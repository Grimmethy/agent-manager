# GPU-broker extraction map — VideoForge verification

Date: 2026-10-16 · Playbook step 2 (read-only verification pass)
Map: `Docs/gpu-broker-extraction-map.md` (PR #561) — sections 1, 3 (G2), 5.
Code read (unmodified): `/media/model-cache/github/videoforge` — `server/core/gpu.py`, `server/app.py`,
`server/core/render.py`, `web/app.js`. All four files exist at those paths.

## Per-claim findings

| # | Map claim (short quote) | Verdict | Evidence (path:line) | Correction (if WRONG) |
|---|---|---|---|---|
| 1 | §1: "VideoForge client … `videoforge/server/core/gpu.py` (45 lines), `server/app.py`, `server/core/render.py` — acquire/heartbeat/release over HTTP to PromptForge" | CONFIRMED | `server/core/gpu.py:12,35-37,40-41,44-45`; `wc -l server/core/gpu.py` → 45 | — |
| 2 | §1 (echoing `gpu.py`'s own docstring): VideoForge "release[s] when the batch is done (that stops ComfyUI and gives the card back to the pipeline)" | WRONG | `server/core/render.py:71,85` (only acquire + heartbeat are called); grep `release(` across `server/` and `web/` finds only the definition at `server/core/gpu.py:44-45` — no call site | "VideoForge defines `release()` (`server/core/gpu.py:44-45`) but never calls it; the session is kept alive by 30-s heartbeats (`server/core/render.py:78-86`) and the card is returned by lease TTL, not by an explicit release" |
| 3 | §1: client spans "`server/app.py`, `server/core/render.py`" (i.e. GPU-endpoint calls beyond `gpu.py`) | CONFIRMED | `server/app.py:142` (GETs `gpu.PF_URL + "/api/gpu/status"` inside the `/api/gpu` route, `server/app.py:136-148`); `server/core/render.py:9,71,85` (via the `gpu` module) | — |
| 4 | §3 G2: repoint "videoforge/server/core/gpu.py, render.py, app.py" | CONFIRMED | `server/core/gpu.py:12` is the single URL constant (`PROMPTFORGE_URL`, default `http://localhost:7430`); `server/app.py:142` reads `gpu.PF_URL`, so one repoint covers all four VideoForge endpoint calls | — |
| 5 | §5 Q1 (answered in map): "VideoForge (`server/app.py`, `server/core/gpu.py`, **`web/app.js`**, which G2 must also repoint)" | WRONG (web/app.js part) | `web/app.js:164` polls the same-origin `/api/gpu` (route `server/app.py:136-148`); grep `7430\|promptforge\|PROMPTFORGE` in `web/` → zero hits | "web/app.js never calls PromptForge or `/api/gpu/*` directly; it polls the same-origin `/api/gpu` (`web/app.js:164`), which `server/app.py:136-148` proxies to `gpu.PF_URL/api/gpu/status`. G2 must repoint the server-side proxy (`server/core/gpu.py:12`), not web/app.js" |
| 6 | Task question: does the web page call PromptForge directly from the browser (CORS/URL)? | ANSWERED: NO cross-origin call exists | `web/app.js:5-15` — single `api()` helper, every fetch is a relative path (`web/app.js:9`); the page is served by VideoForge itself (`server/app.py:25`, `VIDEOFORGE_PORT` default 7438) and embedded as an `<iframe>` | — |

The other §5 open questions (`.model-locks` readers, `gpu-guard.js`'s ComfyUI `/free` reclaim,
`POST /api/pipeline/stop` scope, Windows/second-GPU) are core/PromptForge areas, not VideoForge.

## §5 open questions (VideoForge scope)

- Q: Which VideoForge files call `/api/gpu/*`? — A: `server/core/gpu.py` (acquire `gpu.py:37`, heartbeat `gpu.py:41`,
  release `gpu.py:45` — the last defined but never invoked, row 2) and `server/app.py:142` (status). `render.py` calls
  only through the `gpu` module (`render.py:71,85`). `web/app.js` never touches the endpoints (row 5).
- Q: Does G2 owe VideoForge any CORS work? — A: No. Every browser request is a same-origin relative fetch
  (`web/app.js:9,164`); there is no cross-origin request from the page, so no `Access-Control-Allow-Origin`
  handling and no browser-side URL change are needed. The only repoint is the server-side `PF_URL` (row 4).

## G2 change summary (VideoForge)

- Repoint the single URL constant `PF_URL` (`server/core/gpu.py:12`; env `PROMPTFORGE_URL`, default
  `http://localhost:7430`) at the broker URL — this covers all four VideoForge endpoint calls
  (`gpu.py:37,41,45` and `server/app.py:142`).
- If G2 deletes VideoForge's client copy (`gpu.py`), re-point `server/core/render.py:9` (import) and the call
  sites `render.py:71` (acquire) and `render.py:85-86` (heartbeat, `GpuError` catch) to the broker client;
  grep `gpu\.` shows no other importer of `core.gpu` in `server/` or `web/`.
- Behaviour gap G2 should close: add an explicit `release()` on job completion in `server/core/render.py::_run`
  (today the card is only returned by lease TTL — row 2).
- `web/app.js`: no code change required (rows 5-6); its GPU badge keeps working unchanged against the
  re-pointed `/api/gpu` proxy.
- No CORS/URL changes anywhere in VideoForge.
