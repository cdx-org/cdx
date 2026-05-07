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
