import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, readlink, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  defaultWorktreeRoot,
  resolveExternalizeConfig,
  resolveSharedCachePaths,
  resolveSharedRoot,
  resolveSparseConfig,
  resolveWorktreeArtifactsRoot,
} from './worktree-resources.js';

function trimTrailingNewline(value) {
  return String(value ?? '').replace(/\r?\n$/, '');
}

function normalizeExcludePattern(value) {
  const text = String(value ?? '').trim();
  return text ? text : null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableGitFailure({ command, code, stdout, stderr }) {
  if (command !== 'git') return false;
  if (![1, 128].includes(Number(code))) return false;

  const text = `${stderr ?? ''}\n${stdout ?? ''}`.toLowerCase();
  if (!text.trim()) return false;

  return (
    text.includes('index.lock')
    || text.includes('another git process seems to be running')
    || text.includes('cannot lock ref')
    || text.includes('unable to update local ref')
    || text.includes('failed to update ref')
    || (text.includes(' is at ') && text.includes(' but expected '))
  );
}

export async function runCommand(command, args, { cwd, env, log } = {}) {
  const resolvedEnv = env ? { ...process.env, ...env } : process.env;
  const maxAttempts = command === 'git' ? 8 : 1;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await new Promise((resolve, reject) => {
        let child;
        try {
          child = spawn(command, args, { cwd, env: resolvedEnv, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
          reject(err);
          return;
        }

        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => {
          stdout += chunk;
        });
        child.stderr.on('data', chunk => {
          stderr += chunk;
          if (log && String(chunk ?? '').trim()) {
            log(`[${command} stderr]`, String(chunk).trim());
          }
        });
        child.on('error', err => {
          reject(err);
        });
        child.on('close', code => {
          if (code === 0) {
            resolve({ stdout, stderr });
            return;
          }
          const error = new Error(
            `Command failed: ${command} ${args.join(' ')} (exit=${code})\n${trimTrailingNewline(stderr)}`,
          );
          error.code = code;
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
        });
      });
    } catch (err) {
      lastError = err;
      const retryable = attempt < maxAttempts && isRetryableGitFailure({
        command,
        code: err?.code,
        stdout: err?.stdout,
        stderr: err?.stderr,
      });
      if (!retryable) throw err;

      const delayMs = 100 * attempt;
      if (log) {
        log(`[${command}] transient git failure, retrying in ${delayMs}ms (${attempt}/${maxAttempts})`);
      }
      await sleep(delayMs);
    }
  }

  throw lastError ?? new Error(`Command failed: ${command} ${args.join(' ')}`);
}

export async function git(args, options = {}) {
  const { stdout } = await runCommand('git', args, options);
  return stdout;
}

export async function getRepoRoot(cwd = process.cwd()) {
  const stdout = await git(['rev-parse', '--show-toplevel'], { cwd });
  return trimTrailingNewline(stdout.trim());
}

export async function getHeadRef(repoRoot) {
  const stdout = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot });
  const name = trimTrailingNewline(stdout.trim());
  return name;
}

export async function ensureCleanWorktree(repoRoot) {
  const status = await git(['status', '--porcelain'], { cwd: repoRoot });
  if (status.trim()) {
    const error = new Error(
      'Working tree is not clean. Commit/stash changes before running the orchestrator.',
    );
    error.details = status.trim();
    throw error;
  }
}

export async function ensureRepoExcludes(repoRoot, patterns, { log } = {}) {
  const candidates = Array.isArray(patterns) ? patterns : [patterns];
  const desired = candidates.map(normalizeExcludePattern).filter(Boolean);
  if (desired.length === 0) return { ok: true, updated: false, excludePath: null, added: [] };

  let excludePath = null;
  try {
    excludePath = trimTrailingNewline(
      (await git(['rev-parse', '--git-path', 'info/exclude'], { cwd: repoRoot, log })).trim(),
    );
  } catch (err) {
    if (log) log(`[git] failed to resolve info/exclude: ${err?.message ?? String(err ?? 'unknown error')}`);
    return { ok: false, updated: false, excludePath: null, added: [] };
  }

  if (!excludePath) return { ok: false, updated: false, excludePath: null, added: [] };

  try {
    await mkdir(path.dirname(excludePath), { recursive: true });
  } catch {
    // ignore
  }

  let existing = '';
  try {
    existing = await readFile(excludePath, 'utf8');
  } catch {
    existing = '';
  }

  const lines = existing.replace(/\r/g, '').split('\n');
  const normalizedExisting = new Set(lines.map(line => line.trim()).filter(Boolean));
  const added = desired.filter(pattern => !normalizedExisting.has(pattern));
  if (added.length === 0) return { ok: true, updated: false, excludePath, added: [] };

  const marker = '# Added by cdx (mcp-cdx)';
  const hasMarker = existing.includes(marker);

  let next = existing;
  if (next && !next.endsWith('\n')) next += '\n';
  if (next && !next.endsWith('\n\n')) next += '\n';
  if (!hasMarker) next += `${marker}\n`;
  next += `${added.join('\n')}\n`;

  await writeFile(excludePath, next, 'utf8');
  if (log) log(`[git] updated info/exclude (${excludePath}) with ${added.length} pattern(s).`);
  return { ok: true, updated: true, excludePath, added };
}

export { defaultWorktreeRoot };

async function applySparseCheckout({ repoRoot, worktreePath, log, override } = {}) {
  const config = override ?? resolveSparseConfig(repoRoot);
  if (!config?.enabled) return { enabled: false, applied: false };
  const paths = Array.isArray(config.paths) ? config.paths.filter(Boolean) : [];
  if (paths.length === 0) return { enabled: true, applied: false };

  const mode = config.mode === 'no-cone' ? 'no-cone' : 'cone';
  try {
    const initArgs = ['sparse-checkout', 'init'];
    if (mode === 'cone') initArgs.push('--cone');
    await git(initArgs, { cwd: worktreePath, log });
  } catch (err) {
    if (log) log(`[git] sparse-checkout init failed: ${err?.message ?? String(err ?? 'unknown error')}`);
  }

  try {
    const setArgs = ['sparse-checkout', 'set'];
    if (mode === 'cone') setArgs.push('--cone');
    setArgs.push(...paths);
    await git(setArgs, { cwd: worktreePath, log });
    return { enabled: true, applied: true, paths };
  } catch (err) {
    if (log) log(`[git] sparse-checkout set failed: ${err?.message ?? String(err ?? 'unknown error')}`);
    return { enabled: true, applied: false, error: err };
  }
}

async function ensureSymlink({ target, linkPath, log }) {
  if (!target || !linkPath) return false;
  try {
    const stat = await lstat(linkPath);
    if (stat.isSymbolicLink()) {
      try {
        const existing = await readlink(linkPath);
        const resolvedExisting = path.resolve(path.dirname(linkPath), existing);
        if (resolvedExisting === target) return true;
      } catch {
        // fall through
      }
      await rm(linkPath, { force: true });
    } else {
      if (log) log(`[worktree] skip externalize ${linkPath} (already exists)`);
      return false;
    }
  } catch (err) {
    if (err?.code !== 'ENOENT' && log) {
      log(`[worktree] failed to stat ${linkPath}: ${err?.message ?? String(err ?? 'unknown error')}`);
    }
  }

  const type = process.platform === 'win32' ? 'junction' : 'dir';
  await symlink(target, linkPath, type);
  return true;
}

async function ensureExternalizedDirs({ repoRoot, worktreePath, log, override } = {}) {
  const config = override ?? resolveExternalizeConfig();
  if (!config?.enabled) return { enabled: false, applied: false };
  const dirs = Array.isArray(config.dirs) ? config.dirs.filter(Boolean) : [];
  if (dirs.length === 0) return { enabled: true, applied: false };

  try {
    const patterns = dirs.map(dir => {
      const trimmed = String(dir).trim();
      if (!trimmed) return null;
      const values = [trimmed];
      if (!trimmed.endsWith('/')) values.push(`${trimmed}/`);
      return values;
    }).flat().filter(Boolean);
    if (patterns.length > 0) {
      await ensureRepoExcludes(worktreePath, patterns, { log });
    }
  } catch {
    // best-effort only
  }

  const sharedRoot = resolveSharedRoot(repoRoot);
  const artifactsRoot = resolveWorktreeArtifactsRoot({ repoRoot, worktreePath });
  const cachePaths = resolveSharedCachePaths(repoRoot);

  await mkdir(sharedRoot, { recursive: true }).catch(() => {});
  const cacheDirs = Object.values(cachePaths).filter(value => value && value !== sharedRoot);
  await Promise.all(cacheDirs.map(dir => mkdir(dir, { recursive: true }).catch(() => {})));
  await mkdir(artifactsRoot, { recursive: true }).catch(() => {});

  const applied = [];

  for (const dir of dirs) {
    const name = String(dir).trim();
    if (!name) continue;

    let target = null;
    if (name === '.cache' || name === 'cache') {
      target = cachePaths.xdg;
    } else if (name === 'build') {
      target = path.join(artifactsRoot, 'build');
    } else if (name === 'dist') {
      target = path.join(artifactsRoot, 'dist');
    } else {
      target = path.join(artifactsRoot, name);
    }

    await mkdir(target, { recursive: true }).catch(() => {});
    const linkPath = path.join(worktreePath, name);
    const linked = await ensureSymlink({ target, linkPath, log }).catch(err => {
      if (log) log(`[worktree] failed to symlink ${name}: ${err?.message ?? String(err ?? 'unknown error')}`);
      return false;
    });
    if (linked) applied.push(name);
  }

  return { enabled: true, applied: applied.length > 0, dirs: applied };
}

export async function createWorktree({
  repoRoot,
  worktreePath,
  branch,
  baseRef = 'HEAD',
  log,
  sparse,
  externalize,
}) {
  await git(['worktree', 'add', '-b', branch, worktreePath, baseRef], { cwd: repoRoot, log });

  await applySparseCheckout({ repoRoot, worktreePath, log, override: sparse }).catch(() => {});
  await ensureExternalizedDirs({ repoRoot, worktreePath, log, override: externalize }).catch(() => {});
}

export async function removeWorktree({ repoRoot, worktreePath, force = true, log }) {
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(worktreePath);
  await git(args, { cwd: repoRoot, log });
}

function isSubpath(child, parent) {
  if (!child || !parent) return false;
  const resolvedParent = path.resolve(parent);
  const resolvedChild = path.resolve(child);
  if (resolvedChild === resolvedParent) return true;
  return resolvedChild.startsWith(resolvedParent + path.sep);
}

function parseWorktreePaths(output) {
  if (!output) return [];
  const lines = output.replace(/\r/g, '').split('\n');
  return lines
    .filter(line => line.startsWith('worktree '))
    .map(line => line.slice('worktree '.length).trim())
    .filter(Boolean);
}

export async function pruneWorktreeRuns({
  repoRoot,
  worktreeRoot,
  log,
  ttlHours,
  expire,
} = {}) {
  if (!repoRoot) return { ok: false, removed: 0 };

  const pruneArgs = ['worktree', 'prune'];
  if (expire && String(expire).trim()) {
    pruneArgs.push(`--expire=${String(expire).trim()}`);
  }

  try {
    await git(pruneArgs, { cwd: repoRoot, log });
  } catch (err) {
    if (log) log(`[git] worktree prune failed: ${err?.message ?? String(err ?? 'unknown error')}`);
  }

  const ttl = Number(ttlHours);
  if (!Number.isFinite(ttl) || ttl <= 0) {
    return { ok: true, removed: 0 };
  }

  const resolvedRoot = worktreeRoot ?? defaultWorktreeRoot(repoRoot);
  let entries = [];
  try {
    entries = await readdir(resolvedRoot, { withFileTypes: true });
  } catch {
    return { ok: true, removed: 0 };
  }

  let worktreeList = '';
  try {
    worktreeList = await git(['worktree', 'list', '--porcelain'], { cwd: repoRoot, log });
  } catch {
    worktreeList = '';
  }
  const activePaths = new Set(parseWorktreePaths(worktreeList));

  const now = Date.now();
  const ttlMs = ttl * 60 * 60 * 1000;
  let removed = 0;

  const sharedRoot = resolveSharedRoot(repoRoot);
  const artifactsRoot = path.join(sharedRoot, 'artifacts');

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runDir = path.join(resolvedRoot, entry.name);
    let stats;
    try {
      stats = await lstat(runDir);
    } catch {
      continue;
    }
    if (now - stats.mtimeMs < ttlMs) continue;

    let isActive = false;
    for (const activePath of activePaths) {
      if (isSubpath(activePath, runDir)) {
        isActive = true;
        break;
      }
    }
    if (isActive) continue;

    try {
      await rm(runDir, { recursive: true, force: true });
      removed += 1;
    } catch (err) {
      if (log) log(`[worktree] failed to remove ${runDir}: ${err?.message ?? String(err ?? 'unknown error')}`);
      continue;
    }

    const artifactDir = path.join(artifactsRoot, entry.name);
    try {
      await rm(artifactDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  if (removed > 0) {
    try {
      await git(pruneArgs, { cwd: repoRoot, log });
    } catch {
      // ignore
    }
  }

  return { ok: true, removed };
}

async function resolveCommitConfigArgs({ cwd, log } = {}) {
  const configArgs = [];
  let userName = process.env.CDX_GIT_USER_NAME;
  let userEmail = process.env.CDX_GIT_USER_EMAIL;
  if (!userName) {
    const name = await git(['config', '--get', 'user.name'], { cwd, log }).catch(() => '');
    userName = trimTrailingNewline(name).trim() || 'cdx-bot';
  }
  if (!userEmail) {
    const email = await git(['config', '--get', 'user.email'], { cwd, log }).catch(() => '');
    userEmail = trimTrailingNewline(email).trim() || 'cdx-bot@localhost';
  }
  configArgs.push('-c', `user.name=${userName}`);
  configArgs.push('-c', `user.email=${userEmail}`);
  return configArgs;
}

export async function commitAll({ cwd, message, log }) {
  const status = await git(['status', '--porcelain'], { cwd, log });
  if (!status.trim()) return false;
  try {
    await git(['add', '--sparse', '-A'], { cwd, log });
  } catch (err) {
    const stderr = `${err?.stderr ?? ''}\n${err?.stdout ?? ''}`.toLowerCase();
    const sparseUnsupported =
      stderr.includes('unknown option') && stderr.includes('sparse');
    if (!sparseUnsupported) throw err;
    await git(['add', '-A'], { cwd, log });
  }
  const configArgs = await resolveCommitConfigArgs({ cwd, log });
  await git([...configArgs, 'commit', '-m', message], { cwd, log });
  return true;
}

export async function commitAllowEmpty({
  cwd,
  message,
  log,
  noVerify = true,
} = {}) {
  const configArgs = await resolveCommitConfigArgs({ cwd, log });
  const commitArgs = [...configArgs, 'commit', '--allow-empty', '-m', message];
  if (noVerify) commitArgs.push('--no-verify');
  await git(commitArgs, { cwd, log });
  return true;
}

export async function mergeNoEdit({ cwd, branch, message, log }) {
  const args = ['merge', '--no-ff'];
  const trimmed = typeof message === 'string' ? message.trim() : '';
  if (trimmed) {
    args.push('-m', trimmed);
  } else {
    args.push('--no-edit');
  }
  args.push(branch);
  await git(args, { cwd, log });
}

export async function abortMerge({ cwd, log }) {
  await git(['merge', '--abort'], { cwd, log });
}
