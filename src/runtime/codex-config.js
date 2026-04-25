import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { statSync } from 'node:fs';

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripTomlComment(line) {
  const text = String(line ?? '');
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      const prev = i > 0 ? text[i - 1] : '';
      if (prev !== '\\') inDouble = !inDouble;
      continue;
    }
    if (ch === '#' && !inSingle && !inDouble) {
      return text.slice(0, i);
    }
  }
  return text;
}

function decodeTomlString(raw) {
  const text = raw.trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    const quote = text[0];
    const inner = text.slice(1, -1);
    if (quote === "'") return inner;
    return inner
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  return null;
}

function splitTomlArray(raw) {
  const text = raw.trim();
  if (!text.startsWith('[') || !text.endsWith(']')) return null;
  const inner = text.slice(1, -1).trim();
  if (!inner) return [];

  const items = [];
  let buf = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      buf += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      const prev = i > 0 ? inner[i - 1] : '';
      if (prev !== '\\') inDouble = !inDouble;
      buf += ch;
      continue;
    }
    if (ch === ',' && !inSingle && !inDouble) {
      items.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) items.push(buf.trim());
  return items;
}

function parseTomlValue(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;

  const asString = decodeTomlString(text);
  if (asString !== null) return asString;

  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null') return null;

  const num = Number.parseInt(text, 10);
  if (Number.isFinite(num) && String(num) === text) return num;

  const arrayItems = splitTomlArray(text);
  if (arrayItems !== null) {
    return arrayItems.map(item => {
      const decoded = decodeTomlString(item);
      if (decoded !== null) return decoded;
      if (item === 'true') return true;
      if (item === 'false') return false;
      const n = Number.parseInt(item, 10);
      if (Number.isFinite(n) && String(n) === item) return n;
      return item;
    });
  }

  return text;
}

function setNested(root, pathSegments, value) {
  if (!pathSegments || pathSegments.length === 0) return;
  let target = root;
  for (let i = 0; i < pathSegments.length - 1; i += 1) {
    const key = pathSegments[i];
    if (!isObject(target[key])) {
      target[key] = {};
    }
    target = target[key];
  }
  target[pathSegments[pathSegments.length - 1]] = value;
}

export function parseToml(text) {
  const root = {};
  let section = [];
  const lines = String(text ?? '').split(/\r?\n/);
  for (const rawLine of lines) {
    const withoutComment = stripTomlComment(rawLine);
    const line = withoutComment.trim();
    if (!line) continue;

    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      const name = sectionMatch[1].trim();
      section = name ? name.split('.').map(seg => seg.trim()).filter(Boolean) : [];
      continue;
    }

    const kvMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!kvMatch) continue;
    const keyPath = kvMatch[1].trim();
    const valueRaw = kvMatch[2].trim();
    const value = parseTomlValue(valueRaw);
    const segments = keyPath.split('.').map(seg => seg.trim()).filter(Boolean);
    setNested(root, [...section, ...segments], value);
  }
  return root;
}

function deepMerge(base, override) {
  if (!isObject(base)) return isObject(override) ? { ...override } : override;
  if (!isObject(override)) return { ...base };

  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (Array.isArray(value)) {
      result[key] = value.slice();
    } else if (isObject(value) && isObject(result[key])) {
      result[key] = deepMerge(result[key], value);
    } else if (isObject(value)) {
      result[key] = deepMerge({}, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function readTomlFile(filepath) {
  if (!filepath) return null;
  try {
    if (!existsSync(filepath)) return null;
    const content = readFileSync(filepath, 'utf8');
    return parseToml(content);
  } catch {
    return null;
  }
}

function pathExists(p) {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

function isDirectory(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function findProjectRoot(startDir, markers) {
  const start = path.resolve(String(startDir ?? process.cwd()));
  const markerList = Array.isArray(markers) && markers.length > 0 ? markers : ['.git'];
  let current = start;
  while (true) {
    for (const marker of markerList) {
      const candidate = path.join(current, marker);
      if (pathExists(candidate)) {
        return current;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

export function getConfigValue(config, keyPath) {
  if (!isObject(config)) return undefined;
  const keys = String(keyPath ?? '')
    .split('.')
    .map(seg => seg.trim())
    .filter(Boolean);
  if (keys.length === 0) return undefined;
  let value = config;
  for (const key of keys) {
    if (!isObject(value) && !Array.isArray(value)) return undefined;
    value = value[key];
    if (value === undefined) return undefined;
  }
  return value;
}

export function loadCodexConfigLayers({ cwd } = {}) {
  const resolvedCwd = path.resolve(String(cwd ?? process.cwd()));
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const systemConfigPath = process.env.CODEX_SYSTEM_CONFIG ?? '/etc/codex/config.toml';
  const userConfigPath = path.join(codexHome, 'config.toml');

  const systemConfig = readTomlFile(systemConfigPath) ?? {};
  const userConfig = readTomlFile(userConfigPath) ?? {};

  const mergedPreProject = deepMerge(systemConfig, userConfig);
  const markers = getConfigValue(mergedPreProject, 'project_root_markers');
  const markerList = Array.isArray(markers) ? markers.map(String).filter(Boolean) : ['.git'];

  const projectRoot = findProjectRoot(resolvedCwd, markerList);
  const projectConfigPath = path.join(projectRoot, '.codex', 'config.toml');
  const projectConfig = readTomlFile(projectConfigPath) ?? {};

  const config = deepMerge(deepMerge(systemConfig, userConfig), projectConfig);

  return {
    cwd: resolvedCwd,
    projectRoot,
    sources: [
      { layer: 'system', path: systemConfigPath, exists: pathExists(systemConfigPath) },
      { layer: 'user', path: userConfigPath, exists: pathExists(userConfigPath) },
      { layer: 'project', path: projectConfigPath, exists: pathExists(projectConfigPath) },
    ],
    config,
  };
}

export function resolveCodexProjectRoot({ cwd } = {}) {
  const resolvedCwd = path.resolve(String(cwd ?? process.cwd()));
  const layers = loadCodexConfigLayers({ cwd: resolvedCwd });
  return layers.projectRoot;
}

export function isCodexProjectConfigPresent({ cwd } = {}) {
  const resolvedCwd = path.resolve(String(cwd ?? process.cwd()));
  const layers = loadCodexConfigLayers({ cwd: resolvedCwd });
  const projectConfigPath = layers.sources.find(source => source.layer === 'project')?.path;
  return Boolean(projectConfigPath && pathExists(projectConfigPath) && !isDirectory(projectConfigPath));
}

