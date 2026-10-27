# `projects.json` schema

`projects.json` lives at the repository root (one level above `src/`). It is an
array of project entries consumed by the pipeline at startup: `src/chat-projects.js`
reads it for the dashboard chat (`listProjects`, `resolveProject`), `src/pool-projects.js`
uses it to rank idle-pool candidates, `src/apply-group-a.js` and `src/apply-group-a-brain-dump.js`
route brain-dump entries by project label, and `src/config.js` resolves every
string-path field via `resolveGraphPath`. The environment variable
`AGENT_MANAGER_PROJECTS_REGISTRY_PATH` overrides the file location for tests and
out-of-tree setups.

An entry without a `repoRoot` is skipped; entries are de-duplicated by the realpath
of `repoRoot` (the registry historically lists `agent-manager` twice under two
mount aliases). The runtime shape produced by `listProjects()` is:

```
{ label, repoRoot, pipelineDir, domainsPath, pool, active }
```

where `pipelineDir` defaults to `repoRoot`, `domainsPath` defaults to
`<pipelineDir>/task-domains.json`, and `active` is true only when `repoRoot`
matches the currently selected project.

## Field Reference

| Field | Type | Required | Description |
|---|---|---|---|
| `repoRoot` | string (absolute path) | yes | Absolute path to the project's repository root. Used as the working directory for tasks and the key used to de-duplicate entries. Entries without a `repoRoot` are silently skipped. |
| `label` | string | no | Human-readable project name. Defaults to `path.basename(repoRoot)` when omitted. Case-insensitive match for `resolveProject()`. |
| `pipelineDir` | string (absolute path) | no | Directory that holds the project's pipeline state (queues, history, instances). Defaults to `repoRoot`. De-duplication of idle-pool candidates uses the realpath of this field. |
| `domainsPath` | string (absolute path) | no | Path to the project's task-domain configuration file. Defaults to `<pipelineDir>/task-domains.json`. Resolved via `resolveGraphPath` in `src/config.js`. |
| `pool` | boolean | no | When `true`, the project opts into the idle-pool borrowing system (`src/pool-projects.js`). Idle lanes may pick up work from this project when their own queue is empty. |
| `applyRepoRoot` | string (absolute path) | no | Override root used when applying Group A task-source artifacts for this project. When omitted, `repoRoot` is used. |
| `grepDirs` | array of strings | no | Subdirectories within `repoRoot` that `grep`-based sources should scan. When omitted, the entire `repoRoot` is searched. |
| `toolchainDir` | string (absolute path) | no | Path to a parent project's directory whose `node_modules` should be shared via symlink. See [Toolchain sharing](#toolchain-sharing) below. |

## Toolchain sharing

When a project's repository does not ship its own `node_modules` (e.g. a thin
wrapper or a project that defers dependency installation to a parent), the
pipeline can symlink `node_modules` from a shared parent location into the
scratch worktree before running `review-verify.js`. This avoids redundant
installations and keeps lockfiles in sync across related projects.

### `toolchainDir` semantics

| Aspect | Detail |
|---|---|
| **Type** | Optional string (absolute path) |
| **Default** | Absent — no symlink is performed |
| **Read by** | `src/review-verify.js` during the verify step |
| **Effect** | When set AND the project's `repoRoot` lacks a `node_modules` directory AND `<toolchainDir>/node_modules` exists on disk, `review-verify.js` symlinks `<toolchainDir>/node_modules` into `<scratch-worktree>/node_modules` before running verification. |
| **Skip conditions** | The repo already has its own `node_modules`; the `toolchainDir` path does not exist; the `toolchainDir/node_modules` path does not exist. In all skip cases the verify step proceeds normally without the shared symlink. |

### Behavior When Absent

When `toolchainDir` is missing, empty, or points to a non-existent path, the
pipeline emits a `'no toolchain'` reason with a hint to set `toolchainDir` on
the project entry. This is the fallback documented in the implementation of
`src/review-verify.js`.

| Condition | Result |
|---|---|
| Field absent from the project entry | `'no toolchain'` reason emitted; hint to set `toolchainDir` |
| Field present but empty string (`""`) | `'no toolchain'` reason emitted; hint to set `toolchainDir` |
| Field present but path does not exist | `'no toolchain'` reason emitted; hint to set `toolchainDir` |
| Field present, path exists, but `<toolchainDir>/node_modules` does not | Symlink skipped; verify proceeds without shared modules |
| Field present, `<toolchainDir>/node_modules` exists, repo has no `node_modules` | Symlink created; verify proceeds with shared modules |

### Example

```json
{
  "label": "TaxHarvest-Cowork",
  "repoRoot": "/home/user/repos/taxharvest-cowork",
  "pipelineDir": "/home/user/repos/taxharvest-cowork",
  "domainsPath": "/home/user/repos/taxharvest-cowork/task-domains.json",
  "pool": false,
  "toolchainDir": "/home/user/repos/taxharvest-parent"
}
```

In this example, when `TaxHarvest-Cowork` lacks its own `node_modules`, the
pipeline symlinks `/home/user/repos/taxharvest-parent/node_modules` into the
scratch worktree so verification can run against the shared dependency tree.

## Related

- HUB0235 · 2/4 · Add `createSymlinkSafe` helper in `src/review-verify.js`
- HUB0235 · 3/4 · Integrate `toolchainDir` symlink logic into `verifyDiff`
- HUB0235 · 4/4 · Add `node:test` cases for toolchain directory
