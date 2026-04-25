import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  parseArgs,
  runPackageStartupSmoke,
} from '../../scripts/smoke-startup-paths.js';

function runChild(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
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
    child.on('error', reject);
    child.on('close', code => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function createFixtureProject() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'cdx-startup-smoke-'));
  await mkdir(path.join(rootDir, 'src', 'cli'), { recursive: true });
  await mkdir(path.join(rootDir, 'scripts'), { recursive: true });

  await writeFile(
    path.join(rootDir, 'package.json'),
    JSON.stringify(
      {
        name: 'mcp-cdx',
        type: 'module',
        scripts: {
          'start:cdx-appserver': 'node src/cli/mock-appserver.js',
          'smoke:cdx-stats': 'node scripts/mock-stats.js',
          'smoke:cdx-stats:new-layout': 'node scripts/mock-stats.js --require-new-layout',
        },
      },
      null,
      2,
    ),
    'utf8',
  );

  await writeFile(
    path.join(rootDir, 'src', 'cli', 'mock-appserver.js'),
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
      result: {
        serverInfo: { name: 'cdx-appserver-orchestrator', version: '0.0.0' },
      },
    });
    return;
  }

  if (message.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [{ name: 'run' }, { name: 'status' }, { name: 'ps' }],
      },
    });
    return;
  }

  if (Object.prototype.hasOwnProperty.call(message, 'id')) {
    send({ jsonrpc: '2.0', id: message.id, result: {} });
  }
});
`,
    'utf8',
  );

  await writeFile(path.join(rootDir, 'scripts', 'mock-stats.js'), 'console.log("ok");\n', 'utf8');
  return rootDir;
}

test('parseArgs accepts custom script lists', () => {
  assert.deepEqual(parseArgs(['--scripts=start:cdx-appserver', '--timeout-ms=2500']), {
    requiredScriptNames: ['start:cdx-appserver'],
    timeoutMs: 2500,
    verbose: false,
  });
});

test('runPackageStartupSmoke verifies package startup scripts against a mock MCP server', async () => {
  const rootDir = await createFixtureProject();

  try {
    const result = await runPackageStartupSmoke({
      rootDir,
      timeoutMs: 4000,
    });

    assert.equal(result.skipped, false);
    assert.deepEqual(result.verifiedScripts, [
      'start:cdx-appserver',
      'smoke:cdx-stats',
      'smoke:cdx-stats:new-layout',
    ]);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('smoke-startup-paths CLI works against the real repo checkout', async () => {
  const result = await runChild(process.execPath, ['scripts/smoke-startup-paths.js'], {
    cwd: path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')),
    env: {
      ...process.env,
      CDX_INTEGRATION_EMPTY_FAIL: '0',
      CDX_VALIDATE_TASK: '0',
      CDX_STATS_ENABLED: '0',
      CDX_ROUTER_ENABLED: '0',
      CDX_USE_WORKTREES: '1',
    },
  });

  assert.equal(result.code, 0, result.stderr || result.stdout);
});
