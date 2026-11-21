# Multi-node open items: grimm as a node

Open items found while running grimm as a node on 2026-11-15/16. The task dates say 2026-11-16, but the session date is 2026-11-15; the items cover both days. Items 1 and 7 come from the session report and have no repo citation. Items marked "assumed, verify" were not checked against the file they name.

## 1. Sandbox read access on the live site host

SAW: Grimm hosts the live Property Forager site and database. It is not verified what the node's cloud worker can read there. The AppArmor bwrap step was meant to confine it, but no AppArmor reference exists in the repo (session report).

WHY IT MATTERS: If the cloud worker can read the site database or its files, the pipeline is not confined as intended. Confirming this needs a read-only test against a canary file placed outside the pipeline directory.

WHO DECIDES: The owner decides when to run the read-only sandbox test.

## 2. Registry runs a stale checkout

SAW: am-node-registry.service runs from the live checkout /media/model-cache/github/agent-manager. Per the session report, that checkout had an unpushed local commit and was 87 commits behind origin/master. It ran old code without the clearLeasedTo release fix and dropped the new codeSha heartbeat field. The clearLeasedTo fix is at src/node-registry-server.js:79 and is called from handleRelease at :143. The git state is outside the repo and unconfirmed.

WHY IT MATTERS: Leases may not be released on task completion, and heartbeats do not report which code a node runs.

WHO DECIDES: The owner decides between pushing the local commit, fast-forwarding and restarting, or repointing the unit at a clean checkout.

## 3. Trial pool still used as the pipeline directory

SAW: am-node-registry.service and the package intake set the multi-pipeline directory variable to /media/model-cache/github/agent-manager-trial-pool, not the real pipelines. The variable is read at src/node-registry-server.js:190 and src/package-intake-server.js:84. The trial-pool path is a host path on grimm with no repo match.

WHY IT MATTERS: The registry and intake hand out and accept tasks from the trial pool, not the real pipelines.

WHO DECIDES: The owner decides when to switch the variable to the real pipelines.

## 4. Retry units written but not installed on grimm

SAW: scripts/provision-node.sh writes am-node-retry.service and am-node-retry.path (lines 115, 129, 135; header at line 13). They are not enabled or installed on grimm. docs/agents/multi-node-runbook.md:83 describes them: they requeue review-rejected or degenerate-critique blocked records to pending at most twice, then mark them needs-clarification.

WHY IT MATTERS: Without the units, rejected records stay in queue/blocked and are not retried or escalated.

WHO DECIDES: The owner decides whether to install and enable the retry units.

## 5. Unencrypted LAN traffic with bearer tokens

SAW: The registry listens on 192.168.40.11:7471 and the package intake is on the LAN too. Both use bearer tokens and no TLS (assumed, verify against the service configuration). No token value is recorded here.

WHY IT MATTERS: Anyone on the LAN who can capture traffic can read the bearer tokens and replay them.

WHO DECIDES: The owner decides whether the LAN is trusted enough or the traffic goes over tailscale (docs/agents/tailnet-gateway.md covers the tailnet setup).

## 6. Transport for published code bundles is undecided

SAW: src/node-code-publish.js and src/node-code-apply.js are cited as producing and applying a code bundle, but neither file is in the repo. How a bundle reaches a node (an intake route, a shared directory, or scp) has not been chosen.

WHY IT MATTERS: Without a transport, nodes cannot receive code updates from wok, so they keep running whatever code they already have.

WHO DECIDES: The owner decides the transport. The two source files must exist before the transport can be built.

## 7. Approval of a draft with no diff

SAW: Per the session report, on 2026-11-16 a task whose agentic draft produced no diff was still approved (2 of 3 votes). It then ended as `noop` in done/ without delivering anything. This happened twice (node-status expired-row fix; node-code-apply). No repo citation.

WHY IT MATTERS: The pipeline reports success for tasks that changed nothing, and a human can merge that result believing work was done.

WHO DECIDES: The owner decides whether to queue a mechanism task that refuses approval when the draft has no diff.

## 8. Review gate runs no mutation spot-check

SAW: Per the session report, the review gate does not run a mutation spot-check. In trial 2, 2 of the 3 branches checked had surviving mutants, and their tests missed a specified boundary but still passed review. The mutation check is documented in docs/agents/mutation-check.md (contents assumed, verify against that file).

WHY IT MATTERS: Tests that miss spec boundaries pass review, so the review gate gives false confidence.

WHO DECIDES: The owner decides whether to queue a candidate mechanism task that runs mutation spot-checks at review.

## 9. Cloud worker usage limits on grimm

SAW: A Haiku-drafted trial incurred a cost. The cloud worker is described in docs/agents/node-cloud-worker.md, which exists in the repo. The Claude Pro login on grimm has its own usage limits. The planned answer, an account switcher, is not yet in the repo (docs/agents/account-switcher.md is absent).

WHY IT MATTERS: Without a switcher, the grimm worker stops when its account limit is reached, and the trial cost is not bounded.

WHO DECIDES: The owner decides when to write the account switcher and its doc.
