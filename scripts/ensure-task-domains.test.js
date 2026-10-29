'use strict';

// Tests for scripts/ensure-task-domains.sh and config/task-domains.template.json (2026-10-26).
// Everything runs in temp directories; no live pipeline is touched.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ensure-task-domains.sh');
const TEMPLATE = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'task-domains.template.json'), 'utf8'));
const REQUIRED = ['deep_dive', 'project_search', 'brain_dump_sort', 'path_prefetch_resolve', 'secondbrain',
  'default', 'adhoc', 'research', 'wiki_content', 'character_content'];

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-domains-')); }
function run(dir) { return spawnSync('bash', [SCRIPT, dir], { encoding: 'utf8' }); }
function read(dir) { return JSON.parse(fs.readFileSync(path.join(dir, 'task-domains.json'), 'utf8')); }
function backups(dir) { return fs.readdirSync(dir).filter((f) => f.startsWith('task-domains.json.bak-')); }

test('the template lists every standard domain, research on the second-brain dir', () => {
  assert.deepStrictEqual(Object.keys(TEMPLATE).sort(), REQUIRED.slice().sort());
  assert.strictEqual(TEMPLATE.research.workDirKind, 'secondBrainDir');
  assert.strictEqual(TEMPLATE.adhoc.successCheck, 'git-branch-diff');
});

test('a missing file is written from the template, with no backup', () => {
  const d = tmpDir();
  const r = run(d);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(read(d), TEMPLATE);
  assert.deepStrictEqual(backups(d), []);
});

test('a default-only file gains the other domains and keeps its own default; the original is backed up', () => {
  const d = tmpDir();
  const original = { default: { workDirKind: 'customDir', successCheck: 'git-branch-diff' } };
  fs.writeFileSync(path.join(d, 'task-domains.json'), JSON.stringify(original));
  const r = run(d);
  assert.strictEqual(r.status, 0, r.stderr);
  const after = read(d);
  assert.deepStrictEqual(Object.keys(after).sort(), REQUIRED.slice().sort());
  assert.deepStrictEqual(after.default, original.default);
  assert.deepStrictEqual(after.adhoc, TEMPLATE.adhoc);
  const b = backups(d);
  assert.strictEqual(b.length, 1);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(d, b[0]), 'utf8')), original);
  assert.match(r.stdout, /added .*adhoc/);
});

test('an existing domain and a custom domain are never changed or removed', () => {
  const d = tmpDir();
  const original = {
    default: { workDirKind: 'repoRoot', successCheck: 'git-branch-diff' },
    adhoc: { workDirKind: 'secondBrainDir', successCheck: 'something-else' },
    mine: { workDirKind: 'repoRoot', successCheck: 'custom-check' },
  };
  fs.writeFileSync(path.join(d, 'task-domains.json'), JSON.stringify(original));
  assert.strictEqual(run(d).status, 0);
  const after = read(d);
  assert.deepStrictEqual(after.adhoc, original.adhoc);
  assert.deepStrictEqual(after.mine, original.mine);
  assert.ok('research' in after && 'deep_dive' in after);
});

test('a second run changes nothing and makes no second backup', () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, 'task-domains.json'), JSON.stringify({ default: { workDirKind: 'repoRoot', successCheck: 'git-branch-diff' } }));
  assert.strictEqual(run(d).status, 0);
  const text = fs.readFileSync(path.join(d, 'task-domains.json'), 'utf8');
  const r = run(d);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(fs.readFileSync(path.join(d, 'task-domains.json'), 'utf8'), text);
  assert.strictEqual(backups(d).length, 1);
  assert.match(r.stdout, /already lists all/);
});

test('a file that is not valid JSON is left untouched and the script fails', () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, 'task-domains.json'), '{ not json');
  const r = run(d);
  assert.notStrictEqual(r.status, 0);
  assert.strictEqual(fs.readFileSync(path.join(d, 'task-domains.json'), 'utf8'), '{ not json');
  assert.deepStrictEqual(backups(d), []);
});

test('provision, adopt and register scripts all call ensure-task-domains.sh', () => {
  for (const name of ['provision-plugin-repo.sh', 'adopt-existing-project.sh', 'register-project.sh']) {
    const text = fs.readFileSync(path.join(ROOT, 'scripts', name), 'utf8');
    assert.ok(text.includes('ensure-task-domains.sh'), `${name} does not call ensure-task-domains.sh`);
  }
});
