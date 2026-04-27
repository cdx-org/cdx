import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = 'mcp-cdx';
const DEFAULT_MCP_NAME = 'cdx';
const DEFAULT_ENTRY_RELATIVE_PATH = 'src/cli/cdx-appserver-mcp-server.js';
const DEFAULT_LEGACY_NAMES = 'keepdoing,codex-as-service,codex_as_service';
let backupCounter = 0;

function trim(value) {
  return String(value ?? '').trim();
}

function parseCsv(value) {
  const raw = trim(value);
  if (!raw) return [];
  return raw
    .split(',')
    .map(item => trim(item))
    .filter(Boolean);
}

function toBool(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function tomlEscape(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function tomlKey(key) {
  const text = String(key ?? '');
  if (/^[A-Za-z0-9_-]+$/.test(text)) return text;
  return `"${tomlEscape(text)}"`;
}

function renderTomlString(value) {
  return `"${tomlEscape(value)}"`;
}

function ensureTrailingNewline(text) {
  const raw = String(text ?? '');
  if (!raw) return '\n';
  return raw.endsWith('\n') ? raw : `${raw}\n`;
}

function escapeRegExp(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function removeMcpSection(text, name) {
  const sectionPattern = new RegExp(
    `^\\s*\\[\\s*mcp_servers\\.${escapeRegExp(name)}\\s*\\]\\s*(#.*)?$`,
  );
  const sectionHeaderPattern = /^\s*\[.*\]\s*(#.*)?$/;

  const out = [];
  let skipping = false;

  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (sectionPattern.test(line)) {
      skipping = true;
      continue;
    }

    if (skipping) {
      if (sectionHeaderPattern.test(line)) {
        skipping = false;
        out.push(line);
      }
      continue;
    }

    out.push(line);
  }

  return ensureTrailingNewline(out.join('\n'));
}

function listEntryNames(primary, aliases) {
  const out = [];
  const seen = new Set();
  for (const name of [primary, ...(aliases ?? [])]) {
    const trimmed = trim(name);
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function resolveProjectDir() {
  if (process.env.PROJECT_DIR) {
    return path.resolve(process.env.PROJECT_DIR);
  }
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(path.join(scriptDir, '..', '..'));
}

function resolveEntryPath({ projectDir }) {
  const override = trim(process.env.MCP_ENTRY_PATH);
  if (override) {
    return path.isAbsolute(override) ? override : path.resolve(projectDir, override);
  }

  const rel = DEFAULT_ENTRY_RELATIVE_PATH;
  const abs = path.resolve(projectDir, rel);
  if (fs.existsSync(abs)) return abs;

  throw new Error(`Could not find default entrypoint: ${rel}`);
}

function parseDotenv(text) {
  const env = new Map();
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();

    const equalsIndex = line.indexOf('=');
    if (equalsIndex <= 0) continue;

    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();
    if (!key) continue;

    const hashIndex = value.indexOf(' #');
    if (hashIndex >= 0) value = value.slice(0, hashIndex).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    env.set(key, value);
  }
  return env;
}

function buildEnvTable({
  denylist,
  includeEmpty,
  envJson,
  envKeys,
  envPrefixes,
  envFile,
  loadDotenv,
  projectDir,
}) {
  const entries = new Map();

  function addEntry(key, value) {
    const k = trim(key);
    if (!k) return;
    if (denylist.has(k)) return;
    const v = value === undefined || value === null ? '' : String(value);
    if (!includeEmpty && !v) return;
    entries.set(k, v);
  }

  if (envJson) {
    let parsed;
    try {
      parsed = JSON.parse(envJson);
    } catch (err) {
      throw new Error(`MCP_ENV_JSON is not valid JSON: ${err.message}`);
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        addEntry(key, value);
      }
    } else {
      throw new Error('MCP_ENV_JSON must be a JSON object.');
    }
  }

  for (const key of envKeys) {
    addEntry(key, process.env[key]);
  }

  if (envPrefixes.length > 0) {
    for (const [key, value] of Object.entries(process.env)) {
      if (!key) continue;
      for (const prefix of envPrefixes) {
        if (key.startsWith(prefix)) {
          addEntry(key, value);
          break;
        }
      }
    }
  }

  let dotenvPath = envFile ? envFile : null;
  if (!dotenvPath && loadDotenv) {
    dotenvPath = path.join(projectDir, '.env');
  }
  if (dotenvPath) {
    const resolved = path.isAbsolute(dotenvPath)
      ? dotenvPath
      : path.resolve(projectDir, dotenvPath);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      const content = fs.readFileSync(resolved, 'utf8');
      const parsed = parseDotenv(content);
      for (const [key, value] of parsed.entries()) {
        addEntry(key, value);
      }
    }
  }

  return entries;
}

function renderMcpServerSection({ name, command, entryPath, envVars, envTable }) {
  const lines = [];
  lines.push(`[mcp_servers.${name}]`);
  lines.push(`command = ${renderTomlString(command)}`);
  lines.push(`args = [${renderTomlString(entryPath)}]`);

  if (envVars.length > 0) {
    const items = envVars.map(item => renderTomlString(item)).join(', ');
    lines.push(`env_vars = [${items}]`);
  }

  if (envTable.size > 0) {
    const items = [];
    for (const [key, value] of envTable.entries()) {
      items.push(`${tomlKey(key)} = ${renderTomlString(value)}`);
    }
    lines.push(`env = { ${items.join(', ')} }`);
  }

  return `${lines.join('\n')}\n`;
}

function timestamp() {
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  return (
    `${now.getUTCFullYear()}` +
    `${pad(now.getUTCMonth() + 1)}` +
    `${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`
  );
}

function backupConfig({ configDir, configFile, enabled }) {
  if (!enabled) return null;
  if (!fs.existsSync(configFile)) return null;
  const backupsDir = path.join(configDir, 'backups');
  fs.mkdirSync(backupsDir, { recursive: true });
  backupCounter += 1;
  const out = path.join(backupsDir, `config.toml.${timestamp()}.${process.pid}.${backupCounter}.toml`);
  fs.copyFileSync(configFile, out);
  return out;
}

function latestBackupPath({ configDir }) {
  const backupsDir = path.join(configDir, 'backups');
  if (!fs.existsSync(backupsDir) || !fs.statSync(backupsDir).isDirectory()) return null;
  const candidates = fs
    .readdirSync(backupsDir)
    .filter(name => /^config\.toml\..*\.toml$/.test(name))
    .map(name => {
      const fullPath = path.join(backupsDir, name);
      const stat = fs.statSync(fullPath);
      return { fullPath, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.fullPath ?? null;
}

function restoreConfig({ configDir, configFile, source }) {
  const rawSource = trim(source) || 'latest';
  const restoreSource =
    rawSource === 'latest'
      ? latestBackupPath({ configDir })
      : path.isAbsolute(rawSource)
        ? rawSource
        : path.resolve(process.cwd(), rawSource);

  if (!restoreSource || !fs.existsSync(restoreSource) || !fs.statSync(restoreSource).isFile()) {
    throw new Error(`Backup not found: ${rawSource}`);
  }

  fs.mkdirSync(configDir, { recursive: true });
  if (fs.existsSync(configFile)) {
    backupConfig({ configDir, configFile, enabled: true });
  }
  fs.copyFileSync(restoreSource, configFile);
  return restoreSource;
}

function installSkills({ skillsDir, codexSkillsDir, enabled }) {
  if (!enabled) return 0;
  if (!fs.existsSync(skillsDir) || !fs.statSync(skillsDir).isDirectory()) return 0;

  fs.mkdirSync(codexSkillsDir, { recursive: true });

  let count = 0;
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const src = path.join(skillsDir, entry.name);
    const dest = path.join(codexSkillsDir, entry.name);
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(src, dest, { recursive: true, force: true });
    count += 1;
  }
  return count;
}

function usage({ defaultName, configFile, envVarsDefault }) {
  return `Usage: ./install.sh <command>
       ./install.ps1 <command>

Installs the standalone ${PACKAGE_NAME} app-server into Codex.
The package/repo name is ${PACKAGE_NAME}; the default MCP server name remains ${DEFAULT_MCP_NAME}.
Default legacy names: ${DEFAULT_LEGACY_NAMES}

Commands:
  install     Add or update [mcp_servers.<name>] in ${configFile}
  uninstall   Remove the entry
  doctor      Validate environment and configuration
  backup      Backup ${configFile}
  restore     Restore from backup (restore [latest|/path/to/file])
  help        Show this message

Environment overrides:
  PROJECT_DIR           Project root (default: auto)
  CODEX_HOME            (default: ~/.codex)
  CONFIG_DIR            (default: CODEX_HOME)
  CONFIG_FILE           (default: CODEX_HOME/config.toml)

install.sh wrapper:
  INSTALL_DEPS          If 1, install wrappers run npm install first (default: 1)
  INSTALL_NPM_BIN       npm binary to use for dependency install (default: npm)
  INSTALL_NPM_COMMAND   npm subcommand for dependency install (default: install)
  INSTALL_NPM_EXTRA_ARGS Extra args appended to the npm install command
                        (default: --no-fund --no-audit)
  INSTALL_NODE_BIN      node binary used to run the installer (default: node)
  SKIP_NODE_CHECK       If 1, skip wrapper Node.js/npm preflight checks

Remote install wrapper:
  CDX_INSTALL_REPO      Git repo used by curl|bash or irm|iex installs
                        (default: https://github.com/cdx-org/cdx.git)
  CDX_INSTALL_REF       Branch/tag/ref to install (default: main)
  CDX_INSTALL_DIR       Checkout/cache dir for remote installs
                        (default: ~/.local/share/mcp-cdx or %LOCALAPPDATA%\\mcp-cdx)
  CDX_INSTALL_SKIP_UPDATE If 1, do not update an existing streamed checkout

  MCP_NAME              (default: ${defaultName})
  MCP_ALIAS_NAMES       Comma-separated alias names to install alongside MCP_NAME
  MCP_COMMAND           (default: node)
  MCP_ENTRY_PATH        Explicit entry file path (overrides the default entry)

Env injection (optional):
  MCP_ENV_JSON          JSON object of env pairs, e.g. '{"CDX_DIRTY_WORKTREE":"commit"}'
  MCP_ENV_KEYS          Comma-separated var names to include from current env
  MCP_ENV_PREFIXES      Comma-separated prefixes; includes all vars matching
  MCP_ENV_FILE          Path to .env-style file to import keys from
  MCP_ENV_LOAD_DOTENV   If 1 and MCP_ENV_FILE not set, load PROJECT_DIR/.env
  MCP_INCLUDE_EMPTY_ENV If 1, include keys with empty values
  MCP_ENV_DENYLIST      Comma-separated keys to exclude from env injection

Secrets pass-through (recommended):
  MCP_ENV_VARS          Comma-separated env var names to pass through
                        (default: none; writes env_vars only when non-empty)

Legacy cleanup:
  MCP_LEGACY_NAMES          Comma-separated legacy MCP names to remove during install
  MCP_REMOVE_LEGACY_NAMES   If 1, remove legacy MCP entries during install (default: 1)

Skills installation:
  INSTALL_SKILLS        If 1, copy skills from SKILLS_DIR to CODEX_SKILLS_DIR (default: 1)
  SKILLS_DIR            Skills source dir (default: PROJECT_DIR/skills)
  CODEX_SKILLS_DIR      Skills destination dir (default: CODEX_HOME/skills)
`;
}

function main() {
  const projectDir = resolveProjectDir();
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const configDir = process.env.CONFIG_DIR ?? codexHome;
  const configFile = process.env.CONFIG_FILE ?? path.join(configDir, 'config.toml');

  const defaultName = DEFAULT_MCP_NAME;
  const primaryName = process.env.MCP_NAME ?? defaultName;
  const aliasNames = parseCsv(process.env.MCP_ALIAS_NAMES);
  const entryNames = listEntryNames(primaryName, aliasNames);

  const legacyNames = parseCsv(process.env.MCP_LEGACY_NAMES ?? DEFAULT_LEGACY_NAMES);
  const removeLegacy = toBool(process.env.MCP_REMOVE_LEGACY_NAMES, true);

  const command = process.env.MCP_COMMAND ?? 'node';
  const entryPath = resolveEntryPath({ projectDir });

  const envVarsDefault = '';
  const envVars = parseCsv(process.env.MCP_ENV_VARS ?? envVarsDefault);

  const denylist = new Set(
    parseCsv(process.env.MCP_ENV_DENYLIST ?? 'CDX_REPO_ROOT,CDX_PROJECT_ROOT'),
  );
  const includeEmpty = toBool(process.env.MCP_INCLUDE_EMPTY_ENV, false);
  const envJson = process.env.MCP_ENV_JSON ?? '';
  const envKeys = parseCsv(process.env.MCP_ENV_KEYS);
  const envPrefixes = parseCsv(process.env.MCP_ENV_PREFIXES);
  const envFile = trim(process.env.MCP_ENV_FILE);
  const loadDotenv = toBool(process.env.MCP_ENV_LOAD_DOTENV, false);

  const installSkillsEnabled = toBool(process.env.INSTALL_SKILLS, true);
  const skillsDir = process.env.SKILLS_DIR ?? path.join(projectDir, 'skills');
  const codexSkillsDir = process.env.CODEX_SKILLS_DIR ?? path.join(codexHome, 'skills');

  const backupEnabled = toBool(process.env.INSTALL_BACKUP_BEFORE, true);

  const cmd = process.argv[2] ?? '';
  switch (cmd) {
    case 'install': {
      fs.mkdirSync(configDir, { recursive: true });
      if (!fs.existsSync(configFile)) {
        fs.writeFileSync(configFile, '# Codex CLI configuration\n', 'utf8');
      }
      const backup = backupConfig({ configDir, configFile, enabled: backupEnabled });
      if (backup) {
        console.error(`Backup: ${backup}`);
      }

      let configText = fs.readFileSync(configFile, 'utf8');

      if (removeLegacy) {
        for (const legacy of legacyNames) {
          if (!legacy) continue;
          if (entryNames.includes(legacy)) continue;
          configText = removeMcpSection(configText, legacy);
        }
      }

      for (const name of entryNames) {
        configText = removeMcpSection(configText, name);
      }

      const envTable = buildEnvTable({
        denylist,
        includeEmpty,
        envJson,
        envKeys,
        envPrefixes,
        envFile,
        loadDotenv,
        projectDir,
      });

      const sections = entryNames
        .map(name =>
          renderMcpServerSection({
            name,
            command,
            entryPath,
            envVars,
            envTable,
          }),
        )
        .join('\n');

      configText = ensureTrailingNewline(configText);
      if (!configText.endsWith('\n\n')) configText += '\n';
      configText += sections;

      fs.writeFileSync(configFile, configText, 'utf8');
      console.error(`Installed MCP server(s): ${entryNames.join(', ')}`);
      console.error(`- config: ${configFile}`);
      console.error(`- command: ${command}`);
      console.error(`- entry: ${entryPath}`);

      const installedSkills = installSkills({
        skillsDir,
        codexSkillsDir,
        enabled: installSkillsEnabled,
      });
      if (installedSkills > 0) {
        console.error(`Installed skills: ${installedSkills} -> ${codexSkillsDir}`);
      }
      return;
    }
    case 'uninstall': {
      if (!fs.existsSync(configFile)) {
        console.error(`Nothing to uninstall: ${configFile} not found`);
        return;
      }
      let configText = fs.readFileSync(configFile, 'utf8');
      for (const name of entryNames) {
        configText = removeMcpSection(configText, name);
      }
      fs.writeFileSync(configFile, configText, 'utf8');
      console.error(`Uninstalled MCP server(s): ${entryNames.join(', ')}`);
      return;
    }
    case 'backup': {
      const backup = backupConfig({ configDir, configFile, enabled: true });
      if (!backup) {
        console.error(`Nothing to backup: ${configFile} not found`);
        process.exitCode = 1;
        return;
      }
      console.error(`Backup: ${backup}`);
      console.log(backup);
      return;
    }
    case 'restore': {
      try {
        const restoredFrom = restoreConfig({
          configDir,
          configFile,
          source: process.argv[3] ?? 'latest',
        });
        console.error(`Restored ${configFile} from ${restoredFrom}`);
      } catch (err) {
        console.error(err?.message ?? String(err));
        process.exitCode = 1;
      }
      return;
    }
    case 'doctor': {
      const issues = [];
      if (command === 'node' && !fs.existsSync(entryPath)) {
        issues.push(`entry missing: ${entryPath}`);
      }
      if (!fs.existsSync(configFile)) {
        issues.push(`config missing: ${configFile}`);
      } else {
        const text = fs.readFileSync(configFile, 'utf8');
        for (const name of entryNames) {
          const pattern = new RegExp(
            `^\\s*\\[\\s*mcp_servers\\.${escapeRegExp(name)}\\s*\\]\\s*(#.*)?$`,
            'm',
          );
          if (!pattern.test(text)) {
            issues.push(`missing section: [mcp_servers.${name}]`);
          }
        }
      }

      if (issues.length === 0) {
        console.error('Doctor: all basic checks passed');
        return;
      }
      console.error('Doctor: issues detected');
      for (const issue of issues) {
        console.error(`- ${issue}`);
      }
      process.exitCode = 1;
      return;
    }
    case 'help':
    case '':
    case '-h':
    case '--help': {
      console.log(usage({ defaultName, configFile, envVarsDefault }));
      return;
    }
    default: {
      console.error(`Unknown command: ${cmd}`);
      console.log(usage({ defaultName, configFile, envVarsDefault }));
      process.exitCode = 1;
    }
  }
}

main();
