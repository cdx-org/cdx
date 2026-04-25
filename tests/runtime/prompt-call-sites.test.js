import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractLoadPromptTemplateCalls,
  loadPromptRelatedSourceFiles,
  PROMPT_REFERENCE_PATTERNS,
} from './prompt-audit.js';

test('prompt template call sites keep inline fallback arguments', async () => {
  const promptFiles = await loadPromptRelatedSourceFiles();
  const offenders = [];

  for (const file of promptFiles) {
    const calls = extractLoadPromptTemplateCalls(file.source);
    for (const call of calls) {
      if (call.commaCount < 1) {
        offenders.push(`${file.relPath}:${call.startIndex + 1}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Every loadPromptTemplate call must include an inline fallback.\n${offenders.join('\n')}`,
  );
});

test('prompt audit covers runtime and app-server entrypoints', async () => {
  const promptFiles = await loadPromptRelatedSourceFiles();
  const relPaths = promptFiles.map(file => file.relPath);

  assert.ok(relPaths.includes('src/runtime/prompt-templates.js'));
  assert.ok(relPaths.includes('src/runtime/judge-service.js'));
  assert.ok(relPaths.includes('src/cli/cdx-appserver-mcp-server.js'));
  assert.ok(relPaths.includes('src/cli/cdx-mcp-server.js'));
});

test('prompt-related source files stay self-contained', async () => {
  const promptFiles = await loadPromptRelatedSourceFiles();
  const offenders = [];

  for (const file of promptFiles) {
    for (const pattern of PROMPT_REFERENCE_PATTERNS) {
      if (pattern.test(file.source)) {
        offenders.push(`${file.relPath} -> ${pattern}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Prompt-related source files should not depend on prompt directories or the source repo.\n${offenders.join('\n')}`,
  );
});
