'use strict';

// decompose-draft-gate tests: shape-check gate for decompose drafts.
// Contract under test (verified against src/lib/decompose-draft-gate.js):
//   validateDecomposeDraft(draftText) ->
//     { ok: true, subTasks, reformatted }  -- subTasks is the cleaned array of
//       proposal objects; reformatted is true when the JSON array sat inside a
//       larger prose blob, false when the draft was the bare array itself.
//     { ok: false, reason }                -- prose-only / wrong-shape.
// Test (E) additionally drives the gate over a minimal decompose-pass stand-in's
// two-draft retry (prose-only draft 1, prose-only draft 2) and asserts no third
// attempt happens when both drafts fail the gate.

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateDecomposeDraft } = require('../src/lib/decompose-draft-gate.js');

// runDecomposePass itself moved to the agent-manager-hub-tasks plugin (S4b of the
// hub-tasks extraction, 2026-09-25) -- its own parsing behavior is tested there
// (src/decompose-pass.test.js in that repo). This file's real subject is
// decompose-draft-gate.js (core, unmoved); test (E) below only needs a minimal local
// double that reproduces the one-model-call-per-attempt contract the gate integration
// cares about -- in this test `call` always returns prose the real parser would reject
// too, so the real and fake versions return the same null either way.
async function fakeRunDecomposePass(task, { call }) {
  await call({});
  return null;
}

// ---------------------------------------------------------------------------
// (A) prose-only rejection: a natural-language draft with no JSON array anywhere
// ---------------------------------------------------------------------------
test('(A) prose-only draft is rejected: { ok:false, reason }, no subTasks', () => {
  const draft =
    'I think you should probably split this up somehow. ' +
    'There are two or three natural pieces here, but I am not sure exactly where ' +
    'the boundaries should go, so let me think about it a bit more first.';

  const out = validateDecomposeDraft(draft);
  assert.equal(out.ok, false, 'prose-only draft must be rejected');
  assert.equal(typeof out.reason, 'string', 'rejection must carry a reason string');
  assert.ok(out.reason.length > 0, 'reason must be non-empty');
  assert.ok(!('subTasks' in out), 'a rejection must not produce a subTasks array');
});

// ---------------------------------------------------------------------------
// (B) prose + trailing-JSON auto-reformat: the array is pulled out of a blob
// ---------------------------------------------------------------------------
test('(B) prose with a trailing JSON array is auto-reformatted: { ok:true, reformatted:true }', () => {
  const tasks = [
    { title: 'add a helper', rawText: 'Add a small helper function.' },
    { title: 'wire it up', rawText: 'Call the helper from the entry point.' },
  ];
  const draft = 'Here are the proposed sub-tasks:\n' + JSON.stringify(tasks);

  const out = validateDecomposeDraft(draft);
  assert.equal(out.ok, true, 'prose + valid JSON array must be accepted');
  assert.ok(Array.isArray(out.subTasks), 'subTasks must be an array');
  assert.equal(out.subTasks.length, 2, 'exactly the 2 proposals must be extracted');
  assert.equal(out.subTasks[0].title, 'add a helper');
  assert.equal(out.subTasks[0].rawText, 'Add a small helper function.');
  assert.equal(out.reformatted, true, 'prose around the JSON means the draft was reformatted');
});

// ---------------------------------------------------------------------------
// (C) clean JSON array pass-through: bare array, no prose, no reformat
// ---------------------------------------------------------------------------
test('(C) a bare JSON array passes through unchanged: { ok:true, reformatted:false }', () => {
  const tasks = [
    { title: 'one', rawText: 'Do the first piece.' },
    { title: 'two', rawText: 'Do the second piece.' },
    { title: 'three', rawText: 'Do the third piece, after: 1.' },
  ];
  const draft = JSON.stringify(tasks);

  const out = validateDecomposeDraft(draft);
  assert.equal(out.ok, true, 'bare valid array must be accepted');
  assert.equal(out.reformatted, false, 'a bare array is not a reformat case');
  assert.deepEqual(out.subTasks, tasks, 'subTasks must be deep-equal to the parsed input');
});

// ---------------------------------------------------------------------------
// (D) wrong-shape rejection: JSON present but not an array of proposal objects
// ---------------------------------------------------------------------------
test('(D) wrong-shape drafts are rejected like prose', () => {
  // A JSON object is not an array of sub-task proposals.
  const objectDraft = JSON.stringify({ foo: 'bar' });
  const objectOut = validateDecomposeDraft(objectDraft);
  assert.equal(objectOut.ok, false, 'a JSON object must be rejected');
  assert.equal(typeof objectOut.reason, 'string');
  assert.ok(!('subTasks' in objectOut));

  // An array of primitives is not an array of proposal objects.
  const primitivesDraft = JSON.stringify([1, 2, 3]);
  const primitivesOut = validateDecomposeDraft(primitivesDraft);
  assert.equal(primitivesOut.ok, false, 'an array of primitives must be rejected');
  assert.equal(typeof primitivesOut.reason, 'string');
  assert.ok(!('subTasks' in primitivesOut));
});

// ---------------------------------------------------------------------------
// (E) integration: the gate over a two-draft retry using a minimal decompose-pass
//     stand-in (see fakeRunDecomposePass above). Both drafts come back prose-only ->
//     the gate rejects both, exactly one model call per attempt, no third attempt.
//     Real escalation-avoidance (claudeCall never invoked) is the moved
//     runDecomposePass's own behavior now, covered by its test in the
//     agent-manager-hub-tasks plugin.
// ---------------------------------------------------------------------------
test('(E) both drafts fail the gate: the decompose pass is called exactly twice, no third attempt', async () => {
  const PROSE_ONLY =
    'This should be split into two pieces, one for the parser and one for the printer.';

  // Injectable model call (the same { call } seam the plugin's decompose-pass.test.js
  // uses). It stands in for the local 27B model pass: every invocation it performs
  // counts as a 27B call.
  let calls = 0;
  const call = async () => {
    calls += 1;
    return PROSE_ONLY; // both drafts fail the gate on purpose
  };

  // The two-draft retry: draft 1 -> gate -> if rejected, draft 2 -> gate.
  const gateResults = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const draft = await fakeRunDecomposePass(
      { source: 'manual', promptContext: { rawText: 'Split this task.' } },
      { call },
    );
    const gated = validateDecomposeDraft(draft == null ? '' : String(draft));
    gateResults.push(gated);
    if (gated.ok) break;
  }

  assert.equal(calls, 2, 'the decompose pass made exactly one model call per draft (one retry)');
  assert.equal(gateResults.length, 2, 'both drafts went through the gate');
  for (const gated of gateResults) {
    assert.equal(gated.ok, false, 'a prose-only draft must be rejected by the gate');
    assert.ok(!('subTasks' in gated));
  }
  // When both drafts fail, the retry loop stops after the second draft -- it must
  // never invoke the decompose pass again for a third attempt.
  assert.ok(calls <= 2, 'no extra decompose-pass call occurred after both drafts failed');
});
