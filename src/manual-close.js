'use strict';

// manual-close.js -- close tasks / candidates whose work a human implemented OUTSIDE the pipeline.
//
// Why (2026-09-19): arch-review-ac-6 and -7 (SearchMode refactor of PF's SearchView.tsx) were hand-implemented in ONE
// commit and merged, and the two blocked task records were hand-archived. The archive left AC-6 in
// queue/done/_archived_no_action/ with no terminalDisposition and no mergedAt, and the hand-written commit carried no
// `Task: <id> (` trailer -- so isDependencySatisfied(arch-review-ac-6) stayed false and AC-7 ("Depends-On: AC-6", but
// already implemented by that same commit) sat ineligible forever. Nothing in the pipeline had a first-class way to say
// "a person did this; here is the commit". The dashboard's Archive button is deliberately a "free the item" action; it
// records no outcome, so an archived dependency is an eternal, silent block.
//
// This is that primitive. For each task id it:
//   1. verifies the given commit is reachable from origin/<default branch> (never trusts a claim it can't check),
//   2. finds the task record (done/, done/_archived_no_action/, done/_archived/<month>/, or a human-waiting queue dir),
//   3. stamps terminalDisposition 'superseded' + a `manualClose` block {commit, note, closedAt} + a history event.
//      'superseded' is the existing "the change is live via a manual edit / parallel change" disposition
//      (task-disposition.js: "A human judgement, never inferred") and is in NO_CODE_COMING_DISPOSITIONS, so
//      isDependencySatisfied() releases dependents. It is NOT stamped `merged`/mergedAt: the task's own branch never landed.
//   4. if no record exists (a candidate that was never tasked) creates a closed one in done/_archived_no_action/, so
//      taskIdExistsInQueue() counts the id as TAKEN and the source never generates it as a duplicate of the manual work.
// Records still in-flight (pending/drafting/review/approved/coordinating) are refused -- a worker may hold them; archive or
// finish them first. Already-`merged` records are left alone (idempotent).
//
// CLI (env as the pipeline gets it, i.e. agent-manager.env loaded):
//   node manual-close.js --commit <sha> [--note "why"] [--dry-run] <task-id> [<task-id> ...]
// Prints one JSON object { ok, commit, results:[...] }.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { appendHistoryEvent } = require('./task-history.js');
const { detectDefaultBranch } = require('./git-runner.js');

const CLOSABLE_LIVE_STATES = ['blocked', 'needs-clarification', 'awaiting-confirm'];
const IN_PIPELINE_STATES = ['pending', 'drafting', 'review', 'approved', 'coordinating'];
const ALREADY_LANDED = new Set(['merged', 'applied-direct']);

function realGit(repoRoot, args) {
  return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 }).trim();
}

// -> { ok, sha } | { ok:false, error }. The commit must exist and be an ancestor of origin/<default>.
function verifyCommitOnMain(repoRoot, commit, git = realGit) {
  if (!commit || !/^[0-9a-fA-F]{4,40}$/.test(commit)) return { ok: false, error: `not a commit sha: '${commit}'` };
  let sha;
  try { sha = git(repoRoot, ['rev-parse', '--verify', `${commit}^{commit}`]); } catch { return { ok: false, error: `commit ${commit} not found in ${repoRoot} (fetch first?)` }; }
  let main;
  try { main = detectDefaultBranch(repoRoot); } catch { main = 'main'; }
  try { git(repoRoot, ['merge-base', '--is-ancestor', sha, `origin/${main}`]); } catch {
    return { ok: false, error: `commit ${sha.slice(0, 10)} is not on origin/${main} -- merge it first; refusing to mark work implemented that has not landed` };
  }
  return { ok: true, sha };
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

function writeJsonAtomic(p, data) {
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

// -> { state, file } | null. done/ first (a stamped record there is authoritative), then the archives, then live queues.
function locateRecord(pipelineDir, id) {
  const q = path.join(pipelineDir, 'queue');
  const fixed = [['done', path.join(q, 'done', `${id}.json`)], ['archived', path.join(q, 'done', '_archived_no_action', `${id}.json`)]];
  try {
    const months = path.join(q, 'done', '_archived');
    for (const m of fs.readdirSync(months)) fixed.push(['archived', path.join(months, m, `${id}.json`)]);
  } catch { /* no month archives */ }
  for (const state of [...CLOSABLE_LIVE_STATES, ...IN_PIPELINE_STATES]) {
    fixed.push([state, path.join(q, state, `${id}.json`)]);
    if (state === 'drafting') {
      try {
        for (const e of fs.readdirSync(path.join(q, 'drafting'), { withFileTypes: true })) if (e.isDirectory()) fixed.push(['drafting', path.join(q, 'drafting', e.name, `${id}.json`)]);
      } catch { /* none */ }
    }
  }
  for (const [state, file] of fixed) if (fs.existsSync(file)) return { state, file };
  return null;
}

// arch-review-ac-7 -> { source:'arch_review', candidateId:'AC-7' }; anything else -> null (a record must already exist).
function candidateIdentity(id) {
  const m = /^(.+)-ac-(\d+)$/.exec(id);
  return m ? { source: m[1].replace(/-/g, '_'), candidateId: `AC-${m[2]}` } : null;
}

function closeOne({ pipelineDir, id, sha, note, dryRun, now }) {
  const found = locateRecord(pipelineDir, id);
  const stamp = { commit: sha, note: note || null, closedAt: now.toISOString(), closedBy: 'manual-close.js' };
  const detail = `implemented outside the pipeline by commit ${sha.slice(0, 10)} (on origin/<main>)${note ? ` -- ${note}` : ''}`;
  const archivedDir = path.join(pipelineDir, 'queue', 'done', '_archived_no_action');

  if (!found) {
    const ident = candidateIdentity(id);
    if (!ident) return { id, ok: false, error: 'no task record found, and the id is not a candidate id (<source>-ac-N) so a closed record cannot be created for it' };
    if (dryRun) return { id, ok: true, action: 'would-create', to: 'archived' };
    const rec = {
      id, domain: 'default', source: ident.source, title: `${ident.candidateId} (implemented manually)`,
      promptContext: JSON.stringify({ candidateId: ident.candidateId }), status: 'done', createdAt: stamp.closedAt,
      terminalDisposition: 'superseded', manualClose: stamp, history: [],
    };
    appendHistoryEvent(rec, 'created', 'closed record created by manual-close.js -- the candidate was never tasked');
    appendHistoryEvent(rec, 'superseded', detail);
    fs.mkdirSync(archivedDir, { recursive: true });
    writeJsonAtomic(path.join(archivedDir, `${id}.json`), rec);
    return { id, ok: true, action: 'created', to: 'archived' };
  }

  if (IN_PIPELINE_STATES.includes(found.state)) {
    return { id, ok: false, error: `task is in ${found.state}/ -- a worker may hold it; archive or finish it first` };
  }
  const rec = readJson(found.file);
  if (!rec) return { id, ok: false, error: `unreadable task record ${found.file}` };
  if (ALREADY_LANDED.has(rec.terminalDisposition)) return { id, ok: true, action: 'already-landed', disposition: rec.terminalDisposition, state: found.state };
  if (rec.terminalDisposition === 'superseded' && rec.manualClose) return { id, ok: true, action: 'already-closed', state: found.state };

  const dest = CLOSABLE_LIVE_STATES.includes(found.state) ? path.join(archivedDir, `${id}.json`) : found.file;
  if (dryRun) return { id, ok: true, action: 'would-stamp', from: found.state, to: dest === found.file ? found.state : 'archived', previousDisposition: rec.terminalDisposition || null };
  const previous = rec.terminalDisposition || null;
  rec.terminalDisposition = 'superseded';
  rec.manualClose = stamp;
  // A record stamped 'merged' by an earlier sweep would have hit ALREADY_LANDED above; anything else carried stale merge stamps
  // only by bug (fix_stale_disposition.py) -- never leave mergedAt on a non-merged disposition.
  delete rec.mergedAt; delete rec.mergedAtSource;
  appendHistoryEvent(rec, 'superseded', detail);
  if (dest !== found.file) {
    fs.mkdirSync(archivedDir, { recursive: true });
    if (fs.existsSync(dest)) return { id, ok: false, error: `${dest} already exists` };
    writeJsonAtomic(dest, rec);
    fs.unlinkSync(found.file);
  } else {
    writeJsonAtomic(found.file, rec);
  }
  return { id, ok: true, action: 'stamped', from: found.state, to: dest === found.file ? found.state : 'archived', previousDisposition: previous };
}

function closeAsImplemented({ pipelineDir, repoRoot, ids, commit, note = null, dryRun = false, git = realGit, now = new Date() }) {
  if (!pipelineDir || !repoRoot) return { ok: false, error: 'pipelineDir and repoRoot are required' };
  if (!Array.isArray(ids) || !ids.length) return { ok: false, error: 'no task ids given' };
  const v = verifyCommitOnMain(repoRoot, commit, git);
  if (!v.ok) return { ok: false, error: v.error };
  const results = ids.map((id) => closeOne({ pipelineDir, id: String(id).trim(), sha: v.sha, note, dryRun, now }));
  return { ok: results.every((r) => r.ok), commit: v.sha, dryRun, results };
}

function parseArgs(argv) {
  const out = { ids: [], note: null, commit: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--commit') out.commit = argv[++i];
    else if (argv[i] === '--note') out.note = argv[++i];
    else if (argv[i] === '--dry-run') out.dryRun = true;
    else out.ids.push(argv[i]);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.commit || !args.ids.length) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'Usage: node manual-close.js --commit <sha> [--note why] [--dry-run] <task-id> [...]' })}\n`);
    process.exit(1);
  }
  const { getConfig } = require('./config.js');
  const { pipelineDir, repoRoot } = getConfig();
  const result = closeAsImplemented({ pipelineDir, repoRoot, ...args });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exit(2);
}

module.exports = { closeAsImplemented, verifyCommitOnMain, locateRecord, candidateIdentity };

if (require.main === module) main();
