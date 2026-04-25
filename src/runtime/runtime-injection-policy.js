function coerceString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function uniqueList(items) {
  const out = [];
  const seen = new Set();
  for (const item of items ?? []) {
    const value = coerceString(item);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function normalizeTask(task) {
  if (!task || typeof task !== 'object') return null;
  const id = coerceString(task.id);
  if (!id) return null;
  return {
    ...task,
    id,
    dependsOn: uniqueList(Array.isArray(task.dependsOn) ? task.dependsOn : []),
  };
}

export function normalizeRuntimeInjectionPolicy(policy = {}) {
  const normalized = policy && typeof policy === 'object' ? policy : {};
  const hasAllowedExternalDepIds = Array.isArray(normalized.allowedExternalDepIds);
  const hasAllowInternalDeps = Object.hasOwn(normalized, 'allowInternalDeps');
  return {
    kind: coerceString(normalized.kind) ?? 'runtime',
    allowInternalDeps: hasAllowInternalDeps ? normalized.allowInternalDeps === true : true,
    restrictExternalDeps: hasAllowedExternalDepIds,
    allowedExternalDepIds: hasAllowedExternalDepIds
      ? uniqueList(normalized.allowedExternalDepIds)
      : [],
    dropDepIds: uniqueList(normalized.dropDepIds),
  };
}

export function sanitizeRuntimeInjectedTasks(tasks, policy = {}) {
  const normalizedPolicy = normalizeRuntimeInjectionPolicy(policy);
  const normalizedTasks = (Array.isArray(tasks) ? tasks : [])
    .map(normalizeTask)
    .filter(Boolean);
  const internalTaskIds = new Set(normalizedTasks.map(task => task.id));
  const allowedExternalDepIds = new Set(normalizedPolicy.allowedExternalDepIds);
  const dropDepIds = new Set(normalizedPolicy.dropDepIds);

  let removedDependencyCount = 0;
  const removedByTask = [];

  const sanitizedTasks = normalizedTasks.map(task => {
    const removedDependencies = [];
    const keptDependencies = [];

    for (const depId of task.dependsOn ?? []) {
      if (!depId || depId === task.id || dropDepIds.has(depId)) {
        removedDependencies.push(depId);
        continue;
      }

      if (internalTaskIds.has(depId)) {
        if (normalizedPolicy.allowInternalDeps) {
          keptDependencies.push(depId);
        } else {
          removedDependencies.push(depId);
        }
        continue;
      }

      if (allowedExternalDepIds.has(depId)) {
        keptDependencies.push(depId);
      } else if (!normalizedPolicy.restrictExternalDeps) {
        keptDependencies.push(depId);
      } else {
        removedDependencies.push(depId);
      }
    }

    if (removedDependencies.length > 0) {
      removedDependencyCount += removedDependencies.length;
      removedByTask.push({
        taskId: task.id,
        removedDependencies,
      });
    }

    return {
      ...task,
      dependsOn: uniqueList(keptDependencies),
    };
  });

  return {
    policy: normalizedPolicy,
    tasks: sanitizedTasks,
    mutated: removedDependencyCount > 0,
    removedDependencyCount,
    affectedTaskIds: removedByTask.map(entry => entry.taskId),
    removedByTask,
  };
}
