import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { normalizeToolResultResponseMessage } from './mcp-response-normalization.js';
import { assertFetchAvailable, createUndiciAgent } from './undici-compat.js';

const DEFAULT_HEALTH_PATH = '/health';

function toBoolean(value) {
  if (typeof value !== 'string') {
    return Boolean(value);
  }
  switch (value.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true;
    default:
      return false;
  }
}

function parseJson(value, fallback) {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseArgs(value) {
  if (!value) return undefined;
  const parsed = parseJson(value, null);
  if (Array.isArray(parsed)) return parsed.map(String);
  if (typeof value === 'string') {
    return value
      .split(/\s+/)
      .map(segment => segment.trim())
      .filter(Boolean);
  }
  return undefined;
}

function trimTrailingSlash(url) {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

const dispatcherCache = new Map();
const sharedAutoStart = {
  process: null,
  key: null,
  readyPromise: null,
  refCount: 0,
  keepAlive: false,
};

function getDispatcher(baseUrl) {
  try {
    const { origin } = new URL(baseUrl);
    let agent = dispatcherCache.get(origin);
    if (!agent) {
      agent = createUndiciAgent({
        keepAliveTimeout: 60_000,
        keepAliveTimeoutThreshold: 30_000,
      });
      if (!agent) return undefined;
      dispatcherCache.set(origin, agent);
    }
    return agent;
  } catch (_) {
    return undefined;
  }
}

const resolvedFetch = assertFetchAvailable('Broker session fetch');

process.once('exit', () => {
  for (const agent of dispatcherCache.values()) {
    agent.close();
  }
  if (sharedAutoStart.process && !sharedAutoStart.keepAlive) {
    try {
      sharedAutoStart.process.kill();
    } catch {
      // ignore
    }
  }
  sharedAutoStart.process = null;
  sharedAutoStart.key = null;
  sharedAutoStart.readyPromise = null;
  sharedAutoStart.refCount = 0;
});

export class BrokerSession extends EventEmitter {
  constructor(baseUrl, { log, autoStart } = {}) {
    super();
    this.baseUrl = trimTrailingSlash(baseUrl ?? 'http://localhost:4000');
    this.log = log ?? (() => {});
    this.sessionId = null;
    this.pending = Promise.resolve();
    this.closed = false;
    this.streamAbort = null;
    this.streamPromise = null;
    this.readyPromise = null;
    this.dispatcher = getDispatcher(this.baseUrl);
    this.autoStartConfig = this.#resolveAutoStart(autoStart);
    this.autoStartKey = this.autoStartConfig ? JSON.stringify({
      spawn: Boolean(this.autoStartConfig.spawn),
      command: this.autoStartConfig.command ?? null,
      args: this.autoStartConfig.args ?? null,
      cwd: this.autoStartConfig.cwd ?? null,
      readyEndpoint: this.autoStartConfig.readyEndpoint,
      waitTimeoutMs: this.autoStartConfig.waitTimeoutMs,
      pollIntervalMs: this.autoStartConfig.pollIntervalMs,
      probeTimeoutMs: this.autoStartConfig.probeTimeoutMs,
      baseUrl: this.baseUrl,
    }) : null;
    this.autoStartProcess = null;
    this.autoStartRefed = false;
  }

  async ensureReady() {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.#initialize();
    return this.readyPromise;
  }

  async #initialize() {
    await this.#ensureBackendAvailable();
    const session = await this.#createSession();
    this.sessionId = session.sessionId;
    if (!this.sessionId) {
      throw new Error('Broker did not return sessionId');
    }
    this.log('Acquired session', this.sessionId);
    if (this.autoStartConfig && !this.autoStartRefed) {
      sharedAutoStart.refCount += 1;
      this.autoStartRefed = true;
    }
    this.streamAbort = new AbortController();
    this.streamPromise = this.#streamSession(this.sessionId, this.streamAbort.signal).catch(err => {
      if (!this.closed) {
        this.emit('error', err);
      }
    });
  }

  async #ensureBackendAvailable() {
    if (!this.autoStartConfig) return;

    const available = await this.#checkBackendOnce(this.autoStartConfig.probeTimeoutMs);
    if (available) {
      if (sharedAutoStart.process) {
        this.autoStartProcess = sharedAutoStart.process;
      }
      return;
    }

    if (sharedAutoStart.readyPromise) {
      if (sharedAutoStart.key && sharedAutoStart.key !== this.autoStartKey) {
        await sharedAutoStart.readyPromise.catch(() => {});
        throw new Error('Auto-start already in progress with a different configuration');
      }
      await sharedAutoStart.readyPromise;
      return;
    }

    sharedAutoStart.keepAlive = this.autoStartConfig.keepAlive;

    if (sharedAutoStart.process) {
      if (sharedAutoStart.key && sharedAutoStart.key !== this.autoStartKey) {
        throw new Error('Auto-start process running with different configuration');
      }
      if (!sharedAutoStart.key) {
        sharedAutoStart.key = this.autoStartKey;
      }
      this.autoStartProcess = sharedAutoStart.process;
      // Process exists but broker not reachable yet; wait for readiness.
      sharedAutoStart.readyPromise = this.#waitForBackendReady(sharedAutoStart.process);
    } else {
      sharedAutoStart.keepAlive = this.autoStartConfig.keepAlive;
      sharedAutoStart.key = this.autoStartKey;
      const sequence = this.#startBackendSequence();
      sharedAutoStart.readyPromise = sequence;
    }

    const currentPromise = sharedAutoStart.readyPromise;
    try {
      await currentPromise;
    } catch (err) {
      if (sharedAutoStart.readyPromise === currentPromise) {
        sharedAutoStart.readyPromise = null;
      }
      throw err;
    }
    if (sharedAutoStart.readyPromise === currentPromise) {
      sharedAutoStart.readyPromise = null;
    }

    const confirmed = await this.#checkBackendOnce(this.autoStartConfig.probeTimeoutMs);
    if (!confirmed) {
      throw new Error('Auto-started broker is not reachable after start sequence');
    }
    this.autoStartProcess = sharedAutoStart.process;
  }

  async #startBackendSequence() {
    if (sharedAutoStart.process && sharedAutoStart.process.exitCode == null && sharedAutoStart.process.signalCode == null) {
      return this.#waitForBackendReady(sharedAutoStart.process);
    }

    const child = this.#spawnBackend();
    sharedAutoStart.process = child;
    this.autoStartProcess = child;
    return this.#waitForBackendReady(child);
  }

  #spawnBackend() {
    const config = this.autoStartConfig;
    if (!config) {
      throw new Error('Auto-start configuration missing');
    }

    let child;
    if (typeof config.spawn === 'function') {
      child = config.spawn();
    } else {
      if (!config.command) {
        throw new Error('Auto-start spawn requires a command');
      }
      const options = {
        env: { ...process.env, ...config.env },
        // Default to piping broker output so we can drain/optionally log it without
        // corrupting stdio-based MCP traffic on the parent process.
        stdio: config.stdio ?? ['ignore', 'pipe', 'pipe'],
        detached: config.detached ?? false,
      };
      if (config.cwd) options.cwd = config.cwd;
      if (config.shell !== undefined) options.shell = config.shell;
      child = spawn(config.command, config.args ?? [], options);
    }

    if (!child || typeof child.pid !== 'number') {
      throw new Error('Auto-start spawn must return a ChildProcess');
    }

    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        const text = String(chunk);
        if (!text) return;
        for (const line of text.split(/\r?\n/)) {
          if (!line) continue;
          this.log('[broker]', line);
        }
      });
    }

    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => {
        const text = String(chunk);
        if (!text) return;
        for (const line of text.split(/\r?\n/)) {
          if (!line) continue;
          this.log('[broker stderr]', line);
        }
      });
    }

    child.on('exit', (code, signal) => {
      this.log('Auto-started broker exited', { code, signal });
      if (sharedAutoStart.process === child) {
        sharedAutoStart.process = null;
        sharedAutoStart.key = null;
        sharedAutoStart.refCount = 0;
      }
    });

    return child;
  }

  async #waitForBackendReady(child) {
    const config = this.autoStartConfig;
    const timeoutMs = config.waitTimeoutMs;
    const pollMs = config.pollIntervalMs;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.#checkBackendOnce(config.probeTimeoutMs)) {
        return;
      }
      if (child?.exitCode != null || child?.signalCode != null) {
        throw new Error(`Auto-started broker exited before becoming ready (code=${child.exitCode}, signal=${child.signalCode})`);
      }
      await delay(pollMs);
    }
    throw new Error('Timed out waiting for auto-started broker to become ready');
  }

  async #checkBackendOnce(timeoutMs = 2000) {
    let healthUrl;
    try {
      const path = this.autoStartConfig?.readyEndpoint ?? DEFAULT_HEALTH_PATH;
      healthUrl = new URL(path, this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`);
    } catch (err) {
      this.log('Failed to resolve broker health URL', err);
      return false;
    }

    try {
      const res = await fetch(healthUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        dispatcher: this.dispatcher,
        signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
      });
      if (!res.ok) {
        return false;
      }
      // Drain body quickly if present.
      try {
        await res.arrayBuffer();
      } catch {
        // ignore body errors
      }
      return true;
    } catch (err) {
      this.log('Broker health probe failed', err);
      return false;
    }
  }

  #resolveAutoStart(autoStartOption) {
    let config = autoStartOption;
    if (config === undefined) {
      config = this.#autoStartFromEnv();
    }
    if (!config) return null;
    if (config === true) {
      config = {};
    }
    if (typeof config !== 'object') {
      throw new Error('autoStart option must be an object when enabled');
    }

    const serverPath = fileURLToPath(new URL('../cli/server.js', import.meta.url));
    const normalized = {
      spawn: typeof config.spawn === 'function' ? config.spawn : null,
      command: typeof config.spawn === 'function'
        ? (config.command ?? null)
        : (config.command ?? process.execPath),
      args: Array.isArray(config.args) ? config.args.map(String) : undefined,
      env: {},
      cwd: config.cwd,
      stdio: config.stdio,
      detached: config.detached,
      shell: config.shell,
      keepAlive: Boolean(config.keepAlive),
      readyEndpoint: typeof config.readyEndpoint === 'string' && config.readyEndpoint
        ? config.readyEndpoint
        : DEFAULT_HEALTH_PATH,
      waitTimeoutMs: Number.isFinite(config.waitTimeoutMs)
        ? Number(config.waitTimeoutMs)
        : 15_000,
      pollIntervalMs: Number.isFinite(config.pollIntervalMs)
        ? Number(config.pollIntervalMs)
        : 250,
      probeTimeoutMs: Number.isFinite(config.probeTimeoutMs)
        ? Number(config.probeTimeoutMs)
        : 2_000,
    };

    if (!normalized.args) {
      if (!config.command || config.command === process.execPath) {
        normalized.args = [serverPath];
      } else {
        normalized.args = [];
      }
    }

    const envSource = config.env && typeof config.env === 'object'
      ? config.env
      : {};
    for (const [key, value] of Object.entries(envSource)) {
      if (value === undefined) continue;
      normalized.env[key] = value == null ? value : String(value);
    }

    const explicitPort = config.port ?? config.PORT ?? config.portOverride;
    if (explicitPort !== undefined && normalized.env.PORT === undefined) {
      normalized.env.PORT = String(explicitPort);
    } else if (normalized.env.PORT === undefined) {
      try {
        const url = new URL(this.baseUrl);
        if (url.port) {
          normalized.env.PORT = url.port;
        }
      } catch {
        // ignore invalid URL
      }
    }

    if (!normalized.spawn && !normalized.command) {
      throw new Error('autoStart configuration requires a spawn function or command');
    }

    return normalized;
  }

  #autoStartFromEnv() {
    const rawFlag = process.env.BROKER_AUTO_START;
    const normalizedFlag = typeof rawFlag === 'string' ? rawFlag.trim().toLowerCase() : rawFlag;
    if (normalizedFlag === undefined || normalizedFlag === 'auto') {
      if (!this.#isLocalBaseUrl()) {
        return null;
      }
    } else if (!toBoolean(rawFlag)) {
      return null;
    }

    const config = {};
    if (process.env.BROKER_AUTO_COMMAND) {
      config.command = process.env.BROKER_AUTO_COMMAND;
    }
    const args = parseArgs(process.env.BROKER_AUTO_ARGS);
    if (args) {
      config.args = args;
    }
    const envOverrides = parseJson(process.env.BROKER_AUTO_ENV, null);
    if (envOverrides && typeof envOverrides === 'object') {
      config.env = envOverrides;
    }
    if (process.env.BROKER_AUTO_WAIT_MS) {
      config.waitTimeoutMs = Number.parseInt(process.env.BROKER_AUTO_WAIT_MS, 10);
    }
    if (process.env.BROKER_AUTO_POLL_MS) {
      config.pollIntervalMs = Number.parseInt(process.env.BROKER_AUTO_POLL_MS, 10);
    }
    if (process.env.BROKER_AUTO_PROBE_MS) {
      config.probeTimeoutMs = Number.parseInt(process.env.BROKER_AUTO_PROBE_MS, 10);
    }
    if (process.env.BROKER_AUTO_KEEP_ALIVE) {
      config.keepAlive = toBoolean(process.env.BROKER_AUTO_KEEP_ALIVE);
    }
    if (process.env.BROKER_AUTO_HEALTH_PATH) {
      config.readyEndpoint = process.env.BROKER_AUTO_HEALTH_PATH;
    }
    if (process.env.BROKER_AUTO_PORT) {
      config.port = process.env.BROKER_AUTO_PORT;
    }
    if (process.env.BROKER_AUTO_CWD) {
      config.cwd = process.env.BROKER_AUTO_CWD;
    }
    if (process.env.BROKER_AUTO_STDIO) {
      config.stdio = process.env.BROKER_AUTO_STDIO;
    }
    if (process.env.BROKER_AUTO_DETACHED) {
      config.detached = toBoolean(process.env.BROKER_AUTO_DETACHED);
    }
    if (process.env.BROKER_AUTO_SHELL) {
      config.shell = toBoolean(process.env.BROKER_AUTO_SHELL);
    }

    return config;
  }

  #isLocalBaseUrl() {
    try {
      const { hostname } = new URL(this.baseUrl);
      return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    } catch {
      return false;
    }
  }

  async send(payload) {
    if (this.closed) {
      throw new Error('session-closed');
    }
    await this.ensureReady();
    this.pending = this.pending
      .then(() => this.#sendMessage(this.sessionId, payload))
      .catch(err => {
        this.emit('error', err);
        throw err;
      });
    return this.pending;
  }

  async dispose(reason = 'client-dispose') {
    if (this.closed) return;
    this.closed = true;
    if (this.streamAbort) {
      this.streamAbort.abort();
    }
    await this.pending.catch(() => {});
    await this.#releaseSession(this.sessionId, reason).catch(err => {
      this.log('Failed to release session', err);
    });
    if (this.autoStartConfig && this.autoStartRefed) {
      sharedAutoStart.refCount = Math.max(0, sharedAutoStart.refCount - 1);
      this.autoStartRefed = false;
      if (!this.autoStartConfig.keepAlive && sharedAutoStart.refCount === 0 && sharedAutoStart.process) {
        try {
          sharedAutoStart.process.kill();
        } catch (err) {
          this.log('Failed to terminate auto-started broker', err);
        }
      }
    }
  }

  async waitForStreamEnd() {
    await this.streamPromise;
  }

  async #createSession() {
    const res = await fetch(`${this.baseUrl}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      dispatcher: this.dispatcher,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to create session (${res.status}): ${text}`);
    }
    return res.json();
  }

  async #sendMessage(sessionId, payload) {
    const res = await fetch(`${this.baseUrl}/sessions/${sessionId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      dispatcher: this.dispatcher,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to forward message (${res.status}): ${text}`);
    }
  }

  async #releaseSession(sessionId, reason) {
    if (!sessionId) return;
    try {
      await fetch(`${this.baseUrl}/sessions/${sessionId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
        dispatcher: this.dispatcher,
      });
    } catch (err) {
      this.log('Failed HTTP DELETE for session', sessionId, err);
    }
  }

  async #streamSession(sessionId, signal) {
    const res = await fetch(`${this.baseUrl}/sessions/${sessionId}/stream`, {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
      signal,
      dispatcher: this.dispatcher,
    });
    if (!res.ok || !res.body) {
      const text = await res.text();
      throw new Error(`Failed to open event stream (${res.status}): ${text}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    const flushEvent = rawEvent => {
      if (!rawEvent || rawEvent.startsWith(':')) return { continue: true };

      let eventType = 'message';
      const dataLines = [];
      for (const line of rawEvent.split('\n')) {
        if (line.startsWith('data:')) {
          const value = line.slice(5);
          dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
        } else if (line.startsWith('event:')) {
          eventType = line.slice(6).trim();
        }
      }

      if (dataLines.length === 0) return { continue: true };

      const data = dataLines.join('\n');
      try {
        const payload = normalizeToolResultResponseMessage(JSON.parse(data));
        if (eventType === 'close') {
          this.closed = true;
          this.emit('close', payload);
          return { continue: false, closed: true };
        }
        this.emit('message', payload);
        return { continue: eventType !== 'close', closed: eventType === 'close' };
      } catch (err) {
        this.log('Failed to parse SSE data', err, data);
        return { continue: true };
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: !done });
      }
      if (done) {
        buffer += decoder.decode();
      }

      let separatorIndex;
      while ((separatorIndex = buffer.indexOf('\n\n')) >= 0) {
        const rawEvent = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        const result = flushEvent(rawEvent);
        if (result.closed) return;
      }

      if (done) {
        if (buffer) {
          const result = flushEvent(buffer);
          if (result.closed) return;
        }
        return;
      }
    }
  }
}
