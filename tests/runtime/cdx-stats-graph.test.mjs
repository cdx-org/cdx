import assert from 'node:assert/strict';
import test from 'node:test';

import { filterGraphCommitsForSimple } from '../../src/runtime/cdx-stats-server.js';

test('simple graph hides CDX task bootstrap fan-out commits', () => {
  const baseCommit = {
    id: 'base',
    parents: [],
    subject: 'init: bootstrap repo for cdx',
    decorations: 'refs/heads/master',
  };
  const integrationCommit = {
    id: 'integration',
    parents: ['base'],
    subject: 'cdx: init integration (run-1)',
    decorations: 'refs/heads/cdx/integration/run-1',
  };
  const taskBootstrapCommit = {
    id: 'task-alpha',
    parents: ['integration'],
    subject: 'cdx: init task task-alpha',
    decorations: 'refs/heads/cdx/task/run-1/task-alpha',
  };
  const realTaskCommit = {
    id: 'task-beta-work',
    parents: ['integration'],
    subject: 'Implement beta task',
    decorations: 'refs/heads/cdx/task/run-1/task-beta',
  };

  const filtered = filterGraphCommitsForSimple(
    [taskBootstrapCommit, realTaskCommit, integrationCommit, baseCommit],
    ['integration', 'base'],
  );

  assert.deepEqual(filtered.map(commit => commit.id), [
    'task-beta-work',
    'integration',
    'base',
  ]);
});

test('simple graph keeps a focused CDX bootstrap commit', () => {
  const taskBootstrapCommit = {
    id: 'task-alpha',
    parents: ['integration'],
    subject: 'cdx: init task task-alpha',
    decorations: 'refs/heads/cdx/task/run-1/task-alpha',
  };

  const filtered = filterGraphCommitsForSimple([taskBootstrapCommit], ['task-alpha']);

  assert.deepEqual(filtered.map(commit => commit.id), ['task-alpha']);
});
