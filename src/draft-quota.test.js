'use strict';
// Tests for src/draft-quota.js. No network: nothing here calls Ollama (the host Ollama port is never touched). HOME and every state path are temp dirs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-quota-'));
process.env.HOME = tmp;
const q = require('./draft-quota.js');

const NOW = Date.parse('2026-11-19T12:00:00Z');
const HOURLY = 'Ollama HTTP 429: {"error":"hourly token budget reached","resetsInSec":166}';

function taskFile(extra) {
  const dir = fs.mkdtempSync(path.join(tmp, 'q-'));
  const p = path.join(dir, 't.json');
  fs.writeFileSync(p, JSON.stringify({ id: 't1', draftFailureCount: 0, history: [], ...extra }));
  return p;
}
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

test('1: repeated hourly-budget 429s defer past the reset and never count as failures', () => {
  const p = taskFile();
  for (let i = 0; i < 6; i++) {
    const r = q.classify(HOURLY, NOW);
    assert.equal(r.kind, 'quota');
    assert.ok(r.resumeAt >= NOW + 166 * 1000);
    q.recordDeferral(p, r, NOW, HOURLY);
  }
  const o = read(p);
  assert.equal(o.draftFailureCount, 0);
  assert.equal(q.isDeferred(o, NOW + 165 * 1000), true);
  assert.equal(q.isDeferred(o, NOW + 170 * 1000), false);
});

test('2: five-hour limit with resetsAt schedules the retry after that timestamp', () => {
  const at = NOW + 3 * 3600 * 1000;
  const text = `Ollama HTTP 429: {"error":"five-hour limit reached","resetsAt":"${new Date(at).toISOString()}"}`;
  const r = q.classify(text, NOW);
  assert.equal(r.kind, 'quota');
  assert.equal(r.source, 'resetsAt');
  assert.ok(r.resumeAt > at);
});

test('3: after the deferral ends a success proceeds; failure count untouched by the 429s', () => {
  const p = taskFile({ draftFailureCount: 2 });
  q.recordDeferral(p, q.classify(HOURLY, NOW), NOW, HOURLY);
  const o = read(p);
  assert.equal(o.draftFailureCount, 2);
  assert.equal(q.isDeferred(o, NOW + 200 * 1000), false);
});

test('4: non-429 failures classify as failures (counted by the worker, unchanged path)', () => {
  const p = taskFile();
  const before = fs.readFileSync(p, 'utf8');
  for (const t of ['connect ECONNREFUSED 1.2.3.4:11434', '{"succeeded":false,"reason":"bad json"}', '', 'Ollama HTTP 500']) {
    assert.deepEqual(q.classify(t, NOW), { kind: 'failure' });
  }
  assert.equal(fs.readFileSync(p, 'utf8'), before);
});

test('5: 429 with no reset info defers for a bounded backoff', () => {
  const r = q.classify('Ollama HTTP 429: too many requests', NOW);
  assert.equal(r.kind, 'quota');
  assert.equal(r.source, 'backoff');
  assert.equal(r.resumeAt, NOW + q.QUOTA_BACKOFF_MS);
  const past = q.classify('Ollama HTTP 429: {"resetsAt":"2020-01-01T00:00:00Z"}', NOW);
  assert.equal(past.source, 'backoff');
});
