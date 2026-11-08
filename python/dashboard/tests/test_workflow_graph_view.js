// Node tests for the Workers Graph view builders (HUB0323 piece W-A4b).
// The real scripts are loaded into one bare vm context in the order index.html loads them, like the browser does.
// Run: node --test python/dashboard/tests/test_workflow_graph_view.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS = path.join(__dirname, '..', 'static', 'js');
const ctx = vm.createContext({ console });
ctx.window = ctx; // in a browser window is the global object, which is how workflow-layout.js publishes layoutGraph
for (const f of ['worker-status-helpers.js', 'worker-switch-ui.js', 'workflow-layout.js', 'workflow-loops.js', 'workflow-drag.js', 'workflow-groups.js', 'workflow-card-fit.js', 'workflow-step-card.js', 'workflow-graph-view.js']) {
  vm.runInContext(fs.readFileSync(path.join(JS, f), 'utf8'), ctx, { filename: f });
}
const v = ctx;

const rt = (over) => ({ instanceId: 'worker-3090', status: 'working', stale: false, disabled: false, switchable: true, pid: 4242, currentTaskId: 'task-1', currentPass: 'plan', stateAgeSeconds: 125, hub: null, projectLabel: 'agent-manager', borrowed: false, ...over });
const model = (over) => ({ name: 'ornith:35b', provider: 'local', tierB: null, overridden: false, choices: { local: ['a', 'b'], cloud: ['c'] }, ...over });
const loop = (over) => ({ id: 'worker-3090', kind: 'loop', label: 'worker-3090', parent: null, runtime: rt(), model: model(), work: { taskClasses: ['x'], preempt: 'never', reviewer: false }, counts: null, ...over });
const source = { id: 'source:hygiene', kind: 'source', label: 'hygiene', parent: null, runtime: null, model: null, work: null, counts: { pending: 3, drafting: 1 } };
const stage = { id: 'stage:review', kind: 'stage', label: 'review', parent: null, runtime: null, model: null, work: null, counts: { pending: 0, drafting: 2 } };

test('a working loop shows label, ok badge, state timer, model with local badge and its task', () => {
  const html = v.buildNodeHtml(loop(), false);
  assert.match(html, /^<div class="worker-card clickable wf-node" data-node-id="worker-3090"/);
  assert.match(html, /<span class="id">worker-3090<\/span>/);
  assert.match(html, /<span class="badge ok">working<\/span>/);
  assert.match(html, /in this state 2m/);
  assert.match(html, /ornith:35b/);
  assert.match(html, /wf-provider-local">local</);
  assert.match(html, /task-1 · plan/);
});

test('idle, offline and disabled loops use the shared status badge rules', () => {
  assert.match(v.buildNodeHtml(loop({ runtime: rt({ status: 'idle', currentTaskId: null }) }), false), /<span class="badge idle">idle<\/span>/);
  assert.match(v.buildNodeHtml(loop({ runtime: rt({ status: 'offline', stateAgeSeconds: null }) }), false), /<span class="badge idle">offline<\/span>/);
  assert.doesNotMatch(v.buildNodeHtml(loop({ runtime: rt({ status: 'offline', stateAgeSeconds: null }) }), false), /in this state/);
  const off = v.buildNodeHtml(loop({ runtime: rt({ status: 'disabled', disabled: true }) }), false);
  assert.match(off, /class="worker-card clickable wf-node worker-off"/);
  assert.match(off, /<span class="badge warn">disabled<\/span>/);
  assert.match(off, /Turn on/);
  assert.match(v.buildNodeHtml(loop({ runtime: rt({ stale: true }) }), false), /<span class="badge bad">STALE<\/span>/);
});

test('cloud and script loops carry their provider badge; an unknown provider reads local', () => {
  assert.match(v.buildNodeHtml(loop({ model: model({ provider: 'cloud' }) }), false), /wf-provider-cloud">cloud</);
  assert.match(v.buildNodeHtml(loop({ model: model({ provider: 'script' }) }), false), /wf-provider-script">script</);
  assert.match(v.buildNodeHtml(loop({ model: model({ provider: 'x"><b>' }) }), false), /wf-provider-local">local</);
});

test('source and stage nodes show their counts and no status badge', () => {
  const s = v.buildNodeHtml(source, false);
  assert.match(s, /pending 3 · drafting 1/);
  assert.match(s, /wf-kind">source</);
  assert.doesNotMatch(s, /class="badge /);
  const g = v.buildNodeHtml(stage, false);
  assert.match(g, /pending 0 · drafting 2/);
  assert.match(g, /wf-kind">stage</);
});

test('every user-controlled field is escaped', () => {
  const evil = '<script>alert("x")</script>\'';
  const html = v.buildNodeHtml(loop({ id: 'a"b', label: evil, model: model({ name: evil }), runtime: rt({ currentTaskId: evil, currentPass: evil }) }), false);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;&#39;/);
  assert.match(html, /data-node-id="a&quot;b"/);
  const detail = v.buildDetailHtml(loop({ label: evil, runtime: rt({ projectLabel: evil }) }), [evil]);
  assert.doesNotMatch(detail, /<script>/);
  const sourceHtml = v.buildNodeHtml({ ...source, label: evil, counts: { pending: evil, drafting: 0 } }, false);
  assert.doesNotMatch(sourceHtml, /<script>/);
});

test('the switch button appears only when runtime.switchable is true', () => {
  assert.match(v.buildNodeHtml(loop(), false), /worker-switch-btn/);
  assert.doesNotMatch(v.buildNodeHtml(loop({ runtime: rt({ switchable: false }) }), false), /worker-switch-btn/);
  assert.doesNotMatch(v.buildNodeHtml(loop({ runtime: rt({ switchable: undefined }) }), false), /worker-switch-btn/);
  assert.doesNotMatch(v.buildNodeHtml(source, false), /worker-switch-btn/);
});

test('the selected node gets the selected class and a position when one is given', () => {
  assert.match(v.buildNodeHtml(loop(), true), /class="worker-card clickable wf-node wf-selected"/);
  assert.doesNotMatch(v.buildNodeHtml(loop(), false), /wf-selected/);
  assert.match(v.buildNodeHtml(loop(), false, { x: 288, y: 120 }), /style="left:288px;top:120px;width:272px;height:128px"/);
});

test('edges are paths and only back edges are dashed', () => {
  const fwd = v.buildEdgeSvg({ id: 'a->b:claims', kind: 'claims', back: false }, [{ x: 0, y: 4 }, { x: 8, y: 12 }]);
  assert.match(fwd, /^<path class="wf-edge wf-edge-claims" data-edge-id="a-&gt;b:claims" d="M0 4 L8 12"/);
  assert.doesNotMatch(fwd, /stroke-dasharray/);
  const back = v.buildEdgeSvg({ id: 'b->a:claims', kind: 'claims', back: true }, [{ x: 0, y: 4 }, { x: 8, y: 12 }]);
  assert.match(back, /wf-edge-back/);
  assert.match(back, /stroke-dasharray="6 4"/);
});

const GRAPH = {
  schemaVersion: 1, generatedAt: 'now', groups: [], warnings: [],
  nodes: [source, loop(), stage, loop({ id: 'reviewer', label: 'reviewer', runtime: rt({ instanceId: 'reviewer', switchable: false }) })],
  edges: [
    { id: 'source:hygiene->worker-3090:claims', from: 'source:hygiene', to: 'worker-3090', kind: 'claims', label: null },
    { id: 'worker-3090->reviewer:reviews', from: 'worker-3090', to: 'reviewer', kind: 'reviews', label: null },
    { id: 'reviewer->worker-3090:triggers', from: 'reviewer', to: 'worker-3090', kind: 'triggers', label: null },
  ],
};

test('the graph surface has one node div per node, one path per edge, and dashes only the back edge', () => {
  const html = v.buildGraphHtml(GRAPH, v.layoutGraph(GRAPH), { selectedId: null });
  assert.equal(html.split('data-node-id=').length - 1, 4);
  assert.equal(html.split('<path class="wf-edge ').length - 1, 3);
  assert.equal(html.split('stroke-dasharray').length - 1, 1);
  assert.match(html, /id="wf-surface"/);
  assert.match(html, /data-view="cards"/);
  assert.match(html, /data-view="graph"/);
  assert.doesNotMatch(html, /id="wf-detail"/);
});

test('a selected node adds a read-only detail panel; only loops get the run-log slot', () => {
  const lay = v.layoutGraph(GRAPH);
  const withLoop = v.buildGraphHtml(GRAPH, lay, { selectedId: 'worker-3090' });
  assert.match(withLoop, /id="wf-detail"/);
  assert.match(withLoop, /wf-selected/);
  assert.match(withLoop, /id="wf-runlog"/);
  assert.match(withLoop, /<dt>Provider<\/dt><dd>local<\/dd>/);
  const withSource = v.buildGraphHtml(GRAPH, lay, { selectedId: 'source:hygiene' });
  assert.match(withSource, /<dt>Pending<\/dt><dd>3<\/dd>/);
  assert.doesNotMatch(withSource, /wf-runlog/);
  const service = { id: 'service:watchdog', kind: 'service', label: 'watchdog', parent: null, runtime: rt({ instanceId: 'watchdog', switchable: false }), model: null, work: null, counts: null };
  assert.doesNotMatch(v.buildDetailHtml(service, []), /wf-runlog/);
  assert.match(v.buildDetailHtml(loop(), []), /<dt>Local choices<\/dt><dd>a, b<\/dd>/);
  assert.match(v.buildDetailHtml(loop(), []), /<dt>Cloud choices<\/dt><dd>c<\/dd>/);
});

test('graph warnings show as a one-line note and in the detail panel', () => {
  const g = { ...GRAPH, warnings: ['lanes: boom'] };
  const html = v.buildGraphHtml(g, v.layoutGraph(g), { selectedId: 'worker-3090' });
  assert.match(html, /1 warning\(s\) while building this graph/);
  assert.match(html, /<li>lanes: boom<\/li>/);
});

test('buildGraphHtml and the builders survive empty or null input', () => {
  assert.doesNotThrow(() => v.buildGraphHtml(null, null, null));
  assert.doesNotThrow(() => v.buildNodeHtml(null, false));
  assert.equal(v.buildDetailHtml(null, []), '');
  assert.match(v.buildGraphHtml({ nodes: [], edges: [] }, { positions: {}, width: 0, height: 0, edges: [] }, {}), /id="wf-surface"/);
});

function store(initial, boom) {
  const data = { workersView: initial };
  return {
    getItem: (k) => { if (boom) throw new Error('denied'); return data[k] === undefined ? null : data[k]; },
    setItem: (k, val) => { if (boom) throw new Error('denied'); data[k] = val; },
    data,
  };
}

test('the stored view falls back to cards for anything but "graph"', () => {
  assert.equal(v.workersViewMode(store('graph')), 'graph');
  for (const stored of ['cards', 'GRAPH', 'grid', '', null, undefined, '{}']) assert.equal(v.workersViewMode(store(stored)), 'cards', String(stored));
  assert.equal(v.workersViewMode(store('graph', true)), 'cards');
  assert.equal(v.workersViewMode(null), 'cards');
});

test('setWorkersView stores graph or cards and never throws', () => {
  const s = store(null);
  v.setWorkersView('graph', s);
  assert.equal(s.data.workersView, 'graph');
  v.setWorkersView('anything-else', s);
  assert.equal(s.data.workersView, 'cards');
  assert.doesNotThrow(() => v.setWorkersView('graph', store(null, true)));
});

test('the toggle marks the active view', () => {
  const cards = v.workersViewToggleHtml('cards');
  assert.match(cards, /class="secondary wf-view-btn active" data-view="cards" aria-pressed="true"/);
  assert.match(cards, /class="secondary wf-view-btn" data-view="graph" aria-pressed="false"/);
  assert.match(v.workersViewToggleHtml('graph'), /wf-view-btn active" data-view="graph"/);
});

test('the signature changes with visible values but not with the state age; redraw rules', () => {
  const sig = v.graphSignature(GRAPH);
  const aged = JSON.parse(JSON.stringify(GRAPH));
  aged.nodes[1].runtime.stateAgeSeconds = 9999;
  assert.equal(v.graphSignature(aged), sig);
  for (const mutate of [(g) => { g.nodes[1].runtime.status = 'idle'; }, (g) => { g.nodes[0].counts.pending = 9; }, (g) => { g.nodes[1].runtime.currentTaskId = 'other'; },
    (g) => { g.nodes[1].runtime.disabled = true; }, (g) => { g.edges.pop(); }, (g) => { g.warnings.push('w'); }, (g) => { g.nodes[1].model.name = 'x'; }]) {
    const g = JSON.parse(JSON.stringify(GRAPH));
    mutate(g);
    assert.notEqual(v.graphSignature(g), sig);
  }
  assert.equal(v.graphNeedsRedraw(null, sig), true);
  assert.equal(v.graphNeedsRedraw(sig, sig), false);
  assert.equal(v.graphNeedsRedraw(sig, v.graphSignature({ ...GRAPH, warnings: ['w'] })), true);
});

test('index.html wiring: scripts in order, scroll box inside the page, workers-tab.js hook and size', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'templates', 'index.html'), 'utf8');
  const at = (name) => html.indexOf('/static/js/' + name);
  assert.ok(at('worker-status-helpers.js') > 0);
  assert.ok(at('worker-status-helpers.js') < at('workers-tab.js'));
  assert.ok(at('worker-switch-ui.js') < at('workflow-layout.js'));
  assert.ok(at('workflow-layout.js') < at('workflow-graph-view.js'));
  assert.match(html, /\.wf-surface \{[^}]*overflow: auto;[^}]*max-width: 100%/);
  const tab = fs.readFileSync(path.join(JS, 'workers-tab.js'), 'utf8');
  assert.ok(tab.split('\n').length < 500);
  assert.equal(tab.split("workersViewMode() === 'graph'").length - 1, 1);
  assert.equal(tab.split('wireWorkersViewToggle(main)').length - 1, 1);
});

// ---- renderGraphView with a fake page ----

function fakeMain() {
  const m = { writes: 0, html: '', selectedClicks: [] };
  Object.defineProperty(m, 'innerHTML', { get() { return m.html; }, set(x) { m.html = x; m.writes += 1; } });
  m.querySelector = (sel) => (sel === '#wf-surface' && m.html.includes('id="wf-surface"') ? { scrollLeft: 0, scrollTop: 0 } : null);
  m.querySelectorAll = () => [];
  m.contains = () => true;
  return m;
}

function withFetch(impl) {
  ctx.fetchJson = impl;
  ctx.renderStaleCheck = () => () => false;
  ctx.renderWorkers = () => {};
  ctx.renderRunLogList = () => '';
}

test('a failed or unavailable route shows one message with a way back to Cards and leaves nothing half drawn', async () => {
  const main = fakeMain();
  withFetch(async () => { throw new Error('HTTP 500'); });
  await v.renderGraphView(main, false);
  assert.match(main.html, /The workflow graph is unavailable: HTTP 500\./);
  assert.match(main.html, /data-view="cards">Back to Cards</);
  assert.doesNotMatch(main.html, /id="wf-surface"/);
  withFetch(async () => ({ available: false, reason: 'node missing <b>', nodes: [] }));
  await v.renderGraphView(main, false);
  assert.match(main.html, /unavailable: node missing &lt;b&gt;\./);
  withFetch(async () => ({ schemaVersion: 1 }));
  await v.renderGraphView(main, false);
  assert.match(main.html, /Back to Cards/);
});

test('a poll with nothing changed does not redraw; a changed status does; a stale render writes nothing', async () => {
  const main = fakeMain();
  let graph = JSON.parse(JSON.stringify(GRAPH));
  withFetch(async () => JSON.parse(JSON.stringify(graph)));
  await v.renderGraphView(main, false);
  assert.match(main.html, /id="wf-surface"/);
  const first = main.writes;
  await v.renderGraphView(main, true);
  assert.equal(main.writes, first, 'unchanged poll must not touch the page');
  graph.nodes[1].runtime.status = 'idle';
  await v.renderGraphView(main, true);
  assert.equal(main.writes, first + 1);
  assert.match(main.html, /<span class="badge idle">idle<\/span>/);
  await v.renderGraphView(main, false);
  assert.equal(main.writes, first + 2, 'a non-poll render always draws');
  ctx.renderStaleCheck = () => () => true;
  await v.renderGraphView(main, false);
  assert.equal(main.writes, first + 2, 'a render that went stale during the fetch writes nothing');
});

// ---- one card per loop (HUB0346 piece 2) ----
const cardGraph = () => ({
  nodes: [
    { ...source, id: 'source:shared', label: 'shared' }, { ...source, id: 'source:solo', label: 'solo' },
    loop({ id: 'worker-1', label: 'worker-1' }), loop({ id: 'worker-2', label: 'worker-2', runtime: rt({ instanceId: 'worker-2' }) }),
    { ...loop({ id: 'reviewer', label: 'reviewer' }), runtime: rt({ instanceId: 'reviewer', switchable: false }) },
    { id: 'service:apply-loop', kind: 'service', label: 'apply-loop', parent: null, runtime: null, model: null, work: null, counts: null },
    { id: 'service:watchdog', kind: 'service', label: 'watchdog', parent: null, runtime: null, model: null, work: null, counts: null },
  ],
  edges: [
    { id: 'source:shared->worker-1:claims', from: 'source:shared', to: 'worker-1', kind: 'claims', label: null },
    { id: 'source:shared->worker-2:claims', from: 'source:shared', to: 'worker-2', kind: 'claims', label: null },
    { id: 'source:solo->worker-2:claims', from: 'source:solo', to: 'worker-2', kind: 'claims', label: null },
    { id: 'worker-1->reviewer:reviews', from: 'worker-1', to: 'reviewer', kind: 'reviews', label: null },
    { id: 'worker-2->reviewer:reviews', from: 'worker-2', to: 'reviewer', kind: 'reviews', label: null },
    { id: 'reviewer->service:apply-loop:applies', from: 'reviewer', to: 'service:apply-loop', kind: 'applies', label: null },
  ],
  groups: [], warnings: [],
});
const cardsOf = (html) => html.split('<section class="wf-card"').slice(1);
const topOf = (card, id) => Number(new RegExp('data-node-id="' + id + '"[^>]*style="left:\\d+px;top:(\\d+)px').exec(card)[1]);

test('the cards view is one swipe row with one card per lane plus a services card', () => {
  const html = v.buildCardsHtml(cardGraph(), {});
  assert.match(html, /<div class="wf-cards" id="wf-surface">/);
  const cards = cardsOf(html);
  assert.equal(cards.length, 3);
  assert.deepEqual(cards.map((c) => /data-loop-id="([^"]+)"/.exec(c)[1]), ['worker-1', 'worker-2', 'services']);
  assert.match(cards[0], /1 of 3/);
  assert.match(cards[2], /3 of 3/);
  assert.match(html, /wf-view-btn/, 'the Cards | Graph toggle stays');
});

test('inside a card the source is above the lane, above the reviewer, above the apply service', () => {
  const card = cardsOf(v.buildCardsHtml(cardGraph(), {}))[0];
  assert.ok(topOf(card, 'source:shared') < topOf(card, 'worker-1'));
  assert.ok(topOf(card, 'worker-1') < topOf(card, 'reviewer'));
  assert.ok(topOf(card, 'reviewer') < topOf(card, 'service:apply-loop'));
});

test('each card carries the size of its canvas so the page can scale it to fit', () => {
  cardsOf(v.buildCardsHtml(cardGraph(), {})).forEach((c) => {
    const m = /class="wf-canvas" data-w="(\d+)" data-h="(\d+)" style="width:(\d+)px;height:(\d+)px"/.exec(c);
    assert.ok(m, 'canvas with size');
    assert.equal(m[1], m[3]);
    assert.equal(m[2], m[4]);
    assert.ok(Number(m[1]) > 0 && Number(m[2]) > 0);
  });
});

test('a node that sits on several cards is marked selected on every one of them', () => {
  const html = v.buildCardsHtml(cardGraph(), { selectedId: 'source:shared' });
  const marked = cardsOf(html).filter((c) => /wf-node wf-selected" data-node-id="source:shared"/.test(c) || /wf-selected[^"]*" data-node-id="source:shared"/.test(c));
  assert.equal(marked.length, 2);
  assert.match(html, /wf-detail|wf-node-panel|id="wf-detail"/, 'the detail panel of the selected node follows the row');
});

test('the cards view survives empty or null input and still draws the bar', () => {
  [null, undefined, {}, { nodes: [], edges: [] }].forEach((g) => {
    const html = v.buildCardsHtml(g, {});
    assert.match(html, /id="wf-surface"/);
    assert.equal(cardsOf(html).length, 0);
  });
});

test('the single-canvas builder is unchanged: buildGraphHtml still draws one surface', () => {
  const g = cardGraph();
  const html = v.buildGraphHtml(g, v.layoutGraph(g, v.WF_LAYOUT_OPTS), {});
  assert.match(html, /class="wf-surface" id="wf-surface"/);
  assert.equal(cardsOf(html).length, 0);
});

test('index.html wiring: the card row snaps horizontally and workflow-loops.js loads between the layout and the view', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'templates', 'index.html'), 'utf8');
  assert.match(index, /\.wf-cards \{[^}]*scroll-snap-type: x mandatory/);
  assert.match(index, /\.wf-card \{[^}]*flex: 0 0 100%/);
  const at = (f) => index.indexOf('/static/js/' + f);
  assert.ok(at('workflow-layout.js') > 0 && at('workflow-layout.js') < at('workflow-loops.js'));
  assert.ok(at('workflow-loops.js') < at('workflow-graph-view.js'));
});

// ---- dragged positions (HUB0346 piece 3) ----
const memStore = (obj) => { const m = { ...(obj || {}) }; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, val) => { m[k] = String(val); }, raw: m }; };
const nodeBox = (card, id) => {
  const m = new RegExp('data-node-id="' + id + '"[^>]*style="left:(\\d+)px;top:(\\d+)px').exec(card);
  return { x: Number(m[1]), y: Number(m[2]) };
};

test('a saved position replaces the laid-out one on that card only', () => {
  const store = memStore({ workersGraphPositions: JSON.stringify({ 'worker-1': { 'source:shared': { x: 600, y: 400 } } }) });
  const cards = cardsOf(v.buildCardsHtml(cardGraph(), { storage: store }));
  assert.deepEqual(nodeBox(cards[0], 'source:shared'), { x: 600, y: 400 });
  assert.notDeepEqual(nodeBox(cards[1], 'source:shared'), { x: 600, y: 400 }, 'the same node on the next card was not moved');
});

test('without saved positions the cards are exactly what they were', () => {
  const plain = v.buildCardsHtml(cardGraph(), { storage: memStore() });
  assert.equal(plain, v.buildCardsHtml(cardGraph(), { storage: null }));
  assert.equal(plain, v.buildCardsHtml(cardGraph(), { storage: memStore({ workersGraphPositions: 'garbage' }) }));
});

test('a saved position of a node that is no longer on the card is ignored', () => {
  const store = memStore({ workersGraphPositions: JSON.stringify({ 'worker-1': { 'source:retired': { x: 900, y: 900 } } }) });
  assert.equal(v.buildCardsHtml(cardGraph(), { storage: store }), v.buildCardsHtml(cardGraph(), { storage: memStore() }));
});

test('an edge with a moved end is re-pointed and the canvas grows to hold the moved node', () => {
  const base = cardsOf(v.buildCardsHtml(cardGraph(), { storage: memStore() }))[0];
  const store = memStore({ workersGraphPositions: JSON.stringify({ 'worker-1': { 'worker-1': { x: 1200, y: 900 } } }) });
  const card = cardsOf(v.buildCardsHtml(cardGraph(), { storage: store }))[0];
  const dOf = (c, id) => new RegExp('data-edge-id="' + id.replace('>', '&gt;') + '" d="([^"]+)"').exec(c)[1]; // the view escapes > in attributes
  assert.notEqual(dOf(card, 'source:shared->worker-1:claims'), dOf(base, 'source:shared->worker-1:claims'));
  assert.equal(dOf(card, 'reviewer->service:apply-loop:applies'), dOf(base, 'reviewer->service:apply-loop:applies'), 'an edge between two unmoved nodes keeps its route');
  const size = (c) => { const m = /class="wf-canvas" data-w="(\d+)" data-h="(\d+)"/.exec(c); return { w: Number(m[1]), h: Number(m[2]) }; };
  assert.ok(size(card).w >= 1200 + 272);
  assert.ok(size(card).h >= 900 + 128);
});

test('the card bar has a Reset layout button and the stored view helper falls back to no storage', () => {
  assert.match(v.buildCardsHtml(cardGraph(), {}), /<button type="button" class="secondary wf-reset-btn"[^>]*>Reset layout<\/button>/);
  assert.equal(v.wfStore({ storage: null }), null);
  const m = memStore();
  assert.equal(v.wfStore({ storage: m }), m);
});

test('index.html wiring: workflow-drag.js loads before the view, and nodes in a card are draggable by touch', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'templates', 'index.html'), 'utf8');
  const at = (f) => index.indexOf('/static/js/' + f);
  assert.ok(at('workflow-drag.js') > 0 && at('workflow-drag.js') < at('workflow-graph-view.js'));
  assert.match(index, /\.wf-card \.wf-node \{[^}]*touch-action: none/);
});

test('a layer with many sources wraps into columns that fit the screen, so a card is not one very wide row', () => {
  const g = cardGraph();
  for (let i = 0; i < 12; i++) {
    const id = 'source:bulk' + String(i).padStart(2, '0');
    g.nodes.push({ ...source, id, label: id });
    g.edges.push({ id: id + '->worker-1:claims', from: id, to: 'worker-1', kind: 'claims', label: null });
  }
  const sizeOf = (html) => { const m = /class="wf-canvas" data-w="(\d+)" data-h="(\d+)"/.exec(cardsOf(html)[0]); return { w: Number(m[1]), h: Number(m[2]) }; };
  const open = { 'worker-1': true }; // this is about the expanded layout: a big loop is collapsed by default
  const one = sizeOf(v.buildCardsHtml(g, { storage: null, maxPerRow: 1, expandedSources: open }));
  const four = sizeOf(v.buildCardsHtml(g, { storage: null, maxPerRow: 4, expandedSources: open }));
  assert.equal(one.w, 272, 'a phone gets one column');
  assert.ok(four.w <= 4 * 336, 'a desktop gets at most four');
  assert.ok(one.h > four.h, 'fewer columns make the card taller, not wider');
});

test('the column count follows the screen width: 1 on a phone, more on wider screens, never above 4', () => {
  const at = (w) => { const saved = ctx.innerWidth; ctx.innerWidth = w; const n = v.wfMaxPerRow(); ctx.innerWidth = saved; return n; };
  assert.equal(at(390), 1);
  assert.equal(at(768), 2);
  assert.equal(at(1366), 3);
  assert.equal(at(3000), 4);
  assert.equal(at(100), 1);
  assert.equal(v.wfMaxPerRow(), 4, 'no window width known gives the cap');
});

// ---- graph readability pass 2: collapsed sources, one header per group, lane titles ----
const srcNode = (i) => ({ ...source, id: 'source:big' + String(i).padStart(2, '0'), label: 'big' + i, counts: { pending: 1, drafting: 0 } });
const bigGraph = (n, extra) => {
  const g = cardGraph();
  const added = Array.from({ length: n }, (_, i) => srcNode(i));
  g.nodes.push(...added);
  g.edges.push(...added.map((s) => ({ id: s.id + '->worker-1:claims', from: s.id, to: 'worker-1', kind: 'claims', label: null })));
  return Object.assign(g, extra || {});
};
const cardNodeIds = (card) => [...card.matchAll(/data-node-id="([^"]+)"/g)].map((m) => m[1]);

test('a loop with more than six sources shows ONE group card and a Show N sources button; small loops have no button', () => {
  const cards = cardsOf(v.buildCardsHtml(bigGraph(12), { storage: null, maxPerRow: 1 }));
  const ids = cardNodeIds(cards[0]);
  assert.ok(ids.includes('group:sources:worker-1'));
  assert.ok(!ids.some((id) => id.startsWith('source:big')), 'no individual big source is drawn');
  assert.match(cards[0], /<button type="button" class="secondary wf-sources-toggle" data-loop-id="worker-1" aria-expanded="false">Show 13 sources<\/button>/, '12 added plus the shared source of the base graph');
  assert.match(cards[0], /<span class="id">13 sources<\/span>/);
  assert.doesNotMatch(cards[1], /wf-sources-toggle/);
  assert.ok(ids.length < 8, 'the card is a short chain, not a wall of nodes');
});

test('expanding shows every source again with a Hide sources button; the choice is per loop', () => {
  const html = v.buildCardsHtml(bigGraph(12), { storage: null, maxPerRow: 1, expandedSources: { 'worker-1': true } });
  const cards = cardsOf(html);
  assert.ok(cardNodeIds(cards[0]).filter((id) => id.startsWith('source:big')).length === 12);
  assert.match(cards[0], /aria-expanded="true">Hide sources<\/button>/);
  assert.doesNotMatch(cards[0], /group:sources:worker-1/);
  const other = v.buildCardsHtml(bigGraph(12), { storage: null, maxPerRow: 1, expandedSources: { 'worker-2': true } });
  assert.match(cardsOf(other)[0], /Show 13 sources/, 'expanding another loop does not expand this one');
});

test('the collapsed card keeps the edge from the sources card to the worker, and its edge points are finite', () => {
  const card = cardsOf(v.buildCardsHtml(bigGraph(12), { storage: null, maxPerRow: 1 }))[0];
  assert.match(card, /data-edge-id="group:sources:worker-1-&gt;worker-1:claims" d="M[^"]+L[^"]+"/);
  assert.doesNotMatch(card, /NaN|undefined/);
});

test('a group drawn as one box per row gets its header button on the first box only', () => {
  const g = bigGraph(8, { groups: [{ id: 'group:intake', label: 'Intake', children: Array.from({ length: 8 }, (_, i) => 'source:big' + String(i).padStart(2, '0')), collapsed: false }] });
  g.nodes.forEach((n) => { if (n.id.startsWith('source:big')) n.parent = 'group:intake'; });
  const card = cardsOf(v.buildCardsHtml(g, { storage: null, maxPerRow: 2, expandedSources: { 'worker-1': true } }))[0];
  const boxes = (card.match(/class="wf-group-box"/g) || []).length;
  const headers = (card.match(/class="secondary wf-group-toggle"/g) || []).length;
  assert.ok(boxes >= 3, 'eight sources in rows of two make several boxes (' + boxes + ')');
  assert.equal(headers, 1, 'one header for the group');
  assert.match(card, /▾ Intake/);
});

test('a card with groups leaves room between rows for the group header; a card without groups keeps the normal gap', () => {
  const tops = (html, ids) => ids.map((id) => topOf(cardsOf(html)[0], id));
  const base = bigGraph(8);
  const ids = ['source:big00', 'source:big01'];
  const open = { storage: null, maxPerRow: 1, expandedSources: { 'worker-1': true } };
  const plainTops = tops(v.buildCardsHtml(base, open), ids);
  const gap0 = plainTops[1] - plainTops[0];
  const withGroups = bigGraph(8, { groups: [{ id: 'group:intake', label: 'Intake', children: ['source:big00', 'source:big01', 'source:big02'], collapsed: false }] });
  withGroups.nodes.forEach((n) => { if (['source:big00', 'source:big01', 'source:big02'].includes(n.id)) n.parent = 'group:intake'; });
  const groupTops = tops(v.buildCardsHtml(withGroups, open), ids);
  assert.ok(groupTops[1] - groupTops[0] >= gap0 + 40, 'rows are further apart by about a header (' + gap0 + ' vs ' + (groupTops[1] - groupTops[0]) + ')');
});

test('card titles show the lane id first and the label after it; Services keeps its name', () => {
  assert.equal(v.wfCardTitle({ id: 'worker-3090', label: 'ornith:35b' }), 'worker-3090 · ornith:35b');
  assert.equal(v.wfCardTitle({ id: 'worker-1', label: 'worker-1' }), 'worker-1');
  assert.equal(v.wfCardTitle({ id: 'worker-1' }), 'worker-1');
  assert.equal(v.wfCardTitle({ id: 'services', label: 'Services' }), 'Services');
  assert.equal(v.wfCardTitle(null), '');
  const g = cardGraph();
  g.nodes.find((n) => n.id === 'worker-1').label = 'ornith:35b';
  const html = v.buildCardsHtml(g, { storage: null });
  assert.match(html, /<span class="id">worker-1 · ornith:35b<\/span>/);
});

test('a loop node whose label is only its model name shows its node id; an authored label is kept', () => {
  const plain = loop({ id: 'worker-3090', label: 'ornith:35b', model: model({ name: 'ornith:35b' }) });
  assert.match(v.buildNodeHtml(plain, false), /<span class="id">worker-3090<\/span>/);
  assert.match(v.buildNodeHtml(plain, false), /ornith:35b/, 'the model is still in the meta line');
  const authored = loop({ id: 'worker-3090', label: 'Big GPU', model: model({ name: 'ornith:35b' }) });
  assert.match(v.buildNodeHtml(authored, false), /<span class="id">Big GPU<\/span>/);
  const same = loop({ id: 'worker-1', label: 'worker-1' });
  assert.match(v.buildNodeHtml(same, false), /<span class="id">worker-1<\/span>/);
  const src = { ...source, label: 'ornith:35b', model: model({ name: 'ornith:35b' }) };
  assert.match(v.buildNodeHtml(src, false), /<span class="id">ornith:35b<\/span>/, 'only loop nodes are retitled');
});

// ---- card width pass: wide screens size each card to its drawing and wrap; a phone keeps the swipe row ----
const indexHtml = () => fs.readFileSync(path.join(__dirname, '..', 'templates', 'index.html'), 'utf8');
const phoneBlock = (html) => { const i = html.indexOf('@media (max-width: 700px)'); const j = html.indexOf('\n  }\n', i); return i < 0 ? '' : html.slice(i, j + 5); };

test('wide screens: the card row wraps, a card is as wide as its content, and its height is its content up to 78 percent of the window', () => {
  const html = indexHtml();
  assert.match(html, /\.wf-cards \{ display: flex; flex-wrap: wrap; align-items: flex-start; gap: 12px;/);
  assert.match(html, /\.wf-card \{ flex: 0 0 auto; box-sizing: border-box; max-width: 100%; max-height: 78vh;/);
  const before = html.slice(0, html.indexOf('@media (max-width: 700px)'));
  assert.doesNotMatch(before.slice(before.indexOf('.wf-cards {')), /scroll-snap-type/, 'no snapping outside the phone media query');
});

test('a phone (700 px or narrower) keeps one card per screen in a swipe row, exactly as before', () => {
  const block = phoneBlock(indexHtml());
  assert.ok(block.length > 0, 'the media query exists');
  assert.match(block, /\.wf-cards \{ flex-wrap: nowrap; overflow-x: auto; scroll-snap-type: x mandatory;/);
  assert.match(block, /\.wf-card \{ flex: 0 0 100%; scroll-snap-align: center; scroll-snap-stop: always; height: 78vh; height: 78dvh; max-height: none; \}/);
});

test('index.html loads workflow-card-fit.js after the loops helpers and before the view', () => {
  const index = indexHtml();
  const at = (f) => index.indexOf('/static/js/' + f);
  assert.ok(at('workflow-loops.js') > 0 && at('workflow-loops.js') < at('workflow-card-fit.js'));
  assert.ok(at('workflow-card-fit.js') < at('workflow-graph-view.js'));
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'workflow-graph-view.js'), 'utf8').split('\n').length < 500, 'the view file stays under 500 lines');
});

test('wfIsNarrow follows the 700 px breakpoint', () => {
  const at = (w) => { const saved = ctx.innerWidth; ctx.innerWidth = w; const r = ctx.wfIsNarrow(); ctx.innerWidth = saved; return r; };
  assert.equal(at(390), true);
  assert.equal(at(700), true, '700 px is still a phone');
  assert.equal(at(701), false);
  assert.equal(at(1440), false);
  assert.equal(ctx.wfIsNarrow(), false, 'no window width known counts as wide');
});

test('wfIsNarrow asks the browser with the 700 px media query when matchMedia exists, and trusts its answer', () => {
  const seen = [];
  ctx.matchMedia = (q) => { seen.push(q); return { matches: true }; };
  try {
    assert.equal(ctx.wfIsNarrow(), true);
    assert.deepEqual([...seen], ['(max-width: 700px)']);
    ctx.matchMedia = () => ({ matches: false });
    assert.equal(ctx.wfIsNarrow(), false, 'a wide answer from the browser wins over window.innerWidth');
    ctx.innerWidth = 390;
    assert.equal(ctx.wfIsNarrow(), false, 'matchMedia is the authority when the browser has it');
  } finally {
    delete ctx.matchMedia;
    delete ctx.innerWidth;
  }
});

// ---- loops by type (piece 5) ----
const stepModel = (name, provider, lane, label, scale, tier) => ({ name, provider, lane, size: { b: 8, tier: tier || 'small', label, scale, source: 'tag' } });
const stepNode = (id, label, models, scale) => ({ id, kind: id.startsWith('stage:') ? 'stage' : 'step', label, parent: null, runtime: null, model: null, work: null, counts: null, models, size: { b: 8, tier: 'small', label: '?', scale, source: 'tag' } });
const typedGraph = () => ({
  nodes: [
    stepNode('stage:implement', 'Implement', [stepModel('ornith:35b', 'local', 'worker-3090', '35B', 1.25, 'medium'), stepModel('qwen3-vl:8b-instruct', 'local', 'worker-rx580', '8B', 1.0)], 1.0),
    stepNode('stage:review', 'Review', [stepModel('ornith:35b', 'local', 'reviewer', '35B', 1.25, 'medium')], 1.25),
    stepNode('stage:apply', 'Apply', [stepModel('apply-loop', 'script', null, 'script', 0.8)], 0.8),
    loop({ id: 'worker-3090', label: 'ornith:35b' }), loop({ id: 'worker-rx580', label: 'qwen3-vl:8b-instruct', runtime: rt({ status: 'idle' }) }), loop({ id: 'reviewer', label: 'ornith:35b' }),
  ],
  edges: [{ id: 'stage:implement->stage:review:produces', from: 'stage:implement', to: 'stage:review', kind: 'produces', label: null }, { id: 'stage:review->stage:apply:produces', from: 'stage:review', to: 'stage:apply', kind: 'produces', label: null }],
  groups: [], warnings: [],
  loops: [{ id: 'loop:pipeline', name: 'Task pipeline', kind: 'pipeline', steps: ['stage:implement', 'stage:review', 'stage:apply'], services: [] }],
});
const stepBoxOf = (html, id) => { const m = new RegExp('data-node-id="' + id + '"[^>]*style="left:(\\d+)px;top:(\\d+)px;width:(\\d+)px;height:(\\d+)px"').exec(html); return m ? { w: Number(m[3]), h: Number(m[4]) } : null; };

test('a typed card is titled by the loop name only and shows the models of each step with size badges', () => {
  const [card] = ctx.splitIntoLoops(typedGraph());
  const html = v.buildCardHtml(card, 0, 1, { maxPerRow: 1, storage: null });
  assert.match(html, /<span class="id">Task pipeline<\/span>/);
  assert.doesNotMatch(html, /worker-3090 ·|worker-rx580 ·/);
  assert.match(html, /data-lane="worker-3090"/);
  assert.match(html, /data-lane="worker-rx580"/);
  assert.match(html, /wf-size wf-size-small" title="model size">8B</);
  assert.match(html, /wf-size wf-size-medium" title="model size">35B</);
  assert.equal((html.match(/class="worker-card clickable wf-node wf-step/g) || []).length, 3, 'three step cards, no lane cards');
  assert.doesNotMatch(html, /data-node-id="worker-/);
});

test('a step card is drawn bigger for a bigger model: Review (35B) is wider than Implement (8B), which is wider than Apply (script)', () => {
  const [card] = ctx.splitIntoLoops(typedGraph());
  const html = v.buildCardHtml(card, 0, 1, { maxPerRow: 1, storage: null });
  const impl = stepBoxOf(html, 'stage:implement');
  const review = stepBoxOf(html, 'stage:review');
  const apply = stepBoxOf(html, 'stage:apply');
  assert.ok(review.w > impl.w && impl.w > apply.w, JSON.stringify({ review, impl, apply }));
  assert.deepEqual(impl, { w: 272, h: 128 });
  assert.deepEqual(review, { w: 340, h: 160 });
  assert.deepEqual(apply, { w: 220, h: 104 });
});

test('the lane status shows as a dot on the model row, from the lanes that ride along with the card', () => {
  const [card] = ctx.splitIntoLoops(typedGraph());
  const html = v.buildCardHtml(card, 0, 1, { maxPerRow: 1, storage: null });
  assert.match(html, /wf-dot wf-dot-working" title="worker-3090: working"/);
  assert.match(html, /wf-dot wf-dot-idle" title="worker-rx580: idle"/);
});

test('wfCardTitle: a typed card shows its label; a lane card still shows the lane id first', () => {
  assert.equal(v.wfCardTitle({ id: 'loop:x', label: 'Stalled-task worker', byType: true }), 'Stalled-task worker');
  assert.equal(v.wfCardTitle({ id: 'worker-3090', label: 'ornith:35b' }), 'worker-3090 · ornith:35b');
});

test('lane cards (no graph.loops) are unchanged: no step cards and no model rows', () => {
  const html = v.buildCardsHtml({ nodes: [loop(), source], edges: [{ id: 'source:hygiene->worker-3090:claims', from: 'source:hygiene', to: 'worker-3090', kind: 'claims', label: null }], groups: [], warnings: [] }, { maxPerRow: 1, storage: null });
  assert.doesNotMatch(html, /wf-step|wf-model-row/);
  assert.match(html, /worker-3090/);
});

test('the poll signature changes when a step gains a model or a loop changes its steps', () => {
  const a = typedGraph();
  const b = typedGraph();
  b.nodes[0].models.push(stepModel('x:1b', 'local', 'worker-x', '1B', 1.0));
  const c = typedGraph();
  c.loops[0].steps = ['stage:implement'];
  assert.notEqual(v.graphSignature(a), v.graphSignature(b));
  assert.notEqual(v.graphSignature(a), v.graphSignature(c));
  assert.equal(v.graphSignature(a), v.graphSignature(typedGraph()));
});

test('index.html loads workflow-step-card.js after workflow-card-fit.js and before the view, and the step card styles exist', () => {
  const index = indexHtml();
  const at = (f) => index.indexOf('/static/js/' + f);
  assert.ok(at('workflow-card-fit.js') > 0 && at('workflow-card-fit.js') < at('workflow-step-card.js') && at('workflow-step-card.js') < at('workflow-graph-view.js'));
  assert.match(index, /\.wf-model-row \{/);
  assert.match(index, /\.wf-size-large \{/);
});

test('a press on a model row never starts a node drag (pointer capture would send the click to the node and the row could not open its lane)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'workflow-graph-view.js'), 'utf8');
  assert.match(src, /ev\.target\.closest\('button, select, input, a, \.wf-model-lane'\)/);
});
