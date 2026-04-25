import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { LspMessageReader, writeLspMessage } from '../../src/runtime/lsp.js';

const TEST_PROJECT_ROOT = path.resolve(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
);
const UNDICI_LOADER_OPTION =
  `--import=${pathToFileURL(path.join(TEST_PROJECT_ROOT, 'tests', 'app', 'support', 'undici-loader-register.mjs')).href}`;

function mergeNodeOptions(existing, option) {
  const current = typeof existing === 'string' ? existing.trim() : '';
  const options = current ? current.split(/\s+/) : [];
  if (options.includes(option)) return current;
  return current ? `${current} ${option}` : option;
}

function formatChildExitError(child, prefix) {
  const stderr = typeof child?.stderrLog === 'string' ? child.stderrLog.trim() : '';
  const exitInfo =
    child && (child.exitCode !== null || child.signalCode !== null)
      ? ` (exit=${child.exitCode}, signal=${child.signalCode})`
      : '';
  const stderrTail = stderr ? `\nstderr:\n${stderr.slice(-4000)}` : '';
  return new Error(`${prefix}${exitInfo}${stderrTail}`);
}

function createProcess(command, args, options = {}) {
  const baseEnv = { ...process.env, ...options.env };
  const child = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...baseEnv,
      NODE_OPTIONS: mergeNodeOptions(baseEnv.NODE_OPTIONS, UNDICI_LOADER_OPTION),
      CDX_BACKGROUND_BACKEND_ENABLED: '0',
    },
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderrLog = '';
  child.stderr.on('data', chunk => {
    child.stderrLog += String(chunk ?? '');
    if (process.env.TEST_DEBUG) {
      process.stderr.write(chunk);
    }
  });
  return child;
}

function createMessageReader(child) {
  const queue = [];
  const waiters = [];
  const allMessages = [];
  let closeError = null;

  function trySatisfy(predicate) {
    const index = queue.findIndex(predicate);
    if (index !== -1) {
      const value = queue.splice(index, 1)[0];
      return value;
    }
    return null;
  }

  function resolveWaiters(message) {
    for (let i = 0; i < waiters.length; i += 1) {
      const waiter = waiters[i];
      if (!waiter.predicate || waiter.predicate(message)) {
        waiters.splice(i, 1);
        waiter.resolve(message);
        return true;
      }
    }
    return false;
  }

  function rejectWaiters(err) {
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      waiter.reject(err);
    }
  }

  const reader = new LspMessageReader(child.stdout);
  reader.onMessage(message => {
    allMessages.push(message);
    if (resolveWaiters(message)) return;
    queue.push(message);
  });
  child.once('exit', () => {
    closeError = formatChildExitError(child, 'Process exited before emitting the expected message');
    rejectWaiters(closeError);
  });

  function next(predicate, timeoutMs = 5000) {
    if (closeError) {
      return Promise.reject(closeError);
    }
    const existing = trySatisfy(predicate ?? (() => true));
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.indexOf(entry);
        if (idx !== -1) waiters.splice(idx, 1);
        reject(formatChildExitError(child, 'Timed out waiting for message'));
      }, timeoutMs).unref();
      const entry = {
        predicate,
        resolve: value => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: err => {
          clearTimeout(timer);
          reject(err);
        },
      };
      waiters.push(entry);
    });
  }

  return {
    next,
    allMessages,
  };
}

async function sendRequest(child, message) {
  writeLspMessage(child.stdin, message);
}

async function runCommand(cwd, args) {
  const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    stdout += chunk;
  });
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });
  const code = await new Promise(resolve => child.on('close', resolve));
  if (code !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit=${code})\n${stderr}`);
  }
  return stdout.trim();
}

let cdxServer;
let reader;
let requestCounter = 0;
let tempRoot;
let repoRoot;

const nextId = () => {
  requestCounter += 1;
  return `${requestCounter}`;
};

before(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cdx-broker-test-'));
  repoRoot = path.join(tempRoot, 'repo');
  await mkdir(repoRoot, { recursive: true });
  await runCommand(repoRoot, ['init']);
  await writeFile(path.join(repoRoot, 'README.md'), 'hello\n', 'utf8');
  await runCommand(repoRoot, ['add', '-A']);
  await runCommand(repoRoot, [
    '-c',
    'user.name=test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-m',
    'init',
  ]);

  const serverPath = path.join(TEST_PROJECT_ROOT, 'src', 'cli', 'cdx-mcp-server.js');
  const stubPath = path.join(TEST_PROJECT_ROOT, 'tests', 'app', 'fixtures', 'stubs', 'appserver-mcp-stub.js');

  cdxServer = createProcess('node', [serverPath], {
    env: {
      CDX_APPSERVER_ENTRY: stubPath,
      CDX_REPO_INIT: '1',
      CDX_REPO_INIT_COMMIT_MESSAGE: 'bootstrap test',
    },
  });
  reader = createMessageReader(cdxServer);
  // Let the server finish bootstrapping
  await delay(50);

  const initRequest = {
    jsonrpc: '2.0',
    id: nextId(),
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      clientInfo: { name: 'test-client', version: '1.0.0' },
    },
  };
  await sendRequest(cdxServer, initRequest);
  const initResponse = await reader.next(msg => msg.id === initRequest.id);
  assert.equal(initResponse.result?.serverInfo?.name, 'cdx-orchestrator');
});

after(() => {
  if (cdxServer && !cdxServer.killed) {
    cdxServer.kill();
  }
});

test('cdx broker delegates to appserver spawn', async () => {
  const callRequest = {
    jsonrpc: '2.0',
    id: nextId(),
    method: 'tools/call',
    params: {
      name: 'cdx',
      arguments: {
        prompt: 'Ship a minimal demo',
        repoRoot,
        maxParallelism: 1,
      },
    },
  };

  await sendRequest(cdxServer, callRequest);
  const callResponse = await reader.next(msg => msg.id === callRequest.id, 10000);
  assert.ok(callResponse.result);
  const structured = callResponse.result.structured_content;
  assert.ok(structured);
  assert.ok(structured.runId);
  assert.equal(structured.status, 'running');
  assert.equal(structured.repoRoot, repoRoot);
  assert.equal(structured.background, true);
});

test('cdx broker preflight can auto-init a repo before spawn', async () => {
  const initRepoRoot = path.join(tempRoot, `repo-init-${Date.now()}`);
  await mkdir(initRepoRoot, { recursive: true });
  await writeFile(path.join(initRepoRoot, 'README.md'), 'hello\n', 'utf8');

  const callRequest = {
    jsonrpc: '2.0',
    id: nextId(),
    method: 'tools/call',
    params: {
      name: 'cdx',
      arguments: {
        prompt: 'Ship a minimal demo',
        repoRoot: initRepoRoot,
        maxParallelism: 1,
      },
    },
  };

  await sendRequest(cdxServer, callRequest);
  const callResponse = await reader.next(msg => msg.id === callRequest.id, 10000);
  assert.ok(callResponse.result);

  const message = await runCommand(initRepoRoot, [
    'log',
    '--pretty=%B',
    '-n',
    '1',
  ]);
  assert.equal(message.trim(), 'bootstrap test');
});
