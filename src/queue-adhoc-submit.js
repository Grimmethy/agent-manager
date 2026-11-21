#!/usr/bin/env node
'use strict';
// Adhoc submit CLI: files ONE adhoc task into a chosen pipeline directory.
// Usage: node src/queue-adhoc-submit.js '<json>'
// The JSON object (passed as argv[2], not a shell string) takes:
//   title (non-empty string), promptContext (truthy, passed to the library),
//   premium (optional boolean), pipelineDir (non-empty string), raisedFrom (optional string).
// domain is always 'adhoc' and is not read from the input.
// Prints one JSON line {id, filePath} on success (exit 0). Any failure writes to stderr and exits 1.
// Every check runs before the library call, so no directory or file is created on a bad argument.

const path = require('path');
const { queueAdhocTask } = require('./queue-adhoc-task.js');

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function main() {
  const raw = process.argv[2];
  if (raw === undefined) {
    fail('Usage: node queue-adhoc-submit.js \'<json object>\'');
    return;
  }

  let input;
  try {
    input = JSON.parse(raw);
  } catch (e) {
    fail(`Invalid JSON argument: ${e.message}`);
    return;
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('Argument must be a JSON object');
    return;
  }

  const { title, promptContext, premium, pipelineDir, raisedFrom } = input;
  if (typeof title !== 'string' || !title.trim()) {
    fail('title must be a non-empty string');
    return;
  }
  if (typeof pipelineDir !== 'string' || !pipelineDir.trim()) {
    fail('pipelineDir must be a non-empty string');
    return;
  }
  if (premium !== undefined && typeof premium !== 'boolean') {
    fail('premium must be a boolean when given');
    return;
  }

  const pipeline = path.resolve(pipelineDir);
  const domainsPath = path.join(pipeline, 'task-domains.json');

  // Same env-swap pattern as the --scratch branch of queue-adhoc-task.js; every key is restored in finally.
  // config.js's getConfig() requires AGENT_MANAGER_REPO_ROOT (the consumer repo root). queueAdhocTask is
  // given explicit paths and does not call getConfig() itself, so this default only keeps the environment
  // consistent for anything nested. It defaults to the current working directory, which is an assumption.
  const keys = ['AGENT_MANAGER_PIPELINE_DIR', 'AGENT_MANAGER_DOMAINS_PATH', 'AGENT_MANAGER_REPO_ROOT'];
  const saved = {};
  for (const k of keys) saved[k] = process.env[k];

  process.env.AGENT_MANAGER_PIPELINE_DIR = pipeline;
  process.env.AGENT_MANAGER_DOMAINS_PATH = domainsPath;
  if (!process.env.AGENT_MANAGER_REPO_ROOT) process.env.AGENT_MANAGER_REPO_ROOT = process.cwd();

  try {
    const { record, filePath } = queueAdhocTask(
      {
        title,
        promptContext,
        domain: 'adhoc',
        premiumPriority: premium === true,
        raisedFrom,
      },
      { pipelineDir: pipeline, domainsPath },
    );
    console.log(JSON.stringify({ id: record.id, filePath }));
  } catch (e) {
    fail(e.message);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

if (require.main === module) main();

module.exports = { main };
