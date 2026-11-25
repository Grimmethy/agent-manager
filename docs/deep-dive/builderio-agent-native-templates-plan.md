# Deep dive: BuilderIO/agent-native templates/plan

## Scope and method

Requested target: `templates/plan` in the BuilderIO/agent-native project (community 21, `communityId` 21 in the task payload). The task payload lists no files for this community.

Read-only checks run in the primary checkout (`/tmp/agent-manager-adhoc-worktree-deep-dive-builderio-agent-native-21`):

1. `grep_codebase` for the literal `templates/plan` across all searchable dirs (`dir: "."`). Result: `[]`, no matches.
2. `list_directory` on `.`. Result: 39 entries, none named `templates`. The top level contains `Docs`, `docs`, `Projects`, `Research`, `pipeline`, `python`, `src`, `test`, `tests`, `tools`, `vendor`, `wiki-kb` and similar. No `templates` directory is present.
3. `grep_codebase` for the literal `agent-native` across all searchable dirs. Result: only references to the upstream project, not to its source. `docs/adoption/builderio-agent-native-slides-actions.md` line 3 states that the upstream `templates/` tree is not present in this checkout (`ls templates` fails here).
4. `list_roots`. Result: 33 roots, none of them a BuilderIO/agent-native repository. The closest matches are unrelated `*forge` and plugin repos.

No file was read under `templates/plan`, because none was found to read.

## Inventory table

| Path | Size | Type | Purpose |
|---|---|---|---|
| `templates/plan` | n/a | missing | Not present in the primary checkout (step 1 and step 2 above). Not present in any accessible root (step 4). |

No other files were inventoried, because the scope directory was not found.

## Structure and how the templates fit together

Unknown. No files under `templates/plan` were available to read, so no structure, template fields, or relationships between templates are described here. Any description would be invented.

## Dependencies

- Confirmed present: none. No file under `templates/plan` was read, so no import or reference from it was traced.
- Missing: all dependencies of `templates/plan`, because the directory itself is missing.

## Callers and consumption points

A grep for `templates/plan` in the primary checkout returned no matches (step 1). No caller in this checkout references the path. Callers in the upstream BuilderIO/agent-native repository were not checked, because that repository is not accessible from this machine.

## Open questions

1. Is the BuilderIO/agent-native repository meant to be checked out on this machine? If so, its absolute path is not registered in `list_roots`, so it cannot be read.
2. If the repository is not available, should this community be documented from a copy supplied with the task, as was done for `templates/slides/actions` in `docs/adoption/builderio-agent-native-slides-actions.md`?
3. Which upstream commit or ref should the deep dive target? The task payload gives no revision.
