#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  parseArgs,
  printHelp,
  runEvalHarness,
} from '../tools/scripts/eval-harness.js';

async function main(argv = process.argv.slice(2)) {
  const projectRoot = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const options = parseArgs(argv, { projectRoot });
  if (options.help) {
    printHelp({ projectRoot });
    return;
  }

  const report = await runEvalHarness(options);
  const summary = report.results
    .map(result => `${result.caseId}/${result.adapter}:${result.status}:${result.success === null ? 'skip' : result.success ? 'pass' : 'fail'}`)
    .join(', ');

  console.log(`Eval complete: ${report.resultsDir}`);
  console.log(summary);
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
