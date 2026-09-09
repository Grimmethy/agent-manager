async function enterProjectTab() {
  // Sync the path input from the server's actual active project on every tab entry, before
  // rendering it. Without this, the input only ever reflected localStorage -- if the active
  // project changed via any OTHER route (hand-editing agent-manager.env, another browser tab,
  // launch.bat) the input would silently keep showing a stale path while "Last configured
  // project" below it correctly showed the truth. Since Start Pipeline acts on the input's
  // value, not on activeRepoRoot, that mismatch could launch a pipeline against the wrong
  // project with no warning. Only overrides on tab entry, not on the 3s poll thereafter, so a
  // deliberate browse-a-different-project session isn't fought by this sync mid-use.
  //
  // Compares against lastSyncedActiveRepoRoot (the last server value we actually observed),
  // NOT against projectPath -- comparing against projectPath meant a typed-but-not-yet-started
  // path (Start Pipeline never ran, so activeRepoRoot on the server never changed) got silently
  // overwritten back to the server's stale/placeholder activeRepoRoot on every single tab
  // revisit, since the two never stopped disagreeing. Bug: "Project File Path ... resets to a
  // non-existent default path each time I navigate to it" (2026-08-18). Only a genuine change
  // in what the server reports since we last looked now counts as "external".
  try {
    const status = await fetchJson('/api/pipeline/status');
    if (status.activeRepoRoot && status.activeRepoRoot !== lastSyncedActiveRepoRoot) {
      lastSyncedActiveRepoRoot = status.activeRepoRoot;
      if (status.activeRepoRoot !== projectPath) setProjectPath(status.activeRepoRoot);
    }
    // Same reasoning as the path sync above: reflect whatever's actually configured
    // server-side (env file / another tab / launch.bat) rather than only ever showing
    // this browser's last local choice.
    if (typeof status.includeApply === 'boolean') {
      includeApply = status.includeApply;
      localStorage.setItem('agentManagerIncludeApply', String(includeApply));
    }
    if (typeof status.skipPush === 'boolean') {
      skipPush = status.skipPush;
      localStorage.setItem('agentManagerSkipPush', String(skipPush));
    }
  } catch (e) { /* dashboard's own status check failed -- fall back to whatever's cached */ }

  const main = document.getElementById('main');
  main.innerHTML = `
    <div style="display:flex;flex-direction:column;height:calc(100vh - 93px);">
      <div class="path-row">
        <select id="project-select" style="flex:1;"><option value="">Loading projects...</option></select>
        <input id="project-path-input" type="text" placeholder="C:\\path\\to\\your\\project" value="${escapeAttr(projectPath)}" list="project-history-list" autocomplete="off" style="display:none;">
        <datalist id="project-history-list"></datalist>
        <button class="secondary" id="history-toggle">History...</button>
        <button class="secondary" id="browse-toggle">Browse...</button>
        <button class="secondary" id="sync-btn" title="Fetch origin and fast-forward this checkout onto it">Sync with GitHub</button>
        <button class="action" id="build-btn">Build Graph</button>
      </div>
      <div id="history-panel" class="browser-panel" style="display:none"></div>
      <div class="path-row">
        <input id="project-grepdirs-input" type="text" placeholder="src, frontend/src, backend/src (optional -- comma-separated, leave blank to scan the whole path)" value="${escapeAttr(grepDirs)}">
      </div>
      <div class="path-row" id="pipeline-toggles-row" style="gap:16px;align-items:center;">
        <label style="display:flex;align-items:center;gap:4px;font-size:0.9em;cursor:pointer;">
          <input type="checkbox" id="include-apply-toggle" ${includeApply ? 'checked' : ''}>
          Enable Apply Runner (writes/commits changes)
        </label>
        <label style="display:flex;align-items:center;gap:4px;font-size:0.9em;cursor:pointer;${includeApply ? '' : 'opacity:.5;'}" title="Applied work is always pushed now (2026-08-17) -- an unpushed branch was silently losing real work over time. This only controls whether the local checkout returns to main after each apply, or stays on the applied branch for inspection.">
          <input type="checkbox" id="skip-push-toggle" ${!includeApply ? 'disabled' : ''} ${!skipPush ? 'checked' : ''}>
          Return to main after each apply (unchecked: stay on the applied branch)
        </label>
        <span class="meta" style="font-size:0.85em;">Which job types run is now controlled from the Job List tab. Applied work is always pushed to the remote for durability, regardless of this toggle.</span>
      </div>
      <div id="browser-panel" class="browser-panel" style="display:none"></div>
      <div id="pipeline-panel" class="worker-card"></div>
      <div id="project-status-area" style="flex:1;min-height:0;display:flex;flex-direction:column;"></div>
    </div>
  `;
  lastRenderedStatusKey = null;  // fresh tab entry -- force the first poll to actually render
  document.getElementById('project-path-input').addEventListener('change', (e) => {
    setProjectPath(e.target.value.trim());
    lastRenderedStatusKey = null;  // switched projects -- old key would wrongly suppress the new render
    refreshProjectStatus();
  });
  document.getElementById('include-apply-toggle').addEventListener('change', (e) => {
    includeApply = e.target.checked;
    localStorage.setItem('agentManagerIncludeApply', String(includeApply));
    const pushToggle = document.getElementById('skip-push-toggle');
    pushToggle.disabled = !includeApply;
    pushToggle.closest('label').style.opacity = includeApply ? '' : '.5';
    if (!includeApply) { pushToggle.checked = false; skipPush = true; localStorage.setItem('agentManagerSkipPush', 'true'); }
  });
  document.getElementById('skip-push-toggle').addEventListener('change', (e) => {
    skipPush = !e.target.checked;
    localStorage.setItem('agentManagerSkipPush', String(skipPush));
  });
  document.getElementById('project-select').addEventListener('change', (e) => {
    if (!e.target.value) return;
    setProjectPath(e.target.value);
    document.getElementById('project-path-input').value = projectPath;
    lastRenderedStatusKey = null;  // switched projects -- old key would wrongly suppress the new render
    refreshProjectStatus();
  });
  document.getElementById('browse-toggle').onclick = () => {
    browserOpen = !browserOpen;
    document.getElementById('browser-panel').style.display = browserOpen ? 'block' : 'none';
    // Manual path entry only makes sense while actively browsing -- otherwise the
    // dropdown (populated from Second Brain's referenced projects) is the only way
    // to pick a project, per the actual ask.
    document.getElementById('project-select').style.display = browserOpen ? 'none' : '';
    document.getElementById('project-path-input').style.display = browserOpen ? '' : 'none';
    if (browserOpen) { browsePath = projectPath || ''; loadBrowsePanel(); }
  };
  document.getElementById('history-toggle').onclick = () => {
    historyOpen = !historyOpen;
    document.getElementById('history-panel').style.display = historyOpen ? 'block' : 'none';
    if (historyOpen) renderHistoryPanel();
  };
  document.getElementById('project-grepdirs-input').addEventListener('change', (e) => {
    grepDirs = e.target.value.trim();
    localStorage.setItem('agentManagerGrepDirs', grepDirs);
  });
  document.getElementById('build-btn').onclick = triggerBuild;
  document.getElementById('sync-btn').onclick = triggerSync;

  await loadProjectHistory();
  await loadProjectDropdown();
  await refreshPipelineStatus();
  await refreshProjectStatus();
  projectStatusInterval = setInterval(() => { refreshPipelineStatus(); refreshProjectStatus(); }, 3000);
}

function leaveProjectTab() {
  if (projectStatusInterval) { clearInterval(projectStatusInterval); projectStatusInterval = null; }
}

async function refreshPipelineStatus() {
  const panel = document.getElementById('pipeline-panel');
  if (!panel) return;
  let status;
  try {
    status = await fetchJson('/api/pipeline/status');
  } catch (e) {
    panel.innerHTML = `<div class="row"><span>Could not check pipeline status: ${e.message}</span></div>`;
    return;
  }

  if (status.running) {
    const applyLabel = status.includeApply ? (status.skipPush ? 'Apply Runner on, pushing (stays on branch)' : 'Apply Runner on, pushing') : 'Apply Runner off';
    panel.innerHTML = `
      <div class="row">
        <span>Live pipeline running against <strong>${escapeHtml(status.activeRepoRoot || '?')}</strong> (${escapeHtml(applyLabel)})</span>
        <span class="badge ok">RUNNING</span>
      </div>
    `;
  } else if (status.stoppable) {
    // Daemons are alive but _pipeline_running() isn't confirming (e.g. a worker blocked
    // on the model lock, a stale/missing heartbeat). The Stop control below still shows,
    // gated on stoppable -- so this state is always recoverable from the dashboard.
    panel.innerHTML = `
      <div class="row">
        <span>Pipeline daemons are running against <strong>${escapeHtml(status.activeRepoRoot || '?')}</strong>, but the health check isn't confirming (a worker may be blocked on the model lock). Use Stop / Force Stop to clear them.</span>
        <span class="badge idle">DAEMONS DETECTED</span>
      </div>
    `;
  } else {
    stopRequested = false; // confirmed not running -- next click on the toggle starts fresh, not a stray "force stop"
    if (status.activeRepoRoot) {
      panel.innerHTML = `
        <div class="row">
          <span>Last configured project: <strong>${escapeHtml(status.activeRepoRoot)}</strong></span>
          <span class="badge idle">NOT RUNNING</span>
        </div>
        <div class="meta">Browse to a folder above (or reuse this one) and click Start Pipeline.</div>
      `;
    } else {
      panel.innerHTML = `<div class="row"><span>No project configured yet.</span><span class="badge idle">IDLE</span></div>`;
    }
  }

  // Single button, reused for Start/Stop/Force Stop rather than a separate button per
  // state -- lives next to the path input, not in the panel above, since Start acts on
  // whatever's currently in that input.
  let startBtn = document.getElementById('start-pipeline-btn');
  if (!startBtn) {
    startBtn = document.createElement('button');
    startBtn.id = 'start-pipeline-btn';
    document.querySelector('.path-row').appendChild(startBtn);
  }
  if (status.running || status.stoppable) {
    // Gated on stoppable, not just running: if daemon processes exist, the Stop control
    // must be reachable no matter what the health check says (2026-08-30 incident -- a
    // blocked worker read as "not running" and the button was stuck on "Start Pipeline"
    // with no way to stop the real, live pipeline).
    pipelineStarting = false; // daemons exist -- past the starting gap this flag exists to bridge
    startBtn.className = 'danger';
    startBtn.disabled = false;
    startBtn.textContent = stopRequested ? 'Force Stop Pipeline' : 'Stop Pipeline';
    startBtn.onclick = stopRequested ? forceStopPipeline : stopPipeline;
  } else if (pipelineStarting) {
    // Daemons are still spinning up between the /pipeline/start call returning and this
    // status poll actually seeing status.running -- stay in the same disabled/"Starting..."
    // look startPipeline() itself set, rather than snapping back to a fully bright,
    // clickable "Start Pipeline" for one poll cycle. See pipelineStarting's own comment.
    startBtn.className = 'action';
    startBtn.disabled = true;
    startBtn.textContent = 'Starting...';
  } else {
    startBtn.className = 'action';
    startBtn.textContent = 'Start Pipeline';
    startBtn.onclick = startPipeline;
    startBtn.disabled = !projectPath;
  }
}

async function startPipeline() {
  if (!projectPath) return;
  const btn = document.getElementById('start-pipeline-btn');
  btn.disabled = true;
  btn.textContent = 'Starting...';
  pipelineStarting = true;
  try {
    const res = await fetch('/api/pipeline/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: projectPath, includeApply, skipPush }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.reason || data.description || res.statusText);
  } catch (e) {
    pipelineStarting = false; // start attempt itself failed -- nothing to bridge to, let the next render fall back to plain "Start Pipeline"
    alert('Could not start pipeline: ' + e.message);
  }
  await loadProjectHistory();
  await refreshPipelineStatus();
}

async function stopPipeline() {
  stopRequested = true;
  const btn = document.getElementById('start-pipeline-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Stopping...'; }
  try {
    await fetch('/api/pipeline/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: false }),
    });
  } catch (e) {
    alert('Could not stop pipeline: ' + e.message);
  }
  await refreshPipelineStatus();
}

async function forceStopPipeline() {
  const btn = document.getElementById('start-pipeline-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Force stopping...'; }
  try {
    await fetch('/api/pipeline/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: true }),
    });
  } catch (e) {
    alert('Could not force-stop pipeline: ' + e.message);
  }
  stopRequested = false;
  await refreshPipelineStatus();
}

async function loadBrowsePanel() {
  const panel = document.getElementById('browser-panel');
  if (!panel) return;
  panel.innerHTML = '<div class="empty">Loading...</div>';
  try {
    const data = await fetchJson('/api/browse?path=' + encodeURIComponent(browsePath));
    let html = `<div class="browser-crumb">${data.path || 'Drives'}</div>`;
    if (data.parent) {
      html += `<div class="browser-entry" data-nav="${escapeAttr(data.parent)}"><span>.. (up)</span></div>`;
    }
    if (data.path) {
      html += `<div class="browser-entry" data-select="${escapeAttr(data.path)}" style="border-top:2px solid var(--border);margin-top:4px;padding-top:8px">
        <span><strong>Use this folder</strong></span><span>&rarr;</span></div>`;
    }
    for (const entry of data.entries) {
      html += `<div class="browser-entry" data-nav="${escapeAttr(entry.path)}">
        <span>${escapeHtml(entry.name)}</span>
        ${entry.isGitRepo ? '<span class="git-badge">git</span>' : ''}
      </div>`;
    }
    panel.innerHTML = html;
    panel.querySelectorAll('[data-nav]').forEach(el => {
      el.onclick = () => { browsePath = el.dataset.nav; loadBrowsePanel(); };
    });
    panel.querySelectorAll('[data-select]').forEach(el => {
      el.onclick = () => {
        setProjectPath(el.dataset.select);
        document.getElementById('project-path-input').value = projectPath;
        lastRenderedStatusKey = null;  // switched projects -- old key would wrongly suppress the new render
        browserOpen = false;
        panel.style.display = 'none';
        document.getElementById('project-select').style.display = '';
        document.getElementById('project-path-input').style.display = 'none';
        loadProjectDropdown();  // reflects the freshly-browsed path, even if it's not a known Second Brain project
        refreshProjectStatus();
      };
    });
  } catch (e) {
    panel.innerHTML = `<div class="empty">Could not browse this path: ${e.message}</div>`;
  }
}

async function refreshProjectStatus() {
  const area = document.getElementById('project-status-area');
  const buildBtn = document.getElementById('build-btn');
  if (!area) return;
  if (!projectPath) {
    if (lastRenderedStatusKey !== 'no-path') {
      area.innerHTML = '<div class="empty">Enter or browse to a project path above to get started.</div>';
      lastRenderedStatusKey = 'no-path';
    }
    if (buildBtn) buildBtn.disabled = true;
    return;
  }

  let status;
  try {
    status = await fetchJson('/api/project/status?path=' + encodeURIComponent(projectPath) + '&grepDirs=' + encodeURIComponent(grepDirs));
  } catch (e) {
    if (lastRenderedStatusKey !== 'fetch-error') {
      area.innerHTML = `<div class="empty">${e.message}</div>`;
      lastRenderedStatusKey = 'fetch-error';
    }
    return;
  }

  if (buildBtn) buildBtn.disabled = status.build.running;

  // Building: the log genuinely needs to update every poll, but this branch never
  // contains an iframe, so unconditional re-render here is harmless.
  if (status.build.running) {
    area.innerHTML = '<div class="stat-row"><div class="stat"><strong>Building...</strong></div></div>'
      + '<div class="build-log">' + status.build.log.map(l => `<div>${escapeHtml(l)}</div>`).join('') + '</div>';
    lastRenderedStatusKey = 'building';
    return;
  }

  const key = status.build.error ? ('error:' + status.build.error)
    : status.graphExists ? ('graph:' + status.builtAt)
    : 'no-graph';
  if (key === lastRenderedStatusKey) return;  // nothing actually changed -- leave the iframe alone
  lastRenderedStatusKey = key;

  let html = '';
  if (status.build.error) {
    html = `<div class="stat-row"><div class="stat" style="color:var(--bad)"><strong>Build failed</strong>${escapeHtml(status.build.error)}</div></div>`;
  } else if (status.graphExists) {
    html = `
      <div class="stat-row">
        <div class="stat"><strong>${status.fileCount}</strong>files</div>
        <div class="stat"><strong>${status.communityCount}</strong>communities</div>
        <div class="stat"><strong>${status.builtAt ? new Date(status.builtAt).toLocaleString() : '?'}</strong>last built</div>
      </div>
      <iframe class="viz" src="/project/visualization?path=${encodeURIComponent(projectPath)}&grepDirs=${encodeURIComponent(grepDirs)}"></iframe>
    `;
  } else {
    html = '<div class="empty">No graph built yet for this project -- click Build Graph above.</div>';
  }
  area.innerHTML = html;
}

async function triggerBuild() {
  if (!projectPath) return;
  const buildBtn = document.getElementById('build-btn');
  buildBtn.disabled = true;
  try {
    const body = { path: projectPath };
    const dirs = grepDirs.split(',').map(d => d.trim()).filter(Boolean);
    if (dirs.length) body.grepDirs = dirs;
    const res = await fetch('/api/project/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.description || res.statusText);
    await loadProjectHistory();
    await refreshProjectStatus();
  } catch (e) {
    const area = document.getElementById('project-status-area');
    area.innerHTML = `<div class="empty">Could not start build: ${e.message}</div>`;
    buildBtn.disabled = false;
  }
}

async function triggerSync() {
  if (!projectPath) return;
  const syncBtn = document.getElementById('sync-btn');
  syncBtn.disabled = true;
  const originalLabel = syncBtn.textContent;
  syncBtn.textContent = 'Syncing...';
  try {
    const res = await fetch('/api/project/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: projectPath }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.description || res.statusText);
    if (!data.synced) {
      showToast(data.reason || 'could not sync', 'error');
    } else if (data.changed) {
      showToast(`Synced '${data.branch}' -- pulled ${data.behind} commit(s)`, 'info');
      await refreshProjectStatus();
    } else {
      showToast(`'${data.branch}' is already up to date with GitHub`, 'info');
    }
  } catch (e) {
    showToast(`Sync failed: ${e.message}`, 'error');
  } finally {
    syncBtn.disabled = false;
    syncBtn.textContent = originalLabel;
  }
}
