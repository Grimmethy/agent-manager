'use strict';

// Unit tests for assertStageableFiles (src/lib/apply-core.js) -- the pathspec guard added
// after a real live failure (2026-09-01, pipeline_forensics): a registered source whose
// artifact carried neither `file` nor `files` reached `git add [undefined]`, producing
// "fatal: pathspec 'undefined' did not match any files". apply-task.js:363 and
// lib/apply-main-batch.js:44 now call this guard before any git write; integration-level
// coverage already exists in src/apply-task.test.js, but the guard itself has no direct
// unit tests by its exported name and no t.mock.method-on-child_process proof that no
// subprocess is spawned on the bad shape. This file closes that gap.
//
// Run: node --test src/lib/apply-core.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertStageableFiles } = require('./apply-core.js');

const task = { id: 'guard-unit-1' };

test('assertStageableFiles throws "no target file path" when files is undefined', () => {
  assert.throws(() => assertStageableFiles(task, undefined), new RegExp(`task ${task.id}: no target file path`));
});

test('assertStageableFiles throws when files is the live failure shape [undefined]', () => {
  assert.throws(() => assertStageableFiles(task, [undefined]), /no target file path/);
});

test('assertStageableFiles throws when files is an empty array', () => {
  assert.throws(() => assertStageableFiles(task, []), /no target file path/);
});

test('assertStageableFiles throws when files contains an empty string', () => {
  assert.throws(() => assertStageableFiles(task, ['']), /no target file path/);
});

test('assertStageableFiles documents its exact boundary: only length 0 is rejected, not whitespace-only strings', () => {
  // The guard's real contract is `typeof f === 'string' && f.length > 0` -- a whitespace-only
  // string passes (it would be a valid, if odd, pathspec). Pin the actual behavior so a
  // silent tightening of the guard is visible in the diff/review, not silently accepted.
  assert.doesNotThrow(() => assertStageableFiles(task, ['   \n  ']));
});

test('assertStageableFiles throws when files contains a non-string element', () => {
  assert.throws(() => assertStageableFiles(task, [null]), /no target file path/);
});

test('assertStageableFiles accepts a single valid path (does not throw)', () => {
  assert.doesNotThrow(() => assertStageableFiles(task, ['src/foo.js']));
});

test('assertStageableFiles accepts multiple valid paths (does not throw)', () => {
  assert.doesNotThrow(() => assertStageableFiles(task, ['src/foo.js', 'src/bar.js']));
});

test('assertStageableFiles does not spawn a git subprocess on the bad shape (no child_process call at all)', (t) => {
  // The guard must short-circuit BEFORE any git subprocess; mock the child_process entry
  // points used by src/apply-task.js's git sequence and prove none was touched after the
  // throw. The guard throws for [undefined] -- the exact shape that used to reach git add.
  const cp = require('child_process');
  const spied = ['exec', 'execFile', 'execSync', 'spawn', 'spawnSync'].map((name) => {
    const spy = t.mock.method(cp, name, () => {
      throw new Error(`child_process.${name} was called -- the guard must throw before any git subprocess`);
    });
    return { name, spy };
  });
  assert.throws(() => assertStageableFiles(task, [undefined]), /no target file path/);
  for (const { name, spy } of spied) {
    assert.equal(spy.mock.callCount(), 0, `child_process.${name} must never be called when the guard throws`);
  }
});
