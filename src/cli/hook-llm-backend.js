#!/usr/bin/env node

import http from 'node:http';
import process from 'node:process';

import { OpenAIProxyClient } from '../runtime/openai-proxy-client.js';
import { loadPromptTemplate } from '../runtime/prompt-templates.js';

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function coerceString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
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

function sanitizeHeaderValue(value) {
  if (value === undefined || value === null) return undefined;
  const str = String(value).trim();
  return str.length ? str : undefined;
}

function buildProxyHeaders({ customEventId, metadata, requestTimeout, extraHeaders } = {}) {
  const headers = {};
  const apply = (key, value) => {
    const sanitized = sanitizeHeaderValue(value);
    if (sanitized !== undefined) headers[key] = sanitized;
  };
  apply('X-CUSTOM-EVENT-ID', customEventId);
  apply('X-METADATA', metadata);
  apply('X-REQUEST-TIMEOUT', requestTimeout);
  if (extraHeaders && typeof extraHeaders === 'object') {
    for (const [key, value] of Object.entries(extraHeaders)) {
      apply(key, value);
    }
  }
  return headers;
}

function trimMaybe(value) {
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim();
  return trimmed.length ? trimmed : undefined;
}

function parseJsonEnv(name, fallback = null) {
  const raw = trimMaybe(process.env[name]);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${name}: ${err?.message ?? err}`);
  }
}

function resolveProxyBaseUrl() {
  const orderedKeys = [
    ['openai_base_url', process.env.openai_base_url],
    ['openai_api_base', process.env.openai_api_base],
    ['OPENAI_API_BASE', process.env.OPENAI_API_BASE],
    ['OPENAI_BASE_URL', process.env.OPENAI_BASE_URL],
    ['OPENAI_PROXY_BASE_URL', process.env.OPENAI_PROXY_BASE_URL],
  ];
  for (const [, value] of orderedKeys) {
    const trimmed = trimMaybe(value);
    if (trimmed) return trimmed;
  }
  throw new Error(
    'Missing required OpenAI API base. Set openai_base_url or openai_api_base or OPENAI_API_BASE / OPENAI_BASE_URL / OPENAI_PROXY_BASE_URL.',
  );
}

const PROVIDER_CHOICES = ['openai-us', 'openai-eu'];

function detectProviderFromBase(apiBase) {
  if (!apiBase) return undefined;
  const normalized = apiBase.toLowerCase();
  if (normalized.includes('openai-eu')) return 'openai-eu';
  if (normalized.includes('openai-us')) return 'openai-us';
  return undefined;
}

function resolveProviderName() {
  const raw = trimMaybe(process.env.OPENAI_PROVIDER_NAME || process.env.openai_provider_name);
  if (raw) {
    const normalized = raw.toLowerCase();
    if (!PROVIDER_CHOICES.includes(normalized)) {
      throw new Error(`OPENAI_PROVIDER_NAME must be one of: ${PROVIDER_CHOICES.join(', ')}`);
    }
    return normalized;
  }

  const detected =
    detectProviderFromBase(
      process.env.OPENAI_API_BASE
        || process.env.openai_api_base
        || process.env.OPENAI_BASE_URL
        || process.env.openai_base_url,
    )
    || detectProviderFromBase(process.env.OPENAI_PROXY_BASE_URL);
  if (detected) return detected;
  return PROVIDER_CHOICES[0];
}

function resolveOpenAiApiKey() {
  const fromEnv = trimMaybe(process.env.OPENAI_API_KEY);
  if (fromEnv) return fromEnv;

  const fromCodexEnv = trimMaybe(process.env.CODEX_API_KEY);
  if (fromCodexEnv) return fromCodexEnv;

  throw new Error(
    'Missing required OpenAI API key. Set OPENAI_API_KEY or CODEX_API_KEY.',
  );
}

function normalizePreflightFallback(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return 'llm';
  if (normalized === 'none' || normalized === 'off') return 'none';
  return 'llm';
}

function normalizePreflightRuleInput(input) {
  if (!input) return null;
  if (Array.isArray(input)) return input;
  return [input];
}

function truthyValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return true;
  return Boolean(value);
}

function resolveConditionValue(data, key) {
  return data?.[key];
}

function matchIncludes(actual, expectedList) {
  const actualText = String(actual ?? '');
  const list = Array.isArray(expectedList) ? expectedList : [expectedList];
  return list.some(entry => {
    const needle = String(entry ?? '');
    return needle && actualText.includes(needle);
  });
}

function matchCondition(key, expected, data) {
  if (expected === undefined) return true;
  if (key.endsWith('Includes')) {
    const baseKey = key.slice(0, -'Includes'.length);
    return matchIncludes(resolveConditionValue(data, baseKey), expected);
  }

  const actual = resolveConditionValue(data, key);
  if (typeof expected === 'boolean') {
    return truthyValue(actual) === expected;
  }
  if (typeof expected === 'number') {
    if (Array.isArray(actual)) return actual.length === expected;
    const parsed = Number(actual);
    return Number.isFinite(parsed) && parsed === expected;
  }
  if (typeof expected === 'string') {
    if (Array.isArray(actual)) return actual.includes(expected);
    return String(actual ?? '') === expected;
  }
  if (Array.isArray(expected)) {
    return expected.some(entry => matchCondition(key, entry, data));
  }
  if (expected && typeof expected === 'object') {
    return Object.entries(expected).every(([nestedKey, nestedValue]) => {
      const nestedActual = actual?.[nestedKey];
      if (typeof nestedValue === 'boolean') return truthyValue(nestedActual) === nestedValue;
      return String(nestedActual ?? '') === String(nestedValue ?? '');
    });
  }
  return false;
}

function matchPreflightRule(rule, data) {
  if (!rule) return false;
  const conditions = rule.if ?? rule.when ?? rule.match ?? rule.conditions;
  if (!conditions) return true;
  if (Array.isArray(conditions)) {
    return conditions.every(condition => matchPreflightRule({ if: condition }, data));
  }
  if (typeof conditions !== 'object') return false;
  return Object.entries(conditions).every(([key, expected]) => matchCondition(key, expected, data));
}

function buildPreflightResponse(rule) {
  if (!rule) return null;
  if (typeof rule === 'string') return { steer: rule };
  if (rule.response && typeof rule.response === 'object' && !Array.isArray(rule.response)) {
    return rule.response;
  }
  const response = { ...rule };
  delete response.if;
  delete response.when;
  delete response.match;
  delete response.conditions;
  if (Object.keys(response).length === 0) return null;
  return response;
}

function extractOutputText(response) {
  const texts = [];
  const collectFromContent = contentBlocks => {
    for (const block of contentBlocks) {
      if (!block) continue;
      if (typeof block.text === 'string') {
        texts.push(block.text);
      } else if (Array.isArray(block.content)) {
        collectFromContent(block.content);
      }
    }
  };

  const outputs = Array.isArray(response?.output)
    ? response.output
    : Array.isArray(response?.response?.output)
      ? response.response.output
      : [];
  for (const item of outputs) {
    if (Array.isArray(item?.content)) collectFromContent(item.content);
  }
  if (!texts.length && Array.isArray(response?.content)) {
    collectFromContent(response.content);
  }
  if (!texts.length && Array.isArray(response?.output_text)) {
    texts.push(response.output_text.join('\n'));
  }
  return texts.join('\n\n').trim();
}

function jsonOrNull(text) {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function readJson(req, limitBytes = 2 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > limitBytes) {
      const err = new Error('request_too_large');
      err.statusCode = 413;
      throw err;
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error('invalid_json');
    err.statusCode = 400;
    throw err;
  }
}

const HOOK_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    decision: { type: 'string' },
    justification: { type: 'string' },
    steer: {
      anyOf: [
        { type: 'string' },
        { type: 'array', items: { type: 'string' } },
        { type: 'object', additionalProperties: true },
      ],
    },
    abort: {
      anyOf: [
        { type: 'boolean' },
        { type: 'string' },
        { type: 'object', additionalProperties: true },
      ],
    },
    retry: {
      anyOf: [
        { type: 'boolean' },
        { type: 'string' },
        { type: 'object', additionalProperties: true },
      ],
    },
    actions: {
      type: 'array',
      items: { type: 'object', additionalProperties: true },
    },
  },
};

const HOST = process.env.CDX_HOOKS_LLM_HOST ?? '127.0.0.1';
const PORT = Number.parseInt(process.env.CDX_HOOKS_LLM_PORT ?? '4800', 10);
const PATH = process.env.CDX_HOOKS_LLM_PATH ?? '/hook';
const HEALTH_PATH = process.env.CDX_HOOKS_LLM_HEALTH_PATH ?? '/health';
const MAX_STRING_CHARS = Math.max(
  200,
  Number.parseInt(process.env.CDX_HOOKS_LLM_MAX_STRING_CHARS ?? '2000', 10) || 2000,
);
const MAX_OUTPUT_TOKENS = Math.max(
  64,
  Number.parseInt(process.env.CDX_HOOKS_LLM_MAX_OUTPUT_TOKENS ?? '512', 10) || 512,
);
const MODEL =
  trimMaybe(process.env.CDX_HOOKS_MODEL)
  || trimMaybe(process.env.OPENAI_DEFAULT_MODEL)
  || 'gpt-5.4';
const REASONING_EFFORT = trimMaybe(process.env.CDX_HOOKS_EFFORT) || 'low';
const TIMEOUT_MS = Number.parseInt(process.env.CDX_HOOKS_LLM_TIMEOUT_MS ?? '1200', 10) || 1200;
const PREFLIGHT_POLICY = parseJsonEnv('CDX_HOOKS_PREFLIGHT_POLICY_JSON');
const PREFLIGHT_POLICY_FALLBACK =
  normalizePreflightFallback(process.env.CDX_HOOKS_PREFLIGHT_POLICY_FALLBACK);

const SYSTEM_PROMPT =
  trimMaybe(process.env.CDX_HOOKS_LLM_SYSTEM_PROMPT)
  || loadPromptTemplate(
    'hook-supervisor',
    'You are the CDX hook supervisor.\n\n'
      + 'Decide whether to intervene based on the hook payload.\n'
      + '- Respond with JSON ONLY.\n'
      + '- Omit fields when no action is needed. Return {} when you do not intervene.\n'
      + '- For approval.request, set decision to defaultDecision if no override is needed.\n'
      + '- Do not use task_abort for mere slowness, sparse diffs, or long planner/scout/task turns that still show recent activity.\n'
      + '- If progress exists but the upstream prompt or plan looks weak, prefer {} or a concise agent_message requesting a concrete checkpoint; do not abort.\n'
      + '- Use task_abort only for explicit user instruction, clear wrong-scope or duplicate work, or irrecoverably stuck workers.\n'
      + '- Use agent_message when a small steering nudge is enough.\n'
      + '- Keep steer messages concise and actionable.\n',
  );

const openai = new OpenAIProxyClient({
  baseUrl: resolveProxyBaseUrl(),
  providerName: resolveProviderName(),
  apiKey: resolveOpenAiApiKey(),
  timeoutMs: TIMEOUT_MS,
  defaultHeaders: buildProxyHeaders({
    customEventId: process.env.OPENAI_PROXY_CUSTOM_EVENT_ID,
    metadata: process.env.OPENAI_PROXY_METADATA,
    requestTimeout: process.env.OPENAI_PROXY_REQUEST_TIMEOUT,
  }),
});

async function buildResponse({ hook, context, data, timestamp }) {
  const hookName = coerceString(hook) ?? 'unknown';
  if (hookName.startsWith('preflight.') && PREFLIGHT_POLICY) {
    const key = hookName.endsWith('.start') ? 'start' : hookName.endsWith('.completed') ? 'completed' : null;
    const rules = key ? normalizePreflightRuleInput(PREFLIGHT_POLICY?.[key]) : null;
    if (rules && rules.length > 0) {
      for (const rule of rules) {
        if (!matchPreflightRule(rule, data)) continue;
        const response = buildPreflightResponse(rule);
        return response ?? {};
      }
    }
    if (PREFLIGHT_POLICY_FALLBACK === 'none') {
      return {};
    }
  }

  const hookPayload = {
    hook: hookName,
    context: context === undefined ? null : context,
    data: data === undefined ? null : data,
    timestamp: coerceString(timestamp) ?? new Date().toISOString(),
  };
  const trimmed = trimStrings(hookPayload, MAX_STRING_CHARS);
  const prompt = JSON.stringify(trimmed, null, 2);

  const requestPayload = {
    model: MODEL,
    instructions: SYSTEM_PROMPT,
    input: `Hook payload:\n${prompt}`,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'hook_response',
        schema: HOOK_RESPONSE_SCHEMA,
        strict: false,
      },
    },
  };
  if (REASONING_EFFORT && REASONING_EFFORT !== 'none') {
    requestPayload.reasoning = { effort: REASONING_EFFORT };
  }

  const response = await openai.createResponse(requestPayload);

  const text = extractOutputText(response);
  return jsonOrNull(text) ?? {};
}

const server = http.createServer(async (req, res) => {
  const method = (req.method ?? 'GET').toUpperCase();
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (method === 'GET' && url.pathname === HEALTH_PATH) {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname !== PATH) {
    res.statusCode = 404;
    res.end('not_found');
    return;
  }

  if (method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'POST');
    res.end('method_not_allowed');
    return;
  }

  try {
    const payload = await readJson(req);
    if (!payload || !isObject(payload)) {
      sendJson(res, 400, { error: 'missing_body' });
      return;
    }

    const result = await buildResponse(payload);
    sendJson(res, 200, result ?? {});
  } catch (err) {
    const status = Number.isFinite(err?.statusCode) ? err.statusCode : 500;
    const message = err instanceof Error ? err.message : String(err ?? 'unknown_error');
    sendJson(res, status, { error: message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`hook-llm-backend listening on http://${HOST}:${PORT}${PATH}`);
});
