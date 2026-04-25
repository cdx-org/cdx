import { git } from './git-worktree.js';

const MERGE_CONFLICT_MARKERS = [
  'merge conflict',
  'automatic merge failed',
  'conflit',
  'unmerged',
  'fix conflicts',
  'conflict',
];

function pushText(list, value) {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (trimmed) list.push(trimmed);
}

function collectErrorText(err) {
  const parts = [];
  if (!err) return '';
  if (err instanceof Error) {
    pushText(parts, err.message);
  }
  pushText(parts, err.message);
  pushText(parts, err.stderr);
  pushText(parts, err.stdout);
  const cause = err.cause;
  if (cause && typeof cause === 'object') {
    pushText(parts, cause.message);
    pushText(parts, cause.stderr);
    pushText(parts, cause.stdout);
  }
  return parts.join('\n');
}

export function isMergeConflictError(err) {
  const text = collectErrorText(err).toLowerCase();
  if (!text) return false;
  return MERGE_CONFLICT_MARKERS.some(marker => text.includes(marker));
}

async function hasMergeConflictState(cwd) {
  if (!cwd) return false;
  const unmerged = await git(['ls-files', '-u'], { cwd }).catch(() => '');
  if (String(unmerged ?? '').trim()) return true;
  const mergeHead = await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd }).catch(() => '');
  return Boolean(String(mergeHead ?? '').trim());
}

export async function detectMergeConflict({ err, cwd, log } = {}) {
  if (isMergeConflictError(err)) return true;
  const detected = await hasMergeConflictState(cwd);
  if (detected && typeof log === 'function') {
    log('Merge failed without conflict text; detected unmerged paths in repo state.');
  }
  return detected;
}

function clipInline(value, maxChars = 240) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= maxChars) return text;
  if (maxChars <= 3) return text.slice(0, maxChars);
  return text.slice(0, maxChars - 3) + '...';
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value ?? '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function parseStatusPath(line) {
  const raw = String(line ?? '').trim();
  if (!raw || raw.length < 4) return null;
  const pathPart = raw.slice(3).trim();
  if (!pathPart) return null;
  const arrowIndex = pathPart.lastIndexOf('->');
  if (arrowIndex !== -1) {
    const target = pathPart.slice(arrowIndex + 2).trim();
    return target || null;
  }
  return pathPart;
}

function parseStatusPaths(output) {
  return uniqueStrings(
    String(output ?? '')
      .split(/\r?\n/)
      .map(parseStatusPath)
      .filter(Boolean),
  );
}

function parseUnmergedPaths(output) {
  const lines = String(output ?? '').split(/\r?\n/).filter(Boolean);
  const paths = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.includes('\t')) {
      const parts = line.split('\t');
      const file = parts.slice(1).join('\t').trim();
      if (file) paths.push(file);
      continue;
    }
    const tokens = line.trim().split(/\s+/);
    const file = tokens.slice(3).join(' ').trim();
    if (file) paths.push(file);
  }
  return paths;
}

export async function summarizeMergeState({
  cwd,
  maxStatusLines = 6,
  maxStatusChars = 240,
  maxUnmerged = 6,
} = {}) {
  if (!cwd) return null;
  const statusRaw = await git(['status', '--porcelain'], { cwd }).catch(() => '');
  const statusLines = String(statusRaw ?? '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  const statusPaths = parseStatusPaths(statusRaw);
  const statusSummary = statusLines.length
    ? clipInline(statusLines.slice(0, maxStatusLines).join(' | '), maxStatusChars)
    : 'clean';

  const unmergedRaw = await git(['ls-files', '-u'], { cwd }).catch(() => '');
  const unmergedPaths = uniqueStrings(parseUnmergedPaths(unmergedRaw));
  const unmergedSummary = unmergedPaths.length
    ? `${unmergedPaths.length} files: ${unmergedPaths.slice(0, maxUnmerged).join(', ')}${unmergedPaths.length > maxUnmerged ? ' ...' : ''}`
    : 'none';

  const mergeHead = await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd }).catch(() => '');
  const mergeHeadSummary = String(mergeHead ?? '').trim() || 'none';

  return {
    statusSummary,
    statusCount: statusLines.length,
    statusPaths,
    unmergedSummary,
    unmergedCount: unmergedPaths.length,
    unmergedPaths,
    mergeHead: mergeHeadSummary,
  };
}
