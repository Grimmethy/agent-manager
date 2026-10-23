# GPU broker: shape and extraction map

Status: map, **verified 2026-10-22** by three read-only passes (`Docs/gpu-broker-verification-core.md`, `-videoforge.md`, `-promptforge.md`); corrections are folded in below and marked **[2026-10-22]** · Written 2026-10-15 from `master` at `6db5a58a` (core), PromptForge `3ca798a`,
VideoForge `master` · Companion docs: `Docs/hub-tasks-extraction-map.md`, `Docs/brain-dump-extraction-map.md`,
`docs/agents/repo-extraction-playbook.md` (the process this follows).

**Why this exists.** Who holds the GPU is decided in three places that don't share code. The Forge family gets the card through a lease that
lives inside PromptForge; the pipeline learns about it through a file and a shell helper in core; VideoForge carries its own copy of the client.
Owner rule (2026-10-13): the pipeline's Ollama model and the Forge family (ComfyUI and everything driving it) never hold the card together.
Honouring that rule today is a hand-run sequence (stop the pipeline, wait for workers, unload qwen, warm ComfyUI, work, release, restart the
pipeline), and it failed in recurring ways on 2026-10-14/15: cold ComfyUI start outruns PromptForge's 120 s wait; a worker reloads qwen in the
gap between pipeline stop and session start (brain dump #1813); pipeline stop kills the Forge plugin servers; and a live forge service is
missing environment a throwaway copy had. The goal is a standalone **GPU broker** plugin that owns the lease and the handover, with core
and every forge as thin clients.

**[2026-10-22] Where the four failures stand.**
- *Cold ComfyUI start outruns the wait:* fixed in PromptForge. `COMFY_START_TIMEOUT_S` defaults to 300 s (commit d2677e1, 2026-10-15), and a second job waits up to `FORGE_START_WAIT_S` = 600 s for the one that is starting the session (commit 202c3bf, 2026-10-16). There was never a 120 s wait in `comfy.py`.
- *A worker reloads qwen between stop and session (#1813):* closed on the acquire side, because `gpu_session.begin` writes the lease first and starts the keeper before the slow part. The gap in core's pipeline-stop path is not covered by that and is still open.
- *Pipeline stop kills the Forge plugin servers:* false since 2026-10-14. `stop.sh` receives `--keep-plugins` and `python/dashboard/test_stop_pipeline_keeps_plugins.py` pins it on both paths.
- *Live PromptForge lacks `CHARACTERFORGE_ROOT`:* no longer reproduces. `cf_characters.py` falls back to a sibling `characterforge` checkout, and `GET :7430/api/presets` reports `character_source: characterforge`.

## 1. What exists today

| Piece | Where | What it does |
|---|---|---|
| Forge GPU session | `promptforge-manual/server/core/gpu_session.py` (389 lines on 2026-10-22; the map said 345) | `begin/touch/end/yield_to_pipeline`, a keeper thread (20 s tick), lease file write, ComfyUI listener lookup + stop, in-flight pipeline-call detection (`instances/.model-locks`), host RAM check |
| ComfyUI process, Ollama eviction, lease helpers | `promptforge-manual/server/core/comfy_proc.py` (601 lines) | imported by `gpu_session.py`: `COMFY_URL`, `COMFY_LEASE_PATH`, `comfy_up`, `ollama_models_on_gpu`, `evict_ollama_models`, `ensure_comfyui_ready`, `gpu_inventory`, `mem_available_mb`, `foreign_lease`, `lease_release`, `stop_comfyui`. **[2026-10-22]** The map omitted it; it has to move with G1 |
| Session HTTP API | `promptforge-manual/server/app.py:134-165` | `/api/gpu/status`, `acquire`, `heartbeat`, `release`, `yield` on `:7430` |
| Protocol doc | `promptforge-manual/Docs/GPU_FAMILY_PROTOCOL.md` | the contract above; tunables `FORGE_SESSION_IDLE_S`, `FORGE_SESSION_MAX_S`, `FORGE_KEEPER_TICK_S`, `FORGE_LOCK_WAIT_S`, `FORGE_EVICT_WAIT_S`, `FORGE_START_WAIT_S`, and since G4a `FORGE_LEASE_ENDPOINTS` (only two of them start with `FORGE_SESSION_`) |
| Auto session per job | `promptforge-manual/server/core/comfy.py` | a PromptForge job begins a session itself (`gpu_session.begin("promptforge")` in `_run`, `comfy.py:389` on PromptForge master); the ComfyUI start wait is `comfy_proc.COMFY_START_TIMEOUT_S` (300 s), not 120 s |
| VideoForge client | `videoforge/server/core/gpu.py` (45 lines), `server/app.py`, `server/core/render.py` | acquire/heartbeat/release over HTTP to PromptForge. `web/app.js` only polls the same-origin `/api/gpu` (no change needed there), and `release()` is defined but `render.py` never calls it, so the card is only returned by lease TTL |
| Lease file | `~/.local/state/agent-manager/comfyui-lease.json` | present + fresh (TTL 90 s, ceiling 900 s on the pipeline side) = Forge holds the card. Three writers, not one: PromptForge's `gpu_session.write_lease` and `comfy_proc.lease_acquire` (two different dict shapes) and KaggleForge's `server/gpu_lease.py` (endpoint-scoped, `holder: "kaggleforge"`). PromptForge refuses to start while a fresh foreign lease exists (`comfy_proc.foreign_lease`). Core has honoured an optional `endpoints` array since `3a1b58eb`; PromptForge's lease is card-scoped since G4a |
| Pipeline-side lease read | `scripts/agent-manager-common.sh` `comfyui_lease_held`; `src/gpu-guard.js` `comfyuiLeaseHeld`, `ForgePauseError`, `yieldForgeToPipeline`; `src/local-client.js:266` | lanes yield their ticks; a model call that would START under a fresh lease is refused |
| Pipeline start | `scripts/launch.sh:27-43` | deletes the lease, calls `/api/gpu/yield` on the URL from `gpu_broker_url` (`AGENT_MANAGER_GPU_BROKER_URL`, G3a) |
| Lane arbitration (NOT part of this) | `src/gpu-arbiter.js`, `scripts/gpu-arbiter-cli.js`, `src/gpu-vram.js` | priority/ticket arbitration among Ollama callers. Stays in core: it arbitrates the pipeline's own lanes, not pipeline vs Forge |

## 2. Target shape

A new repo `agent-manager-gpu-broker` (name open, section 4), a plugin on its own port, Python/Flask like the forges. It owns:
- the lease (writes `comfyui-lease.json`, same path and schema, so core's reader needs no change at first);
- ComfyUI's lifecycle (start, warm, stop) and the cold-start wait;
- the Ollama eviction and in-flight-call wait;
- the handover itself as ONE call (`POST /api/gpu/handover {to: "forge"|"pipeline"}`): the part done by hand today;
- the same `/api/gpu/{status,acquire,heartbeat,release,yield}` API, byte-compatible, so PromptForge, VideoForge and core keep working
  unchanged until each is repointed.

**[2026-10-22]** `POST /api/gpu/acquire` is already synchronous: it returns only after the in-flight calls are waited out, the models are evicted, ComfyUI answers and the RAM check passes (`gpu_session.begin`, route `server/app.py:139-147`), or answers 503. The `to: forge` half of the handover therefore exists; what is missing is pausing and resuming the pipeline's lanes.

Core keeps: the lane arbiter, the lease READER (`comfyui_lease_held`, `ForgePauseError`), and a thin client that asks the broker to yield.
Forges keep: only a client (`acquire` before touching ComfyUI directly, `heartbeat`, `release`). PromptForge's `/api/gpu/*` routes become
a thin proxy to the broker for one release, then go.

## 3. Pieces (interface first; each independently shippable, live pipeline keeps working after every one)

| # | Piece | Files | Test | Rollback | Needs |
|---|---|---|---|---|---|
| G0 | Scaffold the broker repo + plugin registration; empty `/api/gpu/status`; free port chosen (**7449**: 7445-7448 are in use or reserved and 7450 is the grimm session agent); docs stub | new repo, `plugins.json` entry | broker boots, status 200, dashboard shows tab or card | remove registration | decision 1, 2 (taken, section 4) |
| G1 | Move the session core into the broker unchanged: `gpu_session.py` **plus the process, lease and Ollama half of `comfy_proc.py`** (config, probes and eviction, spawn and stop, lease helpers, readiness, RAM) **and its three test files** (`tests/test_gpu_session.py`, `test_gpu_claim.py`, `test_foreign_lease.py`, 44 tests); same API, same lease path | broker repo; PromptForge `gpu_session.py` becomes an import-free proxy | the three PromptForge test files pass against the broker; old API shape identical | PromptForge keeps its copy until G2 lands | G0 |
| G2 | Repoint PromptForge jobs and VideoForge at the broker; delete VideoForge's copy and PromptForge's proxy. VideoForge: repoint the one URL constant `server/core/gpu.py:12` (covers all four calls; `web/app.js` needs nothing) and add the missing `release()` on job completion in `render.py::_run`. PromptForge: the `gpu_session` calls in `comfy.py` (`begin`, `touch`, `last_end_reason`) and the sessionless `/api/comfy/start` | `comfy.py`, `videoforge/server/core/gpu.py`, `render.py` | a PromptForge render and a VideoForge clip acquire through the broker; heartbeat and release observed in the broker status | env var points back at PromptForge | G1 |
| G3 | Repoint core. **G3a DONE 2026-10-22** (merged `a0c104dc`): `launch.sh` and `gpu-guard.js` resolve the yield URL in one place, `AGENT_MANAGER_GPU_BROKER_URL` then the old variables then `http://localhost:7430`, behaviour unchanged. **G3b** (open): flip that default to the broker once G2 lands. Lease reader unchanged | `scripts/launch.sh`, `src/gpu-guard.js`, tests | `gpu-guard.test.js` + `forge-pause-callers.test.js` green; launch.sh yield hits the broker | env var back to PromptForge URL | G1 |
| G4a | **DONE 2026-10-22** (PromptForge `c67b380`): card-scoped lease. Both PromptForge lease writers add `endpoints` (default the local Ollama, `FORGE_LEASE_ENDPOINTS` overrides, `all` = old unscoped), so a Forge render pauses only the 3090 lane and the P40 and RX 580 lanes keep running. Takes effect at the next PromptForge start | PromptForge `comfy_proc.py`, `gpu_session.py`, protocol doc | 57 PromptForge tests; real `leaseHeldFor` check | `FORGE_LEASE_ENDPOINTS=all` | none |
| G4 | The handover as one call. **[2026-10-22]** Smaller than first written: `acquire` already blocks until ComfyUI answers (section 2), so `to: forge` is mostly `begin()`; what is still missing is pausing and resuming the lanes, a drain-status endpoint (in-flight calls from `.model-locks` and the arbiter) and a hard Ollama eviction (`KEEP_ALIVE` defaults to 30m, `src/local-client.js:173`). Original text: `to: forge`: pause the pipeline's lanes, wait for in-flight calls, evict every model, start and warm ComfyUI (acquire only returns when :8188 answers, so no client sees the 120 s error). `to: pipeline`: release, stop ComfyUI, restart the pipeline lanes. Closes #1813 (the lease is written BEFORE the pipeline pause, so no worker slips a reload in) | broker; core exposes a pipeline pause/resume the broker calls over the dashboard API | simulated: lease first, worker tick sees it; cold ComfyUI acquire returns ready; handover back restores workers | feature flag, off by default | G1, G3, decision 3 |
| G5 | **RETIRED 2026-10-22, archived.** Both parts were already true: plugin servers survive a pipeline stop (`scripts/stop.sh` honours `--keep-plugins`, pinned by `python/dashboard/test_stop_pipeline_keeps_plugins.py`), and a plugin registration already passes environment (`process.env`, `plugin_process_manager.py`), while the live PromptForge reads CharacterForge through its sibling-checkout fallback | n/a | n/a | n/a | none |
| G6 | Phone control: a Forge-mode switch in the dashboard (one tap: forge / pipeline, shows who holds the card) calling `handover` | dashboard tab script | verified in a real browser, narrow viewport | hide the control | G4 |
| G7 | Docs: `GPU_FAMILY_PROTOCOL.md` moves to the broker repo; this map becomes a pointer; playbook table row updated; `codebase-map.md` row | docs | links resolve | n/a | G1-G4 |

G0 to G3 are mechanical. G4 is the one with new behaviour and the only one that needs a design decision (3). **[2026-10-22]** G3a and G4a are done; the rest waits on G0.

## 4. Decisions only a human can make (each with a recommended default)

1. **Name and port.** Recommended: repo `agent-manager-gpu-broker`, plugin name `gpu-broker`, port **7449** (the 2026-10-15 text said "next free after StageForge's 7444"; 7445-7448 are now in use or reserved).
2. **Where it is registered.** Recommended: a plain plugin in `plugins.json` like the forges, not a dashboard tab at first (G6 adds the control).
3. **Does the broker own pipeline start/stop, or only the lease?** Recommended: lease and ComfyUI only until G4 proves out; pipeline pause/resume
   stays a core API the broker calls. Revisit after G4.
4. **Does the lease file move?** Recommended: no, same path and schema, so core's reader and the shell helper are untouched.
5. **Does ComfyUI belong to the broker or stay a PromptForge child?** Recommended: broker owns its lifecycle (it is the thing that decides when it
   is up); PromptForge's launcher keeps only job submission.

**[2026-10-22] Decided:** the owner took the recommended defaults for decisions 1 to 5 ("Do it", 2026-10-22). The repo stays local with no remote until the owner says otherwise.

## 5. Open questions for the verification pass (playbook step 2)

- ~~Does anything besides PromptForge and VideoForge call `/api/gpu/*`?~~ Answered 2026-10-15 (repo-wide grep): only PromptForge (`server/app.py`, `server/core/comfy.py`), VideoForge (`server/app.py`, `server/core/gpu.py`, **`web/app.js`**, which G2 must also repoint) and core (`scripts/launch.sh`, `src/gpu-guard.js`). StoryForge, SceneForge and CharacterForge go through PromptForge jobs.
- ~~Is `instances/.model-locks` read anywhere else, or only by the session core?~~ Answered 2026-10-22: written by `src/model-inflight-lock.js:37`; read by core only in `python/dashboard/chat_preempt.py` and by PromptForge's `gpu_session.inflight_pipeline_calls`. No other reader.
- ~~Does `gpu-guard.js`'s ComfyUI `/free` reclaim path stay (it does not need the broker) or move?~~ Answered 2026-10-22: it stays in core (`src/gpu-guard.js:213-217`, a plain `POST /free`); it also works for a ComfyUI the broker does not own.
- ~~What exactly does `POST /api/pipeline/stop` kill besides the lanes?~~ Answered 2026-10-22: every pidfile except `dashboard` and `plugin-*` (`scripts/stop.sh:121-127`, called with `--keep-dashboard --keep-plugins`). G5 had nothing left to change and is retired.
- ~~Is there a Windows or second-GPU case the broker's lease must stay per-device-aware for?~~ Answered 2026-10-22: yes. The pipeline has a P40 lane and an RX 580 lane on separate Ollama endpoints. The lease schema needs no device key: the optional `endpoints` array (core since `3a1b58eb`) is the mechanism, and G4a makes PromptForge use it.
- **New 2026-10-22:** PromptForge's `/api/comfy/start` (`server/app.py`) calls `comfy_proc.ensure_comfyui_ready()` with no session, so a manual start takes the lease only on the eviction path. Decide in G1 or G2 whether it goes through the broker.

Source evidence: the file list in section 1 was read on 2026-10-15 and re-verified on 2026-10-22 (the three `gpu-broker-verification-*.md` docs). Section 5 is
now fully answered. The PromptForge verification cites the `promptforge-manual` worktree; on PromptForge `master` the `comfy.py` line numbers are a few higher
(`begin` at 389, `last_end_reason` at 460, `touch` at 468) and the lease writers moved after G4a.
