---
type: brain-dump-sort
project: agent-manager
status: needs-decision
source: brain-dump bd-1795226377935-inconsistent-job-state-visibility-in-mul
---

# Job state held in an in-memory dictionary across worker processes

## Summary

The brain-dump entry claims that Agent Manager keeps job state in an in-memory dictionary shared by worker processes. Under a standard multi-worker process manager, this would cause silent data loss and inconsistent job visibility: jobs could disappear or show different states depending on which worker answers. Operators scaling horizontally would have no way to reconcile this without manual intervention.

## Citation

Source cited by the entry: `Docs/ARCH_REVIEW_CANDIDATES.md:11-14`.

Verification status: NOT CONFIRMED. Lines 11-14 of that file are the AC-1 entry ("Kill-switch file couples tool-client behavior to filesystem state instead of config"), which does not mention job state. A repo-wide search for `multi-worker` returned no matches. The in-memory job-state claim has not been found in the cited document.

## Location in code

Not located. No module-level job dictionary has been identified yet.

## Open decision

The entry's recommendation is to move job state to a shared backend. The alternative is to document single-process deployment as an explicit constraint. Choosing between these needs a human decision. Before deciding, someone should first confirm where the in-memory job state actually lives.

## Related

Possibly related (unverified): `agent-manager-critique-stage-degenerate`, `agent-manager-pipeline-updates`, `agent-manager-hygiene`.
