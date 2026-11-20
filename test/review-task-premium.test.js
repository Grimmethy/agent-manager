'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.env.AGENT_MANAGER_REPO_ROOT) process.env.AGENT_MANAGER_REPO_ROOT = path.join(__dirname, '..');
const { writeTaskJson } = require('../src/review-task.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'review-task-premium-'));
}

test('premium fields on disk survive a write whose in-memory task omits or has stale values', () => {
  const dir = tmpDir();
  const p = path.join(dir, 't.json');
  fs.writeFileSync(p, JSON.stringify({ id: 'a', premiumPriority: true, premiumSetBy: 'user', premiumSetAt: '2026-01-01T00:00:00Z' }));
  writeTaskJson(p, { id: 'a', status: 'approved' });
  let got = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.strictEqual(got.premiumPriority, true);
  assert.strictEqual(got.premiumSetBy, 'user');
  assert.strictEqual(got.premiumSetAt, '2026-01-01T00:00:00Z');
  assert.strictEqual(got.status, 'approved');
  writeTaskJson(p, { id: 'a', premiumPriority: false, premiumSetBy: 'old', premiumSetAt: 'old' });
  got = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.strictEqual(got.premiumPriority, true);
  assert.strictEqual(got.premiumSetBy, 'user');
  assert.strictEqual(got.premiumSetAt, '2026-01-01T00:00:00Z');
  assert.deepStrictEqual(fs.readdirSync(dir), ['t.json']);
});

test('flags cleared on disk are not resurrected from the in-memory task', () => {
  const dir = tmpDir();
  const p = path.join(dir, 't.json');
  fs.writeFileSync(p, JSON.stringify({ id: 'a' }));
  writeTaskJson(p, { id: 'a', premiumPriority: true, premiumSetBy: 'x', premiumSetAt: 'y' });
  const got = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.ok(!('premiumPriority' in got));
  assert.ok(!('premiumSetBy' in got));
  assert.ok(!('premiumSetAt' in got));
});

test('first write with no existing file succeeds and adds no premium fields', () => {
  const dir = tmpDir();
  const p = path.join(dir, 't.json');
  writeTaskJson(p, { id: 'a' });
  const got = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.deepStrictEqual(got, { id: 'a' });
});

test('corrupt existing file makes the writer throw and is left byte-identical', () => {
  const dir = tmpDir();
  const p = path.join(dir, 't.json');
  fs.writeFileSync(p, '{not json');
  assert.throws(() => writeTaskJson(p, { id: 'a' }));
  assert.strictEqual(fs.readFileSync(p, 'utf8'), '{not json');
  assert.deepStrictEqual(fs.readdirSync(dir), ['t.json']);
});
