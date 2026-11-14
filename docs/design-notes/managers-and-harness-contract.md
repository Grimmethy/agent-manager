# Managers and the HTTP harness contract

Status: audit and extraction map, verified against `origin/master` f3e23ab0 and the live repos under `/media/model-cache/github/` on 2026-11-10. Read-only: no code was changed and no remote repository was created. Process: `docs/agents/repo-extraction-playbook.md` steps 1-2.

## 1. Method

The 39 entries of `plugins.json` were read (`registerPath`, `url`, `process`, `tab`, `watchdogScripts`). For each repo that has a `registerPath`, every non-test and test `.js` file was searched for `require` of Agent Manager (AM) modules (a script walked the tree, skipping `node_modules`, `.venv`, `gallery`). The five repos the task names (promptforge, characterforge, storyforge, books, mailroom) were also searched for AM environment variables, AM HTTP routes, and the shared files `queue/`, `projects.json`, `plugins.json`. The AM routes were read from `python/dashboard/routes/` and the broker's from `agent-manager-gpu-broker`. Counts below are what those searches printed.

## 2. The 39 `plugins.json` entries

| Group | Count | Entries |
|---|---|---|
| Forges (forge-manager) | 17 | promptforge, adforge, scriptforge, characterforge, postforge, cutforge, voiceforge, storyforge, videoforge, sceneforge, stageforge, sparforge, kaggleforge, journalforge, annieforge, recipeforge, uiforge |
| Business apps (business-manager) | 7 | books, fsbo-callsheet, inventory-plugin, intakereel, trade-calculator, mailroom, pf-loops |
| Shared services (stay independent) | 7 | gpu-broker (7449), cloud-providers (7450), and the five wikiforge entries: `wikiforge-secondbrain`, `wikiforge-agent-manager`, `wikiforge-wikiforge`, `wikiforge-propertyforager` (all four at port 7421) and `wikiforge-content-pipeline` (no URL, no process) |
| AM plugins (not managers) | 8 | agent-manager-hygiene, agent-manager-hub-tasks, agent-manager-pipeline-ops, agent-manager-context-ops, agent-manager-hardware-plugin (7440), agent-manager-hardware-goatmon-plugin (7441), agent-manager-chat-plugin (7442), llm-tuner (7453) |

That is 17 + 7 + 7 + 8 = 39. The task text says "4 are wikiforge on port 7421": four entries share the port; a fifth wikiforge entry (`content-pipeline`) has no URL.

Two entries have no companion process: `mailroom` (its URL is a Tailscale address, `100.96.112.78:7464`, so it runs on another machine) and `pf-loops` (watchdog scripts only, no tab and no URL). A manager must therefore support an entry that is an external URL with no process, and an entry that has no tab.

## 3. Every way a forge or business app touches AM today

| # | Touch point | Who | Found in |
|---|---|---|---|
| T1a | Code import of AM modules by `require` | characterforge only (5 modules: `task-sources`, `domain-apply-route`, `config`, `task-source-registry`, `model-profile-registry`); the shared service wikiforge `content-pipeline` also imports 4 | `characterforge/register.js:29,42`, tests |
| T1b | Code reuse of AM modules WITHOUT a declared import: `loadCoreSeams` in `uiforge/harness/conformance/source.js` finds the already-loaded AM modules through `require.cache` and calls `script-handler-registry`, `task-sources` (`taskIdExistsInQueue`), `config` (`getConfig`) and `queue-adhoc-task` (`queueAdhocTask`) by absolute path | uiforge | `uiforge/register.js`, `harness/conformance/source.js:18-33` |
| T2 | `register.js` as the `AGENT_MANAGER_REGISTER_PATH` entry point | all 24 forge and business entries (the 17 forges plus the 7 business apps, one register file each; the 15 shared-service and AM-plugin entries are not counted here) have a `registerPath`; 22 of those 24 files export only `module.exports = {}` (a no-op); the two that do real work are characterforge (28 lines, T1a) and uiforge (11 lines, T1b) | `promptforge-manual/register.js`, `books/dashboard/register.js`, `mailroom/register.js`, `storyforge/register.js` |
| T3 | Tab entry in `plugins.json` (`tab.key`, `label`, `kind: script`, `script`, `replaces`) and the plugin's own `ui/<name>-tab.js` served from `/api/plugins/<name>/ui/...` | 23 of 24 (`pf-loops` has no tab) | `plugins.json` |
| T4 | `POST /api/plugins/<name>/ensure-started` from the tab script | 20 of the 23 tabs: promptforge, scriptforge, characterforge, postforge, cutforge, voiceforge, storyforge, videoforge, sceneforge, stageforge, sparforge, kaggleforge, journalforge, annieforge, recipeforge, uiforge, books, inventory-plugin, intakereel, trade-calculator | `*/ui/*-tab.js` |
| T4b | Tabs that do NOT call ensure-started: `adforge` (asks `GET /api/adforge/config` for its URL, then falls back to `http://<host>:7431/`), `fsbo-callsheet` (hard-codes port 7455) and `mailroom` (hard-codes the Tailscale URL). Note that `/api/adforge/config` is a route inside AM itself (`python/dashboard/routes/embedded_tools.py:47`), so AM's own code names a forge | adforge, fsbo-callsheet, mailroom | the three `ui/*-tab.js` files |
| T5 | Process definition in `plugins.json` (`process.command`, `args`, `cwd`, `healthPath`, `env`) | AM starts and health-checks the forge | `plugins.json`, `python/dashboard/plugin_process_manager.py` |
| T6 | GPU: `GPU_BROKER_URL` and the broker routes | promptforge (`server/core/gpu_client.py`, `comfy.py`), videoforge (`server/core/gpu.py`, also reads `PROMPTFORGE_URL`), sparforge (1 file) | files named |
| T7 | Shared file: the ComfyUI lease file (`AGENT_MANAGER_COMFY_LEASE_PATH`, TTL `AGENT_MANAGER_COMFY_LEASE_TTL_S`, max `AGENT_MANAGER_COMFY_LEASE_MAX_S`) | promptforge writes it (`comfy_proc.py:60-61`); AM's `src/gpu-guard.js:48` reads it; `scripts/launch.sh:31-34` deletes it on an explicit pipeline start | both sides |
| T8 | Shared directory: `AGENT_MANAGER_MODEL_LOCKS_DIR`, defaulting to a path inside AM's own `instances/.model-locks` | promptforge `server/core/gpu_session.py:53` | file named |
| T9 | Domain config: `AGENT_MANAGER_DOMAINS_PATH` and `AGENT_MANAGER_REPO_ROOT` (a source stays silent unless the active project's `task-domains.json` defines `character_content`) | characterforge (`am/common.js`) | `characterforge/register.js:20-21` |
| T10 | Documentation-only references to `queue/`, `projects.json`, `plugins.json`, port 7420 | storyforge README and spec, books docs and `run.sh`, characterforge docs | counts only; no code reads them |

What the search did NOT find: no forge or business repo calls `/api/task/...`, `/api/adhoc-tasks`, `/api/pipeline/...` or `/api/stream`, spawns an AM script, or edits `projects.json`. The only non-UI HTTP contact with AM is the lazy start (T4) and the GPU broker (T6). Tasks do reach AM's queue, but in-process: uiforge calls `queueAdhocTask` (T1b) and characterforge's registered sources file tasks through AM's source registry (T1a); both are exactly what a task-submission route (H1) would replace.

## 4. Does the HTTP API plus gpu-broker cover each touch point?

| Touch point | Covered over HTTP today? | What is missing |
|---|---|---|
| T1a characterforge source registration; T1b uiforge's `loadCoreSeams` | No. Sources are registered by `require` of `task-source-registry` and a domain-apply seam (`registerDomainApply`) | A declarative registration over HTTP, or characterforge stays an AM plugin and is excluded from the manager (decision D2). These are the only two real code dependencies in the 24 repos; uiforge's is the less safe one because it is undeclared, so a Kernel refactor of those four modules breaks it silently |
| T2 no-op `register.js` | Not needed | Nothing; the manager can list a tab group without a register file |
| T3 tab entry | Yes, through the manifest tab slot; `GET /api/plugins` lists it | A manager must write its group's entries into the manifest, or AM must read a group manifest from a URL |
| T4 ensure-started (20 tabs) and T4b (3 tabs that skip it) | Yes for the 20, `POST /api/plugins/<name>/ensure-started` (`routes/plugins.py:353`), same origin | If the manager owns the process, the route proxies to the manager; AM needs a manager-registered handler |
| T5 process definition | No: AM owns it in `plugins.json` | The manager owns process management (section 5) |
| T6 GPU | Yes: `POST /api/gpu/acquire`, `/heartbeat`, `/release`, `/yield`, `GET /api/gpu/status`, `/cards` on the broker | Nothing for the three clients; the search found broker use in only three repos (promptforge, videoforge, sparforge); whether other forges that run a model need it was not audited |
| T7 lease file | No: file-based, bypasses HTTP | Retire the file once all lease holders use the broker; until then both sides keep reading it |
| T8 model locks dir | No: a shared directory inside AM | A broker endpoint for model locks, or move the directory out of AM's tree |
| T9 domain config | No: environment and a file | `GET` of the active project's domains over HTTP, or a per-manager config |
| Submit a task with premium priority | **No route exists.** `POST /api/brain-dump/capture` files a note; `POST /api/task-anywhere/<id>/premium-priority` flips an existing task; nothing creates an adhoc task over HTTP (creation is `src/queue-adhoc-task.js`, a script) | `POST /api/tasks` with `{title, rawText, files, premium, raisedFrom}` |
| Read a task's status or verdict | Partly: `GET /api/task-anywhere/<id>` and `GET /api/queue/<state>`; branch verdicts via `/api/git/branches/...` | A single `GET /api/tasks/<id>/status` with phase and verdict |
| Subscribe to a task's status or verdict | Partly: `GET /api/stream` (server-sent events, resumable by `Last-Event-ID`) exists; whether it emits per-task events for a given id was not verified | Confirm or add a per-task event type |
| Request and release a GPU lease | Yes (broker, above) | None |

Net: the forge side is already almost HTTP-only. The gaps are one new AM endpoint (task submission), one status endpoint, the lease and lock files, and characterforge's code imports.

## 5. The two managers

**forge-manager** (17 forges) and **business-manager** (7 apps) each register as one tab group through AM's single manifest tab slot and also run standalone on their own port.

What each owns:
- **Port allocation.** Today ports 7430-7464 are written by hand in each `plugins.json` entry (all unique; the wikiforge entries share 7421 on purpose). The manager owns a registry file and refuses a duplicate.
- **Process management and ensure-started.** The manager runs the command, working directory, environment and health check that `plugins.json` holds today (T5), and answers the lazy start (T4). AM's route forwards to it.
- **The tab registry.** The manager supplies its group's `tab` entries; AM shows one front door.
- **Non-process entries.** `mailroom` (external URL) and `pf-loops` (no tab) are modelled explicitly.

What moves out of `plugins.json`: 24 entries (17 + 7) become two group entries. 15 entries stay: the 8 AM plugins, gpu-broker, cloud-providers and the 5 wikiforge entries.

### Migration steps that keep every forge reachable

1. Add the manager's group manifest reader to AM alongside `plugins.json`; both sources are read, `plugins.json` wins on a name clash. Nothing moves yet. Test: the tab list is identical.
2. Stand the forge-manager up standalone on its own port, serving a copy of the 17 entries. Test: each forge answers its health path through the manager.
3. Switch one forge (the one with no GPU use) to be listed by the manager only; remove its `plugins.json` entry. Test: its tab still opens, ensure-started still works, `GET /api/plugins` shows it once.
4. Repeat per forge, GPU forges (promptforge, videoforge, sparforge) last, after T7 and T8 are retired.
5. Repeat for business-manager; `mailroom` and `pf-loops` last.
6. Remove the manager's duplicate entries from `plugins.json`.

Rollback at every step: restore the one entry in `plugins.json` (a backed-up file); the manager keeps running and is simply not consulted.

## 6. Ordered PR-sized pieces

| Piece | Files | Named test | Rollback | Depends on |
|---|---|---|---|---|
| H1 `POST /api/tasks` and `GET /api/tasks/<id>/status` | a new route file and its test in `python/dashboard/routes/` | route test: creates an adhoc record in a temp pipeline, premium honoured, status reads back | revert | none |
| H2 per-task event on `/api/stream` | `event_stream.py` provider | stream test with a fake task transition | revert | H1 |
| H3 model locks over the broker | broker repo and `gpu_session.py` | broker test plus promptforge's `tests/test_gpu_client.py` | revert | none |
| H4 retire the ComfyUI lease file | `gpu-guard.js`, `comfy_proc.py`, `launch.sh` | `test_gpu_wiring.py` and gpu-guard tests | restore file reads | H3 |
| H5 manifest group reader | `plugins.json` loader, `python/dashboard/routes/plugins.py` | tab list identical with and without a group | revert | none |
| H6 forge-manager standalone | new repo (owner D1), its own process manager, port registry | health path for each of 17 forges | stop the manager | H5 |
| H7 move forges one by one | `plugins.json` entries | per-forge tab opens | restore the entry | H6, H4 for GPU forges |
| H8 business-manager | new repo, same steps | per-app tab opens | as above | H6 |
| H9 characterforge source registration | seam in AM plus characterforge | its `character-interview` tests | revert | D2 |

## 7. Owner-only decisions

- **D1 (outward-facing):** creating the `forge-manager` and `business-manager` remote repositories. Listed, not done.
- **D2:** characterforge (T1a) and uiforge (T1b) register task sources through AM code. Either they stay AM plugins outside the managers (recommended: they are task sources as well as apps; their apps can still be listed in the manager) or a source-registration route is built.
- **D3:** whether the wikiforge entries (5 names, 4 at port 7421) stay in `plugins.json` as shared services (recommended: yes, as the task says).
- **D4:** whether the lease file and model locks (T7, T8) are retired once the broker covers them (recommended: yes, pieces H3 and H4).
- **D5:** whether `intakereel` belongs to the business-manager, as the task says, or the forge-manager (its tab label uses the forge icon; no other evidence was found).
