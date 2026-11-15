'use strict';

// Tests for src/workflow-overlay.js (applyWorkflowConfig). Graphs are built by hand; the builder is not involved.
// Run: node --test src/workflow-overlay.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyWorkflowConfig, addWatchdogScriptNodes } = require('./workflow-overlay.js');

const node = (id, kind, label) => ({ id, kind, label: label || id, parent: null, runtime: null, model: null, work: null, counts: null });
const edge = (from, to, kind, label = null) => ({ id: `${from}->${to}:${kind}`, from, to, kind, label });
const graph = () => ({
  schemaVersion: 1,
  generatedAt: '2026-01-01T00:00:00.000Z',
  nodes: [node('stage:plan', 'stage'), node('service:watchdog', 'service'), node('reviewer', 'loop'), node('worker-a', 'loop', 'A'), node('worker-b', 'loop'), node('source:s1', 'source')],
  edges: [edge('source:s1', 'worker-a', 'claims'), edge('worker-a', 'reviewer', 'reviews', 'derived label'), edge('stage:plan', 'worker-a', 'produces')],
  groups: [],
  warnings: ['from the builder'],
});
const cfg = (over) => ({ schemaVersion: 1, groups: [], edges: [], labels: {}, ...over });
const grp = (id, children, over) => ({ id, label: id, children, collapsed: false, ...over });
function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const parents = (g) => Object.fromEntries(g.nodes.filter((n) => n.parent).map((n) => [n.id, n.parent]));

test('groups listing existing nodes appear with their children, label and collapsed flag, and set the parent of each child', () => {
  const out = applyWorkflowConfig(graph(), cfg({ groups: [grp('group:review', ['reviewer', 'worker-a'], { label: 'Review', collapsed: true })] }));
  assert.deepEqual(out.groups, [{ id: 'group:review', label: 'Review', children: ['reviewer', 'worker-a'], collapsed: true }]);
  assert.deepEqual(parents(out), { reviewer: 'group:review', 'worker-a': 'group:review' });
  assert.deepEqual(out.warnings, ['from the builder']);
});

test('a group without a label uses its id, and collapsed defaults to false', () => {
  const out = applyWorkflowConfig(graph(), cfg({ groups: [{ id: 'group:x', children: ['worker-a'] }] }));
  assert.deepEqual(out.groups, [{ id: 'group:x', label: 'group:x', children: ['worker-a'], collapsed: false }]);
});

test('a child that does not exist is dropped with a warning that names it', () => {
  const out = applyWorkflowConfig(graph(), cfg({ groups: [grp('group:x', ['worker-a', 'ghost'])] }));
  assert.deepEqual(out.groups[0].children, ['worker-a']);
  assert.equal(out.warnings.length, 2);
  assert.match(out.warnings[1], /"ghost"/);
});

test('a group left with no child is dropped with a warning, and so is a group that only held it', () => {
  const out = applyWorkflowConfig(graph(), cfg({ groups: [grp('group:empty', ['ghost']), grp('group:outer', ['group:empty']), grp('group:ok', ['worker-b'])] }));
  assert.deepEqual(out.groups.map((g) => g.id), ['group:ok']);
  assert.equal(out.warnings.filter((w) => /none of its children exists/.test(w)).length, 2);
});

test('a node listed by two groups gets the first group in config order as parent', () => {
  const out = applyWorkflowConfig(graph(), cfg({ groups: [grp('group:one', ['worker-a']), grp('group:two', ['worker-a', 'worker-b'])] }));
  assert.deepEqual(parents(out), { 'worker-a': 'group:one', 'worker-b': 'group:two' });
  assert.deepEqual(out.groups.map((g) => g.children), [['worker-a'], ['worker-a', 'worker-b']]);
});

test('a nested group is kept and node parents follow the group that lists the node', () => {
  const out = applyWorkflowConfig(graph(), cfg({ groups: [grp('group:outer', ['group:inner', 'worker-a']), grp('group:inner', ['worker-b'])] }));
  assert.deepEqual(out.groups.map((g) => g.id), ['group:outer', 'group:inner']);
  assert.deepEqual(out.groups[0].children, ['group:inner', 'worker-a']);
  assert.deepEqual(parents(out), { 'worker-a': 'group:outer', 'worker-b': 'group:inner' });
});

test('a group cannot list itself and a group id is not a node id', () => {
  const out = applyWorkflowConfig(graph(), cfg({ groups: [grp('group:x', ['group:x', 'worker-a'])] }));
  assert.deepEqual(out.groups[0].children, ['worker-a']);
  assert.equal(out.warnings.length, 2);
});

test('labels replace the label of an existing node; an unknown node id gives a warning', () => {
  const out = applyWorkflowConfig(graph(), cfg({ labels: { 'worker-a': 'Alpha', ghost: 'G', 'worker-b': '' } }));
  assert.equal(out.nodes.find((n) => n.id === 'worker-a').label, 'Alpha');
  assert.equal(out.nodes.find((n) => n.id === 'worker-b').label, 'worker-b');
  assert.deepEqual(out.warnings, ['from the builder', 'label for ghost: no such node; ignored']);
});

test('an authored edge between existing nodes is added once, with its label', () => {
  const out = applyWorkflowConfig(graph(), cfg({ edges: [{ from: 'worker-a', to: 'worker-b', kind: 'triggers', label: 'then' }, { from: 'worker-a', to: 'worker-b', kind: 'triggers', label: 'again' }] }));
  const added = out.edges.filter((e) => e.id === 'worker-a->worker-b:triggers');
  assert.deepEqual(added, [{ id: 'worker-a->worker-b:triggers', from: 'worker-a', to: 'worker-b', kind: 'triggers', label: 'then' }]);
  assert.equal(out.edges.length, 4);
});

test('an authored edge with the id of a derived one adds nothing and keeps the derived edge', () => {
  const out = applyWorkflowConfig(graph(), cfg({ edges: [{ from: 'worker-a', to: 'reviewer', kind: 'reviews', label: 'authored' }] }));
  assert.equal(out.edges.length, 3);
  assert.equal(out.edges.find((e) => e.id === 'worker-a->reviewer:reviews').label, 'derived label');
});

test('an authored edge with an unknown endpoint gives a warning and is not added', () => {
  const out = applyWorkflowConfig(graph(), cfg({ edges: [{ from: 'ghost', to: 'worker-a', kind: 'claims', label: null }, { from: 'worker-a', to: 'nobody', kind: 'claims', label: null }] }));
  assert.equal(out.edges.length, 3);
  assert.equal(out.warnings.length, 3);
  assert.match(out.warnings[1], /"ghost"/);
  assert.match(out.warnings[2], /"nobody"/);
});

test('derived edges are never removed or changed', () => {
  const before = graph();
  const out = applyWorkflowConfig(graph(), cfg({ groups: [grp('group:x', ['worker-a'])], labels: { 'worker-a': 'Alpha' }, edges: [{ from: 'worker-b', to: 'worker-a', kind: 'refines', label: null }] }));
  for (const e of before.edges) assert.deepEqual(out.edges.find((x) => x.id === e.id), e);
});

test('nodes stay sorted by kind then id and edges by id', () => {
  const out = applyWorkflowConfig(graph(), cfg({ edges: [{ from: 'worker-b', to: 'worker-a', kind: 'refines', label: null }, { from: 'reviewer', to: 'worker-a', kind: 'triggers', label: null }] }));
  assert.deepEqual(out.nodes.map((n) => n.id), ['stage:plan', 'service:watchdog', 'reviewer', 'worker-a', 'worker-b', 'source:s1']);
  assert.deepEqual(out.edges.map((e) => e.id), [...out.edges.map((e) => e.id)].sort());
  const shuffled = graph();
  shuffled.nodes.reverse();
  assert.deepEqual(applyWorkflowConfig(shuffled, cfg()).nodes.map((n) => n.id), out.nodes.map((n) => n.id));
});

test('two calls with the same input are deepEqual and the input graph and config are not mutated', () => {
  const c = cfg({ groups: [grp('group:x', ['worker-a', 'ghost'])], labels: { 'worker-a': 'Alpha' }, edges: [{ from: 'worker-b', to: 'worker-a', kind: 'refines', label: null }] });
  const a = applyWorkflowConfig(deepFreeze(graph()), deepFreeze(JSON.parse(JSON.stringify(c))));
  const b = applyWorkflowConfig(graph(), c);
  assert.deepEqual(a, b);
  const g = deepFreeze(graph());
  assert.doesNotThrow(() => applyWorkflowConfig(g, deepFreeze(c)));
});

test('no graph or no config returns the input unchanged and nothing throws', () => {
  const g = graph();
  assert.equal(applyWorkflowConfig(g, undefined), g);
  assert.equal(applyWorkflowConfig(g, null), g);
  assert.equal(applyWorkflowConfig(g, [1]), g);
  assert.equal(applyWorkflowConfig(g, 'x'), g);
  assert.equal(applyWorkflowConfig(null, cfg()), null);
  assert.equal(applyWorkflowConfig(undefined, cfg()), undefined);
  const noNodes = { edges: [] };
  assert.equal(applyWorkflowConfig(noNodes, cfg()), noNodes);
  assert.equal(applyWorkflowConfig([], cfg()).length, 0);
});

test('odd config contents are skipped without throwing', () => {
  const out = applyWorkflowConfig(graph(), { groups: 'x', edges: [null, 3, { from: 'worker-a' }], labels: [1] });
  assert.equal(out.nodes.length, 6);
  assert.deepEqual(out.groups, []);
  const mixed = applyWorkflowConfig(graph(), { groups: [null, { id: 5 }, { id: 'group:ok', children: ['worker-a', 7] }], edges: [], labels: { 'worker-a': 9 } });
  assert.deepEqual(mixed.groups.map((g) => g.id), ['group:ok']);
  assert.equal(mixed.nodes.find((n) => n.id === 'worker-a').label, 'A');
});

test('a graph without warnings or edges still gets the overlay warnings', () => {
  const g = { nodes: [node('worker-a', 'loop')] };
  const out = applyWorkflowConfig(g, cfg({ labels: { ghost: 'x' } }));
  assert.deepEqual(out.edges, []);
  assert.equal(out.warnings.length, 1);
});

test('collapsed is true only for the boolean true, and an authored edge without a label gets null', () => {
  for (const collapsed of ['yes', 1, 'true', {}, null]) {
    assert.equal(applyWorkflowConfig(graph(), cfg({ groups: [grp('group:x', ['worker-a'], { collapsed })] })).groups[0].collapsed, false, String(collapsed));
  }
  const out = applyWorkflowConfig(graph(), cfg({ edges: [{ from: 'worker-a', to: 'worker-b', kind: 'triggers' }, { from: 'worker-b', to: 'worker-a', kind: 'refines', label: 7 }] }));
  assert.equal(out.edges.find((e) => e.id === 'worker-a->worker-b:triggers').label, null);
  assert.equal(out.edges.find((e) => e.id === 'worker-b->worker-a:refines').label, null);
});

test('a bad edge entry does not stop the valid entries or the groups from being applied', () => {
  const out = applyWorkflowConfig(graph(), { groups: [grp('group:x', ['worker-a'])], edges: [null, 3, 'x', { from: 'worker-a', to: 'worker-b', kind: 'triggers', label: null }], labels: { 'worker-a': 'Alpha' } });
  assert.equal(out.groups.length, 1);
  assert.ok(out.edges.some((e) => e.id === 'worker-a->worker-b:triggers'));
  assert.equal(out.nodes.find((n) => n.id === 'worker-a').label, 'Alpha');
});

test('a config that throws while it is read leaves the graph as it was', () => {
  const g = graph();
  const evil = { get groups() { throw new Error('boom'); }, edges: [], labels: {} };
  assert.equal(applyWorkflowConfig(g, evil), g);
});

// ---- watchdog script nodes (piece W-C4) ----

const script = (plugin, file, over) => ({ plugin, root: '/r', script: file, abs: '/r/' + file, ...over });
const wdNode = (id) => (g) => g.nodes.find((n) => n.id === id);

test('one script adds one service node and one triggers edge from service:watchdog', () => {
  const out = addWatchdogScriptNodes(graph(), [script('uiforge', 'harness/watchdog-trigger.js')]);
  const id = 'service:watchdog-script:uiforge:watchdog-trigger';
  assert.deepEqual(wdNode(id)(out), { id, kind: 'service', label: 'uiforge: watchdog-trigger.js', parent: null, runtime: null, model: null, work: null, counts: null });
  assert.deepEqual(out.edges.find((e) => e.kind === 'triggers'), { id: `service:watchdog->${id}:triggers`, from: 'service:watchdog', to: id, kind: 'triggers', label: null });
  assert.equal(out.nodes.length, graph().nodes.length + 1);
  assert.equal(out.edges.length, graph().edges.length + 1);
  assert.deepEqual(out.warnings, ['from the builder']);
});

test('the id and label use the file name: directories and the .js ending are handled', () => {
  const out = addWatchdogScriptNodes(graph(), [script('p', 'a/b\\c/run.js'), script('p', 'plain.js'), script('p', 'noext'), script('p', 'deep/x.test.js')]);
  assert.deepEqual(out.nodes.filter((n) => n.id.startsWith('service:watchdog-script:')).map((n) => `${n.id} | ${n.label}`), [
    'service:watchdog-script:p:noext | p: noext', 'service:watchdog-script:p:plain | p: plain.js', 'service:watchdog-script:p:run | p: run.js', 'service:watchdog-script:p:x.test | p: x.test.js']);
});

test('two scripts of one plugin and a script of another plugin', () => {
  const out = addWatchdogScriptNodes(graph(), [script('a', 'one.js'), script('a', 'two.js'), script('b', 'one.js')]);
  assert.deepEqual(out.nodes.filter((n) => n.id.startsWith('service:watchdog-script:')).map((n) => n.id), ['service:watchdog-script:a:one', 'service:watchdog-script:a:two', 'service:watchdog-script:b:one']);
  assert.equal(out.edges.filter((e) => e.kind === 'triggers').length, 3);
});

test('a duplicate entry is added once, also when the node is already in the graph', () => {
  const twice = addWatchdogScriptNodes(graph(), [script('a', 'one.js'), script('a', 'dir/one.js')]);
  assert.equal(twice.nodes.filter((n) => n.id === 'service:watchdog-script:a:one').length, 1);
  assert.equal(twice.edges.filter((e) => e.kind === 'triggers').length, 1);
  const again = addWatchdogScriptNodes(twice, [script('a', 'one.js')]);
  assert.equal(again.nodes.length, twice.nodes.length);
  assert.equal(again.edges.length, twice.edges.length);
});

test('an entry without a plugin or a script is skipped with a warning, the others are added', () => {
  const out = addWatchdogScriptNodes(graph(), [null, 'x', { plugin: 'p' }, { script: 's.js' }, { plugin: '', script: 's.js' }, { plugin: 'p', script: '' }, { plugin: 'p', script: '/' }, { plugin: 'p', script: 'dir/' }, { plugin: 5, script: 's.js' }, script('ok', 'ok.js')]);
  assert.equal(out.warnings.length, 1 + 9);
  assert.match(out.warnings[1], /#1 /);
  assert.deepEqual(out.nodes.filter((n) => n.id.startsWith('service:watchdog-script:')).map((n) => n.id), ['service:watchdog-script:ok:ok']);
});

test('null, a non-array and an empty array change nothing', () => {
  const g = graph();
  for (const scripts of [null, undefined, 'x', {}, 5, []]) assert.equal(addWatchdogScriptNodes(g, scripts), g, JSON.stringify(scripts));
  assert.equal(addWatchdogScriptNodes(null, [script('a', 'x.js')]), null);
  const noNodes = { edges: [] };
  assert.equal(addWatchdogScriptNodes(noNodes, [script('a', 'x.js')]), noNodes);
});

test('without a service:watchdog node the script node is still added and its edge is skipped with a warning', () => {
  const g = graph();
  g.nodes = g.nodes.filter((n) => n.id !== 'service:watchdog');
  const out = addWatchdogScriptNodes(g, [script('a', 'x.js')]);
  assert.ok(wdNode('service:watchdog-script:a:x')(out));
  assert.equal(out.edges.filter((e) => e.kind === 'triggers').length, 0);
  assert.equal(out.warnings.length, 2);
  assert.match(out.warnings[1], /there is no service:watchdog node/);
});

test('the result stays sorted, is deterministic and the input is not mutated', () => {
  const scripts = [script('z', 'last.js'), script('a', 'first.js')];
  const out = addWatchdogScriptNodes(deepFreeze(graph()), deepFreeze(JSON.parse(JSON.stringify(scripts))));
  assert.deepEqual(out.nodes.map((n) => n.id), ['stage:plan', 'service:watchdog', 'service:watchdog-script:a:first', 'service:watchdog-script:z:last', 'reviewer', 'worker-a', 'worker-b', 'source:s1']);
  assert.deepEqual(out.edges.map((e) => e.id), [...out.edges.map((e) => e.id)].sort());
  assert.deepEqual(out, addWatchdogScriptNodes(graph(), scripts));
});

test('a script entry that makes the function throw leaves the graph as it was', () => {
  const g = graph();
  const evil = [{ get plugin() { throw new Error('boom'); }, script: 'x.js' }];
  assert.equal(addWatchdogScriptNodes(g, evil), g);
});

test('a workflow config can label and group the watchdog script nodes when it is applied after them', () => {
  const id = 'service:watchdog-script:a:x';
  const withScripts = addWatchdogScriptNodes(graph(), [script('a', 'x.js')]);
  const out = applyWorkflowConfig(withScripts, cfg({ groups: [grp('group:wd', ['service:watchdog', id])], labels: { [id]: 'Sweep' } }));
  assert.equal(wdNode(id)(out).label, 'Sweep');
  assert.equal(wdNode(id)(out).parent, 'group:wd');
});
