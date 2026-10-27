'use strict';

// Sweep held-for-project tasks: routes tasks that were held while their target project
// was unregistered back into that project's queue once it becomes registered, and archives
// any that remain stuck (project never registered, orphaned directory, etc).
//
// This is the counterpart to queue-adhoc-task.js's held-task routing (HUB0213-0): when a
// human or agent queues a task for a project that isn't in projects.json yet, the task
// lands in <pipelineDir>/queue/held-for-project/<slugified-name>/<id>.json with
// `heldForProject: true` stamped on it. This module periodically checks whether the
// project has since been registered and, if so, moves the held tasks to the project's
// own queue/adhoc/ so they can be claimed normally.
//
// Side-effect requires: listProjects() reads projects.json; isProjectRegistered() uses
// it too. The registry is read fresh each call (no process-wide cache in this module) so
// a human editing projects.json between calls is picked up without a restart.

const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config.js');
const { listProjects } = require('./chat-projects.js');
const { isProjectRegistered } = require('./queue-adhoc-task.js');
const { logPipelineEvent } = require('./pipeline-history.js');
const { appendHistoryEvent } = require('./task-history.js');

const HELD_DIRNAME = 'held-for-project';
const ARCHIVE_DIRNAME = '_archived';
const MONTH_BUCKET_DAYS = 30; // archive buckets by month, same scheme as done-archive.js

function monthBucket(now) {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function slugify(str) {
  return String(str || '').toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '').replace(/[^a-z0-9]+/g, '-');
}

// Reads every <name> subdirectory under <pipelineDir>/queue/held-for-project/ and returns
// an array of { name, dir } objects sorted by name. Never throws -- returns [] if the
// held-for-project root does not exist or is unreadable.
function listHeldProjectDirs(pipelineDir) {
  const heldRoot = path.join(pipelineDir, 'queue', HELD_DIRNAME);
  let entries;
  try {
    entries = fs.readdirSync(heldRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, dir: path.join(heldRoot, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Reads every .json file in a held-project directory, returning { full, name, task } for
// each parseable file. Skips corrupt/partial writes (same pattern as done-archive.js's
// readTaskSafe) and never throws.
function listHeldTasks(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    const full = path.join(dir, e.name);
    let task = null;
    try {
      task = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      // corrupt/partial write -- still listed, will be archived with reason
    }
    out.push({ full, name: e.name, task });
  }
  return out;
}

// Moves a single held task file to the target directory, overwriting any existing file
// with the same name (a held task should never collide with a live one -- the id was
// minted fresh by queueAdhocTask). Returns true on success, false on failure.
function moveTask(src, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, path.basename(src));
  try {
    fs.renameSync(src, dest);
    return true;
  } catch {
    return false;
  }
}

// Archives a task file by moving it to <pipelineDir>/queue/held-for-project/<name>/
// <ARCHIVE_DIRNAME>/<month-bucket>/<original-filename>.json, where <month-bucket> is the
// YYYY-MM of when the archive happened (same scheme as done-archive.js's
// _archived/<YYYY-MM>/). Never throws -- returns { archived: boolean, reason: string }.
function archiveTask({ full, name, pipelineDir, projectName, reason }) {
  const archiveDir = path.join(pipelineDir, 'queue', HELD_DIRNAME, projectName, ARCHIVE_DIRNAME, monthBucket());
  try {
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.renameSync(full, path.join(archiveDir, name));
    return { archived: true, reason };
  } catch (e) {
    return { archived: false, reason: `${reason} (archive failed: ${e.message})` };
  }
}

// Routes one held-project directory's tasks: registered projects get their tasks moved
// to the project's own queue/adhoc/; unregistered projects get their tasks archived with
// a recorded reason. Returns a summary object.
function routeProjectDir({ name, dir, pipelineDir }) {
  const heldTasks = listHeldTasks(dir);
  if (heldTasks.length === 0) {
    return { routed: 0, archived: 0, errors: [], projectName: name };
  }

  // Resolve the project: we know the slugified name came from a project label, so find
  // the matching project by slugified label. This is more robust than isProjectRegistered
  // for lookup purposes since we need the project's pipelineDir.
  const projects = listProjects();
  const project = projects.find((p) => slugify(p.label) === name);

  const summary = { routed: 0, archived: 0, errors: [], projectName: name };

  if (!project) {
    // No matching project at all -- archive everything with a clear reason.
    for (const { full, name: fname, task } of heldTasks) {
      const result = archiveTask({ full, name: fname, pipelineDir, projectName: name, reason: 'no matching project in registry' });
      if (task) {
        try { appendHistoryEvent(task, 'held-archived', result.reason); } catch { /* best-effort */ }
      }
      if (result.archived) summary.archived++;
      else summary.errors.push(`archive failed for ${fname}: ${result.reason}`);
    }
    return summary;
  }

  // Project exists in registry -- verify it's actually registered (realpath match, etc.)
  // before routing. This handles the edge case where a project is in projects.json but
  // its repoRoot points to a non-existent path (realpath fails, isProjectRegistered returns false).
  const registered = isProjectRegistered(project.label, project.repoRoot);

  if (registered) {
    // Route to the project's own queue/adhoc/ directory. The project's pipelineDir is
    // where its queue lives (see chat-projects.js's listProjects).
    const targetDir = path.join(project.pipelineDir, 'queue', 'adhoc');
    fs.mkdirSync(targetDir, { recursive: true });

    for (const { full, name: fname, task } of heldTasks) {
      const dest = path.join(targetDir, fname);
      try {
        // Overwrite any existing file with the same id (shouldn't happen, but be safe).
        if (fs.existsSync(dest)) {
          fs.unlinkSync(dest);
        }
        fs.renameSync(full, dest);
        summary.routed++;
        if (task) {
          try {
            delete task.heldForProject;
            task.routedFromHeld = new Date().toISOString();
            fs.writeFileSync(dest, JSON.stringify(task, null, 2) + '\n');
            appendHistoryEvent(task, 'routed-from-held', `routed from held-for-project/${name}/ to ${project.label} queue`);
          } catch { /* best-effort */ }
        }
      } catch (e) {
        summary.errors.push(`move failed for ${fname}: ${e.message}`);
      }
    }
  } else {
    // Project is in registry but not actually registered (e.g., repoRoot points to
    // a path that doesn't exist). Archive with a clear reason.
    for (const { full, name: fname, task } of heldTasks) {
      const result = archiveTask({ full, name: fname, pipelineDir, projectName: name, reason: `project ${project.label} not registered (repoRoot unresolvable)` });
      if (task) {
        try { appendHistoryEvent(task, 'held-archived', result.reason); } catch { /* best-effort */ }
      }
      if (result.archived) summary.archived++;
      else summary.errors.push(`archive failed for ${fname}: ${result.reason}`);
    }
  }

  return summary;
}

// Main entry point: sweeps all held-for-project directories and routes tasks.
//
// Returns { routed: number, archived: number, errors: string[] } summarising the sweep.
// Never throws -- logs errors via pipeline-history.log and returns them in the summary.
//
// `opts.pipelineDir` is optional; defaults to the configured pipeline dir. `opts.projects`
// is for tests (to inject a fake registry).
function sweepHeldForProject(opts = {}) {
  const { pipelineDir: pipelineDirFromOpts } = opts;
  let pipelineDir;
  try {
    pipelineDir = pipelineDirFromOpts || getConfig().pipelineDir;
  } catch {
    // No config available -- nothing to do.
    return { routed: 0, archived: 0, errors: ['no pipeline dir configured'] };
  }

  const heldDirs = listHeldProjectDirs(pipelineDir);
  if (heldDirs.length === 0) {
    return { routed: 0, archived: 0, errors: [] };
  }

  const summary = { routed: 0, archived: 0, errors: [] };

  for (const heldDir of heldDirs) {
    try {
      const projectSummary = routeProjectDir({ ...heldDir, pipelineDir });
      summary.routed += projectSummary.routed;
      summary.archived += projectSummary.archived;
      summary.errors.push(...projectSummary.errors);
    } catch (e) {
      summary.errors.push(`sweep held-for-project/${heldDir.name} failed: ${e.message}`);
    }
  }

  // Log the sweep outcome to pipeline history for audit.
  try {
    logPipelineEvent(pipelineDir, 'held-for-project-sweep', {
      routed: summary.routed,
      archived: summary.archived,
      errorCount: summary.errors.length,
      projectsSwept: heldDirs.map((d) => d.name),
    });
  } catch { /* best-effort */ }

  return summary;
}

module.exports = { sweepHeldForProject };
