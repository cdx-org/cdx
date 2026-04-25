import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasClassAttribute,
  hasId,
  parseArgs,
  runCdxStatsDashboardSmoke,
} from '../../scripts/smoke-cdx-stats-dashboard.js';

const VALID_HTML = `
<!doctype html>
<html>
  <head>
    <title>CDX Stats</title>
    <style>
      .dashboard-sidebar {}
      .dashboard-main {}
      .card-flex {}
      .body-scroll {}
      .panel {}
      .worktree-pane {}
      .task-dag-table {}
    </style>
  </head>
  <body class="layout dashboard-layout body-scroll">
    <section class="card dashboard-sidebar dashboard-watchdog-panel"></section>
    <main class="card dashboard-main"></main>
    <div id="statusRun"></div>
    <div id="statusWait"></div>
    <div id="cardHeroTitle"></div>
    <div id="agents"></div>
    <div id="tasks"></div>
    <div id="taskDagCard"></div>
    <div id="taskDagTitle"></div>
    <div id="taskDagMeta"></div>
    <table id="testTaskDagTable"></table>
    <div id="worktreeGraphCard"></div>
    <button id="tabLogs"></button>
    <button id="tabWorktree"></button>
    <div id="logbox"></div>
    <div id="tree"></div>
    <div id="file"></div>
    <div id="gitStatus"></div>
  </body>
</html>
`;

class FakeStatsServer {
  async ensureStarted() {
    return 'http://example.invalid';
  }
}

test('parseArgs accepts verbose and require-new-layout flags', () => {
  assert.deepEqual(parseArgs(['--verbose', '--require-new-layout', '--timeout-ms=3210']), {
    requireNewLayout: true,
    timeoutMs: 3210,
    verbose: true,
  });
});

test('HTML helpers detect expected ids and classes', () => {
  assert.equal(hasId(VALID_HTML, 'statusRun'), true);
  assert.equal(hasClassAttribute(VALID_HTML, 'dashboard-watchdog-panel'), true);
  assert.equal(hasClassAttribute(VALID_HTML, 'missing-class'), false);
});

test('runCdxStatsDashboardSmoke validates the rendered dashboard markup', async () => {
  await runCdxStatsDashboardSmoke({
    CdxStatsServer: FakeStatsServer,
    requireNewLayout: true,
    timeoutMs: 5000,
    fetchHtml: async () => ({
      statusCode: 200,
      body: VALID_HTML,
    }),
  });
});

test('runCdxStatsDashboardSmoke fails when required markup is missing', async () => {
  await assert.rejects(
    runCdxStatsDashboardSmoke({
      CdxStatsServer: FakeStatsServer,
      timeoutMs: 3000,
      fetchHtml: async () => ({
        statusCode: 200,
        body: '<html><body>missing expected markup</body></html>',
      }),
    }),
    /Missing expected title text|Missing required element id=/,
  );
});
