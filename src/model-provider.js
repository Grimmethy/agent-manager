'use strict';

// Per-task-source model backend selection: routes ornith-draft.js's/review-task.js's
// default `call`/`majorityVote` between the local Ollama model (ornith-client.js) and
// Claude Code CLI under a subscription (claude-client.js), by task.source.
//
// Added 2026-08-16 alongside claude-client.js specifically so this doesn't repeat
// model-strategies.js's own fate -- that module (per-model generation-parameter
// overrides) shipped fully built and tested but was never actually wired into
// ornith-draft.js/ornith-client.js on the Linux port, so it's had zero real callers
// since. The mechanism here is deliberately the smallest thing that actually gets
// used: one env var, one lookup function, called from the one place selection happens.
//
// AGENT_MANAGER_CLAUDE_SOURCES: comma-separated task.source values that should draft
// (and, for review-task.js, vote) using Claude instead of the local model. Empty/unset
// means every source stays on Ornith -- i.e. this integration is fully opt-in per
// source, never a silent default switch.

const ornith = require('./ornith-client.js');
const claude = require('./claude-client.js');

const CLAUDE_SOURCES = new Set(
  (process.env.AGENT_MANAGER_CLAUDE_SOURCES || '').split(',').map((s) => s.trim()).filter(Boolean),
);

function providerFor(source) {
  return CLAUDE_SOURCES.has(source) ? claude : ornith;
}

// Display/stats label for whichever backend providerFor(source) actually picked --
// used for model-stats.db's `model` column (see model-stats-client.js) so a call
// routed to Claude is recorded as such instead of the previous hardcoded 'ornith',
// which would have silently mislabeled every Claude-served call once this routing
// existed. Separate from providerFor() itself (rather than attaching `.label` to the
// ornith/claude module objects) so providerFor()'s return value stays exactly the
// required module -- model-provider.test.js asserts identity against it.
function labelFor(source) {
  if (!CLAUDE_SOURCES.has(source)) return process.env.ORNITH_MODEL || 'ornith';
  return `claude:${process.env.CLAUDE_MODEL || 'sonnet'}`;
}

module.exports = { providerFor, labelFor };
