import { normalizeToolResultResponseMessage } from './mcp-response-normalization.js';

export class LspMessageReader {
  #buffer = Buffer.alloc(0);
  #listeners = new Set();
  #errorListeners = new Set();
  framing = null; // 'newline' | 'content-length'
  constructor(stream) {
    stream.setEncoding?.('utf8');
    stream.on('data', chunk => {
      const buf = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(typeof chunk === 'string' ? chunk : String(chunk ?? ''), 'utf8');
      if (!buf.length) return;

      this.#buffer =
        this.#buffer.length === 0 ? buf : Buffer.concat([this.#buffer, buf], this.#buffer.length + buf.length);
      try {
        this.#drain();
      } catch (err) {
        this.#emitError(err, { kind: 'drain-error' });
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
    if (this.framing) return;
    this.framing = mode;
  }

  #drainContentLength() {
    if (this.#buffer.length === 0) return undefined;

    const first = this.#buffer[0];
    if (first === 0x7b || first === 0x5b) {
      // Likely newline-framed JSON.
      return undefined;
    }

    const headerEnd =
      this.#buffer.indexOf('\r\n\r\n') !== -1
        ? { index: this.#buffer.indexOf('\r\n\r\n'), sepLength: 4 }
        : this.#buffer.indexOf('\n\n') !== -1
          ? { index: this.#buffer.indexOf('\n\n'), sepLength: 2 }
          : null;

    if (!headerEnd) {
      const newlineIndex = this.#buffer.indexOf(0x0a);
      if (newlineIndex === -1) return null;
      let lineBuf = this.#buffer.subarray(0, newlineIndex);
      if (lineBuf.length > 0 && lineBuf[lineBuf.length - 1] === 0x0d) {
        lineBuf = lineBuf.subarray(0, lineBuf.length - 1);
      }
      const line = lineBuf.toString('ascii');
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
    } catch (err) {
      this.#emitError(new Error('Invalid JSON message'), {
        kind: 'invalid-json',
        preview: body.slice(0, 200),
        cause: err instanceof Error ? err.message : String(err ?? ''),
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

      let lineBuf = this.#buffer.subarray(0, newlineIndex);
      this.#buffer = this.#buffer.subarray(newlineIndex + 1);
      if (lineBuf.length > 0 && lineBuf[lineBuf.length - 1] === 0x0d) {
        lineBuf = lineBuf.subarray(0, lineBuf.length - 1);
      }

      const line = lineBuf.toString('utf8');
      if (!line.trim()) continue;

      try {
        const payload = JSON.parse(line);
        this.#setFraming('newline');
        this.#emit(payload);
      } catch (err) {
        this.#emitError(new Error('Invalid JSON message'), {
          kind: 'invalid-json',
          preview: line.slice(0, 200),
          cause: err instanceof Error ? err.message : String(err ?? ''),
        });
      }
    }
  }
}

export function writeLspMessage(stream, payload, { framing } = {}) {
  const mode = framing === 'content-length' ? 'content-length' : 'newline';
  const normalizedPayload = normalizeToolResultResponseMessage(payload);
  const json = JSON.stringify(normalizedPayload);
  if (mode === 'content-length') {
    const body = Buffer.from(json, 'utf8');
    stream.write(`Content-Length: ${body.length}\r\n\r\n`);
    stream.write(body);
    return;
  }
  stream.write(`${json}\n`);
}
