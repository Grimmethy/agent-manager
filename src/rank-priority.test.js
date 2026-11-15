'use strict';

// The rank-priority leaf (roadmap P4): the logic moved out of workflow-priority.js unchanged; the wrapper still loads the registry first, the leaf does not,
// and task-sources.js no longer requires next-claimable-task.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const leaf = require('./rank-priority.js');
const workflow = require('./workflow-priority.js');
const { clearRegistry, registerTaskSource } = require('./task-source-registry.js');

class Fx {
  static register() {
    clearRegistry();
    registerTaskSource('probe_low', { priority: 7, next: () => null });
    registerTaskSource('adhoc', { priority: 40, next: () => null });
  }
}

test('workflow-priority.js re-exports the leaf effectivePriority and penalty', () => {
  assert.strictEqual(workflow.effectivePriority, leaf.effectivePriority);
  assert.strictEqual(workflow.BOT_ADHOC_PRIORITY_PENALTY, leaf.BOT_ADHOC_PRIORITY_PENALTY);
  assert.equal(leaf.BOT_ADHOC_PRIORITY_PENALTY, 30);
});

test('effectivePriority: premium first, hub tier next, a bot adhoc task is penalised, a human one is not', () => {
  const adhoc = () => 'adhoc';
  assert.equal(leaf.effectivePriority({ premiumPriority: true }, 40, adhoc), -Infinity);
  assert.equal(leaf.effectivePriority({}, 40, adhoc, true), -1000);
  assert.equal(leaf.effectivePriority({}, 40, adhoc), 70);
  assert.equal(leaf.effectivePriority({ humanQueued: true }, 40, adhoc), 40);
});

test('rankPriorityResolved ranks from the registry that is already loaded and does not load one', () => {
  Fx.register();
  assert.equal(leaf.rankPriorityResolved({ source: 'probe_low', domain: 'probe_low' }, { hubTier: false }), 7);
  assert.equal(leaf.rankPriorityResolved({ source: 'adhoc', domain: 'adhoc', humanQueued: true }, { hubTier: false }), 40);
  assert.equal(leaf.rankPriorityResolved({ premiumPriority: true, source: 'adhoc', domain: 'adhoc' }, { hubTier: false }), -Infinity);
  assert.equal(leaf.rankPriorityResolved(null), Infinity);
  assert.equal(leaf.rankPriorityResolved({ source: 'nobody', domain: 'nobody' }, { hubTier: false }), Infinity);
});

test('the wrapper loads the source registry first; the leaf alone ranks an unregistered source last', () => {
  assert.equal(workflow.rankPriorityOfTask(null), Infinity);
  clearRegistry();
  require('./model-profile-registry.js').clearModelProfileRegistry();
  delete require.cache[require.resolve('./task-sources.js')];
  const task = { source: 'adhoc', domain: 'adhoc', humanQueued: true };
  assert.equal(leaf.rankPriorityResolved(task, { hubTier: false }), Infinity, 'the leaf does not load the registry');
  const ranked = workflow.rankPriorityOfTask(task, { hubTier: false });
  assert.equal(Number.isFinite(ranked), true, 'the wrapper loaded task-sources.js, which registers adhoc');
  assert.equal(leaf.rankPriorityResolved(task, { hubTier: false }), ranked, 'with the registry loaded the leaf agrees');
});

test('task-sources.js no longer requires next-claimable-task.js; the leaf does not require workflow-priority.js', () => {
  const { buildGraph } = require('../scripts/import-cycles.js');
  const graph = buildGraph(path.join(__dirname, '..'));
  assert.equal(graph.all['src/task-sources.js'].includes('src/next-claimable-task.js'), false);
  assert.equal(graph.all['src/rank-priority.js'].includes('src/workflow-priority.js'), false);
});
