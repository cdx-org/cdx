#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createStdioJsonRpcClient, mcpInitialize, mcpListTools } from '../tools/scripts/mcp.js';
import { attachDrain, stopChild } from '../tools/scripts/node.js';
import {
  DEFAULT_REQUIRED_NODE_ENTRY_SCRIPTS,
  loadDeclaredEntrypoints,
  resolveProjectRoot,
} from '../tools/scripts/package-scripts.js';

export const DEFAULT_TIMEOUT_MS = 10_000;

function parseScriptList(value) {
  return String(value ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

export function parseArgs(argv) {
  const options = {
    requiredScriptNames: [...DEFAULT_REQUIRED_NODE_ENTRY_SCRIPTS],
    timeoutMs: DEFAULT_TIMEOUT_MS,
    verbose: false,
  };

  let customScripts = null;

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
    if (arg.startsWith('--scripts=')) {
      customScripts = parseScriptList(arg.slice('--scripts='.length));
      continue;
    }
    if (arg.startsWith('--script=')) {
      customScripts ??= [];
      customScripts.push(...parseScriptList(arg.slice('--script='.length)));
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (customScripts) {
    options.requiredScriptNames = [...new Set(customScripts)];
  }

  return options;
}

export function printHelp() {
  console.log(`Package startup smoke test

Usage:
  node scripts/smoke-startup-paths.js [--verbose] [--timeout-ms=10000]
  node scripts/smoke-startup-paths.js --scripts=start:cdx-appserver
  node scripts/smoke-startup-paths.js --script=start:cdx-appserver --script=smoke:cdx-stats

Options:
  --verbose              Print child process stdout/stderr while probing startup.
  --timeout-ms=MS        Timeout for initialize and tools/list checks (default: 10000).
  --scripts=A,B          Override the required package script names to validate.
  --script=NAME          Add one required script name. Repeatable.
`);
}

function startNodeEntrypoint(
  entry,
  {
    rootDir = resolveProjectRoot(import.meta.url),
    env = {},
    stdio = ['ignore', 'pipe', 'pipe'],
    verbose = false,
  } = {},
) {
  const child = spawn(process.execPath, [entry.entryPath, ...entry.args], {
    cwd: rootDir,
    env: {
      ...process.env,
      ...env,
    },
    stdio,
  });

  attachDrain(child, { name: entry.scriptName, enabled: verbose, stdout: stdio[1] === 'pipe' });
  return child;
}

async function runPrimaryStartupPathSmoke(
  entries,
  {
    rootDir = resolveProjectRoot(import.meta.url),
    verbose = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {},
) {
  const appserverEntry = entries.get('start:cdx-appserver');
  if (!appserverEntry) {
    throw new Error('Missing required startup script "start:cdx-appserver"');
  }

  const tempCodexHome = await mkdtemp(path.join(os.tmpdir(), 'cdx-smoke-home-'));
  let appserver = null;
  let client = null;

  try {
    appserver = startNodeEntrypoint(appserverEntry, {
      rootDir,
      env: {
        CODEX_HOME: tempCodexHome,
        CDX_INTEGRATION_EMPTY_FAIL: '0',
        CDX_VALIDATE_TASK: '0',
        CDX_STATS_ENABLED: '0',
        CDX_ROUTER_ENABLED: '0',
        CDX_USE_WORKTREES: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      verbose,
    });
    client = createStdioJsonRpcClient(appserver, { defaultTimeoutMs: timeoutMs });

    const init = await mcpInitialize(client, {
      clientInfo: { name: 'smoke-client', version: '0.0.1' },
    });
    if (init?.serverInfo?.name !== 'cdx-appserver-orchestrator') {
      throw new Error(`Unexpected initialize response: ${JSON.stringify(init)}`);
    }

    const tools = await mcpListTools(client);
    const names = new Set(tools.map(tool => tool.name));
    if (!names.has('run') || !names.has('status') || !names.has('ps')) {
      throw new Error(`Unexpected tools/list response: ${JSON.stringify(tools)}`);
    }
  } finally {
    await client?.dispose().catch(() => {});
    await stopChild(appserver).catch(() => {});
    await rm(tempCodexHome, { recursive: true, force: true }).catch(() => {});
  }
}

export async function runPackageStartupSmoke({
  rootDir = resolveProjectRoot(import.meta.url),
  requiredScriptNames = DEFAULT_REQUIRED_NODE_ENTRY_SCRIPTS,
  verbose = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const entries = await loadDeclaredEntrypoints({ rootDir, requiredScriptNames });
  await runPrimaryStartupPathSmoke(entries, { rootDir, verbose, timeoutMs });

  return {
    skipped: false,
    verifiedScripts: [...entries.keys()],
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const result = await runPackageStartupSmoke(options);
  if (result.skipped) {
    console.log(`Skipping smoke test: ${result.reason}.`);
  } else if (options.verbose) {
    console.log(`Verified package entrypoints: ${result.verifiedScripts.join(', ')}`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
