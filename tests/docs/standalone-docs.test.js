import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('standalone docs describe local mcp-cdx install and layout', () => {
  const usage = readRepoFile('docs/standalone-usage.md');
  const layout = readRepoFile('docs/repository-layout.md');
  const otlp = readRepoFile('docs/otlp-ingest.md');
  const cliNotes = readRepoFile('src/cli/README.md');

  assert.match(usage, /standalone `mcp-cdx`/i);
  assert.match(usage, /\.\/install\.sh install/);
  assert.match(usage, /src\/cli\/cdx-appserver-mcp-server\.js/);
  assert.match(usage, /cdx\.help/);

  assert.match(layout, /src\/runtime\/prompt-templates\.js/);
  assert.match(layout, /standalone package and repository names are `mcp-cdx`/i);
  assert.match(cliNotes, /package as `mcp-cdx` consistently/i);
  assert.match(cliNotes, /`checklist mode` over legacy wording/i);
  assert.doesNotMatch(usage, /mcp-keepdoing/);
  assert.doesNotMatch(cliNotes, /mcp-keepdoing/);

  assert.match(otlp, /OTLP ingest \(CDX stats\)/);
  assert.match(otlp, /npm run start:cdx-appserver/);
});

test('compatibility docs capture retained aliases and standalone deviations', () => {
  const compatibility = readRepoFile('docs/compatibility.md');

  assert.match(compatibility, /default installed MCP entry remains `cdx`/i);
  assert.match(compatibility, /alias of `cdx\.spawn`/i);
  assert.match(compatibility, /defaults to `\.keepdoing`/i);
  assert.match(compatibility, /MCP_ALIAS_NAMES/);
  assert.match(compatibility, /MCP_LEGACY_NAMES/);
  assert.match(compatibility, /`mcp-cdx` consistently/);
  assert.doesNotMatch(compatibility, /mcp-keepdoing/);
});

test('CLI help wording uses standalone terminology when the app-server entrypoint is present', t => {
  const appServerPath = path.join(repoRoot, 'src', 'cli', 'cdx-appserver-mcp-server.js');
  if (!fs.existsSync(appServerPath)) {
    t.skip('src/cli/cdx-appserver-mcp-server.js is not present in this task worktree');
    return;
  }

  const text = fs.readFileSync(appServerPath, 'utf8');
  assert.match(text, /CDX MCP tools/);
  assert.doesNotMatch(text, /mcp-keepdoing/);
  assert.doesNotMatch(text, /for keepdoing mode/);
});

test('install help exposes compatibility aliases without old package naming when installer is present', t => {
  const installerPath = path.join(repoRoot, 'src', 'install', 'cli.js');
  if (!fs.existsSync(installerPath)) {
    t.skip('src/install/cli.js is not present in this task worktree');
    return;
  }

  const output = execFileSync(process.execPath, [installerPath, 'help'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  assert.match(output, /Usage: \.\/install\.sh <command>/);
  assert.match(output, /Installs the standalone mcp-cdx app-server into Codex\./);
  assert.match(
    output,
    /The package\/repo name is mcp-cdx; the default MCP server name remains cdx\./,
  );
  assert.match(output, /MCP_ALIAS_NAMES/);
  assert.match(output, /MCP_LEGACY_NAMES/);
  assert.match(output, /MCP_REMOVE_LEGACY_NAMES/);
  assert.doesNotMatch(output, /mcp-keepdoing/);
});
