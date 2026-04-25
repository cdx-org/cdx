#!/usr/bin/env node
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const DEFAULT_TIMEOUT_MS = 15_000;

export function parseArgs(argv) {
  const options = {
    requireNewLayout: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    verbose: false,
  };

  for (const arg of argv) {
    if (arg === '--require-new-layout') {
      options.requireNewLayout = true;
      continue;
    }
    if (arg === '--verbose') {
      options.verbose = true;
      continue;
    }
    if (arg.startsWith('--timeout-ms=')) {
      const value = Number.parseInt(arg.slice('--timeout-ms='.length), 10);
      if (Number.isFinite(value) && value > 0) {
        options.timeoutMs = value;
        continue;
      }
      throw new Error(`Invalid timeout: ${arg}`);
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

export function printHelp() {
  console.log(`CDX Stats dashboard smoke test

Usage:
  node scripts/smoke-cdx-stats-dashboard.js [--require-new-layout] [--timeout-ms=15000] [--verbose]

Options:
  --require-new-layout   Also require new layout helper classes to appear in HTML markup (class="...").
  --timeout-ms=MS        Overall timeout for the HTTP request (default: 15000).
  --verbose              Print extra logs.
`);
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function hasId(html, id) {
  const pattern = new RegExp(`\\bid\\s*=\\s*["']${escapeRegExp(id)}["']`, 'i');
  return pattern.test(html);
}

export function hasClassAttribute(html, className) {
  const pattern = new RegExp(
    `\\bclass\\s*=\\s*["'][^"']*\\b${escapeRegExp(className)}\\b[^"']*["']`,
    'i',
  );
  return pattern.test(html);
}

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function httpGetText(url, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => {
      const chunks = [];
      response.setEncoding('utf8');
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers ?? {},
          body: chunks.join(''),
        });
      });
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });
    request.on('error', reject);
  });
}

async function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function closeServer(server) {
  if (!server) return;
  try {
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(() => resolve()));
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ERR_SERVER_NOT_RUNNING') return;
    throw error;
  }
}

async function waitForHtml(url, { timeoutMs, verbose }) {
  const start = Date.now();
  let lastError = null;

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await httpGetText(url, { timeoutMs: Math.min(2000, timeoutMs) });
      if (response.statusCode === 200 && typeof response.body === 'string' && response.body.length > 0) {
        return response;
      }
      lastError = new Error(`Unexpected response: status=${response.statusCode}`);
    } catch (error) {
      lastError = error;
    }

    if (verbose) {
      const message =
        lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown_error');
      console.error(`[smoke] retrying: ${message}`);
    }

    await sleep(200);
  }

  throw lastError instanceof Error ? lastError : new Error('Failed to fetch HTML');
}

async function loadCdxStatsServer() {
  const moduleUrl = new URL('../src/runtime/cdx-stats-server.js', import.meta.url);
  const module = await import(moduleUrl);
  if (typeof module.CdxStatsServer !== 'function') {
    throw new Error('src/runtime/cdx-stats-server.js does not export CdxStatsServer');
  }
  return module.CdxStatsServer;
}

export async function runCdxStatsDashboardSmoke({
  requireNewLayout = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  verbose = false,
  CdxStatsServer = null,
  fetchHtml = null,
} = {}) {
  const StatsServer = CdxStatsServer ?? (await loadCdxStatsServer());
  const previousAutoOpen = process.env.CDX_STATS_AUTO_OPEN;
  process.env.CDX_STATS_AUTO_OPEN = '0';

  const stats = new StatsServer({
    enabled: true,
    host: '127.0.0.1',
    port: 0,
    log: message => {
      if (verbose) {
        console.error(`[stats] ${message}`);
      }
    },
  });

  try {
    const url = await withTimeout(stats.ensureStarted(), timeoutMs, 'Server start');
    assertCondition(typeof url === 'string' && url.startsWith('http'), 'Stats server did not return a URL');

    const response = await withTimeout(
      (fetchHtml ?? waitForHtml)(url, { timeoutMs, verbose }),
      timeoutMs,
      'Fetch HTML',
    );
    const html = response.body;

    assertCondition(html.includes('CDX Stats'), 'Missing expected title text: "CDX Stats"');

    const requiredIds = [
      'statusRun',
      'statusWait',
      'cardHeroTitle',
      'agents',
      'tasks',
      'taskDagCard',
      'taskDagTitle',
      'taskDagMeta',
      'testTaskDagTable',
      'worktreeGraphCard',
      'tabLogs',
      'tabWorktree',
      'logbox',
      'tree',
      'file',
      'gitStatus',
    ];
    for (const id of requiredIds) {
      assertCondition(hasId(html, id), `Missing required element id="${id}"`);
    }

    const requiredCssSelectors = [
      '.dashboard-sidebar',
      '.dashboard-main',
      '.card-flex',
      '.body-scroll',
      '.panel',
      '.worktree-pane',
      '.task-dag-table',
    ];
    for (const selector of requiredCssSelectors) {
      assertCondition(html.includes(selector), `Missing required CSS selector: ${selector}`);
    }

    const requiredClassesInMarkup = ['layout', 'card', 'dashboard-sidebar', 'dashboard-main'];
    for (const className of requiredClassesInMarkup) {
      assertCondition(
        hasClassAttribute(html, className),
        `Missing required class in HTML markup: ${className}`,
      );
    }

    if (requireNewLayout) {
      const newLayoutClasses = [
        'dashboard-layout',
        'dashboard-sidebar',
        'dashboard-watchdog-panel',
        'dashboard-main',
      ];
      for (const className of newLayoutClasses) {
        assertCondition(
          hasClassAttribute(html, className),
          `Missing new-layout class in HTML markup: ${className}`,
        );
      }
    }

    if (verbose) {
      console.error(`[smoke] OK: ${url}`);
    }
  } finally {
    await closeServer(stats.httpServer);
    if (previousAutoOpen === undefined) {
      delete process.env.CDX_STATS_AUTO_OPEN;
    } else {
      process.env.CDX_STATS_AUTO_OPEN = previousAutoOpen;
    }
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  await runCdxStatsDashboardSmoke(options);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
