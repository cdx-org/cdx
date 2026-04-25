#!/usr/bin/env node

import {
  assertStandaloneProject,
  formatStandaloneAudit,
} from '../tools/scripts/standalone-self-containment.js';

try {
  const result = await assertStandaloneProject();
  console.log(formatStandaloneAudit(result));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
