// Node tests for the pure drag helpers of the Workers workflow graph (HUB0346 piece 3).
// Run: node --test python/dashboard/tests/test_workflow_drag.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const d = require(path.join(__dirname, '..', 'static', 'js', 'workflow-drag.js'));

const fakeStorage = (initial) => {
  const data = new Map(initial ? Object.entries(initial) : []);
  return { data, getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => { data.set(k, String(v)); } };
};
const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };

test('a press that moves 4 px is a click, 6 px is a drag, and bad numbers never start a drag', () => {
  assert.equal(d.DRAG_THRESHOLD_PX, 5);
  assert.equal(d.movedPastThreshold(4, 0), false);
  assert.equal(d.movedPastThreshold(0, -4), false);
  assert.equal(d.movedPastThreshold(6, 0), true);
  assert.equal(d.movedPastThreshold(3, 4), false, 'exactly 5 px is still a click');
  assert.equal(d.movedPastThreshold(4, 4), true, 'diagonal 5.66 px is a drag');
  [[NaN, 10], [10, Infinity], [undefined, 10], ['9', 9]].forEach(([a, b]) => assert.equal(d.movedPastThreshold(a, b), false));
});

test('moveBy divides the pointer delta by the card scale, rounds, and never goes negative', () => {
  assert.deepEqual(d.moveBy({ x: 100, y: 50 }, 40, 20, 1), { x: 140, y: 70 });
  assert.deepEqual(d.moveBy({ x: 100, y: 50 }, 40, 20, 0.5), { x: 180, y: 90 });
  assert.deepEqual(d.moveBy({ x: 10, y: 10 }, 1, 1, 3), { x: 10, y: 10 }, '0.33 rounds away');
  assert.deepEqual(d.moveBy({ x: 10, y: 10 }, 2, 2, 3), { x: 11, y: 11 }, '0.67 rounds up');
  assert.deepEqual(d.moveBy({ x: 10, y: 10 }, -50, -80, 1), { x: 0, y: 0 });
});

test('moveBy treats a missing or bad scale as 1 and bad numbers as no movement', () => {
  [undefined, 0, -2, NaN, Infinity, '2'].forEach((scale) => assert.deepEqual(d.moveBy({ x: 8, y: 8 }, 10, 10, scale), { x: 18, y: 18 }, String(scale)));
  assert.deepEqual(d.moveBy(null, 10, 10, 1), { x: 10, y: 10 });
  assert.deepEqual(d.moveBy({ x: 8, y: 8 }, NaN, undefined, 1), { x: 8, y: 8 });
});

test('a saved position round-trips through the storage under workersGraphPositions', () => {
  const st = fakeStorage();
  assert.equal(d.saveOffset(st, 'worker-1', 'source:a', { x: 40, y: 120 }), true);
  assert.deepEqual(d.loadOffsets(st, 'worker-1'), { 'source:a': { x: 40, y: 120 } });
  assert.deepEqual(JSON.parse(st.data.get('workersGraphPositions')), { 'worker-1': { 'source:a': { x: 40, y: 120 } } });
  assert.equal(d.WF_POSITIONS_KEY, 'workersGraphPositions');
});

test('positions are kept per loop card and per node, and a later save replaces only its own node', () => {
  const st = fakeStorage();
  d.saveOffset(st, 'worker-1', 'source:shared', { x: 1, y: 2 });
  d.saveOffset(st, 'worker-2', 'source:shared', { x: 30, y: 40 });
  d.saveOffset(st, 'worker-1', 'worker-1', { x: 5, y: 6 });
  d.saveOffset(st, 'worker-1', 'source:shared', { x: 9, y: 9 });
  assert.deepEqual(d.loadOffsets(st, 'worker-1'), { 'source:shared': { x: 9, y: 9 }, 'worker-1': { x: 5, y: 6 } });
  assert.deepEqual(d.loadOffsets(st, 'worker-2'), { 'source:shared': { x: 30, y: 40 } });
  assert.deepEqual(d.loadOffsets(st, 'worker-3'), {});
});

test('bad positions are not saved and bad saved entries are not loaded', () => {
  const st = fakeStorage();
  [null, {}, { x: NaN, y: 1 }, { x: 1, y: Infinity }, { x: '1', y: 2 }].forEach((p) => assert.equal(d.saveOffset(st, 'l', 'n', p), false));
  assert.equal(d.saveOffset(st, 5, 'n', { x: 1, y: 1 }), false);
  assert.equal(d.saveOffset(st, 'l', null, { x: 1, y: 1 }), false);
  assert.equal(st.data.size, 0);
  const dirty = fakeStorage({ workersGraphPositions: JSON.stringify({ l: { ok: { x: 1, y: 2 }, nan: { x: null, y: 1 }, str: { x: 'a', y: 2 }, nul: null } }) });
  assert.deepEqual(d.loadOffsets(dirty, 'l'), { ok: { x: 1, y: 2 } });
});

test('a storage that throws, is missing, or holds garbage never throws and just remembers nothing', () => {
  assert.equal(d.saveOffset(throwing, 'l', 'n', { x: 1, y: 1 }), false);
  assert.deepEqual(d.loadOffsets(throwing, 'l'), {});
  assert.equal(d.saveOffset(null, 'l', 'n', { x: 1, y: 1 }), false);
  assert.deepEqual(d.loadOffsets(undefined, 'l'), {});
  ['not json', '[1,2]', '"x"', 'null', '5'].forEach((raw) => {
    const st = fakeStorage({ workersGraphPositions: raw });
    assert.deepEqual(d.loadOffsets(st, 'l'), {}, raw);
    assert.equal(d.saveOffset(st, 'l', 'n', { x: 2, y: 3 }), true, 'a bad blob is replaced by a good one');
    assert.deepEqual(d.loadOffsets(st, 'l'), { n: { x: 2, y: 3 } });
  });
});

test('a loop id named like an Object.prototype member is just a loop id', () => {
  const st = fakeStorage();
  assert.deepEqual(d.loadOffsets(st, 'constructor'), {});
  assert.equal(d.saveOffset(st, 'constructor', 'toString', { x: 1, y: 2 }), true);
  assert.deepEqual(d.loadOffsets(st, 'constructor'), { toString: { x: 1, y: 2 } });
  assert.deepEqual(d.loadOffsets(st, 'hasOwnProperty'), {});
});

test('clearOffsets forgets the listed loops, or everything when no list is given', () => {
  const st = fakeStorage();
  d.saveOffset(st, 'a', 'n', { x: 1, y: 1 });
  d.saveOffset(st, 'b', 'n', { x: 2, y: 2 });
  d.saveOffset(st, 'c', 'n', { x: 3, y: 3 });
  assert.equal(d.clearOffsets(st, ['a', 'c']), true);
  assert.deepEqual(d.loadOffsets(st, 'a'), {});
  assert.deepEqual(d.loadOffsets(st, 'b'), { n: { x: 2, y: 2 } });
  assert.equal(d.clearOffsets(st), true);
  assert.deepEqual(d.loadOffsets(st, 'b'), {});
  assert.equal(d.clearOffsets(throwing, ['a']), false);
});

test('applyOffsets lays saved positions over the layout and ignores unknown ids and bad numbers', () => {
  const positions = { a: { x: 0, y: 0 }, b: { x: 300, y: 0 }, c: { x: 0, y: 130 } };
  const out = d.applyOffsets(positions, { a: { x: 40, y: 8 }, gone: { x: 1, y: 1 }, b: { x: NaN, y: 4 }, c: null }, ['a', 'b', 'c']);
  assert.deepEqual(out, { a: { x: 40, y: 8 }, b: { x: 300, y: 0 }, c: { x: 0, y: 130 } });
  assert.ok(!('gone' in out));
});

test('applyOffsets only moves ids that are valid for this card (array or Set) and exist in the layout', () => {
  const positions = { a: { x: 0, y: 0 }, b: { x: 300, y: 0 } };
  const offsets = { a: { x: 5, y: 5 }, b: { x: 6, y: 6 } };
  assert.deepEqual(d.applyOffsets(positions, offsets, ['a']), { a: { x: 5, y: 5 }, b: { x: 300, y: 0 } });
  assert.deepEqual(d.applyOffsets(positions, offsets, new Set(['b'])), { a: { x: 0, y: 0 }, b: { x: 6, y: 6 } });
  assert.deepEqual(d.applyOffsets(positions, offsets, undefined), positions);
  assert.deepEqual(d.applyOffsets(positions, { c: { x: 1, y: 1 } }, ['a', 'b', 'c']), positions, 'an id the layout lacks is not invented');
});

test('applyOffsets does not mutate its inputs and an unmoved node keeps the very same object', () => {
  const positions = { a: { x: 0, y: 0 }, b: { x: 300, y: 0 } };
  const offsets = { a: { x: 5, y: 5 } };
  const pCopy = JSON.parse(JSON.stringify(positions));
  const oCopy = JSON.parse(JSON.stringify(offsets));
  const out = d.applyOffsets(positions, offsets, ['a', 'b']);
  assert.deepEqual(positions, pCopy);
  assert.deepEqual(offsets, oCopy);
  assert.notEqual(out, positions);
  assert.equal(out.b, positions.b, 'the view tells moved from unmoved by identity');
  assert.notEqual(out.a, positions.a);
  assert.deepEqual(d.applyOffsets(null, null, null), {});
});

test('edgeBetween runs bottom middle to top middle, and flips when the target sits above', () => {
  const size = { w: 272, h: 128 };
  assert.deepEqual(d.edgeBetween({ x: 0, y: 0 }, { x: 300, y: 200 }, size), [{ x: 136, y: 128 }, { x: 436, y: 200 }]);
  assert.deepEqual(d.edgeBetween({ x: 0, y: 400 }, { x: 0, y: 0 }, size), [{ x: 136, y: 400 }, { x: 136, y: 128 }]);
  assert.deepEqual(d.edgeBetween({ x: 0, y: 0 }, { x: 0, y: 128 }, size), [{ x: 136, y: 128 }, { x: 136, y: 128 }], 'touching counts as below');
  assert.deepEqual(d.edgeBetween({ x: 0, y: 0 }, { x: 60, y: 64 }, size), [{ x: 136, y: 128 }, { x: 196, y: 64 }], 'overlapping nodes keep bottom to top');
  assert.deepEqual(d.edgeBetween({ x: 0, y: 100 }, { x: 0, y: 99 }, size), [{ x: 136, y: 100 }, { x: 136, y: 227 }], 'a target even one pixel higher flips');
  assert.doesNotThrow(() => d.edgeBetween(null, undefined, null));
  d.edgeBetween(null, undefined, null).forEach((p) => assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y)));
});
