import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRuntimeFixture } from './support/runtime-fixture.mjs';

test('dynamic/stall injection sanitizer drops unresolved deps and trigger task deps', async t => {
  const fixture = await createRuntimeFixture(t);
  const { sanitizeRuntimeInjectedTasks } = await fixture.importRuntime('runtime-injection-policy.js');

  const result = sanitizeRuntimeInjectedTasks(
    [
      {
        id: 'assist-1',
        description: 'Add focused validation worker',
        dependsOn: ['task-straggler', 'task-completed', 'task-running', 'assist-2'],
      },
      {
        id: 'assist-2',
        description: 'Independent docs follow-up',
        dependsOn: ['task-completed'],
      },
    ],
    {
      kind: 'dynamic-plan',
      allowInternalDeps: false,
      allowedExternalDepIds: ['task-completed'],
      dropDepIds: ['task-straggler'],
    },
  );

  assert.equal(result.mutated, true);
  assert.equal(result.removedDependencyCount, 3);
  assert.deepEqual(result.affectedTaskIds, ['assist-1']);
  assert.deepEqual(result.tasks, [
    {
      id: 'assist-1',
      description: 'Add focused validation worker',
      dependsOn: ['task-completed'],
    },
    {
      id: 'assist-2',
      description: 'Independent docs follow-up',
      dependsOn: ['task-completed'],
    },
  ]);
});

test('recovery injection sanitizer keeps internal deps and completed external deps only', async t => {
  const fixture = await createRuntimeFixture(t);
  const { sanitizeRuntimeInjectedTasks } = await fixture.importRuntime('runtime-injection-policy.js');

  const result = sanitizeRuntimeInjectedTasks(
    [
      {
        id: 'recovery-1',
        description: 'Rebuild parser fix on clean scope',
        dependsOn: ['task-completed', 'task-failed', 'recovery-2'],
      },
      {
        id: 'recovery-2',
        description: 'Add verification for recovered parser fix',
        dependsOn: ['task-blocked', 'task-completed'],
      },
    ],
    {
      kind: 'recovery-plan',
      allowInternalDeps: true,
      allowedExternalDepIds: ['task-completed'],
      dropDepIds: [],
    },
  );

  assert.equal(result.mutated, true);
  assert.equal(result.removedDependencyCount, 2);
  assert.deepEqual(result.affectedTaskIds, ['recovery-1', 'recovery-2']);
  assert.deepEqual(result.tasks, [
    {
      id: 'recovery-1',
      description: 'Rebuild parser fix on clean scope',
      dependsOn: ['task-completed', 'recovery-2'],
    },
    {
      id: 'recovery-2',
      description: 'Add verification for recovered parser fix',
      dependsOn: ['task-completed'],
    },
  ]);
});

test('runtime injection policy normalizer dedupes dependency allow/drop sets', async t => {
  const fixture = await createRuntimeFixture(t);
  const {
    normalizeRuntimeInjectionPolicy,
    sanitizeRuntimeInjectedTasks,
  } = await fixture.importRuntime('runtime-injection-policy.js');

  const policy = normalizeRuntimeInjectionPolicy({
    kind: ' stall-plan ',
    allowInternalDeps: false,
    allowedExternalDepIds: ['task-1', 'task-1', ' task-2 '],
    dropDepIds: [' task-3 ', 'task-3', ''],
  });

  assert.deepEqual(policy, {
    kind: 'stall-plan',
    allowInternalDeps: false,
    restrictExternalDeps: true,
    allowedExternalDepIds: ['task-1', 'task-2'],
    dropDepIds: ['task-3'],
  });

  const result = sanitizeRuntimeInjectedTasks(
    [
      {
        id: 'stall-1',
        description: 'Recover parallelism',
        dependsOn: ['task-1', 'task-2', 'task-3'],
      },
    ],
    policy,
  );

  assert.deepEqual(result.tasks[0].dependsOn, ['task-1', 'task-2']);
  assert.equal(result.removedDependencyCount, 1);
});

test('runtime injection sanitizer preserves dependencies when no policy is provided', async t => {
  const fixture = await createRuntimeFixture(t);
  const { sanitizeRuntimeInjectedTasks } = await fixture.importRuntime('runtime-injection-policy.js');

  const result = sanitizeRuntimeInjectedTasks([
    {
      id: 'manual-1',
      description: 'Manual supervisor injection',
      dependsOn: ['task-a', 'manual-2'],
    },
    {
      id: 'manual-2',
      description: 'Follow-up manual supervisor injection',
      dependsOn: ['task-b'],
    },
  ]);

  assert.equal(result.mutated, false);
  assert.equal(result.removedDependencyCount, 0);
  assert.deepEqual(result.tasks, [
    {
      id: 'manual-1',
      description: 'Manual supervisor injection',
      dependsOn: ['task-a', 'manual-2'],
    },
    {
      id: 'manual-2',
      description: 'Follow-up manual supervisor injection',
      dependsOn: ['task-b'],
    },
  ]);
});
