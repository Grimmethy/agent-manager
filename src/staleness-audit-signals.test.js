'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyFileStatus, invalidPremiseSignal } = require('./staleness-audit-signals.js');

test('(1) a piece that creates tests/test_x.py is not flagged', () => {
  const promptContext = { newFile: 'tests/test_x.py' };
  assert.equal(classifyFileStatus('tests/test_x.py', promptContext, 'hub', 0), 'created');
  const signal = invalidPremiseSignal({
    promptContext,
    filesLine: 'tests/test_x.py (new)',
    hubBranch: 'hub',
    stackIndex: 0,
  });
  assert.equal(signal, null);
});

test('(2) a piece editing a missing file is flagged', () => {
  const promptContext = {};
  assert.equal(classifyFileStatus('src/missing.js', promptContext, 'hub', 0), 'absent-evidence');
  const signal = invalidPremiseSignal({
    promptContext,
    filesLine: 'src/missing.js',
    hubBranch: 'hub',
    stackIndex: 0,
  });
  assert.notEqual(signal, null);
  assert.deepEqual(signal.details.absentEvidenceFiles, ['src/missing.js']);
  assert.deepEqual(signal.details.createdFiles, []);
});

test('(3) a stacked piece whose file exists only on the hub tip is not flagged', () => {
  const promptContext = {};
  const existsAtRef = (p) => p === 'src/feature.js';
  assert.equal(
    classifyFileStatus('src/feature.js', promptContext, 'hub', 1, existsAtRef),
    'exists-on-hub',
  );
  const signal = invalidPremiseSignal({
    promptContext,
    filesLine: 'src/feature.js',
    hubBranch: 'hub',
    stackIndex: 1,
    existsAtRef,
  });
  assert.equal(signal, null);
});

test('(4) mixed lists are decided on edit/read entries only', () => {
  const signal = invalidPremiseSignal({
    promptContext: {},
    filesLine: 'src/a.js, tests/x.py (new)',
    hubBranch: 'hub',
    stackIndex: 0,
  });
  assert.notEqual(signal, null);
  assert.deepEqual(signal.details.absentEvidenceFiles, ['src/a.js']);
  assert.deepEqual(signal.details.createdFiles, ['tests/x.py']);
});

test('(4b) a missing created file does not flag when the edit entry exists on hub', () => {
  const existsAtRef = (p) => p === 'src/a.js';
  const signal = invalidPremiseSignal({
    promptContext: {},
    filesLine: 'src/a.js, tests/x.py (new)',
    hubBranch: 'hub',
    stackIndex: 1,
    existsAtRef,
  });
  assert.equal(signal, null);
});
