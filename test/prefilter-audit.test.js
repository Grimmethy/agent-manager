'use strict';

// Run: node --test test/prefilter-audit.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { recordDismissal, getRuleCounts } = require('../src/lib/prefilter-audit.js');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('genuine sync-IO finding with no loop header is recorded with its true file and line', () => {
  const dir = tmp('prefilter-audit-');
  const sink = path.join(dir, 'nested', 'dismissals.jsonl');
  const rule = 'sync-io-in-loop/protected-case';
  recordDismissal({ rule, pattern: 'readFileSync', file: 'src/real.js', line: 42, snippet: 'const x = fs.readFileSync(p);' }, sink);
  const lines = fs.readFileSync(sink, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.file, 'src/real.js');
  assert.equal(rec.line, 42);
  assert.equal(rec.rule, rule);
  assert.equal(rec.llmSkipped, true);
  for (const k of ['ts', 'pattern', 'rule', 'file', 'line', 'snippetSha256', 'llmSkipped']) assert.ok(k in rec, k);
  assert.equal(getRuleCounts().get(rule), 1);
});

test('unwritable sink throws and the rule count does not increase', () => {
  const dir = tmp('prefilter-audit-bad-');
  const blocker = path.join(dir, 'afile');
  fs.writeFileSync(blocker, 'x');
  const rule = 'unwritable-sink-rule';
  const before = getRuleCounts().get(rule) || 0;
  assert.throws(() => recordDismissal({ rule, pattern: 'p', file: 'a.js', line: 1, snippet: 's' }, path.join(blocker, 'sub', 'out.jsonl')));
  assert.equal(getRuleCounts().get(rule) || 0, before);
});

test('missing rule throws and creates no counter key', () => {
  const dir = tmp('prefilter-audit-norule-');
  const sink = path.join(dir, 'out.jsonl');
  const before = getRuleCounts().size;
  assert.throws(() => recordDismissal({ pattern: 'p', file: 'a.js', line: 1, snippet: 's' }, sink));
  assert.equal(getRuleCounts().has(undefined), false);
  assert.equal(getRuleCounts().size, before);
});

test('two rules get separate counts', () => {
  const dir = tmp('prefilter-audit-two-');
  const sink = path.join(dir, 'out.jsonl');
  const a = 'two-rules-a';
  const b = 'two-rules-b';
  recordDismissal({ rule: a, pattern: 'p', file: 'a.js', line: 1, snippet: 's' }, sink);
  recordDismissal({ rule: a, pattern: 'p', file: 'a.js', line: 2, snippet: 's' }, sink);
  recordDismissal({ rule: b, pattern: 'p', file: 'b.js', line: 3, snippet: 's' }, sink);
  assert.equal(getRuleCounts().get(a), 2);
  assert.equal(getRuleCounts().get(b), 1);
});
