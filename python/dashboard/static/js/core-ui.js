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

// AC-56, 2026-09-25: this file is loaded as a plain global <script> in the browser
// (`module` is undefined there, so this is a no-op in production) -- the guard exists
// solely so safeSourceNames is requireable from a Node test, the first test coverage
// this file has ever had.
if (typeof module !== 'undefined') module.exports = { safeSourceNames, bumpRenderGeneration, renderStaleCheck, runRefreshGuarded, _resetRenderStateForTest };
