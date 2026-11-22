'use strict';

// Tests for src/workflow-config.js. Every file the loader reads is a temporary file; the real <repo>/workflow.json is never touched.
// Run: node --test src/workflow-config.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateWorkflowConfig, readWorkflowConfig, workflowConfigPath, EDGE_KINDS } = require('./workflow-config.js');

const EMPTY = { schemaVersion: 1, groups: [], edges: [], labels: {} };
const group = (over) => ({ id: 'group:a', label: 'A', children: ['x'], collapsed: false, ...over });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-config-test-'));
function writeTemp(content) {
  const file = path.join(tmp(), 'workflow.json');
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}
const envFor = (file) => ({ AGENT_MANAGER_WORKFLOW_PATH: file });

test('a valid file round-trips', () => {
  const raw = {
    schemaVersion: 1,
    groups: [group({ id: 'group:review', label: 'Review', children: ['reviewer', 'stage:review'], collapsed: true }), group({ id: 'group:all', label: 'All', children: ['group:review', 'worker-3090'] })],
    edges: [{ from: 'source:x', to: 'worker-3090', kind: 'triggers', label: 'on demand' }, { from: 'a', to: 'b', kind: 'refines', label: null }],
    labels: { 'worker-3090': 'Big GPU' },
  };
  const { config, warnings } = validateWorkflowConfig(raw);
  assert.deepEqual(config, raw);
  assert.deepEqual(warnings, []);
  assert.deepEqual(EDGE_KINDS, ['produces', 'claims', 'reviews', 'applies', 'triggers', 'refines']);
});

test('a missing or wrong schemaVersion, a non-object root and an array root give the empty config and one warning', () => {
  for (const raw of [{}, { schemaVersion: 2 }, { schemaVersion: '1' }, null, undefined, 42, 'x', [], [{ schemaVersion: 1 }]]) {
    const { config, warnings } = validateWorkflowConfig(raw);
    assert.deepEqual(config, EMPTY, JSON.stringify(raw));
    assert.equal(warnings.length, 1, JSON.stringify(raw));
  }
});

test('with only schemaVersion the config is empty and complete, with no warning', () => {
  assert.deepEqual(validateWorkflowConfig({ schemaVersion: 1 }), { config: EMPTY, warnings: [] });
});

test('groups: a bad id is dropped, a duplicate id keeps the first', () => {
  for (const id of ['a', 'group:', 'group:A', 'group:-x', 'group:a b', 'xgroup:a', ' group:a', 'group:a\n', 7, undefined]) {
    const { config, warnings } = validateWorkflowConfig({ schemaVersion: 1, groups: [group({ id })] });
    assert.deepEqual(config.groups, [], String(id));
    assert.equal(warnings.length, 1);
  }
  const dup = validateWorkflowConfig({ schemaVersion: 1, groups: [group({ label: 'first' }), group({ label: 'second', children: ['y'] })] });
  assert.equal(dup.config.groups.length, 1);
  assert.equal(dup.config.groups[0].label, 'first');
  assert.match(dup.warnings[0], /repeats the id group:a/);
});

test('groups: a label that is empty, too long or not a string falls back to the id', () => {
  for (const label of ['', '   ', 'x'.repeat(61), 5, null, undefined]) {
    const { config } = validateWorkflowConfig({ schemaVersion: 1, groups: [group({ label })] });
    assert.equal(config.groups[0].label, 'group:a', String(label));
  }
  assert.equal(validateWorkflowConfig({ schemaVersion: 1, groups: [group({ label: 'x'.repeat(60) })] }).config.groups[0].label, 'x'.repeat(60));
  assert.equal(validateWorkflowConfig({ schemaVersion: 1, groups: [group({ label: '  Padded  ' })] }).config.groups[0].label, 'Padded');
});

test('groups: children must be a non-empty array of distinct non-empty strings', () => {
  for (const children of [[], undefined, 'x', {}, [null], [''], ['  ']]) {
    const { config, warnings } = validateWorkflowConfig({ schemaVersion: 1, groups: [group({ children })] });
    assert.deepEqual(config.groups, [], JSON.stringify(children));
    assert.ok(warnings.length >= 1);
  }
  const mixed = validateWorkflowConfig({ schemaVersion: 1, groups: [group({ children: ['x', 7, 'x', 'y', null] })] });
  assert.deepEqual(mixed.config.groups[0].children, ['x', 'y']);
  assert.equal(mixed.warnings.length, 2, 'one warning per child that is not a usable string; the duplicate is merged silently');
});

test('groups: a group listing itself is dropped and a non-boolean collapsed is false', () => {
  const self = validateWorkflowConfig({ schemaVersion: 1, groups: [group({ children: ['x', 'group:a'] })] });
  assert.deepEqual(self.config.groups, []);
  assert.match(self.warnings[0], /lists itself/);
  for (const collapsed of ['true', 1, null]) {
    const r = validateWorkflowConfig({ schemaVersion: 1, groups: [group({ collapsed })] });
    assert.equal(r.config.groups[0].collapsed, false);
    assert.equal(r.warnings.length, 1);
  }
  assert.equal(validateWorkflowConfig({ schemaVersion: 1, groups: [group({ collapsed: true })] }).config.groups[0].collapsed, true);
});

test('groups: a two-group cycle drops both, a longer cycle drops all of it, a group that only points at a cycle survives', () => {
  const two = validateWorkflowConfig({ schemaVersion: 1, groups: [group({ id: 'group:a', children: ['group:b'] }), group({ id: 'group:b', children: ['group:a'] }), group({ id: 'group:c', children: ['x'] })] });
  assert.deepEqual(two.config.groups.map((g) => g.id), ['group:c']);
  assert.equal(two.warnings.length, 2);
  const three = validateWorkflowConfig({ schemaVersion: 1, groups: [group({ id: 'group:a', children: ['group:b'] }), group({ id: 'group:b', children: ['group:c'] }), group({ id: 'group:c', children: ['group:a'] })] });
  assert.deepEqual(three.config.groups, []);
  const tail = validateWorkflowConfig({ schemaVersion: 1, groups: [group({ id: 'group:a', children: ['group:b'] }), group({ id: 'group:b', children: ['group:a'] }), group({ id: 'group:t', children: ['group:a', 'x'] })] });
  assert.deepEqual(tail.config.groups.map((g) => g.id), ['group:t']);
  const nested = validateWorkflowConfig({ schemaVersion: 1, groups: [group({ id: 'group:in', children: ['x'] }), group({ id: 'group:out', children: ['group:in'] })] });
  assert.equal(nested.config.groups.length, 2);
  assert.deepEqual(nested.warnings, []);
});

test('groups: a groups value that is not an array is ignored with one warning', () => {
  const r = validateWorkflowConfig({ schemaVersion: 1, groups: { id: 'group:a' } });
  assert.deepEqual(r.config.groups, []);
  assert.equal(r.warnings.length, 1);
  assert.equal(validateWorkflowConfig({ schemaVersion: 1, groups: ['x', null, 3] }).warnings.length, 3);
  // one bad section must not wipe the others
  const mixed = validateWorkflowConfig({ schemaVersion: 1, groups: 'oops', edges: [{ from: 'a', to: 'b', kind: 'claims' }], labels: { a: 'A' } });
  assert.equal(mixed.config.edges.length, 1);
  assert.deepEqual(mixed.config.labels, { a: 'A' });
  assert.equal(mixed.warnings.length, 1);
});

test('edges: an edges value that is not an array is ignored with one warning and the other sections stay', () => {
  const r = validateWorkflowConfig({ schemaVersion: 1, groups: [group()], edges: 'oops', labels: { a: 'A' } });
  assert.deepEqual(r.config.edges, []);
  assert.equal(r.config.groups.length, 1);
  assert.deepEqual(r.config.labels, { a: 'A' });
  assert.equal(r.warnings.length, 1);
});

test('edges: every closed kind is accepted and anything else is dropped', () => {
  for (const kind of EDGE_KINDS) assert.equal(validateWorkflowConfig({ schemaVersion: 1, edges: [{ from: 'a', to: 'b', kind }] }).config.edges.length, 1, kind);
  for (const kind of ['claim', 'CLAIMS', '', undefined, 5]) {
    const r = validateWorkflowConfig({ schemaVersion: 1, edges: [{ from: 'a', to: 'b', kind }] });
    assert.deepEqual(r.config.edges, [], String(kind));
    assert.equal(r.warnings.length, 1);
  }
});

test('edges: from and to are required strings and may not be equal', () => {
  for (const e of [{ to: 'b', kind: 'claims' }, { from: 'a', kind: 'claims' }, { from: '', to: 'b', kind: 'claims' }, { from: 'a', to: 7, kind: 'claims' }, { from: 'a', to: 'a', kind: 'claims' }, null, 'x']) {
    const r = validateWorkflowConfig({ schemaVersion: 1, edges: [e] });
    assert.deepEqual(r.config.edges, [], JSON.stringify(e));
    assert.equal(r.warnings.length, 1);
  }
});

test('edges: a label is a string of at most 60 characters or null, a longer one drops the edge', () => {
  assert.equal(validateWorkflowConfig({ schemaVersion: 1, edges: [{ from: 'a', to: 'b', kind: 'claims', label: 'x'.repeat(60) }] }).config.edges[0].label, 'x'.repeat(60));
  assert.equal(validateWorkflowConfig({ schemaVersion: 1, edges: [{ from: 'a', to: 'b', kind: 'claims' }] }).config.edges[0].label, null);
  for (const label of ['x'.repeat(61), '', 5]) {
    const r = validateWorkflowConfig({ schemaVersion: 1, edges: [{ from: 'a', to: 'b', kind: 'claims', label }] });
    assert.deepEqual(r.config.edges, []);
    assert.equal(r.warnings.length, 1);
  }
});

test('edges: at most 500 are kept and the rest are dropped with one warning', () => {
  const edges = Array.from({ length: 503 }, (_, i) => ({ from: `a${i}`, to: `b${i}`, kind: 'claims' }));
  const r = validateWorkflowConfig({ schemaVersion: 1, edges });
  assert.equal(r.config.edges.length, 500);
  assert.equal(r.config.edges[499].from, 'a499');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /3 dropped/);
  assert.equal(validateWorkflowConfig({ schemaVersion: 1, edges: edges.slice(0, 500) }).warnings.length, 0);
});

test('labels: values must be non-empty strings of at most 60 characters, at most 500 are kept', () => {
  const r = validateWorkflowConfig({ schemaVersion: 1, labels: { a: 'A', b: 5, c: '', d: 'x'.repeat(61), e: '  E  ' } });
  assert.deepEqual(r.config.labels, { a: 'A', e: 'E' });
  assert.equal(r.warnings.length, 3);
  const many = {};
  for (let i = 0; i < 502; i += 1) many[`n${i}`] = 'L';
  const big = validateWorkflowConfig({ schemaVersion: 1, labels: many });
  assert.equal(Object.keys(big.config.labels).length, 500);
  assert.equal(big.warnings.length, 1);
  for (const labels of [[], 'x', 5]) {
    const bad = validateWorkflowConfig({ schemaVersion: 1, labels });
    assert.deepEqual(bad.config.labels, {});
    assert.equal(bad.warnings.length, 1);
  }
});

test('validateWorkflowConfig never throws, on odd inputs, accessors that throw, and does not mutate its input', () => {
  const evil = { schemaVersion: 1, get groups() { throw new Error('boom'); } };
  const r = validateWorkflowConfig(evil);
  assert.deepEqual(r.config, EMPTY);
  assert.equal(r.warnings.length, 1);
  assert.doesNotThrow(() => validateWorkflowConfig(Symbol.iterator));
  const input = { schemaVersion: 1, groups: [group()], edges: [{ from: 'a', to: 'b', kind: 'claims' }], labels: { a: 'A' } };
  const before = JSON.stringify(input);
  validateWorkflowConfig(input);
  assert.equal(JSON.stringify(input), before);
});

test('the loader: an absent file is the empty config with no warning', () => {
  const r = readWorkflowConfig(envFor(path.join(tmp(), 'nothing-here.json')));
  assert.deepEqual(r, { config: EMPTY, warnings: [] });
});

test('the loader: a directory, invalid JSON and a file over 256 KB give the empty config and one warning', () => {
  const dir = tmp();
  let r = readWorkflowConfig(envFor(dir));
  assert.deepEqual(r.config, EMPTY);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /is not a file/);
  r = readWorkflowConfig(envFor(writeTemp('{ not json')));
  assert.deepEqual(r.config, EMPTY);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /cannot be read as JSON/);
  const big = writeTemp(JSON.stringify({ schemaVersion: 1, labels: { a: 'x'.repeat(256 * 1024) } }));
  r = readWorkflowConfig(envFor(big));
  assert.deepEqual(r.config, EMPTY);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /larger than 256 KB/);
  const ok = writeTemp(JSON.stringify({ schemaVersion: 1, labels: { a: 'x'.repeat(200) } }));
  assert.equal(readWorkflowConfig(envFor(ok)).warnings.length, 1, 'a small file with a bad label still loads and warns about the label only');
});

test('the loader: a valid file loads and its warnings name the file', () => {
  const file = writeTemp({ schemaVersion: 1, groups: [group()], edges: [{ from: 'a', to: 'a', kind: 'claims' }] });
  const r = readWorkflowConfig(envFor(file));
  assert.equal(r.config.groups.length, 1);
  assert.equal(r.warnings.length, 1);
  assert.ok(r.warnings[0].startsWith(file + ': '));
});

test('workflowConfigPath: the env variable, else <repo>/workflow.json', () => {
  assert.equal(workflowConfigPath({ AGENT_MANAGER_WORKFLOW_PATH: '/tmp/x/workflow.json' }), '/tmp/x/workflow.json');
  assert.equal(workflowConfigPath({}), path.join(path.resolve(__dirname, '..'), 'workflow.json'));
  assert.equal(workflowConfigPath({ AGENT_MANAGER_WORKFLOW_PATH: '' }), path.join(path.resolve(__dirname, '..'), 'workflow.json'));
});

test('the CLI prints { config, warnings } as one line of JSON', () => {
  const file = writeTemp({ schemaVersion: 1, groups: [group()] });
  const out = spawnSync(process.execPath, [path.join(__dirname, 'workflow-config.js')], { env: { ...process.env, AGENT_MANAGER_WORKFLOW_PATH: file }, encoding: 'utf8' });
  assert.equal(out.status, 0);
  assert.equal(out.stdout.trim().split('\n').length, 1);
  const parsed = JSON.parse(out.stdout);
  assert.deepEqual(parsed.warnings, []);
  assert.equal(parsed.config.groups[0].id, 'group:a');
  const none = spawnSync(process.execPath, [path.join(__dirname, 'workflow-config.js')], { env: { ...process.env, AGENT_MANAGER_WORKFLOW_PATH: path.join(tmp(), 'none.json') }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(none.stdout), { config: EMPTY, warnings: [] });
});
