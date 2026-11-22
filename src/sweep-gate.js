'use strict';

// sweep-gate.js -- an event gate for the watchdog's per-project sweeps (ADR-0024: triggers, not polls).
//
// Why (2026-11-03 measurement): the watchdog's pool loop ran branch-defect-readmit-sweep.js, branch-conflict-readmit-sweep.js and redo-supersede-sweep.js for EACH of the 41 pool
// projects on EVERY tick. redo-supersede-sweep.js is global (it reads the done/ directory of all 45 registered projects, 10,825 task files, then asks the dashboard for
// ?projects=all): one run is 7 to 13 s of disk time, so a tick spent about 7 minutes and 440,000 file reads on a result that is the same for every project. The two readmit sweeps
// each ran `git fetch` before they even looked for a candidate. None of them has anything to do unless a task record, a verdict or a remote ref changed.
//
// The gate answers `run` or `skip` for one sweep group from the mtime/size/inode of the places its input lives (the same fingerprint src/trigger.js of agent-manager-pipeline-ops
// uses), remembered per group. It FAILS OPEN: any error, a missing registry, an unknown project, a corrupt state file all answer `run`, exactly the behaviour before the gate.
//
//   AGENT_MANAGER_SWEEP_GATE            off -> always `run`
//   AGENT_MANAGER_SWEEP_GATE_MAX_IDLE_MIN   minutes after which a group runs anyway (default 30): the safety net for what an mtime cannot show (a file rewritten in place,
//                                       a remote branch that moved while nobody fetched)
//   AGENT_MANAGER_SWEEP_GATE_DIR        state directory (tests); default ~/.local/state/agent-manager/sweep-gate
// CLI: node sweep-gate.js project <pipelineDir> | node sweep-gate.js global-redo   -> prints `run` or `skip`, exit 0 always.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_MAX_IDLE_MIN = 30;
const PENDING_STATE_FILES = ['branch-defect-readmit-state.json', 'branch-conflict-readmit-state.json'];

function real(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(String(p)); }
}

function stateDir(env = process.env) {
  return String(env.AGENT_MANAGER_SWEEP_GATE_DIR || '').trim() || path.join((env.HOME || os.homedir()), '.local', 'state', 'agent-manager', 'sweep-gate');
}

function statePath(name, key, env = process.env) {
  return path.join(stateDir(env), `${name}-${crypto.createHash('sha1').update(real(key)).digest('hex')}.json`);
}

// sha1 over [path, mtimeMs, size, ino] of each path; a missing path is its own value, so appearing and disappearing both count as a change.
function signature(paths, statImpl = fs.statSync) {
  const parts = paths.map((p) => {
    try { const st = statImpl(p); return [p, st.mtimeMs, st.size, st.ino]; } catch { return [p, null]; }
  });
  return crypto.createHash('sha1').update(JSON.stringify(parts)).digest('hex');
}

function readState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return s && typeof s === 'object' && typeof s.sig === 'string' ? s : null;
  } catch { return null; }
}

function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, file);
}

// { name, key, paths, pending, now, env } -> { run, reason }. `key` names the group's state file (a pipeline directory, or a fixed word); `pending` is true while a sweep still waits
// for its second sighting. The signature is taken BEFORE the answer is stored, so a change that lands while the sweeps run differs from the stored one on the next call.
function checkGate({ name, key, paths, pending = false, now = Date.now(), env = process.env } = {}) {
  try {
    if (String(env.AGENT_MANAGER_SWEEP_GATE || '').trim().toLowerCase() === 'off') return { run: true, reason: 'gate off' };
    const sig = signature(paths);
    const file = statePath(name, key, env);
    const prev = readState(file);
    const maxIdleMs = Math.max(1, Number(env.AGENT_MANAGER_SWEEP_GATE_MAX_IDLE_MIN) || DEFAULT_MAX_IDLE_MIN) * 60000;
    let answer;
    if (!prev) answer = { run: true, reason: 'first run' };
    else if (prev.sig !== sig) answer = { run: true, reason: 'input changed' };
    else if (pending) answer = { run: true, reason: 'a sweep is waiting for its second sighting' };
    else if (!Number.isFinite(prev.at) || now - prev.at >= maxIdleMs) answer = { run: true, reason: 'safety net' };
    else return { run: false, reason: 'unchanged' };
    writeState(file, { sig, at: now });
    return answer;
  } catch (e) {
    return { run: true, reason: `gate error: ${e && e.message ? e.message : e}` };
  }
}

// The paths of one project's sweeps: its done/ directory, its verdict file and the repo's remote refs.
function refPaths(repoRoot) {
  const g = path.join(repoRoot, '.git');
  return [path.join(g, 'refs', 'remotes', 'origin', 'agent'), path.join(g, 'packed-refs'), path.join(g, 'refs', 'remotes', 'origin', 'main'),
    path.join(g, 'refs', 'remotes', 'origin', 'master'), path.join(g, 'refs', 'remotes', 'origin', 'HEAD')];
}

function registeredProjects(env = process.env) {
  const { listProjects } = require('./chat-projects.js');
  const registryPath = String(env.AGENT_MANAGER_PROJECTS_REGISTRY_PATH || env.AGENT_MANAGER_PROJECTS_PATH || '').trim() || undefined;
  return listProjects({ registryPath, activeRepoRoot: '' });
}

// Is any sweep state entry younger than SETTLE_MS (still waiting for the second sighting that makes it act)?
function hasPendingEntry(queueDir, now, settleMs) {
  for (const f of PENDING_STATE_FILES) {
    let state;
    try { state = JSON.parse(fs.readFileSync(path.join(queueDir, f), 'utf8')); } catch { continue; }
    if (!state || typeof state !== 'object') continue;
    for (const e of Object.values(state)) {
      const t = e && Date.parse(e.firstSeenAt);
      if (!Number.isFinite(t) || now - t < settleMs) return true;     // an entry without a readable time is treated as still waiting
    }
  }
  return false;
}

// Gate for the defect and conflict sweeps of one project.
function gateProject(pipelineDir, { env = process.env, now = Date.now() } = {}) {
  try {
    const { SETTLE_MS } = require('./branch-conflict-readmit-sweep.js');
    const want = real(pipelineDir);
    const project = registeredProjects(env).find((p) => real(p.pipelineDir) === want);
    if (!project) return { run: true, reason: 'project not registered' };
    const queueDir = path.join(pipelineDir, 'queue');
    return checkGate({
      name: 'project', key: pipelineDir, env, now,
      paths: [path.join(queueDir, 'done'), path.join(queueDir, 'branch-verdicts.json'), ...refPaths(project.repoRoot)],
      pending: hasPendingEntry(queueDir, now, SETTLE_MS),
    });
  } catch (e) {
    return { run: true, reason: `gate error: ${e && e.message ? e.message : e}` };
  }
}

// Gate for redo-supersede-sweep.js, which reads every registered project: one group for all of them.
function gateGlobalRedo({ env = process.env, now = Date.now() } = {}) {
  try {
    const paths = [];
    const seen = new Set();
    for (const p of registeredProjects(env)) {
      const r = real(p.pipelineDir);
      if (seen.has(r)) continue;
      seen.add(r);
      paths.push(path.join(p.pipelineDir, 'queue', 'done'), path.join(p.pipelineDir, 'queue', 'branch-verdicts.json'));
    }
    if (!paths.length) return { run: true, reason: 'no registered projects' };
    return checkGate({ name: 'global-redo', key: 'all', paths, env, now });
  } catch (e) {
    return { run: true, reason: `gate error: ${e && e.message ? e.message : e}` };
  }
}

module.exports = { checkGate, gateProject, gateGlobalRedo, signature, statePath, stateDir, hasPendingEntry, refPaths, DEFAULT_MAX_IDLE_MIN };

if (require.main === module) {
  let answer = { run: true };
  try {
    const [kind, arg] = process.argv.slice(2);
    if (kind === 'project') answer = gateProject(arg);
    else if (kind === 'global-redo') answer = gateGlobalRedo();
  } catch { answer = { run: true }; }
  process.stdout.write(`${answer.run ? 'run' : 'skip'}\n`);
}
