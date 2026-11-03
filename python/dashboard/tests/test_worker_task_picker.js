// Node tests for the shared task picker (HUB0325 piece W-B4a): buildTaskPickerHtml(inst, items, selectedType).
// The expected strings are written by hand from the "assign a task" block of renderWorkers in workers-tab.js as it was BEFORE the move, including its whitespace
// (the template literals keep their newlines and indentation) and the `value="x" >` spacing of an option that is not selected.
// Run: node --test python/dashboard/tests/test_worker_task_picker.js

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
// hubTag is the real one in queue-tab.js; here a small stand-in with a recognisable output, checked against its use below.
vm.runInContext(ESC_HTML + '\n' + ESC_ATTR + "\nfunction hubTag(hub) { return 'H:' + hub.label; }", ctx);
vm.runInContext(read('worker-task-picker.js'), ctx, { filename: 'worker-task-picker.js' });
const v = ctx;

const INST = { instanceId: 'worker-3090' };
const TYPE_TITLE = 'Assign a specific task to this worker, overriding the automated priority/tier claim order -- includes tasks already claimed by other workers, tier-filtered for this worker type';
const typeSelect = (options) => `<select class="worker-type-select" data-instance-id="worker-3090" onclick="event.stopPropagation()" title="${TYPE_TITLE}">\n            <option value="">(assign a task…)</option>\n            ${options}\n          </select>`;
const taskSelect = (type, first, options) => `<select class="worker-task-select" data-instance-id="worker-3090" onclick="event.stopPropagation()" title="Pick a specific ${type} task to assign to this worker">\n            <option value="">${first}</option>\n            ${options}\n          </select>`;
const taskOption = (id, title, lane, label) => `<option value="${id}" data-title="${title}" data-source-lane="${lane}" title="${title}">${label}</option>`;

test('no items and no selected type: the type select alone, with no type options', () => {
  assert.equal(v.buildTaskPickerHtml(INST, [], ''), typeSelect(''));
  assert.equal(v.buildTaskPickerHtml(INST, undefined, undefined), typeSelect(''));
});

test('items of two sources are grouped by source, sorted, with their counts', () => {
  const items = [{ id: 't1', source: 'pipeline_debrief' }, { id: 't2', source: 'adhoc' }, { id: 't3', source: 'pipeline_debrief' }, { id: 't4' }];
  assert.equal(v.buildTaskPickerHtml(INST, items, ''),
    typeSelect('<option value="adhoc" >adhoc (1)</option><option value="pipeline_debrief" >pipeline_debrief (2)</option><option value="unknown" >unknown (1)</option>'));
});

test('a selected type is marked selected and its tasks follow in a second select', () => {
  const items = [{ id: 't1', title: 'First task', source: 'adhoc' }, { id: 't2', title: 'Second task', source: 'adhoc' }, { id: 't3', title: 'Other', source: 'research' }];
  assert.equal(v.buildTaskPickerHtml(INST, items, 'adhoc'),
    typeSelect('<option value="adhoc" selected>adhoc (2)</option><option value="research" >research (1)</option>')
    + taskSelect('adhoc', '(choose a adhoc task…)', taskOption('t1', 'First task', '', 'First task') + taskOption('t2', 'Second task', '', 'Second task')));
});

test('a selected type whose bucket is empty this poll stays visible with the empty text', () => {
  assert.equal(v.buildTaskPickerHtml(INST, [{ id: 't3', title: 'Other', source: 'research' }], 'adhoc'),
    typeSelect('<option value="adhoc" selected>adhoc (0)</option><option value="research" >research (1)</option>')
    + taskSelect('adhoc', '(no adhoc tasks right now)', ''));
  assert.equal(v.buildTaskPickerHtml(INST, [], 'adhoc'),
    typeSelect('<option value="adhoc" selected>adhoc (0)</option>') + taskSelect('adhoc', '(no adhoc tasks right now)', ''));
});

test('a task title longer than 70 characters is cut to 69 plus an ellipsis in the label only', () => {
  const title = 'x'.repeat(100);
  const out = v.buildTaskPickerHtml(INST, [{ id: 't1', title, source: 'adhoc' }], 'adhoc');
  assert.ok(out.includes(taskOption('t1', title, '', 'x'.repeat(69) + '…')));
  const exact = 'y'.repeat(70);
  assert.ok(v.buildTaskPickerHtml(INST, [{ id: 't1', title: exact, source: 'adhoc' }], 'adhoc').includes(taskOption('t1', exact, '', exact)));
  assert.ok(v.buildTaskPickerHtml(INST, [{ id: 't1', title: 'y'.repeat(71), source: 'adhoc' }], 'adhoc').includes('>' + 'y'.repeat(69) + '…</option>'));
});

test('labels: a task without a title shows its id, a hub member leads with its hub tag, an existing HUB title is not tagged twice', () => {
  const run = (t) => v.buildTaskPickerHtml(INST, [{ source: 'adhoc', ...t }], 'adhoc');
  assert.ok(run({ id: 'abc' }).includes(taskOption('abc', 'abc', '', 'abc')));
  assert.ok(run({ id: 't1', title: 'Do it', hub: { label: 'HUB0001' } }).includes(taskOption('t1', 'Do it', '', 'H:HUB0001 · Do it')));
  assert.ok(run({ id: 't1', title: 'HUB0001 · Do it', hub: { label: 'HUB0001' } }).includes(taskOption('t1', 'HUB0001 · Do it', '', 'HUB0001 · Do it')));
});

test('labels: running on another lane, pinned to a sibling, premium, and the combinations', () => {
  const run = (t) => v.buildTaskPickerHtml(INST, [{ source: 'adhoc', id: 't1', title: 'Do it', ...t }], 'adhoc');
  assert.ok(run({ location: 'drafting:worker-p40' }).includes(taskOption('t1', 'Do it', 'worker-p40', '⚠ running on worker-p40 — Do it')));
  assert.ok(run({ location: 'pending' }).includes(taskOption('t1', 'Do it', '', 'Do it')));
  assert.ok(run({ pinnedTo: 'worker-rx580' }).includes(taskOption('t1', 'Do it', '', '📌 pinned to worker-rx580 — Do it')));
  assert.ok(run({ premiumPriority: true }).includes(taskOption('t1', 'Do it', '', '★ Do it')));
  assert.ok(run({ location: 'drafting:worker-p40', pinnedTo: 'worker-rx580', premiumPriority: true }).includes(taskOption('t1', 'Do it', 'worker-p40', '★ ⚠ running on worker-p40 — Do it')));
  assert.ok(run({ location: 'worker-x' }).includes('data-source-lane="worker-x"'));
});

test('escaping: the type, the id, the title and the label', () => {
  const evil = '<b>"x"&\'';
  const out = v.buildTaskPickerHtml({ instanceId: 'w"1' }, [{ id: evil, title: evil, source: evil }], evil);
  assert.equal(out.split('data-instance-id="w&quot;1"').length - 1, 2, 'both selects escape the instance id');
  assert.ok(out.includes(`>${'&lt;b&gt;&quot;x&quot;&amp;&#39;'} (1)</option>`));
  assert.ok(out.includes('title="Pick a specific <b>&quot;x&quot;&\' task to assign to this worker"'));
  assert.ok(out.includes('(choose a &lt;b&gt;&quot;x&quot;&amp;&#39; task…)'));
  assert.ok(out.includes(`value="<b>&quot;x&quot;&'" data-title="<b>&quot;x&quot;&'"`));
  assert.ok(out.includes('>&lt;b&gt;&quot;x&quot;&amp;&#39;</option>'));
});

test('no other script defines buildTaskPickerHtml, the tab loads the new file before the status helpers, and workers-tab.js got shorter', () => {
  for (const f of fs.readdirSync(JS).filter((n) => n.endsWith('.js') && !n.endsWith('.test.js') && n !== 'worker-task-picker.js')) {
    assert.ok(!/function\s+buildTaskPickerHtml\b|(?:const|let|var)\s+buildTaskPickerHtml\b/.test(read(f)), `${f} defines buildTaskPickerHtml`);
  }
  const tab = read('workers-tab.js');
  assert.ok(tab.split('\n').length < 471, 'workers-tab.js must be shorter than the 471 lines it had before this piece');
  assert.ok(tab.split('\n').length < 500);
  assert.equal(tab.split('buildTaskPickerHtml(').length - 1, 1);
  assert.ok(!tab.includes('worker-task-select'.concat('" data-instance-id')), 'the task select markup now lives in worker-task-picker.js');
  const html = fs.readFileSync(path.join(__dirname, '..', 'templates', 'index.html'), 'utf8');
  const a = html.indexOf('/static/js/worker-task-picker.js');
  assert.ok(a > 0 && a < html.indexOf('/static/js/worker-model-select.js') && a < html.indexOf('/static/js/worker-status-helpers.js') && a < html.indexOf('/static/js/workers-tab.js'));
});
