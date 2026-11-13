# Starting one cloud worker on a node, by hand

For the owner of a node (a machine that drafts tasks for wok; see `multi-node-runbook.md` section 2). This page starts ONE worker, the cloud lane `worker-cloud`, by hand. Nothing here starts by itself, and nothing here touches git.

**Runtime files.** `<pipeline-dir>/node.env` and `<pipeline-dir>/lanes.json` are runtime files outside the repository. `<pipeline-dir>` is the node's pipeline directory given to `scripts/provision-node.sh`. Write them with that prefix every time.

## 1. Environment

Run these from the repository root, in the same shell you use for the worker:

1. Load the node's settings: `set -a; source <pipeline-dir>/node.env; set +a`
2. Point the lane registry at the node's file. Skip this step if `<pipeline-dir>/node.env` already sets it: `export AGENT_MANAGER_LANES_PATH=<pipeline-dir>/lanes.json`. `src/lanes.js` reads that variable.
3. Set the gateway address: `export MODEL_URL=<gateway address>`, for example `http://127.0.0.1:7450` (the default port in `multi-node-runbook.md` section 2a). `scripts/orc-common.sh` exits with status 64 when `MODEL_URL` is empty, and only checks that it is non-empty. The lane's own endpoint comes from its lane environment (step 2 below).

## 2. The lane's own environment

The lane's endpoint and model come from the registry entry for `worker-cloud` in `<pipeline-dir>/lanes.json`. Read them the way `scripts/launch.sh` does:

```
mapfile -t lane_env < <(node src/lanes.js --env worker-cloud)
```

Each output line is one `KEY=VALUE` pair. Nothing is written to disk.

## 3. Start the worker by hand

```
env "${lane_env[@]}" bash scripts/local-worker.sh worker-cloud
```

`scripts/local-worker.sh` takes the lane id as its first argument. On each tick it checks the worker's switch, and the switch is set by the node pause described in section 6. A SIGTERM or SIGINT makes it exit after the tick it is working on.

## 4. Start it as a transient systemd unit (optional)

Use this to keep the worker running after the shell closes. `systemd-run` and the unit name `am-node-worker-cloud` are standard systemd usage and are not defined in this repository. A transient unit does not inherit the shell's exported variables, so pass them explicitly. Keep `<pipeline-dir>/node.env` as the environment file and pass the lane pairs as `--setenv`:

```
systemd-run --user --unit=am-node-worker-cloud --collect -p Nice=10 \
  --working-directory=<repo-root> \
  -p EnvironmentFile=<pipeline-dir>/node.env \
  --setenv=AGENT_MANAGER_LANES_PATH=<pipeline-dir>/lanes.json \
  --setenv=MODEL_URL=<gateway address> \
  <one --setenv=KEY=VALUE per line of the lane environment> \
  bash scripts/local-worker.sh worker-cloud
```

## 5. Stop it

```
systemctl --user stop am-node-worker-cloud
```

The worker exits after the tick it is working on. A task already in flight is finished first.

## 6. Why a started worker claims nothing

A worker that starts can still claim nothing for two reasons.

1. **A node pause.** The site-traffic monitor (`src/site-traffic-monitor.js`) pauses the node while the site is in use. Check it with:

   ```
   node src/worker-switch.js pause-status
   ```

   The output is JSON with `node`, `global` and `workers`. A pause with source `site-traffic` clears itself after the site has been idle for 5 minutes (`AGENT_MANAGER_SITE_IDLE_MIN`, default 5). Do not remove it by hand. Removing it while the site is in use lets workers take the machine away from the people using the site.

2. **A task not leased to this node.** `src/node-affinity.js` (`claimableOnNode`) decides which tasks a worker may claim. A task with `leasedTo` set is claimable only on that node, and a task with no `leasedTo` belongs to wok. A worker on this node therefore skips tasks leased to another node or to wok.

If neither applies, check `node src/lanes.js --env worker-cloud` output and the log written by `scripts/local-worker.sh`.
