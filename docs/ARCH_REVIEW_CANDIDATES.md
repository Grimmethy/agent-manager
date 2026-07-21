# Architecture Review Candidates

### AC-1 · Extract Git vs Direct-Write Apply Paths into Separate Functions
Strength: Strong
Files: src/apply-task.js, src/cli/index.js

Problem:
The `applyTask` function in `src/apply-task.js` interleaves two fundamentally different workflowsΓÇögit branch/commit/push (used by the default path) and direct file writes with custom markers/tracking files (used by secondbrain, project_search, deep_dive)ΓÇöin a single branching structure. Each domain returns a different shape (`{ succeeded: true, doneMarker }` vs `{ succeeded: true, branch }`), forcing callers to inspect return values at every call site. Adding a fourth domain requires editing the same function and inserting another `if/else` block with no extension point.

Solution:
Extract two independent functionsΓÇöone handling git-based apply (branching, committing, pushing) and one handling direct-write apply (creating markers, updating INDEX.md or coverage.json). The CLI caller dispatches to the appropriate function based on task domain. Each function returns a normalized `{ succeeded }` shape with optional metadata fields appended per-path. If needed, introduce an `ApplyStrategy` interface so future domains can register their own strategy without touching existing code.

Benefits:
The git and direct-write paths become independent units that can evolve without coupling. New domain types only need to implement the shared contract rather than edit a monolithic function. Return-value inspection at call sites is eliminated because all strategies normalize output shape. The CLI gains a clear extension point for adding domains in the future.

NOTE: No issues were flagged by the review, so this draft was reproduced unchanged.
