import { LspMessageReader, writeLspMessage } from '../../../src/runtime/lsp.js';

export { LspMessageReader, writeLspMessage };

export function createLspMessageReader(stream) {
  return new LspMessageReader(stream);
}

export function writeJsonRpcRequest(stream, id, method, params) {
  writeLspMessage(stream, { jsonrpc: '2.0', id, method, params });
}

export function writeJsonRpcResult(stream, id, result) {
  if (id === undefined || id === null) return;
  writeLspMessage(stream, { jsonrpc: '2.0', id, result });
}

export function writeJsonRpcError(stream, id, code, message) {
  if (id === undefined || id === null) return;
  writeLspMessage(stream, { jsonrpc: '2.0', id, error: { code, message } });
}

export function writeJsonRpcNotification(stream, method, params) {
  writeLspMessage(stream, { jsonrpc: '2.0', method, params });
}
