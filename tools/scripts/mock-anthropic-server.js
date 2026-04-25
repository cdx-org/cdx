#!/usr/bin/env node
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const SMOKE_FILE_PATH = 'notes/smoke-eval.md';
const SMOKE_FILE_CONTENT = '# Smoke Eval\ncreated-by: orchestrator\n';

function parseArgs(argv) {
  const options = {
    host: DEFAULT_HOST,
    port: 0,
    model: process.env.CDX_EVAL_MOCK_ANTHROPIC_MODEL || DEFAULT_MODEL,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--host' && argv[index + 1]) {
      options.host = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--port' && argv[index + 1]) {
      options.port = Number.parseInt(argv[index + 1], 10) || 0;
      index += 1;
      continue;
    }
    if (arg === '--model' && argv[index + 1]) {
      options.model = argv[index + 1];
      index += 1;
      continue;
    }
  }

  return options;
}

async function appendJsonLine(targetPath, value) {
  if (!targetPath) return;
  await mkdir(path.dirname(targetPath), { recursive: true });
  await appendFile(targetPath, `${JSON.stringify(value)}\n`, 'utf8');
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => {
      body += String(chunk ?? '');
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'content-type': 'application/json',
    'request-id': `req_mock_${randomUUID()}`,
    'content-length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  response.end(body);
}

function makeUsage() {
  return {
    input_tokens: 16,
    output_tokens: 12,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

function makeMessage({ content, model, stopReason }) {
  return {
    id: `msg_mock_${randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: makeUsage(),
  };
}

function getTextFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n');
}

function findLastUserText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user') {
      return getTextFromContent(message.content);
    }
  }
  return '';
}

function hasToolResult(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const lastMessage = messages[messages.length - 1];
  if (lastMessage?.role !== 'user' || !Array.isArray(lastMessage.content)) {
    return false;
  }
  return lastMessage.content.some(block => block?.type === 'tool_result');
}

function buildMockResponse(payload, model) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const promptText = findLastUserText(messages);

  if (hasToolResult(messages)) {
    return makeMessage({
      model,
      stopReason: 'end_turn',
      content: [
        {
          type: 'text',
          text: `Created ${SMOKE_FILE_PATH} with the requested content.`,
        },
      ],
    });
  }

  if (promptText.includes('Reply with exactly: ok')) {
    return makeMessage({
      model,
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'ok' }],
    });
  }

  if (
    promptText.includes(SMOKE_FILE_PATH) &&
    promptText.includes('# Smoke Eval') &&
    promptText.includes('created-by: orchestrator')
  ) {
    return makeMessage({
      model,
      stopReason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_mock_bash_1',
          name: 'Bash',
          input: {
            command: "mkdir -p notes && printf '# Smoke Eval\\ncreated-by: orchestrator\\n' > notes/smoke-eval.md",
            description: 'Create the smoke eval file',
          },
        },
      ],
    });
  }

  return makeMessage({
    model,
    stopReason: 'end_turn',
    content: [{ type: 'text', text: 'ok' }],
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const requestLogPath = process.env.CDX_EVAL_MOCK_ANTHROPIC_LOG || '';

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://${options.host}:${options.port || 80}`);
    const pathname = url.pathname;
    const method = request.method || 'GET';
    const rawBody = await readRequestBody(request).catch(error => {
      sendJson(response, 500, {
        type: 'error',
        error: {
          type: 'internal_server_error',
          message: error instanceof Error ? error.message : String(error ?? 'body_read_failed'),
        },
      });
      return null;
    });
    if (rawBody === null) return;

    let payload = null;
    if (rawBody) {
      try {
        payload = JSON.parse(rawBody);
      } catch {
        payload = null;
      }
    }

    await appendJsonLine(requestLogPath, {
      at: new Date().toISOString(),
      method,
      pathname,
      payload,
    });

    if (pathname === '/health') {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (pathname === '/v1/messages/count_tokens' && method === 'POST') {
      sendJson(response, 200, { input_tokens: 32 });
      return;
    }

    if (pathname === '/v1/models' && method === 'GET') {
      sendJson(response, 200, {
        data: [
          {
            id: options.model,
            type: 'model',
            display_name: options.model,
          },
        ],
        first_id: options.model,
        has_more: false,
        last_id: options.model,
      });
      return;
    }

    if (pathname === '/v1/messages' && method === 'POST') {
      if (payload?.stream === true) {
        sendJson(response, 404, {
          type: 'error',
          error: {
            type: 'not_found_error',
            message: 'streaming not supported by eval mock',
          },
        });
        return;
      }

      sendJson(response, 200, buildMockResponse(payload, options.model));
      return;
    }

    sendJson(response, 404, {
      type: 'error',
      error: {
        type: 'not_found_error',
        message: `Unhandled mock route: ${method} ${pathname}`,
      },
    });
  });

  server.listen(options.port, options.host, () => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      process.stderr.write('Failed to resolve listening address\n');
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`READY ${address.port}\n`);
  });
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
