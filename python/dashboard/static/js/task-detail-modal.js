function renderDraftAttempts(task) {
  const attempts = Array.isArray(task.draftAttempts) ? task.draftAttempts : [];
  if (!attempts.length) return '';

  const tierBlock = (t) => {
    const verdict = t.resolution
      ? `resolution=${t.resolution}`
      : (t.applied === true ? 'applied' : t.applied === false ? 'declined' : (t.blocked ? 'blocked' : '?'));
    let h = `<div class="da-tier"><span class="da-tier-name">${escapeHtml(t.tier)}</span> `
      + `<span class="meta">${escapeHtml(verdict)}`
      + (t.turnsUsed != null ? ` · ${t.turnsUsed} turn(s)` : '')
      + `</span>`;
    if (t.reason) h += `<div class="meta">${escapeHtml(t.reason)}</div>`;
    if (t.toolCalls) {
      const tc = t.toolCalls;
      const byTool = Object.entries(tc.byTool || {}).map(([k, v]) => `${k}×${v}`).join(', ');
      h += `<div class="da-tools">${tc.total} tool call(s)${byTool ? ` — ${escapeHtml(byTool)}` : ''}`
        + `${tc.errors ? ` · ${tc.errors} error(s)` : ''}${tc.listTruncated ? ' · list truncated' : ''}</div>`;
      // Per-call skeleton (tool + arg keys + result size) -- kept on the attempt record
      // forever, unlike the full Work Log below which is pruned once the task reaches done/.
      if (Array.isArray(tc.calls) && tc.calls.length) {
        h += `<div class="da-tools">` + tc.calls.map((c) =>
          `#${c.n != null ? c.n : '?'} ${escapeHtml(c.tool)}(${(c.argKeys || []).map(escapeHtml).join(', ')}) → ${c.bytes} B${c.error ? ' ERR' : ''}`
        ).join('<br>') + (tc.listTruncated ? '<br>…' : '') + `</div>`;
      }
    }
    if (t.response) {
      h += `<div class="meta">response${t.responseChars ? ` (${t.responseChars} chars)` : ''}:</div>`
        + `<pre>${escapeHtml(t.response)}</pre>`;
    }
    if (t.rawDiff) {
      h += `<div class="meta">captured worktree diff${t.rawDiffChars ? ` (${t.rawDiffChars} chars)` : ''}:</div>`
        + `<pre>${escapeHtml(t.rawDiff)}</pre>`;
    }
    return h + `</div>`;
  };

  const one = (a) => {
    const when = a.at ? new Date(a.at).toLocaleString() : '';
    const outcome = a.outcome || '?';
    const summary = `<summary>#${a.attemptNo} · <span class="da-outcome-${escapeHtml(outcome)}">${escapeHtml(outcome)}</span>`
      + `${a.blockedReason ? ` — ${escapeHtmlBright(String(a.blockedReason).slice(0, 120))}` : ''}`
      + ` <span class="meta">${escapeHtml(when)}</span></summary>`;

    if (a.collapsed) {
      const tiers = (a.tiers || []).map((t) => `${t.tier}=${t.resolution || (t.applied ? 'applied' : 'declined')}`).join(' → ');
      return `<details class="draft-attempt">${summary}<div class="da-body meta">`
        + `plan ${a.planChars || 0} chars${a.planDegenerate ? ` (degenerate: ${escapeHtml(a.planDegenerate)})` : ''}`
        + `${tiers ? ` · tiers: ${escapeHtml(tiers)}` : ''}`
        + ` <em>(older attempt — full detail collapsed)</em></div></details>`;
    }

    let body = `<div class="da-body">`;
    if (a.source || a.localRejectCount) {
      body += `<div class="meta">source=${escapeHtml(a.source || '?')}`
        + `${a.localRejectCount ? ` · localRejectCount=${a.localRejectCount}` : ''}`
        + `${a.adhocResolution ? ` · adhocResolution=${escapeHtml(a.adhocResolution)}` : ''}</div>`;
    }
    if (a.plan) {
      if (a.plan.degenerate) {
        body += `<div class="field-label">Plan</div><pre class="meta">(degenerate: ${escapeHtml(a.plan.degenerate)})</pre>`;
      } else {
        body += `<div class="field-label">Plan${a.plan.chars ? ` (${a.plan.chars} chars` : ''}`
          + `${a.plan.attempts != null ? `, ${a.plan.attempts} attempt(s)` : ''}${a.plan.chars ? ')' : ''}</div>`
          + `<pre>${escapeHtml(a.plan.text || '')}</pre>`;
      }
    }
    if (a.implement) {
      const im = a.implement;
      body += `<div class="field-label">Implement</div>`;
      if (im.degenerate) body += `<pre class="meta">(degenerate: ${escapeHtml(im.degenerate)})</pre>`;
      else {
        if (im.note) body += `<div class="meta">${escapeHtml(im.note)}</div>`;
        if (im.text) body += `<pre>${escapeHtml(im.text)}</pre>`;
        else if (!im.note) body += `<pre class="meta">(empty)</pre>`;
      }
    }
    if (a.critique) {
      body += `<div class="meta">critique: ${escapeHtml(a.critique.outcome || '?')}${a.critique.revised ? ', revised' : ''}</div>`;
    }
    if (a.tiers && a.tiers.length) {
      body += `<div class="field-label">Implement Tiers</div>${a.tiers.map(tierBlock).join('')}`;
    }
    if (a.reason) body += `<div class="field-label">Error</div><div class="meta da-outcome-error">${escapeHtml(a.reason)}</div>`;
    return `<details class="draft-attempt">${summary}${body}</div></details>`;
  };

  const rows = attempts.slice().reverse().map(one).join('');
  return `<div class="field-label">Draft Attempts (${attempts.length})</div>${rows}`;
}

function renderWorkLog(task) {
  const wl = task._workLog;
  if (!wl || !Array.isArray(wl.tiers) || !wl.tiers.length) return '';
  const preMerge = ['approved', 'needs-review', 'blocked', 'awaiting-confirm'].includes(task.status);
  const totalCalls = wl.tiers.reduce((n, t) => n + ((t.calls && t.calls.length) || 0), 0);

  const callRow = (c) => {
    const argStr = Object.entries(c.args || {}).map(([k, v]) => {
      const s = String(v);
      return `${escapeHtml(k)}=${escapeHtml(s.length > 200 ? s.slice(0, 200) + '…' : s)}`;
    }).join(', ');
    const head = `<span class="wl-n">#${c.n}</span> <span class="wl-tool">${escapeHtml(c.tool)}</span>(${argStr})`
      + ` <span class="meta">→ ${c.resultBytes} B${c.error ? ' · ERROR' : ''}</span>`;
    if (!c.resultPreview) return `<div class="wl-call${c.error ? ' wl-err' : ''}">${head}</div>`;
    return `<details class="wl-call${c.error ? ' wl-err' : ''}"><summary>${head}</summary>`
      + `<pre>${escapeHtml(c.resultPreview)}</pre></details>`;
  };

  const tierBlocks = wl.tiers.map((t) => {
    const n = (t.calls && t.calls.length) || 0;
    return `<div class="wl-tier"><div class="meta">${escapeHtml(t.tier)}`
      + `${t.turnsUsed != null ? ` · ${t.turnsUsed} turn(s)` : ''} · ${n} tool call(s)`
      + `${t.truncated ? ' · older calls trimmed for size' : ''}</div>`
      + (t.calls || []).map(callRow).join('') + `</div>`;
  }).join('');

  return `<details class="work-log"${preMerge ? ' open' : ''}>`
    + `<summary><span class="field-label">Work Log</span> `
    + `<span class="meta">${totalCalls} tool call(s) across ${wl.tiers.length} tier(s)</span></summary>`
    + tierBlocks + `</details>`;
}

function taskLink(id) {
  return `<a href="#" class="task-jump" data-open-task-anywhere="${escapeAttr(id)}"><code>${escapeHtml(id)}</code></a>`;
}

function renderForensicsStudyBlock(task) {
  if (task.source !== 'pipeline_forensics') return '';
  const pc = task.promptContext || {};
  const losers = Array.isArray(pc.loserIds) ? pc.loserIds : [];
  const winners = Array.isArray(pc.winnerIds) ? pc.winnerIds : [];
  let html = `<div class="field-label">Forensic Study</div><div>`;
  html += `<span class="meta">Trigger: ${escapeHtml(pc.triggerType || '?')}`;
  if (pc.signature) html += ` &middot; Signature: <code>${escapeHtml(pc.signature)}</code>`;
  if (pc.subjectKind && pc.subjectKey && pc.subjectKey !== pc.signature) html += ` &middot; Subject: ${escapeHtml(pc.subjectKind)} <code>${escapeHtml(pc.subjectKey)}</code>`;
  html += `</span>`;
  if (losers.length) html += `<div style="margin-top:6px"><strong>Failing tasks studied (${losers.length}):</strong><br>${losers.map(taskLink).join('<br>')}</div>`;
  if (winners.length) html += `<div style="margin-top:6px"><strong>Contrast set — tasks that SUCCEEDED (${winners.length}):</strong><br>${winners.map(taskLink).join('<br>')}</div>`;
  html += `</div>`;
  return html;
}

function renderHarnessHits(task) {
  const pc = task.promptContext || {};
  const hits = Array.isArray(pc.harnessHits) ? pc.harnessHits : [];
  if (!hits.length) return '';
  const rows = hits.map((h) => `<div class="wl-call">`
    + `<code>${escapeHtml(h.file || '?')}${h.line != null ? ':' + h.line : ''}</code>`
    + (h.query ? ` <span class="meta">(query "${escapeHtml(h.query)}")</span>` : '')
    + (h.text ? `<pre style="margin:2px 0">${escapeHtml(h.text)}</pre>` : '')
    + `</div>`).join('');
  return `<details class="work-log"><summary><span class="field-label">Harness Hits</span> `
    + `<span class="meta">${hits.length} match(es) in this repo's own code</span></summary>${rows}</details>`;
}

function renderEvidenceBundle(task) {
  const pc = task.promptContext || {};
  const ev = typeof pc.evidenceText === 'string' ? pc.evidenceText.trim() : '';
  if (!ev) return '';
  return `<details class="work-log"><summary><span class="field-label">Evidence Bundle</span> `
    + `<span class="meta">${ev.length.toLocaleString()} chars — what the study reasoned over</span></summary>`
    + `<pre>${escapeHtml(ev)}</pre></details>`;
}

function renderSubTaskChecklist(task) {
  const subs = Array.isArray(task.subTasks) ? task.subTasks : [];
  if (!subs.length) return '';
  const total = task.progress && task.progress.total != null ? task.progress.total : subs.length;
  const done = task.progress && task.progress.done != null ? task.progress.done : 0;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const rows = subs.map((st) => {
    const [cls, label] = SUBTASK_STATUS_META[st.status] || ['idle', st.status || 'pending'];
    return `<div class="task-history-row"><span class="badge ${cls}">${escapeHtml(label)}</span> `
      + `${taskLink(st.id)} ${escapeHtmlBright(st.title || '')}</div>`;
  }).join('');
  return `<div class="field-label">Sub-tasks (${done} / ${total})</div>`
    + `<div class="bar-track" style="margin:2px 0 8px"><div class="bar-fill" style="width:${pct}%; background:var(--ok)"></div></div>`
    + `<div class="task-history">${rows}</div>`;
}

function renderRelatedTasks(task) {
  const outgoing = Array.isArray(task._outgoingLinks) ? task._outgoingLinks : [];
  const incoming = Array.isArray(task._incomingLinks) ? task._incomingLinks : [];
  if (!outgoing.length && !incoming.length) return '';
  const row = (id, type, label) =>
    `<div class="task-history-row">${taskLink(id)} <span class="meta">${escapeHtml(type)}${label ? ` — ${escapeHtmlBright(label)}` : ''}</span></div>`;
  let html = `<div class="field-label">Related Tasks</div><div class="task-history">`;
  if (outgoing.length) {
    html += `<div class="meta" style="margin:4px 0 2px">Links to</div>`
      + outgoing.map((l) => row(l.targetId, l.type, l.label)).join('');
  }
  if (incoming.length) {
    html += `<div class="meta" style="margin:6px 0 2px">Linked from</div>`
      + incoming.map((l) => row(l.sourceId, l.type, l.label)).join('');
  }
  html += `</div>`;
  return html;
}

function renderTaskDetailModal(task) {
  const backdrop = document.getElementById('modal-backdrop');
  const content = document.getElementById('modal-content');
  let html = `<button class="close" onclick="closeDetail()">&times;</button><h2>${task.id}</h2>`;
  // "Send to Chat" (2026-09-01) -- dumps this task's key context into the System Chat
  // panel as a user message (via sendTextToChat -> POST /api/chat/inject, no model call)
  // so a follow-up can be had about it. Button sits in the modal's top action area, same
  // .secondary style as Discuss/Edit/Delete. Wired below (task-send-to-chat) rather than
  // inlined so the multi-line payload isn't quote-escaping trouble in an onclick string.
  // Premium Priority toggle (2026-09-07, Grimmethy: "I'll need a way in app to be able
  // to set that premium priority slot for any specific task. I am getting tired of
  // manually selecting it for the worker queue every pass.") -- POSTs
  // /api/task-anywhere/<id>/premium-priority, which finds the task wherever it currently
  // sits (pending/blocked/needs-clarification/drafting/adhoc) and stamps/clears
  // task.premiumPriority; next-claimable-task.js's effectivePriority() then sorts it
  // ahead of EVERY other task, every tick, until this is turned off again or the task
  // reaches done -- unlike the Workers tab's per-instance assign-task pin (one-shot,
  // cleared the moment it's claimed), this is meant to be "set once, forget it."
  const premiumOn = !!task.premiumPriority;
  html += `<div style="margin:8px 0 4px">`
    + `<button type="button" class="secondary" id="task-send-to-chat">Send to Chat</button> `
    + `<button type="button" class="${premiumOn ? 'action' : 'secondary'}" id="task-premium-priority" title="${premiumOn ? 'Currently claimed ahead of everything else in the queue, every pass, until turned off or the task completes. Click to turn off.' : 'Always claim this task first, every pass, regardless of source or age -- stays on until you turn it off or the task completes.'}">${premiumOn ? '★ Premium Priority (on)' : '☆ Set Premium Priority'}</button>`
    + `</div>`;
  if (task._foundState) html += `<div class="field-label">Queue State</div><div>${escapeHtml(task._foundState)}</div>`;
  html += `<div><strong>${escapeHtmlBright(task.title || '')}</strong></div>`;
  // Hub back-link (2026-09-06, Grimmethy: "when a task is a sub-task of a hub I should be
  // able to click into the hub task from the top of the sub task's task log") -- the
  // inverse of renderSubTaskChecklist just below (which shows a hub's children): a
  // decomposed sub-task's promptContext.decomposedFrom already names its owning hub's id
  // (file-decompose-to-hub.js, applyAdhocDiff's own decompose path), but nothing ever
  // surfaced it -- a human landing on a stuck sub-task (like the stacked file-decompose
  // incident this same night) had no one-click way back to the hub coordinating it.
  // taskLink() + the existing data-open-task-anywhere delegation below already do the
  // rest -- the hub could be in coordinating/, done/, or blocked/, so this doesn't guess.
  if (task.promptContext && task.promptContext.decomposedFrom) {
    html += `<div class="field-label">Part of Hub</div><div>${taskLink(task.promptContext.decomposedFrom)}</div>`;
  }
  html += renderSubTaskChecklist(task);
  html += renderRelatedTasks(task);
  // Task metadata (2026-08-26, Grimmethy: "At the top of every task I'd like to see a
  // bit of meta data. How much machine time was spent on the task and a list of all the
  // files it touched") -- totalLatencyMs sums real wall-clock time across every model
  // call this task made (see _task_cost_summary's own comment: recorded for local Ollama
  // calls the same as Claude ones, unlike totalCostUsd which is $0, not absent, for an
  // all-local task). _filesTouched is server-computed from whichever shape this task's
  // actual on-disk change came in (a unified diff, or a Group B JSON change list) --
  // empty for a task that never wrote to the filesystem at all (a verdict-only audit, a
  // split proposal), not an error.
  if (task._costSummary && task._costSummary.totalLatencyMs != null) {
    html += `<div class="field-label">Machine Time</div><div>${fmtDuration(task._costSummary.totalLatencyMs / 1000)} across ${task._costSummary.totalCalls} model call(s)</div>`;
  }
  if (task._filesTouched) {
    const filesLabel = task._filesTouched.length
      ? task._filesTouched.map(f => `<code>${escapeHtml(f)}</code>`).join('<br>')
      : '<span class="meta">no files touched</span>';
    html += `<div class="field-label">Files Touched (${task._filesTouched.length})</div><div>${filesLabel}</div>`;
  }
  // Estimated Anthropic API cost for this ONE task (2026-08-23, Grimmethy: "We should
  // include estimated cost tracking in the job page itself") -- api_task_detail/
  // api_task_anywhere sum every model_calls row for this task_id server-side (a task can
  // carry several real calls: plan, implement, critique, revision), since task.abCallId
  // on the task itself only ever holds the MOST RECENT one. _costSummary is null (not a
  // zeroed object) when the db/column isn't available or no calls exist yet for this
  // task at all -- shown only when there's something real to show.
  if (task._costSummary) {
    const cs = task._costSummary;
    // hypotheticalCostUsd (2026-08-23, Grimmethy: "Clarification on the anthropic
    // costs. I'd like estimates for if we had used the API. Even if we used the local
    // models.") -- unlike totalCostUsd (real spend, $0 for an all-local task), this is
    // always a real number: what THIS task would have cost had every one of its calls,
    // local or not, gone through the API.
    const realLabel = cs.totalCostUsd > 0
      ? `${fmtUsd(cs.totalCostUsd)} real (${cs.callsWithCost}/${cs.totalCalls} call(s) via Claude)`
      : `$0 real -- all ${cs.totalCalls} call(s) ran locally`;
    const hLabel = cs.hypotheticalCostUsd != null ? ` · ${fmtUsd(cs.hypotheticalCostUsd)} est. if every call had used the API` : '';
    html += `<div class="field-label">Estimated API Cost</div><div>${realLabel}${hLabel}</div>`;
  }
  // Request / Input (2026-08-30, Grimmethy: "I get no indication of what actually
  // happened") -- the task's actual INPUT (what the model was asked to act on). Different
  // sources stash it under different promptContext keys; app.py's _task_input_summary
  // normalises them into a [{label, text}] list so a blocked product_spec task shows its
  // ~2KB request brief (promptContext.requestText) instead of just a truncated title.
  if (task._requestInput && task._requestInput.length) {
    for (const item of task._requestInput) {
      html += `<div class="field-label">${escapeHtml(item.label)}</div><pre>${escapeHtml(item.text)}</pre>`;
    }
  }
  html += `<div class="field-label">Domain / Source</div><div>${task.domain || ''} / ${task.source || ''}</div>`;
  if (task.blockedReason) html += `<div class="field-label">Blocked Reason</div><div style="color:var(--bad)">${escapeHtmlBright(task.blockedReason)}</div>`;
  if (task.branch) html += `<div class="field-label">Branch</div><div>${task.branch}</div>`;
  if (task.promptContext && task.promptContext.prefetchedPaths && task.promptContext.prefetchedPaths.length) {
    html += `<div class="field-label">Prefetched Paths</div><div>${task.promptContext.prefetchedPaths.map(p => `<code>${escapeHtml(p)}</code>`).join('<br>')}</div>`;
  }
  // staleness_audit (2026-08-22, Grimmethy: "I don't have information in the task page
  // about when it was actually set up. The pipeline history only shows the newest
  // staleness audit. All previous steps are missing.") -- this task's OWN
  // task.history[] only ever covers its own short life (created -> drafted -> reviewed);
  // the thing a human actually needs to judge "is this really stale" is the ORIGINAL
  // flagged task's own dates, which staleness-audit.js now stamps as structured fields
  // (originalTitle/originalCreatedAt/originalLastActivityAt) specifically so this can
  // render them directly instead of leaving them buried in evidenceText's prose (which
  // only the drafting MODEL ever reads).
  if (task.source === 'staleness_audit' && task.promptContext && task.promptContext.originalTaskId) {
    const pc = task.promptContext;
    html += `<div class="field-label">Original Flagged Task</div><div>`
      + `<code>${escapeHtml(pc.originalTaskId)}</code>`
      + (pc.originalTitle ? `<br>${escapeHtml(pc.originalTitle)}` : '')
      + `<br><span class="meta">Created: ${pc.originalCreatedAt ? new Date(pc.originalCreatedAt).toLocaleString() : 'unknown'}`
      + ` &middot; Last activity: ${pc.originalLastActivityAt ? new Date(pc.originalLastActivityAt).toLocaleString() : 'unknown'}</span>`
      + (pc.reasons && pc.reasons.length ? `<br><span class="meta">Flagged: ${pc.reasons.map(escapeHtml).join(', ')}</span>` : '')
      + `</div>`;
  }
  html += renderForensicsStudyBlock(task);
  // For advisoryProse sources (pipeline_forensics) the deliverable IS implementResponse --
  // a root-cause report, not a diff. Rendered dead last under a generic "Implement" label,
  // it reads as buried; hoist it right below the study framing so the modal leads with the
  // conclusion. The bottom-of-modal block is then skipped (reportShown).
  let reportShown = false;
  if (PROSE_REPORT_SOURCES.has(task.source) && task.implementResponse) {
    html += `<div class="field-label">Root-Cause Report</div><pre>${escapeHtmlBright(task.implementResponse)}</pre>`;
    reportShown = true;
  }
  if (task.needsClarification) html += renderClarificationPicker(task);
  // Pipeline History: task.history[] (task-history.js's appendHistoryEvent -- see that
  // module for the schema). Was written correctly the whole time this session but never
  // rendered anywhere in the app -- the data existed only if you went and read the raw
  // task JSON off disk yourself, which defeats the point of a per-step timeline being a
  // dashboard feature at all. Entries come in two shapes: older ones only ever have
  // `status` (no `stage`, no `detail`) from before task-history.js existed -- render both
  // so a task whose life started before this feature shipped doesn't just show a gap.
  if (task.history && task.history.length) {
    const liveBadge = TASK_DETAIL_LIVE_STATES.has(task._foundState || '')
      ? ` <span class="meta" title="this task is mid-pass; new steps appear here automatically">● live</span>` : '';
    html += `<div class="field-label">Pipeline History${liveBadge}</div><div class="task-history">`;
    html += task.history.map(h => {
      const label = h.stage || h.status || '?';
      const when = h.at ? new Date(h.at).toLocaleString() : '';
      const detail = h.detail || h.note || '';
      return `<div class="task-history-row"><span class="task-history-stage">${escapeHtml(label)}</span> `
        + `<span class="meta">${escapeHtml(when)}</span>`
        + (detail ? `<div class="meta">${escapeHtml(detail)}</div>` : '')
        + `</div>`;
    }).join('') + `</div>`;
  }
  // Draft Attempts: one collapsible record per draftTask() run (draft-attempt-record.js).
  // task.planResponse / task.implementResponse below only ever show the LAST run; this is
  // the per-attempt history -- every earlier plan, every tier's decline reason + response,
  // every tier-3 worktree diff -- so following up on a task that failed N times no longer
  // means re-investigating from scratch.
  html += renderDraftAttempts(task);
  html += renderWorkLog(task);
  html += renderHarnessHits(task);
  html += renderEvidenceBundle(task);
  // A "degenerate: empty" block means the model returned nothing for that pass -- the
  // field is absent, not present-and-empty, so without this the modal just omits the
  // section and the timeline is the only hint anything ran. Say it explicitly.
  const emptyPlan = !task.planResponse && /plan pass degenerate/i.test(task.blockedReason || '');
  const emptyImpl = !task.implementResponse && /implement pass degenerate/i.test(task.blockedReason || '');
  if (task.planResponse) html += `<div class="field-label">Plan</div><pre>${escapeHtmlBright(task.planResponse)}</pre>`;
  else if (emptyPlan) html += `<div class="field-label">Plan</div><pre class="meta">(the plan pass returned an empty response — nothing was drafted; see Blocked Reason above)</pre>`;
  if (task.implementResponse && !reportShown) html += `<div class="field-label">Implement</div><pre>${escapeHtmlBright(task.implementResponse)}</pre>`;
  else if (emptyImpl) html += `<div class="field-label">Implement</div><pre class="meta">(the implement pass returned an empty response — nothing was drafted; see Blocked Reason above)</pre>`;
  content.innerHTML = html;
  backdrop.classList.add('open');
  // Jump to another task from an in-modal link (the forensic study's failing/winner ids) --
  // same delegated pattern the Recent Tasks / Workers lists use.
  content.querySelectorAll('[data-open-task-anywhere]').forEach((link) => {
    link.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openTaskAnywhere(link.dataset.openTaskAnywhere); };
  });
  if (task.needsClarification) wireClarificationPicker(task.id);
  // "Send to Chat" button handler (declared in the modal HTML above). 2026-09-07: used
  // to dump this task's title/source/blockedReason/request/plan/implement text into the
  // System Chat panel as one user message -- measured live at ~13k chars / a real
  // 10,713-token first turn (65% of the local chat's 16,384-token window,
  // instances/context-budget-audit.log), most of which the conversation often never
  // needed. Now injects just the id + title; the model has real lookup tools
  // (read_task/search_tasks, local-tool-client.js) to pull the rest -- summary first,
  // then one specific section (plan/implement/history/blockedReason) only if a question
  // actually needs it -- instead of paying for the whole blob on every single click. See
  // concept-send-to-chat-307f1b's research for the two gaps this closes (no lookup tool
  // existed, no search existed) and the plan behind this change.
  const taskSendToChatBtn = document.getElementById('task-send-to-chat');
  if (taskSendToChatBtn) {
    taskSendToChatBtn.onclick = async () => {
      taskSendToChatBtn.disabled = true;
      try {
        const parts = [`# ${task.id}`];
        if (task.title) parts.push('title: ' + task.title);
        await sendTextToChat(parts.join('\n\n')); // POSTs, expands the panel, re-renders; throws on !ok
        try { chatSession = await fetchJson('/api/chat/active'); chatRender(); } catch (e) { /* leave the panel as-is */ }
        showToast('Sent to chat', 'info');
      } catch (e) {
        showToast('Could not send to chat: ' + e.message);
      } finally {
        taskSendToChatBtn.disabled = false;
      }
    };
  }
  const taskPremiumPriorityBtn = document.getElementById('task-premium-priority');
  if (taskPremiumPriorityBtn) {
    taskPremiumPriorityBtn.onclick = async () => {
      taskPremiumPriorityBtn.disabled = true;
      try {
        const nextEnabled = !premiumOn;
        const res = await fetch(`/api/task-anywhere/${encodeURIComponent(task.id)}/premium-priority`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: nextEnabled }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        showToast(nextEnabled ? 'Premium priority set -- claimed first every pass until you turn it off' : 'Premium priority cleared', 'info');
        task.premiumPriority = nextEnabled;
        renderTaskDetailModal(task); // re-render in place so the button flips state immediately, no full reopen
      } catch (e) {
        showToast('Could not update premium priority: ' + e.message);
        taskPremiumPriorityBtn.disabled = false;
      }
    };
  }
  armTaskDetailAutoRefresh(task);
}

function stopTaskDetailAutoRefresh() {
  if (taskDetailPoll) { clearInterval(taskDetailPoll); taskDetailPoll = null; }
}

function armTaskDetailAutoRefresh(task) {
  stopTaskDetailAutoRefresh();
  const state = task._foundState || '';
  if (!TASK_DETAIL_LIVE_STATES.has(state)) return;
  const id = task.id;
  let lastSig = `${state}:${(task.history || []).length}`;
  taskDetailPoll = setInterval(async () => {
    const backdrop = document.getElementById('modal-backdrop');
    if (!backdrop || !backdrop.classList.contains('open')) { stopTaskDetailAutoRefresh(); return; }
    let fresh;
    try {
      fresh = await fetchJson(`/api/task-anywhere/${encodeURIComponent(id)}`);
    } catch (e) {
      return; // transient -- try again next tick
    }
    const sig = `${fresh._foundState || ''}:${(fresh.history || []).length}`;
    if (sig !== lastSig) {
      lastSig = sig;
      renderTaskDetailModal(fresh); // re-arms (or stops, if it landed in a terminal state)
    }
  }, 4000);
}

function renderDesignDecisionPicker(task) {
  const nc = task.needsClarification;
  let html = `<div class="field-label">⚠ Needs a Human Decision</div>`;
  html += `<div class="meta">The agentic draft investigated this for real and has genuine open questions it shouldn't guess at:</div>`;
  html += `<div class="grill-session" style="margin-top:8px; white-space:pre-wrap">${escapeHtmlBright(nc.openQuestions || '')}</div>`;

  // Multiple-choice shortcut (2026-08-24, Grimmethy: "build in some multiple choice
  // options into the task log... reduce the friction caused by pausing the pipeline to
  // set up a chat") -- nc.options is only ever present when the draft offered a clean
  // 2+ option OPTIONS block (see adhoc-agentic-draft.js's parseClarificationOptions);
  // absent for older held tasks drafted before this feature, or when the model judged
  // the real answer space too open-ended for multiple choice. Either way, the free-text
  // "Other" box below is always available as the universal fallback.
  if (nc.options && nc.options.length) {
    html += `<div style="margin-top:10px"><strong>Pick one:</strong></div>`;
    html += `<div style="margin-top:6px;display:flex;flex-direction:column;gap:6px">`;
    html += nc.options.map((o, i) => `
      <button type="button" class="secondary clarify-answer-option-btn" data-answer="${escapeAttr(`${o.label}: ${o.description}`)}" style="text-align:left;padding:8px 10px">
        <strong>${escapeHtml(o.label)}</strong><br><span class="meta">${escapeHtmlBright(o.description)}</span>
      </button>`).join('');
    html += `</div>`;
  }
  html += `<div style="margin-top:10px"><strong>${nc.options && nc.options.length ? 'Other:' : 'Your answer:'}</strong></div>`;
  html += `<div style="margin-top:6px"><textarea id="clarify-answer-other" rows="3" style="width:100%;background:var(--panel);border:2px solid var(--border);color:var(--text);padding:6px 8px;border-radius:6px;font-family:inherit;font-size:13px" placeholder="Type your decision here -- this gets folded directly into the task's instructions, same as ending a Discuss session would."></textarea></div>`;
  html += `<div style="margin-top:8px"><button type="button" class="action" id="clarify-answer-submit-btn">Submit &amp; Send to Drafting</button> <button type="button" class="secondary" id="clarify-discuss-btn">Discuss instead</button> ${renderProviderToggle('clarify-discuss-provider')}</div>`;
  html += `<div id="clarify-discuss-panel" style="margin-top:10px"></div>`;
  return html;
}

function renderClarificationPicker(task) {
  // 2026-08-24 (Grimmethy: "I'd like to see this discuss option default to using the
  // local reasoning model, not claude") -- providerChoices is a single global keyed by
  // the DOM id, and clarify-discuss-provider is the SAME id reused for every task's
  // modal. Without this reset, toggling to Claude once for any task left it stuck as the
  // default for every OTHER task's Discuss button afterward too, silently defeating the
  // "starts on local" default both this toggle and _discuss_provider_args() otherwise
  // already have. Force it back to local every time a task's detail view is (re)built,
  // so only an explicit click within THIS task's own session ever picks Claude.
  const nc = task.needsClarification;
  providerChoices['clarify-discuss-provider'] = 'local';
  if (nc.reason === 'design-decision') return renderDesignDecisionPicker(task);
  let html = `<div class="field-label">⚠ Needs Clarification</div>`;
  // LLM-assisted fallback suggestion (path_prefetch_resolve, hybrid design 2026-08-16) --
  // shown FIRST and most prominent, since accepting it is the one-click path that's the
  // whole point of the hybrid: still a human decision (never auto-applied), just a much
  // faster one than manually knowing the codebase. Sits above the raw candidate/manual
  // options below it, which stay available as a fallback if the suggestion is wrong.
  if (nc.suggested) {
    const s = nc.suggested;
    const confidenceLabel = s.confident ? 'confident' : 'best guess';
    if (s.paths && s.paths.length) {
      html += `<div class="grill-session" style="margin-top:8px;border:1px solid var(--warn)">`;
      html += `<div class="field-label">Suggested (${confidenceLabel})</div>`;
      html += `<div>${s.paths.map(p => `<code>${escapeHtml(p)}</code>`).join('<br>')}</div>`;
      if (s.rationale) html += `<div class="meta" style="margin-top:6px">${escapeHtmlBright(s.rationale)}</div>`;
      html += `<button type="button" class="action clarify-accept-suggestion-btn" data-suggested-paths="${escapeAttr(JSON.stringify(s.paths))}" style="margin-top:8px">Accept Suggestion</button>`;
      html += `</div>`;
    } else {
      html += `<div class="grill-session" style="margin-top:8px"><div class="field-label">Suggestion attempted</div><div class="meta">The model couldn't find a match either${s.rationale ? ': ' + escapeHtmlBright(s.rationale) : '.'}</div></div>`;
    }
  }
  if (nc.reason === 'ambiguous' && nc.candidates) {
    html += `<div class="meta">One or more keywords matched more than one file -- pick which one(s) belong:</div>`;
    for (const [keyword, files] of Object.entries(nc.candidates)) {
      html += `<div style="margin-top:6px"><strong>${escapeHtml(keyword)}</strong><br>`;
      html += files.map(f => `<button type="button" class="secondary clarify-pick-btn" data-path="${escapeAttr(f)}" style="margin:3px 6px 0 0">${escapeHtml(f)}</button>`).join('');
      html += `</div>`;
    }
  } else {
    html += `<div class="meta">No file in the project graph matched anything in this task's text. Type a path by hand, or proceed without one.</div>`;
  }
  html += `<div style="margin-top:10px"><input type="text" id="clarify-manual-path" placeholder="relative/path/to/file.ts" style="width:60%;background:var(--panel);border:2px solid var(--border);color:var(--text);padding:6px 8px;border-radius:6px;font-family:monospace;font-size:12px">`;
  html += `<button type="button" class="action" id="clarify-add-manual" style="margin-left:6px">Use This Path</button></div>`;
  html += `<div id="clarify-selected-paths" style="margin-top:8px"></div>`;
  html += `<div style="margin-top:10px"><button type="button" class="action" id="clarify-resolve-btn">Send to Drafting</button> <button type="button" class="secondary" id="clarify-skip-btn">Proceed Without Prefetch</button> <button type="button" class="secondary" id="clarify-discuss-btn">Discuss</button> ${renderProviderToggle('clarify-discuss-provider')}</div>`;
  html += `<div id="clarify-discuss-panel" style="margin-top:10px"></div>`;
  return html;
}

function clarifyDiscussRenderPanel(taskId, session) {
  const el = document.getElementById('clarify-discuss-panel');
  if (!el) return;
  const transcriptHtml = grillRenderTranscript(session.transcript, session);
  if (session.status === 'ended') {
    const actionHtml = session.summary
      ? `<div class="grill-enriched-badge">Added to task ✓ -- re-queued for another resolution attempt with this context.</div>`
      : `<div class="meta" style="margin-top:8px">Ended with nothing said -- task unchanged.</div>`;
    el.innerHTML = `<div class="grill-session"><div class="field-label">Discussion ended</div>${transcriptHtml}${actionHtml}</div>`;
  } else {
    el.innerHTML = `<div class="grill-session">${transcriptHtml}<textarea class="grill-answer" rows="3" placeholder="Say more... (Enter to send, Shift+Enter for a new line)"></textarea><div class="row" style="margin-top:8px"><button type="button" class="secondary" id="clarify-discuss-end">End Discussion</button><button type="button" class="action" id="clarify-discuss-send">Send</button></div></div>`;
    const answerEl = el.querySelector('.grill-answer');
    const sendBtn = el.querySelector('#clarify-discuss-send');
    const endBtn = el.querySelector('#clarify-discuss-end');
    const send = () => clarifyDiscussSend(taskId, session.id, answerEl.value, sendBtn);
    sendBtn.onclick = send;
    endBtn.onclick = () => clarifyDiscussEnd(taskId, session.id, endBtn);
    answerEl.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    };
    answerEl.focus();
  }
  const scrollEl = el.querySelector('.grill-transcript');
  if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
}

async function clarifyDiscussStart(taskId) {
  const el = document.getElementById('clarify-discuss-panel');
  try {
    const existing = await fetchJson('/api/task/needs-clarification/' + encodeURIComponent(taskId) + '/discuss/latest');
    if (existing && existing.status === 'active') {
      clarifyDiscussRenderPanel(taskId, existing);
      return;
    }
  } catch (e) { /* best-effort check -- fall through to starting normally */ }
  if (el) el.innerHTML = '<div class="empty">Starting discussion...</div>';
  try {
    const resp = await fetch('/api/task/needs-clarification/' + encodeURIComponent(taskId) + '/discuss/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(providerPayload('clarify-discuss-provider')),
    });
    const session = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(session.description || ('HTTP ' + resp.status));
    clarifyDiscussRenderPanel(taskId, session);
  } catch (e) {
    if (el) el.innerHTML = '';
    showToast('Could not start discussion: ' + e.message);
  }
}

async function clarifyDiscussSend(taskId, sessionId, message, btn) {
  if (!message || !message.trim()) return;
  btn.disabled = true;
  btn.textContent = 'Thinking...';
  try {
    const resp = await fetch('/api/discuss/' + encodeURIComponent(sessionId) + '/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    const session = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(session.description || ('HTTP ' + resp.status));
    clarifyDiscussRenderPanel(taskId, session);
  } catch (e) {
    showToast('Could not send message: ' + e.message);
    btn.disabled = false;
    btn.textContent = 'Send';
  }
}

async function clarifyDiscussEnd(taskId, sessionId, btn) {
  btn.disabled = true;
  btn.textContent = 'Ending...';
  try {
    const resp = await fetch('/api/discuss/' + encodeURIComponent(sessionId) + '/end', { method: 'POST' });
    const result = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(result.description || ('HTTP ' + resp.status));
    clarifyDiscussRenderPanel(taskId, result.session);
    // The held task was just re-opened for another resolution attempt server-side --
    // close the modal and refresh the list rather than leaving a stale picker open
    // against a task that's no longer in the state it shows.
    if (result.heldTask) {
      setTimeout(() => {
        closeDetail();
        if (activeTab === 'needs-clarification') renderQueueTab('needs-clarification');
      }, 1200);
    }
  } catch (e) {
    showToast('Could not end discussion: ' + e.message);
    btn.disabled = false;
    btn.textContent = 'End Discussion';
  }
}

function wireClarificationPicker(taskId) {
  const selected = [];
  const renderSelected = () => {
    const el = document.getElementById('clarify-selected-paths');
    if (!el) return;
    el.innerHTML = selected.length
      ? '<div class="meta">Selected: ' + selected.map(escapeHtml).join(', ') + '</div>'
      : '';
  };
  document.querySelectorAll('.clarify-pick-btn').forEach((btn) => {
    btn.onclick = () => {
      const p = btn.dataset.path;
      if (!selected.includes(p)) selected.push(p);
      btn.disabled = true;
      renderSelected();
    };
  });
  const manualInput = document.getElementById('clarify-manual-path');
  const addManualBtn = document.getElementById('clarify-add-manual');
  if (addManualBtn) {
    addManualBtn.onclick = () => {
      const p = (manualInput.value || '').trim();
      if (!p) return;
      if (!selected.includes(p)) selected.push(p);
      manualInput.value = '';
      renderSelected();
    };
  }
  const resolveBtn = document.getElementById('clarify-resolve-btn');
  if (resolveBtn) resolveBtn.onclick = () => resolveNeedsClarification(taskId, selected);
  const skipBtn = document.getElementById('clarify-skip-btn');
  if (skipBtn) skipBtn.onclick = () => resolveNeedsClarification(taskId, []);
  const acceptSuggestionBtn = document.querySelector('.clarify-accept-suggestion-btn');
  if (acceptSuggestionBtn) {
    acceptSuggestionBtn.onclick = () => {
      let paths = [];
      try { paths = JSON.parse(acceptSuggestionBtn.dataset.suggestedPaths || '[]'); } catch (e) { /* leave empty */ }
      resolveNeedsClarification(taskId, paths);
    };
  }
  const discussBtn = document.getElementById('clarify-discuss-btn');
  if (discussBtn) discussBtn.onclick = () => clarifyDiscussStart(taskId);
  wireProviderToggle('clarify-discuss-provider');
  document.querySelectorAll('.clarify-answer-option-btn').forEach((btn) => {
    btn.onclick = () => answerNeedsClarification(taskId, btn.dataset.answer);
  });
  const answerSubmitBtn = document.getElementById('clarify-answer-submit-btn');
  if (answerSubmitBtn) {
    answerSubmitBtn.onclick = () => {
      const text = (document.getElementById('clarify-answer-other').value || '').trim();
      if (!text) { alert('Type an answer first, or click one of the options above.'); return; }
      answerNeedsClarification(taskId, text);
    };
  }
  // Surface an existing (active or already-ended) discussion instead of leaving the
  // picker looking like nothing has been tried yet -- same "don't bury prior work"
  // reasoning as every other Discuss integration's own for-note/latest check.
  fetchJson('/api/task/needs-clarification/' + encodeURIComponent(taskId) + '/discuss/latest')
    .then((existing) => { if (existing) clarifyDiscussRenderPanel(taskId, existing); })
    .catch(() => { /* best-effort -- no prior session is the common case */ });
}

async function resolveNeedsClarification(taskId, paths) {
  try {
    const res = await fetch(`/api/task/needs-clarification/${encodeURIComponent(taskId)}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.description || `${res.status}`);
    }
    closeDetail();
    if (activeTab === 'needs-clarification') renderQueueTab('needs-clarification');
  } catch (e) {
    alert(`Could not resolve '${taskId}': ` + e.message);
  }
}

async function answerNeedsClarification(taskId, answer) {
  try {
    const res = await fetch(`/api/task/needs-clarification/${encodeURIComponent(taskId)}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.description || `${res.status}`);
    }
    closeDetail();
    if (activeTab === 'needs-clarification') renderQueueTab('needs-clarification');
  } catch (e) {
    alert(`Could not answer '${taskId}': ` + e.message);
  }
}

async function openDetail(state, id) {
  const task = await fetchJson(`/api/task/${state}/${encodeURIComponent(id)}`);
  // /api/task/<state>/<id> doesn't stamp _foundState (only task-anywhere does); carry the
  // state we already know so renderTaskDetailModal can decide whether to poll for updates.
  if (!task._foundState) task._foundState = state;
  renderTaskDetailModal(task);
}

async function openTaskAnywhere(taskId) {
  try {
    const task = await fetchJson(`/api/task-anywhere/${encodeURIComponent(taskId)}`);
    renderTaskDetailModal(task);
  } catch (e) {
    alert('Could not load task details: ' + e.message);
  }
}

function closeDetail() {
  stopTaskDetailAutoRefresh();
  document.getElementById('modal-backdrop').classList.remove('open');
  deepDiveDetailCache = null; // force a fresh fetch next time any project's modal opens
}
