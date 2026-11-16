'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildReport } = require('./hub-branch-assumptions-report.js');

const SCRIPT = path.join(__dirname, 'hub-branch-assumptions-report.js');
const H = '# Hub branch assumptions (generated)';
const tmps = [];

function mkTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hba-'));
  tmps.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
  }
  return root;
}
function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}
function section(report, pattern) {
  const start = report.indexOf('## ' + pattern + '\n');
  assert.ok(start >= 0, 'missing section ' + pattern);
  const next = report.indexOf('\n## ', start + 1);
  const end = next >= 0 ? next : report.indexOf('Grand total');
  return report.slice(start, end);
}

test.after(() => { for (const t of tmps) fs.rmSync(t, { recursive: true, force: true }); });

test('rows have 1-based lines and trimmed text', () => {
  const root = mkTree({ 'src/a.js': 'x\n   const y = readyToMerge(1);   \nz\n' });
  const r = buildReport(root);
  assert.ok(r.startsWith(H + '\n'));
  assert.ok(section(r, 'readyToMerge').includes('- src/a.js:2 -- const y = readyToMerge(1);\n'));
});

test('node_modules and .git are skipped', () => {
  const root = mkTree({
    'src/node_modules/p/i.js': 'readyToMerge\n',
    'src/.git/c': 'readyToMerge\n',
    'scripts/node_modules/q.js': 'readyToMerge\n',
    'src/ok.js': 'readyToMerge\n',
  });
  const r = buildReport(root);
  assert.ok(!r.includes('node_modules'));
  assert.ok(!r.includes('.git'));
  assert.ok(r.includes('- src/ok.js:1 -- readyToMerge'));
  assert.ok(r.includes('Grand total: 1'));
});

test('binary file with NUL byte is skipped', () => {
  const root = mkTree({ 'src/bin.dat': Buffer.from('readyToMerge\0\nreadyToMerge\n') });
  assert.ok(buildReport(root).includes('Grand total: 0'));
});

test('size limit: over 1 MiB skipped, exactly 1 MiB included', () => {
  const head = 'readyToMerge\n';
  const exact = head + 'x'.repeat(1048576 - head.length);
  assert.equal(exact.length, 1048576);
  const root = mkTree({ 'src/exact.js': exact, 'src/big.js': exact + 'y' });
  const r = buildReport(root);
  assert.ok(r.includes('- src/exact.js:1 -- readyToMerge'));
  assert.ok(!r.includes('big.js'));
  assert.ok(r.includes('Grand total: 1'));
});

test('sections list own hits only, sorted by path then line; totals correct', () => {
  const root = mkTree({
    'scripts/z.js': 'hub_for_branch\nreadyToMerge\n',
    'src/b.js': 'a\nreadyToMerge\nhubSiblingConflicts\nreadyToMerge\n',
    'python/a.py': 'agent/decompose-1\nhub_for_branch\n',
    'src/a.js': 'readyToMerge\n',
  });
  const r = buildReport(root);
  assert.deepEqual(section(r, 'readyToMerge').trim().split('\n').filter((l) => l.startsWith('- ')), [
    '- scripts/z.js:2 -- readyToMerge',
    '- src/a.js:1 -- readyToMerge',
    '- src/b.js:2 -- readyToMerge',
    '- src/b.js:4 -- readyToMerge',
  ]);
  assert.ok(section(r, 'readyToMerge').includes('Total: 4 rows'));
  assert.ok(section(r, 'hub_for_branch').includes('Total: 2 rows'));
  assert.ok(section(r, 'hub_for_branch').indexOf('python/a.py:2') < section(r, 'hub_for_branch').indexOf('scripts/z.js:1'));
  assert.ok(section(r, 'hubSiblingConflicts').includes('- src/b.js:3 -- hubSiblingConflicts'));
  assert.ok(section(r, 'agent/decompose-').includes('Total: 1 rows'));
  assert.ok(r.trimEnd().endsWith('Grand total: 8'));
});

test('text is cut at 160 characters', () => {
  const root = mkTree({ 'src/l.js': 'readyToMerge' + 'a'.repeat(300) + '\n' });
  const row = buildReport(root).split('\n').find((l) => l.startsWith('- src/l.js:1 -- '));
  assert.equal(row.slice('- src/l.js:1 -- '.length).length, 160);
});

test('pattern with no hits still prints heading and Total: 0 rows', () => {
  const root = mkTree({ 'src/a.js': 'readyToMerge\n' });
  const r = buildReport(root);
  assert.equal(section(r, 'hub_for_branch').trim(), '## hub_for_branch\n\nTotal: 0 rows');
});

test('CRLF line endings are stripped from row text', () => {
  const root = mkTree({ 'src/c.js': 'a\r\n  readyToMerge x  \r\nhub_for_branch\r\n' });
  const r = buildReport(root);
  assert.ok(r.includes('- src/c.js:2 -- readyToMerge x\n'));
  assert.ok(r.includes('- src/c.js:3 -- hub_for_branch\n'));
  assert.ok(!r.includes('\r'));
});

test('--out creates the directory and equals the stdout form', () => {
  const root = mkTree({ 'src/a.js': 'readyToMerge\n' });
  const out = path.join(root, 'new', 'deep', 'report.md');
  const a = run(['--root', root, '--out', out]);
  assert.equal(a.status, 0);
  assert.equal(a.stdout, '');
  const b = run(['--root', root]);
  assert.equal(b.status, 0);
  assert.equal(fs.readFileSync(out, 'utf8'), b.stdout);
  assert.ok(b.stdout.startsWith(H));
});

test('missing --root directory exits 2 with usage', () => {
  const r = run(['--root', path.join(os.tmpdir(), 'hba-does-not-exist-xyz')]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/i);
  assert.equal(r.stdout, '');
});

test('--root pointing at a file exits 2', () => {
  const root = mkTree({ 'f.txt': 'x' });
  const r = run(['--root', path.join(root, 'f.txt')]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/i);
});

test('unknown argument exits 2 and prints no report', () => {
  const root = mkTree({ 'src/a.js': 'readyToMerge\n' });
  const r = run(['--root', root, '--bogus']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/i);
  assert.ok(!r.stdout.includes('# Hub branch assumptions'));
});

test('flags missing their value exit 2 and write nothing', () => {
  const root = mkTree({ 'src/a.js': 'readyToMerge\n' });
  const r1 = run(['--root', root, '--out']);
  assert.equal(r1.status, 2);
  assert.equal(r1.stdout, '');
  const r2 = run(['--root']);
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /usage/i);
});
