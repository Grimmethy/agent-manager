'use strict';

// Unit tests for file-length-flags-reader.js (split out of decompose-loop-autoroute.js,
// S4a of the hub-tasks extraction, 2026-09-24). Run: node --test src/file-length-flags-reader.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { oversizedFiles, targetOversizedFile } = require('./file-length-flags-reader.js');

function tmpPipeline(findings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-length-flags-reader-test-'));
  fs.mkdirSync(path.join(dir, 'queue'), { recursive: true });
  if (findings !== undefined) {
    fs.writeFileSync(path.join(dir, 'queue', 'file-length-flags.json'), JSON.stringify({ findings }));
  }
  return dir;
}

test('oversizedFiles reads the flags file into a Set of paths', () => {
  const dir = tmpPipeline([{ file: 'a.py', lines: 900 }, { file: 'b.js', lines: 1200 }]);
  const set = oversizedFiles(dir);
  assert.equal(set.size, 2);
  assert.ok(set.has('a.py') && set.has('b.js'));
});

test('oversizedFiles returns an empty Set when the flags file is missing', () => {
  const dir = tmpPipeline(undefined);
  assert.equal(oversizedFiles(dir).size, 0);
});

test('oversizedFiles ignores malformed findings entries', () => {
  const dir = tmpPipeline([{ lines: 900 }, null, { file: 'ok.py' }]);
  const set = oversizedFiles(dir);
  assert.deepEqual([...set], ['ok.py']);
});

test('targetOversizedFile matches the flagged path named in the task text', () => {
  const oversized = new Set(['python/dashboard/templates/index.html', 'src/x.js']);
  const t = { title: 'Combine job types', promptContext: { rawText: 'edit python/dashboard/templates/index.html renderJobListTab()' } };
  assert.equal(targetOversizedFile(t, oversized), 'python/dashboard/templates/index.html');
  assert.equal(targetOversizedFile({ title: 'x', promptContext: { rawText: 'edit src/y.js' } }, oversized), null);
});

test('targetOversizedFile skips a mention inside a verification/compile sentence', () => {
  const oversized = new Set(['app.py']);
  const t = { title: 'Add a test', promptContext: { rawText: 'Create test_x.py.\nRun: python3 -m py_compile app.py test_x.py' } };
  assert.equal(targetOversizedFile(t, oversized), null);
});

test('targetOversizedFile picks the longest matching path when more than one flagged file appears', () => {
  const oversized = new Set(['app.py', 'a/b/app.py']);
  const t = { title: 'x', promptContext: { rawText: 'edit a/b/app.py' } };
  assert.equal(targetOversizedFile(t, oversized), 'a/b/app.py');
});
