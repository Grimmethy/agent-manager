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

// ---- direction 'down' (HUB0346 piece 1): layers run top to bottom ----
const DOWN = { direction: 'down' };
const byX = (r, ids) => ids.slice().sort((a, b) => r.positions[a].x - r.positions[b].x);

test("direction 'down': a chain has strictly increasing y and one shared x", () => {
  const r = layoutGraph({ nodes: N('a', 'b', 'c'), edges: E(['a', 'b'], ['b', 'c']) }, DOWN);
  assert.deepEqual([r.positions.a.y, r.positions.b.y, r.positions.c.y], [0, STEP_Y, STEP_Y * 2]);
  assert.deepEqual([r.positions.a.x, r.positions.b.x, r.positions.c.x], [0, 0, 0]);
  assert.equal(r.width, 240);
  assert.equal(r.height, STEP_Y * 2 + 96);
});

test("direction 'down': a source sits above its loop, above its reviewer, above the apply service", () => {
  const r = layoutGraph({
    nodes: N('service:apply-loop', 'reviewer', 'source:adhoc', 'worker-3090'),
    edges: E(['source:adhoc', 'worker-3090'], ['worker-3090', 'reviewer'], ['reviewer', 'service:apply-loop']),
  }, DOWN);
  const y = (id) => r.positions[id].y;
  assert.ok(y('source:adhoc') < y('worker-3090'));
  assert.ok(y('worker-3090') < y('reviewer'));
  assert.ok(y('reviewer') < y('service:apply-loop'));
});

test("direction 'down': a fan-out puts the children in one layer, side by side by id", () => {
  const r = layoutGraph({ nodes: N('a', 'z', 'm', 'b'), edges: E(['a', 'b'], ['a', 'm'], ['a', 'z']) }, DOWN);
  assert.equal(r.positions.b.y, STEP_Y);
  assert.equal(r.positions.m.y, STEP_Y);
  assert.equal(r.positions.z.y, STEP_Y);
  assert.deepEqual([r.positions.b.x, r.positions.m.x, r.positions.z.x], [0, STEP_X, STEP_X * 2]);
});

test("direction 'down': an edge runs from the bottom middle of the source to the top middle of the target", () => {
  const r = layoutGraph({ nodes: N('a', 'b'), edges: E(['a', 'b']) }, DOWN);
  const pts = r.edges[0].points;
  assert.deepEqual(pts[0], { x: 120, y: 96 });
  assert.deepEqual(pts[pts.length - 1], { x: 120, y: STEP_Y });
});

test("direction 'down': a cycle marks exactly one back edge that leaves the right side and widens the result", () => {
  const r = layoutGraph({ nodes: N('a', 'b'), edges: E(['a', 'b'], ['b', 'a']) }, DOWN);
  const backs = r.edges.filter((e) => e.back);
  assert.equal(backs.length, 1);
  const pts = backs[0].points;
  const b = r.positions[backs[0].id.split('->')[0]];
  assert.deepEqual(pts[0], { x: b.x + 240, y: b.y + 48 });
  const lane = pts[1].x;
  assert.ok(lane > 240, 'the lane is right of the nodes');
  assert.ok(lane < r.width, 'the lane is inside the canvas');
  assert.equal(r.height, STEP_Y + 96, 'a cycle does not add height');
  r.edges.forEach((e) => e.points.forEach((p) => assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y))));
});

test("direction 'down': a self loop terminates and has no NaN", () => {
  const r = layoutGraph({ nodes: N('a'), edges: E(['a', 'a']) }, DOWN);
  assert.equal(r.edges.length, 1);
  assert.equal(r.edges[0].back, true);
  r.edges[0].points.forEach((p) => assert.ok(Number.isFinite(p.x) && p.x >= 0 && Number.isFinite(p.y) && p.y >= 0));
});

test("direction 'down': every coordinate, width and height is a multiple of 4, even with odd options", () => {
  const r = layoutGraph({ nodes: N('a', 'b', 'c', 'd'), edges: E(['a', 'b'], ['a', 'c'], ['c', 'd'], ['d', 'a']) }, { direction: 'down', nodeW: 101, nodeH: 57, gapX: 13, gapY: 9 });
  const all = [r.width, r.height];
  Object.values(r.positions).forEach((p) => all.push(p.x, p.y));
  r.edges.forEach((e) => e.points.forEach((p) => all.push(p.x, p.y)));
  all.forEach((n) => assert.equal(n % 4, 0, `${n} is a multiple of 4`));
});

test("direction 'down': two calls are deepEqual and the input is not mutated", () => {
  const g = { nodes: N('a', 'b', 'c'), edges: E(['a', 'b'], ['a', 'c'], ['c', 'a']) };
  const copy = JSON.parse(JSON.stringify(g));
  assert.deepEqual(layoutGraph(g, DOWN), layoutGraph(g, DOWN));
  assert.deepEqual(g, copy);
});

test("direction 'down': is not the left-to-right layout", () => {
  const g = { nodes: N('a', 'b', 'c'), edges: E(['a', 'b'], ['b', 'c']) };
  assert.notDeepEqual(layoutGraph(g, DOWN).positions, layoutGraph(g).positions);
});

test('any direction other than the exact string down is the left-to-right layout', () => {
  const g = { nodes: N('a', 'z', 'm', 'b'), edges: E(['a', 'b'], ['a', 'm'], ['a', 'z'], ['z', 'a']) };
  const old = layoutGraph(g);
  [undefined, null, 'right', 'sideways', 'DOWN', ' down', 5, true, {}].forEach((direction) => {
    assert.deepEqual(layoutGraph(g, { direction }), old, `direction ${String(direction)}`);
  });
  assert.deepEqual(layoutGraph(g, { direction: 'right', gapX: 100 }), layoutGraph(g, { gapX: 100 }));
});

test("direction 'down': the members of a group stay adjacent in their layer", () => {
  const plain = layoutGraph({ nodes: N('a', 'b', 'c'), edges: [] }, DOWN);
  assert.deepEqual(byX(plain, ['a', 'b', 'c']), ['a', 'b', 'c']);
  const r = layoutGraph({ nodes: [P('a', 'group:g'), P('b', null), P('c', 'group:g')], edges: [], groups: [G('group:g', 'a', 'c')] }, DOWN);
  assert.deepEqual(byX(r, ['a', 'b', 'c']), ['a', 'c', 'b']);
  assert.deepEqual([r.positions.a.x, r.positions.c.x, r.positions.b.x], [0, STEP_X, STEP_X * 2]);
});

test("direction 'down': empty and garbage input give the empty result", () => {
  [null, undefined, {}, { nodes: [] }, 'x'].forEach((g) => assert.deepEqual(layoutGraph(g, DOWN), { positions: {}, width: 0, height: 0, edges: [] }));
});

// ---- maxPerRow (HUB0346 piece 3): a layer with many nodes wraps into rows in the top-to-bottom layout ----
const wide = (n) => ({ nodes: N('lane', ...Array.from({ length: n }, (_, i) => `s${String(i).padStart(2, '0')}`)), edges: E(...Array.from({ length: n }, (_, i) => [`s${String(i).padStart(2, '0')}`, 'lane'])) });

test("direction 'down' with maxPerRow wraps a wide layer into rows of at most that many nodes", () => {
  const r = layoutGraph(wide(7), { direction: 'down', maxPerRow: 3 });
  const ys = [...new Set(Object.keys(r.positions).filter((id) => id !== 'lane').map((id) => r.positions[id].y))].sort((a, b) => a - b);
  assert.deepEqual(ys, [0, STEP_Y, STEP_Y * 2], '7 sources in rows of 3, 3 and 1');
  assert.equal(Object.values(r.positions).filter((p) => p.y === 0).length, 3);
  assert.equal(r.width, 240 + 2 * STEP_X, 'the canvas is three columns wide, not seven');
  assert.equal(r.positions.lane.y, STEP_Y * 3, 'the lane stays below every wrapped row');
});

test('wrapped rows keep the id order left to right and then top to bottom', () => {
  const r = layoutGraph(wide(5), { direction: 'down', maxPerRow: 2 });
  assert.deepEqual(['s00', 's01', 's02', 's03', 's04'].map((id) => [r.positions[id].x / STEP_X, r.positions[id].y / STEP_Y]), [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2]]);
});

test('maxPerRow of 1 makes a single column and a layer that already fits is untouched', () => {
  const one = layoutGraph(wide(4), { direction: 'down', maxPerRow: 1 });
  assert.equal(one.width, 240);
  assert.equal(one.height, STEP_Y * 4 + 96);
  const g = { nodes: N('a', 'b'), edges: E(['a', 'b']) };
  assert.deepEqual(layoutGraph(g, { direction: 'down', maxPerRow: 5 }), layoutGraph(g, DOWN));
});

test('maxPerRow is ignored for the left-to-right layout and for anything but a whole number of 1 or more', () => {
  const g = wide(6);
  assert.deepEqual(layoutGraph(g, { maxPerRow: 2 }), layoutGraph(g));
  [0, -1, 1.5, NaN, Infinity, '2', null, undefined, {}, true].forEach((maxPerRow) => {
    assert.deepEqual(layoutGraph(g, { direction: 'down', maxPerRow }), layoutGraph(g, DOWN), String(maxPerRow));
  });
});

test("a wrapped layer starts a new row where the group changes, so a row never mixes two groups", () => {
  const ids = ['a1', 'a2', 'a3', 'b1', 'b2', 'b3', 'c1'];
  const nodes = ids.map((id) => ({ id, parent: id[0] === 'c' ? null : 'group:' + id[0] }));
  const groups = [{ id: 'group:a', label: 'A', children: ['a1', 'a2', 'a3'], collapsed: false }, { id: 'group:b', label: 'B', children: ['b1', 'b2', 'b3'], collapsed: false }];
  const r = layoutGraph({ nodes, edges: [], groups }, { direction: 'down', maxPerRow: 2 });
  const rowsOf = {};
  ids.forEach((id) => { (rowsOf[r.positions[id].y] = rowsOf[r.positions[id].y] || []).push(id); });
  const rows = Object.keys(rowsOf).map(Number).sort((x, y) => x - y).map((y) => rowsOf[y].sort());
  assert.deepEqual(rows, [['a1', 'a2'], ['a3'], ['b1', 'b2'], ['b3'], ['c1']], 'rows of A, A, B, B, then the ungrouped one');
  assert.equal(new Set(Object.values(r.positions).map((p) => p.y)).size, 5);
});

test("without groups a wrapped layer fills rows exactly as before, and a group that fits stays on one row", () => {
  const ids = ['x1', 'x2', 'x3', 'x4', 'x5'];
  const plain = layoutGraph({ nodes: ids.map((id) => ({ id })), edges: [] }, { direction: 'down', maxPerRow: 2 });
  assert.deepEqual([...new Set(ids.map((id) => plain.positions[id].y))].sort((a, b) => a - b), [0, STEP_Y, STEP_Y * 2]);
  const nodes = ids.map((id) => ({ id, parent: 'group:g' }));
  const one = layoutGraph({ nodes, edges: [], groups: [{ id: 'group:g', label: 'G', children: ids, collapsed: false }] }, { direction: 'down', maxPerRow: 5 });
  assert.equal(new Set(ids.map((id) => one.positions[id].y)).size, 1, 'one group, five per row, one row');
});

test("wrapped rows stay multiples of 4, never overlap, and a cycle still terminates", () => {
  const g = wide(9);
  g.edges.push(E(['lane', 's00'])[0]);
  const r = layoutGraph(g, { direction: 'down', maxPerRow: 4, nodeW: 101, nodeH: 57, gapX: 13, gapY: 9 });
  const seen = new Set();
  Object.values(r.positions).forEach((p) => { assert.equal(p.x % 4, 0); assert.equal(p.y % 4, 0); seen.add(p.x + ',' + p.y); });
  assert.equal(seen.size, Object.keys(r.positions).length, 'no two nodes share a slot');
  assert.equal(r.edges.filter((e) => e.back).length, 1);
  r.edges.forEach((e) => e.points.forEach((p) => assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y))));
});

// ---- per-node sizes (loops by type, piece 4) ----

test('without nodeSizes (or with only bad ones) the positions and edges are exactly the default layout, and sizes are the default box', () => {
  const g = { nodes: N('a', 'b', 'c', 'd'), edges: E(['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']) };
  for (const dir of ['down', 'right']) {
    const base = layoutGraph(g, { direction: dir });
    for (const bad of [undefined, null, {}, 'x', { a: { w: 0, h: 10 } }, { a: { w: NaN, h: 10 } }, { a: { w: 10 } }, { zzz: { w: 99, h: 99 } }]) {
      const r = layoutGraph(g, { direction: dir, nodeSizes: bad });
      assert.deepEqual({ ...r, sizes: undefined }, { ...base, sizes: undefined }, dir + ' ' + JSON.stringify(bad));
    }
    assert.deepEqual(base.sizes.a, { w: 240, h: 96 });
  }
});

test('down: a bigger node pushes the next layer down by its own height, and sizes are returned rounded up to a multiple of 4', () => {
  const g = { nodes: N('a', 'b', 'c'), edges: E(['a', 'b'], ['b', 'c']) };
  const r = layoutGraph(g, { direction: 'down', nodeSizes: { a: { w: 300, h: 150 }, b: { w: 201, h: 71 } } });
  assert.equal(r.positions.a.y, 0);
  assert.equal(r.positions.b.y, 176, '150 + 24 = 174, rounded up to a multiple of 4');
  assert.equal(r.positions.c.y, 272, '176 + 72 + 24, b being 71 rounded up to 72');
  assert.deepEqual(r.sizes.b, { w: 204, h: 72 });
  assert.deepEqual(r.sizes.c, { w: 240, h: 96 });
  assert.equal(r.height, r.positions.c.y + 96);
});

test('down: nodes of one layer do not overlap with mixed sizes, and the layer is as tall as its tallest node', () => {
  const g = { nodes: N('a', 'b', 'c', 'd'), edges: E(['a', 'b'], ['a', 'c'], ['b', 'd']) };
  const r = layoutGraph(g, { direction: 'down', nodeSizes: { b: { w: 360, h: 200 }, c: { w: 120, h: 80 } } });
  const b = r.positions.b;
  const c = r.positions.c;
  assert.equal(b.y, c.y, 'one layer, one top');
  const [first, second] = b.x < c.x ? [['b', 360], ['c', 120]] : [['c', 120], ['b', 360]];
  assert.ok(r.positions[second[0]].x >= r.positions[first[0]].x + first[1] + 48, 'the second node starts after the first node own width plus the gap');
  assert.equal(r.positions.d.y, b.y + 200 + 24, 'the next layer starts under the tallest node');
});

test('right: a wider node pushes the next column right by its own width', () => {
  const g = { nodes: N('a', 'b'), edges: E(['a', 'b']) };
  const r = layoutGraph(g, { direction: 'right', nodeSizes: { a: { w: 400, h: 60 } } });
  assert.equal(r.positions.b.x, 400 + 48);
  assert.equal(r.width, r.positions.b.x + 240);
});

test('edge points touch the real box edges of differently sized nodes', () => {
  const g = { nodes: N('a', 'b'), edges: E(['a', 'b']) };
  const down = layoutGraph(g, { direction: 'down', nodeSizes: { a: { w: 360, h: 120 }, b: { w: 120, h: 80 } } });
  const pts = down.edges[0].points;
  assert.deepEqual(pts[0], { x: 180, y: 120 }, 'bottom middle of the 360 x 120 source');
  assert.deepEqual(pts[pts.length - 1], { x: down.positions.b.x + 60, y: down.positions.b.y }, 'top middle of the 120 wide target');
  const right = layoutGraph(g, { direction: 'right', nodeSizes: { a: { w: 360, h: 120 }, b: { w: 120, h: 80 } } });
  const rp = right.edges[0].points;
  assert.deepEqual(rp[0], { x: 360, y: 60 }, 'right middle of the source');
  assert.deepEqual(rp[rp.length - 1], { x: right.positions.b.x, y: right.positions.b.y + 40 }, 'left middle of the target');
});

test('sizes work with wrapped rows and groups, and a cycle still widens the result', () => {
  const nodes = [...N('a', 'b', 'c', 'd', 'e', 'f')].map((n) => ({ ...n, parent: null }));
  const g = { nodes, edges: E(['a', 'b'], ['a', 'c'], ['a', 'd'], ['a', 'e'], ['a', 'f']) };
  const r = layoutGraph(g, { direction: 'down', maxPerRow: 2, nodeSizes: { b: { w: 300, h: 140 } } });
  const ys = new Set(Object.values(r.positions).map((p) => p.y));
  assert.ok(ys.size >= 4, 'a, then three wrapped rows');
  const cyc = layoutGraph({ nodes: N('a', 'b'), edges: E(['a', 'b'], ['b', 'a']) }, { direction: 'down', nodeSizes: { a: { w: 400, h: 100 } } });
  assert.ok(cyc.edges.some((e) => e.back));
  assert.ok(cyc.width >= 400 + 4, 'the back-edge lane is outside the biggest node');
});

test('right: nodes of one column follow each other by their own heights', () => {
  const g = { nodes: N('a', 'b', 'c'), edges: E(['a', 'b'], ['a', 'c']) };
  const r = layoutGraph(g, { direction: 'right', nodeSizes: { b: { w: 240, h: 200 }, c: { w: 240, h: 60 } } });
  const [first, second] = r.positions.b.y < r.positions.c.y ? [['b', 200], ['c', 60]] : [['c', 60], ['b', 200]];
  assert.equal(r.positions[second[0]].y, r.positions[first[0]].y + first[1] + 24);
});
