# AUDIT — HUB0033 · 3/4 · Core audit table (question 1)

Self-contained core audit table answering question 1 of the HUB0033 Ollama GPU-contention
investigation: **every local-provider (Ollama) dispatch path, whether the chat preempt gate
is on its path, what the gate resolves to, and the verdict.** Built on the merged sibling
deliverables HUB0033 · 1/4 (dispatch-path enumeration, on disk at
`docs/audit/local-provider-dispatch-paths.md`) and HUB0033 · 2/4 (gate-state resolution,
on disk in `python/dashboard/chat_preempt.py`). Every `file:line` below was re-verified
against the working tree when this file was written — none are copied from the task text.

| path | file:line | preempt invoked? | gate condition | verdict |
|------|-----------|------------------|----------------|---------|
| `python/dashboard/routes/chat.py` | `routes/chat.py:152-154` (gate check `if _chat_preempt_enabled():` at :152; `preempted = _preempt_pipeline_for_chat()` at :154) | yes — invoked synchronously, before the SSE generator / node child runs (`routes/chat.py:140-141` comment; `preempted = []` init at :142) | `_chat_preempt_enabled()` = ON by default: env `AGENT_MANAGER_CHAT_PREEMPT` → env file → default `"true"`; OFF only on `0/false/no/off` (`chat_preempt.py:76-98`). OFF state is now logged, not silent (`log_preempt_gate_off` at `chat.py:158`) | chat turn takes the GPU now: worker draft lanes are cancelled below `interactive` on the chat's own endpoint via the arbiter; P40 endpoint never touched; gate OFF = silent bypass of preempt (confirmed, now logged) |
| `python/dashboard/routes/internal_chat.py` (`/api/internal/chat/local-turn`) | `routes/internal_chat.py:177-178` (route decorator at :177; `def api_internal_chat_local_turn():` at :178) | caller-dependent — the handler's own docstring says the caller "is responsible for calling /preempt first and holding a reservation if it wants one"; the route itself never calls `_preempt_pipeline_for_chat` | same gate: the sibling `/api/internal/chat/preempt` wrapper checks `_chat_preempt_enabled()` at `routes/internal_chat.py:106` and returns `{preempted: []}` when OFF | local turn proceeds on whatever GPU state the caller left; a caller that skipped /preempt contends with in-flight worker/reviewer work (the contention this investigation targets) |
| `python/dashboard/discuss_sessions.py` (third path — verified) | `discuss_sessions.py:181` (`proposal = ollama_client.generate(`) and `discuss_sessions.py:276` (the Ollama branch of `_generate`, defined at :241) | no — 0 references to `_preempt_pipeline_for_chat` in the file | not gated by `_chat_preempt_enabled()` at all | genuine local-provider dispatch that bypasses the chat preempt gate entirely — a direct GPU-contention source alongside workers |
| `python/dashboard/grill_sessions.py` (further third path — verified) | `grill_sessions.py:124` and `grill_sessions.py:157` (bare `generate(...)` calls; `from ollama_client import generate` at :12) | no — 0 references to `_preempt_pipeline_for_chat` in the file | not gated by `_chat_preempt_enabled()` at all | same verdict as discuss_sessions: ungated local-provider dispatch, contention source |
| `python/dashboard/app.py` `_run_build` (background third path — verified) | `app.py:2608` (`def _run_build(path_str, grep_dirs)`) | no — background thread, no chat context at all (sibling audit row 5) | not gated by `_chat_preempt_enabled()` | background Ollama work with no chat context; never yields GPU to chat on its own — only the arbiter's cancel-below can interrupt it once it holds a ticket |

## Resolved context

### Gate state — `_chat_preempt_enabled()` (HUB0033 · 2/4, present on disk)

`python/dashboard/chat_preempt.py:97` — `def _chat_preempt_enabled() -> bool:  return
_chat_preempt_gate_state()[0]`. Its docstring at `chat_preempt.py:76` states the single
source of truth:

> "Resolution precedence (single source of truth -- _chat_preempt_enabled() and any
> caller that logs/inspects the exact state go through HERE so they can't drift):
> (a) process env AGENT_MANAGER_CHAT_PREEMPT → source \"env\"; (b) ENV_FILE_PATH value →
> source \"env-file\"; (c) neither set → \"true\" (ON) → source \"default\". `enabled` is
> False only when the resolved value, str().strip().lower(), is in (\"0\", \"false\",
> \"no\", \"off\")."

Production state per the merged HUB0033 · 2/4 change (comment at
`routes/chat.py:146-149`): **default ON ("true") — no disabling value found anywhere in
the repo** (the env file is host-local; verify on the live host). The gate-OFF branch is a
**CONFIRMED SILENT BYPASS** (a local-provider Ollama turn proceeds to the model with no
preempt) — `log_preempt_gate_off` (`chat_preempt.py:102`) now turns that silent skip into
a greppable stderr event without changing dispatch behavior.

### GPU-arbiter queue-vs-cancel finding (HUB0033 · 1/4, present on disk)

`src/gpu-arbiter.js:1-17` (header) establishes the arbiter as "the single owner of
local-model (GPU) access": **priority classes queue** (`interactive > review > draft >
audit`; "A waiter proceeds only when no ticket of a HIGHER class exists and it holds the
earliest ticket of its OWN class"), while **chat preemption is a cancel, not a wait**:

> "CROSS-PROCESS CANCELLATION. cancelBelow(cls) marks every lower-class ticket
> `cancelRequested` and SIGKILLs any that is actively holding; the holder's daemon
> requeues its task." (`src/gpu-arbiter.js:11-14`; `cancelBelow` itself at
> `src/gpu-arbiter.js:339-350`)

So the finding is: **the arbiter is a priority queue for ordinary work, and
queue-vs-cancel is resolved as cancel-below for chat** — `_arbiter_cancel_below("interactive")`
(`chat_preempt.py:276-300`, called from `_preempt_pipeline_for_chat` at `chat_preempt.py:317`)
shells to `scripts/gpu-arbiter-cli.js cancel-below --local --cls interactive`, cancelling
every lower-class ticket on the chat's own GPU endpoint only (never P40), while the
reviewer lane is not on the arbiter yet and keeps the legacy age-gated kill
(`chat_preempt.py:305-306`). Queued lower-class tickets are killed (their daemon requeues
the task) rather than chat waiting behind them.

## Open operator decisions (HUB0033 · 4/4)

The two questions below are **open questions for the operator, not code changes** — this
section surfaces them and records the facts they need to decide; nothing here is an
instruction to implement either option, and no code file is modified by this entry.

### Decision 1 — Timeout ceiling: close as already-fixed, or is the 300s ceiling itself under review?

Fact on disk: `src/local-client.js:372-375` (constant at `src/local-client.js:375`) —
`PER_CALL_TIMEOUT_CEILING_MS = 300_000` — was raised from 240s to 300s on **2026-09-18**
(comment block at `src/local-client.js:352-374`) to match `src/ollama-http.js`'s
`HARD_TIMEOUT_CEILING_MS`, once `dead-process-check.js`'s
`WORKER_ZOMBIE_THRESHOLD_SECONDS` moved to 1680s and 4 × 300s = 1200s again left
deliberate slack. (The P40 endpoint has a separate, explicitly documented 900s exception:
`P40_PER_CALL_TIMEOUT_CEILING_MS`, `src/local-client.js:397`.)

**Open question for the operator:** given that raise, should the worker-timeout question
from the incident be closed as **already-fixed**, or is the 300s ceiling itself still
under review (e.g. does it need to scale per-endpoint the way the P40 exception already
does)?

### Decision 2 — Retry policy: is retry-then-fail acceptable, or is queue-priority backoff wanted?

Fact on disk: worker retry is **maxRetries=2** — the `call(opts, maxRetries = 2)` default
(`src/local-client.js:459`) — and the incident observed the task exhaust it at **2/2**.
The surrounding failure-handling region is the draft-failure branch of
`scripts/local-worker.sh:239-434` (draftFailureCount / infraRequeueCount requeue-vs-block
logic, worker-level infra-failure backoff), and the arbiter's existing lever is its
priority classes (`src/gpu-arbiter.js:1-17`: `interactive > review > draft > audit`).

**Open question for the operator:** is the current **retry-then-fail** behavior
(maxRetries=2, then the task blocks for a human) acceptable as-is, or does the operator
want **queue-priority backoff** — a change that would touch
`scripts/local-worker.sh:239-434` and the `gpu-arbiter` priority classes (e.g. lowering a
repeatedly-failing lane's class so it yields GPU to healthier work instead of burning
retries against a contended endpoint)?
