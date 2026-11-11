# Node registry

The machines that make up this Agent Manager (wok, grimm, any machine added later) are listed in a small registry on wok. A machine joins by being registered; it stays visible by sending a heartbeat; a machine that goes quiet raises one urgent notification. This page is the contract the later pieces of the multi-node plan (the heartbeat client, the ledger and leases) rely on.

## Files

Both live in `AGENT_MANAGER_NODES_DIR` (default `$HOME/.local/state/agent-manager/nodes`), outside any repository.

- `nodes.json`: a map `id -> record` `{id, address, cores, ramGb, gpu, allowedProviders, concurrencyCap, pauseRules, lastSeen, lastAddress, state, load, freeRamGb, paused}`, written atomically.
- `nodes-tokens.json`: a map `id -> token`, mode 600. A token is made when a node is registered and printed once. It is never in a node record and never in the dashboard list.

A node id is lowercase letters, digits and dashes, at most 31 characters, not starting with a dash.

## Registering a node

`node src/node-registry.js register grimm --address 192.168.40.83 --cores 4 --ram-gb 15 --gpu "RX 580" --providers claude-haiku,claude-sonnet --cap 3`

It prints `{record, token}` as JSON. Copy the token to the node into a file only that machine's user can read (the heartbeat client reads it from a file, never from the environment or a repository). Running the command again for an existing node updates its details and keeps the token (`token` prints as `null`); add `--rotate` to make a new one. `node src/node-registry.js list` prints every node with its computed status.

## Heartbeat

The heartbeat is received by its own small server, `node src/node-registry-server.js`, **not** by a dashboard route. The dashboard binds loopback by default and, when opened to the LAN, protects every write endpoint with one shared secret; a heartbeat client holding that secret could merge branches. The intake accepts only a heartbeat and checks a per-node token.

- Settings: `AGENT_MANAGER_NODES_BIND` (default `127.0.0.1`; set it to wok's LAN address to accept other machines) and `AGENT_MANAGER_NODES_PORT` (default `7471`).
- `POST /heartbeat` with `Authorization: Bearer <that node's token>` and JSON `{id, address?, state, load, freeRamGb, paused, at}` (`state` is `up` or `off`; `paused` is a boolean). Reply `200 {ok: true, globalPause, serverTime}`.
- `globalPause` is true while a global pause marker (`src/worker-switch.js` `_pause-global`, see "Pausing a machine" in `lanes.md`) is active on wok and was not itself set from wok's heartbeat reply, so a node that applied the pause cannot echo it back.
- Errors: 400 for a body that is not a JSON object, is over 8 KB, or has an unusable field; 401 for a missing or wrong token (the same answer for an unknown node, so ids cannot be probed); 403 when the request does not come from the address the node was registered with (a node registered without an address is accepted from anywhere that holds its token); 404 for any other path; 405 for any other method on `/heartbeat`.

## Status and the stale alert

Status is computed, never stored: `stale` (no heartbeat for `AGENT_MANAGER_NODE_STALE_MIN` minutes, default 5, or never one), `off` (the node reported state `off`), `paused` (it reported its machine pause is active), otherwise `up`.

After every heartbeat the intake calls `sweepStale`, so a heartbeat from any node (wok heartbeats too) checks all the others: an event, not a polling loop. For each node that has been seen before and is stale (not `off`) it sends one urgent notification through `src/notify.js` with the key `stale-node:<id>`; the notifier de-duplicates by key, so a long outage is one message per notifier window, not one per heartbeat. A node that never sent a heartbeat and a node that is off raise nothing.

## Dashboard

`GET /api/nodes` (read-only) returns the list with each node's status, for the Workers tab and status pages.

## Heartbeat client

`node src/node-heartbeat.js` runs on every machine, wok included. One run builds the payload `{id, state: "up", load, freeRamGb, paused, at}` (free RAM is `MemAvailable` from `/proc/meminfo`, which counts reclaimable cache, falling back to `os.freemem()`), POSTs it to the intake and prints one JSON line.

Settings (environment): `AGENT_MANAGER_NODE_ID`, `AGENT_MANAGER_NODE_URL` (the **intake** URL, for example `http://192.168.40.11:7471/heartbeat`, not the dashboard), `AGENT_MANAGER_NODE_TOKEN_FILE` (a file holding the node's token; the token is never read from the environment, never printed or logged, never in a repository), optional `AGENT_MANAGER_NODE_ADDRESS` and `AGENT_MANAGER_NODE_TIMEOUT_MS` (default 5000). Missing settings or an unreadable or empty token file exit 2 so a timer shows the unit as failed.

The reply's `globalPause` is applied to this machine's markers: true sets a global pause with source `wok` and a 3 minute expiry that every heartbeat refreshes, so it ends by itself if wok stops answering; false clears the global pause only when its source is `wok`. A global pause set here by anyone else is never overwritten or cleared, and the node pause is never touched. A POST that cannot be made, a non-2xx answer or a reply that is not JSON changes nothing and still exits 0.

Setting up a machine (the owner's steps, nothing here is automatic): register it on wok (`node src/node-registry.js register grimm --address <its LAN address> ...`), copy the printed token into a file on that machine that only its user can read (`chmod 600`), and run the heartbeat every minute with a systemd user timer (example, not enabled):

```ini
# ~/.config/systemd/user/am-node-heartbeat.service
[Unit]
Description=Agent Manager node heartbeat
[Service]
Type=oneshot
Environment=AGENT_MANAGER_NODE_ID=grimm
Environment=AGENT_MANAGER_NODE_URL=http://192.168.40.11:7471/heartbeat
Environment=AGENT_MANAGER_NODE_TOKEN_FILE=%h/.config/agent-manager/node-token
ExecStart=/usr/bin/node /path/to/agent-manager/src/node-heartbeat.js

# ~/.config/systemd/user/am-node-heartbeat.timer
[Unit]
Description=Agent Manager node heartbeat, every minute
[Timer]
OnBootSec=30
OnUnitActiveSec=60
[Install]
WantedBy=timers.target
```

Enable with `systemctl --user enable --now am-node-heartbeat.timer`.

## Running the intake (example, not installed)

```ini
# ~/.config/systemd/user/am-node-intake.service
[Unit]
Description=Agent Manager node registry intake
[Service]
Environment=AGENT_MANAGER_NODES_BIND=192.168.40.11
Environment=AGENT_MANAGER_PIPELINE_DIR=/media/model-cache/github/agent-manager
Environment=AGENT_MANAGER_NOTIFY_URL=http://<wok tailnet address>:<port>/agentmanager
ExecStart=/usr/bin/node /media/model-cache/github/agent-manager/src/node-registry-server.js
Restart=on-failure
[Install]
WantedBy=default.target
```

Not enabled by any code. Opening the intake to the LAN, registering grimm and starting the heartbeat client are separate owner-approved steps.
