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

test('checkPair extracts priorities from a markdown table (README.md pattern), not just a JS array', () => {
  const repoRoot = makeTempRepo();
  writeFixture(
    repoRoot,
    STATIC_REL,
    [
      '## Built-in task sources',
      '',
      '| Source | Priority | Reads |',
      '|---|---|---|',
      '| `adhoc` | 10 | ... |',
      '| `arch_import` | 81 | ... |',
      '',
      '## Building the codebase graph',
      '',
    ].join('\n')
  );
  writeFixture(repoRoot, SOURCE_REL, "registerTaskSource('adhoc', { priority: 10, next: fn });\nregisterTaskSource('arch_import', { priority: 81, next: fn });\nregisterTaskSource('deep_dive', { priority: 82, next: fn });\n");

  const result = checkPair(repoRoot, pair({
    staticStartMarker: '| Source | Priority | Reads |',
    staticEndMarker: '## Building the codebase graph',
    staticValueRegex: /\|\s*`[^`]+`\s*\|\s*(\d+)\s*\|/g,
  }));
  assert.equal(result.error, undefined);
  assert.deepEqual(result.missingFromStatic, ['82']);
  assert.deepEqual(result.staleInStatic, []);
});

test('checkPair (joined on source name) still flags a newly-registered source missing from the static list even when it shares a priority with an already-listed one', () => {
  // Regression test for the real 2026-08-17 incident: research_task was registered
  // sharing priority 10 with adhoc, and the OLD priority-joined pair() config saw 10
  // already present (via adhoc) so it never flagged research_task as missing --
  // drift-scan reported clean the whole time this bug existed. Joining on source name
  // instead (the real production PAIRS config, not this file's priority-joined test
  // helper) can't have that blind spot: every registry key is unique by construction.
  const repoRoot = makeTempRepo();
  writeFixture(repoRoot, STATIC_REL, "const JOB_TYPES = [\n{ source: 'adhoc', priority: 10 },\n];\n");
  writeFixture(repoRoot, SOURCE_REL, "registerTaskSource('adhoc', { priority: 10, next: fn });\nregisterTaskSource('research_task', { priority: 10, next: fn });\n");

  const result = checkPair(repoRoot, pair({
    staticValueRegex: /source:\s*'([^']+)'/g,
    sourceValueRegex: /registerTaskSource\('([^']+)'/g,
  }));
  assert.equal(result.error, undefined);
  assert.deepEqual(result.missingFromStatic, ['research_task']);
  assert.deepEqual(result.staleInStatic, []);
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

// sourceCommand mode (2026-08-27, Phase 3): the source list comes from a JSON-emitting
// command (`node task-sources.js --dump-topology`) instead of a regex over a file, so a
// pair can be checked against the REAL registry -- built-ins plus AGENT_MANAGER_REGISTER_PATH
// plugin sources -- not just what one file's registerTaskSource() calls reveal.
function commandPair(overrides = {}) {
  return {
    label: 'test command pair',
    staticFile: 'README.md',
    staticStartMarker: '| Source |',
    staticEndMarker: '## Next section',
    staticValueRegex: /^\|\s*`([^`]+)`\s*\|/gm,
    sourceCommand: ['emit-topology.js'],
    sourceJsonNameKey: 'name',
    ...overrides,
  };
}

test('checkPair sourceCommand mode: clean when the table matches the command JSON', () => {
  const repoRoot = makeTempRepo();
  writeFixture(repoRoot, 'emit-topology.js', 'console.log(JSON.stringify([{name:"alpha"},{name:"beta"}]));\n');
  writeFixture(repoRoot, 'README.md', '| Source |\n|---|\n| `alpha` | x |\n| `beta` | y |\n## Next section\n');
  const result = checkPair(repoRoot, commandPair());
  assert.equal(result.error, undefined);
  assert.deepEqual(result.missingFromStatic, []);
  assert.deepEqual(result.staleInStatic, []);
});

test('checkPair sourceCommand mode: flags a source the command reports but the table omits', () => {
  const repoRoot = makeTempRepo();
  writeFixture(repoRoot, 'emit-topology.js', 'console.log(JSON.stringify([{name:"alpha"},{name:"beta"},{name:"gamma"}]));\n');
  writeFixture(repoRoot, 'README.md', '| Source |\n|---|\n| `alpha` | x |\n| `beta` | y |\n## Next section\n');
  const result = checkPair(repoRoot, commandPair());
  assert.deepEqual(result.missingFromStatic, ['gamma']);
  assert.deepEqual(result.staleInStatic, []);
});

test('checkPair sourceCommand mode: errors clearly when the command does not emit JSON', () => {
  const repoRoot = makeTempRepo();
  writeFixture(repoRoot, 'emit-topology.js', 'console.log("not json at all");\n');
  writeFixture(repoRoot, 'README.md', '| Source |\n|---|\n| `alpha` | x |\n## Next section\n');
  const result = checkPair(repoRoot, commandPair());
  assert.match(result.error, /did not return JSON/);
});
