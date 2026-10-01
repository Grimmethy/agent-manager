// Workers tab: the per-instance cards, recent-task and run-log lists, the completed-tasks section and the stale-heartbeat timers. Moved verbatim out of core-ui.js (2026-10-01); a plain global <script>, loaded by index.html right after core-ui.js and before the inline script that schedules updateStaleTimers.
// No require()/module.exports: the browser loads this with a plain <script src> tag, so every name below is a shared global.

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
  const isStale = renderStaleCheck();
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
  if (isStale()) return;
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
