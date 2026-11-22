'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  extractCitedPaths,
  verifyPaths,
  regroundPath,
  resolveGrounding,
} = require('./cited-path-grounding');

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cited-grounding-test-'));
}

test('create targets absent on disk are not reported as missing', () => {
  const repo = tmpRepo();
  try {
    const task = 'Create `src/lib/new-thing.js` with the helper. Edit `src/real.js`.';
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src', 'real.js'), '');
    const cited = extractCitedPaths(task);
    const create = cited.find((c) => c.path === 'src/lib/new-thing.js');
    assert.ok(create && create.create === true);
    assert.deepEqual(verifyPaths(repo, cited), []);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('non-create missing path is reported by verifyPaths', () => {
  const repo = tmpRepo();
  try {
    assert.deepEqual(verifyPaths(repo, ['nope/gone.js']), ['nope/gone.js']);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('regroundPath returns a result for one unique basename', () => {
  const repo = tmpRepo();
  try {
    fs.mkdirSync(path.join(repo, 'lib'));
    fs.writeFileSync(path.join(repo, 'lib', 'unique-name.js'), '');
    const r = regroundPath(repo, 'old/place/unique-name.js');
    assert.equal(r.ok, true);
    assert.equal(r.path, 'lib/unique-name.js');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('regroundPath returns no result for two same-named files', () => {
  const repo = tmpRepo();
  try {
    fs.mkdirSync(path.join(repo, 'a'));
    fs.mkdirSync(path.join(repo, 'b'));
    fs.writeFileSync(path.join(repo, 'a', 'dup.js'), '');
    fs.writeFileSync(path.join(repo, 'b', 'dup.js'), '');
    const r = regroundPath(repo, 'dup.js');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'ambiguous');
    assert.deepEqual(r.candidates, ['a/dup.js', 'b/dup.js']);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('basename match is case-sensitive', () => {
  const repo = tmpRepo();
  try {
    fs.writeFileSync(path.join(repo, 'Config.js'), '');
    assert.equal(regroundPath(repo, 'config.js').ok, false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('resolveGrounding reports unresolved paths and resolves unique ones', () => {
  const repo = tmpRepo();
  try {
    fs.mkdirSync(path.join(repo, 'lib'));
    fs.writeFileSync(path.join(repo, 'lib', 'found.js'), '');
    const res = resolveGrounding('See `old/found.js` and `ghost/none.js`.', repo);
    assert.deepEqual(res.resolved, { 'old/found.js': 'lib/found.js' });
    assert.deepEqual(res.unresolved.map((u) => u.path), ['ghost/none.js']);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
