import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import {
  commandLooksLikeCodex,
  resolveCodexInvocation,
} from '../../src/runtime/codex-command.js';
import { prepareCodexAppServerArgs } from '../../src/runtime/app-server-client.js';

test('resolveCodexInvocation finds the Windows npm Codex JS entry without PATH', () => {
  const appData = 'C:\\Users\\codex\\AppData\\Roaming';
  const expected = path.win32.join(
    appData,
    'npm',
    'node_modules',
    '@openai',
    'codex',
    'bin',
    'codex.js',
  );

  const resolved = resolveCodexInvocation({
    env: { APPDATA: appData },
    platform: 'win32',
    execPath: 'C:\\nvm4w\\nodejs\\node.exe',
    fileExistsFn: candidate => candidate === expected,
  });

  assert.deepEqual(resolved, {
    command: 'C:\\nvm4w\\nodejs\\node.exe',
    argsPrefix: [expected],
    source: 'node-codex-js',
  });
});

test('resolveCodexInvocation respects explicit CODEX_BIN overrides', () => {
  const resolved = resolveCodexInvocation({
    env: { CODEX_BIN: 'node' },
    platform: 'win32',
    execPath: 'C:\\nvm4w\\nodejs\\node.exe',
    fileExistsFn: () => true,
  });

  assert.deepEqual(resolved, { command: 'node', argsPrefix: [], source: 'explicit' });
});

test('commandLooksLikeCodex detects node launching the Codex JS entry', () => {
  assert.equal(
    commandLooksLikeCodex('node', ['C:\\Users\\codex\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js']),
    true,
  );
  assert.equal(commandLooksLikeCodex('node', ['tests/app/fixtures/stubs/appserver-stub.js']), false);
});

test('prepareCodexAppServerArgs injects ChatGPT auth for node Codex JS invocations', () => {
  const codexJs = 'C:\\Users\\codex\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js';
  const args = prepareCodexAppServerArgs('node', [codexJs, 'app-server'], {
    authMode: 'chatgpt',
  });

  assert.deepEqual(args, [
    codexJs,
    '-c',
    'forced_login_method="chatgpt"',
    'app-server',
  ]);
});
