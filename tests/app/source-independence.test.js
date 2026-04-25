import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..', '..');

function walkJsFiles(rootPath) {
  const files = [];

  function visit(dirPath) {
    let entries = [];
    try {
      entries = readdirSync(dirPath, { withFileTypes: true });
    } catch (err) {
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return;
      throw err;
    }

    for (const entry of entries) {
      const absPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        visit(absPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.js')) {
        files.push(absPath);
      }
    }
  }

  visit(rootPath);
  return files.sort((a, b) => a.localeCompare(b));
}

async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

test('standalone source layout keeps a single canonical cli/runtime tree', async () => {
  const redundantRoots = [
    path.join(REPO_ROOT, 'src', 'app'),
    path.join(REPO_ROOT, 'src', 'apps'),
    path.join(REPO_ROOT, 'src', 'lib'),
  ];
  for (const redundantRoot of redundantRoots) {
    assert.equal(
      await pathExists(redundantRoot),
      false,
      `redundant compatibility tree should be absent: ${path.relative(REPO_ROOT, redundantRoot)}`,
    );
  }

  const sourceFiles = [
    ...walkJsFiles(path.join(REPO_ROOT, 'src', 'cli')),
    ...walkJsFiles(path.join(REPO_ROOT, 'src', 'runtime')),
  ];

  for (const absPath of sourceFiles) {
    const source = await readFile(absPath, 'utf8');
    assert.doesNotMatch(source, /\/Users\/hancho01\/git\/mcp-keepdoing/);
    assert.doesNotMatch(source, /\bmcp-keepdoing\b/);
  }

  const brokerSource = await readFile(
    path.join(REPO_ROOT, 'src', 'cli', 'cdx-mcp-server.js'),
    'utf8',
  );
  assert.match(
    brokerSource,
    /new URL\('\.\/cdx-appserver-mcp-server\.js', import\.meta\.url\)/,
  );
});
