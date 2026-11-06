'use strict';

// invalidPremiseSignal decides on a task's own `Files:` line when it has one (2026-11-01, pf-backend HUB0001 piece 1).
//
// Run: node --test src/staleness-files-line.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { invalidPremiseSignal, ownFilesLine } = require('./staleness-audit-signals.js');

// A plain folder is enough: resolveAgainstRepo looks the path up on disk.
function makeRepo(files) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-files-line-'));
  for (const rel of files) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), 'x\n');
  }
  return repo;
}

// The live shape: a shared-contract paragraph that names a file a LATER piece creates, then the piece's own scope on a Files line.
const LIVE = 'CONTRACT: validation lives in src/services/callLog.js (created by a later piece).\n\nEdit prisma/schema.prisma to add the two models.\nFiles: prisma/schema.prisma';
const task = (rawText, over = {}) => ({ id: 'HUB0001-01', title: 'Add models', source: 'manual', promptContext: { rawText }, history: [], ...over });

test('the live case: a forward reference plus an existing own file is NOT an invalid premise', () => {
  const repo = makeRepo(['prisma/schema.prisma']);
  assert.equal(invalidPremiseSignal(repo, task(LIVE)).hit, false);
});

test('the same text with the own file absent still fires and names it', () => {
  const repo = makeRepo([]);
  const r = invalidPremiseSignal(repo, task(LIVE));
  assert.equal(r.hit, true);
  assert.match(r.evidence[0], /prisma\/schema\.prisma/);
  assert.doesNotMatch(r.evidence[0], /callLog/);
});

test('a Files line with one present and one absent path is not a hit', () => {
  const repo = makeRepo(['src/a.js']);
  const t = task('Edit src/a.js and add src/b.js.\nFiles: src/a.js, src/b.js');
  assert.equal(invalidPremiseSignal(repo, t).hit, false);
});

test('without a Files line the behaviour is exactly as before, in both directions', () => {
  const absent = makeRepo([]);
  const present = makeRepo(['src/a.js']);
  const t = task('Fix the bug in src/a.js please.');
  assert.equal(invalidPremiseSignal(absent, t).hit, true);
  assert.equal(invalidPremiseSignal(present, t).hit, false);
});

test('ownFilesLine parses commas and trims, caps at 20, drops unsafe entries and returns [] without a line', () => {
  assert.deepEqual(ownFilesLine(task('x\nFiles:  a/b.js ,  c/d.mjs  ,, e.sql')), ['a/b.js', 'c/d.mjs', 'e.sql']);
  const many = Array.from({ length: 30 }, (_, i) => `f${i}.js`).join(', ');
  assert.equal(ownFilesLine(task(`Files: ${many}`)).length, 20);
  assert.deepEqual(ownFilesLine(task('Files: has space.js, ../escape.js, /abs/path.js, ok.js')), ['ok.js']);
  assert.deepEqual(ownFilesLine(task('no such line here')), []);
  assert.deepEqual(ownFilesLine({ promptContext: {} }), []);
  assert.deepEqual(ownFilesLine(null), []);
});

test('promptContext.newFile is still excluded from the own files', () => {
  const repo = makeRepo([]);
  const t = task('Create the file.\nFiles: src/new.js', { promptContext: { rawText: 'Create the file.\nFiles: src/new.js', newFile: 'src/new.js' } });
  assert.equal(invalidPremiseSignal(repo, t).hit, false);
});

test('a Files line naming .sql, .mjs and .css paths is honoured', () => {
  const repo = makeRepo(['db/up.sql']);
  const t = task('Mentions src/ghost.js in prose.\nFiles: db/up.sql, server/app.mjs, ui/style.css');
  assert.equal(invalidPremiseSignal(repo, t).hit, false);
  const none = makeRepo([]);
  assert.equal(invalidPremiseSignal(none, t).hit, true);
});

test('existsAtRef rescues an own file that only a chain branch has', () => {
  const repo = makeRepo([]);
  const t = task('Files: src/lib/tileGrid.ts');
  assert.equal(invalidPremiseSignal(repo, t).hit, true);
  assert.equal(invalidPremiseSignal(repo, t, (p) => p === 'src/lib/tileGrid.ts').hit, false);
});
