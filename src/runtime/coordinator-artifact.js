function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function coerceString(value, maxChars = 400) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars - 1).trimEnd()}…` : trimmed;
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = coerceString(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function splitListText(value) {
  const text = coerceString(value, 2_000);
  if (!text) return [];

  const lines = text
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*[-*]\s*/, '').trim())
    .filter(Boolean);
  if (lines.length > 1) return lines;

  return text
    .split(/\s*;\s*/)
    .map(part => part.replace(/^\s*[-*]\s*/, '').trim())
    .filter(Boolean);
}

function normalizeStringList(value, { limit = 6, maxChars = 280 } = {}) {
  const source = Array.isArray(value) ? value : [value];
  const out = [];
  const seen = new Set();

  for (const entry of source) {
    const parts = typeof entry === 'string' ? splitListText(entry) : [entry];
    for (const part of parts) {
      const text = coerceString(part, maxChars);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      out.push(text);
      if (out.length >= limit) return out;
    }
  }

  return out;
}

function normalizeObjectList(value, normalizeEntry, { limit = 8 } = {}) {
  const source = Array.isArray(value) ? value : [value];
  const out = [];

  for (const entry of source) {
    const normalized = normalizeEntry(entry);
    if (!normalized) continue;
    out.push(normalized);
    if (out.length >= limit) break;
  }

  return out;
}

function uniqueEntries(items, keyFn, limit = 8) {
  const seen = new Set();
  const out = [];
  const source = Array.isArray(items) ? items : [];

  for (let index = source.length - 1; index >= 0; index -= 1) {
    const item = source[index];
    if (!item) continue;
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }

  return out.reverse();
}

function formatInlineList(values, limit = 4) {
  const list = uniqueStrings(values).slice(0, limit);
  if (list.length === 0) return null;
  return list.join(', ');
}

function normalizeListLimit(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, parsed);
}

function listDifference(base, extra) {
  const existing = new Set(uniqueStrings(base));
  return uniqueStrings(extra).filter(item => !existing.has(item));
}

function keyedObjectDifference(base, extra, keyFn, limit = 8) {
  const existing = new Set(
    (Array.isArray(base) ? base : [])
      .map(entry => keyFn(entry))
      .filter(Boolean),
  );
  const out = [];
  const source = Array.isArray(extra) ? extra : [];

  for (const entry of source) {
    if (!entry) continue;
    const key = keyFn(entry);
    if (!key || existing.has(key)) continue;
    existing.add(key);
    out.push(entry);
    if (out.length >= limit) break;
  }

  return out;
}

function normalizeEventDetailValue(
  value,
  {
    depth = 0,
    maxDepth = 2,
    maxArrayItems = 6,
    maxObjectEntries = 12,
    maxStringChars = 220,
  } = {},
) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return coerceString(value, maxStringChars);
  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (Array.isArray(value)) {
    const items = [];
    for (const entry of value) {
      const normalized = normalizeEventDetailValue(entry, {
        depth: depth + 1,
        maxDepth,
        maxArrayItems,
        maxObjectEntries,
        maxStringChars,
      });
      if (normalized === null || normalized === undefined) continue;
      items.push(normalized);
      if (items.length >= maxArrayItems) break;
    }
    return items.length > 0 ? items : null;
  }

  if (!isObject(value)) {
    return coerceString(String(value), maxStringChars);
  }

  if (depth >= maxDepth) {
    return coerceString(JSON.stringify(value), maxStringChars);
  }

  const out = {};
  let count = 0;
  for (const [key, entry] of Object.entries(value)) {
    if (!key) continue;
    const normalized = normalizeEventDetailValue(entry, {
      depth: depth + 1,
      maxDepth,
      maxArrayItems,
      maxObjectEntries,
      maxStringChars,
    });
    if (normalized === null || normalized === undefined) continue;
    out[key] = normalized;
    count += 1;
    if (count >= maxObjectEntries) break;
  }

  return Object.keys(out).length > 0 ? out : null;
}

function normalizeSingleLineText(value, maxChars = 180) {
  if (typeof value !== 'string') return null;
  const collapsed = value
    .replace(/[;|]+/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!collapsed) return null;
  const clipped = coerceString(collapsed, maxChars);
  return clipped ? clipped.replace(/[.,:;]+$/, '').trim() : null;
}

function extractJsonCandidate(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const candidate = fenced[1].trim();
    if (candidate.startsWith('{') && candidate.endsWith('}')) return candidate;
  }

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;

  const start = trimmed.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  for (let index = start; index < trimmed.length; index += 1) {
    const ch = trimmed[index];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return trimmed.slice(start, index + 1);
    }
  }

  const match = trimmed.match(/\{[\s\S]*\}/);
  return match ? match[0] : null;
}

function normalizeWatchdogReport(value) {
  const raw = isObject(value) ? value : {};
  const summary = coerceString(
    raw.summary
      ?? raw.report
      ?? raw.overview
      ?? raw.status
      ?? raw.reportSummary
      ?? raw.report_summary,
    500,
  );

  const likelyCauses = normalizeStringList(
    raw.likelyCauses
      ?? raw.likely_causes
      ?? raw.causes
      ?? raw.rootCauses
      ?? raw.root_causes,
    { limit: 6, maxChars: 280 },
  );
  const evidence = normalizeStringList(raw.evidence ?? raw.proof ?? raw.snapshotEvidence, {
    limit: 6,
    maxChars: 280,
  });
  const nextActions = normalizeStringList(
    raw.nextActions
      ?? raw.next_actions
      ?? raw.actions
      ?? raw.recommendations
      ?? raw.suggestedActions
      ?? raw.suggested_actions,
    { limit: 6, maxChars: 280 },
  );

  if (!summary && likelyCauses.length === 0 && evidence.length === 0 && nextActions.length === 0) {
    return null;
  }

  return {
    summary,
    likelyCauses,
    evidence,
    nextActions,
  };
}

function normalizeWatchdogSteerTask(value, maxChars = 500) {
  const raw = isObject(value) ? value : null;
  if (!raw) return null;

  const taskId = coerceString(raw.taskId ?? raw.task_id ?? raw.id ?? raw.task, 120);
  const message = coerceString(raw.message ?? raw.text ?? raw.note ?? raw.guidance, maxChars);
  if (!taskId || !message) return null;

  return { taskId, message };
}

function normalizeWatchdogSteer(value, { taskLimit = 3, maxChars = 500 } = {}) {
  const raw = isObject(value) ? value : {};
  const broadcast = normalizeStringList(
    raw.broadcast
      ?? raw.broadcastMessage
      ?? raw.broadcast_message
      ?? raw.messages,
    { limit: 1, maxChars },
  );

  const taskSource = raw.tasks ?? raw.taskMessages ?? raw.task_messages ?? raw.followUps ?? raw.follow_ups;
  const tasks = [];
  const seen = new Set();

  for (const entry of Array.isArray(taskSource) ? taskSource : [taskSource]) {
    const task = normalizeWatchdogSteerTask(entry, maxChars);
    if (!task) continue;
    const key = `${task.taskId}\u0000${task.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tasks.push(task);
    if (tasks.length >= taskLimit) break;
  }

  return { broadcast, tasks };
}

function hasCoordinatorArtifactShape(value) {
  if (!isObject(value)) return false;
  return (
    Object.hasOwn(value, 'goalSummary')
    || Object.hasOwn(value, 'goal_summary')
    || Object.hasOwn(value, 'sharedContext')
    || Object.hasOwn(value, 'shared_context')
    || Object.hasOwn(value, 'risks')
    || Object.hasOwn(value, 'verification')
    || Object.hasOwn(value, 'replanTriggers')
    || Object.hasOwn(value, 'replan_triggers')
    || Object.hasOwn(value, 'handoffs')
    || Object.hasOwn(value, 'interventions')
  );
}

function normalizeCoordinatorHandoff(value, { maxFiles = 4, maxChars = 320 } = {}) {
  const raw = isObject(value)
    ? value
    : typeof value === 'string'
      ? { summary: value }
      : null;
  if (!raw) return null;

  const taskId = coerceString(raw.taskId ?? raw.task_id ?? raw.id ?? raw.task, 120);
  const summary = coerceString(
    raw.summary
      ?? raw.message
      ?? raw.note
      ?? raw.description
      ?? raw.handoff,
    maxChars,
  );
  const status = coerceString(raw.status ?? raw.state, 40);
  const files = normalizeStringList(
    raw.files ?? raw.changedFiles ?? raw.changed_files,
    { limit: maxFiles, maxChars: 180 },
  );

  if (!taskId && !summary && files.length === 0) return null;

  return {
    taskId: taskId ?? 'task',
    summary: summary ?? (status ? `${status} update` : 'task update'),
    status,
    files,
  };
}

function normalizeCoordinatorIntervention(value, maxChars = 320) {
  const raw = isObject(value)
    ? value
    : typeof value === 'string'
      ? { summary: value }
      : null;
  if (!raw) return null;

  const source = coerceString(raw.source ?? raw.kind ?? raw.owner, 80) ?? 'coordinator';
  const summary = coerceString(
    raw.summary
      ?? raw.message
      ?? raw.note
      ?? raw.description,
    maxChars,
  );
  const reason = coerceString(raw.reason ?? raw.trigger ?? raw.context, 180);

  if (!summary && !reason) return null;

  return {
    source,
    summary: summary ?? reason,
    reason,
  };
}

function normalizeCoordinatorActionTaskControl(value, maxChars = 220) {
  const raw = isObject(value)
    ? value
    : typeof value === 'string'
      ? { taskId: value }
      : null;
  if (!raw) return null;

  const taskId = coerceString(raw.taskId ?? raw.task_id ?? raw.id ?? raw.task, 120);
  const reason = coerceString(
    raw.reason
      ?? raw.message
      ?? raw.note
      ?? raw.summary,
    maxChars,
  );
  if (!taskId) return null;
  return { taskId, reason };
}

function normalizeCoordinatorActionInjectTask(value) {
  if (!isObject(value)) return null;

  const id = coerceString(value.id, 120);
  const description = coerceString(
    value.description
      ?? value.title
      ?? value.summary,
    280,
  );
  const dependsOn = normalizeStringList(value.dependsOn ?? value.dependencies, {
    limit: 8,
    maxChars: 120,
  });
  const prompt = coerceString(value.prompt, 1200);

  const ownership = isObject(value.ownership)
    ? {
        ...(coerceString(value.ownership.scope ?? value.ownership.responsibility, 220)
          ? { scope: coerceString(value.ownership.scope ?? value.ownership.responsibility, 220) }
          : {}),
        ...(normalizeStringList(
          value.ownership.paths
            ?? value.ownership.files
            ?? value.ownership.ownedPaths
            ?? value.ownership.ownedFiles,
          { limit: 8, maxChars: 180 },
        ).length > 0
          ? {
              paths: normalizeStringList(
                value.ownership.paths
                  ?? value.ownership.files
                  ?? value.ownership.ownedPaths
                  ?? value.ownership.ownedFiles,
                { limit: 8, maxChars: 180 },
              ),
            }
          : {}),
      }
    : null;

  const checklist = isObject(value.checklist) ? { ...value.checklist } : null;
  if (!id && !description) return null;

  return {
    ...(id ? { id } : {}),
    ...(description ? { description } : {}),
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
    ...(prompt ? { prompt } : {}),
    ...(ownership && Object.keys(ownership).length > 0 ? { ownership } : {}),
    ...(checklist ? { checklist } : {}),
  };
}

function normalizeCoordinatorActions(value) {
  const raw = isObject(value) ? value : {};
  const injectTasks = normalizeObjectList(
    raw.injectTasks
      ?? raw.inject_tasks
      ?? raw.runtimeInjection
      ?? raw.runtime_injection,
    entry => normalizeCoordinatorActionInjectTask(entry),
    { limit: 6 },
  );
  const abortTasks = normalizeObjectList(
    raw.abortTasks ?? raw.abort_tasks,
    entry => normalizeCoordinatorActionTaskControl(entry),
    { limit: 6 },
  );
  const retryTasks = normalizeObjectList(
    raw.retryTasks ?? raw.retry_tasks,
    entry => normalizeCoordinatorActionTaskControl(entry),
    { limit: 6 },
  );
  const respawnTasks = normalizeObjectList(
    raw.respawnTasks ?? raw.respawn_tasks,
    entry => normalizeCoordinatorActionTaskControl(entry),
    { limit: 6 },
  );

  if (
    injectTasks.length === 0
    && abortTasks.length === 0
    && retryTasks.length === 0
    && respawnTasks.length === 0
  ) {
    return null;
  }

  return {
    injectTasks,
    abortTasks,
    retryTasks,
    respawnTasks,
  };
}

export function hasCoordinatorArtifactData(value) {
  return Boolean(
    value
      && (
        value.goalSummary
        || (Array.isArray(value.sharedContext) && value.sharedContext.length > 0)
        || (Array.isArray(value.risks) && value.risks.length > 0)
        || (Array.isArray(value.verification) && value.verification.length > 0)
        || (Array.isArray(value.replanTriggers) && value.replanTriggers.length > 0)
        || (Array.isArray(value.handoffs) && value.handoffs.length > 0)
        || (Array.isArray(value.interventions) && value.interventions.length > 0)
      ),
  );
}

export function normalizeCoordinatorArtifact(value) {
  const raw = isObject(value) ? value : null;
  if (!raw) return null;

  const goalSummary = coerceString(
    raw.goalSummary
      ?? raw.goal_summary
      ?? raw.summary
      ?? raw.goalBrief
      ?? raw.goal_brief,
    500,
  );
  const sharedContext = normalizeStringList(
    raw.sharedContext
      ?? raw.shared_context
      ?? raw.context
      ?? raw.workerContext
      ?? raw.worker_context,
    { limit: 8, maxChars: 280 },
  );
  const risks = normalizeStringList(
    raw.risks
      ?? raw.watchouts
      ?? raw.watch_outs
      ?? raw.guardrails
      ?? raw.pitfalls,
    { limit: 8, maxChars: 280 },
  );
  const verification = normalizeStringList(
    raw.verification
      ?? raw.validation
      ?? raw.checks
      ?? raw.verificationStrategy
      ?? raw.verification_strategy,
    { limit: 8, maxChars: 280 },
  );
  const replanTriggers = normalizeStringList(
    raw.replanTriggers
      ?? raw.replan_triggers
      ?? raw.interventionTriggers
      ?? raw.intervention_triggers
      ?? raw.watchdogTriggers
      ?? raw.watchdog_triggers,
    { limit: 8, maxChars: 280 },
  );
  const handoffs = uniqueEntries(
    normalizeObjectList(
      raw.handoffs
        ?? raw.taskHandoffs
        ?? raw.task_handoffs
        ?? raw.completedTaskHandoffs
        ?? raw.completed_task_handoffs,
      entry => normalizeCoordinatorHandoff(entry),
      { limit: 8 },
    ),
    entry => `${entry.taskId}\u0000${entry.summary}\u0000${entry.files.join('\u0001')}`,
    8,
  );
  const interventions = uniqueEntries(
    normalizeObjectList(
      raw.interventions
        ?? raw.watchdogInterventions
        ?? raw.watchdog_interventions
        ?? raw.findings,
      entry => normalizeCoordinatorIntervention(entry),
      { limit: 8 },
    ),
    entry => `${entry.source}\u0000${entry.summary}`,
    8,
  );

  const artifact = {
    goalSummary,
    sharedContext,
    risks,
    verification,
    replanTriggers,
    handoffs,
    interventions,
  };

  return hasCoordinatorArtifactData(artifact) ? artifact : null;
}

export function mergeCoordinatorArtifacts(base, extra) {
  const left = normalizeCoordinatorArtifact(base);
  const right = normalizeCoordinatorArtifact(extra);
  if (!left && !right) return null;
  if (!left) return right;
  if (!right) return left;

  const merged = {
    goalSummary: right.goalSummary ?? left.goalSummary ?? null,
    sharedContext: uniqueStrings([...(left.sharedContext ?? []), ...(right.sharedContext ?? [])]).slice(0, 8),
    risks: uniqueStrings([...(left.risks ?? []), ...(right.risks ?? [])]).slice(0, 8),
    verification: uniqueStrings([...(left.verification ?? []), ...(right.verification ?? [])]).slice(0, 8),
    replanTriggers: uniqueStrings([...(left.replanTriggers ?? []), ...(right.replanTriggers ?? [])]).slice(0, 8),
    handoffs: uniqueEntries(
      [...(left.handoffs ?? []), ...(right.handoffs ?? [])],
      entry => `${entry.taskId}\u0000${entry.summary}\u0000${(entry.files ?? []).join('\u0001')}`,
      8,
    ),
    interventions: uniqueEntries(
      [...(left.interventions ?? []), ...(right.interventions ?? [])],
      entry => `${entry.source}\u0000${entry.summary}`,
      8,
    ),
  };

  return hasCoordinatorArtifactData(merged) ? merged : null;
}

export function buildCoordinatorArtifactDelta(base, extra) {
  const left = normalizeCoordinatorArtifact(base);
  const right = normalizeCoordinatorArtifact(extra);
  if (!right) return null;

  const handoffKey = entry => `${entry.taskId}\u0000${entry.summary}\u0000${(entry.files ?? []).join('\u0001')}`;
  const interventionKey = entry => `${entry.source}\u0000${entry.summary}`;
  const delta = {
    goalSummary: right.goalSummary && right.goalSummary !== left?.goalSummary ? right.goalSummary : null,
    sharedContextAdded: listDifference(left?.sharedContext ?? [], right.sharedContext ?? []).slice(0, 6),
    risksAdded: listDifference(left?.risks ?? [], right.risks ?? []).slice(0, 6),
    verificationAdded: listDifference(left?.verification ?? [], right.verification ?? []).slice(0, 6),
    replanTriggersAdded: listDifference(left?.replanTriggers ?? [], right.replanTriggers ?? []).slice(0, 6),
    handoffsAdded: keyedObjectDifference(left?.handoffs ?? [], right.handoffs ?? [], handoffKey, 4),
    interventionsAdded: keyedObjectDifference(
      left?.interventions ?? [],
      right.interventions ?? [],
      interventionKey,
      4,
    ),
  };

  return (
    delta.goalSummary
    || delta.sharedContextAdded.length > 0
    || delta.risksAdded.length > 0
    || delta.verificationAdded.length > 0
    || delta.replanTriggersAdded.length > 0
    || delta.handoffsAdded.length > 0
    || delta.interventionsAdded.length > 0
  )
    ? delta
    : null;
}

export function formatCoordinatorArtifactDelta(
  delta,
  { heading = 'Coordinator artifact delta' } = {},
) {
  if (!delta || !isObject(delta)) {
    return heading ? `${heading}:\n- none` : '- none';
  }

  const lines = [];
  if (heading) lines.push(`${heading}:`);
  if (delta.goalSummary) lines.push(`Goal summary update: ${delta.goalSummary}`);
  if (Array.isArray(delta.sharedContextAdded) && delta.sharedContextAdded.length > 0) {
    lines.push('Add shared context:');
    for (const item of delta.sharedContextAdded) lines.push(`- ${item}`);
  }
  if (Array.isArray(delta.risksAdded) && delta.risksAdded.length > 0) {
    lines.push('Add risks / guardrails:');
    for (const item of delta.risksAdded) lines.push(`- ${item}`);
  }
  if (Array.isArray(delta.verificationAdded) && delta.verificationAdded.length > 0) {
    lines.push('Add verification priorities:');
    for (const item of delta.verificationAdded) lines.push(`- ${item}`);
  }
  if (Array.isArray(delta.replanTriggersAdded) && delta.replanTriggersAdded.length > 0) {
    lines.push('Add replan triggers:');
    for (const item of delta.replanTriggersAdded) lines.push(`- ${item}`);
  }
  if (Array.isArray(delta.handoffsAdded) && delta.handoffsAdded.length > 0) {
    lines.push('New handoffs:');
    for (const item of delta.handoffsAdded) {
      const label = item.status ? `${item.taskId} (${item.status})` : item.taskId;
      const files = formatInlineList(item.files, 4);
      lines.push(`- ${label}: ${item.summary}${files ? ` [files: ${files}]` : ''}`);
    }
  }
  if (Array.isArray(delta.interventionsAdded) && delta.interventionsAdded.length > 0) {
    lines.push('New interventions:');
    for (const item of delta.interventionsAdded) {
      lines.push(`- ${item.source}: ${item.summary}${item.reason ? ` (${item.reason})` : ''}`);
    }
  }

  return lines.length > (heading ? 1 : 0) ? lines.join('\n') : `${heading}:\n- none`;
}

export function formatCoordinatorArtifact(
  artifact,
  {
    heading = 'Coordinator plan artifact',
    sharedContextSummary = null,
    listLimit = 8,
    handoffLimit = 8,
    interventionLimit = 8,
    includeCountSummary = false,
  } = {},
) {
  const normalized = normalizeCoordinatorArtifact(artifact);
  const summary = coerceString(sharedContextSummary, 500);
  const normalizedListLimit = normalizeListLimit(listLimit, 8);
  const normalizedHandoffLimit = normalizeListLimit(handoffLimit, 8);
  const normalizedInterventionLimit = normalizeListLimit(interventionLimit, 8);
  const allSharedContext = summary
    ? uniqueStrings([...(normalized?.sharedContext ?? []), summary]).slice(0, 8)
    : normalized?.sharedContext ?? [];
  const sharedContext = allSharedContext.slice(0, normalizedListLimit);
  const risks = (normalized?.risks ?? []).slice(0, normalizedListLimit);
  const verification = (normalized?.verification ?? []).slice(0, normalizedListLimit);
  const replanTriggers = (normalized?.replanTriggers ?? []).slice(0, normalizedListLimit);
  const handoffs = (normalized?.handoffs ?? []).slice(0, normalizedHandoffLimit);
  const interventions = (normalized?.interventions ?? []).slice(0, normalizedInterventionLimit);

  const lines = [];
  if (heading) lines.push(`${heading}:`);
  if (normalized?.goalSummary) lines.push(`Goal summary: ${normalized.goalSummary}`);
  if (sharedContext.length > 0) {
    lines.push('Shared context:');
    for (const item of sharedContext) lines.push(`- ${item}`);
  }
  if (risks.length > 0) {
    lines.push('Known risks / guardrails:');
    for (const item of risks) lines.push(`- ${item}`);
  }
  if (verification.length > 0) {
    lines.push('Verification priorities:');
    for (const item of verification) lines.push(`- ${item}`);
  }
  if (replanTriggers.length > 0) {
    lines.push('Replan / watchdog triggers:');
    for (const item of replanTriggers) lines.push(`- ${item}`);
  }
  if (handoffs.length > 0) {
    lines.push('Recent task handoffs:');
    for (const item of handoffs) {
      const label = item.status ? `${item.taskId} (${item.status})` : item.taskId;
      const files = formatInlineList(item.files, 4);
      lines.push(`- ${label}: ${item.summary}${files ? ` [files: ${files}]` : ''}`);
    }
  }
  if (interventions.length > 0) {
    lines.push('Recent coordinator interventions:');
    for (const item of interventions) {
      lines.push(`- ${item.source}: ${item.summary}${item.reason ? ` (${item.reason})` : ''}`);
    }
  }
  if (includeCountSummary) {
    const countNotes = [];
    if ((allSharedContext.length - sharedContext.length) > 0) {
      countNotes.push(`${allSharedContext.length - sharedContext.length} more shared context`);
    }
    if (((normalized?.risks ?? []).length - risks.length) > 0) {
      countNotes.push(`${(normalized?.risks ?? []).length - risks.length} more risks`);
    }
    if (((normalized?.verification ?? []).length - verification.length) > 0) {
      countNotes.push(`${(normalized?.verification ?? []).length - verification.length} more verification items`);
    }
    if (((normalized?.replanTriggers ?? []).length - replanTriggers.length) > 0) {
      countNotes.push(`${(normalized?.replanTriggers ?? []).length - replanTriggers.length} more replan triggers`);
    }
    if (((normalized?.handoffs ?? []).length - handoffs.length) > 0) {
      countNotes.push(`${(normalized?.handoffs ?? []).length - handoffs.length} more handoffs`);
    }
    if (((normalized?.interventions ?? []).length - interventions.length) > 0) {
      countNotes.push(`${(normalized?.interventions ?? []).length - interventions.length} more interventions`);
    }
    if (countNotes.length > 0) lines.push(`Retained but omitted for brevity: ${countNotes.join('; ')}.`);
  }

  return lines.length > (heading ? 1 : 0) ? lines.join('\n') : '';
}

export function formatCoordinatorSteer(steer, { heading = 'Coordinator steer proposal' } = {}) {
  const normalized = normalizeWatchdogSteer(steer ?? {});
  const hasMessages = normalized.broadcast.length > 0 || normalized.tasks.length > 0;
  if (!hasMessages) return heading ? `${heading}:\n- none` : '- none';

  const lines = [];
  if (heading) lines.push(`${heading}:`);
  if (normalized.broadcast.length > 0) {
    lines.push('Broadcast messages:');
    for (const item of normalized.broadcast) lines.push(`- ${item}`);
  }
  if (normalized.tasks.length > 0) {
    lines.push('Task-targeted messages:');
    for (const item of normalized.tasks) {
      lines.push(`- ${item.taskId}: ${item.message}`);
    }
  }

  return lines.join('\n');
}

export function buildCoordinatorEventEnvelope(value) {
  const raw = isObject(value) ? value : {};
  const envelope = {
    type: coerceString(raw.type ?? raw.eventType ?? raw.event_type, 120) ?? 'event',
    summary: coerceString(raw.summary ?? raw.note ?? raw.title, 400) ?? 'event update',
  };

  const seq = Number.parseInt(raw.seq, 10);
  if (Number.isFinite(seq) && seq > 0) envelope.seq = seq;

  const phase = coerceString(raw.phase, 80);
  if (phase) envelope.phase = phase;

  const wave = Number.parseInt(raw.wave, 10);
  if (Number.isFinite(wave) && wave >= 0) envelope.wave = wave;

  const taskId = coerceString(raw.taskId ?? raw.task_id, 120);
  if (taskId) envelope.taskId = taskId;

  const details = normalizeEventDetailValue(raw.details ?? raw.payload ?? raw.data, {
    maxDepth: 2,
    maxArrayItems: 8,
    maxObjectEntries: 12,
    maxStringChars: 220,
  });
  if (details && (
    (Array.isArray(details) && details.length > 0)
    || (isObject(details) && Object.keys(details).length > 0)
    || typeof details === 'string'
    || typeof details === 'number'
    || typeof details === 'boolean'
  )) {
    envelope.details = details;
  }

  return envelope;
}

export function formatCoordinatorEventEnvelope(event, { heading = 'Event envelope' } = {}) {
  const envelope = buildCoordinatorEventEnvelope(event);
  const payload = JSON.stringify(envelope, null, 2);
  return heading ? `${heading}:\n${payload}` : payload;
}

export function formatCanonicalCoordinatorEventSummary(value) {
  const raw = isObject(value) ? value : {};
  const normalizedSteer = normalizeWatchdogSteer(raw.steer ?? {});
  const eventType = normalizeSingleLineText(raw.eventType ?? raw.type, 80) ?? 'event';
  const phase = normalizeSingleLineText(raw.phase, 40) ?? '-';
  const taskId = normalizeSingleLineText(raw.taskId ?? raw.task_id, 80) ?? '-';
  const wave = Number.parseInt(raw.wave, 10);
  const broadcastCount = Math.max(
    0,
    Number.parseInt(raw.broadcastCount ?? normalizedSteer.broadcast.length, 10) || 0,
  );
  const taskCount = Math.max(
    0,
    Number.parseInt(raw.taskCount ?? normalizedSteer.tasks.length, 10) || 0,
  );
  const note = normalizeSingleLineText(
    raw.note
      ?? raw.eventSummary
      ?? raw.event_summary
      ?? raw.summary,
    160,
  ) ?? '-';
  const ledger =
    raw.artifactChanged === false
      ? 'unchanged'
      : raw.artifactChanged === true
        ? 'updated'
        : 'unknown';

  return `event=${eventType}; phase=${phase}; wave=${Number.isFinite(wave) && wave >= 0 ? wave : '-'}; task=${taskId}; ledger=${ledger}; steer=b${broadcastCount}/t${taskCount}; note=${note}`;
}

export function formatWatchdogReport(report) {
  const normalized = normalizeWatchdogReport(report);
  if (!normalized) return '';

  const lines = [];
  if (normalized.summary) lines.push(normalized.summary);
  if (normalized.likelyCauses.length > 0) {
    lines.push('Likely causes:');
    for (const item of normalized.likelyCauses) lines.push(`- ${item}`);
  }
  if (normalized.evidence.length > 0) {
    lines.push('Evidence:');
    for (const item of normalized.evidence) lines.push(`- ${item}`);
  }
  if (normalized.nextActions.length > 0) {
    lines.push('Suggested next actions:');
    for (const item of normalized.nextActions) lines.push(`- ${item}`);
  }
  return lines.join('\n');
}

export function parseWatchdogResponse(text) {
  const candidate = extractJsonCandidate(text);
  if (!candidate) return null;

  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }

  if (!isObject(parsed)) return null;
  const report = normalizeWatchdogReport(parsed.report ?? parsed.analysis ?? parsed);
  const steer = normalizeWatchdogSteer(parsed.steer ?? parsed.guidance ?? {});
  const coordinationUpdate = normalizeCoordinatorArtifact(
    parsed.coordinationUpdate
      ?? parsed.coordination_update
      ?? parsed.artifactUpdate
      ?? parsed.artifact_update,
  );

  if (!report && !coordinationUpdate && steer.broadcast.length === 0 && steer.tasks.length === 0) return null;

  return { report, steer, coordinationUpdate };
}

export function parseCoordinatorResponse(text) {
  const candidate = extractJsonCandidate(text);
  if (!candidate) return null;

  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }

  if (!isObject(parsed)) return null;

  const artifactSource =
    parsed.artifact
      ?? parsed.coordinatorArtifact
      ?? parsed.coordinator_artifact
      ?? parsed.coordination
      ?? parsed.coordinationUpdate
      ?? parsed.coordination_update
      ?? parsed.artifactUpdate
      ?? parsed.artifact_update
      ?? (hasCoordinatorArtifactShape(parsed) ? parsed : null);
  const artifact = normalizeCoordinatorArtifact(artifactSource);
  const steer = normalizeWatchdogSteer(parsed.steer ?? parsed.guidance ?? {});
  const actions = normalizeCoordinatorActions(
    parsed.actions
      ?? parsed.orchestration
      ?? parsed.control
      ?? {
        injectTasks: parsed.injectTasks ?? parsed.inject_tasks,
        abortTasks: parsed.abortTasks ?? parsed.abort_tasks,
        retryTasks: parsed.retryTasks ?? parsed.retry_tasks,
        respawnTasks: parsed.respawnTasks ?? parsed.respawn_tasks,
      },
  );
  const eventSummary = coerceString(
    parsed.eventSummary
      ?? parsed.event_summary
      ?? parsed.note
      ?? parsed.coordinatorNote
      ?? parsed.coordinator_note,
    500,
  );

  if (
    !artifact
    && !eventSummary
    && !actions
    && steer.broadcast.length === 0
    && steer.tasks.length === 0
  ) {
    return null;
  }

  return { artifact, steer, actions, eventSummary };
}
