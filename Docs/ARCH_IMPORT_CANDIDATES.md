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

### AC-4 · Add provider-aware base URL defaults and internal getEndpoint() lookup to model-provider.js
Strength: Strong
Files: src/model-provider.js

Problem:
model-provider.js routes tasks between the local (ornith/Ollama) and Claude backends via providerFor(), but there is no single, documented place that resolves each backend's base URL. Base URL resolution is currently scattered or duplicated across individual client modules (local-client.js, claude-client.js), so there's no shared source of truth for defaults, and no way to override a provider's endpoint (e.g. per-environment or per-deployment) without editing those client modules directly.

Solution:
Add a provider-to-endpoint lookup map inside model-provider.js, colocated with the existing routing logic, keyed by the same provider identifiers providerFor() already uses ('local'/'ornith' vs 'claude' -- confirm exact keys by reading local-client.js/claude-client.js's current base-URL handling before implementing). Add an internal, non-exported function getEndpoint(source, override) that: returns override immediately if provided; otherwise checks a per-provider environment variable override (following whatever env var naming convention already exists in the client modules, discovered by reading them -- do not invent a new one if a convention already exists); otherwise falls back to the documented default URL for that provider; and returns null for an unrecognized source. Do not export getEndpoint from the module, and do not modify providerFor()'s existing routing behavior -- this addition lives alongside routing, not intertwined with it. Do not modify local-client.js, claude-client.js, or any other consumer module in this change.

Benefits:
Centralizes base URL defaults and override behavior in one auditable, testable location without disturbing existing routing logic or requiring changes to consumer modules, reducing duplication risk and making future endpoint changes a one-place edit.

### AC-5 · Add unit tests for model-provider.js's new getEndpoint() endpoint-resolution logic
Strength: Strong
Files: src/model-provider.test.js

Problem:
Once model-provider.js gains an internal getEndpoint(source, override) function for resolving each backend's base URL, that logic needs test coverage matching the file's existing node:test/assert-strict style and its withEnv()/freshModelProvider() helper conventions for stubbing environment variables and reloading the module fresh between tests.

Solution:
Add test cases to model-provider.test.js, using the file's existing freshModelProvider() and withEnv() helpers, covering: each known provider returning its correct default endpoint when no override or env var is set; an unrecognized source returning null; an explicit override argument taking precedence over both the env var and the hardcoded default; and (if implemented) a per-provider environment variable override being used when no explicit override argument is passed. Since getEndpoint is not exported, access it only through require.cache reload of the module in the same way the file's other internal-function tests (e.g. reasoningTierFor, resolveModelProfile) already do, or via whatever export pattern the implementation actually uses -- do not add a new public export solely to make it testable if the implementation keeps it module-private and internally referenced.

Benefits:
Ensures the new endpoint-resolution behavior is verified against the same precedence and edge-case rules as the rest of model-provider.js's routing logic, using established test conventions already in the file, with no risk of accidentally exporting new public API surface.

### AC-6 · Scheme guard on the shared `fetchJson` wrapper in gpu-guard.js
Strength: Worth exploring
Source: deepset-ai-haystack — "http/https-only URL scheme guard for LLM-sourced URLs"
Files: src/gpu-guard.js, src/gpu-guard.test.js

Problem:
`src/gpu-guard.js` defines a generic `fetchJson(url, options, timeoutMs)` helper (line 123) that passes its `url` argument straight into the global `fetch` (line 127). Today every call-site in the file constructs the URL from a configuration constant (`OLLAMA_URL`, `theAgentUrl`) or appends a server-returned `app.id`, so the scheme is always `http`/`https` in practice. However, `fetchJson` is a reusable utility (it is even injected as `fetchJsonFn` in tests at `src/gpu-guard.test.js:47`), meaning any future caller—especially one that forwards a task description, worker output, or tool-parameter string into the URL slot—would bypass any scheme check and hand a potentially LLM-hallucinated `file:///etc/passwd`, `gopher://…`, or bare-domain string directly to `fetch`. There is no validation layer between the `url` parameter and the network call.

Solution:
Add a three-line scheme guard at the top of `fetchJson` (and, for symmetry, at the top of `readOllamaVramMb` before it delegates to `fetchJsonFn`): parse the incoming URL with `new URL(url)` and reject any `protocol` not in the set `['http:', 'https:']`, throwing a descriptive `Error` (or returning a typed rejection) before the request is issued. This mirrors the Haystack finding's policy—hard-code the allowed scheme set to exactly `["http", "https"]`—but is implemented inside agent-manager's own `fetchJson` utility rather than imported from another package. The guard is scheme-level, not host-level, so it does not interfere with the existing `OLLAMA_URL` / `theAgentUrl` configuration flow; it simply makes the contract explicit: "this function only talks to http/https endpoints."

Benefits:
Any present or future code path that inadvertently (or adversarially) routes an LLM-generated string into `fetchJson` is stopped at a single choke point rather than requiring every caller to remember to validate. The guard is testable in isolation via the existing `fetchJsonFn` mock pattern in `src/gpu-guard.test.js`, and it converts a silent, potentially dangerous network call into a loud, logged rejection—reducing the blast radius of a hallucinated `file://` or `gopher://` URL from "attempted side-channel read" to "immediate error in the task log."

### AC-7 · Separate model-selection settings from execution context in the Claude client surface
Strength: Worth exploring
Source: microsoft-agent-framework — "Foundry Local client pattern for local-model chat"
Files: python/dashboard/claude_client.py, src/anthropic-pricing.js, src/model-provider.test.js

Problem:
`claude_client.py`'s `generate()` is a flat eleven-parameter signature that mixes three distinct concerns at the same level: model selection (`model`, `effort`), execution context (`cwd`, `allowed_tools`, `max_turns`, `resume`, `add_dirs`), and Ollama-compat sampling knobs that are explicitly "accepted but ignored" (`think`, `temperature`, `num_predict`). The docstring itself notes the ignored params exist "only so callers built against ollama_client.generate()'s interface don't need a separate call shape per provider." Meanwhile `anthropic-pricing.js` independently re-derives the same model via `defaultClaudeModel()` reading the identical `CLAUDE_MODEL` env var, and `model-provider.test.js` confirms the routing layer (`providerFor`) is a separate concern that decides which client module handles a given source. The result is that "which model do I want" is entangled with "where and how do I execute it" in one call signature, and the model-resolution logic is duplicated across the Python wrapper, the pricing estimator, and the JS client's own env fallback.

Solution:
Adapt the finding's "manager owns connection details, settings carry only model selection" split to agent-manager's existing two-language boundary. Concretely: (1) introduce a small `ClaudeModelSelection` dataclass (or TypedDict) in `claude_client.py` carrying only `model` and `effort`—the two knobs that map to `claude-client.js`'s own selection—so callers express *what* they want in one object. (2) Keep `cwd`, `allowed_tools`, `max_turns`, `resume`, `add_dirs` in a separate `ClaudeExecutionContext` (or keep them as a second positional/keyword group) so the "where/how" is visually and type-wise distinct from the "what." (3) Drop `think`/`temperature`/`num_predict` from `generate()`'s signature entirely; the dashboard callers that need a uniform interface can pass them to a thin `ollama_client.generate()` adapter instead, removing the "accepted but ignored" dead weight. (4) Have `anthropic-pricing.js`'s `defaultClaudeModel()` and `claude_client.py`'s `model or os.environ.get("CLAUDE_MODEL", "sonnet")` both delegate to a single shared resolution helper (a one-line function in `model-provider.js` that both the JS pipeline and the Python wrapper can call), eliminating the duplicated env-read-and-fallback logic.

Benefits:
Callers reading `generate()` immediately see which parameters affect model choice versus execution scope, reducing the cognitive load of the eleven-param list and making the "ignored" params disappear rather than persist as a documented trap. The single model-resolution helper removes the risk that `anthropic-pricing.js` and `claude_client.py` drift apart on the default (e.g., one adds a new env override, the other doesn't). The `ClaudeModelSelection` object is the natural unit to thread through `model-provider.js`'s routing and into `anthropic-pricing.js`'s cost estimate without re-reading env vars at each site, mirroring the finding's insight that the settings surface should be the minimal, stable "which model" contract while the manager (here, `claude-client.js` plus the subprocess plumbing) owns everything else.

### AC-8 · Adopt GUARDRAIL span vocabulary for the majority-vote review gate
Strength: Strong
Source: omnigent-ai-omnigent — "GUARDRAIL span-kind as vocabulary for review gates"
Files: scripts/review-runner.sh, docs/adr/0019-deep-dive-pipeline.md, docs/adr/0022-core-is-a-platform-plugins-define-the-work.md

Problem:
`scripts/review-runner.sh` is the concrete implementation of agent-manager's majority-vote review gate: it scans `queue/review/*.json`, invokes `review-task.js`'s Ornith gate, and produces an approve-or-block verdict per task. ADR-0019 and ADR-0022 both treat this gate as load-bearing architecture ("the majority-vote review gate, the deterministic (no-LLM)" core), and ADR-0019 explicitly notes that gate decisions carry a reason (e.g., "Ignore items are written down with a one-line reason rather than omitted"). Yet the gate's output vocabulary is ad-hoc: the shell script and the JS worker each decide their own field names for the verdict, and there is no shared span-kind or attribute set that downstream tooling (a local SQLite viewer, a Grafana dashboard, an MLflow run log) can filter on without reverse-engineering each emitter. The result is that "did the gate block this task, and why?" is answerable only by reading the specific JSON shape that `review-task.js` happens to write, not by a queryable, self-describing schema.

Solution:
Adopt the three-kind span taxonomy (AGENT / TOOL / GUARDRAIL) from the omnigent finding, scoped to the single GUARDRAIL kind that agent-manager actually needs. When `review-runner.sh` (or the `review-task.js` it invokes) emits a structured record for a gate decision, tag it with `span.kind = "GUARDRAIL"`, `policy.name = "majority-vote"`, `policy.phase = "review"`, `policy.action` set to `"allow"` or `"deny"` (mapping the existing approve/block), and `policy.reason` carrying the one-line justification the ADRs already require. This is not a new subsystem; it is a naming convention layered onto the JSON that `review-runner.sh` already writes into the queue. ADR-0022's "core-is-a-platform" framing means this vocabulary becomes the contract every future plugin's review gate must satisfy, so the cost is paid once.

Benefits:
Downstream consumers stop inventing parallel field names: a SQLite `WHERE span_kind='GUARDRAIL' AND policy_action='deny'` query works uniformly across `deep_dive`, `project_search`, `arch_discovery`, and any future source without per-domain schema knowledge. Alerting on gate denials (e.g., "more than 3 blocks in 10 minutes → something is systematically failing the gate") becomes a one-line filter rather than a grep across heterogeneous JSON shapes. Because the vocabulary is three attributes and one label, the adoption cost in `review-runner.sh` is a few lines of field naming, not a new library or middleware layer, and it keeps agent-manager's "deterministic, no-LLM" core (per ADR-0022) free of any additional runtime dependency.
