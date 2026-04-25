#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import process from 'node:process';

import { createLspMessageReader, writeJsonRpcError, writeJsonRpcResult } from '../../harness/lsp.js';

const reader = createLspMessageReader(process.stdin);
const SERVER_INFO = { name: 'appserver-mcp-stub', version: '0.0.0' };

reader.onMessage(message => {
  if (!message || typeof message !== 'object') return;
  const { id, method, params } = message;

  if (method === 'initialize') {
    writeJsonRpcResult(process.stdout, id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: { list: true, call: true } },
      serverInfo: SERVER_INFO,
    });
    return;
  }

  if (method === 'tools/list') {
    writeJsonRpcResult(process.stdout, id, {
      tools: [
        {
          name: 'spawn',
          title: 'CDX Spawn Stub',
          description: 'Return a stubbed spawn response.',
          inputSchema: { type: 'object', additionalProperties: true },
        },
      ],
    });
    return;
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const args = params?.arguments;
    if (toolName !== 'spawn' && toolName !== 'cdx.spawn') {
      writeJsonRpcError(process.stdout, id, -32601, `Unknown tool: ${toolName}`);
      return;
    }
    const runId = `stub-${randomUUID()}`;
    const repoRoot = typeof args?.repoRoot === 'string' ? args.repoRoot : null;
    writeJsonRpcResult(process.stdout, id, {
      content: [
        {
          type: 'text',
          text: `cdx run started: ${runId} (stub)`,
        },
      ],
      structured_content: {
        runId,
        status: 'running',
        repoRoot,
        background: true,
      },
    });
    return;
  }

  if (method === 'ping') {
    writeJsonRpcResult(process.stdout, id, {});
  }
});

process.stdin.resume();
