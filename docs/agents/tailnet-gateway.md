# Tailnet gateway: the whole platform from your phone, owner-only

`scripts/tailnet-gateway.js` lets your own devices (a phone on the same Tailscale tailnet) use the dashboard AND every plugin tab, and
refuses everyone else on the tailnet. Added 2026-10-14.

## Why not just `tailscale serve`

The dashboard trusts **loopback** as "the owner" (`lan_mutation_gate` in `python/dashboard/app.py`: mutating requests from non-loopback
callers need `AGENT_MANAGER_DASHBOARD_TOKEN`). `tailscale serve` proxies from loopback, so **everything behind it is reachable, token-less,
by any device the tailnet's access rules let in**. Verified 2026-10-14: a POST with no token through the `ts.net` name returned 200. The
tailnet here (`gypsy46n2.github`) also contains another account's devices. The plugin tabs also load `http://<hostname>:<port>`, which
loopback-only plugins do not serve to a phone (and an `http` frame inside an `https` page is blocked).

## What it does

- Listens ONLY on this machine's Tailscale address (`tailscale ip -4`; it refuses any other address) on the dashboard port and every plugin
  port from `plugins.json`, and forwards to `127.0.0.1:<same port>`. Plain TCP, so no plugin needs changes and there is no path rewriting.
- For each connection it asks tailscaled who the caller is (`tailscale whois --json <ip>`) and forwards only callers whose login is in
  `AGENT_MANAGER_TAILNET_OWNERS`. Everyone else is closed before a byte reaches Agent Manager; denials are logged with the login.
- Fails closed: no owners configured, a non-Tailscale bind address, a tagged device (no user), or any whois error all mean refuse.
- Answers are cached per address (allow 60 s, deny 10 s, whois error 5 s). `plugins.json` is re-read every 60 s, so a new plugin's port is
  opened without a restart.
- The phone opens `http://<tailnet ip>:7420` (or `http://<host>.<tailnet>.ts.net:7420`). Plain HTTP, but it rides the encrypted tunnel.

## Run it

    AGENT_MANAGER_TAILNET_OWNERS=you@example.com node scripts/tailnet-gateway.js

As a service: `scripts/systemd/agent-manager-tailnet-gateway.service` (instructions in its header). Other env: `AGENT_MANAGER_DASHBOARD_PORT`
(7420), `AGENT_MANAGER_PLUGINS_PATH`, `AGENT_MANAGER_TAILNET_EXTRA_PORTS`, `AGENT_MANAGER_TAILNET_BIND` (must still be a Tailscale address).
Tests: `node --test scripts/tailnet-gateway.test.js` (whois and the network are stubbed; no tailscale needed).

## What a plugin sees from a gateway caller

The gateway forwards plain TCP, so a plugin behind it sees every admitted caller as `127.0.0.1` with NO proxy header (`X-Forwarded-For`, `Forwarded` and `X-Real-IP` are never added). A plugin's own "loopback only" write check (for example PromptForge's `loopback_only` in `server/core/jobs_routes.py`) therefore passes for the owner's other machine: the owner's logins are the trust boundary, and no per-plugin allowlist, token or IP check is needed for a second machine (grimm) to file jobs or start runs on wok. Verified 2026-11-20: from grimm, `POST http://<wok tailnet ip>:7430/api/jobs` with an empty body returned 400 (accepted, nothing filed), and the same request with an `X-Forwarded-For` header returned 403.

Debugging a refused write from another machine: read `~/.local/state/agent-manager/logs/plugin-<name>.log` for the source address the plugin saw (127.0.0.1 means the gateway admitted it and the refusal is the plugin's own logic), and run `ss -ltnp` to see which process owns the tailnet listener.

Known weakness: a plugin that parses JSON with `get_json(force=True)` and does not check the `Origin` header accepts a cross-site POST from a web page open in a browser on an admitted machine. Plugins with write routes should reject a request whose `Origin` host differs from its `Host`.

## Known gaps

- A plugin that already binds `0.0.0.0` on its port (seen 2026-10-14: the goatmon plugin on 7441) cannot be fronted: the gateway logs
  `SKIPPED :<port> (EADDRINUSE)`. That plugin is already reachable, unauthenticated, from every interface including the LAN; bind it to
  127.0.0.1 and the gateway will pick the port up on its next rescan.
- The existing `tailscale serve` HTTPS front for the dashboard is NOT removed by this change and still bypasses the token. Turn it off
  (`tailscale serve reset`) once nothing depends on it (the Android companion app did, from 2026-08-24).
- Tailnet access rules are the other layer: restrict this machine to your own devices in the Tailscale admin console if you can.
- Callers are identified per source address, so anything running on another owner device (not just a browser) is trusted too.
