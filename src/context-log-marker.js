'use strict';

// Per-chat-session "context log" capture (2026-09-15, Grimmethy: "what if we
// generate/edit the task log at the end of each response? ... Maybe we make a context
// log that houses the key most important data and then we could wikilink it to the
// relevant task log rather than embedding" -- see
// /home/wok/.claude/plans/immutable-noodling-axolotl.md's full design).
//
// Same injection/extraction shape as side-finding.js (this module's direct template --
// see that file's own header for the house-style precedent this follows), with two
// deliberate differences: this is MANDATORY every response, not a rare opt-in flag, and
// the extracted entry carries an optional TASK-REF so context-log-sweep.js can later
// cross-reference the right task/project without a separate classification pass -- Chat
// already knows which task it was just discussing (it called read_task or one of the
// unstick tools), so the model states it directly instead of a second model call trying
// to infer it after the fact.
//
// A model may end its response with exactly one block:
//   CONTEXT-LOG: <one-paragraph distillation>
//   TASK-REF: <task id>          (omitted when no specific task was discussed)
// extractContextLog() pulls this out before the caller's own RESOLUTION:/OPTIONS:
// parsing ever sees the text, mirroring extractSideFindings()'s own "strip before the
// rest of the response is interpreted" contract exactly.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONTEXT_LOG_INSTRUCTION = (
  'At the end of every response, you MUST include exactly one block distilling what '
  + 'this exchange covered or decided -- not a restatement of your whole answer, one '
  + 'tight paragraph with the key facts/decisions a reader would need if this were the '
  + 'only line of the conversation they ever saw:\n'
  + 'CONTEXT-LOG: <one-paragraph distillation>\n'
  + 'TASK-REF: <task id>\n'
  + 'Omit the TASK-REF: line entirely when this exchange did not concern a specific '
  + 'task. This is mandatory, not optional -- but keep it tight, never pad it.'
);

const CONTEXT_LOG_SPLIT_RE = /(?=^CONTEXT-LOG:\s*)/m;
// [ \t]* (not \s*) deliberately -- \s* also matches newlines, which would swallow the
// line break after "CONTEXT-LOG:" whenever the summary starts on the NEXT line (e.g.
// "CONTEXT-LOG:\nTASK-REF: x"), merging that next line into a title-only match with
// nothing left to signal where the title line ends. Same reasoning applies to
// TASK_REF_LINE_RE below: it must require exactly one newline immediately before
// "TASK-REF:", not \s*'s "any amount of whitespace including more newlines" -- the
// whole point of BLANK_LINE_RE below is to detect a blank-line separation as a
// DIFFERENT, non-consuming case, and a greedy \s* here would make the two patterns
// match the same position and silently collapse that distinction.
const CONTEXT_LOG_TITLE_RE = /^CONTEXT-LOG:[ \t]*/m;
const TASK_REF_LINE_RE = /\n[ \t]*TASK-REF:\s*(.+)$/m;
const BLANK_LINE_RE = /\n\s*\n/;

// Same "model echoed the instruction's own template tokens" guard side-finding.js's
// SIDE_FINDING_PLACEHOLDER_RE already proved necessary in practice.
const CONTEXT_LOG_PLACEHOLDER_RE = /<one-paragraph distillation>|<task id>/i;

// Idempotent (checks the marker string isn't already present) -- same reason
// injectSideFindingInstruction() is: a retried identical prompt must not accumulate
// copies of the instruction.
function injectContextLogInstruction(text) {
  const base = text || '';
  if (base.includes('CONTEXT-LOG:')) return base;
  return `${base}\n\n${CONTEXT_LOG_INSTRUCTION}`;
}

// Returns { cleanText, entry: {summary, taskRef} | null }. Lenient throughout -- a
// malformed or placeholder-echoing block is dropped (entry stays null), never thrown,
// same fail-open contract every marker extractor in this codebase holds itself to. Only
// the FIRST well-formed block found becomes `entry` if a response somehow contains more
// than one, but every matched block (well-formed or not) is still stripped from
// cleanText so nothing ever leaks into the visible response.
function extractContextLog(text) {
  const source = text || '';
  if (!source.includes('CONTEXT-LOG:')) return { cleanText: source, entry: null };

  const blocks = source.split(CONTEXT_LOG_SPLIT_RE);
  let entry = null;
  const cleanParts = [];

  for (const block of blocks) {
    if (!CONTEXT_LOG_TITLE_RE.test(block)) {
      cleanParts.push(block);
      continue;
    }
    const afterTitle = block.replace(CONTEXT_LOG_TITLE_RE, '');
    const taskRefMatch = afterTitle.match(TASK_REF_LINE_RE);
    const blankMatch = afterTitle.match(BLANK_LINE_RE);
    let boundary = afterTitle.length;
    if (blankMatch) boundary = Math.min(boundary, blankMatch.index);
    if (taskRefMatch) boundary = Math.min(boundary, taskRefMatch.index);
    const summary = afterTitle.slice(0, boundary).trim();

    let remainderStart = boundary;
    let taskRef = null;
    // Only treat TASK-REF as consumed when it's the line immediately ending the
    // summary (no blank line in between) -- a TASK-REF appearing after a blank line is
    // left in cleanText untouched rather than guessed at.
    if (taskRefMatch && taskRefMatch.index === boundary) {
      taskRef = taskRefMatch[1].trim();
      remainderStart = taskRefMatch.index + taskRefMatch[0].length;
    }
    cleanParts.push(afterTitle.slice(remainderStart));

    if (!summary) continue; // malformed -- drop, don't fail the whole extraction
    if (CONTEXT_LOG_PLACEHOLDER_RE.test(summary)) continue; // instruction template echoed back verbatim
    if (!entry) entry = { summary, taskRef: taskRef || null };
  }

  const cleanText = cleanParts.join('').replace(/\n{3,}/g, '\n\n').trim();
  return { cleanText, entry };
}

function inboxDir(pipelineDir) {
  return path.join(pipelineDir, 'queue', 'context-log-inbox');
}

// Best-effort, fire-and-forget: one independent, uniquely-named file per entry
// (race-free by construction, same reasoning as writeSideFindingInbox) for
// context-log-sweep.js to drain into the session's Second Brain note later. Never
// throws past the caller -- a disk problem here must never turn a real Chat turn into a
// pipeline-wide failure over what is, after all, a durability side channel.
function writeContextLogInbox(entry, { sessionId, pipelineDir }) {
  if (!pipelineDir || !sessionId) return;
  try {
    const dir = inboxDir(pipelineDir);
    fs.mkdirSync(dir, { recursive: true });
    const name = `cl-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.json`;
    const record = {
      sessionId,
      summary: entry.summary,
      taskRef: entry.taskRef || null,
      extractedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(dir, name), JSON.stringify(record, null, 2));
  } catch (e) {
    console.warn('[context-log] failed to write inbox entry (non-fatal):', e.message);
  }
}

module.exports = {
  CONTEXT_LOG_INSTRUCTION,
  injectContextLogInstruction,
  extractContextLog,
  writeContextLogInbox,
  inboxDir,
};
