'use strict';

// Agent-run trajectories (2026-10-18, brain-dump 1892 part 1, harness-derived): one gzip JSON
// file per runPlanWithTools() run holding what actually happened -- the message list (system
// prompt, user turns, assistant turns with their tool calls, tool results), each turn's end
// class and usage (the same fields tool-loop-audit.js logs), and the result summary -- so a
// draft can be inspected as a timeline afterwards. Before this, the full message list existed
// only in memory and was dropped on return; task.draftAttempts keeps a tool-call skeleton (no
// arguments, no results) and the 1889 audit keeps per-turn classes with no text.
//
// Files: <pipelineDir>/instances/trajectories/<taskId>/<startedAt>-<stage>-<pid>.json.gz.
// Local only -- they hold task text, the same sensitivity as the task records in queue/.
//
// Size and retention, from the measured run volume (pipeline-history.log context-budget checks,
// 28 active days to 2026-10-18): ~113 agentic runs/day mean, 254 peak; final context p50 ~21k
// tokens, p90 ~32k, max ~49k, i.e. roughly 85-195 KB of text per run before gzip. Each message
// is capped at MAX_MESSAGE_CHARS; files older than the retention window (default 14 days,
// AGENT_MANAGER_TRAJECTORY_RETENTION_DAYS) are pruned at most once an hour.
//
// On by default; AGENT_MANAGER_TRAJECTORY=off (or 0/false) disables it, read at write time.
// Best-effort: a write failure must never break the run.
//
// CLI: node src/trajectory.js list <taskId> [--json] | show <file> [--json]

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const TRAJECTORY_DIRNAME = 'trajectories';
const MAX_MESSAGE_CHARS = 20000;
const DEFAULT_RETENTION_DAYS = 14;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const PRUNE_MARKER = '.last-prune';

function isTrajectoryEnabled() {
  const v = String(process.env.AGENT_MANAGER_TRAJECTORY || '').trim().toLowerCase();
  return !(v === 'off' || v === '0' || v === 'false');
}

function retentionDays() {
  const n = Number(process.env.AGENT_MANAGER_TRAJECTORY_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS;
}

function trajectoriesRoot(pipelineDir) {
  return path.join(pipelineDir, 'instances', TRAJECTORY_DIRNAME);
}

function safeSegment(s, fallback) {
  const v = String(s == null ? '' : s).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 160);
  return v || fallback;
}

function capText(s) {
  if (typeof s !== 'string') return s;
  if (s.length <= MAX_MESSAGE_CHARS) return s;
  return `${s.slice(0, MAX_MESSAGE_CHARS)}\n...[trajectory: truncated ${s.length - MAX_MESSAGE_CHARS} more chars]`;
}

function capMessage(m) {
  if (!m || typeof m !== 'object') return m;
  const out = { role: m.role };
  if (m.final) out.final = true;
  if (m.content != null) out.content = capText(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
  if (typeof m.thinking === 'string') out.thinkingChars = m.thinking.length;
  if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
    out.tool_calls = m.tool_calls.map((c) => {
      const fn = (c && c.function) || {};
      const args = fn.arguments;
      return { name: fn.name || 'unknown', arguments: capText(typeof args === 'string' ? args : JSON.stringify(args == null ? {} : args)) };
    });
  }
  return out;
}

// meta: { taskId, stage, source, lane, model, startedMs, endedMs }. result: the object
// runPlanWithTools returns (its summary fields are kept). runPlanWithTools returns the model's
// final answer (and a forced-summary reply) WITHOUT pushing it onto `messages`, so the final
// response is appended here as an assistant message marked `final: true` -- unless the last
// message already is that reply.
function buildTrajectory({ meta = {}, messages = [], turns = [], result = {} }) {
  const startedMs = meta.startedMs || Date.now();
  const list = Array.isArray(messages) ? messages.slice() : [];
  const last = list[list.length - 1];
  if (typeof result.response === 'string' && result.response
      && !(last && last.role === 'assistant' && last.content === result.response)) {
    list.push({ role: 'assistant', content: result.response, final: true });
  }
  const endedMs = meta.endedMs || Date.now();
  return {
    version: 1,
    taskId: meta.taskId || null,
    stage: meta.stage || null,
    source: meta.source || null,
    lane: meta.lane || null,
    model: meta.model || null,
    startedAt: new Date(startedMs).toISOString(),
    endedAt: new Date(endedMs).toISOString(),
    durationMs: endedMs - startedMs,
    result: {
      responseChars: typeof result.response === 'string' ? result.response.length : null,
      turnsUsed: result.turnsUsed == null ? null : result.turnsUsed,
      forcedSummary: !!result.forcedSummary,
      forcedSummaryReason: result.forcedSummaryReason || null,
      toolsDisabled: !!result.toolsDisabled,
      promptEvalCount: result.prompt_eval_count == null ? null : result.prompt_eval_count,
      evalCount: result.eval_count == null ? null : result.eval_count,
    },
    turns: Array.isArray(turns) ? turns : [],
    messages: list.map(capMessage),
  };
}

function maybePrune(pipelineDir, now = Date.now()) {
  const root = trajectoriesRoot(pipelineDir);
  const marker = path.join(root, PRUNE_MARKER);
  let last = 0;
  try { last = fs.statSync(marker).mtimeMs; } catch { /* never pruned */ }
  if (now - last < PRUNE_INTERVAL_MS) return false;
  try { fs.writeFileSync(marker, new Date(now).toISOString()); } catch { /* best-effort */ }
  pruneTrajectories(pipelineDir, { now });
  return true;
}

// Removes *.json.gz older than the retention window and any task dir left empty. Returns the count removed.
function pruneTrajectories(pipelineDir, { now = Date.now(), days = retentionDays() } = {}) {
  const root = trajectoriesRoot(pipelineDir);
  const cutoff = now - days * 86400000;
  let removed = 0;
  let dirs;
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return 0; }
  for (const d of dirs) {
    const dir = path.join(root, d.name);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.json.gz')) continue;
      const fp = path.join(dir, n);
      try {
        if (fs.statSync(fp).mtimeMs < cutoff) { fs.unlinkSync(fp); removed += 1; }
      } catch { /* raced */ }
    }
    try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch { /* not empty / raced */ }
  }
  return removed;
}

function writeTrajectory(pipelineDir, traj) {
  try {
    if (!pipelineDir || !isTrajectoryEnabled() || !traj) return null;
    const dir = path.join(trajectoriesRoot(pipelineDir), safeSegment(traj.taskId, '_no-task'));
    fs.mkdirSync(dir, { recursive: true });
    const stamp = String(traj.startedAt || new Date().toISOString()).replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const fp = path.join(dir, `${stamp}-${safeSegment(traj.stage, 'run')}-${process.pid}.json.gz`);
    const tmp = `${fp}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, zlib.gzipSync(Buffer.from(JSON.stringify(traj))));
    fs.renameSync(tmp, fp);
    try { maybePrune(pipelineDir); } catch { /* best-effort */ }
    return fp;
  } catch {
    return null; // best-effort -- must never break the run
  }
}

function readTrajectory(file) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
}

// [{ file, startedAt, stage, bytes }] for one task, newest first.
function listTrajectories(pipelineDir, taskId) {
  const dir = path.join(trajectoriesRoot(pipelineDir), safeSegment(taskId, '_no-task'));
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json.gz')); } catch { return []; }
  return names.map((n) => {
    const fp = path.join(dir, n);
    const m = /^(\d{8}T\d{6}Z)-(.+)-\d+\.json\.gz$/.exec(n);
    let bytes = null;
    try { bytes = fs.statSync(fp).size; } catch { /* raced */ }
    return { file: fp, startedAt: m ? m[1] : null, stage: m ? m[2] : null, bytes };
  }).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

module.exports = {
  TRAJECTORY_DIRNAME, MAX_MESSAGE_CHARS, DEFAULT_RETENTION_DAYS, PRUNE_INTERVAL_MS,
  isTrajectoryEnabled, trajectoriesRoot, capMessage, buildTrajectory, writeTrajectory,
  pruneTrajectories, maybePrune, readTrajectory, listTrajectories,
};

if (require.main === module) {
  const [cmd, arg] = process.argv.slice(2);
  const json = process.argv.includes('--json');
  const dir = process.env.AGENT_MANAGER_PIPELINE_DIR || process.env.AGENT_MANAGER_REPO_ROOT || process.cwd();
  if (cmd === 'list' && arg) {
    const rows = listTrajectories(dir, arg);
    if (json) console.log(JSON.stringify(rows, null, 2));
    else for (const r of rows) console.log(`${r.startedAt}  ${String(r.stage).padEnd(16)} ${String(r.bytes).padStart(8)} B  ${r.file}`);
  } else if (cmd === 'show' && arg) {
    const t = readTrajectory(arg);
    if (json) console.log(JSON.stringify(t, null, 2));
    else {
      console.log(`${t.taskId} ${t.stage} ${t.lane || '-'} ${t.model || '-'} ${t.startedAt} (${Math.round(t.durationMs / 1000)} s, ${t.turns.length} turns)`);
      for (const m of t.messages) {
        const calls = m.tool_calls ? ` -> ${m.tool_calls.map((c) => c.name).join(', ')}` : '';
        console.log(`[${m.role}] ${String(m.content || '').replace(/\s+/g, ' ').slice(0, 160)}${calls}`);
      }
    }
  } else {
    console.error('usage: node src/trajectory.js list <taskId> [--json] | show <file> [--json]');
    process.exit(1);
  }
}
