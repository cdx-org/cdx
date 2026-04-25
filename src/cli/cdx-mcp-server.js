#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { BrokerSession } from '../runtime/broker-session.js';
import {
  commitAllowEmpty,
  commitAll,
  ensureCleanWorktree,
  ensureRepoExcludes,
  getRepoRoot,
  git,
} from '../runtime/git-worktree.js';
import { LspMessageReader, writeLspMessage } from '../runtime/lsp.js';
import { loadPromptTemplate, renderPromptTemplate } from '../runtime/prompt-templates.js';
import { resolveSparseConfig } from '../runtime/worktree-resources.js';

const BROKER_BASE_URL = process.env.BROKER_BASE_URL ?? 'http://localhost:4000';
const PROTOCOL_VERSION = process.env.MCP_PROTOCOL_VERSION ?? '2025-06-18';
const SERVER_INFO = { name: 'cdx-orchestrator', version: '0.2.0' };
const DEFAULT_MAX_PARALLELISM = Number.parseInt(
  process.env.CDX_MAX_PARALLELISM ?? '3',
  10,
);
const MAX_TASKS = Number.parseInt(process.env.CDX_MAX_TASKS ?? '8', 10);
const PLANNER_MODEL_PROMPT = process.env.CDX_PLANNER_PROMPT ?? '';
const PLANNER_MAX_RETRIES = Math.max(
  1,
  Number.parseInt(process.env.CDX_PLANNER_MAX_RETRIES ?? '2', 10) || 2,
);
const TASK_MAX_RETRIES = Math.max(
  1,
  Number.parseInt(process.env.CDX_TASK_MAX_RETRIES ?? '1', 10) || 1,
);
const HEALTH_TIMEOUT_MS = Math.max(
  200,
  Number.parseInt(process.env.CDX_HEALTH_TIMEOUT_MS ?? '1500', 10) || 1500,
);
const DEFAULT_APP_SERVER_ENTRY = fileURLToPath(
  new URL('./cdx-appserver-mcp-server.js', import.meta.url),
);
const APP_SERVER_ENTRY = process.env.CDX_APPSERVER_ENTRY
  ? path.resolve(process.env.CDX_APPSERVER_ENTRY)
  : DEFAULT_APP_SERVER_ENTRY;
const APP_SERVER_COMMAND = process.env.CDX_APPSERVER_COMMAND ?? process.execPath;
const DEFAULT_CODEX_MODEL = process.env.CDX_DEFAULT_MODEL ?? process.env.CDX_MODEL ?? 'gpt-5.4';

function logDebug(...args) {
  if (process.env.CDX_LOG_LEVEL === 'debug') {
    console.error(new Date().toISOString(), '[cdx]', ...args);
  }
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function slugify(value, fallback) {
  if (!value || typeof value !== 'string') {
    return fallback;
  }
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

function collectText(result) {
  if (!result || !Array.isArray(result.content)) {
    return '';
  }
  return result.content
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text.trim())
    .filter(Boolean)
    .join('\n\n');
}

function extractJsonCandidate(text) {
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }
  const match = trimmed.match(/\{[\s\S]*\}/);
  return match ? match[0] : null;
}

function coerceString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function coerceBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (['1', 'true', 'yes', 'y', 'on', 'enable', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off', 'disable', 'disabled'].includes(normalized)) return false;
  return null;
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const candidate = coerceString(value);
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    out.push(candidate);
  }
  return out;
}


function uniqueList(items) {
  const out = [];
  const seen = new Set();
  for (const item of items ?? []) {
    if (item === null || item === undefined) continue;
    const value = String(item).trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function normaliseRepoPath(value) {
  const normalized = String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .trim();
  return normalized;
}

function hasGlobChars(pattern) {
  return /[*?[\]{}]/.test(String(pattern ?? ''));
}

function extractSparseRoots(sparseConfig) {
  return uniqueList(
    (Array.isArray(sparseConfig?.paths) ? sparseConfig.paths : [])
      .map(pattern => normaliseRepoPath(pattern))
      .map(normalized => {
        if (!normalized) return null;
        const first = normalized.split('/').find(Boolean) ?? '';
        if (!first || hasGlobChars(first)) return null;
        return first;
      })
      .filter(Boolean),
  );
}

function resolveTaskPathLayout(sparseConfig) {
  const allowedRoots = extractSparseRoots(sparseConfig);
  const preferredCodeRoot =
    ['src', 'lib', 'app', 'apps', 'packages'].find(root => allowedRoots.includes(root)) ?? null;
  const preferredScriptRoot = ['scripts'].find(root => allowedRoots.includes(root)) ?? null;
  const preferredTestRoot = ['tests', 'test'].find(root => allowedRoots.includes(root)) ?? null;

  if (
    allowedRoots.length === 0
    && !preferredCodeRoot
    && !preferredScriptRoot
    && !preferredTestRoot
  ) {
    return null;
  }

  return {
    allowedRoots,
    preferredCodeRoot,
    preferredScriptRoot,
    preferredTestRoot,
  };
}

function formatRepoRoots(roots) {
  return uniqueList((roots ?? []).map(root => `${root}/`));
}

function buildPlannerPathLayoutLines(pathLayout) {
  if (!pathLayout) return [];

  const lines = [];
  const roots = formatRepoRoots(pathLayout.allowedRoots);
  if (roots.length > 0) {
    lines.push(`- Restrict ownership.paths and touched files to sparse-checkout roots: ${roots.join(', ')}.`);
  }
  if (pathLayout.preferredCodeRoot === 'src') {
    lines.push('- Repository code root is src/; put new packages/modules under src/<package>/..., not at the repository top level.');
  } else if (pathLayout.preferredCodeRoot) {
    lines.push(`- Repository code root is ${pathLayout.preferredCodeRoot}/; put new packages/modules there instead of inventing new top-level directories.`);
  }
  if (pathLayout.preferredScriptRoot) {
    lines.push(`- Put runnable entrypoints and helper scripts under ${pathLayout.preferredScriptRoot}/ when adding new files.`);
  }
  if (pathLayout.preferredTestRoot) {
    lines.push(`- Put new tests under ${pathLayout.preferredTestRoot}/.`);
  }
  return lines;
}

function buildPlannerPathLayoutHint(pathLayout) {
  const lines = buildPlannerPathLayoutLines(pathLayout);
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

function buildTaskPathLayoutLines(pathLayout) {
  if (!pathLayout) return [];

  const lines = [];
  if (pathLayout.preferredCodeRoot === 'src') {
    lines.push('- Keep new package/module files under src/<package>/..., not at the repository top level.');
  } else if (pathLayout.preferredCodeRoot) {
    lines.push(`- Keep new package/module files under ${pathLayout.preferredCodeRoot}/.`);
  }
  if (pathLayout.preferredScriptRoot) {
    lines.push(`- Keep new runnable scripts under ${pathLayout.preferredScriptRoot}/.`);
  }
  if (pathLayout.preferredTestRoot) {
    lines.push(`- Keep new tests under ${pathLayout.preferredTestRoot}/.`);
  }
  const roots = formatRepoRoots(pathLayout.allowedRoots);
  if (roots.length > 0) {
    lines.push(`- Sparse-checkout roots: ${roots.join(', ')}.`);
  }
  return lines;
}

function splitPromptOwnedPathList(value) {
  return uniqueList(
    String(value ?? '')
      .split(/\s*(?:,|;)\s*/)
      .map(part => normaliseRepoPath(part))
      .filter(Boolean),
  );
}

function extractPromptOwnedPaths(prompt) {
  if (typeof prompt !== 'string' || prompt.trim().length === 0) return [];

  const matches = [];
  for (const line of prompt.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:[-*]\s*)?(?:Expected touched paths|Owned paths)\s*:\s*(.+?)\s*$/i);
    if (!match) continue;
    matches.push(...splitPromptOwnedPathList(match[1]));
  }
  return uniqueList(matches);
}

function shouldRemapPathToPreferredCodeRoot(normalizedPath, pathLayout) {
  if (!normalizedPath || !pathLayout?.preferredCodeRoot) return false;

  const segments = normalizedPath.split('/').filter(Boolean);
  if (segments.length === 0) return false;

  const first = segments[0];
  if (!first || first.startsWith('.')) return false;
  if ((pathLayout.allowedRoots ?? []).includes(first)) return false;
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(first)) return false;

  return segments.length > 1 || hasGlobChars(normalizedPath) || normalizedPath.endsWith('/');
}

function remapPathToPreferredCodeRoot(pattern, pathLayout) {
  const normalized = normaliseRepoPath(pattern);
  if (!normalized) return '';
  if (!shouldRemapPathToPreferredCodeRoot(normalized, pathLayout)) return normalized;
  return normaliseRepoPath(`${pathLayout.preferredCodeRoot}/${normalized}`);
}

function rewritePromptPathLabels(prompt, ownedPaths) {
  if (typeof prompt !== 'string' || prompt.trim().length === 0) return prompt;
  if (!Array.isArray(ownedPaths) || ownedPaths.length === 0) return prompt;

  const joined = ownedPaths.join(', ');
  return prompt.replace(
    /^(\s*(?:[-*]\s*)?(?:Expected touched paths|Owned paths)\s*:\s*)(.+?)\s*$/gim,
    (_, prefix) => `${prefix}${joined}`,
  );
}

function applyTaskPathLayout(task, pathLayout) {
  if (!task) return task;

  const ownership = normaliseTaskOwnership(task.ownership);
  const promptHintPaths = extractPromptOwnedPaths(task.prompt);
  let mergedPaths = uniqueList([
    ...(ownership?.paths ?? []),
    ...promptHintPaths,
  ].map(pattern => normaliseRepoPath(pattern)).filter(Boolean));

  if (pathLayout) {
    mergedPaths = uniqueList(
      mergedPaths
        .map(pattern => remapPathToPreferredCodeRoot(pattern, pathLayout))
        .filter(Boolean),
    );
  }

  const nextOwnership =
    mergedPaths.length > 0 || ownership?.scope
      ? { scope: ownership?.scope ?? null, paths: mergedPaths }
      : null;

  const nextPrompt =
    typeof task.prompt === 'string' && mergedPaths.length > 0
      ? rewritePromptPathLabels(task.prompt, mergedPaths)
      : task.prompt;

  return {
    ...task,
    prompt: nextPrompt,
    ownership: nextOwnership,
    pathLayout: pathLayout ?? null,
  };
}

function repoInitEnabled() {
  const configured = coerceBoolean(process.env.CDX_REPO_INIT);
  return configured ?? true;
}

function resolveRepoInitCommitMessage() {
  const message = String(process.env.CDX_REPO_INIT_COMMIT_MESSAGE ?? '').trim();
  return message || 'init: bootstrap repo for cdx';
}

function normalizeConflictStrategy(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'ours' || normalized === 'theirs' || normalized === 'abort') {
    return normalized;
  }
  return null;
}

function normalizeDirtyAction(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['commit', 'ask', 'prompt', 'abort'].includes(normalized)) {
    return normalized;
  }
  return null;
}

function resolveDirtyWorktreeAction() {
  return normalizeDirtyAction(process.env.CDX_DIRTY_WORKTREE) ?? 'commit';
}

function resolveDirtyWorktreeConflictStrategy() {
  return normalizeConflictStrategy(process.env.CDX_DIRTY_WORKTREE_CONFLICT) ?? 'ours';
}

function resolveDirtyWorktreeCommitMessage() {
  const message = String(process.env.CDX_DIRTY_WORKTREE_COMMIT_MESSAGE ?? '').trim();
  return message || `chore(cdx): auto-commit before run (${new Date().toISOString()})`;
}

async function ensureInitialCommit({ cwd, message, log } = {}) {
  const committed = await commitAll({ cwd, message, log });
  if (!committed) {
    await commitAllowEmpty({ cwd, message, log, noVerify: true });
  }
}

async function bootstrapRepo(cwd, { log } = {}) {
  if (log) log(`No git repository found; initializing one in ${cwd}...`);
  await git(['init'], { cwd, log });
  await ensureInitialCommit({ cwd, message: resolveRepoInitCommitMessage(), log });
  return await getRepoRoot(cwd);
}

async function resolveRepoRoot(explicitCwd, sandboxCwd, { log } = {}) {
  const candidates = uniqueStrings([
    explicitCwd,
    sandboxCwd,
    process.env.CODEX_PROJECT_ROOT,
    process.env.CODEX_WORKSPACE_ROOT,
    process.cwd(),
    process.env.INIT_CWD,
    process.env.PWD,
  ]);

  let lastError = null;
  for (const cwd of candidates) {
    if (!cwd) continue;
    const info = await stat(cwd).catch(() => null);
    if (!info || !info.isDirectory()) {
      continue;
    }
    try {
      return await getRepoRoot(cwd);
    } catch (err) {
      lastError = err;
      if (repoInitEnabled()) {
        return await bootstrapRepo(cwd, { log });
      }
    }
  }

  const hint = candidates.length ? ` Tried: ${candidates.join(', ')}` : '';
  const initHint = repoInitEnabled()
    ? ''
    : '\nSet CDX_REPO_INIT=1 to bootstrap a repo automatically.';
  throw new Error(
    `cdx must run inside a git repository.${hint}\n`
      + 'If your MCP server starts outside your repo, run Codex from within the target git repo.'
      + initHint,
    { cause: lastError },
  );
}

async function ensureGitAvailable({ log } = {}) {
  await git(['--version'], { log }).catch(err => {
    throw new Error(`git is required to run cdx: ${err?.message ?? err}`);
  });
}

async function ensureRepoIsNonBare({ cwd, log } = {}) {
  const bare = (await git(['rev-parse', '--is-bare-repository'], { cwd, log })).trim();
  if (bare === 'true') {
    throw new Error(`cdx requires a non-bare git repository (${cwd}).`);
  }
}

async function ensureRepoHasHead({ cwd, log } = {}) {
  const hasHead = await git(['rev-parse', '--verify', 'HEAD'], { cwd, log })
    .then(() => true)
    .catch(() => false);
  if (hasHead) return;

  if (repoInitEnabled()) {
    if (log) log('No commits found; creating an initial commit...');
    await ensureInitialCommit({ cwd, message: resolveRepoInitCommitMessage(), log });
    return;
  }

  throw new Error(
    `cdx requires at least one commit in ${cwd}.\n`
      + 'Create an initial commit or set CDX_REPO_INIT=1 to bootstrap automatically.',
  );
}

async function listGitOperationsInProgress({ cwd, log } = {}) {
  const checks = [
    { label: 'merge', path: 'MERGE_HEAD', hint: 'git merge --abort', abortArgs: ['merge', '--abort'] },
    { label: 'rebase', path: 'rebase-apply', hint: 'git rebase --abort', abortArgs: ['rebase', '--abort'] },
    { label: 'rebase', path: 'rebase-merge', hint: 'git rebase --abort', abortArgs: ['rebase', '--abort'] },
    {
      label: 'cherry-pick',
      path: 'CHERRY_PICK_HEAD',
      hint: 'git cherry-pick --abort',
      abortArgs: ['cherry-pick', '--abort'],
    },
    { label: 'revert', path: 'REVERT_HEAD', hint: 'git revert --abort', abortArgs: ['revert', '--abort'] },
  ];

  const active = [];
  for (const check of checks) {
    let resolved = '';
    try {
      resolved = (await git(['rev-parse', '--git-path', check.path], { cwd, log })).trim();
    } catch {
      continue;
    }
    if (!resolved) continue;
    const info = await stat(resolved).catch(() => null);
    if (info) active.push(check);
  }

  return active;
}

async function ensureNoGitOperationInProgress({ cwd, log, allowMerge = false } = {}) {
  const active = await listGitOperationsInProgress({ cwd, log });
  const filtered = allowMerge ? active.filter(entry => entry.label !== 'merge') : active;
  if (filtered.length === 0) return;
  const hints = filtered
    .map(entry => `${entry.label}: ${entry.hint}`)
    .join(', ');
  throw new Error(
    `cdx cannot proceed while a git operation is in progress (${hints}).`,
  );
}

async function abortGitOperations({ cwd, log, abortMerge = false } = {}) {
  const active = await listGitOperationsInProgress({ cwd, log });
  const toAbort = active.filter(entry => entry.label !== 'merge' || abortMerge);
  if (toAbort.length === 0) return { aborted: 0, skipped: active.length };
  for (const entry of toAbort) {
    await git(entry.abortArgs, { cwd, log });
  }
  return { aborted: toAbort.length, skipped: active.length - toAbort.length };
}

async function resolveUnmergedPaths({ cwd, strategy, log } = {}) {
  const resolvedStrategy = normalizeConflictStrategy(strategy) ?? resolveDirtyWorktreeConflictStrategy();
  const output = await git(['diff', '--name-only', '--diff-filter=U'], { cwd, log }).catch(() => '');
  const files = output
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  if (files.length === 0) return { resolved: false, files: [] };
  if (resolvedStrategy === 'abort') {
    const err = new Error(
      `Unmerged paths detected (${files.length}); set CDX_DIRTY_WORKTREE_CONFLICT=ours|theirs to auto-resolve.`,
    );
    err.files = files;
    throw err;
  }
  const checkoutArg = resolvedStrategy === 'theirs' ? '--theirs' : '--ours';
  for (const file of files) {
    await git(['checkout', checkoutArg, '--', file], { cwd, log });
  }
  await git(['add', '-A'], { cwd, log });
  if (log) {
    log(`Resolved ${files.length} conflicted path(s) using ${resolvedStrategy}.`);
  }
  return { resolved: true, files };
}

async function ensureCleanWorktreeOrCommit({ cwd, log } = {}) {
  try {
    await ensureCleanWorktree(cwd);
    return;
  } catch (err) {
    const action = resolveDirtyWorktreeAction();
    const hasDetails = err && typeof err === 'object' && 'details' in err;
    if (action === 'commit' && hasDetails) {
      const message = resolveDirtyWorktreeCommitMessage();
      await resolveUnmergedPaths({
        cwd,
        strategy: resolveDirtyWorktreeConflictStrategy(),
        log,
      });
      if (log) log('Working tree is not clean; auto-committing changes before run...');
      const committed = await commitAll({ cwd, message, log });
      if (committed && log) {
        const sha = (await git(['rev-parse', '--short', 'HEAD'], { cwd, log })).trim();
        if (sha) log(`Auto-commit created ${sha}.`);
      }
      await ensureCleanWorktree(cwd);
      return;
    }
    throw err;
  }
}

async function runPreflight({ explicitRepoRoot, sandboxCwd, log } = {}) {
  await ensureGitAvailable({ log });
  const repoRoot = await resolveRepoRoot(explicitRepoRoot, sandboxCwd, { log });
  await ensureRepoIsNonBare({ cwd: repoRoot, log });
  await ensureRepoHasHead({ cwd: repoRoot, log });
  const dirtyAction = resolveDirtyWorktreeAction();
  const conflictStrategy = resolveDirtyWorktreeConflictStrategy();
  const allowMerge = dirtyAction === 'commit' && conflictStrategy !== 'abort';
  if (dirtyAction === 'commit') {
    const outcome = await abortGitOperations({
      cwd: repoRoot,
      log,
      abortMerge: conflictStrategy === 'abort',
    });
    if (outcome.aborted > 0 && log) {
      log(`Aborted ${outcome.aborted} in-progress git operation(s) before run.`);
    }
  }
  await ensureNoGitOperationInProgress({ cwd: repoRoot, log, allowMerge });
  try {
    await ensureRepoExcludes(repoRoot, ['.cdx-worktrees/', '.tmp-debug-worktrees/'], { log });
  } catch {
    // best-effort only
  }
  await ensureCleanWorktreeOrCommit({ cwd: repoRoot, log });
  return { repoRoot };
}

class CodexClient {
  constructor({ label }) {
    this.label = label ?? 'codex-client';
    this.session = new BrokerSession(BROKER_BASE_URL, {
      log: (...args) => logDebug(`[${this.label}]`, ...args),
    });
    this.nextId = 1;
    this.pending = new Map();
    this.requestHandlers = new Map();
    this.notificationHandler = null;
    this.initialized = false;
    this.closed = false;
    this.initPromise = null;

    this.session.on('message', payload => {
      try {
        this.#handleIncoming(payload);
      } catch (err) {
        logDebug(`[${this.label}] incoming error`, err);
      }
    });
    this.session.on('close', () => {
      this.closed = true;
      for (const [, pending] of this.pending) {
        pending.reject(new Error('codex session closed'));
      }
      this.pending.clear();
    });
    this.requestHandlers.set('applyPatchApproval', msg =>
      this.#replyApproval(msg.id, 'denied'),
    );
    this.requestHandlers.set('execCommandApproval', msg =>
      this.#replyApproval(msg.id, 'denied'),
    );
  }

  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }

  async ensureInitialized() {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      await this.session.ensureReady();
      await this.#sendRequest('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: 'cdx-orchestrator-client', version: '0.1.0' },
      });
      this.initialized = true;
    })();
    return this.initPromise;
  }

  async dispose(reason = 'client-dispose') {
    if (this.closed) return;
    this.closed = true;
    await this.session.dispose(reason).catch(err => {
      logDebug(`[${this.label}] dispose failed`, err);
    });
  }

  async runCodexPrompt(prompt, overrides = {}) {
    await this.ensureInitialized();
    const args = {
      prompt,
      'approval-policy': overrides['approval-policy'] ?? 'never',
      sandbox: overrides.sandbox ?? 'workspace-write',
      'include-plan-tool': overrides['include-plan-tool'] ?? false,
      ...overrides,
    };
    if (!args.model) args.model = DEFAULT_CODEX_MODEL;
    const result = await this.#sendRequest('tools/call', {
      name: 'codex',
      arguments: args,
    });
    const text = collectText(result);
    if (result?.is_error) {
      const message = text || 'Codex returned an error result';
      throw new Error(message);
    }
    return { text, raw: result };
  }

  async #replyApproval(id, decision) {
    if (!id) return;
    await this.session
      .send({ jsonrpc: '2.0', id, result: { decision } })
      .catch(err => {
        logDebug(`[${this.label}] reply approval failed`, err);
      });
  }

  async #sendRequest(method, params) {
    if (this.closed) {
      throw new Error('codex client closed');
    }
    const id = `${this.nextId++}`;
    const payload = { jsonrpc: '2.0', id, method, params };
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    await this.session.send(payload);
    return promise;
  }

  #handleIncoming(message) {
    if (!message || typeof message !== 'object') return;

    if (Object.hasOwn(message, 'method')) {
      const { method } = message;
      if (Object.hasOwn(message, 'id') && this.requestHandlers.has(method)) {
        const handler = this.requestHandlers.get(method);
        handler?.(message);
        return;
      }
      if (this.notificationHandler) {
        this.notificationHandler(message);
      }
      return;
    }

    if (!Object.hasOwn(message, 'id')) return;
    const { id } = message;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);

    if (Object.hasOwn(message, 'error')) {
      const error = message.error ?? {};
      const err = new Error(error.message ?? 'Codex request failed');
      err.code = error.code;
      err.data = error.data;
      pending.reject(err);
      return;
    }

    pending.resolve(message.result);
  }
}

const DEFAULT_PLANNER_PROMPT_TEMPLATE = loadPromptTemplate(
  'planner',
  `You are an expert project planner coordinating a team of Codex engineers.
Break the given goal into a concise JSON plan using the schema:
{
  "tasks": [
    {
      "id": "task-1",               // slug style identifier, unique
      "description": "Short phrase",  // what must be delivered
      "dependsOn": ["task-0"],        // ids that must finish first (optional)
      "prompt": "Optional richer instructions for the Codex agent",
      "ownership": {                // strongly recommended for every task
        "scope": "Single sentence responsibility",
        "paths": ["src/example/*", "test/example.test.js"]
      }
    }
  ]
}
Always include at least one task.{{guidanceBlock}}
Ensure dependencies only reference defined task ids. Return ONLY JSON.`,
);
const DEFAULT_PLANNER_GUIDANCE = loadPromptTemplate(
  'planner-guidance-mcp',
  ' Prefer the smallest set of substantive tasks that preserves useful parallelism.\n'
    + 'Do not create audit-only, scout-only, placeholder, or coordination-only tasks unless analysis is explicitly requested or missing context truly blocks implementation.\n',
);
const PLANNER_ONLY_NOTE = loadPromptTemplate(
  'planner-only-mcp',
  'Plan only: do not write code, run commands, or propose file changes.',
);
const TASK_PROMPT_TEMPLATE = loadPromptTemplate(
  'task',
  'You are part of a larger effort to accomplish the following goal:\n'
    + '{{goal}}\n\n'
    + 'Task assigned to you ({{taskId}}):\n'
    + '{{taskDescription}}{{contextSection}}{{repoIndexSection}}{{extraSection}}{{ownershipSection}}{{prdSection}}{{supervisorRules}}{{retryHint}}\n'
    + '{{tailInstruction}}\n',
);
const TASK_TAIL_PROMPT = loadPromptTemplate(
  'task-tail-mcp',
  'Deliver the best possible result for this task.\n'
    + 'You are not alone in the codebase; avoid unrelated files.\n',
);
const SUMMARY_PROMPT_TEMPLATE = loadPromptTemplate(
  'summariser',
  'The original goal was:\n'
    + '{{goal}}\n\n'
    + 'Completed task outputs:\n'
    + '{{completedSection}}\n\n'
    + 'Failed tasks:\n'
    + '{{failureSection}}\n\n'
    + 'Blocked tasks:\n'
    + '{{blockedSection}}\n\n'
    + 'Produce a cohesive final answer for the user. Highlight any gaps caused by failures or blocked tasks.\n',
);

function buildPlannerPrompt(goal, customization, hints = {}) {
  const base = customization && customization.trim()
    ? customization.trim()
    : renderPromptTemplate(DEFAULT_PLANNER_PROMPT_TEMPLATE, {
      guidanceBlock: DEFAULT_PLANNER_GUIDANCE,
    });
  const pathLayout = hints.pathLayout ?? null;
  const ownershipConstraints = [
    '- Explicitly assign ownership for each task (files/modules/responsibility).',
    '- In each task prompt, state ownership boundaries and expected touched paths.',
    ...buildPlannerPathLayoutLines(pathLayout),
    '- Remind workers they are not alone in the codebase and must avoid unrelated files.',
  ].join('\n');
  return `${base}\n\n${PLANNER_ONLY_NOTE}\n${ownershipConstraints}\n\nGoal:\n${goal}`;
}

function buildRecoveryPrompt(goal, completedTasks, failedTasks, blockedTasks, hints = {}) {
  const completedSection = completedTasks
    .map(task => `- ${task.id}: ${task.description}`)
    .join('\n');
  const failedSection = failedTasks
    .map(task => `- ${task.id}: ${task.description} (reason: ${task.error ?? 'unknown'})`)
    .join('\n') || '- none';
  const blockedSection = blockedTasks
    .map(task => `- ${task.id}: ${task.description}`)
    .join('\n') || '- none';

  const planBlockTemplate = loadPromptTemplate(
    'recovery-plan-block-mcp',
    'Propose a minimal JSON recovery plan using the same schema as before. Focus only on addressing the failed/blocked areas.\n'
      + '{{plannerOnlyNote}}\n'
      + 'Explicitly assign ownership for each task (files/modules/responsibility).\n'
      + '{{pathLayoutHint}}'
      + 'Avoid referencing previous task ids directly; emit fresh ids. Return ONLY JSON.\n',
  );
  const planBlock = renderPromptTemplate(planBlockTemplate, {
    plannerOnlyNote: PLANNER_ONLY_NOTE,
    pathLayoutHint: buildPlannerPathLayoutHint(hints.pathLayout ?? null),
  });
  const promptTemplate = loadPromptTemplate(
    'recovery-planner',
    `You are designing a recovery plan after some tasks failed or were blocked in a multi-agent workflow.
Goal:
{{goal}}{{repoIndexBlock}}

Completed tasks (you MAY depend on these ids):
{{completedSection}}

Failed tasks (need recovery coverage):
{{failedSection}}

Blocked tasks (need recovery coverage):
{{blockedSection}}

{{planBlock}}`,
  );
  return renderPromptTemplate(promptTemplate, {
    goal,
    repoIndexBlock: '',
    completedSection: completedSection || '- none',
    failedSection,
    blockedSection,
    planBlock,
  });
}

function parsePlan(text) {
  const candidate = extractJsonCandidate(text);
  if (!candidate) {
    throw new Error('Planner did not return JSON.');
  }
  const parsed = JSON.parse(candidate);
  if (!isObject(parsed) || !Array.isArray(parsed.tasks)) {
    throw new Error('Planner response missing tasks array.');
  }
  return parsed;
}

function normaliseOwnedPaths(value, limit = 32) {
  const source = Array.isArray(value) ? value : [value];
  const out = [];
  const seen = new Set();
  for (const entry of source) {
    if (out.length >= limit) break;
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normaliseTaskOwnership(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const scope = value.trim();
    return scope ? { scope, paths: [] } : null;
  }
  if (Array.isArray(value)) {
    const paths = normaliseOwnedPaths(value);
    return paths.length > 0 ? { scope: null, paths } : null;
  }
  if (!isObject(value)) return null;

  const scopeCandidates = [
    value.scope,
    value.responsibility,
    value.owner,
    value.ownershipScope,
    value.focus,
  ];
  let scope = null;
  for (const candidate of scopeCandidates) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    scope = trimmed;
    break;
  }

  const paths = normaliseOwnedPaths(
    Array.isArray(value.paths)
      ? value.paths
      : Array.isArray(value.files)
        ? value.files
        : Array.isArray(value.ownedFiles)
          ? value.ownedFiles
          : Array.isArray(value.ownedPaths)
            ? value.ownedPaths
            : [],
  );
  if (!scope && paths.length === 0) return null;
  return { scope, paths };
}

function buildTaskOwnershipSection(task) {
  const ownership = normaliseTaskOwnership(task?.ownership);
  const pathLayout = task?.pathLayout ?? null;
  const lines = ['\nOwnership rules:'];
  if (ownership?.scope) {
    lines.push(`- Responsibility: ${ownership.scope}`);
  }
  if (ownership?.paths?.length > 0) {
    lines.push(`- Owned paths: ${ownership.paths.join(', ')}`);
    lines.push(`- Expected touched paths: ${ownership.paths.join(', ')}`);
  } else {
    lines.push('- Owned paths: keep edits strictly scoped to files needed for this task.');
  }
  lines.push(...buildTaskPathLayoutLines(pathLayout));
  lines.push('- You are not alone in the codebase; other workers may edit unrelated files.');
  lines.push('- Do not modify files outside your ownership unless absolutely required.');
  lines.push('- If out-of-scope edits are unavoidable, keep them minimal and explain why.');
  return `${lines.join('\n')}\n`;
}

function normaliseTasks(rawTasks, options = {}) {
  const pathLayout = options.pathLayout ?? null;
  const tasks = Array.isArray(rawTasks) ? rawTasks.slice(0, MAX_TASKS) : [];
  if (tasks.length === 0) {
    return [
      {
        id: 'task-1',
        description: 'Fulfil the original request',
        dependsOn: [],
        prompt: null,
        ownership: null,
      },
    ];
  }

  const seen = new Map();
  const normalised = [];

  for (let index = 0; index < tasks.length; index += 1) {
    const original = tasks[index] ?? {};
    let id = typeof original.id === 'string' ? original.id.trim() : '';
    id = slugify(id, `task-${index + 1}`);
    let suffix = 1;
    while (seen.has(id)) {
      suffix += 1;
      id = `${id}-${suffix}`;
    }
    seen.set(id, true);

    const description =
      typeof original.description === 'string' && original.description.trim().length > 0
        ? original.description.trim()
        : typeof original.title === 'string' && original.title.trim().length > 0
          ? original.title.trim()
          : `Task ${index + 1}`;

    const dependsOn = Array.isArray(original.dependsOn)
      ? original.dependsOn
          .map(dep => (typeof dep === 'string' ? dep.trim() : ''))
          .filter(Boolean)
      : [];

    const prompt =
      typeof original.prompt === 'string' && original.prompt.trim().length > 0
        ? original.prompt.trim()
        : null;

    const ownership = normaliseTaskOwnership(
      original.ownership ?? {
        scope: original.ownershipScope ?? original.scope ?? original.responsibility ?? null,
        paths: original.ownedPaths ?? original.ownedFiles ?? original.files ?? original.paths ?? null,
      },
    );

    normalised.push(applyTaskPathLayout({
      id,
      description,
      dependsOn,
      prompt,
      ownership,
    }, pathLayout));
  }

  return normalised;
}

class TaskState {
  constructor(task) {
    this.task = task;
    this.status = 'pending';
    this.startedAt = null;
    this.finishedAt = null;
    this.output = null;
    this.error = null;
  }

  start() {
    this.status = 'running';
    this.startedAt = Date.now();
  }

  complete(output) {
    this.status = 'completed';
    this.finishedAt = Date.now();
    this.output = output;
  }

  fail(err) {
    this.status = 'failed';
    this.finishedAt = Date.now();
    this.error = err instanceof Error ? err.message : String(err ?? 'unknown error');
  }

  block(reason) {
    this.status = 'blocked';
    this.finishedAt = Date.now();
    this.error = typeof reason === 'string' ? reason : String(reason ?? 'blocked');
  }

  durationMs() {
    if (!this.startedAt) return null;
    const end = this.finishedAt ?? Date.now();
    return end - this.startedAt;
  }
}

class CdxOrchestrator {
  constructor({ sendLog, sendProgress } = {}) {
    this.sendLog = sendLog ?? (() => {});
    this.sendProgress = sendProgress ?? (() => {});
    this.taskPathLayout = null;
  }

  async run({ prompt, maxParallelism, plannerPrompt, includeSummary, repoRoot }) {
    if (!prompt || typeof prompt !== 'string') {
      throw new Error('cdx tool requires a prompt string.');
    }
    const goal = prompt.trim();
    if (!goal) {
      throw new Error('cdx tool prompt cannot be empty.');
    }

    let layoutRepoRoot = coerceString(repoRoot);
    if (!layoutRepoRoot) {
      try {
        layoutRepoRoot = await getRepoRoot(process.cwd());
      } catch {
        layoutRepoRoot = process.cwd();
      }
    }
    this.taskPathLayout = resolveTaskPathLayout(resolveSparseConfig(layoutRepoRoot));

    const parsedParallel = Number.parseInt(maxParallelism, 10);
    const requestedParallelism = Number.isFinite(parsedParallel) && parsedParallel > 0
      ? parsedParallel
      : DEFAULT_MAX_PARALLELISM;
    const parallelism = await this.#resolveParallelism(requestedParallelism);

    this.sendLog(`Planning tasks (requested ${requestedParallelism}, using ${parallelism})`);
    this.sendProgress({ progress: 0.05, message: 'Planning tasks' });

    const { plan, planText } = await this.#generatePlan(goal, plannerPrompt);

    const tasks = normaliseTasks(plan.tasks, { pathLayout: this.taskPathLayout });
    const planRecord = { raw: planText, tasks };

    this.sendLog(`Executing ${tasks.length} task(s)`);
    this.sendProgress({
      progress: 0.2,
      message: `Executing ${tasks.length} task(s)`
        + (parallelism < requestedParallelism ? ` (throttled to ${parallelism})` : ''),
      total: tasks.length || 1,
    });

    const initialRun = await this.#runTasks(goal, tasks, parallelism);
    let taskResults = [...initialRun.results];
    let outputs = initialRun.outputs;

    const recovery = await this.#attemptRecovery(goal, taskResults, parallelism, outputs);
    if (recovery) {
      planRecord.recovery = recovery.planRecord;
      taskResults = [...taskResults, ...recovery.results];
      outputs = recovery.outputs;
    }

    this.sendProgress({ progress: 0.85, message: 'Generating summary' });

    const summaryText = await this.#summarise(goal, taskResults, includeSummary !== false);
    const reports = this.#buildReports(taskResults);

    return { plan: planRecord, tasks: taskResults, summary: summaryText, reports };
  }

  async #resolveParallelism(desired) {
    const fallback = Math.max(1, desired);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS).unref();
      const res = await fetch(`${BROKER_BASE_URL}/health`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return fallback;
      const data = await res.json();
      const workers = Array.isArray(data?.workers) ? data.workers : [];
      if (workers.length === 0) return fallback;
      const idle = workers.filter(worker => worker.state === 'idle').length;
      if (idle > 0) {
        return Math.max(1, Math.min(desired, idle));
      }
      return Math.max(1, Math.min(desired, workers.length));
    } catch (err) {
      logDebug('Failed to resolve broker capacity', err);
      return fallback;
    }
  }

  async #generatePlan(goal, plannerPrompt) {
    const baseCustomization = (plannerPrompt || PLANNER_MODEL_PROMPT || '').trim();
    const { plan, planText, error } = await this.#obtainPlan(attempt => {
      if (attempt === 0) {
        return buildPlannerPrompt(goal, baseCustomization, { pathLayout: this.taskPathLayout });
      }
      const reinforcement = `${baseCustomization ? `${baseCustomization}\n` : ''}Return strictly valid JSON with a {"tasks": [...]} payload. Do not include commentary.`;
      return buildPlannerPrompt(goal, reinforcement, { pathLayout: this.taskPathLayout });
    });

    if (!plan) {
      this.sendLog(
        `Planner did not return valid JSON after ${PLANNER_MAX_RETRIES} attempt(s): ${error?.message ?? ''}`,
      );
      return { plan: { tasks: [] }, planText: planText || 'planner-fallback' };
    }

    return { plan, planText };
  }

  async #obtainPlan(promptFactory) {
    const client = new CodexClient({ label: 'planner' });
    let lastText = '';
    let plan = null;
    let lastError = null;
    try {
      for (let attempt = 0; attempt < PLANNER_MAX_RETRIES; attempt += 1) {
        const promptText = promptFactory(attempt);
        const { text } = await client.runCodexPrompt(promptText, { sandbox: 'read-only' });
        lastText = text;
        try {
          plan = parsePlan(text);
          break;
        } catch (err) {
          lastError = err;
          this.sendLog(`Planner attempt ${attempt + 1} failed: ${err.message}`);
        }
      }
    } finally {
      await client.dispose('planner-finished');
    }
    return { plan, planText: lastText, error: lastError };
  }

  async #runTasks(goal, tasks, maxParallelism, seedOutputs = new Map()) {
    const taskMap = new Map();
    const taskStates = new Map();

    for (const task of tasks) {
      taskMap.set(task.id, task);
      taskStates.set(task.id, new TaskState(task));
    }

    const dependents = new Map();
    const remainingDeps = new Map();

    for (const task of tasks) {
      const deps = (task.dependsOn ?? [])
        .filter(dep => dep !== task.id && taskMap.has(dep));
      remainingDeps.set(task.id, new Set(deps));
      for (const dep of deps) {
        if (!dependents.has(dep)) dependents.set(dep, []);
        dependents.get(dep).push(task.id);
      }
    }

    const ready = [];
    for (const [taskId, depSet] of remainingDeps.entries()) {
      if (depSet.size === 0) ready.push(taskId);
    }

    const outputs = seedOutputs instanceof Map ? new Map(seedOutputs) : new Map();
    const resolved = new Set();
    const failedTasks = new Set();
    const total = tasks.length || 1;
    const running = new Set();

    const progressFor = (taskId, status, message) => {
      resolved.add(taskId);
      const ratio = resolved.size / total;
      const progressValue = 0.2 + Math.min(ratio, 1) * 0.6;
      this.sendProgress({
        progress: Math.min(progressValue, 0.8),
        message: message ?? `Task ${taskId} ${status}`,
        total,
      });
    };

    const removeFromReady = target => {
      let index;
      while ((index = ready.indexOf(target)) !== -1) {
        ready.splice(index, 1);
      }
    };

    const markBlocked = (taskId, reason, origin) => {
      const state = taskStates.get(taskId);
      if (!state || state.status !== 'pending') return;
      state.block(reason ?? `Blocked by failed dependency ${origin}`);
      progressFor(taskId, 'blocked', `Blocked task ${taskId}`);
      removeFromReady(taskId);
      const dependentsForTask = dependents.get(taskId) ?? [];
      for (const dependentId of dependentsForTask) {
        markBlocked(dependentId, reason, origin ?? taskId);
      }
    };

    const launchTask = taskId => {
      const state = taskStates.get(taskId);
      const task = taskMap.get(taskId);
      if (!state || !task || state.status !== 'pending') return;
      state.start();
      const promise = this.#executeTask(goal, task, outputs)
        .then(result => {
          state.complete(result.output);
          outputs.set(taskId, result.output);
          const dependentsForTask = dependents.get(taskId) ?? [];
          for (const dependentId of dependentsForTask) {
            const depSet = remainingDeps.get(dependentId);
            if (!depSet) continue;
            depSet.delete(taskId);
            if (depSet.size === 0 && taskStates.get(dependentId)?.status === 'pending') {
              ready.push(dependentId);
            }
          }
          progressFor(taskId, 'completed', `Completed task ${taskId}`);
        })
        .catch(err => {
          const error = err instanceof Error ? err : new Error(String(err ?? 'Task failed'));
          failedTasks.add(taskId);
          state.fail(error);
          progressFor(taskId, 'failed', `Failed task ${taskId}: ${error.message}`);
          const dependentsForTask = dependents.get(taskId) ?? [];
          for (const dependentId of dependentsForTask) {
            markBlocked(dependentId, `Blocked by failed task ${taskId}: ${error.message}`, taskId);
          }
        })
        .finally(() => {
          running.delete(promise);
          // Launch newly-runnable work as soon as a worker slot is freed.
          launchIfPossible();
        });

      running.add(promise);
    };

    const launchIfPossible = () => {
      while (ready.length > 0 && running.size < maxParallelism) {
        const nextId = ready.shift();
        if (!nextId) continue;
        const state = taskStates.get(nextId);
        if (!state || state.status !== 'pending') continue;
        launchTask(nextId);
      }
    };

    launchIfPossible();

    while (resolved.size < total) {
      if (running.size === 0) {
        if (ready.length === 0) {
          if (failedTasks.size > 0) {
            break;
          }
          throw new Error('Task dependency cycle detected or no runnable tasks remain.');
        }
        launchIfPossible();
        continue;
      }
      await Promise.race(running);
      launchIfPossible();
    }

    await Promise.allSettled(running);

    const results = [];
    for (const [taskId, state] of taskStates.entries()) {
      results.push({
        id: taskId,
        description: state.task.description,
        dependsOn: state.task.dependsOn,
        prompt: state.task.prompt,
        status: state.status,
        output: state.output,
        error: state.error,
        durationMs: state.durationMs(),
      });
    }

    return { results, outputs };
  }

  async #attemptRecovery(goal, taskResults, parallelism, existingOutputs) {
    const failed = taskResults.filter(task => task.status === 'failed');
    const blocked = taskResults.filter(task => task.status === 'blocked');
    if (failed.length === 0 && blocked.length === 0) {
      return null;
    }

    this.sendLog('Attempting recovery planning for failed/blocked tasks');
    this.sendProgress({ progress: 0.86, message: 'Planning recovery tasks' });

    const completed = taskResults.filter(task => task.status === 'completed');
    const { plan, planText } = await this.#obtainPlan(attempt => {
      const basePrompt = buildRecoveryPrompt(goal, completed, failed, blocked, { pathLayout: this.taskPathLayout });
      if (attempt === 0) return basePrompt;
      return `${basePrompt}\nRemember: respond with JSON only.`;
    });

    if (!plan || !Array.isArray(plan.tasks) || plan.tasks.length === 0) {
      this.sendLog('Recovery planner produced no tasks; skipping recovery stage');
      return null;
    }

    const recoveryTasks = normaliseTasks(plan.tasks, { pathLayout: this.taskPathLayout }).map(task => ({
      ...task,
      id: task.id.startsWith('recovery-') ? task.id : `recovery-${task.id}`,
    }));

    this.sendProgress({
      progress: 0.88,
      message: `Executing recovery tasks (${recoveryTasks.length})`,
      total: recoveryTasks.length,
    });

    const recoveryRun = await this.#runTasks(
      goal,
      recoveryTasks,
      parallelism,
      existingOutputs,
    );

    return {
      planRecord: { raw: planText, tasks: recoveryTasks },
      results: recoveryRun.results,
      outputs: recoveryRun.outputs,
    };
  }

  async #executeTask(goal, task, outputs) {
    const client = new CodexClient({ label: `task-${task.id}` });
    let lastError = null;
    try {
      for (let attempt = 0; attempt < TASK_MAX_RETRIES; attempt += 1) {
        try {
          const dependencyContext = (task.dependsOn ?? [])
            .map(depId => {
              const output = outputs.get(depId);
              if (!output) return null;
              return `### ${depId}\n${output}`;
            })
            .filter(Boolean)
            .join('\n\n');

          const contextSection = dependencyContext
            ? `\nContext from prerequisite tasks:\n${dependencyContext}\n`
            : '';

          const ownershipSection = buildTaskOwnershipSection(task);
          const extra = task.prompt ? `\nAdditional instructions:\n${task.prompt}\n` : '';
          const retryHint = attempt > 0 ? `\nPrevious attempt did not succeed. Ensure the response contains thorough, actionable results.` : '';

          const taskPrompt = renderPromptTemplate(TASK_PROMPT_TEMPLATE, {
            goal,
            taskId: task.id,
            taskDescription: task.description ?? '',
            ownershipSection,
            contextSection,
            repoIndexSection: '',
            extraSection: extra,
            prdSection: '',
            supervisorRules: '',
            retryHint,
            tailInstruction: TASK_TAIL_PROMPT,
          });

          const { text } = await client.runCodexPrompt(taskPrompt);
          return { output: text };
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err ?? 'Task failed'));
          if (attempt + 1 >= TASK_MAX_RETRIES) {
            throw lastError;
          }
          this.sendLog(`Retrying task ${task.id} after error: ${lastError.message}`);
        }
      }
      throw lastError ?? new Error('Task failed for unknown reasons');
    } finally {
      await client.dispose(`task-${task.id}-completed`);
    }
  }

  async #summarise(goal, taskResults, includeSummary) {
    if (!includeSummary) {
      return this.#fallbackSummary(taskResults);
    }

    const completed = taskResults.filter(task => task.status === 'completed' && task.output);
    const failed = taskResults.filter(task => task.status === 'failed');
    const blocked = taskResults.filter(task => task.status === 'blocked');

    if (completed.length === 0 && (failed.length > 0 || blocked.length > 0)) {
      return this.#fallbackSummary(taskResults);
    }

    const client = new CodexClient({ label: 'summariser' });
    try {
      const completedSection = completed
        .map(task => `### ${task.id}: ${task.description}\n${task.output}`)
        .join('\n\n');
      const failureSection = failed.length
        ? failed
            .map(task => `### ${task.id}: ${task.description}\nReason: ${task.error ?? 'Unknown error'}`)
            .join('\n\n')
        : 'None';
      const blockedSection = blocked.length
        ? blocked
            .map(task => `### ${task.id}: ${task.description}\nBlocked reason: ${task.error ?? 'Dependency failed'}`)
            .join('\n\n')
        : 'None';

      const summaryPrompt = renderPromptTemplate(SUMMARY_PROMPT_TEMPLATE, {
        goal,
        completedSection,
        failureSection,
        blockedSection,
      });
      const { text } = await client.runCodexPrompt(summaryPrompt);
      return text;
    } catch (err) {
      this.sendLog(`Summary generation failed: ${err.message}`);
      return this.#fallbackSummary(taskResults);
    } finally {
      await client.dispose('summary-finished');
    }
  }

  #buildReports(taskResults) {
    const toEntry = task => ({
      id: task.id,
      description: task.description,
      output: task.output ?? null,
      error: task.error ?? null,
      status: task.status,
    });
    return {
      successes: taskResults.filter(task => task.status === 'completed').map(toEntry),
      failures: taskResults.filter(task => task.status === 'failed').map(toEntry),
      blocked: taskResults.filter(task => task.status === 'blocked').map(toEntry),
    };
  }

  #fallbackSummary(taskResults) {
    return taskResults
      .map(task => {
        const status = task.status ?? 'unknown';
        const detail = task.output ?? task.error ?? '(no additional details)';
        return `Task ${task.id} [${status}]: ${detail}`;
      })
      .join('\n\n');
  }
}

class AppServerMcpClient {
  constructor({ log, onNotification } = {}) {
    this.log = log ?? (() => {});
    this.onNotification = onNotification ?? (() => {});
    this.proc = null;
    this.reader = null;
    this.pending = new Map();
    this.nextId = 1;
    this.readyPromise = null;
    this.sandboxCwd = null;
  }

  setSandboxCwd(value) {
    const normalized = coerceString(value);
    this.sandboxCwd = normalized;
    if (normalized) {
      this.#sendNotification('codex/sandbox-state/update', { sandboxCwd: normalized });
    }
  }

  async ensureReady() {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = (async () => {
      await this.#spawnProcess();
      await this.#sendRequest('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: 'cdx-broker', version: '0.1.0' },
      });
      if (this.sandboxCwd) {
        this.#sendNotification('codex/sandbox-state/update', { sandboxCwd: this.sandboxCwd });
      }
    })();
    return this.readyPromise;
  }

  async callTool(name, args) {
    await this.ensureReady();
    return await this.#sendRequest('tools/call', { name, arguments: args });
  }

  #spawnProcess() {
    if (this.proc && this.proc.exitCode == null && this.proc.signalCode == null) {
      return;
    }

    const child = spawn(APP_SERVER_COMMAND, [APP_SERVER_ENTRY], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      const text = String(chunk ?? '').trim();
      if (text) this.log(`[appserver stderr] ${text}`);
    });

    const reader = new LspMessageReader(child.stdout);
    reader.onMessage(message => {
      try {
        this.#handleMessage(message);
      } catch (err) {
        this.log(`[appserver] message error: ${err?.message ?? err}`);
      }
    });

    const finalize = reason => {
      if (!this.proc || this.proc !== child) return;
      for (const [, pending] of this.pending) {
        pending.reject(new Error(reason));
      }
      this.pending.clear();
      this.proc = null;
      this.reader = null;
      this.readyPromise = null;
    };

    child.on('error', err => {
      finalize(err?.message ?? 'appserver error');
    });
    child.on('close', () => {
      finalize('appserver exited');
    });

    this.proc = child;
    this.reader = reader;
  }

  #handleMessage(message) {
    if (message && Object.hasOwn(message, 'id')) {
      const id = String(message.id);
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (message.error) {
        const error = new Error(message.error?.message ?? 'appserver error');
        error.code = message.error?.code;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message?.method) {
      this.onNotification(message);
    }
  }

  #sendRequest(method, params) {
    if (!this.proc || !this.proc.stdin) {
      return Promise.reject(new Error('appserver not running'));
    }
    const id = String(this.nextId++);
    writeLspMessage(this.proc.stdin, { jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  #sendNotification(method, params) {
    if (!this.proc || !this.proc.stdin) return;
    writeLspMessage(this.proc.stdin, { jsonrpc: '2.0', method, params });
  }
}

class CdxMcpServer {
  constructor() {
    this.initialized = false;
    this.progressBridge = null;
    this.sandboxCwd = null;
    this.appserver = new AppServerMcpClient({
      log: message => this.#sendNotification('logging/message', { level: 'info', message }),
      onNotification: message => this.#handleAppServerNotification(message),
    });
  }

  async handleMessage(message) {
    if (!message || typeof message !== 'object') return;

    if (Object.hasOwn(message, 'method')) {
      if (Object.hasOwn(message, 'id')) {
        await this.#handleRequest(message);
      } else {
        await this.#handleNotification(message);
      }
      return;
    }
    // Ignore responses/notifications from the client side as we never initiate requests.
  }

  async #handleNotification(notification) {
    const { method, params } = notification ?? {};
    if (!method) return;
    if (method === 'codex/sandbox-state/update') {
      this.#onSandboxStateUpdate(params);
    }
  }

  #onSandboxStateUpdate(params) {
    if (!isObject(params)) return;
    const candidate =
      typeof params.sandboxCwd === 'string'
        ? params.sandboxCwd
        : typeof params.sandbox_cwd === 'string'
          ? params.sandbox_cwd
          : null;
    const normalized = coerceString(candidate);
    if (!normalized) return;
    this.sandboxCwd = normalized;
    this.appserver.setSandboxCwd(normalized);
  }

  async #handleRequest(request) {
    const { id, method, params } = request;
    try {
      switch (method) {
        case 'initialize':
          await this.#onInitialize(id, params);
          break;
        case 'ping':
          this.#sendResponse(id, {});
          break;
        case 'tools/list':
          this.#sendResponse(id, { tools: [this.#cdxToolDescriptor()] });
          break;
        case 'tools/call':
          await this.#onToolsCall(id, params);
          break;
        default:
          this.#sendError(id, -32601, `Unknown method: ${method}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? 'Unknown error');
      this.#sendError(id, -32603, message);
    }
  }

  async #onInitialize(id, params) {
    if (this.initialized) {
      this.#sendError(id, -32600, 'initialize already called');
      return;
    }
    this.initialized = true;
    const result = {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: { list: true, call: true },
        logging: { message: true },
        experimental: {
          'codex/sandbox-state': { version: '1.0.0' },
        },
      },
      serverInfo: SERVER_INFO,
    };
    if (params?.clientInfo?.name) {
      logDebug('Client connected:', params.clientInfo.name, params.clientInfo.version ?? '');
    }
    this.#sendResponse(id, result);
  }

  async #onToolsCall(id, params) {
    if (!isObject(params)) {
      this.#sendError(id, -32602, 'tools/call expects object params');
      return;
    }
    const { name, arguments: args } = params;
    if (name !== 'cdx'
      && name !== 'spawn'
      && name !== 'cdx.spawn'
      && name !== 'run'
      && name !== 'cdx.run') {
      this.#sendError(id, -32601, `Unknown tool: ${name}`);
      return;
    }
    const normalizedArgs = this.#normaliseArguments(args);
    const progressToken = randomUUID();
    this.progressBridge = payload => {
      if (!payload) return;
      const progressValue = Number.isFinite(payload.progress) ? payload.progress : 0;
      this.#sendProgress(progressToken, progressValue, payload.message, payload.total);
    };
    this.#sendProgress(progressToken, 0, 'cdx run started');

    try {
      const log = message =>
        this.#sendNotification('logging/message', { level: 'info', message });
      let preflightRepoRoot = null;
      try {
        const explicitRepoRoot = isObject(normalizedArgs)
          ? normalizedArgs.repoRoot ?? normalizedArgs.repo_root ?? null
          : null;
        const preflight = await runPreflight({
          explicitRepoRoot,
          sandboxCwd: this.sandboxCwd,
          log,
        });
        preflightRepoRoot = preflight.repoRoot;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err ?? 'Unknown error');
        this.#sendNotification('logging/message', {
          level: 'warn',
          message: `cdx preflight failed (falling back to appserver): ${message}`,
        });
      }

      let spawnArgs = normalizedArgs;
      if (isObject(normalizedArgs) && preflightRepoRoot && !normalizedArgs.repoRoot) {
        spawnArgs = { ...normalizedArgs, repoRoot: preflightRepoRoot };
      }

      this.appserver.setSandboxCwd(this.sandboxCwd);
      const result = await this.appserver.callTool('spawn', spawnArgs);
      this.#sendResponse(id, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? 'Unknown error');
      this.#sendProgress(progressToken, 1, `cdx run failed: ${message}`);
      this.#sendResponse(id, {
        is_error: true,
        content: [
          {
            type: 'text',
            text: `cdx failed: ${message}`,
          },
        ],
      });
    }
    this.progressBridge = null;
  }

  #normaliseArguments(args) {
    if (!isObject(args)) return args;
    const normalized = { ...args };
    const repoRoot = args.repoRoot ?? args.repo_root ?? args.repo ?? null;
    if (repoRoot) normalized.repoRoot = repoRoot;

    const parallelCandidate =
      normalized.parallelism ?? normalized.concurrency ?? normalized.minParallelism;
    if (parallelCandidate === undefined || parallelCandidate === null) {
      const maxCandidate = normalized.maxParallelism ?? normalized.max_parallelism;
      if (maxCandidate !== undefined && maxCandidate !== null) {
        normalized.parallelism = maxCandidate;
      }
    }

    return normalized;
  }

  #sendResponse(id, result) {
    writeLspMessage(process.stdout, { jsonrpc: '2.0', id, result });
  }

  #sendError(id, code, message) {
    writeLspMessage(process.stdout, {
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message,
      },
    });
  }

  #sendNotification(method, params) {
    writeLspMessage(process.stdout, { jsonrpc: '2.0', method, params });
  }

  #sendProgress(token, progress, message, total) {
    const payload = {
      progress: Math.max(0, Math.min(progress ?? 0, 1)),
      progressToken: token,
    };
    if (typeof message === 'string' && message.trim()) {
      payload.message = message;
    }
    if (Number.isFinite(total)) {
      payload.total = total;
    }
    this.#sendNotification('notifications/progress', payload);
  }

  #handleAppServerNotification(message) {
    if (!message || typeof message !== 'object') return;
    if (message.method === 'notifications/progress') {
      if (!this.progressBridge) return;
      const params = message.params ?? {};
      this.progressBridge({
        progress: params.progress,
        message: params.message,
        total: params.total,
      });
      return;
    }
    this.#sendNotification(message.method, message.params);
  }

  #cdxToolDescriptor() {
    return {
      name: 'cdx',
      title: 'CDX Broker',
      description:
        'Run git preflight checks, then delegate to cdx.spawn on the appserver orchestrator and immediately return control to the caller once the run is handed off.',
      inputSchema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          prompt: {
            type: 'string',
            description: 'High-level instruction for the orchestrator to accomplish.',
          },
          repoRoot: {
            type: 'string',
            description: 'Optional path to the target git repository.',
          },
          parallelism: {
            type: 'integer',
            minimum: 1,
            description: 'Minimum parallelism when delegating to cdx.spawn.',
          },
          maxParallelism: {
            type: 'integer',
            minimum: 1,
            description:
              'Maximum number of Codex sessions to run in parallel (passed to cdx.spawn).',
          },
          range: {
            type: 'string',
            description: 'Optional parallelism range shorthand (e.g. "3-8").',
          },
        },
        required: ['prompt'],
      },
    };
  }
}

const server = new CdxMcpServer();
const reader = new LspMessageReader(process.stdin);
reader.onMessage(message => {
  server.handleMessage(message).catch(err => {
    logDebug('Failed to handle message', err);
  });
});

process.stdin.resume();

const handleExit = () => {
  process.exit(0);
};

process.on('SIGINT', handleExit);
process.on('SIGTERM', handleExit);
process.stdin.on('end', handleExit);
