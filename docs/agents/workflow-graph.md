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

## What phase B added (HUB0325)

Phase B made the nodes configurable with the controls a worker card has, without changing any lane or pipeline behaviour.

- **Lane fields on `/api/instances`.** Every entry now carries `provider` (`local`, `cloud`, `script` or null), `taskClasses` (the lane's allowlist or null) and `tierB`, taken from the lane whose id equals the
  instance id (`app.worker_lane_defs()`); an instance that is not a lane, or any instance when the lane definitions are unavailable, gets nulls.
- **A provider-aware model control** (`python/dashboard/static/js/worker-model-select.js`, shared by the Cards view and the node panel): a local lane keeps its model select; a cloud lane shows its model read-only
  ("cloud model set by the gateway"), because the gateway ignores the model a caller sends; a script lane shows "script lane, no model"; the watchdog shows nothing.
- **The node panel** (`python/dashboard/static/js/workflow-node-panel.js`): a selected loop node shows its facts, the Turn on / Turn off switch, the model control and a note that says when a change applies, and a worker
  node also shows the task picker (`python/dashboard/static/js/worker-task-picker.js`, extracted unchanged from the Cards view). Choosing a task uses the same confirm dialog and the same assign-task route as the card.
- **When a change applies.** A model override applies on the lane's **next tick** (about 30 seconds). A lane's provider, endpoint and task classes come from `lanes.json` and need a **pipeline restart**; the panel says so.
- **Polling.** A poll never redraws while a model, type or task dropdown has focus, and a poll that fails (a slow route under load) keeps the graph that is drawn instead of replacing it with the unavailable message.
- **Per-node local or cloud choice** was not built; see [workflow-node-provider.md](workflow-node-provider.md) for what it would take and the decisions it needs.

Known gaps of phase B: the graph node carries only the model name and an overridden flag, so the select shows the model the lane currently runs (the override value itself is not in the graph); the task picker appears for
every worker node even when a worker's heartbeat says it cannot be assigned tasks (the graph runtime has no such field); the detail panel sits below the graph.

## Known limits

- Edges are **derived** routing, not authored; a node cannot be moved or connected by hand.
- Changes to the lane registry (`lanes.json`) still need a pipeline restart: lane env is frozen at launch. Only the per-worker **model override**
  (the model control of a card or of a node panel, `/api/worker-models`) applies on the next tick.
- The layout is a simple layered one (longest path, one ordering pass): with 20+ sources the left column is tall and edges cross. It is a first picture,
  not a tuned diagram.
- Only loops with a lane or a legacy `worker-*` / `reviewer*` instance become nodes; other heartbeat names are ignored.

## What phase C added (HUB0326)

Phase C added an optional authored layer over the derived graph. It is read-only: the dashboard never writes it, and nothing in it creates or changes a lane.

**The workflow file.** `workflow.json` is optional. Its path is the environment variable `AGENT_MANAGER_WORKFLOW_PATH`, default `workflow.json` in the repo root; an absent file means no authoring (empty config, no warning).
It never creates, removes or reconfigures a lane: lanes still come only from `src/lanes.js` and `lanes.json`.

```json
{
  "schemaVersion": 1,
  "groups": [
    { "id": "group:gpus", "label": "GPU workers", "children": ["worker-3090", "worker-p40"], "collapsed": true },
    { "id": "group:review", "label": "Review", "children": ["reviewer", "stage:review"], "collapsed": false }
  ],
  "edges": [ { "from": "source:adhoc", "to": "worker-cloud", "kind": "triggers", "label": "demo" } ],
  "labels": { "worker-3090": "Big GPU" }
}
```

**What the file can do.** Groups (a group lists node ids or other group ids; a node's `parent` becomes the first group that lists it), authored edges between existing nodes (a derived edge is never replaced or removed), and labels that replace a node's label.

**Validation** (`validateWorkflowConfig` in `src/workflow-config.js`, pure, never throws, fail closed like `src/lanes.js`): a wrong or missing `schemaVersion`, a root that is not an object, or a file over 256 KB gives the empty config plus one warning. A bad entry is dropped with a warning that names it:
a group id must match `^group:[a-z0-9][a-z0-9-]*$` (the first duplicate wins); a group label is 1 to 60 characters, else the id is used; `children` is a non-empty array of distinct non-empty strings, a group that lists itself or sits on a nesting cycle is dropped; `collapsed` is a boolean, default false;
an edge needs string `from` and `to` that differ and a `kind` from `produces`, `claims`, `reviews`, `applies`, `triggers`, `refines`, and a `label` of at most 60 characters or null; at most 500 edges and 500 labels (the rest dropped with one warning); a label value is 1 to 60 characters.
`readWorkflowConfig(env)` handles an absent file, an unreadable file and a file that is not JSON (empty config plus a warning). `node src/workflow-config.js` prints `{ config, warnings }`.

**The overlay** (`src/workflow-overlay.js`, called by `buildWorkflowGraph` through its `workflow` and `watchdogScripts` options). `applyWorkflowConfig` drops children that are neither a node id nor a kept group, drops a group left empty, ignores a label for an unknown node and an authored edge with an unknown endpoint, each with a warning that is added to the graph's `warnings`.
With neither option the graph is exactly what phase B produced. `GET /api/workflow-graph` reads the file and the watchdog scripts and passes both to the builder; a failure of either only adds a warning.

**Watchdog script nodes.** `addWatchdogScriptNodes` adds one service node per plugin watchdog script (`src/plugin-watchdog-scripts.js`), id `service:watchdog-script:<plugin>:<file name without .js>`, label `<plugin>: <file name>`, and a `triggers` edge from `service:watchdog`. This is the first use of the `triggers` edge kind. A workflow file can label or group these nodes.

**Groups in the Graph view** (`python/dashboard/static/js/workflow-groups.js`, pure, drawn by `workflow-graph-view.js`). An expanded group is a dashed box with a header button; a collapsed group is one card (`N member(s)`) that shows the worst status of its loop members (error, stale, paused, warming, queued, working, idle, offline, disabled), the summed counts and the re-pointed edges.
Click the card or the header button to fold or unfold. The choice lives in the view and survives the 5 second poll; it is not saved, so a reload goes back to the file's `collapsed` values. A selection hidden by a fold is cleared.

**`splitNode`** (`src/workflow-split.js`) is the pure seam a future task atomizer would use to replace one loop node by several: `splitNode(graph, nodeId, parts)` returns `{ ok: true, graph }` or `{ ok: false, error }`, copies every edge of the original to each part, and refuses a split that would orphan a task class. Nothing calls it yet.

**Files and tests.**
- `src/workflow-config.js`: `node --test src/workflow-config.test.js`
- `src/workflow-overlay.js` and the builder hook in `src/workflow-graph.js`: `node --test src/workflow-overlay.test.js src/workflow-graph.test.js`
- `python/dashboard/routes/workflow_graph.py`: `python -m unittest test_workflow_graph_route` from `python/dashboard`
- `python/dashboard/static/js/workflow-groups.js`: `node --test python/dashboard/tests/test_workflow_groups.js`
- `src/workflow-split.js`: `node --test src/workflow-split.test.js`

**Known gaps of phase C.**
- The group box defect found when phase C was checked in a real browser (a box covering cards that are not members) is fixed by phase D; see "What phase D added" for what still remains.
- Nothing writes `workflow.json`; it is edited by hand.
- The fold state is not saved across a reload.
- `splitNode` has no caller and no way to apply its result to a lane.

## What phase D added (HUB0329)

Phase D did two things: it fixed the group boxes, and it built the BASELINE for a priority that follows the graph. It did not build the priority itself (see "Not built" below).

**Group boxes that cover only their members.**
- `layoutGraph` (`python/dashboard/static/js/workflow-layout.js`) now keeps the members of a group together: after the usual column ordering, the members of the same outermost group are moved next to each other in their column, at the place of the group's first member, keeping their order. The outermost group of a node is found from `node.parent` and the group lists of `graph.groups`; a parent that is not a group id counts as no group, and a cycle of group ids stops the walk. A graph without groups lays out exactly as before. Test: `node --test python/dashboard/tests/test_workflow_layout.js`.
- `groupBoxes` (`python/dashboard/static/js/workflow-groups.js`) returns one box per column the group occupies, `{ id, label, x, y, w, h, part }`, with `part` counted from the left; the view draws every box with its own header button and a click on any of them folds the group. Test: `node --test python/dashboard/tests/test_workflow_groups.js`.

**The priority baseline.**
- `flatPriorityOrder(topology)` in `src/workflow-priority.js` returns the sources in the order the claim path uses: by registered priority (lower first), ties by name, each as `{ name, priority, rank }` with the competition rank (1 plus the number of sources with a strictly lower priority, so sources with one priority share a rank and the next rank skips). Entries without a name or a finite priority are skipped and a duplicate name keeps the first.
- `src/workflow-priority.test.js` holds a hand-written golden of 22 sources and their ranks. It exists so that any change of the flat order is a visible decision: the golden does not read the live registry, so it pins the rule and an example, not the day's registry. Test: `node --test src/workflow-priority.test.js`.
- The builder returns the list as the graph's `priorityOrder` key (`src/workflow-graph.js`), and the node panel of a selected source shows "Flat priority N · rank R of M", plus how many other sources share the priority (`buildSourcePriorityHtml` in `python/dashboard/static/js/workflow-node-panel.js`). Tests: `node --test src/workflow-graph.test.js` and `node --test python/dashboard/tests/test_workflow_node_panel.js`.

**Known limits of phase D.**
- A box header (28 px plus the padding) is taller than the 16 px gap between two rows that the view uses (`WF_LAYOUT_OPTS` in `workflow-graph-view.js`), so a header overlaps the bottom of the card above it. Fixing it means changing the row gap of the layout for every graph.
- The layout keeps the members of the OUTERMOST group together. The members of a group nested inside another group keep their old order inside the outer block, so a box of the inner group can still cover another member of the outer group.
- A node id that is a name on `Object.prototype` (for example `constructor`) breaks the layout, which then returns its empty result; no real node has such an id.

**Not built: a priority derived from the graph.** There is no graph-derived priority and no switch that would change the claim order; the registered priorities and the claim order are exactly what they were. The reason is in the data: in the live graph measured on 2026-11-03 (52 sources, 6 lanes) the edges are 112 `claims` (a source to a lane), 4 `produces` (between the stage nodes), 4 `reviews`, 2 `applies` and 2 `refines`, and no source has an edge to any stage, so a source has no position in the workflow that could order it.
The owner has to decide what "position in the workflow" means for a source before anything can be built. Two candidates that can be read from the code:
- the stage a source's output first enters. It needs an edge from each source to a stage, which the builder does not derive today; a `workflow.json` can author such edges between existing nodes, so the meaning could be tried by hand first.
- the lanes that can claim it. The `claims` edges exist today, so a rank could come from, for example, how many lanes can take the source or which tier those lanes are; it would say how scarce the capacity is, not how far along the workflow the work is.
The baseline above is what a comparison needs: today's order, per source, next to whatever the chosen meaning would give.

## Next phases (not built)

- **Phase D, the priority that follows the graph.** The baseline and the comparison aid are built (see above). A graph-derived priority, the off-by-default switch for it and a one-day comparison before any switch need the owner's decision on what a source's position in the workflow means. Not built.
