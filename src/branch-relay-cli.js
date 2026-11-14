'use strict';

// Relay command line (multi-node plan, piece 5b): relays the branch of a package that arrived at the package intake (src/package-intake-server.js).
//
//   node src/branch-relay-cli.js <taskId> --node-url <url> [--repo <path>]
//
// Reads <AGENT_MANAGER_PIPELINE_DIR>/queue/node-packages/<taskId>.json, checks it with validatePackage (src/review-package.js) and calls relayBranch
// (src/branch-relay.js) with the package's branch and sha in --repo (default AGENT_MANAGER_REPO_ROOT). Prints one JSON line {ok, reason}.
// Exit codes: 0 relayed, 3 not relayed (missing or invalid package, or the relay refused), 2 usage. Nothing runs this by itself.

const fs = require('fs');
const path = require('path');
const { validatePackage } = require('./review-package.js');
const { relayBranch } = require('./branch-relay.js');
const { TASK_ID_RE } = require('./node-intake-server.js');

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function readPackage(pipelineDir, taskId) {
  try { return JSON.parse(fs.readFileSync(path.join(pipelineDir, 'queue', 'node-packages', `${taskId}.json`), 'utf8')); } catch (e) { return null; }
}

function run(argv, env = process.env, deps = {}) {
  const out = deps.out || ((s) => process.stdout.write(`${s}\n`));
  const relay = deps.relay || relayBranch;
  const taskId = argv[0];
  const nodeUrl = flag(argv, '--node-url');
  const pipelineDir = String(env.AGENT_MANAGER_PIPELINE_DIR || '').trim();
  const repo = flag(argv, '--repo') || String(env.AGENT_MANAGER_REPO_ROOT || '').trim();
  if (!taskId || taskId.startsWith('--') || !TASK_ID_RE.test(taskId) || !nodeUrl || !pipelineDir || !repo) {
    process.stderr.write('usage: node src/branch-relay-cli.js <taskId> --node-url <url> [--repo <path>] (needs AGENT_MANAGER_PIPELINE_DIR, and --repo or AGENT_MANAGER_REPO_ROOT)\n');
    return 2;
  }
  const pkg = readPackage(pipelineDir, taskId);
  if (!pkg) { out(JSON.stringify({ ok: false, reason: `no readable package for ${taskId} in queue/node-packages` })); return 3; }
  const v = validatePackage(pkg);
  if (!v.ok) { out(JSON.stringify({ ok: false, reason: `the package is not valid: ${v.reason}` })); return 3; }
  if (pkg.taskId !== taskId) { out(JSON.stringify({ ok: false, reason: 'the package is for another task' })); return 3; }
  const r = relay({ branch: pkg.branch, sha: pkg.sha, nodeUrl, repoRoot: repo });
  out(JSON.stringify({ ok: Boolean(r && r.ok), reason: String((r && r.reason) || '') }));
  return r && r.ok ? 0 : 3;
}

if (require.main === module) process.exitCode = run(process.argv.slice(2));

module.exports = { run, readPackage };
