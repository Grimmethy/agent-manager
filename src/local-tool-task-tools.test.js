'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { searchTasksTool } = require('./local-tool-task-tools.js');

function makePipeline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-tasks-test-'));
  fs.mkdirSync(path.join(dir, 'queue', 'pending'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'queue', 'pending', 'fixture-task-1.json'), JSON.stringify({ id: 'fixture-task-1', title: 'Fix the widget renderer', status: 'pending', promptContext: { rawText: 'body text' } }));
  fs.writeFileSync(path.join(dir, 'queue', 'pending', 'fixture-task-2.json'), JSON.stringify({ id: 'fixture-task-2', title: 'Unrelated cleanup', status: 'pending', promptContext: { rawText: 'nothing' } }));
  return dir;
}

test('searchTasksTool similar:false deep-equals the call without the arg', () => {
  const dir = makePipeline();
  const omitted = searchTasksTool(dir, { query: 'widget' });
  const explicit = searchTasksTool(dir, { query: 'widget', similar: false });
  assert.deepEqual(explicit, omitted);
  assert.equal(omitted.results.length, 1);
  assert.equal(omitted.results[0].id, 'fixture-task-1');
});

test('searchTasksTool similar:true refuses until src/task-similarity.js lands', () => {
  const dir = makePipeline();
  const r = searchTasksTool(dir, { query: 'widget', similar: true });
  assert.ok(r.error && r.error.includes('task-similarity'));
});

test('similar:true returns ranked results with score and matchedOn', { skip: 'blocked on HUB0262' }, () => {});
test('similar:true finds a body-only match', { skip: 'blocked on HUB0262' }, () => {});
test('similar:true adds a no-close-match note when the best score is below DUPLICATE_SCORE', { skip: 'blocked on HUB0262' }, () => {});
