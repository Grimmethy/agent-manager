# Systems Monitor family: design

Status: design only. No code, no repos created. Owner decisions are listed at the end.

Why: system health and usage should be visible as a family of separate repos and UIs, not one tab. The family reuses the hardware plugins and the gpu-broker tab rather than duplicating them. ADR-0024 measured what should become visible: the shared spinning disk at 100% busy with 89% I/O pressure, watchdog tick cost (31 node launches per tick), queue-cache hit rate, and swap and memory pressure.

## Already covered

What is verified, and what is not.

**Verified from this checkout:**

- `agent-manager-hardware-plugin` (port 7440, psutil / nvidia-smi data source) and `agent-manager-hardware-goatmon-plugin` (port 7441, Goat Monitor data source) are listed in `README.md` (plugin table, line ~202-203).
- The host dashboard serves the hardware tab through the proxy prefix `/api/hardware` (`python/dashboard/test_plugin_proxy.py`, line ~123-134, and `python/dashboard/test_plugins_manifest.py`, line ~114). The tab slot is `hardware-tab` (`src/resolve-plugin-root.test.js`, line ~61).
- The hardware tab reads `/api/hardware/stats` and `/api/hardware/watch-config` (`Docs/FUNCTION_LENGTH_CANDIDATES.md`, the `renderHardwareTab` notes, line ~6141). The stats payload has a `disk` object (`cur.disk`, line ~6161) and a multi-GPU `gpus` list, produced by `hardware_stats.py` `_gpus()` and the goatmon adapter `gpus` key (`Docs/FUNCTION_LENGTH_CANDIDATES.md` line ~6161; `python/dashboard/plugin_process_manager.py` docstring).
- The host starts and stops slotted plugin processes (`python/dashboard/plugin_process_manager.py`). This is the only existing source of plugin up/down state seen here.
- The gpu-broker tab "GPU Cards" (`agent-manager-gpu-broker`, `README.md` line ~12-14; tab declared in `plugins.json` as `ui/gpu-broker-tab.js`) shows cards, the holder of each card (`held_by`), and the two preferences. Routes: `GET /api/gpu/cards`, `GET|POST /api/gpu/preferences`, `GET /api/health`.
- The dashboard header memory chip reads the gpu-broker marker file (`memory-changed` provider in ADR-0024, S1 status). Its state and reason are shown; the numbers inside the marker are deliberately not announced.
- Watchdog cost and reconcile counts exist in host tooling: `scripts/idle-cost-audit.py` (node/python/git launches per minute and shared-disk IOPS, MB/s, busy percent), `scripts/sweep-idle-cost.js`, and `eventStream.corrections` in `/api/summary` (ADR-0024).
- Queue-cache hit rate is owned by `src/queue-cache.js` (ADR-0024). Whether it exports a counter is not verified.

**Not verified (the two hardware plugin repos are not in `list_roots`, so their own registrations, routes and metric fields could not be read):**

- The exact fields inside `disk`, `gpus` and any memory or swap fields of `/api/hardware/stats`.
- Whether the hardware plugins expose services, token burn or restart times. Assumed not.
- Whether `budget-monitor.js` (host repo root) reports token burn. Not read.

Each row in the Family table below names one owner for each metric. Where the owner is unverified, the row says so.

## Family

| Metric | Owner today | Proposal | Name | Tab | Data source | Refresh cost |
|---|---|---|---|---|---|---|
| Disk and I/O (busy %, IOPS, MB/s) | hardware plugin `disk` object (fields unverified); IOPS measured on demand by `scripts/idle-cost-audit.py` | extend `agent-manager-hardware-plugin` | none (extension) | Hardware tab | `/proc/diskstats`, one read per sample | poll-ok: registers with the existing watchdog clock (ADR-0024 principle 5). Idle cost not measured; must be measured before build. The sample must not scan `queue/`. |
| GPU, VRAM, temperature | hardware plugin `gpus` list (unverified fields) | extend `agent-manager-hardware-plugin` | none (extension) | Hardware tab | nvidia-smi / goatmon, one sample per tick | poll-ok: registers with the existing watchdog clock. nvidia-smi is a process launch per sample, so its idle cost must be measured. |
| Lanes and card holders | gpu-broker `GET /api/gpu/cards` (`held_by`) | no new repo: the GPU Cards tab keeps this | agent-manager-gpu-broker | GPU Cards | gpu-broker routes | Event-driven: acquire and release are writer events on the broker. No poll. |
| Memory and swap | not verified in the hardware plugin; header chip is state only (`memory-changed`) | extend the hardware plugin if its psutil stats already include memory; otherwise a new repo `memforge/mem-plugin` | memforge/mem-plugin (only if new) | Memory | `/proc/meminfo`, `/proc/vmstat` | poll-ok: registers with the existing watchdog clock. Reads are cheap (no disk I/O). |
| Services up/down and last restart | `python/dashboard/plugin_process_manager.py` (plugin processes) | new repo `svcforge/services-plugin` | svcforge/services-plugin | Services | plugin process manager state; systemd unit state if present | Event: a unit or plugin state change (writer announces). If no event exists, poll-ok on the watchdog clock. Idle cost not measured; must be measured before build. |
| Cloud-worker token burn | not verified; `budget-monitor.js` candidate | new repo `tokenforge/token-burn-plugin` | tokenforge/token-burn-plugin | Token burn | usage records written by the cloud worker | Event: writer appends a usage record and announces it. Consumers read only on that event. Existence of the record is assumed; verify. |
| Watchdog tick cost and queue-cache hit rate | `scripts/idle-cost-audit.py`, `eventStream.corrections`, `src/queue-cache.js` | new repo `tickforge/tick-plugin` | tickforge/tick-plugin | Ticks | the watchdog tick-complete point; ADR-0024 reconcile counter | Event: tick complete. No poll. |

No metric appears in more than one row. The disk row covers the `disk` object and IOPS. The GPU row covers VRAM and temperature. Lane and card-holder state is a separate row owned by gpu-broker.

## Shared contract

One JSON sample shape, one history store. Each repo publishes samples; the Systems Monitor view reads only the contract.

Sample (one per line, schema version first):

```json
{"schema": 1, "source": "agent-manager-hardware-plugin", "metric": "disk.busy_pct", "ts": "2026-11-16T10:00:00Z", "value": 100.0, "unit": "percent", "labels": {"device": "sdb"}}
```

Fields: `schema` (integer, bump on any breaking change), `source` (the repo that owns the metric), `metric` (dotted name, unique per source), `ts` (UTC ISO 8601), `value` (number or string), `unit`, `labels` (object, optional).

History store: append-only JSONL, one file per source. Written only when a sample is emitted on an event or a poll-ok interval. Path proposal: `<pipelineDir>/systems-monitor/<source>.jsonl`, kept outside `queue/` (the same reason as the ADR-0024 journal: appends must not move queue directory mtimes). The location is an owner decision.

Each repo plugs into one Systems Monitor view by reading the contract. The view never calls a plugin's internal routes.

## Build order

Smallest first, and the cheapest reads before the saturated disk:

1. This doc.
2. The shared contract, written as the spec in this doc (sample shape and history store), agreed by the owner.
3. Memory and swap (cheapest reads; first decide extension or new).
4. Services up/down and last restart (`svcforge/services-plugin`; events if they exist).
5. GPU, VRAM and temperature (extend the hardware plugin; measure the nvidia-smi launch cost first).
6. Disk and I/O (last of the reads because the disk is saturated; measure `/proc/diskstats` cost first).
7. Cloud-worker token burn (`tokenforge/token-burn-plugin`; depends on the writer event existing).
8. Watchdog tick cost and queue-cache hit rate (`tickforge/tick-plugin`; depends on the ADR-0024 counter and the tick-complete event).

## Open owner decisions

1. Hardware plugin repos: their paths are not in `list_roots`. Give the absolute paths (or confirm they are not on this machine) so the inventory above can be verified.
2. Disk and I/O, GPU, and memory: extend `agent-manager-hardware-plugin`, or split into new repos (`diskforge/disk-io-plugin`, `gpuforge/gpu-plugin`, `memforge/mem-plugin`)?
3. The `Docs/` directory (where this doc lives, as the task names it) versus `docs/` (where the ADRs live). Confirm `Docs/` is the place for design docs.
4. History store location (the proposed `<pipelineDir>/systems-monitor/` path).
5. Whether services and token-burn writer events exist. If not, is a poll-ok on the watchdog clock accepted for them?
6. Acceptable idle cost for nvidia-smi and `/proc/diskstats` sampling, given the disk is already at 100% busy.
7. Final repo names.
