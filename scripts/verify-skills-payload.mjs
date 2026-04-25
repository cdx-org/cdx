#!/usr/bin/env node

import { assertValidShippedSkills, formatValidationResult } from '../src/skills/manifest.mjs';

try {
  const result = assertValidShippedSkills();
  console.log(formatValidationResult(result));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
