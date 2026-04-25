#!/usr/bin/env node

import process from 'node:process';
import { BrokerSession } from '../runtime/broker-session.js';
import { LspMessageReader, writeLspMessage } from '../runtime/lsp.js';

const BROKER_BASE_URL = process.env.BROKER_BASE_URL ?? 'http://localhost:4000';

function log(...args) {
  if (process.env.ORCHESTRATOR_LOG_LEVEL === 'debug') {
    console.error(new Date().toISOString(), ...args);
  }
}

class AgentSession {
  constructor(agentId) {
    this.agentId = agentId;
    this.disposed = false;
    this.session = null;
    this.readyPromise = null;
    this.restartPromise = null;
    this.boundHandlers = null;

    this.#attachSession(this.#createSession());
  }

  #createSession() {
    return new BrokerSession(BROKER_BASE_URL, {
      log: (...args) => log(`[agent:${this.agentId}]`, ...args),
    });
  }

  #attachSession(session) {
    if (this.boundHandlers) {
      const { session: prevSession, messageHandler, closeHandler, errorHandler } = this.boundHandlers;
      prevSession.off('message', messageHandler);
      prevSession.off('close', closeHandler);
      prevSession.off('error', errorHandler);
    }

    const messageHandler = payload => {
      writeLspMessage(process.stdout, { agentId: this.agentId, payload });
    };

    const closeHandler = payload => {
      if (session !== this.session || this.disposed) return;
      this.#handleSessionClose(payload).catch(err => {
        log(`Failed to handle close for agent ${this.agentId}`, err);
      });
    };

    const errorHandler = err => {
      log(`Session error for agent ${this.agentId}`, err);
      if (session !== this.session || this.disposed) return;
      writeLspMessage(process.stdout, {
        agentId: this.agentId,
        event: 'agent-error',
        error: err.message,
      });
    };

    session.on('message', messageHandler);
    session.on('close', closeHandler);
    session.on('error', errorHandler);

    this.boundHandlers = { session, messageHandler, closeHandler, errorHandler };
    this.session = session;
    this.readyPromise = session.ensureReady();
  }

  async #handleSessionClose(payload) {
    if (this.disposed) return;
    writeLspMessage(process.stdout, { agentId: this.agentId, payload });
    await this.#restartSession(payload?.reason ?? 'session-close');
  }

  async #restartSession(reason) {
    if (this.disposed) return;
    if (this.restartPromise) {
      await this.restartPromise;
      return;
    }

    const previousSession = this.session;
    const restartLabel = reason ?? 'unknown';

    writeLspMessage(process.stdout, {
      agentId: this.agentId,
      event: 'agent-restarting',
      reason: restartLabel,
    });

    const newSession = this.#createSession();
    this.#attachSession(newSession);

    this.restartPromise = (async () => {
      try {
        await this.readyPromise;
        writeLspMessage(process.stdout, {
          agentId: this.agentId,
          event: 'agent-restarted',
          reason: restartLabel,
        });
      } finally {
        if (previousSession) {
          try {
            await previousSession.dispose('agent-restart');
          } catch (err) {
            log(`Failed to dispose previous session for agent ${this.agentId}`, err);
          }
        }
      }
    })();

    try {
      await this.restartPromise;
    } finally {
      this.restartPromise = null;
    }
  }

  async send(payload) {
    if (this.disposed) {
      throw new Error(`Agent ${this.agentId} is already disposed`);
    }

    while (!this.disposed) {
      const currentSession = this.session;
      await this.readyPromise;
      try {
        await currentSession.send(payload);
        return;
      } catch (err) {
        if (this.disposed) throw err;
        if (currentSession !== this.session) {
          if (this.restartPromise) {
            try {
              await this.restartPromise;
            } catch (restartErr) {
              log(`Restart promise failed for agent ${this.agentId}`, restartErr);
            }
          }
          continue;
        }
        if (err?.message === 'session-closed') {
          await this.#restartSession('send-error');
          continue;
        }
        throw err;
      }
    }

    throw new Error(`Agent ${this.agentId} is already disposed`);
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.restartPromise) {
      try {
        await this.restartPromise;
      } catch (err) {
        log(`Restart promise rejected for agent ${this.agentId}`, err);
      }
    }
    if (this.readyPromise) {
      try {
        await this.readyPromise;
      } catch (err) {
        log(`Ready promise rejected for agent ${this.agentId}`, err);
      }
    }
    if (this.boundHandlers) {
      const { session, messageHandler, closeHandler, errorHandler } = this.boundHandlers;
      session.off('message', messageHandler);
      session.off('close', closeHandler);
      session.off('error', errorHandler);
      this.boundHandlers = null;
    }
    await this.session?.dispose('agent-dispose');
  }
}

const agents = new Map();

async function handleEnvelope(envelope) {
  const { agentId, payload, control } = envelope;
  if (!agentId) throw new Error('Envelope missing agentId');

  let agent = agents.get(agentId);

  if (control === 'dispose') {
    if (agent) {
      await agent.dispose();
      agents.delete(agentId);
      writeLspMessage(process.stdout, { agentId, event: 'agent-disposed' });
    }
    return;
  }

  if (!agent) {
    agent = new AgentSession(agentId);
    agents.set(agentId, agent);
    writeLspMessage(process.stdout, { agentId, event: 'agent-created' });
  }

  if (payload !== undefined && payload !== null) {
    await agent.send(payload);
  }
}

async function shutdown() {
  await Promise.all([...agents.values()].map(agent => agent.dispose()));
  agents.clear();
}

const reader = new LspMessageReader(process.stdin);
reader.onMessage(message => {
  handleEnvelope(message).catch(err => {
    log('Failed to handle envelope', err);
    writeLspMessage(process.stdout, {
      error: err.message,
      stack: err.stack,
    });
  });
});

const handleSignal = signal => {
  log('Received signal', signal);
  shutdown().finally(() => {
    process.exit(0);
  });
};

process.on('SIGINT', handleSignal);
process.on('SIGTERM', handleSignal);

process.stdin.on('end', () => {
  shutdown().finally(() => {
    process.exit(0);
  });
});
