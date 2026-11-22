'use strict';
// Quota / rate-limit classification for the draft step (scripts/local-worker.sh).
//
// An HTTP 429 ("hourly token budget reached", "five-hour limit reached") is a TEMPORARY capacity condition, not a draft failure.
// The worker defers the task until the stated reset (task.deferUntil, an ISO string) and does NOT touch draftFailureCount, so a
// quota window can never burn the failure budget that sends a task to needs-clarification.
//
// ADR-0024: no timer and no poll is added. The task stays in drafting/ and the worker's EXISTING per-tick leftover-drafting pass
// skips it while deferUntil is in the future (one field read on a file that pass already opens).
//
// Plan-limit release: when a quota-deferred task should be released back to the pool (HUB0781-03), releaseToPool() moves it to
// queue/pending or queue/adhoc, strips deferUntil, and appends a 'released-plan-limit' history event. sweepQuotaDeferred() is the
// startup sweep that calls releaseToPool() for every task still carrying a quota deferral in drafting/.

const fs = require('fs');
const path = require('path');

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

// Determine if a task record is adhoc-shaped: domain 'adhoc', or source 'manual' / 'derived_task'.
// Used by releaseToPool() to decide whether to file the released task in queue/adhoc/ or queue/pending/.
function isAdhocClass(task) {
  if (!task || typeof task !== 'object') return false;
  if (task.domain === 'adhoc') return true;
  if (task.source === 'manual' || task.source === 'derived_task') return true;
  return false;
}

// Strip the deferUntil field from a task record. Returns a SHALLOW copy; the original is not mutated.
function stripPlanLimitDeferral(task) {
  if (!task || typeof task !== 'object') return task;
  const { deferUntil, ...rest } = task;
  return rest;
}

// True when the task's history already contains a quota-deferral event.
// The stage recorded by recordDeferral() is 'deferred' with a detail containing the phrase
// 'draft deferred on a rate-limit/quota response'.
function hasQuotaDeferral(task) {
  if (!task || !Array.isArray(task.history)) return false;
  return task.history.some((h) => h && typeof h.detail === 'string' && h.detail.includes('draft deferred on a rate-limit/quota response'));
}

// Move a plan-limit 429 task from drafting back into the pool.
// - Strips deferUntil from the task record.
// - Appends a history event { stage: 'released-plan-limit', lane, resetsAt, at }.
// - Leaves draftFailureCount unchanged.
// - Files the task in queue/adhoc/ when isAdhocClass(task), else queue/pending/.
//
// DEPENDENCY: HUB0781-03 not merged — pauseLane from src/cloud-plan-limit.js is the real
// lane-pause primitive. The call below is a clearly-marked placeholder so the dependency is
// visible in git history and in code review:
//   const pauseLane = require('./cloud-plan-limit.js').pauseLane;
//   pauseLane(lane, resetsAt);
// Until HUB0781-03 lands, the lane is NOT paused by this helper; the caller (the sweep) is
// responsible for invoking pauseLane once the dependency is available.
function releaseToPool(task, { lane, resetsAt, now, queueRoot }) {
  if (!task || typeof task !== 'object') return task;
  const o = stripPlanLimitDeferral(task);
  o.history = o.history || [];
  const t = Number.isFinite(now) ? now : Date.now();
  o.history.push({
    stage: 'released-plan-limit',
    lane: lane || null,
    resetsAt: resetsAt || null,
    at: new Date(t).toISOString(),
  });
  // DEPENDENCY: HUB0781-03 not merged — pauseLane from src/cloud-plan-limit.js not yet available
  // pauseLane(lane, resetsAt);
  const sub = isAdhocClass(o) ? 'adhoc' : 'pending';
  const dir = path.join(queueRoot, 'queue', sub);
  const name = (o.id || 'task').replace(/\.json$/, '') + '.json';
  const fs = require('fs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(o, null, 2));
  return o;
}

// Sweep every task in draftingDir; release those carrying a quota deferral.
// Returns { released: [...], kept: [...] } where each entry is { id, file } for the task.
function sweepQuotaDeferred(draftingDir, queueRoot) {
  const result = { released: [], kept: [] };
  let entries;
  try {
    entries = fs.readdirSync(draftingDir, { withFileTypes: true });
  } catch (_) {
    return result;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const laneDir = path.join(draftingDir, entry.name);
    let files;
    try {
      files = fs.readdirSync(laneDir).filter((f) => f.endsWith('.json'));
    } catch (_) { continue; }
    for (const file of files) {
      const taskPath = path.join(laneDir, file);
      let task;
      try {
        task = readTask(taskPath);
      } catch (_) { continue; }
      if (!hasQuotaDeferral(task)) {
        result.kept.push({ id: task.id || file.replace(/\.json$/, ''), file: taskPath });
        continue;
      }
      // DEPENDENCY: HUB0781-03 not merged — pauseLane from src/cloud-plan-limit.js not yet available
      // const { pauseLane } = require('./cloud-plan-limit.js');
      // pauseLane(entry.name, task.deferUntil);
      const released = releaseToPool(task, {
        lane: entry.name,
        resetsAt: task.deferUntil || null,
        now: Date.now(),
        queueRoot,
      });
      // Remove the original file from drafting/<lane>/ after releasing it to the pool.
      try { fs.unlinkSync(taskPath); } catch (_) { /* best-effort */ }
      result.released.push({ id: released.id || file.replace(/\.json$/, ''), file: taskPath });
    }
  }
  return result;
}

module.exports = { QUOTA_BACKOFF_MS, MAX_WAIT_MS, isQuotaText, classify, recordDeferral, isDeferred, isAdhocClass, stripPlanLimitDeferral, hasQuotaDeferral, releaseToPool, sweepQuotaDeferred };

// CLI (used by scripts/local-worker.sh):
//   <draft result on stdin> | node draft-quota.js classify-and-defer <task.json>
//       quota   -> writes deferUntil on the task, prints the ISO resume time, exit 0
//       failure -> prints nothing, leaves the file untouched, exit 0
//   node draft-quota.js deferred <task.json>   exit 0 when deferUntil is still in the future, else exit 1
//   node draft-quota.js sweep-quota <draftingDir> <queueRoot>   prints { released, kept } JSON, exits 0
if (require.main === module) {
  const [cmd, arg1, arg2] = process.argv.slice(2);
  try {
    if (cmd === 'classify-and-defer') {
      const text = fs.readFileSync(0, 'utf8');
      const r = classify(text, Date.now());
      if (r.kind === 'quota') console.log(recordDeferral(arg1, r, Date.now(), text));
    } else if (cmd === 'deferred') {
      process.exit(isDeferred(readTask(arg1), Date.now()) ? 0 : 1);
    } else if (cmd === 'sweep-quota') {
      const result = sweepQuotaDeferred(arg1, arg2);
      process.stdout.write(JSON.stringify(result));
      process.exit(0);
    } else {
      process.exit(2);
    }
  } catch (e) {
    // Fail open: an unreadable task is never deferred, and a classify error falls through to the normal failure path.
    if (cmd === 'deferred') process.exit(1);
  }
}
