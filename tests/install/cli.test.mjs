import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const PROJECT_ROOT = path.resolve(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
);
const INSTALLER_PATH = path.join(PROJECT_ROOT, 'src', 'install', 'cli.js');
const DEFAULT_ENTRY_PATH = path.join(PROJECT_ROOT, 'src', 'cli', 'cdx-appserver-mcp-server.js');

function escapeRegExp(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tomlEscape(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

async function createInstallSandbox() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'mcp-cdx-install-'));
  const codexHome = path.join(tempRoot, '.codex');
  return {
    tempRoot,
    codexHome,
    configFile: path.join(codexHome, 'config.toml'),
    backupDir: path.join(codexHome, 'backups'),
    skillsDir: path.join(codexHome, 'skills'),
  };
}

async function runInstaller(args, { env = {}, allowFailure = false } = {}) {
  try {
    const result = await execFileAsync(process.execPath, [INSTALLER_PATH, ...args], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        PROJECT_DIR: PROJECT_ROOT,
        ...env,
      },
    });
    return { code: 0, ...result };
  } catch (error) {
    if (!allowFailure) throw error;
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}

async function withSandbox(run) {
  const sandbox = await createInstallSandbox();
  try {
    return await run(sandbox);
  } finally {
    await rm(sandbox.tempRoot, { recursive: true, force: true });
  }
}

async function createFixtureSkills(rootDir) {
  const skillsRoot = path.join(rootDir, 'fixture-skills');
  await mkdir(path.join(skillsRoot, 'cdx-preflight', 'notes'), { recursive: true });
  await mkdir(path.join(skillsRoot, 'cdx-wait-controller'), { recursive: true });

  await writeFile(
    path.join(skillsRoot, 'cdx-preflight', 'SKILL.md'),
    ['---', 'name: cdx-preflight', 'description: fixture', '---', ''].join('\n'),
    'utf8',
  );
  await writeFile(
    path.join(skillsRoot, 'cdx-preflight', 'notes', 'guide.md'),
    '# fixture\n',
    'utf8',
  );
  await writeFile(
    path.join(skillsRoot, 'cdx-wait-controller', 'SKILL.md'),
    ['---', 'name: cdx-wait-controller', 'description: fixture', '---', ''].join('\n'),
    'utf8',
  );

  return skillsRoot;
}

test('install CLI help text keeps standalone naming and compatibility defaults', async () => {
  const result = await runInstaller(['help']);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Installs the standalone mcp-cdx app-server into Codex\./);
  assert.match(
    result.stdout,
    /The package\/repo name is mcp-cdx; the default MCP server name remains cdx\./,
  );
  assert.match(
    result.stdout,
    /Default legacy names: keepdoing,codex-as-service,codex_as_service/,
  );
  assert.match(result.stdout, /default: none; writes env_vars only when non-empty/);
  assert.doesNotMatch(result.stdout, /The package\/repo name is mcp-keepdoing/);
});

test('install CLI writes standalone cdx entries, aliases, and legacy cleanup into config.toml', async () => {
  await withSandbox(async ({ backupDir, codexHome, configFile }) => {
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      configFile,
      [
        '[mcp_servers.keepdoing]',
        'command = "node"',
        'args = ["legacy.js"]',
        '',
        '[mcp_servers.codex-as-service]',
        'command = "node"',
        'args = ["legacy-compat.js"]',
        '',
        '[mcp_servers.other]',
        'command = "node"',
        'args = ["other.js"]',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = await runInstaller(['install'], {
      env: {
        CODEX_HOME: codexHome,
        INSTALL_SKILLS: '0',
        MCP_ALIAS_NAMES: 'cdx-alt, cdx-alt, cdx-compat',
        MCP_NAME: 'cdx-install-test',
      },
    });

    assert.equal(result.code, 0);
    assert.match(result.stderr, /Installed MCP server\(s\): cdx-install-test, cdx-alt, cdx-compat/);

    const backups = await readdir(backupDir);
    assert.equal(backups.length, 1, 'install should snapshot an existing config before rewriting');

    const configText = await readFile(configFile, 'utf8');
    assert.doesNotMatch(configText, /\[mcp_servers\.keepdoing\]/);
    assert.doesNotMatch(configText, /\[mcp_servers\.codex-as-service\]/);
    assert.match(configText, /\[mcp_servers\.other\]/);
    assert.match(configText, /\[mcp_servers\.cdx-install-test\]/);
    assert.match(configText, /\[mcp_servers\.cdx-alt\]/);
    assert.match(configText, /\[mcp_servers\.cdx-compat\]/);
    assert.match(
      configText,
      new RegExp(`args = \\["${escapeRegExp(tomlEscape(DEFAULT_ENTRY_PATH))}"\\]`),
    );
    assert.doesNotMatch(configText, /\nenv_vars\s*=/);
  });
});

test('install CLI doctor passes after install and uninstall removes only registered entries', async () => {
  await withSandbox(async ({ codexHome, configFile }) => {
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      configFile,
      ['[mcp_servers.other]', 'command = "node"', 'args = ["other.js"]', ''].join('\n'),
      'utf8',
    );

    const installResult = await runInstaller(['install'], {
      env: {
        CODEX_HOME: codexHome,
        INSTALL_SKILLS: '0',
        MCP_NAME: 'cdx-doctor-test',
      },
    });
    assert.equal(installResult.code, 0);

    const doctorResult = await runInstaller(['doctor'], {
      env: {
        CODEX_HOME: codexHome,
        INSTALL_SKILLS: '0',
        MCP_NAME: 'cdx-doctor-test',
      },
    });
    assert.equal(doctorResult.code, 0);
    assert.match(doctorResult.stderr, /Doctor: all basic checks passed/);

    const uninstallResult = await runInstaller(['uninstall'], {
      env: {
        CODEX_HOME: codexHome,
        INSTALL_SKILLS: '0',
        MCP_NAME: 'cdx-doctor-test',
      },
    });
    assert.equal(uninstallResult.code, 0);

    const configText = await readFile(configFile, 'utf8');
    assert.match(configText, /\[mcp_servers\.other\]/);
    assert.doesNotMatch(configText, /\[mcp_servers\.cdx-doctor-test\]/);

    const failedDoctor = await runInstaller(['doctor'], {
      allowFailure: true,
      env: {
        CODEX_HOME: codexHome,
        INSTALL_SKILLS: '0',
        MCP_NAME: 'cdx-doctor-test',
      },
    });
    assert.equal(failedDoctor.code, 1);
    assert.match(failedDoctor.stderr, /Doctor: issues detected/);
    assert.match(failedDoctor.stderr, /missing section: \[mcp_servers\.cdx-doctor-test\]/);
  });
});

test('install CLI can backup and restore config.toml explicitly', async () => {
  await withSandbox(async ({ backupDir, codexHome, configFile }) => {
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      configFile,
      ['[mcp_servers.original]', 'command = "node"', 'args = ["original.js"]', ''].join('\n'),
      'utf8',
    );

    const backupResult = await runInstaller(['backup'], {
      env: {
        CODEX_HOME: codexHome,
        INSTALL_SKILLS: '0',
      },
    });
    assert.equal(backupResult.code, 0);
    assert.match(backupResult.stderr, /Backup: /);

    const backups = await readdir(backupDir);
    assert.equal(backups.length, 1);

    await writeFile(
      configFile,
      ['[mcp_servers.changed]', 'command = "node"', 'args = ["changed.js"]', ''].join('\n'),
      'utf8',
    );

    const restoreResult = await runInstaller(['restore'], {
      env: {
        CODEX_HOME: codexHome,
        INSTALL_SKILLS: '0',
      },
    });
    assert.equal(restoreResult.code, 0);
    assert.match(restoreResult.stderr, /Restored .*config\.toml from /);

    const restoredText = await readFile(configFile, 'utf8');
    assert.match(restoredText, /\[mcp_servers\.original\]/);
    assert.doesNotMatch(restoredText, /\[mcp_servers\.changed\]/);
  });
});

test('install CLI copies skills from the configured standalone payload directory', async () => {
  await withSandbox(async ({ codexHome, skillsDir, tempRoot }) => {
    const fixtureSkills = await createFixtureSkills(tempRoot);

    const result = await runInstaller(['install'], {
      env: {
        CODEX_HOME: codexHome,
        MCP_NAME: 'cdx-skill-test',
        SKILLS_DIR: fixtureSkills,
      },
    });

    assert.equal(result.code, 0);
    assert.match(result.stderr, /Installed skills: 2 -> /);

    const installedSkillDirs = (await readdir(skillsDir)).sort();
    assert.deepEqual(installedSkillDirs, ['cdx-preflight', 'cdx-wait-controller']);

    const installedSkill = await readFile(
      path.join(skillsDir, 'cdx-preflight', 'notes', 'guide.md'),
      'utf8',
    );
    assert.equal(installedSkill, '# fixture\n');
  });
});
