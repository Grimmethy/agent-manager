# ADR-0017 — Architecture discovery as a first-class task type, not a separate loop

**Status:** Accepted (design only — not yet implemented; manual test required before autonomous rollout)

## Decision

`/improve-codebase-architecture` becomes a repeatable, decomposed task category (`domain: 'arch_discovery'`) inside the existing `agent-pipeline` queue, not a dedicated always-on script. A discovery task is drafted, critiqued, and reviewed by exactly the same `ornith-worker.ps1` → `review-runner.ps1` → `apply-runner.ps1` machinery every other task already goes through — plan/implement/critique passes, majority-vote review, atomic queue-state transitions, crash-resume, heartbeats. Nothing new is built for the review or fulfillment stages.

Concretely:

- **Selection** — a new `community-coverage.json` tracker lists every graphify community (currently ~186, from `graphify-out/graph.json`'s `node.community` field) with `lastReviewedAt`. `task-sources.js` gains `nextArchDiscoveryTask()`, which always picks the oldest/null `lastReviewedAt` community — the same "oldest first" pattern already used by `nextStateTargetTask()`, `nextFieldMapGapTask()`, and `nextAdhocTask()`.
- **Context pre-fetch** — since Ornith has no live tool access (confirmed: every existing Ornith-facing task pre-fetches real file content into `promptContext`; the one exception, `arch-review-runner.ps1`, works because it shells out to `claude -p`, and Claude Code has tools during that call), `nextArchDiscoveryTask()` must itself compute the community's context: graphify community summary + real source file content for up to ~60,000 characters, filled by descending link-degree (computed directly from `graph.json`'s `links[]` — no precomputed centrality field exists on nodes, but degree is trivial to derive by counting `source`/`target` occurrences per node id).
- **Output shape** — a discovery task's implement pass produces 0–3 candidates in the identical `AC-NNN · Title / Strength / Files / Problem / Solution / Benefits` format `arch-review-runner.ps1` already writes to `Docs/ARCH_REVIEW_CANDIDATES.md`.
- **Review #1** — `review-runner.ps1`'s existing majority-vote step judges the discovery task like any other. This is the "separate agent" review the design calls for; no new review logic.
- **"Save as tasks"** — on approval, `apply-runner.ps1` gets a new non-git apply path for the `arch_discovery` domain: append the candidates to `ARCH_REVIEW_CANDIDATES.md`, stamp `lastReviewedAt` in the coverage tracker. Same shape as the existing SecondBrain vault-note apply path (write + marker, no git).
- **Task creation** — the existing `nextArchReviewTask()` (zero changes) picks up `Strong` candidates from the doc and spins them into real fulfillment tasks, exactly as it does today.
- **Fulfillment + Review #2** — a worker drafts the real code change; `review-runner.ps1` reviews it; `apply-runner.ps1` does the actual git branch/commit/push. All pre-existing, unmodified.
- **Priority** — `arch_discovery` sits in `task-sources.js`'s chain immediately after `nextArchReviewTask()` (the *consumer*), before `nextUnusedExportTask()`. Because the consumer runs first, discovery only fires when there are no unconsumed `Strong` candidates left to turn into fulfillment tasks — new candidates are never generated while a backlog of un-fulfilled ones already exists.
- **Rollout gate** — not added to `start-agent-pipeline.bat` yet. Run manually first; only wire into the standing pipeline after inspecting real candidate output quality.

## Reason

Two designs were on the table. Option A kept `arch-review-runner.ps1` as a dedicated always-on loop, just decomposing its single `claude -p` sweep into narrower Ornith-driven per-community passes. Option B (chosen) makes discovery a task type inside the existing queue, going through the same lifecycle as everything else.

Option B was chosen because the existing pipeline already had two-thirds of this built and proven: `nextArchReviewTask()` already implements the discovery-doc → deterministic-consumer split (`ARCH_REVIEW_CANDIDATES.md` → fulfillment task), majority-vote review, crash-resume, and heartbeats were all shipped earlier the same night this ADR was written. Option A would have required building a second, parallel review/lifecycle system just for architecture work — Option B requires only: a coverage tracker, one task-source function, one `prompts.js` branch, and one `apply-runner.ps1`/`task-domains.json` entry. Everything else — review, critique, majority-vote, the fulfillment path all the way to a merged branch — is reused verbatim.

The priority placement (after the consumer, before dead-last dead-code triage) was a deliberate anti-junk-pileup decision: the operator explicitly flagged the risk of "building a huge list of junk tasks" if discovery ran too eagerly. Ordering it after its own consumer means the system always drains existing candidates before manufacturing more.

The 60,000-character context budget and degree-based file selection were chosen because Ornith cannot explore live — a discovery prompt is only as good as what's pre-baked into it, and architectural judgments (shallow interfaces, missing locality) generally require reading real code, not just a relationship graph. Degree (computed directly from `graph.json`, no external tool needed) is a reasonable proxy for "the file most worth reading in this community."

## Consequences

- **No new review or apply machinery.** The entire fulfillment half of this feature (steps 5–6 above) already existed and is untouched.
- **Ornith, not Claude, does discovery going forward.** This shifts architecture-review cost from Claude API calls (`arch-review-runner.ps1`'s `claude -p` invocation) to free local inference, consistent with the repo's standing "Ornith does the work, Claude reviews" policy — but it also means discovery quality is bounded by what fits in a pre-fetched, non-interactive prompt, unlike Claude Code's live-exploration pass.
- **`arch-review-runner.ps1` becomes redundant** once this ships and is trusted — it was already unwired from `start-agent-pipeline.bat` and not running. It is not deleted as part of this ADR; that's a follow-up once the new path is proven.
- **Coverage is guaranteed, not comprehensive on day one.** With ~186 communities and low-priority-filler cadence, full-codebase coverage will take a long time to complete once, and even longer to notice when a reviewed community's code has changed enough to warrant a fresh look — no re-review staleness policy exists yet (this ADR only guarantees eventual first-pass coverage, not freshness).
- **Manual test gate is a real blocker, not a formality.** Nothing in this ADR should be read as authorizing autonomous rollout — see `Docs/agents/arch-discovery-pipeline.md` for the concrete pre-flight checklist before wiring into `start-agent-pipeline.bat`.
