// Node tests for the Graph node panel controls (HUB0325 piece W-B3).
// The real scripts are loaded into one bare vm context in the order index.html loads them; fetch and the page are fakes, so no route is ever called.
// Run: node --test python/dashboard/tests/test_workflow_node_panel.js

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
for (const f of ['worker-status-helpers.js', 'worker-switch-ui.js', 'worker-model-select.js', 'worker-task-picker.js', 'workflow-layout.js', 'workflow-node-panel.js', 'workflow-card-fit.js', 'workflow-graph-view.js']) {
  vm.runInContext(read(f), ctx, { filename: f });
}
const v = ctx;

const rt = (over) => ({ instanceId: 'worker-3090', status: 'working', stale: false, disabled: false, switchable: true, pid: 4242, currentTaskId: 'task-1', currentPass: 'plan', stateAgeSeconds: 125, hub: null, projectLabel: null, borrowed: false, ...over });
const model = (over) => ({ name: 'ornith:35b', provider: 'local', tierB: 35, overridden: false, choices: { local: ['a:1', 'ornith:35b'], cloud: ['claude-haiku-5-5'] }, ...over });
const loop = (over) => ({ id: 'worker-3090', kind: 'loop', label: 'worker-3090', parent: null, runtime: rt(), model: model(), work: { taskClasses: null, preempt: 'always', reviewer: false }, counts: null, ...over });
const source = { id: 'source:hygiene', kind: 'source', label: 'hygiene', parent: null, runtime: null, model: null, work: null, counts: { pending: 3, drafting: 1 } };
const stage = { id: 'stage:plan', kind: 'stage', label: 'plan', parent: null, runtime: null, model: null, work: null, counts: { pending: 0, drafting: 0 } };
const service = { id: 'service:watchdog', kind: 'service', label: 'watchdog', parent: null, runtime: rt({ instanceId: 'watchdog', switchable: false }), model: null, work: null, counts: null };

const NOTES = {
  local: "A model change applies on this lane's next tick (about 30 seconds). Provider, endpoint and task classes come from lanes.json and need a pipeline restart.",
  cloud: 'The cloud model is chosen by the gateway, not by this dashboard. Provider and endpoint come from lanes.json and need a pipeline restart.',
  script: 'A script lane runs no model. Its settings come from lanes.json and need a pipeline restart.',
};
const count = (text, part) => text.split(part).length - 1;

test('a local loop panel has the facts, the switch, the model select and the local note', () => {
  const html = v.buildNodePanelHtml(loop(), []);
  assert.match(html, /^<div class="wf-detail" id="wf-detail">/);
  assert.match(html, /worker-switch-btn/);
  assert.match(html, /<select class="worker-model-select" data-instance-id="worker-3090"/);
  assert.match(html, /<option value="a:1" >a:1<\/option><option value="ornith:35b" >ornith:35b<\/option>/);
  assert.equal(count(html, NOTES.local.replace(/'/g, '&#39;')), 1);
  assert.match(html, /<dt>Node<\/dt><dd>worker-3090<\/dd>/);
  assert.match(html, /<dt>Provider<\/dt><dd>local<\/dd>/);
  assert.match(html, /id="wf-runlog"/);
});

test('an overridden model is the selected option, a not overridden one is not', () => {
  assert.match(v.buildNodePanelHtml(loop({ model: model({ overridden: true }) }), []), /<option value="ornith:35b" selected>ornith:35b<\/option>/);
  assert.doesNotMatch(v.buildNodePanelHtml(loop(), []), / selected>/);
});

test('the switch shows only when the runtime is switchable', () => {
  assert.doesNotMatch(v.buildNodePanelHtml(loop({ runtime: rt({ switchable: false }) }), []), /worker-switch-btn/);
  assert.match(v.buildNodePanelHtml(loop({ runtime: rt({ disabled: true }) }), []), /Turn on/);
});

test('a cloud loop shows the gateway text and no select, a script loop neither', () => {
  const cloud = v.buildNodePanelHtml(loop({ id: 'worker-cloud', model: model({ provider: 'cloud', name: 'claude-haiku-5-5' }) }), []);
  assert.match(cloud, /cloud model set by the gateway: claude-haiku-5-5/);
  assert.doesNotMatch(cloud, /<select|<option/);
  assert.equal(count(cloud, NOTES.cloud), 1);
  const script = v.buildNodePanelHtml(loop({ id: 'worker-uiconf', model: model({ provider: 'script', name: null }) }), []);
  assert.match(script, /script lane, no model/);
  assert.doesNotMatch(script, /<select|<option/);
  assert.equal(count(script, NOTES.script), 1);
});

test('each note appears exactly once and only for its own provider', () => {
  for (const provider of ['local', 'cloud', 'script']) {
    const html = v.buildNodePanelHtml(loop({ model: model({ provider }) }), []);
    for (const other of ['local', 'cloud', 'script']) {
      assert.equal(count(html, NOTES[other].replace(/'/g, '&#39;')), other === provider ? 1 : 0, `${provider} panel, ${other} note`);
    }
  }
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(WF_APPLY_NOTES)', ctx)), NOTES);
});

test('source, stage and service nodes keep the read-only panel with their facts and no controls', () => {
  for (const node of [source, stage, service]) {
    assert.equal(v.buildNodePanelHtml(node, []), '', node.id);
    const g = { nodes: [node], edges: [], warnings: [] };
    const html = v.buildGraphHtml(g, v.layoutGraph(g), { selectedId: node.id });
    assert.match(html, /id="wf-detail"/);
    assert.match(html, new RegExp(`<dt>Node</dt><dd>${node.id}</dd>`));
    assert.doesNotMatch(html, /wf-controls|worker-model-select|worker-switch-btn/);
  }
  assert.equal(v.buildNodePanelHtml(null, []), '');
  assert.equal(v.buildNodePanelHtml(loop({ model: null }), []), '');
  assert.equal(v.buildNodePanelHtml(loop({ runtime: null }), []), '');
});

test('the graph draws the panel for a selected loop node and the read-only one otherwise', () => {
  const g = { nodes: [loop(), source], edges: [], warnings: ['lanes: boom'] };
  const lay = v.layoutGraph(g);
  const withPanel = v.buildGraphHtml(g, lay, { selectedId: 'worker-3090' });
  assert.equal(count(withPanel, 'class="wf-controls"'), 1);
  assert.match(withPanel, /<li>lanes: boom<\/li>/);
  assert.equal(count(v.buildGraphHtml(g, lay, { selectedId: null }), 'wf-controls'), 0);
});

test('every interpolated value of the panel is escaped', () => {
  const evil = '<b>"x"&\'';
  const html = v.buildNodePanelHtml(loop({ id: 'w"1', label: evil, model: model({ name: evil, choices: { local: [evil], cloud: [] } }), runtime: rt({ instanceId: 'w"1', projectLabel: evil }) }), [evil]);
  assert.doesNotMatch(html, /<b>[^"]*<\/(span|dd|li|option)>/);
  assert.match(html, /data-instance-id="w&quot;1"/);
  assert.match(html, />&lt;b&gt;&quot;x&quot;&amp;&#39;<\/option>/);
});

function fakeRoot(selects) {
  return { querySelectorAll: (sel) => (sel === '#wf-detail .worker-model-select' ? selects : []) };
}

test('choosing a model calls setModel with the instance and the value, then refresh, and does not propagate the click', async () => {
  const calls = [];
  const sel = { dataset: { instanceId: 'worker-3090' }, value: 'a:1' };
  v.wireNodePanel(fakeRoot([sel]), { setModel: async (id, m) => { calls.push(['set', id, m]); }, refresh: async () => { calls.push(['refresh']); } });
  let stopped = 0;
  sel.onclick({ stopPropagation: () => { stopped += 1; } });
  await sel.onchange({ stopPropagation: () => { stopped += 1; } });
  assert.deepEqual(calls, [['set', 'worker-3090', 'a:1'], ['refresh']]);
  assert.equal(stopped, 2);
  sel.value = '';
  await sel.onchange({ stopPropagation() {} });
  assert.deepEqual(calls.slice(2), [['set', 'worker-3090', ''], ['refresh']]);
});

test('the default setModel makes one POST to the existing route and an empty value clears the override', async () => {
  const seen = [];
  ctx.fetch = async (url, opts) => { seen.push([url, opts.method, opts.headers['Content-Type'], opts.body]); return { ok: true }; };
  await v.wfSetModelDefault('worker-3090', 'a:1');
  await v.wfSetModelDefault('worker/x', '');
  delete ctx.fetch;
  assert.deepEqual(seen, [
    ['/api/worker-models/worker-3090', 'POST', 'application/json', '{"model":"a:1"}'],
    ['/api/worker-models/worker%2Fx', 'POST', 'application/json', '{"model":""}'],
  ]);
});

test('wireNodePanel with default deps uses the real setModel and the global renderWorkers', async () => {
  const seen = [];
  ctx.fetch = async (url, opts) => { seen.push(url + ' ' + opts.body); return { ok: true }; };
  let rendered = 0;
  ctx.renderWorkers = async () => { rendered += 1; };
  const sel = { dataset: { instanceId: 'worker-3090' }, value: 'a:1' };
  v.wireNodePanel(fakeRoot([sel]));
  await sel.onchange({ stopPropagation() {} });
  delete ctx.fetch;
  delete ctx.renderWorkers;
  assert.deepEqual(seen, ['/api/worker-models/worker-3090 {"model":"a:1"}']);
  assert.equal(rendered, 1);
});

test('a poll does not redraw while a model dropdown has focus, a non-poll render does', async () => {
  let fetched = 0;
  const graph = { schemaVersion: 1, nodes: [loop()], edges: [], warnings: [] };
  ctx.fetchJson = async () => { fetched += 1; return JSON.parse(JSON.stringify(graph)); };
  ctx.renderStaleCheck = () => () => false;
  const main = { writes: 0, html: '', querySelector: () => null, querySelectorAll: () => [], contains: () => true };
  Object.defineProperty(main, 'innerHTML', { get() { return main.html; }, set(x) { main.html = x; main.writes += 1; } });
  ctx.document = { activeElement: { classList: { contains: (c) => c === 'worker-model-select' } } };
  await v.renderGraphView(main, true);
  assert.equal(fetched, 0);
  assert.equal(main.writes, 0);
  await v.renderGraphView(main, false);
  assert.equal(main.writes, 1);
  ctx.document = { activeElement: { classList: { contains: () => false } } };
  await v.renderGraphView(main, true);
  assert.equal(fetched, 2);
  delete ctx.document;
});

test('the graph signature changes when a model override flips, so a poll redraws the select', () => {
  const g = { nodes: [loop()], edges: [], warnings: [] };
  const h = { nodes: [loop({ model: model({ overridden: true }) })], edges: [], warnings: [] };
  assert.notEqual(v.graphSignature(g), v.graphSignature(h));
});

test('index.html loads the panel script directly before the view script and the view file stays under 500 lines', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'templates', 'index.html'), 'utf8');
  const a = html.indexOf('/static/js/workflow-node-panel.js');
  const b = html.indexOf('/static/js/workflow-graph-view.js');
  assert.ok(a > 0 && a < b);
  assert.equal(html.slice(a, b).split('<script').length, 2);
  assert.ok(read('workflow-graph-view.js').split('\n').length < 500);
  assert.ok(read('workflow-node-panel.js').split('\n').length < 500);
});

test('an unknown provider gets the local note, and empty control rows are never written', () => {
  const odd = v.buildNodePanelHtml(loop({ model: model({ provider: 'mystery' }) }), []);
  assert.equal(count(odd, NOTES.local.replace(/'/g, '&#39;')), 1);
  // a switchable local worker loop: one row each for the switch, the select and the task pick; not switchable: no switch row
  assert.equal(count(v.buildNodePanelHtml(loop(), []), 'class="wf-control-row"'), 3);
  assert.equal(count(v.buildNodePanelHtml(loop({ runtime: rt({ switchable: false }) }), []), 'class="wf-control-row"'), 2);
  // an instance with no model control at all (the watchdog id) has a switch row only
  assert.equal(count(v.buildNodePanelHtml(loop({ id: 'watchdog', runtime: rt({ instanceId: 'watchdog' }) }), []), 'class="wf-control-row"'), 1);
});

test('only loop nodes with a runtime and a model get controls', () => {
  assert.equal(v.buildNodePanelHtml(loop({ kind: 'service' }), []), '');
  assert.equal(v.buildNodePanelHtml(loop({ kind: 'source' }), []), '');
  assert.equal(v.buildNodeControlsHtml(loop({ model: null })), '');
  assert.equal(v.buildNodeControlsHtml(loop({ runtime: null })), '');
  assert.equal(v.buildNodeControlsHtml(null), '');
});

test('drawing the graph wires the panel once', async () => {
  const wired = [];
  const real = ctx.wireNodePanel;
  ctx.wireNodePanel = (root, deps) => { wired.push([root === main, deps]); };
  ctx.fetchJson = async () => ({ schemaVersion: 1, nodes: [loop()], edges: [], warnings: [] });
  ctx.renderStaleCheck = () => () => false;
  const main = { html: '', querySelector: () => null, querySelectorAll: () => [], contains: () => true };
  Object.defineProperty(main, 'innerHTML', { get() { return main.html; }, set(x) { main.html = x; } });
  await v.renderGraphView(main, false);
  ctx.wireNodePanel = real;
  assert.equal(wired.length, 1);
  assert.equal(wired[0][0], true);
});

test('a failed poll keeps the graph that is drawn, a failed first render shows the message', async () => {
  let fail = false;
  ctx.fetchJson = async () => { if (fail) throw new Error('timeout'); return { schemaVersion: 1, nodes: [loop()], edges: [], warnings: [] }; };
  ctx.renderStaleCheck = () => () => false;
  const main = { writes: 0, html: '', querySelectorAll: () => [], contains: () => true };
  main.querySelector = (sel) => (sel === '#wf-surface' && main.html.includes('id="wf-surface"') ? {} : null);
  Object.defineProperty(main, 'innerHTML', { get() { return main.html; }, set(x) { main.html = x; main.writes += 1; } });
  await v.renderGraphView(main, false);
  const drawn = main.html;
  fail = true;
  await v.renderGraphView(main, true);
  assert.equal(main.html, drawn);
  assert.equal(main.writes, 1);
  await v.renderGraphView(main, false);
  assert.match(main.html, /The workflow graph is unavailable: timeout\./);
  fail = true;
  const blank = { writes: 0, html: '', querySelector: () => null, querySelectorAll: () => [], contains: () => true };
  Object.defineProperty(blank, 'innerHTML', { get() { return blank.html; }, set(x) { blank.html = x; blank.writes += 1; } });
  await v.renderGraphView(blank, true);
  assert.match(blank.html, /unavailable/);
});

// ---- task pin (piece W-B4b) ----

const tick = () => new Promise((r) => setImmediate(r));
const resetView = () => vm.runInContext('wfState.selectedId = null; wfState.tasks = null; wfState.signature = null; wfState.graph = null;', ctx);
const ITEMS = [
  { id: 't1', title: 'First', source: 'adhoc', location: 'pending' },
  { id: 't2', title: 'Second', source: 'adhoc', location: 'drafting:worker-p40' },
  { id: 't3', title: 'Third', source: 'research', location: 'pending' },
];
const reviewerNode = loop({ id: 'reviewer', label: 'reviewer', runtime: rt({ instanceId: 'reviewer' }) });
const PICK_GRAPH = () => ({ schemaVersion: 1, nodes: [loop(), reviewerNode, source], edges: [], warnings: [] });

function fakePage() {
  const main = { html: '', writes: 0, slot: { innerHTML: '' }, nodes: [] };
  Object.defineProperty(main, 'innerHTML', {
    get() { return main.html; },
    set(x) {
      main.html = x; main.writes += 1;
      const m = /<div id="wf-taskpick" class="wf-taskpick">(.*?)<\/div><\/div>/.exec(x);
      main.slot.innerHTML = m ? m[1] : '';
      main.nodes = [...x.matchAll(/data-node-id="([^"]+)"/g)].map((mm) => ({ dataset: { nodeId: mm[1] }, onclick: null }));
    },
  });
  main.querySelector = (sel) => (sel === '#wf-surface' ? (main.html.includes('id="wf-surface"') ? {} : null) : sel === '#wf-taskpick' ? (main.html.includes('id="wf-taskpick"') ? main.slot : null) : null);
  main.querySelectorAll = (sel) => (sel === '.wf-node' ? main.nodes : []);
  main.contains = () => true;
  return main;
}

function setupPage(responder) {
  resetView();
  const urls = [];
  ctx.fetchJson = async (url) => { urls.push(url); return responder(url); };
  ctx.renderStaleCheck = () => () => false;
  const main = fakePage();
  ctx.document = { getElementById: () => main, activeElement: null };
  return { main, urls };
}
const clickNode = async (main, id) => { main.nodes.find((n) => n.dataset.nodeId === id).onclick(); await tick(); await tick(); };

test('only a worker loop node has the task-pick slot', () => {
  assert.equal(v.isTaskPinNode(loop()), true);
  for (const node of [reviewerNode, source, stage, service, loop({ kind: 'service' }), loop({ runtime: null }), null]) assert.equal(v.isTaskPinNode(node), false);
  assert.match(v.buildNodePanelHtml(loop(), []), /<div id="wf-taskpick" class="wf-taskpick"><span class="meta">Loading tasks…<\/span><\/div>/);
  assert.doesNotMatch(v.buildNodePanelHtml(reviewerNode, []), /wf-taskpick|worker-type-select/);
  for (const node of [source, stage, service]) assert.doesNotMatch(v.buildGraphHtml({ nodes: [node], edges: [], warnings: [] }, v.layoutGraph({ nodes: [node], edges: [] }), { selectedId: node.id }), /wf-taskpick/);
});

test('the slot shows the type select with counts, the unavailable text and the loading text', () => {
  const withItems = v.buildNodePanelHtml(loop(), [], { id: 'worker-3090', items: ITEMS, type: '', error: false });
  assert.match(withItems, /<option value="adhoc" >adhoc \(2\)<\/option><option value="research" >research \(1\)<\/option>/);
  assert.doesNotMatch(withItems, /worker-task-select/);
  const failed = v.buildNodePanelHtml(loop(), [], { id: 'worker-3090', items: null, type: '', error: true });
  assert.match(failed, /Task list unavailable\./);
  assert.match(failed, /<select class="worker-model-select"/, 'the model control is still there');
  assert.doesNotMatch(failed, /worker-type-select/);
  const chosen = v.buildNodePanelHtml(loop(), [], { id: 'worker-3090', items: ITEMS, type: 'adhoc', error: false });
  assert.match(chosen, /<option value="adhoc" selected>adhoc \(2\)<\/option>/);
  assert.match(chosen, /<select class="worker-task-select"/);
  assert.match(chosen, /data-source-lane="worker-p40"/);
});

test('selecting a worker node fetches its tasks once, shows the picker, keeps the chosen type when the bucket is empty on the next fetch', async () => {
  const responses = [{ items: ITEMS }, { items: [ITEMS[2]] }];
  const { main, urls } = setupPage((url) => (url.includes('assignable-tasks') ? responses.shift() : PICK_GRAPH()));
  ctx.fetchJson = async (url) => { urls.push(url); return url === '/api/workflow-graph' ? PICK_GRAPH() : responses.shift(); };
  await v.renderGraphView(main, false);
  assert.deepEqual(urls, ['/api/workflow-graph']);
  await clickNode(main, 'worker-3090');
  assert.deepEqual(urls, ['/api/workflow-graph', '/api/instances/worker-3090/assignable-tasks']);
  assert.match(main.slot.innerHTML, /adhoc \(2\)/);
  v.wfSetTaskType('worker-3090', 'adhoc');
  assert.match(main.slot.innerHTML, /<option value="adhoc" selected>adhoc \(2\)<\/option>/);
  assert.match(main.slot.innerHTML, /\(choose a adhoc task…\)/);
  await v.renderGraphView(main, false); // the next redraw refetches; this time the adhoc bucket is empty
  await tick(); await tick();
  assert.match(main.slot.innerHTML, /<option value="adhoc" selected>adhoc \(0\)<\/option>/);
  assert.match(main.slot.innerHTML, /\(no adhoc tasks right now\)/);
  delete ctx.document;
});

test('a task list that fails to load shows the unavailable text and the model control stays', async () => {
  const { main } = setupPage(() => PICK_GRAPH());
  ctx.fetchJson = async (url) => { if (url.includes('assignable-tasks')) throw new Error('boom'); return PICK_GRAPH(); };
  await v.renderGraphView(main, false);
  await clickNode(main, 'worker-3090');
  assert.match(main.slot.innerHTML, /Task list unavailable\./);
  assert.match(main.html, /worker-model-select/);
  delete ctx.document;
});

test('selecting a reviewer node fetches no tasks and clears the task state', async () => {
  const { main, urls } = setupPage(() => ({ items: ITEMS }));
  ctx.fetchJson = async (url) => { urls.push(url); return url === '/api/workflow-graph' ? PICK_GRAPH() : { items: ITEMS }; };
  await v.renderGraphView(main, false);
  await clickNode(main, 'worker-3090');
  assert.equal(urls.filter((u) => u.includes('assignable')).length, 1);
  assert.equal(vm.runInContext('wfState.tasks && wfState.tasks.id', ctx), 'worker-3090');
  await clickNode(main, 'reviewer');
  assert.equal(urls.filter((u) => u.includes('assignable')).length, 1);
  assert.equal(vm.runInContext('wfState.tasks', ctx), null);
  assert.doesNotMatch(main.html, /wf-taskpick/);
  delete ctx.document;
});

test('the type select stores the type through setType and the task select calls setTask and resets itself', async () => {
  const calls = [];
  const typeSel = { dataset: { instanceId: 'worker-3090' }, value: 'adhoc' };
  const taskSel = { dataset: { instanceId: 'worker-3090' }, value: 't2', selectedOptions: [{ dataset: { title: 'Second', sourceLane: 'worker-p40' } }] };
  const root = { querySelectorAll: (sel) => (sel === '#wf-detail .worker-type-select' ? [typeSel] : sel === '#wf-detail .worker-task-select' ? [taskSel] : []) };
  v.wireNodePanel(root, { setType: (id, t) => calls.push(['type', id, t]), setTask: async (...a) => { calls.push(['task', ...a, 'value-during:' + taskSel.value]); } });
  let stopped = 0;
  const ev = { stopPropagation: () => { stopped += 1; } };
  typeSel.onclick(ev); taskSel.onclick(ev);
  typeSel.onchange(ev);
  await taskSel.onchange(ev);
  assert.deepEqual(calls, [['type', 'worker-3090', 'adhoc'], ['task', 'worker-3090', 't2', 'Second', 'worker-p40', 'value-during:']]);
  assert.equal(stopped, 4);
  taskSel.value = 't1'; taskSel.selectedOptions = [{ dataset: { title: 'First', sourceLane: '' } }];
  await taskSel.onchange(ev);
  assert.deepEqual(calls[2], ['task', 'worker-3090', 't1', 'First', null, 'value-during:']);
  taskSel.value = 't1'; taskSel.selectedOptions = [];
  await taskSel.onchange(ev);
  assert.deepEqual(calls[3].slice(0, 5), ['task', 'worker-3090', 't1', undefined, null]);
});

test('with default deps the task select goes through the global setWorkerTask and the type select through wfSetTaskType', async () => {
  const seen = [];
  const realSet = ctx.setWorkerTask;
  ctx.setWorkerTask = async (...a) => { seen.push(a); };
  resetView();
  const taskSel = { dataset: { instanceId: 'worker-3090' }, value: 't1', selectedOptions: [{ dataset: { title: 'First', sourceLane: '' } }] };
  const typeSel = { dataset: { instanceId: 'worker-3090' }, value: 'adhoc' };
  const root = { querySelectorAll: (sel) => (sel === '#wf-detail .worker-type-select' ? [typeSel] : sel === '#wf-detail .worker-task-select' ? [taskSel] : []) };
  v.wireNodePanel(root);
  await taskSel.onchange({ stopPropagation() {} });
  ctx.setWorkerTask = realSet;
  assert.deepEqual(seen, [['worker-3090', 't1', 'First', null]]);
  vm.runInContext("wfState.tasks = { id: 'worker-3090', items: [], type: '', error: false };", ctx);
  ctx.document = { getElementById: () => ({ querySelector: () => null, querySelectorAll: () => [] }), activeElement: null };
  typeSel.onchange({ stopPropagation() {} });
  delete ctx.document;
  assert.equal(vm.runInContext('wfState.tasks.type', ctx), 'adhoc');
});

test('a poll does not redraw while a type or task select has focus', async () => {
  for (const cls of ['worker-type-select', 'worker-task-select']) {
    const { main, urls } = setupPage(() => PICK_GRAPH());
    ctx.document = { getElementById: () => main, activeElement: { classList: { contains: (c) => c === cls } } };
    await v.renderGraphView(main, true);
    assert.equal(urls.length, 0, cls);
    assert.equal(main.writes, 0, cls);
    delete ctx.document;
  }
});

test('the worker prefix is exact, the picker carries the node id, and the graph passes the task state to the panel', () => {
  assert.equal(v.isTaskPinNode(loop({ id: 'workflow-x' })), false);
  assert.equal(v.isTaskPinNode(loop({ id: 'worker' })), true);
  const html = v.buildNodePanelHtml(loop(), [], { id: 'worker-3090', items: ITEMS, type: 'adhoc', error: false });
  assert.match(html, /<select class="worker-type-select" data-instance-id="worker-3090"/);
  assert.match(html, /<select class="worker-task-select" data-instance-id="worker-3090"/);
  const g = { nodes: [loop()], edges: [], warnings: [] };
  const drawn = v.buildGraphHtml(g, v.layoutGraph(g), { selectedId: 'worker-3090', tasks: { id: 'worker-3090', items: ITEMS, type: '', error: false } });
  assert.match(drawn, /adhoc \(2\)/);
});

test('the task list URL is encoded', async () => {
  const odd = loop({ id: 'worker/x', runtime: rt({ instanceId: 'worker/x' }) });
  const urls = [];
  resetView();
  ctx.fetchJson = async (url) => { urls.push(url); return url === '/api/workflow-graph' ? { schemaVersion: 1, nodes: [odd], edges: [], warnings: [] } : { items: [] }; };
  ctx.renderStaleCheck = () => () => false;
  const main = fakePage();
  ctx.document = { getElementById: () => main, activeElement: null };
  await v.renderGraphView(main, false);
  await clickNode(main, 'worker/x');
  assert.ok(urls.includes('/api/instances/worker%2Fx/assignable-tasks'), urls.join(' '));
  delete ctx.document;
});

test('a task list that arrives after the selection moved on is dropped', async () => {
  resetView();
  let release;
  const gate = new Promise((r) => { release = r; });
  ctx.fetchJson = async (url) => { if (url === '/api/workflow-graph') return PICK_GRAPH(); await gate; return { items: ITEMS }; };
  ctx.renderStaleCheck = () => () => false;
  const main = fakePage();
  ctx.document = { getElementById: () => main, activeElement: null };
  await v.renderGraphView(main, false);
  await clickNode(main, 'worker-3090'); // starts the slow fetch
  await clickNode(main, 'reviewer'); // the selection moves on
  release();
  await tick(); await tick();
  assert.equal(vm.runInContext('wfState.tasks', ctx), null);
  assert.doesNotMatch(main.html, /wf-taskpick/);
  delete ctx.document;
});

test('tasks of another node are not drawn in this node\'s slot, and a type for another node is not stored', () => {
  resetView();
  vm.runInContext("wfState.graph = { nodes: [{ id: 'worker-3090', kind: 'loop', runtime: {}, model: {} }] }; wfState.selectedId = 'worker-3090'; wfState.tasks = { id: 'worker-p40', items: [], type: '', error: false };", ctx);
  const main = fakePage();
  main.html = '<div id="wf-taskpick" class="wf-taskpick"></div>';
  const asked = [];
  main.querySelectorAll = (sel) => { asked.push(sel); return []; };
  vm.runInContext('wfRedrawTaskSlot', ctx)(main);
  assert.match(main.slot.innerHTML, /Loading tasks…/);
  assert.ok(asked.includes('#wf-detail .worker-type-select') && asked.includes('#wf-detail .worker-task-select'), 'the slot is wired again after a redraw');
  ctx.document = { getElementById: () => main, activeElement: null };
  v.wfSetTaskType('worker-3090', 'adhoc');
  delete ctx.document;
  assert.equal(vm.runInContext('wfState.tasks.type', ctx), '');
});

// ---- the flat priority line of a source node (HUB0329 piece W-D5) ----

const ORDER = [
  { name: 'first', priority: 1, rank: 1 }, { name: 'hygiene', priority: 40, rank: 2 }, { name: 'twin', priority: 40, rank: 2 },
  { name: 'trio-a', priority: 70, rank: 4 }, { name: 'trio-b', priority: 70, rank: 4 }, { name: 'trio-c', priority: 70, rank: 4 },
];
const srcNode = (name) => ({ ...source, id: 'source:' + name, label: name });

test('a source with an entry shows its flat priority, rank and the number of sources, and one other source sharing the priority', () => {
  const html = v.buildNodePanelHtml(source, [], null, ORDER);
  assert.match(html, /^<div class="wf-detail" id="wf-detail">/);
  assert.equal(count(html, '<div class="meta wf-priority">Flat priority 40 · rank 2 of 6 · 1 other source(s) share this priority</div>'), 1);
  assert.match(html, /<dt>Pending<\/dt><dd>3<\/dd>/);
  assert.doesNotMatch(html, /wf-controls|worker-switch-btn|wf-runlog/);
});

test('three sources sharing a priority say 2 others, a source alone at its priority has no sharing sentence', () => {
  assert.match(v.buildNodePanelHtml(srcNode('trio-b'), [], null, ORDER), /Flat priority 70 · rank 4 of 6 · 2 other source\(s\) share this priority<\/div>/);
  const alone = v.buildNodePanelHtml(srcNode('first'), [], null, ORDER);
  assert.match(alone, /Flat priority 1 · rank 1 of 6<\/div>/);
  assert.doesNotMatch(alone, /share this priority/);
});

test('a source without an entry, or without a usable priority order, keeps the read-only panel', () => {
  assert.equal(v.buildNodePanelHtml(srcNode('unknown'), [], null, ORDER), '');
  for (const bad of [undefined, null, [], 'x', 5, {}, [null, 3]]) assert.equal(v.buildNodePanelHtml(source, [], null, bad), '', JSON.stringify(bad));
  assert.equal(v.buildSourcePriorityHtml(stage, ORDER), '');
  assert.equal(v.buildSourcePriorityHtml(null, ORDER), '');
});

test('the source name and the numbers are escaped', () => {
  const html = v.buildNodePanelHtml(srcNode('<b>x'), [], null, [{ name: '<b>x', priority: '<i>1', rank: '<u>2' }]);
  assert.match(html, /Flat priority &lt;i&gt;1 · rank &lt;u&gt;2 of 1<\/div>/);
  assert.doesNotMatch(html, /<i>1|<u>2/);
});

test('a loop panel is the same with or without a priority order, and a stage or service stays read-only', () => {
  assert.equal(v.buildNodePanelHtml(loop(), [], null, ORDER), v.buildNodePanelHtml(loop(), []));
  assert.equal(v.buildNodePanelHtml(stage, [], null, ORDER), '');
  assert.equal(v.buildNodePanelHtml(service, [], null, ORDER), '');
});

test('the graph passes its priorityOrder to the panel of a selected source', () => {
  const g = { nodes: [loop(), source], edges: [], warnings: [], priorityOrder: ORDER };
  const lay = v.layoutGraph(g);
  assert.equal(count(v.buildGraphHtml(g, lay, { selectedId: 'source:hygiene' }), 'Flat priority 40 · rank 2 of 6'), 1);
  assert.equal(count(v.buildGraphHtml({ ...g, priorityOrder: undefined }, lay, { selectedId: 'source:hygiene' }), 'Flat priority'), 0);
  assert.equal(count(v.buildGraphHtml(g, lay, { selectedId: null }), 'Flat priority'), 0);
});

test('only a source node gets the priority line: the name of a loop, a stage or a prefixed id does not count', () => {
  assert.equal(v.buildSourcePriorityHtml({ ...loop(), id: 'first' }, ORDER), '');
  assert.equal(v.buildSourcePriorityHtml({ ...stage, id: 'first' }, ORDER), '');
  assert.equal(v.buildSourcePriorityHtml({ ...source, id: 'not-a-source:first' }, ORDER), '');
  assert.equal(v.buildSourcePriorityHtml({ ...source, id: 'firstsource:' }, ORDER), '');
  assert.equal(v.buildSourcePriorityHtml({ ...source, id: 'first' }, ORDER).includes('Flat priority 1 · rank 1 of 6'), true);
});

test('empty entries in the priority order are skipped even when the source is found', () => {
  const order = [null, { name: 'first', priority: 1, rank: 1 }, undefined, { name: 'other', priority: 1, rank: 1 }, 7];
  assert.match(v.buildNodePanelHtml(srcNode('first'), [], null, order), /Flat priority 1 · rank 1 of 5 · 1 other source\(s\) share this priority/);
});

// ---- the group-order line of a source (HUB0331 piece W-E3) ----

const COMPARE = [
  { name: 'first', flatRank: 1, graphRank: 1, group: 'group:fix' },
  { name: 'hygiene', flatRank: 2, graphRank: 5, group: 'group:late' },
  { name: 'twin', flatRank: 2, graphRank: 1, group: null },
  { name: 'trio-a', flatRank: 4, graphRank: 2, group: 'group:other' },
];
const GROUPS = [{ id: 'group:fix', label: 'Fixes first', children: [] }, { id: 'group:late', label: '', children: [] }, null];
const html2 = (name, compare, groups) => v.buildNodePanelHtml(srcNode(name), [], null, ORDER, compare, groups);

test('a source shows its group order under the flat priority, higher, lower or the same place', () => {
  assert.match(html2('twin', COMPARE, GROUPS), /Flat priority 40 · rank 2 of 6 · 1 other source\(s\) share this priority<\/div><div class="meta wf-priority-graph">Group order: rank 1 of 4 · group ungrouped · 1 place higher than the flat order<\/div>/);
  assert.match(html2('trio-a', COMPARE, GROUPS), /Group order: rank 2 of 4 · group group:other · 2 places higher than the flat order<\/div>/);
  assert.match(html2('hygiene', COMPARE, GROUPS), /Group order: rank 5 of 4 · group group:late · 3 places lower than the flat order<\/div>/);
  assert.match(html2('first', COMPARE, GROUPS), /Group order: rank 1 of 4 · group Fixes first · same place as the flat order<\/div>/);
  assert.equal(count(html2('first', COMPARE, GROUPS), 'wf-priority-graph'), 1);
});

test('the group label is used when the groups list has a non-empty one, the id otherwise, and everything is escaped', () => {
  const esc = v.buildNodePanelHtml(srcNode('first'), [], null, ORDER, [{ name: 'first', flatRank: 1, graphRank: '<u>', group: 'g' }], [{ id: 'g', label: '<b>"G"</b>' }]);
  assert.match(esc, /Group order: rank &lt;u&gt; of 1 · group &lt;b&gt;&quot;G&quot;&lt;\/b&gt; · /);
  assert.doesNotMatch(esc, /<b>"G"|<u>/);
  assert.match(html2('hygiene', COMPARE, 'not an array'), /group group:late · /);
  assert.match(html2('hygiene', COMPARE, undefined), /group group:late · /);
});

test('without an entry, without a usable priorityCompare or without the flat line the panel is what phase D built', () => {
  const phaseD = v.buildNodePanelHtml(srcNode('hygiene'), [], null, ORDER);
  for (const bad of [undefined, null, [], 'x', 5, {}, [null, 3], [{ name: 'other', flatRank: 1, graphRank: 1, group: null }]]) assert.equal(html2('hygiene', bad, GROUPS), phaseD, JSON.stringify(bad));
  assert.equal(v.buildNodePanelHtml(srcNode('unknown'), [], null, ORDER, COMPARE, GROUPS), '');
  assert.equal(v.buildNodePanelHtml(srcNode('first'), [], null, undefined, COMPARE, GROUPS), '');
  assert.equal(v.buildNodePanelHtml(loop(), [], null, ORDER, COMPARE, GROUPS), v.buildNodePanelHtml(loop(), []));
  assert.equal(v.buildSourceGroupOrderHtml('first', COMPARE, GROUPS).includes('Group order'), true);
});

test('empty entries in priorityCompare are skipped even when the source is found', () => {
  assert.match(html2('twin', [null, undefined, 7, ...COMPARE], GROUPS), /Group order: rank 1 of 7 · group ungrouped/);
});

test('the graph passes priorityCompare and groups to the panel of the selected source', () => {
  const g = { nodes: [loop(), source], edges: [], warnings: [], priorityOrder: ORDER, priorityCompare: COMPARE, groups: GROUPS };
  const lay = v.layoutGraph(g);
  assert.equal(count(v.buildGraphHtml(g, lay, { selectedId: 'source:hygiene' }), 'Group order: rank 5 of 4 · group group:late · 3 places lower than the flat order'), 1);
  assert.equal(count(v.buildGraphHtml({ ...g, priorityCompare: undefined }, lay, { selectedId: 'source:hygiene' }), 'Group order'), 0);
  assert.equal(count(v.buildGraphHtml({ ...g, groups: undefined }, lay, { selectedId: 'source:hygiene' }), 'group group:late'), 1);
  assert.equal(count(v.buildGraphHtml(g, lay, { selectedId: null }), 'Group order'), 0);
});

test('an entry without a group key counts as ungrouped, and the view hands the groups to the panel for the label', () => {
  assert.match(html2('twin', [{ name: 'twin', flatRank: 2, graphRank: 1 }], GROUPS), /group ungrouped · 1 place higher/);
  const g = { nodes: [loop(), srcNode('first')], edges: [], warnings: [], priorityOrder: ORDER, priorityCompare: COMPARE, groups: GROUPS };
  const html = v.buildGraphHtml(g, v.layoutGraph(g), { selectedId: 'source:first' });
  assert.equal(count(html, 'group Fixes first · same place as the flat order'), 1);
});
