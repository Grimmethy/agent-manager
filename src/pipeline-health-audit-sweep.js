'use strict';

// Always-run wrapper around task-sources.js's nextPipelineHealthAuditTask(), invoked
// directly from queue-watcher.sh's watchdog tick -- alongside coordinator-sweep.js,
// blocked-cluster-sweep.js, and this pipeline's other genuine watchdog sweeps -- instead
// of only ever being reachable through getNextTask()'s priority ladder.
//
// Root-caused live (2026-09-15): a real Ollama-hang incident ran for 22+ hours -- every
// worker's draft call timed out, throughput fully stopped, 80+ tasks piled up in
// pending/. pipeline-health-audit.js's own LOG_ERROR_SIGNATURES already recognizes this
// exact shape ('ollama-request-timeout'), and nextPipelineHealthAuditTask() would have
// filed an actionable finding -- but instances/.health-audit-schedule.json's
// lastCheckedAt hadn't moved in 38+ hours, because that function was ONLY ever invoked
// as a registered task source (priority 90, "just under staleness_audit -- an
// operational incident can be actively costing throughput/compute"). That reasoning
// assumed a finite priority number was enough; it isn't, for a source whose whole job is
// "notice something is systemically wrong" -- the higher-priority backlog it competes
// against in getNextTask()'s ladder is EXACTLY what piles up while something is wrong,
// so it never got a turn precisely when it mattered most. No priority number fixes that;
// it has to run independent of the ladder, like its true siblings (coordinator-sweep.js
// etc.) already do.
//
// nextPipelineHealthAuditTask() itself is untouched and still separately reachable via
// the priority ladder (registerTaskSource('pipeline_health_audit', ...) in
// task-sources.js) -- harmless if a quiet tick ever lets it fire there too: both paths
// share the same instances/.health-audit-schedule.json isDue()/markChecked() gate, so
// whichever runs first within the hourly window satisfies it and the other is a no-op.
// This sweep is just the guarantee that AT LEAST one of the two paths runs every tick,
// regardless of backlog size.

const { nextPipelineHealthAuditTask, writeTask } = require('./task-sources.js');
const { sourceEligibleHere } = require('./lib/source-scope.js');

function pipelineHealthAuditSweep({ next = nextPipelineHealthAuditTask, write = writeTask } = {}) {
  // Audits agent-manager's own daemons/queue health -- meaningless (and it outranked PF's hygiene reviews) on
  // any other project. This sweep calls the source directly, so it needs its own core-scope check.
  if (!sourceEligibleHere({ scope: 'core' })) return { filed: false, skipped: 'core-scope: active project is not agent-manager' };
  let task;
  try {
    task = next();
  } catch (e) {
    return { filed: false, error: e.message };
  }
  if (!task) return { filed: false };
  const file = write(task);
  return { filed: true, file, title: task.title };
}

module.exports = { pipelineHealthAuditSweep };

if (require.main === module) {
  process.stdout.write(JSON.stringify(pipelineHealthAuditSweep()));
}
