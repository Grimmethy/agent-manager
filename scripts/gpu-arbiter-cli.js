#!/usr/bin/env node
'use strict';

// Thin CLI over src/gpu-arbiter.js for the non-Node callers (the dashboard's chat-preempt,
// operator debugging). Not used by the worker/reviewer lanes -- those require() the module
// directly.
//
//   node scripts/gpu-arbiter-cli.js cancel-below [--model M] [--cls interactive]
//       -> mark every lower-class GPU ticket cancelRequested + SIGKILL any active holder.
//          Prints a JSON array: [{ pid, cls, taskId, action }]
//   node scripts/gpu-arbiter-cli.js status [--model M]
//       -> { holder, waiting } for the dashboard.
//
// --model defaults to $LOCAL_MODEL. instancesDir comes from getConfig().

const path = require('path');
const arb = require(path.join(__dirname, '..', 'src', 'gpu-arbiter.js'));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function instancesDir() {
  try {
    return path.join(require(path.join(__dirname, '..', 'src', 'config.js')).getConfig().pipelineDir, 'instances');
  } catch {
    const pd = process.env.AGENT_MANAGER_PIPELINE_DIR || process.env.AGENT_MANAGER_REPO_ROOT;
    return pd ? path.join(pd, 'instances') : null;
  }
}

const cmd = process.argv[2];
const model = arg('model', process.env.LOCAL_MODEL || '');
const dir = instancesDir();

if (!dir) { process.stderr.write('gpu-arbiter-cli: cannot resolve instances dir\n'); process.exit(2); }

if (cmd === 'cancel-below') {
  const cls = arg('cls', 'interactive');
  let out = [];
  try { out = arb.cancelBelow(dir, model, cls); } catch (e) { process.stderr.write(`gpu-arbiter-cli: ${e.message}\n`); }
  process.stdout.write(JSON.stringify(out));
} else if (cmd === 'status') {
  let out = { holder: null, waiting: [] };
  try { out = arb.status(dir, model); } catch (e) { process.stderr.write(`gpu-arbiter-cli: ${e.message}\n`); }
  process.stdout.write(JSON.stringify(out));
} else {
  process.stderr.write('usage: gpu-arbiter-cli.js <cancel-below|status> [--model M] [--cls C]\n');
  process.exit(1);
}
