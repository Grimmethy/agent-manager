'use strict';

// Extracted from get-grounding-source.js (2026-09-04) so a lightweight, dependency-free
// consumer (adhoc-diff-sanity.js -- loaded by every adhoc draft tier, hot path) can reuse
// the exact same "what concrete objects does this request name" extraction without pulling
// in get-grounding-source.js's own heavy require chain (task-sources.js + ensureRegistered(),
// a full pipeline bootstrap). Pure function, zero dependencies, behavior unchanged from the
// original inline definition.

// For an adhoc task resolved `no-changes-needed`, the reviewer's job is a coverage check:
// is every concrete thing the request names actually present in the current code? Pull the
// candidate "objects" out of the raw request text so they can be grepped against the real
// repo NOW, rather than trusting only whatever the drafter's own summary chose to cite.
const REQUEST_OBJECT_STOPWORDS = new Set([
  'should', 'shall', 'when', 'with', 'that', 'this', 'from', 'have', 'into', 'their', 'them',
  'then', 'they', 'will', 'would', 'could', 'being', 'such', 'also', 'only', 'each', 'both',
  'some', 'more', 'most', 'other', 'while', 'where', 'what', 'your', 'about', 'after', 'before',
  'tagged', 'selected', 'checkbox', 'check', 'these', 'those', 'here', 'there', 'been', 'does',
  'hide', 'show', 'make', 'like', 'need', 'want', 'note', 'used', 'uses', 'able', 'must',
]);
const MAX_REQUEST_OBJECT_TOKENS = 8;
const QUEUE_STATE_ID_RE = /\d{12,}/;

function extractRequestObjectTokens(rawText) {
  const text = String(rawText || '');
  const tokens = new Set();
  // /api/... paths: the slash must START a token. Without the lookbehind this matched the tail
  // of a relative file path (`src/validate-x.js` -> "/validate-x") and word/word alternations
  // (`JavaScript/Python` -> "/Python"), neither of which is an API route.
  for (const m of text.matchAll(/(?<![\w./-])\/[A-Za-z][\w/-]{2,}/g)) tokens.add(m[0]);
  // "quoted phrases": the closing quote must be the SAME character as the opening one, and
  // neither may sit inside a word. Without both, a backtick in a regex literal paired with the
  // apostrophe of "isn't" several words later ("]/ -- when the response isn"), and one
  // contraction's apostrophe paired with the next ("... but that self-audit task itself no-op").
  for (const m of text.matchAll(/(?<!\w)(["'`])((?:(?!\1)[^\n]){3,40}?)\1(?!\w)/g)) tokens.add(m[2].trim());
  for (const m of text.matchAll(/\b[A-Za-z_][A-Za-z0-9]*(?:[_][A-Za-z0-9]+|[A-Z][a-z0-9]+)+\b/g)) tokens.add(m[0]); // camelCase / snake_case
  for (const m of text.matchAll(/\b[A-Za-z]{4,}\b/g)) {                                      // plain content words
    if (!REQUEST_OBJECT_STOPWORDS.has(m[0].toLowerCase())) tokens.add(m[0]);
  }
  // A queue-state reference (a task id or archive path carrying a 12+ digit epoch-ms stamp)
  // names pipeline runtime state, never repo source, so it can never be grepped for.
  return [...tokens].filter((t) => !QUEUE_STATE_ID_RE.test(t)).slice(0, MAX_REQUEST_OBJECT_TOKENS);
}

module.exports = { extractRequestObjectTokens, REQUEST_OBJECT_STOPWORDS, MAX_REQUEST_OBJECT_TOKENS };
