// Tests for resolve_task_id / report_id_mismatch in scripts/apply-task.sh.
// The functions are extracted from the script itself and run under bash, so the
// test exercises the real code rather than a copy of it.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const APPLY_SH = path.join(__dirname, 'apply-task.sh');
const src = fs.readFileSync(APPLY_SH, 'utf8');
const START = src.indexOf('resolve_task_id() {');
const END = src.indexOf('# Mutex: refuse to run');
assert.ok(START >= 0 && END > START, 'resolve_task_id and report_id_mismatch must sit above the Mutex block');
const FN_DEFS = src.slice(START, END);

const tmpDirs = [];
process.on('exit', () => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function fixture(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-task-id-'));
  tmpDirs.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

function resolveFor(file) {
  const script = `${FN_DEFS}\nid="$(resolve_task_id "$1")"; printf '%s' "$id"; report_id_mismatch "$1" "$id"`;
  const r = spawnSync('bash', ['-c', script, 'bash', file], { encoding: 'utf8' });
  return { id: r.stdout, stderr: r.stderr, status: r.status };
}

test('a record in a misnamed file is filed under its own id', () => {
  const f = fixture('zz.task.json', { id: 'abc-123' });
  const r = resolveFor(f);
  assert.equal(r.status, 0);
  assert.equal(r.id, 'abc-123');
  assert.match(r.stderr, /record file name 'zz\.task' differs from task id 'abc-123': filed as abc-123\.json/);
});

test('a record whose file name already equals its id is unchanged and prints no notice', () => {
  const f = fixture('abc-123.json', { id: 'abc-123' });
  const r = resolveFor(f);
  assert.equal(r.id, 'abc-123');
  assert.equal(r.stderr, '');
});

test('a record with no id field keeps its basename', () => {
  const f = fixture('legacy-7.json', { title: 'no id here' });
  const r = resolveFor(f);
  assert.equal(r.id, 'legacy-7');
  assert.equal(r.stderr, '');
});

test('a non-string id falls back to the basename', () => {
  const f = fixture('n-1.json', { id: 42 });
  assert.equal(resolveFor(f).id, 'n-1');
});

test('an unparseable record falls back to the basename', () => {
  const f = fixture('bad.json', '{not json');
  assert.equal(resolveFor(f).id, 'bad');
});

test('an unsafe id falls back to the basename with a warning', () => {
  const f = fixture('ok-1.json', { id: '../x' });
  const r = resolveFor(f);
  assert.equal(r.id, 'ok-1');
  assert.match(r.stderr, /unsafe task id '\.\.\/x'/);
});

test('the apply loops file records by resolved id, not by basename', () => {
  assert.doesNotMatch(src, /task_id="\$\(basename "\$file" \.json\)"/);
  assert.doesNotMatch(src, /btid="\$\(basename "\$bpath" \.json\)"/);
  assert.match(src, /task_id="\$\(resolve_task_id "\$file"\)"/);
  assert.match(src, /btid="\$\(resolve_task_id "\$bpath"\)"/);
});
