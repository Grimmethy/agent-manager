'use strict';

// Tool-loop audit (2026-10-18, brain-dump 1889, harness-derived): one NDJSON line per
// runPlanWithTools() model turn ('turn-end': how the turn ended) and one per
// edit_file/write_file call ('tool-outcome': what class of result it got). Measurement
// only -- nothing here feeds back into the loop. It exists because the two follow-ups
// that want to change the loop (tiered edit_file matching, continuation nudges keyed on
// how a turn ended) were filed to wait on real numbers, and neither number existed:
// task.draftAttempts keeps a bare error flag per tool call, not its class (36 of 802
// recorded edit_file calls errored, class unknown), and the non-streaming chat path
// dropped Ollama's done_reason entirely, so context-budget's 'truncated' event had fired
// exactly once since 2026-09-08 (from Chat) across 25,496 logged pipeline turns.
//
// Its own file, NOT pipeline-history.log: that file is read IN FULL by
// readPipelineHistory (the capability ledger re-reads it every ~60 s from the claim
// loop), and context-budget is already 62% of it -- a second per-turn stream there
// would multiply every one of those reads. Sizing from the measured turn counts (mean
// 822 loop turns/day, peak 2,469): roughly 0.3 MB/day typical, under 1 MB/day at the
// peak. No rotation yet.
//
// Privacy: entries carry sizes, classes and ids only -- never a file path, a tool
// argument value or any model/file text (task text can hold the owner's private notes).
//
// On by default; AGENT_MANAGER_TOOL_LOOP_AUDIT=off (or 0/false) disables it, read at
// write time. Best-effort: a write failure must never break the loop, same contract as
// pipeline-history.js's logPipelineEvent.
//
// CLI: node src/tool-loop-audit.js [days] [--json]

const fs = require('fs');
const path = require('path');

const AUDIT_FILENAME = 'tool-loop-audit.log';
const DEFAULT_WINDOW_DAYS = 7;
const EDIT_TOOLS = new Set(['edit_file', 'write_file']);

function isAuditEnabled() {
  const v = String(process.env.AGENT_MANAGER_TOOL_LOOP_AUDIT || '').trim().toLowerCase();
  return !(v === 'off' || v === '0' || v === 'false');
}

function auditPath(pipelineDir) {
  return path.join(pipelineDir, 'instances', AUDIT_FILENAME);
}

function logToolLoopEvent(pipelineDir, type, entry) {
  try {
    if (!pipelineDir || !isAuditEnabled()) return;
    const file = auditPath(pipelineDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), type, ...entry })}\n`);
  } catch {
    // best-effort audit trail -- must never break the real call
  }
}

// HEURISTIC, flagged as such on every line it produces. Ollama parses tool calls
// server-side, so a call cut off by the context ceiling never arrives as tool_calls --
// what reaches the client is done_reason 'length', no tool_calls, and whatever partial
// text the model had emitted. When that text contains the start of a tool-call payload
// in one of the shapes models emit it as -- a `<tool_call>` tag, a `"function": {`
// object, or a `"name": "<snake_case>", "arguments":` pair -- the turn is classed
// 'length-tool-call-suspected' instead of plain 'length'. A tool NAME mentioned in prose
// ("I will call edit_file next") is deliberately not enough.
const CUT_OFF_TOOL_CALL_RE = /<tool_call>|"function"\s*:\s*\{|"name"\s*:\s*"[a-z][a-z0-9_]*"\s*,\s*"arguments"\s*:/;

// endClass: 'tool-calls' | 'stop' | 'length' | 'length-tool-call-suspected' |
// 'unknown' (no done_reason reported at all) | 'other' (any other done_reason value).
function classifyTurnEnd({ doneReason, toolCallCount, content }) {
  if (toolCallCount > 0) return { endClass: 'tool-calls', heuristic: false };
  if (doneReason == null || doneReason === '') return { endClass: 'unknown', heuristic: false };
  if (doneReason === 'stop') return { endClass: 'stop', heuristic: false };
  if (doneReason === 'length') {
    return CUT_OFF_TOOL_CALL_RE.test(typeof content === 'string' ? content : '')
      ? { endClass: 'length-tool-call-suspected', heuristic: true }
      : { endClass: 'length', heuristic: false };
  }
  return { endClass: 'other', heuristic: false };
}

// Classifies by the fixed error strings editFileTool/writeFileTool (local-tool-fs-tools.js)
// and executeToolCalls (local-tool-client.js) return. tool-loop-audit.test.js drives every
// one of those branches through the REAL tools, so rewording a message fails a test
// rather than silently landing in 'other-error'.
function classifyToolOutcome({ result }) {
  if (result && typeof result === 'object' && !result.error && (result.edited || result.written)) return 'applied';
  const err = result && typeof result === 'object' ? result.error : null;
  if (typeof err !== 'string') return 'other-error';
  if (/not found verbatim/.test(err)) return 'not-found';
  if (/matches \d+ places/.test(err)) return 'ambiguous';
  if (/not inside any accessible repo|read-only sibling repo/.test(err)) return 'path-refused';
  if (/requires a non-empty/.test(err)) return 'bad-args';
  if (/^could not (read|write) /.test(err)) return 'io-error';
  if (/^tool \S+ failed: /.test(err)) return 'tool-threw';
  return 'other-error';
}

function strLen(v) {
  return typeof v === 'string' ? v.length : null;
}

// ctx: { source, taskId, stage, lane, model, turn, phase }. message is the assistant
// message as postChatTurn returned it; only its sizes are recorded.
function buildTurnEndEntry(ctx, { message, usage, doneReason }) {
  const msg = message || {};
  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  const content = typeof msg.content === 'string' ? msg.content : '';
  const { endClass, heuristic } = classifyTurnEnd({ doneReason, toolCallCount: toolCalls.length, content });
  return {
    ...ctx,
    doneReason: doneReason == null ? null : doneReason,
    endClass,
    heuristic,
    toolCallCount: toolCalls.length,
    toolNames: toolCalls.map((c) => (c && c.function && c.function.name) || 'unknown'),
    contentChars: content.length,
    thinkingChars: strLen(msg.thinking),
    promptEvalCount: usage && usage.prompt_eval_count != null ? usage.prompt_eval_count : null,
    evalCount: usage && usage.eval_count != null ? usage.eval_count : null,
  };
}

// One entry per edit_file/write_file call in `calls` (a slice of runPlanWithTools'
// toolCallLog). Other tools are not logged here -- their outcomes are not what the
// follow-up decisions need, and turn-end's toolNames already counts them.
function buildToolOutcomeEntries(ctx, calls) {
  const out = [];
  for (const c of Array.isArray(calls) ? calls : []) {
    if (!c || !EDIT_TOOLS.has(c.tool)) continue;
    const args = c.args || {};
    const entry = { ...ctx, tool: c.tool, outcome: classifyToolOutcome(c) };
    if (c.tool === 'edit_file') {
      entry.findChars = strLen(args.find);
      entry.replaceChars = strLen(args.replace);
    } else {
      entry.contentChars = strLen(args.content);
    }
    out.push(entry);
  }
  return out;
}

function readToolLoopAudit(pipelineDir, { since, type } = {}) {
  if (!pipelineDir) return [];
  let raw;
  try {
    raw = fs.readFileSync(auditPath(pipelineDir), 'utf8');
  } catch {
    return [];
  }
  const sinceMs = since ? new Date(since).getTime() : null;
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (type && e.type !== type) continue;
    if (sinceMs != null && !(new Date(e.at).getTime() >= sinceMs)) continue;
    out.push(e);
  }
  return out;
}

// Per (lane, model): turn-end counts by endClass (+ how many had no done_reason at all)
// and per-tool outcome counts with a miss rate (non-'applied' / total).
function buildSummary(entries) {
  const rows = new Map();
  const rowFor = (e) => {
    const key = `${e.lane || '-'}\u0000${e.model || '-'}`;
    if (!rows.has(key)) rows.set(key, { lane: e.lane || null, model: e.model || null, turns: 0, endClass: {}, doneReasonNull: 0, heuristic: 0, tools: {} });
    return rows.get(key);
  };
  for (const e of entries) {
    if (e.type === 'turn-end') {
      const r = rowFor(e);
      r.turns += 1;
      r.endClass[e.endClass] = (r.endClass[e.endClass] || 0) + 1;
      if (e.doneReason == null) r.doneReasonNull += 1;
      if (e.heuristic) r.heuristic += 1;
    } else if (e.type === 'tool-outcome') {
      const r = rowFor(e);
      const t = r.tools[e.tool] || (r.tools[e.tool] = { total: 0, outcomes: {}, missRate: 0 });
      t.total += 1;
      t.outcomes[e.outcome] = (t.outcomes[e.outcome] || 0) + 1;
    }
  }
  for (const r of rows.values()) {
    for (const t of Object.values(r.tools)) t.missRate = t.total ? (t.total - (t.outcomes.applied || 0)) / t.total : 0;
  }
  return [...rows.values()].sort((a, b) => b.turns - a.turns);
}

function readSummary(pipelineDir, { windowDays = DEFAULT_WINDOW_DAYS, now = Date.now() } = {}) {
  const since = new Date(now - windowDays * 86400000).toISOString();
  return buildSummary(readToolLoopAudit(pipelineDir, { since }));
}

module.exports = {
  AUDIT_FILENAME, CUT_OFF_TOOL_CALL_RE, isAuditEnabled, auditPath, logToolLoopEvent,
  classifyTurnEnd, classifyToolOutcome, buildTurnEndEntry, buildToolOutcomeEntries,
  readToolLoopAudit, buildSummary, readSummary,
};

if (require.main === module) {
  const dir = process.env.AGENT_MANAGER_PIPELINE_DIR || process.env.AGENT_MANAGER_REPO_ROOT || process.cwd();
  const days = Number(process.argv[2]) || DEFAULT_WINDOW_DAYS;
  const rows = readSummary(dir, { windowDays: days });
  if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
  else {
    console.log('lane'.padEnd(16) + 'model'.padEnd(26) + 'turns'.padStart(6) + '  length  unknown  edit_file miss%');
    for (const r of rows) {
      const len = (r.endClass.length || 0) + (r.endClass['length-tool-call-suspected'] || 0);
      const ef = r.tools.edit_file;
      console.log(String(r.lane || '-').padEnd(16) + String(r.model || '-').padEnd(26) + String(r.turns).padStart(6)
        + `  ${String(len).padStart(6)}  ${String(r.doneReasonNull).padStart(7)}  ${ef ? `${(ef.missRate * 100).toFixed(0)}% of ${ef.total}` : '-'}`);
    }
  }
}
