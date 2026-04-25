import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { createRuntimeFixture } from './support/runtime-fixture.mjs';

function installMockServerLifecycle(t) {
  const originalListen = http.Server.prototype.listen;
  const originalAddress = http.Server.prototype.address;
  const originalClose = http.Server.prototype.close;

  http.Server.prototype.listen = function mockListen(port, host, callback) {
    let resolvedPort = port;
    let resolvedHost = host;
    let done = callback;

    if (typeof port === 'function') {
      resolvedPort = 0;
      resolvedHost = '127.0.0.1';
      done = port;
    } else if (typeof host === 'function') {
      resolvedHost = '127.0.0.1';
      done = host;
    }

    this.__mockAddress = {
      address: typeof resolvedHost === 'string' && resolvedHost ? resolvedHost : '127.0.0.1',
      family: 'IPv4',
      port: Number.isFinite(resolvedPort) ? resolvedPort : 0,
    };
    queueMicrotask(() => done?.());
    return this;
  };

  http.Server.prototype.address = function mockAddress() {
    return this.__mockAddress ?? { address: '127.0.0.1', family: 'IPv4', port: 0 };
  };

  http.Server.prototype.close = function mockClose(callback) {
    queueMicrotask(() => callback?.());
    return this;
  };

  t.after(() => {
    http.Server.prototype.listen = originalListen;
    http.Server.prototype.address = originalAddress;
    http.Server.prototype.close = originalClose;
  });
}

function createMockRequest({ body, method = 'POST', url = '/mcp' } = {}) {
  const chunks = typeof body === 'string' && body.length > 0 ? [Buffer.from(body, 'utf8')] : [];
  const req = Readable.from(chunks);
  req.method = method;
  req.url = url;
  return req;
}

function createMockResponse() {
  const headers = new Map();
  let body = '';
  let resolveDone;
  const done = new Promise(resolve => {
    resolveDone = resolve;
  });

  return {
    statusCode: 200,
    headers,
    done,
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), value);
    },
    write(chunk) {
      if (chunk !== undefined && chunk !== null) body += String(chunk);
    },
    end(chunk = '') {
      if (chunk !== undefined && chunk !== null) body += String(chunk);
      resolveDone();
    },
    getBody() {
      return body;
    },
  };
}

async function callRouter(router, payload, { method = 'POST', url = '/mcp' } = {}) {
  const [listener] = router.httpServer?.listeners('request') ?? [];
  assert.equal(typeof listener, 'function', 'router should register an http request listener');

  const req = createMockRequest({
    body: payload === undefined ? undefined : JSON.stringify(payload),
    method,
    url,
  });
  const res = createMockResponse();

  await Promise.all([Promise.resolve(listener(req, res)), res.done]);

  const body = res.getBody();
  return {
    statusCode: res.statusCode,
    body,
    json: body ? JSON.parse(body) : null,
    headers: res.headers,
  };
}

test('router server exposes tools/list and tools/call', async t => {
  installMockServerLifecycle(t);
  const fixture = await createRuntimeFixture(t);
  const { RouterMcpServer } = await fixture.importRuntime('router-server.js');

  const router = new RouterMcpServer({
    onAsk: async ({ askId, args }) => ({
      decision: { option_id: 'A', rationale: 'stub', next_steps: ['do x'] },
      message_for_agent: `askId=${askId} question=${args?.question ?? ''}`,
    }),
  });
  const handle = await router.start({ host: '127.0.0.1', port: 0, path: '/mcp' });
  t.after(async () => {
    await handle.close();
  });

  const initRes = await callRouter(router, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { clientInfo: { name: 'test', version: '0.0.0' } },
  });
  assert.equal(initRes.statusCode, 200);
  const initJson = initRes.json;
  assert.equal(initJson.result?.serverInfo?.name, 'cdx-router');

  const listRes = await callRouter(router, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  });
  const listJson = listRes.json;
  assert.ok(Array.isArray(listJson.result?.tools));
  assert.ok(listJson.result.tools.some(tool => tool.name === 'ask'));

  const callRes = await callRouter(router, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'ask', arguments: { question: 'hello' } },
  });
  const callJson = callRes.json;
  assert.ok(callJson.result?.content?.[0]?.text.includes('question=hello'));
  assert.equal(callJson.result?.structured_content?.decision?.option_id, 'A');
});

test('router server handles concurrent tools/call requests', async t => {
  installMockServerLifecycle(t);
  const fixture = await createRuntimeFixture(t);
  const { RouterMcpServer } = await fixture.importRuntime('router-server.js');

  const router = new RouterMcpServer({
    onAsk: async ({ askId }) => {
      await new Promise(resolve => setTimeout(resolve, 100));
      return {
        decision: { option_id: 'B', rationale: 'stub', next_steps: ['do y'] },
        message_for_agent: `askId=${askId}`,
      };
    },
  });
  const handle = await router.start({ host: '127.0.0.1', port: 0, path: '/mcp' });
  t.after(async () => {
    await handle.close();
  });

  const start = Date.now();
  const request = id => callRouter(router, {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'ask', arguments: { question: 'x' } },
  }).then(response => response.json);

  const [first, second] = await Promise.all([request(10), request(11)]);
  const elapsed = Date.now() - start;
  assert.equal(first.result?.structured_content?.decision?.option_id, 'B');
  assert.equal(second.result?.structured_content?.decision?.option_id, 'B');
  assert.ok(elapsed < 190, `expected overlap, elapsed=${elapsed}ms`);
});
