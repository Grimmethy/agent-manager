// Node tests for the step card helpers (loops by type, piece 5). Run: node --test python/dashboard/tests/test_workflow_step_card.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { wfStepScale, wfIsStepNode, wfStepBox, wfLaneDotHtml, wfStepModelsHtml } = require(path.join(__dirname, '..', 'static', 'js', 'workflow-step-card.js'));

const size = (label, scale, tier, source) => ({ b: 8, tier: tier || 'small', label, scale, source: source || 'tag' });
const model = (name, provider, lane, sz) => ({ name, provider, lane, size: sz || size('8B', 1.0) });
const step = (models, scale) => ({ id: 'step:x:y', kind: 'step', label: 'Y', models, size: scale === undefined ? null : size('?', scale) });

test('wfStepScale: the size scale of the step, 1 when missing or not a positive finite number', () => {
  assert.equal(wfStepScale(step([], 1.25)), 1.25);
  assert.equal(wfStepScale(step([], 0.8)), 0.8);
  for (const bad of [null, undefined, {}, { size: null }, { size: { scale: 0 } }, { size: { scale: -1 } }, { size: { scale: NaN } }, { size: { scale: '1.5' } }]) assert.equal(wfStepScale(bad), 1);
});

test('wfIsStepNode: a node with a models list is a step card', () => {
  assert.equal(wfIsStepNode(step([])), true);
  assert.equal(wfIsStepNode({ id: 'worker-1', kind: 'loop', models: undefined }), false);
  assert.equal(wfIsStepNode(null), false);
});

test('wfStepBox: base times scale in multiples of 4, and tall enough for its model rows', () => {
  const base = { w: 272, h: 128 };
  assert.deepEqual(wfStepBox(step([model('a', 'local', null)], 1.0), base), { w: 272, h: 128 });
  assert.deepEqual(wfStepBox(step([model('a', 'local', null)], 1.25), base), { w: 340, h: 160 });
  assert.deepEqual(wfStepBox(step([model('a', 'script', null)], 0.8), base), { w: 220, h: 104 });
  const four = wfStepBox(step([1, 2, 3, 4].map((i) => model('m' + i, 'local', null)), 0.8), base);
  assert.equal(four.h, 148, '52 + 4 rows of 24, more than the scaled 104');
  assert.ok(wfStepBox(step([1, 2, 3, 4, 5, 6].map((i) => model('m' + i, 'local', null)), 1.0), base).h > 128);
  assert.deepEqual(wfStepBox(null, null), { w: 272, h: 128 });
});

test('a bigger model gives a bigger box: 35B > 8B > script', () => {
  const base = { w: 272, h: 128 };
  const w = (scale) => wfStepBox(step([model('a', 'local', null)], scale), base).w;
  assert.ok(w(1.25) > w(1.0) && w(1.0) > w(0.8));
});

test('wfStepModelsHtml: one row per model with name, provider badge, size badge and the lane to open', () => {
  const node = step([model('ornith:35b', 'local', 'worker-3090', size('35B', 1.25, 'medium')), model('claude-haiku-5-5', 'cloud', 'worker-cloud', size('cloud haiku', 1.25, 'medium', 'cloud-table')), model('apply-loop', 'script', null, size('script', 0.8, 'script'))], 0.8);
  const lanes = { 'worker-3090': { id: 'worker-3090', runtime: { status: 'working', stale: false } } };
  const html = wfStepModelsHtml(node, lanes);
  assert.equal((html.match(/class="wf-model-row/g) || []).length, 3);
  assert.match(html, /data-lane="worker-3090"/);
  assert.match(html, /data-lane="worker-cloud"/);
  assert.equal((html.match(/data-lane=/g) || []).length, 2, 'a script row has no lane to open');
  assert.match(html, /<span class="wf-model">ornith:35b<\/span> <span class="chip wf-provider wf-provider-local">local<\/span> <span class="chip wf-size wf-size-medium" title="model size">35B<\/span>/);
  assert.match(html, /wf-provider-cloud">cloud</);
  assert.match(html, /wf-size-medium" title="nominal size, assumed">cloud haiku</);
  assert.match(html, /<span class="wf-model">apply-loop<\/span> <span class="chip wf-provider wf-provider-script">script<\/span><\/div>/, 'a script row has its own name and no size badge');
  assert.match(html, /wf-dot wf-dot-working/);
});

test('wfStepModelsHtml: escapes names, falls back to local for an unknown provider, says "no model" for none', () => {
  const html = wfStepModelsHtml(step([model('<b>x"</b>', 'evil"><i>', 'lane"1', null)]), {});
  assert.doesNotMatch(html, /<b>|<i>/);
  assert.match(html, /wf-provider-local">local</);
  assert.match(html, /data-lane="lane&quot;1"/);
  assert.match(wfStepModelsHtml(step([])), /no model/);
  assert.match(wfStepModelsHtml(null), /no model/);
  assert.doesNotMatch(wfStepModelsHtml(step([{ name: 'm', provider: 'local', lane: null, size: null }])), /wf-size/);
});

test('wfLaneDotHtml: one class per status, stale wins, nothing without a runtime', () => {
  assert.match(wfLaneDotHtml({ id: 'l', runtime: { status: 'idle' } }), /wf-dot-idle/);
  assert.match(wfLaneDotHtml({ id: 'l', runtime: { status: 'working', stale: true } }), /wf-dot-stale/);
  assert.match(wfLaneDotHtml({ id: 'l', runtime: { status: 'we"ird' } }), /wf-dot-weird/);
  assert.equal(wfLaneDotHtml(null), '');
  assert.equal(wfLaneDotHtml({ id: 'l' }), '');
});

test('a script step with no model name reads "no model", with the script badge and no size badge', () => {
  for (const name of [null, undefined, '', 'script']) {
    const html = wfStepModelsHtml(step([model(name, 'script', null, size('script', 0.8, 'script'))]), {});
    assert.match(html, /<span class="wf-model">no model<\/span> <span class="chip wf-provider wf-provider-script">script<\/span><\/div>/, String(name));
    assert.doesNotMatch(html, /wf-size/);
  }
  assert.match(wfStepModelsHtml(step([model('', 'local', null, size('8B', 1))]), {}), /<span class="wf-model">-<\/span>/, 'a local model with no name keeps the dash');
});
