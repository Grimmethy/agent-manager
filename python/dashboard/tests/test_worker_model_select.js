// Node tests for the shared worker model control (HUB0325 piece W-B2).
// The expected strings in the "ollama" tests were written by hand from the Workers tab template as it was BEFORE the move (workers-tab.js, the model-select block of renderWorkers),
// including its quirk that an option that is not selected is written `value="x" >` with a space before the `>`.
// Run: node --test python/dashboard/tests/test_worker_model_select.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS = path.join(__dirname, '..', 'static', 'js');
const read = (f) => fs.readFileSync(path.join(JS, f), 'utf8');

// Faithful copies of the two escape helpers; the first test checks they are still what the real scripts contain.
const ESC_HTML = "function escapeHtml(s) {\n  return String(s).replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]));\n}";
const ESC_ATTR = "function escapeAttr(s) { return String(s).replace(/\"/g, '&quot;'); }";

const ctx = vm.createContext({ console });
vm.runInContext(ESC_HTML + '\n' + ESC_ATTR + '\n' + read('worker-model-select.js'), ctx, { filename: 'worker-model-select.js' });
const v = ctx;

test('the escape helpers used here are still the ones in the real scripts', () => {
  assert.ok(read('core-ui.js').includes(ESC_HTML));
  assert.ok(read('branches-joblist-hardware-tabs.js').includes(ESC_ATTR));
});

test('modelKindForInstance: watchdog none; cloud gateway; script script; everything else ollama', () => {
  assert.equal(v.modelKindForInstance({ instanceId: 'watchdog' }), null);
  assert.equal(v.modelKindForInstance({ instanceId: 'watchdog', provider: 'cloud' }), null);
  assert.equal(v.modelKindForInstance({ instanceId: 'worker-x', provider: 'cloud' }), 'gateway');
  assert.equal(v.modelKindForInstance({ instanceId: 'worker-x', provider: 'script' }), 'script');
  for (const provider of [undefined, null, 'local', 'ollama', 'something-else']) {
    assert.equal(v.modelKindForInstance({ instanceId: 'worker-3090', provider }), 'ollama', String(provider));
  }
  assert.equal(v.modelKindForInstance({ instanceId: 'reviewer' }), 'ollama');
  assert.equal(v.modelKindForInstance({ instanceId: 'apply-loop' }), 'ollama');
});

const HEAD = '<select class="worker-model-select" data-instance-id="worker-3090" onclick="event.stopPropagation()"><option value="">(default)</option>';

test('ollama markup: two models, none overridden (hand-written golden)', () => {
  assert.equal(v.buildWorkerModelSelectHtml({ instanceId: 'worker-3090' }, { ollamaModels: ['a:1', 'b:2'] }, {}),
    HEAD + '<option value="a:1" >a:1</option><option value="b:2" >b:2</option></select>');
});

test('ollama markup: the overridden model is selected (hand-written golden)', () => {
  assert.equal(v.buildWorkerModelSelectHtml({ instanceId: 'worker-3090' }, { ollamaModels: ['a:1', 'b:2'] }, { 'worker-3090': 'b:2' }),
    HEAD + '<option value="a:1" >a:1</option><option value="b:2" selected>b:2</option></select>');
});

test('ollama markup: an override of another instance, an override not in the list, no models, missing inputs', () => {
  assert.equal(v.buildWorkerModelSelectHtml({ instanceId: 'worker-3090' }, { ollamaModels: ['a:1'] }, { 'worker-p40': 'a:1' }), HEAD + '<option value="a:1" >a:1</option></select>');
  assert.equal(v.buildWorkerModelSelectHtml({ instanceId: 'worker-3090' }, { ollamaModels: ['a:1'] }, { 'worker-3090': 'zzz' }), HEAD + '<option value="a:1" >a:1</option></select>');
  assert.equal(v.buildWorkerModelSelectHtml({ instanceId: 'worker-3090' }, { ollamaModels: [] }, {}), HEAD + '</select>');
  assert.equal(v.buildWorkerModelSelectHtml({ instanceId: 'worker-3090' }, {}, {}), HEAD + '</select>');
  assert.equal(v.buildWorkerModelSelectHtml({ instanceId: 'worker-3090' }, null, undefined), HEAD + '</select>');
});

test('the watchdog gets no control at all', () => {
  assert.equal(v.buildWorkerModelSelectHtml({ instanceId: 'watchdog' }, { ollamaModels: ['a'] }, {}), '');
});

test('a cloud lane shows the gateway model read-only, with and without a model', () => {
  const t = 'title="The cloud model is chosen by the gateway, not by this dashboard"';
  assert.equal(v.buildWorkerModelSelectHtml({ instanceId: 'worker-cloud', provider: 'cloud', model: 'claude-haiku-5-5' }, { ollamaModels: ['a'] }, {}),
    `<span class="meta worker-model-fixed" ${t}>cloud model set by the gateway: claude-haiku-5-5</span>`);
  assert.equal(v.buildWorkerModelSelectHtml({ instanceId: 'worker-cloud', provider: 'cloud' }, {}, {}),
    `<span class="meta worker-model-fixed" ${t}>cloud model set by the gateway: -</span>`);
  assert.doesNotMatch(v.buildWorkerModelSelectHtml({ instanceId: 'worker-cloud', provider: 'cloud', model: 'm' }, { ollamaModels: ['a'] }, { 'worker-cloud': 'a' }), /<select|<option/);
});

test('a script lane shows that it has no model', () => {
  assert.equal(v.buildWorkerModelSelectHtml({ instanceId: 'worker-uiconf', provider: 'script', model: 'x' }, { ollamaModels: ['a'] }, {}),
    '<span class="meta worker-model-fixed">script lane, no model</span>');
});

test('every interpolated value is escaped', () => {
  const evil = '<b>"x"&\'';
  const sel = v.buildWorkerModelSelectHtml({ instanceId: 'w"1' }, { ollamaModels: [evil] }, {});
  assert.match(sel, /data-instance-id="w&quot;1"/);
  assert.ok(sel.includes('value="<b>&quot;x&quot;&\'" >'), 'escapeAttr only escapes double quotes, as in the template before the move');
  assert.match(sel, />&lt;b&gt;&quot;x&quot;&amp;&#39;<\/option>/);
  const gw = v.buildWorkerModelSelectHtml({ instanceId: 'g', provider: 'cloud', model: evil }, {}, {});
  assert.doesNotMatch(gw, /<b>/);
});

test('no other script defines the two names, the tab loads the new file first, and workers-tab.js got shorter', () => {
  for (const f of fs.readdirSync(JS).filter((n) => n.endsWith('.js') && !n.endsWith('.test.js') && n !== 'worker-model-select.js')) {
    const text = read(f);
    for (const name of ['modelKindForInstance', 'buildWorkerModelSelectHtml']) {
      assert.ok(!new RegExp(`function\\s+${name}\\b|(?:const|let|var)\\s+${name}\\b`).test(text), `${f} defines ${name}`);
    }
  }
  const tab = read('workers-tab.js');
  assert.ok(tab.split('\n').length < 494, 'workers-tab.js must be shorter than the 494 lines it had before this piece');
  assert.equal(tab.split('buildWorkerModelSelectHtml(inst, workerModels, overrides)').length - 1, 1);
  const html = fs.readFileSync(path.join(__dirname, '..', 'templates', 'index.html'), 'utf8');
  const a = html.indexOf('/static/js/worker-model-select.js');
  const b = html.indexOf('/static/js/workers-tab.js');
  assert.ok(a > 0 && a < b, 'loaded before workers-tab.js');
  // worker-status-helpers.js must stay DIRECTLY before workers-tab.js (test_worker_status_helpers.js pins that), so the model-select tag comes just before it.
  assert.ok(a < html.indexOf('/static/js/worker-status-helpers.js'));
  assert.equal(html.slice(a, html.indexOf('/static/js/worker-status-helpers.js')).split('<script').length, 2);
});
