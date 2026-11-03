# Workers workflow graph (phase A, read-only)

The Workers tab has a **Cards | Graph** toggle. **Cards** is the original per-instance card list and stays the default. **Graph** draws the pipeline as a
directed graph: task sources and pipeline stages on the left, the worker loops (one per lane, plus the legacy P40 lane and the reviewers) in the middle,
the services (watchdog, apply-loop) beside them, and the routing between them as arrows. Phase A (HUB0323) only **reads**: nothing in the graph
edits a lane, a model, a priority or a config file. The one control inside a node is the existing Turn on / Turn off button of a switchable loop.

## What you see

- **Node cards** use the same card classes and the same status rules as the Cards view (`fmtAge`, `statusBadgeClass`, `statusLabel` in
  `worker-status-helpers.js`). A loop node shows its status badge, how long it has been in that state, its model with a `local` / `cloud` / `script`
  badge, its current task and pass, and the switch button when `runtime.switchable` is true. A source or stage node shows `pending` and `drafting`
  counts.
- **Edges** are derived routing, not authored: `claims` (a source feeds a loop whose `taskClasses` allows it), `reviews`, `applies`, `refines`,
  `produces`. A dashed edge is a back edge (a cycle closed by the layout).
- **Click a node** to select it: a read-only detail panel opens under the graph (runtime, model with its choices, work, counts, and the graph's own
  warnings). For a loop it also lists the instance's recent runs (`/api/instances/<id>/run-log`). Click it again to unselect.
- The choice of view is remembered in `localStorage` under `workersView` (`graph`, anything else reads as `cards`).
- The graph sits in one scroll box inside the page; the page itself never scrolls sideways. If `/api/workflow-graph` is unavailable the tab shows one
  line and a **Back to Cards** button; the Cards view keeps working.
- **Polling.** The tab redraws every 5 s like the Cards view, but the graph only replaces its surface when a visible value changed (an id, a status, a
  count, a task, a warning). The selection and the scroll position survive a poll. The "in this state" age is not part of that comparison, so it
  updates when something else changes.

## The WorkflowGraph contract

`GET /api/workflow-graph` returns this JSON (built by `src/workflow-graph.js`, called with `node src/workflow-graph.js --stdin`):

```
WorkflowGraph = { schemaVersion: 1, generatedAt: <ISO string>, nodes: [Node], edges: [Edge], groups: [], warnings: [string] }
Node = { id, kind: "stage"|"loop"|"source"|"service", label, parent: null, runtime, model, work, counts }
  id: a lane id ("worker-3090", "reviewer", "worker-uiconf") for loops; "source:<name>" for task sources; "service:watchdog" and "service:apply-loop" for services; "stage:<name>" for the pipeline stages orient, plan, implement, review, apply (kind "stage")
  runtime (loops and services only, else null): { instanceId, status, stale, disabled, switchable, pid, currentTaskId, currentPass, stateAgeSeconds, hub, projectLabel, borrowed } copied from the /api/instances entry with that instanceId; an expected lane with no heartbeat gets status "offline"
  model (loops only, else null): { name, provider: "local"|"cloud"|"script", tierB, overridden, choices: { local: [string], cloud: [string] } }
    provider: lane.provider === "cloud" or lane.cloud === true -> "cloud"; lane.provider === "script" or lane.script === true -> "script"; otherwise "local". name: the instance's current model when it has one, else lane.model. tierB: lane.tier or null. overridden: true when the worker-models overrides map has the lane id. choices.local = ollamaModels, choices.cloud = claudeModels from GET /api/worker-models
  work (loops only, else null): { taskClasses: [string]|null, preempt: string|null, reviewer: boolean }   (null taskClasses = claims any task)
  counts (sources and stages only, else null): { pending: number, drafting: number } from the topology entry's liveCounts ({state: count}); a missing state is 0
Edge = { id: "<from>-><to>:<kind>", from, to, kind: "produces"|"claims"|"reviews"|"applies"|"triggers"|"refines", label: string|null }
Derived routing edges (phase A has no authored edges): source -> loop kind "claims" when the lane's taskClasses is null or includes the source name; loop -> its reviewer loop kind "reviews" when lane.reviewer is true (reviewer id = lane.reviewerId) and from every non-reviewer loop to the plain "reviewer" loop when that loop exists and the lane is not a script lane; reviewer loops -> "service:apply-loop" kind "applies"; a topology entry with variantOf -> its parent source kind "refines". Edges with the same id are emitted once. Node ids and edge ids are stable across calls (same input, same output apart from generatedAt).
Nodes that are not in the lanes array: every instance whose instanceId starts with "worker-" or "reviewer" and has no lane (the legacy P40 lane and its reviewer are like this) becomes a loop node with provider "local", tierB null and work null, named from the instance's model; an instance with instanceId "watchdog" becomes node "service:watchdog"; "service:apply-loop" is always present and has runtime null unless an instance with instanceId "apply-loop" exists. A lane with reviewer true whose reviewerId has no instance still gets a reviewer loop node (status "offline"). Every instance that was used is consumed exactly once (no duplicate node ids).
Input shapes the builder receives (all plain JSON): lanes = the array printed by `node src/lanes.js` (each: id, gpu, model, tier, provider?, cloud?, script?, reviewer, reviewerId, preempt, taskClasses); instances = the array GET /api/instances returns; topology = the array GET /api/pipeline-map returns under its sources (each: name, slug, priority, reasoningTier, workerType, variantOf?, liveCounts: {state: count}); models = { overrides: {instanceId: string}, ollamaModels: [string], claudeModels: [string] }.
```

## Where each part comes from

| Input | Source |
|---|---|
| `lanes` | `node src/lanes.js` (no flag: the full array including `provider`, `cloud`, `script`; `--json` drops those), run with the pipeline's env |
| `instances` | `GET /api/instances` (`routes/instances.py`, called in process) |
| `topology` | `GET /api/pipeline-map` `sources` (`routes/job_types.py`) |
| `models` | `GET /api/worker-models` (`routes/worker_models_1_more.py`) |

`routes/workflow_graph.py` gathers the four inputs through injected functions (`assemble_graph`), so a broken input only adds a warning that names it
and the graph is still returned. If the builder itself breaks the route answers 200 with `{"available": false, "reason": ...}`.

## Files

- `src/workflow-graph.js`: the pure builder (`buildWorkflowGraph`) and its `--stdin` CLI. Tests: `node --test src/workflow-graph.test.js`.
- `python/dashboard/routes/workflow_graph.py`: the route. Tests: `python -m unittest test_workflow_graph_route` from `python/dashboard`.
- `python/dashboard/static/js/workflow-layout.js`: the pure layered layout (`layoutGraph`). Tests: `node --test python/dashboard/tests/test_workflow_layout.js`.
- `python/dashboard/static/js/worker-status-helpers.js`: the status helpers shared with the cards. Tests: `node --test python/dashboard/tests/test_worker_status_helpers.js`.
- `python/dashboard/static/js/workflow-graph-view.js`: the Graph view and the toggle. Tests: `node --test python/dashboard/tests/test_workflow_graph_view.js`.
- `python/dashboard/tests/browser_workflow_graph.mjs`: the repeatable real-browser check, below.
- `python/dashboard/static/js/index-script-order.test.js` guards that `index.html` loads every one of these scripts, in order.

## The real-browser check

Unit tests cannot see a clipped card or a page that scrolls sideways, so the graph has a script that drives it in a real browser. It must run against a
**scratch** dashboard, never the live one on 7420 (it refuses that port).

1. Start a scratch dashboard from the checkout: `HOME=<tmp>/home AGENT_MANAGER_DASHBOARD_PORT=7499 AGENT_MANAGER_REPO_ROOT=<tmp>/repo
   AGENT_MANAGER_PIPELINE_DIR=<tmp>/pipe AGENT_MANAGER_DOMAINS_PATH=<tmp>/pipe/task-domains.json AGENT_MANAGER_LANES_PATH=<tmp>/lanes.json
   .venv/bin/python python/dashboard/app.py`, with a copy of `lanes.json` and `task-domains.json`, an empty `<tmp>/pipe/instances/` (or a few
   heartbeat files written by hand) and `<tmp>/repo` as an empty git repo, so nothing touches the live queue or `~/.local/state`.
2. Run `PLAYWRIGHT_DIR=<a playwright or playwright-core install> DASHBOARD_URL=http://127.0.0.1:7499 node python/dashboard/tests/browser_workflow_graph.mjs`.
   Optional: `SCREENSHOT=<path>` (default `/tmp/workflow-graph.png`), `CHROMIUM=<path to a chromium or headless shell>`.
3. Read the screenshot. The script asserts that the graph has at least one node per instance, that clicking a node opens its detail panel, that the
   selection is still there after two poll cycles (12 s), and that switching back to Cards shows one card per instance.
4. Stop the scratch dashboard by its pid.

With no `PLAYWRIGHT_DIR` the script prints `skipped: PLAYWRIGHT_DIR not set` and exits 0, so it is safe in any test run.

## Known limits

- Edges are **derived** routing, not authored; a node cannot be moved or connected by hand.
- Changes to the lane registry (`lanes.json`) still need a pipeline restart: lane env is frozen at launch. Only the per-worker **model override**
  (the existing Workers tab dropdown, `/api/worker-models`) applies on the next tick; the graph only shows it.
- The layout is a simple layered one (longest path, one ordering pass): with 20+ sources the left column is tall and edges cross. It is a first picture,
  not a tuned diagram.
- Only loops with a lane or a legacy `worker-*` / `reviewer*` instance become nodes; other heartbeat names are ignored.

## Next phases (not built)

- **Phase B, node options.** Per-node model and local-versus-cloud choice written back through the existing worker-model and lane routes. Not built.
- **Phase C, `workflow.json`.** An authored workflow file: composable nodes, authored edges, and a `splitNode` operation that atomizes a large-model node
  into smaller ones. Not built.
- **Phase D, priority follows the graph.** Task priority derived from a task's position in the workflow, behind an off-by-default flag,
  with a golden snapshot of today's order first and a one-day comparison before any switch. Not built.
