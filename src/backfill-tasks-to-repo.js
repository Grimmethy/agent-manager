'use strict';

// One-time backfill: commits every task ALREADY sitting in queue/ into the dedicated
// task-data repo's tasks/<id>.json (task-repo-sync.js's own stable-path convention), so
// collaborators see the full existing history, not just activity from the moment task-
// repo-sync.js shipped forward. 2026-08-24, Grimmethy: "Is the current full task list
// available on the github now?" -> "no, only new activity going forward" -> "build it" ->
// (after the first version landed the whole 250MB backfill directly in agent-manager's OWN
// repo) "That's going to bloat with multiple people working on the project. Can we build a
// sub-repo that stores task data?" -- moved to a genuinely separate repo, see task-repo-
// sync.js's own header for why a real separate repo, not a git submodule.
//
// Deliberately NOT task-repo-sync.js's own syncTaskToRepo() called once per task -- that
// function does a full clone+commit+push cycle PER CALL, which would mean thousands of
// separate network round-trips for a one-time sweep over potentially thousands of files.
// This script instead reuses ONE clone and makes ONE commit for the whole backfill -- a
// real "backfill: import existing task history" event, not thousands of synthetic ones
// (git commit dates for a backfill are never the task's own real historical timestamps
// anyway, so pretending otherwise would be misleading, not more accurate).
//
// Scans every real queue/ location this pipeline's own daemons write to, not just
// task-sources.js's QUEUE_STATES constant (which excludes 'adhoc'/'research' -- holding
// areas for not-yet-picked-up work, still real tasks) and not just the flat per-state
// dirs (drafting/ has per-worker subfolders; done/ has _archived_no_action/ and dated
// _archived/<YYYY-MM>/ buckets from done-archive.js).
//
// CLI: node backfill-tasks-to-repo.js [--dry-run]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { getConfig } = require('./config.js');
const { relativeTaskPath } = require('./task-repo-sync.js');

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
// A one-time sweep over thousands of files (git add/commit) and a push of however much
// that adds up to needs real headroom -- task-repo-sync.js's own regular per-task
// GIT_TIMEOUT_MS (60s, sized for one small file) would be nowhere near enough here.
const GIT_TIMEOUT_MS = 600_000;

function runGit(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
}

// Every real on-disk location a task JSON can sit in -- see this file's own header on why
// this is broader than task-sources.js's QUEUE_STATES.
function findAllTaskFiles(queueDir) {
  const files = [];
  const flatStates = [
    'pending', 'review', 'approved', 'blocked', 'needs-clarification', 'awaiting-confirm',
    'adhoc', 'research',
  ];
  for (const state of flatStates) {
    const dir = path.join(queueDir, state);
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.endsWith('.json')) files.push(path.join(dir, name));
      }
    } catch (e) { /* state dir doesn't exist -- nothing to scan */ }
  }

  // drafting/ -- per-worker subfolders, plus a legacy flat fallback (see api_queue_state's
  // own identical dual handling).
  const draftingDir = path.join(queueDir, 'drafting');
  try {
    for (const entry of fs.readdirSync(draftingDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.json')) {
        files.push(path.join(draftingDir, entry.name));
      } else if (entry.isDirectory()) {
        const sub = path.join(draftingDir, entry.name);
        for (const name of fs.readdirSync(sub)) {
          if (name.endsWith('.json')) files.push(path.join(sub, name));
        }
      }
    }
  } catch (e) { /* no drafting/ yet */ }

  // done/ -- top level, plus _archived_no_action/ (human archives) and dated
  // _archived/<YYYY-MM>/ buckets (done-archive.js) -- every one of these is still a real,
  // completed task, just relocated for done/'s own hot-path performance reasons.
  const doneDir = path.join(queueDir, 'done');
  try {
    for (const entry of fs.readdirSync(doneDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.json')) {
        files.push(path.join(doneDir, entry.name));
      }
    }
  } catch (e) { /* no done/ yet */ }
  try {
    for (const name of fs.readdirSync(path.join(doneDir, '_archived_no_action'))) {
      if (name.endsWith('.json')) files.push(path.join(doneDir, '_archived_no_action', name));
    }
  } catch (e) { /* none yet */ }
  try {
    const archiveRoot = path.join(doneDir, '_archived');
    for (const monthDir of fs.readdirSync(archiveRoot)) {
      const full = path.join(archiveRoot, monthDir);
      if (!fs.statSync(full).isDirectory()) continue;
      for (const name of fs.readdirSync(full)) {
        if (name.endsWith('.json')) files.push(path.join(full, name));
      }
    }
  } catch (e) { /* none yet */ }

  return files;
}

function backfillTasksToRepo({ pipelineDir, taskRepoUrl, mainBranch = 'main', dryRun = false }) {
  const queueDir = path.join(pipelineDir, 'queue');
  const allFiles = findAllTaskFiles(queueDir);
  const summary = { scanned: allFiles.length, written: 0, skipped: 0, errors: [] };

  if (allFiles.length === 0) {
    return { ...summary, committed: false };
  }

  if (dryRun) {
    return { ...summary, written: allFiles.length, committed: false, dryRun: true };
  }

  const cloneDir = path.join(os.tmpdir(), `agent-manager-backfill-${Date.now()}`);

  try {
    runGit(['clone', '--depth', '1', '--branch', mainBranch, taskRepoUrl, cloneDir]);
  } catch (e) {
    return { ...summary, committed: false, errors: [`could not clone task-data repo: ${e.message}`] };
  }

  try {
    for (const filePath of allFiles) {
      let task;
      try {
        task = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (e) {
        summary.skipped++;
        summary.errors.push(`unreadable/malformed: ${filePath}`);
        continue;
      }
      if (!task || !task.id) {
        summary.skipped++;
        summary.errors.push(`no task.id: ${filePath}`);
        continue;
      }
      const relPath = relativeTaskPath(task);
      const fullPath = path.join(cloneDir, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, JSON.stringify(task, null, 2));
      summary.written++;
    }

    runGit(['add', 'tasks'], cloneDir);
    const status = runGit(['status', '--porcelain'], cloneDir);
    if (!status.trim()) {
      return { ...summary, committed: false };
    }

    const msgPath = path.join(os.tmpdir(), 'backfill-commit-msg.txt');
    fs.writeFileSync(msgPath, [
      `task-repo-sync: backfill ${summary.written} existing task record(s)`,
      '',
      'One-time import of task history that existed before task-repo-sync.js shipped --',
      'see that module for how new activity is committed going forward. Commit dates here',
      "reflect the backfill itself, not each task's own real historical timestamps (those",
      'live inside each record\'s own history[] array).',
    ].join('\n'));
    try {
      runGit(['commit', '-F', msgPath], cloneDir);
    } finally {
      fs.unlinkSync(msgPath);
    }
    runGit(['push', 'origin', `HEAD:${mainBranch}`], cloneDir);
    return { ...summary, committed: true };
  } catch (e) {
    return { ...summary, committed: false, errors: [...summary.errors, `commit/push failed: ${e.message}`] };
  } finally {
    try { fs.rmSync(cloneDir, { recursive: true, force: true }); } catch (e) { /* best-effort */ }
  }
}

module.exports = { backfillTasksToRepo, findAllTaskFiles };

if (require.main === module) {
  const { pipelineDir, taskRepoUrl } = getConfig();
  const dryRun = process.argv.includes('--dry-run');
  if (!taskRepoUrl && !dryRun) {
    console.error('backfill-tasks-to-repo: AGENT_MANAGER_TASK_REPO_URL is not set -- nothing to backfill into.');
    process.exit(1);
  }
  const result = backfillTasksToRepo({ pipelineDir, taskRepoUrl, dryRun });
  console.log(JSON.stringify(result, null, 2));
}
