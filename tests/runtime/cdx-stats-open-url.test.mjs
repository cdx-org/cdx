import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { buildOpenUrlCommands } from '../../src/runtime/cdx-stats-server.js';

test('buildOpenUrlCommands prefers installed Chrome then falls back to Explorer on Windows', () => {
  const env = {
    LOCALAPPDATA: 'C:\\Users\\codex\\AppData\\Local',
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  };
  const chromePath = path.join(env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe');
  const edgePath = path.join(env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
  const commands = buildOpenUrlCommands('http://127.0.0.1:61593/?runId=abc', {
    platform: 'win32',
    env,
    fileExistsFn: candidate => candidate === chromePath || candidate === edgePath,
    commandExistsFn: () => false,
  });

  assert.deepEqual(commands[0], {
    command: chromePath,
    args: ['http://127.0.0.1:61593/?runId=abc'],
  });
  assert.deepEqual(commands[1], {
    command: edgePath,
    args: ['http://127.0.0.1:61593/?runId=abc'],
  });
  assert.ok(commands.some(command => command.command === 'explorer.exe'));
});

test('buildOpenUrlCommands keeps the full Windows dashboard URL as one argument', () => {
  const target = 'http://127.0.0.1:61593/?runId=abc&tab=git-tree';
  const commands = buildOpenUrlCommands(target, {
    platform: 'win32',
    env: {},
    fileExistsFn: () => false,
    commandExistsFn: () => false,
  });

  assert.deepEqual(commands[0], {
    command: 'explorer.exe',
    args: [target],
  });
  assert.ok(commands.every(command => command.args.includes(target)));
});

test('buildOpenUrlCommands retains the Chrome-first macOS behavior', () => {
  const commands = buildOpenUrlCommands('http://127.0.0.1:61593/', {
    platform: 'darwin',
    env: {},
    fileExistsFn: () => false,
    commandExistsFn: () => false,
  });

  assert.deepEqual(commands, [
    { command: 'open', args: ['-a', 'Google Chrome', 'http://127.0.0.1:61593/'] },
    { command: 'open', args: ['http://127.0.0.1:61593/'] },
  ]);
});
