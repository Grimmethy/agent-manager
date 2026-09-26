'use strict';

// Swap point for "how does an adhoc task get assessed for decomposition" (S4b of the
// hub-tasks extraction, producer 1, 2026-09-25). decompose-pass.js (the prompt-building +
// model-calling primitive) moved to the agent-manager-hub-tasks plugin; draft-context.js's
// preliminary check and local-agentic-write-draft.js's give-up backstop now call through
// this hook instead of requiring decompose-pass.js directly.
//
// Unlike candidate-split-hub-route.js (S4b, producer 4), an unregistered runner does NOT
// throw here: this hook is on the hot path for EVERY fresh adhoc task's draft, not a rare
// gated apply-time path, so a plugin load hiccup must degrade to "skip the decompose
// check, draft the task normally" rather than stall the whole adhoc lane. The preliminary-
// decompose / give-up-backstop OPTIMIZATIONS become unavailable, not the pipeline.

let current = null;

function getDecomposePassRunner() {
  return current;
}

// A single swap point, not a registry -- same discipline as every other S1-S4b hook.
// Passing no argument (or a falsy value) clears it back to unregistered; used by tests to
// reset state between runs since this module is a singleton for the life of the process.
function setDecomposePassRunner(runner) {
  current = runner || null;
}

// task, opts -> the same shape decompose-pass.js's runDecomposePass returns: {subTasks} or
// null. Never throws (runDecomposePass itself already swallows model-call failures; this
// only adds "no plugin loaded" as one more null-returning case).
async function runDecomposePassIfAvailable(task, opts) {
  const runner = current;
  if (!runner) return null;
  return runner.runDecomposePass(task, opts);
}

module.exports = { getDecomposePassRunner, setDecomposePassRunner, runDecomposePassIfAvailable };
