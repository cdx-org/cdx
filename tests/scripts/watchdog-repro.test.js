import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildWatchdogEnv,
  parseArgs,
  runWatchdogRepro,
} from '../../scripts/watchdog-repro.js';

test('parseArgs accepts watchdog repro overrides', () => {
  assert.deepEqual(
    parseArgs([
      '--verbose',
      '--timeout-ms=1234',
      '--deadline-ms=5678',
      '--server-path=src/cli/server.js',
      '--stub-path=tools/scripts/stub.js',
    ]),
    {
      timeoutMs: 1234,
      deadlineMs: 5678,
      verbose: true,
      serverPath: 'src/cli/server.js',
      stubPath: 'tools/scripts/stub.js',
    },
  );
});

test('buildWatchdogEnv configures the standalone repro defaults', () => {
  const env = buildWatchdogEnv({
    baseEnv: { PATH: process.env.PATH ?? '' },
    repoRoot: '/tmp/repo',
    runId: 'run-123',
    stubPath: '/tmp/stub.js',
    worktreeRoot: '/tmp/worktrees',
  });

  assert.equal(env.CODEX_BIN, process.execPath);
  assert.equal(env.CODEX_APP_SERVER_ARGS, JSON.stringify(['/tmp/stub.js']));
  assert.equal(env.CDX_REPO_ROOT, '/tmp/repo');
  assert.equal(env.CDX_RUN_ID, 'run-123');
  assert.equal(env.CDX_WORKTREE_ROOT, '/tmp/worktrees');
});

test('runWatchdogRepro succeeds against a fake app-server', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'cdx-watchdog-script-'));

  try {
    await mkdir(path.join(rootDir, 'src', 'cli'), { recursive: true });
    await mkdir(path.join(rootDir, 'tools', 'scripts'), { recursive: true });

    await writeFile(path.join(rootDir, 'tools', 'scripts', 'stub.js'), 'console.log("stub");\n', 'utf8');
    await writeFile(
      path.join(rootDir, 'src', 'cli', 'fake-appserver.js'),
      `import readline from 'node:readline';

const reader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(payload) {
  process.stdout.write(JSON.stringify(payload) + '\\n');
}

reader.on('line', line => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const message = JSON.parse(trimmed);

  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { serverInfo: { name: 'fake-appserver', version: '0.0.0' } },
    });
    return;
  }

  if (message.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { tools: [{ name: 'run' }, { name: 'status' }, { name: 'ps' }] },
    });
    return;
  }

  if (message.method === 'tools/call') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { structured_content: { status: 'running' } },
    });
    setTimeout(() => {
      send({ jsonrpc: '2.0', method: 'logging/message', params: { message: '[watchdog] intervention started' } });
      send({ jsonrpc: '2.0', method: 'cdx/event', params: { type: 'watchdog.intervention', reason: 'test' } });
      send({ jsonrpc: '2.0', method: 'cdx/event', params: { type: 'task.followup.exhausted', taskId: 'alpha' } });
      send({ jsonrpc: '2.0', method: 'cdx/event', params: { type: 'task.respawned', taskId: 'alpha' } });
    }, 25);
    return;
  }
});
`,
      'utf8',
    );

    const summary = await runWatchdogRepro({
      rootDir,
      serverPath: path.join(rootDir, 'src', 'cli', 'fake-appserver.js'),
      stubPath: path.join(rootDir, 'tools', 'scripts', 'stub.js'),
      timeoutMs: 4000,
      deadlineMs: 4000,
    });

    assert.equal(summary.success, true);
    assert.deepEqual(summary.found, {
      intervention: true,
      followupExhausted: true,
      respawned: true,
    });
    assert.match(summary.watchdogLogs[0] ?? '', /\[watchdog\]/);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
