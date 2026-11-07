'use strict';

// Tests for src/workflow-loop-types.js. Run: node --test src/workflow-loop-types.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLoops, addLoopTypes } = require('./workflow-loop-types.js');

const STAGES = ['orient', 'plan', 'implement', 'review', 'apply'];
const stage = (name) => ({ id: 'stage:' + name, kind: 'stage', label: name, parent: null, runtime: null, model: null, work: null, counts: null });
const lane = (id, name, provider, tierB) => ({ id, kind: 'loop', label: name, parent: null, runtime: { status: 'idle' }, model: { name, provider, tierB: tierB === undefined ? null : tierB, choices: { local: [], cloud: [] } }, work: null, counts: null });

// The live shape (2026-11-07): four draft lanes, two reviewers, two script lanes.
function liveGraph() {
  return {
    schemaVersion: 1,
    nodes: [
      ...STAGES.map(stage),
      { id: 'service:apply-loop', kind: 'service', label: 'apply-loop', parent: null, runtime: null, model: null, work: null, counts: null },
      lane('worker-3090', 'ornith:35b', 'local', 35), lane('worker-p40', 'ornith-p40:35b', 'local', 35), lane('worker-rx580', 'qwen3-vl:8b-instruct', 'local', 8),
      lane('worker-cloud', 'claude-haiku-5-5', 'cloud'), lane('worker-tuner', 'script', 'script'), lane('worker-uiconf', 'script', 'script'),
      lane('reviewer', 'ornith:35b', 'local', null), lane('reviewer-p40', 'ornith-p40:35b', 'local', null),
    ],
    edges: [
      { id: 'stage:orient->stage:plan:produces', from: 'stage:orient', to: 'stage:plan', kind: 'produces', label: null },
      { id: 'worker-3090->reviewer:reviews', from: 'worker-3090', to: 'reviewer', kind: 'reviews', label: null },
      { id: 'worker-p40->reviewer-p40:reviews', from: 'worker-p40', to: 'reviewer-p40', kind: 'reviews', label: null },
    ],
    groups: [], warnings: [],
  };
}
const node = (g, id) => g.nodes.find((n) => n.id === id);

test('the pipeline loop is derived: Implement lists every draft lane and sizes by the smallest, Review is the reviewers, Apply is a script', () => {
  const g = addLoopTypes(liveGraph(), { schemaVersion: 1, loops: [] });
  const pipe = g.loops.find((l) => l.id === 'loop:pipeline');
  assert.equal(pipe.name, 'Task pipeline');
  assert.equal(pipe.kind, 'pipeline');
  assert.deepEqual(pipe.steps, STAGES.map((s) => 'stage:' + s));
  assert.deepEqual(pipe.services, ['service:apply-loop']);
  const impl = node(g, 'stage:implement');
  assert.equal(impl.loop, 'loop:pipeline');
  assert.deepEqual(impl.models.map((m) => m.lane), ['worker-3090', 'worker-cloud', 'worker-p40', 'worker-rx580']);
  assert.deepEqual(impl.models.map((m) => m.size.label), ['35B', 'cloud haiku', '35B', '8B']);
  assert.equal(impl.size.label, '8B', 'the smallest model sets the size');
  assert.equal(impl.size.scale, 1.0);
  assert.equal(node(g, 'stage:orient').models.length, 4);
  const review = node(g, 'stage:review');
  assert.deepEqual(review.models.map((m) => m.lane), ['reviewer', 'reviewer-p40']);
  assert.equal(review.size.label, '35B');
  const apply = node(g, 'stage:apply');
  assert.deepEqual(apply.models, [{ name: 'apply-loop', provider: 'script', lane: null, size: apply.size }]);
  assert.equal(apply.size.scale, 0.8);
});

test('script lanes become their own loops with one step', () => {
  const g = addLoopTypes(liveGraph(), { schemaVersion: 1, loops: [] });
  const tuner = g.loops.find((l) => l.id === 'loop:tuner');
  assert.equal(tuner.name, 'Tuning loop');
  assert.deepEqual(tuner.steps, ['step:tuner:run']);
  const step = node(g, 'step:tuner:run');
  assert.equal(step.kind, 'step');
  assert.equal(step.loop, 'loop:tuner');
  assert.equal(step.models[0].lane, 'worker-tuner');
  assert.equal(step.size.tier, 'script');
  assert.equal(g.loops.find((l) => l.id === 'loop:uiconf').name, 'UI conformance loop');
  assert.ok(!g.loops.some((l) => /worker-|reviewer/.test(l.id)), 'no loop is named after a lane except the script lanes');
});

test('registry worker loops become step chains with models; a script step has no lane', () => {
  const registry = { schemaVersion: 1, loops: [
    { id: 'loop:stalled', name: 'Stalled-task worker', kind: 'worker', trigger: 'service:apply-loop', steps: [
      { id: 'gather', label: 'Gather the stalled task', model: { provider: 'script', name: null, fromLane: null } },
      { id: 'judge', label: 'Judge it', model: { provider: 'cloud', name: 'claude-sonnet-5-5', fromLane: null } },
      { id: 'act', label: 'Act', model: { provider: 'local', name: null, fromLane: 'worker-rx580' } },
    ] },
  ] };
  const g = addLoopTypes(liveGraph(), registry);
  const loop = g.loops.find((l) => l.id === 'loop:stalled');
  assert.deepEqual(loop.steps, ['step:stalled:gather', 'step:stalled:judge', 'step:stalled:act']);
  assert.deepEqual(loop.services, ['service:apply-loop']);
  assert.equal(node(g, 'step:stalled:gather').models[0].provider, 'script');
  assert.equal(node(g, 'step:stalled:gather').size.scale, 0.8);
  assert.equal(node(g, 'step:stalled:judge').models[0].size.label, 'cloud sonnet');
  assert.equal(node(g, 'step:stalled:act').models[0].lane, 'worker-rx580');
  assert.equal(node(g, 'step:stalled:act').size.label, '8B');
  assert.ok(g.edges.some((e) => e.id === 'step:stalled:gather->step:stalled:judge:produces' && e.kind === 'produces'));
  assert.equal(new Set(g.edges.map((e) => e.id)).size, g.edges.length, 'each edge id once');
});

test('a tag-less local lane with a tierB sizes by tierB', () => {
  const graph = liveGraph();
  graph.nodes = graph.nodes.map((n) => (n.id === 'worker-rx580' ? lane('worker-rx580', 'custom-model', 'local', 8) : n));
  const g = addLoopTypes(graph, { schemaVersion: 1, loops: [] });
  assert.equal(node(g, 'stage:implement').size.label, '8B');
});

test('invalid registry entries are skipped with a warning and nothing throws', () => {
  const g = addLoopTypes(liveGraph(), { schemaVersion: 1, loops: [null, { id: 'x', name: 'bad', steps: [] }, { id: 'loop:a', name: 'A', steps: [] }, { id: 'loop:a', name: 'dup', steps: [] }] });
  assert.ok(g.loops.some((l) => l.id === 'loop:a' && l.name === 'A'));
  assert.equal(g.loops.filter((l) => l.id === 'loop:a').length, 1);
  assert.equal(g.warnings.filter((w) => /loop types/.test(w)).length, 3);
  for (const bad of [null, undefined, {}, { nodes: 'x' }, 5]) assert.doesNotThrow(() => addLoopTypes(bad, null));
  assert.deepEqual(addLoopTypes({ nodes: [], edges: [] }, null).loops, []);
});

test('a graph without the stage nodes has no pipeline loop; the input graph is not mutated', () => {
  const graph = liveGraph();
  graph.nodes = graph.nodes.filter((n) => n.kind !== 'stage');
  const before = JSON.stringify(graph);
  const out = addLoopTypes(graph, null);
  assert.ok(!out.loops.some((l) => l.id === 'loop:pipeline'));
  assert.equal(JSON.stringify(graph), before);
  const full = liveGraph(); const b2 = JSON.stringify(full);
  buildLoops(full, null);
  assert.equal(JSON.stringify(full), b2);
});

test('deterministic: the same input gives the same output', () => {
  assert.equal(JSON.stringify(addLoopTypes(liveGraph(), null)), JSON.stringify(addLoopTypes(liveGraph(), null)));
});

test('a reviewer lane with no reviews edge pointing at it is still a reviewer (by its id), not a draft lane', () => {
  const graph = liveGraph();
  graph.edges = graph.edges.filter((e) => e.kind !== 'reviews');
  const g = addLoopTypes(graph, null);
  assert.deepEqual(node(g, 'stage:review').models.map((m) => m.lane), ['reviewer', 'reviewer-p40']);
  assert.ok(!node(g, 'stage:implement').models.some((m) => /^reviewer/.test(m.lane)));
});
