'use strict';

// Detects whether a model's implement response was truncated (cut off mid-output)
// rather than being a clean refusal or a valid JSON envelope. Used by the review
// pipeline to reject broken drafts before the decode/apply step.
// Run: node --test src/validate-implement-truncation.test.js

// 2026-09-15 (day-of regression, PR #265 wired this into review-task.js unconditionally
// for every task, then this same needs-clarification sweep root-caused it hours later):
// this used to also fall back to json-fence.js's parseJsonMaybeFenced(), whose
// extractBalancedJson() recovery scans the ENTIRE text for the first '{'/'[' and tries to
// JSON.parse whatever balanced-bracket substring starts there -- built for the APPLY path,
// where recovering a real JSON payload buried in prose is the point. Reused here for
// TRUNCATION DETECTION, it means any normal, COMPLETE adhoc implementResponse (a plain
// "RESOLUTION: implemented" summary followed by `=== DIFF ===` + a real unified diff) gets
// its first '{' or '[' extracted from deep inside actual code (e.g. `function foo() {`),
// fails to parse as JSON, and then failed the old CODE_MARKERS fallback below too (a real
// diff always contains braces/brackets/backticks) -- flagging essentially every correct,
// complete Group-A draft as "truncated". Confirmed live: ~half of all real adhoc/brain-dump
// reviews in the hours after this landed were false-blocked and auto-requeued for a
// from-scratch redraft, burning real retry budget on drafts that were already correct
// (adhoc-add-7-coverage-path-tests-to-src-config-test-js-1789403753654-1's own captured
// blockedReason shows a 7457-char response ending in a complete, ordinary sentence).
//
// Fix: this function now only ever recognizes a LITERAL (optionally fenced) JSON envelope
// -- a whole-string JSON.parse, no "find JSON anywhere in the text" recovery -- and drops
// the CODE_MARKERS-implies-truncated rule entirely; a complete diff or code snippet is
// never itself evidence of truncation. The only real truncation signal this file ever had
// solid evidence for (the 2026-09-08 "Topology" incident: a response that cuts off
// mid-string) is the trailing-unterminated-quote heuristic below, which needs no JSON
// parsing at all and catches that shape whether or not the surrounding text also happens
// to contain code.
const FENCED_JSON_RE = /```(?:json)?\s*\n([\s\S]*?)\n?```/i;

// A RESOLUTION: decompose response is a documented, FIXED-format exception: a
// "RESOLUTION: decompose" line followed by a real JSON array of sub-task proposals (see
// agentic-draft-common.js's own RESOLUTION_RE / decompose handling). Stripping exactly
// this known prefix (never an arbitrary search for '{'/'[' anywhere in the text -- that's
// the extractBalancedJson trap the header above describes) lets a legitimate decompose
// response's trailing JSON parse cleanly even though the line above it isn't JSON itself.
const RESOLUTION_PREFIX_RE = /^RESOLUTION:\s*\S+\s*\n+/i;

/**
 * Detect whether `rawText` looks like a truncated model output.
 *
 * @param {string|null|undefined} rawText - The raw implement response text.
 * @returns {{truncated: boolean, reason: string|null}}
 *   - `{ truncated: true, reason: 'truncated output' }` if the text appears truncated.
 *   - `{ truncated: false, reason: null }` if it looks like a valid (or clean refusal) response.
 */
function detectTruncatedImplementResponse(rawText) {
  // 1. Empty / whitespace-only guard.
  if (rawText == null || rawText.trim() === '') {
    return { truncated: true, reason: 'truncated output' };
  }

  const trimmed = rawText.trim();

  // 2. A literal JSON envelope, whole-string only (optionally fenced) -- a complete Group
  //    B response. NOT extractBalancedJson's "find JSON anywhere" recovery (see header).
  const fenced = trimmed.match(FENCED_JSON_RE);
  const afterResolutionPrefix = trimmed.replace(RESOLUTION_PREFIX_RE, '');
  for (const candidate of [fenced ? fenced[1] : trimmed, afterResolutionPrefix]) {
    try {
      JSON.parse(candidate);
      return { truncated: false, reason: null };
    } catch {
      // Try the next candidate / fall through to the prose/diff heuristic below. Not
      // parsing as JSON is expected and NORMAL for the vast majority of real drafts (a
      // Group A implementResponse is never JSON at all), not itself a sign of trouble.
    }
  }

  // 3. Trailing-unterminated-string heuristic: the last whitespace-delimited token has an
  //    odd number of unescaped double-quotes (e.g. ...return "Topology). The one shape
  //    this file has real incident evidence for -- see header.
  const trailingToken = trimmed.split(/\s+/).pop();
  const unescapedQuotes = (trailingToken.match(/(?<!\\)"/g) || []).length;
  if (unescapedQuotes % 2 !== 0) {
    return { truncated: true, reason: 'truncated output' };
  }

  return { truncated: false, reason: null };
}

module.exports = { detectTruncatedImplementResponse };
