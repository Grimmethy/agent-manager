'use strict';

// Node status CLI: prints the node status table, or the rows as one line of JSON, from the real node registry and lease ledger.
//
// run(argv, env, deps) returns { text, code }: the text to print and the exit code. It never calls process.exit.
//   argv   the arguments after the script name: [] or ['--json']; anything else is a usage error (code 2).
//   deps   optional { listNodes, listLeases, now }; each defaults to the real loader or Date.now. now() is called once per run and
//          the same value goes to listNodes and summarizeNodes.
//   code   0 printed; 1 a loader or summary threw (text is 'node-status-cli: <message>'); 2 usage.
// The main block prints usage and errors to stderr, and the table or JSON to stdout, then sets process.exitCode.

const { summarizeNodes, formatSummary } = require('./node-status.js');
const { listNodes: realListNodes } = require('./node-registry.js');
const { listLeases: realListLeases } = require('./lease-ledger.js');

const USAGE = 'usage: node src/node-status-cli.js [--json]';

function parseFlags(argv) {
  let json = false;
  for (const arg of argv) {
    if (arg !== '--json') return null;
    json = true;
  }
  return { json };
}

function run(argv = [], env = process.env, deps = {}) {
  const flags = parseFlags(argv);
  if (!flags) return { text: USAGE, code: 2 };
  const listNodes = deps.listNodes || realListNodes;
  const listLeases = deps.listLeases || realListLeases;
  const now = deps.now ? deps.now() : Date.now();
  try {
    const nodes = listNodes(env, now);
    const leases = listLeases(env);
    const rows = summarizeNodes(nodes, leases, now);
    return { text: flags.json ? JSON.stringify(rows) : formatSummary(rows), code: 0 };
  } catch (e) {
    return { text: `node-status-cli: ${e.message}`, code: 1 };
  }
}

if (require.main === module) {
  const { text, code } = run(process.argv.slice(2), process.env, {});
  (code === 0 ? process.stdout : process.stderr).write(`${text}\n`);
  process.exitCode = code;
}

module.exports = { run };
