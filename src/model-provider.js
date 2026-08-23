'use strict';

// Per-task-source model backend selection: routes local-draft.js's/review-task.js's
// default `call`/`majorityVote` between the local Ollama model (local-client.js) and
// Claude Code CLI under a subscription (claude-client.js), by task.source.
//
// Added 2026-08-16 alongside claude-client.js specifically so this doesn't repeat
// model-strategies.js's own fate -- that module (per-model generation-parameter
// overrides) shipped fully built and tested but was never actually wired into
// local-draft.js/local-client.js on the Linux port, so it's had zero real callers
// since. The mechanism here is deliberately the smallest thing that actually gets
// used: one env var, one lookup function, called from the one place selection happens.
//
// AGENT_MANAGER_CLAUDE_SOURCES: comma-separated task.source values that should draft
// (and, for review-task.js, vote) using Claude instead of the local model. Empty/unset
// means every source stays on Ornith -- i.e. this integration is fully opt-in per
// source, never a silent default switch.

const local = require('./local-client.js');
const claude = require('./claude-client.js');
const { getRegisteredSource, resolveSourceName } = require('./task-source-registry.js');

const CLAUDE_SOURCES = new Set(
  (process.env.AGENT_MANAGER_CLAUDE_SOURCES || '').split(',').map((s) => s.trim()).filter(Boolean),
);

// Accepts either a bare source-name string (legacy call shape, still used by
// model-provider.test.js and anywhere else that only has the string on hand) or a full
// task object -- normalized to a task-shaped object either way so reasoningTierFor() has
// one consistent input.
function normalizeTask(sourceOrTask) {
  return typeof sourceOrTask === 'string' ? { source: sourceOrTask } : (sourceOrTask || {});
}

// Single source of truth for "should this task run on the high-reasoning (Claude) or
// low-reasoning (Ornith) tier" -- used by providerFor()/labelFor() below AND by
// local-worker.sh's worker-lane claim filter (via a `node -e` call into this module), so
// the two can never disagree about which lane a task belongs on. Checked in order:
//   1. task.reasoningTier -- a per-instance override, e.g. the Brain Dump #77 automatic
//      high-reasoning retry for a needs-clarification task whose FIRST (low-tier) attempt
//      already failed to resolve confidently (see task-sources.js's
//      nextPathPrefetchResolveTask()) -- the same *source* (path_prefetch_resolve) needs
//      to run on different tiers depending on which attempt this is, which a static
//      per-source default alone can't express.
//   2. the task's registered source's own static `reasoningTier` (e.g. adhoc, registered
//      'high' in task-sources.js -- though adhoc's actual draft call is hardcoded to
//      Claude via local-draft.js's own resolveSourceName()==='adhoc' branch regardless;
//      this registration exists so the worker-lane filter agrees with that by
//      construction rather than by two people remembering to update two places).
//   3. AGENT_MANAGER_CLAUDE_SOURCES (pre-existing opt-in env var, kept for compatibility).
//   4. default: 'low'.
function reasoningTierFor(task) {
  const t = normalizeTask(task);
  if (t.reasoningTier) return t.reasoningTier;
  const entry = getRegisteredSource(resolveSourceName(t));
  if (entry && entry.reasoningTier) return entry.reasoningTier;
  if (CLAUDE_SOURCES.has(t.source)) return 'high';
  return 'low';
}

// AGENT_MANAGER_FORCE_PROVIDER ('local'|'claude'): per-process override set by
// local-worker.sh's refresh_active_model() when the Workers tab's worker-reasoning
// dropdown picks a local model instead of a Claude one (2026-08-18, Grimmethy: "reasoning
// is set to only show subscription models -- I need to be able to select from both
// subscription and local models"). Only local-worker.sh's worker-reasoning* lane ever
// sets this; every other caller of providerFor() (worker-1's low-tier tasks, reviewer's
// votes, etc.) is unaffected since the env var is unset in their process tree. Checked
// BEFORE reasoningTierFor()-based routing so it wins regardless of the task's own tier --
// but adhoc/research_task's agentic implement calls (local-draft.js's own
// resolveSourceName()==='adhoc'/'research_task' branches) bypass providerFor() entirely
// and are never affected either way; those need Claude Code CLI's real tool access
// (Read/Edit/Bash/WebSearch), which Ornith cannot provide, so forcing them onto a local
// model would silently produce garbage instead of a real implementation -- this override
// only ever reaches the generic, non-agentic call/majorityVote path.
function forcedProvider() {
  const forced = process.env.AGENT_MANAGER_FORCE_PROVIDER;
  if (forced === 'local') return local;
  if (forced === 'claude') return claude;
  return null;
}

function providerFor(sourceOrTask) {
  return forcedProvider() || (reasoningTierFor(sourceOrTask) === 'high' ? claude : local);
}

// Display/stats label for whichever backend providerFor(source) actually picked --
// used for model-stats.db's `model` column (see model-stats-client.js) so a call
// routed to Claude is recorded as such instead of a generic local-backend label,
// which would have silently mislabeled every Claude-served call once this routing
// existed. Separate from providerFor() itself (rather than attaching `.label` to the
// local/claude module objects) so providerFor()'s return value stays exactly the
// required module -- model-provider.test.js asserts identity against it.
// No hardcoded fallback tag if LOCAL_MODEL is unset -- see local-client.js's own comment
// for why (2026-08-22, Grimmethy: "models should be fully interchangeable and their
// names should not be hardcoded anywhere").
function labelFor(sourceOrTask) {
  const forced = process.env.AGENT_MANAGER_FORCE_PROVIDER;
  if (forced === 'local') return process.env.LOCAL_MODEL;
  if (forced === 'claude') return `claude:${process.env.CLAUDE_MODEL || 'sonnet'}`;
  if (reasoningTierFor(sourceOrTask) !== 'high') return process.env.LOCAL_MODEL;
  return `claude:${process.env.CLAUDE_MODEL || 'sonnet'}`;
}

module.exports = { providerFor, labelFor, reasoningTierFor };
