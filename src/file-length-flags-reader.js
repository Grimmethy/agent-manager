'use strict';

// Shared oversized-file lookup (S4a of the hub-tasks extraction, 2026-09-24,
// Docs/hub-tasks-extraction-plan.md section 3). Split out of decompose-loop-autoroute.js
// so it can move to agent-manager-hygiene with the rest of the file-decompose family
// while these two pure, dependency-light helpers stay in core -- local-agentic-write-draft.js
// and needs-clarification-triage.js (both hub KERNEL code that stays) need only these,
// never decompose-loop-autoroute.js's own sweep-authoring logic, so there is no coupling
// left to hook once the sweep itself physically moves.

const fs = require('fs');
const path = require('path');

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// The set of file paths currently flagged too-long (queue/file-length-flags.json, written
// by agent-manager-hygiene's file-length-scan.js).
function oversizedFiles(pipelineDir) {
  const data = readJson(path.join(pipelineDir, 'queue', 'file-length-flags.json'));
  const out = new Set();
  for (const f of (data && data.findings) || []) {
    if (f && f.file) out.add(f.file);
  }
  return out;
}

// A sentence that's a verification/compile/test-run instruction, not a description of what
// to change -- excluded from matching below so an oversized file named only incidentally
// (e.g. "Run: python3 -m py_compile app.py test_x.py") doesn't get treated as the task's
// real target. Root-caused live (2026-09-04) via a task to CREATE a new test file whose
// last sentence was exactly this shape, naming an unrelated flagged-oversized app.py as a
// compile-check argument -- targetOversizedFile returned it as "the target," and autoroute
// auto-authored a real (if ultimately no-op) split plan for a file the task never asked to
// touch.
const VERIFICATION_SENTENCE_RE = /\b(?:py_compile|python3?\s+-m\s+\w+|pytest|unittest|npm (?:test|run|install)|node --test)\b|^\s*Run:/i;

// The oversized file this task is about, or null. Matches the longest flagged path that
// appears verbatim in the task's request text / title (longest so a/b/app.py wins over
// app.py if both were flagged), skipping any sentence that looks like a verification
// command rather than a description of the change.
function targetOversizedFile(task, oversized) {
  const hay = `${task.title || ''}\n${(task.promptContext && task.promptContext.rawText) || ''}`;
  const searchable = hay.split(/(?<=[.!?:])\s+|\n+/)
    .filter((s) => !VERIFICATION_SENTENCE_RE.test(s))
    .join('\n');
  let best = null;
  for (const f of oversized) {
    if (searchable.includes(f) && (!best || f.length > best.length)) best = f;
  }
  return best;
}

module.exports = { oversizedFiles, targetOversizedFile };
