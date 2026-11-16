'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('./node-status-cli.js');
const { summarizeNodes, formatSummary } = require('./node-status.js');

const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const MIN = 60 * 1000;
const at = (ms) => new Date(NOW + ms).toISOString();
const HEADER = 'id status load freeRamGb lent returned expired merged nextExpiryMin';
const USAGE = 'usage: node src/node-status-cli.js [--json]';

const nodes = [
  { id: 'a', status: 'up', load: 0.5, freeRamGb: 8 },
  { id: 'b', status: 'off', load: null, freeRamGb: null },
];
const leases = [
  { taskId: 't1', nodeId: 'a', state: 'lent', expiresAt: at(10 * MIN) },
  { taskId: 't2', nodeId: 'a', state: 'lent', expiresAt: at(-MIN) },
  { taskId: 't3', nodeId: 'a', state: 'returned', expiresAt: at(0) },
  { taskId: 't4', nodeId: 'b', state: 'merged', expiresAt: at(0) },
  { taskId: 't5', nodeId: 'b', state: 'expired', expiresAt: at(-MIN) },
];
const deps = (over = {}) => ({ listNodes: () => nodes, listLeases: () => leases, now: () => NOW, ...over });

test('table output for two nodes with leases in every state', () => {
  const res = run([], {}, deps());
  assert.equal(res.code, 0);
  assert.equal(res.text, formatSummary(summarizeNodes(nodes, leases, NOW)));
  const lines = res.text.split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[1], 'a up 0.5 8 1 1 1 0 10');
  assert.equal(lines[2], 'b off - - 0 0 1 1 -');
});

test('--json output is one line that parses to the rows summarizeNodes produced', () => {
  const res = run(['--json'], {}, deps());
  assert.equal(res.code, 0);
  assert.equal(res.text.includes('\n'), false);
  assert.deepEqual(JSON.parse(res.text), summarizeNodes(nodes, leases, NOW));
});

test('no nodes prints the header only and exits 0', () => {
  const res = run([], {}, deps({ listNodes: () => [] }));
  assert.deepEqual(res, { text: HEADER, code: 0 });
});

test('an unknown flag exits 2 with the usage line', () => {
  assert.deepEqual(run(['--bogus'], {}, deps()), { text: USAGE, code: 2 });
});

test('a throwing listNodes exits 1 with the message', () => {
  const res = run([], {}, deps({ listNodes: () => { throw new Error('registry unreadable'); } }));
  assert.deepEqual(res, { text: 'node-status-cli: registry unreadable', code: 1 });
});

test('a throwing listLeases exits 1 with the message', () => {
  const res = run([], {}, deps({ listLeases: () => { throw new Error('ledger unreadable'); } }));
  assert.deepEqual(res, { text: 'node-status-cli: ledger unreadable', code: 1 });
});

test('the same now goes to listNodes and summarizeNodes, and run returns instead of exiting', () => {
  const seen = [];
  const res = run([], {}, deps({
    listNodes: (env, now) => { seen.push(now); return nodes; },
    now: () => NOW,
  }));
  assert.deepEqual(seen, [NOW]);
  assert.equal(res.text, formatSummary(summarizeNodes(nodes, leases, NOW)));
  assert.equal(res.code, 0);
});
