import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

function coerceString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function pathTools(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function basename(value) {
  return String(value ?? '').split(/[\\/]/).pop()?.toLowerCase() ?? '';
}

function isNodeCommand(command) {
  const base = basename(command);
  return base === 'node' || base === 'node.exe';
}

function isCodexScript(value) {
  const normalized = String(value ?? '').replace(/\\/g, '/').toLowerCase();
  return normalized.endsWith('/@openai/codex/bin/codex.js')
    || normalized.endsWith('/node_modules/@openai/codex/bin/codex.js')
    || basename(value) === 'codex.js';
}

export function commandLooksLikeCodex(command, args = []) {
  const base = basename(command);
  if (base === 'codex' || base.startsWith('codex.')) return true;
  if (base.startsWith('codex-')) return true;
  return isNodeCommand(command) && Array.isArray(args) && isCodexScript(args[0]);
}

function appendCandidate(candidates, seen, candidate, fileExistsFn) {
  const value = coerceString(candidate);
  if (!value) return;
  const key = value.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  if (fileExistsFn(value)) candidates.push(value);
}

function codexJsCandidates({ env, platform, fileExistsFn }) {
  const tools = pathTools(platform);
  const candidates = [];
  const seen = new Set();
  const append = candidate => appendCandidate(candidates, seen, candidate, fileExistsFn);

  append(env.CODEX_CLI_JS);
  append(env.CDX_CODEX_CLI_JS);

  const npmPrefixes = [
    env.npm_config_prefix,
    env.NPM_CONFIG_PREFIX,
    env.APPDATA ? tools.join(env.APPDATA, 'npm') : null,
    env.USERPROFILE ? tools.join(env.USERPROFILE, 'AppData', 'Roaming', 'npm') : null,
  ];

  for (const prefix of npmPrefixes) {
    if (!prefix) continue;
    append(tools.join(prefix, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
  }

  if (platform !== 'win32') {
    const home = env.HOME ?? os.homedir();
    for (const prefix of [
      env.PREFIX,
      tools.join(home, '.npm-global'),
      tools.join(home, '.local'),
      '/usr/local',
      '/opt/homebrew',
    ]) {
      if (!prefix) continue;
      append(tools.join(prefix, 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
    }
  }

  return candidates;
}

export function resolveCodexInvocation({
  command = undefined,
  env = process.env,
  platform = process.platform,
  execPath = process.execPath,
  fileExistsFn = existsSync,
} = {}) {
  const explicit = coerceString(command) ?? coerceString(env.CODEX_BIN);
  if (explicit) {
    return { command: explicit, argsPrefix: [], source: 'explicit' };
  }

  const codexJs = codexJsCandidates({ env, platform, fileExistsFn })[0];
  if (codexJs && coerceString(execPath)) {
    return { command: execPath, argsPrefix: [codexJs], source: 'node-codex-js' };
  }

  return { command: 'codex', argsPrefix: [], source: 'path' };
}
