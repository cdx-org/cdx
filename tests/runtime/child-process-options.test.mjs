import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { hiddenSpawnOptions } from '../../src/runtime/child-process-options.js';

const TEST_PROJECT_ROOT = path.resolve(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
);

test('hiddenSpawnOptions hides Windows child process consoles by default', () => {
  assert.deepEqual(
    hiddenSpawnOptions({ stdio: 'ignore', detached: true }, { platform: 'win32' }),
    { stdio: 'ignore', detached: true, windowsHide: true },
  );
});

test('hiddenSpawnOptions preserves explicit windowsHide choices', () => {
  assert.deepEqual(
    hiddenSpawnOptions({ windowsHide: false, stdio: 'pipe' }, { platform: 'win32' }),
    { windowsHide: false, stdio: 'pipe' },
  );
});

test('hiddenSpawnOptions leaves non-Windows options unchanged', () => {
  assert.deepEqual(
    hiddenSpawnOptions({ stdio: 'ignore' }, { platform: 'linux' }),
    { stdio: 'ignore' },
  );
});

test('CDX child-process spawn sites opt into hidden Windows consoles', async () => {
  const files = [
    'src/runtime/app-server-client.js',
    'src/runtime/broker-server.js',
    'src/runtime/broker-session.js',
    'src/runtime/git-worktree.js',
    'src/runtime/judge-service.js',
    'src/runtime/cdx-stats-server.js',
    'src/cli/cdx-appserver-mcp-server.js',
    'src/cli/cdx-mcp-server.js',
  ];

  for (const file of files) {
    const source = await readFile(path.join(TEST_PROJECT_ROOT, file), 'utf8');
    assert.match(source, /hiddenSpawnOptions\(/, `${file} should hide Windows subprocess consoles`);
  }
});
