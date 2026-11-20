'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeTaskJson } = require('./draft-lifecycle.js');

function tmpTaskPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-lifecycle-test-'));
  return path.join(dir, 'task.json');
}

test('(a) carries disk premium fields forward when incoming omits them', () => {
  const p = tmpTaskPath();
  fs.writeFileSync(p, JSON.stringify({ premiumPriority: true, premiumSetBy: 'human', premiumSetAt: '2026-11-01T00:00:00Z' }));
  writeTaskJson(p, { id: 'x', status: 'drafting' });
  const out = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.strictEqual(out.premiumPriority, true);
  assert.strictEqual(out.premiumSetBy, 'human');
  assert.strictEqual(out.premiumSetAt, '2026-11-01T00:00:00Z');
});

test('(b) incoming explicit true overrides disk false', () => {
  const p = tmpTaskPath();
  fs.writeFileSync(p, JSON.stringify({ premiumPriority: false }));
  writeTaskJson(p, { id: 'x', premiumPriority: true });
  assert.strictEqual(JSON.parse(fs.readFileSync(p, 'utf8')).premiumPriority, true);
});

test('(c) explicit null clears the flag and is not replaced by disk value', () => {
  const p = tmpTaskPath();
  fs.writeFileSync(p, JSON.stringify({ premiumPriority: true }));
  writeTaskJson(p, { id: 'x', premiumPriority: null });
  assert.strictEqual(JSON.parse(fs.readFileSync(p, 'utf8')).premiumPriority, null);
});

test('(d) no existing file: write succeeds and no premium fields are added', () => {
  const p = tmpTaskPath();
  writeTaskJson(p, { id: 'x' });
  const out = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.strictEqual(out.id, 'x');
  assert.ok(!('premiumPriority' in out));
});

test('(e) corrupt existing record: write still succeeds, warns on stderr, caller object unchanged (f)', () => {
  const p = tmpTaskPath();
  fs.writeFileSync(p, '{not json');
  const task = { id: 'x' };
  const origWrite = process.stderr.write;
  let warned = '';
  process.stderr.write = (s) => { warned += s; return true; };
  try {
    writeTaskJson(p, task);
  } finally {
    process.stderr.write = origWrite;
  }
  assert.match(warned, /could not read existing record/);
  assert.deepStrictEqual(task, { id: 'x' });
  assert.strictEqual(JSON.parse(fs.readFileSync(p, 'utf8')).id, 'x');
});
