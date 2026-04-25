import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRuntimeFixture } from './support/runtime-fixture.mjs';

test('normalizeChecklistConfig preserves checklist defaults and de-dupes items', async t => {
  const fixture = await createRuntimeFixture(t);
  const { normalizeChecklistConfig } = await fixture.importRuntime('checklist-mode.js');

  const config = normalizeChecklistConfig({
    workflowMode: 'checklist',
    targets: [
      {
        label: 'Product Alpha',
        sources: ['Slack'],
        recordTo: 'Confluence page: Alpha Notes',
      },
      { id: 'beta', label: 'Product Beta', description: 'Second target' },
      { id: 'beta', label: 'Duplicate Beta' },
    ],
    checklist: [
      'Search Slack',
      {
        id: 'update-note',
        label: 'Update note',
        instructions: 'Write findings',
        sources: ['SharePoint'],
        recordTo: 'docs/alpha.md',
        outputFormat: 'markdown',
        doneWhen: 'Artifact updated with source links',
      },
      { id: 'update-note', label: 'Duplicate note' },
    ],
    outputRoot: '.keepdoing/',
    sourceSystems: ['Slack', 'SharePoint'],
    artifactLocation: 'Confluence page: Weekly Notes',
    artifactFormat: 'markdown',
    artifactInstructions: 'Use concise bullet points.',
  });

  assert.equal(config.outputRoot, '.keepdoing');
  assert.deepEqual(config.sourceSystems, ['Slack', 'SharePoint']);
  assert.equal(config.targets.length, 2);
  assert.equal(config.items.length, 2);
  assert.equal(config.targets[0].id, 'product-alpha');
  assert.equal(config.items[0].id, 'search-slack');
});

test('collectChecklistClarifications uses CDX wording for missing source guidance', async t => {
  const fixture = await createRuntimeFixture(t);
  const { collectChecklistClarifications } = await fixture.importRuntime('checklist-mode.js');

  const clarification = collectChecklistClarifications({
    workflowMode: 'checklist',
    targets: ['Product Alpha'],
    checklist: ['Search evidence'],
  });

  assert.equal(clarification?.needsClarification, true);
  assert.equal(clarification?.questions?.[0]?.id, 'source_systems');
  assert.match(clarification?.questions?.[0]?.question ?? '', /Which systems should CDX inspect/);
  assert.equal(/CDX2/.test(clarification?.questions?.[0]?.question ?? ''), false);
});

test('buildChecklistTasks creates stable ids and recurring workflow prompts', async t => {
  const fixture = await createRuntimeFixture(t);
  const { buildChecklistTasks, normalizeChecklistConfig } = await fixture.importRuntime('checklist-mode.js');

  const config = normalizeChecklistConfig({
    workflowMode: 'checklist',
    continuous: true,
    outputRoot: '.keepdoing',
    sourceSystems: ['Slack', 'SharePoint'],
    artifactLocation: 'Confluence page: Weekly Notes',
    artifactFormat: 'markdown',
    artifactInstructions: 'Use compact bullet points.',
    targets: ['A', 'B'],
    checklist: [
      'Search Slack',
      {
        label: 'Update note',
        sources: ['Confluence'],
        recordTo: 'docs/weekly.md',
        outputFormat: 'markdown',
        doneWhen: 'The page and file both contain the latest findings.',
      },
    ],
  });

  const tasks = buildChecklistTasks(config, { cycle: 2 });

  assert.deepEqual(
    tasks.map(task => task.id),
    [
      'checklist-a-search-slack-c002',
      'checklist-a-update-note-c002',
      'checklist-b-search-slack-c002',
      'checklist-b-update-note-c002',
    ],
  );
  assert.deepEqual(tasks[1].dependsOn, ['checklist-a-search-slack-c002']);
  assert.deepEqual(tasks[3].dependsOn, ['checklist-b-search-slack-c002']);
  assert.deepEqual(tasks[0].ownership.paths, ['.keepdoing/a/search-slack/cycle-002.md']);
  assert.match(tasks[0].prompt, /long-lived recurring checklist workflow/);
  assert.match(tasks[0].prompt, /Artifact path: \.keepdoing\/a\/search-slack\/cycle-002\.md/);
  assert.match(tasks[1].prompt, /Checklist done when: The page and file both contain the latest findings\./);
});
