'use strict';

// instances-dir.js -- where a lane's SHARED runtime state lives: heartbeats, GPU locks/tickets (single-flight-lock.js, gpu-arbiter.js), the
// priority markers, the "is this lane alive" checks.
//
// That state has always been <pipelineDir>/instances/. It must not follow a project context: when an idle lane borrows work from another suite
// project (docs/idle-pool-borrowing.md) the borrowed invocation runs with that project's AGENT_MANAGER_PIPELINE_DIR, yet the lane is still ONE
// lane on ONE GPU -- its heartbeat, and every lock it takes, must stay in its HOME instances dir or two projects' processes would not see each
// other's locks and would hit one Ollama at once (the GPU-thrashing class already fixed once). AGENT_MANAGER_INSTANCES_DIR pins it.
//
// Project-LOCAL instance artifacts (pipeline-history.log, the due-markers of the periodic audits, uptime samples) deliberately keep using
// <pipelineDir>/instances/ directly: they describe that project, not the lane.

const path = require('path');

function sharedInstancesDir(pipelineDir) {
  const override = String(process.env.AGENT_MANAGER_INSTANCES_DIR || '').trim();
  if (override) return override;
  return path.join(pipelineDir, 'instances');
}

module.exports = { sharedInstancesDir };
