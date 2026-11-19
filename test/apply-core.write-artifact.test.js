'use strict';

// AC-212: writeArtifact is a single registry dispatch (getRegisteredSource -> source.apply).
// Run: node --test test/apply-core.write-artifact.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { registerTaskSource, getRegisteredSource, getRegisteredSources } = require('../src/task-source-registry.js');
const { setCandidateSplitHubFiler } = require('../src/candidate-split-hub-route.js');
const { writeArtifact, applyEntryName } = require('../src/lib/apply-core.js');

const proposals = [{ title: 'Sub one', problem: 'P1', solution: 'S1' }];

function tmpDoc() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac212-'));
  return path.join(dir, 'candidates.md');
}

test('split task on a source with its own apply still writes proposals via candidatesPath', () => {
  const doc = tmpDoc();
  let ownApplyCalled = false;
  registerTaskSource('ac212_own_apply', {
    applyOnly: true,
    apply: () => { ownApplyCalled = true; return { file: 'wrong' }; },
    candidatesPath: () => doc,
  });
  const task = { id: 't1', source: 'ac212_own_apply', candidateSplitProposals: proposals };
  assert.equal(applyEntryName(task), 'candidate-split');
  const result = writeArtifact(task, process.cwd(), os.tmpdir());
  assert.equal(ownApplyCalled, false);
  assert.ok(fs.readFileSync(doc, 'utf8').includes('Sub one'));
  assert.ok(result && !result.skipped);
});

test('split without candidatesPath throws naming the entry and task id', () => {
  registerTaskSource('ac212_no_path', { applyOnly: true, apply: () => ({}) });
  const task = { id: 't2', source: 'ac212_no_path', candidateSplitProposals: proposals };
  assert.throws(() => writeArtifact(task, process.cwd(), os.tmpdir()), /candidate-split.*t2|t2.*candidatesPath/s);
});

test('hub route reaches the filer and does not touch candidatesPath', () => {
  let touched = false;
  registerTaskSource('ac212_hub_src', { applyOnly: true, candidatesPath: () => { touched = true; return tmpDoc(); } });
  const calls = [];
  setCandidateSplitHubFiler({ applyCandidateSplitAsHub: (t, dir) => { calls.push([t.id, dir]); return { hub: true }; } });
  try {
    const task = { id: 't3', source: 'ac212_hub_src', candidateSplitProposals: proposals, candidateSplitRoute: 'hub' };
    assert.equal(applyEntryName(task), 'hub-candidate-split');
    assert.deepEqual(writeArtifact(task, process.cwd(), '/pd'), { hub: true });
    assert.deepEqual(calls, [['t3', '/pd']]);
    assert.equal(touched, false);
  } finally {
    setCandidateSplitHubFiler(null);
  }
});

test('hub route with no filer throws and never downgrades to the plain split', () => {
  setCandidateSplitHubFiler(null);
  const task = { id: 't4', source: 'ac212_hub_src', candidateSplitProposals: proposals, candidateSplitRoute: 'hub' };
  assert.throws(() => writeArtifact(task, process.cwd(), os.tmpdir()), /hub hub-candidate-split|hub-candidate-split.*t4.*no hub-task filer/s);
});

test('group B task with no source falls through to applyGroupB', () => {
  const task = { id: 't5', source: 'ac212_unregistered', implementResponse: 'not json at all' };
  assert.equal(applyEntryName(task), 'group-b');
  assert.throws(() => writeArtifact(task, process.cwd(), os.tmpdir()), /group-b.*t5.*Invalid JSON/s);
  const empty = writeArtifact({ id: 't5b', source: 'ac212_unregistered', implementResponse: '' }, process.cwd(), os.tmpdir());
  assert.equal(empty.skipped, true);
});

test('ordinary source with apply is dispatched to that apply', () => {
  registerTaskSource('ac212_ordinary', { applyOnly: true, apply: (a) => ({ file: 'ok', id: a.task.id }) });
  const task = { id: 't6', source: 'ac212_ordinary', implementResponse: 'x' };
  assert.equal(applyEntryName(task), 'ac212_ordinary');
  assert.deepEqual(writeArtifact(task, process.cwd(), os.tmpdir()), { file: 'ok', id: 't6' });
});

test('apply-only entries are registered but not enumerated as task sources', () => {
  for (const n of ['hub-candidate-split', 'candidate-split', 'group-b']) {
    assert.equal(typeof getRegisteredSource(n).apply, 'function');
    assert.ok(!getRegisteredSources().some((s) => s.name === n));
  }
});

test('writeArtifact source has no inline split/group branching and exactly one .apply( call', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/lib/apply-core.js'), 'utf8');
  const start = src.indexOf('function writeArtifact(');
  const end = src.indexOf('\nfunction ', start + 1);
  const body = src.slice(start, end);
  assert.ok(!/candidateSplitRoute|candidateSplitProposals|usesGroupB/.test(body));
  assert.equal((body.match(/\.apply\(/g) || []).length, 1);
});
