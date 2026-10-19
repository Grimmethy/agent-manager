# Design Note: Code-Graph Tools for the Local Agent Loop

**Status:** decided 2026-10-19: do **not** add a graph-backed `get_code_neighbors` tool. Revisit only if the conditions at the end are met.
**Related code:** `python/graph_build.py`, `python/graph_edge_resolution.py`, `src/local-tool-client.js` (the read-only tool set), `graphify-out/graph.json` (generated, gitignored)
**Origin:** brain-dump 1894, from the Kaggle Gemma competition harness analysis (`HARNESS_FOR_AM.md`, 2026-10-18)

## The question

The competition harness gives its agent three graph tools over a precomputed per-repo graph: `get_code_neighbors` (callers and callees of a code node), `get_code_subgraph` and `search_similar_code` (`swegemma/tools/graph.py`). AM's tool loop exposes `grep_codebase`, `read_file`, `list_directory` and `run_bash`, but AM already builds a graph. Could a read-only `get_code_neighbors` over `graph.json` save the agent turns ("what else breaks if I change this") the way it does in the harness?

The request set its own gate: first establish how fresh the graph is against the worktree a draft edits and whether it covers `src/*.js` call edges, and only build the tool if the graph is usable.

## What the harness has, and what AM has

| | Harness graph | AM `graph.json` |
|---|---|---|
| Nodes | functions and classes | **files** (532 `.js`, 139 `.py`, 1 `.html`; 672 total) |
| Edges | callers / callees, with embeddings for similarity | 1,438 `{source, target}` links, **no kind, no direction** |
| Built | per repo snapshot, in the task's own checkout | by `graph_build.py` on a schedule or dashboard button, from the **live checkout** |

## What we measured

Read-only, on the live wok checkout at `origin/master` `88289aac`, 2026-10-19.

Method (re-runnable):

1. Take every tracked `src/**/*.js` file (518, tests included). For each, find the relative `require('./...')` calls and resolve each to a tracked file (`x`, `x.js`, `x/index.js`). That set of `(importer, imported)` pairs is the ground truth: **1,233 ordered edges**, which are **1,228 distinct file pairs** once direction is ignored (some files require each other).
2. Take the graph's `src/*` to `src/*` links: **1,227**.
3. Compare the graph's links with the ground truth as ordered pairs and as unordered pairs.
4. Staleness: files under `src/` changed by `git log --since=<graph.json mtime>`, and for each, whether its graph links still equal its real `require` set.

Results:

| Measure | Value |
|---|---|
| Graph links stored in the real require direction | 576 of 1,227 (47%) |
| Graph links that are real requires but stored the other way round | 651 of 1,227 (53%) |
| Unordered: graph links that are a real require between those two files | 1,227 of 1,227 (100%) |
| Unordered: real file pairs present in the graph | 1,227 of 1,228 (99.9%); the one missing is `src/apply-outcome-classifiers.test.js` / `src/task-disposition.js` |
| Non-test `src/*.js` files that are graph nodes | 265 of 270 |
| Graph age at measurement | 12.5 h |
| `src/` files changed since the build | 4, of which 2 already have links that no longer match their real requires |

The graph is an accurate **undirected** file-relatedness graph: it knows two files are connected by a `require`, not which one requires the other (for example it stores `src/ab-model-select.js` to `src/ab-model-select.test.js`, although the test requires the module). It has **no function-level call edges**, so it cannot answer "callers and callees" at all.

## Decision

Do not build the tool, and do not add an env switch for it. Two reasons:

1. **The freshness guard defeats the use case.** The request asks for a guard that refuses stale answers. The only honest staleness test the graph supports is "this file changed after the graph was built". An agentic draft works in a worktree where it has just edited files, so the guard would refuse precisely the files the agent is asking about. A graph built from the live checkout also says nothing about edits in a task worktree.
2. **What is left duplicates `grep_codebase`.** "Which files require X" is a grep over the worktree for the module's name inside `require(...)`: always fresh, direction-aware, no build step. Direction would have to be re-derived from the file text anyway.

The graph stays what it is for: community structure and coverage for `arch_discovery` (see the `python/graph_build.py` row in `docs/agents/codebase-map.md`).

## When to revisit

Reopen this if **both** become true:

- `graph_build.py` emits **directed** edges and **function-level** call edges (callers and callees), not file adjacency; and
- the graph can be rebuilt or incrementally updated **per worktree**, so a draft's own edits are reflected.

Then a read-only `get_code_neighbors` (neighbors only, no embeddings) behind an env switch is worth re-measuring against the grep baseline. The measurement above is the method to repeat.
