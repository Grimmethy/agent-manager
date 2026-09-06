'use strict';

// Unified fault-side classifier registry (2026-09-06, Blocked-task root-cause
// classification concept, Design option A -- Grimmethy: "we have a lot of repeat
// offenders that keep ending up in blocked... if we get this working we can stop
// focusing entirely on agent-manager and start building up plugins").
//
// Before this file, exactly two mechanisms independently classified a blocked task,
// with no shared vocabulary: reject-retry-check.js's two bespoke structural gates
// (hasUnreliableGrounding, the external-dependency skip -- both inspect real
// structured task fields, added the same day this file was) and
// pipeline-self-audit.js's categorizeBlockedReason/REASON_CATEGORIES (a flat
// keyword-substring list against blockedReason TEXT only, feeding findAuditClusters'
// cluster-reporting). A category discovered in one never benefited the other.
//
// The organizing question every classifier answers, per the "Model or Harness"
// fault-localization research (arXiv 2607.28802): which side of the model/harness/
// environment boundary actually failed, and does that mean retrying could ever help?
// A harness bug (a fetch/anchor-matching/tool defect) or an environment gap (a missing
// external resource) will reproduce identically no matter how many times the SAME
// model is asked to redraft against the SAME broken input -- only a genuine model-side
// misstep (a hallucination, an incomplete edit, an empty response) is worth a blind
// retry at all. This is a GENERAL question askable about a failure shape not yet
// discovered, unlike a keyword list that only recognizes patterns someone already
// wrote a keyword for.
//
// Ordered, first-match-wins (same convention REASON_CATEGORIES already used) -- a
// fabricated claim is more actionable to report/escalate on its own than a generic
// refusal, so more specific/structural classifiers are checked first.

// Checked first, from task.history rather than free-text blockedReason -- a precise,
// mechanical signal (the one that found the real grep-codebase-tool.js bug, 2026-08-19)
// rather than a keyword guess. Kept RETRYABLE, deliberately: unlike an anchor-matcher
// running against unchanged file content, the PLAN pass proposes different search terms
// on each attempt, so a retry can genuinely surface different real results next time --
// same visible harness-side symptom, different retry-worthiness, exactly the
// distinction the Model-or-Harness research names.
function hasZeroHitHarnessSearch(task) {
  const hist = Array.isArray(task.history) ? task.history : [];
  return hist.some((h) => h.stage === 'harness-search' && /\b0\s+(hit|result)\(s\)/.test(h.detail || ''));
}

// 2026-09-06: root-caused live via pipeline-forensics-fix-ac-8 -- a candidate-fulfillment
// task whose cited code couldn't be anchor-matched in its target file at all
// (windowFetchedFileContent, src/sdk/candidate-fulfillment.js, falls back to
// confidence:'none': an unstructured blind slice of the file, explicitly prefixed
// "[LOW-CONFIDENCE GROUNDING: no reliable anchor found... may not contain the real
// target]"). The model correctly refused rather than fabricate an edit against
// admittedly-unreliable grounding -- but refreshCandidateFetchedFiles() re-derives the
// SAME deterministic anchor search from the SAME unchanged file on every retry, so a
// blind requeue can only ever reproduce identical grounding and fail identically.
// Structurally futile, not stochastically unlucky -- HARNESS-side, not retryable.
function hasUnreliableGrounding(task) {
  const fetchedFiles = task.promptContext && task.promptContext.fetchedFiles;
  return Array.isArray(fetchedFiles) && fetchedFiles.some((f) => f && f.anchorConfidence === 'none');
}

function buildUnreliableGroundingQuestion(task) {
  const fetchedFiles = (task.promptContext && task.promptContext.fetchedFiles) || [];
  const badFiles = fetchedFiles.filter((f) => f && f.anchorConfidence === 'none').map((f) => f.path).filter(Boolean);
  return [
    `The grounding-fetch could not find a reliable anchor for this candidate's cited code in `
      + `${badFiles.join(', ') || 'its target file'} -- every draft attempt sees the same `
      + 'unstructured, low-confidence file slice (a blind requeue cannot fix this; the anchor '
      + 'search is deterministic against unchanged file content), so this was escalated after '
      + 'ONE rejection instead of burning further identical retries.',
    '',
    'Likely causes: the candidate\'s own citation of the target code is stale or wrong (check '
      + 'whether the described code still exists, possibly already fixed by a sibling task), '
      + 'or the anchor-matching heuristic missed a real match that does exist. If the '
      + 'underlying issue is already resolved, Archive this task. If the citation is wrong but '
      + 'the issue is real, re-file the candidate with an accurate code citation.',
  ].join('\n');
}

// 2026-09-06: root-caused live via AC-16/AC-18 (real, duplicate pipeline_forensics_fix
// candidates) -- both assumed a prerequisite feature already existed in the codebase
// when it never did. src/candidate-premise-check.js's postImplementCheck wiring
// produces this exact "Invalid premise: " prefix (matching the wording
// finalizeCandidateFulfillment's own split-gated premiseCheck hook already uses) when a
// candidate's own stated claim about the current code doesn't hold up. ENVIRONMENT-side,
// not retryable: the false premise lives in the CANDIDATE itself (an earlier
// generation/forensics stage), not in this draft -- redrafting the same candidate
// against the same false premise reproduces the identical block every time.
function hasInvalidPremise(task) {
  return /^invalid premise:/i.test(String(task.blockedReason || '').trim());
}

function buildInvalidPremiseQuestion(task) {
  return [
    `This candidate's own Problem statement makes a claim about agent-manager's current `
      + `code that a deterministic/model check found does not hold up: `
      + `"${String(task.blockedReason || '').replace(/^invalid premise:\s*/i, '')}".`,
    '',
    'A blind redraft cannot fix this -- the false premise is in the candidate itself, not '
      + 'in how it was implemented. Check whether the premise was ever true (a prerequisite '
      + 'that was simply never built, or already superseded by a sibling task) and either '
      + 'Archive this candidate or re-file it with an accurate premise.',
  ].join('\n');
}

// Keyword categories over blockedReason text, same ones used by hand triaging this
// session's blocked queue, same priority order. faultSide:'model' -- a keyword match on
// the draft's own text/behavior -- and retryable:true for all five: no real evidence yet
// that any of them are mis-classified, so this pass makes their fault-side visible
// without changing any existing retry decision (see this file's own header for why that
// caution matters -- Design option B was explicitly deferred for the same reason).
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

// The full ordered classifier list. Each entry's `classify(task)` returns
// `{ category, faultSide, retryable }` or null (does not apply); `buildQuestion(task)`
// is only present on non-retryable entries that need to STAMP a fresh
// needsClarification themselves (a task already carrying one from an earlier gate --
// e.g. external-dependency, stamped at draft time -- never reaches buildQuestion; see
// classifyBlockedTask's own header).
const CLASSIFIERS = [
  {
    name: 'external-dependency',
    // Stamped at DRAFT time by local-agentic-write-draft.js's detectExternalDependency
    // (AC-13a) -- this classifier only RECOGNIZES it, never builds a fresh question;
    // the one already on the task (crafted with the specific external resource named)
    // must never be overwritten.
    classify(task) {
      if (task.needsClarification && task.needsClarification.reason === 'external-dependency') {
        return { category: 'external-dependency', faultSide: 'environment', retryable: false };
      }
      return null;
    },
  },
  {
    name: 'unreliable-grounding',
    classify(task) {
      if (hasUnreliableGrounding(task)) {
        return { category: 'unreliable-grounding', faultSide: 'harness', retryable: false };
      }
      return null;
    },
    buildQuestion: buildUnreliableGroundingQuestion,
  },
  {
    name: 'invalid-premise',
    classify(task) {
      if (hasInvalidPremise(task)) {
        return { category: 'invalid-premise', faultSide: 'environment', retryable: false };
      }
      return null;
    },
    buildQuestion: buildInvalidPremiseQuestion,
  },
  {
    name: 'harness-search-zero-results',
    classify(task) {
      if (hasZeroHitHarnessSearch(task)) {
        return { category: 'harness-search-zero-results', faultSide: 'harness', retryable: true };
      }
      return null;
    },
  },
  ...REASON_CATEGORIES.map(({ key, keywords }) => ({
    name: key,
    classify(task) {
      const lower = (task.blockedReason || '').toLowerCase();
      if (keywords.some((kw) => lower.includes(kw))) {
        return { category: key, faultSide: 'model', retryable: true };
      }
      return null;
    },
  })),
];

// The single entry point every consumer (reject-retry-check.js's retry-safety decision,
// pipeline-self-audit.js's cluster-reporting) should call instead of maintaining its
// own classification logic. Falls back to {category:'uncategorized', faultSide:'model',
// retryable:true} for anything not explicitly classified -- preserves the CURRENT
// blind-retry behavior for the unclassified majority, so adding this registry is
// additive, never a behavior change for a task no classifier recognizes.
function classifyBlockedTask(task) {
  for (const classifier of CLASSIFIERS) {
    const result = classifier.classify(task);
    if (result) return { ...result, classifierName: classifier.name };
  }
  return { category: 'uncategorized', faultSide: 'model', retryable: true, classifierName: null };
}

// signature format unchanged from pipeline-self-audit.js's own prior implementation
// (`${source}::${category}`) -- findAuditClusters/coverage/buildAuditTask all key off
// this exact shape, so this stays a pure delegation with zero behavior change there.
// One signature per task -- null means "not confidently categorizable, skip it." A
// genuinely unique/ambiguous blocked task is exactly the kind of thing that needs a
// human's own judgment, not a pattern report.
function signatureForTask(task) {
  const { category, classifierName } = classifyBlockedTask(task);
  if (!classifierName || category === 'uncategorized') return null;
  return `${task.source || 'unknown'}::${category}`;
}

// A classifier entry with a buildQuestion -- used by reject-retry-check.js to stamp a
// fresh needsClarification for a non-retryable classification that doesn't already
// carry one (unlike external-dependency, which is always pre-stamped at draft time).
function findClassifier(name) {
  return CLASSIFIERS.find((c) => c.name === name) || null;
}

module.exports = {
  CLASSIFIERS,
  REASON_CATEGORIES,
  classifyBlockedTask,
  categorizeBlockedReason,
  hasZeroHitHarnessSearch,
  hasUnreliableGrounding,
  hasInvalidPremise,
  signatureForTask,
  findClassifier,
};
