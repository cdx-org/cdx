import assert from 'node:assert/strict';
import process from 'node:process';
import test from 'node:test';

import { CdxStatsServer } from '../../src/runtime/cdx-stats-server.js';

test('stats keeps a completed run in merging state while conflict resolver is active', () => {
  const stats = new CdxStatsServer({ enabled: false });
  const runId = 'merge-state-test';

  stats.recordEvent({
    type: 'run.started',
    runId,
    goal: 'verify merge dashboard state',
    pid: process.pid,
  });
  stats.recordEvent({
    type: 'task.completed',
    runId,
    taskId: 'alpha',
    description: 'finished primary task before dependency merge recovery',
  });
  stats.recordEvent({
    type: 'agent.started',
    runId,
    agentId: 'merge:alpha',
    taskId: 'alpha',
    phase: 'merge-conflict',
    worktreePath: 'C:\\tmp\\alpha',
  });
  stats.recordEvent({
    type: 'prompt.sent',
    runId,
    agentId: 'merge:alpha',
    taskId: 'alpha',
    text: 'Resolve all conflicts in the working tree.',
  });
  stats.recordEvent({
    type: 'run.completed',
    runId,
    status: 'completed',
  });

  const state = stats.getState(runId);
  const run = state.activeRun;

  assert.equal(run.status, 'completed');
  assert.equal(run.stage, 'merging');
  assert.equal(run.inFlight, true);
  assert.equal(run.canKill, true);
  assert.equal(run.counts.mergeAgentsRunning, 1);
  assert.match(run.currentTaskSummary, /merge conflict resolution/i);
  assert.match(run.currentTaskSummary, /alpha/);
});

test('stats records appserver token usage notifications into run token usage', () => {
  const stats = new CdxStatsServer({ enabled: false });
  const runId = 'token-notification-test';

  stats.recordEvent({
    type: 'run.started',
    runId,
    goal: 'verify token usage notifications',
    pid: process.pid,
  });
  stats.recordEvent({
    type: 'task.started',
    runId,
    taskId: 'alpha',
    description: 'token task',
  });
  stats.recordEvent({
    type: 'appserver.notification',
    runId,
    agentId: 'task:alpha',
    taskId: 'alpha',
    phase: 'task',
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: 'thread-alpha',
      turnId: 'turn-alpha',
      tokenUsage: {
        last: {
          totalTokens: 150,
          inputTokens: 100,
          cachedInputTokens: 40,
          outputTokens: 50,
          reasoningOutputTokens: 10,
        },
        total: {
          totalTokens: 150,
          inputTokens: 100,
          cachedInputTokens: 40,
          outputTokens: 50,
          reasoningOutputTokens: 10,
        },
      },
    },
  });
  stats.recordEvent({
    type: 'appserver.notification',
    runId,
    agentId: 'task:alpha',
    taskId: 'alpha',
    phase: 'task',
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: 'thread-alpha',
      turnId: 'turn-alpha',
      tokenUsage: {
        total: {
          totalTokens: 150,
          inputTokens: 100,
          cachedInputTokens: 40,
          outputTokens: 50,
          reasoningOutputTokens: 10,
        },
        last: {
          totalTokens: 150,
          inputTokens: 100,
          cachedInputTokens: 40,
          outputTokens: 50,
          reasoningOutputTokens: 10,
        },
      },
    },
  });
  stats.recordEvent({
    type: 'appserver.notification',
    runId,
    agentId: 'task:alpha',
    taskId: 'alpha',
    phase: 'task',
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: 'thread-alpha',
      turnId: 'turn-beta',
      tokenUsage: {
        total: {
          totalTokens: 200,
          inputTokens: 130,
          cachedInputTokens: 50,
          outputTokens: 70,
          reasoningOutputTokens: 12,
        },
        last: {
          totalTokens: 50,
          inputTokens: 30,
          cachedInputTokens: 10,
          outputTokens: 20,
          reasoningOutputTokens: 2,
        },
      },
    },
  });

  const run = stats.getState(runId).activeRun;
  const agent = run.agents.find(item => item.agentId === 'task:alpha');
  const task = run.tasks.find(item => item.taskId === 'alpha');

  assert.equal(run.tokens.input, 130);
  assert.equal(run.tokens.cachedInput, 50);
  assert.equal(run.tokens.output, 70);
  assert.equal(agent.tokens.input, 130);
  assert.equal(task.tokens.output, 70);
  assert.equal(run.tokenUsage.total, 200);
  assert.ok(run.tokenUsage.buckets.some(bucket => bucket.total === 200));
  assert.ok(run.tokenUsage.tpm > 0);
});

test('stats exposes watchdog log cards even without a watchdog agent record', () => {
  const stats = new CdxStatsServer({ enabled: false });
  const runId = 'watchdog-log-only-test';

  stats.recordEvent({
    type: 'run.started',
    runId,
    goal: 'verify watchdog log fallback',
    pid: process.pid,
  });
  stats.recordLog({
    agentId: 'watchdog',
    text: 'coordinator periodic intervention (interval): no recovery action (pending=2).',
  }, runId);

  const run = stats.getState(runId).activeRun;

  assert.equal(run.agents.some(agent => agent.agentId === 'watchdog'), false);
  assert.equal(run.watchdogStdoutLineCount, 1);
  assert.match(run.watchdogStdoutText, /periodic intervention/);
  assert.equal(run.watchdogLatest.kind, 'log');
  assert.match(run.watchdogLatest.text, /pending=2/);
  assert.equal(run.watchdogTurns.length, 1);
  assert.match(run.watchdogTurns[0].text, /periodic intervention/);
});
