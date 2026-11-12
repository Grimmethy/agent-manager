# Multi-node runbook: unattended rules, trial, ramp and addresses

How to run the two-machine Agent Manager (wok and grimm) without watching it. The parts are described in `multi-node.md`; this page is what the owner does and what the system promises while nobody is looking. **Nothing here starts by itself**: every command below is run by the owner.

## 1. The unattended rules

1. **Nothing starts by itself on wok or grimm.** No server, timer, worker, lend or relay is started by code. The owner starts them. `multi-node.md` lists the commands.
2. **Pauses stop new claims at once.** `node src/worker-switch.js pause node` pauses one machine, `pause global` pauses the whole system (`resume <node|global>` ends it, `pause-status` shows it); see "Pausing a machine" in `lanes.md`. A pause with an expiry ends by itself and a broken marker counts as not paused, so a dead tool can never leave a machine stuck.
3. **grimm gives way to the website.** `node src/site-traffic-monitor.js` pauses grimm's node while the site is in use and clears only its own pause after the idle time (`site-traffic-monitor.md`). It also pauses on load or low RAM (`AGENT_MANAGER_SITE_MAX_LOAD`, `AGENT_MANAGER_SITE_MIN_FREE_GB`).
4. **The cloud lane stays off until the owner turns it on**, and while it is on it claims nothing once the gateway's hourly token budget is spent (`src/gateway-budget.js`; `cloud-lane.md`, "What went wrong on the lane, and the budget check").
5. **Work is only claimed on its own node.** A task leased to grimm is never claimed on wok and the other way round (`src/node-affinity.js`).
6. **Leases end.** A lease lasts 6 hours (`AGENT_MANAGER_LEASE_TTL_MS`). `node src/lend-task.js reclaim` expires due leases and takes the tasks back; it is run by the owner (nothing runs it on a schedule yet).
7. **Packages never contain live client data.** A record package drops votes, history, the lease stamp and any token, secret or password key (`src/review-package.js`); the work itself is the record's `rawDiff`.
8. **Merges and deploys stay with the verified flow, and a node never merges, pushes or deploys.** A node's record lands in wok's `queue/review/` and is reviewed, applied, verified and merged as any other task; GitHub credentials never go on a node. Nothing deploys to grimm by code.
9. **The owner hears about exceptions, plus one summary a day.** Urgent messages for a machine that went quiet or a pause that is stuck; one daily summary (`notifier.md`; the hourly timer in its "Daily summary timer" section is an example, not installed).
10. **Tokens live in files** (mode 600), never in the environment, a repository or a log.

## 2. Setting up a node

The owner's steps, in order. Nothing here starts by itself.

1. **On the node:** `scripts/provision-node.sh <node-id> <pipeline-dir> <node-repo-dir>`. It refuses the id `wok`, an id that is not lowercase letters, digits and dashes (up to 31 characters, not starting with a dash) and a directory that is not an absolute path of plain characters. It creates `queue/{pending,adhoc,drafting,review,blocked,needs-clarification,done,node-outbox,node-sent}`, `task-domains.json`, a `lanes.json` holding only the cloud lane, **disabled**, and `node.env` (`AGENT_MANAGER_NODE_ID`, `AGENT_MANAGER_PIPELINE_DIR`, `AGENT_MANAGER_REPO_ROOT`, `AGENT_MANAGER_DOMAINS_PATH`). It never writes a token and starts nothing; running it again keeps what exists.
2. **Register the node on wok and put the token files in place** (section 5 and `nodes.md`): `node src/node-registry.js register <node-id> --address <LAN address> ...`, then copy the printed token into a mode 600 file on the node.
3. **Start the node's workers** with `node.env` in their environment (`set -a; source <pipeline-dir>/node.env; set +a`, then the ordinary `scripts/local-worker.sh <instance-id>`). A worker whose `AGENT_MANAGER_NODE_ID` is not `wok` claims only work leased to its node and files a finished draft in `queue/node-outbox/`. The cloud lane stays off until you set `enabled` to `true` in `lanes.json` (`cloud-lane.md`).
4. **Send the outbox** by hand or from a timer you create: `node src/node-package-send.js --url <wok package intake url> --token-file <file> --node-id <node-id> --outbox <pipeline-dir>/queue/node-outbox`. It prints `{sent, failed, remaining}`; exit 3 means a record stayed in the outbox. Nothing runs it on a schedule.
5. **On wok, start the package intake** with `AGENT_MANAGER_PIPELINE_DIR` set and `AGENT_MANAGER_PACKAGE_BIND` set to wok's LAN address (port 7473 unless `AGENT_MANAGER_PACKAGE_PORT` says otherwise): `node src/package-intake-server.js`. This opens a port on wok to the LAN, so it needs your OK, like the registry service.

A node never merges, pushes or deploys: its output is a record that wok reviews.

## 2a. Giving a node the gateway and a repo copy

A node has no GitHub access, so a repo reaches it as a bundle file, and the cloud-model gateway (the `cloud-providers` repo, see `cloud-lane.md`) is installed the same way. The three scripts only read or write plain files: none runs `systemctl`, `claude`, `ssh` or `scp`, none contacts a network, none writes a key or token. Every step below is yours.

1. **On wok, export the repo:** `scripts/export-repo-bundle.sh /media/model-cache/github/agent-manager <out-dir>`. It checks the bundle with `git bundle verify` and prints one line, `bundle=<path> sha=<40 hex> branch=master`. A third argument names another branch; the `cloud-providers` repo's branch is `main`, so for the gateway run `scripts/export-repo-bundle.sh /media/model-cache/github/cloud-providers <out-dir> main`. It reads the repo only.
2. **Copy the bundle files to the node** with `scp` (or any copy you trust).
3. **On the node, import the repo:** `scripts/import-repo-bundle.sh <bundle-file> <node-repo-dir>` (add the branch name for `main`). A missing or empty directory is cloned and the clone has **no remote** (nothing to push to, no credential to hold) and the identity `agent-manager-node`. Running it again with a newer bundle fast-forwards the clone; exit 3 means the clone has uncommitted changes, is on another branch, or has history the bundle does not (nothing is changed). It prints `head=<sha> dest=<path>`. Use `<node-repo-dir>` as the repo directory you gave `scripts/provision-node.sh`.
4. **Import the gateway the same way**, for example into `~/cloud-providers` on the node.
5. **Write the gateway unit:** `scripts/provision-node-gateway.sh <cloud-providers-dir> ~/.config/systemd/user` (an optional third argument is the port, default 7450). It refuses anything that is not an absolute path or a port from 1024 to 65535. It writes `am-cloud-gateway.service`, which runs the gateway on the logged-in Claude account **without** the confirmation, and `am-cloud-gateway.confirm-subscription.conf.example`, a template that systemd does not read. The gateway refuses to start without the confirmation.
6. **Your decisions and commands** (the scripts do none of them): run `claude auth login` on the node; copy the template to `~/.config/systemd/user/am-cloud-gateway.service.d/confirm-subscription.conf` **only if you accept** that Anthropic's consumer terms may not permit automated use of a Pro login (`cloud-lane.md`, "Billing"); then `systemctl --user daemon-reload` and `systemctl --user enable --now am-cloud-gateway.service`; check `curl http://127.0.0.1:7450/health`; and last set `enabled` to `true` on the cloud lane in `<pipeline-dir>/lanes.json` and restart the node's workers.

## 3. The trial (the 80 percent bar)

Before the farm is scaled up, run a small batch of real tasks through one node and score it.

1. Lend each task (`node src/lend-task.js lend <taskId> grimm --url <node intake /lend url> --token-file <file>`), let the node draft it, send its outbox (`node src/node-package-send.js`, section 2), and when the record arrives in wok's `queue/review/` review and merge it as usual.
2. Write one outcome per task into a JSON file: `[{"taskId": "...", "node": "grimm", "result": "merged"}]`, where `result` is `merged` (merged with no repair), `repaired` (merged after a repair), `failed` or `abandoned`.
3. Score it: `node src/farm-trial.js <outcomes.json>`. It prints the counts per node and exits 0 when at least 80 percent were `merged`, 3 when not.

## 4. The ramp (how many workers a node can take)

Raise the number of workers on a node one at a time and measure after each step. `node src/farm-ramp.js` only prints a decision; the owner starts or stops the workers.

1. Baseline, with no farm running: `node src/farm-ramp.js baseline --site-url <the site's address>` (the median of three timed requests, plus the load average and free RAM). Keep the `siteMs` value.
2. After each change in workers: `node src/farm-ramp.js step --workers <n> [--cap <n>] --baseline-ms <siteMs> --site-url <address> [--rate-limited]`.
3. The decision: `raise` (no limit hit, go one worker higher), `hold` (at the cap), or `stop`. The limits are the site more than 20 percent slower than baseline, load average above 3.0, free RAM below 3 GB, or a rate limit from the cloud gateway (pass `--rate-limited`). On `stop` the cap is one below the worker count that broke a limit; keep it as the node's concurrency cap (`--cap` in `node src/node-registry.js register`).
4. A value that cannot be measured (the site not answering, no `/proc/meminfo`) counts as a limit.

## 5. LAN addresses

Machine-to-machine traffic uses the wired LAN address, with the tailnet address as the fallback.

1. **Owner step: reserve a fixed LAN address for each machine** in the router, so the address in the registry does not change.
2. Register the node with that address: `node src/node-registry.js register grimm --address <LAN address> ...` (see `nodes.md`).
3. To see which address answers a service right now: `node src/node-address.js <LAN address> <tailnet address> <port>`. It prints `{address, via}` with `via` `lan`, `tailnet` or `null`, and exits 3 when neither answers (use `""` for an address you do not have).

## 6. Morning checklist (two minutes)

1. Was there an urgent message, or is the daily summary missing? A missing summary means the summary timer or the notifier is not running.
2. `node src/worker-switch.js pause-status` on each machine: is a pause still set that you did not expect?
3. `node src/lease-ledger.js list`: any lease still `lent` past its expiry? Run `node src/lend-task.js reclaim`.
4. `ls <pipeline dir>/queue/node-packages` and `ls <pipeline dir>/queue/review`: a record package that arrived is already filed in `queue/review/` by the intake and needs no relay; only an old version 1 branch package would still need `node src/branch-relay-cli.js`.
5. On the Workers tab: are the cloud lane and grimm's workers in the state you left them?
6. On the node: `ls <node pipeline dir>/queue/node-outbox`. Records still there were drafted and not sent; run `node src/node-package-send.js`.

## 7. Not built yet

- A loop that applies a ramp decision to the workers: today the owner reads the decision and changes the workers.
- A timer that runs `node src/lend-task.js reclaim`, a timer that runs `node src/node-package-send.js`, and a command that lends the next waiting task automatically.
- Anything that moves a repo or the gateway for you: the export, copy, import and unit-writing steps of section 2a are run by hand, and the gateway's confirmation, its login and its start are yours.
- Automatic scale-up after a passing trial; the trial score is read by the owner.
- The cloud lane's Sonnet escalation, concurrency back-off and the unexplained liveness-probe 401s (see `cloud-lane.md`).
