import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRuntimeFixture, listRuntimeFiles } from './support/runtime-fixture.mjs';

test('all copied runtime modules import cleanly in isolation', async t => {
  const fixture = await createRuntimeFixture(t);
  const files = (await listRuntimeFiles()).filter(file => file.endsWith('.js'));

  for (const file of files) {
    await assert.doesNotReject(
      () => fixture.importRuntime(file),
      `expected ${file} to import without missing local runtime dependencies`,
    );
  }
});
