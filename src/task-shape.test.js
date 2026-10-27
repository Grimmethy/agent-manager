'use strict';

// node:test coverage for src/task-shape.js and its three wiring points in local-agentic-write-draft.js (preliminary scope gate, leaf prompt lock, backstop).
// The two real task records (HUB0148's parent, the GPU broker PromptForge verification) are copied verbatim from the live queue, 2026-10-15/16.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { classifyTaskShape, stampTaskShape, shapeBlocksDecompose, preliminaryDecomposeDecision, shapeEnabled } = require('./task-shape.js');

const CAPTURE_BUG = {"title": "HUB0148 \u00b7 Brain dump capture 500s: string serials in brain-dump.json break next_serial max()", "promptContext": {"rawText": "BUG found 2026-10-15: POST /api/brain-dump/capture returns HTTP 500. python/dashboard/routes/brain_dump.py:132 computes next_serial with max((e.get(\"serial\") or 0) for e in entries ...) and ~50 entries in brain-dump.json (serials 1752-1802, e.g. bd-1791055597086-file-level-dead-code-scan) carry serial as a STRING ('1752'), so max() raises \"TypeError: '>' not supported between instances of 'str' and 'int'\". Capture is documented as a dumb synchronous append that must always work. WANTED: (1) capture computes next_serial from int-coerced serials, tolerating strings and non-numeric junk; (2) _assign_brain_dump_serials (python/dashboard/app.py, read_brain_dump_entries) normalises a string serial to an int on read, so the file heals itself; (3) find which writer produced string serials (machine-raised entries such as pipeline self-findings / side-finding filing, entries whose capturedAt ends in 'Z' rather than +00:00 are the suspects) and make it write an int. Tests: capture with a file containing string serials returns 200 and a serial one above the maximum; read heals the strings; the writer's output has an int serial. Reproduced with the Flask test client; no other capture failure seen. Workaround used meanwhile: the entry was appended to brain-dump.json directly."}};
const GPU_VERIFY = {"title": "GPU broker verify (promptforge): confirm the extraction map against the promptforge code, write Docs/gpu-broker-verification-promptforge.md", "promptContext": {"rawText": "Context: Docs/gpu-broker-extraction-map.md (merged, PR #561) maps pulling the Forge/pipeline GPU lease out of PromptForge into a standalone gpu-broker plugin (docs/agents/repo-extraction-playbook.md). Owner rule 2026-10-13: the pipeline's Ollama model and the Forge family never hold the GPU together. Premium, owner request 2026-10-15; this is one of three small read-only verification tasks replacing a single task that was too big. PromptForge: verify the map against /media/model-cache/github/promptforge-manual (server/core/gpu_session.py, comfy.py, comfy_proc.py, server/app.py routes /api/gpu/*, Docs/GPU_FAMILY_PROTOCOL.md, tests/test_gpu_session.py). Questions: where is the 120 s ComfyUI wait and how does an automatic job session call begin; which functions in gpu_session.py are broker logic vs PromptForge-specific; which tests would move with G1; per-device awareness (is anything GPU-index specific). RULES: read-only on the code; write ONLY the one findings file named below (a NEW file, nothing else changed). For every row/claim of the map that touches your area, state CONFIRMED / WRONG / UNCONFIRMED with path:line evidence, quote the corrected text for anything WRONG, and answer the section-5 open questions that fall in your area. Keep it under 120 lines. FILE TO WRITE: Docs/gpu-broker-verification-promptforge.md (in the agent-manager repo)."}};

const PRIMARY = '/media/model-cache/github/agent-manager';
const ROOTS = [PRIMARY, '/media/model-cache/github/agent-manager-hygiene'];
const t = (rawText, extra = {}) => ({ title: extra.title || 'A task', promptContext: { rawText }, ...extra.task });

function withEnv(name, value, fn) {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  try { return fn(); } finally { if (prev === undefined) delete process.env[name]; else process.env[name] = prev; }
}

const TABLE = [
  ['the real HUB0148 capture-bug text (three wants across files) is multi-file', CAPTURE_BUG, 'multi-file'],
  ['the real GPU broker PromptForge verification text is an investigation', GPU_VERIFY, 'investigation'],
  ['a one-line variant of the capture bug is a one-file-fix', t('BUG: python/dashboard/routes/brain_dump.py:132 computes next_serial with max() over entries whose serial is a string, so capture raises TypeError. Coerce each serial with int() and add a regression case to python/dashboard/test_brain_dump.py.'), 'one-file-fix'],
  ['one JS file plus its test is a one-file-fix', t('In src/foo.js fix the off-by-one in clampIndex and add a case to src/foo.test.js.'), 'one-file-fix'],
  ['two source files is multi-file', t('Update src/a.js and src/b.js so both read the new flag.'), 'multi-file'],
  ['a task naming a sibling repo path is cross-repo', t('In /media/model-cache/github/agent-manager-hygiene/src/unused-export.js change the apply root.'), 'cross-repo'],
  ['a read-only title plus a doc deliverable is an investigation', { title: 'Catalogue of tuning loops (read-only findings doc)', promptContext: { rawText: 'Read the history and write ONE file Docs/tuning-loops-catalogue.md and change nothing else.' } }, 'investigation'],
  ['"read-only" about something else, with no doc deliverable, is not an investigation', t('The export is read-only for consumers. Change the timeout in src/a.js.'), 'one-file-fix'],
  ['a read-only line next to a real code imperative is not an investigation', t('Rename the helper in src/a.js. Nothing else is changed in docs/x.md.'), 'one-file-fix'],
  ['one file with three /api/ endpoints is multi-file', t('In python/dashboard/app.py update /api/a/x, /api/b/y and /api/c/z.'), 'multi-file'],
  ['"every caller" wording is multi-file even with one file named', t('In src/a.js change every caller of foo.'), 'multi-file'],
  ['two numbered wants is multi-file', t('(1) fix src/a.js clamp (2) add a log line.'), 'multi-file'],
  ['a task naming nothing falls through to multi-file', t('Make the dashboard nicer.'), 'multi-file'],
  ['a doc-only edit with no read-only statement stays multi-file', t('Add a row to docs/agents/codebase-map.md for the promptforge image system.'), 'multi-file'],
  ['the edit location in the orient notes counts', { title: 'Fix clamp', promptContext: { rawText: 'The clamp is wrong.' }, orientNotes: 'CURRENT STATE: x\nEDIT LOCATION(S):\n`src/x.js` clamp()\nOPEN QUESTION: none' }, 'one-file-fix'],
];

for (const [name, task, expected] of TABLE) {
  test(`classifyTaskShape: ${name}`, () => {
    const out = classifyTaskShape(task, { roots: ROOTS });
    assert.equal(out.class, expected, JSON.stringify(out));
    assert.ok(Array.isArray(out.reasons) && out.reasons.length > 0 && out.reasons.every((r) => typeof r === 'string' && r), 'every class carries its reasons');
  });
}

test('stampTaskShape sets task.shape; AGENT_MANAGER_TASK_SHAPE=off leaves it unset and disables every suppression', () => {
  const task = t('In src/foo.js fix clamp and add a case to src/foo.test.js.');
  assert.equal(shapeEnabled(), true);
  stampTaskShape(task, { roots: ROOTS });
  assert.equal(task.shape.class, 'one-file-fix');
  assert.equal(shapeBlocksDecompose(task), true);
  withEnv('AGENT_MANAGER_TASK_SHAPE', 'off', () => {
    assert.equal(shapeEnabled(), false);
    assert.equal(shapeBlocksDecompose(task), false);
    const fresh = t('In src/foo.js fix clamp.');
    assert.equal(stampTaskShape(fresh, { roots: ROOTS }), null);
    assert.equal(fresh.shape, undefined);
    const gate = { shouldDecompose: true, reason: 'scope-complexity-gate: x' };
    assert.deepEqual(preliminaryDecomposeDecision(task, gate), { decompose: true, priorAttemptBlock: gate.reason, suppressedDetail: null });
  });
});

const GATE = { shouldDecompose: true, reason: 'scope-complexity-gate: anchor python/dashboard/app.py (flagged oversized) present with 0 endpoint path(s) and 3 subsystem keyword(s)' };

test('preliminaryDecomposeDecision: a one-file-fix is never decomposed and says why', () => {
  const task = t('In src/foo.js fix clamp and add a case to src/foo.test.js.');
  stampTaskShape(task, { roots: ROOTS });
  const d = preliminaryDecomposeDecision(task, GATE);
  assert.equal(d.decompose, false);
  assert.match(d.suppressedDetail, /^decompose suppressed: one-file-fix \(names one source file: src\/foo\.js/);
});

test('preliminaryDecomposeDecision: an investigation may decompose only along its own questions', () => {
  const task = JSON.parse(JSON.stringify(GPU_VERIFY));
  stampTaskShape(task, { roots: ROOTS });
  const d = preliminaryDecomposeDecision(task, GATE);
  assert.equal(d.decompose, true);
  assert.equal(d.suppressedDetail, null);
  assert.ok(d.priorAttemptBlock.startsWith(GATE.reason));
  assert.match(d.priorAttemptBlock, /only along its own numbered questions or areas; never into code-change pieces/);
});

test('preliminaryDecomposeDecision: multi-file and cross-repo get exactly the gate verdict, and a quiet gate stays quiet', () => {
  for (const task of [CAPTURE_BUG, t('In /media/model-cache/github/agent-manager-hygiene/src/unused-export.js change the apply root.')]) {
    const copy = JSON.parse(JSON.stringify(task));
    stampTaskShape(copy, { roots: ROOTS });
    assert.deepEqual(preliminaryDecomposeDecision(copy, GATE), { decompose: true, priorAttemptBlock: GATE.reason, suppressedDetail: null });
  }
  const one = t('In src/foo.js fix clamp.');
  stampTaskShape(one, { roots: ROOTS });
  assert.deepEqual(preliminaryDecomposeDecision(one, { shouldDecompose: false }), { decompose: false, priorAttemptBlock: undefined, suppressedDetail: null });
});

function freshDraftModule() {
  for (const m of ['./local-agentic-write-draft.js', './config.js']) delete require.cache[require.resolve(m)];
  return require('./local-agentic-write-draft.js');
}

test('leafDecomposeLocked: a one-file-fix is locked like a leaf, still unlockable by a burned turn budget, and unchanged when the switch is off', () => {
  const { leafDecomposeLocked } = freshDraftModule();
  const task = t('In src/foo.js fix clamp and add a case to src/foo.test.js.');
  assert.equal(leafDecomposeLocked(task), false, 'no shape yet: unchanged');
  stampTaskShape(task, { roots: ROOTS });
  assert.equal(leafDecomposeLocked(task), true);
  assert.equal(leafDecomposeLocked({ ...task, turnBudgetExhaustedBefore: true }), false);
  assert.equal(leafDecomposeLocked({ ...task, decomposeBlockCount: 1 }), false);
  withEnv('AGENT_MANAGER_TASK_SHAPE', 'off', () => assert.equal(leafDecomposeLocked(task), false));
  const multi = JSON.parse(JSON.stringify(CAPTURE_BUG));
  stampTaskShape(multi, { roots: ROOTS });
  assert.equal(leafDecomposeLocked(multi), false, 'multi-file behaves as before');
});

test('the real scopeComplexityGate firing on a one-file-fix is suppressed through the shape decision', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-shape-gate-'));
  fs.mkdirSync(path.join(dir, 'queue'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'queue', 'file-length-flags.json'), JSON.stringify({ findings: [{ file: 'python/dashboard/app.py' }] }));
  const prev = { r: process.env.AGENT_MANAGER_REPO_ROOT, p: process.env.AGENT_MANAGER_PIPELINE_DIR };
  process.env.AGENT_MANAGER_REPO_ROOT = dir;
  process.env.AGENT_MANAGER_PIPELINE_DIR = dir;
  try {
    const { scopeComplexityGate } = freshDraftModule();
    const task = { title: 'Fix install label', promptContext: { rawText: 'In python/dashboard/app.py fix the install and update label for the ui.', prefetchedPaths: ['python/dashboard/app.py'] } };
    const gate = scopeComplexityGate(task);
    assert.equal(gate.shouldDecompose, true, 'the unmodified gate does fire on this text');
    stampTaskShape(task, { roots: ROOTS });
    assert.equal(task.shape.class, 'one-file-fix');
    const d = preliminaryDecomposeDecision(task, gate);
    assert.equal(d.decompose, false);
    assert.match(d.suppressedDetail, /^decompose suppressed: one-file-fix \(/);
  } finally {
    for (const [e, v] of [['AGENT_MANAGER_REPO_ROOT', prev.r], ['AGENT_MANAGER_PIPELINE_DIR', prev.p]]) { if (v === undefined) delete process.env[e]; else process.env[e] = v; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
