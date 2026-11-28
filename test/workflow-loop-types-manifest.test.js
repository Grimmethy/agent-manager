'use strict';

// The ordered pipeline manifest in src/workflow-loop-types.js: the derived order/membership views and the load-time validity check.

const test = require('node:test');
const assert = require('node:assert');
const { buildLoops, PIPELINE_ORDER, PIPELINE_MEMBERSHIP, pipelineManifestValid } = require('../src/workflow-loop-types.js');

test('PIPELINE_ORDER and PIPELINE_MEMBERSHIP are derived from the manifest in run order', () => {
  assert.deepStrictEqual([...PIPELINE_ORDER], ['orient', 'plan', 'implement', 'review', 'apply']);
  assert.deepStrictEqual({ ...PIPELINE_MEMBERSHIP }, { orient: 'draft', plan: 'draft', implement: 'draft', review: 'review', apply: 'apply' });
  assert.ok(Object.isFrozen(PIPELINE_ORDER));
  assert.ok(Object.isFrozen(PIPELINE_MEMBERSHIP));
});

test('pipelineManifestValid rejects empty, duplicate, unnamed and unknown-pool manifests', () => {
  assert.strictEqual(pipelineManifestValid([{ name: 'a', pool: 'draft' }, { name: 'b', pool: 'review' }]), true);
  assert.strictEqual(pipelineManifestValid([]), false);
  assert.strictEqual(pipelineManifestValid(null), false);
  assert.strictEqual(pipelineManifestValid([{ name: 'a', pool: 'draft' }, { name: 'a', pool: 'draft' }]), false);
  assert.strictEqual(pipelineManifestValid([{ name: '', pool: 'draft' }]), false);
  assert.strictEqual(pipelineManifestValid([{ name: 'a', pool: 'nope' }]), false);
  assert.strictEqual(pipelineManifestValid(['a']), false);
});

test('buildLoops builds the pipeline loop from the manifest order', () => {
  const nodes = PIPELINE_ORDER.map((name) => ({ id: 'stage:' + name, kind: 'stage', label: name }));
  const built = buildLoops({ nodes, edges: [] }, { loops: [] });
  const pipeline = built.loops.find((l) => l.id === 'loop:pipeline');
  assert.ok(pipeline, 'pipeline loop present');
  assert.deepStrictEqual(pipeline.steps, PIPELINE_ORDER.map((n) => 'stage:' + n));
  for (const name of PIPELINE_ORDER) {
    const n = built.nodes.find((x) => x.id === 'stage:' + name);
    assert.strictEqual(n.loop, 'loop:pipeline');
  }
  const missing = buildLoops({ nodes: nodes.slice(1), edges: [] }, { loops: [] });
  assert.strictEqual(missing.loops.find((l) => l.id === 'loop:pipeline'), undefined);
});
