# Architecture review candidates — Ornith army backlog

Fed by a recurring Claude-side discovery loop (`backend/agent-pipeline/arch-review-runner.ps1`)
running `/improve-codebase-architecture`'s exploration phase against this repo, informed by
`CONTEXT.md` and `Docs/adr/`. Only `Strength: Strong` candidates are ever written here — this
file feeds `task-sources.js`'s lowest-priority task source (`nextArchReviewTask`), so a
candidate here can get auto-queued to an Ornith worker unattended. Keep every entry narrow
enough that a single bounded task could tackle it (not "refactor the whole X pipeline" — the
single deepest, most isolated piece of that, if it's real). Each entry is scope-gated to 4000
characters by the reader, same discipline as `TROUBLE_LOG.md`'s `🤖` gate — a candidate that
needs more room to describe probably isn't narrow enough yet.

Entry format (parsed by `nextArchReviewTask()`):

```
### AC-NNN · Title
Strength: Strong
Files: comma, separated, paths

Problem:
...

Solution:
...

Benefits:
...
```

IDs are sequential and never reused, even once a candidate is done/blocked — check the highest
existing `AC-NNN` before adding a new one.

---

### AC-001 · Duplicated DB-mirror/JSON-IO helpers across the two agent-pipeline PowerShell loops
Strength: Strong
Files: backend/agent-pipeline/ornith-worker.ps1, backend/agent-pipeline/review-runner.ps1

Problem:
`Invoke-TaskDb` (the best-effort AgentTask DB mirror wrapper, including its PS5.1
quote-escaping workaround), `Read-TaskJson`/`Write-TaskJson`, and `Write-Heartbeat` are
defined independently — not identically, but as the same interface re-derived — in both
`ornith-worker.ps1` and `review-runner.ps1`. There is no shared module; each script
re-implements the same filesystem-queue-to-Postgres mirror adapter. By the deletion test,
removing either copy doesn't remove the concept, it just relocates it — that's duplication,
not two genuine adapters at a real seam.

Solution:
Extract `backend/agent-pipeline/PipelineCommon.psm1` holding `Invoke-TaskDb`,
`Read-TaskJson`, `Write-TaskJson`, and a parameterized `Write-Heartbeat` (instanceId, model,
status, taskId, pass all as params — the worker's `currentPass` field becomes just an
optional param the review loop omits). Both scripts `Import-Module` it instead of inlining
the functions.

Benefits:
A future fix to the PS5.1 native-arg quoting workaround (already bit this build once, per
`Docs/agents/ornith-delegation.md`) or to the heartbeat JSON shape only needs one edit
instead of two kept manually in sync. It also gives the pipeline mechanics their first
place to test independent of a live Ollama/Ornith process.

---

### AC-002 · HUD-rent-lookup-and-patch sequence duplicated between auto-enrich and rent-lookup routes
Strength: Strong
Files: backend/src/routes/propertyActions.js

Problem:
`_hudFmrLookup` is defined as a private helper directly inside the route file rather than in
`src/services/` alongside the sibling `enrichment.js`/`propertyRepository.js` it depends on,
and the same "call HUD, then `propertyRepo.applyFieldPatch(id, { rentEstimate })`" sequence
is written out independently at two call sites in that file: Step 2 of the auto-enrich
handler and the whole body of `POST /:id/rent-lookup`. Auto-enrich also inlines its
staleness decisions and three-step orchestration (scrape -> HUD -> satellite image) directly
in the Express handler, so the only way to exercise "does auto-enrich correctly skip a
non-stale property" is a live authenticated request against a real property row — unlike
`classify.js`/`waterfall.js`, it has no DB-free test surface.

Solution:
Move `_hudFmrLookup` into `src/services/` (or add an `applyHudRentEstimate(id, county,
property, actorContext)` helper next to `applyFieldPatch`) and have both `/rent-lookup` and
auto-enrich's Step 2 call it. Extract the auto-enrich staleness checks + three-step sequence
into a plain function in `src/services/enrichment.js` (e.g. `runAutoEnrich(property, county,
opts)`) that the route just calls and serializes the result of.

Benefits:
Removes the two-call-site duplication of the rent-patch sequence — one place to fix if the
patch shape or error handling changes — and gives the staleness/orchestration logic a
locality-preserving, DB-free test surface instead of only being reachable through Express +
auth + a real property row.

### AC-010 · Internal Helpers Leaking into Public Surface Area of dateParser.js
Strength: Strong
Files: backend/src/utils/dateParser.js

Problem:
The module exports both public functions (e.g., `parseLooseDate`) and private helpers (`_safeStr`, `_yearFromString`, `_toIsoDate`). The single-underscore prefix is a convention, not an enforced contract. More critically, `_toIsoDate` is reachable by any consumer of the module even though it was designed solely to normalize month/day values inside `parseLooseDate`. There is no documented boundary between "internal" and "public," so future consumers may accidentally build dependencies on helpers that are not meant for them.

Solution:
Restrict the public export surface to only the functions that represent a stable contract (e.g., `parseLooseDate`). Move `_safeStr`, `_yearFromString`, and `_toIsoDate` into an internal-only scope — either by declaring them with a double-underscore prefix (`__`) or, more pragmatically, by extracting them into a separate sub-module that is not required by external consumers. If any of these helpers are genuinely useful elsewhere, promote them explicitly as public APIs rather than leaving them in the same file as private ones.

Benefits:
Consumers get a clean, predictable API and cannot accidentally depend on implementation details. Future refactors can change internal helpers without breaking downstream code that only imports the documented contract. The module's responsibility becomes clearer when its surface area is intentionally bounded.

### AC-011 · Concrete Coupling Between auctionMatch.js and dateParser.js
Strength: Strong
Files: backend/src/services/auctionMatch.js, backend/src/utils/dateParser.js

Problem:
`auctionMatch.js` imports `parseLooseDate` from the utility module and calls it inline when processing auction rows. This creates a concrete dependency on date-parsing behavior — any change to `parseLooseDate`'s signature, error handling, or internal logic will break `auctionMatch.js` without an obvious contract violation visible between them. The coupling is tight rather than abstracted.

Solution:
Introduce a small abstraction layer such as `toAuctionDate(input)` that both modules depend on. Define it once — either in the utility module (where `parseLooseDate` currently lives) or as a new dedicated function — and have `auctionMatch.js` call this instead of `parseLooseDate` directly. If date-parsing logic is reused elsewhere, promote it to public; otherwise keep it internal and let both files depend on the same entry point.

Benefits:
The coupling becomes decoupled at the contract level — changing the implementation behind `toAuctionDate` does not require changes in either file's call sites. If date-parsing needs evolve independently of auction matching, the abstraction allows that evolution without ripple effects. The module boundary is now explicit rather than implicit.

### AC-012 · urls.js Mixes Two Unrelated URL-Building Concerns
Strength: Strong
Files: backend/src/utils/urls.js

Problem:
The file handles two distinct use cases — Montana cadastral URL building and Tyler/Flathead county detail page derivation — in a single module. The private helpers (`_buildCadastralUrlMT`, `_buildTylerDetailUrl`) share no clear seam, and the latter alone contains four nested branches (normalizeWithTaxId, deriveFromSearch, Flathead special case, fallback) with significant string manipulation buried inside try/catch blocks that make control flow difficult to follow. If another county type needs URL building, it is unclear whether to split now or wait.

Solution:
Split the file into two focused modules — one for Montana cadastral URLs and one for Tyler/Flathead detail URLs — each exporting only its own responsibility. Keep shared string-utility helpers (if any) in a separate common module rather than nesting them inside either concern. If additional county types are anticipated, create a small registry or factory pattern that routes to the correct URL builder based on county identifier.

Benefits:
Each file now has a single responsibility, making it easier to test, maintain, and extend independently. Adding a new county type becomes a matter of creating a new module rather than modifying an already-complex one. The deeply nested control flow in `_buildTylerDetailUrl` is eliminated, improving readability and reducing the risk of bugs from tangled branches.

### AC-013 · Configurable Fallback URLs Prevent Silent Misrouting
Strength: Strong
Files: backend/python_services/county_map_loader.py

Problem:
Both `build_tyler_url` and `build_webx_url` fall back to hardcoded strings (`https://itax.tylerapp.com`, generic WEBX template) when no per-county config is present. This means a misconfigured or missing county silently serves the wrong URL rather than failing loudly. The fallback path also hides whether the caller actually intended to use that default — there's no way for downstream code to distinguish "no data" from "intentional default."

Solution:
Make the fallback URLs configurable via a `_defaults` field or separate `fallback_urls` configuration so missing county config produces an explicit error rather than silently serving a wrong URL. Callers can then detect incomplete configuration and handle it appropriately.

Benefits:
Downstream code gains visibility into whether data is genuinely absent versus when a default was intentionally applied, enabling proper error handling and audit trails for misconfigured counties.

### AC-014 · Explicit Customer ID Resolution with Validation
Strength: Strong
Files: backend/python_services/county_map_loader.py

Problem:
The `customer_id` extraction tries multiple string keys, then runs a regex against URL values to extract IDs. This "try everything" pattern makes the source of truth unclear — it's hard to reason about which data field actually drives behavior, and silent failures (e.g., URL patterns change) produce wrong results without any warning. The regex also silently drops bad matches rather than raising an error.

Solution:
Narrow the accepted keys to a documented set with explicit validation, or raise when no customer ID can be resolved so callers know they're operating on incomplete data. Replace silent regex matching with structured extraction that surfaces failures clearly.

Benefits:
Callers gain certainty about which fields drive behavior and receive clear signals when data is missing versus when it's been successfully extracted, eliminating silent misrouting caused by URL pattern changes or key mismatches.

### AC-015 · Startup sequence has no error isolation; cascading failure is implicit, not explicit
Strength: Strong
Files: backend/python_services/worker.py

Problem:
`main()` chains five operations sequentially: `connect`, `ensure_control_row`, two `reset_stale_*` calls, `reconcile_adapter_config`, then the API thread and worker loop. If any intermediate step raises (e.g., a stale reset fails but the control row was already created), the already-started resources are orphaned — the process exits with an unhandled exception rather than cleaning up or reporting partial state. There's no try/except around individual steps, so a transient failure in one phase silently leaves the worker in an inconsistent configuration that only surfaces as a hard crash later.

Solution:
Wrap each logical phase of `main()` in its own try/except block with explicit logging and cleanup hooks. On failure in any phase, log the error context (which phase failed, what state was reached), execute rollback where applicable (e.g., close the API thread if only the worker loop started), and return a structured exit code instead of letting Python propagate an unhandled exception.

Benefits:
Failures become observable and recoverable rather than silent orphaned resources. Operators can see exactly which phase failed from logs, partial state is cleaned up deterministically, and the worker process exits with a meaningful status instead of a generic traceback — reducing mean-time-to-recovery for transient issues.
