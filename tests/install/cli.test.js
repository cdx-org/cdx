import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
const installerPath = path.join(repoRoot, 'src', 'install', 'cli.js');
const installScriptPath = path.join(repoRoot, 'install.sh');

function countMatches(text, pattern) {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

function tomlEscape(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function escapeRegExp(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractMcpSection(configText, name) {
  const header = `[mcp_servers.${name}]`;
  const lines = String(configText).split(/\r?\n/);
  const out = [];
  let collecting = false;
  for (const line of lines) {
    if (line === header) {
      collecting = true;
      out.push(line);
      continue;
    }
    if (collecting && /^\[/.test(line)) break;
    if (collecting) out.push(line);
  }
  return out.join('\n');
}

function writeFileSyncRecursive(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function createTempProject(tempRoot, { skillNames = [] } = {}) {
  const projectRoot = path.join(tempRoot, 'project');
  writeFileSyncRecursive(
    path.join(projectRoot, 'src', 'cli', 'cdx-appserver-mcp-server.js'),
    '#!/usr/bin/env node\nconsole.log("stub");\n',
  );

  for (const name of skillNames) {
    writeFileSyncRecursive(
      path.join(projectRoot, 'skills', name, 'SKILL.md'),
      `# ${name}\n`,
    );
  }

  return projectRoot;
}

async function runInstaller(command, env) {
  return execFileAsync(process.execPath, [installerPath, command], {
    env: {
      ...process.env,
      ...env,
    },
  });
}

test('install CLI registers the default app-server entry without env_vars by default', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cdx-install-'));
  const projectRoot = createTempProject(tempRoot);
  const codexHome = path.join(tempRoot, '.codex');
  const configFile = path.join(codexHome, 'config.toml');
  const expectedEntry = path.join(projectRoot, 'src', 'cli', 'cdx-appserver-mcp-server.js');

  try {
    await runInstaller('install', {
      PROJECT_DIR: projectRoot,
      CODEX_HOME: codexHome,
      INSTALL_SKILLS: '0',
      MCP_NAME: 'cdx-install-test',
    });

    const configText = fs.readFileSync(configFile, 'utf8');
    const section = extractMcpSection(configText, 'cdx-install-test');
    assert.match(section, /\[mcp_servers\.cdx-install-test\]/);
    assert.doesNotMatch(section, /\nenv_vars\s*=/);
    assert.match(
      section,
      new RegExp(`\\[mcp_servers\\.cdx-install-test\\][\\s\\S]*args = \\["${escapeRegExp(tomlEscape(expectedEntry))}"\\]`),
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('install CLI copies skills from the configured project by default', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cdx-install-'));
  const projectRoot = createTempProject(tempRoot, {
    skillNames: ['cdx-preflight', 'cdx-wait-controller'],
  });
  const codexHome = path.join(tempRoot, '.codex');
  const skillsDir = path.join(codexHome, 'skills');

  try {
    await runInstaller('install', {
      PROJECT_DIR: projectRoot,
      CODEX_HOME: codexHome,
      MCP_NAME: 'cdx-install-skills-test',
    });

    const installedSkillDirs = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort();

    assert.deepEqual(installedSkillDirs, ['cdx-preflight', 'cdx-wait-controller']);
    assert.ok(fs.existsSync(path.join(skillsDir, 'cdx-preflight', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(skillsDir, 'cdx-wait-controller', 'SKILL.md')));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('install CLI removes legacy sections and installs aliases alongside the primary entry', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cdx-install-'));
  const projectRoot = createTempProject(tempRoot);
  const codexHome = path.join(tempRoot, '.codex');
  const configFile = path.join(codexHome, 'config.toml');

  try {
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
      configFile,
      [
        '# Codex CLI configuration',
        '',
        '[mcp_servers.keepdoing]',
        'command = "node"',
        'args = ["old.js"]',
        '',
        '[mcp_servers.codex-as-service]',
        'command = "node"',
        'args = ["old.js"]',
        '',
        '[mcp_servers.preserve]',
        'command = "node"',
        'args = ["preserve.js"]',
        '',
      ].join('\n'),
      'utf8',
    );

    await runInstaller('install', {
      PROJECT_DIR: projectRoot,
      CODEX_HOME: codexHome,
      INSTALL_SKILLS: '0',
      MCP_NAME: 'cdx-primary',
      MCP_ALIAS_NAMES: 'cdx-secondary,cdx-primary',
      INSTALL_BACKUP_BEFORE: '0',
    });

    const configText = fs.readFileSync(configFile, 'utf8');
    assert.doesNotMatch(configText, /\[mcp_servers\.keepdoing\]/);
    assert.doesNotMatch(configText, /\[mcp_servers\.codex-as-service\]/);
    assert.match(configText, /\[mcp_servers\.preserve\]/);
    assert.equal(countMatches(configText, /\[mcp_servers\.cdx-primary\]/g), 1);
    assert.equal(countMatches(configText, /\[mcp_servers\.cdx-secondary\]/g), 1);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('install.sh preserves wrapper behavior and supports INSTALL_NODE_BIN overrides', async t => {
  const bashAvailable = await execFileAsync('bash', ['--version']).then(
    () => true,
    () => false,
  );
  if (!bashAvailable) {
    t.skip('bash is not available in this environment');
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cdx-install-'));
  const projectRoot = createTempProject(tempRoot, { skillNames: ['wrapped-skill'] });
  const entryPath = path.join(projectRoot, 'src', 'cli', 'cdx-appserver-mcp-server.js');
  const skillsSource = path.join(projectRoot, 'skills');
  const codexHome = path.join(tempRoot, '.codex');
  const configFile = path.join(codexHome, 'config.toml');
  const nodeWrapper = path.join(tempRoot, 'node-esm.sh');
  const npmWrapper = path.join(tempRoot, 'npm-wrapper.sh');
  const npmLog = path.join(tempRoot, 'npm.log');

  try {
    fs.writeFileSync(
      nodeWrapper,
      `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
      'utf8',
    );
    fs.chmodSync(nodeWrapper, 0o755);
    fs.writeFileSync(
      npmWrapper,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$PWD|$*" >> ${JSON.stringify(npmLog)}\nexit 0\n`,
      'utf8',
    );
    fs.chmodSync(npmWrapper, 0o755);

    await execFileAsync('bash', [installScriptPath, 'install'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        INSTALL_NODE_BIN: nodeWrapper,
        INSTALL_NPM_BIN: npmWrapper,
        MCP_NAME: 'cdx-install-shell-test',
        MCP_ENTRY_PATH: entryPath,
        SKILLS_DIR: skillsSource,
        INSTALL_BACKUP_BEFORE: '0',
      },
    });

    const configText = fs.readFileSync(configFile, 'utf8');
    const section = extractMcpSection(configText, 'cdx-install-shell-test');
    assert.match(section, /\[mcp_servers\.cdx-install-shell-test\]/);
    assert.doesNotMatch(section, /\nenv_vars\s*=/);
    assert.match(
      section,
      new RegExp(`args = \\["${escapeRegExp(tomlEscape(entryPath))}"\\]`),
    );
    assert.ok(fs.existsSync(path.join(codexHome, 'skills', 'wrapped-skill', 'SKILL.md')));
    assert.equal(
      fs.readFileSync(npmLog, 'utf8').trim(),
      `${repoRoot}|install --no-fund --no-audit`,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
