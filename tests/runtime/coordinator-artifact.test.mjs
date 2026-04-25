import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRuntimeFixture } from './support/runtime-fixture.mjs';

test('normalizeCoordinatorArtifact normalizes aliases and list-style text', async t => {
  const fixture = await createRuntimeFixture(t);
  const { normalizeCoordinatorArtifact } = await fixture.importRuntime('coordinator-artifact.js');

  const normalized = normalizeCoordinatorArtifact({
    goal_brief: ' Ship planner context into worker prompts ',
    shared_context: '- dependency summaries\n- shared repo state',
    watchouts: [' duplicate edits ', 'respawn loops'],
    validation: 'run targeted tests; inspect changed files',
    intervention_triggers: 'queue stalls; repeated duplicate work',
    task_handoffs: [
      {
        task_id: 'task-2',
        summary: 'parser changes are ready for follow-up tests',
        status: 'completed',
        changed_files: ['src/parser.js', 'tests/parser.test.js'],
      },
    ],
    watchdog_interventions: [
      {
        source: 'watchdog',
        summary: 'nudge pending validation work',
        reason: 'only one runnable branch remained',
      },
    ],
  });

  assert.deepEqual(normalized, {
    goalSummary: 'Ship planner context into worker prompts',
    sharedContext: ['dependency summaries', 'shared repo state'],
    risks: ['duplicate edits', 'respawn loops'],
    verification: ['run targeted tests', 'inspect changed files'],
    replanTriggers: ['queue stalls', 'repeated duplicate work'],
    handoffs: [
      {
        taskId: 'task-2',
        summary: 'parser changes are ready for follow-up tests',
        status: 'completed',
        files: ['src/parser.js', 'tests/parser.test.js'],
      },
    ],
    interventions: [
      {
        source: 'watchdog',
        summary: 'nudge pending validation work',
        reason: 'only one runnable branch remained',
      },
    ],
  });
});

test('mergeCoordinatorArtifacts preserves prior context and prefers fresher summaries', async t => {
  const fixture = await createRuntimeFixture(t);
  const { mergeCoordinatorArtifacts } = await fixture.importRuntime('coordinator-artifact.js');

  const merged = mergeCoordinatorArtifacts(
    {
      goalSummary: 'Initial recovery focus',
      sharedContext: ['existing context', 'shared repo summary'],
      risks: ['duplicate edits'],
      verification: ['unit tests'],
      replanTriggers: ['worker idle'],
      handoffs: [
        {
          taskId: 'task-1',
          summary: 'Auth guard updated',
          status: 'completed',
          files: ['src/auth/guard.ts'],
        },
      ],
      interventions: [
        {
          source: 'watchdog',
          summary: 'Wait before replanning',
          reason: 'fresh task activity exists',
        },
      ],
    },
    {
      goalSummary: 'Updated recovery focus',
      sharedContext: ['shared repo summary', 'new dependency handoff'],
      risks: ['duplicate edits', 'merge conflicts'],
      verification: ['integration smoke'],
      replanTriggers: ['worker idle', 'blocked queue'],
      handoffs: [
        {
          taskId: 'task-2',
          summary: 'Validation harness added',
          status: 'completed',
          files: ['tests/auth.integration.test.js'],
        },
      ],
      interventions: [
        {
          source: 'watchdog',
          summary: 'Inject validation worker',
          reason: 'serial chain detected',
        },
      ],
    },
  );

  assert.deepEqual(merged, {
    goalSummary: 'Updated recovery focus',
    sharedContext: ['existing context', 'shared repo summary', 'new dependency handoff'],
    risks: ['duplicate edits', 'merge conflicts'],
    verification: ['unit tests', 'integration smoke'],
    replanTriggers: ['worker idle', 'blocked queue'],
    handoffs: [
      {
        taskId: 'task-1',
        summary: 'Auth guard updated',
        status: 'completed',
        files: ['src/auth/guard.ts'],
      },
      {
        taskId: 'task-2',
        summary: 'Validation harness added',
        status: 'completed',
        files: ['tests/auth.integration.test.js'],
      },
    ],
    interventions: [
      {
        source: 'watchdog',
        summary: 'Wait before replanning',
        reason: 'fresh task activity exists',
      },
      {
        source: 'watchdog',
        summary: 'Inject validation worker',
        reason: 'serial chain detected',
      },
    ],
  });
});

test('buildCoordinatorArtifactDelta returns only newly proposed ledger facts', async t => {
  const fixture = await createRuntimeFixture(t);
  const {
    buildCoordinatorArtifactDelta,
    formatCoordinatorArtifactDelta,
  } = await fixture.importRuntime('coordinator-artifact.js');

  const delta = buildCoordinatorArtifactDelta(
    {
      goalSummary: 'Stabilize validation follow-up',
      sharedContext: ['task-2 touched tests/auth.test.js'],
      risks: ['Avoid overlapping edits in src/auth/*'],
      verification: ['Run auth unit tests'],
      replanTriggers: ['worker idle'],
      handoffs: [
        {
          taskId: 'task-2',
          summary: 'Validation harness added',
          status: 'completed',
          files: ['tests/auth.test.js'],
        },
      ],
      interventions: [
        {
          source: 'watchdog',
          summary: 'Wait one scheduler tick',
          reason: 'fresh activity detected',
        },
      ],
    },
    {
      goalSummary: 'Stabilize validation and dependency handoffs',
      sharedContext: ['task-2 touched tests/auth.test.js', 'task-4 is ready for follow-up verification'],
      risks: ['Avoid overlapping edits in src/auth/*', 'Keep task-4 off src/core/*'],
      verification: ['Run auth unit tests', 'Run focused integration smoke'],
      replanTriggers: ['worker idle', 'two stall waves'],
      handoffs: [
        {
          taskId: 'task-2',
          summary: 'Validation harness added',
          status: 'completed',
          files: ['tests/auth.test.js'],
        },
        {
          taskId: 'task-4',
          summary: 'Ready to consume the new validation harness',
          status: 'ready',
          files: ['tests/auth.integration.test.js'],
        },
      ],
      interventions: [
        {
          source: 'watchdog',
          summary: 'Wait one scheduler tick',
          reason: 'fresh activity detected',
        },
        {
          source: 'coordinator',
          summary: 'Nudge task-4 toward focused verification',
          reason: 'task-2 completed the prerequisite work',
        },
      ],
    },
  );

  assert.deepEqual(delta, {
    goalSummary: 'Stabilize validation and dependency handoffs',
    sharedContextAdded: ['task-4 is ready for follow-up verification'],
    risksAdded: ['Keep task-4 off src/core/*'],
    verificationAdded: ['Run focused integration smoke'],
    replanTriggersAdded: ['two stall waves'],
    handoffsAdded: [
      {
        taskId: 'task-4',
        summary: 'Ready to consume the new validation harness',
        status: 'ready',
        files: ['tests/auth.integration.test.js'],
      },
    ],
    interventionsAdded: [
      {
        source: 'coordinator',
        summary: 'Nudge task-4 toward focused verification',
        reason: 'task-2 completed the prerequisite work',
      },
    ],
  });

  const formatted = formatCoordinatorArtifactDelta(delta, {
    heading: 'Runtime proposed artifact delta',
  });
  assert.match(formatted, /^Runtime proposed artifact delta:/);
  assert.match(formatted, /Goal summary update: Stabilize validation and dependency handoffs/);
  assert.match(formatted, /Add shared context:\n- task-4 is ready for follow-up verification/);
  assert.match(formatted, /New handoffs:\n- task-4 \(ready\): Ready to consume the new validation harness \[files: tests\/auth\.integration\.test\.js\]/);
  assert.match(formatted, /New interventions:\n- coordinator: Nudge task-4 toward focused verification \(task-2 completed the prerequisite work\)/);
});

test('formatCoordinatorArtifact renders a compact coordinator brief', async t => {
  const fixture = await createRuntimeFixture(t);
  const { formatCoordinatorArtifact } = await fixture.importRuntime('coordinator-artifact.js');

  const formatted = formatCoordinatorArtifact(
    {
      goalSummary: 'Keep workers aligned during replan',
      sharedContext: ['Task alpha already changed tests/foo.test.js'],
      risks: ['Avoid overlapping edits in src/foo.js'],
      verification: ['Run focused foo tests'],
      replanTriggers: ['Two waves with no runnable tasks'],
      handoffs: [
        {
          taskId: 'task-3',
          summary: 'Parser refactor landed',
          status: 'completed',
          files: ['src/parser.js', 'tests/parser.test.js'],
        },
      ],
      interventions: [
        {
          source: 'watchdog',
          summary: 'Inject verification worker',
          reason: 'only one runnable task remained',
        },
      ],
    },
    {
      heading: 'Coordinator brief',
      sharedContextSummary: 'Repo scout: foo changes span parser and tests.',
    },
  );

  assert.match(formatted, /^Coordinator brief:/);
  assert.match(formatted, /Goal summary: Keep workers aligned during replan/);
  assert.match(formatted, /Shared context:\n- Task alpha already changed tests\/foo\.test\.js\n- Repo scout: foo changes span parser and tests\./);
  assert.match(formatted, /Known risks \/ guardrails:\n- Avoid overlapping edits in src\/foo\.js/);
  assert.match(formatted, /Verification priorities:\n- Run focused foo tests/);
  assert.match(formatted, /Replan \/ watchdog triggers:\n- Two waves with no runnable tasks/);
  assert.match(formatted, /Recent task handoffs:\n- task-3 \(completed\): Parser refactor landed \[files: src\/parser\.js, tests\/parser\.test\.js\]/);
  assert.match(formatted, /Recent coordinator interventions:\n- watchdog: Inject verification worker \(only one runnable task remained\)/);
});

test('formatCoordinatorArtifact can emit compact truncated briefs with retained-count notes', async t => {
  const fixture = await createRuntimeFixture(t);
  const { formatCoordinatorArtifact } = await fixture.importRuntime('coordinator-artifact.js');

  const formatted = formatCoordinatorArtifact(
    {
      goalSummary: 'Keep the ledger concise',
      sharedContext: ['ctx-1', 'ctx-2', 'ctx-3'],
      risks: ['risk-1', 'risk-2'],
      verification: ['verify-1', 'verify-2'],
      replanTriggers: ['trigger-1', 'trigger-2'],
      handoffs: [
        { taskId: 'task-1', summary: 'handoff-1', status: 'completed', files: ['src/a.js'] },
        { taskId: 'task-2', summary: 'handoff-2', status: 'completed', files: ['src/b.js'] },
      ],
      interventions: [
        { source: 'watchdog', summary: 'intervention-1', reason: 'because-1' },
        { source: 'coordinator', summary: 'intervention-2', reason: 'because-2' },
      ],
    },
    {
      heading: 'Compact coordinator ledger',
      listLimit: 1,
      handoffLimit: 1,
      interventionLimit: 1,
      includeCountSummary: true,
    },
  );

  assert.match(formatted, /^Compact coordinator ledger:/);
  assert.match(formatted, /Shared context:\n- ctx-1/);
  assert.match(formatted, /Retained but omitted for brevity: 2 more shared context; 1 more risks; 1 more verification items; 1 more replan triggers; 1 more handoffs; 1 more interventions\./);
});

test('formatCoordinatorSteer and formatCoordinatorEventEnvelope produce compact structured prompts', async t => {
  const fixture = await createRuntimeFixture(t);
  const {
    formatCanonicalCoordinatorEventSummary,
    formatCoordinatorEventEnvelope,
    formatCoordinatorSteer,
  } = await fixture.importRuntime('coordinator-artifact.js');

  const steerText = formatCoordinatorSteer({
    broadcast: ['Prefer validation work while the main edit is blocked.'],
    taskMessages: [
      {
        taskId: 'task-7',
        message: 'Pick up the focused auth verification now.',
      },
    ],
  }, {
    heading: 'Runtime proposed steer',
  });

  assert.match(steerText, /^Runtime proposed steer:/);
  assert.match(steerText, /Broadcast messages:\n- Prefer validation work while the main edit is blocked\./);
  assert.match(steerText, /Task-targeted messages:\n- task-7: Pick up the focused auth verification now\./);

  const envelopeText = formatCoordinatorEventEnvelope({
    seq: 4,
    eventType: 'task.completed',
    phase: 'task',
    taskId: 'task-7',
    summary: 'Task task-7 completed',
    details: {
      changedFiles: ['src/auth/service.js', 'tests/auth.service.test.js'],
      outputSummary: 'Focused auth verification landed.',
    },
  }, {
    heading: 'New event',
  });

  assert.match(envelopeText, /^New event:/);
  assert.match(envelopeText, /"seq": 4/);
  assert.match(envelopeText, /"type": "task\.completed"/);
  assert.match(envelopeText, /"taskId": "task-7"/);
  assert.match(envelopeText, /"changedFiles": \[\n\s+"src\/auth\/service\.js",\n\s+"tests\/auth\.service\.test\.js"\n\s+\]/);

  const canonicalSummary = formatCanonicalCoordinatorEventSummary({
    eventType: 'task.completed',
    phase: 'task',
    wave: 3,
    taskId: 'task-7',
    artifactChanged: true,
    steer: {
      broadcast: ['Prefer validation work while blocked.'],
      taskMessages: [{ taskId: 'task-8', message: 'Pick up verification.' }],
    },
    note: 'Task task-7 completed;\nledger updated with validation handoff.',
  });

  assert.equal(
    canonicalSummary,
    'event=task.completed; phase=task; wave=3; task=task-7; ledger=updated; steer=b1/t1; note=Task task-7 completed, ledger updated with validation handoff',
  );
});

test('parseWatchdogResponse parses JSON reports and steer directives', async t => {
  const fixture = await createRuntimeFixture(t);
  const { parseWatchdogResponse } = await fixture.importRuntime('coordinator-artifact.js');

  const parsed = parseWatchdogResponse(`
\`\`\`json
{
  "report": {
    "summary": "Workers are stalled behind an over-constrained dependency chain.",
    "likely_causes": ["Planner introduced a serial chain", "No runnable follow-up tasks were injected"],
    "evidence": ["snapshot line 12 shows ready=0", "snapshot line 21 shows only one running task"],
    "next_actions": ["Inject independent verification work", "Relax non-essential dependencies"]
  },
  "steer": {
    "broadcast": ["Prioritize independent validation or docs work if your main edit is blocked."],
    "taskMessages": [
      {
        "taskId": "task-7",
        "message": "Your dependency is complete. Pick up validation work now and avoid src/core/*."
      }
    ]
  },
  "coordinationUpdate": {
    "sharedContext": ["snapshot line 12 shows ready=0"],
    "risks": ["Planner introduced a serial chain"],
    "replanTriggers": ["No runnable follow-up tasks were injected"],
    "interventions": [
      {
        "source": "watchdog",
        "summary": "Inject independent verification work",
        "reason": "serial chain detected"
      }
    ]
  }
}
\`\`\`
  `);

  assert.deepEqual(parsed, {
    report: {
      summary: 'Workers are stalled behind an over-constrained dependency chain.',
      likelyCauses: ['Planner introduced a serial chain', 'No runnable follow-up tasks were injected'],
      evidence: ['snapshot line 12 shows ready=0', 'snapshot line 21 shows only one running task'],
      nextActions: ['Inject independent verification work', 'Relax non-essential dependencies'],
    },
    steer: {
      broadcast: ['Prioritize independent validation or docs work if your main edit is blocked.'],
      tasks: [
        {
          taskId: 'task-7',
          message: 'Your dependency is complete. Pick up validation work now and avoid src/core/*.',
        },
      ],
    },
    coordinationUpdate: {
      goalSummary: null,
      sharedContext: ['snapshot line 12 shows ready=0'],
      risks: ['Planner introduced a serial chain'],
      verification: [],
      replanTriggers: ['No runnable follow-up tasks were injected'],
      handoffs: [],
      interventions: [
        {
          source: 'watchdog',
          summary: 'Inject independent verification work',
          reason: 'serial chain detected',
        },
      ],
    },
  });
});

test('parseWatchdogResponse returns null for non-JSON text', async t => {
  const fixture = await createRuntimeFixture(t);
  const { parseWatchdogResponse } = await fixture.importRuntime('coordinator-artifact.js');

  assert.equal(parseWatchdogResponse('wait and monitor'), null);
});

test('parseCoordinatorResponse parses full artifact snapshots and steer directives', async t => {
  const fixture = await createRuntimeFixture(t);
  const { parseCoordinatorResponse } = await fixture.importRuntime('coordinator-artifact.js');

  const parsed = parseCoordinatorResponse(`
{
  "artifact": {
    "goalSummary": "Keep the coordinator ledger authoritative across the run.",
    "sharedContext": ["task-2 finished validation work"],
    "risks": ["Avoid overlapping edits in src/core/*"],
    "verification": ["Run focused validation tests"],
    "replanTriggers": ["Two consecutive stall waves"],
    "handoffs": [
      {
        "taskId": "task-2",
        "status": "completed",
        "summary": "Validation harness is ready for dependency consumers",
        "files": ["tests/validation.test.js"]
      }
    ],
    "interventions": [
      {
        "source": "coordinator",
        "summary": "Keep remaining workers off src/core/*",
        "reason": "task-2 already touched the validation surface"
      }
    ]
  },
  "steer": {
    "broadcast": ["Prefer validation or docs work if your main edit is blocked."],
    "taskMessages": [
      {
        "taskId": "task-4",
        "message": "Pick up the follow-up validation pass now and avoid src/core/*."
      }
    ]
  },
  "eventSummary": "task-2 completion absorbed into the coordinator ledger"
}
  `);

  assert.deepEqual(parsed, {
    artifact: {
      goalSummary: 'Keep the coordinator ledger authoritative across the run.',
      sharedContext: ['task-2 finished validation work'],
      risks: ['Avoid overlapping edits in src/core/*'],
      verification: ['Run focused validation tests'],
      replanTriggers: ['Two consecutive stall waves'],
      handoffs: [
        {
          taskId: 'task-2',
          status: 'completed',
          summary: 'Validation harness is ready for dependency consumers',
          files: ['tests/validation.test.js'],
        },
      ],
      interventions: [
        {
          source: 'coordinator',
          summary: 'Keep remaining workers off src/core/*',
          reason: 'task-2 already touched the validation surface',
        },
      ],
    },
    steer: {
      broadcast: ['Prefer validation or docs work if your main edit is blocked.'],
      tasks: [
        {
          taskId: 'task-4',
          message: 'Pick up the follow-up validation pass now and avoid src/core/*.',
        },
      ],
    },
    actions: null,
    eventSummary: 'task-2 completion absorbed into the coordinator ledger',
  });
});

test('parseCoordinatorResponse parses coordinator orchestration actions', async t => {
  const fixture = await createRuntimeFixture(t);
  const { parseCoordinatorResponse } = await fixture.importRuntime('coordinator-artifact.js');

  const parsed = parseCoordinatorResponse(`
{
  "actions": {
    "injectTasks": [
      {
        "id": "assist-verify",
        "description": "Run the isolated verification pass",
        "dependsOn": ["task-2"],
        "prompt": "Validate the handoff and avoid src/core/*.",
        "ownership": {
          "scope": "Own the verification surface only",
          "paths": ["tests/validation.test.js", "docs/validation/*"]
        }
      }
    ],
    "abortTasks": [
      {
        "taskId": "task-9",
        "reason": "Wrong scope; overlapping the active owner"
      }
    ],
    "retryTasks": [
      {
        "taskId": "task-4",
        "reason": "Transient failure after dependency retry"
      }
    ],
    "respawnTasks": [
      {
        "taskId": "task-7",
        "reason": "Running worker is idle and blocking dependents"
      }
    ]
  },
  "eventSummary": "event=watchdog; phase=watchdog; wave=2; task=-; ledger=updated; steer=b0/t0; note=retry and respawn queued"
}
  `);

  assert.deepEqual(parsed, {
    artifact: null,
    steer: {
      broadcast: [],
      tasks: [],
    },
    actions: {
      injectTasks: [
        {
          id: 'assist-verify',
          description: 'Run the isolated verification pass',
          dependsOn: ['task-2'],
          prompt: 'Validate the handoff and avoid src/core/*.',
          ownership: {
            scope: 'Own the verification surface only',
            paths: ['tests/validation.test.js', 'docs/validation/*'],
          },
        },
      ],
      abortTasks: [
        {
          taskId: 'task-9',
          reason: 'Wrong scope; overlapping the active owner',
        },
      ],
      retryTasks: [
        {
          taskId: 'task-4',
          reason: 'Transient failure after dependency retry',
        },
      ],
      respawnTasks: [
        {
          taskId: 'task-7',
          reason: 'Running worker is idle and blocking dependents',
        },
      ],
    },
    eventSummary: 'event=watchdog; phase=watchdog; wave=2; task=-; ledger=updated; steer=b0/t0; note=retry and respawn queued',
  });
});
