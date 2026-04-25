import { assertFetchAvailable } from './undici-compat.js';

const PROVIDER_PATH_REGEX = /\/api\/providers\/([^/]+)\/v\d+(?:\.\d+)?$/i;
const PROVIDER_BASE_REGEX = /\/api\/providers\/([^/]+)$/i;
const VERSIONED_BASE_REGEX = /\/v\d+(?:\.\d+)?$/i;
const API_SUFFIX_REGEX = /\/api$/i;
const RATE_LIMIT_UPDATED_METHOD = 'account/ratelimits/updated';

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseFiniteNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function roundTo(value, digits = 3) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function parseTimestampMs(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  const numeric = parseFiniteNumber(value);
  if (numeric !== null) {
    if (Math.abs(numeric) < 1e11) return Math.trunc(numeric * 1000);
    return Math.trunc(numeric);
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeMethodName(method) {
  return typeof method === 'string' ? method.trim().toLowerCase() : '';
}

function matchesRateLimitUpdatedMethod(method) {
  const normalized = normalizeMethodName(method);
  return normalized === RATE_LIMIT_UPDATED_METHOD
    || normalized === 'account/ratelimit/updated';
}

function coerceRateLimitList(value) {
  if (Array.isArray(value)) return value;
  if (isObject(value)) {
    return Object.entries(value).map(([name, item]) => {
      if (isObject(item)) return { name, ...item };
      return { name, value: item };
    });
  }
  return [];
}

function unwrapRateLimitSnapshotPayload(value) {
  if (!isObject(value)) return null;
  if (matchesRateLimitUpdatedMethod(value.method) && isObject(value.params)) {
    return value.params;
  }
  if (matchesRateLimitUpdatedMethod(value.method)) {
    return value;
  }
  return value;
}

function extractRateLimitList(value) {
  const payload = unwrapRateLimitSnapshotPayload(value);
  if (!isObject(payload)) return [];
  return coerceRateLimitList(
    payload.rateLimits
      ?? payload.rate_limits
      ?? payload.rateLimit
      ?? payload.rate_limit
      ?? payload.limits
      ?? payload.limitSnapshots,
  );
}

function extractRateLimitContainer(payload) {
  if (!isObject(payload)) return null;
  return payload.rateLimits
    ?? payload.rate_limits
    ?? payload.rateLimit
    ?? payload.rate_limit
    ?? payload.limits
    ?? payload.limitSnapshots
    ?? null;
}

function normalizeCredits(entry) {
  const source = entry.credits ?? entry.credit ?? entry.creditState ?? entry.credit_state ?? null;
  if (source === null || source === undefined) return null;
  if (!isObject(source)) {
    const remaining = parseFiniteNumber(source);
    return remaining === null ? null : { remaining, total: null, used: null };
  }

  const remaining =
    parseFiniteNumber(
      source.remaining
        ?? source.available
        ?? source.balance
        ?? source.left
        ?? source.remainingCredits
        ?? source.remaining_credits,
    );
  const total =
    parseFiniteNumber(
      source.total
        ?? source.limit
        ?? source.max
        ?? source.capacity
        ?? source.quota,
    );
  const used =
    parseFiniteNumber(
      source.used
        ?? source.consumed
        ?? source.spent,
    );

  const normalizedRemaining =
    remaining !== null
      ? remaining
      : total !== null && used !== null
        ? total - used
        : null;

  if (normalizedRemaining === null && total === null && used === null) return null;
  return {
    remaining: normalizedRemaining,
    total,
    used,
  };
}

function deriveUsedPercent(entry, credits) {
  const direct =
    parseFiniteNumber(
      entry.usedPercent
        ?? entry.used_percent
        ?? entry.usagePercent
        ?? entry.usage_percent
        ?? entry.percentUsed
        ?? entry.percent_used,
    );
  if (direct !== null) return direct;

  const limit =
    parseFiniteNumber(
      entry.limit
        ?? entry.max
        ?? entry.quota
        ?? entry.capacity
        ?? entry.total,
    )
    ?? credits?.total
    ?? null;
  const remaining =
    parseFiniteNumber(
      entry.remaining
        ?? entry.remainingLimit
        ?? entry.remaining_limit
        ?? entry.available,
    )
    ?? credits?.remaining
    ?? null;
  const used =
    parseFiniteNumber(
      entry.used
        ?? entry.consumed
        ?? entry.current,
    )
    ?? credits?.used
    ?? null;

  if (limit !== null && limit > 0 && remaining !== null) {
    return ((limit - remaining) / limit) * 100;
  }
  if (limit !== null && limit > 0 && used !== null) {
    return (used / limit) * 100;
  }
  return null;
}

function computeResetWeight(resetInMs) {
  if (!Number.isFinite(resetInMs)) return 1;
  if (resetInMs <= 0) return 0.25;
  if (resetInMs <= 5_000) return 0.2;
  if (resetInMs <= 30_000) return 0.35;
  if (resetInMs <= 2 * 60_000) return 0.55;
  if (resetInMs <= 15 * 60_000) return 0.75;
  if (resetInMs <= 60 * 60_000) return 0.9;
  return 1;
}

function computeCreditPressure(credits, resetWeight) {
  if (!credits) return null;
  const remaining = credits.remaining;
  if (!Number.isFinite(remaining)) return null;
  if (remaining <= 0) return 1;
  if (Number.isFinite(credits.total) && credits.total > 0) {
    return clamp((1 - (remaining / credits.total)) * resetWeight, 0, 1);
  }
  if (remaining <= 1) return 0.98;
  if (remaining <= 2) return 0.9;
  if (remaining <= 3) return 0.82;
  if (remaining <= 5) return 0.7;
  if (remaining <= 10) return 0.55;
  return null;
}

function classifyPressureLevel(score, exhausted) {
  if (exhausted || score >= 0.98) return 'critical';
  if (score >= 0.9) return 'high';
  if (score >= 0.75) return 'elevated';
  if (score >= 0.5) return 'moderate';
  if (score > 0) return 'low';
  return 'none';
}

function normalizeRateLimitEntry(entry, { nameHint, now }) {
  if (!isObject(entry)) return null;

  const credits = normalizeCredits(entry);
  const usedPercent = deriveUsedPercent(entry, credits);
  const cappedUsedPercent = usedPercent === null ? null : clamp(usedPercent, 0, 100);
  const resetsAt = parseTimestampMs(
    entry.resetsAt
      ?? entry.resets_at
      ?? entry.resetAt
      ?? entry.reset_at,
  );
  const resetInMs = Number.isFinite(resetsAt) ? resetsAt - now : null;
  const resetWeight = computeResetWeight(resetInMs);
  const pressureFromUsage =
    cappedUsedPercent === null
      ? null
      : clamp((cappedUsedPercent / 100) * resetWeight, 0, 1);
  const pressureFromCredits = computeCreditPressure(credits, resetWeight);
  const exhausted =
    (usedPercent !== null && usedPercent >= 100)
    || (credits?.remaining !== null && credits?.remaining !== undefined && credits.remaining <= 0);
  const pressureScore = Math.max(
    exhausted ? 1 : 0,
    pressureFromUsage ?? 0,
    pressureFromCredits ?? 0,
  );

  const headroomCandidates = [];
  if (usedPercent !== null) {
    headroomCandidates.push(clamp(1 - (usedPercent / 100), 0, 1));
  }
  if (Number.isFinite(credits?.remaining) && Number.isFinite(credits?.total) && credits.total > 0) {
    headroomCandidates.push(clamp(credits.remaining / credits.total, 0, 1));
  } else if (Number.isFinite(credits?.remaining) && credits.remaining <= 0) {
    headroomCandidates.push(0);
  }
  const headroomRatio =
    headroomCandidates.length > 0
      ? Math.min(...headroomCandidates)
      : null;
  const headroomPercent = headroomRatio === null ? null : headroomRatio * 100;

  const name =
    (typeof entry.name === 'string' && entry.name.trim())
    || (typeof entry.type === 'string' && entry.type.trim())
    || (typeof entry.scope === 'string' && entry.scope.trim())
    || nameHint
    || null;

  if (usedPercent === null && resetsAt === null && credits === null) {
    return null;
  }

  return {
    name,
    scope:
      (typeof entry.scope === 'string' && entry.scope.trim())
      || (typeof entry.kind === 'string' && entry.kind.trim())
      || null,
    model: typeof entry.model === 'string' && entry.model.trim() ? entry.model.trim() : null,
    usedPercent: usedPercent === null ? null : roundTo(usedPercent, 2),
    headroomPercent: headroomPercent === null ? null : roundTo(headroomPercent, 2),
    resetsAt,
    resetInMs,
    credits,
    exhausted,
    pressureScore: roundTo(pressureScore, 3),
    pressureLevel: classifyPressureLevel(pressureScore, exhausted),
  };
}

export function deriveRateLimitPressureState(snapshotPayload, { now = Date.now() } = {}) {
  const payload = unwrapRateLimitSnapshotPayload(snapshotPayload);
  if (!isObject(payload)) return null;

  const method =
    typeof snapshotPayload?.method === 'string'
      ? snapshotPayload.method
      : null;
  if (method && !matchesRateLimitUpdatedMethod(method)) return null;

  const rawLimits = extractRateLimitList(payload);
  if (rawLimits.length === 0) return null;
  const limitContainer = extractRateLimitContainer(payload);
  const limitNames = isObject(limitContainer) ? Object.keys(limitContainer) : [];

  const rateLimits = rawLimits
    .map((entry, index) => {
      const nameHint = limitNames[index] ?? null;
      return normalizeRateLimitEntry(entry, { nameHint, now });
    })
    .filter(Boolean);

  if (rateLimits.length === 0) return null;

  const maxPressureScore = Math.max(...rateLimits.map(limit => limit.pressureScore ?? 0), 0);
  const headroomValues = rateLimits
    .map(limit => limit.headroomPercent)
    .filter(value => Number.isFinite(value));
  const minHeadroomPercent = headroomValues.length > 0 ? Math.min(...headroomValues) : null;
  const maxUsedPercent = Math.max(
    ...rateLimits
      .map(limit => limit.usedPercent)
      .filter(value => Number.isFinite(value)),
    0,
  );
  const nextResetAt = rateLimits
    .map(limit => limit.resetsAt)
    .filter(value => Number.isFinite(value))
    .reduce((min, value) => (min === null || value < min ? value : min), null);
  const nextResetInMs = Number.isFinite(nextResetAt) ? nextResetAt - now : null;
  const creditsRemaining = rateLimits
    .map(limit => limit.credits?.remaining)
    .filter(value => Number.isFinite(value))
    .reduce((min, value) => (min === null || value < min ? value : min), null);
  const exhausted = rateLimits.some(limit => limit.exhausted);
  const pressureLevel = classifyPressureLevel(maxPressureScore, exhausted);

  return {
    source: 'snapshot',
    method: method ?? 'account/rateLimits/updated',
    observedAt: now,
    isRateLimitHit: false,
    rateLimits,
    ratePressureScore: roundTo(maxPressureScore, 3),
    ratePressureLevel: pressureLevel,
    rateHeadroomPercent: minHeadroomPercent === null ? null : roundTo(minHeadroomPercent, 2),
    maxUsedPercent: roundTo(maxUsedPercent, 2),
    nextResetAt,
    nextResetInMs,
    creditsRemaining,
    exhausted,
    shouldThrottle: exhausted || maxPressureScore >= 0.75,
    ratePressure: {
      score: roundTo(maxPressureScore, 3),
      level: pressureLevel,
      exhausted,
      shouldThrottle: exhausted || maxPressureScore >= 0.75,
      maxUsedPercent: roundTo(maxUsedPercent, 2),
      nextResetAt,
      nextResetInMs,
      creditsRemaining,
      limitCount: rateLimits.length,
    },
    rateHeadroom: {
      percent: minHeadroomPercent === null ? null : roundTo(minHeadroomPercent, 2),
      fraction: minHeadroomPercent === null ? null : roundTo(minHeadroomPercent / 100, 3),
      nextResetAt,
      nextResetInMs,
      creditsRemaining,
      limitCount: rateLimits.length,
    },
  };
}

export function deriveRateLimitSnapshotState(snapshotPayload, options = {}) {
  return deriveRateLimitPressureState(snapshotPayload, options);
}

export function normalizeRateLimitSnapshot(snapshotPayload, options = {}) {
  return deriveRateLimitPressureState(snapshotPayload, options)?.rateLimits ?? null;
}

function buildAuthHeader(apiKey) {
  if (!apiKey) throw new Error('OpenAIProxyClient: API key is required');
  return { Authorization: `Bearer ${apiKey}` };
}

function resolveTimeoutMs({ timeoutMs, timeoutSeconds }) {
  if (timeoutMs && Number(timeoutMs) > 0) return Number(timeoutMs);
  if (timeoutSeconds && Number(timeoutSeconds) > 0) return Number(timeoutSeconds) * 1000;
  const envMs = process.env.OPENAI_PROXY_TIMEOUT_MS || process.env.PROXY_TIMEOUT_MS;
  if (envMs && Number(envMs) > 0) return Number(envMs);
  const envSeconds =
    process.env.OPENAI_PROXY_TIMEOUT_SECONDS
    || process.env.PROXY_TIMEOUT
    || process.env.PROXY_TIMEOUT_SEC;
  if (envSeconds && Number(envSeconds) > 0) return Number(envSeconds) * 1000;
  return undefined;
}

export class OpenAIProxyClient {
  constructor({
    baseUrl,
    providerName,
    apiKey,
    timeoutMs,
    timeoutSeconds,
    defaultHeaders,
  } = {}) {
    if (!baseUrl) throw new Error('OpenAIProxyClient: baseUrl is required');
    const normalizedBase = baseUrl.replace(/\/+$/, '');
    const providerMatch = normalizedBase.match(PROVIDER_PATH_REGEX);
    const providerBaseMatch = providerMatch ? null : normalizedBase.match(PROVIDER_BASE_REGEX);
    const isVersionedBase =
      !providerMatch
      && !providerBaseMatch
      && VERSIONED_BASE_REGEX.test(normalizedBase);

    this.baseUrl = normalizedBase;
    this.baseUrlHasApiSuffix = API_SUFFIX_REGEX.test(normalizedBase);
    this.embeddedProviderBase = undefined;
    this.directApiBase = undefined;

    let extractedProvider;
    if (providerMatch) {
      extractedProvider = providerMatch[1]?.toLowerCase();
      this.embeddedProviderBase = normalizedBase;
    } else if (providerBaseMatch) {
      extractedProvider = providerBaseMatch[1]?.toLowerCase();
      this.embeddedProviderBase = `${normalizedBase}/v1`;
    } else if (isVersionedBase) {
      this.directApiBase = normalizedBase;
    }
    const normalizedProvider = providerName ? String(providerName).trim().toLowerCase() : undefined;
    if (this.embeddedProviderBase && normalizedProvider && normalizedProvider !== extractedProvider) {
      console.warn(
        `[mcp-openai] Ignoring OPENAI_PROVIDER_NAME=${normalizedProvider} because base URL encodes provider ${extractedProvider}`,
      );
    }
    this.providerName = extractedProvider || normalizedProvider || 'openai-us';
    this.baseHeaders = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...buildAuthHeader(apiKey),
    };
    this.defaultHeaders = { ...(defaultHeaders || {}) };

    this.timeoutMs = resolveTimeoutMs({ timeoutMs, timeoutSeconds });
  }

  apiBase() {
    if (this.embeddedProviderBase) return this.embeddedProviderBase;
    if (this.directApiBase) return this.directApiBase;
    const providerName = encodeURIComponent(this.providerName);
    if (this.baseUrlHasApiSuffix) {
      return `${this.baseUrl}/providers/${providerName}/v1`;
    }
    return `${this.baseUrl}/api/providers/${providerName}/v1`;
  }

  _applyDefaults(init = {}) {
    const next = { ...init };
    const headerOverrides = next.headers || {};
    next.headers = { ...this.baseHeaders, ...this.defaultHeaders, ...headerOverrides };
    const timeoutMs = next.timeoutMs ?? this.timeoutMs;
    if (
      !next.signal
      && timeoutMs
      && timeoutMs > 0
      && typeof AbortSignal !== 'undefined'
      && AbortSignal.timeout
    ) {
      try {
        next.signal = AbortSignal.timeout(timeoutMs);
      } catch (_) {
        // Ignore if AbortSignal.timeout is unavailable.
      }
    }
    if (next.timeoutMs !== undefined) delete next.timeoutMs;
    return next;
  }

  async _requestJson(url, init = {}, { expectJson = true } = {}) {
    const fetchImpl = assertFetchAvailable('OpenAI proxy fetch');
    const res = await fetchImpl(url, this._applyDefaults(init));
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      const label = init.method || 'GET';
      throw new Error(`${label} ${url} failed (${res.status}): ${text}`);
    }
    if (!expectJson) return text;
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new Error(`Unexpected non-JSON response from ${url}: ${err}`);
    }
  }

  async createResponse(payload, { headers } = {}) {
    const url = `${this.apiBase()}/responses`;
    return this._requestJson(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  }

  async listModels({ limit, after } = {}, { headers } = {}) {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set('limit', String(limit));
    if (after) params.set('after', after);
    const qs = params.toString();
    const url = `${this.apiBase()}/models${qs ? `?${qs}` : ''}`;
    return this._requestJson(url, { method: 'GET', headers });
  }

  async createBatch(payload, { headers } = {}) {
    const url = `${this.apiBase()}/batches`;
    return this._requestJson(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  }
}
