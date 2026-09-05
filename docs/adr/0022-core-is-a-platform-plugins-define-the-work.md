# ADR-0022 — Core is a platform; plugins define the work

**Status:** Accepted (roadmap — implementation staged, see below)

## Context

Agent Manager and its programming-hygiene task sources
(`observability_*`, `performance_*`, `function_length_*`, `arch_*`, `unused_export`) were
built together. Hygiene was the forcing function for much of the platform's design, so it
was never modelled as an optional add-on — it was woven through shared machinery.

A first extraction (agent-manager PRs #3–#10, see `we-really-need-to-merry-token.md` and
`docs/PLUGIN_API.md`) moved the hygiene **task-source definitions** — each source's `next` /
`apply` / prompt builders / registration — into a separate `agent-manager-hygiene` repo,
loaded via `AGENT_MANAGER_REGISTER_PATH`. Core's dashboard and `drift-scan` became
registry-driven off `node src/task-sources.js --dump-topology`.

That left a **half-extraction**. The definitions moved, the substrate did not:

- **Deterministic scanners** — `src/maintenance/{observability,performance,function-length}-scan.js`
  + `scan-utils.js` (~585 lines) stay because core `staleness-fastpath.js` re-runs their
  rules *by name*.
- **Candidate-doc engine** — `nextCandidateFulfillmentTask` + the windowing / fuzzy-match /
  snippet-grounding helpers in `task-sources.js` (~310 lines) plus `src/candidate-docs.js`,
  shared with core `backlog_decomposition` / `backlog_fulfillment`.
- **Prompt bodies** — the `archReview*` / `archDiscovery*` / `archImport*` / `unusedExport*`
  builders still in `src/prompts.js` (~200 lines); `backlog_fulfillment` reuses `archReview*`.
- **~15 per-source-name branches / literals** across `local-draft.js`, `review-task.js`,
  `apply-task.js`, `system-report.js`, `staleness-fastpath.js`, `task-source-registry.js`,
  `arch-discovery-structcheck.js`, and `python/dashboard/app.py`.
- **`arch-discovery-structcheck.js`** (worker invokes by hardcoded path) and
  **`python/build_graph.py`** (produces `arch_discovery`'s graph input).

The result is the worst of both worlds: the cost of two repos and a boundary, without the
benefit of a core small enough to reason about or a plugin free to evolve its own candidate
format or scanner rules independently. Reading `task-sources.js` or `review-task.js` now
means hitting code — a candidate-fulfillment engine, `if (task.source === 'arch_import')`
branches — whose consumers live in another repo, so the code no longer tells a complete
story about itself.

## Decision

**Agent Manager's job is to manage agents — keep them working — not to define the work.**

Core is the platform: the queue state machine, worker/instance management, the
Plan→Draft→Review→Apply loop, the majority-vote review gate (emitting verdicts in the GUARDRAIL span vocabulary: `span.kind`, `policy.name`, `policy.phase`, `policy.action`, `policy.reason`), the deterministic (no-LLM)
apply step, the GPU / budget / heartbeat guards, the dashboard, and a **task-source SDK**. This vocabulary is part of the platform's output contract; plugins consume it in their `apply` step and must not assume ad-hoc key names.

Core contains **no `registerTaskSource` call and no task-source name string** in `src/*.js`
or `python/dashboard/*.py`. Every definition of *what work agents do* lives in a plugin
loaded via `AGENT_MANAGER_REGISTER_PATH`. The entire contract between core and a plugin is
`--dump-topology` plus the SDK documented in `docs/PLUGIN_API.md`. Core has little utility
on its own — that is the intended state. Keeping core and each plugin small is the point:
a monolith gets progressively harder to manage as it grows; small focused units stay
legible.

### Plugins

| Plugin | Owns | Status |
|---|---|---|
| **agent-manager-hygiene** | code-quality review of the consumer repo: `observability_*`, `performance_*`, `function_length_*`, `arch_*`, `unused_export` | exists; half-extracted |
| **project-development** (future, name TBD) | external-project study & adoption: `deep_dive`, `project_search`, `arch_import`'s external-repo side, possibly `backlog_*` | not started; its own effort (Stage H) |
| **self-audit** (open question) | `pipeline_self_audit`, `pipeline_health_audit`, `ui_visibility_audit`, `staleness_audit`, `pipeline_forensics` (+ `pipeline_forensics_fix`) — and/or the platform's always-on I/O sources | see Open questions |

### SDK additions

Optional fields on a `registerTaskSource` / `updateTaskSource` config, all consumed
generically by core (they replace the per-source-name branches):

| Field | Replaces | Consumed by |
|---|---|---|
| `directToMain: true` | `DIRECT_TO_MAIN_SOURCES` literal (duplicated in two files) | `apply-task.js`, `--dump-topology` |
| `reviewGuidance: string \| (task) => string` | `review-task.js` `if (task.source === …)` block | `review-task.js` verdict-prompt builder |
| `draftHook: { harnessFetch?, skipImplementWhen?, structuralCheck?, … }` | `local-draft.js` arch_import branches; the hardcoded `arch-discovery-structcheck.js` call | `local-draft.js` draft flow |
| `reportClass: 'benefit' \| 'filtering' \| …` | `system-report.js` `if (source === …)` | `system-report.js` |
| `graphInputBuilder: <script path>` | `build_graph.py` hardcoded invocation | dashboard "Build Graph", `queue-watcher.sh --check-due` |
| `description`, `domain` | `app.py`'s `SOURCE_DESCRIPTIONS` / `_SOURCE_TO_DOMAIN_KEY` maps | `--dump-topology` → `/api/job-types` |

New registry APIs:

- `registerSourceAlias(taskSourceField, registryName)` — e.g.
  `registerSourceAlias('deadcode_triage', 'unused_export')`; `resolveSourceName` consults
  the alias map instead of a hardcoded `if`.
- `registerDeterministicRecheck(sourceName, { ruleDetectors, repoWideDetectors, reportText })` —
  the plugin registers its `(text, relPath) => findings` fns and templates;
  `staleness-fastpath.js` looks them up by `originalSource` with zero name knowledge.

## Implementation (staged)

Each stage is an independently shippable PR (or small set), core + plugin tests green, the
pipeline runnable throughout. Recommended work order: **A → D → B → C → E → F → G**, then H
as its own effort. A and D are the lowest-risk, highest-legibility wins and unblock the rest.

### Stage A — Registry behavior fields (core only, additive, no source moves)
Replace every `if (task.source === '<name>')` in the loop entry points with a registry
field, read generically: `directToMain`, `reviewGuidance`, `draftHook`, `reportClass`,
`structuralCheck`; `registerSourceAlias()`; `--dump-topology` gains `description` / `domain`
so `app.py` drops its last two hardcoded maps (frozen-snapshot fallback as in Phase 3).
Risk: touches review/draft/apply hot paths — one field per PR, each keeping the old literal
as a `field ?? OLD_LITERAL.has(name)` fallback until Stage G. Verify: full suite,
`--dump-topology`, a real worker+review+apply tick per changed path.

### Stage B — Invert `staleness-fastpath`
`registerDeterministicRecheck(...)`; `staleness-fastpath.js` consults the registry
(`ensureRegistered()` already runs on that path post-#10). No-op fallback to today's LLM
path when nothing is registered. Move the recheck report-text templates into the plugin
registration. Blocks Stage C. Verify: `staleness-fastpath.test.js` rewritten against
fixture rules; a live `staleness_audit` of an `observability_review` finding still
auto-archives.

### Stage C — Move the scanners to the hygiene plugin
`src/maintenance/*-scan.js` + `scan-utils.js` + tests → `agent-manager-hygiene/src/`; the
plugin's `*-review.js` imports flip to local `./`; `register.js` calls
`registerDeterministicRecheck` for observability + performance. `src/maintenance/` is
deleted from core. Update `docs/PLUGIN_API.md`. Verify: both suites; `drift-scan` clean; a
live scan + deterministic recheck.

### Stage D — Candidate-doc SDK
Consolidate `candidate-docs.js` + `nextCandidateFulfillmentTask` + the windowing /
fuzzy-match / snippet helpers into one clearly-labelled SDK module
(`src/sdk/candidate-fulfillment.js`) that core ships and documents but registers nothing
with. `docs/PLUGIN_API.md` gains an "SDK helpers" section. `task-sources.js` shrinks ~310
lines. No behavior change — `backlog_*` and the plugin both import from the new path.

### Stage E — Move `backlog_*` + arch prompt bodies out of core
`backlog_decomposition` / `backlog_fulfillment` are work-definitions; move them plus the
`archReview*` / `archDiscovery*` / `archImport*` / `unusedExport*` prompt bodies out of
`src/prompts.js`, which then keeps only the generic fragments. Home for `backlog_*` is an
open question (hygiene, its own plugin, or the Stage-H project-dev plugin). Blocks on
Stage D.

### Stage F — Graph builder registration
`graphInputBuilder` field names a script; the dashboard button and `queue-watcher.sh
--check-due` run whatever's registered. `build_graph.py` / `visualize_graph.py` move to the
hygiene plugin; the dashboard shells out via the registered path.
`community-coverage.json` / `graph.json` paths stay config-driven. Independent — any time
after A.

### Stage G — Cleanup + guard
Delete every leftover source-name literal / fallback from Stage A. New test: grep
`src/**/*.js` + `python/dashboard/*.py` for the known task-source names → **must be empty**
(comments excluded). That invariant is what keeps core clean going forward. Final
`docs/PLUGIN_API.md` / `AGENTS.md` / `CONTEXT.md` pass; tag both repos.

### Stage H — project-development plugin (separate effort, not this ADR)
`deep_dive`, `project_search`, `arch_import`'s external-repo study side, and
`arch-import-fetch.js` move to a new `agent-manager-project-dev` plugin. Sequenced after
A–G because it reuses the same SDK. `arch-import-fetch.js` has three non-arch consumers
(`pipeline_self_audit` / `pipeline_health_audit` / `ui_visibility_audit`); those either
move to a self-audit plugin (Open questions) or `arch-import-fetch.js` stays in core as a
shared harness utility.

## Consequences

- **Positive:** core becomes small and self-describing — queue + workers + review + apply +
  registry/SDK + config + dashboard, no task source, no source-name string. Each plugin
  owns its domain end to end and can change its candidate format, scanner rules, or prompts
  without a coordinated core release. The `--dump-topology` + SDK contract is enforceable
  (`src/plugin-api.test.js`, plus the Stage-G no-names grep).
- **Negative / cost:** Stages A and B touch the draft/review/apply hot paths — highest-risk
  edits in the codebase. More repos to release together during a transition. The SDK grows
  a handful of new fields/APIs that are themselves a contract to maintain. Anyone who has
  only ever seen Agent Manager *with* hygiene has to relearn where things live.
- **Neutral:** the half-extracted state is stable and shippable; there is no forced deadline
  to finish. Stages can land opportunistically between other work.

## Open questions

1. Do the platform's always-on sources (`adhoc`, `brain_dump_sort`, `path_prefetch_resolve`,
   `trouble_log`, `secondbrain`, `research_task`) eventually move to a `core-reflexes`
   plugin? The principle says yes; `adhoc` is the manual escape hatch and `getNextTask()`
   hardcodes `adhoc` / `brain_dump_sort` as allowlist-exempt. Lean: keep in core for now,
   revisit after Stage G.
2. `pipeline_self_audit` / `pipeline_health_audit` / `ui_visibility_audit` / `staleness_audit`
   / `pipeline_forensics` (+ its `pipeline_forensics_fix` consumer, added 2026-09-01)
   audit the pipeline itself — legitimately core (the platform watching itself) or a
   `self-audit` plugin? This also decides where `arch-import-fetch.js` lands (Stage H).
   `pipeline_forensics` reads deep core internals (`task.draftAttempts`, `work-log.js`,
   `model_calls`, `pipeline-self-audit.js`'s signature primitives, `system-report.js`'s
   accounting) that are deliberately *not* in `docs/PLUGIN_API.md`; if this cohort ever
   becomes a plugin, `forensic-bundle.js` + `pipeline-forensics.js` move with it as one
   unit and those internals join the contract then, not now.
3. `backlog_*` home (Stage E): fold into `agent-manager-hygiene`, its own `backlog` plugin,
   or the Stage-H project-dev plugin? It is product-backlog work, closer to
   project-development than code-hygiene.
4. `build_graph.py` shipped from a Node plugin (Stage F): acceptable as a script the
   dashboard shells out to, or should the graph builder be its own tiny service? Lean:
   script is fine.
