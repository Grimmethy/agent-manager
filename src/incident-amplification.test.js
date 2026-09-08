'use strict';

// Exercises the real grepCodebase() and writeSideFindingInbox() -- no mocking the search
// primitive or the filer itself, matching this session's own "exercise the real
// db-backed module" convention.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runAmplificationSweep } = require('./incident-amplification.js');
const { inboxDir } = require('./side-finding.js');

function freshFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'incident-amplification-test-'));
  const pipelineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'incident-amplification-pipeline-'));
  fs.writeFileSync(path.join(root, 'site-a.js'), "if (e) { status: 'requeued' }\n");
  fs.writeFileSync(path.join(root, 'site-b.js'), "if (e) { status: 'requeued' }\n");
  fs.writeFileSync(path.join(root, 'site-c.js'), "// unrelated\n");
  return { root, pipelineDir };
}

function readInbox(pipelineDir) {
  const dir = inboxDir(pipelineDir);
  let names;
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  return names.map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')));
}

test('runAmplificationSweep finds real matches and files one side-finding per site', () => {
  const { root, pipelineDir } = freshFixture();
  const result = runAmplificationSweep({
    rootCauseSummary: 'history-entry writers using {status,at,note} instead of {stage,at,detail}',
    query: "status: '",
    dir: '.',
    root,
    pipelineDir,
    source: 'test',
  });
  assert.equal(result.matched, 2);
  assert.equal(result.filed, 2);
  assert.equal(result.excluded, 0);

  const inbox = readInbox(pipelineDir);
  assert.equal(inbox.length, 2);
  const titles = inbox.map((r) => r.title).sort();
  assert.match(titles[0], /site-a\.js:1/);
  assert.match(titles[1], /site-b\.js:1/);
  for (const r of inbox) {
    assert.match(r.body, /history-entry writers/);
    assert.equal(r.source, 'test');
  }
});

test('runAmplificationSweep excludes files already known to be fixed', () => {
  const { root, pipelineDir } = freshFixture();
  const result = runAmplificationSweep({
    rootCauseSummary: 'same root cause',
    query: "status: '",
    dir: '.',
    root,
    excludeFiles: ['site-a.js'],
    pipelineDir,
    source: 'test',
  });
  assert.equal(result.matched, 2);
  assert.equal(result.filed, 1);
  assert.equal(result.excluded, 1);
  const inbox = readInbox(pipelineDir);
  assert.equal(inbox.length, 1);
  assert.match(inbox[0].title, /site-b\.js/);
});

test('runAmplificationSweep no-ops cleanly on missing query/rootCauseSummary/pipelineDir', () => {
  const { root, pipelineDir } = freshFixture();
  assert.deepEqual(
    runAmplificationSweep({ rootCauseSummary: 'x', dir: '.', root, pipelineDir }),
    { matched: 0, filed: 0, excluded: 0 },
  );
  assert.deepEqual(
    runAmplificationSweep({ query: "status: '", dir: '.', root, pipelineDir }),
    { matched: 0, filed: 0, excluded: 0 },
  );
  assert.deepEqual(
    runAmplificationSweep({ rootCauseSummary: 'x', query: "status: '", dir: '.', root }),
    { matched: 0, filed: 0, excluded: 0 },
  );
  assert.equal(readInbox(pipelineDir).length, 0);
});

test('runAmplificationSweep returns empty result (not throw) when the query matches nothing', () => {
  const { root, pipelineDir } = freshFixture();
  const result = runAmplificationSweep({
    rootCauseSummary: 'x', query: 'this-string-appears-nowhere-xyz', dir: '.', root, pipelineDir, source: 'test',
  });
  assert.deepEqual(result, { matched: 0, filed: 0, excluded: 0 });
});
