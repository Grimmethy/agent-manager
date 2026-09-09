'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { extractFilesLine, checkCitedPaths, formatFabricatedReason } = require('./candidate-path-grounding.js');

// --- extractFilesLine -----------------------------------------------------------------

test('extractFilesLine: pulls the AC-NNN "Files:" line value', () => {
  const wu = [
    '### AC-042 · Something',
    'Strength: Strong',
    'Source: crewai — "..."',
    'Files: src/task-sources.js, src/config.js',
    '',
    'Problem:',
    'A paragraph that also mentions src/other.js hypothetically.',
  ].join('\n');
  assert.equal(extractFilesLine(wu), 'src/task-sources.js, src/config.js');
});

test('extractFilesLine: case-insensitive, tolerates leading markdown and bold', () => {
  assert.equal(extractFilesLine('- **Files:** a/b.py, c/d.py'), 'a/b.py, c/d.py');
  assert.equal(extractFilesLine('> files : one.js'), 'one.js');
});

test('extractFilesLine: empty when there is no Files: line', () => {
  assert.equal(extractFilesLine('Problem: files that changed were many.'), '');
  assert.equal(extractFilesLine(''), '');
});

// --- checkCitedPaths ----------------------------------------------------------------

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpg-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'real-one.js'), '// real\n');
  fs.writeFileSync(path.join(dir, 'src', 'real-two.js'), '// real\n');
  return dir;
}

test('checkCitedPaths: flags only the path that resolves nowhere', () => {
  const repo = tmpRepo();
  const { fabricated } = checkCitedPaths('src/real-one.js, src/made-up.js', repo, ['src']);
  assert.equal(fabricated.length, 1);
  assert.equal(fabricated[0].claimedPath, 'src/made-up.js');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('checkCitedPaths: a bare filename that resolves via an extraRoot is NOT fabricated', () => {
  const repo = tmpRepo();
  // "real-two.js" with no src/ prefix -- resolves once `src` is prepended (resolvedVia 'prefix')
  const { fabricated } = checkCitedPaths('real-two.js', repo, ['src']);
  assert.equal(fabricated.length, 0);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('checkCitedPaths: all-real Files line -> nothing fabricated', () => {
  const repo = tmpRepo();
  const { fabricated } = checkCitedPaths('src/real-one.js, src/real-two.js', repo, ['src']);
  assert.equal(fabricated.length, 0);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('checkCitedPaths: empty line or missing repoRoot -> no-op', () => {
  assert.deepEqual(checkCitedPaths('', '/x', []), { fabricated: [], checked: [] });
  assert.deepEqual(checkCitedPaths('src/x.js', '', []), { fabricated: [], checked: [] });
});

test('checkCitedPaths: only considers path-extensioned tokens (a directory citation is ignored)', () => {
  const repo = tmpRepo();
  const { fabricated } = checkCitedPaths('src/dashboard/, src/real-one.js', repo, ['src']);
  assert.equal(fabricated.length, 0); // "src/dashboard/" has no file extension -> not extracted at all
  fs.rmSync(repo, { recursive: true, force: true });
});

// --- formatFabricatedReason -------------------------------------------------------

test('formatFabricatedReason: names every fabricated path and starts with the classifier prefix', () => {
  const reason = formatFabricatedReason([{ claimedPath: 'src/a.js' }, { claimedPath: 'src/b.py' }]);
  assert.match(reason, /^fabricated file path\(s\): src\/a\.js, src\/b\.py\b/);
  // The full blockedReason becomes "Ungrounded draft: " + this; the classifier keys on
  // /^ungrounded draft:\s*fabricated file path/i.
  assert.match(`Ungrounded draft: ${reason}`, /^ungrounded draft:\s*fabricated file path/i);
});
