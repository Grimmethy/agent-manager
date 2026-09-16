// src/decompose-question-surface.js
//
// Surfaces a decompose design question to a human: writes one
// decompose_design_question entry into queue/awaiting-confirm/ so the existing
// confirm flow (app.py's confirm block + needs-clarification-triage.js surfacing)
// picks it up.
//
// Self-contained by design: it deliberately does NOT import other src/ modules
// (no ./config.js, no ./task-sources.js). The pipeline dir is resolved the same
// way src/config.js's getConfig() does (AGENT_MANAGER_PIPELINE_DIR || repo root,
// where the repo root is the parent of this file), and callers may override it
// via the options argument ({ pipelineDir }) -- mirroring queueAdhocTask()'s
// { pipelineDir, ... } convention so tests can point at a scratch directory.
//
// Idempotency guard: before writing, BOTH queue/awaiting-confirm/ and
// queue/approved/ are scanned for an existing entry whose `originalTaskId`
// matches the one being surfaced; if either directory already holds one, the
// call is a no-op returning null (no second file is created, ever).

const fs = require('fs');
const path = require('path');

function slugify(str) {
  return str.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '').replace(/[^a-z0-9]+/g, '-');
}

// Default pipeline dir: same resolution as src/config.js's getConfig()
// (env override, else the repo root that contains this src/ directory).
function resolvePipelineDir(options) {
  if (options && options.pipelineDir) return options.pipelineDir;
  return process.env.AGENT_MANAGER_PIPELINE_DIR || path.join(__dirname, '..');
}

// Does `dir` contain any .json entry whose `originalTaskId` equals targetId?
// Tolerates a missing directory and any unreadable/malformed file (skipped,
// never throws): the guard must never crash the surfacing path.
function _dirContainsOriginalTaskId(dir, targetId) {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return false; // directory does not exist yet (or is unreadable) -> nothing there
  }
  for (const name of files) {
    if (!name.endsWith('.json')) continue;
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (entry && entry.originalTaskId === targetId) return true;
    } catch {
      // malformed / non-JSON file in the queue dir: ignore, keep scanning
    }
  }
  return false;
}

// Surface one decompose design question for a blocked original task.
//
//   surfaceDecomposeDesignQuestion({
//     title,               // required: short human-readable question title
//     promptContext,       // required: opaque context (string or object, passed through untouched)
//     originalTaskId,      // required: id of the task whose decompose blocked; idempotency key
//     decomposeBlockedAt,  // required: ISO timestamp of the decompose block
//   }, { pipelineDir }?)   // optional: override where the queue/ tree lives
//
// Returns { record, filePath } on a fresh write, or null when an entry with the
// same originalTaskId already exists in queue/awaiting-confirm/ or queue/approved/.
function surfaceDecomposeDesignQuestion({ title, promptContext, originalTaskId, decomposeBlockedAt }, options) {
  if (!title) throw new Error('surfaceDecomposeDesignQuestion: title is required');
  if (promptContext === undefined || promptContext === null || promptContext === '') {
    throw new Error('surfaceDecomposeDesignQuestion: promptContext is required');
  }
  if (!originalTaskId) throw new Error('surfaceDecomposeDesignQuestion: originalTaskId is required');

  const pipelineDir = resolvePipelineDir(options);
  const awaitingDir = path.join(pipelineDir, 'queue', 'awaiting-confirm');
  const approvedDir = path.join(pipelineDir, 'queue', 'approved');

  // Idempotency guard: same originalTaskId already surfaced (or already
  // approved) anywhere means we must not write a duplicate.
  if (_dirContainsOriginalTaskId(awaitingDir, originalTaskId)) return null;
  if (_dirContainsOriginalTaskId(approvedDir, originalTaskId)) return null;

  const id = `decompose-question-${slugify(originalTaskId)}-${Date.now()}`;
  const record = {
    id,
    source: 'decompose_design_question',
    title,
    promptContext, // opaque: never deconstructed or validated here
    originalTaskId,
    decomposeBlockedAt,
  };

  fs.mkdirSync(awaitingDir, { recursive: true });
  const filePath = path.join(awaitingDir, `${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2) + '\n');
  return { record, filePath };
}

module.exports = { surfaceDecomposeDesignQuestion };
