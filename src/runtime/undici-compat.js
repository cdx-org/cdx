import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function isDirectUndiciMissingError(error) {
  if (!error) return false;
  const code = typeof error.code === 'string' ? error.code : '';
  const message = typeof error.message === 'string' ? error.message : '';
  return (
    (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND')
    && message.includes("'undici'")
  );
}

let undiciModule = null;
try {
  undiciModule = require('undici');
} catch (error) {
  if (!isDirectUndiciMissingError(error)) {
    throw error;
  }
}

export const UndiciAgent = typeof undiciModule?.Agent === 'function' ? undiciModule.Agent : null;
export const undiciFetch =
  typeof undiciModule?.fetch === 'function' ? undiciModule.fetch.bind(undiciModule) : null;

export function createUndiciAgent(options) {
  return UndiciAgent ? new UndiciAgent(options) : null;
}

export function getFetchImplementation() {
  if (typeof globalThis.fetch === 'function') {
    return globalThis.fetch.bind(globalThis);
  }
  return undiciFetch;
}

export function hasUndiciAgent() {
  return Boolean(UndiciAgent);
}

export function assertFetchAvailable(label = 'fetch') {
  const fetchImpl = getFetchImplementation();
  if (typeof fetchImpl === 'function') {
    return fetchImpl;
  }
  throw new Error(
    `${label} is unavailable. Use Node 18+ or install the optional "undici" dependency.`,
  );
}
