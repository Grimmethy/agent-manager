# GPU broker: shape and extraction map

Status: map (read-only code pass, not yet verified by a second pass) · Written 2026-10-15 from `master` at `6db5a58a` (core), PromptForge `3ca798a`,
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

## 1. What exists today

| Piece | Where | What it does |
|---|---|---|
| Forge GPU session | `promptforge-manual/server/core/gpu_session.py` (345 lines) | `begin/touch/end/yield_to_pipeline`, a keeper thread (20 s tick), lease file write, ComfyUI listener lookup + stop, in-flight pipeline-call detection (`instances/.model-locks`), host RAM check |
| Session HTTP API | `promptforge-manual/server/app.py:134-165` | `/api/gpu/status`, `acquire`, `heartbeat`, `release`, `yield` on `:7430` |
| Protocol doc | `promptforge-manual/Docs/GPU_FAMILY_PROTOCOL.md` | the contract above, tunables `FORGE_SESSION_*` |
| Auto session per job | `promptforge-manual/server/core/comfy.py` | a PromptForge job begins a session itself; this is where the 120 s ComfyUI wait lives |
| VideoForge client | `videoforge/server/core/gpu.py` (45 lines), `server/app.py`, `server/core/render.py` | acquire/heartbeat/release over HTTP to PromptForge |
| Lease file | `~/.local/state/agent-manager/comfyui-lease.json` | present + fresh (TTL 90 s, ceiling 900 s on the pipeline side) = Forge holds the card |
| Pipeline-side lease read | `scripts/agent-manager-common.sh` `comfyui_lease_held`; `src/gpu-guard.js` `comfyuiLeaseHeld`, `ForgePauseError`, `yieldForgeToPipeline`; `src/local-client.js:264` | lanes yield their ticks; a model call that would START under a fresh lease is refused |
| Pipeline start | `scripts/launch.sh:27-43` | deletes the lease, calls `/api/gpu/yield` on PromptForge |
| Lane arbitration (NOT part of this) | `src/gpu-arbiter.js`, `scripts/gpu-arbiter-cli.js`, `src/gpu-vram.js` | priority/ticket arbitration among Ollama callers. Stays in core: it arbitrates the pipeline's own lanes, not pipeline vs Forge |

## 2. Target shape

A new repo `agent-manager-gpu-broker` (name open, section 4), a plugin on its own port, Python/Flask like the forges. It owns:
- the lease (writes `comfyui-lease.json`, same path and schema, so core's reader needs no change at first);
- ComfyUI's lifecycle (start, warm, stop) and the cold-start wait;
- the Ollama eviction and in-flight-call wait;
- the handover itself as ONE call (`POST /api/gpu/handover {to: "forge"|"pipeline"}`): the part done by hand today;
- the same `/api/gpu/{status,acquire,heartbeat,release,yield}` API, byte-compatible, so PromptForge, VideoForge and core keep working
  unchanged until each is repointed.

Core keeps: the lane arbiter, the lease READER (`comfyui_lease_held`, `ForgePauseError`), and a thin client that asks the broker to yield.
Forges keep: only a client (`acquire` before touching ComfyUI directly, `heartbeat`, `release`). PromptForge's `/api/gpu/*` routes become
a thin proxy to the broker for one release, then go.

## 3. Pieces (interface first; each independently shippable, live pipeline keeps working after every one)

| # | Piece | Files | Test | Rollback | Needs |
|---|---|---|---|---|---|
| G0 | Scaffold the broker repo + plugin registration; empty `/api/gpu/status`; free port chosen; docs stub | new repo, `plugins.json` entry | broker boots, status 200, dashboard shows tab or card | remove registration | decision 1, 2 |
| G1 | Move the session core into the broker unchanged: `gpu_session.py` and its tests; same API, same lease path | broker repo; PromptForge `gpu_session.py` becomes an import-free proxy | the existing `tests/test_gpu_session.py` passes against the broker; old API shape identical | PromptForge keeps its copy until G2 lands | G0 |
| G2 | Repoint PromptForge jobs and VideoForge at the broker; delete VideoForge's copy and PromptForge's proxy | `comfy.py`, `videoforge/server/core/gpu.py`, `render.py`, `app.py` | a PromptForge render and a VideoForge clip acquire through the broker; heartbeat and release observed in the broker status | env var points back at PromptForge | G1 |
| G3 | Repoint core: `launch.sh` yield call and `gpu-guard.js` `yieldForgeToPipeline` use `AGENT_MANAGER_GPU_BROKER_URL` (default the broker); lease reader unchanged | `scripts/launch.sh`, `src/gpu-guard.js`, tests | `gpu-guard.test.js` + `forge-pause-callers.test.js` green; launch.sh yield hits the broker | env var back to PromptForge URL | G1 |
| G4 | The handover as one call. `to: forge`: pause the pipeline's lanes, wait for in-flight calls, evict every model, start and warm ComfyUI (acquire only returns when :8188 answers, so no client sees the 120 s error). `to: pipeline`: release, stop ComfyUI, restart the pipeline lanes. Closes #1813 (the lease is written BEFORE the pipeline pause, so no worker slips a reload in) | broker; core exposes a pipeline pause/resume the broker calls over the dashboard API | simulated: lease first, worker tick sees it; cold ComfyUI acquire returns ready; handover back restores workers | feature flag, off by default | G1, G3, decision 3 |
| G5 | Plugin servers survive a pipeline stop (the known bug: stop kills the Forge plugins today) and the live PromptForge gets the environment a throwaway had (`CHARACTERFORGE_ROOT`) from the plugin registration, not a hand-built process | core `pipeline/stop` route, `plugins.json` env, PromptForge launcher | stop then start leaves the four forge plugin servers up; live PromptForge resolves character text | revert | none |
| G6 | Phone control: a Forge-mode switch in the dashboard (one tap: forge / pipeline, shows who holds the card) calling `handover` | dashboard tab script | verified in a real browser, narrow viewport | hide the control | G4 |
| G7 | Docs: `GPU_FAMILY_PROTOCOL.md` moves to the broker repo; this map becomes a pointer; playbook table row updated; `codebase-map.md` row | docs | links resolve | n/a | G1-G4 |

G5 has no dependency on the broker and can start at once. G0 to G3 are mechanical. G4 is the one with new behaviour and the only one that
needs a design decision (3).

## 4. Decisions only a human can make (each with a recommended default)

1. **Name and port.** Recommended: repo `agent-manager-gpu-broker`, plugin name `gpu-broker`, next free port after StageForge's 7444.
2. **Where it is registered.** Recommended: a plain plugin in `plugins.json` like the forges, not a dashboard tab at first (G6 adds the control).
3. **Does the broker own pipeline start/stop, or only the lease?** Recommended: lease and ComfyUI only until G4 proves out; pipeline pause/resume
   stays a core API the broker calls. Revisit after G4.
4. **Does the lease file move?** Recommended: no, same path and schema, so core's reader and the shell helper are untouched.
5. **Does ComfyUI belong to the broker or stay a PromptForge child?** Recommended: broker owns its lifecycle (it is the thing that decides when it
   is up); PromptForge's launcher keeps only job submission.

## 5. Open questions for the verification pass (playbook step 2)

- ~~Does anything besides PromptForge and VideoForge call `/api/gpu/*`?~~ Answered 2026-10-15 (repo-wide grep): only PromptForge (`server/app.py`, `server/core/comfy.py`), VideoForge (`server/app.py`, `server/core/gpu.py`, **`web/app.js`**, which G2 must also repoint) and core (`scripts/launch.sh`, `src/gpu-guard.js`). StoryForge, SceneForge and CharacterForge go through PromptForge jobs.
- Is `instances/.model-locks` read anywhere else, or only by the session core?
- Does `gpu-guard.js`'s ComfyUI `/free` reclaim path stay (it does not need the broker) or move?
- What exactly does `POST /api/pipeline/stop` kill besides the lanes, so G5 changes the right thing?
- Is there a Windows or second-GPU case (the P40 lane is disabled today) the broker's lease must stay per-device-aware for?

Source evidence: the file list in section 1 was read on 2026-10-15; line counts and routes are from that read. Section 5 is the checklist for the
second pass; do not start G4 before it is answered.
