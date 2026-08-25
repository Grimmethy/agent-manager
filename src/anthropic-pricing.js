'use strict';

// Real Anthropic API per-token pricing, used to estimate "what would this call have cost
// on the API" for calls that DIDN'T go through the API at all -- a local Ollama call.
//
// Grimmethy, 2026-08-23: "Clarification on the anthropic costs. I'd like estimates for if
// we had used the API. Even if we used the local models." -- claude-client.js's own
// costUsd (Claude Code CLI's own total_cost_usd) already answers this for a call that
// genuinely WAS made to Claude; this module is the other half, for a call that ran on
// the local model instead, computed from the real prompt_eval_count/eval_count token
// counts Ollama already reports for every call (see model-stats-client.js's own
// evalCount/promptEvalCount fields, recorded since before this feature existed).
//
// Rates confirmed live via web search 2026-08-23 (multiple independent pricing-tracker
// sources, consistent with each other): $ per MILLION tokens, input/output.
//   Sonnet 5: $2 / $10   -- INTRODUCTORY rate, through 2026-08-31 only; standard rate
//                           takes effect 2026-09-01 -- this table will need updating
//                           after that date, or the estimate will silently under-count.
//   Opus 5:   $5 / $25
//   Haiku 4.5:$1 / $5
//   Fable 5:  $10 / $50
// Not sourced from Anthropic's own pricing page directly (not separately indexed at
// search time) -- cross-checked against several independent aggregator sources that all
// agreed, but treat this table as a maintained approximation, not a contractual rate.
const PRICING_PER_MILLION_TOKENS = {
  sonnet: { input: 2, output: 10 },
  opus: { input: 5, output: 25 },
  haiku: { input: 1, output: 5 },
  fable: { input: 10, output: 50 },
};

// Same resolution claude-client.js/model-provider.js/adhoc-agentic-draft.js already use
// for "which Claude model would this pipeline actually pick" -- reused here so the
// hypothetical estimate reflects the SAME model this call would really route to if
// AGENT_MANAGER_FORCE_PROVIDER=claude were set, not an arbitrarily different tier.
function defaultClaudeModel() {
  return process.env.CLAUDE_MODEL || 'sonnet';
}

// Strips a leading "claude:" label prefix and any trailing version suffix Anthropic
// sometimes appends (e.g. "claude-sonnet-4-5" -> "sonnet") down to the bare tier name
// this table is keyed by -- best-effort: an unrecognized name falls back to the default
// model's rate rather than silently pricing at $0, since "unrecognized" is far more
// likely to be a naming drift in this table than a genuinely free model.
function normalizeModelName(model) {
  const bare = (model || '').replace(/^claude:/, '').toLowerCase();
  for (const key of Object.keys(PRICING_PER_MILLION_TOKENS)) {
    if (bare.includes(key)) return key;
  }
  return defaultClaudeModel();
}

/**
 * Estimates the Anthropic API cost of a call that may or may not have actually gone
 * through the API -- given real prompt/completion token counts (Ollama's own
 * prompt_eval_count/eval_count for a local call, or the equivalent for a real Claude
 * call). Returns 0 (not null) when both counts are missing/zero, since "no tokens" is a
 * real, valid input, not an error.
 * @param {object} opts
 * @param {number} [opts.promptTokens] - Input/prompt token count.
 * @param {number} [opts.completionTokens] - Output/completion token count.
 * @param {string} [opts.model] - Which Claude tier to price against -- defaults to
 *   defaultClaudeModel() (CLAUDE_MODEL env, same as the rest of this pipeline).
 * @returns {number}
 */
function estimateApiCostUsd({ promptTokens = 0, completionTokens = 0, model } = {}) {
  const rates = PRICING_PER_MILLION_TOKENS[normalizeModelName(model)];
  const inputCost = ((promptTokens || 0) / 1_000_000) * rates.input;
  const outputCost = ((completionTokens || 0) / 1_000_000) * rates.output;
  return inputCost + outputCost;
}

module.exports = { estimateApiCostUsd, defaultClaudeModel, normalizeModelName, PRICING_PER_MILLION_TOKENS };
