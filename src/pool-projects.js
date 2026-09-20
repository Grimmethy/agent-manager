'use strict';

// pool-projects.js -- which suite projects an idle lane may borrow work from (docs/idle-pool-borrowing.md).
//
// A registered project (projects.json) opts in with `"pool": true`. This module answers "given the ACTIVE project, which pool projects are
// there, in what order, and what env makes one invocation run in that project's context". The loops that use it (worker lanes, reviewer, apply
// loop, watchdog) are separate changes; this only computes the list and the env.
//
// * Deduplicated by the real path of pipelineDir: projects.json has duplicate registrations of one project under two mount paths.
// * A project is skipped when its repo or its queue/ dir does not exist, and the ACTIVE project is never in the pool.
// * Ordered least-recently-borrowed first (never-borrowed first, in projects.json order), so every suite project gets GPU time instead of the
//   first entry with work hogging it. State: ~/.local/state/agent-manager/pool-state.json (AGENT_MANAGER_POOL_STATE_PATH overrides).
// * AGENT_MANAGER_POOL_BORROW=false switches the whole thing off.
//
// The env for a borrowed invocation sets the project's paths but PINS AGENT_MANAGER_INSTANCES_DIR to the lane's home instances dir
// (src/instances-dir.js), so heartbeats and GPU locks stay shared. Keys a project does not define (APPLY_REPO_ROOT, GREP_DIRS) are UNSET, the
// same rule the dashboard applies when it switches project, so the previous project's value can never leak into a borrowed one.

const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECTS_PATH = process.env.AGENT_MANAGER_PROJECTS_PATH || path.join(__dirname, '..', 'projects.json');

function enabled() {
  return String(process.env.AGENT_MANAGER_POOL_BORROW || '').trim().toLowerCase() !== 'false';
}

function statePath() {
  return process.env.AGENT_MANAGER_POOL_STATE_PATH || path.join(os.homedir(), '.local', 'state', 'agent-manager', 'pool-state.json');
}

// Borrowing is tracked per ROLE (worker / reviewer): a worker that found a project's draft queue empty must not hide a project that has
// reviews waiting from the reviewer. The worker's keys are the plain realpath (unchanged); other roles are prefixed.
function roleKey(role, pipe) { return role && role !== 'worker' ? `${role}|${pipe}` : pipe; }

function real(p) {
  if (!p) return '';
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function readProjects(projectsPath = PROJECTS_PATH) {
  try {
    const list = JSON.parse(fs.readFileSync(projectsPath, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

function readState(file = statePath()) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!s || typeof s !== 'object') return { lastBorrowedAt: {}, emptyUntil: {} };
    return { ...s, lastBorrowedAt: s.lastBorrowedAt && typeof s.lastBorrowedAt === 'object' ? s.lastBorrowedAt : {}, emptyUntil: s.emptyUntil && typeof s.emptyUntil === 'object' ? s.emptyUntil : {} };
  } catch { return { lastBorrowedAt: {}, emptyUntil: {} }; }
}

// Records that a lane just borrowed from this project (drives the least-recently-borrowed ordering). Best-effort.
function markBorrowed(pipelineDir, { now = new Date(), file = statePath(), role = 'worker' } = {}) {
  try {
    const state = readState(file);
    const key = roleKey(role, real(pipelineDir));
    state.lastBorrowedAt[key] = now.toISOString();
    delete state.emptyUntil[key];
    writeState(file, state);
  } catch { /* ordering is a nicety; never break a lane over it */ }
}

// A project a lane just visited and found nothing to do in is skipped for a while (default 5 min, AGENT_MANAGER_POOL_EMPTY_BACKOFF_SECS) so an
// idle lane does not re-run a whole tick against every empty suite project every cycle. A borrow that DID work clears it.
function emptyBackoffMs() {
  const n = Number(process.env.AGENT_MANAGER_POOL_EMPTY_BACKOFF_SECS);
  return Number.isFinite(n) && n >= 0 ? n * 1000 : 5 * 60 * 1000;
}

function markEmpty(pipelineDir, { now = new Date(), file = statePath(), ttlMs = emptyBackoffMs(), role = 'worker' } = {}) {
  try {
    const state = readState(file);
    state.emptyUntil[roleKey(role, real(pipelineDir))] = new Date(now.getTime() + ttlMs).toISOString();
    writeState(file, state);
  } catch { /* best-effort */ }
}

function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// -> [{ label, repoRoot, pipelineDir, domainsPath, applyRepoRoot, grepDirs }] in borrow order. `active` = { repoRoot, pipelineDir } of the
// project the pipeline is running now (defaults to the process env).
function poolProjects({ projectsPath = PROJECTS_PATH, active, stateFile = statePath(), now = new Date(), includeBackedOff = false, role = 'worker' } = {}) {
  if (!enabled()) return [];
  const act = active || { repoRoot: process.env.AGENT_MANAGER_REPO_ROOT, pipelineDir: process.env.AGENT_MANAGER_PIPELINE_DIR };
  const activePipe = real(act.pipelineDir || act.repoRoot);
  const activeRepo = real(act.repoRoot);
  const state = readState(stateFile);
  const seen = new Set();
  const out = [];
  readProjects(projectsPath).forEach((e, index) => {
    if (!e || e.pool !== true || !e.repoRoot || !e.pipelineDir) return;
    const pipe = real(e.pipelineDir);
    if (seen.has(pipe)) return;
    seen.add(pipe);
    if (pipe === activePipe || real(e.repoRoot) === activeRepo) return;
    if (!fs.existsSync(e.repoRoot) || !fs.existsSync(path.join(e.pipelineDir, 'queue'))) return;
    if (!includeBackedOff && Date.parse(state.emptyUntil[roleKey(role, pipe)]) > now.getTime()) return;
    out.push({
      index, pipe,
      label: e.label || path.basename(e.repoRoot),
      repoRoot: e.repoRoot,
      pipelineDir: e.pipelineDir,
      domainsPath: e.domainsPath || path.join(e.pipelineDir, 'task-domains.json'),
      applyRepoRoot: e.applyRepoRoot || null,
      grepDirs: e.grepDirs || null,
    });
  });
  const last = (p) => Date.parse(state.lastBorrowedAt[roleKey(role, p.pipe)]) || 0;
  out.sort((a, b) => last(a) - last(b) || a.index - b.index);
  return out.map(({ index, pipe, ...p }) => p);
}

// -> { set: {KEY: value}, unset: [KEY] } for running ONE invocation in `project`'s context from a lane whose home instances dir is
// `homeInstancesDir`.
function poolEnvFor(project, homeInstancesDir) {
  const set = {
    AGENT_MANAGER_REPO_ROOT: project.repoRoot,
    AGENT_MANAGER_PIPELINE_DIR: project.pipelineDir,
    AGENT_MANAGER_DOMAINS_PATH: project.domainsPath,
    AGENT_MANAGER_INSTANCES_DIR: homeInstancesDir,
    AGENT_MANAGER_BORROWING_FROM: project.label,
  };
  const unset = [];
  if (project.applyRepoRoot) set.AGENT_MANAGER_APPLY_REPO_ROOT = project.applyRepoRoot; else unset.push('AGENT_MANAGER_APPLY_REPO_ROOT');
  if (project.grepDirs) set.AGENT_MANAGER_GREP_DIRS = project.grepDirs; else unset.push('AGENT_MANAGER_GREP_DIRS');
  return { set, unset };
}

// The same thing as argv for `env` (one token per element): ['-u','KEY', ..., 'KEY=value', ...].
function poolEnvArgs(project, homeInstancesDir) {
  const { set, unset } = poolEnvFor(project, homeInstancesDir);
  return [...unset.flatMap((k) => ['-u', k]), ...Object.entries(set).map(([k, v]) => `${k}=${v}`)];
}

module.exports = { enabled, poolProjects, poolEnvFor, poolEnvArgs, markBorrowed, markEmpty, readProjects, PROJECTS_PATH };

if (require.main === module) {
  // node src/pool-projects.js --list                  JSON [{label, repoRoot, pipelineDir, ...}] in borrow order
  // node src/pool-projects.js --labels                pipelineDir of each borrowable project, one per line, in borrow order (empty-backoff excluded)
  // node src/pool-projects.js --env-args <label|pipelineDir> <homeInstancesDir>   one `env` argv token per line
  // node src/pool-projects.js --mark <pipelineDir>    record a borrow
  const [flag, a, b] = process.argv.slice(2);
  if (flag === '--list') {
    console.log(JSON.stringify(poolProjects({ role: a || 'worker' })));
  } else if (flag === '--env-args') {
    const project = poolProjects({ includeBackedOff: true }).find((p) => p.label === a || real(p.pipelineDir) === real(a));
    if (!project) { console.error(`pool-projects: no pool project '${a}'`); process.exit(1); }
    for (const token of poolEnvArgs(project, b || process.env.AGENT_MANAGER_INSTANCES_DIR || path.join(process.env.AGENT_MANAGER_PIPELINE_DIR || '', 'instances'))) console.log(token);
  } else if (flag === '--labels') {
    for (const p of poolProjects({ role: a || 'worker' })) console.log(p.pipelineDir);
  } else if (flag === '--all') {
    for (const p of poolProjects({ includeBackedOff: true })) console.log(p.pipelineDir);
  } else if (flag === '--mark') {
    markBorrowed(a, { role: b || 'worker' });
  } else if (flag === '--mark-empty') {
    markEmpty(a, { role: b || 'worker' });
  } else {
    console.error('usage: pool-projects.js --list [role] | --labels [role] | --all | --env-args <label|pipelineDir> [homeInstancesDir] | --mark <pipelineDir> [role] | --mark-empty <pipelineDir> [role]');
    process.exit(2);
  }
}
