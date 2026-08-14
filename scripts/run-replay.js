#!/usr/bin/env node
import { loadEnv } from './loadEnv.js';
import { buildStrategyConfig } from './strategyConfig.js';
import { replay } from '../src/replay.js';

loadEnv();

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node scripts/run-replay.js <events_part1.jsonl> [more...]');
  console.error('  uses the same .env strategy overlay as paper');
  process.exit(1);
}

const { params, guards, sim } = buildStrategyConfig({ feeMode: 'paper' });
const { text } = await replay({ files, params, guards, sim });
console.log(text);
