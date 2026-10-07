'use strict';

// structured-change.js -- recognise a structurally valid "Group B" change set (the JSON apply-group-b.js executes).
//
// 2026-10-07 (TaxHarvest needs-clarification investigation, deadcode_fix x9): review-task.js's deterministic
// non-implementation gate rejected any fence-free implementResponse shorter than 80 characters as "a bare tool-call
// request or meta-commentary". A whole-file removal is exactly `{"mode": "delete", "file": "<path>"}` -- 71 to 79
// characters for the short paths in this repo -- so the model's CORRECT draft was blocked on length alone, three times,
// with no model vote. In the live queue every delete response of 80+ characters passed and merged (14 of 14) and every
// one under 80 was blocked (9 of 9). A tiny edit such as {"mode":"edit","file":"a.js","find":"x","replace":"y"} is
// shorter still. This is the structural check that lets such a response skip the length heuristic.
//
// Deliberately STRICT: the WHOLE trimmed text must be the JSON (no prose around it -- unlike
// json-fence.js's parseJsonMaybeFenced, which will happily extract a balanced object from surrounding chatter), each
// item must carry exactly the fields apply-group-b.js's applyOneChange requires for its mode, and a file path must stay
// inside the repo (not absolute, no `..`). `mode: "read"`, prose, an item without a file, an empty array and malformed
// JSON are all false. Never throws.

function isRepoRelativePath(file) {
  if (typeof file !== 'string') return false;
  if (!file.trim() || file !== file.trim()) return false;
  if (file.startsWith('/') || /^[A-Za-z]:[\\/]/.test(file)) return false;
  return !file.split(/[\\/]/).includes('..');
}

function isValidChangeItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  if (!isRepoRelativePath(item.file)) return false;
  if (item.mode === 'delete') return true;
  if (item.mode === 'edit') return typeof item.find === 'string' && item.find.length > 0 && typeof item.replace === 'string';
  if (item.mode === 'create') return typeof item.content === 'string';
  return false;
}

function stripSingleFence(text) {
  const m = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/i);
  return m ? m[1] : text;
}

function isStructuredGroupBChange(implementResponse) {
  try {
    if (typeof implementResponse !== 'string') return false;
    const text = stripSingleFence(implementResponse.trim()).trim();
    if (!text || (text[0] !== '{' && text[0] !== '[')) return false;
    const parsed = JSON.parse(text);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items.length > 0 && items.every(isValidChangeItem);
  } catch {
    return false;
  }
}

// A "read" tool-call request: the model asking to look at a file instead of implementing (`{"mode": "read", "file": "..."}`).
// review-task.js's NON_IMPL_PATTERNS used a bare /"mode"\s*:\s*"read"/ against the WHOLE implementResponse, so any diff or
// summary that merely MENTIONED the string (a test fixture, this very file) was rejected as "a bare tool-call request"
// (found 2026-10-07 when the review of the length-gate fix itself blocked on its own tests). A request is only a request
// when the response IS one: it parses as JSON whose items include mode "read", or it is a short fragment (under
// SHORT_FRAGMENT_CHARS) containing the marker. Never throws.
const SHORT_FRAGMENT_CHARS = 200;
const READ_MODE_RE = /"mode"\s*:\s*"read"/;

function looksLikeReadToolCall(implementResponse) {
  try {
    if (typeof implementResponse !== 'string') return false;
    const text = stripSingleFence(implementResponse.trim()).trim();
    if (!READ_MODE_RE.test(text)) return false;
    if (text.length < SHORT_FRAGMENT_CHARS) return true;
    if (text[0] !== '{' && text[0] !== '[') return false;
    const parsed = JSON.parse(text);
    return (Array.isArray(parsed) ? parsed : [parsed]).some((item) => item && typeof item === 'object' && item.mode === 'read');
  } catch {
    return false;
  }
}

module.exports = { isStructuredGroupBChange, looksLikeReadToolCall, isValidChangeItem, isRepoRelativePath };
