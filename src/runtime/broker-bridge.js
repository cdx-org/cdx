import process from 'node:process';

import { BrokerSession } from './broker-session.js';
import { LspMessageReader, writeLspMessage } from './lsp.js';

function createLogger() {
  return (...args) => {
    if (process.env.BRIDGE_LOG_LEVEL === 'debug') {
      console.error(new Date().toISOString(), ...args);
    }
  };
}

export function normalizeBrokerClientMessage(message) {
  if (!message || typeof message !== 'object') return message;
  if (message.method !== 'initialize') return message;

  const params = message.params && typeof message.params === 'object' ? message.params : {};

  // Some MCP clients omit initialize.capabilities; Codex MCP server requires the
  // field to be present to complete the handshake.
  if (!Object.prototype.hasOwnProperty.call(params, 'capabilities')) {
    params.capabilities = {};
    message.params = params;
  }

  return message;
}

export async function runBrokerBridge({
  brokerBaseUrl = process.env.BROKER_BASE_URL ?? 'http://localhost:4000',
} = {}) {
  const log = createLogger();
  const session = new BrokerSession(brokerBaseUrl, { log });
  await session.ensureReady();

  let cleanedUp = false;
  let pending = Promise.resolve();

  const cleanup = async reason => {
    if (cleanedUp) return;
    cleanedUp = true;
    await pending.catch(() => {});
    await session.dispose(reason).catch(err => {
      log('cleanup dispose failed', err);
    });
  };

  session.on('message', payload => {
    writeLspMessage(process.stdout, payload);
  });

  session.on('close', payload => {
    log('Session closed', payload);
    cleanup('session-close').finally(() => {
      process.exit(0);
    });
  });

  session.on('error', err => {
    log('Session error', err);
    process.exitCode = 1;
  });

  const reader = new LspMessageReader(process.stdin);
  reader.onMessage(message => {
    const normalized = normalizeBrokerClientMessage(message);
    pending = pending
      .then(() => session.send(normalized))
      .catch(err => {
        log('send failed', err);
        process.exitCode = 1;
      });
  });

  process.stdin.resume();

  const handleSignal = signal => {
    log('Received signal', signal);
    cleanup('signal').finally(() => {
      process.exit(0);
    });
  };

  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);

  process.stdin.on('end', () => {
    cleanup('stdin-end').finally(() => {
      process.exit(0);
    });
  });

  await session.waitForStreamEnd();
  await cleanup('stream-end');
  process.stdin.pause();
}

