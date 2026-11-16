'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { searchTasksTool } = require('../src/local-tool-task-tools.js');

function makePipeline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-similar-test-'));
  const pending = path.join(dir, 'queue', 'pending');
  fs.mkdirSync(pending, { recursive: true });
  for (let i = 0; i < 20; i++) {
    fs.writeFileSync(path.join(pending, `filler-${String(i).padStart(2, '0')}.json`), JSON.stringify({ id: `filler-${i}`, title: `Filler number ${i}`, status: 'pending', promptContext: { rawText: 'nothing relevant' } }));
  }
  const archived = path.join(dir, 'queue', 'done', '_archived_no_action');
  fs.mkdirSync(archived, { recursive: true });
  fs.writeFileSync(path.join(archived, 'old-match.json'), JSON.stringify({ id: 'old-match', title: 'Old unrelated title', status: 'done', promptContext: { rawText: 'we must frobnicate the gizmo' } }));
  return dir;
}

test('similar mode returns a genuine archived match past the 15-result cap', () => {
  const dir = makePipeline();
  const r = searchTasksTool(dir, { query: 'frobnicate', includeArchived: true, similar: true });
  assert.ok(!r.error);
  assert.ok(r.results.length <= 15);
  const hit = r.results.find((x) => x.id === 'old-match');
  assert.ok(hit, 'archived body-only match must be returned');
  assert.equal(typeof hit.score, 'number');
  assert.equal(hit.matchedOn, 'body');
});

test('default path adds no score, matchedOn or note keys', () => {
  const dir = makePipeline();
  const r = searchTasksTool(dir, { query: 'Filler', similar: false });
  assert.ok(r.results.length > 0);
  for (const hit of r.results) {
    assert.ok(!('score' in hit));
    assert.ok(!('matchedOn' in hit));
    assert.ok(!('note' in hit));
  }
});
