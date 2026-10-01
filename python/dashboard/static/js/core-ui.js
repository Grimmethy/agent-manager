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

// Stale-render guard (2026-09-29, "display stutters and switches to the wrong tab"): every
// tab renderer awaits a fetch and THEN writes #main, and nothing tied that late write to
// the tab active when it lands -- with server calls taking 8-28s under disk contention, a
// poll-triggered render for tab A routinely finished after the user had clicked tab B and
// painted A over it. renderGeneration is bumped whenever a newer render supersedes older
// ones (renderMain entry, switchToTab); a renderer takes renderStaleCheck() at entry and
// returns instead of writing if the generation has moved on. Capture-only (no bump) on
// purpose: renderMain already bumped for THIS render, and a renderer bumping again would
// invalidate its own caller.
let renderGeneration = 0;
function bumpRenderGeneration() { renderGeneration += 1; }
function renderStaleCheck() {
  const gen = renderGeneration;
  return () => gen !== renderGeneration;
}

// In-flight guard for the 5s refresh() poll: setInterval fires regardless of whether the
// last cycle finished, so a slow server stacked N concurrent cycles, each rebuilding #main.
// A cycle older than maxMs no longer blocks, so one hung request can't wedge polling forever
// (fetchJson's own 8s timeout bounds each request; a cycle is a few of them).
let refreshRunningSince = 0;
async function runRefreshGuarded(fn, { now = Date.now, maxMs = 30000 } = {}) {
  if (refreshRunningSince && now() - refreshRunningSince < maxMs) return;
  refreshRunningSince = now();
  try {
    await fn();
  } finally {
    refreshRunningSince = 0;
  }
}
function _resetRenderStateForTest() { renderGeneration = 0; refreshRunningSince = 0; }

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
  bumpRenderGeneration(); // any in-flight render for the tab being left is now stale
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

// AC-56, 2026-09-25: /api/job-types failing must not blank out an otherwise-successful
// task list -- renderQueueTab's own fetch already succeeded and has real data worth
// rendering regardless. Extracted from renderQueueTab as its own named, dependency-
// injectable function (sourceNamesFn defaults to the real allSourceNames) specifically so
// this fallback behavior is unit-testable without a DOM -- this file has no other test
// coverage today, and a full jsdom harness for the rest of it is out of scope for this fix.
async function safeSourceNames(sourceNamesFn = allSourceNames) {
  try {
    return await sourceNamesFn();
  } catch {
    return [];
  }
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
  const isStale = renderStaleCheck();
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

  const sourceNames = await safeSourceNames();
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

  if (isStale()) return;
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
  if (isStale()) return;
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

// AC-56, 2026-09-25: this file is loaded as a plain global <script> in the browser
// (`module` is undefined there, so this is a no-op in production) -- the guard exists
// solely so safeSourceNames is requireable from a Node test, the first test coverage
// this file has ever had.
if (typeof module !== 'undefined') module.exports = { safeSourceNames, bumpRenderGeneration, renderStaleCheck, runRefreshGuarded, _resetRenderStateForTest };
