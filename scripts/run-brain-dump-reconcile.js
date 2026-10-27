#!/usr/bin/env node
'use strict';

const { reconcileBrainDumpEntries } = require('../src/brain-dump-reconcile.js');

const USAGE = `Usage: run-brain-dump-reconcile.js [OPTIONS]

Options:
  --dry-run   Reconcile without writing changes to the brain-dump JSON
  --json      Output results as pretty-printed JSON (default: summary table)
  --help      Show this help message

Exit codes:
  0  Success
  1  Reconciliation error
  2  Invalid flags`;

function parseArgs(args) {
  const opts = { dryRun: false, json: false };
  const unknown = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--help') {
      console.log(USAGE);
      process.exit(0);
    } else {
      unknown.push(arg);
    }
  }

  if (unknown.length > 0) {
    console.error(`Unknown flags: ${unknown.join(', ')}`);
    console.error(USAGE);
    process.exit(2);
  }

  return opts;
}

function createLogger() {
  return {
    info(msg, ...args) {
      process.stderr.write(`[INFO] ${msg}`);
      if (args.length > 0) {
        process.stderr.write(` ${JSON.stringify(args)}`);
      }
      process.stderr.write('\n');
    },
    warn(msg, ...args) {
      process.stderr.write(`[WARN] ${msg}`);
      if (args.length > 0) {
        process.stderr.write(` ${JSON.stringify(args)}`);
      }
      process.stderr.write('\n');
    }
  };
}

function printSummary(result) {
  const { counts, changes } = result;
  console.log('reconcileBrainDumpEntries summary');
  console.log(`  checked: ${counts.checked}`);
  console.log(`  actioned: ${counts.actioned}`);
  console.log(`  possiblyResolved: ${counts.possiblyResolved}`);
  console.log('');
  console.log('Changes:');
  for (const change of changes) {
    const taskId = change.taskId ? ` (${change.taskId})` : '';
    const symbol = change.symbol ? ` [${change.symbol}]` : '';
    console.log(`  ${change.entryId}: ${change.action}${taskId}${symbol}`);
  }
}

function printJson(result) {
  console.log(JSON.stringify(result, null, 2));
}

try {
  const args = process.argv.slice(2);
  const opts = parseArgs(args);
  const logger = createLogger();

  const result = reconcileBrainDumpEntries({ dryRun: opts.dryRun, logger });

  if (opts.json) {
    printJson(result);
  } else {
    printSummary(result);
  }

  process.exit(0);
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
