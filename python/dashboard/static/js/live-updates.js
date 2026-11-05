'use strict';

// Live updates: the page is told what changed instead of asking every 5 s (ADR-0024; piece 3 of "UI triggers, not polls"). The server half is GET /api/stream
// (python/dashboard/event_stream.py): ONE shared watcher announces named events and every open page hears them. This file is the browser half and is plain
// logic: the EventSource, the clock and the page actions are arguments, so it is tested without a browser (live-updates.test.js).
//
//   counts-changed    a queue state directory gained or lost a record   -> refresh /api/summary (nav badges), redraw a queue tab
//   workers-changed   a worker's status / pass / task changed           -> redraw the Workers tab
//   branches-changed  a verdict was recorded or a branch merged          -> refresh the Branches tab
//   plugins-changed   plugins.json changed                               -> re-sync the plugin tabs, redraw the Plugins tab
//   plugin-states-changed  a plugin process started, stopped or restarted, or its checkout moved (the "restart needed" flag) -> redraw the Plugins tab
//   pipeline-state-changed  the pipeline started or stopped, its apply toggles or the active repo changed (a shared 3 s sampler) -> the Project tab refreshes its pipeline panel
//   project-build-changed   a Project-tab graph build started, logged a line or finished (the build thread announces) -> the Project tab refreshes its status panel
//   brain-dump-changed  brain-dump.json changed (anything wrote an entry) -> the Brain Dump tab refreshes its entry list (its own guard skips an open edit or discussion; finishing one refreshes at once)
//   hygiene-changed  a scanner's queue/*-flags.json or a Docs/*_CANDIDATES.md of the active project changed -> the Hygiene tab reloads its inventory (counts-changed and branches-changed do the same for it)
//   branch-list-changed  the server's branch-list refresh found a different list (it announces itself) -> the Branches tab re-reads the cached list
//   task-records-changed  a record in queue/drafting, review or coordinating changed (a pass flushed a history checkpoint) -> the open task-detail modal re-reads its task if it is watching a live one
//   memory-changed    the host-memory chip's state or reason changed     -> refresh /api/summary (the chip)
//   worker-panels-changed  a ledger, index, on/off marker, the cloud spend ledger or the model-stats database a Workers-tab panel reads changed -> redraw the Workers and Job List tabs
//   settings-changed  agent-manager.env, dashboard-settings.json or the lanes registry changed (the Job List's allowlist, priorities, approval modes; the Models tab's lane models) -> redraw the Job List and Models tabs
//   benchmark-changed  a benchmark run directory or the current-run pointer changed -> redraw the Models tab
//   hardware-changed / tokenfold-changed  the server's shared sampler saw a visible change in the hardware plugin's or the TokenFold proxy's stats (or the service went away or came back) -> redraw the Hardware / TokenFold and Reports tabs
//   reports-changed   a Markdown report file appeared or changed -> redraw the Reports tab
//   discovery-changed the project-search index, the deep-dive or community coverage file or the architecture candidates document changed -> redraw the Deep Dive and Discovery tabs
//   project-changed / snapshot   the pipeline changed, or this page just (re)connected -> refresh everything
//
//   plugin-changed   a plugin announced (POST /api/plugins/<name>/announce) that what its tab shows changed -> redraw the open tab of THAT plugin only
//
// No tab has a redraw timer. A plugin-owned tab is redrawn when its plugin announces a change (the writer announces, ADR-0024); until a plugin does, its tab shows what it drew when it was opened.
// If the stream is unavailable (the server answers 404, EventSource gives up) the page falls back to the old 5 s full refresh until it is reloaded.

const LIVE_STREAM_URL = '/api/stream';
const LIVE_EVENTS = ['snapshot', 'counts-changed', 'workers-changed', 'branches-changed', 'plugins-changed', 'plugin-states-changed', 'plugin-changed', 'pipeline-state-changed', 'project-build-changed', 'brain-dump-changed', 'hygiene-changed', 'branch-list-changed', 'task-records-changed', 'memory-changed', 'worker-panels-changed', 'settings-changed', 'benchmark-changed', 'hardware-changed', 'tokenfold-changed', 'reports-changed', 'discovery-changed', 'project-changed'];
const FALLBACK_POLL_MS = 5000;                  // the ONLY interval left: the full refresh while the stream is closed
// Tabs that manage their own rendering and are never redrawn by a refresh (they keep a half-typed note, an iframe, an open folder, a click in flight).
const SELF_RENDERING_TABS = ['project', 'brain-dump', 'filed', 'hygiene', 'promptforge', 'adforge', 'scriptforge', 'concepts', 'branches'];
// Every tab with its own renderer; anything else is a plain queue-state tab (renderQueueTab), whose content is exactly what counts-changed announces.
const NON_QUEUE_TABS = ['workers', 'hardware', 'models', 'joblist', 'plugins', 'deepdive', 'discovery', 'branches', 'reports', 'tokenfold', 'promptforge', 'adforge',
  'scriptforge', 'adhoc', 'concepts', 'filed', 'hygiene', 'project', 'brain-dump'];

// Tabs that show data derived from what each event announces, beyond the queue-state tabs: the completed-task and queue-record lists (counts-changed), the workers' ledgers, indexes and the
// model-stats database (worker-panels-changed: the Job List's performed counters and turn statistics), and the settings files (settings-changed: the Job List's allowlist and priorities).
const COUNT_DRIVEN_TABS = ['workers', 'adhoc', 'joblist', 'discovery'];
const PANEL_DRIVEN_TABS = ['workers', 'joblist', 'models'];          // the Models tab's statistics, usage and capability come from the model-stats database
const SETTINGS_DRIVEN_TABS = ['joblist', 'models'];                   // and the models each lane runs from the env file and the lanes registry
const BENCHMARK_DRIVEN_TABS = ['models'];                             // and the benchmark runs from the benchmark state directory
const HARDWARE_DRIVEN_TABS = ['hardware'];                            // hardware-changed: the hardware plugin's stats, sampled by the server (a change of two significant figures)
const TOKENFOLD_DRIVEN_TABS = ['tokenfold', 'reports'];               // tokenfold-changed: the TokenFold proxy's stats, sampled the same way
const REPORTS_DRIVEN_TABS = ['reports'];                              // reports-changed: a Markdown report file appeared or changed
const DISCOVERY_DRIVEN_TABS = ['deepdive', 'discovery'];              // discovery-changed: the project-search index, the deep-dive and community coverage files or the architecture candidates document changed

// panels: the open self-rendering tab's OWN refresh (it keeps a half-typed field or an iframe, so it is never redrawn whole; page glue calls its panel refreshers)
// kick: the Branches refresh also asks the server to start a background refresh of the branch list NOW (something that feeds the list happened); without it the page only re-reads the cached list
// modal: refresh the open task-detail modal if it is watching a live task (the page glue does nothing when none is armed)
const NO_PLAN = Object.freeze({ summary: false, plugins: false, nav: false, main: false, branches: false, panels: false, kick: false, modal: false });
const PANEL_TABS = ['project', 'brain-dump', 'hygiene'];                                          // self-rendering tabs that refresh their own panels: the Project tab (pipeline-state-changed, project-build-changed) the Brain Dump tab (brain-dump-changed) and the Hygiene tab (hygiene-changed, plus the queue's counts-changed and branches-changed, which its inventory joins)

function isSelfRenderingTab(tab) { return SELF_RENDERING_TABS.includes(tab); }

function isQueueTab(tab, isPluginTab) {
  return !NON_QUEUE_TABS.includes(tab) && !(typeof isPluginTab === 'function' && isPluginTab(tab));
}

// -> what to refresh for one event while `tab` is the active tab. `main` is never true for a self-rendering tab.
function planForEvent(name, tab, isPluginTab, data, pluginNameOf) {
  const plan = { ...NO_PLAN };
  switch (name) {
    case 'snapshot':
    case 'project-changed':
      plan.summary = plan.plugins = plan.nav = true;
      plan.main = !isSelfRenderingTab(tab);
      plan.branches = tab === 'branches';
      plan.panels = PANEL_TABS.includes(tab);
      plan.modal = true;
      break;
    case 'pipeline-state-changed':
    case 'project-build-changed':
      plan.panels = tab === 'project';
      break;
    case 'brain-dump-changed':
      plan.panels = tab === 'brain-dump';
      break;
    case 'task-records-changed':
      plan.modal = true;                 // a pass flushed a history checkpoint into an in-flight task record
      break;
    case 'counts-changed':
      plan.modal = true;                 // a task moved between states
      plan.panels = tab === 'hygiene';
      plan.branches = plan.kick = tab === 'branches';                                   // a finished task pushes a branch: ask the server to look now
      plan.summary = plan.nav = true;
      plan.main = isQueueTab(tab, isPluginTab) || COUNT_DRIVEN_TABS.includes(tab);        // every self-rendering tab is in NON_QUEUE_TABS, so it is never a queue tab
      break;
    case 'memory-changed':
      plan.summary = true;
      break;
    case 'plugins-changed':
      plan.plugins = plan.nav = true;
      plan.main = tab === 'plugins';
      break;
    case 'plugin-states-changed':
      plan.main = tab === 'plugins';
      break;
    case 'plugin-changed':                  // a plugin announced that its own data changed: only the open tab of THAT plugin is redrawn
      plan.main = !isSelfRenderingTab(tab) && typeof pluginNameOf === 'function' && !!data && typeof data.plugin === 'string' && pluginNameOf(tab) === data.plugin;
      break;
    case 'workers-changed':
      plan.main = tab === 'workers';
      break;
    case 'worker-panels-changed':
      plan.main = PANEL_DRIVEN_TABS.includes(tab);
      break;
    case 'settings-changed':
      plan.main = SETTINGS_DRIVEN_TABS.includes(tab);
      break;
    case 'benchmark-changed':
      plan.main = BENCHMARK_DRIVEN_TABS.includes(tab);
      break;
    case 'hardware-changed':
      plan.main = HARDWARE_DRIVEN_TABS.includes(tab);
      break;
    case 'tokenfold-changed':
      plan.main = TOKENFOLD_DRIVEN_TABS.includes(tab);
      break;
    case 'reports-changed':
      plan.main = REPORTS_DRIVEN_TABS.includes(tab);
      break;
    case 'discovery-changed':
      plan.main = DISCOVERY_DRIVEN_TABS.includes(tab);
      break;
    case 'branches-changed':
      plan.branches = plan.kick = tab === 'branches';
      plan.panels = tab === 'hygiene';
      break;
    case 'branch-list-changed':                // the server's refresh found a different list: read it (no kick, or it would loop)
      plan.branches = tab === 'branches';
      break;
    case 'hygiene-changed':
      plan.panels = tab === 'hygiene';
      break;
    default:
      break;
  }
  return plan;
}

function mergePlans(a, b) {
  return { summary: a.summary || b.summary, plugins: a.plugins || b.plugins, nav: a.nav || b.nav, main: a.main || b.main, branches: a.branches || b.branches, panels: a.panels || b.panels, kick: a.kick || b.kick, modal: a.modal || b.modal };
}

function isEmptyPlan(p) { return !(p.summary || p.plugins || p.nav || p.main || p.branches || p.panels || p.kick || p.modal); }

// deps: { EventSource, url?, apply(plan) -> Promise, poll() -> Promise (the old full refresh), getTab(), isPluginTab?(tab), setStatus?(text),
//         pluginNameOf?(tab) -> the plugin that owns a plugin tab or null, setIntervalFn?, clearIntervalFn?, pollMs? }
// -> { close(), state() }.  Events that arrive while a plan is being applied are merged and applied right after it (nothing is dropped, nothing runs twice at once).
function startLiveUpdates(deps) {
  const setIntervalFn = deps.setIntervalFn || setInterval;
  const clearIntervalFn = deps.clearIntervalFn || clearInterval;
  const pollMs = deps.pollMs || FALLBACK_POLL_MS;
  const status = (text) => { if (deps.setStatus) deps.setStatus(text); };
  let closed = false;
  let fallbackTimer = null;
  let running = false;
  let pending = null;
  let stream = null;

  async function drain() {
    if (running) return;
    running = true;
    try {
      while (pending && !closed) {
        const plan = pending;
        pending = null;
        try { await deps.apply(plan); } catch (e) { /* one failed refresh must not stop the next */ }
      }
    } finally {
      running = false;
    }
  }

  function schedule(plan) {
    if (isEmptyPlan(plan)) return Promise.resolve();         // after close() the drain loop below runs nothing
    pending = pending ? mergePlans(pending, plan) : plan;
    return drain();
  }

  function onEvent(name, data) { return schedule(planForEvent(name, deps.getTab(), deps.isPluginTab, data, deps.pluginNameOf)); }

  function enterFallback() {
    if (fallbackTimer || closed) return;
    status('disconnected (polling)');
    fallbackTimer = setIntervalFn(() => { Promise.resolve(deps.poll()).catch(() => {}); }, pollMs);
  }

  try {
    stream = new deps.EventSource(deps.url || LIVE_STREAM_URL);
  } catch (e) {
    stream = null;
    enterFallback();
  }
  if (stream) {
    stream.addEventListener('open', () => status('connected'));
    stream.addEventListener('error', () => {
      status('disconnected');
      if (stream.readyState === 2) enterFallback();     // CLOSED: the server said no (404) or the browser gave up; the browser keeps retrying while it is CONNECTING
    });
    for (const name of LIVE_EVENTS) {
      stream.addEventListener(name, (e) => {
        let data = null;
        try { data = e && typeof e.data === 'string' ? JSON.parse(e.data) : null; } catch (err) { data = null; }
        onEvent(name, data);
      });
    }
  }

  return {
    close() {
      closed = true;
      if (stream) stream.close();
      if (fallbackTimer) clearIntervalFn(fallbackTimer);
      fallbackTimer = null;
    },
    state() { return { fallback: !!fallbackTimer, closed, running, pending: !!pending }; },
  };
}

if (typeof module !== 'undefined') module.exports = {
  LIVE_STREAM_URL, LIVE_EVENTS, FALLBACK_POLL_MS, SELF_RENDERING_TABS, NON_QUEUE_TABS, COUNT_DRIVEN_TABS, PANEL_DRIVEN_TABS, PANEL_TABS, SETTINGS_DRIVEN_TABS, BENCHMARK_DRIVEN_TABS, HARDWARE_DRIVEN_TABS, TOKENFOLD_DRIVEN_TABS, REPORTS_DRIVEN_TABS, DISCOVERY_DRIVEN_TABS, NO_PLAN,
  isSelfRenderingTab, isQueueTab, planForEvent, mergePlans, isEmptyPlan, startLiveUpdates,
};
