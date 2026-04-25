#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { homedir, tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { AppServerClient } from '../runtime/app-server-client.js';
import { getConfigValue, loadCodexConfigLayers } from '../runtime/codex-config.js';
import { ContextStore } from '../runtime/context-store.js';
import {
  buildCoordinatorArtifactDelta,
  formatCoordinatorArtifact,
  formatCoordinatorArtifactDelta,
  formatCanonicalCoordinatorEventSummary,
  formatCoordinatorEventEnvelope,
  formatCoordinatorSteer,
  mergeCoordinatorArtifacts,
  normalizeCoordinatorArtifact,
  parseCoordinatorResponse,
} from '../runtime/coordinator-artifact.js';
import { JudgeService } from '../runtime/judge-service.js';
import { HookBackendClient } from '../runtime/hook-backend-client.js';
import { LspMessageReader, writeLspMessage } from '../runtime/lsp.js';
import { deriveRateLimitPressureState } from '../runtime/openai-proxy-client.js';
import { sanitizeRuntimeInjectedTasks } from '../runtime/runtime-injection-policy.js';
import { RouterMcpServer } from '../runtime/router-server.js';
import { CdxStatsServer } from '../runtime/cdx-stats-server.js';
import { detectMergeConflict, summarizeMergeState } from '../runtime/merge-conflict.js';
import {
  abortMerge,
  commitAllowEmpty,
  commitAll,
  createWorktree,
  defaultWorktreeRoot,
  ensureCleanWorktree,
  ensureRepoExcludes,
  getHeadRef,
  getRepoRoot,
  git,
  pruneWorktreeRuns,
  mergeNoEdit,
  removeWorktree,
} from '../runtime/git-worktree.js';
import {
  buildSharedCacheEnv,
  detectLanguages,
  resolveExternalizeConfig,
  resolveSharedCacheEnabled,
  resolveSparseConfig,
  resolveWorktreeRoot,
} from '../runtime/worktree-resources.js';
import {
  collectChecklistClarifications,
  buildChecklistTasks,
  normalizeChecklistConfig,
} from '../runtime/checklist-mode.js';
import { loadPromptTemplate, renderPromptTemplate } from '../runtime/prompt-templates.js';
import {
  didInterventionMakeProgress,
  planWatchdogMergeAskRecovery,
  selectDependencyBlockedActions,
} from '../runtime/watchdog-intervention.js';

const THIS_ENTRY = fileURLToPath(import.meta.url);
const STATS_UI_SERVER_COMMAND = process.env.CDX_STATS_UI_COMMAND ?? process.execPath;
const STATS_UI_SERVER_ENTRY = fileURLToPath(new URL('../runtime/cdx-stats-ui-server.js', import.meta.url));
const STATS_UI_START_TIMEOUT_MS = Number.parseInt(process.env.CDX_STATS_UI_START_TIMEOUT_MS ?? '5000', 10) || 5000;
const STATS_UI_STOP_TIMEOUT_MS = Number.parseInt(process.env.CDX_STATS_UI_STOP_TIMEOUT_MS ?? '2000', 10) || 2000;
const STATS_UI_PROXY_ENABLED = coerceBoolean(process.env.CDX_STATS_UI_PROXY) === true;
const CODEX_HOME = process.env.CODEX_HOME || path.join(homedir(), '.codex');
const RUNTIME_LOG_PATH = path.join(CODEX_HOME, 'log', 'cdx-appserver-runtime.log');
const BACKGROUND_BACKEND_ENABLED = coerceBoolean(process.env.CDX_BACKGROUND_BACKEND_ENABLED) ?? true;
const BACKGROUND_BACKEND_MODE = coerceString(process.env.CDX_RUN_BACKEND_MODE) ?? null;
const IS_BACKGROUND_BACKEND_PROCESS = BACKGROUND_BACKEND_MODE === 'http';
const BACKGROUND_BACKEND_HOST = process.env.CDX_RUN_BACKEND_HOST ?? '127.0.0.1';
const BACKGROUND_BACKEND_PORT = Math.max(
  0,
  Number.parseInt(process.env.CDX_RUN_BACKEND_PORT ?? '0', 10) || 0,
);
const BACKGROUND_BACKEND_START_TIMEOUT_MS = Math.max(
  1_000,
  Number.parseInt(process.env.CDX_RUN_BACKEND_START_TIMEOUT_MS ?? '8000', 10) || 8000,
);
const BACKGROUND_BACKEND_HTTP_TIMEOUT_MS = Math.max(
  1_000,
  Number.parseInt(process.env.CDX_RUN_BACKEND_HTTP_TIMEOUT_MS ?? '120000', 10) || 120000,
);
const BACKGROUND_BACKEND_PROBE_INTERVAL_MS = Math.max(
  50,
  Number.parseInt(process.env.CDX_RUN_BACKEND_PROBE_INTERVAL_MS ?? '150', 10) || 150,
);
const BACKGROUND_BACKEND_REGISTRY_PATH = path.resolve(
  process.env.CDX_RUN_BACKEND_REGISTRY_PATH
  ?? path.join(tmpdir(), `mcp-cdx-run-backend-${process.getuid?.() ?? process.pid}.json`),
);
const RUN_JOURNAL_ENABLED = coerceBoolean(process.env.CDX_RUN_JOURNAL_ENABLED) ?? IS_BACKGROUND_BACKEND_PROCESS;
const RUN_JOURNAL_PATH = path.resolve(
  process.env.CDX_RUN_JOURNAL_PATH
  ?? `${BACKGROUND_BACKEND_REGISTRY_PATH}.runs.json`,
);
const RUN_JOURNAL_VERSION = 1;
const RUN_JOURNAL_WRITE_DEBOUNCE_MS = Math.max(
  25,
  Number.parseInt(process.env.CDX_RUN_JOURNAL_WRITE_DEBOUNCE_MS ?? '250', 10) || 250,
);
const RUN_JOURNAL_MAX_STRING_CHARS = Math.max(
  200,
  Number.parseInt(process.env.CDX_RUN_JOURNAL_MAX_STRING_CHARS ?? '8000', 10) || 8000,
);
const RUN_JOURNAL_MAX_ARRAY_ITEMS = Math.max(
  4,
  Number.parseInt(process.env.CDX_RUN_JOURNAL_MAX_ARRAY_ITEMS ?? '64', 10) || 64,
);
const RUN_JOURNAL_MAX_OBJECT_ENTRIES = Math.max(
  8,
  Number.parseInt(process.env.CDX_RUN_JOURNAL_MAX_OBJECT_ENTRIES ?? '64', 10) || 64,
);
const RUN_JOURNAL_MAX_DEPTH = Math.max(
  2,
  Number.parseInt(process.env.CDX_RUN_JOURNAL_MAX_DEPTH ?? '6', 10) || 6,
);
const JOURNAL_ACTIVE_STATUSES = new Set(['running', 'disposing', 'merging']);
const ORPHANED_RUN_STATUS = 'orphaned';
const ORPHANED_RUN_REASON =
  'Detached backend restarted before the run reached a terminal state.';

const PROTOCOL_VERSION = process.env.MCP_PROTOCOL_VERSION ?? '2025-06-18';
const SERVER_INFO = { name: 'cdx-appserver-orchestrator', version: '0.2.0' };

const TOOL_CALL_MAX_WAIT_MS = Math.max(
  1_000,
  Number.parseInt(process.env.CDX_TOOL_CALL_MAX_WAIT_MS ?? '50000', 10) || 50_000,
);
const CONTROL_RECOMMENDED_STATUS_WAIT_MS = Math.max(
  1_000,
  Number.parseInt(process.env.CDX_CONTROLLER_WAIT_MS ?? '30000', 10) || 30_000,
);
const MAX_RUN_HISTORY = Math.max(
  1,
  Number.parseInt(process.env.CDX_RUN_HISTORY ?? '32', 10) || 32,
);
const VALIDATION_TASK_ENABLED = coerceBoolean(process.env.CDX_VALIDATE_TASK) ?? true;
const VALIDATION_TASK_DEPENDS_ALL =
  coerceBoolean(process.env.CDX_VALIDATE_TASK_DEPENDS_ALL) ?? true;
const DEFAULT_MAX_PARALLELISM = Math.max(
  1,
  Number.parseInt(process.env.CDX_MAX_PARALLELISM ?? '10', 10) || 10,
);
const DEFAULT_MIN_PARALLELISM = Math.max(
  1,
  Number.parseInt(process.env.CDX_MIN_PARALLELISM ?? '3', 10) || 3,
);
const PARALLELISM_RAMP_ENABLED = coerceBoolean(process.env.CDX_PARALLELISM_RAMP) ?? true;
const PARALLELISM_RAMP_STEP = Math.max(
  1,
  Number.parseInt(process.env.CDX_PARALLELISM_RAMP_STEP ?? '1', 10) || 1,
);
const WORKTREE_PRUNE_ENABLED = coerceBoolean(process.env.CDX_WORKTREE_PRUNE) ?? true;
const WORKTREE_PRUNE_EXPIRE = coerceString(process.env.CDX_WORKTREE_PRUNE_EXPIRE);
const WORKTREE_TTL_HOURS = (() => {
  const parsed = Number.parseInt(process.env.CDX_WORKTREE_TTL_HOURS ?? '168', 10);
  return Number.isFinite(parsed) ? parsed : 168;
})();
const LOCAL_MCP_PROBE_TIMEOUT_MS = Math.max(
  100,
  Number.parseInt(process.env.CDX_LOCAL_MCP_PROBE_TIMEOUT_MS ?? '350', 10) || 350,
);
const MAX_TASKS = parseTaskLimit(process.env.CDX_MAX_TASKS, null);
const MAX_TOTAL_TASKS = parseTaskLimit(process.env.CDX_MAX_TOTAL_TASKS, MAX_TASKS);
const PLANNER_MAX_RETRIES = Math.max(
  1,
  Number.parseInt(process.env.CDX_PLANNER_MAX_RETRIES ?? '3', 10) || 3,
);
const PLANNER_TASK_MULTIPLIER = Math.max(
  1,
  Number.parseInt(process.env.CDX_PLANNER_TASK_MULTIPLIER ?? '3', 10) || 3,
);
const PLANNER_MIN_TASKS = Math.max(
  0,
  Number.parseInt(process.env.CDX_PLANNER_MIN_TASKS ?? '0', 10) || 0,
);
const GENERATE_PRD = (process.env.CDX_GENERATE_PRD ?? '0') === '1';

const DEFAULT_TASK_MODEL =
  process.env.CDX_DEFAULT_TASK_MODEL
  ?? process.env.CDX_TASK_MODEL_DEFAULT
  ?? process.env.CDX_TASK_MODEL
  ?? 'gpt-5.4';

const DEFAULT_MODEL_SPECS = [
  { model: DEFAULT_TASK_MODEL, effort: 'medium' },
];

const DEFAULT_MODEL =
  process.env.CDX_DEFAULT_MODEL ?? process.env.CDX_MODEL ?? DEFAULT_MODEL_SPECS[0].model;
const DEFAULT_PLANNER_MODEL =
  process.env.CDX_PLANNER_MODEL_DEFAULT ?? 'gpt-5.4';
const DEFAULT_WATCHDOG_MODEL =
  process.env.CDX_DEFAULT_WATCHDOG_MODEL
  ?? process.env.CDX_WATCHDOG_MODEL_DEFAULT
  ?? process.env.CDX_WATCHDOG_MODEL
  ?? 'gpt-5.4';
const WATCHDOG_STEER_COOLDOWN_MS = Math.max(
  1_000,
  Number.parseInt(process.env.CDX_WATCHDOG_STEER_COOLDOWN_MS ?? '60000', 10) || 60_000,
);
const RUNTIME_INJECTION_ACK_TIMEOUT_MS = Math.max(
  1_000,
  Number.parseInt(process.env.CDX_RUNTIME_INJECTION_ACK_TIMEOUT_MS ?? '15000', 10) || 15_000,
);
const LLM_COORDINATOR_ENABLED = coerceBoolean(process.env.CDX_LLM_COORDINATOR) ?? true;
const COORDINATOR_COMMON_RULES = [
  '- Treat the coordinator artifact as the durable run-level ledger that you own across the full run.',
  '- Promote only durable execution facts, dependency-relevant handoffs, guardrails, verification priorities, and replan triggers.',
  '- Prefer stable execution invariants over per-turn chatter, duplicated status lines, or transient noise.',
  '- Compress repeated failures or stalls into one risk/intervention unless the diagnosis materially changed.',
  '- Preserve the best dependency-aware handoffs first, and drop stale or superseded notes.',
  '- If the runtime proposal is low-signal, discard it instead of copying it into the ledger.',
  '- When extended runtime context is present, use it as higher-fidelity evidence than the compact event envelope and extract only the decisive scheduler facts.',
  '- For explicit planning events such as dynamic-plan, stall-plan, and recovery-plan, prefer actions.injectTasks over steer whenever new work should be created.',
  '- Use actions only when they materially improve the current run: inject concrete tasks, abort wrong-scope work, retry failed work, or respawn stuck running work.',
  '- Prefer steering over actions when a message can fix the situation without mutating the task graph.',
  '- Return the full current artifact, not a patch.',
  '- Use empty string/arrays when a field is not needed.',
].join('\n');
const COORDINATOR_STEER_RULES = [
  '- Emit steer only when it changes what an active worker should do next.',
  '- Only steer active tasks listed in the active-task block.',
  '- Prefer no steer over vague or repetitive steer.',
  '- eventSummary MUST be exactly one line in this format: event=<type>; phase=<phase-or->; wave=<wave-or->; task=<task-or->; ledger=<updated|unchanged>; steer=b<N>/t<N>; note=<short phrase-or->.',
  '- Do not add markdown, bullets, quotes, or extra clauses outside that eventSummary format.',
].join('\n');
const COORDINATOR_RESPONSE_SCHEMA = `{
  "artifact": {
    "goalSummary": "1-2 sentence execution summary",
    "sharedContext": ["Facts workers should keep in mind"],
    "risks": ["Guardrails and failure modes"],
    "verification": ["Checks that matter overall"],
    "replanTriggers": ["Signals that should trigger steer, retry, or replan"],
    "handoffs": [
      {
        "taskId": "task-id",
        "status": "completed",
        "summary": "Useful dependency-aware handoff",
        "files": ["path/to/file"]
      }
    ],
    "interventions": [
      {
        "source": "coordinator",
        "summary": "Structured note about a steering decision",
        "reason": "Why it matters"
      }
    ]
  },
  "steer": {
    "broadcast": ["Optional message to all active tasks"],
    "taskMessages": [
      {
        "taskId": "active-task-id",
        "message": "Concrete next instruction for that task"
      }
    ]
  },
  "actions": {
    "injectTasks": [
      {
        "id": "optional-task-id",
        "description": "Concrete task to inject",
        "dependsOn": ["optional-task-id"],
        "prompt": "Optional richer worker handoff",
        "ownership": {
          "scope": "Single sentence responsibility",
          "paths": ["src/example/*"]
        }
      }
    ],
    "abortTasks": [
      {
        "taskId": "running-task-id",
        "reason": "Why this task should stop now"
      }
    ],
    "retryTasks": [
      {
        "taskId": "failed-task-id",
        "reason": "Why this task should be retried"
      }
    ],
    "respawnTasks": [
      {
        "taskId": "running-task-id",
        "reason": "Why this task should be restarted"
      }
    ]
  },
  "eventSummary": "event=<type>; phase=<phase-or->; wave=<wave-or->; task=<task-or->; ledger=<updated|unchanged>; steer=b<N>/t<N>; note=<short phrase-or->"
}`;

function coerceString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseTaskLimit(value, fallback = null) {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (typeof value === 'string' && value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed <= 0) return null;
  return Math.max(1, parsed);
}

function hasTaskLimit(limit) {
  return Number.isFinite(limit) && limit > 0;
}

function remainingTaskCapacity(limit, currentCount) {
  if (!hasTaskLimit(limit)) return Number.POSITIVE_INFINITY;
  return Math.max(0, limit - currentCount);
}

function taskLimitReached(limit, currentCount) {
  return hasTaskLimit(limit) && currentCount >= limit;
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const v = coerceString(value);
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
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

function resolveDirtyWorktreeCommitMessage() {
  const message = String(process.env.CDX_DIRTY_WORKTREE_COMMIT_MESSAGE ?? '').trim();
  return message || `chore(cdx): auto-commit before run (${new Date().toISOString()})`;
}

function resolveDirtyWorktreeConflictStrategy() {
  return normalizeConflictStrategy(process.env.CDX_DIRTY_WORKTREE_CONFLICT) ?? 'ours';
}

async function selectRepoInitCandidate(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const info = await stat(candidate).catch(() => null);
    if (!info || !info.isDirectory()) continue;
    return candidate;
  }
  return null;
}

async function bootstrapRepo(cwd, { log, preflight } = {}) {
  if (log) log(`No git repository found; initializing one in ${cwd}...`);
  if (preflight) preflight.repoInit = true;
  await git(['init'], { cwd, log });
  const message = resolveRepoInitCommitMessage();
  await ensureInitialCommit({ cwd, message, log });
  if (preflight) {
    const sha = (await git(['rev-parse', '--short', 'HEAD'], { cwd, log }).catch(() => '')).trim();
    preflight.initialCommit = {
      message,
      sha: sha || null,
    };
  }
  return await getRepoRoot(cwd);
}

async function resolveRepoRoot(explicitCwd, sandboxCwd, { log, preflight } = {}) {
  const explicit = coerceString(explicitCwd);
  if (explicit) {
    try {
      return await getRepoRoot(explicit);
    } catch (err) {
      if (repoInitEnabled()) {
        const initCwd = await selectRepoInitCandidate([explicit]);
        if (initCwd) {
          try {
            return await bootstrapRepo(initCwd, { log, preflight });
          } catch (initErr) {
            throw new Error(
              `cdx failed to initialize a git repository in ${initCwd}: ${initErr?.message ?? initErr}`,
              { cause: initErr },
            );
          }
        }
      }
      const initHint = repoInitEnabled()
        ? ''
        : '\nSet CDX_REPO_INIT=1 to bootstrap a repo automatically.';
      throw new Error(
        `cdx must run inside a git repository (repoRoot=${explicit}).${initHint}`,
        { cause: err },
      );
    }
  }

  const candidates = uniqueStrings([
    sandboxCwd,
    process.env.CODEX_PROJECT_ROOT,
    process.env.CODEX_WORKSPACE_ROOT,
    process.cwd(),
    process.env.INIT_CWD,
    process.env.PWD,
  ]);

  let lastError = null;
  for (const cwd of candidates) {
    try {
      return await getRepoRoot(cwd);
    } catch (err) {
      lastError = err;
    }
  }

  if (repoInitEnabled()) {
    const initCwd = await selectRepoInitCandidate(candidates);
    if (initCwd) {
      try {
        return await bootstrapRepo(initCwd, { log, preflight });
      } catch (err) {
        throw new Error(
          `cdx failed to initialize a git repository in ${initCwd}: ${err?.message ?? err}`,
          { cause: err },
        );
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

async function ensureRepoHasHead({ cwd, log, preflight } = {}) {
  const hasHead = await git(['rev-parse', '--verify', 'HEAD'], { cwd, log })
    .then(() => true)
    .catch(() => false);
  if (hasHead) return;

  if (repoInitEnabled()) {
    if (log) log('No commits found; creating an initial commit...');
    const message = resolveRepoInitCommitMessage();
    await ensureInitialCommit({ cwd, message, log });
    if (preflight) {
      const sha = (await git(['rev-parse', '--short', 'HEAD'], { cwd, log }).catch(() => '')).trim();
      preflight.initialCommit = {
        message,
        sha: sha || null,
      };
    }
    return;
  }

  throw new Error(
    `cdx requires at least one commit in ${cwd}.\n`
      + 'Create an initial commit or set CDX_REPO_INIT=1 to bootstrap automatically.',
  );
}

async function ensureInitialCommit({ cwd, message, log } = {}) {
  const committed = await commitAll({ cwd, message, log });
  if (!committed) {
    await commitAllowEmpty({ cwd, message, log, noVerify: true });
  }
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
    if (info) active.push({ ...check, resolved });
  }

  return active;
}

async function ensureNoGitOperationInProgress({ cwd, log, allowMerge = false } = {}) {
  const active = await listGitOperationsInProgress({ cwd, log });
  const filtered = allowMerge ? active.filter(entry => entry.label !== 'merge') : active;
  if (filtered.length === 0) return;
  const hints = filtered.map(entry => `${entry.label}: ${entry.hint}`).join(', ');
  throw new Error(
    `cdx cannot proceed while a git operation is in progress (${hints}).`,
  );
}

async function abortGitOperations({ cwd, log, abortMerge: abortMergeEnabled = false } = {}) {
  const active = await listGitOperationsInProgress({ cwd, log });
  const aborted = [];
  const skipped = [];
  for (const entry of active) {
    if (entry.label === 'merge' && !abortMergeEnabled) {
      skipped.push({ label: entry.label, hint: entry.hint });
      continue;
    }
    if (entry.label === 'merge') {
      await abortMerge({ cwd, log });
    } else {
      await git(entry.abortArgs, { cwd, log });
    }
    aborted.push({ label: entry.label, hint: entry.hint });
  }
  return { aborted, skipped };
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

function shortenCdxBranchLabel(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  let next = raw.replace(/^refs\/heads\//, '');
  next = next.replace(/^cdx\/task\/[^/]+\/([^/]+)/, 'cdx/task/$1');
  next = next.replace(/^cdx\/integration\/[^/]+/, 'cdx/integration');
  return next;
}

function formatMergeLabel(label, branch) {
  const trimmed = String(label ?? '').trim();
  if (trimmed && trimmed !== 'unknown') return trimmed;
  const shortened = shortenCdxBranchLabel(branch);
  return shortened || trimmed || 'unknown';
}

function formatMergeMessage(kind, label, branch) {
  const resolved = formatMergeLabel(label, branch);
  return `Merge ${kind} ${resolved}`;
}

async function logMergeFailureSummary({ cwd, label, log }) {
  if (!cwd) return null;
  const summary = await summarizeMergeState({ cwd }).catch(() => null);
  if (!summary) return null;
  if (typeof log === 'function') {
    const prefix = label ? `Merge state for ${label}` : 'Merge state';
    log(
      `${prefix}: status=${summary.statusSummary} unmerged=${summary.unmergedSummary} mergeHead=${summary.mergeHead}`,
    );
  }
  return summary;
}

function collectMergeConflictPaths(summary) {
  return uniqueList([
    ...(Array.isArray(summary?.unmergedPaths) ? summary.unmergedPaths : []),
    ...(Array.isArray(summary?.statusPaths) ? summary.statusPaths : []),
  ].map(normaliseRepoPath).filter(Boolean));
}

async function readMergeResolution({ cwd } = {}) {
  if (!cwd) return { resolved: false, summary: null };
  const summary = await summarizeMergeState({ cwd }).catch(() => null);
  if (!summary) return { resolved: false, summary: null };
  const resolved =
    summary.statusCount === 0
    && summary.unmergedCount === 0
    && summary.mergeHead === 'none';
  return { resolved, summary };
}

function parseArgs(value) {
  if (!value) return undefined;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // ignore and fall back to whitespace splitting
  }
  return trimmed.split(/\s+/).map(segment => segment.trim()).filter(Boolean);
}

function parseJsonObject(value) {
  if (!value) return null;
  if (isObject(value)) return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseHookItemTypes(value) {
  const defaults = ['commandExecution', 'fileChange', 'mcpToolCall'];
  if (value === undefined || value === null) {
    return new Set(defaults);
  }
  if (typeof value !== 'string') {
    return new Set(defaults);
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === '*' || trimmed.toLowerCase() === 'all') return null;
  const entries = trimmed
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
  return entries.length > 0 ? new Set(entries) : null;
}

function normalizeModelId(value) {
  if (!value || typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

function normalizeReasoningEffort(value) {
  if (!value || typeof value !== 'string') return '';
  return value.trim().toLowerCase();
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

function normalizeSandboxMode(value) {
  if (!value || typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'readonly' || normalized === 'read_only' || normalized === 'read only') {
    return 'read-only';
  }
  if (
    normalized === 'workspace' ||
    normalized === 'workspace_write' ||
    normalized === 'workspace write'
  ) {
    return 'workspace-write';
  }
  if (
    normalized === 'danger' ||
    normalized === 'danger_full_access' ||
    normalized === 'danger full access'
  ) {
    return 'danger-full-access';
  }
  if (['read-only', 'workspace-write', 'danger-full-access'].includes(normalized)) {
    return normalized;
  }
  return null;
}

function normalizeWebSearchMode(value) {
  if (value === undefined || value === null) return null;
  const asBool = coerceBoolean(value);
  if (asBool === true) return 'on';
  if (asBool === false) return 'off';
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (['on', 'enabled', 'enable'].includes(normalized)) return 'on';
  if (['off', 'disabled', 'disable'].includes(normalized)) return 'off';
  if (
    [
      'cached',
      'cache',
      'cache-only',
      'cached-only',
      'cache_only',
      'cached_only',
    ].includes(normalized)
  ) {
    return 'cached';
  }
  return null;
}

function defaultEffortForModel(model) {
  const normalized = normalizeModelId(model);
  for (const spec of DEFAULT_MODEL_SPECS) {
    if (normalizeModelId(spec.model) === normalized) {
      return normalizeReasoningEffort(spec.effort);
    }
  }
  return null;
}

function dedupeModelSpecs(specs) {
  const seen = new Set();
  const deduped = [];
  for (const spec of specs ?? []) {
    const model = typeof spec?.model === 'string' ? spec.model.trim() : '';
    if (!model) continue;
    const key = normalizeModelId(model);
    if (seen.has(key)) continue;
    seen.add(key);
    const effort = typeof spec?.effort === 'string' && spec.effort.trim()
      ? normalizeReasoningEffort(spec.effort)
      : null;
    deduped.push({ model, effort });
  }
  return deduped;
}

function supportedEffortsFromModelListEntry(entry) {
  const supported = new Set();
  const options = entry?.supportedReasoningEfforts;
  if (!Array.isArray(options)) return supported;
  for (const option of options) {
    const effort = option?.reasoningEffort;
    if (typeof effort !== 'string') continue;
    const normalized = normalizeReasoningEffort(effort);
    if (normalized) supported.add(normalized);
  }
  return supported;
}

function pickModelSpecFromModelList(specs, modelListResponse) {
  const data = modelListResponse?.data;
  if (!Array.isArray(data) || data.length === 0) return null;

  const normalizedModels = data.map(entry => ({
    entry,
    id: normalizeModelId(entry?.id),
    model: normalizeModelId(entry?.model),
    supportedEfforts: supportedEffortsFromModelListEntry(entry),
  }));

  for (const spec of specs) {
    const wanted = normalizeModelId(spec.model);
    if (!wanted) continue;
    const match = normalizedModels.find(row => row.model === wanted || row.id === wanted);
    if (!match) continue;

    if (spec.effort) {
      const desired = normalizeReasoningEffort(spec.effort);
      if (!desired) continue;
      if (!match.supportedEfforts.has(desired)) continue;
      return { model: spec.model, effort: desired };
    }

    const defaultEffort = normalizeReasoningEffort(match.entry?.defaultReasoningEffort);
    return { model: spec.model, effort: defaultEffort || null };
  }

  return null;
}

function pickDefaultFromModelList(modelListResponse) {
  const data = modelListResponse?.data;
  if (!Array.isArray(data) || data.length === 0) return null;
  const entry = data.find(model => model?.isDefault) ?? data[0];
  const model = typeof entry?.model === 'string' && entry.model.trim()
    ? entry.model.trim()
    : typeof entry?.id === 'string' && entry.id.trim()
      ? entry.id.trim()
      : null;
  if (!model) return null;
  const effort = normalizeReasoningEffort(entry?.defaultReasoningEffort) || null;
  return { model, effort };
}

function readCodexConfigScalar(key) {
  try {
    const layers = loadCodexConfigLayers({ cwd: process.cwd() });
    const value = getConfigValue(layers.config, key);
    if (typeof value === 'string' && value.trim()) return value.trim();
    return null;
  } catch {
    return null;
  }
}

function extractConfigValue(args, key) {
  if (!Array.isArray(args)) return null;
  for (let i = 0; i < args.length - 1; i += 1) {
    const flag = args[i];
    if ((flag !== '-c' && flag !== '--config') || typeof args[i + 1] !== 'string') continue;
    const raw = args[i + 1].trim();
    if (!raw.startsWith(`${key}=`)) continue;
    const valuePart = raw.slice(key.length + 1).trim();
    const quoted = valuePart.match(/^\"([^\"]+)\"$/);
    return quoted ? quoted[1] : valuePart;
  }
  return null;
}

function stripConfigKey(args, key) {
  if (!Array.isArray(args)) return args;
  const next = [];
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if ((flag === '-c' || flag === '--config') && typeof args[i + 1] === 'string') {
      const raw = args[i + 1].trim();
      if (raw.startsWith(`${key}=`)) {
        i += 1;
        continue;
      }
    }
    next.push(args[i]);
  }
  return next;
}

function escapeConfigString(value) {
  return JSON.stringify(String(value ?? ''));
}

function shouldEmitNumericConfigString(keyPath, value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(trimmed)) return false;
  return /(?:^|\.)(?:port|startup_timeout_sec|timeout_ms|timeout_sec|read_timeout_sec|connect_timeout_sec)$/.test(keyPath);
}

function encodeConfigValue(keyPath, value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (shouldEmitNumericConfigString(keyPath, trimmed)) return trimmed;
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
    return escapeConfigString(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => encodeConfigValue(`${keyPath}[${index}]`, item)).join(', ')}]`;
  }
  return null;
}

function appendConfigPairs(args, prefix, value) {
  if (!Array.isArray(args) || !prefix) return;
  if (value === undefined || value === null) return;

  if (isObject(value)) {
    for (const [key, nested] of Object.entries(value)) {
      if (!key) continue;
      appendConfigPairs(args, `${prefix}.${key}`, nested);
    }
    return;
  }

  const encoded = encodeConfigValue(prefix, value);
  if (!encoded) return;
  args.push('-c', `${prefix}=${encoded}`);
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname ?? '').trim().toLowerCase();
  return normalized === '127.0.0.1'
    || normalized === 'localhost'
    || normalized === '::1'
    || normalized === '[::1]';
}

function parseLoopbackMcpUrl(value) {
  const text = coerceString(value);
  if (!text) return null;
  let target;
  try {
    target = new URL(text);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(target.protocol)) return null;
  if (!isLoopbackHostname(target.hostname)) return null;
  const port = target.port
    ? Number.parseInt(target.port, 10)
    : target.protocol === 'https:'
      ? 443
      : 80;
  if (!Number.isFinite(port) || port <= 0) return null;
  return {
    url: text,
    host: target.hostname,
    port,
  };
}

async function probeTcpEndpoint({ host, port, timeoutMs = LOCAL_MCP_PROBE_TIMEOUT_MS } = {}) {
  if (!host || !Number.isFinite(port) || port <= 0) return false;
  return await new Promise(resolve => {
    let settled = false;
    const socket = net.connect({ host, port });

    const finish = ok => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.once('close', hadError => {
      if (hadError) finish(false);
    });
  });
}

async function pathExists(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') return false;
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function hasPersistedBackgroundRecoveryState({
  registryPath = BACKGROUND_BACKEND_REGISTRY_PATH,
  journalPath = RUN_JOURNAL_PATH,
} = {}) {
  const [hasRegistry, hasJournal] = await Promise.all([
    pathExists(registryPath),
    pathExists(journalPath),
  ]);
  return hasRegistry || hasJournal;
}

function normalizeBackgroundBackendRegistry(value) {
  const candidate = value && typeof value === 'object' ? value : null;
  if (!candidate) return null;
  const host = coerceString(candidate.host);
  const url = coerceString(candidate.url);
  const port = Number.parseInt(candidate.port, 10);
  if (!host || !isLoopbackHostname(host) || !Number.isFinite(port) || port <= 0 || !url) {
    return null;
  }
  return {
    host,
    port,
    url,
    pid: Number.parseInt(candidate.pid, 10) || null,
    startedAt: Number.parseInt(candidate.startedAt, 10) || null,
    registryPath: coerceString(candidate.registryPath) ?? null,
  };
}

async function readBackgroundBackendRegistry(registryPath = BACKGROUND_BACKEND_REGISTRY_PATH) {
  try {
    const raw = await readFile(registryPath, 'utf8');
    const parsed = JSON.parse(raw);
    const normalized = normalizeBackgroundBackendRegistry(parsed);
    if (!normalized) return null;
    return {
      ...normalized,
      registryPath,
    };
  } catch {
    return null;
  }
}

async function writeBackgroundBackendRegistry(registry, registryPath = BACKGROUND_BACKEND_REGISTRY_PATH) {
  const normalized = normalizeBackgroundBackendRegistry(registry);
  if (!normalized) {
    throw new Error('invalid background backend registry');
  }
  const payload = {
    ...normalized,
    registryPath,
  };
  const tempPath = `${registryPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(registryPath), { recursive: true });
  await writeFile(tempPath, JSON.stringify(payload), 'utf8');
  await rename(tempPath, registryPath);
  return payload;
}

async function waitForBackgroundBackendRegistry({
  registryPath = BACKGROUND_BACKEND_REGISTRY_PATH,
  timeoutMs = BACKGROUND_BACKEND_START_TIMEOUT_MS,
  probeTimeoutMs = LOCAL_MCP_PROBE_TIMEOUT_MS,
  pollMs = BACKGROUND_BACKEND_PROBE_INTERVAL_MS,
} = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const registry = await readBackgroundBackendRegistry(registryPath);
    if (registry) {
      const reachable = await probeTcpEndpoint({
        host: registry.host,
        port: registry.port,
        timeoutMs: probeTimeoutMs,
      });
      if (reachable) return registry;
    }
    await new Promise(resolve => {
      const timer = setTimeout(resolve, pollMs);
      timer.unref?.();
    });
  }
  return null;
}

function sanitizeRunJournalValue(
  value,
  {
    depth = 0,
    maxDepth = RUN_JOURNAL_MAX_DEPTH,
    maxArrayItems = RUN_JOURNAL_MAX_ARRAY_ITEMS,
    maxObjectEntries = RUN_JOURNAL_MAX_OBJECT_ENTRIES,
    maxStringChars = RUN_JOURNAL_MAX_STRING_CHARS,
  } = {},
) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return clipText(value, maxStringChars);
  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (Array.isArray(value)) {
    const out = [];
    for (const entry of value) {
      const normalized = sanitizeRunJournalValue(entry, {
        depth: depth + 1,
        maxDepth,
        maxArrayItems,
        maxObjectEntries,
        maxStringChars,
      });
      if (normalized === null || normalized === undefined) continue;
      out.push(normalized);
      if (out.length >= maxArrayItems) break;
    }
    return out;
  }

  if (!isObject(value)) {
    return clipText(String(value ?? ''), maxStringChars) || null;
  }

  if (depth >= maxDepth) {
    return clipText(JSON.stringify(value), maxStringChars) || null;
  }

  const out = {};
  let count = 0;
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = typeof key === 'string' ? key.trim() : '';
    if (!normalizedKey) continue;
    const normalizedValue = sanitizeRunJournalValue(entry, {
      depth: depth + 1,
      maxDepth,
      maxArrayItems,
      maxObjectEntries,
      maxStringChars,
    });
    if (normalizedValue === null || normalizedValue === undefined) continue;
    out[normalizedKey] = normalizedValue;
    count += 1;
    if (count >= maxObjectEntries) break;
  }
  return out;
}

function parseFiniteTimestamp(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizePersistedRunJournalRecord(value) {
  const candidate = isObject(value) ? value : null;
  const runId = coerceString(candidate?.runId);
  if (!runId) return null;

  const status = coerceString(candidate?.status) ?? 'unknown';
  const startedAt = parseFiniteTimestamp(candidate?.startedAt);
  const completedAt = parseFiniteTimestamp(candidate?.completedAt);
  const progressToken = coerceString(candidate?.progressToken, 400);
  const statsUrl = coerceString(candidate?.statsUrl, 4_000);
  const error = typeof candidate?.error === 'string' ? clipText(candidate.error, 4_000) : null;
  const resultSummary =
    typeof candidate?.resultSummary === 'string'
      ? clipText(candidate.resultSummary, 20_000)
      : null;
  const input = sanitizeRunJournalValue(candidate?.input);
  const snapshot = sanitizeRunJournalValue(candidate?.snapshot);
  const orphanedAt = parseFiniteTimestamp(candidate?.orphanedAt);
  const orphanedReason =
    typeof candidate?.orphanedReason === 'string'
      ? clipText(candidate.orphanedReason, 2_000)
      : null;
  const resumedFromRunId = coerceString(
    candidate?.resumedFromRunId
      ?? candidate?.resumed_from_run_id
      ?? candidate?.snapshot?.resumedFromRunId
      ?? candidate?.snapshot?.resumed_from_run_id,
    400,
  );
  const resumedIntoRunId = coerceString(
    candidate?.resumedIntoRunId
      ?? candidate?.resumed_into_run_id
      ?? candidate?.snapshot?.resumedIntoRunId
      ?? candidate?.snapshot?.resumed_into_run_id,
    400,
  );

  return {
    runId,
    status,
    startedAt,
    completedAt,
    progressToken,
    statsUrl,
    error,
    resultSummary,
    input,
    snapshot,
    orphanedAt,
    orphanedReason,
    resumedFromRunId,
    resumedIntoRunId,
  };
}

async function readRunJournal(runJournalPath = RUN_JOURNAL_PATH) {
  try {
    const raw = await readFile(runJournalPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!isObject(parsed)) return null;
    const runs = Array.isArray(parsed.runs)
      ? parsed.runs
        .map(normalizePersistedRunJournalRecord)
        .filter(Boolean)
      : [];
    return {
      version: Number.parseInt(parsed.version, 10) || RUN_JOURNAL_VERSION,
      latestRunId: coerceString(parsed.latestRunId),
      updatedAt: parseFiniteTimestamp(parsed.updatedAt),
      runs,
      runJournalPath,
    };
  } catch {
    return null;
  }
}

async function writeRunJournal(payload, runJournalPath = RUN_JOURNAL_PATH) {
  const runs = Array.isArray(payload?.runs)
    ? payload.runs
      .map(normalizePersistedRunJournalRecord)
      .filter(Boolean)
    : [];
  const normalized = {
    version: RUN_JOURNAL_VERSION,
    latestRunId: coerceString(payload?.latestRunId),
    updatedAt: Date.now(),
    runs,
  };
  const tempPath = `${runJournalPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(runJournalPath), { recursive: true });
  await writeFile(tempPath, JSON.stringify(normalized), 'utf8');
  await rename(tempPath, runJournalPath);
  return {
    ...normalized,
    runJournalPath,
  };
}

async function readHttpJsonRequest(req, { limitBytes = 2 * 1024 * 1024 } = {}) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''));
    size += buffer.length;
    if (size > limitBytes) {
      const error = new Error('request_too_large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('invalid_json');
    error.statusCode = 400;
    throw error;
  }
}

async function fetchBackgroundBackendJson(url, body, { timeoutMs = BACKGROUND_BACKEND_HTTP_TIMEOUT_MS } = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { ok: false, error: { code: response.status, message: text || 'invalid_json_response' } };
  }
  if (!response.ok) {
    const message = coerceString(payload?.error?.message) ?? `background backend request failed (${response.status})`;
    const error = new Error(message);
    error.statusCode = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function supportedReasoningEffortsForModel(model) {
  const normalized = typeof model === 'string' ? model.trim().toLowerCase() : '';
  if (!normalized) return null;
  if (/^gpt-5\.(3|4)\b/.test(normalized)) {
    return new Set(['low', 'medium', 'high', 'xhigh']);
  }
  return null;
}

function mapReasoningEffortToSupported(effort, supported) {
  if (!effort || !(supported instanceof Set)) return null;
  const normalized = String(effort).trim().toLowerCase();
  if (supported.has(normalized)) return normalized;
  if (normalized === 'xhigh') {
    return supported.has('xhigh') ? 'xhigh' : supported.has('high') ? 'high' : null;
  }
  if (normalized === 'minimal') {
    return supported.has('minimal') ? 'minimal' : supported.has('low') ? 'low' : null;
  }
  return supported.has('high') ? 'high' : null;
}

const CODEX_CONFIG_REASONING_EFFORT = readCodexConfigScalar('model_reasoning_effort');
const DEFAULT_TASK_EFFORT =
  normalizeReasoningEffort(process.env.CDX_DEFAULT_TASK_EFFORT ?? 'xhigh') || 'xhigh';
const DEFAULT_PLANNER_EFFORT =
  normalizeReasoningEffort(process.env.CDX_PLANNER_EFFORT ?? 'medium') || 'medium';
const DEFAULT_WATCHDOG_EFFORT =
  normalizeReasoningEffort(process.env.CDX_WATCHDOG_EFFORT ?? 'medium') || 'medium';
const STALL_RECOVERY_EFFORT =
  normalizeReasoningEffort(process.env.CDX_STALL_RECOVERY_EFFORT ?? 'medium') || 'medium';
const STALL_RECOVERY_RETRY_EFFORT =
  normalizeReasoningEffort(process.env.CDX_STALL_RECOVERY_RETRY_EFFORT ?? 'xhigh') || 'xhigh';
const RETRY_EFFORT = 'xhigh';
const REASONING_EFFORT_SEQUENCE = ['low', 'medium', 'high', 'xhigh'];
const TASK_RETRY_EFFORT_SEQUENCE = ['medium', 'high', 'xhigh'];
const RATE_LIMIT_ADAPTIVE = coerceBoolean(process.env.CDX_RATE_LIMIT_ADAPTIVE) ?? true;
const RATE_LIMIT_WINDOW_MS = Math.max(
  5_000,
  Number.parseInt(process.env.CDX_RATE_LIMIT_WINDOW_MS ?? '60000', 10) || 60_000,
);
const RATE_LIMIT_DOWN_THRESHOLD = Math.max(
  1,
  Number.parseInt(process.env.CDX_RATE_LIMIT_DOWN_THRESHOLD ?? '1', 10) || 3,
);
const RATE_LIMIT_DOWN_COOLDOWN_MS = Math.max(
  1_000,
  Number.parseInt(process.env.CDX_RATE_LIMIT_DOWN_COOLDOWN_MS ?? '1000', 10) || 10_000,
);
const RATE_LIMIT_UP_IDLE_MS = Math.max(
  1_000,
  Number.parseInt(process.env.CDX_RATE_LIMIT_UP_IDLE_MS ?? '45000', 10) || 45_000,
);
const RATE_LIMIT_UP_COOLDOWN_MS = Math.max(
  1_000,
  Number.parseInt(process.env.CDX_RATE_LIMIT_UP_COOLDOWN_MS ?? '15000', 10) || 15_000,
);
const RATE_LIMIT_PRESSURE_ELEVATED_SCORE = 0.75;
const RATE_LIMIT_PRESSURE_HIGH_SCORE = 0.9;
const RATE_LIMIT_PRESSURE_CRITICAL_SCORE = 0.98;
const RATE_LIMIT_HEADROOM_HIGH_PERCENT = 10;
const RATE_LIMIT_HEADROOM_ELEVATED_PERCENT = 25;
const RATE_LIMIT_HEADROOM_RECOVERY_PERCENT = 40;
const RATE_LIMIT_STRONG_PRESSURE_MIN_PARALLELISM = 1;
const DEFAULT_SANDBOX = process.env.CDX_SANDBOX ?? 'workspace-write';
const DEFAULT_APPROVAL_POLICY = process.env.CDX_APPROVAL_POLICY ?? 'on-request';
const DEFAULT_APPROVAL_DECISION =
  process.env.CDX_APPROVAL_DECISION ?? 'acceptForSession';
const HOOKS_ENABLED = coerceBoolean(process.env.CDX_HOOKS_ENABLED);
const HOOKS_URL = coerceString(process.env.CDX_HOOKS_URL ?? process.env.CDX_HOOKS_ENDPOINT);
const HOOKS_TIMEOUT_MS = (() => {
  const parsed = Number.parseInt(process.env.CDX_HOOKS_TIMEOUT_MS ?? '2500', 10);
  return Number.isFinite(parsed) ? Math.max(100, parsed) : 2500;
})();
const HOOKS_MAX_RETRIES = (() => {
  const parsed = Number.parseInt(process.env.CDX_HOOKS_MAX_RETRIES ?? '1', 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 1;
})();
const HOOKS_MAX_STRING_CHARS = (() => {
  const parsed = Number.parseInt(process.env.CDX_HOOKS_MAX_STRING_CHARS ?? '8000', 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 8000;
})();
const HOOKS_MODEL = 'gpt-5.4';
const HOOKS_EFFORT = 'low';
const HOOKS_ITEM_TYPES = parseHookItemTypes(process.env.CDX_HOOKS_ITEM_TYPES);
const HOOKS_HEADERS = parseJsonObject(
  process.env.CDX_HOOKS_HEADERS_JSON ?? process.env.CDX_HOOKS_HEADERS,
);

const KEEP_WORKTREES = (process.env.CDX_KEEP_WORKTREES ?? '1') === '1';
const USE_GIT_WORKTREES = coerceBoolean(process.env.CDX_USE_WORKTREES) ?? true;
const OWNERSHIP_HARD_ENFORCE = coerceBoolean(process.env.CDX_OWNERSHIP_HARD_ENFORCE) ?? false;
const STREAM_EVENTS = (process.env.CDX_STREAM_EVENTS ?? '1') === '1';
const EVENT_STREAM = (process.env.CDX_EVENT_STREAM ?? '1') === '1';
const EVENT_STREAM_DELTAS = (process.env.CDX_EVENT_STREAM_DELTAS ?? '1') === '1';
const LOG_AGENT_MESSAGE_DELTAS = coerceBoolean(process.env.CDX_LOG_AGENT_MESSAGE_DELTAS) ?? true;
const STREAM_PLANNER_TOKENS =
  coerceBoolean(process.env.CDX_PLANNER_TOKEN_STREAM) ?? EVENT_STREAM_DELTAS;
const STREAM_PROMPTS = coerceBoolean(process.env.CDX_PROMPT_STREAM) ?? EVENT_STREAM;
const PLANNER_TOKEN_STREAM_FLUSH_CHARS = Math.max(
  64,
  Number.parseInt(process.env.CDX_PLANNER_TOKEN_STREAM_CHARS ?? '200', 10) || 200,
);
const PLANNER_TOKEN_STREAM_FLUSH_MS = Math.max(
  0,
  Number.parseInt(process.env.CDX_PLANNER_TOKEN_STREAM_FLUSH_MS ?? '200', 10) || 200,
);
const DYNAMIC_REPLAN_ENABLED = (process.env.CDX_DYNAMIC_REPLAN ?? '1') === '1';
const SOLO_STRAGGLER_MS = Math.max(
  0,
  Number.parseInt(process.env.CDX_SOLO_STRAGGLER_MS ?? `${5 * 60 * 1000}`, 10) || 5 * 60 * 1000,
);
const DYNAMIC_REPLAN_MAX_WAVES = Math.max(
  0,
  Number.parseInt(process.env.CDX_DYNAMIC_REPLAN_MAX_WAVES ?? '1', 10) || 1,
);
const STALL_REPLAN_ENABLED = (process.env.CDX_STALL_REPLAN ?? '1') === '1';
const STALL_REPLAN_MAX_WAVES = Math.max(
  0,
  Number.parseInt(process.env.CDX_STALL_REPLAN_MAX_WAVES ?? '1', 10) || 1,
);
const DYNAMIC_REPLAN_COOLDOWN_MS = Math.max(
  0,
  Number.parseInt(process.env.CDX_DYNAMIC_REPLAN_COOLDOWN_MS ?? `${SOLO_STRAGGLER_MS}`, 10)
    || SOLO_STRAGGLER_MS,
);
const DYNAMIC_REPLAN_CHECK_INTERVAL_MS = Math.max(
  25,
  Number.parseInt(process.env.CDX_DYNAMIC_REPLAN_CHECK_INTERVAL_MS ?? '1000', 10) || 1000,
);
const DEFAULT_REPO_INDEX_ENABLED = coerceBoolean(process.env.CDX_REPO_INDEX) ?? false;
const DEFAULT_AVOID_OVERLAP_ENABLED = coerceBoolean(process.env.CDX_AVOID_OVERLAP) ?? false;
const DEFAULT_SCOUT_ENABLED = coerceBoolean(process.env.CDX_SCOUT_ENABLED) ?? false;
const SCOUT_MAX_CHARS = Math.max(
  200,
  Number.parseInt(process.env.CDX_SCOUT_MAX_CHARS ?? '2000', 10) || 2000,
);
const TASK_PROMPT_REPO_INDEX = coerceBoolean(process.env.CDX_TASK_PROMPT_REPO_INDEX) ?? true;
const TURN_TIMEOUT_MS = Math.max(
  0,
  Number.parseInt(process.env.CDX_TURN_TIMEOUT_MS ?? `${30 * 60 * 1000}`, 10) || 30 * 60 * 1000,
);
const MERGE_AUTO_RESOLVE = (process.env.CDX_MERGE_AUTO_RESOLVE ?? '1') === '1';
const MERGE_AUTO_RESOLVE_LIMIT = Math.max(
  0,
  Number.parseInt(process.env.CDX_MERGE_AUTO_RESOLVE_LIMIT ?? '5', 10) || 5,
);
const MERGE_RESOLVE_TIMEOUT_MS = Math.max(
  0,
  Number.parseInt(process.env.CDX_MERGE_RESOLVE_TIMEOUT_MS ?? '0', 10) || 0,
);
const INTEGRATION_MERGE_RECOVERY_ENABLED =
  coerceBoolean(process.env.CDX_INTEGRATION_MERGE_RECOVERY) ?? true;
const INTEGRATION_MERGE_RECOVERY_MAX = Math.max(
  0,
  Number.parseInt(process.env.CDX_INTEGRATION_MERGE_RECOVERY_MAX ?? '20', 10) || 20,
);
const INTEGRATION_MERGE_RECOVERY_MAX_ATTEMPTS = Math.max(
  1,
  Number.parseInt(process.env.CDX_INTEGRATION_MERGE_RECOVERY_MAX_ATTEMPTS ?? '3', 10) || 3,
);
const INTEGRATION_MERGE_MANUAL_ENABLED =
  coerceBoolean(process.env.CDX_INTEGRATION_MERGE_MANUAL) ?? true;
const INTEGRATION_MERGE_MANUAL_THRESHOLD = Math.max(
  1,
  Number.parseInt(process.env.CDX_INTEGRATION_MERGE_MANUAL_THRESHOLD ?? '2', 10) || 2,
);
const INTEGRATION_MERGE_MANUAL_STRATEGY =
  normalizeConflictStrategy(process.env.CDX_INTEGRATION_MERGE_MANUAL_STRATEGY) ?? 'theirs';
const INTEGRATION_EMPTY_FAIL =
  coerceBoolean(process.env.CDX_INTEGRATION_EMPTY_FAIL) ?? true;
const INTEGRATION_SALVAGE_ENABLED =
  coerceBoolean(process.env.CDX_INTEGRATION_SALVAGE) ?? true;
const INTEGRATION_NORMALIZE_ENABLED =
  coerceBoolean(process.env.CDX_INTEGRATION_NORMALIZE) ?? true;
const INTEGRATION_SALVAGE_MAX_TASKS = Math.max(
  1,
  Number.parseInt(process.env.CDX_INTEGRATION_SALVAGE_MAX_TASKS ?? '12', 10) || 12,
);
const INTEGRATION_SALVAGE_FILE_SAMPLE = Math.max(
  10,
  Number.parseInt(process.env.CDX_INTEGRATION_SALVAGE_FILE_SAMPLE ?? '80', 10) || 80,
);
const INTEGRATION_LAYOUT_MIN_FILES = Math.max(
  1,
  Number.parseInt(process.env.CDX_INTEGRATION_LAYOUT_MIN_FILES ?? '2', 10) || 2,
);
const SCHEDULER_BACKPRESSURE_ENABLED =
  coerceBoolean(process.env.CDX_SCHEDULER_BACKPRESSURE) ?? true;
const SCHEDULER_BACKPRESSURE_RATE_LIMIT_MS = Math.max(
  0,
  Number.parseInt(process.env.CDX_SCHEDULER_BACKPRESSURE_RATE_LIMIT_MS ?? '30000', 10) || 30_000,
);
const SCHEDULER_BACKPRESSURE_COOLDOWN_MS = Math.max(
  0,
  Number.parseInt(process.env.CDX_SCHEDULER_BACKPRESSURE_COOLDOWN_MS ?? '15000', 10) || 15_000,
);
const SCHEDULER_SNAPSHOT_INTERVAL_MS = Math.max(
  0,
  Number.parseInt(process.env.CDX_SCHEDULER_SNAPSHOT_INTERVAL_MS ?? '5000', 10) || 5_000,
);
const TASK_TIMEOUT_MS = Math.max(
  0,
  Number.parseInt(process.env.CDX_TASK_TIMEOUT_MS ?? `${2 * 60 * 60 * 1000}`, 10)
    || 2 * 60 * 60 * 1000,
);
const TASK_IDLE_WARN_MS = Math.max(
  0,
  Number.parseInt(process.env.CDX_TASK_IDLE_WARN_MS ?? `${20 * 60 * 1000}`, 10)
    || 20 * 60 * 1000,
);
const TASK_IDLE_TIMEOUT_RAW_MS = Math.max(
  0,
  Number.parseInt(process.env.CDX_TASK_IDLE_TIMEOUT_MS ?? `${60 * 60 * 1000}`, 10)
    || 60 * 60 * 1000,
);
const TASK_IDLE_TIMEOUT_MS = TASK_IDLE_TIMEOUT_RAW_MS === 0
  ? 0
  : Math.max(TASK_IDLE_WARN_MS, TASK_IDLE_TIMEOUT_RAW_MS);
const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;
const NO_PROGRESS_TIMEOUT_MS = (() => {
  const parsed = Number.parseInt(process.env.CDX_NO_PROGRESS_TIMEOUT_MS ?? `${5 * 60 * 1000}`, 10);
  if (!Number.isFinite(parsed)) return 5 * 60 * 1000;
  return Math.max(0, parsed);
})();
const WATCHDOG_INTERVENTION_ENABLED = (process.env.CDX_WATCHDOG_INTERVENTION ?? '1') === '1';
const WATCHDOG_INTERVENTION_COOLDOWN_MS = Math.max(
  0,
  Number.parseInt(process.env.CDX_WATCHDOG_INTERVENTION_COOLDOWN_MS ?? `${2 * 60 * 1000}`, 10)
    || 2 * 60 * 1000,
);
const WATCHDOG_INTERVENTION_INTERVAL_MS = Math.max(
  0,
  Number.parseInt(
    process.env.CDX_WATCHDOG_INTERVENTION_INTERVAL_MS ?? `${WATCHDOG_INTERVAL_MS}`,
    10,
  ) || WATCHDOG_INTERVAL_MS,
);
const WATCHDOG_MERGE_TIMEOUT_MS = Math.max(
  0,
  Number.parseInt(
    process.env.CDX_WATCHDOG_MERGE_TIMEOUT_MS ?? `${2 * 60 * 1000}`,
    10,
  ) || 2 * 60 * 1000,
);
const WATCHDOG_MERGE_MAX_RETRIES = Math.max(
  0,
  Number.parseInt(process.env.CDX_WATCHDOG_MERGE_MAX_RETRIES ?? '3', 10) || 0,
);
const WATCHDOG_MERGE_ASK_RECOVERY_ENABLED =
  coerceBoolean(process.env.CDX_WATCHDOG_MERGE_ASK_RECOVERY) ?? true;
const WATCHDOG_MERGE_ASK_MIN_AGE_MS = Math.max(
  0,
  Number.parseInt(process.env.CDX_WATCHDOG_MERGE_ASK_MIN_AGE_MS ?? `${60 * 1000}`, 10)
    || 60 * 1000,
);
const WATCHDOG_MERGE_TAKEOVER_MIN_ASKS = Math.max(
  2,
  Number.parseInt(process.env.CDX_WATCHDOG_MERGE_TAKEOVER_MIN_ASKS ?? '2', 10) || 2,
);
const WATCHDOG_RESPAWN_MAX = Math.max(
  0,
  Number.parseInt(process.env.CDX_WATCHDOG_RESPAWN_MAX ?? '2', 10) || 2,
);
const WATCHDOG_RESPAWN_MAX_PER_WAVE = Math.max(
  1,
  Number.parseInt(process.env.CDX_WATCHDOG_RESPAWN_MAX_PER_WAVE ?? '2', 10) || 2,
);
const WATCHDOG_RESPAWN_COOLDOWN_MS = Math.max(
  0,
  Number.parseInt(process.env.CDX_WATCHDOG_RESPAWN_COOLDOWN_MS ?? `${5 * 60 * 1000}`, 10)
    || 5 * 60 * 1000,
);
const WATCHDOG_RETRY_FAILED_ENABLED = coerceBoolean(process.env.CDX_WATCHDOG_RETRY_FAILED) ?? true;
const WATCHDOG_RETRY_FAILED_MAX = Math.max(
  0,
  Number.parseInt(process.env.CDX_WATCHDOG_RETRY_FAILED_MAX ?? `${WATCHDOG_RESPAWN_MAX}`, 10)
    || WATCHDOG_RESPAWN_MAX,
);
const WATCHDOG_RETRY_FAILED_COOLDOWN_MS = Math.max(
  0,
  Number.parseInt(
    process.env.CDX_WATCHDOG_RETRY_FAILED_COOLDOWN_MS ?? '0',
    10,
  ) || 0,
);
const WATCHDOG_RESPAWN_IDLE_MS = (() => {
  const raw = process.env.CDX_WATCHDOG_RESPAWN_IDLE_MS;
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }
  if (TASK_IDLE_TIMEOUT_MS > 0) {
    return Math.max(TASK_IDLE_WARN_MS, Math.floor(TASK_IDLE_TIMEOUT_MS * 0.5));
  }
  return Math.max(TASK_IDLE_WARN_MS, 30 * 60 * 1000);
})();
const WATCHDOG_RESPAWN_BLOCKED_IDLE_MS = (() => {
  const raw = process.env.CDX_WATCHDOG_RESPAWN_BLOCKED_IDLE_MS;
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }
  if (WATCHDOG_RESPAWN_IDLE_MS <= 0) return 0;
  const progressBase = NO_PROGRESS_TIMEOUT_MS > 0
    ? NO_PROGRESS_TIMEOUT_MS
    : WATCHDOG_INTERVENTION_INTERVAL_MS;
  const derived = Math.max(
    WATCHDOG_INTERVENTION_COOLDOWN_MS,
    WATCHDOG_INTERVENTION_INTERVAL_MS,
    progressBase * 2,
  );
  return Math.min(WATCHDOG_RESPAWN_IDLE_MS, derived);
})();
const WATCHDOG_RESPAWN_FULL_QUEUE_IDLE_MS = (() => {
  const raw = process.env.CDX_WATCHDOG_RESPAWN_FULL_QUEUE_IDLE_MS;
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }
  if (WATCHDOG_RESPAWN_BLOCKED_IDLE_MS <= 0) return 0;
  const progressBase = NO_PROGRESS_TIMEOUT_MS > 0
    ? NO_PROGRESS_TIMEOUT_MS
    : WATCHDOG_INTERVENTION_INTERVAL_MS;
  const derived = Math.max(
    WATCHDOG_INTERVENTION_COOLDOWN_MS,
    WATCHDOG_INTERVENTION_INTERVAL_MS,
    progressBase,
  );
  return Math.min(WATCHDOG_RESPAWN_BLOCKED_IDLE_MS, derived);
})();
const RECOVERY_WAVE_ENABLED = (process.env.CDX_RECOVERY_WAVE ?? '1') === '1';
const RECOVERY_MAX_WAVES = Math.max(
  0,
  Number.parseInt(process.env.CDX_RECOVERY_MAX_WAVES ?? '1', 10) || 1,
);
const DEFAULT_INTEGRATION_VERIFY = (process.env.CDX_INTEGRATION_VERIFY ?? '0') === '1';

const ROUTER_ENABLED = (process.env.CDX_ROUTER_ENABLED ?? '1') === '1';
const ROUTER_HOST = process.env.CDX_ROUTER_HOST ?? '127.0.0.1';
const ROUTER_PATH = process.env.CDX_ROUTER_PATH ?? '/mcp';
const ROUTER_MODE = process.env.CDX_ROUTER_MODE ?? 'judge';
const ROUTER_ASK_TIMEOUT_MS = Math.max(
  0,
  Number.parseInt(process.env.CDX_ROUTER_ASK_TIMEOUT_MS ?? `${5 * 60 * 1000}`, 10)
    || 5 * 60 * 1000,
);
const ROUTER_HYBRID_WAIT_MS = Math.max(
  0,
  Number.parseInt(process.env.CDX_ROUTER_HYBRID_WAIT_MS ?? '30000', 10) || 30_000,
);
const ROUTER_EVENT_CONTEXT_CHARS = Math.max(
  200,
  Number.parseInt(process.env.CDX_ROUTER_EVENT_CONTEXT_CHARS ?? '2500', 10) || 2500,
);
const JUDGE_MAX_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.CDX_JUDGE_MAX_CONCURRENCY ?? '2', 10) || 2,
);
const JUDGE_TIMEOUT_MS = Math.max(
  5_000,
  Number.parseInt(process.env.CDX_JUDGE_TIMEOUT_MS ?? '60000', 10) || 60_000,
);
const TASK_MAX_EXTRA_TURNS = Math.max(
  0,
  Number.parseInt(process.env.CDX_TASK_MAX_EXTRA_TURNS ?? '2', 10) || 2,
);
const AGENT_MESSAGE_QUEUE_LIMIT = Math.max(
  1,
  Number.parseInt(process.env.CDX_AGENT_MESSAGE_QUEUE_LIMIT ?? '50', 10) || 50,
);
const AGENT_MESSAGE_MAX_CHARS = Math.max(
  200,
  Number.parseInt(process.env.CDX_AGENT_MESSAGE_MAX_CHARS ?? '8000', 10) || 8000,
);
const AGENT_MESSAGE_PREVIEW_CHARS = Math.max(
  80,
  Number.parseInt(process.env.CDX_AGENT_MESSAGE_PREVIEW_CHARS ?? '240', 10) || 240,
);

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractHookMessages(payload) {
  const messages = [];
  const push = value => {
    const trimmed = coerceString(value);
    if (trimmed) messages.push(trimmed);
  };

  const steer =
    payload?.steer
    ?? payload?.steerMessage
    ?? payload?.steer_message
    ?? payload?.messageForAgent
    ?? payload?.message_for_agent;

  if (Array.isArray(steer)) {
    steer.forEach(push);
  } else if (isObject(steer)) {
    if (Array.isArray(steer.messages)) {
      steer.messages.forEach(push);
    }
    push(steer.message);
    push(steer.text);
  } else {
    push(steer);
  }

  if (Array.isArray(payload?.messages)) {
    payload.messages.forEach(push);
  }

  return [...new Set(messages)];
}

function extractHookBroadcast(payload) {
  if (isObject(payload?.steer)) {
    const steerBroadcast = coerceBoolean(payload.steer.broadcast);
    if (steerBroadcast === true) return true;
  }
  const broadcast = coerceBoolean(payload?.broadcast);
  return broadcast === true;
}

function extractHookAbort(payload) {
  const abort =
    payload?.abort
    ?? payload?.stop
    ?? payload?.cancel
    ?? payload?.halt;
  if (!abort) return null;
  if (abort === true) return { reason: 'hook requested abort' };
  if (typeof abort === 'string') {
    return { reason: abort.trim() };
  }
  if (isObject(abort)) {
    const reason = coerceString(abort.reason ?? abort.message ?? abort.error);
    return { reason: reason ?? 'hook requested abort' };
  }
  return { reason: 'hook requested abort' };
}

function extractHookRetry(payload) {
  const retry =
    payload?.retry
    ?? payload?.rerun
    ?? payload?.retryTurn
    ?? payload?.retry_turn;
  if (!retry) return null;
  if (retry === true) return { prompt: null, reason: null };
  if (typeof retry === 'string') {
    return { prompt: retry.trim(), reason: null };
  }
  if (isObject(retry)) {
    const prompt = coerceString(
      retry.prompt
        ?? retry.message
        ?? retry.text
        ?? payload?.retryPrompt
        ?? payload?.retry_message,
    );
    const reason = coerceString(
      retry.reason ?? retry.error ?? payload?.retryReason ?? payload?.retry_reason,
    );
    return { prompt, reason };
  }
  return null;
}

function cloneRuntimeTaskInput(task) {
  if (!isObject(task)) return null;
  const cloned = { ...task };

  if (Array.isArray(task.dependsOn)) {
    cloned.dependsOn = task.dependsOn
      .map(dep => (typeof dep === 'string' ? dep.trim() : ''))
      .filter(Boolean);
  }

  if (Array.isArray(task.dependencies)) {
    cloned.dependencies = task.dependencies
      .map(dep => (typeof dep === 'string' ? dep.trim() : ''))
      .filter(Boolean);
  }

  if (isObject(task.ownership)) {
    cloned.ownership = {
      ...task.ownership,
      paths: Array.isArray(task.ownership.paths) ? [...task.ownership.paths] : task.ownership.paths,
    };
  }

  if (task.checklist && isObject(task.checklist)) {
    cloned.checklist = { ...task.checklist };
  }

  return cloned;
}

function extractRuntimeInjectionTasks(payload) {
  const tasks = [];
  const push = value => {
    const cloned = cloneRuntimeTaskInput(value);
    if (cloned) tasks.push(cloned);
  };

  if (Array.isArray(payload?.tasks)) {
    payload.tasks.forEach(push);
  } else {
    push(payload?.tasks);
  }

  if (Array.isArray(payload?.inject)) {
    payload.inject.forEach(push);
  } else {
    push(payload?.inject);
  }

  push(payload?.task);
  push(payload?.injectTask ?? payload?.inject_task);

  return tasks;
}

function normalizeHookActionType(value) {
  const raw = coerceString(value);
  if (!raw) return null;
  const normalized = raw.toLowerCase();
  if (['task_abort', 'abort_task', 'aborttask', 'cancel_task', 'task_cancel'].includes(normalized)) {
    return 'task_abort';
  }
  if (['agent_message', 'message', 'broadcast', 'broadcast_message', 'notify'].includes(normalized)) {
    return 'agent_message';
  }
  return normalized;
}

function normalizeHookActions(payload) {
  const raw = payload?.actions ?? payload?.action ?? payload?.control ?? null;
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.filter(entry => isObject(entry));
  }
  if (isObject(raw)) return [raw];
  return [];
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function normalizeRouterMode(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;

  if (['judge', 'auto', 'automatic'].includes(normalized)) return 'judge';
  if (['supervised', 'supervisor', 'manual'].includes(normalized)) return 'supervised';
  if (['hybrid'].includes(normalized)) return 'hybrid';
  return null;
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

function sleepMs(ms) {
  const duration = Number.parseInt(ms, 10) || 0;
  if (duration <= 0) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(resolve, duration);
    timer.unref?.();
  });
}

function clipText(value, maxChars) {
  const max = Math.max(1, Number.parseInt(maxChars, 10) || 1);
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max)} …`;
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

function parseStatusPath(line) {
  if (!line) return null;
  const raw = String(line).trim();
  if (raw.length < 4) return null;
  const pathPart = raw.slice(3).trim();
  if (!pathPart) return null;
  const arrowIndex = pathPart.lastIndexOf('->');
  if (arrowIndex !== -1) {
    const target = pathPart.slice(arrowIndex + 2).trim();
    return target || null;
  }
  return pathPart;
}

function parseStatusPaths(statusText) {
  const lines = String(statusText ?? '').split(/\r?\n/);
  const paths = [];
  for (const line of lines) {
    const path = parseStatusPath(line);
    if (path) paths.push(path);
  }
  return uniqueList(paths);
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

function normaliseOwnedPathPatterns(patterns) {
  return uniqueList((patterns ?? []).map(normaliseRepoPath).filter(Boolean));
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

function buildSharedWorkspacePlannerLines() {
  if (USE_GIT_WORKTREES) return [];

  const lines = [];
  if (OWNERSHIP_HARD_ENFORCE) {
    lines.push('- Every task MUST include ownership.paths with concrete file or directory patterns.');
    lines.push('- ownership.paths across concurrently runnable tasks MUST be disjoint.');
  } else {
    lines.push('- Prefer ownership.paths for each task to reduce overlap in shared workspace mode.');
    lines.push('- When multiple tasks should run in parallel, keep ownership.paths concrete and disjoint.');
  }
  lines.push('- Avoid broad ownership.paths like src/, test/, docs/, or scripts/ when a narrower subpath will do.');
  return lines;
}

function buildSharedWorkspacePlannerHint() {
  const lines = buildSharedWorkspacePlannerLines();
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

function escapeRegex(text) {
  return String(text ?? '').replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function ownershipGlobToRegex(pattern) {
  const normalized = normaliseRepoPath(pattern);
  if (!normalized) return null;
  if (!hasGlobChars(normalized)) return null;
  let regex = '';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === '*') {
      if (normalized[index + 1] === '*') {
        regex += '.*';
        index += 1;
      } else {
        regex += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      regex += '[^/]';
      continue;
    }
    if (char === '{' || char === '}') {
      regex += '';
      continue;
    }
    regex += escapeRegex(char);
  }
  return new RegExp(`^${regex}$`);
}

function ownershipPathMatches(filePath, pattern) {
  const normalizedPath = normaliseRepoPath(filePath);
  const normalizedPattern = normaliseRepoPath(pattern);
  if (!normalizedPath || !normalizedPattern) return false;

  const globRegex = ownershipGlobToRegex(normalizedPattern);
  if (globRegex) return globRegex.test(normalizedPath);

  if (normalizedPattern.endsWith('/')) {
    return normalizedPath.startsWith(normalizedPattern);
  }
  return normalizedPath === normalizedPattern || normalizedPath.startsWith(`${normalizedPattern}/`);
}

function fileMatchesOwnedPaths(filePath, ownedPaths) {
  const patterns = normaliseOwnedPathPatterns(ownedPaths);
  if (patterns.length === 0) return false;
  return patterns.some(pattern => ownershipPathMatches(filePath, pattern));
}

function ownershipStaticPrefix(pattern) {
  const normalized = normaliseRepoPath(pattern);
  if (!normalized) return '';
  if (!hasGlobChars(normalized)) return normalized.endsWith('/') ? normalized : `${normalized}/`;
  const wildcardIndex = normalized.search(/[*?[\]{}]/);
  if (wildcardIndex <= 0) return '';
  const base = normalized.slice(0, wildcardIndex);
  const slash = base.lastIndexOf('/');
  if (slash === -1) return '';
  return base.slice(0, slash + 1);
}

function ownershipPathsConflict(pathsA, pathsB) {
  const a = normaliseOwnedPathPatterns(pathsA);
  const b = normaliseOwnedPathPatterns(pathsB);
  if (a.length === 0 || b.length === 0) return true;

  for (const patternA of a) {
    for (const patternB of b) {
      if (patternA === patternB) return true;
      const prefixA = ownershipStaticPrefix(patternA);
      const prefixB = ownershipStaticPrefix(patternB);
      if (!prefixA || !prefixB) return true;
      if (prefixA.startsWith(prefixB) || prefixB.startsWith(prefixA)) return true;
    }
  }
  return false;
}

function summarizeTopLevelPaths(paths, limit = 6) {
  const counts = new Map();
  for (const entry of paths ?? []) {
    if (!entry) continue;
    const normalized = String(entry).replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalized) continue;
    const top = normalized.split('/')[0] || normalized;
    counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return String(a[0]).localeCompare(String(b[0]));
  });
  const summary = sorted.slice(0, limit).map(([name, count]) => `${name}(${count})`).join(', ');
  const dominant = sorted.length > 0 ? String(sorted[0][0]) : null;
  const dominantCount = sorted.length > 0 ? Number(sorted[0][1]) : 0;
  return { summary, dominantRoot: dominant, dominantCount, entries: sorted };
}

async function listTaskChangedFiles({ cwd, baseRef, log } = {}) {
  const diffArgs = baseRef ? ['diff', '--name-only', `${baseRef}..HEAD`] : ['diff', '--name-only'];
  const diffOutput = await git(diffArgs, { cwd, log }).catch(() => '');
  const diffFiles = diffOutput.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const statusOutput = await git(['status', '--porcelain'], { cwd, log }).catch(() => '');
  const statusFiles = parseStatusPaths(statusOutput);
  const files = uniqueList([...diffFiles, ...statusFiles]);
  return { files, diffFiles, statusFiles };
}

async function hasDiffBetweenRefs({ cwd, baseRef, headRef = 'HEAD', log } = {}) {
  if (!baseRef) return false;
  const output = await git(['diff', '--name-only', `${baseRef}..${headRef}`], { cwd, log }).catch(() => '');
  return Boolean(String(output ?? '').trim());
}

async function countTrackedFiles({ cwd, log } = {}) {
  if (!cwd) return 0;
  const output = await git(['ls-files'], { cwd, log }).catch(() => '');
  return output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean).length;
}

async function collectTaskLayoutSummaries({ taskStates, tasks, baseRef, fileSampleLimit, log } = {}) {
  const summaries = [];
  const limit = Number.isFinite(fileSampleLimit) ? fileSampleLimit : INTEGRATION_SALVAGE_FILE_SAMPLE;
  const list = Array.isArray(tasks) ? tasks : [];
  for (const task of list) {
    if (!task || !taskStates) continue;
    const state = taskStates.get(task.id);
    if (!state || !state.worktreePath) continue;
    const { files, diffFiles, statusFiles } = await listTaskChangedFiles({
      cwd: state.worktreePath,
      baseRef,
      log,
    });
    const layout = summarizeTopLevelPaths(files);
    const sampleFiles = files.slice(0, Math.max(0, limit));
    summaries.push({
      id: task.id,
      description: task.description ?? null,
      worktreePath: state.worktreePath,
      branch: state.branch ?? null,
      fileCount: files.length,
      diffCount: diffFiles.length,
      uncommittedCount: statusFiles.length,
      topLevels: layout.summary,
      dominantRoot: layout.dominantRoot,
      dominantCount: layout.dominantCount,
      sampleFiles,
      hasChanges: files.length > 0,
    });
  }
  return summaries;
}

function detectLayoutMismatch(summaries, minCount = INTEGRATION_LAYOUT_MIN_FILES) {
  const rootCounts = new Map();
  for (const summary of summaries ?? []) {
    const root = summary?.dominantRoot;
    const count = Number(summary?.dominantCount ?? 0);
    if (!root || count < minCount) continue;
    rootCounts.set(root, (rootCounts.get(root) ?? 0) + 1);
  }
  const roots = [...rootCounts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return String(a[0]).localeCompare(String(b[0]));
  });
  return { mismatch: roots.length > 1, roots };
}

function normalizeBranchName(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const cleaned = trimmed
    .replace(/\s+/g, '-')
    .replace(/[^0-9A-Za-z._/-]+/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/^[-/]+/, '')
    .replace(/[-/]+$/, '');
  return cleaned || null;
}

async function didCompleteWithin(promise, timeoutMs) {
  const waitMs = Number.parseInt(timeoutMs, 10) || 0;
  if (waitMs <= 0) {
    await promise;
    return true;
  }
  const raced = await Promise.race([
    promise.then(() => 'done'),
    sleepMs(waitMs).then(() => 'timeout'),
  ]);
  return raced === 'done';
}

async function waitForRunCompletionOrAsk({ promise, orchestrator, timeoutMs, pollMs } = {}) {
  const waitMs = Number.parseInt(timeoutMs, 10) || 0;
  if (waitMs <= 0) {
    await promise;
    return { type: 'done' };
  }

  const interval = Math.max(25, Math.min(2000, Number.parseInt(pollMs, 10) || 200));
  const deadline = Date.now() + waitMs;
  let stop = false;

  const donePromise = promise.then(() => {
    stop = true;
    return { type: 'done' };
  });

  const askPromise = (async () => {
    while (!stop && Date.now() < deadline) {
      const pending =
        typeof orchestrator?.listPendingRouterAsks === 'function'
          ? orchestrator.listPendingRouterAsks()
          : [];
      if (Array.isArray(pending) && pending.length > 0) {
        stop = true;
        return { type: 'ask', pendingAsks: pending };
      }
      const remaining = deadline - Date.now();
      await sleepMs(Math.min(interval, remaining));
    }
    stop = true;
    return { type: 'timeout' };
  })();

  return await Promise.race([donePromise, askPromise]);
}

function buildRunControllerGuidance({ runId, background = false, hasPendingAsk = false, askId = null } = {}) {
  const safeRunId = typeof runId === 'string' && runId.trim() ? runId.trim() : null;
  const statusArguments = {
    ...(safeRunId ? { runId: safeRunId } : {}),
    waitMs: CONTROL_RECOMMENDED_STATUS_WAIT_MS,
    ...(hasPendingAsk ? { waitFor: 'ask' } : {}),
  };
  const answerArguments = {
    ...(safeRunId ? { runId: safeRunId } : {}),
    ...((typeof askId === 'string' && askId.trim()) ? { askId: askId.trim() } : {}),
  };

  return {
    owner: 'cdx',
    doNotContinueLocally: true,
    returnControlToUser: background === true,
    recommendedStatus: {
      tool: 'cdx.status',
      arguments: statusArguments,
    },
    recommendedAnswer: hasPendingAsk
      ? {
          tool: 'cdx.router_answer',
          arguments: answerArguments,
        }
      : null,
  };
}

function formatRunControllerText({ runId, background = false, hasPendingAsk = false } = {}) {
  const statusParts = [];
  if (typeof runId === 'string' && runId.trim()) statusParts.push(`runId: "${runId.trim()}"`);
  statusParts.push(`waitMs: ${CONTROL_RECOMMENDED_STATUS_WAIT_MS}`);
  if (hasPendingAsk) statusParts.push('waitFor: "ask"');
  const statusHint = `cdx.status { ${statusParts.join(', ')} }`;

  if (hasPendingAsk) {
    return 'CDX owns execution for this run. Do not continue the same task locally in this thread. Answer the pending supervisor question with cdx.router_answer, or monitor with ' + statusHint + '.';
  }
  if (background) {
    return 'CDX owns execution for this run. Do not continue the same task locally in this thread. Return control to the user, or monitor with ' + statusHint + '.';
  }
  return 'CDX still owns execution for this run. Do not continue the same task locally in this thread. Keep supervising with ' + statusHint + ' instead of implementing the task locally.';
}

function buildRunResumeGuidance({ runId, resumedIntoRunId = null } = {}) {
  const safeRunId = typeof runId === 'string' && runId.trim() ? runId.trim() : null;
  const safeResumedIntoRunId =
    typeof resumedIntoRunId === 'string' && resumedIntoRunId.trim() ? resumedIntoRunId.trim() : null;
  const statusRunId = safeResumedIntoRunId ?? safeRunId;
  return {
    resumable: Boolean(safeRunId) && !safeResumedIntoRunId,
    resumedIntoRunId: safeResumedIntoRunId,
    recommendedResume:
      safeRunId && !safeResumedIntoRunId
        ? {
            tool: 'cdx.resume',
            arguments: { runId: safeRunId },
          }
        : null,
    recommendedStatus: statusRunId
      ? {
          tool: 'cdx.status',
          arguments: {
            runId: statusRunId,
            waitMs: CONTROL_RECOMMENDED_STATUS_WAIT_MS,
          },
        }
      : null,
  };
}

function formatRunResumeText({ runId, resumedIntoRunId = null } = {}) {
  const safeRunId = typeof runId === 'string' && runId.trim() ? runId.trim() : null;
  const safeResumedIntoRunId =
    typeof resumedIntoRunId === 'string' && resumedIntoRunId.trim() ? resumedIntoRunId.trim() : null;
  if (safeResumedIntoRunId) {
    return `This orphaned run was already resumed into ${safeResumedIntoRunId}. Inspect it with cdx.status { runId: "${safeResumedIntoRunId}", waitMs: ${CONTROL_RECOMMENDED_STATUS_WAIT_MS} }.`;
  }
  if (!safeRunId) return 'This orphaned run can be resumed with cdx.resume.';
  return `Resume it with cdx.resume { runId: "${safeRunId}" }.`;
}

function extractJsonCandidate(text) {
  if (!text) return null;
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    const candidate = fenced[1].trim();
    if (candidate.startsWith('{') && candidate.endsWith('}')) {
      return candidate;
    }
  }
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }
  const start = trimmed.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  for (let i = start; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return trimmed.slice(start, i + 1);
      }
    }
  }

  const match = trimmed.match(/\{[\s\S]*\}/);
  return match ? match[0] : null;
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

function summarizeTaskOutputForPrompt(text, maxChars = 320) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const cleaned = raw
    .replace(/^work complete:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  return clipText(cleaned, maxChars);
}

function formatChangedFilesForPrompt(files, limit = 6) {
  const list = uniqueList(
    (Array.isArray(files) ? files : [])
      .map(file => normaliseRepoPath(file))
      .filter(Boolean),
  );
  if (list.length === 0) return null;
  const clipped = list.slice(0, limit);
  return clipped.length === list.length
    ? clipped.join(', ')
    : `${clipped.join(', ')}, …`;
}

function buildDependencyContextSection(task, taskStates) {
  const deps = uniqueList(
    (Array.isArray(task?.dependsOn) ? task.dependsOn : [])
      .map(dep => (typeof dep === 'string' ? dep.trim() : ''))
      .filter(Boolean),
  );
  if (deps.length === 0) return '';

  const lines = [];
  for (const depId of deps) {
    const depState = taskStates?.get(depId);
    if (!depState || depState.status !== 'completed') continue;
    const description = clipText(depState.task?.description ?? '', 140) || '(no description)';
    const details = [];
    if (depState.commit) details.push(`commit ${clipText(depState.commit, 16)}`);
    const changedFiles = formatChangedFilesForPrompt(depState.changedFiles, 5);
    if (changedFiles) details.push(`files ${changedFiles}`);
    const summary = summarizeTaskOutputForPrompt(depState.output, 220);
    if (summary) details.push(`summary ${summary}`);
    lines.push(`- ${depId}: ${description}${details.length > 0 ? ` (${details.join('; ')})` : ''}`);
  }

  if (lines.length === 0) return '';
  return `Dependency handoff:\n${lines.join('\n')}`;
}

function buildTaskContextSection({ task, taskStates, coordinatorArtifact, sharedContextSummary }) {
  const sections = [];
  const relevantArtifact = selectTaskRelevantCoordinatorArtifact({
    task,
    coordinatorArtifact,
  });
  const coordinatorBlock = formatCoordinatorArtifact(relevantArtifact, {
    heading: 'Coordinator brief',
    sharedContextSummary,
  });
  if (coordinatorBlock) sections.push(coordinatorBlock);

  const dependencyBlock = buildDependencyContextSection(task, taskStates);
  if (dependencyBlock) sections.push(dependencyBlock);

  return sections.length > 0 ? `\n\n${sections.join('\n\n')}\n` : '';
}

function buildPlannerCoordinationBlock(coordinatorArtifact, sharedContextSummary) {
  const block = formatCoordinatorArtifact(coordinatorArtifact, {
    heading: 'Current coordinator artifact',
    sharedContextSummary,
  });
  return block ? `\n${block}\n` : '';
}

function selectTaskRelevantCoordinatorArtifact({ task, coordinatorArtifact }) {
  const normalized = normalizeCoordinatorArtifact(coordinatorArtifact);
  if (!normalized) return null;

  const dependencyIds = new Set(
    (Array.isArray(task?.dependsOn) ? task.dependsOn : [])
      .map(dep => (typeof dep === 'string' ? dep.trim() : ''))
      .filter(Boolean),
  );

  const dependencyHandoffs = (normalized.handoffs ?? [])
    .filter(entry => dependencyIds.has(entry.taskId))
    .slice(-4);
  const handoffs = dependencyHandoffs.length > 0
    ? dependencyHandoffs
    : (normalized.handoffs ?? []).slice(-2);

  return normalizeCoordinatorArtifact({
    ...normalized,
    sharedContext: (normalized.sharedContext ?? []).slice(-4),
    risks: (normalized.risks ?? []).slice(-4),
    verification: (normalized.verification ?? []).slice(-4),
    replanTriggers: (normalized.replanTriggers ?? []).slice(-4),
    handoffs,
    interventions: (normalized.interventions ?? []).slice(-2),
  });
}

function buildTaskCompletionCoordinatorArtifact(task, state) {
  const files = uniqueList(
    (Array.isArray(state?.changedFiles) ? state.changedFiles : [])
      .map(file => normaliseRepoPath(file))
      .filter(Boolean),
  ).slice(0, 4);
  const summary = summarizeTaskOutputForPrompt(state?.output, 260);
  const handoffSummary = clipText(
    summary ? `${task.description}: ${summary}` : `${task.description} completed`,
    340,
  );
  const sharedContext = [];
  if (files.length > 0) {
    sharedContext.push(`Task ${task.id} completed and changed ${files.join(', ')}.`);
  } else {
    sharedContext.push(`Task ${task.id} completed and its follow-on work may now proceed.`);
  }

  return normalizeCoordinatorArtifact({
    sharedContext,
    handoffs: [
      {
        taskId: task.id,
        status: 'completed',
        summary: handoffSummary,
        files,
      },
    ],
  });
}

function buildTaskFailureCoordinatorArtifact(task, state, status = 'failed') {
  const error = clipText(
    typeof state?.error === 'string' && state.error.trim()
      ? state.error.trim()
      : `${status}`,
    240,
  );

  return normalizeCoordinatorArtifact({
    risks: [`${task.id} ${status}: ${error}`],
    replanTriggers: [`${task.id} ${status}; dependent or overlapping work may need steer, retry, or recovery.`],
    interventions: [
      {
        source: 'task',
        summary: `${task.id} marked ${status}`,
        reason: error,
      },
    ],
  });
}

function buildWatchdogCoordinatorArtifact({ report, wave, reason } = {}) {
  if (!report || typeof report !== 'object') {
    const summary = `Watchdog wave ${wave ?? '?'}`;
    return normalizeCoordinatorArtifact({
      interventions: [
        {
          source: 'watchdog',
          summary,
          reason: reason ?? null,
        },
      ],
    });
  }

  const likelyCauses = Array.isArray(report.likelyCauses) ? report.likelyCauses : [];
  const evidence = Array.isArray(report.evidence) ? report.evidence : [];
  const nextActions = Array.isArray(report.nextActions) ? report.nextActions : [];
  const summary =
    typeof report.summary === 'string' && report.summary.trim()
      ? report.summary.trim()
      : `Watchdog wave ${wave ?? '?'}`;

  return normalizeCoordinatorArtifact({
    sharedContext: evidence,
    risks: likelyCauses,
    interventions: [
      {
        source: 'watchdog',
        summary,
        reason: reason ?? null,
      },
      ...nextActions.map(action => ({
        source: 'watchdog',
        summary: action,
        reason: reason ?? null,
      })),
    ],
  });
}

function summarizeCoordinatorTaskIds(tasks, limit = 8) {
  return uniqueList(
    (Array.isArray(tasks) ? tasks : [])
      .map(task => (typeof task === 'string' ? task : task?.id))
      .filter(Boolean),
  ).slice(0, limit);
}

function buildTaskCompletionCoordinatorEvent(task, state) {
  return {
    summary: `Task ${task.id} completed`,
    details: {
      description: clipText(task.description ?? '', 220) || null,
      changedFiles: uniqueList(
        (Array.isArray(state?.changedFiles) ? state.changedFiles : [])
          .map(file => normaliseRepoPath(file))
          .filter(Boolean),
      ).slice(0, 6),
      outputSummary: summarizeTaskOutputForPrompt(state?.output, 320),
      commit: coerceString(state?.commit),
    },
  };
}

function buildTaskFailureCoordinatorEvent(task, error) {
  return {
    summary: `Task ${task.id} failed`,
    details: {
      description: clipText(task.description ?? '', 220) || null,
      error: clipText(error ?? '', 260) || null,
    },
  };
}

function buildRecoveryPlanCoordinatorEvent({
  wave,
  failedTasks,
  blockedTasks,
  plannedTasks,
  desiredCount,
} = {}) {
  const plannedTaskIds = summarizeCoordinatorTaskIds(plannedTasks, 10);
  return {
    summary: `Recovery plan wave ${wave ?? '?'} produced ${plannedTaskIds.length} task candidate(s)`,
    details: {
      desiredCount: Number.isFinite(desiredCount) ? desiredCount : null,
      failedTaskIds: summarizeCoordinatorTaskIds(failedTasks),
      blockedTaskIds: summarizeCoordinatorTaskIds(blockedTasks),
      plannedTaskIds,
    },
  };
}

function buildDynamicPlanCoordinatorEvent({
  wave,
  stragglerTask,
  plannedTasks,
  desiredCount,
} = {}) {
  const plannedTaskIds = summarizeCoordinatorTaskIds(plannedTasks, 10);
  return {
    summary: `Dynamic assist plan wave ${wave ?? '?'} targeted ${stragglerTask?.id ?? 'unknown-task'}`,
    details: {
      desiredCount: Number.isFinite(desiredCount) ? desiredCount : null,
      stragglerTaskId: coerceString(stragglerTask?.id),
      plannedTaskIds,
    },
  };
}

function buildStallPlanCoordinatorEvent({
  wave,
  pendingTasks,
  plannedTasks,
  desiredCount,
  effort,
} = {}) {
  const plannedTaskIds = summarizeCoordinatorTaskIds(plannedTasks, 10);
  return {
    summary: `Stall plan wave ${wave ?? '?'} produced ${plannedTaskIds.length} task candidate(s)`,
    details: {
      desiredCount: Number.isFinite(desiredCount) ? desiredCount : null,
      effort: coerceString(effort),
      pendingTaskIds: summarizeCoordinatorTaskIds(pendingTasks),
      plannedTaskIds,
    },
  };
}

function buildRuntimeInjectionOutcomeCoordinatorEvent({
  label,
  outcome,
} = {}) {
  const normalized = outcome && typeof outcome === 'object' ? outcome : {};
  const status = coerceString(normalized.status) ?? 'unknown';
  const requestedTaskIds = summarizeCoordinatorTaskIds(normalized.requestedTaskIds, 10);
  const appliedTaskIds = summarizeCoordinatorTaskIds(normalized.taskIds, 10);
  const appliedCount = Array.isArray(normalized.taskIds)
    ? normalized.taskIds.length
    : Math.max(0, Number.parseInt(normalized.taskCount, 10) || 0);
  const prefix =
    typeof label === 'string' && label.trim()
      ? label.trim()
      : 'Runtime injection';

  let statusLabel = status;
  if (status === 'applied') {
    statusLabel = `applied ${appliedCount} task(s)`;
  } else if (status === 'empty') {
    statusLabel = 'applied no tasks';
  } else if (status === 'failed') {
    statusLabel = 'failed to apply';
  } else if (status === 'cancelled') {
    statusLabel = 'was cancelled';
  } else if (status === 'timeout') {
    statusLabel = 'timed out awaiting apply';
  }

  return {
    summary: `${prefix} ${statusLabel}`,
    details: {
      status,
      kind: coerceString(normalized.kind),
      source: coerceString(normalized.source),
      requestedTaskIds,
      appliedTaskIds,
      requestedTaskCount: requestedTaskIds.length,
      taskCount: appliedCount,
      sanitizedPolicyKind: coerceString(normalized.sanitized?.policyKind),
      sanitizedDependencyCount:
        Math.max(0, Number.parseInt(normalized.sanitized?.removedDependencyCount, 10) || 0),
      error: clipText(normalized.error ?? '', 260) || null,
    },
  };
}

function buildRuntimeInjectionOutcomeCoordinatorArtifact({
  label,
  outcome,
} = {}) {
  const normalized = outcome && typeof outcome === 'object' ? outcome : null;
  if (!normalized) return null;

  const status = coerceString(normalized.status) ?? 'unknown';
  const appliedTaskIds = summarizeCoordinatorTaskIds(normalized.taskIds, 10);
  const appliedCount = Array.isArray(normalized.taskIds)
    ? normalized.taskIds.length
    : Math.max(0, Number.parseInt(normalized.taskCount, 10) || 0);
  const prefix =
    typeof label === 'string' && label.trim()
      ? label.trim()
      : 'Runtime injection';

  let reason = null;
  if (status === 'applied') {
    const appliedLabel = appliedTaskIds.length > 0 ? appliedTaskIds.join(', ') : '-';
    reason = `Applied ${appliedCount} task(s): ${appliedLabel}`;
  } else if (status === 'empty') {
    reason = 'Queue drained without applying new tasks';
  } else if (status === 'failed') {
    reason = clipText(normalized.error ?? 'Runtime injection apply failed', 220) || null;
  } else if (status === 'timeout') {
    reason = 'Timed out waiting for runtime injection acknowledgement';
  } else if (status === 'cancelled') {
    reason = 'Run cleaned up before the queued injection was applied';
  }
  if ((normalized.sanitized?.removedDependencyCount ?? 0) > 0) {
    const suffix =
      `Sanitized ${normalized.sanitized.removedDependencyCount} dependency reference(s)` +
      `${normalized.sanitized.policyKind ? ` via ${normalized.sanitized.policyKind}` : ''}.`;
    reason = reason ? `${reason} ${suffix}` : suffix;
  }

  return normalizeCoordinatorArtifact({
    interventions: [
      {
        source: 'coordinator',
        summary: `${prefix} ${status}`,
        reason,
      },
    ],
  });
}

function buildWatchdogCoordinatorEvent({
  report,
  steer,
  wave,
  reason,
} = {}) {
  const normalizedReport = report && typeof report === 'object' ? report : {};
  return {
    summary: `Watchdog wave ${wave ?? '?'} assessed scheduler pressure`,
    details: {
      trigger: clipText(reason ?? '', 220) || null,
      reportSummary: clipText(normalizedReport.summary ?? '', 260) || null,
      likelyCauses: Array.isArray(normalizedReport.likelyCauses)
        ? normalizedReport.likelyCauses.slice(0, 6)
        : [],
      evidence: Array.isArray(normalizedReport.evidence)
        ? normalizedReport.evidence.slice(0, 6)
        : [],
      nextActions: Array.isArray(normalizedReport.nextActions)
        ? normalizedReport.nextActions.slice(0, 6)
        : [],
      steerBroadcastCount: Array.isArray(steer?.broadcast) ? steer.broadcast.length : 0,
      steerTaskIds: Array.isArray(steer?.tasks)
        ? uniqueList(steer.tasks.map(entry => entry?.taskId).filter(Boolean)).slice(0, 6)
        : [],
    },
  };
}

function normaliseOwnedPaths(value, limit = 32) {
  const source = Array.isArray(value) ? value : [value];
  const paths = [];
  const seen = new Set();
  for (const entry of source) {
    if (paths.length >= limit) break;
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    paths.push(trimmed);
  }
  return paths;
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

function normaliseTasks(rawTasks, options = {}) {
  const limit = parseTaskLimit(options.limit, MAX_TASKS);
  const pathLayout = options.pathLayout ?? null;
  const tasks = Array.isArray(rawTasks)
    ? (hasTaskLimit(limit) ? rawTasks.slice(0, limit) : rawTasks.slice())
    : [];
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

  const existingIds = options.existingIds;
  const prefix =
    typeof options.prefix === 'string' && options.prefix.trim().length > 0
      ? options.prefix.trim()
      : null;

  const seen = new Set(
    existingIds instanceof Set
      ? [...existingIds]
      : Array.isArray(existingIds)
        ? existingIds.filter(Boolean).map(String)
        : [],
  );
  const normalised = [];

  for (let index = 0; index < tasks.length; index += 1) {
    const original = tasks[index] ?? {};
    let baseId = typeof original.id === 'string' ? original.id.trim() : '';
    baseId = slugify(baseId, `task-${index + 1}`);
    if (prefix && !baseId.startsWith(prefix)) {
      baseId = `${prefix}${baseId}`;
    }
    let id = baseId;
    let suffix = 1;
    while (seen.has(id)) {
      suffix += 1;
      id = `${baseId}-${suffix}`;
    }
    seen.add(id);

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
      checklist:
        original.checklist && typeof original.checklist === 'object' && !Array.isArray(original.checklist)
          ? { ...original.checklist }
          : null,
    }, pathLayout));
  }

  return normalised;
}

function relaxDependenciesForParallelism(tasks, parallelism) {
  const desired = Number.isFinite(parallelism) ? Math.max(1, parallelism) : 1;
  const ids = new Set((tasks ?? []).map(task => task.id));
  const target = Math.min(desired, Math.max(0, tasks?.length ?? 0));

  const cloned = (tasks ?? []).map(task => ({
    ...task,
    dependsOn: Array.isArray(task.dependsOn) ? [...task.dependsOn] : [],
  }));

  const internalDeps = task =>
    (task.dependsOn ?? []).filter(dep => dep !== task.id && ids.has(dep));

  const isRoot = task => internalDeps(task).length === 0;

  let rootCount = cloned.filter(isRoot).length;
  const changes = [];

  if (target < 2 || rootCount >= target) {
    return { tasks: cloned, changes, target, rootCount };
  }

  const candidates = cloned
    .map(task => ({ task, deps: internalDeps(task) }))
    .filter(entry => entry.deps.length > 0)
    .sort((a, b) => a.deps.length - b.deps.length);

  for (const entry of candidates) {
    if (rootCount >= target) break;
    const { task, deps } = entry;
    task.dependsOn = (task.dependsOn ?? []).filter(dep => !(dep !== task.id && ids.has(dep)));
    if (isRoot(task)) {
      rootCount += 1;
      changes.push({ taskId: task.id, removedDependsOn: deps });
    }
  }

  return { tasks: cloned, changes, target, rootCount };
}

function countRunnableRoots(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const ids = new Set(list.map(task => task?.id).filter(Boolean));
  let rootCount = 0;

  for (const task of list) {
    if (!task || typeof task.id !== 'string') continue;
    const deps = Array.isArray(task.dependsOn)
      ? task.dependsOn.filter(dep => dep !== task.id && ids.has(dep))
      : [];
    if (deps.length === 0) rootCount += 1;
  }

  return rootCount;
}

const DEFAULT_PLANNER_PROMPT_TEMPLATE = loadPromptTemplate(
  'planner',
  `You are an expert project planner coordinating a team of Codex engineers.
Break the given goal into a concise JSON plan using the schema:
{
  "tasks": [
    {
      "id": "task-1",                 // slug style identifier, unique
      "description": "Short phrase",  // what must be delivered
      "dependsOn": ["task-0"],        // ids that must finish first (optional)
      "prompt": "Optional richer instructions for the Codex agent",
      "ownership": {                  // strongly recommended for every task
        "scope": "Single sentence responsibility",
        "paths": ["src/example/*", "test/example.test.js"]
      }
    }
  ],
  "coordination": {
    "goalSummary": "1-2 sentence execution summary",
    "sharedContext": ["Facts every worker should know before editing"],
    "risks": ["Key guardrails or likely failure modes"],
    "verification": ["Checks that matter for the overall run"],
    "replanTriggers": ["Signals that should trigger steer, retry, or replan"]
  }
}
Always include at least one task.{{guidanceBlock}}
Use empty string/arrays when a coordination field is not needed.
Ensure dependencies only reference defined task ids. Return ONLY JSON.`,
);
const DEFAULT_PLANNER_GUIDANCE = loadPromptTemplate(
  'planner-guidance-appserver',
  ' Prefer the smallest set of substantive tasks that preserves useful parallelism.\n'
    + 'Do not create audit-only, scout-only, placeholder, or coordination-only tasks unless the user explicitly asked for analysis or missing context truly blocks implementation.\n'
    + 'If a task can gather the needed context and implement in the same turn, keep that as one task instead of splitting it into an audit phase and a follow-up phase.\n'
    + 'A slow planner or slow task is not a failure signal by itself; optimize for correct task shape over immediate worker saturation.\n'
    + 'Each task should be independently implementable and ideally completable in a few minutes.\n'
    + 'Plan as fast as possible while staying accurate: keep reasoning internal, avoid verbosity, and keep task text short.\n',
);
const PLANNER_ONLY_CONSTRAINT = loadPromptTemplate(
  'planner-only-appserver',
  '- Plan only: do not write code, run commands, or apply file changes.',
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
  'task-tail-appserver',
  'Focus on implementation. Do not output a plan or TODO list unless explicitly requested.\n'
    + 'Work in the current repository workspace. Make code changes as needed. Run any commands required.\n'
    + 'Do not stop at an interim status update. Keep working until the assigned task is actually complete.\n'
    + 'Finish with a short completion note.\n',
);
const TASK_FOLLOW_UP_PROMPT = loadPromptTemplate(
  'task-follow-up-appserver',
  'You ended the previous turn without clearly finishing the assigned task.\n'
    + 'Continue the work immediately instead of giving another status update or TODO list.\n'
    + 'If a supervisor decision is required, call router.ask instead of asking in plain text.\n'
    + 'Only when the assigned work is fully complete, reply with "WORK COMPLETE:" followed by a short summary.\n',
);
const TASK_PRD_PROMPT_TEMPLATE = loadPromptTemplate(
  'task-prd',
  'Goal:\n'
    + '{{goal}}\n\n'
    + 'Task ({{taskId}}): {{taskDescription}}\n\n'
    + 'Write a compact PRD for the assigned task.\n'
    + 'Return markdown with the following headings:\n'
    + '- Overview\n'
    + '- Scope\n'
    + '- Non-Goals\n'
    + '- Deliverables\n'
    + '- Acceptance Criteria\n'
    + '- Touched Files (expected)\n'
    + '- Validation Steps\n'
    + 'Be concrete and testable.\n',
);

function buildPlannerPrompt(goal, customization, hints = {}) {
  const custom = (customization ?? '').trim();
  const parallelism = Number.parseInt(hints.parallelism, 10);
  const minTasks = Number.parseInt(hints.minTasks, 10);
  const maxTasks = Number.parseInt(hints.maxTasks, 10);
  const repoIndex = typeof hints.repoIndex === 'string' ? hints.repoIndex.trim() : '';
  const avoidOverlap = hints.avoidOverlap === true;
  const pathLayout = hints.pathLayout ?? null;

  const constraints = [];
  constraints.push(PLANNER_ONLY_CONSTRAINT);
  if (Number.isFinite(parallelism) && parallelism > 0) {
    constraints.push(`- Execution parallelism is ${parallelism}. Plan for full utilisation.`);
    constraints.push(
      `- Ensure at least ${parallelism} tasks can start immediately (dependsOn: []). Avoid linear dependency chains unless truly required.`,
    );
  }
  if (Number.isFinite(minTasks) && minTasks > 0) {
    constraints.push(`- Aim for at least ${minTasks} tasks by splitting work as finely as possible.`);
  }
  if (Number.isFinite(maxTasks) && maxTasks > 0) {
    constraints.push(`- Do not exceed ${maxTasks} tasks.`);
  }
  constraints.push('- Prefer tasks with minimal overlap to reduce merge conflicts.');
  constraints.push('- Split by files/modules/tests/docs when possible.');
  constraints.push('- Explicitly assign ownership for each task (files/modules/responsibility).');
  constraints.push('- In each task prompt, state ownership boundaries and expected touched paths.');
  constraints.push(...buildPlannerPathLayoutLines(pathLayout));
  constraints.push(...buildSharedWorkspacePlannerLines());
  constraints.push('- Remind workers they are not alone in the codebase; they must avoid unrelated files.');
  constraints.push('- Include a final validation/smoke-test task that runs the project\'s recommended checks.');
  if (avoidOverlap) {
    constraints.push('- Strongly avoid touching the same files across tasks.');
    constraints.push('- Assign each task an explicit file/module focus in its prompt.');
    constraints.push('- When in doubt, merge closely related changes into one task.');
  }
  constraints.push('- Only use dependsOn for real prerequisites (not for "just in case" ordering).');

  const constraintsBlock = constraints.length > 0
    ? `\n\nPlanning constraints:\n${constraints.join('\n')}`
    : '';

  const repoIndexBlock = repoIndex ? `\n\nRepository index:\n${repoIndex}` : '';

  const base = custom || renderPromptTemplate(
    DEFAULT_PLANNER_PROMPT_TEMPLATE,
    { guidanceBlock: DEFAULT_PLANNER_GUIDANCE },
  );
  return `${base}${constraintsBlock}${repoIndexBlock}\n\nGoal:\n${goal}`;
}

function detectValidationTask(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const keywords = [
    'validate',
    'validation',
    'verify',
    'verification',
    'smoke',
    'smoketest',
    'smoke test',
    'test',
    'tests',
    'testing',
    'lint',
    'typecheck',
    'type-check',
    'build',
  ];
  for (const task of list) {
    const haystack = `${task?.id ?? ''} ${task?.description ?? ''} ${task?.prompt ?? ''}`.toLowerCase();
    if (!haystack.trim()) continue;
    if (keywords.some(keyword => haystack.includes(keyword))) return true;
  }
  return false;
}

function buildValidationPrompt(repoRoot) {
  const { hasNode, hasPython, hasRust } = detectLanguages(repoRoot);
  const lines = [
    'Run the project\'s validation commands and a smoke run if documented.',
    '- First read README (or docs) for \"Run\", \"Usage\", \"Test\", \"Lint\", or \"Build\" instructions and execute them.',
  ];
  if (hasNode) {
    lines.push('- Node: run npm test (or pnpm/yarn equivalent) and lint/typecheck/build scripts if defined.');
  }
  if (hasPython) {
    lines.push('- Python: run pytest (or python -m pytest) if tests exist; follow README run command if provided.');
  }
  if (hasRust) {
    lines.push('- Rust: run cargo test and cargo build for a quick sanity check.');
  }
  lines.push('If anything fails, fix issues and rerun until checks pass.');
  lines.push('Keep changes minimal and focused on passing validations.');
  return lines.join('\n');
}

function ensureValidationTask({ tasks, repoRoot, maxTasks, log } = {}) {
  const list = Array.isArray(tasks) ? [...tasks] : [];
  if (!VALIDATION_TASK_ENABLED) return list;
  if (detectValidationTask(list)) return list;
  if (Number.isFinite(maxTasks) && list.length >= maxTasks) {
    log?.(`[planner] skipping validation task (maxTasks=${maxTasks} reached)`);
    return list;
  }

  const existingIds = new Set(list.map(task => task?.id).filter(Boolean));
  let id = 'validate';
  let counter = 1;
  while (existingIds.has(id)) {
    id = `validate-${counter}`;
    counter += 1;
  }

  const dependsOn = (!USE_GIT_WORKTREES || VALIDATION_TASK_DEPENDS_ALL)
    ? [...existingIds]
    : [];

  list.push({
    id,
    description: 'Run validation / smoke test',
    dependsOn,
    prompt: buildValidationPrompt(repoRoot),
    ownership: USE_GIT_WORKTREES
      ? null
      : {
        scope: 'Validation across repository outputs',
        paths: ['**'],
      },
  });

  return list;
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
  if (USE_GIT_WORKTREES) {
    lines.push('- Do not modify files outside your ownership unless absolutely required.');
    lines.push('- If out-of-scope edits are unavoidable, keep them minimal and explain why.');
  } else {
    lines.push('- Shared-workspace mode is active (no git worktrees).');
    if (OWNERSHIP_HARD_ENFORCE) {
      lines.push('- NEVER modify files outside Owned paths; out-of-scope edits are hard-blocked.');
      lines.push('- Do not run git add/commit/rebase/merge; the orchestrator performs owned-file commits.');
    } else {
      lines.push('- Prefer staying within Owned paths; avoid unrelated files when possible.');
      lines.push('- Do not run git add/commit/rebase/merge; the orchestrator handles task finalization.');
    }
  }
  return `${lines.join('\n')}\n`;
}

function resolveTaskOwnedPaths(task) {
  const ownership = normaliseTaskOwnership(task?.ownership);
  return normaliseOwnedPathPatterns(ownership?.paths ?? []);
}

function validateSharedTaskOwnership(task) {
  if (USE_GIT_WORKTREES) return;
  if (!OWNERSHIP_HARD_ENFORCE) return;
  const ownedPaths = resolveTaskOwnedPaths(task);
  if (ownedPaths.length > 0) return;
  const taskId = typeof task?.id === 'string' ? task.id : 'unknown';
  throw new Error(
    `Task ${taskId} is missing ownership.paths. Shared-workspace mode requires explicit file ownership for every task.`,
  );
}

function parseTokenCount(value) {
  const num = Number.parseInt(value, 10);
  if (!Number.isFinite(num) || num < 0) return null;
  return num;
}

function estimateTextTokens(text) {
  const value = String(text ?? '');
  if (!value) return 0;
  const bytes = Buffer.byteLength(value, 'utf8');
  return Math.max(0, Math.ceil(bytes / 4));
}

function pickFirstString(...values) {
  for (const candidate of values) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function pickFirstStringValue(...values) {
  for (const candidate of values) {
    if (typeof candidate !== 'string') continue;
    if (candidate.length > 0) return candidate;
  }
  return null;
}

function normalizeItemType(value) {
  if (!value || typeof value !== 'string') return '';
  return value.trim().toLowerCase().replace(/[-_]/g, '');
}

function normaliseTaskList(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter(row => typeof row?.id === 'string' && row.id.trim())
    .map(row => ({ ...row, id: String(row.id).trim() }));
}

function normalizeTaskStatus(status) {
  return typeof status === 'string' ? status.trim().toLowerCase() : '';
}

function isResolvedTaskStatus(status) {
  const normalized = normalizeTaskStatus(status);
  return (
    normalized === 'completed'
    || normalized === 'failed'
    || normalized === 'blocked'
    || normalized === 'superseded'
  );
}

function isFailureTaskStatus(status) {
  const normalized = normalizeTaskStatus(status);
  return normalized === 'failed' || normalized === 'blocked';
}

function isPlannerPhase(phase, agentId) {
  const phaseValue = typeof phase === 'string' ? phase.toLowerCase() : '';
  if (phaseValue.includes('plan')) return true;
  const agentValue = typeof agentId === 'string' ? agentId.toLowerCase() : '';
  return agentValue.includes('planner');
}

function deriveRunPhase({ status, agents, tasks }) {
  if (status !== 'running') return null;
  const runningAgents = Array.isArray(agents)
    ? agents.filter(agent => agent?.status === 'running')
    : [];
  const plannerAgent = runningAgents.find(agent => isPlannerPhase(agent?.phase, agent?.agentId));
  if (plannerAgent) {
    return coerceString(plannerAgent.phase) ?? 'planner';
  }
  const phaseAgent = runningAgents.find(agent => coerceString(agent?.phase));
  if (phaseAgent) {
    return coerceString(phaseAgent.phase);
  }
  if (Array.isArray(tasks) && tasks.some(task => task?.status === 'running')) {
    return 'task';
  }
  if (Array.isArray(tasks) && tasks.length > 0) {
    return 'queued';
  }
  return 'planning';
}

function isPlannerTokenMethod(method) {
  if (typeof method !== 'string') return false;
  const normalized = method.toLowerCase();
  if (normalized.includes('summarytextdelta')) return true;
  if (normalized.includes('reasoning')) return true;
  if (normalized === 'item/agentmessage/delta') return true;
  if (normalized.includes('output_text_delta')) return true;
  if (normalized.includes('output_text/delta')) return true;
  return false;
}

function extractPlannerDeltaText(params) {
  if (!isObject(params)) return null;

  const direct = pickFirstStringValue(
    params.delta,
    params.text,
    params.content,
    params.content?.text,
    params.summaryTextDelta,
    params.summary_text_delta,
    params.reasoning,
    params.reasoning_delta,
    params.reasoningDelta,
  );
  if (direct !== null) return direct;

  const deltaObj = isObject(params.delta) ? params.delta : null;
  const dataObj = isObject(params.data) ? params.data : null;
  const messageObj = isObject(params.message) ? params.message : null;

  return pickFirstStringValue(
    deltaObj?.text,
    deltaObj?.content,
    deltaObj?.content?.text,
    deltaObj?.summaryTextDelta,
    deltaObj?.summary_text_delta,
    deltaObj?.reasoning,
    deltaObj?.reasoning_delta,
    deltaObj?.reasoningDelta,
    dataObj?.text,
    dataObj?.content,
    dataObj?.content?.text,
    dataObj?.summaryTextDelta,
    dataObj?.summary_text_delta,
    dataObj?.reasoning,
    dataObj?.reasoning_delta,
    dataObj?.reasoningDelta,
    messageObj?.delta,
    messageObj?.content,
    messageObj?.text,
  );
}

function extractItemText(item) {
  if (!isObject(item)) return null;
  const direct = pickFirstStringValue(
    item.text,
    item.formattedText,
    item.formatted_text,
    item.aggregatedOutput,
    item.aggregated_output,
    item.output,
    item.output_text,
    item.outputText,
    item.content,
    item.content?.text,
    item.summary,
    item.summaryText,
    item.summary_text,
    item.reasoning,
    item.data?.text,
    item.data?.content,
    item.data?.content?.text,
  );
  if (direct !== null) return direct;
  const messageObj = isObject(item.message) ? item.message : null;
  return pickFirstStringValue(
    messageObj?.content,
    messageObj?.text,
    messageObj?.delta,
  );
}

function parseFiniteNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseTimestampMs(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  const numeric = parseFiniteNumber(value);
  if (numeric !== null) {
    if (Math.abs(numeric) < 1e11) return Math.trunc(numeric * 1000);
    return Math.trunc(numeric);
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeMethodName(method) {
  return typeof method === 'string' ? method.trim().toLowerCase() : '';
}

function isRateLimitSnapshotMethod(method) {
  const normalized = normalizeMethodName(method);
  return normalized === 'account/ratelimits/updated'
    || normalized === 'account/ratelimit/updated';
}

function refreshRateLimitSignal(signal, now = Date.now()) {
  if (!isObject(signal)) return null;
  const nextResetAt = parseTimestampMs(
    signal.nextResetAt
      ?? signal.nextReset_at
      ?? signal.ratePressure?.nextResetAt
      ?? signal.ratePressure?.nextReset_at
      ?? signal.rateHeadroom?.nextResetAt
      ?? signal.rateHeadroom?.nextReset_at,
  );
  const nextResetInMs = Number.isFinite(nextResetAt) ? Math.max(0, nextResetAt - now) : null;
  const ratePressure = isObject(signal.ratePressure)
    ? {
        ...signal.ratePressure,
        nextResetAt,
        nextResetInMs,
      }
    : signal.ratePressure ?? null;
  const rateHeadroom = isObject(signal.rateHeadroom)
    ? {
        ...signal.rateHeadroom,
        nextResetAt,
        nextResetInMs,
      }
    : signal.rateHeadroom ?? null;

  return {
    ...signal,
    nextResetAt,
    nextResetInMs,
    ratePressure,
    rateHeadroom,
  };
}

function extractRateLimitRetryAt(candidates, now) {
  for (const candidate of candidates) {
    if (!isObject(candidate)) continue;
    const absolute = parseTimestampMs(
      candidate.resetsAt
        ?? candidate.resets_at
        ?? candidate.resetAt
        ?? candidate.reset_at
        ?? candidate.retryAt
        ?? candidate.retry_at,
    );
    if (Number.isFinite(absolute)) return absolute;

    const retryAfterMs = parseFiniteNumber(
      candidate.retryAfterMs
        ?? candidate.retry_after_ms
        ?? candidate.retryAfterMillis
        ?? candidate.retry_after_millis,
    );
    if (retryAfterMs !== null && retryAfterMs >= 0) {
      return now + retryAfterMs;
    }

    const retryAfterSeconds = parseFiniteNumber(
      candidate.retryAfterSeconds
        ?? candidate.retry_after_seconds
        ?? candidate.retryAfterSec
        ?? candidate.retry_after_sec
        ?? candidate.retryAfter,
    );
    if (retryAfterSeconds !== null && retryAfterSeconds >= 0) {
      return now + (retryAfterSeconds * 1000);
    }
  }
  return null;
}

function extractRateLimitFailureState({ method, params }, { now = Date.now() } = {}) {
  if (isRateLimitSnapshotMethod(method)) return null;

  const payload = isObject(params) ? params : null;
  const normalizedMethod = normalizeMethodName(method);
  const candidates = [
    payload,
    payload?.error,
    payload?.data,
    payload?.result,
    payload?.response,
    payload?.response?.error,
    payload?.turn,
    payload?.turn?.error,
    payload?.item,
    payload?.item?.error,
  ].filter(isObject);

  const statusCodes = [];
  const codeValues = [];
  const messages = [];
  const pushStatus = value => {
    const parsed = parseFiniteNumber(value);
    if (parsed === null) return;
    statusCodes.push(Math.trunc(parsed));
  };
  const pushCode = value => {
    if (typeof value === 'string' && value.trim()) {
      codeValues.push(value.trim().toLowerCase());
      return;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      codeValues.push(String(Math.trunc(value)));
    }
  };
  const pushMessage = value => {
    const text = pickFirstString(value);
    if (text) messages.push(text);
  };

  for (const candidate of candidates) {
    pushStatus(
      candidate.statusCode
        ?? candidate.status_code
        ?? candidate.status
        ?? candidate.httpStatus
        ?? candidate.http_status,
    );
    pushCode(
      candidate.code
        ?? candidate.errorCode
        ?? candidate.error_code
        ?? candidate.type
        ?? candidate.reason,
    );
    pushMessage(
      candidate.message
        ?? candidate.error
        ?? candidate.detail
        ?? candidate.details
        ?? candidate.reason,
    );
  }

  const uniqueCodes = [...new Set(codeValues)];
  const uniqueMessages = [...new Set(messages)];
  const status429 = statusCodes.some(status => status === 429);
  const codeRateLimited = uniqueCodes.some(
    code => code.includes('rate_limit') || code.includes('ratelimit') || code === '429',
  );
  const messageRateLimited = uniqueMessages.some(message => {
    const normalized = message.toLowerCase();
    return normalized.includes('rate limit')
      || normalized.includes('ratelimit')
      || normalized.includes('too many requests')
      || normalized.includes('429');
  });
  const methodRateLimited = normalizedMethod.includes('rate_limit')
    || normalizedMethod.includes('ratelimit')
    || normalizedMethod.includes('too_many_requests');

  if (!status429 && !codeRateLimited && !messageRateLimited && !methodRateLimited) {
    return null;
  }

  const nextResetAt = extractRateLimitRetryAt(candidates, now);
  const nextResetInMs = Number.isFinite(nextResetAt) ? Math.max(0, nextResetAt - now) : null;

  return {
    source: 'failure',
    method: typeof method === 'string' ? method : null,
    observedAt: now,
    isRateLimitHit: true,
    ratePressureScore: 1,
    ratePressureLevel: 'critical',
    rateHeadroomPercent: 0,
    exhausted: true,
    shouldThrottle: true,
    statusCode: status429 ? 429 : (statusCodes[0] ?? null),
    errorCode: uniqueCodes[0] ?? null,
    errorMessage: uniqueMessages[0] ?? null,
    nextResetAt,
    nextResetInMs,
    ratePressure: {
      score: 1,
      level: 'critical',
      exhausted: true,
      shouldThrottle: true,
      nextResetAt,
      nextResetInMs,
    },
    rateHeadroom: {
      percent: 0,
      fraction: 0,
      nextResetAt,
      nextResetInMs,
    },
  };
}

function isTurnTimeoutError(err) {
  const message = err instanceof Error ? err.message : String(err ?? '');
  if (!message) return false;
  const normalized = message.toLowerCase();
  return normalized.includes('timed out waiting for turn completion')
    || normalized.includes('turn timeout')
    || normalized.includes('app-server exited before turn completion');
}

function extractTokenUsageFromTurnCompleted(params) {
  if (!isObject(params)) return null;
  const turn = isObject(params.turn) ? params.turn : null;

  const candidates = [
    params.usage,
    turn?.usage,
    turn?.tokenUsage,
    turn?.metrics?.usage,
    turn?.metrics,
    turn,
  ].filter(isObject);

  for (const usage of candidates) {
    const inputTokens = parseTokenCount(
      usage.input_tokens ??
        usage.inputTokens ??
        usage.prompt_tokens ??
        usage.promptTokens ??
        usage.promptTokensTotal,
    );
    const outputTokens = parseTokenCount(
      usage.output_tokens ??
        usage.outputTokens ??
        usage.completion_tokens ??
        usage.completionTokens,
    );

    const cachedTokens = parseTokenCount(
      usage.cached_input_tokens ??
        usage.cachedInputTokens ??
        usage.cached_tokens ??
        usage.cachedTokens ??
        usage.input_tokens_details?.cached_tokens ??
        usage.inputTokensDetails?.cachedTokens ??
        usage.prompt_tokens_details?.cached_tokens ??
        usage.promptTokensDetails?.cachedTokens,
    );

    if (inputTokens === null && outputTokens === null && cachedTokens === null) continue;

    return {
      inputTokens: inputTokens ?? 0,
      cachedInputTokens: cachedTokens ?? 0,
      outputTokens: outputTokens ?? 0,
    };
  }

  return null;
}

function extractModelFromTurnCompleted(params) {
  if (!isObject(params)) return null;
  const turn = isObject(params.turn) ? params.turn : null;
  return pickFirstString(
    turn?.model,
    turn?.modelId,
    turn?.model_id,
    params.model,
    params.modelId,
    params.model_id,
    turn?.response?.model,
  );
}

class TurnCollector {
  constructor({ threadId, turnId, onEvent }) {
    this.threadId = threadId;
    this.turnId = turnId;
    this.onEvent = onEvent ?? (() => {});
    this.agentBuffers = new Map(); // itemId -> text
    this.agentMessages = [];
    this.hadAgentMessageDelta = false;
    this.reviewText = null;
    this.items = [];
    this.events = [];
    this.completed = false;
    this.status = null;
    this.error = null;
  }

  handleNotification(message) {
    const { method, params } = message;
    if (!method || !params) return;
    if (params.threadId !== this.threadId) return;
    const eventTurnId = params.turnId ?? params.turn?.id;
    if (eventTurnId !== this.turnId) return;

    this.onEvent({ method, params });

    const normalizedMethod = String(method ?? '').toLowerCase();

    if (
      normalizedMethod === 'item/agentmessage/delta'
      || normalizedMethod.includes('agent_message_delta')
      || normalizedMethod.includes('agent_message_content_delta')
    ) {
      const itemId = params.itemId;
      const delta = params.delta ?? '';
      if (!itemId) return;
      this.hadAgentMessageDelta = true;
      const previous = this.agentBuffers.get(itemId) ?? '';
      this.agentBuffers.set(itemId, previous + delta);
      return;
    }

    if (method === 'item/started' || method === 'item/completed') {
      const item = params.item;
      if (item && typeof item === 'object') {
        const entry = {
          method,
          type: item.type,
          id: item.id,
        };
        if (item.type === 'commandExecution') {
          entry.command = item.command;
          entry.status = item.status;
          entry.exitCode = item.exitCode ?? null;
        } else if (item.type === 'fileChange') {
          entry.files = Array.isArray(item.changes)
            ? item.changes.map(change => change.path).filter(Boolean)
            : [];
          entry.status = item.status;
        } else if (item.type === 'mcpToolCall') {
          entry.server = item.server;
          entry.tool = item.tool;
          entry.status = item.status;
        }
        this.events.push(entry);
      }
    }

    if (method === 'item/completed') {
      const item = params.item;
      if (item) {
        this.items.push(item);
        if (item.type === 'agentMessage' && typeof item.text === 'string') {
          this.agentMessages.push(item.text);
        }
        if (item.type === 'exitedReviewMode' && typeof item.review === 'string') {
          this.reviewText = item.review;
        }
      }
      return;
    }

    if (method === 'turn/completed') {
      const turn = params.turn;
      this.completed = true;
      this.status = turn?.status ?? null;
      this.error = turn?.error?.message ?? null;
      this.events.push({
        method,
        status: turn?.status ?? null,
      });
    }
  }

  finalTextInfo() {
    if (this.agentMessages.length > 0) {
      return {
        text: this.agentMessages.at(-1),
        source: 'agent_message',
        hadAgentMessageDelta: this.hadAgentMessageDelta,
      };
    }
    if (typeof this.reviewText === 'string' && this.reviewText.trim()) {
      return {
        text: this.reviewText,
        source: 'review',
        hadAgentMessageDelta: this.hadAgentMessageDelta,
      };
    }
    const buffers = [...this.agentBuffers.values()].filter(Boolean);
    return {
      text: buffers.length > 0 ? buffers.join('\n') : '',
      source: buffers.length > 0 ? 'agent_delta' : null,
      hadAgentMessageDelta: this.hadAgentMessageDelta,
    };
  }

  finalText() {
    return this.finalTextInfo().text;
  }
}

class TaskState {
  constructor(task, { branch, worktreePath }) {
    this.task = task;
    this.branch = branch;
    this.worktreePath = worktreePath;
    this.status = 'pending';
    this.startedAt = null;
    this.finishedAt = null;
    this.output = null;
    this.error = null;
    this.prd = null;
    this.threadId = null;
    this.turnId = null;
    this.commit = null;
    this.changedFiles = [];
    this.events = null;
    this.lastActivityAt = null;
    this.lastActivity = null;
    this.lastActivityMeta = null;
    this.idleWarnedAt = null;
    this.abortReason = null;
    this.abortRequestedAt = null;
    this.abortAction = null;
    this.respawnAttempts = 0;
    this.lastRespawnAt = null;
    this.mergeRecoveryAttempts = 0;
    this.lastMergeRecoveryAt = null;
    this.mergeConflictSinceAt = null;
    this.lastMergeConflictCheckAt = 0;
    this.lastMergeConflictSummary = null;
    this.mergeWatchdogRequestedAt = null;
    this.client = null;
    this.effortOverride = null;
    this.lastEffortBumpAt = null;
    this.retryAttempts = 0;
    this.lastRetryAt = null;
    this.supersededAt = null;
    this.supersededByTaskIds = [];
    this.supersededFromStatus = null;
    this.supersededWave = null;
  }

  start() {
    this.clearMergeConflictState();
    this.clearSupersededState();
    this.status = 'running';
    this.startedAt = Date.now();
    this.lastActivityAt = this.startedAt;
    this.lastActivity = 'started';
    this.lastActivityMeta = { method: 'task/start' };
    this.idleWarnedAt = null;
    this.abortReason = null;
    this.abortRequestedAt = null;
    this.abortAction = null;
  }

  complete({ output, prd, threadId, turnId, commit, changedFiles, events }) {
    this.clearMergeConflictState();
    this.clearSupersededState();
    this.status = 'completed';
    this.finishedAt = Date.now();
    this.output = output ?? null;
    this.prd = prd ?? null;
    this.threadId = threadId ?? null;
    this.turnId = turnId ?? null;
    this.commit = commit ?? null;
    this.changedFiles = Array.isArray(changedFiles) ? [...changedFiles] : [];
    this.events = events ?? null;
    this.lastActivityAt = this.finishedAt;
    this.lastActivity = 'completed';
    this.abortReason = null;
    this.abortRequestedAt = null;
    this.abortAction = null;
    this.client = null;
  }

  fail(err) {
    this.clearMergeConflictState();
    this.clearSupersededState();
    this.status = 'failed';
    this.finishedAt = Date.now();
    this.error = err instanceof Error ? err.message : String(err ?? 'unknown error');
    this.lastActivityAt = this.finishedAt;
    this.lastActivity = this.error ? `failed: ${this.error}` : 'failed';
    this.abortAction = null;
    this.client = null;
  }

  block(reason) {
    this.clearMergeConflictState();
    this.clearSupersededState();
    this.status = 'blocked';
    this.finishedAt = Date.now();
    this.error = typeof reason === 'string' ? reason : String(reason ?? 'blocked');
    this.lastActivityAt = this.finishedAt;
    this.lastActivity = this.error ? `blocked: ${this.error}` : 'blocked';
    this.abortAction = null;
    this.client = null;
  }

  recordActivity(activity, meta = null) {
    const now = Date.now();
    this.lastActivityAt = now;
    if (activity) {
      this.lastActivity = activity;
    }
    this.lastActivityMeta = meta && typeof meta === 'object' ? { ...meta } : null;
  }

  attachClient(client) {
    this.client = client ?? null;
  }

  clearClient() {
    this.client = null;
  }

  clearMergeConflictState({ preserveCheckAt = false } = {}) {
    this.mergeConflictSinceAt = null;
    if (!preserveCheckAt) this.lastMergeConflictCheckAt = 0;
    this.lastMergeConflictSummary = null;
    this.mergeWatchdogRequestedAt = null;
  }

  clearSupersededState() {
    this.supersededAt = null;
    this.supersededByTaskIds = [];
    this.supersededFromStatus = null;
    this.supersededWave = null;
  }

  requestAbort(reason) {
    if (this.abortRequestedAt) return false;
    this.abortReason = typeof reason === 'string' && reason.trim() ? reason.trim() : 'aborted';
    this.abortRequestedAt = Date.now();
    if (this.client && typeof this.client.dispose === 'function') {
      this.client.dispose(`task-abort:${this.abortReason}`);
    }
    return true;
  }

  requestRespawn(reason) {
    if (this.abortRequestedAt) return false;
    this.abortAction = 'respawn';
    const ok = this.requestAbort(reason);
    if (ok) this.bumpEffortOverride();
    return ok;
  }

  resetForRespawn({ reason } = {}) {
    this.clearSupersededState();
    this.status = 'pending';
    this.startedAt = null;
    this.finishedAt = null;
    this.output = null;
    this.error = null;
    this.prd = null;
    this.threadId = null;
    this.turnId = null;
    this.commit = null;
    this.changedFiles = [];
    this.events = null;
    this.lastActivityAt = Date.now();
    this.lastActivity = reason ? `respawn: ${reason}` : 'respawn';
    this.lastActivityMeta = { method: 'task/respawn' };
    this.idleWarnedAt = null;
    this.abortReason = null;
    this.abortRequestedAt = null;
    this.abortAction = null;
    this.client = null;
  }

  resetForRetry({ reason, source } = {}) {
    this.clearMergeConflictState();
    this.clearSupersededState();
    this.status = 'pending';
    this.startedAt = null;
    this.finishedAt = null;
    this.output = null;
    this.error = null;
    this.prd = null;
    this.threadId = null;
    this.turnId = null;
    this.commit = null;
    this.events = null;
    this.lastActivityAt = Date.now();
    this.lastActivity = reason ? `retry: ${reason}` : 'retry';
    this.lastActivityMeta = {
      method: 'task/retry',
      source: source ?? null,
    };
    this.idleWarnedAt = null;
    this.abortReason = null;
    this.abortRequestedAt = null;
    this.abortAction = null;
    this.client = null;
  }

  supersede({ reason, replacementTaskIds, wave } = {}) {
    this.clearMergeConflictState();
    const previousStatus = this.status;
    const now = Date.now();
    this.status = 'superseded';
    this.finishedAt = now;
    this.supersededAt = now;
    this.supersededByTaskIds = uniqueList(
      (Array.isArray(replacementTaskIds) ? replacementTaskIds : [])
        .map(value => String(value ?? '').trim())
        .filter(Boolean),
    );
    this.supersededFromStatus = normalizeTaskStatus(previousStatus) || null;
    this.supersededWave = Number.isFinite(wave) ? wave : null;
    this.error = typeof reason === 'string' && reason.trim()
      ? reason.trim()
      : 'superseded by recovery task';
    this.lastActivityAt = now;
    this.lastActivity = this.error ? `superseded: ${this.error}` : 'superseded';
    this.lastActivityMeta = {
      method: 'task/superseded',
      replacementTaskIds: [...this.supersededByTaskIds],
      wave: this.supersededWave,
      fromStatus: this.supersededFromStatus,
    };
    this.abortReason = null;
    this.abortRequestedAt = null;
    this.abortAction = null;
    this.client = null;
  }

  durationMs() {
    if (!this.startedAt) return null;
    const end = this.finishedAt ?? Date.now();
    return end - this.startedAt;
  }

  bumpEffortOverride() {
    const current = normalizeReasoningEffort(this.effortOverride) || DEFAULT_TASK_EFFORT;
    const idx = TASK_RETRY_EFFORT_SEQUENCE.indexOf(current);
    const next =
      idx >= 0
        ? TASK_RETRY_EFFORT_SEQUENCE[Math.min(idx + 1, TASK_RETRY_EFFORT_SEQUENCE.length - 1)]
        : TASK_RETRY_EFFORT_SEQUENCE[0];
    if (!next || next === current) return false;
    this.effortOverride = next;
    this.lastEffortBumpAt = Date.now();
    return true;
  }
}

class AppServerCdxOrchestrator {
  constructor({ sendLog, sendProgress, sendEvent, sandboxCwd } = {}) {
    this.sendLog = sendLog ?? (() => {});
    this.sendProgress = sendProgress ?? (() => {});
    this.sendEvent = sendEvent ?? (() => {});

    this.activeRunId = null;
    this.activeRepoRoot = null;
    this.sandboxCwd = coerceString(sandboxCwd);
    this.dangerSandboxClamped = false;
    this.activeGoal = null;
    this.activeEmitEvent = null;
    this.activeModel = null;
    this.activeEffort = null;
    this.modelOverride = null;
    this.plannerModelOverride = null;
    this.taskModelOverride = null;
    this.watchdogModelOverride = null;
    this.effortOverride = null;
    this.plannerEffortOverride = null;
    this.taskEffortOverride = null;
    this.judgeEffortOverride = null;
    this.watchdogEffortOverride = null;
    this.sandboxOverride = null;
    this.webSearchModeOverride = null;
    this.analyticsEnabledOverride = null;
    this.codexConfig = null;
    this.codexConfigMeta = null;
    this.execJustification = null;
    this.workerClientArgsTemplate = null;
    this.repoIndex = null;
    this.repoIndexEnabled = false;
    this.avoidOverlapEnabled = false;
    this.scoutEnabled = false;
    this.sharedContextSummary = null;
    this.coordinatorArtifact = null;
    this.lastCoordinatorBroadcast = null;
    this.coordinatorClient = null;
    this.coordinatorCollectors = null;
    this.coordinatorDetach = null;
    this.coordinatorThreadId = null;
    this.activeRuntimeCoordinatorControl = null;
    this.coordinatorUpdateQueue = Promise.resolve();
    this.coordinatorEventSeq = 0;
    this.watchdogSteerHistory = new Map();
    this.includeRepoIndexInTaskPrompt = TASK_PROMPT_REPO_INDEX;
    this.contextStore = null;
    this.lastTaskActivityAt = null;
    this.lastTurnCompletedAt = null;
    this.turnCounter = 0;
    this.threadToTask = new Map(); // threadId -> taskId
    this.taskStates = null; // Map(taskId -> TaskState)
    this.agentMessageDeltaBuffers = new Map(); // bufferKey -> text
    this.judgeService = null;
    this.router = null;
    this.routerUrl = null;
    this.worktreeSparseConfig = null;
    this.taskPathLayout = null;
    this.worktreeExternalizeConfig = null;
    this.sharedCacheEnabled = null;
    this.routerMode = normalizeRouterMode(ROUTER_MODE) ?? 'judge';
    this.routerAskTimeoutMs = ROUTER_ASK_TIMEOUT_MS;
    this.routerHybridWaitMs = ROUTER_HYBRID_WAIT_MS;
    this.routerAsks = new Map(); // askId -> record
    this.routerAskWaiters = new Map(); // askId -> deferred
    this.supervisorMessages = new Map(); // taskId -> [{id, text, createdAt, source}]
    this.broadcastMessages = []; // [{id, text, createdAt, source}]
    this.broadcastCursors = new Map(); // taskId -> next broadcast index
    this.runtimeInjectionQueue = [];
    this.runtimeInjectionAcks = new Map();
    this.runtimeInjectionResults = new Map();
    this.runtimeInjectionSignalVersion = 0;
    this.runtimeInjectionSignal = createDeferred();
    this.sharedRepoGitLock = Promise.resolve();
    this.rateLimitEvents = [];
    this.rateLimitLastAt = 0;
    this.rateLimitSnapshot = null;
    this.rateLimitFailure = null;

    const hooksEnabled = HOOKS_ENABLED === false ? false : Boolean(HOOKS_URL);
    this.hookClient = hooksEnabled
      ? new HookBackendClient({
          url: HOOKS_URL,
          timeoutMs: HOOKS_TIMEOUT_MS,
          maxStringChars: HOOKS_MAX_STRING_CHARS,
          headers: HOOKS_HEADERS ?? undefined,
          log: (...args) => this.sendLog(`[hook] ${args.join(' ')}`),
        })
      : null;
    this.hookMaxRetries = HOOKS_MAX_RETRIES;
    this.hookItemTypes = HOOKS_ITEM_TYPES;
    this.hookItemQueue = Promise.resolve();
  }

  #wakeRuntimeInjectionScheduler(reason = 'runtime-injection') {
    this.runtimeInjectionSignalVersion += 1;
    const signal = this.runtimeInjectionSignal;
    this.runtimeInjectionSignal = createDeferred();
    signal.resolve({
      reason,
      version: this.runtimeInjectionSignalVersion,
    });
  }

  #runtimeInjectionWakePromise(version) {
    if (this.runtimeInjectionSignalVersion !== version) {
      return Promise.resolve({
        reason: 'runtime-injection',
        version: this.runtimeInjectionSignalVersion,
      });
    }
    return this.runtimeInjectionSignal.promise;
  }

  #settleRuntimeInjectionOutcome(outcome = {}) {
    const injectionId =
      typeof outcome?.injectionId === 'string' && outcome.injectionId.trim()
        ? outcome.injectionId.trim()
        : null;
    if (!injectionId) return;
    this.runtimeInjectionResults.set(injectionId, outcome);
    const deferred = this.runtimeInjectionAcks.get(injectionId);
    if (deferred) {
      deferred.resolve(outcome);
      this.runtimeInjectionAcks.delete(injectionId);
    }
  }

  #consumeRuntimeInjectionOutcome(injectionId) {
    const resolvedInjectionId =
      typeof injectionId === 'string' && injectionId.trim() ? injectionId.trim() : null;
    if (!resolvedInjectionId) return null;
    const outcome = this.runtimeInjectionResults.get(resolvedInjectionId) ?? null;
    if (outcome) this.runtimeInjectionResults.delete(resolvedInjectionId);
    return outcome;
  }

  async #awaitRuntimeInjectionOutcome({
    injectionId,
    timeoutMs = RUNTIME_INJECTION_ACK_TIMEOUT_MS,
  } = {}) {
    const resolvedInjectionId =
      typeof injectionId === 'string' && injectionId.trim() ? injectionId.trim() : null;
    if (!resolvedInjectionId) return null;

    const settled = this.#consumeRuntimeInjectionOutcome(resolvedInjectionId);
    if (settled) return settled;

    const deferred = this.runtimeInjectionAcks.get(resolvedInjectionId) ?? null;
    if (!deferred?.promise) return null;

    if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
      const outcome = await deferred.promise;
      return this.#consumeRuntimeInjectionOutcome(resolvedInjectionId) ?? outcome ?? null;
    }

    const timeoutDeferred = createDeferred();
    const timer = setTimeout(() => {
      timeoutDeferred.resolve({
        ok: false,
        injectionId: resolvedInjectionId,
        status: 'timeout',
        error: 'runtime_injection_ack_timeout',
      });
    }, timeoutMs);
    timer.unref?.();

    try {
      const outcome = await Promise.race([deferred.promise, timeoutDeferred.promise]);
      if (outcome?.status === 'timeout') return outcome;
      return this.#consumeRuntimeInjectionOutcome(resolvedInjectionId) ?? outcome ?? null;
    } finally {
      clearTimeout(timer);
    }
  }

  async #resolveQueuedRuntimeInjection({
    injectionId,
    drainQueue = null,
    timeoutMs = RUNTIME_INJECTION_ACK_TIMEOUT_MS,
  } = {}) {
    const resolvedInjectionId =
      typeof injectionId === 'string' && injectionId.trim() ? injectionId.trim() : null;
    if (!resolvedInjectionId) return null;

    if (typeof drainQueue === 'function') {
      await drainQueue();
    }

    return (
      this.#consumeRuntimeInjectionOutcome(resolvedInjectionId)
      ?? await this.#awaitRuntimeInjectionOutcome({
        injectionId: resolvedInjectionId,
        timeoutMs,
      })
    );
  }

  #queueCoordinatorBroadcast({ source = 'planner', emitEvent } = {}) {
    const message = formatCoordinatorArtifact(this.coordinatorArtifact, {
      heading: 'Coordinator brief for this run',
      sharedContextSummary: this.sharedContextSummary,
    });
    if (!message) return { queued: false, message: null };
    if (message === this.lastCoordinatorBroadcast) {
      return { queued: false, message };
    }

    this.lastCoordinatorBroadcast = message;
    const queued = this.enqueueAgentMessage({ message, source });
    if (queued?.ok) {
      emitEvent?.({
        type: 'planner.coordination.broadcast',
        source,
        chars: message.length,
      });
      return { queued: true, message };
    }
    return { queued: false, message };
  }

  #mergeCoordinatorArtifact({
    artifact,
    source = 'planner',
    emitEvent,
    phase = null,
    wave = null,
    broadcast = true,
  } = {}) {
    const normalized = normalizeCoordinatorArtifact(artifact);
    if (!normalized) return { changed: false, artifact: this.coordinatorArtifact };

    const merged = mergeCoordinatorArtifacts(this.coordinatorArtifact, normalized);
    const previousJson = JSON.stringify(this.coordinatorArtifact ?? null);
    const nextJson = JSON.stringify(merged ?? null);
    const changed = previousJson !== nextJson;
    this.coordinatorArtifact = merged;

    if (changed) {
      emitEvent?.({
        type: 'planner.coordination.updated',
        source,
        phase,
        wave,
        sharedContextCount: merged?.sharedContext?.length ?? 0,
        riskCount: merged?.risks?.length ?? 0,
        verificationCount: merged?.verification?.length ?? 0,
        replanTriggerCount: merged?.replanTriggers?.length ?? 0,
      });
    }

    const queuedBroadcast = broadcast
      ? this.#queueCoordinatorBroadcast({ source, emitEvent })
      : { queued: false };
    return { changed, artifact: merged, broadcastQueued: queuedBroadcast.queued === true };
  }

  #applyCoordinatorArtifactSnapshot({
    artifact,
    source = 'coordinator',
    emitEvent,
    phase = null,
    wave = null,
    broadcast = false,
  } = {}) {
    const normalized = normalizeCoordinatorArtifact(artifact);
    if (!normalized) return { changed: false, artifact: this.coordinatorArtifact };

    const previousJson = JSON.stringify(this.coordinatorArtifact ?? null);
    const nextJson = JSON.stringify(normalized ?? null);
    const changed = previousJson !== nextJson;
    this.coordinatorArtifact = normalized;

    if (changed) {
      emitEvent?.({
        type: 'planner.coordination.updated',
        source,
        phase,
        wave,
        sharedContextCount: normalized?.sharedContext?.length ?? 0,
        riskCount: normalized?.risks?.length ?? 0,
        verificationCount: normalized?.verification?.length ?? 0,
        replanTriggerCount: normalized?.replanTriggers?.length ?? 0,
      });
    }

    const queuedBroadcast = broadcast
      ? this.#queueCoordinatorBroadcast({ source, emitEvent })
      : { queued: false };
    return { changed, artifact: normalized, broadcastQueued: queuedBroadcast.queued === true };
  }

  #formatCoordinatorRuntimeArtifactBrief() {
    return formatCoordinatorArtifact(this.coordinatorArtifact, {
      heading: 'Current coordinator ledger',
      listLimit: 4,
      handoffLimit: 3,
      interventionLimit: 3,
      includeCountSummary: true,
    }) || 'Current coordinator ledger:\n- none';
  }

  #formatCoordinatorArtifactDelta(artifactProposal) {
    const delta = buildCoordinatorArtifactDelta(this.coordinatorArtifact, artifactProposal);
    return formatCoordinatorArtifactDelta(delta, {
      heading: 'Runtime proposed artifact delta',
    });
  }

  #formatCoordinatorSteerProposal(steerProposal) {
    return formatCoordinatorSteer(steerProposal, {
      heading: 'Runtime proposed steer',
    });
  }

  #formatCoordinatorEventEnvelope({
    eventType,
    summary,
    eventDetails,
    phase = null,
    wave = null,
    taskId = null,
    seq = null,
  } = {}) {
    return formatCoordinatorEventEnvelope({
      seq,
      type: eventType ?? 'event',
      phase,
      wave,
      taskId,
      summary: summary ?? 'event update',
      details: eventDetails ?? null,
    }, {
      heading: 'New event',
    });
  }

  #logCanonicalCoordinatorSummary({
    eventType,
    phase = null,
    wave = null,
    taskId = null,
    artifactChanged = null,
    steer = null,
    note = null,
  } = {}) {
    const summary = formatCanonicalCoordinatorEventSummary({
      eventType,
      phase,
      wave,
      taskId,
      artifactChanged,
      steer,
      note,
    });
    this.sendLog(`[coordinator] ${summary}`);
    return summary;
  }

  async #reportCoordinatorInjectionOutcome({
    eventType,
    phase = null,
    wave = null,
    taskId = null,
    label = null,
    outcome,
    emitEvent,
    eventContextText = null,
    source = 'coordinator-apply-result',
  } = {}) {
    const normalized = outcome && typeof outcome === 'object' ? outcome : null;
    if (!normalized) return null;

    const requestedTaskIds = summarizeCoordinatorTaskIds(normalized.requestedTaskIds, 12);
    const appliedTaskIds = summarizeCoordinatorTaskIds(normalized.taskIds, 12);
    const runtimeOutcomeText = [
      'Runtime injection apply result:',
      `- status: ${coerceString(normalized.status) ?? '-'}`,
      `- kind: ${coerceString(normalized.kind) ?? '-'}`,
      `- source: ${coerceString(normalized.source) ?? '-'}`,
      `- requested: ${requestedTaskIds.join(', ') || '-'}`,
      `- applied: ${appliedTaskIds.join(', ') || '-'}`,
      normalized.sanitized?.removedDependencyCount > 0
        ? `- sanitized deps: ${normalized.sanitized.removedDependencyCount}`
        : null,
      normalized.error
        ? `- error: ${clipText(normalized.error, 260)}`
        : null,
    ].filter(Boolean).join('\n');
    const runtimeEvent = buildRuntimeInjectionOutcomeCoordinatorEvent({
      label,
      outcome: normalized,
    });

    return await this.#coordinateEvent({
      eventType,
      summary: runtimeEvent.summary,
      eventDetails: runtimeEvent.details,
      eventContextText: [
        typeof eventContextText === 'string' && eventContextText.trim()
          ? eventContextText.trim()
          : null,
        runtimeOutcomeText,
      ].filter(Boolean).join('\n\n'),
      artifactHint: buildRuntimeInjectionOutcomeCoordinatorArtifact({
        label,
        outcome: normalized,
      }),
      emitEvent,
      phase,
      wave,
      taskId,
      source,
      allowActions: false,
    });
  }

  #buildCoordinatorInjectionPolicy({
    phase = null,
    taskId = null,
  } = {}) {
    const completedTaskIds = this.taskStates instanceof Map
      ? [...this.taskStates.values()]
        .filter(state => state?.task?.id && state.status === 'completed')
        .map(state => state.task.id)
      : [];

    if (phase === 'dynamic-plan') {
      return {
        kind: 'dynamic-plan',
        allowInternalDeps: false,
        allowedExternalDepIds: completedTaskIds,
        dropDepIds: [taskId].filter(Boolean),
      };
    }

    if (phase === 'stall-plan') {
      return {
        kind: 'stall-plan',
        allowInternalDeps: false,
        allowedExternalDepIds: completedTaskIds,
        dropDepIds: [],
      };
    }

    if (phase === 'recovery-plan') {
      return {
        kind: 'recovery-plan',
        allowInternalDeps: true,
        allowedExternalDepIds: completedTaskIds,
        dropDepIds: [],
      };
    }

    if (phase === 'watchdog') {
      return {
        kind: 'watchdog',
        allowInternalDeps: true,
        allowedExternalDepIds: completedTaskIds,
        dropDepIds: [],
      };
    }

    return null;
  }

  async #applyCoordinatorActions({
    actions,
    emitEvent,
    phase = null,
    wave = null,
    taskId = null,
    eventType = null,
    source = 'coordinator',
  } = {}) {
    const normalized = actions && typeof actions === 'object' ? actions : null;
    if (!normalized) {
      return {
        inject: null,
        aborts: [],
        retries: [],
        respawns: [],
      };
    }

    const outcomes = {
      inject: null,
      aborts: [],
      retries: [],
      respawns: [],
    };

    if (Array.isArray(normalized.injectTasks) && normalized.injectTasks.length > 0) {
      outcomes.inject = this.enqueueRuntimeInjection({
        tasks: normalized.injectTasks,
        kind: 'coordinator',
        source,
        policy: this.#buildCoordinatorInjectionPolicy({ phase, taskId }),
      });
    }

    for (const request of Array.isArray(normalized.abortTasks) ? normalized.abortTasks : []) {
      const resolvedTaskId =
        typeof request?.taskId === 'string' && request.taskId.trim()
          ? request.taskId.trim()
          : null;
      if (!resolvedTaskId) continue;
      outcomes.aborts.push(this.requestTaskAbort({
        taskId: resolvedTaskId,
        reason: request.reason ?? 'coordinator requested abort',
        source,
      }));
    }

    const runtimeControl = this.activeRuntimeCoordinatorControl;
    for (const request of Array.isArray(normalized.retryTasks) ? normalized.retryTasks : []) {
      const resolvedTaskId =
        typeof request?.taskId === 'string' && request.taskId.trim()
          ? request.taskId.trim()
          : null;
      if (!resolvedTaskId) continue;
      const outcome = typeof runtimeControl?.retryTask === 'function'
        ? runtimeControl.retryTask({
          taskId: resolvedTaskId,
          reason: request.reason ?? 'coordinator requested retry',
          source,
        })
        : { ok: false, error: 'runtime_control_unavailable', taskId: resolvedTaskId };
      outcomes.retries.push(outcome);
    }

    for (const request of Array.isArray(normalized.respawnTasks) ? normalized.respawnTasks : []) {
      const resolvedTaskId =
        typeof request?.taskId === 'string' && request.taskId.trim()
          ? request.taskId.trim()
          : null;
      if (!resolvedTaskId) continue;
      const outcome = typeof runtimeControl?.respawnTask === 'function'
        ? runtimeControl.respawnTask({
          taskId: resolvedTaskId,
          reason: request.reason ?? 'coordinator requested respawn',
          source,
        })
        : { ok: false, error: 'runtime_control_unavailable', taskId: resolvedTaskId };
      outcomes.respawns.push(outcome);
    }

    const injectTaskCount = Array.isArray(normalized.injectTasks) ? normalized.injectTasks.length : 0;
    const abortCount = outcomes.aborts.length;
    const retryCount = outcomes.retries.length;
    const respawnCount = outcomes.respawns.length;
    if (injectTaskCount || abortCount || retryCount || respawnCount) {
      emitEvent?.({
        type: 'coordinator.actions.applied',
        source,
        phase,
        wave,
        taskId,
        eventType: eventType ?? null,
        injectTaskCount,
        injectQueued: outcomes.inject?.ok === true ? outcomes.inject.taskCount ?? injectTaskCount : 0,
        aborts: outcomes.aborts,
        retries: outcomes.retries,
        respawns: outcomes.respawns,
      });
    }

    return outcomes;
  }

  #buildCoordinatorTaskStateBlock({ limit = 12 } = {}) {
    if (!(this.taskStates instanceof Map) || this.taskStates.size === 0) return '- none';
    const lines = [];
    for (const state of this.taskStates.values()) {
      if (!state?.task || isResolvedTaskStatus(state.status)) continue;
      const status = normalizeTaskStatus(state.status) || 'pending';
      const desc = clipText(state.task.description ?? '', 160);
      const activity = state.lastActivity ? `; lastActivity=${clipText(state.lastActivity, 80)}` : '';
      lines.push(`- ${state.task.id} [${status}]: ${desc}${activity}`);
      if (lines.length >= limit) break;
    }
    return lines.length > 0 ? lines.join('\n') : '- none';
  }

  #buildCoordinatorTaskList(tasks, { limit = 24 } = {}) {
    const lines = [];
    for (const task of Array.isArray(tasks) ? tasks : []) {
      if (!task?.id) continue;
      const deps = Array.isArray(task.dependsOn) && task.dependsOn.length > 0
        ? ` (dependsOn: ${task.dependsOn.join(', ')})`
        : '';
      lines.push(`- ${task.id}: ${clipText(task.description ?? '', 160)}${deps}`);
      if (lines.length >= limit) break;
    }
    return lines.length > 0 ? lines.join('\n') : '- none';
  }

  #queueCoordinatorUpdate(work) {
    const previous = this.coordinatorUpdateQueue?.catch?.(() => {}) ?? Promise.resolve();
    const run = previous.then(() => work());
    this.coordinatorUpdateQueue = run.catch(err => {
      const message = err instanceof Error ? err.message : String(err ?? 'unknown error');
      this.sendLog(`[coordinator] update failed: ${message}`);
    });
    return run;
  }

  async runCoordinatorTurn({
    client,
    threadId,
    cwd,
    text,
    agentId = 'coordinator',
    taskId = null,
    emitEvent,
    model,
    effort,
    timeoutMs = TURN_TIMEOUT_MS,
  } = {}) {
    const promptText = typeof text === 'string' ? text : String(text ?? '');
    const turnParams = {
      threadId,
      input: [{ type: 'text', text: promptText }],
      cwd,
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
      model,
      effort: effort ?? undefined,
    };
    const turnCollector = new TurnCollector({
      threadId,
      turnId: '',
      onEvent: ({ method, params }) => {
        emitEvent?.({
          type: 'appserver.notification',
          agentId,
          taskId: taskId ?? null,
          phase: 'coordinator',
          method,
          params,
        });
      },
    });

    let activeTurnId = null;
    let completedParams = null;
    let resolveCompletion;
    let rejectCompletion;
    const completionPromise = new Promise((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const bufferedNotifications = [];

    const onExit = payload => {
      if (completedParams) return;
      const code = payload?.code ?? null;
      const signal = payload?.signal ?? null;
      const error = payload?.error ?? null;
      const detail = error
        ? `error=${error}`
        : `code=${code ?? 'null'} signal=${signal ?? 'null'}`;
      completedParams = {
        threadId,
        turn: { id: activeTurnId, status: 'failed' },
        error: { message: `app-server exited before coordinator turn completion (${detail})` },
      };
      rejectCompletion(new Error(completedParams.error.message));
    };

    const recordOrDispatch = message => {
      if (!message || typeof message !== 'object') return;
      const params = message.params;
      if (!params || params.threadId !== threadId) return;
      const eventTurnId = params.turnId ?? params.turn?.id;
      if (!eventTurnId) return;
      if (!activeTurnId) {
        bufferedNotifications.push(message);
        return;
      }
      if (eventTurnId !== activeTurnId) return;
      turnCollector.handleNotification(message);
      if (message.method === 'turn/completed' && !completedParams) {
        completedParams = params;
        resolveCompletion(params);
      }
    };

    const onNotification = message => {
      recordOrDispatch(message);
    };

    client.on('notification', onNotification);
    client.on('exit', onExit);

    let timeout = null;
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        if (!completedParams) {
          completedParams = {
            threadId,
            turn: { id: activeTurnId, status: 'failed' },
            error: { message: 'Timed out waiting for coordinator turn completion' },
          };
          rejectCompletion(new Error(completedParams.error.message));
        }
      }, timeoutMs);
      timeout.unref?.();
    }

    try {
      const turnStart = await client.request('turn/start', turnParams);
      const turnId = turnStart?.turn?.id;
      if (!turnId) throw new Error('Failed to start coordinator turn');

      activeTurnId = turnId;
      turnCollector.turnId = turnId;

      for (const message of bufferedNotifications) {
        const params = message?.params;
        if (!params || params.threadId !== threadId) continue;
        const eventTurnId = params.turnId ?? params.turn?.id;
        if (eventTurnId !== turnId) continue;
        turnCollector.handleNotification(message);
        if (message.method === 'turn/completed' && !completedParams) {
          completedParams = params;
          resolveCompletion(params);
        }
      }

      if (!completedParams && turnCollector.completed) {
        completedParams = {
          threadId,
          turn: { id: turnId, status: turnCollector.status ?? 'completed' },
        };
        resolveCompletion(completedParams);
      }

      const completed = completedParams ?? (await completionPromise);
      if (!turnCollector.completed) {
        turnCollector.handleNotification({ method: 'turn/completed', params: completed });
      }

      const finalTextInfo = turnCollector.finalTextInfo();
      const finalText = finalTextInfo.text;
      const usage = {
        inputTokens: estimateTextTokens(promptText),
        cachedInputTokens: 0,
        outputTokens: estimateTextTokens(finalText),
      };

      emitEvent?.({
        type: 'turn.completed',
        agentId,
        taskId: taskId ?? null,
        phase: 'coordinator',
        threadId,
        turnId,
        status: turnCollector.status ?? null,
        model: model ?? null,
        effort: effort ?? null,
        usage,
        estimated: true,
      });

      if (turnCollector.status === 'failed') {
        throw new Error(turnCollector.error || 'coordinator turn failed');
      }

      return {
        turnId,
        text: finalText,
        hadAgentMessageDelta: finalTextInfo.hadAgentMessageDelta === true,
        events: turnCollector.events,
        model: model ?? null,
        effort: effort ?? null,
        usage,
        estimated: true,
        startResponse: turnStart,
      };
    } finally {
      if (timeout) clearTimeout(timeout);
      client.off('notification', onNotification);
      client.off('exit', onExit);
    }
  }

  async #startCoordinator({ goal, repoRoot, tasks, emitEvent } = {}) {
    if (!LLM_COORDINATOR_ENABLED) return { started: false, reason: 'disabled' };
    if (this.coordinatorClient && this.coordinatorThreadId) {
      return { started: true, reused: true };
    }

    const agentId = 'coordinator';
    const plannerModel =
      this.plannerModelOverride
      ?? pickFirstString(process.env.CDX_PLANNER_MODEL)
      ?? DEFAULT_PLANNER_MODEL
      ?? this.modelOverride
      ?? this.activeModel
      ?? DEFAULT_MODEL;
    const plannerEffort =
      normalizeReasoningEffort(
        this.plannerEffortOverride
        ?? pickFirstString(
          process.env.CDX_PLANNER_EFFORT,
          process.env.CDX_PLANNER_MODEL_REASONING_EFFORT,
          process.env.CDX_PLANNER_REASONING_EFFORT,
        )
        ?? this.effortOverride
        ?? process.env.CDX_MODEL_REASONING_EFFORT
        ?? DEFAULT_PLANNER_EFFORT,
      )
      ?? DEFAULT_PLANNER_EFFORT;
    const client = new AppServerClient({
      approvalDecision: DEFAULT_APPROVAL_DECISION,
      approvalJustification: this.execJustification,
      log: (...args) => this.sendLog(`[${agentId}] ${args.join(' ')}`),
      args: this.workerClientArgsTemplate ?? undefined,
      env: {
        CDX_RUN_ID: this.activeRunId ?? '',
        CDX_TASK_ID: '',
      },
    });
    const runCwd = repoRoot ?? this.activeRepoRoot ?? process.cwd();

    emitEvent?.({
      type: 'agent.started',
      agentId,
      phase: 'coordinator',
      worktreePath: runCwd,
      model: plannerModel,
      effort: plannerEffort,
    });

    try {
      await client.ensureInitialized();
      emitEvent?.({
        type: 'agent.initialized',
        agentId,
        phase: 'coordinator',
      });

      const threadStart = await client.request('thread/start', {
        model: plannerModel,
        cwd: runCwd,
        approvalPolicy: DEFAULT_APPROVAL_POLICY,
        sandbox: 'read-only',
      });
      const threadId = threadStart?.thread?.id ?? threadStart?.threadId;
      if (!threadId) throw new Error('Failed to start coordinator thread');

      this.coordinatorClient = client;
      this.coordinatorCollectors = null;
      this.coordinatorDetach = null;
      this.coordinatorThreadId = threadId;

      const goalText = typeof goal === 'string' && goal.trim()
        ? clipText(goal.trim(), 1_200)
        : '-';
      const taskBlock = this.#buildCoordinatorTaskList(tasks);
      const seedArtifact = this.coordinatorArtifact
        ?? normalizeCoordinatorArtifact({
          goalSummary: goalText,
        });
      const seedArtifactText = formatCoordinatorArtifact(seedArtifact, {
        heading: 'Seed coordinator ledger',
        listLimit: 4,
        handoffLimit: 3,
        interventionLimit: 3,
        includeCountSummary: true,
      }) || 'Seed coordinator ledger:\n- none';
      const promptText = `You are the persistent coordinator for a multi-agent CDX run.
You own the run-level coordination ledger. You are not a worker and must not edit files.

Run context:
- runId: ${this.activeRunId ?? '-'}
- goal: ${goalText}

Initial task plan:
${taskBlock}

${seedArtifactText}

Coordinator operating rules:
${COORDINATOR_COMMON_RULES}
- There are no active workers yet, so steer is usually empty during initialization.
${COORDINATOR_STEER_RULES}

Respond with JSON only using the schema:
${COORDINATOR_RESPONSE_SCHEMA}`;

      const turn = await this.runCoordinatorTurn({
        client,
        threadId,
        cwd: runCwd,
        text: promptText,
        agentId,
        taskId: null,
        emitEvent,
        model: plannerModel,
        effort: plannerEffort,
      });

      const parsed = parseCoordinatorResponse(turn.text ?? '');
      const artifact = parsed?.artifact ?? seedArtifact ?? this.coordinatorArtifact;
      const applyResult = this.#applyCoordinatorArtifactSnapshot({
        artifact,
        source: 'coordinator-init',
        emitEvent,
        phase: 'coordinator',
        broadcast: false,
      });
      const steer = parsed?.steer ?? { broadcast: [], tasks: [] };
      const actionOutcome = await this.#applyCoordinatorActions({
        actions: parsed?.actions ?? null,
        emitEvent,
        phase: 'coordinator',
        eventType: 'coordinator.init',
        source: 'coordinator',
      });
      this.enqueueStructuredSteerMessages({
        steer,
        emitEvent,
        source: 'coordinator',
        eventType: 'coordinator.init',
      });
      this.#logCanonicalCoordinatorSummary({
        eventType: 'coordinator.init',
        phase: 'coordinator',
        artifactChanged: applyResult.changed,
        steer,
        note:
          parsed?.eventSummary
          ?? (
            actionOutcome?.inject?.ok === true
              ? `ledger initialized, queued ${actionOutcome.inject.taskCount ?? 0} coordinator task(s)`
              : 'ledger initialized'
          ),
      });
      emitEvent?.({
        type: 'coordinator.initialized',
        artifactPresent: Boolean(artifact),
      });
      return { started: true, artifact };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? 'unknown error');
      emitEvent?.({
        type: 'coordinator.failed',
        error: message,
        phase: 'coordinator',
      });
      await client.dispose('coordinator-start-failed').catch(() => {});
      this.coordinatorClient = null;
      this.coordinatorCollectors = null;
      this.coordinatorDetach = null;
      this.coordinatorThreadId = null;
      return { started: false, reason: message };
    }
  }

  async #stopCoordinator({ reason = 'finished', emitEvent } = {}) {
    const client = this.coordinatorClient;
    const hadCoordinator = Boolean(client || this.coordinatorThreadId);

    this.coordinatorClient = null;
    this.coordinatorCollectors = null;
    this.coordinatorDetach = null;
    this.coordinatorThreadId = null;
    this.coordinatorUpdateQueue = Promise.resolve();

    if (!hadCoordinator) return;

    emitEvent?.({
      type: 'agent.disposing',
      agentId: 'coordinator',
      phase: 'coordinator',
    });
    await client?.dispose?.(`coordinator-${reason}`).catch(() => {});
    emitEvent?.({
      type: 'agent.disposed',
      agentId: 'coordinator',
      phase: 'coordinator',
    });
  }

  async #coordinateEvent({
    eventType,
    summary,
    eventDetails = null,
    eventContextText = null,
    artifactHint,
    steerHint,
    emitEvent,
    phase = null,
    wave = null,
    taskId = null,
    source = 'coordinator',
    modelOverride = null,
    effortOverride = null,
    allowActions = true,
  } = {}) {
    const artifactProposal = normalizeCoordinatorArtifact(artifactHint);
    const steerProposal = steerHint && typeof steerHint === 'object'
      ? steerHint
      : { broadcast: [], tasks: [] };

    if (!LLM_COORDINATOR_ENABLED || !this.coordinatorClient || !this.coordinatorThreadId) {
      const mergeResult = this.#mergeCoordinatorArtifact({
        artifact: artifactProposal,
        source,
        emitEvent,
        phase,
        wave,
        broadcast: false,
      });
      this.enqueueStructuredSteerMessages({
        steer: steerProposal,
        emitEvent,
        wave,
        reason: eventType ?? null,
        source,
        eventType: 'coordinator.fallback.steer',
      });
      return {
        artifact: this.coordinatorArtifact,
        steer: steerProposal,
        actions: null,
        actionOutcome: null,
        artifactChanged: mergeResult.changed,
        eventSummary: null,
        coordinatorBacked: false,
      };
    }

    return this.#queueCoordinatorUpdate(async () => {
      const agentId = 'coordinator';
      const client = this.coordinatorClient;
      const threadId = this.coordinatorThreadId;
      if (!client || !threadId) {
        return {
          artifact: this.coordinatorArtifact,
          steer: { broadcast: [], tasks: [] },
          actions: null,
          actionOutcome: null,
          artifactChanged: false,
          eventSummary: null,
          coordinatorBacked: false,
        };
      }

      this.coordinatorEventSeq += 1;
      const plannerModel =
        modelOverride
        ?? this.plannerModelOverride
        ?? pickFirstString(process.env.CDX_PLANNER_MODEL)
        ?? DEFAULT_PLANNER_MODEL
        ?? this.modelOverride
        ?? this.activeModel
        ?? DEFAULT_MODEL;
      const plannerEffort =
        normalizeReasoningEffort(
          effortOverride
          ?? this.plannerEffortOverride
          ?? pickFirstString(
            process.env.CDX_PLANNER_EFFORT,
            process.env.CDX_PLANNER_MODEL_REASONING_EFFORT,
            process.env.CDX_PLANNER_REASONING_EFFORT,
          )
          ?? this.effortOverride
          ?? process.env.CDX_MODEL_REASONING_EFFORT
          ?? DEFAULT_PLANNER_EFFORT,
        )
        ?? DEFAULT_PLANNER_EFFORT;
      const activeTasksBlock = this.#buildCoordinatorTaskStateBlock();
      const eventEnvelopeText = this.#formatCoordinatorEventEnvelope({
        eventType,
        summary,
        eventDetails,
        phase,
        wave,
        taskId,
        seq: this.coordinatorEventSeq,
      });
      const eventContextBlock =
        typeof eventContextText === 'string' && eventContextText.trim()
          ? `Extended runtime context:\n${clipText(eventContextText.trim(), 12_000)}\n\n`
          : '';
      const promptText = `You are the persistent coordinator for an ongoing multi-agent CDX run.
Keep owning the coordinator artifact across events. Update it in response to the new event below.
Use the current ledger brief as source of truth and treat runtime proposals as suggestions.

${eventEnvelopeText}

${eventContextBlock}Active tasks that may receive steer:
${activeTasksBlock}

${this.#formatCoordinatorRuntimeArtifactBrief()}

${this.#formatCoordinatorArtifactDelta(artifactProposal)}

${this.#formatCoordinatorSteerProposal(steerProposal)}

Coordinator operating rules:
${COORDINATOR_COMMON_RULES}
- Prefer merging the smallest set of new facts that improves the next handoff or steering decision.
- Record structured coordinator/watchdog decisions under interventions when they are durable.
- ${allowActions ? 'Actions are enabled for this event when they materially improve execution.' : 'This is a read-only result-feedback event. Update artifact/steer only and leave actions empty.'}
${COORDINATOR_STEER_RULES}

Respond with JSON only using the schema:
${COORDINATOR_RESPONSE_SCHEMA}`;

      const turn = await this.runCoordinatorTurn({
        client,
        threadId,
        cwd: this.activeRepoRoot ?? process.cwd(),
        text: promptText,
        agentId,
        taskId,
        emitEvent,
        model: plannerModel,
        effort: plannerEffort,
      });

      const parsed = parseCoordinatorResponse(turn.text ?? '');
      const nextArtifact =
        parsed?.artifact
        ?? mergeCoordinatorArtifacts(this.coordinatorArtifact, artifactProposal)
        ?? this.coordinatorArtifact;
      const applyResult = this.#applyCoordinatorArtifactSnapshot({
        artifact: nextArtifact,
        source,
        emitEvent,
        phase: 'coordinator',
        wave,
        broadcast: false,
      });

      const steer = parsed?.steer ?? { broadcast: [], tasks: [] };
      const actionOutcome = allowActions
        ? await this.#applyCoordinatorActions({
          actions: parsed?.actions ?? null,
          emitEvent,
          phase,
          wave,
          taskId,
          eventType,
          source: 'coordinator',
        })
        : null;
      this.enqueueStructuredSteerMessages({
        steer,
        emitEvent,
        wave,
        reason: eventType ?? null,
        source: 'coordinator',
        eventType: 'coordinator.steer.queued',
      });
      const canonicalSummary = this.#logCanonicalCoordinatorSummary({
        eventType: eventType ?? 'event',
        phase: phase ?? 'coordinator',
        wave,
        taskId,
        artifactChanged: applyResult.changed,
        steer,
        note:
          parsed?.eventSummary
          ?? (
            actionOutcome?.inject?.ok === true
              ? `${summary}; queued ${actionOutcome.inject.taskCount ?? 0} task(s)`
              : summary
          ),
      });
      emitEvent?.({
        type: 'coordinator.updated',
        phase,
        wave,
        taskId,
        eventType: eventType ?? null,
        artifactPresent: Boolean(nextArtifact),
        steerBroadcastCount: Array.isArray(steer.broadcast) ? steer.broadcast.length : 0,
        steerTaskCount: Array.isArray(steer.tasks) ? steer.tasks.length : 0,
      });
      return {
        artifact: nextArtifact,
        steer,
        actions: parsed?.actions ?? null,
        actionOutcome,
        artifactChanged: applyResult.changed,
        eventSummary: parsed?.eventSummary ?? canonicalSummary,
        coordinatorBacked: true,
      };
    });
  }

  enqueueStructuredSteerMessages({
    steer,
    emitEvent,
    wave,
    reason,
    source = 'watchdog',
    eventType = 'watchdog.steer.queued',
  } = {}) {
    const normalized = steer && typeof steer === 'object' ? steer : {};
    const now = Date.now();
    const cutoff = now - WATCHDOG_STEER_COOLDOWN_MS;
    for (const [key, value] of this.watchdogSteerHistory.entries()) {
      if (!Number.isFinite(value) || value < cutoff) this.watchdogSteerHistory.delete(key);
    }

    const queued = [];
    const skipped = [];

    const queueOne = ({ taskId = null, message }) => {
      const scope = taskId ? `task:${taskId}` : 'broadcast';
      const key = `${scope}\u0000${message}`;
      const previous = this.watchdogSteerHistory.get(key);
      if (Number.isFinite(previous) && now - previous < WATCHDOG_STEER_COOLDOWN_MS) {
        skipped.push({ taskId, reason: 'cooldown' });
        return;
      }
      if (taskId) {
        const state = this.taskStates?.get(taskId) ?? null;
        if (!state || isResolvedTaskStatus(state.status)) {
          skipped.push({ taskId, reason: 'not_active' });
          return;
        }
      }
      const outcome = this.enqueueAgentMessage({ taskId, message, source });
      if (!outcome?.ok) {
        skipped.push({ taskId, reason: outcome?.error ?? 'queue_failed' });
        return;
      }
      this.watchdogSteerHistory.set(key, now);
      queued.push({ taskId, messageId: outcome.messageId ?? null });
    };

    for (const message of Array.isArray(normalized.broadcast) ? normalized.broadcast : []) {
      if (typeof message !== 'string' || !message.trim()) continue;
      queueOne({ message });
    }

    for (const taskMessage of Array.isArray(normalized.tasks) ? normalized.tasks : []) {
      const taskId =
        typeof taskMessage?.taskId === 'string' && taskMessage.taskId.trim()
          ? taskMessage.taskId.trim()
          : null;
      const message =
        typeof taskMessage?.message === 'string' && taskMessage.message.trim()
          ? taskMessage.message.trim()
          : null;
      if (!taskId || !message) continue;
      queueOne({ taskId, message });
    }

    if (queued.length > 0 || skipped.length > 0) {
      emitEvent?.({
        type: eventType,
        wave,
        reason: reason ?? null,
        source,
        queued,
        skipped,
      });
    }

    return { queued, skipped };
  }

  #enqueueWatchdogSteerMessages({ steer, emitEvent, wave, reason } = {}) {
    return this.enqueueStructuredSteerMessages({
      steer,
      emitEvent,
      wave,
      reason,
      source: 'watchdog',
      eventType: 'watchdog.steer.queued',
    });
  }

  async #askSupervisor({
    question,
    options,
    constraints,
    desiredOutput,
    taskId,
    threadId,
    turnId,
    mode,
    timeoutMs,
    metadata,
    autoAnswer,
  } = {}) {
    const emitEvent = this.activeEmitEvent ?? (() => {});
    const askId = randomUUID();
    const normalizedQuestion = typeof question === 'string' ? question.trim() : '';
    if (!normalizedQuestion) {
      throw new Error('router.ask requires a non-empty question.');
    }
    const resolvedTaskId = typeof taskId === 'string' && taskId.trim() ? taskId.trim() : null;
    const resolvedThreadId = typeof threadId === 'string' && threadId.trim() ? threadId.trim() : null;
    const resolvedTurnId = typeof turnId === 'string' && turnId.trim() ? turnId.trim() : null;
    const resolvedMode = normalizeRouterMode(mode) ?? 'supervised';
    const resolvedTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : null;
    const normalizedMetadata = isObject(metadata)
      ? {
          ...metadata,
          conflictPaths: Array.isArray(metadata.conflictPaths) ? [...metadata.conflictPaths] : [],
        }
      : null;
    const normalizedAutoAnswer = isObject(autoAnswer) ? { ...autoAnswer } : null;

    const record = {
      askId,
      runId: this.activeRunId ?? null,
      taskId: resolvedTaskId,
      threadId: resolvedThreadId,
      turnId: resolvedTurnId,
      mode: resolvedMode,
      timeoutMs: resolvedTimeoutMs,
      question: normalizedQuestion,
      options: Array.isArray(options) ? options : [],
      constraints: Array.isArray(constraints) ? constraints : [],
      desiredOutput: typeof desiredOutput === 'string' && desiredOutput.trim() ? desiredOutput.trim() : null,
      metadata: normalizedMetadata,
      autoAnswer: normalizedAutoAnswer,
      createdAt: Date.now(),
      status: 'pending',
      answeredAt: null,
      answeredBy: null,
      decision: null,
      messageForAgent: null,
    };

    const waiter = createDeferred();
    this.routerAsks.set(askId, record);
    this.routerAskWaiters.set(askId, waiter);

    emitEvent({
      type: 'router.ask.pending',
      askId,
      taskId: resolvedTaskId,
      threadId: resolvedThreadId,
      turnId: resolvedTurnId,
      mode: record.mode,
      timeoutMs: record.timeoutMs,
      question: record.question,
      options: record.options,
      constraints: record.constraints,
      desiredOutput: record.desiredOutput,
      metadata: normalizedMetadata,
      autoAnswer: normalizedAutoAnswer,
      contextPreview: null,
    });

    this.sendLog(`Supervisor input required (router.ask ${askId}).`);
    return await waiter.promise;
  }

  async run({
    prompt,
    targets,
    checklist,
    workflowMode,
    orchestrationMode,
    continuous,
    maxCycles,
    outputRoot,
    sourceSystems,
    artifactLocation,
    artifactFormat,
    artifactInstructions,
    repoRoot: repoRootOverride,
    maxParallelism,
    minParallelism,
    autoscale,
    smartSpawn,
    repoIndex,
    avoidOverlap,
    scout,
    plannerPrompt,
    skipPlanner,
    includeSummary,
    runId,
    model,
    plannerModel,
    taskModel,
    watchdogModel,
    effort,
    plannerEffort,
    taskEffort,
    judgeEffort,
    watchdogEffort,
    sandbox,
    webSearch,
    analyticsEnabled,
    analytics,
    integrationVerify,
    review,
  } = {}) {
    const checklistConfig = normalizeChecklistConfig({
      workflowMode,
      orchestrationMode,
      targets,
      checklist,
      continuous,
      maxCycles,
      outputRoot,
      sourceSystems,
      artifactLocation,
      artifactFormat,
      artifactInstructions,
    }, {
      maxTargets: MAX_TOTAL_TASKS,
      maxItems: MAX_TOTAL_TASKS,
    });

    const promptText = typeof prompt === 'string' ? prompt.trim() : '';
    const goal = promptText || (
      checklistConfig
        ? `Execute the configured checklist workflow for ${checklistConfig.targets.length} targets and ${checklistConfig.items.length} checklist items.`
        : ''
    );
    if (!goal) {
      throw new Error('cdx tool requires either a prompt string or a checklist workload.');
    }

    const smartSpawnEnabled = coerceBoolean(smartSpawn ?? process.env.CDX_SMART_SPAWN) === true;
    const goalWordCount = this.#estimateGoalWords(goal);
    const repoIndexEnabled = coerceBoolean(repoIndex) ?? DEFAULT_REPO_INDEX_ENABLED;
    const avoidOverlapEnabled = coerceBoolean(avoidOverlap) ?? DEFAULT_AVOID_OVERLAP_ENABLED;
    const scoutEnabled = coerceBoolean(scout) ?? DEFAULT_SCOUT_ENABLED;
    this.repoIndexEnabled = repoIndexEnabled;
    this.avoidOverlapEnabled = avoidOverlapEnabled;
    this.scoutEnabled = scoutEnabled;
    this.sharedContextSummary = null;
    this.includeRepoIndexInTaskPrompt = repoIndexEnabled && TASK_PROMPT_REPO_INDEX;

    const desiredRunId = typeof runId === 'string' && runId.trim()
      ? runId.trim()
      : String(process.env.CDX_RUN_ID ?? '').trim()
        ? String(process.env.CDX_RUN_ID ?? '').trim()
        : `cdx-${new Date().toISOString()}-${randomUUID()}`;

    const resolvedRunId = slugify(desiredRunId, `cdx-${Date.now()}`);
    let eventSeq = 0;
    const emitEvent = payload => {
      eventSeq += 1;
      this.sendEvent({
        runId: resolvedRunId,
        seq: eventSeq,
        timestamp: new Date().toISOString(),
        wallMs: Date.now(),
        monotonicNs: process.hrtime.bigint().toString(),
        ...payload,
      });
    };

    this.activeRunId = resolvedRunId;
    this.activeGoal = goal;
    this.activeEmitEvent = emitEvent;
    this.coordinatorArtifact = null;
    this.lastCoordinatorBroadcast = null;
    this.coordinatorClient = null;
    this.coordinatorCollectors = null;
    this.coordinatorDetach = null;
    this.coordinatorThreadId = null;
    this.coordinatorUpdateQueue = Promise.resolve();
    this.coordinatorEventSeq = 0;
    this.watchdogSteerHistory = new Map();
    this.rateLimitEvents = [];
    this.rateLimitLastAt = 0;
    this.rateLimitSnapshot = null;
    this.rateLimitFailure = null;

    const explicitRepoRoot =
      typeof repoRootOverride === 'string' && repoRootOverride.trim() ? repoRootOverride.trim() : null;
    const log = (...args) => this.sendLog(args.join(' '));
    const dirtyAction = resolveDirtyWorktreeAction();
    const conflictStrategy = resolveDirtyWorktreeConflictStrategy();
    const preflightSummary = {
      runId: resolvedRunId,
      repoRoot: null,
      repoInit: false,
      initialCommit: null,
      dirtyAction,
      conflictStrategy,
      abortedOperations: [],
      skippedOperations: [],
      dirtyStatus: null,
      resolvedConflicts: null,
      autoCommit: false,
      autoCommitMessage: null,
      autoCommitSha: null,
      clean: false,
    };
    let repoRoot;
    try {
      repoRoot = await resolveRepoRoot(explicitRepoRoot ?? this.activeRepoRoot, this.sandboxCwd, {
        log,
        preflight: preflightSummary,
      });
      this.activeRepoRoot = repoRoot;
      preflightSummary.repoRoot = repoRoot;

      await this.#handlePreflightHook({
        hook: 'preflight.start',
        runId: resolvedRunId,
        data: preflightSummary,
      });

      await ensureRepoHasHead({ cwd: repoRoot, log, preflight: preflightSummary });

      try {
        await ensureRepoExcludes(
          repoRoot,
          ['.cdx-worktrees/', '.tmp-debug-worktrees/', '.cdx-shared/', '.cdx-runs/'],
          { log },
        );
      } catch {
        // best-effort only
      }

      if (WORKTREE_PRUNE_ENABLED) {
        const worktreeRoot = resolveWorktreeRoot(repoRoot);
        const ttlHours = Number.isFinite(WORKTREE_TTL_HOURS) ? WORKTREE_TTL_HOURS : 0;
        const pruneResult = await pruneWorktreeRuns({
          repoRoot,
          worktreeRoot,
          log,
          ttlHours,
          expire: WORKTREE_PRUNE_EXPIRE,
        });
        if (pruneResult?.removed) {
          this.sendLog(`Pruned ${pruneResult.removed} old worktree run(s).`);
        }
      }

      const allowMerge = dirtyAction === 'commit' && conflictStrategy !== 'abort';
      if (dirtyAction === 'commit') {
        const outcome = await abortGitOperations({
          cwd: repoRoot,
          log,
          abortMerge: conflictStrategy === 'abort',
        });
        preflightSummary.abortedOperations = outcome.aborted;
        preflightSummary.skippedOperations = outcome.skipped;
        if (outcome.aborted.length > 0) {
          this.sendLog(`Aborted ${outcome.aborted.length} in-progress git operation(s) before run.`);
        }
      }
      await ensureNoGitOperationInProgress({ cwd: repoRoot, log, allowMerge });

      try {
        await ensureCleanWorktree(repoRoot);
      } catch (err) {
        const action = dirtyAction;
        const hasDetails = err && typeof err === 'object' && 'details' in err;
        if (action === 'commit' && hasDetails) {
          const message = resolveDirtyWorktreeCommitMessage();
          preflightSummary.dirtyStatus = String(err.details ?? '').trim() || null;

          this.sendLog('Working tree is not clean; auto-committing changes before run...');
          const conflictOutcome = await resolveUnmergedPaths({
            cwd: repoRoot,
            strategy: conflictStrategy,
            log,
          });
          if (conflictOutcome?.resolved) {
            preflightSummary.resolvedConflicts = {
              strategy: conflictStrategy,
              files: conflictOutcome.files ?? [],
            };
          }
          const committed = await commitAll({
            cwd: repoRoot,
            message,
            log: (...args) => this.sendLog(args.join(' ')),
          });
          if (committed) {
            const sha = (await git(['rev-parse', '--short', 'HEAD'], { cwd: repoRoot })).trim();
            if (sha) this.sendLog(`Auto-commit created ${sha}.`);
            preflightSummary.autoCommit = true;
            preflightSummary.autoCommitMessage = message;
            preflightSummary.autoCommitSha = sha || null;
          }
          await ensureCleanWorktree(repoRoot);
        } else if ((action === 'ask' || action === 'prompt') && hasDetails) {
          const details = String(err.details ?? '').trim();
          const branch = await getHeadRef(repoRoot).catch(() => 'HEAD');
          preflightSummary.dirtyStatus = details || null;

          const decision = await this.#askSupervisor({
            question:
              `Working tree is not clean in ${repoRoot} (branch=${branch}).\n\n`
              + `git status --porcelain:\n${clipText(details, 4000)}\n\n`
              + 'Choose how to proceed so cdx can create worktrees.',
            options: [
              { id: 'stash', summary: 'Stash all changes (git stash -u) and continue.' },
              { id: 'branch', summary: 'Create a new branch, commit all changes, then continue.' },
              { id: 'abort', summary: 'Abort the run (no changes applied by cdx).' },
            ],
            constraints: [
              'Do not drop local changes.',
              'Prefer minimal surprises: only stash/commit when explicitly chosen.',
            ],
            desiredOutput:
              'Reply with decision.option_id = stash|branch|abort. Optional: branch_name, commit_message, stash_message.',
          });

          const optionIdRaw = decision?.decision?.option_id ?? decision?.decision?.optionId ?? null;
          const optionId = typeof optionIdRaw === 'string' ? optionIdRaw.trim().toLowerCase() : '';

          if (optionId === 'stash') {
            const stashMessageRaw =
              decision?.stash_message ?? decision?.stashMessage ?? decision?.message ?? null;
            const stashMessage =
              typeof stashMessageRaw === 'string' && stashMessageRaw.trim()
                ? stashMessageRaw.trim()
                : `WIP: before cdx (${new Date().toISOString()})`;
            this.sendLog('Working tree is not clean; stashing changes before run...');
            await git(['stash', 'push', '-u', '-m', stashMessage], {
              cwd: repoRoot,
              log: (...args) => this.sendLog(args.join(' ')),
            });
            const stashHead = (await git(['rev-parse', '--short', 'refs/stash'], { cwd: repoRoot }).catch(() => '')).trim();
            if (stashHead) this.sendLog(`Created stash ${stashHead}.`);
            await ensureCleanWorktree(repoRoot);
          } else if (optionId === 'branch') {
            const branchNameRaw = decision?.branch_name ?? decision?.branchName ?? decision?.branch ?? null;
            const normalizedBranch =
              normalizeBranchName(branchNameRaw)
              ?? normalizeBranchName(`cdx/wip/${String(runId ?? '').trim() || Date.now()}`)
              ?? `cdx/wip/${Date.now()}`;

            let targetBranch = normalizedBranch;
            for (let i = 0; i < 20; i += 1) {
              const exists = await git(['show-ref', '--verify', '--quiet', `refs/heads/${targetBranch}`], {
                cwd: repoRoot,
                log: () => {},
              })
                .then(() => true)
                .catch(() => false);
              if (!exists) break;
              targetBranch = `${normalizedBranch}-${randomUUID().slice(0, 8)}`;
            }

            const commitMessageRaw =
              decision?.commit_message ?? decision?.commitMessage ?? decision?.message ?? null;
            const commitMessage =
              typeof commitMessageRaw === 'string' && commitMessageRaw.trim()
                ? commitMessageRaw.trim()
                : `chore: WIP before cdx (${new Date().toISOString()})`;

            this.sendLog(`Working tree is not clean; creating branch ${targetBranch} and committing changes...`);
            await git(['checkout', '-b', targetBranch], {
              cwd: repoRoot,
              log: (...args) => this.sendLog(args.join(' ')),
            });
            const committed = await commitAll({
              cwd: repoRoot,
              message: commitMessage,
              log: (...args) => this.sendLog(args.join(' ')),
            });
            if (committed) {
              const sha = (await git(['rev-parse', '--short', 'HEAD'], { cwd: repoRoot })).trim();
              if (sha) this.sendLog(`WIP commit created ${sha} on ${targetBranch}.`);
            }
            await ensureCleanWorktree(repoRoot);
          } else {
            throw new Error('cdx aborted due to dirty worktree (supervisor selected abort).');
          }
        } else {
          throw err;
        }
      }
      preflightSummary.clean = true;

      await this.#handlePreflightHook({
        hook: 'preflight.completed',
        runId: resolvedRunId,
        data: preflightSummary,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? 'unknown error');
      emitEvent({
        type: 'preflight.failed',
        error: message,
      });
      this.#cleanupSupervisor();
      throw err;
    }
    const headRef = await getHeadRef(repoRoot);
    const baseHeadSha = (await git(['rev-parse', 'HEAD'], { cwd: repoRoot })).trim();

    const repoFileCount = smartSpawnEnabled ? await this.#countRepoFiles(repoRoot) : null;

    const configLayers = loadCodexConfigLayers({ cwd: repoRoot });
    this.codexConfig = configLayers.config ?? null;
    this.codexConfigMeta = {
      projectRoot: configLayers.projectRoot,
      sources: configLayers.sources,
    };

    const envJustification = String(
      process.env.CDX_EXEC_JUSTIFICATION ?? process.env.CDX_APPROVAL_JUSTIFICATION ?? '',
    ).trim();
    const cfgJustification = getConfigValue(this.codexConfig, 'exec.justification')
      ?? getConfigValue(this.codexConfig, 'exec.justification_text')
      ?? getConfigValue(this.codexConfig, 'exec.justificationText')
      ?? getConfigValue(this.codexConfig, 'exec_justification')
      ?? getConfigValue(this.codexConfig, 'execJustification');
    this.execJustification =
      envJustification
        ? envJustification
        : typeof cfgJustification === 'string' && cfgJustification.trim()
          ? cfgJustification.trim()
          : null;

    this.modelOverride = typeof model === 'string' && model.trim() ? model.trim() : null;
    this.plannerModelOverride =
      typeof plannerModel === 'string' && plannerModel.trim() ? plannerModel.trim() : null;
    this.taskModelOverride =
      typeof taskModel === 'string' && taskModel.trim() ? taskModel.trim() : null;
    this.watchdogModelOverride =
      typeof watchdogModel === 'string' && watchdogModel.trim() ? watchdogModel.trim() : null;
    this.effortOverride = typeof effort === 'string' && effort.trim() ? effort.trim() : null;
    this.plannerEffortOverride =
      typeof plannerEffort === 'string' && plannerEffort.trim() ? plannerEffort.trim() : null;
    this.taskEffortOverride =
      typeof taskEffort === 'string' && taskEffort.trim() ? taskEffort.trim() : null;
    this.judgeEffortOverride =
      typeof judgeEffort === 'string' && judgeEffort.trim() ? judgeEffort.trim() : null;
    this.watchdogEffortOverride =
      typeof watchdogEffort === 'string' && watchdogEffort.trim() ? watchdogEffort.trim() : null;

    if (sandbox !== undefined && sandbox !== null) {
      const normalized = normalizeSandboxMode(String(sandbox));
      if (!normalized) {
        throw new Error(
          `Unsupported sandbox mode: ${String(sandbox).trim()}. Expected read-only | workspace-write | danger-full-access.`,
        );
      }
      this.sandboxOverride = normalized;
    } else {
      this.sandboxOverride = null;
    }

    if (webSearch !== undefined && webSearch !== null) {
      const normalized = normalizeWebSearchMode(webSearch);
      if (!normalized) {
        throw new Error(
          `Unsupported webSearch mode: ${String(webSearch)}. Expected off | on | cached.`,
        );
      }
      this.webSearchModeOverride = normalized;
    } else {
      this.webSearchModeOverride = null;
    }

    const analyticsCandidate =
      analyticsEnabled !== undefined
        ? analyticsEnabled
        : isObject(analytics) && Object.hasOwn(analytics, 'enabled')
          ? analytics.enabled
          : undefined;
    if (analyticsCandidate !== undefined) {
      const coerced = coerceBoolean(analyticsCandidate);
      if (coerced === null) {
        throw new Error(
          `Unsupported analyticsEnabled value: ${String(analyticsCandidate)}. Expected boolean.`,
        );
      }
      this.analyticsEnabledOverride = coerced;
    } else {
      this.analyticsEnabledOverride = null;
    }

    let integrationVerifyEnabled = DEFAULT_INTEGRATION_VERIFY;
    if (integrationVerify !== undefined && integrationVerify !== null) {
      const coerced = coerceBoolean(integrationVerify);
      if (coerced === null) {
        throw new Error(
          `Unsupported integrationVerify value: ${String(integrationVerify)}. Expected boolean.`,
        );
      }
      integrationVerifyEnabled = coerced;
    } else {
      const envCoerced = coerceBoolean(process.env.CDX_INTEGRATION_VERIFY);
      if (envCoerced !== null) integrationVerifyEnabled = envCoerced;
    }

    let reviewEnabled = false;
    if (review !== undefined && review !== null) {
      const coerced = coerceBoolean(review);
      if (coerced === null) {
        throw new Error(`Unsupported review value: ${String(review)}. Expected boolean.`);
      }
      reviewEnabled = coerced;
    } else {
      const envCoerced = coerceBoolean(process.env.CDX_REVIEW ?? process.env.CDX_AUTO_REVIEW);
      if (envCoerced !== null) reviewEnabled = envCoerced;
    }

    this.worktreeSparseConfig = resolveSparseConfig(repoRoot);
    this.taskPathLayout = resolveTaskPathLayout(this.worktreeSparseConfig);
    this.worktreeExternalizeConfig = resolveExternalizeConfig();
    this.sharedCacheEnabled = resolveSharedCacheEnabled();

    const worktreeRoot = USE_GIT_WORKTREES
      ? (resolveWorktreeRoot(repoRoot) ?? defaultWorktreeRoot(repoRoot))
      : null;
    const runRoot = USE_GIT_WORKTREES
      ? path.join(worktreeRoot, resolvedRunId)
      : path.join(repoRoot, '.cdx-runs', resolvedRunId);
    const integrationPath = USE_GIT_WORKTREES ? path.join(runRoot, 'integration') : repoRoot;
    const tasksRoot = path.join(runRoot, 'tasks');
    await mkdir(tasksRoot, { recursive: true });

    const integrationBranch = USE_GIT_WORKTREES ? `cdx/integration/${resolvedRunId}` : null;
    emitEvent({
      type: 'run.started',
      goal,
      repoRoot,
      headRef,
      headSha: baseHeadSha,
      worktreeRoot,
      runRoot,
      integrationBranch,
      keepWorktrees: USE_GIT_WORKTREES ? KEEP_WORKTREES : false,
      worktreeMode: USE_GIT_WORKTREES ? 'git-worktree' : 'shared',
      pid: process.pid,
      sandboxCwd: this.sandboxCwd,
    });

    if (checklistConfig) {
      emitEvent({
        type: 'checklist.configured',
        checklist: checklistConfig,
      });
      this.sendLog(
        `Checklist mode: ${checklistConfig.targets.length} target(s) x ${checklistConfig.items.length} item(s)`
          + `${checklistConfig.continuous ? ' (continuous)' : ''}`,
      );
    }

    this.sendLog(`Repo: ${repoRoot}`);
    this.sendLog(`Base HEAD: ${headRef}`);
    if (USE_GIT_WORKTREES) {
      this.sendLog(`Worktrees: ${runRoot}`);
      this.sendProgress({ progress: 0.02, message: 'Preparing worktrees' });
    } else {
      this.sendLog('Worktree mode: shared workspace (no git worktrees)');
      this.sendProgress({ progress: 0.02, message: 'Preparing shared workspace' });
    }

    return await (async () => {
      if (ROUTER_ENABLED) {
        this.router = new RouterMcpServer({
          protocolVersion: PROTOCOL_VERSION,
          serverInfo: { name: 'cdx-router', version: '0.1.0' },
          log: (...args) => this.sendLog(`[router] ${args.join(' ')}`),
          onAsk: this.#handleRouterAsk.bind(this),
        });
        const handle = await this.router.start({ host: ROUTER_HOST, port: 0, path: ROUTER_PATH });
        this.routerUrl = handle.url;
        emitEvent({ type: 'router.started', url: this.routerUrl });
      } else {
        this.router = null;
        this.routerUrl = null;
      }

      await this.#prepareWorkerClientArgsTemplate();

      if (USE_GIT_WORKTREES) {
        await createWorktree({
          repoRoot,
          worktreePath: integrationPath,
          branch: integrationBranch,
          baseRef: 'HEAD',
          log: (...args) => this.sendLog(args.join(' ')),
          sparse: this.worktreeSparseConfig,
          externalize: this.worktreeExternalizeConfig,
        });
        await this.#syncProjectCodexConfigToWorktree({
          repoRoot,
          worktreePath: integrationPath,
          emitEvent,
          label: 'integration',
        });
        await ensureInitialCommit({
          cwd: integrationPath,
          message: `cdx: init integration (${resolvedRunId})`,
          log: (...args) => this.sendLog(args.join(' ')),
        });
      }

      const shouldBuildRepoIndex = repoIndexEnabled || scoutEnabled;
      this.repoIndex = shouldBuildRepoIndex ? await this.#buildRepoIndex(repoRoot) : '';
      if (this.repoIndex) {
        emitEvent({
          type: 'repo.index.built',
          chars: this.repoIndex.length,
          enabled: repoIndexEnabled,
        });
      }

      const maxParallelismProvided =
        maxParallelism !== undefined &&
        maxParallelism !== null &&
        String(maxParallelism).trim() !== '';

      const minParallelismProvided =
        minParallelism !== undefined &&
        minParallelism !== null &&
        String(minParallelism).trim() !== '';

      const smartDefaults = smartSpawnEnabled
        ? this.#computeSmartSpawnDefaults({ goalWords: goalWordCount, repoFileCount })
        : null;

      const parsedMaxParallelism = this.#parseParallelism(maxParallelism);
      const checklistDefaultParallelism = checklistConfig
        ? Math.max(1, Math.min(DEFAULT_MAX_PARALLELISM, checklistConfig.targets.length))
        : null;
      const shouldParallelize = checklistConfig
        ? checklistConfig.targets.length > 1
        : !maxParallelismProvided && (
          smartSpawnEnabled
            ? (smartDefaults?.maxParallelism ?? 1) > 1
            : this.#shouldParallelizeGoal(goal)
        );
      const planningParallelism =
        parsedMaxParallelism ??
        (maxParallelismProvided
          ? Math.max(1, DEFAULT_MAX_PARALLELISM)
          : checklistConfig
            ? checklistDefaultParallelism
          : smartDefaults?.maxParallelism
            ?? (shouldParallelize
              ? Math.max(1, DEFAULT_MIN_PARALLELISM)
              : 1));

      const skipPlannerFlag =
        coerceBoolean(skipPlanner) ?? coerceBoolean(process.env.CDX_SKIP_PLANNER_SINGLE);
      const skipPlannerEnabled = skipPlannerFlag === true;
      const shouldSkipPlanner = checklistConfig
        ? true
        :
        skipPlannerEnabled && planningParallelism <= 1 && !coerceString(plannerPrompt);

      const requestedMinParallelism = checklistConfig
        ? (
          minParallelismProvided
            ? this.#parseMinParallelism(minParallelism)
            : Math.max(1, Math.min(DEFAULT_MIN_PARALLELISM, planningParallelism))
        )
        : minParallelismProvided
          ? this.#parseMinParallelism(minParallelism)
          : smartDefaults?.minParallelism ?? this.#parseMinParallelism(minParallelism);

      let plannerHints = smartSpawnEnabled
        ? this.#computeSmartPlannerHints({
          goalWords: goalWordCount,
          repoFileCount,
          parallelism: planningParallelism,
          smartDefaults,
        })
        : null;

      if (avoidOverlapEnabled) {
        const nextHints = { ...(plannerHints ?? {}) };
        const currentMultiplier =
          Number.isFinite(nextHints.plannerTaskMultiplier)
            ? nextHints.plannerTaskMultiplier
            : PLANNER_TASK_MULTIPLIER;
        nextHints.plannerTaskMultiplier = Math.min(currentMultiplier, 1);
        const currentMinTasks =
          Number.isFinite(nextHints.plannerMinTasks)
            ? nextHints.plannerMinTasks
            : Math.max(1, planningParallelism);
        nextHints.plannerMinTasks = Math.min(currentMinTasks, Math.max(1, planningParallelism));
        plannerHints = nextHints;
      }

      if (smartSpawnEnabled) {
        const logParts = [
          `goalWords=${goalWordCount}`,
          `repoFiles=${repoFileCount ?? 'unknown'}`,
          `intensity=${plannerHints?.intensity ?? smartDefaults?.intensity ?? 'n/a'}`,
        ];
        if (avoidOverlapEnabled) {
          logParts.push('avoidOverlap=1');
        }
        if (!maxParallelismProvided && smartDefaults?.maxParallelism) {
          logParts.push(`maxParallelism->${planningParallelism}`);
        }
        if (!minParallelismProvided && smartDefaults?.minParallelism) {
          logParts.push(`minParallelism->${requestedMinParallelism}`);
        }
        if (plannerHints?.plannerTaskMultiplier) {
          logParts.push(`plannerMultiplier=${plannerHints.plannerTaskMultiplier}`);
        }
        if (
          plannerHints?.plannerMinTasks !== undefined
          && plannerHints?.plannerMinTasks !== null
        ) {
          logParts.push(`plannerMinTasks=${plannerHints.plannerMinTasks}`);
        }
        this.sendLog(`smartSpawn enabled: ${logParts.join(', ')}`);
      }

      let autoscaleParallelism = true;
      if (autoscale !== undefined && autoscale !== null) {
        const coerced = coerceBoolean(autoscale);
        if (coerced === null) {
          throw new Error(
            `Unsupported autoscale value: ${String(autoscale)}. Expected boolean.`,
          );
        }
        autoscaleParallelism = coerced;
      } else {
        const envCoerced = coerceBoolean(process.env.CDX_AUTOSCALE_PARALLELISM);
        if (envCoerced !== null) autoscaleParallelism = envCoerced;
      }

      if (scoutEnabled && planningParallelism > 1) {
        this.sendProgress({ progress: 0.04, message: 'Running repo scout' });
        const summary = await this.runScoutSummary({
          goal,
          repoRoot,
          repoIndex: this.repoIndex,
          emitEvent,
          cwd: integrationPath,
        });
        if (summary) {
          this.sharedContextSummary = summary;
          this.enqueueAgentMessage({
            message: `Shared repo summary (scout):\n${summary}`,
            source: 'scout',
          });
          emitEvent?.({
            type: 'scout.broadcast',
            chars: summary.length,
          });
        }
      }

      let plannedTasks = [];
      let rawPlanText = '';

      const overridePlan = process.env.CDX_PLAN_OVERRIDE_JSON;
      if (checklistConfig) {
        plannedTasks = buildChecklistTasks(checklistConfig, { cycle: 1 });
        rawPlanText = 'checklist-mode';
        emitEvent({
          type: 'plan.skipped',
          reason: 'checklist',
          parallelism: planningParallelism,
        });
      } else if (shouldSkipPlanner) {
        this.sendLog(`Skipping planner (parallelism=${planningParallelism})`);
        emitEvent({
          type: 'plan.skipped',
          reason: 'serial',
          parallelism: planningParallelism,
        });
        rawPlanText = 'planner-skipped';
      } else if (overridePlan && overridePlan.trim()) {
        const parsed = parsePlan(overridePlan);
        plannedTasks = parsed.tasks ?? [];
        this.#mergeCoordinatorArtifact({
          artifact: parsed.coordination,
          source: 'override-plan',
          emitEvent,
          phase: 'planner',
        });
        rawPlanText = overridePlan;
        this.sendLog(`Using CDX_PLAN_OVERRIDE_JSON (${plannedTasks.length} task(s))`);
        if (!this.modelOverride) {
          await this.#ensureModelSelected();
        }
      } else {
        const plannerClient = new AppServerClient({
          approvalDecision: DEFAULT_APPROVAL_DECISION,
          approvalJustification: this.execJustification,
          log: (...args) => this.sendLog(`[planner] ${args.join(' ')}`),
          ...this.#buildHookClientOptions({ agentId: 'planner', taskId: null, phase: 'planner' }),
          ...this.#buildWorkerClientOptions('planner', 'planner'),
        });
        const plannerCollectors = new Map(); // key -> TurnCollector

        const plannerSpec = this.#agentModelEffort({ phase: 'planner' });
        emitEvent({
          type: 'agent.started',
          agentId: 'planner',
          phase: 'planner',
          worktreePath: repoRoot,
          model: plannerSpec.model,
          effort: plannerSpec.effort,
        });
        const detachPlanner = this.#attachClient({
          client: plannerClient,
          collectors: plannerCollectors,
          emitEvent,
          agentId: 'planner',
          taskId: null,
          phase: 'planner',
          contextStore: null,
        });

        let planError = null;
        try {
          await plannerClient.ensureInitialized();
          emitEvent({
            type: 'agent.initialized',
            agentId: 'planner',
            phase: 'planner',
          });

          if (!this.modelOverride) {
            await this.#ensureModelSelected({ client: plannerClient });
          }
          this.sendProgress({ progress: 0.05, message: 'Planning tasks' });
          const planResult = await this.#plan(
            plannerClient,
            plannerCollectors,
            repoRoot,
            goal,
            plannerPrompt,
            {
              parallelism: planningParallelism,
              plannerTaskMultiplier: plannerHints?.plannerTaskMultiplier,
              plannerMinTasks: plannerHints?.plannerMinTasks,
              repoIndex: repoIndexEnabled ? this.repoIndex : '',
              avoidOverlap: avoidOverlapEnabled,
            },
          );
          plannedTasks = planResult.tasks;
          this.#mergeCoordinatorArtifact({
            artifact: planResult.coordination,
            source: 'planner',
            emitEvent,
            phase: 'planner',
          });
          rawPlanText = planResult.rawPlanText;
        } catch (err) {
          planError = err instanceof Error ? err : new Error(String(err ?? 'unknown error'));
          plannedTasks = [];
          rawPlanText = planError.message;
          this.sendLog(`[planner] failed: ${planError.message}`);
          emitEvent({
            type: 'plan.failed',
            error: planError.message,
          });
        } finally {
          emitEvent({
            type: 'agent.disposing',
            agentId: 'planner',
            phase: 'planner',
          });
          detachPlanner();
          await plannerClient.dispose('planner-finished');
          emitEvent({
            type: 'agent.disposed',
            agentId: 'planner',
            phase: 'planner',
          });
        }
      }

      if (!this.modelOverride) {
        await this.#ensureModelSelected();
      }

      let tasks = normaliseTasks(plannedTasks, { pathLayout: this.taskPathLayout });

      let parallelism = planningParallelism;
      const rootCount = countRunnableRoots(tasks);
      if (!maxParallelismProvided) {
        if (!shouldParallelize) {
          parallelism = 1;
        } else {
          parallelism = Math.max(
            1,
            Math.min(DEFAULT_MAX_PARALLELISM, rootCount, tasks.length),
          );
        }

        if (parallelism !== planningParallelism) {
          emitEvent({
            type: 'parallelism.auto.resolved',
            planningParallelism,
            parallelism,
            rootCount,
            shouldParallelize,
          });
        }
      }

      const resolvedMinParallelism = Math.min(requestedMinParallelism, parallelism);

      if (!checklistConfig) {
        const relaxed = relaxDependenciesForParallelism(tasks, parallelism);
        tasks = relaxed.tasks;
        if (relaxed.changes.length > 0) {
          this.sendLog(
            `Planner dependency relaxation: ${relaxed.rootCount}/${relaxed.target} runnable tasks after removing ${relaxed.changes.length} dependsOn edge(s).`,
          );
          emitEvent({
            type: 'plan.dependencies.relaxed',
            target: relaxed.target,
            rootCount: relaxed.rootCount,
            changes: relaxed.changes,
          });
        }
      }

      if (!checklistConfig) {
        tasks = ensureValidationTask({
          tasks,
          repoRoot,
          maxTasks: MAX_TOTAL_TASKS,
          log: message => this.sendLog(message),
        });
      }

      this.sendLog(`Planned ${tasks.length} tasks (parallelism=${parallelism})`);
      emitEvent({
        type: 'plan.completed',
        taskCount: tasks.length,
        parallelism,
        maxParallelism: parallelism,
        minParallelism: resolvedMinParallelism,
        autoscale: autoscaleParallelism,
        rawPlanText,
      });

      const taskStates = new Map();
      for (const task of tasks) {
        validateSharedTaskOwnership(task);
        if (USE_GIT_WORKTREES) {
          const branch = `cdx/task/${resolvedRunId}/${task.id}`;
          const worktreePath = path.join(tasksRoot, task.id);
          await createWorktree({
            repoRoot,
            worktreePath,
            branch,
            baseRef: integrationBranch,
            log: (...args) => this.sendLog(args.join(' ')),
            sparse: this.worktreeSparseConfig,
            externalize: this.worktreeExternalizeConfig,
          });
          await this.#syncProjectCodexConfigToWorktree({
            repoRoot,
            worktreePath,
            emitEvent,
            label: `task:${task.id}`,
          });
          await ensureInitialCommit({
            cwd: worktreePath,
            message: `cdx: init task ${task.id}`,
            log: (...args) => this.sendLog(args.join(' ')),
          });
          taskStates.set(task.id, new TaskState(task, { branch, worktreePath }));
          emitEvent({
            type: 'worktree.created',
            taskId: task.id,
            description: task.description,
            dependsOn: task.dependsOn,
            branch,
            worktreePath,
            checklist: task.checklist ?? null,
          });
        } else {
          const worktreePath = repoRoot;
          taskStates.set(task.id, new TaskState(task, { branch: null, worktreePath }));
          emitEvent({
            type: 'task.prepared',
            taskId: task.id,
            description: task.description,
            dependsOn: task.dependsOn,
            worktreePath,
            ownership: resolveTaskOwnedPaths(task),
            checklist: task.checklist ?? null,
          });
        }
      }

      this.taskStates = taskStates;
      this.contextStore = new ContextStore({ runId });
      this.threadToTask = new Map();
      await this.#startCoordinator({
        goal,
        repoRoot,
        tasks,
        emitEvent,
      });
      this.judgeService = new JudgeService({
        log: (...args) => this.sendLog(`[judge] ${args.join(' ')}`),
        maxConcurrency: JUDGE_MAX_CONCURRENCY,
        timeoutMs: JUDGE_TIMEOUT_MS,
        model: this.#desiredModel(),
        effort: this.#desiredEffort('judge'),
        config: this.#buildThreadConfigOverrides(),
      });

      this.sendProgress({
        progress: 0.12,
        message: `Executing tasks (${tasks.length})`,
        total: tasks.length,
      });

      const initialRun = await this.#runTasks({
        goal,
        tasks,
        taskStates,
        maxParallelism: parallelism,
        minParallelism: resolvedMinParallelism,
        autoscale: autoscaleParallelism,
        emitEvent,
        repoRoot,
        tasksRoot,
        runId: resolvedRunId,
        integrationBranch,
        checklistConfig,
        progressStart: 0.12,
        progressEnd: 0.78,
      });
      let results = initialRun.results;

      this.sendProgress({
        progress: 0.8,
        message: USE_GIT_WORKTREES ? 'Merging branches' : 'Reconciling owned file changes',
      });
      let mergeReport = await this.#mergeIntoIntegration({
        integrationPath,
        taskStates,
        tasks,
        emitEvent,
      });
      mergeReport = await this.#recoverIntegrationMerges({
        integrationPath,
        taskStates,
        mergeReport,
        emitEvent,
        stage: 'initial',
      });
      emitEvent({
        type: 'merge.completed',
        stage: 'initial',
        merged: mergeReport?.merged ?? [],
        skipped: mergeReport?.skipped ?? [],
        integrationHead: mergeReport?.integrationHead ?? null,
      });

      if (!checklistConfig && RECOVERY_WAVE_ENABLED && RECOVERY_MAX_WAVES > 0 && Array.isArray(results)) {
        let wave = 0;
        while (wave < RECOVERY_MAX_WAVES) {
          const failedTasks = results.filter(task => task.status === 'failed');
          const blockedTasks = results.filter(task => task.status === 'blocked');
          if (failedTasks.length === 0 && blockedTasks.length === 0) break;

          wave += 1;
          const completedTasks = results.filter(task => task.status === 'completed');

          const remainingCapacity = remainingTaskCapacity(MAX_TOTAL_TASKS, taskStates.size);
          const desiredCount = Math.min(
            remainingCapacity,
            Math.max(1, Math.min(parallelism, failedTasks.length + blockedTasks.length)),
          );

          emitEvent({
            type: 'recovery.started',
            wave,
            failed: failedTasks.length,
            blocked: blockedTasks.length,
            desiredCount,
            remainingCapacity: Number.isFinite(remainingCapacity) ? remainingCapacity : null,
          });

          if (desiredCount <= 0) {
            emitEvent({
              type: 'recovery.skipped',
              wave,
              reason: 'no_capacity',
            });
            break;
          }

          this.sendProgress({
            progress: 0.82,
            message: `Planning recovery tasks (wave ${wave})`,
          });

          const recoveryEvent = buildRecoveryPlanCoordinatorEvent({
            wave,
            failedTasks,
            blockedTasks,
            plannedTasks: [],
            desiredCount,
          });
          const completedRecoveryTasks = completedTasks.map(task => ({
            id: task.id,
            description: task.description,
          }));
          const failedRecoveryTasks = failedTasks.map(task => ({
            id: task.id,
            description: task.description,
            error: task.error ?? null,
          }));
          const blockedRecoveryTasks = blockedTasks.map(task => ({
            id: task.id,
            description: task.description,
            error: task.error ?? null,
          }));
          const recoveryPlanSpec = this.#agentModelEffort({ phase: 'recovery-plan' });
          const recoveryContextText = [
            'Recovery planning request:',
            `- desiredCount: ${desiredCount}`,
            '- If replacement work should be created, express it through actions.injectTasks.',
            '- Return 0 tasks when the real issue is prompt quality, over-fragmented planning, or ordinary slowness rather than genuinely failed work that needs replacement.',
            '- Avoid depending on failed or blocked task ids; depend only on completed task ids when needed.',
            '- Prefer immediately runnable tasks and explicit ownership.',
            'Completed tasks you MAY depend on:',
            completedRecoveryTasks.map(task => `- ${task.id}: ${task.description}`).join('\n') || '- none',
            'Failed tasks needing recovery coverage:',
            failedRecoveryTasks
              .map(task => `- ${task.id}: ${task.description} (reason: ${clipText(task.error ?? 'unknown', 200)})`)
              .join('\n') || '- none',
            'Blocked tasks needing recovery coverage:',
            blockedRecoveryTasks
              .map(task => `- ${task.id}: ${task.description} (reason: ${clipText(task.error ?? 'blocked', 200)})`)
              .join('\n') || '- none',
          ].join('\n\n');
          const coordinatedRecoveryPlan = await this.#coordinateEvent({
            eventType: 'recovery-plan',
            summary: recoveryEvent.summary,
            eventDetails: recoveryEvent.details,
            eventContextText: recoveryContextText,
            artifactHint: null,
            emitEvent,
            phase: 'recovery-plan',
            wave,
            source: 'recovery-plan',
            modelOverride: recoveryPlanSpec.model,
            effortOverride: recoveryPlanSpec.effort,
          });
          let recoveryTaskCount = 0;
          let injectedTaskIds = [];
          let rawRecoveryPlanText = coordinatedRecoveryPlan?.eventSummary ?? null;
          let recoveryRunPromise = null;
          const recoveryRunOptions = {
            goal,
            tasks,
            taskStates,
            maxParallelism: parallelism,
            minParallelism: resolvedMinParallelism,
            autoscale: autoscaleParallelism,
            emitEvent,
            repoRoot,
            tasksRoot,
            runId: resolvedRunId,
            integrationBranch,
            progressStart: 0.84,
            progressEnd: 0.9,
          };

          if (coordinatedRecoveryPlan?.coordinatorBacked) {
            const injectionId = coerceString(coordinatedRecoveryPlan.actionOutcome?.inject?.injectionId);
            if (!injectionId) {
              emitEvent({
                type: 'recovery.plan.empty',
                wave,
                coordinatorBacked: true,
                rawPlanText: rawRecoveryPlanText,
              });
              break;
            }
            recoveryRunPromise = this.#runTasks(recoveryRunOptions);
            const injectionOutcome = await this.#resolveQueuedRuntimeInjection({ injectionId });
            if (injectionOutcome) {
              await this.#reportCoordinatorInjectionOutcome({
                eventType: 'recovery-plan-result',
                phase: 'recovery-plan',
                wave,
                label: `Recovery wave ${wave}`,
                outcome: injectionOutcome,
                emitEvent,
              });
            }
            injectedTaskIds = Array.isArray(injectionOutcome?.taskIds)
              ? injectionOutcome.taskIds
              : [];
            recoveryTaskCount = injectedTaskIds.length;
            if (injectionOutcome?.status !== 'applied' || recoveryTaskCount === 0) {
              results = (await recoveryRunPromise).results;
              if (
                injectionOutcome?.status === 'failed'
                || injectionOutcome?.status === 'timeout'
                || injectionOutcome?.status === 'cancelled'
              ) {
                emitEvent({
                  type: 'recovery.skipped',
                  wave,
                  reason: `runtime_injection_${injectionOutcome?.status ?? 'failed'}`,
                  coordinatorBacked: true,
                  rawPlanText: rawRecoveryPlanText,
                  error:
                    injectionOutcome?.error
                    ?? `runtime injection ${injectionOutcome?.status ?? 'failed'}`,
                });
              } else {
                emitEvent({
                  type: 'recovery.plan.empty',
                  wave,
                  coordinatorBacked: true,
                  rawPlanText: rawRecoveryPlanText,
                });
              }
              break;
            }
            emitEvent({
              type: 'recovery.injected',
              wave,
              tasks: injectedTaskIds,
              taskCount: recoveryTaskCount,
              rawPlanText: rawRecoveryPlanText,
              coordinatorBacked: true,
            });
          } else {
            const recoveryPlan = await this.#planRecoveryTasks({
              goal,
              completedTasks: completedRecoveryTasks,
              failedTasks: failedRecoveryTasks,
              blockedTasks: blockedRecoveryTasks,
              desiredCount,
              emitEvent,
              wave,
              cwd: integrationPath,
            });
            rawRecoveryPlanText = recoveryPlan?.rawPlanText ?? rawRecoveryPlanText;
            await this.#coordinateEvent({
              eventType: 'recovery-plan',
              summary: recoveryEvent.summary,
              eventDetails: recoveryEvent.details,
              artifactHint: recoveryPlan?.coordination ?? null,
              emitEvent,
              phase: 'recovery-plan',
              wave,
              source: 'recovery-plan',
            });

            const planned = Array.isArray(recoveryPlan?.tasks) ? recoveryPlan.tasks : [];
            const existingIds = new Set(taskStates.keys());
            const normalised = normaliseTasks(planned, {
              existingIds,
              prefix: `recovery-w${wave}-`,
              limit: desiredCount,
              pathLayout: this.taskPathLayout,
            });

            if (normalised.length === 0) {
              emitEvent({
                type: 'recovery.plan.empty',
                wave,
              });
              break;
            }

            const failedOrBlockedIds = new Set([
              ...failedTasks.map(task => task.id),
              ...blockedTasks.map(task => task.id),
            ]);

            const newTaskIds = normalised.map(task => task.id);
            const knownIds = new Set([...existingIds, ...newTaskIds]);

            for (const newTask of normalised) {
              const deps = new Set();
              for (const dep of newTask.dependsOn ?? []) {
                if (typeof dep !== 'string') continue;
                const trimmed = dep.trim();
                if (!trimmed) continue;
                if (failedOrBlockedIds.has(trimmed)) continue;
                deps.add(trimmed);
              }
              deps.delete(newTask.id);
              newTask.dependsOn = [...deps].filter(dep => knownIds.has(dep) && !failedOrBlockedIds.has(dep));
            }

            for (const newTask of normalised) {
              if (taskLimitReached(MAX_TOTAL_TASKS, taskStates.size)) break;
              validateSharedTaskOwnership(newTask);
              let branch = null;
              let worktreePath = repoRoot;
              if (USE_GIT_WORKTREES) {
                branch = `cdx/task/${resolvedRunId}/${newTask.id}`;
                worktreePath = path.join(tasksRoot, newTask.id);
                await createWorktree({
                  repoRoot,
                  worktreePath,
                  branch,
                  baseRef: integrationBranch,
                  log: (...args) => this.sendLog(args.join(' ')),
                  sparse: this.worktreeSparseConfig,
                  externalize: this.worktreeExternalizeConfig,
                });
                await this.#syncProjectCodexConfigToWorktree({
                  repoRoot,
                  worktreePath,
                  emitEvent,
                  label: `task:${newTask.id}`,
                });
                await ensureInitialCommit({
                  cwd: worktreePath,
                  message: `cdx: init task ${newTask.id}`,
                  log: (...args) => this.sendLog(args.join(' ')),
                });
              }

              taskStates.set(newTask.id, new TaskState(newTask, { branch, worktreePath }));
              tasks.push(newTask);
              injectedTaskIds.push(newTask.id);

              emitEvent({
                type: USE_GIT_WORKTREES ? 'worktree.created' : 'task.prepared',
                taskId: newTask.id,
                description: newTask.description,
                dependsOn: newTask.dependsOn,
                branch,
                worktreePath,
                recoveryWave: wave,
                ownership: USE_GIT_WORKTREES ? undefined : resolveTaskOwnedPaths(newTask),
              });
            }

            recoveryTaskCount = injectedTaskIds.length;
            emitEvent({
              type: 'recovery.injected',
              wave,
              tasks: injectedTaskIds,
              taskCount: recoveryTaskCount,
              rawPlanText: rawRecoveryPlanText,
            });

            if (recoveryTaskCount === 0) {
              emitEvent({
                type: 'recovery.skipped',
                wave,
                reason: 'no_tasks_injected',
              });
              break;
            }
          }

          const supersededLabel = injectedTaskIds.length > 0
            ? injectedTaskIds.join(', ')
            : `${recoveryTaskCount} queued recovery task(s)`;
          const supersededReason = `Superseded by recovery wave ${wave}: ${supersededLabel}`;
          for (const staleTask of [...failedTasks, ...blockedTasks]) {
            const staleState = taskStates.get(staleTask.id);
            if (!staleState || !isFailureTaskStatus(staleState.status)) continue;
            const previousStatus = staleState.status;
            staleState.supersede({
              reason: supersededReason,
              replacementTaskIds: injectedTaskIds,
              wave,
            });
            emitEvent({
              type: 'task.superseded',
              taskId: staleTask.id,
              description: staleTask.description,
              priorStatus: previousStatus,
              replacementTaskIds: injectedTaskIds,
              wave,
              reason: supersededReason,
            });
          }

          this.sendProgress({
            progress: 0.84,
            message: `Executing recovery tasks (${recoveryTaskCount})`,
            total: taskStates.size,
          });

          const recoveryRun = recoveryRunPromise
            ? await recoveryRunPromise
            : await this.#runTasks(recoveryRunOptions);
          results = recoveryRun.results;

          this.sendProgress({
            progress: 0.9,
            message: USE_GIT_WORKTREES
              ? `Merging recovery branches (wave ${wave})`
              : `Reconciling recovery file changes (wave ${wave})`,
          });
          mergeReport = await this.#mergeIntoIntegration({
            integrationPath,
            taskStates,
            tasks,
            emitEvent,
          });
          mergeReport = await this.#recoverIntegrationMerges({
            integrationPath,
            taskStates,
            mergeReport,
            emitEvent,
            stage: `recovery-w${wave}`,
          });
          emitEvent({
            type: 'merge.completed',
            stage: 'recovery',
            wave,
            merged: mergeReport?.merged ?? [],
            skipped: mergeReport?.skipped ?? [],
            integrationHead: mergeReport?.integrationHead ?? null,
          });
        }
      }

      let integrationDiff = await hasDiffBetweenRefs({ cwd: integrationPath, baseRef: baseHeadSha });
      const mergeSkippedEntries = Array.isArray(mergeReport?.skipped) ? mergeReport.skipped : [];
      const mergeSkippedIds = mergeSkippedEntries.map(entry => entry?.id).filter(Boolean);
      let salvageReport = null;
      if (USE_GIT_WORKTREES && INTEGRATION_SALVAGE_ENABLED && (mergeSkippedIds.length > 0 || !integrationDiff)) {
        this.sendProgress({ progress: 0.91, message: 'Salvaging integration changes' });
        salvageReport = await this.#salvageIntegration({
          integrationPath,
          taskStates,
          tasks,
          baseRef: baseHeadSha,
          emitEvent,
          preferTaskIds: mergeSkippedIds,
          allowFallback: !integrationDiff,
          normalize: INTEGRATION_NORMALIZE_ENABLED,
          stage: 'final',
        });
        if (salvageReport) {
          mergeReport = {
            ...mergeReport,
            salvage: salvageReport,
            integrationHead: salvageReport.integrationHead ?? mergeReport?.integrationHead ?? null,
          };
        }
        integrationDiff = await hasDiffBetweenRefs({ cwd: integrationPath, baseRef: baseHeadSha });
      }
      const integrationTrackedCount = await countTrackedFiles({ cwd: integrationPath });
      const integrationEmpty = !integrationDiff;
      const integrationStatus = {
        baseRef: baseHeadSha,
        hasDiff: integrationDiff,
        empty: integrationEmpty,
        trackedCount: integrationTrackedCount,
      };
      mergeReport = { ...mergeReport, integration: integrationStatus };
      emitEvent({
        type: 'integration.status',
        stage: 'final',
        ...integrationStatus,
        salvage: salvageReport
          ? {
              tasks: salvageReport.tasks?.length ?? 0,
              filesCopied: salvageReport.filesCopied ?? 0,
              normalizedFiles: salvageReport.normalizedFiles ?? 0,
            }
          : null,
      });
      const integrationEmptyFatal =
        integrationEmpty
        && INTEGRATION_EMPTY_FAIL
        && !checklistConfig;

      let checkpoint = null;
      if (integrationVerifyEnabled && !integrationEmpty) {
        this.sendProgress({ progress: 0.92, message: 'Verifying integration' });
        checkpoint = await this.#verifyIntegration({ integrationPath, emitEvent, stage: 'final' });
        if (checkpoint?.commit) {
          mergeReport = {
            ...mergeReport,
            integrationHead: checkpoint.commit,
            verification: checkpoint,
          };
        }
      } else if (integrationVerifyEnabled && integrationEmpty) {
        emitEvent({
          type: 'integration.verify.skipped',
          stage: 'final',
          reason: 'integration_empty',
        });
      }

      let ff = {
        applied: false,
        reason: integrationEmpty ? 'No integration changes; skipping fast-forward.' : null,
        integrationBranch,
      };
      if (!integrationEmpty) {
        this.sendProgress({ progress: 0.94, message: 'Fast-forwarding base branch' });
        ff = await this.#fastForwardBase({
          repoRoot,
          headRef,
          integrationBranch,
          tasks: results,
          mergeSkipped: Array.isArray(mergeReport?.skipped) ? mergeReport.skipped.length : 0,
        });
      }
      emitEvent({
        type: 'fastForward.completed',
        result: ff,
      });

      let reviewResult = null;
      if (reviewEnabled) {
        if (integrationEmpty) {
          emitEvent({
            type: 'review.completed',
            stage: 'final',
            status: 'skipped',
            reason: 'integration_empty',
          });
          reviewResult = {
            status: 'skipped',
            stage: 'final',
            target: { type: 'branch', name: integrationBranch ?? 'HEAD' },
            delivery: 'inline',
            output: '',
            reason: 'integration_empty',
          };
        } else {
          this.sendProgress({ progress: 0.95, message: 'Running review' });
          const targetSha =
            typeof mergeReport?.integrationHead === 'string' && mergeReport.integrationHead.trim()
              ? mergeReport.integrationHead.trim()
              : (await git(['rev-parse', 'HEAD'], { cwd: integrationPath })).trim();
          try {
            reviewResult = await this.#reviewIntegration({
              integrationPath,
              emitEvent,
              stage: 'final',
              targetSha,
              goal,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err ?? 'review failed');
            this.sendLog(`[review] failed: ${message}`);
            emitEvent({
              type: 'review.completed',
              stage: 'final',
              status: 'failed',
              error: message,
            });
            reviewResult = {
              status: 'failed',
              stage: 'final',
              target: { type: 'commit', sha: targetSha },
              delivery: 'inline',
              output: '',
              error: message,
            };
          }
        }
      }

      this.sendProgress({
        progress: 0.96,
        message: USE_GIT_WORKTREES ? 'Cleaning up worktrees' : 'Cleaning up run metadata',
      });
      if (!KEEP_WORKTREES || !USE_GIT_WORKTREES) {
        await this.#cleanupWorktrees(repoRoot, runRoot, integrationPath, integrationBranch, taskStates);
      }

      this.sendProgress({ progress: 0.98, message: 'Generating summary' });
      const summaryText = await this.#summariseResults(
        goal,
        results,
        mergeReport,
        ff,
        reviewResult,
        includeSummary !== false,
      );

      const statusCounts = { completed: 0, superseded: 0, failed: 0, blocked: 0 };
      for (const task of results) {
        if (!task) continue;
        const status = normalizeTaskStatus(task.status);
        if (status === 'completed') statusCounts.completed += 1;
        else if (status === 'superseded') statusCounts.superseded += 1;
        else if (status === 'failed') statusCounts.failed += 1;
        else if (status === 'blocked') statusCounts.blocked += 1;
      }
      const mergeSkipped = Array.isArray(mergeReport?.skipped) ? mergeReport.skipped.length : 0;
      const integrationFailure = integrationEmptyFatal;
      const runStatus = integrationFailure
        ? 'failed'
        : statusCounts.failed > 0 || mergeSkipped > 0
          ? 'failed'
          : statusCounts.blocked > 0
            ? 'blocked'
            : 'completed';
      const errorParts = [];
      if (integrationFailure) errorParts.push('integration_empty');
      if (statusCounts.failed > 0 || statusCounts.blocked > 0 || mergeSkipped > 0) {
        errorParts.push(`tasks failed=${statusCounts.failed} blocked=${statusCounts.blocked} mergeSkipped=${mergeSkipped}`);
      }
      const runError = runStatus === 'completed' ? null : errorParts.join(' ');

      emitEvent({
        type: 'run.completed',
        status: runStatus,
        error: runError,
        completed: statusCounts.completed,
        superseded: statusCounts.superseded,
        failed: statusCounts.failed,
        blocked: statusCounts.blocked,
        mergeSkipped,
        integrationEmpty,
        integrationHasDiff: integrationStatus?.hasDiff ?? null,
        integrationTrackedCount: integrationStatus?.trackedCount ?? null,
        integrationFailure,
      });

      return {
        status: runStatus,
        error: runError,
        plan: { raw: rawPlanText, tasks },
        tasks: results,
        merge: mergeReport,
        fastForward: ff,
        review: reviewResult,
        summary: summaryText,
        metadata: {
          id: resolvedRunId,
          repoRoot,
          worktreeRoot,
          keepWorktrees: USE_GIT_WORKTREES ? KEEP_WORKTREES : false,
          worktreeMode: USE_GIT_WORKTREES ? 'git-worktree' : 'shared',
          integrationBranch,
          codexConfig: this.codexConfigMeta,
          checklist: checklistConfig,
        },
      };
    })()
      .catch(err => {
      const message = err instanceof Error ? err.message : String(err ?? 'unknown error');
      emitEvent({
        type: 'run.completed',
        status: 'failed',
        error: message,
      });
      throw err;
      })
      .finally(() => this.#cleanupSupervisor());
  }

  #parseParallelism(maxParallelism) {
    const parsed = Number.parseInt(maxParallelism, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    return null;
  }

  #parseMinParallelism(minParallelism) {
    const parsed = Number.parseInt(minParallelism, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    return Math.max(1, DEFAULT_MIN_PARALLELISM);
  }

  #shouldParallelizeGoal(goal) {
    const raw = String(goal ?? '').trim();
    if (!raw) return false;

    const normalized = raw.replace(/\s+/g, ' ').trim();
    const length = normalized.length;
    const lines = raw.split('\n').filter(line => line.trim()).length;
    const bulletLines = raw
      .split('\n')
      .filter(line => /^\s*(?:[-*]|\d+\.)\s+/.test(line))
      .length;
    const multiClause = /[;,]/.test(raw) || /\b(and|or)\b/i.test(raw);

    if (bulletLines >= 2) return true;
    if (lines >= 4) return true;
    if (length >= 400) return true;
    if (length >= 200 && multiClause) return true;
    return false;
  }

  #estimateGoalWords(goal) {
    if (!goal || typeof goal !== 'string') return 0;
    const words = goal.trim().split(/\s+/).filter(Boolean);
    return words.length;
  }

  async #countRepoFiles(repoRoot) {
    try {
      const output = await git(['ls-files'], { cwd: repoRoot });
      return output ? output.split('\n').filter(Boolean).length : 0;
    } catch {
      return null;
    }
  }

  #computeSmartSpawnDefaults({ goalWords, repoFileCount } = {}) {
    const goal = Number.isFinite(goalWords) ? goalWords : 0;
    const files = Number.isFinite(repoFileCount) ? repoFileCount : null;

    const goalBucket = goal <= 40 ? 'tiny' : goal <= 120 ? 'small' : goal <= 240 ? 'medium' : 'large';
    const repoBucket = files === null
      ? 'unknown'
      : files <= 400
        ? 'tiny'
        : files <= 2000
          ? 'small'
          : files <= 8000
            ? 'medium'
            : 'large';

    let intensity = 'medium';
    if (goalBucket === 'large' || repoBucket === 'large') {
      intensity = 'high';
    } else if (goalBucket === 'tiny' && (repoBucket === 'tiny' || repoBucket === 'unknown')) {
      intensity = 'tiny';
    } else if (goalBucket === 'small' && repoBucket === 'tiny') {
      intensity = 'small';
    } else if (goalBucket === 'tiny' && repoBucket === 'small') {
      intensity = 'small';
    } else if (goalBucket === 'small' && repoBucket === 'small') {
      intensity = 'small';
    } else if (goalBucket === 'medium' && repoBucket === 'medium') {
      intensity = 'medium';
    }

    const intensityMax = {
      tiny: 2,
      small: 3,
      medium: 5,
      high: DEFAULT_MAX_PARALLELISM,
    };
    const intensityMin = {
      tiny: 1,
      small: 2,
      medium: 3,
      high: DEFAULT_MIN_PARALLELISM,
    };

    const maxParallelism = Math.max(
      1,
      Math.min(intensityMax[intensity] ?? DEFAULT_MAX_PARALLELISM, DEFAULT_MAX_PARALLELISM),
    );
    const minParallelism = Math.max(
      1,
      Math.min(intensityMin[intensity] ?? DEFAULT_MIN_PARALLELISM, maxParallelism),
    );

    return { maxParallelism, minParallelism, intensity };
  }

  #computeSmartPlannerHints({ goalWords, repoFileCount, parallelism, smartDefaults } = {}) {
    const defaults = smartDefaults ?? this.#computeSmartSpawnDefaults({ goalWords, repoFileCount });
    const intensity = defaults?.intensity ?? 'medium';
    const multiplier = (() => {
      if (intensity === 'tiny') return 1;
      if (intensity === 'small') return 2;
      if (intensity === 'medium') return Math.min(2, PLANNER_TASK_MULTIPLIER);
      return PLANNER_TASK_MULTIPLIER;
    })();

    const minTasksFloor = Math.max(1, PLANNER_MIN_TASKS);
    const desiredBase = Number.isFinite(parallelism) && parallelism > 0
      ? Math.max(1, Math.round(parallelism * multiplier))
      : minTasksFloor;
    const plannerMinTasks = Math.max(minTasksFloor, desiredBase);

    return { intensity, plannerTaskMultiplier: multiplier, plannerMinTasks };
  }

  async #buildRepoIndex(repoRoot) {
    const resolvedRepoRoot = typeof repoRoot === 'string' && repoRoot.trim() ? repoRoot.trim() : null;
    if (!resolvedRepoRoot) return '';

    const maxChars = Math.max(
      500,
      Number.parseInt(process.env.CDX_REPO_INDEX_MAX_CHARS ?? '4000', 10) || 4000,
    );

    let files = [];
    try {
      const raw = await git(['ls-files'], { cwd: resolvedRepoRoot });
      files = raw
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? 'unknown error');
      this.sendLog(`Repo index: failed to list files (${message})`);
      return '';
    }

    const fileSet = new Set(files);
    const topLevelDirs = new Map(); // dir -> count
    const topLevelFiles = [];

    for (const file of files) {
      const parts = file.split('/');
      if (parts.length === 1) {
        topLevelFiles.push(file);
      } else if (parts[0]) {
        topLevelDirs.set(parts[0], (topLevelDirs.get(parts[0]) ?? 0) + 1);
      }
    }

    const dirLines = [...topLevelDirs.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([dir, count]) => `- ${dir}/ (${count})`);

    const fileLines = topLevelFiles
      .slice()
      .sort()
      .slice(0, 15)
      .map(name => `- ${name}`);

    const addIfExists = (list, candidate) => {
      if (fileSet.has(candidate)) list.push(candidate);
    };

    const notable = [];
    addIfExists(notable, 'README.md');
    addIfExists(notable, 'package.json');
    addIfExists(notable, 'pyproject.toml');
    addIfExists(notable, 'Cargo.toml');
    addIfExists(notable, 'go.mod');
    addIfExists(notable, 'Makefile');
    addIfExists(notable, 'Dockerfile');

    const entrypoints = [];
    for (const candidate of [
      'src/index.js',
      'src/index.ts',
      'src/main.js',
      'src/main.ts',
      'index.js',
      'index.ts',
      'main.js',
      'main.ts',
      'src/cli.js',
      'src/cli.ts',
    ]) {
      addIfExists(entrypoints, candidate);
    }

    const entrypointPattern = /^(?:src\/)?(?:.*\/)?(?:app|server|cli|index|main)\.(?:js|jsx|ts|tsx|py|go|rs)$/i;
    for (const file of files) {
      if (entrypoints.length >= 12) break;
      if (entrypoints.includes(file)) continue;
      if (entrypointPattern.test(file)) {
        entrypoints.push(file);
      }
    }

    let packageSummary = '';
    if (fileSet.has('package.json')) {
      try {
        const content = await readFile(path.join(resolvedRepoRoot, 'package.json'), 'utf8');
        const parsed = JSON.parse(content);
        const scripts = parsed?.scripts && typeof parsed.scripts === 'object' ? Object.keys(parsed.scripts) : [];
        const bins = parsed?.bin && typeof parsed.bin === 'object' ? Object.keys(parsed.bin) : [];
        const name = typeof parsed?.name === 'string' ? parsed.name : null;
        const summaryLines = [];
        if (name) summaryLines.push(`name: ${name}`);
        if (scripts.length) summaryLines.push(`scripts: ${scripts.sort().slice(0, 20).join(', ')}${scripts.length > 20 ? ', …' : ''}`);
        if (bins.length) summaryLines.push(`bin: ${bins.sort().slice(0, 10).join(', ')}${bins.length > 10 ? ', …' : ''}`);
        packageSummary = summaryLines.join('\n');
      } catch {
        packageSummary = '';
      }
    }

    const blocks = [
      `Tracked files: ${files.length}`,
      dirLines.length ? `Top-level directories:\n${dirLines.join('\n')}` : '',
      fileLines.length ? `Top-level files:\n${fileLines.join('\n')}` : '',
      notable.length ? `Notable files:\n${notable.map(name => `- ${name}`).join('\n')}` : '',
      entrypoints.length ? `Likely entrypoints:\n${entrypoints.map(name => `- ${name}`).join('\n')}` : '',
      packageSummary ? `package.json:\n${packageSummary}` : '',
    ].filter(Boolean);

    return clipText(blocks.join('\n\n'), maxChars);
  }

  async #syncProjectCodexConfigToWorktree({ repoRoot, worktreePath, emitEvent, label } = {}) {
    const sourcePath = this.codexConfigMeta?.sources?.find(source => source.layer === 'project')?.path;
    if (!sourcePath) return;

    const sourceStat = await stat(sourcePath).catch(() => null);
    if (!sourceStat?.isFile?.()) return;

    const resolvedRepoRoot = typeof repoRoot === 'string' && repoRoot ? repoRoot : null;
    const resolvedWorktreePath = typeof worktreePath === 'string' && worktreePath ? worktreePath : null;
    if (!resolvedWorktreePath) return;

    const rel = resolvedRepoRoot ? path.relative(resolvedRepoRoot, sourcePath) : '';
    const relLooksInside =
      rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.includes(`..${path.sep}`);
    const destPath = relLooksInside
      ? path.join(resolvedWorktreePath, rel)
      : path.join(resolvedWorktreePath, '.codex', 'config.toml');

    const destStat = await stat(destPath).catch(() => null);
    if (destStat?.isFile?.()) return;

    await mkdir(path.dirname(destPath), { recursive: true });
    await copyFile(sourcePath, destPath);

    emitEvent?.({
      type: 'project.config.synced',
      label: label ?? null,
      sourcePath,
      destPath,
      worktreePath: resolvedWorktreePath,
    });
  }

  async #cleanupSupervisor() {
    const emitEvent = this.activeEmitEvent ?? (() => {});
    const runId = this.activeRunId ?? null;

    await this.#stopCoordinator({ reason: 'cleanup', emitEvent });

    this.threadToTask = new Map();
    this.taskStates = null;
    this.contextStore = null;
    this.judgeService = null;
    if (this.routerAskWaiters.size > 0) {
      for (const [askId, waiter] of this.routerAskWaiters.entries()) {
        if (typeof waiter?.resolve !== 'function') continue;
        const record = this.routerAsks.get(askId) ?? null;
        const taskId = record?.taskId ?? null;
        waiter.resolve({
          decision: {
            option_id: 'UNKNOWN',
            rationale: 'Run ended before a supervisor decision was provided.',
            next_steps: [],
            risks: [],
            confidence: 0.0,
          },
          message_for_agent: 'Run ended before a supervisor decision was provided. Proceed with your best judgment.',
          meta: {
            ask_id: askId,
            run_id: record?.runId ?? runId,
            task_id: taskId,
          },
        });

        emitEvent({
          type: 'router.ask.answered',
          askId,
          taskId,
          optionId: 'UNKNOWN',
          answeredBy: 'run_cleanup',
        });
      }
    }
    this.routerAskWaiters = new Map();
    this.routerAsks = new Map();
    this.supervisorMessages = new Map();
    this.broadcastMessages = [];
    this.broadcastCursors = new Map();
    if (this.runtimeInjectionAcks.size > 0) {
      const queuedById = new Map(
        (Array.isArray(this.runtimeInjectionQueue) ? this.runtimeInjectionQueue : [])
          .filter(entry => entry?.id)
          .map(entry => [entry.id, entry]),
      );
      for (const injectionId of this.runtimeInjectionAcks.keys()) {
        const request = queuedById.get(injectionId) ?? null;
        this.#settleRuntimeInjectionOutcome({
          ok: false,
          injectionId,
          kind: request?.kind ?? null,
          source: request?.source ?? 'cleanup',
          status: 'cancelled',
          requestedTaskIds: summarizeCoordinatorTaskIds(request?.tasks, 24),
          taskIds: [],
          taskCount: 0,
          error: 'run_cleanup',
        });
      }
    }
    this.runtimeInjectionQueue = [];
    this.runtimeInjectionAcks = new Map();
    this.runtimeInjectionResults = new Map();
    this.runtimeInjectionSignalVersion = 0;
    this.runtimeInjectionSignal = createDeferred();
    this.activeRuntimeCoordinatorControl = null;
    this.routerUrl = null;
    this.activeEmitEvent = null;
    this.activeGoal = null;
    this.activeRunId = null;
    this.activeRepoRoot = null;
    this.activeModel = null;
    this.activeEffort = null;
    this.modelOverride = null;
    this.plannerModelOverride = null;
    this.taskModelOverride = null;
    this.watchdogModelOverride = null;
    this.effortOverride = null;
    this.plannerEffortOverride = null;
    this.taskEffortOverride = null;
    this.judgeEffortOverride = null;
    this.watchdogEffortOverride = null;
    this.sandboxOverride = null;
    this.webSearchModeOverride = null;
    this.analyticsEnabledOverride = null;
    this.codexConfig = null;
    this.codexConfigMeta = null;
    this.execJustification = null;
    this.workerClientArgsTemplate = null;
    this.repoIndex = null;
    this.lastTaskActivityAt = null;
    this.lastTurnCompletedAt = null;
    this.turnCounter = 0;
    this.coordinatorArtifact = null;
    this.lastCoordinatorBroadcast = null;
    this.coordinatorEventSeq = 0;
    if (this.router) {
      const router = this.router;
      this.router = null;
      await router.close().catch(() => {});
    }
  }

  #desiredModel(role = 'task') {
    const normalizedRole = typeof role === 'string' ? role.trim().toLowerCase() : '';
    const roleOverride =
      normalizedRole === 'planner'
        ? this.plannerModelOverride
        : normalizedRole === 'task'
          ? this.taskModelOverride
          : normalizedRole === 'watchdog'
            ? this.watchdogModelOverride
            : null;
    const roleEnv = normalizedRole === 'planner'
      ? pickFirstString(process.env.CDX_PLANNER_MODEL)
      : normalizedRole === 'task'
        ? pickFirstString(process.env.CDX_TASK_MODEL)
        : normalizedRole === 'watchdog'
          ? pickFirstString(process.env.CDX_WATCHDOG_MODEL)
          : null;
    const roleDefault =
      normalizedRole === 'planner'
        ? DEFAULT_PLANNER_MODEL
        : normalizedRole === 'task'
          ? DEFAULT_TASK_MODEL
          : normalizedRole === 'watchdog'
            ? DEFAULT_WATCHDOG_MODEL
            : null;
    return roleOverride
      ?? roleEnv
      ?? roleDefault
      ?? this.modelOverride
      ?? this.activeModel
      ?? DEFAULT_MODEL;
  }

  #desiredSandbox(role = 'task') {
    const normalizedRole = typeof role === 'string' ? role.trim().toLowerCase() : '';
    let desired = this.sandboxOverride ?? DEFAULT_SANDBOX;
    if (!this.sandboxOverride && normalizedRole === 'planner') {
      desired = 'read-only';
    }
    if (desired === 'danger-full-access') {
      const allowDanger = coerceBoolean(
        process.env.CDX_ALLOW_DANGER_SANDBOX ?? process.env.CDX_ALLOW_DANGER_FULL_ACCESS,
      );
      if (allowDanger === true) {
        return desired;
      }
      if (!this.dangerSandboxClamped) {
        this.dangerSandboxClamped = true;
        this.sendLog(
          '[sandbox] danger-full-access is disabled for child agents; forcing workspace-write. '
            + 'To enable, set CDX_ALLOW_DANGER_SANDBOX=1 (or use /setup-elevated-sandbox where supported).',
        );
      }
      return 'workspace-write';
    }
    return desired;
  }

  #desiredEffort(role = 'task', effortOverride = null) {
    const model = this.#desiredModel(role);
    const supported = supportedReasoningEffortsForModel(model);

    const normalizedRole = typeof role === 'string' ? role.trim().toLowerCase() : '';
    const explicitOverride = normalizeReasoningEffort(effortOverride);

    if (explicitOverride) {
      const mapped = supported ? mapReasoningEffortToSupported(explicitOverride, supported) : null;
      return mapped ?? explicitOverride;
    }

    const roleOverride =
      normalizedRole === 'planner'
        ? this.plannerEffortOverride
        : normalizedRole === 'judge'
          ? this.judgeEffortOverride
          : normalizedRole === 'watchdog'
            ? this.watchdogEffortOverride
            : this.taskEffortOverride;

    const roleEnv = normalizedRole === 'planner'
      ? pickFirstString(
        process.env.CDX_PLANNER_EFFORT,
        process.env.CDX_PLANNER_MODEL_REASONING_EFFORT,
        process.env.CDX_PLANNER_REASONING_EFFORT,
      )
      : normalizedRole === 'judge'
        ? pickFirstString(
          process.env.CDX_JUDGE_EFFORT,
          process.env.CDX_JUDGE_MODEL_REASONING_EFFORT,
          process.env.CDX_JUDGE_REASONING_EFFORT,
        )
        : normalizedRole === 'watchdog'
          ? pickFirstString(
            process.env.CDX_WATCHDOG_EFFORT,
            process.env.CDX_WATCHDOG_MODEL_REASONING_EFFORT,
            process.env.CDX_WATCHDOG_REASONING_EFFORT,
          )
          : pickFirstString(
            process.env.CDX_TASK_EFFORT,
            process.env.CDX_TASK_MODEL_REASONING_EFFORT,
            process.env.CDX_TASK_REASONING_EFFORT,
          );

    const explicitEnv = process.env.CDX_MODEL_REASONING_EFFORT;

    const roleDefault = (() => {
      if (normalizedRole === 'watchdog') {
        if (supported instanceof Set) {
          if (supported.has('medium')) return 'medium';
          if (supported.has('low')) return 'low';
          if (supported.has('high')) return 'high';
        }
        return DEFAULT_WATCHDOG_EFFORT;
      }
      if (normalizedRole === 'planner') return DEFAULT_PLANNER_EFFORT;
      if (normalizedRole === 'task') return DEFAULT_TASK_EFFORT;
      return null;
    })();

    const requested = roleOverride?.trim()
      ? roleOverride.trim()
      : roleEnv?.trim()
        ? roleEnv.trim()
        : this.effortOverride?.trim()
          ? this.effortOverride.trim()
          : explicitEnv?.trim()
            ? explicitEnv.trim()
            : roleDefault?.trim()
              ? roleDefault.trim()
              : this.activeEffort?.trim()
                ? this.activeEffort.trim()
                : defaultEffortForModel(model) ?? CODEX_CONFIG_REASONING_EFFORT;
    if (!requested || typeof requested !== 'string') return null;
    const normalizedRequested = normalizeReasoningEffort(requested);
    if (!normalizedRequested) return null;
    const mapped = supported ? mapReasoningEffortToSupported(normalizedRequested, supported) : null;
    return mapped ?? normalizedRequested;
  }

  #watchdogEffortForWave(wave = 1) {
    const model = this.#desiredModel('watchdog');
    const supported = supportedReasoningEffortsForModel(model);
    const requested = this.#desiredEffort('watchdog') ?? DEFAULT_WATCHDOG_EFFORT;
    const normalizedRequested = normalizeReasoningEffort(requested);
    if (!normalizedRequested) return null;

    const baseIndex = REASONING_EFFORT_SEQUENCE.indexOf(normalizedRequested);
    const candidates = baseIndex >= 0
      ? REASONING_EFFORT_SEQUENCE.slice(baseIndex)
      : [normalizedRequested, ...REASONING_EFFORT_SEQUENCE];
    const ramp = [];
    for (const candidate of candidates) {
      const mapped = supported
        ? mapReasoningEffortToSupported(candidate, supported) ?? candidate
        : candidate;
      const normalized = normalizeReasoningEffort(mapped);
      if (!normalized || ramp.includes(normalized)) continue;
      ramp.push(normalized);
    }
    if (ramp.length === 0) return null;

    const safeWave = Number.isFinite(wave) && wave > 0 ? Math.floor(wave) : 1;
    return ramp[Math.min(safeWave - 1, ramp.length - 1)];
  }

  #effortRoleFromPhase(phase) {
    const label = typeof phase === 'string' ? phase.trim().toLowerCase() : '';
    if (!label) return 'task';
    if (label.includes('watchdog')) return 'watchdog';
    if (label.includes('plan')) return 'planner';
    if (label.includes('review')) return 'judge';
    return 'task';
  }

  #agentModelEffort({ phase, effortOverride } = {}) {
    const effortRole = this.#effortRoleFromPhase(phase);
    const model = this.#desiredModel(effortRole);
    const effort = this.#desiredEffort(effortRole, effortOverride) ?? null;
    return { model, effort };
  }

  async #prepareWorkerClientArgsTemplate() {
    this.workerClientArgsTemplate = null;

    const command = process.env.CODEX_BIN ?? 'codex';
    const base = path.basename(command).toLowerCase();
    const looksLikeCodex = base === 'codex' || base.startsWith('codex');
    if (!looksLikeCodex) return;

    const envArgs = parseArgs(process.env.CODEX_APP_SERVER_ARGS ?? process.env.CODEX_ARGS);
    if (envArgs && envArgs.length > 0) return;

    const configuredServers = getConfigValue(this.codexConfig, 'mcp_servers');
    const entries = isObject(configuredServers) ? Object.entries(configuredServers) : [];

    const args = ['-c', 'mcp_servers={}'];
    const kept = [];
    const filtered = [];

    for (const [name, spec] of entries) {
      const serverName = coerceString(name);
      if (!serverName || !isObject(spec)) continue;

      const lowered = serverName.toLowerCase();
      if (lowered === 'router') continue;
      if (lowered === 'cdx' || lowered === 'cdx-test' || lowered.startsWith('cdx-')) {
        filtered.push(`${serverName} (recursive supervisor server)`);
        continue;
      }

      const disabled = coerceBoolean(spec.enabled) === false || coerceBoolean(spec.disabled) === true;
      if (disabled) continue;

      const loopback = parseLoopbackMcpUrl(spec.url);
      if (loopback) {
        const reachable = await probeTcpEndpoint({
          host: loopback.host,
          port: loopback.port,
          timeoutMs: LOCAL_MCP_PROBE_TIMEOUT_MS,
        });
        if (!reachable) {
          filtered.push(`${serverName} (${loopback.url} unavailable)`);
          continue;
        }
      }

      appendConfigPairs(args, `mcp_servers.${serverName}`, spec);
      kept.push(serverName);
    }

    if (this.routerUrl) {
      args.push(
        '-c',
        'mcp_servers.router.type="streamable_http"',
        '-c',
        `mcp_servers.router.url="${this.routerUrl}"`,
      );
      kept.push('router');
    }

    args.push('app-server');
    this.workerClientArgsTemplate = args;

    if (filtered.length > 0) {
      this.sendLog(`[mcp] worker agents skipped unavailable/recursive MCP servers: ${filtered.join(', ')}`);
    }
    if (kept.length > 0) {
      this.sendLog(`[mcp] worker agents enabled MCP servers: ${kept.join(', ')}`);
    }
  }

  #buildThreadConfigOverrides() {
    const overrides = {};

    if (this.webSearchModeOverride === 'on') {
      overrides['features.web_search_request'] = true;
    } else if (this.webSearchModeOverride === 'off') {
      overrides['features.web_search_request'] = false;
    } else if (this.webSearchModeOverride === 'cached') {
      overrides['features.web_search_request'] = true;
      overrides['features.web_search_cached'] = true;
    }

    if (typeof this.analyticsEnabledOverride === 'boolean') {
      overrides['analytics.enabled'] = this.analyticsEnabledOverride;
    }

    return Object.keys(overrides).length > 0 ? overrides : null;
  }

  async #ensureModelSelected({ client } = {}) {
    if (this.activeModel && this.activeEffort) return;

    const overrideModel = process.env.CDX_DEFAULT_MODEL ?? process.env.CDX_MODEL ?? null;
    const overrideEffort = process.env.CDX_MODEL_REASONING_EFFORT ?? null;
    const explicitConfigModel =
      extractConfigValue(parseArgs(process.env.CODEX_APP_SERVER_ARGS ?? process.env.CODEX_ARGS), 'model')
      ?? coerceString(getConfigValue(this.codexConfig, 'model'))
      ?? readCodexConfigScalar('model');
    const explicitConfigEffort =
      extractConfigValue(parseArgs(process.env.CODEX_APP_SERVER_ARGS ?? process.env.CODEX_ARGS), 'model_reasoning_effort')
      ?? coerceString(getConfigValue(this.codexConfig, 'model_reasoning_effort'))
      ?? CODEX_CONFIG_REASONING_EFFORT;

    const candidates = [];
    if (overrideModel && overrideModel.trim()) {
      candidates.push({
        model: overrideModel.trim(),
        effort: overrideEffort?.trim()
          ? overrideEffort.trim()
          : defaultEffortForModel(overrideModel),
      });
    }
    candidates.push(...DEFAULT_MODEL_SPECS);
    const specs = dedupeModelSpecs(candidates);

    const command = process.env.CODEX_BIN ?? 'codex';
    const base = path.basename(command).toLowerCase();
    const looksLikeCodex = base === 'codex' || base.startsWith('codex');

    const configuredModel = coerceString(overrideModel) ?? coerceString(explicitConfigModel);
    if (configuredModel) {
      const configuredEffort = normalizeReasoningEffort(overrideEffort)
        || normalizeReasoningEffort(explicitConfigEffort)
        || defaultEffortForModel(configuredModel)
        || candidates[0]?.effort
        || null;
      this.activeModel = configuredModel;
      this.activeEffort = configuredEffort;
      const labelEffort = this.activeEffort ? this.activeEffort : 'default';
      this.sendLog(`[model-select] using configured model=${this.activeModel} effort=${labelEffort}`);
      return;
    }

    let modelList = null;
    let tempClient = null;

    try {
      if (looksLikeCodex) {
        if (!client) {
          tempClient = new AppServerClient({
            approvalDecision: DEFAULT_APPROVAL_DECISION,
            approvalJustification: this.execJustification,
            log: (...args) => this.sendLog(`[model-select] ${args.join(' ')}`),
            ...this.#buildHookClientOptions({
              agentId: 'model-select',
              taskId: null,
              phase: 'model-select',
            }),
            ...this.#buildWorkerClientOptions('model-select', 'task'),
          });
          await tempClient.ensureInitialized();
          client = tempClient;
        }

        try {
          modelList = await client.request('model/list', { limit: 200 });
        } catch (err) {
          this.sendLog(`[model-select] model/list failed: ${err.message}`);
        }
      }
    } finally {
      if (tempClient) {
        await tempClient.dispose('model-select');
      }
    }

    let selection =
      (modelList ? pickModelSpecFromModelList(specs, modelList) : null)
      ?? (modelList ? pickDefaultFromModelList(modelList) : null);

    if (!selection) {
      const fallback = specs[0] ?? DEFAULT_MODEL_SPECS[0];
      selection = {
        model: fallback.model,
        effort: fallback.effort ?? defaultEffortForModel(fallback.model),
      };
    }

    this.activeModel = selection.model;
    this.activeEffort = selection.effort ?? defaultEffortForModel(selection.model);

    const labelEffort = this.activeEffort ? this.activeEffort : 'default';
    this.sendLog(`[model-select] using model=${this.activeModel} effort=${labelEffort}`);
  }

  #buildWorkerClientOptions(taskId, role = 'task', effortOverride = null) {
    const env = {
      CDX_RUN_ID: this.activeRunId ?? '',
      CDX_TASK_ID: taskId ?? '',
    };
    if (this.routerUrl) {
      env.CDX_ROUTER_URL = this.routerUrl;
    }

    const repoRoot = this.activeRepoRoot;
    const worktreePath = this.#resolveWorktreePath(taskId);
    const sharedCacheEnabled =
      typeof this.sharedCacheEnabled === 'boolean'
        ? this.sharedCacheEnabled
        : resolveSharedCacheEnabled();
    const externalizeEnabled =
      typeof this.worktreeExternalizeConfig?.enabled === 'boolean'
        ? this.worktreeExternalizeConfig.enabled
        : resolveExternalizeConfig().enabled;

    if (repoRoot && (sharedCacheEnabled || externalizeEnabled)) {
      const { env: sharedEnv } = buildSharedCacheEnv({
        repoRoot,
        worktreePath: worktreePath ?? repoRoot,
      });
      const cacheKeys = new Set([
        'XDG_CACHE_HOME',
        'npm_config_cache',
        'NPM_CONFIG_CACHE',
        'YARN_CACHE_FOLDER',
        'PNPM_STORE_PATH',
        'PIP_CACHE_DIR',
        'POETRY_CACHE_DIR',
        'PIPENV_CACHE_DIR',
        'UV_CACHE_DIR',
        'CARGO_HOME',
        'RUSTUP_HOME',
      ]);
      const buildKeys = new Set(['CARGO_TARGET_DIR', 'PYTHONPYCACHEPREFIX']);

      for (const [key, value] of Object.entries(sharedEnv)) {
        if (!value) continue;
        if (Object.hasOwn(env, key)) continue;
        if (process.env[key]) continue;
        if (cacheKeys.has(key) && !sharedCacheEnabled) continue;
        if (buildKeys.has(key) && !externalizeEnabled) continue;
        env[key] = value;
      }
    }

    const command = process.env.CODEX_BIN ?? 'codex';
    const base = path.basename(command).toLowerCase();
    const looksLikeCodex = base === 'codex' || base.startsWith('codex');
    const envArgs = parseArgs(process.env.CODEX_APP_SERVER_ARGS ?? process.env.CODEX_ARGS);
    const hasExternalArgs = Boolean(envArgs);

    const desiredEffort = looksLikeCodex ? this.#desiredEffort(role, effortOverride) : null;
    const configuredEffort = extractConfigValue(envArgs, 'model_reasoning_effort')
      ?? CODEX_CONFIG_REASONING_EFFORT;
    const normalizedConfigured = normalizeReasoningEffort(configuredEffort);
    const needsEffortOverride =
      Boolean(looksLikeCodex && desiredEffort)
      && desiredEffort !== normalizedConfigured;

    let args = null;
    if (hasExternalArgs) {
      args = [...envArgs];
    } else if (looksLikeCodex && Array.isArray(this.workerClientArgsTemplate) && this.workerClientArgsTemplate.length > 0) {
      args = [...this.workerClientArgsTemplate];
    }

    if (needsEffortOverride) {
      if (!args) args = ['app-server'];
      args = stripConfigKey(args, 'model_reasoning_effort');
      const configPair = ['-c', `model_reasoning_effort="${desiredEffort}"`];
      const insertAt = args.lastIndexOf('app-server');
      if (insertAt === -1) {
        args.push(...configPair);
      } else {
        args.splice(insertAt, 0, ...configPair);
      }
    }

    if (!args) return { env };

    return { env, args };
  }

  #resolveWorktreePath(taskId) {
    if (!taskId) return this.activeRepoRoot ?? null;
    const state = this.taskStates?.get(taskId);
    if (state?.worktreePath) return state.worktreePath;
    return this.activeRepoRoot ?? null;
  }

  #buildHookContext({ agentId, taskId, phase, threadId, turnId, itemId } = {}) {
    return {
      runId: this.activeRunId ?? null,
      agentId: agentId ?? null,
      taskId: taskId ?? null,
      phase: phase ?? null,
      threadId: threadId ?? null,
      turnId: turnId ?? null,
      itemId: itemId ?? null,
      hookModel: HOOKS_MODEL,
      hookEffort: HOOKS_EFFORT,
    };
  }

  #buildHookClientOptions({ agentId, taskId, phase } = {}) {
    if (!this.hookClient?.enabled) return {};
    const hookContext = () => this.#buildHookContext({ agentId, taskId, phase });
    const approvalHook = async ({ method, params, defaultDecision, context } = {}) => {
      const response = await this.#invokeHook({
        hook: 'approval.request',
        context: isObject(context) ? context : hookContext(),
        data: { method, params, defaultDecision },
      });
      if (!response) return null;
      this.#applyHookSteer({ response, taskId, agentId, phase });
      this.#applyHookActions({ response, taskId, agentId, phase });
      const abort = extractHookAbort(response);
      if (abort && taskId) {
        const outcome = this.requestTaskAbort({
          taskId,
          reason: abort.reason,
          source: 'hook',
        });
        if (
          !outcome?.ok
          && outcome?.error !== 'task_not_running'
          && outcome?.error !== 'abort_already_requested'
        ) {
          this.sendLog(
            `[hook] failed to abort ${taskId}: ${outcome?.error ?? 'unknown_error'}`,
          );
        }
      }
      return response;
    };
    return { approvalHook, hookContext };
  }

  async #handlePreflightHook({ hook, runId, data } = {}) {
    if (!this.hookClient?.enabled || !hook) return null;
    const context = this.#buildHookContext({
      agentId: 'preflight',
      taskId: null,
      phase: 'preflight',
    });
    if (runId) context.runId = runId;
    const response = await this.#invokeHook({ hook, context, data });
    if (!response) return null;
    this.#applyHookSteer({ response, taskId: null, agentId: 'preflight', phase: 'preflight' });
    this.#applyHookActions({ response, taskId: null, agentId: 'preflight', phase: 'preflight' });
    const abort = extractHookAbort(response);
    if (abort) {
      throw new Error(`cdx aborted by hook (${hook}): ${abort.reason}`);
    }
    return response;
  }

  async #invokeHook({ hook, context, data, timeoutMs } = {}) {
    if (!this.hookClient?.enabled || !hook) return null;
    const response = await this.hookClient.request({ hook, context, data, timeoutMs });
    return response ?? null;
  }

  #applyHookSteer({ response, taskId, agentId, phase } = {}) {
    if (!response) return { messages: [], broadcast: false };
    const messages = extractHookMessages(response);
    if (!messages || messages.length === 0) return { messages: [], broadcast: false };
    const resolvedTaskId =
      typeof taskId === 'string' && taskId.trim() ? taskId.trim() : null;
    const broadcast = extractHookBroadcast(response);
    const inferredBroadcast =
      broadcast
      || (!resolvedTaskId && coerceString(phase) === 'preflight');
    if (!resolvedTaskId && !inferredBroadcast) {
      return { messages: [], broadcast: false };
    }
    for (const message of messages) {
      this.enqueueAgentMessage({
        taskId: inferredBroadcast ? null : resolvedTaskId,
        message,
        source: 'hook',
      });
    }
    const emitEvent = this.activeEmitEvent ?? (() => {});
    emitEvent({
      type: 'hook.steer',
      taskId: inferredBroadcast ? null : resolvedTaskId ?? null,
      agentId: agentId ?? null,
      phase: phase ?? null,
      count: messages.length,
      broadcast: inferredBroadcast,
    });
    return { messages, broadcast: inferredBroadcast };
  }

  #applyHookActions({ response, taskId, agentId, phase } = {}) {
    const actions = normalizeHookActions(response);
    if (!actions || actions.length === 0) {
      return { actions: [], applied: 0 };
    }

    const emitEvent = this.activeEmitEvent ?? (() => {});
    const applied = [];

    for (const action of actions) {
      const rawType = coerceString(action?.type ?? action?.action ?? action?.kind ?? action?.name);
      const type = normalizeHookActionType(rawType);
      if (!type) continue;

      if (type === 'task_abort') {
        const resolvedTaskId =
          coerceString(action?.taskId ?? action?.task_id ?? action?.target?.taskId ?? action?.target?.task_id)
          ?? coerceString(taskId);
        if (!resolvedTaskId) continue;
        const reason =
          coerceString(action?.reason ?? action?.message ?? action?.text)
          ?? 'task abort requested';
        const source = coerceString(action?.source) ?? 'hook';
        const outcome = this.requestTaskAbort({
          taskId: resolvedTaskId,
          reason,
          source,
        });
        applied.push({ type, taskId: resolvedTaskId, ok: outcome?.ok ?? false });
        continue;
      }

      if (type === 'agent_message') {
        const message = coerceString(action?.message ?? action?.text ?? action?.prompt);
        if (!message) continue;
        const broadcastFlag = coerceBoolean(action?.broadcast);
        const defaultBroadcast =
          typeof rawType === 'string' ? rawType.toLowerCase().includes('broadcast') : false;
        const broadcast = broadcastFlag === null ? defaultBroadcast : broadcastFlag === true;
        const resolvedTaskId =
          coerceString(action?.taskId ?? action?.task_id ?? action?.target?.taskId ?? action?.target?.task_id)
          ?? coerceString(taskId);
        const source = coerceString(action?.source) ?? 'hook';
        if (!resolvedTaskId && !broadcast) {
          this.sendLog('[hook] agent_message missing taskId; dropping');
          applied.push({ type, taskId: null, ok: false, error: 'missing_task_id' });
          continue;
        }
        const outcome = this.enqueueAgentMessage({
          taskId: broadcast ? null : resolvedTaskId,
          message,
          source,
        });
        applied.push({
          type,
          taskId: broadcast ? null : resolvedTaskId,
          ok: outcome?.ok ?? false,
          broadcast,
        });
        continue;
      }

      this.sendLog(`[hook] unsupported action type: ${type}`);
    }

    if (applied.length > 0) {
      emitEvent({
        type: 'hook.action',
        taskId: coerceString(taskId) ?? null,
        agentId: agentId ?? null,
        phase: phase ?? null,
        count: applied.length,
      });
    }

    return { actions: applied, applied: applied.length };
  }

  #enqueueHookItemCompleted({ agentId, taskId, phase, method, params } = {}) {
    if (!this.hookClient?.enabled) return;
    this.hookItemQueue = this.hookItemQueue
      .then(() => this.#handleHookItemCompleted({ agentId, taskId, phase, method, params }))
      .catch(err => {
        const message = err instanceof Error ? err.message : String(err ?? 'unknown_error');
        this.sendLog(`[hook] item hook failed: ${message}`);
      });
  }

  async #handleHookItemCompleted({ agentId, taskId, phase, method, params } = {}) {
    if (!this.hookClient?.enabled || !params?.item) return null;
    const itemType = params.item.type ?? null;
    if (this.hookItemTypes instanceof Set && itemType && !this.hookItemTypes.has(itemType)) {
      return null;
    }
    const context = this.#buildHookContext({
      agentId,
      taskId,
      phase,
      threadId: params.threadId ?? null,
      turnId: params.turnId ?? params.turn?.id ?? null,
      itemId: params.itemId ?? params.item?.id ?? null,
    });
    const response = await this.#invokeHook({
      hook: 'event.item.completed',
      context,
      data: { method, params },
    });
    if (!response) return null;

    const steer = this.#applyHookSteer({ response, taskId, agentId, phase });
    const actionOutcome = this.#applyHookActions({ response, taskId, agentId, phase });
    const abort = extractHookAbort(response);
    if (abort && taskId) {
      const outcome = this.requestTaskAbort({
        taskId,
        reason: abort.reason,
        source: 'hook',
      });
      if (
        !outcome?.ok
        && outcome?.error !== 'task_not_running'
        && outcome?.error !== 'abort_already_requested'
      ) {
        this.sendLog(
          `[hook] failed to abort ${taskId}: ${outcome?.error ?? 'unknown_error'}`,
        );
      }
    }

    const emitEvent = this.activeEmitEvent ?? (() => {});
    emitEvent({
      type: 'hook.response',
      hook: 'event.item.completed',
      taskId,
      agentId: agentId ?? null,
      phase: phase ?? null,
      actions: {
        steer: steer.messages.length,
        abort: Boolean(abort),
        action: actionOutcome.applied,
      },
    });

    return { response, steer, abort, actionOutcome };
  }

  async #handleHookTurnCompleted({
    agentId,
    taskId,
    phase,
    threadId,
    turn,
    goal,
    task,
  } = {}) {
    if (!this.hookClient?.enabled || !turn) return null;
    const context = this.#buildHookContext({
      agentId,
      taskId,
      phase,
      threadId,
      turnId: turn.turnId ?? null,
    });
    const response = await this.#invokeHook({
      hook: 'event.turn.completed',
      context,
      data: {
        goal,
        task: task
          ? { id: task.id ?? null, description: task.description ?? null }
          : null,
        output: turn.text ?? null,
        model: turn.model ?? null,
        usage: turn.usage ?? null,
        estimated: turn.estimated ?? null,
      },
    });
    if (!response) return null;

    const steer = this.#applyHookSteer({ response, taskId, agentId, phase });
    const actionOutcome = this.#applyHookActions({ response, taskId, agentId, phase });
    const abort = extractHookAbort(response);
    if (abort && taskId) {
      const outcome = this.requestTaskAbort({
        taskId,
        reason: abort.reason,
        source: 'hook',
      });
      if (
        !outcome?.ok
        && outcome?.error !== 'task_not_running'
        && outcome?.error !== 'abort_already_requested'
      ) {
        this.sendLog(
          `[hook] failed to abort ${taskId}: ${outcome?.error ?? 'unknown_error'}`,
        );
      }
    }
    const retry = extractHookRetry(response);

    const emitEvent = this.activeEmitEvent ?? (() => {});
    emitEvent({
      type: 'hook.response',
      hook: 'event.turn.completed',
      taskId,
      agentId: agentId ?? null,
      phase: phase ?? null,
      actions: {
        steer: steer.messages.length,
        abort: Boolean(abort),
        retry: Boolean(retry),
        action: actionOutcome.applied,
      },
    });

    return { response, steer, abort, retry, actionOutcome };
  }

  #buildHookRetryPrompt({ retry } = {}) {
    const prompt = coerceString(retry?.prompt);
    if (prompt) return prompt;
    const reason = coerceString(retry?.reason);
    const reasonLine = reason ? `Reason: ${reason}\n\n` : '';
    return `The hook backend requested a retry.\n${reasonLine}Follow the supervisor messages and continue the task.`;
  }

  async #handleHookTurnCompletedNonTask({
    agentId,
    taskId,
    phase,
    threadId,
    turn,
    goal,
    task,
  } = {}) {
    const outcome = await this.#handleHookTurnCompleted({
      agentId,
      taskId,
      phase,
      threadId,
      turn,
      goal,
      task,
    });
    if (!outcome) return null;

    const agentLabel =
      typeof agentId === 'string' && agentId.trim() ? agentId.trim() : 'agent';
    const phaseLabel =
      typeof phase === 'string' && phase.trim() ? phase.trim() : 'unknown';

    if (outcome.abort) {
      const reason = outcome.abort.reason ?? 'hook requested abort';
      this.sendLog(`[${agentLabel}] hook abort ignored (phase=${phaseLabel}, reason=${reason})`);
    }
    if (outcome.retry) {
      this.sendLog(`[${agentLabel}] hook retry ignored (phase=${phaseLabel})`);
    }
    return outcome;
  }

  #looksLikeQuestion(text) {
    if (!text || typeof text !== 'string') return false;
    const trimmed = text.trim();
    if (!trimmed) return false;
    if (/\?\s*$/.test(trimmed)) return true;
    return /(what should i do|which option|please advise|need your input|can you confirm|should we)/i.test(
      trimmed,
    );
  }

  #looksLikeDone(text) {
    if (!text || typeof text !== 'string') return false;
    const trimmed = text.trim();
    if (!trimmed) return false;
    if (/\b(incomplete|not complete|not yet complete|unfinished|remaining work|work remains|still need)\b/i.test(trimmed)) {
      return false;
    }
    return /(^work complete:|\bdone\b|\bcomplete(?:d)?\b|no remaining|nothing left|\bfinished\b|\ball set\b)/i.test(trimmed);
  }

  #looksLikePendingWork(text) {
    if (!text || typeof text !== 'string') return false;
    const trimmed = text.trim();
    if (!trimmed || this.#looksLikeDone(trimmed)) return false;
    return /(remaining work|work remains|still need(?:s)?|need(?:s)? to|left to do|todo|to-do|follow[- ]?up|next step|pending|unfinished|not complete|not yet complete|continue working|continue with|more work|blocked on|waiting on|requires?(?: a)? decision|need (?:your|supervisor) input|haven't|have not|did not|couldn't|unable to finish)/i.test(trimmed);
  }

  #shouldContinueTaskTurn(text, { requestedExplicitConfirmation = false } = {}) {
    if (!text || typeof text !== 'string') return true;
    if (this.#looksLikeDone(text)) return false;
    if (this.#looksLikeQuestion(text)) return true;
    if (this.#looksLikePendingWork(text)) return true;
    return !requestedExplicitConfirmation;
  }

  #shouldRespawnIncompleteTask(text) {
    if (!text || typeof text !== 'string') return true;
    if (this.#looksLikeDone(text)) return false;
    return this.#looksLikeQuestion(text) || this.#looksLikePendingWork(text);
  }

  async #handleRouterAsk({ askId, args }) {
    const emitEvent = this.activeEmitEvent ?? (() => {});
    const normalized = isObject(args) ? args : {};

    const threadId = normalized.thread_id ?? normalized.threadId ?? null;
    const explicitTaskId = normalized.task_id ?? normalized.taskId ?? normalized.task ?? null;
    const taskId = explicitTaskId ?? (threadId ? this.threadToTask.get(threadId) ?? null : null);
    const turnId = normalized.turn_id ?? normalized.turnId ?? null;

    emitEvent({ type: 'router.ask.received', askId, taskId });

    const context = this.contextStore?.snapshot(taskId) ?? {
      runId: this.activeRunId,
      taskId,
      recentText: '',
      recentEvents: [],
    };

    const mode =
      normalizeRouterMode(normalized.router_mode ?? normalized.routerMode ?? normalized.mode)
      ?? this.routerMode;

    const question = typeof normalized.question === 'string' ? normalized.question.trim() : '';
    const options = Array.isArray(normalized.options) ? normalized.options : [];
    const constraints = Array.isArray(normalized.constraints) ? normalized.constraints : [];
    const desiredOutput =
      typeof normalized.desired_output === 'string' ? normalized.desired_output.trim() : null;
    const metadata = isObject(normalized.metadata) ? { ...normalized.metadata } : null;
    const autoAnswer = isObject(normalized.autoAnswer)
      ? { ...normalized.autoAnswer }
      : isObject(normalized.auto_answer)
        ? { ...normalized.auto_answer }
        : null;

    const timeoutOverrideRaw =
      normalized.timeoutMs ?? normalized.timeout_ms ?? normalized.timeout ?? null;
    const timeoutOverride = Number.parseInt(timeoutOverrideRaw, 10);
    const timeoutMs = Number.isFinite(timeoutOverride) && timeoutOverride > 0
      ? timeoutOverride
      : mode === 'hybrid'
        ? this.routerHybridWaitMs
        : this.routerAskTimeoutMs;

    const record = {
      askId,
      runId: this.activeRunId ?? null,
      taskId: taskId ?? null,
      threadId: threadId ?? null,
      turnId: turnId ?? null,
      mode,
      timeoutMs,
      question,
      options,
      constraints,
      desiredOutput,
      metadata,
      autoAnswer,
      createdAt: Date.now(),
      status: 'pending',
      answeredAt: null,
      answeredBy: null,
      decision: null,
      messageForAgent: null,
    };
    this.routerAsks.set(askId, record);

    if (mode === 'supervised' || mode === 'hybrid') {
      const waiter = createDeferred();
      this.routerAskWaiters.set(askId, waiter);

      const contextPreview =
        typeof context?.recentText === 'string' && context.recentText
          ? context.recentText.slice(-ROUTER_EVENT_CONTEXT_CHARS)
          : '';
      const promptPreview = Array.isArray(context?.recentPrompts) && context.recentPrompts.length > 0
        ? clipText(
          context.recentPrompts
            .slice(-2)
            .map(prompt => prompt?.text ?? '')
            .filter(Boolean)
            .join('\n\n'),
          ROUTER_EVENT_CONTEXT_CHARS,
        )
        : '';

      emitEvent({
        type: 'router.ask.pending',
        askId,
        taskId,
        threadId,
        turnId,
        mode,
        timeoutMs,
        question,
        options,
        constraints,
        desiredOutput,
        metadata,
        autoAnswer,
        contextPreview: [promptPreview ? `Recent prompt:\n${promptPreview}` : '', contextPreview]
          .filter(Boolean)
          .join('\n\n'),
      });

      let timer = null;
      try {
        const raced = await Promise.race([
          waiter.promise.then(value => ({ ok: true, value })),
          new Promise(resolve => {
            if (!timeoutMs) return resolve({ ok: false, timedOut: true });
            timer = setTimeout(() => resolve({ ok: false, timedOut: true }), timeoutMs);
            timer.unref?.();
          }),
        ]);

        if (raced?.ok) {
          const value = raced.value;
          if (record.status === 'pending') {
            record.status = 'answered';
            record.answeredAt = Date.now();
            record.answeredBy = 'supervisor';
            record.messageForAgent = value?.message_for_agent ?? null;
            record.decision = value?.decision ?? null;
          }

          return value;
        }

        emitEvent({
          type: 'router.ask.timeout',
          askId,
          taskId,
          threadId,
          turnId,
          mode,
          timeoutMs,
        });

        record.status = 'timed_out';
        record.answeredAt = Date.now();
        record.answeredBy = 'timeout';

        if (!this.judgeService || typeof this.judgeService.judge !== 'function') {
          const fallback = {
            decision: {
              option_id: 'UNKNOWN',
              rationale: 'Supervisor timed out and judge service was not available.',
              next_steps: [],
              risks: [],
              confidence: 0.0,
            },
            message_for_agent: 'Supervisor timed out and judge service was not available. Proceed with your best judgment.',
            meta: {
              ask_id: askId,
              run_id: this.activeRunId ?? null,
              task_id: taskId ?? null,
            },
            meta2: {
              fallback: 'none',
              reason: 'router.ask timeout and judge unavailable',
            },
          };

          record.status = 'answered';
          record.answeredBy = 'timeout_no_judge';
          record.decision = fallback.decision;
          record.messageForAgent = fallback.message_for_agent;

          emitEvent({
            type: 'router.ask.answered',
            askId,
            taskId,
            optionId: fallback.decision.option_id,
            answeredBy: record.answeredBy,
          });

          return fallback;
        }

        // Safety fallback: use judge when supervisor didn't answer in time.
        emitEvent({ type: 'router.ask.judge.started', askId, taskId, reason: 'timeout' });
        const cwd = taskId ? this.taskStates?.get(taskId)?.worktreePath : null;
        const judged = await this.judgeService.judge({
          askId,
          ask: normalized,
          context,
          goal: this.activeGoal,
          cwd,
        });
        emitEvent({
          type: 'router.ask.judge.completed',
          askId,
          taskId,
          optionId: judged?.decision?.option_id ?? null,
          confidence: judged?.decision?.confidence ?? null,
        });

        const result = {
          ...judged,
          meta: {
            ask_id: askId,
            run_id: this.activeRunId ?? null,
            task_id: taskId ?? null,
          },
          meta2: {
            fallback: 'judge',
            reason: 'router.ask timeout in supervised mode',
          },
        };

        record.status = 'answered';
        record.answeredBy = 'judge_fallback';
        record.decision = judged?.decision ?? null;
        record.messageForAgent = judged?.message_for_agent ?? null;

        return result;
      } finally {
        if (timer) clearTimeout(timer);
        this.routerAskWaiters.delete(askId);
      }
    }

    emitEvent({ type: 'router.ask.judge.started', askId, taskId });

    if (!this.judgeService || typeof this.judgeService.judge !== 'function') {
      const fallback = {
        decision: {
          option_id: 'UNKNOWN',
          rationale: 'Judge service was not available yet.',
          next_steps: [],
          risks: [],
          confidence: 0.0,
        },
        message_for_agent: 'Judge service was not available. Proceed with your best judgment.',
      };

      record.status = 'answered';
      record.answeredAt = Date.now();
      record.answeredBy = 'judge_unavailable';
      record.decision = fallback.decision;
      record.messageForAgent = fallback.message_for_agent;

      emitEvent({
        type: 'router.ask.answered',
        askId,
        taskId,
        optionId: fallback.decision.option_id,
        answeredBy: record.answeredBy,
      });

      return {
        ...fallback,
        meta: {
          ask_id: askId,
          run_id: this.activeRunId ?? null,
          task_id: taskId ?? null,
        },
        meta2: {
          fallback: 'none',
          reason: 'judge unavailable',
        },
      };
    }

    const cwd = taskId ? this.taskStates?.get(taskId)?.worktreePath : null;
    const result = await this.judgeService.judge({
      askId,
      ask: normalized,
      context,
      goal: this.activeGoal,
      cwd,
    });

    emitEvent({
      type: 'router.ask.judge.completed',
      askId,
      taskId,
      optionId: result?.decision?.option_id ?? null,
      confidence: result?.decision?.confidence ?? null,
    });

    record.status = 'answered';
    record.answeredAt = Date.now();
    record.answeredBy = 'judge';
    record.decision = result?.decision ?? null;
    record.messageForAgent = result?.message_for_agent ?? null;

    return {
      ...result,
      meta: {
        ask_id: askId,
        run_id: this.activeRunId ?? null,
        task_id: taskId ?? null,
      },
    };
  }

  listPendingRouterAsks() {
    const pending = [];
    for (const record of this.routerAsks.values()) {
      if (record?.status !== 'pending') continue;
      pending.push({
        askId: record.askId,
        runId: record.runId,
        taskId: record.taskId,
        threadId: record.threadId,
        turnId: record.turnId,
        mode: record.mode,
        timeoutMs: record.timeoutMs,
        question: record.question,
        options: record.options,
        constraints: record.constraints,
        desiredOutput: record.desiredOutput,
        metadata: record.metadata ?? null,
        autoAnswer: record.autoAnswer ?? null,
        createdAt: record.createdAt,
      });
    }
    pending.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    return pending;
  }

  answerRouterAsk({ askId, response, answeredBy } = {}) {
    const emitEvent = this.activeEmitEvent ?? (() => {});
    const resolvedAskId = typeof askId === 'string' && askId.trim() ? askId.trim() : null;
    if (!resolvedAskId) {
      return { ok: false, error: 'missing_ask_id' };
    }

    const waiter = this.routerAskWaiters.get(resolvedAskId);
    const record = this.routerAsks.get(resolvedAskId) ?? null;
    if (!waiter || typeof waiter.resolve !== 'function' || !record || record.status !== 'pending') {
      return { ok: false, error: 'ask_not_pending' };
    }

    const value = (() => {
      const raw = response?.result ?? response?.answer ?? response ?? null;
      if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (isObject(parsed)) return parsed;
          } catch {
            // ignore and treat as plain text
          }
        }

        const token = trimmed.split(/\s+/).filter(Boolean);
        if (token.length === 1) {
          const normalized = token[0].toLowerCase();
          const optionMatch = Array.isArray(record.options)
            ? record.options.find(opt => typeof opt?.id === 'string' && opt.id.trim().toLowerCase() === normalized)
            : null;
          if (optionMatch?.id) {
            return {
              decision: {
                option_id: optionMatch.id,
                rationale: 'Supervisor selected an option.',
                next_steps: [],
                risks: [],
                confidence: null,
              },
              message_for_agent: '',
            };
          }
        }

        return { message_for_agent: trimmed };
      }
      if (!isObject(raw)) return {};
      return raw;
    })();

    const messageForAgentRaw =
      typeof value.message_for_agent === 'string'
        ? value.message_for_agent
        : typeof value.messageForAgent === 'string'
          ? value.messageForAgent
          : typeof value.message === 'string'
            ? value.message
            : '';

    const messageForAgent = messageForAgentRaw.trim()
      ? messageForAgentRaw.trim()
      : 'Proceed with the best option and continue.';

    const decision = isObject(value.decision)
      ? value.decision
      : (() => {
          const firstOptionId = Array.isArray(record.options)
            ? record.options.find(opt => typeof opt?.id === 'string' && opt.id.trim())?.id
            : null;
          return {
            option_id: firstOptionId ?? 'UNKNOWN',
            rationale: 'Supervisor provided guidance.',
            next_steps: [],
            risks: [],
            confidence: null,
          };
        })();

    const result = {
      ...value,
      decision,
      message_for_agent: messageForAgent,
      meta: {
        ask_id: resolvedAskId,
        run_id: record.runId ?? null,
        task_id: record.taskId ?? null,
      },
    };

    record.status = 'answered';
    record.answeredAt = Date.now();
    record.answeredBy = typeof answeredBy === 'string' && answeredBy.trim()
      ? answeredBy.trim()
      : 'supervisor';
    record.decision = decision;
    record.messageForAgent = messageForAgent;

    emitEvent({
      type: 'router.ask.answered',
      askId: resolvedAskId,
      taskId: record.taskId ?? null,
      optionId: decision?.option_id ?? null,
      answeredBy: record.answeredBy,
    });

    waiter.resolve(result);
    this.routerAskWaiters.delete(resolvedAskId);
    this.#wakeRuntimeInjectionScheduler('router.ask.answer');

    return {
      ok: true,
      askId: resolvedAskId,
      runId: record.runId ?? null,
      taskId: record.taskId ?? null,
    };
  }

  enqueueAgentMessage({ taskId, message, source } = {}) {
    const emitEvent = this.activeEmitEvent ?? (() => {});
    const resolvedMessage =
      typeof message === 'string' && message.trim()
        ? clipText(message, AGENT_MESSAGE_MAX_CHARS)
        : null;
    if (!resolvedMessage) {
      return { ok: false, error: 'missing_message' };
    }

    const entry = {
      id: `msg-${randomUUID().slice(0, 8)}`,
      text: resolvedMessage,
      createdAt: Date.now(),
      source: typeof source === 'string' && source.trim() ? source.trim() : 'supervisor',
    };

    const resolvedTaskId =
      typeof taskId === 'string' && taskId.trim() ? taskId.trim() : null;

    if (!resolvedTaskId) {
      this.broadcastMessages.push(entry);
      if (this.broadcastMessages.length > AGENT_MESSAGE_QUEUE_LIMIT) {
        this.broadcastMessages.splice(
          0,
          this.broadcastMessages.length - AGENT_MESSAGE_QUEUE_LIMIT,
        );
      }

      emitEvent({
        type: 'agent.message.queued',
        scope: 'broadcast',
        messageId: entry.id,
        source: entry.source,
        preview: clipText(entry.text, AGENT_MESSAGE_PREVIEW_CHARS),
      });

      return { ok: true, scope: 'broadcast', messageId: entry.id };
    }

    const queue = this.supervisorMessages.get(resolvedTaskId) ?? [];
    queue.push(entry);
    if (queue.length > AGENT_MESSAGE_QUEUE_LIMIT) {
      queue.splice(0, queue.length - AGENT_MESSAGE_QUEUE_LIMIT);
    }
    this.supervisorMessages.set(resolvedTaskId, queue);

    emitEvent({
      type: 'agent.message.queued',
      scope: 'task',
      taskId: resolvedTaskId,
      messageId: entry.id,
      source: entry.source,
      preview: clipText(entry.text, AGENT_MESSAGE_PREVIEW_CHARS),
    });

    return { ok: true, scope: 'task', taskId: resolvedTaskId, messageId: entry.id };
  }

  enqueueRuntimeInjection({ tasks, kind, source, policy } = {}) {
    const emitEvent = this.activeEmitEvent ?? (() => {});
    const plannedTasks = Array.isArray(tasks)
      ? tasks.map(cloneRuntimeTaskInput).filter(Boolean)
      : [];
    if (plannedTasks.length === 0) {
      return { ok: false, error: 'missing_tasks' };
    }

    const requestId = `inject-${randomUUID().slice(0, 8)}`;
    this.runtimeInjectionResults.delete(requestId);
    this.runtimeInjectionAcks.set(requestId, createDeferred());
    const request = {
      id: requestId,
      createdAt: Date.now(),
      kind: typeof kind === 'string' && kind.trim() ? kind.trim() : 'runtime',
      source: typeof source === 'string' && source.trim() ? source.trim() : 'supervisor',
      tasks: plannedTasks,
      policy:
        policy && typeof policy === 'object'
          ? {
            kind: coerceString(policy.kind),
            allowInternalDeps: policy.allowInternalDeps === true,
            allowedExternalDepIds: uniqueList(policy.allowedExternalDepIds ?? []),
            dropDepIds: uniqueList(policy.dropDepIds ?? []),
          }
          : null,
    };

    this.runtimeInjectionQueue.push(request);
    emitEvent({
      type: 'runtime.injection.queued',
      injectionId: request.id,
      kind: request.kind,
      source: request.source,
      taskCount: request.tasks.length,
      requestedTaskIds: request.tasks
        .map(task => coerceString(task?.id))
        .filter(Boolean),
    });
    this.sendLog(
      `[runtime] queued ${request.tasks.length} ${request.kind} task(s) from ${request.source}`,
    );
    this.#wakeRuntimeInjectionScheduler(request.kind);

    return {
      ok: true,
      injectionId: request.id,
      kind: request.kind,
      source: request.source,
      taskCount: request.tasks.length,
      requestedTaskIds: request.tasks
        .map(task => coerceString(task?.id))
        .filter(Boolean),
    };
  }

  requestTaskAbort({ taskId, reason, source } = {}) {
    const resolvedTaskId =
      typeof taskId === 'string' && taskId.trim() ? taskId.trim() : null;
    if (!resolvedTaskId) {
      return { ok: false, error: 'missing_task_id' };
    }
    const state = this.taskStates?.get(resolvedTaskId);
    if (!state) {
      return { ok: false, error: 'unknown_task' };
    }
    if (state.status !== 'running') {
      return { ok: false, error: 'task_not_running', status: state.status };
    }

    const resolvedReason =
      typeof reason === 'string' && reason.trim() ? reason.trim() : 'task abort requested';
    const resolvedSource =
      typeof source === 'string' && source.trim() ? source.trim() : 'manual';

    const ok = state.requestAbort(resolvedReason);
    if (!ok) {
      return {
        ok: false,
        error: 'abort_already_requested',
        taskId: resolvedTaskId,
        reason: state.abortReason ?? resolvedReason,
      };
    }

    const emitEvent = this.activeEmitEvent ?? (() => {});
    emitEvent({
      type: 'task.abort.requested',
      taskId: resolvedTaskId,
      reason: resolvedReason,
      source: resolvedSource,
    });
    this.sendLog(`[${resolvedSource}] aborting ${resolvedTaskId}: ${resolvedReason}`);

    return { ok: true, taskId: resolvedTaskId, reason: resolvedReason };
  }

  listAgentMessages({ taskId, includeBroadcast } = {}) {
    const resolvedTaskId =
      typeof taskId === 'string' && taskId.trim() ? taskId.trim() : null;
    const includeBroadcastResolved =
      includeBroadcast === undefined ? true : coerceBoolean(includeBroadcast);

    const broadcast =
      includeBroadcastResolved !== false
        ? this.broadcastMessages.map(msg => ({ ...msg }))
        : [];

    if (!resolvedTaskId) {
      const tasks = {};
      for (const [key, value] of this.supervisorMessages.entries()) {
        tasks[key] = Array.isArray(value) ? value.map(msg => ({ ...msg })) : [];
      }
      return { broadcast, tasks };
    }

    return {
      broadcast,
      tasks: {
        [resolvedTaskId]: (this.supervisorMessages.get(resolvedTaskId) ?? []).map(msg => ({ ...msg })),
      },
    };
  }

  clearAgentMessages({ taskId } = {}) {
    const emitEvent = this.activeEmitEvent ?? (() => {});
    const resolvedTaskId =
      typeof taskId === 'string' && taskId.trim() ? taskId.trim() : null;

    if (!resolvedTaskId) {
      const droppedBroadcast = this.broadcastMessages.length;
      const droppedTasks = this.supervisorMessages.size;
      this.broadcastMessages = [];
      this.broadcastCursors = new Map();
      this.supervisorMessages = new Map();
      emitEvent({
        type: 'agent.message.cleared',
        scope: 'all',
        droppedBroadcast,
        droppedTasks,
      });
      return { ok: true, scope: 'all', droppedBroadcast, droppedTasks };
    }

    const droppedTasks = (this.supervisorMessages.get(resolvedTaskId) ?? []).length;
    this.supervisorMessages.delete(resolvedTaskId);
    this.broadcastCursors.set(resolvedTaskId, this.broadcastMessages.length);
    emitEvent({
      type: 'agent.message.cleared',
      scope: 'task',
      taskId: resolvedTaskId,
      droppedTasks,
    });
    return { ok: true, scope: 'task', taskId: resolvedTaskId, droppedTasks };
  }

  #drainAgentMessagesForTask(taskId) {
    const resolvedTaskId = typeof taskId === 'string' ? taskId : '';
    const drained = [];

    const cursor = this.broadcastCursors.get(resolvedTaskId) ?? 0;
    if (cursor < this.broadcastMessages.length) {
      drained.push(...this.broadcastMessages.slice(cursor));
      this.broadcastCursors.set(resolvedTaskId, this.broadcastMessages.length);
    }

    const queue = this.supervisorMessages.get(resolvedTaskId);
    if (Array.isArray(queue) && queue.length > 0) {
      drained.push(...queue);
      this.supervisorMessages.delete(resolvedTaskId);
    }

    return drained;
  }

  #withAgentMessages(taskId, text) {
    const messages = this.#drainAgentMessagesForTask(taskId);
    if (!messages || messages.length === 0) return text;

    const emitEvent = this.activeEmitEvent ?? (() => {});
    emitEvent({
      type: 'agent.message.delivered',
      taskId,
      messageIds: messages.map(msg => msg.id),
      count: messages.length,
    });

    const formatted = messages
      .map(msg => {
        const header = `[${msg.id}] (${msg.source ?? 'supervisor'})`;
        return `${header}\n${msg.text}`;
      })
      .join('\n\n');

    const block = `Supervisor messages (read and follow):\n\n${formatted}`;
    return `${text}\n\n${block}`;
  }

  #emitPromptEvent({ emitter, agentId, taskId, phase, threadId, method, params, text }) {
    if (!STREAM_PROMPTS) return;
    const emit = typeof emitter === 'function' ? emitter : this.activeEmitEvent;
    if (!emit || !agentId) return;
    emit({
      type: 'prompt.sent',
      agentId,
      taskId: taskId ?? null,
      phase: phase ?? null,
      threadId: threadId ?? null,
      method: method ?? null,
      params: params ?? null,
      text: typeof text === 'string' ? text : null,
    });
  }

  #recordTaskActivity({ taskId, method, params }) {
    if (!taskId || !this.taskStates) return;
    const state = this.taskStates.get(taskId);
    if (!state || state.status !== 'running') return;

    const now = Date.now();
    this.lastTaskActivityAt = now;
    if (method === 'turn/completed') {
      this.turnCounter = Number.isFinite(this.turnCounter) ? this.turnCounter + 1 : 1;
      this.lastTurnCompletedAt = now;
    }

    const activity = (() => {
      if (method === 'item/started' || method === 'item/completed') {
        const item = params?.item;
        const type = item?.type ?? null;
        if (type === 'commandExecution') {
          const command = item?.command ?? '';
          const status = item?.status ?? '';
          return `command ${status}`.trim() + (command ? `: ${command}` : '');
        }
        if (type === 'fileChange') return 'fileChange';
        if (type === 'mcpToolCall') {
          const server = item?.server ?? '';
          const tool = item?.tool ?? '';
          return server || tool ? `tool ${server}/${tool}`.trim() : 'tool';
        }
        if (type === 'agentMessage') return 'agentMessage';
      }
      if (method === 'turn/completed') {
        const status = params?.turn?.status ?? params?.status ?? null;
        return status ? `turn ${status}` : 'turn completed';
      }
      return method ?? null;
    })();

    const meta = (() => {
      const out = { method };
      if (method === 'item/started' || method === 'item/completed') {
        const item = params?.item ?? null;
        const itemType = item?.type ?? null;
        if (itemType) {
          out.itemType = itemType;
          if (item?.status) out.itemStatus = item.status;
        }
        if (itemType === 'commandExecution') {
          if (item?.command) out.command = item.command;
        } else if (itemType === 'mcpToolCall') {
          if (item?.server) out.server = item.server;
          if (item?.tool) out.tool = item.tool;
        }
      } else if (method === 'turn/completed') {
        const status = params?.turn?.status ?? params?.status ?? null;
        if (status) out.turnStatus = status;
      }
      return out;
    })();

    const clipped = activity ? clipText(activity, 140) : null;
    state.recordActivity(clipped, meta);
  }

  #recordRateLimitEvent({ method, params }) {
    if (!RATE_LIMIT_ADAPTIVE) return;
    const now = Date.now();
    const snapshot = deriveRateLimitPressureState({ method, params }, { now });
    if (snapshot) {
      this.rateLimitSnapshot = refreshRateLimitSignal(snapshot, now);
      return;
    }

    const failure = extractRateLimitFailureState({ method, params }, { now });
    if (!failure) return;

    this.rateLimitFailure = refreshRateLimitSignal(failure, now);
    if (!Array.isArray(this.rateLimitEvents)) this.rateLimitEvents = [];
    this.rateLimitEvents.push(now);
    this.rateLimitLastAt = now;
    const cutoff = now - RATE_LIMIT_WINDOW_MS;
    while (this.rateLimitEvents.length > 0 && this.rateLimitEvents[0] < cutoff) {
      this.rateLimitEvents.shift();
    }
  }

  #recordRateLimitFailureCandidate(candidate, method = 'error') {
    if (!RATE_LIMIT_ADAPTIVE) return;
    const now = Date.now();
    const failure = extractRateLimitFailureState({ method, params: candidate }, { now });
    if (!failure) return;
    this.rateLimitFailure = refreshRateLimitSignal(failure, now);
    if (!Array.isArray(this.rateLimitEvents)) this.rateLimitEvents = [];
    this.rateLimitEvents.push(now);
    this.rateLimitLastAt = now;
    const cutoff = now - RATE_LIMIT_WINDOW_MS;
    while (this.rateLimitEvents.length > 0 && this.rateLimitEvents[0] < cutoff) {
      this.rateLimitEvents.shift();
    }
  }

  #getRateLimitWindowStats(now) {
    const snapshotCutoff = now - Math.max(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_UP_IDLE_MS);
    const failureCutoff = now - RATE_LIMIT_WINDOW_MS;
    const rawSnapshot = refreshRateLimitSignal(this.rateLimitSnapshot, now);
    const rawFailure = refreshRateLimitSignal(this.rateLimitFailure, now);
    const snapshot = (rawSnapshot?.observedAt ?? 0) >= snapshotCutoff ? rawSnapshot : null;
    const failure = (rawFailure?.observedAt ?? 0) >= failureCutoff ? rawFailure : null;
    this.rateLimitSnapshot = snapshot;
    this.rateLimitFailure = failure;
    if (!Array.isArray(this.rateLimitEvents)) {
      return {
        count: 0,
        lastAt: this.rateLimitLastAt ?? 0,
        snapshot,
        failure,
      };
    }
    const cutoff = now - RATE_LIMIT_WINDOW_MS;
    let idx = 0;
    while (idx < this.rateLimitEvents.length && this.rateLimitEvents[idx] < cutoff) idx += 1;
    if (idx > 0) this.rateLimitEvents.splice(0, idx);
    return {
      count: this.rateLimitEvents.length,
      lastAt: this.rateLimitLastAt ?? 0,
      snapshot,
      failure,
    };
  }

  #logItemEvent({ agentId, method, params }) {
    if (!STREAM_EVENTS) return;
    const normalizedMethod = String(method ?? '');
    if (normalizedMethod === 'turn/completed') {
      const status = params?.turn?.status ?? params?.status ?? 'unknown';
      if (agentId) {
        this.sendLog(`[${agentId}] turn completed: ${status}`);
      } else {
        this.sendLog(`turn completed: ${status}`);
      }
      return;
    }

    if (normalizedMethod !== 'item/started' && normalizedMethod !== 'item/completed') return;
    const item = params?.item;
    if (!item || typeof item !== 'object') return;
    const itemType = normalizeItemType(item?.type ?? '') || 'unknown';
    const outputText = extractItemText(item);
    const isOutputItem =
      itemType === 'aggregatedoutput'
      || itemType === 'formattedtext'
      || itemType === 'formattedoutput'
      || itemType === 'outputtext'
      || itemType === 'textoutput';
    const isReasoningItem =
      itemType === 'reasoning'
      || itemType === 'analysis'
      || itemType === 'agentreasoning';
    const isAgentMessage =
      itemType === 'agentmessage'
      || itemType === 'assistantmessage'
      || itemType === 'message';

    if (normalizedMethod === 'item/completed' && outputText && (isOutputItem || isReasoningItem)) {
      const trimmedAgentId = typeof agentId === 'string' ? agentId.trim() : '';
      if (trimmedAgentId) {
        this.sendLog({ text: outputText, stream: true, agentId: trimmedAgentId });
      } else {
        this.sendLog({ text: outputText, stream: true });
      }
      return;
    }
    if (isOutputItem || isReasoningItem) {
      return;
    }

    if (isAgentMessage || itemType.endsWith('message')) {
      if (
        normalizedMethod === 'item/completed'
        && outputText
        && (!EVENT_STREAM_DELTAS || !LOG_AGENT_MESSAGE_DELTAS)
      ) {
        const trimmedAgentId = typeof agentId === 'string' ? agentId.trim() : '';
        if (trimmedAgentId) {
          this.sendLog({ text: outputText, stream: true, agentId: trimmedAgentId });
        } else {
          this.sendLog({ text: outputText, stream: true });
        }
      }
      return;
    }

    if (itemType === 'commandexecution') {
      return;
    }

    if (itemType === 'filechange') {
      const files = Array.isArray(item?.changes)
        ? item.changes.map(change => change.path).filter(Boolean)
        : [];
      const label = `${normalizedMethod} fileChange: ${files.length} file(s)`;
      if (agentId) {
        this.sendLog(`[${agentId}] ${label}`);
      } else {
        this.sendLog(label);
      }
      return;
    }

    if (itemType === 'mcptoolcall') {
      const target = `${item?.server ?? ''}/${item?.tool ?? ''}`.replace(/\/$/, '');
      const label = `${normalizedMethod} mcpToolCall: ${target}`.trim();
      if (agentId) {
        this.sendLog(`[${agentId}] ${label}`);
      } else {
        this.sendLog(label);
      }
      return;
    }

    if (agentId) {
      this.sendLog(`[${agentId}] ${normalizedMethod} ${itemType}`);
    } else {
      this.sendLog(`${normalizedMethod} ${itemType}`);
    }
  }

  #attachClient({ client, collectors, emitEvent, agentId, taskId, phase, contextStore }) {
    if (!client) return () => {};

    const safeEmit = payload => {
      emitEvent?.({
        agentId,
        taskId,
        phase,
        ...payload,
      });
    };
    const streamPlannerTokens = STREAM_PLANNER_TOKENS && isPlannerPhase(phase, agentId);
    const plannerTokenPrefix =
      typeof agentId === 'string' && agentId.trim() ? `[${agentId.trim()}] ` : '[planner] ';
    let plannerTokenBuffer = '';
    let plannerTokenLastFlushAt = Date.now();

    const flushPlannerTokens = (force = false) => {
      if (!plannerTokenBuffer) return;
      const now = Date.now();
      if (!force) {
        const elapsed = now - plannerTokenLastFlushAt;
        const shouldFlush =
          plannerTokenBuffer.includes('\n')
          || plannerTokenBuffer.length >= PLANNER_TOKEN_STREAM_FLUSH_CHARS
          || elapsed >= PLANNER_TOKEN_STREAM_FLUSH_MS;
        if (!shouldFlush) return;
      }
      this.sendLog(`${plannerTokenPrefix}${plannerTokenBuffer}`);
      plannerTokenBuffer = '';
      plannerTokenLastFlushAt = now;
    };

    const onServerRequest = request => {
      const method = request?.method ?? 'unknown';
      const threadId = request?.params?.threadId;
      const turnId = request?.params?.turnId;
      const itemId = request?.params?.itemId;
      const reason = request?.params?.reason;

      if (STREAM_EVENTS) {
        this.sendLog(
          `[approve] agent=${agentId} method=${method} thread=${threadId ?? '?'} turn=${turnId ?? '?'} item=${itemId ?? '?'}${reason ? ` reason=${reason}` : ''}`,
        );
      }

      safeEmit({
        type: 'appserver.request',
        method,
        params: request?.params ?? null,
        result: request?.result ?? null,
      });
    };

    const onNotification = message => {
      const method = message?.method;
      const params = message?.params;
      if (!method || !params) return;
      const normalizedMethod = String(method ?? '').toLowerCase();

      this.#recordRateLimitEvent({ method, params });

      if (streamPlannerTokens) {
        if (method === 'turn/completed' || method === 'thread/completed') {
          flushPlannerTokens(true);
        } else if (isPlannerTokenMethod(method)) {
          const delta = extractPlannerDeltaText(params);
          if (delta !== null) {
            plannerTokenBuffer += delta;
            flushPlannerTokens(false);
          }
        }
      }

      if (collectors && params.threadId) {
        const turnId = params.turnId ?? params.turn?.id;
        if (turnId) {
          const key = `${params.threadId}:${turnId}`;
          const collector = collectors.get(key);
          if (collector) collector.handleNotification(message);
        }
      }

      if (contextStore) {
        contextStore.record({
          taskId,
          agentId,
          phase,
          method,
          params,
          timestamp: new Date().toISOString(),
        });
      }

      if (taskId) {
        this.#recordTaskActivity({ taskId, method, params });
      }

      if (method === 'item/completed') {
        this.#enqueueHookItemCompleted({ agentId, taskId, phase, method, params });
      }

      const isAgentDeltaMethod =
        normalizedMethod === 'item/agentmessage/delta'
        || normalizedMethod.includes('agent_message_delta')
        || normalizedMethod.includes('agent_message_content_delta');

      if (isAgentDeltaMethod && EVENT_STREAM_DELTAS && LOG_AGENT_MESSAGE_DELTAS) {
        if (!streamPlannerTokens) {
          const deltaText = extractPlannerDeltaText(params);
          if (deltaText) {
            const trimmedAgentId = typeof agentId === 'string' ? agentId.trim() : '';
            const itemId = params?.itemId ?? null;
            const bufferKey = itemId
              ? `${trimmedAgentId}:${itemId}`
              : (trimmedAgentId ? `agent:${trimmedAgentId}` : null);
            let toEmit = deltaText;
            if (bufferKey) {
              const prev = this.agentMessageDeltaBuffers?.get(bufferKey) ?? '';
              if (prev && deltaText.startsWith(prev)) {
                toEmit = deltaText.slice(prev.length);
                this.agentMessageDeltaBuffers.set(bufferKey, deltaText);
              } else {
                this.agentMessageDeltaBuffers.set(bufferKey, prev + deltaText);
              }
            }
            if (toEmit) {
              if (trimmedAgentId) {
                this.sendLog({ text: toEmit, stream: true, agentId: trimmedAgentId });
              } else {
                this.sendLog({ text: toEmit, stream: true });
              }
            }
          }
        }
      }

      if (normalizedMethod === 'item/completed') {
        const item = params?.item;
        const itemType = normalizeItemType(item?.type ?? '');
        if (itemType === 'agentmessage') {
          const itemId = item?.id ?? params?.itemId ?? null;
          const trimmedAgentId = typeof agentId === 'string' ? agentId.trim() : '';
          const bufferKey = itemId
            ? `${trimmedAgentId}:${itemId}`
            : (trimmedAgentId ? `agent:${trimmedAgentId}` : null);
          if (bufferKey) this.agentMessageDeltaBuffers?.delete(bufferKey);
        }
      }

      if (!EVENT_STREAM_DELTAS && isAgentDeltaMethod) {
        return;
      }

      safeEmit({
        type: 'appserver.notification',
        method,
        params,
      });
    };

    const onExit = ({ code, signal }) => {
      safeEmit({
        type: 'appserver.exit',
        code: code ?? null,
        signal: signal ?? null,
      });
    };

    client.on('server-request', onServerRequest);
    client.on('notification', onNotification);
    client.on('exit', onExit);

    return () => {
      client.off('server-request', onServerRequest);
      client.off('notification', onNotification);
      client.off('exit', onExit);
      if (streamPlannerTokens) {
        flushPlannerTokens(true);
      }
    };
  }

  async runScoutSummary({ goal, repoRoot, repoIndex, emitEvent, cwd } = {}) {
    const agentId = 'scout';
    const client = new AppServerClient({
      approvalDecision: DEFAULT_APPROVAL_DECISION,
      approvalJustification: this.execJustification,
      log: (...args) => this.sendLog(`[${agentId}] ${args.join(' ')}`),
      ...this.#buildHookClientOptions({ agentId, taskId: null, phase: 'scout' }),
      ...this.#buildWorkerClientOptions(agentId, 'watchdog'),
    });
    const collectors = new Map();
    const detach = this.#attachClient({
      client,
      collectors,
      emitEvent,
      agentId,
      taskId: null,
      phase: 'scout',
      contextStore: null,
    });

    const runCwd = cwd ?? repoRoot ?? this.activeRepoRoot ?? process.cwd();
    const scoutSpec = this.#agentModelEffort({ phase: 'scout' });
    const repoIndexBlock =
      typeof repoIndex === 'string' && repoIndex.trim()
        ? `\nRepository index:\n${repoIndex.trim()}\n`
        : '';

    emitEvent?.({
      type: 'agent.started',
      agentId,
      phase: 'scout',
      worktreePath: runCwd,
      model: scoutSpec.model,
      effort: scoutSpec.effort,
    });

    try {
      await client.ensureInitialized();
      emitEvent?.({
        type: 'agent.initialized',
        agentId,
        phase: 'scout',
      });

      const threadStart = await client.request('thread/start', {
        model: this.#desiredModel(),
        cwd: runCwd,
        approvalPolicy: DEFAULT_APPROVAL_POLICY,
        sandbox: this.#desiredSandbox(),
        config: this.#buildThreadConfigOverrides() ?? undefined,
      });
      const threadId = threadStart?.thread?.id ?? threadStart?.threadId;
      if (!threadId) throw new Error('Failed to start scout thread');

      const promptTemplate = loadPromptTemplate(
        'scout',
        `You are the repo scout for a multi-agent run.
Goal:
{{goal}}
{{repoIndexBlock}}

Your job: produce a concise shared summary for other agents so they avoid redundant repo exploration.
Constraints:
- Do NOT run commands.
- Do NOT modify any files.
- Keep the summary under {{scoutMaxChars}} characters.

Return bullets with:
1) Key areas/files likely relevant to the goal.
2) Likely build/test/lint commands if evident.
3) Any integration or coordination risks to avoid overlap.`,
      );
      const promptText = renderPromptTemplate(promptTemplate, {
        goal,
        repoIndexBlock,
        scoutMaxChars: SCOUT_MAX_CHARS,
      });

      const turn = await this.#runTurn({
        client,
        collectors,
        threadId,
        cwd: runCwd,
        text: promptText,
        onEvent: () => {},
        agentId,
        taskId: null,
        phase: 'scout',
        emitEvent,
      });
      await this.#handleHookTurnCompletedNonTask({
        agentId,
        taskId: null,
        phase: 'scout',
        threadId,
        turn,
        goal,
        task: null,
      });

      const summary = clipText(turn.text ?? '', SCOUT_MAX_CHARS);
      emitEvent?.({
        type: 'scout.completed',
        chars: summary.length,
      });
      return summary;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? 'unknown error');
      emitEvent?.({
        type: 'scout.failed',
        error: message,
      });
      this.sendLog(`[scout] failed: ${message}`);
      return null;
    } finally {
      emitEvent?.({
        type: 'agent.disposing',
        agentId,
        phase: 'scout',
      });
      detach();
      await client.dispose('scout-finished');
      emitEvent?.({
        type: 'agent.disposed',
        agentId,
        phase: 'scout',
      });
    }
  }

  async #plan(client, collectors, cwd, goal, plannerPrompt, options = {}) {
    const maxTasks = MAX_TASKS;
    const parallelism = Number.parseInt(options.parallelism, 10);
    const plannerTaskMultiplier = Number.isFinite(options.plannerTaskMultiplier)
      ? Math.max(1, options.plannerTaskMultiplier)
      : PLANNER_TASK_MULTIPLIER;
    const plannerMinTasks = Number.isFinite(options.plannerMinTasks)
      ? Math.max(1, options.plannerMinTasks)
      : Math.max(1, PLANNER_MIN_TASKS);
    const desired = Number.isFinite(parallelism) && parallelism > 0
      ? parallelism * plannerTaskMultiplier
      : plannerMinTasks;
    const minTasksFloor = Math.max(1, Math.max(plannerMinTasks, desired));
    const minTasks = hasTaskLimit(maxTasks)
      ? Math.min(maxTasks, minTasksFloor)
      : minTasksFloor;
    const desiredParallelism = Number.isFinite(parallelism) && parallelism > 0 ? parallelism : 1;

    const countRootTasks = rawTasks => {
      const normalised = normaliseTasks(rawTasks, { limit: maxTasks, pathLayout: this.taskPathLayout });
      const ids = new Set(normalised.map(task => task.id));
      const roots = normalised.filter(task => {
        const deps = (task.dependsOn ?? []).filter(dep => dep !== task.id && ids.has(dep));
        return deps.length === 0;
      });
      const target = Math.min(desiredParallelism, normalised.length);
      return { rootCount: roots.length, target };
    };

    const planThread = await client.request('thread/start', {
      model: this.#desiredModel('planner'),
      cwd,
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
      sandbox: this.#desiredSandbox('planner'),
      config: this.#buildThreadConfigOverrides() ?? undefined,
    });
    const threadId = planThread?.thread?.id ?? planThread?.threadId;
    if (!threadId) {
      throw new Error('Failed to start planner thread.');
    }

    let lastText = '';
    let lastPlan = null;

    for (let attempt = 0; attempt < PLANNER_MAX_RETRIES; attempt += 1) {
      const basePrompt = (plannerPrompt ?? '').trim();
      const retryHint = attempt === 0
        ? ''
        : 'Your previous plan was insufficient. Increase effective parallelism by producing more independent tasks with empty dependsOn; avoid dependency chains unless truly required. Return ONLY JSON.';
      const promptText = buildPlannerPrompt(goal, basePrompt, {
        parallelism,
        minTasks,
        maxTasks,
        repoIndex: options.repoIndex,
        avoidOverlap: options.avoidOverlap,
        pathLayout: this.taskPathLayout,
      }) + (retryHint ? `\n\n${retryHint}` : '');

      let turn;
      try {
        turn = await this.#runTurn({
          client,
          collectors,
          threadId,
          cwd,
          text: promptText,
          onEvent: () => {},
          agentId: 'planner',
          taskId: null,
          phase: 'planner',
          emitEvent: this.activeEmitEvent,
          effortOverride: attempt > 0 ? RETRY_EFFORT : null,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err ?? 'unknown error');
        this.sendLog(`Planner turn failed (attempt ${attempt + 1}/${PLANNER_MAX_RETRIES}): ${message}`);
        lastText = message;
        continue;
      }

      await this.#handleHookTurnCompletedNonTask({
        agentId: 'planner',
        taskId: null,
        phase: 'planner',
        threadId,
        turn,
        goal,
        task: null,
      });

      lastText = turn.text ?? '';

      try {
        const parsed = parsePlan(turn.text);
        lastPlan = parsed;

        const count = Array.isArray(parsed.tasks) ? parsed.tasks.length : 0;
        const { rootCount, target } = countRootTasks(parsed.tasks);
        const meetsRootRequirement = target < 2 || rootCount >= target;

        const reachedMaxTasks = hasTaskLimit(maxTasks) && count >= maxTasks;
        if ((count >= minTasks || reachedMaxTasks) && meetsRootRequirement) {
          return {
            tasks: parsed.tasks,
            coordination: normalizeCoordinatorArtifact(parsed.coordination),
            rawPlanText: turn.text,
          };
        }

        if (!meetsRootRequirement) {
          this.sendLog(
            `Planner produced only ${rootCount}/${target} immediately-runnable task(s); retrying for better parallelism (attempt ${attempt + 1}/${PLANNER_MAX_RETRIES})`,
          );
        } else {
          this.sendLog(
            `Planner produced ${count} task(s), retrying to reach >=${minTasks} (attempt ${attempt + 1}/${PLANNER_MAX_RETRIES})`,
          );
        }
      } catch (err) {
        this.sendLog(`Planner JSON parse failed (attempt ${attempt + 1}): ${err.message}`);
      }
    }

    if (lastPlan) {
      return {
        tasks: lastPlan.tasks ?? [],
        coordination: normalizeCoordinatorArtifact(lastPlan.coordination),
        rawPlanText: lastText,
      };
    }

    return { tasks: [], coordination: null, rawPlanText: lastText };
  }

  async #planAssistTasks({
    goal,
    stragglerTask,
    completedTasks,
    desiredCount,
    repoIndex,
    contextSnapshot,
    gitStatusSummary,
    emitEvent,
    wave,
  }) {
    const agentId = `dynamic-planner:w${wave}`;
    const client = new AppServerClient({
      approvalDecision: DEFAULT_APPROVAL_DECISION,
      approvalJustification: this.execJustification,
      log: (...args) => this.sendLog(`[${agentId}] ${args.join(' ')}`),
      ...this.#buildHookClientOptions({
        agentId,
        taskId: stragglerTask?.id ?? null,
        phase: 'dynamic-plan',
      }),
      ...this.#buildWorkerClientOptions(stragglerTask?.id ?? agentId, 'planner'),
    });
    const collectors = new Map();
    const detach = this.#attachClient({
      client,
      collectors,
      emitEvent,
      agentId,
      taskId: stragglerTask?.id ?? null,
      phase: 'dynamic-plan',
      contextStore: null,
    });

    const runCwd = this.activeRepoRoot ?? process.cwd();

    const dynamicPlanSpec = this.#agentModelEffort({ phase: 'dynamic-plan' });
    emitEvent?.({
      type: 'agent.started',
      agentId,
      taskId: stragglerTask?.id ?? null,
      phase: 'dynamic-plan',
      worktreePath: runCwd,
      model: dynamicPlanSpec.model,
      effort: dynamicPlanSpec.effort,
    });

    try {
      await client.ensureInitialized();
      emitEvent?.({
        type: 'agent.initialized',
        agentId,
        taskId: stragglerTask?.id ?? null,
        phase: 'dynamic-plan',
      });

      const threadStart = await client.request('thread/start', {
        model: this.#desiredModel('planner'),
        cwd: runCwd,
        approvalPolicy: DEFAULT_APPROVAL_POLICY,
        sandbox: this.#desiredSandbox('planner'),
        config: this.#buildThreadConfigOverrides() ?? undefined,
      });
      const threadId = threadStart?.thread?.id ?? threadStart?.threadId;
      if (!threadId) throw new Error('Failed to start dynamic planner thread');

      const completedSection = (completedTasks ?? [])
        .map(task => `- ${task.id}: ${task.description}`)
        .join('\n') || '- none';

      const stragglerLine = stragglerTask
        ? `${stragglerTask.id}: ${stragglerTask.description} (worktree: ${stragglerTask.worktreePath})`
        : '(unknown)';

      const repoIndexBlock =
        typeof repoIndex === 'string' && repoIndex.trim()
          ? `\nRepository index:\n${repoIndex.trim()}\n`
          : '';
      const coordinationBlock = buildPlannerCoordinationBlock(
        this.coordinatorArtifact,
        this.sharedContextSummary,
      );
      const sharedWorkspaceHint = buildSharedWorkspacePlannerHint();
      const snapshotBlock =
        typeof contextSnapshot === 'string' && contextSnapshot.trim()
          ? `\nStraggler context snapshot:\n${contextSnapshot.trim()}\n`
          : '';
      const gitBlock =
        typeof gitStatusSummary === 'string' && gitStatusSummary.trim()
          ? `\nStraggler worktree git status (porcelain):\n${gitStatusSummary.trim()}\n`
          : '';
      const overlapHint = this.avoidOverlapEnabled
        ? '\n- Strongly avoid overlapping file edits with pending tasks.'
          + '\n- Strongly avoid touching files likely owned by the straggler task.'
        : '';

      const promptTemplate = loadPromptTemplate(
        'dynamic-planner',
        `You are an expert project planner coordinating a team of Codex engineers.
We have an ongoing multi-agent run and one straggler task has been running alone for a long time.
Your job is to propose additional parallel tasks that can be started immediately to reduce total wall-clock time.

Original goal:
{{goal}}

Straggler task (MUST NOT be in dependsOn):
{{stragglerLine}}

Completed tasks you MAY depend on (ids only):
{{completedSection}}{{repoIndexBlock}}{{snapshotBlock}}{{gitBlock}}{{coordinationBlock}}

Return a concise JSON plan using the schema:
{
  "tasks": [
    {
      "id": "assist-1",
      "description": "Short phrase",
      "dependsOn": ["some-completed-task-id"],
      "prompt": "Optional richer instructions for the Codex agent",
      "ownership": {
        "scope": "Single sentence responsibility",
        "paths": ["src/example/*", "test/example.test.js"]
      }
    }
  ],
  "coordination": {
    "goalSummary": "1-2 sentence execution summary",
    "sharedContext": ["Facts every worker should know before editing"],
    "risks": ["Key guardrails or likely failure modes"],
    "verification": ["Checks that matter for the overall run"],
    "replanTriggers": ["Signals that should trigger steer, retry, or replan"]
  }
}
Constraints:
{{plannerOnlyConstraint}}
- Return between 0 and {{desiredCount}} tasks.
- Return 0 tasks when the straggler is still making real progress and there is no clearly independent implementation, test, docs, or validation task that would shorten total wall-clock time.
- Every task MUST NOT include "{{stragglerId}}" in dependsOn.
- Prefer small, independent tasks that can be developed in separate worktrees (tests/docs/validation/refactors/integration).
- Avoid duplicating work already covered by completed tasks.
- Do not create audit-only, scout-only, placeholder, or coordination-only tasks just to fill worker slots.
- Explicitly assign ownership for every task (files/modules/responsibility).
- Include worker guidance that they are not alone in the codebase and should avoid unrelated files.
- Use empty string/arrays when a coordination field is not needed.
{{pathLayoutHint}}{{sharedWorkspaceHint}}{{overlapHint}}
Return ONLY JSON.`,
      );
      const promptText = renderPromptTemplate(promptTemplate, {
        goal,
        stragglerLine,
        completedSection,
        repoIndexBlock,
        snapshotBlock,
        gitBlock,
        coordinationBlock,
        plannerOnlyConstraint: PLANNER_ONLY_CONSTRAINT,
        desiredCount,
        stragglerId: stragglerTask?.id ?? '',
        pathLayoutHint: buildPlannerPathLayoutHint(this.taskPathLayout),
        sharedWorkspaceHint,
        overlapHint,
      });

      const turn = await this.#runTurn({
        client,
        collectors,
        threadId,
        cwd: runCwd,
        text: promptText,
        onEvent: () => {},
        agentId,
        taskId: stragglerTask?.id ?? null,
        phase: 'dynamic-plan',
        emitEvent,
      });
      await this.#handleHookTurnCompletedNonTask({
        agentId,
        taskId: stragglerTask?.id ?? null,
        phase: 'dynamic-plan',
        threadId,
        turn,
        goal,
        task: stragglerTask ?? null,
      });

      const parsed = parsePlan(turn.text);
      return {
        tasks: parsed.tasks ?? [],
        coordination: normalizeCoordinatorArtifact(parsed.coordination),
        rawPlanText: turn.text,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? 'unknown error');
      emitEvent?.({
        type: 'dynamic.plan.failed',
        wave,
        error: message,
      });
      return { tasks: [], coordination: null, rawPlanText: '' };
    } finally {
      emitEvent?.({
        type: 'agent.disposing',
        agentId,
        taskId: stragglerTask?.id ?? null,
        phase: 'dynamic-plan',
      });
      detach();
      await client.dispose(`dynamic-plan-w${wave}-finished`);
      emitEvent?.({
        type: 'agent.disposed',
        agentId,
        taskId: stragglerTask?.id ?? null,
        phase: 'dynamic-plan',
      });
    }
  }

  async #planStalledTasks({
    goal,
    pendingTasks,
    completedTasks,
    desiredCount,
    repoIndex,
    emitEvent,
    wave,
    cwd,
    effortOverride,
  }) {
    const agentId = `stall-planner:w${wave}`;
    const client = new AppServerClient({
      approvalDecision: DEFAULT_APPROVAL_DECISION,
      approvalJustification: this.execJustification,
      log: (...args) => this.sendLog(`[${agentId}] ${args.join(' ')}`),
      ...this.#buildHookClientOptions({ agentId, taskId: null, phase: 'stall-plan' }),
      ...this.#buildWorkerClientOptions(agentId, 'planner', effortOverride),
    });
    const collectors = new Map();
    const detach = this.#attachClient({
      client,
      collectors,
      emitEvent,
      agentId,
      taskId: null,
      phase: 'stall-plan',
      contextStore: null,
    });

    const runCwd = cwd ?? this.activeRepoRoot ?? process.cwd();

    const stallPlanSpec = this.#agentModelEffort({ phase: 'stall-plan', effortOverride });
    emitEvent?.({
      type: 'agent.started',
      agentId,
      phase: 'stall-plan',
      worktreePath: runCwd,
      model: stallPlanSpec.model,
      effort: stallPlanSpec.effort,
    });

    try {
      await client.ensureInitialized();
      emitEvent?.({
        type: 'agent.initialized',
        agentId,
        phase: 'stall-plan',
      });

      const threadStart = await client.request('thread/start', {
        model: this.#desiredModel('planner'),
        cwd: runCwd,
        approvalPolicy: DEFAULT_APPROVAL_POLICY,
        sandbox: this.#desiredSandbox('planner'),
        config: this.#buildThreadConfigOverrides() ?? undefined,
      });
      const threadId = threadStart?.thread?.id ?? threadStart?.threadId;
      if (!threadId) throw new Error('Failed to start stall planner thread');

      const completedSection = (completedTasks ?? [])
        .map(task => `- ${task.id}: ${task.description}`)
        .join('\n') || '- none';

      const pendingLimit = 25;
      const pendingLines = (pendingTasks ?? [])
        .slice(0, pendingLimit)
        .map(task => {
          const deps = Array.isArray(task.dependsOn) && task.dependsOn.length > 0
            ? ` (dependsOn: ${task.dependsOn.join(', ')})`
            : '';
          return `- ${task.id}: ${clipText(task.description ?? '', 160)}${deps}`;
        });
      const pendingSuffix =
        Array.isArray(pendingTasks) && pendingTasks.length > pendingLimit
          ? `\n... +${pendingTasks.length - pendingLimit} more`
          : '';
      const pendingSection = pendingLines.length > 0 ? `${pendingLines.join('\n')}${pendingSuffix}` : '- none';

      const repoIndexBlock =
        typeof repoIndex === 'string' && repoIndex.trim()
          ? `\nRepository index:\n${repoIndex.trim()}\n`
          : '';
      const coordinationBlock = buildPlannerCoordinationBlock(
        this.coordinatorArtifact,
        this.sharedContextSummary,
      );
      const overlapHint = this.avoidOverlapEnabled
        ? '\n- Avoid overlapping file edits with pending tasks where possible.'
        : '';
      const sharedWorkspaceHint = buildSharedWorkspacePlannerHint();

      const promptTemplate = loadPromptTemplate(
        'stall-planner',
        `You are an expert project planner coordinating a stalled multi-agent run.
No tasks are currently runnable (likely a dependency cycle or over-constrained plan).
Your job is to propose additional parallel tasks that can start immediately to reach target parallelism.

Original goal:
{{goal}}{{repoIndexBlock}}{{coordinationBlock}}

Pending tasks (avoid duplicating these):
{{pendingSection}}

Completed tasks you MAY depend on (ids only):
{{completedSection}}

Return a concise JSON plan using the schema:
{
  "tasks": [
    {
      "id": "stall-1",
      "description": "Short phrase",
      "dependsOn": ["optional-completed-task-id"],
      "prompt": "Optional richer instructions for the Codex agent",
      "ownership": {
        "scope": "Single sentence responsibility",
        "paths": ["src/example/*", "test/example.test.js"]
      }
    }
  ],
  "coordination": {
    "goalSummary": "1-2 sentence execution summary",
    "sharedContext": ["Facts every worker should know before editing"],
    "risks": ["Key guardrails or likely failure modes"],
    "verification": ["Checks that matter for the overall run"],
    "replanTriggers": ["Signals that should trigger steer, retry, or replan"]
  }
}
Constraints:
{{plannerOnlyConstraint}}
- Return between 0 and {{desiredCount}} tasks.
- Return 0 tasks when the right action is to wait for active planner, scout, or task progress rather than injecting more work.
- Do NOT depend on pending task ids; depend only on completed task ids when needed.
- Prefer tasks that can start immediately (dependsOn: []) and run in parallel.
- Avoid duplicating work already covered by pending or completed tasks.
- Do not create audit-only, scout-only, placeholder, or coordination-only tasks just to fill worker slots.
- Explicitly assign ownership for every task (files/modules/responsibility).
- Include worker guidance that they are not alone in the codebase and should avoid unrelated files.
- Use empty string/arrays when a coordination field is not needed.
{{pathLayoutHint}}{{sharedWorkspaceHint}}{{overlapHint}}
Return ONLY JSON.`,
      );
      const promptText = renderPromptTemplate(promptTemplate, {
        goal,
        repoIndexBlock,
        coordinationBlock,
        pendingSection,
        completedSection,
        plannerOnlyConstraint: PLANNER_ONLY_CONSTRAINT,
        desiredCount,
        pathLayoutHint: buildPlannerPathLayoutHint(this.taskPathLayout),
        sharedWorkspaceHint,
        overlapHint,
      });

      const turn = await this.#runTurn({
        client,
        collectors,
        threadId,
        cwd: runCwd,
        text: promptText,
        onEvent: () => {},
        agentId,
        taskId: null,
        phase: 'stall-plan',
        emitEvent,
        effortOverride,
      });
      await this.#handleHookTurnCompletedNonTask({
        agentId,
        taskId: null,
        phase: 'stall-plan',
        threadId,
        turn,
        goal,
        task: null,
      });

      const parsed = parsePlan(turn.text);
      return {
        tasks: parsed.tasks ?? [],
        coordination: normalizeCoordinatorArtifact(parsed.coordination),
        rawPlanText: turn.text,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? 'unknown error');
      emitEvent?.({
        type: 'stall.plan.failed',
        wave,
        error: message,
      });
      return { tasks: [], coordination: null, rawPlanText: '' };
    } finally {
      emitEvent?.({
        type: 'agent.disposing',
        agentId,
        phase: 'stall-plan',
      });
      detach();
      await client.dispose(`stall-plan-w${wave}-finished`);
      emitEvent?.({
        type: 'agent.disposed',
        agentId,
        phase: 'stall-plan',
      });
    }
  }

  async #runWatchdog({
    goal,
    snapshotText,
    runId,
    repoRoot,
    emitEvent,
    wave,
    reason,
    drainRuntimeInjections,
  }) {
    const watchdogEffort = this.#watchdogEffortForWave(wave);
    const watchdogSpec = this.#agentModelEffort({
      phase: 'watchdog',
      effortOverride: watchdogEffort,
    });
    const reasonLabel = reason?.label ?? 'unspecified';
    const previousWatchdogEffort = wave > 1 ? this.#watchdogEffortForWave(wave - 1) : null;
    if (wave > 1 && watchdogSpec.effort && watchdogSpec.effort !== previousWatchdogEffort) {
      this.sendLog(`[watchdog] escalating effort to ${watchdogSpec.effort} (wave ${wave}).`);
    }

    const summarizeActionOutcome = (outcome, injectionOutcome = null) => {
      const normalized = outcome && typeof outcome === 'object' ? outcome : {};
      const injectQueued = injectionOutcome?.status === 'applied'
        ? Math.max(0, Number.parseInt(injectionOutcome.taskCount, 10) || 0)
        : 0;
      const abortCount = Array.isArray(normalized.aborts)
        ? normalized.aborts.filter(entry => entry?.ok === true).length
        : 0;
      const retryCount = Array.isArray(normalized.retries)
        ? normalized.retries.filter(entry => entry?.ok === true).length
        : 0;
      const respawnCount = Array.isArray(normalized.respawns)
        ? normalized.respawns.filter(entry => entry?.ok === true).length
        : 0;
      const labels = [];
      if (injectQueued > 0) labels.push(`inject:${injectQueued}`);
      if (abortCount > 0) labels.push(`abort:${abortCount}`);
      if (retryCount > 0) labels.push(`retry:${retryCount}`);
      if (respawnCount > 0) labels.push(`respawn:${respawnCount}`);
      return {
        injectQueued,
        abortCount,
        retryCount,
        respawnCount,
        labels,
        recovered: labels.length > 0,
      };
    };

    const watchdogEvent = buildWatchdogCoordinatorEvent({
      report: null,
      steer: null,
      wave,
      reason: reasonLabel,
    });
    const watchdogArtifact = buildWatchdogCoordinatorArtifact({
      report: null,
      wave,
      reason: reasonLabel,
    });

    try {
      const coordination = await this.#coordinateEvent({
        eventType: 'watchdog',
        summary: watchdogEvent.summary,
        eventDetails: {
          ...(watchdogEvent.details ?? {}),
          runId: runId ?? null,
          repoRoot: clipText(repoRoot ?? this.activeRepoRoot ?? process.cwd(), 220) || null,
          goal: clipText(goal ?? '', 220) || null,
        },
        eventContextText: snapshotText,
        artifactHint: watchdogArtifact,
        steerHint: { broadcast: [], tasks: [] },
        emitEvent,
        phase: 'watchdog',
        wave,
        source: 'watchdog',
        modelOverride: watchdogSpec.model ?? null,
        effortOverride: watchdogSpec.effort ?? watchdogEffort,
      });
      const injectionId = coerceString(coordination?.actionOutcome?.inject?.injectionId);
      const injectionOutcome = injectionId
        ? await this.#resolveQueuedRuntimeInjection({
          injectionId,
          drainQueue: drainRuntimeInjections,
        })
        : null;
      if (injectionOutcome) {
        await this.#reportCoordinatorInjectionOutcome({
          eventType: 'watchdog-result',
          phase: 'watchdog',
          wave,
          label: `Watchdog wave ${wave}`,
          outcome: injectionOutcome,
          emitEvent,
          eventContextText: `Trigger: ${reasonLabel}`,
        });
      }

      const steer = coordination?.steer ?? { broadcast: [], tasks: [] };
      const steerBroadcastCount = Array.isArray(steer.broadcast) ? steer.broadcast.length : 0;
      const steerTaskCount = Array.isArray(steer.tasks) ? steer.tasks.length : 0;
      const actionSummary = summarizeActionOutcome(
        coordination?.actionOutcome ?? null,
        injectionOutcome,
      );
      const actionLabels = [...actionSummary.labels];
      if (steerBroadcastCount > 0 || steerTaskCount > 0) {
        actionLabels.push(`steer:b${steerBroadcastCount}/t${steerTaskCount}`);
      }
      const recovered =
        actionSummary.recovered
        || steerBroadcastCount > 0
        || steerTaskCount > 0;
      const reportText =
        coerceString(coordination?.eventSummary)
        ?? formatCanonicalCoordinatorEventSummary({
          eventType: 'watchdog',
          phase: 'watchdog',
          wave,
          artifactChanged: coordination?.artifactChanged ?? null,
          steer,
          note: actionLabels.join(', ') || reasonLabel,
        });

      this.sendLog(`[watchdog] coordinator wave ${wave}: ${reportText}`);
      emitEvent?.({
        type: 'watchdog.report',
        wave,
        runId: runId ?? null,
        reason: reasonLabel,
        report: reportText,
        recovered,
        actionLabels,
        injectQueued: actionSummary.injectQueued,
        abortCount: actionSummary.abortCount,
        retryCount: actionSummary.retryCount,
        respawnCount: actionSummary.respawnCount,
        steerBroadcastCount,
        steerTaskCount,
      });
      return {
        ...coordination,
        reportText,
        steer,
        recovered,
        actionLabels,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? 'unknown error');
      this.sendLog(`[watchdog] failed (wave ${wave}): ${message}`);
      emitEvent?.({
        type: 'watchdog.failed',
        wave,
        runId: runId ?? null,
        reason: reasonLabel,
        error: message,
      });
      return {
        reportText: null,
        steer: { broadcast: [], tasks: [] },
        actions: null,
        actionOutcome: null,
        artifactChanged: false,
        eventSummary: null,
        coordinatorBacked: false,
        recovered: false,
        actionLabels: [],
      };
    }
  }

  async #planRecoveryTasks({
    goal,
    completedTasks,
    failedTasks,
    blockedTasks,
    desiredCount,
    emitEvent,
    wave,
    cwd,
  }) {
    const agentId = `recovery-planner:w${wave}`;
    const client = new AppServerClient({
      approvalDecision: DEFAULT_APPROVAL_DECISION,
      approvalJustification: this.execJustification,
      log: (...args) => this.sendLog(`[${agentId}] ${args.join(' ')}`),
      ...this.#buildHookClientOptions({ agentId, taskId: null, phase: 'recovery-plan' }),
      ...this.#buildWorkerClientOptions(agentId, 'planner'),
    });
    const collectors = new Map();
    const detach = this.#attachClient({
      client,
      collectors,
      emitEvent,
      agentId,
      taskId: null,
      phase: 'recovery-plan',
      contextStore: null,
    });

    const recoveryPlanSpec = this.#agentModelEffort({ phase: 'recovery-plan' });
    emitEvent?.({
      type: 'agent.started',
      agentId,
      phase: 'recovery-plan',
      worktreePath: cwd ?? process.cwd(),
      model: recoveryPlanSpec.model,
      effort: recoveryPlanSpec.effort,
    });

    try {
      await client.ensureInitialized();
      emitEvent?.({
        type: 'agent.initialized',
        agentId,
        phase: 'recovery-plan',
      });

      const threadStart = await client.request('thread/start', {
        model: this.#desiredModel('planner'),
        cwd: cwd ?? process.cwd(),
        approvalPolicy: DEFAULT_APPROVAL_POLICY,
        sandbox: this.#desiredSandbox('planner'),
        config: this.#buildThreadConfigOverrides() ?? undefined,
      });
      const threadId = threadStart?.thread?.id ?? threadStart?.threadId;
      if (!threadId) throw new Error('Failed to start recovery planner thread');

      const completedSection = (completedTasks ?? [])
        .map(task => `- ${task.id}: ${task.description}`)
        .join('\n') || '- none';
      const failedSection = (failedTasks ?? [])
        .map(task => `- ${task.id}: ${task.description} (reason: ${clipText(task.error ?? 'unknown', 200)})`)
        .join('\n') || '- none';
      const blockedSection = (blockedTasks ?? [])
        .map(task => `- ${task.id}: ${task.description} (reason: ${clipText(task.error ?? 'blocked', 200)})`)
        .join('\n') || '- none';

      const repoIndexBlock =
        this.repoIndexEnabled && this.repoIndex
          ? `\nRepository index:\n${this.repoIndex}\n`
          : '';
      const coordinationBlock = buildPlannerCoordinationBlock(
        this.coordinatorArtifact,
        this.sharedContextSummary,
      );
      const overlapHint = this.avoidOverlapEnabled
        ? '\n- Avoid overlapping file edits with completed tasks where possible.'
        : '';
      const sharedWorkspaceHint = buildSharedWorkspacePlannerHint();

      const planBlockTemplate = loadPromptTemplate(
        'recovery-plan-block-appserver',
`Return a minimal JSON recovery plan using the schema:
{
  "tasks": [
    {
      "id": "recovery-1",
      "description": "Short phrase",
      "dependsOn": ["optional-completed-task-id"],
      "prompt": "Optional richer instructions for the Codex agent",
      "ownership": {
        "scope": "Single sentence responsibility",
        "paths": ["src/example/*", "test/example.test.js"]
      }
    }
  ],
  "coordination": {
    "goalSummary": "1-2 sentence execution summary",
    "sharedContext": ["Facts every worker should know before editing"],
    "risks": ["Key guardrails or likely failure modes"],
    "verification": ["Checks that matter for the overall run"],
    "replanTriggers": ["Signals that should trigger steer, retry, or replan"]
  }
}
Constraints:
{{plannerOnlyConstraint}}
- Return between 0 and {{desiredCount}} tasks.
- Return 0 tasks when the underlying issue looks like prompt quality, over-fragmented planning, or ordinary slowness rather than genuinely failed work that needs replacement.
- Avoid duplicating work already covered by completed tasks.
- Avoid depending on failed/blocked task ids; depend only on completed tasks when needed.
- Prefer tasks that can start immediately (dependsOn: []) and run in parallel.
- Do not create audit-only, scout-only, placeholder, or coordination-only tasks just to fill worker slots.
- Explicitly assign ownership for every task (files/modules/responsibility).
- Include worker guidance that they are not alone in the codebase and should avoid unrelated files.
- Use empty string/arrays when a coordination field is not needed.
{{pathLayoutHint}}{{sharedWorkspaceHint}}{{overlapHint}}
Return ONLY JSON.`,
      );
      const planBlock = renderPromptTemplate(planBlockTemplate, {
        plannerOnlyConstraint: PLANNER_ONLY_CONSTRAINT,
        desiredCount,
        pathLayoutHint: buildPlannerPathLayoutHint(this.taskPathLayout),
        sharedWorkspaceHint,
        overlapHint,
      });
      const promptTemplate = loadPromptTemplate(
        'recovery-planner',
        `You are designing a recovery plan after some tasks failed or were blocked in a multi-agent workflow.
Goal:
{{goal}}{{repoIndexBlock}}{{coordinationBlock}}

Completed tasks (you MAY depend on these ids):
{{completedSection}}

Failed tasks (need recovery coverage):
{{failedSection}}

Blocked tasks (need recovery coverage):
{{blockedSection}}

{{planBlock}}`,
      );
      const promptText = renderPromptTemplate(promptTemplate, {
        goal,
        repoIndexBlock,
        coordinationBlock,
        completedSection,
        failedSection,
        blockedSection,
        planBlock,
      });

      const turn = await this.#runTurn({
        client,
        collectors,
        threadId,
        cwd: cwd ?? process.cwd(),
        text: promptText,
        onEvent: () => {},
        agentId,
        taskId: null,
        phase: 'recovery-plan',
        emitEvent,
      });
      await this.#handleHookTurnCompletedNonTask({
        agentId,
        taskId: null,
        phase: 'recovery-plan',
        threadId,
        turn,
        goal,
        task: null,
      });

      const parsed = parsePlan(turn.text);
      return {
        tasks: parsed.tasks ?? [],
        coordination: normalizeCoordinatorArtifact(parsed.coordination),
        rawPlanText: turn.text,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? 'unknown error');
      emitEvent?.({
        type: 'recovery.plan.failed',
        wave,
        error: message,
      });
      return { tasks: [], coordination: null, rawPlanText: '' };
    } finally {
      emitEvent?.({
        type: 'agent.disposing',
        agentId,
        phase: 'recovery-plan',
      });
      detach();
      await client.dispose(`recovery-plan-w${wave}-finished`);
      emitEvent?.({
        type: 'agent.disposed',
        agentId,
        phase: 'recovery-plan',
      });
    }
  }

  async #maybeInjectDynamicTasks({
    goal,
    tasks,
    taskStates,
    taskMap,
    remainingDeps,
    dependents,
    ready,
    pushReady,
    running,
    runningTasks,
    emitEvent,
    repoRoot,
    tasksRoot,
    runId,
    integrationBranch,
    parallelism,
    state,
    drainRuntimeInjections,
  }) {
    if (!DYNAMIC_REPLAN_ENABLED) return null;
    if (!Number.isFinite(parallelism) || parallelism < 2) return null;

    const dynamicWaves = state?.dynamicWaves ?? 0;
    const lastDynamicAt = state?.lastDynamicAt ?? 0;
    const total = state?.total ?? taskStates.size ?? 1;
    const previousSoloTaskId = state?.soloTaskId ?? null;
    const previousSoloSince = state?.soloSince ?? 0;

    let nextSoloTaskId = previousSoloTaskId;
    let nextSoloSince = previousSoloSince;

    const resetSolo = () => {
      nextSoloTaskId = null;
      nextSoloSince = 0;
    };

    const snapshot = overrides => ({
      dynamicWaves,
      lastDynamicAt,
      total,
      soloTaskId: nextSoloTaskId,
      soloSince: nextSoloSince,
      ...overrides,
    });

    if (!repoRoot || !tasksRoot || !runId) {
      resetSolo();
      return snapshot();
    }

    if (runningTasks.size !== 1) {
      resetSolo();
      return snapshot();
    }

    const taskIdIterator = runningTasks.values();
    const stragglerId = taskIdIterator.next().value;
    if (!stragglerId) {
      resetSolo();
      return snapshot();
    }

    const stragglerState = taskStates.get(stragglerId);
    const stragglerTask = taskMap.get(stragglerId);
    if (!stragglerState || !stragglerTask) {
      resetSolo();
      return snapshot();
    }
    if (stragglerState.status !== 'running') {
      resetSolo();
      return snapshot();
    }

    const now = Date.now();
    if (!stragglerState.startedAt) {
      resetSolo();
      return snapshot();
    }

    for (const [taskId, otherState] of taskStates.entries()) {
      if (taskId === stragglerId) continue;
      if (otherState.status === 'running' || otherState.status === 'pending') {
        resetSolo();
        return snapshot();
      }
    }

    if (nextSoloTaskId !== stragglerId || !nextSoloSince) {
      nextSoloTaskId = stragglerId;
      nextSoloSince = now;
    }

    const totalDurationMs = now - stragglerState.startedAt;
    const soloDurationMs = now - nextSoloSince;

    if (soloDurationMs < SOLO_STRAGGLER_MS) {
      return snapshot();
    }

    if (dynamicWaves >= DYNAMIC_REPLAN_MAX_WAVES) {
      return snapshot();
    }

    if (lastDynamicAt && now - lastDynamicAt < DYNAMIC_REPLAN_COOLDOWN_MS) {
      return snapshot();
    }

    const idleSlots = Math.max(0, parallelism - running.size);
    const remainingCapacity = remainingTaskCapacity(MAX_TOTAL_TASKS, taskStates.size);
    const desiredCount = Math.min(idleSlots, remainingCapacity);
    if (desiredCount <= 0) return snapshot();

    const wave = dynamicWaves + 1;

    emitEvent?.({
      type: 'dynamic.replan.started',
      wave,
      stragglerTaskId: stragglerId,
      stragglerDurationMs: totalDurationMs,
      totalDurationMs,
      soloDurationMs,
      desiredCount,
      currentTaskCount: taskStates.size,
    });

    const completedTasks = [...taskStates.values()]
      .filter(entry => entry.status === 'completed')
      .map(entry => ({
        id: entry.task.id,
        description: entry.task.description,
        worktreePath: entry.worktreePath,
        branch: entry.branch,
      }));

    const snapshotPayload = this.contextStore ? this.contextStore.snapshot(stragglerId) : null;
    const snapshotText = snapshotPayload
      ? JSON.stringify(
        {
          runId: snapshotPayload.runId,
          taskId: snapshotPayload.taskId,
          recentText: clipText(snapshotPayload.recentText ?? '', 2500),
          recentPrompts: Array.isArray(snapshotPayload.recentPrompts)
            ? snapshotPayload.recentPrompts
              .slice(-3)
              .map(prompt => ({
                ts: prompt?.ts ?? null,
                phase: prompt?.phase ?? null,
                agentId: prompt?.agentId ?? null,
                text: clipText(prompt?.text ?? '', 600),
              }))
            : [],
          recentEvents: Array.isArray(snapshotPayload.recentEvents)
            ? snapshotPayload.recentEvents.slice(-20)
            : [],
        },
        null,
        2,
      )
      : '';

    let gitStatusSummary = '';
    try {
      const rawStatus = (await git(['status', '--porcelain'], { cwd: stragglerState.worktreePath })).trim();
      const lines = rawStatus ? rawStatus.split('\n').filter(Boolean) : [];
      if (lines.length === 0) {
        gitStatusSummary = 'clean';
      } else {
        const sample = lines.slice(0, 50).join('\n');
        gitStatusSummary = `${lines.length} change(s)\n${sample}${lines.length > 50 ? '\n…' : ''}`;
      }
    } catch {
      gitStatusSummary = '';
    }

    const dynamicEvent = buildDynamicPlanCoordinatorEvent({
      wave,
      stragglerTask,
      plannedTasks: [],
      desiredCount,
    });
    const dynamicPlanSpec = this.#agentModelEffort({ phase: 'dynamic-plan' });
    const completedSection = (completedTasks ?? [])
      .map(task => `- ${task.id}: ${task.description}`)
      .join('\n') || '- none';
    const repoIndexText =
      typeof this.repoIndex === 'string' && this.repoIndexEnabled && this.repoIndex.trim()
        ? this.repoIndex.trim()
        : '';
    const dynamicContextText = [
      'Dynamic planning request:',
      `- desiredCount: ${desiredCount}`,
      `- stragglerTask: ${stragglerTask.id}: ${clipText(stragglerTask.description ?? '', 220)} (worktree: ${stragglerState.worktreePath})`,
      '- If new parallel work is warranted, express it through actions.injectTasks rather than steer alone.',
      `- Never include "${stragglerTask.id}" in dependsOn.`,
      '- Prefer 0 tasks when the straggler is still making real progress and no clearly independent implementation, test, docs, or validation work would shorten total wall-clock time.',
      '- Prefer small independent tasks; avoid overlapping the straggler task or pending tasks.',
      'Completed tasks you MAY depend on:',
      completedSection,
      repoIndexText ? `Repository index:\n${repoIndexText}` : 'Repository index:\n- none',
      snapshotText ? `Straggler context snapshot:\n${snapshotText}` : 'Straggler context snapshot:\n- none',
      gitStatusSummary ? `Straggler worktree git status:\n${gitStatusSummary}` : 'Straggler worktree git status:\n- none',
    ].join('\n\n');
    const coordinatedDynamicPlan = await this.#coordinateEvent({
      eventType: 'dynamic-plan',
      summary: dynamicEvent.summary,
      eventDetails: dynamicEvent.details,
      eventContextText: dynamicContextText,
      artifactHint: null,
      emitEvent,
      phase: 'dynamic-plan',
      wave,
      taskId: stragglerTask.id,
      source: 'dynamic-plan',
      modelOverride: dynamicPlanSpec.model,
      effortOverride: dynamicPlanSpec.effort,
    });
    if (coordinatedDynamicPlan?.coordinatorBacked) {
      const injectionId = coerceString(coordinatedDynamicPlan.actionOutcome?.inject?.injectionId);
      if (!injectionId) {
        emitEvent?.({
          type: 'dynamic.replan.empty',
          wave,
          coordinatorBacked: true,
          rawPlanText: coordinatedDynamicPlan.eventSummary ?? null,
        });
        return snapshot({ lastDynamicAt: now });
      }
      const injectionOutcome = await this.#resolveQueuedRuntimeInjection({
        injectionId,
        drainQueue: drainRuntimeInjections,
      });
      if (injectionOutcome) {
        await this.#reportCoordinatorInjectionOutcome({
          eventType: 'dynamic-plan-result',
          phase: 'dynamic-plan',
          wave,
          taskId: stragglerTask.id,
          label: `Dynamic assist wave ${wave}`,
          outcome: injectionOutcome,
          emitEvent,
          eventContextText: `Straggler task: ${stragglerTask.id}`,
        });
      }
      const appliedTaskIds = Array.isArray(injectionOutcome?.taskIds)
        ? injectionOutcome.taskIds
        : [];
      if (injectionOutcome?.status !== 'applied' || appliedTaskIds.length === 0) {
        if (injectionOutcome?.status === 'failed' || injectionOutcome?.status === 'timeout' || injectionOutcome?.status === 'cancelled') {
          emitEvent?.({
            type: 'dynamic.replan.failed',
            wave,
            error: injectionOutcome?.error ?? `runtime injection ${injectionOutcome?.status ?? 'failed'}`,
            coordinatorBacked: true,
            rawPlanText: coordinatedDynamicPlan.eventSummary ?? null,
          });
        } else {
          emitEvent?.({
            type: 'dynamic.replan.empty',
            wave,
            coordinatorBacked: true,
            rawPlanText: coordinatedDynamicPlan.eventSummary ?? null,
          });
        }
        return snapshot({ lastDynamicAt: now });
      }

      emitEvent?.({
        type: 'dynamic.replan.injected',
        wave,
        tasks: appliedTaskIds,
        taskCount: appliedTaskIds.length,
        rawPlanText: coordinatedDynamicPlan.eventSummary ?? null,
        coordinatorBacked: true,
      });

      return {
        dynamicWaves: wave,
        lastDynamicAt: now,
        total: taskStates.size || 1,
        soloTaskId: nextSoloTaskId,
        soloSince: nextSoloSince,
      };
    }

    const assistPlan = await this.#planAssistTasks({
      goal,
      stragglerTask: {
        id: stragglerTask.id,
        description: stragglerTask.description,
        worktreePath: stragglerState.worktreePath,
      },
      completedTasks,
      desiredCount,
      repoIndex: repoIndexText,
      contextSnapshot: snapshotText,
      gitStatusSummary,
      emitEvent,
      wave,
    });
    await this.#coordinateEvent({
      eventType: 'dynamic-plan',
      summary: dynamicEvent.summary,
      eventDetails: dynamicEvent.details,
      artifactHint: assistPlan?.coordination ?? null,
      emitEvent,
      phase: 'dynamic-plan',
      wave,
      taskId: stragglerTask.id,
      source: 'dynamic-plan',
    });

    const planned = Array.isArray(assistPlan?.tasks) ? assistPlan.tasks : [];
    if (planned.length === 0) {
      emitEvent?.({
        type: 'dynamic.replan.empty',
        wave,
      });
      return snapshot({ lastDynamicAt: now });
    }

    const existingIds = new Set(taskMap.keys());
    const normalised = normaliseTasks(planned, {
      existingIds,
      prefix: `assist-w${wave}-`,
      limit: desiredCount,
      pathLayout: this.taskPathLayout,
    });

    if (normalised.length === 0) {
      emitEvent?.({
        type: 'dynamic.replan.empty',
        wave,
      });
      return snapshot({ lastDynamicAt: now });
    }

    const completedIds = completedTasks.map(task => task.id);
    const newTaskIds = normalised.map(task => task.id);
    const knownIds = new Set([...existingIds, ...newTaskIds]);

    for (const newTask of normalised) {
      const deps = new Set();
      for (const dep of [...(newTask.dependsOn ?? []), ...completedIds]) {
        if (typeof dep !== 'string') continue;
        const trimmed = dep.trim();
        if (!trimmed) continue;
        deps.add(trimmed);
      }
      deps.delete(newTask.id);
      deps.delete(stragglerId);
      newTask.dependsOn = [...deps].filter(dep => knownIds.has(dep));
    }

    const injected = [];
    const enqueue = typeof pushReady === 'function' ? pushReady : taskId => ready.push(taskId);

    try {
      for (const newTask of normalised) {
        if (taskLimitReached(MAX_TOTAL_TASKS, taskStates.size)) break;
        validateSharedTaskOwnership(newTask);
        let branch = null;
        let worktreePath = repoRoot;
        if (USE_GIT_WORKTREES) {
          branch = `cdx/task/${runId}/${newTask.id}`;
          worktreePath = path.join(tasksRoot, newTask.id);
          await createWorktree({
            repoRoot,
            worktreePath,
            branch,
            baseRef: integrationBranch,
            log: (...args) => this.sendLog(args.join(' ')),
            sparse: this.worktreeSparseConfig,
            externalize: this.worktreeExternalizeConfig,
          });
          await this.#syncProjectCodexConfigToWorktree({
            repoRoot,
            worktreePath,
            emitEvent,
            label: `task:${newTask.id}`,
          });
          await ensureInitialCommit({
            cwd: worktreePath,
            message: `cdx: init task ${newTask.id}`,
            log: (...args) => this.sendLog(args.join(' ')),
          });
        }

        taskStates.set(newTask.id, new TaskState(newTask, { branch, worktreePath }));
        taskMap.set(newTask.id, newTask);
        tasks.push(newTask);

        emitEvent?.({
          type: USE_GIT_WORKTREES ? 'worktree.created' : 'task.prepared',
          taskId: newTask.id,
          description: newTask.description,
          dependsOn: newTask.dependsOn,
          branch,
          worktreePath,
          dynamicWave: wave,
          ownership: USE_GIT_WORKTREES ? undefined : resolveTaskOwnedPaths(newTask),
        });

        injected.push(newTask.id);
      }

      for (const newTaskId of injected) {
        const newTask = taskMap.get(newTaskId);
        if (!newTask) continue;

        const deps = (newTask.dependsOn ?? []).filter(
          dep => dep !== newTaskId && dep !== stragglerId && taskMap.has(dep),
        );

        const depSet = new Set(deps);
        for (const dep of deps) {
          if (!dependents.has(dep)) dependents.set(dep, []);
          dependents.get(dep).push(newTaskId);

          const depState = taskStates.get(dep);
          if (depState && isResolvedTaskStatus(depState.status)) {
            depSet.delete(dep);
          }
        }

        remainingDeps.set(newTaskId, depSet);
        if (depSet.size === 0 && taskStates.get(newTaskId)?.status === 'pending') {
          enqueue(newTaskId);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? 'unknown error');
      emitEvent?.({
        type: 'dynamic.replan.failed',
        wave,
        error: message,
      });
      return snapshot({ lastDynamicAt: now });
    }

    emitEvent?.({
      type: 'dynamic.replan.injected',
      wave,
      tasks: injected,
      taskCount: injected.length,
      rawPlanText: assistPlan?.rawPlanText ?? null,
    });

    return {
      dynamicWaves: wave,
      lastDynamicAt: now,
      total: taskStates.size || 1,
      soloTaskId: nextSoloTaskId,
      soloSince: nextSoloSince,
    };
  }

  async #runTasks({
    goal,
    tasks,
    taskStates,
    maxParallelism,
    minParallelism,
    autoscale,
    emitEvent,
    repoRoot,
    tasksRoot,
    runId,
    integrationBranch,
    checklistConfig,
    progressStart,
    progressEnd,
  }) {
    const progressStartValue = Number.isFinite(progressStart)
      ? Math.max(0, Math.min(progressStart, 1))
      : 0.12;
    const progressEndValue = Number.isFinite(progressEnd)
      ? Math.max(progressStartValue, Math.min(progressEnd, 1))
      : 0.8;
    const progressRange = Math.max(0, progressEndValue - progressStartValue);

    const resolvedMaxParallelism = Math.max(1, Number.parseInt(maxParallelism, 10) || 1);
    const resolvedMinParallelism = Math.max(
      1,
      Math.min(resolvedMaxParallelism, Number.parseInt(minParallelism, 10) || 1),
    );
    const effectiveMaxParallelism = Math.min(
      resolvedMaxParallelism,
      Math.max(1, Array.isArray(tasks) ? tasks.length : resolvedMaxParallelism),
    );
    const effectiveMinParallelism = Math.max(
      1,
      Math.min(resolvedMinParallelism, effectiveMaxParallelism),
    );
    const checklistModeActive = checklistConfig?.mode === 'checklist';
    const checklistLastItemId = checklistModeActive
      ? String(checklistConfig.items.at(-1)?.id ?? '')
      : '';
    const checklistNextCycleByTarget = checklistModeActive
      ? new Map(checklistConfig.targets.map(target => [target.id, 2]))
      : new Map();
    const autoscaleParallelism = autoscale !== false;
    let dynamicMaxParallelism =
      autoscaleParallelism && PARALLELISM_RAMP_ENABLED
        ? effectiveMinParallelism
        : effectiveMaxParallelism;

    const taskMap = new Map(tasks.map(task => [task.id, task]));
    const dependents = new Map();
    const remainingDeps = new Map();

    for (const task of tasks) {
      const deps = (task.dependsOn ?? []).filter(dep => dep !== task.id && taskMap.has(dep));
      const depSet = new Set(deps);
      for (const dep of deps) {
        if (!dependents.has(dep)) dependents.set(dep, []);
        dependents.get(dep).push(task.id);

        const depState = taskStates.get(dep);
        if (depState && isResolvedTaskStatus(depState.status)) {
          depSet.delete(dep);
        }
      }
      remainingDeps.set(task.id, depSet);
    }

    const ready = [];
    const readySet = new Set();
    const readyOrder = new Map();
    let readySeq = 0;

    const hasTrackedMergeConflict = state =>
      Number.isFinite(state?.mergeConflictSinceAt) && state.mergeConflictSinceAt > 0;

    const removeReady = taskId => {
      if (!taskId || !readySet.has(taskId)) return;
      readySet.delete(taskId);
      for (let idx = ready.length - 1; idx >= 0; idx -= 1) {
        if (ready[idx] === taskId) ready.splice(idx, 1);
      }
    };

    const pushReady = taskId => {
      if (!taskId || readySet.has(taskId)) return;
      const state = taskStates.get(taskId);
      if (!state || state.status !== 'pending' || hasTrackedMergeConflict(state)) return;
      if (!readyOrder.has(taskId)) readyOrder.set(taskId, readySeq++);
      ready.push(taskId);
      readySet.add(taskId);
    };

    const pendingDependentsScore = taskId => {
      const list = dependents.get(taskId) ?? [];
      let pendingCount = 0;
      for (const dependentId of list) {
        const state = taskStates.get(dependentId);
        if (state && state.status === 'pending') pendingCount += 1;
      }
      return pendingCount;
    };

    const pickNextReady = () => {
      if (ready.length === 0) return null;

      let bestIdx = -1;
      let bestScore = -1;
      let bestOrder = Number.MAX_SAFE_INTEGER;

      for (let idx = 0; idx < ready.length; idx += 1) {
        const candidate = ready[idx];
        const state = taskStates.get(candidate);
        if (!state || state.status !== 'pending' || hasTrackedMergeConflict(state)) continue;
        const score = pendingDependentsScore(candidate);
        const order = readyOrder.get(candidate) ?? Number.MAX_SAFE_INTEGER;
        if (score > bestScore || (score === bestScore && order < bestOrder)) {
          bestIdx = idx;
          bestScore = score;
          bestOrder = order;
        }
      }

      if (bestIdx === -1) {
        for (let idx = ready.length - 1; idx >= 0; idx -= 1) {
          const candidate = ready[idx];
          const state = taskStates.get(candidate);
          if (!state || state.status !== 'pending' || hasTrackedMergeConflict(state)) {
            ready.splice(idx, 1);
            readySet.delete(candidate);
          }
        }
        return null;
      }

      const nextId = ready.splice(bestIdx, 1)[0] ?? null;
      if (nextId) readySet.delete(nextId);
      return nextId;
    };

    for (const [taskId, depSet] of remainingDeps.entries()) {
      const state = taskStates.get(taskId);
      if (state?.status === 'pending' && depSet.size === 0) pushReady(taskId);
    }

    let total = taskStates.size || 1;
    const initialReady = ready.length;
    if (dynamicMaxParallelism > 1 && initialReady < dynamicMaxParallelism) {
      this.sendLog(
        `Scheduler note: only ${initialReady} task(s) are runnable initially (targetParallelism=${dynamicMaxParallelism}). This usually means the plan has a dependency chain.`,
      );
    } else if (autoscaleParallelism && PARALLELISM_RAMP_ENABLED && dynamicMaxParallelism < effectiveMaxParallelism) {
      this.sendLog(
        `Scheduler ramp: start maxParallelism=${dynamicMaxParallelism}, target=${effectiveMaxParallelism}, min=${effectiveMinParallelism}.`,
      );
    } else {
      this.sendLog(
        `Scheduler: totalTasks=${total} autoscale=${autoscaleParallelism} maxParallelism=${dynamicMaxParallelism} minParallelism=${effectiveMinParallelism} initialReady=${initialReady}`,
      );
    }

    let currentParallelism = autoscaleParallelism
      ? Math.max(
        effectiveMinParallelism,
        Math.min(dynamicMaxParallelism, initialReady),
      )
      : dynamicMaxParallelism;

    emitEvent?.({
      type: 'scheduler.initialized',
      totalTasks: total,
      parallelism: dynamicMaxParallelism,
      maxParallelism: dynamicMaxParallelism,
      minParallelism: effectiveMinParallelism,
      autoscale: autoscaleParallelism,
      currentParallelism,
      initialReady,
    });
    const resolved = new Set();
    const running = new Set();
    const runningTasks = new Map(); // promise -> taskId
    const runningTaskIds = new Set();
    for (const [taskId, state] of taskStates.entries()) {
      if (isResolvedTaskStatus(state.status)) {
        resolved.add(taskId);
      }
    }

    const taskOwnershipPaths = taskId => {
      const task = taskMap.get(taskId);
      return resolveTaskOwnedPaths(task);
    };

    const canScheduleChecklistCycle = (targetId, cycle) => {
      if (!checklistModeActive) return false;
      if (!targetId) return false;
      const configuredMax = Number.parseInt(checklistConfig?.maxCycles, 10);
      if (!Number.isFinite(configuredMax) || configuredMax <= 0) {
        return checklistConfig?.continuous === true || checklistConfig?.maxCycles === null;
      }
      return cycle <= configuredMax;
    };

    const registerRuntimeInjectionTasks = async ({
      plannedTasks,
      prefix = null,
      limit = undefined,
      ignoreDepIds = [],
      taskEventFields = {},
      injectionPolicy = null,
    } = {}) => {
      const rawTasks = Array.isArray(plannedTasks) ? plannedTasks : [];
      if (rawTasks.length === 0) {
        return {
          normalised: [],
          sanitized: {
            tasks: [],
            mutated: false,
            removedDependencyCount: 0,
            affectedTaskIds: [],
            removedByTask: [],
            policy: null,
          },
          injected: [],
        };
      }

      const normalised = normaliseTasks(rawTasks, {
        existingIds: new Set(taskMap.keys()),
        prefix,
        limit,
        pathLayout: this.taskPathLayout,
      });
      const sanitized = sanitizeRuntimeInjectedTasks(normalised, injectionPolicy ?? {});
      const effectiveTasks = sanitized.tasks;
      const injected = [];
      const ignoredDeps = new Set(
        Array.isArray(ignoreDepIds)
          ? ignoreDepIds.filter(Boolean).map(value => String(value))
          : [],
      );

      for (const newTask of effectiveTasks) {
        if (!newTask?.id || taskMap.has(newTask.id)) continue;
        if (taskLimitReached(MAX_TOTAL_TASKS, taskStates.size)) break;
        validateSharedTaskOwnership(newTask);

        let branch = null;
        let worktreePath = repoRoot;
        if (USE_GIT_WORKTREES) {
          branch = `cdx/task/${runId}/${newTask.id}`;
          worktreePath = path.join(tasksRoot, newTask.id);
          await createWorktree({
            repoRoot,
            worktreePath,
            branch,
            baseRef: integrationBranch,
            log: (...args) => this.sendLog(args.join(' ')),
            sparse: this.worktreeSparseConfig,
            externalize: this.worktreeExternalizeConfig,
          });
          await this.#syncProjectCodexConfigToWorktree({
            repoRoot,
            worktreePath,
            emitEvent,
            label: `task:${newTask.id}`,
          });
          await ensureInitialCommit({
            cwd: worktreePath,
            message: `cdx: init task ${newTask.id}`,
            log: (...args) => this.sendLog(args.join(' ')),
          });
        }

        taskStates.set(newTask.id, new TaskState(newTask, { branch, worktreePath }));
        taskMap.set(newTask.id, newTask);
        tasks.push(newTask);

        emitEvent?.({
          type: USE_GIT_WORKTREES ? 'worktree.created' : 'task.prepared',
          taskId: newTask.id,
          description: newTask.description,
          dependsOn: newTask.dependsOn,
          branch,
          worktreePath,
          ownership: USE_GIT_WORKTREES ? undefined : resolveTaskOwnedPaths(newTask),
          checklist: newTask.checklist ?? null,
          ...taskEventFields,
        });

        injected.push(newTask.id);
      }

      for (const newTaskId of injected) {
        const newTask = taskMap.get(newTaskId);
        if (!newTask) continue;
        const deps = (newTask.dependsOn ?? []).filter(
          dep => dep !== newTaskId && !ignoredDeps.has(dep) && taskMap.has(dep),
        );
        newTask.dependsOn = deps;

        const depSet = new Set(deps);
        for (const dep of deps) {
          if (!dependents.has(dep)) dependents.set(dep, []);
          dependents.get(dep).push(newTaskId);
          const depState = taskStates.get(dep);
          if (depState && isResolvedTaskStatus(depState.status)) {
            depSet.delete(dep);
          }
        }
        remainingDeps.set(newTaskId, depSet);
        if (depSet.size === 0 && taskStates.get(newTaskId)?.status === 'pending') {
          pushReady(newTaskId);
        }
      }

      total = taskStates.size || 1;
      return { normalised, sanitized, injected };
    };

    const injectChecklistCycle = async (targetId, cycle) => {
      if (!checklistModeActive) return [];
      if (!repoRoot || !tasksRoot || !runId) return [];
      if (!canScheduleChecklistCycle(targetId, cycle)) return [];

      const planned = buildChecklistTasks(checklistConfig, {
        cycle,
        targetIds: [targetId],
      });
      const { injected } = await registerRuntimeInjectionTasks({
        plannedTasks: planned,
      });

      if (injected.length > 0) {
        checklistNextCycleByTarget.set(targetId, cycle + 1);
        emitEvent?.({
          type: 'checklist.cycle.injected',
          targetId,
          cycle,
          taskCount: injected.length,
          tasks: injected,
        });
      }

      return injected;
    };

    const hasRunningOwnershipConflict = taskId => {
      if (USE_GIT_WORKTREES) return false;
      const candidatePaths = taskOwnershipPaths(taskId);
      if (candidatePaths.length === 0) return runningTaskIds.size > 0;
      for (const runningTaskId of runningTaskIds) {
        const activePaths = taskOwnershipPaths(runningTaskId);
        if (activePaths.length === 0) return true;
        if (ownershipPathsConflict(candidatePaths, activePaths)) {
          return true;
        }
      }
      return false;
    };

    let lastProgress = progressStartValue;

    let dynamicWaves = 0;
    let lastDynamicAt = 0;
    let soloTaskId = null;
    let soloSince = 0;
    let stallReplanWaves = 0;
    const watchdogMinAgents = Math.max(2, resolvedMinParallelism);
    let watchdogWave = 0;
    let watchdogRunning = false;
    let watchdogPromise = null;
    let watchdogMergeAskRecovery = null;
    let lastWatchdogAt = 0;
    let lastWatchdogInterventionAt = 0;
    let lastProgressAt = Date.now();
    let lastNoProgressInterventionAt = 0;
    let lastPeriodicInterventionAt = 0;
    let lastPeriodicInterventionTurn = Number.isFinite(this.turnCounter) ? this.turnCounter : 0;

    const schedulerStartedAt = Date.now();

    const sleep = ms =>
      new Promise(resolve => {
        const timer = setTimeout(resolve, ms);
        if (timer.unref) timer.unref();
      });

    const formatDuration = ms => {
      if (!Number.isFinite(ms) || ms < 0) return '-';
      const totalSeconds = Math.floor(ms / 1000);
      const seconds = totalSeconds % 60;
      const minutes = Math.floor(totalSeconds / 60) % 60;
      const hours = Math.floor(totalSeconds / 3600);

      if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
      }
      return `${minutes}:${String(seconds).padStart(2, '0')}`;
    };

    const estimateRemainingMs = (elapsedMs, done, totalCount) => {
      if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return null;
      const doneNum = Number.parseInt(done, 10);
      const totalNum = Number.parseInt(totalCount, 10);
      if (!Number.isFinite(doneNum) || !Number.isFinite(totalNum) || doneNum <= 0 || totalNum <= 0) {
        return null;
      }
      if (doneNum >= totalNum) return 0;
      const estimatedTotalMs = elapsedMs * (totalNum / doneNum);
      return Math.max(0, Math.round(estimatedTotalMs - elapsedMs));
    };

    const idleWarnMs = TASK_IDLE_WARN_MS;
    const idleTimeoutMs = TASK_IDLE_TIMEOUT_MS;
    const taskTimeoutMs = TASK_TIMEOUT_MS;
    const watchdogInterventionEnabled = WATCHDOG_INTERVENTION_ENABLED;
    const watchdogInterventionIntervalMs = WATCHDOG_INTERVENTION_INTERVAL_MS;
    const respawnIdleMs = WATCHDOG_RESPAWN_IDLE_MS;
    const blockedRespawnIdleMs = WATCHDOG_RESPAWN_BLOCKED_IDLE_MS;
    const fullQueueRespawnIdleMs = WATCHDOG_RESPAWN_FULL_QUEUE_IDLE_MS;
    const respawnMax = WATCHDOG_RESPAWN_MAX;
    const respawnCooldownMs = WATCHDOG_RESPAWN_COOLDOWN_MS;
    const respawnMaxPerWave = WATCHDOG_RESPAWN_MAX_PER_WAVE;
    const retryFailedEnabled = WATCHDOG_RETRY_FAILED_ENABLED;
    const retryFailedMax = WATCHDOG_RETRY_FAILED_MAX;
    const retryFailedCooldownMs = WATCHDOG_RETRY_FAILED_COOLDOWN_MS;

    const formatIdle = ms => (Number.isFinite(ms) ? formatDuration(ms) : '-');

    const refreshProgressFromActivity = () => {
      const latest = Number.isFinite(this.lastTaskActivityAt) ? this.lastTaskActivityAt : 0;
      if (latest > lastProgressAt) {
        lastProgressAt = latest;
      }
    };

    const warnIdleTask = (taskId, state, idleMs) => {
      if (!idleWarnMs || idleMs < idleWarnMs) return false;
      if (state.idleWarnedAt) return false;
      state.idleWarnedAt = Date.now();
      const message =
        `Watchdog: no activity for ${formatIdle(idleMs)}. `
        + 'If work remains, continue it immediately. '
        + 'If blocked or waiting on a decision, call router.ask with options.';
      this.enqueueAgentMessage({ taskId, message, source: 'watchdog' });
      emitEvent?.({
        type: 'task.idle.warn',
        taskId,
        idleMs,
        lastActivityAt: state.lastActivityAt ?? null,
        lastActivity: state.lastActivity ?? null,
      });
      this.sendLog(`[watchdog] idle warn for ${taskId} (${formatIdle(idleMs)} idle).`);
      return true;
    };

    const abortRunningTask = (taskId, state, reason, meta = {}) => {
      if (!state || state.status !== 'running') return false;
      const ok = state.requestAbort(reason);
      if (!ok) return false;
      emitEvent?.({
        type: 'task.abort.requested',
        taskId,
        reason,
        source: 'watchdog',
        ...meta,
      });
      this.sendLog(`[watchdog] aborting ${taskId}: ${reason}`);
      return true;
    };

    const checkTaskHealth = async () => {
      const now = Date.now();
      const runningIds = [...runningTasks.values()];
      for (const taskId of runningIds) {
        const state = taskStates.get(taskId);
        if (!state || state.status !== 'running') continue;

        const elapsedMs = state.durationMs();
        if (!state.client && !state.abortRequestedAt) {
          const reason = 'worker missing; respawning task';
          if (respawnRunningTask(taskId, state, reason, { missingClient: true })) {
            continue;
          }
        }

        if (taskTimeoutMs > 0 && Number.isFinite(elapsedMs) && elapsedMs > taskTimeoutMs) {
          abortRunningTask(taskId, state, `task timeout after ${formatIdle(elapsedMs)}`, {
            elapsedMs,
          });
          continue;
        }

        const lastAt = state.lastActivityAt ?? state.startedAt ?? null;
        if (!Number.isFinite(lastAt)) continue;
        const idleMs = Math.max(0, now - lastAt);
        if (idleTimeoutMs > 0 && idleMs >= idleTimeoutMs) {
          abortRunningTask(taskId, state, `idle timeout after ${formatIdle(idleMs)}`, {
            idleMs,
            lastActivityAt: state.lastActivityAt ?? null,
            lastActivity: state.lastActivity ?? null,
          });
          continue;
        }
        warnIdleTask(taskId, state, idleMs);
      }
    };

    const computeIdleMs = (state, now) => {
      const lastAt = state?.lastActivityAt ?? state?.startedAt ?? null;
      if (!Number.isFinite(lastAt)) return null;
      return Math.max(0, now - lastAt);
    };

    // A running task that starves the queue needs a much faster recovery path than the
    // generic idle timeout used for isolated workers.
    const computeBlockingRespawnThresholdMs = ({ blockedCount, pendingCount }) => {
      if (respawnIdleMs <= 0) return 0;
      let threshold = respawnIdleMs;
      if (blockedCount > 0 && blockedRespawnIdleMs > 0) {
        threshold = Math.min(threshold, blockedRespawnIdleMs);
      }
      if (
        pendingCount >= 2
        && blockedCount >= pendingCount
        && fullQueueRespawnIdleMs > 0
      ) {
        threshold = Math.min(threshold, fullQueueRespawnIdleMs);
      }
      return threshold;
    };

    const buildRunningMeta = now => {
      const meta = new Map();
      for (const taskId of runningTasks.values()) {
        const state = taskStates.get(taskId);
        if (!state || state.status !== 'running') continue;
        meta.set(taskId, {
          idleMs: computeIdleMs(state, now),
          lastActivity: state.lastActivity ?? null,
          hasClient: Boolean(state.client),
          abortRequestedAt: state.abortRequestedAt ?? null,
        });
      }
      return meta;
    };

    const diagnosePendingStates = (pendingStates, runningMeta) => {
      const summary = {
        runnable: [],
        waitingOnOwnership: [],
        blockedByFailed: [],
        blockedByBlocked: [],
        waitingOnRunning: [],
        waitingOnRunningIdle: [],
        waitingOnRunningMerge: [],
        waitingOnUnknown: [],
      };

      for (const state of pendingStates) {
        const taskId = state.task.id;
        const deps = [...(remainingDeps.get(taskId) ?? [])];
        if (deps.length === 0) {
          if (hasRunningOwnershipConflict(taskId)) {
            summary.waitingOnOwnership.push(taskId);
          } else {
            summary.runnable.push(taskId);
          }
          continue;
        }

        let hasRunning = false;
        let hasIdle = false;
        let hasFailed = false;
        let hasBlocked = false;
        let hasKnown = false;

        for (const depId of deps) {
          const depState = taskStates.get(depId);
          if (!depState) continue;
          hasKnown = true;
          if (depState.status === 'failed') {
            hasFailed = true;
          } else if (depState.status === 'blocked') {
            hasBlocked = true;
          } else if (depState.status === 'running') {
            hasRunning = true;
            const meta = runningMeta?.get(depId);
            if (Number.isFinite(meta?.idleMs) && respawnIdleMs > 0 && meta.idleMs >= respawnIdleMs) {
              hasIdle = true;
            }
            if (meta && meta.hasClient === false) {
              hasIdle = true;
            }
          }
        }

        if (hasFailed) {
          summary.blockedByFailed.push(taskId);
        } else if (hasBlocked) {
          summary.blockedByBlocked.push(taskId);
        } else if (hasIdle) {
          summary.waitingOnRunningIdle.push(taskId);
        } else if (hasRunning) {
          summary.waitingOnRunning.push(taskId);
        } else if (!hasKnown) {
          summary.waitingOnUnknown.push(taskId);
        } else {
          summary.waitingOnUnknown.push(taskId);
        }
      }

      return summary;
    };

    const cleanupMissingDeps = pendingStates => {
      let removed = 0;
      const fixed = [];
      for (const state of pendingStates) {
        const depSet = remainingDeps.get(state.task.id);
        if (!depSet || depSet.size === 0) continue;
        let changed = false;
        for (const dep of [...depSet]) {
          if (!taskStates.has(dep)) {
            depSet.delete(dep);
            removed += 1;
            changed = true;
          }
        }
        if (changed && Array.isArray(state.task.dependsOn)) {
          state.task.dependsOn = state.task.dependsOn.filter(dep => depSet.has(dep));
        }
        if (depSet.size === 0) {
          pushReady(state.task.id);
          fixed.push(state.task.id);
        }
      }
      return { removed, fixed };
    };

    const respawnRunningTask = (taskId, state, reason, meta = {}) => {
      if (!state || state.status !== 'running') return false;
      const { ignoreLimits = false, ...eventMeta } = meta ?? {};
      if (!ignoreLimits) {
        if (respawnMax <= 0) return false;
        if (state.respawnAttempts >= respawnMax) return false;
      }
      const now = Date.now();
      if (state.lastRespawnAt && now - state.lastRespawnAt < respawnCooldownMs) return false;
      if (!state.requestRespawn(reason)) return false;
      state.respawnAttempts += 1;
      state.lastRespawnAt = now;
      emitEvent?.({
        type: 'task.respawn.requested',
        taskId,
        reason,
        attempt: state.respawnAttempts,
        ...eventMeta,
      });
      this.sendLog(`[${eventMeta.source ?? 'watchdog'}] respawn requested for ${taskId}: ${reason}`);
      return true;
    };

    const isRetryableAbortReason = reason => {
      const normalized = String(reason ?? '').toLowerCase();
      if (!normalized) return false;
      if (normalized.includes('timeout') || normalized.includes('timed out')) return true;
      if (normalized.includes('idle')) return true;
      if (normalized.includes('rate limit') || normalized.includes('ratelimit')) return true;
      if (normalized.includes('app-server') || normalized.includes('app server')) return true;
      if (normalized.includes('dispose') || normalized.includes('disposed')) return true;
      if (normalized.includes('disconnect') || normalized.includes('disconnected')) return true;
      if (normalized.includes('closed') || normalized.includes('exited')) return true;
      if (normalized.includes('crash') || normalized.includes('terminated')) return true;
      return false;
    };

    const shouldRetryFailedTask = (state, error) => {
      if (!retryFailedEnabled || retryFailedMax <= 0) return false;
      if (!state) return false;
      if (state.retryAttempts >= retryFailedMax) return false;
      const now = Date.now();
      if (state.lastRetryAt && now - state.lastRetryAt < retryFailedCooldownMs) return false;
      if (state.abortRequestedAt && state.abortAction !== 'respawn') {
        if (!isRetryableAbortReason(state.abortReason)) return false;
      }
      const message = error instanceof Error ? error.message : String(error ?? '');
      if (message && /abort/i.test(message) && !isRetryableAbortReason(message)) return false;
      return true;
    };

    const queueTaskRetry = (taskId, state, reason, meta = {}) => {
      if (!retryFailedEnabled || retryFailedMax <= 0) return false;
      if (!state) return false;
      if (state.retryAttempts >= retryFailedMax) return false;
      const now = Date.now();
      if (state.lastRetryAt && now - state.lastRetryAt < retryFailedCooldownMs) return false;

      const reasonText = clipText(String(reason ?? 'task failed'), 200);
      state.retryAttempts += 1;
      state.lastRetryAt = now;
      state.bumpEffortOverride();
      state.resetForRetry({ reason: reasonText, source: meta.source ?? 'watchdog' });
      resolved.delete(taskId);

      emitEvent?.({
        type: 'task.retry.requested',
        taskId,
        reason: reasonText,
        attempt: state.retryAttempts,
        effort: state.effortOverride ?? null,
        ...meta,
      });
      this.sendLog(`[${meta.source ?? 'watchdog'}] retrying ${taskId}: ${reasonText}`);
      sendSchedulerProgress(`Retrying task ${taskId}: ${reasonText}`);

      const depSet = remainingDeps.get(taskId);
      if (!depSet || depSet.size === 0) pushReady(taskId);

      const dependentsForTask = dependents.get(taskId) ?? [];
      for (const dependentId of dependentsForTask) {
        const dependentState = taskStates.get(dependentId);
        if (!dependentState || dependentState.status !== 'blocked') continue;
        dependentState.resetForRetry({ reason: `dependency ${taskId} retry`, source: 'dependency' });
        resolved.delete(dependentId);
        emitEvent?.({
          type: 'task.unblocked',
          taskId: dependentId,
          reason: `dependency ${taskId} retry`,
        });
        const dependentDeps = remainingDeps.get(dependentId);
        if (!dependentDeps || dependentDeps.size === 0) {
          pushReady(dependentId);
        }
      }

      return true;
    };

    const respawnBlockingTasks = (pendingStates, runningMeta) => {
      if (respawnIdleMs <= 0 || respawnMax <= 0) return 0;
      const pendingCount = pendingStates.length;
      const blockingCounts = new Map();
      for (const state of pendingStates) {
        const deps = remainingDeps.get(state.task.id) ?? new Set();
        for (const depId of deps) {
          const depState = taskStates.get(depId);
          if (!depState || depState.status !== 'running') continue;
          blockingCounts.set(depId, (blockingCounts.get(depId) ?? 0) + 1);
        }
      }

      const candidates = [];
      for (const [taskId, count] of blockingCounts.entries()) {
        const state = taskStates.get(taskId);
        if (!state || state.status !== 'running') continue;
        const meta = runningMeta.get(taskId);
        const idleMs = meta?.idleMs ?? null;
        const orphaned = meta?.hasClient === false;
        const blockingRespawnThresholdMs = orphaned
          ? 0
          : computeBlockingRespawnThresholdMs({ blockedCount: count, pendingCount });
        if (!orphaned && (idleMs === null || idleMs < blockingRespawnThresholdMs)) continue;
        candidates.push({
          taskId,
          state,
          idleMs: idleMs ?? 0,
          count,
          orphaned,
          blockingRespawnThresholdMs,
        });
      }

      candidates.sort((a, b) => {
        if (a.orphaned !== b.orphaned) return a.orphaned ? -1 : 1;
        if (a.count !== b.count) return b.count - a.count;
        const aOver = Math.max(0, a.idleMs - a.blockingRespawnThresholdMs);
        const bOver = Math.max(0, b.idleMs - b.blockingRespawnThresholdMs);
        if (aOver !== bOver) return bOver - aOver;
        return b.idleMs - a.idleMs;
      });

      let respawned = 0;
      for (const candidate of candidates) {
        if (respawned >= respawnMaxPerWave) break;
        const reason = candidate.orphaned
          ? 'worker missing; respawning task'
          : `idle ${formatIdle(candidate.idleMs)} >= ${formatIdle(candidate.blockingRespawnThresholdMs)} while blocking ${candidate.count} pending task(s)`;
        if (respawnRunningTask(candidate.taskId, candidate.state, reason, {
          idleMs: candidate.idleMs,
          blockedCount: candidate.count,
          blockingRespawnThresholdMs: candidate.blockingRespawnThresholdMs,
        })) {
          respawned += 1;
        }
      }

      return respawned;
    };

    const shouldReplanForDiagnostics = (diagnostics, pendingStates) => {
      if (pendingStates.length === 0) return false;
      if (ready.length > 0) return false;
      if (running.size === 0) return true;
      const waitingActiveOnly =
        diagnostics.waitingOnRunning.length > 0
        && diagnostics.waitingOnRunning.length === pendingStates.length
        && diagnostics.waitingOnRunningIdle.length === 0
        && diagnostics.waitingOnRunningMerge.length === 0;
      if (waitingActiveOnly) return false;
      return true;
    };

    const computeCounts = () => {
      const counts = {
        total: taskStates.size || 0,
        pending: 0,
        running: 0,
        completed: 0,
        superseded: 0,
        failed: 0,
        blocked: 0,
      };
      for (const state of taskStates.values()) {
        switch (state.status) {
          case 'pending':
            counts.pending += 1;
            break;
          case 'running':
            counts.running += 1;
            break;
          case 'completed':
            counts.completed += 1;
            break;
          case 'superseded':
            counts.superseded += 1;
            break;
          case 'failed':
            counts.failed += 1;
            break;
          case 'blocked':
            counts.blocked += 1;
            break;
          default:
            break;
        }
      }
      return counts;
    };


    const deriveBottleneckKind = (counts, diagnostics) => {
      if (!counts || !diagnostics) return null;
      if (counts.running === 0 && counts.pending > 0 && diagnostics.runnable.length === 0) {
        return 'stalled';
      }
      if (diagnostics.waitingOnRunningMerge.length > 0) return 'merge';
      if (diagnostics.blockedByFailed.length > 0) return 'failed';
      if (diagnostics.blockedByBlocked.length > 0) return 'blocked';
      if (diagnostics.waitingOnRunningIdle.length > 0) return 'idle';
      if (diagnostics.waitingOnRunning.length > 0) return 'running';
      if (diagnostics.waitingOnOwnership.length > 0) return 'ownership';
      if (diagnostics.runnable.length > 0) return 'runnable';
      if (counts.pending > 0) return 'pending';
      return null;
    };

    const emitSchedulerSnapshot = (reason, { force = false } = {}) => {
      const now = Date.now();
      if (!force && SCHEDULER_SNAPSHOT_INTERVAL_MS > 0) {
        if (now - lastSchedulerSnapshotAt < SCHEDULER_SNAPSHOT_INTERVAL_MS) return;
      }
      lastSchedulerSnapshotAt = now;
      const counts = computeCounts();
      const pendingStates = [...taskStates.values()].filter(state => state.status === 'pending');
      const runningMeta = buildRunningMeta(now);
      const diagnostics = diagnosePendingStates(pendingStates, runningMeta);
      const bottleneckKind = deriveBottleneckKind(counts, diagnostics);
      emitEvent?.({
        type: 'scheduler.snapshot',
        reason: reason ?? null,
        totalTasks: counts.total,
        pendingTasks: counts.pending,
        runningTasks: counts.running,
        completedTasks: counts.completed,
        supersededTasks: counts.superseded,
        failedTasks: counts.failed,
        blockedTasks: counts.blocked,
        resolvedTasks: resolved.size,
        readyCount: ready.length,
        readyRunnableCount: diagnostics.runnable.length,
        ownershipBlockedCount: diagnostics.waitingOnOwnership.length,
        currentParallelism,
        maxParallelism: dynamicMaxParallelism,
        minParallelism: effectiveMinParallelism,
        autoscale: autoscaleParallelism,
        rateLimitHits: lastRateLimitStats.count ?? 0,
        rateLimitLastAt: lastRateLimitStats.lastAt ?? 0,
        rateLimitSource: lastRateLimitStats.source ?? null,
        ratePressureScore: lastRateLimitStats.pressureScore ?? 0,
        ratePressureLevel: lastRateLimitStats.pressureLevel ?? 'none',
        rateHeadroomPercent: lastRateLimitStats.headroomPercent ?? null,
        rateLimitShouldThrottle: lastRateLimitStats.shouldThrottle ?? false,
        rateLimitExhausted: lastRateLimitStats.exhausted ?? false,
        rateLimitNextResetAt: lastRateLimitStats.nextResetAt ?? null,
        rateLimitNextResetInMs: lastRateLimitStats.nextResetInMs ?? null,
        rateLimitWindowMs: RATE_LIMIT_WINDOW_MS,
        backpressureActive,
        backpressureReason,
        backpressureUntil,
        backpressureMaxParallelism: backpressureActive
          ? Math.min(backpressureMaxParallelism, dynamicMaxParallelism)
          : dynamicMaxParallelism,
        bottleneckKind,
      });
    };



    const decorateProgressMessage = baseMessage => {
      const counts = computeCounts();
      const resolvedCount = resolved.size;
      const elapsedMs = Date.now() - schedulerStartedAt;
      const etaMs = estimateRemainingMs(elapsedMs, resolvedCount, counts.total);
      const etaLabel = etaMs === null ? '-' : formatDuration(etaMs);
      const agentsLabel = autoscaleParallelism
        ? `agents ${running.size}/${currentParallelism} (max ${dynamicMaxParallelism})`
        : `agents ${running.size}/${dynamicMaxParallelism}`;
      const prefix =
        `${agentsLabel} · `
        + `tasks ${counts.completed}/${counts.total} (running ${counts.running}, superseded ${counts.superseded}, failed ${counts.failed}, blocked ${counts.blocked}) · `
        + `elapsed ${formatDuration(elapsedMs)} · eta ${etaLabel}`;
      return baseMessage ? `${prefix} · ${baseMessage}` : prefix;
    };

    const sendSchedulerProgress = (message, { resolveTaskId } = {}) => {
      if (resolveTaskId) {
        const before = resolved.size;
        resolved.add(resolveTaskId);
        if (resolved.size !== before) {
          lastProgressAt = Date.now();
        }
      }
      total = taskStates.size || 1;
      const ratio = resolved.size / Math.max(1, total);
      const progressValue = progressStartValue + Math.min(ratio, 1) * progressRange;
      const bounded = Math.min(progressValue, progressEndValue);
      lastProgress = Math.max(lastProgress, bounded);
      this.sendProgress({
        progress: lastProgress,
        message: decorateProgressMessage(message),
        total,
      });
    };

    const buildWatchdogSnapshotText = () => {
      const counts = computeCounts();
      const runningIds = [...runningTasks.values()];
      const nowMs = Date.now();

      const runningLimit = 12;
      const runningLines = runningIds
        .slice(0, runningLimit)
        .map(taskId => {
          const state = taskStates.get(taskId);
          const description = clipText(state?.task?.description ?? '', 160) || '(no description)';
          const durationMs = state?.durationMs();
          const durationLabel = Number.isFinite(durationMs) ? formatDuration(durationMs) : '-';
          const idleMs = Number.isFinite(state?.lastActivityAt)
            ? Math.max(0, nowMs - state.lastActivityAt)
            : null;
          const idleLabel = idleMs === null ? '-' : formatDuration(idleMs);
          const lastActivity = clipText(state?.lastActivity ?? '', 80) || '-';
          const latestPrompt = this.contextStore?.snapshot(taskId)?.recentPrompts?.slice?.(-1)?.[0] ?? null;
          const promptLabel = clipText(latestPrompt?.text ?? '', 120) || '-';
          return `- ${taskId}: ${description} (running ${durationLabel}, idle ${idleLabel}, last: ${lastActivity}, prompt: ${promptLabel})`;
        });
      const runningSuffix =
        runningIds.length > runningLimit ? `\n... +${runningIds.length - runningLimit} more` : '';

      const pendingStates = [...taskStates.values()].filter(state => state.status === 'pending');
      const pendingLimit = 15;
      const pendingLines = pendingStates
        .slice(0, pendingLimit)
        .map(state => {
          const taskId = state.task.id;
          const description = clipText(state.task.description ?? '', 140) || '(no description)';
          const deps = [...(remainingDeps.get(taskId) ?? [])];
          const depLabel = deps.length > 0 ? `waiting on: ${deps.join(', ')}` : 'no deps';
          return `- ${taskId}: ${description} (${depLabel})`;
        });
      const pendingSuffix =
        pendingStates.length > pendingLimit ? `\n... +${pendingStates.length - pendingLimit} more` : '';
      const pendingNoDeps = pendingStates.filter(state => {
        const deps = remainingDeps.get(state.task.id);
        return !deps || deps.size === 0;
      }).length;

      const readyLimit = 10;
      const readyLines = ready
        .slice(0, readyLimit)
        .map(taskId => {
          const task = taskMap.get(taskId);
          const description = clipText(task?.description ?? '', 140) || '(no description)';
          return `- ${taskId}: ${description}`;
        });
      const readySuffix = ready.length > readyLimit ? `\n... +${ready.length - readyLimit} more` : '';

      const blockedStates = [...taskStates.values()].filter(state => state.status === 'blocked');
      const blockedLimit = 10;
      const blockedLines = blockedStates
        .slice(0, blockedLimit)
        .map(state => {
          const description = clipText(state.task.description ?? '', 140) || '(no description)';
          const reason = clipText(state.error ?? 'blocked', 200);
          return `- ${state.task.id}: ${description} (reason: ${reason})`;
        });
      const blockedSuffix =
        blockedStates.length > blockedLimit ? `\n... +${blockedStates.length - blockedLimit} more` : '';

      const failedStates = [...taskStates.values()].filter(state => state.status === 'failed');
      const failedLimit = 10;
      const failedLines = failedStates
        .slice(0, failedLimit)
        .map(state => {
          const description = clipText(state.task.description ?? '', 140) || '(no description)';
          const reason = clipText(state.error ?? 'failed', 200);
          return `- ${state.task.id}: ${description} (error: ${reason})`;
        });
      const failedSuffix =
        failedStates.length > failedLimit ? `\n... +${failedStates.length - failedLimit} more` : '';

      const supersededStates = [...taskStates.values()].filter(state => state.status === 'superseded');
      const supersededLimit = 10;
      const supersededLines = supersededStates
        .slice(0, supersededLimit)
        .map(state => {
          const description = clipText(state.task.description ?? '', 140) || '(no description)';
          const reason = clipText(state.error ?? 'superseded', 200);
          return `- ${state.task.id}: ${description} (reason: ${reason})`;
        });
      const supersededSuffix =
        supersededStates.length > supersededLimit ? `\n... +${supersededStates.length - supersededLimit} more` : '';

      return [
        `parallelism: running ${running.size}, current ${currentParallelism}, min ${resolvedMinParallelism}, effectiveMin ${effectiveMinParallelism}, max ${dynamicMaxParallelism}, autoscale ${autoscaleParallelism}`,
        `threshold: ${watchdogMinAgents}`,
        `respawn idle: default ${formatIdle(respawnIdleMs)}, blocked ${formatIdle(blockedRespawnIdleMs)}, full-queue ${formatIdle(fullQueueRespawnIdleMs)}`,
        `readyQueue: ${ready.length}`,
        `pendingWithoutDeps: ${pendingNoDeps}`,
        `counts: total ${counts.total}, pending ${counts.pending}, running ${counts.running}, completed ${counts.completed}, superseded ${counts.superseded}, failed ${counts.failed}, blocked ${counts.blocked}`,
        'running tasks:',
        `${runningLines.length > 0 ? runningLines.join('\n') : '- none'}${runningSuffix}`,
        'ready tasks:',
        `${readyLines.length > 0 ? readyLines.join('\n') : '- none'}${readySuffix}`,
        'pending tasks:',
        `${pendingLines.length > 0 ? pendingLines.join('\n') : '- none'}${pendingSuffix}`,
        'superseded tasks:',
        `${supersededLines.length > 0 ? supersededLines.join('\n') : '- none'}${supersededSuffix}`,
        'blocked tasks:',
        `${blockedLines.length > 0 ? blockedLines.join('\n') : '- none'}${blockedSuffix}`,
        'failed tasks:',
        `${failedLines.length > 0 ? failedLines.join('\n') : '- none'}${failedSuffix}`,
      ].join('\n');
    };

    const runActiveIntervention = async reasonLabel => {
      let pendingStates = [...taskStates.values()].filter(state => state.status === 'pending');

      const actions = [];

      if (pendingStates.length > 0) {
        const cleanup = cleanupMissingDeps(pendingStates);
        if (cleanup.removed > 0) actions.push('deps-cleaned');
        if (cleanup.fixed.length > 0) actions.push('deps-ready');
      }

      const runningMeta = buildRunningMeta(Date.now());
      pendingStates = [...taskStates.values()].filter(state => state.status === 'pending');

      if (pendingStates.length === 0) {
        emitEvent?.({
          type: 'watchdog.diagnosis',
          reason: reasonLabel ?? null,
          pending: 0,
          runnable: 0,
          blockedByFailed: 0,
          blockedByBlocked: 0,
          waitingOnRunning: 0,
          waitingOnRunningIdle: 0,
          waitingOnRunningMerge: 0,
          waitingOnUnknown: 0,
        });
        return { recovered: actions.length > 0, actions, pending: 0 };
      }

      let diagnostics = diagnosePendingStates(pendingStates, runningMeta);

      if (diagnostics.blockedByFailed.length > 0) {
        let retried = 0;
        const failedDeps = new Set();
        for (const taskId of diagnostics.blockedByFailed) {
          const deps = [...(remainingDeps.get(taskId) ?? [])];
          for (const depId of deps) {
            const depState = taskStates.get(depId);
            if (!depState || depState.status !== 'failed') continue;
            if (failedDeps.has(depId)) continue;
            if (shouldRetryFailedTask(depState, depState.error ?? null)) {
              if (queueTaskRetry(depId, depState, `retry after failure (blocked ${taskId})`, { source: 'watchdog' })) {
                retried += 1;
                failedDeps.add(depId);
              }
            }
          }
        }
        if (retried > 0) {
          actions.push('retry-failed');
          pendingStates = [...taskStates.values()].filter(state => state.status === 'pending');
          diagnostics = diagnosePendingStates(pendingStates, runningMeta);
        }
      }

      const blockedDecisions = selectDependencyBlockedActions(diagnostics);
      for (const taskId of blockedDecisions.unrecoverableTaskIds) {
        const deps = [...(remainingDeps.get(taskId) ?? [])];
        const reason = `Blocked by failed dependency: ${deps.join(', ') || 'unknown'}`;
        markBlocked(taskId, reason, deps[0] ?? null);
      }
      if (blockedDecisions.unrecoverableTaskIds.length > 0) actions.push('deps-blocked');

      pendingStates = [...taskStates.values()].filter(state => state.status === 'pending');
      diagnostics = diagnosePendingStates(pendingStates, runningMeta);

      for (const taskId of diagnostics.runnable) {
        pushReady(taskId);
      }
      if (diagnostics.runnable.length > 0) actions.push('runnable');

      const respawned = respawnBlockingTasks(pendingStates, runningMeta);
      if (respawned > 0) actions.push('respawn');

      const pendingAfter = [...taskStates.values()].filter(state => state.status === 'pending');
      const finalDiagnostics = diagnosePendingStates(pendingAfter, runningMeta);
      emitEvent?.({
        type: 'watchdog.diagnosis',
        reason: reasonLabel ?? null,
        pending: pendingAfter.length,
        runnable: finalDiagnostics.runnable.length,
        blockedByFailed: finalDiagnostics.blockedByFailed.length,
        blockedByBlocked: finalDiagnostics.blockedByBlocked.length,
        waitingOnRunning: finalDiagnostics.waitingOnRunning.length,
        waitingOnRunningIdle: finalDiagnostics.waitingOnRunningIdle.length,
        waitingOnRunningMerge: finalDiagnostics.waitingOnRunningMerge.length,
        waitingOnUnknown: finalDiagnostics.waitingOnUnknown.length,
      });

      let stallRecovered = false;
      if (shouldReplanForDiagnostics(finalDiagnostics, pendingAfter)) {
        stallRecovered = await recoverFromStall();
        if (stallRecovered) actions.push('stall-recover');
      }

      return {
        recovered: didInterventionMakeProgress(actions, stallRecovered),
        actions,
        pending: pendingAfter.length,
      };
    };

    const triggerWatchdogMergeAskRecovery = () => {
      if (!WATCHDOG_MERGE_ASK_RECOVERY_ENABLED) return;
      if (watchdogMergeAskRecovery) return;
      if (this.routerAskWaiters.size === 0) return;

      watchdogMergeAskRecovery = this.#recoverPendingMergeSupervisorAsks({ emitEvent })
        .then(outcome => {
          if (!outcome) return;
          if (outcome.recovered) {
            lastProgressAt = Date.now();
            sendSchedulerProgress('Recovered pending dependency merge asks');
          }
          if (outcome.recovered || outcome.failed > 0) {
            this.sendLog(
              `[watchdog] merge ask recovery: eligible=${outcome.eligible} groups=${outcome.takeoverGroups} takeoverRecovered=${outcome.takeoverRecovered} autoAnswered=${outcome.autoAnswered}${outcome.failed > 0 ? ` failed=${outcome.failed}` : ''}.`,
            );
          }
        })
        .catch(async err => {
          const message = err instanceof Error ? err.message : String(err ?? 'merge ask recovery failed');
          this.sendLog(`[watchdog] merge ask recovery failed: ${message}`);
        })
        .finally(() => {
          watchdogMergeAskRecovery = null;
        });
    };

    const buildWatchdogSignals = (now = Date.now()) => {
      const pendingStates = [...taskStates.values()]
        .filter(state => state.status === 'pending');
      const runningMeta = buildRunningMeta(now);
      const diagnostics = diagnosePendingStates(pendingStates, runningMeta);
      const actionablePending = pendingStates.length > 0;
      const noReadyWork = ready.length === 0;
      const noWorkers = running.size === 0;
      const waitingOnlyOnHealthyRunning =
        diagnostics.waitingOnRunning.length > 0
        && diagnostics.waitingOnRunning.length === pendingStates.length
        && diagnostics.waitingOnRunningIdle.length === 0
        && diagnostics.waitingOnRunningMerge.length === 0
        && diagnostics.waitingOnUnknown.length === 0
        && diagnostics.blockedByFailed.length === 0
        && diagnostics.blockedByBlocked.length === 0;
      const meaningfulShortfall =
        actionablePending
        && noReadyWork
        && (
          noWorkers
          || diagnostics.waitingOnRunningIdle.length > 0
          || diagnostics.waitingOnRunningMerge.length > 0
          || diagnostics.waitingOnUnknown.length > 0
          || diagnostics.blockedByFailed.length > 0
          || diagnostics.blockedByBlocked.length > 0
        )
        && !waitingOnlyOnHealthyRunning;

      return {
        pendingStates,
        runningMeta,
        diagnostics,
        actionablePending,
        noReadyWork,
        noWorkers,
        meaningfulShortfall,
        waitingOnlyOnHealthyRunning,
      };
    };

    const summarizeWatchdogOutcome = outcome => {
      const normalized = outcome && typeof outcome === 'object' ? outcome : null;
      if (!normalized) {
        return {
          recovered: false,
          actionLabels: [],
          reportText: null,
        };
      }
      return {
        recovered: normalized.recovered === true,
        actionLabels: Array.isArray(normalized.actionLabels)
          ? normalized.actionLabels.filter(Boolean)
          : [],
        reportText: coerceString(normalized.reportText ?? normalized.eventSummary),
      };
    };

    const maybeTriggerWatchdog = (options = {}) => {
      const force = options?.force === true;
      const forcedReason = typeof options?.reason === 'string' && options.reason.trim()
        ? options.reason.trim()
        : null;
      const now = Date.now();
      if (watchdogRunning) return watchdogPromise;
      const intervalDue = lastWatchdogAt === 0 || now - lastWatchdogAt >= WATCHDOG_INTERVAL_MS;
      const signals = buildWatchdogSignals(now);
      if (!signals.actionablePending) return null;

      const noProgressDue =
        NO_PROGRESS_TIMEOUT_MS > 0
        && now - lastProgressAt >= NO_PROGRESS_TIMEOUT_MS;
      if (!force && !intervalDue && !noProgressDue) return null;
      if (!signals.meaningfulShortfall && !noProgressDue) return null;

      watchdogRunning = true;
      lastWatchdogAt = now;
      watchdogWave += 1;
      const wave = watchdogWave;

      const reasonParts = [];
      if (force) reasonParts.push(forcedReason ?? 'forced');
      if (running.size < watchdogMinAgents) {
        reasonParts.push(`low-agents (running ${running.size} < ${watchdogMinAgents})`);
      }
      if (intervalDue) reasonParts.push('interval');
      if (noProgressDue) reasonParts.push('no-progress');
      if (signals.noWorkers && signals.noReadyWork) reasonParts.push('no-workers');
      const reasonLabel = reasonParts.join(', ') || 'unspecified';

      const snapshotText = buildWatchdogSnapshotText();
      const pendingWatchdog = this.#runWatchdog({
        goal,
        snapshotText,
        runId,
        repoRoot,
        emitEvent,
        wave,
        reason: { label: reasonLabel },
        drainRuntimeInjections: processRuntimeInjectionQueue,
      })
        .catch(async err => {
          const message = err instanceof Error ? err.message : String(err ?? 'unknown error');
          this.sendLog(`[watchdog] failed to run (wave ${wave}): ${message}`);
          return {
            reportText: null,
            actions: null,
            actionOutcome: null,
            artifactChanged: false,
            eventSummary: null,
            coordinatorBacked: false,
            recovered: false,
            actionLabels: [],
            steer: { broadcast: [], tasks: [] },
          };
        })
        .finally(() => {
          watchdogRunning = false;
          if (watchdogPromise === pendingWatchdog) {
            watchdogPromise = null;
          }
        });
      watchdogPromise = pendingWatchdog;
      return pendingWatchdog;
    };

    let lastHeartbeatAt = 0;
    const HEARTBEAT_INTERVAL_MS = 5_000;

      const markBlocked = (taskId, reason, origin) => {
        const state = taskStates.get(taskId);
        if (!state || state.status !== 'pending') return;
        state.block(reason ?? `Blocked by failed dependency ${origin}`);
        sendSchedulerProgress(`Blocked task ${taskId}`, { resolveTaskId: taskId });
      emitEvent?.({
        type: 'task.blocked',
        taskId,
        reason: state.error ?? null,
        blockedBy: origin ?? null,
        checklist: state.task.checklist ?? null,
      });
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
      this.sendLog(`Starting task ${taskId} in ${state.worktreePath}`);
      sendSchedulerProgress(`Started task ${taskId}`);
      emitEvent?.({
        type: 'task.started',
        taskId,
        description: task.description,
        dependsOn: task.dependsOn,
        branch: state.branch,
        worktreePath: state.worktreePath,
        checklist: task.checklist ?? null,
      });

        const promise = this.#executeTask({
          goal,
          state,
          task,
          taskStates,
          emitEvent,
        })
        .then(async () => {
          const completionEvent = buildTaskCompletionCoordinatorEvent(task, state);
          await this.#coordinateEvent({
            eventType: 'task.completed',
            summary: completionEvent.summary,
            eventDetails: completionEvent.details,
            artifactHint: buildTaskCompletionCoordinatorArtifact(task, state),
            emitEvent,
            phase: 'task',
            taskId,
            source: 'task-complete',
          });
          const dependentsForTask = dependents.get(taskId) ?? [];
          for (const dependentId of dependentsForTask) {
            const depSet = remainingDeps.get(dependentId);
            if (!depSet) continue;
            depSet.delete(taskId);
            if (depSet.size === 0 && taskStates.get(dependentId)?.status === 'pending') {
              pushReady(dependentId);
            }
          }
          sendSchedulerProgress(`Completed task ${taskId}`, { resolveTaskId: taskId });
          emitEvent?.({
            type: 'task.completed',
            taskId,
            description: task.description,
            branch: state.branch,
            commit: state.commit ?? null,
            changedFiles: Array.isArray(state.changedFiles) ? [...state.changedFiles] : [],
            checklist: task.checklist ?? null,
          });

          const taskChecklist = task.checklist ?? null;
          if (
            checklistModeActive
            && taskChecklist?.targetId
            && String(taskChecklist.itemId ?? '') === checklistLastItemId
          ) {
            try {
              const nextCycle = checklistNextCycleByTarget.get(taskChecklist.targetId) ?? 2;
              const injected = await injectChecklistCycle(taskChecklist.targetId, nextCycle);
              if (injected.length > 0) {
                total = taskStates.size || 1;
                sendSchedulerProgress(
                  `Queued checklist cycle ${nextCycle} for ${taskChecklist.targetLabel ?? taskChecklist.targetId}`,
                );
              }
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err ?? 'checklist injection failed');
              emitEvent?.({
                type: 'checklist.cycle.failed',
                targetId: taskChecklist.targetId,
                cycle: checklistNextCycleByTarget.get(taskChecklist.targetId) ?? null,
                error: message,
              });
              this.sendLog(`[checklist] failed to inject next cycle for ${taskChecklist.targetId}: ${message}`);
            }
          }
        })
        .catch(async err => {
          const error = err instanceof Error ? err : new Error(String(err ?? 'Task failed'));
          this.#recordRateLimitFailureCandidate(error, error?.name ?? 'error');
          if (state.abortAction === 'respawn') {
            const reason = state.abortReason ?? error.message;
            state.resetForRespawn({ reason });
            const depSet = remainingDeps.get(taskId);
            if (!depSet || depSet.size === 0) {
              pushReady(taskId);
            }
            emitEvent?.({
              type: 'task.respawned',
              taskId,
              reason,
              attempt: state.respawnAttempts,
              checklist: task.checklist ?? null,
            });
            this.sendLog(`[watchdog] respawned ${taskId}: ${reason}`);
            sendSchedulerProgress(`Respawned task ${taskId}: ${reason}`);
            return;
          }

          const finalError = state.abortReason ? new Error(state.abortReason) : error;
          if (shouldRetryFailedTask(state, finalError)) {
            if (queueTaskRetry(taskId, state, finalError.message, { source: 'failure' })) {
              return;
            }
          }

          state.fail(finalError);
          const failureEvent = buildTaskFailureCoordinatorEvent(task, finalError.message);
          await this.#coordinateEvent({
            eventType: 'task.failed',
            summary: failureEvent.summary,
            eventDetails: failureEvent.details,
            artifactHint: buildTaskFailureCoordinatorArtifact(task, state, 'failed'),
            emitEvent,
            phase: 'task',
            taskId,
            source: 'task-failed',
          });
          sendSchedulerProgress(`Failed task ${taskId}: ${finalError.message}`, { resolveTaskId: taskId });
          emitEvent?.({
            type: 'task.failed',
            taskId,
            description: task.description,
            branch: state.branch,
            error: finalError.message,
            checklist: task.checklist ?? null,
          });
          const dependentsForTask = dependents.get(taskId) ?? [];
          for (const dependentId of dependentsForTask) {
            markBlocked(dependentId, `Blocked by failed task ${taskId}: ${error.message}`, taskId);
          }
        })
        .finally(() => {
          running.delete(promise);
          runningTasks.delete(promise);
          runningTaskIds.delete(taskId);
          // Refill worker slots immediately when a task settles so newly-unblocked
          // tasks do not wait for the next scheduler tick.
          launchIfPossible();
        });

      running.add(promise);
      runningTasks.set(promise, taskId);
      runningTaskIds.add(taskId);
    };

    let lastEmittedParallelism = currentParallelism;
    let lastEmittedMaxParallelism = dynamicMaxParallelism;
    let lastRateLimitDownAt = 0;
    let lastRateLimitUpAt = 0;
    let lastRateLimitPressureAt = 0;
    let lastRateLimitStats = {
      count: 0,
      lastAt: 0,
      source: null,
      pressureScore: 0,
      pressureLevel: 'none',
      headroomPercent: null,
      shouldThrottle: false,
      exhausted: false,
      nextResetAt: null,
      nextResetInMs: null,
      snapshot: null,
      failure: null,
    };
    let backpressureActive = false;
    let backpressureReason = null;
    let backpressureUntil = 0;
    let backpressureMaxParallelism = dynamicMaxParallelism;
    let lastBackpressureEventAt = 0;
    let lastSchedulerSnapshotAt = 0;

    const computeRateLimitAdaptiveFloor = stats => {
      const headroomPercent = Number.isFinite(stats?.headroomPercent) ? stats.headroomPercent : null;
      const strongPressure =
        (stats?.count ?? 0) >= RATE_LIMIT_DOWN_THRESHOLD
        || stats?.exhausted === true
        || (stats?.pressureScore ?? 0) >= RATE_LIMIT_PRESSURE_HIGH_SCORE
        || (headroomPercent !== null && headroomPercent <= RATE_LIMIT_HEADROOM_HIGH_PERCENT);
      return strongPressure ? RATE_LIMIT_STRONG_PRESSURE_MIN_PARALLELISM : effectiveMinParallelism;
    };

    const computeRateLimitTargetCap = (stats, ratePressureFloor) => {
      const hitCount = stats?.count ?? 0;
      const pressureScore = stats?.pressureScore ?? 0;
      const headroomPercent = Number.isFinite(stats?.headroomPercent) ? stats.headroomPercent : null;
      const shouldThrottle = stats?.shouldThrottle === true;
      const exhausted = stats?.exhausted === true;

      if (
        hitCount >= RATE_LIMIT_DOWN_THRESHOLD + 1
        || exhausted
        || pressureScore >= RATE_LIMIT_PRESSURE_CRITICAL_SCORE
        || (headroomPercent !== null && headroomPercent <= 2)
      ) {
        return ratePressureFloor;
      }

      if (
        hitCount >= RATE_LIMIT_DOWN_THRESHOLD
        || shouldThrottle
        || pressureScore >= RATE_LIMIT_PRESSURE_HIGH_SCORE
        || (headroomPercent !== null && headroomPercent <= RATE_LIMIT_HEADROOM_HIGH_PERCENT)
      ) {
        return Math.max(ratePressureFloor, Math.min(2, effectiveMaxParallelism));
      }

      if (
        pressureScore >= RATE_LIMIT_PRESSURE_ELEVATED_SCORE
        || (headroomPercent !== null && headroomPercent <= RATE_LIMIT_HEADROOM_ELEVATED_PERCENT)
      ) {
        return Math.max(
          effectiveMinParallelism,
          Math.min(effectiveMaxParallelism, Math.ceil(effectiveMaxParallelism / 2)),
        );
      }

      return null;
    };

    const computeRateLimitBackpressureDurationMs = (stats, now) => {
      if (Number.isFinite(stats?.nextResetAt)) {
        return Math.max(0, stats.nextResetAt - now);
      }
      if (Number.isFinite(stats?.nextResetInMs)) {
        return Math.max(0, stats.nextResetInMs);
      }
      return SCHEDULER_BACKPRESSURE_RATE_LIMIT_MS;
    };

    const hasRateLimitRecoverySignal = stats => {
      if ((stats?.count ?? 0) >= RATE_LIMIT_DOWN_THRESHOLD) return false;
      if (stats?.shouldThrottle === true) return false;
      const headroomPercent = Number.isFinite(stats?.headroomPercent) ? stats.headroomPercent : null;
      if (headroomPercent !== null) {
        return headroomPercent >= RATE_LIMIT_HEADROOM_RECOVERY_PERCENT;
      }
      return (stats?.pressureScore ?? 0) < RATE_LIMIT_PRESSURE_ELEVATED_SCORE;
    };

    const emitBackpressureChanged = (now, active, reason, until, maxParallelism) => {
      if (!SCHEDULER_BACKPRESSURE_ENABLED) return;
      const changed =
        active !== backpressureActive
        || reason !== backpressureReason
        || maxParallelism !== backpressureMaxParallelism
        || until !== backpressureUntil;
      if (!changed) return;
      backpressureActive = active;
      backpressureReason = reason;
      backpressureUntil = until;
      backpressureMaxParallelism = maxParallelism;
      lastBackpressureEventAt = now;
      emitEvent?.({
        type: 'scheduler.backpressure.changed',
        active,
        reason,
        until,
        maxParallelism,
      });
    };

    const activateBackpressure = (reason, now, durationMs, maxParallelism, options = {}) => {
      if (!SCHEDULER_BACKPRESSURE_ENABLED) return;
      const until = durationMs > 0 ? now + durationMs : now;
      const minParallelismFloor = Number.isFinite(options?.minParallelismFloor)
        ? Math.max(1, Math.trunc(options.minParallelismFloor))
        : effectiveMinParallelism;
      const nextMax = Math.max(minParallelismFloor, Math.min(maxParallelism, dynamicMaxParallelism));
      const shouldEmit =
        !backpressureActive
        || reason !== backpressureReason
        || nextMax !== backpressureMaxParallelism
        || until > backpressureUntil + 1000;
      if (shouldEmit || now - lastBackpressureEventAt >= SCHEDULER_BACKPRESSURE_COOLDOWN_MS) {
        emitBackpressureChanged(now, true, reason, until, nextMax);
      } else {
        backpressureActive = true;
        backpressureReason = reason;
        backpressureUntil = Math.max(backpressureUntil, until);
        backpressureMaxParallelism = nextMax;
      }
    };

    const refreshBackpressure = now => {
      if (!backpressureActive) return;
      if (now < backpressureUntil) return;
      emitBackpressureChanged(now, false, null, 0, dynamicMaxParallelism);
    };

    const maybeAdjustParallelismForRateLimit = () => {
      if (!RATE_LIMIT_ADAPTIVE) return null;
      const now = Date.now();
      const stats = this.#getRateLimitWindowStats(now);
      const hitCount = stats.count ?? 0;
      const lastHitAt = stats.lastAt ?? 0;
      const snapshot = stats.snapshot ?? null;
      const failure = stats.failure ?? null;
      const snapshotObservedAt = snapshot?.observedAt ?? 0;
      const failureObservedAt = failure?.observedAt ?? 0;
      const pressureScore = Math.max(
        snapshot?.ratePressureScore ?? 0,
        failure?.ratePressureScore ?? 0,
        hitCount >= RATE_LIMIT_DOWN_THRESHOLD ? 1 : 0,
      );
      const headroomPercent =
        Number.isFinite(snapshot?.rateHeadroomPercent)
          ? snapshot.rateHeadroomPercent
          : Number.isFinite(failure?.rateHeadroomPercent)
            ? failure.rateHeadroomPercent
            : null;
      const shouldThrottle =
        snapshot?.shouldThrottle === true
        || failure?.shouldThrottle === true
        || hitCount >= RATE_LIMIT_DOWN_THRESHOLD;
      const exhausted =
        snapshot?.exhausted === true
        || failure?.exhausted === true
        || hitCount >= RATE_LIMIT_DOWN_THRESHOLD + 1;
      const nextResetCandidates = [snapshot?.nextResetAt, failure?.nextResetAt]
        .filter(value => Number.isFinite(value));
      const nextResetAt = nextResetCandidates.length > 0 ? Math.min(...nextResetCandidates) : null;
      const nextResetInMs = Number.isFinite(nextResetAt) ? Math.max(0, nextResetAt - now) : null;
      const latestObservedAt = Math.max(snapshotObservedAt, failureObservedAt, lastHitAt);
      const source =
        failureObservedAt > snapshotObservedAt
          ? (failure?.source ?? 'failure')
          : snapshotObservedAt > 0
            ? (snapshot?.source ?? 'snapshot')
            : hitCount > 0
              ? 'failure'
              : null;
      lastRateLimitStats = {
        count: hitCount,
        lastAt: lastHitAt,
        source,
        pressureScore,
        pressureLevel:
          failure?.ratePressureLevel
          ?? snapshot?.ratePressureLevel
          ?? (hitCount >= RATE_LIMIT_DOWN_THRESHOLD ? 'critical' : 'none'),
        headroomPercent,
        shouldThrottle,
        exhausted,
        nextResetAt,
        nextResetInMs,
        snapshot,
        failure,
      };
      let updatedReason = null;
      const ratePressureFloor = computeRateLimitAdaptiveFloor(lastRateLimitStats);
      const rateLimitTargetCap = computeRateLimitTargetCap(lastRateLimitStats, ratePressureFloor);

      if (rateLimitTargetCap !== null && rateLimitTargetCap < effectiveMaxParallelism) {
        lastRateLimitPressureAt = Math.max(lastRateLimitPressureAt, latestObservedAt || now);
      }

      if (
        SCHEDULER_BACKPRESSURE_ENABLED
        && SCHEDULER_BACKPRESSURE_RATE_LIMIT_MS > 0
        && rateLimitTargetCap !== null
        && rateLimitTargetCap < effectiveMaxParallelism
      ) {
        activateBackpressure(
          'rate-limit-pressure',
          now,
          computeRateLimitBackpressureDurationMs(lastRateLimitStats, now),
          rateLimitTargetCap,
          { minParallelismFloor: ratePressureFloor },
        );
      }

      const dynamicRateLimitTarget = rateLimitTargetCap === null
        ? dynamicMaxParallelism
        : Math.max(effectiveMinParallelism, rateLimitTargetCap);
      const hasNewPressure = latestObservedAt > lastRateLimitDownAt;
      if (
        rateLimitTargetCap !== null
        && dynamicRateLimitTarget < dynamicMaxParallelism
        && hasNewPressure
        && now - lastRateLimitDownAt >= RATE_LIMIT_DOWN_COOLDOWN_MS
      ) {
        if (dynamicRateLimitTarget !== dynamicMaxParallelism) {
          dynamicMaxParallelism = dynamicRateLimitTarget;
          updatedReason = 'rate-limit-down';
        }
        lastRateLimitDownAt = latestObservedAt || now;
      }

      const idleForMs = lastRateLimitPressureAt
        ? now - lastRateLimitPressureAt
        : Number.POSITIVE_INFINITY;
      if (
        !updatedReason
        && dynamicMaxParallelism < effectiveMaxParallelism
        && hasRateLimitRecoverySignal(lastRateLimitStats)
        && idleForMs >= RATE_LIMIT_UP_IDLE_MS
        && now - lastRateLimitUpAt >= RATE_LIMIT_UP_COOLDOWN_MS
      ) {
        dynamicMaxParallelism = Math.min(
          effectiveMaxParallelism,
          dynamicMaxParallelism + PARALLELISM_RAMP_STEP,
        );
        lastRateLimitUpAt = now;
        updatedReason = 'rate-limit-up';
      }

      if (currentParallelism > dynamicMaxParallelism) {
        currentParallelism = dynamicMaxParallelism;
      }

      return updatedReason;
    };

    const recomputeParallelism = (reason = null) => {
      const rateLimitReason = maybeAdjustParallelismForRateLimit();
      const effectiveReason = rateLimitReason ?? reason;
      const now = Date.now();
      refreshBackpressure(now);
      const backpressureCap = backpressureActive
        ? Math.min(backpressureMaxParallelism, dynamicMaxParallelism)
        : dynamicMaxParallelism;

      if (!autoscaleParallelism) {
        currentParallelism = backpressureCap;
      } else {
        const runnable = running.size + ready.length;
        const desired = Math.max(
          effectiveMinParallelism,
          Math.min(dynamicMaxParallelism, runnable),
        );
        currentParallelism = Math.min(desired, backpressureCap);
      }

      if (currentParallelism > backpressureCap) {
        currentParallelism = backpressureCap;
      }

      if (
        currentParallelism !== lastEmittedParallelism
        || lastEmittedMaxParallelism !== dynamicMaxParallelism
      ) {
        lastEmittedParallelism = currentParallelism;
        lastEmittedMaxParallelism = dynamicMaxParallelism;
        const runnable = running.size + ready.length;
        emitEvent?.({
          type: 'scheduler.parallelism.changed',
          parallelism: dynamicMaxParallelism,
          maxParallelism: dynamicMaxParallelism,
          minParallelism: effectiveMinParallelism,
          autoscale: autoscaleParallelism,
          currentParallelism,
          runnable,
          reason: effectiveReason,
          rateLimitHits: lastRateLimitStats.count ?? 0,
          rateLimitLastAt: lastRateLimitStats.lastAt ?? 0,
          rateLimitSource: lastRateLimitStats.source ?? null,
          ratePressureScore: lastRateLimitStats.pressureScore ?? 0,
          ratePressureLevel: lastRateLimitStats.pressureLevel ?? 'none',
          rateHeadroomPercent: lastRateLimitStats.headroomPercent ?? null,
          rateLimitShouldThrottle: lastRateLimitStats.shouldThrottle ?? false,
          rateLimitExhausted: lastRateLimitStats.exhausted ?? false,
          rateLimitNextResetAt: lastRateLimitStats.nextResetAt ?? null,
          rateLimitNextResetInMs: lastRateLimitStats.nextResetInMs ?? null,
          backpressureActive,
          backpressureReason,
          backpressureUntil,
          backpressureMaxParallelism: backpressureCap,
        });
      }

      return currentParallelism;
    };

    const launchIfPossible = () => {
      recomputeParallelism('launch');
      const deferred = [];
      while (ready.length > 0 && running.size < currentParallelism) {
        const nextId = pickNextReady();
        if (!nextId) break;
        if (hasRunningOwnershipConflict(nextId)) {
          deferred.push(nextId);
          continue;
        }
        launchTask(nextId);
      }
      for (const taskId of deferred) {
        pushReady(taskId);
      }
    };

    const coordinatorRuntimeControl = {
      retryTask: ({ taskId, reason, source } = {}) => {
        const resolvedTaskId =
          typeof taskId === 'string' && taskId.trim() ? taskId.trim() : null;
        if (!resolvedTaskId) {
          return { ok: false, error: 'missing_task_id' };
        }
        const state = taskStates.get(resolvedTaskId);
        if (!state) {
          return { ok: false, error: 'unknown_task', taskId: resolvedTaskId };
        }
        if (state.status !== 'failed') {
          return { ok: false, error: 'task_not_failed', taskId: resolvedTaskId, status: state.status };
        }

        const resolvedReason =
          typeof reason === 'string' && reason.trim() ? reason.trim() : 'coordinator requested retry';
        const resolvedSource =
          typeof source === 'string' && source.trim() ? source.trim() : 'coordinator';
        const ok = queueTaskRetry(resolvedTaskId, state, resolvedReason, { source: resolvedSource });
        if (!ok) {
          return {
            ok: false,
            error: 'retry_unavailable',
            taskId: resolvedTaskId,
            status: state.status,
            reason: resolvedReason,
          };
        }

        this.#wakeRuntimeInjectionScheduler('coordinator-retry');
        launchIfPossible();
        emitSchedulerSnapshot('coordinator-retry', { force: true });
        return {
          ok: true,
          taskId: resolvedTaskId,
          status: state.status,
          reason: resolvedReason,
        };
      },
      respawnTask: ({ taskId, reason, source } = {}) => {
        const resolvedTaskId =
          typeof taskId === 'string' && taskId.trim() ? taskId.trim() : null;
        if (!resolvedTaskId) {
          return { ok: false, error: 'missing_task_id' };
        }
        const state = taskStates.get(resolvedTaskId);
        if (!state) {
          return { ok: false, error: 'unknown_task', taskId: resolvedTaskId };
        }
        if (state.status !== 'running') {
          return { ok: false, error: 'task_not_running', taskId: resolvedTaskId, status: state.status };
        }

        const resolvedReason =
          typeof reason === 'string' && reason.trim() ? reason.trim() : 'coordinator requested respawn';
        const resolvedSource =
          typeof source === 'string' && source.trim() ? source.trim() : 'coordinator';
        const ok = respawnRunningTask(resolvedTaskId, state, resolvedReason, { source: resolvedSource });
        if (!ok) {
          return {
            ok: false,
            error: 'respawn_unavailable',
            taskId: resolvedTaskId,
            status: state.status,
            reason: resolvedReason,
          };
        }

        this.#wakeRuntimeInjectionScheduler('coordinator-respawn');
        emitSchedulerSnapshot('coordinator-respawn', { force: true });
        return {
          ok: true,
          taskId: resolvedTaskId,
          status: state.status,
          reason: resolvedReason,
        };
      },
    };
    this.activeRuntimeCoordinatorControl = coordinatorRuntimeControl;

    const processRuntimeInjectionQueue = async () => {
      if (!Array.isArray(this.runtimeInjectionQueue) || this.runtimeInjectionQueue.length === 0) {
        return [];
      }

      const outcomes = [];
      let appliedCount = 0;
      while (this.runtimeInjectionQueue.length > 0) {
        const request = this.runtimeInjectionQueue.shift();
        if (!request) continue;
        const requestedTaskIds = summarizeCoordinatorTaskIds(request.tasks, 24);
        let outcome = null;

        try {
          const { injected, sanitized } = await registerRuntimeInjectionTasks({
            plannedTasks: request.tasks,
            taskEventFields: {
              runtimeInjectionId: request.id,
              runtimeInjectionKind: request.kind ?? null,
              runtimeInjectionSource: request.source ?? null,
            },
            injectionPolicy: request.policy ?? null,
          });
          const sanitizedMeta =
            sanitized && typeof sanitized === 'object'
              ? {
                policyKind: coerceString(sanitized.policy?.kind) ?? null,
                removedDependencyCount:
                  Math.max(0, Number.parseInt(sanitized.removedDependencyCount, 10) || 0),
                affectedTaskIds: Array.isArray(sanitized.affectedTaskIds)
                  ? sanitized.affectedTaskIds
                  : [],
                removedByTask: Array.isArray(sanitized.removedByTask)
                  ? sanitized.removedByTask
                  : [],
              }
              : null;
          if ((sanitizedMeta?.removedDependencyCount ?? 0) > 0) {
            emitEvent?.({
              type: 'runtime.injection.sanitized',
              injectionId: request.id,
              kind: request.kind ?? null,
              source: request.source ?? null,
              policyKind: sanitizedMeta.policyKind,
              removedDependencyCount: sanitizedMeta.removedDependencyCount,
              affectedTaskIds: sanitizedMeta.affectedTaskIds,
            });
            this.sendLog(
              `[runtime] sanitized ${sanitizedMeta.removedDependencyCount} dependency reference(s) for ${request.kind ?? 'runtime'} injection ${request.id}${sanitizedMeta.policyKind ? ` (${sanitizedMeta.policyKind})` : ''}.`,
            );
          }

          if (injected.length > 0) {
            outcome = {
              ok: true,
              injectionId: request.id,
              kind: request.kind ?? null,
              source: request.source ?? null,
              status: 'applied',
              requestedTaskIds,
              taskIds: injected,
              taskCount: injected.length,
              sanitized: sanitizedMeta,
              error: null,
            };
            emitEvent?.({
              type: request.kind === 'steer' ? 'steer.injected' : 'runtime.injection.injected',
              injectionId: request.id,
              kind: request.kind ?? null,
              source: request.source ?? null,
              taskCount: injected.length,
              tasks: injected,
            });
            appliedCount += injected.length;
            this.sendLog(
              `[runtime] injected ${injected.length} ${request.kind ?? 'runtime'} task(s) from ${request.source ?? 'supervisor'}`,
            );
            sendSchedulerProgress(
              `Injected ${injected.length} ${request.kind ?? 'runtime'} task(s)`,
            );
          } else {
            outcome = {
              ok: true,
              injectionId: request.id,
              kind: request.kind ?? null,
              source: request.source ?? null,
              status: 'empty',
              requestedTaskIds,
              taskIds: [],
              taskCount: 0,
              sanitized: sanitizedMeta,
              error: null,
            };
            emitEvent?.({
              type: 'runtime.injection.empty',
              injectionId: request.id,
              kind: request.kind ?? null,
              source: request.source ?? null,
            });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err ?? 'unknown error');
          outcome = {
            ok: false,
            injectionId: request.id,
            kind: request.kind ?? null,
            source: request.source ?? null,
            status: 'failed',
            requestedTaskIds,
            taskIds: [],
            taskCount: 0,
            sanitized: null,
            error: message,
          };
          emitEvent?.({
            type: request.kind === 'steer' ? 'steer.failed' : 'runtime.injection.failed',
            injectionId: request.id,
            kind: request.kind ?? null,
            source: request.source ?? null,
            error: message,
          });
          this.sendLog(
            `[runtime] failed to inject ${request.kind ?? 'runtime'} tasks from ${request.source ?? 'supervisor'}: ${message}`,
          );
        } finally {
          if (outcome) {
            outcomes.push(outcome);
            this.#settleRuntimeInjectionOutcome(outcome);
          }
        }
      }

      if (appliedCount > 0) {
        launchIfPossible();
        emitSchedulerSnapshot('runtime-injection', { force: true });
      }

      return outcomes;
    };

    const removeDependentEdge = (depId, taskId) => {
      const list = dependents.get(depId);
      if (!list) return;
      const next = list.filter(entry => entry !== taskId);
      if (next.length === 0) {
        dependents.delete(depId);
      } else if (next.length !== list.length) {
        dependents.set(depId, next);
      }
    };

    const relaxStalledDependencies = pendingStates => {
      if (checklistModeActive) {
        return { changed: false, newlyReady: [] };
      }
      const pendingIds = new Set(pendingStates.map(state => state.task.id));
      const snapshot = pendingStates.map(state => ({
        id: state.task.id,
        dependsOn: [...(remainingDeps.get(state.task.id) ?? [])].filter(dep => pendingIds.has(dep)),
      }));

      const relaxed = relaxDependenciesForParallelism(snapshot, resolvedMinParallelism);
      if (relaxed.changes.length === 0) {
        return { changed: false, newlyReady: [] };
      }

      for (const change of relaxed.changes) {
        const state = taskStates.get(change.taskId);
        if (!state) continue;
        const task = state.task;
        const removed = Array.isArray(change.removedDependsOn) ? change.removedDependsOn : [];
        if (removed.length === 0) continue;
        if (Array.isArray(task.dependsOn)) {
          task.dependsOn = task.dependsOn.filter(dep => !removed.includes(dep));
        } else {
          task.dependsOn = [];
        }
        const depSet = remainingDeps.get(change.taskId);
        if (depSet) {
          for (const dep of removed) {
            depSet.delete(dep);
            removeDependentEdge(dep, change.taskId);
          }
        }
      }

      const newlyReady = [];
      for (const state of pendingStates) {
        if (state.status !== 'pending') continue;
        const depSet = remainingDeps.get(state.task.id);
        if (!depSet || depSet.size === 0) {
          pushReady(state.task.id);
          newlyReady.push(state.task.id);
        }
      }

      this.sendLog(
        `Scheduler stall: relaxed ${relaxed.changes.length} dependency edge(s) to restore runnable tasks.`,
      );
      emitEvent?.({
        type: 'scheduler.dependencies.relaxed',
        target: relaxed.target,
        rootCount: relaxed.rootCount,
        changes: relaxed.changes,
        mode: 'stall',
      });
      if (newlyReady.length > 0) {
        sendSchedulerProgress(`Unblocked ${newlyReady.length} task(s) after dependency relax`);
      }

      return { changed: true, newlyReady };
    };

    const attemptStallReplan = async pendingStates => {
      if (checklistModeActive) return false;
      if (!STALL_REPLAN_ENABLED) return false;
      if (stallReplanWaves >= STALL_REPLAN_MAX_WAVES) return false;
      if (!repoRoot || !tasksRoot || !runId) return false;

      const remainingCapacity = remainingTaskCapacity(MAX_TOTAL_TASKS, taskStates.size);
      const desiredCount = Math.min(remainingCapacity, Math.max(1, resolvedMinParallelism));
      if (desiredCount <= 0) return false;

      stallReplanWaves += 1;
      const wave = stallReplanWaves;

      emitEvent?.({
        type: 'stall.replan.started',
        wave,
        pending: pendingStates.length,
        desiredCount,
        currentTaskCount: taskStates.size,
        effort: STALL_RECOVERY_EFFORT,
      });

      const completedTasks = [...taskStates.values()]
        .filter(entry => entry.status === 'completed')
        .map(entry => ({
          id: entry.task.id,
          description: entry.task.description,
        }));
      const pendingTasks = pendingStates.map(state => ({
        id: state.task.id,
        description: state.task.description,
        dependsOn: [...(remainingDeps.get(state.task.id) ?? [])],
      }));

      const planWithEffort = async effort => {
        const stallEvent = buildStallPlanCoordinatorEvent({
          wave,
          pendingTasks,
          plannedTasks: [],
          desiredCount,
          effort,
        });
        const pendingSection = pendingTasks
          .slice(0, 25)
          .map(task => {
            const deps = Array.isArray(task.dependsOn) && task.dependsOn.length > 0
              ? ` (dependsOn: ${task.dependsOn.join(', ')})`
              : '';
            return `- ${task.id}: ${clipText(task.description ?? '', 160)}${deps}`;
          })
          .join('\n') || '- none';
        const completedSection = completedTasks
          .map(task => `- ${task.id}: ${task.description}`)
          .join('\n') || '- none';
        const repoIndexText =
          typeof this.repoIndex === 'string' && this.repoIndexEnabled && this.repoIndex.trim()
            ? this.repoIndex.trim()
            : '';
        const stallContextText = [
          'Stall recovery planning request:',
          `- desiredCount: ${desiredCount}`,
          `- effort: ${effort ?? '-'}`,
          '- If new runnable work should be created, express it through actions.injectTasks.',
          '- Return 0 tasks when the right action is to wait for active progress rather than inject more work.',
          '- Do not depend on pending task ids; depend only on completed task ids when needed.',
          '- Prefer immediately runnable tasks with empty dependsOn.',
          'Pending tasks to avoid duplicating:',
          pendingSection,
          'Completed tasks you MAY depend on:',
          completedSection,
          repoIndexText ? `Repository index:\n${repoIndexText}` : 'Repository index:\n- none',
        ].join('\n\n');
        const stallPlanSpec = this.#agentModelEffort({ phase: 'stall-plan', effortOverride: effort });
        const coordinatedPlan = await this.#coordinateEvent({
          eventType: 'stall-plan',
          summary: stallEvent.summary,
          eventDetails: stallEvent.details,
          eventContextText: stallContextText,
          artifactHint: null,
          emitEvent,
          phase: 'stall-plan',
          wave,
          source: 'stall-plan',
          modelOverride: stallPlanSpec.model,
          effortOverride: stallPlanSpec.effort,
        });
        if (coordinatedPlan?.coordinatorBacked) {
          const injectionId = coerceString(coordinatedPlan.actionOutcome?.inject?.injectionId);
          const injectionOutcome = injectionId
            ? await this.#resolveQueuedRuntimeInjection({
              injectionId,
              drainQueue: processRuntimeInjectionQueue,
            })
            : null;
          if (injectionOutcome) {
            await this.#reportCoordinatorInjectionOutcome({
              eventType: 'stall-plan-result',
              phase: 'stall-plan',
              wave,
              label: `Stall plan wave ${wave}`,
              outcome: injectionOutcome,
              emitEvent,
            });
          }
          return {
            coordinatorBacked: true,
            injectionOutcome,
            rawPlanText: coordinatedPlan.eventSummary ?? null,
            effort,
          };
        }

        const stallPlan = await this.#planStalledTasks({
          goal,
          pendingTasks,
          completedTasks,
          desiredCount,
          repoIndex: repoIndexText,
          emitEvent,
          wave,
          cwd: repoRoot,
          effortOverride: effort,
        });
        await this.#coordinateEvent({
          eventType: 'stall-plan',
          summary: stallEvent.summary,
          eventDetails: stallEvent.details,
          artifactHint: stallPlan?.coordination ?? null,
          emitEvent,
          phase: 'stall-plan',
          wave,
          source: 'stall-plan',
        });

        const planned = Array.isArray(stallPlan?.tasks) ? stallPlan.tasks : [];
        const existingIds = new Set(taskMap.keys());
        const normalised = normaliseTasks(planned, {
          existingIds,
          prefix: `stall-w${wave}-`,
          limit: desiredCount,
          pathLayout: this.taskPathLayout,
        });

        return { coordinatorBacked: false, stallPlan, planned, normalised, effort };
      };

      let planResult = await planWithEffort(STALL_RECOVERY_EFFORT);

      if (
        (
          planResult.coordinatorBacked
            ? planResult.injectionOutcome?.status !== 'applied'
            : planResult.normalised.length === 0
        )
        && STALL_RECOVERY_RETRY_EFFORT
        && STALL_RECOVERY_RETRY_EFFORT !== STALL_RECOVERY_EFFORT
      ) {
        this.sendLog(
          `[stall-replan] empty plan at effort=${STALL_RECOVERY_EFFORT}; retrying with ${STALL_RECOVERY_RETRY_EFFORT}.`,
        );
        emitEvent?.({
          type: 'stall.replan.retry',
          wave,
          effort: STALL_RECOVERY_RETRY_EFFORT,
        });
        planResult = await planWithEffort(STALL_RECOVERY_RETRY_EFFORT);
      }

      if (planResult.coordinatorBacked) {
        const appliedTaskIds = Array.isArray(planResult.injectionOutcome?.taskIds)
          ? planResult.injectionOutcome.taskIds
          : [];
        if (planResult.injectionOutcome?.status !== 'applied' || appliedTaskIds.length === 0) {
          if (
            planResult.injectionOutcome?.status === 'failed'
            || planResult.injectionOutcome?.status === 'timeout'
            || planResult.injectionOutcome?.status === 'cancelled'
          ) {
            emitEvent?.({
              type: 'stall.replan.failed',
              wave,
              error:
                planResult.injectionOutcome?.error
                ?? `runtime injection ${planResult.injectionOutcome?.status ?? 'failed'}`,
              effort: planResult.effort ?? null,
              coordinatorBacked: true,
              rawPlanText: planResult.rawPlanText ?? null,
            });
          } else {
            emitEvent?.({
              type: 'stall.replan.empty',
              wave,
              effort: planResult.effort ?? null,
              coordinatorBacked: true,
              rawPlanText: planResult.rawPlanText ?? null,
            });
          }
          return false;
        }

        emitEvent?.({
          type: 'stall.replan.injected',
          wave,
          tasks: appliedTaskIds,
          taskCount: appliedTaskIds.length,
          rawPlanText: planResult.rawPlanText ?? null,
          effort: planResult.effort ?? null,
          coordinatorBacked: true,
        });
        sendSchedulerProgress(`Injected ${appliedTaskIds.length} stall task(s)`);
        return true;
      }

      if (planResult.normalised.length === 0) {
        emitEvent?.({
          type: 'stall.replan.empty',
          wave,
          effort: planResult.effort ?? null,
        });
        return false;
      }

      const normalised = planResult.normalised;

      const completedIds = completedTasks.map(task => task.id);
      const completedSet = new Set(completedIds);
      for (const newTask of normalised) {
        const deps = (newTask.dependsOn ?? [])
          .filter(dep => completedSet.has(dep));
        newTask.dependsOn = [...new Set(deps)];
      }

      try {
        const { injected } = await registerRuntimeInjectionTasks({
          plannedTasks: normalised,
          taskEventFields: { stallWave: wave },
        });

        emitEvent?.({
          type: 'stall.replan.injected',
          wave,
          tasks: injected,
          taskCount: injected.length,
          rawPlanText: planResult.stallPlan?.rawPlanText ?? null,
          effort: planResult.effort ?? null,
        });

        if (injected.length > 0) {
          sendSchedulerProgress(`Injected ${injected.length} stall task(s)`);
          return true;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err ?? 'unknown error');
        emitEvent?.({
          type: 'stall.replan.failed',
          wave,
          error: message,
        });
        return false;
      }
      return false;
    };

    const recoverFromStall = async () => {
      if (checklistModeActive) return false;
      const pendingStates = [...taskStates.values()]
        .filter(state => state.status === 'pending');
      if (pendingStates.length === 0) return false;

      const relaxed = relaxStalledDependencies(pendingStates);
      if (relaxed.newlyReady.length > 0) return true;

      return await attemptStallReplan(pendingStates);
    };

    const maybeInterveneLowAgents = async () => {
      if (!watchdogInterventionEnabled) return;
      const now = Date.now();
      if (now - lastWatchdogInterventionAt < WATCHDOG_INTERVENTION_COOLDOWN_MS) return;
      const belowMin = running.size < watchdogMinAgents;
      if (!belowMin) return;

      const signals = buildWatchdogSignals(now);
      if (!signals.actionablePending || !signals.noReadyWork) return;
      if (!signals.meaningfulShortfall) return;

      lastWatchdogInterventionAt = now;
      const outcome = summarizeWatchdogOutcome(
        await maybeTriggerWatchdog({ force: true, reason: 'low-agents' }),
      );
      const recovered = outcome.recovered;
      const actions = outcome.actionLabels;
      emitEvent?.({
        type: 'watchdog.intervention',
        action: recovered ? 'coordinator-recover' : 'coordinator-noop',
        running: running.size,
        ready: ready.length,
        pending: signals.pendingStates.length,
        reason: 'low-agents',
        actions,
      });
      const actionLabel = actions.length > 0 ? ` actions=${actions.join(',')}` : '';
      if (recovered) {
        this.sendLog(
          `[watchdog] coordinator intervention (low-agents): recovered stalled plan (pending=${signals.pendingStates.length}).${actionLabel}`,
        );
      } else {
        this.sendLog(
          `[watchdog] coordinator intervention (low-agents): no recovery action available (pending=${signals.pendingStates.length}).${actionLabel}${outcome.reportText ? ` report=${outcome.reportText}` : ''}`,
        );
      }
    };

    const maybeInterveneNoProgress = async () => {
      if (NO_PROGRESS_TIMEOUT_MS <= 0) return;
      const now = Date.now();
      if (now - lastProgressAt < NO_PROGRESS_TIMEOUT_MS) return;
      if (now - lastNoProgressInterventionAt < WATCHDOG_INTERVENTION_COOLDOWN_MS) return;

      const pendingStates = [...taskStates.values()]
        .filter(state => state.status === 'pending');
      if (pendingStates.length === 0 || ready.length > 0) return;

      lastNoProgressInterventionAt = now;
      emitEvent?.({
        type: 'watchdog.no_progress',
        elapsedMs: now - lastProgressAt,
        running: running.size,
        pending: pendingStates.length,
        ready: ready.length,
      });

      const outcome = summarizeWatchdogOutcome(
        await maybeTriggerWatchdog({ force: true, reason: 'no-progress' }),
      );
      const recovered = outcome.recovered;
      const actions = outcome.actionLabels;
      emitEvent?.({
        type: 'watchdog.intervention',
        action: recovered ? 'coordinator-no-progress-recover' : 'coordinator-no-progress-noop',
        running: running.size,
        ready: ready.length,
        pending: pendingStates.length,
        reason: 'no-progress',
        actions,
      });
      if (recovered) {
        lastProgressAt = Date.now();
        this.sendLog(
          `[watchdog] coordinator no-progress recovery triggered (pending=${pendingStates.length}).${actions.length > 0 ? ` actions=${actions.join(',')}` : ''}`,
        );
        sendSchedulerProgress('Coordinator watchdog intervention after no-progress timeout');
      } else {
        this.sendLog(
          `[watchdog] coordinator no-progress recovery found no action (pending=${pendingStates.length}).${actions.length > 0 ? ` actions=${actions.join(',')}` : ''}${outcome.reportText ? ` report=${outcome.reportText}` : ''}`,
        );
      }
    };

    const maybeIntervenePeriodic = async () => {
      if (!watchdogInterventionEnabled) return;
      const now = Date.now();
      const intervalDue = lastPeriodicInterventionAt === 0
        || now - lastPeriodicInterventionAt >= watchdogInterventionIntervalMs;
      const turnCounter = Number.isFinite(this.turnCounter) ? this.turnCounter : 0;
      const turnDelta = turnCounter - lastPeriodicInterventionTurn;
      const turnDue = turnDelta > 0;
      if (!intervalDue && !turnDue) return;

      const lastInterventionAt = Math.max(lastWatchdogInterventionAt, lastNoProgressInterventionAt);
      if (now - lastInterventionAt < WATCHDOG_INTERVENTION_COOLDOWN_MS) return;

      const pendingStates = [...taskStates.values()]
        .filter(state => state.status === 'pending');

      lastPeriodicInterventionAt = now;
      lastPeriodicInterventionTurn = turnCounter;

      if (pendingStates.length === 0) return;

      lastWatchdogInterventionAt = now;
      const reasonParts = [];
      if (intervalDue) reasonParts.push('interval');
      if (turnDue) reasonParts.push(`turn+${turnDelta}`);
      const reasonLabel = reasonParts.join(', ') || 'periodic';

      const outcome = summarizeWatchdogOutcome(
        await maybeTriggerWatchdog({ force: true, reason: reasonLabel }),
      );
      const recovered = outcome.recovered;
      const actions = outcome.actionLabels;
      emitEvent?.({
        type: 'watchdog.intervention',
        action: recovered ? 'coordinator-periodic-recover' : 'coordinator-periodic-noop',
        running: running.size,
        ready: ready.length,
        pending: pendingStates.length,
        reason: reasonLabel,
        actions,
      });
      const actionLabel = actions.length > 0 ? ` actions=${actions.join(',')}` : '';
      if (recovered) {
        this.sendLog(
          `[watchdog] coordinator periodic intervention (${reasonLabel}): recovered stalled tasks (pending=${pendingStates.length}).${actionLabel}`,
        );
      } else {
        this.sendLog(
          `[watchdog] coordinator periodic intervention (${reasonLabel}): no recovery action (pending=${pendingStates.length}).${actionLabel}${outcome.reportText ? ` report=${outcome.reportText}` : ''}`,
        );
      }
    };

    try {
      launchIfPossible();
      emitSchedulerSnapshot('init', { force: true });
      await processRuntimeInjectionQueue();
      launchIfPossible();

      while (resolved.size < total) {
        await processRuntimeInjectionQueue();

        if (!checklistModeActive && DYNAMIC_REPLAN_ENABLED) {
          const nextState = await this.#maybeInjectDynamicTasks({
            goal,
            tasks,
            taskStates,
            taskMap,
            remainingDeps,
            dependents,
            ready,
            pushReady,
            running,
            runningTasks,
            emitEvent,
            repoRoot,
            tasksRoot,
            runId,
            integrationBranch,
            parallelism: dynamicMaxParallelism,
            state: {
              dynamicWaves,
              lastDynamicAt,
              total,
              soloTaskId,
              soloSince,
            },
            drainRuntimeInjections: processRuntimeInjectionQueue,
          });
          if (nextState) {
            dynamicWaves = Number.isFinite(nextState.dynamicWaves)
              ? nextState.dynamicWaves
              : dynamicWaves;
            lastDynamicAt = Number.isFinite(nextState.lastDynamicAt)
              ? nextState.lastDynamicAt
              : lastDynamicAt;
            total = Number.isFinite(nextState.total) ? nextState.total : total;
            if (Object.hasOwn(nextState, 'soloTaskId')) {
              soloTaskId = nextState.soloTaskId;
            }
            if (Object.hasOwn(nextState, 'soloSince')) {
              soloSince = nextState.soloSince;
            }
          }
        }

        launchIfPossible();
        triggerWatchdogMergeAskRecovery();
        maybeTriggerWatchdog();
        await checkTaskHealth();
        refreshProgressFromActivity();
        await maybeInterveneLowAgents();
        await maybeInterveneNoProgress();
        await maybeIntervenePeriodic();
        triggerWatchdogMergeAskRecovery();
        await processRuntimeInjectionQueue();

        if (running.size === 0) {
          if (ready.length === 0) {
            triggerWatchdogMergeAskRecovery();
            const watchdogOutcome = summarizeWatchdogOutcome(
              await maybeTriggerWatchdog({ force: true, reason: 'scheduler-stall' }),
            );
            if (!watchdogOutcome.recovered) {
              const fallbackOutcome = await runActiveIntervention('scheduler-stall');
              if (!fallbackOutcome.recovered) break;
            }
          }
          launchIfPossible();
          continue;
        }
        const wakeVersion = this.runtimeInjectionSignalVersion;
        await Promise.race([
          ...running,
          sleep(DYNAMIC_REPLAN_CHECK_INTERVAL_MS),
          this.#runtimeInjectionWakePromise(wakeVersion),
        ]);
        triggerWatchdogMergeAskRecovery();
        await processRuntimeInjectionQueue();
        const now = Date.now();
        if (now - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
          lastHeartbeatAt = now;
          sendSchedulerProgress('Tasks in progress');
        }
        refreshProgressFromActivity();
        await checkTaskHealth();
        launchIfPossible();
        emitSchedulerSnapshot('tick');
      }

      const stalledPending = [...taskStates.values()].filter(state => state.status === 'pending');
      if (stalledPending.length > 0) {
        this.sendLog(
          `Scheduler stalled; marking ${stalledPending.length} pending task(s) as blocked.`,
        );
        for (const pendingState of stalledPending) {
          markBlocked(
            pendingState.task.id,
            'Scheduler stalled: no runnable tasks after recovery attempts.',
            'scheduler',
          );
        }
      }

      await Promise.allSettled(running);

      const results = [];
      for (const [taskId, state] of taskStates.entries()) {
        results.push({
          id: taskId,
          description: state.task.description,
          dependsOn: state.task.dependsOn,
          prompt: state.task.prompt,
          branch: state.branch,
          worktreePath: state.worktreePath,
          status: state.status,
          output: state.output,
          prd: state.prd,
          error: state.error,
          commit: state.commit,
          changedFiles: Array.isArray(state.changedFiles) ? [...state.changedFiles] : [],
          events: state.events,
          threadId: state.threadId,
          turnId: state.turnId,
          durationMs: state.durationMs(),
          checklist: state.task.checklist ?? null,
        });
      }

      return { results };
    } finally {
      if (this.activeRuntimeCoordinatorControl === coordinatorRuntimeControl) {
        this.activeRuntimeCoordinatorControl = null;
      }
    }
  }

  #collectRunningOwnershipPaths(taskStates, excludeTaskId) {
    const patterns = [];
    if (!(taskStates instanceof Map)) return patterns;
    for (const [taskId, otherState] of taskStates.entries()) {
      if (!otherState || taskId === excludeTaskId) continue;
      if (otherState.status !== 'running') continue;
      patterns.push(...resolveTaskOwnedPaths(otherState.task));
    }
    return normaliseOwnedPathPatterns(patterns);
  }

  async #withSharedRepoGitLock(fn) {
    const prev = this.sharedRepoGitLock ?? Promise.resolve();
    let release = null;
    this.sharedRepoGitLock = new Promise(resolve => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release?.();
    }
  }

  async #finalizeSharedTaskChanges({ task, taskStates, cwd, emitEvent }) {
    const commitAllPending = async reason => {
      const headBefore = (await git(['rev-parse', 'HEAD'], { cwd })).trim();
      const commitMessage = `cdx: ${task.id} - ${task.description}`;
      await commitAll({ cwd, message: commitMessage });
      const headAfter = (await git(['rev-parse', 'HEAD'], { cwd })).trim();
      const commit = headAfter !== headBefore ? headAfter : null;
      const committedFilesOutput = commit
        ? await git(['show', '--name-only', '--pretty=format:', 'HEAD'], { cwd }).catch(() => '')
        : '';
      const changedFiles = uniqueList(
        committedFilesOutput
          .split(/\r?\n/)
          .map(line => line.trim())
          .filter(Boolean),
      );
      emitEvent?.({
        type: 'task.commit.completed',
        taskId: task.id,
        commit,
        changedFiles,
        mode: 'shared-fallback',
        reason: reason ?? null,
      });
      return { commit, changedFiles };
    };

    const ownedPaths = resolveTaskOwnedPaths(task);
    if (ownedPaths.length === 0) {
      if (!OWNERSHIP_HARD_ENFORCE) {
        emitEvent?.({
          type: 'task.ownership.warning',
          taskId: task?.id ?? null,
          reason: 'missing_ownership_paths',
        });
        return await commitAllPending('missing_ownership_paths');
      }
      throw new Error(`Task ${task?.id ?? 'unknown'} has no ownership.paths; cannot finalize shared-workspace changes.`);
    }

    const statusOutput = await git(['status', '--porcelain'], { cwd }).catch(() => '');
    const changedFiles = parseStatusPaths(statusOutput);
    const runningOwned = this.#collectRunningOwnershipPaths(taskStates, task?.id);
    const allowedPatterns = normaliseOwnedPathPatterns([...ownedPaths, ...runningOwned]);
    const unauthorized = changedFiles.filter(file => !fileMatchesOwnedPaths(file, allowedPatterns));
    if (unauthorized.length > 0) {
      const clipped = unauthorized.slice(0, 25);
      emitEvent?.({
        type: OWNERSHIP_HARD_ENFORCE ? 'task.ownership.violation' : 'task.ownership.warning',
        taskId: task?.id ?? null,
        changedFiles: clipped,
        total: unauthorized.length,
      });
      if (!OWNERSHIP_HARD_ENFORCE) {
        return await commitAllPending('out_of_scope_changes_allowed');
      }
      throw new Error(
        `Ownership violation for ${task?.id ?? 'task'}: ${unauthorized.length} file(s) outside assigned paths changed.\n`
          + `${clipped.join('\n')}`,
      );
    }

    const ownedChanged = changedFiles.filter(file => fileMatchesOwnedPaths(file, ownedPaths));
    if (ownedChanged.length === 0) {
      emitEvent?.({
        type: 'task.ownership.no_changes',
        taskId: task?.id ?? null,
      });
      return { commit: null, changedFiles: [] };
    }

    const headBefore = (await git(['rev-parse', 'HEAD'], { cwd })).trim();
    await git(['add', '-A', '--', ...ownedPaths], { cwd });
    const stagedOutput = await git(['diff', '--cached', '--name-only'], { cwd }).catch(() => '');
    const stagedFiles = uniqueList(stagedOutput.split(/\r?\n/).map(line => line.trim()).filter(Boolean));
    const stagedUnexpected = stagedFiles.filter(file => !fileMatchesOwnedPaths(file, allowedPatterns));
    if (stagedUnexpected.length > 0) {
      const clipped = stagedUnexpected.slice(0, 25);
      emitEvent?.({
        type: 'task.ownership.stage_violation',
        taskId: task?.id ?? null,
        stagedFiles: clipped,
        total: stagedUnexpected.length,
      });
      throw new Error(
        `Ownership staging violation for ${task?.id ?? 'task'}: staged files outside ownership.\n${clipped.join('\n')}`,
      );
    }

    const commitMessage = `cdx: ${task.id} - ${task.description}`;
    let committed = false;
    try {
      await git(['commit', '--only', '-m', commitMessage, '--', ...ownedPaths], {
        cwd,
        log: (...args) => this.sendLog(args.join(' ')),
      });
      committed = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? 'commit failed');
      if (!/nothing to commit|no changes added to commit/i.test(message)) {
        throw err;
      }
    }

    const headAfter = (await git(['rev-parse', 'HEAD'], { cwd })).trim();
    const commit = committed && headAfter !== headBefore ? headAfter : null;
    emitEvent?.({
      type: 'task.commit.completed',
      taskId: task.id,
      commit,
      changedFiles: ownedChanged,
    });
    return { commit, changedFiles: ownedChanged };
  }

  async #executeTask({ goal, state, task, taskStates, emitEvent }) {
    if (USE_GIT_WORKTREES) {
      const depEntries = (task.dependsOn ?? [])
        .map(depId => ({ depId, branch: taskStates.get(depId)?.branch }))
        .filter(entry => entry.branch);
      for (const { depId, branch } of depEntries) {
        await this.#mergeDependencyBranch({
          state,
          task,
          depId,
          branch,
          emitEvent,
        });
      }
    }

    const agentId = `task:${task.id}`;
    const client = new AppServerClient({
      approvalDecision: DEFAULT_APPROVAL_DECISION,
      approvalJustification: this.execJustification,
      log: (...args) => this.sendLog(`[${agentId}] ${args.join(' ')}`),
      ...this.#buildHookClientOptions({ agentId, taskId: task.id, phase: 'task' }),
      ...this.#buildWorkerClientOptions(task.id, 'task', state.effortOverride),
    });
    const collectors = new Map();
    const detach = this.#attachClient({
      client,
      collectors,
      emitEvent,
      agentId,
      taskId: task.id,
      phase: 'task',
      contextStore: this.contextStore,
    });
    state.attachClient(client);

    const taskSpec = this.#agentModelEffort({ phase: 'task', effortOverride: state.effortOverride });
    emitEvent?.({
      type: 'agent.started',
      agentId,
      taskId: task.id,
      phase: 'task',
      worktreePath: state.worktreePath,
      branch: state.branch,
      model: taskSpec.model,
      effort: taskSpec.effort,
    });

    try {
      await client.ensureInitialized();
      emitEvent?.({
        type: 'agent.initialized',
        agentId,
        taskId: task.id,
        phase: 'task',
      });

      const threadStart = await client.request('thread/start', {
        model: taskSpec.model,
        cwd: state.worktreePath,
        approvalPolicy: DEFAULT_APPROVAL_POLICY,
        sandbox: this.#desiredSandbox('task'),
        config: this.#buildThreadConfigOverrides() ?? undefined,
      });
      const threadId = threadStart?.thread?.id ?? threadStart?.threadId;
      if (!threadId) throw new Error(`Failed to start thread for task ${task.id}`);
      state.threadId = threadId;
      state.recordActivity('thread started', { method: 'thread/start' });

      let prd = null;
      if (GENERATE_PRD) {
        const prdPrompt = renderPromptTemplate(TASK_PRD_PROMPT_TEMPLATE, {
          goal,
          taskId: task.id,
          taskDescription: task.description ?? '',
        });
        const prdTurn = await this.#runTurn({
          client,
          collectors,
          threadId,
          cwd: state.worktreePath,
          text: prdPrompt,
          onEvent: ({ method, params }) => {
            this.#logItemEvent({ agentId, method, params });
          },
          agentId,
          taskId: task.id,
          phase: 'task',
          emitEvent,
          effortOverride: state.effortOverride,
        });
        prd = prdTurn.text;
        emitEvent?.({
          type: 'task.prd.completed',
          taskId: task.id,
          agentId,
        });
      }

      const repoIndexSection =
        this.repoIndex && this.includeRepoIndexInTaskPrompt
          ? `\nRepository index:\n${this.repoIndex}\n`
          : '';
      const ownershipSection = buildTaskOwnershipSection(task);
      const extra = task.prompt ? `\nAdditional instructions:\n${task.prompt}\n` : '';
      const prdSection = prd ? `\nPRD:\n${prd}\n` : '';
      const supervisorRules = this.routerUrl
        ? `\nSupervisor rules:\n- If you need a decision (options A/B/C, tradeoffs, risky step), DO NOT ask in plain text. Call the tool router.ask.\n- In router.ask arguments, include run_id=$CDX_RUN_ID and task_id=$CDX_TASK_ID when available.\n- After receiving router.ask result, follow message_for_agent as your next actions.\n`
        : '';
      const taskPrompt = renderPromptTemplate(TASK_PROMPT_TEMPLATE, {
        goal,
        taskId: task.id,
        taskDescription: task.description ?? '',
        ownershipSection,
        contextSection: buildTaskContextSection({
          task,
          taskStates,
          coordinatorArtifact: this.coordinatorArtifact,
          sharedContextSummary: this.sharedContextSummary,
        }),
        repoIndexSection,
        extraSection: extra,
        prdSection,
        supervisorRules,
        retryHint: '',
        tailInstruction: TASK_TAIL_PROMPT,
      });

      this.threadToTask.set(threadId, task.id);

      const allEvents = [];
      const hookRetryLimit = this.hookMaxRetries ?? 0;
      let hookRetryCount = 0;
      let retryEffortOverride = null;
      const runOneTurn = async text => {
        let nextText = text;
        while (true) {
          if (state.abortReason) {
            throw new Error(`Task aborted: ${state.abortReason}`);
          }
          const withMessages = this.#withAgentMessages(task.id, nextText);
          let turn;
          try {
            turn = await this.#runTurn({
              client,
              collectors,
              threadId,
              cwd: state.worktreePath,
              text: withMessages,
              onEvent: ({ method, params }) => {
                this.#logItemEvent({ agentId, method, params });
              },
              agentId,
              taskId: task.id,
              phase: 'task',
              emitEvent,
              effortOverride: retryEffortOverride ?? state.effortOverride,
            });
          } catch (err) {
            if (isTurnTimeoutError(err)) {
              const now = Date.now();
              const reason = err instanceof Error ? err.message : String(err ?? 'turn timeout');
              const overMax = WATCHDOG_RESPAWN_MAX > 0 && state.respawnAttempts >= WATCHDOG_RESPAWN_MAX;
              const coolingDown = state.lastRespawnAt
                && now - state.lastRespawnAt < WATCHDOG_RESPAWN_COOLDOWN_MS;
              if (!overMax && !coolingDown && state.requestRespawn(reason)) {
                state.respawnAttempts += 1;
                state.lastRespawnAt = now;
                emitEvent?.({
                  type: 'task.respawn.requested',
                  taskId: task.id,
                  reason,
                  attempt: state.respawnAttempts,
                  timeoutMs: TURN_TIMEOUT_MS,
                });
                this.sendLog(`[watchdog] respawn requested for ${task.id}: ${reason}`);
              }
            }
            throw err;
          }
          allEvents.push(...(turn.events ?? []));
          if (state.abortReason) {
            throw new Error(`Task aborted: ${state.abortReason}`);
          }

          const hookOutcome = await this.#handleHookTurnCompleted({
            agentId,
            taskId: task.id,
            phase: 'task',
            threadId,
            turn,
            goal,
            task,
          });

          if (hookOutcome?.abort) {
            const reason = hookOutcome.abort.reason ?? 'hook requested abort';
            state.requestAbort(reason);
            throw new Error(`Task aborted: ${reason}`);
          }

          if (hookOutcome?.retry) {
            if (hookRetryCount < hookRetryLimit) {
              hookRetryCount += 1;
              emitEvent?.({
                type: 'hook.retry',
                taskId: task.id,
                agentId,
                phase: 'task',
                attempt: hookRetryCount,
                maxRetries: hookRetryLimit,
              });
              retryEffortOverride = RETRY_EFFORT;
              nextText = this.#buildHookRetryPrompt({ retry: hookOutcome.retry });
              continue;
            }
            this.sendLog(
              `[${agentId}] hook retry skipped (limit=${hookRetryLimit})`,
            );
            emitEvent?.({
              type: 'hook.retry.skipped',
              taskId: task.id,
              agentId,
              phase: 'task',
              attempt: hookRetryCount,
              maxRetries: hookRetryLimit,
            });
          }

          retryEffortOverride = null;
          return turn;
        }
      };

      let turn = await runOneTurn(taskPrompt);
      let followupTurnsUsed = 0;
      let requestedExplicitConfirmation = false;

      while (followupTurnsUsed < TASK_MAX_EXTRA_TURNS) {
        const shouldContinue = this.#shouldContinueTaskTurn(turn.text, {
          requestedExplicitConfirmation,
        });
        if (!shouldContinue) break;

        followupTurnsUsed += 1;
        requestedExplicitConfirmation = true;
        const followupReason =
          this.#looksLikeQuestion(turn.text)
            ? 'question'
            : this.#looksLikePendingWork(turn.text)
              ? 'unfinished'
              : 'unclear';
        state.recordActivity(`follow-up turn requested: ${followupReason}`, {
          method: 'task/followup',
          reason: followupReason,
          attempt: followupTurnsUsed,
        });
        emitEvent?.({
          type: 'task.followup.requested',
          taskId: task.id,
          attempt: followupTurnsUsed,
          reason: followupReason,
        });
        turn = await runOneTurn(TASK_FOLLOW_UP_PROMPT);
      }

      const exhaustedFollowUpBudget = followupTurnsUsed >= TASK_MAX_EXTRA_TURNS;
      if (exhaustedFollowUpBudget && this.#shouldRespawnIncompleteTask(turn.text)) {
        const reason = 'task turn ended before the assigned work was complete';
        emitEvent?.({
          type: 'task.followup.exhausted',
          taskId: task.id,
          followupTurns: followupTurnsUsed,
          reason,
        });
        const now = Date.now();
        const overMax = WATCHDOG_RESPAWN_MAX > 0 && state.respawnAttempts >= WATCHDOG_RESPAWN_MAX;
        const coolingDown = state.lastRespawnAt
          && now - state.lastRespawnAt < WATCHDOG_RESPAWN_COOLDOWN_MS;
        if (!overMax && !coolingDown && state.requestRespawn(reason)) {
          state.respawnAttempts += 1;
          state.lastRespawnAt = now;
          emitEvent?.({
            type: 'task.respawn.requested',
            taskId: task.id,
            reason,
            attempt: state.respawnAttempts,
            source: 'task-followup',
            followupTurns: followupTurnsUsed,
          });
          this.sendLog(`[watchdog] respawn requested for ${task.id}: ${reason}`);
        }
        throw new Error(reason);
      }

      let commit = null;
      let changedFiles = [];
      if (USE_GIT_WORKTREES) {
        const commitMessage = `cdx: ${task.id} - ${task.description}`;
        await commitAll({ cwd: state.worktreePath, message: commitMessage });
        commit = (await git(['rev-parse', 'HEAD'], { cwd: state.worktreePath })).trim();
        const committedFilesOutput = await git(
          ['show', '--name-only', '--pretty=format:', 'HEAD'],
          { cwd: state.worktreePath },
        ).catch(() => '');
        changedFiles = uniqueList(
          committedFilesOutput
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean),
        );
      } else {
        const finalized = await this.#withSharedRepoGitLock(async () =>
          this.#finalizeSharedTaskChanges({
            task,
            taskStates,
            cwd: state.worktreePath,
            emitEvent,
          }));
        commit = finalized?.commit ?? null;
        changedFiles = Array.isArray(finalized?.changedFiles) ? finalized.changedFiles : [];
      }

      state.complete({
        output: turn.text,
        prd,
        threadId,
        turnId: turn.turnId,
        commit,
        changedFiles,
        events: allEvents,
      });
    } finally {
      emitEvent?.({
        type: 'agent.disposing',
        agentId,
        taskId: task.id,
        phase: 'task',
      });
      state.clearClient();
      detach();
      await client.dispose(`task-${task.id}-finished`);
      emitEvent?.({
        type: 'agent.disposed',
        agentId,
        taskId: task.id,
        phase: 'task',
      });
    }
  }

  async #runTurnCore({
    client,
    collectors,
    threadId,
    startMethod,
    startRequest,
    estimateInputText,
    onEvent,
    agentId,
    taskId,
    phase,
    emitEvent,
    timeoutMsOverride,
    effort,
  }) {
    const timeoutMs = Number.isFinite(timeoutMsOverride) && timeoutMsOverride > 0
      ? timeoutMsOverride
      : TURN_TIMEOUT_MS;
    const methodLabel = typeof startMethod === 'string' && startMethod.trim()
      ? startMethod.trim()
      : 'turn/start';
    if (typeof startRequest !== 'function') {
      throw new Error(`Invalid startRequest for ${methodLabel}`);
    }

    // Some app-server implementations may emit turn notifications immediately after replying to
    // turn/start (in the same stdout chunk). When we attach the completion listener only after
    // awaiting turn/start, we can miss the turn/completed event and deadlock. To avoid this,
    // attach a per-turn notification buffer before issuing the request.
    let activeTurnId = null;
    const bufferedNotifications = [];

    const turnCollector = new TurnCollector({ threadId, turnId: '', onEvent });

    let completedParams = null;
    let resolveCompletion;
    let rejectCompletion;

    const completionPromise = new Promise((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });

    const onExit = payload => {
      if (completedParams) return;
      const code = payload?.code ?? null;
      const signal = payload?.signal ?? null;
      const error = payload?.error ?? null;
      const detail = error
        ? `error=${error}`
        : `code=${code ?? 'null'} signal=${signal ?? 'null'}`;
      const message = `app-server exited before turn completion (${detail})`;
      completedParams = {
        threadId,
        turn: { id: activeTurnId, status: 'failed' },
        error: { message },
      };
      rejectCompletion(new Error(message));
    };

    const recordOrDispatch = message => {
      if (!message || typeof message !== 'object') return;
      const params = message.params;
      if (!params || params.threadId !== threadId) return;
      const eventTurnId = params.turnId ?? params.turn?.id;
      if (!eventTurnId) return;

      if (!activeTurnId) {
        bufferedNotifications.push(message);
        return;
      }

      if (eventTurnId !== activeTurnId) return;
      turnCollector.handleNotification(message);

      if (message.method === 'turn/completed' && !completedParams) {
        completedParams = params;
        resolveCompletion(params);
      }
    };

    const onNotification = message => {
      recordOrDispatch(message);
    };

    client.on('notification', onNotification);
    client.on('exit', onExit);

    let timeout = null;
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        if (!completedParams) {
          completedParams = { threadId, turn: { id: activeTurnId, status: 'failed' }, error: { message: 'Timed out waiting for turn completion' } };
          rejectCompletion(new Error('Timed out waiting for turn completion'));
        }
      }, timeoutMs);
      timeout.unref?.();
    }

    try {
      const turnStart = await startRequest();
      const turnId = turnStart?.turn?.id;
      if (!turnId) throw new Error(`Failed to start ${methodLabel}`);

      activeTurnId = turnId;
      turnCollector.turnId = turnId;

      for (const message of bufferedNotifications) {
        if (!message || typeof message !== 'object') continue;
        const params = message.params;
        if (!params || params.threadId !== threadId) continue;
        const eventTurnId = params.turnId ?? params.turn?.id;
        if (eventTurnId !== turnId) continue;

        turnCollector.handleNotification(message);
        if (message.method === 'turn/completed' && !completedParams) {
          completedParams = params;
          resolveCompletion(params);
        }
      }

      if (!completedParams && turnCollector.completed) {
        // Collector may have observed turn/completed via buffered notifications.
        completedParams = { threadId, turn: { id: turnId, status: turnCollector.status ?? 'completed' } };
        resolveCompletion(completedParams);
      }

      const completed = completedParams ?? (await completionPromise);

      if (!turnCollector.completed) {
        turnCollector.handleNotification({ method: 'turn/completed', params: completed });
      }

      const events = turnCollector.events;
      const finalTextInfo = turnCollector.finalTextInfo();
      const finalText = finalTextInfo.text;

      const fallbackRole = this.#effortRoleFromPhase(phase);
      const resolvedModel = extractModelFromTurnCompleted(completed) ?? this.#desiredModel(fallbackRole);
      const parsedUsage = extractTokenUsageFromTurnCompleted(completed);
      const usage = parsedUsage ?? {
        inputTokens: typeof estimateInputText === 'string'
          ? estimateTextTokens(estimateInputText)
          : 0,
        cachedInputTokens: 0,
        outputTokens: estimateTextTokens(finalText),
      };
      const estimated = parsedUsage === null;

      const emitter = typeof emitEvent === 'function' ? emitEvent : this.activeEmitEvent;
      if (emitter && agentId) {
        emitter({
          type: 'turn.completed',
          agentId,
          taskId: taskId ?? null,
          phase: phase ?? null,
          threadId,
          turnId,
          status: turnCollector.status ?? null,
          model: resolvedModel,
          effort: effort ?? null,
          usage,
          estimated,
        });
      }

      if (turnCollector.status === 'failed') {
        const msg = turnCollector.error || 'turn failed';
        throw new Error(msg);
      }

      if (collectors instanceof Map) {
        collectors.delete(`${threadId}:${turnId}`);
      }

      return {
        turnId,
        text: finalText,
        textSource: finalTextInfo.source,
        hadAgentMessageDelta: finalTextInfo.hadAgentMessageDelta === true,
        events,
        model: resolvedModel,
        effort: effort ?? null,
        usage,
        estimated,
        startResponse: turnStart,
      };
    } finally {
      if (timeout) clearTimeout(timeout);
      client.off('notification', onNotification);
      client.off('exit', onExit);
      if (activeTurnId && collectors instanceof Map) {
        collectors.delete(`${threadId}:${activeTurnId}`);
      }
    }
  }

  async #runTurn({
    client,
    collectors,
    threadId,
    cwd,
    text,
    onEvent,
    agentId,
    taskId,
    phase,
    emitEvent,
    effortOverride,
    timeoutMs,
  }) {
    const effortRole = this.#effortRoleFromPhase(phase);
    const desiredModel = this.#desiredModel(effortRole);
    const desiredEffort = this.#desiredEffort(effortRole, effortOverride);
    const promptText = typeof text === 'string' ? text : String(text ?? '');
    const turnParams = {
      threadId,
      input: [{ type: 'text', text: promptText }],
      cwd,
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
      model: desiredModel,
      effort: desiredEffort ?? undefined,
    };
    if (taskId && this.contextStore?.recordPrompt) {
      this.contextStore.recordPrompt({
        taskId,
        agentId,
        phase,
        threadId,
        text: promptText,
        timestamp: new Date().toISOString(),
      });
    }
    this.#emitPromptEvent({
      emitter: emitEvent,
      agentId,
      taskId,
      phase,
      threadId,
      method: 'turn/start',
      params: turnParams,
      text: promptText,
    });
    return await this.#runTurnCore({
      client,
      collectors,
      threadId,
      startMethod: 'turn/start',
      estimateInputText: promptText,
      startRequest: () => client.request('turn/start', turnParams),
      onEvent,
      agentId,
      taskId,
      phase,
      emitEvent,
      timeoutMsOverride: timeoutMs,
      effort: desiredEffort ?? null,
    });
  }

  async #runReviewTurn({
    client,
    collectors,
    threadId,
    target,
    delivery = 'inline',
    onEvent,
    agentId,
    taskId,
    phase,
    emitEvent,
  }) {
    const normalizedDelivery =
      typeof delivery === 'string' && delivery.trim() ? delivery.trim() : 'inline';
    if (normalizedDelivery !== 'inline') {
      throw new Error(
        `Unsupported review delivery: ${normalizedDelivery}. Only inline review is currently supported.`,
      );
    }

    const startParams = {
      threadId,
      delivery: 'inline',
      target,
    };

    const turn = await this.#runTurnCore({
      client,
      collectors,
      threadId,
      startMethod: 'review/start',
      estimateInputText: JSON.stringify(startParams),
      startRequest: () => client.request('review/start', startParams),
      onEvent,
      agentId,
      taskId,
      phase,
      emitEvent,
    });

    return {
      ...turn,
      reviewThreadId: turn?.startResponse?.reviewThreadId ?? null,
    };
  }

  async #mergeIntoIntegration({ integrationPath, taskStates, tasks, emitEvent }) {
    if (!USE_GIT_WORKTREES) {
      const merged = [];
      const skipped = [];
      for (const task of tasks ?? []) {
        const state = taskStates.get(task.id);
        if (!state) continue;
        if (state.status !== 'completed') {
          continue;
        }
        merged.push({
          id: task.id,
          branch: null,
          mode: 'shared',
          files: Array.isArray(state.changedFiles) ? [...state.changedFiles] : [],
        });
        emitEvent?.({
          type: 'integration.merge.completed',
          taskId: task.id,
          branch: null,
          mode: 'shared',
          files: Array.isArray(state.changedFiles) ? [...state.changedFiles] : [],
        });
      }
      const head = (await git(['rev-parse', 'HEAD'], { cwd: integrationPath })).trim();
      return { merged, skipped, integrationHead: head };
    }

    const merged = [];
    const failed = [];
    const autoResolveLimit = MERGE_AUTO_RESOLVE_LIMIT > 0 ? MERGE_AUTO_RESOLVE_LIMIT : Infinity;
    let autoResolveUsed = 0;
    const mergeResolveTimeoutMs = MERGE_RESOLVE_TIMEOUT_MS > 0 ? MERGE_RESOLVE_TIMEOUT_MS : null;
    for (const task of tasks) {
      const state = taskStates.get(task.id);
      if (!state) continue;
      if (state.status !== 'completed') {
        continue;
      }
      try {
        const activeOps = await listGitOperationsInProgress({
          cwd: integrationPath,
          log: (...args) => this.sendLog(args.join(' ')),
        }).catch(() => []);
        if (activeOps.length > 0) {
          this.sendLog(
            `Integration worktree had ${activeOps.length} in-progress git operation(s); aborting before merge.`,
          );
          await abortGitOperations({
            cwd: integrationPath,
            log: (...args) => this.sendLog(args.join(' ')),
            abortMerge: true,
          }).catch(err => {
            const msg = err instanceof Error ? err.message : String(err ?? 'abort failed');
            this.sendLog(`Failed to abort git operation before merge: ${msg}`);
          });
        }

        const mergeMessage = formatMergeMessage('task', task.id, state.branch);
        await mergeNoEdit({
          cwd: integrationPath,
          branch: state.branch,
          message: mergeMessage,
          log: (...args) => this.sendLog(args.join(' ')),
        });
        merged.push({ id: task.id, branch: state.branch });
        emitEvent?.({
          type: 'integration.merge.completed',
          taskId: task.id,
          branch: state.branch,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err ?? 'merge failed');
        const isConflict = await detectMergeConflict({
          err,
          cwd: integrationPath,
          log: (...args) => this.sendLog(args.join(' ')),
        });
        await logMergeFailureSummary({
          cwd: integrationPath,
          label: task.id,
          log: (...args) => this.sendLog(args.join(' ')),
        });
        const allowResolve =
          isConflict
          && MERGE_AUTO_RESOLVE
          && autoResolveUsed < autoResolveLimit;

        if (!allowResolve) {
          if (isConflict) {
            this.sendLog(`Merge conflict for ${task.id}; auto-resolve skipped: ${message}`);
          } else {
            this.sendLog(`Merge failed for ${task.id}: ${message}`);
          }
          await abortMerge({ cwd: integrationPath }).catch(() => {});
          failed.push({
            id: task.id,
            reason: isConflict ? 'merge_conflict' : 'merge_failed',
            error: message,
          });
          emitEvent?.({
            type: 'integration.merge.skipped',
            taskId: task.id,
            branch: state.branch,
            reason: isConflict ? 'merge_conflict' : 'merge_failed',
            error: message,
          });
          continue;
        }

        autoResolveUsed += 1;
        this.sendLog(`Merge conflict for ${task.id}: ${message}`);
        try {
          await this.#resolveMergeConflict({
            integrationPath,
            taskId: task.id,
            emitEvent,
            timeoutMs: mergeResolveTimeoutMs,
          });
          merged.push({ id: task.id, branch: state.branch, resolved: true });
          emitEvent?.({
            type: 'integration.merge.resolved',
            taskId: task.id,
            branch: state.branch,
          });
        } catch (resolveErr) {
          const resolveMessage =
            resolveErr instanceof Error ? resolveErr.message : String(resolveErr ?? 'merge resolve failed');
          this.sendLog(`Merge resolve failed for ${task.id}: ${resolveMessage}`);
          await abortMerge({ cwd: integrationPath }).catch(() => {});
          failed.push({
            id: task.id,
            reason: 'merge_conflict',
            error: resolveMessage,
          });
          emitEvent?.({
            type: 'integration.merge.failed',
            taskId: task.id,
            branch: state.branch,
            reason: 'merge_conflict',
            error: resolveMessage,
          });
        }
      }
    }
    const head = (await git(['rev-parse', 'HEAD'], { cwd: integrationPath })).trim();
    return { merged, skipped: failed, integrationHead: head };
  }

  async #recoverIntegrationMerges({ integrationPath, taskStates, mergeReport, emitEvent, stage }) {
    if (!USE_GIT_WORKTREES) return mergeReport;
    if (!INTEGRATION_MERGE_RECOVERY_ENABLED) return mergeReport;
    const skipped = Array.isArray(mergeReport?.skipped) ? mergeReport.skipped : [];
    if (!integrationPath || skipped.length == 0) return mergeReport;

    const recovered = [];
    const stillSkipped = [];
    let attempted = 0;
    const maxTasks = INTEGRATION_MERGE_RECOVERY_MAX;
    const stageLabel = typeof stage === 'string' && stage.trim() ? stage.trim() : 'integration';
    const manualMergeEnabled =
      INTEGRATION_MERGE_MANUAL_ENABLED && skipped.length >= INTEGRATION_MERGE_MANUAL_THRESHOLD;
    const manualMergeStrategy = INTEGRATION_MERGE_MANUAL_STRATEGY;

    for (const entry of skipped) {
      const taskId = entry?.id;
      if (!taskId) continue;
      if (maxTasks > 0 && attempted >= maxTasks) {
        stillSkipped.push(entry);
        continue;
      }
      const state = taskStates.get(taskId);
      if (!state || state.status !== 'completed' || !state.branch) {
        stillSkipped.push(entry);
        continue;
      }

      attempted += 1;
      let resolved = false;
      let lastError = null;
      let manualTried = false;

      for (let attempt = 1; attempt <= INTEGRATION_MERGE_RECOVERY_MAX_ATTEMPTS; attempt += 1) {
        try {
          const activeOps = await listGitOperationsInProgress({
            cwd: integrationPath,
            log: (...args) => this.sendLog(args.join(' ')),
          }).catch(() => []);
          if (activeOps.length > 0) {
            await abortGitOperations({
              cwd: integrationPath,
              log: (...args) => this.sendLog(args.join(' ')),
              abortMerge: true,
            }).catch(() => {});
          }

          const mergeMessage = formatMergeMessage('task', taskId, state.branch);
          await mergeNoEdit({
            cwd: integrationPath,
            branch: state.branch,
            message: mergeMessage,
            log: (...args) => this.sendLog(args.join(' ')),
          });
          resolved = true;
          break;
        } catch (err) {
          lastError = err;
          const message = err instanceof Error ? err.message : String(err ?? 'merge failed');
          const isConflict = await detectMergeConflict({
            err,
            cwd: integrationPath,
            log: (...args) => this.sendLog(args.join(' ')),
          });
          await logMergeFailureSummary({
            cwd: integrationPath,
            label: `${taskId} (recovery ${stageLabel})`,
            log: (...args) => this.sendLog(args.join(' ')),
          });

          if (await this.#mergeAlreadyResolved({
            cwd: integrationPath,
            taskId,
            label: `integration recovery ${taskId}`,
            emitEvent,
          })) {
            resolved = true;
            break;
          }

          if (!isConflict) {
            await abortMerge({ cwd: integrationPath }).catch(() => {});
            continue;
          }

          if (manualMergeEnabled && !manualTried) {
            manualTried = true;
            const manualOutcome = await this.#manualResolveMergeConflict({
              cwd: integrationPath,
              taskId,
              strategy: manualMergeStrategy,
              emitEvent,
              contextLabel: `integration recovery for task ${taskId} (${stageLabel})`,
            });
            if (manualOutcome?.resolved) {
              resolved = true;
              break;
            }
          }

          const sequence = TASK_RETRY_EFFORT_SEQUENCE.length > 0
            ? TASK_RETRY_EFFORT_SEQUENCE
            : [DEFAULT_TASK_EFFORT];
          const effortOverride = sequence[Math.min(attempt - 1, sequence.length - 1)] ?? DEFAULT_TASK_EFFORT;

          try {
            await this.#resolveMergeConflict({
              integrationPath,
              taskId,
              contextLabel: `integration recovery for task ${taskId} (${stageLabel})`,
              emitEvent,
              timeoutMs: WATCHDOG_MERGE_TIMEOUT_MS > 0 ? WATCHDOG_MERGE_TIMEOUT_MS : null,
              effortOverride,
            });
            resolved = true;
            break;
          } catch (resolveErr) {
            lastError = resolveErr;
            await abortMerge({ cwd: integrationPath }).catch(() => {});
            if (attempt >= INTEGRATION_MERGE_RECOVERY_MAX_ATTEMPTS) {
              break;
            }
            this.sendLog(
              `[merge] integration recovery failed for ${taskId} (attempt ${attempt}/${INTEGRATION_MERGE_RECOVERY_MAX_ATTEMPTS}): ${message}`,
            );
          }
        }
      }

      if (resolved) {
        recovered.push({ id: taskId, branch: state.branch, recovered: true });
        emitEvent?.({
          type: 'integration.merge.recovered',
          taskId,
          branch: state.branch,
          stage: stageLabel,
        });
      } else {
        const errorText = lastError instanceof Error ? lastError.message : String(lastError ?? entry?.error ?? 'merge recovery failed');
        stillSkipped.push({
          id: taskId,
          reason: entry?.reason ?? 'merge_failed',
          error: errorText,
        });
        emitEvent?.({
          type: 'integration.merge.recovery_failed',
          taskId,
          branch: state.branch,
          stage: stageLabel,
          error: errorText,
        });
      }
    }

    const head = (await git(['rev-parse', 'HEAD'], { cwd: integrationPath })).trim();
    const merged = [...(mergeReport?.merged ?? []), ...recovered];
    const nextReport = {
      merged,
      skipped: stillSkipped,
      integrationHead: head,
      recovered,
    };
    emitEvent?.({
      type: 'integration.merge.recovery.completed',
      stage: stageLabel,
      recovered: recovered.length,
      skipped: stillSkipped.length,
    });
    return nextReport;
  }


  async #salvageIntegration({
    integrationPath,
    taskStates,
    tasks,
    baseRef,
    emitEvent,
    preferTaskIds,
    allowFallback = false,
    normalize = false,
    stage,
  } = {}) {
    if (!USE_GIT_WORKTREES) {
      return { attempted: false, reason: 'shared_workspace_mode' };
    }
    if (!integrationPath) {
      return { attempted: false, reason: 'missing_integration_path' };
    }
    if (!Array.isArray(tasks) || tasks.length === 0) {
      return { attempted: false, reason: 'no_tasks' };
    }

    const stageLabel = typeof stage === 'string' && stage.trim() ? stage.trim() : 'integration';
    const log = (...args) => this.sendLog(args.join(' '));

    const summaries = await collectTaskLayoutSummaries({
      taskStates,
      tasks,
      baseRef,
      fileSampleLimit: INTEGRATION_SALVAGE_FILE_SAMPLE,
      log,
    });

    if (summaries.length === 0) {
      return { attempted: false, reason: 'no_task_changes', tasks: [] };
    }

    const layout = detectLayoutMismatch(summaries);
    const dominantRoot = layout.roots?.[0]?.[0] ?? null;
    const normalizeEnabled = Boolean(normalize && dominantRoot && layout.mismatch);

    if (layout.mismatch) {
      emitEvent?.({
        type: 'integration.layout.mismatch',
        stage: stageLabel,
        roots: layout.roots,
        dominantRoot,
        taskCount: summaries.length,
      });
    }

    const preferSet = new Set(uniqueList(preferTaskIds));
    const statusRank = status => {
        if (status === 'completed') return 3;
        if (status === 'superseded') return 2.5;
        if (status === 'blocked') return 2;
        if (status === 'failed') return 1;
        if (status === 'running') return 0;
        return -1;
      };

    let candidates = summaries.filter(summary => summary.hasChanges);
    if (preferSet.size > 0) {
      const preferred = candidates.filter(summary => preferSet.has(summary.id));
      if (preferred.length > 0) {
        candidates = preferred;
      } else if (!allowFallback) {
        candidates = [];
      }
    }

    if (candidates.length === 0 && allowFallback) {
      candidates = summaries.filter(summary => summary.hasChanges);
    }

    candidates.sort((a, b) => {
      const preferA = preferSet.has(a.id);
      const preferB = preferSet.has(b.id);
      if (preferA !== preferB) return preferA ? -1 : 1;
      const rankA = statusRank(taskStates.get(a.id)?.status);
      const rankB = statusRank(taskStates.get(b.id)?.status);
      if (rankA !== rankB) return rankB - rankA;
      if ((b.fileCount ?? 0) !== (a.fileCount ?? 0)) {
        return (b.fileCount ?? 0) - (a.fileCount ?? 0);
      }
      return String(a.id).localeCompare(String(b.id));
    });

    if (INTEGRATION_SALVAGE_MAX_TASKS > 0) {
      candidates = candidates.slice(0, INTEGRATION_SALVAGE_MAX_TASKS);
    }

    if (candidates.length === 0) {
      return { attempted: false, reason: 'no_candidates', tasks: [] };
    }

    emitEvent?.({
      type: 'integration.salvage.started',
      stage: stageLabel,
      taskCount: candidates.length,
      preferredCount: preferSet.size,
      layoutMismatch: layout.mismatch,
      dominantRoot,
      normalize: normalizeEnabled,
    });

    await abortGitOperations({
      cwd: integrationPath,
      log,
      abortMerge: true,
    }).catch(() => {});

    const taskReports = [];
    const errors = [];
    let filesCopied = 0;
    let normalizedFiles = 0;

    for (const summary of candidates) {
      const state = taskStates.get(summary.id);
      if (!state?.worktreePath) {
        errors.push({ id: summary.id, error: 'missing worktree' });
        continue;
      }

      let copied = 0;
      let normalized = 0;
      let missing = 0;
      let skipped = 0;

      try {
        const { files } = await listTaskChangedFiles({
          cwd: state.worktreePath,
          baseRef,
          log,
        });

        for (const file of files) {
          if (!file) continue;
          if (file.startsWith('.git/') || file.includes('/.git/')) {
            skipped += 1;
            continue;
          }

          const sourcePath = path.join(state.worktreePath, ...file.split('/'));
          const info = await stat(sourcePath).catch(() => null);
          if (!info || info.isDirectory()) {
            missing += 1;
            continue;
          }

          let targetRel = file;
          if (
            normalizeEnabled
            && summary.dominantRoot
            && dominantRoot
            && summary.dominantRoot !== dominantRoot
          ) {
            const parts = file.split('/');
            if (parts.length > 1 && parts[0] === summary.dominantRoot) {
              targetRel = [dominantRoot, ...parts.slice(1)].join('/');
            }
          }

          const targetPath = path.join(integrationPath, ...targetRel.split('/'));
          await mkdir(path.dirname(targetPath), { recursive: true });
          await copyFile(sourcePath, targetPath);

          copied += 1;
          filesCopied += 1;
          if (targetRel !== file) {
            normalized += 1;
            normalizedFiles += 1;
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err ?? 'salvage failed');
        errors.push({ id: summary.id, error: message });
        this.sendLog(`[watchdog] salvage failed for ${summary.id}: ${message}`);
      }

      taskReports.push({
        id: summary.id,
        status: state.status ?? 'unknown',
        fileCount: summary.fileCount ?? 0,
        copied,
        normalized,
        missing,
        skipped,
        dominantRoot: summary.dominantRoot ?? null,
      });

      emitEvent?.({
        type: 'integration.salvage.task',
        stage: stageLabel,
        taskId: summary.id,
        copied,
        normalized,
        missing,
        skipped,
      });
    }

    const committed = await commitAll({
      cwd: integrationPath,
      message: `cdx: salvage integration (${stageLabel})`,
      log,
    });
    const integrationHead = (await git(['rev-parse', 'HEAD'], { cwd: integrationPath })).trim();

    const report = {
      attempted: true,
      stage: stageLabel,
      committed,
      integrationHead,
      filesCopied,
      normalizedFiles,
      tasks: taskReports,
      errors,
      layoutMismatch: layout.mismatch,
      dominantRoot,
      roots: layout.roots,
    };

    emitEvent?.({
      type: 'integration.salvage.completed',
      stage: stageLabel,
      committed,
      taskCount: taskReports.length,
      filesCopied,
      normalizedFiles,
      layoutMismatch: layout.mismatch,
      dominantRoot,
      errorCount: errors.length,
    });

    return report;
  }

  async #readMergeHead({ cwd } = {}) {
    if (!cwd) return '';
    return (await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd }).catch(() => '')).trim();
  }

  async #mergeDependencyBranchOnce({
    worktreePath,
    taskId,
    dependencyId,
    dependencyBranch,
    emitEvent,
    resolved = null,
  } = {}) {
    if (!worktreePath) {
      throw new Error('Missing dependency merge worktree path.');
    }
    if (!dependencyBranch) {
      throw new Error('Missing dependency merge branch.');
    }
    const mergeMessage = formatMergeMessage('dependency', dependencyId, dependencyBranch);
    await mergeNoEdit({
      cwd: worktreePath,
      branch: dependencyBranch,
      message: mergeMessage,
      log: (...args) => this.sendLog(args.join(' ')),
    });
    emitEvent?.({
      type: 'task.dependency.merged',
      taskId: taskId ?? null,
      dependencyId: dependencyId ?? null,
      dependencyBranch,
      resolved,
    });
  }

  async #resolveDependencyMergeConflict({
    worktreePath,
    taskId,
    dependencyId,
    dependencyBranch,
    emitEvent,
    contextLabel,
    timeoutMs,
    resolved = 'conflict_resolved',
  } = {}) {
    await this.#resolveMergeConflict({
      worktreePath,
      taskId,
      dependencyId,
      dependencyBranch,
      contextLabel,
      emitEvent,
      timeoutMs,
    });
    emitEvent?.({
      type: 'task.dependency.merged',
      taskId: taskId ?? null,
      dependencyId: dependencyId ?? null,
      dependencyBranch: dependencyBranch ?? null,
      resolved,
    });
    return resolved;
  }

  #answerDependencyMergeAsk({
    askId,
    taskId,
    answeredBy = 'watchdog',
    optionId = 'resolve',
    rationale,
    messageForAgent,
  } = {}) {
    const resolvedAskId = typeof askId === 'string' && askId.trim() ? askId.trim() : null;
    if (!resolvedAskId) return { ok: false, error: 'missing_ask_id' };
    const resolvedOptionId =
      typeof optionId === 'string' && optionId.trim() ? optionId.trim().toLowerCase() : 'resolve';
    const resolvedRationale =
      typeof rationale === 'string' && rationale.trim()
        ? rationale.trim()
        : 'Watchdog recovered the dependency merge and is resuming the task.';
    const resolvedMessage =
      typeof messageForAgent === 'string' && messageForAgent.trim()
        ? messageForAgent.trim()
        : 'Watchdog recovered the dependency merge. Continue the task.';
    const outcome = this.answerRouterAsk({
      askId: resolvedAskId,
      response: {
        decision: {
          option_id: resolvedOptionId,
          rationale: resolvedRationale,
          next_steps: [],
          risks: [],
          confidence: null,
        },
        message_for_agent: resolvedMessage,
      },
      answeredBy,
    });
    if (outcome?.ok) {
      this.sendLog(
        `[watchdog] auto-answered supervisor ask ${resolvedAskId} for ${taskId ?? 'unknown'} (${resolvedOptionId}).`,
      );
    }
    return outcome;
  }

  async #takeOverDependencyMergeForAsk({ ask, emitEvent } = {}) {
    const taskId = typeof ask?.taskId === 'string' && ask.taskId.trim() ? ask.taskId.trim() : null;
    const askId = typeof ask?.askId === 'string' && ask.askId.trim() ? ask.askId.trim() : null;
    const worktreePath =
      typeof ask?.worktreePath === 'string' && ask.worktreePath.trim()
        ? ask.worktreePath.trim()
        : null;
    const dependencyId =
      typeof ask?.dependencyId === 'string' && ask.dependencyId.trim()
        ? ask.dependencyId.trim()
        : null;
    const dependencyBranch =
      typeof ask?.dependencyBranch === 'string' && ask.dependencyBranch.trim()
        ? ask.dependencyBranch.trim()
        : null;
    const label = `${taskId ?? 'task'} dependency ${dependencyId ?? 'unknown'}`;
    if (!askId || !worktreePath || !dependencyBranch) {
      return { ok: false, error: 'missing_merge_ask_metadata' };
    }

    try {
      if (await this.#mergeAlreadyResolved({
        cwd: worktreePath,
        taskId,
        label,
        emitEvent,
      })) {
        const outcome = this.#answerDependencyMergeAsk({
          askId,
          taskId,
          rationale: 'Watchdog confirmed that no merge conflict remains in the worktree.',
          messageForAgent: 'No merge conflict remains. Continue the task.',
        });
        return {
          ok: outcome?.ok === true || outcome?.error === 'ask_not_pending',
          action: 'clean-auto-answer',
          error: outcome?.ok ? null : outcome?.error ?? null,
        };
      }

      this.sendLog(
        `[watchdog] merge recovery actions for ${taskId ?? askId}: dependency=${dependencyId ?? 'unknown'} branch=${dependencyBranch}`,
      );
      emitEvent?.({
        type: 'watchdog.merge_takeover.started',
        askId,
        taskId,
        dependencyId,
        dependencyBranch,
        worktreePath,
      });

      const mergeTimeoutMs = WATCHDOG_MERGE_TIMEOUT_MS > 0
        ? WATCHDOG_MERGE_TIMEOUT_MS
        : MERGE_RESOLVE_TIMEOUT_MS > 0
          ? MERGE_RESOLVE_TIMEOUT_MS
          : null;
      const contextLabel = `watchdog recovery for task ${taskId ?? 'unknown'}`;
      const mergeHead = await this.#readMergeHead({ cwd: worktreePath });
      if (mergeHead) {
        await this.#resolveDependencyMergeConflict({
          worktreePath,
          taskId,
          dependencyId,
          dependencyBranch,
          contextLabel,
          emitEvent,
          timeoutMs: mergeTimeoutMs,
          resolved: 'watchdog_conflict_resolved',
        });
      } else {
        await abortMerge({ cwd: worktreePath }).catch(() => {});
        try {
          await this.#mergeDependencyBranchOnce({
            worktreePath,
            taskId,
            dependencyId,
            dependencyBranch,
            emitEvent,
            resolved: 'watchdog_retry',
          });
        } catch (err) {
          const isConflict = await detectMergeConflict({
            err,
            cwd: worktreePath,
            log: (...args) => this.sendLog(args.join(' ')),
          });
          await logMergeFailureSummary({
            cwd: worktreePath,
            label,
            log: (...args) => this.sendLog(args.join(' ')),
          });
          if (!isConflict) throw err;
          await this.#resolveDependencyMergeConflict({
            worktreePath,
            taskId,
            dependencyId,
            dependencyBranch,
            contextLabel,
            emitEvent,
            timeoutMs: mergeTimeoutMs,
            resolved: 'watchdog_retry_conflict_resolved',
          });
        }
      }

      const outcome = this.#answerDependencyMergeAsk({
        askId,
        taskId,
        rationale: 'Watchdog recovered the dependency merge directly and is resuming the task.',
      });
      if (!outcome?.ok && outcome?.error !== 'ask_not_pending') {
        throw new Error(`failed to answer router.ask ${askId}: ${outcome?.error ?? 'unknown_error'}`);
      }
      emitEvent?.({
        type: 'watchdog.merge_takeover.completed',
        askId,
        taskId,
        dependencyId,
        dependencyBranch,
      });
      return { ok: true, action: 'takeover-resolved' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? 'merge recovery failed');
      this.sendLog(`[watchdog] merge recovery failed for ${taskId ?? askId}: ${message}`);
      emitEvent?.({
        type: 'watchdog.merge_takeover.failed',
        askId,
        taskId,
        dependencyId,
        dependencyBranch,
        error: message,
      });
      return { ok: false, error: message };
    }
  }

  async #recoverPendingMergeSupervisorAsks({ emitEvent } = {}) {
    const pending = this.listPendingRouterAsks();
    const recoveryPlan = planWatchdogMergeAskRecovery(pending, {
      now: Date.now(),
      minAgeMs: WATCHDOG_MERGE_ASK_MIN_AGE_MS,
      minTakeoverGroupSize: WATCHDOG_MERGE_TAKEOVER_MIN_ASKS,
    });

    if (recoveryPlan.eligible.length === 0) {
      return {
        recovered: false,
        eligible: 0,
        takeoverGroups: 0,
        takeoverRecovered: 0,
        autoAnswered: 0,
        failed: 0,
      };
    }

    const eligibleByAskId = new Map(recoveryPlan.eligible.map(record => [record.askId, record]));
    let takeoverRecovered = 0;
    let autoAnswered = 0;
    let failed = 0;

    for (const group of recoveryPlan.takeoverGroups) {
      this.sendLog(
        `[watchdog] merge takeover queued: asks=${group.askIds.join(', ')} tasks=${group.taskIds.join(', ') || '-'} conflicts=${group.conflictPaths.join(', ') || '-'}.`,
      );
      emitEvent?.({
        type: 'watchdog.merge_takeover.queued',
        askIds: group.askIds,
        taskIds: group.taskIds,
        conflictPaths: group.conflictPaths,
      });
      for (const askId of group.askIds) {
        const ask = eligibleByAskId.get(askId);
        if (!ask) continue;
        const outcome = await this.#takeOverDependencyMergeForAsk({ ask, emitEvent });
        if (outcome?.ok) takeoverRecovered += 1;
        else failed += 1;
      }
    }

    for (const ask of recoveryPlan.standalone) {
      if (!ask?.askId || !ask?.worktreePath) continue;
      const label = `${ask.taskId ?? 'task'} dependency ${ask.dependencyId ?? 'unknown'}`;
      const resolved = await this.#mergeAlreadyResolved({
        cwd: ask.worktreePath,
        taskId: ask.taskId ?? null,
        label,
        emitEvent,
      });
      if (!resolved) continue;
      const outcome = this.#answerDependencyMergeAsk({
        askId: ask.askId,
        taskId: ask.taskId ?? null,
        rationale: 'Watchdog confirmed that the dependency merge already finished cleanly.',
        messageForAgent: 'The dependency merge is already complete. Continue the task.',
      });
      if (outcome?.ok || outcome?.error === 'ask_not_pending') {
        autoAnswered += 1;
      } else {
        failed += 1;
      }
    }

    return {
      recovered: takeoverRecovered > 0 || autoAnswered > 0,
      eligible: recoveryPlan.eligible.length,
      takeoverGroups: recoveryPlan.takeoverGroups.length,
      takeoverRecovered,
      autoAnswered,
      failed,
    };
  }

  async #mergeAlreadyResolved({ cwd, taskId, label, emitEvent }) {
    const { resolved, summary } = await readMergeResolution({ cwd });
    if (!resolved) return false;
    const note = typeof label === 'string' && label.trim()
      ? label.trim()
      : typeof taskId === 'string' && taskId.trim()
        ? `task ${taskId.trim()}`
        : 'merge';
    this.sendLog(`[merge] ${note}: no conflicts remain; treating as resolved.`);
    emitEvent?.({
      type: 'merge.resolved.detected',
      taskId: taskId ?? null,
      label: note,
      summary,
    });
    return true;
  }


  async #manualResolveMergeConflict({
    cwd,
    taskId,
    strategy,
    emitEvent,
    contextLabel,
  }) {
    if (!cwd) return { resolved: false, files: [], error: 'missing cwd' };
    const resolvedStrategy = normalizeConflictStrategy(strategy) ?? 'theirs';
    const effectiveStrategy = resolvedStrategy === 'abort' ? 'theirs' : resolvedStrategy;

    let result;
    try {
      result = await resolveUnmergedPaths({
        cwd,
        strategy: effectiveStrategy,
        log: (...args) => this.sendLog(args.join(' ')),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? 'manual resolve failed');
      this.sendLog(`[merge] manual resolve failed for ${taskId ?? 'merge'}: ${message}`);
      emitEvent?.({
        type: 'integration.merge.manual_failed',
        taskId: taskId ?? null,
        label: contextLabel ?? null,
        strategy: effectiveStrategy,
        error: message,
      });
      return { resolved: false, files: [], error: message };
    }

    if (!result?.resolved) {
      return { resolved: false, files: result?.files ?? [] };
    }

    const unmerged = await git(['ls-files', '-u'], { cwd }).catch(() => '');
    if (String(unmerged ?? '').trim()) {
      const message = `Unresolved merge conflicts remain after manual resolve.`;
      this.sendLog(`[merge] manual resolve incomplete for ${taskId ?? 'merge'}: ${message}`);
      emitEvent?.({
        type: 'integration.merge.manual_failed',
        taskId: taskId ?? null,
        label: contextLabel ?? null,
        strategy: effectiveStrategy,
        error: message,
      });
      return { resolved: false, files: result.files ?? [], error: message };
    }

    const mergeHead = await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd }).catch(() => '');
    if (String(mergeHead ?? '').trim()) {
      const commitArgs = [
        '-c',
        `user.name=${process.env.CDX_GIT_USER_NAME ?? 'cdx-bot'}`,
        '-c',
        `user.email=${process.env.CDX_GIT_USER_EMAIL ?? 'cdx-bot@localhost'}`,
        'commit',
        '--no-edit',
      ];
      await git(commitArgs, { cwd });
    }

    const status = (await git(['status', '--porcelain'], { cwd })).trim();
    if (status) {
      const message = `Manual merge resolver left pending changes.`;
      this.sendLog(`[merge] manual resolve incomplete for ${taskId ?? 'merge'}: ${message}`);
      emitEvent?.({
        type: 'integration.merge.manual_failed',
        taskId: taskId ?? null,
        label: contextLabel ?? null,
        strategy: effectiveStrategy,
        error: message,
      });
      return { resolved: false, files: result.files ?? [], error: message };
    }

    emitEvent?.({
      type: 'integration.merge.manual_resolved',
      taskId: taskId ?? null,
      label: contextLabel ?? null,
      strategy: effectiveStrategy,
      files: result.files ?? [],
    });
    this.sendLog(
      `[merge] manual resolve completed for ${taskId ?? 'merge'} using ${effectiveStrategy}.`,
    );
    return { resolved: true, files: result.files ?? [], strategy: effectiveStrategy };
  }

  async #resolveMergeConflict({
    integrationPath,
    worktreePath,
    taskId,
    dependencyId,
    dependencyBranch,
    contextLabel,
    emitEvent,
    timeoutMs,
    effortOverride,
  }) {
    const targetPath = worktreePath ?? integrationPath;
    if (!targetPath) {
      throw new Error('Missing merge worktree path.');
    }
    const agentId = `merge:${taskId}`;

    const scopeLabel =
      typeof contextLabel === 'string' && contextLabel.trim()
        ? contextLabel.trim()
        : taskId
          ? `${worktreePath ? 'preparing task' : 'integrating task'} ${taskId}`
          : 'handling a merge';
    const depSummary =
      dependencyBranch || dependencyId
        ? `Dependency: ${dependencyId ?? 'unknown'}\nBranch: ${dependencyBranch ?? 'unknown'}\n\n`
        : '';
    const prompt = `A git merge conflict occurred while ${scopeLabel}.
${depSummary}Resolve all conflicts in the working tree.

Then run:
- git status --porcelain
- git ls-files -u
- git diff --check

If conflicts are resolved, stage the resolved files and finalize the merge (git commit).
If the merge cannot be resolved, explain why. Do not abort the merge unless strictly necessary.`;

    const isTurnTimeout = err => {
      const message = err instanceof Error ? err.message : String(err ?? '');
      return message.toLowerCase().includes('timed out waiting for turn completion');
    };
    const baseTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : TURN_TIMEOUT_MS;
    const watchdogTimeoutMs = WATCHDOG_MERGE_TIMEOUT_MS;
    const mergeTimeoutMs = watchdogTimeoutMs > 0
      ? Math.min(baseTimeoutMs, watchdogTimeoutMs)
      : baseTimeoutMs;
    const maxRetries = watchdogTimeoutMs > 0 ? WATCHDOG_MERGE_MAX_RETRIES : 0;
    const maxAttempts = 1 + Math.max(0, maxRetries);

    const runMergeAttempt = async attempt => {
      const client = new AppServerClient({
        approvalDecision: DEFAULT_APPROVAL_DECISION,
        approvalJustification: this.execJustification,
        log: (...args) => this.sendLog(`[${agentId}] ${args.join(' ')}`),
        ...this.#buildHookClientOptions({ agentId, taskId, phase: 'merge' }),
        ...this.#buildWorkerClientOptions(taskId, 'task', effortOverride ?? null),
      });
      const collectors = new Map();
      const detach = this.#attachClient({
        client,
        collectors,
        emitEvent,
        agentId,
        taskId,
        phase: 'merge',
        contextStore: this.contextStore,
      });

      const mergeSpec = this.#agentModelEffort({ phase: 'merge', effortOverride });
      emitEvent?.({
        type: 'agent.started',
        agentId,
        taskId,
        phase: 'merge',
        worktreePath: targetPath,
        model: mergeSpec.model,
        effort: mergeSpec.effort,
      });

      try {
        await client.ensureInitialized();
        emitEvent?.({
          type: 'agent.initialized',
          agentId,
          taskId,
          phase: 'merge',
        });

        const threadStart = await client.request('thread/start', {
          model: this.#desiredModel(),
          cwd: targetPath,
          approvalPolicy: DEFAULT_APPROVAL_POLICY,
          sandbox: this.#desiredSandbox(),
          config: this.#buildThreadConfigOverrides() ?? undefined,
        });
        const threadId = threadStart?.thread?.id ?? threadStart?.threadId;
        if (!threadId) throw new Error('Failed to start conflict resolver thread');

        const attemptPrompt = attempt > 1
          ? `${prompt}\n\nWatchdog note: previous merge attempt timed out. Re-check conflicts and finish the merge promptly.`
          : prompt;

        const turn = await this.#runTurn({
          client,
          collectors,
          threadId,
          cwd: targetPath,
          text: attemptPrompt,
          onEvent: ({ method, params }) => {
            if (method === 'item/completed' && params?.item?.type === 'commandExecution') {
              this.sendLog(`[merge] ${params.item.command}`);
            }
          },
          agentId,
          taskId,
          phase: 'merge',
          emitEvent,
          timeoutMs: mergeTimeoutMs,
        });
        await this.#handleHookTurnCompletedNonTask({
          agentId,
          taskId,
          phase: 'merge',
          threadId,
          turn,
          goal: null,
          task: taskId ? { id: taskId } : null,
        });

        const unmerged = (await git(['ls-files', '-u'], { cwd: targetPath })).trim();
        if (unmerged) {
          throw new Error(`Unresolved merge conflicts remain:\n${unmerged.split('\n').slice(0, 10).join('\n')}`);
        }

        const mergeHead = await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], {
          cwd: targetPath,
        }).catch(() => '');
        if (mergeHead.trim()) {
          await git(['add', '-A'], { cwd: targetPath });
          const commitArgs = [
            '-c',
            `user.name=${process.env.CDX_GIT_USER_NAME ?? 'cdx-bot'}`,
            '-c',
            `user.email=${process.env.CDX_GIT_USER_EMAIL ?? 'cdx-bot@localhost'}`,
            'commit',
            '--no-edit',
          ];
          await git(commitArgs, { cwd: targetPath });
        }

        const status = (await git(['status', '--porcelain'], { cwd: targetPath })).trim();
        if (status) {
          throw new Error(`Merge resolver left pending changes:\n${status}`);
        }
      } finally {
        emitEvent?.({
          type: 'agent.disposing',
          agentId,
          taskId,
          phase: 'merge',
        });
        detach();
        await client.dispose(`merge-${taskId}-finished`);
        emitEvent?.({
          type: 'agent.disposed',
          agentId,
          taskId,
          phase: 'merge',
        });
      }
    };

    try {
      let lastError = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          await runMergeAttempt(attempt);
          return;
        } catch (err) {
          lastError = err;
          if (await this.#mergeAlreadyResolved({
            cwd: targetPath,
            taskId,
            label: scopeLabel,
            emitEvent,
          })) {
            return;
          }
          if (attempt < maxAttempts && isTurnTimeout(err)) {
            this.sendLog(
              `[merge] resolution timed out after ${mergeTimeoutMs}ms; retrying (${attempt}/${maxAttempts}).`,
            );
            emitEvent?.({
              type: 'merge.retry',
              taskId,
              attempt,
              timeoutMs: mergeTimeoutMs,
            });
            continue;
          }
          throw err;
        }
      }
      if (lastError) throw lastError;
    } catch (err) {
      if (await this.#mergeAlreadyResolved({
        cwd: targetPath,
        taskId,
        label: scopeLabel,
        emitEvent,
      })) {
        return;
      }
      await abortMerge({ cwd: targetPath }).catch(() => {});
      throw err;
    }
  }

  async #mergeDependencyBranch({ state, task, depId, branch, emitEvent }) {
    if (!USE_GIT_WORKTREES) return;
    const taskId = task?.id ?? 'unknown';
    const dependencyId = depId ?? 'unknown';
    const dependencyBranch = branch;
    const worktreePath = state.worktreePath;
    const mergeLabel = `${taskId} dependency ${dependencyId}`;
    const mergeResolveTimeoutMs = MERGE_RESOLVE_TIMEOUT_MS > 0 ? MERGE_RESOLVE_TIMEOUT_MS : null;

    try {
      await this.#mergeDependencyBranchOnce({
        worktreePath,
        taskId,
        dependencyId,
        dependencyBranch,
        emitEvent,
      });
      return;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err ?? 'Dependency merge failed'));
      this.sendLog(
        `[${taskId}] Dependency merge failed (${dependencyId}): ${error.message}`,
      );
      const failureSummary = await logMergeFailureSummary({
        cwd: worktreePath,
        label: mergeLabel,
        log: (...args) => this.sendLog(args.join(' ')),
      });
      const initialConflictPaths = collectMergeConflictPaths(failureSummary);
      if (await this.#mergeAlreadyResolved({
        cwd: worktreePath,
        taskId,
        label: mergeLabel,
        emitEvent,
      })) {
        return;
      }

      let autoAttempt = null;
      let autoError = null;

      const mergeHeadBefore = await this.#readMergeHead({ cwd: worktreePath });
      if (mergeHeadBefore) {
        autoAttempt = 'resolve';
        try {
          await this.#resolveDependencyMergeConflict({
            worktreePath,
            taskId,
            dependencyId,
            dependencyBranch,
            contextLabel: `preparing task ${taskId}`,
            emitEvent,
            timeoutMs: mergeResolveTimeoutMs,
            resolved: 'conflict_resolved',
          });
          return;
        } catch (resolveErr) {
          autoError = resolveErr instanceof Error
            ? resolveErr
            : new Error(String(resolveErr ?? 'Dependency merge resolve failed'));
        }
      } else {
        autoAttempt = 'retry';
        try {
          await abortMerge({ cwd: worktreePath }).catch(() => {});
          await this.#mergeDependencyBranchOnce({
            worktreePath,
            taskId,
            dependencyId,
            dependencyBranch,
            emitEvent,
            resolved: 'retry',
          });
          return;
        } catch (retryErr) {
          autoError = retryErr instanceof Error
            ? retryErr
            : new Error(String(retryErr ?? 'Dependency merge retry failed'));
        }
      }

      const mergeHeadAfter = await this.#readMergeHead({ cwd: worktreePath });
      const hasMergeHead = mergeHeadAfter.length > 0;
      const postAutoSummary = await summarizeMergeState({ cwd: worktreePath }).catch(() => null);
      const conflictPaths = uniqueList([
        ...initialConflictPaths,
        ...collectMergeConflictPaths(postAutoSummary),
      ]);
      const autoLabel = autoAttempt === 'resolve' ? 'Auto-resolve' : 'Auto-retry';
      const autoDetail = autoError ? `${autoLabel} failed: ${autoError.message}` : '';
      const decision = await this.#askSupervisor({
        question:
          `Dependency merge failed while preparing task ${taskId}.\n\n`
          + `Dependency: ${dependencyId}\n`
          + `Branch: ${dependencyBranch}\n\n`
          + `Error: ${error.message}\n`
          + (autoDetail ? `\n${autoDetail}\n` : '\n')
          + (hasMergeHead
            ? 'A merge is in progress in the worktree. Resolve and continue?'
            : 'No merge is in progress in the worktree. Retry the merge?'),
        options: [
          {
            id: 'resolve',
            summary: hasMergeHead
              ? 'Resolve conflicts automatically and continue.'
              : 'Retry the merge and continue.',
          },
          { id: 'abort', summary: 'Abort this task (leave dependency unresolved).' },
        ],
        constraints: [
          'Prefer to continue if recovery is safe.',
        ],
        desiredOutput: 'Reply with decision.option_id = resolve|abort.',
        taskId,
        metadata: {
          kind: 'dependency-merge-retry',
          taskId,
          dependencyId,
          dependencyBranch,
          worktreePath,
          conflictPaths,
        },
        autoAnswer: {
          kind: 'dependency-merge-retry',
          minAgeMs: WATCHDOG_MERGE_ASK_MIN_AGE_MS,
        },
      });

      const optionIdRaw =
        decision?.decision?.option_id
        ?? decision?.decision?.optionId
        ?? decision?.option_id
        ?? decision?.optionId
        ?? null;
      const optionId =
        typeof optionIdRaw === 'string' && optionIdRaw.trim()
          ? optionIdRaw.trim().toLowerCase()
          : 'resolve';

      if (optionId === 'abort' || optionId === 'fail' || optionId === 'stop') {
        const mergeHeadCurrent = await this.#readMergeHead({ cwd: worktreePath });
        if (mergeHeadCurrent) {
          await abortMerge({ cwd: worktreePath }).catch(() => {});
        }
        throw autoError ?? error;
      }

      if (await this.#mergeAlreadyResolved({
        cwd: worktreePath,
        taskId,
        label: mergeLabel,
        emitEvent,
      })) {
        return;
      }

      const mergeHeadCurrent = await this.#readMergeHead({ cwd: worktreePath });
      if (mergeHeadCurrent) {
        await this.#resolveDependencyMergeConflict({
          worktreePath,
          taskId,
          dependencyId,
          dependencyBranch,
          contextLabel: `preparing task ${taskId}`,
          emitEvent,
          timeoutMs: mergeResolveTimeoutMs,
          resolved: 'conflict_resolved',
        });
        return;
      }

      await abortMerge({ cwd: worktreePath }).catch(() => {});
      await this.#mergeDependencyBranchOnce({
        worktreePath,
        taskId,
        dependencyId,
        dependencyBranch,
        emitEvent,
        resolved: 'retry',
      });
    }
  }

  async #verifyIntegration({ integrationPath, emitEvent, stage } = {}) {
    if (!integrationPath) return { committed: false, commit: null, output: '' };

    const stageLabel = stage ? String(stage) : 'integration';
    const agentId = `checkpoint:${stageLabel}`;
    const client = new AppServerClient({
      approvalDecision: DEFAULT_APPROVAL_DECISION,
      approvalJustification: this.execJustification,
      log: (...args) => this.sendLog(`[${agentId}] ${args.join(' ')}`),
      ...this.#buildHookClientOptions({ agentId, taskId: null, phase: 'checkpoint' }),
      ...this.#buildWorkerClientOptions(agentId),
    });
    const collectors = new Map();
    const detach = this.#attachClient({
      client,
      collectors,
      emitEvent,
      agentId,
      taskId: null,
      phase: 'checkpoint',
      contextStore: this.contextStore,
    });

    const checkpointSpec = this.#agentModelEffort({ phase: 'checkpoint' });
    emitEvent?.({
      type: 'agent.started',
      agentId,
      phase: 'checkpoint',
      worktreePath: integrationPath,
      model: checkpointSpec.model,
      effort: checkpointSpec.effort,
    });

    try {
      await client.ensureInitialized();
      emitEvent?.({
        type: 'agent.initialized',
        agentId,
        phase: 'checkpoint',
      });

      const threadStart = await client.request('thread/start', {
        model: this.#desiredModel(),
        cwd: integrationPath,
        approvalPolicy: DEFAULT_APPROVAL_POLICY,
        sandbox: this.#desiredSandbox(),
        config: this.#buildThreadConfigOverrides() ?? undefined,
      });
      const threadId = threadStart?.thread?.id ?? threadStart?.threadId;
      if (!threadId) throw new Error('Failed to start integration verification thread');

      const promptTemplate = loadPromptTemplate(
        'checkpoint',
        `You are the integration verification agent for a multi-agent run.
Work in the current repository workspace (${USE_GIT_WORKTREES ? 'integration worktree with merged branches' : 'shared workspace mode'}).
Your job:
- Read README/docs for "Run", "Usage", "Test", "Lint", or "Build" commands and execute them.
- Run the project's validation commands as appropriate (tests, lint, typecheck, build).
- If anything fails, fix issues until validations pass.
- Keep changes minimal and focused. Do not introduce unrelated refactors.
- Leave the worktree clean (no uncommitted changes).
Finish with a short report of what you ran and what you fixed.`,
      );
      const prompt = renderPromptTemplate(promptTemplate, {});

      const turn = await this.#runTurn({
        client,
        collectors,
        threadId,
        cwd: integrationPath,
        text: prompt,
        onEvent: ({ method, params }) => {
          if (!STREAM_EVENTS) return;
          if (method === 'item/completed' && params?.item?.type === 'commandExecution') {
            this.sendLog(`[checkpoint] ${params.item.command}`);
          }
        },
        agentId,
        taskId: null,
        phase: 'checkpoint',
        emitEvent,
      });
      await this.#handleHookTurnCompletedNonTask({
        agentId,
        taskId: null,
        phase: 'checkpoint',
        threadId,
        turn,
        goal: null,
        task: null,
      });

      const commitMessage = `cdx: checkpoint (${stageLabel})`;
      const committed = await commitAll({ cwd: integrationPath, message: commitMessage });
      const commit = (await git(['rev-parse', 'HEAD'], { cwd: integrationPath })).trim();

      const status = (await git(['status', '--porcelain'], { cwd: integrationPath })).trim();
      if (status) {
        throw new Error(`Integration checkpoint left pending changes:\n${status}`);
      }

      emitEvent?.({
        type: 'integration.verify.completed',
        stage: stageLabel,
        committed,
        commit,
      });

      return { committed, commit, output: turn.text };
    } finally {
      emitEvent?.({
        type: 'agent.disposing',
        agentId,
        phase: 'checkpoint',
      });
      detach();
      await client.dispose(`checkpoint-${stageLabel}-finished`);
      emitEvent?.({
        type: 'agent.disposed',
        agentId,
        phase: 'checkpoint',
      });
    }
  }

  async #reviewIntegration({ integrationPath, emitEvent, stage, targetSha, goal } = {}) {
    if (!integrationPath || !targetSha) {
      return {
        status: 'skipped',
        reason: 'Missing integrationPath or targetSha.',
        output: '',
      };
    }

    const stageLabel = stage ? String(stage) : 'integration';
    const agentId = `review:${stageLabel}`;

    const client = new AppServerClient({
      approvalDecision: DEFAULT_APPROVAL_DECISION,
      approvalJustification: this.execJustification,
      log: (...args) => this.sendLog(`[${agentId}] ${args.join(' ')}`),
      ...this.#buildHookClientOptions({ agentId, taskId: null, phase: 'review' }),
      ...this.#buildWorkerClientOptions(agentId),
    });
    const collectors = new Map();
    const detach = this.#attachClient({
      client,
      collectors,
      emitEvent,
      agentId,
      taskId: null,
      phase: 'review',
      contextStore: this.contextStore,
    });

    const reviewSpec = this.#agentModelEffort({ phase: 'review' });
    emitEvent?.({
      type: 'agent.started',
      agentId,
      phase: 'review',
      worktreePath: integrationPath,
      model: reviewSpec.model,
      effort: reviewSpec.effort,
    });

    const titleSuffix =
      typeof goal === 'string' && goal.trim() ? clipText(goal.trim(), 80) : stageLabel;
    const target = {
      type: 'commit',
      sha: targetSha,
      title: `cdx review: ${titleSuffix}`,
    };

    try {
      await client.ensureInitialized();
      emitEvent?.({
        type: 'agent.initialized',
        agentId,
        phase: 'review',
      });

      const threadStart = await client.request('thread/start', {
        model: this.#desiredModel(),
        cwd: integrationPath,
        approvalPolicy: DEFAULT_APPROVAL_POLICY,
        sandbox: 'read-only',
        config: this.#buildThreadConfigOverrides() ?? undefined,
      });
      const threadId = threadStart?.thread?.id ?? threadStart?.threadId;
      if (!threadId) throw new Error('Failed to start review thread');

      const reviewTurn = await this.#runReviewTurn({
        client,
        collectors,
        threadId,
        target,
        delivery: 'inline',
        onEvent: ({ method, params }) => {
          if (!STREAM_EVENTS) return;
          if (method === 'item/completed') {
            const itemType = params?.item?.type;
            if (itemType === 'enteredReviewMode') {
              this.sendLog('[review] entered review mode');
            } else if (itemType === 'exitedReviewMode') {
              this.sendLog('[review] exited review mode');
            }
          }
        },
        agentId,
        taskId: null,
        phase: 'review',
        emitEvent,
      });
      await this.#handleHookTurnCompletedNonTask({
        agentId,
        taskId: null,
        phase: 'review',
        threadId,
        turn: reviewTurn,
        goal,
        task: null,
      });

      emitEvent?.({
        type: 'review.completed',
        stage: stageLabel,
        threadId,
        reviewThreadId: reviewTurn.reviewThreadId ?? threadId,
        turnId: reviewTurn.turnId,
        target,
      });

      return {
        status: 'completed',
        stage: stageLabel,
        threadId,
        reviewThreadId: reviewTurn.reviewThreadId ?? threadId,
        turnId: reviewTurn.turnId,
        target,
        delivery: 'inline',
        output: reviewTurn.text ?? '',
        model: reviewTurn.model ?? null,
        usage: reviewTurn.usage ?? null,
        estimated: reviewTurn.estimated ?? null,
      };
    } finally {
      emitEvent?.({
        type: 'agent.disposing',
        agentId,
        phase: 'review',
      });
      detach();
      await client.dispose(`review-${stageLabel}-finished`);
      emitEvent?.({
        type: 'agent.disposed',
        agentId,
        phase: 'review',
      });
    }
  }

  async #fastForwardBase({ repoRoot, headRef, integrationBranch, tasks, mergeSkipped }) {
    if (!USE_GIT_WORKTREES || !integrationBranch) {
      const head = (await git(['rev-parse', 'HEAD'], { cwd: repoRoot })).trim();
      return {
        applied: false,
        reason: 'Shared workspace mode: changes are already on the base branch.',
        integrationBranch: null,
        head,
      };
    }
    if (headRef === 'HEAD') {
      return {
        applied: false,
        reason: 'Detached HEAD; skipping fast-forward.',
        integrationBranch,
      };
    }

    const applyPartial = (process.env.CDX_APPLY_PARTIAL ?? '0') === '1';
    const hasIncomplete =
      (Array.isArray(tasks) && tasks.some(task => (task?.status ?? 'unknown') !== 'completed'))
      || (Number(mergeSkipped) || 0) > 0;
    if (hasIncomplete && !applyPartial) {
      return {
        applied: false,
        reason: 'Tasks did not fully complete; skipping fast-forward.',
        integrationBranch,
      };
    }
    try {
      await git(['merge', '--ff-only', integrationBranch], {
        cwd: repoRoot,
        log: (...args) => this.sendLog(args.join(' ')),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? 'merge failed');
      this.sendLog(`Fast-forward failed: ${message}`);
      return {
        applied: false,
        reason: `Fast-forward failed: ${message}`,
        integrationBranch,
      };
    }
    const head = (await git(['rev-parse', 'HEAD'], { cwd: repoRoot })).trim();
    return { applied: true, head, integrationBranch };
  }

  async #cleanupWorktrees(repoRoot, runRoot, integrationPath, integrationBranch, taskStates) {
    if (!USE_GIT_WORKTREES) {
      await rm(runRoot, { recursive: true, force: true }).catch(() => {});
      return;
    }
    for (const state of taskStates.values()) {
      await removeWorktree({
        repoRoot,
        worktreePath: state.worktreePath,
        force: true,
        log: (...args) => this.sendLog(args.join(' ')),
      }).catch(err => {
        this.sendLog(`Failed to remove worktree ${state.worktreePath}: ${err.message}`);
      });
      if (state.branch) {
        await git(['branch', '-D', state.branch], {
          cwd: repoRoot,
          log: (...args) => this.sendLog(args.join(' ')),
        }).catch(err => {
          this.sendLog(`Failed to delete branch ${state.branch}: ${err.message}`);
        });
      }
    }
    await removeWorktree({
      repoRoot,
      worktreePath: integrationPath,
      force: true,
      log: (...args) => this.sendLog(args.join(' ')),
    }).catch(err => {
      this.sendLog(`Failed to remove integration worktree: ${err.message}`);
    });
    if (integrationBranch) {
      await git(['branch', '-D', integrationBranch], {
        cwd: repoRoot,
        log: (...args) => this.sendLog(args.join(' ')),
      }).catch(err => {
        this.sendLog(`Failed to delete integration branch ${integrationBranch}: ${err.message}`);
      });
    }
    await rm(runRoot, { recursive: true, force: true }).catch(() => {});
  }

  async #summariseResults(goal, tasks, mergeReport, ff, review, enabled) {
    if (enabled === false) {
      return this.#fallbackSummary(tasks);
    }
    const statusCounts = tasks.reduce((acc, task) => {
      const status = normalizeTaskStatus(task?.status);
      if (status === 'completed') acc.completed += 1;
      else if (status === 'superseded') acc.superseded += 1;
      else if (status === 'failed') acc.failed += 1;
      else if (status === 'blocked') acc.blocked += 1;
      return acc;
    }, {
      completed: 0,
      superseded: 0,
      failed: 0,
      blocked: 0,
    });
    const mergeLine = `Merged: ${mergeReport?.merged?.length ?? 0}, skipped: ${mergeReport?.skipped?.length ?? 0}`;
    const salvage = mergeReport?.salvage;
    const salvageLine = salvage
      ? `Salvage: tasks=${salvage.tasks?.length ?? 0}, files=${salvage.filesCopied ?? 0}${salvage.normalizedFiles ? `, normalized=${salvage.normalizedFiles}` : ''}`
      : '';
    const integrationInfo = mergeReport?.integration;
    const integrationLine = integrationInfo?.empty
      ? 'Integration: empty (no diff from base)'
      : integrationInfo?.hasDiff
        ? `Integration: changed (${integrationInfo.trackedCount ?? 0} tracked)`
        : '';
    const ffLine = ff?.applied ? `Fast-forwarded to ${ff.head}` : `Not applied: ${ff?.reason ?? ''}`;
    const reviewStatus = typeof review?.status === 'string' ? review.status : null;
    const reviewText =
      reviewStatus === 'completed'
        ? typeof review?.output === 'string' && review.output.trim()
          ? `Review:\n${clipText(review.output, 2500)}`
          : 'Review: completed (no output)'
        : reviewStatus === 'failed'
          ? `Review: failed${review?.error ? ` (${clipText(review.error, 400)})` : ''}`
          : reviewStatus === 'skipped'
            ? `Review: skipped${review?.reason ? ` (${clipText(review.reason, 400)})` : ''}`
            : '';
    return [
      `Goal:\n${goal}`,
      `Tasks: ${tasks.length} (completed=${statusCounts.completed}, superseded=${statusCounts.superseded}, failed=${statusCounts.failed}, blocked=${statusCounts.blocked})`,
      mergeLine,
      salvageLine,
      integrationLine,
      ffLine,
      reviewText,
    ].filter(Boolean).join('\n\n');
  }

  #fallbackSummary(tasks) {
    return tasks
      .map(task => {
        const status = task.status ?? 'unknown';
        const detail = task.output ?? task.error ?? '(no details)';
        return `Task ${task.id} [${status}]: ${detail}`;
      })
      .join('\n\n');
  }
}

class CdxAppServerMcpServer {
  constructor({ transportEnabled = true } = {}) {
    this.initialized = false;
    this.framing = 'newline';
    this.transportEnabled = transportEnabled !== false;
    this.latestRunId = null;
    this.runHistory = new Map(); // runId -> runRecord
    this.directToolCalls = new Map(); // id -> { resolve, notifications }
    this.backgroundBackendStartPromise = null;
    this.backgroundBackendRegistry = null;
    this.runJournalPath = RUN_JOURNAL_PATH;
    this.runJournalFlushTimer = null;
    this.runJournalWritePromise = Promise.resolve();
    this.sandboxCwd = null;
    this.stats = new CdxStatsServer({
      log: message =>
        this.#sendNotification('logging/message', { level: 'info', message }),
    });
    this.statsUiProcess = null;
    this.statsUiUrl = null;
    this.statsUiTargetBaseUrl = null;
    this.statsUiStartPromise = null;
    this.statsUiExitHooksInstalled = false;
    this.transportWritable = this.transportEnabled;
    this.transportClosedReason = null;
    this.transportGuardsInstalled = false;
    this.runtimeGuardsInstalled = false;
    this.runtimeFaultLogPath = RUNTIME_LOG_PATH;
    this.runtimeFaultLogPromise = Promise.resolve();
    this.runtimeFaultSerial = 0;
    this.runtimeDegraded = false;
    this.runtimeDegradedReason = null;
    this.runtimeRecoveryPromise = null;
    if (this.transportEnabled) {
      this.#installTransportGuards();
    }
    this.#installRuntimeGuards();
    if (STATS_UI_PROXY_ENABLED) {
      this.#installStatsUiExitHooks();
    }
  }

  async hydratePersistedRunJournal() {
    if (!RUN_JOURNAL_ENABLED) return { loaded: 0, mutated: false, latestRunId: null };

    const journal = await readRunJournal(this.runJournalPath);
    if (!journal || journal.runs.length === 0) {
      return { loaded: 0, mutated: false, latestRunId: null };
    }

    const now = Date.now();
    let mutated = false;
    for (const entry of journal.runs) {
      const runId = coerceString(entry?.runId);
      if (!runId || this.runHistory.has(runId)) continue;

      let status = coerceString(entry?.status) ?? 'unknown';
      let completedAt = entry?.completedAt ?? null;
      let error = entry?.error ?? null;
      let orphanedAt = entry?.orphanedAt ?? null;
      let orphanedReason = entry?.orphanedReason ?? null;
      const resumedFromRunId = coerceString(entry?.resumedFromRunId ?? entry?.snapshot?.resumedFromRunId, 400);
      const resumedIntoRunId = coerceString(entry?.resumedIntoRunId ?? entry?.snapshot?.resumedIntoRunId, 400);
      const snapshot = isObject(entry?.snapshot) ? { ...entry.snapshot } : null;

      if (JOURNAL_ACTIVE_STATUSES.has(status.toLowerCase())) {
        status = ORPHANED_RUN_STATUS;
        completedAt = completedAt ?? now;
        orphanedAt = orphanedAt ?? now;
        orphanedReason = orphanedReason ?? ORPHANED_RUN_REASON;
        error = error ?? orphanedReason;
        if (snapshot) {
          snapshot.status = ORPHANED_RUN_STATUS;
          snapshot.pendingAsks = [];
          snapshot.controller = null;
          snapshot.orphanedAt = orphanedAt;
          snapshot.orphanedReason = orphanedReason;
          snapshot.recoveredFromJournal = true;
          snapshot.resumedFromRunId = resumedFromRunId ?? null;
          snapshot.resumedIntoRunId = resumedIntoRunId ?? null;
        }
        mutated = true;
      } else if (snapshot) {
        snapshot.recoveredFromJournal = true;
        snapshot.resumedFromRunId = resumedFromRunId ?? null;
        snapshot.resumedIntoRunId = resumedIntoRunId ?? null;
      }

      const summary =
        typeof entry?.resultSummary === 'string' && entry.resultSummary.trim()
          ? entry.resultSummary.trim()
          : typeof snapshot?.summary === 'string' && snapshot.summary.trim()
            ? snapshot.summary.trim()
            : null;

      this.runHistory.set(runId, {
        runId,
        status,
        startedAt: entry?.startedAt ?? null,
        completedAt,
        progressToken: entry?.progressToken ?? null,
        input: isObject(entry?.input) ? entry.input : null,
        statsUrl: entry?.statsUrl ?? null,
        result: summary ? { summary } : null,
        error,
        promise: null,
        orchestrator: null,
        durableSnapshot: snapshot,
        recoveredFromJournal: true,
        orphanedAt,
        orphanedReason,
        resumedFromRunId,
        resumedIntoRunId,
      });
    }

    if (this.runHistory.size > 0) {
      const preferredRunId =
        (journal.latestRunId && this.runHistory.has(journal.latestRunId))
          ? journal.latestRunId
          : [...this.runHistory.values()]
            .sort((a, b) => (b?.startedAt ?? 0) - (a?.startedAt ?? 0))
            .map(record => record?.runId)
            .find(Boolean)
          ?? null;
      if (preferredRunId) this.latestRunId = preferredRunId;
    }

    this.#trimRunHistory();
    if (mutated) {
      this.#queueRunJournalFlush({ immediate: true });
    }
    return {
      loaded: this.runHistory.size,
      mutated,
      latestRunId: this.latestRunId,
    };
  }

  #buildPersistedRunJournalRecord(record) {
    const runId = coerceString(record?.runId);
    if (!runId) return null;

    const runState = this.stats.getRunState?.(runId) ?? null;
    const snapshot = this.#snapshotRunStatus({
      runId,
      record,
      runState,
      includeTasks: true,
      includeAgents: false,
      includeAsks: false,
    });
    const resultSummary =
      typeof record?.result?.summary === 'string' && record.result.summary.trim()
        ? record.result.summary.trim()
        : typeof snapshot?.summary === 'string' && snapshot.summary.trim()
          ? snapshot.summary.trim()
          : null;

    return normalizePersistedRunJournalRecord({
      runId,
      status: record?.status ?? snapshot?.status ?? 'unknown',
      startedAt: record?.startedAt ?? null,
      completedAt: record?.completedAt ?? null,
      progressToken: record?.progressToken ?? null,
      statsUrl: record?.statsUrl ?? null,
      input: isObject(record?.input) ? sanitizeRunJournalValue(record.input) : null,
      error: record?.error ?? null,
      resultSummary,
      snapshot: sanitizeRunJournalValue({
        ...snapshot,
        recoveredFromJournal: record?.recoveredFromJournal === true,
        orphanedAt: record?.orphanedAt ?? null,
        orphanedReason: record?.orphanedReason ?? null,
        resumedFromRunId: record?.resumedFromRunId ?? null,
        resumedIntoRunId: record?.resumedIntoRunId ?? null,
      }),
      orphanedAt: record?.orphanedAt ?? null,
      orphanedReason: record?.orphanedReason ?? null,
      resumedFromRunId: record?.resumedFromRunId ?? null,
      resumedIntoRunId: record?.resumedIntoRunId ?? null,
    });
  }

  #buildRunJournalPayload() {
    const runs = [...this.runHistory.values()]
      .map(record => this.#buildPersistedRunJournalRecord(record))
      .filter(Boolean)
      .sort((a, b) => (a?.startedAt ?? 0) - (b?.startedAt ?? 0));
    return {
      latestRunId: this.latestRunId,
      runs,
    };
  }

  async #flushRunJournalNow() {
    if (!RUN_JOURNAL_ENABLED) return null;
    return await writeRunJournal(this.#buildRunJournalPayload(), this.runJournalPath);
  }

  #queueRunJournalFlush({ immediate = false } = {}) {
    if (!RUN_JOURNAL_ENABLED) return;

    const schedule = () => {
      this.runJournalWritePromise = this.runJournalWritePromise
        .catch(() => {})
        .then(() => this.#flushRunJournalNow())
        .catch(() => {});
    };

    if (immediate) {
      if (this.runJournalFlushTimer) {
        clearTimeout(this.runJournalFlushTimer);
        this.runJournalFlushTimer = null;
      }
      schedule();
      return;
    }

    if (this.runJournalFlushTimer) return;
    this.runJournalFlushTimer = setTimeout(() => {
      this.runJournalFlushTimer = null;
      schedule();
    }, RUN_JOURNAL_WRITE_DEBOUNCE_MS);
    this.runJournalFlushTimer.unref?.();
  }

  async callToolDirect(name, args) {
    const id = `direct:${randomUUID()}`;
    return await new Promise((resolve, reject) => {
      this.directToolCalls.set(id, {
        resolve,
        reject,
        notifications: [],
      });
      this.#onToolsCall(id, { name, arguments: args })
        .catch(error => {
          if (!this.directToolCalls.has(id)) return;
          this.directToolCalls.delete(id);
          reject(error);
        });
    });
  }

  async handleMessage(message) {
    if (!message || typeof message !== 'object') return;

    if (!Object.hasOwn(message, 'method')) return;

    if (Object.hasOwn(message, 'id')) {
      await this.#handleRequest(message);
      return;
    }

    await this.#handleNotification(message);
  }

  async #handleNotification(notification) {
    const { method, params } = notification ?? {};
    if (!method) return;

    switch (method) {
      case 'codex/sandbox-state/update':
        this.#onSandboxStateUpdate(params);
        break;
      default:
        break;
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
  }

  #installTransportGuards() {
    if (this.transportGuardsInstalled) return;
    this.transportGuardsInstalled = true;

    const markClosed = error => {
      if (!this.transportWritable) return;
      this.transportWritable = false;
      this.transportClosedReason =
        error instanceof Error
          ? error.code ?? error.message ?? 'transport_closed'
          : String(error ?? 'transport_closed');
      void this.#recordRuntimeFault('transport.closed', error, {
        reason: this.transportClosedReason,
      });
    };

    const onTransportError = error => {
      markClosed(error);
    };

    process.stdout.on('error', onTransportError);
    process.stdout.on('close', () => markClosed('stdout_closed'));
    process.stdout.on('finish', () => markClosed('stdout_finished'));
    process.stdin.on('end', () => markClosed('stdin_ended'));
    process.stdin.on('close', () => markClosed('stdin_closed'));
  }

  #installRuntimeGuards() {
    if (this.runtimeGuardsInstalled) return;
    this.runtimeGuardsInstalled = true;

    process.on('unhandledRejection', reason => {
      void this.#recordRuntimeFault('process.unhandledRejection', reason);
    });

    process.on('uncaughtException', error => {
      void this.#recordRuntimeFault('process.uncaughtException', error);
    });
  }

  #activeRuntimeLogRunIds() {
	    const running = [...this.runHistory.values()]
      .filter(record => ['running', 'disposing', 'merging'].includes(String(record?.status ?? '').trim()))
      .map(record => (typeof record?.runId === 'string' ? record.runId.trim() : ''))
      .filter(Boolean);
    if (running.length > 0) return uniqueList(running);
    return this.latestRunId ? [this.latestRunId] : [];
  }

  #normalizeRuntimeError(error) {
    if (error instanceof Error) {
      return {
        name: error.name || 'Error',
        message: error.message || 'Unknown error',
        stack: typeof error.stack === 'string' ? error.stack : '',
        code: error.code ?? null,
      };
    }
    return {
      name: 'NonError',
      message: String(error ?? 'Unknown error'),
      stack: '',
      code: null,
    };
  }

  #isRecoverableRuntimeFault(kind, details) {
    const normalizedKind = String(kind ?? '').trim().toLowerCase();
    const code = String(details?.code ?? '').trim().toUpperCase();
    if (normalizedKind.startsWith('transport.')) return true;
    if (normalizedKind === 'reader.protocol') return true;
    if (['EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED'].includes(code)) return true;
    return false;
  }

  #markRuntimeDegraded(kind, details) {
    if (this.runtimeDegraded) return;
    if (this.#isRecoverableRuntimeFault(kind, details)) return;
    this.runtimeDegraded = true;
    this.runtimeDegradedReason = `[runtime] ${kind}: ${details.name}: ${details.message}`;
  }

  #quarantineActiveRunsFromFault(reason) {
    const now = Date.now();
    const message = clipText(String(reason ?? 'runtime fault'), 400) || 'runtime fault';
    let mutated = false;
    for (const record of this.runHistory.values()) {
      const status = String(record?.status ?? '').trim().toLowerCase();
      if (!['running', 'disposing', 'merging'].includes(status)) continue;
      record.status = 'failed';
      record.error = message;
      record.completedAt = now;
      mutated = true;
      try {
        this.stats.recordEvent({
          type: 'run.completed',
          runId: record.runId,
          status: 'failed',
          error: message,
        });
      } catch {}
      try {
        this.stats.recordLog({ agentId: 'server', text: `[runtime] quarantined run ${record.runId}: ${message}` }, record.runId);
      } catch {}
    }
    if (mutated) this.#queueRunJournalFlush({ immediate: true });
  }

  async #attemptRuntimeRecovery(trigger = 'tool') {
    if (!this.runtimeDegraded) return true;
    if (this.runtimeRecoveryPromise) {
      return await this.runtimeRecoveryPromise;
    }

    this.runtimeRecoveryPromise = (async () => {
      try {
        await this.#stopStatsUiProcess().catch(() => {});
        this.statsUiStartPromise = null;
        this.statsUiUrl = null;
        this.statsUiTargetBaseUrl = null;

        const baseUrl = await this.stats.ensureStarted({ autoOpen: false });
        if (!baseUrl) {
          throw new Error('stats server unavailable during runtime recovery');
        }

        const previousReason = this.runtimeDegradedReason;
        this.runtimeDegraded = false;
        this.runtimeDegradedReason = null;

        const recoveryLine =
          `[runtime] recovered before ${trigger}`
          + (previousReason ? ` (${clipText(previousReason, 240)})` : '');
        try {
          this.stats.recordLog({ agentId: 'server', text: recoveryLine }, this.latestRunId ?? null);
        } catch {}
        if (this.transportWritable) {
          this.#sendNotification('logging/message', {
            level: 'info',
            message: recoveryLine,
          });
        }
        await this.#appendRuntimeFaultLine(`${new Date().toISOString()} ${recoveryLine}\n\n`);
        return true;
      } catch (error) {
        const details = this.#normalizeRuntimeError(error);
        const failureLine = `[runtime] recovery failed before ${trigger}: ${details.name}: ${details.message}`;
        try {
          this.stats.recordLog({ agentId: 'server', text: failureLine }, this.latestRunId ?? null);
        } catch {}
        if (this.transportWritable) {
          this.#sendNotification('logging/message', {
            level: 'warn',
            message: failureLine,
          });
        }
        const lines = [
          `${new Date().toISOString()} ${failureLine}`,
          details.code ? `code=${details.code}` : '',
          details.stack ? clipText(details.stack, 12000) : '',
          '',
        ].filter(Boolean);
        await this.#appendRuntimeFaultLine(`${lines.join('\n')}\n`);
        return false;
      } finally {
        this.runtimeRecoveryPromise = null;
      }
    })();

    return await this.runtimeRecoveryPromise;
  }

  async #waitForRuntimeRecovery(trigger = 'run') {
    if (!this.runtimeDegraded && !this.runtimeRecoveryPromise) return true;
    const recovered = await this.#attemptRuntimeRecovery(trigger);
    if (recovered) return true;

    const warningLine =
      `[runtime] recovery before ${trigger} did not complete cleanly; continuing with fresh run state and watchdog-based task recovery.`;
    try {
      this.stats.recordLog({ agentId: 'server', text: warningLine }, this.latestRunId ?? null);
    } catch {}
    if (this.transportWritable) {
      this.#sendNotification('logging/message', {
        level: 'warn',
        message: warningLine,
      });
    }
    await this.#appendRuntimeFaultLine(`${new Date().toISOString()} ${warningLine}\n\n`);
    return false;
  }

  async #appendRuntimeFaultLine(line) {
    const targetPath = this.runtimeFaultLogPath;
    if (!targetPath) return;
    this.runtimeFaultLogPromise = this.runtimeFaultLogPromise
      .catch(() => {})
      .then(async () => {
        await mkdir(path.dirname(targetPath), { recursive: true });
        await appendFile(targetPath, line, 'utf8');
      })
      .catch(() => {});
    await this.runtimeFaultLogPromise;
  }

  async #recordRuntimeFault(kind, error, context = null) {
    const details = this.#normalizeRuntimeError(error);
    this.#markRuntimeDegraded(kind, details);
    if (this.runtimeDegraded) {
      this.#quarantineActiveRunsFromFault(`[runtime] ${kind}: ${details.message}`);
    }
    const timestamp = new Date().toISOString();
    const faultId = ++this.runtimeFaultSerial;
    const contextJson = context && Object.keys(context).length > 0 ? JSON.stringify(context) : '';
    const firstLine = `[runtime:${faultId}] ${kind}: ${details.name}: ${details.message}`;
    const lines = [
      `${timestamp} ${firstLine}`,
      details.code ? `code=${details.code}` : '',
      contextJson ? `context=${contextJson}` : '',
      details.stack ? clipText(details.stack, 12000) : '',
      '',
    ].filter(Boolean);
    const payload = lines.join('\n');

    for (const runId of this.#activeRuntimeLogRunIds()) {
      try {
        this.stats.recordLog({ agentId: 'server', text: firstLine }, runId);
      } catch {}
    }
    try {
      this.stats.recordLog({ agentId: 'server', text: firstLine }, null);
    } catch {}

    if (this.transportWritable) {
      this.#sendNotification('logging/message', {
        level: 'warn',
        message: firstLine,
      });
    }

    await this.#appendRuntimeFaultLine(`${payload}\n`);

    if (this.runtimeDegraded) {
      void this.#attemptRuntimeRecovery(kind);
    }
  }

  handleReaderProtocolError(error, context) {
    void this.#recordRuntimeFault('reader.protocol', error, isObject(context) ? context : null);
  }

  #writeTransport(payload) {
    if (!this.transportEnabled) return false;
    if (!this.transportWritable) return false;
    if (process.stdout.destroyed || process.stdout.writableEnded) {
      this.transportWritable = false;
      this.transportClosedReason = this.transportClosedReason ?? 'stdout_unavailable';
      return false;
    }
    try {
      writeLspMessage(process.stdout, payload, { framing: this.framing });
      return true;
    } catch (error) {
      this.transportWritable = false;
      this.transportClosedReason =
        error instanceof Error
          ? error.code ?? error.message ?? 'transport_write_failed'
          : String(error ?? 'transport_write_failed');
      return false;
    }
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
          this.#sendResponse(id, { tools: this.#toolDescriptors() });
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
      this.#sendNotification('logging/message', {
        level: 'info',
        message: `Client connected: ${params.clientInfo.name}`,
      });
    }
    this.#sendResponse(id, result);
  }

	  async #onToolsCall(id, params) {
    if (!isObject(params)) {
      this.#sendError(id, -32602, 'tools/call expects object params');
      return;
    }
    const { name, arguments: args } = params;

    if (
      (this.runtimeDegraded || this.runtimeRecoveryPromise)
      && (name === 'cdx' || name === 'spawn' || name === 'cdx.spawn' || name === 'run' || name === 'cdx.run')
    ) {
      await this.#waitForRuntimeRecovery(String(name ?? 'tool'));
    }

    if (name === 'cdx' || name === 'spawn' || name === 'cdx.spawn') {
      await this.#onCdxSpawn(id, args);
      return;
    }

    if (name === 'run' || name === 'cdx.run') {
      await this.#onCdxRun(id, args);
      return;
    }

    if (name === 'resume' || name === 'cdx_resume' || name === 'cdx.resume') {
      await this.#onCdxResume(id, args);
      return;
    }

    if (name === 'help' || name === 'cdx.help') {
      await this.#onCdxHelp(id, args);
      return;
    }

    if (name === 'ps' || name === 'cdx.ps') {
      await this.#onCdxPs(id, args);
      return;
    }

    if (name === 'rollback' || name === 'cdx_rollback' || name === 'cdx.rollback') {
      await this.#onCdxRollback(id, args);
      return;
    }

    if (name === 'thread_fork' || name === 'cdx_thread_fork' || name === 'cdx.thread_fork') {
      await this.#onCdxThreadFork(id, args);
      return;
    }

    if (name === 'requirements' || name === 'cdx_requirements' || name === 'cdx.requirements') {
      await this.#onCdxRequirements(id, args);
      return;
    }

    if (name === 'metrics' || name === 'cdx_metrics' || name === 'cdx.metrics') {
      await this.#onCdxMetrics(id, args);
      return;
    }

    if (name === 'webui' || name === 'cdx.webui') {
      await this.#onCdxWebui(id, args);
      return;
    }

    if (
      name === 'stats_test' ||
      name === 'stats.test' ||
      name === 'cdx_stats_test' ||
      name === 'cdx.stats.test'
    ) {
      await this.#onCdxStatsTest(id, args);
      return;
    }

    if (name === 'pending_asks' || name === 'cdx_pending_asks' || name === 'cdx.pending_asks') {
      await this.#onCdxPendingAsks(id, args);
      return;
    }

    if (name === 'router_answer' || name === 'cdx_router_answer' || name === 'cdx.router_answer') {
      await this.#onCdxRouterAnswer(id, args);
      return;
    }

    if (name === 'agent_message' || name === 'cdx_agent_message' || name === 'cdx.agent_message') {
      await this.#onCdxAgentMessage(id, args);
      return;
    }

    if (name === 'steer' || name === 'cdx_steer' || name === 'cdx.steer') {
      await this.#onCdxSteer(id, args);
      return;
    }

    if (name === 'agent_inbox' || name === 'cdx_agent_inbox' || name === 'cdx.agent_inbox') {
      await this.#onCdxAgentInbox(id, args);
      return;
    }

    if (
      name === 'task_abort' ||
      name === 'abort_task' ||
      name === 'cdx.task_abort' ||
      name === 'cdx.abort_task'
    ) {
      await this.#onCdxTaskAbort(id, args);
      return;
    }

    if (name === 'config' || name === 'cdx_config' || name === 'cdx.config') {
      await this.#onCdxConfig(id, args);
      return;
    }

    if (name === 'logs' || name === 'cdx.logs') {
      await this.#onCdxLogs(id, args);
      return;
    }

    if (name === 'status' || name === 'cdx.status') {
      await this.#onCdxStatus(id, args);
      return;
    }

    this.#sendError(id, -32601, `Unknown tool: ${name}`);
  }

  #trimRunHistory() {
    const entries = [...this.runHistory.entries()];
    if (entries.length <= MAX_RUN_HISTORY) return;

    const activeStatuses = new Set(['running', 'disposing', 'merging']);
    const removable = entries
      .filter(([, record]) => !activeStatuses.has(String(record?.status ?? '').trim().toLowerCase()))
      .sort((a, b) => (a[1]?.startedAt ?? 0) - (b[1]?.startedAt ?? 0));
    const overflow = Math.max(0, entries.length - MAX_RUN_HISTORY);
    const removeCount = Math.min(overflow, removable.length);
    let removed = 0;
    for (let i = 0; i < removeCount; i += 1) {
      this.runHistory.delete(removable[i][0]);
      removed += 1;
    }
    if (removed > 0) this.#queueRunJournalFlush();
  }

  #normalizeLogPayload(message) {
    if (isObject(message)) {
      const text =
        typeof message.text === 'string'
          ? message.text
          : typeof message.message === 'string'
            ? message.message
            : String(message.text ?? message.message ?? '');
      const agentId = typeof message.agentId === 'string' ? message.agentId.trim() : '';
      return { text, stream: message.stream === true, agentId: agentId || null };
    }
    return { text: String(message ?? ''), stream: false, agentId: null };
  }

  #decorateLogMessage(runId, message) {
    const text = String(message ?? '');
    if (!runId) return text;
    const match = text.match(/^\[([^\]]+)\]\s*(.*)$/);
    if (match) {
      return `[${match[1]}] (${runId}) ${match[2] ?? ''}`.trimEnd();
    }
    return `(${runId}) ${text}`.trimEnd();
  }

  #reserveRunId(desiredRunId) {
    const base = slugify(desiredRunId, `cdx-${Date.now()}`);
    if (!this.runHistory.has(base)) return base;
    for (let i = 0; i < 20; i += 1) {
      const candidate = slugify(`${base}-${randomUUID().slice(0, 8)}`, `${base}-${Date.now()}`);
      if (!this.runHistory.has(candidate)) return candidate;
    }
    return slugify(`${base}-${Date.now()}`, `${base}-${Date.now()}`);
  }

  #statsUrlForRun(statsBaseUrl, runId) {
    if (!statsBaseUrl || !runId) return statsBaseUrl ?? null;
    const base = String(statsBaseUrl);
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}runId=${encodeURIComponent(runId)}`;
  }

  #installStatsUiExitHooks() {
    if (this.statsUiExitHooksInstalled) return;
    this.statsUiExitHooksInstalled = true;

    const killChild = () => {
      const child = this.statsUiProcess;
      if (!child || child.killed || child.exitCode !== null) return;
      try {
        child.kill('SIGTERM');
      } catch {}
    };

    process.once('exit', killChild);
    process.once('SIGINT', () => {
      killChild();
      process.exit(130);
    });
    process.once('SIGTERM', () => {
      killChild();
      process.exit(0);
    });
  }

  async #stopStatsUiProcess() {
    const child = this.statsUiProcess;
    this.statsUiProcess = null;
    this.statsUiUrl = null;
    this.statsUiTargetBaseUrl = null;

    if (!child || child.exitCode !== null || child.killed) return;

    await new Promise(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
        finish();
      }, STATS_UI_STOP_TIMEOUT_MS);
      timeout.unref?.();

      child.once('exit', finish);
      try {
        child.kill('SIGTERM');
      } catch {
        finish();
      }
    });
  }

  async #ensureStatsUiStarted(apiBaseUrl) {
    const targetBaseUrl = typeof apiBaseUrl === 'string' ? apiBaseUrl.trim() : '';
    if (!targetBaseUrl) return null;

    const existing = this.statsUiProcess;
    if (
      existing
      && existing.exitCode === null
      && !existing.killed
      && this.statsUiTargetBaseUrl === targetBaseUrl
      && this.statsUiUrl
    ) {
      return this.statsUiUrl;
    }

    if (this.statsUiStartPromise) {
      return await this.statsUiStartPromise;
    }

    if (existing) {
      await this.#stopStatsUiProcess();
    }

    this.statsUiStartPromise = new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        CDX_STATS_UI_TARGET: targetBaseUrl,
        CDX_STATS_UI_HOST: process.env.CDX_STATS_UI_HOST ?? '127.0.0.1',
        CDX_STATS_UI_PORT: process.env.CDX_STATS_UI_PORT ?? '0',
      };
      const child = spawn(STATS_UI_SERVER_COMMAND, [STATS_UI_SERVER_ENTRY], {
        cwd: process.cwd(),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.statsUiProcess = child;
      this.statsUiUrl = null;
      this.statsUiTargetBaseUrl = targetBaseUrl;

      let stdoutBuffer = '';
      let stderrBuffer = '';
      let settled = false;

      const finishResolve = value => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      };
      const finishReject = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };
      const flushStderrLines = force => {
        const normalized = stderrBuffer.replace(/\r/g, '');
        const parts = normalized.split('\n');
        stderrBuffer = force ? '' : (parts.pop() ?? '');
        for (const line of parts) {
          const message = line.trim();
          if (!message) continue;
          this.#sendNotification('logging/message', {
            level: 'warn',
            message: `[stats-ui] ${message}`,
          });
        }
      };
      const timeout = setTimeout(() => {
        if (settled) return;
        try {
          child.kill('SIGTERM');
        } catch {}
        finishReject(new Error(`Stats UI process did not report a URL within ${STATS_UI_START_TIMEOUT_MS}ms`));
      }, STATS_UI_START_TIMEOUT_MS);
      timeout.unref?.();

      child.stdout.on('data', chunk => {
        stdoutBuffer += String(chunk ?? '');
        const parts = stdoutBuffer.split('\n');
        stdoutBuffer = parts.pop() ?? '';
        for (const rawLine of parts) {
          const line = rawLine.trim();
          if (!line) continue;
          if (line.startsWith('CDX_STATS_UI_URL=')) {
            const uiUrl = line.slice('CDX_STATS_UI_URL='.length).trim();
            this.statsUiUrl = uiUrl || null;
            finishResolve(this.statsUiUrl);
            continue;
          }
          this.#sendNotification('logging/message', {
            level: 'info',
            message: `[stats-ui] ${line}`,
          });
        }
      });

      child.stderr.on('data', chunk => {
        stderrBuffer += String(chunk ?? '');
        flushStderrLines(false);
      });

      child.once('error', err => {
        finishReject(err instanceof Error ? err : new Error(String(err ?? 'stats_ui_spawn_failed')));
      });

      child.once('exit', (code, signal) => {
        flushStderrLines(true);
        if (this.statsUiProcess === child) {
          this.statsUiProcess = null;
          this.statsUiUrl = null;
          this.statsUiTargetBaseUrl = null;
        }
        if (!settled) {
          const detail = signal ? `signal ${signal}` : `code ${code ?? 0}`;
          finishReject(new Error(`Stats UI process exited before startup (${detail})`));
        }
      });
    });

    try {
      return await this.statsUiStartPromise;
    } finally {
      this.statsUiStartPromise = null;
    }
  }

  async #ensureStatsDashboardBaseUrl() {
    const apiBaseUrl = await this.stats.ensureStarted({ autoOpen: false });
    if (!apiBaseUrl) return null;
    if (!STATS_UI_PROXY_ENABLED) {
      if (this.statsUiProcess) {
        await this.#stopStatsUiProcess().catch(() => {});
      }
      this.statsUiUrl = null;
      this.statsUiTargetBaseUrl = null;
      return apiBaseUrl;
    }
    try {
      return await this.#ensureStatsUiStarted(apiBaseUrl);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? 'stats_ui_failed');
      this.#sendNotification('logging/message', {
        level: 'warn',
        message: `Stats UI process failed; using stats server URL directly: ${message}`,
      });
      return apiBaseUrl;
    }
  }

  async #ensureBackgroundBackendAvailable({ autoStart = true } = {}) {
    if (!BACKGROUND_BACKEND_ENABLED || IS_BACKGROUND_BACKEND_PROCESS) return null;

    const candidates = [
      normalizeBackgroundBackendRegistry(this.backgroundBackendRegistry),
      await readBackgroundBackendRegistry(),
    ].filter(Boolean);

    for (const candidate of candidates) {
      const reachable = await probeTcpEndpoint({
        host: candidate.host,
        port: candidate.port,
        timeoutMs: LOCAL_MCP_PROBE_TIMEOUT_MS,
      });
      if (reachable) {
        this.backgroundBackendRegistry = candidate;
        return candidate;
      }
    }

    this.backgroundBackendRegistry = null;
    if (!autoStart) return null;

    if (this.backgroundBackendStartPromise) {
      return await this.backgroundBackendStartPromise;
    }

    this.backgroundBackendStartPromise = (async () => {
      const child = spawn(process.execPath, [THIS_ENTRY], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CDX_RUN_BACKEND_MODE: 'http',
          CDX_RUN_BACKEND_HOST: BACKGROUND_BACKEND_HOST,
          CDX_RUN_BACKEND_PORT: String(BACKGROUND_BACKEND_PORT),
          CDX_RUN_BACKEND_REGISTRY_PATH: BACKGROUND_BACKEND_REGISTRY_PATH,
        },
        stdio: ['ignore', 'ignore', 'ignore'],
        detached: true,
      });
      child.unref();

      const registry = await waitForBackgroundBackendRegistry({
        registryPath: BACKGROUND_BACKEND_REGISTRY_PATH,
        timeoutMs: BACKGROUND_BACKEND_START_TIMEOUT_MS,
      });
      if (!registry) {
        throw new Error(`Timed out waiting for detached CDX backend (${BACKGROUND_BACKEND_REGISTRY_PATH})`);
      }
      this.backgroundBackendRegistry = registry;
      return registry;
    })().finally(() => {
      this.backgroundBackendStartPromise = null;
    });

    return await this.backgroundBackendStartPromise;
  }

  async #proxyBackgroundToolCall(name, args, { autoStart = true } = {}) {
    if (!BACKGROUND_BACKEND_ENABLED || IS_BACKGROUND_BACKEND_PROCESS) return null;

    let registry = await this.#ensureBackgroundBackendAvailable({ autoStart });
    if (!registry) return null;

    const invoke = async target => {
      const url = new URL('/tools/call', target.url);
      return await fetchBackgroundBackendJson(url, {
        name,
        args: isObject(args) ? args : args ?? null,
      });
    };

    try {
      return await invoke(registry);
    } catch (error) {
      this.backgroundBackendRegistry = null;
      if (!autoStart) return null;
      registry = await this.#ensureBackgroundBackendAvailable({ autoStart: true });
      if (!registry) throw error;
      return await invoke(registry);
    }
  }

  #applyBackgroundProxyRunTracking(result, { promptHint = null, captureSpawnGuard = false } = {}) {
    const structured = isObject(result?.structured_content) ? result.structured_content : {};
    const runId = coerceString(structured.runId);
    const statsUrl = coerceString(structured.statsUrl);
    if (runId) {
      this.latestRunId = runId;
    }
    if (captureSpawnGuard && runId) {
      this.spawnGuard = {
        runId,
        prompt: typeof promptHint === 'string' ? promptHint : null,
        createdAt: Date.now(),
        statsUrl,
      };
    }
  }

  async #proxyBackgroundToolResponse(id, name, args, options = {}) {
    const proxied = await this.#proxyBackgroundToolCall(name, args, {
      autoStart: options.autoStart !== false,
    });
    if (!proxied) return false;
    if (proxied.ok === true) {
      this.#applyBackgroundProxyRunTracking(proxied.result, {
        promptHint: options.promptHint ?? null,
        captureSpawnGuard: options.captureSpawnGuard === true,
      });
      this.#sendResponse(id, proxied.result);
      return true;
    }
    const code = Number.isFinite(proxied?.error?.code) ? proxied.error.code : -32603;
    const message = coerceString(proxied?.error?.message) ?? 'background backend error';
    this.#sendError(id, code, message);
    return true;
  }

	  async #onCdxRun(id, args) {
	    const orchestratorInput = this.#normaliseArguments(args);
    const checklistClarification = collectChecklistClarifications(orchestratorInput, {
      maxTargets: MAX_TOTAL_TASKS,
      maxItems: MAX_TOTAL_TASKS,
      maxQuestions: 3,
    });
    if (checklistClarification) {
      this.#sendChecklistClarificationResponse(id, checklistClarification);
      return;
    }

    const backgroundCandidate =
      args?.background
      ?? args?.backgroundMode
      ?? args?.background_mode
      ?? args?.detached
      ?? args?.detach
      ?? args?.async
      ?? args?.returnImmediately
      ?? args?.return_immediately;
    let background = null;
    if (backgroundCandidate !== undefined) {
      const coerced = coerceBoolean(backgroundCandidate);
      if (coerced === null) {
        this.#sendError(
          id,
          -32602,
          `Unsupported background value: ${String(backgroundCandidate)}. Expected boolean.`,
        );
        return;
      }
      background = coerced;
    } else {
      const envCoerced = coerceBoolean(process.env.CDX_RUN_BACKGROUND);
      if (envCoerced !== null) background = envCoerced;
    }

    const backgroundJobCandidate =
      args?.backgroundJob
      ?? args?.background_job
      ?? args?.backgroundJobMode
      ?? args?.background_job_mode
      ?? args?.__backgroundJob;
    let backgroundJob = false;
    if (backgroundJobCandidate !== undefined) {
      const coerced = coerceBoolean(backgroundJobCandidate);
      if (coerced === null) {
        this.#sendError(
          id,
          -32602,
          `Unsupported backgroundJob value: ${String(backgroundJobCandidate)}. Expected boolean.`,
        );
        return;
      }
      backgroundJob = coerced;
    }
    if (background !== true) {
      backgroundJob = false;
    }

	    const statusSnapshotRequested = args?.__statusSnapshot === true;
	    const resumedFromRunId =
	      typeof args?.resumedFromRunId === 'string' && args.resumedFromRunId.trim()
	        ? args.resumedFromRunId.trim()
	        : typeof args?.resumed_from_run_id === 'string' && args.resumed_from_run_id.trim()
	          ? args.resumed_from_run_id.trim()
	          : null;

	    if (
	      BACKGROUND_BACKEND_ENABLED
      && !IS_BACKGROUND_BACKEND_PROCESS
      && background === true
      && backgroundJob === true
    ) {
      const proxyArgs = {
        ...orchestratorInput,
        background: true,
        backgroundJob: false,
      };
      if (statusSnapshotRequested) proxyArgs.__statusSnapshot = true;
      const proxied = await this.#proxyBackgroundToolResponse(id, 'cdx.run', proxyArgs, {
        autoStart: true,
      });
      if (proxied) return;
    }

    const desiredRunId =
      typeof args?.runId === 'string' && args.runId.trim()
        ? args.runId.trim()
        : typeof args?.run_id === 'string' && args.run_id.trim()
          ? args.run_id.trim()
          : String(process.env.CDX_RUN_ID ?? '').trim()
            ? String(process.env.CDX_RUN_ID ?? '').trim()
            : `cdx-${new Date().toISOString()}-${randomUUID()}`;

    const runId = this.#reserveRunId(desiredRunId);
    orchestratorInput.runId = runId;

    const progressToken = randomUUID();
    this.#sendProgress(progressToken, 0, `cdx run started (runId=${runId})`);

    const runRecord = {
      runId,
      status: 'running',
      startedAt: Date.now(),
      completedAt: null,
      progressToken,
      input: orchestratorInput,
      statsUrl: null,
      result: null,
      error: null,
      promise: null,
      orchestrator: null,
	      durableSnapshot: null,
	      recoveredFromJournal: false,
	      orphanedAt: null,
	      orphanedReason: null,
	      resumedFromRunId,
	      resumedIntoRunId: null,
	    };
    this.latestRunId = runId;
    this.runHistory.set(runId, runRecord);
    this.#trimRunHistory();
    this.#queueRunJournalFlush({ immediate: true });

    if (this.stats.url || this.statsUiUrl) {
      runRecord.statsUrl = this.#statsUrlForRun(this.stats.url ?? this.statsUiUrl, runId);
    }

    const startRun = async () => {
      try {
        const dashboardBaseUrl = await this.#ensureStatsDashboardBaseUrl();
        runRecord.statsUrl = this.#statsUrlForRun(dashboardBaseUrl, runId);
        this.#queueRunJournalFlush();

        if (runRecord.statsUrl && this.stats.autoOpen) {
          const ok = await this.stats.openUrl(runRecord.statsUrl);
          if (!ok) {
            this.#sendNotification('logging/message', {
              level: 'warn',
              message: `Stats UI auto-open failed. Open manually: ${runRecord.statsUrl}`,
            });
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err ?? 'unknown error');
        this.#sendNotification('logging/message', {
          level: 'warn',
          message: `Stats UI failed to start: ${message}`,
        });
      }

      runRecord.orchestrator = new AppServerCdxOrchestrator({
        sendLog: message => {
          const payload = this.#normalizeLogPayload(message);
          this.stats.recordLog(payload, runId);
          const notificationText =
            typeof message === 'string'
              ? message
              : payload.agentId
                ? `[${payload.agentId}] ${payload.text}`
                : payload.text;
          this.#sendNotification('logging/message', {
            level: 'info',
            message: this.#decorateLogMessage(runId, notificationText),
          });
        },
        sendProgress: payload => {
          if (!payload) return;
          const progressValue = Number.isFinite(payload.progress) ? payload.progress : 0;
          this.#sendProgress(progressToken, progressValue, payload.message, payload.total);
        },
        sendEvent: payload => {
          this.stats.recordEvent(payload);
          this.#queueRunJournalFlush();
          if (!EVENT_STREAM) return;
          this.#sendNotification('cdx/event', payload);
        },
        sandboxCwd: this.sandboxCwd,
      });

      runRecord.promise = runRecord.orchestrator
        .run(orchestratorInput)
        .then(result => {
          const resultStatus = typeof result?.status === 'string' ? result.status : 'completed';
          runRecord.status = resultStatus;
          runRecord.result = result;
          runRecord.error = result?.error ?? null;
          const message = resultStatus === 'completed'
            ? 'cdx run completed'
            : `cdx run ${resultStatus}`;
          this.#sendProgress(progressToken, 1, message);
        })
        .catch(err => {
          const message = err instanceof Error ? err.message : String(err ?? 'Unknown error');
          runRecord.status = 'failed';
          runRecord.error = message;
          if (typeof runRecord.orchestrator?.sendLog === 'function') {
            runRecord.orchestrator.sendLog(`[run] failed: ${message}`);
          }
          this.#sendProgress(progressToken, 1, `cdx run failed: ${message}`);
        })
        .finally(() => {
          runRecord.completedAt = Date.now();
          this.#queueRunJournalFlush({ immediate: true });
        });
    };

    const startRunSafely = () =>
      startRun().catch(err => {
        const message = err instanceof Error ? err.message : String(err ?? 'Unknown error');
        runRecord.status = 'failed';
        runRecord.error = message;
        runRecord.completedAt = Date.now();
        this.#sendProgress(progressToken, 1, `cdx run failed: ${message}`);
      });

    if (backgroundJob) {
      setImmediate(() => {
        void startRunSafely();
      });
    } else {
      await startRunSafely();
    }

    if (background) {
      const statsLine = runRecord.statsUrl
        ? `Stats: ${runRecord.statsUrl}`
        : this.stats.enabled
          ? 'Stats: (starting)'
          : 'Stats: (disabled)';
      if (statusSnapshotRequested) {
        const runState = this.stats.getRunState?.(runId) ?? null;
        const snapshot = this.#snapshotRunStatus({
          runId,
          record: runRecord,
          runState,
          includeTasks: true,
          includeAgents: false,
          includeAsks: true,
        });
        const text = `${snapshot.message} ${statsLine} ${formatRunControllerText({
          runId,
          background: true,
          hasPendingAsk: Array.isArray(snapshot.pendingAsks) && snapshot.pendingAsks.length > 0,
        })}`;
        this.#sendResponse(id, {
          content: [{ type: 'text', text }],
          structured_content: {
            runId,
            status: snapshot.status,
            phase: snapshot.phase,
            statsUrl: runRecord.statsUrl,
            progressToken,
            background: true,
            elapsedMs: snapshot.elapsedMs,
            etaMs: snapshot.etaMs,
            counts: snapshot.counts,
            summary: snapshot.summary,
            tasks: snapshot.tasks,
            checklist: snapshot.checklist,
            taskIdsByStatus: snapshot.taskIdsByStatus,
            agents: snapshot.agents,
	            pendingAsks: snapshot.pendingAsks,
	            recoveredFromJournal: snapshot.recoveredFromJournal,
	            orphanedAt: snapshot.orphanedAt,
	            orphanedReason: snapshot.orphanedReason,
	            resumedFromRunId: snapshot.resumedFromRunId,
	            resumedIntoRunId: snapshot.resumedIntoRunId,
	            resume: snapshot.resume,
	            controller: buildRunControllerGuidance({
	              runId,
	              background: true,
              hasPendingAsk: Array.isArray(snapshot.pendingAsks) && snapshot.pendingAsks.length > 0,
              askId: Array.isArray(snapshot.pendingAsks)
                ? snapshot.pendingAsks
                  .map(entry => (typeof entry?.askId === 'string' ? entry.askId.trim() : ''))
                  .find(Boolean)
                : null,
            }),
          },
        });
        return;
      }
      this.#sendResponse(id, {
        content: [
          {
            type: 'text',
            text:
              `cdx run started: ${runId} (background). `
              + `Use cdx.status to check progress (includes task lists). `
              + `${statsLine} `
              + formatRunControllerText({ runId, background: true }),
          },
        ],
        structured_content: {
          runId,
          status: runRecord.status,
          statsUrl: runRecord.statsUrl,
          progressToken,
          background: true,
          controller: buildRunControllerGuidance({ runId, background: true }),
        },
      });
      return;
    }

    const waitResult = await waitForRunCompletionOrAsk({
      promise: runRecord.promise,
      orchestrator: runRecord.orchestrator,
      timeoutMs: TOOL_CALL_MAX_WAIT_MS,
      pollMs: 200,
    });

    if (waitResult?.type === 'done') {
      if (runRecord.status === 'completed' && runRecord.result) {
        this.#sendResponse(id, {
          content: [{ type: 'text', text: runRecord.result.summary }],
          structured_content: runRecord.result,
        });
        return;
      }
      const message = runRecord.error ?? 'Unknown error';
      this.#sendResponse(id, {
        is_error: true,
        content: [{ type: 'text', text: `cdx failed: ${message}` }],
      });
      return;
    }

    if (waitResult?.type === 'ask') {
      const pending =
        Array.isArray(waitResult.pendingAsks) ? waitResult.pendingAsks : [];
      const first = pending[0] ?? null;
      const optionIds = Array.isArray(first?.options)
        ? first.options
          .map(opt => (typeof opt?.id === 'string' ? opt.id.trim() : ''))
          .filter(Boolean)
          .join('|')
        : '';
      const defaultOptionId = Array.isArray(first?.options)
        ? first.options
          .map(opt => (typeof opt?.id === 'string' ? opt.id.trim() : ''))
          .find(Boolean)
        : null;
      const questionPreview = first?.question ? clipText(first.question, 600) : '';
      const askLine = first?.askId ? `Pending ask: ${first.askId}` : 'Pending ask: (unknown)';
      const hint = first?.askId
        ? `Answer with cdx.router_answer { runId: "${runId}", askId: "${first.askId}", response: "${defaultOptionId || 'stash'}" }`
        : 'Answer with cdx.router_answer to continue.';

      const statsLine = runRecord.statsUrl ? `Stats: ${runRecord.statsUrl}` : 'Stats: (disabled)';
      this.#sendResponse(id, {
        content: [
          {
            type: 'text',
            text:
              `cdx run started: ${runId} (waiting for supervisor input). `
              + `${askLine}. `
              + `${optionIds ? `Options: ${optionIds}. ` : ''}`
              + `${questionPreview ? `Question: ${questionPreview} ` : ''}`
              + `${hint}. `
              + `${statsLine} `
              + formatRunControllerText({ runId, hasPendingAsk: pending.length > 0 }),
          },
        ],
        structured_content: {
          runId,
          status: runRecord.status,
          statsUrl: runRecord.statsUrl,
          progressToken,
          pendingAsks: pending,
          controller: buildRunControllerGuidance({
            runId,
            hasPendingAsk: pending.length > 0,
            askId: typeof first?.askId === 'string' ? first.askId : null,
          }),
        },
      });
      return;
    }

	    const statsLine = runRecord.statsUrl ? `Stats: ${runRecord.statsUrl}` : 'Stats: (disabled)';
	    this.#sendResponse(id, {
	      content: [
	        {
	          type: 'text',
	          text:
	            `cdx run started: ${runId} (still running). `
	            + `Use cdx.status to check progress (includes task lists). `
	            + `Tip: pass afterEventId + waitMs to cdx.status to long-poll instead of running curl loops. `
	            + `${statsLine} `
	            + formatRunControllerText({ runId }),
	        },
	      ],
	      structured_content: {
	        runId,
        status: runRecord.status,
        statsUrl: runRecord.statsUrl,
        progressToken,
        controller: buildRunControllerGuidance({ runId }),
      },
	    });
	  }

	  async #onCdxSpawn(id, args) {
      const forceCandidate = isObject(args)
        ? args.force
          ?? args.allowRepeat
          ?? args.allow_repeat
          ?? args.repeat
          ?? args.resetSpawnGuard
          ?? args.reset_spawn_guard
        : undefined;
      let forceSpawn = false;
      if (forceCandidate !== undefined) {
        const coerced = coerceBoolean(forceCandidate);
        if (coerced === null) {
          this.#sendError(
            id,
            -32602,
            `Unsupported force value: ${String(forceCandidate)}. Expected boolean.`,
          );
          return;
        }
        forceSpawn = coerced;
      }

      if (!forceSpawn && this.spawnGuard?.runId) {
        const runId = this.spawnGuard.runId;
        const record = this.runHistory.get(runId) ?? null;
        const runState = this.stats.getRunState?.(runId) ?? null;
        if (!record && !runState) {
          if (BACKGROUND_BACKEND_ENABLED && !IS_BACKGROUND_BACKEND_PROCESS) {
            const autoStart = await hasPersistedBackgroundRecoveryState({
              registryPath: BACKGROUND_BACKEND_REGISTRY_PATH,
              journalPath: this.runJournalPath,
            });
            const proxied = await this.#proxyBackgroundToolCall('cdx.status', {
              runId,
              includeTasks: true,
              includeAgents: false,
              includeAsks: true,
            }, { autoStart });
            const structured = isObject(proxied?.result?.structured_content)
              ? proxied.result.structured_content
              : null;
            if (proxied?.ok === true && structured && coerceString(structured.runId)) {
              this.latestRunId = runId;
              this.spawnGuard = {
                ...this.spawnGuard,
                statsUrl: coerceString(structured.statsUrl) ?? this.spawnGuard.statsUrl ?? null,
              };
              this.#sendResponse(id, proxied.result);
              return;
            }
          }
          this.spawnGuard = null;
        } else {
          const statsUrl = record?.statsUrl ?? this.spawnGuard.statsUrl ?? null;
          const statsLine = statsUrl
            ? `Stats: ${statsUrl}`
            : this.stats.enabled
              ? 'Stats: (starting)'
              : 'Stats: (disabled)';
          const snapshot = this.#snapshotRunStatus({
            runId,
            record,
            runState,
            includeTasks: true,
            includeAgents: false,
            includeAsks: true,
          });
          this.latestRunId = runId;
          this.#sendResponse(id, {
            content: [
              {
                type: 'text',
                text: `${snapshot.message} ${statsLine} ${formatRunControllerText({
                  runId,
                  background: true,
                  hasPendingAsk: Array.isArray(snapshot.pendingAsks) && snapshot.pendingAsks.length > 0,
                })}`,
              },
            ],
            structured_content: {
              runId,
              status: snapshot.status,
              phase: snapshot.phase,
              elapsedMs: snapshot.elapsedMs,
              etaMs: snapshot.etaMs,
              counts: snapshot.counts,
              summary: snapshot.summary,
              tasks: snapshot.tasks,
              checklist: snapshot.checklist,
              taskIdsByStatus: snapshot.taskIdsByStatus,
              agents: snapshot.agents,
	              pendingAsks: snapshot.pendingAsks,
	              recoveredFromJournal: snapshot.recoveredFromJournal,
	              orphanedAt: snapshot.orphanedAt,
	              orphanedReason: snapshot.orphanedReason,
	              resumedFromRunId: snapshot.resumedFromRunId,
	              resumedIntoRunId: snapshot.resumedIntoRunId,
	              resume: snapshot.resume,
	              statsUrl,
	              background: true,
	              deduped: true,
              controller: buildRunControllerGuidance({
                runId,
                background: true,
                hasPendingAsk: Array.isArray(snapshot.pendingAsks) && snapshot.pendingAsks.length > 0,
                askId: Array.isArray(snapshot.pendingAsks)
                  ? snapshot.pendingAsks
                    .map(entry => (typeof entry?.askId === 'string' ? entry.askId.trim() : ''))
                    .find(Boolean)
                  : null,
              }),
            },
          });
          return;
        }
      }

	    const lastRecord = this.latestRunId ? this.runHistory.get(this.latestRunId) : null;
	    const lastInput = isObject(lastRecord?.input) ? lastRecord.input : null;

	    const parsePositiveInt = value => {
	      const parsed = Number.parseInt(value, 10);
	      if (!Number.isFinite(parsed) || parsed <= 0) return null;
	      return parsed;
	    };

	    const parseRangeShorthand = value => {
	      const text = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
	      if (!text) return null;

	      const rangeMatch = text.match(/^(\d+)\s*-\s*(\d+)$/);
	      if (rangeMatch) {
	        const min = parsePositiveInt(rangeMatch[1]);
	        const max = parsePositiveInt(rangeMatch[2]);
	        if (!min || !max || min > max) return null;
	        return { min, max };
	      }

	      const single = parsePositiveInt(text);
	      if (!single) return null;
	      return { min: single, max: null };
	    };

	    let minParallelism = null;
	    let maxParallelism = null;
	    let overrides = null;

	    if (args === undefined || args === null) {
	      minParallelism = DEFAULT_MIN_PARALLELISM;
	      maxParallelism = DEFAULT_MAX_PARALLELISM;
	    } else if (typeof args === 'number') {
	      minParallelism = parsePositiveInt(args);
	    } else if (typeof args === 'string') {
	      const parsed = parseRangeShorthand(args);
	      if (parsed) {
	        minParallelism = parsed.min;
	        maxParallelism = parsed.max;
	      } else {
          const trimmed = args.trim();
          const rangePromptMatch = trimmed.match(/^(\d+\s*-\s*\d+|\d+)\s+([\s\S]*\S)$/);
          if (rangePromptMatch) {
            const rangeParsed = parseRangeShorthand(rangePromptMatch[1]);
            if (rangeParsed) {
              minParallelism = rangeParsed.min;
              maxParallelism = rangeParsed.max;
              overrides = { prompt: rangePromptMatch[2].trim() };
            }
          }
          if (!minParallelism) {
            minParallelism = DEFAULT_MIN_PARALLELISM;
            maxParallelism = DEFAULT_MAX_PARALLELISM;
            overrides = { prompt: trimmed };
          }
        }
	    } else if (isObject(args)) {
	      overrides = args;

	      const rangeCandidate =
	        args.range
	        ?? args.parallelismRange
	        ?? args.parallelism_range
	        ?? args.parallelism;
	      const parsedRange =
	        typeof rangeCandidate === 'string' && rangeCandidate.includes('-')
	          ? parseRangeShorthand(rangeCandidate)
	          : null;

	      if (parsedRange && parsedRange.max !== null) {
	        minParallelism = parsedRange.min;
	        maxParallelism = parsedRange.max;
	      } else {
	        const candidate =
	          args.parallelism
	          ?? args.concurrency
	          ?? args.concurrencyLevel
	          ?? args.concurrency_level
	          ?? args.minParallelism
	          ?? args.min_parallelism
	          ?? args.n
	          ?? args.count;
	        minParallelism = parsePositiveInt(candidate);

	        const maxCandidate = args.maxParallelism ?? args.max_parallelism;
	        const parsedMax = parsePositiveInt(maxCandidate);
	        if (parsedMax) maxParallelism = parsedMax;
	      }
	    }

	    if (!minParallelism) {
        minParallelism = DEFAULT_MIN_PARALLELISM;
        maxParallelism = DEFAULT_MAX_PARALLELISM;
	    }

    const merged = {
      ...(lastInput ? { ...lastInput } : {}),
      ...(overrides ? { ...overrides } : {}),
    };
    const explicitChecklistOverrides =
      Array.isArray(overrides?.targets)
      && Array.isArray(overrides?.checklist)
      && !(typeof overrides?.prompt === 'string' && overrides.prompt.trim())
      && !(typeof overrides?.goal === 'string' && overrides.goal.trim());
    if (explicitChecklistOverrides) {
      delete merged.prompt;
      delete merged.goal;
    }

    const checklistClarification = collectChecklistClarifications(merged, {
      maxTargets: MAX_TOTAL_TASKS,
      maxItems: MAX_TOTAL_TASKS,
      maxQuestions: 3,
    });
    if (checklistClarification) {
      this.#sendChecklistClarificationResponse(id, checklistClarification);
      return;
    }
    const checklistConfig = normalizeChecklistConfig(merged, {
      maxTargets: MAX_TOTAL_TASKS,
      maxItems: MAX_TOTAL_TASKS,
    });
    const promptCandidate =
      typeof merged.prompt === 'string' && merged.prompt.trim()
        ? merged.prompt
        : typeof merged.goal === 'string' && merged.goal.trim()
          ? merged.goal
          : checklistConfig
            ? `Execute the configured checklist workflow for ${checklistConfig.targets.length} targets and ${checklistConfig.items.length} checklist items.`
          : null;
	    if (!promptCandidate) {
	      this.#sendError(
	        id,
	        -32602,
	        'cdx.spawn requires a prompt, a checklist workload, or a previous CDX run to reuse the last prompt.',
	      );
	      return;
	    }
    merged.prompt = promptCandidate;
    merged.__statusSnapshot = true;

    const spawnBackgroundCandidate = isObject(args)
      ? args.background
        ?? args.backgroundMode
        ?? args.background_mode
        ?? args.detached
        ?? args.detach
        ?? args.async
        ?? args.returnImmediately
        ?? args.return_immediately
      : undefined;
    if (spawnBackgroundCandidate === undefined) {
      merged.background = true;
    } else {
      const coerced = coerceBoolean(spawnBackgroundCandidate);
      if (coerced === null) {
        this.#sendError(
          id,
          -32602,
          `Unsupported background value: ${String(spawnBackgroundCandidate)}. Expected boolean.`,
        );
        return;
      }
      merged.background = coerced;
    }

    const spawnBackgroundJobCandidate = isObject(args)
      ? args.backgroundJob
        ?? args.background_job
        ?? args.spawnBackgroundJob
        ?? args.spawn_background_job
      : undefined;
    if (spawnBackgroundJobCandidate === undefined) {
      merged.backgroundJob = true;
    } else {
      const coerced = coerceBoolean(spawnBackgroundJobCandidate);
      if (coerced === null) {
        this.#sendError(
          id,
          -32602,
          `Unsupported backgroundJob value: ${String(spawnBackgroundJobCandidate)}. Expected boolean.`,
        );
        return;
      }
      merged.backgroundJob = coerced;
    }

    const existing = Number.parseInt(merged.maxParallelism ?? merged.max_parallelism, 10);
    const existingValue = Number.isFinite(existing) ? Math.max(0, existing) : 0;

    const existingMin = Number.parseInt(merged.minParallelism ?? merged.min_parallelism, 10);
    const existingMinValue = Number.isFinite(existingMin) ? Math.max(0, existingMin) : 0;

    if (maxParallelism !== null) {
      merged.minParallelism = minParallelism;
      merged.maxParallelism = Math.max(maxParallelism, minParallelism);
    } else {
      merged.minParallelism = Math.max(minParallelism, existingMinValue);
      merged.maxParallelism = Math.max(existingValue, merged.minParallelism);
    }

    delete merged.range;
    delete merged.parallelismRange;
    delete merged.parallelism_range;
    delete merged.parallelism;
    delete merged.min_parallelism;
    delete merged.concurrency;
    delete merged.concurrencyLevel;
    delete merged.concurrency_level;
    delete merged.n;
    delete merged.count;
    delete merged.max_parallelism;

      if (forceSpawn) {
        this.spawnGuard = null;
      }

      if (BACKGROUND_BACKEND_ENABLED && !IS_BACKGROUND_BACKEND_PROCESS) {
        const proxied = await this.#proxyBackgroundToolResponse(id, 'cdx.spawn', merged, {
          autoStart: true,
          promptHint: merged.prompt,
          captureSpawnGuard: true,
        });
        if (proxied) return;
      }

      const previousRunId = this.latestRunId;
	    await this.#onCdxRun(id, merged);
      const spawnedRunId = this.latestRunId;
      if (spawnedRunId && spawnedRunId !== previousRunId && this.runHistory.has(spawnedRunId)) {
        const record = this.runHistory.get(spawnedRunId) ?? null;
        this.spawnGuard = {
          runId: spawnedRunId,
          prompt: merged.prompt,
          createdAt: Date.now(),
          statsUrl: record?.statsUrl ?? null,
        };
	      }
		  }

	  #buildResumePlannerPrompt({
	    sourceRunId,
	    sourceRecord,
	    sourceSnapshot,
	    extraPlannerPrompt = null,
	  } = {}) {
	    const inheritedPlannerPrompt = coerceString(sourceRecord?.input?.plannerPrompt, 12_000);
	    const overridePlannerPrompt = coerceString(extraPlannerPrompt, 12_000);
	    const tasks = Array.isArray(sourceSnapshot?.tasks) ? sourceSnapshot.tasks : [];
	    const completedTasks = tasks
	      .filter(task => task?.status === 'completed' || task?.status === 'superseded')
	      .slice(0, 8);
	    const unfinishedTasks = tasks
	      .filter(task => task?.status === 'pending' || task?.status === 'running')
	      .slice(0, 8);
	    const blockedTasks = tasks
	      .filter(task => task?.status === 'failed' || task?.status === 'blocked')
	      .slice(0, 8);

	    const formatTask = (task, { includeError = false, includePrompt = false } = {}) => {
	      const label = `${task?.id ?? 'task'} [${task?.status ?? 'unknown'}]`;
	      const description = coerceString(task?.description, 220) ?? 'no description recorded';
	      const extras = [];
	      if (Array.isArray(task?.dependsOn) && task.dependsOn.length > 0) {
	        extras.push(`deps=${task.dependsOn.slice(0, 4).join(',')}`);
	      }
	      if (Array.isArray(task?.changedFiles) && task.changedFiles.length > 0) {
	        extras.push(`files=${task.changedFiles.slice(0, 4).join(',')}`);
	      }
	      if (includeError) {
	        const error = coerceString(task?.error, 180);
	        if (error) extras.push(`error=${error}`);
	      }
	      if (includePrompt) {
	        const prompt = coerceString(task?.lastPromptText, 180);
	        if (prompt) extras.push(`handoff=${prompt}`);
	      }
	      const suffix = extras.length > 0 ? ` (${extras.join('; ')})` : '';
	      return clipText(`- ${label}: ${description}${suffix}`, 400);
	    };

	    const coordinationSource =
	      sourceRecord?.durableSnapshot?.coordinatorArtifact
	      ?? sourceRecord?.durableSnapshot?.coordination
	      ?? sourceRecord?.result?.coordination
	      ?? null;
	    const coordinationBlock = formatCoordinatorArtifact(coordinationSource, {
	      heading: 'Previous coordinator artifact',
	      listLimit: 6,
	      handoffLimit: 6,
	      interventionLimit: 6,
	      includeCountSummary: true,
	    });

	    const parts = [];
	    if (inheritedPlannerPrompt) parts.push(inheritedPlannerPrompt);
	    if (overridePlannerPrompt && overridePlannerPrompt !== inheritedPlannerPrompt) {
	      parts.push(overridePlannerPrompt);
	    }

	    const lines = [
	      'Resume this work from an orphaned CDX run. This is a recovery restart, not a clean-slate plan.',
	      `- Previous runId: ${sourceRunId}`,
	    ];
	    if (typeof sourceSnapshot?.orphanedReason === 'string' && sourceSnapshot.orphanedReason.trim()) {
	      lines.push(`- Orphan reason: ${clipText(sourceSnapshot.orphanedReason.trim(), 280)}`);
	    }
	    lines.push('- Preserve completed work when it still satisfies the goal.');
	    lines.push('- Do not recreate completed or superseded tasks unless new evidence proves they are still incomplete.');
	    lines.push('- Focus the new plan on the unfinished, blocked, failed, or final validation work needed to close the original goal.');

	    if (typeof sourceSnapshot?.summary === 'string' && sourceSnapshot.summary.trim()) {
	      lines.push('', 'Previous run summary:', clipText(sourceSnapshot.summary.trim(), 1_200));
	    }
	    if (coordinationBlock) {
	      lines.push('', coordinationBlock);
	    }
	    if (completedTasks.length > 0) {
	      lines.push('', 'Already completed or superseded:');
	      for (const task of completedTasks) lines.push(formatTask(task));
	    }
	    if (unfinishedTasks.length > 0) {
	      lines.push('', 'Unfinished tasks to revisit:');
	      for (const task of unfinishedTasks) lines.push(formatTask(task, { includePrompt: true }));
	    }
	    if (blockedTasks.length > 0) {
	      lines.push('', 'Failed or blocked tasks to repair:');
	      for (const task of blockedTasks) lines.push(formatTask(task, { includeError: true, includePrompt: true }));
	    }

	    parts.push(lines.join('\n'));
	    return clipText(parts.filter(Boolean).join('\n\n'), 16_000) ?? null;
	  }

	  async #onCdxResume(id, args) {
	    if (!isObject(args)) {
	      this.#sendError(id, -32602, 'cdx.resume expects object arguments with an orphaned runId.');
	      return;
	    }

	    const input = { ...args };
	    const sourceRunId =
	      typeof input.runId === 'string' && input.runId.trim()
	        ? input.runId.trim()
	        : typeof input.run_id === 'string' && input.run_id.trim()
	          ? input.run_id.trim()
	          : this.latestRunId;
	    if (!sourceRunId) {
	      this.#sendError(id, -32602, 'cdx.resume requires runId (or a latest orphaned run) to resume.');
	      return;
	    }

	    const forceCandidate =
	      input.force
	      ?? input.allowRepeat
	      ?? input.allow_repeat
	      ?? input.repeat
	      ?? input.resumeAgain
	      ?? input.resume_again;
	    const forceResume = forceCandidate === undefined ? false : coerceBoolean(forceCandidate);
	    if (forceResume === null) {
	      this.#sendError(id, -32602, `Unsupported force value: ${String(forceCandidate)}. Expected boolean.`);
	      return;
	    }

	    if (BACKGROUND_BACKEND_ENABLED && !IS_BACKGROUND_BACKEND_PROCESS) {
	      const autoStart = await hasPersistedBackgroundRecoveryState({
	        registryPath: BACKGROUND_BACKEND_REGISTRY_PATH,
	        journalPath: this.runJournalPath,
	      });
	      const proxied = await this.#proxyBackgroundToolResponse(id, 'cdx.resume', input, {
	        autoStart,
	        promptHint: typeof input.prompt === 'string' ? input.prompt : null,
	        captureSpawnGuard: true,
	      });
	      if (proxied) return;
	    }

	    const sourceRecord = this.runHistory.get(sourceRunId) ?? null;
	    const sourceRunState = this.stats.getRunState?.(sourceRunId) ?? null;
	    if (!sourceRecord && !sourceRunState) {
	      this.#sendError(id, -32602, `No cdx run found for resume: ${sourceRunId}`);
	      return;
	    }

	    const sourceStatus =
	      sourceRecord?.status
	      ?? sourceRunState?.status
	      ?? sourceRecord?.durableSnapshot?.status
	      ?? 'unknown';
	    if (sourceStatus !== ORPHANED_RUN_STATUS) {
	      this.#sendError(
	        id,
	        -32602,
	        `cdx.resume only supports orphaned runs. ${sourceRunId} is ${sourceStatus}.`,
	      );
	      return;
	    }

	    const existingResumedIntoRunId =
	      coerceString(sourceRecord?.resumedIntoRunId ?? sourceRecord?.durableSnapshot?.resumedIntoRunId, 400)
	      ?? null;
	    if (!forceResume && existingResumedIntoRunId) {
	      const linkedRecord = this.runHistory.get(existingResumedIntoRunId) ?? null;
	      const linkedRunState = this.stats.getRunState?.(existingResumedIntoRunId) ?? null;
	      const linkedSnapshot =
	        linkedRecord || linkedRunState
	          ? this.#snapshotRunStatus({
	              runId: existingResumedIntoRunId,
	              record: linkedRecord,
	              runState: linkedRunState,
	              includeTasks: true,
	              includeAgents: false,
	              includeAsks: true,
	            })
	          : null;
	      this.latestRunId = existingResumedIntoRunId;
	      const linkedMessage = linkedSnapshot?.controller
	        ? `${linkedSnapshot.message} ${formatRunControllerText({
	            runId: existingResumedIntoRunId,
	            background: linkedSnapshot.controller?.returnControlToUser === true,
	            hasPendingAsk: Array.isArray(linkedSnapshot.pendingAsks) && linkedSnapshot.pendingAsks.length > 0,
	          })}`
	        : linkedSnapshot?.message
	          ?? `orphaned run ${sourceRunId} was already resumed into ${existingResumedIntoRunId}.`;
	      this.#sendResponse(id, {
	        content: [{
	          type: 'text',
	          text: `${linkedMessage} ${formatRunResumeText({
	            runId: sourceRunId,
	            resumedIntoRunId: existingResumedIntoRunId,
	          })}`,
	        }],
	        structured_content: {
	          runId: existingResumedIntoRunId,
	          status: linkedSnapshot?.status ?? 'unknown',
	          phase: linkedSnapshot?.phase ?? null,
	          statsUrl: linkedRecord?.statsUrl ?? null,
	          elapsedMs: linkedSnapshot?.elapsedMs ?? null,
	          etaMs: linkedSnapshot?.etaMs ?? null,
	          counts: linkedSnapshot?.counts ?? null,
	          summary: linkedSnapshot?.summary ?? null,
	          tasks: linkedSnapshot?.tasks ?? null,
	          checklist: linkedSnapshot?.checklist ?? null,
	          taskIdsByStatus: linkedSnapshot?.taskIdsByStatus ?? null,
	          agents: linkedSnapshot?.agents ?? null,
	          pendingAsks: linkedSnapshot?.pendingAsks ?? null,
	          recoveredFromJournal: linkedSnapshot?.recoveredFromJournal ?? false,
	          orphanedAt: linkedSnapshot?.orphanedAt ?? null,
	          orphanedReason: linkedSnapshot?.orphanedReason ?? null,
	          resumedFromRunId: sourceRunId,
	          deduped: true,
	          sourceRunId,
	          controller: linkedSnapshot?.controller ?? null,
	        },
	      });
	      return;
	    }

	    const baseInput = isObject(sourceRecord?.input) ? { ...sourceRecord.input } : {};
	    const originalGoal =
	      coerceString(baseInput.prompt, 20_000)
	      ?? coerceString(baseInput.goal, 20_000)
	      ?? null;
	    if (!originalGoal) {
	      this.#sendError(
	        id,
	        -32602,
	        `cdx.resume could not find the original prompt for orphaned run ${sourceRunId}.`,
	      );
	      return;
	    }

	    const sourceSnapshot = this.#snapshotRunStatus({
	      runId: sourceRunId,
	      record: sourceRecord,
	      runState: sourceRunState,
	      includeTasks: true,
	      includeAgents: false,
	      includeAsks: false,
	    });

	    const merged = {
	      ...baseInput,
	      ...input,
	    };
	    delete merged.runId;
	    delete merged.run_id;
	    delete merged.force;
	    delete merged.allowRepeat;
	    delete merged.allow_repeat;
	    delete merged.repeat;
	    delete merged.resumeAgain;
	    delete merged.resume_again;

	    const overridePlannerPrompt =
	      input.plannerPrompt
	      ?? input.planner_prompt
	      ?? input['planner-prompt']
	      ?? null;
	    merged.prompt =
	      (typeof input.prompt === 'string' && input.prompt.trim())
	        ? input.prompt.trim()
	        : originalGoal;
	    merged.plannerPrompt = this.#buildResumePlannerPrompt({
	      sourceRunId,
	      sourceRecord,
	      sourceSnapshot,
	      extraPlannerPrompt: overridePlannerPrompt,
	    });

	    const backgroundCandidate =
	      input.background
	      ?? input.backgroundMode
	      ?? input.background_mode
	      ?? input.detached
	      ?? input.detach
	      ?? input.async
	      ?? input.returnImmediately
	      ?? input.return_immediately;
	    if (backgroundCandidate === undefined) {
	      merged.background = true;
	    } else {
	      const parsedBackground = coerceBoolean(backgroundCandidate);
	      if (parsedBackground === null) {
	        this.#sendError(
	          id,
	          -32602,
	          `Unsupported background value: ${String(backgroundCandidate)}. Expected boolean.`,
	        );
	        return;
	      }
	      merged.background = parsedBackground;
	    }

	    const backgroundJobCandidate =
	      input.backgroundJob
	      ?? input.background_job
	      ?? input.spawnBackgroundJob
	      ?? input.spawn_background_job;
	    if (backgroundJobCandidate === undefined) {
	      merged.backgroundJob = merged.background === true;
	    } else {
	      const parsedBackgroundJob = coerceBoolean(backgroundJobCandidate);
	      if (parsedBackgroundJob === null) {
	        this.#sendError(
	          id,
	          -32602,
	          `Unsupported backgroundJob value: ${String(backgroundJobCandidate)}. Expected boolean.`,
	        );
	        return;
	      }
	      merged.backgroundJob = parsedBackgroundJob;
	    }

	    const parsePositiveInt = value => {
	      const parsed = Number.parseInt(value, 10);
	      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
	    };
	    const parseRangeShorthand = value => {
	      const text = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
	      if (!text) return null;
	      const rangeMatch = text.match(/^(\d+)\s*-\s*(\d+)$/);
	      if (rangeMatch) {
	        const min = parsePositiveInt(rangeMatch[1]);
	        const max = parsePositiveInt(rangeMatch[2]);
	        if (!min || !max || min > max) return null;
	        return { min, max };
	      }
	      const single = parsePositiveInt(text);
	      return single ? { min: single, max: null } : null;
	    };

	    let minParallelism = null;
	    let maxParallelism = null;
	    const rangeCandidate =
	      input.range
	      ?? input.parallelismRange
	      ?? input.parallelism_range
	      ?? input.parallelism;
	    const parsedRange =
	      typeof rangeCandidate === 'string' && rangeCandidate.includes('-')
	        ? parseRangeShorthand(rangeCandidate)
	        : null;
	    if (parsedRange && parsedRange.max !== null) {
	      minParallelism = parsedRange.min;
	      maxParallelism = parsedRange.max;
	    } else {
	      const minCandidate =
	        input.parallelism
	        ?? input.concurrency
	        ?? input.concurrencyLevel
	        ?? input.concurrency_level
	        ?? input.minParallelism
	        ?? input.min_parallelism;
	      minParallelism = parsePositiveInt(minCandidate);
	      maxParallelism = parsePositiveInt(input.maxParallelism ?? input.max_parallelism);
	    }
	    if (maxParallelism !== null) {
	      merged.minParallelism = minParallelism;
	      merged.maxParallelism = Math.max(maxParallelism, minParallelism ?? 1);
	    } else if (minParallelism !== null) {
	      merged.minParallelism = minParallelism;
	      const existingMax = parsePositiveInt(merged.maxParallelism ?? merged.max_parallelism);
	      merged.maxParallelism = Math.max(existingMax ?? 0, minParallelism);
	    }
	    delete merged.range;
	    delete merged.parallelismRange;
	    delete merged.parallelism_range;
	    delete merged.parallelism;
	    delete merged.concurrency;
	    delete merged.concurrencyLevel;
	    delete merged.concurrency_level;
	    delete merged.min_parallelism;
	    delete merged.max_parallelism;

	    merged.__statusSnapshot = true;
	    merged.resumedFromRunId = sourceRunId;

	    const previousLatestRunId = this.latestRunId;
	    await this.#onCdxRun(id, merged);
	    const resumedRunId = this.latestRunId;
	    if (
	      resumedRunId
	      && resumedRunId !== sourceRunId
	      && resumedRunId !== previousLatestRunId
	      && this.runHistory.has(resumedRunId)
	    ) {
	      sourceRecord.resumedIntoRunId = resumedRunId;
	      const resumedRecord = this.runHistory.get(resumedRunId) ?? null;
	      if (resumedRecord && !resumedRecord.resumedFromRunId) {
	        resumedRecord.resumedFromRunId = sourceRunId;
	      }
	      this.#queueRunJournalFlush({ immediate: true });
	    }
	  }

	  async #onCdxHelp(id) {
	    const text = [
	      'CDX MCP tools',
	      '',
	      'Primary tools:',
	      '- cdx.spawn: Primary entrypoint. Starts the orchestrator in background by default, returns an immediate status snapshot, and gives control back to the user while CDX executes the run. Input can be N, "MIN-MAX", or an object with either { prompt, ...cdxOptions } for planner mode or { workflowMode: "checklist", targets: [...], checklist: [...], continuous?, maxCycles?, outputRoot?, ...cdxOptions } for checklist mode. Incomplete or vague checklist input returns status=needs_clarification with focused follow-up questions. Subsequent spawn calls reuse the latest spawn run unless force=true.',
	      '- cdx: Alias of cdx.spawn for callers that expose a single top-level CDX tool.',
	      '- cdx.resume: Restart a new run from an orphaned run\'s saved ledger/input. Defaults to background handoff and links the orphaned run to the new run.',
	      '- background: Set false only when you explicitly want to block until completion (cdx.spawn defaults to background).',
	      '- cdx.run: Advanced/manual orchestrator entrypoint. Requires either { prompt } for planner mode or { targets, checklist } for checklist mode. Optional checklist hints include { sourceSystems, artifactLocation, artifactFormat, artifactInstructions }. Other optional flags: { workflowMode, continuous, maxCycles, outputRoot, repoRoot, maxParallelism, minParallelism, autoscale, smartSpawn, skipPlanner, model, plannerModel, taskModel, watchdogModel, effort, plannerEffort, taskEffort, judgeEffort, watchdogEffort, sandbox, webSearch, analyticsEnabled, integrationVerify, review }',
	      '- cdx.status: Inspect run status, tasks, and recent events. Supports long-polling with { afterEventId, waitMs } and { waitFor: "event"|"ask" }.',
      '- cdx.ps: List currently running CDX runs and their dashboard URLs.',
      '',
      'Supervised router.ask flow:',
      '1) Start a run with cdx.spawn (or cdx if your broker exposes the alias).',
      '2) Poll with cdx.status { waitFor: "ask", waitMs: 30000 } to block until an ask is pending.',
      '3) Answer using cdx.router_answer (see pending asks in cdx.status.pendingAsks).',
      '',
      'Other tools:',
      '- cdx.rollback: Roll back last N turns for a task/thread (only if the app-server protocol supports it).',
      '- cdx.thread_fork: Fork a task/thread into a new thread (only if the app-server protocol supports it).',
      '- cdx.requirements: Read requirements allow-lists (requirements.toml/MDM) via configRequirements/read.',
      '- cdx.metrics: Return Prometheus/OpenTelemetry metrics from the stats server.',
      '- cdx.webui: Start the stats web UI backend and return the URL (omit runId to follow latest run).',
      '- cdx.stats.test: Open a seeded stats test screen (default: 10 running workers + git tree tab).',
      '- cdx.ps: List currently running CDX runs and their dashboard URLs.',
      '- cdx.pending_asks: List pending router asks.',
      '- cdx.router_answer: Answer a pending router.ask (supervised mode).',
      '- cdx.agent_message / cdx.agent_inbox: Supervisor message queue into worker turns (agent control).',
      '- cdx.steer: Queue a supervisor message and/or inject future tasks into a running run.',
      '- cdx.task_abort: Abort a running task (interrupts the current turn).',
      '- cdx.config: Inspect layered config (/etc, CODEX_HOME, project .codex/config.toml).',
      '',
    ].join('\n');

    this.#sendResponse(id, {
      content: [{ type: 'text', text }],
      structured_content: { text },
    });
  }

  async #onCdxPs(id) {
		    const now = Date.now();
		    const snapshot = [...this.runHistory.values()]
		      .map(record => {
		        const runId = record?.runId ?? null;
		        const runState = runId ? this.stats.getRunState?.(runId) ?? null : null;
		        const status = record?.status ?? runState?.status ?? 'unknown';
		        const statsUrl = record?.statsUrl ?? null;
		        const startedAt = record?.startedAt ?? runState?.startedAt ?? null;
		        const elapsedMs = Number.isFinite(startedAt) ? Math.max(0, now - startedAt) : null;
		        return {
		          runId,
		          status,
		          statsUrl,
			          startedAt,
			          elapsedMs,
	              recoveredFromJournal: record?.recoveredFromJournal === true,
	              orphanedReason: record?.orphanedReason ?? null,
	              resumedIntoRunId: record?.resumedIntoRunId ?? null,
			        };
		      })
	      .filter(entry => entry.runId)
	      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
      const running = snapshot
        .filter(entry => entry.status === 'running')
	      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
      const orphaned = snapshot.filter(entry => entry.status === ORPHANED_RUN_STATUS);

	    if (running.length === 0 && BACKGROUND_BACKEND_ENABLED && !IS_BACKGROUND_BACKEND_PROCESS) {
        const autoStart = await hasPersistedBackgroundRecoveryState({
          registryPath: BACKGROUND_BACKEND_REGISTRY_PATH,
          journalPath: this.runJournalPath,
        });
	      const proxied = await this.#proxyBackgroundToolResponse(id, 'cdx.ps', {}, {
	        autoStart,
	      });
	      if (proxied) return;
	    }

	    const lines = ['cdx ps'];
		    if (running.length === 0) {
		      lines.push('No running runs.');
		    } else {
		      for (const run of running) {
		        lines.push(`${run.runId}: ${run.statsUrl ?? '(stats disabled)'}`);
		      }
		    }
      if (orphaned.length > 0) {
        lines.push('');
        lines.push('Orphaned runs:');
	        for (const run of orphaned) {
	          const reason = typeof run.orphanedReason === 'string' && run.orphanedReason.trim()
	            ? ` (${clipText(run.orphanedReason, 120)})`
	            : '';
	          const resumedInto = typeof run.resumedIntoRunId === 'string' && run.resumedIntoRunId.trim()
	            ? ` -> resumedInto ${run.resumedIntoRunId.trim()}`
	            : '';
	          lines.push(`${run.runId}: orphaned${reason}${resumedInto}`);
	        }
      }

		    this.#sendResponse(id, {
		      content: [{ type: 'text', text: lines.join('\n') }],
		      structured_content: { running, orphaned },
		    });
		  }

  async #onCdxRollback(id, args) {
    const input = isObject(args) ? args : {};
    const runId =
      typeof input.runId === 'string' && input.runId.trim()
        ? input.runId.trim()
        : typeof input.run_id === 'string' && input.run_id.trim()
          ? input.run_id.trim()
          : this.latestRunId;

    if (
      BACKGROUND_BACKEND_ENABLED
      && !IS_BACKGROUND_BACKEND_PROCESS
      && (
        (runId && !this.runHistory.has(runId))
        || (!runId && this.runHistory.size === 0)
      )
    ) {
      const proxied = await this.#proxyBackgroundToolResponse(id, 'cdx.rollback', input, {
        autoStart: false,
      });
      if (proxied) return;
    }

    if (!runId) {
      this.#sendError(id, -32602, 'cdx.rollback requires runId (or an existing latest run).');
      return;
    }

    const record = this.runHistory.get(runId) ?? null;
    if (!record) {
      this.#sendError(id, -32602, `Unknown runId: ${runId}`);
      return;
    }

    const turnsRaw = input.turns ?? input.nTurns ?? input.n_turns ?? input.count ?? 1;
    const turns = Math.max(1, Number.parseInt(turnsRaw, 10) || 1);

    const taskId =
      typeof input.taskId === 'string' && input.taskId.trim()
        ? input.taskId.trim()
        : typeof input.task_id === 'string' && input.task_id.trim()
          ? input.task_id.trim()
          : null;
    const requestedThreadId =
      typeof input.threadId === 'string' && input.threadId.trim()
        ? input.threadId.trim()
        : typeof input.thread_id === 'string' && input.thread_id.trim()
          ? input.thread_id.trim()
          : null;

    let resolvedThreadId = requestedThreadId;
    let resolvedWorktreePath = null;
    let resolvedTaskId = taskId;

    const liveState = record?.orchestrator?.taskStates;
    if (!resolvedThreadId && taskId && liveState instanceof Map) {
      const state = liveState.get(taskId);
      if (state?.threadId) resolvedThreadId = state.threadId;
      if (state?.worktreePath) resolvedWorktreePath = state.worktreePath;
    }

    const finishedTasks = record?.result?.tasks;
    if (!resolvedThreadId && taskId && Array.isArray(finishedTasks)) {
      const match = finishedTasks.find(task => task?.id === taskId);
      if (match?.threadId) resolvedThreadId = match.threadId;
      if (match?.worktreePath) resolvedWorktreePath = match.worktreePath;
    }

    if (!resolvedTaskId && resolvedThreadId && Array.isArray(finishedTasks)) {
      const match = finishedTasks.find(task => task?.threadId === resolvedThreadId);
      if (match?.id) resolvedTaskId = match.id;
      if (!resolvedWorktreePath && match?.worktreePath) resolvedWorktreePath = match.worktreePath;
    }

    if (!resolvedThreadId) {
      this.#sendError(
        id,
        -32602,
        'cdx.rollback requires threadId, or taskId with a known threadId.',
      );
      return;
    }

    const baseInput = isObject(record?.input) ? record.input : {};
    const merged = { ...baseInput, ...input };

    const normalizedSandbox =
      merged.sandbox !== undefined && merged.sandbox !== null
        ? normalizeSandboxMode(String(merged.sandbox))
        : null;
    if (merged.sandbox !== undefined && merged.sandbox !== null && !normalizedSandbox) {
      this.#sendError(
        id,
        -32602,
        `Unsupported sandbox mode: ${String(merged.sandbox).trim()}. Expected read-only | workspace-write | danger-full-access.`,
      );
      return;
    }

    const webSearchMode =
      merged.webSearch !== undefined && merged.webSearch !== null
        ? normalizeWebSearchMode(merged.webSearch)
        : null;
    if (merged.webSearch !== undefined && merged.webSearch !== null && !webSearchMode) {
      this.#sendError(
        id,
        -32602,
        `Unsupported webSearch mode: ${String(merged.webSearch)}. Expected off | on | cached.`,
      );
      return;
    }

    const analyticsCandidate =
      merged.analyticsEnabled !== undefined
        ? merged.analyticsEnabled
        : isObject(merged.analytics) && Object.hasOwn(merged.analytics, 'enabled')
          ? merged.analytics.enabled
          : undefined;
    const analyticsEnabled =
      analyticsCandidate === undefined ? null : coerceBoolean(analyticsCandidate);
    if (analyticsCandidate !== undefined && analyticsEnabled === null) {
      this.#sendError(
        id,
        -32602,
        `Unsupported analyticsEnabled value: ${String(analyticsCandidate)}. Expected boolean.`,
      );
      return;
    }

    const configOverrides = {};
    if (webSearchMode === 'on') {
      configOverrides['features.web_search_request'] = true;
    } else if (webSearchMode === 'off') {
      configOverrides['features.web_search_request'] = false;
    } else if (webSearchMode === 'cached') {
      configOverrides['features.web_search_request'] = true;
      configOverrides['features.web_search_cached'] = true;
    }
    if (typeof analyticsEnabled === 'boolean') {
      configOverrides['analytics.enabled'] = analyticsEnabled;
    }

    const client = new AppServerClient({
      approvalDecision: DEFAULT_APPROVAL_DECISION,
      approvalJustification: record?.orchestrator?.execJustification ?? null,
      log: (...parts) => {
        const msg = parts.map(String).join(' ');
        this.stats.recordLog(`[rollback] ${msg}`, runId);
      },
      env: {
        CDX_RUN_ID: runId,
        CDX_TASK_ID: resolvedTaskId ?? '',
      },
    });

    const cleanupClient = async () => {
      await client.dispose('cdx-rollback').catch(() => {});
    };

    try {
      await client.ensureInitialized();

      const resumeParams = { threadId: resolvedThreadId };
      if (resolvedWorktreePath) resumeParams.cwd = resolvedWorktreePath;
      if (typeof merged.model === 'string' && merged.model.trim()) {
        resumeParams.model = merged.model.trim();
      }
      if (normalizedSandbox) {
        resumeParams.sandbox = normalizedSandbox;
      }
      if (Object.keys(configOverrides).length > 0) {
        resumeParams.config = configOverrides;
      }

      await client.request('thread/resume', resumeParams);

      const candidates = [
        { threadId: resolvedThreadId, turns },
        { threadId: resolvedThreadId, nTurns: turns },
        { threadId: resolvedThreadId, count: turns },
      ];

      let rollbackResult = null;
      let paramsUsed = null;

      for (const candidate of candidates) {
        try {
          rollbackResult = await client.request('thread/rollback', candidate);
          paramsUsed = Object.keys(candidate).sort();
          break;
        } catch (err) {
          if (err?.code === -32601) {
            this.#sendResponse(id, {
              content: [
                {
                  type: 'text',
                  text:
                    'thread/rollback is not supported by this Codex app-server build. Update Codex to enable rollback.',
                },
              ],
              structured_content: {
                supported: false,
                runId,
                taskId: resolvedTaskId,
                threadId: resolvedThreadId,
                turns,
              },
            });
            return;
          }
          if (err?.code === -32602) {
            continue;
          }
          throw err;
        }
      }

      if (!rollbackResult) {
        this.#sendError(
          id,
          -32603,
          'thread/rollback failed (method exists but parameter shape was rejected).',
        );
        return;
      }

      this.#sendResponse(id, {
        content: [
          {
            type: 'text',
            text:
              `Rolled back ${turns} turn(s) for thread ${resolvedThreadId}.` +
              (paramsUsed ? ` (params: ${paramsUsed.join(', ')})` : ''),
          },
        ],
        structured_content: {
          supported: true,
          runId,
          taskId: resolvedTaskId,
          threadId: resolvedThreadId,
          turns,
          paramsUsed,
          result: rollbackResult,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? 'unknown error');
      this.#sendError(id, -32603, `cdx.rollback failed: ${message}`);
    } finally {
      await cleanupClient();
    }
  }

  async #onCdxThreadFork(id, args) {
    const input = isObject(args) ? args : {};
    const runId =
      typeof input.runId === 'string' && input.runId.trim()
        ? input.runId.trim()
        : typeof input.run_id === 'string' && input.run_id.trim()
          ? input.run_id.trim()
          : this.latestRunId;

    if (
      BACKGROUND_BACKEND_ENABLED
      && !IS_BACKGROUND_BACKEND_PROCESS
      && (
        (runId && !this.runHistory.has(runId))
        || (!runId && this.runHistory.size === 0)
      )
    ) {
      const proxied = await this.#proxyBackgroundToolResponse(id, 'cdx.thread_fork', input, {
        autoStart: false,
      });
      if (proxied) return;
    }

    const record = runId ? this.runHistory.get(runId) ?? null : null;
    if (runId && !record) {
      this.#sendError(id, -32602, `Unknown runId: ${runId}`);
      return;
    }

    const taskId =
      typeof input.taskId === 'string' && input.taskId.trim()
        ? input.taskId.trim()
        : typeof input.task_id === 'string' && input.task_id.trim()
          ? input.task_id.trim()
          : null;
    const requestedThreadId =
      typeof input.threadId === 'string' && input.threadId.trim()
        ? input.threadId.trim()
        : typeof input.thread_id === 'string' && input.thread_id.trim()
          ? input.thread_id.trim()
          : null;

    let resolvedThreadId = requestedThreadId;
    let resolvedWorktreePath = null;
    let resolvedTaskId = taskId;

    const liveState = record?.orchestrator?.taskStates;
    if (!resolvedThreadId && taskId && liveState instanceof Map) {
      const state = liveState.get(taskId);
      if (state?.threadId) resolvedThreadId = state.threadId;
      if (state?.worktreePath) resolvedWorktreePath = state.worktreePath;
    }

    const finishedTasks = record?.result?.tasks;
    if (!resolvedThreadId && taskId && Array.isArray(finishedTasks)) {
      const match = finishedTasks.find(task => task?.id === taskId);
      if (match?.threadId) resolvedThreadId = match.threadId;
      if (match?.worktreePath) resolvedWorktreePath = match.worktreePath;
    }

    if (!resolvedTaskId && resolvedThreadId && Array.isArray(finishedTasks)) {
      const match = finishedTasks.find(task => task?.threadId === resolvedThreadId);
      if (match?.id) resolvedTaskId = match.id;
      if (!resolvedWorktreePath && match?.worktreePath) resolvedWorktreePath = match.worktreePath;
    }

    if (!resolvedThreadId) {
      this.#sendError(
        id,
        -32602,
        'cdx.thread_fork requires threadId, or taskId with a known threadId.',
      );
      return;
    }

    const baseInput = isObject(record?.input) ? record.input : {};
    const merged = { ...baseInput, ...input };

    const normalizedSandbox =
      merged.sandbox !== undefined && merged.sandbox !== null
        ? normalizeSandboxMode(String(merged.sandbox))
        : null;
    if (merged.sandbox !== undefined && merged.sandbox !== null && !normalizedSandbox) {
      this.#sendError(
        id,
        -32602,
        `Unsupported sandbox mode: ${String(merged.sandbox).trim()}. Expected read-only | workspace-write | danger-full-access.`,
      );
      return;
    }

    const webSearchMode =
      merged.webSearch !== undefined && merged.webSearch !== null
        ? normalizeWebSearchMode(merged.webSearch)
        : null;
    if (merged.webSearch !== undefined && merged.webSearch !== null && !webSearchMode) {
      this.#sendError(
        id,
        -32602,
        `Unsupported webSearch mode: ${String(merged.webSearch)}. Expected off | on | cached.`,
      );
      return;
    }

    const analyticsCandidate =
      merged.analyticsEnabled !== undefined
        ? merged.analyticsEnabled
        : isObject(merged.analytics) && Object.hasOwn(merged.analytics, 'enabled')
          ? merged.analytics.enabled
          : undefined;
    const analyticsEnabled =
      analyticsCandidate === undefined ? null : coerceBoolean(analyticsCandidate);
    if (analyticsCandidate !== undefined && analyticsEnabled === null) {
      this.#sendError(
        id,
        -32602,
        `Unsupported analyticsEnabled value: ${String(analyticsCandidate)}. Expected boolean.`,
      );
      return;
    }

    const configOverrides = {};
    if (webSearchMode === 'on') {
      configOverrides['features.web_search_request'] = true;
    } else if (webSearchMode === 'off') {
      configOverrides['features.web_search_request'] = false;
    } else if (webSearchMode === 'cached') {
      configOverrides['features.web_search_request'] = true;
      configOverrides['features.web_search_cached'] = true;
    }
    if (typeof analyticsEnabled === 'boolean') {
      configOverrides['analytics.enabled'] = analyticsEnabled;
    }

    const client = new AppServerClient({
      approvalDecision: DEFAULT_APPROVAL_DECISION,
      approvalJustification: record?.orchestrator?.execJustification ?? null,
      log: (...parts) => {
        const msg = parts.map(String).join(' ');
        this.stats.recordLog(`[fork] ${msg}`, runId);
      },
      env: {
        CDX_RUN_ID: runId ?? '',
        CDX_TASK_ID: resolvedTaskId ?? '',
      },
    });

    const cleanupClient = async () => {
      await client.dispose('cdx-thread-fork').catch(() => {});
    };

    try {
      await client.ensureInitialized();

      const forkParams = { threadId: resolvedThreadId };
      const pathCandidate =
        typeof merged.path === 'string' && merged.path.trim()
          ? merged.path.trim()
          : typeof merged.rolloutPath === 'string' && merged.rolloutPath.trim()
            ? merged.rolloutPath.trim()
            : typeof merged.rollout_path === 'string' && merged.rollout_path.trim()
              ? merged.rollout_path.trim()
              : null;
      if (pathCandidate) {
        forkParams.path = pathCandidate;
      }

      const cwdCandidate =
        typeof merged.cwd === 'string' && merged.cwd.trim()
          ? merged.cwd.trim()
          : resolvedWorktreePath;
      if (cwdCandidate) {
        forkParams.cwd = cwdCandidate;
      }

      if (typeof merged.model === 'string' && merged.model.trim()) {
        forkParams.model = merged.model.trim();
      }
      if (normalizedSandbox) {
        forkParams.sandbox = normalizedSandbox;
      }
      if (Object.keys(configOverrides).length > 0) {
        forkParams.config = configOverrides;
      }

      let forkResult = null;
      try {
        forkResult = await client.request('thread/fork', forkParams);
      } catch (err) {
        if (err?.code === -32601) {
          this.#sendResponse(id, {
            content: [
              {
                type: 'text',
                text:
                  'thread/fork is not supported by this Codex app-server build. Update Codex to enable thread forking.',
              },
            ],
            structured_content: {
              supported: false,
              runId: runId ?? null,
              taskId: resolvedTaskId,
              threadId: resolvedThreadId,
              params: forkParams,
            },
          });
          return;
        }
        throw err;
      }

      const forkedThreadId = forkResult?.thread?.id ?? forkResult?.threadId ?? null;
      this.#sendResponse(id, {
        content: [
          {
            type: 'text',
            text:
              `Forked thread ${resolvedThreadId}.` +
              (forkedThreadId ? ` New thread: ${forkedThreadId}.` : ''),
          },
        ],
        structured_content: {
          supported: true,
          runId: runId ?? null,
          taskId: resolvedTaskId,
          threadId: resolvedThreadId,
          forkedThreadId,
          params: forkParams,
          result: forkResult,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? 'unknown error');
      this.#sendError(id, -32603, `cdx.thread_fork failed: ${message}`);
    } finally {
      await cleanupClient();
    }
  }

  async #onCdxRequirements(id, args) {
    const input = isObject(args) ? args : {};
    const runId =
      typeof input.runId === 'string' && input.runId.trim()
        ? input.runId.trim()
        : typeof input.run_id === 'string' && input.run_id.trim()
          ? input.run_id.trim()
          : this.latestRunId;

    const record = runId ? this.runHistory.get(runId) ?? null : null;
    if (runId && !record) {
      this.#sendError(id, -32602, `Unknown runId: ${runId}`);
      return;
    }

    const client = new AppServerClient({
      approvalDecision: DEFAULT_APPROVAL_DECISION,
      approvalJustification: record?.orchestrator?.execJustification ?? null,
      log: (...parts) => {
        const msg = parts.map(String).join(' ');
        this.stats.recordLog(`[requirements] ${msg}`, runId);
      },
      env: {
        CDX_RUN_ID: runId ?? '',
      },
    });

    const cleanupClient = async () => {
      await client.dispose('cdx-requirements').catch(() => {});
    };

    try {
      await client.ensureInitialized();
      let requirementsResult = null;
      try {
        requirementsResult = await client.request('configRequirements/read');
      } catch (err) {
        if (err?.code === -32601) {
          this.#sendResponse(id, {
            content: [
              {
                type: 'text',
                text:
                  'configRequirements/read is not supported by this Codex app-server build. Update Codex to enable requirements inspection.',
              },
            ],
            structured_content: {
              supported: false,
              runId: runId ?? null,
            },
          });
          return;
        }
        throw err;
      }

      const requirements = requirementsResult?.requirements ?? null;
      this.#sendResponse(id, {
        content: [
          {
            type: 'text',
            text:
              requirements
                ? 'Loaded config requirements are available.'
                : 'No config requirements are configured (requirements.toml/MDM not present).',
          },
        ],
        structured_content: {
          supported: true,
          runId: runId ?? null,
          requirements,
          result: requirementsResult,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? 'unknown error');
      this.#sendError(id, -32603, `cdx.requirements failed: ${message}`);
    } finally {
      await cleanupClient();
    }
  }

  async #onCdxMetrics(id, args) {
    const input = isObject(args) ? args : {};
    const runId =
      typeof input.runId === 'string' && input.runId.trim()
        ? input.runId.trim()
        : typeof input.run_id === 'string' && input.run_id.trim()
          ? input.run_id.trim()
          : this.latestRunId;

    const formatRaw =
      typeof input.format === 'string' && input.format.trim()
        ? input.format.trim().toLowerCase()
        : typeof input.output === 'string' && input.output.trim()
          ? input.output.trim().toLowerCase()
          : 'prometheus';

    if (formatRaw !== 'prometheus' && formatRaw !== 'otel') {
      this.#sendError(id, -32602, `Unsupported metrics format: ${formatRaw}. Expected prometheus|otel.`);
      return;
    }

    if (formatRaw === 'otel') {
      const metrics = this.stats.getOtelMetrics(runId ?? null);
      const text = JSON.stringify(metrics, null, 2);
      this.#sendResponse(id, {
        content: [{ type: 'text', text }],
        structured_content: {
          runId: runId ?? null,
          format: 'otel',
          metrics,
        },
      });
      return;
    }

    const text = this.stats.getPrometheusMetrics(runId ?? null);
    this.#sendResponse(id, {
      content: [{ type: 'text', text }],
      structured_content: {
        runId: runId ?? null,
        format: 'prometheus',
        text,
      },
    });
  }

  async #onCdxWebui(id, args) {
    const input = isObject(args) ? args : {};
    const runId =
      typeof input.runId === 'string' && input.runId.trim()
        ? input.runId.trim()
        : typeof input.run_id === 'string' && input.run_id.trim()
          ? input.run_id.trim()
          : null;

    const openRaw =
      Object.hasOwn(input, 'open')
        ? input.open
        : Object.hasOwn(input, 'openDashboard')
          ? input.openDashboard
          : Object.hasOwn(input, 'open_dashboard')
            ? input.open_dashboard
            : Object.hasOwn(input, 'openStats')
              ? input.openStats
              : Object.hasOwn(input, 'open_stats')
                ? input.open_stats
                : Object.hasOwn(input, 'autoOpen')
                  ? input.autoOpen
                  : Object.hasOwn(input, 'auto_open')
                    ? input.auto_open
                    : undefined;
    const open = openRaw === undefined ? true : coerceBoolean(openRaw);
    if (open === null) {
      this.#sendError(
        id,
        -32602,
        `Unsupported open value: ${String(openRaw)}. Expected boolean.`,
      );
      return;
    }

    try {
      const dashboardBaseUrl = await this.#ensureStatsDashboardBaseUrl();
      if (!dashboardBaseUrl) {
        this.#sendResponse(id, {
          content: [{ type: 'text', text: 'Stats UI: (disabled)' }],
          structured_content: {
            runId: runId ?? null,
            statsUrl: null,
            opened: false,
            error: 'stats_disabled',
          },
        });
        return;
      }

      const statsUrl = runId ? this.#statsUrlForRun(dashboardBaseUrl, runId) : dashboardBaseUrl;
      let opened = null;
      let openError = null;
      if (open === true && statsUrl) {
        opened = await this.stats.openUrl(statsUrl);
        if (!opened) openError = 'open_failed';
      }

      if (runId) {
        const record = this.runHistory.get(runId) ?? null;
        if (record && !record.statsUrl) record.statsUrl = statsUrl;
      }

      const text = statsUrl ? `Stats UI: ${statsUrl}` : 'Stats UI: (disabled)';
      this.#sendResponse(id, {
        content: [{ type: 'text', text }],
        structured_content: {
          runId: runId ?? null,
          statsUrl,
          opened,
          error: openError,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? 'open_failed');
      this.#sendError(id, -32603, `cdx.webui failed: ${message}`);
    }
  }

  async #onCdxStatsTest(id, args) {
    const input = isObject(args) ? args : {};
    const runId =
      typeof input.runId === 'string' && input.runId.trim()
        ? input.runId.trim()
        : typeof input.run_id === 'string' && input.run_id.trim()
          ? input.run_id.trim()
          : 'stats-test';

    const workersRaw = input.workers ?? input.workerCount ?? input.worker_count ?? 10;
    const workersParsed = Number.parseInt(workersRaw, 10);
    const workers = Number.isFinite(workersParsed)
      ? Math.max(1, Math.min(64, workersParsed))
      : 10;

    const tabRaw = String(input.tab ?? 'worktree').trim().toLowerCase();
    const tab = tabRaw === 'api' ? 'api' : tabRaw === 'logs' ? 'logs' : 'worktree';

    const openRaw =
      Object.hasOwn(input, 'open')
        ? input.open
        : Object.hasOwn(input, 'openDashboard')
          ? input.openDashboard
          : Object.hasOwn(input, 'open_dashboard')
            ? input.open_dashboard
            : Object.hasOwn(input, 'autoOpen')
              ? input.autoOpen
              : Object.hasOwn(input, 'auto_open')
                ? input.auto_open
                : true;
    const open = coerceBoolean(openRaw);
    if (open === null) {
      this.#sendError(
        id,
        -32602,
        `Unsupported open value: ${String(openRaw)}. Expected boolean.`,
      );
      return;
    }

    const cwdCandidate =
      (typeof input.repoRoot === 'string' && input.repoRoot.trim())
      || (typeof input.repo_root === 'string' && input.repo_root.trim())
      || (typeof input.cwd === 'string' && input.cwd.trim())
      || this.sandboxCwd
      || process.cwd();

    let repoRoot = String(cwdCandidate);
    try {
      repoRoot = await getRepoRoot(repoRoot);
    } catch {}

    let headRef = 'HEAD';
    try {
      const resolvedHead = await getHeadRef(repoRoot);
      if (typeof resolvedHead === 'string' && resolvedHead.trim()) {
        headRef = resolvedHead.trim();
      }
    } catch {}

    try {
      const dashboardBaseUrl = await this.#ensureStatsDashboardBaseUrl();
      if (!dashboardBaseUrl) {
        this.#sendResponse(id, {
          content: [{ type: 'text', text: 'Stats test UI: (disabled)' }],
          structured_content: {
            runId,
            statsUrl: null,
            opened: false,
            workerCount: workers,
            error: 'stats_disabled',
          },
        });
        return;
      }

      const seeded = this.stats.seedDebugRun({
        runId,
        repoRoot,
        cwd: repoRoot,
        headRef,
        workerCount: workers,
      });
      const seededRunId = seeded?.runId ?? runId;
      const seededWorkerCount = seeded?.workerCount ?? workers;
      const seededRepoRoot = seeded?.repoRoot ?? repoRoot;
      const seededHeadRef = seeded?.headRef ?? headRef;

      let statsUrl = this.#statsUrlForRun(dashboardBaseUrl, seededRunId);
      if (statsUrl) {
        const sep = statsUrl.includes('?') ? '&' : '?';
        statsUrl = `${statsUrl}${sep}tab=${encodeURIComponent(tab)}&mode=test`;
      }

      let opened = null;
      let openError = null;
      if (open === true && statsUrl) {
        opened = await this.stats.openUrl(statsUrl);
        if (!opened) openError = 'open_failed';
      }

      const now = Date.now();
      this.latestRunId = seededRunId;
      this.runHistory.set(seededRunId, {
        runId: seededRunId,
        status: 'running',
        startedAt: now,
        completedAt: null,
        progressToken: null,
        input: {
          mode: 'stats_test',
          runId: seededRunId,
          workers: seededWorkerCount,
          repoRoot: seededRepoRoot,
          tab,
        },
        statsUrl,
        result: null,
        error: null,
        promise: null,
        orchestrator: null,
	        durableSnapshot: null,
	        recoveredFromJournal: false,
	        orphanedAt: null,
	        orphanedReason: null,
	        resumedFromRunId: null,
	        resumedIntoRunId: null,
	      });
      this.#trimRunHistory();
      this.#queueRunJournalFlush();

      const text = statsUrl
        ? `Stats test UI: ${statsUrl}`
        : 'Stats test UI: (disabled)';

      this.#sendResponse(id, {
        content: [{ type: 'text', text }],
        structured_content: {
          runId: seededRunId,
          statsUrl,
          opened,
          workerCount: seededWorkerCount,
          repoRoot: seededRepoRoot,
          headRef: seededHeadRef,
          tab,
          error: openError,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? 'stats_test_failed');
      this.#sendError(id, -32603, `cdx.stats.test failed: ${message}`);
    }
  }

  async #onCdxLogs(id, args) {
    const input = isObject(args) ? args : {};
    const runId =
      typeof input.runId === 'string' && input.runId.trim()
        ? input.runId.trim()
        : typeof input.run_id === 'string' && input.run_id.trim()
          ? input.run_id.trim()
          : this.latestRunId;

    if (
      BACKGROUND_BACKEND_ENABLED
      && !IS_BACKGROUND_BACKEND_PROCESS
      && (
        (runId && !this.runHistory.has(runId))
        || (!runId && this.runHistory.size === 0)
      )
    ) {
      const proxied = await this.#proxyBackgroundToolResponse(id, 'cdx.logs', input, {
        autoStart: false,
      });
      if (proxied) return;
    }

    const taskId =
      typeof input.taskId === 'string' && input.taskId.trim()
        ? input.taskId.trim()
        : typeof input.task_id === 'string' && input.task_id.trim()
          ? input.task_id.trim()
          : null;

    const explicitAgentId =
      typeof input.agentId === 'string' && input.agentId.trim()
        ? input.agentId.trim()
        : typeof input.agent_id === 'string' && input.agent_id.trim()
          ? input.agent_id.trim()
          : null;

    const agentId = explicitAgentId ?? (taskId ? `task:${taskId}` : 'server');

    const afterRaw =
      input.afterLogId
      ?? input.after_log_id
      ?? input.after
      ?? input.cursor
      ?? 0;
    const afterLogId = Math.max(0, Number.parseInt(afterRaw, 10) || 0);

    const limitRaw = input.limit ?? input.max ?? input.count ?? '200';
    const limit = Math.max(0, Math.min(2000, Number.parseInt(limitRaw, 10) || 0));

    const waitMsRaw =
      input.waitMs
      ?? input.wait_ms
      ?? input.timeoutMs
      ?? input.timeout_ms
      ?? input.wait
      ?? 0;
    const waitMs = Math.max(0, Math.min(120_000, Number.parseInt(waitMsRaw, 10) || 0));

    let waited = null;
    if (waitMs > 0 && typeof this.stats.waitForLog === 'function') {
      const snap = this.stats.getLogs(agentId, afterLogId, 1, runId);
      if (!Array.isArray(snap?.items) || snap.items.length === 0) {
        waited = await this.stats.waitForLog(runId, agentId, afterLogId, waitMs, null);
      }
    }

    const batch = this.stats.getLogs(agentId, afterLogId, limit, runId);
    const items = Array.isArray(batch?.items) ? batch.items : [];

    const lines = items.map(item => {
      const ts = item?.ts ? `[${item.ts}] ` : '';
      const text = item?.text ?? '';
      return `${ts}${text}`;
    });

    const header = `cdx logs runId=${runId ?? '-'} agentId=${agentId} after=${afterLogId} limit=${limit}`;
    const body = lines.length > 0 ? `${header}\n${lines.join('\n')}` : `${header}\n(no new logs)`;

    this.#sendResponse(id, {
      content: [{ type: 'text', text: body }],
      structured_content: {
        runId: runId ?? null,
        agentId,
        afterLogId,
        nextLogId: batch?.next ?? afterLogId,
        lastLogId: batch?.lastLogId ?? 0,
        waited,
        items,
      },
    });
  }

  async #onCdxPendingAsks(id, args) {
    const input = isObject(args) ? args : {};
    const runId =
      typeof input.runId === 'string' && input.runId.trim()
        ? input.runId.trim()
        : typeof input.run_id === 'string' && input.run_id.trim()
          ? input.run_id.trim()
          : this.latestRunId;

    if (
      BACKGROUND_BACKEND_ENABLED
      && !IS_BACKGROUND_BACKEND_PROCESS
      && (
        (runId && !this.runHistory.has(runId))
        || (!runId && this.runHistory.size === 0)
      )
    ) {
      const proxied = await this.#proxyBackgroundToolResponse(id, 'cdx.pending_asks', input, {
        autoStart: false,
      });
      if (proxied) return;
    }

    if (!runId) {
      this.#sendResponse(id, {
        content: [{ type: 'text', text: 'No cdx run found.' }],
        structured_content: { runId: null, pendingAsks: [] },
      });
      return;
    }

    const record = this.runHistory.get(runId) ?? null;
    const pending =
      typeof record?.orchestrator?.listPendingRouterAsks === 'function'
        ? record.orchestrator.listPendingRouterAsks()
        : [];

    const message = pending.length
      ? `cdx run ${runId}: pending router asks=${pending.length}`
      : `cdx run ${runId}: no pending router asks`;

    this.#sendResponse(id, {
      content: [{ type: 'text', text: message }],
      structured_content: {
        runId,
        pendingAsks: pending,
      },
    });
  }

  async #onCdxRouterAnswer(id, args) {
    const input = isObject(args) ? args : {};
    const runId =
      typeof input.runId === 'string' && input.runId.trim()
        ? input.runId.trim()
        : typeof input.run_id === 'string' && input.run_id.trim()
          ? input.run_id.trim()
          : this.latestRunId;

    if (
      BACKGROUND_BACKEND_ENABLED
      && !IS_BACKGROUND_BACKEND_PROCESS
      && (
        (runId && !this.runHistory.has(runId))
        || (!runId && this.runHistory.size === 0)
      )
    ) {
      const proxied = await this.#proxyBackgroundToolResponse(id, 'cdx.router_answer', input, {
        autoStart: false,
      });
      if (proxied) return;
    }

    if (!runId) {
      this.#sendError(id, -32602, 'cdx.router_answer requires runId (or an existing latest run).');
      return;
    }

    const record = this.runHistory.get(runId) ?? null;
    if (!record?.orchestrator || typeof record.orchestrator.answerRouterAsk !== 'function') {
      this.#sendError(id, -32603, `cdx.router_answer: unknown run or router not available (${runId})`);
      return;
    }

    let askId =
      typeof input.askId === 'string' && input.askId.trim()
        ? input.askId.trim()
        : typeof input.ask_id === 'string' && input.ask_id.trim()
          ? input.ask_id.trim()
          : null;

    if (!askId && typeof record.orchestrator.listPendingRouterAsks === 'function') {
      const pending = record.orchestrator.listPendingRouterAsks() ?? [];
      if (pending.length === 1 && pending[0]?.askId) {
        askId = String(pending[0].askId).trim() || null;
      } else if (pending.length > 0) {
        const ids = pending.map(entry => entry?.askId).filter(Boolean).slice(0, 10).join(', ');
        this.#sendError(id, -32602, `cdx.router_answer requires askId. Pending asks: ${ids}`);
        return;
      }
    }

    if (!askId) {
      this.#sendError(id, -32602, 'cdx.router_answer requires askId.');
      return;
    }

    const response =
      input.response ?? input.answer ?? input.result ?? input.structured_content ?? input;

    const outcome = record.orchestrator.answerRouterAsk({
      askId,
      response,
      answeredBy: input.answeredBy ?? input.answered_by ?? 'supervisor',
    });

    if (!outcome?.ok) {
      const message = outcome?.error ? String(outcome.error) : 'unknown_error';
      this.#sendError(id, -32603, `cdx.router_answer failed: ${message}`);
      return;
    }

    this.#sendResponse(id, {
      content: [{ type: 'text', text: `Answered router.ask ${askId}` }],
      structured_content: outcome,
    });
  }

  #resolveToolTargetTask(record, input) {
    let taskId =
      typeof input?.taskId === 'string' && input.taskId.trim()
        ? input.taskId.trim()
        : typeof input?.task_id === 'string' && input.task_id.trim()
          ? input.task_id.trim()
          : null;

    const threadId =
      typeof input?.threadId === 'string' && input.threadId.trim()
        ? input.threadId.trim()
        : typeof input?.thread_id === 'string' && input.thread_id.trim()
          ? input.thread_id.trim()
          : null;

    if (!taskId && threadId) {
      const mapped = record?.orchestrator?.threadToTask?.get?.(threadId) ?? null;
      if (typeof mapped === 'string' && mapped.trim()) taskId = mapped.trim();
    }

    const agentId =
      typeof input?.agentId === 'string' && input.agentId.trim()
        ? input.agentId.trim()
        : typeof input?.agent_id === 'string' && input.agent_id.trim()
          ? input.agent_id.trim()
          : null;

    if (!taskId && agentId && agentId.startsWith('task:')) {
      const candidate = agentId.slice('task:'.length).trim();
      if (candidate) taskId = candidate;
    }

    return {
      taskId,
      threadId,
      agentId,
    };
  }

  async #onCdxAgentMessage(id, args) {
    const input = isObject(args) ? args : {};
    const runId =
      typeof input.runId === 'string' && input.runId.trim()
        ? input.runId.trim()
        : typeof input.run_id === 'string' && input.run_id.trim()
          ? input.run_id.trim()
          : this.latestRunId;

    if (
      BACKGROUND_BACKEND_ENABLED
      && !IS_BACKGROUND_BACKEND_PROCESS
      && (
        (runId && !this.runHistory.has(runId))
        || (!runId && this.runHistory.size === 0)
      )
    ) {
      const proxied = await this.#proxyBackgroundToolResponse(id, 'cdx.agent_message', input, {
        autoStart: false,
      });
      if (proxied) return;
    }

    if (!runId) {
      this.#sendError(id, -32602, 'cdx.agent_message requires runId (or an existing latest run).');
      return;
    }

    const record = this.runHistory.get(runId) ?? null;
    if (!record?.orchestrator || typeof record.orchestrator.enqueueAgentMessage !== 'function') {
      this.#sendError(id, -32603, `cdx.agent_message: unknown run (${runId})`);
      return;
    }

    if (record.status !== 'running') {
      this.#sendError(
        id,
        -32603,
        `cdx.agent_message: run ${runId} is not running (status=${record.status ?? 'unknown'})`,
      );
      return;
    }

    const message =
      typeof input.message === 'string'
        ? input.message
        : typeof input.text === 'string'
          ? input.text
          : typeof input.msg === 'string'
            ? input.msg
            : null;

    if (!message || !message.trim()) {
      this.#sendError(id, -32602, 'cdx.agent_message requires a non-empty message string.');
      return;
    }

    const source =
      typeof input.source === 'string' && input.source.trim()
        ? input.source.trim()
        : typeof input.from === 'string' && input.from.trim()
          ? input.from.trim()
          : 'supervisor';
    const { taskId } = this.#resolveToolTargetTask(record, input);

    const outcome = record.orchestrator.enqueueAgentMessage({
      taskId,
      message,
      source,
    });

    if (!outcome?.ok) {
      const error = outcome?.error ? String(outcome.error) : 'unknown_error';
      this.#sendError(id, -32603, `cdx.agent_message failed: ${error}`);
      return;
    }

    const scopeText =
      outcome.scope === 'broadcast'
        ? 'broadcast'
        : outcome.taskId
          ? `task ${outcome.taskId}`
          : 'task';

    this.#sendResponse(id, {
      content: [{ type: 'text', text: `Queued supervisor message (${scopeText}).` }],
      structured_content: {
        runId,
        ...outcome,
      },
    });
  }

  async #onCdxSteer(id, args) {
    const input = isObject(args) ? args : {};
    const runId =
      typeof input.runId === 'string' && input.runId.trim()
        ? input.runId.trim()
        : typeof input.run_id === 'string' && input.run_id.trim()
          ? input.run_id.trim()
          : this.latestRunId;

    if (
      BACKGROUND_BACKEND_ENABLED
      && !IS_BACKGROUND_BACKEND_PROCESS
      && (
        (runId && !this.runHistory.has(runId))
        || (!runId && this.runHistory.size === 0)
      )
    ) {
      const proxied = await this.#proxyBackgroundToolResponse(id, 'cdx.steer', input, {
        autoStart: false,
      });
      if (proxied) return;
    }

    if (!runId) {
      this.#sendError(id, -32602, 'cdx.steer requires runId (or an existing latest run).');
      return;
    }

    const record = this.runHistory.get(runId) ?? null;
    if (
      !record?.orchestrator
      || typeof record.orchestrator.enqueueAgentMessage !== 'function'
      || typeof record.orchestrator.enqueueRuntimeInjection !== 'function'
    ) {
      this.#sendError(id, -32603, `cdx.steer: unknown run (${runId})`);
      return;
    }

    if (record.status !== 'running') {
      this.#sendError(
        id,
        -32603,
        `cdx.steer: run ${runId} is not running (status=${record.status ?? 'unknown'})`,
      );
      return;
    }

    const message =
      typeof input.message === 'string'
        ? input.message
        : typeof input.text === 'string'
          ? input.text
          : typeof input.msg === 'string'
            ? input.msg
            : null;

    const tasks = extractRuntimeInjectionTasks(input);
    if ((!message || !message.trim()) && tasks.length === 0) {
      this.#sendError(
        id,
        -32602,
        'cdx.steer requires a non-empty message and/or at least one task to inject.',
      );
      return;
    }

    const source =
      typeof input.source === 'string' && input.source.trim()
        ? input.source.trim()
        : typeof input.from === 'string' && input.from.trim()
          ? input.from.trim()
          : 'supervisor';

    const broadcast = coerceBoolean(input.broadcast) === true;
    const target = this.#resolveToolTargetTask(record, input);
    let taskId = target.taskId;

    if (!taskId && !broadcast && tasks.length === 1) {
      const injectedTaskId = coerceString(tasks[0]?.id);
      if (injectedTaskId) taskId = injectedTaskId;
    }

    if (message && message.trim() && !broadcast && !taskId && tasks.length > 0) {
      this.#sendError(
        id,
        -32602,
        'cdx.steer message targeting is ambiguous. Provide taskId/threadId/agentId, set broadcast=true, or inject exactly one named task.',
      );
      return;
    }

    let injection = null;
    if (tasks.length > 0) {
      injection = record.orchestrator.enqueueRuntimeInjection({
        tasks,
        kind: 'steer',
        source,
      });
      if (!injection?.ok) {
        const error = injection?.error ? String(injection.error) : 'unknown_error';
        this.#sendError(id, -32603, `cdx.steer failed to queue tasks: ${error}`);
        return;
      }
    }

    let queuedMessage = null;
    if (message && message.trim()) {
      queuedMessage = record.orchestrator.enqueueAgentMessage({
        taskId: broadcast ? null : taskId,
        message,
        source,
      });
      if (!queuedMessage?.ok) {
        const error = queuedMessage?.error ? String(queuedMessage.error) : 'unknown_error';
        this.#sendError(id, -32603, `cdx.steer failed to queue message: ${error}`);
        return;
      }
    }

    const parts = [];
    if (queuedMessage?.scope === 'broadcast') {
      parts.push('queued broadcast message');
    } else if (queuedMessage?.taskId) {
      parts.push(`queued message for task ${queuedMessage.taskId}`);
    } else if (queuedMessage) {
      parts.push('queued message');
    }
    if (injection?.taskCount) {
      parts.push(`queued ${injection.taskCount} task injection(s)`);
    }

    this.#sendResponse(id, {
      content: [{ type: 'text', text: parts.join('; ') || 'Queued steer request.' }],
      structured_content: {
        ok: true,
        runId,
        message: queuedMessage,
        injection,
      },
    });
  }

  async #onCdxAgentInbox(id, args) {
    const input = isObject(args) ? args : {};
    const runId =
      typeof input.runId === 'string' && input.runId.trim()
        ? input.runId.trim()
        : typeof input.run_id === 'string' && input.run_id.trim()
          ? input.run_id.trim()
          : this.latestRunId;

    if (
      BACKGROUND_BACKEND_ENABLED
      && !IS_BACKGROUND_BACKEND_PROCESS
      && (
        (runId && !this.runHistory.has(runId))
        || (!runId && this.runHistory.size === 0)
      )
    ) {
      const proxied = await this.#proxyBackgroundToolResponse(id, 'cdx.agent_inbox', input, {
        autoStart: false,
      });
      if (proxied) return;
    }

    if (!runId) {
      this.#sendResponse(id, {
        content: [{ type: 'text', text: 'No cdx run found.' }],
        structured_content: { runId: null, inbox: null },
      });
      return;
    }

    const record = this.runHistory.get(runId) ?? null;
    if (!record?.orchestrator || typeof record.orchestrator.listAgentMessages !== 'function') {
      this.#sendError(id, -32603, `cdx.agent_inbox: unknown run (${runId})`);
      return;
    }

    const taskId =
      typeof input.taskId === 'string' && input.taskId.trim()
        ? input.taskId.trim()
        : typeof input.task_id === 'string' && input.task_id.trim()
          ? input.task_id.trim()
          : null;

    const includeBroadcastCandidate =
      Object.hasOwn(input, 'includeBroadcast')
        ? input.includeBroadcast
        : Object.hasOwn(input, 'include_broadcast')
          ? input.include_broadcast
          : undefined;
    const includeBroadcast =
      includeBroadcastCandidate === undefined ? true : coerceBoolean(includeBroadcastCandidate);
    if (includeBroadcastCandidate !== undefined && includeBroadcast === null) {
      this.#sendError(
        id,
        -32602,
        `Unsupported includeBroadcast value: ${String(includeBroadcastCandidate)}. Expected boolean.`,
      );
      return;
    }

    const clearCandidate =
      Object.hasOwn(input, 'clear') ? input.clear : Object.hasOwn(input, 'clearInbox') ? input.clearInbox : undefined;
    const clear = clearCandidate === undefined ? false : coerceBoolean(clearCandidate);
    if (clearCandidate !== undefined && clear === null) {
      this.#sendError(
        id,
        -32602,
        `Unsupported clear value: ${String(clearCandidate)}. Expected boolean.`,
      );
      return;
    }

    const inbox = record.orchestrator.listAgentMessages({
      taskId,
      includeBroadcast,
    });

    let cleared = null;
    if (clear) {
      cleared =
        typeof record.orchestrator.clearAgentMessages === 'function'
          ? record.orchestrator.clearAgentMessages({ taskId })
          : null;
    }

    const broadcastCount = Array.isArray(inbox?.broadcast) ? inbox.broadcast.length : 0;
    const taskCounts = {};
    const tasks = inbox?.tasks ?? {};
    for (const [key, value] of Object.entries(tasks)) {
      taskCounts[key] = Array.isArray(value) ? value.length : 0;
    }

    const message = taskId
      ? `cdx run ${runId}: inbox task=${taskId} broadcast=${broadcastCount} queued=${taskCounts[taskId] ?? 0}`
      : `cdx run ${runId}: inbox broadcast=${broadcastCount} tasks=${Object.keys(taskCounts).length}`;

    this.#sendResponse(id, {
      content: [{ type: 'text', text: message }],
      structured_content: {
        runId,
        inbox,
        counts: {
          broadcast: broadcastCount,
          tasks: taskCounts,
        },
        cleared,
      },
    });
  }

  async #onCdxTaskAbort(id, args) {
    const input = isObject(args) ? args : {};
    const runId =
      typeof input.runId === 'string' && input.runId.trim()
        ? input.runId.trim()
        : typeof input.run_id === 'string' && input.run_id.trim()
          ? input.run_id.trim()
          : this.latestRunId;

    if (
      BACKGROUND_BACKEND_ENABLED
      && !IS_BACKGROUND_BACKEND_PROCESS
      && (
        (runId && !this.runHistory.has(runId))
        || (!runId && this.runHistory.size === 0)
      )
    ) {
      const proxied = await this.#proxyBackgroundToolResponse(id, 'cdx.task_abort', input, {
        autoStart: false,
      });
      if (proxied) return;
    }

    if (!runId) {
      this.#sendError(id, -32602, 'cdx.task_abort requires runId (or an existing latest run).');
      return;
    }

    const record = this.runHistory.get(runId) ?? null;
    if (!record?.orchestrator || typeof record.orchestrator.requestTaskAbort !== 'function') {
      this.#sendError(id, -32603, `cdx.task_abort: unknown run (${runId})`);
      return;
    }

    const taskId =
      typeof input.taskId === 'string' && input.taskId.trim()
        ? input.taskId.trim()
        : typeof input.task_id === 'string' && input.task_id.trim()
          ? input.task_id.trim()
          : null;
    if (!taskId) {
      this.#sendError(id, -32602, 'cdx.task_abort requires taskId.');
      return;
    }

    const reason =
      typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim() : null;
    const source =
      typeof input.source === 'string' && input.source.trim() ? input.source.trim() : null;

    const outcome = record.orchestrator.requestTaskAbort({
      taskId,
      reason,
      source,
    });

    if (!outcome?.ok) {
      const error = outcome?.error ? String(outcome.error) : 'unknown_error';
      this.#sendError(id, -32603, `cdx.task_abort failed: ${error}`);
      return;
    }

    const message = `Abort requested for task ${outcome.taskId ?? taskId}.`;
    this.#sendResponse(id, {
      content: [{ type: 'text', text: message }],
      structured_content: {
        runId,
        ...outcome,
      },
    });
  }

  async #onCdxConfig(id, args) {
    const input = isObject(args) ? args : {};
    const requestedRunId =
      typeof input.runId === 'string' && input.runId.trim()
        ? input.runId.trim()
        : typeof input.run_id === 'string' && input.run_id.trim()
          ? input.run_id.trim()
          : null;

    let layers = null;
    let config = null;
    let meta = null;

    if (requestedRunId) {
      const record = this.runHistory.get(requestedRunId) ?? null;
      if (record?.orchestrator?.codexConfigMeta && record.orchestrator.codexConfig) {
        config = record.orchestrator.codexConfig;
        meta = {
          ...record.orchestrator.codexConfigMeta,
          runId: requestedRunId,
        };
      }
    }

    if (!config || !meta) {
      const cwd =
        typeof input.cwd === 'string' && input.cwd.trim()
          ? input.cwd.trim()
          : process.cwd();
      layers = loadCodexConfigLayers({ cwd });
      config = layers.config ?? {};
      meta = {
        runId: null,
        cwd: layers.cwd,
        projectRoot: layers.projectRoot,
        sources: layers.sources,
      };
    }

    const keysRaw = input.keys ?? input.key ?? input.paths ?? null;
    const keys = Array.isArray(keysRaw)
      ? keysRaw.map(String).map(v => v.trim()).filter(Boolean)
      : typeof keysRaw === 'string' && keysRaw.trim()
        ? [keysRaw.trim()]
        : [];

    const values = {};
    for (const key of keys) {
      values[key] = getConfigValue(config, key);
    }

    const sources = Array.isArray(meta?.sources) ? meta.sources : [];
    const projectEntry = sources.find(entry => entry?.layer === 'project') ?? null;
    const projectConfigPresent = Boolean(projectEntry?.exists);

    const message = meta.runId
      ? `cdx.config (runId=${meta.runId}): projectRoot=${meta.projectRoot} projectConfig=${projectConfigPresent}`
      : `cdx.config: projectRoot=${meta.projectRoot} projectConfig=${projectConfigPresent}`;

    this.#sendResponse(id, {
      content: [{ type: 'text', text: message }],
      structured_content: {
        meta,
        keys,
        values,
      },
    });
  }

  #formatStatusMessage({
    runId,
    status,
    phase,
    counts,
    elapsedMs,
    etaMs,
    tasks,
    pendingAsks,
    summary,
    error,
  }) {
    if (status === 'completed' && summary) return summary;

    const countsText = counts
      ? `agents=${counts.agentsRunning}/${counts.agentsTotal} tasks=${counts.tasksCompleted}/${counts.tasksTotal} running=${counts.tasksRunning} superseded=${counts.tasksSuperseded ?? 0} failed=${counts.tasksFailed} blocked=${counts.tasksBlocked}`
      : 'counts unavailable';

    const extraTaskInfo = Array.isArray(tasks) && tasks.length > 0
      ? [
        tasks.some(task => task.status === 'running')
          ? `runningTasks=[${tasks.filter(task => task.status === 'running').map(task => task.id).join(', ')}]`
          : null,
        tasks.some(task => task.status === 'failed')
          ? `failedTasks=[${tasks.filter(task => task.status === 'failed').map(task => task.id).join(', ')}]`
          : null,
        tasks.some(task => task.status === 'blocked')
          ? `blockedTasks=[${tasks.filter(task => task.status === 'blocked').map(task => task.id).join(', ')}]`
          : null,
        tasks.some(task => task.status === 'superseded')
          ? `supersededTasks=[${tasks.filter(task => task.status === 'superseded').map(task => task.id).join(', ')}]`
          : null,
      ]
        .filter(Boolean)
        .join(' ')
      : '';

    const formatDuration = ms => {
      if (!Number.isFinite(ms) || ms < 0) return '-';
      const totalSeconds = Math.floor(ms / 1000);
      const seconds = totalSeconds % 60;
      const minutes = Math.floor(totalSeconds / 60) % 60;
      const hours = Math.floor(totalSeconds / 3600);

      if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
      }
      return `${minutes}:${String(seconds).padStart(2, '0')}`;
    };

    const timeInfo = [
      Number.isFinite(elapsedMs) && elapsedMs !== null ? `elapsed=${formatDuration(elapsedMs)}` : null,
      Number.isFinite(etaMs) && etaMs !== null ? `eta=${formatDuration(etaMs)}` : null,
    ].filter(Boolean).join(' ');

    const runningDetail = (() => {
      if (!Array.isArray(tasks) || tasks.length === 0) return '';
      const running = tasks.filter(task => task.status === 'running');
      if (running.length === 0) return '';

      const nowMs = Date.now();
      const describe = task => {
        const idleMs =
          Number.isFinite(task.lastActivityAt) && task.lastActivityAt !== null
            ? Math.max(0, nowMs - task.lastActivityAt)
            : null;
        const idleLabel = idleMs === null ? '?' : formatDuration(idleMs);
        const activity =
          typeof task.lastActivity === 'string' && task.lastActivity.trim()
            ? clipText(task.lastActivity, 90)
            : null;
        return activity
          ? `${task.id}(idle ${idleLabel}: ${activity})`
          : `${task.id}(idle ${idleLabel})`;
      };

      const sorted = running.slice().sort((a, b) => {
        const aAt = Number.isFinite(a.lastActivityAt) ? a.lastActivityAt : 0;
        const bAt = Number.isFinite(b.lastActivityAt) ? b.lastActivityAt : 0;
        return aAt - bAt;
      });

      const limit = sorted.length <= 3 ? sorted.length : 1;
      const suffix = sorted.length > limit ? `, +${sorted.length - limit} more` : '';
      return `runningDetail=[${sorted.slice(0, limit).map(describe).join(', ')}${suffix}]`;
    })();

    const askInfo = Array.isArray(pendingAsks) && pendingAsks.length > 0
      ? `pendingAsks=${pendingAsks.length}`
      : '';

    const phaseText = phase ? `phase=${phase}` : '';
    const errorText =
      (status === 'failed' || status === ORPHANED_RUN_STATUS) && typeof error === 'string' && error.trim()
        ? ` reason=${clipText(error, 160)}`
        : '';

    return `cdx run ${runId}: status=${status}${phaseText ? ` ${phaseText}` : ''} ${countsText}${timeInfo ? ` ${timeInfo}` : ''}${extraTaskInfo ? ` ${extraTaskInfo}` : ''}${runningDetail ? ` ${runningDetail}` : ''}${askInfo ? ` ${askInfo}` : ''}${errorText}`;
  }

  #snapshotRunStatus({
    runId,
    record,
    runState,
    includeTasks = true,
    includeAgents = false,
    includeAsks = true,
  } = {}) {
    const durableSnapshot = isObject(record?.durableSnapshot) ? record.durableSnapshot : null;
    let status = record?.status ?? runState?.status ?? durableSnapshot?.status ?? 'unknown';
    const now = Date.now();
    const startedAt = record?.startedAt ?? runState?.startedAt ?? null;
    const completedAt = record?.completedAt ?? runState?.completedAt ?? null;
    const endAt = completedAt ?? now;
    const elapsedMs = Number.isFinite(startedAt) ? Math.max(0, endAt - startedAt) : null;

    const counts = runState?.counts ?? (isObject(durableSnapshot?.counts) ? durableSnapshot.counts : null);
	    const summary =
	      record?.result?.summary
	      ?? (typeof durableSnapshot?.summary === 'string' && durableSnapshot.summary.trim()
	        ? durableSnapshot.summary.trim()
	        : null);
	    const resumedFromRunId =
	      coerceString(record?.resumedFromRunId ?? durableSnapshot?.resumedFromRunId, 400)
	      ?? null;
	    const resumedIntoRunId =
	      coerceString(record?.resumedIntoRunId ?? durableSnapshot?.resumedIntoRunId, 400)
	      ?? null;
	    const error =
	      typeof record?.error === 'string' && record.error.trim()
	        ? record.error.trim()
	        : typeof durableSnapshot?.orphanedReason === 'string' && durableSnapshot.orphanedReason.trim()
          ? durableSnapshot.orphanedReason.trim()
          : null;

    let tasks = [];
    if (Array.isArray(runState?.tasks)) {
      tasks = normaliseTaskList(
        runState.tasks.map(task => ({
          id: task?.taskId,
          status: task?.status,
          description: task?.description,
          dependsOn: task?.dependsOn,
          checklist: task?.checklist,
          branch: task?.branch,
          worktreePath: task?.worktreePath,
          changedFiles: task?.changedFiles,
          startedAt: task?.startedAt,
          finishedAt: task?.finishedAt,
          error: task?.error,
          supersededAt: task?.supersededAt,
          priorStatus: task?.priorStatus,
          replacementTaskIds: task?.replacementTaskIds,
          recoveryWave: task?.recoveryWave,
          lastActivityAt: task?.lastActivityAt,
          lastActivity: task?.lastActivity,
          lastPromptAt: task?.lastPromptAt ?? null,
          lastPromptText: clipText(task?.lastPromptText ?? '', 600) || null,
        })),
      );
    } else if (Array.isArray(durableSnapshot?.tasks)) {
      tasks = normaliseTaskList(
        durableSnapshot.tasks
          .filter(task => isObject(task))
          .map(task => ({
            ...task,
            id: task?.id,
            status: task?.status,
            description: task?.description,
            dependsOn: Array.isArray(task?.dependsOn) ? task.dependsOn : [],
            checklist: task?.checklist ?? null,
            branch: task?.branch ?? null,
            worktreePath: task?.worktreePath ?? null,
            changedFiles: Array.isArray(task?.changedFiles) ? task.changedFiles : [],
            startedAt: task?.startedAt ?? null,
            finishedAt: task?.finishedAt ?? null,
            error: task?.error ?? null,
            supersededAt: task?.supersededAt ?? null,
            priorStatus: task?.priorStatus ?? null,
            replacementTaskIds: Array.isArray(task?.replacementTaskIds) ? task.replacementTaskIds : [],
            recoveryWave: task?.recoveryWave ?? null,
            threadId: task?.threadId ?? null,
            lastActivityAt: task?.lastActivityAt ?? null,
            lastActivity: task?.lastActivity ?? null,
            lastPromptAt: task?.lastPromptAt ?? null,
            lastPromptText: clipText(task?.lastPromptText ?? '', 600) || null,
          })),
      );
    } else if (record?.orchestrator?.taskStates instanceof Map) {
      tasks = normaliseTaskList(
        [...record.orchestrator.taskStates.values()].map(state => ({
          id: state?.task?.id,
          status: state?.status,
          description: state?.task?.description,
          dependsOn: state?.task?.dependsOn,
          checklist: state?.task?.checklist,
          branch: state?.branch,
          worktreePath: state?.worktreePath,
          changedFiles: state?.changedFiles,
          startedAt: state?.startedAt,
          finishedAt: state?.finishedAt,
          error: state?.error,
          supersededAt: state?.supersededAt,
          priorStatus: state?.supersededFromStatus,
          replacementTaskIds: state?.supersededByTaskIds,
          recoveryWave: state?.supersededWave,
          threadId: state?.threadId,
          lastActivityAt: state?.lastActivityAt,
          lastActivity: state?.lastActivity,
          lastPromptAt: this.contextStore?.snapshot(state?.task?.id)?.recentPrompts?.slice?.(-1)?.[0]?.ts ?? null,
          lastPromptText: clipText(
            this.contextStore?.snapshot(state?.task?.id)?.recentPrompts?.slice?.(-1)?.[0]?.text ?? '',
            600,
          ) || null,
        })),
      );
    } else if (Array.isArray(record?.result?.tasks)) {
      tasks = normaliseTaskList(
        record.result.tasks.map(task => ({
          id: task?.id,
          status: task?.status,
          description: task?.description,
          dependsOn: task?.dependsOn,
          checklist: task?.checklist,
          branch: task?.branch,
          worktreePath: task?.worktreePath,
          changedFiles: task?.changedFiles,
          error: task?.error,
          supersededAt: task?.supersededAt,
          priorStatus: task?.priorStatus,
          replacementTaskIds: task?.replacementTaskIds,
          recoveryWave: task?.recoveryWave,
          threadId: task?.threadId,
          lastPromptAt: task?.lastPromptAt ?? null,
          lastPromptText: clipText(task?.lastPromptText ?? '', 600) || null,
        })),
      );
    }

    const taskIdsByStatus = tasks.reduce(
      (acc, task) => {
        const key = typeof task.status === 'string' ? task.status : 'unknown';
        if (!acc[key]) acc[key] = [];
        acc[key].push(task.id);
        return acc;
      },
      { pending: [], running: [], completed: [], superseded: [], failed: [], blocked: [] },
    );

    const localCounts = {
      pending: taskIdsByStatus.pending.length,
      running: taskIdsByStatus.running.length,
      completed: taskIdsByStatus.completed.length,
      superseded: taskIdsByStatus.superseded.length,
      failed: taskIdsByStatus.failed.length,
      blocked: taskIdsByStatus.blocked.length,
    };
    const mergeSkipped = Array.isArray(record?.result?.merge?.skipped)
      ? record.result.merge.skipped.length
      : 0;
    if (status === 'completed' || status === 'running') {
      if (localCounts.failed > 0 || mergeSkipped > 0) {
        status = 'failed';
      } else if (localCounts.blocked > 0) {
        status = 'blocked';
      }
    }

    const agentSnapshot = Array.isArray(runState?.agents)
      ? runState.agents.map(agent => ({
          agentId: agent?.agentId ?? null,
          taskId: agent?.taskId ?? null,
        phase: agent?.phase ?? null,
        status: agent?.status ?? null,
        startedAt: agent?.startedAt ?? null,
        finishedAt: agent?.finishedAt ?? null,
        worktreePath: agent?.worktreePath ?? null,
          branch: agent?.branch ?? null,
          lastActivityAt: agent?.lastActivityAt ?? null,
          lastActivity: agent?.lastActivity ?? null,
          lastPromptAt: agent?.lastPromptAt ?? null,
          lastPromptText: clipText(agent?.lastPromptText ?? '', 800) || null,
        }))
      : [];

    const agents = includeAgents ? agentSnapshot : null;

    const pendingAsks = includeAsks && typeof record?.orchestrator?.listPendingRouterAsks === 'function'
      ? record.orchestrator.listPendingRouterAsks()
      : includeAsks && Array.isArray(durableSnapshot?.pendingAsks)
        ? durableSnapshot.pendingAsks
      : null;
    const checklist =
      runState?.checklist
      ?? record?.result?.metadata?.checklist
      ?? durableSnapshot?.checklist
      ?? null;

    const phase = deriveRunPhase({ status, agents: agentSnapshot, tasks });

    let etaMs =
      Number.isFinite(durableSnapshot?.etaMs) && durableSnapshot.etaMs >= 0
        ? durableSnapshot.etaMs
        : null;
    if (counts && Number.isFinite(elapsedMs) && elapsedMs !== null) {
      const totalTasks = Number.parseInt(counts.tasksTotal, 10);
      const doneTasks =
        (Number.parseInt(counts.tasksCompleted, 10) || 0)
        + (Number.parseInt(counts.tasksSuperseded, 10) || 0)
        + (Number.parseInt(counts.tasksFailed, 10) || 0)
        + (Number.parseInt(counts.tasksBlocked, 10) || 0);
      if (Number.isFinite(totalTasks) && totalTasks > 0 && doneTasks > 0) {
        if (doneTasks >= totalTasks) {
          etaMs = 0;
        } else {
          const estimatedTotalMs = elapsedMs * (totalTasks / doneTasks);
          etaMs = Math.max(0, Math.round(estimatedTotalMs - elapsedMs));
        }
      }
    }

    const message = this.#formatStatusMessage({
      runId,
      status,
      phase,
      counts,
      elapsedMs,
      etaMs,
      tasks,
      pendingAsks,
      summary,
      error,
    });

    const firstAskId = Array.isArray(pendingAsks)
      ? pendingAsks
        .map(entry => (typeof entry?.askId === 'string' ? entry.askId.trim() : ''))
        .find(Boolean)
      : null;
	    const controller = status === 'running'
	      ? buildRunControllerGuidance({
	          runId,
	          hasPendingAsk: Array.isArray(pendingAsks) && pendingAsks.length > 0,
	          askId: firstAskId,
	        })
	      : null;
	    const resume = status === ORPHANED_RUN_STATUS
	      ? buildRunResumeGuidance({ runId, resumedIntoRunId })
	      : null;

	    return {
	      runId,
	      status,
      phase,
      elapsedMs,
      etaMs,
      counts,
      summary,
      tasks: includeTasks ? tasks : null,
      checklist,
      taskIdsByStatus: includeTasks ? taskIdsByStatus : null,
      agents,
	      pendingAsks,
	      controller,
	      recoveredFromJournal: record?.recoveredFromJournal === true || durableSnapshot?.recoveredFromJournal === true,
	      orphanedAt: record?.orphanedAt ?? durableSnapshot?.orphanedAt ?? null,
	      orphanedReason: record?.orphanedReason ?? durableSnapshot?.orphanedReason ?? null,
	      resumedFromRunId,
	      resumedIntoRunId,
	      resume,
	      message,
	    };
	  }

  async #onCdxStatus(id, args) {
    const input = isObject(args) ? args : {};
    const runId =
      typeof input.runId === 'string' && input.runId.trim()
        ? input.runId.trim()
        : typeof input.run_id === 'string' && input.run_id.trim()
          ? input.run_id.trim()
          : this.latestRunId;

    if (
      BACKGROUND_BACKEND_ENABLED
      && !IS_BACKGROUND_BACKEND_PROCESS
      && (
        (runId && !this.runHistory.has(runId))
        || (!runId && this.runHistory.size === 0)
      )
    ) {
      const autoStart = await hasPersistedBackgroundRecoveryState({
        registryPath: BACKGROUND_BACKEND_REGISTRY_PATH,
        journalPath: this.runJournalPath,
      });
      const proxied = await this.#proxyBackgroundToolResponse(id, 'cdx.status', input, {
        autoStart,
      });
      if (proxied) return;
    }

    if (!runId) {
      this.#sendResponse(id, {
        content: [{ type: 'text', text: 'No cdx run found.' }],
        structured_content: { runId: null, status: 'unknown' },
      });
      return;
    }

    let record = this.runHistory.get(runId) ?? null;
    let runState = this.stats.getRunState?.(runId) ?? null;
    let status = record?.status ?? runState?.status ?? 'unknown';

    const afterEventIdRaw =
      input.afterEventId
      ?? input.after_event_id
      ?? input.sinceEventId
      ?? input.since_event_id
      ?? input.after
      ?? input.cursor
      ?? 0;
    const afterEventId = Math.max(0, Number.parseInt(afterEventIdRaw, 10) || 0);

    const eventsLimitRaw = input.eventsLimit ?? input.events_limit ?? input.limit ?? '200';
    const eventsLimit = Math.max(0, Math.min(2000, Number.parseInt(eventsLimitRaw, 10) || 0));

    const waitMsRaw =
      input.waitMs
      ?? input.wait_ms
      ?? input.timeoutMs
      ?? input.timeout_ms
      ?? input.wait
      ?? 0;
    const waitMs = Math.max(0, Math.min(120_000, Number.parseInt(waitMsRaw, 10) || 0));

    const includeEventsCandidate = Object.hasOwn(input, 'includeEvents')
      ? input.includeEvents
      : Object.hasOwn(input, 'include_events')
        ? input.include_events
        : undefined;
    const includeEvents = includeEventsCandidate === undefined
      ? waitMs > 0
      : coerceBoolean(includeEventsCandidate);
    if (includeEventsCandidate !== undefined && includeEvents === null) {
      this.#sendError(
        id,
        -32602,
        `Unsupported includeEvents value: ${String(includeEventsCandidate)}. Expected boolean.`,
      );
      return;
    }

    const waitForRaw = input.waitFor ?? input.wait_for ?? input.wait_for_mode ?? input.wait_for_condition ?? null;
    const waitFor = typeof waitForRaw === 'string' && waitForRaw.trim()
      ? waitForRaw.trim().toLowerCase()
      : 'event';
    if (!['event', 'ask', 'asks'].includes(waitFor)) {
      this.#sendError(
        id,
        -32602,
        `Unsupported waitFor value: ${String(waitForRaw)}. Expected "event" or "ask".`,
      );
      return;
    }
    const waitForMode = waitFor === 'asks' ? 'ask' : waitFor;

    let waited = null;
    if (
      waitMs > 0 &&
      status === 'running' &&
      typeof this.stats.waitForRunEvent === 'function' &&
      typeof this.stats.getRunEvents === 'function'
    ) {
      if (waitForMode === 'ask') {
        const deadline = Date.now() + waitMs;
        const baseline = this.stats.getRunEvents(runId, 0, 0);
        const baselineLast = baseline?.lastEventId ?? 0;
        let cursorAfter = Math.max(afterEventId, baselineLast);

        const snapshotPending = () => {
          const currentRecord = this.runHistory.get(runId) ?? record;
          const pending =
            typeof currentRecord?.orchestrator?.listPendingRouterAsks === 'function'
              ? currentRecord.orchestrator.listPendingRouterAsks()
              : [];
          return Array.isArray(pending) ? pending : [];
        };

        if (snapshotPending().length > 0) {
          waited = { ok: true, timedOut: false, lastEventId: cursorAfter, reason: 'ask_already_pending' };
        } else {
          while (Date.now() < deadline) {
            const remaining = deadline - Date.now();
            const step = await this.stats.waitForRunEvent(runId, cursorAfter, remaining);
            cursorAfter = step?.lastEventId ?? cursorAfter;

            record = this.runHistory.get(runId) ?? record;
            runState = this.stats.getRunState?.(runId) ?? runState;
            status = record?.status ?? runState?.status ?? status;

            if (snapshotPending().length > 0) {
              waited = { ok: true, timedOut: false, lastEventId: cursorAfter, reason: 'ask' };
              break;
            }

            if (status !== 'running') {
              waited = { ok: true, timedOut: true, lastEventId: cursorAfter, reason: `run_${status}` };
              break;
            }

            if (step?.timedOut) {
              waited = { ok: true, timedOut: true, lastEventId: cursorAfter, reason: 'timeout' };
              break;
            }
          }

          if (!waited) {
            waited = { ok: true, timedOut: true, lastEventId: cursorAfter, reason: 'timeout' };
          }
        }
      } else {
        const cursor = this.stats.getRunEvents(runId, afterEventId, 0);
        const lastEventId = cursor?.lastEventId ?? 0;
        if (lastEventId <= afterEventId) {
          waited = await this.stats.waitForRunEvent(runId, afterEventId, waitMs);
          record = this.runHistory.get(runId) ?? record;
          runState = this.stats.getRunState?.(runId) ?? runState;
          status = record?.status ?? runState?.status ?? status;
        }
      }
    }

    let statsUrl = record?.statsUrl ?? null;

    const openDashboardRaw =
      Object.hasOwn(input, 'openDashboard')
        ? input.openDashboard
        : Object.hasOwn(input, 'open_dashboard')
          ? input.open_dashboard
          : Object.hasOwn(input, 'openStats')
            ? input.openStats
            : Object.hasOwn(input, 'open_stats')
              ? input.open_stats
              : undefined;
    const openDashboard = openDashboardRaw === undefined ? false : coerceBoolean(openDashboardRaw);
    if (openDashboardRaw !== undefined && openDashboard === null) {
      this.#sendError(
        id,
        -32602,
        `Unsupported openDashboard value: ${String(openDashboardRaw)}. Expected boolean.`,
      );
      return;
    }

    let dashboardOpened = null;
    let dashboardOpenError = null;
    if (openDashboard) {
      try {
        const dashboardBaseUrl = await this.#ensureStatsDashboardBaseUrl();
        const derived = statsUrl ?? this.#statsUrlForRun(dashboardBaseUrl, runId);
        if (derived) {
          statsUrl = derived;
          if (record && !record.statsUrl) record.statsUrl = derived;
        }

        if (!statsUrl) {
          dashboardOpened = false;
          dashboardOpenError = 'stats_disabled';
        } else {
          dashboardOpened = await this.stats.openUrl(statsUrl);
          if (!dashboardOpened) dashboardOpenError = 'open_failed';
        }
      } catch (err) {
        dashboardOpened = false;
        dashboardOpenError = err instanceof Error ? err.message : String(err ?? 'open_failed');
      }
    }

    const eventsCursor = typeof this.stats.getRunEvents === 'function'
      ? this.stats.getRunEvents(runId, afterEventId, includeEvents ? eventsLimit : 0)
      : { items: [], next: afterEventId, lastEventId: 0 };
    const events = includeEvents ? eventsCursor.items : null;
    const lastEventId = eventsCursor.lastEventId ?? 0;

    if (waitMs > 0 && !waited) {
      const supportsWait =
        typeof this.stats.waitForRunEvent === 'function' && typeof this.stats.getRunEvents === 'function';
      waited = {
        ok: true,
        timedOut: true,
        lastEventId,
        reason: status !== 'running' ? `run_${status}` : supportsWait ? 'no_wait_performed' : 'not_supported',
      };
    }

    const includeTasksCandidate = Object.hasOwn(input, 'includeTasks')
      ? input.includeTasks
      : Object.hasOwn(input, 'include_tasks')
        ? input.include_tasks
        : undefined;
    const includeAgentsCandidate = Object.hasOwn(input, 'includeAgents')
      ? input.includeAgents
      : Object.hasOwn(input, 'include_agents')
        ? input.include_agents
        : undefined;
    const includeAsksCandidate = Object.hasOwn(input, 'includeAsks')
      ? input.includeAsks
      : Object.hasOwn(input, 'include_asks')
        ? input.include_asks
        : undefined;

    const includeTasks = includeTasksCandidate === undefined
      ? true
      : coerceBoolean(includeTasksCandidate);
    if (includeTasksCandidate !== undefined && includeTasks === null) {
      this.#sendError(
        id,
        -32602,
        `Unsupported includeTasks value: ${String(includeTasksCandidate)}. Expected boolean.`,
      );
      return;
    }

    const includeAgents = includeAgentsCandidate === undefined
      ? false
      : coerceBoolean(includeAgentsCandidate);
    if (includeAgentsCandidate !== undefined && includeAgents === null) {
      this.#sendError(
        id,
        -32602,
        `Unsupported includeAgents value: ${String(includeAgentsCandidate)}. Expected boolean.`,
      );
      return;
    }

    const includeAsks = includeAsksCandidate === undefined
      ? true
      : coerceBoolean(includeAsksCandidate);
    if (includeAsksCandidate !== undefined && includeAsks === null) {
      this.#sendError(
        id,
        -32602,
        `Unsupported includeAsks value: ${String(includeAsksCandidate)}. Expected boolean.`,
      );
      return;
    }

    const snapshot = this.#snapshotRunStatus({
      runId,
      record,
      runState,
      includeTasks,
      includeAgents,
      includeAsks,
    });
	    let message = snapshot.controller
	      ? `${snapshot.message} ${formatRunControllerText({
	          runId,
	          background: snapshot.controller?.returnControlToUser === true,
	          hasPendingAsk: Array.isArray(snapshot.pendingAsks) && snapshot.pendingAsks.length > 0,
	        })}`
	      : snapshot.message;
	    if (snapshot.resume) {
	      message = `${message} ${formatRunResumeText({
	        runId,
	        resumedIntoRunId: snapshot.resumedIntoRunId,
	      })}`;
	    }

	    this.#sendResponse(id, {
	      content: [{ type: 'text', text: message }],
      structured_content: {
        runId,
        status: snapshot.status,
        phase: snapshot.phase,
        statsUrl,
        dashboardOpened,
        dashboardOpenError,
        elapsedMs: snapshot.elapsedMs,
        etaMs: snapshot.etaMs,
        counts: snapshot.counts,
        summary: snapshot.summary,
        tasks: snapshot.tasks,
        checklist: snapshot.checklist,
        taskIdsByStatus: snapshot.taskIdsByStatus,
        agents: snapshot.agents,
        pendingAsks: snapshot.pendingAsks,
	        recoveredFromJournal: snapshot.recoveredFromJournal,
	        orphanedAt: snapshot.orphanedAt,
	        orphanedReason: snapshot.orphanedReason,
	        resumedFromRunId: snapshot.resumedFromRunId,
	        resumedIntoRunId: snapshot.resumedIntoRunId,
	        resume: snapshot.resume,
	        controller: snapshot.controller,
	        events,
        afterEventId,
        lastEventId,
        waited,
      },
    });
  }

  #normaliseArguments(args) {
    const prompt = args?.prompt;
    const targets = Array.isArray(args?.targets) ? args.targets : undefined;
    const checklist = Array.isArray(args?.checklist) ? args.checklist : undefined;
    const workflowMode =
      args?.workflowMode
      ?? args?.workflow_mode
      ?? args?.mode;
    const orchestrationMode =
      args?.orchestrationMode
      ?? args?.orchestration_mode;
    const continuous =
      args?.continuous
      ?? args?.repeat
      ?? args?.repeatForever
      ?? args?.repeat_forever;
    const maxCycles = args?.maxCycles ?? args?.max_cycles;
    const outputRoot = args?.outputRoot ?? args?.output_root;
    const sourceSystems =
      args?.sourceSystems
      ?? args?.source_systems
      ?? args?.sources
      ?? args?.sourceHints
      ?? args?.source_hints;
    const artifactLocation =
      args?.artifactLocation
      ?? args?.artifact_location
      ?? args?.recordTo
      ?? args?.record_to
      ?? args?.destination;
    const artifactFormat =
      args?.artifactFormat
      ?? args?.artifact_format
      ?? args?.outputFormat
      ?? args?.output_format;
    const artifactInstructions =
      args?.artifactInstructions
      ?? args?.artifact_instructions
      ?? args?.recordingInstructions
      ?? args?.recording_instructions;
    const repoRoot =
      args?.repoRoot
      ?? args?.repo_root
      ?? args?.repo
      ?? args?.repoPath
      ?? args?.repo_path
      ?? args?.projectRoot
      ?? args?.project_root;
    const maxParallelism = args?.maxParallelism ?? args?.max_parallelism;
    const minParallelism =
      args?.minParallelism
      ?? args?.min_parallelism
      ?? args?.minPar
      ?? args?.min_par
      ?? args?.minAgents
      ?? args?.min_agents;
    const concurrency =
      args?.concurrency ?? args?.concurrencyLevel ?? args?.concurrency_level;
    const autoscale =
      args?.autoscale
      ?? args?.autoScale
      ?? args?.autoscaleParallelism
      ?? args?.autoscale_parallelism
      ?? args?.auto_scale;
    const includeSummary =
      args?.includeSummary ?? args?.include_summary ?? args?.['include-summary'];
    const plannerPrompt =
      args?.plannerPrompt ?? args?.planner_prompt ?? args?.['planner-prompt'];
    const skipPlanner =
      args?.skipPlanner
      ?? args?.skip_planner
      ?? args?.skipPlanning
      ?? args?.skip_planning
      ?? args?.skipPlan
      ?? args?.skip_plan;
    const model = args?.model;
    const plannerModel =
      args?.plannerModel
      ?? args?.planner_model
      ?? args?.plannerModelId
      ?? args?.planner_model_id;
    const taskModel =
      args?.taskModel
      ?? args?.task_model
      ?? args?.taskModelId
      ?? args?.task_model_id;
    const watchdogModel =
      args?.watchdogModel
      ?? args?.watchdog_model
      ?? args?.watchdogModelId
      ?? args?.watchdog_model_id;
    const effort =
      args?.effort
      ?? args?.reasoningEffort
      ?? args?.reasoning_effort
      ?? args?.modelReasoningEffort
      ?? args?.model_reasoning_effort;
    const plannerEffort =
      args?.plannerEffort
      ?? args?.planner_effort
      ?? args?.plannerReasoningEffort
      ?? args?.planner_reasoning_effort
      ?? args?.plannerModelReasoningEffort
      ?? args?.planner_model_reasoning_effort;
    const taskEffort =
      args?.taskEffort
      ?? args?.task_effort
      ?? args?.taskReasoningEffort
      ?? args?.task_reasoning_effort
      ?? args?.taskModelReasoningEffort
      ?? args?.task_model_reasoning_effort;
    const judgeEffort =
      args?.judgeEffort
      ?? args?.judge_effort
      ?? args?.judgeReasoningEffort
      ?? args?.judge_reasoning_effort
      ?? args?.judgeModelReasoningEffort
      ?? args?.judge_model_reasoning_effort;
    const watchdogEffort =
      args?.watchdogEffort
      ?? args?.watchdog_effort
      ?? args?.watchdogReasoningEffort
      ?? args?.watchdog_reasoning_effort
      ?? args?.watchdogModelReasoningEffort
      ?? args?.watchdog_model_reasoning_effort;
    const sandbox = args?.sandbox ?? args?.sandboxMode ?? args?.sandbox_mode;

    const webSearchCached =
      args?.webSearchCached ?? args?.web_search_cached ?? args?.webSearchCachedOnly;
    const webSearch =
      args?.webSearch
      ?? args?.web_search
      ?? args?.webSearchMode
      ?? args?.web_search_mode
      ?? (webSearchCached ? 'cached' : undefined);

    const analyticsEnabled = args?.analyticsEnabled ?? args?.analytics_enabled;
    const analytics = args?.analytics;

    const integrationVerify =
      args?.integrationVerify
      ?? args?.integration_verify
      ?? args?.checkpointVerify
      ?? args?.checkpoint_verify
      ?? args?.verifyIntegration
      ?? args?.verify_integration;

	    const review =
	      args?.review
	      ?? args?.autoReview
	      ?? args?.auto_review
	      ?? args?.reviewStart
	      ?? args?.review_start
	      ?? args?.integrationReview
	      ?? args?.integration_review;

	    const smartSpawn =
	      args?.smartSpawn
	      ?? args?.smart_spawn
	      ?? args?.smartspawn
	      ?? args?.['smart-spawn']
	      ?? args?.smart_spawn_enabled;
	    const repoIndex = args?.repoIndex ?? args?.repo_index;
	    const avoidOverlap = args?.avoidOverlap ?? args?.avoid_overlap;
    const scout =
      args?.scout
      ?? args?.scoutEnabled
      ?? args?.scout_enabled
      ?? args?.scoutMode
      ?? args?.scout_mode;
	    const waveCheckpoint =
	      args?.waveCheckpoint ?? args?.wave_checkpoint ?? args?.waveCheckpointEnabled;
    const maxWaves = args?.maxWaves ?? args?.max_waves;
    const checkpointValidate =
      args?.checkpointValidate ?? args?.checkpoint_validate ?? args?.checkpointValidation;
    const validateCmd =
      args?.validateCmd ?? args?.validate_cmd ?? args?.validateCommand ?? args?.validate_command;
    const recoveryEnabled = args?.recoveryEnabled ?? args?.recovery_enabled;
    const parallelToolCalls =
      args?.parallelToolCalls ?? args?.parallel_tool_calls ?? args?.parallelToolcalls;

	    const parseBooleanFlag = value => {
	      const coerced = coerceBoolean(value);
	      return coerced === null ? undefined : coerced;
	    };

    const resolvedSmartSpawn = parseBooleanFlag(smartSpawn);
    const resolvedRepoIndex = parseBooleanFlag(repoIndex);
    const resolvedAvoidOverlap = parseBooleanFlag(avoidOverlap);
    const resolvedScout = parseBooleanFlag(scout);
    const resolvedWaveCheckpoint = parseBooleanFlag(waveCheckpoint) ?? false;
    const resolvedCheckpointValidate = parseBooleanFlag(checkpointValidate) ?? false;
    const resolvedRecoveryEnabled = parseBooleanFlag(recoveryEnabled) ?? false;
    const resolvedParallelToolCalls = parseBooleanFlag(parallelToolCalls) ?? false;
    const resolvedSkipPlanner = parseBooleanFlag(skipPlanner);

    const parsedConcurrency = Number.parseInt(concurrency, 10);
    const resolvedConcurrency =
      Number.isFinite(parsedConcurrency) && parsedConcurrency > 0 ? parsedConcurrency : undefined;

    let resolvedMaxParallelism = maxParallelism;
    let resolvedMinParallelism = minParallelism;
    if (resolvedConcurrency !== undefined) {
      if (resolvedMaxParallelism === undefined || resolvedMaxParallelism === null) {
        resolvedMaxParallelism = resolvedConcurrency;
      }
      if (resolvedMinParallelism === undefined || resolvedMinParallelism === null) {
        resolvedMinParallelism = resolvedConcurrency;
      }
    }

    const parsedMaxWaves = Number.parseInt(maxWaves, 10);
    const resolvedMaxWaves =
      Number.isFinite(parsedMaxWaves) && parsedMaxWaves > 0 ? parsedMaxWaves : maxWaves;

    const resolvedValidateCmd = Array.isArray(validateCmd)
      ? validateCmd.map(item => String(item)).filter(Boolean)
      : typeof validateCmd === 'string'
        ? validateCmd
        : undefined;

    return {
      prompt,
      targets,
      checklist,
      workflowMode,
      orchestrationMode,
      continuous,
      maxCycles,
      outputRoot,
      sourceSystems,
      artifactLocation,
      artifactFormat,
      artifactInstructions,
      repoRoot,
      maxParallelism: resolvedMaxParallelism,
      minParallelism: resolvedMinParallelism,
      concurrency: resolvedConcurrency,
      autoscale,
      includeSummary,
      plannerPrompt,
      skipPlanner: resolvedSkipPlanner,
      model,
      plannerModel,
      taskModel,
      watchdogModel,
      effort,
      plannerEffort,
      taskEffort,
      judgeEffort,
      watchdogEffort,
      sandbox,
      webSearch,
      analyticsEnabled,
      analytics,
      integrationVerify,
      review,
      smartSpawn: resolvedSmartSpawn,
      repoIndex: resolvedRepoIndex,
      avoidOverlap: resolvedAvoidOverlap,
      scout: resolvedScout,
      waveCheckpoint: resolvedWaveCheckpoint,
      maxWaves: resolvedMaxWaves,
      checkpointValidate: resolvedCheckpointValidate,
      validateCmd: resolvedValidateCmd,
      recoveryEnabled: resolvedRecoveryEnabled,
      parallelToolCalls: resolvedParallelToolCalls,
    };
  }

  #sendResponse(id, result) {
    const direct = this.directToolCalls.get(id);
    if (direct) {
      this.directToolCalls.delete(id);
      direct.resolve({
        ok: true,
        result,
        notifications: Array.isArray(direct.notifications) ? direct.notifications : [],
      });
      return;
    }
    this.#writeTransport({ jsonrpc: '2.0', id, result });
  }

  #sendError(id, code, message) {
    const direct = this.directToolCalls.get(id);
    if (direct) {
      this.directToolCalls.delete(id);
      direct.resolve({
        ok: false,
        error: {
          code,
          message,
        },
        notifications: Array.isArray(direct.notifications) ? direct.notifications : [],
      });
      return;
    }
    this.#writeTransport({
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message,
      },
    });
  }

  #sendNotification(method, params) {
    this.#writeTransport({ jsonrpc: '2.0', method, params });
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

  #buildChecklistClarificationText(payload) {
    const questions = Array.isArray(payload?.questions) ? payload.questions : [];
    const lines = [
      'Checklist input needs clarification before CDX can start the run.',
    ];
    if (typeof payload?.summary === 'string' && payload.summary.trim()) {
      lines.push(payload.summary.trim());
    }
    if (questions.length > 0) {
      lines.push('', 'Please answer these questions and call cdx.spawn/cdx.run again with the completed fields:');
      for (const question of questions) {
        const line = typeof question?.question === 'string' ? question.question.trim() : '';
        if (!line) continue;
        lines.push(`- ${line}`);
        if (typeof question?.expectedFormat === 'string' && question.expectedFormat.trim()) {
          lines.push(`  Expected: ${question.expectedFormat.trim()}`);
        }
      }
    }
    return lines.join('\n');
  }

  #sendChecklistClarificationResponse(id, payload) {
    const text = this.#buildChecklistClarificationText(payload);
    this.#sendResponse(id, {
      content: [{ type: 'text', text }],
      structured_content: {
        status: 'needs_clarification',
        mode: 'checklist',
        needsClarification: true,
        ...payload,
      },
    });
  }

  sendUnhandledTransportError(id, error) {
    const message = error instanceof Error ? error.message : String(error ?? 'Unknown error');
    this.#sendError(id, -32603, message);
  }

		  #toolDescriptors() {
		    return [
		      this.#toolDescriptorSpawn(),
	      this.#toolDescriptorResume(),
	      this.#toolDescriptorCdx(),
		      this.#toolDescriptorHelp(),
		      this.#toolDescriptorPs(),
		      this.#toolDescriptorRollback(),
		      this.#toolDescriptorThreadFork(),
	      this.#toolDescriptorRequirements(),
	      this.#toolDescriptorMetrics(),
	      this.#toolDescriptorWebui(),
      this.#toolDescriptorStatsTest(),
	      this.#toolDescriptorPendingAsks(),
      this.#toolDescriptorRouterAnswer(),
      this.#toolDescriptorAgentMessage(),
      this.#toolDescriptorSteer(),
      this.#toolDescriptorAgentInbox(),
      this.#toolDescriptorTaskAbort(),
      this.#toolDescriptorConfig(),
      this.#toolDescriptorLogs(),
      this.#toolDescriptorStatus(),
		    ];
		  }

  #toolDescriptorCdx() {
    return {
      name: 'run',
      title: 'CDX Run (Advanced)',
      description:
        'Advanced/manual orchestrator entrypoint. Prefer cdx.spawn for the default handoff flow because it returns an immediate status snapshot and gives control back to the user while CDX executes the run. Use cdx.run when you explicitly want blocking or lower-level control over the orchestrator. After you call this, CDX owns execution for that goal: do not duplicate the same implementation locally in the caller thread; either supervise with cdx.status or return control to the user.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          prompt: {
            type: 'string',
            description: 'Optional high-level instruction for the orchestrator to accomplish.',
          },
          targets: {
            type: 'array',
            description:
              'Checklist workload targets. Providing both targets and checklist enables checklist mode.',
            items: {
              anyOf: [
                { type: 'string' },
                {
                  type: 'object',
                  additionalProperties: true,
                  properties: {
                    id: { type: 'string' },
                    label: { type: 'string' },
                    title: { type: 'string' },
                    name: { type: 'string' },
                    description: { type: 'string' },
                    instructions: { type: 'string' },
                    prompt: { type: 'string' },
                    sources: {
                      anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' } },
                      ],
                    },
                    recordTo: { type: 'string' },
                    metadata: { type: 'object' },
                  },
                },
              ],
            },
          },
          checklist: {
            type: 'array',
            description:
              'Checklist items to run for every target. Items execute sequentially per target.',
            items: {
              anyOf: [
                { type: 'string' },
                {
                  type: 'object',
                  additionalProperties: true,
                  properties: {
                    id: { type: 'string' },
                    label: { type: 'string' },
                    title: { type: 'string' },
                    name: { type: 'string' },
                    description: { type: 'string' },
                    instructions: { type: 'string' },
                    prompt: { type: 'string' },
                    sources: {
                      anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' } },
                      ],
                    },
                    recordTo: { type: 'string' },
                    outputFormat: { type: 'string' },
                    doneWhen: { type: 'string' },
                  },
                },
              ],
            },
          },
          workflowMode: {
            type: 'string',
            enum: ['planner', 'checklist'],
            description: 'Execution mode. Use checklist to bypass the planner and run a target x item grid.',
          },
          orchestrationMode: {
            type: 'string',
            enum: ['planner', 'checklist'],
            description: 'Alias for workflowMode.',
          },
          continuous: {
            type: 'boolean',
            description:
              'When checklist mode is active, keep injecting the next cycle for a target after its last item completes.',
          },
          maxCycles: {
            type: 'integer',
            minimum: 1,
            description:
              'Optional cycle cap for checklist mode. Omit for a single cycle, or combine with continuous for repeated cycles.',
          },
          outputRoot: {
            type: 'string',
            description: 'Base directory for checklist artifacts (default: .keepdoing).',
          },
          sourceSystems: {
            anyOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
            description: 'Default source systems for checklist research steps (for example Slack, SharePoint, Confluence).',
          },
          artifactLocation: {
            type: 'string',
            description: 'Optional default destination or recording target for checklist outputs.',
          },
          artifactFormat: {
            type: 'string',
            description: 'Optional default output format hint (for example markdown, plain text, Confluence page).',
          },
          artifactInstructions: {
            type: 'string',
            description: 'Optional default instructions for how checklist artifacts should be written.',
          },
          repoRoot: {
            type: 'string',
            description:
              'Optional repository root override (useful when Codex is started outside the target git repo).',
          },
          maxParallelism: {
            type: 'integer',
            minimum: 1,
            description:
              'Maximum number of Codex task agents to run in parallel. Defaults to CDX_MAX_PARALLELISM (default 10).',
          },
          minParallelism: {
            type: 'integer',
            minimum: 1,
            description:
              'Minimum parallelism floor when autoscale is enabled. Defaults to CDX_MIN_PARALLELISM (default 3).',
          },
          concurrency: {
            type: 'integer',
            minimum: 1,
            description: 'Alias to set both maxParallelism and minParallelism to the same value.',
          },
          autoscale: {
            type: 'boolean',
            description:
              'Enable adaptive parallelism between minParallelism and maxParallelism (default: true).',
          },
          includeSummary: {
            type: 'boolean',
            description: 'Whether to include a final summary (default: true).',
          },
          background: {
            type: 'boolean',
            description: 'Return immediately after starting the run (continue in background).',
          },
          integrationVerify: {
            type: 'boolean',
            description:
              'Optional integration checkpoint agent that runs validation (tests/lint) after merging (default: false; can also be enabled via CDX_INTEGRATION_VERIFY=1).',
          },
          review: {
            type: 'boolean',
            description:
              'Optional post-run review step using app-server review/start (default: false; can also be enabled via CDX_REVIEW=1).',
          },
          plannerPrompt: {
            type: 'string',
            description: 'Optional planner instructions prepended to the planning step.',
          },
          skipPlanner: {
            type: 'boolean',
            description: 'Skip the planner stage and run a single fallback task (best for serial runs).',
          },
          runId: {
            type: 'string',
            description: 'Optional run id override (advanced).',
          },
          model: {
            type: 'string',
            description: 'Optional model override for all child threads.',
          },
          plannerModel: {
            type: 'string',
            description: 'Optional model override for planner turns (planning/replanning).',
          },
          taskModel: {
            type: 'string',
            description: 'Optional model override for task worker turns.',
          },
          watchdogModel: {
            type: 'string',
            description: 'Optional model override for watchdog diagnosis turns.',
          },
          effort: {
            type: 'string',
            description:
              'Optional reasoning effort override for turns (e.g. low/medium/high/xhigh).',
          },
          plannerEffort: {
            type: 'string',
            description:
              'Optional reasoning effort override for planner turns (planning/replanning).',
          },
          taskEffort: {
            type: 'string',
            description: 'Optional reasoning effort override for task worker turns.',
          },
          judgeEffort: {
            type: 'string',
            description: 'Optional reasoning effort override for judge sessions.',
          },
          watchdogEffort: {
            type: 'string',
            description:
              'Optional base reasoning effort for watchdog turns; escalates by wave until capped.',
          },
          sandbox: {
            type: 'string',
            enum: ['read-only', 'workspace-write', 'danger-full-access'],
            description:
              'Optional sandbox override for child threads (default: CDX_SANDBOX or workspace-write).',
          },
          webSearch: {
            type: 'string',
            enum: ['off', 'cached', 'on'],
            description:
              'Optional web search mode for child threads. cached uses cached-only behavior when supported by Codex.',
          },
          webSearchCached: {
            type: 'boolean',
            description: 'Alias for webSearch=cached.',
          },
          analyticsEnabled: {
            type: 'boolean',
            description:
              'Optional analytics collection toggle via config (analytics.enabled) when supported by Codex.',
          },
          analytics: {
            type: 'object',
            additionalProperties: false,
            properties: {
              enabled: { type: 'boolean' },
            },
            description: 'Alias container for analyticsEnabled.',
          },
          smartSpawn: {
            type: 'boolean',
            description: 'Enable smart spawn heuristics (opt-in, default: false).',
          },
          repoIndex: {
            type: 'boolean',
            description: 'Enable repo index usage for planner/tasks (opt-in, default: false).',
          },
          avoidOverlap: {
            type: 'boolean',
            description: 'Reduce task overlap when smart spawn is enabled (opt-in, default: false).',
          },
          scout: {
            type: 'boolean',
            description:
              'Run a lightweight repo scout summary before planning to reduce redundant exploration (opt-in, default: false).',
          },
          waveCheckpoint: {
            type: 'boolean',
            description: 'Enable wave-level checkpoints for smart spawn (opt-in, default: false).',
          },
          maxWaves: {
            type: 'integer',
            minimum: 1,
            description: 'Optional cap on waves when waveCheckpoint is enabled.',
          },
          checkpointValidate: {
            type: 'boolean',
            description: 'Run validation command at checkpoints (opt-in, default: false).',
          },
          validateCmd: {
            type: ['string', 'array'],
            items: { type: 'string' },
            description:
              'Validation command to run when checkpointValidate is enabled. Accepts string or array of args.',
          },
          recoveryEnabled: {
            type: 'boolean',
            description: 'Enable recovery flow for smart spawn (opt-in, default: false).',
          },
          parallelToolCalls: {
            type: 'boolean',
            description: 'Allow parallel tool calls for spawned agents (opt-in, default: false).',
          },
        },
      },
    };
  }

  #toolDescriptorSpawn() {
    return {
      name: 'spawn',
      title: 'CDX Spawn (Primary)',
      description:
        'Primary entrypoint for CDX orchestration. Ensures a minimum parallelism (or range), defaults to background execution, returns an immediate status snapshot, and gives control back to the user while CDX executes the run. If prompt is omitted, reuses the latest CDX run prompt. Subsequent spawn calls reuse the latest spawn run unless force=true. After you call this, CDX owns execution for that run: do not implement the same task locally in the caller thread; either return control to the user or supervise with cdx.status.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          range: {
            type: 'string',
            description: 'Optional shorthand range string "MIN-MAX" (example: "4-10").',
          },
          parallelism: {
            type: 'integer',
            minimum: 1,
            description: 'Shorthand minimum parallelism (e.g. 10).',
          },
          concurrency: {
            type: 'integer',
            minimum: 1,
            description: 'Alias for minimum parallelism (same as parallelism).',
          },
          force: {
            type: 'boolean',
            description: 'Allow starting a new spawn run even if one already started (default: false).',
          },
          background: {
            type: 'boolean',
            description: 'Return immediately after starting the run (continue in background).',
          },
          backgroundJob: {
            type: 'boolean',
            description:
              'Start the run asynchronously after replying (experimental; default: true for spawn).',
          },
          prompt: { type: 'string' },
          targets: {
            type: 'array',
            items: {
              anyOf: [
                { type: 'string' },
                {
                  type: 'object',
                  additionalProperties: true,
                  properties: {
                    id: { type: 'string' },
                    label: { type: 'string' },
                    title: { type: 'string' },
                    name: { type: 'string' },
                    description: { type: 'string' },
                    instructions: { type: 'string' },
                    prompt: { type: 'string' },
                    sources: {
                      anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' } },
                      ],
                    },
                    recordTo: { type: 'string' },
                    metadata: { type: 'object' },
                  },
                },
              ],
            },
          },
          checklist: {
            type: 'array',
            items: {
              anyOf: [
                { type: 'string' },
                {
                  type: 'object',
                  additionalProperties: true,
                  properties: {
                    id: { type: 'string' },
                    label: { type: 'string' },
                    title: { type: 'string' },
                    name: { type: 'string' },
                    description: { type: 'string' },
                    instructions: { type: 'string' },
                    prompt: { type: 'string' },
                    sources: {
                      anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' } },
                      ],
                    },
                    recordTo: { type: 'string' },
                    outputFormat: { type: 'string' },
                    doneWhen: { type: 'string' },
                  },
                },
              ],
            },
          },
          workflowMode: { type: 'string', enum: ['planner', 'checklist'] },
          orchestrationMode: { type: 'string', enum: ['planner', 'checklist'] },
          continuous: { type: 'boolean' },
          maxCycles: { type: 'integer', minimum: 1 },
          outputRoot: { type: 'string' },
          sourceSystems: {
            anyOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
          },
          artifactLocation: { type: 'string' },
          artifactFormat: { type: 'string' },
          artifactInstructions: { type: 'string' },
          repoRoot: { type: 'string' },
          maxParallelism: { type: 'integer', minimum: 1 },
          minParallelism: { type: 'integer', minimum: 1 },
          autoscale: { type: 'boolean' },
          includeSummary: { type: 'boolean' },
          integrationVerify: { type: 'boolean' },
          review: { type: 'boolean' },
          plannerPrompt: { type: 'string' },
          skipPlanner: {
            type: 'boolean',
            description: 'Skip the planner stage and run a single fallback task (best for serial runs).',
          },
          model: { type: 'string' },
          plannerModel: { type: 'string' },
          taskModel: { type: 'string' },
          watchdogModel: { type: 'string' },
          effort: { type: 'string' },
          plannerEffort: { type: 'string' },
          taskEffort: { type: 'string' },
          judgeEffort: { type: 'string' },
          watchdogEffort: { type: 'string' },
          sandbox: {
            type: 'string',
            enum: ['read-only', 'workspace-write', 'danger-full-access'],
          },
          webSearch: { type: 'string', enum: ['off', 'cached', 'on'] },
          webSearchCached: { type: 'boolean' },
          analyticsEnabled: { type: 'boolean' },
          analytics: {
            type: 'object',
            additionalProperties: false,
            properties: { enabled: { type: 'boolean' } },
          },
          smartSpawn: { type: 'boolean' },
          repoIndex: { type: 'boolean' },
          avoidOverlap: { type: 'boolean' },
          scout: { type: 'boolean' },
          waveCheckpoint: { type: 'boolean' },
          maxWaves: { type: 'integer', minimum: 1 },
          checkpointValidate: { type: 'boolean' },
          validateCmd: { type: ['string', 'array'], items: { type: 'string' } },
          recoveryEnabled: { type: 'boolean' },
          parallelToolCalls: { type: 'boolean' },
        },
      },
    };
	  }

	  #toolDescriptorResume() {
	    return {
	      name: 'resume',
	      title: 'CDX Resume',
	      description:
	        'Restart a new run from an orphaned run using the saved input and durable coordinator/task ledger. This is the explicit recovery path after detached backend loss or process death.',
	      inputSchema: {
	        type: 'object',
	        additionalProperties: true,
	        required: ['runId'],
	        properties: {
	          runId: {
	            type: 'string',
	            description: 'Orphaned run id to resume.',
	          },
	          force: {
	            type: 'boolean',
	            description: 'Start another resumed run even if this orphaned run was already resumed before.',
	          },
	          background: {
	            type: 'boolean',
	            description: 'Return immediately after starting the resumed run (default: true).',
	          },
	          backgroundJob: {
	            type: 'boolean',
	            description: 'Start the resumed run asynchronously after replying (default: same as background).',
	          },
	          prompt: {
	            type: 'string',
	            description: 'Optional replacement goal. Defaults to the original run prompt.',
	          },
	          plannerPrompt: {
	            type: 'string',
	            description: 'Optional extra planner instructions appended ahead of the resume ledger.',
	          },
	          range: {
	            type: 'string',
	            description: 'Optional shorthand range string "MIN-MAX" for resumed parallelism.',
	          },
	          parallelism: {
	            type: 'integer',
	            minimum: 1,
	            description: 'Optional shorthand minimum parallelism for the resumed run.',
	          },
	          maxParallelism: {
	            type: 'integer',
	            minimum: 1,
	            description: 'Optional max parallelism override for the resumed run.',
	          },
	          minParallelism: {
	            type: 'integer',
	            minimum: 1,
	            description: 'Optional min parallelism override for the resumed run.',
	          },
	        },
	      },
	    };
	  }

	  #toolDescriptorHelp() {
	    return {
	      name: 'help',
			      title: 'CDX Help',
			      description: 'Show usage information for CDX MCP tools.',
			      inputSchema: {
			        type: 'object',
			        additionalProperties: false,
			        properties: {},
			      },
			    };
			  }

			  #toolDescriptorPs() {
			    return {
			      name: 'ps',
			      title: 'CDX PS',
			      description: 'List currently running CDX runs and their dashboard URLs.',
			      inputSchema: {
			        type: 'object',
			        additionalProperties: false,
			        properties: {},
		      },
		    };
		  }

  #toolDescriptorRollback() {
    return {
      name: 'rollback',
      title: 'CDX Rollback',
      description:
        'Rollback the last N turns of a task thread (if supported by the Codex app-server protocol).',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string', description: 'Target run id (defaults to latest run).' },
          taskId: { type: 'string', description: 'Task id to rollback (optional).' },
          threadId: { type: 'string', description: 'Thread id to rollback (optional).' },
          turns: { type: 'integer', minimum: 1, description: 'How many turns to rollback.' },
          model: { type: 'string', description: 'Optional model override for resume.' },
          sandbox: {
            type: 'string',
            enum: ['read-only', 'workspace-write', 'danger-full-access'],
            description: 'Optional sandbox override for resume.',
          },
          webSearch: { type: 'string', enum: ['off', 'cached', 'on'] },
          analyticsEnabled: { type: 'boolean' },
          analytics: {
            type: 'object',
            additionalProperties: false,
            properties: { enabled: { type: 'boolean' } },
          },
        },
      },
    };
  }

  #toolDescriptorThreadFork() {
    return {
      name: 'thread_fork',
      title: 'CDX Thread Fork',
      description:
        'Fork a task thread into a new thread (if supported by the Codex app-server protocol).',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string', description: 'Target run id (defaults to latest run).' },
          taskId: { type: 'string', description: 'Task id to fork (optional).' },
          threadId: { type: 'string', description: 'Thread id to fork (optional).' },
          path: { type: 'string', description: 'Optional rollout path to fork from (advanced).' },
          cwd: { type: 'string', description: 'Optional cwd override for the forked thread.' },
          model: { type: 'string', description: 'Optional model override for the forked thread.' },
          sandbox: {
            type: 'string',
            enum: ['read-only', 'workspace-write', 'danger-full-access'],
            description: 'Optional sandbox override for the forked thread.',
          },
          webSearch: { type: 'string', enum: ['off', 'cached', 'on'] },
          analyticsEnabled: { type: 'boolean' },
          analytics: {
            type: 'object',
            additionalProperties: false,
            properties: { enabled: { type: 'boolean' } },
          },
        },
      },
    };
  }

  #toolDescriptorRequirements() {
    return {
      name: 'requirements',
      title: 'CDX Requirements',
      description:
        'Fetch the loaded requirements allow-lists (requirements.toml/MDM) via configRequirements/read.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string', description: 'Optional run id for log attribution.' },
        },
      },
    };
  }

  #toolDescriptorMetrics() {
    return {
      name: 'metrics',
      title: 'CDX Metrics',
      description: 'Return Prometheus/OpenTelemetry metrics from the stats server.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string', description: 'Target run id (defaults to latest run).' },
          format: {
            type: 'string',
            enum: ['prometheus', 'otel'],
            description: 'Metrics output format (default: prometheus).',
          },
        },
      },
    };
  }

  #toolDescriptorWebui() {
    return {
      name: 'webui',
      title: 'CDX Web UI',
      description: 'Start the stats web UI backend and return the URL.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string', description: 'Optional run id to select in the UI.' },
          open: {
            type: 'boolean',
            description: 'Open the stats URL in a browser (default: true).',
          },
        },
      },
    };
  }

  #toolDescriptorStatsTest() {
    return {
      name: 'stats_test',
      title: 'CDX Stats Test UI',
      description:
        'Seed a synthetic stats run (workers + tasks) and open the stats UI in debug-friendly test mode.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string', description: 'Synthetic run id (default: stats-test).' },
          workers: {
            type: 'integer',
            minimum: 1,
            maximum: 64,
            description: 'Number of synthetic running workers to seed (default: 10).',
          },
          repoRoot: {
            type: 'string',
            description: 'Repo root used for git graph/tree rendering (defaults to current repository).',
          },
          tab: {
            type: 'string',
            enum: ['logs', 'api', 'worktree'],
            description: 'Initial tab to open in UI (default: worktree).',
          },
          open: {
            type: 'boolean',
            description: 'Open the stats URL in a browser (default: true).',
          },
        },
      },
    };
  }

  #toolDescriptorPendingAsks() {
    return {
      name: 'pending_asks',
      title: 'CDX Pending Router Asks',
      description: 'List pending router.ask requests that are waiting for a supervisor response.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string', description: 'Run id to query (defaults to most recent).' },
        },
      },
    };
  }

  #toolDescriptorRouterAnswer() {
    return {
      name: 'router_answer',
      title: 'CDX Router Answer',
      description:
        'Answer a pending router.ask request (supervised mode). Unblocks the waiting worker tool call immediately.',
      inputSchema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          runId: { type: 'string', description: 'Run id to answer (defaults to latest).' },
          askId: { type: 'string', description: 'askId from router.ask.pending event.' },
          answeredBy: {
            type: 'string',
            description: 'Optional label for audit (default: supervisor).',
          },
          response: {
            type: ['object', 'string'],
            description:
              'Response payload. Should include message_for_agent and optional decision object. A plain string is treated as message_for_agent.',
          },
          message_for_agent: {
            type: 'string',
            description: 'Direct message for the blocked agent. Alternative to response.',
          },
          decision: {
            type: 'object',
            additionalProperties: true,
            description: 'Convenience alias for response.decision.',
          },
        },
        required: ['askId'],
      },
    };
  }

  #toolDescriptorAgentMessage() {
    return {
      name: 'agent_message',
      title: 'CDX Agent Message',
      description:
        'Queue a supervisor message for a running task agent. The message is delivered at the next worker turn boundary (or broadcast to all tasks when taskId is omitted).',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string', description: 'Target run id (defaults to latest run).' },
          taskId: { type: 'string', description: 'Target task id. Omit to broadcast.' },
          threadId: { type: 'string', description: 'Optional thread id (mapped to task id when known).' },
          agentId: { type: 'string', description: 'Optional agent id (e.g. task:alpha).' },
          message: { type: 'string', description: 'Message text to deliver to the worker.' },
          source: { type: 'string', description: 'Optional message source label (default: supervisor).' },
        },
        required: ['message'],
      },
    };
  }

  #toolDescriptorSteer() {
    return {
      name: 'steer',
      title: 'CDX Steer',
      description:
        'Queue a supervisor message and/or inject future tasks into a running run. Messages use the existing supervisor queue; tasks are registered at runtime by the scheduler.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string', description: 'Target run id (defaults to latest run).' },
          taskId: { type: 'string', description: 'Optional task id for the message target.' },
          threadId: { type: 'string', description: 'Optional thread id (mapped to task id when known).' },
          agentId: { type: 'string', description: 'Optional agent id (e.g. task:alpha).' },
          message: { type: 'string', description: 'Optional supervisor message to queue.' },
          source: { type: 'string', description: 'Optional message/source label (default: supervisor).' },
          broadcast: {
            type: 'boolean',
            description: 'Broadcast the message instead of targeting a single task.',
          },
          task: {
            type: 'object',
            additionalProperties: true,
            description: 'Optional single future task to inject.',
            properties: {
              id: { type: 'string' },
              description: { type: 'string' },
              title: { type: 'string' },
              prompt: { type: 'string' },
              dependsOn: { type: 'array', items: { type: 'string' } },
              ownership: { type: 'object', additionalProperties: true },
            },
          },
          tasks: {
            type: 'array',
            description: 'Optional future tasks to inject into the running scheduler.',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                id: { type: 'string' },
                description: { type: 'string' },
                title: { type: 'string' },
                prompt: { type: 'string' },
                dependsOn: { type: 'array', items: { type: 'string' } },
                ownership: { type: 'object', additionalProperties: true },
              },
            },
          },
        },
      },
    };
  }

  #toolDescriptorAgentInbox() {
    return {
      name: 'agent_inbox',
      title: 'CDX Agent Inbox',
      description:
        'Inspect queued supervisor messages waiting to be delivered to task agents (and broadcast messages).',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string', description: 'Target run id (defaults to latest run).' },
          taskId: { type: 'string', description: 'Filter to a specific task id (optional).' },
          includeBroadcast: { type: 'boolean', description: 'Include broadcast message list (default: true).' },
          clear: { type: 'boolean', description: 'If true, clears the returned inbox entries.' },
        },
      },
    };
  }

  #toolDescriptorTaskAbort() {
    return {
      name: 'task_abort',
      title: 'CDX Task Abort',
      description:
        'Abort a running task immediately. This interrupts the current turn and marks the task as failed.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string', description: 'Target run id (defaults to latest run).' },
          taskId: { type: 'string', description: 'Task id to abort.' },
          reason: { type: 'string', description: 'Optional abort reason.' },
          source: { type: 'string', description: 'Optional source label for audit (default: manual).' },
        },
        required: ['taskId'],
      },
    };
  }

  #toolDescriptorConfig() {
    return {
      name: 'config',
      title: 'CDX Config',
      description:
        'Inspect layered Codex configuration sources (/etc, CODEX_HOME, project .codex/config.toml) and optionally fetch specific keys.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string', description: 'If provided, uses config loaded for that run (when available).' },
          cwd: { type: 'string', description: 'Directory to resolve project root (defaults to process cwd).' },
          keys: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional list of dot-path config keys to fetch (e.g. exec.justification, analytics.enabled).',
          },
        },
      },
    };
  }

  #toolDescriptorLogs() {
    return {
      name: 'logs',
      title: 'CDX Logs',
      description:
        'Tail per-agent logs captured by the stats server. Provide taskId to resolve agentId=task:<taskId>.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string', description: 'Run id to query (defaults to latest run).' },
          agentId: { type: 'string', description: 'Agent id to tail (default: server).' },
          taskId: { type: 'string', description: 'Optional task id to map to agentId (task:<taskId>).' },
          afterLogId: { type: 'integer', minimum: 0, description: 'Only return logs after this id (cursor).' },
          limit: { type: 'integer', minimum: 0, maximum: 2000, description: 'Max log lines to return.' },
          waitMs: {
            type: 'integer',
            minimum: 0,
            maximum: 120000,
            description: 'If set, long-poll for up to waitMs for new logs after afterLogId.',
          },
        },
      },
    };
  }

		  #toolDescriptorStatus() {
		    return {
		      name: 'status',
		      title: 'CDX Status',
		      description:
		        'Return the latest run status (or a specific runId) including counts, tasks, and summary when available.',
	      inputSchema: {
	        type: 'object',
        additionalProperties: false,
        properties: {
          runId: {
            type: 'string',
            description: 'Run id to query (defaults to most recent).',
          },
          openDashboard: {
            type: 'boolean',
            description: 'If true, attempt to open the Stats UI in a browser (best-effort).',
          },
          includeTasks: {
            type: 'boolean',
            description: 'Include per-task status details (default: true).',
          },
          includeAgents: {
            type: 'boolean',
            description: 'Include per-agent status details (default: false).',
          },
          includeAsks: {
            type: 'boolean',
            description: 'Include pending router asks (default: true).',
          },
          includeEvents: {
            type: 'boolean',
            description: 'Include recent scheduler events (default: false; auto-enabled when waitMs is set).',
          },
          waitFor: {
            type: 'string',
            enum: ['event', 'ask'],
            description:
              'When waitMs is set, what to wait for: "event" waits for any new event after afterEventId; "ask" waits until a pending router.ask exists.',
          },
          afterEventId: {
            type: 'integer',
            minimum: 0,
            description: 'Only return events after this id (cursor).',
          },
          eventsLimit: {
            type: 'integer',
            minimum: 0,
            maximum: 2000,
            description: 'Max events to return when includeEvents is true.',
          },
          waitMs: {
            type: 'integer',
            minimum: 0,
            maximum: 120000,
            description:
              'If set, long-poll for up to waitMs for a new event after afterEventId (runs only when status is running).',
          },
        },
      },
    };
  }
}

function isDirectExecution(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return path.resolve(fileURLToPath(metaUrl)) === path.resolve(process.argv[1]);
  } catch {
    return false;
  }
}

async function runDetachedBackgroundBackendServer() {
  const app = new CdxAppServerMcpServer({ transportEnabled: false });
  await app.hydratePersistedRunJournal();
  const startedAt = Date.now();
  const server = http.createServer(async (req, res) => {
    const sendJson = (statusCode, body) => {
      res.statusCode = statusCode;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(body));
    };

    try {
      const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && requestUrl.pathname === '/health') {
        sendJson(200, {
          ok: true,
          pid: process.pid,
          startedAt,
          latestRunId: app.latestRunId ?? null,
          orphanedRuns: [...app.runHistory.values()]
            .filter(record => String(record?.status ?? '').trim() === ORPHANED_RUN_STATUS)
            .map(record => record?.runId)
            .filter(Boolean),
          runningRuns: [...app.runHistory.values()]
            .filter(record => String(record?.status ?? '').trim() === 'running')
            .map(record => record?.runId)
            .filter(Boolean),
        });
        return;
      }

      if (req.method === 'POST' && requestUrl.pathname === '/tools/call') {
        const body = await readHttpJsonRequest(req);
        const name = coerceString(body?.name);
        if (!name) {
          sendJson(400, {
            ok: false,
            error: { code: -32602, message: 'missing tool name' },
          });
          return;
        }
        const response = await app.callToolDirect(name, body?.args);
        sendJson(200, response);
        return;
      }

      sendJson(404, {
        ok: false,
        error: { code: 404, message: 'not_found' },
      });
    } catch (error) {
      const statusCode = Number.isFinite(error?.statusCode) ? error.statusCode : 500;
      sendJson(statusCode, {
        ok: false,
        error: {
          code: statusCode,
          message: error instanceof Error ? error.message : String(error ?? 'unknown_error'),
        },
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(BACKGROUND_BACKEND_PORT, BACKGROUND_BACKEND_HOST, resolve);
  });

  const address = server.address();
  const host =
    typeof address === 'object' && address && typeof address.address === 'string'
      ? address.address
      : BACKGROUND_BACKEND_HOST;
  const port =
    typeof address === 'object' && address
      ? address.port
      : BACKGROUND_BACKEND_PORT;
  const registry = await writeBackgroundBackendRegistry({
    host,
    port,
    url: `http://${host}:${port}/`,
    pid: process.pid,
    startedAt,
  });

  const cleanup = async () => {
    try {
      const current = await readBackgroundBackendRegistry(registry.registryPath ?? BACKGROUND_BACKEND_REGISTRY_PATH);
      if (current?.pid === process.pid) {
        await rm(registry.registryPath ?? BACKGROUND_BACKEND_REGISTRY_PATH, { force: true });
      }
    } catch {}
  };

  process.once('SIGTERM', () => {
    server.close(() => {
      void cleanup().finally(() => process.exit(0));
    });
  });
  process.once('SIGINT', () => {
    server.close(() => {
      void cleanup().finally(() => process.exit(130));
    });
  });
}

async function startMcpTransportServer() {
  const server = new CdxAppServerMcpServer();
  const reader = new LspMessageReader(process.stdin);
  reader.onError((error, context) => {
    server.handleReaderProtocolError(error, context);
  });
  reader.onMessage(message => {
    server.framing = reader.framing ?? server.framing;
    server.handleMessage(message).catch(err => {
      server.sendUnhandledTransportError(message?.id ?? null, err);
    });
  });
}

export { AppServerCdxOrchestrator, CdxAppServerMcpServer, runDetachedBackgroundBackendServer, startMcpTransportServer };

if (isDirectExecution(import.meta.url)) {
  const runner = IS_BACKGROUND_BACKEND_PROCESS
    ? runDetachedBackgroundBackendServer
    : startMcpTransportServer;
  runner().catch(error => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error ?? 'unknown_error');
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
