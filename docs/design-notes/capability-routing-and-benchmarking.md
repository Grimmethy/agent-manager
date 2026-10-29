# Design Note: Capability Routing and Task-Class Benchmarking

**Status:** built 2026-10-17: ledger (#570), shadow reservation with an `enforce` switch (#571), escalation on timeout/degenerate/error (#574), probing, shadow by default (#575), and the probe debrief's deterministic evidence bundle (#576). The `capability_debrief` report source with human-gated filing (section 5a) built too (this PR). Not built: the fix-merged reset hook (`resetCluster` is not called by anything yet) and the before/after scorecard read. (Grimmethy + Claude)
**Related code:** `src/lanes.js`, `src/next-claimable-task.js`, `src/reject-retry-check.js`, `src/premium-rotation.js`
**Related docs:** [lanes.md](../agents/lanes.md)

## Why

Lanes are data now (`lanes.json`), and a lane can carry a `taskClasses` allowlist. That answers "what may this lane take". It does not answer
"what should the big lanes leave alone". Today a 27B lane will happily claim a small bounded task while an 8B lane that could do it sits idle.

The allowlist is also hand-written, and hand-written was wrong on day one: `change_review` looked small, and on the RX 580 8B (16K ctx) its plan
call exceeded the 300 s ceiling. Speed does not follow model size either. Measured 2026-10-17: the 8B on the RX 580 does 26-30 tok/s, the 27B on
the P40 about 10 tok/s.

**Goal.** Every task class should fit on smaller and smaller models over time, and the system should discover which ones already do, from
evidence, with no human maintaining the list. Reservation (big lanes skip work a small lane handles) then falls out as a *consequence* of the
measurements, not a separate hand-tuned setting.

## Principles

1. **Evidence over declaration.** `taskClasses` stays as an operator override. The default is derived from measured results.
2. **Flexible, not hard-coded.** No list of model sizes or task types in code. Tiers and sources are whatever the registry and the source
   registry say they are, including sources added later by plugins.
3. **Nothing strands.** A reservation always expires into "a big lane takes it".
4. **Shadow first.** Every new policy logs what it would have done before it does it.
5. **Failure class, not the single task.** Escalation is mechanical (`avoidLanes`), never a hand-edit of `queue/`.

## 1. Capability tiers (derived, not configured)

A lane's **tier** is a number derived from its model, ordered only for comparison: the parameter count parsed from the model tag
(`qwen3-vl:8b-instruct` -> 8, `...:27b` -> 27), with an optional `tier` field in the lane entry as an override for tags that don't carry a size.
Two lanes are comparable only through this number; the code never names "8B" or "27B".

`lanes.js` gains `tier` on each lane object. Nothing else about lane definition changes.

## 2. The benchmark ledger

One append-only record per **attempt**, written where outcomes are already known (the same place `draftAttempts` and the task log are stamped):

```
{ ts, source, lane, model, tier, numCtx, outcome, stage, wallMs, tokensIn, tokensOut, retries, reason }
```

- `outcome`: `ok` (applied or merged with a green gate) | `rejected` (a gate or reviewer said no) | `timeout` | `degenerate` | `error`.
- `source` is the registered source name. New sources appear in the ledger the first time they run; there is no schema to extend.
- Stored as JSONL under the pipeline data dir, rotated by month. Cheap to write, cheap to scan.

A derived **scorecard** is computed from the ledger on demand (and cached): per `(source, model)` over a trailing window:

| stat | meaning |
|---|---|
| `n` | attempts in window |
| `okRate` | ok / n, counting rejected, timeout, degenerate and error as failures |
| `p50/p95 wallMs` | time to finish |
| `confidence` | `n` and a Wilson lower bound on `okRate`, so 3/3 is not treated like 30/30 |

The reference for "how good is good enough" is the **best-performing larger tier on the same source**, not an absolute number: a source passes on
a small lane when its `okRate` lower bound is at or above `reference - margin` (default margin 0.10) with `n >= minAttempts` (default 8).
Where no larger tier has data, the absolute floor `minOkRate` (default 0.85) applies.

All four knobs (`window`, `minAttempts`, `margin`, `minOkRate`) live in the environment file, one set, overridable per source in the source
registration.

## 3. Reservation (the original ask)

In `pickClaimableTasks`, next to the preferred-lane rule, the inverse rule:

> A lane skips a task of source S when a **lower-tier** lane is alive and *qualified* for S, unless the task has waited longer than the grace
> period, or the lower-tier lane is busy past its own grace, or the task carries an operator pin / premium flag.

- **Qualified** = scorecard passes the gate for `(S, that lane's model)`, **or** S is in that lane's `taskClasses` and the lane's `reserve`
  setting is on (operator override, below).
- **Alive** = heartbeat fresh, the same liveness test the watchdog uses.
- **Grace** = `AGENT_MANAGER_RESERVATION_GRACE_SECS` (default 300). After it, the big lane takes the task, so a dead or saturated small lane
  costs at most one grace interval, never a stall.
- Among several qualified lanes the cheapest qualified tier wins; ties go to the idle one.

Automatic by default. A lane entry can set `"reserve": false` (never reserve for this lane, e.g. while it is being repaired) or
`"reserve": "always"` (honour `taskClasses` without needing evidence, for a deliberate operator choice). Absent = evidence-driven.

## 4. Escalation

A small lane's `timeout`, `degenerate`, `error` or reviewer-rejected outcome stamps `avoidLanes` with that lane (the mechanism `reject-retry-check.js`
already uses for degenerate plans), so the retry goes to a larger lane. The ledger records it; the failure also lowers that source's scorecard
there, which is how a source gets *un-reserved* automatically when a model regresses.

## 5. Probing: how smaller models get tried at all

Reservation only reserves what is already proven, which alone would freeze the system at today's answer. So the claim loop also does **probing**:

- A small, bounded fraction (default 10%, `AGENT_MANAGER_PROBE_FRACTION`, chosen deterministically per task) of eligible tasks of an *unproven* `(source, small-lane)` pair are offered to the small lane first, as a
  trial. Eligible means low-stakes: the source is flagged re-runnable, a big lane can redo it, and the task is not premium or **human-queued** (decided 2026-10-17: human-queued work is ad hoc, hard even for the 27B, and the 8B never probes it). At most one probe in flight per small lane. Probing for a source stops after it passes the gate, and after several consecutive failed probes until a debrief fix lands (section 5a).
- A trial that fails escalates (section 4) and costs one attempt of time, nothing else.
- When a source passes the gate, probing for that pair stops and reservation starts. When a smaller tier exists below it, probing moves down.
- This is the "improve every task class to fit smaller models" loop: tasks keep getting tried on the next tier down at a trickle.

A separate **shrink** half of the goal is outside this note's code but is what the ledger enables: a source with a poor small-model scorecard is
a candidate for atomizing (smaller prompts, split plan/write stages, tighter context) and the scorecard says which source to atomize first and
shows whether the change worked. The Pipeline Forensics source can consume the scorecard as evidence.

## 5a. Probe debrief: turning a failed probe into a smaller task

Probing finds out *that* a task class does not fit a small model. It does not make it fit. The shrink loop is the follow-up that does (requested
2026-10-17: after a probe, a higher-level model debriefs the attempt and proposes system fixes that break the task into smaller scoped work).

**Trigger.** A probe fails (timeout, degenerate, error, or the draft is rejected) and the task is then finished on a larger lane via escalation.
That pairing is the evidence: the same task, same inputs, one small-lane failure and one large-lane result. Debriefs fire per *failure cluster*
(source + failure signature, e.g. `change_review` + plan-call timeout), not per attempt: default after 3 failed probes in a cluster, and once per
cluster until a fix lands.

**Who debriefs.** A larger-tier **local** lane (the 27B), never a premium or hosted model: local-model failures are solved by splitting the work,
not by switching provider. It runs as an ordinary low-priority task from a new `capability_debrief` source.

**Shape: reuse, don't reinvent.** It mirrors `pipeline_debrief` / `pipeline_forensics`: a deterministic bundle builder
(`forensic-bundle.js`'s `gatherEvidenceForTask`) assembles the evidence, a model writes the report, and the existing so-what, premise-check and
candidate-dedupe gates apply. The bundle for a cluster holds: the failed small-lane attempts (prompt size in tokens, `numCtx`, which stage failed,
wall time, response length or truncation), the large-lane result for the same task, and a contrast set of probes of the same source that passed.

**Output is structured, not prose.** Each proposal names a cause class and a concrete fix:

| cause | typical fix |
|---|---|
| prompt or context too large for the lane's `numCtx` | window or trim the input; split the input by file/section |
| task is several jobs in one call | split into stages (plan / write / verify) or per-file sub-tasks, each a smaller registered source |
| a call is mechanically decidable | replace it with a deterministic check (the `pipeline_debrief` determinism audit already looks for these) |
| needs reasoning depth the tier lacks | verdict `not shrinkable at this tier`, with the reason; probing for the source pauses |

**Landing a fix.** Proposals are filed for a human decision first (brain dump, as Pipeline Forensics does), not auto-applied; an approved one
becomes ordinary AM tasks that go through the normal review and merge gates. Once a fix merges, the source's probe failure streak resets and the
scorecard is read before/after the fix commit, so the loop closes on evidence: a fix that does not raise the small lane's pass rate is visible.

**Guards.** One debrief per cluster; a daily debrief cap so it cannot crowd out real work; a proposal that cites a file, symbol or metric not in the
bundle is rejected by the premise check; `not shrinkable` is a valid outcome and is recorded, not retried.

**Rollout.** After probing is in shadow and the ledger has failed-probe clusters to analyse: bundle builder and report only (no filing), then
human-gated filing, then optional auto-filing of low-risk classes (context trimming) once the proposals have a track record.

## 6. Where it surfaces

- Dashboard: a **Capability** tab, a matrix of sources (rows) by lane/model (columns) showing `okRate`, `n`, p50 time and the current state
  (`proven`, `probing`, `failing`, `no data`). Same data, no new store.
- Workers tab: each lane shows the sources it is currently qualified for.
- Audit log: every reservation skip, grace expiry, probe and escalation is one line in the task log with the reason.

## 7. Rollout

1. **Ledger only.** Write attempts, build the scorecard and the tab. No behaviour change. Immediately useful: it answers the `change_review`
   question with data.
2. **Shadow reservation.** Log "would have skipped" and "would have probed" decisions for a week; review them like other policy changes.
3. **Escalation on timeout** (small, independently valuable).
4. **Enforce** reservation, then probing, behind two env switches, flipped one at a time.
5. Retire hand-maintained `taskClasses` for anything the evidence covers; keep it as an override.

## Open questions

- **What counts as `ok` for sources whose output is judged later** (a merged change that is reverted a week on). Start with "passed the gates and
  was applied", add a revert/regression signal if the ledger shows it matters.
- **Context size as a variable.** The 8B ran at `numCtx` 16384; a source may pass at 16K and fail at 8K or the reverse. The ledger records
  `numCtx`, so the scorecard can key on `(source, model, numCtx)` when that matters; start without it.
- **Reviewer votes** (CONFIRM/DENY) and other non-task model calls are not lane-routed today and so are not in the ledger. They are a natural
  second consumer once lanes can serve them.
- **Throttle.** `generation-throttle.js` counts every live lane; a lane that can only take some tasks inflates that count. Reservation makes
  this worse, so the throttle should count a lane's *qualified* backlog rather than the lane.
- **Probe fraction vs. tail latency** for time-sensitive sources: probably per-source opt-out.
