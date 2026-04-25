import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPromptTemplate, renderPromptTemplate } from '../../src/runtime/prompt-templates.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..', '..');
const PROMPT_TEMPLATE_PATH = path.join(REPO_ROOT, 'src', 'runtime', 'prompt-templates.js');
const SMOKE_PROMPT_REFERENCE_PATTERNS = Object.freeze([
  /\bprompts\//,
  /\btest\/prompts\b/,
  /\btests\/prompts\b/,
  /prompt-templates\.js/,
]);

function listMarkdownFiles(dirPath) {
  try {
    return readdirSync(dirPath, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return [];
    throw err;
  }
}

function listDirEntries(dirPath) {
  try {
    return readdirSync(dirPath, { withFileTypes: true })
      .map(entry => entry.isDirectory() ? `${entry.name}/` : entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return [];
    throw err;
  }
}

function listSmokeScriptPaths() {
  const roots = [
    path.join(REPO_ROOT, 'test', 'smoke'),
    path.join(REPO_ROOT, 'tests', 'smoke'),
  ];
  const relativePaths = [];

  for (const root of roots) {
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith('.js') && !entry.name.endsWith('.mjs')) continue;
        relativePaths.push(path.relative(REPO_ROOT, path.join(root, entry.name)));
      }
    } catch (err) {
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') continue;
      throw err;
    }
  }

  return relativePaths.sort((a, b) => a.localeCompare(b));
}

test('loadPromptTemplate preserves inline fallback behavior', () => {
  const fallback = 'Planner prompt text';

  assert.equal(loadPromptTemplate('planner', fallback), fallback);
  assert.equal(loadPromptTemplate(' planner ', fallback), fallback);
  assert.equal(loadPromptTemplate('', fallback), fallback);
  assert.equal(loadPromptTemplate(null, fallback), fallback);
  assert.equal(loadPromptTemplate('planner'), '');
  assert.throws(
    () => loadPromptTemplate('planner', null),
    /must provide an inline fallback/i,
  );
});

test('renderPromptTemplate replaces placeholders with stringified values', () => {
  const rendered = renderPromptTemplate(
    'Task {{task}} retry={{retry}} ok={{ok}} missing={{missing}} nil={{nil}}',
    {
      task: 'build',
      retry: 2,
      ok: true,
      nil: null,
    },
  );

  assert.equal(rendered, 'Task build retry=2 ok=true missing= nil=');
  assert.equal(renderPromptTemplate('', { task: 'build' }), '');
  assert.equal(renderPromptTemplate(null, { task: 'build' }), '');
});

test('runtime prompt templates stay inline-only and self-contained', async () => {
  const source = await readFile(PROMPT_TEMPLATE_PATH, 'utf8');

  assert.doesNotMatch(source, /node:fs|readFileSync|readFile|readdirSync|prompts\//);

  assert.deepEqual(
    listMarkdownFiles(path.join(REPO_ROOT, 'prompts')),
    [],
    'legacy runtime prompt markdown files should not be shipped on disk',
  );

  assert.deepEqual(
    listDirEntries(path.join(REPO_ROOT, 'test', 'prompts')),
    [],
    'test prompt fixtures should stay empty when prompts are inline-only',
  );

  assert.deepEqual(
    listDirEntries(path.join(REPO_ROOT, 'tests', 'prompts')),
    [],
    'tests prompt fixtures should stay empty when prompts are inline-only',
  );

  const smokeScripts = listSmokeScriptPaths();
  for (const relPath of smokeScripts) {
    const smokeSource = await readFile(path.join(REPO_ROOT, relPath), 'utf8');
    for (const pattern of SMOKE_PROMPT_REFERENCE_PATTERNS) {
      assert.doesNotMatch(
        smokeSource,
        pattern,
        `smoke helper ${relPath} should stay prompt-agnostic: ${pattern}`,
      );
    }
  }
});
