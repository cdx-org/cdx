import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DEFAULT_REQUIRED_NODE_ENTRY_SCRIPTS,
  loadDeclaredEntrypoints,
  resolveNodeScriptEntry,
  resolveProjectRoot,
  splitShellCommand,
} from '../../tools/scripts/package-scripts.js';

test('splitShellCommand preserves quoted arguments', () => {
  assert.deepEqual(splitShellCommand("node scripts/example.js --name='cdx appserver' --flag"), [
    'node',
    'scripts/example.js',
    '--name=cdx appserver',
    '--flag',
  ]);
});

test('resolveNodeScriptEntry rejects non-node commands', () => {
  assert.throws(
    () => resolveNodeScriptEntry('start:cdx-appserver', { 'start:cdx-appserver': 'npm run start' }),
    /only support simple node entry scripts/,
  );
});

test('loadDeclaredEntrypoints resolves the standalone startup helper scripts', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cdx-package-scripts-'));

  try {
    await mkdir(path.join(tempRoot, 'src', 'cli'), { recursive: true });
    await mkdir(path.join(tempRoot, 'scripts'), { recursive: true });

    await writeFile(
      path.join(tempRoot, 'package.json'),
      JSON.stringify(
        {
          name: 'mcp-cdx',
          type: 'module',
          scripts: {
            'start:cdx-appserver': 'node src/cli/cdx-appserver-mcp-server.js',
            'smoke:cdx-stats': 'node scripts/smoke-cdx-stats-dashboard.js',
            'smoke:cdx-stats:new-layout':
              'node scripts/smoke-cdx-stats-dashboard.js --require-new-layout',
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    await writeFile(path.join(tempRoot, 'src', 'cli', 'cdx-appserver-mcp-server.js'), '', 'utf8');
    await writeFile(path.join(tempRoot, 'scripts', 'smoke-cdx-stats-dashboard.js'), '', 'utf8');

    const entries = await loadDeclaredEntrypoints({
      rootDir: tempRoot,
      requiredScriptNames: DEFAULT_REQUIRED_NODE_ENTRY_SCRIPTS,
    });

    assert.equal(entries.size, 3);
    assert.equal(entries.get('start:cdx-appserver')?.relativeEntry, 'src/cli/cdx-appserver-mcp-server.js');
    assert.equal(entries.get('smoke:cdx-stats')?.relativeEntry, 'scripts/smoke-cdx-stats-dashboard.js');
    assert.deepEqual(entries.get('smoke:cdx-stats:new-layout')?.args, ['--require-new-layout']);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('resolveProjectRoot walks up from both helper and script entrypoints', () => {
  const helperRoot = resolveProjectRoot(import.meta.url);
  const scriptRoot = resolveProjectRoot(new URL('../../scripts/smoke-startup-paths.js', import.meta.url));

  assert.equal(helperRoot, scriptRoot);
  assert.ok(helperRoot.replace(/\\/g, '/').endsWith('/mcp-cdx'));
});
