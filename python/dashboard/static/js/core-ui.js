function isGroupExpanded(groupName) {
  return localStorage.getItem('agentManagerNavGroup_' + groupName) !== 'collapsed';
}

function setProjectPath(newPath) {
  if (newPath !== projectPath) {
    grepDirs = '';
    localStorage.setItem('agentManagerGrepDirs', '');
    const grepInput = document.getElementById('project-grepdirs-input');
    if (grepInput) grepInput.value = '';
  }
  projectPath = newPath;
  localStorage.setItem('agentManagerProjectPath', projectPath);
}

async function loadProjectHistory() {
  try {
    const data = await fetchJson('/api/projects/history');
    projectHistory = data.projects || [];
  } catch (e) {
    projectHistory = [];
  }
  const list = document.getElementById('project-history-list');
  if (list) list.innerHTML = projectHistory.map((p) => `<option value="${escapeAttr(p)}">`).join('');
}

async function loadProjectDropdown() {
  const select = document.getElementById('project-select');
  if (!select) return;
  let projects = [];
  try {
    const data = await fetchJson('/api/second-brain/projects');
    projects = data.projects || [];
  } catch (e) { /* Second Brain not configured -- leave the dropdown at just the placeholder */ }
  let matched = !projectPath;
  let html = '<option value="">Select a project...</option>';
  for (const p of projects) {
    const selected = p.path === projectPath;
    if (selected) matched = true;
    html += `<option value="${escapeAttr(p.path)}"${selected ? ' selected' : ''}>${escapeHtml(p.name)}</option>`;
  }
  // Current path isn't a known Second Brain project (e.g. picked via Browse) -- keep it
  // visible and selected rather than silently falling back to the placeholder.
  if (!matched) html += `<option value="${escapeAttr(projectPath)}" selected>${escapeHtml(projectPath)}</option>`;
  select.innerHTML = html;
}

function renderHistoryPanel() {
  const panel = document.getElementById('history-panel');
  if (!panel) return;
  if (projectHistory.length === 0) {
    panel.innerHTML = `<div class="empty">No projects loaded yet.</div>`;
    return;
  }
  panel.innerHTML = projectHistory.map((p) => `
    <div class="browser-entry" data-select="${escapeAttr(p)}">
      <span>${escapeHtml(p)}</span><span>&rarr;</span>
    </div>
  `).join('');
  panel.querySelectorAll('[data-select]').forEach((el) => {
    el.onclick = () => {
      setProjectPath(el.dataset.select);
      document.getElementById('project-path-input').value = projectPath;
      lastRenderedStatusKey = null;
      historyOpen = false;
      panel.style.display = 'none';
      refreshProjectStatus();
    };
  });
}

async function fetchJson(url, { timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let r;
  try {
    r = await fetch(url, { signal: controller.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(url + ' -> timed out after ' + (timeoutMs / 1000) + 's');
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
  if (!r.ok) throw new Error(url + ' -> ' + r.status);
  return r.json();
}

function severityForTab(tabKey, count) {
  const thresholds = TAB_COUNT_SEVERITY_THRESHOLDS[tabKey];
  if (!thresholds || typeof count !== 'number') return null;
  if (thresholds.bad !== undefined && count >= thresholds.bad) return 'bad';
  if (thresholds.warn !== undefined && count >= thresholds.warn) return 'warn';
  return null;
}

// The shared "switch active tab" transition: runs whichever tab we're leaving's own
// leave*Tab hook, updates activeTab, re-renders the nav, then runs the destination's own
// enter*Tab hook (or the generic renderMain() for everything else). Both onclick handlers
// in renderTabButton below use this, and so does redirectFromGoneActiveTab() (piece 5;
// Docs/hub-tasks-extraction-plan.md section 5) -- the redirect needs the real leave/enter
// semantics, not just an activeTab assignment, so it reuses this instead of duplicating it.
function switchToTab(key) {
  if (activeTab === 'project' && key !== 'project') leaveProjectTab();
  if (activeTab === 'brain-dump' && key !== 'brain-dump') leaveBrainDumpTab();
  if (activeTab === 'branches' && key !== 'branches') leaveBranchesTab();
  if (activeTab === 'hygiene' && key !== 'hygiene') leaveHygieneTab();
  activeTab = key;
  renderNav();
  if (key === 'project') enterProjectTab();
  else if (key === 'brain-dump') enterBrainDumpTab();
  else if (key === 'branches') enterBranchesTab();
  else if (key === 'hygiene') enterHygieneTab();
  else renderMain();
}

function renderTabButton(tab, indent) {
  const btn = document.createElement('button');
  btn.className = tab.key === activeTab ? 'active' : '';
  if (tab.description) btn.title = tab.description;
  if (indent) btn.style.paddingLeft = '36px';
  if (tab.key === 'adhoc') {
    // Two numbers, not one folded-together count (Grimmethy, 2026-08-22: "It's just as
    // important to know how many in process there are so that we know how much work
    // the system already has to work on") -- grey for in-progress (backlog size, not a
    // problem), red for blocked (needs a human decision, same urgency 'blocked'/
    // 'awaiting-confirm' already get elsewhere in this nav).
    const inProgress = counts.adhocInProgress ?? 0;
    const blocked = counts.adhocBlocked ?? 0;
    btn.innerHTML = `<span>${tab.label}</span><span class="count">`
      + `<span style="color:var(--muted)">${inProgress}</span>`
      + ` <span style="color:var(--bad); font-weight:600">${blocked}</span>`
      + `</span>`;
    btn.onclick = () => switchToTab(tab.key);
    return btn;
  }
  const count = (tab.key === 'workers' || tab.key === 'models' || tab.key === 'joblist' || tab.key === 'plugins' || tab.key === 'deepdive') ? '' : (counts[tab.key] ?? '');
  const severity = severityForTab(tab.key, count);
  const dot = severity ? `<span class="status-dot ${severity}"></span>` : '';
  btn.innerHTML = `<span>${tab.label}</span><span class="count">${dot}${count}</span>`;
  btn.onclick = () => switchToTab(tab.key);
  return btn;
}

// --- Manifest-driven dashboard tab: tab-bar merge (piece 3 of 6; Docs/
// hub-tasks-extraction-plan.md section 5). Fail-safe by construction: mergePluginTabs()
// always rebuilds TABS from CORE_TABS first, so a plugin that vanishes, gets disabled, or
// declares a malformed tab simply drops back out and never corrupts the whole nav. What a
// plugin's row actually does when clicked (loading its ui/ script, piece 2's route) is
// wired up by the renderer dispatch in a later piece -- this piece only gets the row into
// the nav bar.
// NOT `= CORE_TABS`: core-ui.js loads via <script src> before the inline <script> block in
// index.html that defines CORE_TABS, so referencing it here at top-level (not inside a
// function body) would throw ReferenceError immediately and abort the rest of this file's
// execution, silently undefining renderNav and everything below it. TABS starts empty and
// is populated by the first mergePluginTabs() call (syncPluginTabs(), bottom of
// index.html, which runs after CORE_TABS exists).
let TABS = [];

function isValidPluginTab(tab) {
  if (!tab || typeof tab !== 'object') return false;
  if (typeof tab.key !== 'string' || !tab.key.trim()) return false;
  if (typeof tab.label !== 'string' || !tab.label.trim()) return false;
  if (tab.kind !== 'script') return false;
  if (typeof tab.script !== 'string' || !tab.script.trim()) return false;
  return true;
}

// Drops the row with this key wherever it lives (top-level or inside a group's children).
// Used only for a *deliberately disabled* replaces-declaring plugin -- see mergePluginTabs
// below -- never for a merely-malformed one, which still gets the CORE_TABS fallback as a
// safety net.
function removeTabByKey(tabs, key) {
  const idx = tabs.findIndex((t) => t.key === key);
  if (idx !== -1) { tabs.splice(idx, 1); return true; }
  for (const t of tabs) {
    if (t.group && Array.isArray(t.children)) {
      const cIdx = t.children.findIndex((c) => c.key === key);
      if (cIdx !== -1) { t.children.splice(cIdx, 1); return true; }
    }
  }
  return false;
}

function mergePluginTabs(plugins, manifestTabsEnabled) {
  const tabs = CORE_TABS.map((t) => (t.children ? { ...t, children: [...t.children] } : { ...t }));
  if (manifestTabsEnabled !== false) {
    for (const p of plugins || []) {
      if (!p) continue;
      if (p.enabled === false) {
        // A disabled plugin that declares `replaces` claimed ownership of a hardcoded
        // CORE_TABS row -- hide that row too instead of silently falling back to it, so
        // disabling a plugin in the Plugins tab actually hides its tab rather than
        // swapping back to a functionally-identical core implementation the user can't
        // tell apart from the plugin being on (Grimmethy, 2026-09-23: disabling
        // promptforge left the tab fully visible and clickable). Only acts on a
        // structurally valid declaration -- a disabled AND malformed plugin can't be
        // trusted to say which row it meant, so that row keeps its CORE_TABS fallback,
        // same as the "malformed while enabled" case below.
        if (isValidPluginTab(p.tab) && typeof p.tab.replaces === 'string' && p.tab.replaces.trim()) {
          removeTabByKey(tabs, p.tab.replaces);
        }
        continue;
      }
      if (!isValidPluginTab(p.tab)) continue;
      const tab = p.tab;
      const row = { key: tab.key, label: tab.label, description: tab.description, pluginName: p.name, pluginScript: tab.script };
      const replaces = tab.replaces;
      let replaced = false;
      if (replaces) {
        for (let i = 0; i < tabs.length && !replaced; i++) {
          if (tabs[i].key === replaces) { tabs[i] = row; replaced = true; }
          else if (tabs[i].group && Array.isArray(tabs[i].children)) {
            const idx = tabs[i].children.findIndex((c) => c.key === replaces);
            if (idx !== -1) { tabs[i].children[idx] = row; replaced = true; }
          }
        }
      }
      if (replaced) continue;
      if (tab.group) {
        let groupRow = tabs.find((t) => t.group === tab.group);
        if (!groupRow) { groupRow = { group: tab.group, children: [] }; tabs.push(groupRow); }
        groupRow.children.push(row);
      } else {
        tabs.push(row);
      }
    }
  }
  TABS = tabs;
  return tabs; // also returned (not just assigned to the module-level TABS) so callers --
               // including the Node vm-sandboxed test, since a vm context's top-level
               // `let` bindings aren't visible as sandbox properties from the outside --
               // can inspect the merge result directly.
}

async function syncPluginTabs() {
  try {
    const data = await fetchJson('/api/plugins');
    mergePluginTabs(data.plugins, data.manifestTabsEnabled);
  } catch (e) {
    // Fail-safe: leave TABS as whatever it already was (CORE_TABS on the very first
    // failure) rather than let a plugin-listing error block the rest of the dashboard.
  }
}

// --- Manifest-driven dashboard tab: renderer registry, loader and dispatch (piece 4 of 6;
// Docs/hub-tasks-extraction-plan.md section 5). This is the riskiest piece -- it sits on
// the path every tab click already runs -- so the contract is narrow and the failure mode
// is contained: a plugin's ui/<script>.js is loaded as a plain classic <script> (same-origin,
// piece 2's route) and is expected to call registerPluginTabRenderer(key, fn) at load time;
// renderPluginTab() is the only thing that invokes fn(), inside a try/catch that writes any
// failure (load error, or a script that never registered) into #main as a plain error panel
// -- never into the nav, never thrown up to renderMain's own caller. A broken plugin script
// can only ever break its own tab.
const pluginTabRenderers = {};
const pluginTabScriptLoads = {};

// Exposed so a loaded plugin script can hand back its render function; not called by
// anything else in core.
function registerPluginTabRenderer(key, renderFn) {
  if (typeof key === 'string' && key && typeof renderFn === 'function') {
    pluginTabRenderers[key] = renderFn;
  }
}

// TABS is a flat list of core rows plus, per piece 3, `{group, children}` rows -- searches
// one level of children, matching how renderNav() itself walks the structure.
function findTabByKey(key) {
  for (const t of TABS) {
    if (t.key === key) return t;
    if (Array.isArray(t.children)) {
      const child = t.children.find((c) => c.key === key);
      if (child) return child;
    }
  }
  return null;
}

// Enable/disable lifecycle: active-tab redirect (piece 5 of 6; Docs/
// hub-tasks-extraction-plan.md section 5). A CORE_TABS row survives mergePluginTabs()
// UNLESS a plugin both declared `replaces` for it and was then deliberately disabled (see
// mergePluginTabs' own comment, 2026-09-23) -- so findTabByKey(activeTab) can now come back
// empty either because activeTab named a plugin-declared tab whose plugin was disabled,
// removed, or dropped a `replaces` that used to cover this key, OR because that plugin's
// disable just took its replaced CORE_TABS row down with it. Either way the handling is the
// same: switchToTab() runs the real leave/enter transition rather than just reassigning
// activeTab, so the tab we're leaving still gets its own cleanup hook.
function redirectFromGoneActiveTab(fallbackKey = 'project') {
  if (findTabByKey(activeTab)) return false;
  switchToTab(fallbackKey);
  return true;
}

// tab.pluginScript is validated server-side (app._validate_plugin_tab) to be 'ui/<file>.js'
// with no '..' segments; the route itself (piece 2) is the actual security boundary, this
// just builds the matching URL -- the route's own path segment is literally 'ui/', so the
// leading 'ui/' here is stripped rather than sent twice.
function pluginTabAssetUrl(tab) {
  const rel = tab.pluginScript.replace(/^ui\//, '');
  return `/api/plugins/${encodeURIComponent(tab.pluginName)}/ui/${rel.split('/').map(encodeURIComponent).join('/')}`;
}

function loadPluginTabScript(tab) {
  if (pluginTabScriptLoads[tab.key]) return pluginTabScriptLoads[tab.key];
  const promise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = pluginTabAssetUrl(tab);
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${s.src}`));
    document.head.appendChild(s);
  }).catch((e) => {
    // Don't cache a failed load -- a transient error (plugin restarting, etc.) shouldn't
    // permanently blacklist the tab; the next click retries.
    delete pluginTabScriptLoads[tab.key];
    throw e;
  });
  pluginTabScriptLoads[tab.key] = promise;
  return promise;
}

async function renderPluginTab(tab) {
  const main = document.getElementById('main');
  try {
    if (!pluginTabRenderers[tab.key]) {
      main.innerHTML = `<div class="empty">Loading ${escapeHtml(tab.label)}...</div>`;
      await loadPluginTabScript(tab);
    }
    const renderFn = pluginTabRenderers[tab.key];
    if (typeof renderFn !== 'function') {
      throw new Error(`${tab.pluginScript} loaded but never called registerPluginTabRenderer('${tab.key}', ...)`);
    }
    await renderFn();
  } catch (e) {
    main.innerHTML = `<div class="empty">Could not load the "${escapeHtml(tab.label)}" tab (plugin ${escapeHtml(tab.pluginName)}): ${escapeHtml(e.message)}</div>`;
  }
}

function renderNav() {
  const nav = document.getElementById('nav');
  nav.innerHTML = '';
  for (const tab of TABS) {
    if (tab.group) {
      const expanded = isGroupExpanded(tab.group);
      const header = document.createElement('button');
      header.innerHTML = `<span>${expanded ? '▾' : '▸'} ${tab.group}</span><span class="count"></span>`;
      header.onclick = () => {
        localStorage.setItem('agentManagerNavGroup_' + tab.group, expanded ? 'collapsed' : 'expanded');
        renderNav();
      };
      nav.appendChild(header);
      if (expanded) {
        for (const child of tab.children) nav.appendChild(renderTabButton(child, true));
      }
    } else {
      nav.appendChild(renderTabButton(tab, false));
    }
  }
}

function fmtAge(sec) {
  if (sec == null) return '?';
  if (sec < 60) return sec + 's';
  if (sec < 3600) return Math.round(sec / 60) + 'm';
  return Math.round(sec / 3600) + 'h';
}

function statusBadgeClass(status, stale) {
  if (stale) return 'bad';
  if (status === 'offline') return 'idle';
  if (status === 'working' || status === 'checking') return 'ok';
  if (status === 'idle') return 'idle';
  // 'queued' (2026-08-19): a claimed task waiting its turn behind another lane at the
  // single-flight lock (agent-manager-common.sh's acquire_single_flight_lock) -- amber,
  // same as the generic 'warn' fallback below, but named explicitly so it reads as a
  // deliberate third state (green=actively running, amber=waiting its turn, gray=idle)
  // rather than falling through by accident.
  if (status === 'queued') return 'warn';
  return 'warn';
}

function modelKindForInstance(inst) {
  if (inst.instanceId === 'watchdog') return null;
  return 'ollama'; // every lane runs a local model (lanes are one per GPU)
}

async function setWorkerModel(instanceId, model) {
  await fetch(`/api/worker-models/${encodeURIComponent(instanceId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  });
  await renderWorkers();
}

// Only worker-* lanes (worker-1, worker-reasoning, worker-p40, worker-reasoning-p40)
// claim from queue/pending/ via local-worker.sh -- reviewer/watchdog have nothing to
// pin a pending task onto.
function canAssignTask(inst) {
  return inst.instanceId.startsWith('worker');
}

// Operator override (2026-09-06, Grimmethy: "I need to be able to select the task I
// want each worker to run... this should override the automated system"): pins
// `taskId` to `instanceId` (POST /api/instances/<id>/assign-task), which
// src/next-claimable-task.js's claim ranking picks up ahead of everything else next
// tick, and preempts whatever that worker is doing right now so it can pick the pinned
// task up immediately instead of waiting for its current pass to finish on its own.
//
// `sourceLane` (2026-09-07 follow-up, Grimmethy after live-testing the above: "The task
// I want, autodecomp, is in drafting") is set when the picked task is being STOLEN from
// another lane's drafting/ rather than idle in pending/ -- a more consequential action
// (it stops that other lane's real work too), so the confirm names both sides.
async function setWorkerTask(instanceId, taskId, taskTitle, sourceLane) {
  if (!taskId) return;
  const label = taskTitle ? `"${taskTitle}" (${taskId})` : taskId;
  const msg = sourceLane
    ? `Assign ${label} to ${instanceId}? This will stop ${sourceLane}'s current work on it and hand it to ${instanceId}. If ${instanceId} is currently working on something else, that task will also be cancelled and requeued.`
    : `Assign ${label} to ${instanceId}? If it's currently working on something else, that task will be cancelled and requeued.`;
  if (!confirm(msg)) {
    return;
  }
  await fetch(`/api/instances/${encodeURIComponent(instanceId)}/assign-task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId }),
  });
  // Back to the type picker for this card's next assignment, rather than staying
  // drilled into whatever type was just used -- the confirm() above already gated
  // this on the operator actually going through with it (a decline returns before
  // this point and leaves the drill-down as-is, so re-picking another task of the
  // same type doesn't require re-choosing the type too).
  delete selectedWorkerTaskType[instanceId];
  pendingWorkerAssign[instanceId] = taskId;
  await renderWorkers();
}

async function setClaudePaused(paused) {
  await fetch('/api/claude-pause', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paused }),
  });
  await renderWorkers();
}

async function toggleWorkerExpand(instanceId) {
  expandedWorkerId = expandedWorkerId === instanceId ? null : instanceId;
  await renderWorkers();
}

function renderRecentTasksList(tasks) {
  if (!tasks.length) return '<div class="meta">No tasks recorded for this instance yet.</div>';
  return `<ul class="recent-tasks-list">${tasks.map(t => `
    <li><a href="#" data-open-task-anywhere="${escapeAttr(t.taskId)}">${escapeHtml(t.taskId)}</a>
      <span class="meta">${t.outcome ? `<strong style="color:var(${t.outcome === 'approved' ? '--ok' : '--bad'})">${escapeHtml(t.outcome)}</strong> · ` : ''}${t.model ? escapeHtml(t.model) + ' · ' : ''}${t.completedAt ? fmtAge((Date.now() - new Date(t.completedAt).getTime()) / 1000) + ' ago' : ''}</span>
    </li>`).join('')}</ul>`;
}

// Per-instance run log (2026-09-08, see expandedIsWorker's own header comment above for
// the "recent-tasks only shows terminal state" gap this closes). Each row is either a
// real model_calls attempt ('call' -- outcome resolved from the owning task's current
// record when the call row's own outcome column is blank) or a hard-failure log entry
// ('failed' -- a call that never got a usable response at all, so no task-level outcome
// exists for it yet).
function renderRunLogList(runs) {
  if (!runs.length) return '<div class="meta">No runs recorded for this instance yet.</div>';
  return `<ul class="recent-tasks-list">${runs.map(r => {
    const failed = r.kind === 'failed';
    const pending = r.outcome === 'pending' || r.outcome === 'in-progress';
    const color = failed ? '--bad' : pending ? '--muted' : COMPLETED_TASKS_OUTCOME_OK_RE.test(r.outcome || '') ? '--ok' : '--bad';
    const label = failed ? `FAILED: ${r.outcome || 'error'}` : (r.outcome || '?');
    return `<li><a href="#" data-open-task-anywhere="${escapeAttr(r.taskId || '')}">${escapeHtml(r.taskId || '(unknown task)')}</a>
      <span class="meta"><strong style="color:var(${color})">${escapeHtml(label)}</strong>${r.stage ? ' · ' + escapeHtml(r.stage) : ''}${r.model ? ' · ' + escapeHtml(r.model) : ''}${r.latencyMs != null ? ' · ' + (r.latencyMs / 1000).toFixed(1) + 's' : ''} · ${r.at ? fmtAge((Date.now() - new Date(r.at).getTime()) / 1000) + ' ago' : ''}</span>
      ${failed && r.detail ? `<div class="meta" style="opacity:0.75">${escapeHtml(r.detail.slice(0, 160))}</div>` : ''}
    </li>`;
  }).join('')}</ul>`;
}

// Global "all tasks completed" log (2026-09-08, Grimmethy: "an in app representation of
// that all tasks completed log under the workers... only loads the most recent 25 tasks
// until I scroll to the bottom") -- see completedTasksLog's own header comment
// (index.html) for why this is accumulated JS state rather than DOM state: renderWorkers
// fully replaces #main on every 5s poll, and re-rendering the SAME accumulated array each
// time produces identical HTML for this section so the replace is invisible.
const COMPLETED_TASKS_OUTCOME_OK_RE = /^(approved|merged|applied-direct|pending-merge)$/;

function renderCompletedTasksSection() {
  const rows = completedTasksLog.map(t => `
    <li><a href="#" data-open-task-anywhere="${escapeAttr(t.taskId)}">${escapeHtmlBright(t.title || t.taskId)}</a>
      <span class="meta">${t.outcome ? `<strong style="color:var(${COMPLETED_TASKS_OUTCOME_OK_RE.test(t.outcome || '') ? '--ok' : '--bad'})">${escapeHtml(t.outcome)}</strong> · ` : ''}${t.source ? escapeHtml(t.source) + ' · ' : ''}${t.instanceId ? escapeHtml(t.instanceId) + ' · ' : ''}${t.model ? escapeHtml(t.model) + ' · ' : ''}${t.completedAt ? fmtAge((Date.now() - new Date(t.completedAt).getTime()) / 1000) + ' ago' : ''}</span>
    </li>`).join('');
  const footer = completedTasksExhausted
    ? (completedTasksLog.length ? '<div class="meta" style="text-align:center; padding:8px">No more tasks.</div>' : '<div class="meta">No completed tasks yet.</div>')
    : `<div id="completed-tasks-sentinel" style="height:1px"></div>${completedTasksLoading ? '<div class="meta" style="text-align:center; padding:8px">Loading…</div>' : ''}`;
  return `
    <div class="completed-tasks-log" style="margin-top:24px">
      <div class="meta" style="font-weight:600; margin-bottom:8px">All tasks completed</div>
      <ul class="recent-tasks-list">${rows}</ul>
      ${footer}
    </div>
  `;
}

// isPoll-safe: called after every renderWorkers() render since the sentinel node (and any
// prior observer's target) is torn down and rebuilt along with the rest of #main.
function setupCompletedTasksObserver() {
  if (completedTasksObserver) completedTasksObserver.disconnect();
  const sentinel = document.getElementById('completed-tasks-sentinel');
  if (!sentinel) return;
  completedTasksObserver = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) loadMoreCompletedTasks();
  }, { root: null, rootMargin: '200px' });
  completedTasksObserver.observe(sentinel);
}

// completedTasksLoading guards a fast scroll-to-bottom firing the IntersectionObserver
// callback more than once before state updates from the first in-flight fetch land.
async function loadMoreCompletedTasks() {
  if (completedTasksLoading || completedTasksExhausted) return;
  completedTasksLoading = true;
  try {
    const url = '/api/tasks/completed?limit=25' + (completedTasksNextCursor ? `&before=${encodeURIComponent(completedTasksNextCursor)}` : '');
    const data = await fetchJson(url);
    const rows = data.tasks || [];
    completedTasksLog = completedTasksLog.concat(rows);
    completedTasksNextCursor = data.nextCursor || null;
    if (!data.nextCursor || rows.length === 0) completedTasksExhausted = true;
  } catch (e) {
    // best-effort -- leave state as-is, the sentinel is still present so the next scroll
    // (or the next poll, if it's still on-screen) retries.
  } finally {
    completedTasksLoading = false;
  }
  if (activeTab === 'workers') await renderWorkers();
}

// 2026-09-14, screaminggoatclubmt: "the 'All tasks completed' section has stalled. Last
// update 23 hours ago" -- root-caused live: the FIRST-load guard in renderWorkers below
// (`if (!completedTasksLog.length ...) loadMoreCompletedTasks()`) only ever fires ONCE
// per page load, and loadMoreCompletedTasks only ever APPENDS OLDER pages to the end via
// the `before` cursor (real scroll-triggered pagination). Nothing ever re-checked for
// NEWER completions -- confirmed live: /api/tasks/completed itself was current to the
// minute (real backend, real recent completions), the dashboard's OWN accumulated JS
// state (completedTasksLog, module-level, survives every 5s #main rebuild by design --
// see its own header comment) was just never topped up with them. A tab left open for
// 23h shows exactly what was true when it first loaded the section, forever.
//
// Fetches the newest page (no `before` cursor) and PREPENDS whatever isn't already in
// completedTasksLog (deduped by taskId) -- never touches completedTasksNextCursor /
// completedTasksExhausted, so the scroll-triggered "load older" pagination this doesn't
// touch keeps working exactly as before. Called only on the real 5s poll cycle
// (renderWorkers(isPoll===true) below), not on every action-triggered re-render.
async function refreshNewestCompletedTasks() {
  try {
    const data = await fetchJson('/api/tasks/completed?limit=25');
    const rows = data.tasks || [];
    if (!rows.length) return;
    const known = new Set(completedTasksLog.map((t) => t.taskId));
    const fresh = rows.filter((t) => !known.has(t.taskId));
    if (fresh.length) completedTasksLog = fresh.concat(completedTasksLog);
  } catch (e) {
    // best-effort -- the next 5s poll retries; the existing list just stays as-is.
  }
}

// isPoll (2026-09-07, Grimmethy: "please fix the dropdown reset on poll thing, that
// is extraordinarily irritating and has bit me several times"): the 5s refresh()
// cycle (index.html's renderMain(), 'workers' branch) used to call this unconditionally,
// and every call does a full main.innerHTML replace of all worker cards -- including
// every <select> element. Replacing a <select> DOM node while its native dropdown
// popup is open (or while it simply has focus mid-choice) yanks the control out from
// under the operator, closing the popup / resetting the visible selection, even though
// selectedWorkerTaskType itself was never actually cleared. Every INTERACTION-driven
// call site (type-select onchange, task-select onchange via setWorkerTask, expand
// toggle, filter click, model-select onchange) calls this directly and must still run
// so the UI reflects what the operator just did -- only the poll-driven call (isPoll
// === true) is skipped, and only when focus is currently inside one of this tab's own
// selects, i.e. the operator is actively mid-choice. The next 5s tick tries again.
async function renderWorkers(isPoll) {
  if (isPoll) {
    const active = document.activeElement;
    if (active && (active.classList.contains('worker-type-select') || active.classList.contains('worker-task-select'))) {
      return;
    }
    // Top up the completed-tasks log with anything newer than what's already loaded --
    // see refreshNewestCompletedTasks's own header note. Only on the real poll cycle,
    // not every action-triggered re-render (assign-task, filter click, expand/collapse).
    await refreshNewestCompletedTasks();
  }
  // run-log vs recent-tasks (2026-09-08, Grimmethy: "This looks like it's only showing
  // fully completed tasks. I want to see a log of every time an agent is run and the
  // outcome of that run."): a drafting worker's real activity includes attempts that
  // never reach a terminal task state at all (a hard OLLAMA_TIMEOUT, mid-GPU-contention,
  // never produces a usable response) -- /api/instances/<id>/run-log surfaces those too,
  // merged with every model_calls row regardless of outcome. reviewer has no equivalent
  // call-level data (review-task.js's majorityVote never calls recordCall, see that
  // route's own docstring) so it keeps the existing terminal-state recent-tasks view.
  const expandedIsWorker = !!(expandedWorkerId && expandedWorkerId.startsWith('worker'));
  const [instances, workerModels, costSummary, recentTasks] = await Promise.all([
    fetchJson('/api/instances'),
    fetchJson('/api/worker-models'),
    fetchJson('/api/models/cost-summary'),
    // Only fetch for whichever card is currently expanded -- no point loading this for
    // every instance on every 5s poll when at most one card shows it at a time.
    expandedWorkerId
      ? fetchJson(`/api/instances/${encodeURIComponent(expandedWorkerId)}/${expandedIsWorker ? 'run-log' : 'recent-tasks'}`)
      : Promise.resolve(null),
  ]);
  // Candidate list for each worker's own "assign task" override dropdown (2026-09-07
  // follow-up, Grimmethy after live-testing the override: "the only tasks I have
  // access to... are pipeline debrief tasks. The task I want, autodecomp, is in
  // drafting. I need access to the full list of available jobs, they should however be
  // whats available for that specific worker type"). Per-instance now, not one shared
  // list: /api/instances/<id>/assignable-tasks tier-filters for THAT lane and also
  // surfaces tasks already claimed by other lanes (queue/drafting/<lane>/), not just
  // queue/pending/ -- a plain worker-model-style shared list can't express either of
  // those. Fetched only for worker-* instances (canAssignTask), in parallel.
  const assignableByInstance = {};
  await Promise.all(instances.filter(canAssignTask).map(async (inst) => {
    try {
      const r = await fetchJson(`/api/instances/${encodeURIComponent(inst.instanceId)}/assignable-tasks`);
      assignableByInstance[inst.instanceId] = r.items || [];
    } catch (e) {
      assignableByInstance[inst.instanceId] = [];
    }
  }));
  const overrides = workerModels.overrides || {};
  // Per-instance cumulative estimated API cost (2026-08-23, "Where else would it make
  // sense to track it?" -> Workers tab): AGENT_MANAGER_INSTANCE_ID is stamped onto every
  // real model_calls row now (see model-stats-client.js's own recordCall) -- keyed here
  // by instanceId so each worker-card can show its own running total, same "estimate,
  // not a bill" framing as the Models tab's own widget.
  const costByInstance = Object.fromEntries((costSummary.byInstance || []).map((i) => [i.instanceId, i.totalCost]));
  const main = document.getElementById('main');
  const fetchedAt = Date.now();
  instances.forEach(i => { i._fetchedAtMs = fetchedAt; });
  instancesForTimers = instances;
  // Clear the optimistic pending-assign marker the moment real data confirms it --
  // either the pin took (currentTaskId now matches) or the operator/pipeline moved on
  // to something else for this instance since (a stale marker pointing at a taskId this
  // instance is no longer even working toward would be actively misleading, worse than
  // no marker at all).
  instances.forEach((inst) => {
    // Any real currentTaskId -- matching the pin (success) or not (moved on to
    // something else meanwhile) -- means the "waiting to pick this up" state is over.
    if (pendingWorkerAssign[inst.instanceId] && inst.currentTaskId) {
      delete pendingWorkerAssign[inst.instanceId];
    }
  });
  const filterBar = `
    <div class="worker-filter-bar" style="margin-bottom:10px; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px">
      <div></div>
      <label style="display:flex; align-items:center; gap:6px; font-size:0.9em; cursor:pointer" title="Stops every automated Claude call pipeline-wide (worker-reasoning's plan pass, adhoc/research's implement calls, review votes) until unchecked -- preserves your subscription's token budget.">
        <input type="checkbox" id="claude-pause-toggle" ${workerModels.claudePaused ? 'checked' : ''}>
        Pause Claude (preserve subscription tokens)
      </label>
    </div>
  `;
  const shown = instances;
  if (instances.length === 0) { main.innerHTML = '<div class="empty">No instances found -- is the pipeline running?</div>'; return; }
  // Preserve scroll position across the full innerHTML replace below -- same isPoll
  // "don't yank state out from under the operator" reasoning as the dropdown guard
  // above, needed here because the completed-tasks log (renderCompletedTasksSection)
  // can push #main well past one screen, and a poll landing mid-scroll would otherwise
  // silently reset the operator back to the top every 5s.
  const scrollY = window.scrollY;
  main.innerHTML = filterBar + (shown.length === 0
    ? '<div class="empty">No workers match this filter.</div>'
    : shown.map(inst => `
    <div class="worker-card clickable" data-instance-id="${escapeAttr(inst.instanceId)}">
      <div class="row">
        <span class="id">${inst.instanceId}</span>
        ${(() => {
          const kind = modelKindForInstance(inst);
          if (!kind) return '';
          const current = overrides[inst.instanceId] || '';
          const optionsFor = (label, values) => values.length
            ? `<optgroup label="${escapeAttr(label)}">${values.map(m => `<option value="${escapeAttr(m.value)}" ${m.value === current ? 'selected' : ''}>${m.label}</option>`).join('')}</optgroup>`
            : '';
          let body;
          if (kind === 'mixed') {
            // Prefixed so local-worker.sh's refresh_active_model can tell which backend
            // was picked -- see that function's own comment for why this is the fix for
            // "reasoning only shows subscription models."
            body = optionsFor('Claude (subscription)', (workerModels.claudeModels || []).map(m => ({ value: `claude:${m}`, label: m })))
              + optionsFor('Local (Ollama)', (workerModels.ollamaModels || []).map(m => ({ value: `ollama:${m}`, label: m })));
          } else {
            body = (workerModels.ollamaModels || []).map(m => `<option value="${escapeAttr(m)}" ${m === current ? 'selected' : ''}>${m}</option>`).join('');
          }
          return `<select class="worker-model-select" data-instance-id="${escapeAttr(inst.instanceId)}" onclick="event.stopPropagation()"><option value="">(default)</option>${body}</select>`;
        })()}
        ${canAssignTask(inst) ? (() => {
          const items = assignableByInstance[inst.instanceId] || [];
          // Grouped by source (task TYPE) so the picker shows "pipeline_debrief (7)"
          // etc first, rather than one flat list where a deep single-type backlog
          // buries everything else (see selectedWorkerTaskType's own header comment).
          const bySource = {};
          items.forEach((t) => {
            const key = t.source || 'unknown';
            (bySource[key] = bySource[key] || []).push(t);
          });
          const sourceKeys = Object.keys(bySource).sort();
          const selectedType = selectedWorkerTaskType[inst.instanceId] || '';
          // Keep the previously-picked type visible even if its bucket happens to be
          // empty on THIS particular poll (its last task just got claimed elsewhere, or
          // this instance's own assignable-tasks fetch above hit its catch and fell back
          // to [] for one cycle) -- 2026-09-07, same complaint as isPoll above: a
          // transient empty bucket used to collapse the whole drill-down back to the
          // type-only picker, which looked identical to "your selection got reset" even
          // though selectedWorkerTaskType was never actually cleared.
          if (selectedType && !sourceKeys.includes(selectedType)) sourceKeys.push(selectedType);
          sourceKeys.sort();
          const typeSelect = `<select class="worker-type-select" data-instance-id="${escapeAttr(inst.instanceId)}" onclick="event.stopPropagation()" title="Assign a specific task to this worker, overriding the automated priority/tier claim order -- includes tasks already claimed by other workers, tier-filtered for this worker type">
            <option value="">(assign a task…)</option>
            ${sourceKeys.map(k => `<option value="${escapeAttr(k)}" ${k === selectedType ? 'selected' : ''}>${escapeHtml(k)} (${(bySource[k] || []).length})</option>`).join('')}
          </select>`;
          if (!selectedType) return typeSelect;
          const tasksOfSelectedType = bySource[selectedType] || [];
          // A native <select> sizes itself to its widest <option> text -- an untruncated
          // task title (adhoc/decompose titles especially routinely run 80-100+ chars)
          // pushed this whole control off the right edge of the worker card (2026-09-07,
          // Grimmethy: "when I open the manual task that has long task names it sets the
          // selector to the size of the largest... names should be truncated"). Truncate
          // what's SHOWN; the option's own `title` attribute (native hover tooltip) and
          // `data-title` (read by setWorkerTask's confirm-dialog text) both still carry
          // the full, untruncated title -- nothing is actually lost, just not rendered
          // into the control's own width.
          const OPTION_LABEL_MAX = 70;
          const truncateLabel = (s) => (s.length > OPTION_LABEL_MAX ? `${s.slice(0, OPTION_LABEL_MAX - 1)}…` : s);
          const optionLabel = (t) => {
            // A hub member leads with its HUB#### slot (2026-09-20) so a hub in progress is recognisable in this list.
            const rawTitle = t.title || t.id;
            const base = t.hub && !/^HUB\d/.test(rawTitle) ? `${hubTag(t.hub)} · ${rawTitle}` : rawTitle;
            // pinnedTo (2026-09-07, Grimmethy: "why do the 2 reasoning workers have
            // different lists? they really should share the same task list") -- a task
            // pending but already pinned to a SIBLING lane (same tier) now shows here
            // too instead of being invisible; picking it just re-pins it to this lane
            // instead (no kill needed, nothing is running on it yet, unlike the
            // "⚠ running on" case below).
            let full = base;
            if (t.location && t.location !== 'pending') full = `⚠ running on ${t.location.replace(/^drafting:/, '')} — ${base}`;
            else if (t.pinnedTo) full = `📌 pinned to ${t.pinnedTo} — ${base}`;
            // premiumPriority (2026-09-07, Grimmethy: "I am getting tired of manually
            // selecting it for the worker queue every pass") -- surfaces here so the
            // operator can SEE this task is already set to always-claim-first and
            // doesn't need to keep re-picking it via this very dropdown.
            if (t.premiumPriority) full = `★ ${full}`;
            return truncateLabel(full);
          };
          const taskSelect = `<select class="worker-task-select" data-instance-id="${escapeAttr(inst.instanceId)}" onclick="event.stopPropagation()" title="Pick a specific ${escapeAttr(selectedType)} task to assign to this worker">
            <option value="">${tasksOfSelectedType.length ? `(choose a ${escapeHtml(selectedType)} task…)` : `(no ${escapeHtml(selectedType)} tasks right now)`}</option>
            ${tasksOfSelectedType.map(t => `<option value="${escapeAttr(t.id)}" data-title="${escapeAttr(t.title || t.id)}" data-source-lane="${escapeAttr(t.location && t.location !== 'pending' ? t.location.replace(/^drafting:/, '') : '')}" title="${escapeAttr(t.title || t.id)}">${escapeHtml(optionLabel(t))}</option>`).join('')}
          </select>`;
          return typeSelect + taskSelect;
        })() : ''}
        <div class="badge-col">
          <span class="badge ${statusBadgeClass(inst.status, inst.stale)}">${inst.stale ? 'STALE' : inst.status}</span>
          ${inst.stale ? `<span class="stale-timer" id="stale-timer-${inst.instanceId}"></span>` : ''}
          <span class="state-timer" id="state-timer-${inst.instanceId}">${inst.stateAgeSeconds != null ? 'in this state ' + fmtDuration(inst.stateAgeSeconds) : ''}</span>
        </div>
      </div>
      <div class="meta">
        pid ${inst.pid ?? '-'} · model ${inst.model || '-'} · heartbeat ${fmtAge(inst.heartbeatAgeSeconds)} ago
        ${inst.currentTaskId && inst.projectLabel ? ' · <span class="badge ' + (inst.borrowed ? 'warn' : 'idle') + '" title="' + (inst.borrowed ? 'Borrowed: this lane is idle in the active project and is working a task of ' + escapeAttr(inst.projectLabel) + ' (idle-pool borrowing)' : 'This task belongs to the active project') + '">📁 ' + escapeHtml(inst.projectLabel) + (inst.borrowed ? ' (borrowed)' : '') + '</span>' : ''}
        ${inst.currentTaskId && inst.hub ? ' · <span class="badge ok" title="This task belongs to hub ' + escapeAttr(inst.hub.label) + '" style="font-weight:700">🗂 ' + escapeHtml(hubTag(inst.hub)) + '</span>' : ''}
        ${inst.currentTaskId ? ' · working on <strong><a href="#" data-open-task-anywhere="' + escapeAttr(inst.currentTaskId) + '">' + escapeHtml(inst.currentTaskId) + '</a></strong>' + (inst.currentPass ? ' (' + escapeHtml(inst.currentPass) + ')' : '') : ''}
        ${pendingWorkerAssign[inst.instanceId] ? ' · <strong>📌 pinned, waiting for ' + escapeAttr(inst.instanceId) + ' to pick it up…</strong>' : ''}
        ${costByInstance[inst.instanceId] ? ' · ' + fmtUsd(costByInstance[inst.instanceId]) + ' est. API cost' : ''}
      </div>
      ${expandedWorkerId === inst.instanceId ? `
      <div class="worker-recent-tasks">
        <div class="meta" style="margin-top:8px; font-weight:600">${inst.instanceId === 'reviewer' ? 'Last 10 reviewed tasks' : 'Recent runs (every attempt, including failures)'}</div>
        ${recentTasks ? (recentTasks.runs ? renderRunLogList(recentTasks.runs) : renderRecentTasksList(recentTasks.tasks || [])) : '<div class="meta">Loading…</div>'}
      </div>` : ''}
    </div>
  `).join('')) + renderCompletedTasksSection();
  window.scrollTo(0, scrollY);
  setupCompletedTasksObserver();
  if (!completedTasksLog.length && !completedTasksLoading && !completedTasksExhausted) {
    loadMoreCompletedTasks();
  }
  main.querySelectorAll('.worker-card[data-instance-id]').forEach((card) => {
    card.onclick = () => toggleWorkerExpand(card.dataset.instanceId);
  });
  const claudePauseToggle = main.querySelector('#claude-pause-toggle');
  if (claudePauseToggle) {
    claudePauseToggle.onchange = (e) => setClaudePaused(e.target.checked);
  }
  main.querySelectorAll('.worker-model-select').forEach((sel) => {
    sel.onclick = (e) => e.stopPropagation();
    sel.onchange = (e) => { e.stopPropagation(); setWorkerModel(sel.dataset.instanceId, sel.value); };
  });
  main.querySelectorAll('.worker-type-select').forEach((sel) => {
    sel.onclick = (e) => e.stopPropagation();
    sel.onchange = (e) => {
      e.stopPropagation();
      if (sel.value) selectedWorkerTaskType[sel.dataset.instanceId] = sel.value;
      else delete selectedWorkerTaskType[sel.dataset.instanceId];
      renderWorkers();
    };
  });
  main.querySelectorAll('.worker-task-select').forEach((sel) => {
    sel.onclick = (e) => e.stopPropagation();
    sel.onchange = async (e) => {
      e.stopPropagation();
      const taskId = sel.value;
      const opt = sel.selectedOptions[0];
      const title = opt && opt.dataset.title;
      const sourceLane = opt && opt.dataset.sourceLane ? opt.dataset.sourceLane : null;
      sel.value = ''; // reset immediately -- confirm() may be declined, and a real
      // assignment triggers a full renderWorkers() re-render anyway.
      await setWorkerTask(sel.dataset.instanceId, taskId, title, sourceLane);
    };
  });
  main.querySelectorAll('[data-open-task-anywhere]').forEach((link) => {
    link.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openTaskAnywhere(link.dataset.openTaskAnywhere); };
  });
  updateStaleTimers();
}

function fmtDuration(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

function updateStaleTimers() {
  for (const inst of instancesForTimers) {
    // State-runtime tracker: ticks for every instance that reports stateSince. Anchored
    // to the server-computed stateAgeSeconds at fetch time rather than parsing stateSince
    // locally, so a client/server clock skew can't distort the reading.
    const st = document.getElementById('state-timer-' + inst.instanceId);
    if (st && inst.stateAgeSeconds != null) {
      const elapsed = inst.stateAgeSeconds + (Date.now() - inst._fetchedAtMs) / 1000;
      st.textContent = 'in this state ' + fmtDuration(elapsed);
    }
    if (!inst.stale) continue;
    const el = document.getElementById('stale-timer-' + inst.instanceId);
    if (!el) continue;
    const staleSinceMs = new Date(inst.lastHeartbeat).getTime() + inst.staleThresholdSeconds * 1000;
    el.textContent = 'Stale for ' + fmtDuration((Date.now() - staleSinceMs) / 1000);
  }
}

function fmtPct(x) { return x == null ? '-' : Math.round(x * 100) + '%'; }

function fmtNum(x, digits) { return x == null ? '-' : Number(x).toFixed(digits); }

function fmtUsd(x) { return x == null ? '-' : '$' + Number(x).toFixed(4); }

function renderBarCell(value, max, colorVar, fmt) {
  const label = fmt(value);
  if (value == null || !max) return label;
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return `<div>${label}</div><div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%; background:var(--${colorVar})"></div></div>`;
}

function showToast(message, kind = 'error') {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = kind === 'error' ? 'toast-error' : 'toast-info';
  // Force a reflow before adding "show" so the fade-in transition actually plays when
  // the same node is reused back-to-back (toggling a class that's already set doesn't
  // retrigger a CSS transition).
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(toastHideTimer);
  toastHideTimer = setTimeout(() => { el.classList.remove('show'); }, 3000);
}

function renderProviderToggle(idAttr) {
  const provider = providerChoices[idAttr] || 'local';
  const claudeClass = provider === 'claude' ? ' provider-toggle-claude' : '';
  const label = provider === 'claude' ? 'Claude' : 'Local';
  return `<button type="button" class="secondary provider-toggle${claudeClass}" id="${idAttr}" data-provider="${provider}" title="Local model vs. your Claude subscription -- click to switch">${label}</button>`;
}

function wireProviderToggle(idAttr) {
  const btn = document.getElementById(idAttr);
  if (!btn) return;
  btn.onclick = (e) => {
    e.stopPropagation();
    const next = btn.dataset.provider === 'local' ? 'claude' : 'local';
    providerChoices[idAttr] = next;
    btn.dataset.provider = next;
    btn.textContent = next === 'local' ? 'Local' : 'Claude';
    btn.classList.toggle('provider-toggle-claude', next === 'claude');
  };
}

function providerPayload(idAttr) {
  const btn = document.getElementById(idAttr);
  return { provider: (btn && btn.dataset.provider) || 'local' };
}

// 2026-09-15: Chat moved out of this repo entirely into its own plugin
// (agent-manager-chat-plugin, slotKind:"persistent-sidebar" in plugins.json) -- see
// /home/wok/.claude/plans/immutable-noodling-axolotl.md. chatSetCollapsed/chatPanelInit/
// chatStartNew/chatSend/chatToggleReserve/chatWireProviderToggle/chatRender (and the
// module-level `chatSession`) are gone; the plugin's own iframe'd page owns all of that
// now, in its own document/JS context this page can't reach into directly. What's left
// here is generic (works for ANY future slotKind:"persistent-sidebar" plugin, not just
// Chat) plus the one cross-iframe bridge "Send to chat" still needs.

// Cache of the currently-active persistent-sidebar plugins, refreshed by
// mountPersistentSidebarPlugins() -- sendTextToChat() below needs a plugin's proxy base
// path without re-fetching /api/plugins on every single click.
let _persistentSidebarPlugins = [];

async function mountPersistentSidebarPlugins() {
  const layout = document.getElementById('layout');
  if (!layout) return;
  let data;
  try {
    data = await fetchJson('/api/plugins');
  } catch (e) {
    return; // best-effort -- a dashboard with no plugins configured yet has nothing to mount
  }
  const plugins = (data.plugins || []).filter((p) => p.slotKind === 'persistent-sidebar' && p.active && p.url);
  _persistentSidebarPlugins = plugins;
  // Remove any previously-mounted sidebars/toggles before remounting (refresh() can
  // call this again later if the plugin list ever changes at runtime).
  layout.querySelectorAll('.plugin-sidebar').forEach((el) => el.remove());
  document.querySelectorAll('.plugin-sidebar-toggle').forEach((el) => el.remove());
  for (const plugin of plugins) {
    const storageKey = `agentManagerPluginSidebar:${plugin.name}`;
    const collapsed = localStorage.getItem(storageKey) === 'collapsed';
    const proxyBase = `/api/plugins/${encodeURIComponent(plugin.name)}/proxy`;
    // Every plugin route this dashboard proxies to is expected to serve its own real
    // page at "<proxyBase>/<something>" (see agent-manager-chat-plugin's own GET /chat
    // for why a bare trailing-slash root won't match the generic proxy route at all --
    // Werkzeug's <path:subpath> converter never matches an empty segment). "chat" is
    // Chat's own choice, not a generic convention -- a future second persistent-sidebar
    // plugin can name its own page path however it likes, this just has to match.
    const pagePath = plugin.homePath || 'chat';

    const aside = document.createElement('aside');
    aside.className = 'plugin-sidebar' + (collapsed ? ' sidebar-collapsed' : '');
    aside.dataset.plugin = plugin.name;
    const iframe = document.createElement('iframe');
    iframe.src = `${proxyBase}/${pagePath}`;
    iframe.title = plugin.description || plugin.name;
    aside.appendChild(iframe);
    layout.appendChild(aside);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'plugin-sidebar-toggle';
    toggle.dataset.plugin = plugin.name;
    toggle.title = `Show/hide ${plugin.description || plugin.name}`;
    toggle.textContent = plugin.sidebarLabel || 'Chat';
    toggle.onclick = () => {
      const isCollapsed = aside.classList.toggle('sidebar-collapsed');
      localStorage.setItem(storageKey, isCollapsed ? 'collapsed' : 'expanded');
    };
    document.body.appendChild(toggle);
  }
}

// "Send to chat" (task detail modal, Brain Dump entries): posts through the same
// same-origin proxy path the sidebar iframe itself uses, then tells that iframe to
// refresh via postMessage -- this page cannot call into the iframe's own JS/DOM
// directly (different document, and same-origin-policy-isolated regardless once served
// from a different real port behind the proxy). The plugin's own chat.js listens for
// {type: "agent-manager-chat-refresh"} and re-fetches+re-renders its active session
// when it arrives. Un-collapses the sidebar so the sent text is actually visible.
async function sendTextToChat(text) {
  if (!_persistentSidebarPlugins.length) await mountPersistentSidebarPlugins();
  const plugin = _persistentSidebarPlugins.find((p) => p.name === 'agent-manager-chat-plugin') || _persistentSidebarPlugins[0];
  if (!plugin) throw new Error('no active Chat sidebar plugin to send to');
  const proxyBase = `/api/plugins/${encodeURIComponent(plugin.name)}/proxy`;
  const r = await fetch(`${proxyBase}/api/chat/inject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.detail || body.description || `HTTP ${r.status}`);
  }
  await r.json().catch(() => null);
  const aside = document.querySelector(`.plugin-sidebar[data-plugin="${plugin.name}"]`);
  if (aside) {
    aside.classList.remove('sidebar-collapsed');
    localStorage.setItem(`agentManagerPluginSidebar:${plugin.name}`, 'expanded');
    const iframe = aside.querySelector('iframe');
    if (iframe && iframe.contentWindow) iframe.contentWindow.postMessage({ type: 'agent-manager-chat-refresh' }, '*');
  }
}

async function renderClaudeSettingsPanel() {
  const settings = await fetchJson('/api/settings/claude');
  claudeSettingsCache = settings;
  const modelOpts = settings.modelChoices.map(m => `<option value="${m}" ${m === settings.model ? 'selected' : ''}>${m}</option>`).join('');
  const effortOpts = settings.effortChoices.map(e => `<option value="${e}" ${e === settings.effort ? 'selected' : ''}>${e}</option>`).join('');
  const tokenStatus = settings.tokenConfigured
    ? '<span style="color:var(--ok)">Subscription token configured</span>'
    : '<span style="color:var(--warn)">No subscription token set -- Claude toggle will fail until one is added</span>';
  return `
    <div class="grill-session" style="margin-bottom:16px">
      <div class="field-label">Claude Subscription Defaults</div>
      <div class="meta" style="margin-bottom:8px">Used whenever a Discuss/Grill conversation is switched to Claude via its toggle, unless that conversation picks a different model/effort itself.</div>
      <div class="row" style="gap:8px;align-items:center">
        <label>Model <select id="claude-default-model">${modelOpts}</select></label>
        <label>Effort <select id="claude-default-effort">${effortOpts}</select></label>
        <button type="button" class="action" id="claude-settings-save">Save</button>
        <span id="claude-settings-status" class="meta"></span>
      </div>
      <div class="field-label" style="margin-top:14px">Subscription Token</div>
      <div class="meta" style="margin-bottom:6px">${tokenStatus} -- generate one with <code>claude setup-token</code> (opens a browser to approve, then prints a token good for about a year). Pasted here, it's saved to <code>agent-manager.env</code> and never shown again, including to this page -- only whether one is set.</div>
      <div class="row" style="gap:8px;align-items:center">
        <input type="password" id="claude-token-input" placeholder="Paste token from \`claude setup-token\`" autocomplete="off" style="flex:1;background:var(--panel);border:2px solid var(--border);color:var(--text);padding:6px 10px;border-radius:6px;font-family:monospace;font-size:12px">
        <button type="button" class="action" id="claude-token-save">Save Token</button>
        ${settings.tokenConfigured ? '<button type="button" class="secondary" id="claude-token-clear">Clear</button>' : ''}
      </div>
    </div>`;
}

function wireClaudeSettingsPanel() {
  const btn = document.getElementById('claude-settings-save');
  if (btn) btn.onclick = async () => {
    const model = document.getElementById('claude-default-model').value;
    const effort = document.getElementById('claude-default-effort').value;
    const status = document.getElementById('claude-settings-status');
    try {
      claudeSettingsCache = await (await fetch('/api/settings/claude', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, effort }),
      })).json();
      status.textContent = 'Saved.';
      setTimeout(() => { status.textContent = ''; }, 2000);
    } catch (e) {
      status.textContent = 'Save failed: ' + e.message;
    }
  };

  const tokenBtn = document.getElementById('claude-token-save');
  if (tokenBtn) tokenBtn.onclick = async () => {
    const input = document.getElementById('claude-token-input');
    const token = input.value.trim();
    if (!token) { showToast('Paste a token first.'); return; }
    try {
      const res = await fetch('/api/settings/claude-token', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(result.description || ('HTTP ' + res.status));
      // Wipe the field immediately rather than leaving the pasted secret sitting in a
      // form input (and in the browser's own form-autofill history) any longer than
      // the single click it took to save it.
      input.value = '';
      showToast(result.restarted ? 'Token saved -- pipeline restarted to pick it up.' : 'Token saved.', 'info');
      renderModelsTab();
    } catch (e) {
      showToast('Could not save token: ' + e.message);
    }
  };

  const clearBtn = document.getElementById('claude-token-clear');
  if (clearBtn) clearBtn.onclick = async () => {
    if (!confirm('Remove the saved Claude subscription token? The toggle will stop working until a new one is added.')) return;
    try {
      await fetch('/api/settings/claude-token', { method: 'DELETE' });
      showToast('Token cleared.', 'info');
      renderModelsTab();
    } catch (e) {
      showToast('Could not clear token: ' + e.message);
    }
  };
}

async function renderClaudeUsagePanel() {
  let usage;
  try {
    usage = await fetchJson('/api/claude-usage');
  } catch (e) {
    return '';
  }
  if (!usage.available) {
    return `<div class="grill-session" style="margin-bottom:16px"><div class="field-label">Claude Usage</div><div class="meta">Not available: ${escapeHtml(usage.reason || 'unknown')}</div></div>`;
  }
  const healthLabel = usage.healthy
    ? '<span style="color:var(--ok)">healthy</span>'
    : `<span style="color:var(--bad)">rate-limited</span>`;
  const lastHitLine = usage.lastRateLimit
    ? `<div class="meta">Last rate-limit hit: ${new Date(usage.lastRateLimit.at).toLocaleString()}</div>` : '';
  const resetLine = usage.lastRateLimit && usage.lastRateLimit.resetsAt
    ? `<div class="meta">Resets: ${new Date(usage.lastRateLimit.resetsAt).toLocaleString()}</div>` : '';
  const est = usage.estimate;
  const estimateLine = est
    ? `<div class="meta" style="margin-top:6px" title="${escapeAttr(est.basis)}">Estimated: ${est.usedTokens.toLocaleString()}/~${est.ceilingTokens.toLocaleString()} tokens used (${est.usedPercent}%) -- learned from ${est.sampleCount} past rate-limit hit${est.sampleCount === 1 ? '' : 's'}${est.estimatedCapAt ? `, projected to hit the cap around ${new Date(est.estimatedCapAt).toLocaleString()} at the current pace` : ''}</div>`
    : `<div class="meta" style="margin-top:6px">No used/total estimate yet -- needs at least one real rate-limit hit in the last 7 days to learn an account-specific ceiling from.</div>`;
  return `
    <div class="grill-session" style="margin-bottom:16px">
      <div class="field-label">Claude Usage</div>
      <div>${healthLabel} <span class="meta">-- ${escapeHtml(usage.reason || '')}</span></div>
      ${lastHitLine}
      ${resetLine}
      ${estimateLine}
      <div class="row" style="gap:24px;margin-top:6px">
        <div class="stat" title="${usage.sinceLastLimit.usedFallback5h ? 'No rate-limit hit recorded yet in the last 7 days -- no real window boundary to anchor to, showing a trailing 5h lookback instead.' : 'Since ' + new Date(usage.sinceLastLimit.windowStart).toLocaleString() + ', the real start of the current rate-limit window (the last reset), not a generic trailing lookback.'}"><strong>${usage.sinceLastLimit.calls}</strong>calls since ${usage.sinceLastLimit.usedFallback5h ? 'last 5h (no hit yet)' : 'last limit'}</div>
        <div class="stat" title="${usage.sinceLastLimit.usedFallback5h ? 'No rate-limit hit recorded yet in the last 7 days -- no real window boundary to anchor to, showing a trailing 5h lookback instead.' : 'Since ' + new Date(usage.sinceLastLimit.windowStart).toLocaleString() + ', the real start of the current rate-limit window (the last reset), not a generic trailing lookback.'}"><strong>${usage.sinceLastLimit.tokens.toLocaleString()}</strong>tokens since ${usage.sinceLastLimit.usedFallback5h ? 'last 5h (no hit yet)' : 'last limit'}</div>
        <div class="stat"><strong>${usage.rolling7d.calls}</strong>calls / last 7d</div>
        <div class="stat"><strong>${usage.rolling7d.tokens.toLocaleString()}</strong>tokens / last 7d</div>
      </div>
      <div class="meta" style="margin-top:6px">Volume trend, not a live quota gauge -- Claude Code only ever reports a rate-limit hit reactively, after it happens. "Since last limit" is anchored to the real window boundary (the last reset), not a generic trailing lookback. Includes both interactive \`claude\` sessions and this pipeline's own headless calls on this machine.</div>
    </div>`;
}

function renderCaseInfoModal(kase) {
  const backdrop = document.getElementById('modal-backdrop');
  const content = document.getElementById('modal-content');
  content.innerHTML = `
    <button class="close" onclick="closeDetail()">&times;</button>
    <h2>${escapeHtml(kase.id)}</h2>
    <div><strong>Category:</strong> ${escapeHtml(kase.category)} &nbsp; <strong>Grader:</strong> ${escapeHtml(kase.grader)}${kase.grader === 'judge' ? ' <span class="badge warn">scored by a Claude call against a rubric, not auto-checkable</span>' : ''}</div>
    <div class="field-label" style="margin-top:14px">What this measures</div>
    <div>${escapeHtml(kase.description || '(no description)')}</div>
    <div class="field-label" style="margin-top:14px">Full Prompt</div>
    <pre>${escapeHtml(kase.prompt)}</pre>
  `;
  backdrop.classList.add('open');
}

function openGlobalBrainDumpModal() {
  const backdrop = document.getElementById('modal-backdrop');
  const content = document.getElementById('modal-content');
  content.innerHTML = `
    <button class="close" onclick="closeDetail()">&times;</button>
    <h2>Brain Dump</h2>
    <div class="capture-row">
      <input id="global-bd-capture-input" placeholder="Brain dump -- capture anything" autocomplete="off">
      <button class="action" id="global-bd-capture-btn" title="Save this note as a new Brain Dump entry">Capture</button>
    </div>
  `;
  backdrop.classList.add('open');
  const input = document.getElementById('global-bd-capture-input');
  input.focus();
  const submit = async () => {
    const text = input.value.trim();
    if (!text) return;
    const btn = document.getElementById('global-bd-capture-btn');
    btn.disabled = true;
    try {
      await fetch('/api/brain-dump/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      closeDetail();
      if (activeTab === 'brain-dump') refreshBrainDumpEntries(true);
    } catch (e) {
      alert('Could not capture: ' + e.message);
      btn.disabled = false;
    }
  };
  document.getElementById('global-bd-capture-btn').onclick = submit;
  input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
}

async function postTaskAction(state, id, action, confirmMessage, body) {
  if (confirmMessage && !confirm(confirmMessage)) return;
  try {
    const opts = { method: 'POST' };
    if (body) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body); }
    const res = await fetch(`/api/task/${state}/${encodeURIComponent(id)}/${action}`, opts);
    if (!res.ok) {
      const respBody = await res.json().catch(() => ({}));
      // 2026-08-24 (pipeline hardening): a requeue can come back 409 specifically because
      // this task's blockedReason looks like the same problem as an earlier attempt (see
      // app.py's _repeated_blocker_match) -- not a generic error, a real "are you sure"
      // checkpoint. Only requeue ever sends this shape; every other 409 (e.g. "already
      // has a task in pending/") falls through to the plain alert below same as before.
      if (res.status === 409 && action === 'requeue' && !(body && body.force)) {
        if (confirm(`${respBody.description}\n\nRequeue anyway?`)) {
          return postTaskAction(state, id, action, null, { force: true });
        }
        return;
      }
      throw new Error(respBody.description || `${res.status}`);
    }
    await renderQueueTab(state);
  } catch (e) {
    alert(`Could not ${action} '${id}': ` + e.message);
  }
}

function allSourceNames() {
  if (!allSourceNamesPromise) {
    allSourceNamesPromise = fetchJson('/api/job-types').then((jobTypes) => jobTypes.map((j) => j.name).sort());
  }
  return allSourceNamesPromise;
}

function wireQueueSourceFilter(state) {
  const select = document.getElementById('queue-source-filter');
  if (!select) return;
  select.onchange = () => {
    queueSourceFilter[state] = select.value;
    // A new filter means a new result set -- start back at page 1, same reasoning
    // scroll-triggered pagination already resets per-state, not just appends onto
    // whatever page depth the PREVIOUS filter had scrolled to.
    queueLoadedCount[state] = QUEUE_PAGE_SIZE;
    renderQueueTab(state);
  };
}

// Hub Tasks tab sort control. Choice persists in localStorage so it survives a reload and
// the 5s auto-refresh; changing it resets pagination to page 1 the same way the task-type
// filter does.
function wireHubSort(state) {
  const select = document.getElementById('hub-sort-select');
  if (!select) return;
  select.onchange = () => {
    localStorage.setItem('agentManagerHubSort', select.value);
    queueLoadedCount[state] = QUEUE_PAGE_SIZE;
    renderQueueTab(state);
  };
}

// Prompt for a hub's priority and POST it. Lower = worked first; blank clears the ranking.
// The backend route (/api/task-anywhere/<id>/hub-priority) only accepts a coordinating
// hub, and src/hub-priority.js reads the field on both this tab's sort and the worker
// claim order for the hub's children.
async function setHubPriority(id, current) {
  const raw = window.prompt(
    `Priority for hub "${id}"\n\nLower number = worked first. Leave blank to clear the ranking (unranked hubs run oldest-first).`,
    current === null || current === undefined ? '' : String(current));
  if (raw === null) return; // cancelled
  const trimmed = raw.trim();
  let payload;
  if (trimmed === '') {
    payload = { priority: null };
  } else if (/^-?\d+$/.test(trimmed)) {
    payload = { priority: parseInt(trimmed, 10) };
  } else {
    showToast('Hub priority must be a whole number.', 'error');
    return;
  }
  try {
    const res = await fetch(`/api/task-anywhere/${encodeURIComponent(id)}/hub-priority`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showToast(payload.priority === null ? 'Hub priority cleared.' : `Hub priority set to ${payload.priority}.`, 'info');
    renderQueueTab('coordinating');
  } catch (e) {
    showToast('Could not set hub priority: ' + e.message, 'error');
  }
}

// Hub Tasks row progress: BUILT pieces (finished, committed, waiting on the merge) are real progress -- a hub of pending-merge pieces used to read
// "0 / 3 sub-tasks done" for its whole life. `done` = merged/closed; `built` = done + awaiting merge (coordinator-sweep.js childPhase).
// "HUB0002 3/3" for a hub member, "HUB0002" for the hub itself or a member the checklist does not list (workers tab, assign dropdown).
function hubTag(hub) {
  if (!hub || !hub.label) return '';
  return hub.seq && hub.total ? `${hub.label} ${hub.seq}/${hub.total}` : hub.label;
}

function hubProgressChip(t) {
  const p = t.progress;
  if (!p) return '<span style="color:var(--warn)">☑ ? sub-tasks</span>';
  const built = p.built != null ? Math.max(p.built, p.done || 0) : (p.done || 0);
  const gate = (t.integrationGate || {}).status;
  const gateClear = gate == null || gate === 'passed' || gate === 'skipped';
  if (p.total > 0 && built === p.total && gateClear) {
    return `<span style="color:var(--ok)" title="Every piece is built; the hub lands as one merge">✓ ready to merge — ${built} / ${p.total} built${p.done ? ` · ${p.done} merged` : ''}</span>`;
  }
  return `<span style="color:var(--warn)">☑ ${built} / ${p.total} built${built > (p.done || 0) ? ` · ${p.done || 0} merged` : ''}</span>`;
}

async function renderQueueTab(state) {
  if (!queueLoadedCount[state]) queueLoadedCount[state] = QUEUE_PAGE_SIZE;
  queueLoadInFlight = true;
  const sourceFilter = queueSourceFilter[state] || '';
  const filterQS = sourceFilter ? `&source=${encodeURIComponent(sourceFilter)}` : '';
  // Hub Tasks tab sort (2026-09-09, Grimmethy: "I'd like the hubs to be sortable either
  // alphabetically by name or by priority"). Only the coordinating state honours it;
  // 'priority' (the default) = explicit hubPriority asc, then unranked hubs oldest-first.
  const hubSort = state === 'coordinating'
    ? (localStorage.getItem('agentManagerHubSort') || 'priority')
    : '';
  const sortQS = hubSort ? `&sort=${encodeURIComponent(hubSort)}` : '';
  let tasks, total;
  try {
    const resp = await fetchJson(`/api/queue/${state}?limit=${queueLoadedCount[state]}&offset=0${filterQS}${sortQS}`);
    tasks = resp.items;
    total = resp.total;
  } finally {
    queueLoadInFlight = false;
  }
  queueHasMore[state] = queueLoadedCount[state] < total;
  const main = document.getElementById('main');

  const sourceNames = await allSourceNames();
  const filterOptionsHtml = ['<option value="">All task types</option>']
    .concat(sourceNames.map((n) => `<option value="${escapeAttr(n)}" ${n === sourceFilter ? 'selected' : ''}>${escapeHtml(n)}</option>`))
    .join('');
  const hubSortHtml = state === 'coordinating'
    ? `<label class="meta" style="margin-left:14px">Sort hubs: <select id="hub-sort-select">
         <option value="priority" ${hubSort === 'priority' ? 'selected' : ''}>Priority (then oldest first)</option>
         <option value="name" ${hubSort === 'name' ? 'selected' : ''}>Name (A–Z)</option>
       </select></label>`
    : '';
  const filterHtml = `<div class="row" style="margin-bottom:10px"><label class="meta">Task type: <select id="queue-source-filter">${filterOptionsHtml}</select></label>${hubSortHtml}</div>`;

  if (tasks.length === 0) {
    main.innerHTML = filterHtml + `<div class="empty">${sourceFilter ? `No "${escapeHtml(sourceFilter)}" tasks here.` : 'Nothing here.'}</div>`;
    wireQueueSourceFilter(state);
    wireHubSort(state);
    return;
  }
  const showArchiveRequeue = state === 'blocked' || state === 'done';
  // Archive alone (no generic Requeue -- that moves to pending/, wrong for an
  // adhoc-domain task; resolving happens via the detail modal's own picker instead, see
  // renderTaskDetailModal).
  const showArchiveOnly = state === 'needs-clarification';
  // A plain requeue writes to pending/, which strands an adhoc-shaped task (nextAdhocTask only scans queue/adhoc/); the server refuses those too.
  const isAdhocShapedTask = (t) => t && (t.domain === 'adhoc' || t.source === 'manual' || t.source === 'derived_task');
  // apply-task.js's awaiting-confirm gate (src/apply-group-b.js's batchContainsDeleteMode):
  // Confirm re-runs this exact task for real (stamps deleteConfirmedAt, moves to approved/
  // for the next apply-task.sh pass); Deny is the existing generic Archive action -- no
  // separate deny endpoint needed, giving up on a delete-containing batch is exactly what
  // Archive already means everywhere else in this table.
  const showConfirmDeny = state === 'awaiting-confirm';
  const showApply = state === 'approved';

  // 'prompt'-tier tasks get an active badge here instead of a plain row -- the whole
  // point of that tier vs 'approve' is not sitting unnoticed (see /api/job-types'
  // approvalMode field). Best-effort: a failed fetch just means no badges render, same
  // "degrade gracefully" convention JOB_TYPES' own jobTypes-null fallback already uses.
  let approvalModeBySource = {};
  if (showApply) {
    try {
      const jobTypes = await fetchJson('/api/job-types');
      jobTypes.forEach((j) => { approvalModeBySource[j.name] = j.approvalMode; });
    } catch (e) { /* badges just won't render */ }
  }

  // Hub Tasks family header (2026-09-08, Grimmethy: "a top hub level label ... to show the
  // name of the entire family of hubs"): api_queue_state stamps hubFamily on every hub in a
  // family (the topmost hub's own title), so a muted-blue divider row can be inserted the
  // first time a new family appears in the (already hierarchy-ordered) list -- works even
  // when a page starts mid-family, since every row carries its family's label, not just roots.
  let lastHubFamily = null;
  const rows = tasks.map(t => {
    const isPrompt = showApply && approvalModeBySource[t.source] === 'prompt';
    // Orange left-border + ⚠ prefix on every row here -- the actual ask (Discuss session
    // on context-aware-file-path-prefetch-job.md): surface these prominently rather than
    // let them blend into an ordinary-looking list and get silently orphaned.
    const rowClass = state === 'needs-clarification' ? 'clickable needs-clarification-row' : 'clickable';
    // awaiting-confirm holds two different things behind one shared gate/endpoint (see
    // apply-task.js's own two gates and api_task_confirm_delete's comment) -- the delete-
    // mode Group B batch this tab/copy was originally written for, and (Brain Dump #67,
    // 2026-08-17) an adhoc task with a real agentic-drafted code diff. Same domain/source
    // signal resolveSourceName() itself checks, cheap enough to duplicate client-side
    // rather than adding a field just for this label.
    const isAdhocConfirm = state === 'awaiting-confirm' && (t.domain === 'adhoc' || t.source === 'manual');
    // A third thing this same shared gate/endpoint holds (Brain Dump #1 follow-up,
    // 2026-08-17) -- a research task with a real agentic web-research write-up, same
    // "check the task's own domain" signal as isAdhocConfirm above.
    const isResearchConfirm = state === 'awaiting-confirm' && t.domain === 'research';
    // A fourth thing this shared gate holds (2026-09-01): a pipeline_forensics ranked
    // root-cause report, held for a human read BEFORE its RECOMMENDED FOLLOW-UP FIX is
    // filed as an AC-NNN pipeline-fix candidate (applyForensicsReport pass 1 -> pass 2).
    const isForensicsConfirm = state === 'awaiting-confirm' && t.source === 'pipeline_forensics';
    const detailCell = t.needsClarification
      ? `<span style="color:var(--warn)">⚠ ${t.needsClarification.reason === 'ambiguous' ? 'ambiguous match' : t.needsClarification.reason === 'design-decision' ? 'needs a human decision' : 'no anchor match'}</span>`
      : isAdhocConfirm
        ? '<span style="color:var(--warn)">⚠ real code diff ready to apply</span>'
        : isResearchConfirm
          ? '<span style="color:var(--warn)">📚 research write-up ready to file</span>'
          : isForensicsConfirm
            ? '<span style="color:var(--warn)">📋 root-cause report — confirm to file the fix candidate</span>'
          : state === 'awaiting-confirm'
            ? '<span style="color:var(--bad)">🗑 contains a delete</span>'
          : state === 'coordinating'
            ? (t.coordinatorBlocked
              ? `<span style="color:var(--bad)" title="${escapeAttr(t.blockedReason || '')}">⛔ stuck ${t.progress ? `at ${t.progress.done}/${t.progress.total}` : ''}${t.coordinatorBlocked.escalated ? ' — needs a human' : ''}: ${escapeHtmlBright((t.blockedReason || '').slice(0, 90))}</span>`
              : hubProgressChip(t))
            // 2026-09-08: was escapeHtml(t.blockedReason).slice(0, 80) -- sliced the
            // escaped output, not the raw text. Harmless before (worst case: a cut
            // HTML entity), but would slice straight through a <span> tag once brightening
            // wraps long words, producing broken markup. Slice the raw text first instead,
            // matching the sibling branch just above.
            : (t.blockedReason ? '<span style="color:var(--bad)">' + escapeHtmlBright(t.blockedReason.slice(0, 80)) + '</span>' : (t.branch || t.doneMarker || ''));
    // Dead-adhoc-task flag (adhoc-staleness-flag.js). Chip + evidence tooltip; the
    // retire action is the row's existing Archive/Reject button, plus a Keep to dismiss.
    const sf = t.stalenessFlag;
    const staleChip = sf ? (() => {
      const label = { 'already-implemented': '🪦 already implemented', 'duplicate-of': '👯 duplicate',
        'invalid-premise': '❓ invalid premise', 'decompose-loop': '♻️ can\'t decompose — re-scope',
        'retries-exhausted': '🧗 capability ceiling', 'fabrication-repeat': '🧗 capability ceiling',
        'recheck-verdict-archive': '🪦 recheck: retire' }[sf.reason] || `⚑ ${sf.reason}`;
      const tip = escapeAttr(((sf.evidence || []).join(' • ')).slice(0, 400) + `  [${sf.confidence}${sf.voteResult ? ', ' + sf.voteResult : ''}]`);
      const col = sf.confidence === 'high' ? 'var(--bad)' : 'var(--warn)';
      return `<span title="${tip}" style="display:inline-block;margin-bottom:3px;padding:1px 5px;border:1px solid ${col};border-radius:3px;color:${col};font-size:11px">${label}</span><br>`;
    })() : '';
    const rereviewBtn = t.rereviewable ? `<button type="button" class="secondary task-rereview-btn" data-id="${escapeAttr(t.id)}" title="Send this SAME draft back to review (no redraft) -- for when the draft was fine and the review side was wrong">Re-review</button>` : '';
    const keepBtn = sf ? `<button type="button" class="secondary task-staleness-keep-btn" data-id="${escapeAttr(t.id)}" title="Dismiss this flag -- the task stays and is not re-flagged for a while">Keep</button>` : '';
    // Stale-grounding flag (context-trim-sweep.js): the task's file-content anchoring went
    // stale and re-anchoring against current content never resolved it. Same chip + Keep
    // pattern as stalenessFlag above -- both can show simultaneously, though the sweep
    // itself skips a task carrying a fresh stalenessFlag:{disposition:'retire'}.
    const ctf = t.contextTrimFlag;
    const trimChip = ctf ? (() => {
      const tip = escapeAttr(((ctf.evidence || []).join(' • ')).slice(0, 400) + `  [${ctf.confidence}]`);
      const col = ctf.confidence === 'strong' ? 'var(--bad)' : 'var(--warn)';
      return `<span title="${tip}" style="display:inline-block;margin-bottom:3px;padding:1px 5px;border:1px solid ${col};border-radius:3px;color:${col};font-size:11px">🔍 stale grounding — needs re-anchoring</span><br>`;
    })() : '';
    const trimKeepBtn = ctf ? `<button type="button" class="secondary task-context-trim-keep-btn" data-id="${escapeAttr(t.id)}" title="Dismiss this flag -- the task stays as-is and won't be re-anchored for a while">Keep grounding as-is</button>` : '';
    // Hub Tasks family indent (2026-09-08): hubDepth comes pre-computed from api_queue_state's
    // parentHub tree walk (coordinating state only, undefined/0 everywhere else -- no-op).
    // Hub priority chip + Set-priority button (2026-09-09): `hubPriority` (lower = worked
    // first) drives both this tab's default sort and the worker claim order for the hub's
    // children. Shown on every coordinating row; the button prompts and POSTs to
    // /api/task-anywhere/<id>/hub-priority.
    const hubPriorityControl = state === 'coordinating'
      ? `<div style="margin-top:3px">`
        + (t.hubPriority !== null && t.hubPriority !== undefined
          ? `<span title="Hub priority — lower is worked first" style="display:inline-block;padding:1px 5px;border:1px solid var(--link);border-radius:3px;color:var(--link);font-size:11px">P${escapeHtml(String(t.hubPriority))}</span> `
          : `<span class="meta" style="font-size:11px">unranked</span> `)
        + `<button type="button" class="secondary hub-priority-btn" data-id="${escapeAttr(t.id)}" data-priority="${t.hubPriority === null || t.hubPriority === undefined ? '' : escapeAttr(String(t.hubPriority))}" style="padding:0 6px;font-size:11px" title="Set or clear this hub's priority">Set priority</button>`
        + `</div>`
      : '';
    const hubIdCell = state === 'coordinating'
      ? `<td${t.hubDepth ? ` style="padding-left:${t.hubDepth * 14 + 4}px"` : ''}>${t.hubDepth ? '↳ ' : ''}${t.id}${hubPriorityControl}</td>`
      : `<td>${t.id}</td>`;
    let familyHeaderRow = '';
    if (state === 'coordinating' && t.hubFamily && t.hubFamily !== lastHubFamily) {
      familyHeaderRow = `<tr><td colspan="4" style="background:rgba(91,157,255,0.14);color:var(--link);font-weight:600;padding:6px 8px;border-top:1px solid var(--border)">🗂 ${escapeHtml(t.hubFamily)}</td></tr>`;
      lastHubFamily = t.hubFamily;
    }
    return `${familyHeaderRow}
    <tr class="${rowClass}" data-id="${t.id}" data-state="${state}">
      ${hubIdCell}
      <td>${escapeHtmlBright(t.title || '')}${isPrompt ? ' <span class="badge warn" title="This source is set to \'prompt\' -- it still needs your explicit Apply click, same as approve, but is actively badged so it does not sit unnoticed">needs review</span>' : ''}</td>
      <td>${t.domain || ''}/${t.source || ''}</td>
      <td>${staleChip}${trimChip}${detailCell}</td>
      ${showArchiveRequeue ? `<td>
        <button type="button" class="secondary task-archive-btn" data-id="${escapeAttr(t.id)}">Archive</button>
        <button type="button" class="secondary task-requeue-btn" data-id="${escapeAttr(t.id)}">Requeue</button>
        ${rereviewBtn}
        ${keepBtn}
        ${trimKeepBtn}
      </td>` : ''}
      ${showArchiveOnly ? `<td>
        ${isAdhocShapedTask(t) ? '' : `<button type="button" class="secondary task-requeue-btn" data-id="${escapeAttr(t.id)}" title="Send it back for a fresh draft (adhoc tasks use the picker / answer box instead)">Requeue</button>`}
        <button type="button" class="secondary task-done-btn" data-id="${escapeAttr(t.id)}">Mark Done</button>
        <button type="button" class="secondary task-archive-btn" data-id="${escapeAttr(t.id)}">Reject</button>
        <button type="button" class="secondary task-discuss-btn" data-id="${escapeAttr(t.id)}">Discuss</button>
        ${rereviewBtn}
        ${keepBtn}
      </td>` : ''}
      ${showConfirmDeny ? `<td>
        <button type="button" class="secondary task-confirm-delete-btn" data-id="${escapeAttr(t.id)}" data-adhoc="${isAdhocConfirm}" data-research="${isResearchConfirm}" data-forensics="${isForensicsConfirm}">${isAdhocConfirm ? 'Confirm & Apply' : isResearchConfirm ? 'Confirm & File' : isForensicsConfirm ? 'Confirm & File Fix Candidate' : 'Confirm Delete'}</button>
        <button type="button" class="secondary task-archive-btn" data-id="${escapeAttr(t.id)}" data-adhoc="${isAdhocConfirm}" data-research="${isResearchConfirm}" data-forensics="${isForensicsConfirm}">Deny</button>
      </td>` : ''}
      ${showApply ? `<td><button type="button" class="secondary task-apply-btn" data-id="${escapeAttr(t.id)}">Apply</button></td>` : ''}
    </tr>
  `;
  }).join('');
  const actionHeader = (showArchiveRequeue || showArchiveOnly || showConfirmDeny || showApply) ? '<th>Actions</th>' : '';
  const footer = `<div class="meta" style="padding:10px 4px">Showing ${tasks.length} of ${total}${queueHasMore[state] ? ' -- scroll for more' : ''}</div>`
    + (state === 'needs-clarification' ? '<div class="meta" style="padding:0 4px">Click a row to pick a file path, answer an open design question, or Discuss -- then send it back to drafting.</div>' : '');
  main.innerHTML = filterHtml + `<table><thead><tr><th>ID</th><th>Title</th><th>Domain/Source</th><th>Detail</th>${actionHeader}</tr></thead><tbody>${rows}</tbody></table>${footer}`;
  wireQueueSourceFilter(state);
  wireHubSort(state);
  main.querySelectorAll('tr.clickable').forEach(row => {
    row.onclick = () => openDetail(row.dataset.state, row.dataset.id);
  });
  main.querySelectorAll('.hub-priority-btn').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const cur = btn.dataset.priority === '' ? null : parseInt(btn.dataset.priority, 10);
      setHubPriority(btn.dataset.id, cur);
    };
  });
  main.querySelectorAll('.task-archive-btn').forEach((btn) => {
    const msg = state === 'needs-clarification'
      ? `Reject '${btn.dataset.id}'? This holds it aside without ever drafting it -- the original brain-dump entry is unaffected.`
      : state === 'awaiting-confirm'
        ? (btn.dataset.adhoc === 'true'
          ? `Deny '${btn.dataset.id}'? This gives up on the drafted code diff entirely -- nothing will be committed.`
          : btn.dataset.research === 'true'
            ? `Deny '${btn.dataset.id}'? This gives up on the drafted research write-up entirely -- nothing will be filed into SecondBrain.`
            : btn.dataset.forensics === 'true'
              ? `Deny '${btn.dataset.id}'? This discards the forensic root-cause report -- no pipeline-fix candidate will be filed.`
              : `Deny the delete in '${btn.dataset.id}'? This gives up on the batch entirely -- nothing in it (including any non-delete items in the same batch) will be applied.`)
        : `Archive '${btn.dataset.id}'? This frees up its underlying item for reconsideration but does not apply anything.`;
    btn.onclick = (e) => { e.stopPropagation(); postTaskAction(state, btn.dataset.id, 'archive', msg); };
  });
  main.querySelectorAll('.task-done-btn').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      postTaskAction(state, btn.dataset.id, 'done', `Mark '${btn.dataset.id}' as done? Use this when the underlying work is already finished (e.g. done by hand) -- unlike Reject, this moves it to the Done tab and stops it from being regenerated.`);
    };
  });
  // 2026-08-24 (Grimmethy: "we also need one on the page where Mark Done and Reject
  // already are located") -- Discuss previously only lived inside the row's own detail
  // modal (clarify-discuss-btn, wireClarificationPicker), one extra click away from this
  // list. Same underlying flow, just reached directly from the list row: open the detail
  // modal (which builds the clarify-discuss-panel and wires everything Discuss needs) then
  // immediately start the discussion, instead of making the user click in first.
  main.querySelectorAll('.task-discuss-btn').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      await openDetail(state, btn.dataset.id);
      clarifyDiscussStart(btn.dataset.id);
    };
  });
  main.querySelectorAll('.task-staleness-keep-btn').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      postTaskAction(state, btn.dataset.id, 'staleness-keep',
        `Dismiss the staleness flag on '${btn.dataset.id}'? The task stays where it is and won't be re-flagged for a while.`);
    };
  });
  main.querySelectorAll('.task-context-trim-keep-btn').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      postTaskAction(state, btn.dataset.id, 'context-trim-keep',
        `Dismiss the stale-grounding flag on '${btn.dataset.id}'? The task stays as-is and won't be re-anchored for a while.`);
    };
  });
  main.querySelectorAll('.task-confirm-delete-btn').forEach((btn) => {
    const msg = btn.dataset.adhoc === 'true'
      ? `Confirm '${btn.dataset.id}'? Click into the row first to review the real diff this agentic pass drafted -- confirming lets the next apply pass commit and push it for real.`
      : btn.dataset.research === 'true'
        ? `Confirm '${btn.dataset.id}'? Click into the row first to review the real research write-up this agentic pass drafted -- confirming lets the next apply pass file it into SecondBrain for real.`
        : btn.dataset.forensics === 'true'
          ? `Confirm '${btn.dataset.id}'? Click into the row first to read the ranked root-cause report -- confirming files its RECOMMENDED FOLLOW-UP FIX as an AC-NNN candidate in Docs/PIPELINE_FIX_CANDIDATES.md for pipeline_forensics_fix to turn into a real diff.`
          : `Confirm the delete in '${btn.dataset.id}'? This lets the next apply pass run the batch for real, including the delete.`;
    btn.onclick = (e) => { e.stopPropagation(); postTaskAction(state, btn.dataset.id, 'confirm', msg); };
  });
  main.querySelectorAll('.task-rereview-btn').forEach((btn) => {
    btn.onclick = (e) => { e.stopPropagation(); postTaskAction(state, btn.dataset.id, 'rereview', `Re-review '${btn.dataset.id}'? Its draft is kept and goes straight back to review -- no redraft.`); };
  });
  main.querySelectorAll('.task-requeue-btn').forEach((btn) => {
    btn.onclick = (e) => { e.stopPropagation(); postTaskAction(state, btn.dataset.id, 'requeue', `Requeue '${btn.dataset.id}' for a fresh draft? This resets its retry history.`); };
  });
  main.querySelectorAll('.task-apply-btn').forEach((btn) => {
    btn.onclick = (e) => { e.stopPropagation(); postTaskAction(state, btn.dataset.id, 'apply', `Apply '${btn.dataset.id}' now? This runs the real git branch/commit/push (or vault-note write) for this one task.`); };
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// Long-word brightness rule (2026-09-08, Grimmethy: "any words 6 or more letters long are
// formatted to be 10% more bright"), scoped to PROSE text only (descriptions, report
// content, chat messages, task titles) -- never task IDs, buttons, badges, nav labels, or
// other structured/dense text, where nearly every "word" would qualify and the effect
// would be noise, not emphasis. Sentinels use two Unicode Private-Use-Area code points
// (built via String.fromCharCode so this source file stays plain ASCII) -- guaranteed
// absent from real prose and never HTML-special, so they pass through escapeHtml()
// completely untouched. Marking must happen BEFORE escaping (so word-boundary matching
// never has to reason about already-inserted <span> tags) and unmarking must be the LAST
// step of whatever HTML a caller builds (after any other markup generation).
const LONG_WORD_RE = /[A-Za-z]{6,}/g;
const MARK_OPEN = String.fromCharCode(0xE000);
const MARK_CLOSE = String.fromCharCode(0xE001);

function markLongWords(raw) {
  return String(raw == null ? '' : raw).replace(LONG_WORD_RE, (w) => MARK_OPEN + w + MARK_CLOSE);
}

function unmarkToBrightSpans(html) {
  return html.split(MARK_OPEN).join('<span class="hl-bright">').split(MARK_CLOSE).join('</span>');
}

// Drop-in replacement for escapeHtml() at prose call sites: identical output for text with
// no 6+ letter words, brightened spans otherwise.
function escapeHtmlBright(raw) {
  return unmarkToBrightSpans(escapeHtml(markLongWords(raw)));
}

function adhocStateBadgeClass(state) {
  if (state === 'blocked' || state === 'awaiting-confirm') return 'bad';
  if (state === 'needs-clarification') return 'warn';
  if (state === 'approved' || state === 'done') return 'ok';
  return 'idle'; // adhoc (unclaimed), pending, drafting:*, review
}

function adhocStateLabel(state) {
  if (state.startsWith('drafting:')) return `Drafting (${state.slice('drafting:'.length)})`;
  if (state === 'adhoc') return 'Queued (unclaimed)';
  return state.charAt(0).toUpperCase() + state.slice(1).replace(/-/g, ' ');
}

async function renderPluginsTab() {
  const main = document.getElementById('main');
  let data;
  try {
    data = await fetchJson('/api/plugins');
  } catch (e) {
    main.innerHTML = `<div class="empty">Could not load plugins: ${escapeHtml(e.message)}</div>`;
    return;
  }
  const slotted = plugins => plugins.filter((p) => p.slot);
  const unslotted = plugins => plugins.filter((p) => !p.slot);
  const allPlugins = data.plugins || [];
  const rows = unslotted(allPlugins).map((p) => {
    const enabled = p.enabled !== false;
    return `
      <div style="display:flex; align-items:flex-start; gap:12px; padding:12px 14px; background:var(--panel); border:1px solid var(--border); border-radius:8px; margin-bottom:8px;">
        <label style="display:flex; align-items:center; gap:8px; margin-top:2px; cursor:pointer;">
          <input type="checkbox" class="plugin-toggle" data-name="${escapeAttr(p.name)}" ${enabled ? 'checked' : ''}>
        </label>
        <div style="flex:1; min-width:0;">
          <div style="font-weight:600;">${escapeHtml(p.name)} ${enabled ? '' : '<span class="badge idle" style="margin-left:6px;">disabled</span>'}</div>
          ${p.description ? `<div class="meta" style="margin-top:2px;">${escapeHtml(p.description)}</div>` : ''}
          <div class="meta" style="margin-top:4px; word-break:break-all; font-family:monospace; font-size:11px; color:var(--muted);">${escapeHtml(p.registerPath || '(no path)')}</div>
        </div>
      </div>`;
  }).join('');

  // Slotted plugins (e.g. "hardware-tab") are mutually exclusive -- a radio group, not
  // independent checkboxes, since exactly one (or none) actually runs at a time and
  // switching genuinely starts/stops the underlying process (see /api/plugins/select-slot).
  const slotGroups = {};
  slotted(allPlugins).forEach((p) => { (slotGroups[p.slot] = slotGroups[p.slot] || []).push(p); });
  const slotSections = Object.entries(slotGroups).map(([slot, members]) => {
    const radioName = `slot-${slot}`;
    const noneChecked = !members.some((m) => m.active) ? 'checked' : '';
    const options = [`
      <label style="display:flex; align-items:center; gap:8px; padding:8px 10px; cursor:pointer;">
        <input type="radio" name="${escapeAttr(radioName)}" class="slot-radio" data-slot="${escapeAttr(slot)}" value="" ${noneChecked}>
        <span>None (stop monitoring)</span>
      </label>`, ...members.map((m) => {
      const badge = m.running
        ? '<span class="badge ok" style="margin-left:6px;">running</span>'
        : '<span class="badge idle" style="margin-left:6px;">stopped</span>';
      return `
      <label style="display:flex; align-items:flex-start; gap:8px; padding:8px 10px; cursor:pointer;">
        <input type="radio" name="${escapeAttr(radioName)}" class="slot-radio" data-slot="${escapeAttr(slot)}" value="${escapeAttr(m.name)}" ${m.active ? 'checked' : ''} style="margin-top:2px;">
        <span>
          <div style="font-weight:600;">${escapeHtml(m.name)}${badge}</div>
          ${m.description ? `<div class="meta" style="margin-top:2px;">${escapeHtml(m.description)}</div>` : ''}
        </span>
      </label>`;
    })];
    return `
      <div style="padding:12px 14px; background:var(--panel); border:1px solid var(--border); border-radius:8px; margin-bottom:8px;">
        <div class="field-label" style="margin-bottom:6px;">${escapeHtml(slot)} source</div>
        <div style="display:flex; flex-direction:column; gap:2px;" id="slot-group-${escapeAttr(slot)}">${options.join('')}</div>
        <div class="meta slot-status" style="margin-top:6px;"></div>
      </div>`;
  }).join('');

  main.innerHTML = `
    <h2 style="margin-top:0;">Plugins</h2>
    ${slotSections}
    <div class="meta" style="margin-bottom:14px;">
      Only enabled plugins register their task sources. A change here restarts the pipeline if it is running so an
      in-flight draft for a now-disabled source can't stall. Manifest: <span style="font-family:monospace;">${escapeHtml(data.manifestPath || 'plugins.json')}</span>
    </div>
    <div id="plugins-list">${rows || '<div class="empty">No plugins registered yet -- add one below.</div>'}</div>

    <h3 style="margin-top:22px;">Add a plugin</h3>
    <div style="display:flex; flex-direction:column; gap:8px; max-width:640px;">
      <input type="text" id="plugin-add-path" placeholder="Absolute path to the plugin's register.js (e.g. /media/model-cache/github/agent-manager-imagegen/register.js)" style="padding:8px; background:var(--bg); border:1px solid var(--border); border-radius:6px; color:var(--text);">
      <input type="text" id="plugin-add-name" placeholder="Name (optional -- defaults to the plugin folder name)" style="padding:8px; background:var(--bg); border:1px solid var(--border); border-radius:6px; color:var(--text);">
      <input type="text" id="plugin-add-desc" placeholder="Description (optional)" style="padding:8px; background:var(--bg); border:1px solid var(--border); border-radius:6px; color:var(--text);">
      <button class="action" id="plugin-add-btn" style="align-self:flex-start;">Add plugin</button>
      <div id="plugin-add-msg" class="meta"></div>
    </div>

    <h3 style="margin-top:22px;">Available plugins</h3>
    <div id="marketplace-note" class="meta" style="margin-bottom:10px;"></div>
    <div id="marketplace-list"><div class="meta">Loading...</div></div>`;

  main.querySelectorAll('.slot-radio').forEach((radio) => {
    radio.onchange = async () => {
      const slot = radio.dataset.slot;
      const name = radio.value || null;
      const group = main.querySelector(`#slot-group-${slot}`);
      const statusEl = group ? group.closest('div').parentElement.querySelector('.slot-status') : null;
      group.querySelectorAll('input').forEach((r) => { r.disabled = true; });
      if (statusEl) statusEl.textContent = name ? `Starting ${name}...` : 'Stopping...';
      try {
        const r = await fetch('/api/plugins/select-slot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slot, name }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.description || r.status);
        if (name && !body.healthy) {
          if (statusEl) statusEl.textContent = `${name} started but did not report healthy in time -- check its log.`;
        }
        await renderPluginsTab();
      } catch (e) {
        alert('Could not switch plugin: ' + e.message);
        await renderPluginsTab();
      }
    };
  });

  main.querySelectorAll('.plugin-toggle').forEach((cb) => {
    cb.onchange = async () => {
      cb.disabled = true;
      try {
        const r = await fetch('/api/plugins/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: cb.dataset.name, enabled: cb.checked }),
        });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).description || r.status);
        await syncPluginTabs();
        renderNav();
        await renderPluginsTab();
      } catch (e) {
        alert('Could not update plugin: ' + e.message);
        cb.checked = !cb.checked;
        cb.disabled = false;
      }
    };
  });

  const addBtn = main.querySelector('#plugin-add-btn');
  addBtn.onclick = async () => {
    const msg = main.querySelector('#plugin-add-msg');
    const registerPath = main.querySelector('#plugin-add-path').value.trim();
    const name = main.querySelector('#plugin-add-name').value.trim();
    const description = main.querySelector('#plugin-add-desc').value.trim();
    if (!registerPath) { msg.textContent = 'A register.js path is required.'; return; }
    addBtn.disabled = true;
    msg.textContent = 'Adding...';
    try {
      const r = await fetch('/api/plugins/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ registerPath, name, description }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.description || r.status);
      await syncPluginTabs();
      renderNav();
      await renderPluginsTab();
    } catch (e) {
      msg.textContent = 'Could not add plugin: ' + e.message;
      addBtn.disabled = false;
    }
  };

  // Marketplace: fetch catalog entries annotated with install status and render
  // Install / Update / Installed controls per entry. 402/403 surface via showToast.
  (async () => {
    const listEl = main.querySelector('#marketplace-list');
    const noteEl = main.querySelector('#marketplace-note');
    let mkt;
    try {
      mkt = await fetchJson('/api/plugins/marketplace');
    } catch (e) {
      listEl.innerHTML = '<div class="meta">Could not load marketplace: ' + escapeHtml(e.message) + '</div>';
      return;
    }
    if (mkt.catalogError) {
      noteEl.textContent = mkt.catalogError;
    }
    const entries = mkt.plugins || mkt.entries || [];
    if (!entries.length) {
      listEl.innerHTML = '<div class="meta">No plugins available in the catalog.</div>';
      return;
    }
    listEl.innerHTML = entries.map((p) => {
      const installed = p.installed === true;
      const updateAvail = p.updateAvailable === true;
      let priceText = '';
      if (p.pricing && p.pricing.model && p.pricing.model !== 'free') {
        const cur = p.pricing.currency || '';
        const amt = p.pricing.amount_cents != null ? (p.pricing.amount_cents / 100) : 0;
        const interval = p.pricing.interval || '';
        priceText = escapeHtml(cur + ' ' + amt + (interval ? ' / ' + interval : ''));
      }
      let controlHtml = '';
      if (installed && updateAvail) {
        controlHtml = '<button class="action" data-mkt-action="update" data-id="' + escapeAttr(p.id) + '">Update</button>';
      } else if (installed) {
        controlHtml = '<span class="badge ok" style="margin-top:2px;">Installed</span>';
      } else {
        const isPaid = p.pricing && p.pricing.model && p.pricing.model !== 'free';
        const paidStyle = isPaid ? ' style="opacity:0.7; border-style:dashed;" title="Paid plugin -- requires a license"' : '';
        controlHtml = '<button class="action" data-mkt-action="install" data-id="' + escapeAttr(p.id) + '"' + paidStyle + '>Install</button>';
      }
      const versionLine = p.installedVersion
        ? '<div class="meta" style="margin-top:2px; font-size:11px;">Installed: ' + escapeHtml(p.installedVersion) + (updateAvail ? ' <span class="badge idle" style="margin-left:4px;">update available</span>' : '') + '</div>'
        : '';
      return '<div style="display:flex; align-items:flex-start; gap:12px; padding:12px 14px; background:var(--panel); border:1px solid var(--border); border-radius:8px; margin-bottom:8px;">'
        + '<div style="flex:1; min-width:0;">'
        + '<div style="font-weight:600;">' + escapeHtml(p.name) + (priceText ? ' <span class="meta" style="margin-left:8px;">' + priceText + '</span>' : '') + '</div>'
        + '<div class="meta" style="margin-top:2px;">' + escapeHtml(p.summary || '') + '</div>'
        + versionLine
        + '</div>'
        + '<div style="white-space:nowrap;">' + controlHtml + '</div>'
        + '</div>';
    }).join('');

    listEl.querySelectorAll('[data-mkt-action]').forEach((btn) => {
      btn.onclick = async () => {
        const action = btn.dataset.mktAction;
        const id = btn.dataset.id;
        btn.disabled = true;
        btn.textContent = action === 'update' ? 'Updating...' : 'Installing...';
        try {
          const r = await fetch('/api/plugins/' + action, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
          });
          const body = await r.json().catch(() => ({}));
          if (!r.ok) {
            const errMsg = body.description || body.error || 'Error ' + r.status;
            showToast(errMsg, 'error');
            btn.textContent = action === 'update' ? 'Update' : 'Install';
            btn.disabled = false;
            return;
          }
          showToast(action === 'update' ? 'Plugin updated successfully' : 'Plugin installed successfully', 'success');
          await renderPluginsTab();
        } catch (e) {
          showToast('Could not ' + (action === 'update' ? 'update' : 'install') + ' plugin: ' + e.message, 'error');
          btn.textContent = action === 'update' ? 'Update' : 'Install';
          btn.disabled = false;
        }
      };
    });
  })();
}

function pipelineFlagBadges(s) {
  const badges = [];
  if (s.directToMain) badges.push('<span class="badge ok" title="Commits straight to main, no review branch">direct-to-main</span>');
  if (s.candidateFulfillment) badges.push('<span class="badge idle" title="Consumes a vetted candidate write-up; grounded in real fetched file content">candidate-fulfillment</span>');
  if (s.hasCandidatesPath) badges.push('<span class="badge idle" title="Can output {&quot;mode&quot;:&quot;split&quot;} when a candidate is too large for one atomic edit, writing sub-candidates back into its own candidates doc">split-capable</span>');
  if (s.emptyApproval) badges.push('<span class="badge idle" title="An empty implement response is a legitimate, deterministically auto-approved outcome for this source">empty-ok</span>');
  if (s.advisoryProse) badges.push('<span class="badge idle" title="Deliverable is a prose verdict, not a diff -- critique is skipped">advisory-prose</span>');
  if (s.hasCustomApply && !s.directToMain) badges.push('<span class="badge idle" title="Has its own registered apply() instead of the generic Group B diff path">custom-apply</span>');
  return badges.join(' ') || '<span class="meta">—</span>';
}
