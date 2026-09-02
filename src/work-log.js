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
    doc.tiers.push({
      tier: tier || 'unknown',
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
    try { files = fs.readdirSync(dir); } catch { return { pruned: 0 }; }
    let pruned = 0;
    for (const f of files) {
      if (!f.endsWith('.json') || f.includes('.tmp-')) continue;
      const id = f.slice(0, -5);
      if (!taskIsLive(queueRoot, id)) {
        try { fs.unlinkSync(path.join(dir, f)); pruned += 1; } catch { /* raced */ }
      }
    }
    return { pruned };
  } catch { return { pruned: 0 }; }
}

module.exports = { appendTierWorkLog, readWorkLog, pruneWorkLogs, worklogDir, worklogPath };

// CLI: node work-log.js --prune   (used by scripts/apply-task.sh once per tick)
if (require.main === module) {
  if (process.argv[2] === '--prune') {
    const { pruned } = pruneWorkLogs();
    process.stdout.write(JSON.stringify({ pruned }));
  }
}
