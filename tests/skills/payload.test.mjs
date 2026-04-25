import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FORBIDDEN_SKILL_TEXT_SNIPPETS,
  SHIPPED_SKILL_NAMES,
  assertValidShippedSkills,
  formatValidationResult,
  validateShippedSkills,
} from '../../src/skills/manifest.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function createSkillFixture({ forbiddenText = null } = {}) {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'mcp-cdx-skills-'));
  await mkdir(path.join(fixtureRoot, 'docs'), { recursive: true });
  await mkdir(path.join(fixtureRoot, 'skills'), { recursive: true });

  for (const skillName of SHIPPED_SKILL_NAMES) {
    const skillDir = path.join(fixtureRoot, 'skills', skillName);
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, 'SKILL.md'),
      [
        '---',
        `name: ${skillName}`,
        'description: fixture',
        '---',
        '',
        '# Fixture',
      ].join('\n'),
      'utf8',
    );
  }

  await writeFile(
    path.join(fixtureRoot, 'skills', 'cdx-preflight', 'README.md'),
    forbiddenText ? `contains ${forbiddenText}\n` : 'standalone fixture\n',
    'utf8',
  );
  await writeFile(
    path.join(fixtureRoot, 'docs', 'repository-layout.md'),
    `skills: ${SHIPPED_SKILL_NAMES.join(', ')}\n`,
    'utf8',
  );

  return fixtureRoot;
}

test('skill manifest exports the expected standalone skill inventory', () => {
  assert.deepEqual(SHIPPED_SKILL_NAMES, ['cdx-preflight', 'cdx-wait-controller']);
  assert.deepEqual(FORBIDDEN_SKILL_TEXT_SNIPPETS, ['mcp-keepdoing', 'mcp-codex-as-service']);
});

test('validateShippedSkills accepts a standalone fixture payload', async () => {
  const fixtureRoot = await createSkillFixture();

  try {
    const result = validateShippedSkills(fixtureRoot);

    assert.deepEqual(result.installedSkillDirs, [...SHIPPED_SKILL_NAMES]);
    assert.deepEqual(result.issues, []);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('validateShippedSkills rejects skill payloads that still mention the source repo', async () => {
  const fixtureRoot = await createSkillFixture({ forbiddenText: 'mcp-keepdoing' });

  try {
    const result = validateShippedSkills(fixtureRoot);

    assert.match(
      formatValidationResult(result),
      /forbidden standalone reference "mcp-keepdoing" found in skills\/cdx-preflight\/README\.md/,
    );
    assert.throws(() => assertValidShippedSkills(fixtureRoot), /mcp-keepdoing/);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('standalone docs in this repo keep the shipped skill inventory visible', () => {
  const repoLayout = validateShippedSkills(projectRoot);

  assert.ok(
    repoLayout.issues.every(issue => !issue.startsWith('docs/repository-layout.md does not mention')),
    'docs/repository-layout.md should continue to mention every shipped skill',
  );
});
