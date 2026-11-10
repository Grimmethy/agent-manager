# Owner touchpoints: definition, classification of operator actions, and gaps

Status: findings for HUB0361 piece 1. Measured 2026-11-09 against `origin/master` (read-only; nothing here changes behaviour).
Every number below came from a command run while writing this document; every `file:line` was checked against the tree.

## 1. Definition

An **owner touchpoint** is an action by a human actor on a task, a branch or a queue bucket, where the pipeline could in
principle have resolved that item itself (review it, merge it, requeue it, retire it, give it a verdict). The goal is to
drive the number of touchpoints per day towards zero.

Actions that are **outward-facing or irreversible by design** are the owner's and are not counted as touchpoints:
publishing, sending, spending money, deleting data, and choosing priorities. They are listed in the table below as
"by design" so that they are visible but kept apart from the number we want to shrink.

## 2. What is recorded today, and where

Four stores hold something about who acted. They have different shapes:

| Store | Records | Actor field | Values seen | Rows |
|---|---|---|---|---|
| `requeue-attribution.db`, table `requeue_causes` | every requeue | `actor` | operator-manual 400, pipeline-mechanism 774, agent-session 69 | 1243 (2026-09-08 to 2026-11-09) |
| `queue/branch-removals.jsonl` | branch merged, discarded, or superseded by a requeue | `actor` | merged/dashboard-merge 505, discarded/dashboard-discard 209, superseded-by-requeue/chat-requeue 23 | 737 (2026-09-22 to 2026-11-09) |
| `queue/branch-verdicts.json` | branch verdicts | `source` | chat 540, worker 46, deterministic 6, manual 6 | 598 |
| the task record | premium flag | `premiumSetBy` | operator-ui, operator-bulk, chat-queue, cli | per task |

Only the first store separates a human from an agent session from the pipeline's own mechanisms, and it covers
**requeues only**. `src/requeue-attribution-client.js:84` already holds a windowed per-actor count over it.

Requeues per day over the last 7 days, by actor (the one series that is countable today):

| Day | operator-manual | agent-session | pipeline-mechanism |
|---|---|---|---|
| 2026-11-03 | 0 | 4 | 5 |
| 2026-11-04 | 0 | 8 | 4 |
| 2026-11-05 | 3 | 3 | 4 |
| 2026-11-06 | 46 | 0 | 3 |
| 2026-11-07 | 0 | 1 | 1 |
| 2026-11-08 | 4 | 1 | 7 |
| 2026-11-09 | 5 | 0 | 3 |

## 3. Classification of the operator actions

"Recorded actor" is what the route or the code it calls writes about who acted. "Human vs script" says whether that value
can tell a person from a script that calls the same route.

| Action | Route (file:line) | Recorded actor | Human vs script | Class |
|---|---|---|---|---|
| Merge a branch | `POST /api/git/branches/<branch>/merge` (`pipeline_1_more.py:848`) | ledger actor is the constant `dashboard-merge` (`pipeline_1_more.py:689`) | cannot tell | touchpoint |
| Merge a held hub early | `POST /api/git/held-hub-branches/<branch>/merge-early` (`pipeline_1_more.py:174`) | one history line on the owning hub from `_record_held_merge_history` (`pipeline_1_more.py:107`, called at `:310`), which takes no actor; the route body does not write the removal ledger, so an early merge leaves no ledger row | cannot tell | touchpoint |
| Discard a branch | `POST /api/git/branches/<branch>/discard` (`pipeline_1_more.py:922`) | ledger actor is the constant `dashboard-discard` (`branch_discard.py:49`) | cannot tell | touchpoint |
| Discard in a batch | `POST /api/git/branches/discard-batch` (`pipeline_1_more.py:977`) | same ledger path as discard | cannot tell | touchpoint |
| Record a branch verdict | `POST /api/git/branches/<branch>/verdict` | `source` taken from the request body, defaulting to `manual` (`branch_verdicts.py:39`) | partly: chat, worker and deterministic are labelled, but a caller that omits `source` is recorded as manual | touchpoint when `manual` |
| Retire a hub | `POST /api/hub/<hub_id>/retire` (`task.py:172`) | stamps `terminalDisposition: abandoned`, `manualArchive` and a history event with the reason; no caller identity | cannot tell | touchpoint |
| Archive a task | `POST /api/task/<state>/<task_id>/archive` (`task.py:106`) | same stamp as retire; no caller identity | cannot tell | touchpoint |
| Requeue a task | `POST /api/task/<state>/<task_id>/requeue` (`task.py:515`) | `requeue_causes.actor` from `_record_manual_requeue` (`app.py:1274`), default operator-manual; also ledger actor `dashboard-requeue` (`task.py:643`) | cannot tell; any caller of the route is operator-manual | touchpoint |
| Requeue from the chat tool | `src/chat-task-requeue.js:105` | actor `agent-session` | yes | agent, not an owner touchpoint |
| Apply an approved task | `POST /api/task/approved/<task_id>/apply` (`task.py:902`) | nothing recorded about the caller | cannot tell | touchpoint |
| Set premium priority | `POST /api/task-anywhere/<task_id>/premium-priority` (`task_anywhere_1_more.py:63`) | `premiumSetBy`, only `operator-ui` or `operator-bulk` accepted, default operator-ui (`task_anywhere_1_more.py:96`) | cannot tell; a script cannot label itself without a 400 | by design (choosing priorities) |
| Queue a task with premium | `src/queue-adhoc-task.js:94` and `src/local-tool-task-tools.js:250` | `premiumSetBy` is `cli` or `chat-queue` | `chat-queue` is clean; `cli` is a person or a script | by design (choosing priorities) |
| Process a brain-dump entry now | `POST /api/brain-dump/<entry_id>/prioritize` (`brain_dump.py:234`) | nothing recorded about the caller | cannot tell | by design (choosing what to work on) |

## 4. Gaps

Each gap is an action whose record cannot separate a human from a script, or records no actor at all. Until it is
closed, a per-day touchpoint count over that action over-counts (scripts counted as the owner) or cannot be built.

1. **Merge, discard and requeue ledger actors are constants.** `dashboard-merge` (505 rows), `dashboard-discard` (209 rows) and `dashboard-requeue` name the route, not the caller. A merge by the build loop through the same route looks exactly like an owner's click. Impact: the merge and discard counts cannot be reported as owner touchpoints.
2. **Two opposite defaults for a missing requeue actor.** `src/requeue-attribution.js:316` defaults to operator-manual, `src/requeue-attribution-db.js:76` defaults to pipeline-mechanism. A requeue written without an actor is a human on one path and the pipeline on the other. Impact: the operator-manual count (400) may include requeues made by scripts.
3. **The dashboard requeue route labels every caller operator-manual.** Impact: the same as gap 2; scripted callers of the route count as the owner.
4. **Archive, retire, approve and apply, early hub merge, and brain-dump prioritize record no caller.** The early hub merge also leaves no row in the removal ledger. Impact: their touchpoints cannot be counted from the pipeline's own data; an event-level log with an actor would have to be added.
5. **Premium priority cannot be labelled by a script.** The route accepts only `operator-ui` and `operator-bulk` and rejects anything else; the library path records `cli` for both people and scripts. Impact: none for the touchpoint count (priority is by design), but the provenance is unreliable.
6. **Verdict `source` is declared by the caller and defaults to `manual`.** Impact: a script that forgets the field is counted as a human verdict.

## 5. Consequence for the later pieces

Only requeues can be counted per day today. A per-day touchpoint view should start from the `requeue_causes` series above
and report the other actions as "not countable yet", each linked to the gap that blocks it, instead of publishing numbers
that count scripts as the owner.

## 6. Rollback

This piece adds one file, `docs/design-notes/owner-touchpoints.md`. Deleting it undoes the piece.
