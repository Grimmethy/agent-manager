'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cal = require('./poll-calibrate.js');

// A fake file system: { '/r/a': { 'x.js': 'text', ... } }. listFiles returns the relative names, readFile the text (null when unknown).
const fakeFs = (repos) => ({
  listFiles: (root) => (repos[root] ? Object.keys(repos[root]) : null),
  readFile: (abs) => {
    for (const [root, files] of Object.entries(repos)) {
      if (abs.startsWith(root + '/')) { const rel = abs.slice(root.length + 1); if (rel in files) return files[rel]; }
    }
    return null;
  },
});
const projects = (...roots) => roots.map((r) => ({ repoRoot: r, label: path.basename(r), pool: true }));

test('counts per language and per repo, split into poll and info, with byKind and annotated', () => {
  const f = fakeFs({
    '/r/alpha': {
      'a.js': 'setInterval(a, 1);\nsetInterval(b, 2); // poll-ok: reason here',
      'b.py': 'def f():\n    while True:\n        time.sleep(1)',
      'ci.yml': 'services:\n  db:\n    healthcheck:\n      interval: 5s',
    },
    '/r/beta': { 'c.js': 'setInterval(c, 3);', 'notes.md': 'setInterval(x, 1);' },
  });
  const r = cal.calibrate({ projects: projects('/r/alpha', '/r/beta'), ...f });
  assert.deepStrictEqual(r.perLanguage.js, { poll: 3, info: 0, annotated: 1, byKind: { 'set-interval': 3 } });
  assert.deepStrictEqual(r.perLanguage.py, { poll: 1, info: 0, annotated: 0, byKind: { 'sleep-loop': 1 } });
  assert.deepStrictEqual(r.perLanguage.yaml, { poll: 0, info: 1, annotated: 0, byKind: { 'healthcheck-interval': 1 } });
  assert.deepStrictEqual(r.perRepo, { alpha: { poll: 3, info: 1 }, beta: { poll: 1, info: 0 } });
  assert.strictEqual(r.totals.repos, 2);
  assert.strictEqual(r.totals.files, 4);
});

test('a repo whose root is missing (listFiles null or throwing) is skipped and named', () => {
  const f = fakeFs({ '/r/alpha': { 'a.js': 'setInterval(a, 1);' } });
  const throwing = { ...f, listFiles: (root) => { if (root === '/r/boom') throw new Error('not a git repo'); return f.listFiles(root); } };
  const r = cal.calibrate({ projects: projects('/r/alpha', '/r/gone', '/r/boom'), ...throwing });
  assert.deepStrictEqual(r.totals.skippedRepos, ['gone', 'boom']);
  assert.deepStrictEqual(Object.keys(r.perRepo), ['alpha']);
  assert.strictEqual(r.totals.repos, 1);
});

test('the same checkout listed twice (two spellings of one real directory) is counted once', () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-cal-'));
  const link = real + '-link';
  fs.symlinkSync(real, link);
  try {
    const f = { listFiles: () => ['a.js'], readFile: () => 'setInterval(a, 1);' };
    const r = cal.calibrate({ projects: [{ repoRoot: real, label: 'one' }, { repoRoot: link, label: 'two' }], ...f });
    assert.deepStrictEqual(r.perRepo, { one: { poll: 1, info: 0 } });
    assert.deepStrictEqual(r.totals.duplicateRepos, ['two']);
    assert.strictEqual(r.totals.repos, 1);
  } finally { fs.unlinkSync(link); fs.rmSync(real, { recursive: true, force: true }); }
});

test('two different checkouts with one label stay apart', () => {
  const f = fakeFs({ '/r/a/app': { 'a.js': 'setInterval(a, 1);' }, '/r/b/app': { 'a.js': 'setInterval(a, 1);' } });
  const r = cal.calibrate({ projects: [{ repoRoot: '/r/a/app', label: 'app' }, { repoRoot: '/r/b/app', label: 'app' }], ...f });
  assert.deepStrictEqual(Object.keys(r.perRepo).sort(), ['app', 'app (/r/b/app)']);
});

test('vendor and generated directories are skipped; a file NAMED like one is not', () => {
  const body = 'setInterval(a, 1);';
  const f = fakeFs({ '/r/x': {
    'node_modules/p/i.js': body, '.venv/lib/x.py': 'while True:\n    time.sleep(1)', 'venv/a.js': body, 'vendor/tokenfold/a.js': body, 'dist/a.js': body, 'build/a.js': body,
    'graphify-out/a.js': body, 'task-logs/a.js': body, 'queue/adhoc/a.js': body, 'pkg/__pycache__/a.js': body, 'src/node_modules/deep/a.js': body, 'src/keep.js': body, 'queue.js': body,
  } });
  const r = cal.calibrate({ projects: projects('/r/x'), ...f });
  assert.strictEqual(r.perLanguage.js.poll, 2);
  assert.strictEqual(r.totals.files, 2);
  for (const dir of cal.SKIP_DIRS) assert.ok(cal.isSkippedPath(`${dir}/a.js`), dir);
  assert.strictEqual(cal.isSkippedPath('src/dist.js'), false);
  assert.strictEqual(cal.isSkippedPath('build'), false);          // a FILE named like a skipped directory is not inside one
  assert.strictEqual(cal.isSkippedPath('src/queue'), false);
});

test('an extensionless file is classified by its first line; no shebang or an unknown one is skipped; a known non-code extension is never read', () => {
  const reads = [];
  const files = {
    'bin/run': '#!/bin/bash\nwhile true; do\n  sleep 5\ndone',
    'bin/node-tool': '#!/usr/bin/env node\nsetInterval(a, 1);',
    'Makefile': 'all:\n\techo hi',
    'bin/perl-tool': '#!/usr/bin/perl\nsleep 5 while 1;',
    'data.json': '{ "intervalMs": 5 }',
    'README.md': 'setInterval(a, 1);',
  };
  const r = cal.calibrate({ projects: projects('/r/x'), listFiles: () => Object.keys(files), readFile: (abs) => { reads.push(path.basename(abs)); return files[abs.slice('/r/x/'.length)]; } });
  assert.deepStrictEqual(r.perLanguage.sh, { poll: 1, info: 0, annotated: 0, byKind: { 'sleep-loop': 1 } });
  assert.strictEqual(r.perLanguage.js.poll, 1);
  assert.ok(!reads.includes('data.json') && !reads.includes('README.md'), 'a .json or .md file was read');
  assert.strictEqual(r.totals.files, 2);
});

test('test files and unreadable files are skipped', () => {
  const f = fakeFs({ '/r/x': { 'a.test.js': 'setInterval(a, 1);', 'tests/b.js': 'setInterval(b, 1);', 'ok.js': 'setInterval(c, 1);' } });
  const unreadable = { listFiles: () => ['gone.js', 'ok.js'], readFile: (abs) => (abs.endsWith('ok.js') ? 'setInterval(c, 1);' : null) };
  assert.strictEqual(cal.calibrate({ projects: projects('/r/x'), ...f }).perLanguage.js.poll, 1);
  const r = cal.calibrate({ projects: projects('/r/y'), ...unreadable });
  assert.strictEqual(r.perLanguage.js.poll, 1);
  assert.strictEqual(r.totals.files, 1);
});

test('the sample is deterministic: sorted by signature, every k-th, capped, in any input order, each with its source line', () => {
  const lines = Array.from({ length: 100 }, (_, i) => `setInterval(job${i}, ${i + 1});`);
  const make = (order) => fakeFs({ '/r/x': { 'a.js': order.join('\n') } });
  const a = cal.calibrate({ projects: projects('/r/x'), ...make(lines), sample: 10 });
  const b = cal.calibrate({ projects: projects('/r/x'), ...make([...lines].reverse()), sample: 10 });
  assert.strictEqual(a.samples.js.length, 10);
  assert.deepStrictEqual(a.samples.js.map((s) => s.snippet), b.samples.js.map((s) => s.snippet));
  assert.deepStrictEqual(Object.keys(a.samples.js[0]).sort(), ['kind', 'line', 'path', 'repo', 'severity', 'snippet']);
  assert.strictEqual(a.samples.js[0].repo, 'x');
  assert.match(a.samples.js[0].snippet, /^setInterval\(job\d+, \d+\);$/);
  // 100 findings, sample 10: every 10th of the signature-sorted list
  const sorted = cal.pickSample(Array.from({ length: 100 }, (_, i) => ({ signature: String(1000 + i), repo: 'x', path: 'a', line: i })), 10);
  assert.deepStrictEqual(sorted.map((s) => s.line), [0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
});

test('sample sizes: default 30, fewer findings than the sample returns them all, 0 returns none', () => {
  const lines = Array.from({ length: 50 }, (_, i) => `setInterval(job${i}, 1);`).join('\n');
  const f = fakeFs({ '/r/x': { 'a.js': lines } });
  assert.strictEqual(cal.calibrate({ projects: projects('/r/x'), ...f }).samples.js.length, 30);
  assert.strictEqual(cal.calibrate({ projects: projects('/r/x'), ...f, sample: 500 }).samples.js.length, 50);
  assert.deepStrictEqual(cal.calibrate({ projects: projects('/r/x'), ...f, sample: 0 }).samples.js, []);
  assert.strictEqual(cal.DEFAULT_SAMPLE, 30);
});

test('calibrate with no projects (missing, null or empty) returns empty counts instead of throwing', () => {
  for (const args of [{}, { projects: null }, { projects: [] }]) {
    const r = cal.calibrate({ ...args, listFiles: () => [], readFile: () => null });
    assert.deepStrictEqual([r.perLanguage, r.perRepo, r.samples, r.totals], [{}, {}, {}, { repos: 0, files: 0, skippedRepos: [], duplicateRepos: [] }]);
  }
});

test('formatReport names both kinds of skipped repo', () => {
  const text = cal.formatReport({ perLanguage: {}, perRepo: {}, samples: {}, totals: { repos: 1, files: 2, skippedRepos: ['gone'], duplicateRepos: ['twin'] } });
  assert.match(text, /skipped \(root missing\): gone; skipped \(same checkout listed twice\): twin/);
});

test('onProgress is called once per project with its label, index and the total', () => {
  const calls = [];
  cal.calibrate({ projects: projects('/r/a', '/r/b'), listFiles: () => [], readFile: () => null, onProgress: (...args) => calls.push(args) });
  assert.deepStrictEqual(calls, [['a', 0, 2], ['b', 1, 2]]);
});

test('formatReport lists counts, kinds, per-repo counts, samples with their lines, notes on skipped repos, and ends with the provisional rule', () => {
  const f = fakeFs({ '/r/alpha': { 'a.js': 'setInterval(a, 1);' } });
  const text = cal.formatReport(cal.calibrate({ projects: projects('/r/alpha', '/r/gone'), ...f, sample: 5 }));
  assert.match(text, /1 repo\(s\), 1 file\(s\) scanned; skipped \(root missing\): gone/);
  assert.match(text, /js\s+poll\s+1\s+info\s+0\s+annotated\s+0\s+set-interval 1/);
  assert.match(text, /alpha\s+poll\s+1\s+info\s+0/);
  assert.match(text, /alpha a\.js:1 \[set-interval\/poll\]\s+setInterval\(a, 1\);/);
  assert.ok(text.trimEnd().endsWith(cal.PROVISIONAL_RULE));
  assert.match(cal.PROVISIONAL_RULE, /shadow mode/);
  assert.match(cal.PROVISIONAL_RULE, /at least 50/);
  assert.match(cal.PROVISIONAL_RULE, /under 10%/);
  assert.match(cal.PROVISIONAL_RULE, /changeable by the owner/);
});

test('the module imports nothing from agent-manager outside src/lib (only built-ins and ./poll-detector.js)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'poll-calibrate.js'), 'utf8');
  const required = [...src.matchAll(/require\(\s*(['"])([^'"]+)\1\s*\)/g)].map((m) => m[2]).sort();
  assert.deepStrictEqual(required, ['./poll-detector.js', 'fs', 'path']);
});
