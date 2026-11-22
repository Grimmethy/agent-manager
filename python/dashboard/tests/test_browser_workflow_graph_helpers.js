// Node tests for the pure helpers exported by browser_workflow_graph.mjs (loops by type, piece 6). Run: node --test python/dashboard/tests/test_browser_workflow_graph_helpers.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, 'browser_workflow_graph.mjs')).href);

test('instanceIsShown: a node, or in the by-type view a model row, shows an instance; only the watchdog is exempt, and only in that view', async () => {
  const { instanceIsShown } = await load();
  assert.equal(instanceIsShown('worker-3090', ['stage:implement'], ['worker-3090'], true), true, 'a model row shows a lane');
  assert.equal(instanceIsShown('worker-3090', ['worker-3090'], [], false), true, 'a lane node shows it in the lane view');
  assert.equal(instanceIsShown('apply-loop', ['service:apply-loop'], [], true), true, 'the apply service keeps its prefix');
  assert.equal(instanceIsShown('worker-3090', ['stage:implement'], ['worker-p40'], true), false, 'another lane row does not count');
  assert.equal(instanceIsShown('watchdog', [], [], true), true, 'the watchdog is shown as each loop trigger in the by-type view');
  assert.equal(instanceIsShown('watchdog', [], [], false), false, 'but it must be a node in the lane view');
  assert.equal(instanceIsShown('worker-x', [], [], true), false);
});

test('loopTitleProblems: titles must be the loop names in order, the first the Task pipeline, none a lane', async () => {
  const { loopTitleProblems } = await load();
  const loops = [{ name: 'Task pipeline' }, { name: 'Stalled-task worker' }, { name: 'Tuning loop' }];
  assert.deepEqual(loopTitleProblems(['Task pipeline', 'Stalled-task worker', 'Tuning loop'], loops), []);
  assert.deepEqual(loopTitleProblems([], loops), ['no card is drawn', 'the card titles are not the loop names in order', 'the first card is not the Task pipeline']);
  assert.match(loopTitleProblems(['Stalled-task worker', 'Task pipeline', 'Tuning loop'], loops).join(), /not the loop names in order/);
  assert.match(loopTitleProblems(['Stalled-task worker', 'Task pipeline', 'Tuning loop'], loops).join(), /first card is not the Task pipeline/);
  assert.match(loopTitleProblems(['Task pipeline', 'worker-3090 · ornith:35b'], [{ name: 'Task pipeline' }, { name: 'worker-3090 · ornith:35b' }].slice(0, 1)).join(), /titled by a lane or GPU/);
  assert.deepEqual(loopTitleProblems(['Task pipeline', 'Retry worker-bot'], [{ name: 'Task pipeline' }, { name: 'Retry worker-bot' }]), [], 'a loop whose real name says worker- is allowed only if it is the loop name');
  assert.match(loopTitleProblems(['Task pipeline', 'P40 lane'], [{ name: 'Task pipeline' }, { name: 'Tuning loop' }]).join(), /titled by a lane or GPU/);
  assert.match(loopTitleProblems(['Task pipeline'], null).join(), /not the loop names in order/);
});
