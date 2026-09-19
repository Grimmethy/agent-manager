'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  SIDE_EFFECT_PATH_RE, taskWantsDependencyChange, stageDraftChanges, changedFilesOfDiff, unnamedChangedFiles,
} = require('./draft-side-effects.js');

const runGit = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' });

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'side-effects-'));
  runGit(['init', '-q', '-b', 'main'], dir);
  runGit(['config', 'user.email', 't@t'], dir); runGit(['config', 'user.name', 't'], dir);
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'App.tsx'), 'const a = 1;\n');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3,"libc":"glibc"}\n');
  runGit(['add', '-A'], dir); runGit(['commit', '-q', '-m', 'init'], dir);
  return dir;
}

test('SIDE_EFFECT_PATH_RE matches lockfiles, node_modules and bytecode, not source', () => {
  for (const p of ['package-lock.json', 'web/yarn.lock', 'pnpm-lock.yaml', 'a/b/Cargo.lock', 'node_modules/x/index.js', 'pkg/__pycache__/m.cpython-312.pyc', 'x.pyc']) {
    assert.equal(SIDE_EFFECT_PATH_RE.test(p), true, p);
  }
  for (const p of ['src/App.tsx', 'package.json', 'docs/lock-notes.md', 'src/lockfile.js', 'README.md']) {
    assert.equal(SIDE_EFFECT_PATH_RE.test(p), false, p);
  }
});

test('stageDraftChanges keeps the real change and unstages a rewritten lockfile (the PF incident)', () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'src', 'App.tsx'), 'const a = 2;\n');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3}\n'); // what a sandbox `npm install` did
  fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'i.js'), '1');
  const { excluded } = stageDraftChanges({ worktreeDir: dir, runGit, task: { title: 'Fix a timer leak', promptContext: { rawText: 'clear the timeout' } } });
  assert.deepEqual(excluded.sort(), ['node_modules/x/i.js', 'package-lock.json']);
  const staged = runGit(['diff', '--cached', '--name-only'], dir).trim().split('\n');
  assert.deepEqual(staged, ['src/App.tsx']);
});

test('stageDraftChanges keeps the lockfile when the task is genuinely about dependencies', () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3}\n');
  const { excluded } = stageDraftChanges({ worktreeDir: dir, runGit, task: { title: 'Upgrade vite to 6.4', promptContext: { rawText: 'bump the dependency' } } });
  assert.deepEqual(excluded, []);
  assert.deepEqual(runGit(['diff', '--cached', '--name-only'], dir).trim().split('\n'), ['package-lock.json']);
});

test('taskWantsDependencyChange looks at the task text, not the model-written plan', () => {
  assert.equal(taskWantsDependencyChange({ title: 'Fix timer', promptContext: { rawText: 'clear it' } }), false);
  assert.equal(taskWantsDependencyChange({ title: 'x', promptContext: { rawText: 'run npm install and commit the lockfile' } }), true);
  assert.equal(taskWantsDependencyChange({ title: 'x', promptContext: { rawText: 'y' }, planResponse: 'npm install to get tsc' }), false);
});

test('changedFilesOfDiff / unnamedChangedFiles: a file nothing mentions is reported; named ones (path or basename) are not', () => {
  const rawDiff = [
    'diff --git a/src/App.tsx b/src/App.tsx', '--- a/src/App.tsx', '+++ b/src/App.tsx', '@@ -1 +1 @@', '-a', '+b',
    'diff --git a/package-lock.json b/package-lock.json', '--- a/package-lock.json', '+++ b/package-lock.json', '@@ -1 +1 @@', '-x', '+y',
    'diff --git a/src/util/helper.ts b/src/util/helper.ts', '--- a/src/util/helper.ts', '+++ b/src/util/helper.ts', '@@ -1 +1 @@', '-x', '+y',
  ].join('\n');
  assert.deepEqual(changedFilesOfDiff(rawDiff), ['src/App.tsx', 'package-lock.json', 'src/util/helper.ts']);
  const task = { title: 'startTour leaks a timer', promptContext: { rawText: 'In src/App.tsx the timeout id is discarded.' }, planResponse: 'Edit App.tsx, and helper.ts for the shared type.', implementResponse: 'Changed App.tsx.', rawDiff };
  assert.deepEqual(unnamedChangedFiles(task), ['package-lock.json']);
  assert.deepEqual(unnamedChangedFiles({ ...task, rawDiff: '' }), []);
});
