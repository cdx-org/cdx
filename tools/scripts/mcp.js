import {
  createLspMessageReader,
  writeJsonRpcNotification,
  writeJsonRpcRequest,
} from './lsp.js';

export function createStdioJsonRpcClient(child, { defaultTimeoutMs = 5000 } = {}) {
  if (!child?.stdin || !child?.stdout) {
    throw new Error('Child process must have stdin/stdout');
  }

  const reader = createLspMessageReader(child.stdout);
  const pending = new Map();
  const allMessages = [];
  const notifications = [];
  let requestId = 0;

  reader.onMessage(message => {
    allMessages.push(message);
    if (message && typeof message === 'object' && Object.prototype.hasOwnProperty.call(message, 'id')) {
      const entry = pending.get(message.id);
      if (entry) {
        pending.delete(message.id);
        clearTimeout(entry.timer);
        entry.resolve(message);
        return;
      }
    }
    notifications.push(message);
  });

  const request = (method, params, { timeoutMs = defaultTimeoutMs } = {}) => {
    requestId += 1;
    const id = requestId;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for response (method=${method} id=${id})`));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      writeJsonRpcRequest(child.stdin, id, method, params);
    });
  };

  const notify = (method, params) => {
    writeJsonRpcNotification(child.stdin, method, params);
  };

  const dispose = async () => {
    for (const [id, entry] of pending.entries()) {
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new Error('Client disposed'));
    }
    try {
      child.stdin.end();
    } catch {}
  };

  return {
    request,
    notify,
    dispose,
    allMessages,
    notifications,
  };
}

export async function mcpInitialize(
  client,
  {
    protocolVersion = '2025-06-18',
    clientInfo = { name: 'script-client', version: '0.0.0' },
    capabilities = {},
    timeoutMs,
  } = {},
) {
  const response = await client.request(
    'initialize',
    { protocolVersion, clientInfo, capabilities },
    timeoutMs ? { timeoutMs } : undefined,
  );
  return response.result;
}

export async function mcpListTools(client, { timeoutMs } = {}) {
  const response = await client.request('tools/list', {}, timeoutMs ? { timeoutMs } : undefined);
  return response.result?.tools ?? [];
}

export async function mcpCallTool(client, name, args = {}, { timeoutMs } = {}) {
  const response = await client.request(
    'tools/call',
    { name, arguments: args },
    timeoutMs ? { timeoutMs } : undefined,
  );
  return response.result;
}
