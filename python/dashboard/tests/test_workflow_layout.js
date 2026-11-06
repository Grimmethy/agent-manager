// Node tests for the pure workflow graph layout (HUB0323 piece W-A3).
// Run: node --test python/dashboard/tests/test_workflow_layout.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { layoutGraph } = require(path.join(__dirname, '..', 'static', 'js', 'workflow-layout.js'));

const N = (...ids) => ids.map((id) => ({ id }));
const E = (...pairs) => pairs.map(([from, to]) => ({ id: `${from}->${to}:claims`, from, to }));
const STEP_X = 240 + 48; // default nodeW + gapX
const STEP_Y = 96 + 24; // default nodeH + gapY

test('chain a->b->c puts the nodes in three layers', () => {
  const r = layoutGraph({ nodes: N('a', 'b', 'c'), edges: E(['a', 'b'], ['b', 'c']) });
  assert.equal(r.positions.a.x, 0);
  assert.equal(r.positions.b.x, STEP_X);
  assert.equal(r.positions.c.x, STEP_X * 2);
  assert.equal(r.positions.a.y, 0);
  assert.equal(r.positions.c.y, 0);
  assert.equal(r.edges.length, 2);
  assert.ok(r.edges.every((e) => e.back === false));
});

test('edge points run from the right middle of the source to the left middle of the target', () => {
  const r = layoutGraph({ nodes: N('a', 'b'), edges: E(['a', 'b']) });
  const pts = r.edges[0].points;
  assert.deepEqual(pts[0], { x: 240, y: 48 });
  assert.deepEqual(pts[pts.length - 1], { x: STEP_X, y: 48 });
});

test('fan-out: children share a layer and stack by id', () => {
  const r = layoutGraph({ nodes: N('a', 'z', 'm', 'b'), edges: E(['a', 'b'], ['a', 'm'], ['a', 'z']) });
  assert.equal(r.positions.b.x, STEP_X);
  assert.equal(r.positions.m.x, STEP_X);
  assert.equal(r.positions.z.x, STEP_X);
  assert.deepEqual([r.positions.b.y, r.positions.m.y, r.positions.z.y], [0, STEP_Y, STEP_Y * 2]);
});

test('fan-in: the target sits one layer after its deepest source', () => {
  const r = layoutGraph({ nodes: N('a', 'b', 'c', 't'), edges: E(['a', 't'], ['b', 't'], ['b', 'c'], ['c', 't']) });
  assert.equal(r.positions.a.x, 0);
  assert.equal(r.positions.b.x, 0);
  assert.equal(r.positions.c.x, STEP_X);
  assert.equal(r.positions.t.x, STEP_X * 2);
});

test('diamond a->b,c->d gives d the longest-path layer', () => {
  const r = layoutGraph({ nodes: N('a', 'b', 'c', 'd'), edges: E(['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']) });
  assert.equal(r.positions.d.x, STEP_X * 2);
  assert.equal(r.positions.b.x, r.positions.c.x);
  // d is placed at the average row of its two sources
  assert.equal(r.positions.d.y, 0);
});

test('later layers are ordered by the average row of their placed neighbours', () => {
  // x hangs off the second root, y off the first: y must come first despite its larger id
  const r = layoutGraph({ nodes: N('r1', 'r2', 'x', 'y'), edges: E(['r2', 'x'], ['r1', 'y']) });
  assert.ok(r.positions.y.y < r.positions.x.y);
});

test('cycle a->b->a marks exactly one back edge and terminates', () => {
  const r = layoutGraph({ nodes: N('a', 'b'), edges: E(['a', 'b'], ['b', 'a']) });
  const back = r.edges.filter((e) => e.back);
  assert.equal(back.length, 1);
  assert.equal(back[0].id, 'b->a:claims');
  assert.equal(r.positions.a.x, 0);
  assert.equal(r.positions.b.x, STEP_X);
  // the back edge leaves the right of b, drops below the layer, and returns to a
  assert.ok(back[0].points.length > 2);
  assert.ok(back[0].points[0].x > r.positions.b.x);
  const lowest = Math.max(...back[0].points.map((p) => p.y));
  assert.ok(lowest > r.positions.b.y + 96);
  assert.ok(r.height >= lowest);
  assert.ok(back[0].points.every((p) => p.x >= 0));
});

test('a self loop is a back edge and does not hang', () => {
  const r = layoutGraph({ nodes: N('a'), edges: E(['a', 'a']) });
  assert.equal(r.edges.length, 1);
  assert.equal(r.edges[0].back, true);
  assert.equal(r.positions.a.x, 0);
});

test('an isolated node is layer 0', () => {
  const r = layoutGraph({ nodes: N('a', 'b', 'lone'), edges: E(['a', 'b']) });
  assert.equal(r.positions.lone.x, 0);
  assert.notEqual(r.positions.lone.y, r.positions.a.y);
});

test('duplicate node ids keep the first', () => {
  const r = layoutGraph({ nodes: [{ id: 'a', label: 'first' }, { id: 'a', label: 'second' }, { id: 'b' }], edges: E(['a', 'b']) });
  assert.deepEqual(Object.keys(r.positions).sort(), ['a', 'b']);
  assert.equal(r.positions.b.x, STEP_X);
});

test('an edge with an unknown endpoint is dropped', () => {
  const r = layoutGraph({ nodes: N('a', 'b'), edges: E(['a', 'b'], ['a', 'ghost'], ['ghost', 'b']) });
  assert.deepEqual(r.edges.map((e) => e.id), ['a->b:claims']);
});

test('null, undefined and non-array input give the empty result', () => {
  const empty = { positions: {}, width: 0, height: 0, edges: [] };
  assert.deepEqual(layoutGraph(null), empty);
  assert.deepEqual(layoutGraph(undefined), empty);
  assert.deepEqual(layoutGraph({}), empty);
  assert.deepEqual(layoutGraph({ nodes: 'x', edges: 5 }), empty);
  assert.deepEqual(layoutGraph({ nodes: [], edges: [] }), empty);
  assert.deepEqual(layoutGraph({ nodes: N('a'), edges: null }).edges, []);
  assert.doesNotThrow(() => layoutGraph({ nodes: [null, 3, { id: 7 }], edges: [null, {}] }));
});

test('300 nodes in 30 layers completes with no NaN coordinate', () => {
  const nodes = [];
  const edges = [];
  for (let l = 0; l < 30; l++) {
    for (let i = 0; i < 10; i++) {
      const id = `n${String(l).padStart(2, '0')}_${i}`;
      nodes.push({ id });
      if (l > 0) edges.push({ id: `${id}<-p`, from: `n${String(l - 1).padStart(2, '0')}_${i}`, to: id });
    }
  }
  const r = layoutGraph({ nodes, edges });
  assert.equal(Object.keys(r.positions).length, 300);
  assert.equal(r.positions.n29_0.x, STEP_X * 29);
  const all = [];
  Object.values(r.positions).forEach((p) => all.push(p.x, p.y));
  r.edges.forEach((e) => e.points.forEach((p) => all.push(p.x, p.y)));
  all.push(r.width, r.height);
  assert.ok(all.every((n) => Number.isFinite(n)));
});

test('a very long chain does not overflow the stack', () => {
  const nodes = [];
  const edges = [];
  for (let i = 0; i < 5000; i++) {
    nodes.push({ id: `c${String(i).padStart(5, '0')}` });
    if (i) edges.push({ id: `e${i}`, from: `c${String(i - 1).padStart(5, '0')}`, to: `c${String(i).padStart(5, '0')}` });
  }
  const r = layoutGraph({ nodes, edges });
  assert.equal(Object.keys(r.positions).length, 5000);
});

test('every coordinate, width and height is a multiple of 4, even with odd options', () => {
  const g = { nodes: N('a', 'b', 'c'), edges: E(['a', 'b'], ['b', 'c'], ['c', 'a']) };
  [undefined, { nodeW: 241, nodeH: 97, gapX: 49, gapY: 25 }, { nodeW: 10, nodeH: 3, gapX: 1, gapY: 1 }].forEach((opts) => {
    const r = layoutGraph(g, opts);
    const all = [r.width, r.height];
    Object.values(r.positions).forEach((p) => all.push(p.x, p.y));
    r.edges.forEach((e) => e.points.forEach((p) => all.push(p.x, p.y)));
    assert.ok(all.every((n) => n % 4 === 0), JSON.stringify(opts));
  });
});

test('two calls with the same input are deepEqual and the input is not mutated', () => {
  const g = { nodes: N('b', 'a', 'c'), edges: E(['a', 'b'], ['b', 'c'], ['c', 'a']) };
  const before = JSON.stringify(g);
  assert.deepEqual(layoutGraph(g), layoutGraph(g));
  assert.equal(JSON.stringify(g), before);
});

test('opts override the defaults and bad opts fall back', () => {
  const g = { nodes: N('a', 'b'), edges: E(['a', 'b']) };
  const r = layoutGraph(g, { nodeW: 100, gapX: 20, nodeH: 40, gapY: 8 });
  assert.equal(r.positions.b.x, 120);
  assert.equal(r.width, 220);
  assert.equal(r.height, 40);
  const bad = layoutGraph(g, { nodeW: -5, gapX: 'wide', nodeH: NaN });
  assert.equal(bad.positions.b.x, STEP_X);
});

test('width and height cover the farthest node', () => {
  const r = layoutGraph({ nodes: N('a', 'b', 'c'), edges: E(['a', 'b'], ['a', 'c']) });
  assert.equal(r.width, STEP_X + 240);
  assert.equal(r.height, STEP_Y + 96);
});

test('duplicate ids take one row, not two', () => {
  const r = layoutGraph({ nodes: N('a', 'a', 'b'), edges: [] });
  assert.equal(r.positions.a.y, 0);
  assert.equal(r.positions.b.y, STEP_Y);
  assert.equal(r.height, STEP_Y + 96);
});

test('a node whose id getter throws gives the empty result instead of throwing', () => {
  const bad = { get id() { throw new Error('boom'); } };
  assert.deepEqual(layoutGraph({ nodes: [bad], edges: [] }), { positions: {}, width: 0, height: 0, edges: [] });
});

// ---- groups (HUB0329 piece W-D1): the members of one group are placed next to each other in their column ----
const G = (id, ...children) => ({ id, label: id, children, collapsed: false });
const P = (id, parent) => ({ id, parent });
const order = (r, ids) => ids.slice().sort((a, b) => r.positions[a].y - r.positions[b].y);

test('two members of a group that the plain order separates end up adjacent', () => {
  const plain = layoutGraph({ nodes: N('a', 'b', 'c'), edges: [] });
  assert.deepEqual(order(plain, ['a', 'b', 'c']), ['a', 'b', 'c']);
  const r = layoutGraph({ nodes: [P('a', 'group:g'), P('b', null), P('c', 'group:g')], edges: [], groups: [G('group:g', 'a', 'c')] });
  assert.deepEqual(order(r, ['a', 'b', 'c']), ['a', 'c', 'b']);
  assert.deepEqual([r.positions.a.y, r.positions.c.y, r.positions.b.y], [0, STEP_Y, STEP_Y * 2]);
});

test('two interleaved groups become two contiguous blocks', () => {
  const r = layoutGraph({
    nodes: [P('a', 'group:one'), P('b', 'group:two'), P('c', 'group:one'), P('d', 'group:two')], edges: [],
    groups: [G('group:one', 'a', 'c'), G('group:two', 'b', 'd')],
  });
  assert.deepEqual(order(r, ['a', 'b', 'c', 'd']), ['a', 'c', 'b', 'd']);
});

test('the block sits where the first member was and keeps the old order inside', () => {
  const r = layoutGraph({ nodes: [P('a', null), P('b', 'group:g'), P('c', null), P('d', 'group:g')], edges: [], groups: [G('group:g', 'd', 'b')] });
  assert.deepEqual(order(r, ['a', 'b', 'c', 'd']), ['a', 'b', 'd', 'c']);
});

test('the members of a nested group count as members of the outer group', () => {
  const r = layoutGraph({
    nodes: [P('a', 'group:inner'), P('b', null), P('c', 'group:inner'), P('d', 'group:outer')], edges: [],
    groups: [G('group:outer', 'group:inner', 'd'), G('group:inner', 'a', 'c')],
  });
  assert.deepEqual(order(r, ['a', 'b', 'c', 'd']), ['a', 'c', 'd', 'b']);
});

test('a cycle of group ids neither hangs nor throws', () => {
  const r = layoutGraph({
    nodes: [P('a', 'group:x'), P('b', null), P('c', 'group:y')], edges: [],
    groups: [G('group:x', 'group:y'), G('group:y', 'group:x')],
  });
  assert.equal(Object.keys(r.positions).length, 3);
});

test('a parent that is not a group is no group, and groups in other columns change nothing', () => {
  const unknown = layoutGraph({ nodes: [P('a', 'nope'), P('b', null), P('c', 'nope')], edges: [], groups: [] });
  assert.deepEqual(order(unknown, ['a', 'b', 'c']), ['a', 'b', 'c']);
  const base = layoutGraph({ nodes: N('a', 'b', 'c'), edges: E(['a', 'b']) });
  const grouped = layoutGraph({ nodes: [P('a', 'group:g'), P('b', 'group:g'), P('c', null)], edges: E(['a', 'b']), groups: [G('group:g', 'a', 'b')] });
  assert.deepEqual(grouped, base);
});

test('without groups, or without parents, the result is exactly the old one', () => {
  const nodes = N('a', 'z', 'm', 'b', 'q');
  const edges = E(['a', 'b'], ['a', 'm'], ['a', 'z'], ['q', 'z']);
  const old = layoutGraph({ nodes, edges });
  assert.deepEqual(layoutGraph({ nodes: nodes.map((n) => ({ ...n, parent: null })), edges, groups: [] }), old);
  assert.deepEqual(layoutGraph({ nodes: nodes.map((n) => ({ ...n, parent: 'group:g' })), edges, groups: [] }), old);
});

test('the grouped layout is deterministic', () => {
  const g = { nodes: [P('a', 'group:g'), P('b', null), P('c', 'group:g')], edges: [], groups: [G('group:g', 'a', 'c')] };
  assert.deepEqual(layoutGraph(g), layoutGraph(g));
});

test('three levels of nesting resolve to the outermost group', () => {
  const r = layoutGraph({
    nodes: [P('a', 'group:l3'), P('b', null), P('c', 'group:l3'), P('d', 'group:l1')], edges: [],
    groups: [G('group:l1', 'group:l2', 'd'), G('group:l2', 'group:l3'), G('group:l3', 'a', 'c')],
  });
  assert.deepEqual(order(r, ['a', 'b', 'c', 'd']), ['a', 'c', 'd', 'b']);
});

test('a group listed by two groups belongs to the first of them', () => {
  const r = layoutGraph({
    nodes: [P('a', 'group:in'), P('b', 'group:two'), P('c', 'group:in'), P('d', 'group:one'), P('e', 'group:two')], edges: [],
    groups: [G('group:one', 'group:in', 'd'), G('group:two', 'group:in', 'b', 'e'), G('group:in', 'a', 'c')],
  });
  assert.deepEqual(order(r, ['a', 'b', 'c', 'd', 'e']), ['a', 'c', 'd', 'b', 'e']);
});

test('malformed groups are ignored and never throw', () => {
  const nodes = [P('a', 'group:g'), P('b', null), P('c', 'group:g')];
  const old = layoutGraph({ nodes: N('a', 'b', 'c'), edges: [] });
  assert.deepEqual(layoutGraph({ nodes, edges: [], groups: [G('group:g', 'a', 'c'), null, { children: ['b'] }, { id: 'group:h', children: 'abc' }] }).positions.c, { x: 0, y: STEP_Y });
  assert.deepEqual(layoutGraph({ nodes, edges: [], groups: 'x' }), old);
  assert.deepEqual(layoutGraph({ nodes: [P('a', 'undefined'), P('b', null), P('c', 'undefined')], edges: [], groups: [{ children: ['a'] }] }), old);
});

test('ids that are names on Object.prototype are plain ids', () => {
  const r = layoutGraph({
    nodes: [P('a', 'constructor'), P('b', null), P('c', 'constructor')], edges: [],
    groups: [G('constructor', 'a', 'c')],
  });
  assert.deepEqual(order(r, ['a', 'b', 'c']), ['a', 'c', 'b']);
  const none = layoutGraph({ nodes: [P('a', 'toString'), P('b', null), P('c', 'toString')], edges: [], groups: [] });
  assert.deepEqual(order(none, ['a', 'b', 'c']), ['a', 'b', 'c']);
});

test('with duplicate node ids the first node decides the group', () => {
  const r = layoutGraph({
    nodes: [P('a', 'group:g'), P('b', null), P('c', 'group:g'), P('a', null)], edges: [], groups: [G('group:g', 'a', 'c')],
  });
  assert.deepEqual(order(r, ['a', 'b', 'c']), ['a', 'c', 'b']);
});

test('a group id that is a name on Object.prototype nests like any other', () => {
  const nested = layoutGraph({
    nodes: [P('a', 'constructor'), P('b', null), P('c', 'constructor'), P('d', 'group:o')], edges: [],
    groups: [G('group:o', 'constructor', 'd'), G('constructor', 'a', 'c')],
  });
  assert.deepEqual(order(nested, ['a', 'b', 'c', 'd']), ['a', 'c', 'd', 'b']);
});
