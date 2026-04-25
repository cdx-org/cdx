import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const SOURCE_RUNTIME_DIR = path.join(REPO_ROOT, 'src', 'runtime');

const TEMP_PACKAGE_JSON = JSON.stringify({ type: 'module' }, null, 2);
const UNDICI_PACKAGE_JSON = JSON.stringify(
  {
    name: 'undici',
    type: 'module',
    exports: './index.js',
  },
  null,
  2,
);

const UNDICI_STUB_SOURCE = `export class Agent {
  constructor(options = {}) {
    this.options = options;
  }

  async close() {}

  destroy() {}
}

export const fetch = (...args) => {
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('global fetch is unavailable');
  }
  return globalThis.fetch(...args);
};
`;

const PROMPT_TEMPLATES_STUB_SOURCE = `export function loadPromptTemplate(name, fallback = '') {
  if (!name || typeof name !== 'string') return fallback ?? '';
  const key = name.trim();
  if (!key) return fallback ?? '';
  if (fallback === null || fallback === undefined) {
    throw new Error(\`Prompt template "\${key}" must provide an inline fallback.\`);
  }
  return fallback ?? '';
}

export function renderPromptTemplate(template, vars = {}) {
  if (typeof template !== 'string' || template.length === 0) return '';
  return template.replace(/\\{\\{([a-zA-Z0-9_]+)\\}\\}/g, (match, key) => {
    const value = vars[key];
    if (value === null || value === undefined) return '';
    return String(value);
  });
}
`;

async function copyTree(sourceDir, targetDir) {
  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyTree(sourcePath, targetPath);
      continue;
    }
    if (entry.isFile()) {
      await copyFile(sourcePath, targetPath);
    }
  }
}

export function runtimeSourceRoot() {
  return SOURCE_RUNTIME_DIR;
}

export async function listRuntimeFiles() {
  const entries = await readdir(SOURCE_RUNTIME_DIR, { withFileTypes: true });
  return entries
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

export async function createRuntimeFixture(
  t,
  {
    withPromptTemplateStub = true,
    withUndiciStub = true,
    extraFiles = [],
  } = {},
) {
  assert.ok(t && typeof t.after === 'function', 'createRuntimeFixture requires a node:test context');

  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'mcp-cdx-runtime-'));
  t.after(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  await writeFile(path.join(fixtureRoot, 'package.json'), TEMP_PACKAGE_JSON, 'utf8');

  const runtimeRoot = path.join(fixtureRoot, 'src', 'runtime');
  await copyTree(SOURCE_RUNTIME_DIR, runtimeRoot);

  if (withPromptTemplateStub) {
    await writeFile(
      path.join(runtimeRoot, 'prompt-templates.js'),
      PROMPT_TEMPLATES_STUB_SOURCE,
      'utf8',
    );
  }

  if (withUndiciStub) {
    const undiciRoot = path.join(fixtureRoot, 'node_modules', 'undici');
    await mkdir(undiciRoot, { recursive: true });
    await writeFile(path.join(undiciRoot, 'package.json'), UNDICI_PACKAGE_JSON, 'utf8');
    await writeFile(path.join(undiciRoot, 'index.js'), UNDICI_STUB_SOURCE, 'utf8');
  }

  for (const file of extraFiles) {
    const targetPath = path.join(fixtureRoot, file.path);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, file.content, 'utf8');
  }

  return {
    fixtureRoot,
    runtimeRoot,
    importRuntime: async moduleName => {
      const moduleUrl =
        `${pathToFileURL(path.join(runtimeRoot, moduleName)).href}` +
        `?v=${Date.now()}-${Math.random().toString(16).slice(2)}`;
      return import(moduleUrl);
    },
  };
}
