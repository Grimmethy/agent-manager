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

// --- line-anchored windowing (harnessHits / path:line refs / tail heuristic) ---

// A file well over any maxCharsPerFile: N numbered lines so a "line M" assertion is real.
function bigNumberedFile(nLines, marker, markerLine) {
  const lines = [];
  for (let i = 1; i <= nLines; i += 1) {
    lines.push(i === markerLine ? `line ${i} ${marker}` : `line ${i} filler filler filler filler filler`);
  }
  return lines.join('\n');
}

test('harnessHits window an oversized file with no matching identifiers', () => {
  const dir = makeRepo({ 'python/dashboard/app.py': bigNumberedFile(1200, 'INSERT_ROUTE_HERE', 300) });
  const t = adhoc('Add POST /api/plugins/install to python/dashboard/app.py.', {
    prefetchedPaths: ['python/dashboard/app.py'],
    harnessHits: [{ file: 'python/dashboard/app.py', line: 300, query: 'x', text: 'y' }],
  });
  const files = taskAnchorFiles(t, dir, { maxCharsPerFile: 8000 });
  assert.equal(files.length, 1);
  assert.match(files[0].content, /INSERT_ROUTE_HERE/);
  assert.match(files[0].content, /showing lines \d+-\d+, around grep hit\(s\) at line\(s\) 300/);
  assert.doesNotMatch(files[0].content, /head shown/);
  assert.equal(files[0].windowed, true);
  assert.deepEqual(files[0].anchoredOnLines, [300]);
});

test('two far-apart hit clusters each get a window', () => {
  let content = bigNumberedFile(1200, 'ZZZ', 0);
  content = content.split('\n');
  content[119] = 'line 120 FIRST_REGION_MARKER';
  content[899] = 'line 900 SECOND_REGION_MARKER';
  const dir = makeRepo({ 'python/dashboard/app.py': content.join('\n') });
  const t = adhoc('Edit python/dashboard/app.py.', {
    prefetchedPaths: ['python/dashboard/app.py'],
    harnessHits: [
      { file: 'python/dashboard/app.py', line: 120, query: 'a', text: 'b' },
      { file: 'python/dashboard/app.py', line: 900, query: 'c', text: 'd' },
    ],
  });
  const [f] = taskAnchorFiles(t, dir, { maxCharsPerFile: 8000 });
  assert.match(f.content, /FIRST_REGION_MARKER/);
  assert.match(f.content, /SECOND_REGION_MARKER/);
  assert.match(f.content, /lines between windows/);
  assert.doesNotMatch(f.content, /line 500 filler/);
});

test('harnessHits take priority over an identifier match', () => {
  const content = bigNumberedFile(1000, 'HIT_REGION', 800)
    .split('\n')
    .map((l, i) => (i === 49 ? 'line 50 distinctiveIdentifierToken' : l))
    .join('\n');
  const dir = makeRepo({ 'src/big.js': content });
  const t = adhoc('Change distinctiveIdentifierToken in src/big.js.', {
    prefetchedPaths: ['src/big.js'],
    harnessHits: [{ file: 'src/big.js', line: 800, query: 'x', text: 'y' }],
  });
  const [f] = taskAnchorFiles(t, dir, { maxCharsPerFile: 8000 });
  assert.match(f.content, /HIT_REGION/);
  assert.match(f.content, /around grep hit\(s\) at line\(s\) 800/);
});

test('a path:line ref in the task text windows the file, no harnessHits needed', () => {
  const dir = makeRepo({ 'python/dashboard/app.py': bigNumberedFile(7000, 'THE_INSERTION_POINT', 6645) });
  const long = taskAnchorFiles(adhoc('Insert the handler at python/dashboard/app.py:6645, mirroring api_plugins_add.'), dir, { maxCharsPerFile: 8000 });
  assert.match(long[0].content, /THE_INSERTION_POINT/);
  assert.match(long[0].content, /around grep hit\(s\) at line\(s\) 6645/);
  const bare = taskAnchorFiles(adhoc('Insert the handler at app.py:6645.', { prefetchedPaths: ['python/dashboard/app.py'] }), dir, { maxCharsPerFile: 8000 });
  assert.match(bare[0].content, /THE_INSERTION_POINT/);
});

test('tail heuristic: "at the bottom of the file" shows the end, not the head', () => {
  const dir = makeRepo({ 'python/dashboard/app.py': `${bigNumberedFile(1200, 'nope', 0)}\nLAST_LINE_BLUEPRINT_SPOT` });
  const t = adhoc('Register the dashboard_api blueprint at the bottom of python/dashboard/app.py.', {
    prefetchedPaths: ['python/dashboard/app.py'],
  });
  const [f] = taskAnchorFiles(t, dir, { maxCharsPerFile: 8000 });
  assert.match(f.content, /LAST_LINE_BLUEPRINT_SPOT/);
  assert.match(f.content, /END of the file/);
  assert.doesNotMatch(f.content, /head shown/);
});

test('no hits, no idents, no tail cue still head-truncates (regression guard)', () => {
  const dir = makeRepo({ 'src/big.js': 'q'.repeat(40000) });
  const [f] = taskAnchorFiles(adhoc('Do something in src/big.js.', { prefetchedPaths: ['src/big.js'] }), dir, { maxCharsPerFile: 8000 });
  assert.match(f.content, /head shown/);
});

test('a small file is returned verbatim even when hitLines are present', () => {
  const dir = makeRepo({ 'src/small.js': 'line 1\nline 2\nline 3\n' });
  const t = adhoc('Edit src/small.js.', {
    prefetchedPaths: ['src/small.js'],
    harnessHits: [{ file: 'src/small.js', line: 2, query: 'x', text: 'y' }],
  });
  const [f] = taskAnchorFiles(t, dir, { maxCharsPerFile: 8000 });
  assert.equal(f.content, 'line 1\nline 2\nline 3\n');
  assert.equal(f.windowed, false);
});

test('a harnessHit for a different file does not move this file\'s window', () => {
  const dir = makeRepo({ 'python/dashboard/app.py': bigNumberedFile(1200, 'IDENT_REGION', 60) });
  const t = adhoc('Change theIdentRegionThing in python/dashboard/app.py.', {
    prefetchedPaths: ['python/dashboard/app.py'],
    harnessHits: [{ file: 'python/dashboard/other.py', line: 900, query: 'x', text: 'y' }],
  });
  const [f] = taskAnchorFiles(t, dir, { maxCharsPerFile: 8000 });
  assert.deepEqual(f.anchoredOnLines, []);
  assert.doesNotMatch(f.content, /around grep hit/);
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
