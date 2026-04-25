#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createScratchRepo } from '../tools/scripts/git.js';
import { createStdioJsonRpcClient } from '../tools/scripts/mcp.js';
import { stopChild } from '../tools/scripts/node.js';
import { assertReadableFile, resolveProjectRoot } from '../tools/scripts/package-scripts.js';

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_DEADLINE_MS = 45_000;

export function parseArgs(argv) {
  const options = {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    deadlineMs: DEFAULT_DEADLINE_MS,
    verbose: false,
    serverPath: null,
    stubPath: null,
  };

  for (const arg of argv) {
    if (arg === '--verbose') {
      options.verbose = true;
      continue;
    }
    if (arg.startsWith('--timeout-ms=')) {
      const value = Number.parseInt(arg.slice('--timeout-ms='.length), 10);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`Invalid timeout: ${arg}`);
      }
      options.timeoutMs = value;
      continue;
    }
    if (arg.startsWith('--deadline-ms=')) {
      const value = Number.parseInt(arg.slice('--deadline-ms='.length), 10);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`Invalid deadline: ${arg}`);
      }
      options.deadlineMs = value;
      continue;
    }
    if (arg.startsWith('--server-path=')) {
      options.serverPath = arg.slice('--server-path='.length);
      continue;
    }
    if (arg.startsWith('--stub-path=')) {
      options.stubPath = arg.slice('--stub-path='.length);
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

export function printHelp() {
  console.log(`CDX watchdog repro helper

Usage:
  node scripts/watchdog-repro.js [--verbose] [--timeout-ms=10000] [--deadline-ms=45000]
  node scripts/watchdog-repro.js --server-path=/abs/path/to/cdx-appserver-mcp-server.js

Options:
  --verbose              Print raw server stderr while waiting for events.
  --timeout-ms=MS        JSON-RPC request timeout (default: 10000).
  --deadline-ms=MS       Max overall wait for watchdog events (default: 45000).
  --server-path=PATH     Override the CDX app-server entrypoint.
  --stub-path=PATH       Override the backing app-server stub used for repro runs.
`);
}

export function buildWatchdogEnv({
  baseEnv = process.env,
  repoRoot,
  runId,
  stubPath,
  worktreeRoot,
} = {}) {
  return {
    ...baseEnv,
    CODEX_BIN: process.execPath,
    CODEX_APP_SERVER_ARGS: JSON.stringify([stubPath]),
    APP_SERVER_STUB_PLAN_MODE: 'parallel',
    APP_SERVER_STUB_TASK_COUNT: '1',
    APP_SERVER_STUB_DELAY_MS: '0',
    APP_SERVER_STUB_TASK_TEXT_SEQUENCE: JSON.stringify([
      'Remaining work: collect the target evidence.',
      'Still need to collect the target evidence.',
      'WORK COMPLETE: collected the target evidence and finished the task.',
    ]),
    CDX_WORKTREE_ROOT: worktreeRoot,
    CDX_RUN_ID: runId,
    CDX_EVENT_STREAM: '1',
    CDX_EVENT_STREAM_DELTAS: '0',
    CDX_STREAM_EVENTS: '0',
    CDX_STATS_AUTO_OPEN: '0',
    CDX_MAX_PARALLELISM: '1',
    CDX_MIN_PARALLELISM: '1',
    CDX_WATCHDOG_INTERVENTION: '1',
    CDX_WATCHDOG_INTERVENTION_COOLDOWN_MS: '4000',
    CDX_WATCHDOG_INTERVENTION_INTERVAL_MS: '4000',
    CDX_WATCHDOG_RESPAWN_MAX: '2',
    CDX_WATCHDOG_RESPAWN_COOLDOWN_MS: '0',
    CDX_TASK_MAX_EXTRA_TURNS: '1',
    CDX_NO_PROGRESS_TIMEOUT_MS: '0',
    CDX_REPO_ROOT: repoRoot,
  };
}

function resolveServerPath(rootDir, explicitPath) {
  if (explicitPath) {
    return path.isAbsolute(explicitPath) ? explicitPath : path.resolve(rootDir, explicitPath);
  }
  return path.join(rootDir, 'src', 'cli', 'cdx-appserver-mcp-server.js');
}

function resolveStubPath(rootDir, explicitPath) {
  if (explicitPath) {
    return path.isAbsolute(explicitPath) ? explicitPath : path.resolve(rootDir, explicitPath);
  }
  return path.join(rootDir, 'tools', 'scripts', 'appserver-stub.js');
}

export async function runWatchdogRepro({
  rootDir = resolveProjectRoot(import.meta.url),
  serverPath: explicitServerPath = null,
  stubPath: explicitStubPath = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  deadlineMs = DEFAULT_DEADLINE_MS,
  verbose = false,
} = {}) {
  const serverPath = resolveServerPath(rootDir, explicitServerPath);
  const stubPath = resolveStubPath(rootDir, explicitStubPath);
  await assertReadableFile(serverPath, 'CDX app-server entrypoint');
  await assertReadableFile(stubPath, 'Watchdog repro stub');

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cdx-watchdog-repro-'));
  const repoRoot = path.join(tempRoot, 'repo');
  const worktreeRoot = path.join(tempRoot, 'worktrees');
  const runId = `watchdog-repro-${Date.now()}`;

  await createScratchRepo(repoRoot);

  const env = buildWatchdogEnv({
    repoRoot,
    runId,
    stubPath,
    worktreeRoot,
  });

  const server = spawn(process.execPath, [serverPath], {
    cwd: tempRoot,
    env,
    stdio: ['pipe', 'pipe', verbose ? 'inherit' : 'pipe'],
  });
  const client = createStdioJsonRpcClient(server, { defaultTimeoutMs: timeoutMs });

  try {
    await client.request('initialize', {
      protocolVersion: '2025-06-18',
      clientInfo: { name: 'watchdog-repro', version: '0.0.0' },
    });
    client.notify('codex/sandbox-state/update', { sandboxCwd: repoRoot });
    await client.request('tools/list', {});

    const runResponse = await client.request(
      'tools/call',
      {
        name: 'run',
        arguments: {
          runId,
          prompt: 'Reproduce watchdog interventions',
          repoRoot,
          background: true,
        },
      },
      { timeoutMs },
    );

    const runStatus = runResponse?.result?.structured_content?.status
      ?? runResponse?.result?.structuredContent?.status
      ?? 'unknown';
    if (runStatus !== 'running') {
      throw new Error(`Unexpected run status: ${runStatus}`);
    }

    const found = {
      intervention: null,
      followupExhausted: null,
      respawned: null,
    };
    const watchdogLogs = [];

    const deadline = Date.now() + deadlineMs;
    let notificationIndex = 0;

    while (Date.now() < deadline) {
      while (notificationIndex < client.notifications.length) {
        const message = client.notifications[notificationIndex];
        notificationIndex += 1;
        if (!message || typeof message !== 'object') continue;

        if (message.method === 'logging/message') {
          const text = message.params?.message;
          if (typeof text === 'string' && text.includes('[watchdog]')) {
            watchdogLogs.push(text);
          }
        }

        if (message.method === 'cdx/event') {
          const event = message.params;
          if (!event || typeof event !== 'object') continue;
          if (event.type === 'watchdog.intervention' && !found.intervention) {
            found.intervention = event;
          }
          if (event.type === 'task.followup.exhausted' && !found.followupExhausted) {
            found.followupExhausted = event;
          }
          if (event.type === 'task.respawned' && !found.respawned) {
            found.respawned = event;
          }
        }
      }

      if (found.followupExhausted && found.respawned) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    return {
      success: Boolean(found.followupExhausted && found.respawned),
      found: {
        intervention: Boolean(found.intervention),
        followupExhausted: Boolean(found.followupExhausted),
        respawned: Boolean(found.respawned),
      },
      intervention: found.intervention,
      followupExhausted: found.followupExhausted,
      respawned: found.respawned,
      watchdogLogs: watchdogLogs.slice(-5),
      runId,
    };
  } finally {
    await client.dispose().catch(() => {});
    await stopChild(server).catch(() => {});
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const summary = await runWatchdogRepro(options);
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.success) {
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
