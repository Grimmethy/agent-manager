# Architecture Import Candidates

### AC-1 · Slug Generation Pattern Not Found in Agent-Manager
Strength: Speculative
Source: hatchet-dev-Hatchet — "Pure slug generation with random suffix"
Files: (no real matches found)

Problem:
The search queries proposed to locate analogous slug-generation logic in agent-manager's own codebase returned zero results. This indicates that agent-manager does not currently implement a `generateTenantSlug`-style function, nor does it use patterns like `runId`, `randomSuffix`, or `uniqueId` for deriving slugs from user-provided names in its task pipeline.

Solution:
Since no matching code exists in agent-manager's real files, the original finding cannot be directly adapted here. If agent-manager later introduces slug generation for workflow run IDs or worker group identifiers derived from user input, the recommendation to use crypto-secure randomness instead of `Math.random()` would apply at that point.

Benefits:
No immediate benefit can be realized because there is no corresponding code in agent-manager to improve. Forcing this candidate onto unrelated files would violate the constraint against inventing matches.
