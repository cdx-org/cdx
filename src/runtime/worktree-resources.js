import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_SPARSE_DIRS = [
  'src',
  'lib',
  'app',
  'apps',
  'packages',
  'scripts',
  'test',
  'tests',
  'docs',
  'examples',
  'config',
  'configs',
  'tools',
  '.github',
  '.codex',
];

const NODE_HINT_FILES = [
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
];

const PYTHON_HINT_FILES = [
  'pyproject.toml',
  'requirements.txt',
  'requirements-dev.txt',
  'requirements.in',
  'setup.py',
  'setup.cfg',
  'Pipfile',
  'poetry.lock',
];

const RUST_HINT_FILES = [
  'Cargo.toml',
  'Cargo.lock',
];

function coerceBoolean(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim().toLowerCase();
  if (!text) return null;
  if (['1', 'true', 'yes', 'y', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(text)) return false;
  return null;
}

function parseListEnv(value) {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map(item => String(item).trim()).filter(Boolean);
      }
    } catch {
      // fall through
    }
  }
  return raw
    .split(/[,\n]/)
    .map(item => item.trim())
    .filter(Boolean);
}

function fileExists(repoRoot, name) {
  try {
    return existsSync(path.join(repoRoot, name));
  } catch {
    return false;
  }
}

function dirExists(repoRoot, name) {
  try {
    return statSync(path.join(repoRoot, name)).isDirectory();
  } catch {
    return false;
  }
}

export function detectLanguages(repoRoot) {
  const hasNode = NODE_HINT_FILES.some(file => fileExists(repoRoot, file));
  const hasPython = PYTHON_HINT_FILES.some(file => fileExists(repoRoot, file));
  const hasRust = RUST_HINT_FILES.some(file => fileExists(repoRoot, file));
  return { hasNode, hasPython, hasRust };
}

function defaultSparsePaths(repoRoot) {
  const { hasNode, hasPython, hasRust } = detectLanguages(repoRoot);
  const paths = new Set();

  for (const dir of DEFAULT_SPARSE_DIRS) {
    paths.add(dir);
  }

  if (hasNode) {
    ['src', 'lib', 'app', 'apps', 'packages', 'scripts', 'test', 'tests', 'config', 'configs'].forEach(dir => paths.add(dir));
  }

  if (hasPython) {
    ['src', 'app', 'apps', 'tests', 'test', 'scripts', 'config', 'configs', 'notebooks'].forEach(dir => paths.add(dir));
  }

  if (hasRust) {
    ['src', 'crates', 'tests', 'examples', 'benches'].forEach(dir => paths.add(dir));
  }

  const filtered = [...paths].filter(dir => dirExists(repoRoot, dir));
  return filtered.length > 0 ? filtered : [...paths];
}

function normalizeSparseMode(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return 'cone';
  if (raw === 'cone' || raw === '1' || raw === 'true') return 'cone';
  if (raw === 'no-cone' || raw === 'noncone' || raw === 'nocone' || raw === '0' || raw === 'false') {
    return 'no-cone';
  }
  return raw;
}

function sanitizeKey(value) {
  const text = String(value ?? '').trim();
  if (!text) return 'default';
  return text.replace(/[:\\]/g, '_');
}

function isSubpath(child, parent) {
  if (!child || !parent) return false;
  const resolvedParent = path.resolve(parent);
  const resolvedChild = path.resolve(child);
  if (resolvedChild === resolvedParent) return true;
  return resolvedChild.startsWith(resolvedParent + path.sep);
}

export function defaultWorktreeRoot(repoRoot) {
  return path.join(repoRoot, '.cdx-worktrees');
}

export function resolveWorktreeRoot(repoRoot) {
  const override = String(process.env.CDX_WORKTREE_ROOT ?? '').trim();
  if (override) {
    if (path.isAbsolute(override)) return override;
    return path.resolve(repoRoot ?? process.cwd(), override);
  }
  return defaultWorktreeRoot(repoRoot);
}

export function resolveSharedRoot(repoRoot) {
  const override = String(process.env.CDX_SHARED_ROOT ?? '').trim();
  if (override) {
    if (path.isAbsolute(override)) return override;
    return path.resolve(repoRoot ?? process.cwd(), override);
  }
  return path.join(repoRoot, '.cdx-shared');
}

export function resolveWorktreeKey({ repoRoot, worktreePath }) {
  if (!worktreePath) return 'default';
  const worktreeRoot = resolveWorktreeRoot(repoRoot);
  if (isSubpath(worktreePath, worktreeRoot)) {
    const rel = path.relative(worktreeRoot, worktreePath);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return sanitizeKey(rel);
    }
  }
  return sanitizeKey(path.basename(worktreePath));
}

export function resolveWorktreeArtifactsRoot({ repoRoot, worktreePath }) {
  const sharedRoot = resolveSharedRoot(repoRoot);
  const key = resolveWorktreeKey({ repoRoot, worktreePath });
  return path.join(sharedRoot, 'artifacts', key);
}

export function resolveSharedCachePaths(repoRoot) {
  const sharedRoot = resolveSharedRoot(repoRoot);
  const cacheRoot = path.join(sharedRoot, 'cache');
  return {
    sharedRoot,
    cacheRoot,
    xdg: path.join(cacheRoot, 'xdg'),
    npm: path.join(cacheRoot, 'npm'),
    yarn: path.join(cacheRoot, 'yarn'),
    pnpm: path.join(cacheRoot, 'pnpm'),
    pip: path.join(cacheRoot, 'pip'),
    poetry: path.join(cacheRoot, 'poetry'),
    pipenv: path.join(cacheRoot, 'pipenv'),
    uv: path.join(cacheRoot, 'uv'),
    cargo: path.join(cacheRoot, 'cargo'),
    rustup: path.join(cacheRoot, 'rustup'),
  };
}

export function resolveWorktreeBuildPaths({ repoRoot, worktreePath }) {
  const artifactsRoot = resolveWorktreeArtifactsRoot({ repoRoot, worktreePath });
  return {
    artifactsRoot,
    build: path.join(artifactsRoot, 'build'),
    dist: path.join(artifactsRoot, 'dist'),
    cargoTarget: path.join(artifactsRoot, 'cargo-target'),
    pycache: path.join(artifactsRoot, 'pycache'),
  };
}

export function buildSharedCacheEnv({ repoRoot, worktreePath }) {
  const cache = resolveSharedCachePaths(repoRoot);
  const build = resolveWorktreeBuildPaths({ repoRoot, worktreePath });
  return {
    env: {
      XDG_CACHE_HOME: cache.xdg,
      npm_config_cache: cache.npm,
      NPM_CONFIG_CACHE: cache.npm,
      YARN_CACHE_FOLDER: cache.yarn,
      PNPM_STORE_PATH: cache.pnpm,
      PIP_CACHE_DIR: cache.pip,
      POETRY_CACHE_DIR: cache.poetry,
      PIPENV_CACHE_DIR: cache.pipenv,
      UV_CACHE_DIR: cache.uv,
      CARGO_HOME: cache.cargo,
      RUSTUP_HOME: cache.rustup,
      CARGO_TARGET_DIR: build.cargoTarget,
      PYTHONPYCACHEPREFIX: build.pycache,
    },
    cache,
    build,
  };
}

export function resolveSparseConfig(repoRoot) {
  const enabledFlag = coerceBoolean(process.env.CDX_SPARSE_CHECKOUT);
  if (enabledFlag === false) {
    return { enabled: false, mode: 'cone', paths: [] };
  }
  const mode = normalizeSparseMode(process.env.CDX_SPARSE_MODE ?? 'cone');
  const paths = parseListEnv(process.env.CDX_SPARSE_PATHS) ?? defaultSparsePaths(repoRoot);
  return { enabled: true, mode, paths };
}

export function resolveExternalizeConfig() {
  const enabledFlag = coerceBoolean(process.env.CDX_WORKTREE_EXTERNALIZE);
  const enabled = enabledFlag === null ? true : enabledFlag;
  const dirs = parseListEnv(process.env.CDX_WORKTREE_EXTERNALIZE_DIRS)
    ?? ['build', 'dist', '.cache'];
  return { enabled, dirs };
}

export function resolveSharedCacheEnabled() {
  const enabledFlag = coerceBoolean(process.env.CDX_SHARED_CACHE);
  return enabledFlag === null ? true : enabledFlag;
}
