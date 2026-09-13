'use strict';

// Regression for the deterministic pre-flight check (search-preflight.js) that verifies the
// side-findings inbox holds at least one parseable record with real content before the sweep
// does any heavier work. Pins the three contract outcomes: a healthy inbox (ok + sample), an
// unreachable inbox dir, and an inbox with only malformed / empty records.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { inboxDir } = require('./side-finding.js');
const { searchPreflight } = require('./search-preflight.js');

const pipelineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-'));

after(() => {
  fs.rmSync(pipelineDir, { recursive: true, force: true });
});

test('ok=true with sample.tokenCount>0 when the inbox has one valid record', () => {
  const dir = inboxDir(pipelineDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'finding-1.json'),
    JSON.stringify({ title: 'test finding', body: 'some real content here' }),
  );
  const result = searchPreflight(pipelineDir);
  assert.equal(result.ok, true);
  assert.ok(result.sample.tokenCount > 0);
});

test('ok=false, reason=inbox-unreachable when pipelineDir does not exist', () => {
  const ghostDir = path.join(os.tmpdir(), 'preflight-ghost-' + process.pid);
  fs.rmSync(ghostDir, { recursive: true, force: true });
  const result = searchPreflight(ghostDir);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'inbox-unreachable');
});

test('ok=false, reason=no-parseable-results when the inbox has only malformed files', () => {
  const dir = inboxDir(pipelineDir);
  fs.mkdirSync(dir, { recursive: true });
  // Remove any files left by earlier tests so this case is self-contained.
  for (const f of fs.readdirSync(dir)) {
    fs.unlinkSync(path.join(dir, f));
  }
  fs.writeFileSync(path.join(dir, 'bad-1.json'), 'not json');
  fs.writeFileSync(path.join(dir, 'bad-2.json'), JSON.stringify({ foo: 1 }));
  const result = searchPreflight(pipelineDir);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-parseable-results');
});
