function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class RingBuffer {
  constructor({ maxItems = 200, maxBytes = 64 * 1024 } = {}) {
    this.maxItems = Math.max(1, Number.parseInt(maxItems, 10) || 200);
    this.maxBytes = Math.max(1024, Number.parseInt(maxBytes, 10) || 64 * 1024);
    this.items = [];
    this.bytes = 0;
  }

  push(item) {
    const serialized = JSON.stringify(item);
    const size = Buffer.byteLength(serialized, 'utf8');
    this.items.push(item);
    this.bytes += size;

    while (this.items.length > this.maxItems || this.bytes > this.maxBytes) {
      const removed = this.items.shift();
      if (removed === undefined) break;
      this.bytes -= Buffer.byteLength(JSON.stringify(removed), 'utf8');
    }
  }

  toArray() {
    return this.items.slice();
  }
}

export class ContextStore {
  constructor({ runId, maxItemsPerTask, maxBytesPerTask } = {}) {
    this.runId = runId ?? null;
    this.maxItemsPerTask = maxItemsPerTask ?? 500;
    this.maxBytesPerTask = maxBytesPerTask ?? 256 * 1024;
    this.tasks = new Map(); // taskId -> { text, events, prompts }
  }

  ensureTask(taskId) {
    if (!taskId) return null;
    let entry = this.tasks.get(taskId);
    if (!entry) {
      entry = {
        text: '',
        events: new RingBuffer({
          maxItems: this.maxItemsPerTask,
          maxBytes: this.maxBytesPerTask,
        }),
        prompts: new RingBuffer({
          maxItems: Math.max(8, Math.min(32, Math.floor(this.maxItemsPerTask / 8))),
          maxBytes: Math.max(8 * 1024, Math.floor(this.maxBytesPerTask / 8)),
        }),
      };
      this.tasks.set(taskId, entry);
    }
    return entry;
  }

  recordPrompt({ taskId, agentId, phase, threadId, text, timestamp }) {
    const entry = this.ensureTask(taskId);
    if (!entry) return;
    const promptText = typeof text === 'string' ? text.trim() : '';
    if (!promptText) return;
    entry.prompts.push({
      ts: timestamp ?? new Date().toISOString(),
      kind: 'prompt',
      phase: phase ?? null,
      agentId: agentId ?? null,
      threadId: threadId ?? null,
      text: promptText,
    });
  }

  record({ taskId, agentId, phase, method, params, timestamp }) {
    const entry = this.ensureTask(taskId);
    if (!entry) return;

    const ts = timestamp ?? new Date().toISOString();

    if (method === 'item/agentMessage/delta') {
      const delta = typeof params?.delta === 'string' ? params.delta : '';
      if (delta) {
        entry.text += delta;
        const maxTextBytes = 128 * 1024;
        if (Buffer.byteLength(entry.text, 'utf8') > maxTextBytes) {
          entry.text = entry.text.slice(Math.max(0, entry.text.length - 64 * 1024));
        }
      }
    }

    if (method === 'item/started' || method === 'item/completed') {
      const item = params?.item;
      if (isObject(item)) {
        const type = item.type ?? 'unknown';
        if (type === 'commandExecution') {
          entry.events.push({
            ts,
            kind: 'command',
            phase: phase ?? null,
            agentId: agentId ?? null,
            command: item.command ?? null,
            status: item.status ?? null,
            exitCode: item.exitCode ?? null,
            method,
          });
        } else if (type === 'fileChange') {
          const files = Array.isArray(item.changes)
            ? item.changes.map(change => change?.path).filter(Boolean)
            : [];
          entry.events.push({
            ts,
            kind: 'fileChange',
            phase: phase ?? null,
            agentId: agentId ?? null,
            files,
            status: item.status ?? null,
            method,
          });
        } else if (type === 'mcpToolCall') {
          entry.events.push({
            ts,
            kind: 'mcpToolCall',
            phase: phase ?? null,
            agentId: agentId ?? null,
            server: item.server ?? null,
            tool: item.tool ?? null,
            status: item.status ?? null,
            method,
          });
        }
      }
    }

    if (method === 'turn/completed') {
      entry.events.push({
        ts,
        kind: 'turn',
        phase: phase ?? null,
        agentId: agentId ?? null,
        status: params?.turn?.status ?? params?.status ?? null,
      });
    }
  }

  snapshot(taskId) {
    const entry = this.ensureTask(taskId);
    if (!entry) {
      return {
        runId: this.runId,
        taskId,
        recentText: '',
        recentEvents: [],
        recentPrompts: [],
      };
    }
    return {
      runId: this.runId,
      taskId,
      recentText: entry.text,
      recentEvents: entry.events.toArray(),
      recentPrompts: entry.prompts.toArray(),
    };
  }
}
