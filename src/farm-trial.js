'use strict';

// Trial scorer (multi-node plan, piece 5c): the bar a node's work has to clear before the farm is scaled up. A trial is a batch of real small tasks run through
// a node; each ends as 'merged' (merged with no repair), 'repaired' (merged after a repair), 'failed' or 'abandoned'. The trial passes when at least 80 percent
// were merged with no repair.
//
//   scoreTrial(outcomes) -> {total, clean, share, passes, byNode}
//   node src/farm-trial.js <outcomes.json>      (a JSON array of {taskId, node, result}) prints the result; exit 0 passes, 3 fails, 2 usage
//
// Nothing here starts a trial or reads the pipeline: the outcomes are written down by the owner or a later piece. See docs/agents/multi-node-runbook.md.

const fs = require('fs');

const TRIAL_BAR = 0.8;
const RESULTS = ['merged', 'repaired', 'failed', 'abandoned'];

function scoreTrial(outcomes) {
  if (!Array.isArray(outcomes)) throw new Error('outcomes must be an array');
  const byNode = {};
  let clean = 0;
  outcomes.forEach((o, i) => {
    if (!o || !RESULTS.includes(o.result)) {
      throw new Error(`outcome ${i} has an unknown result ${JSON.stringify(o && o.result)} (expected one of ${RESULTS.join(', ')})`);
    }
    const node = typeof o.node === 'string' && o.node ? o.node : 'unknown';
    byNode[node] = byNode[node] || { total: 0, clean: 0 };
    byNode[node].total += 1;
    if (o.result === 'merged') { byNode[node].clean += 1; clean += 1; }
  });
  const total = outcomes.length;
  const share = total === 0 ? 0 : clean / total;
  return { total, clean, share, passes: share >= TRIAL_BAR, byNode };
}

function main(argv, out = (s) => process.stdout.write(`${s}\n`)) {
  const file = argv[0];
  if (!file) { process.stderr.write('usage: node src/farm-trial.js <outcomes.json>\n'); return 2; }
  let result;
  try {
    result = scoreTrial(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    process.stderr.write(`farm-trial: ${e.message}\n`);
    return 2;
  }
  out(JSON.stringify(result));
  return result.passes ? 0 : 3;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { scoreTrial, main, TRIAL_BAR, RESULTS };
