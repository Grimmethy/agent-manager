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
// This module ONLY detects and describes -- it never touches queue/ files itself. The
// filed task's own implement pass produces a real recommendation ('archive' or 'worth a
// fresh investigation') which, once it clears an independent review vote, DOES have a
// real automatic effect (2026-08-23, Grimmethy: "We need to remove the human part of that
// step" -- see staleness-auto-archive.js for the actual archiving mechanism and its
// safety scoping; this module still never performs that action itself).

const path = require('path');
const { execFileSync } = require('child_process');
const { REASON_CATEGORIES } = require('./pipeline-self-audit.js');
const { extractFilePaths, resolveAgainstRepo } = require('./fact-checker.js');

// Lowered from 14 (2026-08-23, Grimmethy: "Yes, lower the default" -- after confirming
// live that the first real candidate, adhoc-brain-dump-bd-1786742554232, had been
// genuinely dead since 2026-08-14 with zero real developments, yet its CORRECTED age
// (lastActivityTs's own exhausted-spam fix, same commit range) was only ~9 days --
// still under the old 14-day threshold. 7 days catches that case with margin while
// staying well clear of a task still in normal active back-and-forth.
const DEFAULT_STALENESS_THRESHOLD_DAYS = 7;
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

// Stages that mean "retries stopped happening," not "something happened" -- excluded
// from lastActivityTs below. Found live 2026-08-23 (Grimmethy: "analyze the staleness
// criteria to make sure it recognizes tasks like that as stale"): the very first real
// staleness_audit candidate (adhoc-brain-dump-bd-1786742554232, "agent manager is doing
// project searches...") has 2,756 near-identical 'exhausted' entries, fired roughly every
// 30s for 25 hours straight (2026-08-16T20:32 to 2026-08-17T21:38) by a since-fixed
// reject-retry-check.js bug (see that file's own `alreadyStamped` guard comment -- it no
// longer re-stamps a task that's already exhausted, but existing tasks from before that
// fix still carry the old spam in their history). Blindly taking max(history[].at) read
// this task as "5 days old" (the last spam ping) when its real last substantive activity
// was 2026-08-14 -- 9 days old, and its underlying concern hasn't moved since. A retry
// storm should make a task look MORE stuck, never fresher; 'exhausted' is explicitly a
// "no further attempts will happen" marker, the opposite of progress, so it can never be
// the most recent signal used to judge how stale something is.
const NON_PROGRESS_STAGES = new Set(['exhausted']);

// The last real forward-progress timestamp for a task -- history[]'s own last entry NOT
// in NON_PROGRESS_STAGES above (whatever real stage it's in: blocked, needs-clarification,
// a retry's plan-done, etc.), NOT createdAt, so a task that's old but still actively
// retrying doesn't count as stale. Falls back to createdAt only when history is missing/
// empty, or every entry is a non-progress marker (a task that NEVER did anything but
// exhaust retries) -- logged nowhere specifically, but both cases are unusual enough that
// treating it as "last touched at creation" is the safe, conservative read.
function lastActivityTs(task) {
  const hist = Array.isArray(task.history) ? task.history : [];
  const timestamps = hist
    .filter((h) => !NON_PROGRESS_STAGES.has(h.stage))
    .map((h) => Date.parse(h.at))
    .filter((t) => Number.isFinite(t));
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

// Third criterion, added 2026-08-23 (Grimmethy: "we very likely have other adhoc tasks
// that are just stuck" -- confirmed live: 167 of 213 real blocked tasks, 78%, already
// carry this marker) -- reject-retry-check.js stamps 'exhausted' on a task once it's
// used up its MAX_ORNITH_REJECT_RETRIES (2) automatic review-rejection retries; from
// that point on, NOTHING in this pipeline will ever touch it again on its own,
// regardless of how young it is. Age and fabrication-repeat both needed real time (or a
// specific rejection reason) to accumulate before catching a task -- this catches the
// pipeline's own explicit "I have given up on this automatically" signal the instant it
// fires, closing the exact backlog gap a fresh 7-day-old task with genuinely no future
// would otherwise sit in, uncaught, for up to a week.
function hasExhaustedRetries(task) {
  const hist = Array.isArray(task.history) ? task.history : [];
  return hist.some((h) => h.stage === 'exhausted');
}

const GIT_LOG_TIMEOUT_MS = 15_000;

// Real file paths a task's own text mentions -- reuses fact-checker.js's own extraction
// (same PATH_EXT_RE regex checkFilePaths already runs at review time) rather than a
// second, possibly-inconsistent implementation. Pulls from every place a task's own
// concern is described in free text: the original request, the title, the reason it got
// blocked, and any accumulated rejection feedback.
function candidateFilePaths(task) {
  const ctx = task.promptContext || {};
  const feedback = Array.isArray(task.priorRejectionFeedback)
    ? task.priorRejectionFeedback.join(' ')
    : (task.priorRejectionFeedback || '');
  const text = [ctx.rawText, task.title, task.blockedReason, feedback].filter(Boolean).join('\n');
  return extractFilePaths(text);
}

// Fourth criterion, added 2026-08-23 (Grimmethy: "What really makes a task stale is if
// it's already been completed or redundant in some way. How do we check for that?") --
// the other three criteria are all proxies for "the pipeline gave up trying," not the
// actual thing that matters: has the concern this task describes already been addressed
// by OTHER work since. This is the one deterministic, git-based signal for that: if a
// real file this task's own text names was genuinely committed to AFTER the task was
// filed, that's strong evidence something already touched the area it's about,
// independent of age/retries/fabrication (the young-and-already-resolved case none of
// the other three would ever catch). Deliberately still just a SIGNAL, not a verdict --
// the actual "is this really resolved" judgment stays with the filed task's own
// harness-grounded premise-recheck pass (real current file content, not just "was it
// committed"), same division of labor as every other criterion here.
//
// Needs real repo access (git log), unlike the other three pure-JSON criteria -- takes
// repoRoot explicitly rather than reading getConfig() itself, so this file stays fully
// testable without a real repo unless a caller actually wants this check. Best-effort:
// any git failure (not a real repo, a file genuinely untracked, git itself unavailable)
// is non-fatal, same philosophy every other git call in this pipeline already follows --
// returns {touched: false, files: []} rather than throwing.
function findFilesTouchedSince(repoRoot, task) {
  const createdAtIso = task.createdAt;
  if (!repoRoot || !createdAtIso || Number.isNaN(Date.parse(createdAtIso))) {
    return { touched: false, files: [] };
  }

  const claimedPaths = candidateFilePaths(task);
  const touchedFiles = [];
  for (const claimed of claimedPaths) {
    const resolved = resolveAgainstRepo(repoRoot, claimed);
    if (!resolved) continue; // not a real file in this repo -- nothing to check against
    const relPath = path.relative(repoRoot, resolved);
    try {
      const out = execFileSync(
        'git', ['log', `--since=${createdAtIso}`, '--oneline', '-1', '--', relPath],
        { cwd: repoRoot, encoding: 'utf8', timeout: GIT_LOG_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      if (out.trim()) touchedFiles.push(relPath);
    } catch (e) {
      // best-effort -- one file's git error must not abort checking the rest
    }
  }
  return { touched: touchedFiles.length > 0, files: touchedFiles };
}

// One entry per task that survives ANY condition -- reasons records which one(s) fired
// (a task can be old AND a repeat fabricator AND possibly-resolved) so the filed task's
// own text can be specific about why it was flagged, rather than a generic "this looked
// stale." opts.repoRoot is optional and opt-in: when omitted (every existing test, and
// any caller that doesn't have/want real git access), the possibly-resolved check is
// skipped entirely -- this file stays fully testable with zero git dependency unless a
// caller actually asks for it.
// Sources that produce a REPORT about another task rather than a standalone code claim
// -- 2026-08-24, Grimmethy: "Why is worker-1 doing drafting tasks when there are tasks in
// pending?" led to finding a real staleness_audit task auditing ANOTHER staleness_audit
// task live in drafting/. Mechanism: a staleness_audit task's own evidenceText
// necessarily quotes real repo file paths (describing the ORIGINAL flagged task it's
// about), so findFilesTouchedSince's git-log check false-positives on those quoted
// paths, flagging the audit itself as 'possibly-resolved' -- but "is this report still
// relevant" is a meaningless question for a source whose entire output IS a verdict
// about a DIFFERENT task, not a code claim later commits could resolve (unlike
// observability_review/performance_review, whose findings genuinely can become moot --
// see staleness-fastpath.js's own deterministic recheck for exactly that case). Excluded
// entirely from candidacy rather than merely handled, since there is no real question
// here to answer, deterministically or otherwise.
const SELF_AUDIT_SOURCES = new Set(['staleness_audit', 'pipeline_self_audit']);

function findStalenessCandidates(tasks, coverage = {}, now = Date.now(), { repoRoot } = {}) {
  const threshold = stalenessThresholdMs();
  const cooldown = cooldownMs();
  const candidates = [];
  for (const task of tasks) {
    if (!task || !task.id) continue;
    if (SELF_AUDIT_SOURCES.has(task.source)) continue;
    const reasons = [];
    if (isStaleByAge(task, now, threshold)) reasons.push('stale-age');
    if (isFabricationRepeat(task)) reasons.push('fabrication-repeat');
    if (hasExhaustedRetries(task)) reasons.push('retries-exhausted');
    let touchedFiles = [];
    if (repoRoot) {
      const gitCheck = findFilesTouchedSince(repoRoot, task);
      if (gitCheck.touched) {
        reasons.push('possibly-resolved');
        touchedFiles = gitCheck.files;
      }
    }
    if (reasons.length === 0) continue;

    const covered = coverage[task.id];
    if (covered && covered.reportedAt) {
      const reportedMs = Date.parse(covered.reportedAt);
      if (Number.isFinite(reportedMs) && now - reportedMs < cooldown) continue;
    }

    candidates.push({ task, reasons, lastActivityTs: lastActivityTs(task), touchedFiles });
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
  // 2026-08-23, Grimmethy: "What really makes a task stale is if it's already been
  // completed or redundant in some way. How do we check for that?" -- surfaced directly
  // here (not left for the premise-recheck to rediscover on its own) so the model's own
  // grep queries start from a concrete lead instead of guessing which files to check.
  if (candidate.touchedFiles && candidate.touchedFiles.length > 0) {
    lines.push('', `Real commits landed AFTER this task was created, touching file(s) it names: ${candidate.touchedFiles.join(', ')} -- strong evidence something already addressed this, though NOT a confirmed verdict on its own; verify against the real current content of these files.`);
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
      // Which QUEUE domain the flagged task itself belongs to (adhoc, project_search,
      // default, ...) -- NOT this staleness-audit task's own `domain` above (always
      // defaultDomain). Threaded through to markStalenessAuditReported() so coverage can
      // track per-domain throughput -- see pickFairCandidate()'s own header for why.
      originalDomain: task.domain || null,
      // Structured, dashboard-renderable fields (2026-08-22, Grimmethy: "I don't have
      // information in the task page about when it was actually set up") -- alongside
      // evidenceText's prose version below (what the MODEL reads), so the dashboard can
      // show the original task's real dates directly without parsing prose.
      originalTitle: task.title || null,
      originalCreatedAt: task.createdAt || null,
      originalLastActivityAt: lastTs != null ? new Date(lastTs).toISOString() : null,
      // Stamped so local-draft.js's deterministic-recheck short-circuit (see
      // staleness-fastpath.js's own header) can re-run the ORIGINAL scanner rule against
      // current file content without a second queue read -- every task JSON this package
      // writes is meant to be self-contained (see task-sources.js's own header), and this
      // is exactly the same "embed what a later step needs, don't make it re-fetch"
      // principle every other promptContext field here already follows.
      originalSource: task.source || null,
      originalRule: (task.promptContext && task.promptContext.rule) || null,
      originalFile: (task.promptContext && task.promptContext.file) || null,
      reasons,
      evidenceText: buildStalenessEvidenceText(candidate),
    },
  };
}

// Picks which candidate to file a report for next -- 2026-08-23, Grimmethy: "So why then
// does adhoc tasks still show 35 blocked? It hasn't gone down." Found live: plain
// oldest-first (candidates[0] after findStalenessCandidates' own age-sort) meant whichever
// domain happened to contain the globally-oldest neglected task kept winning every single
// tick -- coverage showed 8 straight project_search picks in a row while 28 real, evidenced
// adhoc candidates (16 with concrete git-log proof) sat untouched simply because they
// weren't quite as old. Age alone isn't fair across domains with very different task
// volumes/lifecycles.
//
// Fix: group by task.domain, rank domains by how long it's been since THAT domain last
// had a report filed (never-reported domains first, ties by real age) using coverage's own
// `domain`+`reportedAt` fields (see markStalenessAuditReported, task-sources.js), then pick
// the oldest candidate within the most-overdue domain. A domain with a huge, ancient
// backlog no longer permanently starves every other domain's real candidates.
function pickFairCandidate(candidates, coverage = {}) {
  if (!candidates || candidates.length === 0) return null;

  const domainLastReportedMs = {};
  for (const entry of Object.values(coverage)) {
    if (!entry || !entry.domain || !entry.reportedAt) continue;
    const ts = Date.parse(entry.reportedAt);
    if (!Number.isFinite(ts)) continue;
    if (!(entry.domain in domainLastReportedMs) || ts > domainLastReportedMs[entry.domain]) {
      domainLastReportedMs[entry.domain] = ts;
    }
  }

  const ranked = candidates.slice().sort((a, b) => {
    const domainA = a.task.domain || '(none)';
    const domainB = b.task.domain || '(none)';
    // A domain with no prior report at all is maximally overdue -- sorts before any
    // domain with a real reportedAt, however old.
    const lastA = domainA in domainLastReportedMs ? domainLastReportedMs[domainA] : -Infinity;
    const lastB = domainB in domainLastReportedMs ? domainLastReportedMs[domainB] : -Infinity;
    if (lastA !== lastB) return lastA - lastB;
    return (a.lastActivityTs || 0) - (b.lastActivityTs || 0);
  });
  return ranked[0];
}

module.exports = {
  DEFAULT_STALENESS_THRESHOLD_DAYS,
  DEFAULT_COOLDOWN_DAYS,
  stalenessThresholdMs,
  cooldownMs,
  lastActivityTs,
  isStaleByAge,
  isFabricationRepeat,
  hasExhaustedRetries,
  candidateFilePaths,
  findFilesTouchedSince,
  findStalenessCandidates,
  SELF_AUDIT_SOURCES,
  buildStalenessEvidenceText,
  buildStalenessAuditTask,
  pickFairCandidate,
};
