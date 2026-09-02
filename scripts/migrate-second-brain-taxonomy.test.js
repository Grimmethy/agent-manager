'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'migrate-second-brain-taxonomy.js');

function makeVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-migrate-'));
  const w = (rel, body = '# x\n') => { fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), body); };
  w('agent_manager/draft-fix.md');
  w('Projects/agent-manager/tasks/completed/old-task.md');
  w('journal/a-date.md');
  w('agent-manager/journal/self-note.md');
  w('Reference/x.md');
  w('references/y.md');
  w('Hardware/gpu.md');
  w('ideas/thing.md');
  w('References/y.md'); // collision target for references/y.md
  w('Characters/Bard.md'); // already canonical
  w('Agent Manager Reports/hourly/2026-09-02T11h.md'); // machine dir -- untouched
  w('root-note.md');
  return dir;
}

function run(dir, apply) {
  return execFileSync('node', [SCRIPT, ...(apply ? ['--apply'] : [])], {
    encoding: 'utf8',
    env: { ...process.env, SECOND_BRAIN_DIR: dir, AGENT_MANAGER_REPO_ROOT: '/media/model-cache/github/agent-manager' },
  });
}

test('dry-run writes nothing', () => {
  const dir = makeVault();
  const before = execFileSync('find', [dir, '-type', 'f'], { encoding: 'utf8' });
  run(dir, false);
  assert.equal(execFileSync('find', [dir, '-type', 'f'], { encoding: 'utf8' }), before);
});

test('--apply consolidates onto the canonical taxonomy, conserves file count, handles collisions, is idempotent', () => {
  const dir = makeVault();
  const count = (d) => execFileSync('find', [d, '-name', '*.md'], { encoding: 'utf8' }).trim().split('\n').length;
  const before = count(dir);

  run(dir, true);

  assert.equal(count(dir), before, 'file count conserved (moves only)');
  const tops = fs.readdirSync(dir).filter((n) => !n.startsWith('.') && fs.statSync(path.join(dir, n)).isDirectory());
  for (const bad of ['agent_manager', 'journal', 'Reference', 'references', 'Hardware', 'ideas']) {
    assert.equal(tops.includes(bad), false, `${bad}/ should be gone`);
  }
  assert.ok(fs.existsSync(path.join(dir, 'agent-manager', 'draft-fix.md')));
  assert.ok(fs.existsSync(path.join(dir, 'agent-manager', 'archive', 'old-task.md')));
  assert.ok(fs.existsSync(path.join(dir, 'Journal', 'a-date.md')));
  assert.ok(fs.existsSync(path.join(dir, 'Journal', 'agent-manager', 'self-note.md')));
  assert.ok(fs.existsSync(path.join(dir, 'References', 'x.md')));
  assert.ok(fs.existsSync(path.join(dir, 'References', 'hardware', 'gpu.md')));
  assert.ok(fs.existsSync(path.join(dir, 'Ideas', 'thing.md')));
  // collision: references/y.md kept a distinct name, References/y.md untouched
  assert.ok(fs.existsSync(path.join(dir, 'References', 'y.md')));
  assert.ok(fs.existsSync(path.join(dir, 'References', 'y-references.md')));
  // machine dir untouched
  assert.ok(fs.existsSync(path.join(dir, 'Agent Manager Reports', 'hourly', '2026-09-02T11h.md')));
  // bare root note -> Characters
  assert.ok(fs.existsSync(path.join(dir, 'Characters', 'root-note.md')));

  const out2 = run(dir, true);
  assert.match(out2, /already migrated/);
});
