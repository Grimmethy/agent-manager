'use strict';

// Unit tests for decompose-review-registry.js (deterministic-review hook, S4a of the
// hub-tasks extraction, 2026-09-24). Run: node --test src/decompose-review-registry.test.js
//
// Uses throwaway kind names throughout (never 'script-extract'/'one-pass-decompose'/
// 'node-module-decompose'/'blueprint-decompose') so these tests can't collide with the
// real production registrations those four producer files make at module load, shared
// process-wide.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const {
  registerDeterministicReview, verifyDeterministicDraft, verifyOnePassStyleRederivation, clearDeterministicReviewRegistry,
} = require('./decompose-review-registry.js');

test('verifyDeterministicDraft returns null for a task with no deterministicApply kind', () => {
  assert.equal(verifyDeterministicDraft({}, '/tmp'), null);
  assert.equal(verifyDeterministicDraft({ promptContext: {} }, '/tmp'), null);
  assert.equal(verifyDeterministicDraft(null, '/tmp'), null);
});

test('verifyDeterministicDraft returns null for an unregistered kind', () => {
  assert.equal(verifyDeterministicDraft({ promptContext: { deterministicApply: 'nobody-registered-this-kind' } }, '/tmp'), null);
});

test('a registered kind\'s verify() decides the outcome and receives (task, repoRoot, groundingRef)', () => {
  const seen = [];
  registerDeterministicReview('test-kind-records-args', {
    verify: (task, repoRoot, groundingRef) => { seen.push([task.id, repoRoot, groundingRef]); return { ok: true }; },
  });
  const result = verifyDeterministicDraft({ id: 't1', promptContext: { deterministicApply: 'test-kind-records-args' } }, '/repo', 'refs/x');
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(seen, [['t1', '/repo', 'refs/x']]);
});

test('registerDeterministicReview overwrites (not throws) on a re-registered kind name', () => {
  registerDeterministicReview('test-kind-dup', { verify: () => ({ ok: false }) });
  assert.doesNotThrow(() => registerDeterministicReview('test-kind-dup', { verify: () => ({ ok: true }) }));
  assert.deepEqual(verifyDeterministicDraft({ promptContext: { deterministicApply: 'test-kind-dup' } }, '/tmp'), { ok: true });
});

test('registerDeterministicReview requires a non-empty kind string and a verify function', () => {
  assert.throws(() => registerDeterministicReview('', { verify: () => null }), /non-empty string/);
  assert.throws(() => registerDeterministicReview('test-kind-no-fn', {}), /verify must be a function/);
});

// --- verifyOnePassStyleRederivation ---

function makeRepo(sourceFile, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decompose-review-registry-test-'));
  fs.mkdirSync(path.dirname(path.join(dir, sourceFile)), { recursive: true });
  fs.writeFileSync(path.join(dir, sourceFile), content);
  return dir;
}

test('verifyOnePassStyleRederivation: byte-exact re-derivation -> ok:true with moduleCount', () => {
  const repoRoot = makeRepo('src/thing.js', 'ORIGINAL SOURCE');
  const parsed = [
    { mode: 'create', file: 'src/a.js', content: 'A' },
    { mode: 'edit', file: 'src/thing.js', find: 'ORIGINAL SOURCE', replace: 'REDUCED SOURCE' },
  ];
  const task = { promptContext: { sourceFile: 'src/thing.js', moves: [{ kind: 'x' }] }, implementResponse: JSON.stringify(parsed) };
  const rebuild = () => ({ ok: true, changes: parsed });
  assert.deepEqual(verifyOnePassStyleRederivation(task, repoRoot, rebuild), { ok: true, moduleCount: 1 });
});

test('verifyOnePassStyleRederivation: rebuild reports drift -> ok:false with a reason', () => {
  const repoRoot = makeRepo('src/thing.js', 'ORIGINAL SOURCE');
  const parsed = [{ mode: 'create', file: 'src/a.js', content: 'A' }, { mode: 'edit', file: 'src/thing.js', find: 'x', replace: 'y' }];
  const task = { promptContext: { sourceFile: 'src/thing.js', moves: [{ kind: 'x' }] }, implementResponse: JSON.stringify(parsed) };
  const result = verifyOnePassStyleRederivation(task, repoRoot, () => ({ ok: false, reason: 'a symbol moved' }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /no longer re-derives cleanly/);
});

test('verifyOnePassStyleRederivation: rebuild succeeds but the draft byte-mismatches -> ok:false', () => {
  const repoRoot = makeRepo('src/thing.js', 'ORIGINAL SOURCE');
  const parsed = [{ mode: 'create', file: 'src/a.js', content: 'A' }, { mode: 'edit', file: 'src/thing.js', find: 'x', replace: 'y' }];
  const task = { promptContext: { sourceFile: 'src/thing.js', moves: [{ kind: 'x' }] }, implementResponse: JSON.stringify(parsed) };
  const fresh = { ok: true, changes: [{ mode: 'create', file: 'src/a.js', content: 'TAMPERED' }, parsed[1]] };
  const result = verifyOnePassStyleRederivation(task, repoRoot, () => fresh);
  assert.equal(result.ok, false);
  assert.match(result.reason, /no longer byte-matches/);
});

test('verifyOnePassStyleRederivation: returns null (not applicable) for a non-JSON or wrong-shape implementResponse', () => {
  const repoRoot = makeRepo('src/thing.js', 'ORIGINAL SOURCE');
  const task = { promptContext: { sourceFile: 'src/thing.js', moves: [{ kind: 'x' }] }, implementResponse: 'not json at all' };
  assert.equal(verifyOnePassStyleRederivation(task, repoRoot, () => { throw new Error('must not be called'); }), null);
});

test('verifyOnePassStyleRederivation: returns null when promptContext lacks sourceFile/moves', () => {
  assert.equal(verifyOnePassStyleRederivation({ promptContext: {} }, '/tmp', () => { throw new Error('must not be called'); }), null);
});

test('verifyOnePassStyleRederivation: a read failure returns ok:false with a reason', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'decompose-review-registry-test-'));
  const parsed = [{ mode: 'create', file: 'src/a.js', content: 'A' }, { mode: 'edit', file: 'src/missing.js', find: 'x', replace: 'y' }];
  const task = { promptContext: { sourceFile: 'src/missing.js', moves: [{ kind: 'x' }] }, implementResponse: JSON.stringify(parsed) };
  const result = verifyOnePassStyleRederivation(task, repoRoot, () => { throw new Error('must not be called'); });
  assert.equal(result.ok, false);
  assert.match(result.reason, /could not re-read/);
});

// Run last: exercises clearDeterministicReviewRegistry, which wipes the SAME process-wide
// singleton the four producer files register their real kinds into -- restores those four
// immediately afterward so any other test file sharing this process isn't left with an
// empty registry.
test('clearDeterministicReviewRegistry empties the registry', () => {
  registerDeterministicReview('test-kind-for-clear', { verify: () => ({ ok: true }) });
  assert.deepEqual(verifyDeterministicDraft({ promptContext: { deterministicApply: 'test-kind-for-clear' } }, '/tmp'), { ok: true });
  clearDeterministicReviewRegistry();
  assert.equal(verifyDeterministicDraft({ promptContext: { deterministicApply: 'test-kind-for-clear' } }, '/tmp'), null);

  // Restore production state (re-triggers each producer's own registerDeterministicReview call).
  delete require.cache[require.resolve('./script-extract.js')];
  delete require.cache[require.resolve('./decompose-one-pass.js')];
  delete require.cache[require.resolve('./decompose-node-module.js')];
  delete require.cache[require.resolve('./decompose-flask-blueprint.js')];
  require('./script-extract.js');
  require('./decompose-one-pass.js');
  require('./decompose-node-module.js');
  require('./decompose-flask-blueprint.js');
});
