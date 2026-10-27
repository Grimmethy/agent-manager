# GPU broker verification — core (map §1/5 vs core code)

Date: 2026-10-16 · Scope: `Docs/gpu-broker-extraction-map.md` section 1 ("what exists today") and section 5 (open questions),
verified line-by-line against this core checkout. Every row re-grepped on this date; tags: **CONFIRMED / WRONG / UNCONFIRMED**.

## Verification table

| # | Claim (map §1) | Verified path:line | Tag | Notes |
|---|---|---|---|---|
| 1 | Pipeline start deletes lease + yields Forge | scripts/launch.sh:31-42 | **CONFIRMED** | lease path :31, `rm -f` :33-34, `POST /api/gpu/yield` :42 (map says :27-43 — same block, comment starts :27) |
| 2 | `comfyui_lease_held` shell helper | scripts/agent-manager-common.sh:98 | **CONFIRMED** | def at :98, comment :97; TTL 90s / ceiling 900s read at :100-101 |
| 3 | Local worker yields its tick under lease | scripts/local-worker.sh:525 | **CONFIRMED** | `if comfyui_lease_held; then` |
| 4 | Review runner yields under lease | scripts/review-runner.sh:91 | **CONFIRMED** | `if comfyui_lease_held; then` (comment :89) |
| 5 | JS lease reader + ForgePauseError + yield | src/gpu-guard.js:54,77,101 | **CONFIRMED** | `comfyuiLeaseHeld` :54, `class ForgePauseError` :77, `yieldForgeToPipeline` :101 (exports :194) |
| 6 | Model call refused under fresh lease | src/local-client.js:266 | **CONFIRMED** | **map cites :264 — actual check is :266** (`ForgePauseError` throw); :264-265 are its comment |
| 7 | Stop route reaches stop.sh with keep flags | python/dashboard/routes/pipeline_1_more.py:69-74 | **CONFIRMED** | map says :68; actual: route :69, `_stop_pipeline` import :71, call :74 (file lives under `routes/`) |
| 8 | `_stop_pipeline` passes --keep-dashboard --keep-plugins | python/dashboard/app.py:2549,2603 | **CONFIRMED** | def :2549; args at :2603 on BOTH graceful (Popen) and force (run) paths |
| 9 | stop.sh skips `plugin-*.pid` | scripts/stop.sh:125 | **CONFIRMED** | `if [[ "$name" == plugin-* && "$KEEP_PLUGINS" == true ]]` :125-127 |
| 10 | G5: "stop kills the Forge plugins today" | map §1/G5 vs python/dashboard/test_stop_pipeline_keeps_plugins.py | **WRONG** | stale as of 2026-10-14: `stop.sh` now receives `--keep-plugins`; regression test asserts it on both paths — see `python/dashboard/test_stop_pipeline_keeps_plugins.py` |
| 11 | ComfyUI `/free` reclaim path | src/gpu-guard.js:214-217 | **CONFIRMED** | `POST /free {unload_models, free_memory}` at :213-217; self-contained in gpu-guard.js — no broker needed to keep it |
| 12 | `.model-locks` writer | src/model-inflight-lock.js:37 | **CONFIRMED** | `locksDir()` :36-38; `acquire()` writes `{model, instanceId, pid, startedAt}` json files (5-min stale ceiling :6) |
| 13 | `.model-locks` reader (core) | python/dashboard/chat_preempt.py:164-168,265,394 | **CONFIRMED** | reader fn :164-168; directory listings :265-266 and :394-396 |
| 14 | `/api/gpu` callers in core | scripts/launch.sh:42; src/gpu-guard.js:105 | **CONFIRMED** | repo-wide grep of `scripts/`+`src/` finds only these two call sites (gpu-guard.js:106 is an error-message string) |
| 15 | Pause/resume (G4 prerequisite) | python/dashboard/app.py:2731-2760 | **UNCONFIRMED** | resume side exists — `_launch_pipeline_subprocess` calls `_acquire_gpu_lease()` before spawning; MISSING: a drain-status endpoint (in-flight calls from `.model-locks`/gpu-arbiter) and a real Ollama eviction — `KEEP_ALIVE` defaults to `30m` (src/local-client.js:173), so evicted models re-load for up to 30 min |

## Section-5 questions (answers)

The map's fifth bullet was already answered in-line (2026-10-15); the four open ones:

1. **Is `instances/.model-locks` read anywhere else, or only by the session core?** — No. Repo-wide grep finds only the writer
   (`src/model-inflight-lock.js:37`) and the core reader `python/dashboard/chat_preempt.py:164-168,265,394`
   (plus `src/gpu-arbiter.js:17` mentioning it in a comment). PromptForge's session core reads it inside its own repo, not here.
2. **Does `gpu-guard.js`'s `/free` reclaim path stay or move?** — Stay. It is self-contained (`src/gpu-guard.js:213-217`,
   plain `POST /free`, no broker API) and works for a standalone ComfyUI the broker doesn't own. Moving it into the broker would
   only add a failure point for the common standalone case.
3. **What does `POST /api/pipeline/stop` kill besides the lanes, so G5 changes the right thing?** — It shells out to
   `scripts/stop.sh` with `--keep-dashboard --keep-plugins` (app.py:2603), which SIGTERM/SIGKILLs every remaining pidfile in the
   pids folder EXCEPT `dashboard` and `plugin-*` (stop.sh:121-127). So since the 2026-10-14 fix, plugin servers SURVIVE a stop —
   G5's remaining work is only the PromptForge `CHARACTERFORGE_ROOT` env registration, not the kill list.
4. **Is there a Windows / second-GPU (P40) case the lease must stay per-device-aware for?** — Yes. The P40 lane runs against a
   separate Ollama endpoint (`src/local-client.js:146-147`, `IS_P40_ENDPOINT`) and Windows uses `launch.bat` / taskkill paths
   (`python/dashboard/app.py:2551-2558`). The lease file is a single JSON (`comfyui-lease.json`) with no device field — if a
   second card is ever enabled, the broker's lease schema needs a per-device key (decision 4 in the map assumes one GPU).

## Summary

- 14 **CONFIRMED**, 1 **WRONG** (G5 "stop kills plugins today" — fixed 2026-10-14, guarded by
  `python/dashboard/test_stop_pipeline_keeps_plugins.py`), 1 **UNCONFIRMED** (G4 pause/resume drain endpoint + Ollama eviction).
- Two map citations corrected: local-client.js :264 → **:266**; stop route pipeline_1_more.py :68 → **routes/pipeline_1_more.py:69-74**.
- The only real gap for G4 is the drain-status endpoint and a hard Ollama eviction (KEEP_ALIVE is 30m, src/local-client.js:173);
  everything else in section 1 checks out against core.
