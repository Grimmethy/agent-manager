# applyRepoRoot: per-project apply worktree isolation

## Purpose

Every pool project (a registered project with `"pool": true` in `projects.json`)
runs the same apply loop (`scripts/apply-loop.sh` → `src/apply-task.js`) but
against its own worktree. The worktree is identified by the `applyRepoRoot` field
on the project entry, which the loop sets as `AGENT_MANAGER_APPLY_REPO_ROOT`
before invoking the apply.

Without a dedicated `applyRepoRoot` per project, the apply loop falls back to the
shared default (`/media/model-cache/github`, set in `src/config.js` as
`APPLY_REPO_ROOT_DEFAULT`). All projects then write into the same directory.

## The problem: dirty-tree contamination

When every pool project shares a single apply directory, the following chain of
events happens:

1. Task A runs against Project 1. `apply-task.js` writes its output into the
   shared `/media/model-cache/github` worktree.
2. The worktree now contains Project 1's code, modified by Task A's apply.
3. Task B runs against Project 2. The apply loop sets
   `AGENT_MANAGER_APPLY_REPO_ROOT` to the shared default (no per-project
   override exists).
4. Task B's apply operates on the SAME directory, which still has Project 1's
   code plus Task A's changes -- dirty, uncommitted, potentially conflicting.
5. Task B either applies against Project 1's files by accident, or its own files
   land in a tree contaminated with another project's state.

This is the "dirty working tree from one task's apply must never be committed
into the next task's branch" failure mode. The fix is to give each pool project
its own isolated apply clone, so the apply loop never sees another project's
files.

## The solution

Each pool project gets an apply clone at:

```
/media/model-cache/github/<repoName>-apply
```

The apply loop reads `applyRepoRoot` from the project entry in `projects.json`,
sets it as `AGENT_MANAGER_APPLY_REPO_ROOT`, and all git operations in
`apply-task.js` target that directory instead of the shared default.

`src/pool-projects.js` (the `eligibleEntries` function) already passes
`applyRepoRoot` through to the per-project env, so once the field is set in
`projects.json` the isolation works automatically -- no code changes needed.

## Migration: `scripts/migrate-apply-repo-root.sh`

A one-time migration script exists to set up apply clones for every pool project
that is missing `applyRepoRoot`. It:

1. Reads `projects.json` (from `AGENT_MANAGER_PROJECTS_PATH`, defaulting to
   `./projects.json`).
2. Finds all entries with `"pool": true` and no `applyRepoRoot`.
3. Clones `<repoName>-apply` into `/media/model-cache/github/` from the source
   repo (derived from the existing `repoRoot`).
4. Updates `projects.json` in place, adding `applyRepoRoot` for each project.

### Running the migration

```bash
# From the agent-manager repo root:
AGENT_MANAGER_PROJECTS_PATH=./projects.json bash scripts/migrate-apply-repo-root.sh
```

### Prerequisites

- `jq` (for projects.json manipulation)
- `git` (for cloning)
- `gh` CLI or SSH keys (for authentication to the source repos)
- Write access to `/media/model-cache/github/`

### Idempotency

The script is idempotent: rerunning against an already-migrated `projects.json`
prints "All pool:true projects already have applyRepoRoot set. Nothing to
migrate." and exits 0. Existing apply clones are reused rather than re-cloned;
pass `FORCE_MIGRATE=1` to force a re-clone.

### Error handling

- Missing `projects.json`: exits 1 with a clear message.
- Missing `jq` or `git`: exits 1 naming the missing tool.
- Clone failure: logs the failure, skips the project, continues with the rest.
  Exits 1 at the end if any clones failed so the operator knows to retry.

## Verifying the migration

After running the migration, confirm every pool project has an apply clone:

```bash
jq -r '.[] | select(.pool == true) | "\(.label // .repoRoot): \(.applyRepoRoot // "MISSING")"' projects.json
```

Every line should show a path under `/media/model-cache/github/`, never
"MISSING".

## Related files

- `src/config.js` -- `APPLY_REPO_ROOT_DEFAULT` and the `applyRepoRoot` env var
  resolution.
- `src/apply-task.js` -- consumes `applyRepoRoot` for all git operations.
- `src/pool-projects.js` -- sets `AGENT_MANAGER_APPLY_REPO_ROOT` per borrowed
  project from the entry's `applyRepoRoot` field.
- `scripts/provision-plugin-repo.sh` -- the pattern this migration script
  follows for cloning repos to `/media/model-cache/github/`.
