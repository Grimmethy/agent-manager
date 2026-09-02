'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { taskAnchorFiles, resolveBareFilename } = require('./task-anchor-files.js');

function makeRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}
const adhoc = (rawText, extra = {}) => ({ source: 'manual', promptContext: { rawText, ...extra } });

test('picks up promptContext.prefetchedPaths (the field nothing read before)', () => {
  const dir = makeRepo({ 'python/dashboard/templates/index.html': 'function renderJobListTab() {}\n' });
  const t = adhoc('Reorganize the Job List tab.', { prefetchedPaths: ['python/dashboard/templates/index.html'] });
  const files = taskAnchorFiles(t, dir);
  assert.deepEqual(files.map((f) => f.path), ['python/dashboard/templates/index.html']);
  assert.match(files[0].content, /renderJobListTab/);
});

test('extracts a literal repo-relative path written in the task', () => {
  const dir = makeRepo({ 'src/task-sources.js': 'registerTaskSource("brain_dump_sort", {})\n' });
  const files = taskAnchorFiles(adhoc('Add a new task source to src/task-sources.js at priority 41.'), dir);
  assert.deepEqual(files.map((f) => f.path), ['src/task-sources.js']);
});

test('resolves a bare filename mentioned as a pattern to mirror', () => {
  const dir = makeRepo({
    'src/staleness-audit.js': 'const COOLDOWN = 1;\n',
    'src/other.js': 'x\n',
  });
  const files = taskAnchorFiles(adhoc('Mirror the staleness-audit.js cooldown-tracking pattern for bounding the sweep.'), dir);
  assert.ok(files.some((f) => f.path === 'src/staleness-audit.js'));
  assert.ok(!files.some((f) => f.path === 'src/other.js'), 'only files the task actually names');
});

test('resolves an ADR number reference', () => {
  const dir = makeRepo({ 'docs/adr/0018-project-search-task-source.md': '# project_search\n' });
  const files = taskAnchorFiles(adhoc("Same 'not meant to churn' precedent as 0018's project_search decision."), dir);
  assert.deepEqual(files.map((f) => f.path), ['docs/adr/0018-project-search-task-source.md']);
});

test('a file named in a "do NOT touch" clause is excluded', () => {
  const dir = makeRepo({
    'python/dashboard/templates/index.html': 'renderJobListTab\n',
    'src/apply-adhoc-diff.js': 'applyAdhocDiff\n',
  });
  const t = adhoc('Reorganize the Job List in python/dashboard/templates/index.html. Do NOT touch src/apply-adhoc-diff.js or anything under src/.');
  const files = taskAnchorFiles(t, dir);
  assert.ok(files.some((f) => f.path === 'python/dashboard/templates/index.html'));
  assert.ok(!files.some((f) => f.path === 'src/apply-adhoc-diff.js'), 'a forbidden file is not offered as an edit target');
});

test('an oversized file is windowed around the distinctive identifiers the task names', () => {
  const filler = 'x'.repeat(40000);
  const dir = makeRepo({
    'src/big.js': `${filler}\n// HEAD localStorage localStorage localStorage\n${'y'.repeat(40000)}\nfunction theRealTargetFunction() { return COOLDOWN_TRACKER; }\n${'z'.repeat(40000)}`,
  });
  const files = taskAnchorFiles(adhoc('Change theRealTargetFunction and COOLDOWN_TRACKER in src/big.js.'), dir, { maxCharsPerFile: 8000 });
  assert.equal(files.length, 1);
  assert.match(files[0].content, /theRealTargetFunction/);
  assert.match(files[0].content, /chars before this window/);
});

test('non-adhoc tasks and empty rawText yield nothing', () => {
  const dir = makeRepo({ 'src/x.js': 'a\n' });
  assert.deepEqual(taskAnchorFiles({ source: 'observability_fix', promptContext: { rawText: 'touch src/x.js' } }, dir), []);
  assert.deepEqual(taskAnchorFiles({ source: 'manual', promptContext: {} }, dir), []);
});

test('resolveBareFilename returns null when ambiguous', () => {
  const dir = makeRepo({ 'src/dup.js': 'a\n', 'scripts/dup.js': 'b\n' });
  assert.equal(resolveBareFilename(dir, 'dup.js'), null);
  assert.equal(resolveBareFilename(dir, 'src/dup.js'.split('/').pop()), null);
});

test('path traversal is refused', () => {
  const dir = makeRepo({ 'src/x.js': 'a\n' });
  assert.deepEqual(taskAnchorFiles(adhoc('edit ../../../etc/passwd and src/x.js'), dir).map((f) => f.path), ['src/x.js']);
});
