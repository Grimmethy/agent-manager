# Brain Dump in agent-manager: shape and extraction map

Status: reference (brain dump) · Written 2026-09-20 from a code read of `master` at `97b4bee` · Companion: `Docs/hub-tasks-extraction-map.md`
(the same exercise for hub tasks) · Related: `docs/adr/0022-core-is-a-platform-plugins-define-the-work.md` (open question 1 is about
`brain_dump_sort`), `docs/agents/codebase-map.md` rows "Brain Dump" and "Filed Findings".

**Why this exists.** Brain Dump is to become its own repo: a standard item that can be dropped into any project. Today it is not a
module. It is a JSON file plus a dashboard tab plus a task source plus a set of sweeps, spread across ~179 tracked files
(most of them tests and comments) in two runtimes (Node pipeline, Python dashboard). This is the map of every part, the shape of the
records it moves, and the seams where it is entangled with the rest of the pipeline.

Vocabulary: **entry** = one record in `brain-dump.json`. **capture** = create an entry (human or machine). **sort** = the
`brain_dump_sort` task that classifies a `captured` entry. **filed note** = the Second Brain vault note a sort writes.
**queued task** = a task a sort (or Prioritize) creates from an entry. **machine-raised** = an entry with `raisedBy`.
**side finding** = a `SIDE-FINDING:` block a model emits mid-response. Not to be confused with the **Second Brain** (the Obsidian-style
vault under `SECOND_BRAIN_DIR`): it is the sort's *destination*, a neighbouring system with its own routes/UI, not part of Brain Dump.

---

## 0. Decisions so far (Grimmethy, 2026-09-20)

| # | Question (section 8) | Status |
|---|---|---|
| 1 | Single owner for `brain-dump.json` | **Being clarified, not decided.** Meaning: exactly one component reads and writes the file and everything else asks it (call / HTTP / CLI), so two programs can never overwrite each other's change. Section 8 has the failure it prevents. |
| 2 | Is the sorter part of the repo? | **Yes.** The sorter (`brain_dump_sort`, classifier, prompts, apply) moves with Brain Dump. This settles ADR 0022 open question 1 *for Brain Dump*: its allowlist exemption and the hardcoded `brain_dump_sort` handling in `getNextTask()` become properties of the repo's own registration, not of core. |
| 3 | Delivery: library, plugin, or separate service | **Exploring.** See section 9. |
| 4 | Vault and project-registry adapters | **Not sure yet.** Left open. |
| 5 | The UI | **Part of the repo**, with the rest of the code. The open work is a defined contract for how the UI talks to its host (section 7, Seam B). |

## 1. The loop

```
  human: dashboard "+ Brain Dump" (any tab) ─────────────────────────────┐
  model: SIDE-FINDING: block in any response ─> queue/side-findings-inbox/ ─(watchdog tick)─> side-finding-sweep ─┤
  pipeline sources (debrief, forensics, change_review, ...) raise via the same inbox (raisedBy.source)           ▼
                                                                                           brain-dump.json  status:'captured'
                                                                                                         │
                             brain_dump_sort (task source, priority 42, cheap local model, DETERMINISTIC review)
                                                                                                         ▼
                              status:'sorted'  (a note filed into the vault: sort.secondBrainPath/tags/rationale)
                              status:'actioned' (a task queued in the origin project: queuedTaskId; or researched / hand-closed)
                                                                                                         │
                      apply of the queued task ──> closeOriginatingBrainDumpEntry ──> resolvedAt / resolvedNote
```

## 2. Inventory by layer

| Layer | Files | Owns |
|---|---|---|
| **Store** | `<pipelineDir>/brain-dump.json` (`{"entries":[…]}`); override `AGENT_MANAGER_BRAIN_DUMP_PATH` | the whole state. One file **per project pipeline dir** (agent-manager 1,311 entries / 1.9 MB; five other projects have their own). The path default is computed twice, independently: `python/dashboard/app.py` `brain_dump_path()` and `src/config.js` `brainDumpPath` ("no other link between them") |
| **Store access, Python** | `app.py`: `read_brain_dump_entries` / `write_brain_dump_entries` (whole-file rewrite), `_assign_brain_dump_serials` (the `#N` handle), `_brain_dump_entries_with_task_status` (joins each entry to its queued task's live queue state), `_brain_dump_needs_attention_count`, `BRAIN_DUMP_NEEDS_ATTENTION_STATES` | dashboard-side reads/writes |
| **Store access, Node** | `apply-group-a-brain-dump.js`: `loadBrainDump`, `findEntry`, `recoverableSortSkip`, `closeBrainDumpEntryResolved`; `writeJsonAtomicSync` (`atomic-write.js`) | pipeline-side reads/writes |
| **Dashboard API** | `routes/brain_dump.py` (300 lines): `GET /api/brain-dump`, `GET /api/filed-findings`, `POST /api/brain-dump/capture`, `PUT /api/brain-dump/<id>`, `POST …/suppress`, `DELETE …`, `POST …/prioritize` ("Process this now": injects the entry straight into `queue/adhoc/`, **bypassing the sort**, and marks it `actioned`), `GET …/discuss/latest`, `POST …/discuss/start`; `is_filed_note` splits the human view from filed notes | the tab's back end. Also `routes/shared_misc.py` (summary badge `counts["brain-dump"]`, needs-attention, hides suppressed/filed), `routes/task_anywhere_1_more.py` (a Discuss session ending appends its summary to the entry's `rawText`), `discuss_sessions.py` + `chat_sessions.py` (per-entry Discuss; storage dir is passed in by the caller) |
| **Dashboard UI** | `static/js/brain-dump-and-second-brain.js` (1,113 lines; the Brain Dump half is ~L1-520 and L962-1000, the Second Brain browser is L519-960 in the **same file**), `core-ui.js` (global capture modal, badge), `templates/index.html` (tab, `#global-brain-dump-btn`), `branches-joblist-hardware-tabs.js` | the tab, the "+ Brain Dump" button available on every tab, Filed Findings tab |
| **Sort pipeline** | `task-sources.js`: `registerTaskSource('brain_dump_sort', …)` (L1518), `nextBrainDumpSortTask`, `brainDumpSortTaskId`, `brainDumpSortReviewValidate`; `brain-dump-sort-classify.js` (323 lines: parse, `validateSecondBrainPath`, `CANONICAL_TOP_LEVEL`); `apply-group-a-brain-dump.js` (513 lines: `applyBrainDumpSort`); `lib/prompt-planning.js` `brainDumpSortPlanPrompt`, `lib/prompt-implementation.js` `brainDumpSortImplementPrompt`, `prompts.js` `brainDumpDirective`; `reject-retry-check.js` `stampBrainDumpSortExhausted` (`sortAttempt`); `scripts/migrate-brain-dump-sort-backlog.js`; `python/dspy_brain_dump_sort_pilot.py` (pilot) | classify -> file a note, or queue a task in the origin project (`research/`, `derived/` or `adhoc/`) |
| **Intake, machine** | `side-finding.js` (marker convention, `injectSideFindingInstruction` / `extractSideFindings` / `writeSideFindingInbox`), hooked at three model-client chokepoints (`local-client.js`, `claude-client.js`, `local-tool-client.js`); `side-finding-sweep.js` (watchdog one-shot from `queue-watcher.sh`: drains `queue/side-findings-inbox/`, dedupes by Jaccard against machine-raised entries only, bumps `count`/`lastSeenAt`/`seenIn`); `incident-amplification.js` + marker | how the rest of the system files findings without knowing Brain Dump exists |
| **Loop closing** | `lib/apply-core.js` `closeOriginatingBrainDumpEntry`, called from `apply-task.js` (4 sites) and `lib/apply-main-batch.js` (3 sites); `staleness-audit.js` (sweeps queued tasks a human resolved by hand) | marks an entry resolved when its task lands |
| **Vault (neighbour)** | `SECOND_BRAIN_DIR` (`config.js` `getSecondBrainDir`), `app.py` `second_brain_dir()`, `routes/second_brain.py` | the sort's destination; out of scope but the hardest coupling |
| **Docs / tests** | `README.md` task-source rows, `AGENTS.md` (side-finding section), `docs/agents/codebase-map.md` (route list "not yet itemized": this file itemizes it), ADR 0022 | tests: `brain-dump-sort-classify.test.js`, `test_brain_dump_routes.py`, `side-finding*.test.js`, `incident-amplification*.test.js`, plus large BD sections in `apply-group-a.test.js` (207 refs), `task-sources.test.js` (114), `apply-task.test.js` (37) |

## 3. Record shape

Core (every entry): `id` (slug, `bd-<epoch-ms>-<slug>`), `serial` (stable `#N`, assigned in `capturedAt` order by the dashboard), `capturedAt`,
`rawText`, `status` (`captured` -> `sorted` | `actioned`; live counts 201 / 517 / 593).

| Field(s) | Written by | Meaning |
|---|---|---|
| `raisedBy {source, taskId, repoRoot, …}`, `count`, `lastSeenAt`, `seenIn` (958 entries) | `side-finding-sweep.js` | machine-raised; the dedupe counter. `raisedBy.repoRoot` says which project's pipeline raised it |
| `sort {secondBrainPath, tags, actionable, rationale, category?}`, `sortedAt` (517) | `applyBrainDumpSort` | classification + where the note was filed |
| `queuedTaskId`, `queuedAt` (579) | `applyBrainDumpSort`, Prioritize | the task made from this entry (the join key for live status in the UI) |
| `resolvedAt`, `resolvedNote` (169) | `closeBrainDumpEntryResolved` | the queued task landed |
| `suppressed`, `suppressedReason`, `suppressedAt` (150) | `POST …/suppress` | hidden from every list and from dedupe matching; reversible |
| `sortAttempt`, `duplicateGateAttempts`, `rerouted` | sort retry / duplicate gate | bounded-retry bookkeeping |
| `editedAt`, `reopenedAt/Note`, `note`, `actionedAt`, `sourceUrl`, `sourceVerifiedAt` | dashboard | edits, reopen, research provenance |

Who files entries (live counts): 353 human-typed (no `raisedBy`); machine-raised by `raisedBy.source`: `manual` 308 (side findings emitted while a
manual/adhoc task was being worked), `pipeline_debrief` 268, `change_review` 61, `concept-research` 49, `pipeline_forensics` 46 + `pipeline_forensics_fix` 28,
`observability_fix` 23, and a tail of research sweeps (`chat_context_research`, `blocked_task_classification_research`, ...).

Statuses are few and the file is a plain list, but nothing enforces the shape: two runtimes read and write it directly.

## 4. Where Brain Dump leaks into non-Brain-Dump modules (the entanglement)

| Module | Touchpoint |
|---|---|
| `task-sources.js` (83 refs) | the `brain_dump_sort` registration and its **allowlist exemption** (always active "above any single project"; ADR 0022 Q1), routing into `derived_task` / `research_task`, `brainDumpSortReviewValidate` |
| `review-task.js`, `reject-retry-check.js` | the deterministic-review branch for this one source; sort exhaustion stamping (`stampBrainDumpSortExhausted`) |
| `apply-task.js`, `lib/apply-core.js`, `lib/apply-main-batch.js`, `apply-group-a.js` | `brainDumpPath` threaded through every apply path; `closeOriginatingBrainDumpEntry` at seven call sites; the sort apply lives in the "Group A" apply family |
| `local-client.js`, `claude-client.js`, `local-tool-client.js` | side-finding inject/extract/write at every model call (the chokepoints that make Brain Dump "ambient") |
| `local-draft.js`, `prompts.js`, `lib/prompt-*.js`, `fact-checker.js`, `path-prefetch.js` | sort prompts and `brainDumpDirective`; `path-prefetch.js` `resolveAnchors` is imported by the sort apply |
| `apply-group-a-brain-dump.js` <- `projects.json` | cross-project routing: `readProjectRegistry`, `originProjectFor`, `deriveBelongsToProject` decide which project's queue a queued task lands in |
| `scripts/queue-watcher.sh` | runs `side-finding-sweep` (L289) each watchdog tick; `context-log-sweep` (L300) is adjacent but **deliberately not routed through Brain Dump** |
| `concepts.js`, `concepts.json` | `conceptId` on side findings; Incident Amplification files its "silent siblings" as side findings, and concept research raises entries too (`raisedBy.source: concept-research`) |
| `local-worker.ps1`, `config.js`, `build_graph.py` | the Windows worker's priority-tier bucket and single-JSON-output handling for the sort source; env/paths; graph nodes. (`single-flight-lock.js`, `system-report.js`, `needs-clarification-triage.js` only *cite* Brain Dump ids or the cheap sort model in comments: no coupling) |
| dashboard `app.py` (55 refs), `shared_misc.py`, `core-ui.js`, `index.html` (49 refs) | badge counts, needs-attention, global capture modal, tab wiring |

## 5. Operational surface

* **Env:** `AGENT_MANAGER_BRAIN_DUMP_PATH` (same name in both runtimes on purpose), `SECOND_BRAIN_DIR`, `AGENT_MANAGER_SIDE_FINDING_SWEEP=false` (kill switch), `AGENT_MANAGER_PROJECTS_REGISTRY_PATH`.
* **Dirs:** `queue/side-findings-inbox/`, `queue/derived/`, `queue/research/`, the vault, and each project's own `brain-dump.json`.
* **Model profile:** `brain-dump-cheap-local` (a small local model; `brain_dump_sort` is the highest-volume task type).

## 6. Contracts with other repos

* **agent-manager-hygiene:** no code dependency. `git grep` finds only comments citing brain-dump ids. The plugin's work reaches Brain Dump
  *indirectly*: models emit `SIDE-FINDING:` blocks and the core files them. So the inbound contract is the marker + the inbox directory
  + the `raisedBy` shape, nothing else.
* **Other projects:** each has its own pipeline dir and its own `brain-dump.json`; only the sort source, the vault, and the project
  registry are shared.
* **Second Brain:** the vault path, the `CANONICAL_TOP_LEVEL` taxonomy, and `is_filed_note` (which separates filed notes from human entries in the UI).

## 7. Extraction guidance

**Seam A: the kernel (this is the drop-in).** Store + record schema + serials + the capture / edit / suppress / delete / read-with-task-status
API + counts. The first job is a **single owner** for the file: today Python and Node each implement the same JSON contract.

**Seam B: the UI (in the repo, decided).** The tab, Filed Findings, and the global "+ Brain Dump" capture move with the code. Split them out of the
Second Brain JS file first. What has to be designed is the **host contract**, because today the UI reaches into agent-manager freely. The touchpoints
to turn into an explicit interface: (1) where and how it mounts (a tab, a global capture button on every tab); (2) the summary badge / needs-attention
counts the host shows elsewhere (`counts["brain-dump"]`); (3) the join from an entry's `queuedTaskId` to the host's live task state
(`_brain_dump_entries_with_task_status`); (4) per-entry Discuss sessions, which today use the host's chat/discuss machinery; (5) which project's store
the UI is looking at (the host's active project); (6) styling/theme, auth and session, and the fetch base URL, none of which the UI should assume.

**Seam C: the sorter (in the repo, decided).** The `brain_dump_sort` source, classifier, prompts and apply. It still depends on host services that
must become adapters: a vault (destination), a project registry (routing), a model profile, **and**, the part that is easy to miss, the pipeline
machinery it runs on today: a task queue, a worker lane, the GPU/model lock, deterministic review and the apply stage. Inside the repo it needs a
"schedule this work" and "make a cheap model call" contract.

**Seam D: intake.** `side-finding.js` + the sweep + the inbox. The model-client chokepoints stay in the host; they only need the marker
functions and an inbox writer.

**Seam E: loop closing.** Replace the seven direct `closeOriginatingBrainDumpEntry` calls with one "task resolved" hook the host fires.

**Suggested first step (same as the hub map):** plan first. Then add the hook interfaces (a store adapter, a sort-destination adapter, a
project-registry adapter, a task-resolved hook) to the source registry and `docs/PLUGIN_API.md` with the **current behaviour as the default
implementation**, keep the full suite green at every step, and only then move code behind them. Do not change Brain Dump behaviour while extracting.

**Invariants to keep (each is visible in the code today):**
1. The dedupe only ever merges a machine finding into another **machine-raised** entry, never into a human-typed note (`side-finding-sweep.js`).
2. Machine intake writes only to the inbox; **one** sweep does the batched read-modify-write, not the hot model-call chokepoints.
3. Sort review is **deterministic** (parse + validate + tracked-label check), never an LLM vote.
4. Every entry keeps a stable `serial`; `id` stays a slug; `serial` assignment is oldest-first and never reassigns.
5. A suppressed entry is hidden everywhere and never matched or counted; suppress is reversible.
6. Closing the loop is best-effort and must never fail an apply.
7. Machine-written report dirs and chat context logs are never routed through Brain Dump or the sorter.
8. A machine-raised finding belongs to the project that raised it (`originProjectFor`), not to the classifier's guess.
9. `{"entries":[…]}` and `AGENT_MANAGER_BRAIN_DUMP_PATH` are a shared contract between the two runtimes.

## 8. Known gaps and open questions

* **Two runtimes, one JSON file, no lock (decision 1).** Python rewrites the whole file; Node writes atomically; the code calls the race "theoretical and already
  accepted". The failure it allows is a lost update: the dashboard reads the file, the pipeline appends an entry, the dashboard writes its copy back, and the
  pipeline's entry is gone, with no error. A repo dropped into many projects cannot inherit that. Whether it has ever actually lost an entry here was not checked.
* **Whole-file rewrite** of a 1.9 MB file on every change.
* **The sorter is in the repo (decided), but it runs on agent-manager's task pipeline today.** A host without that pipeline needs the sorter to bring its own runner, or a contract for one. Also still open: the vault and the project registry (decision 4).
* **Per-project store vs shared vault.** A project's entries are its own; the vault and the always-on sort are shared, and routing a queued task to *another* project's queue reads `projects.json`. A standalone repo needs an explicit project-registry contract.
* **The UI shares a file with the Second Brain browser**, and `is_filed_note` couples the two views. The UI is in the repo (decided); its host contract is section 7, Seam B.
* **`getNextTask()` hardcodes `brain_dump_sort` as allowlist-exempt.**
* **Line numbers here are as of `97b4bee`.** `docs/agents/codebase-map.md` still says the route list is not itemized; update it when this lands.

## 9. Delivery options compared (decision 3)

This system already ships all three shapes, so each option has a working precedent.

| | **A. In-process plugin** | **B. Separate service** | **C. Library (npm + pip)** |
|---|---|---|---|
| Precedent here | `agent-manager-hygiene`: `register.js` loaded into the pipeline via `AGENT_MANAGER_REGISTER_PATH`, contract in `docs/PLUGIN_API.md`, one-way dependency, `plugin-api.test.js` | `agent-manager-chat-plugin` and the hardware plugin: own repo, own Flask app and port (7441/7442), declared in `plugins.json` with `slot`, `url`, `process`, optional `proxy {prefix, sse}`; PromptForge/AdForge/ScriptForge are standalone apps embedded as tabs | none as such (hygiene deep-imports core: "no `exports` map" is a listed wart) |
| How the host uses it | shares the Node process and the filesystem; registers task sources, calls core helpers | host launches/lists it and proxies `/api/<prefix>/*`; the plugin can call back into the host (`internal_api_client.py` in the chat plugin) | host imports it in each runtime |
| **Single owner of the file** (decision 1) | only if every reader goes through the plugin's module; the Python dashboard cannot, so a second implementation remains | **natural**: the service is the only thing that touches the file; everyone else uses its HTTP API | needs one implementation per language, which recreates today's two-writer problem |
| **UI in the repo** (decision 5) | awkward: the host must serve the plugin's static files itself | **natural**: the service serves its own UI; the host embeds it (tab, sidebar slot, or a small script for the global capture button) | the host must bundle and mount it |
| **Sorter in the repo** (decision 2) | natural in agent-manager (it *is* a task source, as today); nothing for a host with no pipeline | needs its own runner or a "schedule work / model call" contract with the host. Precedent: the chat plugin keeps worker-kill and GPU-lock authority **host-side** and reaches it over HTTP (`internal_api_client.py` -> the core dashboard's internal chat API) | same problem as A |
| Works in a host that is **not** agent-manager | no: it depends on agent-manager's registry and queue | **yes**, if the host contract is small (mount, counts, task-status join) | only in the same language |
| Cost | cheapest to build; tightest coupling; core internals become API | a process to run, port, health and upgrade per project; latency; a versioned HTTP contract to keep stable | two packages to release in lockstep |
| Failure mode | a core refactor silently breaks the plugin (the contract test is the only guard) | the service is down: capture and the tab fail while the pipeline keeps running | version skew between the two language libraries |

**Where this leans, not a decision.** Decisions 1, 2 and 5 together (the repo owns the store, the sorter *and* the UI) fit **B**, with a thin in-process piece
in the host for the parts that must live in the pipeline (registering the sorter as a task source, the model-client side-finding hooks, the watchdog sweeps,
closing the loop when a task lands). That is the same split the chat plugin already uses (a service plus a `proxy` block plus a callback client), combined with
hygiene's `register.js`. The question that settles it: **which hosts is "any project" meant to include?** Projects that agent-manager already manages (each
already has its own `brain-dump.json`), or arbitrary applications with no agent-manager at all (PF-Client-Portal's React app, for example)? Only the second
needs the host-agnostic UI and the runner-for-the-sorter answers above.
