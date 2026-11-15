// Node tests for the pure loop helpers of the Workers workflow graph (HUB0346 piece 2): splitIntoLoops and fitScale.
// Run: node --test python/dashboard/tests/test_workflow_loops.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { splitIntoLoops, fitScale, WF_MIN_SCALE } = require(path.join(__dirname, '..', 'static', 'js', 'workflow-loops.js'));

const node = (id, kind, extra) => ({ id, kind, label: id, parent: null, ...extra });
const edge = (from, to, kind) => ({ id: `${from}->${to}:${kind}`, from, to, kind, label: null });
const ids = (card) => card.graph.nodes.map((n) => n.id).sort();

const GRAPH = () => ({
  nodes: [
    node('source:a', 'source'), node('source:b', 'source'), node('source:c', 'source'), node('source:orphan', 'source'),
    node('worker-1', 'loop'), node('worker-2', 'loop'), node('reviewer', 'loop'),
    node('service:apply-loop', 'service'), node('service:watchdog', 'service'), node('stage:plan', 'stage'),
  ],
  edges: [
    edge('source:a', 'worker-1', 'claims'), edge('source:b', 'worker-1', 'claims'), edge('source:b', 'worker-2', 'claims'), edge('source:c', 'worker-2', 'claims'),
    edge('worker-1', 'reviewer', 'reviews'), edge('worker-2', 'reviewer', 'reviews'), edge('reviewer', 'service:apply-loop', 'applies'),
    edge('service:watchdog', 'stage:plan', 'triggers'),
  ],
  groups: [], warnings: ['w'],
});

test('one card per lane in id order, then a services card', () => {
  const cards = splitIntoLoops(GRAPH());
  assert.deepEqual(cards.map((c) => c.id), ['worker-1', 'worker-2', 'services']);
  assert.deepEqual(cards.map((c) => c.label), ['worker-1', 'worker-2', 'Services']);
});

test('a lane card holds the sources that claim for it, the lane, its reviewer and the apply service', () => {
  const [one, two] = splitIntoLoops(GRAPH());
  assert.deepEqual(ids(one), ['reviewer', 'service:apply-loop', 'source:a', 'source:b', 'worker-1']);
  assert.deepEqual(ids(two), ['reviewer', 'service:apply-loop', 'source:b', 'source:c', 'worker-2']);
});

test('a node can sit on several cards, and a card keeps only the edges between its own nodes', () => {
  const [one, two] = splitIntoLoops(GRAPH());
  assert.ok(one.graph.nodes.some((n) => n.id === 'source:b') && two.graph.nodes.some((n) => n.id === 'source:b'));
  assert.deepEqual(one.graph.edges.map((e) => e.id).sort(), [
    'reviewer->service:apply-loop:applies', 'source:a->worker-1:claims', 'source:b->worker-1:claims', 'worker-1->reviewer:reviews',
  ]);
  assert.ok(!one.graph.edges.some((e) => e.to === 'worker-2'));
});

test('everything on no lane card lands on the services card, and the card is left out when there is nothing', () => {
  const cards = splitIntoLoops(GRAPH());
  assert.deepEqual(ids(cards[2]), ['service:watchdog', 'source:orphan', 'stage:plan']);
  assert.deepEqual(cards[2].graph.edges.map((e) => e.id), ['service:watchdog->stage:plan:triggers']);
  const g = GRAPH();
  g.nodes = g.nodes.filter((n) => !['source:orphan', 'service:watchdog', 'stage:plan'].includes(n.id));
  g.edges = g.edges.filter((e) => e.kind !== 'triggers');
  assert.deepEqual(splitIntoLoops(g).map((c) => c.id), ['worker-1', 'worker-2']);
});

test('a reviewer reached by a reviews edge is not a lane and brings its own apply edge', () => {
  const g = {
    nodes: [node('worker-9', 'loop'), node('reviewer-9', 'loop'), node('service:apply-loop', 'service')],
    edges: [edge('worker-9', 'reviewer-9', 'reviews'), edge('reviewer-9', 'service:apply-loop', 'applies')],
  };
  const cards = splitIntoLoops(g);
  assert.deepEqual(cards.map((c) => c.id), ['worker-9']);
  assert.deepEqual(ids(cards[0]), ['reviewer-9', 'service:apply-loop', 'worker-9']);
});

test('a lane without a reviews edge falls back to the node called reviewer when there is one', () => {
  const g = {
    nodes: [node('worker-1', 'loop'), node('reviewer', 'loop'), node('service:apply-loop', 'service')],
    edges: [edge('reviewer', 'service:apply-loop', 'applies')],
  };
  assert.deepEqual(ids(splitIntoLoops(g)[0]), ['reviewer', 'service:apply-loop', 'worker-1']);
  const none = { nodes: [node('worker-1', 'loop')], edges: [] };
  assert.deepEqual(ids(splitIntoLoops(none)[0]), ['worker-1']);
});

test('only loop nodes are lanes: a service or a collapsed group named like a worker is not', () => {
  const g = { nodes: [node('worker-x', 'service'), node('group:g', 'group'), node('worker-1', 'loop')], edges: [] };
  const cards = splitIntoLoops(g);
  assert.deepEqual(cards.map((c) => c.id), ['worker-1', 'services']);
  assert.deepEqual(ids(cards[1]), ['group:g', 'worker-x']);
});

test('a graph with no lane at all is one services card', () => {
  const g = { nodes: [node('source:a', 'source'), node('stage:plan', 'stage')], edges: [edge('source:a', 'stage:plan', 'produces')] };
  const cards = splitIntoLoops(g);
  assert.deepEqual(cards.map((c) => c.id), ['services']);
  assert.equal(cards[0].graph.edges.length, 1);
});

test('groups follow their members: a card keeps the groups that have a member on it', () => {
  const g = GRAPH();
  g.groups = [{ id: 'group:one', label: 'One', children: ['source:a'], collapsed: false }, { id: 'group:two', label: 'Two', children: ['source:c'], collapsed: false }];
  const [one, two] = splitIntoLoops(g);
  assert.deepEqual(one.graph.groups.map((x) => x.id), ['group:one']);
  assert.deepEqual(two.graph.groups.map((x) => x.id), ['group:two']);
});

test('empty and garbage input give an empty list and never throw', () => {
  [null, undefined, 5, 'x', {}, { nodes: 'x' }, { nodes: [] }].forEach((g) => assert.deepEqual(splitIntoLoops(g), []));
  assert.doesNotThrow(() => splitIntoLoops({ nodes: [null, 3, { id: 7 }, { id: 'worker-1', kind: 'loop' }], edges: [null, { from: 1 }, 'x'] }));
  assert.deepEqual(splitIntoLoops({ nodes: [null, 3, { id: 7 }, { id: 'worker-1', kind: 'loop' }], edges: [null] }).map((c) => c.id), ['worker-1']);
});

test('the input is not mutated and two calls give the same answer', () => {
  const g = GRAPH();
  const copy = JSON.parse(JSON.stringify(g));
  assert.deepEqual(splitIntoLoops(g), splitIntoLoops(g));
  assert.deepEqual(g, copy);
});

test('fitScale shrinks to fit, never above 1', () => {
  assert.equal(fitScale(1000, 2000, 500, 1000), 0.5);
  assert.equal(fitScale(100, 100, 500, 500), 1);
  assert.equal(fitScale(800, 400, 400, 1000), 0.5);
  assert.equal(fitScale(1000, 500, 800, 350, 0.1), 0.7);
});

test('fitScale never goes below the minimum, so a big loop scrolls instead of shrinking to nothing', () => {
  assert.equal(WF_MIN_SCALE, 0.5);
  assert.equal(fitScale(4000, 4000, 400, 400), 0.5);
  assert.equal(fitScale(4000, 4000, 400, 400, 0.25), 0.25);
  assert.equal(fitScale(4000, 4000, 400, 400, 5), 1, 'a minimum above 1 still caps at 1');
});

test('fitScale gives 1 for a bad size and the default minimum for a bad minimum', () => {
  [[NaN, 100, 100, 100], [0, 100, 100, 100], [100, -5, 100, 100], [100, 100, undefined, 100], [100, 100, 100, Infinity]].forEach((a) => assert.equal(fitScale(...a), 1));
  assert.equal(fitScale(4000, 4000, 400, 400, NaN), 0.5);
  assert.equal(fitScale(4000, 4000, 400, 400, -1), 0.5);
});

// ---- fitScaleForCard (graph readability pass 2): width-only scale when the card scrolls vertically anyway ----
const { fitScaleForCard } = require(path.join(__dirname, '..', 'static', 'js', 'workflow-loops.js'));

test('fitScaleForCard fits the whole loop while that stays above the minimum', () => {
  assert.equal(fitScaleForCard(272, 560, 330, 470), fitScale(272, 560, 330, 470));
  assert.equal(fitScaleForCard(272, 560, 330, 470).toFixed(3), '0.839');
  assert.equal(fitScaleForCard(100, 100, 500, 500), 1);
});

test('a loop too tall for the minimum scales by width only, so a tall column stays readable', () => {
  assert.equal(fitScale(272, 4160, 330, 600), 0.5, 'the old rule shrank it to the floor');
  assert.equal(fitScaleForCard(272, 4160, 330, 600), 1);
  assert.equal(fitScaleForCard(272, 4160, 200, 600).toFixed(3), '0.735');
  assert.equal(fitScaleForCard(800, 4000, 400, 600), 0.5, 'width needs the floor too');
  assert.equal(fitScaleForCard(2000, 4000, 400, 600), 0.5, 'never below the minimum');
});

test('fitScaleForCard honours a custom minimum and gives 1 for bad sizes', () => {
  assert.equal(fitScaleForCard(272, 4160, 100, 600, 0.25).toFixed(4), '0.3676');
  assert.equal(fitScaleForCard(272, 4160, 330, 600, 0.9), 1);
  [[NaN, 100, 100, 100], [100, 0, 100, 100], [100, 100, -1, 100], [100, 100, 100, undefined]].forEach((a) => assert.equal(fitScaleForCard(...a), 1));
  assert.equal(fitScaleForCard(4000, 4000, 400, 400, NaN), 0.5);
});

// ---- cardWidthFor (card width pass): a loop card is as wide as its drawing needs on a wide screen ----
const { cardWidthFor, WF_CARD_MIN_W } = require(path.join(__dirname, '..', 'static', 'js', 'workflow-loops.js'));

test('a card is the drawing width plus its extras, between the minimum and the row', () => {
  assert.equal(WF_CARD_MIN_W, 300);
  assert.equal(cardWidthFor(272, 1080, 40), 312, 'a 272 px column in a 1080 px row is 312 px, not 1080');
  assert.equal(cardWidthFor(608, 1080, 40), 648);
  assert.equal(cardWidthFor(100, 1080, 40), 300, 'a tiny drawing still gets the minimum');
  assert.equal(cardWidthFor(2000, 1080, 40), 1080, 'never wider than the row');
  assert.equal(cardWidthFor(1040, 1080, 40), 1080, 'exactly the row');
});

test('a fractional drawing width is rounded up and a fractional row is rounded down', () => {
  assert.equal(cardWidthFor(271.2, 1080, 40), 312);
  assert.equal(cardWidthFor(2000, 1080.7, 40), 1080);
});

test('a row narrower than the minimum wins, so a card never overflows its row', () => {
  assert.equal(cardWidthFor(272, 250, 40), 250);
  assert.equal(cardWidthFor(100, 299, 40), 299);
});

test('a missing row means no upper limit; a custom minimum is honoured', () => {
  [undefined, null, 0, -5, NaN, Infinity, '1080'].forEach((row) => assert.equal(cardWidthFor(2000, row, 40), 2040, String(row)));
  assert.equal(cardWidthFor(100, 1080, 40, 150), 150);
  assert.equal(cardWidthFor(100, 1080, 40, 0), 300, 'a bad minimum falls back to the default');
  assert.equal(cardWidthFor(100, 1080, 40, NaN), 300);
});

test('a bad drawing width or extra counts as zero, and the answer is never NaN', () => {
  [NaN, undefined, null, -10, Infinity, 'x'].forEach((cw) => assert.equal(cardWidthFor(cw, 1080, 40), 300, String(cw)));
  [NaN, undefined, null, -10, '40'].forEach((ex) => assert.equal(cardWidthFor(272, 1080, ex), 300, String(ex)));
  assert.equal(cardWidthFor(272, 1080), 300, 'no extra at all: 272 is below the minimum');
  assert.equal(cardWidthFor(400, 1080), 400);
  [[], [1], [NaN, NaN, NaN, NaN], [1e9, 1e9, 1e9, 1e9]].forEach((a) => assert.ok(Number.isFinite(cardWidthFor(...a))));
});

// ---- loops by type (piece 5) ----
const { splitByLoopTypes } = require(path.join(__dirname, '..', 'static', 'js', 'workflow-loops.js'));
const step = (id, lanes) => node(id, 'step', { models: (lanes || []).map((l) => ({ name: 'm', provider: 'local', lane: l })) });
const TYPED = () => ({
  nodes: [node('stage:orient', 'stage', { models: [{ name: 'm', provider: 'local', lane: 'worker-1' }] }), node('stage:apply', 'stage', { models: [] }), node('service:apply-loop', 'service'),
    node('step:stalled:gather', 'step', { models: [] }), node('step:stalled:judge', 'step', { models: [{ name: 'claude-sonnet-5-5', provider: 'cloud', lane: null }] }), node('service:watchdog-script:p:stalled-trigger', 'service'),
    node('worker-1', 'loop'), node('worker-2', 'loop'), node('source:a', 'source')],
  edges: [edge('stage:orient', 'stage:apply', 'produces'), edge('step:stalled:gather', 'step:stalled:judge', 'produces'), edge('worker-1', 'stage:orient', 'claims')],
  groups: [], warnings: ['w'],
  loops: [
    { id: 'loop:pipeline', name: 'Task pipeline', kind: 'pipeline', steps: ['stage:orient', 'stage:apply'], services: ['service:apply-loop'] },
    { id: 'loop:stalled', name: 'Stalled-task worker', kind: 'worker', steps: ['step:stalled:gather', 'step:stalled:judge'], services: ['service:watchdog-script:p:stalled-trigger'] },
  ],
});

test('graph.loops: one card per loop, titled by the loop name, never by a lane', () => {
  const cards = splitIntoLoops(TYPED());
  assert.deepEqual(cards.map((c) => c.id), ['loop:pipeline', 'loop:stalled']);
  assert.deepEqual(cards.map((c) => c.label), ['Task pipeline', 'Stalled-task worker']);
  assert.ok(cards.every((c) => c.byType === true));
  assert.ok(!cards.some((c) => /worker-|reviewer|services/.test(c.id + c.label.replace('Stalled-task worker', ''))));
});

test('a typed card holds the steps and the services, not the lanes behind the models, which ride along as card.lanes', () => {
  const [pipe, stalled] = splitIntoLoops(TYPED());
  assert.deepEqual(ids(pipe), ['service:apply-loop', 'stage:apply', 'stage:orient']);
  assert.deepEqual(Object.keys(pipe.lanes), ['worker-1']);
  assert.equal(pipe.lanes['worker-1'].id, 'worker-1');
  assert.deepEqual(Object.keys(stalled.lanes), [], 'a cloud step with no lane has none');
  assert.ok(!ids(pipe).includes('worker-1'));
});

test('services are joined by an edge made here: below the last step of the pipeline, above the first step of a worker loop', () => {
  const [pipe, stalled] = splitIntoLoops(TYPED());
  assert.ok(pipe.graph.edges.some((e) => e.from === 'stage:apply' && e.to === 'service:apply-loop' && e.kind === 'produces'));
  assert.ok(stalled.graph.edges.some((e) => e.from === 'service:watchdog-script:p:stalled-trigger' && e.to === 'step:stalled:gather' && e.kind === 'triggers'));
  assert.ok(stalled.graph.edges.some((e) => e.from === 'step:stalled:gather' && e.to === 'step:stalled:judge'), 'the step chain edge is kept');
  assert.equal(new Set(pipe.graph.edges.map((e) => e.id)).size, pipe.graph.edges.length);
});

test('without graph.loops (or with an empty list, or loops with no step in the graph) the cards are the old lane cards', () => {
  const old = splitIntoLoops(GRAPH()).map((c) => c.id);
  for (const loops of [undefined, [], [{ id: 'loop:x', name: 'X', steps: ['nope'] }], [null, 5]]) {
    const g = { ...GRAPH(), loops };
    assert.deepEqual(splitIntoLoops(g).map((c) => c.id), old);
  }
});

test('invalid loop entries are skipped and nothing throws; the input is not mutated', () => {
  const g = TYPED();
  g.loops.unshift(null, { id: 5 }, { id: 'loop:bad', name: 'B', steps: 'x' });
  const before = JSON.stringify(g);
  assert.deepEqual(splitIntoLoops(g).map((c) => c.id), ['loop:pipeline', 'loop:stalled']);
  assert.equal(JSON.stringify(g), before);
  assert.deepEqual(splitByLoopTypes([], new Map(), [], []), []);
});
