'use strict';

// Chat's four task-unstick primitives (2026-09-15, Grimmethy: "The chat's job is to
// interact with the user to help get these blocked tasks unstuck. If it can't do that
// it won't be able to properly do its job."). Node-side ports of the four existing
// human-facing Flask routes in python/dashboard/routes/task.py -- same reasoning
// task-anywhere.js's own header already gives for why this is a duplicate Node
// implementation rather than a subprocess shell-out: local-tool-client.js's tool
// handlers run in-process (no HTTP hop), and this is stable, simple, fixed-order
// directory-move logic with low drift risk, not business logic worth cross-language
// sharing effort for.
//
// Every exported function returns { ok: true, ... } or { ok: false, error, ... } --
// NEVER throws for an expected failure (task not found, already moved, dest collision,
// invalid input). Chat's tool handler hands this straight back as the tool result, and
// a conversational agent needs a clean, relayable message, not a stack trace.
//
// Field lists/history-entry shapes below are copied byte-for-byte from the Python
// routes they mirror (cited per function) so behavior is identical regardless of
// whether a human clicked a dashboard button or Chat called the tool -- including two
// real asymmetries in the originals (resolve/ appends no history entry; the done/
// history entry uses a `status` key where every other one uses `stage`) that are
// replicated deliberately, not "fixed" here.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { classifyRequeue } = require('./requeue-attribution.js');
const { recordBranchRemoval } = require('./branch-removal-ledger.js');

function readJsonSafe(fullPath) {
  try {
    return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  } catch {
    return null;
  }
}

// Scoped, single-directory lookup returning the actual file PATH (not parsed content --
// every caller here needs to write/rename the file, unlike task-anywhere.js's
// findTaskAnywhere, which is read-only and searches broadly across every state).
function findAt(pipelineDir, state, taskId) {
  const p = path.join(pipelineDir, 'queue', state, `${taskId}.json`);
  const data = readJsonSafe(p);
  return data ? { path: p, data } : null;
}

// Same dated-month-bucket scan as task-anywhere.js's findTaskAnywhere and
// python/dashboard/routes/task.py's api_task_requeue -- 'archived' is a pseudo-state,
// not a real queue/ directory name: done/_archived_no_action/ first, then
// done/_archived/<YYYY-MM>/ (any month).
function findArchived(pipelineDir, taskId) {
  const noAction = findAt(pipelineDir, path.join('done', '_archived_no_action'), taskId);
  if (noAction) return noAction;
  const archivedRoot = path.join(pipelineDir, 'queue', 'done', '_archived');
  let months = [];
  try {
    months = fs.readdirSync(archivedRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { /* no archive at all yet -- not found */ }
  for (const month of months) {
    const found = findAt(pipelineDir, path.join('done', '_archived', month), taskId);
    if (found) return found;
  }
  return null;
}

function notFoundError(taskId, expectedState) {
  return {
    ok: false,
    error: `Task '${taskId}' isn't in ${expectedState}/ right now -- it may have already `
      + 'been resolved, or the id is wrong. Use read_task to check its current state.',
  };
}

function collisionError(taskId, destState) {
  return {
    ok: false,
    error: `Task '${taskId}' already has a task in ${destState}/ -- it may have already `
      + 'been requeued. Use read_task to check its current state.',
  };
}

function nowIso() {
  return new Date().toISOString();
}

function writeAndUnlink(destPath, data, srcPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, JSON.stringify(data, null, 2), 'utf8');
  fs.unlinkSync(srcPath);
}

// classifyRequeue's own fallback-model path is skipped here for the same reason
// python/dashboard/requeue_attribution_client.py's Flask-subprocess CLI path already
// skips it (see requeue-attribution.js's own header on skipFallbackModel): Chat's whole
// turn already holds the GPU's 'interactive' priority marker for its entire run (see
// runPlanWithTools' turnLock/CHAT_IS_INTERACTIVE) -- a second, nested model call from
// inside a tool handler mid-turn is exactly the GPU contention this flag exists to
// avoid, not a hypothetical.
async function classifyBestEffort(task, opts) {
  try {
    await classifyRequeue(task, { ...opts, requeueWriter: 'chat-tool-client', actor: 'agent-session', skipFallbackModel: true });
  } catch {
    // best-effort, same contract every other classifyRequeue call site in this
    // codebase already holds itself to -- telemetry must never break the real move.
  }
}

// Mirrors api_task_answer_clarification, python/dashboard/routes/task.py:406-454.
async function answerNeedsClarification(pipelineDir, taskId, answer) {
  if (typeof taskId !== 'string' || !taskId.trim()) {
    return { ok: false, error: 'taskId is required' };
  }
  const trimmed = typeof answer === 'string' ? answer.trim() : '';
  if (!trimmed) {
    return { ok: false, error: 'answer is required and must be non-empty' };
  }
  const found = findAt(pipelineDir, 'needs-clarification', taskId);
  if (!found) return notFoundError(taskId, 'needs-clarification');
  const { path: srcPath, data } = found;

  data.promptContext = data.promptContext || {};
  const prior = data.promptContext.rawText || '';
  data.promptContext.rawText = prior
    + `\n\nHUMAN DESIGN DECISION (answered directly from Chat, ${nowIso()}):\n${trimmed}\n`
    + 'This answer resolves the open question(s) above -- implement against it directly rather than re-asking for clarification.';
  delete data.needsClarification;
  data.history = data.history || [];
  data.history.push({
    stage: 'needs-clarification-resolved', at: nowIso(),
    detail: 'Answered via Chat -- requeued to adhoc/ for a fresh draft pass.',
  });

  const destPath = path.join(pipelineDir, 'queue', 'adhoc', `${taskId}.json`);
  if (fs.existsSync(destPath)) return collisionError(taskId, 'adhoc');
  writeAndUnlink(destPath, data, srcPath);
  await classifyBestEffort(data, { reasonHint: `needs-clarification answered via Chat: ${trimmed.slice(0, 200)}` });
  return { ok: true, id: taskId };
}

// Mirrors api_task_resolve_clarification, task.py:370-403. Deliberately appends NO
// history entry, matching the Python original's own asymmetry with the answer/ route.
async function resolveNeedsClarification(pipelineDir, taskId, paths) {
  if (typeof taskId !== 'string' || !taskId.trim()) {
    return { ok: false, error: 'taskId is required' };
  }
  const found = findAt(pipelineDir, 'needs-clarification', taskId);
  if (!found) return notFoundError(taskId, 'needs-clarification');
  const { path: srcPath, data } = found;

  let prefetchedPaths;
  if (Array.isArray(paths) && paths.length) {
    prefetchedPaths = paths.map(String);
    data.promptContext = data.promptContext || {};
    data.promptContext.prefetchedPaths = prefetchedPaths;
  }
  delete data.needsClarification;

  const destPath = path.join(pipelineDir, 'queue', 'adhoc', `${taskId}.json`);
  if (fs.existsSync(destPath)) return collisionError(taskId, 'adhoc');
  writeAndUnlink(destPath, data, srcPath);
  await classifyBestEffort(data, { reasonHint: 'needs-clarification resolved via Chat file-path picker' });
  return { ok: true, id: taskId, prefetchedPaths };
}

// Mirrors api_task_mark_done_clarification, task.py:457-489. Terminal -- does NOT
// requeue, and (matching the original) never calls classifyRequeue.
async function markNeedsClarificationDone(pipelineDir, taskId) {
  if (typeof taskId !== 'string' || !taskId.trim()) {
    return { ok: false, error: 'taskId is required' };
  }
  const found = findAt(pipelineDir, 'needs-clarification', taskId);
  if (!found) return notFoundError(taskId, 'needs-clarification');
  const { path: srcPath, data } = found;

  data.doneMarker = 'marked done via Chat from Needs Clarification';
  data.history = data.history || [];
  // `status`, not `stage` -- an inconsistency in the original route this ports
  // (task.py:483-485), replicated exactly since some consumer may already key on it.
  data.history.push({ status: 'done', at: nowIso(), note: 'manually marked done from needs-clarification/ (via Chat)' });

  const destPath = path.join(pipelineDir, 'queue', 'done', `${taskId}.json`);
  if (fs.existsSync(destPath)) return collisionError(taskId, 'done');
  writeAndUnlink(destPath, data, srcPath);
  return { ok: true, id: taskId };
}

// Same word/symbol-overlap heuristic as python/dashboard/app.py's
// _repeated_blocker_match + _quoted_symbols/_significant_words/_jaccard
// (app.py:1581-1640) -- best-effort, approximate: a missed match just means no warning,
// a false-positive costs one extra confirm (force:true), never blocks a requeue outright.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'to', 'of', 'for', 'and', 'or', 'in', 'on', 'with', 'is', 'are',
  'this', 'that', 'it', 'be', 'as', 'at', 'by', 'from', 'into', 'not', 'but', 'its',
  'was', 'were', 'has', 'have', 'had', 'do', 'does', 'did',
]);
const QUOTED_SYMBOL_RE = /`([^`]{3,60})`/g;
const REPEATED_BLOCKER_THRESHOLD = 0.3;

function significantWords(text) {
  const out = new Set();
  for (const w of String(text || '').toLowerCase().match(/[a-z0-9_]+/g) || []) {
    if (w.length > 2 && !STOPWORDS.has(w)) out.add(w);
  }
  return out;
}

function quotedSymbols(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(QUOTED_SYMBOL_RE)) {
    const s = m[1].trim();
    if (s) out.add(s);
  }
  return out;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union ? intersection / union : 0;
}

function repeatedBlockerMatch(task) {
  const currentReason = task.blockedReason || '';
  if (!currentReason) return null;
  const currentSymbols = quotedSymbols(currentReason);
  const currentWords = significantWords(currentReason);
  let best = null;
  for (const prior of task.priorRejectionFeedback || []) {
    const priorText = prior || '';
    const priorSymbols = quotedSymbols(priorText);
    for (const s of currentSymbols) {
      if (priorSymbols.has(s)) return priorText;
    }
    const score = jaccard(currentWords, significantWords(priorText));
    if (score >= REPEATED_BLOCKER_THRESHOLD && (!best || score > best[1])) {
      best = [priorText, score];
    }
  }
  return best ? best[0] : null;
}

// Mirrors api_task_requeue, task.py:188-367 (state ∈ blocked/done/archived -> pending),
// the most complex of the four -- repeated-blocker guard, superseded-branch abandonment,
// and the exact fresh-record field allowlist, all ported.
async function requeueBlockedTask(pipelineDir, repoRoot, taskId, { state, force = false } = {}) {
  if (typeof taskId !== 'string' || !taskId.trim()) {
    return { ok: false, error: 'taskId is required' };
  }
  if (!['blocked', 'done', 'archived'].includes(state)) {
    return { ok: false, error: 'state must be one of "blocked", "done", or "archived"' };
  }
  const found = state === 'archived' ? findArchived(pipelineDir, taskId) : findAt(pipelineDir, state, taskId);
  if (!found) return notFoundError(taskId, state === 'archived' ? 'done/_archived*' : state);
  const { path: srcPath, data } = found;

  if (state === 'blocked' && !force) {
    const repeat = repeatedBlockerMatch(data);
    if (repeat) {
      return {
        ok: false,
        error: "This task's rejection looks like the same underlying problem as an earlier "
          + `attempt: "${repeat.slice(0, 220)}" -- redrafting alone hasn't fixed this before `
          + 'and likely will not now without a real change. Tell the human this before '
          + 'retrying with force:true -- do not silently force it yourself.',
        repeatedBlocker: repeat,
      };
    }
  }

  // Superseded-branch abandonment (task.py:269-313, a real 2026-09-13 incident: a
  // requeue silently orphaned the prior unmerged branch, left pushed to GitHub forever
  // with no record anywhere that a later attempt superseded it).
  if (data.terminalDisposition !== 'merged') {
    let appliedBranch = null;
    for (const ev of [...(data.history || [])].reverse()) {
      if (ev && ev.stage === 'applied' && ev.detail) { appliedBranch = ev.detail; break; }
    }
    if (appliedBranch && repoRoot) {
      try {
        execFileSync('git', ['push', 'origin', '--delete', appliedBranch], { cwd: repoRoot, stdio: 'pipe' });
        recordBranchRemoval(pipelineDir, { branch: appliedBranch, taskId: data.id, cause: 'superseded-by-requeue', detail: `requeued from ${state}/`, actor: 'chat-requeue' });
      } catch {
        // Non-fatal, same reasoning as the Python route's own try/except: already gone,
        // never actually pushed, or a transient network error are all fine -- the
        // requeue itself must not fail here. (No cross-process branch-cache to
        // invalidate from this Node subprocess -- the dashboard's own cache has a TTL
        // and will pick up the deletion on its next natural refresh.)
      }
      data.history = data.history || [];
      data.history.push({
        stage: 'abandoned', at: nowIso(),
        detail: `superseded by a manual requeue from ${state}/ (via Chat); prior branch ${appliedBranch} deleted`,
      });
      data.terminalDisposition = 'abandoned';
    }
  }

  const destPath = path.join(pipelineDir, 'queue', 'pending', `${taskId}.json`);
  if (fs.existsSync(destPath)) return collisionError(taskId, 'pending');

  const history = Array.isArray(data.history) ? [...data.history] : [];
  history.push({
    stage: 'requeued', at: nowIso(), note: `manually requeued from ${state}/ (via Chat)`,
    blockedReasonAtRequeue: data.blockedReason,
    priorRejectionFeedbackAtRequeue: data.priorRejectionFeedback,
  });
  const fresh = {
    id: data.id || taskId,
    domain: data.domain,
    source: data.source,
    title: data.title,
    promptContext: data.promptContext,
    status: 'pending',
    createdAt: data.createdAt || nowIso(),
    history,
  };
  // Coordination fields -- never part of the drafting/review/apply history this reset
  // clears, always carried over verbatim when present (see task.py's own docstring on
  // two real incidents this allowlist protects against).
  for (const key of ['stacked', 'dependsOn', 'atomic', 'noDecompose']) {
    if (key in data) fresh[key] = data[key];
  }

  writeAndUnlink(destPath, fresh, srcPath);
  await classifyBestEffort(data, { reasonHint: `manually requeued from ${state}/ via Chat` });
  return { ok: true, id: taskId };
}

module.exports = {
  answerNeedsClarification, resolveNeedsClarification, markNeedsClarificationDone, requeueBlockedTask,
  repeatedBlockerMatch, // exported for direct unit testing
};
