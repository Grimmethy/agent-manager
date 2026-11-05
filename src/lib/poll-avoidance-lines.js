'use strict';

// ADR-0024 ("triggers, not polls", docs/adr/0024-triggers-not-polls.md): new work states which EVENT would remove a poll and its measured idle cost. The poll detector (src/poll-detector.js,
// docs/agents/poll-detector.md) is the shared definition of a poll; these lines put the same rule in front of the model that PLANS a change, the model that WRITES it and the model that
// REVIEWS it, so a new poll is stopped where it would be written, not found by a scan afterwards. Advisory text only: nothing here blocks a task (the pre-merge gate is a separate, later
// stage that starts in shadow mode). Pure, no imports, so it can move with the detector.

const POLL_OK_TOKEN = 'poll-ok:';

// What a poll is, in one sentence, shared by all three prompts.
const WHAT_A_POLL_IS = 'A poll is code that wakes up on a clock and looks, whether or not anything changed: setInterval, a setTimeout that re-arms itself, a while-true loop that sleeps, schedule.every, a systemd timer, a cron schedule.';

// For the model that plans a change.
const PLAN_LINES = [
  'NO NEW POLLS (ADR-0024, triggers not polls): the idle system must cost almost nothing, so do not plan a poll.',
  WHAT_A_POLL_IS,
  `If the change must react to something, plan the EVENT that triggers it (a file watch, a queue write, a hook, a callback, a signal) and name it in the plan. If no event exists, the plan says so, states the measured idle cost of the poll it keeps, and puts \`${POLL_OK_TOKEN} <reason>\` in a comment on that line or the line above.`,
  'A retry wait with an attempt limit, a one-shot sleep and a test are not polls.',
].join(' ');

// For the model that writes the change (the implement pass).
const IMPLEMENT_LINES = [
  'NO NEW POLLS (ADR-0024): do not add setInterval, a self re-arming setTimeout, an unbounded loop that sleeps, schedule.every, a timer unit or a cron schedule. React to the event your plan names instead.',
  `The only exception is a poll with no event to replace it: then the comment on that line, or the line directly above, says \`${POLL_OK_TOKEN} <the reason>\` (an empty reason does not count). Bounded retry waits, one-shot sleeps and tests are not polls. Leave polls that were already in the file alone.`,
].join(' ');

// For the model that reviews the draft.
const REVIEW_LINES = [
  'POLL CHECK (ADR-0024, triggers not polls):',
  WHAT_A_POLL_IS,
  `If an ADDED line of the draft is a poll, vote REJECT unless that line or the line directly above carries \`${POLL_OK_TOKEN} <non-empty reason>\` or the plan names the event that replaces it.`,
  'Bounded retry waits, one-shot sleeps, tests and polls that were already in the file are NOT grounds to reject.',
].join(' ');

module.exports = { PLAN_LINES, IMPLEMENT_LINES, REVIEW_LINES, WHAT_A_POLL_IS, POLL_OK_TOKEN };
