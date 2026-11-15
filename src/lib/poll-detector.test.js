'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const det = require('./poll-detector.js');

const tableOf = (kind, re, languages = ['js']) => ({ languages, rules: [{ kind, severity: 'poll', test: (ctx) => re.test(ctx.lines[ctx.index]) && ctx.lines[ctx.index].trim() }] });
const SETI = tableOf('set-interval', /setInterval\(/);

test('parseAnnotation: every comment style, on the same line and on the line above', () => {
  const styles = ['// poll-ok: x', '/* poll-ok: x */', '<!-- poll-ok: x -->', '# poll-ok: x', 'REM poll-ok: x', ':: poll-ok: x', '-- poll-ok: x'];
  for (const c of styles) {
    assert.deepStrictEqual(det.parseAnnotation([`code(); ${c}`], 0), { annotated: true, reason: 'x' }, `same line: ${c}`);
    assert.deepStrictEqual(det.parseAnnotation([c, 'code();'], 1), { annotated: true, reason: 'x' }, `line above: ${c}`);
  }
});

test('parseAnnotation: an empty reason does not count, nor does a marker two lines above or outside a comment', () => {
  for (const c of ['// poll-ok:', '// poll-ok:   ', '/* poll-ok: */', '<!-- poll-ok: -->']) assert.strictEqual(det.parseAnnotation([c], 0).annotated, false, c);
  assert.strictEqual(det.parseAnnotation(['// poll-ok: reason', 'a();', 'b();'], 2).annotated, false);
  assert.strictEqual(det.parseAnnotation(['const poll-ok: reason'], 0).annotated, false);
  assert.deepStrictEqual(det.parseAnnotation(['x'], 5), { annotated: false, reason: null });
});

test('languageOf table', () => {
  const t = { 'a.js': 'js', 'a.mjs': 'js', 'a.cjs': 'js', 'a.jsx': 'js', 'a.ts': 'js', 'a.tsx': 'js', 'a.html': 'js', 'a.py': 'py', 'a.sh': 'sh', 'a.bash': 'sh', 'a.ps1': 'ps1', 'a.bat': 'bat', 'a.cmd': 'bat',
    'a.service': 'systemd', 'a.timer': 'systemd', 'a.yml': 'yaml', 'a.yaml': 'yaml', 'a.sql': 'sql', 'x/plugins.json': 'config', 'task-domains.json': 'config', 'package.json': 'config', 'a.toml': 'config',
    'data.json': null, 'a.md': null, 'a.txt': null, 'a.png': null, 'Makefile': null };
  for (const [file, lang] of Object.entries(t)) assert.strictEqual(det.languageOf(file), lang, file);
});

test('shebangLanguage table', () => {
  const t = { '#!/bin/bash': 'sh', '#!/usr/bin/env bash': 'sh', '#!/bin/sh': 'sh', '#!/usr/bin/env python3': 'py', '#!/usr/bin/python': 'py', '#!/usr/bin/env node': 'js', '#!/usr/bin/env pwsh': 'ps1', '# not a shebang': null, '': null, '#!/usr/bin/perl': null };
  for (const [line, lang] of Object.entries(t)) assert.strictEqual(det.shebangLanguage(line), lang, line);
});

test('isTestPath table', () => {
  for (const p of ['test_a.py', 'x/test_a.py', 'a_test.py', 'a.test.js', 'a.spec.js', 'a.test.mjs', 'test/a.js', 'tests/a.py', 'src/__tests__/a.js', 'src/lib/a.test.js']) assert.strictEqual(det.isTestPath(p), true, p);
  for (const p of ['a.js', 'src/testing.js', 'contest/a.js', 'latest.py', 'scripts/local-worker.sh']) assert.strictEqual(det.isTestPath(p), false, p);
});

test('scanText: a test path returns [] unless includeTests', () => {
  const text = 'setInterval(a, 1);';
  assert.deepStrictEqual(det.scanText({ language: 'js', path: 'a.test.js', text, tables: [SETI] }), []);
  assert.strictEqual(det.scanText({ language: 'js', path: 'a.test.js', text, tables: [SETI], includeTests: true }).length, 1);
});

test('scanText: findings have the contract shape, are sorted, and carry the annotation', () => {
  const text = 'a();\n// poll-ok: dashboard refresh, no event exists\nsetInterval(b, 1);\nsetInterval(c, 2);';
  const found = det.scanText({ language: 'js', path: 'x.js', text, tables: [SETI] });
  assert.deepStrictEqual(found.map((f) => f.line), [3, 4]);
  assert.deepStrictEqual(Object.keys(found[0]).sort(), ['annotated', 'kind', 'language', 'line', 'path', 'reason', 'severity', 'signature', 'snippet']);
  assert.strictEqual(found[0].annotated, true);
  assert.strictEqual(found[0].reason, 'dashboard refresh, no event exists');
  assert.strictEqual(found[1].annotated, false);
  assert.strictEqual(found[0].severity, 'poll');
});

test('scanText: findings from several tables are merged in line order', () => {
  const late = tableOf('late', /second/);
  const early = tableOf('early', /first/);
  const found = det.scanText({ language: 'js', path: 'x.js', text: 'first();\nsecond();\nfirst();', tables: [late, early] });
  assert.deepStrictEqual(found.map((f) => `${f.line}:${f.kind}`), ['1:early', '2:late', '3:early']);
});

test('scanText: a table for another language is not run; no language gives []', () => {
  assert.deepStrictEqual(det.scanText({ language: 'py', path: 'x.py', text: 'setInterval(a)', tables: [SETI] }), []);
  assert.deepStrictEqual(det.scanText({ language: null, path: 'x.md', text: 'setInterval(a)', tables: [SETI] }), []);
});

test('scanText: an .html file is scanned inside <script> blocks only, with real line numbers', () => {
  const text = '<p>setInterval(no, 1)</p>\n<script>\nsetInterval(yes, 2);\n</script>\n<p>setInterval(no, 3)</p>\n<script>setInterval(also, 4);</script>';
  assert.deepStrictEqual(det.scanText({ language: 'js', path: 'p.html', text, tables: [SETI] }).map((f) => f.line), [3, 6]);
});

test('scanText: the default tables come from src/lib/poll-rules (js rules find setInterval)', () => {
  const found = det.scanText({ language: 'js', path: 'x.js', text: 'setInterval(a, 1);' });
  assert.deepStrictEqual(found.map((f) => f.kind), ['set-interval']);
});

test('signatureOf: same after a line move and a whitespace change, different after a snippet change', () => {
  const at = (text, file = 'x.js') => det.scanText({ language: 'js', path: file, text, tables: [SETI] })[0];
  const base = at('setInterval(a, 1);');
  assert.strictEqual(at('\n\n\nsetInterval(a, 1);').signature, base.signature);
  assert.strictEqual(at('setInterval(a,    1);').signature, at('setInterval(a, 1);').signature);
  assert.notStrictEqual(at('setInterval(b, 1);').signature, base.signature);
  assert.notStrictEqual(at('setInterval(a, 1);', 'y.js').signature, base.signature);
  assert.match(base.signature, /^[0-9a-f]{40}$/);
  assert.strictEqual(at('setInterval(a, 1); // trailing comment').signature, base.signature);
});

const DIFF = [
  'diff --git a/src/a.js b/src/a.js', '--- a/src/a.js', '+++ b/src/a.js', '@@ -10,3 +10,4 @@',
  ' setInterval(old, 1);', '-setInterval(removed, 2);', '+setInterval(added, 3);', ' keep();',
].join('\n');

test('scanDiff: reports only ADDED lines (not context, not removed) with new-file line numbers', () => {
  const found = det.scanDiff(DIFF, { tables: [SETI] });
  assert.deepStrictEqual(found.map((f) => [f.path, f.line, f.snippet]), [['src/a.js', 11, 'setInterval(added, 3);']]);
});

test('scanDiff: a new file counts every line as added; deleted, binary and unknown-language files are skipped', () => {
  const diff = [
    'diff --git a/n.js b/n.js', 'new file mode 100644', '--- /dev/null', '+++ b/n.js', '@@ -0,0 +1,2 @@', '+a();', '+setInterval(x, 1);',
    'diff --git a/d.js b/d.js', 'deleted file mode 100644', '--- a/d.js', '+++ /dev/null', '@@ -1 +0,0 @@', '-setInterval(y, 1);',
    'diff --git a/i.png b/i.png', 'Binary files a/i.png and b/i.png differ',
    'diff --git a/n.md b/n.md', 'new file mode 100644', '--- /dev/null', '+++ b/n.md', '@@ -0,0 +1 @@', '+setInterval(z, 1);',
  ].join('\n');
  assert.deepStrictEqual(det.scanDiff(diff, { tables: [SETI] }).map((f) => [f.path, f.line]), [['n.js', 2]]);
});

test('scanDiff: test files are skipped unless includeTests; an annotation on a context line above counts', () => {
  const t = DIFF.replace(/src\/a\.js/g, 'src/a.test.js');
  assert.deepStrictEqual(det.scanDiff(t, { tables: [SETI] }), []);
  assert.strictEqual(det.scanDiff(t, { tables: [SETI], includeTests: true }).length, 1);
  const noted = DIFF.replace(' setInterval(old, 1);', ' // poll-ok: reviewed');
  assert.strictEqual(det.scanDiff(noted, { tables: [SETI] })[0].annotated, true);
});

test('scanDiff: context decides a rule that needs the surrounding lines', () => {
  const rearm = { languages: ['js'], rules: [{ kind: 'k', severity: 'poll', test: (ctx) => /await sleep/.test(ctx.lines[ctx.index]) && ctx.lines.slice(0, ctx.index).some((l) => /while \(true\)/.test(l)) && 'x' }] };
  const diff = ['diff --git a/a.js b/a.js', '--- a/a.js', '+++ b/a.js', '@@ -4,3 +4,3 @@', ' while (true) {', '+  await sleep(1);', ' }'].join('\n');
  assert.deepStrictEqual(det.scanDiff(diff, { tables: [rearm] }).map((f) => f.line), [5]);
});

test('scanDiff: an .html diff inside an existing <script> block is scanned; markup outside is not', () => {
  const diff = ['diff --git a/p.html b/p.html', '--- a/p.html', '+++ b/p.html', '@@ -20,2 +20,3 @@', ' var a = 1;', '+setInterval(x, 1);', ' </script>', '+<p>setInterval(no, 1)</p>'].join('\n');
  assert.deepStrictEqual(det.scanDiff(diff, { tables: [SETI] }).map((f) => f.line), [21]);
});

test('scanDiff: an extensionless new file with a bash shebang is recognised', () => {
  const sh = tableOf('k', /sleep/, ['sh']);
  const diff = ['diff --git a/run b/run', 'new file mode 100755', '--- /dev/null', '+++ b/run', '@@ -0,0 +1,2 @@', '+#!/bin/bash', '+sleep 5'].join('\n');
  assert.deepStrictEqual(det.scanDiff(diff, { tables: [sh] }).map((f) => f.line), [2]);
});

test('loadRules: lists *.rules.js, loads good ones, puts a throwing or malformed one in loadErrors', () => {
  const fake = { readdirSync: () => ['good.rules.js', 'boom.rules.js', 'odd.rules.js', 'notes.txt', 'other.js'] };
  const loaded = [];
  const load = (file) => {
    loaded.push(path.basename(file));
    if (file.endsWith('boom.rules.js')) throw new Error('syntax error in rule file');
    if (file.endsWith('odd.rules.js')) return { languages: 'js' };
    return SETI;
  };
  const { tables, loadErrors } = det.loadRules(fake, { dir: '/x/poll-rules', load });
  assert.deepStrictEqual(loaded, ['boom.rules.js', 'good.rules.js', 'odd.rules.js']);
  assert.deepStrictEqual(tables, [SETI]);
  assert.deepStrictEqual(loadErrors.map((e) => e.file), ['boom.rules.js', 'odd.rules.js']);
  assert.match(loadErrors[0].error, /syntax error/);
});

test('loadRules: the real directory yields the js table and no errors; an unreadable directory is reported, not thrown', () => {
  const real = det.loadRules(fs);
  assert.deepStrictEqual(real.loadErrors, []);
  assert.ok(real.tables.some((t) => t.languages.includes('js')));
  const broken = det.loadRules({ readdirSync: () => { throw new Error('ENOENT'); } });
  assert.strictEqual(broken.tables.length, 0);
  assert.strictEqual(broken.loadErrors.length, 1);
});

test('the module requires only node built-ins (and loads rule files from ./poll-rules)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'poll-detector.js'), 'utf8');
  const required = [...src.matchAll(/require\(\s*(['"])([^'"]+)\1\s*\)/g)].map((m) => m[2]);
  assert.deepStrictEqual(required.sort(), ['crypto', 'fs', 'path']);
  assert.ok(!/from\s+['"]\.\.?\//.test(src));
  assert.match(src, /RULES_DIR = path\.join\(__dirname, 'poll-rules'\)/);
});
