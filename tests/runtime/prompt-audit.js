import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(TEST_DIR, '..', '..');
export const PROMPT_REFERENCE_PATTERNS = Object.freeze([
  /\bprompts\//,
  /\btest\/prompts\b/,
  /\btests\/prompts\b/,
  /\/Users\/hancho01\/git\/mcp-keepdoing/,
]);

function isJsModule(name) {
  return name.endsWith('.js') || name.endsWith('.mjs') || name.endsWith('.cjs');
}

function walkFiles(rootPath) {
  const results = [];

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
      if (entry.isFile()) results.push(absPath);
    }
  }

  visit(rootPath);
  return results.sort((a, b) => a.localeCompare(b));
}

export function listPromptRelatedSourceFiles() {
  const roots = [
    path.join(REPO_ROOT, 'src', 'cli'),
    path.join(REPO_ROOT, 'src', 'runtime'),
  ];

  return roots.flatMap(rootPath => walkFiles(rootPath))
    .filter(filePath => isJsModule(path.basename(filePath)))
    .sort((a, b) => a.localeCompare(b));
}

export async function loadPromptRelatedSourceFiles() {
  const filePaths = listPromptRelatedSourceFiles();
  const entries = [];

  for (const absPath of filePaths) {
    const source = await readFile(absPath, 'utf8');
    if (
      absPath.endsWith(`${path.sep}prompt-templates.js`)
      || source.includes('loadPromptTemplate(')
      || source.includes('renderPromptTemplate(')
    ) {
      entries.push({
        absPath,
        relPath: path.relative(REPO_ROOT, absPath),
        source,
      });
    }
  }

  return entries.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function skipQuoted(source, startIndex, quote) {
  let index = startIndex + 1;
  while (index < source.length) {
    const ch = source[index];
    if (ch === '\\') {
      index += 2;
      continue;
    }
    if (ch === quote) return index + 1;
    index += 1;
  }
  return index;
}

function skipLineComment(source, startIndex) {
  let index = startIndex + 2;
  while (index < source.length && source[index] !== '\n') index += 1;
  return index;
}

function skipBlockComment(source, startIndex) {
  let index = startIndex + 2;
  while (index + 1 < source.length) {
    if (source[index] === '*' && source[index + 1] === '/') return index + 2;
    index += 1;
  }
  return source.length;
}

function findCallEnd(source, openParenIndex) {
  let depth = 1;

  for (let index = openParenIndex + 1; index < source.length; index += 1) {
    const ch = source[index];
    const next = source[index + 1];
    if (ch === '\'' || ch === '"' || ch === '`') {
      index = skipQuoted(source, index, ch) - 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      index = skipLineComment(source, index) - 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      index = skipBlockComment(source, index) - 1;
      continue;
    }
    if (ch === '(') {
      depth += 1;
      continue;
    }
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function countTopLevelCommas(source) {
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let commas = 0;

  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index];
    const next = source[index + 1];
    if (ch === '\'' || ch === '"' || ch === '`') {
      index = skipQuoted(source, index, ch) - 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      index = skipLineComment(source, index) - 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      index = skipBlockComment(source, index) - 1;
      continue;
    }

    if (ch === '(') {
      parenDepth += 1;
      continue;
    }
    if (ch === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (ch === '{') {
      braceDepth += 1;
      continue;
    }
    if (ch === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
    if (ch === '[') {
      bracketDepth += 1;
      continue;
    }
    if (ch === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }
    if (ch === ',' && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
      commas += 1;
    }
  }

  return commas;
}

export function extractLoadPromptTemplateCalls(source) {
  const calls = [];
  let cursor = 0;

  while (cursor < source.length) {
    const matchIndex = source.indexOf('loadPromptTemplate', cursor);
    if (matchIndex === -1) break;

    const before = source[matchIndex - 1] ?? '';
    const afterNameIndex = matchIndex + 'loadPromptTemplate'.length;
    const after = source[afterNameIndex] ?? '';
    if ((/[A-Za-z0-9_$]/).test(before) || (/[A-Za-z0-9_$]/).test(after)) {
      cursor = afterNameIndex;
      continue;
    }

    let openParenIndex = afterNameIndex;
    while (openParenIndex < source.length && /\s/.test(source[openParenIndex])) {
      openParenIndex += 1;
    }
    if (source[openParenIndex] !== '(') {
      cursor = afterNameIndex;
      continue;
    }

    const closeParenIndex = findCallEnd(source, openParenIndex);
    if (closeParenIndex === -1) break;

    const argsSource = source.slice(openParenIndex + 1, closeParenIndex);
    calls.push({
      argsSource,
      commaCount: countTopLevelCommas(argsSource),
      startIndex: matchIndex,
    });
    cursor = closeParenIndex + 1;
  }

  return calls;
}
