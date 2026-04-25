import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { access, constants, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { AppServerClient } from '../../src/runtime/app-server-client.js';
import { resolveProjectRoot } from './package-scripts.js';

export const DEFAULT_CASE_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_CDX_STATUS_WAIT_MS = 5_000;
export const DEFAULT_CLAUDE_MAX_TURNS = 40;
export const DEFAULT_RESULTS_SUBDIR = path.join('eval', 'results');
export const DEFAULT_SAMPLE_CORPUS = path.join('eval', 'cases', 'sample.json');

const VALID_ADAPTERS = new Set(['cdx', 'claude']);

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function coerceString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parsePositiveInt(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function truncate(text, maxChars = 400) {
  const input = typeof text === 'string' ? text.trim() : '';
  if (!input) return '';
  if (input.length <= maxChars) return input;
  return `${input.slice(0, Math.max(0, maxChars - 3))}...`;
}

function uniqueStrings(values) {
  return [...new Set((values ?? []).map(value => String(value).trim()).filter(Boolean))];
}

function splitCommandArgs(value) {
  if (Array.isArray(value)) {
    return value.map(entry => String(entry));
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.map(entry => String(entry));
    }
  } catch {
    // fall back to whitespace splitting
  }
  return trimmed.split(/\s+/).map(part => part.trim()).filter(Boolean);
}

function parseListArg(value) {
  return String(value ?? '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
}

function slugify(value, fallback = 'item') {
  const slug = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

function resolvePathMaybe(baseDir, targetPath) {
  if (!targetPath) return null;
  return path.isAbsolute(targetPath) ? targetPath : path.resolve(baseDir, targetPath);
}

function sanitizeJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function nowTimestampLabel() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function fileExists(targetPath) {
  try {
    await access(targetPath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(targetPath) {
  await mkdir(targetPath, { recursive: true });
  return targetPath;
}

async function writeJson(targetPath, value) {
  await ensureDir(path.dirname(targetPath));
  await writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function resolveCommandOnPath(command) {
  const candidate = coerceString(command);
  if (!candidate) return null;
  if (candidate.includes(path.sep)) {
    return existsSync(candidate) ? candidate : null;
  }
  const searchPath = String(process.env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean);
  for (const dir of searchPath) {
    const fullPath = path.join(dir, candidate);
    if (existsSync(fullPath)) return fullPath;
  }
  return null;
}

function resolveBunCommand() {
  const fromPath = resolveCommandOnPath('bun');
  if (fromPath) return fromPath;
  const homeCandidate = path.join(os.homedir(), '.bun', 'bin', 'bun');
  return existsSync(homeCandidate) ? homeCandidate : null;
}

function defaultClaudeRepoRoot(projectRoot) {
  return path.resolve(projectRoot, '..', 'claude-code', 'claude-code-main');
}

export function parseArgs(
  argv,
  {
    projectRoot = resolveProjectRoot(import.meta.url),
    env = process.env,
    defaults = {},
  } = {},
) {
  const defaultCorpusPath = resolvePathMaybe(projectRoot, defaults.corpusPath ?? DEFAULT_SAMPLE_CORPUS);
  const defaultResultsDir = resolvePathMaybe(projectRoot, defaults.resultsDir ?? DEFAULT_RESULTS_SUBDIR);
  const defaultClaudeRoot = resolvePathMaybe(
    projectRoot,
    defaults.claudeRepoRoot ?? env.CDX_EVAL_CLAUDE_REPO ?? defaultClaudeRepoRoot(projectRoot),
  );

  const options = {
    projectRoot,
    corpusPath: defaultCorpusPath,
    resultsDir: defaultResultsDir,
    caseIds: [],
    adapters: ['cdx', 'claude'],
    keepWorkspaces: false,
    verbose: false,
    defaultTimeoutMs: parsePositiveInt(defaults.defaultTimeoutMs ?? env.CDX_EVAL_TIMEOUT_MS, null),
    cdxCommand: defaults.cdxCommand ?? env.CDX_EVAL_CDX_COMMAND ?? process.execPath,
    cdxArgs:
      splitCommandArgs(defaults.cdxArgs ?? env.CDX_EVAL_CDX_ARGS)
      ?? [path.join(projectRoot, 'src', 'cli', 'cdx-appserver-mcp-server.js')],
    claudeCommand: defaults.claudeCommand ?? env.CDX_EVAL_CLAUDE_COMMAND ?? null,
    claudeArgs: splitCommandArgs(defaults.claudeArgs ?? env.CDX_EVAL_CLAUDE_ARGS),
    claudeRepoRoot: defaultClaudeRoot,
  };

  for (const arg of argv) {
    if (arg === '--verbose') {
      options.verbose = true;
      continue;
    }
    if (arg === '--keep-workspaces') {
      options.keepWorkspaces = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg.startsWith('--corpus=')) {
      options.corpusPath = resolvePathMaybe(projectRoot, arg.slice('--corpus='.length));
      continue;
    }
    if (arg.startsWith('--results-dir=')) {
      options.resultsDir = resolvePathMaybe(projectRoot, arg.slice('--results-dir='.length));
      continue;
    }
    if (arg.startsWith('--case=')) {
      options.caseIds.push(...parseListArg(arg.slice('--case='.length)));
      continue;
    }
    if (arg.startsWith('--adapter=')) {
      options.adapters = uniqueStrings(parseListArg(arg.slice('--adapter='.length)));
      continue;
    }
    if (arg.startsWith('--timeout-ms=')) {
      const parsed = parsePositiveInt(arg.slice('--timeout-ms='.length), null);
      if (!parsed) throw new Error(`Invalid timeout: ${arg}`);
      options.defaultTimeoutMs = parsed;
      continue;
    }
    if (arg.startsWith('--cdx-command=')) {
      options.cdxCommand = arg.slice('--cdx-command='.length);
      continue;
    }
    if (arg.startsWith('--cdx-args=')) {
      options.cdxArgs = splitCommandArgs(arg.slice('--cdx-args='.length)) ?? [];
      continue;
    }
    if (arg.startsWith('--claude-command=')) {
      options.claudeCommand = arg.slice('--claude-command='.length);
      continue;
    }
    if (arg.startsWith('--claude-args=')) {
      options.claudeArgs = splitCommandArgs(arg.slice('--claude-args='.length));
      continue;
    }
    if (arg.startsWith('--claude-repo-root=')) {
      options.claudeRepoRoot = resolvePathMaybe(projectRoot, arg.slice('--claude-repo-root='.length));
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  options.caseIds = uniqueStrings(options.caseIds);
  options.adapters = options.adapters.length > 0 ? options.adapters : ['cdx', 'claude'];

  for (const adapter of options.adapters) {
    if (!VALID_ADAPTERS.has(adapter)) {
      throw new Error(`Unsupported adapter "${adapter}". Expected one of: cdx, claude.`);
    }
  }

  return options;
}

export function printHelp({
  projectRoot = resolveProjectRoot(import.meta.url),
} = {}) {
  const samplePath = path.join(projectRoot, DEFAULT_SAMPLE_CORPUS);
  console.log(`Orchestrator eval harness

Usage:
  node scripts/eval-orchestrators.js [--corpus=FILE] [--adapter=cdx,claude]
  node scripts/eval-orchestrators.js --case=smoke-file-write --verbose

Options:
  --corpus=FILE              Eval corpus JSON file. Default: ${samplePath}
  --results-dir=DIR          Output directory for run artifacts. Default: ${path.join(projectRoot, DEFAULT_RESULTS_SUBDIR)}
  --case=ID[,ID...]          Run only selected case ids. Repeatable.
  --adapter=NAME[,NAME...]   Adapter subset: cdx, claude. Default: both.
  --timeout-ms=MS            Override case timeout for every case.
  --keep-workspaces          Preserve per-adapter temp workspaces.
  --verbose                  Print per-case progress while running.
  --cdx-command=CMD          Override cdx adapter command.
  --cdx-args='[...]'         Override cdx adapter args (JSON array or whitespace string).
  --claude-command=CMD       Override claude adapter command.
  --claude-args='[...]'      Override claude adapter args (JSON array or whitespace string).
  --claude-repo-root=DIR     Override claude-code-main checkout root.
`);
}

function normalizeVerification(definition, baseDir) {
  if (!definition) return null;

  const steps = [];
  const entries = Array.isArray(definition.commands)
    ? definition.commands
    : definition.command
      ? [definition.command]
      : Array.isArray(definition)
        ? definition
        : [];

  for (const entry of entries) {
    if (typeof entry === 'string') {
      steps.push({
        command: entry,
        cwd: null,
        timeoutMs: 60_000,
        passExitCodes: [0],
        stdoutIncludes: [],
        stderrIncludes: [],
      });
      continue;
    }
    if (!isObject(entry) || !coerceString(entry.command)) {
      throw new Error('verification commands must be strings or objects with a command field');
    }
    steps.push({
      command: entry.command.trim(),
      cwd: resolvePathMaybe(baseDir, entry.cwd) ?? null,
      timeoutMs: parsePositiveInt(entry.timeoutMs, 60_000),
      passExitCodes: Array.isArray(entry.passExitCodes)
        ? entry.passExitCodes.map(value => Number.parseInt(String(value), 10)).filter(Number.isFinite)
        : [parsePositiveInt(entry.expectExitCode, 0) ?? 0],
      stdoutIncludes: Array.isArray(entry.stdoutIncludes) ? entry.stdoutIncludes.map(String) : [],
      stderrIncludes: Array.isArray(entry.stderrIncludes) ? entry.stderrIncludes.map(String) : [],
    });
  }

  if (steps.length === 0) return null;
  return {
    steps,
  };
}

function mergeAdapterConfig(defaultsValue, caseValue) {
  const defaultsConfig = isObject(defaultsValue) ? defaultsValue : {};
  const caseConfig = isObject(caseValue) ? caseValue : {};
  return {
    ...defaultsConfig,
    ...caseConfig,
    env: {
      ...(isObject(defaultsConfig.env) ? defaultsConfig.env : {}),
      ...(isObject(caseConfig.env) ? caseConfig.env : {}),
    },
    spawnArgs: {
      ...(isObject(defaultsConfig.spawnArgs) ? defaultsConfig.spawnArgs : {}),
      ...(isObject(caseConfig.spawnArgs) ? caseConfig.spawnArgs : {}),
    },
  };
}

function normalizeCaseRecord(rawCase, defaultsRecord, corpusDir, cliOptions) {
  if (!isObject(rawCase)) {
    throw new Error('Each eval case must be an object');
  }

  const merged = {
    ...(isObject(defaultsRecord) ? defaultsRecord : {}),
    ...rawCase,
  };
  const id = coerceString(merged.id);
  if (!id) throw new Error('Eval case is missing required id');

  const prompt = coerceString(merged.prompt);
  if (!prompt) throw new Error(`Eval case "${id}" is missing required prompt`);

  const repoRootInput = coerceString(merged.repoRoot);
  if (!repoRootInput) throw new Error(`Eval case "${id}" is missing required repoRoot`);
  const repoRoot = resolvePathMaybe(corpusDir, repoRootInput);

  const workspaceMode = coerceString(merged.workspaceMode ?? merged.workspace)?.toLowerCase() ?? 'copy';
  if (!['copy', 'git-worktree', 'in-place'].includes(workspaceMode)) {
    throw new Error(`Eval case "${id}" has unsupported workspaceMode "${workspaceMode}"`);
  }

  const timeoutMs = parsePositiveInt(merged.timeoutMs ?? cliOptions.defaultTimeoutMs, DEFAULT_CASE_TIMEOUT_MS);
  const maxTurns = parsePositiveInt(merged.maxTurns, DEFAULT_CLAUDE_MAX_TURNS);
  const adapterList = Array.isArray(merged.adapters)
    ? uniqueStrings(merged.adapters)
    : cliOptions.adapters;

  const success = {
    ...(isObject(defaultsRecord?.success) ? defaultsRecord.success : {}),
    ...(isObject(rawCase.success) ? rawCase.success : {}),
    adapters: {
      ...(isObject(defaultsRecord?.success?.adapters) ? defaultsRecord.success.adapters : {}),
      ...(isObject(rawCase.success?.adapters) ? rawCase.success.adapters : {}),
    },
  };

  const adapterConfig = {
    cdx: mergeAdapterConfig(defaultsRecord?.adapterConfig?.cdx, rawCase.adapterConfig?.cdx),
    claude: mergeAdapterConfig(defaultsRecord?.adapterConfig?.claude, rawCase.adapterConfig?.claude),
  };

  return {
    id,
    prompt,
    repoRoot,
    repoRootInput,
    timeoutMs,
    maxTurns,
    workspaceMode,
    workspaceIgnore: Array.isArray(merged.workspaceIgnore) ? merged.workspaceIgnore.map(String) : [],
    adapters: adapterList,
    tags: Array.isArray(merged.tags) ? merged.tags.map(String) : [],
    notes: coerceString(merged.notes),
    verification: normalizeVerification(merged.verification, corpusDir),
    success,
    adapterConfig,
  };
}

export async function loadEvalCorpus(corpusPath, cliOptions = {}) {
  const resolvedPath = path.resolve(corpusPath);
  const raw = await readFile(resolvedPath, 'utf8');
  const parsed = JSON.parse(raw);
  const corpusDir = path.dirname(resolvedPath);
  const defaultsRecord = isObject(parsed?.defaults) ? parsed.defaults : {};
  const cases = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.cases)
      ? parsed.cases
      : null;

  if (!cases) {
    throw new Error(`Corpus must be an array or an object with cases[]: ${resolvedPath}`);
  }

  const normalizedCases = cases.map(entry => normalizeCaseRecord(entry, defaultsRecord, corpusDir, cliOptions));
  const selected = cliOptions.caseIds?.length
    ? normalizedCases.filter(entry => cliOptions.caseIds.includes(entry.id))
    : normalizedCases;

  if (cliOptions.caseIds?.length) {
    const missing = cliOptions.caseIds.filter(caseId => !selected.some(entry => entry.id === caseId));
    if (missing.length > 0) {
      throw new Error(`Unknown case id(s): ${missing.join(', ')}`);
    }
  }

  return {
    corpusPath: resolvedPath,
    defaults: sanitizeJson(defaultsRecord),
    cases: selected.map(entry => ({
      ...entry,
      adapters: entry.adapters.filter(adapter => cliOptions.adapters.includes(adapter)),
    })),
  };
}

async function runCommandCapture(command, args, {
  cwd,
  env,
  timeoutMs = 60_000,
  stdinText = null,
} = {}) {
  return await new Promise(resolve => {
    const startedAt = Date.now();
    let timedOut = false;
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;

    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const finish = payload => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ...payload,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += String(chunk ?? '');
    });
    child.stderr.on('data', chunk => {
      stderr += String(chunk ?? '');
    });
    child.on('error', error => {
      finish({ code: null, signal: null, error: error instanceof Error ? error.message : String(error ?? '') });
    });
    child.on('close', (code, signal) => {
      finish({ code, signal, error: null });
    });

    if (stdinText) {
      child.stdin.write(stdinText);
    }
    child.stdin.end();

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGTERM');
        } catch {}
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            try {
              child.kill('SIGKILL');
            } catch {}
          }
        }, 1_000).unref?.();
      }, timeoutMs);
      timer.unref?.();
    }
  });
}

async function runShellCommand(command, options = {}) {
  const shell = process.env.SHELL ?? '/bin/zsh';
  return await runCommandCapture(shell, ['-lc', command], options);
}

async function runCommandStrict(command, args, options = {}) {
  const result = await runCommandCapture(command, args, options);
  if (result.error) {
    throw new Error(`${command} ${args.join(' ')} failed to start: ${result.error}`);
  }
  if (result.timedOut) {
    throw new Error(`${command} ${args.join(' ')} timed out`);
  }
  if (result.code !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (exit=${result.code})\n${truncate(result.stderr || result.stdout, 1200)}`,
    );
  }
  return result;
}

async function reserveFreePort() {
  return await new Promise((resolve, reject) => {
    const server = createNetServer();
    server.unref?.();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Unable to resolve free TCP port')));
        return;
      }
      const { port } = address;
      server.close(error => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function isGitRepository(repoRoot) {
  const result = await runCommandCapture('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: repoRoot,
    timeoutMs: 5_000,
  });
  return result.code === 0;
}

function buildCopyFilter(sourceRoot, ignoreEntries) {
  const ignored = uniqueStrings(ignoreEntries).map(entry => entry.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, ''));
  return sourcePath => {
    const rel = path.relative(sourceRoot, sourcePath);
    if (!rel) return true;
    const normalized = rel.replace(/\\/g, '/');
    if (normalized === '.git' || normalized.startsWith('.git/')) return false;
    for (const entry of ignored) {
      if (!entry) continue;
      if (normalized === entry || normalized.startsWith(`${entry}/`)) return false;
    }
    return true;
  };
}

async function initGitSnapshot(workspaceRoot) {
  await runCommandStrict('git', ['init'], { cwd: workspaceRoot, timeoutMs: 30_000 });
  await runCommandStrict('git', ['config', 'user.name', 'Eval Harness'], { cwd: workspaceRoot, timeoutMs: 10_000 });
  await runCommandStrict('git', ['config', 'user.email', 'eval-harness@example.invalid'], {
    cwd: workspaceRoot,
    timeoutMs: 10_000,
  });
  await runCommandStrict('git', ['add', '-A'], { cwd: workspaceRoot, timeoutMs: 120_000 });
  await runCommandStrict('git', ['commit', '--allow-empty', '-m', 'eval snapshot'], {
    cwd: workspaceRoot,
    timeoutMs: 120_000,
  });
}

async function prepareWorkspace(caseRecord, adapterName, workspacesRoot, resultsDir) {
  const workspaceLabel = `${slugify(caseRecord.id)}-${adapterName}`;
  const workspaceRoot = path.join(workspacesRoot, workspaceLabel);

  if (caseRecord.workspaceMode === 'in-place') {
    return {
      workspaceRoot: caseRecord.repoRoot,
      cleanup: async () => {},
      metadata: { mode: 'in-place' },
    };
  }

  if (caseRecord.workspaceMode === 'git-worktree') {
    await ensureDir(path.dirname(workspaceRoot));
    await runCommandStrict('git', ['worktree', 'add', '--detach', workspaceRoot, 'HEAD'], {
      cwd: caseRecord.repoRoot,
      timeoutMs: 180_000,
    });
    return {
      workspaceRoot,
      cleanup: async () => {
        await runCommandCapture('git', ['worktree', 'remove', '--force', workspaceRoot], {
          cwd: caseRecord.repoRoot,
          timeoutMs: 120_000,
        });
      },
      metadata: { mode: 'git-worktree' },
    };
  }

  const ignoreEntries = [...caseRecord.workspaceIgnore];
  const relativeResultsPath =
    resultsDir && path.resolve(resultsDir).startsWith(path.resolve(caseRecord.repoRoot) + path.sep)
      ? path.relative(caseRecord.repoRoot, resultsDir)
      : null;
  if (relativeResultsPath) ignoreEntries.push(relativeResultsPath);

  await cp(caseRecord.repoRoot, workspaceRoot, {
    recursive: true,
    filter: buildCopyFilter(caseRecord.repoRoot, ignoreEntries),
  });

  if (await isGitRepository(caseRecord.repoRoot)) {
    await initGitSnapshot(workspaceRoot);
  }

  return {
    workspaceRoot,
    cleanup: async () => {
      await rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
    },
    metadata: { mode: 'copy', ignored: uniqueStrings(ignoreEntries) },
  };
}

export function buildClaudeInvocation({
  caseRecord,
  workspaceRoot,
  adapterConfig = {},
  claudeRepoRoot,
  claudeCommand,
  claudeArgs,
  bunPath = resolveBunCommand(),
} = {}) {
  const looksLikeBunCommand = commandValue => path.basename(String(commandValue ?? '')) === 'bun';
  const command = coerceString(adapterConfig.command)
    ?? coerceString(claudeCommand)
    ?? bunPath
    ?? null;

  if (!command) {
    return {
      available: false,
      reason: 'claude command is not configured and bun is not on PATH',
    };
  }

  const repoRoot = resolvePathMaybe(process.cwd(), adapterConfig.repoRoot ?? claudeRepoRoot);
  const explicitArgs = splitCommandArgs(adapterConfig.args) ?? claudeArgs ?? null;

  let baseArgs = explicitArgs;
  if (!baseArgs) {
    if (!repoRoot) {
      return {
        available: false,
        reason: 'claude repo root is not configured',
      };
    }
    const distEntryPath = path.join(repoRoot, 'dist', 'cli.js');
    const entryPath = path.join(repoRoot, 'src', 'entrypoints', 'cli.tsx');
    if (existsSync(distEntryPath)) {
      baseArgs = [distEntryPath];
    } else if (existsSync(entryPath)) {
      baseArgs = [looksLikeBunCommand(command) ? 'run' : '', entryPath].filter(Boolean);
    } else {
      return {
        available: false,
        reason: `claude entrypoint not found: ${distEntryPath} or ${entryPath}`,
      };
    }
  }

  const maxTurns = parsePositiveInt(adapterConfig.maxTurns ?? caseRecord.maxTurns, DEFAULT_CLAUDE_MAX_TURNS);
  const permissionMode = coerceString(adapterConfig.permissionMode) ?? 'bypassPermissions';
  const enableCoordinatorMode = adapterConfig.coordinatorMode !== false;
  const enableVerbose = adapterConfig.verbose !== false;
  const outputFormat = coerceString(adapterConfig.outputFormat) ?? 'stream-json';
  const extraArgs = splitCommandArgs(adapterConfig.extraArgs) ?? [];
  const finalArgs = [
    ...baseArgs,
    '--print',
    ...(enableVerbose ? ['--verbose'] : []),
    '--output-format',
    outputFormat,
    '--dangerously-skip-permissions',
    '--permission-mode',
    permissionMode,
    '--max-turns',
    String(maxTurns),
    ...extraArgs,
    caseRecord.prompt,
  ];

  const env = {
    ...adapterConfig.env,
    ...(enableCoordinatorMode ? { CLAUDE_CODE_COORDINATOR_MODE: '1' } : {}),
  };

  return {
    available: true,
    command,
    args: finalArgs,
    cwd: workspaceRoot,
    env,
    meta: {
      outputFormat,
      coordinatorMode: enableCoordinatorMode,
      maxTurns,
    },
  };
}

async function startClaudeMockServer({
  artifactsDir,
  adapterConfig = {},
  projectRoot,
} = {}) {
  const mockConfig = adapterConfig.mockServer;
  if (!mockConfig) return null;

  const port = parsePositiveInt(mockConfig.port, null) ?? await reserveFreePort();
  const command = coerceString(mockConfig.command) ?? process.execPath;
  const args =
    splitCommandArgs(mockConfig.args)
    ?? [path.join(projectRoot, 'tools', 'scripts', 'mock-anthropic-server.js'), '--port', String(port)];
  const cwd = resolvePathMaybe(projectRoot, mockConfig.cwd) ?? projectRoot;
  const readyTimeoutMs = parsePositiveInt(mockConfig.readyTimeoutMs, 10_000);
  const stdoutPath = path.join(artifactsDir, 'mock-server.stdout.log');
  const stderrPath = path.join(artifactsDir, 'mock-server.stderr.log');
  const requestLogPath = path.join(artifactsDir, 'mock-server.requests.jsonl');
  const stdoutStream = createWriteStream(stdoutPath, { encoding: 'utf8' });
  const stderrStream = createWriteStream(stderrPath, { encoding: 'utf8' });

  const child = spawn(command, args, {
    cwd,
    env: {
      ...process.env,
      ...adapterConfig.env,
      ...(isObject(mockConfig.env) ? mockConfig.env : {}),
      CDX_EVAL_MOCK_ANTHROPIC_LOG: requestLogPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  let settled = false;
  let startupError = null;
  const ready = await new Promise(resolve => {
    let timer = null;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const onData = chunk => {
      const text = String(chunk ?? '');
      stdoutStream.write(text);
      if (text.includes('READY')) {
        finish(true);
      }
    };
    const onErrorData = chunk => {
      const text = String(chunk ?? '');
      stderrStream.write(text);
      if (text.includes('READY')) {
        finish(true);
      }
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onErrorData);
    child.on('error', error => {
      startupError = error instanceof Error ? error.message : String(error ?? 'unknown_error');
      finish(false);
    });
    child.on('exit', code => {
      if (!settled) {
        startupError = `mock server exited early (code=${code ?? 'null'})`;
        finish(false);
      }
    });

    timer = setTimeout(() => {
      startupError = `mock server did not become ready within ${readyTimeoutMs}ms`;
      finish(false);
    }, readyTimeoutMs);
    timer.unref?.();
  });

  if (!ready) {
    try {
      child.kill('SIGTERM');
    } catch {}
    await new Promise(resolve => stdoutStream.end(resolve));
    await new Promise(resolve => stderrStream.end(resolve));
    throw new Error(startupError ?? 'mock server failed to start');
  }

  const stop = async () => {
    try {
      child.kill('SIGTERM');
    } catch {}
    await new Promise(resolve => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
        resolve();
      }, 2_000);
      timer.unref?.();
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await new Promise(resolve => stdoutStream.end(resolve));
    await new Promise(resolve => stderrStream.end(resolve));
  };

  return {
    env: {
      ANTHROPIC_API_KEY: coerceString(mockConfig.apiKey) ?? 'eval-mock-key',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    },
    artifacts: {
      stdoutPath,
      stderrPath,
      requestLogPath,
    },
    stop,
  };
}

async function runVerification(caseRecord, workspaceRoot, artifactsDir) {
  if (!caseRecord.verification) return null;

  const results = [];
  for (let index = 0; index < caseRecord.verification.steps.length; index += 1) {
    const step = caseRecord.verification.steps[index];
    const stepResult = await runShellCommand(step.command, {
      cwd: step.cwd ?? workspaceRoot,
      timeoutMs: step.timeoutMs,
    });
    const stdout = stepResult.stdout ?? '';
    const stderr = stepResult.stderr ?? '';
    const passExitCodes = step.passExitCodes.length > 0 ? step.passExitCodes : [0];
    const exitOk = passExitCodes.includes(stepResult.code ?? 0);
    const stdoutOk = step.stdoutIncludes.every(token => stdout.includes(token));
    const stderrOk = step.stderrIncludes.every(token => stderr.includes(token));
    results.push({
      step: index + 1,
      command: step.command,
      cwd: step.cwd ?? workspaceRoot,
      timeoutMs: step.timeoutMs,
      passExitCodes,
      code: stepResult.code,
      signal: stepResult.signal,
      timedOut: stepResult.timedOut,
      ok: !stepResult.error && exitOk && stdoutOk && stderrOk && !stepResult.timedOut,
      stdout: truncate(stdout, 2_000),
      stderr: truncate(stderr, 2_000),
      stdoutIncludes: step.stdoutIncludes,
      stderrIncludes: step.stderrIncludes,
      error: stepResult.error,
    });
  }

  const verification = {
    ok: results.every(entry => entry.ok),
    steps: results,
  };
  await writeJson(path.join(artifactsDir, 'verification.json'), verification);
  return verification;
}

function histogramKey(type, subtype) {
  return subtype ? `${type}:${subtype}` : type;
}

function incrementCounter(map, key) {
  map[key] = (map[key] ?? 0) + 1;
}

function collectTextFromBlocks(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text.trim())
    .filter(Boolean)
    .join('\n\n');
}

function summarizeCdxMetrics(finalSnapshot, events, pendingAskIds) {
  const eventTypeHistogram = {};
  for (const event of events) {
    incrementCounter(eventTypeHistogram, coerceString(event?.type) ?? 'unknown');
  }
  const tasks = Array.isArray(finalSnapshot?.tasks) ? finalSnapshot.tasks : [];
  return {
    taskCount: tasks.length,
    completedTaskCount: tasks.filter(task => task?.status === 'completed').length,
    failedTaskCount: tasks.filter(task => task?.status === 'failed').length,
    blockedTaskCount: tasks.filter(task => task?.status === 'blocked').length,
    eventCount: events.length,
    eventTypeHistogram,
    pendingAskCount: pendingAskIds.size,
  };
}

function summarizeClaudeMetrics(state) {
  return {
    messageTypeHistogram: state.messageTypeHistogram,
    taskStartedCount: state.taskStartedIds.size,
    taskNotificationCount: state.taskNotifications.length,
    taskProgressCount: state.taskProgressCount,
    taskStatusHistogram: state.taskStatusHistogram,
    toolUseSummaryCount: state.toolUseSummaryCount,
    maxTaskToolUses: state.maxTaskToolUses,
  };
}

function buildExcerpt(text) {
  return truncate(String(text ?? '').replace(/\s+/g, ' '), 240);
}

function evaluateRunSuccess(caseRecord, adapterName, result) {
  if (result.status === 'skipped') {
    return { ok: null, checks: ['adapter skipped'] };
  }

  const checks = [];
  let ok = true;
  const success = isObject(caseRecord.success) ? caseRecord.success : {};
  const adapterSuccess = isObject(success.adapters?.[adapterName]) ? success.adapters[adapterName] : {};

  if (adapterName === 'cdx') {
    const expectedStatuses = Array.isArray(adapterSuccess.statuses) && adapterSuccess.statuses.length > 0
      ? adapterSuccess.statuses.map(String)
      : ['completed'];
    const pass = expectedStatuses.includes(result.engineStatus);
    checks.push(`engineStatus in [${expectedStatuses.join(', ')}]: ${pass ? 'ok' : `got ${result.engineStatus}`}`);
    ok &&= pass;
  }

  if (adapterName === 'claude') {
    const expectedSubtypes = Array.isArray(adapterSuccess.subtypes) && adapterSuccess.subtypes.length > 0
      ? adapterSuccess.subtypes.map(String)
      : ['success'];
    const pass = expectedSubtypes.includes(result.engineStatus);
    checks.push(`result subtype in [${expectedSubtypes.join(', ')}]: ${pass ? 'ok' : `got ${result.engineStatus}`}`);
    ok &&= pass;

    if (adapterSuccess.minTaskNotifications !== undefined) {
      const minimum = parsePositiveInt(adapterSuccess.minTaskNotifications, 0) ?? 0;
      const count = result.metrics?.taskNotificationCount ?? 0;
      const passTaskNotifications = count >= minimum;
      checks.push(`task notifications >= ${minimum}: ${passTaskNotifications ? 'ok' : `got ${count}`}`);
      ok &&= passTaskNotifications;
    }
  }

  const outputIncludes = Array.isArray(success.outputIncludes) ? success.outputIncludes.map(String) : [];
  const outputExcludes = Array.isArray(success.outputExcludes) ? success.outputExcludes.map(String) : [];
  const finalText = String(result.finalText ?? '');

  for (const token of outputIncludes) {
    const pass = finalText.includes(token);
    checks.push(`output includes "${token}": ${pass ? 'ok' : 'missing'}`);
    ok &&= pass;
  }
  for (const token of outputExcludes) {
    const pass = !finalText.includes(token);
    checks.push(`output excludes "${token}": ${pass ? 'ok' : 'present'}`);
    ok &&= pass;
  }

  if (result.verification) {
    const pass = result.verification.ok === true;
    checks.push(`verification: ${pass ? 'ok' : 'failed'}`);
    ok &&= pass;
  }

  if (result.status === 'timed_out' || result.status === 'needs_input' || result.status === 'failed') {
    ok = false;
  }

  return { ok, checks };
}

async function runCdxAdapter({
  caseRecord,
  workspaceRoot,
  artifactsDir,
  cliOptions,
} = {}) {
  const adapterConfig = caseRecord.adapterConfig?.cdx ?? {};
  const env = {
    CDX_BACKGROUND_BACKEND_ENABLED: '0',
    CDX_APP_SERVER_REQUEST_TIMEOUT_MS: String(caseRecord.timeoutMs + 30_000),
    ...(isObject(adapterConfig.env) ? adapterConfig.env : {}),
  };

  const client = new AppServerClient({
    command: coerceString(adapterConfig.command) ?? cliOptions.cdxCommand,
    args: splitCommandArgs(adapterConfig.args) ?? cliOptions.cdxArgs,
    env,
    log: (...parts) => {
      if (cliOptions.verbose) {
        process.stderr.write(`[eval:cdx] ${parts.join(' ')}\n`);
      }
    },
  });

  const startedAt = Date.now();
  const spawnArgs = {
    prompt: caseRecord.prompt,
    repoRoot: workspaceRoot,
    force: true,
    background: true,
    ...(isObject(adapterConfig.spawnArgs) ? adapterConfig.spawnArgs : {}),
  };

  const events = [];
  const snapshots = [];
  const pendingAskIds = new Set();
  let afterEventId = 0;
  let finalSnapshot = null;
  let finalText = '';
  let runId = null;
  let status = 'failed';
  let engineStatus = 'unknown';

  try {
    await client.ensureInitialized();
    const spawnResult = await client.request('tools/call', {
      name: 'spawn',
      arguments: spawnArgs,
    });
    await writeJson(path.join(artifactsDir, 'spawn-result.json'), spawnResult);

    runId = coerceString(spawnResult?.structured_content?.runId);
    if (!runId) {
      throw new Error('cdx spawn did not return a runId');
    }

    const deadline = Date.now() + caseRecord.timeoutMs;
    while (Date.now() < deadline) {
      const waitMs = Math.max(1, Math.min(DEFAULT_CDX_STATUS_WAIT_MS, deadline - Date.now()));
      const statusResult = await client.request('tools/call', {
        name: 'status',
        arguments: {
          runId,
          includeTasks: true,
          includeAgents: false,
          includeAsks: true,
          includeEvents: true,
          afterEventId,
          waitMs,
          waitFor: 'event',
        },
      });

      const structured = isObject(statusResult?.structured_content) ? statusResult.structured_content : {};
      finalSnapshot = structured;
      finalText = collectTextFromBlocks(statusResult?.content);
      engineStatus = coerceString(structured.status) ?? 'unknown';
      const newEvents = Array.isArray(structured.events) ? structured.events : [];
      events.push(...newEvents);
      afterEventId = parsePositiveInt(structured.lastEventId, afterEventId) ?? afterEventId;

      const pendingAsks = Array.isArray(structured.pendingAsks) ? structured.pendingAsks : [];
      for (const entry of pendingAsks) {
        const askId = coerceString(entry?.askId);
        if (askId) pendingAskIds.add(askId);
      }

      snapshots.push({
        at: new Date().toISOString(),
        status: engineStatus,
        phase: coerceString(structured.phase),
        counts: structured.counts ?? null,
        pendingAsks,
        lastEventId: structured.lastEventId ?? null,
      });

      if (pendingAsks.length > 0) {
        status = 'needs_input';
        break;
      }
      if (engineStatus && engineStatus !== 'running') {
        status = engineStatus === 'completed' ? 'completed' : 'failed';
        break;
      }
    }

    if (status === 'failed' && engineStatus === 'running') {
      status = 'timed_out';
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? 'unknown_error');
    finalText = message;
    status = 'failed';
  } finally {
    await writeJson(path.join(artifactsDir, 'status-snapshots.json'), snapshots);
    await writeJson(path.join(artifactsDir, 'events.json'), events);
    if (finalSnapshot) {
      await writeJson(path.join(artifactsDir, 'final-status.json'), finalSnapshot);
    }
    await client.dispose('eval-harness');
  }

  const metrics = summarizeCdxMetrics(finalSnapshot, events, pendingAskIds);
  return {
    adapter: 'cdx',
    status,
    engineStatus,
    runId,
    durationMs: Date.now() - startedAt,
    finalText,
    excerpt: buildExcerpt(finalText),
    metrics,
    artifacts: {
      workspaceRoot,
      statusSnapshotsPath: path.join(artifactsDir, 'status-snapshots.json'),
      eventsPath: path.join(artifactsDir, 'events.json'),
      finalStatusPath: path.join(artifactsDir, 'final-status.json'),
    },
    command: {
      command: coerceString(adapterConfig.command) ?? cliOptions.cdxCommand,
      args: splitCommandArgs(adapterConfig.args) ?? cliOptions.cdxArgs,
      cwd: process.cwd(),
    },
  };
}

async function runClaudeAdapter({
  caseRecord,
  workspaceRoot,
  artifactsDir,
  cliOptions,
} = {}) {
  const adapterConfig = caseRecord.adapterConfig?.claude ?? {};
  const invocation = buildClaudeInvocation({
    caseRecord,
    workspaceRoot,
    adapterConfig,
    claudeRepoRoot: cliOptions.claudeRepoRoot,
    claudeCommand: cliOptions.claudeCommand,
    claudeArgs: cliOptions.claudeArgs,
  });

  if (!invocation.available) {
    return {
      adapter: 'claude',
      status: 'skipped',
      engineStatus: 'unavailable',
      durationMs: 0,
      finalText: invocation.reason,
      excerpt: buildExcerpt(invocation.reason),
      metrics: null,
      artifacts: { workspaceRoot },
      command: null,
    };
  }

  const mockServer = await startClaudeMockServer({
    artifactsDir,
    adapterConfig,
    projectRoot: cliOptions.projectRoot,
  });
  try {
    const startedAt = Date.now();
    const rawStreamPath = path.join(artifactsDir, 'stream.jsonl');
    const stderrPath = path.join(artifactsDir, 'stderr.txt');
    const rawStream = createWriteStream(rawStreamPath, { encoding: 'utf8' });
    let stderr = '';
    let buffer = '';
    let parseFailureCount = 0;
    let finalResult = null;
    const state = {
      messageTypeHistogram: {},
      taskStartedIds: new Set(),
      taskNotifications: [],
      taskProgressCount: 0,
      taskStatusHistogram: {},
      toolUseSummaryCount: 0,
      maxTaskToolUses: 0,
    };

    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: {
        ...process.env,
        ...(mockServer?.env ?? {}),
        ...invocation.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    const handleMessage = message => {
      const type = coerceString(message?.type) ?? 'unknown';
      const subtype = coerceString(message?.subtype);
      incrementCounter(state.messageTypeHistogram, histogramKey(type, subtype));

      if (type === 'system' && subtype === 'task_started') {
        const taskId = coerceString(message.task_id);
        if (taskId) state.taskStartedIds.add(taskId);
        return;
      }
      if (type === 'system' && subtype === 'task_progress') {
        state.taskProgressCount += 1;
        const toolUses = parsePositiveInt(message?.usage?.tool_uses, 0) ?? 0;
        state.maxTaskToolUses = Math.max(state.maxTaskToolUses, toolUses);
        return;
      }
      if (type === 'system' && subtype === 'task_notification') {
        const status = coerceString(message.status) ?? 'unknown';
        incrementCounter(state.taskStatusHistogram, status);
        state.taskNotifications.push({
          taskId: coerceString(message.task_id),
          status,
          summary: coerceString(message.summary),
          toolUses: parsePositiveInt(message?.usage?.tool_uses, 0) ?? 0,
        });
        const toolUses = parsePositiveInt(message?.usage?.tool_uses, 0) ?? 0;
        state.maxTaskToolUses = Math.max(state.maxTaskToolUses, toolUses);
        return;
      }
      if (type === 'tool_use_summary') {
        state.toolUseSummaryCount += 1;
        return;
      }
      if (type === 'result') {
        finalResult = message;
      }
    };

    const flushBuffer = () => {
      while (true) {
        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex === -1) break;
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.trim()) continue;
        rawStream.write(`${line}\n`);
        try {
          handleMessage(JSON.parse(line));
        } catch {
          parseFailureCount += 1;
        }
      }
    };

    const status = await new Promise(resolve => {
      let timer = null;
      let settled = false;

      const finish = value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };

      child.stdout.on('data', chunk => {
        buffer += String(chunk ?? '');
        flushBuffer();
      });
      child.stderr.on('data', chunk => {
        stderr += String(chunk ?? '');
      });
      child.on('error', error => {
        finish({
          status: 'failed',
          error: error instanceof Error ? error.message : String(error ?? 'unknown_error'),
          code: null,
          signal: null,
        });
      });
      child.on('close', (code, signal) => {
        if (buffer.trim()) {
          rawStream.write(`${buffer}`);
          try {
            handleMessage(JSON.parse(buffer));
          } catch {
            parseFailureCount += 1;
          }
        }
        finish({ status: 'completed', code, signal, error: null });
      });

      timer = setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch {}
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            try {
              child.kill('SIGKILL');
            } catch {}
          }
        }, 1_000).unref?.();
        finish({ status: 'timed_out', code: null, signal: 'SIGTERM', error: 'timeout' });
      }, caseRecord.timeoutMs);
      timer.unref?.();
    });

    await new Promise(resolve => {
      rawStream.end(resolve);
    });
    await writeFile(stderrPath, stderr, 'utf8');

    const metrics = summarizeClaudeMetrics(state);
    const engineStatus = coerceString(finalResult?.subtype) ?? (status.status === 'timed_out' ? 'timed_out' : 'unknown');
    const finalText = coerceString(finalResult?.result)
      ?? (Array.isArray(finalResult?.errors)
        ? finalResult.errors.join('\n')
        : status.error ?? '');

    return {
      adapter: 'claude',
      status:
        status.status === 'timed_out'
          ? 'timed_out'
          : engineStatus === 'success'
            ? 'completed'
            : status.status === 'completed'
              ? 'failed'
              : 'failed',
      engineStatus,
      durationMs: Date.now() - startedAt,
      finalText,
      excerpt: buildExcerpt(finalText),
      metrics: {
        ...metrics,
        parseFailureCount,
        numTurns: parsePositiveInt(finalResult?.num_turns, 0) ?? 0,
        durationReportedMs: parsePositiveInt(finalResult?.duration_ms, 0) ?? 0,
        totalCostUsd: Number.isFinite(Number(finalResult?.total_cost_usd))
          ? Number(finalResult.total_cost_usd)
          : null,
      },
      artifacts: {
        workspaceRoot,
        streamPath: rawStreamPath,
        stderrPath,
        ...(mockServer?.artifacts ?? {}),
      },
      command: {
        command: invocation.command,
        args: invocation.args,
        cwd: invocation.cwd,
      },
    };
  } finally {
    await mockServer?.stop?.();
  }
}

export function renderMarkdownReport(report) {
  const lines = [
    '# Orchestrator Eval Report',
    '',
    `- Started: ${report.startedAt}`,
    `- Completed: ${report.completedAt}`,
    `- Corpus: ${report.corpusPath}`,
    `- Results dir: ${report.resultsDir}`,
    '',
    '| Case | Adapter | Status | Success | Duration | Signal | Verification |',
    '| --- | --- | --- | --- | ---: | --- | --- |',
  ];

  for (const result of report.results) {
    const verification = result.verification
      ? result.verification.ok
        ? 'pass'
        : 'fail'
      : '';
    const signal =
      result.adapter === 'cdx'
        ? `tasks=${result.metrics?.taskCount ?? 0}, events=${result.metrics?.eventCount ?? 0}, asks=${result.metrics?.pendingAskCount ?? 0}`
        : `workers=${result.metrics?.taskStartedCount ?? 0}, notifications=${result.metrics?.taskNotificationCount ?? 0}, turns=${result.metrics?.numTurns ?? 0}`;
    lines.push(
      `| ${result.caseId} | ${result.adapter} | ${result.status} | ${result.success === null ? 'skip' : result.success ? 'pass' : 'fail'} | ${(
        result.durationMs / 1000
      ).toFixed(1)}s | ${signal} | ${verification} |`,
    );
  }

  for (const result of report.results) {
    lines.push('', `## ${result.caseId} / ${result.adapter}`, '');
    lines.push(`- Repo: ${result.repoRoot}`);
    lines.push(`- Workspace: ${result.workspaceRoot}`);
    if (result.runId) lines.push(`- Run id: ${result.runId}`);
    lines.push(`- Status: ${result.status}`);
    lines.push(`- Engine status: ${result.engineStatus}`);
    lines.push(`- Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
    if (result.successChecks?.length) {
      lines.push(`- Success checks: ${result.successChecks.join(' | ')}`);
    }
    if (result.excerpt) {
      lines.push(`- Output excerpt: ${result.excerpt}`);
    }
    if (result.verification?.steps?.length) {
      const detail = result.verification.steps
        .map(step => `step ${step.step}: ${step.ok ? 'pass' : 'fail'} (${step.command})`)
        .join(' | ');
      lines.push(`- Verification: ${detail}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

export async function runEvalHarness(cliOptions) {
  const corpus = await loadEvalCorpus(cliOptions.corpusPath, cliOptions);
  const runLabel = nowTimestampLabel();
  const runRoot = path.join(cliOptions.resultsDir, runLabel);
  const workspacesRoot = await mkdtemp(path.join(os.tmpdir(), `cdx-eval-workspaces-${slugify(runLabel, 'run')}-`));
  await ensureDir(runRoot);

  const results = [];
  const startedAt = new Date().toISOString();

  for (const caseRecord of corpus.cases) {
    if (!(await fileExists(caseRecord.repoRoot))) {
      throw new Error(`Case "${caseRecord.id}" repoRoot does not exist: ${caseRecord.repoRoot}`);
    }

    for (const adapterName of caseRecord.adapters) {
      const caseArtifactsDir = path.join(runRoot, slugify(caseRecord.id), adapterName);
      await ensureDir(caseArtifactsDir);

      if (cliOptions.verbose) {
        process.stderr.write(`[eval] case=${caseRecord.id} adapter=${adapterName} starting\n`);
      }

      const workspace = await prepareWorkspace(
        caseRecord,
        adapterName,
        workspacesRoot,
        cliOptions.resultsDir,
      );

      let result;
      try {
        if (adapterName === 'cdx') {
          result = await runCdxAdapter({
            caseRecord,
            workspaceRoot: workspace.workspaceRoot,
            artifactsDir: caseArtifactsDir,
            cliOptions,
          });
        } else if (adapterName === 'claude') {
          result = await runClaudeAdapter({
            caseRecord,
            workspaceRoot: workspace.workspaceRoot,
            artifactsDir: caseArtifactsDir,
            cliOptions,
          });
        } else {
          result = {
            adapter: adapterName,
            status: 'skipped',
            engineStatus: 'unsupported',
            durationMs: 0,
            finalText: `Unsupported adapter ${adapterName}`,
            excerpt: `Unsupported adapter ${adapterName}`,
            metrics: null,
            artifacts: { workspaceRoot: workspace.workspaceRoot },
            command: null,
          };
        }

        result.verification = result.status === 'skipped'
          ? null
          : await runVerification(caseRecord, workspace.workspaceRoot, caseArtifactsDir);
        const evaluation = evaluateRunSuccess(caseRecord, adapterName, result);
        result.success = evaluation.ok;
        result.successChecks = evaluation.checks;
      } finally {
        if (!cliOptions.keepWorkspaces) {
          await workspace.cleanup();
        }
      }

      const reportRecord = {
        caseId: caseRecord.id,
        adapter: adapterName,
        repoRoot: caseRecord.repoRoot,
        workspaceRoot: workspace.workspaceRoot,
        runId: result.runId ?? null,
        status: result.status,
        engineStatus: result.engineStatus,
        durationMs: result.durationMs,
        excerpt: result.excerpt,
        finalText: truncate(result.finalText, 4_000),
        metrics: result.metrics,
        verification: result.verification,
        success: result.success,
        successChecks: result.successChecks,
        command: result.command,
        artifacts: result.artifacts,
      };
      await writeJson(path.join(caseArtifactsDir, 'result.json'), reportRecord);
      results.push(reportRecord);

      if (cliOptions.verbose) {
        process.stderr.write(
          `[eval] case=${caseRecord.id} adapter=${adapterName} status=${reportRecord.status} success=${reportRecord.success}\n`,
        );
      }
    }
  }

  const report = {
    runLabel,
    startedAt,
    completedAt: new Date().toISOString(),
    corpusPath: corpus.corpusPath,
    resultsDir: runRoot,
    workspacesRoot,
    results,
  };

  await writeJson(path.join(runRoot, 'results.json'), report);
  await writeFile(path.join(runRoot, 'report.md'), renderMarkdownReport(report), 'utf8');

  if (!cliOptions.keepWorkspaces) {
    await rm(workspacesRoot, { recursive: true, force: true }).catch(() => {});
  }

  return report;
}
