import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';
import zlib from 'node:zlib';
import { open, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';

import { git } from './git-worktree.js';
import { computeTextTokenCostUsd, normalizePricingTier } from './openai-pricing.js';
import { renderDashboardLayout } from './cdx-stats-dashboard-cards.js';
import { buildChecklistBoard } from './checklist-mode.js';

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseNonNegativeInt(value) {
  const num = Number.parseInt(value, 10);
  if (!Number.isFinite(num) || num < 0) return null;
  return num;
}

function pickFirstString(...values) {
  for (const candidate of values) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function pickFirstPid(...values) {
  for (const candidate of values) {
    const parsed = parseNonNegativeInt(candidate);
    if (parsed !== null) return parsed;
  }
  return null;
}

function coerceAttrString(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function getAttrValue(source, key) {
  if (!isObject(source) || !key) return null;
  if (Object.hasOwn(source, key)) return source[key];
  if (!key.includes('.')) return null;
  const parts = key.split('.');
  let cur = source;
  for (const part of parts) {
    if (!isObject(cur) || !(part in cur)) return null;
    cur = cur[part];
  }
  return cur;
}

function pickAttrString(keys, sources) {
  if (!Array.isArray(keys) || keys.length === 0) return null;
  for (const key of keys) {
    for (const source of sources) {
      const value = getAttrValue(source, key);
      const str = coerceAttrString(value);
      if (str) return str;
    }
  }
  return null;
}

function maybeParseJsonObject(value) {
  if (!value) return null;
  if (isObject(value)) return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function formatOtlpValue(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    const json = JSON.stringify(value);
    if (typeof json === 'string') return json;
  } catch {}
  return String(value);
}

function readTokenCount(obj, ...paths) {
  if (!isObject(obj)) return null;
  for (const pathKey of paths) {
    if (!pathKey) continue;
    if (typeof pathKey === 'string' && pathKey.includes('.')) {
      const parts = pathKey.split('.');
      let cur = obj;
      for (const part of parts) {
        if (!isObject(cur) || !(part in cur)) {
          cur = null;
          break;
        }
        cur = cur[part];
      }
      const parsed = parseNonNegativeInt(cur);
      if (parsed !== null) return parsed;
      continue;
    }
    const parsed = parseNonNegativeInt(obj[pathKey]);
    if (parsed !== null) return parsed;
  }
  return null;
}

function formatUsd(value) {
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round(value * 1e8) / 1e8;
  return rounded;
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function sendText(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.statusCode = status;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

function escapePromLabelValue(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"');
}

function formatPromLabels(labels) {
  if (!labels || !isObject(labels)) return '';
  const parts = [];
  for (const [key, value] of Object.entries(labels)) {
    if (!key) continue;
    parts.push(`${key}="${escapePromLabelValue(value)}"`);
  }
  return parts.length > 0 ? `{${parts.join(',')}}` : '';
}

function promSample(name, labels, value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '';
  return `${name}${formatPromLabels(labels)} ${num}\n`;
}

function promHistogram({ name, help, values, buckets, labels }) {
  const vals = Array.isArray(values)
    ? values.map(v => Number(v)).filter(v => Number.isFinite(v) && v >= 0)
    : [];
  const bucketBounds = Array.isArray(buckets)
    ? buckets.map(v => Number(v)).filter(v => Number.isFinite(v) && v >= 0).sort((a, b) => a - b)
    : [];

  const lines = [];
  if (help) lines.push(`# HELP ${name} ${help}\n`);
  lines.push(`# TYPE ${name} histogram\n`);

  if (vals.length === 0) {
    for (const bound of bucketBounds) {
      lines.push(promSample(`${name}_bucket`, { ...labels, le: String(bound) }, 0));
    }
    lines.push(promSample(`${name}_bucket`, { ...labels, le: '+Inf' }, 0));
    lines.push(promSample(`${name}_sum`, labels, 0));
    lines.push(promSample(`${name}_count`, labels, 0));
    return lines.join('');
  }

  const counts = new Array(bucketBounds.length + 1).fill(0);
  let sum = 0;

  for (const v of vals) {
    sum += v;
    let placed = false;
    for (let idx = 0; idx < bucketBounds.length; idx += 1) {
      if (v <= bucketBounds[idx]) {
        counts[idx] += 1;
        placed = true;
        break;
      }
    }
    if (!placed) counts[bucketBounds.length] += 1;
  }

  let cumulative = 0;
  for (let idx = 0; idx < bucketBounds.length; idx += 1) {
    cumulative += counts[idx];
    lines.push(promSample(`${name}_bucket`, { ...labels, le: String(bucketBounds[idx]) }, cumulative));
  }
  cumulative += counts[bucketBounds.length];
  lines.push(promSample(`${name}_bucket`, { ...labels, le: '+Inf' }, cumulative));
  lines.push(promSample(`${name}_sum`, labels, sum));
  lines.push(promSample(`${name}_count`, labels, vals.length));
  return lines.join('');
}

function stripAnsi(value) {
  return String(value ?? '').replace(
    /\u001b\[[0-9;]*m/g,
    '',
  );
}

function normalizeLogMessage(message) {
  if (isObject(message)) {
    const text =
      typeof message.text === 'string'
        ? message.text
        : typeof message.message === 'string'
          ? message.message
          : String(message.text ?? message.message ?? '');
    const agentId = typeof message.agentId === 'string' ? message.agentId.trim() : '';
    return { text, stream: message.stream === true, agentId: agentId || null };
  }
  return { text: String(message ?? ''), stream: false, agentId: null };
}

function parseAgentPrefix(message) {
  const text = String(message ?? '');
  const match = text.match(/^\[([^\]]+)\]\s*(.*)$/);
  if (!match) return { agentId: 'server', text: stripAnsi(text) };
  return { agentId: match[1], text: stripAnsi(match[2] ?? '') };
}

function clipSummaryDeltaText(value, max = 6000) {
  const text = String(value ?? '').replace(/\r/g, '');
  if (!text) return '';
  if (text.length <= max) return text;
  return text.slice(text.length - max);
}

function clipTextBlock(value, max = 6000) {
  const text = String(value ?? '').replace(/\r/g, '');
  if (!text) return '';
  if (text.length <= max) return text;
  return text.slice(text.length - max);
}

function mergeSummaryDeltaText(prev, next, max = 6000) {
  const existing = typeof prev === 'string' ? prev : '';
  const incoming = typeof next === 'string' ? next : '';
  if (!incoming) return existing;
  const trimmed = incoming.replace(/\r/g, '');
  let combined = '';
  if (existing && trimmed.startsWith(existing)) {
    combined = trimmed;
  } else if (existing) {
    combined = existing + trimmed;
  } else {
    combined = trimmed;
  }
  return clipSummaryDeltaText(combined, max);
}

function isDeltaMethodName(method) {
  const normalized = typeof method === 'string' ? method.toLowerCase() : '';
  if (!normalized) return false;
  return normalized.includes('delta');
}

function extractSummaryDeltaText(method, params) {
  if (!isDeltaMethodName(method) || !isObject(params)) return null;
  const direct = pickFirstString(
    params.summaryTextDelta,
    params.summary_text_delta,
    params.delta,
    params.text,
    params.content,
    params.content?.text,
    params.message?.delta,
    params.message?.text,
    params.data?.delta,
    params.data?.text,
  );
  if (direct) return direct;
  const deltaObj = isObject(params.delta) ? params.delta : null;
  const dataObj = isObject(params.data) ? params.data : null;
  const messageObj = isObject(params.message) ? params.message : null;
  return pickFirstString(
    deltaObj?.summaryTextDelta,
    deltaObj?.summary_text_delta,
    deltaObj?.text,
    deltaObj?.content,
    deltaObj?.content?.text,
    dataObj?.summaryTextDelta,
    dataObj?.summary_text_delta,
    dataObj?.text,
    dataObj?.content,
    dataObj?.content?.text,
    messageObj?.delta,
    messageObj?.text,
  );
}

async function filterExistingRevisions(repoRoot, revisions) {
  const checks = (Array.isArray(revisions) ? revisions : []).map(async rev => {
    const candidate = String(rev ?? '').trim();
    if (!candidate || candidate === '--all') return null;
    try {
      await git(['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], { cwd: repoRoot });
      return candidate;
    } catch {
      return null;
    }
  });

  const results = await Promise.all(checks);
  return results.filter(Boolean);
}

function parseBoolParam(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

const WORKTREE_STATUS_TTL_MS = 20_000;
const LOG_AGENT_MESSAGE_DELTAS =
  process.env.CDX_LOG_AGENT_MESSAGE_DELTAS === undefined
    ? true
    : parseBoolParam(process.env.CDX_LOG_AGENT_MESSAGE_DELTAS);
const WORKTREE_STATUS_CONCURRENCY = 8;
const GRAPH_RESPONSE_TTL_MS = 2_000;
const GRAPH_RESPONSE_CACHE_MAX = 50;
const LOG_LONG_POLL_MAX_MS = 120_000;
const OTLP_MAX_BYTES_DEFAULT = 5_000_000;
const OTLP_LOG_BODY_LIMIT_DEFAULT = 2000;

function headerValue(headers, name) {
  const value = headers?.[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

function isJsonContentType(contentType) {
  const type = String(contentType ?? '').toLowerCase();
  if (!type) return true;
  if (type.includes('application/json')) return true;
  if (type.includes('+json')) return true;
  return false;
}

async function readRequestBody(req, maxBytes) {
  const limit = Number.parseInt(maxBytes, 10) || OTLP_MAX_BYTES_DEFAULT;
  const lengthHeader = headerValue(req.headers, 'content-length');
  const contentLength = Number.parseInt(lengthHeader, 10);
  if (Number.isFinite(contentLength) && contentLength > limit) {
    const err = new Error('payload_too_large');
    err.statusCode = 413;
    throw err;
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) {
      const err = new Error('payload_too_large');
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

async function maybeDecompressBody(buffer, encoding) {
  const value = String(encoding ?? '').trim().toLowerCase();
  if (!value || value === 'identity') return buffer;
  if (value.includes('gzip')) {
    return await new Promise((resolve, reject) => {
      zlib.gunzip(buffer, (err, out) => {
        if (err) reject(err);
        else resolve(out);
      });
    });
  }
  const err = new Error(`unsupported_content_encoding:${value}`);
  err.statusCode = 415;
  throw err;
}

async function readJsonBody(req, maxBytes) {
  const contentType = headerValue(req.headers, 'content-type');
  if (!isJsonContentType(contentType)) {
    const err = new Error('unsupported_content_type');
    err.statusCode = 415;
    throw err;
  }
  const raw = await readRequestBody(req, maxBytes);
  const decoded = await maybeDecompressBody(raw, headerValue(req.headers, 'content-encoding'));
  if (!decoded || decoded.length === 0) return null;
  const text = decoded.toString('utf8').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    const error = new Error('invalid_json');
    error.statusCode = 400;
    error.cause = err;
    throw error;
  }
}

function otelAnyValueToJs(value) {
  if (!isObject(value)) return null;
  if ('stringValue' in value) return String(value.stringValue ?? '');
  if ('intValue' in value) return Number(value.intValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('boolValue' in value) return Boolean(value.boolValue);
  if ('bytesValue' in value) return String(value.bytesValue ?? '');
  if ('arrayValue' in value) {
    const values = Array.isArray(value.arrayValue?.values) ? value.arrayValue.values : [];
    return values.map(otelAnyValueToJs);
  }
  if ('kvlistValue' in value) {
    const entries = Array.isArray(value.kvlistValue?.values) ? value.kvlistValue.values : [];
    return otelAttributesToObject(entries);
  }
  return null;
}

function otelAttributesToObject(attrs) {
  const output = {};
  if (!Array.isArray(attrs)) return output;
  for (const attr of attrs) {
    if (!isObject(attr)) continue;
    const key = String(attr.key ?? '').trim();
    if (!key) continue;
    const raw = attr.value ?? attr.anyValue ?? attr;
    const value = otelAnyValueToJs(raw);
    if (value !== null) output[key] = value;
  }
  return output;
}

function extractOtlpLogRecords(payload) {
  const records = [];
  if (!isObject(payload)) return records;
  const resourceLogs = Array.isArray(payload.resourceLogs) ? payload.resourceLogs : [];
  for (const resourceLog of resourceLogs) {
    const resourceAttrs = otelAttributesToObject(resourceLog?.resource?.attributes);
    const scopeLogs = Array.isArray(resourceLog?.scopeLogs) ? resourceLog.scopeLogs : [];
    for (const scopeLog of scopeLogs) {
      const scopeAttrs = otelAttributesToObject(scopeLog?.scope?.attributes);
      const logRecords = Array.isArray(scopeLog?.logRecords) ? scopeLog.logRecords : [];
      for (const logRecord of logRecords) {
        records.push({
          resourceAttrs,
          scopeAttrs,
          recordAttrs: otelAttributesToObject(logRecord?.attributes),
          body: otelAnyValueToJs(logRecord?.body),
          traceId: logRecord?.traceId ?? null,
          spanId: logRecord?.spanId ?? null,
          severityText: logRecord?.severityText ?? null,
          severityNumber: logRecord?.severityNumber ?? null,
          timeUnixNano: logRecord?.timeUnixNano ?? logRecord?.observedTimeUnixNano ?? null,
        });
      }
    }
  }
  return records;
}

function extractOtlpSpans(payload) {
  const spans = [];
  if (!isObject(payload)) return spans;
  const resourceSpans = Array.isArray(payload.resourceSpans) ? payload.resourceSpans : [];
  for (const resourceSpan of resourceSpans) {
    const resourceAttrs = otelAttributesToObject(resourceSpan?.resource?.attributes);
    const scopeSpans = Array.isArray(resourceSpan?.scopeSpans) ? resourceSpan.scopeSpans : [];
    for (const scopeSpan of scopeSpans) {
      const scopeAttrs = otelAttributesToObject(scopeSpan?.scope?.attributes);
      const spanEntries = Array.isArray(scopeSpan?.spans) ? scopeSpan.spans : [];
      for (const span of spanEntries) {
        spans.push({
          resourceAttrs,
          scopeAttrs,
          spanAttrs: otelAttributesToObject(span?.attributes),
          name: span?.name ?? null,
          startTimeUnixNano: span?.startTimeUnixNano ?? null,
          endTimeUnixNano: span?.endTimeUnixNano ?? null,
        });
      }
    }
  }
  return spans;
}

async function mapConcurrent(items, limit, mapper) {
  const list = Array.isArray(items) ? items : [];
  const concurrency = Math.max(1, Number.parseInt(limit, 10) || 1);
  const results = new Array(list.length);
  let nextIndex = 0;

  const workers = new Array(Math.min(concurrency, list.length)).fill(0).map(async () => {
    while (true) {
      const idx = nextIndex;
      nextIndex += 1;
      if (idx >= list.length) break;
      results[idx] = await mapper(list[idx], idx);
    }
  });

  await Promise.all(workers);
  return results;
}

function parseGitStatusPorcelain(porcelain) {
  const summary = {
    tracked: 0,
    untracked: 0,
    conflicts: 0,
    total: 0,
  };
  const lines = String(porcelain ?? '').replace(/\r/g, '').split('\n');
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('!! ')) continue;
    if (line.startsWith('?? ')) {
      summary.untracked += 1;
      continue;
    }
    summary.tracked += 1;
    const xy = line.slice(0, 2);
    if (
      xy === 'UU' ||
      xy === 'AA' ||
      xy === 'DD' ||
      xy === 'AU' ||
      xy === 'UA' ||
      xy === 'DU' ||
      xy === 'UD' ||
      xy.includes('U')
    ) {
      summary.conflicts += 1;
    }
  }
  summary.total = summary.tracked + summary.untracked;
  return summary;
}

const GIT_LOG_FIELD_SEPARATOR = '\u001f';

function parseGitLogCommitRows(output) {
  const lines = String(output ?? '').replace(/\r/g, '').split('\n');
  const commits = [];

  for (const line of lines) {
    if (!line) continue;
    const parts = line.split(GIT_LOG_FIELD_SEPARATOR);
    const id = String(parts[0] ?? '').trim();
    if (!id) continue;

    const parentsRaw = String(parts[1] ?? '').trim();
    const subject = String(parts[2] ?? '').trim();
    const author = parts.length >= 6 ? String(parts[3] ?? '').trim() : null;
    const timestampSecRaw = parts.length >= 6 ? String(parts[4] ?? '').trim() : '';
    const timestampSec = Number.parseInt(timestampSecRaw, 10);
    const timestamp = Number.isFinite(timestampSec) ? timestampSec * 1000 : null;
    const decorations = parts.length >= 6 ? String(parts[5] ?? '').trim() : String(parts[3] ?? '').trim();

    const parents = parentsRaw ? parentsRaw.split(/\s+/).filter(Boolean) : [];
    commits.push({
      id,
      shortId: id.length > 7 ? id.slice(0, 7) : id,
      parents,
      subject,
      author,
      timestamp,
      decorations,
    });
  }

  return commits;
}

function filterGraphCommitsForSimple(commits, focusIds) {
  const list = Array.isArray(commits) ? commits : [];
  const focus = new Set(
    (Array.isArray(focusIds) ? focusIds : [])
      .map(id => String(id ?? '').trim())
      .filter(Boolean),
  );
  return list.filter(commit => {
    if (!commit?.id) return false;
    if (focus.has(commit.id)) return true;
    if (Array.isArray(commit.parents) && commit.parents.length > 1) return true;
    const decorations = String(commit.decorations ?? '').trim();
    return decorations.length > 0;
  });
}

function formatWorktreeStatusSummary(summary) {
  if (!summary || !Number.isFinite(summary.total) || summary.total <= 0) return 'clean';
  const parts = [];
  if (summary.tracked > 0) parts.push('+' + String(summary.tracked));
  if (summary.untracked > 0) parts.push('?' + String(summary.untracked));
  if (summary.conflicts > 0) parts.push('!' + String(summary.conflicts));
  return parts.join(' ');
}

function formatWatchdogTurnLogText(entries) {
  const raw = Array.isArray(entries) ? entries : [];
  if (raw.length === 0) return '';

  const lines = [];
  let streamTail = '';
  let streamTimestamp = '';

  const pushLine = (text, timestamp = '') => {
    const prefix = timestamp ? ('[' + timestamp + '] ') : '';
    lines.push(prefix + text);
  };

  const flushStreamTail = () => {
    if (!streamTail) return;
    pushLine(streamTail, streamTimestamp);
    streamTail = '';
    streamTimestamp = '';
  };

  const appendStreamText = (text, timestamp) => {
    if (!streamTimestamp) {
      streamTimestamp = timestamp;
    }
    let combined = streamTail ? (streamTail + text) : text;
    if (streamTail && text.startsWith(streamTail)) {
      combined = text;
    }
    const parts = combined.split('\n');
    streamTail = parts.pop() ?? '';
    for (const part of parts) {
      pushLine(part, streamTimestamp || timestamp);
      streamTimestamp = timestamp || streamTimestamp;
    }
    if (!streamTail) {
      streamTimestamp = '';
    }
  };

  for (const entry of raw) {
    const text = String(entry?.text ?? '').replace(/\r/g, '');
    const timestamp = typeof entry?.ts === 'string' ? entry.ts : '';
    const isStream = entry?.stream === true;
    if (isStream) {
      if (!text) continue;
      appendStreamText(text, timestamp);
      continue;
    }

    flushStreamTail();
    const parts = text.split('\n');
    for (const part of parts) {
      pushLine(part, timestamp);
    }
  }

  flushStreamTail();
  return lines.join('\n');
}

function buildTaskOutputTail(entries, { maxLines = 15, maxCharsPerLine = 240 } = {}) {
  const raw = Array.isArray(entries) ? entries : [];
  if (raw.length === 0) {
    return {
      text: '',
      lineCount: 0,
      totalLines: 0,
      truncated: false,
      hasStream: false,
    };
  }

  const streamEntries = raw.filter(entry => entry?.stream === true);
  const sourceEntries = streamEntries.length > 0 ? streamEntries : raw;
  const lines = [];
  let streamTail = '';

  const pushLine = text => {
    const normalized = stripAnsi(String(text ?? '').replace(/\r/g, ''));
    if (!normalized.trim()) return;
    if (normalized.length > maxCharsPerLine) {
      lines.push(`${normalized.slice(0, maxCharsPerLine)} …`);
      return;
    }
    lines.push(normalized);
  };

  const flushStreamTail = () => {
    if (!streamTail) return;
    pushLine(streamTail);
    streamTail = '';
  };

  const appendStreamText = text => {
    let combined = streamTail ? (streamTail + text) : text;
    if (streamTail && text.startsWith(streamTail)) {
      combined = text;
    }
    const parts = combined.split('\n');
    streamTail = parts.pop() ?? '';
    for (const part of parts) {
      pushLine(part);
    }
    if (!streamTail) return;
    streamTail = stripAnsi(streamTail);
  };

  for (const entry of sourceEntries) {
    const text = String(entry?.text ?? '').replace(/\r/g, '');
    if (!text) continue;
    if (entry?.stream === true) {
      appendStreamText(text);
      continue;
    }

    flushStreamTail();
    for (const part of text.split('\n')) {
      pushLine(part);
    }
  }

  flushStreamTail();

  const visibleLines = maxLines > 0 ? lines.slice(-maxLines) : lines.slice();
  return {
    text: visibleLines.join('\n'),
    lineCount: visibleLines.length,
    totalLines: lines.length,
    truncated: visibleLines.length < lines.length,
    hasStream: streamEntries.length > 0,
  };
}

function isWatchdogTurnBoundaryText(text) {
  const normalized = String(text ?? '').replace(/\r/g, '').trim().toLowerCase();
  if (!normalized) return false;
  return /^(periodic intervention|intervention:|no-progress recovery|respawn requested|retrying |merge takeover queued|merge recovery actions|merge recovery failed|manual merge |idle warn |aborting |auto-answered supervisor ask|failed to run|report \(wave |failed \(wave )/.test(normalized);
}

function normalizeIsoTimestamp(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

function summarizeWatchdogText(text, { maxLines = 3, maxCharsPerLine = 220 } = {}) {
  const lines = String(text ?? '')
    .replace(/\r/g, '')
    .split('\n')
    .map(line => stripAnsi(line).trim().replace(/^\[[^\]]+\]\s*/, ''))
    .filter(Boolean);
  if (lines.length === 0) return '';
  return lines
    .slice(0, maxLines)
    .map(line => (line.length > maxCharsPerLine ? `${line.slice(0, maxCharsPerLine - 1)}…` : line))
    .join('\n');
}

function inferWatchdogTurnKind(text) {
  const firstLine = String(text ?? '')
    .replace(/\r/g, '')
    .split('\n')
    .map(line => stripAnsi(line).trim())
    .find(Boolean) ?? '';
  const normalized = firstLine.replace(/^\[[^\]]+\]\s*/, '').toLowerCase();
  if (!normalized) return 'unknown';
  if (normalized.startsWith('report (wave ')) return 'report';
  if (normalized.startsWith('failed (wave ') || normalized.startsWith('failed to run')) return 'failure';
  if (normalized.startsWith('periodic intervention')) return 'periodic-intervention';
  if (normalized.startsWith('intervention:')) return 'intervention';
  if (normalized.startsWith('no-progress recovery')) return 'no-progress-recovery';
  if (normalized.startsWith('respawn requested')) return 'respawn-requested';
  if (normalized.startsWith('respawned ')) return 'respawned';
  if (normalized.startsWith('retrying ')) return 'retry';
  if (
    normalized.startsWith('merge takeover queued')
    || normalized.startsWith('merge recovery actions')
    || normalized.startsWith('merge recovery failed')
    || normalized.startsWith('manual merge ')
  ) {
    return 'merge-recovery';
  }
  if (normalized.startsWith('idle warn ')) return 'idle-warning';
  if (normalized.startsWith('aborting ')) return 'abort';
  if (normalized.startsWith('auto-answered supervisor ask')) return 'auto-answer';
  return 'log';
}

function buildWatchdogTurnRecord({
  index,
  turnId = null,
  eventId = 0,
  startedLogId = 0,
  endedLogId = 0,
  text = '',
  live = false,
  source = null,
  startedAt = null,
  completedAt = null,
  lastLogAt = null,
  summary = null,
  kind = null,
} = {}) {
  const normalizedText = String(text ?? '').replace(/\r/g, '');
  const normalizedStartedAt = normalizeIsoTimestamp(startedAt);
  const normalizedCompletedAt = normalizeIsoTimestamp(completedAt);
  const normalizedLastLogAt = normalizeIsoTimestamp(lastLogAt);
  const timestamp = normalizedLastLogAt || normalizedCompletedAt || normalizedStartedAt;
  const summaryText = summarizeWatchdogText(summary || normalizedText);
  return {
    index: Number.parseInt(index, 10) || 0,
    turnId: typeof turnId === 'string' && turnId.trim() ? turnId.trim() : null,
    eventId: Number.parseInt(eventId, 10) || 0,
    startedLogId: Number.parseInt(startedLogId, 10) || 0,
    endedLogId: Number.parseInt(endedLogId, 10) || 0,
    text: normalizedText,
    summary: summaryText,
    kind: kind ? String(kind) : inferWatchdogTurnKind(summaryText || normalizedText),
    source: source ? String(source) : (live ? 'log.live' : 'log'),
    startedAt: normalizedStartedAt,
    completedAt: normalizedCompletedAt,
    lastLogAt: normalizedLastLogAt,
    timestamp,
    live: live === true,
  };
}

function buildWatchdogTurnsSnapshot(completedTurns, logs, { live = false } = {}) {
  const safeTurns = Array.isArray(completedTurns)
    ? completedTurns
      .map(item => ({
        index: Number.parseInt(item?.index, 10) || 0,
        turnId: typeof item?.turnId === 'string' && item.turnId.trim() ? item.turnId.trim() : null,
        eventId: Number.parseInt(item?.eventId, 10) || 0,
        startedLogId: Number.parseInt(item?.startedLogId, 10) || 0,
        endedLogId: Number.parseInt(item?.endedLogId, 10) || 0,
        text: String(item?.text ?? '').replace(/\r/g, ''),
        summary: typeof item?.summary === 'string' ? item.summary : '',
        kind: typeof item?.kind === 'string' ? item.kind : '',
        source: typeof item?.source === 'string' ? item.source : '',
        startedAt: normalizeIsoTimestamp(item?.startedAt),
        completedAt: normalizeIsoTimestamp(item?.completedAt),
        lastLogAt: normalizeIsoTimestamp(item?.lastLogAt ?? item?.timestamp),
        live: item?.live === true,
      }))
      .filter(item => item.index > 0)
      .sort((a, b) => a.index - b.index)
    : [];

  const logItems = Array.isArray(logs)
    ? logs
      .map(item => ({
        id: Number(item?.id) || 0,
        ts: typeof item?.ts === 'string' ? item.ts : '',
        text: String(item?.text ?? '').replace(/\r/g, ''),
        stream: item?.stream === true,
      }))
      .filter(item => item.id > 0)
      .sort((a, b) => a.id - b.id)
    : [];

  const turns = [];
  let previousEndedLogId = 0;
  for (const turn of safeTurns) {
    const turnEntries = logItems.filter(log => log.id > previousEndedLogId && log.id <= turn.endedLogId);
    const turnText = turnEntries.length > 0
      ? formatWatchdogTurnLogText(turnEntries)
      : turn.text;
    turns.push(buildWatchdogTurnRecord({
      index: turn.index,
      turnId: turn.turnId,
      eventId: turn.eventId,
      startedLogId: turnEntries.length > 0
        ? (Number(turnEntries[0]?.id) || turn.startedLogId || 0)
        : turn.startedLogId,
      endedLogId: turn.endedLogId,
      text: turnText,
      live: turn.live === true,
      source: turn.source || 'turn.completed',
      startedAt: turnEntries[0]?.ts ?? turn.startedAt,
      completedAt: turn.completedAt,
      lastLogAt: turnEntries[turnEntries.length - 1]?.ts ?? turn.lastLogAt ?? turn.completedAt,
      summary: turn.summary,
      kind: turn.kind,
    }));
    previousEndedLogId = Math.max(previousEndedLogId, turn.endedLogId);
  }

  const tailEntries = logItems.filter(log => log.id > previousEndedLogId);
  if (tailEntries.length === 0) return turns;

  let remainingTailEntries = tailEntries;
  const firstBoundaryIndex = tailEntries.findIndex(entry => isWatchdogTurnBoundaryText(entry.text));
  if (turns.length > 0 && firstBoundaryIndex > 0) {
    const leadingEntries = tailEntries.slice(0, firstBoundaryIndex);
    const leadingText = formatWatchdogTurnLogText(leadingEntries);
    const lastTurn = turns[turns.length - 1];
    lastTurn.text = lastTurn.text && leadingText ? `${lastTurn.text}\n${leadingText}` : (lastTurn.text || leadingText);
    lastTurn.summary = summarizeWatchdogText(lastTurn.text);
    lastTurn.endedLogId = Number(leadingEntries[leadingEntries.length - 1]?.id) || lastTurn.endedLogId;
    lastTurn.lastLogAt = normalizeIsoTimestamp(leadingEntries[leadingEntries.length - 1]?.ts) ?? lastTurn.lastLogAt;
    lastTurn.timestamp = lastTurn.lastLogAt || lastTurn.completedAt || lastTurn.startedAt;
    remainingTailEntries = tailEntries.slice(firstBoundaryIndex);
  }
  if (remainingTailEntries.length === 0) return turns;

  const groups = [];
  let current = [];
  for (const entry of remainingTailEntries) {
    if (current.length > 0 && isWatchdogTurnBoundaryText(entry.text)) {
      groups.push(current);
      current = [];
    }
    current.push(entry);
  }
  if (current.length > 0) groups.push(current);

  let nextIndex = turns.length > 0
    ? Math.max(...turns.map(turn => Number(turn?.index) || 0)) + 1
    : 1;

  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i];
    turns.push(buildWatchdogTurnRecord({
      index: nextIndex,
      turnId: null,
      eventId: Number(group[group.length - 1]?.id) || previousEndedLogId,
      startedLogId: Number(group[0]?.id) || 0,
      endedLogId: Number(group[group.length - 1]?.id) || previousEndedLogId,
      text: formatWatchdogTurnLogText(group),
      live: live === true && i === groups.length - 1,
      source: live === true && i === groups.length - 1 ? 'log.live' : 'log',
      startedAt: group[0]?.ts ?? null,
      completedAt: group[group.length - 1]?.ts ?? null,
      lastLogAt: group[group.length - 1]?.ts ?? null,
    }));
    nextIndex += 1;
  }

  return turns;
}

function buildWatchdogLatestSnapshot(turns, outputTail, { live = false, agent = null } = {}) {
  const latestTurn = Array.isArray(turns) && turns.length > 0
    ? turns[turns.length - 1]
    : null;
  if (latestTurn) {
    const timestamp =
      latestTurn.timestamp
      || latestTurn.lastLogAt
      || latestTurn.completedAt
      || latestTurn.startedAt
      || null;
    return {
      text: latestTurn.summary || summarizeWatchdogText(latestTurn.text),
      fullText: latestTurn.text,
      kind: latestTurn.kind || inferWatchdogTurnKind(latestTurn.text),
      source: latestTurn.source || (latestTurn.live ? 'log.live' : 'turn'),
      at: timestamp,
      timestamp,
      turnIndex: Number(latestTurn.index) || null,
      live: latestTurn.live === true,
      status: typeof agent?.status === 'string' ? agent.status : null,
    };
  }

  const fullText = String(outputTail?.text ?? '').replace(/\r/g, '');
  const text = summarizeWatchdogText(fullText);
  if (!text) return null;

  const timestamp = normalizeIsoTimestamp(agent?.lastActivityAt);
  return {
    text,
    fullText,
    kind: inferWatchdogTurnKind(text),
    source: live ? 'stdout.live' : 'stdout',
    at: timestamp,
    timestamp,
    turnIndex: null,
    live: live === true,
    status: typeof agent?.status === 'string' ? agent.status : null,
  };
}

class RingBuffer {
  constructor(limit) {
    this.limit = Math.max(1, Number.parseInt(limit, 10) || 1);
    this.items = [];
  }

  push(entry) {
    this.items.push(entry);
    if (this.items.length > this.limit) {
      this.items.splice(0, this.items.length - this.limit);
    }
  }

  since(id, limit = 500) {
    const min = Number.parseInt(id, 10) || 0;
    const filtered = this.items.filter(item => (item.id ?? 0) > min);
    return filtered.slice(-Math.max(1, Number.parseInt(limit, 10) || 500));
  }
}

function commandExists(candidate) {
  if (!candidate) return false;
  const hasDirSeparator = candidate.includes('/') || candidate.includes('\\');
  if (hasDirSeparator) {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter);
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
      : [''];
  for (const entry of pathEntries) {
    if (!entry) continue;
    for (const ext of extensions) {
      const resolved = path.join(entry, ext ? `${candidate}${ext}` : candidate);
      try {
        accessSync(resolved, constants.X_OK);
        return true;
      } catch {}
    }
  }
  return false;
}

function fileExists(candidate) {
  if (!candidate) return false;
  try {
    accessSync(candidate, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function pushOpenCommand(commands, seen, command, args) {
  const normalizedCommand = String(command ?? '').trim();
  if (!normalizedCommand) return;
  const key = `${normalizedCommand.toLowerCase()}\0${JSON.stringify(args ?? [])}`;
  if (seen.has(key)) return;
  seen.add(key);
  commands.push({ command: normalizedCommand, args: args ?? [] });
}

function appendExecutableCandidate(commands, seen, candidate, target, { fileExistsFn, commandExistsFn }) {
  const executable = String(candidate ?? '').trim();
  if (!executable) return;

  const hasDirSeparator = executable.includes('/') || executable.includes('\\');
  if (hasDirSeparator) {
    if (fileExistsFn(executable)) pushOpenCommand(commands, seen, executable, [target]);
    return;
  }

  if (commandExistsFn(executable)) pushOpenCommand(commands, seen, executable, [target]);
}

function windowsBrowserPathCandidates(env = process.env) {
  const localAppData = env.LOCALAPPDATA;
  const programFiles = env.ProgramFiles;
  const programFilesX86 = env['ProgramFiles(x86)'];
  return [
    localAppData && path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    programFiles && path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    programFilesX86 && path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    localAppData && path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    programFiles && path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    programFilesX86 && path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean);
}

export function buildOpenUrlCommands(
  url,
  {
    platform = process.platform,
    env = process.env,
    fileExistsFn = fileExists,
    commandExistsFn = commandExists,
  } = {},
) {
  const target = String(url ?? '').trim();
  if (!target) return [];

  const commands = [];
  const seen = new Set();

  const browserOverride = String(env.CDX_BROWSER ?? '').trim();
  if (browserOverride) {
    appendExecutableCandidate(commands, seen, browserOverride, target, { fileExistsFn, commandExistsFn });
  }

  if (platform === 'darwin') {
    pushOpenCommand(commands, seen, 'open', ['-a', 'Google Chrome', target]);
    pushOpenCommand(commands, seen, 'open', [target]);
    return commands;
  }

  if (platform === 'win32') {
    for (const candidate of windowsBrowserPathCandidates(env)) {
      appendExecutableCandidate(commands, seen, candidate, target, { fileExistsFn, commandExistsFn });
    }

    for (const candidate of ['chrome.exe', 'chrome', 'msedge.exe', 'msedge']) {
      appendExecutableCandidate(commands, seen, candidate, target, { fileExistsFn, commandExistsFn });
    }

    pushOpenCommand(commands, seen, 'explorer.exe', [target]);
    pushOpenCommand(commands, seen, 'rundll32.exe', ['url.dll,FileProtocolHandler', target]);
    pushOpenCommand(commands, seen, 'cmd', ['/d', '/s', '/c', 'start', '', target]);
    return commands;
  }

  const linuxCandidates = [
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
  ];
  for (const candidate of linuxCandidates) {
    appendExecutableCandidate(commands, seen, candidate, target, { fileExistsFn, commandExistsFn });
  }

  appendExecutableCandidate(commands, seen, 'xdg-open', target, { fileExistsFn, commandExistsFn });
  return commands;
}

function runDetached(command, args, { timeoutMs = 1500 } = {}) {
  return new Promise(resolve => {
    let settled = false;
    const finish = ok => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    let timer = null;
    try {
      const baseCommand = path.basename(String(command ?? '')).toLowerCase();
      const windowsHide = baseCommand === 'cmd' || baseCommand === 'cmd.exe';
      const child = spawn(command, args, {
        stdio: 'ignore',
        detached: true,
        windowsHide,
      });
      child.unref();

      child.once('error', () => finish(false));
      child.once('close', code => finish(code === 0));

      timer = setTimeout(() => finish(true), timeoutMs);
      timer.unref?.();
    } catch {
      if (timer) clearTimeout(timer);
      finish(false);
    }
  });
}

async function openUrlPreferChrome(url) {
  const target = String(url ?? '').trim();
  if (!target) return false;

  for (const { command, args } of buildOpenUrlCommands(target)) {
    const ok = await runDetached(command, args);
    if (ok) return true;
  }
  return false;
}

export const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CDX Stats</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0b0f17;
        --panel: #111827;
        --panel2: #0f172a;
        --graph-surface: rgba(2,6,23,0.35);
        --muted: #94a3b8;
        --text: #e5e7eb;
        --border: rgba(148, 163, 184, 0.18);
        --accent: #38bdf8;
        --changed: #f97316;
        --danger: #fb7185;
        --ok: #34d399;
        --warn: #fbbf24;
        --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        /* VSCode-ish tokens (scoped usage in graph) */
        --vscode-foreground: #cccccc;
        --vscode-disabledForeground: rgba(204,204,204,0.5);
        --vscode-sideBar-background: #181818;
        --vscode-sideBar-foreground: #cccccc;
        --vscode-list-hoverBackground: #2a2d2e;
        --vscode-list-activeSelectionBackground: #094771;
        --vscode-list-activeSelectionForeground: #ffffff;
        --vscode-list-inactiveSelectionBackground: #37373d;
        --vscode-list-inactiveSelectionForeground: #ffffff;
        --vscode-badge-background: #4d4d4d;
        --vscode-badge-foreground: #ffffff;
        --vscode-contrastBorder: rgba(255,255,255,0.14);
	      }
	      * { box-sizing: border-box; }

	      /* Minimal icons (no external assets) */
	      .icon {
	        display: inline-flex;
	        align-items: center;
	        justify-content: center;
	        width: 16px;
	        height: 16px;
	        line-height: 1;
	        font-size: 12px;
	        user-select: none;
	        -webkit-user-select: none;
	      }
	      .icon.spin {
	        animation: icon-spin 1.2s linear infinite;
	      }
	      @keyframes icon-spin {
	        100% { transform: rotate(360deg); }
	      }
	      body {
	        margin: 0;
	        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji";
        background: radial-gradient(1200px 700px at 10% 0%, rgba(56,189,248,0.08), transparent 70%),
                    radial-gradient(900px 600px at 90% 20%, rgba(52,211,153,0.07), transparent 70%),
                    var(--bg);
        color: var(--text);
        display: flex;
        flex-direction: column;
        height: 100vh;
      }
      header {
        display: none;
        padding: 14px 16px;
        border-bottom: 1px solid var(--border);
        background: rgba(17,24,39,0.65);
        backdrop-filter: blur(10px);
        position: sticky;
        top: 0;
        z-index: 10;
      }
      .title {
        display: flex;
        align-items: baseline;
        gap: 12px;
        flex-wrap: wrap;
      }
      .title h1 {
        font-size: 16px;
        margin: 0;
        letter-spacing: 0.2px;
      }
      .pill {
        font-family: var(--mono);
        font-size: 12px;
        color: var(--muted);
        border: 1px solid var(--border);
        border-radius: 999px;
        padding: 4px 10px;
        background: rgba(15,23,42,0.6);
      }
      .session-bar {
        border-top: 1px solid var(--border);
        align-items: flex-start;
      }
      .session-bar .tab {
        flex: 0 0 auto;
      }
      .session-meta {
        flex: 1 1 360px;
        min-width: 220px;
        max-width: 100%;
        font-family: var(--mono);
        font-size: 11px;
        line-height: 1.4;
        color: var(--muted);
        white-space: pre;
        overflow-wrap: normal;
        word-break: normal;
        overflow-x: auto;
      }
      .overlay {
        position: fixed;
        inset: 0;
        background: rgba(2,6,23,0.65);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 40;
        padding: 18px;
      }
      .overlay.hidden {
        display: none;
      }
      .overlay-card {
        width: min(1100px, 100%);
        max-height: 85vh;
        display: flex;
        flex-direction: column;
        background: rgba(15,23,42,0.95);
        border: 1px solid var(--border);
        border-radius: 14px;
        overflow: hidden;
      }
      .overlay-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 14px;
        border-bottom: 1px solid var(--border);
        background: rgba(17,24,39,0.9);
      }
      .overlay-title {
        font-size: 13px;
        font-weight: 600;
      }
      .overlay-actions {
        display: flex;
        gap: 8px;
      }
      .overlay-body {
        padding: 12px 14px 16px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        min-height: 0;
      }
      .jobs-meta {
        font-family: var(--mono);
        font-size: 12px;
        color: var(--muted);
      }
      .jobs-list {
        display: grid;
        gap: 10px;
        overflow: auto;
        padding-right: 4px;
      }
      .job-row {
        border: 1px solid var(--border);
        background: rgba(2,6,23,0.35);
        border-radius: 12px;
        padding: 12px;
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 10px;
        text-align: left;
        color: var(--text);
        cursor: pointer;
      }
      .job-row:hover {
        border-color: rgba(56,189,248,0.45);
      }
      .job-row.active {
        border-color: rgba(56,189,248,0.65);
        background: rgba(56,189,248,0.12);
      }
      .job-main {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
      }
      .job-title {
        font-family: var(--mono);
        font-size: 12px;
        color: var(--text);
        margin-bottom: 6px;
      }
      .job-sub {
        font-family: var(--mono);
        font-size: 11px;
        color: var(--muted);
        line-height: 1.4;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .job-action {
        align-self: center;
        font-size: 11px;
        color: var(--muted);
        border: 1px solid var(--border);
        border-radius: 999px;
        padding: 4px 8px;
        background: rgba(2,6,23,0.35);
      }
      .layout {
        display: grid;
        grid-template-columns: minmax(320px, 1fr) minmax(0, 2fr);
        gap: 14px;
        padding: 14px;
        flex: 1 1 auto;
        min-height: 0;
        overflow: hidden;
      }
      .dashboard-sidebar {
        display: grid;
        grid-template-rows: auto minmax(0, 1fr);
        gap: 14px;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
      }
      .dashboard-status-panel,
      .dashboard-watchdog-panel,
      .dashboard-main {
        min-width: 0;
        min-height: 0;
      }
      .dashboard-watchdog-panel,
      .dashboard-main {
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .dashboard-watchdog-panel > *,
      .dashboard-main > * {
        flex: 1 1 auto;
        min-width: 0;
        min-height: 0;
      }
      .dashboard-watchdog-panel #cardView,
      .dashboard-watchdog-panel #cardHero {
        flex: 1 1 auto;
        min-height: 0;
      }
      #testGitTree {
        background: rgba(2, 6, 23, 0.35);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 10px;
        white-space: pre;
        overflow: auto;
        min-height: 0;
      }
      #testTaskDagWrap {
        background: rgba(2, 6, 23, 0.35);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 8px;
        min-height: 0;
        height: 100%;
        flex: 1 1 auto;
        display: flex;
        align-items: flex-start;
        justify-content: flex-start;
        overflow: auto;
        overscroll-behavior: contain;
      }
      #taskDagCard {
        min-height: 0;
        height: 100%;
      }
      #taskDagCard .card-head {
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
      }
      #taskDagMeta {
        font-size: 11px;
        white-space: normal;
        text-align: left;
        flex: 1 1 280px;
      }
      #testTaskDagWrap {
        display: block;
        overflow: auto;
      }
      .task-dag-table {
        width: max-content;
        min-width: 100%;
        border-collapse: collapse;
        font-family: var(--mono);
        font-size: 12px;
      }
      .task-dag-table thead th {
        position: sticky;
        top: 0;
        z-index: 1;
        text-align: left;
        padding: 10px 12px;
        background: rgba(2, 6, 23, 0.92);
        color: #cbd5e1;
        border-bottom: 1px solid var(--border);
      }
      .task-dag-table tbody tr {
        border-bottom: 1px solid rgba(148, 163, 184, 0.14);
      }
      .task-dag-table tbody tr:hover {
        background: rgba(15, 23, 42, 0.4);
      }
      .task-dag-table td {
        vertical-align: top;
        padding: 10px 12px;
        color: var(--text);
        box-sizing: border-box;
      }
      .task-dag-table .muted-cell {
        color: var(--muted);
      }
      .task-dag-table .task-main,
      .task-dag-table .summary-main {
        font-weight: 600;
        color: #e2e8f0;
        overflow-wrap: anywhere;
      }
      .task-dag-table .task-sub,
      .task-dag-table .summary-sub {
        margin-top: 4px;
        color: var(--muted);
        font-size: 11px;
        line-height: 1.45;
        white-space: normal;
        overflow-wrap: anywhere;
      }
      .task-dag-table.task-summary-table {
        width: 100%;
        min-width: 760px;
        table-layout: fixed;
      }
      .task-dag-table.task-summary-table .task-col {
        width: 66%;
      }
      .task-dag-table.task-summary-table .status-col {
        width: 34%;
      }
      .task-dag-table.task-summary-table .summary-primary-row td {
        padding-bottom: 10px;
      }
      .task-dag-table.task-summary-table .summary-output-row td {
        padding-top: 0;
        padding-bottom: 14px;
      }
      .task-dag-table.task-summary-table .summary-status-stack {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 6px;
      }
      .task-dag-table.task-summary-table .summary-status-row,
      .task-dag-table.task-summary-table .summary-status-pills {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .task-dag-table.task-summary-table .summary-status-updated {
        color: var(--muted);
        font-size: 11px;
        line-height: 1.4;
        white-space: normal;
        overflow-wrap: anywhere;
      }
      .task-dag-table.task-summary-table .summary-dependency {
        color: #cbd5e1;
        cursor: help;
      }
      .task-dag-table.task-summary-table .summary-output-box {
        display: block;
        margin: 0;
        padding: 0;
        color: var(--text);
        font-family: var(--mono);
        font-size: 11px;
        line-height: 1.45;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        word-break: break-word;
        width: 100%;
        max-width: 100%;
        box-sizing: border-box;
        min-height: 0;
        max-height: calc(1.45em * 10);
        overflow-x: hidden;
        overflow-y: auto;
      }
      .task-dag-table.task-summary-table .summary-output-box.placeholder {
        color: var(--muted);
      }
      .task-phase-output {
        display: block;
        margin: 0;
        padding: 10px 12px;
        border-radius: 10px;
        border: 1px solid rgba(148, 163, 184, 0.18);
        background: rgba(15, 23, 42, 0.32);
        color: var(--text);
        font-family: var(--mono);
        font-size: 11px;
        line-height: 1.45;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        word-break: break-word;
        width: 100%;
        min-height: 100%;
        box-sizing: border-box;
        overflow: auto;
      }
      .task-phase-output.placeholder {
        color: var(--muted);
      }
      .task-dag-table.task-matrix-table {
        width: max-content;
        min-width: 100%;
        table-layout: fixed;
      }
      .task-dag-table.task-matrix-table thead th:first-child,
      .task-dag-table.task-matrix-table tbody td:first-child {
        position: sticky;
        left: 0;
        z-index: 2;
      }
      .task-dag-table.task-matrix-table thead th:first-child {
        z-index: 3;
      }
      .task-dag-table.task-matrix-table tbody td:first-child {
        background: rgba(2, 6, 23, 0.96);
      }
      .task-dag-table.task-matrix-table .matrix-head {
        width: 216px;
        min-width: 216px;
        max-width: 216px;
        white-space: normal;
      }
      .task-dag-table.task-matrix-table .matrix-target {
        width: 336px;
        min-width: 336px;
        max-width: 336px;
      }
      .task-dag-table.task-matrix-table .matrix-target-title {
        font-weight: 700;
        color: #e2e8f0;
        overflow-wrap: anywhere;
      }
      .task-dag-table.task-matrix-table .matrix-target-meta {
        margin-top: 6px;
        color: var(--muted);
        font-size: 11px;
        line-height: 1.4;
      }
      .task-dag-table.task-matrix-table .matrix-target-summary,
      .task-dag-table.task-matrix-table .matrix-target-steps {
        margin-top: 8px;
        color: var(--muted);
        font-size: 11px;
        line-height: 1.45;
        white-space: normal;
        overflow-wrap: anywhere;
      }
      .task-dag-table.task-matrix-table .matrix-target-summary {
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 4;
        overflow: hidden;
      }
      .task-dag-table.task-matrix-table .matrix-target-steps {
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        overflow: hidden;
      }
      .task-dag-table.task-matrix-table .matrix-cell-wrap {
        width: 216px;
        min-width: 216px;
        max-width: 216px;
      }
      .task-dag-table.task-matrix-table .matrix-cell-wrap[data-task] {
        cursor: pointer;
      }
      .task-dag-table.task-matrix-table .matrix-cell-shell {
        display: flex;
        flex-direction: column;
        gap: 8px;
        min-height: 68px;
        padding: 8px 10px;
        border-radius: 10px;
        border: 1px solid rgba(148, 163, 184, 0.18);
        background: rgba(15, 23, 42, 0.32);
      }
      .task-dag-table.task-matrix-table .matrix-cell-shell.running {
        border-color: rgba(56, 189, 248, 0.45);
      }
      .task-dag-table.task-matrix-table .matrix-cell-shell.completed {
        border-color: rgba(52, 211, 153, 0.35);
      }
      .task-dag-table.task-matrix-table .matrix-cell-shell.failed,
      .task-dag-table.task-matrix-table .matrix-cell-shell.blocked {
        border-color: rgba(251, 113, 133, 0.4);
      }
      .task-dag-table.task-matrix-table .matrix-status-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .task-dag-table.task-matrix-table .matrix-status-row .badge {
        max-width: 100%;
      }
      .task-dag-table.task-matrix-table .matrix-age {
        color: var(--muted);
        font-size: 11px;
      }
      .task-dag-table.task-matrix-table .matrix-placeholder {
        color: var(--muted);
        font-size: 11px;
      }
      .task-dag-table.task-matrix-table .matrix-sub {
        color: var(--muted);
        font-size: 11px;
        line-height: 1.4;
        white-space: normal;
        overflow-wrap: anywhere;
      }
      .task-dag-table.task-matrix-table .matrix-agent {
        color: var(--muted);
        font-size: 11px;
        line-height: 1.35;
        white-space: normal;
        overflow-wrap: anywhere;
      }
      .task-dag-table.task-matrix-table .matrix-running {
        color: var(--muted);
      }
      .task-dag-table.task-checklist-table {
        width: 100%;
        min-width: 100%;
        table-layout: fixed;
      }
      .task-dag-table.task-checklist-table th,
      .task-dag-table.task-checklist-table td {
        vertical-align: top;
      }
      .task-dag-table.task-checklist-table .checklist-target-col {
        width: 24%;
      }
      .task-dag-table.task-checklist-table .checklist-status-col {
        width: 12%;
      }
      .task-dag-table.task-checklist-table .checklist-updated-col {
        width: 14%;
      }
      .task-dag-table.task-checklist-table tbody tr[data-task] {
        cursor: pointer;
      }
      .task-dag-table.task-checklist-table .checklist-target-cell {
        background: rgba(2, 6, 23, 0.96);
      }
      .task-dag-table.task-checklist-table .checklist-target-shell {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .task-dag-table.task-checklist-table .checklist-target-title {
        font-weight: 700;
        color: #e2e8f0;
        overflow-wrap: anywhere;
      }
      .task-dag-table.task-checklist-table .checklist-target-job,
      .task-dag-table.task-checklist-table .checklist-progress-text,
      .task-dag-table.task-checklist-table .checklist-updated-text {
        color: var(--muted);
        font-size: 11px;
        line-height: 1.45;
        white-space: normal;
        overflow-wrap: anywhere;
      }
      .task-dag-table.task-checklist-table .checklist-status-cell .badge {
        max-width: 100%;
      }
      .task-dag-table.task-checklist-table .checklist-status-shell {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .task-dag-table.task-checklist-table .checklist-progress-text.alert {
        color: #fda4af;
      }
      #watchdogTurnBrowser {
        display: flex;
        flex-direction: column;
        gap: 8px;
        flex: 1 1 auto;
        min-height: 0;
        order: -1;
      }
      #watchdogTurnBrowser[hidden] {
        display: none;
      }
      #watchdogTurnTabs {
        display: flex;
        flex-wrap: nowrap;
        align-items: center;
        gap: 6px;
        overflow-x: auto;
        overflow-y: hidden;
        white-space: nowrap;
        scrollbar-width: thin;
      }
      .watchdog-turn-tab {
        flex: 0 0 auto;
        border: 1px solid var(--border);
        border-radius: 999px;
        padding: 3px 9px;
        font-family: var(--mono);
        font-size: 11px;
        color: var(--muted);
        background: rgba(2,6,23,0.45);
        cursor: pointer;
      }
      .watchdog-turn-tab.active {
        border-color: rgba(56,189,248,0.7);
        color: #e2e8f0;
        background: rgba(56,189,248,0.16);
      }
      .watchdog-turn-gap {
        flex: 0 0 auto;
        color: var(--muted);
        font-family: var(--mono);
        font-size: 11px;
        padding: 0 2px;
        user-select: none;
        -webkit-user-select: none;
      }
      #watchdogTurnPanel {
        flex: 1 1 auto;
        min-height: 280px;
        max-height: none;
        overflow: auto;
        margin: 0;
        padding: 12px;
        border: 1px solid var(--border);
        border-radius: 10px;
        background: rgba(2, 6, 23, 0.38);
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .column {
        display: flex;
        flex-direction: column;
        gap: 14px;
        overflow: auto;
        min-height: 0;
        min-width: 0;
      }
      .column-left-primary {
        display: grid;
        grid-template-rows: auto minmax(220px, 0.72fr) minmax(320px, 1.28fr);
        gap: 14px;
        overflow: hidden;
      }
      .column-left-primary > * {
        min-height: 0;
        min-width: 0;
      }
      #cardView {
        gap: 0;
        min-height: 0;
      }
      #cardView > .card {
        flex: 1 1 auto;
      }
      .layout-middle-row {
        min-height: 0;
        overflow: hidden;
      }
      .layout-middle-row > * {
        min-width: 0;
        min-height: 0;
      }
      .layout-status,
      .layout-dag {
        min-height: 0;
        min-width: 0;
      }
      .layout-dag {
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .layout-dag > * {
        flex: 1 1 auto;
        min-height: 0;
        min-width: 0;
      }
      .column-middle {
        overflow: hidden;
        display: flex;
        flex-direction: column;
        min-height: 0;
      }
      .column-middle > * {
        min-width: 0;
        min-height: 0;
        flex: 1 1 auto;
      }
      .column-task-sidebar {
        overflow: hidden;
      }
      .column-right {
        display: none;
        overflow: hidden;
        min-height: 0;
      }
      .column-right > * { min-height: 0; }
      .card-view-stack {
        flex: 1 1 auto;
        overflow: hidden;
      }
      .right-mid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 14px;
        min-height: 0;
        overflow: hidden;
      }
      .right-mid > * { min-width: 0; min-height: 0; }
      .card-flex {
        display: flex;
        flex-direction: column;
        min-height: 0;
        overflow: hidden;
      }
      .body-scroll {
        flex: 1 1 auto;
        min-height: 0;
        overflow: auto;
        overflow-x: hidden;
      }
      .panel {
        flex: 1 1 auto;
        min-height: 0;
        display: flex;
        flex-direction: column;
      }
      .worktree-split {
        flex: 1 1 auto;
        min-height: 0;
      }
      .worktree-pane {
        display: flex;
        flex-direction: column;
        gap: 10px;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
      }
      .worktree-pane .tree,
      .worktree-pane .logbox {
        flex: 1 1 auto;
        min-height: 0;
      }
      #file { flex: 2 1 auto; }
      #gitStatus { flex: 1 1 auto; }
      .card {
        border: 1px solid var(--border);
        border-radius: 12px;
        background: rgba(17, 24, 39, 0.72);
        overflow: hidden;
      }
      .card h2 {
        font-size: 13px;
        margin: 0;
        padding: 12px 12px 10px;
        border-bottom: 1px solid var(--border);
        color: var(--muted);
        letter-spacing: 0.2px;
      }
      .card .body {
        padding: 12px;
      }
      .kv {
        display: grid;
        grid-template-columns: 98px 1fr;
        gap: 6px 10px;
        font-size: 12px;
      }
      .kv .k { color: var(--muted); }
      .kv .v { font-family: var(--mono); overflow-wrap: anywhere; }
      .hidden { display: none !important; }
      .legacy-panels { display: none; }
      .status-grid {
        display: grid;
        grid-template-columns: repeat(5, minmax(0, 1fr));
        gap: 10px;
      }
      .status-item {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 10px 12px;
        border-radius: 10px;
        border: 1px solid var(--border);
        background: rgba(2,6,23,0.35);
      }
      .status-label {
        font-family: var(--mono);
        font-size: 11px;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.6px;
      }
      .status-value {
        font-family: var(--mono);
        font-size: 16px;
        color: var(--text);
      }
      .status-meta {
        margin-top: 10px;
        font-family: var(--mono);
        font-size: 12px;
        color: var(--muted);
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
      }
      .card-view {
        display: flex;
        flex-direction: column;
        gap: 14px;
        flex: 1 1 auto;
        min-height: 0;
      }
      .card-view .card {
        display: flex;
        flex-direction: column;
        min-height: 0;
      }
      .card-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 12px 12px 10px;
        border-bottom: 1px solid var(--border);
      }
      .card-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-left: auto;
      }
      .card-title {
        flex: 1 1 auto;
        min-width: 0;
        font-size: 13px;
        color: var(--muted);
        letter-spacing: 0.2px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .card-tags {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
      }
      .card-body {
        padding: 12px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        min-height: 0;
      }
      .card-meta {
        font-family: var(--mono);
        font-size: 11px;
        color: var(--muted);
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .card-text {
        font-family: var(--mono);
        font-size: 12px;
        line-height: 1.5;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        max-height: 7.5em;
        overflow-y: auto;
        min-height: 7.5em;
      }
      .card-hero .card-body {
        flex: 1 1 auto;
      }
      .card-hero .card-text {
        flex: 1 1 auto;
        min-height: 10em;
        max-height: none;
      }
      .card-hero.watchdog-turns-active .card-meta,
      .card-hero.watchdog-turns-active .card-text {
        display: none;
      }
      .card-hero.full {
        flex: 1 1 auto;
      }
      .card-hero.full .card-body {
        flex: 1 1 auto;
      }
      .card-hero.full .card-text {
        flex: 1 1 auto;
        max-height: none;
        min-height: 0;
      }
      .card-stack {
        display: flex;
        flex-direction: column;
        gap: 14px;
        min-height: 0;
        flex: 1 1 auto;
        overflow: auto;
      }
      .card-list {
        display: flex;
        flex-direction: column;
        gap: 14px;
        min-height: 0;
      }
      .card-list .card {
        flex: 0 0 auto;
        min-height: 320px;
      }
      .card-list .card .card-body {
        flex: 1 1 auto;
      }
      .card-list .card .card-text {
        flex: 1 1 auto;
        min-height: 15em;
        max-height: 15em;
      }
      .card-stack > .card.planner-placeholder,
      .card-stack > .card.stack-placeholder {
        flex: 1 1 auto;
        min-height: 0;
      }
      .card-stack > .card.planner-placeholder .card-body,
      .card-stack > .card.stack-placeholder .card-body {
        flex: 1 1 auto;
      }
      .card-stack > .card.planner-placeholder .card-text,
      .card-stack > .card.stack-placeholder .card-text {
        flex: 1 1 auto;
        min-height: 0;
        max-height: none;
      }
      .card-empty { opacity: 0.6; }
      .fallback {
        position: fixed;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: var(--mono);
        font-size: 13px;
        color: var(--muted);
        background: var(--bg);
        z-index: 5;
      }
      .fallback.hidden { display: none; }
      .agents {
        display: grid;
        gap: 8px;
      }
      .agent-btn {
        width: 100%;
        text-align: left;
        border: 1px solid var(--border);
        background: rgba(15,23,42,0.6);
        color: var(--text);
        border-radius: 10px;
        padding: 10px 10px;
        cursor: pointer;
        display: grid;
        gap: 4px;
        overflow-wrap: anywhere;
      }
      .agent-btn.active {
        border-color: rgba(56,189,248,0.55);
        box-shadow: 0 0 0 1px rgba(56,189,248,0.18) inset;
      }
      .agent-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        min-width: 0;
      }
      .agent-id {
        font-family: var(--mono);
        font-size: 12px;
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .badge {
        font-size: 11px;
        padding: 2px 8px;
        border-radius: 999px;
        border: 1px solid var(--border);
        color: var(--muted);
        background: rgba(2,6,23,0.25);
        white-space: nowrap;
      }
      .badge.ok { color: var(--ok); border-color: rgba(52,211,153,0.35); }
      .badge.warn { color: var(--warn); border-color: rgba(251,191,36,0.35); }
      .badge.bad { color: var(--danger); border-color: rgba(251,113,133,0.35); }
      .badge.muted { color: var(--muted); border-color: rgba(148,163,184,0.35); }
      .tag-group {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 6px;
        flex-wrap: wrap;
      }
      .tag {
        font-size: 10px;
        padding: 1px 6px;
        border-radius: 999px;
        border: 1px solid var(--border);
        color: var(--muted);
        background: rgba(2,6,23,0.25);
        white-space: nowrap;
      }
      .tag.ok { color: var(--ok); border-color: rgba(52,211,153,0.35); }
      .tag.warn { color: var(--warn); border-color: rgba(251,191,36,0.35); }
      .tag.bad { color: var(--danger); border-color: rgba(251,113,133,0.35); }
      .tag.muted { color: var(--muted); border-color: rgba(148,163,184,0.35); }
      .tabs {
        display: flex;
        gap: 8px;
        padding: 10px 12px;
        border-bottom: 1px solid var(--border);
        background: rgba(15,23,42,0.55);
      }
      .tab {
        border: 1px solid var(--border);
        background: rgba(2,6,23,0.25);
        color: var(--muted);
        border-radius: 999px;
        padding: 6px 10px;
        font-size: 12px;
        cursor: pointer;
      }
      .tab.danger {
        color: var(--danger);
        border-color: rgba(251,113,133,0.6);
        background: rgba(251,113,133,0.12);
      }
      .tab:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .tab.active {
        color: var(--text);
        border-color: rgba(56,189,248,0.55);
      }
      .split {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
      }
      .mono {
        font-family: var(--mono);
        font-size: 12px;
        line-height: 1.5;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .logbox {
        flex: 1 1 auto;
        min-height: 0;
        overflow: auto;
        padding: 12px;
        background: rgba(2,6,23,0.35);
      }
      .toolbar {
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
        padding: 10px 12px;
        border-bottom: 1px solid var(--border);
        background: rgba(15,23,42,0.55);
      }
      .toolbar .input {
        flex: 1 1 auto;
        min-width: 0;
        width: auto;
      }
      body[data-graph-simple="1"] [data-graph-advanced="1"] {
        display: none !important;
      }
      .input {
        background: rgba(2,6,23,0.35);
        color: var(--text);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 8px 10px;
        font-size: 12px;
        width: 100%;
        font-family: var(--mono);
      }
      .toggle {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
        user-select: none;
        font-family: var(--mono);
        font-size: 12px;
        color: var(--muted);
        white-space: nowrap;
      }
      .toggle input {
        position: absolute;
        opacity: 0;
        width: 1px;
        height: 1px;
        overflow: hidden;
      }
      .toggle-ui {
        width: 38px;
        height: 22px;
        border-radius: 999px;
        border: 1px solid var(--border);
        background: rgba(2,6,23,0.35);
        position: relative;
        flex: 0 0 auto;
      }
      .toggle-ui::after {
        content: '';
        position: absolute;
        left: 2px;
        top: 2px;
        width: 18px;
        height: 18px;
        border-radius: 999px;
        background: rgba(148,163,184,0.7);
        transition: transform 120ms ease, background 120ms ease;
      }
      .toggle input:checked + .toggle-ui {
        border-color: rgba(56,189,248,0.55);
        background: rgba(56,189,248,0.18);
      }
      .toggle input:checked + .toggle-ui::after {
        transform: translateX(16px);
        background: rgba(56,189,248,0.95);
      }
      .tree {
        flex: 1 1 auto;
        min-height: 0;
        overflow: auto;
        padding: 10px 12px;
        background: rgba(2,6,23,0.35);
      }
      .tree-item {
        font-family: var(--mono);
        font-size: 12px;
        padding: 3px 6px;
        border-radius: 8px;
        cursor: pointer;
        display: flex;
        gap: 6px;
        align-items: center;
      }
      .tree-item:hover { background: rgba(148,163,184,0.12); }
      .tree-item.changed { color: var(--changed); }
      .tree-item.deleted { color: var(--danger); }
      .muted { color: var(--muted); }
      .graph-body {
        padding: 0;
        display: flex;
        flex-direction: column;
        flex: 1 1 auto;
        min-height: 0;
        overflow: hidden;
      }
      .graph-meta {
        padding: 10px 12px;
        border-bottom: 1px solid var(--border);
        font-family: var(--mono);
        font-size: 12px;
        color: var(--muted);
        overflow-wrap: anywhere;
        white-space: pre-wrap;
      }
      .graph-scroll {
        flex: 1 1 auto;
        min-height: 0;
        overflow: auto;
        padding: 8px 0 6px 0;
        background: var(--vscode-sideBar-background);
        overscroll-behavior: contain;
        touch-action: pan-x pan-y;
        scroll-padding-top: 12px;
      }
      .graph-list {
        display: flex;
        flex-direction: column;
        min-width: max-content;
        box-sizing: border-box;
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji";
        font-size: 13px;
      }
      .graph-row {
        display: flex;
        align-items: center;
        height: 22px;
        padding: 0 8px;
        gap: 0;
        white-space: nowrap;
        user-select: none;
      }
      #worktreeGraphCard .toolbar,
      #worktreeGraphCard .graph-meta {
        display: none;
      }
      #worktreeGraphCard .graph-body {
        padding: 0;
      }
      #worktreeGraphCard .graph-scroll {
        padding: 4px 0;
        scroll-padding-top: 0;
        background: var(--vscode-sideBar-background);
      }
      #worktreeGraphCard .graph-list {
        min-width: 100%;
      }
      #worktreeGraphCard .graph-row {
        padding-left: 4px;
        padding-right: 4px;
      }
      #worktreeGraphCard .label-description,
      #worktreeGraphCard .label-hash,
      #worktreeGraphCard .label-container {
        display: none;
      }
      #worktreeGraphCard .monaco-icon-label {
        gap: 0;
      }
      #worktreeGraphCard .monaco-icon-label .label-name {
        width: 100%;
      }
      #worktreeGraphCard .checklist-board {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 8px;
        box-sizing: border-box;
      }
      #worktreeGraphCard .checklist-grid {
        display: grid;
        gap: 8px;
        min-width: 100%;
        align-items: stretch;
      }
      #worktreeGraphCard .checklist-header {
        position: sticky;
        top: 0;
        z-index: 1;
      }
      #worktreeGraphCard .checklist-header-cell {
        display: flex;
        align-items: center;
        min-height: 42px;
        padding: 8px 10px;
        border-radius: 10px;
        background: color-mix(in srgb, var(--vscode-editorWidget-background) 92%, transparent);
        border: 1px solid color-mix(in srgb, var(--vscode-editorWidget-border) 85%, transparent);
        font-size: 12px;
        font-weight: 600;
      }
      #worktreeGraphCard .checklist-row-label {
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 4px;
        min-height: 92px;
        padding: 10px;
        border-radius: 12px;
        background: color-mix(in srgb, var(--vscode-editorWidget-background) 92%, transparent);
        border: 1px solid color-mix(in srgb, var(--vscode-editorWidget-border) 85%, transparent);
      }
      #worktreeGraphCard .checklist-row-title {
        font-size: 13px;
        font-weight: 700;
        color: var(--vscode-foreground);
      }
      #worktreeGraphCard .checklist-row-meta {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
      }
      #worktreeGraphCard .checklist-row-description {
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
        line-height: 1.4;
      }
      #worktreeGraphCard .checklist-cell {
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        gap: 8px;
        min-height: 92px;
        padding: 10px;
        border-radius: 12px;
        background: color-mix(in srgb, var(--vscode-editor-background) 94%, transparent);
        border: 1px solid color-mix(in srgb, var(--vscode-editorWidget-border) 72%, transparent);
      }
      #worktreeGraphCard .checklist-cell.running {
        border-color: color-mix(in srgb, var(--vscode-progressBar-background) 80%, transparent);
      }
      #worktreeGraphCard .checklist-cell.failed,
      #worktreeGraphCard .checklist-cell.blocked {
        border-color: color-mix(in srgb, var(--vscode-errorForeground) 65%, transparent);
      }
      #worktreeGraphCard .checklist-cell.completed {
        border-color: color-mix(in srgb, var(--vscode-testing-iconPassed) 65%, transparent);
      }
      #worktreeGraphCard .checklist-cell-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      #worktreeGraphCard .checklist-cell-title {
        font-size: 12px;
        font-weight: 600;
        color: var(--vscode-foreground);
      }
      #worktreeGraphCard .checklist-cell-subtitle {
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
        line-height: 1.35;
        white-space: normal;
        word-break: break-word;
      }
      #worktreeGraphCard .checklist-cell-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
      }
      #worktreeGraphCard .checklist-empty {
        padding: 24px;
        border-radius: 12px;
        border: 1px dashed color-mix(in srgb, var(--vscode-editorWidget-border) 72%, transparent);
        color: var(--vscode-descriptionForeground);
      }
      .graph-row:hover { background: var(--vscode-list-hoverBackground); }
      .graph-row.selected { background: var(--vscode-list-inactiveSelectionBackground); color: var(--vscode-list-inactiveSelectionForeground); }
      .graph-scroll:focus .graph-row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
      .graph-row.load-more { cursor: pointer; }
      .graph-row.load-more.disabled { cursor: default; opacity: 0.7; }
      .history-item-load-more .history-item-placeholder.shimmer {
        position: relative;
        overflow: hidden;
      }
      .history-item-load-more .history-item-placeholder.shimmer::after {
        content: "";
        position: absolute;
        inset: 0;
        background: linear-gradient(90deg, transparent, rgba(255,255,255,0.08), transparent);
        transform: translateX(-100%);
        animation: cdx-shimmer 1.2s infinite;
      }
      @keyframes cdx-shimmer {
        100% { transform: translateX(100%); }
      }
      .history-item-load-more .history-item-placeholder {
        display: flex;
        align-items: center;
        gap: 8px;
        color: var(--vscode-foreground);
        font-size: 13px;
      }

      .history-item {
        display: flex;
        align-items: center;
        width: 100%;
        min-width: 0;
      }
      .graph-container {
        display: flex;
        flex-shrink: 0;
        height: 22px;
        align-items: center;
      }
      .graph-container.flip-y > svg.graph {
        transform: scaleY(-1);
        transform-origin: 50% 50%;
      }
      .history-item > .graph-container.current > svg.graph > circle:last-child,
      .history-item > .graph-container.incoming-changes > svg.graph > circle:last-child,
      .history-item > .graph-container.outgoing-changes > svg.graph > circle:last-child {
        fill: var(--vscode-sideBar-background);
      }
      .graph-row:hover .history-item > .graph-container.current > svg.graph > circle:last-child,
      .graph-row:hover .history-item > .graph-container.incoming-changes > svg.graph > circle:last-child,
      .graph-row:hover .history-item > .graph-container.outgoing-changes > svg.graph > circle:last-child {
        fill: var(--vscode-list-hoverBackground);
      }
      .history-item > .graph-container > svg.graph > circle { stroke: var(--vscode-sideBar-background); }
      .graph-row:hover .history-item > .graph-container > svg.graph > circle:first-of-type { stroke: transparent; }
      .graph-row:hover .history-item > .graph-container > svg.graph > circle:nth-of-type(2) { stroke: var(--vscode-list-hoverBackground); }
      .graph-row.selected .history-item > .graph-container > svg.graph > circle:nth-of-type(2) { stroke: var(--vscode-list-inactiveSelectionBackground); }
      .graph-scroll:focus .graph-row.selected .history-item > .graph-container > svg.graph > circle:nth-of-type(2) { stroke: var(--vscode-list-activeSelectionBackground); }
      .graph-row.selected .history-item > .graph-container.incoming-changes > svg.graph > circle:last-child,
      .graph-row.selected .history-item > .graph-container.outgoing-changes > svg.graph > circle:last-child {
        fill: var(--vscode-list-inactiveSelectionBackground);
      }
      .graph-scroll:focus .graph-row.selected .history-item > .graph-container.incoming-changes > svg.graph > circle:last-child,
      .graph-scroll:focus .graph-row.selected .history-item > .graph-container.outgoing-changes > svg.graph > circle:last-child {
        fill: var(--vscode-list-activeSelectionBackground);
      }

      .monaco-icon-label {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
        flex: 1 1 auto;
      }
      .monaco-icon-label .label-name {
        color: var(--vscode-foreground);
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .graph-row.selected .monaco-icon-label .label-name { color: inherit; }
      .monaco-icon-label .label-description {
        color: var(--vscode-disabledForeground);
        flex: 0 0 auto;
      }
      .graph-row.selected .monaco-icon-label .label-description { color: inherit; opacity: 0.9; }
      .monaco-icon-label .label-hash {
        font-family: var(--mono);
        font-size: 12px;
        color: var(--vscode-disabledForeground);
        flex: 0 0 auto;
      }
      .graph-row.selected .monaco-icon-label .label-hash { color: inherit; opacity: 0.9; }
      .monaco-icon-label.history-item-current .label-name { font-weight: 600; }
      .monaco-icon-label.history-item-current .label-description { font-weight: 500; }

      .label-container {
        display: flex;
        flex-shrink: 0;
        margin-left: 4px;
        gap: 4px;
      }
      .label-container > .label {
        display: flex;
        align-items: center;
        border-radius: 10px;
        line-height: 18px;
      }
	      .label-container > .label > .count {
	        font-size: 12px;
	        padding-left: 4px;
	      }
	      .label-container > .label > .icon {
	        color: inherit;
	        padding: 1px 2px;
	      }
	      .label-container > .label > .description {
	        font-size: 12px;
	        padding-right: 4px;
	        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 100px;
      }
      .history-item-load-more .graph-placeholder {
        mask-image: linear-gradient(transparent, black);
        -webkit-mask-image: linear-gradient(transparent, black);
      }

      .graph-hover {
        position: fixed;
        z-index: 9999;
        display: none;
        max-width: 520px;
        background: #1f1f1f;
        border: 1px solid #3c3c3c;
        border-radius: 6px;
        padding: 8px 10px;
        box-shadow: 0 6px 24px rgba(0,0,0,0.45);
        color: var(--vscode-foreground);
        font-size: 12px;
        pointer-events: none;
      }
      .graph-hover .history-item-hover-container p { margin: 4px 0; }
      .graph-hover .history-item-hover-container .hover-refs {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-top: 6px;
      }
      .graph-hover .history-item-hover-container .hover-ref {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        border-radius: 10px;
        padding: 2px 6px;
        background: var(--vscode-badge-background);
        color: var(--vscode-foreground);
      }
      .graph-hover .history-item-hover-container .hover-ref.colored {
        color: var(--vscode-sideBar-background);
      }
      body.worktree-maximized { overflow: hidden; }
      body.worktree-maximized .layout { overflow: hidden; }
      body.worktree-maximized #ioCard {
        position: fixed;
        left: 0;
        right: 0;
        top: var(--header-height, 56px);
        bottom: 0;
        z-index: 50;
        border-radius: 0;
        box-shadow: 0 18px 60px rgba(0,0,0,0.55);
      }
      @media (max-width: 980px) {
        body { height: auto; }
        .layout { grid-template-columns: 1fr; overflow: visible; }
        .dashboard-sidebar,
        .dashboard-main { overflow: visible; }
        .status-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
    </style>
  </head>
  <body>
    <header style="display:none;">
      <div class="title">
        <h1>CDX Stats</h1>
        <div id="serverPid" class="pill">server pid: -</div>
        <div id="pillAgents" class="pill">agents: 0</div>
        <div id="pillTasks" class="pill">tasks: 0</div>
        <div id="pillSched" class="pill">sched: -</div>
        <div id="pillTime" class="pill">time: -</div>
        <div id="pillStatus" class="pill">status: -</div>
      </div>
      <div class="toolbar session-bar">
        <div id="sessionMeta" class="session-meta"></div>
      </div>
    </header>

    <div id="jobsOverlay" class="overlay hidden" aria-hidden="true">
      <div class="overlay-card">
        <div class="overlay-header">
          <div class="overlay-title">Jobs</div>
          <div class="overlay-actions">
            <button id="jobsFollowLatest" class="tab">follow latest</button>
            <button id="jobsClose" class="tab">close</button>
          </div>
        </div>
        <div class="overlay-body">
          <div id="jobsMeta" class="jobs-meta">jobs: -</div>
          <div id="jobsList" class="jobs-list"></div>
        </div>
      </div>
    </div>

    <div id="fallback" class="fallback">Loading CDX Stats…</div>

${renderDashboardLayout()}

    <script>
	      const pillRun = document.getElementById('pillRun');
      const pillAgents = document.getElementById('pillAgents');
      const pillTasks = document.getElementById('pillTasks');
      const pillSched = document.getElementById('pillSched');
	      const pillTime = document.getElementById('pillTime');
	      const pillStatus = document.getElementById('pillStatus');
	      const runKv = document.getElementById('runKv');
      const statusRunEl = document.getElementById('statusRun');
      const statusWaitEl = document.getElementById('statusWait');
      const statusBlockEl = document.getElementById('statusBlock');
      const statusMergeEl = document.getElementById('statusMerge');
      const statusDoneEl = document.getElementById('statusDone');
      const statusElapsedEl = document.getElementById('statusElapsed');
      const statusEtaEl = document.getElementById('statusEta');
      const statusConnEl = document.getElementById('statusConn');
      const fallbackEl = document.getElementById('fallback');
      const cardHero = document.getElementById('cardHero');
      const cardHeroTitle = document.getElementById('cardHeroTitle');
      const cardHeroTags = document.getElementById('cardHeroTags');
      const cardHeroMeta = document.getElementById('cardHeroMeta');
	      const cardHeroText = document.getElementById('cardHeroText');
	      const cardStack = document.getElementById('cardStack');
	      const cardStackTemplate = document.getElementById('cardStackTemplate');
      const cardViewEl = document.getElementById('cardView');
	      const agentsEl = document.getElementById('agents');
	      const agentsMetaEl = document.getElementById('agentsMeta');
	      const tasksEl = document.getElementById('tasks');
	      const tasksMetaEl = document.getElementById('tasksMeta');
      const tabLogs = document.getElementById('tabLogs');
      const tabApi = document.getElementById('tabApi');
      const tabPrompts = document.getElementById('tabPrompts');
      const tabWorktree = document.getElementById('tabWorktree');
      const panelLogs = document.getElementById('panelLogs');
      const panelApi = document.getElementById('panelApi');
      const panelPrompts = document.getElementById('panelPrompts');
      const panelWorktree = document.getElementById('panelWorktree');
      const logbox = document.getElementById('logbox');
      const apibox = document.getElementById('apibox');
	      const promptbox = document.getElementById('promptbox');
	      const promptsEnabled = Boolean(tabPrompts && panelPrompts);
      const worktreeGraphTitle = document.getElementById('worktreeGraphTitle');
      const worktreeGraphToolbar = document.querySelector('#worktreeGraphCard .toolbar');
	      const graphMeta = document.getElementById('graphMeta');
		      const graphScroll = document.getElementById('graphScroll');
		      const graphList = document.getElementById('graphList');
		      const graphCanvas = document.getElementById('graphCanvas');
		      const graphLimitInput = document.getElementById('graphLimit');
		      const refreshGraphBtn = document.getElementById('refreshGraph');
		      const graphSimpleInput = document.getElementById('graphSimple');
		      const graphAllRefsInput = document.getElementById('graphAllRefs');
		      const graphPageOnScrollInput = document.getElementById('graphPageOnScroll');
			      const graphBadgesSelect = document.getElementById('graphBadges');
			      const graphIncomingInput = document.getElementById('graphIncoming');
			      const graphOutgoingInput = document.getElementById('graphOutgoing');
			      const graphWorktreeChangesInput = document.getElementById('graphWorktreeChanges');
			      const graphUntrackedInput = document.getElementById('graphUntracked');
	      const filterInput = document.getElementById('filterInput');
	      const apiFilterInput = document.getElementById('apiFilterInput');
	      const apiRawInput = document.getElementById('apiRaw');
	      const promptFilterInput = document.getElementById('promptFilterInput');
	      const promptRawInput = document.getElementById('promptRaw');
      const pathInput = document.getElementById('pathInput');
      const treeEl = document.getElementById('tree');
      const fileEl = document.getElementById('file');
      const gitStatusEl = document.getElementById('gitStatus');
      const jobsButton = document.getElementById('jobsButton');
      const jobsOverlay = document.getElementById('jobsOverlay');
      const jobsClose = document.getElementById('jobsClose');
      const jobsFollowLatest = document.getElementById('jobsFollowLatest');
      const jobsListEl = document.getElementById('jobsList');
      const jobsMetaEl = document.getElementById('jobsMeta');
      const sessionMetaEl = document.getElementById('sessionMeta');
      const serverPidEl = document.getElementById('serverPid');
	      const killRunBtn = document.getElementById('killRun');
      const ioCard = document.getElementById('ioCard');
	      const worktreeMaxToggle = document.getElementById('worktreeMaxToggle');
      const headerEl = document.querySelector('header');
      let testGitTreeEl = document.getElementById('testGitTree');
      let testTaskDagWrapEl = document.getElementById('testTaskDagWrap');
      let testTaskDagTableEl = document.getElementById('testTaskDagTable');
      let taskDagTitleEl = document.getElementById('taskDagTitle');
      let taskDagMetaEl = document.getElementById('taskDagMeta');

	      const pageQuery = new URLSearchParams(window.location.search);
      const pageMode = String(pageQuery.get('mode') ?? '').trim().toLowerCase();
      const isStatsTestMode = pageMode === 'test' || pageMode === 'debug';
      let state = null;
      let selectedRunId = String(pageQuery.get('runId') ?? '').trim();
        let selectedPid = String(pageQuery.get('pid') ?? '').trim();
        const runIdLocked = Boolean(selectedRunId);
      let followActiveRun = !selectedRunId;
      let runSwitchInFlight = false;
      const initialTab = (() => {
        const raw = String(pageQuery.get('tab') ?? '').trim().toLowerCase();
        if (raw === 'api') return 'api';
        if (raw === 'worktree') return 'worktree';
        return 'logs';
      })();
      let activeTab = initialTab;
      const CARD_TOP_HOLD_MS = 5000;
      const CARD_STACK_MAX_ITEMS = 8;
      let cardStackTopId = null;
      let cardStackTopAt = 0;
      let backendConnected = null;
      let backendError = null;
		      let selectedAgent = null;
		      let selectedWorktreeAgent = null;
		      let selectedPath = '';
		      let logAfter = 0;
		      const agentTokenCache = new Map();
		      const taskTokenCache = new Map();
		      let lastTokenRunId = null;
		      const STATE_POLL_MS = 1000;
		      const LOG_POLL_MIN_INTERVAL_MS = 250;
		      const LOG_LONG_POLL_TIMEOUT_MS = 25_000;
		      const API_POLL_MIN_INTERVAL_MS = 500;
		      const API_LONG_POLL_TIMEOUT_MS = 25_000;
		      const API_APPEND_THROTTLE_MS = 120;
		      const PROMPT_POLL_MIN_INTERVAL_MS = 500;
		      const PROMPT_LONG_POLL_TIMEOUT_MS = 25_000;
		      const PROMPT_APPEND_THROTTLE_MS = 120;
		      const GRAPH_AUTO_REFRESH_MS = 2_000;
		      const GRAPH_THROTTLE_MS = 2_000;
		      const GRAPH_AUTO_RESUME_DELAY_MS = 10_000;
		      const EVENT_POLL_MIN_INTERVAL_MS = 1000;
		      const EVENT_LONG_POLL_TIMEOUT_MS = 25_000;
		      const EVENT_LATEST_LONG_POLL_TIMEOUT_MS = 5000;
		      const WORKTREE_STATUS_POLL_MIN_MS = 2000;
		      const WORKTREE_STATUS_POLL_MAX_MS = 15_000;
		      const MAX_LOG_LINES = 4000;
		      const TRIM_LOG_LINES = 3000;
		      const MAX_API_LINES = 4000;
		      const TRIM_API_LINES = 3000;
		      const MAX_PROMPT_LINES = 4000;
		      const TRIM_PROMPT_LINES = 3000;
		      let logLines = [];
		      let logTail = '';
		      let logTotalLines = 0;
		      let logPendingLines = [];
		      let logFlushRaf = null;
		      let logTextNode = null;
		      let logStream = null;
		      let logStreamKey = '';
		      let apiChunks = [];
		      let apiTotalLines = 0;
		      let apiPendingLines = [];
		      let apiFlushTimer = null;
		      let promptChunks = [];
		      let promptTotalLines = 0;
		      let promptPendingLines = [];
		      let promptFlushTimer = null;
		      let eventAfterId = 0;
		      let eventsLoopRunning = false;
		      let eventsAbortController = null;
		      let eventsLastPollAt = 0;
		      let logsLoopRunning = false;
		      let logsAbortController = null;
		      let logsLastPollAt = 0;
		      let apiLoopRunning = false;
		      let apiAbortController = null;
		      let apiLastPollAt = 0;
		      let promptLoopRunning = false;
		      let promptAbortController = null;
		      let promptLastPollAt = 0;
		      let worktreeLoopRunning = false;
		      let worktreeStatusAbortController = null;
		      let worktreeTreeAbortController = null;
		      let worktreeLastPollAt = 0;
		      let worktreePollDelayMs = WORKTREE_STATUS_POLL_MIN_MS;
		      let worktreeLastStatusText = null;
		      let graphRefreshDeferred = false;
		      let graphAutoRefreshPausedUntil = 0;
		      let graphAutoRefreshTimer = null;
		      let refreshTimer = null;
		      let statePollInFlight = false;
		      let graphLastFetchAt = 0;
			      let graphLastRunId = null;
			      let graphInFlight = false;
			      let graphCache = null;
			      let graphResizeTimer = null;
		      let graphPendingScrollAdjustment = 0;
		      let graphCommits = [];
		      let graphSkip = 0;
		      let graphHasMore = false;
		      let graphLoadingMore = false;
		      let graphViewModels = [];
		      let graphColumnsForLoadMore = [];
		      let graphSelectedIndex = -1;
		      let graphVirtualTopSpacer = null;
		      let graphVirtualRows = null;
		      let graphVirtualBottomSpacer = null;
		      let graphLoadMoreRow = null;
		      let graphLoadMoreObserver = null;
		      let graphLoadMorePlaceholder = null;
		      let graphLoadMoreLabel = null;
		      let graphVirtualStart = 0;
		      let graphVirtualEnd = 0;
		      let graphHoverEl = null;
		      let graphHoverTimer = null;
		      let graphHoverToken = 0;
		      let graphHoverIndex = null;
		      let graphHoverAnchor = null;
		      let worktreeMaximized = false;
		      let gitChangeIndex = null;
      let apiAfterId = 0;
      let promptAfterId = 0;
      let testGitTreeRunId = null;
      let watchdogTurnTabsEl = null;
      let watchdogTurnPanelEl = null;
      let watchdogTurnTabs = [];
      let watchdogActiveTurn = null;
      let watchdogTurnsInFlight = false;
      let watchdogTurnsLastFetchAt = 0;
      let watchdogTurnsLastRunKey = null;
      let watchdogTurnsLastEventId = 0;
      let watchdogTurnsLastLogId = 0;
      const WATCHDOG_TURNS_REFRESH_MIN_MS = 1500;

      function updateHeaderHeight() {
        const height = headerEl ? Math.ceil(headerEl.getBoundingClientRect().height) : 0;
        document.documentElement.style.setProperty('--header-height', String(height) + 'px');
      }

      function refreshDagCardElements() {
        testGitTreeEl = document.getElementById('testGitTree');
        testTaskDagWrapEl = document.getElementById('testTaskDagWrap');
        testTaskDagTableEl = document.getElementById('testTaskDagTable');
        taskDagTitleEl = document.getElementById('taskDagTitle');
        taskDagMetaEl = document.getElementById('taskDagMeta');
      }

      function capturePageScrollState() {
        const scrollingEl = document.scrollingElement || document.documentElement || document.body;
        return {
          top: Number(window.scrollY ?? scrollingEl?.scrollTop ?? 0) || 0,
          left: Number(window.scrollX ?? scrollingEl?.scrollLeft ?? 0) || 0,
        };
      }

      function restorePageScrollState(state) {
        if (!state) return;
        const top = Number.isFinite(state?.top) ? state.top : 0;
        const left = Number.isFinite(state?.left) ? state.left : 0;
        const scrollingEl = document.scrollingElement || document.documentElement || document.body;
        if (scrollingEl) {
          scrollingEl.scrollTop = top;
          scrollingEl.scrollLeft = left;
        }
        if (typeof window.scrollTo === 'function') {
          window.scrollTo(left, top);
        }
      }

      function captureTaskDagScrollState() {
        refreshDagCardElements();
        const wrapEl = testTaskDagWrapEl;
        const outputScroll = [];
        if (wrapEl) {
          const outputEls = wrapEl.querySelectorAll('.summary-output-box[data-task-output-id]');
          for (const outputEl of outputEls) {
            const taskId = String(outputEl.getAttribute('data-task-output-id') ?? '').trim();
            if (!taskId) continue;
            outputScroll.push({
              taskId,
              top: Number(outputEl.scrollTop) || 0,
              left: Number(outputEl.scrollLeft) || 0,
            });
          }
        }
        return {
          wrapTop: wrapEl ? (Number(wrapEl.scrollTop) || 0) : 0,
          wrapLeft: wrapEl ? (Number(wrapEl.scrollLeft) || 0) : 0,
          outputScroll,
        };
      }

      function restoreTaskDagScrollState(state) {
        if (!state) return;
        refreshDagCardElements();
        const wrapEl = testTaskDagWrapEl;
        if (!wrapEl) return;
        wrapEl.scrollTop = Number.isFinite(state?.wrapTop) ? state.wrapTop : 0;
        wrapEl.scrollLeft = Number.isFinite(state?.wrapLeft) ? state.wrapLeft : 0;

        const outputByTaskId = new Map();
        const outputEls = wrapEl.querySelectorAll('.summary-output-box[data-task-output-id]');
        for (const outputEl of outputEls) {
          const taskId = String(outputEl.getAttribute('data-task-output-id') ?? '').trim();
          if (!taskId || outputByTaskId.has(taskId)) continue;
          outputByTaskId.set(taskId, outputEl);
        }

        const entries = Array.isArray(state?.outputScroll) ? state.outputScroll : [];
        for (const entry of entries) {
          const taskId = String(entry?.taskId ?? '').trim();
          if (!taskId) continue;
          const outputEl = outputByTaskId.get(taskId);
          if (!outputEl) continue;
          outputEl.scrollTop = Number.isFinite(entry?.top) ? entry.top : 0;
          outputEl.scrollLeft = Number.isFinite(entry?.left) ? entry.left : 0;
        }
      }

      function initStatsTestLayout() {
        refreshDagCardElements();
        ensureWatchdogTurnBrowser();
      }

      function setWorktreeMaximized(next) {
        worktreeMaximized = Boolean(next);
        document.body.classList.toggle('worktree-maximized', worktreeMaximized);
        if (worktreeMaxToggle) {
          worktreeMaxToggle.textContent = worktreeMaximized ? 'minimize' : 'maximize';
        }
        updateHeaderHeight();
      }

      worktreeMaxToggle?.addEventListener('click', () => setWorktreeMaximized(!worktreeMaximized));
      initStatsTestLayout();
      if (cardHero) {
        cardHero.addEventListener('click', event => {
          const tab = event?.target?.closest?.('.watchdog-turn-tab[data-turn]');
          if (!tab) return;
          const turn = Number.parseInt(tab.getAttribute('data-turn') ?? '', 10);
          if (!Number.isFinite(turn)) return;
          watchdogActiveTurn = turn;
          renderWatchdogTurnTabs();
        });
      }
      updateHeaderHeight();

	      const STORAGE_KEYS = {
	        apiRaw: 'cdxStats.api.raw',
	        promptRaw: 'cdxStats.prompts.raw',
	        graphSimple: 'cdxStats.graph.simple',
	        graphAllRefs: 'cdxStats.graph.allRefs',
	        graphPageOnScroll: 'cdxStats.graph.pageOnScroll',
	        graphBadges: 'cdxStats.graph.badges',
		        graphIncoming: 'cdxStats.graph.incomingChanges',
		        graphOutgoing: 'cdxStats.graph.outgoingChanges',
		        graphWorktreeChanges: 'cdxStats.graph.worktreeChanges',
		        graphUntracked: 'cdxStats.graph.untracked',
		        graphPageSize: 'cdxStats.graph.pageSize',
		      };

	      function readStoredBool(key, fallback) {
	        try {
	          const raw = localStorage.getItem(key);
	          if (raw === null) return fallback;
          const normalized = String(raw).trim().toLowerCase();
          if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
          if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
          return fallback;
        } catch {
          return fallback;
	        }
	      }

	      function readStoredString(key, fallback) {
	        try {
	          const raw = localStorage.getItem(key);
	          if (raw === null) return fallback;
	          const value = String(raw ?? '').trim();
	          return value ? value : fallback;
	        } catch {
	          return fallback;
	        }
	      }

		      function storeBool(key, value) {
		        try {
		          localStorage.setItem(key, value ? '1' : '0');
		        } catch {}
		      }

      function storeString(key, value) {
        try {
          localStorage.setItem(key, String(value ?? ''));
        } catch {}
      }

      function parseGraphPageSize(rawValue) {
        const normalized = String(rawValue ?? '').trim().toLowerCase();
        if (!normalized || normalized === 'all' || normalized === '0') {
          return { pageSize: 0, label: 'all' };
        }
        const parsed = Number.parseInt(normalized, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          return { pageSize: 0, label: 'all' };
        }
        const bounded = Math.max(20, Math.min(800, parsed));
        return { pageSize: bounded, label: String(bounded) };
      }

      function applyGraphSimpleMode() {
        const simple = graphSimpleInput ? graphSimpleInput.checked : false;
        if (document.body) {
          if (simple) {
            document.body.dataset.graphSimple = '1';
          } else {
            delete document.body.dataset.graphSimple;
          }
        }
      }

	      function resetLogs() {
		        logAfter = 0;
		        logLines = [];
		        logTail = '';
		        logTotalLines = 0;
		        logPendingLines = [];
		        if (logFlushRaf) cancelAnimationFrame(logFlushRaf);
		        logFlushRaf = null;
		        closeLogStream();
		        if (logbox) {
		          logbox.textContent = '';
		          logTextNode = document.createTextNode('');
		          logbox.appendChild(logTextNode);
		        } else {
		          logTextNode = null;
		        }
		      }

		      function resetApi() {
		        apiAfterId = 0;
		        clearApiView();
		      }

		      function clearApiView() {
		        apiChunks = [];
		        apiTotalLines = 0;
		        apiPendingLines = [];
		        if (apiFlushTimer) clearTimeout(apiFlushTimer);
		        apiFlushTimer = null;
		        if (apibox) apibox.textContent = '';
		      }

		      function resetPrompts() {
		        promptAfterId = 0;
		        clearPromptView();
		      }

		      function clearPromptView() {
		        promptChunks = [];
		        promptTotalLines = 0;
		        promptPendingLines = [];
		        if (promptFlushTimer) clearTimeout(promptFlushTimer);
		        promptFlushTimer = null;
		        if (promptbox) promptbox.textContent = '';
		      }

		      function trimLogs() {
		        logTotalLines = logLines.length + (logTail ? 1 : 0);
		        if (logTotalLines <= MAX_LOG_LINES) return;
		        if (logLines.length > TRIM_LOG_LINES) {
		          logLines = logLines.slice(-TRIM_LOG_LINES);
		          logTotalLines = logLines.length + (logTail ? 1 : 0);
		        }
		      }

		      function trimApi() {
		        if (!apibox) return;
		        if (apiTotalLines <= MAX_API_LINES) return;
		        while (apiChunks.length > 0 && apiTotalLines > TRIM_API_LINES) {
		          const chunk = apiChunks.shift();
		          if (!chunk) continue;
		          if (chunk.node && chunk.node.parentNode === apibox) {
		            apibox.removeChild(chunk.node);
		          }
		          apiTotalLines -= chunk.lines || 0;
		        }
		      }

		      function trimPrompts() {
		        if (!promptbox) return;
		        if (promptTotalLines <= MAX_PROMPT_LINES) return;
		        while (promptChunks.length > 0 && promptTotalLines > TRIM_PROMPT_LINES) {
		          const chunk = promptChunks.shift();
		          if (!chunk) continue;
		          if (chunk.node && chunk.node.parentNode === promptbox) {
		            promptbox.removeChild(chunk.node);
		          }
		          promptTotalLines -= chunk.lines || 0;
		        }
		      }

		      function ensureLogTextNode() {
		        if (!logbox) return null;
		        if (!logTextNode || logTextNode.parentNode !== logbox) {
		          logbox.textContent = '';
		          logTextNode = document.createTextNode('');
		          logbox.appendChild(logTextNode);
		        }
		        return logTextNode;
		      }

		      function enqueueLogLines(lines) {
		        const raw = Array.isArray(lines) ? lines : [];
		        if (raw.length === 0) return;
		        logPendingLines.push(...raw);

		        if (logFlushRaf) return;
		        logFlushRaf = requestAnimationFrame(() => {
		          logFlushRaf = null;
		          const batch = logPendingLines;
		          logPendingLines = [];
		          appendLogLines(batch);
		        });
		      }

		      function enqueueApiLines(lines) {
		        const raw = Array.isArray(lines) ? lines : [];
		        if (raw.length === 0) return;
		        apiPendingLines.push(...raw);

		        if (apiFlushTimer) return;
		        apiFlushTimer = setTimeout(() => {
		          apiFlushTimer = null;
		          const batch = apiPendingLines;
		          apiPendingLines = [];
		          appendApiLines(batch);
		        }, API_APPEND_THROTTLE_MS);
		      }

		      function enqueuePromptLines(lines) {
		        const raw = Array.isArray(lines) ? lines : [];
		        if (raw.length === 0) return;
		        promptPendingLines.push(...raw);

		        if (promptFlushTimer) return;
		        promptFlushTimer = setTimeout(() => {
		          promptFlushTimer = null;
		          const batch = promptPendingLines;
		          promptPendingLines = [];
		          appendPromptLines(batch);
		        }, PROMPT_APPEND_THROTTLE_MS);
		      }

		      function appendLogLines(lines) {
		        if (!logbox) return;
		        const raw = Array.isArray(lines) ? lines : [];
		        if (raw.length === 0) return;
		        const filter = String(filterInput.value ?? '').trim();

		        const pushLine = line => {
		          if (filter && !line.includes(filter)) return;
		          logLines.push(line);
		        };
		        const appendStreamText = text => {
		          let combined = logTail ? logTail + text : text;
		          if (logTail && text.startsWith(logTail)) {
		            combined = text;
		          }
		          const parts = combined.split('\\n');
		          logTail = parts.pop() ?? '';
		          for (const line of parts) {
		            pushLine(line);
		          }
		        };

		        const normalizeEntry = entry => {
		          if (entry === null || entry === undefined) return null;
		          if (typeof entry === 'string') return { text: entry, stream: false };
		          if (typeof entry === 'object' && !Array.isArray(entry)) {
		            const text = typeof entry.text === 'string' ? entry.text : String(entry.text ?? '');
		            return { text, stream: entry.stream === true };
		          }
		          return { text: String(entry), stream: false };
		        };

		        for (const item of raw) {
		          const entry = normalizeEntry(item);
		          if (!entry) continue;
		          const text = String(entry.text ?? '').replace(/\\r/g, '');
		          if (entry.stream) {
		            if (!text) continue;
		            appendStreamText(text);
		            continue;
		          }

		          if (logTail) {
		            pushLine(logTail);
		            logTail = '';
		          }
		          const parts = text.split('\\n');
		          for (const line of parts) {
		            pushLine(line);
		          }
		        }

		        trimLogs();

		        const node = ensureLogTextNode();
		        if (node) {
		          const showTail = logTail && (!filter || logTail.includes(filter));
		          const displayLines = showTail ? logLines.concat(logTail) : logLines;
		          if (displayLines.length === 0) {
		            node.textContent = '';
		          } else {
		            node.textContent =
		              displayLines.join('\\n') + (showTail ? '' : '\\n');
		          }
		        }
		      }

		      function appendApiLines(lines) {
		        if (!apibox) return;
		        const raw = Array.isArray(lines) ? lines : [];
		        if (raw.length === 0) return;

		        const filter = String(apiFilterInput?.value ?? '').trim();
		        const filtered = filter ? raw.filter(line => line.includes(filter)) : raw;
		        if (filtered.length === 0) return;

		        const text = filtered.join('\\n') + '\\n';
		        const node = document.createTextNode(text);
		        apibox.appendChild(node);
		        apiChunks.push({ node, lines: filtered.length });
		        apiTotalLines += filtered.length;
		        trimApi();
		      }

		      function appendPromptLines(lines) {
		        if (!promptbox) return;
		        const raw = Array.isArray(lines) ? lines : [];
		        if (raw.length === 0) return;

		        const filter = String(promptFilterInput?.value ?? '').trim();
		        const filtered = filter ? raw.filter(line => line.includes(filter)) : raw;
		        if (filtered.length === 0) return;

		        const text = filtered.join('\\n') + '\\n';
		        const node = document.createTextNode(text);
		        promptbox.appendChild(node);
		        promptChunks.push({ node, lines: filtered.length });
		        promptTotalLines += filtered.length;
		        trimPrompts();
		      }

      if (apiRawInput) {
		        apiRawInput.checked = readStoredBool(STORAGE_KEYS.apiRaw, false);
		        apiRawInput.addEventListener('change', () => {
		          storeBool(STORAGE_KEYS.apiRaw, apiRawInput.checked);
		          resetApi();
		          if (activeTab === 'api') {
		            refreshApi(true, 0).catch(() => {});
		          }
		        });
		      }

		      if (promptRawInput) {
		        promptRawInput.checked = readStoredBool(STORAGE_KEYS.promptRaw, false);
		        promptRawInput.addEventListener('change', () => {
		          storeBool(STORAGE_KEYS.promptRaw, promptRawInput.checked);
		          resetPrompts();
		          if (activeTab === 'prompts') {
		            refreshPrompts(true, 0).catch(() => {});
		          }
		        });
		      }

	      if (graphSimpleInput) {
	        graphSimpleInput.checked = readStoredBool(STORAGE_KEYS.graphSimple, true);
	        applyGraphSimpleMode();
	        graphSimpleInput.addEventListener('change', () => {
	          storeBool(STORAGE_KEYS.graphSimple, graphSimpleInput.checked);
	          applyGraphSimpleMode();
	          refreshGraph(true);
	        });
	      }

	      if (graphAllRefsInput) {
	        graphAllRefsInput.checked = readStoredBool(STORAGE_KEYS.graphAllRefs, false);
	        graphAllRefsInput.addEventListener('change', () => {
	          storeBool(STORAGE_KEYS.graphAllRefs, graphAllRefsInput.checked);
	          refreshGraph(true);
	        });
	      }

	      if (graphPageOnScrollInput) {
	        graphPageOnScrollInput.checked = readStoredBool(STORAGE_KEYS.graphPageOnScroll, true);
	        graphPageOnScrollInput.addEventListener('change', () => {
	          storeBool(STORAGE_KEYS.graphPageOnScroll, graphPageOnScrollInput.checked);
	        });
	      }

	      if (graphBadgesSelect) {
	        graphBadgesSelect.value = readStoredString(STORAGE_KEYS.graphBadges, 'filter');
	        graphBadgesSelect.addEventListener('change', () => {
	          storeString(STORAGE_KEYS.graphBadges, graphBadgesSelect.value);
	          refreshGraph(true);
	        });
	      }

	      if (graphIncomingInput) {
	        graphIncomingInput.checked = readStoredBool(STORAGE_KEYS.graphIncoming, true);
	        graphIncomingInput.addEventListener('change', () => {
	          storeBool(STORAGE_KEYS.graphIncoming, graphIncomingInput.checked);
	          refreshGraph(true);
	        });
	      }

	      if (graphOutgoingInput) {
	        graphOutgoingInput.checked = readStoredBool(STORAGE_KEYS.graphOutgoing, true);
	        graphOutgoingInput.addEventListener('change', () => {
	          storeBool(STORAGE_KEYS.graphOutgoing, graphOutgoingInput.checked);
	          refreshGraph(true);
	        });
	      }

      if (graphLimitInput) {
        const stored = readStoredString(STORAGE_KEYS.graphPageSize, 'all');
        const normalized = String(stored ?? '').trim();
        const migrated = !normalized || normalized === '200';
        const nextValue = migrated ? 'all' : normalized;
        if (!graphLimitInput.value) graphLimitInput.value = nextValue;
        if (migrated) storeString(STORAGE_KEYS.graphPageSize, nextValue);
        graphLimitInput.addEventListener('change', () => {
          storeString(STORAGE_KEYS.graphPageSize, String(graphLimitInput.value ?? ''));
        });
      }

		      if (graphWorktreeChangesInput) {
		        graphWorktreeChangesInput.checked = readStoredBool(STORAGE_KEYS.graphWorktreeChanges, false);
		        graphWorktreeChangesInput.addEventListener('change', () => {
		          storeBool(STORAGE_KEYS.graphWorktreeChanges, graphWorktreeChangesInput.checked);
		          refreshGraph(true);
		        });
		      }
		      if (graphUntrackedInput) {
		        graphUntrackedInput.checked = readStoredBool(STORAGE_KEYS.graphUntracked, false);
		        graphUntrackedInput.addEventListener('change', () => {
		          storeBool(STORAGE_KEYS.graphUntracked, graphUntrackedInput.checked);
		          refreshGraph(true);
		        });
		      }

      function normalizeRelPath(value) {
        return String(value ?? '')
          .trim()
          .replaceAll('\\\\', '/')
          .replace(/^\\/+/, '')
          .replace(/\\/+$/, '');
      }

      function emptyGitChangeIndex() {
        return {
          changedFiles: new Set(),
          deletedFiles: new Set(),
          changedDirs: new Set(),
        };
      }

      function buildGitChangeIndex(porcelain) {
        const index = emptyGitChangeIndex();
        const lines = String(porcelain ?? '').replace(/\\r/g, '').split('\\n');
        for (const line of lines) {
          if (!line) continue;
          if (line.startsWith('!! ')) continue;

          let pathPart = '';
          let isDeleted = false;
          if (line.startsWith('?? ')) {
            pathPart = line.slice(3);
          } else if (line.length >= 4) {
            const x = line[0];
            const y = line[1];
            isDeleted = x === 'D' || y === 'D';
            pathPart = line.slice(3);
            if ((x === 'R' || x === 'C' || y === 'R' || y === 'C') && pathPart.includes(' -> ')) {
              pathPart = pathPart.split(' -> ').pop();
            }
          } else {
            continue;
          }

          const relPath = normalizeRelPath(pathPart);
          if (!relPath) continue;

          if (isDeleted) index.deletedFiles.add(relPath);
          else index.changedFiles.add(relPath);

          const slash = relPath.lastIndexOf('/');
          let dir = slash >= 0 ? relPath.slice(0, slash) : '';
          while (dir) {
            index.changedDirs.add(dir);
            const next = dir.lastIndexOf('/');
            dir = next >= 0 ? dir.slice(0, next) : '';
          }
        }
        return index;
      }

      function deletedChildrenForDir(index, dir, existingPaths) {
        if (!index?.deletedFiles || index.deletedFiles.size === 0) return [];
        const prefix = dir ? (dir + '/') : '';
        const results = [];
        for (const relPath of index.deletedFiles) {
          if (existingPaths && existingPaths.has(relPath)) continue;
          if (!relPath.startsWith(prefix)) continue;
          const rest = relPath.slice(prefix.length);
          if (!rest || rest.includes('/')) continue;
          results.push({ name: rest, type: 'deleted', path: relPath });
        }
        results.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        return results;
      }

      function byId(list, id, key = 'agentId') {
        if (!Array.isArray(list)) return null;
        return list.find(item => item && item[key] === id) ?? null;
      }

      function statusBadge(status) {
        const value = String(status ?? 'unknown');
        const cls = value === 'completed' || value === 'disposed'
          ? 'ok'
          : value === 'superseded'
            ? 'muted'
          : value === 'running' || value === 'pending' || value === 'disposing'
            ? 'warn'
            : value === 'failed' || value === 'blocked'
              ? 'bad'
              : '';
        return { value, cls };
      }

      function formatTokenDelta(delta) {
        if (!Number.isFinite(delta)) return '(+0)';
        if (delta === 0) return '(+0)';
        const sign = delta > 0 ? '+' : '';
        return '(' + sign + delta + ')';
      }

      function formatTokenSummary(tokens, cache, id) {
        if (!tokens || !id) return 'in - · cached - · out -';
        const key = String(id);
        const input = Number(tokens.input) || 0;
        const cached = Number(tokens.cachedInput) || 0;
        const output = Number(tokens.output) || 0;
        const prev = cache.get(key) ?? { input, cachedInput: cached, output };
        const deltaInput = input - (Number(prev.input) || 0);
        const deltaCached = cached - (Number(prev.cachedInput) || 0);
        const deltaOutput = output - (Number(prev.output) || 0);
        cache.set(key, { input, cachedInput: cached, output });
        return 'in ' + input + formatTokenDelta(deltaInput)
          + ' · cached ' + cached + formatTokenDelta(deltaCached)
          + ' · out ' + output + formatTokenDelta(deltaOutput);
      }

      function formatTokenIoSummary(tokens) {
        if (!tokens || typeof tokens !== 'object') return 'input - · output -';
        const input = Number(tokens.input) || 0;
        const output = Number(tokens.output) || 0;
        return 'input ' + input + ' · output ' + output;
      }

      function formatAgentModelLabel(agent) {
        if (!agent || typeof agent !== 'object') return '';
        const model = String(agent.lastModel ?? agent.model ?? '').trim();
        const effort = String(agent.lastEffort ?? agent.effort ?? '').trim();
        if (model && effort) return model + ' ' + effort;
        return model || effort;
      }

	      function escapeAttr(value) {
	        return String(value ?? '')
	          .replace(/&/g, '&amp;')
	          .replace(/"/g, '&quot;')
	          .replace(/</g, '&lt;')
	          .replace(/>/g, '&gt;');
	      }

      function statusColorForTask(status) {
        const normalized = String(status ?? '').trim().toLowerCase();
        if (normalized === 'running') return '#34d399';
        if (normalized === 'pending') return '#fbbf24';
        if (normalized === 'failed') return '#fb7185';
        if (normalized === 'blocked') return '#f97316';
        if (normalized === 'superseded') return '#94a3b8';
        if (normalized === 'completed') return '#38bdf8';
        return '#94a3b8';
      }

      function taskStatusSortWeight(status) {
        const normalized = String(status ?? '').trim().toLowerCase();
        if (normalized === 'running' || normalized === 'disposing') return 0;
        if (normalized === 'pending') return 1;
        if (normalized === 'blocked') return 2;
        if (normalized === 'failed') return 3;
        if (normalized === 'superseded') return 4;
        if (normalized === 'completed') return 5;
        return 6;
      }

      function taskPriorityValue(task) {
        const raw =
          task?.priority
          ?? task?.prio
          ?? task?.rank
          ?? task?.order
          ?? null;
        const parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed)) return parsed;
        const weight = taskStatusSortWeight(task?.status);
        if (weight < 5) return weight + 1;
        return 9;
      }

      function parsePositiveInt(value) {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) return null;
        return parsed;
      }

      function parseNonNegativeInt(value) {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed) || parsed < 0) return null;
        return parsed;
      }

      function resolveTaskDagColumns(run, taskCount) {
        const scheduler = run && typeof run.scheduler === 'object' ? run.scheduler : null;
        const counts = run && typeof run.counts === 'object' ? run.counts : null;
        const workers = Array.isArray(run?.workers) ? run.workers : [];
        const liveBusyCount = workers.filter(worker => worker && worker.inUse === true).length;

        const busyWorkers =
          parseNonNegativeInt(liveBusyCount)
          ?? parseNonNegativeInt(counts?.workerBusy)
          ?? parseNonNegativeInt(counts?.tasksRunning)
          ?? 0;

        const maxParallelism =
          parsePositiveInt(scheduler?.maxParallelism)
          ?? parsePositiveInt(counts?.parallelism)
          ?? parsePositiveInt(run?.parallelism)
          ?? parsePositiveInt(counts?.workerPoolSize)
          ?? parsePositiveInt(run?.workerPoolSize)
          ?? 1;

        const currentParallelism =
          parsePositiveInt(scheduler?.currentParallelism)
          ?? parsePositiveInt(counts?.parallelism)
          ?? maxParallelism;

        const rowMax = Math.max(1, Math.min(taskCount || 1, maxParallelism));
        const activeColumns = busyWorkers > 0
          ? Math.min(rowMax, busyWorkers)
          : Math.min(rowMax, currentParallelism);
        const columns = Math.max(1, Math.min(taskCount || 1, activeColumns));

        return {
          columns,
          rowMax,
          busyWorkers,
          currentParallelism,
          maxParallelism,
        };
      }

      function setTaskDagTitle(title) {
        if (!taskDagTitleEl) return;
        taskDagTitleEl.textContent = String(title ?? '').trim() || 'Target Task Table';
      }

      function ensureTaskDagTableEl() {
        if (!testTaskDagWrapEl) return null;
        let tableEl = document.getElementById('testTaskDagTable');
        if (!tableEl) {
          testTaskDagWrapEl.textContent = '';
          tableEl = document.createElement('table');
          tableEl.id = 'testTaskDagTable';
          tableEl.className = 'task-dag-table';
          tableEl.setAttribute('aria-label', 'Task table');
          testTaskDagWrapEl.appendChild(tableEl);
        }
        testTaskDagTableEl = tableEl;
        return tableEl;
      }

      function ensureTaskDagStdoutEl() {
        if (!testTaskDagWrapEl) return null;
        let outputEl = document.getElementById('testTaskDagStdout');
        if (!outputEl) {
          testTaskDagWrapEl.textContent = '';
          outputEl = document.createElement('pre');
          outputEl.id = 'testTaskDagStdout';
          testTaskDagWrapEl.appendChild(outputEl);
        }
        testTaskDagTableEl = document.getElementById('testTaskDagTable');
        return outputEl;
      }

      function taskDagEmptyState(message, colSpan) {
        setTaskDagTitle('Target Task Table');
        if (taskDagMetaEl) {
          taskDagMetaEl.textContent = message || 'No task data';
        }
        const tableEl = ensureTaskDagTableEl();
        if (!tableEl) return;
        tableEl.className = 'task-dag-table';
        tableEl.textContent = '';
        const body = document.createElement('tbody');
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = Math.max(1, Number.parseInt(colSpan, 10) || 1);
        cell.className = 'muted-cell';
        cell.textContent = message || 'No task data';
        row.appendChild(cell);
        body.appendChild(row);
        tableEl.appendChild(body);
      }

      function buildTaskDisplayLabel(task) {
        const targetLabel = clipInline(task?.targetLabel ?? '', 36);
        const itemLabel = clipInline(task?.itemLabel ?? '', 48);
        if (targetLabel && itemLabel) {
          return appendRecoverLabel(targetLabel + ' / ' + itemLabel, task?.recoverAttempt, 72);
        }
        if (itemLabel) return appendRecoverLabel(itemLabel, task?.recoverAttempt, 72);
        if (targetLabel) return appendRecoverLabel(targetLabel, task?.recoverAttempt, 72);
        return appendRecoverLabel(task?.description || task?.id || 'Task', task?.recoverAttempt, 72);
      }

      function buildTaskSecondaryLabel(task) {
        const parts = [];
        if (task?.cycle) parts.push('cycle ' + String(task.cycle));
        const folderLabel = pathLeafLabel(task?.worktreePath ?? '', 32);
        if (folderLabel) parts.push('folder: ' + folderLabel);
        const fallbackDescription = clipInline(task?.description ?? '', 56);
        const fallbackId = clipInline(task?.id ?? '', 48);
        const primary = buildTaskDisplayLabel(task);
        if (fallbackDescription && fallbackDescription !== primary) {
          parts.push(fallbackDescription);
        } else if (fallbackId && fallbackId !== primary) {
          parts.push(fallbackId);
        }
        return parts.join(' · ');
      }

      function buildTaskDependencyLine(task, taskMap) {
        const deps = Array.isArray(task?.dependsOn)
          ? task.dependsOn.map(dep => String(dep ?? '').trim()).filter(Boolean)
          : [];
        if (deps.length === 0) return 'Depends nothing';

        const resolveLabel = depId => {
          const depTask = taskMap && typeof taskMap.get === 'function'
            ? taskMap.get(depId)
            : null;
          if (depTask) return clipInline(buildTaskDisplayLabel(depTask), 44);
          return clipInline(depId, 44);
        };

        if (deps.length === 1) {
          return 'Depends ' + (resolveLabel(deps[0]) || '1 task');
        }

        const labels = deps.slice(0, 2).map(resolveLabel).filter(Boolean);
        if (deps.length > labels.length) {
          labels.push('+' + String(deps.length - labels.length) + ' more');
        }
        return 'Depends ' + (labels.join(', ') || (String(deps.length) + ' tasks'));
      }

      function buildTaskDependencyTooltip(task, taskMap) {
        const deps = Array.isArray(task?.dependsOn)
          ? task.dependsOn.map(dep => String(dep ?? '').trim()).filter(Boolean)
          : [];
        if (deps.length === 0) return '0 dependencies';

        const header = deps.length === 1 ? '1 dependency' : String(deps.length) + ' dependencies';
        const lines = deps.map(depId => {
          const depTask = taskMap && typeof taskMap.get === 'function'
            ? taskMap.get(depId)
            : null;
          const rawStatus = String(depTask?.status ?? 'unknown').trim().toLowerCase();
          const status = rawStatus === 'disposing'
            ? 'running'
            : (rawStatus || 'unknown');
          const label = depTask
            ? clipInline(buildTaskDisplayLabel(depTask), 72)
            : clipInline(depId, 72);
          return status + ' · ' + (label || depId);
        });
        return [header, ...lines].join('\\n');
      }

      function compareTaskSummaryRows(a, b) {
        const wa = taskStatusSortWeight(a?.status);
        const wb = taskStatusSortWeight(b?.status);
        if (wa !== wb) return wa - wb;
        const ta = activityTimestamp(a);
        const tb = activityTimestamp(b);
        if (ta !== tb) return tb - ta;
        if ((a?.level ?? 0) !== (b?.level ?? 0)) return (a?.level ?? 0) - (b?.level ?? 0);
        if ((a?.priority ?? 99) !== (b?.priority ?? 99)) return (a?.priority ?? 99) - (b?.priority ?? 99);
        if ((a?.targetLabel ?? '') !== (b?.targetLabel ?? '')) return (a?.targetLabel ?? '').localeCompare(b?.targetLabel ?? '');
        if ((a?.itemLabel ?? '') !== (b?.itemLabel ?? '')) return (a?.itemLabel ?? '').localeCompare(b?.itemLabel ?? '');
        return String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
      }

      function formatTaskUpdatedText(task) {
        const lastActivityAt = Number.isFinite(task?.lastActivityAt)
          ? task.lastActivityAt
          : Number(task?.lastActivityAt);
        if (Number.isFinite(lastActivityAt) && lastActivityAt > 0) {
          return 'Last updated ' + formatAgo(lastActivityAt);
        }
        return 'Last updated -';
      }

      function formatChecklistProgressText(cellData, agent) {
        const status = String(cellData?.status ?? 'pending').trim().toLowerCase();
        const summary = clipInline(
          cellData?.summaryText
            ?? cellData?.lastActivity
            ?? agent?.summaryTextDelta
            ?? agent?.lastActivity
            ?? '',
          72,
        );
        if (status === 'pending') {
          return cellData?.taskId ? 'Queued for the assigned task agent' : 'Not started';
        }
        if (status === 'running') {
          return summary || 'Task agent is actively working on this goal';
        }
        if (status === 'completed') {
          return summary || 'Completed';
        }
        if (status === 'superseded') {
          return clipInline(cellData?.error ?? summary ?? '', 88) || 'Superseded by recovery work';
        }
        if (status === 'failed' || status === 'blocked') {
          return clipInline(cellData?.error ?? summary ?? '', 88) || 'Needs attention';
        }
        return summary || '-';
      }

      function formatTaskActivityLabel(kind) {
        const normalized = String(kind ?? '').trim().toLowerCase();
        if (!normalized) return null;
        if (normalized === 'ratelimit') return 'rate-limit';
        if (normalized === 'commandexec') return 'command';
        if (normalized === 'reasoning') return 'reasoning';
        if (normalized === 'tool') return 'tool';
        if (normalized === 'file') return 'file';
        return null;
      }

      function hasRecentSchedulerRateLimit(run) {
        const scheduler = run && typeof run.scheduler === 'object' ? run.scheduler : null;
        const hits = Number.parseInt(scheduler?.rateLimitHits, 10);
        if (!Number.isFinite(hits) || hits <= 0) return false;
        const lastAt = Number(scheduler?.rateLimitLastAt ?? 0);
        if (!Number.isFinite(lastAt) || lastAt <= 0) return true;
        const windowMs = Number.parseInt(scheduler?.rateLimitWindowMs, 10);
        const recencyMs = Number.isFinite(windowMs) && windowMs > 0
          ? Math.min(Math.max(windowMs, 15_000), 5 * 60 * 1000)
          : 60_000;
        return Date.now() - lastAt <= recencyMs;
      }

      function taskStatusPills(task, run) {
        const status = String(task?.status ?? '').trim().toLowerCase();
        const pills = [];
        const seen = new Set();
        const add = (text, cls = '') => {
          const label = String(text ?? '').trim();
          if (!label || seen.has(label)) return;
          seen.add(label);
          pills.push({ text: label, cls });
        };
        if (status !== 'running') return pills;

        const activityLabel = formatTaskActivityLabel(deriveTaskActivityKind(task));
        if (activityLabel) {
          add(activityLabel, activityLabel === 'rate-limit' ? 'warn' : '');
        }

        const scheduler = run && typeof run.scheduler === 'object' ? run.scheduler : null;
        if (scheduler?.backpressureActive) {
          const reason = String(scheduler.backpressureReason ?? '').trim().toLowerCase();
          if (reason === 'rate-limit') add('rate-limit', 'warn');
          else add('backpressure', 'warn');
        } else if (hasRecentSchedulerRateLimit(run)) {
          add('rate-limit', 'warn');
        }

        return pills;
      }

      function normalizeOutputText(value) {
        return String(value ?? '').replace(/\\r/g, '').trimEnd();
      }

      function taskOutputViewModel(task) {
        const stdoutText = normalizeOutputText(task?.stdoutText ?? '');
        if (stdoutText.trim()) {
          return { text: stdoutText, placeholder: false };
        }

        const status = String(task?.status ?? 'pending').trim().toLowerCase();
        if (status === 'running') {
          const fallback = clipInline(task?.summaryText ?? task?.lastActivity ?? '', 180);
          return {
            text: fallback || 'Waiting for live output...',
            placeholder: true,
          };
        }
        if (status === 'pending') {
          return { text: 'Queued. Waiting for worker output...', placeholder: true };
        }
        if (status === 'superseded') {
          return {
            text: clipInline(task?.error ?? task?.lastActivity ?? '', 180) || 'Superseded by recovery work.',
            placeholder: true,
          };
        }
        if (status === 'failed' || status === 'blocked') {
          return {
            text: clipInline(task?.error ?? task?.lastActivity ?? '', 180) || 'No recent output.',
            placeholder: true,
          };
        }
        return {
          text: clipInline(task?.summaryText ?? task?.lastActivity ?? '', 180) || 'No recent output.',
          placeholder: true,
        };
      }

      function buildPreTaskPhaseView(run) {
        const scoutAgent = pickAgentByKind(run?.agents ?? [], 'scout');
        const plannerAgent = pickAgentByKind(run?.agents ?? [], 'planner');
        const kind = scoutAgent ? 'scout' : (plannerAgent ? 'planner' : '');
        if (!kind) return null;

        const agent = kind === 'scout' ? scoutAgent : plannerAgent;
        const stdoutText = normalizeOutputText(
          kind === 'scout'
            ? (run?.scoutStdoutText ?? '')
            : (run?.plannerStdoutText ?? ''),
        );
        const lineCount = Number.parseInt(
          kind === 'scout'
            ? run?.scoutStdoutLineCount
            : run?.plannerStdoutLineCount,
          10,
        ) || 0;
        const plannedTaskCount = Number.parseInt(run?.plannedTaskCount, 10) || 0;
        const parallelism = Number.parseInt(run?.counts?.parallelism, 10) || 0;
        const plannerPlanText = String(run?.plannerPlanText ?? '').trim();

        let text = stdoutText;
        let placeholder = false;
        if (!text && kind === 'planner') {
          if (plannerPlanText && plannerPlanText !== 'planner-skipped') {
            text = plannerPlanText;
          } else if (plannerPlanText === 'planner-skipped') {
            text = 'Planner step skipped; tasks will execute directly.';
          }
        }
        if (!text) {
          text = 'Waiting for ' + kind + ' output...';
          placeholder = true;
        }

        const meta = ['No target tasks yet'];
        if (agent?.agentId) meta.push('agent: ' + String(agent.agentId));
        if (lineCount > 0) meta.push(kind + ' output lines: ' + String(lineCount));
        if (kind === 'planner' && plannedTaskCount > 0) {
          meta.push('planned tasks: ' + String(plannedTaskCount));
        }
        if (kind === 'planner' && parallelism > 0) {
          meta.push('parallelism: ' + String(parallelism));
        }

        return {
          kind,
          status: String(agent?.status ?? 'pending').trim().toLowerCase() || 'pending',
          title: kind === 'scout' ? 'Scout Stdout' : 'Planner Stdout',
          meta: meta.join(' · '),
          text,
          placeholder,
        };
      }

      function renderPreTaskStdout(view) {
        const outputEl = ensureTaskDagStdoutEl();
        if (!outputEl) return;
        setTaskDagTitle(view?.title ?? 'Target Task Table');
        if (taskDagMetaEl) {
          taskDagMetaEl.textContent = String(view?.meta ?? '').trim() || 'No target tasks yet';
        }
        outputEl.className = view?.placeholder ? 'task-phase-output placeholder' : 'task-phase-output';
        outputEl.textContent = String(view?.text ?? '').trimEnd();
      }

      function renderChecklistTaskMatrix(run, checklist) {
        setTaskDagTitle('Target Task Table');
        const tableEl = ensureTaskDagTableEl();
        if (!tableEl) return;
        const columns = Array.isArray(checklist?.columns) ? checklist.columns : [];
        const rows = Array.isArray(checklist?.rows) ? checklist.rows : [];
        const counts = checklist?.counts ?? {};
        const agents = Array.isArray(run?.agents) ? run.agents : [];
        if (rows.length === 0 || columns.length === 0) {
          taskDagEmptyState('Checklist mode is active, but there are no visible rows yet.', Math.max(1, columns.length + 1));
          return;
        }

        const maxCycles = Number.isFinite(checklist?.maxCycles) ? checklist.maxCycles : 'unbounded';
        if (taskDagMetaEl) {
          taskDagMetaEl.textContent =
            'targets: ' + rows.length
            + ' · items: ' + columns.length
            + ' · running: ' + (counts.running ?? 0)
            + ' · done: ' + (counts.completed ?? 0)
            + ' · failed: ' + (counts.failed ?? 0)
            + ' · blocked: ' + (counts.blocked ?? 0)
            + ' · continuous: ' + (checklist?.continuous === true ? 'on' : 'off')
            + ' · max cycles: ' + maxCycles;
        }

        tableEl.className = 'task-dag-table task-checklist-table';
        tableEl.textContent = '';

        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        const targetHead = document.createElement('th');
        targetHead.scope = 'col';
        targetHead.className = 'checklist-target-col';
        targetHead.textContent = 'Target';
        headRow.appendChild(targetHead);

        const statusHead = document.createElement('th');
        statusHead.scope = 'col';
        statusHead.className = 'checklist-status-col';
        statusHead.textContent = 'Status';
        headRow.appendChild(statusHead);

        const progressHead = document.createElement('th');
        progressHead.scope = 'col';
        progressHead.textContent = 'Progress';
        headRow.appendChild(progressHead);

        const updatedHead = document.createElement('th');
        updatedHead.scope = 'col';
        updatedHead.className = 'checklist-updated-col';
        updatedHead.textContent = 'Last updated';
        headRow.appendChild(updatedHead);
        thead.appendChild(headRow);
        tableEl.appendChild(thead);

        const tbody = document.createElement('tbody');
        for (const rowData of rows) {
          const cellRows = Array.isArray(rowData?.cells) && rowData.cells.length > 0
            ? rowData.cells
            : [{ itemId: 'pending', itemLabel: 'Checklist item', status: 'pending' }];

          for (const cellData of cellRows) {
            const status = String(cellData?.status ?? 'pending').trim() || 'pending';
            const statusInfo = statusBadge(status);
            const row = document.createElement('tr');
            const taskId = String(cellData?.taskId ?? '').trim();
            const resolvedAgentId = String(cellData?.agentId ?? '').trim() || (taskId ? resolveTaskAgentId(taskId) : '');
            const agent = resolvedAgentId ? byId(agents, resolvedAgentId, 'agentId') : null;
            if (taskId) {
              row.setAttribute('data-task', taskId);
            }
            row.title = [
              String(rowData?.label ?? rowData?.targetId ?? '').trim(),
              String(cellData?.itemLabel ?? cellData?.itemId ?? '').trim(),
              composeStatusTag(status, cellData?.lastActivityKind ?? null),
              formatChecklistProgressText(cellData, agent),
            ].filter(Boolean).join(' · ');

            const targetCell = document.createElement('td');
            targetCell.className = 'checklist-target-cell';
            const targetShell = document.createElement('div');
            targetShell.className = 'checklist-target-shell';
            const targetTitle = document.createElement('div');
            targetTitle.className = 'checklist-target-title';
            targetTitle.textContent = clipInline(rowData?.label ?? rowData?.targetId ?? '', 48) || 'Target';
            targetShell.appendChild(targetTitle);
            const targetJob = document.createElement('div');
            targetJob.className = 'checklist-target-job';
            targetJob.textContent = clipInline(cellData?.itemLabel ?? cellData?.itemId ?? '', 48) || 'Checklist item';
            targetShell.appendChild(targetJob);
            targetCell.appendChild(targetShell);
            row.appendChild(targetCell);

            const statusCell = document.createElement('td');
            statusCell.className = 'checklist-status-cell';
            const statusShell = document.createElement('div');
            statusShell.className = 'checklist-status-shell';
            const badge = document.createElement('span');
            badge.className = ('badge ' + statusInfo.cls).trim();
            badge.textContent = composeStatusTag(status, null);
            statusShell.appendChild(badge);
            if (status === 'running') {
              const spinner = document.createElement('span');
              spinner.className = 'icon spin matrix-running';
              spinner.textContent = iconGlyph('loading');
              statusShell.appendChild(spinner);
            }
            statusCell.appendChild(statusShell);
            row.appendChild(statusCell);

            const progressCell = document.createElement('td');
            const progress = document.createElement('div');
            progress.className = (status === 'failed' || status === 'blocked')
              ? 'checklist-progress-text alert'
              : 'checklist-progress-text';
            progress.textContent = formatChecklistProgressText(cellData, agent);
            progressCell.appendChild(progress);
            row.appendChild(progressCell);

            const updatedCell = document.createElement('td');
            const updated = document.createElement('div');
            updated.className = 'checklist-updated-text';
            updated.textContent = Number.isFinite(cellData?.lastActivityAt)
              ? formatAgo(cellData.lastActivityAt)
              : 'waiting';
            updatedCell.appendChild(updated);
            row.appendChild(updatedCell);

            tbody.appendChild(row);
          }
        }

        tableEl.appendChild(tbody);
      }

      function renderGenericTaskSummary(run, normalizedTasks, options = {}) {
        setTaskDagTitle('Target Task Table');
        const tableEl = ensureTaskDagTableEl();
        if (!tableEl) return;
        const byId = new Map(normalizedTasks.map(task => [task.id, task]));
        const levels = new Map();
        const visiting = new Set();
        const resolveLevel = id => {
          if (levels.has(id)) return levels.get(id) ?? 0;
          if (visiting.has(id)) return 0;
          visiting.add(id);
          const task = byId.get(id);
          let level = 0;
          if (task) {
            for (const dep of task.dependsOn) {
              if (!byId.has(dep)) continue;
              level = Math.max(level, resolveLevel(dep) + 1);
            }
          }
          visiting.delete(id);
          levels.set(id, level);
          return level;
        };

        for (const task of normalizedTasks) {
          task.level = resolveLevel(task.id);
        }

        normalizedTasks.sort(compareTaskSummaryRows);

        const rootCount = normalizedTasks.filter(task => task.dependsOn.length === 0).length;
        const maxLevel = normalizedTasks.reduce((max, task) => Math.max(max, task.level ?? 0), 0);
        const layout = resolveTaskDagColumns(run, normalizedTasks.length);
        const customMetaText = String(options?.metaText ?? '').trim();
        if (taskDagMetaEl) {
          taskDagMetaEl.textContent = customMetaText || (
            'tasks: ' + normalizedTasks.length
            + ' · roots: ' + rootCount
            + ' · levels: ' + (maxLevel + 1)
            + ' · active workers: ' + layout.busyWorkers
            + ' · scheduler: ' + layout.currentParallelism
            + ' · max: ' + layout.maxParallelism
          );
        }

        tableEl.className = 'task-dag-table task-summary-table';
        tableEl.textContent = '';

        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        for (const label of ['Task', 'Status']) {
          const th = document.createElement('th');
          th.scope = 'col';
          th.textContent = label;
          headRow.appendChild(th);
        }
        thead.appendChild(headRow);
        tableEl.appendChild(thead);

        const tbody = document.createElement('tbody');
        for (const task of normalizedTasks) {
          const displayLabel = buildTaskDisplayLabel(task);
          const secondary = buildTaskSecondaryLabel(task);
          const dependencyLine = buildTaskDependencyLine(task, byId);
          const dependencyTooltip = buildTaskDependencyTooltip(task, byId);
          const row = document.createElement('tr');
          row.className = 'summary-primary-row';

          const taskCell = document.createElement('td');
          taskCell.className = 'task-col';
          taskCell.title = [
            displayLabel,
            secondary,
            dependencyTooltip,
            task.id,
          ].filter(Boolean).join('\\n') || task.id;

          const main = document.createElement('div');
          main.className = 'summary-main';
          main.textContent = displayLabel;
          taskCell.appendChild(main);

          if (secondary) {
            const sub = document.createElement('div');
            sub.className = 'summary-sub';
            sub.textContent = secondary;
            taskCell.appendChild(sub);
          }
          const dependency = document.createElement('div');
          dependency.className = 'summary-sub summary-dependency';
          dependency.textContent = dependencyLine;
          dependency.title = dependencyTooltip;
          taskCell.appendChild(dependency);
          row.appendChild(taskCell);

          const statusCell = document.createElement('td');
          statusCell.className = 'status-col';
          const badgeInfo = statusBadge(task.status);
          const statusStack = document.createElement('div');
          statusStack.className = 'summary-status-stack';
          const badgeRow = document.createElement('div');
          badgeRow.className = 'summary-status-row';
          const badge = document.createElement('span');
          badge.className = ('badge ' + badgeInfo.cls).trim();
          badge.textContent = composeStatusTag(task.status, task.kind ?? null);
          badgeRow.appendChild(badge);
          if (task.status === 'running') {
            const spinner = document.createElement('span');
            spinner.className = 'icon spin matrix-running';
            spinner.textContent = iconGlyph('loading');
            badgeRow.appendChild(spinner);
          }
          statusStack.appendChild(badgeRow);

          const pills = taskStatusPills(task, run);
          if (pills.length > 0) {
            const pillRow = document.createElement('div');
            pillRow.className = 'summary-status-pills';
            for (const pill of pills) {
              const extra = document.createElement('span');
              extra.className = ('badge ' + pill.cls).trim();
              extra.textContent = pill.text;
              pillRow.appendChild(extra);
            }
            statusStack.appendChild(pillRow);
          }

          const updated = document.createElement('div');
          updated.className = 'summary-status-updated';
          updated.textContent = formatTaskUpdatedText(task);
          if (!task.lastActivityAt) updated.classList.add('muted-cell');
          statusStack.appendChild(updated);

          statusCell.appendChild(statusStack);
          row.appendChild(statusCell);
          tbody.appendChild(row);

          const outputRow = document.createElement('tr');
          outputRow.className = 'summary-output-row';
          const outputCell = document.createElement('td');
          outputCell.className = 'summary-output-cell';
          outputCell.colSpan = 2;
          const outputView = taskOutputViewModel(task);
          const output = document.createElement('pre');
          output.className = outputView.placeholder
            ? 'summary-output-box placeholder'
            : 'summary-output-box';
          output.setAttribute('data-task-output-id', task.id);
          output.textContent = outputView.text;
          outputCell.appendChild(output);
          outputRow.appendChild(outputCell);
          tbody.appendChild(outputRow);
        }

        tableEl.appendChild(tbody);
      }

      function renderTaskDagTable(run) {
        if (!testTaskDagWrapEl) return;

        const tasks = Array.isArray(run?.tasks) ? run.tasks : [];
        const normalizedTasks = tasks
          .map(task => {
            const id = String(task?.taskId ?? task?.id ?? '').trim();
            const checklist = task?.checklist && typeof task.checklist === 'object'
              ? task.checklist
              : null;
            return {
              id,
              kind: null,
              status: String(task?.status ?? 'unknown').trim() || 'unknown',
              dependsOn: Array.isArray(task?.dependsOn)
                ? task.dependsOn.map(dep => String(dep ?? '').trim()).filter(Boolean)
                : [],
              priority: taskPriorityValue(task),
              description: clipInline(task?.description ?? '', 180),
              targetLabel: clipInline(checklist?.targetLabel ?? '', 48),
              itemLabel: clipInline(checklist?.itemLabel ?? '', 72),
              recoverAttempt: Number.parseInt(task?.retryAttempt, 10) || null,
              worktreePath: task?.worktreePath ?? '',
              cycle: Number.parseInt(checklist?.cycle, 10) || null,
              stdoutText: normalizeOutputText(task?.stdoutText ?? ''),
              summaryText: clipInline(task?.summaryTextDelta ?? '', 220),
              error: clipInline(task?.error ?? '', 180),
              lastActivity: clipInline(task?.lastActivity ?? '', 180),
              lastActivityKind: String(task?.lastActivityKind ?? '').trim().toLowerCase() || null,
              lastActivityAt: Number.isFinite(Number(task?.lastActivityAt)) ? Number(task.lastActivityAt) : null,
            };
          })
          .filter(task => task.id);

        if (normalizedTasks.length === 0) {
          const preTaskPhaseView = buildPreTaskPhaseView(run);
          if (preTaskPhaseView) {
            renderPreTaskStdout(preTaskPhaseView);
            return;
          }
          taskDagEmptyState('No task data', 2);
          return;
        }

        const checklist = run?.checklist && typeof run.checklist === 'object'
          ? run.checklist
          : null;
        if (checklist?.mode === 'checklist') {
          renderChecklistTaskMatrix(run, checklist);
          return;
        }

        renderGenericTaskSummary(run, normalizedTasks);
      }

      function buildGitTreeAscii(paths, { maxLines = 1200 } = {}) {
        const list = Array.isArray(paths) ? paths.map(p => String(p ?? '').trim()).filter(Boolean) : [];
        list.sort((a, b) => a.localeCompare(b));
        if (list.length === 0) return '(empty)';

        const lines = [];
        const root = { children: new Map(), file: false };
        for (const filePath of list) {
          const parts = filePath.split('/').filter(Boolean);
          let node = root;
          for (let i = 0; i < parts.length; i += 1) {
            const part = parts[i];
            if (!node.children.has(part)) {
              node.children.set(part, { children: new Map(), file: false });
            }
            node = node.children.get(part);
            if (i === parts.length - 1) node.file = true;
          }
        }

        const walk = (node, prefix) => {
          const entries = [...node.children.entries()].sort((a, b) => {
            const aDir = a[1].children.size > 0 && !a[1].file;
            const bDir = b[1].children.size > 0 && !b[1].file;
            if (aDir !== bDir) return aDir ? -1 : 1;
            return a[0].localeCompare(b[0]);
          });
          for (let i = 0; i < entries.length; i += 1) {
            if (lines.length >= maxLines) return;
            const [name, child] = entries[i];
            const last = i === entries.length - 1;
            const hasChildren = child.children.size > 0;
            const isDir = hasChildren && !child.file;
            lines.push(prefix + (last ? '└─ ' : '├─ ') + name + (isDir ? '/' : ''));
            if (hasChildren) {
              walk(child, prefix + (last ? '   ' : '│  '));
            }
          }
        };

        walk(root, '');
        if (lines.length >= maxLines && list.length > maxLines) {
          lines.push('... (' + String(list.length - maxLines) + ' more files)');
        }
        return lines.join('\\n');
      }

      async function refreshTestGitTree() {
        refreshDagCardElements();
        if (!testGitTreeEl) return;
        const runId = state?.activeRun?.id ?? selectedRunId ?? '';
        if (!runId) {
          testGitTreeEl.textContent = 'No active run';
          return;
        }
        if (testGitTreeRunId === runId && testGitTreeEl.textContent && !testGitTreeEl.textContent.startsWith('Loading')) {
          return;
        }
        testGitTreeEl.textContent = 'Loading git tree...';
        try {
          const prefix = selectedRunId ? ('runId=' + encodeURIComponent(selectedRunId) + '&') : '';
          const data = await fetchJson('/api/git-tree?' + prefix + 'max=4000');
          const treeText = buildGitTreeAscii(data?.paths ?? [], { maxLines: 1400 });
          const title = [
            'repo: ' + String(data?.repoRoot ?? '-'),
            'ref: ' + String(data?.ref ?? '-'),
            'files: ' + String(data?.total ?? 0) + (data?.truncated ? ' (truncated)' : ''),
            '',
          ].join('\\n');
          testGitTreeEl.textContent = title + treeText;
          testGitTreeRunId = runId;
        } catch (err) {
          testGitTreeEl.textContent = 'Failed to load git tree: ' + String(err?.message ?? err ?? 'unknown error');
        }
      }

      function refreshTestTaskDag() {
        const scrollState = captureTaskDagScrollState();
        renderTaskDagTable(state?.activeRun ?? null);
        restoreTaskDagScrollState(scrollState);
      }

      function ensureWatchdogTurnBrowser() {
        if (!cardHero) return;
        const body = cardHero.querySelector('.card-body');
        if (!body) return;

        let browser = document.getElementById('watchdogTurnBrowser');
        if (!browser) {
          browser = document.createElement('div');
          browser.id = 'watchdogTurnBrowser';
          browser.hidden = true;
          const tabs = document.createElement('div');
          tabs.id = 'watchdogTurnTabs';
          const panel = document.createElement('pre');
          panel.id = 'watchdogTurnPanel';
          panel.className = 'mono';
          browser.appendChild(tabs);
          browser.appendChild(panel);
          const meta = body.querySelector('#cardHeroMeta');
          if (meta) body.insertBefore(browser, meta);
          else body.prepend(browser);
        }

        if (!watchdogTurnTabsEl) {
          watchdogTurnTabsEl = document.getElementById('watchdogTurnTabs');
        }
        if (!watchdogTurnPanelEl) {
          watchdogTurnPanelEl = document.getElementById('watchdogTurnPanel');
        }
      }

      function setWatchdogTurnBrowserVisible(visible) {
        ensureWatchdogTurnBrowser();
        const browser = document.getElementById('watchdogTurnBrowser');
        if (!browser) return;
        browser.hidden = !visible;
        if (cardHero) {
          cardHero.classList.toggle('watchdog-turns-active', visible);
        }
      }

      function setWatchdogTurnMessage(message, { visible = true } = {}) {
        ensureWatchdogTurnBrowser();
        if (!watchdogTurnTabsEl || !watchdogTurnPanelEl) return;
        setWatchdogTurnBrowserVisible(visible);
        watchdogTurnTabs = [];
        watchdogActiveTurn = null;
        watchdogTurnTabsEl.innerHTML = '';
        watchdogTurnPanelEl.textContent = message;
      }

      function buildWatchdogTurnTabItems(tabs, activeIndex) {
        const list = Array.isArray(tabs)
          ? tabs.filter(tab => Number.isFinite(Number(tab?.index)))
          : [];
        if (list.length === 0) return [];
        if (list.length <= 6) {
          return list.map(tab => ({
            type: 'tab',
            index: tab.index,
            active: tab.index === activeIndex,
          }));
        }

        const positions = new Set();
        for (let index = 0; index < Math.min(2, list.length); index += 1) {
          positions.add(index);
        }
        for (let index = Math.max(0, list.length - 3); index < list.length; index += 1) {
          positions.add(index);
        }

        const activePosition = list.findIndex(tab => tab.index === activeIndex);
        if (activePosition >= 0) {
          positions.add(activePosition);
          if (activePosition > 0) positions.add(activePosition - 1);
          if (activePosition + 1 < list.length) positions.add(activePosition + 1);
        }

        const items = [];
        let previousPosition = null;
        for (const position of [...positions].sort((a, b) => a - b)) {
          if (previousPosition !== null && (position - previousPosition) > 1) {
            items.push({ type: 'ellipsis' });
          }
          const tab = list[position];
          items.push({
            type: 'tab',
            index: tab.index,
            active: tab.index === activeIndex,
          });
          previousPosition = position;
        }
        return items;
      }

      function renderWatchdogTurnTabs() {
        ensureWatchdogTurnBrowser();
        if (!watchdogTurnTabsEl || !watchdogTurnPanelEl) return;
        if (!Array.isArray(watchdogTurnTabs) || watchdogTurnTabs.length === 0) {
          setWatchdogTurnBrowserVisible(false);
          watchdogTurnTabsEl.innerHTML = '';
          watchdogTurnPanelEl.textContent = 'No watchdog turn logs yet';
          return;
        }

        setWatchdogTurnBrowserVisible(true);

        if (!Number.isFinite(watchdogActiveTurn)) {
          watchdogActiveTurn = watchdogTurnTabs[watchdogTurnTabs.length - 1].index;
        }
        const hasActive = watchdogTurnTabs.some(tab => tab.index === watchdogActiveTurn);
        if (!hasActive) {
          watchdogActiveTurn = watchdogTurnTabs[watchdogTurnTabs.length - 1].index;
        }

        const activeIndex = watchdogActiveTurn;
        watchdogTurnTabsEl.innerHTML = buildWatchdogTurnTabItems(watchdogTurnTabs, activeIndex)
          .map(item => {
            if (item.type === 'ellipsis') {
              return '<span class="watchdog-turn-gap" aria-hidden="true">...</span>';
            }
            return '<button class="watchdog-turn-tab' + (item.active ? ' active' : '') + '" data-turn="' + item.index + '">' + item.index + '</button>';
          })
          .join('');

        const activeButton = watchdogTurnTabsEl.querySelector('.watchdog-turn-tab.active');
        activeButton?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });

        const activeTab = watchdogTurnTabs.find(tab => tab.index === activeIndex) ?? watchdogTurnTabs[watchdogTurnTabs.length - 1];
        watchdogTurnPanelEl.textContent = activeTab?.text ? activeTab.text : '(no logs in this turn)';
      }

      function formatWatchdogLogEntries(entries) {
        const raw = Array.isArray(entries) ? entries : [];
        if (raw.length === 0) return '';

        const lines = [];
        let streamTail = '';
        let streamTimestamp = '';

        const pushLine = (text, timestamp = '') => {
          const prefix = timestamp ? ('[' + timestamp + '] ') : '';
          lines.push(prefix + text);
        };

        const flushStreamTail = () => {
          if (!streamTail) return;
          pushLine(streamTail, streamTimestamp);
          streamTail = '';
          streamTimestamp = '';
        };

        const appendStreamText = (text, timestamp) => {
          if (!streamTimestamp) {
            streamTimestamp = timestamp;
          }
          let combined = streamTail ? (streamTail + text) : text;
          if (streamTail && text.startsWith(streamTail)) {
            combined = text;
          }
          const parts = combined.split('\\n');
          streamTail = parts.pop() ?? '';
          for (const part of parts) {
            pushLine(part, streamTimestamp || timestamp);
            streamTimestamp = timestamp || streamTimestamp;
          }
          if (!streamTail) {
            streamTimestamp = '';
          }
        };

        for (const entry of raw) {
          const text = String(entry?.text ?? '').replace(/\\r/g, '');
          const timestamp = typeof entry?.ts === 'string' ? entry.ts : '';
          const isStream = entry?.stream === true;
          if (isStream) {
            if (!text) continue;
            appendStreamText(text, timestamp);
            continue;
          }

          flushStreamTail();
          const parts = text.split('\\n');
          for (const part of parts) {
            pushLine(part, timestamp);
          }
        }

        flushStreamTail();
        return lines.join('\\n');
      }

      function buildWatchdogTurnTabs(completedTurns, logs, watchdogStatus) {
        const safeTurns = Array.isArray(completedTurns)
          ? completedTurns
            .map(item => ({
              index: Number.parseInt(item?.index, 10) || 0,
              endedLogId: Number.parseInt(item?.endedLogId, 10) || 0,
              text: String(item?.text ?? '').replace(/\\r/g, ''),
              live: item?.live === true,
            }))
            .filter(item => item.index > 0)
            .sort((a, b) => a.index - b.index)
          : [];

        const logItems = Array.isArray(logs)
          ? logs
            .map(item => ({
              id: Number(item?.id) || 0,
              ts: typeof item?.ts === 'string' ? item.ts : '',
              text: String(item?.text ?? '').replace(/\\r/g, ''),
              stream: item?.stream === true,
            }))
            .filter(item => item.id > 0)
            .sort((a, b) => a.id - b.id)
          : [];

        const tabs = [];
        let previousEndedLogId = 0;
        for (const turn of safeTurns) {
          const turnEntries = logItems.filter(log => log.id > previousEndedLogId && log.id <= turn.endedLogId);
          const turnText = turnEntries.length > 0
            ? formatWatchdogLogEntries(turnEntries)
            : turn.text;
          tabs.push({
            index: turn.index,
            text: turnText,
            live: turn.live === true,
          });
          previousEndedLogId = Math.max(previousEndedLogId, turn.endedLogId);
        }

        const lastCompletedLogId = safeTurns.length > 0
          ? safeTurns[safeTurns.length - 1].endedLogId
          : 0;
        const tailText = formatWatchdogLogEntries(logItems.filter(log => log.id > lastCompletedLogId));
        const normalizedStatus = String(watchdogStatus ?? '').trim().toLowerCase();
        const watchdogActive = normalizedStatus === 'running' || normalizedStatus === 'disposing';
        const hasLiveTab = tabs.some(tab => tab.live === true);
        if (tailText || (watchdogActive && !hasLiveTab) || tabs.length === 0) {
          tabs.push({
            index: tabs.length + 1,
            text: tailText,
            live: watchdogActive && !hasLiveTab,
          });
        }

        return tabs;
      }

      async function refreshWatchdogTurns(force = false) {
        ensureWatchdogTurnBrowser();
        if (!watchdogTurnTabsEl || !watchdogTurnPanelEl) return;

        const run = state?.activeRun ?? null;
        if (!run) {
          setWatchdogTurnMessage('No active run', { visible: false });
          return;
        }
        const watchdogAgent = pickAgentByKind(run?.agents ?? [], 'watchdog');
        if (!watchdogAgent?.agentId) {
          setWatchdogTurnMessage('No watchdog agent in active run', { visible: false });
          return;
        }

        const runId = String(run?.id ?? selectedRunId ?? '').trim();
        if (!runId) {
          setWatchdogTurnMessage('No active run id', { visible: false });
          return;
        }
        const runKey = runId + '|' + String(watchdogAgent.agentId);
        const completedTurns = Array.isArray(run?.watchdogTurns) ? run.watchdogTurns : [];
        const lastCompletedTurnEventId = completedTurns.length > 0
          ? (Number(completedTurns[completedTurns.length - 1]?.eventId) || completedTurns.length)
          : 0;
        const now = Date.now();
        if (!force) {
          if (watchdogTurnsInFlight) return;
          if (
            watchdogTurnsLastRunKey === runKey
            && (now - watchdogTurnsLastFetchAt) < WATCHDOG_TURNS_REFRESH_MIN_MS
          ) {
            if (Array.isArray(watchdogTurnTabs) && watchdogTurnTabs.length > 0) {
              watchdogActiveTurn = watchdogTurnTabs[watchdogTurnTabs.length - 1].index;
              renderWatchdogTurnTabs();
            }
            return;
          }
        }
        const prevRunKey = watchdogTurnsLastRunKey;
        const prevEventId = watchdogTurnsLastEventId;
        const prevLogId = watchdogTurnsLastLogId;
        watchdogTurnsInFlight = true;
        watchdogTurnsLastRunKey = runKey;
        watchdogTurnsLastFetchAt = now;

        try {
          const prefix = 'runId=' + encodeURIComponent(runId) + '&';
          const logData = await fetchJson(
            '/api/logs?' + prefix + 'agentId=' + encodeURIComponent(String(watchdogAgent.agentId)) + '&after=0&timeoutMs=0&limit=2000',
          );
          const lastEventId = lastCompletedTurnEventId;
          const lastLogId = Number(logData?.lastLogId) || 0;
          const changed =
            force
            || runKey !== prevRunKey
            || lastEventId !== prevEventId
            || lastLogId !== prevLogId;
          if (!changed) {
            if (Array.isArray(watchdogTurnTabs) && watchdogTurnTabs.length > 0) {
              watchdogActiveTurn = watchdogTurnTabs[watchdogTurnTabs.length - 1].index;
              renderWatchdogTurnTabs();
            }
            return;
          }

          watchdogTurnsLastEventId = lastEventId;
          watchdogTurnsLastLogId = lastLogId;

          const turns = buildWatchdogTurnTabs(
            completedTurns,
            logData?.items ?? [],
            watchdogAgent.status,
          );
          if (!Array.isArray(turns) || turns.length === 0) {
            setWatchdogTurnMessage('No watchdog turn logs yet');
            return;
          }

          watchdogTurnTabs = turns;
          watchdogActiveTurn = turns[turns.length - 1].index;
          renderWatchdogTurnTabs();
        } catch (err) {
          setWatchdogTurnMessage('Failed to load watchdog turns: ' + String(err?.message ?? err ?? 'unknown error'));
        } finally {
          watchdogTurnsInFlight = false;
        }
      }

      function composeStatusTag(status, kind) {
        const base = status === 'disposing' ? 'running' : String(status ?? 'unknown');
        if (kind) return base + '·' + kind;
        return base;
      }

      function deriveAgentKind(agent) {
        const phase = String(agent?.phase ?? '').toLowerCase();
        const agentId = String(agent?.agentId ?? '').toLowerCase();
        if (phase.includes('plan') || agentId.includes('planner')) return 'planner';
        if (phase.includes('scout') || agentId.includes('scout')) return 'scout';
        if (phase.includes('runner') || agentId === 'runner') return 'runner';
        if (phase.includes('watchdog') || agentId.includes('watchdog')) return 'watchdog';
        if (phase.includes('merge') || agentId.includes('merge')) return 'merge';
        if (phase.includes('review')) return 'review';
        if (phase.includes('checkpoint') || phase.includes('validate')) return 'checkpoint';
        if (agent?.taskId) return 'task';
        return null;
      }

      function deriveTaskActivityKind(task) {
        const kind = String(task?.lastActivityKind ?? '').trim().toLowerCase();
        let resolved = kind;
        if (!resolved) {
          const activity = String(task?.lastActivity ?? '').toLowerCase();
          if (activity.includes('rate')) resolved = 'ratelimit';
          else if (activity.includes('command')) resolved = 'commandexec';
          else if (activity.includes('reason')) resolved = 'reasoning';
          else if (activity.includes('tool')) resolved = 'tool';
          else if (activity.includes('file')) resolved = 'file';
        }
        if (!resolved) return null;
        if (resolved === 'message') return null;
        if (resolved === 'commandexec') return 'commandexec';
        if (resolved === 'ratelimit') return 'ratelimit';
        if (resolved === 'reasoning') return 'reasoning';
        if (resolved === 'toolcall' || resolved === 'tool') return 'tool';
        if (resolved === 'filechange' || resolved === 'file') return 'file';
        return resolved;
      }

      function activityTimestamp(entry) {
        const value = Number(
          entry?.lastPromptAt
          ?? entry?.summaryTextDeltaAt
          ?? entry?.lastActivityAt
          ?? entry?.startedAt
          ?? entry?.finishedAt
          ?? 0,
        );
        return Number.isFinite(value) ? value : 0;
      }

      function pickAgentByKind(agents, kind) {
        const list = Array.isArray(agents)
          ? agents.filter(agent => deriveAgentKind(agent) === kind)
          : [];
        if (list.length === 0) return null;
        const statusWeight = agent => {
          const status = String(agent?.status ?? '');
          if (status === 'running' || status === 'disposing') return 0;
          if (status === 'disposed') return 2;
          return 1;
        };
        return [...list].sort((a, b) => {
          const wa = statusWeight(a);
          const wb = statusWeight(b);
          if (wa !== wb) return wa - wb;
          const ta = activityTimestamp(a);
          const tb = activityTimestamp(b);
          if (ta !== tb) return tb - ta;
          return String(a?.agentId ?? '').localeCompare(String(b?.agentId ?? ''));
        })[0];
      }

      function pickTaskCandidate(tasks) {
        const list = Array.isArray(tasks) ? tasks.filter(task => task?.taskId) : [];
        if (list.length === 0) return null;
        const active = list.filter(task =>
          ['running', 'pending', 'blocked'].includes(String(task?.status ?? '')),
        );
        const pool = active.length > 0 ? active : list;
        return [...pool].sort((a, b) => {
          const ta = activityTimestamp(a);
          const tb = activityTimestamp(b);
          if (ta !== tb) return tb - ta;
          return String(a?.taskId ?? '').localeCompare(String(b?.taskId ?? ''));
        })[0];
      }

      function pickCardText(...values) {
        for (const value of values) {
          const raw = String(value ?? '');
          if (raw && raw.trim()) return raw;
        }
        return '';
      }

      function clipCardText(value, max = 6000) {
        const text = String(value ?? '');
        if (!text || !text.trim()) return '';
        if (text.length <= max) return text;
        return text.slice(text.length - max);
      }

      function setCardTags(container, tags) {
        if (!container) return;
        container.innerHTML = '';
        for (const tag of tags) {
          const chip = document.createElement('span');
          chip.className = 'badge' + (tag.cls ? ' ' + tag.cls : '');
          chip.textContent = tag.text;
          container.appendChild(chip);
        }
      }

      function renderCard({ titleEl, tagsEl, metaEl, textEl, rootEl }, payload) {
        if (!rootEl) return;
        if (titleEl) titleEl.textContent = payload.title ?? '-';
        setCardTags(tagsEl, payload.tags ?? []);
        const metaText = String(payload.meta ?? '');
        if (metaEl) {
          metaEl.textContent = metaText;
          metaEl.classList.toggle('hidden', !metaText.trim());
        }
        const bodyText = String(payload.text ?? '');
        if (textEl) {
          textEl.textContent = bodyText;
          textEl.classList.toggle('hidden', !bodyText.trim());
        }
        rootEl.classList.toggle('card-empty', !payload.hasData);
      }

      function cardTimestamp(...entries) {
        let best = 0;
        for (const entry of entries) {
          const value = activityTimestamp(entry);
          if (value > best) best = value;
        }
        return best;
      }

      function resolveCardOrder(cards) {
        if (!Array.isArray(cards) || cards.length === 0) {
          cardStackTopId = null;
          cardStackTopAt = 0;
          return [];
        }
        const disposedWeight = card => {
          const tags = Array.isArray(card?.tags) ? card.tags : [];
          return tags.some(tag => String(tag?.text ?? '').trim().toLowerCase().includes('disposed')) ? 1 : 0;
        };
        const sorted = [...cards].sort((a, b) => {
          const da = disposedWeight(a);
          const db = disposedWeight(b);
          if (da !== db) return da - db;
          const ta = Number(a?.ts ?? 0);
          const tb = Number(b?.ts ?? 0);
          if (ta !== tb) return tb - ta;
          const ka = String(a?.sortKey ?? a?.id ?? '');
          const kb = String(b?.sortKey ?? b?.id ?? '');
          return ka.localeCompare(kb);
        });
        const desiredTop = sorted[0]?.id ?? null;
        const now = Date.now();
        if (!cardStackTopId || !sorted.some(card => card.id === cardStackTopId)) {
          cardStackTopId = desiredTop;
          cardStackTopAt = now;
        } else if (cardStackTopId !== desiredTop) {
          if (now - cardStackTopAt >= CARD_TOP_HOLD_MS) {
            cardStackTopId = desiredTop;
            cardStackTopAt = now;
          }
        }
        const topId = cardStackTopId || desiredTop;
        if (!topId) return sorted;
        const topIndex = sorted.findIndex(card => card.id === topId);
        if (topIndex > 0) {
          const [top] = sorted.splice(topIndex, 1);
          return [top, ...sorted];
        }
        return sorted;
      }

      function createStackCardElement() {
        if (cardStackTemplate?.content) {
          const clone = cardStackTemplate.content.firstElementChild?.cloneNode(true);
          if (clone) {
            return {
              rootEl: clone,
              titleEl: clone.querySelector('.card-title'),
              tagsEl: clone.querySelector('.card-tags'),
              metaEl: clone.querySelector('.card-meta'),
              textEl: clone.querySelector('.card-text'),
            };
          }
        }
        const root = document.createElement('div');
        root.className = 'card card-flex';
        const head = document.createElement('div');
        head.className = 'card-head';
        const titleEl = document.createElement('div');
        titleEl.className = 'card-title';
        const tagsEl = document.createElement('div');
        tagsEl.className = 'card-tags';
        head.appendChild(titleEl);
        head.appendChild(tagsEl);
        const body = document.createElement('div');
        body.className = 'card-body';
        const metaEl = document.createElement('div');
        metaEl.className = 'card-meta';
        const textEl = document.createElement('div');
        textEl.className = 'card-text mono';
        body.appendChild(metaEl);
        body.appendChild(textEl);
        root.appendChild(head);
        root.appendChild(body);
        return { rootEl: root, titleEl, tagsEl, metaEl, textEl };
      }

      function ensureTokenCaches(runId) {
        const resolved = typeof runId === 'string' ? runId : '';
        if (!resolved) return;
        if (resolved !== lastTokenRunId) {
          agentTokenCache.clear();
          taskTokenCache.clear();
          lastTokenRunId = resolved;
        }
      }

      function isActiveAgent(agent) {
        const status = String(agent?.status ?? '');
        return status === 'running' || status === 'disposing';
      }

      function countAgentsByPhase(agents, phase) {
        if (!Array.isArray(agents)) return 0;
        return agents.filter(agent => {
          const agentId = typeof agent?.agentId === 'string' ? agent.agentId.trim() : '';
          if (!agentId || agentId.toLowerCase() === 'server') return false;
          return agent?.phase === phase && isActiveAgent(agent);
        }).length;
      }
      function deriveSchedulerCounts(run) {
        const counts = run?.counts ?? {};
        const agents = Array.isArray(run?.agents) ? run.agents : [];
        return {
          running: counts.tasksRunning ?? 0,
          pending: counts.tasksPending ?? 0,
          blocked: counts.tasksBlocked ?? 0,
          merging: countAgentsByPhase(agents, 'merge'),
        };
      }

	      function formatDuration(ms) {
	        if (!Number.isFinite(ms) || ms < 0) return '-';
	        const totalSeconds = Math.floor(ms / 1000);
	        const seconds = totalSeconds % 60;
	        const minutes = Math.floor(totalSeconds / 60) % 60;
	        const hours = Math.floor(totalSeconds / 3600);

	        if (hours > 0) {
	          return String(hours) + ':' + String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
	        }
	        return String(minutes) + ':' + String(seconds).padStart(2, '0');
	      }

	      function formatAgo(ts) {
	        const value = Number.parseInt(ts, 10);
	        if (!Number.isFinite(value) || value <= 0) return '-';
	        const delta = Math.max(0, Date.now() - value);
	        if (delta < 1000) return 'now';
	        const seconds = Math.floor(delta / 1000);
	        if (seconds < 60) return String(seconds) + 's';
	        const minutes = Math.floor(seconds / 60);
	        if (minutes < 60) return String(minutes) + 'm';
	        const hours = Math.floor(minutes / 60);
	        return String(hours) + 'h';
	      }

      function formatUsd(value) {
        const num = Number(value);
        if (!Number.isFinite(num)) return '-';
        const abs = Math.abs(num);
        const decimals = abs >= 10 ? 2 : abs >= 1 ? 3 : abs >= 0.01 ? 4 : 6;
        return '$' + num.toFixed(decimals);
      }

      function estimateRemainingMs(elapsedMs, done, total) {
        if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return null;
        const doneNum = Number.parseInt(done, 10);
        const totalNum = Number.parseInt(total, 10);
        if (!Number.isFinite(doneNum) || !Number.isFinite(totalNum) || doneNum <= 0 || totalNum <= 0) {
          return null;
        }
        if (doneNum >= totalNum) return 0;
        const estimatedTotalMs = elapsedMs * (totalNum / doneNum);
        return Math.max(0, Math.round(estimatedTotalMs - elapsedMs));
      }

      function setBackendStatus(ok, message) {
        backendConnected = ok;
        backendError = message || null;
        if (!statusConnEl) return;
        if (ok === true) {
          statusConnEl.textContent = 'backend: connected';
          return;
        }
        if (ok === false) {
          const suffix = backendError ? ' (' + backendError + ')' : '';
          statusConnEl.textContent = 'backend: disconnected' + suffix;
          return;
        }
        statusConnEl.textContent = 'backend: -';
      }

      function hideFallback() {
        if (fallbackEl) fallbackEl.classList.add('hidden');
      }

      function showFallback(message) {
        if (!fallbackEl) return;
        fallbackEl.textContent = message || 'Loading CDX Stats…';
        fallbackEl.classList.remove('hidden');
      }

      async function fetchJson(url, options = {}) {
        const signal = options && typeof options === 'object' ? options.signal : undefined;
        const res = await fetch(url, { cache: 'no-store', signal });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error('Request failed: ' + res.status + ' ' + text);
        }
        return await res.json();
      }

      function currentRunId() {
        return state?.activeRun?.id ?? null;
      }

      function setSelectedRun(value) {
        selectedRunId = String(value ?? '').trim();
        const url = new URL(window.location.href);
        if (selectedRunId) {
          url.searchParams.set('runId', selectedRunId);
        } else {
          url.searchParams.delete('runId');
        }
        window.history.replaceState({}, '', url);
      }

      function setSelectedPid(value) {
        selectedPid = String(value ?? '').trim();
        const url = new URL(window.location.href);
        if (selectedPid) {
          url.searchParams.set('pid', selectedPid);
        } else {
          url.searchParams.delete('pid');
        }
        window.history.replaceState({}, '', url);
      }

      function stateUrl() {
        return selectedRunId
          ? ('/api/state?runId=' + encodeURIComponent(selectedRunId))
          : '/api/state';
      }

      async function applyRunChange(nextRunId, { follow } = {}) {
        if (runSwitchInFlight) return;
        runSwitchInFlight = true;
        followActiveRun = Boolean(follow);
        setSelectedRun(nextRunId);

        if (eventsAbortController) {
          eventsAbortController.abort();
          eventsAbortController = null;
        }
        eventsLastPollAt = 0;
        if (logsAbortController) {
          logsAbortController.abort();
          logsAbortController = null;
        }
        logsLastPollAt = 0;
        if (apiAbortController) {
          apiAbortController.abort();
          apiAbortController = null;
        }
        apiLastPollAt = 0;
        if (promptAbortController) {
          promptAbortController.abort();
          promptAbortController = null;
        }
        promptLastPollAt = 0;
        if (worktreeStatusAbortController) {
          worktreeStatusAbortController.abort();
          worktreeStatusAbortController = null;
        }
        if (worktreeTreeAbortController) {
          worktreeTreeAbortController.abort();
          worktreeTreeAbortController = null;
        }
        worktreeLastPollAt = 0;
        worktreePollDelayMs = WORKTREE_STATUS_POLL_MIN_MS;
        worktreeLastStatusText = null;
        graphRefreshDeferred = false;
        graphAutoRefreshPausedUntil = 0;
        cardStackTopId = null;
        cardStackTopAt = 0;
        testGitTreeRunId = null;
        watchdogTurnTabs = [];
        watchdogActiveTurn = null;
        watchdogTurnsInFlight = false;
        watchdogTurnsLastFetchAt = 0;
        watchdogTurnsLastRunKey = null;
        watchdogTurnsLastEventId = 0;
        watchdogTurnsLastLogId = 0;

        selectedAgent = null;
        selectedWorktreeAgent = null;
        selectedPath = '';
        pathInput.value = '';
        resetLogs();
        resetApi();
        resetPrompts();
        fileEl.textContent = '';
        gitStatusEl.textContent = '';
        if (testGitTreeEl) testGitTreeEl.textContent = '';
        setWatchdogTurnMessage('Loading watchdog turn logs...', { visible: true });

        try {
          await refreshState({ skipAutoFollow: true });
          await syncEventCursor();
          refreshGraph(true).catch(() => {});
        } catch {
          // ignore
        } finally {
          runSwitchInFlight = false;
        }
      }

      function clipInline(value, max = 60) {
        const text = String(value ?? '').replace(/\\s+/g, ' ').trim();
        if (!text) return '';
        if (text.length <= max) return text;
        if (max <= 3) return text.slice(0, max);
        return text.slice(0, max - 3) + '...';
      }

      function pathLeafLabel(value, max = 36) {
        const raw = String(value ?? '').trim().replace(/[\\\\/]+$/g, '');
        if (!raw) return '';
        const parts = raw.split(/[\\\\/]/).filter(Boolean);
        const leaf = parts.length > 0 ? parts[parts.length - 1] : raw;
        return clipInline(leaf, max);
      }

      function formatRecoverLabel(attempt) {
        const num = Number.parseInt(attempt, 10);
        if (!Number.isFinite(num) || num <= 0) return '';
        return 'recover ' + String(num);
      }

      function appendRecoverLabel(label, attempt, max = 88) {
        const combined = [String(label ?? '').trim(), formatRecoverLabel(attempt)]
          .filter(Boolean)
          .join(' ');
        return clipInline(combined, max);
      }

      function formatTaskCardId(taskId) {
        const normalized = String(taskId ?? '').trim();
        if (!normalized) return 'Task';
        return normalized.charAt(0).toUpperCase() + normalized.slice(1);
      }

      function buildTaskCardTitle(taskId, description, modelLabel, worktreePath, recoverAttempt) {
        const parts = [appendRecoverLabel(formatTaskCardId(taskId), recoverAttempt, 52) || formatTaskCardId(taskId)];
        const folderLabel = pathLeafLabel(worktreePath, 24);
        if (folderLabel) parts.push('folder: ' + folderLabel);
        const clippedDescription = clipInline(description ?? '', 88);
        if (clippedDescription) parts.push(clippedDescription);
        if (modelLabel) parts.push(modelLabel);
        return parts.join(' - ');
      }

      function runPidKey(run) {
        const pid = run?.pid ?? null;
        if (pid === null || pid === undefined || pid === '') return 'unknown';
        return String(pid);
      }

      function runWorkspacePath(run) {
        return run?.cwd ?? run?.repoRoot ?? run?.runRoot ?? run?.worktreeRoot ?? '';
      }

      function runCommandValue(run) {
        return run?.lastCommand ?? run?.processCommand ?? '';
      }

      function runTaskValue(run) {
        return run?.currentTaskSummary ?? '';
      }

      function killRunButtonText(run) {
        if (!run) return 'kill job';
        return run?.inFlight === true ? 'kill job' : 'finished';
      }

      function killRunButtonTitle(run) {
        if (!run) return 'Force terminate this CDX process';
        return run?.inFlight === true
          ? 'Force terminate this CDX process'
          : 'Run is no longer active';
      }

      function filteredRunsByPid(runs, pid) {
        if (!pid) return runs;
        const key = String(pid);
        return runs.filter(run => runPidKey(run) === key);
      }

      function pickLatestRun(runs, activeRunId) {
        if (!Array.isArray(runs) || runs.length === 0) return null;
        if (activeRunId) {
          const active = runs.find(run => run?.id === activeRunId);
          if (active) return active;
        }
        return runs[0];
      }

      function jobTitleLine(run) {
        const parts = [];
        const pid = runPidKey(run);
        const session = run?.id ? String(run.id) : '-';
        const stage = run?.stage ? String(run.stage) : (run?.status ? String(run.status) : 'unknown');
        const age = formatAgo(run?.startedAt ?? run?.createdAt);
        const folderLabel = pathLeafLabel(runWorkspacePath(run), 24);
        if (pid) parts.push('pid:' + pid);
        if (session) parts.push('session:' + session);
        if (folderLabel) parts.push('folder:' + folderLabel);
        if (stage) parts.push(stage);
        if (age && age !== '-') parts.push(age);
        return parts.join(' · ');
      }

      function jobDetailLines(run) {
        const lines = [];
        const stage = run?.stage ? String(run.stage) : '';
        const status = run?.status ? String(run.status) : '';
        if (stage || status) {
          const parts = [];
          if (stage) parts.push('state: ' + stage);
          if (status && status !== stage) parts.push('raw: ' + status);
          lines.push(parts.join(' · '));
        }
        const cwd = runWorkspacePath(run);
        if (cwd) lines.push('cwd: ' + cwd);
        const goal = clipInline(run?.goal, 180);
        if (goal) lines.push('goal: ' + goal);
        const focus = clipInline(run?.currentTaskSummary, 180);
        if (focus) lines.push('focus: ' + focus);
        const cmd = clipInline(runCommandValue(run), 180);
        const task = clipInline(runTaskValue(run), 180);
        if (cmd || task) {
          const parts = [];
          if (cmd) parts.push('cmd: ' + cmd);
          if (task) parts.push('task: ' + task);
          lines.push(parts.join(' · '));
        }
        return lines;
      }

      function renderJobsList() {
        if (!jobsListEl) return;
        const runs = Array.isArray(state?.runs) ? state.runs : [];
        if (jobsMetaEl) {
          const pidLabel = selectedPid ? (' · pid filter: ' + selectedPid) : '';
          const activeLabel = state?.activeRunId ? (' · active: ' + state.activeRunId) : '';
          const selectedLabel = selectedRunId ? (' · selected: ' + selectedRunId) : '';
          jobsMetaEl.textContent = 'jobs: ' + runs.length + pidLabel + activeLabel + selectedLabel;
        }
        jobsListEl.innerHTML = '';
        if (runs.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'muted mono';
          empty.textContent = 'No jobs yet';
          jobsListEl.appendChild(empty);
          return;
        }
        const activeRunId = state?.activeRunId ?? null;
        const selectedId = selectedRunId || activeRunId || '';
        for (const run of runs) {
          if (!run || !run.id) continue;
          const row = document.createElement('button');
          row.type = 'button';
          row.className = 'job-row';
          if (run.id === selectedId) row.classList.add('active');
          row.dataset.runId = run.id;
          row.dataset.pid = runPidKey(run);

          const main = document.createElement('div');
          main.className = 'job-main';
          const title = document.createElement('div');
          title.className = 'job-title';
          title.textContent = jobTitleLine(run);
          main.appendChild(title);

          const lines = jobDetailLines(run);
          for (const line of lines) {
            const sub = document.createElement('div');
            sub.className = 'job-sub';
            sub.textContent = line;
            main.appendChild(sub);
          }

          const action = document.createElement('div');
          action.className = 'job-action';
          action.textContent = 'open';

          row.appendChild(main);
          row.appendChild(action);
          jobsListEl.appendChild(row);
        }
      }

      function openJobsOverlay() {
        if (!jobsOverlay) return;
        renderJobsList();
        jobsOverlay.classList.remove('hidden');
        jobsOverlay.setAttribute('aria-hidden', 'false');
      }

      function closeJobsOverlay() {
        if (!jobsOverlay) return;
        jobsOverlay.classList.add('hidden');
        jobsOverlay.setAttribute('aria-hidden', 'true');
      }

	      function setActiveTab(tab) {
	        const nextTab = (!promptsEnabled && tab === 'prompts') ? 'logs' : tab;
	        activeTab = nextTab;
	        const logsActive = nextTab === 'logs';
	        const apiActive = nextTab === 'api';
	        const promptsActive = promptsEnabled && nextTab === 'prompts';
	        const worktreeActive = nextTab === 'worktree';
		        tabLogs.classList.toggle('active', logsActive);
		        tabApi?.classList.toggle('active', apiActive);
		        tabPrompts?.classList.toggle('active', promptsActive);
		        tabWorktree.classList.toggle('active', worktreeActive);
		        panelLogs.style.display = logsActive ? '' : 'none';
		        if (panelApi) panelApi.style.display = apiActive ? '' : 'none';
		        if (panelPrompts) panelPrompts.style.display = promptsActive ? '' : 'none';
		        panelWorktree.style.display = worktreeActive ? '' : 'none';

	        if (!worktreeActive && worktreeMaximized) {
	          setWorktreeMaximized(false);
	        }

		        if (logsActive) {
		          startLogsLoop();
		          if (!window.EventSource) {
		            refreshLogs(true, 0).catch(() => {});
		          }
		        } else {
		          closeLogStream();
		          if (logsAbortController) {
		            logsAbortController.abort();
		            logsAbortController = null;
		          }
		        }

		        if (apiActive) {
		          startApiLoop();
		          refreshApi(true, 0).catch(() => {});
		        } else {
		          if (apiAbortController) {
		            apiAbortController.abort();
		            apiAbortController = null;
		          }
		        }

		        if (promptsActive) {
		          startPromptLoop();
		          refreshPrompts(true, 0).catch(() => {});
		        } else {
		          if (promptAbortController) {
		            promptAbortController.abort();
		            promptAbortController = null;
		          }
		        }

		        if (worktreeActive) {
		          startWorktreeLoop();
		          worktreePollDelayMs = WORKTREE_STATUS_POLL_MIN_MS;
		          worktreeLastPollAt = 0;
		          worktreeLastStatusText = null;
		          refreshGitStatus().catch(() => {});
		          refreshTree().catch(() => {});
		        } else {
		          if (worktreeStatusAbortController) {
		            worktreeStatusAbortController.abort();
		            worktreeStatusAbortController = null;
		          }
		          if (worktreeTreeAbortController) {
		            worktreeTreeAbortController.abort();
		            worktreeTreeAbortController = null;
		          }
		        }
		      }

	      tabLogs.addEventListener('click', () => {
	        setActiveTab('logs');
	        setWorktreeMaximized(false);
	      });
      tabApi?.addEventListener('click', () => {
        setActiveTab('api');
        setWorktreeMaximized(false);
      });
      tabPrompts?.addEventListener('click', () => {
        setActiveTab('prompts');
        setWorktreeMaximized(false);
      });
      tabWorktree.addEventListener('click', () => {
        setActiveTab('worktree');
        setWorktreeMaximized(true);
      });

      function renderSessionMeta(run) {
        if (!sessionMetaEl) return;
        if (!run) {
          sessionMetaEl.textContent = 'session: -\\npid: -\\ncwd: -\\ncmd: -\\ntask: -';
          return;
        }
        const sessionId = run?.id ?? '-';
        const pid = run?.pid ?? '-';
        const cwd = runWorkspacePath(run) || '-';
        const cmd = clipInline(runCommandValue(run), 180) || '-';
        const task = clipInline(runTaskValue(run), 180) || '-';
        sessionMetaEl.textContent = [
          'session: ' + sessionId,
          'pid: ' + pid,
          'cwd: ' + cwd,
          'cmd: ' + cmd,
          'task: ' + task,
        ].join('\\n');
      }

      function renderRun() {
        if (serverPidEl) {
          const pid = state?.serverPid;
          serverPidEl.textContent = 'server pid: ' + (pid ? pid : '-');
        }
        const run = state?.activeRun ?? null;
        ensureTokenCaches(run?.id);
        if (killRunBtn) {
          killRunBtn.textContent = killRunButtonText(run);
          killRunBtn.title = killRunButtonTitle(run);
          killRunBtn.disabled = run?.canKill !== true;
        }
        if (!run) {
          if (pillRun) pillRun.textContent = 'run: -';
          pillAgents.textContent = 'agents: 0';
          pillTasks.textContent = 'tasks: 0';
          pillSched.textContent = 'sched: -';
          pillTime.textContent = 'time: -';
          pillStatus.textContent = 'status: -';
          if (statusRunEl) statusRunEl.textContent = '-';
          if (statusWaitEl) statusWaitEl.textContent = '-';
          if (statusBlockEl) statusBlockEl.textContent = '-';
          if (statusMergeEl) statusMergeEl.textContent = '-';
          if (statusDoneEl) statusDoneEl.textContent = '-';
          if (statusElapsedEl) statusElapsedEl.textContent = 'elapsed: -';
          if (statusEtaEl) statusEtaEl.textContent = 'eta: -';
          if (statusConnEl && backendConnected === null) statusConnEl.textContent = 'backend: -';
          if (runKv) runKv.innerHTML = '<div class="k">info</div><div class="v">No active run</div>';
          if (tasksEl) tasksEl.innerHTML = '<div class="muted">No active run</div>';
          renderSessionMeta(null);
          return;
        }

        if (pillRun) pillRun.textContent = 'run: ' + run.id;

        const agentsTotal = run.counts?.agentsTotal ?? 0;
        const agentsRunning = run.counts?.agentsRunning ?? 0;
        pillAgents.textContent = 'agents: ' + agentsRunning;

        const tasksTotal = run.counts?.tasksTotal ?? 0;
        const tasksCompleted = run.counts?.tasksCompleted ?? 0;
        const tasksSuperseded = run.counts?.tasksSuperseded ?? 0;
        const tasksFailed = run.counts?.tasksFailed ?? 0;
        const tasksBlocked = run.counts?.tasksBlocked ?? 0;
        const tasksResolved = tasksCompleted + tasksSuperseded + tasksFailed + tasksBlocked;
        pillTasks.textContent = 'tasks: ' + tasksResolved + '/' + tasksTotal;

        const sched = run.scheduler ?? null;
        const schedCounts = deriveSchedulerCounts(run);
        const bottleneck = sched?.bottleneckKind ? (' (' + sched.bottleneckKind + ')') : '';
        const ownership = Number.isFinite(sched?.ownershipBlockedCount) && sched.ownershipBlockedCount > 0
          ? (' · own=' + String(sched.ownershipBlockedCount))
          : '';
        const backpressure = sched?.backpressureActive
          ? (' · bp=' + (sched.backpressureReason ?? 'on'))
          : '';
        pillSched.textContent =
          'sched: running=' + schedCounts.running
          + ' pending=' + schedCounts.pending
          + ' blocked=' + schedCounts.blocked
          + ' merging=' + schedCounts.merging
          + bottleneck
          + ownership
          + backpressure;

        pillStatus.textContent = 'status: ' + String(run?.stage ?? run?.status ?? 'unknown');

        const now = Date.now();
        const startedAt = Number.isFinite(run.startedAt) ? run.startedAt : null;
        const completedAt = Number.isFinite(run.completedAt) ? run.completedAt : null;
        const endAt = completedAt ?? now;
        const elapsedMs = startedAt ? Math.max(0, endAt - startedAt) : null;
        const remainingMs = run?.inFlight === true
          ? estimateRemainingMs(elapsedMs, tasksResolved, tasksTotal)
          : null;
        pillTime.textContent = 'time: ' + formatDuration(elapsedMs) + ' eta: ' + formatDuration(remainingMs);

        if (statusRunEl) statusRunEl.textContent = String(run.counts?.tasksRunning ?? 0);
        if (statusWaitEl) statusWaitEl.textContent = String(run.counts?.tasksPending ?? 0);
        if (statusBlockEl) statusBlockEl.textContent = String(run.counts?.tasksBlocked ?? 0);
        if (statusMergeEl) statusMergeEl.textContent = String(schedCounts.merging ?? 0);
        if (statusDoneEl) {
          statusDoneEl.textContent = String(
            (run.counts?.tasksCompleted ?? 0)
            + (run.counts?.tasksSuperseded ?? 0)
            + (run.counts?.tasksFailed ?? 0),
          );
        }
        if (statusElapsedEl) statusElapsedEl.textContent = 'elapsed: ' + formatDuration(elapsedMs);
        if (statusEtaEl) statusEtaEl.textContent = 'eta: ' + formatDuration(remainingMs);

        const backpressureLabel = sched?.backpressureActive
          ? ('reason=' + (sched.backpressureReason ?? 'on')
            + ' · for ' + formatDuration(Math.max(0, (sched.backpressureUntil ?? 0) - Date.now())))
          : 'off';
        const rateLimitLabel = Number.isFinite(sched?.rateLimitHits)
          ? ('hits=' + String(sched.rateLimitHits)
            + ' · last ' + (sched.rateLimitLastAt ? formatAgo(sched.rateLimitLastAt) : '-'))
          : '-';
        const rows = [
          ['goal', run.goal ?? '-'],
          ['repo', run.repoRoot ?? '-'],
          ['head', run.headRef ?? '-'],
          ['runRoot', run.runRoot ?? '-'],
          ['keepWorktrees', String(run.keepWorktrees ?? false)],
          ['agents', agentsRunning + ' running (total ' + agentsTotal + ')'],
          ['tasks', tasksCompleted + '/' + tasksTotal + ' completed · superseded: ' + tasksSuperseded + ' · running: ' + (run.counts?.tasksRunning ?? 0) + ' · pending: ' + (run.counts?.tasksPending ?? 0) + ' · failed: ' + tasksFailed + ' · blocked: ' + tasksBlocked],
          ['sched', 'running=' + schedCounts.running + ' · pending=' + schedCounts.pending + ' · blocked=' + schedCounts.blocked + ' · merging=' + schedCounts.merging + bottleneck + ownership],
          ['backpressure', backpressureLabel],
          ['rateLimit', rateLimitLabel],
          ['asks', String(run.counts?.asksPending ?? 0) + ' pending'],
          ['elapsed', formatDuration(elapsedMs)],
          ['eta', formatDuration(remainingMs)],
        ];
	        if (runKv) {
	          runKv.innerHTML = rows.map(([k,v]) => (
	            '<div class="k">' + k + '</div><div class="v">' + v + '</div>'
	          )).join('');
	        }
        renderSessionMeta(run);
      }

	      function renderTasks() {
	        const run = state?.activeRun ?? null;
	        const tasks = run?.tasks ?? [];
	        if (!tasksEl) return;
	        if (!run) {
            if (tasksMetaEl) tasksMetaEl.textContent = '';
	          tasksEl.innerHTML = '<div class="muted">No active run</div>';
	          return;
	        }

	        if (!Array.isArray(tasks) || tasks.length === 0) {
            if (tasksMetaEl) tasksMetaEl.textContent = '';
	          const planned = run.plannedTaskCount ?? run.counts?.tasksTotal ?? 0;
	          const hint = planned > 0
	            ? ('Waiting for worktrees (' + planned + ' planned)')
	            : 'No tasks yet';
	          tasksEl.innerHTML = '<div class="muted">' + hint + '</div>';
	          return;
	        }

          if (tasksMetaEl) {
            const totalUsd = tasks.reduce((sum, task) => sum + (Number(task?.costUsd) || 0), 0);
            tasksMetaEl.textContent = 'total cost: ' + formatUsd(totalUsd);
          }

	        const lastActivityScore = task =>
	          Number(task?.lastActivityAt ?? task?.startedAt ?? task?.finishedAt ?? 0);

	        const sorted = [...tasks].sort((a, b) => {
	          const wa = taskStatusSortWeight(a.status);
	          const wb = taskStatusSortWeight(b.status);
	          if (wa !== wb) return wa - wb;
	          const ta = lastActivityScore(a);
	          const tb = lastActivityScore(b);
	          if (ta !== tb) return tb - ta;
	          return String(a.taskId).localeCompare(String(b.taskId));
	        });

	        const html = sorted.map(task => {
          const taskId = String(task.taskId ?? '');
          if (!taskId) return '';
          const agentId = 'task:' + taskId;
	          const statusInfo = statusBadge(task.status);
	          const active = selectedAgent === agentId || selectedAgent === taskId;
	          const activityKind = task.status === 'running' ? deriveTaskActivityKind(task) : null;
	          const tagText = composeStatusTag(task.status, activityKind);
	          const tagHtml = '<span class="tag ' + statusInfo.cls + '">' + tagText + '</span>';
          const tokensLine = formatTokenSummary(task.tokens, taskTokenCache, taskId);
	          const desc = String(task.description ?? '').trim();
	          const last = task.lastActivityAt ? formatAgo(task.lastActivityAt) : '-';
	          const activity = task.lastActivity ? String(task.lastActivity) : '';
	          const title = [
	            desc ? ('desc: ' + desc) : null,
	            activity ? ('last: ' + last + ' · ' + activity) : ('last: ' + last),
	          ].filter(Boolean).join('\\n');
	          const titleAttr = title ? (' title="' + escapeAttr(title) + '"') : '';
	          return '<button class="agent-btn' + (active ? ' active' : '') + '" data-task="' + taskId + '"' + titleAttr + '>' +
	            '<div class="agent-row">' +
	              '<div class="agent-id">' + taskId + '</div>' +
	              '<div class="tag-group">' + tagHtml + '</div>' +
	            '</div>' +
	            '<div class="muted mono" style="font-size:11px;">' + tokensLine + '</div>' +
	          '</button>';
		        }).join('');

		        tasksEl.innerHTML = html;
		      }

      function renderAgents() {
        const run = state?.activeRun ?? null;
        const agents = run?.agents ?? [];
        if (!agentsEl) return;

        if (!Array.isArray(agents) || agents.length === 0) {
          if (agentsMetaEl) agentsMetaEl.textContent = '';
          agentsEl.innerHTML = '<div class="muted">No agents yet</div>';
          return;
        }

        if (agentsMetaEl) {
          const totalUsd = agents
            .filter(agent => agent?.agentId && agent.agentId !== 'server')
            .reduce((sum, agent) => sum + (Number(agent?.costUsd) || 0), 0);
          agentsMetaEl.textContent = 'total cost: ' + formatUsd(totalUsd);
        }

        const weight = agent => {
          const kind = deriveAgentKind(agent);
          if (kind === 'planner') return 0;
          if (kind === 'runner') return 1;
          if (kind === 'watchdog') return 2;
          const status = String(agent?.status ?? '');
          if (status === 'running' || status === 'disposing') return 3;
          if (status === 'disposed') return 4;
          return 5;
        };

        const lastActivityScore = agent =>
          Number(agent?.lastActivityAt ?? agent?.startedAt ?? agent?.finishedAt ?? 0);

        const sorted = [...agents].sort((a, b) => {
          const wa = weight(a);
          const wb = weight(b);
          if (wa !== wb) return wa - wb;
          const ta = lastActivityScore(a);
          const tb = lastActivityScore(b);
          if (ta !== tb) return tb - ta;
          return String(a.agentId).localeCompare(String(b.agentId));
        });

        const html = sorted.map(agent => {
          const id = String(agent.agentId ?? '');
          if (!id) return '';
          const statusInfo = statusBadge(agent.status);
          const active = id === selectedAgent;
          const kind = deriveAgentKind(agent);
          const tagText = composeStatusTag(agent.status, kind);
          const tagHtml = '<span class="tag ' + statusInfo.cls + '">' + tagText + '</span>';
          const modelLine = formatAgentModelLabel(agent);
          const tokensLine = formatTokenSummary(agent.tokens, agentTokenCache, id);
          const last = agent.lastActivityAt ? formatAgo(agent.lastActivityAt) : '-';
          const activity = agent.lastActivity ? String(agent.lastActivity) : '';
          const title = [
            agent.phase ? ('phase: ' + agent.phase) : null,
            agent.taskId ? ('task: ' + agent.taskId) : null,
            activity ? ('last: ' + last + ' · ' + activity) : ('last: ' + last),
          ].filter(Boolean).join('\\n');
          const titleAttr = title ? (' title="' + escapeAttr(title) + '"') : '';
          return '<button class="agent-btn' + (active ? ' active' : '') + '" data-agent="' + id + '"' + titleAttr + '>' +
            '<div class="agent-row">' +
              '<div class="agent-id">' + id + '</div>' +
              '<div class="tag-group">' + tagHtml + '</div>' +
            '</div>' +
            (modelLine ? ('<div class="muted mono" style="font-size:11px;">' + modelLine + '</div>') : '') +
            '<div class="muted mono" style="font-size:11px;">' + tokensLine + '</div>' +
          '</button>';
	        }).join('');
	        agentsEl.innerHTML = html;
	      }

      function renderCardView() {
        if (!cardHero || !cardStack) return;
        const run = state?.activeRun ?? null;
        const agents = Array.isArray(run?.agents) ? run.agents : [];
        const tasks = Array.isArray(run?.tasks) ? run.tasks : [];

        if (!run) {
          cardStackTopId = null;
          cardStackTopAt = 0;
          if (cardHero) cardHero.classList.remove('full');
          if (cardStack) {
            cardStack.classList.add('hidden');
            cardStack.textContent = '';
          }
          renderCard(
            { titleEl: cardHeroTitle, tagsEl: cardHeroTags, metaEl: cardHeroMeta, textEl: cardHeroText, rootEl: cardHero },
            { title: 'Watchdog Agent', tags: [], meta: 'No active run.', text: '', hasData: false },
          );
          return;
        }

        const watchdogAgent = pickAgentByKind(agents, 'watchdog');
        const plannerAgent = pickAgentByKind(agents, 'planner');
        const heroAgent = watchdogAgent;

        if (cardHero) {
          cardHero.classList.remove('full');
        }
        if (cardStack) {
          cardStack.classList.remove('hidden');
        }

        const heroStatus = heroAgent?.status ?? 'idle';
        const heroKind = heroAgent ? deriveAgentKind(heroAgent) : 'watchdog';
        const heroTagInfo = statusBadge(heroStatus);
        const watchdogLatest = run?.watchdogLatest ?? null;
        const heroTags = heroAgent
          ? [{ text: composeStatusTag(heroStatus, heroKind), cls: heroTagInfo.cls }]
          : [{ text: 'idle', cls: '' }];
        if (watchdogLatest?.kind) {
          heroTags.push({ text: String(watchdogLatest.kind).replace(/-/g, ' '), cls: '' });
        }
        const heroModel = formatAgentModelLabel(heroAgent);
        const heroLastSource = watchdogLatest?.at ?? heroAgent?.lastActivityAt ?? null;
        const heroLast = heroLastSource ? formatAgo(heroLastSource) : '-';
        const heroTitleParts = ['Watchdog Agent'];
        if (heroModel) heroTitleParts.push(heroModel);
        if (heroLast && heroLast !== '-') {
          heroTitleParts.push('last ' + heroLast);
        } else if (!heroModel) {
          heroTitleParts.push('waiting');
        }
        const heroText = heroAgent
          ? clipCardText(
            pickCardText(
              watchdogLatest?.text,
              run?.watchdogStdoutText,
              heroAgent?.summaryTextDelta,
              heroAgent?.lastActivity,
              heroAgent?.lastPromptText,
              run?.goal,
            ),
          )
          : '';
        const heroMetaParts = [];
        if (heroAgent?.taskId) heroMetaParts.push('task: ' + heroAgent.taskId);
        if (watchdogLatest?.source) heroMetaParts.push('source: ' + watchdogLatest.source);
        if (watchdogLatest?.turnIndex) heroMetaParts.push('turn: ' + watchdogLatest.turnIndex);
        if (watchdogLatest?.at) heroMetaParts.push('updated ' + formatAgo(watchdogLatest.at));

        renderCard(
          { titleEl: cardHeroTitle, tagsEl: cardHeroTags, metaEl: cardHeroMeta, textEl: cardHeroText, rootEl: cardHero },
          {
            title: heroTitleParts.join(' - '),
            tags: heroTags,
            meta: heroAgent ? heroMetaParts.join(' · ') : 'No watchdog yet.',
            text: heroText,
            hasData: Boolean(heroAgent),
          },
        );

        if (!cardStack) return;

        const taskList = (Array.isArray(tasks) ? tasks : []).filter(task => {
          const status = String(task?.status ?? '');
          return status !== 'completed';
        });
        const taskIds = new Set();
        for (const task of taskList) {
          const id = String(task?.taskId ?? '').trim();
          if (id) taskIds.add(id);
        }
        for (const agent of agents) {
          if (deriveAgentKind(agent) === 'merge') continue;
          const taskId = String(agent?.taskId ?? '').trim();
          if (!taskId || taskIds.has(taskId)) continue;
          taskIds.add(taskId);
          taskList.push({
            taskId,
            description: null,
            dependsOn: [],
            branch: null,
            worktreePath: agent?.worktreePath ?? null,
            retryAttempt: null,
            status: agent?.status ?? 'running',
            startedAt: agent?.startedAt ?? null,
            finishedAt: agent?.finishedAt ?? null,
            lastActivityAt: agent?.lastActivityAt ?? null,
            lastActivity: agent?.lastActivity ?? null,
            lastActivityKind: agent?.lastActivityKind ?? null,
            summaryTextDelta: null,
            summaryTextDeltaAt: null,
          });
        }

        const pickPrimaryTaskAgent = taskId => {
          if (!taskId) return null;
          const candidates = agents.filter(agent => String(agent?.taskId ?? '').trim() === taskId);
          if (candidates.length === 0) return null;
          const primary = candidates.filter(agent => deriveAgentKind(agent) !== 'merge');
          const pool = primary.length ? primary : candidates;
          const weight = agent => {
            const status = String(agent?.status ?? '');
            if (status === 'running' || status === 'disposing') return 0;
            if (status === 'disposed') return 2;
            return 1;
          };
          return [...pool].sort((a, b) => {
            const wa = weight(a);
            const wb = weight(b);
            if (wa !== wb) return wa - wb;
            const ta = activityTimestamp(a);
            const tb = activityTimestamp(b);
            if (ta !== tb) return tb - ta;
            return String(a?.agentId ?? '').localeCompare(String(b?.agentId ?? ''));
          })[0];
        };

        const taskCards = taskList
          .filter(task => String(task?.taskId ?? '').trim())
          .map(task => {
            const taskId = String(task.taskId);
            const taskAgent = pickPrimaryTaskAgent(taskId);
            const status = task?.status ?? 'pending';
            const activityKind = task?.status === 'running' ? deriveTaskActivityKind(task) : null;
            const tagInfo = statusBadge(status);
            const tags = [{ text: composeStatusTag(status, activityKind), cls: tagInfo.cls }];
            const taskModel = formatAgentModelLabel(taskAgent);
            const tokenMeta = formatTokenIoSummary(task?.tokens ?? taskAgent?.tokens ?? null);
            const text = clipCardText(
              pickCardText(
                task?.lastPromptText,
                taskAgent?.lastPromptText,
                task?.summaryTextDelta,
                taskAgent?.summaryTextDelta,
                task?.lastActivity,
                taskAgent?.lastActivity,
                task?.description,
              ),
            );
            return {
              id: 'task:' + taskId,
              sortKey: 'task:' + taskId,
              title: buildTaskCardTitle(
                taskId,
                task?.description,
                taskModel,
                task?.worktreePath ?? taskAgent?.worktreePath ?? '',
                task?.retryAttempt ?? null,
              ),
              tags,
              meta: tokenMeta,
              text,
              hasData: true,
              ts: cardTimestamp(task, taskAgent),
            };
          });

        const cards = [...taskCards];
        const ordered = resolveCardOrder(cards);
        const display = CARD_STACK_MAX_ITEMS > 0 && ordered.length > CARD_STACK_MAX_ITEMS
          ? ordered.slice(0, CARD_STACK_MAX_ITEMS)
          : ordered;

        const hasKnownTaskCards =
          tasks.some(task => String(task?.taskId ?? '').trim())
          || agents.some(agent => deriveAgentKind(agent) !== 'merge' && String(agent?.taskId ?? '').trim());
        const plannedCount = Number.parseInt(run?.plannedTaskCount, 10)
          || Number.parseInt(run?.counts?.tasksTotal, 10)
          || 0;
        const plannerParallelism = Number.parseInt(run?.counts?.parallelism, 10) || 0;
        const preTaskPhaseView = buildPreTaskPhaseView(run);
        const plannerMeta = [];
        if (plannedCount > 0) plannerMeta.push('planned tasks: ' + plannedCount);
        if (plannerParallelism > 0) plannerMeta.push('parallelism: ' + plannerParallelism);
        if (plannerAgent?.agentId) plannerMeta.push('agent: ' + plannerAgent.agentId);
        const plannerRawText = String(run?.plannerPlanText ?? '').trim();
        const plannerText = clipCardText(
          pickCardText(
            run?.plannerStdoutText,
            plannerRawText === 'planner-skipped'
              ? 'Planner step skipped; tasks will execute directly.'
              : plannerRawText,
            plannerAgent?.summaryTextDelta,
            plannerAgent?.lastActivity,
            plannerAgent?.lastPromptText,
            run?.goal,
          ),
        );
        const plannerStatus = plannerAgent?.status ?? '';
        const plannerTags = plannerStatus
          ? [{ text: composeStatusTag(plannerStatus, 'planner'), cls: statusBadge(plannerStatus).cls }]
          : [];

        cardStack.textContent = '';
        const fragment = document.createDocumentFragment();

        if (!hasKnownTaskCards) {
          cardStackTopId = null;
          cardStackTopAt = 0;
          const node = createStackCardElement();
          node.rootEl.classList.add('planner-placeholder');
          const preTaskTags = preTaskPhaseView?.status
            ? [{
              text: composeStatusTag(preTaskPhaseView.status, preTaskPhaseView.kind),
              cls: statusBadge(preTaskPhaseView.status).cls,
            }]
            : [];
          renderCard(node, {
            title: preTaskPhaseView?.title ?? 'Planner Plan',
            tags: preTaskPhaseView ? preTaskTags : plannerTags,
            meta: preTaskPhaseView?.meta ?? plannerMeta.join('\\n'),
            text: preTaskPhaseView?.text ?? plannerText,
            hasData: preTaskPhaseView
              ? Boolean(preTaskPhaseView.text || preTaskPhaseView.meta || preTaskPhaseView.status)
              : Boolean(plannerText || plannerMeta.length || plannerStatus),
          });
          fragment.appendChild(node.rootEl);
          cardStack.appendChild(fragment);
          return;
        }

        if (display.length === 0) {
          cardStackTopId = null;
          cardStackTopAt = 0;
          const node = createStackCardElement();
          node.rootEl.classList.add('stack-placeholder');
          renderCard(node, {
            title: 'Task Cards',
            tags: [],
            meta: 'No active task cards.',
            text: '',
            hasData: false,
          });
          fragment.appendChild(node.rootEl);
          cardStack.appendChild(fragment);
          return;
        }

        for (const card of display) {
          const node = createStackCardElement();
          renderCard(node, card);
          fragment.appendChild(node.rootEl);
        }
        cardStack.appendChild(fragment);
      }

		      function clearTimers() {
		        closeLogStream();
		        if (logsAbortController) {
		          logsAbortController.abort();
		          logsAbortController = null;
		        }
		        if (apiAbortController) {
		          apiAbortController.abort();
		          apiAbortController = null;
		        }
		        if (promptAbortController) {
		          promptAbortController.abort();
		          promptAbortController = null;
		        }
		        if (worktreeStatusAbortController) {
		          worktreeStatusAbortController.abort();
		          worktreeStatusAbortController = null;
		        }
		        if (worktreeTreeAbortController) {
		          worktreeTreeAbortController.abort();
		          worktreeTreeAbortController = null;
		        }
		      }

		      function normalizeRefValue(value) {
		        const raw = String(value ?? '').trim();
		        if (!raw) return '';
		        if (raw.startsWith('refs/heads/')) return raw.slice('refs/heads/'.length);
		        if (raw.startsWith('refs/remotes/')) return raw.slice('refs/remotes/'.length);
		        if (raw.startsWith('refs/tags/')) return raw.slice('refs/tags/'.length);
		        return raw;
		      }

		      function taskIdFromBranchRef(value) {
		        const ref = normalizeRefValue(value);
		        if (!ref) return null;
		        const match =
		          ref.match(/^cdx\\/task\\/[^/]+\\/([^/]+)$/) ||
		          ref.match(/^cdx\\/task\\/([^/]+)$/);
		        return match ? match[1] : null;
		      }

      function resolveTaskAgentId(taskId) {
        const raw = String(taskId ?? '').trim();
        if (!raw) return null;
        const run = state?.activeRun ?? null;
        const agents = Array.isArray(run?.agents) ? run.agents : [];
        const direct = agents.find(agent => String(agent?.taskId ?? '').trim() === raw);
        if (direct?.agentId) return String(direct.agentId);
        const prefixed = 'task:' + raw;
        if (agents.some(agent => agent?.agentId === prefixed)) return prefixed;
        if (agents.some(agent => agent?.agentId === raw)) return raw;
        return prefixed;
      }

      function resolveSelectedTaskId() {
        const raw = String(selectedAgent ?? '').trim();
        if (!raw) return null;
        if (raw.startsWith('task:')) return raw.slice('task:'.length);
        const run = state?.activeRun ?? null;
        const agents = Array.isArray(run?.agents) ? run.agents : [];
        const agent = agents.find(entry => String(entry?.agentId ?? '').trim() === raw);
        const taskId = String(agent?.taskId ?? '').trim();
        return taskId || null;
      }

      function taskIdFromGraphRefs(refs) {
        const run = state?.activeRun ?? null;
        const tasks = Array.isArray(run?.tasks) ? run.tasks : [];
        const lookup = new Map();
		        for (const task of tasks) {
		          const taskId = String(task?.taskId ?? '').trim();
		          const branch = String(task?.branch ?? '').trim();
		          if (!taskId || !branch) continue;
		          lookup.set(branch, taskId);
		          lookup.set(normalizeRefValue(branch), taskId);
		        }

		        const candidates = [];
		        for (const ref of Array.isArray(refs) ? refs : []) {
		          const id = String(ref?.id ?? '').trim();
		          const name = String(ref?.name ?? '').trim();
		          if (id) candidates.push(id);
		          if (name && name !== id) candidates.push(name);
		        }

		        for (const candidate of candidates) {
		          if (lookup.has(candidate)) return lookup.get(candidate);
		          const normalized = normalizeRefValue(candidate);
		          if (lookup.has(normalized)) return lookup.get(normalized);
		          const parsed = taskIdFromBranchRef(candidate) || taskIdFromBranchRef(normalized);
		          if (parsed) return parsed;
		        }
		        return null;
		      }

      async function selectAgent(agentId, { focusLogs = false } = {}) {
        if (!agentId) return;
        selectedAgent = agentId;
        resetLogs();
        resetApi();
        fileEl.textContent = '';
        gitStatusEl.textContent = '';

	        const run = state?.activeRun ?? null;
	        const agent = byId(run?.agents ?? [], agentId, 'agentId');
	        selectedWorktreeAgent = agentId;
	        selectedPath = '';
	        pathInput.value = '';

	        renderAgents();
	        renderTasks();
	        const nextTab = focusLogs ? 'logs' : activeTab;
	        setActiveTab(nextTab);
	      }

		      function resetWorktreeBackoff() {
		        worktreePollDelayMs = WORKTREE_STATUS_POLL_MIN_MS;
		        worktreeLastPollAt = 0;
		      }

	      const GRAPH_PALETTE = [
	        '#38bdf8',
	        '#34d399',
	        '#fbbf24',
	        '#a78bfa',
	        '#fb7185',
	        '#60a5fa',
	        '#f97316',
	        '#22c55e',
	      ];

	      const GRAPH_DIRS = {
	        U: [-1, 0],
	        D: [1, 0],
	        L: [0, -1],
	        R: [0, 1],
	        UL: [-1, -1],
	        UR: [-1, 1],
	        DL: [1, -1],
	        DR: [1, 1],
	      };
	      const GRAPH_OPP = {
	        U: 'D',
	        D: 'U',
	        L: 'R',
	        R: 'L',
	        UL: 'DR',
	        DR: 'UL',
	        UR: 'DL',
	        DL: 'UR',
	      };

	      function graphConnectionsForChar(ch) {
	        switch (ch) {
	          case '|':
	            return ['U', 'D'];
	          case '-':
	          case '_':
	            return ['L', 'R'];
	          case '\\\\':
	            return ['UL', 'DR'];
	          case '/':
	            return ['UR', 'DL'];
	          case '*':
	            return ['U', 'D', 'L', 'R', 'UL', 'UR', 'DL', 'DR'];
	          default:
	            return [];
	        }
	      }

		      function parseGraphRows(text) {
		        const raw = String(text ?? '').replace(/\\r/g, '').split('\\n');
		        if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
		        return raw.map(line => {
		          const match = line.match(/[0-9a-f]{7,40}(?= )/);
		          if (match && typeof match.index === 'number') {
		            const idx = match.index;
		            const prefix = line.slice(0, idx).replace(/\\s+$/, '');
		            return {
		              prefix,
		              rest: line.slice(idx),
		            };
		          }
		          return { prefix: line.replace(/\\s+$/, ''), rest: '' };
		        });
		      }

	      function buildGraphGeometry(rows) {
	        const prefixes = rows.map(row => row.prefix);
	        const maxCols = prefixes.reduce((m, p) => Math.max(m, p.length), 0);
	        const grid = prefixes.map(prefix => prefix.padEnd(maxCols, ' ').split(''));
	        const edges = [];
	        const nodes = [];
	        const edgeKeys = new Set();
	        const rowCount = grid.length;

	        for (let r = 0; r < rowCount; r += 1) {
	          for (let c = 0; c < maxCols; c += 1) {
	            const ch = grid[r][c];
	            if (ch === '*') nodes.push({ r, c });
	            const conns = graphConnectionsForChar(ch);
	            if (conns.length === 0) continue;

	            for (const dir of conns) {
	              const delta = GRAPH_DIRS[dir];
	              if (!delta) continue;
	              const nr = r + delta[0];
	              const nc = c + delta[1];
	              if (nr < 0 || nr >= rowCount || nc < 0 || nc >= maxCols) continue;

	              const neighborConns = graphConnectionsForChar(grid[nr][nc]);
	              const opp = GRAPH_OPP[dir];
	              if (!opp || !neighborConns.includes(opp)) continue;

	              const a = r * maxCols + c;
	              const b = nr * maxCols + nc;
	              const key = a < b ? String(a) + '-' + String(b) : String(b) + '-' + String(a);
	              if (edgeKeys.has(key)) continue;
	              edgeKeys.add(key);
	              edges.push({ r1: r, c1: c, r2: nr, c2: nc });
	            }
	          }
	        }

	        return { maxCols, edges, nodes };
	      }

	      function graphScrollWidth() {
	        const width = graphScroll?.clientWidth ?? 0;
	        return Number.isFinite(width) && width > 0 ? width : 640;
	      }

	      function renderGraphCanvas(payload) {
	        if (!graphCanvas) return;
	        const ctx = graphCanvas.getContext('2d');
	        if (!ctx) return;

	        const rows = parseGraphRows(payload?.graph ?? '');
	        if (rows.length === 0) {
	          const width = graphScrollWidth();
	          const height = 160;
	          const dpr = window.devicePixelRatio || 1;
	          graphCanvas.width = Math.ceil(width * dpr);
	          graphCanvas.height = Math.ceil(height * dpr);
	          graphCanvas.style.width = String(width) + 'px';
	          graphCanvas.style.height = String(height) + 'px';
	          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	          ctx.clearRect(0, 0, width, height);
	          ctx.fillStyle = '#94a3b8';
	          ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
	          ctx.textBaseline = 'top';
	          ctx.fillText('No graph data', 12, 12);
	          return;
	        }

		        const geo = buildGraphGeometry(rows);
		        const maxCols = geo.maxCols;

		        const colW = 6;
		        const rowHCommit = 18;
		        const rowHBridge = 10;
		        const padX = 8;
		        const padY = 8;
		        const textGap = 12;
		        const graphWidth = maxCols * colW;
		        const textX = padX + graphWidth + textGap;

		        const rowHeights = rows.map(row => (row?.rest ? rowHCommit : rowHBridge));
		        const totalRowsHeight = rowHeights.reduce(
		          (sum, h) => sum + (Number.isFinite(h) ? h : rowHCommit),
		          0,
		        );
		        const rowCenters = new Array(rows.length);
		        let cursorY = padY;
		        for (let r = rows.length - 1; r >= 0; r -= 1) {
		          const h = rowHeights[r] ?? rowHCommit;
		          rowCenters[r] = cursorY + h / 2;
		          cursorY += h;
		        }

		        const font = '12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
		        ctx.font = font;
		        const desiredHeight = Math.ceil(padY * 2 + totalRowsHeight);
	        const maxTextWidthPx = rows.reduce((max, row) => {
	          const text = row.rest ?? '';
	          if (!text) return max;
	          const width = ctx.measureText(text).width;
	          return width > max ? width : max;
	        }, 0);
	        const requiredWidth = Math.ceil(textX + maxTextWidthPx + padX);
	        const desiredWidth = Math.max(graphScrollWidth(), requiredWidth);

		        const prevTop = graphScroll?.scrollTop ?? 0;
		        const prevLeft = graphScroll?.scrollLeft ?? 0;

		        const dpr = window.devicePixelRatio || 1;
		        graphCanvas.width = Math.ceil(desiredWidth * dpr);
		        graphCanvas.height = Math.ceil(desiredHeight * dpr);
	        graphCanvas.style.width = String(desiredWidth) + 'px';
	        graphCanvas.style.height = String(desiredHeight) + 'px';
	        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

	        ctx.clearRect(0, 0, desiredWidth, desiredHeight);
	        ctx.lineCap = 'round';
		        ctx.lineJoin = 'round';

			        const colorForCol = col => GRAPH_PALETTE[Math.abs(col) % GRAPH_PALETTE.length] ?? '#38bdf8';
			        const rowToY = r => rowCenters[r] ?? padY;
			        const colToX = c => padX + c * colW + colW / 2;

			        ctx.globalAlpha = 0.9;
			        ctx.lineWidth = 2;

		        const edgeKeyForIds = (a, b) => (a < b ? String(a) + '-' + String(b) : String(b) + '-' + String(a));
		        const idFor = (r, c) => r * maxCols + c;
		        const xyForId = id => ({
		          r: Math.floor(id / maxCols),
		          c: id % maxCols,
		          x: colToX(id % maxCols),
		          y: rowToY(Math.floor(id / maxCols)),
		        });

		        const buildPolylines = edges => {
		          const neighbors = new Map();
		          for (const edge of edges) {
		            const a = idFor(edge.r1, edge.c1);
		            const b = idFor(edge.r2, edge.c2);
		            if (!neighbors.has(a)) neighbors.set(a, []);
		            if (!neighbors.has(b)) neighbors.set(b, []);
		            neighbors.get(a).push(b);
		            neighbors.get(b).push(a);
		          }
		          for (const list of neighbors.values()) list.sort((a, b) => a - b);

		          const visited = new Set();
		          const paths = [];
		          const nodes = [...neighbors.keys()].sort((a, b) => a - b);

		          const degree = id => neighbors.get(id)?.length ?? 0;
		          const seen = (a, b) => visited.has(edgeKeyForIds(a, b));
		          const mark = (a, b) => visited.add(edgeKeyForIds(a, b));

		          for (const start of nodes) {
		            if (degree(start) === 2) continue;
		            for (const next of neighbors.get(start) ?? []) {
		              if (seen(start, next)) continue;
		              const path = [start, next];
		              mark(start, next);
		              let prev = start;
		              let cur = next;
		              while (degree(cur) === 2) {
		                const nbs = neighbors.get(cur) ?? [];
		                const candidate = nbs[0] === prev ? nbs[1] : nbs[0];
		                if (candidate === undefined) break;
		                if (seen(cur, candidate)) break;
		                path.push(candidate);
		                mark(cur, candidate);
		                prev = cur;
		                cur = candidate;
		              }
		              paths.push(path);
		            }
		          }

		          while (true) {
		            let seed = null;
		            for (const start of nodes) {
		              for (const next of neighbors.get(start) ?? []) {
		                if (seen(start, next)) continue;
		                seed = { start, next };
		                break;
		              }
		              if (seed) break;
		            }
		            if (!seed) break;
		            const path = [seed.start, seed.next];
		            mark(seed.start, seed.next);
		            let prev = seed.start;
		            let cur = seed.next;
		            while (cur !== seed.start) {
		              const nbs = neighbors.get(cur) ?? [];
		              const candidate = nbs[0] === prev ? nbs[1] : nbs[0];
		              if (candidate === undefined) break;
		              if (seen(cur, candidate)) break;
		              path.push(candidate);
		              mark(cur, candidate);
		              prev = cur;
		              cur = candidate;
		            }
		            paths.push(path);
		          }

		          return paths;
		        };

		        const edgesByColor = new Map();
		        for (const edge of geo.edges) {
		          const color = colorForCol(Math.min(edge.c1, edge.c2));
		          if (!edgesByColor.has(color)) edgesByColor.set(color, []);
		          edgesByColor.get(color).push(edge);
		        }
		        for (const [color, edges] of edgesByColor.entries()) {
		          ctx.strokeStyle = color;
		          ctx.beginPath();
		          const paths = buildPolylines(edges);
		          for (const ids of paths) {
		            if (ids.length < 2) continue;
		            const first = xyForId(ids[0]);
		            const isCycle = ids[0] === ids[ids.length - 1];
		            const lastIndex = isCycle ? ids.length - 1 : ids.length;
		            ctx.moveTo(first.x, first.y);
		            for (let i = 1; i < lastIndex; i += 1) {
		              const pt = xyForId(ids[i]);
		              ctx.lineTo(pt.x, pt.y);
		            }
		            if (isCycle) ctx.closePath();
		          }
		          ctx.stroke();
		        }

			        ctx.globalAlpha = 1;
			        for (const node of geo.nodes) {
			          const x = colToX(node.c);
			          const y = rowToY(node.r);
			          ctx.fillStyle = colorForCol(node.c);
			          ctx.beginPath();
			          ctx.arc(x, y, 3, 0, Math.PI * 2);
			          ctx.fill();
			          ctx.strokeStyle = 'rgba(2,6,23,0.65)';
			          ctx.lineWidth = 1;
			          ctx.stroke();
		        }

	        ctx.font = font;
	        ctx.fillStyle = '#e5e7eb';
	        ctx.textBaseline = 'middle';
	        ctx.textAlign = 'left';
		        for (let i = 0; i < rows.length; i += 1) {
		          const y = rowToY(i);
		          const text = rows[i].rest ?? '';
		          if (text) ctx.fillText(text, textX, y);
		        }

		        if (graphScroll) {
		          graphScroll.scrollTop = prevTop;
		          graphScroll.scrollLeft = prevLeft;
		        }
	      }

		      const GRAPH_COLORS = ['#FFB000', '#DC267F', '#994F00', '#40B0A6', '#B66DFF'];
			      const HISTORY_ITEM_REF_COLOR = '#59a4f9';
			      const HISTORY_ITEM_REMOTE_REF_COLOR = '#B180D7';
			      const HISTORY_ITEM_BASE_REF_COLOR = '#EA5C00';
			      const SCM_INCOMING_HISTORY_ITEM_ID = 'scm-graph-incoming-changes';
			      const SCM_OUTGOING_HISTORY_ITEM_ID = 'scm-graph-outgoing-changes';
			      const SWIMLANE_HEIGHT = 22;
			      const SWIMLANE_WIDTH = 11;
			      const SWIMLANE_CURVE_RADIUS = 5;
			      const CIRCLE_RADIUS = 4;
			      const CIRCLE_STROKE_WIDTH = 2;

		      function svgEl(tag) {
		        return document.createElementNS('http://www.w3.org/2000/svg', tag);
		      }

		      function createPath(color, strokeWidth) {
		        const path = svgEl('path');
		        path.setAttribute('fill', 'none');
		        path.setAttribute('stroke-width', String(strokeWidth ?? 1));
		        path.setAttribute('stroke-linecap', 'round');
		        path.setAttribute('stroke', String(color ?? GRAPH_COLORS[0]));
		        return path;
		      }

		      function drawVerticalLine(x, y1, y2, color, strokeWidth) {
		        const path = createPath(color, strokeWidth);
		        path.setAttribute('d', 'M ' + String(x) + ' ' + String(y1) + ' V ' + String(y2));
		        return path;
		      }

			      function drawCircle(index, radius, strokeWidth, fillColor) {
			        const circle = svgEl('circle');
			        circle.setAttribute('cx', String(SWIMLANE_WIDTH * (index + 1)));
			        circle.setAttribute('cy', String(SWIMLANE_WIDTH));
			        circle.setAttribute('r', String(radius));
			        circle.setAttribute('stroke-width', String(strokeWidth));
			        if (fillColor) {
			          circle.setAttribute('fill', String(fillColor));
			        }
			        return circle;
			      }

			      function drawDashedCircle(index, strokeWidth, color) {
			        const circle = svgEl('circle');
			        circle.setAttribute('cx', String(SWIMLANE_WIDTH * (index + 1)));
			        circle.setAttribute('cy', String(SWIMLANE_WIDTH));
			        circle.setAttribute('r', String(CIRCLE_RADIUS + 1));
			        circle.setAttribute('stroke', String(color ?? HISTORY_ITEM_REF_COLOR));
			        circle.setAttribute('stroke-width', String(strokeWidth ?? 1));
			        circle.setAttribute('stroke-dasharray', '4,2');
			        circle.setAttribute('fill', 'none');
			        return circle;
			      }

		      function findLastIndex(nodes, id) {
		        for (let i = nodes.length - 1; i >= 0; i -= 1) {
		          if (nodes[i]?.id === id) return i;
		        }
		        return -1;
		      }

			      function renderHistoryItemGraph(viewModel) {
			        const svg = svgEl('svg');
			        svg.classList.add('graph');

			        const historyItem = viewModel?.historyItem ?? {};
			        const inputSwimlanes = Array.isArray(viewModel?.inputSwimlanes) ? viewModel.inputSwimlanes : [];
			        const outputSwimlanes = Array.isArray(viewModel?.outputSwimlanes) ? viewModel.outputSwimlanes : [];

			        const inputIndex = inputSwimlanes.findIndex(node => node?.id === historyItem.id);
			        const circleIndex = inputIndex !== -1 ? inputIndex : inputSwimlanes.length;
			        const circleColor =
			          circleIndex < outputSwimlanes.length
			            ? outputSwimlanes[circleIndex]?.color
			            : circleIndex < inputSwimlanes.length
			              ? inputSwimlanes[circleIndex]?.color
			              : HISTORY_ITEM_REF_COLOR;

		        let outputSwimlaneIndex = 0;
		        for (let index = 0; index < inputSwimlanes.length; index += 1) {
		          const color = inputSwimlanes[index]?.color ?? GRAPH_COLORS[0];

			          if (inputSwimlanes[index]?.id === historyItem.id) {
		            if (index !== circleIndex) {
		              const d = [];
		              const path = createPath(color, 1);
		              d.push('M ' + String(SWIMLANE_WIDTH * (index + 1)) + ' 0');
		              d.push('A ' + String(SWIMLANE_WIDTH) + ' ' + String(SWIMLANE_WIDTH) + ' 0 0 1 ' + String(SWIMLANE_WIDTH * index) + ' ' + String(SWIMLANE_WIDTH));
		              d.push('H ' + String(SWIMLANE_WIDTH * (circleIndex + 1)));
		              path.setAttribute('d', d.join(' '));
		              svg.append(path);
		            } else {
		              outputSwimlaneIndex += 1;
		            }
		          } else {
		            if (
		              outputSwimlaneIndex < outputSwimlanes.length &&
		              inputSwimlanes[index]?.id === outputSwimlanes[outputSwimlaneIndex]?.id
		            ) {
		              if (index === outputSwimlaneIndex) {
		                svg.append(drawVerticalLine(SWIMLANE_WIDTH * (index + 1), 0, SWIMLANE_HEIGHT, color, 1));
		              } else {
		                const d = [];
		                const path = createPath(color, 1);
		                d.push('M ' + String(SWIMLANE_WIDTH * (index + 1)) + ' 0');
		                d.push('V 6');
		                d.push(
		                  'A ' +
		                    String(SWIMLANE_CURVE_RADIUS) +
		                    ' ' +
		                    String(SWIMLANE_CURVE_RADIUS) +
		                    ' 0 0 1 ' +
		                    String((SWIMLANE_WIDTH * (index + 1)) - SWIMLANE_CURVE_RADIUS) +
		                    ' ' +
		                    String(SWIMLANE_HEIGHT / 2),
		                );
		                d.push('H ' + String((SWIMLANE_WIDTH * (outputSwimlaneIndex + 1)) + SWIMLANE_CURVE_RADIUS));
		                d.push(
		                  'A ' +
		                    String(SWIMLANE_CURVE_RADIUS) +
		                    ' ' +
		                    String(SWIMLANE_CURVE_RADIUS) +
		                    ' 0 0 0 ' +
		                    String(SWIMLANE_WIDTH * (outputSwimlaneIndex + 1)) +
		                    ' ' +
		                    String((SWIMLANE_HEIGHT / 2) + SWIMLANE_CURVE_RADIUS),
		                );
		                d.push('V ' + String(SWIMLANE_HEIGHT));
		                path.setAttribute('d', d.join(' '));
		                svg.append(path);
		              }

		              outputSwimlaneIndex += 1;
		            }
		          }
		        }

			        const parentIds = Array.isArray(historyItem.parentIds) ? historyItem.parentIds : [];
		        for (let i = 1; i < parentIds.length; i += 1) {
		          const parentOutputIndex = findLastIndex(outputSwimlanes, parentIds[i]);
		          if (parentOutputIndex === -1) continue;

		          const d = [];
		          const path = createPath(outputSwimlanes[parentOutputIndex]?.color ?? GRAPH_COLORS[0], 1);

		          d.push('M ' + String(SWIMLANE_WIDTH * parentOutputIndex) + ' ' + String(SWIMLANE_HEIGHT / 2));
		          d.push(
		            'A ' +
		              String(SWIMLANE_WIDTH) +
		              ' ' +
		              String(SWIMLANE_WIDTH) +
		              ' 0 0 1 ' +
		              String(SWIMLANE_WIDTH * (parentOutputIndex + 1)) +
		              ' ' +
		              String(SWIMLANE_HEIGHT),
		          );
		          d.push('M ' + String(SWIMLANE_WIDTH * parentOutputIndex) + ' ' + String(SWIMLANE_HEIGHT / 2));
		          d.push('H ' + String(SWIMLANE_WIDTH * (circleIndex + 1)) + ' ');

		          path.setAttribute('d', d.join(' '));
		          svg.append(path);
		        }

		        if (inputIndex !== -1) {
		          svg.append(
		            drawVerticalLine(
		              SWIMLANE_WIDTH * (circleIndex + 1),
		              0,
		              SWIMLANE_HEIGHT / 2,
			              inputSwimlanes[inputIndex]?.color ?? HISTORY_ITEM_REF_COLOR,
		              1,
		            ),
		          );
		        }

		        if (parentIds.length > 0) {
		          svg.append(drawVerticalLine(SWIMLANE_WIDTH * (circleIndex + 1), SWIMLANE_HEIGHT / 2, SWIMLANE_HEIGHT, circleColor, 1));
		        }

			        if (viewModel?.kind === 'HEAD') {
			          svg.append(drawCircle(circleIndex, CIRCLE_RADIUS + 3, CIRCLE_STROKE_WIDTH, circleColor));
			          svg.append(drawCircle(circleIndex, CIRCLE_STROKE_WIDTH, CIRCLE_RADIUS));
			        } else if (viewModel?.kind === 'incoming-changes' || viewModel?.kind === 'outgoing-changes') {
			          svg.append(drawCircle(circleIndex, CIRCLE_RADIUS + 3, CIRCLE_STROKE_WIDTH, circleColor));
			          svg.append(drawCircle(circleIndex, CIRCLE_RADIUS + 1, CIRCLE_STROKE_WIDTH + 1));
			          svg.append(drawDashedCircle(circleIndex, CIRCLE_STROKE_WIDTH - 1, circleColor));
			        } else if (parentIds.length > 1) {
			          svg.append(drawCircle(circleIndex, CIRCLE_RADIUS + 2, CIRCLE_STROKE_WIDTH, circleColor));
			          svg.append(drawCircle(circleIndex, CIRCLE_RADIUS - 1, CIRCLE_STROKE_WIDTH, circleColor));
			        } else {
			          svg.append(drawCircle(circleIndex, CIRCLE_RADIUS + 1, CIRCLE_STROKE_WIDTH, circleColor));
			        }

		        const width = SWIMLANE_WIDTH * (Math.max(inputSwimlanes.length, outputSwimlanes.length, 1) + 1);
		        svg.style.height = String(SWIMLANE_HEIGHT) + 'px';
		        svg.style.width = String(width) + 'px';
		        return svg;
		      }

			      function rot(value, modulo) {
			        const mod = Math.max(1, Number.parseInt(modulo, 10) || 1);
			        const num = Number.parseInt(value, 10) || 0;
			        const r = num % mod;
			        return r < 0 ? r + mod : r;
			      }

			      function findLastIdx(items, predicate) {
			        const arr = Array.isArray(items) ? items : [];
			        const fn = typeof predicate === 'function' ? predicate : null;
			        if (!fn) return -1;
			        for (let i = arr.length - 1; i >= 0; i -= 1) {
			          if (fn(arr[i], i)) return i;
			        }
			        return -1;
			      }

			      function compareHistoryItemRefs(ref1, ref2, currentHistoryItemRef, currentHistoryItemRemoteRef, currentHistoryItemBaseRef) {
			        const getHistoryItemRefOrder = ref => {
			          if (ref?.id === currentHistoryItemRef?.id) return 1;
			          if (ref?.id === currentHistoryItemRemoteRef?.id) return 2;
			          if (ref?.id === currentHistoryItemBaseRef?.id) return 3;
			          if (ref?.color !== undefined) return 4;
			          return 99;
			        };
			        return getHistoryItemRefOrder(ref1) - getHistoryItemRefOrder(ref2);
			      }

			      function getLabelColorIdentifier(historyItem, colorMap) {
			        const item = historyItem ?? {};
			        if (item.id === SCM_INCOMING_HISTORY_ITEM_ID) return HISTORY_ITEM_REMOTE_REF_COLOR;
			        if (item.id === SCM_OUTGOING_HISTORY_ITEM_ID) return HISTORY_ITEM_REF_COLOR;
			        const refs = Array.isArray(item.references) ? item.references : [];
			        for (const ref of refs) {
			          const colorIdentifier = colorMap.get(ref.id);
			          if (colorIdentifier !== undefined) {
			            return colorIdentifier;
			          }
			        }
			        return undefined;
			      }

			      function getHistoryItemIndex(historyItemViewModel) {
			        const historyItem = historyItemViewModel?.historyItem ?? {};
			        const inputSwimlanes = Array.isArray(historyItemViewModel?.inputSwimlanes)
			          ? historyItemViewModel.inputSwimlanes
			          : [];
			        const inputIndex = inputSwimlanes.findIndex(node => node?.id === historyItem.id);
			        return inputIndex !== -1 ? inputIndex : inputSwimlanes.length;
			      }

			      function renderHistoryGraphPlaceholder(columns, highlightIndex) {
			        const cols = Array.isArray(columns) ? columns : [];
			        const svg = svgEl('svg');
			        for (let index = 0; index < cols.length; index += 1) {
			          const strokeWidth = index === highlightIndex ? 3 : 1;
			          svg.append(drawVerticalLine(SWIMLANE_WIDTH * (index + 1), 0, SWIMLANE_HEIGHT, cols[index].color, strokeWidth));
			        }
			        svg.style.height = String(SWIMLANE_HEIGHT) + 'px';
			        svg.style.width = String(SWIMLANE_WIDTH * (cols.length + 1)) + 'px';
			        return svg;
			      }

			      function parseDecorationTokens(raw) {
			        const text = String(raw ?? '').trim();
			        if (!text) return [];
			        return text
			          .split(',')
			          .map(token => String(token ?? '').trim())
			          .filter(Boolean);
			      }

			      function parseHistoryItemReferences(decorations) {
			        const tokens = parseDecorationTokens(decorations);
			        const refs = [];
			        const seen = new Set();
			        const knownRefs = Array.isArray(graphCache?.historyItemRefs) ? graphCache.historyItemRefs : [];
			        const nameToRef = new Map();
			        const refNameById = new Map();
			        const shortNameFromRefId = refId => {
			          const str = String(refId ?? '').trim();
			          if (str.startsWith('refs/heads/')) return str.slice('refs/heads/'.length);
			          if (str.startsWith('refs/remotes/')) return str.slice('refs/remotes/'.length);
			          if (str.startsWith('refs/tags/')) return str.slice('refs/tags/'.length);
			          return str;
			        };
			        const registerRefName = (id, name, iconId) => {
			          const refId = String(id ?? '').trim();
			          const refName = String(name ?? '').trim();
			          if (!refId || !refName) return;
			          const refIcon = String(iconId ?? '').trim();
			          refNameById.set(refId, refName);
			          const shortName = shortNameFromRefId(refId);
			          if (shortName) {
			            refNameById.set(shortName, refName);
			            nameToRef.set(shortName, { id: refId, iconId: refIcon });
			          }
			          nameToRef.set(refName, { id: refId, iconId: refIcon });
			        };
			        for (const ref of knownRefs) {
			          registerRefName(ref?.id, ref?.name, ref?.iconId);
			        }
			        if (graphCache?.historyItemRef?.id && graphCache?.historyItemRef?.name) {
			          registerRefName(
			            graphCache.historyItemRef.id,
			            graphCache.historyItemRef.name,
			            graphCache.historyItemRef.iconId ?? 'git-branch',
			          );
			        }
			        if (graphCache?.historyItemRemoteRef?.id && graphCache?.historyItemRemoteRef?.name) {
			          registerRefName(
			            graphCache.historyItemRemoteRef.id,
			            graphCache.historyItemRemoteRef.name,
			            graphCache.historyItemRemoteRef.iconId ?? 'cloud',
			          );
			        }

			        const pushRef = (id, name, iconId) => {
			          const refId = String(id ?? '').trim();
			          if (!refId) return;
			          const refIcon = String(iconId ?? '').trim();
			          const key = refId + '|' + refIcon;
			          if (seen.has(key)) return;
			          seen.add(key);
			          refs.push({
			            id: refId,
			            name: String(name ?? '').trim() || refId,
			            iconId: refIcon,
			          });
			        };

			        const nameFromFullRef = refId => {
			          const str = String(refId ?? '').trim();
			          const mapped = refNameById.get(str);
			          if (mapped) return mapped;
			          if (str.startsWith('refs/heads/')) return str.slice('refs/heads/'.length);
			          if (str.startsWith('refs/remotes/')) return str.slice('refs/remotes/'.length);
			          if (str.startsWith('refs/tags/')) return str.slice('refs/tags/'.length);
			          return str;
			        };

			        for (const rawToken of tokens) {
			          let token = String(rawToken ?? '').trim();
			          if (!token) continue;

			          // Skip remote HEAD pointers (VSCode does this)
			          if (token.startsWith('refs/remotes/') && token.endsWith('/HEAD')) {
			            continue;
			          }

			          // Tags
			          if (token.startsWith('tag: ')) {
			            const rest = token.slice('tag: '.length).trim();
			            if (!rest) continue;
			            const full = rest.startsWith('refs/tags/') ? rest : ('refs/tags/' + rest);
			            pushRef(full, nameFromFullRef(full), 'tag');
			            continue;
			          }

			          // HEAD -> branch indicator (use target icon)
			          if (token.startsWith('HEAD -> ')) {
			            const target = token.slice('HEAD -> '.length).trim();
			            if (!target) continue;
			            const mapped = nameToRef.get(target);
			            const refId = mapped?.id ? String(mapped.id) : target;
			            pushRef(refId, nameFromFullRef(refId), 'target');
			            continue;
			          }

			          // General arrows: keep RHS
			          const arrow = token.split(' -> ');
			          if (arrow.length === 2) {
			            token = String(arrow[1] ?? '').trim();
			            if (!token) continue;
			          }

			          if (token.startsWith('refs/heads/')) {
			            pushRef(token, nameFromFullRef(token), 'git-branch');
			            continue;
			          }
			          if (token.startsWith('refs/remotes/')) {
			            pushRef(token, nameFromFullRef(token), 'cloud');
			            continue;
			          }

			          // Fallback: short ref names (decorate=short)
			          const mapped = nameToRef.get(token);
			          if (mapped?.id) {
			            const refId = String(mapped.id);
			            const iconId = String(mapped.iconId ?? '').trim() ||
			              (refId.startsWith('refs/remotes/') ? 'cloud' : refId.startsWith('refs/tags/') ? 'tag' : 'git-branch');
			            pushRef(refId, nameFromFullRef(refId), iconId);
			          } else {
			            pushRef(token, token, 'git-branch');
			          }
			        }

			        return refs;
			      }

			      function getGraphColorMap(historyItemRefs, currentHistoryItemRef, currentHistoryItemRemoteRef, currentHistoryItemBaseRef) {
			        const colorMap = new Map();
			        if (currentHistoryItemRef) {
			          colorMap.set(currentHistoryItemRef.id, HISTORY_ITEM_REF_COLOR);
			          if (currentHistoryItemRemoteRef) colorMap.set(currentHistoryItemRemoteRef.id, HISTORY_ITEM_REMOTE_REF_COLOR);
			          if (currentHistoryItemBaseRef) colorMap.set(currentHistoryItemBaseRef.id, HISTORY_ITEM_BASE_REF_COLOR);
			        }
			        const refs = Array.isArray(historyItemRefs) ? historyItemRefs : [];
			        for (const ref of refs) {
			          if (ref?.id && !colorMap.has(ref.id)) {
			            colorMap.set(ref.id, undefined);
			          }
			        }
			        return colorMap;
			      }

			      function addIncomingOutgoingChangesHistoryItems(
			        viewModels,
			        currentHistoryItemRef,
			        currentHistoryItemRemoteRef,
			        addIncomingChanges,
			        addOutgoingChanges,
			        mergeBase,
			      ) {
			        if (currentHistoryItemRef?.revision === currentHistoryItemRemoteRef?.revision) return;
			        if (!mergeBase) return;

			        // Incoming changes node
			        if (addIncomingChanges && currentHistoryItemRemoteRef && currentHistoryItemRemoteRef.revision !== mergeBase) {
			          const beforeHistoryItemIndex = findLastIdx(
			            viewModels,
			            vm => Array.isArray(vm?.outputSwimlanes) && vm.outputSwimlanes.some(node => node?.id === mergeBase),
			          );
			          const afterHistoryItemIndex = viewModels.findIndex(vm => vm?.historyItem?.id === mergeBase);

			          if (beforeHistoryItemIndex !== -1 && afterHistoryItemIndex !== -1) {
			            const beforeVm = viewModels[beforeHistoryItemIndex];
			            const incomingChangeMerged =
			              Array.isArray(beforeVm?.historyItem?.parentIds) &&
			              beforeVm.historyItem.parentIds.length === 2 &&
			              beforeVm.historyItem.parentIds.includes(mergeBase);

			            if (!incomingChangeMerged) {
			              viewModels[beforeHistoryItemIndex] = {
			                ...beforeVm,
			                inputSwimlanes: (beforeVm.inputSwimlanes ?? []).map(node => {
			                  return node?.id === mergeBase && node?.color === HISTORY_ITEM_REMOTE_REF_COLOR
			                    ? { ...node, id: SCM_INCOMING_HISTORY_ITEM_ID }
			                    : node;
			                }),
			                outputSwimlanes: (beforeVm.outputSwimlanes ?? []).map(node => {
			                  return node?.id === mergeBase && node?.color === HISTORY_ITEM_REMOTE_REF_COLOR
			                    ? { ...node, id: SCM_INCOMING_HISTORY_ITEM_ID }
			                    : node;
			                }),
			              };

			              const inputSwimlanes = (viewModels[beforeHistoryItemIndex].outputSwimlanes ?? []).map(node => ({ ...node }));
			              const outputSwimlanes = (viewModels[afterHistoryItemIndex].inputSwimlanes ?? []).map(node => ({ ...node }));
			              const displayIdLength = viewModels[0]?.historyItem?.displayId?.length ?? 0;

			              const incomingChangesHistoryItem = {
			                id: SCM_INCOMING_HISTORY_ITEM_ID,
			                displayId: '0'.repeat(displayIdLength),
			                parentIds: [mergeBase],
			                author: currentHistoryItemRemoteRef?.name,
			                subject: 'Incoming Changes',
			                message: '',
			                references: [],
			              };

			              viewModels.splice(afterHistoryItemIndex, 0, {
			                historyItem: incomingChangesHistoryItem,
			                kind: 'incoming-changes',
			                inputSwimlanes,
			                outputSwimlanes,
			              });
			            }
			          }
			        }

			        // Outgoing changes node
			        if (addOutgoingChanges && currentHistoryItemRef?.revision && currentHistoryItemRef.revision !== mergeBase) {
			          const currentHistoryItemRefIndex = viewModels.findIndex(
			            vm => vm?.kind === 'HEAD' && vm?.historyItem?.id === currentHistoryItemRef.revision,
			          );

			          if (currentHistoryItemRefIndex !== -1) {
			            const outgoingChangesHistoryItem = {
			              id: SCM_OUTGOING_HISTORY_ITEM_ID,
			              displayId: viewModels[0]?.historyItem?.displayId
			                ? '0'.repeat(viewModels[0].historyItem.displayId.length)
			                : undefined,
			              parentIds: [currentHistoryItemRef.revision],
			              author: currentHistoryItemRef?.name,
			              subject: 'Outgoing Changes',
			              message: '',
			              references: [],
			            };

			            const inputSwimlanes = (viewModels[currentHistoryItemRefIndex].inputSwimlanes ?? []).slice(0);
			            const outputSwimlanes = inputSwimlanes.slice(0).concat({
			              id: currentHistoryItemRef.revision,
			              color: HISTORY_ITEM_REF_COLOR,
			            });

			            viewModels.splice(currentHistoryItemRefIndex, 0, {
			              historyItem: outgoingChangesHistoryItem,
			              kind: 'outgoing-changes',
			              inputSwimlanes,
			              outputSwimlanes,
			            });

			            const next = viewModels[currentHistoryItemRefIndex + 1];
			            if (next && Array.isArray(next.inputSwimlanes)) {
			              next.inputSwimlanes.push({ id: currentHistoryItemRef.revision, color: HISTORY_ITEM_REF_COLOR });
			            }
			          }
			        }
			      }

			      function toHistoryItemViewModelArray(
			        historyItems,
			        colorMap,
			        currentHistoryItemRef,
			        currentHistoryItemRemoteRef,
			        currentHistoryItemBaseRef,
			        addIncomingChanges,
			        addOutgoingChanges,
			        mergeBase,
			      ) {
			        let colorIndex = -1;
			        const items = Array.isArray(historyItems) ? historyItems : [];
			        const viewModels = [];

			        for (let index = 0; index < items.length; index += 1) {
			          const historyItem = items[index];
			          const kind = historyItem?.id === currentHistoryItemRef?.revision ? 'HEAD' : 'node';
			          const outputSwimlanesFromPreviousItem = viewModels.length > 0 ? viewModels[viewModels.length - 1].outputSwimlanes : [];
			          const inputSwimlanes = Array.isArray(outputSwimlanesFromPreviousItem)
			            ? outputSwimlanesFromPreviousItem.map(node => ({ ...node }))
			            : [];
			          const outputSwimlanes = [];

			          let firstParentAdded = false;
			          const parentIds = Array.isArray(historyItem?.parentIds) ? historyItem.parentIds : [];

			          // Add first parent to the output
			          if (parentIds.length > 0) {
			            for (const node of inputSwimlanes) {
			              if (node?.id === historyItem.id) {
			                if (!firstParentAdded) {
			                  outputSwimlanes.push({
			                    id: parentIds[0],
			                    color: getLabelColorIdentifier(historyItem, colorMap) ?? node.color,
			                  });
			                  firstParentAdded = true;
			                }
			                continue;
			              }
			              outputSwimlanes.push({ ...node });
			            }
			          }

			          // Add unprocessed parent(s) to the output
			          for (let i = firstParentAdded ? 1 : 0; i < parentIds.length; i += 1) {
			            let colorIdentifier;
			            if (i === 0) {
			              colorIdentifier = getLabelColorIdentifier(historyItem, colorMap);
			            } else {
			              const parent = items.find(h => h?.id === parentIds[i]);
			              colorIdentifier = parent ? getLabelColorIdentifier(parent, colorMap) : undefined;
			            }

			            if (!colorIdentifier) {
			              colorIndex = rot(colorIndex + 1, GRAPH_COLORS.length);
			              colorIdentifier = GRAPH_COLORS[colorIndex];
			            }

			            outputSwimlanes.push({ id: parentIds[i], color: colorIdentifier });
			          }

			          const references = (historyItem?.references ?? []).map(ref => {
			            let color = colorMap.get(ref.id);
			            if (colorMap.has(ref.id) && color === undefined) {
			              const inputIndex = inputSwimlanes.findIndex(node => node?.id === historyItem.id);
			              const circleIndex = inputIndex !== -1 ? inputIndex : inputSwimlanes.length;
			              color =
			                circleIndex < outputSwimlanes.length
			                  ? outputSwimlanes[circleIndex].color
			                  : circleIndex < inputSwimlanes.length
			                    ? inputSwimlanes[circleIndex].color
			                    : HISTORY_ITEM_REF_COLOR;
			            }
			            return { ...ref, color };
			          });

			          references.sort((a, b) =>
			            compareHistoryItemRefs(a, b, currentHistoryItemRef, currentHistoryItemRemoteRef, currentHistoryItemBaseRef),
			          );

			          viewModels.push({
			            historyItem: {
			              ...historyItem,
			              references,
			            },
			            kind,
			            inputSwimlanes,
			            outputSwimlanes,
			          });
			        }

			        addIncomingOutgoingChangesHistoryItems(
			          viewModels,
			          currentHistoryItemRef,
			          currentHistoryItemRemoteRef,
			          addIncomingChanges,
			          addOutgoingChanges,
			          mergeBase,
			        );

			        return viewModels;
			      }

            function getActiveChecklist() {
              const checklist = state?.activeRun?.checklist;
              return checklist && checklist.mode === 'checklist' ? checklist : null;
            }

            function clipChecklistText(value, max = 90) {
              const text = String(value ?? '').replace(/\\s+/g, ' ').trim();
              if (!text) return '';
              if (text.length <= max) return text;
              return text.slice(0, max - 3) + '...';
            }

            function renderChecklistBoard(checklist) {
              if (!graphList) return;
              if (graphLoadMoreObserver) {
                graphLoadMoreObserver.disconnect();
                graphLoadMoreObserver = null;
              }
              graphVirtualTopSpacer = null;
              graphVirtualRows = null;
              graphVirtualBottomSpacer = null;
              graphLoadMoreRow = null;
              graphLoadMorePlaceholder = null;
              graphLoadMoreLabel = null;
              graphSelectedIndex = -1;
              graphViewModels = [];
              graphList.textContent = '';

              const columns = Array.isArray(checklist?.columns) ? checklist.columns : [];
              const rows = Array.isArray(checklist?.rows) ? checklist.rows : [];
              const counts = checklist?.counts ?? {};

              if (worktreeGraphTitle) {
                worktreeGraphTitle.textContent = 'Checklist Board';
              }
              if (worktreeGraphToolbar) {
                worktreeGraphToolbar.style.display = 'none';
              }
              if (graphMeta) {
                const maxCycles = Number.isFinite(checklist?.maxCycles) ? checklist.maxCycles : 'unbounded';
                graphMeta.style.display = 'block';
                graphMeta.textContent =
                  'targets: ' + rows.length
                  + ' · items: ' + columns.length
                  + ' · running: ' + (counts.running ?? 0)
                  + ' · done: ' + (counts.completed ?? 0)
                  + ' · failed: ' + (counts.failed ?? 0)
                  + ' · blocked: ' + (counts.blocked ?? 0)
                  + ' · continuous: ' + (checklist?.continuous === true ? 'on' : 'off')
                  + ' · max cycles: ' + maxCycles
                  + ' · output root: ' + (checklist?.outputRoot ?? '-');
              }

              if (rows.length === 0 || columns.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'checklist-empty';
                empty.textContent = 'Checklist mode is active, but there are no visible rows yet.';
                graphList.appendChild(empty);
                return;
              }

              const board = document.createElement('div');
              board.className = 'checklist-board';
              const gridTemplate =
                'minmax(180px, 240px) repeat(' + Math.max(columns.length, 1) + ', minmax(160px, 1fr))';

              const header = document.createElement('div');
              header.className = 'checklist-grid checklist-header';
              header.style.gridTemplateColumns = gridTemplate;

              const targetHead = document.createElement('div');
              targetHead.className = 'checklist-header-cell';
              targetHead.textContent = 'Target';
              header.appendChild(targetHead);

              for (const column of columns) {
                const cell = document.createElement('div');
                cell.className = 'checklist-header-cell';
                cell.textContent = String(column?.label ?? column?.id ?? '').trim();
                header.appendChild(cell);
              }

              board.appendChild(header);

              for (const row of rows) {
                const rowGrid = document.createElement('div');
                rowGrid.className = 'checklist-grid';
                rowGrid.style.gridTemplateColumns = gridTemplate;

                const rowLabel = document.createElement('div');
                rowLabel.className = 'checklist-row-label';

                const rowTitle = document.createElement('div');
                rowTitle.className = 'checklist-row-title';
                rowTitle.textContent = String(row?.label ?? row?.targetId ?? '').trim();
                rowLabel.appendChild(rowTitle);

                const rowMeta = document.createElement('div');
                rowMeta.className = 'checklist-row-meta';
                const cyclePill = document.createElement('span');
                cyclePill.className = 'pill';
                cyclePill.textContent = 'cycle ' + (Number.parseInt(row?.cycle, 10) || 1);
                rowMeta.appendChild(cyclePill);
                if ((Number.parseInt(row?.lastCompletedCycle, 10) || 0) > 0) {
                  const completedPill = document.createElement('span');
                  completedPill.className = 'pill';
                  completedPill.textContent = 'last done ' + row.lastCompletedCycle;
                  rowMeta.appendChild(completedPill);
                }
                rowLabel.appendChild(rowMeta);

                if (row?.description) {
                  const rowDescription = document.createElement('div');
                  rowDescription.className = 'checklist-row-description';
                  rowDescription.textContent = clipChecklistText(row.description, 180);
                  rowLabel.appendChild(rowDescription);
                }

                rowGrid.appendChild(rowLabel);

                for (const cellData of Array.isArray(row?.cells) ? row.cells : []) {
                  const status = String(cellData?.status ?? 'pending').trim() || 'pending';
                  const statusInfo = statusBadge(status);
                  const tagText = composeStatusTag(status, cellData?.lastActivityKind ?? null);

                  const cell = document.createElement('div');
                  cell.className = ('checklist-cell ' + status + ' ' + statusInfo.cls).trim();

                  const head = document.createElement('div');
                  head.className = 'checklist-cell-head';

                  const title = document.createElement('div');
                  title.className = 'checklist-cell-title';
                  title.textContent = String(cellData?.itemLabel ?? cellData?.itemId ?? '').trim();
                  head.appendChild(title);

                  if (status === 'running') {
                    const spinner = document.createElement('span');
                    spinner.className = 'icon spin';
                    spinner.textContent = iconGlyph('loading');
                    head.appendChild(spinner);
                  }

                  cell.appendChild(head);

                  const subtitle = document.createElement('div');
                  subtitle.className = 'checklist-cell-subtitle';
                  subtitle.textContent = clipChecklistText(
                    cellData?.error
                      ?? cellData?.lastActivity
                      ?? cellData?.outputPath
                      ?? '',
                    140,
                  ) || '-';
                  cell.appendChild(subtitle);

                  const footer = document.createElement('div');
                  footer.className = 'checklist-cell-footer';

                  const badge = document.createElement('span');
                  badge.className = ('badge ' + statusInfo.cls).trim();
                  badge.textContent = tagText;
                  footer.appendChild(badge);

                  const age = document.createElement('span');
                  age.textContent = Number.isFinite(cellData?.lastActivityAt)
                    ? formatAgo(cellData.lastActivityAt)
                    : '';
                  footer.appendChild(age);

                  cell.appendChild(footer);
                  rowGrid.appendChild(cell);
                }

                board.appendChild(rowGrid);
              }

              graphList.appendChild(board);
            }

			      function ensureGraphDom() {
              if (getActiveChecklist()) return false;
			        if (!graphScroll || !graphList) return false;
			        if (graphVirtualRows) return true;

			        graphList.textContent = '';

			        graphVirtualTopSpacer = document.createElement('div');
			        graphVirtualRows = document.createElement('div');
			        graphVirtualRows.style.display = 'flex';
			        graphVirtualRows.style.flexDirection = 'column';
			        graphVirtualBottomSpacer = document.createElement('div');

			        graphLoadMoreRow = document.createElement('div');
			        graphLoadMoreRow.className = 'graph-row load-more history-item-load-more disabled';
			        graphLoadMoreRow.setAttribute('data-role', 'load-more');

			        graphLoadMorePlaceholder = document.createElement('div');
			        graphLoadMorePlaceholder.className = 'graph-container graph-placeholder';
			        graphLoadMoreRow.appendChild(graphLoadMorePlaceholder);

			        graphLoadMoreLabel = document.createElement('div');
			        graphLoadMoreLabel.className = 'history-item-placeholder';
			        graphLoadMoreRow.appendChild(graphLoadMoreLabel);

			        graphLoadMoreRow.addEventListener('click', () => {
			          const pageOnScroll = graphPageOnScrollInput ? graphPageOnScrollInput.checked : true;
			          if (pageOnScroll) return;
			          loadMoreGraph().catch(() => {});
			        });

			        graphList.appendChild(graphLoadMoreRow);
			        graphList.appendChild(graphVirtualTopSpacer);
			        graphList.appendChild(graphVirtualRows);
			        graphList.appendChild(graphVirtualBottomSpacer);

				        graphScroll.tabIndex = 0;
			        graphScroll.addEventListener('scroll', ev => {
			          hideGraphHover();
			          updateGraphVirtual(false);
			          if (ev?.isTrusted) {
			            noteGraphUserScroll();
			          }
			        });

			        graphScroll.addEventListener('click', ev => {
			          const row = ev.target?.closest?.('.graph-row[data-index]');
			          if (!row) return;
			          graphScroll.focus?.();
			          hideGraphHover();
			          const idx = Number.parseInt(row.getAttribute('data-index') ?? '', 10);
			          if (!Number.isFinite(idx)) return;
			          setGraphSelectedIndex(idx);
			          const viewModel = graphViewModels?.[idx];
			          const taskId = taskIdFromGraphRefs(viewModel?.historyItem?.references);
			          const agentId = resolveTaskAgentId(taskId);
			          if (agentId) selectAgent(agentId, { focusLogs: true });
			        });

			        graphScroll.addEventListener('keydown', ev => {
			          if (!graphViewModels || graphViewModels.length === 0) return;
			          if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
			          ev.preventDefault();
			          const delta = ev.key === 'ArrowDown' ? 1 : -1;
			          const next = Math.max(0, Math.min(graphViewModels.length - 1, (graphSelectedIndex >= 0 ? graphSelectedIndex : 0) + delta));
			          setGraphSelectedIndex(next);
			          hideGraphHover();
			          ensureGraphIndexVisible(next);
			        });

			        return true;
			      }

			      function ensureGraphIndexVisible(index) {
			        if (!graphScroll) return;
			        const rowH = 22;
			        const loadMoreOffset = graphHasMore ? rowH : 0;
			        const top = loadMoreOffset + index * rowH;
			        const bottom = top + rowH;
			        const viewTop = graphScroll.scrollTop;
			        const viewBottom = viewTop + (graphScroll.clientHeight ?? 0);
			        if (top < viewTop) {
			          graphScroll.scrollTop = top;
			        } else if (bottom > viewBottom) {
			          graphScroll.scrollTop = Math.max(0, bottom - (graphScroll.clientHeight ?? 0));
			        }
			      }

			      function formatGraphSubject(subject) {
			        const raw = String(subject ?? '').trim();
			        if (!raw) return '';
			        let next = raw;
			        next = next.replace(/refs\\/heads\\/cdx\\/task\\/[^/'"\\s]+\\/([^/'"\\s]+)/g, 'cdx/task/$1');
			        next = next.replace(/cdx\\/task\\/[^/'"\\s]+\\/([^/'"\\s]+)/g, 'cdx/task/$1');
			        next = next.replace(/refs\\/heads\\/cdx\\/integration\\/[^/'"\\s]+/g, 'cdx/integration');
			        next = next.replace(/cdx\\/integration\\/[^/'"\\s]+/g, 'cdx/integration');
			        return next;
			      }

			      function buildHistoryItems(commits, mergeBase) {
			        const list = Array.isArray(commits) ? commits : [];
			        const base = typeof mergeBase === 'string' && mergeBase.trim() ? mergeBase.trim() : null;
			        const items = list.map(commit => {
			          const refs = parseHistoryItemReferences(commit?.decorations);
			          if (base && commit?.id === base) {
			            refs.push({ id: 'merge-base', name: 'Merge Base' });
			          }
			          const rawSubject = String(commit?.subject ?? '');
			          const subject = formatGraphSubject(rawSubject);
			          return {
			            id: commit?.id,
			            parentIds: Array.isArray(commit?.parents) ? commit.parents : [],
			            subject,
			            message: rawSubject,
			            displayId: String(commit?.shortId ?? ''),
			            author: commit?.author ? String(commit.author) : '',
			            timestamp: typeof commit?.timestamp === 'number' ? commit.timestamp : undefined,
			            references: refs,
			          };
			        });
			        return items.filter(item => item?.id);
			      }

			      function buildGraphModelsFromCache(cache) {
			        const providedRefs = Array.isArray(cache?.historyItemRefs) ? cache.historyItemRefs : [];
			        const selectedRefs = Array.isArray(cache?.selectedRefs) ? cache.selectedRefs : [];
			        const historyItemRefs = providedRefs.length > 0
			          ? providedRefs.map(ref => ({ ...ref }))
			          : selectedRefs
			            .map(name => String(name ?? '').trim())
			            .filter(Boolean)
			            .map(name => ({ id: name, name }));

			        const historyItemRef = cache?.historyItemRef ?? null;
			        const historyItemRemoteRef = cache?.historyItemRemoteRef ?? null;
			        const mergeBase = cache?.mergeBase ?? null;
			        const historyItemBaseRef = mergeBase ? { id: 'merge-base', name: 'Merge Base', revision: mergeBase } : null;

			        const colorMap = getGraphColorMap(historyItemRefs, historyItemRef, historyItemRemoteRef, historyItemBaseRef);
			        const items = buildHistoryItems(graphCommits, mergeBase);

			        const historyItemRefIds = new Set(historyItemRefs.map(ref => ref.id));
			        const addIncomingChangesNode = Boolean(cache?.incomingChanges) && Boolean(historyItemRemoteRef) && historyItemRefIds.has(historyItemRemoteRef.id);
			        const addOutgoingChangesNode = Boolean(cache?.outgoingChanges) && Boolean(historyItemRef) && historyItemRefIds.has(historyItemRef.id);

			        const viewModels = toHistoryItemViewModelArray(
			          items,
			          colorMap,
			          historyItemRef,
			          historyItemRemoteRef,
			          historyItemBaseRef,
			          addIncomingChangesNode,
			          addOutgoingChangesNode,
			          mergeBase,
			        );

			        return { viewModels, colorMap };
			      }

				      function groupByKey(items, keyFn) {
				        const arr = Array.isArray(items) ? items : [];
				        const fn = typeof keyFn === 'function' ? keyFn : null;
			        const map = new Map();
			        for (const item of arr) {
			          const key = fn ? String(fn(item) ?? '') : '';
			          if (!map.has(key)) map.set(key, []);
			          map.get(key).push(item);
			        }
				        return map;
				      }

				      function iconGlyph(iconId) {
				        const id = String(iconId ?? '').trim();
				        switch (id) {
				          case 'git-branch':
				            return '⎇';
				          case 'cloud':
				            return '⇅';
				          case 'tag':
				            return '⌗';
				          case 'target':
				            return '●';
				          case 'worktree':
				            return '▦';
				          case 'fold-down':
				            return '▾';
				          case 'fold-up':
				            return '▴';
				          case 'loading':
				            return '↻';
				          default:
				            return '';
				        }
				      }

				      function renderHistoryItemBadge(historyItemRefs, showDescription) {
				        const refs = Array.isArray(historyItemRefs) ? historyItemRefs : [];
				        if (refs.length === 0) return null;
				        const first = refs[0] ?? {};
			        const iconId = String(first?.iconId ?? '').trim();
			        if (!iconId) return null;

			        const colored = Boolean(first?.color);
			        const label = document.createElement('div');
			        label.className = 'label';
			        label.style.backgroundColor = colored ? String(first.color) : 'var(--vscode-badge-background)';
			        label.style.color = colored ? 'var(--vscode-sideBar-background)' : 'var(--vscode-foreground)';

			        const count = document.createElement('div');
			        count.className = 'count';
			        count.textContent = refs.length > 1 ? String(refs.length) : '';
				        if (refs.length <= 1) count.style.display = 'none';

				        const icon = document.createElement('div');
				        icon.className = 'icon';
				        icon.textContent = iconGlyph(iconId);

				        const description = document.createElement('div');
				        description.className = 'description';
				        description.textContent = showDescription ? String(first?.name ?? '') : '';
			        if (!showDescription) description.style.display = 'none';

			        label.appendChild(count);
			        label.appendChild(icon);
			        label.appendChild(description);
			        return label;
			      }

			      function renderHistoryItemBadges(historyItem, labelContainer) {
			        if (!labelContainer) return;
			        const badgeMode = String(graphBadgesSelect?.value ?? 'filter');
			        const showAllBadges = badgeMode === 'all';

			        const refs = Array.isArray(historyItem?.references) ? historyItem.references.slice(0) : [];
			        if (refs.length === 0) return;

			        // If the first reference is colored, render it separately with description.
			        if (refs.length > 0 && refs[0]?.color) {
			          const first = renderHistoryItemBadge([refs[0]], true);
			          if (first) labelContainer.appendChild(first);
			          refs.splice(0, 1);
			        }

			        const refsByColor = groupByKey(refs, ref => (ref?.color ? String(ref.color) : ''));

			        for (const [colorKey, group] of refsByColor.entries()) {
			          if (colorKey === '' && !showAllBadges) continue;
			          if (!group || group.length === 0) continue;

			          const refsByIcon = groupByKey(group, ref => String(ref?.iconId ?? ''));
			          for (const [iconKey, iconGroup] of refsByIcon.entries()) {
			            if (!iconKey) continue;
			            const badge = renderHistoryItemBadge(iconGroup, false);
			            if (!badge) continue;
			            labelContainer.appendChild(badge);
			          }
			        }
			      }

				      function branchIdCandidates(branch) {
				        const raw = String(branch ?? '').trim();
				        if (!raw) return [];
				        const candidates = new Set([raw]);
				        candidates.add('refs/heads/' + raw);
				        candidates.add('refs/remotes/' + raw);
				        candidates.add('refs/tags/' + raw);
				        return [...candidates.values()];
				      }

			      function appendWorktreeAnnotationBadges(labelContainer, refs) {
			        if (!labelContainer) return;
			        const annotations = Array.isArray(graphCache?.worktreeAnnotations) ? graphCache.worktreeAnnotations : [];
			        if (annotations.length === 0) return;

			        const refIds = Array.isArray(refs) ? refs.map(ref => String(ref?.id ?? '').trim()).filter(Boolean) : [];
			        const idSet = new Set(refIds);

			        for (const id of refIds) {
			          if (id.startsWith('refs/heads/')) idSet.add(id.slice('refs/heads/'.length));
			          if (id.startsWith('refs/remotes/')) idSet.add(id.slice('refs/remotes/'.length));
			          if (id.startsWith('refs/tags/')) idSet.add(id.slice('refs/tags/'.length));
			        }

			        for (const ann of annotations) {
			          const branch = String(ann?.branch ?? '').trim();
			          if (!branch) continue;
			          const matches = branchIdCandidates(branch).some(candidate => idSet.has(candidate));
			          if (!matches) continue;

			          const label = String(ann?.label ?? '').trim();
			          const text = String(ann?.text ?? '').trim();
			          if (!label || !text) continue;

			          const badge = document.createElement('div');
			          badge.className = 'label';
			          badge.style.backgroundColor = 'rgba(56,189,248,0.18)';
			          badge.style.color = 'var(--vscode-foreground)';

			          const count = document.createElement('div');
			          count.className = 'count';
				          count.style.display = 'none';

				          const icon = document.createElement('div');
				          icon.className = 'icon';
				          icon.textContent = iconGlyph('worktree');

				          const description = document.createElement('div');
				          description.className = 'description';
				          description.textContent = label + ': ' + text;

			          badge.appendChild(count);
			          badge.appendChild(icon);
			          badge.appendChild(description);
			          labelContainer.appendChild(badge);
			        }
			      }

			      function ensureGraphHoverDom() {
			        if (graphHoverEl) return graphHoverEl;
			        const el = document.createElement('div');
			        el.className = 'graph-hover';
			        document.body.appendChild(el);
			        graphHoverEl = el;
			        return el;
			      }

			      function hideGraphHover() {
			        if (graphHoverTimer) {
			          clearTimeout(graphHoverTimer);
			          graphHoverTimer = null;
			        }
			        graphHoverIndex = null;
			        if (!graphHoverEl) return;
			        graphHoverEl.style.display = 'none';
			        graphHoverEl.textContent = '';
			      }

			      function formatHistoryItemTimestamp(ts) {
			        const num = Number(ts);
			        if (!Number.isFinite(num) || num <= 0) return '';
			        try {
			          return new Date(num).toLocaleString();
			        } catch {
			          return '';
			        }
			      }

			      function buildGraphHoverContent(viewModel) {
			        const historyItem = viewModel?.historyItem ?? {};
			        const container = document.createElement('div');
			        container.className = 'history-item-hover-container';

			        const subject = String(historyItem.subject ?? '').trim();
			        if (subject) {
			          const p = document.createElement('p');
			          p.textContent = subject;
			          container.appendChild(p);
			        }

			        const author = String(historyItem.author ?? '').trim();
			        const time = formatHistoryItemTimestamp(historyItem.timestamp);
			        const metaParts = [];
			        if (author) metaParts.push(author);
			        if (time) metaParts.push(time);
			        if (metaParts.length > 0) {
			          const p = document.createElement('p');
			          p.textContent = metaParts.join(' · ');
			          container.appendChild(p);
			        }

			        const id = String(historyItem.id ?? '').trim();
			        if (id) {
			          const p = document.createElement('p');
			          p.style.fontFamily = 'var(--mono)';
			          p.textContent = id;
			          container.appendChild(p);
			        }

			        const refs = Array.isArray(historyItem.references) ? historyItem.references : [];
			        if (refs.length > 0) {
			          const wrap = document.createElement('div');
			          wrap.className = 'hover-refs';
			          for (const ref of refs.slice(0, 16)) {
			            const name = String(ref?.name ?? '').trim();
			            if (!name) continue;
			            const iconId = String(ref?.iconId ?? '').trim();

			            const pill = document.createElement('span');
			            pill.className = 'hover-ref';
			            if (ref?.color) {
			              pill.classList.add('colored');
			              pill.style.backgroundColor = String(ref.color);
			            }

				            if (iconId) {
				              const icon = document.createElement('span');
				              icon.className = 'icon';
				              icon.textContent = iconGlyph(iconId);
				              pill.appendChild(icon);
				            }

			            const text = document.createElement('span');
			            text.textContent = name;
			            pill.appendChild(text);

			            wrap.appendChild(pill);
			          }
			          if (wrap.childNodes.length > 0) {
			            container.appendChild(wrap);
			          }
			        }

			        return container;
			      }

			      function positionGraphHover(hover, rowRect, anchor) {
			        const anchorX = Number.isFinite(anchor?.x) ? anchor.x : rowRect.left + 8;
			        const anchorY = Number.isFinite(anchor?.y) ? anchor.y : rowRect.top + 4;
			        const hoverRect = hover.getBoundingClientRect();

			        let x = anchorX + 16;
			        if (x + hoverRect.width > window.innerWidth - 8) {
			          x = anchorX - hoverRect.width - 16;
			        }
			        x = Math.max(8, Math.min(x, window.innerWidth - hoverRect.width - 8));

			        let y = anchorY + 12;
			        if (y + hoverRect.height > window.innerHeight - 8) {
			          y = window.innerHeight - hoverRect.height - 8;
			        }
			        y = Math.max(8, Math.min(y, window.innerHeight - hoverRect.height - 8));

			        hover.style.left = Math.round(x) + 'px';
			        hover.style.top = Math.round(y) + 'px';
			      }

			      function showGraphHover(rowEl, viewModel, index, anchor) {
			        if (!rowEl) return;
			        const hover = ensureGraphHoverDom();
			        hover.textContent = '';
			        hover.appendChild(buildGraphHoverContent(viewModel));
			        hover.style.display = 'block';
			        hover.style.visibility = 'hidden';

			        const rowRect = rowEl.getBoundingClientRect();
			        positionGraphHover(hover, rowRect, anchor);
			        hover.style.visibility = '';
			        graphHoverIndex = index;
			      }

			      function scheduleGraphHover(rowEl, viewModel, index, anchor) {
			        if (!rowEl || !viewModel) return;
			        if (graphHoverTimer) {
			          clearTimeout(graphHoverTimer);
			          graphHoverTimer = null;
			        }
			        graphHoverToken += 1;
			        const token = graphHoverToken;
			        graphHoverTimer = setTimeout(() => {
			          graphHoverTimer = null;
			          if (token !== graphHoverToken) return;
			          if (!document.body.contains(rowEl)) return;
			          showGraphHover(rowEl, viewModel, index, anchor);
			        }, 350);
			      }

			      function createGraphRow(viewModel, index) {
			        const row = document.createElement('div');
			        row.className = 'graph-row';
			        row.setAttribute('data-index', String(index));
			        if (index === graphSelectedIndex) row.classList.add('selected');

			        const wrapper = document.createElement('div');
			        wrapper.className = 'history-item';
			        row.appendChild(wrapper);

			        const graphContainer = document.createElement('div');
			        graphContainer.className = 'graph-container';
			        graphContainer.classList.add('flip-y');
			        if (viewModel?.kind === 'HEAD') graphContainer.classList.add('current');
			        if (viewModel?.kind === 'incoming-changes') graphContainer.classList.add('incoming-changes');
			        if (viewModel?.kind === 'outgoing-changes') graphContainer.classList.add('outgoing-changes');
			        graphContainer.appendChild(renderHistoryItemGraph(viewModel));
			        wrapper.appendChild(graphContainer);

			        const label = document.createElement('div');
			        label.className = 'monaco-icon-label';
			        if (viewModel?.kind === 'HEAD') label.classList.add('history-item-current');

			        const nameEl = document.createElement('span');
			        nameEl.className = 'label-name';
			        nameEl.textContent = String(viewModel?.historyItem?.subject ?? '').trim();
			        label.appendChild(nameEl);

			        const author = String(viewModel?.historyItem?.author ?? '').trim();
			        if (author) {
			          const authorEl = document.createElement('span');
			          authorEl.className = 'label-description';
			          authorEl.textContent = author;
			          label.appendChild(authorEl);
			        }

			        const displayId = String(viewModel?.historyItem?.displayId ?? '').trim();
			        if (displayId) {
			          const hashEl = document.createElement('span');
			          hashEl.className = 'label-hash';
			          hashEl.textContent = displayId;
			          label.appendChild(hashEl);
			        }

			        wrapper.appendChild(label);

			        const labelContainer = document.createElement('div');
			        labelContainer.className = 'label-container';
			        const refs = Array.isArray(viewModel?.historyItem?.references) ? viewModel.historyItem.references : [];
			        renderHistoryItemBadges(viewModel?.historyItem, labelContainer);
			        appendWorktreeAnnotationBadges(labelContainer, refs);
			        if (labelContainer.childNodes.length > 0) {
			          wrapper.appendChild(labelContainer);
			        }

			        row.addEventListener('mouseenter', event => {
			          graphHoverAnchor = event ? { x: event.clientX, y: event.clientY } : null;
			          scheduleGraphHover(row, viewModel, index, graphHoverAnchor);
			        });
			        row.addEventListener('mousemove', event => {
			          if (!event) return;
			          graphHoverAnchor = { x: event.clientX, y: event.clientY };
			          if (graphHoverEl && graphHoverEl.style.display === 'block' && graphHoverIndex === index) {
			            positionGraphHover(graphHoverEl, row.getBoundingClientRect(), graphHoverAnchor);
			          }
			        });
			        row.addEventListener('mouseleave', () => hideGraphHover());
			        row.title = '';
			        return row;
			      }

			      function updateGraphVirtual(force) {
              if (getActiveChecklist()) return;
			        if (!ensureGraphDom()) return;
			        hideGraphHover();

			        const rowH = 22;
			        const overscan = 40;
			        const total = Array.isArray(graphViewModels) ? graphViewModels.length : 0;

			        const scrollTop = graphScroll.scrollTop;
			        const loadMoreOffset = graphHasMore ? rowH : 0;
			        const adjustedScrollTop = Math.max(0, scrollTop - loadMoreOffset);
			        const clientHeight = graphScroll.clientHeight ?? 0;
			        const start = Math.max(0, Math.floor(adjustedScrollTop / rowH) - overscan);
			        const end = Math.min(total, Math.ceil((adjustedScrollTop + clientHeight) / rowH) + overscan);

			        if (!force && start === graphVirtualStart && end === graphVirtualEnd) {
			          updateGraphLoadMoreRow();
			          return;
			        }

			        graphVirtualStart = start;
			        graphVirtualEnd = end;

			        graphVirtualTopSpacer.style.height = String(start * rowH) + 'px';
			        graphVirtualBottomSpacer.style.height = String((total - end) * rowH) + 'px';

			        graphVirtualRows.textContent = '';
			        const fragment = document.createDocumentFragment();
			        for (let i = start; i < end; i += 1) {
			          fragment.appendChild(createGraphRow(graphViewModels[i], i));
			        }
			        graphVirtualRows.appendChild(fragment);

			        updateGraphLoadMoreRow();
			      }

			      function setGraphSelectedIndex(index) {
			        const total = Array.isArray(graphViewModels) ? graphViewModels.length : 0;
			        if (total <= 0) return;
			        const next = Math.max(0, Math.min(total - 1, Number.parseInt(index, 10) || 0));
			        if (graphSelectedIndex === next) return;
			        graphSelectedIndex = next;
			        updateGraphVirtual(true);
			      }

			      function updateGraphLoadMoreRow() {
			        if (!graphLoadMoreRow || !graphLoadMorePlaceholder || !graphLoadMoreLabel) return;
			        const pageOnScroll = graphPageOnScrollInput ? graphPageOnScrollInput.checked : true;

			        if (!graphHasMore) {
			          graphLoadMoreRow.style.display = 'none';
			          if (graphLoadMoreObserver) {
			            graphLoadMoreObserver.disconnect();
			            graphLoadMoreObserver = null;
			          }
			          return;
			        }

			        graphLoadMoreRow.style.display = 'flex';
			        graphLoadMoreRow.classList.toggle('disabled', pageOnScroll || graphLoadingMore);
			        graphLoadMoreLabel.classList.toggle('shimmer', pageOnScroll);
			        graphLoadMoreLabel.style.flex = '1 1 auto';
			        graphLoadMoreLabel.style.minWidth = '180px';
				        graphLoadMoreLabel.textContent = '';
				        if (!pageOnScroll) {
				          const icon = document.createElement('span');
				          icon.className = 'icon' + (graphLoadingMore ? ' spin' : '');
				          icon.textContent = iconGlyph(graphLoadingMore ? 'loading' : 'fold-up');
				          const text = document.createElement('span');
				          text.textContent = graphLoadingMore ? 'Loading…' : 'Load More…';
				          graphLoadMoreLabel.appendChild(icon);
				          if (text.textContent) graphLoadMoreLabel.appendChild(text);
			        }

			        graphLoadMorePlaceholder.textContent = '';
			        const cols = Array.isArray(graphColumnsForLoadMore) ? graphColumnsForLoadMore : [];
			        graphLoadMorePlaceholder.appendChild(renderHistoryGraphPlaceholder(cols));

			        updateGraphLoadMoreObserver();
			      }

			      function updateGraphLoadMoreObserver() {
			        if (graphLoadMoreObserver) {
			          graphLoadMoreObserver.disconnect();
			          graphLoadMoreObserver = null;
			        }
			        const pageOnScroll = graphPageOnScrollInput ? graphPageOnScrollInput.checked : true;
			        if (!pageOnScroll || !graphHasMore || !graphLoadMoreRow) return;
			        if (!graphScroll) return;

			        graphLoadMoreObserver = new IntersectionObserver(
			          entries => {
			            for (const entry of entries) {
			              if (!entry.isIntersecting) continue;
			              loadMoreGraph().catch(() => {});
			            }
			          },
			          { root: graphScroll, threshold: 0.1 },
			        );
			        graphLoadMoreObserver.observe(graphLoadMoreRow);
			      }

			      function renderGraph(force) {
		        if (getActiveChecklist()) return;
		        if (!graphMeta || !graphScroll || !graphList) return;
		        if (!ensureGraphDom()) return;

		        if (!graphCache || graphCommits.length === 0) {
		          graphViewModels = [];
		          graphColumnsForLoadMore = [];
		          graphSelectedIndex = -1;
		          graphVirtualStart = 0;
		          graphVirtualEnd = 0;
		          graphVirtualTopSpacer.style.height = '0px';
		          graphVirtualBottomSpacer.style.height = '0px';
		          graphVirtualRows.textContent = '';
		          const empty = document.createElement('div');
		          empty.className = 'graph-row';
		          empty.style.color = '#94a3b8';
		          empty.textContent = 'No graph data';
		          graphVirtualRows.appendChild(empty);
		          graphLoadMoreRow.style.display = 'none';
		          return;
		        }

		        const prevTop = graphScroll.scrollTop;
		        const prevLeft = graphScroll.scrollLeft;
		        const scrollAdjustment = graphPendingScrollAdjustment;
		        graphPendingScrollAdjustment = 0;

		        const { viewModels } = buildGraphModelsFromCache(graphCache);
		        graphViewModels = viewModels.slice(0).reverse();
		        graphColumnsForLoadMore = graphViewModels.length > 0 ? (graphViewModels[0].outputSwimlanes ?? []) : [];

		        updateGraphVirtual(Boolean(force));

		        graphScroll.scrollTop = prevTop + scrollAdjustment;
		        graphScroll.scrollLeft = prevLeft;
		        if (scrollAdjustment) updateGraphVirtual(true);
		      }

			      async function fetchGraphPage(runId, skip, settings, force) {
				        const qs =
				          'runId=' + encodeURIComponent(runId) +
				          '&skip=' + encodeURIComponent(String(skip ?? 0)) +
				          '&limit=' + encodeURIComponent(String(settings.pageSize)) +
				          '&simple=' + encodeURIComponent(settings.simple ? '1' : '0') +
				          '&allRefs=' + encodeURIComponent(settings.allRefs ? '1' : '0') +
				          '&decorateAll=' + encodeURIComponent(settings.decorateAll ? '1' : '0') +
				          '&incomingChanges=' + encodeURIComponent(settings.incomingChanges ? '1' : '0') +
				          '&outgoingChanges=' + encodeURIComponent(settings.outgoingChanges ? '1' : '0') +
				          '&worktreeChanges=' + encodeURIComponent(settings.worktreeChanges ? '1' : '0') +
				          '&includeUntracked=' + encodeURIComponent(settings.includeUntracked ? '1' : '0') +
				          '&force=' + encodeURIComponent(force ? '1' : '0');
				        return await fetchJson('/api/graph?' + qs);
				      }

			      async function loadMoreGraph() {
			        if (getActiveChecklist()) return;
			        if (graphLoadingMore) return;
			        const runId = state?.activeRun?.id;
			        if (!runId || !graphCache) return;
			        if (!graphHasMore) return;

				        const simple = graphSimpleInput ? graphSimpleInput.checked : false;
				        const pageSizeInfo = parseGraphPageSize(graphLimitInput?.value ?? '');
				        if (pageSizeInfo.pageSize <= 0) {
				          graphHasMore = false;
				          updateGraphLoadMoreRow();
				          return;
				        }
				        const settings = {
				          pageSize: pageSizeInfo.pageSize,
				          simple,
				          allRefs: simple ? false : (graphAllRefsInput ? graphAllRefsInput.checked : false),
				          decorateAll: simple ? false : String(graphBadgesSelect?.value ?? 'filter') === 'all',
				          incomingChanges: simple ? false : (graphIncomingInput ? graphIncomingInput.checked : true),
				          outgoingChanges: simple ? false : (graphOutgoingInput ? graphOutgoingInput.checked : true),
				          worktreeChanges: simple ? false : (graphWorktreeChangesInput ? graphWorktreeChangesInput.checked : true),
				          includeUntracked: simple ? false : (graphUntrackedInput ? graphUntrackedInput.checked : false),
				        };

			        graphLoadingMore = true;
			        updateGraphLoadMoreRow();

			        try {
				          const data = await fetchGraphPage(runId, graphSkip, settings, false);
				          const page = Array.isArray(data?.commits) ? data.commits : [];
				          if (page.length === 0) {
				            graphHasMore = false;
			          } else {
			            graphCommits = graphCommits.concat(page);
			            graphPendingScrollAdjustment += page.length * 22;
			            graphSkip = Number.isFinite(data?.nextSkip) ? data.nextSkip : graphSkip + page.length;
			            graphHasMore = Boolean(data?.hasMore);
			          }
			          graphCache = { ...graphCache, ...data };
			          renderGraph(true);
			        } catch {
			          // ignore
			        } finally {
			          graphLoadingMore = false;
			          updateGraphLoadMoreRow();
			        }
			      }

				      async function refreshGraph(force) {
				        if (!graphMeta || !graphList) return;
				        if (force) graphRefreshDeferred = false;
                const checklist = getActiveChecklist();
                if (checklist) {
                  graphCache = null;
                  graphCommits = [];
                  graphSkip = 0;
                  graphHasMore = false;
                  graphLoadingMore = false;
                  renderChecklistBoard(checklist);
                  return;
                }
                if (worktreeGraphTitle) {
                  worktreeGraphTitle.textContent = 'Git Commit History';
                }
                if (worktreeGraphToolbar) {
                  worktreeGraphToolbar.style.display = '';
                }
                if (graphMeta) {
                  graphMeta.style.display = '';
                }
				        const runId = state?.activeRun?.id;
				        if (!runId) {
				          graphMeta.textContent = 'graph: no active run';
				          graphCache = null;
				          graphCommits = [];
			          graphSkip = 0;
			          graphHasMore = false;
			          renderGraph(true);
			          return;
			        }

				        const now = Date.now();
				        const throttleMs = GRAPH_THROTTLE_MS;
				        if (!force) {
				          if (graphInFlight) return;
				          if (graphLastRunId === runId && now - graphLastFetchAt < throttleMs) return;
				        }

			        const pageSizeInfo = parseGraphPageSize(graphLimitInput?.value ?? '');
			        const simple = graphSimpleInput ? graphSimpleInput.checked : false;
				        const settings = {
				          pageSize: pageSizeInfo.pageSize,
				          simple,
				          allRefs: simple ? false : (graphAllRefsInput ? graphAllRefsInput.checked : false),
				          decorateAll: simple ? false : String(graphBadgesSelect?.value ?? 'filter') === 'all',
				          incomingChanges: simple ? false : (graphIncomingInput ? graphIncomingInput.checked : true),
				          outgoingChanges: simple ? false : (graphOutgoingInput ? graphOutgoingInput.checked : true),
				          worktreeChanges: simple ? false : (graphWorktreeChangesInput ? graphWorktreeChangesInput.checked : true),
				          includeUntracked: simple ? false : (graphUntrackedInput ? graphUntrackedInput.checked : false),
				        };

				        const requestKey = runId +
				          '|' + String(pageSizeInfo.label) +
				          '|' + String(settings.simple) +
				          '|' + String(settings.allRefs) +
				          '|' + String(settings.decorateAll) +
				          '|' + String(settings.incomingChanges) +
				          '|' + String(settings.outgoingChanges) +
				          '|' + String(settings.worktreeChanges) +
				          '|' + String(settings.includeUntracked);

			        if (graphLastRunId !== runId) {
			        }

			        graphInFlight = true;
			        graphLastRunId = runId;
			        graphLastFetchAt = now;

			        try {
				          const data = await fetchGraphPage(runId, 0, settings, force);
				          const page = Array.isArray(data?.commits) ? data.commits : [];
				          const headId = page.length > 0 ? String(page[0]?.id ?? '') : '';
				          const existingHeadId = graphCommits.length > 0 ? String(graphCommits[0]?.id ?? '') : '';
				          const keyChanged = graphCache && graphCache.requestKey ? graphCache.requestKey !== requestKey : false;

			          if (force || keyChanged || !existingHeadId || (headId && headId !== existingHeadId)) {
			            graphCommits = page;
			            graphSkip = Number.isFinite(data?.nextSkip) ? data.nextSkip : page.length;
			            graphHasMore = Boolean(data?.hasMore) && settings.pageSize > 0;
			            graphSelectedIndex = -1;
			          } else {
			            // Update the top page in-place (decorations/worktree annotations can change)
			            for (let i = 0; i < Math.min(graphCommits.length, page.length); i += 1) {
			                if (String(graphCommits[i]?.id ?? '') !== String(page[i]?.id ?? '')) {
			                  graphCommits = page;
			                  graphSkip = Number.isFinite(data?.nextSkip) ? data.nextSkip : page.length;
			                  graphHasMore = Boolean(data?.hasMore) && settings.pageSize > 0;
			                  graphSelectedIndex = -1;
			                  break;
			                }
			                graphCommits[i] = page[i];
			              }
			          }

			          graphCache = { ...data, requestKey };

			          const focusRefs = Array.isArray(data.selectedRefs)
			            ? data.selectedRefs
			            : Array.isArray(data.refs)
			              ? data.refs
			              : [];
				          const scope = data.allRefs ? 'all' : 'run';
				          const dirtyWorktrees = Number.isFinite(data.dirtyWorktrees) ? data.dirtyWorktrees : 0;
				          const worktreeChangesLabel = data.worktreeChanges ? ('on (dirty ' + String(dirtyWorktrees) + ')') : 'off';
				          const untrackedLabel = settings.includeUntracked ? 'on' : 'off';
				          const upstreamLabel = data.upstreamRef ? ('upstream: ' + data.upstreamRef + '\\n') : '';
				          const pageSizeLabel = settings.pageSize > 0 ? String(settings.pageSize) : 'all';
				          if (settings.simple) {
				            graphMeta.textContent =
				              'branch/merge view · loaded: ' + String(graphCommits.length) +
				              ' · refs: ' + String(focusRefs.length) +
				              ' · page size: ' + pageSizeLabel + '\\n' +
				              'head: ' + (data.headRef ?? '-') +
				              ' · integration: ' + (data.integrationBranch ?? '-') +
				              ' · updated: ' + new Date().toISOString();
				          } else {
				            graphMeta.textContent =
				              'repo: ' + (data.repoRoot ?? '-') + '\\n' +
				              'head: ' + (data.headRef ?? '-') + '\\n' +
				              upstreamLabel +
				              'integration: ' + (data.integrationBranch ?? '-') + '\\n' +
				              'scope: ' + scope + ' · page size: ' + pageSizeLabel + ' · loaded: ' + String(graphCommits.length) + ' · focus refs: ' + String(focusRefs.length) + '\\n' +
				              'badges: ' + String(graphBadgesSelect?.value ?? 'filter') + ' · worktree changes: ' + worktreeChangesLabel + ' · untracked: ' + untrackedLabel + '\\n' +
				              'incoming: ' + (settings.incomingChanges ? 'on' : 'off') + ' · outgoing: ' + (settings.outgoingChanges ? 'on' : 'off') + ' · updated: ' + new Date().toISOString();
				          }

			          renderGraph(true);
			        } catch (err) {
			          graphMeta.textContent = 'graph: failed to load (' + (err?.message ?? String(err ?? 'unknown error')) + ')';
			        } finally {
			          graphInFlight = false;
			        }
			      }

			      function scheduleGraphResize() {
        if (graphResizeTimer) clearTimeout(graphResizeTimer);
        graphResizeTimer = setTimeout(() => {
          updateHeaderHeight();
          const checklist = getActiveChecklist();
          if (checklist) {
            renderChecklistBoard(checklist);
          } else {
            updateGraphVirtual(true);
          }
          refreshTestTaskDag();
        }, 120);
      }
			      window.addEventListener('resize', scheduleGraphResize);

function formatEventText(prefix, text) {
		        const raw = String(text ?? '').split(/\\r?\\n/);
		        if (raw.length === 0) return [];
		        const pad = ' '.repeat(prefix.length);
  return raw.map((line, index) => (index === 0 ? prefix + line : pad + line));
}
      function normalizeItemType(value) {
        return String(value ?? '').trim().toLowerCase().replace(/[-_]/g, '');
      }

      function extractEventItemText(item) {
        if (!item || typeof item !== 'object') return '';
        return pickFirstTextValue(
          item.text,
          item.formattedText,
          item.formatted_text,
          item.aggregatedOutput,
          item.aggregated_output,
          item.output,
          item.output_text,
          item.outputText,
          item.summary,
          item.summaryText,
          item.summary_text,
          item.reasoning,
          item.content,
          item.content?.text,
          item.message?.text,
          item.message?.content,
          item.data?.text,
          item.data?.content,
        );
      }

      function formatEventItem(item, method) {
        if (!item || typeof item !== 'object') return null;
        const rawType = String(item.type ?? '');
        if (!rawType) return null;
        const type = normalizeItemType(rawType);
        const text = extractEventItemText(item);
        const isOutputType =
          type === 'aggregatedoutput'
          || type === 'formattedtext'
          || type === 'formattedoutput'
          || type === 'outputtext'
          || type === 'textoutput';
        const isReasoning =
          type === 'reasoning'
          || type === 'analysis'
          || type === 'agentreasoning';
        const isMessage =
          type === 'agentmessage'
          || type === 'assistantmessage'
          || type === 'message'
          || type.endsWith('message');
        if (method === 'item/completed' && text && (isMessage || isOutputType || isReasoning)) {
          return { kind: 'agentMessage', text };
        }
        if (type === 'commandexecution') {
          return null;
        }
        if (type === 'mcptoolcall') {
          const target = (String(item.server ?? '') + '/' + String(item.tool ?? '')).replace(/\\/$/, '');
          const status = item.status ? (' status=' + item.status) : '';
          return { kind: 'summary', text: ('mcp ' + target + status).trim() };
        }
        if (type === 'filechange') {
          const count = Array.isArray(item.changes) ? item.changes.length : 0;
          const status = item.status ? (' status=' + item.status) : '';
          return { kind: 'summary', text: ('fileChange files=' + count + status).trim() };
        }
        return { kind: 'summary', text: rawType };
      }

      function pickFirstTextValue(...values) {
        for (const value of values) {
          if (typeof value === 'string') {
            const trimmed = value.trim();
            if (trimmed) return trimmed;
          }
          if (Array.isArray(value)) {
            for (const entry of value) {
              const text = typeof entry?.text === 'string' ? entry.text.trim() : '';
              if (text) return text;
            }
          }
        }
        return '';
      }

      function extractReasoningText(params) {
        if (!params || typeof params !== 'object') return '';
        const item = params.item ?? null;
        return pickFirstTextValue(
          item?.text,
          item?.summary,
          item?.summaryText,
          item?.reasoning,
          item?.output_text,
          item?.outputText,
          item?.content,
          params.reasoning,
          params.reasoning_delta,
          params.reasoningDelta,
          params.delta,
          params.text,
          params.content,
          params.content?.text,
          params.data?.delta,
          params.data?.text,
          params.message?.delta,
          params.message?.text,
        );
      }

      function isDeltaMethodName(method) {
        const normalized = String(method ?? "").toLowerCase();
        if (!normalized) return false;
        return normalized.includes("agent_message_delta")
          || normalized.includes("agent_message_content_delta")
          || normalized.includes("reasoning_content_delta")
          || normalized.includes("agent_reasoning_delta")
          || normalized.includes("reasoning_delta");
      }

      function isCommandEventMethod(method) {
        const normalized = String(method ?? "").toLowerCase();
        if (!normalized) return false;
        return normalized.includes("exec_command");
      }

      function formatEventLines(items) {
        const lines = [];
        const list = Array.isArray(items) ? items : [];
        const targetAgent = String(selectedAgent ?? '').trim();
        const targetTask = resolveSelectedTaskId();
        const useRaw = apiRawInput ? apiRawInput.checked : false;
        for (const entry of list) {
          const payload = entry?.payload ?? {};
          const type = String(payload.type ?? '');
          if (!targetAgent) continue;
          const payloadAgent = String(payload.agentId ?? '').trim();
          const payloadTask = String(payload.taskId ?? '').trim();
          if (payloadAgent) {
            if (payloadAgent !== targetAgent && (!targetTask || payloadTask !== targetTask)) continue;
          } else if (!targetTask || payloadTask !== targetTask) {
            continue;
          }

		          const ts = entry?.ts ? ('[' + entry.ts + '] ') : '';
		          const meta = [];
		          if (payload.agentId) meta.push('agent=' + payload.agentId);
		          if (payload.taskId) meta.push('task=' + payload.taskId);
		          if (payload.phase) meta.push('phase=' + payload.phase);
		          const prefix = ts + (meta.length ? meta.join(' ') + ' ' : '');

		          if (useRaw) {
		            lines.push(...formatEventText(prefix, JSON.stringify(entry, null, 2)));
		            continue;
		          }

          if (type !== 'appserver.notification' && type !== 'appserver.request') {
            continue;
          }

		          if (type === 'appserver.request') {
		            const method = payload.method ?? 'request';
		            const params = payload.params ?? {};
		            const itemId = params?.itemId ? (' item=' + params.itemId) : '';
		            const reason = params?.reason ? (' reason=' + params.reason) : '';
		            lines.push((prefix + 'request ' + method + itemId + reason).trim());
		            continue;
		          }

		          const method = payload.method ?? '';
		          if (isDeltaMethodName(method) || isCommandEventMethod(method)) continue;

		          const params = payload.params ?? {};
		          if (method === 'item/completed' || method === 'item/started') {
		            const formatted = formatEventItem(params.item, method);
		            if (formatted?.kind === 'agentMessage') {
		              lines.push(...formatEventText(prefix, formatted.text));
		              continue;
		            }
		            if (formatted?.text) {
		              lines.push(prefix + formatted.text);
		              continue;
		            }
		          }

		          if (method === 'turn/completed') {
		            const turn = params.turn ?? {};
		            const status = turn?.status ?? params.status ?? 'unknown';
		            const turnId = turn?.id ?? params.turnId ?? null;
		            const details = [];
		            if (turnId) details.push('turn=' + turnId);
		            if (status) details.push('status=' + status);
		            lines.push((prefix + 'turn/completed' + (details.length ? ' ' + details.join(' ') : '')).trim());
		            continue;
		          }

		          if (method) {
		            lines.push(prefix + method);
		          }
		        }
		        return lines;
		      }

      function formatPromptLines(items) {
        const lines = [];
        const list = Array.isArray(items) ? items : [];
        const targetAgent = selectedAgent ?? null;
        const useRaw = promptRawInput ? promptRawInput.checked : false;
        for (const entry of list) {
          const payload = entry?.payload ?? {};
          const type = String(payload.type ?? '');
          if (type !== 'prompt.sent' && type !== 'appserver.notification') continue;
          if (targetAgent && payload.agentId && payload.agentId !== targetAgent) continue;

          const ts = entry?.ts ? ('[' + entry.ts + '] ') : '';
          const meta = [];
          if (payload.agentId) meta.push('agent=' + payload.agentId);
          if (payload.taskId) meta.push('task=' + payload.taskId);
          if (payload.phase) meta.push('phase=' + payload.phase);
          if (payload.method) meta.push('method=' + payload.method);
          const prefix = ts + (meta.length ? meta.join(' ') + ' ' : '');

          if (type === 'appserver.notification') {
            const method = payload.method ?? '';
            const params = payload.params ?? {};
            const itemType = String(params?.item?.type ?? '').toLowerCase();
            if (method === 'item/completed' && (itemType === 'reasoning' || itemType === 'analysis')) {
              const text = extractReasoningText(params);
              if (text) {
                lines.push(...formatEventText(prefix + 'reasoning: ', text));
              } else {
                lines.push(prefix + 'reasoning (empty)');
              }
            }
            continue;
          }

          if (useRaw) {
            lines.push(...formatEventText(prefix, JSON.stringify(payload, null, 2)));
            continue;
          }

		          const text =
		            typeof payload.text === 'string'
		              ? payload.text
		              : typeof payload.params?.input?.[0]?.text === 'string'
		                ? payload.params.input[0].text
		                : '';
		          if (text) {
		            lines.push(...formatEventText(prefix, text));
		          } else {
		            lines.push(prefix + '(empty prompt)');
		          }
		        }
		        return lines;
		      }

		      function logStreamKeyFor(runId, agentId) {
		        return String(runId ?? '') + '|' + String(agentId ?? '');
		      }

		      function closeLogStream() {
		        if (logStream) {
		          logStream.close();
		          logStream = null;
		        }
		        logStreamKey = '';
		      }

		      function openLogStream() {
		        if (document.hidden || activeTab !== 'logs' || !selectedAgent) return;
		        const runId = currentRunId();
		        const key = logStreamKeyFor(runId, selectedAgent);
		        if (logStream && logStreamKey === key) return;
		        closeLogStream();

		        const params = new URLSearchParams();
		        if (runId) params.set('runId', runId);
		        params.set('agentId', selectedAgent);
		        if (logAfter > 0) params.set('after', String(logAfter));
		        const url = '/api/logs/stream?' + params.toString();

		        const stream = new EventSource(url);
		        logStream = stream;
		        logStreamKey = key;

		        stream.onmessage = event => {
		          const lastEventId = Number.parseInt(event?.lastEventId, 10);
		          if (Number.isFinite(lastEventId)) logAfter = lastEventId;
		          const data = event?.data ?? '';
		          if (!data) return;
		          let payload = null;
		          if (data[0] === '{') {
		            try {
		              payload = JSON.parse(data);
		            } catch {}
		          }
		          if (payload && typeof payload === 'object') {
		            enqueueLogLines([payload]);
		            return;
		          }
		          const lines = data.replace(/\\r/g, '').split('\\n');
		          if (lines.length > 0 && lines[lines.length - 1] === '') {
		            lines.pop();
		          }
		          if (lines.length > 0) enqueueLogLines(lines);
		        };

		        stream.onerror = () => {
		          if (document.hidden || activeTab !== 'logs' || !selectedAgent) {
		            closeLogStream();
		          }
		        };
		      }

		      async function refreshLogs(reset, timeoutMs = 0) {
		        if (document.hidden) return { timedOut: true, count: 0 };
		        if (activeTab !== 'logs') return { timedOut: true, count: 0 };
		        if (!selectedAgent) return { timedOut: true, count: 0 };

	        if (logsAbortController) {
	          logsAbortController.abort();
	          logsAbortController = null;
	        }

	        const runId = currentRunId();
	        const prefix = runId ? ('runId=' + encodeURIComponent(runId) + '&') : '';
	        const url =
	          '/api/logs?' +
	          prefix +
	          'agentId=' + encodeURIComponent(selectedAgent) +
	          '&after=' + encodeURIComponent(String(logAfter)) +
	          '&limit=500' +
	          '&timeoutMs=' + encodeURIComponent(String(timeoutMs || 0));

	        const controller = new AbortController();
	        logsAbortController = controller;
	        let data;
	        try {
	          data = await fetchJson(url, { signal: controller.signal });
	        } finally {
	          if (logsAbortController === controller) {
	            logsAbortController = null;
	          }
	        }

		        const items = Array.isArray(data?.items) ? data.items : [];
		        const entries = items.map(item => ({
		          text: item?.text ?? '',
		          stream: item?.stream === true,
		        }));
		        enqueueLogLines(entries);
		        logAfter = data?.next ?? logAfter;
		        return { timedOut: Boolean(data?.timedOut), count: items.length };
		      }

      async function refreshApi(reset, timeoutMs = 0) {
        if (document.hidden) return { timedOut: true, count: 0 };
        if (activeTab !== 'api') return { timedOut: true, count: 0 };
        if (!selectedAgent) return { timedOut: true, count: 0 };

        if (apiAbortController) {
          apiAbortController.abort();
          apiAbortController = null;
        }

		        const runId = currentRunId();
		        const prefix = runId ? ('runId=' + encodeURIComponent(runId) + '&') : '';
		        const url =
		          '/api/events?' +
		          prefix +
		          'after=' + encodeURIComponent(String(apiAfterId)) +
		          '&limit=500' +
		          '&timeoutMs=' + encodeURIComponent(String(timeoutMs || 0)) +
		          '&mode=full';

		        const controller = new AbortController();
		        apiAbortController = controller;
		        let data;
		        try {
		          data = await fetchJson(url, { signal: controller.signal });
		        } finally {
		          if (apiAbortController === controller) {
		            apiAbortController = null;
		          }
		        }

		        const items = Array.isArray(data?.items) ? data.items : [];
		        const lines = formatEventLines(items);
		        enqueueApiLines(lines);
		        const next = data?.next ?? data?.lastEventId;
		        apiAfterId = Number.isFinite(next) ? next : apiAfterId;
		        return { timedOut: Boolean(data?.timedOut), count: items.length };
		      }

		      async function refreshPrompts(reset, timeoutMs = 0) {
		        if (document.hidden) return { timedOut: true, count: 0 };
		        if (activeTab !== 'prompts') return { timedOut: true, count: 0 };

		        if (promptAbortController) {
		          promptAbortController.abort();
		          promptAbortController = null;
		        }

		        const runId = currentRunId();
		        const prefix = runId ? ('runId=' + encodeURIComponent(runId) + '&') : '';
		        const url =
		          '/api/events?' +
		          prefix +
		          'after=' + encodeURIComponent(String(promptAfterId)) +
		          '&limit=500' +
		          '&timeoutMs=' + encodeURIComponent(String(timeoutMs || 0)) +
		          '&mode=full';

		        const controller = new AbortController();
		        promptAbortController = controller;
		        let data;
		        try {
		          data = await fetchJson(url, { signal: controller.signal });
		        } finally {
		          if (promptAbortController === controller) {
		            promptAbortController = null;
		          }
		        }

		        const items = Array.isArray(data?.items) ? data.items : [];
		        const lines = formatPromptLines(items);
		        enqueuePromptLines(lines);
		        const next = data?.next ?? data?.lastEventId;
		        promptAfterId = Number.isFinite(next) ? next : promptAfterId;
		        return { timedOut: Boolean(data?.timedOut), count: items.length };
		      }

		      async function refreshGitStatus() {
		        if (document.hidden) return null;
		        if (!selectedWorktreeAgent) {
		          gitStatusEl.textContent = 'No worktree for this agent.';
		          gitChangeIndex = emptyGitChangeIndex();
		          return '';
		        }

	        if (worktreeStatusAbortController) {
	          worktreeStatusAbortController.abort();
	          worktreeStatusAbortController = null;
	        }

	        const controller = new AbortController();
	        worktreeStatusAbortController = controller;
	        try {
	          const runId = currentRunId();
	          const suffix = runId ? ('?runId=' + encodeURIComponent(runId)) : '';
	          const data = await fetchJson(
	            '/api/agents/' + encodeURIComponent(selectedWorktreeAgent) + '/worktree/git/status' + suffix,
	            { signal: controller.signal },
	          );
	          const statusText = typeof data?.status === 'string' ? data.status : '';
	          gitStatusEl.textContent = statusText;
	          gitChangeIndex = buildGitChangeIndex(statusText);
	          return statusText;
	        } catch (err) {
	          const isAbort = err && typeof err === 'object' && err.name === 'AbortError';
	          if (isAbort) throw err;
	          gitStatusEl.textContent = 'No worktree for this agent.';
	          gitChangeIndex = emptyGitChangeIndex();
	          return null;
	        } finally {
	          if (worktreeStatusAbortController === controller) {
	            worktreeStatusAbortController = null;
	          }
	        }
	      }

		      async function refreshTree() {
		        if (document.hidden) return;
		        if (!selectedWorktreeAgent) {
		          treeEl.innerHTML = '<div class="muted">No worktree for this agent.</div>';
		          return;
		        }

	        if (worktreeTreeAbortController) {
	          worktreeTreeAbortController.abort();
	          worktreeTreeAbortController = null;
	        }

	        const rel = normalizeRelPath(pathInput?.value ?? '');
	        if (pathInput && pathInput.value !== rel) pathInput.value = rel;
	        selectedPath = rel;

	        const controller = new AbortController();
	        worktreeTreeAbortController = controller;
	        let data;
	        try {
	          const runId = currentRunId();
	          const prefix = runId ? ('runId=' + encodeURIComponent(runId) + '&') : '';
	          data = await fetchJson(
	            '/api/agents/' + encodeURIComponent(selectedWorktreeAgent) + '/worktree/list?' + prefix + 'path=' + encodeURIComponent(rel),
	            { signal: controller.signal },
	          );
	        } catch (err) {
	          const isAbort = err && typeof err === 'object' && err.name === 'AbortError';
	          if (isAbort) throw err;
	          treeEl.innerHTML = '<div class="muted">No worktree for this agent.</div>';
	          return;
	        } finally {
	          if (worktreeTreeAbortController === controller) {
	            worktreeTreeAbortController = null;
	          }
	        }
	        const index = gitChangeIndex ?? emptyGitChangeIndex();
	        const entries = Array.isArray(data.entries) ? data.entries : [];
	        const existingPaths = new Set(entries.map(ent => normalizeRelPath(ent?.path ?? ent?.name ?? '')).filter(Boolean));
        const deletedEntries = deletedChildrenForDir(index, rel, existingPaths);
        const allEntries = [...entries, ...deletedEntries];
        allEntries.sort((a, b) => {
          const rank = value => value === 'dir' ? 0 : value === 'file' ? 1 : 2;
          const aRank = rank(a?.type);
          const bRank = rank(b?.type);
          if (aRank !== bRank) return aRank - bRank;
          const aKey = String(a?.name ?? a?.path ?? '');
          const bKey = String(b?.name ?? b?.path ?? '');
          return aKey.localeCompare(bKey);
        });
        const header = '<div class="muted" style="margin-bottom:8px;">' +
          'worktree: ' + (data.worktreePath ?? '-') + '</div>';
        if (allEntries.length === 0) {
          treeEl.innerHTML = header + '<div class="muted">Empty</div>';
          return;
        }
	        treeEl.innerHTML = header + allEntries.map(ent => {
	          const type = String(ent?.type ?? 'file');
	          const fullRel = normalizeRelPath(ent?.path ?? ent?.name ?? '');
	          const isDeleted = type === 'deleted' || (fullRel && index.deletedFiles.has(fullRel));
	          const isChanged = !isDeleted && (
	            (type === 'dir' && fullRel && index.changedDirs.has(fullRel)) ||
	            (type !== 'dir' && fullRel && index.changedFiles.has(fullRel))
	          );
	          const icon = type === 'dir' ? '📁' : isDeleted ? '🗑️' : '📄';
	          const cls = isDeleted ? ' deleted' : isChanged ? ' changed' : '';
	          return '<div class="tree-item' + cls + '" data-type="' + type + '" data-path="' + fullRel + '">' +
	            '<span>' + icon + '</span>' +
	            '<span>' + fullRel + '</span>' +
	          '</div>';
		        }).join('');
		      }

      async function openDiff(relPath) {
        if (!selectedWorktreeAgent) return;
        try {
          const runId = currentRunId();
          const prefix = runId ? ('runId=' + encodeURIComponent(runId) + '&') : '';
          const data = await fetchJson('/api/agents/' + encodeURIComponent(selectedWorktreeAgent) + '/worktree/git/diff?' + prefix + 'path=' + encodeURIComponent(relPath));
          fileEl.textContent = data.diff ?? '';
        } catch (err) {
          fileEl.textContent = 'Failed to open diff: ' + (err?.message ?? String(err ?? 'unknown error'));
        }
      }

      async function openFile(relPath, preferDiff) {
        if (!selectedWorktreeAgent) return;
        const normalized = normalizeRelPath(relPath);
        const index = gitChangeIndex ?? emptyGitChangeIndex();
        const isDeleted = Boolean(preferDiff) || (normalized && index.deletedFiles.has(normalized));
        if (isDeleted) {
          await openDiff(normalized);
          return;
        }
        let data;
        try {
          const runId = currentRunId();
          const prefix = runId ? ('runId=' + encodeURIComponent(runId) + '&') : '';
          data = await fetchJson('/api/agents/' + encodeURIComponent(selectedWorktreeAgent) + '/worktree/file?' + prefix + 'path=' + encodeURIComponent(normalized));
        } catch (err) {
          fileEl.textContent = 'Failed to open file: ' + (err?.message ?? String(err ?? 'unknown error'));
          return;
        }
        if (data.binary) {
          fileEl.textContent = 'Binary file (' + (data.size ?? 0) + ' bytes)';
          return;
        }
        const extra = data.truncated ? '\\n\\n[truncated]' : '';
        fileEl.textContent = (data.content ?? '') + extra;
      }

      async function refreshState(options = {}) {
        if (document.hidden && state) return;
        let nextState = null;
        try {
          nextState = await fetchJson(stateUrl());
          setBackendStatus(true);
          hideFallback();
        } catch (err) {
          setBackendStatus(false, err?.message ?? 'fetch failed');
          showFallback('Backend disconnected: ' + (err?.message ?? 'fetch failed'));
          renderRun();
          renderTasks();
          renderAgents();
          renderCardView();
          return;
        }
        state = nextState;
        const pageScrollState = capturePageScrollState();
        const runsList = Array.isArray(state?.runs) ? state.runs : [];
	          if (!options.skipAutoFollow) {
              if (selectedPid) {
                const filtered = filteredRunsByPid(runsList, selectedPid);
                const hasSelected = selectedRunId
                  ? filtered.some(run => run?.id === selectedRunId)
                  : false;
                if (!hasSelected && filtered.length > 0) {
                  const nextRun = pickLatestRun(filtered, state?.activeRunId);
                  if (nextRun?.id) {
                    await applyRunChange(nextRun.id, { follow: false });
                    return;
                  }
                }
              } else {
	              if (selectedRunId && state?.activeRun?.id && state.activeRun.id !== selectedRunId) {
	                await applyRunChange(state.activeRun.id, { follow: false });
	                return;
	              }
	              if (selectedRunId && !state?.activeRun && state?.activeRunId) {
	                await applyRunChange(state.activeRunId, { follow: true });
	                return;
	              }
	              if (followActiveRun && state?.activeRunId && state.activeRunId !== selectedRunId) {
	                await applyRunChange(state.activeRunId, { follow: true });
	                return;
	              }
          }
	          }
          renderJobsList();
          renderRun();
	        renderTasks();
	        renderAgents();
          renderCardView();
          refreshTestTaskDag();
          refreshTestGitTree().catch(() => {});
          refreshWatchdogTurns().catch(() => {});
	        const run = state?.activeRun ?? null;
	        const agents = run?.agents ?? [];
	        const tasks = run?.tasks ?? [];
	        if (!selectedAgent) {
	          const runningTask = Array.isArray(tasks) ? tasks.find(t => t?.status === 'running' && t?.taskId) : null;
	          if (runningTask) {
	            const agentId = resolveTaskAgentId(runningTask.taskId);
	            if (agentId) await selectAgent(agentId);
	          } else if (Array.isArray(agents) && agents.length > 0) {
	            await selectAgent(agents[0].agentId);
	          }
	        }
          restorePageScrollState(pageScrollState);
	      }


	      async function pollState() {
	        if (statePollInFlight) return;
	        statePollInFlight = true;
	        try {
	          await refreshState();
	        } catch {
	          // ignore
	        } finally {
	          statePollInFlight = false;
	        }
	      }

	      if (agentsEl) {
	        agentsEl.addEventListener('click', ev => {
	          const btn = ev.target?.closest?.('button[data-agent]');
	          if (!btn) return;
	          const id = btn.getAttribute('data-agent');
	          if (!id) return;
	          selectAgent(id, { focusLogs: true });
	        });
	      }

	      if (tasksEl) {
	        tasksEl.addEventListener('click', ev => {
	          const btn = ev.target?.closest?.('button[data-task]');
	          if (!btn) return;
	          const taskId = btn.getAttribute('data-task');
	          if (!taskId) return;
	          const agentId = resolveTaskAgentId(taskId);
	          if (!agentId) return;
	          selectAgent(agentId, { focusLogs: true });
	        });
	      }

        if (testTaskDagWrapEl) {
          testTaskDagWrapEl.addEventListener('click', ev => {
            const cell = ev.target?.closest?.('[data-task]');
            if (!cell) return;
            const taskId = cell.getAttribute('data-task');
            if (!taskId) return;
            const agentId = resolveTaskAgentId(taskId);
            if (!agentId) return;
            selectAgent(agentId, { focusLogs: true });
          });
        }

		      if (treeEl) {
		        treeEl.addEventListener('click', ev => {
		          const node = ev.target?.closest?.('.tree-item[data-path]');
		          if (!node) return;
		          const type = node.getAttribute('data-type');
		          const relPath = node.getAttribute('data-path');
		          if (!relPath) return;
		          (async () => {
		            if (type === 'dir') {
		              pathInput.value = relPath;
		              await refreshTree();
		              return;
		            }
		            await openFile(relPath, type === 'deleted');
		          })().catch(() => {});
		        });
		      }

			      document.addEventListener('visibilitychange', async () => {
			        if (document.hidden) {
			          if (eventsAbortController) {
			            eventsAbortController.abort();
			            eventsAbortController = null;
			          }
			          clearTimers();
			          if (refreshTimer) {
			            clearInterval(refreshTimer);
			            refreshTimer = null;
			          }
			          return;
			        }
			        try {
			          await refreshState();
			        } catch {
			          // ignore
			        }
			        try {
			          await syncEventCursor();
			        } catch {
			          // ignore
			        }
			        setActiveTab(activeTab);
			        if (refreshTimer) clearInterval(refreshTimer);
			        refreshTimer = setInterval(() => pollState(), STATE_POLL_MS);
			      });

			      pathInput.addEventListener('change', () => {
			        resetWorktreeBackoff();
			        refreshTree().catch(() => {});
			      });
			      refreshGraphBtn?.addEventListener('click', () => refreshGraph(true).catch(() => {}));
			      graphLimitInput?.addEventListener('change', () => {
			        refreshGraph(true).catch(() => {});
			      });
			      filterInput.addEventListener('input', () => {
			        // no-op: filter applies for new lines only, keep it simple
			      });
			      apiFilterInput?.addEventListener('input', () => {
			        // no-op: filter applies for new lines only, keep it simple
			      });
			      promptFilterInput?.addEventListener('input', () => {
			        // no-op: filter applies for new lines only, keep it simple
			      });
			      if (runIdLocked) {
			        if (jobsButton) jobsButton.style.display = 'none';
			      }
			      jobsButton?.addEventListener('click', () => {
			        if (runIdLocked) return;
			        openJobsOverlay();
			      });
			      jobsClose?.addEventListener('click', () => {
			        closeJobsOverlay();
			      });
			      jobsOverlay?.addEventListener('click', ev => {
			        if (ev.target === jobsOverlay) {
			          closeJobsOverlay();
			        }
			      });
			      jobsFollowLatest?.addEventListener('click', async () => {
			        try {
			          setSelectedPid('');
			          await applyRunChange('', { follow: true });
			        } catch {
			          // ignore
			        } finally {
			          closeJobsOverlay();
			        }
			      });
			      jobsListEl?.addEventListener('click', async ev => {
			        const row = ev.target?.closest?.('.job-row');
			        if (!row) return;
			        const runId = row.dataset.runId ?? '';
			        if (!runId) return;
			        const pid = row.dataset.pid ?? '';
			        try {
			          setSelectedPid(pid && pid !== 'unknown' ? pid : '');
			          await applyRunChange(runId, { follow: false });
			        } catch {
			          // ignore
			        } finally {
			          closeJobsOverlay();
			        }
			      });

			      killRunBtn?.addEventListener('click', async () => {
			        const run = state?.activeRun ?? null;
			        if (!run || run.canKill !== true) return;
			        const pid = state?.serverPid;
			        const pidLabel = pid ? ' (pid ' + pid + ')' : '';
			        const ok = window.confirm(
			          'Force kill this CDX process' + pidLabel + '? This will terminate the server immediately.',
			        );
			        if (!ok) return;
			        killRunBtn.disabled = true;
			        try {
			          await fetch('/api/kill', { method: 'POST' });
			        } catch (err) {
			          killRunBtn.disabled = false;
			          alert('Failed to send kill request: ' + (err?.message ?? String(err ?? 'unknown error')));
			        }
			      });


      function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
      }

      function noteGraphUserScroll() {
        graphAutoRefreshPausedUntil = Date.now() + GRAPH_AUTO_RESUME_DELAY_MS;
      }

      function graphAutoRefreshAllowed(now = Date.now()) {
        if (document.hidden) return false;
        return now >= graphAutoRefreshPausedUntil;
      }

      function startGraphAutoRefreshLoop() {
        if (graphAutoRefreshTimer) return;
        graphAutoRefreshTimer = setInterval(() => {
          if (!graphAutoRefreshAllowed()) return;
          if (graphRefreshDeferred) graphRefreshDeferred = false;
          refreshGraph(false).catch(() => {});
        }, GRAPH_AUTO_REFRESH_MS);
      }

	      async function syncEventCursor() {
	        try {
	          const runId = selectedRunId ? ('runId=' + encodeURIComponent(selectedRunId) + '&') : '';
	          const url = '/api/events?' + runId + 'after=0&timeoutMs=0&mode=signal';
	          const data = await fetchJson(url);
	          const last = Number.parseInt(data?.lastEventId, 10);
	          eventAfterId = Number.isFinite(last) ? last : 0;
	        } catch {
	          eventAfterId = 0;
	        }
	      }

	      async function fetchEventSignal(timeoutMs) {
	        const runId = selectedRunId ? ('runId=' + encodeURIComponent(selectedRunId) + '&') : '';
	        const qs = runId +
	          'after=' + encodeURIComponent(String(eventAfterId)) +
	          '&timeoutMs=' + encodeURIComponent(String(timeoutMs)) +
	          '&mode=signal';
	        const url = '/api/events?' + qs;
	        const controller = new AbortController();
	        eventsAbortController = controller;
	        try {
	          const res = await fetch(url, { cache: 'no-store', signal: controller.signal });
	          if (!res.ok) {
	            const text = await res.text().catch(() => '');
	            throw new Error('Request failed: ' + res.status + ' ' + text);
	          }
	          return await res.json();
	        } finally {
	          if (eventsAbortController === controller) {
	            eventsAbortController = null;
	          }
	        }
	      }

		      function startEventsLoop() {
		        if (eventsLoopRunning) return;
		        eventsLoopRunning = true;
		        (async () => {
	          while (eventsLoopRunning) {
	            if (document.hidden) {
	              await delay(1000);
	              continue;
	            }

	            const now = Date.now();
	            const waitMs = Math.max(0, EVENT_POLL_MIN_INTERVAL_MS - (now - eventsLastPollAt));
	            if (waitMs) await delay(waitMs);
	            eventsLastPollAt = Date.now();

	            let data;
	            try {
	              const timeoutMs = selectedRunId ? EVENT_LONG_POLL_TIMEOUT_MS : EVENT_LATEST_LONG_POLL_TIMEOUT_MS;
	              data = await fetchEventSignal(timeoutMs);
	            } catch (err) {
	              const isAbort = err && typeof err === 'object' && err.name === 'AbortError';
	              if (isAbort) continue;
	              await delay(1500);
	              continue;
	            }

	            const lastId = Number.parseInt(data?.lastEventId, 10);
	            if (Number.isFinite(lastId) && lastId > eventAfterId) {
	              eventAfterId = lastId;
	            }

	            const stateHint = Boolean(data?.hints?.state);
	            const graphHint = Boolean(data?.hints?.graph);

	            if (stateHint) {
	              refreshState().catch(() => {});
	            }

	            if (graphHint) {
	              if (!graphAutoRefreshAllowed()) {
	                graphRefreshDeferred = true;
	              } else {
	                graphRefreshDeferred = false;
	                refreshGraph(false).catch(() => {});
	              }
	            }
	          }
	        })().catch(() => {});
	      }

		      function startLogsLoop() {
		        if (document.hidden || activeTab !== 'logs' || !selectedAgent) {
		          closeLogStream();
		          if (logsAbortController) {
		            logsAbortController.abort();
		            logsAbortController = null;
		          }
		          logsLoopRunning = false;
		          return;
		        }

		        if (window.EventSource) {
		          if (logsAbortController) {
		            logsAbortController.abort();
		            logsAbortController = null;
		          }
		          logsLoopRunning = false;
		          openLogStream();
		          return;
		        }

		        if (logsLoopRunning) return;
		        logsLoopRunning = true;
		        (async () => {
		          while (logsLoopRunning) {
		            if (document.hidden || activeTab !== 'logs' || !selectedAgent) {
		              if (logsAbortController) {
		                logsAbortController.abort();
		                logsAbortController = null;
		              }
		              await delay(500);
		              continue;
		            }

		            const now = Date.now();
		            const waitMs = Math.max(0, LOG_POLL_MIN_INTERVAL_MS - (now - logsLastPollAt));
		            if (waitMs) await delay(waitMs);
		            logsLastPollAt = Date.now();

		            try {
		              await refreshLogs(false, LOG_LONG_POLL_TIMEOUT_MS);
		            } catch (err) {
		              const isAbort = err && typeof err === 'object' && err.name === 'AbortError';
		              if (isAbort) continue;
		              await delay(1000);
		            }
		          }
		        })().catch(() => {});
		      }

		      function startApiLoop() {
		        if (apiLoopRunning) return;
		        apiLoopRunning = true;
		        (async () => {
		          while (apiLoopRunning) {
		            if (document.hidden || activeTab !== 'api') {
		              if (apiAbortController) {
		                apiAbortController.abort();
		                apiAbortController = null;
		              }
		              await delay(500);
		              continue;
		            }

		            const now = Date.now();
		            const waitMs = Math.max(0, API_POLL_MIN_INTERVAL_MS - (now - apiLastPollAt));
		            if (waitMs) await delay(waitMs);
		            apiLastPollAt = Date.now();

		            try {
		              await refreshApi(false, API_LONG_POLL_TIMEOUT_MS);
		            } catch (err) {
		              const isAbort = err && typeof err === 'object' && err.name === 'AbortError';
		              if (isAbort) continue;
		              await delay(1000);
		            }
		          }
		        })().catch(() => {});
		      }

		      function startPromptLoop() {
		        if (promptLoopRunning) return;
		        promptLoopRunning = true;
		        (async () => {
		          while (promptLoopRunning) {
		            if (document.hidden || activeTab !== 'prompts') {
		              if (promptAbortController) {
		                promptAbortController.abort();
		                promptAbortController = null;
		              }
		              await delay(500);
		              continue;
		            }

		            const now = Date.now();
		            const waitMs = Math.max(0, PROMPT_POLL_MIN_INTERVAL_MS - (now - promptLastPollAt));
		            if (waitMs) await delay(waitMs);
		            promptLastPollAt = Date.now();

		            try {
		              await refreshPrompts(false, PROMPT_LONG_POLL_TIMEOUT_MS);
		            } catch (err) {
		              const isAbort = err && typeof err === 'object' && err.name === 'AbortError';
		              if (isAbort) continue;
		              await delay(1000);
		            }
		          }
		        })().catch(() => {});
		      }

		      function nextWorktreeDelayMs(current) {
		        const cur = Number.parseInt(current, 10) || WORKTREE_STATUS_POLL_MIN_MS;
		        if (cur <= WORKTREE_STATUS_POLL_MIN_MS) return Math.min(WORKTREE_STATUS_POLL_MAX_MS, 5000);
		        if (cur <= 5000) return Math.min(WORKTREE_STATUS_POLL_MAX_MS, 10_000);
		        return WORKTREE_STATUS_POLL_MAX_MS;
		      }

		      function startWorktreeLoop() {
		        if (worktreeLoopRunning) return;
		        worktreeLoopRunning = true;
		        (async () => {
		          while (worktreeLoopRunning) {
		            if (document.hidden || activeTab !== 'worktree' || !selectedWorktreeAgent) {
		              if (worktreeStatusAbortController) {
		                worktreeStatusAbortController.abort();
		                worktreeStatusAbortController = null;
		              }
		              if (worktreeTreeAbortController) {
		                worktreeTreeAbortController.abort();
		                worktreeTreeAbortController = null;
		              }
		              worktreeLastStatusText = null;
		              worktreePollDelayMs = WORKTREE_STATUS_POLL_MIN_MS;
		              await delay(500);
		              continue;
		            }

		            const now = Date.now();
		            const waitMs = Math.max(0, worktreePollDelayMs - (now - worktreeLastPollAt));
		            if (waitMs) await delay(waitMs);
		            worktreeLastPollAt = Date.now();

		            let statusText = null;
		            try {
		              statusText = await refreshGitStatus();
		            } catch (err) {
		              const isAbort = err && typeof err === 'object' && err.name === 'AbortError';
		              if (isAbort) continue;
		              statusText = null;
		            }

		            if (typeof statusText !== 'string') {
		              worktreePollDelayMs = nextWorktreeDelayMs(worktreePollDelayMs);
		              continue;
		            }

		            const changed = worktreeLastStatusText === null ? true : statusText !== worktreeLastStatusText;
		            worktreeLastStatusText = statusText;
		            if (changed) {
		              resetWorktreeBackoff();
		              refreshTree().catch(() => {});
		              continue;
		            }
		            worktreePollDelayMs = nextWorktreeDelayMs(worktreePollDelayMs);
		          }
		        })().catch(() => {});
		      }

      async function boot() {
        try {
          await refreshState();
          await syncEventCursor();
          refreshGraph(true).catch(() => {});
        } catch (err) {
          setBackendStatus(false, err?.message ?? 'fetch failed');
          showFallback('Backend disconnected: ' + (err?.message ?? 'fetch failed'));
        }
        startEventsLoop();
        startGraphAutoRefreshLoop();
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = setInterval(() => pollState(), STATE_POLL_MS);
      }

      boot().catch(err => {
        setBackendStatus(false, err?.message ?? 'fetch failed');
        showFallback('UI error: ' + (err?.message ?? 'boot failed'));
        renderRun();
        renderTasks();
        renderAgents();
        renderCardView();
  });

      window.addEventListener('error', event => {
        const message = event?.message ?? 'unknown error';
        showFallback('UI error: ' + message);
      });

      window.addEventListener('unhandledrejection', event => {
        const reason = event?.reason?.message ?? event?.reason ?? 'unknown rejection';
        showFallback('UI error: ' + reason);
      });
    </script>
  </body>
</html>`;

function pickFirstTextValue(...values) {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        const text = typeof entry?.text === 'string' ? entry.text.trim() : '';
        if (text) return text;
      }
    }
  }
  return '';
}

function normalizeItemType(value) {
  if (!value || typeof value !== 'string') return '';
  return value.trim().toLowerCase().replace(/[-_]/g, '');
}

function extractItemRole(item) {
  if (!isObject(item)) return null;
  return pickFirstString(item.role, item.message?.role, item.data?.role);
}

function extractItemText(item) {
  if (!isObject(item)) return '';
  return pickFirstTextValue(
    item.text,
    item.formattedText,
    item.formatted_text,
    item.aggregatedOutput,
    item.aggregated_output,
    item.output,
    item.output_text,
    item.outputText,
    item.summary,
    item.summaryText,
    item.summary_text,
    item.reasoning,
    item.content,
    item.content?.text,
    item.message?.text,
    item.message?.content,
    item.data?.text,
    item.data?.content,
  );
}

function shouldLogMessageItem(item) {
  if (!isObject(item)) return false;
  const type = normalizeItemType(item.type ?? '');
  if (!type) return false;
  const role = extractItemRole(item);
  if (role) {
    const normalizedRole = role.trim().toLowerCase();
    if (['user', 'system', 'developer'].includes(normalizedRole)) return false;
    if (['assistant', 'model'].includes(normalizedRole)) return true;
  }
  if (type === 'usermessage') return false;
  if (type === 'agentmessage' || type === 'assistantmessage' || type === 'message') return true;
  return type.endsWith('message');
}

function isRateLimitMethod(method, params) {
  const normalized = typeof method === 'string' ? method.toLowerCase() : '';
  if (!normalized) return false;
  if (normalized.includes('rate_limit') || normalized.includes('ratelimit')) return true;
  const payload = isObject(params) ? params : null;
  if (!payload) return false;
  return Boolean(
    payload.rateLimits
    || payload.rate_limits
    || payload.rateLimit
    || payload.rate_limit,
  );
}

function summarizeAppserverNotification(method, params) {
  const prefix = `[${method}]`;
  const normalizedMethod = String(method ?? '').toLowerCase();
  if (!params || !isObject(params)) {
    return { line: null, activity: prefix, activityKind: null };
  }
  const isAgentDelta =
    normalizedMethod === 'item/agentmessage/delta'
    || normalizedMethod.includes('agent_message_delta')
    || normalizedMethod.includes('agent_message_content_delta');
  const isReasoningDelta =
    normalizedMethod.includes('reasoning_content_delta')
    || normalizedMethod.includes('agent_reasoning_delta')
    || normalizedMethod.includes('reasoning_delta');
  if (isAgentDelta) {
    if (LOG_AGENT_MESSAGE_DELTAS) {
      return { line: null, activity: `${prefix} agentMessage`, activityKind: 'message' };
    }
    const delta = pickFirstString(
      params.delta,
      params.text,
      params.content,
      params.content?.text,
      params.message?.delta,
      params.message?.text,
      params.data?.delta,
      params.data?.text,
      params.reasoning,
      params.reasoning_delta,
      params.reasoningDelta,
    );
    const trimmed = typeof delta === 'string' ? delta.trim() : '';
    if (!trimmed) {
      return { line: null, activity: `${prefix} agentMessage`, activityKind: 'message' };
    }
    const maxChars = 2000;
    const clipped = trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)} …` : trimmed;
    return { line: clipped, activity: clipped, activityKind: 'message' };
  }
  if (isReasoningDelta) {
    return { line: null, activity: `${prefix} reasoning`, activityKind: 'reasoning' };
  }
  if (normalizedMethod.includes('exec_command')) {
    return { line: null, activity: `${prefix} command`, activityKind: 'commandexec' };
  }
  if (isRateLimitMethod(method, params)) {
    return { line: null, activity: `${prefix} rateLimit`, activityKind: 'ratelimit' };
  }
  const item = params.item;
  if (isObject(item)) {
    const type = normalizeItemType(item.type ?? '') || 'unknown';
    if (method === 'item/completed' && shouldLogMessageItem(item)) {
      const msg = extractItemText(item);
      if (!msg) {
        return { line: null, activity: `${prefix} message`, activityKind: 'message' };
      }
      const maxChars = 4000;
      const clipped = msg.length > maxChars ? `${msg.slice(0, maxChars)} …` : msg;
      return { line: clipped, activity: clipped, activityKind: 'message' };
    }
    if (
      type === 'aggregatedoutput'
      || type === 'formattedtext'
      || type === 'formattedoutput'
      || type === 'outputtext'
      || type === 'textoutput'
    ) {
      const text = extractItemText(item);
      if (!text) {
        return { line: null, activity: `${prefix} output`, activityKind: 'message' };
      }
      const maxChars = 4000;
      const clipped = text.length > maxChars ? `${text.slice(0, maxChars)} …` : text;
      return { line: clipped, activity: clipped, activityKind: 'message' };
    }
    if (type === 'reasoning' || type === 'analysis' || type === 'agentreasoning') {
      const text = extractItemText(item);
      if (!text) {
        return { line: null, activity: `${prefix} reasoning`, activityKind: 'reasoning' };
      }
      const maxChars = 4000;
      const clipped = text.length > maxChars ? `${text.slice(0, maxChars)} …` : text;
      return { line: clipped, activity: clipped, activityKind: 'reasoning' };
    }
    if (type === 'commandexecution') {
      const cmd = typeof item.command === 'string' ? item.command.trim() : '';
      const status = item.status ? String(item.status) : '';
      const exitCode = Number.isFinite(item.exitCode) ? String(item.exitCode) : '';
      const summaryParts = [];
      if (cmd) summaryParts.push(cmd);
      if (status) summaryParts.push('status=' + status);
      if (exitCode) summaryParts.push('exit=' + exitCode);
      const summary = summaryParts.join(' ').trim();
      const cwd = pickFirstString(item.cwd, item.workdir, item.workingDirectory, item.working_directory);
      const activity = summary ? ('command ' + summary) : `${prefix} command`;
      return {
        line: null,
        activity,
        commandSummary: summary || cmd || null,
        cwd: cwd ?? null,
        activityKind: 'commandexec',
      };
    }
    if (type === 'filechange') {
      const count = Array.isArray(item.changes) ? item.changes.length : 0;
      const status = item.status ? (' status=' + item.status) : '';
      return {
        line: ('fileChange files=' + count + status).trim(),
        activity: 'fileChange',
        activityKind: 'filechange',
      };
    }
    if (type === 'mcptoolcall') {
      const target = (String(item.server ?? '') + '/' + String(item.tool ?? '')).replace(/\/$/, '');
      const status = item.status ? (' status=' + item.status) : '';
      const line = ('mcp ' + target + status).trim();
      return { line, activity: line, activityKind: 'toolcall' };
    }
    return { line: null, activity: `${prefix} item: ${type}`, activityKind: null };
  }
  if (method === 'turn/completed') {
    const status = params.turn?.status ?? params.status ?? 'unknown';
    return { line: null, activity: `${prefix} turn: ${status}`, activityKind: null };
  }
  return { line: null, activity: prefix, activityKind: null };
}

function clipSummary(value, max = 120) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (text.length <= max) return text;
  if (max <= 3) return text.slice(0, max);
  return text.slice(0, max - 3) + '...';
}

function summarizeRunTaskSummary(run) {
  if (!run || !(run.tasks instanceof Map)) return null;
  const tasks = [...run.tasks.values()];
  if (tasks.length === 0) return null;

  const taskScore = task =>
    Number(task?.lastActivityAt ?? task?.startedAt ?? task?.finishedAt ?? 0);

  const pickLatest = list => {
    if (!Array.isArray(list) || list.length === 0) return null;
    return list.reduce((best, item) => (taskScore(item) > taskScore(best) ? item : best), list[0]);
  };

  const formatTask = task => {
    const taskId = String(task?.taskId ?? '').trim();
    const desc = clipSummary(task?.description, 80);
    if (taskId && desc) return `${taskId}: ${desc}`;
    if (taskId) return taskId;
    return desc ?? null;
  };

  const running = tasks.filter(task => task?.status === 'running');
  if (running.length > 0) {
    const primary = pickLatest(running);
    const label = formatTask(primary);
    const prefix = running.length > 1 ? `${running.length} running` : 'running';
    return clipSummary(label ? `${prefix} · ${label}` : prefix, 120);
  }

  const recent = pickLatest(tasks);
  if (!recent) return null;
  const status = String(recent.status ?? 'unknown');
  const label = formatTask(recent);
  return clipSummary(label ? `${status} · ${label}` : status, 120);
}

function isCountedAgentForStats(agent) {
  const agentId = typeof agent?.agentId === 'string' ? agent.agentId.trim() : '';
  if (!agentId) return false;
  const normalizedId = agentId.toLowerCase();
  if (normalizedId === 'server' || normalizedId === 'backend') return false;
  const taskId = agent?.taskId;
  if (taskId !== null && taskId !== undefined && String(taskId).trim()) return true;
  const phase = String(agent?.phase ?? '').trim().toLowerCase();
  return phase === 'task' || phase === 'merge';
}

const RUN_IN_FLIGHT_STAGES = new Set([
  'running',
  'queued',
  'waiting',
  'merging',
  'reviewing',
  'validating',
]);

function hasTrackableRunAgentIdentity(agent) {
  const agentId = typeof agent?.agentId === 'string' ? agent.agentId.trim() : '';
  if (!agentId) return false;
  const normalizedId = agentId.toLowerCase();
  return normalizedId !== 'server' && normalizedId !== 'backend';
}

function isActiveRunAgent(agent) {
  if (!hasTrackableRunAgentIdentity(agent)) return false;
  const status = String(agent?.status ?? '').trim().toLowerCase();
  return status === 'running' || status === 'disposing';
}

function countActiveRunAgentsByPhase(agents, phase) {
  if (!Array.isArray(agents)) return 0;
  const normalizedPhase = String(phase ?? '').trim().toLowerCase();
  if (!normalizedPhase) return 0;
  return agents.filter(agent => (
    String(agent?.phase ?? '').trim().toLowerCase() === normalizedPhase && isActiveRunAgent(agent)
  )).length;
}

function readRunActivitySignals(run) {
  const counts = isObject(run?.counts) ? run.counts : {};
  const scheduler = isObject(run?.scheduler) ? run.scheduler : {};
  const agents = Array.isArray(run?.agents) ? run.agents : [];
  return {
    status: String(run?.status ?? '').trim().toLowerCase(),
    tasksRunning: parseNonNegativeInt(counts?.tasksRunning) ?? 0,
    tasksPending: parseNonNegativeInt(counts?.tasksPending) ?? 0,
    tasksSuperseded: parseNonNegativeInt(counts?.tasksSuperseded) ?? 0,
    tasksFailed: parseNonNegativeInt(counts?.tasksFailed) ?? 0,
    tasksBlocked: parseNonNegativeInt(counts?.tasksBlocked) ?? 0,
    agentsRunning: parseNonNegativeInt(counts?.agentsRunning) ?? 0,
    asksPending: parseNonNegativeInt(counts?.asksPending) ?? 0,
    schedulerRunning: parseNonNegativeInt(scheduler?.runningTasks) ?? 0,
    schedulerPending: parseNonNegativeInt(scheduler?.pendingTasks) ?? 0,
    reviewAgents: countActiveRunAgentsByPhase(agents, 'review'),
    checkpointAgents: countActiveRunAgentsByPhase(agents, 'checkpoint'),
    mergeAgents: countActiveRunAgentsByPhase(agents, 'merge'),
    hasActiveAgent: agents.some(agent => isActiveRunAgent(agent)),
  };
}

function hasActiveRunExecutionSignals(signals) {
  return signals.tasksRunning > 0
    || signals.agentsRunning > 0
    || signals.schedulerRunning > 0
    || signals.hasActiveAgent;
}

function hasQueuedRunWorkSignals(signals) {
  return signals.tasksPending > 0
    || signals.asksPending > 0
    || signals.schedulerPending > 0;
}

function hasLiveRunActivitySignals(signals) {
  return hasActiveRunExecutionSignals(signals) || hasQueuedRunWorkSignals(signals);
}

function deriveRunStageFromSignals(signals) {
  const terminalStatus = signals.status === 'failed'
    || signals.status === 'blocked'
    || signals.status === 'completed'
    || signals.status === 'disposed';
  const hasActiveExecution = hasActiveRunExecutionSignals(signals);
  const hasQueuedWork = hasQueuedRunWorkSignals(signals);
  const hasLiveActivity = hasLiveRunActivitySignals(signals);

  if (signals.status === 'disposed') return 'disposed';
  if (signals.asksPending > 0) return 'waiting';
  if (signals.reviewAgents > 0) return 'reviewing';
  if (signals.checkpointAgents > 0) return 'validating';
  if (signals.mergeAgents > 0) return 'merging';
  if (signals.status === 'running' || hasActiveExecution) return 'running';
  if (!terminalStatus && hasQueuedWork) return 'queued';
  if (signals.status === 'blocked') return 'blocked';
  if (signals.status === 'failed') return 'failed';
  if (!hasLiveActivity && signals.tasksBlocked > 0) return 'blocked';
  if (!hasLiveActivity && signals.tasksFailed > 0) return 'failed';
  if (signals.status === 'completed') {
    if (!hasLiveActivity && signals.tasksFailed > 0) return 'failed';
    if (!hasLiveActivity && signals.tasksBlocked > 0) return 'blocked';
    return 'completed';
  }
  if (hasQueuedWork) return 'queued';
  return signals.status || 'unknown';
}

function isRunInFlightStage(stage) {
  return RUN_IN_FLIGHT_STAGES.has(String(stage ?? '').trim().toLowerCase());
}

function canKillRunFromSignals(run, signals, serverPid) {
  const resolvedServerPid = parseNonNegativeInt(serverPid);
  if (resolvedServerPid === null) return false;
  const runPid = parseNonNegativeInt(run?.pid);
  if (runPid !== null && runPid !== resolvedServerPid) return false;
  if (signals.status === 'running') return true;
  return hasLiveRunActivitySignals(signals);
}

function buildRunDerivedState(run, serverPid) {
  const signals = readRunActivitySignals(run);
  const stage = deriveRunStageFromSignals(signals);
  return {
    stage,
    inFlight: isRunInFlightStage(stage),
    canKill: canKillRunFromSignals(run, signals, serverPid),
  };
}

async function readFileLimited(filePath, maxBytes) {
  const handle = await open(filePath, 'r');
  try {
    const info = await handle.stat();
    const size = Number.parseInt(info.size, 10) || 0;
    const toRead = Math.max(0, Math.min(size, maxBytes));
    const buffer = Buffer.alloc(toRead);
    const { bytesRead } = await handle.read(buffer, 0, toRead, 0);
    const slice = buffer.subarray(0, bytesRead);
    const binary = slice.includes(0);
    return {
      binary,
      size,
      truncated: size > maxBytes,
      content: binary ? null : slice.toString('utf8'),
    };
  } finally {
    await handle.close().catch(() => {});
  }
}

export class CdxStatsServer {
  constructor({
    enabled = (process.env.CDX_STATS_ENABLED ?? '1') === '1',
    host = process.env.CDX_STATS_HOST ?? '127.0.0.1',
    port = Number.parseInt(process.env.CDX_STATS_PORT ?? '0', 10) || 0,
    log = () => {},
  } = {}) {
    this.enabled = enabled;
    this.host = host;
    this.port = port;
    this.log = log;
    this.pricingTier =
      normalizePricingTier(process.env.CDX_STATS_PRICING_TIER ?? process.env.CDX_PRICING_TIER)
      ?? 'standard';

    this.httpServer = null;
    this.url = null;
    this.autoOpen = (process.env.CDX_STATS_AUTO_OPEN ?? '1') === '1';
    this.autoOpened = false;

    this.otlpEnabled = (process.env.CDX_STATS_OTLP_ENABLED ?? '1') === '1';
    this.otlpMaxBytes =
      Number.parseInt(process.env.CDX_STATS_OTLP_MAX_BYTES ?? '', 10)
      || OTLP_MAX_BYTES_DEFAULT;
    this.otlpLogBodyLimit =
      Number.parseInt(process.env.CDX_STATS_OTLP_LOG_BODY_LIMIT ?? '', 10)
      || OTLP_LOG_BODY_LIMIT_DEFAULT;

    this.runs = new Map(); // runId -> runState
    this.activeRunId = null;
    this.seq = 0;
    this.serverLogs = new RingBuffer(5000);
    this.eventCounters = new Map(); // eventType -> count
    this.logWaiters = new Map(); // key -> Set(waiter)
    this.logStreams = new Map(); // key -> Set(stream)
    this.eventWaiters = new Map(); // runId -> Set(waiter)
    this.worktreeStatusCache = new Map(); // worktreePath -> { at, value }
    this.graphResponseCache = new Map(); // cacheKey -> { at, value }
  }

  async ensureStarted(options) {
    if (!this.enabled) return null;
    const resolvedOptions = isObject(options) ? options : {};
    const autoOpenOverride = resolvedOptions.autoOpen;
    const shouldAutoOpen =
      autoOpenOverride === undefined ? this.autoOpen : parseBoolParam(autoOpenOverride);
    if (this.httpServer) {
      await this.#maybeAutoOpen(this.url, shouldAutoOpen);
      return this.url;
    }

    this.httpServer = http.createServer((req, res) => {
      this.#handleRequest(req, res).catch(err => {
        const message = err instanceof Error ? err.message : String(err ?? 'unknown_error');
        sendJson(res, 500, { error: message });
      });
    });

    await new Promise((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen(this.port, this.host, () => {
        this.httpServer.off('error', reject);
        resolve();
      });
    });

    const address = this.httpServer.address();
    const resolvedPort = typeof address === 'object' && address ? address.port : this.port;
    this.url = `http://${this.host}:${resolvedPort}/`;
    this.log(`Stats API: ${this.url}`);
    await this.#maybeAutoOpen(this.url, shouldAutoOpen);
    return this.url;
  }

  async stop() {
    const server = this.httpServer;
    if (!server) return;

    this.httpServer = null;
    this.url = null;
    this.autoOpened = false;

    await new Promise(resolve => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  seedDebugRun(options = {}) {
    const input = isObject(options) ? options : {};
    const runId = pickFirstString(input.runId, input.run_id, input.id, 'stats-test') ?? 'stats-test';
    const repoRoot =
      pickFirstString(input.repoRoot, input.repo_root, input.cwd, process.cwd()) ?? process.cwd();
    const headRef = pickFirstString(input.headRef, input.head_ref, input.branch, 'HEAD') ?? 'HEAD';
    const workerCountRaw = input.workerCount ?? input.worker_count ?? input.workers ?? 10;
    const workerCountParsed = Number.parseInt(workerCountRaw, 10);
    const workerCount = Number.isFinite(workerCountParsed)
      ? Math.max(1, Math.min(64, workerCountParsed))
      : 10;

    const now = Date.now();
    const run = this.#getOrCreateRun(runId);
    run.id = runId;
    run.goal = `Stats test mode (${workerCount} workers)`;
    run.status = 'running';
    run.error = null;
    run.pid = process.pid;
    run.cwd = repoRoot;
    run.repoRoot = repoRoot;
    run.headRef = headRef;
    run.worktreeRoot = repoRoot;
    run.runRoot = repoRoot;
    run.integrationBranch = headRef;
    run.keepWorktrees = false;
    run.processCommand = 'cdx.stats.test';
    run.lastCommand = 'cdx.stats.test --workers=' + String(workerCount);
    run.lastCommandAt = now;
    run.createdAt = now - 120_000;
    run.completedAt = null;
    run.updatedAt = now;
    run.plannedTaskCount = workerCount;
    run.parallelism = workerCount;
    run.scheduler = {
      updatedAt: now,
      reason: 'stats-test',
      totalTasks: workerCount,
      pendingTasks: 0,
      runningTasks: workerCount,
      completedTasks: 0,
      failedTasks: 0,
      blockedTasks: 0,
      resolvedTasks: 0,
      readyCount: workerCount,
        readyRunnableCount: workerCount,
        ownershipBlockedCount: 0,
        currentParallelism: workerCount,
        maxParallelism: workerCount,
        minParallelism: workerCount,
      autoscale: false,
      locksHeldTasks: 0,
      locksHeldKeys: 0,
      bottleneckKind: null,
      rateLimitHits: 0,
      rateLimitLastAt: null,
      rateLimitWindowMs: null,
      backpressureActive: false,
      backpressureReason: null,
      backpressureUntil: null,
      backpressureMaxParallelism: null,
    };
    run.workerPoolSize = workerCount;
    run.workerBusy = workerCount;
    run.costUsd = 0;
    run.tokens = { input: 0, cachedInput: 0, output: 0 };
    run.tasks = new Map();
    run.asks = new Map();
    run.workers = new Map();
    run.events = new RingBuffer(4000);
    run.eventCounters = new Map();

    const serverAgent = {
      agentId: 'server',
      taskId: null,
      phase: 'server',
      status: 'running',
      startedAt: run.createdAt,
      finishedAt: null,
      worktreePath: null,
      branch: null,
      lastActivityAt: now,
      lastActivity: 'stats test seed active',
      lastActivityKind: 'status',
      summaryTextDelta: null,
      summaryTextDeltaAt: null,
      lastPromptText: null,
      lastPromptAt: null,
      model: null,
      costUsd: 0,
      tokens: { input: 0, cachedInput: 0, output: 0 },
    };
    const plannerAgent = {
      agentId: 'planner',
      taskId: null,
      phase: 'planner',
      status: 'running',
      startedAt: run.createdAt,
      finishedAt: null,
      worktreePath: repoRoot,
      branch: headRef,
      lastActivityAt: now - 20_000,
      lastActivity: `Seeded ${workerCount} synthetic worker tasks for dashboard debugging`,
      lastActivityKind: 'status',
      summaryTextDelta: 'Synthetic plan created for stats test mode',
      summaryTextDeltaAt: now - 20_000,
      lastPromptText: 'Create a synthetic dashboard run with running workers and visible git tree.',
      lastPromptAt: now - 30_000,
      model: 'gpt-5.4',
      costUsd: 0,
      tokens: { input: 0, cachedInput: 0, output: 0 },
    };
    const watchdogAgent = {
      agentId: 'watchdog',
      taskId: null,
      phase: 'watchdog',
      status: 'running',
      startedAt: run.createdAt,
      finishedAt: null,
      worktreePath: repoRoot,
      branch: headRef,
      lastActivityAt: now - 2_000,
      lastActivity: 'monitoring worker progress and merge queue',
      lastActivityKind: 'status',
      summaryTextDelta: 'Watchdog active in stats test mode',
      summaryTextDeltaAt: now - 2_000,
      lastPromptText: 'Track stalled tasks and merge risk; intervene when needed.',
      lastPromptAt: now - 6_000,
      model: 'gpt-5.4',
      costUsd: 0,
      tokens: { input: 0, cachedInput: 0, output: 0 },
    };
    run.agents = new Map([
      ['server', serverAgent],
      ['planner', plannerAgent],
      ['watchdog', watchdogAgent],
    ]);

    run.logs = new Map();
    const addLog = (agentId, text, { stream = false, ts = null } = {}) => {
      if (!run.logs.has(agentId)) run.logs.set(agentId, new RingBuffer(8000));
      run.logs.get(agentId).push({
        id: this.#nextSeq(),
        ts: ts ?? new Date().toISOString(),
        agentId,
        text: String(text ?? ''),
        stream,
      });
    };

    addLog('server', 'stats test mode enabled');
    addLog('planner', `planned ${workerCount} synthetic worker tasks`);
    addLog('watchdog', 'watchdog started');
    addLog('watchdog', 'turn 1: scanning scheduler for stalled tasks');
    addLog('watchdog', 'turn 1: no stalled task, monitoring continues');

    for (let i = 1; i <= workerCount; i += 1) {
      const n = String(i).padStart(2, '0');
      const taskId = `worker-${n}`;
      const agentId = `task:${taskId}`;
      const workerId = `w${n}`;
      const startedAt = now - (workerCount - i + 1) * 3_000;
      const readyAt = startedAt - 2_000;
      const dependsOn =
        i <= 3
          ? []
          : [`worker-${String(i - 3).padStart(2, '0')}`];

      run.tasks.set(taskId, {
        taskId,
        description: `Debug worker ${n} processing repository tree`,
        dependsOn,
        files: [],
        branch: headRef,
        worktreePath: repoRoot,
        status: 'running',
        readyAt,
        startedAt,
        finishedAt: null,
        queueWaitMs: Math.max(0, startedAt - readyAt),
        error: null,
        lastActivityAt: startedAt + 1_000,
        lastActivity: `Scanning git tree segment ${n}`,
        lastActivityKind: 'stdout',
        summaryTextDelta: `Worker ${n} active`,
        summaryTextDeltaAt: startedAt + 1_000,
        lastPromptText: `Inspect and validate repository tree for segment ${n}.`,
        lastPromptAt: startedAt - 500,
        costUsd: 0,
        tokens: { input: 0, cachedInput: 0, output: 0 },
      });

      run.agents.set(agentId, {
        agentId,
        taskId,
        phase: 'task',
        status: 'running',
        startedAt,
        finishedAt: null,
        worktreePath: repoRoot,
        branch: headRef,
        lastActivityAt: startedAt + 1_000,
        lastActivity: `working on ${taskId}`,
        lastActivityKind: 'stdout',
        summaryTextDelta: `Task ${taskId} is running`,
        summaryTextDeltaAt: startedAt + 1_000,
        lastPromptText: `Execute ${taskId} debug workload`,
        lastPromptAt: startedAt - 1_000,
        model: 'gpt-5.4',
        costUsd: 0,
        tokens: { input: 0, cachedInput: 0, output: 0 },
      });

      addLog(
        agentId,
        [
          `$ rg --files src | sed -n '${i},${i + 4}p'`,
          'src/runtime/cdx-stats-server.js',
          'src/cli/cdx-appserver-mcp-server.js',
          `Inspecting repository tree segment ${n}`,
          'Collecting scheduler and worktree telemetry',
          'Preparing dashboard patch context',
        ].join('\n'),
        {
          stream: true,
          ts: new Date(startedAt + 1_200).toISOString(),
        },
      );

      run.workers.set(workerId, {
        workerId,
        status: 'busy',
        startedAt: run.createdAt,
        initializedAt: run.createdAt + 1_000,
        lastAcquiredAt: startedAt,
        lastReleasedAt: null,
        inUse: true,
        taskId,
        agentId,
      });

      addLog(agentId, `started ${taskId}`);
      addLog(agentId, `processing git tree nodes for ${taskId}`);
    }

    const pushEvent = payload => {
      const type = typeof payload?.type === 'string' ? payload.type : 'unknown';
      run.eventCounters.set(type, (run.eventCounters.get(type) ?? 0) + 1);
      run.events.push({
        id: this.#nextSeq(),
        ts: new Date().toISOString(),
        payload: { ...payload, runId },
      });
    };

    pushEvent({
      type: 'run.started',
      runId,
      goal: run.goal,
      repoRoot,
      headRef,
      runRoot: repoRoot,
      worktreeRoot: repoRoot,
      keepWorktrees: false,
    });
    pushEvent({ type: 'plan.completed', runId, taskCount: workerCount, parallelism: workerCount });
    pushEvent({ type: 'turn.completed', runId, agentId: 'watchdog', turnId: 'watchdog-turn-1' });
    addLog('watchdog', 'turn 2: queue depth stable, checking merge conflicts');
    addLog('watchdog', 'turn 2: no conflict detected, keeping workers active');
    pushEvent({ type: 'turn.completed', runId, agentId: 'watchdog', turnId: 'watchdog-turn-2' });
    addLog('watchdog', 'turn 3: worker-07 latency spike observed; collecting extra telemetry');
    addLog('watchdog', 'turn 3: intervention not required; continue monitoring');
    for (let i = 1; i <= workerCount; i += 1) {
      const n = String(i).padStart(2, '0');
      const taskId = `worker-${n}`;
      pushEvent({ type: 'task.ready', runId, taskId });
      pushEvent({ type: 'task.started', runId, taskId, agentId: `task:${taskId}` });
      pushEvent({ type: 'worker.acquired', runId, workerId: `w${n}`, taskId, agentId: `task:${taskId}` });
    }

    this.activeRunId = runId;
    this.worktreeStatusCache.clear();
    this.graphResponseCache.clear();

    const lastEventId = run.events.items.length > 0 ? run.events.items[run.events.items.length - 1].id : 0;
    if (lastEventId > 0) this.#notifyEventWaiters(runId, lastEventId);

    return {
      runId,
      workerCount,
      repoRoot,
      headRef,
    };
  }

  recordLog(message, runId) {
    const payload = normalizeLogMessage(message);
    const parsed = payload.agentId
      ? { agentId: payload.agentId, text: stripAnsi(payload.text) }
      : parseAgentPrefix(payload.text);
    const { agentId, text } = parsed;
    const entry = {
      id: this.#nextSeq(),
      ts: new Date().toISOString(),
      agentId,
      text,
      stream: payload.stream === true,
    };

    const resolvedRunId = typeof runId === 'string' && runId ? runId : this.activeRunId;
    const run = resolvedRunId ? this.runs.get(resolvedRunId) ?? this.#getOrCreateRun(resolvedRunId) : null;
    if (!run) {
      this.serverLogs.push(entry);
      const key = `server|${agentId}`;
      this.#notifyLogWaiters(key, entry.id);
      this.#notifyLogStreams(key, entry);
      return;
    }

    if (!run.logs.has(agentId)) {
      run.logs.set(agentId, new RingBuffer(8000));
    }
    run.logs.get(agentId).push(entry);
    const key = `${resolvedRunId}|${agentId}`;
    this.#notifyLogWaiters(key, entry.id);
    this.#notifyLogStreams(key, entry);
  }

  recordEvent(payload) {
    if (!isObject(payload)) return;
    const runId = typeof payload.runId === 'string' && payload.runId ? payload.runId : null;
    const type = typeof payload.type === 'string' ? payload.type : 'unknown';

    const resolvedRunId = runId ?? this.activeRunId;
    if (!resolvedRunId) return;
    const run = this.#getOrCreateRun(resolvedRunId);
    run.updatedAt = Date.now();

    const globalCount = (this.eventCounters.get(type) ?? 0) + 1;
    this.eventCounters.set(type, globalCount);
    if (run.eventCounters instanceof Map) {
      run.eventCounters.set(type, (run.eventCounters.get(type) ?? 0) + 1);
    }

    const eventEntry = {
      id: this.#nextSeq(),
      ts: new Date().toISOString(),
      payload,
    };
    run.events.push(eventEntry);
    this.#notifyEventWaiters(resolvedRunId, eventEntry.id);

    if (type === 'run.started') {
      this.activeRunId = resolvedRunId;
      run.status = 'running';
      run.goal = payload.goal ?? run.goal;
      run.repoRoot = payload.repoRoot ?? run.repoRoot;
      run.headRef = payload.headRef ?? run.headRef;
      run.worktreeRoot = payload.worktreeRoot ?? run.worktreeRoot;
      run.runRoot = payload.runRoot ?? run.runRoot;
      run.integrationBranch = payload.integrationBranch ?? run.integrationBranch;
      run.keepWorktrees = payload.keepWorktrees ?? run.keepWorktrees;
      const pid = pickFirstPid(payload.pid, payload.processPid, payload.process_pid);
      if (pid !== null) {
        run.pid = pid;
      }
      const cwd = pickFirstString(payload.cwd, payload.sandboxCwd, payload.sandbox_cwd);
      if (cwd) {
        run.cwd = cwd;
      }
    }

    if (type === 'run.completed') {
      run.status = payload.status ?? 'completed';
      run.error = payload.error ?? null;
      run.completedAt = Date.now();
    }

    if (type === 'checklist.configured') {
      run.checklist = payload.checklist ?? run.checklist ?? null;
    }

    if (type === 'plan.completed') {
      const count = Number.parseInt(payload.taskCount, 10);
      if (Number.isFinite(count) && count >= 0) {
        run.plannedTaskCount = count;
      }
      const parallelism = Number.parseInt(payload.parallelism, 10);
      if (Number.isFinite(parallelism) && parallelism > 0) {
        run.parallelism = parallelism;
      }
      if (typeof payload.rawPlanText === 'string') {
        run.plannerPlanText = clipTextBlock(payload.rawPlanText, 12000);
        run.plannerPlanAt = Date.now();
      }
    }

    if (type === 'prompt.sent') {
      const rawText =
        typeof payload.text === 'string'
          ? payload.text
          : typeof payload.params?.input?.[0]?.text === 'string'
            ? payload.params.input[0].text
            : '';
      const clipped = clipTextBlock(rawText, 6000);
      if (clipped) {
        const now = Date.now();
        const agentId = payload.agentId ? String(payload.agentId) : null;
        const taskId = payload.taskId ? String(payload.taskId) : null;
        if (agentId) {
          const agent = run.agents.get(agentId) ?? {
            agentId,
            taskId: taskId ?? null,
            phase: payload.phase ?? null,
            status: 'running',
            startedAt: now,
            finishedAt: null,
            worktreePath: payload.worktreePath ?? null,
            branch: payload.branch ?? null,
            lastActivityAt: null,
            lastActivity: null,
            lastActivityKind: null,
            summaryTextDelta: null,
            summaryTextDeltaAt: null,
            costUsd: 0,
            tokens: { input: 0, cachedInput: 0, output: 0 },
          };
          agent.lastPromptText = clipped;
          agent.lastPromptAt = now;
          run.agents.set(agentId, agent);
        }
        if (taskId) {
          const task = run.tasks.get(taskId) ?? {
            taskId,
            agentId: agentId ?? null,
            description: payload.description ?? null,
            dependsOn: Array.isArray(payload.dependsOn) ? payload.dependsOn : [],
            files: Array.isArray(payload.files) ? payload.files : [],
            checklist: payload.checklist ?? null,
            branch: payload.branch ?? null,
            worktreePath: payload.worktreePath ?? null,
            status: 'pending',
            readyAt: null,
            startedAt: null,
            finishedAt: null,
            queueWaitMs: null,
            error: null,
            retryAttempt: null,
            lastActivityAt: null,
            lastActivity: null,
            lastActivityKind: null,
            summaryTextDelta: null,
            summaryTextDeltaAt: null,
            costUsd: 0,
            tokens: { input: 0, cachedInput: 0, output: 0 },
          };
          task.agentId = agentId ?? task.agentId ?? null;
          task.lastPromptText = clipped;
          task.lastPromptAt = now;
          run.tasks.set(taskId, task);
        }
      }
    }

    if (type === 'scheduler.snapshot') {
      run.scheduler = {
        updatedAt: Date.now(),
        reason: payload.reason ?? null,
        totalTasks: payload.totalTasks ?? null,
        pendingTasks: payload.pendingTasks ?? null,
        runningTasks: payload.runningTasks ?? null,
        completedTasks: payload.completedTasks ?? null,
        failedTasks: payload.failedTasks ?? null,
        blockedTasks: payload.blockedTasks ?? null,
        resolvedTasks: payload.resolvedTasks ?? null,
        readyCount: payload.readyCount ?? null,
        readyRunnableCount: payload.readyRunnableCount ?? null,
        ownershipBlockedCount: payload.ownershipBlockedCount ?? null,
        currentParallelism: payload.currentParallelism ?? null,
        maxParallelism: payload.maxParallelism ?? null,
        minParallelism: payload.minParallelism ?? null,
        autoscale: payload.autoscale ?? null,
        locksHeldTasks: payload.locksHeldTasks ?? null,
        locksHeldKeys: payload.locksHeldKeys ?? null,
        bottleneckKind: payload.bottleneckKind ?? null,
        rateLimitHits: payload.rateLimitHits ?? null,
        rateLimitLastAt: payload.rateLimitLastAt ?? null,
        rateLimitWindowMs: payload.rateLimitWindowMs ?? null,
        backpressureActive: payload.backpressureActive ?? null,
        backpressureReason: payload.backpressureReason ?? null,
        backpressureUntil: payload.backpressureUntil ?? null,
        backpressureMaxParallelism: payload.backpressureMaxParallelism ?? null,
      };
    }

    if (type === 'worker_pool.ready') {
      const size = Number.parseInt(payload.size, 10);
      if (Number.isFinite(size) && size >= 0) {
        run.workerPoolSize = size;
      }
    }

    if (type.startsWith('worker.') && payload.workerId) {
      const workerId = String(payload.workerId);
      const worker = run.workers.get(workerId) ?? {
        workerId,
        status: 'unknown',
        startedAt: null,
        initializedAt: null,
        lastAcquiredAt: null,
        lastReleasedAt: null,
        inUse: false,
        taskId: null,
        agentId: null,
      };
      const now = Date.now();
      if (type === 'worker.started') {
        worker.status = 'started';
        worker.startedAt = worker.startedAt ?? now;
      } else if (type === 'worker.initialized') {
        worker.status = 'initialized';
        worker.initializedAt = worker.initializedAt ?? now;
      } else if (type === 'worker.acquired') {
        worker.status = 'busy';
        worker.inUse = true;
        worker.taskId = payload.taskId ?? worker.taskId;
        worker.agentId = payload.agentId ?? worker.agentId;
        worker.lastAcquiredAt = now;
      } else if (type === 'worker.released') {
        worker.status = 'idle';
        worker.inUse = false;
        worker.taskId = null;
        worker.agentId = null;
        worker.lastReleasedAt = now;
      }
      run.workers.set(workerId, worker);
      run.workerBusy = [...run.workers.values()].filter(entry => entry?.inUse).length;
    }

    if (type === 'router.ask.pending' && payload.askId) {
      const askId = String(payload.askId);
      const now = Number.isFinite(payload.wallMs) ? payload.wallMs : Date.now();
      const ask = run.asks?.get?.(askId) ?? {
        askId,
        runId: resolvedRunId,
        taskId: payload.taskId ?? null,
        threadId: payload.threadId ?? null,
        turnId: payload.turnId ?? null,
        status: 'pending',
        mode: payload.mode ?? null,
        timeoutMs: payload.timeoutMs ?? null,
        question: payload.question ?? null,
        options: Array.isArray(payload.options) ? payload.options : [],
        constraints: Array.isArray(payload.constraints) ? payload.constraints : [],
        desiredOutput: payload.desiredOutput ?? null,
        contextPreview: payload.contextPreview ?? null,
        createdAt: now,
        answeredAt: null,
        answeredBy: null,
        optionId: null,
        confidence: null,
      };
      ask.taskId = payload.taskId ?? ask.taskId;
      ask.threadId = payload.threadId ?? ask.threadId;
      ask.turnId = payload.turnId ?? ask.turnId;
      ask.mode = payload.mode ?? ask.mode;
      ask.timeoutMs = payload.timeoutMs ?? ask.timeoutMs;
      ask.question = payload.question ?? ask.question;
      ask.options = Array.isArray(payload.options) ? payload.options : ask.options;
      ask.constraints = Array.isArray(payload.constraints) ? payload.constraints : ask.constraints;
      ask.desiredOutput = payload.desiredOutput ?? ask.desiredOutput;
      ask.contextPreview = payload.contextPreview ?? ask.contextPreview;
      ask.status = 'pending';
      run.asks.set(askId, ask);
    }

    if (type === 'router.ask.answered' && payload.askId) {
      const askId = String(payload.askId);
      const now = Number.isFinite(payload.wallMs) ? payload.wallMs : Date.now();
      const ask = run.asks?.get?.(askId) ?? {
        askId,
        runId: resolvedRunId,
        taskId: payload.taskId ?? null,
        threadId: payload.threadId ?? null,
        turnId: payload.turnId ?? null,
        status: 'answered',
        mode: null,
        timeoutMs: null,
        question: null,
        options: [],
        constraints: [],
        desiredOutput: null,
        contextPreview: null,
        createdAt: now,
        answeredAt: null,
        answeredBy: null,
        optionId: null,
        confidence: null,
      };
      ask.taskId = payload.taskId ?? ask.taskId;
      ask.status = 'answered';
      ask.answeredAt = now;
      ask.answeredBy = payload.answeredBy ?? ask.answeredBy ?? 'supervisor';
      ask.optionId = payload.optionId ?? ask.optionId ?? null;
      run.asks.set(askId, ask);
    }

    if (type === 'router.ask.timeout' && payload.askId) {
      const askId = String(payload.askId);
      const now = Number.isFinite(payload.wallMs) ? payload.wallMs : Date.now();
      const ask = run.asks?.get?.(askId) ?? {
        askId,
        runId: resolvedRunId,
        taskId: payload.taskId ?? null,
        threadId: payload.threadId ?? null,
        turnId: payload.turnId ?? null,
        status: 'timed_out',
        mode: payload.mode ?? null,
        timeoutMs: payload.timeoutMs ?? null,
        question: null,
        options: [],
        constraints: [],
        desiredOutput: null,
        contextPreview: null,
        createdAt: now,
        answeredAt: null,
        answeredBy: null,
        optionId: null,
        confidence: null,
      };
      ask.taskId = payload.taskId ?? ask.taskId;
      ask.threadId = payload.threadId ?? ask.threadId;
      ask.turnId = payload.turnId ?? ask.turnId;
      ask.mode = payload.mode ?? ask.mode;
      ask.timeoutMs = payload.timeoutMs ?? ask.timeoutMs;
      ask.status = 'timed_out';
      ask.answeredAt = now;
      ask.answeredBy = 'timeout';
      run.asks.set(askId, ask);
    }

    if (type === 'router.ask.judge.completed' && payload.askId) {
      const askId = String(payload.askId);
      const now = Number.isFinite(payload.wallMs) ? payload.wallMs : Date.now();
      const ask = run.asks?.get?.(askId) ?? {
        askId,
        runId: resolvedRunId,
        taskId: payload.taskId ?? null,
        threadId: payload.threadId ?? null,
        turnId: payload.turnId ?? null,
        status: 'answered',
        mode: null,
        timeoutMs: null,
        question: null,
        options: [],
        constraints: [],
        desiredOutput: null,
        contextPreview: null,
        createdAt: now,
        answeredAt: null,
        answeredBy: null,
        optionId: null,
        confidence: null,
      };
      ask.taskId = payload.taskId ?? ask.taskId;
      ask.status = 'answered';
      ask.answeredAt = now;
      ask.answeredBy = ask.answeredBy ?? 'judge';
      ask.optionId = payload.optionId ?? ask.optionId ?? null;
      ask.confidence = payload.confidence ?? ask.confidence ?? null;
      run.asks.set(askId, ask);
    }

    if (type === 'worktree.created' && payload.taskId) {
      const taskId = String(payload.taskId);
        const task = run.tasks.get(taskId) ?? {
          taskId,
          description: null,
          dependsOn: [],
          files: [],
          checklist: payload.checklist ?? null,
          branch: null,
          worktreePath: null,
          status: 'pending',
        readyAt: null,
        startedAt: null,
        finishedAt: null,
        queueWaitMs: null,
        error: null,
        retryAttempt: null,
        lastActivityAt: null,
        lastActivity: null,
        lastActivityKind: null,
        summaryTextDelta: null,
        summaryTextDeltaAt: null,
        costUsd: 0,
        tokens: { input: 0, cachedInput: 0, output: 0 },
      };
      task.branch = payload.branch ?? task.branch;
      task.worktreePath = payload.worktreePath ?? task.worktreePath;
      task.description = payload.description ?? task.description;
      task.dependsOn = Array.isArray(payload.dependsOn) ? payload.dependsOn : task.dependsOn;
      task.files = Array.isArray(payload.files) ? payload.files : task.files;
      task.checklist = payload.checklist ?? task.checklist ?? null;
      run.tasks.set(taskId, task);
    }

    if (type.startsWith('task.') && payload.taskId) {
      const taskId = String(payload.taskId);
      const task = run.tasks.get(taskId) ?? {
        taskId,
        agentId: payload.agentId ?? null,
        description: payload.description ?? null,
        dependsOn: Array.isArray(payload.dependsOn) ? payload.dependsOn : [],
        files: Array.isArray(payload.files) ? payload.files : [],
        checklist: payload.checklist ?? null,
        branch: payload.branch ?? null,
          worktreePath: payload.worktreePath ?? null,
          status: 'pending',
        readyAt: null,
        startedAt: null,
        finishedAt: null,
        queueWaitMs: null,
        error: null,
        retryAttempt: null,
        lastActivityAt: null,
        lastActivity: null,
        lastActivityKind: null,
        summaryTextDelta: null,
        summaryTextDeltaAt: null,
        costUsd: 0,
        tokens: { input: 0, cachedInput: 0, output: 0 },
        supersededAt: null,
        priorStatus: null,
        replacementTaskIds: [],
        recoveryWave: null,
      };
      const clearSupersededTaskState = () => {
        task.supersededAt = null;
        task.priorStatus = null;
        task.replacementTaskIds = [];
        task.recoveryWave = null;
      };
      task.agentId = payload.agentId ?? task.agentId ?? null;
      const now = Date.now();
      if (type === 'task.ready') {
        clearSupersededTaskState();
        task.readyAt = task.readyAt ?? now;
        task.lastActivityAt = now;
        task.lastActivity = 'ready';
        task.lastActivityKind = null;
      } else if (type === 'task.started') {
        clearSupersededTaskState();
        task.status = 'running';
        task.startedAt = now;
        if (Number.isFinite(task.readyAt)) {
          task.queueWaitMs = Math.max(0, now - task.readyAt);
        }
        task.lastActivityAt = now;
        task.lastActivity = 'started';
        task.lastActivityKind = null;
      } else if (type === 'task.completed') {
        clearSupersededTaskState();
        task.status = 'completed';
        task.finishedAt = now;
        task.lastActivityAt = now;
        task.lastActivity = 'completed';
        task.lastActivityKind = null;
      } else if (type === 'task.respawned' || type === 'task.retry.requested' || type === 'task.unblocked') {
        clearSupersededTaskState();
        task.status = 'pending';
        task.startedAt = null;
        task.finishedAt = null;
        task.error = null;
        task.lastActivityAt = now;
        if (type === 'task.unblocked') {
          task.lastActivity = 'unblocked';
        } else if (type === 'task.respawned') {
          task.lastActivity = 'respawned';
        } else {
          task.lastActivity = 'retry queued';
        }
        task.lastActivityKind = null;
      } else if (type === 'task.failed') {
        clearSupersededTaskState();
        task.status = 'failed';
        task.finishedAt = now;
        task.error = payload.error ?? task.error;
        task.lastActivityAt = now;
        task.lastActivity = task.error ? `failed: ${task.error}` : 'failed';
        task.lastActivityKind = null;
      } else if (type === 'task.blocked') {
        clearSupersededTaskState();
        task.status = 'blocked';
        task.finishedAt = now;
        task.error = payload.reason ?? task.error;
        task.lastActivityAt = now;
        task.lastActivity = task.error ? `blocked: ${task.error}` : 'blocked';
        task.lastActivityKind = null;
      } else if (type === 'task.superseded') {
        task.status = 'superseded';
        task.finishedAt = now;
        task.error = payload.reason ?? task.error;
        task.supersededAt = now;
        task.priorStatus = payload.priorStatus ?? task.priorStatus ?? null;
        task.replacementTaskIds = Array.isArray(payload.replacementTaskIds)
          ? payload.replacementTaskIds.map(value => String(value ?? '')).filter(Boolean)
          : (Array.isArray(task.replacementTaskIds) ? task.replacementTaskIds : []);
        const recoveryWave = Number.parseInt(payload.wave, 10);
        task.recoveryWave = Number.isFinite(recoveryWave) ? recoveryWave : task.recoveryWave ?? null;
        task.lastActivityAt = now;
        task.lastActivity = task.error ? `superseded: ${task.error}` : 'superseded';
        task.lastActivityKind = null;
      }
      task.branch = payload.branch ?? task.branch;
      task.worktreePath = payload.worktreePath ?? task.worktreePath;
      task.description = payload.description ?? task.description;
      task.dependsOn = Array.isArray(payload.dependsOn) ? payload.dependsOn : task.dependsOn;
      task.files = Array.isArray(payload.files) ? payload.files : task.files;
      task.checklist = payload.checklist ?? task.checklist ?? null;
      const retryAttempt = Number.parseInt(payload.attempt, 10);
      if (Number.isFinite(retryAttempt) && retryAttempt > 0) {
        task.retryAttempt = Math.max(Number.parseInt(task.retryAttempt, 10) || 0, retryAttempt);
      }
      run.tasks.set(taskId, task);
    }

    if (type === 'agent.started' && payload.agentId) {
      const agentId = String(payload.agentId);
      const agent = run.agents.get(agentId) ?? {
        agentId,
        taskId: payload.taskId ?? null,
        phase: payload.phase ?? null,
        status: 'running',
        startedAt: Date.now(),
        finishedAt: null,
        worktreePath: payload.worktreePath ?? null,
        branch: payload.branch ?? null,
        lastModel: null,
        lastEffort: null,
        lastActivityAt: null,
        lastActivity: null,
        lastActivityKind: null,
        summaryTextDelta: null,
        summaryTextDeltaAt: null,
        costUsd: 0,
        tokens: { input: 0, cachedInput: 0, output: 0 },
      };
      const startedModel = pickFirstString(payload.model, payload.modelId, payload.model_id) ?? null;
      const startedEffort = pickFirstString(
        payload.effort,
        payload.reasoningEffort,
        payload.reasoning_effort,
        payload.modelReasoningEffort,
        payload.model_reasoning_effort,
      ) ?? null;
      agent.status = 'running';
      agent.taskId = payload.taskId ?? agent.taskId;
      agent.phase = payload.phase ?? agent.phase;
      agent.worktreePath = payload.worktreePath ?? agent.worktreePath;
      agent.branch = payload.branch ?? agent.branch;
      agent.lastModel = startedModel ?? agent.lastModel ?? null;
      if (startedEffort) agent.lastEffort = startedEffort;
      agent.startedAt = agent.startedAt ?? Date.now();
      agent.lastActivityAt = agent.lastActivityAt ?? Date.now();
      agent.lastActivity = agent.lastActivity ?? 'started';
      run.agents.set(agentId, agent);
      if (agent.taskId) {
        const task = run.tasks.get(agent.taskId);
        if (task) {
          task.agentId = agentId;
          run.tasks.set(agent.taskId, task);
        }
      }
    }

    if ((type === 'agent.disposed' || type === 'agent.disposing') && payload.agentId) {
      const agentId = String(payload.agentId);
      const agent = run.agents.get(agentId);
      if (agent) {
        if (type === 'agent.disposed') {
          agent.status = 'disposed';
          agent.finishedAt = Date.now();
        } else if (agent.status === 'running') {
          agent.status = 'disposing';
        }
      }
    }

    if (type === 'turn.completed' && payload.agentId) {
      const agentId = String(payload.agentId);
      const taskId = payload.taskId ? String(payload.taskId) : null;
      const usage = isObject(payload.usage) ? payload.usage : null;

      const inputTokens = readTokenCount(usage, 'inputTokens', 'input_tokens', 'prompt_tokens', 'promptTokens');
      const cachedInputTokens = readTokenCount(
        usage,
        'cachedInputTokens',
        'cached_input_tokens',
        'cached_tokens',
        'input_tokens_details.cached_tokens',
        'prompt_tokens_details.cached_tokens',
      );
      const outputTokens = readTokenCount(usage, 'outputTokens', 'output_tokens', 'completion_tokens', 'completionTokens');

      const hasAnyTokenCounts =
        inputTokens !== null || cachedInputTokens !== null || outputTokens !== null;

      const resolvedTier =
        normalizePricingTier(payload.pricingTier ?? run.pricingTier ?? this.pricingTier)
        ?? this.pricingTier;
      run.pricingTier = resolvedTier;

      const model = pickFirstString(payload.model, payload.modelId, payload.model_id) ?? null;
      const effort = pickFirstString(
        payload.effort,
        payload.reasoningEffort,
        payload.reasoning_effort,
        payload.modelReasoningEffort,
        payload.model_reasoning_effort,
      ) ?? null;
      const cost = model && hasAnyTokenCounts
        ? computeTextTokenCostUsd({
          model,
          tier: resolvedTier,
          inputTokens: inputTokens ?? 0,
          cachedInputTokens: cachedInputTokens ?? 0,
          outputTokens: outputTokens ?? 0,
        })
        : null;

      const deltaUsd = cost?.usd?.total ?? null;
      const deltaInput = inputTokens ?? 0;
      const deltaCached = cachedInputTokens ?? 0;
      const deltaOutput = outputTokens ?? 0;

      if (!run.tokens) run.tokens = { input: 0, cachedInput: 0, output: 0 };
      run.tokens.input += deltaInput;
      run.tokens.cachedInput += deltaCached;
      run.tokens.output += deltaOutput;
      if (deltaUsd !== null) {
        run.costUsd = (Number.isFinite(run.costUsd) ? run.costUsd : 0) + deltaUsd;
      }

      const agent = run.agents.get(agentId) ?? {
        agentId,
        taskId: taskId,
        phase: payload.phase ?? null,
        status: 'running',
        startedAt: Date.now(),
        finishedAt: null,
        worktreePath: payload.worktreePath ?? null,
        branch: payload.branch ?? null,
        lastActivityAt: null,
        lastActivity: null,
        lastActivityKind: null,
        summaryTextDelta: null,
        summaryTextDeltaAt: null,
        costUsd: 0,
        tokens: { input: 0, cachedInput: 0, output: 0 },
      };
      if (!agent.tokens) agent.tokens = { input: 0, cachedInput: 0, output: 0 };
      agent.tokens.input += deltaInput;
      agent.tokens.cachedInput += deltaCached;
      agent.tokens.output += deltaOutput;
      if (deltaUsd !== null) {
        agent.costUsd = (Number.isFinite(agent.costUsd) ? agent.costUsd : 0) + deltaUsd;
      }
      agent.lastModel = model ?? agent.lastModel ?? null;
      if (effort) agent.lastEffort = effort;
      run.agents.set(agentId, agent);

      if (taskId) {
        const task = run.tasks.get(taskId) ?? {
          taskId,
          description: null,
          dependsOn: [],
          checklist: null,
          branch: null,
          worktreePath: null,
          status: 'pending',
          startedAt: null,
        finishedAt: null,
        error: null,
        lastActivityAt: null,
        lastActivity: null,
        lastActivityKind: null,
        summaryTextDelta: null,
        summaryTextDeltaAt: null,
        costUsd: 0,
        tokens: { input: 0, cachedInput: 0, output: 0 },
      };
        if (!task.tokens) task.tokens = { input: 0, cachedInput: 0, output: 0 };
        task.tokens.input += deltaInput;
        task.tokens.cachedInput += deltaCached;
        task.tokens.output += deltaOutput;
        if (deltaUsd !== null) {
          task.costUsd = (Number.isFinite(task.costUsd) ? task.costUsd : 0) + deltaUsd;
        }
        run.tasks.set(taskId, task);
      }

      if (agentId === 'watchdog') {
        this.#recordCompletedWatchdogTurn(run, payload, eventEntry);
      }
    }

    if (type === 'appserver.notification' && payload.agentId) {
      const agentId = String(payload.agentId);
      if (!run.logs.has(agentId)) {
        run.logs.set(agentId, new RingBuffer(8000));
      }
      const method = payload.method ?? '';
      const params = payload.params ?? {};
      const summary = summarizeAppserverNotification(method, params);
      const line = summary?.line ?? null;
      const activity = summary?.activity ?? null;
      const activityKind = summary?.activityKind ?? null;
      const now = Date.now();
      if (summary?.commandSummary) {
        run.lastCommand = summary.commandSummary;
        run.lastCommandAt = now;
      }
      if (summary?.cwd && !run.cwd) {
        run.cwd = summary.cwd;
      }
      if (line) {
        run.logs.get(agentId).push({
          id: this.#nextSeq(),
          ts: new Date().toISOString(),
          agentId,
          text: line,
        });
      }

      const clip = (value, max = 180) => {
        const text = String(value ?? '').replace(/\s+/g, ' ').trim();
        if (!text) return null;
        if (text.length <= max) return text;
        return `${text.slice(0, max)} …`;
      };

      const agent = run.agents.get(agentId) ?? {
        agentId,
        taskId: payload.taskId ?? null,
        phase: payload.phase ?? null,
        status: 'running',
        startedAt: now,
        finishedAt: null,
        worktreePath: payload.worktreePath ?? null,
        branch: payload.branch ?? null,
        lastActivityAt: null,
        lastActivity: null,
        lastActivityKind: null,
        summaryTextDelta: null,
        summaryTextDeltaAt: null,
        costUsd: 0,
        tokens: { input: 0, cachedInput: 0, output: 0 },
      };
      agent.lastActivityAt = now;
      agent.lastActivity = clip(activity ?? line);
      if (activityKind && activityKind !== 'message') {
        agent.lastActivityKind = activityKind;
      }
      const deltaText = extractSummaryDeltaText(method, params);
      if (deltaText) {
        agent.summaryTextDelta = mergeSummaryDeltaText(agent.summaryTextDelta, deltaText);
        agent.summaryTextDeltaAt = now;
      }
      run.agents.set(agentId, agent);

      if (payload.taskId) {
        const taskId = String(payload.taskId);
        const task = run.tasks.get(taskId);
        if (task) {
        task.lastActivityAt = now;
        task.lastActivity = clip(activity ?? line);
          if (activityKind && activityKind !== 'message') {
            task.lastActivityKind = activityKind;
          }
          if (deltaText) {
            task.summaryTextDelta = mergeSummaryDeltaText(task.summaryTextDelta, deltaText);
            task.summaryTextDeltaAt = now;
          }
          run.tasks.set(taskId, task);
        }
      }
    }

    if (type === 'appserver.request' && payload.agentId) {
      const agentId = String(payload.agentId);
      if (!run.logs.has(agentId)) {
        run.logs.set(agentId, new RingBuffer(8000));
      }
      const method = payload.method ?? 'unknown';
      const now = Date.now();
      const line = `[request] ${method}`;
      run.logs.get(agentId).push({
        id: this.#nextSeq(),
        ts: new Date().toISOString(),
        agentId,
        text: line,
      });

      const agent = run.agents.get(agentId) ?? null;
      if (agent) {
        agent.lastActivityAt = now;
        agent.lastActivity = line;
        run.agents.set(agentId, agent);
      }
    }
  }

  #clipOtlpText(value, max = this.otlpLogBodyLimit) {
    const text = formatOtlpValue(value).replace(/\s+/g, ' ').trim();
    if (!text) return null;
    if (text.length <= max) return text;
    return `${text.slice(0, max)} …`;
  }

  #applyOtlpContext(runId, resourceAttrs, recordAttrs, scopeAttrs, bodyAttrs) {
    if (!runId) return;
    const run = this.#getOrCreateRun(runId);

    const pid = pickFirstPid(
      recordAttrs?.['process.pid'],
      recordAttrs?.process_pid,
      recordAttrs?.pid,
      scopeAttrs?.['process.pid'],
      scopeAttrs?.process_pid,
      scopeAttrs?.pid,
      bodyAttrs?.['process.pid'],
      bodyAttrs?.process_pid,
      bodyAttrs?.pid,
      resourceAttrs?.['process.pid'],
      resourceAttrs?.process_pid,
      resourceAttrs?.pid,
    );
    if (pid !== null && (run.pid === null || run.pid === undefined)) {
      run.pid = pid;
    }

    const cwd = pickFirstString(
      recordAttrs?.['process.cwd'],
      recordAttrs?.['process.working_directory'],
      recordAttrs?.['process.workdir'],
      recordAttrs?.cwd,
      recordAttrs?.['cdx.cwd'],
      recordAttrs?.['codex.cwd'],
      scopeAttrs?.['process.cwd'],
      scopeAttrs?.['process.working_directory'],
      scopeAttrs?.['process.workdir'],
      scopeAttrs?.cwd,
      scopeAttrs?.['cdx.cwd'],
      scopeAttrs?.['codex.cwd'],
      bodyAttrs?.['process.cwd'],
      bodyAttrs?.['process.working_directory'],
      bodyAttrs?.['process.workdir'],
      bodyAttrs?.cwd,
      bodyAttrs?.['cdx.cwd'],
      bodyAttrs?.['codex.cwd'],
      resourceAttrs?.['process.cwd'],
      resourceAttrs?.['process.working_directory'],
      resourceAttrs?.['process.workdir'],
      resourceAttrs?.cwd,
      resourceAttrs?.['cdx.cwd'],
      resourceAttrs?.['codex.cwd'],
    );
    if (cwd && !run.cwd) {
      run.cwd = cwd;
    }

    const command = pickFirstString(
      recordAttrs?.['process.command_line'],
      recordAttrs?.['process.command'],
      recordAttrs?.['process.executable.name'],
      recordAttrs?.['process.executable.path'],
      scopeAttrs?.['process.command_line'],
      scopeAttrs?.['process.command'],
      scopeAttrs?.['process.executable.name'],
      scopeAttrs?.['process.executable.path'],
      bodyAttrs?.['process.command_line'],
      bodyAttrs?.['process.command'],
      bodyAttrs?.['process.executable.name'],
      bodyAttrs?.['process.executable.path'],
      resourceAttrs?.['process.command_line'],
      resourceAttrs?.['process.command'],
      resourceAttrs?.['process.executable.name'],
      resourceAttrs?.['process.executable.path'],
    );
    if (command && !run.processCommand) {
      run.processCommand = command;
    }
  }

  #resolveOtlpIdentifiers(resourceAttrs, recordAttrs, overrides, scopeAttrs, bodyAttrs, metaAttrs) {
    const sources = [recordAttrs, scopeAttrs, bodyAttrs, metaAttrs, resourceAttrs].filter(Boolean);
    const runKeys = [
      'cdx.run_id',
      'run.id',
      'run_id',
      'runId',
      'conversation.id',
      'conversation_id',
      'conversationId',
      'session.id',
      'session_id',
      'sessionId',
      'traceId',
      'trace_id',
    ];
    const agentKeys = [
      'cdx.agent_id',
      'agent.id',
      'agent_id',
      'agentId',
      'conversation.id',
      'conversation_id',
      'conversationId',
      'worker.id',
      'worker_id',
      'workerId',
    ];
    const taskKeys = ['cdx.task_id', 'task.id', 'task_id', 'taskId'];

    let runId = pickFirstString(overrides?.runId);
    if (!runId) runId = pickAttrString(runKeys, sources);
    const agentId = pickFirstString(overrides?.agentId) ?? pickAttrString(agentKeys, sources);
    const taskId = pickFirstString(overrides?.taskId) ?? pickAttrString(taskKeys, sources);
    if (!runId && agentId) runId = agentId;
    return { runId, agentId, taskId };
  }

  #recordOtlpAgentMessage({ runId, agentId, taskId, text }) {
    const clipped = this.#clipOtlpText(text);
    if (!clipped) return;
    this.recordEvent({
      type: 'appserver.notification',
      runId,
      agentId,
      taskId,
      phase: 'otel',
      method: 'item/completed',
      params: {
        item: {
          type: 'agentMessage',
          text: clipped,
        },
      },
    });
  }

  #ingestOtlpLogRecord(record, overrides) {
    const resourceAttrs = record.resourceAttrs ?? {};
    const scopeAttrs = record.scopeAttrs ?? {};
    const recordAttrs = record.recordAttrs ?? {};
    const bodyAttrs = maybeParseJsonObject(record.body);
    const metaAttrs = {
      traceId: record.traceId ?? null,
      spanId: record.spanId ?? null,
    };
    const { runId, agentId, taskId } = this.#resolveOtlpIdentifiers(
      resourceAttrs,
      recordAttrs,
      overrides,
      scopeAttrs,
      bodyAttrs,
      metaAttrs,
    );
    if (!runId) return { accepted: 0, rejected: 1 };
    this.#applyOtlpContext(runId, resourceAttrs, recordAttrs, scopeAttrs, bodyAttrs);

    const eventName = pickFirstString(
      recordAttrs['event.name'],
      recordAttrs.event_name,
      recordAttrs.eventName,
      bodyAttrs?.['event.name'],
      bodyAttrs?.event_name,
      bodyAttrs?.eventName,
    );
    const eventKind = pickFirstString(
      recordAttrs['event.kind'],
      recordAttrs.event_kind,
      recordAttrs.eventKind,
      bodyAttrs?.['event.kind'],
      bodyAttrs?.event_kind,
      bodyAttrs?.eventKind,
    );
    const model = pickFirstString(
      recordAttrs.model,
      bodyAttrs?.model,
      resourceAttrs.model,
      recordAttrs.slug,
      bodyAttrs?.slug,
      resourceAttrs.slug,
    );

    if (eventName === 'codex.conversation_starts') {
      this.recordEvent({
        type: 'run.started',
        runId,
        goal: 'codex session',
      });
      this.recordEvent({
        type: 'agent.started',
        runId,
        agentId: agentId ?? runId,
        phase: 'codex',
      });
      return { accepted: 1, rejected: 0 };
    }

    if (eventName === 'codex.user_prompt') {
      const prompt = pickFirstString(recordAttrs.prompt, bodyAttrs?.prompt, bodyAttrs?.text, record.body);
      const message = prompt ?? bodyAttrs ?? record.body;
      this.#recordOtlpAgentMessage({ runId, agentId: agentId ?? runId, taskId, text: message });
      return { accepted: 1, rejected: 0 };
    }

    if (eventName === 'codex.sse_event' && eventKind === 'response.completed') {
      const usage = {};
      const inputTokens = readTokenCount(recordAttrs, 'input_token_count');
      const cachedInputTokens = readTokenCount(recordAttrs, 'cached_token_count');
      const outputTokens = readTokenCount(recordAttrs, 'output_token_count');
      if (inputTokens !== null) usage.inputTokens = inputTokens;
      if (cachedInputTokens !== null) usage.cachedInputTokens = cachedInputTokens;
      if (outputTokens !== null) usage.outputTokens = outputTokens;
      this.recordEvent({
        type: 'turn.completed',
        runId,
        agentId: agentId ?? runId,
        taskId,
        model,
        usage,
      });
      return { accepted: 1, rejected: 0 };
    }

    if (eventName === 'codex.tool_result') {
      this.recordEvent({
        type: 'otel.tool_result',
        runId,
        agentId: agentId ?? runId,
        taskId,
        toolName: recordAttrs.tool_name ?? recordAttrs.toolName ?? null,
        callId: recordAttrs.call_id ?? recordAttrs.callId ?? null,
        durationMs: Number.parseInt(recordAttrs.duration_ms ?? recordAttrs.durationMs ?? 0, 10) || null,
        success: recordAttrs.success ?? null,
      });
      return { accepted: 1, rejected: 0 };
    }

    if (eventName === 'codex.tool_decision') {
      this.recordEvent({
        type: 'otel.tool_decision',
        runId,
        agentId: agentId ?? runId,
        taskId,
        toolName: recordAttrs.tool_name ?? recordAttrs.toolName ?? null,
        callId: recordAttrs.call_id ?? recordAttrs.callId ?? null,
        decision: recordAttrs.decision ?? null,
        source: recordAttrs.source ?? null,
      });
      return { accepted: 1, rejected: 0 };
    }

    if (eventName === 'codex.api_request') {
      this.recordEvent({
        type: 'otel.api_request',
        runId,
        agentId: agentId ?? runId,
        taskId,
        status: recordAttrs['http.response.status_code'] ?? recordAttrs.status ?? null,
        durationMs: Number.parseInt(recordAttrs.duration_ms ?? 0, 10) || null,
      });
      return { accepted: 1, rejected: 0 };
    }

    const fallbackMessage = this.#clipOtlpText(record.body ?? '');
    if (fallbackMessage) {
      this.#recordOtlpAgentMessage({ runId, agentId: agentId ?? runId, taskId, text: fallbackMessage });
    }
    this.recordEvent({
      type: 'otel.log',
      runId,
      agentId: agentId ?? runId,
      taskId,
      name: eventName ?? 'otel.log',
      kind: eventKind ?? null,
      severity: record.severityText ?? null,
    });
    return { accepted: 1, rejected: 0 };
  }

  async #ingestOtlpLogs(req, url) {
    const body = await readJsonBody(req, this.otlpMaxBytes);
    const records = extractOtlpLogRecords(body);
    const overrides = {
      runId: pickFirstString(url.searchParams.get('runId'), headerValue(req.headers, 'x-cdx-run-id')),
      agentId: pickFirstString(url.searchParams.get('agentId'), headerValue(req.headers, 'x-cdx-agent-id')),
      taskId: pickFirstString(url.searchParams.get('taskId'), headerValue(req.headers, 'x-cdx-task-id')),
    };
    let accepted = 0;
    let rejected = 0;
    for (const record of records) {
      const outcome = this.#ingestOtlpLogRecord(record, overrides);
      accepted += outcome.accepted;
      rejected += outcome.rejected;
    }
    return {
      ok: true,
      accepted,
      rejected,
      partialSuccess: rejected > 0
        ? { rejectedLogRecords: rejected, errorMessage: 'some log records were dropped' }
        : null,
    };
  }

  async #ingestOtlpTraces(req, url) {
    const body = await readJsonBody(req, this.otlpMaxBytes);
    const spans = extractOtlpSpans(body);
    const overrides = {
      runId: pickFirstString(url.searchParams.get('runId'), headerValue(req.headers, 'x-cdx-run-id')),
      agentId: pickFirstString(url.searchParams.get('agentId'), headerValue(req.headers, 'x-cdx-agent-id')),
      taskId: pickFirstString(url.searchParams.get('taskId'), headerValue(req.headers, 'x-cdx-task-id')),
    };
    const counts = new Map();
    let accepted = 0;
    let rejected = 0;
    for (const span of spans) {
      const { runId } = this.#resolveOtlpIdentifiers(
        span.resourceAttrs ?? {},
        span.spanAttrs ?? {},
        overrides,
        span.scopeAttrs ?? {},
        null,
        null,
      );
      if (!runId) {
        rejected += 1;
        continue;
      }
      accepted += 1;
      this.#applyOtlpContext(runId, span.resourceAttrs ?? {}, span.spanAttrs ?? {}, span.scopeAttrs ?? {});
      counts.set(runId, (counts.get(runId) ?? 0) + 1);
    }
    for (const [runId, spanCount] of counts.entries()) {
      this.recordEvent({ type: 'otel.traces', runId, spanCount });
    }
    return {
      ok: true,
      accepted,
      rejected,
      partialSuccess: rejected > 0
        ? { rejectedSpans: rejected, errorMessage: 'some spans were dropped' }
        : null,
    };
  }

  getState(runId = null) {
    const resolvedRunId = this.#resolveReadableRunId(runId);

    const runs = [...this.runs.values()]
      .sort((a, b) => (b?.createdAt ?? 0) - (a?.createdAt ?? 0))
      .slice(0, 50)
      .map(entry => {
        const agents = [...(entry.agents?.values?.() ?? [])];
        const tasks = [...(entry.tasks?.values?.() ?? [])];
        const asks = [...(entry.asks?.values?.() ?? [])];
        const countedAgents = agents.filter(isCountedAgentForStats);
        const plannedTaskCount = Number.isFinite(entry.plannedTaskCount)
          ? entry.plannedTaskCount
          : Number.parseInt(entry.plannedTaskCount, 10) || 0;
        const tasksTotal = Math.max(tasks.length, plannedTaskCount);
        const knownPending = tasks.filter(task => task.status === 'pending').length;
        const missingTasks = Math.max(0, tasksTotal - tasks.length);
        const counts = {
          agentsRunning: countedAgents.filter(agent => agent.status === 'running' || agent.status === 'disposing').length,
          tasksPending: knownPending + missingTasks,
          tasksRunning: tasks.filter(task => task.status === 'running').length,
          tasksSuperseded: tasks.filter(task => task.status === 'superseded').length,
          tasksFailed: tasks.filter(task => task.status === 'failed').length,
          tasksBlocked: tasks.filter(task => task.status === 'blocked').length,
          asksPending: asks.filter(ask => ask.status === 'pending').length,
        };
        const derivedState = buildRunDerivedState({
          status: entry.status,
          counts,
          scheduler: entry.scheduler ?? null,
          agents,
          pid: entry.pid ?? null,
        }, process.pid);
        return {
          id: entry.id,
          status: entry.status,
          goal: entry.goal,
          createdAt: entry.createdAt,
          startedAt: entry.createdAt,
          completedAt: entry.completedAt,
          pid: entry.pid ?? null,
          cwd: entry.cwd ?? null,
          repoRoot: entry.repoRoot ?? null,
          runRoot: entry.runRoot ?? null,
          worktreeRoot: entry.worktreeRoot ?? null,
          processCommand: entry.processCommand ?? null,
          lastCommand: entry.lastCommand ?? null,
          lastCommandAt: entry.lastCommandAt ?? null,
          currentTaskSummary: summarizeRunTaskSummary(entry),
          stage: derivedState.stage,
          inFlight: derivedState.inFlight,
          canKill: derivedState.canKill,
        };
      });

    return {
      serverPid: process.pid,
      activeRunId: this.activeRunId,
      runs,
      activeRun: resolvedRunId ? this.getRunState(resolvedRunId) : null,
    };
  }

  #isPlaceholderRun(run) {
    if (!run) return false;
    const status = String(run.status ?? '').trim().toLowerCase();
    if (status && status !== 'unknown') return false;
    if (
      pickFirstString(
        run.goal,
        run.cwd,
        run.repoRoot,
        run.headRef,
        run.worktreeRoot,
        run.runRoot,
        run.integrationBranch,
        run.processCommand,
        run.lastCommand,
      )
    ) {
      return false;
    }
    if (run.pid !== null && run.pid !== undefined) return false;
    const taskCount = run.tasks instanceof Map ? run.tasks.size : 0;
    const askCount = run.asks instanceof Map ? run.asks.size : 0;
    const workerCount = run.workers instanceof Map ? run.workers.size : 0;
    const nonServerAgentCount = run.agents instanceof Map
      ? [...run.agents.values()].filter(agent => String(agent?.agentId ?? '').trim() !== 'server').length
      : 0;
    const plannedTaskCount = Number.isFinite(run.plannedTaskCount)
      ? run.plannedTaskCount
      : Number.parseInt(run.plannedTaskCount, 10) || 0;
    return (
      taskCount === 0
      && askCount === 0
      && workerCount === 0
      && nonServerAgentCount === 0
      && plannedTaskCount === 0
      && !isObject(run.checklist)
      && !isObject(run.scheduler)
    );
  }

  #runAliasScore(run) {
    if (!run) return Number.NEGATIVE_INFINITY;
    const status = String(run.status ?? '').trim().toLowerCase();
    let score = 0;
    if (run.id === this.activeRunId) score += 2_000;
    if (status === 'running' || status === 'disposing' || status === 'merging') {
      score += 1_000;
    } else if (status === 'completed') {
      score += 800;
    } else if (status === 'failed' || status === 'blocked') {
      score += 700;
    } else if (status && status !== 'unknown') {
      score += 500;
    }
    if (!this.#isPlaceholderRun(run)) score += 400;
    if (run.repoRoot) score += 50;
    if (run.goal) score += 25;
    if (run.pid !== null && run.pid !== undefined) score += 25;
    score += Math.min(200, run.tasks instanceof Map ? run.tasks.size : 0);
    score += Math.min(50, run.asks instanceof Map ? run.asks.size : 0);
    score += Math.min(50, run.workers instanceof Map ? run.workers.size : 0);
    score += Math.min(50, Array.isArray(run.events?.items) ? run.events.items.length : 0);
    return score;
  }

  #resolveReadableRunId(runId) {
    const requestedRunId =
      typeof runId === 'string' && runId.trim()
        ? runId.trim()
        : typeof this.activeRunId === 'string' && this.activeRunId.trim()
          ? this.activeRunId.trim()
          : null;
    if (!requestedRunId) return null;

    const exactRun = this.runs.get(requestedRunId) ?? null;
    const prefix = `${requestedRunId}-`;
    const candidates = [...this.runs.values()].filter(candidate => {
      const candidateId = String(candidate?.id ?? '').trim();
      return Boolean(candidateId) && candidateId !== requestedRunId && candidateId.startsWith(prefix);
    });
    if (candidates.length === 0) {
      return exactRun ? requestedRunId : requestedRunId;
    }
    if (exactRun && !this.#isPlaceholderRun(exactRun)) {
      return requestedRunId;
    }

    candidates.sort((a, b) => {
      const scoreDelta = this.#runAliasScore(b) - this.#runAliasScore(a);
      if (scoreDelta !== 0) return scoreDelta;
      return (Number(b?.createdAt) || 0) - (Number(a?.createdAt) || 0);
    });
    const preferred = candidates[0] ?? null;
    if (preferred && !this.#isPlaceholderRun(preferred)) {
      return preferred.id;
    }
    if (exactRun) return requestedRunId;
    return preferred?.id ?? requestedRunId;
  }

  getRunState(runId) {
    const resolvedId = this.#resolveReadableRunId(runId);
    const run = resolvedId ? this.runs.get(resolvedId) : null;
    if (!run) return null;

    const agents = [...run.agents.values()].sort((a, b) =>
      String(a.agentId).localeCompare(String(b.agentId)),
    );
    const taskAgentByTaskId = new Map();
    for (const agent of agents) {
      const taskId = String(agent?.taskId ?? '').trim();
      if (!taskId) continue;
      const prev = taskAgentByTaskId.get(taskId) ?? null;
      const prevRunning = prev && (prev.status === 'running' || prev.status === 'disposing');
      const nextRunning = agent?.status === 'running' || agent?.status === 'disposing';
      if (!prev || (!prevRunning && nextRunning)) {
        taskAgentByTaskId.set(taskId, agent);
      }
    }
    const tasks = [...run.tasks.values()]
      .sort((a, b) =>
        String(a.taskId).localeCompare(String(b.taskId)),
      )
      .map(task => {
        const taskId = String(task?.taskId ?? '').trim();
        const resolvedAgent = taskId ? taskAgentByTaskId.get(taskId) ?? null : null;
        const resolvedAgentId =
          String(task?.agentId ?? '').trim()
          || String(resolvedAgent?.agentId ?? '').trim()
          || (taskId ? `task:${taskId}` : '');
        const outputTail = buildTaskOutputTail(run.logs.get(resolvedAgentId)?.items ?? []);
        return {
          ...task,
          agentId: resolvedAgentId || null,
          stdoutText: outputTail.text,
          stdoutLineCount: outputTail.lineCount,
          stdoutTotalLines: outputTail.totalLines,
          stdoutTruncated: outputTail.truncated,
          stdoutHasStream: outputTail.hasStream,
        };
      });
    const asks = [...(run.asks?.values?.() ?? [])].sort((a, b) =>
      (a.createdAt ?? 0) - (b.createdAt ?? 0),
    );
    const countedAgents = agents.filter(isCountedAgentForStats);

    const plannedTaskCount = Number.isFinite(run.plannedTaskCount)
      ? run.plannedTaskCount
      : Number.parseInt(run.plannedTaskCount, 10) || 0;

    const tasksTotal = Math.max(tasks.length, plannedTaskCount);
    const knownPending = tasks.filter(t => t.status === 'pending').length;
    const missingTasks = Math.max(0, tasksTotal - tasks.length);

    const counts = {
      agentsTotal: countedAgents.length,
      agentsRunning: countedAgents.filter(agent => agent.status === 'running' || agent.status === 'disposing').length,
      agentsDisposed: countedAgents.filter(agent => agent.status === 'disposed').length,
      tasksTotal,
      tasksPending: knownPending + missingTasks,
      tasksRunning: tasks.filter(t => t.status === 'running').length,
      tasksCompleted: tasks.filter(t => t.status === 'completed').length,
      tasksSuperseded: tasks.filter(t => t.status === 'superseded').length,
      tasksFailed: tasks.filter(t => t.status === 'failed').length,
      tasksBlocked: tasks.filter(t => t.status === 'blocked').length,
      asksPending: asks.filter(a => a.status === 'pending').length,
      parallelism: Number.isFinite(run.parallelism) ? run.parallelism : null,
      readyCount: run.scheduler?.readyCount ?? null,
      readyRunnableCount: run.scheduler?.readyRunnableCount ?? null,
      locksHeldTasks: run.scheduler?.locksHeldTasks ?? null,
      locksHeldKeys: run.scheduler?.locksHeldKeys ?? null,
      bottleneckKind: run.scheduler?.bottleneckKind ?? null,
      workerPoolSize: run.workerPoolSize ?? null,
      workerBusy: run.workerBusy ?? null,
    };

    const tokens = run.tokens ?? null;
    const costUsd = Number.isFinite(run.costUsd) ? run.costUsd : null;
    const scoutOutputTail = buildTaskOutputTail(run.logs.get('scout')?.items ?? []);
    const plannerOutputTail = buildTaskOutputTail(run.logs.get('planner')?.items ?? []);
    const watchdogLogs = run.logs.get('watchdog')?.items ?? [];
    const watchdogOutputTail = buildTaskOutputTail(watchdogLogs);
    const watchdogAgent = agents.find(agent => String(agent?.agentId ?? '') === 'watchdog') ?? null;
    const watchdogLive = agents.some(agent =>
      String(agent?.agentId ?? '') === 'watchdog'
      && (agent?.status === 'running' || agent?.status === 'disposing')
    );
    const watchdogTurns = buildWatchdogTurnsSnapshot(run.watchdogTurns?.items ?? [], watchdogLogs, {
      live: watchdogLive,
    });
    const watchdogLatest = buildWatchdogLatestSnapshot(watchdogTurns, watchdogOutputTail, {
      live: watchdogLive,
      agent: watchdogAgent,
    });
    const checklistConfig = isObject(run.checklist) ? run.checklist : null;
    const checklist = checklistConfig ? buildChecklistBoard(checklistConfig, tasks) : null;
    const derivedState = buildRunDerivedState({
      status: run.status,
      counts,
      scheduler: run.scheduler ?? null,
      agents,
      pid: run.pid ?? null,
    }, process.pid);

    return {
      id: run.id,
      goal: run.goal,
      status: run.status,
      error: run.error,
      pid: run.pid ?? null,
      cwd: run.cwd ?? null,
      repoRoot: run.repoRoot,
      headRef: run.headRef,
      worktreeRoot: run.worktreeRoot,
      runRoot: run.runRoot,
      integrationBranch: run.integrationBranch,
      keepWorktrees: run.keepWorktrees ?? false,
      processCommand: run.processCommand ?? null,
      lastCommand: run.lastCommand ?? null,
      lastCommandAt: run.lastCommandAt ?? null,
      currentTaskSummary: summarizeRunTaskSummary(run),
      stage: derivedState.stage,
      inFlight: derivedState.inFlight,
      canKill: derivedState.canKill,
      startedAt: run.createdAt,
      completedAt: run.completedAt,
      plannedTaskCount,
      plannerPlanText: run.plannerPlanText ?? null,
      plannerPlanAt: run.plannerPlanAt ?? null,
      scoutStdoutText: scoutOutputTail.text,
      scoutStdoutLineCount: scoutOutputTail.lineCount,
      scoutStdoutTotalLines: scoutOutputTail.totalLines,
      scoutStdoutTruncated: scoutOutputTail.truncated,
      scoutStdoutHasStream: scoutOutputTail.hasStream,
      plannerStdoutText: plannerOutputTail.text,
      plannerStdoutLineCount: plannerOutputTail.lineCount,
      plannerStdoutTotalLines: plannerOutputTail.totalLines,
      plannerStdoutTruncated: plannerOutputTail.truncated,
      plannerStdoutHasStream: plannerOutputTail.hasStream,
      watchdogStdoutText: watchdogOutputTail.text,
      watchdogStdoutLineCount: watchdogOutputTail.lineCount,
      watchdogStdoutTotalLines: watchdogOutputTail.totalLines,
      watchdogStdoutTruncated: watchdogOutputTail.truncated,
      watchdogStdoutHasStream: watchdogOutputTail.hasStream,
      watchdogLatest,
      checklist,
      counts,
      tokens,
      costUsd,
      scheduler: run.scheduler ?? null,
      workers: [...(run.workers?.values?.() ?? [])].sort((a, b) =>
        String(a?.workerId ?? '').localeCompare(String(b?.workerId ?? '')),
      ),
      watchdogTurns,
      agents,
      tasks,
      asks,
    };
  }

  getPrometheusMetrics(runId = null) {
    const resolvedRunId = this.#resolveReadableRunId(runId);

    const run = resolvedRunId ? this.getRunState(resolvedRunId) : null;
    const rawRun = resolvedRunId ? this.runs.get(resolvedRunId) ?? null : null;
    const labels = resolvedRunId ? { run_id: resolvedRunId } : {};

    let body = '';
    body += '# HELP cdx_active_run Whether a run is active (selected run).\n';
    body += '# TYPE cdx_active_run gauge\n';
    body += promSample('cdx_active_run', labels, run ? 1 : 0);

    if (!run) return body;

    body += '# HELP cdx_tasks Number of tasks by status.\n';
    body += '# TYPE cdx_tasks gauge\n';
    body += promSample('cdx_tasks', { ...labels, status: 'pending' }, run.counts?.tasksPending ?? 0);
    body += promSample('cdx_tasks', { ...labels, status: 'running' }, run.counts?.tasksRunning ?? 0);
    body += promSample('cdx_tasks', { ...labels, status: 'completed' }, run.counts?.tasksCompleted ?? 0);
    body += promSample('cdx_tasks', { ...labels, status: 'superseded' }, run.counts?.tasksSuperseded ?? 0);
    body += promSample('cdx_tasks', { ...labels, status: 'failed' }, run.counts?.tasksFailed ?? 0);
    body += promSample('cdx_tasks', { ...labels, status: 'blocked' }, run.counts?.tasksBlocked ?? 0);

    body += '# HELP cdx_events_total Total CDX events observed by type.\n';
    body += '# TYPE cdx_events_total counter\n';
    const eventCounters =
      rawRun?.eventCounters instanceof Map ? [...rawRun.eventCounters.entries()] : [];
    eventCounters.sort((a, b) => String(a?.[0] ?? '').localeCompare(String(b?.[0] ?? '')));
    for (const [eventType, count] of eventCounters) {
      body += promSample('cdx_events_total', { ...labels, type: eventType }, count);
    }

    body += '# HELP cdx_scheduler_ready Number of tasks in ready queue.\n';
    body += '# TYPE cdx_scheduler_ready gauge\n';
    body += promSample('cdx_scheduler_ready', labels, run.scheduler?.readyCount ?? 0);

    body += '# HELP cdx_scheduler_ready_runnable Number of ready tasks runnable now.\n';
    body += '# TYPE cdx_scheduler_ready_runnable gauge\n';
    body += promSample('cdx_scheduler_ready_runnable', labels, run.scheduler?.readyRunnableCount ?? 0);

    body += '# HELP cdx_scheduler_parallelism Current scheduler parallelism.\n';
    body += '# TYPE cdx_scheduler_parallelism gauge\n';
    body += promSample('cdx_scheduler_parallelism', labels, run.scheduler?.currentParallelism ?? run.counts?.parallelism ?? 0);

    body += '# HELP cdx_worker_pool_size Task worker pool size.\n';
    body += '# TYPE cdx_worker_pool_size gauge\n';
    body += promSample('cdx_worker_pool_size', labels, run.counts?.workerPoolSize ?? 0);

    body += '# HELP cdx_worker_busy Task workers currently acquired.\n';
    body += '# TYPE cdx_worker_busy gauge\n';
    body += promSample('cdx_worker_busy', labels, run.counts?.workerBusy ?? 0);

    const tasks = Array.isArray(run.tasks) ? run.tasks : [];
    const queueWaitSeconds = [];
    const runSeconds = [];
    const failedByReason = new Map();
    const blockedByReason = new Map();

    const classifyReason = (status, error) => {
      const text = String(error ?? '').toLowerCase();
      if (!text) return 'unknown';
      if (status === 'blocked') {
        if (text.includes('blocked by failed')) return 'dependency_failed';
      }
      if (text.includes('conflict') || text.includes('automatic merge failed')) return 'merge_conflict';
      if (text.includes('timeout')) return 'timeout';
      if (text.includes('router.ask')) return 'router_ask';
      if (text.includes('worker_pool_closed') || text.includes('worker pool')) return 'worker_pool';
      return 'other';
    };

    for (const task of tasks) {
      const readyAt = Number(task?.readyAt);
      const startedAt = Number(task?.startedAt);
      const finishedAt = Number(task?.finishedAt);
      if (Number.isFinite(readyAt) && Number.isFinite(startedAt) && startedAt >= readyAt) {
        queueWaitSeconds.push((startedAt - readyAt) / 1000);
      }
      if (Number.isFinite(startedAt) && Number.isFinite(finishedAt) && finishedAt >= startedAt) {
        runSeconds.push((finishedAt - startedAt) / 1000);
      }

      if (task?.status === 'failed') {
        const reason = classifyReason('failed', task?.error);
        failedByReason.set(reason, (failedByReason.get(reason) ?? 0) + 1);
      } else if (task?.status === 'blocked') {
        const reason = classifyReason('blocked', task?.error);
        blockedByReason.set(reason, (blockedByReason.get(reason) ?? 0) + 1);
      }
    }

    body += promHistogram({
      name: 'cdx_task_queue_wait_seconds',
      help: 'Time from task ready to started.',
      values: queueWaitSeconds,
      buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600],
      labels,
    });

    body += promHistogram({
      name: 'cdx_task_run_seconds',
      help: 'Task execution wall time (started to finished).',
      values: runSeconds,
      buckets: [1, 2, 5, 10, 30, 60, 120, 300, 600, 1800, 3600],
      labels,
    });

    body += '# HELP cdx_task_failures Total failed tasks by reason.\n';
    body += '# TYPE cdx_task_failures gauge\n';
    for (const [reason, count] of failedByReason.entries()) {
      body += promSample('cdx_task_failures', { ...labels, reason }, count);
    }

    body += '# HELP cdx_task_blocked Total blocked tasks by reason.\n';
    body += '# TYPE cdx_task_blocked gauge\n';
    for (const [reason, count] of blockedByReason.entries()) {
      body += promSample('cdx_task_blocked', { ...labels, reason }, count);
    }

    return body;
  }

  getOtelMetrics(runId = null) {
    const resolvedRunId = this.#resolveReadableRunId(runId);
    const run = resolvedRunId ? this.getRunState(resolvedRunId) : null;
    const rawRun = resolvedRunId ? this.runs.get(resolvedRunId) ?? null : null;
    if (!run) {
      return {
        resource: { serviceName: 'cdx-stats', runId: resolvedRunId ?? null },
        metrics: [],
      };
    }

    const eventCounters =
      rawRun?.eventCounters instanceof Map ? [...rawRun.eventCounters.entries()] : [];
    eventCounters.sort((a, b) => String(a?.[0] ?? '').localeCompare(String(b?.[0] ?? '')));

    return {
      resource: { serviceName: 'cdx-stats', runId: resolvedRunId },
      metrics: [
        {
          name: 'cdx.tasks',
          type: 'gauge',
          unit: '1',
          dataPoints: [
            { attributes: { status: 'pending' }, value: run.counts?.tasksPending ?? 0 },
            { attributes: { status: 'running' }, value: run.counts?.tasksRunning ?? 0 },
            { attributes: { status: 'completed' }, value: run.counts?.tasksCompleted ?? 0 },
            { attributes: { status: 'superseded' }, value: run.counts?.tasksSuperseded ?? 0 },
            { attributes: { status: 'failed' }, value: run.counts?.tasksFailed ?? 0 },
            { attributes: { status: 'blocked' }, value: run.counts?.tasksBlocked ?? 0 },
          ],
        },
        {
          name: 'cdx.events',
          type: 'counter',
          unit: '1',
          dataPoints: eventCounters.map(([eventType, value]) => ({
            attributes: { type: eventType },
            value,
          })),
        },
        {
          name: 'cdx.scheduler.ready',
          type: 'gauge',
          unit: '1',
          dataPoints: [{ attributes: {}, value: run.scheduler?.readyCount ?? 0 }],
        },
        {
          name: 'cdx.scheduler.ready_runnable',
          type: 'gauge',
          unit: '1',
          dataPoints: [{ attributes: {}, value: run.scheduler?.readyRunnableCount ?? 0 }],
        },
        {
          name: 'cdx.worker_pool.size',
          type: 'gauge',
          unit: '1',
          dataPoints: [{ attributes: {}, value: run.counts?.workerPoolSize ?? 0 }],
        },
        {
          name: 'cdx.worker_pool.busy',
          type: 'gauge',
          unit: '1',
          dataPoints: [{ attributes: {}, value: run.counts?.workerBusy ?? 0 }],
        },
      ],
    };
  }

  getLogs(agentId, after, limit, runId) {
    const resolvedAgent = typeof agentId === 'string' && agentId.trim() ? agentId.trim() : 'server';
    const resolvedRunId = this.#resolveReadableRunId(runId);
    const run = resolvedRunId ? this.runs.get(resolvedRunId) : null;
    const store = run ? run.logs.get(resolvedAgent) : this.serverLogs;
    if (!store) return { items: [], next: Number.parseInt(after, 10) || 0, lastLogId: 0 };
    const items = store.since(after, limit);
    const next = items.length > 0 ? items[items.length - 1].id : Number.parseInt(after, 10) || 0;
    const lastLogId = store.items.length > 0 ? store.items[store.items.length - 1].id : 0;
    return { items, next, lastLogId };
  }

  async waitForLog(runId, agentId, afterId, timeoutMs, req) {
    const resolvedAgent = typeof agentId === 'string' && agentId.trim() ? agentId.trim() : 'server';
    const resolvedRunId = this.#resolveReadableRunId(runId);
    const key = `${resolvedRunId ?? 'server'}|${resolvedAgent}`;
    const after = Number.parseInt(afterId, 10) || 0;
    const timeout = Math.max(0, Math.min(LOG_LONG_POLL_MAX_MS, Number.parseInt(timeoutMs, 10) || 0));

    const snapshot = () => {
      const run = resolvedRunId ? this.runs.get(resolvedRunId) : null;
      const store = run ? run.logs.get(resolvedAgent) : this.serverLogs;
      const lastLogId = store?.items?.length > 0 ? store.items[store.items.length - 1].id : 0;
      return { store, lastLogId };
    };

    const snap = snapshot();
    if (snap.lastLogId > after) {
      return { ok: true, timedOut: false, lastLogId: snap.lastLogId };
    }

    if (timeout <= 0) {
      return { ok: true, timedOut: true, lastLogId: snap.lastLogId };
    }

    return await new Promise(resolve => {
      const set = this.logWaiters.get(key) ?? new Set();
      this.logWaiters.set(key, set);

      const waiter = {
        afterId: after,
        timer: null,
        cleanup: () => {},
        resolve,
      };

      const finalize = payload => {
        waiter.cleanup?.();
        resolve(payload);
      };

      waiter.cleanup = () => {
        if (waiter.timer) clearTimeout(waiter.timer);
        if (typeof req?.off === 'function') req.off('close', onClose);
        this.#removeLogWaiter(key, waiter);
      };

      const onClose = () => {
        const latest = snapshot().lastLogId;
        finalize({ ok: false, timedOut: true, lastLogId: latest });
      };

      if (typeof req?.once === 'function') req.once('close', onClose);

      waiter.timer = setTimeout(() => {
        const latest = snapshot().lastLogId;
        finalize({ ok: true, timedOut: true, lastLogId: latest });
      }, timeout);
      waiter.timer.unref?.();

      set.add(waiter);
    });
  }

  getRunEvents(runId, afterId, limit) {
    const run = this.#runForId(runId);
    const after = Number.parseInt(afterId, 10) || 0;
    const max = Math.max(0, Math.min(2000, Number.parseInt(limit, 10) || 0));
    if (!run?.events) {
      return { items: [], next: after, lastEventId: 0 };
    }
    const items = max > 0 ? run.events.since(after, max) : [];
    const next = items.length > 0 ? items[items.length - 1].id : after;
    const lastEventId = run.events.items.length > 0 ? run.events.items[run.events.items.length - 1].id : 0;
    return { items, next, lastEventId };
  }

  async waitForRunEvent(runId, afterId, timeoutMs) {
    const resolvedRunId = this.#resolveReadableRunId(runId);
    const run = resolvedRunId ? this.runs.get(resolvedRunId) ?? null : null;
    if (!resolvedRunId || !run) return { ok: false, timedOut: true, lastEventId: 0 };
    const after = Number.parseInt(afterId, 10) || 0;
    const timeout = Math.max(0, Math.min(120_000, Number.parseInt(timeoutMs, 10) || 0));
    const lastEventId = run.events.items.length > 0 ? run.events.items[run.events.items.length - 1].id : 0;

    if (lastEventId > after) {
      return { ok: true, timedOut: false, lastEventId };
    }

    if (timeout <= 0) {
      return { ok: true, timedOut: true, lastEventId };
    }

    return await new Promise(resolve => {
      const waiter = {
        afterId: after,
        resolve,
        timer: null,
      };

      if (!this.eventWaiters.has(resolvedRunId)) {
        this.eventWaiters.set(resolvedRunId, new Set());
      }
      this.eventWaiters.get(resolvedRunId).add(waiter);

      waiter.timer = setTimeout(() => {
        this.#removeEventWaiter(resolvedRunId, waiter);
        const latest = run.events.items.length > 0 ? run.events.items[run.events.items.length - 1].id : 0;
        resolve({ ok: true, timedOut: true, lastEventId: latest });
      }, timeout);
      waiter.timer.unref?.();
    });
  }

	  async #handleRequest(req, res) {
	    const method = (req.method ?? 'GET').toUpperCase();
	    const url = new URL(req.url ?? '/', 'http://localhost');

	    if (method === 'GET' && url.pathname === '/') {
	      sendText(res, 200, INDEX_HTML, 'text/html; charset=utf-8');
	      return;
    }

    if (method === 'GET' && url.pathname === '/metrics') {
      const runId = url.searchParams.get('runId');
      const body = this.getPrometheusMetrics(runId);
      sendText(res, 200, body, 'text/plain; version=0.0.4; charset=utf-8');
      return;
    }

    if (method === 'GET' && url.pathname === '/api/otel/metrics') {
      const runId = url.searchParams.get('runId');
      sendJson(res, 200, this.getOtelMetrics(runId));
      return;
    }

    if (method === 'GET' && url.pathname === '/internal/ping') {
      sendJson(res, 200, { ok: true, url: this.url, pid: process.pid });
      return;
    }

    if (method === 'POST' && url.pathname === '/internal/log') {
      try {
        const body = await readJsonBody(req, this.otlpMaxBytes);
        this.recordLog(body?.message ?? body?.payload ?? body, body?.runId ?? null);
        sendJson(res, 200, { ok: true });
      } catch (err) {
        const status = Number.isFinite(err?.statusCode) ? err.statusCode : 500;
        const message = err instanceof Error ? err.message : String(err ?? 'internal_log_failed');
        sendJson(res, status, { error: message });
      }
      return;
    }

    if (method === 'POST' && url.pathname === '/internal/event') {
      try {
        const body = await readJsonBody(req, this.otlpMaxBytes);
        const payload = isObject(body?.payload) ? body.payload : body;
        this.recordEvent(payload);
        sendJson(res, 200, { ok: true });
      } catch (err) {
        const status = Number.isFinite(err?.statusCode) ? err.statusCode : 500;
        const message = err instanceof Error ? err.message : String(err ?? 'internal_event_failed');
        sendJson(res, status, { error: message });
      }
      return;
    }

    if (method === 'POST' && url.pathname === '/internal/seed-debug-run') {
      try {
        const body = await readJsonBody(req, this.otlpMaxBytes);
        const seeded = this.seedDebugRun(isObject(body?.options) ? body.options : body);
        sendJson(res, 200, { ok: true, ...seeded });
      } catch (err) {
        const status = Number.isFinite(err?.statusCode) ? err.statusCode : 500;
        const message = err instanceof Error ? err.message : String(err ?? 'internal_seed_debug_run_failed');
        sendJson(res, status, { error: message });
      }
      return;
    }

    if (method === 'POST' && url.pathname === '/v1/logs') {
      if (!this.otlpEnabled) {
        sendJson(res, 404, { error: 'otlp_disabled' });
        return;
      }
      try {
        const result = await this.#ingestOtlpLogs(req, url);
        sendJson(res, 200, result);
      } catch (err) {
        const status = Number.isFinite(err?.statusCode) ? err.statusCode : 500;
        const message = err instanceof Error ? err.message : String(err ?? 'otlp_logs_failed');
        sendJson(res, status, { error: message });
      }
      return;
    }

    if (method === 'POST' && url.pathname === '/v1/traces') {
      if (!this.otlpEnabled) {
        sendJson(res, 404, { error: 'otlp_disabled' });
        return;
      }
      try {
        const result = await this.#ingestOtlpTraces(req, url);
        sendJson(res, 200, result);
      } catch (err) {
        const status = Number.isFinite(err?.statusCode) ? err.statusCode : 500;
        const message = err instanceof Error ? err.message : String(err ?? 'otlp_traces_failed');
        sendJson(res, status, { error: message });
      }
      return;
    }
    if (method === 'GET' && url.pathname === '/api/state') {
      const runId = url.searchParams.get('runId');
      sendJson(res, 200, this.getState(runId));
      return;
    }

    if (method === 'GET' && url.pathname === '/api/git-tree') {
      const runIdParam = url.searchParams.get('runId');
      const run = this.#runForId(runIdParam);
      if (!run || !run.repoRoot) {
        sendJson(res, 404, { error: 'unknown_run' });
        return;
      }

      const requestedRef = url.searchParams.get('ref');
      const ref =
        pickFirstString(requestedRef, run.headRef, 'HEAD')
        ?? 'HEAD';
      const maxRaw = Number.parseInt(url.searchParams.get('max') ?? '0', 10);
      const max = Number.isFinite(maxRaw) && maxRaw > 0
        ? Math.max(1, Math.min(20_000, maxRaw))
        : 4000;

      try {
        const output = await git(['ls-tree', '-r', '--name-only', ref], { cwd: run.repoRoot });
        const paths = String(output ?? '')
          .replace(/\r/g, '')
          .split('\n')
          .filter(line => line.length > 0);
        const total = paths.length;
        const truncated = total > max;
        const limitedPaths = truncated ? paths.slice(0, max) : paths;
        sendJson(res, 200, {
          runId: run.id,
          repoRoot: run.repoRoot,
          ref,
          total,
          truncated,
          paths: limitedPaths,
        });
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err ?? 'unknown_error');
        sendJson(res, 500, { error: message });
        return;
      }
    }

    if (method === 'POST' && url.pathname === '/api/kill') {
      sendJson(res, 200, { ok: true, pid: process.pid });
      setTimeout(() => {
        try {
          process.kill(process.pid, 'SIGKILL');
        } catch {
          process.exit(1);
        }
      }, 50);
      return;
    }

    if (method === 'GET' && url.pathname === '/api/logs/stream') {
      const agentId = url.searchParams.get('agentId') ?? 'server';
      const runIdRaw = url.searchParams.get('runId');
      const resolvedRunId = this.#resolveReadableRunId(runIdRaw);
      const resolvedAgent =
        typeof agentId === 'string' && agentId.trim() ? agentId.trim() : 'server';

      const headerIdRaw = req.headers['last-event-id'];
      const headerId = Array.isArray(headerIdRaw) ? headerIdRaw[0] : headerIdRaw;
      const afterHeader = parseNonNegativeInt(headerId);
      const afterQuery = parseNonNegativeInt(url.searchParams.get('after'));
      const after = afterHeader ?? afterQuery ?? 0;
      const limitRaw = parseNonNegativeInt(url.searchParams.get('limit'));
      const limit = Math.max(0, Math.min(5000, limitRaw ?? 2000));

      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();
      res.write('retry: 2000\n\n');

      const key = `${resolvedRunId ?? 'server'}|${resolvedAgent}`;
      const stream = {
        lastSentId: after,
        closed: false,
        suspended: true,
        pending: [],
        send: entry => {
          if (stream.closed || res.writableEnded) return;
          const payload = JSON.stringify({
            text: String(entry.text ?? '').replace(/\r/g, ''),
            stream: entry.stream === true,
          });
          res.write(`id: ${entry.id}\n`);
          res.write(`data: ${payload}\n\n`);
          stream.lastSentId = entry.id;
        },
        close: () => {
          if (stream.closed) return;
          stream.closed = true;
          stream.pending = [];
          if (heartbeat) clearInterval(heartbeat);
          this.#removeLogStream(key, stream);
          try {
            res.end();
          } catch {
            // ignore
          }
        },
      };

      if (!this.logStreams.has(key)) {
        this.logStreams.set(key, new Set());
      }
      this.logStreams.get(key).add(stream);

      const heartbeat = setInterval(() => {
        if (stream.closed || res.writableEnded) {
          stream.close();
          return;
        }
        res.write(': ping\n\n');
      }, 15_000);
      heartbeat.unref?.();

      req.on('close', () => stream.close());
      res.on('close', () => stream.close());

      try {
        const result = this.getLogs(resolvedAgent, after, limit, resolvedRunId);
        for (const item of result.items) {
          if (item && item.id > stream.lastSentId) stream.send(item);
        }
        stream.suspended = false;
        if (stream.pending.length > 0) {
          for (const item of stream.pending) {
            if (item && item.id > stream.lastSentId) stream.send(item);
          }
          stream.pending = [];
        }
      } catch {
        stream.close();
      }
      return;
    }

	    if (method === 'GET' && url.pathname === '/api/logs') {
	      const agentId = url.searchParams.get('agentId') ?? 'server';
	      const requestedRunId = url.searchParams.get('runId');
	      const resolvedRunId = this.#resolveReadableRunId(requestedRunId);
	      const after = Math.max(0, Number.parseInt(url.searchParams.get('after') ?? '0', 10) || 0);
	      const limit = Math.max(
	        0,
	        Math.min(2000, Number.parseInt(url.searchParams.get('limit') ?? '500', 10) || 0),
	      );
	      const timeoutMs = Math.max(
	        0,
	        Math.min(LOG_LONG_POLL_MAX_MS, Number.parseInt(url.searchParams.get('timeoutMs') ?? '0', 10) || 0),
	      );

	      const run = resolvedRunId ? this.runs.get(resolvedRunId) : null;
	      if (requestedRunId && !run) {
	        sendJson(res, 200, {
	          ok: true,
	          runId: resolvedRunId ?? requestedRunId,
	          agentId,
	          after,
	          timedOut: true,
	          lastLogId: 0,
	          items: [],
	          next: after,
	        });
	        return;
	      }

	      let timedOut = false;
	      let result = this.getLogs(agentId, after, limit, resolvedRunId);
	      if (result.items.length === 0 && timeoutMs > 0) {
	        const wait = await this.waitForLog(resolvedRunId, agentId, after, timeoutMs, req);
	        if (wait && wait.ok === false) return;
	        timedOut = Boolean(wait?.timedOut);
	        result = this.getLogs(agentId, after, limit, resolvedRunId);
	      } else {
	        timedOut = result.items.length === 0;
	      }

	      sendJson(res, 200, { ok: true, runId: resolvedRunId ?? requestedRunId ?? null, agentId, after, timedOut, ...result });
	      return;
	    }

	    if (method === 'GET' && url.pathname === '/api/events') {
	      const mode = String(url.searchParams.get('mode') ?? 'signal').trim().toLowerCase();
	      const requestedRunId = url.searchParams.get('runId');
	      const resolvedRunId = this.#resolveReadableRunId(requestedRunId);
	      const after = Math.max(
	        0,
	        Math.min(10_000_000_000, Number.parseInt(url.searchParams.get('after') ?? '0', 10) || 0),
	      );
	      const timeoutMs = Math.max(
	        0,
	        Math.min(120_000, Number.parseInt(url.searchParams.get('timeoutMs') ?? '25000', 10) || 0),
	      );
	      const limit = Math.max(
	        0,
	        Math.min(2000, Number.parseInt(url.searchParams.get('limit') ?? '500', 10) || 0),
	      );

	      const run = resolvedRunId ? this.runs.get(resolvedRunId) : null;
	      if (!run) {
	        sendJson(res, 200, {
	          ok: true,
	          runId: resolvedRunId ?? requestedRunId ?? null,
	          after,
	          timedOut: true,
	          lastEventId: 0,
	          next: after,
	          hasGap: false,
	          hints: { state: false, graph: false },
	          items: mode === 'full' ? [] : undefined,
	        });
	        return;
	      }

	      const snapshot = () => {
	        const store = run.events;
	        const oldest = store.items.length > 0 ? store.items[0].id : 0;
	        const latest = store.items.length > 0 ? store.items[store.items.length - 1].id : 0;
	        const hasGap = after > 0 && oldest > after;
	        const items = limit > 0 ? store.since(after, limit) : [];
	        return { oldest, latest, hasGap, items };
	      };

	      let timedOut = false;
	      let snap = snapshot();
	      if (!snap.hasGap && snap.items.length === 0 && timeoutMs > 0) {
	        const wait = await this.waitForRunEvent(resolvedRunId, after, timeoutMs);
	        timedOut = Boolean(wait?.timedOut);
	        snap = snapshot();
	      } else if (snap.hasGap || snap.items.length > 0) {
	        timedOut = false;
	      } else {
	        timedOut = true;
	      }

	      const stateHint = snap.hasGap || snap.latest > after;
	      const graphHint =
	        snap.hasGap ||
	        snap.items.some(entry => {
	          const t = String(entry?.payload?.type ?? '');
	          return (
	            t === 'run.started' ||
	            t === 'run.completed' ||
	            t === 'plan.completed' ||
	            t === 'worktree.created' ||
	            t === 'task.ready' ||
	            t === 'task.started' ||
	            t === 'task.completed' ||
	            t === 'task.superseded' ||
	            t === 'task.failed' ||
	            t === 'task.blocked'
	          );
	        });

	      if (mode === 'full') {
	        const next = snap.items.length > 0 ? snap.items[snap.items.length - 1].id : after;
	        sendJson(res, 200, {
	          ok: true,
	          runId: resolvedRunId,
	          after,
	          timedOut,
	          lastEventId: snap.latest,
	          next,
	          hasGap: snap.hasGap,
	          hints: { state: stateHint, graph: graphHint },
	          items: snap.items,
	        });
	        return;
	      }

	      sendJson(res, 200, {
	        ok: true,
	        runId: resolvedRunId,
	        after,
	        timedOut,
	        lastEventId: snap.latest,
	        next: snap.latest,
	        hasGap: snap.hasGap,
	        hints: { state: stateHint, graph: graphHint },
	      });
	      return;
	    }

			    if (method === 'GET' && url.pathname === '/api/graph') {
			      const runId = this.#resolveReadableRunId(url.searchParams.get('runId'));
			      const simple = parseBoolParam(url.searchParams.get('simple'));
				      let allRefs = parseBoolParam(url.searchParams.get('allRefs'));
				      let decorateAll = parseBoolParam(url.searchParams.get('decorateAll'));
				      let worktreeChanges = parseBoolParam(url.searchParams.get('worktreeChanges'));
				      let includeUntracked = parseBoolParam(url.searchParams.get('includeUntracked'));
			      let incomingChanges = parseBoolParam(url.searchParams.get('incomingChanges'));
			      let outgoingChanges = parseBoolParam(url.searchParams.get('outgoingChanges'));
			      const force = parseBoolParam(url.searchParams.get('force'));
		      const limitRaw = String(url.searchParams.get('limit') ?? '').trim().toLowerCase();
		      const unlimited = limitRaw === 'all' || limitRaw === '0';
		      const skip = unlimited
		        ? 0
		        : Math.max(
		          0,
		          Math.min(200_000, Number.parseInt(url.searchParams.get('skip') ?? '0', 10) || 0),
		        );
	      const parsedLimit = Number.parseInt(url.searchParams.get('limit') ?? '200', 10) || 200;
	      const limit = unlimited ? 0 : Math.max(20, Math.min(800, parsedLimit));
		      const run = runId ? this.runs.get(runId) : null;
      if (!run || !run.repoRoot) {
        sendJson(res, 404, { error: 'unknown_run' });
        return;
      }
      if (simple) {
        allRefs = false;
        decorateAll = false;
        incomingChanges = false;
        outgoingChanges = false;
        worktreeChanges = false;
        includeUntracked = false;
      }
		      const repoRoot = run.repoRoot;
		      try {
		        let headCommit = null;
		        if (run.headRef) {
		          try {
		            headCommit = String(
		              await git(['rev-parse', `${String(run.headRef)}^{commit}`], { cwd: repoRoot }),
		            ).trim();
		          } catch {
		            headCommit = null;
		          }
		        }
		        if (!headCommit) {
		          try {
		            headCommit = String(await git(['rev-parse', 'HEAD^{commit}'], { cwd: repoRoot })).trim();
		          } catch {
		            headCommit = null;
		          }
		        }

		        const cacheable = !force && skip === 0 && !worktreeChanges;
		        let graphCacheKey = null;
		        if (cacheable && headCommit) {
		          const limitKey = unlimited ? 'all' : String(limit);
		          graphCacheKey = [
		            String(runId ?? ''),
		            limitKey,
		            simple ? '1' : '0',
		            allRefs ? '1' : '0',
		            decorateAll ? '1' : '0',
		            incomingChanges ? '1' : '0',
		            outgoingChanges ? '1' : '0',
		            includeUntracked ? '1' : '0',
		            headCommit,
		          ].join('|');
		          const cached = this.graphResponseCache.get(graphCacheKey);
		          if (cached && Number.isFinite(cached.at) && Date.now() - cached.at < GRAPH_RESPONSE_TTL_MS) {
		            sendJson(res, 200, cached.value);
		            return;
		          }
		        }

		        const headRefName = run.headRef ? String(run.headRef) : null;
		        const toHeadRefId = name => {
		          const raw = String(name ?? '').trim();
		          if (!raw) return null;
	          return raw.startsWith('refs/') ? raw : `refs/heads/${raw}`;
	        };

	        const selectedBranches = new Set();
	        const addSelectedRef = refId => {
	          const raw = String(refId ?? '').trim();
	          if (!raw) return;
	          selectedBranches.add(raw);
	        };

	        const headRefId = headRefName ? toHeadRefId(headRefName) : null;
	        if (headRefId) addSelectedRef(headRefId);
	        const integrationRefId = run.integrationBranch ? toHeadRefId(run.integrationBranch) : null;
	        if (integrationRefId) addSelectedRef(integrationRefId);
	        for (const task of run.tasks?.values?.() ?? []) {
	          const taskRefId = task?.branch ? toHeadRefId(task.branch) : null;
	          if (taskRefId) addSelectedRef(taskRefId);
	        }

	        let upstreamRef = null;
	        let upstreamRefId = null;
	        if ((incomingChanges || outgoingChanges) && headRefName) {
	          try {
	            const upstreamRev = `${headRefName}@{upstream}`;
	            upstreamRef = String(await git(['rev-parse', '--abbrev-ref', upstreamRev], { cwd: repoRoot })).trim();
	            upstreamRefId = String(await git(['rev-parse', '--symbolic-full-name', upstreamRev], { cwd: repoRoot })).trim();
	          } catch {
	            upstreamRef = null;
	            upstreamRefId = null;
	          }
	          if (!upstreamRef || upstreamRef === 'HEAD' || !upstreamRefId || upstreamRefId === 'HEAD') {
	            upstreamRef = null;
	            upstreamRefId = null;
	          } else {
	            addSelectedRef(upstreamRefId);
	          }
	        }
	        let integrationCommit = null;
	        if (run.integrationBranch) {
	          try {
	            integrationCommit = String(
	              await git(['rev-parse', `${String(run.integrationBranch)}^{commit}`], { cwd: repoRoot }),
	            ).trim();
	          } catch {
	            integrationCommit = null;
	          }
	        }

	        let upstreamCommit = null;
	        if (upstreamRef) {
	          try {
	            upstreamCommit = String(
	              await git(['rev-parse', `${String(upstreamRef)}^{commit}`], { cwd: repoRoot }),
	            ).trim();
	          } catch {
	            upstreamCommit = null;
	          }
	        }
	        const selectedRefs = [...selectedBranches.values()];
	        const branchLabelMap = new Map();
	        const registerBranchLabel = (branch, label) => {
	          const rawBranch = String(branch ?? '').trim();
	          const rawLabel = String(label ?? '').trim();
	          if (!rawBranch || !rawLabel) return;
	          branchLabelMap.set(rawBranch, rawLabel);
	          const refId = toHeadRefId(rawBranch);
	          if (refId) branchLabelMap.set(refId, rawLabel);
	        };
	        if (integrationRefId) {
	          registerBranchLabel(integrationRefId, 'integration');
	        }
	        for (const task of run.tasks?.values?.() ?? []) {
	          if (!task?.branch) continue;
	          const label = String(task.taskId ?? task.id ?? task.description ?? task.branch).trim();
	          if (!label) continue;
	          registerBranchLabel(task.branch, label);
	        }
	        const historyItemRefs = selectedRefs.map(id => {
	          const refId = String(id ?? '').trim();
	          const defaultName = refId.startsWith('refs/heads/')
	            ? refId.slice('refs/heads/'.length)
	            : refId.startsWith('refs/remotes/')
	              ? refId.slice('refs/remotes/'.length)
	              : refId.startsWith('refs/tags/')
	                ? refId.slice('refs/tags/'.length)
	                : refId;
	          const name = branchLabelMap.get(refId) ?? defaultName;
	          const iconId = refId.startsWith('refs/remotes/')
	            ? 'cloud'
	            : refId.startsWith('refs/tags/')
	              ? 'tag'
	              : refId.startsWith('refs/heads/')
	                ? 'git-branch'
	                : '';
	          return { id: refId, name, iconId };
	        });

	        const baseArgs = [
	          'log',
	          '--no-color',
	          '--date-order',
	        ];
	        if (!unlimited) {
	          baseArgs.push(`--max-count=${limit + 1}`, `--skip=${skip}`);
	        } else if (skip > 0) {
	          baseArgs.push(`--skip=${skip}`);
	        }
	        baseArgs.push('--pretty=format:%H%x1f%P%x1f%s%x1f%an%x1f%at%x1f%D');

        const revisionArgs = allRefs
          ? ['--all']
          : selectedBranches.size === 0
            ? ['--all']
            : selectedRefs;
        const existingRevisionArgs =
          revisionArgs.length === 1 && revisionArgs[0] === '--all'
            ? revisionArgs
            : await filterExistingRevisions(repoRoot, revisionArgs);
        const finalRevisionArgs = allRefs
          ? ['--all']
          : existingRevisionArgs.length > 0
            ? existingRevisionArgs
            : ['--all'];

        const patterns = [];
	        if (runId) {
	          patterns.push(`refs/heads/cdx/task/${runId}/*`);
	          patterns.push(`refs/heads/cdx/integration/${runId}`);
	        }
	        if (headRefId) patterns.push(headRefId);
	        if (upstreamRefId) patterns.push(upstreamRefId);

	        let output = '';
	        if (allRefs) {
	          try {
	            output = await git([...baseArgs, '--decorate=full', ...finalRevisionArgs], { cwd: repoRoot });
	          } catch {
	            output = await git([...baseArgs, '--decorate', ...finalRevisionArgs], { cwd: repoRoot });
	          }
	        } else {
	          if (decorateAll) {
	            try {
	              output = await git([...baseArgs, '--decorate=full', ...finalRevisionArgs], { cwd: repoRoot });
	            } catch {
	              output = await git([...baseArgs, '--decorate', ...finalRevisionArgs], { cwd: repoRoot });
	            }
	          } else {
	            try {
	              const decorateArgs = ['--decorate=full', ...patterns.map(p => `--decorate-refs=${p}`)];
	              output = await git([...baseArgs, ...decorateArgs, ...finalRevisionArgs], { cwd: repoRoot });
	            } catch {
	              output = await git([...baseArgs, '--decorate', ...finalRevisionArgs], { cwd: repoRoot });
	            }
	          }
	        }

	        const commitsRaw = parseGitLogCommitRows(output);
	        const hasMore = !unlimited && commitsRaw.length > limit;
	        const pageRaw = unlimited ? commitsRaw : (hasMore ? commitsRaw.slice(0, limit) : commitsRaw);
	        const focusCommitIds = [headCommit, integrationCommit, upstreamCommit].filter(Boolean);
	        const commits = simple ? filterGraphCommitsForSimple(pageRaw, focusCommitIds) : pageRaw;
	        const nextSkip = unlimited ? commitsRaw.length : skip + pageRaw.length;

	        const worktrees = [];
	        let dirtyWorktrees = 0;
	        const worktreeAnnotations = [];
        if (worktreeChanges) {
          const targets = [];
          if (run.integrationBranch && run.runRoot) {
            targets.push({
              label: 'integration',
              branch: integrationRefId ?? String(run.integrationBranch),
              worktreePath: path.join(String(run.runRoot), 'integration'),
            });
          }
	          for (const task of run.tasks?.values?.() ?? []) {
	            if (!task?.branch || !task?.worktreePath) continue;
	            targets.push({
	              label: String(task.taskId ?? task.id ?? task.branch),
	              branch: toHeadRefId(task.branch) ?? String(task.branch),
	              worktreePath: String(task.worktreePath),
	            });
	          }

	          const now = Date.now();
	          const statuses = await mapConcurrent(
	            targets,
	            WORKTREE_STATUS_CONCURRENCY,
	            async target => {
	              const cached = this.worktreeStatusCache.get(target.worktreePath);
	              if (!force && cached && Number.isFinite(cached.at) && now - cached.at < WORKTREE_STATUS_TTL_MS) {
	                return { ...target, ...cached.value };
	              }
		              try {
		                const statusArgs = includeUntracked
		                  ? ['status', '--porcelain']
		                  : ['status', '--porcelain', '-uno'];
		                const porcelain = await git(statusArgs, { cwd: target.worktreePath });
		                const summary = parseGitStatusPorcelain(porcelain);
		                const value = { ok: true, summary };
		                this.worktreeStatusCache.set(target.worktreePath, { at: now, value });
		                return { ...target, ...value };
	              } catch (err) {
	                const message = err instanceof Error ? err.message : String(err ?? 'unknown_error');
	                const value = { ok: false, error: message, summary: { tracked: 0, untracked: 0, conflicts: 0, total: 0 } };
	                this.worktreeStatusCache.set(target.worktreePath, { at: now, value });
	                return { ...target, ...value };
	              }
	            },
	          );
	          dirtyWorktrees = statuses.filter(entry => entry?.ok && entry?.summary?.total > 0).length;
	          worktrees.push(...statuses);

	          const annotations = statuses
	            .filter(entry => entry?.ok && entry?.branch && entry?.summary?.total > 0)
	            .map(entry => ({
              branch: entry.branch,
              label: entry.label,
              text: formatWorktreeStatusSummary(entry.summary),
            }))
            .sort((a, b) => b.branch.length - a.branch.length);

          worktreeAnnotations.push(...annotations);
        }

	        let mergeBase = null;
	        if (headCommit && upstreamRef && upstreamCommit && headCommit !== upstreamCommit) {
	          try {
	            mergeBase = String(
	              await git(['merge-base', headCommit, upstreamCommit], { cwd: repoRoot }),
	            ).trim();
	          } catch {
	            mergeBase = null;
	          }
	        }

		        const body = {
		          runId,
		          skip,
		          hasMore,
		          nextSkip,
		          repoRoot,
		          headRef: run.headRef ?? null,
		          includeUntracked,
		          headCommit,
		          historyItemRef: headCommit
	            ? {
	              id: headRefId ?? headCommit,
	              name: headRefName ?? headCommit,
	              revision: headCommit,
	              iconId: 'target',
	            }
	            : null,
	          integrationBranch: run.integrationBranch ?? null,
	          integrationCommit,
	          upstreamRef,
	          upstreamCommit,
	          historyItemRemoteRef: upstreamRefId && upstreamRef && upstreamCommit
	            ? {
	              id: upstreamRefId,
	              name: upstreamRef,
	              revision: upstreamCommit,
	              iconId: upstreamRefId.startsWith('refs/remotes/') ? 'cloud' : upstreamRefId.startsWith('refs/heads/') ? 'git-branch' : 'cloud',
	            }
	            : null,
	          mergeBase,
	          incomingChanges,
	          outgoingChanges,
	          simple,
	          allRefs,
	          decorateAll,
	          limit,
	          unlimited,
	          worktreeChanges,
	          dirtyWorktrees,
	          worktrees,
	          commits,
	          worktreeAnnotations,
	          historyItemRefs,
		          refs: allRefs || finalRevisionArgs[0] === '--all' ? [] : selectedRefs,
		          selectedRefs,
		        };
		        if (cacheable && graphCacheKey) {
		          this.graphResponseCache.set(graphCacheKey, { at: Date.now(), value: body });
		          if (this.graphResponseCache.size > GRAPH_RESPONSE_CACHE_MAX) {
		            const firstKey = this.graphResponseCache.keys().next().value;
		            if (firstKey) this.graphResponseCache.delete(firstKey);
		          }
		        }
		        sendJson(res, 200, body);
		        return;
		      } catch (err) {
	        const message = err instanceof Error ? err.message : String(err ?? 'unknown_error');
	        sendJson(res, 500, { error: message });
        return;
      }
    }

    const agentListMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/worktree\/list$/);
    if (method === 'GET' && agentListMatch) {
      const agentId = decodeURIComponent(agentListMatch[1]);
      const rel = url.searchParams.get('path') ?? '';
      const result = await this.#listAgentWorktree(agentId, rel);
      sendJson(res, 200, result);
      return;
    }

    const agentFileMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/worktree\/file$/);
    if (method === 'GET' && agentFileMatch) {
      const agentId = decodeURIComponent(agentFileMatch[1]);
      const rel = url.searchParams.get('path') ?? '';
      const result = await this.#readAgentWorktreeFile(agentId, rel);
      sendJson(res, 200, result);
      return;
    }

    const agentStatusMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/worktree\/git\/status$/);
    if (method === 'GET' && agentStatusMatch) {
      const agentId = decodeURIComponent(agentStatusMatch[1]);
      const output = await this.#gitAgentStatus(agentId);
      sendJson(res, 200, { status: output });
      return;
    }

    const agentDiffMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/worktree\/git\/diff$/);
    if (method === 'GET' && agentDiffMatch) {
      const agentId = decodeURIComponent(agentDiffMatch[1]);
      const rel = url.searchParams.get('path');
      const output = await this.#gitAgentDiff(agentId, rel);
      sendJson(res, 200, { diff: output });
      return;
    }

    const listMatch = url.pathname.match(/^\/api\/worktrees\/([^/]+)\/list$/);
    if (method === 'GET' && listMatch) {
      const taskId = decodeURIComponent(listMatch[1]);
      const rel = url.searchParams.get('path') ?? '';
      const result = await this.#listWorktree(taskId, rel);
      sendJson(res, 200, result);
      return;
    }

    const fileMatch = url.pathname.match(/^\/api\/worktrees\/([^/]+)\/file$/);
    if (method === 'GET' && fileMatch) {
      const taskId = decodeURIComponent(fileMatch[1]);
      const rel = url.searchParams.get('path') ?? '';
      const result = await this.#readWorktreeFile(taskId, rel);
      sendJson(res, 200, result);
      return;
    }

    const statusMatch = url.pathname.match(/^\/api\/worktrees\/([^/]+)\/git\/status$/);
    if (method === 'GET' && statusMatch) {
      const taskId = decodeURIComponent(statusMatch[1]);
      const output = await this.#gitStatus(taskId);
      sendJson(res, 200, { status: output });
      return;
    }

    const diffMatch = url.pathname.match(/^\/api\/worktrees\/([^/]+)\/git\/diff$/);
    if (method === 'GET' && diffMatch) {
      const taskId = decodeURIComponent(diffMatch[1]);
      const rel = url.searchParams.get('path');
      const output = await this.#gitDiff(taskId, rel);
      sendJson(res, 200, { diff: output });
      return;
    }

    sendJson(res, 404, { error: 'not_found' });
  }

  #nextSeq() {
    this.seq += 1;
    return this.seq;
  }

  #getOrCreateRun(runId) {
    if (this.runs.has(runId)) return this.runs.get(runId);
    const run = {
      id: runId,
      goal: null,
      status: 'unknown',
      error: null,
      pricingTier: this.pricingTier,
      pid: null,
      cwd: null,
      repoRoot: null,
      headRef: null,
      worktreeRoot: null,
      runRoot: null,
      integrationBranch: null,
      keepWorktrees: null,
      processCommand: null,
      lastCommand: null,
      lastCommandAt: null,
      createdAt: Date.now(),
      completedAt: null,
      updatedAt: Date.now(),
      plannedTaskCount: 0,
      parallelism: null,
      plannerPlanText: null,
      plannerPlanAt: null,
      checklist: null,
      scheduler: null,
      workerPoolSize: null,
      workerBusy: 0,
      workers: new Map(),
      costUsd: 0,
      tokens: { input: 0, cachedInput: 0, output: 0 },
      tasks: new Map(),
      asks: new Map(),
      agents: new Map([
        [
          'server',
          {
            agentId: 'server',
            taskId: null,
            phase: 'server',
            status: 'running',
            startedAt: Date.now(),
            finishedAt: null,
            worktreePath: null,
            branch: null,
            lastActivityAt: null,
            lastActivity: null,
            lastActivityKind: null,
            costUsd: 0,
            tokens: { input: 0, cachedInput: 0, output: 0 },
          },
        ],
      ]),
      logs: new Map([['server', new RingBuffer(8000)]]),
      events: new RingBuffer(4000),
      watchdogTurns: new RingBuffer(128),
      eventCounters: new Map(),
    };
    this.runs.set(runId, run);
    return run;
  }

  #recordCompletedWatchdogTurn(run, payload, eventEntry) {
    if (!run || !(run.watchdogTurns instanceof RingBuffer)) return;
    const agentId = String(payload?.agentId ?? '').trim();
    if (agentId !== 'watchdog') return;

    const logStore = run.logs.get(agentId);
    const completedTurns = run.watchdogTurns.items;
    const previousTurn = completedTurns.length > 0
      ? completedTurns[completedTurns.length - 1]
      : null;
    const previousEndLogId = Number(previousTurn?.endedLogId) || 0;
    const logItems = Array.isArray(logStore?.items)
      ? logStore.items.filter(item => (Number(item?.id) || 0) > previousEndLogId)
      : [];
    const endedLogId = logItems.length > 0
      ? (Number(logItems[logItems.length - 1]?.id) || previousEndLogId)
      : previousEndLogId;
    const text = formatWatchdogTurnLogText(logItems);
    const turnId = pickFirstString(payload.turnId, payload.turn_id) ?? null;
    const startedLogId = logItems.length > 0
      ? (Number(logItems[0]?.id) || previousEndLogId)
      : previousEndLogId;
    const startedAt = normalizeIsoTimestamp(logItems[0]?.ts);
    const completedAt = normalizeIsoTimestamp(eventEntry?.ts ?? Date.now());
    const lastLogAt = normalizeIsoTimestamp(logItems[logItems.length - 1]?.ts ?? completedAt);
    const summary = summarizeWatchdogText(text);

    run.watchdogTurns.push({
      index: (Number(previousTurn?.index) || 0) + 1,
      turnId,
      eventId: Number(eventEntry?.id) || 0,
      startedLogId,
      endedLogId,
      source: 'turn.completed',
      startedAt,
      completedAt,
      lastLogAt,
      timestamp: lastLogAt || completedAt || startedAt,
      summary,
      kind: inferWatchdogTurnKind(summary || text),
      text,
    });
  }

  #removeLogWaiter(key, waiter) {
    const set = this.logWaiters.get(key);
    if (!set) return;
    set.delete(waiter);
    if (set.size === 0) {
      this.logWaiters.delete(key);
    }
  }

  #notifyLogWaiters(key, logId) {
    const set = this.logWaiters.get(key);
    if (!set || set.size === 0) return;
    for (const waiter of [...set]) {
      if (!waiter || !(logId > waiter.afterId)) continue;
      waiter.cleanup?.();
      waiter.resolve({ ok: true, timedOut: false, lastLogId: logId });
    }
  }

  #removeLogStream(key, stream) {
    const set = this.logStreams.get(key);
    if (!set) return;
    set.delete(stream);
    if (set.size === 0) {
      this.logStreams.delete(key);
    }
  }

  #notifyLogStreams(key, entry) {
    const set = this.logStreams.get(key);
    if (!set || set.size === 0) return;
    for (const stream of [...set]) {
      if (!stream) continue;
      if (stream.suspended) {
        stream.pending?.push(entry);
        continue;
      }
      if (!(entry.id > stream.lastSentId)) continue;
      try {
        stream.send(entry);
      } catch {
        stream.close?.();
        this.#removeLogStream(key, stream);
      }
    }
  }

  #removeEventWaiter(runId, waiter) {
    const set = this.eventWaiters.get(runId);
    if (!set) return;
    set.delete(waiter);
    if (set.size === 0) {
      this.eventWaiters.delete(runId);
    }
  }

  #notifyEventWaiters(runId, eventId) {
    const set = this.eventWaiters.get(runId);
    if (!set || set.size === 0) return;
    for (const waiter of [...set]) {
      if (!waiter || !(eventId > waiter.afterId)) continue;
      if (waiter.timer) clearTimeout(waiter.timer);
      set.delete(waiter);
      waiter.resolve({ ok: true, timedOut: false, lastEventId: eventId });
    }
    if (set.size === 0) {
      this.eventWaiters.delete(runId);
    }
  }

  #runForId(runId) {
    const resolvedRunId = this.#resolveReadableRunId(runId);
    if (!resolvedRunId) return null;
    return this.runs.get(resolvedRunId) ?? null;
  }

  #worktreePathForTask(taskId, runId) {
    const run = this.#runForId(runId);
    const task = run?.tasks?.get(taskId) ?? null;
    const worktreePath = task?.worktreePath;
    if (typeof worktreePath === 'string' && worktreePath) {
      return worktreePath;
    }
    return null;
  }

  async #listWorktree(taskId, relPath, runId) {
    const worktreePath = this.#worktreePathForTask(taskId, runId);
    if (!worktreePath) {
      const err = new Error('unknown_task_or_worktree');
      err.statusCode = 404;
      throw err;
    }
    return this.#listWorktreeAt({ key: taskId, worktreePath, relPath });
  }

  async #readWorktreeFile(taskId, relPath, runId) {
    const worktreePath = this.#worktreePathForTask(taskId, runId);
    if (!worktreePath) {
      const err = new Error('unknown_task_or_worktree');
      err.statusCode = 404;
      throw err;
    }
    return this.#readWorktreeFileAt({ key: taskId, worktreePath, relPath });
  }

  async #gitStatus(taskId, runId) {
    const worktreePath = this.#worktreePathForTask(taskId, runId);
    if (!worktreePath) return '';
    return this.#gitStatusAt(worktreePath);
  }

  async #gitDiff(taskId, relPath, runId) {
    const worktreePath = this.#worktreePathForTask(taskId, runId);
    if (!worktreePath) return '';
    return this.#gitDiffAt(worktreePath, relPath);
  }

  #safeResolve(root, rel) {
    const base = path.resolve(root);
    const candidate = path.resolve(base, rel || '');
    if (candidate === base) return candidate;
    const prefix = base.endsWith(path.sep) ? base : `${base}${path.sep}`;
    if (!candidate.startsWith(prefix)) {
      const err = new Error('path_outside_worktree');
      err.statusCode = 400;
      throw err;
    }
    return candidate;
  }

  #worktreePathForAgent(agentId, runId) {
    const run = this.#runForId(runId);
    const resolvedAgentId = typeof agentId === 'string' ? agentId : '';
    const agent = run?.agents?.get(resolvedAgentId) ?? null;
    if (!agent && run) {
      const candidateTaskId = resolvedAgentId.startsWith('task:')
        ? resolvedAgentId.slice('task:'.length)
        : resolvedAgentId;
      if (candidateTaskId && run.tasks?.has(candidateTaskId)) {
        return this.#worktreePathForTask(candidateTaskId, runId);
      }
    }
    const direct = agent?.worktreePath;
    if (typeof direct === 'string' && direct) return direct;
    const taskId = agent?.taskId ? String(agent.taskId) : null;
    if (taskId) return this.#worktreePathForTask(taskId, runId);
    return null;
  }

  async #listAgentWorktree(agentId, relPath, runId) {
    const worktreePath = this.#worktreePathForAgent(agentId, runId);
    if (!worktreePath) {
      const err = new Error('unknown_agent_or_worktree');
      err.statusCode = 404;
      throw err;
    }
    return this.#listWorktreeAt({ key: agentId, worktreePath, relPath, agentId });
  }

  async #readAgentWorktreeFile(agentId, relPath, runId) {
    const worktreePath = this.#worktreePathForAgent(agentId, runId);
    if (!worktreePath) {
      const err = new Error('unknown_agent_or_worktree');
      err.statusCode = 404;
      throw err;
    }
    return this.#readWorktreeFileAt({ key: agentId, worktreePath, relPath, agentId });
  }

  async #gitAgentStatus(agentId, runId) {
    const worktreePath = this.#worktreePathForAgent(agentId, runId);
    if (!worktreePath) return '';
    return this.#gitStatusAt(worktreePath);
  }

  async #gitAgentDiff(agentId, relPath, runId) {
    const worktreePath = this.#worktreePathForAgent(agentId, runId);
    if (!worktreePath) return '';
    return this.#gitDiffAt(worktreePath, relPath);
  }

  async #listWorktreeAt({ key, worktreePath, relPath, agentId }) {
    const resolved = this.#safeResolve(worktreePath, relPath);
    const dirents = await readdir(resolved, { withFileTypes: true });
    const entries = dirents
      .map(dirent => {
        const name = dirent.name;
        const type = dirent.isDirectory() ? 'dir' : 'file';
        const rel = relPath ? path.posix.join(relPath.replaceAll('\\', '/'), name) : name;
        return { name, type, path: rel };
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    const payload = { worktreePath, path: relPath, entries };
    if (agentId) payload.agentId = agentId;
    if (!agentId) payload.taskId = key;
    return payload;
  }

  async #readWorktreeFileAt({ key, worktreePath, relPath, agentId }) {
    const resolved = this.#safeResolve(worktreePath, relPath);
    const maxBytes = Math.max(
      1,
      Number.parseInt(process.env.CDX_STATS_MAX_FILE_BYTES ?? `${200 * 1024}`, 10) ||
        200 * 1024,
    );
    const result = await readFileLimited(resolved, maxBytes);
    const payload = {
      worktreePath,
      path: relPath,
      binary: result.binary,
      size: result.size,
      truncated: result.truncated,
      content: result.content,
    };
    if (agentId) payload.agentId = agentId;
    if (!agentId) payload.taskId = key;
    return payload;
  }

  async #gitStatusAt(worktreePath) {
    return (await git(['status', '--porcelain'], { cwd: worktreePath })).trimEnd();
  }

  async #gitDiffAt(worktreePath, relPath) {
    const args = ['diff'];
    if (typeof relPath === 'string' && relPath.trim()) {
      args.push('--', relPath.trim());
    }
    return (await git(args, { cwd: worktreePath })).trimEnd();
  }

  async openUrl(url) {
    const target = typeof url === 'string' ? url.trim() : '';
    if (!target) return false;
    return openUrlPreferChrome(target);
  }

  async openUrlAuto(url) {
    if (this.autoOpened) return true;
    const ok = await this.openUrl(url);
    if (ok) this.autoOpened = true;
    return ok;
  }

  async #maybeAutoOpen(url, shouldAutoOpen) {
    if (!shouldAutoOpen) return;

    const target = typeof url === 'string' ? url.trim() : '';
    if (!target) return;

    const ok = await this.openUrlAuto(target);
    if (!ok) this.log(`Stats UI auto-open failed. Open manually: ${target}`);
  }
}
