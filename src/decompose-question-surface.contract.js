// src/decompose-question-surface.contract.js
//
// HUB0028 · 2/2 — Synthesized contract spec for the decompose-question surfacing
// path. This is the single, importable, machine-readable deliverable that seeds
// the next implementation piece: reading THIS file is sufficient to (re)implement
// or consume `surfaceDecomposeDesignQuestion` without consulting any other doc.
//
// Provenance (captured verbatim at synthesis time):
//   - Gate condition:      src/needs-clarification-triage.js (bucket E, lines 745-746
//                           + the `if (!DRY_RUN)` guard around the surface call)
//   - Surface contract:    src/decompose-question-surface.js (function
//                           `surfaceDecomposeDesignQuestion`, lines 58-98)
//   - Decomposition:       adhoc-read-triage-routing-and-surface-contract-1789597008872-0

'use strict';

// ── 1. Gate condition (verbatim from src/needs-clarification-triage.js) ──────
// The triage sweep evaluates these lines in order inside its per-task loop;
// bucket E (and its surface call) fires only when ALL of them hold.
const GATE_CONDITION = [
  "const decompLoop = !!(task.stalenessFlag && task.stalenessFlag.reason === 'decompose-loop');",
  'if (decompLoop && targetOversizedFile(task, oversizedFiles(pipelineDir))) continue; // autoroute owns it',
  'if (task.stalenessKeep && task.stalenessKeep.until && task.stalenessKeep.until > now) continue; // human said Keep',
  'if (decompLoop) { ... if (!DRY_RUN) { surfaceDecomposeDesignQuestion({...}, { pipelineDir }) ... } }',
].join('\n');

// Human-readable one-line form of the same gate:
//   decompLoop
//   && !targetOversizedFile(task, oversizedFiles(pipelineDir))
//   && !(task.stalenessKeep && task.stalenessKeep.until && task.stalenessKeep.until > now)
//   && !DRY_RUN   // the surface call itself is wrapped in `if (!DRY_RUN)`

// ── 2. Required input fields with enforcement status ──────────────────────────
// Enforcement reflects what the code actually does (throws = required-and-enforced):
const INPUT_FIELDS = [
  {
    name: 'title',
    type: 'string',
    enforcement: 'required', // `if (!title) throw new Error('...title is required')`
  },
  {
    name: 'promptContext',
    type: 'string | object', // opaque: passed through untouched, never validated
    enforcement: 'required', // `if (promptContext === undefined || null || '') throw`
  },
  {
    name: 'originalTaskId',
    type: 'string',
    enforcement: 'required', // `if (!originalTaskId) throw` — ALSO the idempotency key
  },
  {
    name: 'decomposeBlockedAt',
    type: 'string', // ISO timestamp; callers pass `(task.stalenessFlag && task.stalenessFlag.at) || now`
    enforcement: 'required-but-not-enforced', // documented as required in the signature; no throw on absence
  },
];

// ── 3. Output path & filename expression (exact) ──────────────────────────────
// pipelineDir = options.pipelineDir || process.env.AGENT_MANAGER_PIPELINE_DIR || path.join(__dirname, '..')
const OUTPUT_PATH = 'path.join(pipelineDir, "queue", "awaiting-confirm", `decompose-question-${slugify(originalTaskId)}-${Date.now()}.json`)';

// slugify, verbatim from src/decompose-question-surface.js:
//   str.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '').replace(/[^a-z0-9]+/g, '-')

// ── 4. Idempotency key ─────────────────────────────────────────────────────────
// Before writing, BOTH queue/awaiting-confirm/ and queue/approved/ are scanned
// for an existing entry whose `originalTaskId` equals the incoming one; if either
// directory already holds one, the call no-ops and returns null (never a 2nd file).
const IDEMPOTENCY_KEY = 'originalTaskId'; // checked via `_dirContainsOriginalTaskId(dir, originalTaskId)` over both dirs

// ── 5. Return value shape ──────────────────────────────────────────────────────
// Fresh write:  { record, filePath }  — record is the JSON object written:
//   { id, source: 'decompose_design_question', title, promptContext, originalTaskId, decomposeBlockedAt }
//   where id = `decompose-question-${slugify(originalTaskId)}-${Date.now()}`
// Idempotent repeat: null
const RETURN_SHAPE = {
  fresh: '{ record: { id, source, title, promptContext, originalTaskId, decomposeBlockedAt }, filePath: string }',
  repeat: 'null',
};

// ── 6. Directory auto-creation ─────────────────────────────────────────────────
// `fs.mkdirSync(awaitingDir, { recursive: true })` runs immediately before the
// file write; the idempotency scan also tolerates a missing directory.
const DIR_AUTO_CREATE = true;

// ── Provenance ─────────────────────────────────────────────────────────────────
const SOURCE_GATE = 'src/needs-clarification-triage.js (bucket E, lines 745-746 + !DRY_RUN guard, lines 758-771)';
const SOURCE_CONTRACT = 'src/decompose-question-surface.js (surfaceDecomposeDesignQuestion, lines 58-98)';

module.exports = {
  GATE_CONDITION,
  INPUT_FIELDS,
  OUTPUT_PATH,
  IDEMPOTENCY_KEY,
  RETURN_SHAPE,
  DIR_AUTO_CREATE,
  SOURCE_GATE,
  SOURCE_CONTRACT,
};
