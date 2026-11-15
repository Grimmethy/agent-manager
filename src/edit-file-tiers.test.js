'use strict';

// Tiered edit_file matching (brain-dump 1890): exact first; with AGENT_MANAGER_EDIT_FILE_TIERS on, a whitespace-
// or indentation-relaxed line match (re-indented) and a JSON-unescaped retry; off (default), the same tiers run only
// as a non-enumerable matchProbe for the tool-loop audit. Real files in a temp dir, through the real editFileTool.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { editFileTool, unescapeJsonText, editTiersEnabled, closestMatchHint } = require('./local-tool-fs-tools.js');
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
  assert.ok(r.error.startsWith(NOT_FOUND), 'a non-matching second line still misses');
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

test('off: file untouched, model-visible result identical to the old message, non-enumerable matchProbe set', () => {
  const f = fixture(SRC);
  const r = withTiers('off', () => editFileTool(f.roots, { path: 'f.js', find: '      return 1;', replace: 'return 13;' }));
  assert.equal(f.read(), SRC);
  assert.equal(JSON.stringify(r), JSON.stringify({ error: NOT_FOUND }));
  assert.deepEqual(Object.keys(r), ['error']);
  assert.equal(r.matchProbe, 'flexible-strip');
  for (const v of ['off', '0', 'false', 'OFF']) {
    const g = fixture(SRC);
    withTiers(v, () => editFileTool(g.roots, { path: 'f.js', find: '      return 1;', replace: 'x' }));
    assert.equal(g.read(), SRC, v);
  }
});

test('default (unset or empty) is ON since 2026-11-10: an indentation miss is applied', () => {
  for (const v of [undefined, '', 'on']) {
    assert.equal(withTiers(v, () => editTiersEnabled()), true, String(v));
  }
  const f = fixture(SRC);
  const r = withTiers(undefined, () => editFileTool(f.roots, { path: 'f.js', find: '      return 1;', replace: 'return 13;' }));
  assert.equal(r.edited, true);
  assert.equal(r.matchStrategy, 'flexible-strip');
});

const BIG = 'const alpha = 1;\nfunction computeTotal(items, taxRate) {\n  const sum = items.reduce((a, b) => a + b.price, 0);\n  return sum * (1 + taxRate);\n}\nmodule.exports = { computeTotal };\n';

test('miss hint: a near-miss gets the closest lines with numbers, original sentence first', () => {
  const f = fixture(BIG);
  const r = withTiers('on', () => editFileTool(f.roots, { path: 'f.js', find: 'function computeTotals(items, taxrate) {', replace: 'x' }));
  assert.ok(r.error.startsWith(NOT_FOUND), 'existing wording stays the first sentence');
  assert.match(r.error, /Closest text in the file \(line 2 is the best match/);
  assert.match(r.error, /2\| function computeTotal\(items, taxRate\) \{/);
  assert.equal(f.read(), BIG, 'no edit made');
});

test('miss hint: an unrelated find gets no hint', () => {
  const f = fixture(BIG);
  const r = withTiers('on', () => editFileTool(f.roots, { path: 'f.js', find: 'completely different words about databases', replace: 'x' }));
  assert.equal(r.error, NOT_FOUND);
});

test('miss hint: capped at 600 characters of file text and 6 lines, long lines cut', () => {
  const line = 'const longName = someFunction(' + 'param, '.repeat(18) + ');';
  const content = (line + '\n').repeat(20);
  const find = line.replace('param', 'parm');
  const h = closestMatchHint(content, find);
  const rows = h.split('\n').filter((l) => /^\d+\| /.test(l));
  assert.ok(rows.length >= 1 && rows.length <= 6, `rows ${rows.length}`);
  assert.ok(rows.join('\n').length <= 600, `row text ${rows.join('\n').length}`);
  assert.ok(rows.length < 6, 'the character cap, not the line cap, stopped it');
  const huge = closestMatchHint(('x'.repeat(300) + ' marker_line_here\n').repeat(3), 'x'.repeat(300) + ' marker_line_here');
  assert.ok(huge.split('\n').every((l) => l.length <= 165 + 5 || !/^\d+\|/.test(l)), 'long lines are cut to 160 chars');
});

test('miss hint: anchored on the first non-blank line of a multi-line find, and works on CRLF files', () => {
  const crlf = BIG.replace(/\n/g, '\r\n');
  const f = fixture(crlf);
  const r = withTiers('on', () => editFileTool(f.roots, { path: 'f.js', find: '\n\nfunction computeTotals(items, taxrate) {\n  return 0;\n}', replace: 'x' }));
  assert.match(r.error, /line 2 is the best match/);
  assert.ok(!r.error.includes('\r'), 'no carriage returns leak into the hint');
});

test('miss hint: switched off with AGENT_MANAGER_EDIT_FILE_TIERS=off', () => {
  const f = fixture(BIG);
  const r = withTiers('off', () => editFileTool(f.roots, { path: 'f.js', find: 'function computeTotals(items, taxrate) {', replace: 'x' }));
  assert.equal(r.error, NOT_FOUND);
});

test('tool-loop audit records matchStrategy and matchProbe, and buildSummary counts them', () => {
  const f = fixture(SRC);
  const applied = withTiers('on', () => editFileTool(f.roots, { path: 'f.js', find: '      return 1;', replace: 'return 14;' }));
  const g = fixture(SRC);
  const missed = withTiers('off', () => editFileTool(g.roots, { path: 'f.js', find: '      return 2;', replace: 'return 20;' }));
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
