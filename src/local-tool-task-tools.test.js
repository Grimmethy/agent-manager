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

test('similar:true returns ranked results with score and matchedOn', () => {
  const dir = makePipeline();
  const r = searchTasksTool(dir, { query: 'widget renderer', similar: true });
  assert.ok(!r.error);
  assert.equal(r.results[0].id, 'fixture-task-1');
  assert.equal(typeof r.results[0].score, 'number');
  assert.equal(typeof r.results[0].matchedOn, 'string');
});

test('similar:true finds a body-only match', () => {
  const dir = makePipeline();
  fs.writeFileSync(path.join(dir, 'queue', 'pending', 'fixture-task-3.json'), JSON.stringify({ id: 'fixture-task-3', title: 'Misc chore', status: 'pending', promptContext: { rawText: 'frobnicate the gizmo' } }));
  const r = searchTasksTool(dir, { query: 'frobnicate', similar: true });
  assert.equal(r.results[0].id, 'fixture-task-3');
  assert.equal(r.results[0].matchedOn, 'body');
});

test('similar:true adds a no-close-match note when the best score is below DUPLICATE_SCORE', () => {
  const dir = makePipeline();
  const r = searchTasksTool(dir, { query: 'widget', similar: true });
  assert.equal(r.results[0].note, 'no close match');
  assert.equal(r.results[1].note, undefined);
});
