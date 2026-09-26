# Local-Provider Dispatch Paths — Audit

Audit of every place in this codebase that dispatches work to a local model
provider (Ollama). Established as part of HUB0033 (Ollama GPU contention
investigation). Each row cites `path:line` verified in the working tree at the
time of writing.

## 8-row audit table

| # | Path / Entry point | Dispatch mechanism | Goes through `_preempt_pipeline_for_chat`? | Classification |
|---|--------------------|--------------------|---------------------------------------------|----------------|
| 1 | `python/dashboard/routes/chat.py` | `_preempt_pipeline_for_chat()` called at `python/dashboard/routes/chat.py:145` before chat dispatch | Yes — this is a known preempt site | Known preempt site (preempted) |
| 2 | `python/dashboard/routes/internal_chat.py` | `_preempt_pipeline_for_chat()` called at `python/dashboard/routes/internal_chat.py:109` (wrapper documented at line 99) | Yes — this is a known preempt site | Known preempt site (preempted) |
| 3 | `python/dashboard/discuss_sessions.py` | `ollama_client.generate(...)` at `python/dashboard/discuss_sessions.py:181` (provider split in `_generate` at line 241) | No — 0 references to `_preempt_pipeline_for_chat` in the file | Third path — bypasses `_preempt_pipeline_for_chat` |
| 4 | `python/dashboard/grill_sessions.py` | bare `generate(...)` calls at `python/dashboard/grill_sessions.py:124` and `:157` | No — 0 references to `_preempt_pipeline_for_chat` in the file | Third path — bypasses `_preempt_pipeline_for_chat` |
| 5 | `python/dashboard/app.py` `_run_build` / `python/build_graph.py` | `_run_build` background thread defined at `python/dashboard/app.py:2606`; local-provider POST to `{ollama_url}/api/generate` at `python/build_graph.py:512` (URL default at `python/build_graph.py:154`) | No — background thread, not a chat route | Background third path |
| 6 | `src/` worker lanes (e.g. `src/local-draft.js`) | `src/local-draft.js` requires `./local-client.js` at `src/local-draft.js:77` and dispatches through `local-client.js`'s `call()` | No — these lanes are the *victims* killed by the preempt, not preemptors | Preempted victims |
| 7 | `/api/tags` | Appears in local-provider search-term matches in `python/` (3 hits) but does not dispatch to a local model | N/A — no local-model dispatch | False positive (search-term match only) |
| 8 | `/api/ps` | Appears in `src/` (16 hits) but does not dispatch to a local model; 0 hits in `python/` | N/A — no local-model dispatch | False positive (search-term match only) |

## Out of scope

`claude_client` (`python/dashboard/claude_client.py`) is **out of scope** for
this audit: it is the Claude-side client, not a local-provider dispatch path.
Wherever a dispatch function splits on provider (e.g. `discuss_sessions.py`
`_generate` at line 241, with the Claude branch at line 266), only the
Ollama/local branch is counted in this table.

## Bottom line

- **Genuine local-provider dispatchers that bypass the chat preempt gate:**
  `discuss_sessions.py` (row 3) and `grill_sessions.py` (row 4) — the two
  "third paths" the audit set out to find.
- **Background dispatcher:** `app.py _run_build` → `python/build_graph.py`
  (row 5) — fires Ollama work on its own thread with no chat context at all.
- **Only rows 1–2 (`routes/chat.py`, `routes/internal_chat.py`) actually go
  through the preempt gate** (`chat_preempt.py:266`
  `def _preempt_pipeline_for_chat()`), and their job is to *kill* the
  worker-lane dispatch of row 6 — so rows 6's lanes are the preempted victims,
  not a source of contention themselves.
- Rows 7–8 (`/api/tags`, `/api/ps`) are false positives: they match
  local-provider search terms but never call the local model.
- `claude_client` is out of scope (see above).
