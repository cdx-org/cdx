import { constants, existsSync } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_REQUIRED_NODE_ENTRY_SCRIPTS = Object.freeze([
  'start:cdx-appserver',
  'smoke:cdx-stats',
  'smoke:cdx-stats:new-layout',
]);

function trim(value) {
  return String(value ?? '').trim();
}

function unique(items) {
  return [...new Set(items.map(item => trim(item)).filter(Boolean))];
}

export function resolveProjectRoot(fromUrl = import.meta.url) {
  let current = path.dirname(fileURLToPath(fromUrl));
  while (true) {
    if (existsSync(path.join(current, 'package.json'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Could not find package.json above ${current}`);
    }
    current = parent;
  }
}

export function resolvePackageJsonPath(rootDir = resolveProjectRoot(import.meta.url)) {
  return path.join(rootDir, 'package.json');
}

export async function assertReadableFile(filePath, label = 'File') {
  await access(filePath, constants.R_OK).catch(error => {
    throw new Error(`${label} does not exist or is not readable: ${filePath}`, { cause: error });
  });
}

export async function loadPackageJson(rootDir = resolveProjectRoot(import.meta.url)) {
  const packageJsonPath = resolvePackageJsonPath(rootDir);
  const content = await readFile(packageJsonPath, 'utf8');
  return JSON.parse(content);
}

export function splitShellCommand(command) {
  const tokens = [];
  let current = '';
  let quote = null;
  let escaping = false;

  for (const char of String(command ?? '')) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === '\\') {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (escaping) current += '\\';
  if (quote) {
    throw new Error(`Unterminated quote in command: ${command}`);
  }
  if (current) tokens.push(current);
  return tokens;
}

export function resolveNodeScriptEntry(
  scriptName,
  scripts,
  { rootDir = resolveProjectRoot(import.meta.url) } = {},
) {
  const command = scripts?.[scriptName];
  if (!command) {
    throw new Error(`package.json is missing required script "${scriptName}"`);
  }

  const tokens = splitShellCommand(command);
  if (tokens[0] !== 'node') {
    throw new Error(
      `Standalone helper scripts only support simple node entry scripts. "${scriptName}" is "${command}"`,
    );
  }

  const [, relativeEntry, ...args] = tokens;
  if (!relativeEntry) {
    throw new Error(`Script "${scriptName}" does not declare a node entry file`);
  }

  return {
    scriptName,
    command,
    relativeEntry,
    entryPath: path.resolve(rootDir, relativeEntry),
    args,
  };
}

export async function loadDeclaredEntrypoints({
  rootDir = resolveProjectRoot(import.meta.url),
  requiredScriptNames = DEFAULT_REQUIRED_NODE_ENTRY_SCRIPTS,
} = {}) {
  const packageJson = await loadPackageJson(rootDir);
  const entries = new Map();

  for (const scriptName of unique(requiredScriptNames)) {
    const entry = resolveNodeScriptEntry(scriptName, packageJson.scripts, { rootDir });
    await assertReadableFile(entry.entryPath, `Script "${scriptName}" entrypoint`);
    entries.set(scriptName, entry);
  }

  return entries;
}
