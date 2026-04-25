import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import process from 'node:process';

import { LspMessageReader, writeLspMessage } from './lsp.js';
import { normalizeToolResultResponseMessage } from './mcp-response-normalization.js';

export const OPENAI_API_ENV_KEYS = Object.freeze([
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'OPENAI_API_BASE',
  'OPENAI_BASE_URL',
  'OPENAI_PROXY_BASE_URL',
  'OPENAI_PROVIDER_NAME',
  'openai_api_base',
  'openai_base_url',
  'openai_provider_name',
]);

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function coerceString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseTimeoutMs(value, fallbackMs) {
  if (value === undefined || value === null) return fallbackMs;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return fallbackMs;
  return Math.max(0, parsed);
}

function parseArgs(value) {
  if (!value) return undefined;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // ignore and fall back to whitespace splitting
  }
  return trimmed.split(/\s+/).map(segment => segment.trim()).filter(Boolean);
}

function commandLooksLikeCodex(command) {
  const base = String(command ?? '').split(/[\\/]/).pop()?.toLowerCase() ?? '';
  return base === 'codex' || base.startsWith('codex-') || base.startsWith('codex.');
}

function normalizeCodexAuthMode(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return null;
  if (['chatgpt', 'chat-gpt', 'chat_gpt', 'web'].includes(normalized)) return 'chatgpt';
  if (['api', 'openai-api', 'openai_api', 'apikey', 'api-key', 'api_key'].includes(normalized)) {
    return 'api';
  }
  if (['inherit', 'auto', 'default', 'none', 'off'].includes(normalized)) return 'inherit';
  return null;
}

export function resolveCodexAuthMode(env = process.env) {
  const explicit = normalizeCodexAuthMode(env.CDX_CODEX_AUTH_MODE ?? env.CDX_AUTH_MODE);
  if (explicit) return explicit;
  return 'chatgpt';
}

export function prepareCodexAppServerEnv(env, { authMode = resolveCodexAuthMode(env) } = {}) {
  const next = { ...(env || {}) };
  if (authMode === 'chatgpt') {
    for (const key of OPENAI_API_ENV_KEYS) delete next[key];
  }
  return next;
}

function argsContainConfigKey(args, key) {
  if (!Array.isArray(args)) return false;
  for (let i = 0; i < args.length - 1; i += 1) {
    const flag = args[i];
    if ((flag !== '-c' && flag !== '--config') || typeof args[i + 1] !== 'string') continue;
    if (args[i + 1].trim().startsWith(`${key}=`)) return true;
  }
  return false;
}

export function prepareCodexAppServerArgs(command, args, { authMode = resolveCodexAuthMode() } = {}) {
  const next = Array.isArray(args) ? [...args] : ['app-server'];
  if (!commandLooksLikeCodex(command)) return next;
  if (authMode !== 'chatgpt') return next;
  if (argsContainConfigKey(next, 'forced_login_method')) return next;

  const configPair = ['-c', 'forced_login_method="chatgpt"'];
  const insertAt = next.lastIndexOf('app-server');
  if (insertAt === -1) {
    next.unshift(...configPair);
  } else {
    next.splice(insertAt, 0, ...configPair);
  }
  return next;
}

export class AppServerClient extends EventEmitter {
  constructor({
    command = process.env.CODEX_BIN ?? 'codex',
    args,
    env = {},
    log = () => {},
    clientInfo = { name: 'cdx-appserver-orchestrator', version: '0.1.0' },
    approvalDecision = 'acceptForSession',
    approvalJustification = null,
    approvalHook = null,
    hookContext = null,
  } = {}) {
    super();
    this.command = command;
    const envArgs = parseArgs(process.env.CODEX_APP_SERVER_ARGS ?? process.env.CODEX_ARGS);
    const inheritedEnv = { ...process.env, ...env };
    this.authMode = resolveCodexAuthMode(inheritedEnv);
    this.args = prepareCodexAppServerArgs(
      this.command,
      args ?? envArgs ?? ['app-server'],
      { authMode: this.authMode },
    );
    this.env = commandLooksLikeCodex(this.command)
      ? prepareCodexAppServerEnv(inheritedEnv, { authMode: this.authMode })
      : inheritedEnv;
    this.log = log;
    this.clientInfo = clientInfo;
    this.approvalDecision = approvalDecision;
    this.approvalJustification = approvalJustification;
    this.approvalHook = approvalHook;
    this.hookContext = hookContext;

    this.closed = false;
    this.closeError = null;

    this.proc = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.env,
    });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stderr.setEncoding('utf8');

    this.reader = new LspMessageReader(this.proc.stdout);
    this.reader.onMessage(message => this.#handleIncoming(message));

    this.proc.stderr.on('data', chunk => {
      const trimmed = String(chunk ?? '').trim();
      if (!trimmed) return;
      this.log('[app-server stderr]', trimmed);
    });

    this.proc.on('error', err => {
      const error = err instanceof Error ? err : new Error(String(err ?? 'unknown error'));
      const code = typeof err?.code === 'string' ? err.code : null;
      const hint =
        code === 'ENOENT'
          ? ` Unable to spawn the Codex app-server binary (${this.command}). Set CODEX_BIN to an absolute path (e.g. ${process.execPath} ...), or ensure \"codex\" is on PATH.`
          : '';

      const wrapped = new Error(`${error.message}${hint}`);
      wrapped.code = code ?? undefined;

      this.closed = true;
      this.closeError = wrapped;
      for (const pending of this.pending.values()) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(wrapped);
      }
      this.pending.clear();
      this.emit('exit', { code: null, signal: null, error: wrapped.message });
    });

    this.proc.on('exit', (code, signal) => {
      const err = new Error(`codex app-server exited (code=${code}, signal=${signal})`);
      this.closed = true;
      this.closeError = err;
      for (const pending of this.pending.values()) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(err);
      }
      this.pending.clear();
      this.emit('exit', { code, signal });
    });

    this.nextId = 1;
    this.pending = new Map();
    this.initialized = false;
    this.initPromise = null;
    this.requestTimeoutMs = parseTimeoutMs(
      process.env.CDX_APP_SERVER_REQUEST_TIMEOUT_MS,
      5 * 60 * 1000,
    );
  }

  async ensureInitialized() {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      await this.request('initialize', { clientInfo: this.clientInfo });
      this.notify('initialized');
      this.initialized = true;
    })();
    return this.initPromise;
  }

  async dispose(reason = 'dispose') {
    this.log('Disposing app-server client', reason);
    try {
      if (!this.proc.killed) this.proc.kill();
    } catch (err) {
      this.log('Failed to kill app-server', err);
    }
  }

  notify(method, params) {
    writeLspMessage(this.proc.stdin, {
      method,
      params: params === undefined ? undefined : params,
    });
  }

  request(method, params) {
    if (this.closed) {
      const err = this.closeError ?? new Error('codex app-server is closed');
      return Promise.reject(err);
    }
    const id = this.nextId;
    this.nextId += 1;
    const message = {
      id,
      method,
      params: params === undefined ? undefined : params,
    };

    const promise = new Promise((resolve, reject) => {
      let timer = null;
      const timeoutMs = this.requestTimeoutMs;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          const err = new Error(
            `codex app-server request timed out (method=${method}, id=${id}, timeoutMs=${timeoutMs})`,
          );
          err.code = 'ETIMEDOUT';
          reject(err);
        }, timeoutMs);
        timer.unref?.();
      }
      this.pending.set(id, { resolve, reject, timer });
    });

    writeLspMessage(this.proc.stdin, message);
    return promise;
  }

  async #handleIncoming(message) {
    const normalizedMessage = normalizeToolResultResponseMessage(message);
    message = normalizedMessage;
    if (!isObject(message)) return;

    if (Object.hasOwn(message, 'method')) {
      const method = message.method;
      if (Object.hasOwn(message, 'id')) {
        await this.#handleServerRequest(message).catch(err => {
          this.log('Failed to handle server request', method, err);
        });
        return;
      }
      this.emit('notification', message);
      return;
    }

    if (!Object.hasOwn(message, 'id')) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (pending.timer) clearTimeout(pending.timer);

    if (Object.hasOwn(message, 'error') && message.error) {
      const err = new Error(message.error?.message ?? 'app-server request failed');
      err.code = message.error?.code;
      err.data = message.error?.data;
      pending.reject(err);
      return;
    }

    pending.resolve(message.result);
  }

  async #handleServerRequest(request) {
    const { id, method, params } = request;

    if (method === 'item/commandExecution/requestApproval') {
      return this.#reply(
        id,
        await this.#resolveApprovalResult({ method, params }),
        params,
        method,
      );
    }
    if (method === 'item/fileChange/requestApproval') {
      return this.#reply(
        id,
        await this.#resolveApprovalResult({ method, params }),
        params,
        method,
      );
    }
    if (method === 'execCommandApproval') {
      return this.#reply(
        id,
        await this.#resolveApprovalResult({ method, params, defaultDecision: 'allow' }),
        params,
        method,
      );
    }
    if (method === 'applyPatchApproval') {
      return this.#reply(
        id,
        await this.#resolveApprovalResult({ method, params, defaultDecision: 'allow' }),
        params,
        method,
      );
    }

    this.log('Unhandled app-server request', method);
    return this.#reply(
      id,
      await this.#resolveApprovalResult({ method, params }),
      params,
      method,
    );
  }

  #resolveHookContext(params) {
    let base = null;
    if (typeof this.hookContext === 'function') {
      try {
        base = this.hookContext();
      } catch (err) {
        this.log('hookContext function failed', err);
      }
    } else if (isObject(this.hookContext)) {
      base = this.hookContext;
    }
    const context = isObject(base) ? { ...base } : {};
    const threadId = params?.threadId ?? params?.thread?.id ?? null;
    const turnId = params?.turnId ?? params?.turn?.id ?? null;
    const itemId = params?.itemId ?? params?.item?.id ?? null;
    if (threadId) context.threadId = threadId;
    if (turnId) context.turnId = turnId;
    if (itemId) context.itemId = itemId;
    return context;
  }

  async #resolveDefaultDecision({ method, params } = {}) {
    const configured = this.approvalDecision;
    if (typeof configured === 'function') {
      try {
        const value = await configured({ method, params });
        const decision = coerceString(value);
        if (decision) return decision;
      } catch (err) {
        this.log('approvalDecision function failed', err);
      }
    }
    return coerceString(configured) ?? 'acceptForSession';
  }

  async #resolveApprovalResult({ method, params, defaultDecision } = {}) {
    const fallbackDecision =
      coerceString(defaultDecision) ?? (await this.#resolveDefaultDecision({ method, params }));
    let result = this.#buildApprovalResult({ decision: fallbackDecision, method, params });

    if (typeof this.approvalHook === 'function') {
      const context = this.#resolveHookContext(params);
      try {
        const hookResult = await this.approvalHook({
          method,
          params,
          context,
          defaultDecision: fallbackDecision,
          defaultResult: result,
        });
        if (isObject(hookResult)) {
          const hookDecision = coerceString(
            hookResult.decision ?? hookResult.approval ?? hookResult.action,
          );
          const hookJustification = coerceString(
            hookResult.justification ?? hookResult.reason ?? hookResult.message,
          );
          const resolvedDecision = hookDecision ?? fallbackDecision;
          if (hookJustification) {
            result = { decision: resolvedDecision, justification: hookJustification };
          } else if (hookDecision) {
            result = this.#buildApprovalResult({
              decision: resolvedDecision,
              method,
              params,
            });
          }
        }
      } catch (err) {
        this.log('approvalHook failed', err);
      }
    }

    return result;
  }

  #buildApprovalResult({ decision, method, params }) {
    const base = { decision };

    const configured = this.approvalJustification;
    let justification = null;

    if (typeof configured === 'function') {
      try {
        const value = configured({ method, params, decision });
        if (typeof value === 'string' && value.trim()) {
          justification = value.trim();
        }
      } catch (err) {
        this.log('approvalJustification function failed', err);
      }
    } else if (typeof configured === 'string' && configured.trim()) {
      justification = configured.trim();
    }

    if (!justification) {
      const command =
        typeof params?.item?.command === 'string'
          ? params.item.command
          : typeof params?.command === 'string'
            ? params.command
            : null;
      const reason =
        typeof params?.reason === 'string'
          ? params.reason
          : typeof params?.requestedReason === 'string'
            ? params.requestedReason
            : null;

      const normalizedDecision = typeof decision === 'string' ? decision.toLowerCase() : '';
      const isAutoApproval =
        normalizedDecision.startsWith('accept')
        || normalizedDecision.startsWith('allow')
        || normalizedDecision.startsWith('approve');
      const prefix = isAutoApproval ? 'cdx auto-approval' : 'cdx approval decision';
      const parts = [`${prefix} (${decision})`];
      if (method) parts.push(`method=${method}`);
      if (command) parts.push(`command=${command}`);
      if (reason) parts.push(`reason=${reason}`);
      justification = parts.join(' · ');
    }

    return justification ? { ...base, justification } : base;
  }

  async #reply(id, result, params, method) {
    if (id === undefined || id === null) return;
    this.emit('server-request', { id, method, result, params });
    writeLspMessage(this.proc.stdin, { id, result });
  }
}
