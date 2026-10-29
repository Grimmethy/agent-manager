---
name: act-as-local-agent
description: Manually walk one agent-manager adhoc task through the real pipeline stages (orient, plan, implement, review, apply) by doing the work directly instead of delegating to the local Ollama model -- producing a task record indistinguishable from one the real system produced, so it can pass through genuine automated review, apply, and merge. Use this whenever the user wants to "process" a brain-dump entry or adhoc task through agent-manager's real pipeline by hand, wants to "act as the in-app agent / local agent / worker" on a specific task, or references running something "through the same rules the in-app AI has to follow." Also trigger on requests to promote a brain-dump entry into a real task and carry it forward. Covers agent-manager specifically -- the env paths and field names below are that project's, not generic.
---

# Act as the local agent

This walks ONE agent-manager task through the real pipeline by hand -- orient, plan,
implement, review, apply -- performing the actual work yourself (reading code, writing a
real plan, making real edits, running real tests) rather than calling the local Ollama
model. Review and apply are the two stages that stay REAL: run the actual CLI/daemon,
never simulate their verdicts.

This exists because doing it the first time (2026-09-26) required reverse-engineering
`local-draft.js` / `orient-pass.js` / `review-task.js` / `apply-task.js` from scratch, and
produced three real mistakes along the way. A second real run, using this skill, avoided
all three of those -- but hit two more of a different shape, plus a serious one that isn't
really a mistake in the work at all (see step 5's guardrail on where to run review, and
step 7). Everything below is the corrected
version of both walk-throughs, not generic advice -- follow the exact field names and file
paths, they are load-bearing.

**The one principle underneath most of the mistakes in both runs:** never describe a
verification in the Acceptance block until you have actually performed it in that exact
form. Run 1's rejections were about *stale* claims (a criterion describing a plan you'd
already abandoned). Run 2's rejections were about *premature* claims -- writing "confirmed
to fail against the pre-fix code, then restored" before actually doing that specific
bypass-and-restore step, or citing a "cross-language parity test" that only existed as a
manual, throwaway check you'd run and discarded, not as a committed test. Both are the
same underlying error: describing verification you intend to do, or once did informally,
as verification you have actually done in the artifact under review. Real review catches
this reliably -- that's a feature, not friction -- but it costs a wasted model-call cycle
every time. Before finalizing `implementResponse`, reread your own Acceptance block one
line at a time and ask, of each claim: did I just run the exact thing this sentence says,
against the exact code in this diff, or am I describing something I believe should work?

**Process exactly one task at a time, and stop for the human between stages.** Several of
the real mistakes below were only caught because a human was reading the task record
along the way. Don't run orient→plan→implement→review→apply end-to-end unattended -- do
one stage, report what happened, wait to be told to continue.

## 0. Environment

Source the real env file instead of re-typing exports -- forgetting one (`LOCAL_MODEL`,
specifically) produces a confusing raw Ollama 400 error instead of a clear message:

```bash
export AGENT_MANAGER_CORE_REPO_ROOT=<absolute path of YOUR agent-manager checkout>
set -a; source "$AGENT_MANAGER_CORE_REPO_ROOT/agent-manager.env"; set +a
```

Two repo roots matter and are easy to conflate:
- `AGENT_MANAGER_REPO_ROOT` (from the env file) --
  the **consumer repo the pipeline edits**. Task files, `queue/`, `brain-dump.json` all
  live under this one. This is where `git log`, `queue/done/`, and the real merge commits
  show up.
- `AGENT_MANAGER_CORE_REPO_ROOT` (set above by hand)
  -- agent-manager's **own source**, where you `node`/`git worktree`/run tests from when
  the work item is a change to agent-manager's own code. This project is self-hosted
  (agent-manager manages itself), so both roots point at clones of the *same* GitHub repo
  -- but they are different directories on disk and git operations on one are invisible to
  the other until pushed+pulled.

`AGENT_MANAGER_APPLY_REPO_ROOT` (a separate checkout of the same repo; see `agent-manager.env`) is a
*third* clone the real `apply` stage uses. You never touch it directly -- see step 5.

## 1. Starting point: promote a brain-dump entry to a real task

If starting from a brain-dump entry id rather than an existing task, do this up front (a
real gap found the hard way -- fixing it after the fact means editing `brain-dump.json` by
hand later instead of getting it right at creation):

```bash
node src/queue-adhoc-task.js --title "<title>" --prompt-context-file <file.json>
```

`<file.json>` is `{"rawText": "...", "raisedFrom": "brain-dump-<id>"}`. This is the exact
primitive Chat's own `queue_reviewed_task` tool calls (`queueAdhocTask()` in
`src/queue-adhoc-task.js`) -- it writes a `domain:'default', source:'manual',
humanQueued:true` record into `queue/adhoc/`.

`queueAdhocTask()` has **zero awareness of brain-dump entries**. It will not link back.
Immediately after, stamp the originating entry in `brain-dump.json` yourself (mirroring
exactly what `/api/brain-dump/<id>/prioritize` does):

```python
entry["status"] = "actioned"
entry["queuedTaskId"] = "<the id queueAdhocTask() printed>"
entry["queuedAt"] = "<now, ISO8601 UTC>"
```

Writing to `brain-dump.json` may be denied by an auto-mode classifier as a shared-resource
edit -- if so, stop and ask the human to approve it rather than finding a workaround.

## 2. Orient -- read-only investigation, done by you directly

Real function: `runOrientPass` in `src/orient-pass.js`. **Do this step yourself, by
reading the actual code** -- do not invoke the local model for it. (This was explicitly
corrected once already: delegating this step to Ollama defeats the point of the exercise.)

Output contract (`buildOrientPrompt`), as your own investigation report:
```
CURRENT STATE: what exists now, 2-4 sentences.
KEY FILES/SYMBOLS: each as `path:line -- what it is`, only ones you actually read.
EXISTING PATTERN TO MIRROR: the closest existing thing, with a path:line.
EDIT LOCATION(S): where the change goes, as specifically as you can.
OPEN QUESTION: anything genuinely ambiguous, or "none".
```
Cite real `path:line`. If you can't confirm something, say "unconfirmed" -- never guess.

**Read the code deeply enough to test your own assumptions before writing the plan.** The
first real run of this skill designed a "consolidate three duplicate functions" plan from
a surface read, then discovered mid-implementation that two of the three answer genuinely
different questions (one checks existence of a path, the other compares two paths for
equivalence) and can't be merged. Reading `resolveAgainstRepoDetailed`'s actual body
during orient -- not just its call sites -- would have caught this before the plan was
even written.

Persist onto the task record:
```json
{ "orientNotes": "<the report above>", "oriented": true,
  "history": [{"stage": "orient-done", "at": "<now>", "detail": "8 turn(s) equivalent -- performed directly by the operator, not delegated"}] }
```

## 3. Plan -- numbered steps + a CRITERIA: block

Real contract (`adhocPlanPrompt` in `src/prompts.js`): a numbered, actionable PLAN, ending
with a line reading exactly `CRITERIA:` followed by 2-5 bullets. `parseCriteriaBlock`
(`src/acceptance-criteria.js`) parses lines matching
`^\s*(?:[-*]|\d+[.)])\s+(.+?)\s*$` immediately after that line -- a blank line ends the
block, so keep every bullet on its own line with no gaps.

Persist:
```json
{ "planResponse": "<full plan text>", "lastGoodPlan": "<same text>",
  "acceptanceCriteria": ["<bullet 1>", "<bullet 2>", ...],
  "acceptanceCriteriaSource": "plan-derived",
  "history": [{"stage": "plan-done", "at": "<now>", "detail": "1 attempt(s), <N> chars, grounded"}] }
```

**Guardrail -- the mistake that cost two rejected review passes:** if orient (or anything
during implement) reveals the plan's approach needs revising, updating
`promptContext.rawText` is not enough. `acceptanceCriteria` must be re-derived to match the
*new* plan too. Leaving a stale criterion describing the abandoned approach is exactly what
the real review model caught, twice, the first time this was run -- it is not a corner
case, it is the default failure mode of a plan revision.

## 4. Implement -- real work, in an isolated worktree, diff as TEXT (not a branch)

Do the actual work in a disposable worktree so nothing touches the live checkouts:
```bash
cd <AGENT_MANAGER_CORE_REPO_ROOT-or-REPO_ROOT-as-appropriate>
git fetch origin -q
git worktree add -b agent/<task-id> <scratch-path> origin/master
```
Make the real edits. Run the affected test suites **before** the change (capture a
baseline) and **after**. If anything fails, check whether it also fails on the clean,
unmodified baseline before assuming your change caused it -- don't guess either way.

**Critical guardrail -- the single biggest mistake made running this the first time:**
implement does not create a real branch/commit in the pipeline's own `applyRepoRoot`. That
is `apply`'s job, and apply runs *after* review approves, not before. Implement only
produces a *proposed diff as text*. Commit inside your throwaway worktree only far enough
to extract a real unified diff (`git show <commit> --format=""`), then persist that text
-- never push or reference that worktree's branch from the task record.

Persist:
```json
{
  "adhocResolution": "implemented",
  "rawDiff": "<the real unified diff text>",
  "implementResponse": "<summary>\n\n=== DIFF ===\n<rawDiff>",
  "acceptanceResults": [ /* see below */ ],
  "history": [{"stage": "implement-done", "at": "<now>", "detail": "..."}]
}
```

`<summary>` must include a literal `Acceptance:` block, one line per criterion:
`N. <criterion> -- <what check you ran> -- <PASS/FAIL + brief result>`.

**`acceptanceResults` is not auto-derived from that text -- you must compute it yourself
and put it on the record, or review blocks immediately with zero model calls spent:**
```bash
node -e "
const { parseAcceptanceBlock } = require('./src/acceptance-criteria.js');
console.log(JSON.stringify(parseAcceptanceBlock(summary)));
"
```
`review-task.js`'s pre-review gate checks `task.acceptanceResults.length` directly, not
the text of `implementResponse` -- a summary with a perfect-looking Acceptance block still
gets rejected with zero GPU spent if this field itself is missing.

**Wording guardrail:** `parseAcceptanceBlock`'s pass/fail detector is
`/\bPASS(?:ED|ES)?\b/i.test(result) && !/\bFAIL(?:ED|S)?\b/i.test(result)`. It searches the
whole result string for the bare word, so writing "0 fail" inside an otherwise-passing
result flips it to `pass:false`. Say "no failures" or "clean," not a count containing the
word "fail."

## 5. Review -- run it for real, but NOT inside a live-watched directory yet

`review-task.js` only ever takes a plain file path as its argument -- it has no idea
whether that path is inside a directory anything else is watching:
```bash
node src/review-task.js <path-to-task.json>
```
This makes genuine local-model calls -- you'll see `[local-client] call timing: ...` lines
in the output when it does. A `[fact-checker] failed to parse targets input... is not
valid JSON` warning is benign and expected (seen on every single run so far, always
harmless); it doesn't stop the run. `factCheckVerdict: "flagged"` alongside a real
`verdict: "approved"` from 2 genuine, substantively-reasoned APPROVE votes is also this
same benign warning, not a second problem -- don't chase it once you've confirmed the
votes themselves are real and substantive.

**Do your first review pass(es) on the file in your scratchpad, NOT in `queue/review/`.**
`queue/review/` is polled by the live `review-runner.sh` daemon on its own cadence. Run 2
of this skill placed the task there and ran `review-task.js` on it by hand -- no move was
even involved, just a plain file sitting in a directory something else also watches -- and
the daemon independently reprocessed an EARLIER, uncorrected snapshot of the same file
concurrently with the manual runs, forking it into two divergent copies with contradictory
history (see step 7). Iterate entirely outside `queue/` (a path under your scratchpad
directory works fine -- the script doesn't care) until you have a real, clean `approved`
verdict, and only THEN place the file into the real queue at all -- go straight to
`queue/approved/` (step 6), skipping `queue/review/` entirely, since review already
genuinely happened.

**If it blocks, read `blockedReason` as a real signal, not noise.** Across both runs, every
single block was a correct, substantive catch, never a false positive: a missing
`acceptanceResults` field, a stale acceptance criterion, an overclaimed test, an
overclaimed verification method (see the principle at the top of this file). Fix the
actual described problem for real and re-run; don't retry blindly hoping for a different
roll, and don't just reword the claim without doing the thing it describes.

## 6. Approved → apply → merge: hand off, don't simulate

Once `status` is `approved` on your scratchpad copy, place it directly into the real
queue -- there's no need to pass through `queue/review/` first, since review already
genuinely happened outside it:
```bash
mkdir -p $AGENT_MANAGER_REPO_ROOT/queue/approved
cp <your-scratchpad-path>/<id>.json $AGENT_MANAGER_REPO_ROOT/queue/approved/<id>.json
```

**Then stop.** Do not manually run apply, push a branch, or open a PR yourself. The live
daemon's own automated apply-and-merge sweep picks up `queue/approved/` on its own next
tick and lands a real merge commit -- you'll see it as `Merge <title> (via dashboard)` in
`git log`. Confirm it actually happened; don't assume:
```bash
git -C $AGENT_MANAGER_REPO_ROOT fetch origin -q
git -C $AGENT_MANAGER_REPO_ROOT log --oneline -3 origin/master
find $AGENT_MANAGER_REPO_ROOT/queue -iname "*<task-id-or-slug>*"
```
The task's file should now be the single copy, sitting in `queue/done/`, with
`status:"done"` and `mergedAt` set.

## 7. Always check for duplicate task-id forks -- after a manual move, AND after any
review pass run against a file already sitting inside `queue/`

Two real incidents, two different triggers:
- Run 1: while a task's file was being moved by hand between queue directories, the live
  daemon's own reject-retry sweep independently reprocessed an earlier snapshot of the
  same task id at the same time. Forked into three files across `done/`, `review/`, and
  `blocked/`.
- Run 2: no move was involved at all -- the file was simply *sitting* in `queue/review/`
  while `review-task.js` was run against it by hand, and `review-runner.sh`'s own polling
  picked up the same file independently. Forked into two files across `blocked/` and
  `adhoc/`.

The common thread is not "moving a file" -- it's *a task file existing inside any
live-watched queue directory while you are also touching it*, whether you move it,
edit it, or run a script against it in place. Step 5's fix (do all your review iteration
outside `queue/` entirely) prevents run 2's specific trigger going forward, but check for
forks anyway after every point where the file was inside `queue/` at all:
```bash
find $AGENT_MANAGER_REPO_ROOT/queue -iname "*<task-id-or-slug>*"
```
If more than one file for the same task id turns up, read each one's
`history`/`status`/`mergedAt` to find the real, most-advanced lineage. Save a copy of
every divergent file as evidence before touching anything (this incident, both times, is
itself real supporting evidence for the duplicate-task-id-lock work agent-manager needs --
don't discard it). Reconcile by hand: pick the fullest/most-correct lineage, correct
anything the fork left stale, verify it OUTSIDE `queue/` again if you touched the diff at
all, and only then place a single clean file back. Confirm with the human before deleting
the stale copies.
