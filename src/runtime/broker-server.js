import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';

import { LspMessageReader, writeLspMessage } from './lsp.js';

function commandExists(candidate) {
  if (!candidate) return false;
  const hasDirSeparator = candidate.includes('/') || candidate.includes('\\');
  if (hasDirSeparator) {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter);
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
      : [''];
  for (const entry of pathEntries) {
    if (!entry) continue;
    for (const ext of extensions) {
      const resolved = path.join(entry, ext ? `${candidate}${ext}` : candidate);
      try {
        accessSync(resolved, constants.X_OK);
        return true;
      } catch {}
    }
  }
  return false;
}

function resolveWorkerCommand() {
  if (process.env.CS_COMMAND) return process.env.CS_COMMAND;
  if (process.env.CODEX_COMMAND) return process.env.CODEX_COMMAND;
  if (commandExists('cs')) return 'cs';
  if (commandExists('codex')) {
    console.warn(
      'CS MCP broker falling back to "codex" executable; set CS_COMMAND to override.',
    );
    return 'codex';
  }
  throw new Error(
    'CS MCP broker: unable to find "cs" or "codex" in PATH. Set CS_COMMAND or CODEX_COMMAND.',
  );
}

function resolveWorkerArgs(command) {
  if (process.env.CS_ARGS) {
    return JSON.parse(process.env.CS_ARGS);
  }
  if (process.env.CODEX_ARGS) {
    return JSON.parse(process.env.CODEX_ARGS);
  }

  const base = command ? path.basename(command).toLowerCase() : '';
  if (base === 'codex' || base === 'codex.exe') {
    return ['mcp-server'];
  }
  return ['mcp'];
}

export async function runBrokerServer({
  host = process.env.BROKER_HOST ?? '127.0.0.1',
  port = Number.parseInt(process.env.PORT ?? '4000', 10),
  maxSessions = Number.parseInt(process.env.MAX_SESSIONS ?? '2', 10),
  sessionTtlMs = Number.parseInt(process.env.SESSION_TTL_MS ?? `${30 * 60 * 1000}`, 10),
  workerCommand = resolveWorkerCommand(),
  workerArgs = resolveWorkerArgs(workerCommand),
} = {}) {
  function log(...args) {
    console.log(new Date().toISOString(), ...args);
  }

  function sendJson(res, status, body) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
  }

  async function readJson(req, limitBytes = 2 * 1024 * 1024) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buf.length;
      if (size > limitBytes) {
        const err = new Error('request_too_large');
        err.statusCode = 413;
        throw err;
      }
      chunks.push(buf);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw.trim()) return null;
    try {
      return JSON.parse(raw);
    } catch {
      const err = new Error('invalid_json');
      err.statusCode = 400;
      throw err;
    }
  }

  const workers = new Map(); // workerId -> worker
  const sessions = new Map(); // sessionId -> session
  const pendingWorkerRequests = [];

  function createSession() {
    const sessionId = randomUUID();
    const session = {
      id: sessionId,
      workerId: null,
      workerPromise: null,
      createdAt: Date.now(),
      lastActive: Date.now(),
      ttlHandle: null,
      streamClients: new Set(),
      pendingMessages: [],
    };
    sessions.set(sessionId, session);
    refreshSessionTimer(sessionId);
    return session;
  }

  function getSession(sessionId) {
    return sessions.get(sessionId);
  }

  function takeIdleWorker() {
    for (const worker of workers.values()) {
      if (worker.state === 'idle') {
        worker.state = 'busy';
        return worker;
      }
    }
    return null;
  }

  function refreshSessionTimer(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return;
    if (session.ttlHandle) clearTimeout(session.ttlHandle);
    session.ttlHandle = setTimeout(() => {
      log('Session expired', sessionId);
      releaseSession(sessionId, 'ttl');
    }, sessionTtlMs);
  }

  function emitToSession(session, payload) {
    const data = JSON.stringify(payload);
    if (session.streamClients.size === 0) {
      session.pendingMessages.push(data);
      return;
    }
    for (const client of session.streamClients) {
      client.res.write(`data: ${data}\n\n`);
    }
  }

  function emitSessionClosed(session, reason) {
    const payload = JSON.stringify({ event: 'session-closed', reason });
    for (const client of session.streamClients) {
      client.res.write(`event: close\n`);
      client.res.write(`data: ${payload}\n\n`);
      client.res.end();
      clearInterval(client.keepAlive);
    }
    session.streamClients.clear();
  }

  function cleanupSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return;
    if (session.ttlHandle) clearTimeout(session.ttlHandle);
    sessions.delete(sessionId);
  }

  function retireWorker(workerId) {
    const worker = workers.get(workerId);
    if (!worker) return;
    if (worker.state === 'terminating') return;
    worker.state = 'terminating';
    worker.sessionId = null;
    try {
      worker.proc.kill();
    } catch (err) {
      log('Failed to terminate worker', workerId, err);
    }
  }

  function releaseSession(sessionId, reason = 'released') {
    const session = sessions.get(sessionId);
    if (!session) return;
    if (session.workerId) {
      retireWorker(session.workerId);
    }
    emitSessionClosed(session, reason);
    cleanupSession(sessionId);
    drainWorkerQueue();
  }

  function drainWorkerQueue() {
    while (pendingWorkerRequests.length > 0) {
      const worker = takeIdleWorker();
      if (!worker) return;
      const request = pendingWorkerRequests.shift();
      if (!request) {
        worker.state = 'idle';
        return;
      }
      if (request.signal?.aborted) {
        worker.state = 'idle';
        request.reject?.(new Error('aborted'));
        continue;
      }
      if (request.signal && request.abortHandler) {
        request.signal.removeEventListener('abort', request.abortHandler);
      }
      request.resolve(worker);
    }
  }

  function requestWorker(signal) {
    const existing = takeIdleWorker();
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const abortHandler = () => reject(new Error('aborted'));
      if (signal) {
        if (signal.aborted) {
          reject(new Error('aborted'));
          return;
        }
        signal.addEventListener('abort', abortHandler, { once: true });
      }
      pendingWorkerRequests.push({ resolve, reject, signal, abortHandler });
    });
  }

  async function acquireWorkerForSession(session, signal) {
    if (!session) throw new Error('missing-session');
    if (session.workerId) {
      const worker = workers.get(session.workerId);
      if (worker && worker.state === 'busy' && worker.sessionId === session.id) {
        return worker;
      }
      session.workerId = null;
    }

    if (!session.workerPromise) {
      session.workerPromise = requestWorker(signal)
        .then(worker => {
          worker.sessionId = session.id;
          session.workerId = worker.id;
          log('Assigned worker', worker.id, 'to session', session.id);
          return worker;
        })
        .finally(() => {
          session.workerPromise = null;
        });
    }
    return session.workerPromise;
  }

  function createWorker() {
    const workerId = randomUUID();
    const proc = spawn(workerCommand, workerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    const reader = new LspMessageReader(proc.stdout);
    const worker = {
      id: workerId,
      proc,
      reader,
      state: 'idle',
      sessionId: null,
    };

    reader.onMessage(message => {
      const { sessionId } = worker;
      if (!sessionId) {
        log('Warning: received message from idle worker', workerId, message);
        return;
      }
      const session = sessions.get(sessionId);
      if (!session) {
        log('Warning: received message for missing session', sessionId);
        return;
      }
      session.lastActive = Date.now();
      refreshSessionTimer(sessionId);
      emitToSession(session, message);
    });

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', data => {
      log(`[worker ${workerId} stderr]`, String(data ?? '').trim());
    });

    proc.on('error', err => {
      log(`Worker ${workerId} spawn error`, err);
      if (worker.sessionId) {
        const sessionId = worker.sessionId;
        const session = sessions.get(sessionId);
        if (session) {
          emitSessionClosed(session, 'worker-error');
          cleanupSession(sessionId);
        }
      }
      workers.delete(workerId);
      setTimeout(() => {
        createWorker();
        drainWorkerQueue();
      }, 5000).unref?.();
    });

    proc.on('exit', (code, signal) => {
      log(`Worker ${workerId} exited`, { code, signal });
      if (worker.sessionId) {
        const sessionId = worker.sessionId;
        const session = sessions.get(sessionId);
        if (session) {
          emitSessionClosed(session, 'worker-exit');
          cleanupSession(sessionId);
        }
      }
      workers.delete(workerId);
      createWorker();
      drainWorkerQueue();
    });

    workers.set(workerId, worker);
    log('Spawned worker', workerId);
    drainWorkerQueue();
  }

  for (let i = 0; i < maxSessions; i += 1) {
    createWorker();
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const method = (req.method ?? 'GET').toUpperCase();

      if (method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, {
          workers: [...workers.values()].map(worker => ({
            id: worker.id,
            state: worker.state,
            sessionId: worker.sessionId,
          })),
          sessions: [...sessions.values()].map(session => ({
            id: session.id,
            workerId: session.workerId,
            createdAt: session.createdAt,
            lastActive: session.lastActive,
          })),
          queueDepth: pendingWorkerRequests.length,
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/sessions') {
        const session = createSession();
        sendJson(res, 201, { sessionId: session.id, workerId: session.workerId });
        return;
      }

      const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)(?:\/(stream|message))?$/);
      if (!sessionMatch) {
        res.statusCode = 404;
        res.end('not-found');
        return;
      }

      const sessionId = sessionMatch[1];
      const sub = sessionMatch[2] ?? null;
      const session = getSession(sessionId);
      if (!session) {
        sendJson(res, 404, { error: 'not-found' });
        return;
      }

      if (method === 'GET' && sub === null) {
        sendJson(res, 200, {
          id: session.id,
          workerId: session.workerId,
          createdAt: session.createdAt,
          lastActive: session.lastActive,
          ttlMs: Math.max(0, sessionTtlMs - (Date.now() - session.lastActive)),
        });
        return;
      }

      if (method === 'DELETE' && sub === null) {
        releaseSession(sessionId, 'client-closed');
        res.statusCode = 204;
        res.end();
        return;
      }

      if (method === 'GET' && sub === 'stream') {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.write(': connected\n\n');

        const client = {
          res,
          keepAlive: setInterval(() => {
            if (!res.writableEnded) res.write(': keep-alive\n\n');
          }, 15000),
        };
        session.streamClients.add(client);

        for (const pending of session.pendingMessages) {
          res.write(`data: ${pending}\n\n`);
        }
        session.pendingMessages = [];

        const onClose = () => {
          clearInterval(client.keepAlive);
          session.streamClients.delete(client);
          if (session.streamClients.size === 0) {
            releaseSession(session.id, 'stream-closed');
          }
        };
        req.on('close', onClose);
        return;
      }

      if (method === 'POST' && sub === 'message') {
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        req.on('aborted', onAbort);
        try {
          const payload = await readJson(req);
          if (!payload || typeof payload !== 'object') {
            sendJson(res, 400, { error: 'invalid-body' });
            return;
          }
          const worker = await acquireWorkerForSession(session, controller.signal);
          if (controller.signal.aborted) {
            sendJson(res, 499, { error: 'client-aborted' });
            return;
          }
          writeLspMessage(worker.proc.stdin, payload);
          session.lastActive = Date.now();
          refreshSessionTimer(session.id);
          res.statusCode = 202;
          res.end();
        } catch (err) {
          if (controller.signal.aborted) {
            sendJson(res, 499, { error: 'client-aborted' });
          } else if (err?.message === 'aborted') {
            sendJson(res, 503, { error: 'busy' });
          } else {
            log('Failed to write to worker', err);
            sendJson(res, 500, { error: 'write-failed' });
          }
        } finally {
          req.off('aborted', onAbort);
        }
        return;
      }

      res.statusCode = 405;
      res.end('method-not-allowed');
    } catch (err) {
      log('Unhandled server error', err);
      sendJson(res, 500, { error: 'internal-error' });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  log(`CS MCP broker listening on port ${port}`);

  return { server, host, port };
}
