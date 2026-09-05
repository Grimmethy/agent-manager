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

async function fetchJson(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  let r;
  try {
    r = await fetch(url, { signal: controller.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(url + ' -> timed out after 8s');
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
    btn.onclick = () => {
      if (activeTab === 'project' && tab.key !== 'project') leaveProjectTab();
      if (activeTab === 'brain-dump' && tab.key !== 'brain-dump') leaveBrainDumpTab();
      activeTab = tab.key;
      renderNav();
      renderMain();
    };
    return btn;
  }
  const count = (tab.key === 'workers' || tab.key === 'models' || tab.key === 'joblist' || tab.key === 'plugins' || tab.key === 'deepdive') ? '' : (counts[tab.key] ?? '');
  const severity = severityForTab(tab.key, count);
  const dot = severity ? `<span class="status-dot ${severity}"></span>` : '';
  btn.innerHTML = `<span>${tab.label}</span><span class="count">${dot}${count}</span>`;
  btn.onclick = () => {
    if (activeTab === 'project' && tab.key !== 'project') leaveProjectTab();
    if (activeTab === 'brain-dump' && tab.key !== 'brain-dump') leaveBrainDumpTab();
    activeTab = tab.key;
    renderNav();
    if (tab.key === 'project') enterProjectTab();
    else if (tab.key === 'brain-dump') enterBrainDumpTab();
    else renderMain();
  };
  return btn;
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

function laneForInstance(inst) {
  return inst.instanceId.startsWith('worker-reasoning') ? 'reasoning' : 'local';
}

function modelKindForInstance(inst) {
  if (inst.instanceId === 'watchdog') return null;
  return laneForInstance(inst) === 'reasoning' ? 'mixed' : 'ollama';
}

async function setWorkerModel(instanceId, model) {
  await fetch(`/api/worker-models/${encodeURIComponent(instanceId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  });
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

async function renderWorkers() {
  const [instances, workerModels, costSummary, recentTasks] = await Promise.all([
    fetchJson('/api/instances'),
    fetchJson('/api/worker-models'),
    fetchJson('/api/models/cost-summary'),
    // Only fetch for whichever card is currently expanded -- no point loading this for
    // every instance on every 5s poll when at most one card shows it at a time.
    expandedWorkerId ? fetchJson(`/api/instances/${encodeURIComponent(expandedWorkerId)}/recent-tasks`) : Promise.resolve(null),
  ]);
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
  const filterBar = `
    <div class="worker-filter-bar" style="margin-bottom:10px; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px">
      <div>
        ${[['all', 'All'], ['local', 'Local (grunt)'], ['reasoning', 'Claude (reasoning)']].map(([key, label]) => `
          <button class="${workersTypeFilter === key ? 'active' : ''}" data-worker-filter="${key}">${label}</button>
        `).join('')}
      </div>
      <label style="display:flex; align-items:center; gap:6px; font-size:0.9em; cursor:pointer" title="Stops every automated Claude call pipeline-wide (worker-reasoning's plan pass, adhoc/research's implement calls, review votes) until unchecked -- preserves your subscription's token budget.">
        <input type="checkbox" id="claude-pause-toggle" ${workerModels.claudePaused ? 'checked' : ''}>
        Pause Claude (preserve subscription tokens)
      </label>
    </div>
  `;
  const shown = instances.filter(inst => workersTypeFilter === 'all' || laneForInstance(inst) === workersTypeFilter);
  if (instances.length === 0) { main.innerHTML = '<div class="empty">No instances found -- is the pipeline running?</div>'; return; }
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
        <div class="badge-col">
          <span class="badge ${statusBadgeClass(inst.status, inst.stale)}">${inst.stale ? 'STALE' : inst.status}</span>
          ${inst.stale ? `<span class="stale-timer" id="stale-timer-${inst.instanceId}"></span>` : ''}
          <span class="state-timer" id="state-timer-${inst.instanceId}">${inst.stateAgeSeconds != null ? 'in this state ' + fmtDuration(inst.stateAgeSeconds) : ''}</span>
        </div>
      </div>
      <div class="meta">
        pid ${inst.pid ?? '-'} · model ${inst.model || '-'} · heartbeat ${fmtAge(inst.heartbeatAgeSeconds)} ago
        ${inst.currentTaskId ? ' · working on <strong><a href="#" data-open-task-anywhere="' + escapeAttr(inst.currentTaskId) + '">' + escapeHtml(inst.currentTaskId) + '</a></strong>' + (inst.currentPass ? ' (' + escapeHtml(inst.currentPass) + ')' : '') : ''}
        ${costByInstance[inst.instanceId] ? ' · ' + fmtUsd(costByInstance[inst.instanceId]) + ' est. API cost' : ''}
      </div>
      ${expandedWorkerId === inst.instanceId ? `
      <div class="worker-recent-tasks">
        <div class="meta" style="margin-top:8px; font-weight:600">${inst.instanceId === 'reviewer' ? 'Last 10 reviewed tasks' : 'Last 10 completed tasks'}</div>
        ${recentTasks ? renderRecentTasksList(recentTasks.tasks || []) : '<div class="meta">Loading…</div>'}
      </div>` : ''}
    </div>
  `).join(''));
  main.querySelectorAll('.worker-card[data-instance-id]').forEach((card) => {
    card.onclick = () => toggleWorkerExpand(card.dataset.instanceId);
  });
  main.querySelectorAll('[data-worker-filter]').forEach((btn) => {
    btn.onclick = () => { workersTypeFilter = btn.dataset.workerFilter; renderWorkers(); };
  });
  const claudePauseToggle = main.querySelector('#claude-pause-toggle');
  if (claudePauseToggle) {
    claudePauseToggle.onchange = (e) => setClaudePaused(e.target.checked);
  }
  main.querySelectorAll('.worker-model-select').forEach((sel) => {
    sel.onclick = (e) => e.stopPropagation();
    sel.onchange = (e) => { e.stopPropagation(); setWorkerModel(sel.dataset.instanceId, sel.value); };
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

function chatSetCollapsed(collapsed) {
  const panel = document.getElementById('chat-panel');
  if (panel) panel.classList.toggle('chat-collapsed', collapsed);
  localStorage.setItem('agentManagerChatPanel', collapsed ? 'collapsed' : 'expanded');
}

async function sendTextToChat(text) {
  const r = await fetch('/api/chat/inject', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.detail || body.description || `HTTP ${r.status}`);
  }
  await r.json().catch(() => null);
  chatSetCollapsed(false);
  chatRender();
}

async function chatPanelInit() {
  chatSetCollapsed(localStorage.getItem('agentManagerChatPanel') === 'collapsed');
  const tab = document.getElementById('chat-toggle-tab');
  if (tab) {
    tab.onclick = () => {
      const panel = document.getElementById('chat-panel');
      chatSetCollapsed(!panel.classList.contains('chat-collapsed'));
    };
  }
  const newBtn = document.getElementById('chat-new-btn');
  if (newBtn) newBtn.onclick = chatStartNew;
  const sendBtn = document.getElementById('chat-send-btn');
  if (sendBtn) sendBtn.onclick = chatSend;
  const input = document.getElementById('chat-input');
  if (input) {
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chatSend(); }
    };
  }
  try {
    chatSession = await fetchJson('/api/chat/active');
  } catch (e) {
    chatSession = null;
  }
  chatRender();
}

async function chatStartNew() {
  const newBtn = document.getElementById('chat-new-btn');
  if (newBtn) { newBtn.disabled = true; newBtn.textContent = 'Starting...'; }
  try {
    const resp = await fetch('/api/chat/new', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(providerPayload('chat-provider')),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(body.description || `HTTP ${resp.status}`);
    chatSession = body;
  } catch (e) {
    showToast('Could not start a new conversation: ' + e.message);
  } finally {
    if (newBtn) { newBtn.disabled = false; newBtn.textContent = 'New'; }
  }
  chatRender();
}

async function chatSend() {
  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send-btn');
  const message = input && input.value.trim();
  if (!message || !chatSession) return;
  input.value = '';
  sendBtn.disabled = true;
  sendBtn.textContent = 'Thinking...';
  // Optimistic append so the user's own message shows immediately -- a real reply
  // (local provider especially, under real worker-lane contention) can take a while.
  chatSession.transcript.push({ role: 'user', text: message });
  // 2026-08-26 (Open WebUI investigation: "vastly improve the chat system... streaming")
  // -- a live in-progress assistant entry that fills in as SSE chunks arrive, instead of
  // one blocking fetch()+json() that left the user staring at nothing until the whole
  // reply (or the turn budget) was done.
  const assistantEntry = { role: 'assistant', text: '' };
  chatSession.transcript.push(assistantEntry);
  chatRender();
  try {
    const resp = await fetch(`/api/chat/${encodeURIComponent(chatSession.id)}/message`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    if (!resp.ok || !resp.body) {
      const body = await resp.json().catch(() => ({}));
      throw new Error(body.description || `HTTP ${resp.status}`);
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let finalSession = null;
    let streamErr = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split('\n\n');
      buf = frames.pop(); // keep the last, possibly-incomplete frame for next read
      for (const frame of frames) {
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        const evt = JSON.parse(line.slice(6));
        if (evt.type === 'preempt') {
          // "make GPU space" summary (brain dump #5) -- a muted line prepended to this
          // turn's reply so the user can see what the pipeline gave up for it.
          const lanes = evt.lanes || [];
          const killed = lanes.filter((l) => l.action === 'killed').map((l) => l.lane);
          const spared = lanes.filter((l) => l.action === 'spared')
            .map((l) => `${l.lane} (${Math.round((l.ageSeconds || 0) / 60)}m in)`);
          const bits = [];
          if (killed.length) bits.push('freed ' + killed.join(', '));
          if (spared.length) bits.push('spared ' + spared.join(', '));
          if (bits.length) { assistantEntry.text = `_⚡ ${bits.join(' · ')}_\n\n`; chatRender(); }
        } else if (evt.type === 'chunk') {
          assistantEntry.text += evt.text;
          chatRender();
        } else if (evt.type === 'final') {
          finalSession = evt.session;
        } else if (evt.type === 'error') {
          streamErr = evt.error;
        }
      }
    }
    if (streamErr) throw new Error(streamErr);
    if (finalSession) chatSession = finalSession;
  } catch (e) {
    showToast('Chat message failed: ' + e.message);
    // Roll back the optimistic append -- the real transcript (without this failed turn)
    // is whatever's still on disk; simplest correct fix is just re-fetching it.
    try { chatSession = await fetchJson('/api/chat/active'); } catch (e2) { /* leave as-is */ }
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send';
  }
  chatRender();
}

async function chatToggleReserve() {
  if (!chatSession) return;
  const btn = document.getElementById('chat-reserve-btn');
  const wantOn = !chatSession.reserved;
  btn.disabled = true;
  // Plain fetch, no client-side timeout -- turning reservation ON can genuinely block
  // server-side for a while (single_flight_lock.acquire() waiting for a busy worker
  // lane's current call to finish), same as any other real acquire-the-lock wait
  // discussed at length tonight; an artificial abort here would misreport a legitimately
  // slow-but-successful reservation as a failure.
  btn.textContent = wantOn ? 'Reserving...' : 'Releasing...';
  try {
    const resp = await fetch(`/api/chat/${encodeURIComponent(chatSession.id)}/reserve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on: wantOn }),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(body.description || `HTTP ${resp.status}`);
    chatSession = body;
  } catch (e) {
    showToast('Could not toggle reservation: ' + e.message);
  } finally {
    btn.disabled = false;
  }
  chatRender();
}

function chatWireProviderToggle() {
  const btn = document.getElementById('chat-provider');
  if (!btn) return;
  btn.onclick = async (e) => {
    e.stopPropagation();
    const next = btn.dataset.provider === 'local' ? 'claude' : 'local';
    btn.dataset.provider = next;
    providerChoices['chat-provider'] = next;
    btn.textContent = next === 'claude' ? 'Claude' : 'Local';
    btn.classList.toggle('provider-toggle-claude', next === 'claude');
    await chatStartNew();
  };
}

function chatRender() {
  const titleEl = document.getElementById('chat-title');
  if (titleEl && chatSession && Array.isArray(chatSession.roots) && chatSession.roots.length) {
    titleEl.title = 'Accessible repos (roots[0] is primary):\n' + chatSession.roots.join('\n');
  }
  const container = document.getElementById('chat-provider-container');
  if (container && !document.getElementById('chat-provider')) {
    container.innerHTML = renderProviderToggle('chat-provider');
    chatWireProviderToggle();
  }
  if (chatSession && document.getElementById('chat-provider')) {
    // Provider is fixed once a session exists (same "no mid-conversation switch"
    // reasoning as Discuss) -- the header toggle reflects/controls only what the NEXT
    // "New" conversation will use, so pin it to match the ACTIVE session's own provider
    // rather than letting it silently drift out of sync with what's actually running.
    const btn = document.getElementById('chat-provider');
    if (btn.dataset.provider !== chatSession.provider) {
      btn.dataset.provider = chatSession.provider;
      providerChoices['chat-provider'] = chatSession.provider;
      btn.textContent = chatSession.provider === 'claude' ? 'Claude' : 'Local';
      btn.classList.toggle('provider-toggle-claude', chatSession.provider === 'claude');
    }
  }

  const reserveBtn = document.getElementById('chat-reserve-btn');
  if (reserveBtn) {
    const showReserve = !!chatSession && chatSession.provider === 'local';
    reserveBtn.style.display = showReserve ? '' : 'none';
    if (showReserve) {
      reserveBtn.onclick = chatToggleReserve;
      reserveBtn.classList.toggle('active', !!chatSession.reserved);
      reserveBtn.textContent = chatSession.reserved ? 'Reserved' : 'Reserve';
      reserveBtn.title = chatSession.reserved
        ? 'Holding the local model exclusively -- click to release it back to the worker lanes'
        : 'Hold the local model exclusively for this conversation until you turn it back off';
    }
  }

  const transcriptEl = document.getElementById('chat-transcript');
  if (transcriptEl) {
    transcriptEl.innerHTML = chatSession && chatSession.transcript.length
      ? grillRenderTranscript(chatSession.transcript, chatSession)
      : '<div class="empty">Say something to the chat.</div>';
    // 2026-08-26: the ACTUAL scrollable box is the .grill-transcript div
    // grillRenderTranscript() just created one level inside #chat-transcript, not
    // #chat-transcript itself -- see the CSS comment above #chat-transcript's own rule
    // for the full incident. Setting scrollTop on the wrong (outer) element was a
    // silent no-op every single render, which is why every new message left the inner
    // box sitting at its default post-render scrollTop of 0 (top) instead of the bottom.
    const scrollBox = transcriptEl.querySelector('.grill-transcript');
    if (scrollBox) scrollBox.scrollTop = scrollBox.scrollHeight;
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

async function renderQueueTab(state) {
  if (!queueLoadedCount[state]) queueLoadedCount[state] = QUEUE_PAGE_SIZE;
  queueLoadInFlight = true;
  const sourceFilter = queueSourceFilter[state] || '';
  const filterQS = sourceFilter ? `&source=${encodeURIComponent(sourceFilter)}` : '';
  let tasks, total;
  try {
    const resp = await fetchJson(`/api/queue/${state}?limit=${queueLoadedCount[state]}&offset=0${filterQS}`);
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
  const filterHtml = `<div class="row" style="margin-bottom:10px"><label class="meta">Task type: <select id="queue-source-filter">${filterOptionsHtml}</select></label></div>`;

  if (tasks.length === 0) {
    main.innerHTML = filterHtml + `<div class="empty">${sourceFilter ? `No "${escapeHtml(sourceFilter)}" tasks here.` : 'Nothing here.'}</div>`;
    wireQueueSourceFilter(state);
    return;
  }
  const showArchiveRequeue = state === 'blocked' || state === 'done';
  // Archive alone (no generic Requeue -- that moves to pending/, wrong for an
  // adhoc-domain task; resolving happens via the detail modal's own picker instead, see
  // renderTaskDetailModal).
  const showArchiveOnly = state === 'needs-clarification';
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
              ? `<span style="color:var(--bad)" title="${escapeAttr(t.blockedReason || '')}">⛔ stuck ${t.progress ? `at ${t.progress.done}/${t.progress.total}` : ''}${t.coordinatorBlocked.escalated ? ' — needs a human' : ''}: ${escapeHtml((t.blockedReason || '').slice(0, 90))}</span>`
              : `<span style="color:var(--warn)">☑ ${t.progress ? `${t.progress.done} / ${t.progress.total}` : '?'} sub-tasks done</span>`)
            : (t.blockedReason ? '<span style="color:var(--bad)">' + escapeHtml(t.blockedReason).slice(0, 80) + '</span>' : (t.branch || t.doneMarker || ''));
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
    return `
    <tr class="${rowClass}" data-id="${t.id}" data-state="${state}">
      <td>${t.id}</td>
      <td>${t.title || ''}${isPrompt ? ' <span class="badge warn" title="This source is set to \'prompt\' -- it still needs your explicit Apply click, same as approve, but is actively badged so it does not sit unnoticed">needs review</span>' : ''}</td>
      <td>${t.domain || ''}/${t.source || ''}</td>
      <td>${staleChip}${trimChip}${detailCell}</td>
      ${showArchiveRequeue ? `<td>
        <button type="button" class="secondary task-archive-btn" data-id="${escapeAttr(t.id)}">Archive</button>
        <button type="button" class="secondary task-requeue-btn" data-id="${escapeAttr(t.id)}">Requeue</button>
        ${keepBtn}
        ${trimKeepBtn}
      </td>` : ''}
      ${showArchiveOnly ? `<td>
        <button type="button" class="secondary task-done-btn" data-id="${escapeAttr(t.id)}">Mark Done</button>
        <button type="button" class="secondary task-archive-btn" data-id="${escapeAttr(t.id)}">Reject</button>
        <button type="button" class="secondary task-discuss-btn" data-id="${escapeAttr(t.id)}">Discuss</button>
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
  main.querySelectorAll('tr.clickable').forEach(row => {
    row.onclick = () => openDetail(row.dataset.state, row.dataset.id);
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
