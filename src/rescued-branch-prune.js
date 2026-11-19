'use strict';

// rescued-branch-prune.js -- delete remote agent/triage-queue-rescued-* snapshot branches whose content is already fully covered.
//
// A rescued branch is deleted (git push origin --delete) only when EVERY `### AC-N · title` heading it adds, and EVERY patch-id it carries beyond main,
// already exists on origin/agent/triage-queue or origin/main. This mirrors _check_redundant_snapshot in python/dashboard/branch_verdicts.py. Anything
// uncertain (a git error, an unparseable answer, a unique heading or patch-id) fails closed: no delete, verdict `needs-work`.
//
//   AGENT_MANAGER_RESCUED_BRANCH_PRUNE        off | dry-run | on   (default off)
//   AGENT_MANAGER_RESCUED_BRANCH_PRUNE_KILL   1/true/on/yes -> forced off, zero git calls
//
// No timers: the module only runs when something calls it. git/fs/now/recordBranchRemoval are injected.

const ROLLING_BRANCH = 'agent/triage-queue';
const MAIN_BRANCH = 'main';
const PREFIX = 'agent/triage-queue-rescued-';
const MAX_PER_RUN = 5;
const HEADING_RE = /^### AC-\d+ · \S/;
const TRUTHY = new Set(['1', 'true', 'on', 'yes']);

function resolveMode(env = process.env) {
  if (TRUTHY.has(String(env.AGENT_MANAGER_RESCUED_BRANCH_PRUNE_KILL || '').trim().toLowerCase())) return 'off';
  const v = String(env.AGENT_MANAGER_RESCUED_BRANCH_PRUNE || 'off').trim().toLowerCase();
  if (v === 'on' || v === 'true' || v === '1') return 'on';
  if (v === 'dry-run') return 'dry-run';
  return 'off';
}

const lines = (s) => String(s || '').split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim());
const msg = (e) => (e && e.message ? String(e.message).split('\n')[0] : String(e));

// git(args) -> stdout string; throws on a nonzero exit.
function addedHeadings(git, base, ref) {
  const out = git(['diff', '--unified=0', `${base}...${ref}`]);
  return lines(out).filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)).filter((l) => HEADING_RE.test(l));
}

function headingsInTree(git, ref) {
  let out;
  try { out = git(['grep', '-h', '-e', '^### AC-', ref]); } catch (e) {
    if (e && e.status === 1) return new Set(); // git grep: no match
    throw e;
  }
  return new Set(lines(out).filter((l) => HEADING_RE.test(l)));
}

function plusShas(git, upstream, ref) {
  const out = git(['cherry', upstream, ref]);
  const shas = [];
  for (const l of lines(out)) {
    const m = /^([+-]) ([0-9a-f]{7,64})$/.exec(l.trim());
    if (!m) throw new Error(`unparseable git cherry line: ${l}`);
    if (m[1] === '+') shas.push(m[2]);
  }
  return shas;
}

// -> { ok: true, detail } or { ok: false, reason }. Never throws.
function checkBranch(git, branch) {
  try {
    git(['rev-parse', '--verify', '--quiet', `origin/${ROLLING_BRANCH}`]);
    git(['rev-parse', '--verify', '--quiet', `origin/${MAIN_BRANCH}`]);
    const ref = `origin/${branch}`;
    const mine = addedHeadings(git, `origin/${MAIN_BRANCH}`, ref);
    if (mine.length) {
      const known = new Set([...headingsInTree(git, `origin/${ROLLING_BRANCH}`), ...headingsInTree(git, `origin/${MAIN_BRANCH}`)]);
      const unique = mine.filter((h) => !known.has(h));
      if (unique.length) return { ok: false, reason: `unique heading: ${unique[0]}` };
    }
    const beyondMain = plusShas(git, `origin/${MAIN_BRANCH}`, ref);
    let uniquePatches = [];
    if (beyondMain.length) {
      const beyondRolling = new Set(plusShas(git, `origin/${ROLLING_BRANCH}`, ref));
      uniquePatches = beyondMain.filter((s) => beyondRolling.has(s));
    }
    if (uniquePatches.length) return { ok: false, reason: `unique patch-id (commit ${uniquePatches[0].slice(0, 12)})` };
    return { ok: true, detail: `snapshot of ${ROLLING_BRANCH}/${MAIN_BRANCH}: ${mine.length} heading(s), ${beyondMain.length} commit(s) all covered` };
  } catch (e) {
    return { ok: false, reason: `git error: ${msg(e)}` };
  }
}

function runRescuedPrune({ git, fs, now = () => new Date(), pipelineDir, taskId = null, env = process.env, recordBranchRemoval, gate, repoRoot, modeOverride, max = MAX_PER_RUN } = {}) {
  void fs; // injected for symmetry with the other sweeps; this module needs no file access of its own
  const mode = modeOverride || resolveMode(env);
  if (mode === 'off') return { mode, results: [] };
  if (mode === 'on' && repoRoot) {
    const sg = require('./sweep-gate.js');
    const answer = (gate || sg.checkGate)({ name: 'rescued-branch-prune', key: repoRoot, paths: sg.refPaths(repoRoot), env });
    if (answer && answer.run === false) return { mode, results: [], skipped: answer.reason };
  }
  const record = recordBranchRemoval || require('./branch-removal-ledger.js').recordBranchRemoval;
  let names;
  try {
    git(['fetch', 'origin', '--prune']);
    const out = git(['for-each-ref', '--format=%(refname)', `refs/remotes/origin/${PREFIX}*`]);
    names = lines(out).map((l) => l.trim().replace(/^refs\/remotes\/origin\//, '')).filter((n) => n.startsWith(PREFIX)).sort();
  } catch (e) {
    return { mode, results: [{ branch: null, verdict: 'needs-work', reason: `git error: ${msg(e)}` }] };
  }
  const results = [];
  let acted = 0;
  for (const branch of names) {
    if (acted >= max) break;
    const check = checkBranch(git, branch);
    if (!check.ok) { results.push({ branch, verdict: 'needs-work', reason: check.reason }); continue; }
    acted++;
    if (mode === 'dry-run') { results.push({ branch, verdict: 'would-delete', reason: check.detail }); continue; }
    try {
      git(['push', 'origin', '--delete', branch]);
    } catch (e) {
      results.push({ branch, verdict: 'needs-work', reason: `push failed: ${msg(e)}` });
      continue;
    }
    record(pipelineDir, { branch, taskId, cause: 'housekeeping', detail: `rescued-branch-prune: ${check.detail}`, actor: 'rescued-branch-prune', now: now() });
    results.push({ branch, verdict: 'deleted', reason: check.detail });
  }
  return { mode, results };
}

module.exports = { runRescuedPrune, resolveMode, checkBranch, MAX_PER_RUN, PREFIX };
