'use strict';

// Node outbox (multi-node plan, piece 7b): tells a worker whether it runs on a NODE (a machine other than wok). A node worker stops after the draft stage:
// scripts/local-worker.sh files the drafted record in queue/node-outbox/ instead of queue/review/, and src/node-package-send.js ships it to wok, where the
// ordinary review, apply, verifier and merge run. A node worker is one whose AGENT_MANAGER_NODE_ID (trimmed) is non-empty and not 'wok' (workerNode in
// src/node-affinity.js, the same rule the claim filter uses).
//
//   node src/node-outbox.js is-node    exit 0 on a node worker, 1 on wok (reads the process environment); anything else prints usage and exits 2.

const { workerNode, LEDGER_OWNER } = require('./node-affinity.js');

function isNodeWorker(env = process.env) {
  return workerNode(env.AGENT_MANAGER_NODE_ID) !== LEDGER_OWNER;
}

function main(argv = process.argv.slice(2), env = process.env, err = process.stderr) {
  if (argv.length === 1 && argv[0] === 'is-node') return isNodeWorker(env) ? 0 : 1;
  err.write('usage: node src/node-outbox.js is-node\n');
  return 2;
}

if (require.main === module) process.exit(main());

module.exports = { isNodeWorker, main };
