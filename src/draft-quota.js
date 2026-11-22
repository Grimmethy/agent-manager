'use strict';
// Quota / rate-limit classification for the draft step (scripts/local-worker.sh).
//
// An HTTP 429 ("hourly token budget reached", "five-hour limit reached") is a TEMPORARY capacity condition, not a draft failure.
// The worker defers the task until the stated reset (task.deferUntil, an ISO string) and does NOT touch draftFailureCount, so a
// quota window can never burn the failure budget that sends a task to needs-clarification.
//
// ADR-0024: no timer and no poll is added. The task stays in drafting/ and the worker's EXISTING per-tick leftover-drafting pass
// skips it while deferUntil is in the future (one field read on a file that pass already opens).

const fs = require('fs');

// Wait used when a 429 carries no usable reset information (or a reset in the past / unparseable). Bounds EACH wait, not the
// number of deferrals.
const QUOTA_BACKOFF_MS = 5 * 60 * 1000;
// A stated reset further away than this is clamped, so a bad timestamp can never park a task for days.
const MAX_WAIT_MS = 6 * 60 * 60 * 1000;
// Small pad after a stated reset so the retry lands after it, not on it.
const RESET_PAD_MS = 1000;

const QUOTA_PATTERN = /HTTP 429|hourly token budget|five-hour (?:plan )?limit|too many requests/i;

function isQuotaText(text) {
  return QUOTA_PATTERN.test(String(text || ''));
}

function parseResetsInSec(text) {
  const m = /resetsInSec\\?"?\s*[:=]\s*\\?"?(\d+(?:\.\d+)?)/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parseResetsAt(text) {
  const m = /resetsAt\\?"?\s*[:=]\s*\\?"?([^"\\,}\s]+)/i.exec(text);
  if (!m) return null;
  const raw = m[1];
  let ms;
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    ms = n < 1e11 ? n * 1000 : n;   // epoch seconds or epoch milliseconds
  } else {
    ms = Date.parse(raw);
  }
  return Number.isFinite(ms) ? ms : null;
}

// classify(text, nowMs) -> { kind: 'failure' } | { kind: 'quota', resumeAt: <epoch ms>, source: 'resetsInSec'|'resetsAt'|'backoff' }
function classify(text, nowMs) {
  const t = String(text || '');
  if (!isQuotaText(t)) return { kind: 'failure' };
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const inSec = parseResetsInSec(t);
  if (inSec !== null) {
    return { kind: 'quota', source: 'resetsInSec', resumeAt: now + inSec * 1000 + RESET_PAD_MS };
  }
  const at = parseResetsAt(t);
  if (at !== null && at > now) {
    return { kind: 'quota', source: 'resetsAt', resumeAt: at + RESET_PAD_MS };
  }
  return { kind: 'quota', source: 'backoff', resumeAt: now + QUOTA_BACKOFF_MS };
}

function readTask(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Persist deferUntil on the task file. Never touches draftFailureCount.
function recordDeferral(taskPath, result, nowMs, detailText) {
  const o = readTask(taskPath);
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  o.deferUntil = new Date(result.resumeAt).toISOString();
  o.history = o.history || [];
  o.history.push({
    stage: 'deferred',
    at: new Date(now).toISOString(),
    detail: `draft deferred on a rate-limit/quota response (HTTP 429) until ${o.deferUntil} (reset source: ${result.source}); not counted as a failure${detailText ? ` (most recent: ${String(detailText).slice(0, 300)})` : ''}`,
  });
  fs.writeFileSync(taskPath, JSON.stringify(o, null, 2));
  return o.deferUntil;
}

function isDeferred(task, nowMs) {
  const until = Date.parse(task && task.deferUntil);
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  return Number.isFinite(until) && until > now;
}

module.exports = { QUOTA_BACKOFF_MS, MAX_WAIT_MS, isQuotaText, classify, recordDeferral, isDeferred };

// CLI (used by scripts/local-worker.sh):
//   <draft result on stdin> | node draft-quota.js classify-and-defer <task.json>
//       quota   -> writes deferUntil on the task, prints the ISO resume time, exit 0
//       failure -> prints nothing, leaves the file untouched, exit 0
//   node draft-quota.js deferred <task.json>   exit 0 when deferUntil is still in the future, else exit 1
if (require.main === module) {
  const [cmd, taskPath] = process.argv.slice(2);
  try {
    if (cmd === 'classify-and-defer') {
      const text = fs.readFileSync(0, 'utf8');
      const r = classify(text, Date.now());
      if (r.kind === 'quota') console.log(recordDeferral(taskPath, r, Date.now(), text));
    } else if (cmd === 'deferred') {
      process.exit(isDeferred(readTask(taskPath), Date.now()) ? 0 : 1);
    } else {
      process.exit(2);
    }
  } catch (e) {
    // Fail open: an unreadable task is never deferred, and a classify error falls through to the normal failure path.
    if (cmd === 'deferred') process.exit(1);
  }
}
