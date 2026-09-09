'use strict';

// Requeue Attribution's classifier (2026-09-08) -- fires on EVERY requeue across this
// pipeline, deliberately cheap and ungated (Grimmethy: "I want this to go off like
// crazy"). Deterministic-first, mirrors brain_dump_sort/fact-checker.js's own established
// cheap-checks-before-a-model-call convention:
//   1. Structured signals already on the task (BLOCKER-TYPE, stalenessFlag.reason).
//   2. For an Ollama-timeout-shaped reason specifically: a real retrospective GPU-
//      contention check against model-stats.db's own model_calls history (gpu-guard.js/
//      model-inflight-lock.js retain no history -- confirmed this session -- so this is
//      the only real source for "was something else running on the GPU at time T").
//   3. Only when 1-2 don't resolve it: a rate-limited cheap local-model call, classifying
//      into a fixed vocabulary (DSPy-Signature style, mirrors BLOCKER_TYPE_RE's own
//      precedent in agentic-draft-common.js).
// The cause signature itself is Rollbar's real, published normalize-then-hash algorithm --
// strip the variable/noisy parts of the reason text, hash what's left. Recorded into
// requeue-attribution.db (its own db, not merged into task-links.db) and cross-linked to
// the contributing task via task-links-client.js's recordLink() -- reusing Task Linking's
// primitive rather than inventing a second linking mechanism.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { call: callBackend } = require('./local-client.js');
const { recordRequeueCause, getBurnRate } = require('./requeue-attribution-client.js');
const { recordLink } = require('./task-links-client.js');

const BLOCKER_TYPE_RE = /BLOCKER-TYPE:\s*(design-question|budget-exhausted|infra-error)\b/i;
const OLLAMA_TIMEOUT_RE = /OLLAMA_TIMEOUT|Ollama request timed out/i;

// Fixed vocabulary the fallback model call must choose from -- DSPy Signature style.
const CAUSE_CATEGORIES = ['transient-infra', 'gpu-contention', 'model-capability', 'design-decision', 'genuine-bug'];
const CAUSE_RE = new RegExp(`CAUSE:\\s*(${CAUSE_CATEGORIES.join('|')})\\b`, 'i');

// Rate limiter -- defense-in-depth per the concept's own gap-4 decision. The PRIMARY
// defense against the GPU-contention feedback loop (classifying an Ollama timeout by
// making another model call that competes for the same constrained GPU) is step 2's
// deterministic check; this is a cheap backstop for when that check misses a real case.
// Module-level, in-memory, per-process -- not cross-process accurate, which is fine for a
// backstop, not the primary mechanism.
const FALLBACK_RATE_LIMIT_MAX = Number(process.env.AGENT_MANAGER_REQUEUE_ATTRIBUTION_FALLBACK_RATE_LIMIT) || 5;
const FALLBACK_RATE_LIMIT_WINDOW_MS = 60_000;
let fallbackCallTimestamps = [];
function fallbackRateLimitOk(now) {
  fallbackCallTimestamps = fallbackCallTimestamps.filter((t) => now - t < FALLBACK_RATE_LIMIT_WINDOW_MS);
  if (fallbackCallTimestamps.length >= FALLBACK_RATE_LIMIT_MAX) return false;
  fallbackCallTimestamps.push(now);
  return true;
}
function _resetFallbackRateLimitForTests() {
  fallbackCallTimestamps = [];
}

function normalizeReasonText(reasonHint) {
  if (Array.isArray(reasonHint)) return reasonHint.filter(Boolean).join('; ');
  return String(reasonHint || '');
}

// Step 1: structured signals already on the task -- no model call, no repo read.
function structuredSignalCategory(task, reasonText) {
  const blockerMatch = BLOCKER_TYPE_RE.exec((task && task.blockedReason) || '') || BLOCKER_TYPE_RE.exec(reasonText);
  if (blockerMatch) return blockerMatch[1]; // design-question | budget-exhausted | infra-error
  if (task && task.stalenessFlag && task.stalenessFlag.reason) return task.stalenessFlag.reason;
  return null;
}

// Step 2: a real retrospective overlap query against model-stats.db's model_calls table --
// "did some OTHER task's call have this task's failure timestamp inside its own
// [started_at, started_at+latency_ms] window." Bounded to a generous +/-10min window
// around `atMs` so this stays a small scan even as model_calls grows into the thousands,
// not a full-table scan every single classification.
const GPU_CONTENTION_WINDOW_MS = 10 * 60 * 1000;
function checkGpuContention(taskId, atMs, repoRoot) {
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch (e) { return false; }
  const dbPath = process.env.AGENT_MANAGER_MODEL_STATS_DB_PATH || path.join(repoRoot, 'model-stats.db');
  if (!fs.existsSync(dbPath)) return false;
  let db;
  try { db = new DatabaseSync(dbPath, { readOnly: true }); } catch (e) { return false; }
  try {
    const windowStart = new Date(atMs - GPU_CONTENTION_WINDOW_MS).toISOString();
    const windowEnd = new Date(atMs + GPU_CONTENTION_WINDOW_MS).toISOString();
    const rows = db.prepare(`
      SELECT started_at, latency_ms FROM model_calls
      WHERE task_id != ? AND started_at >= ? AND started_at <= ?
    `).all(taskId, windowStart, windowEnd);
    for (const r of rows) {
      const start = Date.parse(r.started_at);
      if (!Number.isFinite(start)) continue;
      const end = start + (r.latency_ms || 0);
      if (atMs >= start && atMs <= end) return true;
    }
    return false;
  } catch (e) {
    return false;
  } finally {
    try { db.close(); } catch (e) { /* best-effort */ }
  }
}

// Step 3: the rare fallback. `callModel` is injectable (test/caller override), same
// convention review-task.js's own localMajorityVote param already uses -- defaults to the
// real local-client.js backend.
async function classifyViaFallbackModel(reasonText, callModel) {
  const backend = callModel || callBackend;
  try {
    const prompt = `Classify why this pipeline task requeue happened. Respond with EXACTLY one line: CAUSE: <category>\nCategories: ${CAUSE_CATEGORIES.join(', ')}\n\nReason text:\n${reasonText.slice(0, 2000)}`;
    const result = await backend({ prompt, numPredict: 30, temperature: 0.1, source: 'requeue-attribution' });
    const text = (result && (result.response || result.text)) || '';
    const match = CAUSE_RE.exec(text);
    return match ? match[1].toLowerCase() : null;
  } catch (e) {
    return null;
  }
}

// Rollbar's real, published normalize-then-hash algorithm -- strip the variable/noisy
// parts (timestamps, hex ids/SHAs, file paths, long digit runs), keep everything else
// (including error/status-code-shaped tokens, which are usually the semantically
// meaningful part), hash what's left. Cheap, no ML, no accumulated history required.
// Escalation -- Google SRE Workbook's "ticket" tier as the concept's own gap-6 decision
// requires (3-day/6-hour dual windows, 1x burn / 10% budget consumed, live from day one,
// not observe-only). The Workbook's formula needs a total-request denominator ("N% of a
// fixed error budget") that doesn't exist here -- there is no fixed SLO population to
// measure against, only per-signature occurrence counts. Rather than invent one, this
// keeps the dual-window SHAPE (a short window confirms the pattern is live RIGHT NOW, a
// long window confirms it's sustained, not a blip) and reuses this exact codebase's own
// existing bar for "is this a real pattern, not noise" -- pipeline-forensics.js's own
// CLARIFICATION_CLUSTER_THRESHOLD (3) -- as the long-window count, scaled down for the
// short window by the same ~12:1 ratio the SRE tier's own 3d:6h windows carry (3/12 -> 1).
// A documented v1 simplification, not the literal Workbook math -- upgrading to a real
// share-of-total-volume denominator is a legitimate later pass once more history
// accumulates, not a v1 requirement (the concept's own text explicitly allows this).
//
// 2026-09-08, Grimmethy: "this system should be aggressive... we lose a ton of machine
// time to these requeues. If we can reduce them before they even happen we gain a huge
// efficiency boost." -- revises the original "least-aggressive tier, live from day one"
// starting point down from 3 to 2: two real occurrences of the same signature within 3
// days is already worth a forensics look, rather than waiting for a third. Deliberately
// NOT dropping to 1 -- that would remove the "confirmed pattern, not a one-off" signal
// this dual-window shape exists to provide in the first place, and would burn forensics'
// own investigation budget on flukes. Short-window stays at its already-minimal floor.
const ESCALATION_LONG_WINDOW_MS = 3 * 24 * 3600 * 1000;
const ESCALATION_SHORT_WINDOW_MS = 6 * 3600 * 1000;
const ESCALATION_LONG_THRESHOLD = 2;
const ESCALATION_SHORT_THRESHOLD = 1;

// Writes queue/forensics-requests/requeue-attribution-<sig>.json once a signature's burn
// rate crosses both windows. Deliberately requests by TASK ID, not by our own signature:
// pipeline-forensics.js's own on-demand 'signature' subject kind is hard-wired (in
// task-sources.js's finish()) to re-derive membership via signatureForClarificationTask,
// which is a DIFFERENT algorithm from this module's Rollbar-style hash -- a request keyed
// on our own signature would never match any task and would silently produce zero
// subjects (bundle.stats.subjectCount < floor), the exact "quiet loss" every requeue-write
// hook point elsewhere in this module already guards against. Requesting the CURRENT
// (most recent) contributing task by id uses forensics' existing, already-working 'task'
// subject path (floor=1, real evidence bundle) -- zero changes needed to task-sources.js
// or pipeline-forensics.js, per this session's own grounding pass.
function checkAndEscalate(signature, taskId, { repoRoot, now = Date.now() } = {}) {
  if (!signature || !taskId || !repoRoot) return;
  try {
    const { shortCount, longCount } = getBurnRate(signature, {
      shortWindowMs: ESCALATION_SHORT_WINDOW_MS,
      longWindowMs: ESCALATION_LONG_WINDOW_MS,
      now,
    });
    if (longCount < ESCALATION_LONG_THRESHOLD || shortCount < ESCALATION_SHORT_THRESHOLD) return;

    const requestsDir = path.join(repoRoot, 'queue', 'forensics-requests');
    const requestPath = path.join(requestsDir, `requeue-attribution-${signature.slice(0, 12)}.json`);
    // Same-name file already filed -- pipeline-forensics.js's own coverageEntryActive
    // check (keyed on this exact filename) is what actually prevents re-triggering once
    // forensics has processed it; this existsSync check just avoids a redundant write
    // (and a bumped mtime that would reorder the on-demand queue) while it's still pending.
    if (fs.existsSync(requestPath)) return;

    fs.mkdirSync(requestsDir, { recursive: true });
    fs.writeFileSync(requestPath, JSON.stringify({
      taskId,
      requeueAttributionSignature: signature,
      requeueAttributionBurnRate: { shortCount, longCount },
      at: new Date(now).toISOString(),
    }, null, 2));
  } catch (e) {
    // Escalation must never break the real requeue -- see this module's own header.
  }
}

function buildSignature(category, reasonText) {
  const normalized = String(reasonText || '')
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, '')
    .replace(/\b[0-9a-f]{6,}\b/gi, '')
    .replace(/[\w./-]+\.(?:js|py|json|md)\b/g, '')
    .replace(/\b\d{2,}\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const base = `${category}::${normalized}`;
  return crypto.createHash('sha1').update(base).digest('hex');
}

// task: the full task record. opts.reasonHint: a string OR array (e.g. context-trim-
// sweep.js's own improvements[]) -- whatever reason data is already local at the caller's
// requeue-write site, no new signal-gathering required at any hook point.
async function classifyRequeue(task, {
  reasonHint,
  blockedStage = null,
  requeueWriter,
  actor = 'pipeline-mechanism',
  repoRoot,
  callModel = null,
  skipFallbackModel = false,
  now = Date.now(),
} = {}) {
  const reasonText = normalizeReasonText(reasonHint) || (task && task.blockedReason) || '';

  let category = structuredSignalCategory(task, reasonText);

  if (!category && OLLAMA_TIMEOUT_RE.test(reasonText)) {
    if (checkGpuContention(task && task.id, now, repoRoot)) {
      category = 'gpu-contention';
    }
  }

  // skipFallbackModel: the manual-requeue CLI path (invoked as a subprocess from Flask)
  // must not make a model call -- it would compete for the same constrained GPU a worker
  // may be using, for a classification the actor dimension already makes secondary.
  if (!category && !skipFallbackModel && reasonText && fallbackRateLimitOk(now)) {
    category = await classifyViaFallbackModel(reasonText, callModel);
  }

  if (!category) category = 'unclassified';

  const signature = buildSignature(category, reasonText);

  recordRequeueCause({ taskId: task && task.id, signature, blockedStage, requeueWriter, actor });
  if (task && task.id) {
    recordLink({ sourceId: task.id, targetId: signature, type: 'contributes-to-signature' });
    checkAndEscalate(signature, task.id, { repoRoot, now });
  }

  return { signature, category };
}

module.exports = {
  classifyRequeue,
  buildSignature,
  structuredSignalCategory,
  checkGpuContention,
  checkAndEscalate,
  normalizeReasonText,
  CAUSE_CATEGORIES,
  _resetFallbackRateLimitForTests,
};

// CLI: `node src/requeue-attribution.js classify <payloadPath>` -- so the Flask dashboard
// (python/dashboard/requeue_attribution_client.py) can record a MANUAL requeue, which
// otherwise never reaches this classifier at all (api_task_requeue is pure Python).
// payload: { task?, taskFile?, reasonHint, requeueWriter, actor, blockedStage? }.
// Prints the { signature, category } result as JSON. Best-effort: any failure exits 0
// with an empty object so a telemetry problem never breaks a requeue on the caller side.
if (require.main === module) {
  (async () => {
    try {
      const [event, payloadPath] = process.argv.slice(2);
      if (event !== 'classify' || !payloadPath) {
        process.stderr.write('Usage: node requeue-attribution.js classify <payloadPath>\n');
        process.exit(1);
      }
      const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
      let task = payload.task;
      if (!task && payload.taskFile && fs.existsSync(payload.taskFile)) {
        task = JSON.parse(fs.readFileSync(payload.taskFile, 'utf8'));
      }
      const repoRoot = process.env.AGENT_MANAGER_PIPELINE_DIR || process.env.AGENT_MANAGER_REPO_ROOT;
      const result = await classifyRequeue(task || {}, {
        reasonHint: payload.reasonHint,
        blockedStage: payload.blockedStage || null,
        requeueWriter: payload.requeueWriter || 'operator-manual',
        actor: payload.actor || 'operator-manual',
        skipFallbackModel: true,
        repoRoot,
      });
      process.stdout.write(JSON.stringify(result || {}));
    } catch (e) {
      process.stdout.write('{}');
    }
  })();
}
