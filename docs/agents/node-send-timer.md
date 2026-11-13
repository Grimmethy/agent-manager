# Send timer for a node (example systemd user units)

This page gives example systemd user units that run the node send command every 2 minutes. Nothing in the repository creates, installs or enables these units. The owner writes them and enables them by hand. The runbook (docs/agents/multi-node-runbook.md) says the same: nothing runs the send command on a schedule.

## Prerequisites

- A node checkout at `<node repo path>`.
- Node.js at `/usr/bin/node`. Change the `ExecStart` line if your node binary lives elsewhere.
- The node token in a file at `%h/.config/agent-manager/node-token` (`%h` is your home directory). The file holds only the token.
- Wok's package intake running and reachable: `node src/package-intake-server.js` on wok, default port 7473, endpoint `/package`. See docs/agents/multi-node-runbook.md.
- The node's outbox directory: `<pipeline-dir>/queue/node-outbox`.

## am-node-send.service

```
[Unit]
Description=Send drafted records from the node outbox to wok

[Service]
Type=oneshot
WorkingDirectory=<node repo path>
ExecStart=/usr/bin/node src/node-package-send.js --url http://<wok LAN address>:7473/package --token-file %h/.config/agent-manager/node-token --node-id <node-id> --outbox <pipeline-dir>/queue/node-outbox
Nice=10
```

## am-node-send.timer

```
[Unit]
Description=Run the node send every 2 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=2min

[Install]
WantedBy=timers.target
```

poll-ok: owner-requested 2-minute schedule per task spec; documentation only, nothing in the repository enables it; idle cost not measured in this pass.

This timer is a poll. An event-driven alternative is a systemd `.path` unit watching the outbox directory, which would start the service when a record appears. Choosing that is for the owner; it is not implemented here.

## Install (by the owner)

Place both files in `~/.config/systemd/user/`, then run:

```
systemctl --user daemon-reload
systemctl --user enable --now am-node-send.timer
```

## Output and exit codes

Each run prints one JSON line `{sent, failed, remaining}`: `sent` is the number of records moved to `node-sent/`, `failed` is the number that stayed in the outbox, and `remaining` is the number still in the outbox.

- Exit 0: nothing failed.
- Exit 2: a missing argument, an unreadable or empty token file, or an outbox that is not a directory. Usage is printed on stderr.
- Exit 3: at least one record failed. It stays in the outbox and is retried on the next run.

## Token

The token is read from the file named by `--token-file` and is never printed or logged. Keep that file readable only by you.

## Last run

```
journalctl --user -u am-node-send.service -n 20
```
