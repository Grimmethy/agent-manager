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
for (const f of ['worker-status-helpers.js', 'worker-switch-ui.js', 'workflow-layout.js', 'workflow-loops.js', 'workflow-graph-view.js']) {
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
