function uniqueTaskIds(values) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const taskId = typeof value === 'string' ? value.trim() : '';
    if (!taskId || seen.has(taskId)) continue;
    seen.add(taskId);
    out.push(taskId);
  }
  return out;
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function normalizeConflictPath(value) {
  return String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

function parsePositiveInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function normalizeMergeAskRecord(record, { now, minAgeMs }) {
  const raw = isObject(record) ? record : {};
  const metadata = isObject(raw.metadata) ? raw.metadata : {};
  const autoAnswer = isObject(raw.autoAnswer) ? raw.autoAnswer : {};
  const kind =
    typeof autoAnswer.kind === 'string' && autoAnswer.kind.trim()
      ? autoAnswer.kind.trim()
      : typeof metadata.kind === 'string' && metadata.kind.trim()
        ? metadata.kind.trim()
        : '';
  if (kind !== 'dependency-merge-retry') return null;

  const askId = typeof raw.askId === 'string' ? raw.askId.trim() : '';
  if (!askId) return null;

  const taskId =
    typeof raw.taskId === 'string' && raw.taskId.trim()
      ? raw.taskId.trim()
      : typeof metadata.taskId === 'string' && metadata.taskId.trim()
        ? metadata.taskId.trim()
        : '';
  const worktreePath =
    typeof metadata.worktreePath === 'string' && metadata.worktreePath.trim()
      ? metadata.worktreePath.trim()
      : '';
  const dependencyId =
    typeof metadata.dependencyId === 'string' && metadata.dependencyId.trim()
      ? metadata.dependencyId.trim()
      : '';
  const dependencyBranch =
    typeof metadata.dependencyBranch === 'string' && metadata.dependencyBranch.trim()
      ? metadata.dependencyBranch.trim()
      : '';
  const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : 0;
  const recordMinAgeMs = parsePositiveInt(autoAnswer.minAgeMs, minAgeMs);
  const ageMs = createdAt > 0 ? Math.max(0, now - createdAt) : 0;
  if (ageMs < recordMinAgeMs) return null;

  const conflictPaths = uniqueStrings(
    (Array.isArray(metadata.conflictPaths) ? metadata.conflictPaths : [])
      .map(normalizeConflictPath)
      .filter(Boolean),
  );

  return {
    askId,
    taskId,
    worktreePath,
    dependencyId,
    dependencyBranch,
    createdAt,
    ageMs,
    conflictPaths,
  };
}

function buildOverlapGroups(records) {
  const byAskId = new Map(records.map(record => [record.askId, record]));
  const pathToAskIds = new Map();

  for (const record of records) {
    for (const conflictPath of record.conflictPaths) {
      if (!pathToAskIds.has(conflictPath)) pathToAskIds.set(conflictPath, new Set());
      pathToAskIds.get(conflictPath).add(record.askId);
    }
  }

  const visited = new Set();
  const groups = [];

  for (const record of records) {
    if (visited.has(record.askId) || record.conflictPaths.length === 0) continue;

    const queue = [record.askId];
    const askIds = [];
    const taskIds = [];
    const conflictPaths = new Set();
    visited.add(record.askId);

    while (queue.length > 0) {
      const askId = queue.shift();
      const current = byAskId.get(askId);
      if (!current) continue;
      askIds.push(current.askId);
      if (current.taskId) taskIds.push(current.taskId);

      for (const conflictPath of current.conflictPaths) {
        conflictPaths.add(conflictPath);
        const linkedAskIds = pathToAskIds.get(conflictPath) ?? [];
        for (const linkedAskId of linkedAskIds) {
          if (visited.has(linkedAskId)) continue;
          visited.add(linkedAskId);
          queue.push(linkedAskId);
        }
      }
    }

    groups.push({
      askIds,
      taskIds: uniqueTaskIds(taskIds),
      conflictPaths: [...conflictPaths],
    });
  }

  return groups;
}

export function selectDependencyBlockedActions(diagnostics = {}) {
  const blockedByFailed = uniqueTaskIds(diagnostics?.blockedByFailed);
  const blockedByBlocked = uniqueTaskIds(diagnostics?.blockedByBlocked)
    .filter(taskId => !blockedByFailed.includes(taskId));

  return {
    unrecoverableTaskIds: blockedByFailed,
    waitingOnBlockedTaskIds: blockedByBlocked,
  };
}

export function didInterventionMakeProgress(actions = [], stallRecovered = false) {
  if (stallRecovered) return true;

  const remaining = new Set(
    (Array.isArray(actions) ? actions : [])
      .map(action => (typeof action === 'string' ? action.trim() : ''))
      .filter(Boolean),
  );

  if (remaining.size === 0) return false;
  remaining.delete('deps-blocked');
  return remaining.size > 0;
}

export function planWatchdogMergeAskRecovery(
  records = [],
  { now = Date.now(), minAgeMs = 0, minTakeoverGroupSize = 2 } = {},
) {
  const effectiveMinAgeMs = parsePositiveInt(minAgeMs, 0);
  const effectiveMinTakeoverGroupSize = Math.max(2, parsePositiveInt(minTakeoverGroupSize, 2) || 2);

  const eligible = [];
  for (const record of Array.isArray(records) ? records : []) {
    const normalized = normalizeMergeAskRecord(record, {
      now,
      minAgeMs: effectiveMinAgeMs,
    });
    if (normalized) eligible.push(normalized);
  }

  const groups = buildOverlapGroups(eligible);
  const takeoverGroups = groups.filter(group => group.askIds.length >= effectiveMinTakeoverGroupSize);
  const takeoverAskIds = new Set(takeoverGroups.flatMap(group => group.askIds));
  const standalone = eligible.filter(record => !takeoverAskIds.has(record.askId));

  return {
    eligible,
    takeoverGroups,
    standalone,
  };
}
