'use strict';

// Bounded re-roll for an inconclusive review vote (HUB0698 1/5). The vote itself is injected as
// runVote (a zero-argument thunk that runs one resolvedMajorityVote call on the same draft), so this
// module never talks to the model directly. An inconclusive first vote is re-run at most MAX_REROLLS
// times per draft. The re-roll budget is keyed by draftKey: a count recorded against a different
// draft counts as 0, so a new draft gets a fresh budget.

const MAX_REROLLS = 1;

function isConclusive(result) {
  return Boolean(result && result.confident && result.verdict);
}

// Per-verdict count of the real votes in a vote result, e.g. { APPROVE: 2, REJECT: 1 }.
function tallyOf(result) {
  const tally = {};
  const votes = (result && Array.isArray(result.votes)) ? result.votes : [];
  for (const vote of votes) {
    if (vote && vote.verdict) {
      tally[vote.verdict] = (tally[vote.verdict] || 0) + 1;
    }
  }
  return tally;
}

// recordEvent is called as recordEvent({ stage, ... }).
async function voteWithOneReroll({ task, draftKey, runVote, recordEvent }) {
  const used = task.reviewVoteRerollDraftKey === draftKey ? (task.reviewVoteRerolls ?? 0) : 0;

  const first = await runVote();
  if (isConclusive(first)) return first;
  if (used >= MAX_REROLLS) return first;

  recordEvent({ stage: 'review-vote-reroll', tally: tallyOf(first), draftKey });
  task.reviewVoteRerolls = used + 1;
  task.reviewVoteRerollDraftKey = draftKey;

  const second = await runVote();
  if (isConclusive(second)) return second;

  recordEvent({
    stage: 'review-vote-hold',
    firstTally: tallyOf(first),
    secondTally: tallyOf(second),
    draftKey,
  });
  task.reviewVoteSplit = true;
  task.reviewInconclusive = true;
  return second;
}

module.exports = { voteWithOneReroll, MAX_REROLLS };
