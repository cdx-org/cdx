import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  AppServerClient,
  prepareCodexAppServerArgs,
  prepareCodexAppServerEnv,
} from '../../src/runtime/app-server-client.js';
import { LspMessageReader, writeLspMessage } from '../../src/runtime/lsp.js';
import { normalizeToolResultResponseMessage } from '../../src/runtime/mcp-response-normalization.js';
import {
  detectMergeConflict,
  isMergeConflictError,
  summarizeMergeState,
} from '../../src/runtime/merge-conflict.js';
import {
  didInterventionMakeProgress,
  planWatchdogMergeAskRecovery,
  selectDependencyBlockedActions,
} from '../../src/runtime/watchdog-intervention.js';
import {
  assertJsonRpcErrorEnvelope,
  assertToolCallResultContract,
  getToolCallStructuredContent,
  readToolCallText,
} from './support/mcpToolContract.js';

const TEST_PROJECT_ROOT = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
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
    cwd: options.cwd,
    env: {
      ...baseEnv,
      NODE_OPTIONS: mergeNodeOptions(baseEnv.NODE_OPTIONS, UNDICI_LOADER_OPTION),
      CDX_INTEGRATION_EMPTY_FAIL: baseEnv.CDX_INTEGRATION_EMPTY_FAIL ?? '0',
      CDX_VALIDATE_TASK: baseEnv.CDX_VALIDATE_TASK ?? '0',
      CDX_STATS_ENABLED: baseEnv.CDX_STATS_ENABLED ?? '0',
      CDX_ROUTER_ENABLED: baseEnv.CDX_ROUTER_ENABLED ?? '0',
      CDX_USE_WORKTREES: baseEnv.CDX_USE_WORKTREES ?? '1',
      CDX_BACKGROUND_BACKEND_ENABLED: baseEnv.CDX_BACKGROUND_BACKEND_ENABLED ?? '0',
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

function isRetryableGitFailure({ code, stdout, stderr }) {
  if (![1, 128].includes(Number(code))) return false;
  const text = `${stderr ?? ''}\n${stdout ?? ''}`.toLowerCase();
  if (!text.trim()) return false;
  return (
    text.includes('index.lock')
    || text.includes('another git process seems to be running')
    || text.includes('cannot lock ref')
    || text.includes('unable to update local ref')
    || text.includes('failed to update ref')
    || (text.includes(' is at ') && text.includes(' but expected '))
  );
}

async function runCommand(cwd, args) {
  const maxAttempts = 10;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
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
    if (code === 0) {
      return stdout.trim();
    }

    const retryable = attempt < maxAttempts && isRetryableGitFailure({ code, stdout, stderr });
    if (retryable) {
      await new Promise(resolve => setTimeout(resolve, 100 * attempt));
      continue;
    }

    throw new Error(`git ${args.join(' ')} failed (exit=${code})\n${stderr}`);
  }
  throw new Error(`git ${args.join(' ')} failed after retries`);
}

async function runCommandAllowFailure(cwd, args) {
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
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function stopProcess(child, { timeoutMs = 5000 } = {}) {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) return;

  await new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
      resolve();
    }, timeoutMs);
    timer.unref?.();
    child.once('exit', finish);
    child.kill();
  });
}

async function removeDirWithRetry(targetPath, { attempts = 20, delayMs = 250 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rm(targetPath, { recursive: true, force: true });
      return;
    } catch (err) {
      const retryable = ['ENOTEMPTY', 'EBUSY', 'EPERM'].includes(err?.code);
      if (!retryable || attempt >= attempts) throw err;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

async function stopDetachedProcess(pid, { timeoutMs = 5000 } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return;

  const signalProcessGroup = signal => {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {}
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  };

  const isAlive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  if (!isAlive()) return;

  if (!signalProcessGroup('SIGTERM')) {
    return;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isAlive()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  signalProcessGroup('SIGKILL');
}

async function waitForCondition(check, { timeoutMs = 5000, intervalMs = 100, label = 'condition' } = {}) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  if (lastError) throw lastError;
  throw new Error(`Timed out waiting for ${label}`);
}

async function initRepo(repoRoot) {
  await mkdir(repoRoot, { recursive: true });
  await runCommand(repoRoot, ['init']);
  await runCommand(repoRoot, ['config', 'user.name', 'stub']);
  await runCommand(repoRoot, ['config', 'user.email', 'stub@example.com']);
  await writeFile(path.join(repoRoot, 'README.md'), 'hello\n', 'utf8');
  await runCommand(repoRoot, ['add', '-A']);
  await runCommand(repoRoot, ['commit', '-m', 'init']);
}

async function createMergeConflict(worktreePath) {
  await runCommand(worktreePath, ['config', 'user.name', 'stub']);
  await runCommand(worktreePath, ['config', 'user.email', 'stub@example.com']);
  const repoRoot = await runCommand(worktreePath, ['rev-parse', '--show-toplevel']);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const fileName = `conflict-${suffix}.txt`;
  const branchName = `conflict-other-${suffix}`;
  const auxWorktreePath = path.join(path.dirname(worktreePath), `conflict-other-${suffix}-wt`);

  await writeFile(path.join(worktreePath, fileName), 'base\n', 'utf8');
  await runCommand(worktreePath, ['add', fileName]);
  await runCommand(worktreePath, ['commit', '-m', `base ${suffix}`]);

  await runCommand(worktreePath, ['branch', branchName]);
  await runCommand(repoRoot, ['worktree', 'add', auxWorktreePath, branchName]);
  try {
    await runCommand(auxWorktreePath, ['config', 'user.name', 'stub']);
    await runCommand(auxWorktreePath, ['config', 'user.email', 'stub@example.com']);
    await writeFile(path.join(auxWorktreePath, fileName), 'other\n', 'utf8');
    await runCommand(auxWorktreePath, ['add', fileName]);
    await runCommand(auxWorktreePath, ['commit', '-m', `other ${suffix}`]);
  } finally {
    await runCommandAllowFailure(repoRoot, ['worktree', 'remove', '--force', auxWorktreePath]);
  }

  await writeFile(path.join(worktreePath, fileName), 'alpha\n', 'utf8');
  await runCommand(worktreePath, ['add', fileName]);
  await runCommand(worktreePath, ['commit', '-m', `alpha ${suffix}`]);

  const result = await runCommandAllowFailure(worktreePath, ['merge', branchName]);
  const conflict = await detectMergeConflict({ err: result, cwd: worktreePath });
  if (!conflict) {
    throw new Error(
      `Expected merge conflict in ${worktreePath}, got exit=${result.code} stdout=${result.stdout} stderr=${result.stderr}`,
    );
  }
}

let tempRoot;
let repoRoot;
let server;
let reader;
let requestCounter = 0;

const nextId = () => {
  requestCounter += 1;
  return `${requestCounter}`;
};

before(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cdx-appserver-test-'));
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

  const serverPath = path.join(TEST_PROJECT_ROOT, 'src', 'cli', 'cdx-appserver-mcp-server.js');
  const stubPath = path.join(TEST_PROJECT_ROOT, 'tests', 'app', 'fixtures', 'stubs', 'appserver-stub.js');

  server = createProcess('node', [serverPath], {
    cwd: tempRoot,
    env: {
      CODEX_BIN: 'node',
      CODEX_APP_SERVER_ARGS: JSON.stringify([stubPath]),
      APP_SERVER_STUB_DELAY_MS: '200',
      CDX_WORKTREE_ROOT: path.join(tempRoot, 'worktrees'),
      CDX_RUN_ID: 'test-run',
      CDX_MAX_PARALLELISM: '1',
      CDX_EVENT_STREAM: '1',
      CDX_EVENT_STREAM_DELTAS: '0',
      CDX_STREAM_EVENTS: process.env.TEST_DEBUG ? '1' : '0',
      CDX_STATS_AUTO_OPEN: '0',
    },
  });
  reader = createMessageReader(server);

  const initRequest = {
    jsonrpc: '2.0',
    id: nextId(),
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      clientInfo: { name: 'test-client', version: '0.0.1' },
    },
  };
  await sendRequest(server, initRequest);
  const initResponse = await reader.next(msg => msg.id === initRequest.id, 5000);
  assert.equal(initResponse.result?.serverInfo?.name, 'cdx-appserver-orchestrator');

  await sendRequest(server, {
    jsonrpc: '2.0',
    method: 'codex/sandbox-state/update',
    params: {
      sandboxCwd: repoRoot,
    },
  });
});

after(async () => {
  await stopProcess(server);
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('tool result normalization backfills MCP-compatible content fields', () => {
  const message = {
    jsonrpc: '2.0',
    id: 'tool-1',
    result: {
      structuredContent: { status: 'running', text: 'Run started' },
      isError: false,
      content: { type: 'output_text', text: 'Run started' },
    },
  };

  const normalized = normalizeToolResultResponseMessage(message);
  assert.notEqual(normalized, message);
  assert.deepEqual(normalized.result?.structured_content, {
    status: 'running',
    text: 'Run started',
  });
  assert.equal(normalized.result?.is_error, false);
  assert.deepEqual(normalized.result?.content, [
    { type: 'text', text: 'Run started' },
  ]);
});

test('watchdog keeps tasks waiting on blocked dependencies pending for recovery', () => {
  const decision = selectDependencyBlockedActions({
    blockedByFailed: ['task-2', 'task-2'],
    blockedByBlocked: ['task-3', 'task-4', 'task-2'],
  });

  assert.deepEqual(decision, {
    unrecoverableTaskIds: ['task-2'],
    waitingOnBlockedTaskIds: ['task-3', 'task-4'],
  });
});

test('watchdog only treats actionable intervention work as recovery progress', () => {
  assert.equal(didInterventionMakeProgress([], false), false);
  assert.equal(didInterventionMakeProgress(['deps-blocked'], false), false);
  assert.equal(didInterventionMakeProgress(['deps-blocked', 'respawn'], false), true);
  assert.equal(didInterventionMakeProgress([], true), true);
});

test('watchdog groups stale overlapping dependency merge asks for takeover', () => {
  const plan = planWatchdogMergeAskRecovery(
    [
      {
        askId: 'ask-1',
        taskId: 'task-1',
        createdAt: 1_000,
        metadata: {
          kind: 'dependency-merge-retry',
          taskId: 'task-1',
          worktreePath: '/tmp/task-1',
          dependencyId: 'task-a',
          dependencyBranch: 'cdx/task/a',
          conflictPaths: ['src/shared.js', './src/a.js'],
        },
      },
      {
        askId: 'ask-2',
        taskId: 'task-2',
        createdAt: 1_100,
        metadata: {
          kind: 'dependency-merge-retry',
          taskId: 'task-2',
          worktreePath: '/tmp/task-2',
          dependencyId: 'task-b',
          dependencyBranch: 'cdx/task/b',
          conflictPaths: ['src/shared.js', 'src/b.js'],
        },
      },
      {
        askId: 'ask-3',
        taskId: 'task-3',
        createdAt: 1_200,
        metadata: {
          kind: 'dependency-merge-retry',
          taskId: 'task-3',
          worktreePath: '/tmp/task-3',
          dependencyId: 'task-c',
          dependencyBranch: 'cdx/task/c',
          conflictPaths: ['docs/readme.md'],
        },
      },
      {
        askId: 'ask-fresh',
        taskId: 'task-4',
        createdAt: 4_500,
        metadata: {
          kind: 'dependency-merge-retry',
          taskId: 'task-4',
          worktreePath: '/tmp/task-4',
          dependencyId: 'task-d',
          dependencyBranch: 'cdx/task/d',
          conflictPaths: ['src/shared.js'],
        },
      },
    ],
    {
      now: 5_000,
      minAgeMs: 1_000,
      minTakeoverGroupSize: 2,
    },
  );

  assert.equal(plan.eligible.length, 3);
  assert.equal(plan.takeoverGroups.length, 1);
  assert.deepEqual(plan.takeoverGroups[0].askIds, ['ask-1', 'ask-2']);
  assert.deepEqual(plan.takeoverGroups[0].taskIds, ['task-1', 'task-2']);
  assert.deepEqual(
    [...plan.takeoverGroups[0].conflictPaths].sort(),
    ['src/a.js', 'src/b.js', 'src/shared.js'],
  );
  assert.deepEqual(plan.standalone.map(record => record.askId), ['ask-3']);
});

test('merge conflict detection uses stdout and repo state', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'cdx-merge-detect-test-'));
  try {
    await initRepo(tempDir);
    await createMergeConflict(tempDir);

    const fauxError = {
      message: 'merge failed',
      stdout: 'CONFLICT (content): Merge conflict in conflict.txt',
      stderr: '',
    };
    assert.ok(isMergeConflictError(fauxError));

    const scrubbedError = new Error('merge failed');
    scrubbedError.stdout = '';
    scrubbedError.stderr = '';
    const detected = await detectMergeConflict({ err: scrubbedError, cwd: tempDir });
    assert.ok(detected);
  } finally {
    await runCommandAllowFailure(tempDir, ['merge', '--abort']);
    await removeDirWithRetry(tempDir);
  }
});

test('merge state summary retains status and unmerged path arrays', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'cdx-merge-summary-test-'));
  try {
    await initRepo(tempDir);
    await createMergeConflict(tempDir);

    const summary = await summarizeMergeState({ cwd: tempDir });
    assert.ok(summary);
    assert.ok(Array.isArray(summary.statusPaths));
    assert.ok(Array.isArray(summary.unmergedPaths));
    assert.ok(summary.statusPaths.length >= 1);
    assert.ok(summary.unmergedPaths.length >= 1);
    assert.equal(summary.unmergedCount, summary.unmergedPaths.length);
    assert.ok(
      summary.statusPaths.some(file => file.endsWith('.txt')),
      `Expected at least one conflicted status path, got ${JSON.stringify(summary.statusPaths)}`,
    );
    assert.ok(
      summary.unmergedPaths.some(file => file.endsWith('.txt')),
      `Expected at least one unmerged path, got ${JSON.stringify(summary.unmergedPaths)}`,
    );
  } finally {
    await runCommandAllowFailure(tempDir, ['merge', '--abort']);
    await removeDirWithRetry(tempDir);
  }
});

test('cdx server exposes helper tools and global option passthrough fields', async () => {
  const listRequest = {
    jsonrpc: '2.0',
    id: nextId(),
    method: 'tools/list',
    params: {},
  };
  await sendRequest(server, listRequest);
  const listResponse = await reader.next(msg => msg.id === listRequest.id, 5000);
  const tools = listResponse.result?.tools;
  assert.ok(Array.isArray(tools));

  const names = tools.map(tool => tool.name).sort();
  assert.ok(names.includes('run'));
  assert.ok(names.includes('status'));
  assert.ok(names.includes('spawn'));
  assert.ok(names.includes('help'));
  assert.ok(names.includes('ps'));
  assert.ok(names.includes('rollback'));
  assert.ok(names.includes('thread_fork'));
  assert.ok(names.includes('requirements'));
  assert.ok(names.includes('metrics'));
  assert.ok(names.includes('pending_asks'));
  assert.ok(names.includes('router_answer'));
  assert.ok(names.includes('agent_message'));
  assert.ok(names.includes('steer'));
  assert.ok(names.includes('agent_inbox'));
  assert.ok(names.includes('task_abort'));
  assert.ok(names.includes('config'));
  assert.ok(names.includes('logs'));

  const cdxTool = tools.find(tool => tool.name === 'run');
  const props = cdxTool?.inputSchema?.properties ?? {};
  assert.ok(props.model);
  assert.ok(props.plannerModel);
  assert.ok(props.taskModel);
  assert.ok(props.watchdogModel);
  assert.ok(props.sandbox);
  assert.ok(props.webSearch);
  assert.ok(props.analyticsEnabled);
  assert.ok(props.watchdogEffort);
  assert.ok(props.review);
  assert.ok(props.repoRoot);
  assert.ok(props.targets);
  assert.ok(props.checklist);
  assert.ok(props.workflowMode);
  assert.ok(props.continuous);
  assert.ok(props.maxCycles);
  assert.ok(props.outputRoot);

  const spawnTool = tools.find(tool => tool.name === 'spawn');
  const spawnProps = spawnTool?.inputSchema?.properties ?? {};
  assert.ok(spawnProps.targets);
  assert.ok(spawnProps.checklist);
  assert.ok(spawnProps.workflowMode);
  assert.ok(spawnProps.continuous);
  assert.ok(spawnProps.maxCycles);
  assert.ok(spawnProps.outputRoot);

  const steerTool = tools.find(tool => tool.name === 'steer');
  const steerProps = steerTool?.inputSchema?.properties ?? {};
  assert.ok(steerProps.message);
  assert.ok(steerProps.task);
  assert.ok(steerProps.tasks);

  const routerAnswerTool = tools.find(tool => tool.name === 'router_answer');
  assert.equal(routerAnswerTool?.inputSchema?.type, 'object');
  assert.deepEqual(routerAnswerTool?.inputSchema?.required, ['askId']);
  assert.ok(routerAnswerTool?.inputSchema?.properties?.response);
  assert.ok(routerAnswerTool?.inputSchema?.properties?.message_for_agent);
  assert.ok(routerAnswerTool?.inputSchema?.properties?.decision);
});

test('tool input schemas are compatible with OpenAI function parameter top-level rules', async () => {
  const listRequest = {
    jsonrpc: '2.0',
    id: nextId(),
    method: 'tools/list',
    params: {},
  };
  await sendRequest(server, listRequest);
  const listResponse = await reader.next(msg => msg.id === listRequest.id, 5000);
  const tools = listResponse.result?.tools;
  assert.ok(Array.isArray(tools));

  const forbiddenTopLevelKeys = ['oneOf', 'anyOf', 'allOf', 'enum', 'not'];
  for (const tool of tools) {
    const schema = tool?.inputSchema;
    assert.equal(schema?.type, 'object', `${tool?.name} inputSchema must be a top-level object`);
    for (const key of forbiddenTopLevelKeys) {
      assert.ok(
        !Object.hasOwn(schema, key),
        `${tool?.name} inputSchema must not use top-level ${key}`,
      );
    }
  }
});

test('cdx helper tool aliases are accepted in tools/call', async () => {
  const helpRequest = {
    jsonrpc: '2.0',
    id: nextId(),
    method: 'tools/call',
    params: {
      name: 'help',
      arguments: {},
    },
  };

  await sendRequest(server, helpRequest);
  const helpResponse = await reader.next(msg => msg.id === helpRequest.id, 5000);
  assert.ok(helpResponse.result);
  const text = helpResponse.result.structured_content?.text ?? '';
  assert.ok(typeof text === 'string' && text.includes('CDX MCP tools'));
  assert.ok(text.includes('workflowMode: "checklist"'));
  assert.ok(text.includes('{ targets, checklist }'));
});

test('tools/call contract: success responses include content and camelCase structuredContent', async () => {
  const helpRequest = {
    jsonrpc: '2.0',
    id: nextId(),
    method: 'tools/call',
    params: {
      name: 'help',
      arguments: {},
    },
  };

  await sendRequest(server, helpRequest);
  const helpResponse = await reader.next(msg => msg.id === helpRequest.id, 5000);
  assert.ok(!Object.hasOwn(helpResponse, 'error'));

  const result = assertToolCallResultContract(helpResponse.result, {
    requireStructuredContent: true,
  });
  const structured = getToolCallStructuredContent(result);
  const text = readToolCallText(result);

  assert.ok(text.includes('CDX MCP tools'));
  assert.ok(structured?.text?.includes('CDX MCP tools'));
});

test('tools/call contract: empty states still return content and structuredContent instead of an empty payload', async () => {
  const pendingRequest = {
    jsonrpc: '2.0',
    id: nextId(),
    method: 'tools/call',
    params: {
      name: 'pending_asks',
      arguments: {},
    },
  };

  await sendRequest(server, pendingRequest);
  const pendingResponse = await reader.next(msg => msg.id === pendingRequest.id, 5000);
  assert.ok(!Object.hasOwn(pendingResponse, 'error'));

  const result = assertToolCallResultContract(pendingResponse.result, {
    requireStructuredContent: true,
  });
  const structured = getToolCallStructuredContent(result);
  const text = readToolCallText(result);

  assert.equal(structured?.runId, null);
  assert.deepEqual(structured?.pendingAsks ?? null, []);
  assert.ok(text.includes('No cdx run found.'));
});

test('tools/call contract: protocol/tool lookup failures use the JSON-RPC error envelope', async () => {
  const unknownToolRequest = {
    jsonrpc: '2.0',
    id: nextId(),
    method: 'tools/call',
    params: {
      name: 'not_a_real_tool',
      arguments: {},
    },
  };

  await sendRequest(server, unknownToolRequest);
  const unknownToolResponse = await reader.next(msg => msg.id === unknownToolRequest.id, 5000);

  assertJsonRpcErrorEnvelope(unknownToolResponse, {
    code: -32601,
    message: /Unknown tool: not_a_real_tool/,
  });
});

test('tools/call contract: execution failures stay in the result envelope with camelCase isError', async () => {
  const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), 'cdx-tools-call-contract-'));
  const isolatedRepoRoot = path.join(isolatedRoot, 'repo');
  await initRepo(isolatedRepoRoot);

  const serverPath = path.join(TEST_PROJECT_ROOT, 'src', 'cli', 'cdx-appserver-mcp-server.js');

  let failureServer = null;
  try {
    failureServer = createProcess('node', [serverPath], {
      cwd: isolatedRoot,
      env: {
        CODEX_BIN: 'definitely-not-a-real-codex-binary',
        CDX_WORKTREE_ROOT: path.join(isolatedRoot, 'worktrees'),
        CDX_STATS_AUTO_OPEN: '0',
        CDX_MAX_PARALLELISM: '1',
      },
    });
    const failureReader = createMessageReader(failureServer);

    const initRequest = {
      jsonrpc: '2.0',
      id: nextId(),
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        clientInfo: { name: 'tools-call-contract-client', version: '0.0.1' },
      },
    };
    await sendRequest(failureServer, initRequest);
    await failureReader.next(msg => msg.id === initRequest.id, 5000);

    const callRequest = {
      jsonrpc: '2.0',
      id: nextId(),
      method: 'tools/call',
      params: {
        name: 'run',
        arguments: {
          prompt: 'Ship a minimal demo',
          repoRoot: isolatedRepoRoot,
          maxParallelism: 1,
        },
      },
    };

    await sendRequest(failureServer, callRequest);
    const callResponse = await failureReader.next(msg => msg.id === callRequest.id, 20_000);

    assert.ok(!Object.hasOwn(callResponse, 'error'));
    const result = assertToolCallResultContract(callResponse.result, {
      requireIsError: true,
    });
    const text = readToolCallText(result);

    assert.ok(text.includes('cdx failed:'));
  } finally {
    await stopProcess(failureServer);
    await removeDirWithRetry(isolatedRoot);
  }
});

test('cdx app-server orchestrator streams events and runs agents in parallel', { timeout: 30_000 }, async () => {
  const runId = `stream-run-${Date.now()}`;
  const callRequest = {
    jsonrpc: '2.0',
    id: nextId(),
    method: 'tools/call',
    params: {
      name: 'run',
      arguments: {
        runId,
        prompt: 'Ship a minimal demo',
        maxParallelism: 2,
      },
    },
  };

  const baseline = reader.allMessages.length;
  await sendRequest(server, callRequest);
  const callResponse = await reader.next(msg => msg.id === callRequest.id, 30_000);
  assert.ok(callResponse.result);

  const structured = callResponse.result.structured_content;
  assert.ok(structured);
  assert.equal(structured.metadata?.id, runId);
  assert.equal(structured.tasks.length, 3);
  structured.tasks.forEach(task => {
    assert.equal(task.status, 'completed');
  });

  const streamMessages = reader.allMessages.slice(baseline);
  const eventMessages = streamMessages.filter(msg => msg.method === 'cdx/event');
  assert.ok(eventMessages.length > 0);

  const events = eventMessages.map(msg => msg.params ?? {});
  assert.ok(events.some(evt => evt.type === 'run.started'));
  assert.ok(events.some(evt => evt.type === 'agent.started' && evt.agentId === 'planner'));
  assert.ok(events.some(evt => evt.type === 'agent.started' && String(evt.agentId).startsWith('task:')));
  assert.ok(
    events.some(
      evt =>
        evt.type === 'appserver.notification' &&
        String(evt.agentId).startsWith('task:') &&
        String(evt.method).startsWith('item/'),
    ),
  );

  const startedBeforeCompleted = new Set();
  for (const evt of events) {
    if (evt.type === 'task.completed') break;
    if (evt.type === 'task.started' && evt.taskId) {
      startedBeforeCompleted.add(evt.taskId);
    }
  }
  assert.ok(startedBeforeCompleted.size >= 2);
});

test('cdx app-server orchestrator can auto-commit a dirty worktree before running', { timeout: 30_000 }, async () => {
  const serverPath = path.join(TEST_PROJECT_ROOT, 'src', 'cli', 'cdx-appserver-mcp-server.js');
  const stubPath = path.join(TEST_PROJECT_ROOT, 'tests', 'app', 'fixtures', 'stubs', 'appserver-stub.js');

  const dirtyRepoRoot = path.join(tempRoot, 'repo-dirty');
  await mkdir(dirtyRepoRoot, { recursive: true });

  await runCommand(dirtyRepoRoot, ['init']);
  await writeFile(path.join(dirtyRepoRoot, 'README.md'), 'hello\n', 'utf8');
  await runCommand(dirtyRepoRoot, ['add', '-A']);
  await runCommand(dirtyRepoRoot, [
    '-c',
    'user.name=test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-m',
    'init',
  ]);

  const dirtyServer = createProcess('node', [serverPath], {
    cwd: dirtyRepoRoot,
    env: {
      CODEX_BIN: 'node',
      CODEX_APP_SERVER_ARGS: JSON.stringify([stubPath]),
      APP_SERVER_STUB_DELAY_MS: '0',
      CDX_WORKTREE_ROOT: path.join(tempRoot, 'worktrees-dirty'),
      CDX_RUN_ID: 'dirty-run',
      CDX_MAX_PARALLELISM: '1',
      CDX_EVENT_STREAM: '1',
      CDX_EVENT_STREAM_DELTAS: '0',
      CDX_STREAM_EVENTS: '0',
      CDX_STATS_AUTO_OPEN: '0',
      CDX_DIRTY_WORKTREE: 'commit',
      CDX_DIRTY_WORKTREE_COMMIT_MESSAGE: 'autocommit test',
    },
  });

  const dirtyReader = createMessageReader(dirtyServer);

  try {
    const initRequest = {
      jsonrpc: '2.0',
      id: nextId(),
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        clientInfo: { name: 'dirty-test-client', version: '0.0.1' },
      },
    };
    await sendRequest(dirtyServer, initRequest);
    await dirtyReader.next(msg => msg.id === initRequest.id, 5000);

    await writeFile(path.join(dirtyRepoRoot, 'dirty.txt'), 'dirty\n', 'utf8');

    const callRequest = {
      jsonrpc: '2.0',
      id: nextId(),
      method: 'tools/call',
      params: {
        name: 'run',
        arguments: {
          prompt: 'Ship a minimal demo',
          repoRoot: dirtyRepoRoot,
          maxParallelism: 1,
        },
      },
    };

    await sendRequest(dirtyServer, callRequest);
    const callResponse = await dirtyReader.next(msg => msg.id === callRequest.id, 30_000);
    assert.ok(callResponse.result);

    const message = await runCommand(dirtyRepoRoot, [
      'log',
      '--pretty=%B',
      '--grep',
      '^autocommit test$',
      '-n',
      '1',
    ]);
    assert.equal(message.trim(), 'autocommit test');
  } finally {
    await stopProcess(dirtyServer);
  }
});

test('cdx app-server orchestrator can auto-init a missing git repo before running', { timeout: 30_000 }, async () => {
  const serverPath = path.join(TEST_PROJECT_ROOT, 'src', 'cli', 'cdx-appserver-mcp-server.js');
  const stubPath = path.join(TEST_PROJECT_ROOT, 'tests', 'app', 'fixtures', 'stubs', 'appserver-stub.js');

  const initRepoRoot = path.join(tempRoot, 'repo-init');
  await mkdir(initRepoRoot, { recursive: true });
  await writeFile(path.join(initRepoRoot, 'README.md'), 'hello\n', 'utf8');

  const initServer = createProcess('node', [serverPath], {
    cwd: initRepoRoot,
    env: {
      CODEX_BIN: 'node',
      CODEX_APP_SERVER_ARGS: JSON.stringify([stubPath]),
      APP_SERVER_STUB_DELAY_MS: '0',
      CDX_WORKTREE_ROOT: path.join(tempRoot, 'worktrees-init'),
      CDX_RUN_ID: 'init-run',
      CDX_MAX_PARALLELISM: '1',
      CDX_EVENT_STREAM: '1',
      CDX_EVENT_STREAM_DELTAS: '0',
      CDX_STREAM_EVENTS: '0',
      CDX_STATS_AUTO_OPEN: '0',
      CDX_REPO_INIT: '1',
      CDX_REPO_INIT_COMMIT_MESSAGE: 'bootstrap test',
    },
  });

  const initReader = createMessageReader(initServer);

  try {
    const initRequest = {
      jsonrpc: '2.0',
      id: nextId(),
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        clientInfo: { name: 'init-test-client', version: '0.0.1' },
      },
    };
    await sendRequest(initServer, initRequest);
    await initReader.next(msg => msg.id === initRequest.id, 5000);

    const callRequest = {
      jsonrpc: '2.0',
      id: nextId(),
      method: 'tools/call',
      params: {
        name: 'run',
        arguments: {
          prompt: 'Ship a minimal demo',
          repoRoot: initRepoRoot,
          maxParallelism: 1,
        },
      },
    };

    await sendRequest(initServer, callRequest);
    const callResponse = await initReader.next(msg => msg.id === callRequest.id, 30_000);
    assert.ok(callResponse.result);

    const message = await runCommand(initRepoRoot, [
      'log',
      '--pretty=%B',
      '--grep',
      '^bootstrap test$',
      '-n',
      '1',
    ]);
    assert.equal(message.trim(), 'bootstrap test');
  } finally {
    await stopProcess(initServer);
  }
});

test('cdx spawn can hand off detached backend runs and proxy status back to the frontend MCP server', { timeout: 30_000 }, async () => {
  const serverPath = path.join(TEST_PROJECT_ROOT, 'src', 'cli', 'cdx-appserver-mcp-server.js');
  const stubPath = path.join(TEST_PROJECT_ROOT, 'tests', 'app', 'fixtures', 'stubs', 'appserver-stub.js');
  const detachedRoot = await mkdtemp(path.join(os.tmpdir(), 'cdx-detached-backend-test-'));
  const detachedRepoRoot = path.join(detachedRoot, 'repo');
  const registryPath = path.join(detachedRoot, 'run-backend-registry.json');
  const journalPath = path.join(detachedRoot, 'run-journal.json');

  await initRepo(detachedRepoRoot);

  let detachedServer = null;
  let detachedReader = null;
  let backendPid = null;

  try {
    detachedServer = createProcess('node', [serverPath], {
      cwd: detachedRoot,
      env: {
        CODEX_BIN: 'node',
        CODEX_APP_SERVER_ARGS: JSON.stringify([stubPath]),
        APP_SERVER_STUB_DELAY_MS: '0',
        CDX_WORKTREE_ROOT: path.join(detachedRoot, 'worktrees'),
        CDX_MAX_PARALLELISM: '1',
        CDX_EVENT_STREAM: '0',
        CDX_STREAM_EVENTS: '0',
        CDX_STATS_AUTO_OPEN: '0',
        CDX_BACKGROUND_BACKEND_ENABLED: '1',
        CDX_RUN_BACKEND_REGISTRY_PATH: registryPath,
        CDX_RUN_JOURNAL_PATH: journalPath,
        CDX_RUN_BACKEND_START_TIMEOUT_MS: '5000',
      },
    });
    detachedReader = createMessageReader(detachedServer);

    const initRequest = {
      jsonrpc: '2.0',
      id: nextId(),
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        clientInfo: { name: 'detached-backend-client', version: '0.0.1' },
      },
    };
    await sendRequest(detachedServer, initRequest);
    await detachedReader.next(msg => msg.id === initRequest.id, 5000);

    const spawnRequest = {
      jsonrpc: '2.0',
      id: nextId(),
      method: 'tools/call',
      params: {
        name: 'spawn',
        arguments: {
          prompt: 'Ship a minimal demo',
          repoRoot: detachedRepoRoot,
          maxParallelism: 1,
        },
      },
    };
    await sendRequest(detachedServer, spawnRequest);
    const spawnResponse = await detachedReader.next(msg => msg.id === spawnRequest.id, 30_000);
    const spawnResult = assertToolCallResultContract(spawnResponse.result, {
      requireStructuredContent: true,
    });
    const spawnStructured = getToolCallStructuredContent(spawnResult);

    const runId = typeof spawnStructured?.runId === 'string' ? spawnStructured.runId : null;
    assert.ok(runId);
    assert.equal(spawnStructured?.background, true);

    const registry = JSON.parse(await readFile(registryPath, 'utf8'));
    backendPid = Number.parseInt(String(registry?.pid ?? ''), 10);
    assert.ok(Number.isInteger(backendPid) && backendPid > 0);
    assert.match(String(registry?.url ?? ''), /^http:\/\/127\.0\.0\.1:\d+\/$/);

    const statusRequest = {
      jsonrpc: '2.0',
      id: nextId(),
      method: 'tools/call',
      params: {
        name: 'status',
        arguments: {
          runId,
          includeTasks: true,
          includeAgents: false,
          includeAsks: true,
        },
      },
    };
    await sendRequest(detachedServer, statusRequest);
    const statusResponse = await detachedReader.next(msg => msg.id === statusRequest.id, 30_000);
    const statusResult = assertToolCallResultContract(statusResponse.result, {
      requireStructuredContent: true,
    });
    const statusStructured = getToolCallStructuredContent(statusResult);

    assert.equal(statusStructured?.runId, runId);
    assert.ok(['running', 'completed'].includes(statusStructured?.status));
    assert.ok(Array.isArray(statusStructured?.tasks));
  } finally {
    await stopProcess(detachedServer);
    await stopDetachedProcess(backendPid);
    await removeDirWithRetry(detachedRoot);
  }
});

test('cdx status can revive detached backend journal state after backend exit and mark unfinished runs orphaned', { timeout: 40_000 }, async () => {
  const serverPath = path.join(TEST_PROJECT_ROOT, 'src', 'cli', 'cdx-appserver-mcp-server.js');
  const stubPath = path.join(TEST_PROJECT_ROOT, 'tests', 'app', 'fixtures', 'stubs', 'appserver-stub.js');
  const detachedRoot = await mkdtemp(path.join(os.tmpdir(), 'cdx-detached-recovery-test-'));
  const detachedRepoRoot = path.join(detachedRoot, 'repo');
  const registryPath = path.join(detachedRoot, 'run-backend-registry.json');
  const journalPath = path.join(detachedRoot, 'run-journal.json');

  await initRepo(detachedRepoRoot);

  let detachedServer = null;
  let detachedReader = null;
  let backendPid = null;

  try {
    detachedServer = createProcess('node', [serverPath], {
      cwd: detachedRoot,
      env: {
        CODEX_BIN: 'node',
        CODEX_APP_SERVER_ARGS: JSON.stringify([stubPath]),
        APP_SERVER_STUB_DELAY_MS: '5000',
        CDX_WORKTREE_ROOT: path.join(detachedRoot, 'worktrees'),
        CDX_MAX_PARALLELISM: '1',
        CDX_EVENT_STREAM: '0',
        CDX_STREAM_EVENTS: '0',
        CDX_STATS_AUTO_OPEN: '0',
        CDX_BACKGROUND_BACKEND_ENABLED: '1',
        CDX_RUN_BACKEND_REGISTRY_PATH: registryPath,
        CDX_RUN_JOURNAL_PATH: journalPath,
        CDX_RUN_BACKEND_START_TIMEOUT_MS: '5000',
      },
    });
    detachedReader = createMessageReader(detachedServer);

    const initRequest = {
      jsonrpc: '2.0',
      id: nextId(),
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        clientInfo: { name: 'detached-recovery-client', version: '0.0.1' },
      },
    };
    await sendRequest(detachedServer, initRequest);
    await detachedReader.next(msg => msg.id === initRequest.id, 5000);

    const spawnRequest = {
      jsonrpc: '2.0',
      id: nextId(),
      method: 'tools/call',
      params: {
        name: 'spawn',
        arguments: {
          prompt: 'Ship a minimal demo',
          repoRoot: detachedRepoRoot,
          maxParallelism: 1,
        },
      },
    };
    await sendRequest(detachedServer, spawnRequest);
    const spawnResponse = await detachedReader.next(msg => msg.id === spawnRequest.id, 30_000);
    const spawnResult = assertToolCallResultContract(spawnResponse.result, {
      requireStructuredContent: true,
    });
    const spawnStructured = getToolCallStructuredContent(spawnResult);

    const runId = typeof spawnStructured?.runId === 'string' ? spawnStructured.runId : null;
    assert.ok(runId);

    await waitForCondition(async () => {
      const journal = JSON.parse(await readFile(journalPath, 'utf8'));
      return Array.isArray(journal?.runs) && journal.runs.some(entry => entry?.runId === runId)
        ? journal
        : null;
    }, {
      timeoutMs: 10_000,
      intervalMs: 100,
      label: 'journaled detached run',
    });

    const registry = JSON.parse(await readFile(registryPath, 'utf8'));
    backendPid = Number.parseInt(String(registry?.pid ?? ''), 10);
    assert.ok(Number.isInteger(backendPid) && backendPid > 0);

    await stopDetachedProcess(backendPid);
    await waitForCondition(() => {
      try {
        process.kill(backendPid, 0);
        return false;
      } catch {
        return true;
      }
    }, {
      timeoutMs: 10_000,
      intervalMs: 100,
      label: 'detached backend shutdown',
    });

    const statusRequest = {
      jsonrpc: '2.0',
      id: nextId(),
      method: 'tools/call',
      params: {
        name: 'status',
        arguments: {
          runId,
          includeTasks: true,
          includeAgents: false,
          includeAsks: true,
        },
      },
    };
    await sendRequest(detachedServer, statusRequest);
    const statusResponse = await detachedReader.next(msg => msg.id === statusRequest.id, 30_000);
    const statusResult = assertToolCallResultContract(statusResponse.result, {
      requireStructuredContent: true,
    });
    const statusStructured = getToolCallStructuredContent(statusResult);

	    assert.equal(statusStructured?.runId, runId);
	    assert.equal(statusStructured?.status, 'orphaned');
	    assert.equal(statusStructured?.recoveredFromJournal, true);
	    assert.ok(typeof statusStructured?.orphanedReason === 'string' && statusStructured.orphanedReason.length > 0);
	    assert.match(readToolCallText(statusResult), /status=orphaned/);
	    assert.match(readToolCallText(statusResult), /cdx\.resume/);
	    assert.equal(statusStructured?.resume?.resumable, true);
	    assert.equal(statusStructured?.resume?.recommendedResume?.tool, 'cdx.resume');
	    assert.equal(statusStructured?.resume?.recommendedResume?.arguments?.runId, runId);

	    const revivedRegistry = JSON.parse(await readFile(registryPath, 'utf8'));
	    const revivedPid = Number.parseInt(String(revivedRegistry?.pid ?? ''), 10);
	    assert.ok(Number.isInteger(revivedPid) && revivedPid > 0);
    assert.notEqual(revivedPid, backendPid);
    backendPid = revivedPid;
  } finally {
    await stopProcess(detachedServer);
    await stopDetachedProcess(backendPid);
    await removeDirWithRetry(detachedRoot);
	  }
	});

test('cdx resume can restart an orphaned detached run and persist old/new run linkage', { timeout: 50_000 }, async () => {
  const serverPath = path.join(TEST_PROJECT_ROOT, 'src', 'cli', 'cdx-appserver-mcp-server.js');
  const stubPath = path.join(TEST_PROJECT_ROOT, 'tests', 'app', 'fixtures', 'stubs', 'appserver-stub.js');
  const detachedRoot = await mkdtemp(path.join(os.tmpdir(), 'cdx-detached-resume-test-'));
  const detachedRepoRoot = path.join(detachedRoot, 'repo');
  const registryPath = path.join(detachedRoot, 'run-backend-registry.json');
  const journalPath = path.join(detachedRoot, 'run-journal.json');

  await initRepo(detachedRepoRoot);

  let detachedServer = null;
  let detachedReader = null;
  let backendPid = null;

  try {
    detachedServer = createProcess('node', [serverPath], {
      cwd: detachedRoot,
      env: {
        CODEX_BIN: 'node',
        CODEX_APP_SERVER_ARGS: JSON.stringify([stubPath]),
        APP_SERVER_STUB_DELAY_MS: '5000',
        CDX_WORKTREE_ROOT: path.join(detachedRoot, 'worktrees'),
        CDX_MAX_PARALLELISM: '1',
        CDX_EVENT_STREAM: '0',
        CDX_STREAM_EVENTS: '0',
        CDX_STATS_AUTO_OPEN: '0',
        CDX_BACKGROUND_BACKEND_ENABLED: '1',
        CDX_RUN_BACKEND_REGISTRY_PATH: registryPath,
        CDX_RUN_JOURNAL_PATH: journalPath,
        CDX_RUN_BACKEND_START_TIMEOUT_MS: '5000',
      },
    });
    detachedReader = createMessageReader(detachedServer);

    const initRequest = {
      jsonrpc: '2.0',
      id: nextId(),
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        clientInfo: { name: 'detached-resume-client', version: '0.0.1' },
      },
    };
    await sendRequest(detachedServer, initRequest);
    await detachedReader.next(msg => msg.id === initRequest.id, 5000);

    const spawnRequest = {
      jsonrpc: '2.0',
      id: nextId(),
      method: 'tools/call',
      params: {
        name: 'spawn',
        arguments: {
          prompt: 'Ship a minimal demo',
          repoRoot: detachedRepoRoot,
          maxParallelism: 1,
        },
      },
    };
    await sendRequest(detachedServer, spawnRequest);
    const spawnResponse = await detachedReader.next(msg => msg.id === spawnRequest.id, 30_000);
    const spawnResult = assertToolCallResultContract(spawnResponse.result, {
      requireStructuredContent: true,
    });
    const spawnStructured = getToolCallStructuredContent(spawnResult);
    const orphanedRunId = typeof spawnStructured?.runId === 'string' ? spawnStructured.runId : null;
    assert.ok(orphanedRunId);

    await waitForCondition(async () => {
      const journal = JSON.parse(await readFile(journalPath, 'utf8'));
      return Array.isArray(journal?.runs) && journal.runs.some(entry => entry?.runId === orphanedRunId)
        ? journal
        : null;
    }, {
      timeoutMs: 10_000,
      intervalMs: 100,
      label: 'journaled detached run before resume',
    });

    const registry = JSON.parse(await readFile(registryPath, 'utf8'));
    backendPid = Number.parseInt(String(registry?.pid ?? ''), 10);
    assert.ok(Number.isInteger(backendPid) && backendPid > 0);

    await stopDetachedProcess(backendPid);
    await waitForCondition(() => {
      try {
        process.kill(backendPid, 0);
        return false;
      } catch {
        return true;
      }
    }, {
      timeoutMs: 10_000,
      intervalMs: 100,
      label: 'detached backend shutdown before resume',
    });

    const orphanStatusRequest = {
      jsonrpc: '2.0',
      id: nextId(),
      method: 'tools/call',
      params: {
        name: 'status',
        arguments: {
          runId: orphanedRunId,
          includeTasks: true,
          includeAgents: false,
          includeAsks: true,
        },
      },
    };
    await sendRequest(detachedServer, orphanStatusRequest);
    const orphanStatusResponse = await detachedReader.next(msg => msg.id === orphanStatusRequest.id, 30_000);
    const orphanStatusResult = assertToolCallResultContract(orphanStatusResponse.result, {
      requireStructuredContent: true,
    });
    const orphanStatusStructured = getToolCallStructuredContent(orphanStatusResult);
    assert.equal(orphanStatusStructured?.status, 'orphaned');
    assert.equal(orphanStatusStructured?.resume?.resumable, true);

    const revivedRegistry = JSON.parse(await readFile(registryPath, 'utf8'));
    const revivedPid = Number.parseInt(String(revivedRegistry?.pid ?? ''), 10);
    assert.ok(Number.isInteger(revivedPid) && revivedPid > 0);
    assert.notEqual(revivedPid, backendPid);
    backendPid = revivedPid;

    const resumeRequest = {
      jsonrpc: '2.0',
      id: nextId(),
      method: 'tools/call',
      params: {
        name: 'resume',
        arguments: {
          runId: orphanedRunId,
        },
      },
    };
    await sendRequest(detachedServer, resumeRequest);
    const resumeResponse = await detachedReader.next(msg => msg.id === resumeRequest.id, 30_000);
    const resumeResult = assertToolCallResultContract(resumeResponse.result, {
      requireStructuredContent: true,
    });
    const resumeStructured = getToolCallStructuredContent(resumeResult);
    const resumedRunId = typeof resumeStructured?.runId === 'string' ? resumeStructured.runId : null;

    assert.ok(resumedRunId);
    assert.notEqual(resumedRunId, orphanedRunId);
    assert.equal(resumeStructured?.resumedFromRunId, orphanedRunId);
    assert.ok(['running', 'completed'].includes(resumeStructured?.status));

    await waitForCondition(async () => {
      const journal = JSON.parse(await readFile(journalPath, 'utf8'));
      if (!Array.isArray(journal?.runs)) return false;
      const oldEntry = journal.runs.find(entry => entry?.runId === orphanedRunId);
      const newEntry = journal.runs.find(entry => entry?.runId === resumedRunId);
      return oldEntry?.resumedIntoRunId === resumedRunId && newEntry?.resumedFromRunId === orphanedRunId;
    }, {
      timeoutMs: 10_000,
      intervalMs: 100,
      label: 'resume linkage journal flush',
    });

    const oldStatusRequest = {
      jsonrpc: '2.0',
      id: nextId(),
      method: 'tools/call',
      params: {
        name: 'status',
        arguments: {
          runId: orphanedRunId,
          includeTasks: true,
          includeAgents: false,
          includeAsks: true,
        },
      },
    };
    await sendRequest(detachedServer, oldStatusRequest);
    const oldStatusResponse = await detachedReader.next(msg => msg.id === oldStatusRequest.id, 30_000);
    const oldStatusResult = assertToolCallResultContract(oldStatusResponse.result, {
      requireStructuredContent: true,
    });
    const oldStatusStructured = getToolCallStructuredContent(oldStatusResult);
    assert.equal(oldStatusStructured?.status, 'orphaned');
    assert.equal(oldStatusStructured?.resumedIntoRunId, resumedRunId);
    assert.equal(oldStatusStructured?.resume?.resumable, false);
    assert.equal(oldStatusStructured?.resume?.recommendedStatus?.arguments?.runId, resumedRunId);

    const resumedStatusRequest = {
      jsonrpc: '2.0',
      id: nextId(),
      method: 'tools/call',
      params: {
        name: 'status',
        arguments: {
          runId: resumedRunId,
          includeTasks: true,
          includeAgents: false,
          includeAsks: true,
        },
      },
    };
    await sendRequest(detachedServer, resumedStatusRequest);
    const resumedStatusResponse = await detachedReader.next(msg => msg.id === resumedStatusRequest.id, 30_000);
    const resumedStatusResult = assertToolCallResultContract(resumedStatusResponse.result, {
      requireStructuredContent: true,
    });
    const resumedStatusStructured = getToolCallStructuredContent(resumedStatusResult);
    assert.equal(resumedStatusStructured?.runId, resumedRunId);
    assert.equal(resumedStatusStructured?.resumedFromRunId, orphanedRunId);
  } finally {
    await stopProcess(detachedServer);
    await stopDetachedProcess(backendPid);
    await removeDirWithRetry(detachedRoot);
  }
});

test('app-server client times out hung requests', { timeout: 10_000 }, async () => {
  const previous = process.env.CDX_APP_SERVER_REQUEST_TIMEOUT_MS;
  process.env.CDX_APP_SERVER_REQUEST_TIMEOUT_MS = '150';

  const client = new AppServerClient({
    command: 'node',
    args: ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000);'],
    log: () => {},
  });

  try {
    await assert.rejects(
      client.ensureInitialized(),
      err => err instanceof Error && err.code === 'ETIMEDOUT',
    );
  } finally {
    await client.dispose('test-timeout');
    if (previous === undefined) {
      delete process.env.CDX_APP_SERVER_REQUEST_TIMEOUT_MS;
    } else {
      process.env.CDX_APP_SERVER_REQUEST_TIMEOUT_MS = previous;
    }
  }
});

test('app-server client defaults codex launches to ChatGPT auth', () => {
  const args = prepareCodexAppServerArgs('codex', ['app-server'], { authMode: 'chatgpt' });
  assert.deepEqual(args, ['-c', 'forced_login_method="chatgpt"', 'app-server']);

  const explicitArgs = prepareCodexAppServerArgs(
    'codex',
    ['-c', 'forced_login_method="api"', 'app-server'],
    { authMode: 'chatgpt' },
  );
  assert.deepEqual(explicitArgs, ['-c', 'forced_login_method="api"', 'app-server']);

  const nodeArgs = prepareCodexAppServerArgs('node', ['stub.js'], { authMode: 'chatgpt' });
  assert.deepEqual(nodeArgs, ['stub.js']);

  const env = prepareCodexAppServerEnv({
    OPENAI_API_KEY: 'api-key',
    CODEX_API_KEY: 'codex-api-key',
    OPENAI_API_BASE: 'https://proxy.example.test/v1',
    OPENAI_PROXY_BASE_URL: 'https://proxy.example.test',
    CODEX_HOME: '/tmp/codex-home',
  }, { authMode: 'chatgpt' });
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.CODEX_API_KEY, undefined);
  assert.equal(env.OPENAI_API_BASE, undefined);
  assert.equal(env.OPENAI_PROXY_BASE_URL, undefined);
  assert.equal(env.CODEX_HOME, '/tmp/codex-home');

  const apiEnv = prepareCodexAppServerEnv({
    OPENAI_API_KEY: 'api-key',
    OPENAI_API_BASE: 'https://proxy.example.test/v1',
  }, { authMode: 'api' });
  assert.equal(apiEnv.OPENAI_API_KEY, 'api-key');
  assert.equal(apiEnv.OPENAI_API_BASE, 'https://proxy.example.test/v1');
});

test('app-server client normalizes tool call responses before resolving requests', async () => {
  const script = `
let buffer = '';
function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  while (true) {
    const newlineIndex = buffer.indexOf('\\n');
    if (newlineIndex === -1) break;
    const line = buffer.slice(0, newlineIndex).replace(/\\r$/, '');
    buffer = buffer.slice(newlineIndex + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
      send(message.id, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { list: true, call: true } },
        serverInfo: { name: 'normalize-stub', version: '0.0.0' },
      });
      continue;
    }
    if (message.method === 'tools/call') {
      send(message.id, {
        structuredContent: { status: 'running', text: 'Normalized from structuredContent' },
        isError: false,
      });
    }
  }
});
process.stdin.resume();
`;

  const client = new AppServerClient({
    command: process.execPath,
    args: ['--input-type=module', '-e', script],
    log: () => {},
  });

  try {
    await client.ensureInitialized();
    const result = await client.request('tools/call', {
      name: 'demo',
      arguments: { hello: 'world' },
    });

    assert.deepEqual(result?.structured_content, {
      status: 'running',
      text: 'Normalized from structuredContent',
    });
    assert.equal(result?.is_error, false);
    assert.deepEqual(result?.content, [
      { type: 'text', text: 'Normalized from structuredContent' },
    ]);
  } finally {
    await client.dispose('test-normalized-tool-call');
  }
});
