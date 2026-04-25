#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import process from 'node:process';

import { createLspMessageReader, writeLspMessage } from '../../harness/lsp.js';

const reader = createLspMessageReader(process.stdin);

let threadCounter = 0;
let turnCounter = 0;
let plannerTurnCounter = 0;
let taskTurnCounter = 0;
const taskThreadIds = new Set();

function reply(id, result) {
  if (id === undefined || id === null) return;
  writeLspMessage(process.stdout, { id, result });
}

function notify(method, params) {
  writeLspMessage(process.stdout, { method, params });
}

function collectInputText(params) {
  const input = params?.input;
  if (!Array.isArray(input)) return '';
  return input
    .map(part => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

function isPlannerPrompt(text) {
  if (!text) return false;
  return (
    text.includes('You are an expert project planner') ||
    text.includes('Break the given goal into a concise JSON plan') ||
    text.includes('"tasks"') ||
    text.includes('Return ONLY JSON')
  );
}

function buildPlan() {
  const mode = String(process.env.APP_SERVER_STUB_PLAN_MODE ?? '').trim().toLowerCase();
  const desiredCountRaw = process.env.APP_SERVER_STUB_TASK_COUNT;
  const desiredCount = Math.max(1, Number.parseInt(desiredCountRaw ?? '3', 10) || 3);

  const namePool = [
    'alpha',
    'bravo',
    'charlie',
    'delta',
    'echo',
    'foxtrot',
    'golf',
    'hotel',
    'india',
    'juliet',
    'kilo',
    'lima',
    'mike',
    'november',
    'oscar',
    'papa',
    'quebec',
    'romeo',
    'sierra',
    'tango',
    'uniform',
    'victor',
    'whiskey',
    'xray',
    'yankee',
    'zulu',
  ];

  const buildParallel = count => ({
    tasks: Array.from({ length: count }, (_, idx) => {
      const id = namePool[idx] ?? `task-${idx + 1}`;
      const label = id.charAt(0).toUpperCase() + id.slice(1);
      return { id, description: `${label} task`, dependsOn: [], prompt: `Do ${id}.` };
    }),
  });

  const buildSerial = count => ({
    tasks: Array.from({ length: count }, (_, idx) => {
      const id = namePool[idx] ?? `task-${idx + 1}`;
      const label = id.charAt(0).toUpperCase() + id.slice(1);
      const dependsOn = idx === 0 ? [] : [namePool[idx - 1] ?? `task-${idx}`];
      return { id, description: `${label} task`, dependsOn, prompt: `Do ${id}.` };
    }),
  });

  const parallel = buildParallel(desiredCount);
  const serial = buildSerial(desiredCount);

  if (mode === 'serial') return serial;
  if (mode === 'serial-then-parallel') {
    return plannerTurnCounter <= 1 ? serial : parallel;
  }

  return parallel;
}

function parseDelayMap() {
  const raw = process.env.APP_SERVER_STUB_DELAY_MAP;
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseTaskTextSequence() {
  const raw = process.env.APP_SERVER_STUB_TASK_TEXT_SEQUENCE;
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const sequence = parsed
      .map(item => (typeof item === 'string' ? item : ''))
      .filter(item => item.length > 0);
    return sequence.length > 0 ? sequence : null;
  } catch {
    return null;
  }
}

const taskTextSequence = parseTaskTextSequence();

function extractTaskId(text) {
  if (!text) return null;
  const match = text.match(/Task assigned to you \(([^)]+)\)/);
  if (!match) return null;
  return match[1]?.trim() || null;
}

function isTaskPrompt(text) {
  if (!text) return false;
  return text.includes('Task assigned to you (')
    || text.includes('You ended the previous turn without clearly finishing the assigned task.');
}

function resolveDelayMs({ inputText, isPlanner }) {
  if (isPlanner) return 0;
  const defaultDelayMs = Number.parseInt(process.env.APP_SERVER_STUB_DELAY_MS ?? '0', 10) || 0;
  const delayMap = parseDelayMap();
  if (!delayMap) return defaultDelayMs;
  const taskId = extractTaskId(inputText);
  if (!taskId) return defaultDelayMs;
  const mapped = delayMap[taskId];
  const value = Number.parseInt(mapped, 10);
  if (Number.isFinite(value) && value >= 0) return value;
  return defaultDelayMs;
}

async function delay(ms) {
  if (!ms || ms <= 0) return;
  await new Promise(resolve => setTimeout(resolve, ms));
}

reader.onMessage(async message => {
  if (!message || typeof message !== 'object') return;

  const { id, method, params } = message;

  if (method === 'initialize') {
    reply(id, {
      protocolVersion: '2025-03-26',
      capabilities: {},
      serverInfo: { name: 'appserver-stub', version: '0.0.0' },
    });
    return;
  }

  if (method === 'thread/start') {
    threadCounter += 1;
    const threadId = `thread-${threadCounter}`;
    reply(id, { thread: { id: threadId } });
    return;
  }

  if (method === 'thread/resume') {
    const threadId = params?.threadId ?? params?.thread_id ?? 'thread-unknown';
    reply(id, { thread: { id: threadId } });
    return;
  }

  if (method === 'turn/start') {
    turnCounter += 1;
    const threadId = params?.threadId ?? 'thread-unknown';
    const turnId = `turn-${turnCounter}`;
    reply(id, { turn: { id: turnId } });

    const inputText = collectInputText(params);
    const isPlanner = isPlannerPrompt(inputText);
    const taskPrompt = !isPlanner && (taskThreadIds.has(threadId) || isTaskPrompt(inputText));
    if (isPlanner) plannerTurnCounter += 1;
    if (taskPrompt) taskThreadIds.add(threadId);
    const delayMs = resolveDelayMs({ inputText, isPlanner });

    const itemId = `agentMessage-${randomUUID()}`;
    notify('item/started', {
      threadId,
      turnId,
      item: { id: itemId, type: 'agentMessage' },
    });

    let text;
    if (isPlanner) {
      text = JSON.stringify(buildPlan());
    } else {
      const overrideText = String(process.env.APP_SERVER_STUB_TASK_TEXT ?? '').trim();
      if (taskPrompt && Array.isArray(taskTextSequence) && taskTextSequence.length > 0) {
        const index = Math.min(taskTurnCounter, taskTextSequence.length - 1);
        taskTurnCounter += 1;
        text = taskTextSequence[index] || `Task complete (${threadId}/${turnId}).`;
      } else {
        text = overrideText || `Task complete (${threadId}/${turnId}).`;
      }
      await delay(delayMs);
    }

    if ((process.env.APP_SERVER_STUB_DELTAS ?? '0') === '1') {
      for (const chunk of [text.slice(0, 20), text.slice(20)]) {
        if (!chunk) continue;
        notify('item/agentMessage/delta', { threadId, turnId, itemId, delta: chunk });
      }
    }

    notify('item/completed', {
      threadId,
      turnId,
      item: { id: itemId, type: 'agentMessage', text },
    });

    notify('turn/completed', {
      threadId,
      turn: { id: turnId, status: 'completed' },
    });
    return;
  }

  if (id !== undefined && id !== null) {
    writeLspMessage(process.stdout, {
      id,
      error: { code: -32601, message: `Unknown method: ${method}` },
    });
  }
});
