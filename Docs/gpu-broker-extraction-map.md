# GPU broker: shape and extraction map

> **Pointer (2026-10-23, G7c).** The broker is built and live. Its own docs are the current reference: **`agent-manager-gpu-broker`** (repo,
> `/media/model-cache/github/agent-manager-gpu-broker`) has `Docs/GPU_FAMILY_PROTOCOL.md` (the contract: sessions, cards, preferences, the lease, the
> API), `README.md` (routes, cards, preferences, every configuration variable) and `Docs/BACKLOG.md` (what is left). This file is the extraction
> **record**: why it was done, the decisions, what was built when (section 3) and what the build taught us (section 6). Sections 1 and 2 describe the
> code **before** the extraction (as read on 2026-10-15/22) and are kept as history, not as a description of today.

Status: **built and live as of 2026-10-23 (G7a/b/c done; G3b and G4 open or probably retired, see section 3)**. Originally a map, **verified 2026-10-22** by three read-only passes (`Docs/gpu-broker-verification-core.md`, `-videoforge.md`, `-promptforge.md`); corrections are folded in below and marked **[2026-10-22]** · Written 2026-10-15 from `master` at `6db5a58a` (core), PromptForge `3ca798a`,
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

## 1. What existed before the extraction (as of 2026-10-22)

*History. Where each piece lives now is in section 3 and in the broker repo's README.*

| Piece | Where | What it does |
|---|---|---|
| Forge GPU session | `promptforge-manual/server/core/gpu_session.py` (389 lines on 2026-10-22; the map said 345) | `begin/touch/end/yield_to_pipeline`, a keeper thread (20 s tick), lease file write, ComfyUI listener lookup + stop, in-flight pipeline-call detection (`instances/.model-locks`), host RAM check |
| ComfyUI process, Ollama eviction, lease helpers | `promptforge-manual/server/core/comfy_proc.py` (601 lines) | imported by `gpu_session.py`: `COMFY_URL`, `COMFY_LEASE_PATH`, `comfy_up`, `ollama_models_on_gpu`, `evict_ollama_models`, `ensure_comfyui_ready`, `gpu_inventory`, `mem_available_mb`, `foreign_lease`, `lease_release`, `stop_comfyui`. **[2026-10-22]** The map omitted it; it has to move with G1 |
| Session HTTP API | `promptforge-manual/server/app.py:134-165` | `/api/gpu/status`, `acquire`, `heartbeat`, `release`, `yield` on `:7430` |
| Protocol doc | `promptforge-manual/Docs/GPU_FAMILY_PROTOCOL.md` (**moved 2026-10-23 to the broker repo's `Docs/GPU_FAMILY_PROTOCOL.md`; PromptForge's copy is now a pointer**) | the contract above; tunables `FORGE_SESSION_IDLE_S`, `FORGE_SESSION_MAX_S`, `FORGE_KEEPER_TICK_S`, `FORGE_LOCK_WAIT_S`, `FORGE_EVICT_WAIT_S`, `FORGE_START_WAIT_S`, and since G4a `FORGE_LEASE_ENDPOINTS` (only two of them start with `FORGE_SESSION_`) |
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

## 3. Pieces and where they stand (interface first; each was independently shippable, the live pipeline kept working after every one)

**State as of 2026-10-23:** G0, G1, G2, G3a, G4a, G5 (retired), G6 (rebuilt as the card page), G7 and G8 are done; G3b is optional and open; G4 is probably retired. Commits below are merge commits on each repo's main branch.

| # | Piece | Files | Test | Rollback | Needs |
|---|---|---|---|---|---|
| G0 | **DONE** (broker `ffc8946`): scaffold the broker repo + plugin registration; port **7449** (7445-7448 in use or reserved, 7450 is the grimm session agent); the repo is private on GitHub (owner-approved) | new repo, `plugins.json` entry `gpu-broker` | broker boots, status 200 | remove registration | decisions 1, 2 (taken, section 4) |
| G1 | **DONE** (broker `3081330`, the last of five pieces): the session core moved into the broker (`server/core/gpu_session.py`, `server/core/comfy_proc.py`) with its tests, same five `/api/gpu` routes, same lease path | broker repo | the PromptForge session tests pass against the broker (now 121 broker tests, sandboxed) | PromptForge kept its copy until G2 | G0 |
| G2 | **DONE.** Broker `1c2adf4` (G2a: `acquire_steps` in `/api/gpu/status` so a blocked client shows progress); PromptForge `3cd9d52` (broker client `server/core/gpu_client.py`, heartbeat thread, proxy routes, `GPU_BROKER_URL`, cutover docs); VideoForge `2b2340d` (`GPU_BROKER_URL` precedence and the card released after the queue idles). **Cutover live 2026-10-22/23** (owner-approved): PromptForge and VideoForge run in broker mode; first live test: cold ComfyUI 228 s with steps streamed, the lease scoped to the 3090 endpoint so the P40 and RX 580 lanes kept running, release 25 s. PromptForge keeps an in-process fallback when `GPU_BROKER_URL` is unset | `comfy.py`, `gpu_client.py`, `videoforge/server/core/gpu.py`, `render.py` | acquire, heartbeat and release observed in the broker status | remove `GPU_BROKER_URL` and restart | G1 |
| G3 | **G3a DONE** (core `a0c104dc`): `launch.sh` and `gpu-guard.js` resolve the yield URL in one place, `AGENT_MANAGER_GPU_BROKER_URL` then the old variables then `http://localhost:7430`, behaviour unchanged. **Tool-loop fix DONE** (core `37411512`, found by the first live broker test): tool-loop turns ignored the lease and reloaded a model the Forge had just evicted; `chatTurnWithFlakeRecovery` in `src/local-tool-client.js` now checks `leaseHeldFor` before every turn (not for the Chat panel, see G8). **G3b open and optional:** flip the default yield URL to the broker; PromptForge's proxy already makes the old URL work. One shared URL resolver is filed as a premium task | `scripts/launch.sh`, `src/gpu-guard.js`, `src/local-tool-client.js`, tests | `gpu-guard.test.js`, `local-tool-client-forge-pause.test.js` | env var back to PromptForge URL | G1 |
| G4a | **DONE** (PromptForge `c67b380`): card-scoped lease. The lease carries `endpoints` (default the local Ollama, `FORGE_LEASE_ENDPOINTS` overrides, `all` = old unscoped), so a Forge render pauses only the lane on that card. Since G8 the broker scopes the lease to the card it holds | PromptForge and broker `comfy_proc.py`, `gpu_session.py` | real `leaseHeldFor` check | `FORGE_LEASE_ENDPOINTS=all` | none |
| G4 | **PROBABLY RETIRED (not built).** `acquire` already blocks until ComfyUI answers and the lease, the in-flight wait and the eviction already do the job; retire unless a real gap shows (broker backlog says the same). The handover as one call. **[2026-10-22]** Smaller than first written: `acquire` already blocks until ComfyUI answers (section 2), so `to: forge` is mostly `begin()`; what is still missing is pausing and resuming the lanes, a drain-status endpoint (in-flight calls from `.model-locks` and the arbiter) and a hard Ollama eviction (`KEEP_ALIVE` defaults to 30m, `src/local-client.js:173`). Original text: `to: forge`: pause the pipeline's lanes, wait for in-flight calls, evict every model, start and warm ComfyUI (acquire only returns when :8188 answers, so no client sees the 120 s error). `to: pipeline`: release, stop ComfyUI, restart the pipeline lanes. Closes #1813 (the lease is written BEFORE the pipeline pause, so no worker slips a reload in) | broker; core exposes a pipeline pause/resume the broker calls over the dashboard API | simulated: lease first, worker tick sees it; cold ComfyUI acquire returns ready; handover back restores workers | feature flag, off by default | G1, G3, decision 3 |
| G5 | **RETIRED 2026-10-22, archived.** Both parts were already true: plugin servers survive a pipeline stop (`scripts/stop.sh` honours `--keep-plugins`, pinned by `python/dashboard/test_stop_pipeline_keeps_plugins.py`), and a plugin registration already passes environment (`process.env`, `plugin_process_manager.py`), while the live PromptForge reads CharacterForge through its sibling-checkout fallback | n/a | n/a | n/a | none |
| G6 | **DONE, built differently** (broker `884141f` page, `e28af9b` tab): not the Forge/pipeline mode switch written here (no `handover` exists; G4 is not built) but the **card page**: which GPU holds what, and the two owner preferences, phone-sized. The broker serves it at `GET /`; the dashboard tab **GPU Cards** (group Forges, script `ui/gpu-broker-tab.js` in the broker repo) embeds it. The tab entry lives in the host-local, gitignored `plugins.json`; a premium task documents restoring it after a rebuild. Checked in a real browser (narrow layout) | broker `server/static/cards.html`, `ui/gpu-broker-tab.js` | rendered, saved a preference, showed a held card | remove the tab entry | G8 |
| G7 | **DONE.** G7a (broker `879e45c`): `GPU_FAMILY_PROTOCOL.md` now lives in the broker repo, rewritten for the broker as owner, with tests that keep it in step with the routes. G7b (PromptForge `9e3abff`): PromptForge's copy is a short pointer. G7c (this change): this map is headed by a pointer to the broker docs and keeps its history; the codebase map and playbook have rows | docs in three repos | link and drift tests | n/a | G1-G4 |
| G8 | **DONE** (owner direction 2026-10-22/23: the Forge is not tied to one GPU and chat keeps working on another). Broker: card registry and per-card acquire `fe8bc0e` (G8a), owner preferences `8a10a1a` (G8c, `forgeCard` and `chatCard`), card page `884141f`, tab `e28af9b`. PromptForge: a job may name its card, `d730362`. Core: Chat picks a card per message (`src/chat-card.js`, `python/dashboard/chat_card.py`, merged as `54649e21`): it moves to a free card with a visible note when the Forge holds its card and a manual pick always works; preempt follows the card (`b7544f72`); Chat reads the `chatCard` preference (`0da690e8`; `GPU_BROKER_URL`, then `AGENT_MANAGER_GPU_BROKER_URL`, else `http://localhost:7449`, fails open). Decisions: plumbing first, the 3090 stays the only Forge-capable card (`canHost` = forge and local); ask before downloading anything for another card | broker `server/cards.py`, `server/preferences.py`; `src/chat-card.js` | 121 broker tests, 95 PromptForge tests, chat-card node tests; live round trip of `chatCard` through the chat CLI | clear the preferences | G1, G2 |

G0 to G3 were mechanical. G4 was the one piece with new behaviour and a design decision (3); it was overtaken by G8 and is probably retired. **[2026-10-23]** Everything except G3b (optional) and G4 (probably retired) is done.

## 4. Decisions only a human can make (each with a recommended default)

1. **Name and port.** Recommended: repo `agent-manager-gpu-broker`, plugin name `gpu-broker`, port **7449** (the 2026-10-15 text said "next free after StageForge's 7444"; 7445-7448 are now in use or reserved).
2. **Where it is registered.** Recommended: a plain plugin in `plugins.json` like the forges, not a dashboard tab at first (G6 adds the control).
3. **Does the broker own pipeline start/stop, or only the lease?** Recommended: lease and ComfyUI only until G4 proves out; pipeline pause/resume
   stays a core API the broker calls. Revisit after G4.
4. **Does the lease file move?** Recommended: no, same path and schema, so core's reader and the shell helper are untouched.
5. **Does ComfyUI belong to the broker or stay a PromptForge child?** Recommended: broker owns its lifecycle (it is the thing that decides when it
   is up); PromptForge's launcher keeps only job submission.

**[2026-10-22] Decided:** the owner took the recommended defaults for decisions 1 to 5 ("Do it", 2026-10-22). **[2026-10-23]** The repo now has a private GitHub remote (owner-approved), as do the pip dependency (Flask) installs it needed.

## 5. Open questions for the verification pass (playbook step 2)

- ~~Does anything besides PromptForge and VideoForge call `/api/gpu/*`?~~ Answered 2026-10-15 (repo-wide grep): only PromptForge (`server/app.py`, `server/core/comfy.py`), VideoForge (`server/app.py`, `server/core/gpu.py`, **`web/app.js`**, which G2 must also repoint) and core (`scripts/launch.sh`, `src/gpu-guard.js`). StoryForge, SceneForge and CharacterForge go through PromptForge jobs.
- ~~Is `instances/.model-locks` read anywhere else, or only by the session core?~~ Answered 2026-10-22: written by `src/model-inflight-lock.js:37`; read by core only in `python/dashboard/chat_preempt.py` and by PromptForge's `gpu_session.inflight_pipeline_calls`. No other reader.
- ~~Does `gpu-guard.js`'s ComfyUI `/free` reclaim path stay (it does not need the broker) or move?~~ Answered 2026-10-22: it stays in core (`src/gpu-guard.js:213-217`, a plain `POST /free`); it also works for a ComfyUI the broker does not own.
- ~~What exactly does `POST /api/pipeline/stop` kill besides the lanes?~~ Answered 2026-10-22: every pidfile except `dashboard` and `plugin-*` (`scripts/stop.sh:121-127`, called with `--keep-dashboard --keep-plugins`). G5 had nothing left to change and is retired.
- ~~Is there a Windows or second-GPU case the broker's lease must stay per-device-aware for?~~ Answered 2026-10-22: yes. The pipeline has a P40 lane and an RX 580 lane on separate Ollama endpoints. The lease schema needs no device key: the optional `endpoints` array (core since `3a1b58eb`) is the mechanism, and G4a makes PromptForge use it.
- **New 2026-10-22:** PromptForge's `/api/comfy/start` (`server/app.py`) calls `comfy_proc.ensure_comfyui_ready()` with no session, so a manual start takes the lease only on the eviction path. Decide in G1 or G2 whether it goes through the broker.

## 6. Lessons from the build (2026-10-22/23)

- **Check the lease before every tool-loop turn, not only before a pass.** The first live broker test found a pass that was between two turns when the Forge took the card; it sent its next turn and reloaded the model. The fix is in `chatTurnWithFlakeRecovery`; the Chat panel is exempt unless a card was chosen for it (then `AGENT_MANAGER_CHAT_CARD_GUARD=1` makes a lease on that card pause the turn).
- **Card ids follow lane names** (`3090`, `p40`, `rx580`), and a card's Ollama URL is also the arbiter's lock key (`ollama-<host>-<port>`), so one registry entry lines the Forge, Chat, the lanes and the preempt up.
- **Test GPU code under a sandbox.** A mutated test once started a real ComfyUI and wrote a real lease next to the resident model. Every test of code that can reach `gpu_session.begin`, `ensure_comfyui_ready`, `evict_ollama_models` or the lease runs with the lease path, pid file and lock directory in a scratch directory, the URLs pointed at nothing, and dangerous calls raising by default.
- **After merges, sync the live checkouts and restart the plugin.** The running broker and PromptForge kept old code until restarted, one working copy was behind, and the dashboard's own sync refused over untracked backup files. Premium tasks cover the sync fix and a restart-needed hint.
- **A hub piece that needs another hub's unmerged branch fails in a confusing way.** HUB0008-03 needed `accounts.py` from HUB0006; it was reported as an infra error, and merging into master alone was not enough because stacked pieces build from their own hub branch tip. Premium tasks cover a clearer stop reason and an operator route for merging a held hub branch early.

## 7. Still open

- Chat panel card selector in the chat plugin (waits on the model-swap hub, HUB0008).
- G3b (optional) and G4 (probably retired); the shared broker-URL resolver task.
- Rename the lease holder `promptforge` and PromptForge's pid-file path; decide whether `/api/comfy/start` moves to the broker.
- ComfyUI on another machine (the P40 VM or grimm): needs a ComfyUI install there; ask before downloading.

Source evidence: the file list in section 1 was read on 2026-10-15 and re-verified on 2026-10-22 (the three `gpu-broker-verification-*.md` docs). Section 5 is
now fully answered. The PromptForge verification cites the `promptforge-manual` worktree; on PromptForge `master` the `comfy.py` line numbers are a few higher
(`begin` at 389, `last_end_reason` at 460, `touch` at 468) and the lease writers moved after G4a.
