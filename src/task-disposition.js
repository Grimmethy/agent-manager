'use strict';

// Resolves the TERMINAL DISPOSITION of a task that has already been applied -- the one
// thing the pipeline log never recorded. task-history.js's own header already names the
// gap it was created to close ("apply-task.js never touched task.history, so a task
// landing in done/ carried no record that it was ever applied, when, or to what branch");
// this closes the NEXT one: `applied` was the last event in every task's log, so from the
// log alone you could not tell whether a task's code actually reached origin/<main>, is
// still sitting on an unmerged agent/<id> branch, or was applied to a branch that has
// since vanished without ever landing (lost work). That is exactly what an update audit
// needs to answer, so every applied task now gets a definitive closing event.
//
// Terminal stages (appended by task-log-reconcile.js's sweep, by the dashboard merge
// button, and by the coordinator hub):
//   merged         -- the task's code is on origin/<main> (its `Task: <id>` commit trailer,
//                     or a triage-batch `(task <id>)` line, is reachable from origin/<main>)
//   applied-direct -- a directToMain source committed straight to <main> (the apply detail
//                     says so) but no locatable trailer -- treated as shipped
//   filed          -- the apply wrote a candidates-doc / Second Brain note, nothing to merge
//   noop           -- the apply was a no-op verdict (false positive, empty, "no code change")
//   pending-merge  -- an agent/<id> branch exists and is ahead of <main>, not yet merged
//   abandoned      -- applied to a branch that no longer exists and is NOT on <main>: the
//                     work was lost. This is the one an audit must never miss.

const { execFileSync } = require('child_process');
const { detectDefaultBranch } = require('./git-runner.js');

const TERMINAL_STAGES = new Set([
  'merged', 'applied-direct', 'filed', 'noop', 'pending-merge', 'abandoned',
]);

function lastEvent(history) {
  return Array.isArray(history) && history.length ? history[history.length - 1] : null;
}

function lastAppliedEvent(history) {
  if (!Array.isArray(history)) return null;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i] && history[i].stage === 'applied') return history[i];
  }
  return null;
}

// A default git probe -- swappable in tests. Returns stdout (trimmed) or '' on any failure.
function realGit(repoRoot, args) {
  try {
    return execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000,
    }).trim();
  } catch {
    return '';
  }
}

// Build the "what has actually shipped / what branches exist" context ONCE for a whole
// sweep, so resolveDisposition() does zero git subprocesses per record. A per-id
// `git log --grep` over full history, twice per record, is ~10k history walks across a
// 5000-record backfill -- unusable. Instead: one `git log --format=%B` to harvest every
// applied task id reachable from origin/<main> (both apply-commit shapes), and one
// `git for-each-ref` for the agent/<id> branches and how far each is ahead.
function buildShipContext(repoRoot, { git = realGit, mainBranch: mainOverride } = {}) {
  const mainBranch = mainOverride || (repoRoot ? detectDefaultBranch(repoRoot) : 'master');
  const onMainIds = new Map(); // taskId -> short sha of the commit that carries it

  const bodies = git(repoRoot, ['log', `origin/${mainBranch}`, '--format=%H%x00%B%x00%x00']);
  for (const chunk of bodies.split('\x00\x00')) {
    const [sha, body] = chunk.split('\x00');
    if (!sha || !body) continue;
    const short = sha.trim().slice(0, 12);
    for (const m of body.matchAll(/(?:^|\s)Task:\s+(\S+)\s+\(/g)) if (!onMainIds.has(m[1])) onMainIds.set(m[1], short);
    for (const m of body.matchAll(/\(task\s+(\S+?)\)/g)) if (!onMainIds.has(m[1])) onMainIds.set(m[1], short);
  }

  const branchAhead = new Map(); // taskId -> commits the agent/<id> branch is ahead of origin/<main>
  // for-each-ref with an ahead/behind count, one call, both local and remote agent/* refs.
  const refs = git(repoRoot, [
    'for-each-ref', '--format=%(refname:short)%00%(ahead-behind:origin/' + mainBranch + ')',
    'refs/heads/agent/', 'refs/remotes/origin/agent/',
  ]);
  for (const line of refs.split('\n')) {
    const [ref, ab] = line.split('\x00');
    if (!ref) continue;
    const id = ref.replace(/^origin\//, '').replace(/^agent\//, '');
    const ahead = Number((ab || '').trim().split(/\s+/)[0]) || 0;
    // a ref present in both heads/ and remotes/origin/ -- keep the larger ahead count
    branchAhead.set(id, Math.max(branchAhead.get(id) || 0, ahead));
  }

  return { mainBranch, onMainIds, branchAhead };
}

// Fallbacks for the single-record path (e.g. app.py right after a merge) -- one id, so a
// direct git call is fine.
function taskCommitOnMain(git, repoRoot, mainBranch, taskId) {
  for (const needle of [`Task: ${taskId} (`, `(task ${taskId})`]) {
    const sha = git(repoRoot, [
      'log', `origin/${mainBranch}`, '-n', '1', '--fixed-strings', `--grep=${needle}`, '--format=%H',
    ]);
    if (sha) return sha;
  }
  return '';
}

function branchAheadCount(git, repoRoot, mainBranch, branch) {
  for (const ref of [`origin/${branch}`, branch]) {
    const exists = git(repoRoot, ['rev-parse', '--verify', '--quiet', ref]);
    if (!exists) continue;
    const n = git(repoRoot, ['rev-list', '--count', `origin/${mainBranch}..${ref}`]);
    return { exists: true, ahead: Number(n) || 0 };
  }
  return { exists: false, ahead: 0 };
}

const FILED_RE = /filed under|->\s*\/|→\s*\/|appended|candidate\(s\)|wrote .*\.md/i;
const NOOP_RE = /no candidates|no code change|degenerate|false positive|empty implement|no-op|suggested 0|nothing to (apply|do)|skipped/i;
const DIRECT_RE = /committed to (?:master|main)|triage batch/i;
const BRANCH_DETAIL_RE = /^agent\//;

// record -> { stage, detail } to append, or null when there is nothing to do (the task
// was never applied, or it already carries a terminal event).
//
// Pass a `ctx` from buildShipContext() to resolve a whole sweep with zero per-record git
// calls (the fast path). Without it, falls back to a direct git probe per id (fine for a
// single record, e.g. from the dashboard right after a merge).
function resolveDisposition(record, { repoRoot, git = realGit, mainBranch: mainOverride, ctx } = {}) {
  if (!record || typeof record !== 'object') return null;
  const history = record.history;
  const applied = lastAppliedEvent(history);
  if (!applied) return null; // never applied -- blocked/needs-clarification in done, not this sweep's job

  const tail = lastEvent(history);
  if (tail && TERMINAL_STAGES.has(tail.stage) && tail.stage !== 'pending-merge') return null; // already closed
  // A 'pending-merge' tail IS re-resolved (the branch may have been merged since).

  const detail = String(applied.detail || '').trim();
  const taskId = record.id || '';
  const mainBranch = (ctx && ctx.mainBranch) || mainOverride || (repoRoot ? detectDefaultBranch(repoRoot) : 'master');

  // 1. Definitively on origin/<main>?
  if (taskId) {
    const sha = ctx
      ? (ctx.onMainIds.get(taskId) || '')
      : (repoRoot ? taskCommitOnMain(git, repoRoot, mainBranch, taskId) : '');
    if (sha) {
      return { stage: 'merged', detail: `on origin/${mainBranch} @ ${sha.slice(0, 12)} (commit-trailer)` };
    }
  }

  // 2. directToMain source that says it committed straight to main, trailer not locatable
  //    (batch commit older than the current message format, or origin not fetched).
  if (DIRECT_RE.test(detail)) {
    return { stage: 'applied-direct', detail: `directToMain apply: ${detail}`.slice(0, 200) };
  }

  // 3. An agent/<id> branch still around?
  if (taskId) {
    let exists = false;
    let ahead = 0;
    if (ctx) {
      exists = ctx.branchAhead.has(taskId);
      ahead = ctx.branchAhead.get(taskId) || 0;
    } else if (repoRoot) {
      ({ exists, ahead } = branchAheadCount(git, repoRoot, mainBranch, `agent/${taskId}`));
    }
    if (exists && ahead > 0) {
      return { stage: 'pending-merge', detail: `agent/${taskId} is ${ahead} commit(s) ahead of ${mainBranch}, not merged` };
    }
    if (exists && ahead === 0) {
      return { stage: 'merged', detail: `agent/${taskId} fully contained in ${mainBranch} (branch not ahead)` };
    }
  }

  // 4. The apply wrote a doc / note -- nothing to merge.
  if (FILED_RE.test(detail)) {
    return { stage: 'filed', detail: `apply wrote a doc/note: ${detail}`.slice(0, 200) };
  }

  // 5. The apply was an explicit no-op verdict.
  if (NOOP_RE.test(detail)) {
    return { stage: 'noop', detail: `no-op apply: ${detail}`.slice(0, 200) };
  }

  // 6. The apply detail names an agent/<id> branch, but it is gone AND not on <main>:
  //    the work was lost. The loud one.
  if (BRANCH_DETAIL_RE.test(detail)) {
    return { stage: 'abandoned', detail: `applied to ${detail} -- branch gone, not on ${mainBranch}: work lost` };
  }

  // 7. Unclassifiable apply outcome from a non-branch source -- record it as a noop rather
  //    than cry "abandoned" for what is almost certainly a doc/verdict source with an
  //    unusual detail string.
  return { stage: 'noop', detail: `apply outcome not classifiable, treated as no-op: ${detail || '(no detail)'}`.slice(0, 200) };
}

module.exports = { resolveDisposition, buildShipContext, TERMINAL_STAGES, lastAppliedEvent, taskCommitOnMain };
