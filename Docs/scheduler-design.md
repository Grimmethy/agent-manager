# Scheduler Design — `agent-manager-scheduler` (its own repo + plugin)

Status: design proposal (owner decision 2026-10-15: the scheduling brain is a separate
repo/plugin, not more core). One file, read-only against core at first.
Conventions: `[confirmed]` = seen in this repo at the cited `path:line`; `[unconfirmed]` =
from the owner brief, external docs, or not yet present in code — verify before relying on it.

## 1. Three-way split (the design rests on this)

- **(a) What matters** — goals/initiatives, each with a metric the work should move.
  Brief says cite `Docs/initiative-record-design.md` if it exists; it does not
  (`ls Docs/` shows no such file) `[unconfirmed]`. Treat "an initiative = a named target
  metric + the work expected to move it" as the working definition.
- **(b) What is READY** — tasks carry *readiness conditions*, not just a rank. Examples:
  "after PR N merges", "after N days of data", "when a project's pending count exceeds K",
  "when a loop reports a metric moved". Today the closest thing is `dependsOn` checked by
  `isDependencySatisfied` (src/task-sources.js:177) `[confirmed]` — that is a dependency
  gate, not a composable readiness condition.
- **(c) What runs NEXT** — a scheduler picks from ready tasks under hard constraints
  (resources, exclusivity, capacity classes) and writes down *why* (Section 6).

## 2. Current state (how claim order is decided today)

Claim chain, in order, for one lane reading `<queue>/pending/`:
1. `pinnedWorker` tasks for this instance first (oldest first); tasks pinned to another
   instance are excluded (src/next-claimable-task.js:210 `pickClaimableTasks`) `[confirmed]`.
2. `effectivePriority(task, base, resolveSourceNameFn, hubTier)`
   (src/next-claimable-task.js:83) `[confirmed]`: `premiumPriority` → `-Infinity`
   (beats everything); hub-tier → `HUB_TIER_PRIORITY = -1000` (src/hub-priority.js:40)
   `[confirmed]`; adhoc source without `humanQueued` → base + 30 penalty (bot adhoc sorts
   after humans); else the source's registered priority.
3. Sort by priority ascending, then mtime ascending (src/next-claimable-task.js:210) `[confirmed]`.
4. `humanQueued: true` is stamped only by human entry points: brain-dump "Process this now"
   (python/dashboard/routes/brain_dump.py:256) and `queue-adhoc-task.js`
   (src/queue-adhoc-task.js:56) `[confirmed]`.
5. Hub children order within the tier by hub `hubPriority` then hub `createdAt`
   (src/hub-priority.js:218 `isHubTierTask`; ordering rule at top of file) `[confirmed]`.
6. Lane preference: secondary lane holds the top task for a fresh-idle preferred lane,
   grace default 120s (`AGENT_MANAGER_LANE_PREFERENCE_GRACE_SECS`)
   (src/next-claimable-task.js, `preferredLaneIsIdle` block) `[confirmed]`.
7. Adhoc generation path: `nextAdhocTask` (src/task-sources.js:578) re-applies ordering
   through the source's `hubOrder` hook (src/hub-priority.js `DEFAULT_HUB_ORDER`) `[confirmed]`.
8. Idle-lane borrowing: an idle lane may pick up tasks from another suite project when the
   active project has nothing (Docs/idle-pool-borrowing.md, built 2026-09-20, kill switch
   `AGENT_MANAGER_POOL_BORROW`) `[confirmed]`.

Signals that already exist:
- Heartbeats per lane under `instances/<id>.json` (`lastHeartbeat`, `status`)
  (src/next-claimable-task.js `preferredLaneIsIdle`) `[confirmed]`.
- Lanes = one per GPU: `worker-3090`, `worker-p40` (src/lanes.js:47 `getLanes`) `[confirmed]`.
- RAM guard: 20 GB pipeline box, `MIN_AVAILABLE_MB` default 2048
  (src/mem-guard.js:28, context at :4) `[confirmed]`.
- Queue states as directory names (`pending`, `drafting`, `review`, `blocked`, `done`,
  `coordinating`, …) read throughout src `[confirmed]`.
- P40 heat/VRAM budget in code: not found (`grep -n heat src/*.js` clean) `[unconfirmed]`.

What is missing: readiness conditions; cost-of-delay; resource-cost awareness at pick time;
attention-based aging; capacity-class budgets; a decision log for picks.

## 3. Scoring model

Formula (kept small and explainable):

    score = expected_value + cost_of_delay − resource_cost − risk

- `expected_value` — from the initiative/metric the task serves (Section 1a); defaults to a
  per-source baseline learned from outcome feedback (Section 7), so it starts as a constant
  per source and only moves when a metric actually moves.
- `cost_of_delay` — **attention age, not wall-clock age**: age accrues only while the task's
  project is the active/attended one; a dormant project's tasks do not accumulate age.
  Brief says cite `Docs/project-rotation-and-expiry-aging-findings.md` if it exists; it does
  not `[unconfirmed]` — the principle (dormant projects do not age) is owner-stated.
  Each factor is normalised 0.0–1.0 before its weight is applied (the Slurm multifactor
  form, Prior Art) and weights are plain integers in a config file.
- `resource_cost` — VRAM/heat/VRAM-exclusivity demand declared on the task (Section 4),
  0.0–1.0 against current headroom read from `instances/` heartbeats `[confirmed]`
  (heartbeat files exist) and mem-guard thresholds (src/mem-guard.js:28) `[confirmed]`.
- `risk` — 0.0–1.0, raised for: touching scheduler/core itself, tasks already redrafted
  twice, hub children whose earlier siblings are unmerged (the hazard
  `hubHasUnmergedEarlierSibling` guards today, src/hub-priority.js) `[confirmed]`.
- Hard floor, no exceptions: `premiumPriority` → score `-Infinity` equivalent; `humanQueued`
  adhoc sorts ahead of bot adhoc (both exist today at src/next-claimable-task.js:83
  `[confirmed]`). NO machine score can ever outrank a human-flagged task.

## 4. Constraints (hard, checked before scoring matters)

1. GPU/VRAM + host RAM: mem-guard 2 GB floor on a 20 GB box (src/mem-guard.js:28, :4)
   `[confirmed]`; per-task VRAM demand vs lane headroom.
2. Forge-vs-pipeline exclusivity + GPU broker: broker is planned as
   `agent-manager-gpu-broker`, port 7449
   (Docs/gpu-broker-extraction-map.md:71) `[confirmed]`; scheduler consumes broker
   decisions rather than re-implementing allocation `[unconfirmed]` until broker lands.
3. P40 heat budget: owner-stated limit on sustained P40 work `[unconfirmed]` (no code).
4. One active project vs rotation; apply stage is per-project (idle-pool borrowing only
   fires when active project is empty, Docs/idle-pool-borrowing.md) `[confirmed]`.
5. WIP limits: max in-flight tasks per project and per hub
   (hub siblings already sequenced, src/hub-priority.js `siblingHolds`) `[confirmed]`.
6. Exclusion rules (pinnedWorker, lane preference) stay as they are
   (src/next-claimable-task.js:210) `[confirmed]`.
7. Concurrency: one task per lane per tick (existing `mv -n` atomic claim) `[confirmed]`.

## 5. Capacity classes

Three classes with adjustable shares (default 60/25/15): **product work / system
improvement / maintenance**. Borrowing model (Kueue cohorts, Prior Art): if one class is
empty or its work does not admit (constraints, Section 4), its budget is lent to the others
proportionally; lent budget is reclaimable the moment the class produces work that fits.
Starvation guarantee: every non-empty class gets ≥1 slot per scheduling window before any
class gets a second. Unadmittable older tasks never block newer ones that fit
(BestEffortFIFO idea, Prior Art). An empty class's budget never silently disappears — the
decision record (Section 6) names who borrowed it and for how long.

## 6. Explanations (decision record per pick)

Every pick writes one JSON line: `{ ts, candidates: [{id, score, factor breakdown}],
chosen, excluded: [{id, reason}], constraintHits, classBudgets, mode: shadow|authoritative }`.
Shown on the dashboard as a "Scheduler Decisions" tab reading the log directory read-only
(the dashboard lives under python/dashboard/ `[confirmed]`; the tab itself is new
`[unconfirmed]`). Shadow-mode log (Section 7) uses the same schema plus a
`queuePick` field so the comparison report is one `diff` away.

## 7. Self-improvement without runaway

- **Daily planning cycle**: scheduler proposes a slate (from the health ledger, tuning
  loops, initiatives). Brief says cite `Docs/tuning-loops-design.md` if it exists; it does
  not `[unconfirmed]`. Owner approves or edits the slate (open-multi-agent approval
  pattern: bound to a hash of what the reviewer saw, Prior Art).
- **Outcome feedback**: after work lands, check whether the targeted metric moved; adjust
  `expected_value` estimates for that source/initiative. Bounded: ±20% per observation,
  reverts after 30 days of no movement.
- **Guardrails** (all mandatory): changes to the scheduler itself always require human
  approval; **SHADOW MODE FIRST** — for at least one full week the scheduler only logs what
  it *would* pick next to what the queue actually picked, with a weekly comparison report;
  per-feature kill switch falls back to today's queue (same shape as
  `AGENT_MANAGER_POOL_BORROW`, Docs/idle-pool-borrowing.md `[confirmed]`); rate limit on
  estimate changes; shadow mode is the only mode in P0–P4 (Section 9).

## 8. Repo + plugin plan

- Repo: `agent-manager-scheduler`; plugin name `scheduler`. Port: next free **after**
  StageForge 7444 **and** the planned gpu-broker (Docs/gpu-broker-extraction-map.md:71
  `[confirmed]`) — recommend reserving 7446 `[unconfirmed]` pending broker allocation.
- Registers as a plugin the same way other plugins do: `config.ensureRegistered()`
  requires each enabled plugin's `register.js` (src/config.js:452 `[confirmed]`).
- Reads the queue read-only at first (pending/, heartbeats, initiatives). Writes only its
  own shadow log. Core never imports scheduler code; the scheduler imports core's read
  helpers, never the other way.
- Integration seam: a **claim-order hook** — core's `pickClaimableTasks`
  (src/next-claimable-task.js:210 `[confirmed]`) accepts an optional re-rank callback that
  is a no-op when absent, so core works identically with the plugin uninstalled. No other
  core edits.
- Language: JavaScript (Node), matching core; tests: `node --test` unit tests for scoring,
  readiness conditions, and class budgets against fixture queues.
- Stays in core: atomic claim (`mv -n`), pinnedWorker, lanes, mem-guard, plugin registry.

## 9. Phases (smallest first)

| Phase | Delivers | Tests | Rollback | Depends on |
|---|---|---|---|---|
| P0 | Scaffold + shadow scorer: read-only, logs pick vs queue pick | scoring/aging unit tests; fixture-queue shadow run | delete plugin dir | none |
| P1 | Readiness conditions (merged-after, days-of-data-after, count-over-threshold, metric-moved) | each condition against fixture states | per-feature kill switch | P0 |
| P2 | Capacity classes + borrowing + starvation guarantee | budget/empty-class tests | kill switch back to flat queue | P0 |
| P3 | Daily planning cycle + dashboard slate view | slate proposal/apply tests | planning disabled | P1 |
| P4 | Outcome feedback adjusting value estimates | estimate-change tests, rate limit | feedback off, estimates frozen | P3 |
| P5 | Flip shadow → authoritative **per class** (maintenance first) | end-to-end claim-order tests | per-class kill switch to today's queue | P0–P4, one week clean shadow report |

## 10. Open decisions (recommended defaults in bold)

1. Share split — **60/25/15** product/system/maintenance.
2. Attention-age rate — **1 day-equivalent per active-project day** the task waits.
3. Shadow period before P5 — **one week, no constraint violations**.
4. Scheduler port — **7446**, confirmed once gpu-broker takes its port `[unconfirmed]`.
5. Where value estimates live — **in the scheduler repo, not on task files** (keeps core
   queue files unchanged).
6. Whether `humanQueued` also implies a class (product) — **yes**, humans always product.

Risks: optimising a proxy metric instead of the owner's actual goals (mitigate: outcome
feedback checks the real metric); complexity creep (mitigate: 4 named factors, 4 condition
types, hard caps); scheduler churn (mitigate: per-feature kill switches, shadow-first,
rate-limited estimate changes).

## Prior art (what we borrow, what we do not)

- **Dagster declarative automation** (docs.dagster.io automation-condition reference; web
  doc, not cloned — no web access here, cited by URL): borrow *composable conditions over
  upstream state*; we deliberately do not build a full DAG engine — 4 condition types only.
- **Slurm multifactor priority** (slurm.schedmd.com/priority_multifactor.html; web doc,
  cited by URL): borrow the weighted-sum-of-0.0–1.0-factors form and per-factor
  normalisation; replace wall-clock age with attention age; drop partition/QOS factors.
- **kueue** (kubernetes-sigs/kueue): borrow cohort/borrowing/fair-sharing and BestEffortFIO
  "unadmittable old job doesn't block newer fitting job"; do not build a k8s control plane.
- **KAI-Scheduler** (kai-scheduler/KAI-Scheduler): borrow one-snapshot-per-cycle discipline
  and ordered actions (allocate/reclaim); no consolidation/preemption in v1.
- **open-multi-agent** (open-multi-agent/open-multi-agent): borrow approval bound to a hash
  of what was reviewed; it has no priority/capacity concept — we keep ours.
- **aden-hive/hive**: borrow wake-up taxonomy (cron/interval/webhook), retries with
  backoff, dead-letter list, concurrency cap; its "self-improvement" is saved skills, not
  a learning scheduler — we do not copy that.

**Finding (search of GitHub 2026-10-15):** no project found that combines a daily planning
cycle with outcome-based re-ranking — that part of this design is new work, not a reuse.
The scouted-repos index (`/media/model-cache/github/UsefulProjectIndex/INDEX.md`) was not
present in this checkout and could not be opened `[unconfirmed]`; the references above are
cited by name/URL as provided in the owner brief.
