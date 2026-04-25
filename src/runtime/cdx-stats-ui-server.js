import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { INDEX_HTML } from './cdx-stats-server.js';

function sendText(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.statusCode = status;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

function trimTrailingSlash(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return text.endsWith('/') ? text.slice(0, -1) : text;
}

function proxyClientFor(url) {
  return url.protocol === 'https:' ? https : http;
}

export class CdxStatsUiServer {
  constructor({
    enabled = true,
    host = process.env.CDX_STATS_UI_HOST ?? '127.0.0.1',
    port = Number.parseInt(process.env.CDX_STATS_UI_PORT ?? '0', 10) || 0,
    targetBaseUrl = process.env.CDX_STATS_UI_TARGET ?? '',
    log = () => {},
  } = {}) {
    this.enabled = enabled;
    this.host = host;
    this.port = port;
    this.targetBaseUrl = trimTrailingSlash(targetBaseUrl);
    this.log = log;
    this.httpServer = null;
    this.url = null;
  }

  async ensureStarted() {
    if (!this.enabled) return null;
    if (!this.targetBaseUrl) {
      throw new Error('CDX stats UI target base URL is required.');
    }
    if (this.httpServer) {
      return this.url;
    }

    this.httpServer = http.createServer((req, res) => {
      this.#handleRequest(req, res).catch(err => {
        const message = err instanceof Error ? err.message : String(err ?? 'unknown_error');
        sendText(res, 500, message);
      });
    });

    await new Promise((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen(this.port, this.host, () => {
        this.httpServer.off('error', reject);
        resolve();
      });
    });

    const address = this.httpServer.address();
    const resolvedPort = typeof address === 'object' && address ? address.port : this.port;
    this.url = `http://${this.host}:${resolvedPort}/`;
    this.log(`Stats UI: ${this.url} (proxy -> ${this.targetBaseUrl})`);
    return this.url;
  }

  async stop() {
    const server = this.httpServer;
    if (!server) return;

    this.httpServer = null;
    this.url = null;

    await new Promise(resolve => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  async #handleRequest(req, res) {
    const method = (req.method ?? 'GET').toUpperCase();
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (method === 'GET' && url.pathname === '/') {
      sendText(res, 200, INDEX_HTML, 'text/html; charset=utf-8');
      return;
    }

    if (method === 'GET' && url.pathname === '/favicon.ico') {
      res.statusCode = 204;
      res.setHeader('Cache-Control', 'no-store');
      res.end();
      return;
    }

    await this.#proxyRequest(req, res);
  }

  async #proxyRequest(req, res) {
    if (!this.targetBaseUrl) {
      sendText(res, 503, 'Stats API target is unavailable.');
      return;
    }

    const target = new URL(req.url ?? '/', `${this.targetBaseUrl}/`);
    const client = proxyClientFor(target);
    const headers = { ...req.headers, host: target.host };

    await new Promise((resolve, reject) => {
      const upstream = client.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port,
          method: req.method,
          path: `${target.pathname}${target.search}`,
          headers,
        },
        upstreamRes => {
          if (!res.headersSent) {
            res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          }
          upstreamRes.pipe(res);
          upstreamRes.on('end', resolve);
          upstreamRes.on('error', reject);
        },
      );

      upstream.on('error', err => {
        if (!res.headersSent) {
          sendText(res, 502, err instanceof Error ? err.message : String(err ?? 'proxy_failed'));
          resolve();
          return;
        }
        reject(err);
      });

      req.on('aborted', () => upstream.destroy());
      req.on('error', err => upstream.destroy(err));
      res.on('close', () => {
        if (!upstream.destroyed && !upstream.writableEnded) {
          upstream.destroy();
        }
      });

      req.pipe(upstream);
    });
  }
}

export function createCdxStatsUiServerFromEnv({
  enabled = true,
  log = message => {
    if (!message) return;
    process.stderr.write(`${String(message)}\n`);
  },
} = {}) {
  return new CdxStatsUiServer({
    enabled,
    host: process.env.CDX_STATS_UI_HOST ?? '127.0.0.1',
    port: Number.parseInt(process.env.CDX_STATS_UI_PORT ?? '0', 10) || 0,
    targetBaseUrl: process.env.CDX_STATS_UI_TARGET ?? '',
    log,
  });
}

function startOrphanExitWatcher() {
  const orphanCheck = setInterval(() => {
    if (process.ppid === 1) {
      process.exit(0);
    }
  }, 2000);
  orphanCheck.unref?.();
  return orphanCheck;
}

export async function runCdxStatsUiServerCli() {
  const server = createCdxStatsUiServerFromEnv();
  const orphanCheck = startOrphanExitWatcher();

  const shutdown = async code => {
    clearInterval(orphanCheck);
    await server.stop().catch(() => {});
    process.exit(code);
  };

  process.on('SIGINT', () => {
    shutdown(130).catch(() => process.exit(130));
  });
  process.on('SIGTERM', () => {
    shutdown(0).catch(() => process.exit(0));
  });

  const url = await server.ensureStarted();
  process.stdout.write(`CDX_STATS_UI_URL=${url}\n`);
}

function isDirectRun(metaUrl) {
  if (!process.argv[1]) return false;
  return fileURLToPath(metaUrl) === path.resolve(process.argv[1]);
}

if (isDirectRun(import.meta.url)) {
  runCdxStatsUiServerCli().catch(err => {
    const message = err instanceof Error ? err.message : String(err ?? 'start_failed');
    process.stderr.write(`Failed to start stats UI server: ${message}\n`);
    process.exit(1);
  });
}
