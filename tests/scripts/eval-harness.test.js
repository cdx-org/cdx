import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildClaudeInvocation,
  loadEvalCorpus,
  parseArgs,
  renderMarkdownReport,
} from '../../tools/scripts/eval-harness.js';

test('parseArgs accepts adapter and corpus overrides', () => {
  const options = parseArgs(
    [
      '--corpus=./eval/cases/custom.json',
      '--adapter=cdx',
      '--case=alpha,beta',
      '--timeout-ms=120000',
      '--keep-workspaces',
    ],
    { projectRoot: '/tmp/mcp-cdx' },
  );

  assert.equal(options.corpusPath, '/tmp/mcp-cdx/eval/cases/custom.json');
  assert.deepEqual(options.adapters, ['cdx']);
  assert.deepEqual(options.caseIds, ['alpha', 'beta']);
  assert.equal(options.defaultTimeoutMs, 120000);
  assert.equal(options.keepWorkspaces, true);
});

test('loadEvalCorpus resolves repoRoot relative to the corpus file and merges defaults', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cdx-eval-corpus-'));

  try {
    const corpusDir = path.join(tempRoot, 'eval', 'cases');
    const repoRoot = path.join(tempRoot, 'fixture-repo');
    await mkdir(corpusDir, { recursive: true });
    await mkdir(repoRoot, { recursive: true });

    const corpusPath = path.join(corpusDir, 'corpus.json');
    await writeFile(
      corpusPath,
      JSON.stringify(
        {
          defaults: {
            timeoutMs: 9000,
            maxTurns: 11,
            adapterConfig: {
              claude: {
                coordinatorMode: true,
              },
            },
          },
          cases: [
            {
              id: 'alpha',
              repoRoot: '../../fixture-repo',
              prompt: 'Do the thing',
              verification: {
                command: 'test -f README.md',
              },
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );

    const corpus = await loadEvalCorpus(corpusPath, {
      adapters: ['cdx', 'claude'],
      caseIds: [],
      defaultTimeoutMs: null,
    });

    assert.equal(corpus.cases.length, 1);
    assert.equal(corpus.cases[0].repoRoot, repoRoot);
    assert.equal(corpus.cases[0].timeoutMs, 9000);
    assert.equal(corpus.cases[0].maxTurns, 11);
    assert.equal(corpus.cases[0].verification.steps.length, 1);
    assert.equal(corpus.cases[0].adapterConfig.claude.coordinatorMode, true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('buildClaudeInvocation injects coordinator mode and print flags', () => {
  const invocation = buildClaudeInvocation({
    caseRecord: {
      prompt: 'Fix the bug',
      maxTurns: 25,
      adapterConfig: {},
    },
    workspaceRoot: '/tmp/workspace',
    adapterConfig: {
      env: {
        EXTRA_FLAG: '1',
      },
    },
    claudeRepoRoot: '/tmp/claude-code-main',
    claudeCommand: '/usr/local/bin/bun',
    claudeArgs: ['run', '/tmp/claude-code-main/src/entrypoints/cli.tsx'],
    bunPath: '/usr/local/bin/bun',
  });

  assert.equal(invocation.available, true);
  assert.equal(invocation.command, '/usr/local/bin/bun');
  assert.deepEqual(invocation.args.slice(0, 2), ['run', '/tmp/claude-code-main/src/entrypoints/cli.tsx']);
  assert.ok(invocation.args.includes('--print'));
  assert.ok(invocation.args.includes('--dangerously-skip-permissions'));
  assert.ok(invocation.args.includes('--permission-mode'));
  assert.ok(invocation.args.includes('bypassPermissions'));
  assert.equal(invocation.env.CLAUDE_CODE_COORDINATOR_MODE, '1');
  assert.equal(invocation.env.EXTRA_FLAG, '1');
});

test('renderMarkdownReport includes per-adapter summary rows', () => {
  const markdown = renderMarkdownReport({
    startedAt: '2026-04-02T00:00:00.000Z',
    completedAt: '2026-04-02T00:01:00.000Z',
    corpusPath: '/tmp/corpus.json',
    resultsDir: '/tmp/results',
    results: [
      {
        caseId: 'alpha',
        adapter: 'cdx',
        repoRoot: '/tmp/repo',
        workspaceRoot: '/tmp/workspace',
        runId: 'run-1',
        status: 'completed',
        engineStatus: 'completed',
        durationMs: 2000,
        excerpt: 'all good',
        metrics: {
          taskCount: 3,
          eventCount: 9,
          pendingAskCount: 0,
        },
        verification: {
          ok: true,
          steps: [{ step: 1, ok: true, command: 'npm test' }],
        },
        success: true,
        successChecks: ['engineStatus in [completed]: ok'],
      },
      {
        caseId: 'alpha',
        adapter: 'claude',
        repoRoot: '/tmp/repo',
        workspaceRoot: '/tmp/workspace-claude',
        runId: null,
        status: 'skipped',
        engineStatus: 'unavailable',
        durationMs: 0,
        excerpt: 'bun missing',
        metrics: {
          taskStartedCount: 0,
          taskNotificationCount: 0,
          numTurns: 0,
        },
        verification: null,
        success: null,
        successChecks: ['adapter skipped'],
      },
    ],
  });

  assert.match(markdown, /\| alpha \| cdx \| completed \| pass \|/);
  assert.match(markdown, /\| alpha \| claude \| skipped \| skip \|/);
  assert.match(markdown, /Run id: run-1/);
  assert.match(markdown, /Output excerpt: bun missing/);
});
