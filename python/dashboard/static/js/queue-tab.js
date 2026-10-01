// Queue tab: task actions, hub sort and priority, the source filter wiring and renderQueueTab. Moved verbatim out of core-ui.js (2026-10-01); allSourceNames and safeSourceNames stayed behind because core-ui.test.js requires safeSourceNames from core-ui.js. A plain global <script>, loaded by index.html right after core-ui.js.
// No require()/module.exports: the browser loads this with a plain <script src> tag, so every name below is a shared global.

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
