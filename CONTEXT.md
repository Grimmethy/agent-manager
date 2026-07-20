# Agent Pipeline

A queue-based system that delegates scoped implementation tasks to a local Ornith model, with plan/implement/critique passes and majority-vote review before anything reaches git.

## Language

**Task Source**:
A priority-ranked generator, registered via `registerTaskSource`, that produces tasks for the queue (e.g. `arch_review`, `arch_discovery`, `adhoc`). The priority ladder between task sources determines claim order.
_Avoid_: source (ambiguous with the `source` field below — always say "task source" for the generator)

**Source** (task field):
Records which task source produced a given task. Usually matches the task source's registered name — except tasks from the `adhoc` task source, whose `source` field is `manual`, not `adhoc`.
_Avoid_: domain (a different field, see below)

**Domain** (task field):
Governs where and how a task executes: its working-directory kind and success check, per `task-domains.json`. Independent of which task source produced the task.
_Avoid_: source

**Claim**:
A task file that has been moved into a per-instance drafting folder (an atomic, same-volume `Move-Item`), marking it as owned by that instance.

**Orphaned claim**:
A claim whose owning process is confirmed dead. Recovered automatically at the next worker startup (crash-resume).
_Avoid_: stranded claim (a different failure state, see below)

**Stranded claim**:
A claim sitting inside a drafting folder whose owning process is alive, but the file isn't the one that owner is currently working — invisible to crash-resume, since recovery only checks folder-level ownership, not per-file. Not recovered automatically; requires manual or `pipeline-doctor.ps1` intervention.
_Avoid_: orphaned claim

**Instance**:
One running process identified by an `instanceId` (`worker-1`, `review-runner`, `apply-runner`, `queue-watchdog`), which owns exactly one heartbeat file.

**Heartbeat**:
The JSON file an instance writes on every status change (`pid`, `status`, `currentTaskId`, `currentPass`, `lastHeartbeat`) — the system's only source of truth for whether an instance is alive and what it's doing.

**Duplicate instance**:
Two or more processes sharing the same `instanceId`, racing to write the same heartbeat file and claim from the same drafting folder. Caused by a manual restart racing `queue-watchdog`'s automatic one; root-caused but not yet fixed in code as of 2026-07-19 (see `docs/pipeline-incident-2026-07-19.md`).

**Pass**:
One of the stages a task's draft goes through inside a single instance: `plan` → `implement` → `critique` → (optionally) `revise`. Distinct from review, which happens afterward, by a separate instance.
_Avoid_: review (a pass belongs to drafting; review is its own later stage)

**Degenerate**:
An Ornith response judged mechanically unusable — empty, or otherwise failing a basic sanity check — before anything is evaluated for correctness. Caught immediately and blocks the task (`blockedReason: "<Pass> pass degenerate: <reason>"`). Distinct from a response that is merely wrong, which review exists to catch.

**Blocked**:
A task sitting in `queue/blocked/`, not actively being worked. Reached from a degenerate pass, a manual intervention (e.g. breaking a crash loop), or a review-stage rejection — the `blockedStage` field on the task is what distinguishes which, and it decides what happens next.
_Avoid_: rejected (too narrow — only review-stage rejection is a "rejection" in the auto-retry sense)

**Review-stage rejection**:
A blocked task whose `blockedStage` is exactly `"review"` — a real reviewer looked at the draft and rejected it. The *only* kind of blocked task `queue-watchdog` auto-requeues for a fresh redraft (up to `MaxOrnithRejectRetries` times). Every other blocked task sits permanently until a human acts — including anything manually blocked to break a crash loop, which must deliberately use a `blockedStage` other than `"review"` or it will resume looping.

**Priority ladder**:
The ordered list of registered task sources — lower number wins. `getNextTask()` walks it in order, so a task source only fires once every higher-priority one has nothing to offer.

**Adhoc**:
The special task source (priority 10, always wins the priority ladder) for tasks injected directly into `queue/adhoc/`, bypassing normal generation. Tasks from it carry `source: 'manual'`.

**Candidate**:
A proposed finding written by a discovery-style task source (e.g. `arch_discovery`) into a doc for later action, self-rated Strong or Weak, for a human or a consumer task source to act on.
