# Splitting a subsystem into its own repo: the recurring process

The project is growing past what should live in one repo, and this is going to keep
happening — pulling a subsystem (Hub Tasks, Brain Dump, hygiene's scanners, ...) out of
`agent-manager` into its own plugin repo. This doc is the recurring process, generalized
from actually doing it once end-to-end (the manifest-driven dashboard tab slot, S0 of the
Hub Tasks extraction, PR #455, 2026-09-23), so the next extraction doesn't start from
zero. Read this before starting a new one; add to it after finishing one.

**In-flight / planned extractions** (check here first — someone may already have mapped
or half-built the one you're about to start):

| Target | Status | Doc |
|---|---|---|
| Hub Tasks → `agent-manager-hub-tasks` | S0 done (PR #455). S1 (claim-ordering/dependency-release hooks, PR #459), S2 (apply-result routing hook, PR #460), S3-a (decompose/split-proposal detection hook, narrowed from full S3, PR #461) all merged 2026-09-23. S4a done 2026-09-24 (file-decompose family moved to hygiene, PR #468). **S4b done, 2026-09-25**: repo scaffolded, then both task-level producers moved -- producer 4 (candidate split, `candidate-split-hub-route.js`) and producer 1 (adhoc decompose, `decompose-pass-route.js`; the latter's swap point degrades gracefully rather than throwing, since it's on the hot path for every adhoc draft — see the Worktrees section's incident note). Their caller-side dispatch logic stays in core. Hub-intake hook shape decided (section 3) but the fuller generalization deferred to S5. S3's `verifyMove` hook, S5-S6 not started. | `Docs/hub-tasks-extraction-plan.md` |
| Brain Dump → standalone plugin repo | Still in the decision phase — no sequenced plan yet (single owner for `brain-dump.json`, vault/project-registry adapters both undecided) | `Docs/brain-dump-extraction-map.md` |

## The process

Originally written down in `Docs/hub-tasks-extraction-plan.md` section 8 for one specific
extraction; this is the same steps, generalized. For "extract subsystem X into its own
repo":

1. **Map** the target: every part, the record shapes, the seams. Produces a standalone
   `Docs/<x>-extraction-map.md` — see the two docs in the table above for the shape this
   takes.
2. **Verify the map against the code** with a read-only pass; record the corrections. A
   map written from memory or a fast read is wrong in places every time — don't trust it,
   or the model's own report of it, unchecked.
3. **Order the work interface-first**: add hooks/registrations to the source registry with
   today's code as the default (so behavior is unchanged), then move code behind them,
   each step independently shippable and leaving the live pipeline/dashboard working.
4. **List the decisions only a human can make**, each with a recommended default; record
   who decided what. Don't let an unresolved decision block starting the mechanical parts
   that don't depend on it.
5. **Find the blocking preconditions** by asking a narrow question, not by starting the
   big step. (Here: "can a plugin add its own dashboard tab?" — no — which became S0.)
6. **Decompose each precondition into PR-sized pieces**, each with files, a named test, a
   rollback, and its dependencies on the other pieces. 4-8 pieces is the range that's
   worked so far; six for the manifest tab slot.
7. **File the pieces as a brain-dump entry** so the pipeline's own decompose pass can
   build them as a hub — *or*, per the note below, build them directly in a session like
   this one when the work benefits from a human in the loop at each piece.
8. **Feed the outcome back** into the map and the plan doc, including anything that turned
   out wrong or was found along the way (see "Lessons" below for a worked example).

Mechanical (automatable now): 1–3, 6, 7. Needs a human: 4, any outward-facing step
(creating a remote repo), and every merge.

## When to build directly instead of filing a brain-dump entry

The process above (step 7) assumes the pipeline's own local-model ladder builds each
piece. For the manifest tab slot, Grimmethy instead had Claude build all six pieces
directly in a session, one piece at a time with a review/commit checkpoint after each —
confirmed as the right cadence for this kind of work (not a correction; an explicit
preference after the first two pieces landed). Prefer this when:

- The pieces touch code across both runtimes (Python + browser JS here) in ways that
  benefit from a single coherent read of the whole mechanism, not independently-drafted
  pieces that each need to be checked for drift against the others.
- A verification pass across the finished pieces (see below) is cheap to do in the same
  session, catching cross-piece bugs immediately rather than as separate follow-up tasks.

Still file a brain-dump entry / hub for the *next* thing this precondition unblocks (e.g.
Hub Tasks' S1) rather than piling more scope into the same session unprompted.

## Lessons (from building S0, the manifest tab slot)

- **Run a dedicated verification pass before calling a multi-piece build done**, even
  though each piece was tested individually as it landed. This caught two real issues
  that no single piece's own tests would have: piece 3 introduced a bug piece 4 and 5's
  tests didn't happen to exercise (see below), and piece 5 made a piece-3 workaround
  redundant. Multi-step builds accrete this kind of self-obsoleting leftover; a session
  that stops as soon as the last piece's own tests pass will miss it.
- **Real script-load-order matters and is easy to test around by accident.** A `vm`
  sandbox test that pre-seeds a global so the function under test is callable (e.g.
  `CORE_TABS` in `core-ui.js`'s own tests) can mask a bug that only shows up when the
  file actually runs in the browser's real `<script>` tag order. Concretely: `let TABS =
  CORE_TABS;` at `core-ui.js`'s own top level threw `ReferenceError` on every real page
  load, because `core-ui.js` loads via `<script src>` *before* the inline `<script>` block
  in `index.html` that defines `CORE_TABS` — silently undefining `renderNav` and
  everything below that line. The per-function unit test never caught it because it
  supplied `CORE_TABS` itself. **Whenever a change touches more than one browser-JS file
  that load in a fixed order, add a test that runs them in that real order with nothing
  pre-seeded**, not just per-file unit tests.
- **No browser-JS test harness existed in this repo before this build.** The fix: load
  the real file with Node's `vm` module — the same oracle-execution technique
  `scripts/extract-core-ui.js` already used (real V8 parses and runs the actual source; no
  hand-rolled lexer, no mocked behavior) — with a minimal fake `document`/`localStorage`
  stubbed only for what the code under test actually touches. This is now the working
  pattern; see `scripts/manifest-tab-*.test.js` for four worked examples of increasing
  complexity (pure functions → DOM-touching functions → cross-file dispatch → a fixture
  run through the whole pipeline).
- **A real checked-in fixture, exercised from both directions, is the strongest available
  proof when there's no live browser to test against.** `test-fixtures/manifest-tab-example-plugin/`
  is a real, minimal, working example — not a mock — and two tests exercise its *exact*
  on-disk bytes: one from the serving side (Python: the route hands back the same bytes,
  gated correctly on enabled/disabled and the feature's kill switch) and one from the
  consuming side (JS: that same file's real content, executed for real via `vm`, actually
  registers and renders through the real dispatch code). Neither test mocks the other
  side's behavior.
- **Work in a dedicated worktree, never the shared checkout** — see "Worktrees" below.
- **`gh pr merge --delete-branch` can report failure when the merge actually succeeded.**
  If the base branch (`master`) is checked out in a different worktree, `gh`'s post-merge
  step (switching the *local* worktree to the base branch) fails and the command exits
  non-zero — but the merge on GitHub itself already went through. Check `gh pr view
  --json state,mergedAt,mergeCommit` before assuming the merge failed and retrying; if it
  shows `MERGED`, just delete the remote branch by hand (`git push origin --delete
  <branch>`) since `--delete-branch` never got to run.

## Worktrees

`agent-manager`'s own checkout is shared/live — **never edit or run git operations
against it directly**; that's the live pipeline's working tree, and stray edits or
branch/checkout changes there race whatever the pipeline itself is doing. Do
extraction/refactor work in the `agent-manager-manual` worktree instead: branch from
`origin/master` (not local `master`, which is checked out in the shared checkout and
can't be checked out twice), do the work, push, and merge with `gh pr merge` from there.
(`docs/agents/manual-nc-resolution.md` references this same caveat for hand-resolving a
needs-clarification task — this is the doc that promise pointed at.)

**The same rule applies to every plugin's checkout, not just core's.** Confirmed live
2026-09-25 during the hub-tasks extraction's producer-1 move: editing files (even just
`git checkout <branch>` plus new untracked files, no commit) directly inside
`agent-manager-hub-tasks`'s checkout took the live pipeline down, because that exact
directory is what `plugins.json`'s `registerPath` points at — `AGENT_MANAGER_REGISTER_PATH`
resolution reads whatever is on disk at that path, not a specific git ref, so a branch
checkout changes live behavior the instant it happens, with no commit or merge needed.
The new `register.js` required a core module (`decompose-pass-route.js`) that only existed
in the separate core worktree, not yet merged into the live `agent-manager` checkout —
every worker tick's `require()` then threw before printing any output, which surfaced as
opaque empty `draft call failed for X:` lines, not an obvious stack trace. **Fix going
forward: `git worktree add ../<plugin>-manual -b <branch> origin/master` for every plugin
repo the same way core already gets a `-manual` worktree**, and only touch the plugin's
live checkout directory with a plain `git pull --ff-only` after the PR is merged — never a
branch checkout or an uncommitted edit. (This incident is why `agent-manager-hub-tasks`
now has a sibling `agent-manager-hub-tasks-manual` worktree.)
