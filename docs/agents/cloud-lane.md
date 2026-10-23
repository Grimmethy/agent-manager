# The cloud lane: extra throughput for adhoc tasks on Claude Haiku

A **cloud lane** is a [lane](lanes.md) whose endpoint is not a GPU but the **cloud-providers gateway**: a small private service (the repo `Grimmethy/cloud-providers`, checked out at `/media/model-cache/github/cloud-providers`) that speaks the Ollama HTTP API on `127.0.0.1:7450` and forwards each call to a cloud model, Claude Haiku (`claude-haiku-5-5`) by default. Workers only ever talk the Ollama protocol (`/api/generate`, `/api/chat`), so a cloud lane needs no new claim code: it is an ordinary `lanes.json` entry whose `ollamaUrl` is the gateway.

It exists for one reason: **extra throughput for `adhoc` tasks**. Nothing else.

## The design rule: explicit and bounded

- **A cloud lane is a `lanes.json` entry with `"provider": "cloud"` and a mandatory `taskClasses` allowlist**, conventionally `["adhoc"]`. `src/lanes.js` drops a cloud entry that has no allowlist (or an empty one), so a cloud lane can never claim "anything". It also drops one with a `preempt` other than `never` or with `reviewer: true`, and ignores `numCtx` / `numBatch` (they describe a GPU).
- **It is never an overflow path.** A task that fails on a local lane is not sent to the cloud lane. Capability routing and lane escalation both need a known tier, and a cloud model name has none, so a cloud lane is never "a bigger lane". The only way a task reaches it is by being an allowlisted source that the lane claims like any other lane.
- **Hygiene scan sources are deliberately not on it.** `function_length_review`, `observability_review`, `performance_review`, `change_review` and the like are being atomized so that the RX 580 lane handles them; a cloud model would be overkill there and would spend money for nothing. Keep them off the allowlist.
- **It must not change claim order or throttle local lanes.** Nothing about priority, premium rotation or the local lanes' behaviour changes when a cloud lane is added.

## Why this is not the old subscription path

A task source can still be switched to Claude with `AGENT_MANAGER_CLAUDE_SOURCES` (`src/model-provider.js` -> `src/claude-client.js`, with the manual pause in `src/claude-pause.js` and the `python/dashboard/routes/claude_settings.py` settings), but that path is deliberately dialed back and fully optional. It was dialed back because its mere existence made the previous Claude lean on the subscription instead of building tasks that fit a smaller model. The owner's rule: *"Always break the task down rather than switching to a subscription model."*

The cloud lane differs on purpose: it is a **separate lane**, never a per-source provider switch; it needs an explicit `lanes.json` entry; it is bounded by an allowlist; and it never takes over a source that local lanes can do. Do not use `AGENT_MANAGER_CLAUDE_SOURCES` to route work to it.

## Billing: API key by default, subscription only if the owner confirms

- **API key (the default and the supported route).** The gateway's `anthropic-api` provider reads `ANTHROPIC_API_KEY` from the environment of the gateway process and bills the metered API. Put the key in the environment the gateway is started from, **not** in `agent-manager.env` (that file is read into every daemon's environment).
- **Subscription adapter (off by default).** The `claude-subscription` provider runs `claude -p` against a Claude Pro/Max login. It is owner-confirmed: it does nothing unless `CLOUD_SUBSCRIPTION_CONFIRMED=1` is set (together with the gateway's provider switch and `CLAUDE_CODE_OAUTH_TOKEN`; the gateway README's "Subscription adapter" section lists them all). Anthropic's Feb 2026 terms clarified that Free/Pro/Max OAuth tokens are for Claude Code and Claude.ai, so using them from other automated tooling may breach the consumer terms; API-key billing is the supported route. The adapter is **text only** (a request with tools gets HTTP 501), strips `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the `claude` child process, and records its calls with a null cost. It has not been run against a live login: the JSON field names it reads are unverified.

## Spend: ledger, meter, cap

The gateway appends one line per call to `spend-ledger.jsonl` (counts and cost only, never prompt or response text) in the cloud-providers repo's `data/` directory (gitignored) and reports it at `GET /meter`.

- **Prices come from the owner.** Set `CLOUD_PRICE_IN_PER_MTOK` and `CLOUD_PRICE_OUT_PER_MTOK` (USD per million tokens). There is no built-in price table: without them every cost is null and the meter says "unpriced".
- **Optional monthly cap.** `CLOUD_MONTHLY_CAP_USD` with `CLOUD_CAP_MODE`: `warn` (default) still serves the call and marks the response with an `X-Cloud-Cap: exceeded` header; `hard` answers HTTP 429 without calling the provider. A cap set without prices cannot be evaluated, so it warns once at startup and is ignored. This is a spend guard on the cloud account; it never throttles local lanes.
- **Where you see it.** The Workers tab shows a **Cloud spend** panel under the worker cards (month to date, today, tokens, cost or the unpriced message, the cap and an amber "cap exceeded" marker), fed by `GET /api/cloud-meter` (`python/dashboard/routes/cloud_meter.py`, `python/dashboard/static/js/cloud-spend-panel.js`). The panel appears only when a cloud lane is configured, and says the gateway is not reachable when it is down.

## What a cloud lane skips

There is no GPU behind the gateway, so the GPU-only logic skips it (`isCloudEndpoint()` in `src/lanes.js`): a Forge lease never holds its endpoint (`leaseHeldFor` in `src/gpu-guard.js`), the host-VRAM headroom check does nothing for it, `src/lane-health.js` never probes it, and `src/chat-card.js` never offers it as a chat card. Host RAM pressure (`mem-guard`) still pauses its worker.

## Enabling it

1. **Start the gateway** from `/media/model-cache/github/cloud-providers` with `./run.sh`, with `ANTHROPIC_API_KEY` in its environment. It listens on `127.0.0.1:7450` by default and always on loopback; the gateway README's "Running" section lists the port and model settings, and the price and cap variables above are optional.
2. **Add the lane.** Copy the cloud entry from `lanes.example.json` into your `lanes.json` and set `"enabled": true`:

   ```json
   { "gpu": "cloud", "provider": "cloud", "ollamaUrl": "http://127.0.0.1:7450", "model": "claude-haiku-5-5",
     "taskClasses": ["adhoc"], "preempt": "never", "enabled": true }
   ```

   The lane is `worker-cloud`. Restart the pipeline so `scripts/launch.sh` starts its worker.
3. **Check it.** The Workers tab shows `worker-cloud` and the Cloud spend panel; `curl http://127.0.0.1:7450/meter` shows the gateway's own view.
4. **Plugin registration is not done yet.** The gateway is not listed in `plugins.json` (a gitignored, per-install file), and the dashboard's add route needs a `register.js`, which the cloud-providers repo does not have yet; a follow-up task in that repo's pipeline adds a no-op one. Until it lands, start the gateway by hand as in step 1.

To turn it off, set `"enabled": false` on the entry and restart the pipeline.
