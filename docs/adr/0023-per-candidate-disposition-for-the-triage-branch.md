# ADR-0023 — Per-candidate disposition for the triage rolling branch

**Status:** Accepted (roadmap — implementation staged in four slices, brain-dump #1748–#1751; nothing built yet)

## Context

Every triage-style source — `function_length_*`, `observability_*`, `performance_*`,
`change_review`, dead-code triage, `arch_*` — appends its candidate write-ups to a
`Docs/*_CANDIDATES.md` file. Since 2026-09-19 nothing is committed to the default branch
unattended (`src/lib/main-push-policy.js`: "Nothing should ever go to github main like that
without a gate step"), so all of these appends stack as commits on **one rolling branch**,
`agent/triage-queue`, which a human merges or discards. It is one branch, not one per task,
because every task appends to the *same* end of the *same* file; independent branches would
conflict there.

The human decision is therefore **all-or-nothing per branch**, while the content is mixed.

Evidence (brain-dump #1741, measured 2026-10-03):

- `queue/branch-removals.jsonl` records 12 whole-branch decisions on `agent/triage-queue`:
  7 merged, 5 discarded. Three of the five discards were one batch repeatedly resurrected by a
  stale tracking ref (fixed in PR #487); counted by distinct decision it is about 7 merged and
  3 discarded. There is no baseline before 2026-09-19, because before the gate triage went
  straight to the default branch.
- The one recoverable discarded batch (tip `4ef24d50`, discarded 2026-10-01) held three
  `function_length` candidates: AC-197 (new), AC-198 (duplicate of AC-57 / AC-10) and AC-199
  (duplicate of AC-52). The recorded verdict was "cherry-pick AC-197 only"; the tab offers no
  cherry-pick, so the choice was to merge two duplicates or discard the one good candidate. The
  good candidate was discarded.
- Candidates are consumed only from the default branch: `nextCandidateFulfillmentTask`
  (`src/sdk/lib/candidate-lifecycle.js`) reads the doc through `readCandidatesText`
  (`src/lib/candidate-doc-refs.js`), i.e. `origin/<main>`. A candidate becomes a task only after a
  human merges it.
- A candidate whose **authored** text (the `Snippet:` block excluded, `candidateGuardSize`)
  exceeds `MAX_ARCH_REVIEW_TASK_CHARS = 4000` is skipped by that same function with a bare
  `continue` — it never becomes a task and nothing reports why. Measured on everything merged on
  the default branch: 20 of 394 candidates (5%) are over the limit, concentrated in
  `function_length` (19 of 72, 26%) with 1 of 30 in pipeline-fix and none elsewhere; the median
  candidate is about 2,000 characters. All three candidates in the discarded batch were over
  (5,240 / 7,611 / 10,249 characters). The Hygiene tab already labels such a candidate
  `ineligible: oversized … the fulfillment step skips it forever`, but only after a human has
  merged it.

Constraints found in the code that any solution must respect:

1. Triage commits are attributable but **not independent**. Each appends blocks at the end of the
   same doc and later hunks assume earlier ones are present, so cherry-picking commit N without
   N-1 conflicts at end-of-file. A commit message lists `- <title> (task <id>)` and `Task-Log:`
   lines (`src/lib/apply-main-batch.js`).
2. Candidate ids are allocated as max+1 across the default branch **and** every unmerged branch
   (`highestIdAcrossRefs`), and split siblings carry `Depends-On: AC-NNN`, satisfied only once
   MERGED.
3. Only a human action may put anything on the default branch. The dashboard Merge button is such
   an action; so would be an accept control.
4. Task dispositions for a rolling-branch commit read `pending-merge` until the branch is gone,
   and the merge endpoint derives the task id from the branch name, which means nothing for
   `agent/triage-queue`.
5. Merge, Discard and the apply loop all take the same global apply lock, so appends and
   decisions cannot interleave.
6. Already built and reusable: `snapshot_branch` and the richer removal-ledger rows (it parses the
   candidate headings a branch adds, the card's verdict and pins `refs/discarded/*`), the
   candidate-dedupe key, and the Hygiene tab's per-candidate status model.

## Decision

Add **per-candidate disposition on the existing branch** ("decide on the branch, then merge the
rest"), plus a **write-time size gate**. Both were chosen by the owner on 2026-10-03.

**Controls.** In the Unmerged Branches detail view, for a branch that adds candidate docs, show
one row per added candidate with its id, title, files, authored size, originating task and
computed flags (duplicate of an existing key on the default branch, oversized, depends-on
status) plus the card's verdict reasons. Each row can be **Accept**, **Reject** or **Defer**,
with a reason. The whole-branch Merge and Discard buttons remain, and a GitHub PR of the branch
still works unchanged.

**Server action** — `POST /api/git/branches/<branch>/decide-candidates`, under the apply lock,
atomic or no-op:

1. Fetch; refuse (409) if the branch head is not the `sha` the client saw.
2. Parse the added candidate blocks per doc in order and map each to its commit and task.
3. Validate: a missing decision means Defer; an accepted block must not depend on a rejected or
   deferred block unless that dependency is already on the default branch; a rejected block with
   accepted dependents is an error.
4. Build the accepted set on a temporary branch from `origin/<main>` by appending the accepted
   blocks in original order with their original ids (gaps are harmless), commit with `Task:`
   trailers and push the default branch. Any failure before the push leaves everything unchanged.
5. Rebuild the rolling branch from the deferred blocks only (or delete it if none), after pinning
   the rejected content under `refs/discarded/<branch>/<timestamp>`.
6. Record one ledger row per decided candidate (accepted / rejected / deferred, with id, title,
   files, reason, verdict, head sha and snapshot ref).
7. Update task records: accepted → `mergedAt` and a terminal `merged`; rejected → `dismissed`.

**Size gate.** Before a candidate block is appended, measure it with `candidateGuardSize` — the
same measure fulfillment uses. Over the limit: do not append; reject the draft with feedback that
quotes the measured size, so the existing reject-retry loop re-drafts it, and after the retry
budget route it to needs-clarification. Kill switch `AGENT_MANAGER_CANDIDATE_SIZE_GATE=false`.

**Rollout.** Decisions sit behind `AGENT_MANAGER_CANDIDATE_DECISIONS`.

## Options considered

| | A. Inbox (git-free) | B. Decide on the branch (chosen) | C. Revert / cherry-pick on the branch | D. One branch per candidate |
|---|---|---|---|---|
| Idea | Candidates wait as queue files, never as commits; accept appends to the default branch | Per-candidate Accept / Reject / Defer in the branch view; the server rebuilds from the decisions and merges the accepted ones | Drop rejected commits by revert or rebase | Back to a branch per task |
| Fixes all-or-nothing | yes | yes | partly | yes |
| Keeps GitHub PR review | no | yes | yes | yes |
| New storage / large migration | yes | no | no | no |
| Git risk | low | low (atomic, off a temp branch) | high: end-of-file conflicts, rewrites pushed history | reintroduces the conflicts that caused the single branch |
| Removes resurrect / id-collision machinery | yes | no | no | no |

A is the cleaner end state and remains a possible later direction; B's block parser, decision
rows and per-candidate flags carry over to it. C is fragile for the reason in constraint 1. D
regresses to the problem the single branch solved.

## Consequences

- A mixed batch no longer forces a bad trade: good candidates are merged, duplicates and false
  positives are rejected with a recorded reason and recoverable content, and the rest can wait.
- The removal ledger gains per-candidate rows, so mixed-batch rate and decision outcomes become
  measurable, which is what decides whether option A is ever worth building (slice S5).
- Candidates that fulfillment would skip forever stop reaching a human; the rate of
  needs-clarification caused by size becomes visible instead of silent.
- New server surface to maintain: a block parser, an atomic rebuild of a pushed branch, and a
  decision ledger. Id reuse after a reject needs an explicit mitigation (take the maximum with
  the highest id in the decision ledger), because `highestIdAcrossRefs` no longer sees a rejected
  id.
- The decide action pushes the default branch on a human click, like the Merge button; it must
  never run from the pipeline.
- Per-candidate decisions exist only in the dashboard; a PR merged on GitHub is still
  whole-branch.
- New endpoint tests must not take the real global apply lock (brain-dump #1746).

## Build slices

Each is independently shippable, in this order:

- **S1 (#1748)** — write-time size gate. Independent.
- **S2 (#1749)** — read-only per-candidate flags: `GET /api/git/branches/<branch>/candidates` and a
  table in the branch detail view. No git mutation. Independent of S1.
- **S3 (#1750)** — the decide endpoint above. Builds on S2's parser.
- **S4 (#1751)** — the controls, behind `AGENT_MANAGER_CANDIDATE_DECISIONS`. Needs S3.
- **S5** — re-measure from the removal ledger after a few batches and decide whether the inbox
  option is still worth building.

## Not verified when this was written

The front-end branch detail modal code was located (`renderBranchDetailModal`) but not read; the
commit-to-task mapping for a commit that batches several tasks is confirmed only as far as the
commit-message format (`- <title> (task <id>)`), so S3 specifies a title-match fallback that
reports unmatched tasks instead of guessing; the full task-disposition path for a rolling-branch
commit was not traced end to end.
