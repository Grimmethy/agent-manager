# Hand-resolving a needs-clarification task: go through the real pipeline, not around it

When a `queue/needs-clarification/` task is diagnosed and fixed by hand (Claude or a
human, outside the automated draft ladder), **the fix must still flow through the
pipeline's own review and apply machinery** — `queue/review/` → `review-task.js`'s real
local-model vote → `queue/approved/` → the dashboard's Apply button → `agent/<id>` branch
→ Unmerged Branches tab → human merge. Do not `git commit`/`push`/`gh pr create` directly
against the shared checkout or any throwaway worktree. That bypasses the exact
verification machinery (fact-checker's cited-path grounding, the acceptance-criteria
gate, review-task.js's deterministic gates, apply-task.js's branch/commit conventions)
this repo exists to enforce on every other task, and produces a branch/PR the dashboard's
own Unmerged Branches view and task-log audit trail never learn about.

Confirmed live 2026-09-15: the first pass at this (task
`adhoc-add-getsecondbraindir-and-requiresecondbraindir-helpers-to-config-js-with-tests`)
was hand-committed and PR'd directly — closed and redone through this process once the
gap was caught. See `queue/done/` for that task's original 6-attempt automated history
and PR #296 (closed, unmerged) for the abandoned direct-PR attempt.

## Why "as though bound by the constraints of the local model"

A `queue/review/` task file is consumed by real code (`review-task.js`, then
`apply-task.js`) that expects the exact shape `local-draft.js`/`agentic-draft-common.js`
produce: a real `git diff` captured from a real worktree, a summary ending in a
`RESOLUTION:` line and (when `acceptanceCriteria` is set) an `Acceptance:` block review
holds the diff to, `task.rawDiff`/`task.implementResponse` in the same concatenated
format. Writing anything looser (a hand-typed diff, a missing Acceptance block, an
acceptanceCriteria list that doesn't match reality) either crashes the pipeline's
parsers or produces a false pass — the review gate becomes decorative rather than real.
The steps below produce a task file indistinguishable, in shape, from what the automated
ladder would have written, using content that is actually true (a diff that really
applies, test output that really ran) rather than fabricated.

## Steps

1. **Diagnose and fix in a real throwaway worktree**, branched off `origin/master` (or
   the relevant base), never in the shared checkout or `agent-manager-manual` (see
   `docs/agents/codebase-map.md`'s "shared checkout risk" caveat, or ask if unsure which
   worktree is safe to touch). Run the real tests. Do not commit or push this worktree —
   it exists only to produce a verified diff; delete it (`git worktree remove --force`)
   once the diff is captured.
2. **One task = one diff.** If the fix bundles a substantive change with a *derived*
   pipeline-hardening fix (the kind of thing normally filed as a brain-dump follow-up),
   split them into separate worktrees/diffs/task files — matches how the pipeline scopes
   every other task and keeps each review vote meaningful.
3. **Capture the diff exactly as the pipeline would**: `git add -A <files>; git diff
   --cached --full-index --binary` inside the worktree. Never hand-type a diff.
4. **Build the task JSON** (see `src/local-draft.js`/`agentic-draft-common.js` for the
   authoritative field shapes; a finished example lives in any `queue/done/adhoc-*.json`
   with `adhocResolution: "implemented"`):
   - `id`, `domain: "adhoc"`, `source: "manual"`, `title`, `promptContext.rawText`,
     `generatedForRepoRoot`, `status: "needs-review"`.
   - `history`: include the original `created` entry if resuming a real queued task, a
     `manual-resolution` entry stating plainly that this was hand-authored and why (link
     the original task id / the root cause), and a final `needs-review` entry. Do not
     fabricate fake `orient-done`/`plan-done`/`implement-started` timings — that
     misleads anyone later grepping history for real local-model timing stats. Honesty
     about provenance is fine; the FIELD SHAPES are what must match the model's output,
     not a pretense that a model produced it.
   - `planResponse`/`lastGoodPlan`: end with a `CRITERIA:` block if the task has a real
     definition of done.
   - `acceptanceCriteria`: run the real `resolveAcceptanceCriteria()` (from
     `src/acceptance-criteria.js`) against your `planResponse`/`promptContext` — don't
     hand-copy criteria, since the whole point of doing this right is that the same
     sanitization the pipeline applies (e.g. `dropSingleFileScopeContradictions`) applies
     here too, and disagreeing with it by hand is a signal you haven't actually fixed the
     contradiction.
   - `implementResponse`: `RESOLUTION: implemented\n\n<real summary>\n\nAcceptance:\n1.
     <criterion> -- <check you actually ran> -- PASS (<real result>)\n...` followed by
     `\n\n=== DIFF ===\n<rawDiff>`. Compute `acceptanceResults` via the real
     `parseAcceptanceBlock()` against this text and confirm every entry's `pass` is
     `true` before filing — a criterion your own summary fails is a sign the fix isn't
     actually done. Watch for a wording collision with `parseAcceptanceBlock`'s
     `PASS`/`FAIL` regex (e.g. "0 fail" trips the `FAIL` match even inside a passing
     line) — reword rather than let a real pass render as a false fail.
   - `rawDiff`: the captured diff, trimmed with a single trailing newline (mirrors
     `group-b-worktree-diff.js`'s `normalizeDiffOutput`).
5. **Verify before filing**: apply the exact `rawDiff` string from the JSON (not your
   working-tree state) against a *fresh* worktree from the same base and re-run the real
   tests. This catches drift between what you captured and what you pasted into JSON.
6. **Drop the file at `queue/review/<id>.json`.** The already-running `review-runner.sh`
   daemon (check `instances/reviewer.json`'s heartbeat, or `ps aux | grep review-runner`)
   picks it up within one tick (~30s) and runs `review-task.js`'s real local-model vote —
   this is the actual verification gate, not theater. Approved → `queue/approved/`.
   Blocked → `queue/blocked/` with a real `blockedReason`; diagnose the block like any
   other rejected draft rather than assuming your hand-authored version was correct.
7. **Apply and merge through the dashboard**, not the CLI: the Job List / Approved view's
   apply action (`/api/task/approved/<id>/apply`, wired to `src/apply-task.js`) pushes
   the real `agent/<id>` branch through `git-runner.js` against `applyRepoRoot`; it then
   shows up in the Unmerged Branches tab for the normal merge/discard flow.
8. **Never mark the original needs-clarification task `done` before the replacement
   lands in review** — that endpoint (`/api/task/needs-clarification/<id>/done`) is for
   work that is *already* verified finished, not a placeholder for work about to be
   redone. If you already did (see the 2026-09-15 incident above), leave the `done`
   record as an honest log of the abandoned automated attempts; the new work gets its
   own task id per step 4, not a rewrite of the old record.

## What NOT to do

- Don't `git commit`/`push`/`gh pr create` yourself for a needs-clarification fix. If a
  PR already exists from before this doc existed, close it (don't merge it) once the
  replacement is filed through `queue/review/`, to avoid two branches for the same diff.
- Don't hand-write a diff, an Acceptance block, or acceptanceCriteria without running the
  real functions that would have produced them — the point of this process is that the
  SAME code gates a hand fix as a model-drafted one.
- Don't skip straight to `queue/approved/` — the local-model review vote is real
  verification (fact-checker cited-path grounding, deterministic gates in
  `review-task.js`), not a bureaucratic hop to route around.
