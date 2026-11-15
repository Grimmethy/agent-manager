'use strict';
// draftTask() runs a registered script handler instead of a model draft. Run: node --test src/local-draft-script-handler.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'script-handler-draft-'));
process.env.AGENT_MANAGER_REPO_ROOT = tmp;
process.env.AGENT_MANAGER_PIPELINE_DIR = tmp;
process.env.AGENT_MANAGER_DOMAINS_PATH = path.join(tmp, 'task-domains.json');
fs.writeFileSync(process.env.AGENT_MANAGER_DOMAINS_PATH, '{}');
const { registerScriptHandler, _resetForTests } = require('./script-handler-registry.js');
const { draftTask } = require('./local-draft.js');

const mkTask = (over = {}) => ({ id: 't-1', domain: 'default', source: 'script_demo_source', title: 'demo', status: 'drafting', history: [], promptContext: { rawText: 'x' }, ...over });
const events = (task) => task.history.map((h) => h.stage);
const noModel = () => { throw new Error('a model call was made for a script-handled source'); };

test.beforeEach(() => _resetForTests());

test('a handler result is recorded on the task, the task is terminal "recorded", and no model is called', async () => {
  let seen;
  registerScriptHandler('script_demo_source', async (task) => { seen = task.id; return { outcome: 'baseline', summary: 'ran 3 tasks', detail: { n: 3 } }; });
  const task = mkTask();
  const res = await draftTask(task, { localCall: noModel });
  assert.deepEqual(res, { succeeded: true, recorded: true });
  assert.equal(seen, 't-1');
  assert.equal(task.terminalDisposition, 'recorded');
  assert.equal(task.status, 'recorded');
  assert.equal(task.scriptResult.outcome, 'baseline');
  assert.equal(task.scriptResult.summary, 'ran 3 tasks');
  assert.deepEqual(task.scriptResult.detail, { n: 3 });
  assert.match(task.scriptResult.at, /^\d{4}-\d\d-\d\dT/);
  assert.ok(events(task).includes('script-handler-done'));
  assert.ok(events(task).includes('recorded'));
  assert.ok(!events(task).includes('needs-review'), 'a recorded task never goes to review');
  assert.equal(task.draftAttempts, undefined, 'no draft attempt is started');
  const done = task.history.find((h) => h.stage === 'script-handler-done');
  assert.match(done.detail, /^baseline: ran 3 tasks$/);
});

test('missing result fields get safe defaults and a long summary is cut in the history detail', async () => {
  registerScriptHandler('script_demo_source', async () => ({ summary: 'x'.repeat(500) }));
  const task = mkTask();
  await draftTask(task, { localCall: noModel });
  assert.equal(task.scriptResult.outcome, 'done');
  assert.equal(task.scriptResult.detail, null);
  assert.equal(task.history.find((h) => h.stage === 'script-handler-done').detail.length, 200);
  registerScriptHandler('script_demo_source_2', async () => undefined);
  const t2 = mkTask({ source: 'script_demo_source_2' });
  assert.deepEqual(await draftTask(t2, { localCall: noModel }), { succeeded: true, recorded: true });
  assert.equal(t2.scriptResult.summary, '');
});

test('a throwing handler returns succeeded:false with the reason, records script-handler-failed, and leaves the task un-recorded', async () => {
  registerScriptHandler('script_demo_source', async () => { throw new Error('broker said no'); });
  const task = mkTask();
  const res = await draftTask(task, { localCall: noModel });
  assert.equal(res.succeeded, false);
  assert.equal(res.reason, 'script handler failed: broker said no');
  assert.equal(res.recorded, undefined);
  assert.ok(events(task).includes('script-handler-failed'));
  assert.equal(task.terminalDisposition, undefined);
  assert.equal(task.status, 'drafting');
  assert.equal(task.scriptResult, undefined);
});

test('a source with no handler does not take the script path', async () => {
  const task = mkTask({ source: 'no_handler_source' });
  let called = false;
  const res = await draftTask(task, { localCall: async () => { called = true; throw new Error('model path reached'); } }).catch((e) => ({ threw: e.message }));
  assert.notEqual(res && res.recorded, true);
  assert.equal(task.terminalDisposition, undefined);
  assert.ok(!events(task).includes('script-handler-done'));
  assert.ok(called || res.threw || res.succeeded === false || res.blocked, 'the normal draft path ran (model call, error or block), not the script path');
});
