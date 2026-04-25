import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  } catch (err) {
    const parseErr = new Error('invalid_json');
    parseErr.statusCode = 400;
    parseErr.cause = err;
    throw parseErr;
  }
}

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

function toolDescriptor() {
  return {
    name: 'ask',
    description:
      'Ask the central supervisor to decide between options and provide next steps. Use this instead of asking the user directly.',
    inputSchema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        run_id: { type: 'string' },
        task_id: { type: 'string' },
        thread_id: { type: 'string' },
        turn_id: { type: 'string' },
        question: { type: 'string' },
        options: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              id: { type: 'string' },
              summary: { type: 'string' },
            },
          },
        },
        constraints: { type: 'array', items: { type: 'string' } },
        desired_output: { type: 'string' },
      },
      required: ['question'],
    },
  };
}

export class RouterMcpServer {
  constructor({
    protocolVersion = '2025-03-26',
    serverInfo = { name: 'cdx-router', version: '0.1.0' },
    log = () => {},
    onAsk,
  } = {}) {
    this.protocolVersion = protocolVersion;
    this.serverInfo = serverInfo;
    this.log = log;
    this.onAsk = onAsk ?? (async () => ({ message_for_agent: 'No handler configured.' }));
    this.httpServer = null;
    this.url = null;
    this.path = '/mcp';
  }

  async start({ host = '127.0.0.1', port = 0, path = '/mcp' } = {}) {
    if (this.httpServer) {
      return { url: this.url, close: () => this.close() };
    }

    this.path = path;
    this.httpServer = http.createServer(async (req, res) => {
      try {
        await this.#handleRequest(req, res);
      } catch (err) {
        const status = Number.isFinite(err?.statusCode) ? err.statusCode : 500;
        const message = err instanceof Error ? err.message : String(err ?? 'unknown_error');
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: message }));
      }
    });

    await new Promise((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen(port, host, () => {
        this.httpServer.off('error', reject);
        resolve();
      });
    });

    const address = this.httpServer.address();
    const resolvedPort = typeof address === 'object' && address ? address.port : port;
    this.url = new URL(`http://${host}:${resolvedPort}${this.path}`).toString();
    this.log(`router listening: ${this.url}`);

    return { url: this.url, close: () => this.close() };
  }

  async close() {
    if (!this.httpServer) return;
    const server = this.httpServer;
    this.httpServer = null;
    this.url = null;
    await new Promise(resolve => server.close(() => resolve()));
  }

  async #handleRequest(req, res) {
    const method = (req.method ?? 'GET').toUpperCase();
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname !== this.path) {
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

    const payload = await readJson(req);
    if (payload === null) {
      res.statusCode = 400;
      res.end('missing_body');
      return;
    }

    const responses = [];
    const messages = Array.isArray(payload) ? payload : [payload];
    for (const message of messages) {
      const response = await this.#handleJsonRpcMessage(message);
      if (response) responses.push(response);
    }

    if (Array.isArray(payload)) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(responses));
      return;
    }

    if (responses.length === 0) {
      res.statusCode = 204;
      res.end();
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(responses[0]));
  }

  async #handleJsonRpcMessage(message) {
    if (!isObject(message)) return null;
    const { id, method, params } = message;

    if (!method || typeof method !== 'string') {
      if (id === undefined) return null;
      return jsonRpcError(id, -32600, 'Invalid Request');
    }

    if (method === 'initialize') {
      if (id === undefined) return null;
      return jsonRpcResult(id, {
        protocolVersion: this.protocolVersion,
        capabilities: { tools: { list: true, call: true } },
        serverInfo: this.serverInfo,
      });
    }

    if (method === 'ping') {
      if (id === undefined) return null;
      return jsonRpcResult(id, {});
    }

    if (method === 'tools/list') {
      if (id === undefined) return null;
      return jsonRpcResult(id, { tools: [toolDescriptor()] });
    }

    if (method === 'tools/call') {
      if (id === undefined) return null;
      if (!isObject(params)) {
        return jsonRpcError(id, -32602, 'Invalid params');
      }
      const name = params.name;
      const args = params.arguments;
      if (name !== 'ask') {
        return jsonRpcError(id, -32601, `Unknown tool: ${name}`);
      }

      const askId = randomUUID();
      const result = await this.onAsk({
        askId,
        args: isObject(args) ? args : {},
      });

      const messageForAgent =
        typeof result?.message_for_agent === 'string'
          ? result.message_for_agent
          : JSON.stringify(result ?? {}, null, 2);

      return jsonRpcResult(id, {
        content: [{ type: 'text', text: messageForAgent }],
        structured_content: result ?? null,
      });
    }

    if (id === undefined) return null;
    return jsonRpcError(id, -32601, `Unknown method: ${method}`);
  }
}

