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
