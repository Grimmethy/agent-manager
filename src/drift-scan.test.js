'use strict';

// Unit tests for drift-scan.js's set-difference logic, run against throwaway fixture
// files in a temp dir -- never against this repo's real index.html/task-sources.js, so
// these stay green regardless of what those files currently contain.
//
// Run: node --test src/drift-scan.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { checkPair, sliceBetween } = require('./drift-scan.js');

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-scan-test-'));
  return dir;
}

function writeFixture(repoRoot, relPath, content) {
  const full = path.join(repoRoot, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

const STATIC_REL = 'static.js';
const SOURCE_REL = 'source.js';

// Mirrors the real pair: joined on priority NUMBER, not on the source-name string --
// registry keys and display labels are deliberately allowed to differ (see drift-scan.js).
function pair(overrides = {}) {
  return {
    label: 'test pair',
    staticFile: STATIC_REL,
    staticStartMarker: 'const JOB_TYPES = [',
    staticEndMarker: '];',
    staticValueRegex: /priority:\s*(\d+)/g,
    sourceFile: SOURCE_REL,
    sourceValueRegex: /registerTaskSource\('[^']+',\s*\{\s*priority:\s*(\d+)/g,
    ...overrides,
  };
}

test('sliceBetween returns the substring including both markers', () => {
  const text = 'before\nconst X = [\nbody\n];\nafter';
  const slice = sliceBetween(text, 'const X = [', '];');
  assert.equal(slice, 'const X = [\nbody\n];');
});

test('sliceBetween returns null when the start marker is absent', () => {
  assert.equal(sliceBetween('nothing here', 'const X = [', '];'), null);
});

test('sliceBetween returns null when the end marker is absent', () => {
  assert.equal(sliceBetween('const X = [\nbody', 'const X = [', '];'), null);
});

test('checkPair reports clean when every registered priority has a Job List row, even with different name labels', () => {
  const repoRoot = makeTempRepo();
  // 'secondbrain' (registry key) vs 'inbox' (display label) -- deliberately different
  // strings, same real-world pattern as the actual codebase. Must NOT be flagged.
  writeFixture(repoRoot, STATIC_REL, "const JOB_TYPES = [\n{ source: 'inbox', domain: 'secondbrain', priority: 40 },\n{ source: 'manual', domain: 'adhoc', priority: 10 },\n];\n");
  writeFixture(repoRoot, SOURCE_REL, "registerTaskSource('secondbrain', { priority: 40, next: nextSecondBrainTask });\nregisterTaskSource('adhoc', { priority: 10, next: nextAdhocTask });\n");

  const result = checkPair(repoRoot, pair());
  assert.equal(result.error, undefined);
  assert.deepEqual(result.missingFromStatic, []);
  assert.deepEqual(result.staleInStatic, []);
});

test('checkPair flags a priority registered but missing from the static list', () => {
  const repoRoot = makeTempRepo();
  writeFixture(repoRoot, STATIC_REL, "const JOB_TYPES = [\n{ source: 'a', priority: 10 },\n];\n");
  writeFixture(repoRoot, SOURCE_REL, "registerTaskSource('a', { priority: 10, next: fn });\nregisterTaskSource('b', { priority: 82, next: fn });\n");

  const result = checkPair(repoRoot, pair());
  assert.equal(result.error, undefined);
  assert.deepEqual(result.missingFromStatic, ['82']);
  assert.deepEqual(result.staleInStatic, []);
});

test('checkPair flags a stale priority left in the static list after removal from the registry', () => {
  const repoRoot = makeTempRepo();
  writeFixture(repoRoot, STATIC_REL, "const JOB_TYPES = [\n{ source: 'a', priority: 10 },\n{ source: 'b', priority: 82 },\n];\n");
  writeFixture(repoRoot, SOURCE_REL, "registerTaskSource('a', { priority: 10, next: fn });\n");

  const result = checkPair(repoRoot, pair());
  assert.equal(result.error, undefined);
  assert.deepEqual(result.missingFromStatic, []);
  assert.deepEqual(result.staleInStatic, ['82']);
});

test('checkPair reports both missing and stale simultaneously, each sorted', () => {
  const repoRoot = makeTempRepo();
  writeFixture(repoRoot, STATIC_REL, "const JOB_TYPES = [\n{ source: 'z', priority: 99 },\n{ source: 'old', priority: 20 },\n];\n");
  writeFixture(repoRoot, SOURCE_REL, "registerTaskSource('z', { priority: 99, next: fn });\nregisterTaskSource('new_b', { priority: 82, next: fn });\nregisterTaskSource('new_a', { priority: 81, next: fn });\n");

  const result = checkPair(repoRoot, pair());
  assert.deepEqual(result.missingFromStatic, ['81', '82']);
  assert.deepEqual(result.staleInStatic, ['20']);
});

test('checkPair errors clearly when the static file is missing entirely', () => {
  const repoRoot = makeTempRepo();
  writeFixture(repoRoot, SOURCE_REL, "registerTaskSource('a', { priority: 10, next: fn });\n");

  const result = checkPair(repoRoot, pair());
  assert.match(result.error, /could not read/);
});

test('checkPair errors when the start/end markers no longer bound anything (renamed array)', () => {
  const repoRoot = makeTempRepo();
  writeFixture(repoRoot, STATIC_REL, "const RENAMED_ARRAY = [\n{ source: 'a', priority: 10 },\n];\n");
  writeFixture(repoRoot, SOURCE_REL, "registerTaskSource('a', { priority: 10, next: fn });\n");

  const result = checkPair(repoRoot, pair());
  assert.match(result.error, /could not locate/);
});

test('checkPair errors when the value regex matches the block but extracts nothing (regex drifted from real syntax)', () => {
  const repoRoot = makeTempRepo();
  // Block exists, but no `priority:` field at all -- shape changed underneath the regex.
  writeFixture(repoRoot, STATIC_REL, "const JOB_TYPES = [\n{ source: 'a', rank: 10 },\n];\n");
  writeFixture(repoRoot, SOURCE_REL, "registerTaskSource('a', { priority: 10, next: fn });\n");

  const result = checkPair(repoRoot, pair());
  assert.match(result.error, /extracted zero values/);
});

test('checkPair is not confused by an unrelated top-level array sharing the end marker text', () => {
  const repoRoot = makeTempRepo();
  writeFixture(
    repoRoot,
    STATIC_REL,
    "const OTHER = [1, 2];\nconst JOB_TYPES = [\n{ source: 'a', priority: 10 },\n{ source: 'b', priority: 20 },\n];\nconst AFTER = [3];\n"
  );
  writeFixture(repoRoot, SOURCE_REL, "registerTaskSource('a', { priority: 10, next: fn });\nregisterTaskSource('b', { priority: 20, next: fn });\n");

  const result = checkPair(repoRoot, pair());
  assert.equal(result.error, undefined);
  assert.deepEqual(result.missingFromStatic, []);
  assert.deepEqual(result.staleInStatic, []);
});
