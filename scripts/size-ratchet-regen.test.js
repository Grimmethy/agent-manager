'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scanOffenders, lowerOnly } = require('./size-ratchet-regen.js');

const SCRIPT = path.join(__dirname, 'size-ratchet-regen.js');
const LIMITS = { maxFileLines: 500, maxFunctionLines: 100 };
const lines = (n) => 'const x = 1;\n'.repeat(n);

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'size-regen-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}
function run(root, allowlist, args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, AGENT_MANAGER_SIZE_RATCHET_ROOT: root, AGENT_MANAGER_SIZE_RATCHET_ALLOWLIST: allowlist, AGENT_MANAGER_MAX_FILE_LINES: '500', AGENT_MANAGER_MAX_FUNCTION_LINES: '100' },
    encoding: 'utf8',
  });
  return { status: r.status, stderr: r.stderr, data: fs.existsSync(allowlist) ? JSON.parse(fs.readFileSync(allowlist, 'utf8')) : null };
}

test('scanOffenders lists only files and functions OVER the limits, never compliant ones', () => {
  const root = tree({ 'a.js': lines(501), 'b.js': lines(10), 'c.py': 'def big():\n' + '    x = 1\n'.repeat(150) });
  const found = scanOffenders(root, LIMITS);
  assert.deepEqual(found.files, { 'a.js': 501 });
  assert.deepEqual(Object.keys(found.functions), ['c.py::big']);
});

test('--init writes the current offenders with their line counts as caps', () => {
  const root = tree({ 'a.js': lines(501), 'b.js': lines(10) });
  const out = path.join(root, 'allow.json');
  const r = run(root, out, ['--init']);
  assert.equal(r.status, 0);
  assert.deepEqual(r.data, { files: { 'a.js': 501 }, functions: {} });
});

test('regen without --init lowers a cap and drops an entry that is back under the limit', () => {
  const root = tree({ 'a.js': lines(520), 'b.js': lines(300) });
  const out = path.join(root, 'allow.json');
  fs.writeFileSync(out, JSON.stringify({ files: { 'a.js': 560, 'b.js': 505 }, functions: {} }));
  const r = run(root, out, []);
  assert.equal(r.status, 0);
  assert.deepEqual(r.data, { files: { 'a.js': 520 }, functions: {} });
});

test('regen never raises a cap and refuses an offender that is not listed', () => {
  const root = tree({ 'a.js': lines(530), 'new.js': lines(501) });
  const out = path.join(root, 'allow.json');
  fs.writeFileSync(out, JSON.stringify({ files: { 'a.js': 510 }, functions: {} }));
  const r = run(root, out, []);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /new\.js/);
  assert.equal(r.data.files['a.js'], 510);
});

test('lowerOnly is pure: cap = min(old cap, current lines)', () => {
  const { next, unlisted } = lowerOnly({ files: { 'a.js': 600 }, functions: {} }, { files: { 'a.js': 550 }, functions: { 'a.js::f': 120 } });
  assert.deepEqual(next, { files: { 'a.js': 550 }, functions: {} });
  assert.deepEqual(unlisted, ['function a.js::f (120 lines)']);
});
