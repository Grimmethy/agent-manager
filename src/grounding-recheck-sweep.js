'use strict';

// grounding-recheck-sweep.js -- give a task ANY registered postImplementCheck grounding
// gate blocked a real second chance, instead of leaving it stuck forever.
//
// Why (2026-09-28): local-draft.js stamps task.reviewInconclusive = true whenever a
// registered postImplementCheck (deep_dive's runDeepDiveGroundingCheck, pipeline_debrief's
// runPipelineDebriefSoWhatCheck, function_length_review's runGroundingCheck in the hygiene
// plugin) returns verdict:'ungrounded'/'invalid-premise' -- deliberately, per that site's
// own comment: "a re-roll-worthy gate flake, not a genuine reviewer REJECT". But
// reject-retry-check.js's entire sweep entry gate excludes every reviewInconclusive task
// via isReviewRejection() (blockedStage==='review' && !task.reviewInconclusive), and the
// only re-roll mechanism ever built for a reviewInconclusive task,
// fabricated-path-recheck-sweep.js, is scoped to ONE specific gate (a fabricated-file-path
// detector that re-derives file existence directly, never calls a registered
// postImplementCheck at all). Every OTHER grounding gate's rejection has had NO re-roll
// path -- confirmed live: the function_length_review task for src/git-runner.js:53 and all
// 12 currently-blocked pipeline_debrief tasks carry reviewInconclusive:true on their
// current block and have never once reached needs-clarification/exhausted despite genuine
// grounding rejections, because they never reach reject-retry-check.js's downstream
// classification/exhaustion/escalation logic at all.
//
// This sweep is source-agnostic: it looks up whatever postImplementCheck IS registered for
// a task's own source and re-runs it against the task's EXISTING implementResponse (no
// fresh draft). If the check now says 'ok' (e.g. because the check itself was fixed, like
// pipeline-debrief-so-what-check.js's contrastIds/slug-fragment widening earlier this
// session), the task is released straight to approved/ -- no redraft, no model call beyond
// the recheck itself. If it is still ungrounded, the task gets exactly ONE real,
// properly-tracked redraft chance (localRejectCount bumped, reviewInconclusive cleared, so
// a genuine reviewer rejection on the next attempt is no longer invisible to
// reject-retry-check.js). A SECOND failure escalates to needs-clarification, except for
// pipeline_debrief/pipeline_forensics (REVIEW_VERDICT_ADVISORY_PROSE_EXCLUDED), which
// reject-retry-check.js's own design already treats as "usually already moot by the time
// they exhaust" -- those are marked exhausted and left in blocked/ instead.
//
// Kill switch: AGENT_MANAGER_GROUNDING_RECHECK=false. CLI: node grounding-recheck-sweep.js [--dry-run]

const fs = require('fs');
const path = require('path');
const { getRegisteredSource, resolveSourceName } = require('./task-source-registry.js');
const {
  isReviewVerdictAdvisoryProseSource, buildExhaustedReviewVerdictQuestion,
} = require('./reject-retry-check.js');

// Registers this package's built-in sources FIRST (side effect of the require) -- a
// consumer's own plugin-registered sources (function_length_review, in the hygiene
// plugin) are then covered by ensureRegistered() below. Without both, a standalone
// `node grounding-recheck-sweep.js` process gets an empty registry and every
// getRegisteredSource() lookup for a plugin source silently returns undefined --
// the exact gap reject-retry-check.js's own header documents fixing for itself.
require('./task-sources.js');
try { require('./config.js').ensureRegistered(); } catch { /* no live config (e.g. a unit test) -- fine, nothing to register */ }

const REVIEW_VERDICT_ADVISORY_PROSE_EXCLUDED = new Set(['pipeline_forensics', 'pipeline_debrief']);
const DIRS = ['blocked', 'needs-clarification'];

const enabled = () => process.env.AGENT_MANAGER_GROUNDING_RECHECK !== 'false';
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function writeJson(p, data) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(data, null, 2)); }

function isAdhocTask(task) { return task && task.domain === 'adhoc'; }

function appendHistoryEvent(task, stage, detail) {
  task.history = Array.isArray(task.history) ? task.history : [];
  const event = { stage, at: new Date().toISOString() };
  if (detail !== undefined) event.detail = detail;
  task.history.push(event);
}

// { pipelineDir, approvedDir?, needsClarificationDir?, adhocDir?, derivedDir?, pendingDir?, now?, dryRun? } -> Promise<summary>
async function sweepGroundingRecheck({
  pipelineDir, approvedDir, needsClarificationDir, adhocDir, derivedDir, pendingDir,
  now = new Date(), dryRun = false,
} = {}) {
  const summary = { checked: 0, recovered: [], requeued: [], exhausted: [], errors: 0 };
  if (!enabled() || !pipelineDir) return summary;
  const queueDir = path.join(pipelineDir, 'queue');
  const approvedDirResolved = approvedDir || path.join(queueDir, 'approved');
  const needsClarificationDirResolved = needsClarificationDir || path.join(queueDir, 'needs-clarification');
  const pendingDirResolved = pendingDir || path.join(queueDir, 'pending');
  const adhocDirResolved = adhocDir || path.join(queueDir, 'adhoc');
  const derivedDirResolved = derivedDir || path.join(queueDir, 'derived');
  const nowIso = now.toISOString();

  // Snapshot BOTH dirs' listings up front -- this sweep's own escalation path writes into
  // needs-clarification/, one of the two dirs it scans, so reading each dir lazily inside
  // one shared outer loop would pick up a file THIS SAME RUN just wrote there moments ago
  // and process it a second time (confirmed live while writing this sweep's own tests).
  const entries = [];
  for (const dir of DIRS) {
    const stateDir = path.join(queueDir, dir);
    let names;
    try { names = fs.readdirSync(stateDir).filter((f) => f.endsWith('.json')); } catch { continue; }
    for (const name of names) entries.push({ dir, stateDir, name });
  }

  for (const { dir, stateDir, name } of entries) {
    const filePath = path.join(stateDir, name);
    const task = readJson(filePath);
    if (!task || typeof task !== 'object') continue;
    if (task.reviewInconclusive !== true || task.blockedStage !== 'review') continue;
    if (!task.implementResponse) continue;

    let source;
    try { source = getRegisteredSource(resolveSourceName(task)); } catch { source = null; }
    if (!source || typeof source.postImplementCheck !== 'function') continue;

    summary.checked += 1;

    try {
      if (task.groundingRecheckAttempted === true) {
        // Second failure -- already had one free recheck + one real redraft chance.
        if (REVIEW_VERDICT_ADVISORY_PROSE_EXCLUDED.has(task.source)) {
          const alreadyStamped = Array.isArray(task.history) && task.history.some((h) => h.stage === 'exhausted');
          if (alreadyStamped) continue;
          appendHistoryEvent(task, 'exhausted', 'grounding-recheck-sweep: still ungrounded after one redraft chance -- pipeline_debrief/pipeline_forensics windows are usually already moot by the time they exhaust, left in blocked/ rather than escalated');
          if (!dryRun) fs.writeFileSync(filePath, JSON.stringify(task, null, 2));
          summary.exhausted.push({ id: task.id, from: dir, disposition: 'moot' });
          continue;
        }
        const openQuestions = isReviewVerdictAdvisoryProseSource(task.source)
          ? buildExhaustedReviewVerdictQuestion(task)
          : [`This task's grounding gate rejected it again after one redraft chance: ${String(task.blockedReason || '(no detail)')}`];
        task.needsClarification = { reason: 'fabricated-ungrounded-claim', openQuestions };
        appendHistoryEvent(task, 'exhausted', 'grounding-recheck-sweep: still ungrounded after one redraft chance');
        appendHistoryEvent(task, 'needs-clarification', 'escalated to a human after a recheck-granted redraft failed the same grounding gate again');
        if (!dryRun) {
          const dest = path.join(needsClarificationDirResolved, name);
          writeJson(dest, task);
          fs.unlinkSync(filePath);
        }
        summary.exhausted.push({ id: task.id, from: dir, disposition: 'needs-clarification' });
        continue;
      }

      // First time -- re-run the registered check against the EXISTING implementResponse.
      let grounding;
      try {
        grounding = await source.postImplementCheck(task, task.implementResponse, {});
      } catch {
        grounding = null; // same fail-safe local-draft.js's own call site uses: a throw is never a block.
      }
      const stillUngrounded = grounding && (grounding.verdict === 'ungrounded' || grounding.verdict === 'invalid-premise');

      if (!stillUngrounded) {
        // RECOVERED -- mirrors reject-retry-check.js's deterministicReviewRecoveryCheck release shape.
        task.reviewedAt = nowIso;
        task.reviewProvider = 'grounding-recheck-sweep';
        task.localVerdict = 'Auto-approved on re-check: the registered grounding gate that originally blocked this now passes the existing (unchanged) implementResponse -- no redraft needed.';
        delete task.blockedReason;
        delete task.blockedStage;
        delete task.reviewInconclusive;
        appendHistoryEvent(task, 'approved', 'grounding-recheck-sweep: re-ran the registered postImplementCheck against the existing implementResponse, now passes');
        if (!dryRun) {
          const dest = path.join(approvedDirResolved, name);
          writeJson(dest, task);
          fs.unlinkSync(filePath);
        }
        summary.recovered.push({ id: task.id, from: dir });
        continue;
      }

      // Still genuinely ungrounded -- one real, properly-tracked redraft chance.
      task.groundingRecheckAttempted = true;
      delete task.reviewInconclusive;
      delete task.planResponse;
      delete task.implementResponse;
      task.priorRejectionFeedback = Array.isArray(task.priorRejectionFeedback) ? task.priorRejectionFeedback : [];
      task.priorRejectionFeedback.push(String(grounding.reason || task.blockedReason || '(no detail)'));
      task.localRejectCount = (Number(task.localRejectCount) || 0) + 1;
      delete task.blockedStage;
      delete task.blockedReason;
      task.status = 'pending';
      appendHistoryEvent(task, 'requeued', 'grounding-recheck-sweep: still ungrounded on recheck -- one real redraft chance granted, reviewInconclusive cleared');
      const destDir = task.source === 'derived_task' ? derivedDirResolved : isAdhocTask(task) ? adhocDirResolved : pendingDirResolved;
      if (!dryRun) {
        const dest = path.join(destDir, name);
        writeJson(dest, task);
        fs.unlinkSync(filePath);
      }
      summary.requeued.push({ id: task.id, from: dir });
    } catch (e) {
      summary.errors += 1;
      console.error(`[grounding-recheck-sweep] ${task && task.id || name}: ${e.message}`);
    }
  }
  return summary;
}

module.exports = { sweepGroundingRecheck };

if (require.main === module) {
  const { getConfig } = require('./config.js');
  const cfg = getConfig();
  const dryRun = process.argv.includes('--dry-run');
  sweepGroundingRecheck({ pipelineDir: cfg.pipelineDir, dryRun }).then((s) => {
    process.stdout.write(`checked=${s.checked} recovered=${s.recovered.length}${s.recovered.length ? ` [${s.recovered.map((r) => r.id).join(', ')}]` : ''} requeued=${s.requeued.length}${s.requeued.length ? ` [${s.requeued.map((r) => r.id).join(', ')}]` : ''} exhausted=${s.exhausted.length} errors=${s.errors}${dryRun ? ' (dry run)' : ''}\n`);
  }).catch((e) => { console.error('[grounding-recheck-sweep]', (e && e.stack) || e); process.exit(1); });
}
