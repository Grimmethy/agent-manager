'use strict';

// Deterministic "detector" half of the self-improving pipeline loop (Grimmethy,
// 2026-08-19: "How can we turn this into a self improving process?", after a manual
// session found 92% of arch_import blocked tasks were dying to the same
// grep-codebase-tool.js bug). Scans queue/blocked/ for clusters of tasks failing the SAME
// underlying way and, once a cluster is large enough to be confident it's systemic (not
// one bad draft), files a task describing the evidence and asking a model to find the
// root cause and fix it.
//
// MOVED OFF CLAUDE 2026-08-20 (Grimmethy: "Is pipeline self audit dependent entirely on
// using the claude subscription? If so, change it to rely on the reasoning model itself,
// even if local" -- confirmed live: it was, structurally, since domain:'adhoc' always
// routes to the real agentic Claude Code CLI pass, and a Claude rate-limit that stalled
// worker-reasoning's whole high-tier lane was directly why self-audit hadn't fired since
// the prior restart). Now uses the SAME harness-grounded Ornith flow arch_import already
// runs successfully against this pipeline's own repo (task-sources.js's arch-import-fetch.js
// via grep-codebase-tool.js): a plan pass proposes search terms from the evidence below,
// the harness greps this pipeline's OWN repo for real matches, and the implement pass
// drafts a real Group-B diff grounded ONLY in what was actually found -- see
// pipelineSelfAuditPlanPrompt/pipelineSelfAuditImplementPrompt (prompts.js) and
// task-sources.js's harness-search branch for task.source === 'pipeline_self_audit'.
//
// This module ONLY detects and describes -- it never edits pipeline code and never
// touches queue/ files itself. apply-task.js's own awaiting-confirm gate (checked on
// task.source === 'pipeline_self_audit' specifically, not on domain any more, since this
// no longer runs through the domain:'adhoc' path that used to carry that gate for free)
// still holds any real resulting diff for explicit human confirmation before it can
// touch git or disk, regardless of AGENT_MANAGER_INCLUDE_APPLY/approval-mode settings --
// draft-and-propose only, by construction, not by a rule this module has to remember to
// follow.
//
// Detection is never a verdict that the underlying blocked tasks were WRONG to be
// blocked -- a human (or the audit task's own drafting pass) judges that. This only
// answers "are a lot of tasks dying the same avoidable way, worth a human's attention as
// one pattern instead of N separate one-offs."

const CLUSTER_THRESHOLD = 5; // below this, "a pattern" is indistinguishable from a handful of independently bad drafts
const MAX_EXAMPLES = 5;
const MAX_REASON_CHARS = 220;

// Checked first, from task.history rather than free-text blockedReason -- a precise,
// mechanical signal (same one that found the grep-codebase-tool.js bug) rather than a
// keyword guess.
function hasZeroHitHarnessSearch(task) {
  const hist = Array.isArray(task.history) ? task.history : [];
  return hist.some((h) => h.stage === 'harness-search' && /\b0\s+(hit|result)\(s\)/.test(h.detail || ''));
}

// Keyword categories over blockedReason text, same ones used by hand triaging this
// session's blocked queue, in the same priority order (a fabricated claim is more
// actionable to report on its own than a generic "refusal", so it's checked first).
const REASON_CATEGORIES = [
  { key: 'fabricated-ungrounded-claim', keywords: ['fabricat', 'hallucinat', 'unverified claim', 'ungrounded'] },
  { key: 'refusal-no-changes-needed', keywords: ['no-changes-needed', 'refus'] },
  { key: 'empty-degenerate-draft', keywords: ['empty', 'degenerate', 'no actual implementation', 'no implementation', 'no code'] },
  { key: 'truncated-draft', keywords: ['truncat'] },
  { key: 'inconclusive-review', keywords: ['inconclusive'] },
];

function categorizeBlockedReason(reason) {
  const lower = (reason || '').toLowerCase();
  for (const { key, keywords } of REASON_CATEGORIES) {
    if (keywords.some((kw) => lower.includes(kw))) return key;
  }
  return null;
}

// One signature per task -- null means "not confidently categorizable, skip it." A
// genuinely unique/ambiguous blocked task is exactly the kind of thing that needs a
// human's own judgment, not a pattern report.
function signatureForTask(task) {
  if (hasZeroHitHarnessSearch(task)) return `${task.source || 'unknown'}::harness-search-zero-results`;
  const category = categorizeBlockedReason(task.blockedReason);
  return category ? `${task.source || 'unknown'}::${category}` : null;
}

// coverage: { [signature]: { reportedAt, taskId } } -- signatures already turned into an
// audit task are skipped forever (this module reports a pattern once; whether the
// resulting fix actually worked is for a human/the next tick's real queue state to show,
// not something this deterministic pass re-derives).
function findAuditClusters(blockedTasks, coverage = {}) {
  const bySignature = new Map();
  for (const task of blockedTasks) {
    const sig = signatureForTask(task);
    if (!sig) continue;
    if (!bySignature.has(sig)) bySignature.set(sig, []);
    bySignature.get(sig).push(task);
  }

  const clusters = [];
  for (const [signature, tasks] of bySignature.entries()) {
    if (tasks.length < CLUSTER_THRESHOLD) continue;
    if (coverage[signature]) continue;
    clusters.push({ signature, tasks });
  }
  // Largest cluster first -- generators here return one task per source per tick (same
  // shape every other next*Task() follows), so if only one audit task gets filed this
  // tick, it should be the most-evidenced pattern.
  clusters.sort((a, b) => b.tasks.length - a.tasks.length);
  return clusters;
}

// Neither the plan pass nor the harness-fetch step below has any access to the live
// queue/ directory (it's gitignored, not part of what a repo grep or file read can ever
// see) -- every piece of evidence about the FAILURE PATTERN itself has to be embedded
// directly in this text. The harness-fetch step does separately provide real access to
// this pipeline's own SOURCE code (see task-sources.js's harness-search branch), just
// never to queue/ task-state files.
function buildAuditRawText(cluster) {
  const { signature, tasks } = cluster;
  const sepIdx = signature.lastIndexOf('::');
  const source = signature.slice(0, sepIdx);
  const category = signature.slice(sepIdx + 2);
  const examples = tasks.slice(0, MAX_EXAMPLES).map((t) => {
    const reason = (t.blockedReason || '(no blockedReason recorded)').slice(0, MAX_REASON_CHARS);
    return `- ${t.id}: ${reason}`;
  });
  const remainder = tasks.length - examples.length;

  return [
    `A deterministic scan of this pipeline's own queue/blocked/ found ${tasks.length} tasks (source="${source}") all failing the SAME way: ${category}.`,
    '',
    'Example blocked tasks (id: blockedReason, truncated):',
    ...examples,
    remainder > 0 ? `...and ${remainder} more with the same signature.` : '',
    '',
    'This many tasks failing identically usually means the root cause is in this ' +
      'pipeline\'s OWN code (a harness/fetch bug, a prompt gap, a broken tool) rather ' +
      'than every one of these tasks independently being a bad idea -- the precedent for ' +
      'this exact shape of bug is grep-codebase-tool.js, found 2026-08-19: it silently ' +
      'returned zero search results for 92% of arch_import tasks (only JS/TS file ' +
      'extensions were searched, and multi-word queries never exact-matched a line of ' +
      'real code), which every one of those blocked tasks correctly reported as "no ' +
      'grounding available" -- the individual drafts were not wrong, the tool feeding ' +
      'them was.',
    '',
  ].filter(Boolean).join('\n');
}

// domain must be the consumer's real defaultDomain (task-sources.js's getConfig() value,
// same 'default' key deep_dive/arch_import/observability_review etc. already use) --
// passed in rather than hardcoded here, matching every other next*Task() builder's own
// convention of not baking config into pipeline-self-audit.js's otherwise config-free
// pure functions.
function buildAuditTask(cluster, domain) {
  const { signature } = cluster;
  const sepIdx = signature.lastIndexOf('::');
  const source = signature.slice(0, sepIdx);
  const category = signature.slice(sepIdx + 2);
  const id = `pipeline-self-audit-${source}-${category}-${Date.now()}`;
  return {
    id,
    domain,
    source: 'pipeline_self_audit',
    title: `Pipeline self-audit: ${cluster.tasks.length} "${source}" tasks blocked the same way (${category})`,
    promptContext: {
      evidenceText: buildAuditRawText(cluster),
      signature,
      taskCount: cluster.tasks.length,
    },
  };
}

module.exports = {
  CLUSTER_THRESHOLD,
  hasZeroHitHarnessSearch,
  categorizeBlockedReason,
  signatureForTask,
  findAuditClusters,
  buildAuditRawText,
  buildAuditTask,
};
