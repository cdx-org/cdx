import test from 'node:test';
import assert from 'node:assert/strict';

import { ContextStore } from '../../src/runtime/context-store.js';

test('ContextStore snapshots include recent prompts alongside text and events', () => {
  const store = new ContextStore({ runId: 'run-1' });

  store.recordPrompt({
    taskId: 'task-1',
    agentId: 'task:task-1',
    phase: 'task',
    threadId: 'thread-1',
    text: 'Follow the owned paths and finish the assigned implementation.',
    timestamp: '2026-04-02T00:00:00.000Z',
  });
  store.record({
    taskId: 'task-1',
    agentId: 'task:task-1',
    phase: 'task',
    method: 'item/agentMessage/delta',
    params: { delta: 'Implemented the requested change.' },
    timestamp: '2026-04-02T00:00:01.000Z',
  });
  store.record({
    taskId: 'task-1',
    agentId: 'task:task-1',
    phase: 'task',
    method: 'turn/completed',
    params: { status: 'completed' },
    timestamp: '2026-04-02T00:00:02.000Z',
  });

  const snapshot = store.snapshot('task-1');
  assert.equal(snapshot.runId, 'run-1');
  assert.equal(snapshot.taskId, 'task-1');
  assert.match(snapshot.recentText, /Implemented the requested change/);
  assert.equal(snapshot.recentPrompts.length, 1);
  assert.equal(snapshot.recentPrompts[0].threadId, 'thread-1');
  assert.match(snapshot.recentPrompts[0].text, /owned paths/);
  assert.equal(snapshot.recentEvents.length, 1);
  assert.equal(snapshot.recentEvents[0].kind, 'turn');
});

test('ContextStore returns empty prompt list for unknown tasks', () => {
  const store = new ContextStore({ runId: 'run-2' });
  const snapshot = store.snapshot('missing-task');
  assert.deepEqual(snapshot.recentPrompts, []);
  assert.deepEqual(snapshot.recentEvents, []);
  assert.equal(snapshot.recentText, '');
});
