import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRuntimeFixture } from './support/runtime-fixture.mjs';

test('OpenAIProxyClient derives the correct API base across proxy layouts', async t => {
  const fixture = await createRuntimeFixture(t);
  const { OpenAIProxyClient } = await fixture.importRuntime('openai-proxy-client.js');

  const embeddedProviderClient = new OpenAIProxyClient({
    baseUrl: 'https://proxy.example.com/api/providers/openai-us/v1',
    apiKey: 'test-key',
  });
  assert.equal(embeddedProviderClient.apiBase(), 'https://proxy.example.com/api/providers/openai-us/v1');

  const directOpenAiClient = new OpenAIProxyClient({
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'test-key',
  });
  assert.equal(directOpenAiClient.apiBase(), 'https://api.openai.com/v1');

  const apiSuffixClient = new OpenAIProxyClient({
    baseUrl: 'https://proxy.example.com/api',
    providerName: 'openai-eu',
    apiKey: 'test-key',
  });
  assert.equal(apiSuffixClient.apiBase(), 'https://proxy.example.com/api/providers/openai-eu/v1');

  const fallbackClient = new OpenAIProxyClient({
    baseUrl: 'https://proxy.example.com',
    providerName: 'openai-us',
    apiKey: 'test-key',
  });
  assert.equal(fallbackClient.apiBase(), 'https://proxy.example.com/api/providers/openai-us/v1');
});

test('deriveRateLimitPressureState parses rate-limit snapshots and ignores unrelated notifications', async t => {
  const fixture = await createRuntimeFixture(t);
  const { deriveRateLimitPressureState } = await fixture.importRuntime('openai-proxy-client.js');

  const now = 1_710_000_000_000;
  const snapshot = deriveRateLimitPressureState(
    {
      method: 'account/ratelimits/updated',
      params: {
        rateLimits: {
          requests: {
            usedPercent: 100,
            resetsAt: now + 2_000,
            credits: {
              remaining: 0,
              total: 50,
            },
          },
        },
      },
    },
    { now },
  );

  assert.equal(snapshot?.source, 'snapshot');
  assert.equal(snapshot?.rateLimits.length, 1);
  assert.equal(snapshot?.ratePressureLevel, 'critical');
  assert.equal(snapshot?.rateHeadroomPercent, 0);
  assert.equal(snapshot?.shouldThrottle, true);
  assert.equal(snapshot?.nextResetAt, now + 2_000);
  assert.equal(snapshot?.nextResetInMs, 2_000);

  const ignored = deriveRateLimitPressureState({
    method: 'turn/completed',
    params: { status: 'completed' },
  });
  assert.equal(ignored, null);
});
