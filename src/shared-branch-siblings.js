#!/usr/bin/env node
'use strict';

// CLI twin of lib/shared-branch.js for the Python dashboard (one implementation, not two):
//   node src/shared-branch-siblings.js --pipeline <dir> --branch <agent/x> --task <id>
// Prints {"siblings":[{id,state}...]} and exits 0; any failure prints {"error":...} and exits 2 (callers then keep the branch).

const { liveSiblingsOnBranch } = require('./lib/shared-branch.js');

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? null : process.argv[i + 1]; };
const result = liveSiblingsOnBranch({ pipelineDir: arg('pipeline'), branch: arg('branch'), selfId: arg('task') });
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(result.error ? 2 : 0);
