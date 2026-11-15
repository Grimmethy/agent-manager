'use strict';

// The vote and the decision of runReview (roadmap step 1, piece P6.5b): wait for a free local model, build the verdict prompt, take the 3-vote majority
// and turn it into an approved or blocked review result. Moved out of review-task.js unchanged; the four helpers that still live in review-task.js
// (waitForLocalAvailability, buildVerdictPrompt, classifyVote, decideInconclusiveOutcome) are handed in through the ctx so this module never requires it.

const { appendHistoryEvent } = require('./task-history.js');
const { resolveSourceName } = require('./task-source-registry.js');

// ctx: { task, factCheck, groundingText, factCheckVerdict, instancesDir, resolvedMajorityVote, recordModelOutcome,
//        waitForLocalAvailability, buildVerdictPrompt, classifyVote, decideInconclusiveOutcome }
async function runVoteAndDecide(ctx) {
  const { task, factCheck, groundingText, factCheckVerdict, instancesDir, resolvedMajorityVote, recordModelOutcome,
    waitForLocalAvailability, buildVerdictPrompt, classifyVote, decideInconclusiveOutcome } = ctx;
  await waitForLocalAvailability(instancesDir);

  const verdictPrompt = buildVerdictPrompt(task, factCheck, groundingText);
  // minAgreeing: 2 of 3 -- a genuine majority, matching majorityVote()'s own documented
  // default and intent (an ABSOLUTE count of agreeing real votes, guarding against e.g. 1
  // real + 2 degenerate votes looking like a confident 1-0 consensus -- see that function's
  // comment). This was 3 (i.e. requiring full unanimity from 3 independent, temperature-0.2
  // but still stochastic votes) -- confirmed live 2026-08-16: 23 of 181 blocked tasks,
  // the second-largest group in queue/blocked/, were real 2-1 splits (both real REJECT-
  // majority AND, invisibly, any real APPROVE-majority) discarded as "no confident
  // majority" purely because one of three votes dissented, not because the verdict was
  // actually unclear.
  const voteResult = await resolvedMajorityVote({
    prompt: verdictPrompt,
    classify: classifyVote(['APPROVE', 'REJECT'], 20),
    n: 3,
    minAgreeing: 2,
    temperature: 0.2,
    source: task.source,
    taskId: task.id,
    stage: 'review-vote', // HUB0280-02: local-client.js call() records these votes in model_calls
  });

  // 2026-08-24, Grimmethy: "are there any efficiency buffs you can think of" -- voteErrors
  // (added alongside majorityVote()'s own per-vote resilience fix, commit 0ac54b9) was
  // computed but never actually read anywhere -- real diagnostic signal (which votes
  // hard-failed, and why) silently discarded on every single review, exactly the kind of
  // "why did this take 3x longer than expected" trail that took hours of manual log
  // archaeology to reconstruct by hand earlier tonight. Surfaced into both voteSummary
  // (so it's visible in the task's own history without opening the raw field) and a new
  // task.voteErrors (so it's queryable structured data, same convention task.localVotes
  // already uses for the real vote responses).
  const voteErrorSuffix = voteResult.voteErrors && voteResult.voteErrors.length > 0
    ? `, ${voteResult.voteErrors.length} vote(s) hard-failed`
    : '';
  const voteSummary = `votes: ${voteResult.realVoteCount}/${voteResult.requestedVotes} real${voteErrorSuffix}`;

  if (!voteResult.confident || !voteResult.verdict) {
    // brain-dump bd-1788725054994: Tasks 13/18/20/24 were requeued solely on 3/3
    // inconclusive votes, costing tokens without changing task complexity. An adhoc
    // task passes through with a caveat instead of blocking.
    const _sourceName = resolveSourceName(task);
    const _inconclusiveDecision = decideInconclusiveOutcome(_sourceName, voteResult);
    if (_inconclusiveDecision.passThrough) {
      task.reviewedAt = new Date().toISOString();
      task.reviewProvider = 'local';
      task.localVotes = voteResult.votes;
      task.voteErrors = voteResult.voteErrors;
      recordModelOutcome({ callId: task.abCallId, outcome: 'approved', outcomeStage: 'review', outcomeReason: `pass-with-caveat: inconclusive votes on adhoc source (${_sourceName})` });
      appendHistoryEvent(task, 'approved', `pass-with-caveat: inconclusive votes (${voteSummary}), adhoc pass-through`);
      return { succeeded: true, verdict: 'approved', factCheckVerdict };
    }
    const reason = `Local-model review inconclusive, no confident majority (${voteSummary})`;
    task.reviewProvider = 'local';
    task.localVotes = voteResult.votes;
    task.voteErrors = voteResult.voteErrors;
    recordModelOutcome({ callId: task.abCallId, outcome: 'rejected', outcomeStage: 'review', outcomeReason: reason });
    appendHistoryEvent(task, 'blocked', reason);
    return { succeeded: true, verdict: 'blocked', blockedReason: reason, blockedStage: 'review', factCheckVerdict };
  }

  if (voteResult.verdict === 'APPROVE') {
    const sampleVote = voteResult.votes.find((v) => v.verdict === 'APPROVE');
    task.reviewedAt = new Date().toISOString();
    task.reviewProvider = 'local';
    task.localVerdict = `Confident majority APPROVE (${voteSummary})\n\n${sampleVote ? sampleVote.response : ''}`;
    task.localVotes = voteResult.votes;
    task.voteErrors = voteResult.voteErrors;
    recordModelOutcome({ callId: task.abCallId, outcome: 'approved', outcomeStage: 'review', outcomeReason: null });
    appendHistoryEvent(task, 'approved', voteSummary);
    return { succeeded: true, verdict: 'approved', factCheckVerdict };
  }

  const sampleVote = voteResult.votes.find((v) => v.verdict === 'REJECT');
  const match = sampleVote && sampleVote.response.match(/REJECT:\s*(.+)/);
  const reason = match ? match[1] : `REJECT (${voteSummary})`;
  task.reviewProvider = 'local';
  task.localVotes = voteResult.votes;
  task.voteErrors = voteResult.voteErrors;
  recordModelOutcome({ callId: task.abCallId, outcome: 'rejected', outcomeStage: 'review', outcomeReason: reason });
  appendHistoryEvent(task, 'blocked', reason);
  return { succeeded: true, verdict: 'blocked', blockedReason: reason, blockedStage: 'review', factCheckVerdict };
}

module.exports = { runVoteAndDecide };
