'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { splitNode } = require('./workflow-split.js');

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); }
  return o;
}
function edge(from, to, kind) { return { id: `${from}->${to}:${kind}`, from, to, kind, label: null }; }
function loop(id, work) {
  return { id, kind: 'loop', label: id, parent: null, runtime: { status: 'idle' }, model: { name: 'big', provider: 'local', tierB: null, overridden: false, choices: { local: [], cloud: [] } }, work, counts: null };
}
function makeGraph(work) {
  return {
    schemaVersion: 1,
    nodes: [
      { id: 'stage:review', kind: 'stage', label: 'review', parent: null, runtime: null, model: null, work: null, counts: null },
      loop('reviewer', null),
      loop('worker-big', work === undefined ? { taskClasses: ['a', 'b'], preempt: 'never', reviewer: true } : work),
      { id: 'source:a', kind: 'source', label: 'a', parent: null, runtime: null, model: null, work: null, counts: { pending: 1, drafting: 0 } },
      { id: 'source:b', kind: 'source', label: 'b', parent: null, runtime: null, model: null, work: null, counts: { pending: 0, drafting: 0 } },
    ],
    edges: [
      edge('source:a', 'worker-big', 'claims'),
      edge('source:b', 'worker-big', 'claims'),
      edge('worker-big', 'reviewer', 'reviews'),
      edge('source:a', 'stage:review', 'feeds'),
    ],
    groups: [],
    warnings: [],
  };
}
const P1 = { id: 'worker-s1', label: 'Small 1', model: { name: 'small', provider: 'local' }, taskClasses: ['a'] };
const P2 = { id: 'worker-s2', label: 'Small 2', model: { name: 'small', provider: 'local' }, taskClasses: ['b'] };

test('splits a loop into two parts with the right node shape', () => {
  const r = splitNode(makeGraph(), 'worker-big', [P1, P2]);
  assert.equal(r.ok, true);
  const ids = r.graph.nodes.map((n) => n.id);
  assert.ok(!ids.includes('worker-big'));
  const s1 = r.graph.nodes.find((n) => n.id === 'worker-s1');
  assert.deepEqual(s1, {
    id: 'worker-s1', kind: 'loop', label: 'Small 1', parent: null, runtime: null,
    model: { name: 'small', provider: 'local', tierB: null, overridden: false, choices: { local: [], cloud: [] } },
    work: { taskClasses: ['a'], preempt: 'never', reviewer: true }, counts: null,
  });
  assert.equal(r.graph.nodes.find((n) => n.id === 'worker-s2').work.taskClasses[0], 'b');
});

test('every incoming and outgoing edge exists once per part with a rebuilt id; the rest is untouched', () => {
  const g = makeGraph();
  const r = splitNode(g, 'worker-big', [P1, P2]);
  assert.deepEqual(r.graph.edges.map((e) => e.id), [
    'source:a->stage:review:feeds',
    'source:a->worker-s1:claims', 'source:a->worker-s2:claims',
    'source:b->worker-s1:claims', 'source:b->worker-s2:claims',
    'worker-s1->reviewer:reviews', 'worker-s2->reviewer:reviews',
  ]);
  assert.deepEqual(r.graph.edges.find((e) => e.id === 'source:a->stage:review:feeds'), g.edges[3]);
  assert.ok(!r.graph.edges.some((e) => e.from === 'worker-s1' && e.to === 'worker-s2'));
  assert.deepEqual(r.graph.nodes.find((n) => n.id === 'source:a'), g.nodes[3]);
  assert.deepEqual(r.graph.nodes.find((n) => n.id === 'reviewer'), g.nodes[1]);
});

test('three parts give three nodes and three copies of each edge', () => {
  const r = splitNode(makeGraph(), 'worker-big', [P1, P2, { id: 'worker-s3', label: 'S3', model: null, taskClasses: ['a', 'b'] }]);
  assert.equal(r.ok, true);
  assert.equal(r.graph.nodes.filter((n) => n.kind === 'loop').length, 4);
  assert.equal(r.graph.edges.filter((e) => e.kind === 'claims').length, 6);
  assert.equal(r.graph.edges.filter((e) => e.kind === 'reviews').length, 3);
});

test('a cloud provider and a null model are kept as given; a missing label falls back to the id', () => {
  const r = splitNode(makeGraph(), 'worker-big', [
    { id: 'c1', label: 'Cloud', model: { name: 'haiku', provider: 'cloud' }, taskClasses: ['a'] },
    { id: 'c2', model: null, taskClasses: ['b'] },
  ]);
  assert.equal(r.graph.nodes.find((n) => n.id === 'c1').model.provider, 'cloud');
  assert.equal(r.graph.nodes.find((n) => n.id === 'c1').model.name, 'haiku');
  assert.equal(r.graph.nodes.find((n) => n.id === 'c2').model, null);
  assert.equal(r.graph.nodes.find((n) => n.id === 'c2').label, 'c2');
  const s = splitNode(makeGraph(), 'worker-big', [{ id: 'x1', model: { provider: 'script' }, taskClasses: ['a'] }, P2]);
  assert.equal(s.graph.nodes.find((n) => n.id === 'x1').model.provider, 'script');
  assert.equal(s.graph.nodes.find((n) => n.id === 'x1').model.name, null);
});

test('refusals name the cause', () => {
  const g = makeGraph();
  assert.deepEqual(splitNode(g, 'nope', [P1, P2]), { ok: false, error: 'unknown node: nope' });
  assert.deepEqual(splitNode(g, 'source:a', [P1, P2]), { ok: false, error: 'node is not a loop: source:a' });
  assert.deepEqual(splitNode(g, 'worker-big', [P1]), { ok: false, error: 'split needs at least 2 parts' });
  assert.deepEqual(splitNode(g, 'worker-big', []), { ok: false, error: 'split needs at least 2 parts' });
  assert.deepEqual(splitNode(g, 'worker-big', [P1, { ...P2, id: '' }]), { ok: false, error: 'a part id must be a non-empty string' });
  assert.deepEqual(splitNode(g, 'worker-big', [P1, { ...P2, id: 'worker-s1' }]), { ok: false, error: 'duplicate part id: worker-s1' });
  assert.deepEqual(splitNode(g, 'worker-big', [P1, { ...P2, id: 'reviewer' }]), { ok: false, error: 'part id is already a node id: reviewer' });
  assert.deepEqual(splitNode(g, 'worker-big', [P1, { ...P2, model: { name: 'x', provider: 'remote' } }]),
    { ok: false, error: 'invalid provider for part worker-s2: must be local, cloud or script' });
  assert.equal(splitNode(g, 'worker-big', [P1, { ...P2, id: 'worker-big' }]).ok, false);
});

test('the orphan rule: partial cover refused, full cover accepted, null part covers all, an original that claims anything accepts arrays', () => {
  const g = makeGraph();
  const refused = splitNode(g, 'worker-big', [P1, { ...P1, id: 'worker-s2' }]);
  assert.deepEqual(refused, { ok: false, error: 'split would orphan task classes: b' });
  assert.equal(splitNode(g, 'worker-big', [P1, P2]).ok, true);
  assert.equal(splitNode(g, 'worker-big', [P1, { ...P2, taskClasses: null }]).ok, true);
  assert.equal(splitNode(g, 'worker-big', [{ ...P1, taskClasses: ['a', 'b'] }, { ...P2, taskClasses: [] }]).ok, true);
  const any = makeGraph({ taskClasses: null, preempt: 'never', reviewer: false });
  assert.equal(splitNode(any, 'worker-big', [P1, P2]).ok, true);
  assert.equal(splitNode(any, 'worker-big', [{ ...P1, taskClasses: null }, P2]).ok, true);
  assert.equal(splitNode(g, 'worker-big', [P1, { ...P2, taskClasses: 'b' }]).ok, false);
});

test('a loop without a work object splits with null preempt and reviewer', () => {
  const r = splitNode(makeGraph(null), 'worker-big', [P1, P2]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.graph.nodes.find((n) => n.id === 'worker-s1').work, { taskClasses: ['a'], preempt: null, reviewer: null });
});

test('parts inherit the parent and a group that listed the original lists the parts', () => {
  const g = makeGraph();
  g.nodes.find((n) => n.id === 'worker-big').parent = 'group:gpus';
  g.groups = [{ id: 'group:gpus', label: 'GPU', children: ['reviewer', 'worker-big'], collapsed: false }, { id: 'group:o', label: 'O', children: ['source:a'], collapsed: true }];
  const r = splitNode(g, 'worker-big', [P1, P2]);
  assert.equal(r.graph.nodes.find((n) => n.id === 'worker-s2').parent, 'group:gpus');
  assert.deepEqual(r.graph.groups[0].children, ['reviewer', 'worker-s1', 'worker-s2']);
  assert.deepEqual(r.graph.groups[1], g.groups[1]);
});

test('a self-edge on the original becomes one edge per part on that part', () => {
  const g = makeGraph();
  g.edges.push(edge('worker-big', 'worker-big', 'triggers'));
  const r = splitNode(g, 'worker-big', [P1, P2]);
  assert.ok(r.graph.edges.some((e) => e.id === 'worker-s1->worker-s1:triggers'));
  assert.ok(!r.graph.edges.some((e) => e.from === 'worker-s1' && e.to === 'worker-s2'));
});

test('the input graph and parts are not mutated (deep-frozen), and the output is sorted and deterministic', () => {
  const g = deepFreeze(makeGraph());
  const parts = deepFreeze([{ ...P2 }, { ...P1 }]);
  const r = splitNode(g, 'worker-big', parts);
  assert.equal(r.ok, true);
  const kinds = { stage: 0, service: 1, loop: 2, source: 3 };
  const sorted = r.graph.nodes.slice().sort((a, b) => (kinds[a.kind] - kinds[b.kind]) || (a.id < b.id ? -1 : 1));
  assert.deepEqual(r.graph.nodes.map((n) => n.id), sorted.map((n) => n.id));
  assert.deepEqual(r.graph.edges.map((e) => e.id), r.graph.edges.map((e) => e.id).slice().sort());
  assert.deepEqual(splitNode(g, 'worker-big', parts), r);
  assert.deepEqual(r.graph.nodes.filter((n) => n.kind === 'loop').map((n) => n.id), ['reviewer', 'worker-s1', 'worker-s2']);
});

test('null, undefined and non-array inputs return ok false and never throw', () => {
  [null, undefined, 1, 'x', [], {}, { nodes: [] }, { nodes: {}, edges: [] }, { nodes: [null], edges: [] }].forEach((g) => {
    const r = splitNode(g, 'worker-big', [P1, P2]);
    assert.equal(r.ok, false);
    assert.equal(typeof r.error, 'string');
  });
  [null, undefined, 'x', {}, [null, null], [1, 2]].forEach((p) => assert.equal(splitNode(makeGraph(), 'worker-big', p).ok, false));
  assert.equal(splitNode(makeGraph(), undefined, [P1, P2]).ok, false);
});

test('bad part fields are refused with their own error text', () => {
  const g = makeGraph();
  assert.deepEqual(splitNode(g, 'worker-big', [P1, null]), { ok: false, error: 'every part must be an object' });
  assert.deepEqual(splitNode(g, 'worker-big', [P1, { ...P2, id: 5 }]), { ok: false, error: 'a part id must be a non-empty string' });
  assert.deepEqual(splitNode(g, 'worker-big', [P1, { ...P2, taskClasses: 'b' }]), { ok: false, error: 'taskClasses of part worker-s2 must be an array or null' });
  assert.deepEqual(splitNode(g, 'worker-big', [P1, { ...P2, model: 'small' }]),
    { ok: false, error: 'invalid provider for part worker-s2: must be local, cloud or script' });
  assert.deepEqual(splitNode(null, 'worker-big', [P1, P2]), { ok: false, error: 'graph must have nodes and edges' });
});

test('an original whose taskClasses is not an array claims anything', () => {
  const g = makeGraph({ taskClasses: 'a', preempt: 'never', reviewer: true });
  assert.equal(splitNode(g, 'worker-big', [P1, P2]).ok, true);
});

test('a part with taskClasses null keeps null, and the part array is a copy', () => {
  const g = makeGraph();
  const parts = [{ ...P1, taskClasses: null }, { ...P2 }];
  const r = splitNode(g, 'worker-big', parts);
  assert.equal(r.graph.nodes.find((n) => n.id === 'worker-s1').work.taskClasses, null);
  const copy = r.graph.nodes.find((n) => n.id === 'worker-s2').work.taskClasses;
  assert.deepEqual(copy, ['b']);
  assert.notEqual(copy, parts[1].taskClasses);
});

test('duplicate input edges are emitted once, a label is kept on every copy, an unrelated edge is kept as it was', () => {
  const g = makeGraph();
  g.edges.push({ ...g.edges[0] });
  g.edges[2] = { ...g.edges[2], label: 'checks' };
  g.edges[3] = { ...g.edges[3], extra: 1 };
  const r = splitNode(g, 'worker-big', [P1, P2]);
  assert.equal(r.graph.edges.filter((e) => e.id === 'source:a->worker-s1:claims').length, 1);
  assert.equal(r.graph.edges.length, 7);
  assert.deepEqual(r.graph.edges.filter((e) => e.kind === 'reviews').map((e) => e.label), ['checks', 'checks']);
  assert.deepEqual(r.graph.edges.find((e) => e.kind === 'feeds'), g.edges[3]);
});

test('other graph fields are kept, a graph without groups gets none, and a throwing node is a refusal', () => {
  const r = splitNode(makeGraph(), 'worker-big', [P1, P2]);
  assert.equal(r.graph.schemaVersion, 1);
  assert.deepEqual(r.graph.warnings, []);
  const g = makeGraph();
  delete g.groups;
  const r2 = splitNode(g, 'worker-big', [P1, P2]);
  assert.equal(r2.ok, true);
  assert.ok(!('groups' in r2.graph));
  const bad = makeGraph();
  bad.nodes.push({ get id() { throw new Error('boom'); }, kind: 'loop' });
  const r3 = splitNode(bad, 'worker-big', [P1, P2]);
  assert.deepEqual(r3, { ok: false, error: 'split failed: boom' });
});
