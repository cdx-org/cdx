import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const MAX_LINES = 32;
const MAX_CHARS = 2_000;
const DIR_LIMIT = 12;
const FILE_LIMIT = 8;
const SCRIPT_LIMIT = 10;
const SCRIPT_CMD_LIMIT = 120;

const SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.turbo',
  '.next',
  '.cache',
  '.idea',
]);

const CONFIG_PATTERNS = [
  /^tsconfig\.json$/i,
  /^package-lock\.json$/i,
  /^pnpm-lock\.yaml$/i,
  /^yarn\.lock$/i,
  /^bun\.lockb$/i,
  /^pnpm-workspace\.ya?ml$/i,
  /^turbo\.json$/i,
  /^lerna\.json$/i,
  /^nx\.json$/i,
  /^renovate\.json$/i,
  /^docker-compose(\.[\w-]+)?\.ya?ml$/i,
  /^dockerfile$/i,
  /^Makefile$/,
  /^jest\.config\.[\w.]+$/i,
  /^vitest\.config\.[\w.]+$/i,
  /^vite\.config\.[\w.]+$/i,
  /^webpack\.config\.[\w.]+$/i,
  /^rollup\.config\.[\w.]+$/i,
  /^next\.config\.[\w.]+$/i,
  /^svelte\.config\.[\w.]+$/i,
  /^tailwind\.config\.[\w.]+$/i,
  /^babel\.config\.[\w.]+$/i,
  /^\.babelrc(\.[\w.]+)?$/i,
  /^eslint(\.config)?\.[\w.]+$/i,
  /^\.eslintrc(\.[\w.]+)?$/i,
  /^prettier(\.config)?\.[\w.]+$/i,
  /^\.prettierrc(\.[\w.]+)?$/i,
  /^cspell\.config\.[\w.]+$/i,
  /^\.github$/,
  /^\.circleci$/,
  /^\.gitlab-ci\.ya?ml$/i,
  /^\.devcontainer$/,
  /^\.vscode$/,
];

const SCRIPT_PRIORITY = [
  'dev',
  'start',
  'build',
  'test',
  'lint',
  'format',
  'typecheck',
  'check',
  'coverage',
  'ci',
  'prepare',
  'prepublishOnly',
  'release',
  'deploy',
];

function truncateValue(value, maxLength) {
  const text = String(value ?? '');
  if (!text) return '';
  if (!Number.isFinite(maxLength) || maxLength <= 0) return text;
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

async function safeReadDir(rootPath) {
  try {
    return await readdir(rootPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function safeReadPackageJson(repoRoot) {
  try {
    const raw = await readFile(path.join(repoRoot, 'package.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function formatList(items, limit) {
  if (!Array.isArray(items) || items.length === 0) return '';
  const bounded = items.slice(0, Math.max(1, limit));
  const suffix = items.length > bounded.length ? ` (+${items.length - bounded.length} more)` : '';
  return `${bounded.join(', ')}${suffix}`;
}

function buildTopLevelSummary(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '';

  const dirs = entries
    .filter(entry => entry?.isDirectory?.())
    .map(entry => entry.name)
    .filter(name => name && !SKIP_DIRS.has(name))
    .sort((a, b) => a.localeCompare(b));

  const files = entries
    .filter(entry => entry?.isFile?.() || entry?.isSymbolicLink?.())
    .map(entry => entry.name)
    .filter(name => name && name !== '.DS_Store')
    .sort((a, b) => a.localeCompare(b));

  const dirText = formatList(dirs.map(name => `${name}/`), DIR_LIMIT);
  const fileText = formatList(files, FILE_LIMIT);

  const segments = [];
  if (dirText) segments.push(`dirs: ${dirText}`);
  if (fileText) segments.push(`files: ${fileText}`);

  return segments.length > 0 ? `Top-level: ${segments.join(' | ')}` : '';
}

function buildConfigSummary(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  const names = entries.map(entry => entry.name).filter(Boolean);
  const matched = new Set();

  for (const name of names) {
    for (const pattern of CONFIG_PATTERNS) {
      if (pattern.test(name)) {
        matched.add(name);
        break;
      }
    }
  }

  if (matched.size === 0) return '';
  const ordered = [...matched].sort((a, b) => a.localeCompare(b));
  return `Configs: ${formatList(ordered, 14)}`;
}

function buildScriptSummary(pkgJson) {
  const scripts = pkgJson?.scripts;
  if (!scripts || typeof scripts !== 'object') return '';

  const entries = Object.entries(scripts)
    .filter(([name]) => typeof name === 'string' && name.trim())
    .map(([name, cmd]) => [name.trim(), typeof cmd === 'string' ? cmd.trim() : String(cmd ?? '')]);
  if (entries.length === 0) return '';

  const priority = [];
  const remainder = [];
  const seen = new Set();

  for (const [name, cmd] of entries) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (SCRIPT_PRIORITY.includes(name)) {
      priority.push([name, cmd]);
    } else {
      remainder.push([name, cmd]);
    }
  }

  const ordered = [...priority, ...remainder].slice(0, SCRIPT_LIMIT);
  const formatted = ordered.map(([name, cmd]) =>
    cmd ? `${name}: ${truncateValue(cmd, SCRIPT_CMD_LIMIT)}` : name,
  );

  return formatted.length > 0 ? `Scripts: ${formatted.join(' | ')}` : '';
}

function clampSummary(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return '';

  const lines = trimmed.split(/\r?\n/).slice(0, MAX_LINES);
  let joined = lines.join('\n');
  if (joined.length > MAX_CHARS) {
    joined = `${joined.slice(0, Math.max(0, MAX_CHARS - 3))}...`;
  }
  return joined.trim();
}

export async function buildRepoIndexSummary(repoRoot) {
  if (!repoRoot || typeof repoRoot !== 'string') return '';

  const entries = await safeReadDir(repoRoot);
  const topLevel = buildTopLevelSummary(entries);
  const configs = buildConfigSummary(entries);
  const pkgJson = await safeReadPackageJson(repoRoot);
  const scripts = buildScriptSummary(pkgJson);

  const parts = [topLevel, scripts, configs].filter(Boolean);
  if (parts.length === 0) return '';

  return clampSummary(parts.join('\n'));
}

