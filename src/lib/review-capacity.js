'use strict';

// review-capacity.js: pure helpers that tell a provider capacity limit (HTTP 429 / plan-limit /
// "five-hour limit reached") apart from an ordinary review failure, and compute when to retry.
//
//   classifyReviewFailure(result) -> {kind:'capacity', resetsAt?: ISO string} | {kind:'failure'}
//   nextBackoffMs(step)           -> ms (1 min doubling, capped at 1 h)
//   computeResumeAt(classification, nowMs, step) -> ISO string
//   isLegacyPlanLimitBlock(reason) -> {legacy:boolean, resetsAt?: ISO string}
//   formatWaitingStatus(task)     -> string ('' when the task is not waiting on a provider limit)
//
// formatWaitingStatus form rule: a finite task.backoffStep selects the backoff form
// ("resumes ~<ISO>"); otherwise the exact-reset form is used. Callers must therefore leave
// backoffStep unset when resumeAt came from a reported resetsAt.
//
// Purity contract: no I/O, no timers, no clock reads, no imports. The caller passes nowMs.

const BASE_BACKOFF_MS = 60 * 1000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

function toIso(value) {
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = Math.abs(value) < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
  }
  return undefined;
}

function extractResetsAt(text) {
  if (typeof text !== 'string') return undefined;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const body = JSON.parse(text.slice(start, end + 1));
      if (body && typeof body === 'object') {
        let raw = body.resetsAt;
        if (raw === undefined && body.error && typeof body.error === 'object') raw = body.error.resetsAt;
        const iso = toIso(raw);
        if (iso) return iso;
      }
    } catch (_) {
      // fall through to the tolerant scan below
    }
  }
  // Tolerate truncated / malformed JSON: look for a bare "resetsAt": value pair.
  const m = /"resetsAt"\s*:\s*(?:"([^"]*)"|(\d+(?:\.\d+)?))/.exec(text);
  if (m) return toIso(m[1] !== undefined ? m[1] : Number(m[2]));
  return undefined;
}

const TEXT_FIELDS = ['reason', 'error', 'message', 'stderr', 'stdout', 'body'];
const STATUS_FIELDS = ['status', 'statusCode', 'httpStatus'];

function collectText(result) {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object') return '';
  const parts = [];
  for (const f of TEXT_FIELDS) {
    if (typeof result[f] === 'string') parts.push(result[f]);
  }
  return parts.join('\n');
}

function classifyReviewFailure(result) {
  try {
    const text = collectText(result);
    let status = NaN;
    if (result && typeof result === 'object') {
      for (const f of STATUS_FIELDS) {
        const n = Number(result[f]);
        if (result[f] !== null && result[f] !== undefined && Number.isFinite(n)) {
          status = n;
          break;
        }
      }
    }
    const isCapacity =
      status === 429 ||
      /\b429\b/.test(text) ||
      /plan[-\s]?limit/i.test(text) ||
      /five[-\s]?hour limit reached/i.test(text);
    if (!isCapacity) return { kind: 'failure' };
    const out = { kind: 'capacity' };
    const resetsAt = extractResetsAt(text);
    if (resetsAt) out.resetsAt = resetsAt;
    return out;
  } catch (_) {
    return { kind: 'failure' };
  }
}

function nextBackoffMs(step) {
  if (typeof step !== 'number' || !Number.isFinite(step)) return BASE_BACKOFF_MS;
  const s = Math.min(10, Math.max(0, Math.floor(step)));
  return Math.min(BASE_BACKOFF_MS * Math.pow(2, s), MAX_BACKOFF_MS);
}

function computeResumeAt(classification, nowMs, step) {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    throw new TypeError('computeResumeAt: nowMs must be a finite number');
  }
  const resetsAt = classification && typeof classification === 'object' ? classification.resetsAt : undefined;
  if (typeof resetsAt === 'string') {
    const t = Date.parse(resetsAt);
    if (Number.isFinite(t) && t > nowMs) return resetsAt;
  }
  return new Date(nowMs + nextBackoffMs(step)).toISOString();
}

function isLegacyPlanLimitBlock(reason) {
  if (typeof reason !== 'string') return { legacy: false };
  const legacy =
    /review call failed\s+\d+\s+times in a row/i.test(reason) &&
    /plan[-\s]?limit/i.test(reason) &&
    /five[-\s]?hour limit reached/i.test(reason);
  if (!legacy) return { legacy: false };
  const out = { legacy: true };
  const resetsAt = extractResetsAt(reason);
  if (resetsAt) out.resetsAt = resetsAt;
  return out;
}

function formatWaitingStatus(task) {
  if (!task || typeof task !== 'object' || task.waitingOn !== 'provider-limit') return '';
  let iso = 'unknown';
  if (typeof task.resumeAt === 'string' && Number.isFinite(Date.parse(task.resumeAt))) iso = task.resumeAt;
  const backoff = typeof task.backoffStep === 'number' && Number.isFinite(task.backoffStep);
  const approx = backoff && iso !== 'unknown' ? '~' : '';
  const label = backoff ? `backoff step ${task.backoffStep}` : 'plan limit';
  return `waiting: provider limit (${label}), resumes ${approx}${iso}`;
}

module.exports = {
  classifyReviewFailure,
  nextBackoffMs,
  computeResumeAt,
  isLegacyPlanLimitBlock,
  formatWaitingStatus,
};
