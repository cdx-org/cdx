#!/usr/bin/env node

import process from 'node:process';

import { runBrokerServer } from '../runtime/broker-server.js';

runBrokerServer().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

