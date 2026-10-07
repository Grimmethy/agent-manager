---
name: verify-unmerged-branches
description: Verify every branch in agent-manager's Unmerged Branches tab for value and validity -- find each branch's hub, check the diff is behavior-preserving or correct, run the affected tests in a scratch worktree, catch duplicates and inert halves, and give a merge / hold / discard verdict per branch. Use when the user says "verify the unmerged branches", "check the unmerged branches", "another round of unmerged branch verification", "/verify-unmerged-branches", or asks whether an agent/* branch is worth merging. It records each verdict on the branch's card (border color + badge) through the verdict endpoint, and does NOT merge or discard unless the user then asks. Covers agent-manager specifically (paths, endpoints and field names below are that project's).
---

# Verify unmerged branches

Produces a verdict for each pushed-but-unmerged branch: **merge**, **hold** (inert or waiting on siblings),
**fix first**, or **discard** (redundant). Verification never merges or discards, but it DOES record each verdict on the branch card (step 5) so the tab's
border color and badge reflect it. Merging and discarding are separate steps the user has to ask for, and in this environment they may be blocked (see "Acting on the verdicts").

The written rules this follows are in `docs/agents/unmerged-branch-review.md` (agent-manager repo) and the
"Recurring work processes" table in `docs/agents/codebase-map.md`. Read both first if the session has not.

## 0. Where things are

Paths below use env vars: `AGENT_MANAGER_CORE_REPO_ROOT` = your agent-manager checkout, `AGENT_MANAGER_REPO_ROOT` = the repo the pipeline edits (both come from `agent-manager.env`; set the CORE one by hand). The dashboard is assumed at `localhost:7420`.

- Core checkout (interactive, also the running pipeline's source): `$AGENT_MANAGER_CORE_REPO_ROOT`.
  **Never edit or run mutating git ops in it.** Read-only `git fetch`, `git log`, `git diff`, `git show`, `git worktree add` are fine.
- The default branch is `master`, not `main` (`git branch -r --no-merged origin/master`). `origin/main` errors.
- Live pipeline queue: `$AGENT_MANAGER_REPO_ROOT/queue` (same disk as `$AGENT_MANAGER_CORE_REPO_ROOT/queue`).
- Test runner for the dashboard: `$AGENT_MANAGER_CORE_REPO_ROOT/.venv/bin/python -m unittest ...`. Node tests: `node --test <file>`
  (worktrees need `ln -s <core>/node_modules node_modules`).
- Scratch worktrees go under the session scratchpad, never under `/media/...`. Remove them when done (`git worktree remove --force`, then `git worktree prune`).
- Do not use `pkill -f` / `pkill` with a pattern that also matches your own shell command; it kills the tool call (exit 144).

## 1. List what is actually unmerged

```bash
cd $AGENT_MANAGER_CORE_REPO_ROOT && git fetch -q --prune
git branch -r --no-merged origin/master          # includes non-agent/* branches the tab does NOT show
curl -s localhost:7420/api/git/unmerged-branches # what the tab shows: branch, ahead, behind, willConflict, hub, subject, pushedAt
```

Note `agent/*` only appears in the tab. A `feat/*` or `fix/*` branch is unmerged but invisible there; mention it, and
review it only if asked. `ahead`/`behind`/`willConflict` come from the API; do not recompute them by hand.

Also check the previous round's memory file (`project-agent-manager-unmerged-branches-*.md`) so you can say which earlier branches are gone.

## 2. Per branch: hub context first, diff second

For each branch (this ordering is the whole point of `unmerged-branch-review.md`):

1. **Find the hub and siblings.** The subject often reads `HUBnnnn · k/n · title`. Then:
   ```bash
   grep -rl "<task-id or timestamp fragment>" queue/ | head
   ```
   Hub files live in `queue/coordinating/`; a hub's `subTasks` array lists every sibling with `status`/`phase`. Some hubs
   are already in `queue/done/` (e.g. `function-length-fix-ac-N.json`, matched by `hubLabel`); search `queue/done/` too.
2. Read `promptContext.rawText` (the original ask), `subTaskProposals`, and `localVerdict`/`localVotes` (a hub can carry a
   verdict that its decomposition is incomplete or rejected).
3. **Then read the branch diff**: `git log --format='%h %s' master..origin/<b>` and `git diff master...origin/<b>` (three dots).
4. Classify: a sub-task may be the missing half of a sibling (looks like dead code alone), an **inert addition** (a helper nothing calls until a later sibling wires it), or a **duplicate** of another branch.

## 3. Verify by running things, not by reading

Use a scratch worktree per branch so nothing touches the live checkouts:

```bash
S=<scratchpad>; git worktree add -q --detach $S/w1 origin/<branch>; ln -s $PWD/node_modules $S/w1/node_modules
```

- **Run only the tests for the files the branch touches**, from the worktree (JS: `node --test <file>`; Python dashboard: unittest as above).
  Do not run all of `src/local-draft.test.js` on every branch; it takes minutes and can look hung. Run branches' suites in parallel with `&` + `wait`
  when they do not share files, and use a `timeout`.
- **Behavior-preserving refactors** (function-length decompositions): render the same fixed input on `master` and on the branch and `diff` the
  outputs. Set `AGENT_MANAGER_REPO_ROOT`/`AGENT_MANAGER_PIPELINE_DIR` to a temp dir first if the module reads config, and require
  `src/task-sources.js` before rendering. Identical output plus passing tests is real evidence; a passing suite alone is not.
- **Mutation check for new tests**: break the production behavior (e.g. `sed` out the guard), rerun, and confirm the new test fails, then restore.
  Do this for test-only branches. A test that passes with the behavior removed is worthless.
- **Two branches on the same file**: `git merge --no-commit --no-ff` one into a worktree of the other (then `git merge --abort`). A conflict
  means they are alternatives, not a pair. Compare them (e.g. resulting function length) and recommend one.
- **Candidate-doc branches** (`agent/triage-queue`, `Docs/*_CANDIDATES.md`): list the `+### AC-` headings the branch adds and check each against
  master's doc **and** the current code (function still long? file path moved?). The dedupe key is file plus first identifier, so a candidate
  filed under a moved file path slips past it. Recommend cherry-picking only the genuinely new candidates.
- **Redundancy -> RED (discard).** A branch that is not worth merging must be recorded as a `discard` verdict (red border), not left yellow. Check
  each branch against these, and say which rule applied in the reason:
  1. **Superseded by an open rival.** Two branches from DIFFERENT hubs that conflict with each other
     (`git merge-tree --write-tree --name-only origin/<a> origin/<b>` exits 1 with `CONFLICT`) cannot both merge. If one rewires real code (removes
     non-comment, non-`module.exports` lines) and the other only adds unused helpers, the add-only one is redundant: red. Two add-only rivals, or two
     rewiring ones, are yellow "alternative to X: keep one" -- name the rival and recommend which. Never compare two branches of the SAME hub.
  2. **Superseded by a rival that already merged.** The change was already done another way on master (e.g. an inert `shouldPreliminaryDecompose`
     helper set when master already has `runPreliminaryDecomposeGate` for the same extraction; its hub sibling is done). The deterministic check
     cannot see this, so it is your call: red, with the merged rival and the evidence (function names, hub label, merge commit) in the reason.
  3. **Recurring triage-queue candidates.** For `agent/triage-queue` (or any branch adding to `Docs/*_CANDIDATES.md`) compare each added
     `### AC-N` heading's function name with the headings on master, IGNORING the file path (the dedupe key is file + identifier, so a moved file
     slips through). All added candidates duplicates: red. A mix: yellow, naming the new ones so they can be cherry-picked.
  The automatic checks (`python/dashboard/branch_redundancy.py`, once merged) already apply rules 1 and 3 and record them as deterministic red/yellow
  verdicts; your chat verdict for the same head SHA replaces theirs, so if you disagree, record your own with the reason. Rule 2 is yours alone.
- **Known-bad shapes to flag** (from earlier rounds): a fallback that sets a `claude:*` model override but only calls the local Ollama client
  (does nothing useful); merging a snapshot branch that resurrects entries master already removed.

## 4. Report

One table, one row per branch, then short findings. Each row: branch, hub and position (`k/n`), verdict, the specific evidence
(tests run and counts, equivalence result, conflict result). State plainly what you did **not** test (e.g. suites skipped because the branch
does not touch them). Order recommended merges (dependency order) and name anything to close as redundant.

Record the verdicts (step 5) before writing the report, and say in the report which cards were updated. Save durable results as a project memory (`project-agent-manager-unmerged-branches-<date>.md`) only if the user is likely to come back to them;
update the previous round's file rather than duplicating.

## 5. Record each verdict on its card (always, after verifying)

Every verified branch gets a verdict recorded so its border color changes in the tab: green = merge, yellow = needs-work, red = discard,
grey = unverified or stale. Mapping from step 4: **merge -> "merge"**, **hold / fix first -> "needs-work"**, **discard (redundant, superseded, recurring, already on master) -> "discard"**.

```bash
# headSha comes from the API (the branch head you actually verified); sending it makes a moved branch a 409 instead of a wrong verdict
curl -s localhost:7420/api/git/unmerged-branches | python3 -c "import json,sys;[print(b['branch'],b['headSha']) for b in json.load(sys.stdin)]"
curl -s -X POST "localhost:7420/api/git/branches/<branch>/verdict" -H 'Content-Type: application/json' \
  -d '{"verdict":"merge","reasons":["<specific evidence: tests run, equivalence result, hub state>"],"source":"chat","sha":"<headSha>"}'
```

- `source` is `"chat"` for a verdict from this skill (`"manual"` if the user made the call). A chat/manual verdict is final for that head SHA;
  the automatic deterministic checks never overwrite it. The deterministic checks only set discard (already on master, redundant snapshot)
  or needs-work (conflicts, stale, sibling conflicts) and never green, so **green comes only from a verdict recorded here**.
- `reasons` is what the card shows (first reason under the title, all of them in the detail view) and what gets appended to the owning task and
  hub history. Write specific evidence, not "looks fine". Do not claim tests you did not run.
- A verdict is tied to the head SHA. If the branch gets a new commit, the old verdict reads back stale (grey, "verdict is for an older commit")
  and the branch needs re-verifying. Re-verify rather than re-posting the old verdict.
- Recording only records; it never merges or discards. `404` = not currently listed; `400` = bad body; `409` = head moved (re-fetch, re-verify).
- If the POST is blocked by the classifier or the dashboard is down, say so and list the verdicts in the report. Do not claim the cards were updated.
- After posting, read the API back (`verdict`, `stale`) and confirm each branch shows the verdict you recorded. The colors only appear in the tab
  once the card UI is on the running dashboard; if the tab looks unchanged, check the served `branch-verdicts.js` before assuming the record failed.

## 6. Acting on the verdicts (only when asked)

- Preferred: the user clicks **Merge** / **Discard** in the Unmerged Branches tab (the dashboard endpoints take the apply lock, sync the live
  checkout and update the hub). Discard deletes the remote branch permanently; get an explicit yes for each.
- The auto-mode classifier has blocked both `curl -X POST .../api/git/branches/<b>/merge` and `gh pr create` + `gh pr merge` here
  ("Modify Shared Resources" / "Merge Without Review"), even after the user said to use `gh pr merge`. Do not retry variants, and do not
  route around it. Report what was blocked and offer: (a) the user clicks in the tab, (b) the user adds a Bash permission rule, (c) the user
  runs `! gh pr merge ...` themselves.
- Merge in dependency order. After hub sub-tasks merge, the hub's auto-complete sweep closes the hub; a redundant duplicate branch may also need
  its hub sub-task marked done or superseded.

## Pitfalls

- Judging a branch standalone before checking its hub is the documented way this goes wrong.
- `git diff master...branch` (three dots) not two; two dots includes unrelated master movement.
- Stale local refs: always `git fetch --prune` first, and use `origin/<branch>` not the local branch.
- Do not claim a check you did not run. If the classifier or a timeout stopped something, say so.
