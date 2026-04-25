import { constants } from 'node:fs';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_REPO_NAME = `mcp-${'keepdoing'}`;

export const SOURCE_REPO_ROOT = `/Users/hancho01/git/${SOURCE_REPO_NAME}`;
export const EXPECTED_PACKAGE_NAME = 'mcp-cdx';
export const EXPECTED_PRIMARY_MCP_NAME = 'cdx';
export const EXPECTED_RUNTIME_ENTRY = 'src/cli/cdx-appserver-mcp-server.js';
export const EXPECTED_INSTALLER_ENTRY = 'src/install/cli.js';

export const REQUIRED_ROOT_FILES = Object.freeze([
  'install.sh',
  'package.json',
  'package-lock.json',
]);

export const REQUIRED_INSTALL_FILES = Object.freeze([
  'src/install/cli.js',
]);

export const REQUIRED_CLI_FILES = Object.freeze([
  'src/cli/bridge.js',
  'src/cli/cdx-appserver-mcp-server.js',
  'src/cli/cdx-mcp-server.js',
  'src/cli/hook-llm-backend.js',
  'src/cli/orchestrator.js',
  'src/cli/server.js',
]);

export const REQUIRED_RUNTIME_FILES = Object.freeze([
  'src/runtime/app-server-client.js',
  'src/runtime/broker-bridge.js',
  'src/runtime/broker-server.js',
  'src/runtime/broker-session.js',
  'src/runtime/cdx-stats-dashboard-cards.js',
  'src/runtime/cdx-stats-server.js',
  'src/runtime/cdx-stats-ui-server.js',
  'src/runtime/checklist-mode.js',
  'src/runtime/codex-config.js',
  'src/runtime/context-store.js',
  'src/runtime/git-worktree.js',
  'src/runtime/hook-backend-client.js',
  'src/runtime/judge-output-schema.json',
  'src/runtime/judge-service.js',
  'src/runtime/lsp.js',
  'src/runtime/mcp-response-normalization.js',
  'src/runtime/merge-conflict.js',
  'src/runtime/openai-pricing.js',
  'src/runtime/openai-proxy-client.js',
  'src/runtime/prompt-templates.js',
  'src/runtime/repo-index.js',
  'src/runtime/router-server.js',
  'src/runtime/watchdog-intervention.js',
  'src/runtime/worktree-resources.js',
]);

export const REQUIRED_SKILL_FILES = Object.freeze([
  'src/skills/manifest.mjs',
  'skills/cdx-preflight/SKILL.md',
  'skills/cdx-wait-controller/SKILL.md',
]);

export const REQUIRED_DOC_FILES = Object.freeze([
  'docs/install-metadata.md',
  'docs/repository-layout.md',
  'docs/runtime-prompt-templates.md',
  'docs/skills.md',
]);

export const DISALLOWED_LAYOUT_PATHS = Object.freeze([
  'src/app',
  'src/apps',
  'src/lib',
]);

export const REQUIRED_STANDALONE_PATHS = Object.freeze([
  ...REQUIRED_ROOT_FILES,
  ...REQUIRED_INSTALL_FILES,
  ...REQUIRED_CLI_FILES,
  ...REQUIRED_RUNTIME_FILES,
  ...REQUIRED_SKILL_FILES,
  ...REQUIRED_DOC_FILES,
]);

export const REQUIRED_EXECUTABLE_PATHS = Object.freeze([
  'install.sh',
]);

export const TEXT_AUDIT_ROOTS = Object.freeze([
  'install.sh',
  'package.json',
  'package-lock.json',
  'docs',
  'scripts',
  'skills',
  'src/cli',
  'src/install',
  'src/runtime',
  'src/skills',
]);

function escapeRegExp(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SOURCE_REPO_ROOT_PATTERN = new RegExp(escapeRegExp(SOURCE_REPO_ROOT));
const SOURCE_REPO_NAME_PATTERN = new RegExp(`\\b${escapeRegExp(SOURCE_REPO_NAME)}\\b`);
const ALLOWED_SOURCE_TOKEN_REFERENCES = new Map([
  ['src/skills/manifest.mjs', new Set([SOURCE_REPO_NAME])],
]);

function isTextAuditFile(filePath) {
  const baseName = path.basename(filePath);
  if (baseName === 'install.sh' || baseName === 'package.json' || baseName === 'package-lock.json') {
    return true;
  }

  return /\.(?:cjs|js|json|md|mjs|sh|toml|txt|ya?ml)$/i.test(baseName);
}

async function pathExists(targetPath) {
  try {
    await access(targetPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readTextIfExists(rootDir, relativePath) {
  const absolutePath = path.join(rootDir, relativePath);
  if (!(await pathExists(absolutePath))) return null;
  return readFile(absolutePath, 'utf8');
}

async function listFilesRecursive(rootDir, relativeRoot) {
  const absoluteRoot = path.join(rootDir, relativeRoot);
  if (!(await pathExists(absoluteRoot))) return [];

  const rootStat = await stat(absoluteRoot);
  if (rootStat.isFile()) {
    return isTextAuditFile(relativeRoot) ? [relativeRoot] : [];
  }
  if (!rootStat.isDirectory()) return [];

  const results = [];
  const queue = [relativeRoot];

  while (queue.length > 0) {
    const current = queue.pop();
    const currentPath = path.join(rootDir, current);
    const entries = await readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryRelativePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryRelativePath);
        continue;
      }
      if (entry.isFile() && isTextAuditFile(entryRelativePath)) {
        results.push(entryRelativePath);
      }
    }
  }

  return results.sort((left, right) => left.localeCompare(right));
}

async function collectAuditFiles(rootDir, scanRoots) {
  const files = new Set();
  for (const relativeRoot of scanRoots) {
    for (const relativePath of await listFilesRecursive(rootDir, relativeRoot)) {
      files.add(relativePath);
    }
  }
  return [...files].sort((left, right) => left.localeCompare(right));
}

async function findMissingPaths(rootDir, requiredPaths) {
  const missingPaths = [];
  for (const relativePath of requiredPaths) {
    if (!(await pathExists(path.join(rootDir, relativePath)))) {
      missingPaths.push(relativePath);
    }
  }
  return missingPaths;
}

async function findNonExecutablePaths(rootDir, executablePaths) {
  const nonExecutablePaths = [];
  for (const relativePath of executablePaths) {
    const absolutePath = path.join(rootDir, relativePath);
    if (!(await pathExists(absolutePath))) continue;
    const fileStat = await stat(absolutePath);
    if ((fileStat.mode & 0o111) === 0) {
      nonExecutablePaths.push(relativePath);
    }
  }
  return nonExecutablePaths;
}

async function findPresentPaths(rootDir, relativePaths) {
  const presentPaths = [];
  for (const relativePath of relativePaths) {
    if (await pathExists(path.join(rootDir, relativePath))) {
      presentPaths.push(relativePath);
    }
  }
  return presentPaths;
}

async function auditPackageMetadata(rootDir, expectedPackageName, expectedRuntimeEntry) {
  const packageIssues = [];
  const packageJsonText = await readTextIfExists(rootDir, 'package.json');

  if (packageJsonText === null) return packageIssues;

  let parsed;
  try {
    parsed = JSON.parse(packageJsonText);
  } catch (error) {
    packageIssues.push(`package.json is not valid JSON: ${error.message}`);
    return packageIssues;
  }

  if (parsed.name !== expectedPackageName) {
    packageIssues.push(
      `package.json name should be "${expectedPackageName}" but found "${parsed.name ?? ''}"`,
    );
  }

  const startCommand = parsed.scripts?.['start:cdx-appserver'];
  if (typeof startCommand !== 'string' || !startCommand.trim()) {
    packageIssues.push('package.json is missing scripts.start:cdx-appserver');
  } else if (!startCommand.includes(expectedRuntimeEntry)) {
    packageIssues.push(
      `scripts.start:cdx-appserver should point at "${expectedRuntimeEntry}" but is "${startCommand}"`,
    );
  }

  return packageIssues;
}

async function auditInstallSurface(
  rootDir,
  {
    expectedInstallerEntry = EXPECTED_INSTALLER_ENTRY,
    expectedPackageName = EXPECTED_PACKAGE_NAME,
    expectedPrimaryMcpName = EXPECTED_PRIMARY_MCP_NAME,
    expectedRuntimeEntry = EXPECTED_RUNTIME_ENTRY,
  } = {},
) {
  const installerIssues = [];

  const installSh = await readTextIfExists(rootDir, 'install.sh');
  if (installSh !== null) {
    if (!installSh.includes(expectedInstallerEntry)) {
      installerIssues.push(`install.sh should invoke "${expectedInstallerEntry}"`);
    }
    if (!installSh.includes('PROJECT_DIR')) {
      installerIssues.push('install.sh should resolve the installer from PROJECT_DIR');
    }
  }

  const installerCli = await readTextIfExists(rootDir, expectedInstallerEntry);
  if (installerCli !== null) {
    if (!new RegExp(`PACKAGE_NAME\\s*=\\s*['"]${escapeRegExp(expectedPackageName)}['"]`).test(installerCli)) {
      installerIssues.push(`${expectedInstallerEntry} should set PACKAGE_NAME to "${expectedPackageName}"`);
    }
    if (
      !new RegExp(`DEFAULT_MCP_NAME\\s*=\\s*['"]${escapeRegExp(expectedPrimaryMcpName)}['"]`).test(
        installerCli,
      )
    ) {
      installerIssues.push(
        `${expectedInstallerEntry} should keep DEFAULT_MCP_NAME as "${expectedPrimaryMcpName}"`,
      );
    }
    if (!installerCli.includes(expectedRuntimeEntry)) {
      installerIssues.push(
        `${expectedInstallerEntry} should keep the default runtime entry "${expectedRuntimeEntry}"`,
      );
    }
    if (!installerCli.includes('Usage: ./install.sh')) {
      installerIssues.push(`${expectedInstallerEntry} should keep install.sh usage text`);
    }
  }

  return installerIssues;
}

async function findSourceLeakMatches(rootDir, auditFiles) {
  const sourceLeakMatches = [];

  for (const relativePath of auditFiles) {
    const content = await readFile(path.join(rootDir, relativePath), 'utf8');
    const allowedTokens = ALLOWED_SOURCE_TOKEN_REFERENCES.get(relativePath) ?? new Set();

    if (SOURCE_REPO_ROOT_PATTERN.test(content) && !allowedTokens.has(SOURCE_REPO_ROOT)) {
      sourceLeakMatches.push({ relativePath, token: SOURCE_REPO_ROOT });
    }

    if (SOURCE_REPO_NAME_PATTERN.test(content) && !allowedTokens.has(SOURCE_REPO_NAME)) {
      sourceLeakMatches.push({ relativePath, token: SOURCE_REPO_NAME });
    }
  }

  return sourceLeakMatches;
}

function buildIssues({
  disallowedPaths,
  missingPaths,
  nonExecutablePaths,
  packageIssues,
  installerIssues,
  sourceLeakMatches,
}) {
  return [
    ...disallowedPaths.map(relativePath => `remove redundant compatibility path: ${relativePath}`),
    ...missingPaths.map(relativePath => `missing required path: ${relativePath}`),
    ...nonExecutablePaths.map(relativePath => `expected executable bit on: ${relativePath}`),
    ...packageIssues,
    ...installerIssues,
    ...sourceLeakMatches.map(
      ({ relativePath, token }) => `forbidden source-tree reference "${token}" found in ${relativePath}`,
    ),
  ];
}

export function resolveProjectRoot(fromUrl = import.meta.url) {
  return path.dirname(fileURLToPath(new URL('../../package.json', fromUrl)));
}

export async function auditStandaloneProject({
  disallowedPaths = DISALLOWED_LAYOUT_PATHS,
  rootDir = resolveProjectRoot(import.meta.url),
  expectedInstallerEntry = EXPECTED_INSTALLER_ENTRY,
  expectedPackageName = EXPECTED_PACKAGE_NAME,
  expectedPrimaryMcpName = EXPECTED_PRIMARY_MCP_NAME,
  expectedRuntimeEntry = EXPECTED_RUNTIME_ENTRY,
  executablePaths = REQUIRED_EXECUTABLE_PATHS,
  requiredPaths = REQUIRED_STANDALONE_PATHS,
  scanRoots = TEXT_AUDIT_ROOTS,
} = {}) {
  const [auditFiles, installerIssues, missingPaths, nonExecutablePaths, packageIssues, presentDisallowedPaths] =
    await Promise.all([
      collectAuditFiles(rootDir, scanRoots),
      auditInstallSurface(rootDir, {
        expectedInstallerEntry,
        expectedPackageName,
        expectedPrimaryMcpName,
        expectedRuntimeEntry,
      }),
      findMissingPaths(rootDir, requiredPaths),
      findNonExecutablePaths(rootDir, executablePaths),
      auditPackageMetadata(rootDir, expectedPackageName, expectedRuntimeEntry),
      findPresentPaths(rootDir, disallowedPaths),
    ]);

  const sourceLeakMatches = await findSourceLeakMatches(rootDir, auditFiles);

  const issues = buildIssues({
    disallowedPaths: presentDisallowedPaths,
    missingPaths,
    nonExecutablePaths,
    packageIssues,
    installerIssues,
    sourceLeakMatches,
  });

  return {
    auditFiles,
    disallowedPaths: [...disallowedPaths],
    executablePaths: [...executablePaths],
    expectedInstallerEntry,
    expectedPackageName,
    expectedPrimaryMcpName,
    expectedRuntimeEntry,
    hasIssues: issues.length > 0,
    installerIssues,
    issues,
    missingPaths,
    nonExecutablePaths,
    packageIssues,
    presentDisallowedPaths,
    requiredPaths: [...requiredPaths],
    rootDir,
    scanRoots: [...scanRoots],
    sourceLeakMatches,
  };
}

export function formatStandaloneAudit(result) {
  const lines = [
    `Standalone self-containment audit for ${result.rootDir}`,
    `Audited files: ${result.auditFiles.length}`,
  ];

  if (!result.hasIssues) {
    lines.push(
      `OK: required paths present (${result.requiredPaths.length}), install surface intact, no ${SOURCE_REPO_NAME} references found.`,
    );
    return lines.join('\n');
  }

  lines.push('Audit failed:');
  for (const issue of result.issues) {
    lines.push(`- ${issue}`);
  }

  return lines.join('\n');
}

export async function assertStandaloneProject(options) {
  const result = await auditStandaloneProject(options);
  if (result.hasIssues) {
    throw new Error(formatStandaloneAudit(result));
  }
  return result;
}
