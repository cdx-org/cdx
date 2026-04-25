const DEFAULT_OUTPUT_ROOT = '.keepdoing';
const CHECKLIST_HINT_KEYS = [
  'workflowMode',
  'workflow_mode',
  'orchestrationMode',
  'orchestration_mode',
  'targets',
  'checklist',
  'continuous',
  'maxCycles',
  'max_cycles',
  'outputRoot',
  'output_root',
  'sourceSystems',
  'source_systems',
  'artifactLocation',
  'artifact_location',
  'artifactFormat',
  'artifact_format',
  'artifactInstructions',
  'artifact_instructions',
];
const RESEARCH_VERBS = ['search', 'inspect', 'review', 'investigate', 'collect', 'gather', 'find', 'lookup', 'look up', 'audit', 'check'];
const SOURCE_KEYWORDS = ['slack', 'sharepoint', 'confluence', 'jira', 'salesforce', 'outlook', 'email', 'github', 'gdrive', 'google drive', 'wiki', 'docs'];

function coerceBoolean(value) {
  if (value === true || value === false) return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return null;
}

function coerceString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function clipLabel(value, max = 120) {
  const text = coerceString(value);
  if (!text) return null;
  return text.length <= max ? text : `${text.slice(0, max - 1)}...`;
}

function normalizeStringList(value, { max = 32, clip = 160 } = {}) {
  const rawItems = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\n,;]+/)
      : [];
  const output = [];
  const seen = new Set();
  for (const entry of rawItems) {
    const text = clipLabel(entry, clip);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(text);
    if (output.length >= max) break;
  }
  return output;
}

function resolveCollectionLimit(value, fallback = 256) {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (typeof value === 'string' && value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed <= 0) return null;
  return Math.max(1, parsed);
}

function applyCollectionLimit(items, limit) {
  if (!Array.isArray(items)) return [];
  if (Number.isFinite(limit) && limit > 0) {
    return items.slice(0, limit);
  }
  return items.slice();
}

export function slugify(value, fallback = 'item') {
  const raw = coerceString(value);
  if (!raw) return fallback;
  const normalized = raw
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function padCycle(cycle) {
  return String(Math.max(1, Number.parseInt(cycle, 10) || 1)).padStart(3, '0');
}

function normalizeOutputRoot(value) {
  const text = coerceString(value);
  if (!text) return DEFAULT_OUTPUT_ROOT;
  return text.replace(/\\/g, '/').replace(/\/+$/g, '') || DEFAULT_OUTPUT_ROOT;
}

function normalizeTarget(value, index) {
  if (typeof value === 'string') {
    const label = clipLabel(value, 160) ?? `Target ${index + 1}`;
    return {
      id: slugify(value, `target-${index + 1}`),
      label,
      description: null,
      instructions: null,
      sources: [],
      recordTo: null,
      metadata: null,
    };
  }
  if (!value || typeof value !== 'object') {
    return {
      id: `target-${index + 1}`,
      label: `Target ${index + 1}`,
      description: null,
      instructions: null,
      sources: [],
      recordTo: null,
      metadata: null,
    };
  }
  const id = slugify(
    value.id ?? value.key ?? value.slug ?? value.code ?? value.name ?? value.label ?? value.title,
    `target-${index + 1}`,
  );
  const label = clipLabel(
    value.label ?? value.title ?? value.name ?? value.code ?? value.id ?? `Target ${index + 1}`,
    160,
  ) ?? `Target ${index + 1}`;
  const description = coerceString(value.description ?? value.summary);
  const instructions = coerceString(
    value.instructions ?? value.prompt ?? value.goal ?? value.notes ?? value.guidance,
  );
  const sources = normalizeStringList(
    value.sources ?? value.sourceSystems ?? value.source_systems ?? value.systems,
    { max: 16 },
  );
  const recordTo = coerceString(
    value.recordTo ?? value.record_to ?? value.destination ?? value.outputTarget ?? value.output_target,
  );
  const metadata =
    value.metadata && typeof value.metadata === 'object' && !Array.isArray(value.metadata)
      ? { ...value.metadata }
      : null;
  return { id, label, description, instructions, sources, recordTo, metadata };
}

function normalizeChecklistItem(value, index) {
  if (typeof value === 'string') {
    const label = clipLabel(value, 160) ?? `Checklist ${index + 1}`;
    return {
      id: slugify(value, `item-${index + 1}`),
      label,
      description: null,
      instructions: null,
      sources: [],
      recordTo: null,
      outputFormat: null,
      doneWhen: null,
    };
  }
  if (!value || typeof value !== 'object') {
    return {
      id: `item-${index + 1}`,
      label: `Checklist ${index + 1}`,
      description: null,
      instructions: null,
      sources: [],
      recordTo: null,
      outputFormat: null,
      doneWhen: null,
    };
  }
  const id = slugify(
    value.id ?? value.key ?? value.slug ?? value.code ?? value.name ?? value.label ?? value.title,
    `item-${index + 1}`,
  );
  const label = clipLabel(
    value.label ?? value.title ?? value.name ?? value.code ?? value.id ?? `Checklist ${index + 1}`,
    160,
  ) ?? `Checklist ${index + 1}`;
  const description = coerceString(value.description ?? value.summary);
  const instructions = coerceString(
    value.instructions ?? value.prompt ?? value.goal ?? value.notes ?? value.guidance,
  );
  const sources = normalizeStringList(
    value.sources ?? value.sourceSystems ?? value.source_systems ?? value.systems,
    { max: 16 },
  );
  const recordTo = coerceString(
    value.recordTo ?? value.record_to ?? value.destination ?? value.outputTarget ?? value.output_target,
  );
  const outputFormat = coerceString(
    value.outputFormat ?? value.output_format ?? value.artifactFormat ?? value.artifact_format,
  );
  const doneWhen = coerceString(
    value.doneWhen ?? value.done_when ?? value.success ?? value.completeWhen ?? value.complete_when,
  );
  return { id, label, description, instructions, sources, recordTo, outputFormat, doneWhen };
}

function hasChecklistHints(input = {}) {
  return CHECKLIST_HINT_KEYS.some(key => input?.[key] !== undefined);
}

export function detectChecklistMode(input = {}) {
  const mode = coerceString(
    input.workflowMode
    ?? input.workflow_mode
    ?? input.orchestrationMode
    ?? input.orchestration_mode
    ?? input.mode,
  );
  if (mode && mode.toLowerCase() === 'checklist') return true;
  const targets = Array.isArray(input.targets) ? input.targets : [];
  const checklist = Array.isArray(input.checklist) ? input.checklist : [];
  return targets.length > 0 && checklist.length > 0;
}

function isPlaceholderLabel(value, kind) {
  const text = coerceString(value);
  if (!text) return true;
  const normalized = text.toLowerCase();
  if (/^[0-9._-]+$/.test(normalized)) return true;
  if (kind === 'item' && normalized.length < 3) return true;
  if (new RegExp(`^${kind}(?:[\\s_-]*\\d+)?$`).test(normalized)) return true;
  if (kind === 'item' && /^checklist(?:[\\s_-]*item)?(?:[\\s_-]*\\d+)?$/.test(normalized)) return true;
  return false;
}

function collectProvidedTargets(input = {}, options = {}) {
  const maxTargets = resolveCollectionLimit(options.maxTargets, 256);
  return uniqueById(
    applyCollectionLimit(Array.isArray(input.targets) ? input.targets : [], maxTargets)
      .map((value, index) => normalizeTarget(value, index)),
  );
}

function collectProvidedItems(input = {}, options = {}) {
  const maxItems = resolveCollectionLimit(options.maxItems, 256);
  return uniqueById(
    applyCollectionLimit(Array.isArray(input.checklist) ? input.checklist : [], maxItems)
      .map((value, index) => normalizeChecklistItem(value, index)),
  );
}

export function collectChecklistClarifications(input = {}, options = {}) {
  if (!hasChecklistHints(input) && !detectChecklistMode(input)) return null;

  const targets = collectProvidedTargets(input, options);
  const items = collectProvidedItems(input, options);
  const promptText = coerceString(input.prompt ?? input.goal);
  const outputRoot = coerceString(input.outputRoot ?? input.output_root);
  const sourceSystems = normalizeStringList(
    input.sourceSystems ?? input.source_systems ?? input.sources ?? input.sourceHints ?? input.source_hints,
    { max: 16 },
  );
  const artifactLocation = coerceString(
    input.artifactLocation ?? input.artifact_location ?? input.recordTo ?? input.record_to ?? input.destination,
  );
  const artifactFormat = coerceString(
    input.artifactFormat ?? input.artifact_format ?? input.outputFormat ?? input.output_format,
  );
  const artifactInstructions = coerceString(
    input.artifactInstructions ?? input.artifact_instructions ?? input.recordingInstructions ?? input.recording_instructions,
  );
  const hasWorkflowContext =
    Boolean(promptText)
    || targets.some(target => target.description || target.instructions)
    || items.some(item => item.description || item.instructions);
  const contextFragments = [
    promptText,
    artifactLocation,
    artifactFormat,
    artifactInstructions,
    ...sourceSystems,
    ...targets.flatMap(target => [target.label, target.description, target.instructions, ...(Array.isArray(target.sources) ? target.sources : []), target.recordTo]),
    ...items.flatMap(item => [item.label, item.description, item.instructions, ...(Array.isArray(item.sources) ? item.sources : []), item.recordTo, item.outputFormat, item.doneWhen]),
  ].filter(Boolean).map(text => String(text).toLowerCase());

  const questions = [];

  if (targets.length === 0) {
    questions.push({
      id: 'targets',
      priority: 1,
      reason: 'missing_targets',
      question: 'Which targets should this checklist run for? Provide a flat list or target objects with id/label.',
      expectedFormat: 'targets: ["a", "b"] or [{ "id": "a", "label": "Product A" }]',
    });
  } else {
    const placeholderTargets = targets
      .filter(target => isPlaceholderLabel(target.label, 'target') && !target.description && !target.instructions)
      .map(target => target.label);
    if (placeholderTargets.length > 0) {
      questions.push({
        id: 'target_details',
        priority: 3,
        reason: 'underspecified_targets',
        question: `Some targets are too vague to act on safely: ${placeholderTargets.join(', ')}. What are their real names or target-specific instructions?`,
        expectedFormat: 'targets: [{ "id": "a", "label": "Product A", "instructions": "..." }]',
      });
    }
  }

  if (items.length === 0) {
    questions.push({
      id: 'checklist',
      priority: 1,
      reason: 'missing_checklist',
      question: 'What checklist items should run for every target, in order?',
      expectedFormat: 'checklist: ["Search Slack", "Search SharePoint", "Update report"]',
    });
  } else {
    const placeholderItems = items
      .filter(item => isPlaceholderLabel(item.label, 'item') && !item.description && !item.instructions)
      .map(item => item.label);
    if (placeholderItems.length > 0) {
      questions.push({
        id: 'checklist_details',
        priority: 2,
        reason: 'underspecified_checklist',
        question: `Some checklist items are too vague to execute safely: ${placeholderItems.join(', ')}. What should those steps actually do?`,
        expectedFormat: 'checklist: [{ "label": "Search Slack", "instructions": "Find recent bugs and owner comments" }]',
      });
    }
  }

  const needsWorkflowGoal =
    targets.length > 0
    && items.length > 0
    && !hasWorkflowContext
    && (
      targets.some(target => isPlaceholderLabel(target.label, 'target') && !target.description && !target.instructions)
      || items.some(item => isPlaceholderLabel(item.label, 'item') && !item.description && !item.instructions)
    );

  if (needsWorkflowGoal) {
    questions.push({
      id: 'workflow_goal',
      priority: 2,
      reason: 'missing_workflow_goal',
      question: 'What should each checklist step actually investigate and leave behind? For example: search Slack/SharePoint, summarize findings, and update a note or Confluence page.',
      expectedFormat: 'prompt: "For each target, inspect Slack and SharePoint, summarize findings, and update the artifact file."',
    });
  }

  const hasSourceGuidance =
    sourceSystems.length > 0
    || targets.some(target => Array.isArray(target.sources) && target.sources.length > 0)
    || items.some(item => Array.isArray(item.sources) && item.sources.length > 0)
    || contextFragments.some(fragment => SOURCE_KEYWORDS.some(keyword => fragment.includes(keyword)));
  const needsSourceGuidance =
    targets.length > 0
    && items.length > 0
    && !hasSourceGuidance
    && items.some(item => {
      const label = `${item.label ?? ''} ${item.description ?? ''} ${item.instructions ?? ''}`.toLowerCase();
      return RESEARCH_VERBS.some(keyword => label.includes(keyword));
    });
  if (needsSourceGuidance) {
    questions.push({
      id: 'source_systems',
      priority: 2,
      reason: 'missing_source_systems',
      question: 'Which systems should CDX inspect for these checklist steps? For example Slack, SharePoint, Confluence, Jira, or local files.',
      expectedFormat: 'sourceSystems: ["Slack", "SharePoint"] or checklist: [{ "label": "Search docs", "sources": ["Confluence"] }]',
    });
  }

  if (!outputRoot && needsWorkflowGoal) {
    questions.push({
      id: 'artifact_location',
      priority: 4,
      reason: 'default_output_root_only',
      question: 'Where should the routine write its artifacts? If omitted, CDX will use .keepdoing/<target>/<item>/cycle-###.md.',
      expectedFormat: 'outputRoot: ".keepdoing" or another repo-relative folder',
    });
  }

  if (questions.length === 0) return null;

  const sorted = questions
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
    .slice(0, Math.max(1, Number.parseInt(options.maxQuestions ?? '3', 10) || 3))
    .map(({ priority, ...question }) => question);

  return {
    mode: 'checklist',
    needsClarification: true,
    summary: 'Checklist input is not specific enough to start safely.',
    questions: sorted,
    provided: {
      targets: targets.length,
      checklist: items.length,
      hasPrompt: Boolean(promptText),
      sourceSystems,
      artifactLocation: artifactLocation ?? null,
      artifactFormat: artifactFormat ?? null,
      outputRoot: outputRoot ?? DEFAULT_OUTPUT_ROOT,
    },
  };
}

function uniqueById(items) {
  const output = [];
  const seen = new Set();
  for (const item of items) {
    const id = coerceString(item?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    output.push(item);
  }
  return output;
}

export function normalizeChecklistConfig(input = {}, options = {}) {
  if (!detectChecklistMode(input)) return null;

  const targets = collectProvidedTargets(input, options);
  const items = collectProvidedItems(input, options);

  if (targets.length === 0) {
    throw new Error('Checklist mode requires at least one target.');
  }
  if (items.length === 0) {
    throw new Error('Checklist mode requires at least one checklist item.');
  }

  const continuous = coerceBoolean(input.continuous) === true;
  const parsedMaxCycles = Number.parseInt(input.maxCycles ?? input.max_cycles, 10);
  const maxCycles =
    Number.isFinite(parsedMaxCycles) && parsedMaxCycles > 0
      ? parsedMaxCycles
      : continuous
        ? null
        : 1;

  const outputRoot = normalizeOutputRoot(input.outputRoot ?? input.output_root);
  const sourceSystems = normalizeStringList(
    input.sourceSystems ?? input.source_systems ?? input.sources ?? input.sourceHints ?? input.source_hints,
    { max: 16 },
  );
  const artifactLocation = coerceString(
    input.artifactLocation ?? input.artifact_location ?? input.recordTo ?? input.record_to ?? input.destination,
  );
  const artifactFormat = coerceString(
    input.artifactFormat ?? input.artifact_format ?? input.outputFormat ?? input.output_format,
  );
  const artifactInstructions = coerceString(
    input.artifactInstructions ?? input.artifact_instructions ?? input.recordingInstructions ?? input.recording_instructions,
  );

  return {
    mode: 'checklist',
    continuous,
    maxCycles,
    outputRoot,
    sourceSystems,
    artifactLocation,
    artifactFormat,
    artifactInstructions,
    targets: targets.map((target, index) => ({ ...target, order: index })),
    items: items.map((item, index) => ({ ...item, order: index })),
  };
}

function buildPrompt({
  config,
  target,
  item,
  cycle,
  outputPath,
  outputRoot,
}) {
  const lines = [
    'Run one checklist step for a long-lived recurring checklist workflow.',
    '',
    `Target: ${target.label}`,
    `Checklist item: ${item.label}`,
    `Cycle: ${cycle}`,
    `Artifact path: ${outputPath}`,
    `Output root: ${outputRoot}`,
    '',
    'Requirements:',
    '- Inspect the relevant sources for this target and checklist item.',
    '- Update or create the artifact file at the exact artifact path.',
    '- Keep the artifact factual, concise, and self-contained.',
    '- If you use external sources, record enough context to make the note reusable.',
    '- Restrict file changes to the owned artifact path.',
  ];
  if (Array.isArray(config?.sourceSystems) && config.sourceSystems.length > 0) {
    lines.push('', `Default source systems: ${config.sourceSystems.join(', ')}`);
  }
  if (config?.artifactLocation) {
    lines.push('', `Default recording target: ${config.artifactLocation}`);
  }
  if (config?.artifactFormat) {
    lines.push('', `Default artifact format: ${config.artifactFormat}`);
  }
  if (config?.artifactInstructions) {
    lines.push('', `Artifact instructions:\n${config.artifactInstructions}`);
  }
  if (target.description) {
    lines.push('', `Target context: ${target.description}`);
  }
  if (target.instructions) {
    lines.push('', `Target-specific instructions:\n${target.instructions}`);
  }
  if (Array.isArray(target.sources) && target.sources.length > 0) {
    lines.push('', `Target-specific sources: ${target.sources.join(', ')}`);
  }
  if (target.recordTo) {
    lines.push('', `Target-specific recording target: ${target.recordTo}`);
  }
  if (item.description) {
    lines.push('', `Checklist context: ${item.description}`);
  }
  if (item.instructions) {
    lines.push('', `Checklist instructions:\n${item.instructions}`);
  }
  if (Array.isArray(item.sources) && item.sources.length > 0) {
    lines.push('', `Checklist sources: ${item.sources.join(', ')}`);
  }
  if (item.recordTo) {
    lines.push('', `Checklist recording target: ${item.recordTo}`);
  }
  if (item.outputFormat) {
    lines.push('', `Checklist output format: ${item.outputFormat}`);
  }
  if (item.doneWhen) {
    lines.push('', `Checklist done when: ${item.doneWhen}`);
  }
  lines.push('', `Owned paths: ${outputPath}`, `Expected touched paths: ${outputPath}`);
  return lines.join('\n');
}

function buildTaskId(targetId, itemId, cycle) {
  return `checklist-${slugify(targetId, 'target')}-${slugify(itemId, 'item')}-c${padCycle(cycle)}`;
}

function buildOutputPath(outputRoot, targetId, itemId, cycle) {
  return `${normalizeOutputRoot(outputRoot)}/${slugify(targetId, 'target')}/${slugify(itemId, 'item')}/cycle-${padCycle(cycle)}.md`;
}

export function buildChecklistTask({
  config,
  target,
  item,
  cycle,
  dependsOn = [],
}) {
  const outputPath = buildOutputPath(config.outputRoot, target.id, item.id, cycle);
  return {
    id: buildTaskId(target.id, item.id, cycle),
    description: `${target.label}: ${item.label} (cycle ${cycle})`,
    dependsOn: Array.isArray(dependsOn) ? dependsOn.filter(Boolean) : [],
    prompt: buildPrompt({
      config,
      target,
      item,
      cycle,
      outputPath,
      outputRoot: config.outputRoot,
    }),
    ownership: {
      scope: `Maintain the checklist artifact for ${target.label} / ${item.label} / cycle ${cycle}.`,
      paths: [outputPath],
    },
    checklist: {
      mode: 'checklist',
      targetId: target.id,
      targetLabel: target.label,
      targetOrder: target.order ?? 0,
      itemId: item.id,
      itemLabel: item.label,
      itemOrder: item.order ?? 0,
      cycle,
      outputPath,
      sources: item.sources,
      recordTo: item.recordTo ?? config.artifactLocation ?? null,
      outputFormat: item.outputFormat ?? config.artifactFormat ?? null,
    },
  };
}

export function buildChecklistTasks(config, options = {}) {
  if (!config || config.mode !== 'checklist') return [];
  const cycle = Math.max(1, Number.parseInt(options.cycle ?? '1', 10) || 1);
  const targetIds = Array.isArray(options.targetIds)
    ? new Set(options.targetIds.map(value => String(value)))
    : null;
  const tasks = [];
  for (const target of config.targets) {
    if (targetIds && !targetIds.has(target.id)) continue;
    let previousTaskId = null;
    for (const item of config.items) {
      const task = buildChecklistTask({
        config,
        target,
        item,
        cycle,
        dependsOn: previousTaskId ? [previousTaskId] : [],
      });
      tasks.push(task);
      previousTaskId = task.id;
    }
  }
  return tasks;
}

function compareTaskSort(a, b) {
  const aTarget = Number.parseInt(a?.checklist?.targetOrder, 10) || 0;
  const bTarget = Number.parseInt(b?.checklist?.targetOrder, 10) || 0;
  if (aTarget !== bTarget) return aTarget - bTarget;
  const aItem = Number.parseInt(a?.checklist?.itemOrder, 10) || 0;
  const bItem = Number.parseInt(b?.checklist?.itemOrder, 10) || 0;
  if (aItem !== bItem) return aItem - bItem;
  const aCycle = Number.parseInt(a?.checklist?.cycle, 10) || 1;
  const bCycle = Number.parseInt(b?.checklist?.cycle, 10) || 1;
  return aCycle - bCycle;
}

function summarizeVisibleCounts(rows) {
  const counts = {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    blocked: 0,
  };
  for (const row of rows) {
    for (const cell of row.cells) {
      const status = coerceString(cell?.status) ?? 'pending';
      if (Object.hasOwn(counts, status)) counts[status] += 1;
    }
  }
  return counts;
}

function summarizeChecklistSteps(columns) {
  const labels = Array.isArray(columns)
    ? columns
      .map(column => clipLabel(column?.label ?? column?.id, 48))
      .filter(Boolean)
    : [];
  if (labels.length === 0) return null;
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} -> ${labels[1]}`;
  const preview = labels.slice(0, 3).join(' -> ');
  return labels.length > 3 ? `${preview} +${labels.length - 3} more` : preview;
}

function summarizeTargetGoal(target, columns) {
  const explicit = clipLabel(target?.instructions ?? target?.description, 220);
  if (explicit) return explicit;
  const steps = summarizeChecklistSteps(columns);
  return steps ? `Focus: ${steps}` : 'Focus: complete the assigned checklist items.';
}

export function buildChecklistBoard(config, taskRows = []) {
  if (!config || config.mode !== 'checklist') return null;

  const columns = config.items.map(item => ({
    id: item.id,
    label: item.label,
    order: item.order ?? 0,
  }));

  const tasks = Array.isArray(taskRows)
    ? taskRows
      .filter(task => task?.checklist?.mode === 'checklist')
      .slice()
      .sort(compareTaskSort)
    : [];

  const byTarget = new Map();
  for (const target of config.targets) {
    byTarget.set(target.id, []);
  }
  for (const task of tasks) {
    const targetId = coerceString(task?.checklist?.targetId);
    if (!targetId) continue;
    if (!byTarget.has(targetId)) byTarget.set(targetId, []);
    byTarget.get(targetId).push(task);
  }

  const rows = config.targets.map(target => {
    const targetTasks = byTarget.get(target.id) ?? [];
    const latestCycle = targetTasks.reduce((max, task) => {
      const cycle = Number.parseInt(task?.checklist?.cycle, 10) || 1;
      return Math.max(max, cycle);
    }, 1);

    let lastCompletedCycle = 0;
    for (let cycle = 1; cycle <= latestCycle; cycle += 1) {
      const cycleTasks = targetTasks.filter(task => (Number.parseInt(task?.checklist?.cycle, 10) || 1) === cycle);
      if (cycleTasks.length === 0) continue;
      const everyCompleted = cycleTasks.length === columns.length
        && cycleTasks.every(task => task?.status === 'completed');
      if (everyCompleted) lastCompletedCycle = cycle;
    }

    const cells = columns.map(column => {
      const match = targetTasks
        .filter(task =>
          (Number.parseInt(task?.checklist?.cycle, 10) || 1) === latestCycle
          && String(task?.checklist?.itemId ?? '') === column.id,
        )
        .at(-1);
      return {
        itemId: column.id,
        itemLabel: column.label,
        cycle: latestCycle,
        taskId: coerceString(match?.taskId ?? match?.id),
        agentId: coerceString(match?.agentId),
        status: coerceString(match?.status) ?? 'pending',
        outputPath: coerceString(match?.checklist?.outputPath),
        error: coerceString(match?.error),
        startedAt: match?.startedAt ?? null,
        finishedAt: match?.finishedAt ?? null,
        lastActivityAt: match?.lastActivityAt ?? null,
        lastActivity: coerceString(match?.lastActivity),
        lastActivityKind: coerceString(match?.lastActivityKind),
        summaryText: coerceString(match?.summaryTextDelta),
      };
    });

    return {
      targetId: target.id,
      label: target.label,
      description: target.description,
      instructions: target.instructions,
      goalSummary: summarizeTargetGoal(target, columns),
      stepsSummary: summarizeChecklistSteps(columns),
      order: target.order ?? 0,
      cycle: latestCycle,
      lastCompletedCycle,
      cells,
    };
  });

  return {
    mode: 'checklist',
    continuous: config.continuous === true,
    maxCycles: config.maxCycles ?? null,
    outputRoot: config.outputRoot,
    columns,
    rows,
    counts: summarizeVisibleCounts(rows),
  };
}
