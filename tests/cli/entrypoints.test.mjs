import { spawnSync } from 'node:child_process';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
);
const CLI_ROOT = path.join(PROJECT_ROOT, 'src', 'cli');
const SOURCE_LEAK_PATTERN = /\/Users\/hancho01\/git\/mcp-keepdoing|mcp-keepdoing/;

const CLI_FILES = [
  'bridge.js',
  'cdx-appserver-mcp-server.js',
  'cdx-mcp-server.js',
  'hook-llm-backend.js',
  'orchestrator.js',
  'server.js',
];

const DIRECT_EXECUTABLE_FILES = new Set([
  'cdx-appserver-mcp-server.js',
  'cdx-mcp-server.js',
  'hook-llm-backend.js',
  'orchestrator.js',
]);

function resolveCliPath(name) {
  return path.join(CLI_ROOT, name);
}

async function readCli(name) {
  return readFile(resolveCliPath(name), 'utf8');
}

function parseImports(source) {
  return [...source.matchAll(/^\s*import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"];?\s*$/gm)]
    .map(([, specifier]) => specifier);
}

function assertAllowedImports(file, imports) {
  for (const specifier of imports) {
    if (specifier.startsWith('node:')) continue;
    if (specifier.startsWith('../runtime/')) continue;
    if (file === 'cdx-mcp-server.js' && specifier === './cdx-appserver-mcp-server.js') continue;

    assert.fail(`${file} imports an unexpected module specifier: ${specifier}`);
  }
}

test('CLI entrypoints exist, stay self-contained, and parse cleanly', async () => {
  const dirEntries = await readdir(CLI_ROOT);
  assert.deepEqual(
    dirEntries.filter(name => name.endsWith('.js')).sort(),
    CLI_FILES,
    'src/cli should keep the expected runnable entrypoint inventory',
  );

  for (const file of CLI_FILES) {
    const fullPath = resolveCliPath(file);
    await access(fullPath);

    const source = await readCli(file);
    assert.match(source, /^#!\/usr\/bin\/env node/m, `${file} should keep its node shebang`);
    assert.doesNotMatch(
      source,
      SOURCE_LEAK_PATTERN,
      `${file} should not reference the source repo or old package name`,
    );

    const imports = parseImports(source);
    assert.ok(imports.length > 0, `${file} should have explicit imports`);
    assertAllowedImports(file, imports);

    const syntax = spawnSync(process.execPath, ['--check', fullPath], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
    });
    assert.equal(
      syntax.status,
      0,
      `${file} failed syntax check:\n${syntax.stderr || syntax.stdout}`,
    );
  }
});

test('package metadata keeps the standalone mcp-cdx startup surface local to this repo', async () => {
  const packageJson = JSON.parse(await readFile(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));

  assert.equal(packageJson.name, 'mcp-cdx');
  assert.match(packageJson.description, /Standalone CDX/);
  assert.equal(
    packageJson.scripts?.['start:cdx-appserver'],
    'node src/cli/cdx-appserver-mcp-server.js',
  );
  assert.equal(
    packageJson.scripts?.['smoke:cdx-stats'],
    'node scripts/smoke-cdx-stats-dashboard.js',
  );
  assert.equal(
    packageJson.scripts?.['smoke:cdx-stats:new-layout'],
    'node scripts/smoke-cdx-stats-dashboard.js --require-new-layout',
  );
  assert.doesNotMatch(packageJson.description, SOURCE_LEAK_PATTERN);
  assert.doesNotMatch(packageJson.scripts?.['start:cdx-appserver'] ?? '', SOURCE_LEAK_PATTERN);
});

test('direct CLI entrypoints keep executable file modes where the source ships them', async () => {
  if (process.platform === 'win32') {
    return;
  }

  for (const file of CLI_FILES) {
    const fileStat = await stat(resolveCliPath(file));
    const isExecutable = (fileStat.mode & 0o111) !== 0;

    assert.equal(
      isExecutable,
      DIRECT_EXECUTABLE_FILES.has(file),
      `${file} executable bit drifted from the expected runnable surface`,
    );
  }
});

test('broker entrypoint keeps its local appserver handoff and cdx tool aliases', async () => {
  const source = await readCli('cdx-mcp-server.js');

  assert.match(
    source,
    /new URL\('\.\/cdx-appserver-mcp-server\.js', import\.meta\.url\)/,
    'cdx-mcp-server should resolve the sibling appserver entry locally',
  );
  assert.match(source, /name: 'cdx-orchestrator'/);
  assert.match(source, /name: 'cdx'/);
  assert.match(source, /name !== 'cdx'/);
  assert.match(source, /name !== 'cdx\.spawn'/);
  assert.match(source, /name !== 'cdx\.run'/);
  assert.match(
    source,
    /delegate to cdx\.spawn on the appserver orchestrator and immediately return control to the caller/,
  );
});

test('appserver entrypoint keeps the main CDX help surface intact', async () => {
  const source = await readCli('cdx-appserver-mcp-server.js');

  assert.match(source, /name: 'cdx-appserver-orchestrator'/);
  assert.match(source, /cdx\.spawn: Primary entrypoint\./);
  assert.match(source, /cdx\.run: Advanced\/manual orchestrator entrypoint\./);
  assert.match(source, /cdx\.status: Inspect run status, tasks, and recent events\./);
  assert.match(source, /cdx\.ps: List currently running CDX runs and their dashboard URLs\./);
  assert.match(source, /cdx\.router_answer: Answer a pending router\.ask/);
  assert.match(source, /cdx\.steer: Queue a supervisor message and\/or inject future tasks/);
  assert.match(source, /default: \.keepdoing/);
});

test('thin wrapper entrypoints still dispatch into runtime modules', async () => {
  const bridge = await readCli('bridge.js');
  const server = await readCli('server.js');
  const orchestrator = await readCli('orchestrator.js');
  const hookBackend = await readCli('hook-llm-backend.js');

  assert.match(bridge, /runBrokerBridge\(\)\.catch/);
  assert.match(server, /runBrokerServer\(\)\.catch/);
  assert.match(orchestrator, /class AgentSession/);
  assert.match(orchestrator, /new BrokerSession\(BROKER_BASE_URL/);
  assert.match(hookBackend, /OPENAI_BASE_URL/);
  assert.match(hookBackend, /openai_base_url/);
});
