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
vm.runInContext(ESC_HTML + '\n' + ESC_ATTR, ctx);
for (const f of ['worker-status-helpers.js', 'worker-switch-ui.js', 'worker-model-select.js', 'workflow-layout.js', 'workflow-node-panel.js', 'workflow-graph-view.js']) {
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
  // a switchable local loop: one row for the switch and one for the select; not switchable: only the select row
  assert.equal(count(v.buildNodePanelHtml(loop(), []), 'class="wf-control-row"'), 2);
  assert.equal(count(v.buildNodePanelHtml(loop({ runtime: rt({ switchable: false }) }), []), 'class="wf-control-row"'), 1);
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
