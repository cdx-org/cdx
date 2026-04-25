import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { listRuntimeFiles, runtimeSourceRoot } from './support/runtime-fixture.mjs';

test('runtime files do not point back to the source repo or stale names', async () => {
  const runtimeRoot = runtimeSourceRoot();
  const files = await listRuntimeFiles();

  for (const file of files) {
    const text = await readFile(path.join(runtimeRoot, file), 'utf8');
    assert.equal(/\/Users\/hancho01\/git\/mcp-keepdoing/.test(text), false);
    assert.equal(/\bmcp-keepdoing\b/.test(text), false);
    assert.equal(/\bCDX2\b/.test(text), false);
  }
});
