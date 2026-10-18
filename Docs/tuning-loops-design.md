# Passive tuning loops: shared loop shape, health ledger, and the first three loops

Status: **design doc only.** No `src/*.js`, `python/**`, or `scripts/**` change. The only
artifact is this file. Written 2026-10-15 for the owner's request to turn the by-hand
system management and streamlining of Agent Manager (across many Claude sessions) into a
set of small, repeatable, passive tasks that run through the existing pipeline.

**Grounding statement.** `Docs/tuning-loops-catalogue.md` does **not** exist
(unconfirmed — verify: no such file in the working tree), so
this doc grounds in the nine loops from the owner's 2026-10-15 memory-and-skim pass, and
says so. Motivation scale from that pass: ~2,799 commits on `origin/master` since
2026-08-01, of which ~220 are `Triage batch` commits and several hundred are fixes. The
nine loops: (1) stalled-bucket drain, (2) incident → root cause → sweep siblings
(Incident Amplification — machinery partially exists, the passive loop does not),
(3) unmerged-branch review (see `docs/agents/unmerged-branch-review.md`, confirmed
to exist), (4) scanner precision tuning, (5) policy-change follow-up, (6) triage
candidate sifts, (7) code-health and history analysis (proposed in the memory note
`project-agent-manager-code-health-analysis-2026-10-08`, unconfirmed — verify; no
`code-health` hits anywhere in `Docs/` or `docs/`, and no built code found),
(8) brain-dump /
memory / docs hygiene, (9) environment drift.

Conventions used below: every code reference is tagged **confirmed (path:line)** or
**unconfirmed — verify**. "Unconfirmed — verify" includes new files this design proposes
that do not exist yet.

## 1. The shared shape (the contract every loop obeys)

Every passive tuning loop is the same six-part machine. A loop that breaks any part is a
different system and should not be called a loop.

1. **Trigger.** One of:
   - *schedule* — a time gate ("every day at T", "every N days since X");
   - *event* — a merged policy/env change, a bucket (e.g. `queue/blocked`,
     `queue/needs-clarification` — states named in `QUEUE_STATES`, confirmed
     (src/task-sources.js:76)) crossing a size threshold, or a premium/initiative piece
     stalled past a bound.
   Triggers are deterministic checks, never model judgments.
2. **Evidence bundle — no model.** A fixed JSON bundle built deterministically from the
   repo and queue state: counts per state/bucket, recent diffs, task histories, rates
   (e.g. requeue-per-day, FP-dismissal rate), ledger slices. Same inputs ⇒ same bundle.
   A sketch:
   ```json
   { "loop": "env_drift", "trigger": "schedule:daily", "window_days": 7,
     "counts": { "blocked": 12, "needs_clarification": 5 },
     "deltas": { "blocked_7d": -3 }, "items": [ /* per-item evidence, individual cause */ ],
     "ledger_tail": [ /* last N days of this loop's ledger rows */ ] }
   ```
3. **One narrow model step over the bundle.** A single, bounded model call — ideally a
   **binary verdict** (yes/no), mirroring the grounding-check pattern used by
   `deep_dive`'s `postImplementCheck` (confirmed (src/task-sources.js:2313)) and
   `runGroundingCheck` (confirmed (src/deep-dive-grounding-check.js:185)). Where the
   answer is a pure diff (env drift), the model step is skipped entirely.
4. **Output invariant: the loop's output is ALWAYS a filed task or a finding with
   evidence and never a direct merge.** This is the load-bearing safety rule. A loop may
   also *release* bucket items, but only per the dismissal-safety rule in §7.
5. **Human gate.** Required whenever the verdict is non-binary, the blast radius is more
   than one file, or the loop proposes retiring itself. The gate is the normal review
   path of a filed task — nothing new.
6. **Metric.** Each loop names the number it drives down (bucket size, drift count, FP
   rate, stalled-days) and records before/after in the health ledger (§3). If the metric
   does not move, the loop must be able to see that and stop (§7).

## 2. The daily health ledger

The earlier proposal lives only in the memory note
`project-agent-manager-code-health-analysis-2026-10-08` (unconfirmed — verify; no code
or `Docs/` artifact found). This design pins it down:

- **What it records per day (one JSONL row per event, keyed by `loop_id`):**
  trigger fired (and why), verdict + verdict inputs, items released / held / filed
  (with per-item cause), the loop's own metric before/after, and resource cost
  (GPU-minutes, peak RAM, model calls).
- **Where it lives:** `<pipelineDir>/health-ledger/YYYY-MM-DD.jsonl`, where
  `pipelineDir = AGENT_MANAGER_PIPELINE_DIR || repoRoot` (confirmed
  (src/config.js:114)); the same directory convention already holds state files like
  `community-coverage.json` (confirmed (src/config.js:102)). File location is a new
  proposal — unconfirmed — verify.
- **How loops read it:** every trigger step reads the last N days of its own `loop_id`
  slice to compute its metric, check its kill switch, and evaluate retirement (§7).
  Loops never read each other's slices.
- **Append-only.** Rows are never rewritten; corrections are new rows. This makes every
  dismissal auditable (see §7's `dismissed_total` / `held_total` counters).

## 3. The first three loops, in build order (each with its smallest first PR)

### 3.1 Loop A — policy-change follow-up (build first)

- **Trigger (event):** a policy/env change merges. Registration: the change record gets
  a scheduled-task obligation — "review this in N days with these metrics".
- **Bundle:** the merged diff + a 7-day window of the named metric.
- **Model step (binary):** "Is the metric within its target band? yes/no."
- **Output:** a filed task "review <change> in N days with <metrics>" — nothing is
  auto-tightened; tightening is a normal reviewed task.
- **Metric:** % of policy changes that got a follow-up review within N days.
- **Smallest first PR:** one new plugin source `policy_followup` — a `register.js` that
  calls `registerTaskSource('policy_followup', {...})` (seam confirmed
  (src/task-source-registry.js:21); in-repo registration shape confirmed
  (src/task-sources.js:1529)) plus a deterministic 7-day metric reader over the ledger.
  New files — unconfirmed — verify.

### 3.2 Loop B — environment-drift check

- **Trigger (schedule, daily):** compare declared intended state vs live state.
- **Bundle (no model step needed — pure diff):** a declared manifest of intended env
  switches, lanes, P40 allocation, and plugin env (a new JSON file — unconfirmed —
  verify) diffed against live process/env state, key by key.
- **Verdict (deterministic):** `drift_detected: true/false`, with each drifted key and
  its declared vs actual value.
- **Worked examples (from the 2026-10-15 pass):** (a) the P40 mismatch — intended
  allocation vs what actually runs on the P40; (b) missing `CHARACTERFORGE_ROOT` on the
  live PromptForge process. Both are exactly this shape: declared value present, live
  value absent/different.
- **Output:** one filed task listing each drifted key; a human applies/decides.
- **Metric:** drift count (target 0 within one run of any env change).
- **Smallest first PR:** the manifest file + a pure diff function (no model, testable
  offline) + the `env_drift` source registration. New files — unconfirmed — verify.

### 3.3 Loop C — bucket-drain

- **Trigger (schedule + threshold):** `queue/blocked` or `queue/needs-clarification`
  size > N for M days.
- **Bundle:** every item in the bucket with its individual evidence/cause, plus the
  shared-cause frequency count (e.g. how many items show
  `ENV_MISSING:CHARACTERFORGE_ROOT` vs `PERM_DENIED` vs other).
- **Model step (binary, narrow):** "Is there a single cause covering ≥ 60 % of items?"
  If yes → identify it. The shared-cause identification must produce an explicit
  **cause predicate** (e.g. `env_var == "CHARACTERFORGE_ROOT" && status == "missing"`).
- **Output:** ONE filed fix task for the shared cause (filed, not applied), then
  per-item release/hold per the dismissal-safety rule below.
- **Baseline this improves on:** auto-drain already requeues stuck tasks *after* a fix
  for a signature lands — `requeueBlockedTasksForSignature` (confirmed
  (src/blocked-drain.js:42)) matches items with `taskMatchesSignature` (confirmed
  (src/blocked-drain.js:36)) and is wired from `apply-task.js` (confirmed
  (src/blocked-drain.js:133)). What is missing is the upstream half: finding the shared
  cause first and filing the one fix. This loop adds that.
- **Metric:** bucket size and days-to-drain.
- **Smallest first PR:** the shared-cause predicate + per-item release/hold decision +
  a ledger row per release/hold. New files — unconfirmed — verify.

### 3.3a Dismissal-safety rule (mandatory for any loop that releases items)

The dangerous case is concrete: **a bucket item with cause `PERM_DENIED` in a bucket
whose shared cause is `ENV_MISSING:CHARACTERFORGE_ROOT`.** If the release step keys on
bucket membership instead of per-item cause, it will release (dismiss) the
`PERM_DENIED` item and silently lose a genuinely different, still-real problem.

The rule, in check order:

1. **Per-item cause check runs BEFORE any release.** Each item is tested individually
   against the shared-cause predicate; the item most likely to be a false match (here,
   the `PERM_DENIED` item) is checked first in the per-item loop.
2. **Only predicate-matching items are released.** The `PERM_DENIED` item is **not**
   released; it stays in the bucket with a finding attached: `not covered by shared
   cause; individual cause: PERM_DENIED`.
3. **Every release and every hold is a ledger row** with `loop_id`, `item_id`,
   `shared_cause_predicate`, `item_individual_cause`, `timestamp`, and
   `verdict: "released"` / `verdict: "held"`. Per-day counters `dismissed_total` and
   `held_total` are maintained so a wrongly dismissed case can be found by querying for
   `verdict: "released"` where `item_individual_cause != shared_cause_predicate`.

**Test (to add with Loop C's first PR, not implemented here):** a synthetic bucket of
5 items — 4 with `cause: "ENV_MISSING:CHARACTERFORGE_ROOT"`, 1 with
`cause: "PERM_DENIED"`. After the loop runs, assert: exactly 4 are released; exactly 1
is held with a finding; the held item's `cause` field (`PERM_DENIED`) is preserved in
its ledger row; and the `PERM_DENIED` item is not in the released set.

## 4. Registration: loops are task-source plugins, not core growth

The registration seam already exists and is proven by the out-of-tree
`agent-manager-hygiene` plugin, which ships its review/fix sources this way
(README.md:76, confirmed; the hygiene row in the plugin table README.md:135, confirmed).

- The seam: `registerTaskSource(name, config)` (confirmed
  (src/task-source-registry.js:21)); exported for plugin use including
  `registerSourceAlias` (confirmed (src/task-source-registry.js:119)).
- In-repo shape to imitate: `registerTaskSource('adhoc', { priority: taskPriority(...),
  next: nextAdhocTask, apply: applyAdhocDiff, ... })` (confirmed
  (src/task-sources.js:1529)); another full example with a model profile and a
  deterministic review at `registerTaskSource('brain_dump_sort', ...)` (confirmed
  (src/task-sources.js:1611)).
- Plugin loading: `AGENT_MANAGER_REGISTER_PATH` points at a `register.js` required for
  its side effect of calling `registerTaskSource` (README.md:76, confirmed; the env var
  is parsed in `src/resolve-plugin-root.js:30`, confirmed); the enforced import contract
  is documented in `docs/PLUGIN_API.md` (confirmed (docs/PLUGIN_API.md:22)), with a
  `registerTaskSource('my_source', {...})` example (confirmed
  (docs/PLUGIN_API.md:85)) and a manifest entry with
  `"registerPath": "/path/to/my-plugin/register.js"` (confirmed
  (docs/PLUGIN_API.md:120)). `plugins.json` (beside `agent-manager.env`) enables
  disables (README.md:164, confirmed).
- **Rule:** each loop lives in its own plugin repo (or a single
  `agent-manager-tuning-loops` repo with one `register.js` per loop) and registers at
  load time. Nothing in `src/task-sources.js` grows per loop. The hygiene plugin's own
  `register.js` is out-of-tree and was not readable in this session — unconfirmed —
  verify its exact call shape before mirroring.

## 5. Relationship to the Initiative record

`Docs/initiative-record-design.md` is itself design-doc-only (confirmed
(Docs/initiative-record-design.md:9)). Under it:

- A loop **is a recurring initiative**: the initiative record names the durable goal
  ("keep the blocked bucket drained"), while each run of the loop files individual
  tasks into it.
- Add three fields to a loop's initiative record: `recurrence` (`daily` | `event` |
  `threshold`), `retirement_metric` (the number from shared-shape item 6), and
  `loop_id` (matching the ledger key). Field names are new — unconfirmed — verify
  against the initiative doc's proposed shape before implementing.
- Lifecycle: `active → paused (kill switch) → retired`. Retirement is a human-gated
  task, not an auto-action (shared-shape items 4–5).

## 6. Guards

- **GPU/RAM budget.** Host: ~20 GB RAM, one 3090, one P40 that overheats. Each loop
  declares `max_gpu_min_per_run` and `max_ram_mb` in its registration; the scheduler
  enforces and defers to the 3090 (or skips) when the P40 is in use or thermally
  limited. Enforcer does not exist yet — unconfirmed — verify.
- **Kill switch.** Per-loop flag checked at the top of every trigger (`killed: true`);
  a ledger row is written when a kill is issued and when it is cleared.
- **Rate limit.** Max N runs per day per loop (default N=1 for all three first loops).
- **Self-retirement / paying for itself.** A loop proves it by its metric: if the
  targeted number shows no improvement over 14 consecutive days of ledger rows, the
  loop files a "retire me" task (human gate) and then sets the initiative record to
  `retired`. No loop may delete its own ledger rows — the evidence stays.
- All guards are design proposals; no code exists yet — unconfirmed — verify.

## 7. Open decisions (with recommended defaults)

| # | Decision | Recommended default |
|---|----------|---------------------|
| D1 | Evidence bundle on disk or in memory? | **On disk** (auditable, survives crash, diffable) — a temp file under `<pipelineDir>` (unconfirmed — verify) |
| D2 | Binary verdict or 3-way (yes / no / escalate)? | **3-way**, with `escalate` routing to a human-gated task |
| D3 | One shared ledger file or per-loop files? | **One file per day, keyed by `loop_id`** (simpler cross-loop queries) |
| D4 | May the model step propose a fix, not just a verdict? | **No** — verdict only; the fix is always a filed task |
| D5 | P40 vs 3090 scheduling priority? | **P40 for batch/off-peak, 3090 for interactive**; defer on thermal limit |
| D6 | One plugin repo for all loops or one repo per loop? | **One `agent-manager-tuning-loops` repo**, one `register.js` per loop (matches the hygiene pattern, README.md:76 confirmed) |

## 8. What this doc deliberately does NOT do

- It does not implement any loop, ledger, or registration.
- It does not touch `src/task-sources.js`, `src/task-source-registry.js`,
  `src/blocked-drain.js`, or any plugin.
- It does not claim the Incident Amplification loop (loop 2) is built: the
  marker/extract machinery exists (`stage = 'incident-amplification'`, confirmed
  (src/incident-amplification.js:34)), but the passive incident→root-cause→sweep
  loop does not — that is a future loop, not in scope here.
- It defers loops 2, 4, 6, and 8 to a follow-up task once the shared shape, ledger,
  and first three loops are reviewed.

## 9. Appendix: confirmed vs unconfirmed claims

| Claim | Status |
|-------|--------|
| `registerTaskSource(name, config)` seam | **confirmed (src/task-source-registry.js:21)** |
| Registry exports incl. `registerSourceAlias` | **confirmed (src/task-source-registry.js:119)** |
| `QUEUE_STATES` list incl. `blocked` / `needs-clarification` | **confirmed (src/task-sources.js:76)** |
| `registerTaskSource('adhoc', {...})` shape | **confirmed (src/task-sources.js:1529)** |
| `registerTaskSource('brain_dump_sort', {...})` shape | **confirmed (src/task-sources.js:1611)** |
| `deep_dive` with `postImplementCheck` grounding | **confirmed (src/task-sources.js:2313)** |
| `runGroundingCheck` | **confirmed (src/deep-dive-grounding-check.js:185)** |
| `requeueBlockedTasksForSignature` | **confirmed (src/blocked-drain.js:42)** |
| `taskMatchesSignature` | **confirmed (src/blocked-drain.js:36)** |
| `apply-task.js` wiring of blocked-drain | **confirmed (src/blocked-drain.js:133)** |
| `pipelineDir` resolution | **confirmed (src/config.js:114)** |
| `AGENT_MANAGER_REGISTER_PATH` env var | **confirmed (README.md:76)** |
| `AGENT_MANAGER_REGISTER_PATH` parsing | **confirmed (src/resolve-plugin-root.js:30)** |
| `plugins.json` beside `agent-manager.env` | **confirmed (README.md:164)** |
| Plugin API contract doc | **confirmed (docs/PLUGIN_API.md:22)** |
| `registerTaskSource('my_source', {...})` example | **confirmed (docs/PLUGIN_API.md:85)** |
| Manifest `registerPath` field | **confirmed (docs/PLUGIN_API.md:120)** |
| Hygiene plugin as task-source plugin | **confirmed (README.md:76, README.md:135)** |
| `unmerged-branch-review.md` exists | **confirmed (docs/agents/unmerged-branch-review.md)** |
| `incident-amplification` stage machinery | **confirmed (src/incident-amplification.js:34)** |
| Initiative record design doc | **confirmed (Docs/initiative-record-design.md:9)** |
| Memory note `project-agent-manager-code-health-analysis-2026-10-08` | **unconfirmed — verify** (not in repo; memory note only) |
| `<pipelineDir>/health-ledger/` location | **unconfirmed — verify** (new proposal) |
| Loop plugin repo / `register.js` files | **unconfirmed — verify** (new proposal) |
| GPU/RAM budget enforcer | **unconfirmed — verify** (does not exist yet) |
| Kill switch / rate limit / retirement code | **unconfirmed — verify** (does not exist yet) |
| Initiative record field names for loops | **unconfirmed — verify** (new proposal) |
| Hygiene plugin `register.js` exact call shape | **unconfirmed — verify** (out-of-tree, not readable here) |
