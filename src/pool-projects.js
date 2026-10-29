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
// Premium reach (2026-10-18, Grimmethy: "premium priority tasks happen regardless of what project repo is currently selected (currently
// selected repo still wins the tie)"): registeredProjects() is the same list WITHOUT the `pool` opt-in -- every registered project -- and
// premiumProjects() keeps the ones holding a premiumPriority task in the queue stage a role works on (hasPremium; it only picks WHICH
// project a borrowed tick visits -- the lane-aware ranking stays in next-claimable-task.js). Its order/backoff state is separate
// ('premium-<role>' keys) from idle borrowing's. Every premium borrow is written to the HOME project's pipeline history ('premium-borrow').
// AGENT_MANAGER_PREMIUM_REACH=false switches it off, independently of AGENT_MANAGER_POOL_BORROW.
//
// The env for a borrowed invocation sets the project's paths but PINS AGENT_MANAGER_INSTANCES_DIR to the lane's home instances dir
// (src/instances-dir.js), so heartbeats and GPU locks stay shared. Keys a project does not define (APPLY_REPO_ROOT, GREP_DIRS) are UNSET, the
// same rule the dashboard applies when it switches project, so the previous project's value can never leak into a borrowed one.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { openQueueCache, readTaskCached } = require('./queue-cache.js');   // node built-ins only: safe to load from the bash-called CLI too
const { unmetPrerequisiteHubs } = require('./hub-prerequisites.js');   // fs + path only: safe to load from the bash-called CLI

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

// The per-entry rules every list shares: an entry needs repoRoot + pipelineDir, is deduped by realpath(pipelineDir), is never the ACTIVE
// project (`active` = { repoRoot, pipelineDir } of the project the pipeline is running now, default the process env), and is skipped when its
// repo or queue/ dir is missing. `requirePool` keeps only `pool: true` entries (idle borrowing); premium reach passes false. Entries keep
// their projects.json `index` and realpath `pipe` for ordering; stripProject() drops them.
function eligibleEntries({ projectsPath = PROJECTS_PATH, active, requirePool = true } = {}) {
  const act = active || { repoRoot: process.env.AGENT_MANAGER_REPO_ROOT, pipelineDir: process.env.AGENT_MANAGER_PIPELINE_DIR };
  const activePipe = real(act.pipelineDir || act.repoRoot);
  const activeRepo = real(act.repoRoot);
  const seen = new Set();
  const out = [];
  readProjects(projectsPath).forEach((e, index) => {
    if (!e || (requirePool && e.pool !== true) || !e.repoRoot || !e.pipelineDir) return;
    const pipe = real(e.pipelineDir);
    if (seen.has(pipe)) return;
    seen.add(pipe);
    if (pipe === activePipe || real(e.repoRoot) === activeRepo) return;
    if (!fs.existsSync(e.repoRoot) || !fs.existsSync(path.join(e.pipelineDir, 'queue'))) return;
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
  return out;
}

const stripProject = ({ index, pipe, ...p }) => p;

// Least-recently-borrowed first under state key `key`, projects.json order as the tiebreak.
function orderByLastBorrowed(entries, state, key) {
  const last = (p) => Date.parse(state.lastBorrowedAt[roleKey(key, p.pipe)]) || 0;
  return [...entries].sort((a, b) => last(a) - last(b) || a.index - b.index).map(stripProject);
}

const backedOff = (state, key, pipe, now) => Date.parse(state.emptyUntil[roleKey(key, pipe)]) > now.getTime();

// -> [{ label, repoRoot, pipelineDir, domainsPath, applyRepoRoot, grepDirs }] in borrow order (pool:true projects only).
function poolProjects({ projectsPath = PROJECTS_PATH, active, stateFile = statePath(), now = new Date(), includeBackedOff = false, role = 'worker' } = {}) {
  if (!enabled()) return [];
  const state = readState(stateFile);
  const out = eligibleEntries({ projectsPath, active, requirePool: true })
    .filter((p) => includeBackedOff || !backedOff(state, role, p.pipe, now));
  return orderByLastBorrowed(out, state, role);
}

// Every registered project (pooled or not), same shape and rules as poolProjects(), in projects.json order.
function registeredProjects({ projectsPath = PROJECTS_PATH, active } = {}) {
  return eligibleEntries({ projectsPath, active, requirePool: false }).map(stripProject);
}

function premiumReachEnabled() {
  return String(process.env.AGENT_MANAGER_PREMIUM_REACH || '').trim().toLowerCase() !== 'false';
}

const LANE_RE = /^[A-Za-z0-9_.-]+$/;   // a lane is an instance id (worker-3090); anything else is ignored rather than joined into a path

// The queue stages a role takes work from: a worker claims from pending/ and resumes its own drafting/<lane>/, and the tick's own seeding
// generates a premium adhoc/ or derived/ task first, ahead of every source and the generation throttle (lib/task-selection.js
// premiumPreemptedTask); the reviewer reads review/; the apply loop reads approved/. 'worker-seed' is just the generation stages, which a
// premium-only borrowed tick checks before running the seeding step (so it never generates regular work in another project).
function premiumStageDirs(role, lane) {
  if (role === 'worker') return ['adhoc', 'derived', 'pending', ...(lane && LANE_RE.test(lane) ? [path.join('drafting', lane)] : [])];
  if (role === 'worker-seed') return ['adhoc', 'derived'];
  if (role === 'reviewer') return ['review'];
  if (role === 'apply') return ['approved'];
  return [];
}

// A premium task only wins the tie for its project (hasPremium) when a lane could actually claim it. 2026-10-25: six premium stacked hub children in the
// home queue's adhoc/ were each held by an unmet dependsOn (their dependency sat in needs-clarification, blocked, coordinating or adhoc for 66-69 h), yet
// hasPremium counted them, so every lane answered "home has premium work", never borrowed another repo's premium task, and last did so on 2026-10-22.
// These helpers mirror the gates nextAdhocLikeTask (task-sources.js) applies to adhoc/ and derived/ candidates, WITHOUT loading config, the source
// registry or git (hasPremium is called from bash on every tick). Deliberate gaps, all in the fail-closed direction or the old behaviour: no git
// reconcile fallback (a done record that is neither stamped nor stacked reads as unreleased), no per-source dependencyRelease override, and not
// hubOrder.siblingHolds or the derived hold (a premium task held only by those still counts, as before).
const NO_CODE_COMING_DISPOSITIONS = new Set(['noop', 'dismissed', 'filed', 'abandoned', 'superseded', 'aged-out']);
const NESTED_HUB_PIECE_DONE = new Set(['pending-merge', 'done', 'merged', 'applied-direct', 'gone', ...NO_CODE_COMING_DISPOSITIONS]);
const GATED_PREMIUM_STAGES = new Set(['adhoc', 'derived']);   // the only stages whose claim path gates on dependsOn/softDependsOn/prerequisiteHubs

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// task-sources.js nestedHubBuilt: a coordinating record with a stacked branch whose pieces are all finished releases its dependents.
function nestedHubBuilt(pipelineDir, depId) {
  const rec = readJsonSafe(path.join(pipelineDir, 'queue', 'coordinating', `${depId}.json`));
  if (!rec || !rec.stacked || !rec.stacked.branch) return false;
  const subs = Array.isArray(rec.subTasks) ? rec.subTasks : [];
  return subs.length > 0 && subs.every((sub) => sub && typeof sub.status === 'string' && NESTED_HUB_PIECE_DONE.has(sub.status));
}

const DONE_DIRS = [['done'], ['done', '_archived_no_action']];
function doneRecord(pipelineDir, depId) {
  for (const parts of DONE_DIRS) {
    const rec = readJsonSafe(path.join(pipelineDir, 'queue', ...parts, `${depId}.json`));
    if (rec) return rec;
  }
  return null;
}

// task-sources.js isDependencySatisfied + defaultReleaseSignals (minus the git fallback and the per-source override).
function dependencyReleased(pipelineDir, depId) {
  const id = String(depId || '').trim();
  if (!id) return true;   // a blank or malformed entry blocks nothing
  if (nestedHubBuilt(pipelineDir, id)) return true;
  for (const parts of DONE_DIRS) {
    const rec = readJsonSafe(path.join(pipelineDir, 'queue', ...parts, `${id}.json`));
    if (!rec) continue;
    if (rec.mergedAt || rec.terminalDisposition === 'applied-direct') return true;
    if (NO_CODE_COMING_DISPOSITIONS.has(rec.terminalDisposition)) return true;
    if (rec.stacked && rec.stacked.branch) return true;   // a stacked child reaching done/ is committed on the shared branch
  }
  return false;
}

// task-sources.js isSoftDependencySatisfied: reaching done/ at all is the signal.
function softDependencyReleased(pipelineDir, depId) {
  const id = String(depId || '').trim();
  return !id || !!doneRecord(pipelineDir, id);
}

// False when a lane could not claim this adhoc/derived premium task right now. Any unexpected error counts the task (the pre-fix behaviour).
function premiumTaskClaimable(pipelineDir, task) {
  try {
    if (Array.isArray(task.dependsOn) && task.dependsOn.some((id) => !dependencyReleased(pipelineDir, id))) return false;
    if (Array.isArray(task.softDependsOn) && task.softDependsOn.some((id) => !softDependencyReleased(pipelineDir, id))) return false;
    if (unmetPrerequisiteHubs(pipelineDir, task).length > 0) return false;
  } catch { return true; }
  return true;
}

// Is there a task in `dir` (one stage directory) with a top-level premiumPriority === true that a lane could claim? `names` are its .json files and `read`
// turns a full path into { task }: the cached reader normally, a direct read when the cache layer itself broke.
function stageHasPremium(pipelineDir, stage, dir, names, read) {
  for (const name of names) {
    const { task } = read(path.join(dir, name));
    if (!task || task.premiumPriority !== true) continue;
    if (GATED_PREMIUM_STAGES.has(stage) && !premiumTaskClaimable(pipelineDir, task)) continue;   // gated premium work does not hold the tie
    return true;
  }
  return false;
}

// True when a task in one of the role's stages has a top-level premiumPriority === true -- the same test as lib/task-selection.js
// hasPremiumPriorityInQueue (not required from there: that module loads the config and source registry, and this one is called from
// bash every tick). Unreadable dirs and corrupt/partial files are skipped; never throws. Each stage directory is read through the RAM cache
// (queue-cache.js): a tick that finds the directory unchanged reads no task file. Measured on wok 2026-10-28: pending/ held 3576 files / 58 MB and a
// cold-cache pass over them took 44 s. A task edited in place (rather than added or removed) is noticed within the cache's REVALIDATE_MS. If the cache
// layer itself throws, that stage is read directly, as it was before the cache existed.
function hasPremium(pipelineDir, { role = 'worker', lane = null } = {}) {
  if (!pipelineDir) return false;
  for (const stage of premiumStageDirs(role, lane)) {
    const dir = path.join(pipelineDir, 'queue', stage);
    let found = false;
    try {
      const cache = openQueueCache(dir);
      found = stageHasPremium(pipelineDir, stage, dir, cache.names(), (full) => readTaskCached(cache, full));
      cache.save();
    } catch {
      try {
        const names = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
        found = stageHasPremium(pipelineDir, stage, dir, names, (full) => readTaskCached(null, full));
      } catch { found = false; }   // an unreadable stage holds no premium work
    }
    if (found) return true;
  }
  return false;
}

// State key for premium reach: per lane for a worker (a premium task another lane may take is not this lane's backoff), per role otherwise.
function premiumRoleKey(role = 'worker', lane = null) {
  return role === 'worker' && lane ? `premium-worker:${lane}` : `premium-${role}`;
}

// -> registered projects (active excluded) holding a premium task for `role` (and `lane`), least-recently-premium-borrowed first.
function premiumProjects({ role = 'worker', lane = null, projectsPath = PROJECTS_PATH, active, stateFile = statePath(), now = new Date(), includeBackedOff = false } = {}) {
  if (!premiumReachEnabled()) return [];
  const state = readState(stateFile);
  const key = premiumRoleKey(role, lane);
  const out = eligibleEntries({ projectsPath, active, requirePool: false })
    .filter((p) => includeBackedOff || !backedOff(state, key, p.pipe, now))
    .filter((p) => hasPremium(p.pipelineDir, { role, lane }));
  return orderByLastBorrowed(out, state, key);
}

// Records a premium borrow (order + clears its backoff) and writes one 'premium-borrow' event to the HOME project's pipeline history, the
// durable trail of every time a premium task outside the active project was worked. Best-effort.
function markPremiumBorrowed(pipelineDir, { role = 'worker', lane = null, homePipelineDir = null, now = new Date(), file = statePath(), projectsPath = PROJECTS_PATH } = {}) {
  markBorrowed(pipelineDir, { now, file, role: premiumRoleKey(role, lane) });
  if (!homePipelineDir) return;
  try {
    const entry = readProjects(projectsPath).find((e) => e && e.pipelineDir && real(e.pipelineDir) === real(pipelineDir));
    require('./pipeline-history.js').logPipelineEvent(homePipelineDir, 'premium-borrow', {
      role, lane: lane || null, project: (entry && entry.label) || path.basename(pipelineDir), pipelineDir,
    });
  } catch { /* best-effort audit trail */ }
}

// A premium borrow that took nothing (e.g. the task is restricted to another lane) backs that project off for this role/lane.
function markPremiumEmpty(pipelineDir, { role = 'worker', lane = null, now = new Date(), file = statePath(), ttlMs = emptyBackoffMs() } = {}) {
  markEmpty(pipelineDir, { now, file, ttlMs, role: premiumRoleKey(role, lane) });
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

module.exports = {
  enabled, poolProjects, poolEnvFor, poolEnvArgs, markBorrowed, markEmpty, readProjects, PROJECTS_PATH,
  registeredProjects, premiumReachEnabled, premiumStageDirs, hasPremium, premiumTaskClaimable, dependencyReleased, premiumProjects, markPremiumBorrowed, markPremiumEmpty,
};

if (require.main === module) {
  // node src/pool-projects.js --list                  JSON [{label, repoRoot, pipelineDir, ...}] in borrow order
  // node src/pool-projects.js --labels                pipelineDir of each borrowable project, one per line, in borrow order (empty-backoff excluded)
  // node src/pool-projects.js --env-args <label|pipelineDir> <homeInstancesDir>   one `env` argv token per line (pool or other registered project)
  // node src/pool-projects.js --mark <pipelineDir>    record a borrow
  // node src/pool-projects.js --premium-projects <role> [lane]       pipelineDir of each registered project holding premium work for role, one per line
  // node src/pool-projects.js --has-premium <pipelineDir> <role> [lane]   exit 0 when that project holds premium work for role, else 1
  // node src/pool-projects.js --mark-premium <pipelineDir> <role> <homePipelineDir> [lane]   record a premium borrow + home history event
  // node src/pool-projects.js --mark-premium-empty <pipelineDir> <role> [lane]   back that project off for this role/lane
  const [flag, a, b, c, d] = process.argv.slice(2);
  if (flag === '--list') {
    console.log(JSON.stringify(poolProjects({ role: a || 'worker' })));
  } else if (flag === '--env-args') {
    const match = (p) => p.label === a || real(p.pipelineDir) === real(a);
    const project = poolProjects({ includeBackedOff: true }).find(match) || registeredProjects().find(match);
    if (!project) { console.error(`pool-projects: no pool project '${a}' (and no other registered project by that name)`); process.exit(1); }
    for (const token of poolEnvArgs(project, b || process.env.AGENT_MANAGER_INSTANCES_DIR || path.join(process.env.AGENT_MANAGER_PIPELINE_DIR || '', 'instances'))) console.log(token);
  } else if (flag === '--labels') {
    for (const p of poolProjects({ role: a || 'worker' })) console.log(p.pipelineDir);
  } else if (flag === '--all') {
    for (const p of poolProjects({ includeBackedOff: true })) console.log(p.pipelineDir);
  } else if (flag === '--mark') {
    markBorrowed(a, { role: b || 'worker' });
  } else if (flag === '--mark-empty') {
    markEmpty(a, { role: b || 'worker' });
  } else if (flag === '--premium-projects') {
    for (const p of premiumProjects({ role: a || 'worker', lane: b || null })) console.log(p.pipelineDir);
  } else if (flag === '--has-premium') {
    process.exit(hasPremium(a, { role: b || 'worker', lane: c || null }) ? 0 : 1);
  } else if (flag === '--mark-premium') {
    markPremiumBorrowed(a, { role: b || 'worker', homePipelineDir: c || null, lane: d || null });
  } else if (flag === '--mark-premium-empty') {
    markPremiumEmpty(a, { role: b || 'worker', lane: c || null });
  } else {
    console.error('usage: pool-projects.js --list [role] | --labels [role] | --all | --env-args <label|pipelineDir> [homeInstancesDir] | --mark <pipelineDir> [role] | --mark-empty <pipelineDir> [role] | --premium-projects <role> [lane] | --has-premium <pipelineDir> <role> [lane] | --mark-premium <pipelineDir> <role> <homePipelineDir> [lane] | --mark-premium-empty <pipelineDir> <role> [lane]');
    process.exit(2);
  }
}
