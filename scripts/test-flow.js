#!/usr/bin/env node
import process from 'node:process';

import { runPackageStartupSmoke } from './smoke-startup-paths.js';

async function main(argv = process.argv.slice(2)) {
  const verbose = Boolean(process.env.TEST_DEBUG) || argv.includes('--verbose');
  const result = await runPackageStartupSmoke({ verbose });

  if (result.skipped) {
    console.log(`Skipping smoke test: ${result.reason}.`);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
