'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const grounding = require('../src/plan-grounding.js');

const MODULE = require.resolve('../src/codebase-map-grounding.js');
const TASK = { source: 'manual', promptContext: { rawText: 'Fix anchorFn in `src/anchor.js` so mappedFn works' } };
const ANCHOR_HEADER = 'FILES THIS TASK NAMES';
const MAP_HEADER = 'CODEBASE MAP MATCHES';

function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'map-ground-'));
  for (const rel of Object.keys(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, files[rel]);
  }
  return root;
}

function baseRepo(extra) {
  return makeRepo(Object.assign({
    'src/anchor.js': 'function anchorFn() { return 1; }',
    'src/mapped.js': 'function mappedFn() { return 2; }',
  }, extra || {}));
}

function stubMatcher(impl) {
  const calls = { n: 0 };
  require.cache[MODULE] = {
    id: MODULE, filename: MODULE, loaded: true,
    exports: { matchCodebaseMap: (args) => { calls.n += 1; return impl(args); } },
  };
  return calls;
}

function restoreMatcher() { delete require.cache[MODULE]; }

function run(repoRoot, envValue) {
  const prev = process.env.AGENT_MANAGER_MAP_GROUNDING;
  if (envValue === undefined) delete process.env.AGENT_MANAGER_MAP_GROUNDING;
  else process.env.AGENT_MANAGER_MAP_GROUNDING = envValue;
  try {
    return grounding.buildPlanGrounding(TASK, { repoRoot });
  } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_MAP_GROUNDING;
    else process.env.AGENT_MANAGER_MAP_GROUNDING = prev;
  }
}

test('protected case: anchor plus a distinct map match', () => {
  const repoRoot = baseRepo();
  const calls = stubMatcher(() => ['src/mapped.js']);
  try {
    const out = run(repoRoot, undefined);
    assert.deepStrictEqual(out.mapPaths, ['src/mapped.js']);
    assert.deepStrictEqual(out.anchorPaths, ['src/anchor.js']);
    assert.ok(out.text.indexOf(MAP_HEADER) > out.text.indexOf(ANCHOR_HEADER));
    assert.strictEqual(calls.n, 1);
  } finally { restoreMatcher(); }
});

for (const off of ['0', 'false']) {
  test('kill switch off with ' + off + ': no matcher call, no map section', () => {
    const repoRoot = baseRepo();
    const calls = stubMatcher(() => ['src/mapped.js']);
    try {
      const out = run(repoRoot, off);
      assert.strictEqual(calls.n, 0);
      assert.deepStrictEqual(out.mapPaths, []);
      assert.strictEqual(out.mapStats.enabled, false);
      assert.ok(!out.text.includes(MAP_HEADER));
    } finally { restoreMatcher(); }
  });
}

for (const on of [undefined, '1']) {
  test('kill switch on with ' + String(on) + ': map section present', () => {
    const repoRoot = baseRepo();
    stubMatcher(() => ['src/mapped.js']);
    try {
      const out = run(repoRoot, on);
      assert.deepStrictEqual(out.mapPaths, ['src/mapped.js']);
      assert.strictEqual(out.mapStats.enabled, true);
    } finally { restoreMatcher(); }
  });
}

test('same basename in a different directory is kept', () => {
  const repoRoot = baseRepo({ 'lib/anchor.js': 'function other() { return 3; }' });
  stubMatcher(() => ['lib/anchor.js']);
  try {
    const out = run(repoRoot, undefined);
    assert.deepStrictEqual(out.mapPaths, ['lib/anchor.js']);
    assert.deepStrictEqual(out.anchorPaths, ['src/anchor.js']);
  } finally { restoreMatcher(); }
});

test('anchor duplicate with ./ prefix is counted, not duplicated', () => {
  const repoRoot = baseRepo();
  stubMatcher(() => ['./src/anchor.js']);
  try {
    const out = run(repoRoot, undefined);
    assert.deepStrictEqual(out.mapPaths, []);
    assert.strictEqual(out.mapStats.skippedDuplicate, 1);
  } finally { restoreMatcher(); }
});

test('unreadable map file does not stop the other map files', () => {
  const repoRoot = baseRepo();
  stubMatcher(() => ['src/missing.js', 'src/mapped.js']);
  try {
    const out = run(repoRoot, undefined);
    assert.deepStrictEqual(out.mapPaths, ['src/mapped.js']);
    assert.strictEqual(out.mapStats.skippedUnreadable, 1);
  } finally { restoreMatcher(); }
});

test('matcher throws: error recorded, grounding still returned', () => {
  const repoRoot = baseRepo();
  stubMatcher(() => { throw new Error('boom'); });
  try {
    const out = run(repoRoot, undefined);
    assert.ok(out && out.text.includes(ANCHOR_HEADER));
    assert.deepStrictEqual(out.mapPaths, []);
    assert.ok(String(out.mapStats.error).includes('boom'));
  } finally { restoreMatcher(); }
});

test('ordering: anchor < map < grep (grep check applies when grep hits exist)', () => {
  const repoRoot = baseRepo();
  stubMatcher(() => ['src/mapped.js']);
  try {
    const out = run(repoRoot, undefined);
    const a = out.text.indexOf(ANCHOR_HEADER);
    const m = out.text.indexOf(MAP_HEADER);
    const g = out.text.indexOf('GREP HITS');
    assert.ok(a >= 0 && m >= 0);
    assert.ok(a < m);
    if (g >= 0) assert.ok(m < g);
  } finally { restoreMatcher(); }
});

test('bound: text.length is at most PLAN_GROUNDING_MAX_CHARS exactly', () => {
  const repoRoot = baseRepo({
    'src/anchor.js': 'a'.repeat(9000),
    'src/mapped.js': 'b'.repeat(9000),
  });
  stubMatcher(() => ['src/mapped.js']);
  try {
    const out = run(repoRoot, undefined);
    assert.ok(out.text.length <= grounding.PLAN_GROUNDING_MAX_CHARS);
  } finally { restoreMatcher(); }
});
