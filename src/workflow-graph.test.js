'use strict';

// Tests for src/workflow-graph.js using node:test.
// Run: node --test src/workflow-graph.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const { buildWorkflowGraph } = require('./workflow-graph.js');

// ---- fixtures ----

function makeLane(opts) {
  return Object.assign({
    id: opts.id || 'worker-test',
    gpu: opts.gpu || 'test',
    model: opts.model || 'qwen2.5:7b',
    tier: opts.tier || 7,
    preempt: opts.preempt || 'never',
    reviewer: opts.reviewer || false,
    reviewerId: opts.reviewerId || `reviewer-${opts.gpu || 'test'}`,
    taskClasses: opts.taskClasses || null,
    env: opts.env || { OLLAMA_URL: 'http://localhost:11434', LOCAL_MODEL: opts.model || 'qwen2.5:7b' },
    local: false,
    slow: false,
    numCtx: null,
    numBatch: null,
    reserve: 'auto',
  }, opts);
}

function makeInstance(instanceId, extra) {
  return Object.assign({
    instanceId,
    status: 'working',
    pid: 1000,
    model: 'qwen2.5:7b',
    currentTaskId: 'task-1',
    currentPass: 1,
    lastHeartbeat: '2026-01-01T00:00:00Z',
    heartbeatAgeSeconds: 10,
    stateAgeSeconds: 5,
    stale: false,
    staleThresholdSeconds: 120,
    switchable: true,
    disabled: false,
    hub: null,
    projectLabel: null,
    borrowed: false,
  }, extra || {});
}

const FIXED_NOW = new Date('2026-06-01T12:00:00.000Z');

// ---- tests ----

test('provider mapping: ollama (default), cloud, script', () => {
  const lanes = [
    makeLane({ id: 'worker-ollama', model: 'qwen2.5:7b' }),
    makeLane({ id: 'worker-cloud', model: 'claude-sonnet', provider: 'cloud', cloud: true, taskClasses: ['change_review'] }),
    makeLane({ id: 'worker-script', model: 'llm-tuner', provider: 'script', script: true, taskClasses: ['code_generate'] }),
  ];
  const g = buildWorkflowGraph({ lanes, instances: [], topology: [], models: { overrides: {}, ollamaModels: ['qwen2.5:7b'], claudeModels: ['claude-sonnet'] }, now: FIXED_NOW });
  const loops = g.nodes.filter(n => n.kind === 'loop');
  assert.equal(loops.length, 3);
  const byId = new Map(loops.map(n => [n.id, n]));
  assert.equal(byId.get('worker-ollama').model.provider, 'local');
  assert.equal(byId.get('worker-cloud').model.provider, 'cloud');
  assert.equal(byId.get('worker-script').model.provider, 'script');
});

test('null taskClasses: lane claims every source', () => {
  const topology = [{ name: 'change_review', slug: 'change-review', priority: 5, reasoningTier: 'low', workerType: 'ornith', liveCounts: { pending: 1, drafting: 0 } }];
  const lanes = [makeLane({ id: 'worker-any', taskClasses: null })];
  const g = buildWorkflowGraph({ lanes, instances: [], topology, models: { overrides: {}, ollamaModels: [], claudeModels: [] }, now: FIXED_NOW });
  const claims = g.edges.filter(e => e.kind === 'claims');
  assert.equal(claims.length, 1);
  assert.equal(claims[0].from, 'source:change_review');
  assert.equal(claims[0].to, 'worker-any');
});

test('filtered taskClasses: lane claims only matching source', () => {
  const topology = [
    { name: 'change_review', slug: 'change-review', priority: 5, reasoningTier: 'low', workerType: 'ornith', liveCounts: { pending: 1, drafting: 0 } },
    { name: 'brain_dump_sort', slug: 'brain-dump-sort', priority: 8, reasoningTier: 'low', workerType: 'ornith', liveCounts: { pending: 0, drafting: 1 } },
  ];
  const lanes = [makeLane({ id: 'worker-select', taskClasses: ['change_review'] })];
  const g = buildWorkflowGraph({ lanes, instances: [], topology, models: { overrides: {}, ollamaModels: [], claudeModels: [] }, now: FIXED_NOW });
  const claims = g.edges.filter(e => e.kind === 'claims');
  assert.equal(claims.length, 1);
  assert.equal(claims[0].from, 'source:change_review');
  assert.equal(claims[0].to, 'worker-select');
});

test('drafting lane with reviewer true gets reviews edge to reviewerId loop', () => {
  const lanes = [
    makeLane({ id: 'worker-d1', reviewer: true, reviewerId: 'reviewer-d1' }),
    makeLane({ id: 'worker-d2' }),
  ];
  const g = buildWorkflowGraph({ lanes, instances: [], topology: [], models: { overrides: {}, ollamaModels: [], claudeModels: [] }, now: FIXED_NOW });
  const reviews = g.edges.filter(e => e.kind === 'reviews');
  const toReviewerD1 = reviews.filter(e => e.to === 'reviewer-d1');
  assert.ok(toReviewerD1.length >= 1, 'worker-d1 should have a reviews edge to reviewer-d1');
});

test('reviewer loops get applies edge to service:apply-loop', () => {
  const lanes = [makeLane({ id: 'worker-r1', reviewer: true, reviewerId: 'reviewer-r1' })];
  const g = buildWorkflowGraph({ lanes, instances: [], topology: [], models: { overrides: {}, ollamaModels: [], claudeModels: [] }, now: FIXED_NOW });
  const applies = g.edges.filter(e => e.kind === 'applies' && e.to === 'service:apply-loop');
  assert.ok(applies.length >= 1, 'reviewer loop should have applies edge to apply-loop');
  const ids = applies.map(e => e.from);
  assert.ok(ids.includes('reviewer-r1'), 'reviewer-r1 should apply');
});

test('expected lane with no instance becomes offline placeholder', () => {
  const lanes = [makeLane({ id: 'worker-x', reviewer: true, reviewerId: 'reviewer-x' })];
  const g = buildWorkflowGraph({ lanes, instances: [], topology: [], models: { overrides: {}, ollamaModels: [], claudeModels: [] }, now: FIXED_NOW });
  const offline = g.nodes.find(n => n.id === 'reviewer-x');
  assert.ok(offline, 'reviewer-x should exist as a node');
  assert.equal(offline.kind, 'loop');
  assert.equal(offline.runtime.status, 'offline');
});

test('models.overrides marks overridden true', () => {
  const lanes = [makeLane({ id: 'worker-3090' })];
  const instances = [makeInstance('worker-3090', { model: 'qwen2.5:14b' })];
  const g = buildWorkflowGraph({ lanes, instances, topology: [], models: { overrides: { 'worker-3090': 'qwen2.5:14b' }, ollamaModels: [], claudeModels: [] }, now: FIXED_NOW });
  const loop = g.nodes.find(n => n.id === 'worker-3090');
  assert.equal(loop.model.overridden, true);
  assert.equal(loop.model.name, 'qwen2.5:14b');
});

test('topology entry with variantOf gives refines edge', () => {
  const topology = [
    { name: 'arch_import_review', slug: 'arch-import-review', priority: 5, reasoningTier: 'low', workerType: 'ornith', variantOf: 'arch_review', liveCounts: { pending: 0, drafting: 1 } },
    { name: 'arch_review', slug: 'arch-review', priority: 5, reasoningTier: 'high', workerType: 'reasoning', liveCounts: { pending: 1, drafting: 0 } },
  ];
  const g = buildWorkflowGraph({ lanes: [], instances: [], topology, models: { overrides: {}, ollamaModels: [], claudeModels: [] }, now: FIXED_NOW });
  const refines = g.edges.filter(e => e.kind === 'refines');
  assert.equal(refines.length, 1);
  assert.equal(refines[0].from, 'source:arch_import_review');
  assert.equal(refines[0].to, 'source:arch_review');
});

test('legacy instances (worker-p40, reviewer-p40) without lanes become loop nodes', () => {
  const instances = [
    makeInstance('worker-p40', { model: 'llama3:8b', status: 'working' }),
    makeInstance('reviewer-p40', { model: 'llama3:8b', status: 'working' }),
  ];
  const g = buildWorkflowGraph({ lanes: [], instances, topology: [], models: { overrides: {}, ollamaModels: ['llama3:8b'], claudeModels: [] }, now: FIXED_NOW });
  const p40 = g.nodes.find(n => n.id === 'worker-p40');
  const rp40 = g.nodes.find(n => n.id === 'reviewer-p40');
  assert.ok(p40, 'worker-p40 should exist');
  assert.ok(rp40, 'reviewer-p40 should exist');
  assert.equal(p40.kind, 'loop');
  assert.equal(p40.model.provider, 'local');
  assert.equal(p40.work, null);
  assert.equal(rp40.kind, 'loop');
});

test('watchdog instance becomes service:watchdog', () => {
  const instances = [makeInstance('watchdog', { status: 'working', pid: 42 })];
  const g = buildWorkflowGraph({ lanes: [], instances, topology: [], models: { overrides: {}, ollamaModels: [], claudeModels: [] }, now: FIXED_NOW });
  const w = g.nodes.find(n => n.id === 'service:watchdog');
  assert.ok(w, 'service:watchdog should exist');
  assert.equal(w.kind, 'service');
  assert.equal(w.runtime.status, 'working');
  assert.equal(w.runtime.pid, 42);
});

test('service:apply-loop exists with null runtime when no apply-loop instance', () => {
  const g = buildWorkflowGraph({ lanes: [], instances: [], topology: [], models: { overrides: {}, ollamaModels: [], claudeModels: [] }, now: FIXED_NOW });
  const a = g.nodes.find(n => n.id === 'service:apply-loop');
  assert.ok(a, 'service:apply-loop should always exist');
  assert.equal(a.kind, 'service');
  assert.equal(a.runtime, null);
});

test('host lane with reviewerId "reviewer" produces ONE reviews edge (not two)', () => {
  // The host lane has reviewer:true, reviewerId:'reviewer'. It should get exactly one reviews edge
  // from rule 1 (to its reviewerId), and rule 2 should NOT apply because it IS a reviewer lane.
  const lanes = [
    { id: 'worker-host', gpu: '3090', model: 'qwen2.5:35b', tier: 35, preempt: 'always', reviewer: true, reviewerId: 'reviewer', taskClasses: null, env: {}, local: true, slow: false, numCtx: null, numBatch: null, reserve: 'auto',
      instanceId: 'worker-host', status: 'working', pid: 1, model: 'qwen2.5:35b', currentTaskId: null, currentPass: null, lastHeartbeat: '2026-01-01T00:00:00Z', heartbeatAgeSeconds: 0, stateAgeSeconds: 0, stale: false, staleThresholdSeconds: 120, switchable: true, disabled: false, hub: null, projectLabel: null, borrowed: false },
    makeLane({ id: 'worker-other' }),
  ];
  const instances = [makeInstance('worker-host', { model: 'qwen2.5:35b' })];
  const g = buildWorkflowGraph({ lanes, instances, topology: [], models: { overrides: {}, ollamaModels: [], claudeModels: [] }, now: FIXED_NOW });
  const reviewsFromHost = g.edges.filter(e => e.kind === 'reviews' && e.from === 'worker-host');
  assert.equal(reviewsFromHost.length, 1, `expected exactly 1 reviews edge from worker-host, got ${reviewsFromHost.length}: ${reviewsFromHost.map(e=>e.to).join(',')}`);
  assert.equal(reviewsFromHost[0].to, 'reviewer');
});

test('counts default missing states to 0', () => {
  const topology = [
    { name: 's1', slug: 's1', priority: 1, reasoningTier: 'low', workerType: 'ornith', liveCounts: { pending: 3 } },
    { name: 's2', slug: 's2', priority: 2, reasoningTier: 'low', workerType: 'ornith', liveCounts: {} },
    { name: 's3', slug: 's3', priority: 3, reasoningTier: 'low', workerType: 'ornith', liveCounts: null },
  ];
  const g = buildWorkflowGraph({ lanes: [], instances: [], topology, models: { overrides: {}, ollamaModels: [], claudeModels: [] }, now: FIXED_NOW });
  const s1 = g.nodes.find(n => n.id === 'source:s1');
  const s2 = g.nodes.find(n => n.id === 'source:s2');
  const s3 = g.nodes.find(n => n.id === 'source:s3');
  assert.deepEqual(s1.counts, { pending: 3, drafting: 0 });
  assert.deepEqual(s2.counts, { pending: 0, drafting: 0 });
  assert.deepEqual(s3.counts, { pending: 0, drafting: 0 });
});

test('null/undefined/wrong-type inputs produce warnings and never throw', () => {
  const cases = [
    { lanes: null, label: 'lanes=null' },
    { lanes: undefined, label: 'lanes=undefined' },
    { lanes: 'string', label: 'lanes=string' },
    { lanes: {}, label: 'lanes=object' },
    { instances: null, label: 'instances=null' },
    { topology: 42, label: 'topology=number' },
    { models: 'x', label: 'models=string' },
  ];
  for (const c of cases) {
    const opts = { lanes: [], instances: [], topology: [], models: { overrides: {}, ollamaModels: [], claudeModels: [] }, now: FIXED_NOW };
    opts[c.label.split('=')[0]] = c[c.label.split('=')[1]];
    let threw = false;
    let result;
    try { result = buildWorkflowGraph(opts); } catch (e) { threw = true; }
    assert.equal(threw, false, `${c.label} should not throw`);
    assert.ok(result.warnings.length >= 1, `${c.label} should have a warning`);
    // Stages (5) + services (2) always exist per contract; no loops/sources/derived edges
    assert.equal(result.nodes.filter(n => n.kind === 'stage').length, 5, `${c.label} should have 5 stage nodes`);
    assert.equal(result.nodes.filter(n => n.kind === 'service').length, 2, `${c.label} should have 2 service nodes`);
    assert.equal(result.nodes.filter(n => n.kind === 'loop').length, 0, `${c.label} should have no loop nodes`);
    assert.equal(result.nodes.filter(n => n.kind === 'source').length, 0, `${c.label} should have no source nodes`);
    assert.equal(result.edges.filter(e => e.kind !== 'produces').length, 0, `${c.label} should have no derived edges`);
  }
});

test('two calls with same input and now are deepEqual', () => {
  const input = {
    lanes: [makeLane({ id: 'worker-a' }), makeLane({ id: 'worker-b' })],
    instances: [makeInstance('worker-a', { model: 'm1' })],
    topology: [{ name: 'src1', slug: 'src1', priority: 1, reasoningTier: 'low', workerType: 'ornith', liveCounts: { pending: 1, drafting: 0 } }],
    models: { overrides: {}, ollamaModels: ['m1'], claudeModels: [] },
    now: FIXED_NOW,
  };
  const a = buildWorkflowGraph(input);
  const b = buildWorkflowGraph(input);
  assert.deepEqual(a, b);
});

test('CLI round-trips a fixture and returns exit 1 for bad input', () => {
  // Write a fixture
  const tmpDir = '/tmp/workflow-graph-test';
  try { require('node:fs').mkdirSync(tmpDir, { recursive: true }); } catch {}
  const fixture = {
    lanes: [makeLane({ id: 'worker-cli' })],
    instances: [makeInstance('worker-cli', { model: 'test' })],
    topology: [{ name: 's', slug: 's', priority: 1, reasoningTier: 'low', workerType: 'ornith', liveCounts: { pending: 0, drafting: 0 } }],
    models: { overrides: {}, ollamaModels: [], claudeModels: [] },
  };
  const fixturePath = path.join(tmpDir, 'fixture.json');
  fs.writeFileSync(fixturePath, JSON.stringify(fixture));

  // Round-trip
  const ok = spawnSync('node', ['src/workflow-graph.js', '--stdin'], { input: fs.readFileSync(fixturePath), encoding: 'utf8', cwd: path.join(__dirname, '..') });
  assert.equal(ok.status, 0, `CLI should exit 0, got ${ok.status}: ${ok.stderr}`);
  const parsed = JSON.parse(ok.stdout);
  assert.equal(parsed.schemaVersion, 1);
  assert.ok(parsed.nodes.length > 0);

  // Bad JSON -> exit 1
  const bad = spawnSync('node', ['src/workflow-graph.js', '--stdin'], { input: 'not json{{{', encoding: 'utf8', cwd: path.join(__dirname, '..') });
  assert.equal(bad.status, 1, `CLI should exit 1 for bad JSON, got ${bad.status}: ${bad.stderr}`);
  const badParsed = JSON.parse(bad.stderr);
  assert.ok(badParsed.error, 'error output should be JSON with an error field');
});

test('stage nodes and produces edges exist', () => {
  const g = buildWorkflowGraph({ lanes: [], instances: [], topology: [], models: { overrides: {}, ollamaModels: [], claudeModels: [] }, now: FIXED_NOW });
  const stages = g.nodes.filter(n => n.kind === 'stage').map(n => n.id).sort();
  assert.deepEqual(stages, ['stage:apply', 'stage:implement', 'stage:orient', 'stage:plan', 'stage:review']);
  const produces = g.edges.filter(e => e.kind === 'produces');
  assert.equal(produces.length, 4);
  // The chain orient -> plan -> implement -> review -> apply must all be present
  const chain = ['orient', 'plan', 'implement', 'review', 'apply'];
  for (let i = 0; i < chain.length - 1; i++) {
    const from = `stage:${chain[i]}`;
    const to = `stage:${chain[i + 1]}`;
    const edge = produces.find(e => e.from === from && e.to === to);
    assert.ok(edge, `should have produces edge ${from} -> ${to}`);
  }
});

test('output is sorted: nodes by kind then id, edges by id', () => {
  const lanes = [makeLane({ id: 'worker-z' }), makeLane({ id: 'worker-a' })];
  const topology = [{ name: 'z_src', slug: 'z-src', priority: 1, reasoningTier: 'low', workerType: 'ornith', liveCounts: {} }, { name: 'a_src', slug: 'a-src', priority: 2, reasoningTier: 'low', workerType: 'ornith', liveCounts: {} }];
  const g = buildWorkflowGraph({ lanes, instances: [], topology, models: { overrides: {}, ollamaModels: [], claudeModels: [] }, now: FIXED_NOW });
  const nodeIds = g.nodes.map(n => n.id);
  // stages first, then services, then loops, then sources
  const stageIdx = nodeIds.indexOf('stage:orient');
  const loopIdx = nodeIds.indexOf('loop');
  const sourceIdx = nodeIds.indexOf('source:a_src');
  assert.ok(stageIdx < nodeIds.indexOf('service:watchdog'), 'stages before services');
  assert.ok(nodeIds.indexOf('service:watchdog') < nodeIds.indexOf('worker-a'), 'services before loops');
  assert.ok(nodeIds.indexOf('worker-a') < nodeIds.indexOf('worker-z'), 'loops sorted by id');
  assert.ok(nodeIds.indexOf('worker-z') < sourceIdx, 'loops before sources');
  // edges sorted by id
  const edgeIds = g.edges.map(e => e.id);
  const sorted = [...edgeIds].sort();
  assert.deepEqual(edgeIds, sorted);
});

// ---- corrective piece: the plain "reviewer" loop node ----

const EMPTY_MODELS = { overrides: {}, ollamaModels: [], claudeModels: [] };
const hostLane = () => makeLane({ id: 'worker-host', gpu: '3090', reviewer: true, reviewerId: 'reviewer', local: true });

test('a host lane with reviewerId "reviewer" and a reviewer instance gets ONE reviewer node built from that instance', () => {
  const g = buildWorkflowGraph({
    lanes: [hostLane()],
    instances: [makeInstance('worker-host'), makeInstance('reviewer', { status: 'working' })],
    topology: [], models: EMPTY_MODELS, now: FIXED_NOW,
  });
  const nodes = g.nodes.filter(n => n.id === 'reviewer');
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].kind, 'loop');
  assert.equal(nodes[0].runtime.instanceId, 'reviewer');
  assert.equal(nodes[0].runtime.status, 'working');
  const reviews = g.edges.filter(e => e.kind === 'reviews' && e.to === 'reviewer');
  assert.deepEqual(reviews.map(e => e.from), ['worker-host']);
});

test('the same lane with no reviewer instance still gets an offline reviewer node', () => {
  const g = buildWorkflowGraph({ lanes: [hostLane()], instances: [makeInstance('worker-host')], topology: [], models: EMPTY_MODELS, now: FIXED_NOW });
  const nodes = g.nodes.filter(n => n.id === 'reviewer');
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].runtime.status, 'offline');
});

test('every edge endpoint is a node id and node ids are unique', () => {
  const cases = [
    { lanes: [hostLane()], instances: [makeInstance('worker-host'), makeInstance('reviewer')] },
    { lanes: [hostLane()], instances: [makeInstance('worker-host')] },
    { lanes: [], instances: [makeInstance('worker-p40'), makeInstance('reviewer-p40')] },
  ];
  for (const c of cases) {
    const g = buildWorkflowGraph({ ...c, topology: [], models: EMPTY_MODELS, now: FIXED_NOW });
    const ids = g.nodes.map(n => n.id);
    assert.equal(new Set(ids).size, ids.length, 'node ids are unique');
    for (const e of g.edges) {
      assert.ok(ids.includes(e.from), `edge ${e.id} starts at a missing node`);
      assert.ok(ids.includes(e.to), `edge ${e.id} ends at a missing node`);
    }
  }
});

test('the reviewer case builds the same graph on every call', () => {
  const input = { lanes: [hostLane()], instances: [makeInstance('worker-host'), makeInstance('reviewer')], topology: [], models: EMPTY_MODELS, now: FIXED_NOW };
  const copy = { ...JSON.parse(JSON.stringify({ lanes: input.lanes, instances: input.instances, topology: input.topology, models: input.models })), now: FIXED_NOW };
  assert.deepEqual(buildWorkflowGraph(input), buildWorkflowGraph(copy));
});

test('a reviewer instance already used as a legacy loop is not built a second time', () => {
  const lane = makeLane({ id: 'worker-d1', reviewer: true, reviewerId: 'reviewer-d1' });
  const g = buildWorkflowGraph({ lanes: [lane], instances: [makeInstance('worker-d1'), makeInstance('reviewer-d1')], topology: [], models: EMPTY_MODELS, now: FIXED_NOW });
  assert.equal(g.nodes.filter(n => n.id === 'reviewer-d1').length, 1);
});

test('a reviewerId that is itself a lane id does not add a second node', () => {
  const lanes = [makeLane({ id: 'worker-a', reviewer: true, reviewerId: 'worker-b' }), makeLane({ id: 'worker-b' })];
  const g = buildWorkflowGraph({ lanes, instances: [makeInstance('worker-a')], topology: [], models: EMPTY_MODELS, now: FIXED_NOW });
  assert.equal(g.nodes.filter(n => n.id === 'worker-b').length, 1);
});

// ---- workflow overlay (piece W-C2) ----

const OVERLAY_INPUT = () => ({
  lanes: [makeLane({ id: 'worker-a', gpu: 'a' }), makeLane({ id: 'worker-b', gpu: 'b' })],
  instances: [makeInstance('worker-a')],
  topology: [{ name: 's1', slug: 's1', priority: 1, reasoningTier: 'low', workerType: 'ornith', liveCounts: { pending: 2 } }],
  models: { overrides: {}, ollamaModels: [], claudeModels: [] },
  now: FIXED_NOW,
});

test('the builder with a workflow config has the groups, parents, labels and authored edges', () => {
  const g = buildWorkflowGraph({ ...OVERLAY_INPUT(), workflow: { schemaVersion: 1, groups: [{ id: 'group:gpus', label: 'GPUs', children: ['worker-a', 'worker-b'], collapsed: true }], edges: [{ from: 'source:s1', to: 'worker-b', kind: 'triggers', label: 'manual' }], labels: { 'worker-a': 'Alpha' } } });
  assert.deepEqual(g.groups, [{ id: 'group:gpus', label: 'GPUs', children: ['worker-a', 'worker-b'], collapsed: true }]);
  assert.equal(g.nodes.find((n) => n.id === 'worker-a').parent, 'group:gpus');
  assert.equal(g.nodes.find((n) => n.id === 'worker-b').parent, 'group:gpus');
  assert.equal(g.nodes.find((n) => n.id === 'worker-a').label, 'Alpha');
  assert.ok(g.edges.some((e) => e.id === 'source:s1->worker-b:triggers' && e.label === 'manual'));
});

test('the builder without a workflow config, or with an empty one, returns the graph as it was built: no groups, no parents, same nodes and edges', () => {
  const plain = buildWorkflowGraph(OVERLAY_INPUT());
  assert.deepEqual(plain.groups, []);
  assert.ok(plain.nodes.every((n) => n.parent === null));
  for (const workflow of [undefined, null, {}, { schemaVersion: 1, groups: [], edges: [], labels: {} }, 'x', []]) {
    assert.deepEqual(buildWorkflowGraph({ ...OVERLAY_INPUT(), workflow }), plain, JSON.stringify(workflow));
  }
});

test('the builder CLI passes a workflow key through to the overlay', () => {
  const input = JSON.stringify({ ...OVERLAY_INPUT(), now: undefined, workflow: { schemaVersion: 1, groups: [{ id: 'group:x', children: ['worker-a'] }] } });
  const out = spawnSync(process.execPath, [path.join(__dirname, 'workflow-graph.js'), '--stdin'], { input, encoding: 'utf8' });
  assert.equal(out.status, 0);
  assert.equal(JSON.parse(out.stdout).groups[0].id, 'group:x');
});

test('the builder with watchdogScripts adds the service nodes and triggers edges, and without them is unchanged', () => {
  const plain = buildWorkflowGraph(OVERLAY_INPUT());
  const g = buildWorkflowGraph({ ...OVERLAY_INPUT(), watchdogScripts: [{ plugin: 'uiforge', root: '/r', script: 'harness/watchdog-trigger.js', abs: '/r/harness/watchdog-trigger.js' }] });
  const id = 'service:watchdog-script:uiforge:watchdog-trigger';
  assert.ok(g.nodes.some((n) => n.id === id && n.kind === 'service'));
  assert.ok(g.edges.some((e) => e.id === `service:watchdog->${id}:triggers` && e.kind === 'triggers'));
  for (const watchdogScripts of [undefined, null, [], 'x']) assert.deepEqual(buildWorkflowGraph({ ...OVERLAY_INPUT(), watchdogScripts }), plain, JSON.stringify(watchdogScripts));
  const grouped = buildWorkflowGraph({ ...OVERLAY_INPUT(), watchdogScripts: [{ plugin: 'uiforge', script: 'a.js' }], workflow: { schemaVersion: 1, groups: [{ id: 'group:wd', children: ['service:watchdog', 'service:watchdog-script:uiforge:a'] }], edges: [], labels: {} } });
  assert.equal(grouped.nodes.find((n) => n.id === 'service:watchdog-script:uiforge:a').parent, 'group:wd');
});
