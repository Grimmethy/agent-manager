'use strict';

// needs-clarification triage sweep (2026-09-04). queue/needs-clarification/ fills with
// reason:'design-decision' tasks that nothing works automatically -- path_prefetch_resolve
// only handles ambiguous/no-match, blocked-drain only requeues the exhausted-history
// subset once a fix signature lands, adhoc-staleness-flag only stamps, and
// decompose-loop-autoroute only does the oversized-file decompose-loop subset. So a
// design-decision task sits until a human clicks Answer / Archive / Discuss.
//
// This sweep churns two clear sub-populations and leaves the rest:
//
//   A. DEGENERATE DRAFT -- the drafter's openQuestions is "I have no prior context / this
//      is the start of our conversation / no defined problem", but promptContext.rawText
//      is intact and substantial. This is the local 27B flaking on the tier-3 forced-
//      summary turn (context rollback after an Ollama renderer flake), not a real
//      question (known signature `manual::empty-degenerate-draft`). -> strip the draft
//      artifacts and requeue to queue/adhoc/ for one clean retry (bounded).
//
//   B. INVALID PREMISE / ALREADY DONE -- openQuestions says the thing asked for already
//      exists / doesn't apply / isn't a code change, or adhoc-staleness-flag stamped a
//      high-confidence flag. -> archive to queue/done/_archived_no_action/ ONLY behind the
//      same resolution-signal bar staleness-auto-archive.js uses (a `possibly-resolved`
//      reason or a cited real commit) OR a confident local vote; otherwise stamp a
//      medium-confidence stalenessFlag and leave it for a human.
//
// Everything else -- retry-exhausted escalations (blocked-drain owns those), the
// decompose-loop subset (autoroute owns those), and genuine design questions -- is
// stamped `ncTriageDecision:'leave-for-human'` and left in place, idempotently.
//
// Cheap by construction: readdirSync of a small dir; LLM votes only in bucket B, capped
// per sweep. Runs unconditionally on the watchdog tick, same discipline as
// auto-confirm-review.js. Kill switch: AGENT_MANAGER_NC_TRIAGE=false.
//
//   D. FALSE COMPLETION-CLAIM SIGNATURE (2026-09-04) -- the draft asserted something
//      checkable and false about its own output ("claims to have implemented X" while the
//      diff only touches an unrelated file; "claims to have created file Y" while the
//      fact-check confirms it doesn't exist) and review had to catch it by judgment, each
//      time, until retries ran out. adhoc-diff-sanity.js's adhocNoChangesClaimProblem and
//      the false-test-count/false-file-creation checks now catch this class at DRAFT time,
//      before it ever reaches review -- so a task stuck on this exact signature deserves
//      one more, now-gated attempt rather than staying frozen for a human forever.
//      Checked BEFORE the "already reviewed" skip below (unlike A/B/C): this detector did
//      not exist when older tasks were first triaged, so a stale `leave-for-human` stamp
//      must not shield them from a fix built specifically for this shape. Bounded by the
//      same MAX_REQUEUES/ncTriageAttempts counter bucket A uses -- one clean retry, then
//      it falls back to the normal leave-for-human path like everything else.
//
//   E. DECOMPOSE-LOOP, NOT AN OVERSIZED-FILE TARGET (2026-09-04) -- the original comment
//      above ("decompose-loop subset -- autoroute owns those") was only half true:
//      decompose-loop-autoroute.js explicitly declines a decompose-loop task whose target
//      isn't a genuinely oversized file ("left for the human" -- see its own header), but
//      this sweep's own unconditional `stalenessFlag.reason === 'decompose-loop' -> skip`
//      trusted autoroute to own EVERY such task regardless. Root-caused live: of the 5
//      decompose-loop-flagged adhoc tasks that have ever existed, all 5 hit this exact
//      dead zone -- 4 were quietly moved to _archived_no_action with no
//      terminalDisposition/resolvedBy/autorouteAttempts at all (dropped, never resolved),
//      the 5th (a well-specified, mechanical test-writing task) sat with `ncTriageDecision`
//      never even set. Fix: the skip now checks autoroute's own precondition
//      (targetOversizedFile) before deferring; a non-oversized-file decompose-loop task
//      gets one clean-state requeue instead (these are usually tractable -- the model just
//      needs pushed toward "implement it directly" instead of "split it"), falling back to
//      an honest, visible bucket-C leave-for-human stamp if it recurs, rather than staying
//      invisible forever. Checked before the "already reviewed" skip, same reasoning as D.
//
//   F. TURN/CONTEXT BUDGET EXHAUSTED, NOT A DESIGN QUESTION (2026-09-07) -- root-caused
//      live: adhoc-extract-29-functions-to-analytics-and-discovery-js-and-remove-them-
//      from-index-html-...-0 wrote a complete, fully-specified extraction script to the
//      worktree and then ran out of turn/context budget before actually running it --
//      its own openQuestions said so explicitly ("not any design uncertainty or missing
//      code... No further code changes or decisions are needed"). This sailed past
//      CREATE_TASK_RE into bucket C ("genuine design question -- left for a human")
//      because nothing here recognized "the model told you outright this isn't a
//      decision, just an unfinished mechanical step" as its own signature. Requeuing
//      loses the in-progress script (queue/adhoc/ tasks start from a clean worktree), but
//      that's fine -- the task's rawText/plan/acceptance criteria are untouched and
//      already fully specify the same mechanical steps, so a clean retry can reproduce
//      the script from scratch and this time actually execute it, rather than sitting on
//      a human's queue for a decision that was never really needed. Bounded by the same
//      MAX_REQUEUES counter every other requeue bucket uses.
//
//   H. DETERMINISTICALLY-CLASSIFIED INVALID-PREMISE (2026-09-11) -- src/blocked-task-
//      classifiers.js escalates a blocked task straight to needs-clarification/ with
//      reason:'invalid-premise' when its blockedReason matched /^invalid premise:/i --
//      candidate-premise-check.js's own deterministic/model-vetted gate output, already
//      confirmed before the task ever reached blocked/. This used to hit the
//      `nc.reason !== 'design-decision'` gate below and be skipped entirely ("not ours"),
//      so it sat in needs-clarification/ forever with no triage at all -- confirmed live
//      2026-09-11: 9 pipeline_forensics_fix / arch_import_review tasks, all untouched
//      since creation. Unlike bucket B (which infers "premise looks invalid" from a
//      design-decision task's free-text openQuestions and needs a resolution signal or
//      vote to act on that inference), the reason itself IS the confirmed signal here --
//      but this still reuses bucket B's own archive-or-flag machinery (resolution-signal
//      check, then a majority vote, then a medium-confidence flag) rather than archiving
//      unconditionally, so a premise that was true when filed but has since been
//      invalidated by other work still gets one more check before anything moves.
//
//   I. DETERMINISTICALLY-CLASSIFIED UNRELIABLE-GROUNDING (2026-09-11) -- same escalation
//      path, reason:'unreliable-grounding' (blocked-task-classifiers.js's
//      hasUnreliableGrounding: the candidate's fetched file had anchorConfidence:'none').
//      That file's own comment explains why this is NOT a bucket-A/D/E/F/G-style requeue
//      candidate: refreshCandidateFetchedFiles() re-derives the SAME deterministic anchor
//      search against the SAME unchanged file on every retry, so a blind requeue can only
//      ever reproduce the identical failure -- genuinely harness-side, not stochastic.
//      Also hit the `nc.reason !== 'design-decision'` gate and sat untouched forever (11
//      tasks, confirmed live 2026-09-11). Treated like bucket C's retry-exhausted shape:
//      file ghost debt (no automated recovery exists), stamp it reviewed, leave it
//      visible for a human to fix the grounding source or archive -- instead of the old
//      silent, permanent drop.
//
//   J. DETERMINISTIC-TRUNCATION-GUARD FALSE-BLOCK SIGNATURE (2026-09-16) -- same shape as
//      bucket D: `task.reviewProvider === 'deterministic-truncation-guard'` means a
//      deterministic review gate (src/validate-implement-truncation.js), not a real
//      judgment call, was the terminal rejection before escalation. That gate false-
//      flagged essentially any complete Group A implementResponse as "truncated" for
//      about a day (PR #265, 2026-09-14) before being root-caused and fixed -- a task
//      stuck on exactly this signature was never a design question. Not date-scoped: the
//      `reviewProvider` marker itself is the signature, so this recovers any future task
//      that lands here via the identical mechanism (a deterministic gate later found
//      buggy), not just this one incident.

//   K. DECOMPOSE-REVIEW-BLIND SIGNATURE (2026-09-16) -- PR #230 ("decompose review was
//      structurally blind to the actual sub-tasks", merged 2026-09-14) fixed
//      local-agentic-write-draft.js's give-up backstop to render the real sub-task list
//      into task.implementResponse via formatSubTaskProposalsForReview -- before that
//      fix, a task whose decompose was accepted (task.adhocResolution === 'decompose',
//      a genuine >= 2-item task.subTaskProposals) still carried an implementResponse
//      that never mentioned any of those sub-tasks by name, so review correctly-per-its-
//      own-instructions rejected it as "no actual decomposition, just meta-commentary" --
//      not a real design question, a rendering bug in a task that ALREADY has a valid,
//      complete decomposition sitting right there in subTaskProposals. Confirmed live:
//      21 of 31 needs-clarification tasks with a real >= 2-item subTaskProposals show
//      this exact gap. No redraft needed -- unlike every other bucket here, this one
//      REPAIRS the existing artifact (regenerates implementResponse from the already-
//      valid subTaskProposals) and sends it straight to queue/review/ for a real vote,
//      not queue/adhoc/ for a fresh draft.
//
//      POSITIONING FIX 1 (2026-09-16, same day): first shipped positioned after every
//      other bucket, which meant it never actually ran -- every real target also has
//      stalenessFlag.reason === 'decompose-loop' and, often, an oversized target file,
//      so the decompose-loop/oversized-file deferral ("autoroute owns it") a few lines
//      below silently `continue`d the task away before this bucket, or even bucket D,
//      ever got a look. Moved to run BEFORE that deferral.
//
//      POSITIONING FIX 2 (2026-09-16, same day, found running the sweep for real after
//      fix 1 landed): also moved to run BEFORE the `nc.reason` allowlist -- 2 more real
//      targets carry reason:'infra-error' (a later, unrelated attempt's failure mode
//      masking an earlier attempt's still-valid decomposition), which that allowlist
//      excludes since it only lets 'design-decision'/'invalid-premise'/'unreliable-
//      grounding' through. See its own inline comment for both incidents.
//
//   L. FABRICATED-FILE-PATH NEAR-MISS AUTO-REPAIR (2026-09-16) -- candidate-path-
//      grounding.js's Check 0 escalates an arch_discovery candidate straight to
//      needs-clarification (reason:'fabricated-file-path', non-retryable by design --
//      see blocked-task-classifiers.js's own comment: 3 qwen passes all re-invented the
//      same wrong path, so a blind redraft never differs) whenever the write-up's
//      `Files:` line names a path that resolves nowhere in the repo. Root-caused live
//      (arch-discovery-community-15, "scripts" community): the model was handed exactly
//      3 real files verbatim in its own promptContext.files (candidates-doc-merge.js,
//      candidates-doc-merge-driver.js, candidates-doc-merge.test.js -- all sharing the
//      same 3-4 word stem) and cited `merge-candidates.js`, a token-shuffle of the first
//      real path, not a wholesale invention. The gate correctly refuses to guess, but
//      "correctly refuses to guess" and "a human must now read this" are different bars:
//      when the claimed path's basename tokens are a STRICT subset of exactly one real
//      grounded path's tokens (and every other candidate has a worse -- larger -- extra-
//      token count), that's not a judgment call either; it is close enough as a matter
//      of set arithmetic. This bucket substitutes the real path for the fabricated one
//      everywhere it appears in implementResponse and sends the repaired write-up
//      straight to review, instead of leaving a mechanically-recoverable near-miss for a
//      human. Scoped to source:'arch_discovery' only -- the one shape with a verified,
//      trustworthy promptContext.files list of real grounded paths; a genuinely
//      unrecoverable fabrication (no real path is a confident match) still falls through
//      to bucket C, unchanged.
const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config.js');
const { appendHistoryEvent } = require('./task-history.js');
const { formatSubTaskProposalsForReview } = require('./agentic-draft-common.js');
const { classifyVote, clip } = require('./auto-confirm-review.js');
const { hasResolutionSignal } = require('./staleness-auto-archive.js');
const { targetOversizedFile, oversizedFiles } = require('./decompose-loop-autoroute.js');
const { classifyRequeue } = require('./requeue-attribution.js');
const { fileGhostDebt } = require('./ghost-debt.js');
const { surfaceDecomposeDesignQuestion } = require('./decompose-question-surface.js');

// Read env inside the sweep, not at module load -- keeps tests able to toggle it and
// matches auto-confirm-review.js's discipline.
function cfgEnv() {
  return {
    KILL: process.env.AGENT_MANAGER_NC_TRIAGE === 'false',
    VOTE_ENABLED: process.env.AGENT_MANAGER_NC_TRIAGE_VOTE !== 'false',
    DRY_RUN: process.env.AGENT_MANAGER_NC_TRIAGE_DRY_RUN === '1',
    MAX_REQUEUES: Number(process.env.AGENT_MANAGER_NC_TRIAGE_MAX_REQUEUES) || 1,
    MAX_VOTES: Number(process.env.AGENT_MANAGER_NC_TRIAGE_MAX_VOTES) || 2,
    VOTE_MODEL: process.env.AGENT_MANAGER_NC_TRIAGE_VOTE_MODEL || 'qwen2.5:3b',
  };
}
const MIN_RAWTEXT_FOR_REQUEUE = 400;

// Per-bucket requeue-attempt counters (2026-09-16, pipeline hardening): every bucket below
// used to share ONE flat task.ncTriageAttempts counter gated by MAX_REQUEUES, so a task
// that burned its one shot on an EARLIER, unrelated bucket (e.g. a generic redraft) was
// then permanently locked out of every LATER, more targeted repair bucket added
// afterward -- confirmed live: Bucket K (built specifically to rescue a stuck-but-solvable
// subset by resubmitting an existing, already-valid decomposition -- no redraft, none of a
// fresh attempt's risk or cost) could never fire on a task that had already been requeued
// once by an older, unrelated bucket, since the shared counter was already at its cap.
// Each bucket now tracks its OWN attempt count under task.ncTriageBucketAttempts, so
// buckets are independent budgets instead of one shared one that the first bucket to touch
// a task exhausts for every bucket after it.
function bucketAttempts(task, bucket) {
  return (task.ncTriageBucketAttempts && task.ncTriageBucketAttempts[bucket]) || 0;
}
function bumpBucketAttempts(task, bucket) {
  if (!task.ncTriageBucketAttempts) task.ncTriageBucketAttempts = {};
  const next = bucketAttempts(task, bucket) + 1;
  task.ncTriageBucketAttempts[bucket] = next;
  return next;
}

// The drafter said, in effect, "I was handed nothing to work on". When the task's own
// rawText is substantial this is a local-model flake on the forced-summary turn, not a
// real question -- see the header and src/local-tool-client.js:652 (flake rollback).
const DEGENERATE_RE = /(?:don'?t|do not) have any (?:prior|previous)\b|(?:don'?t|do not) have (?:any )?(?:prior|previous) (?:context|turns?|tasks?)\b|\bno prior (?:context|turns?|tasks?|conversation)\b|\bstart of (?:our|the) conversation\b|\bfirst message in (?:our|the) conversation\b|\bno (?:defined|specific) (?:problem|objective|task) (?:was )?(?:stated|defined|provided|presented)?\b|\bno specific (?:problem|task|objective) was stated\b/i;

// The drafter concluded the task asks for something that already exists, does not apply to
// this codebase, or is not a code change -- the archive case.
const INVALID_PREMISE_RE = /\bpremise (?:of this task )?(?:is|appears|seems)[^.]{0,40}(?:false|invalid|wrong|contradict)|contradicts the codebase|no mapping to anything in (?:this|the) rep(?:o|ository)?|\bzero matches\b|does not (?:exist|map)[^.]{0,20}(?:in|to) (?:this|the) (?:repo|codebase)|research-domain brain-dump|not a code change\b[^.]{0,40}brain-dump/i;

// A "create X" task naturally names files that don't exist yet, which trips
// adhoc-staleness-flag's `invalid-premise` detector ("every file this task names is
// absent") AND can trip INVALID_PREMISE_RE. And a task that reports real progress isn't a
// dead premise -- it's a redraft candidate a human should see, not an archive. Either
// signal drops the task straight to bucket C.
const CREATE_TASK_RE = /\b(?:create|add|write|build|implement|scaffold|extract|introduce)\b[^.\n]{0,70}\b(?:new )?(?:file|module|script|component|endpoint|route|blueprint|source|helper)\b/i;
const IN_PROGRESS_RE = /\bgot close\b|\bverified facts\b|\bfor the next pass\b|\bran out of turns\b|working (?:\w+ )?script exists|\bstate so far\b|\bpartial (?:work|implementation) (?:landed|exists)\b/i;

// Bucket F signature: the drafter explicitly says it ran out of turn/context budget mid-
// mechanical-step AND explicitly disclaims any real design uncertainty -- see the header's
// own comment on the incident this fixes.
const BUDGET_EXHAUSTED_RE = /ran out of (?:turn|context)(?:[/ ](?:turn|context))? budget/i;
const COMPLETABLE_NOT_DESIGN_RE = /no further code changes? or decisions? (?:are |is )?(?:needed|required)|not (?:a|any) design (?:uncertainty|question|decision)|has(?:n'?t| not) (?:yet )?been executed/i;

// 2026-09-08, root-caused live (autodecomp-...-04-system-and-project-js): the drafter's
// own text said "not a design question -- a pass-budget overrun," which matches
// COMPLETABLE_NOT_DESIGN_RE but NOT BUDGET_EXHAUSTED_RE (worded "no tool budget left" /
// "pass-budget overrun," not "ran out of turn/context budget") -- fell through to bucket C
// as a "genuine design question." Chasing more phrasings is a losing regex arms race
// (Second Brain [[dspy-signatures]] research: DSPy constrains an output field's
// vocabulary with Literal[...] rather than inferring meaning from free text after the
// fact). local-agentic-write-draft.js's own prompt contract now requires an explicit,
// fixed-vocabulary `BLOCKER-TYPE:` line immediately after `RESOLUTION: needs-human-
// decision` -- when present, it is authoritative and bypasses BOTH regexes above entirely
// (a task from an older draft, or a path that doesn't emit the tag, still falls back to
// the phrase-matching pair).
const BLOCKER_TYPE_BUDGET_EXHAUSTED_RE = /BLOCKER-TYPE:\s*budget-exhausted\b/i;

// Bucket G signature: the drafter tagged an explicit tool/environment failure. Normally
// resolveAgenticDraft (agentic-draft-common.js) intercepts this as a retryable block
// before it ever reaches needs-clarification/ -- this is the backstop for a task that
// gets here another way (an older draft, a non-agentic path, a regression) still carrying
// the tag in its openQuestions. A transient infra fault clears on a fresh pass; bounded
// by MAX_REQUEUES like every other bucket.
const BLOCKER_TYPE_INFRA_ERROR_RE = /BLOCKER-TYPE:\s*infra-error\b/i;

// Bucket D signature: a draft's own text (or review's account of it) asserted a checkable
// completion claim that is contradicted by the diff/repo -- the exact shape
// adhoc-diff-sanity.js's adhocNoChangesClaimProblem and the false-test-count/
// false-file-creation checks (2026-09-04) now catch at draft time. Matches both the older
// review-time phrasing ("claims to have implemented...but the diff only...", "claims to
// have created the file...but the deterministic fact-check...") and the new gate's own
// blockedReason wording ("resolved no-changes-needed but...", "no \"Already covered:\"
// block", "summary claims N tests").
const FALSE_CLAIM_RE = /\bclaims? (?:to have )?"?(?:implement|creat|verif)\w*\b|\bresolved no-changes-needed but\b|\bno "Already covered:" block\b|\bdeterministic fact-check (?:confirms|flags)\b|\bsummary claims\b/i;

const REQUEUE_STRIP_FIELDS = [
  'needsClarification', 'localRejectCount', 'retryableDraftBlock', 'turnBudgetExhausted',
  'turnBudgetExhaustedBefore', 'adhocResolution', 'subTaskProposals', 'preDrafted',
  'priorRejectionFeedback', 'rawDiff', 'implementResponse', 'blockedReason', 'blockedStage',
  'claimedAt',
];

// 2026-09-17, root-caused live: every bucket below strips REQUEUE_STRIP_FIELDS (which
// already includes blockedReason/blockedStage) before writing a clean-slate retry back
// into queue/adhoc/, but none of them ever reset task.status away from 'blocked' --
// escalation to needs-clarification never clears the blocked-stage fields underneath
// it, so a task requeued this way lands in adhoc/ still reading status:'blocked' with
// no blockedReason/blockedStage to explain it. Confirmed live: 2 real tasks requeued by
// bucket E sat with an inexplicable "blocked, no reason" status. Harmless for CLAIM
// eligibility (task-sources.js's nextAdhocLikeTask() never checks task.status at all),
// but it DOES make the task indistinguishable from an already-exhausted blocked task to
// any OTHER sweep that keys off status:'blocked' (reject-retry-check.js's own in-place
// adhoc/ scan is exactly this shape) -- and if the task is genuinely re-claimed and
// fails again, a stale status:'blocked' left over from a stripped-but-not-reset prior
// cycle is exactly the kind of inconsistent state this whole class of bug (see
// routes/task.py's matching /answer and /resolve fix, same day) keeps producing.
function resetStatusForFreshAdhocAttempt(task) {
  if (task.status === 'blocked') task.status = 'pending';
}

// Bucket L helpers. Parses candidate-path-grounding.js's own formatFabricatedReason()
// shape ("fabricated file path(s): a, b -- not present anywhere in the target repo. ...")
// -- deliberately matching that exact producer rather than a looser pattern, so this
// never fires on a differently-worded blockedReason from some other gate.
const FABRICATED_PATHS_RE = /fabricated file path\(s\):\s*(.+?)\s*--\s*not present anywhere in the target repo/i;
function extractFabricatedPaths(blockedReason) {
  const m = FABRICATED_PATHS_RE.exec(String(blockedReason || ''));
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

// basename, extension stripped, split on any run of non-alphanumeric characters --
// "candidates-doc-merge.test.js" -> ['candidates','doc','merge','test'].
function basenameTokens(filePath) {
  const base = String(filePath || '').split('/').pop() || '';
  const noExt = base.replace(/\.[a-z0-9]+$/i, '');
  return noExt.split(/[^a-z0-9]+/i).map((t) => t.toLowerCase()).filter(Boolean);
}

// A claimed (fabricated) path is a confident near-miss of a real grounded path when its
// token set is a non-empty STRICT subset of the real path's token set, and no other real
// path ties for the fewest leftover (extra) tokens -- a unique closest superset, not just
// "some overlap." Returns the matching real path, or null if there is no unique winner.
function findNearMissRealPath(claimedPath, realPaths) {
  const claimedTokens = new Set(basenameTokens(claimedPath));
  if (claimedTokens.size === 0) return null;
  let best = null; // { realPath, extra }
  let tie = false;
  for (const realPath of realPaths) {
    const realTokens = new Set(basenameTokens(realPath));
    if (realTokens.size <= claimedTokens.size) continue; // not a strict superset by size
    let isSubset = true;
    for (const t of claimedTokens) { if (!realTokens.has(t)) { isSubset = false; break; } }
    if (!isSubset) continue;
    const extra = realTokens.size - claimedTokens.size;
    if (!best || extra < best.extra) { best = { realPath, extra }; tie = false; }
    else if (extra === best.extra && realPath !== best.realPath) { tie = true; }
  }
  return best && !tie ? best.realPath : null;
}

function log(line) {
  process.stderr.write(`[nc-triage] ${line}\n`);
}

function buildInvalidPremisePrompt(task) {
  const oq = (task.needsClarification && task.needsClarification.openQuestions) || '';
  const rawText = (task.promptContext && task.promptContext.rawText) || '';
  return [
    'You are triaging a stuck task. It was drafted, could not be implemented, and the',
    "drafter's stated reason was:",
    '',
    `  ${clip(oq, 2500)}`,
    '',
    'Original task:',
    `  ${clip(rawText, 2500)}`,
    '',
    'Decide ONE thing: is the drafter CORRECT that this task\'s premise is invalid -- the',
    'thing it asks for already exists, does not apply to this codebase, or is not a code',
    'change at all -- such that the right action is to archive it with no work?',
    '',
    'Answer EXACTLY one line:',
    'CONFIRM: <why the premise is genuinely invalid / already satisfied>',
    'DENY: <why there is still real, actionable work here>',
  ].join('\n');
}

function voteReason(vote, marker) {
  const sample = (vote && vote.votes || []).find((v) => v.verdict === marker);
  if (!sample) return marker;
  const m = sample.response.match(new RegExp(`${marker}:\\s*(.+)`, 'i'));
  return (m ? m[1] : sample.response).trim().slice(0, 240);
}

async function needsClarificationTriage({ pipelineDir, repoRoot, majorityVote }) {
  const summary = { checked: 0, requeued: 0, archived: 0, flagged: 0, leftForHuman: 0, errors: 0 };
  const { KILL, VOTE_ENABLED, DRY_RUN, MAX_REQUEUES, MAX_VOTES, VOTE_MODEL } = cfgEnv();
  if (KILL) return summary;
  if (DRY_RUN) summary.dryRun = true;

  const ncDir = path.join(pipelineDir, 'queue', 'needs-clarification');
  const adhocDir = path.join(pipelineDir, 'queue', 'adhoc');
  const archiveDir = path.join(pipelineDir, 'queue', 'done', '_archived_no_action');

  let names;
  try {
    names = fs.readdirSync(ncDir).filter((f) => f.endsWith('.json'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      return summary; // no needs-clarification/ dir
    }
    console.error('[needs-clarification-triage] readdirSync failed on', ncDir, err);
    summary.errors += 1;
    return summary;
  }

  const now = new Date().toISOString();
  let votesUsed = 0;

  const writeInPlace = (file, task) => {
    if (DRY_RUN) return;
    try { fs.writeFileSync(file, JSON.stringify(task, null, 2)); } catch (e) {
      log(`write failed ${path.basename(file)}: ${e.message}`); summary.errors += 1;
    }
  };

  for (const name of names) {
    const file = path.join(ncDir, name);
    let task;
    try {
      task = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      summary.errors += 1;
      continue;
    }

    // --- Bucket K: decompose-review-blind signature -> repair in place, send to review --
    // Checked BEFORE the `nc.reason` allowlist below (and everything else in the loop,
    // including the decompose-loop/oversized-file deferral) -- SECOND positioning fix,
    // same day as the first: root-caused live 2026-09-16 running the sweep for real
    // after the first fix landed -- 2 of the remaining un-recovered targets carry
    // needsClarification.reason === 'infra-error', not 'design-decision', so the
    // allowlist below (`if (reason !== 'design-decision' && ...) continue`) excluded
    // them before Bucket K ever got a look, identical in shape to the oversized-file
    // dead zone the first fix closed. Real incident: a task's SECOND draft attempt
    // produced a genuine decompose (real subTaskProposals) that review correctly
    // rejected for the rendering bug this bucket exists to fix; the requeued THIRD
    // attempt then hit an unrelated infra-error and exhausted retries -- escalation
    // reason reflects only the LAST failure, not the fact that a valid decomposition
    // is still sitting on the task from an earlier attempt. Bucket K's own detection
    // (a real >=2-item subTaskProposals with no evidence in implementResponse) is
    // already a narrow, deterministic, reason-independent signal, so it belongs ahead
    // of a filter meant for buckets that actually need a specific escalation reason to
    // make sense (H/I key off the reason value itself; this one doesn't use it at all).
    //
    // Checked BEFORE the decompose-loop/oversized-file deferral immediately below --
    // root-caused live 2026-09-16, hours after this bucket first shipped: EVERY one of
    // its intended targets also carries stalenessFlag.reason === 'decompose-loop' (the
    // same repeated-decompose history that triggered the give-up backstop this bucket
    // exists to repair), and a large fraction of those target an oversized file (the
    // very files -- local-draft.js, agentic-draft-common.js -- this pipeline's own
    // decompose-related fixes live in). The line below silently `continue`s any
    // decompose-loop task whose target is oversized ("autoroute owns it") with NO log
    // line and NO bucket ever getting a chance to run -- including this one, and
    // including Bucket D above it, though D's own signature rarely overlaps in
    // practice. decompose-loop-autoroute.js's OWN precondition then declines anyway
    // when that same file is "actively developed" (a real, separate safety guard), so
    // the net effect was a permanent dead zone: deferred here, declined there, visible
    // nowhere. This bucket's own concern (a decomposition that ALREADY happened and
    // just needs its rendering repaired) has nothing to do with whether the target file
    // is oversized -- there is nothing left for autoroute to do -- so it must run
    // before that deferral, not after it, unlike every requeue bucket below which
    // genuinely does need to yield to autoroute's oversized-file ownership.
    //
    // Unlike every other bucket here, this does NOT redraft: the task already has a
    // valid, complete decomposition (task.subTaskProposals), just an implementResponse
    // that (pre-PR-#230) never mentioned it. Regenerate implementResponse from the real
    // sub-tasks and file straight to queue/review/ for a real vote -- see the top-of-file
    // header comment for the full incident.
    {
      const id0 = task.id || name.replace(/\.json$/, '');
      const subTasks = Array.isArray(task.subTaskProposals) ? task.subTaskProposals : [];
      const isDecompose = task.adhocResolution === 'decompose' && subTasks.length >= 2;
      const hasEvidence = isDecompose && subTasks.some((s) => s && s.title
        && String(task.implementResponse || '').includes(String(s.title).slice(0, 30)));
      if (isDecompose && !hasEvidence && bucketAttempts(task, 'K') < MAX_REQUEUES) {
        const reviewDir = path.join(pipelineDir, 'queue', 'review');
        const reviewPath = path.join(reviewDir, `${id0}.json`);
        if (fs.existsSync(reviewPath)) {
          log(`${id0}: bucket K but ${id0}.json already in review/ -- already handled, skipping`);
        } else {
          summary.checked += 1;
          const attempt = bucketAttempts(task, 'K') + 1;
          log(`${id0}: bucket K (decompose-review-blind signature) -> repaired in place, sent to review ${attempt}/${MAX_REQUEUES}`);
          summary.requeued += 1;
          if (!DRY_RUN) {
            delete task.needsClarification;
            delete task.localRejectCount;
            delete task.retryableDraftBlock;
            delete task.preDrafted;
            delete task.priorRejectionFeedback;
            delete task.blockedReason;
            delete task.blockedStage;
            delete task.claimedAt;
            delete task.ncTriageDecision;
            delete task.ncTriageReviewedAt;
            bumpBucketAttempts(task, 'K');
            task.status = 'needs-review';
            task.implementResponse = `Decomposed into ${subTasks.length} sub-task(s).\n\n${formatSubTaskProposalsForReview(subTasks)}`;
            appendHistoryEvent(task, 'requeued',
              `needs-clarification-triage: decompose-review-blind signature (a since-fixed rendering gap, PR #230, hid a genuinely valid decomposition from review) -- implementResponse regenerated from the existing subTaskProposals, sent straight to review ${attempt}/${MAX_REQUEUES}`);
            try {
              await classifyRequeue(task, { reasonHint: 'bucket-K: decompose-review-blind signature', requeueWriter: 'needs-clarification-triage', repoRoot });
            } catch { /* classification must never block the real requeue */ }
            try {
              fs.mkdirSync(reviewDir, { recursive: true });
              fs.writeFileSync(reviewPath, JSON.stringify(task, null, 2));
              fs.unlinkSync(file);
            } catch (e) {
              log(`${id0}: repair-and-review move failed: ${e.message}`);
              summary.requeued -= 1;
              summary.errors += 1;
            }
          }
          continue;
        }
      }
    }

    // --- Bucket L: fabricated-file-path near-miss auto-repair (arch_discovery only) ---
    // Checked BEFORE the `nc.reason` allowlist below, same reasoning as bucket K:
    // reason:'fabricated-file-path' is not in that allowlist, so this would otherwise be
    // silently skipped every tick. See the top-of-file header for the full incident.
    {
      const id0 = task.id || name.replace(/\.json$/, '');
      const nc0 = task.needsClarification || {};
      if (nc0.reason === 'fabricated-file-path' && task.source === 'arch_discovery'
        && bucketAttempts(task, 'L') < MAX_REQUEUES) {
        const realPaths = Array.isArray(task.promptContext && task.promptContext.files)
          ? task.promptContext.files.map((f) => f && f.path).filter(Boolean)
          : [];
        const claimed = extractFabricatedPaths(task.blockedReason);
        const repairs = claimed.length > 0
          ? claimed.map((c) => ({ claimed: c, real: findNearMissRealPath(c, realPaths) }))
          : [];
        const allResolved = repairs.length > 0 && repairs.every((r) => r.real);
        if (allResolved) {
          const reviewDir = path.join(pipelineDir, 'queue', 'review');
          const reviewPath = path.join(reviewDir, `${id0}.json`);
          if (fs.existsSync(reviewPath)) {
            log(`${id0}: bucket L but ${id0}.json already in review/ -- already handled, skipping`);
          } else {
            summary.checked += 1;
            const attempt = bucketAttempts(task, 'L') + 1;
            log(`${id0}: bucket L (fabricated-file-path near-miss) -> repaired ${repairs.length} path(s), sent to review ${attempt}/${MAX_REQUEUES}`);
            summary.requeued += 1;
            if (!DRY_RUN) {
              let text = String(task.implementResponse || '');
              for (const r of repairs) {
                text = text.split(r.claimed).join(r.real);
              }
              task.implementResponse = text;
              delete task.needsClarification;
              delete task.localRejectCount;
              delete task.retryableDraftBlock;
              delete task.preDrafted;
              delete task.priorRejectionFeedback;
              delete task.blockedReason;
              delete task.blockedStage;
              delete task.claimedAt;
              delete task.ncTriageDecision;
              delete task.ncTriageReviewedAt;
              bumpBucketAttempts(task, 'L');
              task.status = 'needs-review';
              appendHistoryEvent(task, 'requeued',
                `needs-clarification-triage: fabricated-file-path near-miss signature -- substituted the real grounded path for ${repairs.map((r) => `"${r.claimed}" -> "${r.real}"`).join(', ')}, sent straight to review ${attempt}/${MAX_REQUEUES}`);
              try {
                await classifyRequeue(task, { reasonHint: 'bucket-L: fabricated-file-path near-miss', requeueWriter: 'needs-clarification-triage', repoRoot });
              } catch { /* classification must never block the real requeue */ }
              try {
                fs.mkdirSync(reviewDir, { recursive: true });
                fs.writeFileSync(reviewPath, JSON.stringify(task, null, 2));
                fs.unlinkSync(file);
              } catch (e) {
                log(`${id0}: repair-and-review move failed: ${e.message}`);
                summary.requeued -= 1;
                summary.errors += 1;
              }
            }
            continue;
          }
        }
      }
    }

    const nc = task.needsClarification || {};
    const reason = nc.reason;
    if (reason !== 'design-decision' && reason !== 'invalid-premise' && reason !== 'unreliable-grounding') {
      continue;                                                          // not ours
    }

    // --- Bucket H: deterministically-classified invalid-premise -------------------
    if (reason === 'invalid-premise') {
      if (task.ncTriageDecision === 'leave-for-human') continue;         // already reviewed
      summary.checked += 1;
      const id = task.id || name.replace(/\.json$/, '');
      const oq = nc.openQuestions || '';

      const archive = (decisionNote) => {
        log(`${id}: bucket H (deterministic invalid-premise) -> archive (${decisionNote})`);
        summary.archived += 1;
        if (DRY_RUN) return;
        appendHistoryEvent(task, 'archived',
          `needs-clarification-triage: invalid-premise (candidate-premise-check.js, deterministic) -- ${decisionNote}`);
        task.status = 'done';
        const dest = path.join(archiveDir, `${id}.json`);
        try {
          if (fs.existsSync(dest)) { log(`${id}: archive dest exists -- already handled`); summary.archived -= 1; return; }
          fs.mkdirSync(archiveDir, { recursive: true });
          fs.writeFileSync(dest, JSON.stringify(task, null, 2));
          fs.unlinkSync(file);
        } catch (e) {
          log(`${id}: archive move failed: ${e.message}`);
          summary.archived -= 1;
          summary.errors += 1;
        }
      };

      let resolved = false;
      try { resolved = hasResolutionSignal(task, oq); } catch (e) { log(`${id}: hasResolutionSignal threw: ${e.message} -- treating as unresolved`); resolved = false; }
      if (resolved) { archive('verified resolution signal'); continue; }

      if (VOTE_ENABLED && typeof majorityVote === 'function' && votesUsed < MAX_VOTES) {
        votesUsed += 1;
        let vote;
        try {
          vote = await majorityVote({
            prompt: buildInvalidPremisePrompt(task),
            classify: classifyVote(['CONFIRM', 'DENY'], 15),
            n: 3, minAgreeing: 2, temperature: 0.2,
            source: 'needs_clarification_triage', model: VOTE_MODEL,
            taskId: task.id, stage: 'nc-triage-premise-vote',
          });
        } catch (e) {
          appendHistoryEvent(task, 'advisory',
            `needs-clarification-triage: premise vote could not run (${(e && e.message || 'vote error').slice(0, 140)}) -- will retry`);
          writeInPlace(file, task);
          summary.errors += 1;
          continue;
        }
        if (vote && vote.confident && vote.verdict === 'CONFIRM') {
          archive(`local vote: ${voteReason(vote, 'CONFIRM')}`);
          continue;
        }
        // confident DENY or inconclusive -> fall through to flag
      }

      log(`${id}: bucket H but unverified -> flag + leave`);
      summary.flagged += 1;
      if (DRY_RUN) continue;
      if (!task.stalenessFlag || task.stalenessFlag.reason !== 'nc-triage-invalid-premise') {
        task.stalenessFlag = {
          reason: 'nc-triage-invalid-premise', disposition: 'retire', confidence: 'medium',
          at: now, evidence: [oq.slice(0, 300)],
        };
      }
      task.ncTriageReviewedAt = now;
      task.ncTriageDecision = 'leave-for-human';
      appendHistoryEvent(task, 'advisory',
        'needs-clarification-triage: invalid-premise (deterministic gate), unverified by a resolution signal or vote -- flagged for a human');
      writeInPlace(file, task);
      continue;
    }

    // --- Bucket I: deterministically-classified unreliable-grounding --------------
    if (reason === 'unreliable-grounding') {
      if (task.ncTriageDecision === 'leave-for-human') continue;         // already reviewed
      summary.checked += 1;
      const id = task.id || name.replace(/\.json$/, '');
      const oq = nc.openQuestions || '';
      log(`${id}: bucket I (unreliable-grounding, harness-side, blind retry reproduces identically) -> flag + leave for human`);
      summary.leftForHuman += 1;
      if (DRY_RUN) continue;
      fileGhostDebt({ task, reasonText: oq || task.blockedReason, site: 'needs-clarification-triage:bucket-I-unreliable-grounding', pipelineDir });
      task.ncTriageReviewedAt = now;
      task.ncTriageDecision = 'leave-for-human';
      appendHistoryEvent(task, 'advisory',
        'needs-clarification-triage: unreliable-grounding (harness-side; a blind retry reproduces the same anchor-match failure) -- ghost debt filed, left for a human to fix the grounding source or archive');
      writeInPlace(file, task);
      continue;
    }


    const decompLoop = !!(task.stalenessFlag && task.stalenessFlag.reason === 'decompose-loop');
    if (decompLoop && targetOversizedFile(task, oversizedFiles(pipelineDir))) continue; // autoroute owns it
    if (task.stalenessKeep && task.stalenessKeep.until && task.stalenessKeep.until > now) continue; // human said Keep

    // --- Bucket E: decompose-loop, not an oversized-file target -> clean-state requeue ---
    // Checked BEFORE the "already reviewed" skip -- see header. Only acts (and counts
    // toward `checked`) when decompLoop is set; otherwise falls through unchanged.
    if (decompLoop) {
      const id0 = task.id || name.replace(/\.json$/, '');
      // Surface the decompose design question to a human BEFORE the terminal action
      // below (requeue, or the cap-spent leave-for-human fall-through), so the original
      // triage still proceeds either way. Best-effort: the helper is idempotent (it
      // scans queue/awaiting-confirm/ + queue/approved/ for the same originalTaskId
      // and no-ops on a repeat), and any failure must never block the sweep.
      if (!DRY_RUN) {
        try {
          const surfaced = surfaceDecomposeDesignQuestion({
            title: clip(task.title || nc.openQuestions || task.blockedReason || `decompose-loop: ${id0}`, 200),
            promptContext: task.promptContext
              || { source: 'needs-clarification-triage', bucket: 'E-decompose-loop', openQuestions: nc.openQuestions || '', blockedReason: task.blockedReason || '' },
            originalTaskId: id0,
            decomposeBlockedAt: (task.stalenessFlag && task.stalenessFlag.at) || now,
          });
          if (surfaced) log(`${id0}: bucket E decompose question surfaced -> ${surfaced.filePath}`);
        } catch (e) {
          log(`${id0}: surfacing decompose question failed (non-fatal): ${e.message}`);
        }
      }
      if (bucketAttempts(task, 'E') < MAX_REQUEUES) {
        const adhocPath = path.join(adhocDir, `${id0}.json`);
        if (fs.existsSync(adhocPath)) {
          log(`${id0}: bucket E but ${id0}.json already in adhoc/ -- already handled, skipping`);
        } else {
          summary.checked += 1;
          const attempt = bucketAttempts(task, 'E') + 1;
          log(`${id0}: bucket E (decompose-loop, not an oversized-file target) -> requeue ${attempt}/${MAX_REQUEUES}`);
          summary.requeued += 1;
          if (!DRY_RUN) {
            for (const f of REQUEUE_STRIP_FIELDS) delete task[f];
            resetStatusForFreshAdhocAttempt(task);
            delete task.stalenessFlag;
            delete task.decomposeBlockCount;
            delete task.autoDecomposeCount;
            delete task.ncTriageDecision;
            delete task.ncTriageReviewedAt;
            bumpBucketAttempts(task, 'E');
            appendHistoryEvent(task, 'requeued',
              `needs-clarification-triage: decompose-loop flag but target is not an oversized file (autoroute declines) -- clean-state retry ${attempt}/${MAX_REQUEUES}`);
            try {
              await classifyRequeue(task, { reasonHint: 'bucket-E: decompose-loop, non-oversized target', requeueWriter: 'needs-clarification-triage', repoRoot });
            } catch { /* classification must never block the real requeue */ }
            try {
              fs.mkdirSync(adhocDir, { recursive: true });
              fs.writeFileSync(adhocPath, JSON.stringify(task, null, 2));
              fs.unlinkSync(file);
            } catch (e) {
              log(`${id0}: requeue move failed: ${e.message}`);
              summary.requeued -= 1;
              summary.errors += 1;
            }
          }
          continue;
        }
      }
      // Cap spent (or adhoc/ race) and still decompose-loop-flagged, non-oversized: fall
      // through to the normal ladder below so it gets an honest, visible leave-for-human
      // stamp instead of staying invisible (the actual bug being fixed).
    }

    // --- Bucket D: false completion-claim signature -> clean-state requeue -----------
    // Checked BEFORE the "already reviewed" skip -- see header. Only acts (and counts
    // toward `checked`) when the signature actually matches; otherwise falls through to
    // the pre-existing flow unchanged.
    {
      const id0 = task.id || name.replace(/\.json$/, '');
      const sig = FALSE_CLAIM_RE.test(String(task.blockedReason || '')) || FALSE_CLAIM_RE.test(String(nc.openQuestions || ''));
      if (sig && bucketAttempts(task, 'D') < MAX_REQUEUES) {
        const adhocPath = path.join(adhocDir, `${id0}.json`);
        if (fs.existsSync(adhocPath)) {
          log(`${id0}: bucket D but ${id0}.json already in adhoc/ -- already handled, skipping`);
        } else {
          summary.checked += 1;
          const attempt = bucketAttempts(task, 'D') + 1;
          log(`${id0}: bucket D (false completion-claim signature) -> requeue ${attempt}/${MAX_REQUEUES}, now caught earlier by the draft-time verification gate`);
          summary.requeued += 1;
          if (!DRY_RUN) {
            for (const f of REQUEUE_STRIP_FIELDS) delete task[f];
            resetStatusForFreshAdhocAttempt(task);
            delete task.ncTriageDecision;
            delete task.ncTriageReviewedAt;
            bumpBucketAttempts(task, 'D');
            appendHistoryEvent(task, 'requeued',
              `needs-clarification-triage: false completion-claim signature (draft asserted something the diff/repo contradicts) -- now caught at draft time by adhoc-diff-sanity.js, clean-state retry ${attempt}/${MAX_REQUEUES}`);
            try {
              await classifyRequeue(task, { reasonHint: 'bucket-D: false completion-claim signature', requeueWriter: 'needs-clarification-triage', repoRoot });
            } catch { /* classification must never block the real requeue */ }
            try {
              fs.mkdirSync(adhocDir, { recursive: true });
              fs.writeFileSync(adhocPath, JSON.stringify(task, null, 2));
              fs.unlinkSync(file);
            } catch (e) {
              log(`${id0}: requeue move failed: ${e.message}`);
              summary.requeued -= 1;
              summary.errors += 1;
            }
          }
          continue;
        }
      }
    }

    // --- Bucket F: turn/context budget exhausted, not a design question -> requeue ---
    // Checked BEFORE the "already reviewed" skip below -- same reasoning as D/E: a stale
    // leave-for-human stamp from before this bucket existed must not shield an
    // already-triaged task from a fix built specifically for this shape.
    {
      const oqF = nc.openQuestions || '';
      const historyF = Array.isArray(task.history) ? task.history : [];
      const hasExhaustedF = historyF.some((h) => h && h.stage === 'exhausted');
      const id0 = task.id || name.replace(/\.json$/, '');
      const isBudgetExhausted = BLOCKER_TYPE_BUDGET_EXHAUSTED_RE.test(oqF)
        || (BUDGET_EXHAUSTED_RE.test(oqF) && COMPLETABLE_NOT_DESIGN_RE.test(oqF));
      if (isBudgetExhausted && !hasExhaustedF && bucketAttempts(task, 'F') < MAX_REQUEUES) {
        const adhocPath = path.join(adhocDir, `${id0}.json`);
        if (fs.existsSync(adhocPath)) {
          log(`${id0}: bucket F but ${id0}.json already in adhoc/ -- already handled, skipping`);
        } else {
          summary.checked += 1;
          const attempt = bucketAttempts(task, 'F') + 1;
          log(`${id0}: bucket F (turn/context budget exhausted, not a design question) -> requeue ${attempt}/${MAX_REQUEUES}`);
          summary.requeued += 1;
          if (!DRY_RUN) {
            for (const f of REQUEUE_STRIP_FIELDS) delete task[f];
            resetStatusForFreshAdhocAttempt(task);
            delete task.ncTriageDecision;
            delete task.ncTriageReviewedAt;
            bumpBucketAttempts(task, 'F');
            appendHistoryEvent(task, 'requeued',
              `needs-clarification-triage: drafter explicitly disclaimed any design uncertainty (ran out of turn/context budget mid-mechanical-step) -- clean-state retry ${attempt}/${MAX_REQUEUES}`);
            try {
              await classifyRequeue(task, { reasonHint: 'bucket-F: turn/context budget exhausted, not a design question', requeueWriter: 'needs-clarification-triage', repoRoot });
            } catch { /* classification must never block the real requeue */ }
            try {
              fs.mkdirSync(adhocDir, { recursive: true });
              fs.writeFileSync(adhocPath, JSON.stringify(task, null, 2));
              fs.unlinkSync(file);
            } catch (e) {
              log(`${id0}: requeue move failed: ${e.message}`);
              summary.requeued -= 1;
              summary.errors += 1;
            }
          }
          continue;
        }
      }
    }

    // --- Bucket G: drafter tagged BLOCKER-TYPE: infra-error -> clean-state requeue ----
    // Same shape and reasoning as F: a tool/environment failure is not a design question,
    // and a transient one usually clears on a fresh pass. resolveAgenticDraft normally
    // catches this upstream; this is the backstop for a task that reached here another way.
    {
      const oqG = nc.openQuestions || '';
      const historyG = Array.isArray(task.history) ? task.history : [];
      const hasExhaustedG = historyG.some((h) => h && h.stage === 'exhausted');
      const id0 = task.id || name.replace(/\.json$/, '');
      if (BLOCKER_TYPE_INFRA_ERROR_RE.test(oqG) && !hasExhaustedG && bucketAttempts(task, 'G') < MAX_REQUEUES) {
        const adhocPath = path.join(adhocDir, `${id0}.json`);
        if (fs.existsSync(adhocPath)) {
          log(`${id0}: bucket G but ${id0}.json already in adhoc/ -- already handled, skipping`);
        } else {
          summary.checked += 1;
          const attempt = bucketAttempts(task, 'G') + 1;
          log(`${id0}: bucket G (BLOCKER-TYPE: infra-error, a tool/environment failure, not a design question) -> requeue ${attempt}/${MAX_REQUEUES}`);
          summary.requeued += 1;
          if (!DRY_RUN) {
            for (const f of REQUEUE_STRIP_FIELDS) delete task[f];
            resetStatusForFreshAdhocAttempt(task);
            delete task.ncTriageDecision;
            delete task.ncTriageReviewedAt;
            bumpBucketAttempts(task, 'G');
            appendHistoryEvent(task, 'requeued',
              `needs-clarification-triage: drafter tagged BLOCKER-TYPE: infra-error (tool/environment failure, not a design question) -- clean-state retry ${attempt}/${MAX_REQUEUES}`);
            try {
              await classifyRequeue(task, { reasonHint: 'bucket-G: infra-error, not a design question', requeueWriter: 'needs-clarification-triage', repoRoot });
            } catch { /* classification must never block the real requeue */ }
            try {
              fs.mkdirSync(adhocDir, { recursive: true });
              fs.writeFileSync(adhocPath, JSON.stringify(task, null, 2));
              fs.unlinkSync(file);
            } catch (e) {
              log(`${id0}: requeue move failed: ${e.message}`);
              summary.requeued -= 1;
              summary.errors += 1;
            }
          }
          continue;
        }
      }
    }

    // --- Bucket J: deterministic-truncation-guard false-block signature -> requeue ---
    // 2026-09-16, same shape as Bucket D (a since-fixed deterministic gate false-positive,
    // not a real design question): src/validate-implement-truncation.js's
    // detectTruncatedImplementResponse(), wired unconditionally into review-task.js by PR
    // #265 (2026-09-14), false-flagged essentially any COMPLETE, correct Group A
    // implementResponse as "truncated output" -- root-caused live 2026-09-16 (~half of
    // real adhoc/brain-dump reviews false-blocked in the hours after it landed), fixed,
    // and merged. A task whose terminal review verdict before escalation was THIS exact
    // deterministic gate (`reviewProvider === 'deterministic-truncation-guard'`) was never
    // actually a design question -- it's a real, already-drafted, already-implemented
    // response that a bug rejected. Checked BEFORE the "already reviewed" skip, same
    // reasoning as D/E/F/G: a stale leave-for-human stamp from before this fix landed must
    // not shield an already-triaged task from it. Not date-scoped -- the signature
    // (`reviewProvider`) is itself the deterministic marker, so this recovers any future
    // task landing here via the identical mechanism (a deterministic review gate later
    // found to be buggy), not just this one incident.
    {
      const id0 = task.id || name.replace(/\.json$/, '');
      if (task.reviewProvider === 'deterministic-truncation-guard' && bucketAttempts(task, 'J') < MAX_REQUEUES) {
        const adhocPath = path.join(adhocDir, `${id0}.json`);
        if (fs.existsSync(adhocPath)) {
          log(`${id0}: bucket J but ${id0}.json already in adhoc/ -- already handled, skipping`);
        } else {
          summary.checked += 1;
          const attempt = bucketAttempts(task, 'J') + 1;
          log(`${id0}: bucket J (deterministic-truncation-guard false-block signature) -> requeue ${attempt}/${MAX_REQUEUES}, now fixed in validate-implement-truncation.js`);
          summary.requeued += 1;
          if (!DRY_RUN) {
            for (const f of REQUEUE_STRIP_FIELDS) delete task[f];
            resetStatusForFreshAdhocAttempt(task);
            delete task.ncTriageDecision;
            delete task.ncTriageReviewedAt;
            delete task.reviewProvider;
            bumpBucketAttempts(task, 'J');
            appendHistoryEvent(task, 'requeued',
              `needs-clarification-triage: deterministic-truncation-guard false-block signature (a since-fixed review gate rejected an already-correct implementResponse) -- clean-state retry ${attempt}/${MAX_REQUEUES}`);
            try {
              await classifyRequeue(task, { reasonHint: 'bucket-J: deterministic-truncation-guard false-block signature', requeueWriter: 'needs-clarification-triage', repoRoot });
            } catch { /* classification must never block the real requeue */ }
            try {
              fs.mkdirSync(adhocDir, { recursive: true });
              fs.writeFileSync(adhocPath, JSON.stringify(task, null, 2));
              fs.unlinkSync(file);
            } catch (e) {
              log(`${id0}: requeue move failed: ${e.message}`);
              summary.requeued -= 1;
              summary.errors += 1;
            }
          }
          continue;
        }
      }
    }


    if (task.ncTriageDecision === 'leave-for-human') continue;           // already reviewed

    summary.checked += 1;
    const id = task.id || name.replace(/\.json$/, '');
    const oq = nc.openQuestions || '';
    const rawText = (task.promptContext && task.promptContext.rawText) || '';
    const history = Array.isArray(task.history) ? task.history : [];
    const hasExhausted = history.some((h) => h && h.stage === 'exhausted');

    // --- Bucket A: degenerate draft -> clean-state requeue -------------------------
    if (DEGENERATE_RE.test(oq) && rawText.length >= MIN_RAWTEXT_FOR_REQUEUE
        && !hasExhausted && bucketAttempts(task, 'A') < MAX_REQUEUES) {
      const adhocPath = path.join(adhocDir, `${id}.json`);
      if (fs.existsSync(adhocPath)) {
        log(`${id}: bucket A but ${id}.json already in adhoc/ -- already handled, skipping`);
        continue;
      }
      const attempt = bucketAttempts(task, 'A') + 1;
      log(`${id}: bucket A (degenerate draft, rawText ${rawText.length}c) -> requeue ${attempt}/${MAX_REQUEUES}`);
      summary.requeued += 1;
      if (DRY_RUN) continue;
      for (const f of REQUEUE_STRIP_FIELDS) delete task[f];
      resetStatusForFreshAdhocAttempt(task);
      bumpBucketAttempts(task, 'A');
      appendHistoryEvent(task, 'requeued',
        `needs-clarification-triage: degenerate "no prior context" draft (rawText intact) -- clean-state retry ${attempt}/${MAX_REQUEUES}`);
      try {
        await classifyRequeue(task, { reasonHint: 'bucket-A: degenerate draft, no prior context', requeueWriter: 'needs-clarification-triage', repoRoot });
      } catch { /* classification must never block the real requeue */ }
      try {
        fs.mkdirSync(adhocDir, { recursive: true });
        fs.writeFileSync(adhocPath, JSON.stringify(task, null, 2));
        fs.unlinkSync(file);
      } catch (e) {
        log(`${id}: requeue move failed: ${e.message}`);
        summary.requeued -= 1;
        summary.errors += 1;
      }
      continue;
    }

    // --- Bucket B: invalid premise / already done --------------------------------
    // adhoc-staleness-flag's `invalid-premise` reason has a known false-positive mode on
    // "create X" tasks (the files are absent because the task's job is to make them), so a
    // stalenessFlag alone is NOT enough -- require a corroborating drafter conclusion too.
    const flagSaysInvalid = task.stalenessFlag && task.stalenessFlag.confidence === 'high'
      && /already-implemented|duplicate-of/.test(String(task.stalenessFlag.reason || ''));
    const excludedFromB = CREATE_TASK_RE.test(rawText) || IN_PROGRESS_RE.test(oq);
    const bucketB = !excludedFromB && (flagSaysInvalid || INVALID_PREMISE_RE.test(oq));

    if (bucketB) {
      const archive = (decisionNote) => {
        log(`${id}: bucket B -> archive (${decisionNote})`);
        summary.archived += 1;
        if (DRY_RUN) return;
        appendHistoryEvent(task, 'archived',
          `needs-clarification-triage: premise invalid / already satisfied -- ${decisionNote}`);
        task.status = 'done';
        const dest = path.join(archiveDir, `${id}.json`);
        try {
          if (fs.existsSync(dest)) { log(`${id}: archive dest exists -- already handled`); summary.archived -= 1; return; }
          fs.mkdirSync(archiveDir, { recursive: true });
          fs.writeFileSync(dest, JSON.stringify(task, null, 2));
          fs.unlinkSync(file);
        } catch (e) {
          log(`${id}: archive move failed: ${e.message}`);
          summary.archived -= 1;
          summary.errors += 1;
        }
      };

      let resolved = false;
      try { resolved = hasResolutionSignal(task, oq); } catch (e) { log(`${id}: hasResolutionSignal threw: ${e.message} -- treating as unresolved`); resolved = false; }
      if (resolved) { archive('verified resolution signal'); continue; }

      if (VOTE_ENABLED && typeof majorityVote === 'function' && votesUsed < MAX_VOTES) {
        votesUsed += 1;
        let vote;
        try {
          vote = await majorityVote({
            prompt: buildInvalidPremisePrompt(task),
            classify: classifyVote(['CONFIRM', 'DENY'], 15),
            n: 3, minAgreeing: 2, temperature: 0.2,
            source: 'needs_clarification_triage', model: VOTE_MODEL,
            // Attribute any SIDE-FINDING: the vote model emits to the task actually being
            // voted on -- without this it lands in the inbox with taskId:null (brain-dump
            // serial 644 "Different Scope" was one such orphan, dedup-counted to 406).
            taskId: task.id, stage: 'nc-triage-premise-vote',
          });
        } catch (e) {
          appendHistoryEvent(task, 'advisory',
            `needs-clarification-triage: premise vote could not run (${(e && e.message || 'vote error').slice(0, 140)}) -- will retry`);
          writeInPlace(file, task);
          summary.errors += 1;
          continue;
        }
        if (vote && vote.confident && vote.verdict === 'CONFIRM') {
          archive(`local vote: ${voteReason(vote, 'CONFIRM')}`);
          continue;
        }
        // confident DENY or inconclusive -> fall through to flag
      }

      // Signal present but unverified -> stamp a medium flag and leave for a human.
      log(`${id}: bucket B but unverified -> flag + leave`);
      summary.flagged += 1;
      if (DRY_RUN) continue;
      if (!task.stalenessFlag || task.stalenessFlag.reason !== 'nc-triage-invalid-premise') {
        task.stalenessFlag = {
          reason: 'nc-triage-invalid-premise', disposition: 'retire', confidence: 'medium',
          at: now, evidence: [oq.slice(0, 300)],
        };
      }
      appendHistoryEvent(task, 'advisory',
        'needs-clarification-triage: premise looks invalid but unverified -- flagged for a human');
      writeInPlace(file, task);
      continue;
    }

    // --- Bucket C: leave for a human ---------------------------------------------
    log(`${id}: bucket C (${hasExhausted ? 'retry-exhausted' : 'genuine question'}) -> leave for human`);
    summary.leftForHuman += 1;
    if (DRY_RUN) continue;
    // Ghost debt -- only the retry-exhausted shape: a mechanical failure that no bucket
    // (A/B/D/E/F/G) caught and only a conditional blocked-drain fix-signature match can
    // ever rescue. A genuine design question is a legitimate human call, not a missing
    // mechanism, so it is deliberately NOT recorded as debt.
    if (hasExhausted) {
      fileGhostDebt({ task, reasonText: oq || task.blockedReason, site: 'needs-clarification-triage:bucket-C-retry-exhausted', pipelineDir });
    }
    task.ncTriageReviewedAt = now;
    task.ncTriageDecision = 'leave-for-human';
    appendHistoryEvent(task, 'advisory', hasExhausted
      ? 'needs-clarification-triage: retry-exhausted -- blocked-drain requeues on a fix signature, else a human'
      : 'needs-clarification-triage: genuine design question -- left for a human');
    writeInPlace(file, task);
  }

  return summary;
}

module.exports = {
  needsClarificationTriage,
  buildInvalidPremisePrompt,
  DEGENERATE_RE,
  INVALID_PREMISE_RE,
  FALSE_CLAIM_RE,
  BUDGET_EXHAUSTED_RE,
  COMPLETABLE_NOT_DESIGN_RE,
  BLOCKER_TYPE_BUDGET_EXHAUSTED_RE,
  BLOCKER_TYPE_INFRA_ERROR_RE,
};

if (require.main === module) {
  const cfg = getConfig();
  const { majorityVote } = require('./local-client.js');
  needsClarificationTriage({ pipelineDir: cfg.pipelineDir, repoRoot: cfg.repoRoot, majorityVote })
    .then((s) => process.stdout.write(JSON.stringify(s)))
    .catch((e) => { process.stderr.write(`needs-clarification-triage failed: ${e && e.stack || e}\n`); process.exit(1); });
}
