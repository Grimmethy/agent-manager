# Multi-node runbook: unattended rules, trial, ramp and addresses

How to run the two-machine Agent Manager (wok and grimm) without watching it. The parts are described in `multi-node.md`; this page is what the owner does and what the system promises while nobody is looking. **Nothing here starts by itself**: every command below is run by the owner.

## 1. The unattended rules

1. **Nothing starts by itself on wok or grimm.** No server, timer, worker, lend or relay is started by code. The owner starts them. `multi-node.md` lists the commands.
2. **Pauses stop new claims at once.** `node src/worker-switch.js pause node` pauses one machine, `pause global` pauses the whole system (`resume <node|global>` ends it, `pause-status` shows it); see "Pausing a machine" in `lanes.md`. A pause with an expiry ends by itself and a broken marker counts as not paused, so a dead tool can never leave a machine stuck.
3. **grimm gives way to the website.** `node src/site-traffic-monitor.js` pauses grimm's node while the site is in use and clears only its own pause after the idle time (`site-traffic-monitor.md`). It also pauses on load or low RAM (`AGENT_MANAGER_SITE_MAX_LOAD`, `AGENT_MANAGER_SITE_MIN_FREE_GB`).
4. **The cloud lane stays off until the owner turns it on**, and while it is on it claims nothing once the gateway's hourly token budget is spent (`src/gateway-budget.js`; `cloud-lane.md`, "What went wrong on the lane, and the budget check").
5. **Work is only claimed on its own node.** A task leased to grimm is never claimed on wok and the other way round (`src/node-affinity.js`).
6. **Leases end.** A lease lasts 6 hours (`AGENT_MANAGER_LEASE_TTL_MS`). `node src/lend-task.js reclaim` expires due leases and takes the tasks back; it is run by the owner (nothing runs it on a schedule yet).
7. **Packages never contain live client data.** A review package drops votes, history and any token, secret or password key (`src/review-package.js`); the work itself travels as a branch.
8. **Merges and deploys stay with the verified flow.** A relayed branch is reviewed, verified and merged as any other. Nothing deploys to grimm by code.
9. **The owner hears about exceptions, plus one summary a day.** Urgent messages for a machine that went quiet or a pause that is stuck; one daily summary (`notifier.md`; the hourly timer in its "Daily summary timer" section is an example, not installed).
10. **Tokens live in files** (mode 600), never in the environment, a repository or a log.

## 2. The trial (the 80 percent bar)

Before the farm is scaled up, run a small batch of real tasks through one node and score it.

1. Lend each task (`node src/lend-task.js lend <taskId> grimm --url <node intake /lend url> --token-file <file>`), let the node build it, and when its package arrives relay the branch (`node src/branch-relay-cli.js <taskId> --node-url <node repo url>`), then review and merge as usual.
2. Write one outcome per task into a JSON file: `[{"taskId": "...", "node": "grimm", "result": "merged"}]`, where `result` is `merged` (merged with no repair), `repaired` (merged after a repair), `failed` or `abandoned`.
3. Score it: `node src/farm-trial.js <outcomes.json>`. It prints the counts per node and exits 0 when at least 80 percent were `merged`, 3 when not.

## 3. The ramp (how many workers a node can take)

Raise the number of workers on a node one at a time and measure after each step. `node src/farm-ramp.js` only prints a decision; the owner starts or stops the workers.

1. Baseline, with no farm running: `node src/farm-ramp.js baseline --site-url <the site's address>` (the median of three timed requests, plus the load average and free RAM). Keep the `siteMs` value.
2. After each change in workers: `node src/farm-ramp.js step --workers <n> [--cap <n>] --baseline-ms <siteMs> --site-url <address> [--rate-limited]`.
3. The decision: `raise` (no limit hit, go one worker higher), `hold` (at the cap), or `stop`. The limits are the site more than 20 percent slower than baseline, load average above 3.0, free RAM below 3 GB, or a rate limit from the cloud gateway (pass `--rate-limited`). On `stop` the cap is one below the worker count that broke a limit; keep it as the node's concurrency cap (`--cap` in `node src/node-registry.js register`).
4. A value that cannot be measured (the site not answering, no `/proc/meminfo`) counts as a limit.

## 4. LAN addresses

Machine-to-machine traffic uses the wired LAN address, with the tailnet address as the fallback.

1. **Owner step: reserve a fixed LAN address for each machine** in the router, so the address in the registry does not change.
2. Register the node with that address: `node src/node-registry.js register grimm --address <LAN address> ...` (see `nodes.md`).
3. To see which address answers a service right now: `node src/node-address.js <LAN address> <tailnet address> <port>`. It prints `{address, via}` with `via` `lan`, `tailnet` or `null`, and exits 3 when neither answers (use `""` for an address you do not have).

## 5. Morning checklist (two minutes)

1. Was there an urgent message, or is the daily summary missing? A missing summary means the summary timer or the notifier is not running.
2. `node src/worker-switch.js pause-status` on each machine: is a pause still set that you did not expect?
3. `node src/lease-ledger.js list`: any lease still `lent` past its expiry? Run `node src/lend-task.js reclaim`.
4. `ls <pipeline dir>/queue/node-packages`: any package that arrived and was not relayed? Relay it with `node src/branch-relay-cli.js`.
5. On the Workers tab: are the cloud lane and grimm's workers in the state you left them?

## 6. Not built yet

- A loop that applies a ramp decision to the workers: today the owner reads the decision and changes the workers.
- A timer that runs `node src/lend-task.js reclaim`, a command that lends the next waiting task automatically, and a command that relays a package when it arrives.
- Automatic scale-up after a passing trial; the trial score is read by the owner.
- The cloud lane's Sonnet escalation, concurrency back-off and the unexplained liveness-probe 401s (see `cloud-lane.md`).
