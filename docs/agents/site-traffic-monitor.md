# Site traffic monitor (grimm)

`src/site-traffic-monitor.js` pauses a machine's Agent Manager workers while the Property Forager site on it is in use, so the people using the site get the machine, and lets the work resume when they are gone. It sets and clears the node pause of `src/worker-switch.js` (see "Pausing a machine" in `lanes.md`), so `scripts/local-worker.sh` needs no change: a paused machine's workers claim nothing new and finish what they are on.

## The signal, and why it is sockets

There is no request log to read: grimm's front door (`pf-web`, a plain node server on port 8080) proxies to the public backend (`pf-public`, port 3002) and logs nothing, and the admin port is 3010. So the monitor counts sockets in state `ESTAB` or `TIME-WAIT` whose **local** port is 8080, 3002 or 3010, read with `ss -tanH`. Measured on 2026-11-11, an idle grimm has none, and TIME-WAIT keeps a request visible for about a minute after its connection closes, so a short request is not missed between passes. Connections that grimm makes to other machines (local port elsewhere) and listening sockets are not counted. Anyone using the site counts, the owner included.

## What each pass does (every 10 seconds)

| Situation | Action |
|---|---|
| any such socket | `setPause('node', {source: "site-traffic", reason: "site in use", ttlMin: 10})`, refreshing the 10 minute expiry |
| none for `AGENT_MANAGER_SITE_IDLE_MIN` minutes (default 5) | clear the node pause, **only if its source is `site-traffic`** |
| load average above `AGENT_MANAGER_SITE_MAX_LOAD` (default 3.0) or free RAM below `AGENT_MANAGER_SITE_MIN_FREE_GB` (default 3, `MemAvailable`) | pause with source `site-backstop`; cleared when both are back under the limits |
| `ss` cannot be read | change nothing and log it once: a failed read is not "idle" |
| a node pause, of any source, seen continuously for more than `AGENT_MANAGER_SITE_STUCK_HOURS` (default 6) | one urgent notification through `src/notify.js`, key `pause-stuck:<hostname>` |

A pause someone else set on the machine (the operator's, for example) is never overwritten and never cleared. A backstop pause is replaced by a traffic pause; a traffic pause is not replaced by a backstop one.

**It cannot leave a machine paused.** Every pause the monitor sets carries a 10 minute expiry that each pass refreshes, so a dead monitor's pause ends by itself, and a graceful stop (SIGTERM or SIGINT) clears its own pause at once. The stuck-alert clock is in memory, so restarting the monitor restarts it.

Logging is one line per state change (paused, resumed, backstop on or off, `ss` failing or working again, stuck, stopped), never one per pass.

## Running it

- `node src/site-traffic-monitor.js`: the loop (`AGENT_MANAGER_SITE_POLL_S`, default 10 seconds).
- `node src/site-traffic-monitor.js --once`: one pass, prints the result as one JSON line on stdout, for tests and cron. The log lines go to stderr (the systemd journal keeps both streams).

It runs on the machine whose site it watches (grimm). Deploying it there is a separate, owner-approved step; nothing starts it automatically. A systemd service example (not installed), run as the user whose workers it should pause:

```ini
# ~/.config/systemd/user/am-site-traffic-monitor.service
[Unit]
Description=Agent Manager site traffic monitor
[Service]
Environment=AGENT_MANAGER_PIPELINE_DIR=/path/to/agent-manager
Environment=AGENT_MANAGER_NOTIFY_URL=http://<wok tailnet address>:<port>/agentmanager
ExecStart=/usr/bin/node /path/to/agent-manager/src/site-traffic-monitor.js
Restart=on-failure
[Install]
WantedBy=default.target
```

`AGENT_MANAGER_NOTIFY_URL` is only needed for the stuck alert (see `notifier.md`). Enable with `systemctl --user enable --now am-site-traffic-monitor.service`.
