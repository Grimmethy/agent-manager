'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { flatPriorityOrder, groupPriorityOrder } = require('./workflow-priority.js');

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

// ---- groupPriorityOrder (HUB0331 piece W-E1) ----

const flat = (pairs) => flatPriorityOrder(pairs.map(([name, priority]) => ({ name, priority })));
const src = (name, parent) => ({ id: 'source:' + name, kind: 'source', parent: parent === undefined ? null : parent });
const grp = (id, ...children) => ({ id, label: id, children, collapsed: false });
const FLAT8 = flat([['a1', 1], ['a2', 5], ['b1', 10], ['b2', 20], ['c1', 30], ['c2', 40], ['d1', 50], ['u1', 60]]);
// Ranks by hand: flat ranks are 1..8 in that order. Group order: fix (b1 b2), idea (a1 c1), house (c2 d1), then the ungrouped a2 and u1.
// Sorted by (group, priority): b1 b2 a1 c1 c2 d1 a2 u1 -> graph ranks 1..8.
const GRAPH8 = {
  nodes: [src('a1', 'group:idea'), src('a2'), src('b1', 'group:fix'), src('b2', 'group:fix'), src('c1', 'group:idea'), src('c2', 'group:house'), src('d1', 'group:house'), src('u1')],
  groups: [grp('group:fix', 'source:b1', 'source:b2'), grp('group:idea', 'source:a1', 'source:c1'), grp('group:house', 'source:c2', 'source:d1')],
};

test('golden: eight sources in three groups, ranks written out by hand', () => {
  assert.deepEqual(groupPriorityOrder(GRAPH8, FLAT8), [
    { name: 'a1', flatRank: 1, graphRank: 3, group: 'group:idea' },
    { name: 'a2', flatRank: 2, graphRank: 7, group: null },
    { name: 'b1', flatRank: 3, graphRank: 1, group: 'group:fix' },
    { name: 'b2', flatRank: 4, graphRank: 2, group: 'group:fix' },
    { name: 'c1', flatRank: 5, graphRank: 4, group: 'group:idea' },
    { name: 'c2', flatRank: 6, graphRank: 5, group: 'group:house' },
    { name: 'd1', flatRank: 7, graphRank: 6, group: 'group:house' },
    { name: 'u1', flatRank: 8, graphRank: 8, group: null },
  ]);
});

test('reversing the order of the groups reverses the blocks and keeps the flat order inside each', () => {
  // house (c2 d1), idea (a1 c1), fix (b1 b2), then the ungrouped a2 and u1: c2 1, d1 2, a1 3, c1 4, b1 5, b2 6, a2 7, u1 8
  const rev = { ...GRAPH8, groups: [...GRAPH8.groups].reverse() };
  const r = groupPriorityOrder(rev, FLAT8);
  assert.deepEqual(r.map((e) => [e.name, e.graphRank]), [['a1', 3], ['a2', 7], ['b1', 5], ['b2', 6], ['c1', 4], ['c2', 1], ['d1', 2], ['u1', 8]]);
});

test('sources of one group with the same priority share a graph rank and the next rank skips', () => {
  const f = flat([['x', 5], ['y', 5], ['z', 9]]);
  const g = { nodes: [src('x', 'group:g'), src('y', 'group:g'), src('z', 'group:g')], groups: [grp('group:g', 'source:x', 'source:y', 'source:z')] };
  assert.deepEqual(groupPriorityOrder(g, f).map((e) => e.graphRank), [1, 1, 3]);
});

test('a source in an inner group counts in the index of the outermost group', () => {
  const f = flat([['p', 1], ['q', 2], ['r', 3]]);
  const g = { nodes: [src('p'), src('q', 'group:inner'), src('r', 'group:top')], groups: [grp('group:other', 'source:p'), grp('group:top', 'group:inner', 'source:r'), grp('group:inner', 'source:q')] };
  // p is in no group's node.parent (ungrouped); top is index 1, so q (inner) and r (top) are both in index 1: q (2) before r (3); p last.
  assert.deepEqual(groupPriorityOrder(g, f).map((e) => [e.name, e.group, e.graphRank]), [['p', null, 3], ['q', 'group:top', 1], ['r', 'group:top', 2]]);
});

test('a cycle of group ids, a parent that is not a group and a source that is not in the graph do not throw and count as expected', () => {
  const f = flat([['a', 1], ['b', 2], ['c', 3]]);
  const g = { nodes: [src('a', 'group:x'), src('b', 'nope')], groups: [grp('group:x', 'group:y'), grp('group:y', 'group:x')] };
  const r = groupPriorityOrder(g, f);
  assert.equal(r.length, 3);
  assert.equal(r.find((e) => e.name === 'b').group, null);
  assert.equal(r.find((e) => e.name === 'c').group, null);
  assert.notEqual(r.find((e) => e.name === 'a').group, null);
});

test('prototype names work as group ids', () => {
  const f = flat([['a', 1], ['b', 2]]);
  const g = { nodes: [src('a', 'constructor'), src('b')], groups: [grp('constructor', 'source:a')] };
  assert.deepEqual(groupPriorityOrder(g, f), [{ name: 'a', flatRank: 1, graphRank: 1, group: 'constructor' }, { name: 'b', flatRank: 2, graphRank: 2, group: null }]);
});

test('nothing grouped, or an input that cannot be used, gives an empty list', () => {
  assert.deepEqual(groupPriorityOrder({ nodes: [src('a1')], groups: [] }, FLAT8), []);
  assert.deepEqual(groupPriorityOrder({ nodes: [src('a1', 'group:nobody')], groups: [grp('group:g', 'source:zzz')] }, FLAT8), []);
  for (const bad of [null, undefined, 5, 'x', [], {}, { nodes: 'x' }]) assert.deepEqual(groupPriorityOrder(bad, FLAT8), [], JSON.stringify(bad));
  for (const bad of [null, undefined, {}, 'x']) assert.deepEqual(groupPriorityOrder(GRAPH8, bad), [], JSON.stringify(bad));
});

test('entries that cannot be used are skipped and the rest are still ranked', () => {
  const f = [...FLAT8.slice(0, 3), null, { name: 'bad', priority: NaN, rank: 1 }, { name: 'worse', priority: 1 }];
  assert.deepEqual(groupPriorityOrder(GRAPH8, f).map((e) => e.name), ['a1', 'a2', 'b1']);
});

test('the inputs are not mutated and two calls give the same result', () => {
  const g = deepFreeze(JSON.parse(JSON.stringify(GRAPH8)));
  const f = deepFreeze(JSON.parse(JSON.stringify(FLAT8)));
  const a = groupPriorityOrder(g, f);
  assert.deepEqual(groupPriorityOrder(g, f), a);
  a[0].graphRank = 99;
  assert.equal(groupPriorityOrder(g, f)[0].graphRank, 3);
});

test('a throwing node gives an empty list', () => {
  const g = { nodes: [{ get id() { throw new Error('boom'); } }], groups: [] };
  assert.deepEqual(groupPriorityOrder(g, FLAT8), []);
});

test('only an array of entries is read, a group without id is ignored, bad groups do not hide the good ones', () => {
  assert.deepEqual(groupPriorityOrder(GRAPH8, new Set(FLAT8)), []);
  const f = flat([['a', 1], ['b', 2]]);
  const g = { nodes: [src('a', 'undefined'), src('b', 'group:ok')], groups: [{ children: ['source:a'] }, { id: 'group:str', children: 'source:b' }, grp('group:ok', 'source:b')] };
  assert.deepEqual(groupPriorityOrder(g, f), [{ name: 'a', flatRank: 1, graphRank: 2, group: null }, { name: 'b', flatRank: 2, graphRank: 1, group: 'group:ok' }]);
});

test('a group listed by two groups goes up to the first, three levels of nesting reach the outermost, prototype names nest', () => {
  const f = flat([['a', 1], ['b', 2], ['c', 3]]);
  const two = { nodes: [src('a', 'group:in'), src('b', 'group:two'), src('c', 'group:one')], groups: [grp('group:one', 'group:in', 'source:c'), grp('group:two', 'group:in', 'source:b'), grp('group:in', 'source:a')] };
  assert.deepEqual(groupPriorityOrder(two, f).map((e) => [e.name, e.group, e.graphRank]), [['a', 'group:one', 1], ['b', 'group:two', 3], ['c', 'group:one', 2]]);
  const deep = { nodes: [src('a', 'group:l3'), src('b'), src('c', 'group:l1')], groups: [grp('group:l1', 'group:l2', 'source:c'), grp('group:l2', 'group:l3'), grp('group:l3', 'source:a')] };
  assert.deepEqual(groupPriorityOrder(deep, f).map((e) => [e.name, e.group]), [['a', 'group:l1'], ['b', null], ['c', 'group:l1']]);
  const proto = { nodes: [src('a', 'constructor'), src('b'), src('c', 'group:o')], groups: [grp('group:o', 'constructor', 'source:c'), grp('constructor', 'source:a')] };
  assert.deepEqual(groupPriorityOrder(proto, f).map((e) => e.group), ['group:o', null, 'group:o']);
});

test('the first node with an id decides, a parent that is not a string is no group, an entry without a string name is skipped', () => {
  const f = flat([['a', 1], ['b', 2]]);
  const dup = { nodes: [src('a', 'group:g'), src('a', null), src('b')], groups: [grp('group:g', 'source:a')] };
  assert.equal(groupPriorityOrder(dup, f)[0].group, 'group:g');
  const num = { nodes: [src('a', 5), src('b', 'group:5')], groups: [grp('5', 'source:a'), grp('group:5', 'source:b')] };
  assert.deepEqual(groupPriorityOrder(num, f).map((e) => e.group), [null, 'group:5']);
  assert.deepEqual(groupPriorityOrder(GRAPH8, [{ name: 7, priority: 1, rank: 1 }, ...FLAT8]).map((e) => e.name), FLAT8.map((e) => e.name));
});
