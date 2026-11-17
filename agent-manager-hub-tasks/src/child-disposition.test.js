'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyChild, hubDispositionFor, historyEvent } = require('./child-disposition.js');

const evidence = (yes) => ({ mergeEvidence: () => yes });

test('merged child archived as superseded stays merged', () => {
  const child = { id: 'c1', archive: { reason: 'superseded', supersededBy: 'c9' } };
  const r = classifyChild(child, evidence(true));
  assert.equal(r.classification, 'merged');
  assert.equal(r.disposition, 'merged');
});

test('throwing merge lookup yields needs-human, never noop', () => {
  const child = { id: 'c2', archive: { reason: 'superseded', supersededBy: 'c9' } };
  const r = classifyChild(child, { mergeEvidence: () => { throw new Error('git down'); } });
  assert.equal(r.disposition, 'needs-human');
  assert.notEqual(r.disposition, 'noop');
});

test('superseded reason without superseding reference is discarded/needs-human', () => {
  const r = classifyChild({ id: 'c3', archive: { reason: 'superseded' } }, evidence(false));
  assert.equal(r.classification, 'discarded');
  assert.equal(r.disposition, 'needs-human');
});

test('no archive reason and no merge evidence is discarded/needs-human', () => {
  const r = classifyChild({ id: 'c4' }, evidence(false));
  assert.equal(r.classification, 'discarded');
  assert.equal(r.disposition, 'needs-human');
});

test('genuine redundant child (reason + reference, no merge) is noop', () => {
  const child = { id: 'c5', archive: { reason: 'superseded', supersededBy: 'c9' } };
  const r = classifyChild(child, evidence(false));
  assert.equal(r.classification, 'redundant');
  assert.equal(r.disposition, 'noop');
  const ev = historyEvent('HUB1', child, r.classification, r.disposition);
  assert.deepEqual(Object.keys(ev).sort(), ['childId', 'classification', 'disposition', 'hubId', 'reason']);
  assert.equal(ev.hubId, 'HUB1');
  assert.equal(ev.childId, 'c5');
  assert.equal(ev.classification, 'redundant');
  assert.equal(ev.disposition, 'noop');
});

test('merge lookup is called once per child and never for recorded-merged children', () => {
  let calls = 0;
  const ctx = { mergeEvidence: () => { calls += 1; return false; } };
  classifyChild({ id: 'a' }, ctx);
  classifyChild({ id: 'b', archive: { reason: 'x' } }, ctx);
  assert.equal(calls, 2);
  classifyChild({ id: 'c', mergedAt: 'x' }, ctx);
  assert.equal(calls, 2);
});

test('hubDispositionFor precedence and doneMarker', () => {
  const kids = [
    { childId: 'k1', disposition: 'merged' },
    { childId: 'k2', disposition: 'needs-human' },
    { childId: 'k3', disposition: 'merged' },
  ];
  const h = hubDispositionFor(kids);
  assert.equal(h.disposition, 'needs-human');
  assert.match(h.doneMarker, /k2/);
  assert.equal(hubDispositionFor([{ childId: 'a', disposition: 'merged' }, { childId: 'b', disposition: 'noop' }]).disposition, 'noop');
  assert.equal(hubDispositionFor([{ childId: 'a', disposition: 'merged' }]).disposition, 'merged');
  assert.equal(hubDispositionFor([]).disposition, 'needs-human');
});
