'use strict';

// Forces a full-coverage arch_discovery sweep instead of waiting on the normal one-
// community-per-tick rotation (2026-09-24, user request: the project needed an
// architecture-review pass after a large volume of recent changes, and the last real
// activity -- arch-review-ac-31, 2026-09-21 -- only reviewed a single generated candidate,
// not a full pass across every module/community).
//
// Queues one arch_discovery task per community.json entry that doesn't already have an
// in-flight or terminal task (same taskIdExistsInQueue dedup the normal picker uses), all
// at once, straight into queue/pending/. arch_discovery is already the highest-priority
// generator on the ladder (AGENT_MANAGER_TASK_PRIORITIES in agent-manager.env: arch_review
// 1 / arch_import_review 2 / arch_discovery 3), so the already-running local workers
// (local-worker.sh, 60s ticks) drain this backlog on their normal cadence with no other
// changes needed -- see agent-manager-hygiene/src/arch.js's allPendingArchDiscoveryTasks().
//
// Usage: node scripts/force-arch-discovery-sweep.js

const path = require('path');
const { ensureRegistered, getConfig } = require('../src/config.js');
const { writeTask, taskIdExistsInQueue } = require('../src/task-sources.js');

ensureRegistered();

// Resolved off plugins.json's own registerPath, same as agent-manager's plugin loader --
// there's no node_modules symlink from core back to the hygiene plugin (only the reverse),
// so a bare require('agent-manager-hygiene/...') would fail.
const plugins = require('../plugins.json');
const hygienePlugin = plugins.find((p) => p.name === 'agent-manager-hygiene');
if (!hygienePlugin) {
  console.error('agent-manager-hygiene plugin not found in plugins.json -- arch_discovery lives there.');
  process.exit(1);
}
const archPath = path.join(path.dirname(hygienePlugin.registerPath), 'src', 'arch.js');
const { allPendingArchDiscoveryTasks } = require(archPath);

const tasks = allPendingArchDiscoveryTasks({ getConfig, taskIdExistsInQueue });

if (tasks.length === 0) {
  console.log('Nothing to queue -- every community already has an in-flight or terminal arch_discovery task.');
  process.exit(0);
}

for (const task of tasks) {
  const file = writeTask(task);
  console.log(`queued: ${file}`);
}

console.log(`\nQueued ${tasks.length} arch_discovery task(s) for a full-coverage sweep.`);
