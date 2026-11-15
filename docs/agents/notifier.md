# Owner notifier

`src/notify.js` is the one call Agent Manager (and anything next to it) makes to reach the owner's phone. It replaces "the owner looks at the portal" for the few conditions that need a person. The older `_fire_alert_webhook` in `python/dashboard/app.py` still exists and is untouched; it only fires when something polls `GET /api/alerts`.

## Levels

| Level | When | How it is sent |
|---|---|---|
| `urgent` | a machine down, an auto-pause stuck, a repair limit hit, a queue stalled | at once, priority `urgent` |
| `summary` | the one daily message (`src/notify-summary.js`) | priority `default`, once per local day |
| `routine` | everything else | never sent; one line in the log |

Noise control: the same `key` is not sent again inside its window (urgent 60 minutes, summary 20 hours) and urgent messages are capped per hour, so a flapping condition produces one message. A failed send is not remembered, so the next trigger retries it. `notify()` never throws.

## Calling it

From node: `const { notify } = require('./notify.js'); await notify({ level: 'urgent', key: 'stale-node:grimm', title: 'grimm is not answering', text: 'last seen 12 min ago' });`

From a shell script: `node src/notify.js --level urgent --key stale-node:grimm --title "grimm is not answering" --text "last seen 12 min ago"` (prints the outcome as JSON; exit code 2 only for a usage error).

Pick a stable `key` per condition (the thing that is wrong, not the time), put ids and short titles in `title`, and never put live client data in `text`.

## Settings (environment)

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_MANAGER_NOTIFY_URL` | unset = nothing is sent | the ntfy-compatible topic URL |
| `AGENT_MANAGER_NOTIFY` | on | `false` is the kill switch |
| `AGENT_MANAGER_NOTIFY_DEDUPE_MIN` | 60 | urgent window per key, minutes |
| `AGENT_MANAGER_NOTIFY_SUMMARY_WINDOW_HOURS` | 20 | summary window per key, hours |
| `AGENT_MANAGER_NOTIFY_MAX_PER_HOUR` | 6 | urgent messages per hour |
| `AGENT_MANAGER_NOTIFY_SUMMARY_HOUR` | 8 | earliest local hour for the daily summary |
| `AGENT_MANAGER_NOTIFY_DIR` | `<pipeline dir>/notify` | where state and log live |
| `AGENT_MANAGER_NOTIFY_TIMEOUT_MS` | 5000 | per-post timeout |

State is `notify-state.json` (written atomically) and `notify-log.jsonl` (when, level, key, title, outcome; never the message body) in that directory. Outcomes: `sent`, `duplicate`, `rate-limited`, `routine`, `no-url`, `unknown-level`, `error`.

## Owner steps (not done by the code)

1. Run a self-hosted ntfy server on wok, reachable over the tailnet only, so no third party sees task titles. Follow ntfy's own install documentation (https://docs.ntfy.sh); the server settings that matter are its `base-url` (the tailnet address of wok) and `listen-http`.
2. Install the ntfy app on the Pixel (already on the tailnet), point it at that server and subscribe to a topic, for example `agentmanager`.
3. Set `AGENT_MANAGER_NOTIFY_URL=http://<wok tailnet address>:<port>/agentmanager` where the pipeline's environment is defined, and test: `node src/notify.js --level urgent --key test --title "notifier test"`.

## Daily summary timer (example, not installed)

`node src/notify-summary.js` is safe to run as often as you like: it sends only after the summary hour and only once per local day. A systemd user timer that runs it hourly:

```ini
# ~/.config/systemd/user/am-notify-summary.service
[Unit]
Description=Agent Manager daily summary
[Service]
Type=oneshot
Environment=AGENT_MANAGER_PIPELINE_DIR=/media/model-cache/github/agent-manager
Environment=AGENT_MANAGER_NOTIFY_URL=http://<wok tailnet address>:<port>/agentmanager
ExecStart=/usr/bin/node /media/model-cache/github/agent-manager/src/notify-summary.js

# ~/.config/systemd/user/am-notify-summary.timer
[Unit]
Description=Agent Manager daily summary, hourly check
[Timer]
OnCalendar=hourly
Persistent=true
[Install]
WantedBy=timers.target
```

Enable with `systemctl --user enable --now am-notify-summary.timer`. It is not enabled by the code.

## Stuck-task notifier (premium tasks in blocked / needs-clarification)

`src/stuck-task-notifier.js` watches the `blocked/` and `needs-clarification/` directories under the home queue (and every pooled project queue, when `--pool-queues` is passed) and pings the owner the moment a **premium** task lands in one of them. Non-premium entries are ignored; the existing pile is recorded silently on first run so it does not flood the phone.

Triggered by `src/wait-for-change.js` (fs.watch / inotify), not by a timer. The 600-second `--timeout` is the only safety net and is documented on its own line in the source; on timeout the loop only re-checks in-memory pending keys, never rescanning the directory.

### Running it

One-shot (useful for testing):

```sh
node src/stuck-task-notifier.js /media/model-cache/github/agent-manager/queue
```

Drain mode (long-running, the production path):

```sh
node src/stuck-task-notifier.js --drain \
  --home-queue /media/model-cache/github/agent-manager/queue \
  --seen /media/model-cache/github/agent-manager/.stuck-task-seen.json \
  --pool-queues
```

`--seen` defaults to `<cwd>/.stuck-task-seen.json`. `--timeout` defaults to 600 seconds.

### systemd user service (example, not installed)

```ini
# ~/.config/systemd/user/am-stuck-notifier.service
[Unit]
Description=Agent Manager stuck-task notifier
After=network-online.target

[Service]
Type=simple
Environment=AGENT_MANAGER_PIPELINE_DIR=/media/model-cache/github/agent-manager
Environment=AGENT_MANAGER_NOTIFY_URL=http://<wok tailnet address>:<port>/agentmanager
ExecStart=/usr/bin/node /media/model-cache/github/agent-manager/src/stuck-task-notifier.js --drain \
  --home-queue /media/model-cache/github/agent-manager/queue \
  --seen /media/model-cache/github/agent-manager/.stuck-task-seen.json \
  --pool-queues
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
```

Enable with `systemctl --user enable --now am-stuck-notifier.service`. It is not enabled by the code.

### Noise control

`notify()` dedupes the same `stuck:<state>:<taskId>` key for 60 minutes (the `urgent` window in `src/notify.js`). A task that re-enters `blocked` within 60 minutes of its last notification will be reported as `duplicate` and never reach the phone. The seen file still treats it as new (its mtime changed), so the next trigger will try again. Force a resend by deleting and recreating the task file, or by waiting out the window.

Idle wake rate on an idle queue: 1 wake per 600 seconds (one per timeout interval), measured by running `--drain` against an empty `blocked/` and `needs-clarification/` for one hour and counting timeout events. That is ~144 idle wakes per day per home queue; pooled queues add one wake per timeout per extra project.

