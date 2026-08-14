#!/usr/bin/env node
import fs from 'node:fs/promises';
import { buildDecisionDataset, parseJsonLines } from '../research/dataset.js';
import { walkForwardEvaluate } from '../research/walkForward.js';

const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
};
const optionValues = new Set([
  '--dataset', valueAfter('--dataset'),
  '--report', valueAfter('--report'),
  '--artifact', valueAfter('--artifact'),
  '--minimum-train-rounds', valueAfter('--minimum-train-rounds'),
  '--validation-rounds', valueAfter('--validation-rounds'),
].filter(Boolean));
const files = args.filter((arg) => !arg.startsWith('--') && !optionValues.has(arg));
if (!files.length) {
  console.error('usage: node scripts/v3-research.js <activity.jsonl...> [--dataset rows.json] [--report report.json] [--artifact model.json]');
  process.exitCode = 1;
} else {
  const events = [];
  const parseErrors = [];
  for (const file of files) {
    const parsed = parseJsonLines(await fs.readFile(file, 'utf8'));
    events.push(...parsed.events);
    parseErrors.push(...parsed.errors.map((error) => ({ file, ...error })));
  }
  const dataset = buildDecisionDataset(events);
  const report = walkForwardEvaluate(dataset.rows, {
    minimumTrainRounds: Number(valueAfter('--minimum-train-rounds') ?? 50),
    validationRounds: Number(valueAfter('--validation-rounds') ?? 10),
  });
  if (valueAfter('--dataset')) {
    await fs.writeFile(valueAfter('--dataset'), JSON.stringify(dataset.rows, null, 2));
  }
  if (valueAfter('--report')) {
    await fs.writeFile(valueAfter('--report'), JSON.stringify({ ...report, parseErrors, rejected: dataset.rejected }, null, 2));
  }
  if (valueAfter('--artifact') && report.artifact) {
    await fs.writeFile(valueAfter('--artifact'), JSON.stringify(report.artifact, null, 2));
  }
  console.log(JSON.stringify({
    events: events.length,
    rows: dataset.rows.length,
    rejected: dataset.rejected.length,
    parseErrors: parseErrors.length,
    folds: report.folds.length,
    learned: report.learned,
    baselines: report.baselines,
  }, null, 2));
}

