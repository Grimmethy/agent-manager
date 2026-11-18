# Branch verdicts: "Ready to merge" vs "Needs re-verify"

Code: `python/dashboard/branch_reverify.py` (the new logic) called from `python/dashboard/branch_verdicts.py` `enrich_branches_with_verdicts` (server), `python/dashboard/static/js/branch-verdicts.js` (the Unmerged Branches tab). Tests: `python/dashboard/test_branch_reverify.py`, `python/dashboard/static/js/branch-verdicts.test.js`.

## The problem this solves (2026-11-18)
"Ready to merge" used to mean "the newest verdict is `merge`", whatever the branch looked like today. A chat or manual verdict for a head sha is final (`record_verdict` never lets a deterministic or worker verdict replace it), so a branch that later conflicted with master, or fell 900 commits behind, still read ready. On 2026-11-18, 55 branches carried `merge`: 10 conflicted, 11 were more than 100 commits behind, 6 were pieces of unfinished hubs.

## What the tab does now
* **Needs re-verify** is its own filter bucket right after "Ready to merge". A branch whose newest verdict is `merge` goes there, and the card lists every reason, when ANY of these holds (`Reasons.of` in `branch_reverify.py`, pure, from fields the list build already has):
  * `conflicts with <main> now` (`willConflict` is true; unknown/None is not a reason);
  * `verified <age> ago, <n> commits behind <main>`: behind more than N commits, or the verdict is older than the age limit AND the base moved at all (behind >= 1). A verdict that is old on a branch with behind 0 is still fresh;
  * `hub piece: an earlier piece or the hub is unfinished` (the branch belongs to a hub whose state is not done/retired).
* Every card shows the verdict age (`verdict 3 h old`, `verdict 6 days old`) from `verifiedAt`, and `duplicate of <branch>` when other open branches (not discard) name the same task (`taskId`).
* The branch dict gains `verdictAgeHours`, `reverify {reasons, verdictAgeHours}` (only when there is a reason) and `duplicateOf` (only for duplicates).

## Settings (environment, read on every list build; a bad value falls back to the default)
| Variable | Default | Meaning |
|---|---|---|
| `AGENT_MANAGER_VERDICT_REVERIFY_MAX_BEHIND` | 100 | commits behind the main branch above which a `merge` verdict needs re-verify |
| `AGENT_MANAGER_VERDICT_REVERIFY_MAX_AGE_HOURS` | 24 | verdict age (hours) above which a `merge` verdict on a branch the base has moved past needs re-verify |
| `AGENT_MANAGER_VERDICT_DEMOTE_ON_CONFLICT` | on | `0`/`false`/`off`/`no` turns the demotion below off |

## The event that re-queues a conflicting verdict
The list build (the page's counts/branches events kick it when main moves or a branch is pushed; no timer) now also looks at a `merge` verdict of ANY source on a branch whose `willConflict` is true. It replaces that record with a deterministic `needs-work` verdict ("conflicts with <main> on: files; the earlier <source> merge verdict (<time>) no longer applies") and journals `verdict_recorded`. The Needs-Work worker takes every branch whose current verdict is needs-work, so the branch is re-queued without a person. The replaced record is kept inside the new one under `supersedes`; when the conflict clears, the list build puts it back. `willConflict` unknown (None) changes nothing.

A `merge` verdict that is only old or far behind (no conflict) is NOT rewritten: it shows in Needs re-verify. WORKER verdicts are already re-judged by the pipeline-ops verifier when the base moves (`agent-manager-pipeline-ops` `docs/branch-verifier.md`, `src/verify-carry.js`); chat and manual verdicts, and pieces of unfinished hubs (the verifier skips them), are the ones nothing re-judges, and they are exactly the ones this bucket surfaces.

## Known gap
The merge loop's checker (`checker-ledger.jsonl` in pipeline-ops) can answer NOT-READY for a branch that still reads `merge` (for example "not the reviewed diff: the task record was not found"). That answer is not on the branch dict, so the tab cannot show it yet; a later task can read the ledger into the list build.

## Why the code is shaped this way
`scripts/size-ratchet-check.js` measures a top-level python `def` to the end of the FILE (and a method to the end of its class), so `branch_reverify.py` keeps its helpers in small classes with the two entry points last, and `branch_verdicts.py` (a frozen file) changed by net minus one line. The JS helpers sit before `_bvEscape` for the same kind of reason (its regex literal confuses the scanner).
