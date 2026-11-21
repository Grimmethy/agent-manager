'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { checkSpec, loadSpec } = require('./split-check.js');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'split-check');
const FIXTURE = path.join(FIXTURE_DIR, 'bad-split.json');

test('known-bad fixture reports every violation kind', () => {
  const { spec, rootDir } = loadSpec(FIXTURE);
  const kinds = new Set(checkSpec(spec, rootDir).map((v) => v.kind));
  assert.ok(kinds.has('nonexistent-file'), 'missing nonexistent-file');
  assert.ok(kinds.has('unordered-reference'), 'missing unordered-reference');
  assert.ok(kinds.has('signature-change-unmigrated'), 'missing signature-change-unmigrated');
});

test('well-ordered split has no violations', () => {
  const spec = {
    parentFiles: ['app/helper.js', 'app/consumer.js', 'app/cli.js'],
    children: [
      { id: 'C1', files: ['app/helper.js'], removes: ['legacyHelper'], changesSignature: ['sharedRun'] },
      { id: 'C2', files: ['app/consumer.js'], dependsOn: ['C1'] },
      { id: 'C3', files: ['app/cli.js'], dependsOn: ['C1'] },
      { id: 'C4', files: ['app/new-util.js'] },
    ],
  };
  assert.deepEqual(checkSpec(spec, FIXTURE_DIR), []);
});

test('transitive dependency satisfies the ordering rule', () => {
  const spec = {
    parentFiles: ['app/helper.js', 'app/consumer.js'],
    children: [
      { id: 'C1', files: ['app/helper.js'], removes: ['legacyHelper'] },
      { id: 'C2', files: ['app/consumer.js'], dependsOn: ['C3'] },
      { id: 'C3', files: [], dependsOn: ['C1'] },
    ],
  };
  assert.deepEqual(checkSpec(spec, FIXTURE_DIR), []);
});

test('keepsOldSignature exempts a signature change', () => {
  const spec = {
    parentFiles: ['app/helper.js', 'app/cli.js'],
    children: [
      { id: 'C1', files: ['app/helper.js'], changesSignature: ['sharedRun'], keepsOldSignature: true },
      { id: 'C3', files: ['app/cli.js'] },
    ],
  };
  assert.deepEqual(checkSpec(spec, FIXTURE_DIR), []);
});
