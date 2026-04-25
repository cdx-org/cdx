function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizePricingTier(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'std') return 'standard';
  if (['standard', 'flex', 'batch', 'priority'].includes(normalized)) return normalized;
  return null;
}

function normalizeModel(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim().toLowerCase();
  return normalized ? normalized : null;
}

const TEXT_TOKEN_RATES_PER_1M = {
  batch: {
    'gpt-5.4': { input: 0.938, cachedInput: 0.094, output: 7.5 },
    'gpt-5': { input: 0.625, cachedInput: 0.0625, output: 5.0 },
    'gpt-5-mini': { input: 0.125, cachedInput: 0.0125, output: 1.0 },
    'gpt-5-nano': { input: 0.025, cachedInput: 0.0025, output: 0.2 },
    'gpt-5-pro': { input: 7.5, cachedInput: null, output: 60.0 },
    'gpt-4.1': { input: 1.0, cachedInput: null, output: 4.0 },
    'gpt-4.1-mini': { input: 0.2, cachedInput: null, output: 0.8 },
    'gpt-4.1-nano': { input: 0.05, cachedInput: null, output: 0.2 },
    'gpt-4o': { input: 1.25, cachedInput: null, output: 5.0 },
    'gpt-4o-2024-05-13': { input: 2.5, cachedInput: null, output: 7.5 },
    'gpt-4o-mini': { input: 0.075, cachedInput: null, output: 0.3 },
    o1: { input: 7.5, cachedInput: null, output: 30.0 },
    'o1-pro': { input: 75.0, cachedInput: null, output: 300.0 },
    'o3-pro': { input: 10.0, cachedInput: null, output: 40.0 },
    o3: { input: 1.0, cachedInput: null, output: 4.0 },
    'o3-deep-research': { input: 5.0, cachedInput: null, output: 20.0 },
    'o4-mini': { input: 0.55, cachedInput: null, output: 2.2 },
    'o4-mini-deep-research': { input: 1.0, cachedInput: null, output: 4.0 },
    'o3-mini': { input: 0.55, cachedInput: null, output: 2.2 },
    'o1-mini': { input: 0.55, cachedInput: null, output: 2.2 },
    'computer-use-preview': { input: 1.5, cachedInput: null, output: 6.0 },
  },
  flex: {
    'gpt-5.4': { input: 0.938, cachedInput: 0.094, output: 7.5 },
    'gpt-5': { input: 0.625, cachedInput: 0.0625, output: 5.0 },
    'gpt-5-mini': { input: 0.125, cachedInput: 0.0125, output: 1.0 },
    'gpt-5-nano': { input: 0.025, cachedInput: 0.0025, output: 0.2 },
    o3: { input: 1.0, cachedInput: 0.25, output: 4.0 },
    'o4-mini': { input: 0.55, cachedInput: 0.138, output: 2.2 },
  },
  standard: {
    'gpt-5.4': { input: 1.875, cachedInput: 0.188, output: 15.0 },
    'gpt-5': { input: 1.25, cachedInput: 0.125, output: 10.0 },
    'gpt-5-mini': { input: 0.25, cachedInput: 0.025, output: 2.0 },
    'gpt-5-nano': { input: 0.05, cachedInput: 0.005, output: 0.4 },
    'gpt-5.3-codex-chat-latest': { input: 1.75, cachedInput: 0.175, output: 14.0 },
    'gpt-5-chat-latest': { input: 1.25, cachedInput: 0.125, output: 10.0 },
    'gpt-5-codex': { input: 1.25, cachedInput: 0.125, output: 10.0 },
    'gpt-5-pro': { input: 15.0, cachedInput: null, output: 120.0 },
    'gpt-4.1': { input: 2.0, cachedInput: 0.5, output: 8.0 },
    'gpt-4.1-mini': { input: 0.4, cachedInput: 0.1, output: 1.6 },
    'gpt-4.1-nano': { input: 0.1, cachedInput: 0.025, output: 0.4 },
    'gpt-4o': { input: 2.5, cachedInput: 1.25, output: 10.0 },
    'gpt-4o-2024-05-13': { input: 5.0, cachedInput: null, output: 15.0 },
    'gpt-4o-mini': { input: 0.15, cachedInput: 0.075, output: 0.6 },
    'gpt-realtime': { input: 4.0, cachedInput: 0.4, output: 16.0 },
    'gpt-realtime-mini': { input: 0.6, cachedInput: 0.06, output: 2.4 },
    'gpt-4o-realtime-preview': { input: 5.0, cachedInput: 2.5, output: 20.0 },
    'gpt-4o-mini-realtime-preview': { input: 0.6, cachedInput: 0.3, output: 2.4 },
    'gpt-audio': { input: 2.5, cachedInput: null, output: 10.0 },
    'gpt-audio-mini': { input: 0.6, cachedInput: null, output: 2.4 },
    'gpt-4o-audio-preview': { input: 2.5, cachedInput: null, output: 10.0 },
    'gpt-4o-mini-audio-preview': { input: 0.15, cachedInput: null, output: 0.6 },
    o1: { input: 15.0, cachedInput: 7.5, output: 60.0 },
    'o1-pro': { input: 150.0, cachedInput: null, output: 600.0 },
    'o3-pro': { input: 20.0, cachedInput: null, output: 80.0 },
    o3: { input: 2.0, cachedInput: 0.5, output: 8.0 },
    'o3-deep-research': { input: 10.0, cachedInput: 2.5, output: 40.0 },
    'o4-mini': { input: 1.1, cachedInput: 0.275, output: 4.4 },
    'o4-mini-deep-research': { input: 2.0, cachedInput: 0.5, output: 8.0 },
    'o3-mini': { input: 1.1, cachedInput: 0.55, output: 4.4 },
    'o1-mini': { input: 1.1, cachedInput: 0.55, output: 4.4 },
    'gpt-5.3-codex-mini': { input: 0.25, cachedInput: 0.025, output: 2.0 },
    'codex-mini-latest': { input: 1.5, cachedInput: 0.375, output: 6.0 },
    'gpt-5-search-api': { input: 1.25, cachedInput: 0.125, output: 10.0 },
    'gpt-4o-mini-search-preview': { input: 0.15, cachedInput: null, output: 0.6 },
    'gpt-4o-search-preview': { input: 2.5, cachedInput: null, output: 10.0 },
    'computer-use-preview': { input: 3.0, cachedInput: null, output: 12.0 },
    'gpt-image-1.5': { input: 5.0, cachedInput: 1.25, output: 10.0 },
    'chatgpt-image-latest': { input: 5.0, cachedInput: 1.25, output: 10.0 },
    'gpt-image-1': { input: 5.0, cachedInput: 1.25, output: null },
    'gpt-image-1-mini': { input: 2.0, cachedInput: 0.2, output: null },
  },
  priority: {
    'gpt-5.4': { input: 3.75, cachedInput: 0.375, output: 30.0 },
    'gpt-5': { input: 2.5, cachedInput: 0.25, output: 20.0 },
    'gpt-5-mini': { input: 0.45, cachedInput: 0.045, output: 3.6 },
    'gpt-5-codex': { input: 2.5, cachedInput: 0.25, output: 20.0 },
    'gpt-4.1': { input: 3.5, cachedInput: 0.875, output: 14.0 },
    'gpt-4.1-mini': { input: 0.7, cachedInput: 0.175, output: 2.8 },
    'gpt-4.1-nano': { input: 0.2, cachedInput: 0.05, output: 0.8 },
    'gpt-4o': { input: 4.25, cachedInput: 2.125, output: 17.0 },
    'gpt-4o-2024-05-13': { input: 8.75, cachedInput: null, output: 26.25 },
    'gpt-4o-mini': { input: 0.25, cachedInput: 0.125, output: 1.0 },
    o3: { input: 3.5, cachedInput: 0.875, output: 14.0 },
    'o4-mini': { input: 2.0, cachedInput: 0.5, output: 8.0 },
  },
};

export function getTextTokenRates({ model, tier = 'standard' } = {}) {
  const normalizedModel = normalizeModel(model);
  if (!normalizedModel) return null;

  const normalizedTier = normalizePricingTier(tier) ?? 'standard';
  const tierRates = TEXT_TOKEN_RATES_PER_1M[normalizedTier];
  if (!tierRates) return null;

  const entry = tierRates[normalizedModel];
  if (entry) return { tier: normalizedTier, model: normalizedModel, ...entry };

  if (normalizedTier !== 'standard') {
    const fallback = TEXT_TOKEN_RATES_PER_1M.standard?.[normalizedModel];
    if (fallback) return { tier: 'standard', model: normalizedModel, ...fallback };
  }

  return null;
}

function coerceTokenCount(value) {
  const num = Number.parseInt(value, 10);
  if (!Number.isFinite(num) || num < 0) return 0;
  return num;
}

function roundUsd(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1e8) / 1e8;
}

export function computeTextTokenCostUsd({
  model,
  tier,
  inputTokens,
  cachedInputTokens,
  outputTokens,
} = {}) {
  const rates = getTextTokenRates({ model, tier });
  if (!rates) return null;

  const input = coerceTokenCount(inputTokens);
  const cached = coerceTokenCount(cachedInputTokens);
  const output = coerceTokenCount(outputTokens);

  const inputRate = Number.isFinite(rates.input) ? rates.input : null;
  const cachedRate = Number.isFinite(rates.cachedInput) ? rates.cachedInput : null;
  const outputRate = Number.isFinite(rates.output) ? rates.output : null;

  if (!Number.isFinite(inputRate)) return null;

  const inputUsd = (Math.max(0, input - cached) * inputRate) / 1_000_000;
  const cachedUsd = (cached * (Number.isFinite(cachedRate) ? cachedRate : inputRate)) / 1_000_000;
  const outputUsd = outputRate ? (output * outputRate) / 1_000_000 : 0;

  const totalUsd = inputUsd + cachedUsd + outputUsd;

  return {
    tier: rates.tier,
    model: rates.model,
    tokens: { input, cachedInput: cached, output },
    usd: {
      input: roundUsd(inputUsd),
      cachedInput: roundUsd(cachedUsd),
      output: roundUsd(outputUsd),
      total: roundUsd(totalUsd),
    },
    ratesPer1M: {
      input: inputRate,
      cachedInput: Number.isFinite(cachedRate) ? cachedRate : inputRate,
      output: outputRate ?? 0,
    },
  };
}

export function isTextTokenRatesTable(value) {
  if (!isObject(value)) return false;
  return Object.values(value).every(tierEntry => isObject(tierEntry));
}
