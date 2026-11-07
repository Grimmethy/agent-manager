// Node tests for the groups of the Workers graph (HUB0326 piece W-C5): the pure helpers of workflow-groups.js and their use in the Graph view.
// The real scripts are loaded into one bare vm context in the order index.html loads them; fetch and the page are fakes.
// Run: node --test python/dashboard/tests/test_workflow_groups.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS = path.join(__dirname, '..', 'static', 'js');
const read = (f) => fs.readFileSync(path.join(JS, f), 'utf8');
const ESC_HTML = "function escapeHtml(s) {\n  return String(s).replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]));\n}";
const ESC_ATTR = "function escapeAttr(s) { return String(s).replace(/\"/g, '&quot;'); }";

const ctx = vm.createContext({ console });
ctx.window = ctx;
vm.runInContext(ESC_HTML + '\n' + ESC_ATTR + "\nfunction hubTag(hub) { return 'H:' + hub.label; }", ctx);
for (const f of ['worker-status-helpers.js', 'worker-switch-ui.js', 'worker-model-select.js', 'worker-task-picker.js', 'workflow-layout.js', 'workflow-groups.js', 'workflow-node-panel.js', 'workflow-card-fit.js', 'workflow-graph-view.js']) {
  vm.runInContext(read(f), ctx, { filename: f });
}
const v = ctx;

const rt = (status, over) => ({ instanceId: 'x', status, stale: false, disabled: false, switchable: true, pid: 1, currentTaskId: null, currentPass: null, stateAgeSeconds: 5, hub: null, projectLabel: null, borrowed: false, ...over });
const node = (id, kind, status, extra) => ({ id, kind, label: id, parent: null, runtime: status ? rt(status, { instanceId: id }) : null, model: kind === 'loop' ? { name: 'm', provider: 'local', tierB: null, overridden: false, choices: { local: [], cloud: [] } } : null, work: null, counts: null, ...extra });
const edge = (from, to, kind, label = null) => ({ id: `${from}->${to}:${kind}`, from, to, kind, label });
const grp = (id, children, over) => ({ id, label: id, children, collapsed: false, ...over });
const graph = (over) => ({
  schemaVersion: 1, generatedAt: 'now', warnings: [],
  nodes: [node('worker-a', 'loop', 'working'), node('worker-b', 'loop', 'idle'), node('worker-c', 'loop', 'offline'), node('source:s', 'source', null, { counts: { pending: 2, drafting: 1 } }), node('source:t', 'source', null, { counts: { pending: 5, drafting: 0 } })],
  edges: [edge('source:s', 'worker-a', 'claims'), edge('source:s', 'worker-b', 'claims'), edge('worker-a', 'worker-b', 'triggers'), edge('worker-c', 'source:t', 'refines'), edge('source:t', 'worker-c', 'claims')],
  groups: [], ...over,
});
function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
// values made inside the vm context have that context's Array.prototype, so they are compared as plain copies
const plain = (x) => JSON.parse(JSON.stringify(x));
const ids = (g) => plain(g.nodes.map((n) => n.id));
const edgeIds = (g) => plain(g.edges.map((e) => e.id));

test('worstStatus returns the first status of the list, unknown ones rank between working and idle, nothing reads as idle', () => {
  const order = ['error', 'stale', 'paused', 'warming', 'queued', 'working', 'idle', 'offline', 'disabled'];
  order.forEach((s, i) => { if (i + 1 < order.length) assert.equal(v.worstStatus([order[i + 1], s]), s); });
  assert.equal(v.worstStatus(['mystery', 'working']), 'working');
  assert.equal(v.worstStatus(['mystery', 'idle']), 'mystery');
  assert.equal(v.worstStatus(['offline', 'mystery', 'disabled']), 'mystery');
  for (const empty of [[], null, undefined, 'x', 5, [null, '', 3]]) assert.equal(v.worstStatus(empty), 'idle', JSON.stringify(empty));
  assert.equal(v.worstStatus(['idle']), 'idle');
});

test('effectiveCollapsed: the operator choice wins over the flag in both directions', () => {
  const g = graph({ groups: [grp('group:a', ['worker-a'], { collapsed: true }), grp('group:b', ['worker-b'])] });
  assert.deepEqual([...v.effectiveCollapsed(g, {})], ['group:a']);
  assert.deepEqual([...v.effectiveCollapsed(g, { 'group:a': false, 'group:b': true })], ['group:b']);
  assert.deepEqual([...v.effectiveCollapsed(g, { 'group:a': 'yes' })], ['group:a']);
  assert.deepEqual([...v.effectiveCollapsed(null, null)], []);
  assert.deepEqual([...v.effectiveCollapsed({}, undefined)], []);
});

test('collapseGraph with no groups or nothing collapsed returns the same graph', () => {
  const plain = graph();
  assert.equal(v.collapseGraph(plain, new Set(['group:x'])), plain);
  const withGroup = graph({ groups: [grp('group:a', ['worker-a'])] });
  assert.equal(v.collapseGraph(withGroup, new Set()), withGroup);
  assert.equal(v.collapseGraph(withGroup, []), withGroup);
  assert.equal(v.collapseGraph(withGroup, undefined), withGroup);
  assert.equal(v.collapseGraph(null, new Set(['group:a'])), null);
});

test('a collapsed group becomes one node with the aggregate status, summed counts and its members edges re-pointed', () => {
  const g = graph({ groups: [grp('group:ab', ['worker-a', 'worker-b', 'source:s'], { label: 'AB' })] });
  const out = v.collapseGraph(g, new Set(['group:ab']));
  assert.deepEqual(ids(out), ['worker-c', 'source:t', 'group:ab']);
  const n = out.nodes.find((x) => x.id === 'group:ab');
  assert.equal(n.kind, 'group');
  assert.equal(n.label, 'AB');
  assert.equal(n.parent, null);
  assert.equal(n.memberCount, 3);
  assert.equal(n.runtime.status, 'working');
  assert.equal(n.runtime.switchable, false);
  assert.equal(n.model, null);
  assert.deepEqual(plain(n.counts), { pending: 2, drafting: 1 });
  // all three edges inside the group are gone; the two that cross its border remain
  assert.deepEqual(edgeIds(out), ['source:t->worker-c:claims', 'worker-c->source:t:refines']);
  assert.deepEqual(plain(out.groups), []);
});

test('edges from and to a collapsed group are re-pointed, duplicates are emitted once and keep the first label', () => {
  const g = graph({ groups: [grp('group:ab', ['worker-a', 'worker-b'])], edges: [edge('source:s', 'worker-a', 'claims', 'first'), edge('source:s', 'worker-b', 'claims', 'second'), edge('worker-a', 'source:t', 'produces'), edge('worker-b', 'source:t', 'produces')] });
  const out = v.collapseGraph(g, new Set(['group:ab']));
  assert.deepEqual(edgeIds(out), ['group:ab->source:t:produces', 'source:s->group:ab:claims']);
  assert.equal(out.edges.find((e) => e.id === 'source:s->group:ab:claims').label, 'first');
  assert.deepEqual(plain(out.edges.map((e) => [e.from, e.to])), [['group:ab', 'source:t'], ['source:s', 'group:ab']]);
});

test('the aggregate status is the worst child status, stale counts, and only loop children give a status', () => {
  const g = graph({ groups: [grp('group:x', ['worker-a', 'worker-b', 'source:s'])] });
  g.nodes[1] = node('worker-b', 'loop', 'error');
  assert.equal(v.collapseGraph(g, new Set(['group:x'])).nodes.find((n) => n.id === 'group:x').runtime.status, 'error');
  const stale = graph({ groups: [grp('group:x', ['worker-a'])] });
  stale.nodes[0] = node('worker-a', 'loop', 'working', { runtime: rt('working', { stale: true }) });
  assert.equal(v.collapseGraph(stale, new Set(['group:x'])).nodes.find((n) => n.id === 'group:x').runtime.stale, true);
  const onlySource = graph({ groups: [grp('group:x', ['source:s', 'source:t'])] });
  const n = v.collapseGraph(onlySource, new Set(['group:x'])).nodes.find((x) => x.id === 'group:x');
  assert.equal(n.runtime.status, 'idle');
  assert.deepEqual(plain(n.counts), { pending: 7, drafting: 1 });
});

test('two collapsed groups and an edge between them', () => {
  const g = graph({ groups: [grp('group:one', ['worker-a']), grp('group:two', ['worker-b'])] });
  const out = v.collapseGraph(g, new Set(['group:one', 'group:two']));
  assert.deepEqual(ids(out), ['worker-c', 'source:s', 'source:t', 'group:one', 'group:two']);
  assert.ok(edgeIds(out).includes('group:one->group:two:triggers'));
  assert.ok(edgeIds(out).includes('source:s->group:one:claims'));
  assert.ok(edgeIds(out).includes('source:s->group:two:claims'));
});

test('a collapsed outer group hides an inner one; a collapsed inner group inside an expanded outer one becomes a child of it', () => {
  const g = graph({ groups: [grp('group:out', ['group:in', 'worker-c']), grp('group:in', ['worker-a', 'worker-b'])] });
  const both = v.collapseGraph(g, new Set(['group:out', 'group:in']));
  assert.deepEqual(ids(both), ['source:s', 'source:t', 'group:out']);
  assert.equal(both.nodes.find((n) => n.id === 'group:out').memberCount, 3);
  assert.deepEqual(plain(both.groups), []);
  const inner = v.collapseGraph(g, new Set(['group:in']));
  assert.deepEqual(ids(inner), ['worker-c', 'source:s', 'source:t', 'group:in']);
  assert.deepEqual(plain(inner.groups.map((x) => [x.id, x.children])), [['group:out', ['group:in', 'worker-c']]]);
});

test('a group whose children are all missing is not collapsed into a node', () => {
  const g = graph({ groups: [grp('group:ghost', ['nobody'], { collapsed: true })] });
  assert.equal(v.collapseGraph(g, new Set(['group:ghost'])), g);
});

test('collapseGraph does not mutate its input and gives the same result twice', () => {
  const g = deepFreeze(graph({ groups: [grp('group:ab', ['worker-a', 'worker-b'])] }));
  const a = v.collapseGraph(g, new Set(['group:ab']));
  assert.deepEqual(a, v.collapseGraph(graph({ groups: [grp('group:ab', ['worker-a', 'worker-b'])] }), new Set(['group:ab'])));
  assert.doesNotThrow(() => v.collapseGraph(deepFreeze({ nodes: 'x', groups: [{ id: 'g', children: 5 }] }), new Set(['g'])));
});

test('groupBoxes: a box around the laid-out children of an expanded group, none for a group without laid-out members', () => {
  const g = graph({ groups: [grp('group:ab', ['worker-a', 'worker-b'], { label: 'AB' }), grp('group:none', ['nobody'])] });
  const boxes = v.groupBoxes(g, { 'worker-a': { x: 100, y: 200 }, 'worker-b': { x: 400, y: 328 } }, { w: 272, h: 128 }, 12);
  assert.deepEqual(plain(boxes), [{ id: 'group:ab', label: 'AB', x: 88, y: 160, w: 296, h: 180, part: 0 }, { id: 'group:ab', label: 'AB', x: 388, y: 288, w: 296, h: 180, part: 1 }]);
  assert.deepEqual(plain(v.groupBoxes(g, {}, { w: 1, h: 1 })), []);
  assert.deepEqual(plain(v.groupBoxes(null, {}, {})), []);
});

test('groupBoxes: a group at the edge of the layout has negative coordinates, the default padding is 12, nested groups are enclosed', () => {
  const g = graph({ groups: [grp('group:out', ['group:in', 'worker-c']), grp('group:in', ['worker-a'])] });
  const boxes = v.groupBoxes(g, { 'worker-a': { x: 0, y: 0 }, 'worker-c': { x: 300, y: 0 } }, { w: 272, h: 128 });
  assert.deepEqual(plain(boxes.map((b) => [b.id, b.x, b.y, b.w, b.h])), [['group:out', -12, -40, 296, 180], ['group:out', 288, -40, 296, 180], ['group:in', -12, -40, 296, 180]]);
});

test('the view draws a dashed box and a header button for an expanded group, escapes its label, and shifts the canvas when the box starts before the layout', () => {
  const g = graph({ groups: [grp('group:x', ['worker-a'], { label: '<b>"X"</b>' })] });
  const lay = v.layoutGraph(g, { nodeW: 272, nodeH: 128, gapX: 64, gapY: 16 });
  const html = v.buildGraphHtml(g, lay, { selectedId: null });
  assert.match(html, /<div class="wf-group-box" data-group-id="group:x" style="left:324px;top:0px;width:296px;height:180px">/);
  assert.match(html, /<button type="button" class="secondary wf-group-toggle" data-group-id="group:x" aria-expanded="true" title="Collapse this group">▾ &lt;b&gt;&quot;X&quot;&lt;\/b&gt;<\/button>/);
  assert.doesNotMatch(html, /<b>"X"/);
  assert.ok(html.indexOf('wf-group-box') < html.indexOf('class="wf-edges"'), 'the box is under the edges and the nodes');
  // worker-a sits at layer 1, y 0 in the layout; the box starts 40px above it, so the canvas is shifted down by 40
  assert.match(html, /data-node-id="worker-a" style="left:336px;top:40px;/);
  assert.match(html, /data-node-id="source:s" style="left:0px;top:40px;/);
});

test('the view draws a collapsed group as one card with the status, counts and member count, and without switch, model control or task pin', () => {
  const g = v.collapseGraph(graph({ groups: [grp('group:ab', ['worker-a', 'worker-b'], { label: 'AB', collapsed: true })] }), new Set(['group:ab']));
  const html = v.buildGraphHtml(g, v.layoutGraph(g, { nodeW: 272, nodeH: 128, gapX: 64, gapY: 16 }), { selectedId: null });
  assert.match(html, /class="worker-card clickable wf-node wf-group-node" data-node-id="group:ab" data-group="1"/);
  assert.match(html, /2 member\(s\)/);
  assert.match(html, /<span class="badge ok">working<\/span>/);
  assert.doesNotMatch(html, /wf-group-box/);
  const card = html.slice(html.indexOf('data-node-id="group:ab"'));
  assert.doesNotMatch(card, /worker-switch-btn|worker-model-select|wf-taskpick/);
  assert.equal(v.buildNodePanelHtml(g.nodes.find((n) => n.id === 'group:ab'), []), '');
});

test('a graph without groups is drawn without any group markup and with the layout size', () => {
  const g = graph();
  const lay = v.layoutGraph(g, { nodeW: 272, nodeH: 128, gapX: 64, gapY: 16 });
  const html = v.buildGraphHtml(g, lay, { selectedId: null });
  assert.doesNotMatch(html, /wf-group/);
  assert.ok(html.includes(`<div class="wf-canvas" style="width:${lay.width}px;height:${lay.height}px">`));
});

test('the signature changes when a group, its children or its collapsed flag change', () => {
  const base = graph({ groups: [grp('group:a', ['worker-a'])] });
  const sig = v.graphSignature(base);
  for (const change of [(x) => { x.groups[0].collapsed = true; }, (x) => { x.groups[0].children = ['worker-a', 'worker-b']; }, (x) => { x.groups[0].label = 'New'; }, (x) => { x.groups.push(grp('group:b', ['worker-c'])); }, (x) => { x.groups = []; }]) {
    const g = JSON.parse(JSON.stringify(base));
    change(g);
    assert.notEqual(v.graphSignature(g), sig);
  }
  assert.equal(v.graphSignature(JSON.parse(JSON.stringify(base))), sig);
});

// ---- the view with a fake page ----

const tick = () => new Promise((r) => setImmediate(r));
function fakePage() {
  const main = { writes: 0, html: '', nodes: [], toggles: [] };
  Object.defineProperty(main, 'innerHTML', {
    get() { return main.html; },
    set(x) {
      main.html = x; main.writes += 1;
      main.nodes = [...x.matchAll(/class="worker-card clickable wf-node[^"]*" data-node-id="([^"]+)"( data-group="1")?/g)].map((m) => ({ dataset: { nodeId: m[1], group: m[2] ? '1' : undefined }, onclick: null }));
      main.toggles = [...x.matchAll(/class="secondary wf-group-toggle" data-group-id="([^"]+)"/g)].map((m) => ({ dataset: { groupId: m[1] }, onclick: null }));
    },
  });
  main.querySelector = (sel) => (sel === '#wf-surface' ? (main.html.includes('id="wf-surface"') ? { scrollLeft: 0, scrollTop: 0 } : null) : null);
  main.querySelectorAll = (sel) => (sel === '.wf-node' ? main.nodes : sel === '.wf-group-toggle' ? main.toggles : []);
  main.contains = () => true;
  return main;
}
const reset = () => vm.runInContext('wfState.selectedId = null; wfState.tasks = null; wfState.signature = null; wfState.graph = null; wfState.shown = null; wfState.toggles = {};', ctx);
function setup(g) {
  reset();
  ctx.fetchJson = async (url) => (url === '/api/workflow-graph' ? JSON.parse(JSON.stringify(g)) : { items: [], runs: [] });
  ctx.renderStaleCheck = () => () => false;
  const main = fakePage();
  ctx.document = { getElementById: () => main, activeElement: null };
  return main;
}
const click = async (el) => { el.onclick({ stopPropagation() {} }); await tick(); await tick(); };

test('a group card toggles open and the header button toggles it closed again, with the choice kept in the view state', async () => {
  const main = setup(graph({ groups: [grp('group:ab', ['worker-a', 'worker-b'], { collapsed: true })] }));
  await v.renderGraphView(main, false);
  assert.ok(main.html.includes('data-group="1"') && !main.html.includes('wf-group-box'), 'drawn collapsed');
  await click(main.nodes.find((n) => n.dataset.group === '1'));
  assert.ok(main.html.includes('wf-group-box') && main.html.includes('data-node-id="worker-a"') && !main.html.includes('data-group="1"'), 'drawn expanded');
  assert.equal(vm.runInContext('wfState.toggles["group:ab"]', ctx), false);
  await click(main.toggles[0]);
  assert.ok(main.html.includes('data-group="1"') && !main.html.includes('data-node-id="worker-a"'), 'collapsed again');
  assert.equal(vm.runInContext('wfState.toggles["group:ab"]', ctx), true);
  delete ctx.document;
});

test('the operator choice survives the poll: an unchanged poll does not redraw and a changed graph is drawn with the same choice', async () => {
  const g = graph({ groups: [grp('group:ab', ['worker-a', 'worker-b'], { collapsed: true })] });
  const main = setup(g);
  await v.renderGraphView(main, false);
  await click(main.nodes.find((n) => n.dataset.group === '1')); // expanded by the operator
  const writes = main.writes;
  await v.renderGraphView(main, true);
  assert.equal(main.writes, writes, 'an unchanged poll writes nothing');
  const changed = JSON.parse(JSON.stringify(g));
  changed.nodes[0].runtime.status = 'idle';
  ctx.fetchJson = async (url) => (url === '/api/workflow-graph' ? JSON.parse(JSON.stringify(changed)) : { items: [], runs: [] });
  await v.renderGraphView(main, true);
  assert.equal(main.writes, writes + 1);
  assert.ok(main.html.includes('wf-group-box'), 'still expanded after the redraw');
  delete ctx.document;
});

test('a selected node that gets hidden inside a collapsed group is deselected and its panel is gone', async () => {
  const main = setup(graph({ groups: [grp('group:ab', ['worker-a', 'worker-b'])] }));
  await v.renderGraphView(main, false);
  await click(main.nodes.find((n) => n.dataset.nodeId === 'worker-a'));
  assert.equal(vm.runInContext('wfState.selectedId', ctx), 'worker-a');
  assert.ok(main.html.includes('id="wf-detail"'));
  await click(main.toggles[0]);
  assert.equal(vm.runInContext('wfState.selectedId', ctx), null);
  assert.ok(!main.html.includes('id="wf-detail"'));
  delete ctx.document;
});

test('clicking a group card never selects it and a node outside the groups is still selected normally', async () => {
  const main = setup(graph({ groups: [grp('group:ab', ['worker-a'], { collapsed: true })] }));
  await v.renderGraphView(main, false);
  await click(main.nodes.find((n) => n.dataset.group === '1'));
  assert.equal(vm.runInContext('wfState.selectedId', ctx), null);
  await click(main.nodes.find((n) => n.dataset.nodeId === 'worker-c'));
  assert.equal(vm.runInContext('wfState.selectedId', ctx), 'worker-c');
  delete ctx.document;
});

test('the toggle helper flips the stored choice from the flag the group came with', () => {
  reset();
  vm.runInContext("wfState.graph = { nodes: [], edges: [], groups: [{ id: 'group:a', label: 'A', children: ['x'], collapsed: true }] }; wfState.shown = null;", ctx);
  const main = fakePage();
  ctx.document = { getElementById: () => main, activeElement: null };
  v.wfToggleGroup('group:a', main);
  assert.equal(vm.runInContext('wfState.toggles["group:a"]', ctx), false);
  v.wfToggleGroup('group:a', main);
  assert.equal(vm.runInContext('wfState.toggles["group:a"]', ctx), true);
  delete ctx.document;
});

test('index.html loads workflow-groups.js directly before workflow-node-panel.js and the files stay under 500 lines', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'templates', 'index.html'), 'utf8');
  const a = html.indexOf('/static/js/workflow-groups.js');
  const b = html.indexOf('/static/js/workflow-node-panel.js');
  assert.ok(a > 0 && a < b);
  assert.equal(html.slice(a, b).split('<script').length, 2);
  for (const f of ['workflow-groups.js', 'workflow-card-fit.js', 'workflow-graph-view.js']) assert.ok(read(f).split('\n').length < 500, f);
});

// ---- edge cases found by mutation checks ----

test('effectiveCollapsed only accepts a boolean choice', () => {
  const g = graph({ groups: [grp('group:a', ['worker-a'], { collapsed: false })] });
  for (const bad of ['yes', 1, 'true', {}, null]) assert.deepEqual([...v.effectiveCollapsed(g, { 'group:a': bad })], [], String(bad));
  assert.deepEqual([...v.effectiveCollapsed(g, { 'group:a': true })], ['group:a']);
});

test('collapseGraph accepts a plain array of ids and ignores ghost members when counting', () => {
  const g = graph({ groups: [grp('group:ab', ['worker-a', 'ghost'])] });
  const out = v.collapseGraph(g, ['group:ab']);
  const n = out.nodes.find((x) => x.id === 'group:ab');
  assert.equal(n.memberCount, 1);
  assert.deepEqual(ids(out), ['worker-b', 'worker-c', 'source:s', 'source:t', 'group:ab']);
});

test('nested groups three levels deep collapse into the outermost one only, and a nesting cycle still terminates', () => {
  const g = graph({ groups: [grp('group:top', ['group:mid']), grp('group:mid', ['group:low', 'worker-b']), grp('group:low', ['worker-a'])] });
  const out = v.collapseGraph(g, new Set(['group:top']));
  assert.deepEqual(plain(out.groups), []);
  assert.equal(out.nodes.filter((n) => n.kind === 'group').length, 1);
  assert.equal(out.nodes.find((n) => n.id === 'group:top').memberCount, 2);
  const cyc = graph({ groups: [grp('group:a', ['group:b', 'worker-a']), grp('group:b', ['group:a', 'worker-b'])] });
  const c = v.collapseGraph(cyc, new Set(['group:a']));
  assert.equal(c.nodes.find((n) => n.id === 'group:a').memberCount, 2);
  assert.deepEqual(v.groupBoxes(cyc, { 'worker-a': { x: 0, y: 0 }, 'worker-b': { x: 300, y: 0 } }, { w: 10, h: 10 }, 0).length, 4);
});

test('the aggregate status ignores services and sources and the counts ignore values that are not numbers', () => {
  const g = graph({ groups: [grp('group:x', ['worker-a', 'service:watchdog', 'source:s', 'source:t'])] });
  g.nodes.push(node('service:watchdog', 'service', 'error'));
  g.nodes.find((n) => n.id === 'source:s').counts = { pending: 'x', drafting: NaN };
  const n = v.collapseGraph(g, new Set(['group:x'])).nodes.find((x) => x.id === 'group:x');
  assert.equal(n.runtime.status, 'working');
  assert.deepEqual(plain(n.counts), { pending: 5, drafting: 0 });
});

test('the group node is sorted after the sources, the other nodes keep kind then id order, even when the input is unsorted', () => {
  const g = graph({ groups: [grp('group:x', ['worker-a'])] });
  g.nodes = [node('source:t', 'source', null), node('worker-c', 'loop', 'idle'), node('worker-a', 'loop', 'idle'), node('service:watchdog', 'service', 'idle'), node('stage:plan', 'stage', null)];
  g.edges = [];
  assert.deepEqual(ids(v.collapseGraph(g, new Set(['group:x']))), ['stage:plan', 'service:watchdog', 'worker-c', 'source:t', 'group:x']);
});

test('an expanded group lists the collapsed group that holds one of its nodes instead of the node', () => {
  const g = graph({ groups: [grp('group:keep', ['worker-a', 'worker-c']), grp('group:hide', ['worker-a', 'worker-b'])] });
  const out = v.collapseGraph(g, new Set(['group:hide']));
  assert.deepEqual(plain(out.groups.map((x) => [x.id, x.children])), [['group:keep', ['group:hide', 'worker-c']]]);
});

test('collapseGraph returns the graph when reading it throws', () => {
  const evil = { get nodes() { throw new Error('boom'); }, groups: [grp('g', ['x'])] };
  assert.equal(v.collapseGraph(evil, new Set(['g'])), evil);
});

test('the view shifts the canvas right when a box starts left of the layout, and widens it for a box that ends beyond it', () => {
  const g = graph({ groups: [grp('group:s', ['source:s'])] });
  const lay = v.layoutGraph(g, { nodeW: 272, nodeH: 128, gapX: 64, gapY: 16 });
  const html = v.buildGraphHtml(g, lay, { selectedId: null });
  assert.match(html, /<div class="wf-group-box" data-group-id="group:s" style="left:0px;top:0px;width:296px;height:180px">/);
  assert.match(html, /data-node-id="source:s" style="left:12px;top:40px;/);
  assert.match(html, /data-node-id="worker-a" style="left:348px;top:40px;/);
  const last = graph({ groups: [grp('group:last', ['worker-b'])] });
  const lastLay = v.layoutGraph(last, { nodeW: 272, nodeH: 128, gapX: 64, gapY: 16 });
  const lastHtml = v.buildGraphHtml(last, lastLay, { selectedId: null });
  const m = /<div class="wf-canvas" style="width:(\d+)px;height:(\d+)px">/.exec(lastHtml);
  assert.ok(Number(m[1]) >= lastLay.width + 12 - 0 && Number(m[1]) > lastLay.width, `width ${m[1]} vs ${lastLay.width}`);
  assert.ok(Number(m[2]) > lastLay.height, `height ${m[2]} vs ${lastLay.height}`);
  assert.ok(lastHtml.includes(`<svg class="wf-edges" width="${m[1]}" height="${m[2]}"`));
});

test('edge paths are shifted together with the nodes', () => {
  const g = graph({ groups: [grp('group:x', ['worker-a'])], edges: [edge('source:s', 'worker-a', 'claims')] });
  const lay = v.layoutGraph(g, { nodeW: 272, nodeH: 128, gapX: 64, gapY: 16 });
  const html = v.buildGraphHtml(g, lay, { selectedId: null });
  assert.ok(html.includes(' d="M272 104 L336 104"'), 'the claims edge starts at the shifted right middle of source:s (y 64 + 40)');
});

test('hiding the selected node in a collapsed group also drops the task state, and the header button stops the click from reaching the node', async () => {
  const main = setup(graph({ groups: [grp('group:ab', ['worker-a', 'worker-b'])] }));
  await v.renderGraphView(main, false);
  await click(main.nodes.find((n) => n.dataset.nodeId === 'worker-a'));
  assert.notEqual(vm.runInContext('wfState.tasks', ctx), null);
  let stopped = 0;
  main.toggles[0].onclick({ stopPropagation: () => { stopped += 1; } });
  await tick(); await tick();
  assert.equal(stopped, 1);
  assert.equal(vm.runInContext('wfState.tasks', ctx), null);
  assert.equal(vm.runInContext('wfState.selectedId', ctx), null);
  delete ctx.document;
});

test('the canvas grows downward when a box ends below the last row', () => {
  const g = { nodes: [node('worker-a', 'loop', 'idle'), node('worker-b', 'loop', 'idle')], edges: [], groups: [grp('group:b', ['worker-b'])], warnings: [] };
  const lay = v.layoutGraph(g, { nodeW: 272, nodeH: 128, gapX: 64, gapY: 16 });
  assert.equal(lay.height, 272);
  const html = v.buildGraphHtml(g, lay, { selectedId: null });
  assert.ok(html.includes('<div class="wf-canvas" style="width:296px;height:284px">'), html.slice(html.indexOf('wf-canvas'), html.indexOf('wf-canvas') + 80));
});

test('groupBoxes: members in one column share one box (part 0), members in two columns get one box per column, left to right', () => {
  const size = { w: 272, h: 128 };
  const one = v.groupBoxes(graph({ groups: [grp('group:g', ['worker-a', 'worker-b', 'worker-c'])] }), { 'worker-a': { x: 0, y: 0 }, 'worker-b': { x: 0, y: 144 }, 'worker-c': { x: 0, y: 288 } }, size, 12);
  assert.deepEqual(plain(one), [{ id: 'group:g', label: 'group:g', x: -12, y: -40, w: 296, h: 468, part: 0 }]);
  const two = v.groupBoxes(graph({ groups: [grp('group:g', ['worker-a', 'worker-b', 'worker-c'])] }), { 'worker-c': { x: 600, y: 0 }, 'worker-a': { x: 0, y: 0 }, 'worker-b': { x: 0, y: 144 } }, size, 12);
  assert.deepEqual(plain(two.map((b) => [b.part, b.x, b.y, b.w, b.h])), [[0, -12, -40, 296, 324], [1, 588, -40, 296, 180]]);
});

test('groupBoxes: a box covers none of the other cards of its column, nested members count, a collapsed or empty group has no box', () => {
  const size = { w: 272, h: 128 };
  const g = graph({ groups: [grp('group:out', ['group:in', 'worker-c']), grp('group:in', ['worker-a'])] });
  const pos = { 'worker-a': { x: 0, y: 0 }, 'worker-b': { x: 0, y: 144 }, 'worker-c': { x: 0, y: 288 } };
  const boxes = v.groupBoxes(g, pos, size, 12).filter((b) => b.id === 'group:out');
  assert.equal(boxes.length, 1);
  assert.ok(boxes[0].y <= pos['worker-a'].y - 12 - 28 && boxes[0].y + boxes[0].h >= pos['worker-c'].y + 128 + 12);
  assert.deepEqual(plain(v.groupBoxes(graph({ groups: [grp('group:none', ['nobody'])] }), pos, size, 12)), []);
  assert.deepEqual(plain(v.groupBoxes(graph({ groups: [grp('group:g', ['worker-a'])] }), {}, size, 12)), []);
});

test('the view draws one box and one header button per column of a group, and a click on the second button folds the group', async () => {
  const main = setup(graph({ groups: [grp('group:ab', ['worker-a', 'worker-b'], { label: '<i>AB</i>' })] }));
  await v.renderGraphView(main, false);
  assert.equal((main.html.match(/class="wf-group-box"/g) || []).length, 2);
  assert.equal(main.toggles.length, 2);
  assert.equal((main.html.match(/&lt;i&gt;AB&lt;\/i&gt;/g) || []).length, 2);
  assert.doesNotMatch(main.html, /<i>AB/);
  await click(main.toggles[1]);
  assert.ok(main.html.includes('data-group="1"') && !main.html.includes('wf-group-box'), 'folded from the second button');
  assert.equal(vm.runInContext('wfState.toggles["group:ab"]', ctx), true);
  delete ctx.document;
});

test('groupBoxes: boxes are numbered left to right whatever the order of the members, and bad input gives no boxes', () => {
  const size = { w: 272, h: 128 };
  const g = graph({ groups: [grp('group:g', ['worker-c', 'worker-b', 'worker-a'])] });
  const boxes = v.groupBoxes(g, { 'worker-a': { x: 0, y: 0 }, 'worker-b': { x: 300, y: 0 }, 'worker-c': { x: 600, y: 0 } }, size, 12);
  assert.deepEqual(plain(boxes.map((b) => [b.part, b.x])), [[0, -12], [1, 288], [2, 588]]);
  const trap = { get 'worker-a'() { throw new Error('boom'); } };
  assert.deepEqual(plain(v.groupBoxes(g, trap, size, 12)), []);
  assert.deepEqual(plain(v.groupBoxes({ groups: 'x' }, {}, size, 12)), []);
  assert.deepEqual(plain(v.groupBoxes(undefined, undefined, undefined)), []);
});

test('groupBoxes: a group without a label is boxed under its id', () => {
  const g = graph({ groups: [grp('group:nolabel', ['worker-a'], { label: '' }), grp('group:nolabel2', ['worker-a'], { label: undefined })] });
  const boxes = v.groupBoxes(g, { 'worker-a': { x: 0, y: 0 } }, { w: 272, h: 128 }, 12);
  assert.deepEqual(plain(boxes.map((b) => b.label)), ['group:nolabel', 'group:nolabel2']);
});

test("groupBoxes with direction 'down' draws one box per row, counted from the top; the default stays one box per column", () => {
  const { groupBoxes } = require(path.join(__dirname, '..', 'static', 'js', 'workflow-groups.js'));
  const graph = { groups: [{ id: 'group:a', label: 'A', children: ['x', 'y', 'z'] }] };
  const positions = { x: { x: 0, y: 0 }, y: { x: 300, y: 0 }, z: { x: 0, y: 130 } };
  const size = { w: 272, h: 128 };
  const down = groupBoxes(graph, positions, size, 12, 'down');
  assert.equal(down.length, 2);
  assert.deepEqual(down.map((b) => b.part), [0, 1]);
  assert.deepEqual(down[0], { id: 'group:a', label: 'A', x: -12, y: -40, w: 596, h: 180, part: 0 });
  assert.deepEqual(down[1], { id: 'group:a', label: 'A', x: -12, y: 90, w: 296, h: 180, part: 1 });
  const cols = groupBoxes(graph, positions, size, 12);
  assert.equal(cols.length, 2);
  assert.deepEqual(cols[0], { id: 'group:a', label: 'A', x: -12, y: -40, w: 296, h: 310, part: 0 });
  assert.deepEqual(groupBoxes(graph, positions, size, 12, 'sideways'), cols);
});

// ---- collapseLoopSources (graph readability pass 2): a big loop's sources become one group card ----
const srcN = (i) => node('source:s' + String(i).padStart(2, '0'), 'source', null, { counts: { pending: i % 3, drafting: 1 } });
const bigLoop = (n, groups) => {
  const sources = Array.from({ length: n }, (_, i) => srcN(i));
  return {
    id: 'worker-1', label: 'ornith:35b',
    graph: {
      nodes: [...sources, node('worker-1', 'loop', 'working'), node('reviewer', 'loop', 'idle'), node('service:apply-loop', 'service')],
      edges: [...sources.map((s) => edge(s.id, 'worker-1', 'claims')), edge('worker-1', 'reviewer', 'reviews'), edge('reviewer', 'service:apply-loop', 'applies')],
      groups: groups || [], warnings: [],
    },
  };
};

test('more than six sources become ONE group card with the summed counts and re-pointed edges', () => {
  const r = v.collapseLoopSources(bigLoop(7), 6, false);
  assert.equal(r.collapsed, true);
  assert.equal(r.collapsible, true);
  assert.equal(r.count, 7);
  assert.equal(r.groupId, 'group:sources:worker-1');
  assert.deepEqual(plain(r.graph.nodes.map((n) => n.id).sort()), ['group:sources:worker-1', 'reviewer', 'service:apply-loop', 'worker-1']);
  const g = r.graph.nodes.find((n) => n.id === 'group:sources:worker-1');
  assert.equal(g.kind, 'group');
  assert.equal(g.label, '7 sources');
  assert.equal(g.memberCount, 7);
  assert.equal(g.counts.drafting, 7);
  assert.equal(g.counts.pending, [0, 1, 2, 0, 1, 2, 0].reduce((a, b) => a + b, 0));
  const claims = r.graph.edges.filter((e) => e.kind === 'claims');
  assert.deepEqual(plain(claims.map((e) => [e.from, e.to])), [['group:sources:worker-1', 'worker-1']], 'seven edges became one');
  assert.equal(r.graph.edges.length, 3);
});

test('six sources or fewer are left exactly as they are', () => {
  const loop = bigLoop(6);
  const r = v.collapseLoopSources(loop, 6, false);
  assert.equal(r.collapsed, false);
  assert.equal(r.collapsible, false);
  assert.equal(r.count, 6);
  assert.equal(r.graph, loop.graph, 'the same graph object comes back');
  assert.equal(v.collapseLoopSources(bigLoop(0), 6, false).count, 0);
});

test('expanded keeps every source, and the loop stays collapsible so the card can offer Hide', () => {
  const loop = bigLoop(9);
  const r = v.collapseLoopSources(loop, 6, true);
  assert.equal(r.collapsed, false);
  assert.equal(r.collapsible, true);
  assert.equal(r.graph, loop.graph);
  assert.equal(r.count, 9);
  assert.equal(r.groupId, null);
});

test('authored groups lose the collapsed sources and are dropped when nothing else is left in them', () => {
  const loop = bigLoop(8, [
    grp('group:intake', Array.from({ length: 8 }, (_, i) => 'source:s' + String(i).padStart(2, '0'))),
    grp('group:mixed', ['source:s00', 'worker-1', 'reviewer']),
    grp('group:gpu', ['worker-1']),
  ]);
  const r = v.collapseLoopSources(loop, 6, false);
  const ids = plain(r.graph.groups.map((x) => x.id));
  assert.deepEqual(ids, ['group:mixed', 'group:gpu'], 'the all-source group is gone; the sources group is a node now, not a box');
  assert.ok(r.graph.nodes.some((n) => n.id === 'group:sources:worker-1' && n.kind === 'group'));
  assert.deepEqual(plain(r.graph.groups.find((x) => x.id === 'group:mixed').children), ['worker-1', 'reviewer']);
});

test('collapseLoopSources does not mutate its input and a bad max falls back to six', () => {
  const loop = bigLoop(8, [grp('group:intake', ['source:s00', 'source:s01'])]);
  const copy = JSON.parse(JSON.stringify(loop));
  v.collapseLoopSources(loop, 6, false);
  assert.deepEqual(JSON.parse(JSON.stringify(loop)), copy);
  [0, -1, 1.5, NaN, undefined, null, 'x'].forEach((bad) => {
    assert.equal(v.collapseLoopSources(bigLoop(7), bad, false).collapsed, true, String(bad));
    assert.equal(v.collapseLoopSources(bigLoop(6), bad, false).collapsed, false, String(bad));
  });
  assert.equal(v.collapseLoopSources(bigLoop(3), 2, false).collapsed, true, 'a smaller max is honoured');
});

test('collapseLoopSources never throws on garbage', () => {
  [null, undefined, {}, { graph: null }, { graph: { nodes: 'x' } }, { id: 'a', graph: { nodes: [null, 3, { id: 7 }] } }].forEach((x) => {
    const r = v.collapseLoopSources(x, 6, false);
    assert.equal(r.collapsed, false);
    assert.equal(r.collapsible, false);
  });
  assert.equal(v.collapseLoopSources({ id: 'a', graph: { nodes: [null, 3, { id: 7 }, { id: 'source:x', kind: 'source' }], edges: [] } }, 6, false).count, 1);
});
