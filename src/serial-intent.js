'use strict';

// "Is this await-in-a-loop sequential ON PURPOSE?" -- a deterministic pre-dispatch check for the sequential-await-in-loop finding (brain dump #1661).
//
// Why: the performance scanner flags every loop whose body awaits. Of the 253 findings it raised for that rule, 218 were dismissed and 2 merged (86% waste: each one
// ran the whole plan -> implement -> critique -> review cycle to reach "false positive"). Reading the 140 dismissals whose snippet shows an awaited call in a plain
// loop, the model's reasons were: the order matters or it is rate-limited / locked (73), each iteration depends on the previous result -- pagination cursors, early
// exit (57), or it is a retry/backoff/poll loop (10). Those are things the snippet itself usually shows, so they can be read without a model.
//
// What: detectSerialIntent(snippet) -> { intentional, signals }. It looks for explicit evidence that the serial order is required: a comment that says so, a
// poll/backoff sleep, a retry or attempt counter, a pagination cursor, an unbounded `while (true)` consumer, an early `break`/`return` after the await, a loop
// condition or awaited argument that the body reassigns, or `for await` (async iteration). No evidence -> not intentional -> the finding goes to the normal pipeline.
// It deliberately does NOT decide the other way: an await that lies beyond the snippet window, or a plain independent loop, is left for a model/human.
//
// Precision over recall: a wrongly dismissed real finding is lost silently, a missed false positive just costs one cycle. Pure; never throws.

const COMMENT_SERIAL_RE = /\b(sequential(?:ly)?|serial(?:ly|ize[sd]?|ization)?|in order|one at a time|one by one|order matters|must (?:run|be|execute) (?:in )?(?:order|sequence|series|sequential\w*|serial\w*)|rate[- ]?limit(?:ed|ing)?|throttl\w+|single[- ]flight|mutex|back[- ]?pressure|do not (?:parallel\w+|run in parallel)|not (?:safe|possible) to parallel\w+)\b/i;
const SLEEP_AWAIT_RE = /\bawait\s+(?:(?:asyncio\.)?sleep|delay|wait\w*|backoff\w*|pause)\s*\(|\bawait\s+new\s+Promise\s*\(\s*\(?\s*\w*\s*\)?\s*=>\s*setTimeout|\bawait\s+asyncio\.sleep\s*\(/;
const RETRY_RE = /\b(?:attempt|attempts|retry|retries|retrying|tries)\b/i;
const CURSOR_ASSIGN_RE = /\b(?:cursor|next_?page|next_?token|page_?token|next_?cursor|offset|continuation\w*)\s*=[^=]/i;
const CURSOR_COND_RE = /\b(?:while|until)\b[^)\n]*\b(?:cursor|has_?more|has_?next|next_?page|next_?token|page_?token|more)\b/i;
const UNBOUNDED_RE = /\bwhile\s*\(\s*(?:true|1)\s*\)|\bfor\s*\(\s*;\s*;\s*\)|^\s*while\s+(?:True|1)\s*:/m;
const FOR_AWAIT_RE = /\bfor\s+await\s*\(|\basync\s+for\b/;
const EXIT_WORD_RE = /\b(?:break|return)\b/;

function splitCodeAndComments(snippet) {
  const code = [];
  const comments = [];
  for (const raw of String(snippet || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (/^(?:\/\/|#|\*|\/\*)/.test(line)) { comments.push(line); continue; }
    const trailing = raw.match(/^(.*?)(?:\s\/\/|\s#\s)(.*)$/);
    if (trailing && !/['"`]/.test(trailing[1].slice(-1))) { code.push(trailing[1]); comments.push(trailing[2]); } else code.push(raw);
  }
  return { code, comments };
}

// Identifiers a loop header's condition reads: `while (cursor)`, `while (queue.length > 0 && !done)`.
function headerConditionVars(codeText) {
  const m = codeText.match(/\bwhile\s*\(([^)]*)\)/);
  if (!m) return [];
  const skip = new Set(['true', 'false', 'null', 'undefined', 'length', 'typeof', 'await', 'new', 'this']);
  return [...new Set((m[1].match(/[A-Za-z_$][\w$]*/g) || []).filter((v) => !skip.has(v)))];
}

function detectSerialIntent(snippet) {
  const result = { intentional: false, signals: [] };
  try {
    const text = String(snippet || '');
    if (!text.trim()) return result;
    const { code, comments } = splitCodeAndComments(text);
    const codeText = code.join('\n');
    const add = (s) => { if (!result.signals.includes(s)) result.signals.push(s); };
    if (comments.some((c) => COMMENT_SERIAL_RE.test(c))) add('comment-says-serial');
    if (SLEEP_AWAIT_RE.test(codeText)) add('poll-or-backoff-sleep');
    if (RETRY_RE.test(codeText)) add('retry-loop');
    if (CURSOR_ASSIGN_RE.test(codeText) || CURSOR_COND_RE.test(codeText)) add('pagination-cursor');
    if (UNBOUNDED_RE.test(codeText)) add('unbounded-consumer-loop');
    if (FOR_AWAIT_RE.test(codeText)) add('async-iteration');
    // An early exit INSIDE the loop at or after the await depends on the awaited result. "Inside" = indented deeper than the loop header (a `return out;` that
    // closes the function after the loop is not an exit from it); `return await x` exits on the first iteration whatever the result.
    const lines = code;
    const indentOf = (l) => (l.match(/^\s*/) || [''])[0].length;
    const headerIdx = lines.findIndex((l) => /\b(?:for|while)\b|\bdo\s*\{/.test(l));
    const awaitIdx = lines.findIndex((l) => /\bawait\b/.test(l));
    if (headerIdx >= 0 && awaitIdx >= headerIdx) {
      const base = indentOf(lines[headerIdx]);
      for (let j = headerIdx + 1; j < lines.length; j += 1) {
        if (/\breturn\s+await\b/.test(lines[j]) || (j >= awaitIdx && indentOf(lines[j]) > base && EXIT_WORD_RE.test(lines[j]))) { add('early-exit-after-await'); break; }
      }
    }
    // Loop-carried state: only text AFTER the loop header counts, so a default parameter in the function signature above it (`temperature = 0.2`) is not a
    // reassignment. The loop condition's variables updated in the body, or a variable passed to the awaited call and reassigned after it.
    const header = codeText.search(/\b(?:for|while)\b|\bdo\s*\{/);
    const afterHeader = header >= 0 ? codeText.slice(header) : '';
    const assigns = (v, where) => new RegExp(`(?:^|[^\\w$.])${v.replace(/\$/g, '\\$')}\\s*(?:=[^=]|\\+=|-=|\\+\\+|--)`, 'm').test(where);
    const bodyAfterHeader = afterHeader.replace(/^[^\n{]*(?:\{|\n|$)/, '');
    for (const v of headerConditionVars(afterHeader)) {
      if (assigns(v, bodyAfterHeader)) { add('loop-condition-updated-in-body'); break; }
    }
    const awaitCall = afterHeader.match(/\bawait\s+[\w$.]+\s*\(([^)]*)\)/);
    if (awaitCall) {
      const afterAwait = afterHeader.slice(afterHeader.indexOf(awaitCall[0]) + awaitCall[0].length);
      for (const v of (awaitCall[1].match(/[A-Za-z_$][\w$]*/g) || [])) {
        if (['true', 'false', 'null', 'undefined'].includes(v)) continue;
        if (assigns(v, afterAwait) && !new RegExp(`\\b(?:const|let|var)\\s+${v.replace(/\$/g, '\\$')}\\b`).test(afterHeader)) { add('awaited-argument-updated-in-body'); break; }
      }
    }
    result.intentional = result.signals.length > 0;
  } catch { /* advisory: a detector failure means "no evidence" */ }
  return result;
}

module.exports = { detectSerialIntent };
