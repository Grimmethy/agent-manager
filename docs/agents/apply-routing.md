# Applying a diff that belongs to another project (plugin repos)

Question (HUB0156, first raised 2026-09-29): can an approved manual/adhoc task whose real diff edits a plugin repo (wikiforge, a chat plugin, hygiene, ...) be applied by the pipeline today? Checked 2026-10-30 with fixtures only (real temp git repos, no live queue, no push).

## Answer

| Case | Where the approved record sits | Result |
|---|---|---|
| (a) | agent-manager's own `queue/approved/` | FAILS. `applyTask` uses `AGENT_MANAGER_APPLY_REPO_ROOT` (agent-manager's apply clone); `git apply` cannot find the plugin's files. The clone is left untouched. |
| (b) | the plugin project's own `queue/approved/` | WORKS. The apply loop runs that project's pass with `AGENT_MANAGER_REPO_ROOT` = the plugin repo and `AGENT_MANAGER_APPLY_REPO_ROOT` unset. |
| (c) | a premium record in any registered project's `queue/approved/` | Applied by the premium pass (`scripts/apply-loop.sh`, `node src/pool-projects.js --premium-projects apply`), again with that project's own env. Read from the code; not re-run here (nothing premium was waiting in another project). |

## Evidence

- (a) and (b): run on two temp repos, a "core" repo with `tracked.txt` and a "plugin" repo with `content-pipeline/prompts.js`, using the real `applyAdhocDiff` from `src/apply-adhoc-diff.js` and a real diff that edits the plugin file:
  - against the core repo: `git apply failed: error: content-pipeline/prompts.js: No such file or directory`, `git status` clean afterwards;
  - against the plugin repo: applies, returns `{ files: ['content-pipeline/prompts.js'] }`, file content changed.
- (b), live: `node src/pool-projects.js --env-args <chat plugin pipeline dir> <instances dir>` prints `-u AGENT_MANAGER_APPLY_REPO_ROOT` and `AGENT_MANAGER_REPO_ROOT=<plugin repo>`: the plugin pass never uses agent-manager's apply clone.

## What was built, and what was not

The only real gap was the message in case (a): an operator saw a bare git error and had to work out that the record sat in the wrong queue. `src/apply-target-hint.js` now adds one line to that error, only after `git apply` has failed: if none of the files the diff edits exist in this repo and exactly one other registered project holds all of them, the error names that project and the `queue/approved/` directory the record belongs in. It changes nothing about what gets applied, and it stays silent when no single project fits or the failure is something else (a stale diff).

Not built, on purpose: a router that applies a diff to another project from agent-manager's queue. It would duplicate what the per-project passes already do, would need its own push/merge rules per repo, and the first attempt at it (HUB0156 `src/apply-route.js`) assumed `AGENT_MANAGER_APPLY_REPO_ROOT` is a folder of per-repo clones, which it is not.
