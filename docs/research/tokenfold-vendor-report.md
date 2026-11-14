# TokenFold Vendor Report

**Date:** 2026-11-09
**Status:** Read-only investigation. No code or config changes.
**Deliverable:** This document.

## 1. What TokenFold Is

TokenFold is a **transparent token-compression reverse proxy** for LLM communication. It sits between Agent Manager's API callers (workers, reviewers, the dashboard) and the upstream model server (Ollama by default) and:

1. Collapses conversation history into a compact `HIST:` block (rolling digest).
2. Replaces repeated code fences / tool results with stable references.
3. Learns an alias dictionary (`FoldLang`) for recurring instructions.
4. Rewrites English to a terse form (~43% of natural-English token cost).
5. Picks the cheaper of "compressed" vs. "verbatim" per request.

The model never sees the compression; the decoder expands replies back to plain English locally. Measured steady-state context reduction is **81–87% raw, 85–91% cache-effective** for multi-turn agent sessions.

Source: `vendor/tokenfold/README.md`; implementation in `vendor/tokenfold/core/tokenfold/engine.py`, `vendor/tokenfold/core/tokenfold/cli.py`.

## 2. Metadata

| Field | Value | Source |
|---|---|---|
| Package name | `tokenfold` | `vendor/tokenfold/core/pyproject.toml` `[project] name` |
| Version | **0.1.0** | `vendor/tokenfold/core/pyproject.toml` `[project] version` |
| License | **MIT** (Copyright 2026 Vanilla Services) | `vendor/tokenfold/LICENSE` |
| Python requires | >= 3.11 | `vendor/tokenfold/core/pyproject.toml` |
| Runtime deps | `tiktoken`, `tokenizers`, `httpx`, `fastapi`, `uvicorn` | `vendor/tokenfold/core/pyproject.toml` `[project].dependencies` |
| CLI entry | `tokenfold = "tokenfold.cli:main"` | `vendor/tokenfold/core/pyproject.toml` `[project.scripts]` |
| Tracked files | 47 | `git ls-files vendor/tokenfold` |
| On-disk size | **50 MB** | `du -sh vendor/tokenfold` |
| Git-tracked Python package code | 196 KB | `du -sh vendor/tokenfold/core/tokenfold` |
| Git-tracked tokenizer assets | **50 MB** (5 JSON files) | `du -sh vendor/tokenfold/core/assets/tokenizers` |

Breakdown of the 50 MB tokenizer assets (`vendor/tokenfold/core/assets/tokenizers/`):

| File | Size |
|---|---|
| `gemma2.json` | 17.5 MB |
| `llama3.json` | 17.2 MB |
| `deepseek3.json` | 7.8 MB |
| `qwen2.5.json` | 7.0 MB |
| `mistral.json` | 2.0 MB |

The Python package itself (`vendor/tokenfold/core/tokenfold/`) is **196 KB** — 0.4% of the tracked total.

## 3. Consumers (every file in this repo that references TokenFold)

### 3.1 Runtime consumers (start the proxy, route traffic through it)

| File | Lines | Role |
|---|---|---|
| `scripts/launch.sh` | 103–167 | **Primary runtime consumer.** Resolves a TokenFold source (sibling checkout → `vendor/tokenfold`), provisions a venv from `vendor/tokenfold/core` on first launch, sets `TOKENFOLD_ASSETS_DIR` to the vendored tokenizer JSONs, starts the proxy via `python -m tokenfold.cli serve --port 9339 --upstream ...`, health-checks `/healthz`, and **reroutes `OLLAMA_URL` through `http://localhost:9339`** so every subsequent worker/reviewer/dashboard call is transparently compressed. |

### 3.2 Dashboard consumers (expose TokenFold's live stats to the UI)

| File | Lines | Role |
|---|---|---|
| `python/dashboard/routes/event_stream.py` | 24, 75–76 | Samples `/tokenfold/stats` from `http://localhost:<TOKENFOLD_PORT>/tokenfold/stats` on interval `TOKENFOLD_INTERVAL_S`; emits a `tokenfold-changed` event when the value moves. `_tokenfold_url()` resolves the URL. |
| `python/dashboard/routes/embedded_tools.py` | 15–16, 28–33 | Exposes `GET /api/tokenfold/stats` to the browser by proxying to the local TokenFold instance. Returns a degraded-but-200 response if the proxy is unreachable (same pattern `hardware.py` line 31 documents). |
| `python/dashboard/routes/hardware.py` | 31 | Comments reference the same degraded-but-200 pattern used by `api_tokenfold_stats()`. |
| `python/dashboard/static/js/analytics-and-discovery.js` | 478–481 | Fetches `/api/tokenfold/stats`, renders a stats panel, and links to `http://localhost:<port>/tokenfold/dashboard`. Shows an empty state when the proxy isn't running. |
| `python/dashboard/static/js/live-updates.js` | 22, 33, 38, 48, 121 | Registers `tokenfold-changed` in `LIVE_EVENTS`; maps it to `TOKENFOLD_DRIVEN_TABS = ['tokenfold', 'reports']`; dispatches redraw on that event. |
| `python/dashboard/static/js/branches-joblist-hardware-tabs.js` | 1055 | Tab dispatch: `activeTab === 'tokenfold'` calls `renderTokenfoldTab()`. |
| `python/dashboard/static/js/branch-projects.js` | 30 | Line-count table includes `tokenfold: 186` (one of the tracked repos). |

### 3.3 Test / CI consumers

| File | Lines | Role |
|---|---|---|
| `src/branch-check-harness.js` | 50–54, 59, 162–165 | Detects a `vendor/tokenfold/core/` layout (marker: `core/tests/test_core.py` + `core/tokenfold/`), runs `python3 tests/test_core.py` with `PYTHONPATH=.` from `core/` when tokenfold files change in a branch. `DEFAULT_HARNESSES = [tokenfoldCore, nodeTest, pythonVenvFlat, pythonSrcTests]`. |
| `src/branch-check-harness.test.js` | 61–65, 136–139 | Exercises the tokenfold-harness detection and plan output. |
| `src/ollama-http.js` | 155 | Comments document that the OLLAMA_URL reroute goes through TokenFold's `ollama_native.py`. |
| `src/ollama-http.test.js` | 49 | Asserts the `x-tokenfold-session` request header is present on outgoing Ollama calls (proves the reroute is live). |
| `src/lib/poll-calibrate.test.js` | 71 | Fixture path `vendor/tokenfold/a.js` in a synthetic file tree. |
| `src/lib/poll-rules/config.rules.test.js` | 90 | `languageOf('vendor/tokenfold/core/assets/tokenizers/deepseek3.json')` returns `null` (JSON isn't treated as a source language). |
| `python/dashboard/static/js/branch-projects.test.js` | 34 | Test fixture mirroring the line-count table. |
| `python/dashboard/static/js/live-updates.test.js` | 82 | Tests that `tokenfold-changed` redraws only the TokenFold and Reports tabs. |

### 3.4 Documentation / script references

| File | Lines | Role |
|---|---|---|
| `scripts/adopt-existing-project.sh` | 3, 14 | Mentions TokenFold as an example of a same-owner dependency for the adopt script. |

**Total unique consumer files: 17.** All paths verified against the working tree.

## 4. Why It Is Vendored (Current Rationale)

`scripts/launch.sh` lines 112–118 resolve the source in this order:

1. `$TOKENFOLD_DIR` (explicit env override)
2. A sibling checkout (`${REPO_DIR%/*}/tokenfold`)
3. **`vendor/tokenfold`** (the vendored snapshot, "present in every clone")

The vendored copy exists so TokenFold works out of the box with no second download. The launch script provisions a venv from `vendor/tokenfold/core` on first launch and reuses it thereafter.

There is a **documented install-time bug** (`scripts/launch.sh` lines 138–148, annotated 2026-08-21): `pip install vendor/tokenfold/core` does **not** bundle `core/assets/tokenizers/*.json` because those sit outside the `packages.find` scope. The workaround is `TOKENFOLD_ASSETS_DIR` pointing at the on-disk assets — which only works if the assets are present, i.e. if the vendored snapshot is tracked. This is the operational reason the 50 MB of tokenizer JSONs must live in this repo: **pip from the upstream does not ship them either**, so there is no install path that doesn't need the files on disk.

## 5. Are the Assets Needed at Runtime?

**Yes, the tokenizer JSONs are loaded at runtime.** `scripts/launch.sh` line 149 sets `TOKENFOLD_ASSETS_DIR="${TOKENFOLD_DIR}/core/assets/tokenizers"` and the running server's `tokenizers/registry.py` reads them on every request. Without the 50 MB of JSON files, TokenFold crashes with a 500 the moment it tries to load any of its five supported tokenizer profiles (Qwen, Llama 3, Gemma 2, DeepSeek 3, Mistral).

The Python package code (196 KB) is also needed at runtime — it is what runs as the proxy. But that is cheap to install from a source tree or wheel.

**Verdict:** the runtime dependency is 196 KB of Python + 50 MB of data. The data is the problem, not the code.

## 6. Recommendation

### Recommended: git-lfs for the tokenizer assets, keep the Python code vendored (or pin-install)

**Why this combination:**

- The Python code (196 KB) is small enough to keep vendored with zero operational cost, and the upstream does not ship the data files via pip anyway — so a plain `pip install tokenfold==0.1.0` would fail at runtime just like today, unless we also solve the data problem.
- The 5 tokenizer JSONs (50 MB total) are the entire tracked-size problem. They are static lookup tables, regenerated only when TokenFold adds a new model profile. They are perfect git-lfs material: content-addressed, stored outside the git object database, replaced by ~200-byte pointers per file.

**Clone-size effect:**

| Before | After (estimated) |
|---|---|
| `vendor/tokenfold` tracked: **~50 MB** (47 files) | `vendor/tokenfold` tracked: **< 1 MB** (50 KB Python + configs + 5 LFS pointers ~1 KB) |
| Every clone downloads 50 MB of tokenizer blobs | Every clone downloads ~1 KB of LFS pointers (actual blobs pulled on first `tokenizers/registry.py` load, or lazily) |
| `git gc`/packs carry 50 MB of JSON repeatedly | `git gc`/packs carry nothing but pointers |

**Migration steps (one human decision, rest mechanical):**

1. `git lfs install` in this repo.
2. `git lfs track --force 'vendor/tokenfold/core/assets/tokenizers/*.json'`.
3. Commit the `.gitattributes` and the now-tiny JSON files (git-lfs re-uploads on first push).
4. Add `.git-lfs-download` to `scripts/launch.sh` (or a one-line `git lfs pull` in the venv-provision block) for air-gapped machines that never push.
5. Document in `CONTEXT.md` that `vendor/tokenfold/core/assets/tokenizers/` is LFS-tracked.

### Alternatives considered and rejected

| Option | Why rejected |
|---|---|
| **Keep as-is (50 MB tracked)** | Every clone, every branch, every `git gc` pays 50 MB for five static JSON files. Wasteful at scale. |
| **Move everything to a separate repo/package** | The upstream doesn't ship the data via pip; we'd still need a vendored snapshot or LFS for the data. Adds a second repo to manage for no net reduction in tracked bytes. |
| **Replace with a pinned `pip install` of the upstream** | `pip install tokenfold==0.1.0` does not bundle `core/assets/tokenizers/*.json` (confirmed by the documented 2026-08-21 bug in `launch.sh`). Would break at runtime until the upstream fixes their package manifest — out of our control. |
| **git-ignore the JSONs and download at launch** | Fragile: air-gapped machines, flaky network, first-launch race with the proxy. The vendored copy exists precisely to avoid this. |

## 7. Sources Cited

- `vendor/tokenfold/core/pyproject.toml` — version, dependencies, build config
- `vendor/tokenfold/LICENSE` — MIT license
- `vendor/tokenfold/README.md` — purpose, architecture, measured results
- `vendor/tokenfold/core/tokenfold/engine.py` — implementation
- `vendor/tokenfold/core/tokenfold/cli.py` — CLI entry point
- `scripts/launch.sh` — runtime consumer (lines 103–167)
- `python/dashboard/routes/event_stream.py` — event sampling (lines 24, 75–76)
- `python/dashboard/routes/embedded_tools.py` — stats endpoint (lines 15–16, 28–33)
- `python/dashboard/routes/hardware.py` — pattern reference (line 31)
- `python/dashboard/static/js/analytics-and-discovery.js` — frontend panel (lines 478–481)
- `python/dashboard/static/js/live-updates.js` — event dispatch (lines 22, 33, 38, 48, 121)
- `python/dashboard/static/js/branches-joblist-hardware-tabs.js` — tab dispatch (line 1055)
- `python/dashboard/static/js/branch-projects.js` — line counts (line 30)
- `src/branch-check-harness.js` — CI harness detection (lines 50–54, 59, 162–165)
- `src/ollama-http.js` — reroute documentation (line 155)
- `src/ollama-http.test.js` — header assertion (line 49)
- `scripts/adopt-existing-project.sh` — example reference (lines 3, 14)
