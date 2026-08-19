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

### AC-2 · Provider-aware base URL defaults in model-provider routing
Strength: Strong
Source: contrix — "Base URL defaults per provider type"
Files: src/model-provider.js, src/model-provider.test.js

Problem:
`model-provider.js` currently implements a two-way backend selection (ornith vs. claude) with no concept of endpoint configuration beyond what each client module independently resolves. The routing logic (`providerFor()`) and the base URL resolution are decoupled — there is no single source of truth for which endpoint a given provider maps to, so adding support for additional backends requires patching every consumer rather than registering them alongside the routing table.

Solution:
Extend `model-provider.js` with a provider-specific base URL mapping that lives alongside the existing routing logic. Add a `getEndpoint(source)` helper (internal, not exported) that resolves endpoint configuration by looking up the selected provider in a centralized map, falling back to documented defaults for each backend. The function should accept an optional override parameter so callers can inject per-request endpoints when needed. Update `model-provider.test.js` with coverage for every branch: known providers returning their default endpoints, unknown sources returning `null`, and explicit overrides taking precedence over defaults.

Benefits:
Adding new providers becomes a matter of registering them in one lookup table plus implementing their client module, without touching routing logic or duplicating configuration patterns. Operators can override base URLs per-provider via environment variables without modifying source code — the override path flows through the same helper already tested. The model-stats labeling already distinguishes ornith vs. claude; extending this to capture endpoint metadata (region, API version) becomes natural when the provider selection layer owns that information.

NOTE: Flag 2 was not fully applied because its reasoning appeared incomplete and I cannot confirm whether `configFor` was intended as exported or internal without the full critique text -- the corrected draft uses an internal helper instead to avoid any ambiguity about public surface area.
