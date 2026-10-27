'use strict';

// Per-task work log: the full tool-call transcript of a multi-turn agentic draft tier,
// written to queue/worklogs/<task_id>.json so a human can audit exactly what the model
// read, searched, ran, and edited BEFORE approving/merging its output.
//
// Why a sidecar and not draft-attempt-record.js's own tier record: that record is kept on
// task.draftAttempts inside the task file, forever, for every attempt -- so it deliberately
// keeps only a summary (tool name + arg KEYS + result byte size). summariseToolCalls()
// there strips every arg VALUE ("never their values, which hold file paths / edit bodies /
// shell commands"), which is exactly the information an auditor needs. Bloating the task
// file with full transcripts was the 244KB-task-file failure mode (see task-history.js's
// collapse comment). A sidecar keyed by task id is lazily loaded by the dashboard only
// when a task is opened, capped in size, and kept for as long as the task file itself sits
// in queue/ -- including queue/done/ top-level (2026-09-01, Grimmethy: "I want to be able
// to see the work logs in done tasks"). It is pruned only once done-archive.js rotates the
// task file out of queue/done/ into queue/done/_archived/<YYYY-MM>/ (default 30 days) or a
// human archives it to _archived_no_action/ -- at which point taskIsLive() no longer sees
// it and the next pruneWorkLogs() pass deletes it. That rotation IS the size bound; there
// is no separate retention timer here.
//
// Best-effort throughout: a worklog write or prune must NEVER break or slow a real draft.

const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config.js');
const { appendHistoryEvent } = require('./task-history.js');

const ARG_VALUE_CAP = 4000;        // per individual arg value (grep queries, edit bodies, bash commands)
const RESULT_PREVIEW_CAP = 2000;   // per tool-call result preview
const FILE_BYTE_CAP = 1_000_000;   // whole-worklog ceiling; older tiers' call bodies are dropped first

// Queue dirs whose tasks keep their worklog. 'adhoc' matters specifically: reject-retry-
// check.js requeues a retryable adhoc draft block to queue/adhoc/ (not pending/), so
// without it here pruneWorkLogs deleted the tier-3 transcript on the very next tick.
// 'done' (top-level only -- taskIsLive's existsSync does not descend into
// done/_archived/<month>/ or done/_archived_no_action/) keeps the transcript visible in
// the dashboard for a merged task until done-archive.js rotates it out; see the header.
const LIVE_QUEUE_DIRS = ['pending', 'adhoc', 'review', 'approved', 'blocked', 'needs-clarification', 'awaiting-confirm', 'done'];

function worklogDir(pipelineDir) {
  return path.join(pipelineDir || getConfig().pipelineDir, 'queue', 'worklogs');
}

function worklogPath(taskId, pipelineDir) {
  return path.join(worklogDir(pipelineDir), `${taskId}.json`);
}

function capString(s, cap) {
  if (typeof s !== 'string') return s;
  return s.length > cap ? `${s.slice(0, cap)}…[+${s.length - cap} more chars]` : s;
}

// One tool-call entry ({ tool, args, result }) -> an auditable-but-bounded shape.
function shapeCall(entry, n) {
  const tool = (entry && entry.tool) || 'unknown';
  const args = {};
  if (entry && entry.args && typeof entry.args === 'object') {
    for (const [k, v] of Object.entries(entry.args)) {
      let s;
      try { s = typeof v === 'string' ? v : JSON.stringify(v); } catch { s = String(v); }
      args[k] = capString(s, ARG_VALUE_CAP);
    }
  }
  const result = entry && entry.result;
  let resultBytes = 0;
  try { resultBytes = JSON.stringify(result == null ? '' : result).length; } catch { resultBytes = -1; }
  const isError = !!(result && typeof result === 'object' && result.error);
  const call = { n, tool, args, resultBytes };
  try {
    const rs = typeof result === 'string' ? result : JSON.stringify(result);
    if (rs) call.resultPreview = capString(rs, RESULT_PREVIEW_CAP);
  } catch { /* unserialisable result -- byte size + error flag still recorded */ }
  if (isError) call.error = true;
  return call;
}

function slimTier(tier) {
  return {
    ...tier,
    truncated: true,
    calls: (tier.calls || []).map((c) => ({ n: c.n, tool: c.tool, resultBytes: c.resultBytes, ...(c.error ? { error: true } : {}) })),
  };
}

// Append one tier's full tool transcript to the task's worklog. No-op when there is no
// tool activity to record. `pipelineDir` is resolved from config when omitted.
function appendTierWorkLog(task, { tier, turnsUsed, toolCallLog, finalMessage } = {}, pipelineDir) {
  try {
    if (!task || !task.id) return;
    if (!Array.isArray(toolCallLog) || toolCallLog.length === 0) return;

    const dir = worklogDir(pipelineDir);
    fs.mkdirSync(dir, { recursive: true });
    const p = worklogPath(task.id, pipelineDir);

    let doc;
    try { doc = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`[work-log] failed to read prior worklog for task ${task.id} at ${p}: ${err.message}; starting a fresh document`);
      }
      doc = null;
    }
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.tiers)) doc = { taskId: task.id, tiers: [] };
    doc.taskId = task.id;
    doc.updatedAt = new Date().toISOString();
    // attemptStart scopes a tier to its DRAFT ATTEMPT (2026-10-26, stale-worklog task): it is
    // the task's latest 'draft-started' history event -- the same key get-grounding-source.js's
    // tiersOfCurrentAttempt() already treats as "an attempt began" -- so a worklog carrying
    // several attempts can be filtered to just the current one by marker alone. Fallbacks keep
    // the value stable within a requeue's attempt: a prior tier's own marker, else the entry's
    // write time. A log written before this field existed carries no marker at all, and the
    // grounding side (tiersOfLatestMarkedAttempt) keeps EVERY unmarked entry -- today's behaviour.
    let attemptStart = null;
    for (const h of Array.isArray(task.history) ? task.history : []) {
      if (h && h.stage === 'draft-started') {
        const t = Date.parse(h.at);
        if (Number.isFinite(t)) attemptStart = new Date(t).toISOString();
      }
    }
    if (!attemptStart) {
      const prior = (doc.tiers || []).filter((t) => t && t.attemptStart).pop();
      attemptStart = prior ? prior.attemptStart : new Date().toISOString();
    }
    doc.tiers.push({
      tier: tier || 'unknown',
      attemptStart,
      at: new Date().toISOString(),
      turnsUsed: turnsUsed != null ? turnsUsed : null,
      callCount: toolCallLog.length,
      calls: toolCallLog.map((e, i) => shapeCall(e, i + 1)),
      ...(typeof finalMessage === 'string' && finalMessage.trim()
        ? { finalMessage: capString(finalMessage, ARG_VALUE_CAP) }
        : {}),
    });

    let out = JSON.stringify(doc, null, 2);
    for (let i = 0; i < doc.tiers.length && out.length > FILE_BYTE_CAP; i += 1) {
      if (!doc.tiers[i].truncated) {
        doc.tiers[i] = slimTier(doc.tiers[i]);
        out = JSON.stringify(doc, null, 2);
      }
    }

    const tmp = `${p}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, out);
    fs.renameSync(tmp, p);
  } catch { /* best-effort: never break a draft over a worklog */ }
}

// One structured audit event per archive, readable out of any log capture: task id,
// both filenames, the moment it happened. This is what makes a WRONGLY-archived log
// discoverable after the fact (2026-10-26, stale-worklog task) -- the rename itself
// leaves no trace anywhere else.
function auditWorklogArchive({ taskId, from, to, at, reason }) {
  const ev = { event: 'worklog-archived', taskId: String(taskId ?? ''), from: from ?? null, to: to ?? null, at, reason: reason ?? null };
  try { console.log(JSON.stringify(ev)); } catch { /* audit must never throw */ }
  return ev;
}

// Archive the task's LIVE worklog as <id>.attempt-N.json in the SAME worklogs/ dir
// (N = highest existing attempt number for this task + 1, so repeated requeues stack:
// attempt-1, attempt-2, ...). The file is RENAMED, never deleted -- the audit trail and
// the dashboard's archived-attempt view both keep working. Best-effort like everything
// else here: no live log (non-agentic task) or a failed rename is a no-op, never an error.
function archiveWorkLog(taskId, { pipelineDir, reason } = {}) {
  if (!taskId) return null;
  try {
    const dir = worklogDir(pipelineDir);
    const live = worklogPath(taskId, pipelineDir);
    if (!fs.existsSync(live)) return null; // nothing to archive -- no error.
    const escaped = String(taskId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^${escaped}\\.attempt-(\\d+)\\.json$`);
    let maxN = 0;
    try {
      for (const f of fs.readdirSync(dir)) {
        const m = f.match(re);
        if (m) maxN = Math.max(maxN, Number(m[1]));
      }
    } catch { /* dir missing is covered by the existsSync(live) check above */ }
    const n = maxN + 1;
    const archived = path.join(dir, `${taskId}.attempt-${n}.json`);
    let doc = null;
    try { doc = JSON.parse(fs.readFileSync(live, 'utf8')); } catch { /* keep the bytes as-is on rename */ }
    if (doc && typeof doc === 'object') {
      doc.archivedAt = new Date().toISOString();
      doc.archiveReason = reason || null;
      fs.writeFileSync(live, JSON.stringify(doc, null, 2));
    }
    fs.renameSync(live, archived);
    const at = new Date().toISOString();
    auditWorklogArchive({ taskId, from: live, to: archived, at, reason });
    return { taskId, from: live, to: archived, n, at, reason: reason || null };
  } catch (err) {
    console.warn(`[work-log] archiveWorkLog failed for ${taskId}: ${err.message}`);
    return null;
  }
}

// Requeue-for-redraft / decompose-parent entry points call this: archive the just-finished
// attempt's worklog (rename, readable, same dir) AND record a structured history event on
// the task itself when the task object is at hand -- the two surfaces of the same audit
// event. Passing no `task` (callers that only know the id) still archives and logs the
// console event.
function archiveTaskWorkLog(task, pipelineDir, reason) {
  const res = archiveWorkLog(task && task.id ? task.id : task, { pipelineDir, reason });
  if (res && task && typeof task === 'object') {
    try {
      appendHistoryEvent(task, 'worklog-archived',
        `attempt ${res.n} worklog archived to ${path.basename(res.to)} (reason: ${res.reason || 'requeue'}); ${res.tiers ?? ''}`.trim());
    } catch { /* history must never break a requeue */ }
  }
  return res;
}

function readWorkLog(taskId, pipelineDir) {
  try { return JSON.parse(fs.readFileSync(worklogPath(taskId, pipelineDir), 'utf8')); } catch { return null; }
}

function taskIsLive(queueRoot, id) {
  for (const d of LIVE_QUEUE_DIRS) {
    if (fs.existsSync(path.join(queueRoot, d, `${id}.json`))) return true;
  }
  try {
    const draftingRoot = path.join(queueRoot, 'drafting');
    for (const sub of fs.readdirSync(draftingRoot)) {
      if (fs.existsSync(path.join(draftingRoot, sub, `${id}.json`))) return true;
    }
  } catch { /* no drafting/ dir */ }
  return false;
}

// Delete worklogs whose task has left the live queue dirs (rotated out of queue/done/ by
// done-archive.js, human-archived, or gone). Cheap: one readdir + a handful of existsSync
// per orphan. Safe to call every draft.
function pruneWorkLogs(pipelineDir) {
  try {
    const root = pipelineDir || getConfig().pipelineDir;
    const dir = worklogDir(root);
    const queueRoot = path.join(root, 'queue');
    let files;
    try { files = fs.readdirSync(dir); } catch (err) { if (err.code !== 'ENOENT') console.error(`pruneWorkLogs: readdir failed for ${dir} [${err.code}]: ${err.message}`); return { pruned: 0 }; }
    const liveSet = new Set();
    for (const d of LIVE_QUEUE_DIRS) {
      try {
        for (const entry of fs.readdirSync(path.join(queueRoot, d))) {
          if (entry.endsWith('.json')) liveSet.add(entry.slice(0, -5));
        }
      } catch { /* dir may not exist */ }
    }
    try {
      const draftingRoot = path.join(queueRoot, 'drafting');
      for (const sub of fs.readdirSync(draftingRoot)) {
        for (const entry of fs.readdirSync(path.join(draftingRoot, sub))) {
          if (entry.endsWith('.json')) liveSet.add(entry.slice(0, -5));
        }
      }
    } catch { /* no drafting/ dir */ }
    let pruned = 0;
    for (const f of files) {
      if (!f.endsWith('.json') || f.includes('.tmp-')) continue;
      // Derive the base task id: strip .attempt-<N> if present, then strip .json.
      // A worklog file is either <id>.json or <id>.attempt-<N>.json; both must be
      // cleaned up when the task is no longer live.
      let baseId;
      const attemptMatch = f.match(/^(.+)\\.attempt-\\d+\\.json$/);
      if (attemptMatch) {
        baseId = attemptMatch[1];
      } else {
        baseId = f.slice(0, -5);
      }
      if (!liveSet.has(baseId)) {
        try { fs.unlinkSync(path.join(dir, f)); pruned += 1; } catch (err) { if (err.code !== 'ENOENT') console.error(`pruneWorkLogs: unlink failed for ${path.join(dir, f)} [${err.code}]: ${err.message}`); }
      }
    }
    return { pruned };
  } catch (err) { console.error(`pruneWorkLogs: unexpected error: ${err.message}`, err.stack); return { pruned: 0 }; }
}

module.exports = { appendTierWorkLog, readWorkLog, pruneWorkLogs, worklogDir, worklogPath, archiveWorkLog, archiveTaskWorkLog };

// CLI: node work-log.js --prune   (used by scripts/apply-task.sh once per tick)
if (require.main === module) {
  if (process.argv[2] === '--prune') {
    const { pruned } = pruneWorkLogs();
    process.stdout.write(JSON.stringify({ pruned }));
  }
}
