# Deep dive: packages/core/src/fonts (heygen-com/hyperframes)

## Scope check

- `ls packages/core/src/fonts` in the primary checkout (`agent-manager-adhoc-worktree-deep-dive-heygen-com-hyperframes-18`) returned `ENOENT: no such file or directory`.
- `ls packages` and `ls packages/core` both report no such file or directory.
- `git ls-files packages/core/src` returned no output. `git ls-files | grep -i font` returned no output.
- `list_roots` lists no repository named `hyperframes` or `heygen-com-hyperframes`. The registered repos are agent-manager and its plugins.

Result: the directory `packages/core/src/fonts` is absent from this checkout and from every registered repo. There are no source files to inventory.

## File inventory

None. The directory is absent, so no files, exports, or imports were found.

## Data flow

Not applicable. No font loading, resolution, caching, or consumption code was found in the accessible repos.

## Test coverage

Not applicable. No test files for this directory were found.

## Open questions

1. Where is the heygen-com/hyperframes repository checked out? It is not registered with `list_roots`. Once it is registered, or its path is given, this deep dive can be redone against the real `packages/core/src/fonts` files.
2. Does the community `packages/core/src/fonts` refer to a different path in the hyperframes repo? The task context lists an empty `files` array, so the path comes only from the community name.
3. This document is a record of absence, not an analysis of hyperframes fonts code.
