'use strict';

const { getRegisteredSource } = require('./task-source-registry.js');

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
// fails to parse as JSON, and then failed the old code-marker fallback below too (a real
// diff always contains braces/brackets/backticks) -- flagging essentially every correct,
// complete Group-A draft as "truncated". Confirmed live: ~half of all real adhoc/brain-dump
// reviews in the hours after this landed were false-blocked and auto-requeued for a
// from-scratch redraft, burning real retry budget on drafts that were already correct
// (adhoc-add-7-coverage-path-tests-to-src-config-test-js-1789403753654-1's own captured
// blockedReason shows a 7457-char response ending in a complete, ordinary sentence).
//
// Fix: this function now only ever recognizes a LITERAL (optionally fenced) JSON envelope
// -- a whole-string JSON.parse, no "find JSON anywhere in the text" recovery -- and drops
// the code-marker-implies-truncated rule entirely; a complete diff or code snippet is
// never itself evidence of truncation. The only real truncation signal this file ever had
// solid evidence for (the 2026-09-08 "Topology" incident: a response that cuts off
// mid-string) is the trailing-unterminated-quote heuristic below, which needs no JSON
// parsing at all and catches that shape whether or not the surrounding text also happens
// to contain code.
//
// ADVISORY-PROSE CONTRACT (2026-08-29, requested by the self-audit
// pipeline-self-audit-function_length_review-truncated-draft-1788034686181 -- 5
// function_length_review drafts false-blocked on code markers in prose): an optional
// second argument `source` names the task's source. When it resolves to a registered
// source entry with the `advisoryProse` flag -- the SAME flag review-task.js's
// isAdvisoryProseSource() reads, which already exempts those sources from its own
// non-implementation gate -- a legitimate code-bearing advisory-prose draft (e.g.
// function_length_review) can NEVER be flagged truncated: detectTruncatedImplementResponse
// returns { truncated: false, reason: null } immediately after the empty-string guard and
// before any heuristic runs. This is intentional: advisory prose is supposed to quote and
// discuss code, so brace/bracket/backtick/quote content in it is not a truncation signal.
const FENCED_JSON_RE = /```(?:json)?\s*\n([\s\S]*?)\n?```/i;

// A RESOLUTION: decompose response is a documented, FIXED-format exception: a
// "RESOLUTION: decompose" line followed by a real JSON array of sub-task proposals (see
// agentic-draft-common.js's own RESOLUTION_RE / decompose handling). Stripping exactly
// this known prefix (never an arbitrary search for '{'/'[' anywhere in the text -- that's
// the extractBalancedJson trap the header above describes) lets a legitimate decompose
// response's trailing JSON parse cleanly even though the line above it isn't JSON itself.
const RESOLUTION_PREFIX_RE = /^RESOLUTION:\s*\S+\s*\n+/i;

// COMPLETE-DIFF EXEMPTION (2026-10-18). A Group A implementResponse ends with its unified diff, so rule 4's "last token" is whatever the
// diff's last CONTEXT line ends with -- code the draft never wrote. Two real false blocks: a premium-reach task whose diff ended on an
// unchanged comment `... "we need to build this sort of analysis into the daily report"` (last token `report"`), and HUB0073-01, whose diff
// ended on the close of a quoted comment opened a line earlier (`... projects"):`) -- so a last-LINE quote count would be wrong too. For a
// diff the real truncation test is structural: a cut-off diff leaves its last hunk short of the line counts its `@@ -a,b +c,d @@` header
// declares. diffIsComplete() checks exactly that; a complete diff is never "truncated output". Bump TRUNCATION_GATE_VERSION whenever this
// gate's rules change: needs-clarification-triage.js bucket J re-admits a task once per version when the current gate passes it.
const TRUNCATION_GATE_VERSION = '2026-10-18-complete-diff';
const DIFF_MARKER = '=== DIFF ===';
const HUNK_RE = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

function diffIsComplete(text) {
  const at = typeof text === 'string' ? text.indexOf(DIFF_MARKER) : -1;
  if (at < 0) return false;
  const lines = text.slice(at + DIFF_MARKER.length).split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();   // the diff's own trailing newline(s)
  let hunks = 0;
  let left = null;                                                       // { old, new } still owed by the current hunk
  for (const line of lines) {
    const h = HUNK_RE.exec(line);
    if (h) {
      if (left && (left.old > 0 || left.new > 0)) return false;          // the previous hunk ended early
      left = { old: h[1] === undefined ? 1 : Number(h[1]), new: h[2] === undefined ? 1 : Number(h[2]) };
      hunks += 1;
      continue;
    }
    // Once a hunk has all its declared lines, what follows until the next @@ is file headers (`diff --git`, `--- a/`, `+++ b/`, `index`, ...)
    // and is skipped; truncation only ever REMOVES lines from the end, so over-long hunks are not this gate's concern. Known limit: a cut that
    // lands exactly between two hunks or files leaves a diff that looks complete (the old token rule caught that only by chance).
    if (!left || (left.old === 0 && left.new === 0)) { left = null; continue; }
    if (line.startsWith('\\')) continue;                                   // "\ No newline at end of file"
    const c = line[0];
    if (c === ' ' || line === '') { left.old -= 1; left.new -= 1; }      // context (an empty line is an empty context line)
    else if (c === '-') left.old -= 1;
    else if (c === '+') left.new -= 1;
    else return false;                                                   // not a diff line inside a hunk
    if (left.old < 0 || left.new < 0) return false;
  }
  return hunks > 0 && (!left || (left.old === 0 && left.new === 0));
}

/**
 * Detect whether `rawText` looks like a truncated model output.
 *
 * @param {string|null|undefined} rawText - The raw implement response text.
 * @param {string|null|undefined} [source] - Optional task source name. If it resolves
 *   to a registered source entry with `advisoryProse` true (same flag as
 *   review-task.js's isAdvisoryProseSource), the response is never flagged truncated:
 *   { truncated: false, reason: null } is returned right after the empty-string guard,
 *   before any heuristic. See the ADVISORY-PROSE CONTRACT in the header.
 * @returns {{truncated: boolean, reason: string|null}}
 *   - `{ truncated: true, reason: 'truncated output' }` if the text appears truncated.
 *   - `{ truncated: false, reason: null }` if it looks like a valid (or clean refusal) response.
 */
function detectTruncatedImplementResponse(rawText, source) {
  // 1. Empty / whitespace-only guard.
  if (rawText == null || rawText.trim() === '') {
    return { truncated: true, reason: 'truncated output' };
  }

  // 2. Advisory-prose carve-out (see ADVISORY-PROSE CONTRACT in the header): a
  //    code-bearing advisory-prose draft (e.g. function_length_review) must never be
  //    flagged truncated, so short-circuit before any heuristic.
  if (source) {
    const entry = getRegisteredSource(source);
    if (entry && entry.advisoryProse) {
      return { truncated: false, reason: null };
    }
  }

  // 2b. A diff that is complete per its hunk headers is not truncated (see COMPLETE-DIFF EXEMPTION above). Anything else falls through to
  //     the rules below unchanged.
  if (diffIsComplete(rawText)) {
    return { truncated: false, reason: null };
  }

  const trimmed = rawText.trim();

  // 3. A literal JSON envelope, whole-string only (optionally fenced) -- a complete Group
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

  // 4. Trailing-unterminated-string heuristic: the last whitespace-delimited token has an
  //    odd number of unescaped double-quotes (e.g. ...return "Topology). The one shape
  //    this file has real incident evidence for -- see header.
  const trailingToken = trimmed.split(/\s+/).pop();
  const unescapedQuotes = (trailingToken.match(/(?<!\\)"/g) || []).length;
  if (unescapedQuotes % 2 !== 0) {
    return { truncated: true, reason: 'truncated output' };
  }

  return { truncated: false, reason: null };
}

module.exports = { detectTruncatedImplementResponse, diffIsComplete, TRUNCATION_GATE_VERSION };
