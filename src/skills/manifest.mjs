import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SHIPPED_SKILL_NAMES = Object.freeze([
  'cdx-preflight',
  'cdx-wait-controller',
]);

export const FORBIDDEN_SKILL_TEXT_SNIPPETS = Object.freeze([
  'mcp-keepdoing',
  'mcp-codex-as-service',
]);

function listTextFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTextFiles(entryPath));
      continue;
    }
    files.push(entryPath);
  }
  return files.sort();
}

function toPortablePath(value) {
  return String(value ?? '').replace(/\\/g, '/');
}

export function resolveProjectRoot(fromUrl = import.meta.url) {
  return path.resolve(path.dirname(fileURLToPath(fromUrl)), '..', '..');
}

export function resolveRepoSkillsDir(projectRoot = resolveProjectRoot()) {
  return path.join(projectRoot, 'skills');
}

export function validateShippedSkills(projectRoot = resolveProjectRoot()) {
  const issues = [];
  const skillsDir = resolveRepoSkillsDir(projectRoot);
  const installedSkillDirs = fs.existsSync(skillsDir)
    ? fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort()
    : [];

  if (!fs.existsSync(skillsDir)) {
    issues.push(`missing skills directory: ${path.relative(projectRoot, skillsDir)}`);
  }

  if (JSON.stringify(installedSkillDirs) !== JSON.stringify([...SHIPPED_SKILL_NAMES].sort())) {
    issues.push(
      `expected shipped skill directories ${SHIPPED_SKILL_NAMES.join(', ')} but found ${installedSkillDirs.join(', ') || '(none)'}`,
    );
  }

  for (const skillName of SHIPPED_SKILL_NAMES) {
    const skillDir = path.join(skillsDir, skillName);
    const skillFile = path.join(skillDir, 'SKILL.md');

    if (!fs.existsSync(skillDir) || !fs.statSync(skillDir).isDirectory()) {
      issues.push(`missing skill directory: skills/${skillName}`);
      continue;
    }

    if (!fs.existsSync(skillFile)) {
      issues.push(`missing skill file: skills/${skillName}/SKILL.md`);
      continue;
    }

    const skillText = fs.readFileSync(skillFile, 'utf8');
    if (!skillText.includes(`name: ${skillName}`)) {
      issues.push(`frontmatter name mismatch in skills/${skillName}/SKILL.md`);
    }

    for (const filePath of listTextFiles(skillDir)) {
      const relativePath = toPortablePath(path.relative(projectRoot, filePath));
      const content = fs.readFileSync(filePath, 'utf8');
      for (const forbiddenSnippet of FORBIDDEN_SKILL_TEXT_SNIPPETS) {
        if (content.includes(forbiddenSnippet)) {
          issues.push(`forbidden standalone reference "${forbiddenSnippet}" found in ${relativePath}`);
        }
      }
    }
  }

  const repoLayoutPath = path.join(projectRoot, 'docs', 'repository-layout.md');
  if (!fs.existsSync(repoLayoutPath)) {
    issues.push('missing documentation file: docs/repository-layout.md');
  } else {
    const repoLayoutText = fs.readFileSync(repoLayoutPath, 'utf8');
    for (const skillName of SHIPPED_SKILL_NAMES) {
      if (!repoLayoutText.includes(skillName)) {
        issues.push(`docs/repository-layout.md does not mention ${skillName}`);
      }
    }
  }

  return {
    projectRoot,
    skillsDir,
    installedSkillDirs,
    issues,
  };
}

export function formatValidationResult(result) {
  if (result.issues.length === 0) {
    return [
      `Skill payload OK: ${result.installedSkillDirs.join(', ')}`,
      `skills dir: ${path.relative(result.projectRoot, result.skillsDir) || '.'}`,
    ].join('\n');
  }

  return [
    'Skill payload validation failed:',
    ...result.issues.map(issue => `- ${issue}`),
  ].join('\n');
}

export function assertValidShippedSkills(projectRoot = resolveProjectRoot()) {
  const result = validateShippedSkills(projectRoot);
  if (result.issues.length > 0) {
    throw new Error(formatValidationResult(result));
  }
  return result;
}
