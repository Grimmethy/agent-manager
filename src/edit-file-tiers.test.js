'use strict';

// Tiered edit_file matching (brain-dump 1890): exact first; with AGENT_MANAGER_EDIT_FILE_TIERS on, a whitespace-
// or indentation-relaxed line match (re-indented) and a JSON-unescaped retry; off (default), the same tiers run only
// as a non-enumerable matchProbe for the tool-loop audit. Real files in a temp dir, through the real editFileTool.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { editFileTool, unescapeJsonText } = require('./local-tool-fs-tools.js');
const { buildToolOutcomeEntries, buildSummary } = require('./tool-loop-audit.js');

function withTiers(value, fn) {
  const prev = process.env.AGENT_MANAGER_EDIT_FILE_TIERS;
  if (value === undefined) delete process.env.AGENT_MANAGER_EDIT_FILE_TIERS; else process.env.AGENT_MANAGER_EDIT_FILE_TIERS = value;
  try { return fn(); } finally { if (prev === undefined) delete process.env.AGENT_MANAGER_EDIT_FILE_TIERS; else process.env.AGENT_MANAGER_EDIT_FILE_TIERS = prev; }
}

function fixture(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-tiers-'));
  fs.writeFileSync(path.join(dir, 'f.js'), content);
  return { roots: [dir], read: () => fs.readFileSync(path.join(dir, 'f.js'), 'utf8') };
}

const SRC = 'function a() {\n  if (x) {\n    return 1;\n  }\n  return 2;\n}\n';
const NOT_FOUND = '"find" text not found verbatim in f.js -- no change made. Re-read the file and match it exactly.';

test('exact match path is unchanged (no matchStrategy field, same result shape)', () => {
  const f = fixture(SRC);
  const r = withTiers('on', () => editFileTool(f.roots, { path: 'f.js', find: '    return 1;', replace: '    return 10;' }));
  assert.deepEqual(r, { path: 'f.js', edited: true });
  assert.match(f.read(), /return 10;/);
});

test('on: trailing-whitespace difference -> flexible-rstrip, applied once', () => {
  const f = fixture(SRC);
  const r = withTiers('on', () => editFileTool(f.roots, { path: 'f.js', find: '    return 1;   \n  }', replace: '    return 11;\n  }' }));
  assert.deepEqual(r, { path: 'f.js', edited: true, matchStrategy: 'flexible-rstrip' });
  assert.equal(f.read(), 'function a() {\n  if (x) {\n    return 11;\n  }\n  return 2;\n}\n');
});

test('on: indentation difference -> flexible-strip, replacement re-indented to the file (nested block keeps relative indent)', () => {
  const f = fixture(SRC);
  const r = withTiers('on', () => editFileTool(f.roots, { path: 'f.js', find: 'if (x) {\n  return 1;\n}', replace: 'if (x) {\n  log();\n  return 1;\n}' }));
  assert.equal(r.matchStrategy, 'flexible-strip');
  assert.equal(f.read(), 'function a() {\n  if (x) {\n    log();\n    return 1;\n  }\n  return 2;\n}\n');
});

test('on: CRLF file keeps CRLF line endings', () => {
  const f = fixture(SRC.replace(/\n/g, '\r\n'));
  const r = withTiers('on', () => editFileTool(f.roots, { path: 'f.js', find: 'return 1;\nXX', replace: 'y' }));
  assert.equal(r.error, NOT_FOUND, 'a non-matching second line still misses');
  const r2 = withTiers('on', () => editFileTool(f.roots, { path: 'f.js', find: '      return 1;', replace: 'return 12;' }));
  assert.equal(r2.matchStrategy, 'flexible-strip');
  assert.equal(f.read(), 'function a() {\r\n  if (x) {\r\n    return 12;\r\n  }\r\n  return 2;\r\n}\r\n');
});

test('on: JSON-escaped find/replace -> unescaped tier', () => {
  const f = fixture(SRC);
  const r = withTiers('on', () => editFileTool(f.roots, { path: 'f.js', find: '  if (x) {\\n    return 1;', replace: '  if (x) {\\n    return \\"one\\";' }));
  assert.equal(r.matchStrategy, 'unescaped');
  assert.match(f.read(), /return "one";/);
  assert.equal(unescapeJsonText('a\nb'), null, 'real newlines: not escaped text');
  assert.equal(unescapeJsonText('plain'), null);
});

test('on: an ambiguous or absent fallback leaves the file untouched with the existing message', () => {
  const dup = 'x();\n  x();\n';
  const f = fixture(dup);
  const r = withTiers('on', () => editFileTool(f.roots, { path: 'f.js', find: '    x();', replace: 'y();' }));
  assert.equal(r.error, NOT_FOUND);
  assert.equal(r.matchProbe, 'flexible-strip-ambiguous');
  assert.equal(f.read(), dup);
  const g = fixture(SRC);
  const r2 = withTiers('on', () => editFileTool(g.roots, { path: 'f.js', find: 'nothing like this', replace: 'z' }));
  assert.equal(r2.error, NOT_FOUND);
  assert.equal(r2.matchProbe, undefined);
  assert.equal(g.read(), SRC);
});

test('off (default): file untouched, model-visible result identical to today, non-enumerable matchProbe set', () => {
  const f = fixture(SRC);
  const r = withTiers(undefined, () => editFileTool(f.roots, { path: 'f.js', find: '      return 1;', replace: 'return 13;' }));
  assert.equal(f.read(), SRC);
  assert.equal(JSON.stringify(r), JSON.stringify({ error: NOT_FOUND }));
  assert.deepEqual(Object.keys(r), ['error']);
  assert.equal(r.matchProbe, 'flexible-strip');
  for (const v of ['off', '0', 'false', '']) {
    const g = fixture(SRC);
    withTiers(v, () => editFileTool(g.roots, { path: 'f.js', find: '      return 1;', replace: 'x' }));
    assert.equal(g.read(), SRC, v);
  }
});

test('tool-loop audit records matchStrategy and matchProbe, and buildSummary counts them', () => {
  const f = fixture(SRC);
  const applied = withTiers('on', () => editFileTool(f.roots, { path: 'f.js', find: '      return 1;', replace: 'return 14;' }));
  const g = fixture(SRC);
  const missed = withTiers(undefined, () => editFileTool(g.roots, { path: 'f.js', find: '      return 2;', replace: 'return 20;' }));
  const exact = withTiers(undefined, () => editFileTool(g.roots, { path: 'f.js', find: 'return 2;', replace: 'return 21;' }));
  const ctx = { lane: 'worker-3090', model: 'm', turn: 0 };
  const entries = buildToolOutcomeEntries(ctx, [
    { tool: 'edit_file', args: { find: 'a', replace: 'b' }, result: applied },
    { tool: 'edit_file', args: { find: 'a', replace: 'b' }, result: missed },
    { tool: 'edit_file', args: { find: 'a', replace: 'b' }, result: exact },
  ]);
  assert.deepEqual(entries.map((e) => [e.outcome, e.matchStrategy, e.matchProbe]),
    [['applied', 'flexible-strip', null], ['not-found', null, 'flexible-strip'], ['applied', 'exact', null]]);
  const row = buildSummary(entries.map((e) => ({ ...e, type: 'tool-outcome' })))[0];
  assert.deepEqual(row.tools.edit_file.strategies, { 'flexible-strip': 1, exact: 1 });
  assert.deepEqual(row.tools.edit_file.probes, { 'flexible-strip': 1 });
});
