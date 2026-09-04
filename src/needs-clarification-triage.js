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

const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config.js');
const { appendHistoryEvent } = require('./task-history.js');
const { classifyVote, clip } = require('./auto-confirm-review.js');
const { hasResolutionSignal } = require('./staleness-auto-archive.js');

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

const REQUEUE_STRIP_FIELDS = [
  'needsClarification', 'localRejectCount', 'retryableDraftBlock', 'turnBudgetExhausted',
  'turnBudgetExhaustedBefore', 'adhocResolution', 'subTaskProposals', 'preDrafted',
  'priorRejectionFeedback', 'rawDiff', 'implementResponse', 'blockedReason', 'blockedStage',
  'claimedAt',
];

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

    const nc = task.needsClarification || {};
    if (nc.reason !== 'design-decision') continue;                       // not ours
    if (task.stalenessFlag && task.stalenessFlag.reason === 'decompose-loop') continue; // autoroute owns it
    if (task.stalenessKeep && task.stalenessKeep.until && task.stalenessKeep.until > now) continue; // human said Keep
    if (task.ncTriageDecision === 'leave-for-human') continue;           // already reviewed

    summary.checked += 1;
    const id = task.id || name.replace(/\.json$/, '');
    const oq = nc.openQuestions || '';
    const rawText = (task.promptContext && task.promptContext.rawText) || '';
    const history = Array.isArray(task.history) ? task.history : [];
    const hasExhausted = history.some((h) => h && h.stage === 'exhausted');

    // --- Bucket A: degenerate draft -> clean-state requeue -------------------------
    if (DEGENERATE_RE.test(oq) && rawText.length >= MIN_RAWTEXT_FOR_REQUEUE
        && !hasExhausted && (task.ncTriageAttempts || 0) < MAX_REQUEUES) {
      const adhocPath = path.join(adhocDir, `${id}.json`);
      if (fs.existsSync(adhocPath)) {
        log(`${id}: bucket A but ${id}.json already in adhoc/ -- already handled, skipping`);
        continue;
      }
      const attempt = (task.ncTriageAttempts || 0) + 1;
      log(`${id}: bucket A (degenerate draft, rawText ${rawText.length}c) -> requeue ${attempt}/${MAX_REQUEUES}`);
      summary.requeued += 1;
      if (DRY_RUN) continue;
      for (const f of REQUEUE_STRIP_FIELDS) delete task[f];
      task.ncTriageAttempts = attempt;
      appendHistoryEvent(task, 'requeued',
        `needs-clarification-triage: degenerate "no prior context" draft (rawText intact) -- clean-state retry ${attempt}/${MAX_REQUEUES}`);
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
};

if (require.main === module) {
  const cfg = getConfig();
  const { majorityVote } = require('./local-client.js');
  needsClarificationTriage({ pipelineDir: cfg.pipelineDir, repoRoot: cfg.repoRoot, majorityVote })
    .then((s) => process.stdout.write(JSON.stringify(s)))
    .catch((e) => { process.stderr.write(`needs-clarification-triage failed: ${e && e.stack || e}\n`); process.exit(1); });
}
