# Lanes: adding a GPU is one registry entry

A **lane** is one worker process on one GPU endpoint, named for the GPU (`worker-3090`, `worker-p40`, `worker-rx580`). Since 2026-10-17 lanes are
**data**: `src/lanes.js` builds every lane definition, and `scripts/launch.sh`, the watchdog's restart rule (`src/dead-process-check.js`), the claim
loop (`src/next-claimable-task.js`), the GPU arbiter guard (`src/lib/ollama-lock-key.js`) and the dashboard (`app.worker_lane_defs()`,
`chat_preempt.py`) all read that one module. (History: until then each new GPU needed its own special case in six files; adding grimm's RX 580 made
that the thing to remove.)

## Where lanes come from, in order

1. **The host lane**, always. Named from `AGENT_MANAGER_LOCAL_GPU`, else the first `nvidia-smi` GPU, else `local`.
2. **The legacy P40 lane** `worker-p40`, when both `AGENT_MANAGER_P40_OLLAMA_URL` and `AGENT_MANAGER_P40_MODEL` are set. Unchanged behaviour for
   existing installs. It can also be declared in the registry (the registry entry then replaces it).
3. **The lanes registry**: the JSON file at `AGENT_MANAGER_LANES_PATH` (default `<repo>/lanes.json`, gitignored; absent = no extra lanes).
   Copy `lanes.example.json` to start. A bare array, or `{"lanes": [...]}`.

## Adding a GPU (the whole procedure)

1. Run Ollama on that machine, reachable from this one (a tailnet address is fine). Pull the model it should serve. On a small card also set
   `OLLAMA_FLASH_ATTENTION=1` and `OLLAMA_KV_CACHE_TYPE=q8_0` on that Ollama (halves the context's memory) and size `numCtx` to fit (see below).
2. Add an entry to `lanes.json`:

   ```json
   { "gpu": "rx580", "ollamaUrl": "http://100.96.112.78:11434", "model": "qwen3-vl:8b-instruct",
     "taskClasses": ["brain_dump_sort", "change_review"] }
   ```
3. **Restart the pipeline** (`launch.sh`) so the lane is started. The watchdog only restarts lanes that already have a heartbeat; a lane that has
   never run is started by `launch.sh`. Lane env is frozen when a worker launches, so editing `lanes.json` never changes a running lane.
4. Check the Workers tab shows the new `worker-<gpu>` lane with a recent heartbeat.

## Entry fields

| field | required | meaning |
|---|---|---|
| `gpu` | yes | slug; the lane id defaults to `worker-<gpu>` |
| `ollamaUrl` | yes | `http(s)` endpoint of that GPU's Ollama (also the GPU arbiter's serialization key) |
| `model` | yes | becomes the lane's `LOCAL_MODEL` |
| `id` | no | override; must match `^worker-[a-z0-9]+$`. An id equal to an earlier lane **replaces** it (never the host lane) |
| `enabled` | no | `false` keeps the entry on file but launches nothing |
| `numCtx` | no | whole number 2048..131072: the one `num_ctx` this lane's calls use. **Set it for any card smaller than the 24 GB ones**: the pipeline pins `49152` (sized for the 3090/P40) and an 8 GB card cannot hold that next to an 8B model. Measured on an RX 580 8 GB, qwen3-vl:8b: `49152` -> 10.6 tok/s at 80% GPU; `16384` -> 26.2 tok/s at 100% GPU (with a q8 KV cache; f16 KV: 8.0 tok/s at `49152`). It is exported as `AGENT_MANAGER_LANE_NUM_CTX` to that lane's processes only |
| `numBatch` | no | whole number 32..8192: the `num_batch` (prompt-processing batch) this lane's calls use, exported as `AGENT_MANAGER_LANE_NUM_BATCH` to that lane only. Absent = Ollama's default. Measured on the RX 580 (qwen3-vl:8b, Vulkan, q8 KV, 4.4k-token prompt): default 26 tok/s prompt processing (169 s before the first token); **1024 -> 178 tok/s (26 s)** with generation unchanged at 25 tok/s; 2048 -> 177 tok/s but generation halves to 13; 256 -> 34. Flash attention and the q8 KV cache are NOT the cause (f16 KV was slower on both) |
| `taskClasses` | no | allowlist of task **source** names (`brain_dump_sort`, `change_review`, `observability_review`, `staleness_audit`, ...). Absent = claims any task. Must be non-empty if present |
| `preempt` | no | `always` \| `age-gated` \| `never` (default `never`): whether an interactive chat turn may kill this lane's in-flight call. Only the host lane is `always`: the chat takes over the host GPU only |
| `tier` | no | positive number, billions of parameters. Defaults to the size parsed from `model` (`qwen3-vl:8b-instruct` -> 8); set it when the tag carries no size. Capability routing only compares tiers; a lane with an unknown tier is never reserved around |
| `reserve` | no | `"auto"` (default: this lane is reserved for a source once the capability ledger shows it handles it), `"always"` (reserved for everything in its `taskClasses`, no evidence needed), or `false` (never reserve work for this lane) |
| `reviewer` | no | `true` also runs a **review daemon** on this lane's GPU (`reviewer-<gpu>`, `scripts/review-runner.sh`), so its three CONFIRM/DENY votes go to this lane's Ollama instead of queueing behind the host GPU. Default `false`. The host lane always has the plain `reviewer`; the legacy P40 lane (not in the registry) opts in with `AGENT_MANAGER_P40_REVIEWER=true` in `agent-manager.env`. Needs a pipeline restart. See "Review daemons" below |
| `slow` | no | `true` for a categorically slower endpoint (the P40 is the model case): longer per-call timeout ceiling and watchdog zombie threshold, so a slow-but-alive lane is not killed mid-call. Default `false` |

## Behaviours worth knowing

- **Fail closed.** A bad file, or an entry with a missing/invalid field, never creates a lane (and never widens one); the problem is written to
  stderr once per process and the other lanes carry on. Two lanes on one Ollama endpoint are refused (one GPU, one lock).
- **`taskClasses` is enforced where claims happen** (`pickClaimableTasks`). An operator pin to the lane (Workers tab "assign") bypasses it, as it
  bypasses lane avoidance. A task whose source cannot be resolved is never offered to a restricted lane.
- **A restricted lane with nothing allowlisted pending claims nothing**; it never falls back to the rest of the queue. That is the point.
- The preferred-lane rule (the first lane in the list gets a lone task for `AGENT_MANAGER_LANE_PREFERENCE_GRACE_SECS`) still applies, so
  registry lanes come after the host lane (and the legacy P40) in claim preference.
- `generation-throttle.js` counts every live lane when deciding how many tasks may be in flight, so a restricted lane raises that count even
  though it can only take some tasks. Revisit if a tiny lane starts causing over-generation.
- The reviewer's CONFIRM/DENY votes and other non-task model calls use the process's own `OLLAMA_URL`; they are **not** routed to lanes.

## Capability routing (`src/capability-routing.js`)

A bigger-tier lane leaves a task alone while a **lower-tier** lane that has proven itself on that task's source is alive, for at most
`AGENT_MANAGER_RESERVATION_GRACE_SECS` (default 300). "Proven" = the capability ledger scorecard (`src/capability-ledger.js`) shows at least
`AGENT_MANAGER_CAPABILITY_MIN_ATTEMPTS` (8) attempts and a success-rate lower bound within `AGENT_MANAGER_CAPABILITY_MARGIN` (0.10) of the best larger
tier's (or, with no larger-tier data, a success rate of at least `AGENT_MANAGER_CAPABILITY_MIN_OK_RATE`, 0.85), or the lane says `reserve: "always"`.
Human-queued and premium tasks, operator pins, and tasks that already failed on the small lane (`avoidLanes`) are never held.

`AGENT_MANAGER_CAPABILITY_ROUTING` = `shadow` (default: decide and log one `reservation` line per task/lane/holder to the pipeline-history log, change
nothing), `enforce`, or `off`. Design and rollout: `docs/design-notes/capability-routing-and-benchmarking.md`. `launch.sh` exports
`AGENT_MANAGER_HOST_LOCAL_MODEL` so the host lane's tier is known inside remote-lane workers.

### Lane health

`src/lane-health.js` (run from the watchdog tick, in the background) sends each **idle** lane's endpoint one tiny fixed generation about every 10 minutes
(`AGENT_MANAGER_LANE_HEALTH_INTERVAL_SECS`, 600) and records tokens/s in `<instances>/lane-health.<lane>.json` and as a `lane-health` pipeline-history
line. A lane is **degraded** when its latest probe failed or ran below `AGENT_MANAGER_LANE_HEALTH_MIN_FRACTION` (0.5) of its own 75th-percentile
baseline. Why it exists: on 2026-10-17 the RX 580's memory clock stuck at 300 MHz (0.6 instead of 26 tok/s) and three timeouts looked like a task that
was too big for the 8B. Consumers: reservation and probing never use a degraded lane; `capability-debrief-bundle.js` marks clusters that ran on a
degraded lane as hardware suspects and keeps them out of the debrief queue. `AGENT_MANAGER_LANE_HEALTH=off` disables. CLI: `node src/lane-health.js --status`.
The capability ledger also records each attempt's own `tps` (from calls that returned) and the scorecard shows its median.

### Probing

So smaller lanes keep getting tried on work they have not proven, a **restricted lane** (one with `taskClasses`) is also offered a deterministic fraction
(`AGENT_MANAGER_PROBE_FRACTION`, default 0.10; the choice is a hash of task id and lane, so it is stable across ticks) of **eligible** tasks outside its
allowlist, one per claim call. Eligible = not human-queued, premium, pinned or `adhoc`, and the source's registration does not say `probe: false`. A
lane that already passes the gate for a source gets reservation instead; a source pauses for a lane after `AGENT_MANAGER_PROBE_MAX_FAIL_STREAK`
(3) consecutive failed attempts there. While a probe task is waiting and the small lane is idle, bigger lanes hold it for the reservation grace.
A probe that fails escalates (below). Governed by the same `AGENT_MANAGER_CAPABILITY_ROUTING` switch: in `shadow` (default) it only logs `would-probe`
lines. Next: the probe debrief (`docs/design-notes/capability-routing-and-benchmarking.md` section 5a).

### Escalation

A draft attempt that ends in a **timeout, degenerate output or a hard error** on a lane that has a bigger-tier lane above it stamps that lane onto
the task's `avoidLanes` (the same mechanism plan-degenerate blocks already used) and writes a `lane-escalated` history event, so the retry goes
to a larger lane instead of looping on the small one. A reviewer rejection is not an escalation. `AGENT_MANAGER_LANE_ESCALATION=off` disables it.
Needs known tiers on both lanes; the biggest lane never escalates. Caveat: `avoidLanes` is per task and permanent, so a task escalated off the
8B waits for a bigger lane even if none is currently alive.

## Review daemons (2026-10-18)

Reviews (the three-vote gate in `src/review-task.js`) used to run on ONE daemon on the host GPU, queueing behind the host lane's drafts; the 3090 is the busiest card, and
a review waiting behind it can hit the 5-minute per-call limit (seen on the first task a grimm-driven session pushed through review). A lane with `reviewer: true` (or
`AGENT_MANAGER_P40_REVIEWER=true` for the P40) also gets its own `review-runner.sh` daemon, `reviewer-<gpu>`, started by `launch.sh` and restarted by the watchdog
(`restartTargetFor`) with that lane's Ollama env, shown in the Workers tab through `app.reviewer_instance_ids()`.

- **No double reviews:** the daemons share `queue/review/`, so each item is **claimed** (an atomic `mkdir` under `<instances>/review-claims/`, owner pid recorded) before it is
  reviewed and kept until the next item starts, so it outlives the approve/block move. A claim whose owner is dead, or that is older than 3 h, is taken over.
- **What it does not do:** one review still runs its three votes on ONE GPU (the claimer's); it parallelises across tasks, not within one. The P40 is ~3x slower than
  the 3090 per token, so a task claimed by the P40 reviewer finishes later than it would have on a free 3090: the gain is throughput when the 3090 reviewer is busy, not latency.
- **Single-flight locks** are keyed by the Ollama ENDPOINT (`ollama-<host>-<port>`, `localOllamaLockKey()` in `src/lib/ollama-lock-key.js`), the same key worker drafts use through
  `gpu-arbiter.js`, so a lane's worker and its reviewer take turns on one GPU ("one role per cycle per lane") while lanes on different endpoints never wait for each other, whatever
  model tag they run. The review daemon gets the key from `review_lock_key()` in `scripts/review-runner.sh` (it was the model name until 2026-10-21, a different lockfile for the same
  GPU: `worker-p40` and `reviewer-p40` overlapped and the P40 VM's llama-server was OOM-killed). `scripts/review-runner-lock-key.test.js` guards it.
- **Priority:** the arbiter class of a review outranks a draft on the same endpoint, so on the P40 a review goes before a waiting `worker-p40` draft, as on the 3090.
- **Arbiter hold (drafts only):** `node scripts/gpu-arbiter-cli.js hold --key <endpoint key> --pid <its pid> [--cls review] [--task ID]` takes an arbiter place ticket for a process that is not a lane, released when that pid exits, on SIGTERM, or on a higher class's cancel-below; `status --key K` lists it under `reserved`, and each start/release is a `gpu-hold` line in `pipeline-history.log`. Only callers that take arbiter tickets wait behind it, which today means drafts; reviews take none (see below), and a draft lane still claims and then waits the 600 s arbiter deadline. To reserve a card, use the endpoint-scoped lease below.

## Endpoint-scoped GPU lease (2026-10-18)

The Forge-family lease (`~/.local/state/agent-manager/comfyui-lease.json`, see PromptForge's `Docs/GPU_FAMILY_PROTOCOL.md`) is how anything outside the pipeline takes a
card from it. While a fresh lease is held, `local-client.js` refuses to START a model call (`ForgePauseError`, "paused, not failed": no retry, no failure count), and
`local-worker.sh` / `review-runner.sh` yield their ticks. That covers drafts, the reviewer's votes and every other `local-client.js` caller. It does **not** go through
the gpu-arbiter: a reviewer vote takes no arbiter ticket, so an arbiter place ticket (`holdPlace`) holds off drafts only. Use the lease to reserve a card.

A lease may now be **scoped to some cards**, so a plugin that reserves one card (a KaggleForge eval on the P40) does not pause the lanes on the others:

```json
{ "holder": "kaggleforge", "family": "forge", "owner": "KAG-gemma-dev-0009", "endpoints": ["http://192.168.122.29:11434"],
  "acquiredAt": "2026-10-18T09:00:00Z", "refreshedAt": "2026-10-18T09:00:20Z" }
```

- **`endpoints`** is optional. Absent or empty = the whole pipeline, exactly as before (PromptForge's lease has no such field and is unchanged). Present = only calls to those
  Ollama URLs are held off. Matching is `host:port`; `localhost`, `127.0.0.1` and `::1` are one host; a missing port means 11434. A caller whose own URL cannot be parsed stays held.
- **Who checks it:** `gpu-guard.js` `leaseHeldFor(url)` (used by `local-client.js` with the lane's `OLLAMA_URL`, and by `lane-health.js`, which skips a leased card so a probe
  does not reload the model the holder evicted); the shell twin `comfyui_lease_held [url]` in `agent-manager-common.sh` (the daemons pass `${OLLAMA_URL:-http://localhost:11434}`),
  which calls the same JS function so the rule exists once. `comfyuiLeaseHeld()` / `comfyui_lease_held` with no argument keep the old meaning: any fresh lease = held.
- **Freshness is unchanged:** `refreshedAt` within 90 s and `acquiredAt` within 900 s (`AGENT_MANAGER_COMFY_LEASE_TTL_S` / `_MAX_S`). The holder must renew **both** timestamps
  about every 20 s, as PromptForge's keeper does, or the 900 s ceiling ends the lease. Kill switch: `AGENT_MANAGER_FORGE_PAUSE=off`.
- **One file, one holder.** Do not write over a fresh lease whose `holder` is someone else. PromptForge's `lease_intact()` ends its own session when the holder changes. The
  holder must treat the file disappearing, or its `holder` changing, as preemption and get off the card.
- **Pipeline start wins.** `scripts/launch.sh` deletes the lease on an explicit pipeline start, scoped or not. A holder that finds its lease gone must stop, not rewrite it.
- **Still to do outside this repo:** PromptForge's `Docs/GPU_FAMILY_PROTOCOL.md` should describe `endpoints` and the holder rule. KaggleForge's runner (`server/gpu_lease.py`) is the first writer.
- **Not true as written elsewhere in this file:** the "Review daemons" section says a review's arbiter class outranks a draft on the same endpoint. Reviews take no arbiter
  ticket (`review-task.js` and `local-client.js` never call the arbiter), so that priority does not exist; the lease is what holds a review off.

## Tests

`src/lanes.test.js` (registry parsing, validation, fail-closed, id/endpoint collisions, CLI), `src/next-claimable-task.test.js` (allowlist),
`scripts/gpu-arbiter-cli-endpoint.test.js` (remote-lane guard), `scripts/gpu-arbiter-cli.test.js` (hold lifecycle), `src/gpu-guard.test.js` + `scripts/comfyui-lease-endpoint.test.js` (endpoint-scoped lease, shell/JS parity), `python/dashboard/test_chat_preempt.py` + `test_expected_instances.py`
(dashboard parity and preemption sets).
