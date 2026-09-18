'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  sweep, isDue, extractMergedSha, isAncestorOfMain, listMergedDoneTasks,
} = require('./merged-work-sweep.js');
const { inboxDir } = require('./side-finding.js');

function git(args, cwd) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'merged-work-sweep-repo-'));
  git(['init', '-q'], root);
  git(['config', 'user.email', 'test@example.com'], root);
  git(['config', 'user.name', 'Test'], root);
  return root;
}

function commitFile(root, relPath, content) {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  git(['add', relPath], root);
  git(['commit', '-q', '-m', `commit ${relPath}`], root);
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

function currentBranch(root) {
  return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

function tmpPipeline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merged-work-sweep-pipeline-'));
  fs.mkdirSync(path.join(dir, 'queue', 'done'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'instances'), { recursive: true });
  return dir;
}

function doneTask(pipelineDir, id, { sha, historyDetail, rawDiff }) {
  const task = {
    id,
    terminalDisposition: 'merged',
    rawDiff,
    history: [
      { stage: 'applied', at: '2026-09-01T00:00:00Z', detail: 'applied' },
      { stage: 'merged', at: '2026-09-01T01:00:00Z', detail: historyDetail !== undefined ? historyDetail : `on origin/master @ ${sha} (commit-trailer)` },
    ],
  };
  fs.writeFileSync(path.join(pipelineDir, 'queue', 'done', `${id}.json`), JSON.stringify(task, null, 2));
  return task;
}

test('extractMergedSha: pulls the SHA out of the merged history event detail', () => {
  const task = { history: [{ stage: 'merged', at: 'x', detail: 'on origin/master @ 10fb39a8c0f4 (commit-trailer)' }] };
  assert.equal(extractMergedSha(task), '10fb39a8c0f4');
});

test('extractMergedSha: null when no merged event or no parseable SHA', () => {
  assert.equal(extractMergedSha({ history: [{ stage: 'applied', detail: 'x' }] }), null);
  assert.equal(extractMergedSha({ history: [{ stage: 'merged', detail: 'no sha here' }] }), null);
  assert.equal(extractMergedSha({}), null);
});

test('isAncestorOfMain: true for a real ancestor, false for an orphan commit', () => {
  const root = makeRepo();
  const sha1 = commitFile(root, 'a.js', 'const a = 1;\n');
  assert.equal(isAncestorOfMain(root, sha1), true);

  // An orphan branch's commit is never an ancestor of master.
  git(['checkout', '--orphan', 'orphan-branch'], root);
  git(['rm', '-rf', '--cached', '.'], root);
  const orphanSha = commitFile(root, 'b.js', 'const b = 2;\n');
  assert.equal(isAncestorOfMain(root, orphanSha), false);
});

test('sweep: ancestor SHA is skipped with no content check and no finding', () => {
  const root = makeRepo();
  const sha = commitFile(root, 'a.js', 'const a = 1;\n');
  const pipelineDir = tmpPipeline();
  doneTask(pipelineDir, 'task-ancestor', { sha });

  const summary = sweep({ pipelineDir, repoRoot: root });
  assert.equal(summary.ancestorSkipped, 1);
  assert.equal(summary.contentChecked, 0);
  assert.equal(summary.flagged, 0);
});

test('sweep: no parseable SHA is skipped with no content check and no finding', () => {
  const root = makeRepo();
  commitFile(root, 'a.js', 'const a = 1;\n');
  const pipelineDir = tmpPipeline();
  doneTask(pipelineDir, 'task-no-sha', { historyDetail: 'merged, no sha recorded' });

  const summary = sweep({ pipelineDir, repoRoot: root });
  assert.equal(summary.noShaSkipped, 1);
  assert.equal(summary.contentChecked, 0);
  assert.equal(summary.flagged, 0);
});

test('sweep: non-ancestor SHA whose content genuinely is missing files a side-finding inbox entry', () => {
  const root = makeRepo();
  commitFile(root, 'unrelated.js', 'const u = 1;\n'); // master has SOME history but never gets this task's content
  const branchName = currentBranch(root);
  git(['checkout', '--orphan', 'lost-work-branch'], root);
  git(['rm', '-rf', '--cached', '.'], root);
  git(['clean', '-fdx'], root); // drop the now-untracked leftover files so switching back doesn't conflict
  const orphanSha = commitFile(root, 'never-landed.js', 'const neverLanded = "distinctive-content-marker-xyz";\n');
  git(['checkout', branchName], root);

  const pipelineDir = tmpPipeline();
  const rawDiff = [
    'diff --git a/never-landed.js b/never-landed.js',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/never-landed.js',
    '+const neverLanded = "distinctive-content-marker-xyz";',
  ].join('\n');
  doneTask(pipelineDir, 'task-lost', { sha: orphanSha, rawDiff });

  const summary = sweep({ pipelineDir, repoRoot: root });
  assert.equal(summary.contentChecked, 1);
  assert.equal(summary.flagged, 1);

  const inboxFiles = fs.readdirSync(inboxDir(pipelineDir));
  assert.equal(inboxFiles.length, 1);
  const finding = JSON.parse(fs.readFileSync(path.join(inboxDir(pipelineDir), inboxFiles[0]), 'utf8'));
  assert.match(finding.title, /task-lost/);
  assert.equal(finding.source, 'merged_work_sweep');
  assert.equal(finding.taskId, 'task-lost');
});

test('sweep: non-ancestor SHA whose content IS present elsewhere (refactor-moved) is silently checked, no finding', () => {
  const root = makeRepo();
  commitFile(root, 'moved-elsewhere.js', 'const stillHereAfterRefactor = "distinctive-content-marker-abc";\n');
  const branchName = currentBranch(root);
  git(['checkout', '--orphan', 'orphan-2'], root);
  git(['rm', '-rf', '--cached', '.'], root);
  git(['clean', '-fdx'], root);
  const orphanSha = commitFile(root, 'original-path.js', 'placeholder\n');
  git(['checkout', branchName], root);

  const pipelineDir = tmpPipeline();
  const rawDiff = [
    'diff --git a/original-path.js b/original-path.js',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/original-path.js',
    '+const stillHereAfterRefactor = "distinctive-content-marker-abc";',
  ].join('\n');
  doneTask(pipelineDir, 'task-moved', { sha: orphanSha, rawDiff });

  const summary = sweep({ pipelineDir, repoRoot: root });
  assert.equal(summary.contentChecked, 1);
  assert.equal(summary.present, 1);
  assert.equal(summary.flagged, 0);
  // No finding filed -- writeSideFindingInbox never creates the inbox dir in that case.
  assert.equal(fs.existsSync(inboxDir(pipelineDir)), false);
});

test('sweep: a task already in checkedIds state is never re-scanned', () => {
  const root = makeRepo();
  const sha = commitFile(root, 'a.js', 'const a = 1;\n');
  const pipelineDir = tmpPipeline();
  doneTask(pipelineDir, 'task-repeat', { sha });

  const first = sweep({ pipelineDir, repoRoot: root });
  assert.equal(first.scanned, 1);
  const second = sweep({ pipelineDir, repoRoot: root });
  assert.equal(second.scanned, 0);
});

test('listMergedDoneTasks: only tasks with terminalDisposition merged are included', () => {
  const pipelineDir = tmpPipeline();
  fs.writeFileSync(path.join(pipelineDir, 'queue', 'done', 'not-merged.json'), JSON.stringify({ id: 'not-merged', terminalDisposition: 'abandoned' }));
  doneTask(pipelineDir, 'is-merged', { sha: 'deadbeef' });
  const found = listMergedDoneTasks(pipelineDir);
  assert.deepEqual(found.map((t) => t.id), ['is-merged']);
});

test('isDue: true when never run, false right after, true again past the interval', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merged-work-sweep-sched-'));
  assert.equal(isDue(dir), true);
  const root = makeRepo();
  const pipelineDir = tmpPipeline();
  sweep({ pipelineDir, repoRoot: root, instancesDir: dir, now: new Date() });
  assert.equal(isDue(dir, new Date()), false);
  assert.equal(isDue(dir, new Date(Date.now() + 6 * 60 * 1000)), true);
});
