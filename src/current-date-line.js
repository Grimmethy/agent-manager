'use strict';

// Single shared source of truth for "what is today's real date" across every model
// call in this pipeline -- Grimmethy, 2026-08-24: pipeline-hardening follow-up after a
// real incident where review-task.js's buildVerdictPrompt had no anchor for "today" at
// all and rejected a well-sourced research draft for citing "future" dates that were
// actually already in the past. Patching that ONE prompt fixed that ONE incident, but an
// audit right after found the exact same gap in every other prompt builder in this
// codebase (drafting, research's own prompt, discuss) -- any of them could hit the same
// failure independently, and a piecemeal per-prompt fix only ever closes the instance
// that already bit someone. Injected once, at the two real choke points every prompt in
// this pipeline flows through (claude-client.js's callOnce, local-client.js's callOnce),
// so no future prompt builder can reintroduce this gap by simply forgetting to call a
// helper -- it's not opt-in.

function currentDateLine() {
  return `(Real current date: ${new Date().toISOString().slice(0, 10)} -- do not assume ` +
    'an earlier date is "now." Judge recency/plausibility of any date, URL, or event ' +
    'against this real date, not your own training-data intuition of "the present.")';
}

module.exports = { currentDateLine };
