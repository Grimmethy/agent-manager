'use strict';

// Staleness audit: the per-task counterpart to pipeline-self-audit.js's per-CLUSTER
// detector (Grimmethy, 2026-08-22, "Build [this] now" -- see queue/blocked/
// adhoc-build-a-staleness-audit-... for the full spec this implements). Finds individual
// queue/blocked/ or queue/needs-clarification/ tasks whose underlying premise is likely
// no longer worth chasing -- either it's sat untouched past a staleness threshold, or it
// was rejected for fabrication/hallucination repeatedly -- and, for each one, files a real
// task asking the harness-grounded local model to recheck whether the concern still holds
// against CURRENT repo state (see task-sources.js's nextStalenessAuditTask() for how this
// module's pure functions get called, and local-draft.js's own 'staleness_audit' branch
// for the harness-grounded plan/implement pass that does the actual rechecking).
//
// Deliberately mirrors pipeline-self-audit.js's own shape (deterministic filter here, no
// model call; the real judgment call -- "is this still true" -- happens later, in the
// filed task's own harness-grounded draft pass, same division of labor pipeline_self_audit
// already uses) -- but the unit here is ONE TASK, not a cluster of >=5 sharing a failure
// signature, since staleness is a per-task property (age, its own rejection history) that
// clustering would only obscure.
//
// This module ONLY detects and describes -- it never touches queue/ files, never archives
// or requeues anything itself. The filed task's own implement pass is explicitly advisory
// ("here's what I found, you decide" -- see prompts.js's stalenessAuditImplementPrompt),
// and the human archives/requeues the ORIGINAL stale task themselves via the existing
// archive/requeue mechanism already on the Blocked/Needs-Clarification tabs.

const { REASON_CATEGORIES } = require('./pipeline-self-audit.js');

const DEFAULT_STALENESS_THRESHOLD_DAYS = 14;
const DEFAULT_COOLDOWN_DAYS = 21; // re-eligible after this long even if already reported once -- a
// human who leaves a flagged task blocked (rather than archiving it) hasn't resolved it,
// so this should surface again eventually rather than being suppressed forever, unlike
// pipeline_self_audit's own coverage (a systemic-bug report that's either fixed or not,
// with no "still relevant, just not actioned yet" middle state a single stale task has).
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const FABRICATION_KEYWORDS = REASON_CATEGORIES.find((c) => c.key === 'fabricated-ungrounded-claim').keywords;

function envDays(name, fallback) {
  const raw = process.env[name];
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}

function stalenessThresholdMs() {
  return envDays('AGENT_MANAGER_STALENESS_THRESHOLD_DAYS', DEFAULT_STALENESS_THRESHOLD_DAYS) * MS_PER_DAY;
}

function cooldownMs() {
  return envDays('AGENT_MANAGER_STALENESS_COOLDOWN_DAYS', DEFAULT_COOLDOWN_DAYS) * MS_PER_DAY;
}

// The last real forward-progress timestamp for a task -- history[]'s own last entry
// (whatever stage it's in: blocked, needs-clarification, a retry's plan-done, etc.), NOT
// createdAt, so a task that's old but still actively retrying doesn't count as stale.
// Falls back to createdAt only when history is missing/empty (malformed or pre-history
// task file) -- logged nowhere specifically, but a missing history is itself unusual
// enough that treating it as "last touched at creation" is the safe, conservative read.
function lastActivityTs(task) {
  const hist = Array.isArray(task.history) ? task.history : [];
  const timestamps = hist.map((h) => Date.parse(h.at)).filter((t) => Number.isFinite(t));
  if (timestamps.length > 0) return Math.max(...timestamps);
  const created = Date.parse(task.createdAt);
  return Number.isFinite(created) ? created : null;
}

function isStaleByAge(task, now, thresholdMs = stalenessThresholdMs()) {
  const last = lastActivityTs(task);
  if (last == null) return false; // no timestamp at all -- can't confidently call this stale, not a guess this module makes
  return now - last > thresholdMs;
}

// priorRejectionFeedback may be a string or an array of strings (see prompts.js's own
// priorRejectionBlock() handling of the same field) -- normalized to one lowercase blob
// alongside blockedReason so a single keyword scan covers both.
function isFabricationRepeat(task) {
  if (!((task.ornithRejectCount || 0) >= 2)) return false;
  const feedback = Array.isArray(task.priorRejectionFeedback)
    ? task.priorRejectionFeedback.join(' ')
    : (task.priorRejectionFeedback || '');
  const text = `${task.blockedReason || ''} ${feedback}`.toLowerCase();
  return FABRICATION_KEYWORDS.some((kw) => text.includes(kw));
}

// One entry per task that survives EITHER condition -- reasons records which one(s) fired
// (a task can be both old AND a repeat fabricator) so the filed task's own text can be
// specific about why it was flagged, rather than a generic "this looked stale."
function findStalenessCandidates(tasks, coverage = {}, now = Date.now()) {
  const threshold = stalenessThresholdMs();
  const cooldown = cooldownMs();
  const candidates = [];
  for (const task of tasks) {
    if (!task || !task.id) continue;
    const reasons = [];
    if (isStaleByAge(task, now, threshold)) reasons.push('stale-age');
    if (isFabricationRepeat(task)) reasons.push('fabrication-repeat');
    if (reasons.length === 0) continue;

    const covered = coverage[task.id];
    if (covered && covered.reportedAt) {
      const reportedMs = Date.parse(covered.reportedAt);
      if (Number.isFinite(reportedMs) && now - reportedMs < cooldown) continue;
    }

    candidates.push({ task, reasons, lastActivityTs: lastActivityTs(task) });
  }
  // Oldest last-activity first -- the longest-neglected task is the most overdue for a
  // human's attention, same "most-evidenced first" intent pipeline-self-audit.js's own
  // cluster sort has, just keyed on age instead of cluster size.
  candidates.sort((a, b) => (a.lastActivityTs || 0) - (b.lastActivityTs || 0));
  return candidates;
}

function formatAgeDays(ms) {
  return Math.floor(ms / MS_PER_DAY);
}

// Neither the plan pass nor the harness-fetch step has any access to queue/ (gitignored,
// not part of what a repo grep/read can ever see -- same constraint buildAuditRawText's
// own header documents for pipeline-self-audit.js) -- every piece of evidence about the
// ORIGINAL stale task has to be embedded directly in this text.
function buildStalenessEvidenceText(candidate, now = Date.now()) {
  const { task, reasons, lastActivityTs: lastTs } = candidate;
  const ageDays = lastTs != null ? formatAgeDays(now - lastTs) : null;
  const rawText = (task.promptContext && task.promptContext.rawText) || task.title || '(no title/rawText recorded)';
  // Absolute dates alongside the relative day-count (2026-08-22, Grimmethy: "I don't have
  // information in the task page about when it was actually set up" -- caught live, the
  // dashboard task detail page only ever showed the STALENESS-AUDIT task's own short
  // history, never the ORIGINAL flagged task's real creation/last-activity dates) --
  // "5 days old" stops being self-explanatory the moment someone reads this later than
  // the moment it was generated; an absolute date never does.
  const createdAtIso = task.createdAt || null;
  const lastActivityIso = lastTs != null ? new Date(lastTs).toISOString() : null;
  const lines = [
    `Original task ID: ${task.id}`,
    `Original title: ${task.title || '(none)'}`,
    `Original source: ${task.source || 'unknown'}`,
    `Original task created: ${createdAtIso || 'unknown (no createdAt recorded)'}`,
    lastActivityIso
      ? `Last forward progress: ${lastActivityIso} (${ageDays} day(s) ago)`
      : 'Last forward progress: unknown (no usable timestamp)',
    `Flagged because: ${reasons.join(', ')}`,
    `ornithRejectCount: ${task.ornithRejectCount != null ? task.ornithRejectCount : 0}`,
    '',
    'Original task text/request:',
    rawText,
    '',
    `Most recent blockedReason: ${task.blockedReason || '(none recorded)'}`,
  ];
  if (task.priorRejectionFeedback) {
    const feedback = Array.isArray(task.priorRejectionFeedback) ? task.priorRejectionFeedback : [task.priorRejectionFeedback];
    lines.push('', 'Prior rejection feedback:', ...feedback.map((f, i) => `${i + 1}. ${f}`));
  }
  return lines.join('\n');
}

// domain must be the consumer's real defaultDomain (task-sources.js's getConfig() value),
// passed in rather than hardcoded here -- same convention buildAuditTask (pipeline-self-
// audit.js) already follows.
function buildStalenessAuditTask(candidate, domain) {
  const { task, reasons, lastActivityTs: lastTs } = candidate;
  const id = `staleness-audit-${task.id}-${Date.now()}`;
  return {
    id,
    domain,
    source: 'staleness_audit',
    title: `Staleness audit: "${task.title || task.id}" (${reasons.join(', ')})`,
    promptContext: {
      originalTaskId: task.id,
      // Structured, dashboard-renderable fields (2026-08-22, Grimmethy: "I don't have
      // information in the task page about when it was actually set up") -- alongside
      // evidenceText's prose version below (what the MODEL reads), so the dashboard can
      // show the original task's real dates directly without parsing prose.
      originalTitle: task.title || null,
      originalCreatedAt: task.createdAt || null,
      originalLastActivityAt: lastTs != null ? new Date(lastTs).toISOString() : null,
      reasons,
      evidenceText: buildStalenessEvidenceText(candidate),
    },
  };
}

module.exports = {
  DEFAULT_STALENESS_THRESHOLD_DAYS,
  DEFAULT_COOLDOWN_DAYS,
  stalenessThresholdMs,
  cooldownMs,
  lastActivityTs,
  isStaleByAge,
  isFabricationRepeat,
  findStalenessCandidates,
  buildStalenessEvidenceText,
  buildStalenessAuditTask,
};
