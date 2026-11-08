# IO churn detector

One shared, deterministic definition of the mistakes that make Ollama reload the resident model. On 2026-11-06 the 21 GB local model was reloaded from the SSD 13-20 times an hour (IO pressure 87-95%), because code sent a context size different from the pinned one, sent a finite keep-alive over the server's never-expire, unloaded the model, or POSTed to Ollama itself instead of going through `src/local-client.js`. A different `num_ctx` makes Ollama restart its runner, which is a full reload. The detector is the sibling of the poll detector (`docs/agents/poll-detector.md`, ADR-0024): later pieces wire the prompt lines (`src/lib/io-avoidance-lines.js`) and the pre-merge gates to it. **This version wires nothing.**

## What it flags

Only ADDED lines of a diff (or every line, for a repository scan), in `.js`-family, `.py` and `.sh` files. Comment lines, python docstrings, js block comments, test files, `vendor/`, `node_modules/` and the sanctioned files are never flagged.

| Kind | Meaning |
|---|---|
| `caller-num-ctx` | a numeric literal assigned or passed as `num_ctx`, `numCtx`, `NUM_CTX` (any name containing it): the context is chosen by `src/gpu-capacity.js`, never by a caller |
| `finite-keep-alive` | `keep_alive` / `keepAlive` / `KEEP_ALIVE` set to a literal shorter than a year (`'30m'`, `600`); `'8760h'`, `-1` and a named constant are fine |
| `unload-call` | `keep_alive` 0 or `'0'`, an `unload(...)` / `unloadModel(...)` call, or `ollama stop` |
| `direct-model-call` | `/api/generate` or `/api/chat` in code; dashboard routes such as `/api/chat/inject` are not model calls |

Sanctioned files (the one place allowed to name these): `src/gpu-capacity.js`, `src/keep-alive.js`, `src/local-client.js`, `src/local-tool-client.js`, `src/model-resident.js`, `src/ollama-http.js`.

## The annotation

A line that must do one of these on purpose says why, in a comment on the same line or directly above:

```
// io-ok: a one-shot probe of the scratch endpoint, never the resident model
```

`#` (py, sh) and `//` and `/* */` (js) all work. An empty reason (`// io-ok:`) does not count.

## Commands

```
node src/io-churn-detector.js scan --diff <file> [--fail-on-new]    # prints { new, known, annotated }; known is always []
node src/io-churn-detector.js scan --root <dir> [--json]            # every finding in the tracked files
```

Exit 0 ok, 1 an unexpected error (or `--fail-on-new` found a NEW un-annotated finding), 2 a usage error. A branch check, the way a gate runs it:

```
git diff origin/master...HEAD > /tmp/branch.diff
node src/io-churn-detector.js scan --diff /tmp/branch.diff --fail-on-new
```

## Today's findings (2026-11-07, `scan --root`)

Seven, all already known: `python/dashboard/ollama_client.py` (num_ctx 8192 and the call itself) and `python/graph_communities.py` (fixed by the next piece of this hub), the launch warm-up in `scripts/agent-manager-common.sh` and `scripts/launch.sh`, and the probes in `src/lane-health.js` and `src/reasoning-bench.js`. A diff gate only looks at added lines, so these never block anything; they are the list of places to route through the shared client or annotate.
