import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DISALLOWED_LAYOUT_PATHS,
  EXPECTED_INSTALLER_ENTRY,
  EXPECTED_PACKAGE_NAME,
  EXPECTED_PRIMARY_MCP_NAME,
  EXPECTED_RUNTIME_ENTRY,
  assertStandaloneProject,
  auditStandaloneProject,
  formatStandaloneAudit,
} from '../../tools/scripts/standalone-self-containment.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function writeFixtureFile(rootDir, relativePath, content) {
  const targetPath = path.join(rootDir, relativePath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, 'utf8');
}

test('standalone audit helper accepts a minimal self-contained fixture', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cdx-standalone-ok-'));

  try {
    await writeFixtureFile(
      tempRoot,
      'package.json',
      JSON.stringify(
        {
          name: EXPECTED_PACKAGE_NAME,
          scripts: {
            'start:cdx-appserver': `node ${EXPECTED_RUNTIME_ENTRY}`,
          },
        },
        null,
        2,
      ),
    );
    await writeFixtureFile(
      tempRoot,
      'install.sh',
      `#!/usr/bin/env bash
set -euo pipefail
PROJECT_DIR="\${PROJECT_DIR:-/tmp/cdx}"
exec node "$PROJECT_DIR/${EXPECTED_INSTALLER_ENTRY}" "$@"
`,
    );
    await chmod(path.join(tempRoot, 'install.sh'), 0o755);
    await writeFixtureFile(
      tempRoot,
      EXPECTED_INSTALLER_ENTRY,
      `const PACKAGE_NAME = '${EXPECTED_PACKAGE_NAME}';
const DEFAULT_MCP_NAME = '${EXPECTED_PRIMARY_MCP_NAME}';
const DEFAULT_ENTRY_RELATIVE_PATH = '${EXPECTED_RUNTIME_ENTRY}';

export function usage() {
  return 'Usage: ./install.sh <command>';
}
`,
    );

    const result = await auditStandaloneProject({
      rootDir: tempRoot,
      requiredPaths: ['install.sh', 'package.json', EXPECTED_INSTALLER_ENTRY],
      scanRoots: ['install.sh', 'package.json', 'src/install'],
    });

    assert.equal(result.hasIssues, false, formatStandaloneAudit(result));
    assert.deepEqual(result.missingPaths, []);
    assert.deepEqual(result.nonExecutablePaths, []);
    assert.deepEqual(result.packageIssues, []);
    assert.deepEqual(result.installerIssues, []);
    assert.deepEqual(result.presentDisallowedPaths, []);
    assert.deepEqual(result.sourceLeakMatches, []);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('standalone audit helper reports missing files, install drift, and source leaks', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cdx-standalone-bad-'));

  try {
    await writeFixtureFile(
      tempRoot,
      'package.json',
      JSON.stringify(
        {
          name: 'mcp-keepdoing',
          scripts: {
            'start:cdx-appserver': 'node /Users/hancho01/git/mcp-keepdoing/src/cli/cdx-appserver-mcp-server.js',
          },
        },
        null,
        2,
      ),
    );
    await writeFixtureFile(
      tempRoot,
      'install.sh',
      `#!/usr/bin/env bash
set -euo pipefail
exec node /Users/hancho01/git/mcp-keepdoing/src/install/cli.js "$@"
`,
    );
    await writeFixtureFile(tempRoot, 'src/lib/ghost.js', 'export const ghost = true;\n');

    const result = await auditStandaloneProject({
      rootDir: tempRoot,
      requiredPaths: ['install.sh', 'package.json', EXPECTED_INSTALLER_ENTRY],
      scanRoots: ['install.sh', 'package.json'],
    });

    assert.equal(result.hasIssues, true);
    assert.deepEqual(result.missingPaths, [EXPECTED_INSTALLER_ENTRY]);
    assert.deepEqual(result.nonExecutablePaths, process.platform === 'win32' ? [] : ['install.sh']);
    assert.deepEqual(result.presentDisallowedPaths, [...DISALLOWED_LAYOUT_PATHS.filter(path => path === 'src/lib')]);
    assert.match(result.packageIssues.join('\n'), /package\.json name should be "mcp-cdx"/);
    assert.match(
      result.installerIssues.join('\n'),
      /install\.sh should resolve the installer from PROJECT_DIR/,
    );
    assert.match(
      result.issues.join('\n'),
      /remove redundant compatibility path: src\/lib/,
    );
    assert.ok(
      result.sourceLeakMatches.some(match => match.relativePath === 'install.sh'),
      `expected install.sh leak in audit result:\n${formatStandaloneAudit(result)}`,
    );
    assert.ok(
      result.sourceLeakMatches.some(match => match.relativePath === 'package.json'),
      `expected package.json leak in audit result:\n${formatStandaloneAudit(result)}`,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('standalone repo keeps the required copied surface and no source-tree dependencies', async () => {
  await assertStandaloneProject({ rootDir: ROOT_DIR });
});
