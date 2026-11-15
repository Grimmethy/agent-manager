'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { claimBands, bandedPriority, readClaimBands, GROUP_BAND } = require('./workflow-claim-order.js');
const { flatPriorityOrder, groupPriorityOrder } = require('./workflow-priority.js');
const { applyWorkflowConfig } = require('./workflow-overlay.js');
const { validateWorkflowConfig } = require('./workflow-config.js');

const grp = (id, children) => ({ id, label: id, children, collapsed: false });

test('no groups, null, undefined and non-object configs give null bands and the base priority back', () => {
  for (const c of [null, undefined, 5, 'x', [], {}, { groups: [] }, { groups: 'no' }, { groups: [grp('group:a', ['worker-3090'])] }]) {
    assert.equal(claimBands(c), null);
  }
  assert.equal(bandedPriority('adhoc', 40, null), 40);
  assert.equal(bandedPriority('adhoc', 40, undefined), 40);
});

test('two groups: index follows the file order, ungrouped sources sit after the last group', () => {
  const bands = claimBands({ groups: [grp('group:a', ['source:fix']), grp('group:b', ['source:mine'])] });
  assert.equal(bands.count, 2);
  assert.equal(bands.index.fix, 0);
  assert.equal(bands.index.mine, 1);
  assert.equal(bandedPriority('fix', 15, bands), 15);
  assert.equal(bandedPriority('mine', 10, bands), 1010);
  assert.equal(bandedPriority('loose', 10, bands), 2010);
  assert.equal(GROUP_BAND, 1000);
});

test('nested groups: a source takes the OUTER group index, an inner group is never used as outermost', () => {
  const bands = claimBands({ groups: [grp('group:inner', ['source:deep']), grp('group:other', ['source:x']), grp('group:outer', ['group:inner', 'source:y'])] });
  assert.equal(bands.index.deep, 2);
  assert.equal(bands.index.y, 2);
  assert.equal(bands.index.x, 1);
  assert.equal(bandedPriority('deep', 3, bands), 2003);
});

test('a source listed by two groups follows the first one in the file', () => {
  const bands = claimBands({ groups: [grp('group:a', ['source:s']), grp('group:b', ['source:s'])] });
  assert.equal(bands.index.s, 0);
});

test('a group cycle or a group that lists itself does not hang or throw', () => {
  const cyc = claimBands({ groups: [grp('group:a', ['group:b', 'source:s']), grp('group:b', ['group:a'])] });
  assert.ok(cyc === null || typeof cyc.index.s === 'number');
  const self = claimBands({ groups: [grp('group:a', ['group:a', 'source:s'])] });
  assert.equal(self.index.s, 0);
});

test('source names that are Object.prototype members behave like any other name; non-source children are ignored', () => {
  const bands = claimBands({ groups: [grp('group:a', ['source:constructor', 'source:__proto__', 'source:toString', 'worker-3090', 'group:zzz', 'source:', 7])] });
  assert.equal(bands.index.constructor, 0);
  assert.equal(bands.index.__proto__, 0);
  assert.equal(bandedPriority('toString', 1, bands), 1);
  assert.equal(bandedPriority('hasOwnProperty', 1, bands), 1001);
  assert.equal(Object.keys(bands.index).sort().join(','), '__proto__,constructor,toString');
});

test('a base priority that is not a finite number is returned unchanged', () => {
  const bands = claimBands({ groups: [grp('group:a', ['source:s'])] });
  assert.equal(bandedPriority('s', Infinity, bands), Infinity);
  assert.equal(bandedPriority('s', -Infinity, bands), -Infinity);
  assert.ok(Number.isNaN(bandedPriority('s', NaN, bands)));
  assert.equal(bandedPriority('s', undefined, bands), undefined);
  assert.equal(bandedPriority(undefined, 5, bands), 1005);
});

// 14 sources with registered priorities; some equal, some across groups, some ungrouped. Config of 3 groups, one nested.
const SOURCES = [['fix_a', 15], ['fix_b', 15], ['fix_c', 2], ['audit_a', 20], ['audit_b', 30], ['audit_c', 20], ['own_a', 40], ['own_b', 41], ['own_c', 40], ['brain', 70], ['wiki', 82], ['loose_a', 5], ['loose_b', 96], ['loose_c', 5]];
const CONFIG = { schemaVersion: 1, groups: [
  grp('group:audits', ['source:audit_a', 'source:audit_b', 'source:audit_c']),
  grp('group:fixes', ['source:fix_a', 'source:fix_b', 'source:fix_c']),
  grp('group:own', ['source:own_a', 'group:more', 'source:own_c']),
  grp('group:more', ['source:own_b', 'source:brain']),
], edges: [], labels: {} };

test('GOLDEN: sorting by bandedPriority then name gives the order groupPriorityOrder shows', () => {
  const topology = SOURCES.map(([name, priority]) => ({ name, priority }));
  const graph = applyWorkflowConfig({ nodes: SOURCES.map(([name]) => ({ id: 'source:' + name, kind: 'source', label: name, parent: null })), edges: [], groups: [] }, CONFIG);
  const shown = groupPriorityOrder(graph, flatPriorityOrder(topology));
  assert.equal(shown.length, 14);
  const bands = claimBands(CONFIG);
  const claim = SOURCES.map(([name, p]) => ({ name, v: bandedPriority(name, p, bands) })).sort((a, b) => (a.v - b.v) || (a.name < b.name ? -1 : 1)).map((e) => e.name);
  const panel = shown.slice().sort((a, b) => (a.graphRank - b.graphRank) || (a.name < b.name ? -1 : 1)).map((e) => e.name);
  assert.deepEqual(claim, panel);
  // by hand: audits (0): audit_a 20, audit_c 20, audit_b 30; fixes (1): fix_c 2, fix_a 15, fix_b 15; own (2, outer of more): own_a 40, own_c 40, own_b 41, brain 70; loose after: loose_a 5, loose_c 5, wiki 82, loose_b 96
  assert.deepEqual(claim, ['audit_a', 'audit_c', 'audit_b', 'fix_c', 'fix_a', 'fix_b', 'own_a', 'own_c', 'own_b', 'brain', 'loose_a', 'loose_c', 'wiki', 'loose_b']);
  assert.equal(bandedPriority('brain', 70, bands), 2070);
  assert.equal(bandedPriority('wiki', 82, bands), 4082);
});

function tmpWorkflow(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wco-'));
  const file = path.join(dir, 'workflow.json');
  fs.writeFileSync(file, typeof config === 'string' ? config : JSON.stringify(config));
  fs.utimesSync(file, 1700000000, 1700000000); // whole seconds, so a later utimes with the same value gives the same mtimeMs
  return { dir, file, env: { AGENT_MANAGER_PRIORITY_MODE: 'group', AGENT_MANAGER_WORKFLOW_PATH: file } };
}

test('readClaimBands: mode absent or not group gives null without touching the file', () => {
  const t = tmpWorkflow(CONFIG);
  try {
    assert.equal(readClaimBands({ AGENT_MANAGER_WORKFLOW_PATH: t.file }), null);
    assert.equal(readClaimBands({ ...t.env, AGENT_MANAGER_PRIORITY_MODE: 'flat' }), null);
    assert.equal(readClaimBands({ ...t.env, AGENT_MANAGER_PRIORITY_MODE: 'GROUP' }), null);
    assert.equal(readClaimBands(null), null);
  } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('readClaimBands: mode group reads the file, caches by mtime and size, re-reads a changed file', () => {
  const t = tmpWorkflow(CONFIG);
  try {
    const first = readClaimBands(t.env);
    assert.equal(first.index.audit_a, 0);
    assert.equal(readClaimBands(t.env), first, 'same object from the cache');
    // same size, same mtime, different content: the cache must answer (proves no second read)
    const st = fs.statSync(t.file);
    const swapped = JSON.stringify(CONFIG).replace('audit_a', 'audit_z');
    fs.writeFileSync(t.file, swapped);
    fs.utimesSync(t.file, 1700000000, 1700000000);
    assert.equal(fs.statSync(t.file).size, st.size);
    assert.equal(readClaimBands(t.env).index.audit_a, 0, 'cached bands still answer');
    // a new mtime forces a re-read
    fs.utimesSync(t.file, 1700000005, 1700000005);
    const again = readClaimBands(t.env);
    assert.equal(again.index.audit_a, undefined);
    assert.equal(again.index.audit_z, 0);
    // a changed size forces a re-read
    fs.writeFileSync(t.file, JSON.stringify({ ...CONFIG, groups: [grp('group:only', ['source:solo'])] }));
    assert.equal(readClaimBands(t.env).index.solo, 0);
  } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('readClaimBands: an absent file, invalid JSON, a wrong schema or no groups give null and never throw', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wco-'));
  try {
    assert.equal(readClaimBands({ AGENT_MANAGER_PRIORITY_MODE: 'group', AGENT_MANAGER_WORKFLOW_PATH: path.join(dir, 'none.json') }), null);
    for (const body of ['{not json', '[]', '{"schemaVersion":2,"groups":[]}', '{"schemaVersion":1,"groups":[]}', '']) {
      const t = tmpWorkflow(body);
      try { assert.equal(readClaimBands(t.env), null, body); } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the real validator output is accepted: a validated config gives the same bands as the raw one', () => {
  const { config } = validateWorkflowConfig(CONFIG);
  assert.deepEqual(claimBands(config), claimBands(CONFIG));
});

test('a bad group entry (no children array, no id, null) is skipped and the good groups still give bands', () => {
  const bands = claimBands({ groups: [{ id: 'group:bad' }, null, { children: ['source:ghost'] }, grp('group:ok', ['source:s'])] });
  assert.equal(bands.count, 4);
  assert.equal(bands.index.s, 3);
  assert.equal(bands.index.ghost, undefined);
});

test('three levels of nesting still end at the outermost group', () => {
  const bands = claimBands({ groups: [grp('group:inner', ['source:s']), grp('group:mid', ['group:inner']), grp('group:outer', ['group:mid'])] });
  assert.equal(bands.index.s, 2);
});

test('group ids that are Object.prototype members work, also when nested', () => {
  const flat = claimBands({ groups: [grp('constructor', ['source:s']), grp('toString', ['source:t'])] });
  assert.equal(flat.index.s, 0);
  assert.equal(flat.index.t, 1);
  const nested = claimBands({ groups: [grp('constructor', ['source:s']), grp('group:o', ['constructor'])] });
  assert.equal(nested.index.s, 1);
});

test('a config whose groups getter throws gives null', () => {
  const evil = {};
  Object.defineProperty(evil, 'groups', { get() { throw new Error('boom'); } });
  assert.equal(claimBands(evil), null);
});

test('readClaimBands: the cache key holds the size and the path', () => {
  const a = tmpWorkflow({ schemaVersion: 1, groups: [grp('group:a', ['source:aaa'])] });
  const b = tmpWorkflow({ schemaVersion: 1, groups: [grp('group:a', ['source:bbb'])] });
  try {
    assert.equal(fs.statSync(a.file).size, fs.statSync(b.file).size);
    assert.equal(fs.statSync(a.file).mtimeMs, fs.statSync(b.file).mtimeMs);
    assert.equal(readClaimBands(a.env).index.aaa, 0);
    assert.equal(readClaimBands(b.env).index.bbb, 0, 'another file with the same mtime and size is read, not served from the cache');
    // same path, same mtime, different size
    fs.writeFileSync(b.file, JSON.stringify({ schemaVersion: 1, groups: [grp('group:a', ['source:bbbbbb'])] }));
    fs.utimesSync(b.file, 1700000000, 1700000000);
    assert.equal(readClaimBands(b.env).index.bbbbbb, 0);
  } finally { fs.rmSync(a.dir, { recursive: true, force: true }); fs.rmSync(b.dir, { recursive: true, force: true }); }
});
