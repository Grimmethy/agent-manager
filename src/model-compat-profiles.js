'use strict';

// Model compatibility profiles (2026-10-24, Grimmethy): small ordered registry of
// per-model quirks that the forced-summary / empty-response path consults before
// deciding how to behave. One file, no dependencies, pure function -- the forced-summary
// path is deep inside the agentic tool loop and adding an import graph there is a
// maintenance liability.
//
// Each profile is one entry in the PROFILES array below. resolveProfile() iterates in
// order and returns a merged quirks object: for every key, the FIRST profile that matches
// contributes its value (first-match-wins per key, not first-match-wins for the whole
// object). Unknown models return {}.
//
// Quirk keys:
//
//   forcedSummaryRetryThink: 'same' | 'off'
//     When the forced-summary turn fires (model ran out of turns or context), should the
//     retry send think:true again? 'off' means omit the think field entirely on the
//     forced-summary call, on the theory that the previous thinking budget was wasted and
//     the model should spend its remaining budget on a plain answer. Default: 'same'.
//     Rationale: 952 forced-summary turns per week were followed by short-thinking retries
//     that burned the remaining budget on reasoning instead of a final answer -- the
//     model kept thinking about what to answer instead of answering. Forcing 'off' on
//     those models skips the second waste.
//
//   salvageThinkingOnEmpty: bool
//     When a turn comes back with empty content but non-empty thinking, should the loop
//     salvage the thinking trace as the response? True means yes, the thinking IS the
//     answer the model produced. Default: false.
//     Rationale: 1,041 empty-response turns per week had thinking traces attached but
//     no content -- the model thought but never wrote a final answer. For models that
//     do this habitually (ornith variants), treating thinking as the answer is better
//     than resampling.
//
// Measured baseline (2026-10-24, tool-loop-audit.log, 7-day window):
//   - 1,041 empty-response turns / week (the primary driver of this module)
//   - 952 forced-summary turns followed by short-thinking retries (the forcedSummaryRetryThink driver)
//   - 87 length-cutoff turns that looked like real answers but were cut off (the detectDegenerate driver)
//   - ~97% of all model calls go to ornith variants (the reason ornith-sparse is first)
//
// These numbers are documented here so future readers can judge whether a profile change
// is fixing a real measured problem or just a hunch. They are NOT asserted in tests --
// the audit log is the source of truth, not this comment.

const PROFILES = [
  // 2026-10-24: ornith variants are the dominant model (~97% of calls) and the primary
  // source of the two quirks this module exists to address. Empty responses with thinking
  // traces, and forced-summary turns that retry with thinking (wasting the final budget),
  // both hit ornith disproportionately. This profile is first in the array for that reason.
  {
    id: 'ornith-sparse',
    match: /^ornith(-p40)?:/,
    quirks: {
      forcedSummaryRetryThink: 'off',
      salvageThinkingOnEmpty: true,
    },
  },
  // Claude/Anthropic models: retry with same thinking setting, salvage thinking on empty
  // (Claude tends to produce useful thinking even when final answer is empty)
  {
    id: 'claude',
    match: /^(anthropic|claude)/i,
    quirks: {
      forcedSummaryRetryThink: 'same',
      salvageThinkingOnEmpty: true,
    },
  },
  // Gemini models: retry with same thinking setting, don't salvage (Gemini's thinking
  // is less reliable as a standalone answer)
  {
    id: 'gemini',
    match: /^(google|gemini)/i,
    quirks: {
      forcedSummaryRetryThink: 'same',
      salvageThinkingOnEmpty: false,
    },
  },
  // OpenAI/GPT models: don't retry with thinking (GPT handles retries differently),
  // don't salvage (GPT rarely produces thinking-only responses)
  {
    id: 'openai',
    match: /^(openai|gpt)/i,
    quirks: {
      forcedSummaryRetryThink: 'off',
      salvageThinkingOnEmpty: false,
    },
  },
  // Local models (Ollama, Llama, etc.): don't retry with thinking (local models often
  // have shorter context and thinking wastes the remaining budget), don't salvage
  {
    id: 'local',
    match: /^(local|ollama|llama|llamacpp)/i,
    quirks: {
      forcedSummaryRetryThink: 'off',
      salvageThinkingOnEmpty: false,
    },
  },
];

// Default quirks applied to any model not matched by a profile. These are the safe
// defaults: retry thinking the same way, don't salvage (the model might be genuinely
// empty and resampling is better than trusting its reasoning trace).
const DEFAULTS = {
  forcedSummaryRetryThink: 'off',
  salvageThinkingOnEmpty: false,
};

// Iterates PROFILES in order. For each quirk key, the first matching profile's value
// wins; unmatched keys fall through to DEFAULTS. Always returns an object with both
// quirk keys populated (defaults for unknown models).
function resolveProfile(modelName) {
  if (typeof modelName !== 'string') return { ...DEFAULTS };
  const merged = {};
  for (const profile of PROFILES) {
    if (!profile.match.test(modelName)) continue;
    for (const key of Object.keys(profile.quirks)) {
      if (!(key in merged)) {
        merged[key] = profile.quirks[key];
      }
    }
  }
  // Merge with defaults for any keys the matched profile(s) didn't set.
  return { ...DEFAULTS, ...merged };
}

// Returns a shallow copy of PROFILES -- callers can inspect the registry without
// mutating it. Each entry is {id, match, quirks} where match is the RegExp and quirks
// is the raw quirks object (not merged with defaults).
function describeProfiles() {
  return PROFILES.map((p) => ({
    id: p.id,
    match: p.match,
    quirks: { ...p.quirks },
  }));
}

module.exports = {
  PROFILES,
  DEFAULTS,
  resolveProfile,
  describeProfiles,
};
