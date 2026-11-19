'use strict';

// Plan-limit parsing and resume helpers (HUB0743 piece 1/4).
//
// A provider plan limit answers `ollama http 429: {"error":"plan-limit","resetsAt":...,"window":...}`. Retrying every tick only burns the task's draft
// failure budget, so the worker should defer the task until the limit resets. This module is PURE and SYNCHRONOUS: no timers, no I/O, no clock reads in
// the library functions (time always arrives as `nowMs`), per ADR-0024 (triggers, not polls). Only the CLI layer at the bottom reads the clock.
//
// CLI (for the bash worker):
//   node src/plan-limit-resume.js classify <reason-or-body>    prints the JSON result; exit 0 = plan limit, 1 = not a plan limit
//   node src/plan-limit-resume.js due <task json>              exit 0 = due (or no resume time), 1 = still deferred
//   node src/plan-limit-resume.js requeue-parked <task json>   prints the requeued task JSON; exit 1 = not a parked plan-limit task
// Arguments may be replaced by stdin when omitted. Usage errors exit 2.

const FALLBACK_BACKOFF_MS = 15 * 60 * 1000;
const PARKED_RE = /draft call failed \d+ times in a row[\s\S]*plan-limit/;

function bodyFrom(input) {
  if (input && typeof input === 'object' && !Array.isArray(input)) return input;
  if (typeof input !== 'string') return null;
  const marker = /ollama http (\d{3})/i.exec(input);
  if (marker && Number(marker[1]) !== 429) return null;
  const start = input.indexOf('{');
  const end = input.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(input.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    return null;
  }
}

function toMs(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? (v < 1e11 ? v * 1000 : v) : NaN;
  if (typeof v === 'string' && v.trim()) {
    if (/^\d+(\.\d+)?$/.test(v.trim())) return toMs(Number(v));
    return Date.parse(v);
  }
  return NaN;
}

// -> {deferred: true, resumeAtMs, window, source: 'resetsAt'|'fallback'} for a plan-limit 429, else null. Never throws.
function parsePlanLimit(reasonOrBody, nowMs) {
  try {
    if (!Number.isFinite(nowMs)) return null;
    const body = bodyFrom(reasonOrBody);
    if (!body || body.error !== 'plan-limit') return null;
    const reset = toMs(body.resetsAt);
    const window = typeof body.window === 'string' && body.window ? body.window : 'unknown';
    if (Number.isFinite(reset)) return { deferred: true, resumeAtMs: Math.max(reset, nowMs), window, source: 'resetsAt' };
    return { deferred: true, resumeAtMs: nowMs + FALLBACK_BACKOFF_MS, window, source: 'fallback' };
  } catch (e) {
    return null;
  }
}

function statusText(d) {
  if (!d || typeof d !== 'object' || !Number.isFinite(d.resumeAtMs)) return 'provider plan limit reached; resume time unknown';
  return `provider plan limit reached (window: ${d.window || 'unknown'}); resuming at ${new Date(d.resumeAtMs).toISOString()}`;
}

function taskResumeMs(task) {
  if (!task || typeof task !== 'object') return NaN;
  for (const k of ['resumeAtMs', 'planLimitResumeAtMs', 'resumeAt']) {
    const ms = toMs(task[k]);
    if (Number.isFinite(ms)) return ms;
  }
  return NaN;
}

// True unless the task carries a resume time that is still in the future.
function isDue(task, nowMs) {
  const at = taskResumeMs(task);
  if (!Number.isFinite(at) || !Number.isFinite(nowMs)) return true;
  return nowMs >= at;
}

function parkedText(task) {
  if (!task || typeof task !== 'object') return '';
  for (const k of ['blockedReason', 'clarificationReason', 'needsClarificationReason', 'reason']) {
    if (typeof task[k] === 'string' && PARKED_RE.test(task[k])) return task[k];
  }
  return '';
}

// A task parked with "draft call failed N times in a row ... plan-limit" -> a NEW task object ready for pending/, else null. Input is never mutated.
function requeueParked(task, nowMs) {
  const text = parkedText(task);
  if (!text || !Number.isFinite(nowMs)) return null;
  const d = parsePlanLimit(text, nowMs);
  const resumeAtMs = d ? d.resumeAtMs : nowMs + FALLBACK_BACKOFF_MS;
  const out = { ...task };
  for (const k of ['blockedReason', 'blockedStage', 'clarificationReason', 'needsClarificationReason', 'draftFailureCount', 'status']) delete out[k];
  out.resumeAtMs = resumeAtMs;
  out.history = (Array.isArray(task.history) ? task.history : []).concat([{
    stage: 'requeued',
    at: new Date(nowMs).toISOString(),
    detail: `requeued from a plan-limit park; ${statusText(d || { resumeAtMs, window: 'unknown' })}`,
  }]);
  return out;
}

function readStdin() {
  try { return require('fs').readFileSync(0, 'utf8'); } catch (e) { return ''; }
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (!['classify', 'due', 'requeue-parked'].includes(cmd)) {
    process.stderr.write('usage: node src/plan-limit-resume.js classify|due|requeue-parked [text-or-json]\n');
    return 2;
  }
  const arg = rest.length ? rest.join(' ') : readStdin();
  const now = Date.now();
  if (cmd === 'classify') {
    const d = parsePlanLimit(arg, now);
    if (!d) return 1;
    process.stdout.write(`${JSON.stringify({ ...d, text: statusText(d) })}\n`);
    return 0;
  }
  let task;
  try { task = JSON.parse(arg); } catch (e) {
    process.stderr.write('plan-limit-resume: task argument is not valid JSON\n');
    return 2;
  }
  if (cmd === 'due') return isDue(task, now) ? 0 : 1;
  const next = requeueParked(task, now);
  if (!next) return 1;
  process.stdout.write(`${JSON.stringify(next)}\n`);
  return 0;
}

module.exports = { parsePlanLimit, statusText, isDue, requeueParked, FALLBACK_BACKOFF_MS };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
