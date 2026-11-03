'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { flatPriorityOrder } = require('./workflow-priority.js');

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); }
  return o;
}

// The registered priorities of 22 task sources on 2026-11-03, in a scrambled order (the golden fixture).
const FIXTURE = [
  ['adhoc', 40], ['capability_debrief', 96], ['arch_import', 5], ['trouble_log', 44], ['unused_export', 0], ['performance_triage', 79],
  ['character_sprite_describe', 1], ['deadcode_fix', 30], ['brain_dump_disposition', 43], ['arch_review', 2], ['research_task', 43], ['ui_conformance', 5],
  ['change_review', 20], ['doc_drift_fix', 15], ['observability_triage', 79], ['arch_discovery', 4], ['derived_task', 41], ['character_regen_prompt', 1],
  ['staleness_audit', 24], ['brain_dump_sort', 70], ['arch_import_review', 3], ['change_review_fix', 10],
].map(([name, priority]) => ({ name, priority, slug: name, liveCounts: {} }));

// Written out by hand from the rule: rank = 1 + the number of sources with a strictly lower priority.
const GOLDEN = [
  ['unused_export', 0, 1],
  ['character_regen_prompt', 1, 2], ['character_sprite_describe', 1, 2],
  ['arch_review', 2, 4],
  ['arch_import_review', 3, 5],
  ['arch_discovery', 4, 6],
  ['arch_import', 5, 7], ['ui_conformance', 5, 7],
  ['change_review_fix', 10, 9],
  ['doc_drift_fix', 15, 10],
  ['change_review', 20, 11],
  ['staleness_audit', 24, 12],
  ['deadcode_fix', 30, 13],
  ['adhoc', 40, 14],
  ['derived_task', 41, 15],
  ['brain_dump_disposition', 43, 16], ['research_task', 43, 16],
  ['trouble_log', 44, 18],
  ['brain_dump_sort', 70, 19],
  ['observability_triage', 79, 20], ['performance_triage', 79, 20],
  ['capability_debrief', 96, 22],
].map(([name, priority, rank]) => ({ name, priority, rank }));

test('golden: the order and the competition ranks of 22 sources', () => {
  assert.deepEqual(flatPriorityOrder(FIXTURE), GOLDEN);
});

test('the claim order the pipeline relies on: adhoc before derived_task before brain_dump_sort', () => {
  const names = flatPriorityOrder(FIXTURE).map((e) => e.name);
  assert.ok(names.indexOf('adhoc') < names.indexOf('derived_task'));
  assert.ok(names.indexOf('derived_task') < names.indexOf('brain_dump_sort'));
});

test('sources with the same priority are ordered by name and share a rank', () => {
  const r = flatPriorityOrder([{ name: 'b', priority: 3 }, { name: 'a', priority: 3 }, { name: 'c', priority: 1 }]);
  assert.deepEqual(r, [{ name: 'c', priority: 1, rank: 1 }, { name: 'a', priority: 3, rank: 2 }, { name: 'b', priority: 3, rank: 2 }]);
});

test('the rank is not the position: a tie makes the next rank skip', () => {
  const r = flatPriorityOrder([{ name: 'a', priority: 1 }, { name: 'b', priority: 1 }, { name: 'c', priority: 1 }, { name: 'd', priority: 2 }]);
  assert.deepEqual(r.map((e) => e.rank), [1, 1, 1, 4]);
});

test('entries that cannot be ranked are skipped', () => {
  const r = flatPriorityOrder([
    null, undefined, 5, 'x', [], { priority: 1 }, { name: '', priority: 1 }, { name: 7, priority: 1 }, { name: 'p', priority: '5' }, { name: 'q', priority: NaN },
    { name: 'r', priority: Infinity }, { name: 's', priority: -Infinity }, { name: 't' }, { name: 'ok', priority: 0 },
  ]);
  assert.deepEqual(r, [{ name: 'ok', priority: 0, rank: 1 }]);
});

test('a negative or fractional priority is a priority', () => {
  const r = flatPriorityOrder([{ name: 'a', priority: 0.5 }, { name: 'b', priority: -1 }]);
  assert.deepEqual(r, [{ name: 'b', priority: -1, rank: 1 }, { name: 'a', priority: 0.5, rank: 2 }]);
});

test('a duplicate name keeps the first entry', () => {
  const r = flatPriorityOrder([{ name: 'a', priority: 9 }, { name: 'b', priority: 5 }, { name: 'a', priority: 1 }]);
  assert.deepEqual(r, [{ name: 'b', priority: 5, rank: 1 }, { name: 'a', priority: 9, rank: 2 }]);
});

test('input that is not an array gives an empty list', () => {
  [undefined, null, {}, 'x', 5, true, { length: 2, 0: { name: 'a', priority: 1 } }].forEach((x) => assert.deepEqual(flatPriorityOrder(x), []));
  assert.deepEqual(flatPriorityOrder([]), []);
});

test('the input is not mutated and two calls give the same result', () => {
  const input = deepFreeze(FIXTURE.map((e) => ({ ...e })));
  const a = flatPriorityOrder(input);
  assert.deepEqual(flatPriorityOrder(input), a);
  assert.deepEqual(input.map((e) => e.name), FIXTURE.map((e) => e.name));
  a[0].rank = 99;
  assert.equal(flatPriorityOrder(input)[0].rank, 1);
});

test('an entry whose getter throws gives an empty list instead of an exception', () => {
  const bad = { name: 'a', get priority() { throw new Error('boom'); } };
  assert.deepEqual(flatPriorityOrder([{ name: 'z', priority: 1 }, bad]), []);
});

test('only an array is read: a Set or a generator of entries gives an empty list', () => {
  const entry = { name: 'a', priority: 1 };
  assert.deepEqual(flatPriorityOrder(new Set([entry])), []);
  assert.deepEqual(flatPriorityOrder((function* () { yield entry; })()), []);
  assert.deepEqual(flatPriorityOrder([entry]), [{ name: 'a', priority: 1, rank: 1 }]);
});
