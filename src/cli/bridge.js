#!/usr/bin/env node

import process from 'node:process';

import { runBrokerBridge } from '../runtime/broker-bridge.js';

runBrokerBridge().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

