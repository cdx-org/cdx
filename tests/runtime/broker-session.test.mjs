import assert from 'node:assert/strict';
import process from 'node:process';
import { test } from 'node:test';

import { createRuntimeFixture } from './support/runtime-fixture.mjs';

test('broker session auto-start defaults to the CLI server entrypoint', async t => {
  const fixture = await createRuntimeFixture(t);
  const { BrokerSession } = await fixture.importRuntime('broker-session.js');

  const session = new BrokerSession('http://127.0.0.1:4000', { autoStart: true });

  assert.equal(session.autoStartConfig?.command, process.execPath);
  assert.ok(Array.isArray(session.autoStartConfig?.args));
  assert.match(session.autoStartConfig.args[0], /src[\\/]cli[\\/]server\.js$/);
  await session.dispose();
});
