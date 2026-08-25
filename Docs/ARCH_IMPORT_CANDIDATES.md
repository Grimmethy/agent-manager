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

### AC-3 · Strategy-based parsing for LLM structured responses
Strength: Worth exploring
Source: outputguard — "pluggable strategy architecture for malformed output handling"
Files: python/dashboard/grill_sessions.py

Problem:
`_parse_response` in `grill_sessions.py` is a single, monolithic 6-line function that hardcodes one parsing convention (substring check for "STATUS: COMPLETE", then `split("SUMMARY:", 1)` or `split("QUESTION:", 1)`). Its fallback behavior is silent degradation: if the expected marker is absent, it returns the *entire* raw text—including the "STATUS: COMPLETE" or "STATUS: CONTINUE" prefix—as the extracted value, which then gets stored verbatim in the session transcript and later appended to the note by `enrich_note`. There is no way to plug in an alternative parsing or repair strategy (e.g., stripping markdown fences the model may wrap around the response, normalizing case, or recovering a summary when the model emits "Summary:" with a capital S) without editing this one function. As the dashboard grows to consume structured output from additional LLM endpoints (the `ollama_client.generate` call is the only source today, but the architecture invites more), each new source with a different marker convention or failure mode would require another inline `if/else` branch in the same function.

Solution:
Adapt the OutputGuard pattern into a lightweight `ResponseParser` protocol in `grill_sessions.py` (or a small sibling module): define a `parse(text: str) -> dict` interface, then provide concrete strategies such as `StatusMarkerParser` (the current logic, but with explicit per-field extraction and a `repair` step that strips fences / normalizes case before matching), `JsonBlockParser` (for sources that return JSON), and a `RawFallback` that logs a warning instead of silently returning the full text. A `CompositeParser` tries strategies in order and returns the first successful result. `_parse_response` becomes a thin call to the configured composite, and `start_session` / `submit_answer` no longer depend on the parsing mechanics. Adding a new LLM source with a different output convention means registering a new strategy, not editing the call sites.

Benefits:
The silent-degradation path (raw text including status markers leaking into the transcript and the enriched note) becomes an explicit, logged fallback rather than an invisible data-quality bug. New LLM sources or prompt-format changes are additive—register a strategy—rather than requiring edits to the two call sites in `start_session` and `submit_answer`. The parsing logic becomes unit-testable in isolation (feed a fenced response, a case-variant, a missing-marker response) without exercising the full session lifecycle.
