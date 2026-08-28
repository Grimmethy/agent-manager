# AGENTS.md

Repo-specific guidance for coding agents working in `agent-manager`.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (`github.com/Grimmethy/agent-manager`), via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`) — no repo-specific overrides. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` (to be created) and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Working directory: never edit this checkout directly

This repo is self-hosting: `AGENT_MANAGER_REPO_ROOT` for the running pipeline points at
this exact checkout, and `apply-task.js`'s git-branch-diff flow calls
`gitRunner.resetToMain()` (`src/git-runner.js`) on it before every single task apply --
`git stash push -u` + `git checkout <mainBranch>` + a push-then-hard-reset onto
`origin/<mainBranch>`. That runs continuously while the pipeline is live, on whatever
schedule the queue produces approved tasks, with no way to know in advance when the next
one lands.

**A manual or agent-driven fix made directly in this checkout will get swept up in the
next `resetToMain()`** the moment it isn't already pushed:
- An uncommitted edit gets auto-stashed (recoverable via `git stash list`, but silently
  parked, not lost) -- confirmed live 2026-08-26, this exact fix restored from `stash@{0}`.
- A real local commit on `mainBranch` that hasn't reached `origin` yet is now pushed
  forward automatically rather than discarded (fixed 2026-08-27, see git-runner.js's own
  comment) -- but that's a safety net for a slip, not something to rely on by default: it
  still means the checkout can switch branches, stash your working tree, or move
  out from under whatever you were mid-edit on, with zero warning.

**Do the fix in a separate worktree or clone instead** (`git worktree add
../agent-manager-manual-fix -b my-fix origin/master`, or an entirely separate clone), then
commit and push a branch from there. That checkout is physically immune to anything
`resetToMain()` does to the pipeline's own repoRoot. Only reach for editing the shared
checkout directly when there's a specific reason to (e.g. inspecting exactly what state
the live pipeline is in right now) -- and treat anything you leave there as ephemeral,
never as the durable copy of the fix.

## queue/ is live pipeline state, not a source tree -- never hand-edit it

`queue/*/*.json` (gitignored) is mutated continuously by `worker-1`, `reviewer`, and
`watchdog` while the pipeline is live -- moving a task file between state directories,
rewriting it in place, isn't a safe filesystem op the way it looks; go through the
dashboard's `/api/task/...` endpoints (`python/dashboard/app.py`) instead, which encode
real invariants a hand-move skips:

- **Requeue** (`POST /api/task/blocked/<id>/requeue`) checks the new `blockedReason`
  against `priorRejectionFeedback` first (`_repeated_blocker_match`) and 409s if this looks
  like the same underlying problem recurring -- `{"force": true}` overrides it, but only
  reach for that once you've actually diagnosed why it'll be different this time, not as a
  reflex unblock.
- **Requeue carries the OLD `promptContext` forward, verbatim** -- it resets status/history,
  not the task's material. If the actual fix is downstream of how `promptContext` gets
  built (see the grounding-freshness gotcha below), requeuing alone reproduces the exact
  same failure. The task needs to not exist at all -- delete the file outright -- so the
  next scan of its source (a candidates doc, an arch-discovery pass, whatever generated it)
  builds it fresh. Confirm the underlying finding is still open before deleting (e.g. still
  `Strength: Strong` in the relevant `Docs/*_CANDIDATES.md`) -- deleting a task whose source
  finding has since been resolved just discards it.

## Grounding freshness: promptContext is frozen at creation, not live

`nextCandidateFulfillmentTask()` (`src/task-sources.js`) snapshots each named file's
content into `promptContext.fetchedFiles` once, at task-creation time. Two different
consumers read that snapshot with two different freshness guarantees, and conflating them
costs a wasted retry cycle:

- **`local-draft.js`** (the plan/implement passes) reads `promptContext.fetchedFiles`
  directly, as frozen -- it never re-fetches. If a sibling candidate touching the same file
  merges in while this task is still queued, the draft is being written against code that
  no longer exists.
- **`get-grounding-source.js`** (the review/fact-check pass) re-reads each `fetchedFiles`
  path's *current* content from `repoRoot` at review time (fixed 2026-08-27 -- see
  `refreshFetchedFileContent`), so review always fact-checks against reality regardless of
  how stale the snapshot is.

The practical effect: a task can get correctly re-rejected at review even after a perfectly
good draft, if a sibling branch changed the target file between draft and review -- that's
not a bug, it's a real conflict, and the fix is a fresh draft (delete + let it regenerate),
not a requeue (which reuses the stale snapshot the draft was already written against).

Snapshotted files over ~8000 chars get windowed, not sent in full
(`windowFetchedFileContent`, fixed 2026-08-27): it centers the window on the first anchor
that matches, strongest first -- (1) a `Snippet:` field (real code text a scanner/reviewer
read, written deterministically by `applyArchDiscoveryCandidates` and matched fuzzily, so
it survives whitespace-only reformatting); (2) the first backtick-quoted symbol from the
candidate's own Problem/Solution prose that's a real substring of the file; (3) a "line
NNN" citation from that prose. It falls back to flat truncation-from-byte-0 only when none
of the three match. A candidate doc entry that describes its target in prose without a
`Snippet:` field and without ever quoting the actual symbol/snippet degrades to the old
blind-truncation behavior for a large file -- when hand-writing or editing a candidates doc
entry, include a `Snippet:` fenced block (or at least quote the real identifier).

## Task sources: built-ins here, hygiene sources in a separate plugin

The `observability_*`, `performance_*`, `function_length_*`, `arch_*` and `unused_export`
task sources moved (2026-08-27) into the out-of-tree **agent-manager-hygiene** plugin,
loaded via `AGENT_MANAGER_REGISTER_PATH` (comma-separated for more than one plugin;
`src/config.js` `ensureRegistered()` `require()`s each once). The live `agent-manager.env`
points it at `/media/wok/model-cache/agent-manager-hygiene/register.js`.

- **`docs/PLUGIN_API.md` is the contract** for what a plugin may `require` from
  `agent-manager/src/*`. `src/plugin-api.test.js` fails in THIS repo's CI if one of those
  exports is removed — update both together.
- The deterministic scanner rules (`observability`/`performance`/`function-length` scans +
  `scan-utils.js`) live in the **plugin** as of ADR-0022 Stage C. `staleness-fastpath.js`
  re-runs a rule via the `registerDeterministicRecheck` seam
  (`src/deterministic-recheck-registry.js`) — it holds no detector code and no source names.
  Core imports nothing from a `src/maintenance/` directory; that directory is gone.
- `arch-discovery-structcheck.js` and `arch-import-fetch.js` **stay here** (worker
  subprocess by hardcoded path; shared repo-search harness).
- `python/build_graph.py` **stays here** — it produces `graph.json` / `community-coverage.json`
  that the plugin's `arch_discovery` reads read-only. Keep the output shapes stable.
- The dashboard's Job List / Pipeline Map and `npm run drift-scan` are registry-driven
  (`node src/task-sources.js --dump-topology`), so plugin sources show up automatically and
  drift-scan stays clean across the boundary. When editing a plugin source, run
  `drift-scan` with `AGENT_MANAGER_REGISTER_PATH` set (the watchdog does).
- **Editing a plugin source:** clone/worktree `agent-manager-hygiene` separately (same
  "never edit the live checkout" rule as this repo — `apply-task.js`'s `resetToMain()` and
  the plugin's own `node_modules/agent-manager` symlink both point at the live tree). Its
  `npm test` runs against that symlink.
