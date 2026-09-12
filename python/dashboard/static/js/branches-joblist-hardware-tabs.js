async function renderBranchesTab() {
  const main = document.getElementById('main');
  let branches;
  try {
    branches = await fetchJson('/api/git/unmerged-branches');
  } catch (e) {
    main.innerHTML = `<div class="empty">Error loading branches: ${escapeHtml(e.message)}</div>`;
    return;
  }
  if (branches.length === 0) {
    main.innerHTML = '<div class="empty">Nothing pushed-but-unmerged -- the live copy is caught up.</div>';
    return;
  }
  main.innerHTML = branches.map((b) => {
    // willConflict is a git merge-tree preview (app.py's _check_merge_conflict) -- a
    // real 3-way merge computed entirely against the object database, no working tree
    // touched -- run fresh every time this tab loads, not just at merge time. Added
    // after a real near-miss (2026-08-18): two branches that independently created the
    // same new file only revealed that conflict as an opaque error AFTER a merge was
    // already attempted. null means the check itself failed (not "no conflict") --
    // shown as unknown, never silently treated as safe.
    const conflictBadge = b.willConflict === true
      ? `<span class="badge bad" title="Conflicts on: ${escapeAttr((b.conflictFiles || []).join(', '))}">⚠ will conflict</span>`
      : b.willConflict === null
        ? `<span class="badge warn" title="Could not preview this merge -- outcome unknown until attempted.">? conflict unknown</span>`
        : '';
    const behindBadge = typeof b.behind === 'number' && b.behind > 0
      ? `<span class="badge" style="background:var(--panel);color:var(--muted)" title="master has moved ${b.behind} commit${b.behind === 1 ? '' : 's'} since this branch was forked -- git's 3-way merge still only applies this branch's OWN changes, so being behind alone is not itself dangerous.">${b.behind} behind</span>`
      : '';
    // A branch owned by an unfinished coordinator hub (a stacked file-decompose branch
    // still missing its wiring commit + gate pass) -- merging it now ships an incomplete
    // decomposition. The merge endpoint 409s it without {force:true}.
    const hubMidFlight = b.hub && !b.hub.readyToMerge;
    // Clickable straight from the list row (2026-09-12, screaminggoatclubmt: "I need
    // links in the unmerged branches task log to the hub task associated with unmerged
    // branches that are waiting on hubs to finish") -- before this, the ONLY way to see
    // which hub a mid-flight branch was waiting on was the tooltip's plain text (hub id,
    // no way to jump to it) or opening this row's own detail modal first. data-open-hub
    // reuses task-detail-modal.js's existing openTaskAnywhere(), the same generic
    // "look this task id up wherever it currently lives" opener every other tab already
    // uses -- no new endpoint needed.
    const hubBadge = b.hub
      ? (hubMidFlight
        ? `<span class="badge bad" data-open-hub="${escapeAttr(b.hub.id)}" style="cursor:pointer" title="Hub ${escapeAttr(b.hub.id)}: ${b.hub.progress.done}/${b.hub.progress.total} done${b.hub.integrationGate.status ? ', gate ' + b.hub.integrationGate.status : ''} -- click to open the hub">⚠ hub mid-flight</span>`
        : `<span class="badge ok" data-open-hub="${escapeAttr(b.hub.id)}" style="cursor:pointer" title="Coordinator hub complete -- click to open the hub">✓ hub complete</span>`)
      : '';
    return `
    <div class="worker-card" data-branch-row="${escapeAttr(b.branch)}" data-open-branch="${escapeAttr(b.branch)}" style="cursor:pointer">
      <div class="row">
        <span class="id">${escapeHtmlBright(b.title)}</span>
        <div class="badge-col">
          ${hubBadge}
          ${conflictBadge}
          <span class="badge warn">${b.ahead} commit${b.ahead === 1 ? '' : 's'} ahead</span>
          ${behindBadge}
        </div>
      </div>
      <div class="meta">
        ${b.domain ? `domain <strong>${escapeHtml(b.domain)}</strong>${b.source ? ' · source <strong>' + escapeHtml(b.source) + '</strong>' : ''} · ` : ''}
        pushed ${fmtAge((Date.now() - new Date(b.pushedAt).getTime()) / 1000)} ago
        ${!b.matchedTaskState ? ' · <span title="No matching queue/ task file found -- label is the branch\'s own last commit subject.">no task record found</span>' : ''}
        ${b.matchedTaskState === 'task-log' ? ' · <span title="No live queue/ record exists for this task anymore -- this came from the git-tracked task-logs/ file apply-task.js committed alongside the change, so it survives archival.">from committed task log</span>' : ''}
      </div>
      ${b.description ? `<div style="margin-top:6px;font-size:13px;color:var(--text)">${escapeHtml(b.description)}</div>` : ''}
      <div class="meta" style="font-family:monospace;font-size:11px;margin-top:4px">${escapeHtml(b.branch)}</div>
      <div class="row" style="margin-top:8px">
        <button class="action" data-merge-branch="${escapeAttr(b.branch)}" data-will-conflict="${b.willConflict === true}" data-conflict-files="${escapeAttr((b.conflictFiles || []).join(', '))}" data-hub-midflight="${hubMidFlight === true}" data-hub-status="${escapeAttr(b.hub ? b.hub.progress.done + '/' + b.hub.progress.total + ' done' + (b.hub.integrationGate.status ? ', gate ' + b.hub.integrationGate.status : '') : '')}">Merge to ${escapeHtml(b.mainBranch)}</button>
        <button class="secondary" data-discard-branch="${escapeAttr(b.branch)}" title="Permanently delete this remote branch and archive its task -- for a branch you've decided NOT to merge.">Discard</button>
      </div>
    </div>
  `;
  }).join('');

  main.querySelectorAll('[data-open-branch]').forEach((card) => {
    card.onclick = (e) => {
      // Don't hijack the Merge/Discard buttons' own clicks -- each has its own handler
      // and confirm() flow below, opening the history modal underneath it would be
      // surprising. Same reasoning for the hub badge (data-open-hub, below): it opens a
      // DIFFERENT task's detail (the hub, not this branch), so it must win over the
      // row's own "open this branch's detail" click.
      if (e.target.closest('[data-merge-branch]') || e.target.closest('[data-discard-branch]') || e.target.closest('[data-open-hub]')) return;
      const b = branches.find((x) => x.branch === card.dataset.openBranch);
      if (b) renderBranchDetailModal(b);
    };
  });

  main.querySelectorAll('[data-open-hub]').forEach((badge) => {
    badge.onclick = (e) => {
      e.stopPropagation();
      openTaskAnywhere(badge.dataset.openHub);
    };
  });

  main.querySelectorAll('[data-merge-branch]').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const branch = btn.dataset.mergeBranch;
      const midFlight = btn.dataset.hubMidflight === 'true';
      const confirmMsg = btn.dataset.willConflict === 'true'
        ? `"${branch}" is flagged as WILL CONFLICT with master on: ${btn.dataset.conflictFiles}.\n\nThe merge will very likely fail and need manual resolution. Attempt it anyway?`
        : midFlight
          ? `"${branch}" belongs to a coordinator hub that is NOT finished (${btn.dataset.hubStatus}).\n\nMerging now ships an incomplete decomposition -- the moved routes will 404 until the wiring task lands. Force the merge anyway?`
          : `Merge "${branch}" into master and sync the live dashboard?`;
      if (!confirm(confirmMsg)) return;
      btn.disabled = true;
      btn.textContent = 'Merging...';
      try {
        const resp = await fetch(`/api/git/branches/${encodeURIComponent(branch)}/merge`, {
          method: 'POST',
          headers: midFlight ? { 'Content-Type': 'application/json' } : {},
          body: midFlight ? JSON.stringify({ force: true }) : undefined,
        });
        const result = await resp.json();
        if (!resp.ok || !result.succeeded) throw new Error(result.reason || `HTTP ${resp.status}`);
        if (result.liveSync && result.liveSync.restartTriggered) {
          btn.textContent = 'Merged -- dashboard reloading...';
          // Werkzeug's reloader restart is near-instant but not synchronous with this
          // response -- give it a moment, then just re-render; if it's still mid-restart
          // renderMain()'s own try/catch shows a normal "disconnected" state until the
          // next 5s poll succeeds, same as any other brief connection drop.
          setTimeout(() => renderMain(), 1500);
        } else {
          await renderBranchesTab();
        }
      } catch (e) {
        alert('Merge failed: ' + e.message);
        await renderBranchesTab();
      }
    };
  });

  // Discard (2026-09-08, see api_git_discard_branch's own header for the incident this
  // closes) -- for a branch you've decided NOT to merge: permanently deletes the remote
  // ref and archives its task, so it actually stops showing here instead of just being
  // hidden or forgotten about.
  main.querySelectorAll('[data-discard-branch]').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const branch = btn.dataset.discardBranch;
      if (!confirm(`Discard "${branch}"?\n\nThis PERMANENTLY DELETES the remote branch (not just merging it later) and archives its task as dismissed. This cannot be undone from here.`)) return;
      btn.disabled = true;
      btn.textContent = 'Discarding...';
      try {
        const resp = await fetch(`/api/git/branches/${encodeURIComponent(branch)}/discard`, { method: 'POST' });
        const result = await resp.json();
        if (!resp.ok || !result.succeeded) throw new Error(result.reason || `HTTP ${resp.status}`);
        await renderBranchesTab();
      } catch (e) {
        alert('Discard failed: ' + e.message);
        await renderBranchesTab();
      }
    };
  });
}

async function renderBranchDetailModal(b) {
  const backdrop = document.getElementById('modal-backdrop');
  const content = document.getElementById('modal-content');
  content.innerHTML = `<button class="close" onclick="closeDetail()">&times;</button><h2>${escapeHtmlBright(b.title)}</h2><div class="meta">Loading history...</div>`;
  backdrop.classList.add('open');
  let data;
  try {
    data = await fetchJson(`/api/git/branches/${encodeURIComponent(b.branch)}/commits`);
  } catch (e) {
    content.innerHTML = `<button class="close" onclick="closeDetail()">&times;</button><h2>${escapeHtmlBright(b.title)}</h2><div class="meta" style="color:var(--bad)">Error loading history: ${escapeHtml(e.message)}</div>`;
    return;
  }
  let html = `<button class="close" onclick="closeDetail()">&times;</button><h2>${escapeHtmlBright(b.title)}</h2>`;
  html += `<div class="meta" style="font-family:monospace;font-size:11px">${escapeHtml(b.branch)} → ${escapeHtml(b.mainBranch)}</div>`;
  if (b.domain) html += `<div class="field-label">Domain / Source</div><div>${escapeHtml(b.domain)} / ${escapeHtml(b.source || '')}</div>`;
  if (b.description) html += `<div class="field-label">What this changes</div><div>${escapeHtml(b.description)}</div>`;

  // Coordinator hub status -- a stacked file-decompose branch is a slice of a multi-task
  // hub, not a finished unit. Show where the hub stands and whether it's safe to merge.
  const hub = data.hub;
  if (hub) {
    const p = hub.progress || {};
    const gate = (hub.integrationGate || {}).status;
    html += `<div class="field-label">Coordinator hub</div>`;
    html += `<div class="worker-card" style="margin:4px 0">`;
    if (!hub.readyToMerge) {
      html += `<div class="badge bad" style="margin-bottom:6px">⚠ mid-flight — not ready to merge</div>`;
    } else {
      html += `<div class="badge ok" style="margin-bottom:6px">✓ hub complete</div>`;
    }
    html += `<div class="meta"><a href="javascript:void(0)" data-open-hub="${escapeAttr(hub.id)}" style="cursor:pointer">${escapeHtmlBright(hub.title || hub.id)}</a> · ${p.done}/${p.total} task(s) done`
      + (gate ? ` · integration gate <strong>${escapeHtml(gate)}</strong>` : '') + `</div>`;
    if (hub.blockedReason) html += `<div class="meta" style="color:var(--bad);margin-top:4px">${escapeHtmlBright(hub.blockedReason)}</div>`;
    html += `<div class="task-history" style="margin-top:6px">` + (hub.subTasks || []).map((st) =>
      `<div class="task-history-row"><span class="task-history-stage">${escapeHtmlBright(st.title || st.id)}</span> `
      + `<span class="badge ${st.status === 'done' || st.status === 'merged' ? 'ok' : st.status === 'blocked' || st.status === 'needs-clarification' ? 'bad' : ''}">${escapeHtml(st.status || '?')}</span></div>`
    ).join('') + `</div>`;
    const checks = (hub.integrationGate || {}).checks;
    if (checks && checks.length) {
      html += `<div class="task-history" style="margin-top:4px">` + checks.map((ck) =>
        `<div class="task-history-row"><span class="task-history-stage">gate: ${escapeHtml(ck.name)}</span> `
        + `<span class="badge ${ck.status === 'pass' ? 'ok' : ck.status === 'fail' ? 'bad' : ''}">${escapeHtml(ck.status)}</span>`
        + (ck.detail ? `<pre>${escapeHtml(ck.detail)}</pre>` : '') + `</div>`
      ).join('') + `</div>`;
    }
    html += `</div>`;
  }

  html += `<div class="field-label">Commits (${data.commits.length}, newest first)</div>`;
  if (!data.commits.length) {
    html += `<div class="meta">No commits found ahead of ${escapeHtml(b.mainBranch)}.</div>`;
  } else {
    html += data.commits.map((c) => {
      const when = c.date ? new Date(c.date).toLocaleString() : '';
      let row = `<div class="worker-card" style="margin:4px 0">`
        + `<div class="task-history-row"><span class="task-history-stage">${escapeHtml(c.subject)}</span> `
        + `<span class="meta">${escapeHtml(c.author)} · ${escapeHtml(when)} · <code>${escapeHtml(c.sha.slice(0, 8))}</code></span></div>`;
      // The commit's own message body -- and, when the Task: trailer resolves, that
      // task's REAL pipeline log (plan → implement tiers → review votes → disposition).
      if (c.task) {
        const t = c.task;
        row += `<div class="meta" style="margin-top:2px">task <code>${escapeHtml(t.id)}</code> · ${escapeHtml(t.state || '?')}`
          + (t.terminalDisposition ? ` · ${escapeHtml(t.terminalDisposition)}` : '')
          + (t.reviewVotes ? ` · review ${escapeHtml(t.reviewVotes)}` : '') + `</div>`;
        if (t.description) row += `<div style="font-size:12px;margin-top:4px">${escapeHtml(t.description)}</div>`;
        row += `<div class="task-history" style="margin-top:6px">` + (t.history || []).map((e) => {
          const eWhen = e.at ? new Date(e.at).toLocaleTimeString() : '';
          return `<div class="task-history-row"><span class="task-history-stage">${escapeHtml(e.stage || '?')}</span> `
            + `<span class="meta">${escapeHtml(eWhen)}</span>`
            + (e.detail ? ` <span style="font-size:12px">${escapeHtml(e.detail)}</span>` : '') + `</div>`;
        }).join('') + `</div>`;
      } else {
        if (c.taskId) row += `<div class="meta" style="margin-top:2px">task <code>${escapeHtml(c.taskId)}</code> — no queue record found</div>`;
        if (c.body) row += `<pre>${escapeHtml(c.body)}</pre>`;
      }
      return row + `</div>`;
    }).join('');
  }
  content.innerHTML = html;
  content.querySelectorAll('[data-open-hub]').forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();
      openTaskAnywhere(el.dataset.openHub);
    };
  });
}

async function renderJobListTab() {
  const main = document.getElementById('main');
  let jobTypes;
  try {
    jobTypes = await fetchJson('/api/job-types');
  } catch (e) {
    jobTypes = null;
  }
  // 2026-08-26, Grimmethy: "After looking at pipeline map I've realized that it really
  // should just be an extension of Job List instead of a new tab entirely" -- folded in
  // here rather than kept as its own tab. Row list is /api/pipeline-map's sources (straight
  // off the real registry via --dump-topology); /api/job-types carries the per-row
  // description/domain/priority/worker-type (also registry-driven, load_topology()) and the
  // editable state. Both include AGENT_MANAGER_REGISTER_PATH plugin sources, so neither
  // can drift the way the old client-side JOB_TYPES const did.
  let pipelineMap;
  try {
    pipelineMap = await fetchJson('/api/pipeline-map');
  } catch (e) {
    pipelineMap = null;
  }
  const activeByName = {};
  const alwaysActiveByName = {};
  const priorityByName = {};
  const approvalModeByName = {};
  const workerTypeByName = {};
  const timesPerformedByName = {};
  const availableByName = {};
  const familyByName = {};
  const familyLabelByName = {};
  (jobTypes || []).forEach((j) => {
    activeByName[j.name] = j.active;
    alwaysActiveByName[j.name] = j.alwaysActive;
    priorityByName[j.name] = j.priority;
    approvalModeByName[j.name] = j.approvalMode;
    workerTypeByName[j.name] = j.workerType;
    timesPerformedByName[j.name] = j.timesPerformed;
    availableByName[j.name] = j.available;
    familyByName[j.name] = j.family || null;
    familyLabelByName[j.name] = j.familyLabel || null;
  });
  const descByName = {};
  const domainByName = {};
  (jobTypes || []).forEach((j) => { descByName[j.name] = j.description; domainByName[j.name] = j.domain; });

  const mapAvailable = !!(pipelineMap && pipelineMap.available);
  // Fall back to /api/job-types' own rows when /api/pipeline-map itself is unavailable
  // (node not on PATH, script error, etc.) -- /api/job-types has a committed topology
  // snapshot fallback so it stays populated; same "degrade, don't blank the tab" treatment.
  const sourceList = mapAvailable
    ? pipelineMap.sources
    : (jobTypes || []).map((j) => ({ name: j.name, priority: j.priority, liveCounts: {} }));

  // Backbone strip: total live count per stage, summed across every source at once.
  const stageTotals = {};
  for (const stage of PIPELINE_STAGE_ORDER) stageTotals[stage] = 0;
  for (const s of sourceList) {
    for (const [stage, count] of Object.entries(s.liveCounts || {})) {
      stageTotals[stage] = (stageTotals[stage] || 0) + count;
    }
  }
  const backboneHtml = mapAvailable ? `
    <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:16px;">
      ${PIPELINE_STAGE_ORDER.map((stage) => `
        <div style="flex:1; min-width:110px; background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:10px 12px; text-align:center;">
          <div style="font-size:22px; font-weight:700; color:${stageTotals[stage] > 0 ? 'var(--accent)' : 'var(--muted)'};">${stageTotals[stage]}</div>
          <div class="meta">${PIPELINE_STAGE_LABELS[stage]}</div>
        </div>
      `).join('<div style="align-self:center; color:var(--muted); font-size:18px;">→</div>')}
    </div>
  ` : '';

  // Sort by the EFFECTIVE priority (server override if any, else the registry/JOB_TYPES
  // static default) -- not the bare static default -- so an edit actually reorders the
  // table.
  const buildRow = (j, opts = {}) => {
    const alwaysActive = !!alwaysActiveByName[j.name];
    const isActive = jobTypes ? (activeByName[j.name] ?? true) : true;
    const checkbox = jobTypes
      ? `<input type="checkbox" class="job-type-toggle" data-source="${escapeAttr(j.name)}" ${isActive ? 'checked' : ''} ${alwaysActive ? 'disabled title="Always active -- cannot be turned off"' : ''}>`
      : `<span class="meta">?</span>`;
    // Priority cell: click-to-type input, relying on the browser's own native number-input
    // spinner for the "up1/down1" arrows the Brain Dump request asked for -- a separate
    // pair of custom buttons above/below the input (the original implementation) was
    // redundant with that native control and looked like a duplicate widget. Disabled
    // entirely when /api/job-types failed to load, same convention the checkbox already
    // uses for that case.
    const priorityCell = jobTypes
      ? `<input type="number" class="priority-input" data-source="${escapeAttr(j.name)}" value="${j.priority}">`
      : `<span class="meta">${j.priority}</span>`;
    // Approval mode (three-tier approval mode, 2026-07-26): a plain native <select> --
    // there's no custom-dropdown component anywhere in this dashboard, and a 3-option
    // enum is exactly what a native select is for. 'auto' applies automatically once
    // Ornith approves; 'approve'/'prompt' both wait for a manual Apply click on the
    // Approved tab -- 'prompt' only differs in getting an active badge there instead of
    // a plain count, never in whether this automatic loop touches it.
    const approvalMode = approvalModeByName[j.name] ?? 'auto';
    const approvalModeCell = jobTypes
      ? `<select class="approval-mode-select" data-source="${escapeAttr(j.name)}">
          ${['auto', 'prompt', 'approve'].map((m) => `<option value="${m}" ${m === approvalMode ? 'selected' : ''}>${m}</option>`).join('')}
        </select>`
      : `<span class="meta">${approvalMode}</span>`;
    // Worker Type: which worker actually claims this source's tasks -- 'ornith' (the
    // local, low-reasoning worker) or 'reasoning' (the Claude-backed high-reasoning
    // worker). Note for adhoc/research_task specifically: their actual draft call is
    // hardcoded to Claude regardless of this setting (see model-provider.js's
    // reasoningTierFor() comment), so overriding those two rows to 'ornith' only changes
    // which worker's claim filter picks the task up, not what drafts it.
    const workerType = workerTypeByName[j.name] ?? 'ornith';
    const workerTypeCell = jobTypes
      ? `<select class="worker-type-select" data-source="${escapeAttr(j.name)}">
          ${['ornith', 'reasoning'].map((w) => `<option value="${w}" ${w === workerType ? 'selected' : ''}>${w}</option>`).join('')}
        </select>`
      : `<span class="meta">${workerType}</span>`;
    // Times Performed: cumulative, all-time count of how many tasks this job type has
    // ever generated (Brain Dump, 2026-08-23) -- independent of the Active/Priority/
    // Approval Mode columns above, which only affect FUTURE tasks. Read-only here; the
    // one way to change it is the "Reset counts" button below, which zeroes every row at
    // once (see /api/job-types/reset-counts's own comment for why never a single row).
    const timesPerformed = timesPerformedByName[j.name] ?? 0;
    // Available: how many Strong-rated candidates this source's own backlog doc (e.g.
    // ARCH_REVIEW_CANDIDATES.md) still has waiting, not yet claimed by any in-queue
    // fulfillment task (app.py's available_candidate_counts()). Only a handful of sources
    // have an enumerable backlog doc at all (arch_review, arch_import_review,
    // observability_fix, performance_fix) -- null for everything else, shown as a blank
    // cell rather than a misleading 0 for a source whose real backlog size just isn't
    // tracked anywhere (an inbox folder, a flags file, external scanner output, ...).
    const available = jobTypes ? availableByName[j.name] : null;
    const availableCell = available == null ? '' : String(available);
    const behaviorCell = mapAvailable ? pipelineFlagBadges(j) : '<span class="meta">?</span>';
    const liveCell = mapAvailable
      ? (Object.entries(j.liveCounts || {}).filter(([, c]) => c > 0)
          .map(([stage, c]) => `<span class="badge warn" title="${PIPELINE_STAGE_LABELS[stage] || stage}">${PIPELINE_STAGE_LABELS[stage] || stage}: ${c}</span>`)
          .join(' ') || '<span class="meta">idle</span>')
      : '<span class="meta">?</span>';
    // Turns (min/avg/max) (2026-08-26, Grimmethy: "add turnsUsed recording... a data
    // point we track for each job type in the Job List itself (min/max/average)" --
    // prompted by the Chat-panel turn-budget investigation finding zero telemetry for
    // whether ANY runPlanWithTools()-backed source's turn cap is actually enough). Only
    // populated for sources that have gone through a real recorded call at least once
    // (model-stats.db's turns_used column, model-stats-db.js's own turns-summary event)
    // -- a blank cell means "not instrumented yet or never called," not "uses 0 turns."
    const turnsCell = j.turnsStats
      ? `${j.turnsStats.minTurns} / ${Math.round(j.turnsStats.avgTurns * 10) / 10} / ${j.turnsStats.maxTurns}<span class="meta"> (n=${j.turnsStats.calls})</span>`
      : '<span class="meta">—</span>';
    const nameCellStyle = opts.inFamily ? ' style="padding-left:24px"' : '';
    const trAttrs = opts.inFamily ? ` class="fam-member" data-fam-row="${escapeAttr(opts.inFamily)}"${opts.hidden ? ' style="display:none"' : ''}` : '';
    return `
    <tr${trAttrs}>
      <td>${checkbox}</td>
      <td>${priorityCell}</td>
      <td>${approvalModeCell}</td>
      <td>${workerTypeCell}</td>
      <td${nameCellStyle}><a href="#" class="job-log-link" data-job-log="${escapeAttr(j.name)}" title="Recent runs of this job type">${escapeHtml(j.name)}</a></td>
      <td>${domainByName[j.name] ?? '—'}</td>
      <td>${behaviorCell}</td>
      <td>${liveCell}</td>
      <td>${turnsCell}</td>
      <td>${timesPerformed}</td>
      <td>${availableCell}</td>
      <td>${escapeHtml(descByName[j.name] ?? '')}</td>
    </tr>
  `;
  };

  // Group family members (arch_discovery/arch_import/arch_review/arch_import_review, ...)
  // out of the flat priority sort: a family renders as one collapsible block positioned
  // at its lowest-priority member, with a group-level Priority input that shifts every
  // member together (POST /api/job-types/priority-family). Members are NOT guaranteed
  // contiguous in a global priority sort, so pulling them into a block means a family's
  // higher-priority members can appear ahead of a singleton that outranks them -- an
  // accepted trade for the grouping. Per-source overrides still work: expand and edit a
  // member row. Collapse state persists per family in localStorage.
  let collapsedFamilies;
  try {
    collapsedFamilies = new Set(JSON.parse(localStorage.getItem('joblist-collapsed-families') || '[]'));
  } catch (e) {
    collapsedFamilies = new Set();
  }

  const sorted = sourceList.slice()
    .map((j) => ({ ...j, priority: priorityByName[j.name] ?? j.priority }))
    .sort((a, b) => a.priority - b.priority);

  const familyMembers = {};
  for (const j of sorted) {
    const fam = familyByName[j.name];
    if (fam) (familyMembers[fam] = familyMembers[fam] || []).push(j);
  }

  const renderItems = [];
  const seenFamilies = new Set();
  for (const j of sorted) {
    const fam = familyByName[j.name];
    if (!fam) { renderItems.push({ sortKey: j.priority, kind: 'single', row: j }); continue; }
    if (seenFamilies.has(fam)) continue;
    seenFamilies.add(fam);
    const members = familyMembers[fam];
    const lo = Math.min(...members.map((m) => m.priority));
    const hi = Math.max(...members.map((m) => m.priority));
    renderItems.push({ sortKey: lo, kind: 'family', key: fam, label: familyLabelByName[members[0].name] || fam, members, lo, hi });
  }
  renderItems.sort((a, b) => a.sortKey - b.sortKey);

  const rows = renderItems.map((item) => {
    if (item.kind === 'single') return buildRow(item.row);
    const collapsed = collapsedFamilies.has(item.key);
    const spread = item.lo === item.hi ? `priority ${item.lo}` : `priority ${item.lo}–${item.hi}`;
    const headerPriorityCell = jobTypes
      ? `<input type="number" class="fam-priority-input" data-family="${escapeAttr(item.key)}" value="${item.lo}" title="Set this family's position — shifts every member by the same amount, keeping their internal order. Expand to override one row.">`
      : `<span class="meta">${item.lo}</span>`;
    const header = `
    <tr class="fam-header" style="background:var(--panel)">
      <td></td>
      <td>${headerPriorityCell}</td>
      <td colspan="10">
        <button type="button" class="fam-toggle" data-family="${escapeAttr(item.key)}"
          style="background:none;border:none;color:inherit;cursor:pointer;font:inherit;padding:0 6px 0 0">${collapsed ? '▶' : '▼'}</button>
        <b>${escapeHtml(item.label)}</b>
        <span class="meta"> — ${item.members.length} sources · ${spread}</span>
      </td>
    </tr>`;
    const memberRows = item.members.map((m) => buildRow(m, { inFamily: item.key, hidden: collapsed })).join('');
    return header + memberRows;
  }).join('');

  const unregistered = mapAvailable ? (pipelineMap.unregistered || []) : [];
  const unregisteredHtml = unregistered.length ? `
    <p class="meta" style="margin-top:16px;">Tasks in the queue under a source name with no matching registry entry (a renamed/retired source with old work still sitting around):</p>
    <table><thead><tr><th>Source name</th><th>Live counts</th></tr></thead><tbody>
      ${unregistered.map((u) => `<tr><td>${escapeHtml(u.name)}</td><td>${Object.entries(u.liveCounts).map(([st, c]) => `${PIPELINE_STAGE_LABELS[st] || st}: ${c}`).join(', ')}</td></tr>`).join('')}
    </tbody></table>
  ` : '';

  // Hand-authored detail insets: the two real multi-tier paths that don't reduce to a
  // single registry flag, kept as static text/boxes reviewed by hand (rare-changing)
  // rather than auto-generated.
  const detailInsetsHtml = mapAvailable ? `
    <div style="display:flex; gap:16px; flex-wrap:wrap; margin-top:24px;">
      <div style="flex:1; min-width:320px; background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:14px;">
        <div style="font-weight:600; margin-bottom:8px;">Adhoc draft (domain:'adhoc', source:'manual')</div>
        <div class="meta" style="line-height:1.7;">
          A single local multi-turn agentic pass, <b>local-agentic-write</b> (local-agentic-write-draft.js) — real read/grep/glob/edit/write/run_bash tool access against an isolated worktree. No Claude tier, and no cheaper escalation tiers ahead of it: those existed 2026-09-01 through 2026-09-06, removed after real production history showed the cheap tiers won only ~11% of the time combined while costing the other ~89% their full time for nothing, and a safety audit found no incident of this pass's write access producing a bad edit a cheaper read-only tier would have caught. Declines (blocks for a human) if it can't confidently make the change.<br>
          Can resolve to <b>decompose</b> (task judged too large — queues 2+ fresh adhoc sub-tasks to <code>queue/adhoc/</code> instead of a diff) or <b>needs-human-decision</b> (routes to <code>queue/needs-clarification/</code>, never judged by an automatic reviewer).
        </div>
      </div>
      <div style="flex:1; min-width:320px; background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:14px;">
        <div style="font-weight:600; margin-bottom:8px;">Split escape hatch (candidate-fulfillment sources — see "split-capable" badge)</div>
        <div class="meta" style="line-height:1.7;">
          Implement can output <code>{"mode":"split","candidates":[...]}</code> instead of a diff when the real candidate genuinely doesn't fit one atomic JSON edit (prompts.js's candidateSplitInstructions). Skips critique (no diff to critique) and goes straight to review, judged on scope-coverage rather than "does it contain code." At apply time, the sub-candidates are written back into the <i>same</i> candidates doc the original came from (the exact appender arch_discovery's own apply already uses) — each one then flows through the normal pickup loop on a later tick, small enough to land as its own single edit.
        </div>
      </div>
    </div>
  ` : '';

  main.innerHTML = `<div style="margin-bottom:10px"><button id="reset-job-type-counts" class="secondary">Reset counts</button></div>`
    + backboneHtml
    + `<table><thead><tr><th>Active</th><th>Priority</th><th>Approval Mode</th><th>Worker Type</th><th>Source</th><th>Domain</th><th>Behavior</th><th>Live (in-flight)</th><th title="Min / Avg / Max turnsUsed across every recorded runPlanWithTools() call for this source">Turns (min/avg/max)</th><th>Times Performed</th><th>Available</th><th>Description</th></tr></thead><tbody>${rows}</tbody></table>`
    + unregisteredHtml
    + detailInsetsHtml;

  main.querySelectorAll('.job-log-link').forEach((a) => {
    a.onclick = (e) => { e.preventDefault(); openJobLog(a.dataset.jobLog); };
  });

  const resetButton = document.getElementById('reset-job-type-counts');
  if (resetButton) {
    resetButton.onclick = async () => {
      if (!confirm('Reset the "Times Performed" counter for every job type back to 0?')) return;
      resetButton.disabled = true;
      try {
        await fetch('/api/job-types/reset-counts', { method: 'POST' });
        await renderJobListTab();
      } catch (e) {
        alert('Could not reset counts: ' + e.message);
        resetButton.disabled = false;
      }
    };
  }

  main.querySelectorAll('.job-type-toggle').forEach((cb) => {
    cb.onchange = async () => {
      cb.disabled = true;
      try {
        await fetch('/api/job-types/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: cb.dataset.source, active: cb.checked }),
        });
      } catch (e) {
        alert('Could not update job type: ' + e.message);
        cb.checked = !cb.checked;
      }
      cb.disabled = false;
    };
  });

  // Submits a new priority for `source`, re-rendering the (now possibly re-sorted) tab
  // on success -- reverting the input's displayed value on failure rather than leaving
  // it showing an unsaved edit.
  const submitPriority = async (source, newPriority, revertTo) => {
    const controls = main.querySelectorAll(`[data-source="${CSS.escape(source)}"]`);
    controls.forEach((el) => { el.disabled = true; });
    try {
      await fetch('/api/job-types/priority', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: source, priority: newPriority }),
      });
      await renderJobListTab();
    } catch (e) {
      alert('Could not update priority: ' + e.message);
      controls.forEach((el) => { el.disabled = false; });
      const input = main.querySelector(`input.priority-input[data-source="${CSS.escape(source)}"]`);
      if (input) input.value = revertTo;
    }
  };

  main.querySelectorAll('.priority-input').forEach((input) => {
    const commit = () => {
      const parsed = parseInt(input.value, 10);
      const original = priorityByName[input.dataset.source];
      if (Number.isNaN(parsed) || parsed === original) { input.value = original; return; }
      submitPriority(input.dataset.source, parsed, original);
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
  });

  // Family collapse toggle: show/hide the member rows in place (no refetch) and remember
  // the choice per family.
  main.querySelectorAll('.fam-toggle').forEach((btn) => {
    btn.onclick = () => {
      const fam = btn.dataset.family;
      const collapse = !collapsedFamilies.has(fam);
      if (collapse) collapsedFamilies.add(fam); else collapsedFamilies.delete(fam);
      try { localStorage.setItem('joblist-collapsed-families', JSON.stringify([...collapsedFamilies])); } catch (e) { /* private mode */ }
      btn.textContent = collapse ? '▶' : '▼';
      main.querySelectorAll(`tr[data-fam-row="${CSS.escape(fam)}"]`).forEach((tr) => {
        tr.style.display = collapse ? 'none' : '';
      });
    };
  });

  // Family-level Priority: one number shifts every member of the family together (server
  // keeps the internal 70/71/80/81-style offsets). Re-renders on success so the table
  // re-sorts; reverts the field on failure.
  main.querySelectorAll('.fam-priority-input').forEach((input) => {
    const original = Number(input.value);
    const commit = async () => {
      const parsed = parseInt(input.value, 10);
      if (Number.isNaN(parsed) || parsed === original) { input.value = original; return; }
      input.disabled = true;
      try {
        const res = await fetch('/api/job-types/priority-family', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ family: input.dataset.family, base: parsed }),
        });
        if (!res.ok) throw new Error(await res.text());
        await renderJobListTab();
      } catch (e) {
        alert('Could not update family priority: ' + e.message);
        input.value = original;
        input.disabled = false;
      }
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
  });

  main.querySelectorAll('.approval-mode-select').forEach((select) => {
    select.onchange = async () => {
      const source = select.dataset.source;
      const original = approvalModeByName[source];
      const mode = select.value;
      select.disabled = true;
      try {
        await fetch('/api/job-types/approval-mode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: source, mode }),
        });
      } catch (e) {
        alert('Could not update approval mode: ' + e.message);
        select.value = original;
      }
      select.disabled = false;
    };
  });

  main.querySelectorAll('.worker-type-select').forEach((select) => {
    select.onchange = async () => {
      const source = select.dataset.source;
      const original = workerTypeByName[source];
      const workerType = select.value;
      select.disabled = true;
      try {
        await fetch('/api/job-types/worker-type', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: source, workerType }),
        });
      } catch (e) {
        alert('Could not update worker type: ' + e.message);
        select.value = original;
      }
      select.disabled = false;
    };
  });
}

function fmtBytes(n) {
  if (n == null) return '-';
  const gb = n / (1024 ** 3);
  return gb >= 1 ? gb.toFixed(1) + ' GB' : (n / (1024 ** 2)).toFixed(0) + ' MB';
}

function fmtMiB(n) {
  if (n == null) return '-';
  return n >= 1024 ? (n / 1024).toFixed(1) + ' GB' : Math.round(n) + ' MiB';
}

function fmtTemp(c) { return c == null ? '-' : Math.round(c) + '°C'; }

function fmtPercent(p) { return p == null ? '-' : Math.round(p) + '%'; }

function renderSparkline(history, getValue, avg, label) {
  // The label is rendered as this chart's own heading -- baked in here, not left to
  // each call site to add separately, after a real regression (2026-09-06): the
  // multi-GPU rewrite passed `label` through for the empty-state message only, so
  // every sparkline with real data rendered with no visible heading at all -- three
  // unlabeled stacked charts per GPU, no way to tell utilization from VRAM from
  // temperature, or which GPU a given chart even belonged to. Baking the heading into
  // the function itself means no future call site can drop it again by omission.
  const heading = `<div class="field-label">${escapeHtml(label)} -- last 24h</div>`;
  const W = 300, H = 60, PAD = 3;
  const points = history
    .map((entry, i) => ({ i, v: getValue(entry) }))
    .filter(p => p.v != null);
  if (points.length < 2) return `${heading}<div class="meta">Not enough history yet to graph ${escapeHtml(label)}.</div>`;
  const values = points.map(p => p.v);
  const min = Math.min(...values, avg != null ? avg : values[0]);
  const max = Math.max(...values, avg != null ? avg : values[0]);
  const span = Math.max(max - min, 1);
  const x = (i) => PAD + (i / (history.length - 1)) * (W - PAD * 2);
  const y = (v) => PAD + (1 - (v - min) / span) * (H - PAD * 2);
  const linePoints = points.map(p => `${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const last = points[points.length - 1];
  const avgY = avg != null ? y(avg) : null;
  return `
    ${heading}
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:60px;display:block">
      ${avgY != null ? `<line x1="${PAD}" y1="${avgY.toFixed(1)}" x2="${W - PAD}" y2="${avgY.toFixed(1)}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="4,3" vector-effect="non-scaling-stroke"/>` : ''}
      <polyline points="${linePoints}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
      <circle cx="${x(last.i).toFixed(1)}" cy="${y(last.v).toFixed(1)}" r="3" fill="var(--accent)"/>
    </svg>
    <div class="meta">&#8212; current &nbsp;&nbsp; &#8901;&#8901;&#8901; 24h average</div>`;
}

async function renderHardwareTab() {
  const main = document.getElementById('main');
  const data = await fetchJson('/api/hardware/stats');
  // Hardware is a swappable plugin slot (2026-09-05) -- "available: false" means no
  // plugin is currently active/running for it, distinct from a plugin running but
  // still warming up its first sample (which instead shows normally with nulls/no
  // history yet, same as before this change).
  if (data.available === false) {
    main.innerHTML = `
      <div class="empty">Hardware monitoring is off -- pick a plugin on the
        <a href="#" onclick="activeTab='plugins'; renderNav(); renderMain(); return false;">Plugins tab</a>.</div>`;
    return;
  }
  const cur = data.current || {};
  const avg = data.averages || {};
  const history = data.history || [];
  const ram = cur.ram || {};
  const disk = cur.disk || {};
  // Multi-GPU (2026-09-05): prefer the full "gpus" list (both this repo's plugins can
  // report it -- see hardware_stats.py's _gpus()/goatmon_adapter.py's "gpus" key) so
  // every GPU on the box gets its own labeled section, not just whichever one a
  // legacy single-"gpu" heuristic picked as "primary". Falls back to a one-item list
  // from the singular "gpu" field for any plugin that only ever reports one.
  const gpuList = (cur.gpus && cur.gpus.length) ? cur.gpus : (cur.gpu ? [cur.gpu] : []);
  const gpuLabel = (g, i) => g.name || `GPU ${g.index != null ? g.index : i}`;
  // History rows carry the same "gpus" (or singular "gpu") shape per sample -- match
  // by array position, since a GPU's index/name is stable across samples on one box.
  const gpuHistoryValue = (entry, i, field) => {
    if (entry.gpus && entry.gpus[i]) return entry.gpus[i][field];
    if (i === 0 && entry.gpu) return entry.gpu[field];
    return null;
  };
  const gpuAvg = (i, field) => {
    const values = history.map(e => gpuHistoryValue(e, i, field)).filter(v => v != null);
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  };

  const tempStat = (label, curVal, avgVal) => `
    <div class="stat"><strong>${fmtTemp(curVal)}</strong>${escapeHtml(label)} temp (24h avg ${fmtTemp(avgVal)})</div>`;

  const gpuSections = gpuList.length ? gpuList.map((g, i) => `
    <div class="field-label">${escapeHtml(gpuLabel(g, i))}</div>
    <div class="stat-row">
      <div class="stat"><strong>${fmtPercent(g.utilizationPercent)}</strong>utilization (24h avg ${fmtPercent(gpuAvg(i, 'utilizationPercent'))})</div>
      <div class="stat"><strong>${fmtMiB(g.vramUsedMiB)} / ${fmtMiB(g.vramTotalMiB)}</strong>VRAM used</div>
      <div class="stat"><strong>${fmtTemp(g.temperatureCelsius)}</strong>temp (24h avg ${fmtTemp(gpuAvg(i, 'temperatureCelsius'))})</div>
    </div>
    ${renderSparkline(history, e => gpuHistoryValue(e, i, 'utilizationPercent'), gpuAvg(i, 'utilizationPercent'), `${gpuLabel(g, i)} utilization`)}
    ${renderSparkline(history, e => gpuHistoryValue(e, i, 'vramUsedMiB'), gpuAvg(i, 'vramUsedMiB'), `${gpuLabel(g, i)} VRAM used`)}
    ${renderSparkline(history, e => gpuHistoryValue(e, i, 'temperatureCelsius'), gpuAvg(i, 'temperatureCelsius'), `${gpuLabel(g, i)} temperature`)}
  `).join('') : `<div class="field-label">GPU</div><div class="meta">No GPU detected.</div>`;

  main.innerHTML = `
    <div class="field-label">System</div>
    <div class="stat-row">
      <div class="stat"><strong>${fmtPercent(cur.cpuPercent)}</strong>CPU utilization (24h avg ${fmtPercent(avg.cpuPercent)})</div>
      <div class="stat"><strong>${fmtBytes(ram.usedBytes)} / ${fmtBytes(ram.totalBytes)}</strong>RAM used</div>
      <div class="stat"><strong>${fmtBytes(disk.usedBytes)} / ${fmtBytes(disk.totalBytes)}</strong>disk used</div>
      ${tempStat('CPU', cur.cpuTemperatureCelsius, avg.cpuTemperatureCelsius)}
    </div>
    ${renderSparkline(history, e => e.cpuTemperatureCelsius, avg.cpuTemperatureCelsius, 'CPU temperature')}
    ${renderSparkline(history, e => e.cpuPercent, avg.cpuPercent, 'CPU utilization')}
    ${renderSparkline(history, e => e.ram ? e.ram.usedBytes : null, avg.ramUsedBytes, 'RAM used')}
    ${renderSparkline(history, e => e.disk ? e.disk.usedBytes : null, avg.diskUsedBytes, 'disk used')}

    ${gpuSections}

    ${cur.filesystems && cur.filesystems.length ? `
    <div class="field-label">Filesystems</div>
    <table style="width:100%; border-collapse:collapse;">
      <tr><th class="meta" style="text-align:left; padding:2px 8px 2px 0;">Mount</th>
          <th class="meta" style="text-align:left; padding:2px 8px;">Device</th>
          <th class="meta" style="text-align:left; padding:2px 8px;">Type</th>
          <th class="meta" style="text-align:right; padding:2px 0;">Used / total</th></tr>
      ${cur.filesystems.map(fs => `
        <tr>
          <td class="meta" style="padding:2px 8px 2px 0; word-break:break-all;">${escapeHtml(fs.mountPoint)}${fs.readOnly ? ' <span class="badge idle">ro</span>' : ''}</td>
          <td class="meta" style="padding:2px 8px; font-family:monospace;">${escapeHtml(fs.device)}</td>
          <td class="meta" style="padding:2px 8px;">${escapeHtml(fs.type)}</td>
          <td class="meta" style="padding:2px 0; text-align:right;">${fmtBytes(fs.usedBytes)} / ${fmtBytes(fs.totalBytes)}</td>
        </tr>`).join('')}
    </table>` : ''}

    ${(cur.power || (cur.runaways && cur.runaways.length)) ? `
    <div class="field-label">Power &amp; runaway processes</div>
    <div class="stat-row">
      ${cur.power && cur.power.packageWatts != null
        ? `<div class="stat"><strong>${cur.power.packageWatts.toFixed(1)} W</strong>package power${avg.powerPackageWatts != null ? ` (24h avg ${avg.powerPackageWatts.toFixed(1)} W)` : ''}</div>`
        : ''}
    </div>
    ${cur.power && cur.power.rails && cur.power.rails.length ? `
    <table style="width:100%; border-collapse:collapse; margin-top:6px;">
      ${cur.power.rails.map(r => `
        <tr><td class="meta" style="padding:2px 8px 2px 0;">${escapeHtml(r.name)}</td>
            <td class="meta" style="padding:2px 0;">${r.watts.toFixed(2)} W</td></tr>`).join('')}
    </table>` : ''}
    ${cur.runaways && cur.runaways.length ? `
    <table style="width:100%; border-collapse:collapse; margin-top:6px;">
      ${cur.runaways.map(a => `
        <tr><td class="meta" style="padding:2px 8px 2px 0; color:var(--bad);">pid ${a.pid}</td>
            <td class="meta" style="padding:2px 0;">${escapeHtml(a.headline)}</td></tr>`).join('')}
    </table>` : `<div class="meta" style="margin-top:6px;">No runaway processes detected.</div>`}
    ` : ''}

    ${cur.processes && cur.processes.length ? `
    <div class="field-label">Top processes by CPU</div>
    <table style="width:100%; border-collapse:collapse;">
      <tr><th class="meta" style="text-align:left; padding:2px 8px 2px 0;">Process</th>
          <th class="meta" style="text-align:right; padding:2px 8px;">PID</th>
          <th class="meta" style="text-align:right; padding:2px 8px;">CPU</th>
          <th class="meta" style="text-align:right; padding:2px 8px;">RAM</th>
          <th class="meta" style="text-align:right; padding:2px 8px;">Threads</th>
          <th class="meta" style="text-align:right; padding:2px 8px;">GPU</th>
          <th class="meta" style="text-align:left; padding:2px 0;">User / scope</th></tr>
      ${cur.processes.map(p => `
        <tr>
          <td class="meta" style="padding:2px 8px 2px 0;">${escapeHtml(p.name)}</td>
          <td class="meta" style="padding:2px 8px; text-align:right;">${p.pid}</td>
          <td class="meta" style="padding:2px 8px; text-align:right;">${fmtPercent(p.cpuPercent)}</td>
          <td class="meta" style="padding:2px 8px; text-align:right;">${fmtBytes(p.rssBytes)}</td>
          <td class="meta" style="padding:2px 8px; text-align:right;">${p.threads}</td>
          <td class="meta" style="padding:2px 8px; text-align:right;">${p.gpuPercent ? fmtPercent(p.gpuPercent) : '-'}</td>
          <td class="meta" style="padding:2px 0;">${escapeHtml(p.user || '-')} &middot; ${escapeHtml(p.scopeLabel || '-')}</td>
        </tr>`).join('')}
    </table>` : ''}

    <div class="meta" style="margin-top:14px">${history.length} sample${history.length === 1 ? '' : 's'} in the last 24h &middot; sampled every 10s.</div>
  `;
}

async function renderMain() {
  try {
    if (activeTab === 'workers') await renderWorkers(true);
    else if (activeTab === 'hardware') await renderHardwareTab();
    else if (activeTab === 'models') await renderModelsTab();
    else if (activeTab === 'joblist') await renderJobListTab();
    else if (activeTab === 'plugins') await renderPluginsTab();
    else if (activeTab === 'deepdive') await renderDeepDiveTab();
    else if (activeTab === 'discovery') await renderDiscoveryTab();
    else if (activeTab === 'branches') await renderBranchesTab();
    else if (activeTab === 'reports') await renderReportsTab();
    else if (activeTab === 'tokenfold') await renderTokenfoldTab();
    else if (activeTab === 'promptforge') await renderPromptForgeTab();
    else if (activeTab === 'adforge') await renderAdForgeTab();
    else if (activeTab === 'scriptforge') await renderScriptForgeTab();
    else if (activeTab === 'adhoc') await renderAdhocTasksTab();
    else if (activeTab === 'concepts') await renderConceptsTab();
    else await renderQueueTab(activeTab);
  } catch (e) {
    document.getElementById('main').innerHTML = `<div class="empty">Error loading data: ${e.message}</div>`;
  }
}

async function refresh() {
  try {
    counts = await fetchJson('/api/summary');
    document.getElementById('pipeline-status').textContent = 'connected';
  } catch (e) {
    document.getElementById('pipeline-status').textContent = 'disconnected';
  }
  renderNav();
  // Project and Brain Dump tabs manage their own rendering (enter*Tab/leave*Tab) so a
  // user's in-progress folder browsing or a half-typed capture note isn't wiped out by
  // this generic 5s cycle -- only the nav badge counts above still update while open.
  // promptforge / adforge / scriptforge are embedded iframes -- re-running
  // renderMain() every 5s would rebuild them and reload the app out from under the
  // user's inputs, same reason project / brain-dump opt out here.
  // concepts (2026-09-06): confirmed live -- a "View timeline" click could lose the
  // race against this same 5s cycle rebuilding the tab's DOM via innerHTML mid-click,
  // silently discarding the interaction with no error. Same class of bug Brain Dump's
  // own opt-out already exists to prevent; re-entering the tab still re-fetches once.
  if (!['project', 'brain-dump', 'promptforge', 'adforge', 'scriptforge', 'concepts'].includes(activeTab)) renderMain();
}

function escapeAttr(s) { return String(s).replace(/"/g, '&quot;'); }
