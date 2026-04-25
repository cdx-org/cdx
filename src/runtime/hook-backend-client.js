import { getFetchImplementation } from './undici-compat.js';

const resolvedFetch = getFetchImplementation();

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function coerceString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeHeaders(headers) {
  if (!isObject(headers)) return null;
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    const name = coerceString(key);
    if (!name) continue;
    normalized[name] = String(value);
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function trimStrings(value, maxChars, seen = new WeakSet()) {
  if (typeof value === 'string') {
    if (maxChars > 0 && value.length > maxChars) {
      return `${value.slice(0, Math.max(0, maxChars))}...`;
    }
    return value;
  }
  if (!value || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return value.message;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map(entry => trimStrings(entry, maxChars, seen));
  }

  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = trimStrings(entry, maxChars, seen);
  }
  return output;
}

export class HookBackendClient {
  constructor({ url, timeoutMs, maxStringChars, headers, log } = {}) {
    this.url = coerceString(url);
    this.timeoutMs = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 0;
    this.maxStringChars = Number.isFinite(maxStringChars) ? Math.max(0, maxStringChars) : 0;
    this.headers = normalizeHeaders(headers) ?? {};
    this.log = typeof log === 'function' ? log : () => {};
  }

  get enabled() {
    return Boolean(this.url);
  }

  async request({ hook, context, data, timeoutMs } = {}) {
    if (!this.url) return null;
    if (typeof resolvedFetch !== 'function') {
      this.log('hook backend unavailable: fetch is not defined');
      return null;
    }

    const hookLabel = coerceString(hook) ?? 'unknown';
    const payload = {
      hook: hookLabel,
      context: context ?? null,
      data: data ?? null,
      timestamp: new Date().toISOString(),
    };
    const body =
      this.maxStringChars > 0 ? JSON.stringify(trimStrings(payload, this.maxStringChars)) : JSON.stringify(payload);

    const timeout = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : this.timeoutMs;
    const controller = timeout > 0 ? new AbortController() : null;
    let timer = null;
    if (controller && timeout > 0) {
      timer = setTimeout(() => controller.abort(), timeout);
      timer.unref?.();
    }

    try {
      const res = await resolvedFetch(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...this.headers,
        },
        body,
        signal: controller?.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        const preview = text ? ` body=${text.slice(0, 200)}` : '';
        this.log(`hook request failed (hook=${hookLabel} status=${res.status})${preview}`);
        return null;
      }
      if (!text || !text.trim()) return null;
      try {
        return JSON.parse(text);
      } catch (err) {
        this.log(`hook response JSON parse failed (hook=${hookLabel})`, err);
        return null;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? 'unknown error');
      this.log(`hook request error (hook=${hookLabel}): ${message}`);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
