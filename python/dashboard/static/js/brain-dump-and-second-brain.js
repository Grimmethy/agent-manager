function renderBrainDumpShell() {
  document.getElementById('main').innerHTML = `
    <div class="capture-row">
      <input id="bd-capture-input" placeholder="Brain dump -- capture anything" autocomplete="off">
      <button class="action" id="bd-capture-btn" title="Save this note as a new Brain Dump entry">Capture</button>
    </div>
    <div class="split-pane">
      <div>
        <div class="field-label" style="display:flex; justify-content:space-between; align-items:center;">
          <span>Entries</span>
          <select id="bd-status-filter" style="text-transform:none; letter-spacing:normal; font-size:12px;">
            <option value="" ${brainDumpStatusFilter === '' ? 'selected' : ''}>Unprocessed</option>
            <option value="actioned" ${brainDumpStatusFilter === 'actioned' ? 'selected' : ''}>Processed</option>
            <option value="all" ${brainDumpStatusFilter === 'all' ? 'selected' : ''}>All</option>
          </select>
        </div>
        <div id="bd-entries"><div class="empty">Loading...</div></div>
      </div>
      <div>
        <div class="field-label" style="display:flex; justify-content:space-between; align-items:center;">
          <span>Second Brain</span>
          <button class="secondary" id="bd-sync-github-btn" style="text-transform:none; letter-spacing:normal; font-size:12px; padding:4px 10px;" title="Scan GitHub for your repos and create Second Brain notes for any that aren't linked yet">Sync GitHub Projects</button>
        </div>
        <div class="browser-panel" id="bd-browser" style="max-height:220px"><div class="empty">Loading...</div></div>
        <div id="bd-file-panel"></div>
      </div>
    </div>
  `;

  const input = document.getElementById('bd-capture-input');
  // Persist the draft across tab switches (brain-dump entry, 2026-08-17: "navigate to
  // other tabs in order to gather or confirm information" without losing what's typed).
  // renderBrainDumpShell() rebuilds #main -- and this input inside it -- from scratch on
  // every visit to this tab, wiping any unsaved text; localStorage is the only thing
  // that survives that. Same "browsePath survives across visits" pattern already used
  // for brainDumpBrowsePath just below, applied to a draft instead of a folder path.
  const DRAFT_KEY = 'agentManagerBrainDumpDraft';
  input.value = localStorage.getItem(DRAFT_KEY) || '';
  input.oninput = () => localStorage.setItem(DRAFT_KEY, input.value);
  const submit = async () => {
    const text = input.value.trim();
    if (!text) return;
    const btn = document.getElementById('bd-capture-btn');
    btn.disabled = true;
    try {
      await fetch('/api/brain-dump/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      input.value = '';
      localStorage.removeItem(DRAFT_KEY);
      await refreshBrainDumpEntries(true);
    } catch (e) {
      alert('Could not capture: ' + e.message);
    }
    btn.disabled = false;
  };
  document.getElementById('bd-capture-btn').onclick = submit;
  input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };

  document.getElementById('bd-status-filter').onchange = (e) => {
    brainDumpStatusFilter = e.target.value;
    refreshBrainDumpEntries(true);
  };

  document.getElementById('bd-sync-github-btn').onclick = async (e) => {
    const btn = e.target;
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Syncing...';
    try {
      const resp = await fetch('/api/second-brain/sync-github-projects', { method: 'POST' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const result = await resp.json();
      await loadSecondBrainBrowser();
      alert(`Synced ${result.synced} GitHub project(s)` + (result.created.length ? ` -- created ${result.created.length} new note(s): ${result.created.join(', ')}` : ' -- all already referenced.'));
    } catch (err) {
      alert('Could not sync GitHub projects: ' + err.message);
    }
    btn.disabled = false;
    btn.textContent = original;
  };

  loadSecondBrainBrowser();
}

function renderBrainDumpEditCard(entry) {
  const serialBadge = entry.serial ? `<span class="bd-serial" title="Reference this entry as #${entry.serial}">#${entry.serial}</span>` : '';
  return `
    <div class="bd-entry" data-id="${escapeAttr(entry.id)}">
      ${serialBadge ? `<div class="row meta" style="margin-bottom:4px">${serialBadge}</div>` : ''}
      <div class="capture-row" style="margin-bottom:0">
        <textarea data-edit-input="${escapeAttr(entry.id)}" rows="10" style="width:100%;white-space:pre-wrap;overflow-wrap:break-word;resize:vertical;">${escapeHtml(entry.rawText)}</textarea>
      </div>
      <div class="row" style="margin-top:8px">
        <span></span>
        <span>
          <button class="action" data-save="${escapeAttr(entry.id)}" title="Save the edited text for this entry">Save</button>
          <button class="secondary" data-cancel-edit="${escapeAttr(entry.id)}" title="Discard these edits and go back to the entry as it was">Cancel</button>
        </span>
      </div>
    </div>
  `;
}

function wireBrainDumpCardHandlers(el) {
  el.querySelectorAll('[data-jump]').forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault();
      const filePath = a.dataset.jump;
      const dir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
      brainDumpBrowsePath = dir;
      localStorage.setItem('agentManagerBrainDumpBrowsePath', brainDumpBrowsePath);
      loadSecondBrainBrowser().then(() => loadSecondBrainFile(filePath));
    };
  });

  el.querySelectorAll('[data-prioritize]').forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = 'Queuing...';
      try {
        await fetch('/api/brain-dump/' + encodeURIComponent(btn.dataset.prioritize) + '/prioritize', { method: 'POST' });
        await refreshBrainDumpEntries(true);
      } catch (e) {
        alert('Could not queue: ' + e.message);
        btn.disabled = false;
        btn.textContent = 'Process now';
      }
    };
  });

  el.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copyText || '');
        const original = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = original; }, 1200);
      } catch (e) {
        alert('Could not copy: ' + e.message);
      }
    };
  });

  el.querySelectorAll('[data-delete]').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm('Delete this brain dump entry?')) return;
      try {
        await fetch('/api/brain-dump/' + encodeURIComponent(btn.dataset.delete), { method: 'DELETE' });
        await refreshBrainDumpEntries(true);
      } catch (e) {
        alert('Could not delete: ' + e.message);
      }
    };
  });

  el.querySelectorAll('[data-reopen]').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm(`Reopen '${btn.dataset.reopen}' for a fresh draft? This resets its retry history.`)) return;
      btn.disabled = true;
      try {
        const res = await fetch(`/api/task/archived/${encodeURIComponent(btn.dataset.reopen)}/requeue`, { method: 'POST' });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.description || `${res.status}`);
        }
        await refreshBrainDumpEntries(true);
      } catch (e) {
        alert('Could not reopen: ' + e.message);
        btn.disabled = false;
      }
    };
  });

  el.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.onclick = () => {
      brainDumpEditingId = btn.dataset.edit;
      refreshBrainDumpEntries(true).then(() => {
        const input = el.querySelector(`[data-edit-input="${CSS.escape(brainDumpEditingId)}"]`);
        if (input) { input.focus(); input.select(); }
      });
    };
  });

  el.querySelectorAll('[data-cancel-edit]').forEach((btn) => {
    btn.onclick = () => {
      brainDumpEditingId = null;
      refreshBrainDumpEntries(true);
    };
  });

  el.querySelectorAll('[data-save]').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.save;
      const input = el.querySelector(`[data-edit-input="${CSS.escape(id)}"]`);
      const text = input.value.trim();
      if (!text) return;
      btn.disabled = true;
      try {
        await fetch('/api/brain-dump/' + encodeURIComponent(id), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        brainDumpEditingId = null;
        await refreshBrainDumpEntries(true);
      } catch (e) {
        alert('Could not save: ' + e.message);
        btn.disabled = false;
      }
    };
  });

  el.querySelectorAll('[data-edit-input]').forEach((input) => {
    input.onkeydown = (e) => {
      if (e.key === 'Escape') { el.querySelector(`[data-cancel-edit="${CSS.escape(input.dataset.editInput)}"]`).click(); return; }
      if (e.key === 'Enter' && !e.shiftKey && input.tagName !== 'TEXTAREA') el.querySelector(`[data-save="${CSS.escape(input.dataset.editInput)}"]`).click();
    };
  });

  el.querySelectorAll('[data-bd-send-to-chat]').forEach((btn) => {
    btn.onclick = () => {
      const entry = brainDumpEntryById.get(btn.dataset.bdSendToChat);
      if (!entry) { showToast('Could not send to chat: that brain-dump entry is no longer in the list.'); return; }
      const block =
        `Brain Dump entry #${entry.serial} -- id: ${entry.id}\n\n` +
        `${entry.rawText}\n` +
        `Discuss this brain-dump entry. Its id is ${entry.id}.`;
      sendTextToChat(block)
        .catch((e) => showToast(`Could not send to chat: ${e.message}`));
    };
  });
  el.querySelectorAll('[data-discuss]').forEach((btn) => {
    btn.onclick = () => brainDumpDiscussStart(btn.dataset.discuss);
  });
  el.querySelectorAll('[data-discuss-send]').forEach((btn) => {
    const card = btn.closest('.bd-entry');
    const textarea = card ? card.querySelector('.grill-answer') : null;
    const send = () => brainDumpDiscussSend(btn.dataset.discussSend, textarea ? textarea.value : '', btn, btn.dataset.entry);
    btn.onclick = send;
    if (textarea) {
      textarea.onkeydown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
      };
    }
  });

  el.querySelectorAll('[data-discuss-end]').forEach((btn) => {
    btn.onclick = () => brainDumpDiscussEnd(btn.dataset.discussEnd, btn, btn.dataset.entry);
  });

  el.querySelectorAll('[data-discuss-cancel]').forEach((btn) => {
    btn.onclick = () => {
      // Aborting the fetch alone isn't enough -- brainDumpDiscussStart's own catch
      // block already no-ops once brainDumpDiscussingId no longer matches this entry
      // (see its stale-response guard), so clearing it here is what actually makes
      // Cancel silent instead of surfacing an "AbortError" failure toast a moment later.
      if (brainDumpDiscussStartController) brainDumpDiscussStartController.abort();
      brainDumpDiscussingId = null;
      brainDumpDiscussSession = null;
      refreshBrainDumpEntries(true);
    };
  });

  el.querySelectorAll('[data-discuss-close]').forEach((btn) => {
    btn.onclick = () => {
      brainDumpDiscussingId = null;
      brainDumpDiscussSession = null;
      refreshBrainDumpEntries(true);
    };
  });

  // Same tail-scroll/focus treatment as grillRenderPanel -- keeps the latest message in
  // view and the input ready to type into, on every re-render (each message send
  // re-renders this card the same way submitting a grill answer does).
  if (brainDumpDiscussingId) {
    const discussScroll = el.querySelector(`[data-id="${CSS.escape(brainDumpDiscussingId)}"] .grill-transcript`);
    if (discussScroll) discussScroll.scrollTop = discussScroll.scrollHeight;
    const discussInput = el.querySelector(`[data-id="${CSS.escape(brainDumpDiscussingId)}"] .grill-answer`);
    if (discussInput) discussInput.focus();
  }
}

async function brainDumpDiscussStart(entryId) {
  // Brain Dump entries no longer carry a per-entry local/Subscription provider toggle
  // (removed 2026 -- see the render/wiring sites below). The provider falls back to the
  // same default the toggle itself defaulted to ("local"); the server's
  // _discuss_provider_args() also defaults to "local" when no provider is supplied.
  const providerBody = { provider: 'local' };
  try {
    const existing = await fetchJson('/api/brain-dump/' + encodeURIComponent(entryId) + '/discuss/latest');
    if (existing && existing.status === 'active') {
      brainDumpDiscussingId = entryId;
      brainDumpDiscussSession = existing;
      await refreshBrainDumpEntries(true);
      return;
    }
    if (existing && existing.status === 'ended') {
      showToast(`Starting a new discussion -- the previous one (${existing.transcript.length} messages) is kept, not deleted.`);
    }
  } catch (e) { /* best-effort check -- fall through to starting normally */ }

  brainDumpDiscussingId = entryId;
  brainDumpDiscussSession = null;
  const controller = new AbortController();
  brainDumpDiscussStartController = controller;
  await refreshBrainDumpEntries(true);
  try {
    const resp = await fetch('/api/brain-dump/' + encodeURIComponent(entryId) + '/discuss/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(providerBody), signal: controller.signal,
    });
    const session = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(session.description || ('HTTP ' + resp.status));
    // Stale-response guard (2026-08-17, brain-dump entry: reported "context bleed"
    // between two simultaneous discussions -- root cause was never actually the two
    // providers' backends crossing wires; it's this function's OWN response handler
    // blindly overwriting the shared brainDumpDiscussSession/brainDumpDiscussingId
    // singletons regardless of which entry is on screen by the time a slow reply
    // finally lands. Switch to a different entry's Discuss card while entryId's request
    // is still in flight, and its late response used to clobber whatever entry you'd
    // since opened -- reproduces exactly the reported symptom (entry B's card shows
    // entry A's transcript/provider). The server already persisted this response
    // correctly under its own session regardless; only the UI application is stale, so
    // discarding it here loses nothing -- reopening entryId's Discuss later resumes the
    // real, up-to-date session via the existing "status === 'active'" path above.
    if (brainDumpDiscussingId !== entryId) return;
    brainDumpDiscussSession = session;
    await refreshBrainDumpEntries(true);
  } catch (e) {
    if (brainDumpDiscussingId !== entryId) return;
    showToast('Could not start discussion: ' + e.message);
    brainDumpDiscussingId = null;
    brainDumpDiscussSession = null;
    await refreshBrainDumpEntries(true);
  }
}

async function brainDumpDiscussSend(sessionId, message, btn, entryId) {
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
    // Same stale-response guard as brainDumpDiscussStart -- see its own comment. Without
    // this, a reply to a message sent to entryId lands and overwrites whatever DIFFERENT
    // entry the user has since switched to, appearing as cross-talk between two discussions.
    if (brainDumpDiscussingId !== entryId) return;
    brainDumpDiscussSession = session;
    await refreshBrainDumpEntries(true);
  } catch (e) {
    showToast('Could not send message: ' + e.message);
    btn.disabled = false;
    btn.textContent = 'Send';
  }
}

async function brainDumpDiscussEnd(sessionId, btn, entryId) {
  btn.disabled = true;
  btn.textContent = 'Ending...';
  try {
    const resp = await fetch('/api/discuss/' + encodeURIComponent(sessionId) + '/end', { method: 'POST' });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.description || ('HTTP ' + resp.status));
    // Same stale-response guard as brainDumpDiscussStart/Send -- see the former's comment.
    if (brainDumpDiscussingId !== entryId) return;
    brainDumpDiscussSession = data.session;
    await refreshBrainDumpEntries(true);
  } catch (e) {
    showToast('Could not end discussion: ' + e.message);
    btn.disabled = false;
    btn.textContent = 'End Discussion';
  }
}

async function refreshBrainDumpEntries(force = false) {
  if ((brainDumpEditingId || brainDumpDiscussingId) && !force) return;
  const el = document.getElementById('bd-entries');
  if (!el) return;
  let entries;
  try {
    const qs = brainDumpStatusFilter ? `?status=${encodeURIComponent(brainDumpStatusFilter)}` : '';
    entries = await fetchJson('/api/brain-dump' + qs);
    entries.forEach((entry) => brainDumpEntryById.set(entry.id, entry));
  } catch (e) {
    el.innerHTML = `<div class="empty">Could not load: ${e.message}</div>`;
    return;
  }

  if (entries.length === 0) {
    const msg = brainDumpStatusFilter === 'actioned' ? 'No processed entries yet.'
      : brainDumpStatusFilter === 'all' ? 'Nothing captured yet.'
      : 'Nothing unprocessed -- everything captured so far has been actioned.';
    el.innerHTML = `<div class="empty">${msg}</div>`;
    return;
  }

  el.innerHTML = entries.map((entry) => {
    if (entry.id === brainDumpEditingId) return renderBrainDumpEditCard(entry);
    if (entry.id === brainDumpDiscussingId) return renderBrainDumpDiscussCard(entry, brainDumpDiscussSession);
    return renderBrainDumpCard(entry);
  }).join('');

  wireBrainDumpCardHandlers(el);
}

function taskStatusBadgeHtml(taskId, taskStatus) {
  const [sev, label] = TASK_STATUS_BADGE[taskStatus] || TASK_STATUS_BADGE.unknown;
  return `<span class="badge ${sev} clickable" data-open-task="${escapeAttr(taskId)}" style="cursor:pointer" title="task ${escapeAttr(taskId)} -- click for details">${escapeHtml(label)}</span>`;
}

function renderBrainDumpCard(entry) {
  const sort = entry.sort;
  const statusBadge = entry.status === 'sorted'
    ? '<span class="badge ok">sorted</span>'
    : '<span class="badge idle">captured</span>';
  const queuedBadge = entry.queuedTaskId ? taskStatusBadgeHtml(entry.queuedTaskId, entry.taskStatus) : '';
  const reopenBtn = entry.taskStatus === 'archived'
    ? `<button class="secondary" data-reopen="${escapeAttr(entry.queuedTaskId)}" title="Requeue this entry's task for a fresh draft, resetting its retry history">Reopen</button>`
    : '';
  const jump = sort && sort.secondBrainPath
    ? `<a class="jump" data-jump="${escapeAttr(sort.secondBrainPath)}" href="#">open &rarr;</a>`
    : '';
  const meta = sort
    ? escapeHtml((sort.tags && sort.tags.length ? sort.tags.join(', ') : sort.secondBrainPath) || '')
    : new Date(entry.capturedAt).toLocaleString();
  const serialBadge = entry.serial ? `<span class="bd-serial" title="Reference this entry as #${entry.serial}">#${entry.serial}</span> ` : '';
  // Side-finding provenance + count (2026-09-05, side-finding-sweep.js): same colored-
  // chip-with-tooltip convention as the Job List tab's stalenessFlag/contextTrimFlag
  // chips. countChip only shows once a duplicate has actually landed (count===1 is the
  // common case and needs no extra UI); raisedByBadge marks a machine-raised entry so it
  // reads differently from a human-typed note at a glance.
  const countChip = entry.count > 1
    ? `<span title="${escapeAttr(`Seen ${entry.count} times${(entry.seenIn || []).length ? ' -- tasks: ' + entry.seenIn.join(', ') : ''}`)}" style="display:inline-block;margin-left:6px;padding:1px 5px;border:1px solid var(--warn);border-radius:3px;color:var(--warn);font-size:11px">🔁 seen ${entry.count}&times;</span>`
    : '';
  // 2026-09-05, Grimmethy (reading the first real finding, #208, which had no taskId at
  // all): "Make sure the brain dumps provide enough context. A link to the task that
  // spawned it would be a great add." Clickable (data-open-task, same delegated listener
  // taskStatusBadgeHtml already wires up above -- openTaskAnywhere finds a task
  // regardless of which queue state it's currently in) whenever a taskId is actually
  // present; falls back to a plain, non-clickable badge for an older/Chat-raised finding
  // that predates this or genuinely has no task to link (taskId stays null for Chat).
  const raisedByBadge = entry.raisedBy
    ? (entry.raisedBy.taskId
      ? `<span class="clickable" data-open-task="${escapeAttr(entry.raisedBy.taskId)}" style="cursor:pointer;display:inline-block;margin-left:6px;padding:1px 5px;border:1px solid var(--muted);border-radius:3px;color:var(--muted);font-size:11px" title="Flagged automatically while working on ${escapeAttr(entry.raisedBy.taskId)} -- click to open that task">🤖 ${escapeHtml(entry.raisedBy.source || 'pipeline')}</span>`
      : `<span style="display:inline-block;margin-left:6px;padding:1px 5px;border:1px solid var(--muted);border-radius:3px;color:var(--muted);font-size:11px" title="Flagged automatically while working on a ${escapeAttr(entry.raisedBy.source || 'pipeline')} task (no task link available)">🤖 ${escapeHtml(entry.raisedBy.source || 'pipeline')}</span>`)
    : '';
  return `
    <div class="bd-entry" data-id="${escapeAttr(entry.id)}">
      <div class="row">
        <span class="text">${serialBadge}${escapeHtmlBright(entry.rawText)}${countChip}${raisedByBadge}</span>
        ${statusBadge}
      </div>
      <div class="row meta">
        <span>${meta}</span>
        ${jump}
      </div>
      <div class="row" style="margin-top:8px">
        <span>${queuedBadge}</span>
        <span>
          <button class="secondary" data-prioritize="${escapeAttr(entry.id)}" title="Queue this entry for drafting right away instead of waiting on the normal sort/priority order">Process now</button>
          <button class="secondary" data-bd-send-to-chat="${escapeAttr(entry.id)}" title="Send this entry to the System Chat panel as a message -- no AI call, works even while the local model is busy">Send to Chat</button>
          <button class="secondary" data-copy="${escapeAttr(entry.id)}" data-copy-text="${escapeAttr(entry.rawText)}" title="Copy this entry's raw text to the clipboard">Copy</button>
          <button class="secondary" data-edit="${escapeAttr(entry.id)}" title="Edit this entry's raw text">Edit</button>
          <button class="secondary" data-delete="${escapeAttr(entry.id)}" title="Delete this brain dump entry">Delete</button>
          ${reopenBtn}
        </span>
      </div>
    </div>
  `;
}

function renderBrainDumpDiscussCard(entry, session) {
  const serialBadge = entry.serial ? `<span class="bd-serial" title="Reference this entry as #${entry.serial}">#${entry.serial}</span> ` : '';
  if (!session) {
    return `
      <div class="bd-entry" data-id="${escapeAttr(entry.id)}">
        <div class="row"><span class="text">${serialBadge}${escapeHtmlBright(entry.rawText)}</span></div>
        <div class="row" style="margin-top:8px"><span class="empty">Starting conversation...</span><button type="button" class="secondary" data-discuss-cancel="${escapeAttr(entry.id)}" title="Abort starting this conversation">Cancel</button></div>
      </div>
    `;
  }
  const transcriptHtml = grillRenderTranscript(session.transcript, session);
  const bodyHtml = session.status === 'ended'
    ? `${transcriptHtml}` +
      (session.summary
        ? `<div class="grill-enriched-badge">Added to entry ✓: ${escapeHtml(session.summary)}</div>`
        : `<div class="meta" style="margin-top:8px">Ended with nothing said -- entry unchanged.</div>`) +
      `<div class="row" style="margin-top:10px"><span></span><button type="button" class="secondary" data-discuss-close="${escapeAttr(entry.id)}" title="Close this ended conversation and go back to the entry list">Close</button></div>`
    : `${transcriptHtml}` +
      `<textarea class="grill-answer" rows="3" placeholder="Say more... (Enter to send, Shift+Enter for a new line)"></textarea>` +
      `<div class="row" style="margin-top:8px">` +
      `<button type="button" class="secondary" data-discuss-end="${escapeAttr(session.id)}" data-entry="${escapeAttr(entry.id)}" title="End this conversation and fold any new context into the entry">End Discussion</button>` +
      `<button type="button" class="action" data-discuss-send="${escapeAttr(session.id)}" data-entry="${escapeAttr(entry.id)}" title="Send this message">Send</button>` +
      `</div>`;
  return `
    <div class="bd-entry" data-id="${escapeAttr(entry.id)}">
      ${serialBadge ? `<div class="row meta" style="margin-bottom:4px">${serialBadge}</div>` : ''}
      <div class="grill-session">${bodyHtml}</div>
    </div>
  `;
}

async function loadSecondBrainBrowser() {
  const panel = document.getElementById('bd-browser');
  if (!panel) return;
  panel.innerHTML = '<div class="empty">Loading...</div>';
  let data;
  try {
    data = await fetchJson('/api/second-brain/browse?path=' + encodeURIComponent(brainDumpBrowsePath));
  } catch (e) {
    // brainDumpBrowsePath is persisted in localStorage across sessions -- a folder it
    // points at can legitimately stop existing between visits (renamed, merged, deleted
    // outside the dashboard entirely, e.g. by hand or by another tool), which otherwise
    // permanently wedges this panel on a dead 404 with no way back short of clearing
    // localStorage yourself. Confirmed live 2026-08-16: the "projects"/"Projects"
    // case-duplicate folders got merged, and a browser that had "projects" saved from
    // before the merge 404'd here forever after. Fall back to root once rather than
    // leaving a stale path permanently wedged.
    if (brainDumpBrowsePath !== '') {
      brainDumpBrowsePath = '';
      localStorage.setItem('agentManagerBrainDumpBrowsePath', '');
      try {
        data = await fetchJson('/api/second-brain/browse?path=');
      } catch (e2) {
        panel.innerHTML = `<div class="empty">Could not browse: ${e2.message}</div>`;
        return;
      }
    } else {
      panel.innerHTML = `<div class="empty">Could not browse: ${e.message}</div>`;
      return;
    }
  }

  if (!data.configured) {
    panel.innerHTML = '<div class="empty">SECOND_BRAIN_DIR is not configured for the active project.</div>';
    return;
  }

  // A plain path-as-text crumb here previously gave no way back to the root except
  // clicking "up" once per level -- easy to end up parked deep in a small folder (e.g.
  // Decisions/, 2 files) after a "jump to file" link, with no obvious cue you're not
  // looking at the whole second brain. Every segment (including "Second Brain" itself)
  // is now a clickable jump-to-that-level link, reusing the same [data-nav] wiring the
  // existing browser-entry rows already use below (attribute selector, not class-scoped).
  const crumbSegments = data.path ? data.path.split('/') : [];
  let crumbHtml = `<span class="crumb-link" data-nav="">Second Brain</span>`;
  let acc = '';
  for (const seg of crumbSegments) {
    acc = acc ? `${acc}/${seg}` : seg;
    crumbHtml += ` / <span class="crumb-link" data-nav="${escapeAttr(acc)}">${escapeHtml(seg)}</span>`;
  }
  let html = `<div class="browser-crumb">${crumbHtml}</div>`;
  if (data.parent !== null) {
    html += `<div class="browser-entry" data-nav="${escapeAttr(data.parent)}"><span>.. (up)</span></div>`;
  }
  for (const entry of data.entries) {
    if (entry.isDir) {
      // Population count: direct children only (files + subfolders) -- null means the
      // folder couldn't be read (permissions), distinct from a genuinely empty "0".
      const countLabel = entry.count === null ? '?' : entry.count;
      html += `<div class="browser-entry" data-nav="${escapeAttr(entry.path)}"><span>${escapeHtml(entry.name)}/</span><span class="entry-count">${countLabel}</span></div>`;
    } else {
      const active = entry.path === brainDumpSelectedFile ? ' active' : '';
      // Notes linked to a real GitHub repo (via /api/second-brain/sync-github-projects)
      // get a one-click way to make that repo the pipeline's active project, or a badge
      // if it already is -- the actual ask: buttons in Second Brain that set a project
      // active, so every GitHub project is reachable AND actionable from here.
      let projectControl = '';
      if (entry.repoPath) {
        projectControl = entry.isActiveProject
          ? `<span class="badge ok" title="${escapeAttr(entry.repoPath)}">Active Project</span>`
          : `<button type="button" class="secondary set-active-project" data-repo-path="${escapeAttr(entry.repoPath)}" title="Stop the current pipeline and start it against ${escapeAttr(entry.repoPath)}">Set Active</button>`;
      } else if (entry.name.toLowerCase().endsWith('.md') && !entry.name.startsWith('_')) {
        // Project-starter notes (not yet linked to any repo, and not a _template.md-style
        // scaffold) get a way to actually become a project -- the ask: "turn these project
        // starters into actual projects" via a button next to the note.
        projectControl = `<button type="button" class="secondary create-github-project" data-note-path="${escapeAttr(entry.path)}" title="Create a new git repo seeded from this note's content">Create GitHub Project</button>`;
      }
      html += `<div class="browser-entry${active}" data-file="${escapeAttr(entry.path)}"><span>${escapeHtml(entry.name)}</span>${projectControl}</div>`;
    }
  }
  panel.innerHTML = html;

  panel.querySelectorAll('[data-nav]').forEach((el) => {
    el.onclick = () => {
      brainDumpBrowsePath = el.dataset.nav;
      localStorage.setItem('agentManagerBrainDumpBrowsePath', brainDumpBrowsePath);
      loadSecondBrainBrowser();
    };
  });
  panel.querySelectorAll('.set-active-project').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation(); // don't also trigger the row's data-file "open note" handler
      const repoPath = btn.dataset.repoPath;
      if (!confirm(`Stop the current pipeline (if running) and start it against:\n${repoPath}\n\nStarts in the safe default (no apply/no push) -- switch that on later from the Project tab if you want it to write changes.`)) return;
      btn.disabled = true;
      btn.textContent = 'Switching...';
      try {
        await fetch('/api/pipeline/stop', { method: 'POST' });
        const resp = await fetch('/api/pipeline/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: repoPath, includeApply: false, skipPush: true }),
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(err.description || ('HTTP ' + resp.status));
        }
        await loadSecondBrainBrowser();
      } catch (err) {
        alert('Could not switch active project: ' + err.message);
        btn.disabled = false;
        btn.textContent = 'Set Active';
      }
    };
  });
  panel.querySelectorAll('.create-github-project').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation(); // don't also trigger the row's data-file "open note" handler
      const notePath = btn.dataset.notePath;
      if (!confirm(`Create a new GitHub project seeded from this note?\n\nThis creates a new folder + git repo under your GitHub projects directory, with this note's content as README.md, and links the note to it here.`)) return;
      btn.disabled = true;
      btn.textContent = 'Creating...';
      try {
        const resp = await fetch('/api/second-brain/create-github-project', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ notePath }),
        });
        const result = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(result.description || ('HTTP ' + resp.status));
        await loadSecondBrainBrowser();
        alert(`Created ${result.projectName} at ${result.repoPath}`);
      } catch (err) {
        alert('Could not create GitHub project: ' + err.message);
        btn.disabled = false;
        btn.textContent = 'Create GitHub Project';
      }
    };
  });
  panel.querySelectorAll('[data-file]').forEach((el) => {
    el.onclick = () => loadSecondBrainFile(el.dataset.file);
  });
}

async function loadSecondBrainFile(filePath) {
  brainDumpSelectedFile = filePath;
  const panel = document.getElementById('bd-file-panel');
  if (!panel) return;
  panel.innerHTML = '<div class="empty">Loading...</div>';
  try {
    const data = await fetchJson('/api/second-brain/file?path=' + encodeURIComponent(filePath));
    panel.innerHTML = `<div class="field-label">${escapeHtml(filePath)}</div><div class="note-content">${escapeHtml(data.content)}</div><div id="sb-task-refs"></div><div class="grill-controls"><button type="button" class="secondary grill-start" data-mode="grill-me">Grill Me</button> <button type="button" class="secondary grill-start" data-mode="grill-with-docs">Grill With Docs</button> <button type="button" class="secondary" id="sb-discuss-start">Discuss</button> ${renderProviderToggle('sb-discuss-provider')}</div><div id="grill-panel"></div><div id="sb-discuss-panel"></div>`;
    panel.querySelectorAll('.grill-start').forEach((btn) => {
      btn.onclick = () => grillStartSession(filePath, btn.dataset.mode);
    });
    const discussBtn = panel.querySelector('#sb-discuss-start');
    if (discussBtn) discussBtn.onclick = () => sbDiscussStart(filePath);
    wireProviderToggle('sb-discuss-provider');
    // Linked-task status (2026-08-16): a note can carry a "Queued as adhoc task `id` in
    // **label**" cross-reference from applyBrainDumpSort -- surface its LIVE status here
    // (looked up directly from that project's own queue, even if it isn't the currently
    // active pipeline) instead of leaving the reader to wonder whether it ever went
    // anywhere. Same motivating incident as the Brain Dump tab's own taskStatus badges:
    // every one of a real user's queued tasks turned out to be silently blocked.
    try {
      const refs = await fetchJson('/api/second-brain/task-refs?notePath=' + encodeURIComponent(filePath));
      const refsEl = panel.querySelector('#sb-task-refs');
      if (refsEl && refs.length) {
        refsEl.innerHTML = '<div class="field-label">Linked Tasks</div>' + refs.map((r) => {
          const badge = r.projectFound && r.taskStatus
            ? taskStatusBadgeHtml(r.taskId, r.taskStatus)
            : '<span class="badge idle">unknown</span>';
          const activeNote = r.isActiveProject ? '' : '<span class="meta"> (not the active project)</span>';
          const noteLine = r.note ? `<div class="meta" style="margin-top:2px">${escapeHtml(r.note)}</div>` : '';
          return `<div class="row" style="margin-top:4px"><span><code>${escapeHtml(r.taskId)}</code> in <strong>${escapeHtml(r.projectLabel)}</strong>${activeNote}</span>${badge}</div>${noteLine}`;
        }).join('');
      }
    } catch (e) { /* best-effort -- a missing/unreadable note just means no refs to show */ }
    // Surface an existing session for this note instead of leaving grill-panel empty and
    // silently letting the next Grill Me click start a fresh one next to it -- confirmed
    // live 2026-08-14: nothing was ever actually lost (every session persists correctly
    // in .agent-manager-grill-sessions.json), but with no UI ever checking for or showing
    // prior work, a completed-but-not-yet-enriched session was invisible the moment you
    // navigated away and back.
    try {
      const existing = await fetchJson('/api/second-brain/grill/for-note?notePath=' + encodeURIComponent(filePath));
      if (existing) grillRenderPanel(existing);
    } catch (e) { /* best-effort -- a missing/unreadable sessions file just means no prior session to show */ }
    // Same "don't bury existing work" treatment for a past/in-progress Discuss session.
    try {
      const existingDiscuss = await fetchJson('/api/second-brain/discuss/for-note?notePath=' + encodeURIComponent(filePath));
      if (existingDiscuss) sbDiscussRenderPanel(existingDiscuss);
    } catch (e) { /* best-effort -- same as above */ }
  } catch (e) {
    panel.innerHTML = `<div class="empty">Could not read file: ${e.message}</div>`;
  }
  document.querySelectorAll('#bd-browser .browser-entry[data-file]').forEach((el) => {
    el.classList.toggle('active', el.dataset.file === filePath);
  });
}

function grillRenderTranscript(transcript, session) {
  // session.provider is only set on Discuss sessions ("local" or "claude" -- see
  // discuss_sessions.py's PROVIDER_* comment); Grill Me sessions never set it and are
  // always the local model. Label the assistant turns for whichever model actually
  // generated them instead of assuming a specific local model unconditionally (2026-08-24,
  // Grimmethy: "Ornith is no longer the default model... reference local instead").
  const assistantLabel = session && session.provider === 'claude' ? 'Claude' : 'Local';
  const rows = transcript.map((t) => {
    const roleLabel = t.role === 'assistant' ? assistantLabel : 'You';
    const cls = t.role === 'assistant' ? 'grill-msg-assistant' : 'grill-msg-user';
    // 2026-09-01 (Grimmethy: "each thinking segment to include a full blank line space
    // between each other" + "time stamps to the second programmed into each thought
    // segment"): split the turn's text on blank lines into <p> blocks (CSS gives them
    // the full-line gap) and, when the turn carries a `timestamp` (chat_sessions.py
    // started recording one per turn, to the second), stamp every segment with it.
    // Turns persisted before that change have no `timestamp` -- they just render
    // plain, as before.
    let body;
    if (t.timestamp) {
      const m = String(t.timestamp).match(/T(\d{2}):(\d{2}):(\d{2})/);
      const stamp = m ? `${m[1]}:${m[2]}:${m[3]}` : String(t.timestamp).slice(11, 19);
      body = String(t.text).split(/\n{2,}/).map(seg =>
        `<p><span class="grill-seg-ts">${escapeHtml(stamp)}</span>${escapeHtmlBright(seg)}</p>`
      ).join('');
    } else {
      body = escapeHtmlBright(t.text);
    }
    return `<div class="${cls}"><div class="grill-msg-role">${escapeHtml(roleLabel)}</div><div class="grill-msg-text">${body}</div></div>`;
  }).join('');
  return `<div class="field-label">Conversation</div><div class="grill-transcript">${rows}</div>`;
}

function grillRenderPanel(session) {
  const el = document.getElementById('grill-panel');
  if (!el) return;
  const transcriptHtml = grillRenderTranscript(session.transcript, session);
  if (session.status === 'complete') {
    // grillEnrich refreshes the note-content readout in place automatically -- no manual
    // reload step needed (previously required navigating away and back, or a separate
    // "Reload Note" click, to see the appended summary at all).
    const actionHtml = session.enrichedAt
      ? `<div class="grill-enriched-badge">Enriched ✓ (note updated — the full conversation above is not written to the note itself, only the summary)</div>`
      : `<button type="button" class="action grill-enrich" data-session="${escapeAttr(session.id)}">Enrich Brain</button>`;
    el.innerHTML = `<div class="grill-session"><div class="field-label">Session complete</div>${transcriptHtml}${actionHtml}</div>`;
    const enrichBtn = el.querySelector('.grill-enrich');
    if (enrichBtn) enrichBtn.onclick = (e) => grillEnrich(session.id, e.target);
  } else {
    el.innerHTML = `<div class="grill-session">${transcriptHtml}<textarea class="grill-answer" rows="3" placeholder="Your answer... (Enter to send, Shift+Enter for a new line)"></textarea><button type="button" class="action grill-submit" data-session="${escapeAttr(session.id)}">Submit Answer</button></div>`;
    const answerEl = el.querySelector('.grill-answer');
    const submitBtn = el.querySelector('.grill-submit');
    submitBtn.onclick = (e) => grillSubmitAnswer(session.id, answerEl.value, e.target);
    // Enter sends, Shift+Enter inserts a newline (the browser's own default for a plain
    // Enter in a textarea is also a newline -- only intercept the un-modified case).
    answerEl.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        grillSubmitAnswer(session.id, answerEl.value, submitBtn);
      }
    };
    answerEl.focus();
  }
  const scrollEl = el.querySelector('.grill-transcript');
  if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
}

async function grillStartSession(notePath, mode) {
  const el = document.getElementById('grill-panel');
  // Don't silently start a second session next to one already sitting there -- a
  // completed-but-not-enriched (or still-active) session for this exact note+mode is
  // real, persisted work; starting fresh should be a deliberate choice, not an accident
  // of clicking the wrong button after navigating back to a note.
  try {
    const existing = await fetchJson('/api/second-brain/grill/for-note?notePath=' + encodeURIComponent(notePath));
    if (existing && existing.mode === mode) {
      const already = existing.status === 'complete'
        ? (existing.enrichedAt ? 'a completed, already-enriched session' : 'a completed session that has not been enriched yet')
        : 'a session already in progress';
      if (!confirm(`This note has ${already} (${existing.transcript.length} messages). Start a brand new session anyway? (The existing one is kept, not deleted.)`)) {
        grillRenderPanel(existing);
        return;
      }
    }
  } catch (e) { /* best-effort check -- if it fails, fall through to starting normally */ }
  if (el) el.innerHTML = '<div class="empty">Starting session...</div>';
  try {
    const resp = await fetch('/api/second-brain/grill/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notePath, mode }),
    });
    const session = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(session.description || ('HTTP ' + resp.status));
    grillRenderPanel(session);
  } catch (e) {
    if (el) el.innerHTML = `<div class="empty">Could not start session: ${e.message}</div>`;
  }
}

async function grillSubmitAnswer(sessionId, answer, btn) {
  if (!answer || !answer.trim()) return;
  btn.disabled = true;
  btn.textContent = 'Thinking...';
  try {
    const resp = await fetch('/api/second-brain/grill/' + encodeURIComponent(sessionId) + '/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer }),
    });
    const session = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(session.description || ('HTTP ' + resp.status));
    grillRenderPanel(session);
  } catch (e) {
    alert('Could not submit answer: ' + e.message);
    btn.disabled = false;
    btn.textContent = 'Submit Answer';
  }
}

async function grillEnrich(sessionId, btn) {
  btn.disabled = true;
  btn.textContent = 'Enriching...';
  try {
    const resp = await fetch('/api/second-brain/grill/' + encodeURIComponent(sessionId) + '/enrich', { method: 'POST' });
    const result = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(result.description || ('HTTP ' + resp.status));
    grillRenderPanel(result);
    // Refresh the note-content readout in place so the newly-appended summary shows up
    // immediately -- previously this required navigating away and back (or a separate
    // manual "Reload Note" click) to see any change at all. Only the note-content div is
    // touched, not the whole panel, so the transcript/enriched-badge just rendered above
    // stays put.
    if (result.notePath) {
      try {
        const data = await fetchJson('/api/second-brain/file?path=' + encodeURIComponent(result.notePath));
        const noteContentEl = document.querySelector('#bd-file-panel .note-content');
        if (noteContentEl) noteContentEl.textContent = data.content;
      } catch (e) { /* best-effort -- enrich itself already succeeded; a failed refresh here just leaves the readout stale until the note is reopened */ }
    }
  } catch (e) {
    alert('Could not enrich note: ' + e.message);
    btn.disabled = false;
    btn.textContent = 'Enrich Brain';
  }
}

function sbDiscussRenderPanel(session) {
  const el = document.getElementById('sb-discuss-panel');
  if (!el) return;
  const transcriptHtml = grillRenderTranscript(session.transcript, session);
  if (session.status === 'ended') {
    const actionHtml = session.summary
      ? `<div class="grill-enriched-badge">Added to note ✓: ${escapeHtml(session.summary)}</div>`
      : `<div class="meta" style="margin-top:8px">Ended with nothing said -- note unchanged.</div>`;
    el.innerHTML = `<div class="grill-session"><div class="field-label">Discussion ended</div>${transcriptHtml}${actionHtml}</div>`;
  } else {
    el.innerHTML = `<div class="grill-session">${transcriptHtml}<textarea class="grill-answer" rows="3" placeholder="Say more... (Enter to send, Shift+Enter for a new line)"></textarea><div class="row" style="margin-top:8px"><button type="button" class="secondary" id="sb-discuss-end">End Discussion</button><button type="button" class="action" id="sb-discuss-send">Send</button></div></div>`;
    const answerEl = el.querySelector('.grill-answer');
    const sendBtn = el.querySelector('#sb-discuss-send');
    const endBtn = el.querySelector('#sb-discuss-end');
    sendBtn.onclick = () => sbDiscussSend(session.id, answerEl.value, sendBtn);
    endBtn.onclick = () => sbDiscussEnd(session.id, endBtn);
    answerEl.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sbDiscussSend(session.id, answerEl.value, sendBtn); }
    };
    answerEl.focus();
  }
  const scrollEl = el.querySelector('.grill-transcript');
  if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
}

async function sbDiscussStart(notePath) {
  const el = document.getElementById('sb-discuss-panel');
  try {
    const existing = await fetchJson('/api/second-brain/discuss/for-note?notePath=' + encodeURIComponent(notePath));
    if (existing) {
      const already = existing.status === 'ended' ? 'a past discussion' : 'a discussion already in progress';
      if (!confirm(`This note has ${already} (${existing.transcript.length} messages). Start a brand new one anyway? (The existing one is kept, not deleted.)`)) {
        sbDiscussRenderPanel(existing);
        return;
      }
    }
  } catch (e) { /* best-effort check -- fall through to starting normally */ }
  if (el) el.innerHTML = '<div class="empty">Starting discussion...</div>';
  try {
    const resp = await fetch('/api/second-brain/discuss/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notePath, ...providerPayload('sb-discuss-provider') }),
    });
    const session = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(session.description || ('HTTP ' + resp.status));
    sbDiscussRenderPanel(session);
  } catch (e) {
    if (el) el.innerHTML = '';
    showToast('Could not start discussion: ' + e.message);
  }
}

async function sbDiscussSend(sessionId, message, btn) {
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
    sbDiscussRenderPanel(session);
  } catch (e) {
    showToast('Could not send message: ' + e.message);
    btn.disabled = false;
    btn.textContent = 'Send';
  }
}

async function sbDiscussEnd(sessionId, btn) {
  btn.disabled = true;
  btn.textContent = 'Ending...';
  try {
    const resp = await fetch('/api/discuss/' + encodeURIComponent(sessionId) + '/end', { method: 'POST' });
    const result = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(result.description || ('HTTP ' + resp.status));
    sbDiscussRenderPanel(result.session);
    // Same in-place note-content refresh grillEnrich already does, for the same reason:
    // the summary just got appended to the file on disk, so the readout above should
    // show it immediately rather than looking stale until the note is reopened.
    if (result.noteUpdated && result.session && result.session.subjectId) {
      try {
        const data = await fetchJson('/api/second-brain/file?path=' + encodeURIComponent(result.session.subjectId));
        const noteContentEl = document.querySelector('#bd-file-panel .note-content');
        if (noteContentEl) noteContentEl.textContent = data.content;
      } catch (e) { /* best-effort -- end itself already succeeded */ }
    }
  } catch (e) {
    showToast('Could not end discussion: ' + e.message);
    btn.disabled = false;
    btn.textContent = 'End Discussion';
  }
}

async function enterBrainDumpTab() {
  renderBrainDumpShell();
  // force=true -- brainDumpEditingId/brainDumpDiscussingId are module-level and outlive
  // leaveBrainDumpTab() (by design, so an in-progress discussion survives a tab switch).
  // An unforced call here would hit refreshBrainDumpEntries' own guard against those same
  // flags and skip the list entirely on every return to this tab, appearing to hang
  // indefinitely with no spinner (confirmed live 2026-08-17, see the brain-dump entry
  // this fix closes out). The periodic poll below stays unforced on purpose -- that guard
  // is still correct there, to keep a 5s tick from clobbering an open discussion/edit.
  await refreshBrainDumpEntries(true);
  brainDumpEntriesInterval = setInterval(refreshBrainDumpEntries, 5000);
}

function leaveBrainDumpTab() {
  if (brainDumpEntriesInterval) { clearInterval(brainDumpEntriesInterval); brainDumpEntriesInterval = null; }
}
