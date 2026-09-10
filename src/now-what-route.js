'use strict';

// now-what-route.js -- deterministic router for debrief NOW WHAT items
// (the {title, body} pairs parseDebriefNowWhatItems yields).
//
// Decides whether an item is a real fix-candidate (names a file, an
// identifier/call, or states an actionable change) and, when so, writes an
// adhoc task JSON into <pipelineDir>/queue/adhoc/ mirroring the shape
// applyBrainDumpSort's queuedTaskId branch builds in
// apply-group-a-brain-dump.js ({ id, domain:'adhoc', source, title,
// promptContext:{ rawText, ... } }) written with writeJsonAtomicSync.
//
// Contract: returns the written file path (string) on success, null when the
// item is too vague to be a task, and NEVER throws.

const fs = require('fs');
const path = require('path');
const { writeJsonAtomicSync } = require('./atomic-write.js');

// A file-path-like token: something with a recognized code/doc extension.
const FILE_TOKEN_RE =
  /\b[\w./-]+\.(?:js|ts|jsx|tsx|json|md|css|html|py|go|rs|sh|yml|yaml)\b/i;
// An identifier call: a camelCase/snake identifier immediately followed by "(".
const IDENT_CALL_RE = /\b[a-z][a-zA-Z0-9_]*\s*\(/;
// Imperative change verbs that mark the item as an actionable change.
const ACTION_VERB_RE =
  /\b(?:fix(?:es|ed)?|update[sd]?|change[sd]?|add[s]?|remov\w+|renam\w+|refactor\w*|patch\w*|correct\w*|set[s]?|wire[sd]?|hook\w*|implement\w*|replac\w+|delet\w+|creat\w+|writ\w+|edit[s]?|adjust\w*|clear\w*|handle[sd]?)\b/i;

// Pure, deterministic gate: is this item a real fix-candidate?
function isFixCandidate({ title, body }) {
  const text = `${title || ''} ${body || ''}`.trim();
  if (!text) return false;
  if (FILE_TOKEN_RE.test(text)) return true;
  if (IDENT_CALL_RE.test(text) && ACTION_VERB_RE.test(text)) return true;
  if (ACTION_VERB_RE.test(title || '')) return true;
  return false;
}

function routeNowWhatItem({ title, body, taskId, pipelineDir }) {
  try {
    const t = String(title || '').trim();
    const b = String(body || '').trim();
    if (!isFixCandidate({ title: t, body: b })) return null;

    const queuedId = `adhoc-now-what-${String(taskId || 'unknown')}-${Date.now()}`;
    const adhocTask = {
      id: queuedId,
      domain: 'adhoc',
      source: 'now_what',
      title: (t || b).slice(0, 120),
      body: b,
      raisedBy: { source: 'pipeline_debrief', taskId, stage: 'now-what' },
      promptContext: { rawText: b, debriefTaskId: taskId },
    };

    const adhocDir = path.join(pipelineDir, 'queue', 'adhoc');
    fs.mkdirSync(adhocDir, { recursive: true });
    const filePath = path.join(adhocDir, `${queuedId}.json`);
    writeJsonAtomicSync(filePath, adhocTask);
    return filePath;
  } catch (err) {
    // Never throw: a bad pipelineDir, a read-only fs, whatever -- the caller
    // just gets null and the item is not filed.
    return null;
  }
}

module.exports = { routeNowWhatItem };
