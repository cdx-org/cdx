export class LspMessageReader {
  #buffer = Buffer.alloc(0);
  #listeners = new Set();
  #errorListeners = new Set();
  framing = null;

  constructor(stream) {
    stream.setEncoding?.('utf8');
    stream.on('data', chunk => {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(typeof chunk === 'string' ? chunk : String(chunk ?? ''), 'utf8');
      if (!buffer.length) return;

      this.#buffer =
        this.#buffer.length === 0
          ? buffer
          : Buffer.concat([this.#buffer, buffer], this.#buffer.length + buffer.length);

      try {
        this.#drain();
      } catch (error) {
        this.#emitError(error, { kind: 'drain-error' });
        this.#buffer = Buffer.alloc(0);
      }
    });
  }

  onMessage(listener) {
    this.#listeners.add(listener);
  }

  removeListener(listener) {
    this.#listeners.delete(listener);
  }

  onError(listener) {
    this.#errorListeners.add(listener);
  }

  removeErrorListener(listener) {
    this.#errorListeners.delete(listener);
  }

  #emit(message) {
    for (const listener of this.#listeners) {
      listener(message);
    }
  }

  #emitError(error, context) {
    for (const listener of this.#errorListeners) {
      listener(error, context);
    }
  }

  #setFraming(mode) {
    if (!this.framing) this.framing = mode;
  }

  #drainContentLength() {
    if (this.#buffer.length === 0) return undefined;

    const first = this.#buffer[0];
    if (first === 0x7b || first === 0x5b) return undefined;

    const headerEnd =
      this.#buffer.indexOf('\r\n\r\n') !== -1
        ? { index: this.#buffer.indexOf('\r\n\r\n'), sepLength: 4 }
        : this.#buffer.indexOf('\n\n') !== -1
          ? { index: this.#buffer.indexOf('\n\n'), sepLength: 2 }
          : null;

    if (!headerEnd) {
      const newlineIndex = this.#buffer.indexOf(0x0a);
      if (newlineIndex === -1) return null;
      let lineBuffer = this.#buffer.subarray(0, newlineIndex);
      if (lineBuffer.length > 0 && lineBuffer[lineBuffer.length - 1] === 0x0d) {
        lineBuffer = lineBuffer.subarray(0, lineBuffer.length - 1);
      }
      const line = lineBuffer.toString('ascii');
      if (/^[A-Za-z0-9-]+:\s*/.test(line)) {
        const lowered = line.toLowerCase();
        if (lowered.startsWith('content-length:') || lowered.startsWith('content-type:')) {
          return null;
        }
      }
      return undefined;
    }

    const headerText = this.#buffer.subarray(0, headerEnd.index).toString('ascii');
    const lengthMatch = headerText.match(/^Content-Length:\s*(\d+)\s*$/im);
    if (!lengthMatch) {
      this.#emitError(new Error('Invalid header: missing Content-Length'), {
        kind: 'missing-content-length',
        preview: headerText.slice(0, 200),
      });
      const bodyStart = headerEnd.index + headerEnd.sepLength;
      this.#buffer = this.#buffer.subarray(bodyStart);
      return undefined;
    }

    const contentLength = Number.parseInt(lengthMatch[1] ?? '0', 10);
    if (!Number.isFinite(contentLength) || contentLength < 0) {
      this.#emitError(new Error('Invalid Content-Length'), {
        kind: 'invalid-content-length',
        preview: String(lengthMatch[1] ?? '').slice(0, 200),
      });
      const bodyStart = headerEnd.index + headerEnd.sepLength;
      this.#buffer = this.#buffer.subarray(bodyStart);
      return undefined;
    }

    const bodyStart = headerEnd.index + headerEnd.sepLength;
    const bodyEnd = bodyStart + contentLength;
    if (this.#buffer.length < bodyEnd) return null;

    const body = this.#buffer.subarray(bodyStart, bodyEnd).toString('utf8');
    this.#buffer = this.#buffer.subarray(bodyEnd);

    try {
      const payload = JSON.parse(body);
      this.#setFraming('content-length');
      return payload;
    } catch (error) {
      this.#emitError(new Error('Invalid JSON message'), {
        kind: 'invalid-json',
        preview: body.slice(0, 200),
        cause: error instanceof Error ? error.message : String(error ?? ''),
      });
      return undefined;
    }
  }

  #drain() {
    while (true) {
      while (
        this.#buffer.length > 0 &&
        (this.#buffer[0] === 0x0a ||
          this.#buffer[0] === 0x0d ||
          this.#buffer[0] === 0x20 ||
          this.#buffer[0] === 0x09)
      ) {
        this.#buffer = this.#buffer.subarray(1);
      }

      if (this.#buffer.length === 0) break;

      const framed = this.#drainContentLength();
      if (framed === null) break;
      if (framed) {
        this.#emit(framed);
        continue;
      }

      const newlineIndex = this.#buffer.indexOf(0x0a);
      if (newlineIndex === -1) break;

      let lineBuffer = this.#buffer.subarray(0, newlineIndex);
      this.#buffer = this.#buffer.subarray(newlineIndex + 1);
      if (lineBuffer.length > 0 && lineBuffer[lineBuffer.length - 1] === 0x0d) {
        lineBuffer = lineBuffer.subarray(0, lineBuffer.length - 1);
      }

      const line = lineBuffer.toString('utf8');
      if (!line.trim()) continue;

      try {
        const payload = JSON.parse(line);
        this.#setFraming('newline');
        this.#emit(payload);
      } catch (error) {
        this.#emitError(new Error('Invalid JSON message'), {
          kind: 'invalid-json',
          preview: line.slice(0, 200),
          cause: error instanceof Error ? error.message : String(error ?? ''),
        });
      }
    }
  }
}

export function createLspMessageReader(stream) {
  return new LspMessageReader(stream);
}

export function writeLspMessage(stream, payload, { framing } = {}) {
  const mode = framing === 'content-length' ? 'content-length' : 'newline';
  const json = JSON.stringify(payload);

  if (mode === 'content-length') {
    const body = Buffer.from(json, 'utf8');
    stream.write(`Content-Length: ${body.length}\r\n\r\n`);
    stream.write(body);
    return;
  }

  stream.write(`${json}\n`);
}

export function writeJsonRpcRequest(stream, id, method, params, options = {}) {
  writeLspMessage(stream, { jsonrpc: '2.0', id, method, params }, options);
}

export function writeJsonRpcResult(stream, id, result, options = {}) {
  if (id === undefined || id === null) return;
  writeLspMessage(stream, { jsonrpc: '2.0', id, result }, options);
}

export function writeJsonRpcError(stream, id, code, message, options = {}) {
  if (id === undefined || id === null) return;
  writeLspMessage(stream, { jsonrpc: '2.0', id, error: { code, message } }, options);
}

export function writeJsonRpcNotification(stream, method, params, options = {}) {
  writeLspMessage(stream, { jsonrpc: '2.0', method, params }, options);
}
