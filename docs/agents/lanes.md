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

1. Run Ollama on that machine, reachable from this one (a tailnet address is fine). Pull the model it should serve.
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
| `taskClasses` | no | allowlist of task **source** names (`brain_dump_sort`, `change_review`, `observability_review`, `staleness_audit`, ...). Absent = claims any task. Must be non-empty if present |
| `preempt` | no | `always` \| `age-gated` \| `never` (default `never`): whether an interactive chat turn may kill this lane's in-flight call. Only the host lane is `always`: the chat takes over the host GPU only |
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

## Tests

`src/lanes.test.js` (registry parsing, validation, fail-closed, id/endpoint collisions, CLI), `src/next-claimable-task.test.js` (allowlist),
`scripts/gpu-arbiter-cli-endpoint.test.js` (remote-lane guard), `python/dashboard/test_chat_preempt.py` + `test_expected_instances.py`
(dashboard parity and preemption sets).
