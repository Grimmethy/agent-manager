const DEEP_DIVE_ADD_BAR = `
  <div class="capture-row">
    <input id="dd-add-url-input" placeholder="Paste a github.com/org/repo URL to scout it" autocomplete="off">
    <button class="action" id="dd-add-url-btn" title="Add this repo -- it clones/grabs communities on the next worker tick, same as any auto-discovered lead">Add repo</button>
  </div>
`;

function wireDeepDiveAddBar() {
  const input = document.getElementById('dd-add-url-input');
  const btn = document.getElementById('dd-add-url-btn');
  const submit = async () => {
    const url = input.value.trim();
    if (!url) return;
    btn.disabled = true;
    try {
      const res = await fetch('/api/project-search/manual-lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.description || res.statusText);
      }
      const result = await res.json();
      input.value = '';
      if (result.alreadyPresent) {
        alert(`${result.name} is already scouted -- it'll clone on its next worker tick if it hasn't already.`);
      }
    } catch (e) {
      alert('Could not add repo: ' + e.message);
    } finally {
      btn.disabled = false;
    }
    if (activeTab === 'deepdive') await renderDeepDiveTab();
  };
  btn.onclick = submit;
  input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
}

async function renderDeepDiveTab() {
  const projects = await fetchJson('/api/deep-dive/projects');
  const main = document.getElementById('main');
  if (projects.length === 0) {
    main.innerHTML = DEEP_DIVE_ADD_BAR + '<div class="empty">No repos scouted yet -- project_search hasn\'t landed a Strong lead for deep_dive to pick up, or add one above.</div>';
    wireDeepDiveAddBar();
    return;
  }
  const rows = projects.map(p => `
    <tr class="clickable ${p.hotlist ? 'top-row' : ''}" data-slug="${escapeAttr(p.slug)}">
      <td onclick="event.stopPropagation()"><input type="checkbox" class="hotlist-toggle" data-slug="${escapeAttr(p.slug)}" ${p.hotlist ? 'checked' : ''} title="Move this repo to the top of the research priority list"></td>
      <td>${escapeHtml(p.slug)}</td>
      <td>${p.sourceUrl ? `<a href="${escapeAttr(p.sourceUrl)}" target="_blank" onclick="event.stopPropagation()">${escapeHtml(p.sourceUrl)}</a>` : ''}</td>
      <td>${p.reviewedCount} / ${p.communityCount}</td>
      <td>${p.totalActionItems}</td>
      <td>${p.clonedAt ? new Date(p.clonedAt).toLocaleString() : ''}</td>
    </tr>
  `).join('');
  main.innerHTML = DEEP_DIVE_ADD_BAR + `<table><thead><tr><th>Hot</th><th>Project</th><th>Source</th><th>Communities Reviewed</th><th>Action Items</th><th>Cloned</th></tr></thead><tbody>${rows}</tbody></table>`;
  wireDeepDiveAddBar();
  main.querySelectorAll('tr.clickable').forEach(row => {
    row.onclick = () => openDeepDiveDetail(row.dataset.slug);
  });
  main.querySelectorAll('.hotlist-toggle').forEach(cb => {
    cb.onclick = (e) => e.stopPropagation();
    cb.onchange = () => toggleHotlist(cb.dataset.slug, cb.checked);
  });
}

async function toggleHotlist(slug, hotlist) {
  try {
    await fetch('/api/deep-dive/projects/' + encodeURIComponent(slug) + '/hotlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hotlist }),
    });
  } catch (e) {
    alert('Could not update hotlist: ' + e.message);
  }
  if (activeTab === 'deepdive') await renderDeepDiveTab();
}

function itemsForCommunity(items, community) {
  return items.filter((it) => (
    community.id != null && it.communityId != null
      ? it.communityId === community.id
      : it.community === community.name
  ));
}

function renderDeepDiveItems(items) {
  if (items.length === 0) return '<div class="empty">No action items for this selection.</div>';
  return items.map((it) => `
    <div class="worker-card">
      <div class="row">
        <span class="id">${escapeHtmlBright(it.title)}</span>
        <span class="badge ${it.rating === 'Use' ? 'ok' : it.rating === 'Adapt' ? 'warn' : 'idle'}">${escapeHtml(it.rating || '')}</span>
      </div>
      <div class="meta">${escapeHtml(it.community || '')}${it.files ? ' · ' + escapeHtml(it.files) : ''}</div>
      <div style="margin-top:8px">${escapeHtml(it.rationale || '')}</div>
    </div>
  `).join('');
}

function renderDeepDiveCommunityRows(detail, selectedIdx, items) {
  const rows = [];
  (detail.communities || []).forEach((c, i) => {
    const hasItems = (c.actionItemCount || 0) > 0;
    rows.push(`
      <tr class="${hasItems ? 'clickable' : ''} ${selectedIdx === i ? 'top-row' : ''}" data-community-idx="${i}">
        <td>${escapeHtml(c.name || '')}</td>
        <td>${c.lastReviewedAt ? new Date(c.lastReviewedAt).toLocaleString() : 'not yet reviewed'}</td>
        <td>${c.actionItemCount ?? '-'}</td>
      </tr>
    `);
    if (selectedIdx === i) {
      const shown = itemsForCommunity(items, { id: i, name: c.name });
      rows.push(`
        <tr>
          <td colspan="3" style="padding:0">
            <div style="padding:12px 4px 16px">
              <div class="field-label" style="margin-top:0">Ideas from "${escapeHtml(c.name)}" <a href="#" id="dd-collapse" style="margin-left:8px;font-weight:normal">(collapse)</a></div>
              ${renderDeepDiveItems(shown)}
            </div>
          </td>
        </tr>
      `);
    }
  });
  return rows.join('');
}

function renderDeepDiveDetailBody(detail, selectedIdx) {
  const items = detail.items || [];
  let html = `<div class="field-label">Communities (${(detail.communities || []).length}) -- click one with action items to see them inline</div>`;
  html += `<table><thead><tr><th>Name</th><th>Reviewed</th><th>Action Items</th></tr></thead><tbody>${renderDeepDiveCommunityRows(detail, selectedIdx, items)}</tbody></table>`;

  if (selectedIdx == null) {
    html += `<div class="field-label">All ideas picked from this repo</div>`;
    html += items.length === 0
      ? '<div class="empty">Nothing written up yet -- no community from this repo has cleared review.</div>'
      : renderDeepDiveItems(items);
  }
  return html;
}

function wireDeepDiveDetailHandlers(slug, selectedIdx) {
  document.querySelectorAll('#modal-content tr.clickable[data-community-idx]').forEach((row) => {
    const idx = Number(row.dataset.communityIdx);
    // Clicking the already-expanded row collapses it back rather than re-expanding it.
    row.onclick = () => openDeepDiveDetail(slug, idx === selectedIdx ? null : idx);
  });
  const collapse = document.getElementById('dd-collapse');
  if (collapse) collapse.onclick = (e) => { e.preventDefault(); openDeepDiveDetail(slug, null); };
}

async function openDeepDiveDetail(slug, selectedIdx = null) {
  const backdrop = document.getElementById('modal-backdrop');
  const content = document.getElementById('modal-content');

  // Re-opening the same project (selecting a different community) reuses the cached
  // fetch instead of re-fetching -- the underlying data can't have changed within one
  // modal session, and re-fetch would also flicker the "which row is highlighted" state.
  const detail = (deepDiveDetailCache && deepDiveDetailCache.slug === slug)
    ? deepDiveDetailCache
    : await fetchJson('/api/deep-dive/projects/' + encodeURIComponent(slug));
  deepDiveDetailCache = detail;

  let html = `<button class="close" onclick="closeDetail()">&times;</button><h2>${escapeHtml(detail.slug)}</h2>`;
  if (detail.sourceUrl) html += `<div><a href="${escapeAttr(detail.sourceUrl)}" target="_blank">${escapeHtml(detail.sourceUrl)}</a></div>`;
  html += renderDeepDiveDetailBody(detail, selectedIdx);

  content.innerHTML = html;
  backdrop.classList.add('open');
  wireDeepDiveDetailHandlers(slug, selectedIdx);
}

async function renderDiscoveryTab() {
  const d = await fetchJson('/api/discovery');
  discoveryCandidatesCache = d.candidates || [];
  const main = document.getElementById('main');
  if (!d.available) {
    main.innerHTML = '<div class="empty">No discovery state found for the active project -- community-coverage.json and the candidates doc appear once the project graph is built and arch_discovery has run.</div>';
    return;
  }

  const reviewed = d.communities.filter(c => c.lastReviewedAt).length;
  const inFlight = d.tasks.filter(t => t.state !== 'done');
  const doneRuns = d.tasks.filter(t => t.state === 'done');
  const nextCommunity = d.communities.find(c => c.id === d.nextCommunityId);
  const stats = `
    <div class="stat-row">
      <div class="stat"><strong>${reviewed} / ${d.communities.length}</strong>communities reviewed</div>
      <div class="stat"><strong>${inFlight.length}</strong>runs in flight</div>
      <div class="stat"><strong>${doneRuns.length}</strong>runs completed</div>
      <div class="stat"><strong>${d.candidates.length}</strong>candidates produced</div>
      <div class="stat"><strong>${nextCommunity ? escapeHtml(nextCommunity.name) : '--'}</strong>next up</div>
    </div>`;

  // Same order the job itself works in (nextArchDiscoveryTask's oldest-first rotation,
  // never-reviewed before any real timestamp), so the top of the table is always "what
  // discovery cares about right now".
  const sortedCommunities = [...d.communities].sort((a, b) =>
    (a.lastReviewedAt || '').localeCompare(b.lastReviewedAt || ''));
  // Only rows with something to say (in queue, next up, or actually reviewed) show by
  // default; the untouched tail collapses to a one-line count.
  const interesting = sortedCommunities.filter(c =>
    c.inFlightState || c.id === d.nextCommunityId || c.lastReviewedAt);
  const communities = discoveryShowAllCommunities ? sortedCommunities : interesting;
  const hiddenCount = sortedCommunities.length - communities.length;
  const communityRows = communities.map(c => {
    const status = c.inFlightState
      ? `<span class="badge warn">in queue: ${escapeHtml(c.inFlightState)}</span>`
      : c.id === d.nextCommunityId
        ? '<span class="badge ok">next up</span>'
        : c.lastReviewedAt
          ? '<span class="badge idle">reviewed</span>'
          : '<span class="badge idle">never reviewed</span>';
    return `<tr>
      <td>#${c.id} ${escapeHtml(c.name || '')}</td>
      <td>${status}</td>
      <td>${c.lastReviewedAt ? new Date(c.lastReviewedAt).toLocaleString() : ''}</td>
      <td>${c.lastCandidateCount ?? ''}</td>
    </tr>`;
  }).join('');

  const stateBadge = (s) => {
    const cls = s === 'done' ? 'ok' : s === 'blocked' ? 'bad'
      : (s === 'needs-clarification' || s === 'awaiting-confirm') ? 'warn' : 'idle';
    return `<span class="badge ${cls}">${escapeHtml(s)}</span>`;
  };
  const runRows = d.tasks.map(t => {
    // Whichever field carries the run's actual outcome -- same signal priority as
    // _adhoc_task_excerpt server-side.
    const result = t.blockedReason
      ? `<span style="color:var(--bad)">${escapeHtmlBright(t.blockedReason.slice(0, 140))}${t.blockedReason.length > 140 ? '…' : ''}</span>`
      : t.doneMarker
        ? escapeHtml(t.doneMarker)
        : t.hasImplement ? 'draft written' : t.hasPlan ? 'plan written' : '';
    return `<tr class="clickable" data-task-id="${escapeAttr(t.id)}" title="Click for the full readout (plan, draft, review verdicts)">
      <td>${escapeHtmlBright(t.title)}</td>
      <td>${stateBadge(t.state)}</td>
      <td>${t.createdAt ? new Date(t.createdAt).toLocaleString() : ''}</td>
      <td class="meta">${result}</td>
    </tr>`;
  }).join('');
  const runsTable = d.tasks.length === 0
    ? '<div class="empty">No arch-discovery runs in the queue yet.</div>'
    : `<table><thead><tr><th>Run</th><th>State</th><th>Created</th><th>Result</th></tr></thead><tbody>${runRows}</tbody></table>`;

  const candidateRows = d.candidates.map(c => `
    <tr class="clickable" data-candidate-id="${c.id}" title="Click to read the full write-up">
      <td><span class="bd-serial">AC-${String(c.id).padStart(3, '0')}</span></td>
      <td>${escapeHtmlBright(c.title)} <button class="secondary" data-discovery-send-to-chat="${c.id}" title="Send this candidate's title and write-up to the System Chat panel as a message -- no AI call, works even while the local model is busy">Send to Chat</button></td>
      <td>${c.strength ? `<span class="badge ${c.strength === 'Strong' ? 'ok' : 'idle'}">${escapeHtml(c.strength)}</span>` : ''}</td>
      <td class="meta">${c.files.slice(0, 3).map(escapeHtml).join(', ')}${c.files.length > 3 ? ` +${c.files.length - 3} more` : ''}</td>
    </tr>`).join('');
  const candidatesTable = d.candidates.length === 0
    ? '<div class="empty">No candidates written yet.</div>'
    : `<table><thead><tr><th>ID</th><th>Candidate</th><th>Strength</th><th>Files</th></tr></thead><tbody>${candidateRows}</tbody></table>`;

  const communityToggle = (discoveryShowAllCommunities || hiddenCount > 0)
    ? `<div style="margin:8px 0 0"><button class="secondary" id="discovery-show-all">${
        discoveryShowAllCommunities
          ? 'Show active communities only'
          : `Show all ${sortedCommunities.length} communities (${hiddenCount} never reviewed hidden)`
      }</button></div>`
    : '';

  // Runs and candidates first -- they're what this tab exists to surface; the (large)
  // community rotation table is reference material below them.
  main.innerHTML = stats
    + `<div class="field-label">Discovery Runs</div>` + runsTable
    + `<div class="field-label">Candidates Produced${d.candidatesPath ? ` <span style="text-transform:none;letter-spacing:0">(${escapeHtml(d.candidatesPath)})</span>` : ''}</div>`
    + candidatesTable
    + `<div class="field-label">Communities (rotation order)</div>`
    + `<table><thead><tr><th>Community</th><th>Status</th><th>Last Reviewed</th><th>Candidates Last Run</th></tr></thead><tbody>${communityRows}</tbody></table>`
    + communityToggle;

  main.querySelectorAll('tr[data-task-id]').forEach(row => {
    row.onclick = () => openTaskAnywhere(row.dataset.taskId);
  });
  main.querySelectorAll('tr[data-candidate-id]').forEach(row => {
    row.onclick = () => openDiscoveryCandidate(parseInt(row.dataset.candidateId, 10));
  });

  // "Send to Chat": dumps this arch_discovery candidate's title + write-up into the
  // System Chat panel as a user message (via sendTextToChat -> POST /api/chat/inject,
  // no model call) so a follow-up can be had about it. Same pattern as
  // concepts-and-adhoc-tab.js's concept cards: wired here (not inlined in an onclick)
  // so the payload isn't quote-escaping trouble, and hard-capped at <=200 chars
  // before sendTextToChat.
  main.querySelectorAll('[data-discovery-send-to-chat]').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation(); // keep the row's own click (open the full write-up) from firing too
      btn.disabled = true;
      try {
        const candidate = discoveryCandidatesCache.find((x) => x.id === parseInt(btn.dataset.discoverySendToChat, 10));
        if (!candidate) { showToast('Could not send to chat: that candidate is no longer in the list.'); return; }
        const parts = [`AC-${String(candidate.id).padStart(3, '0')}: ${candidate.title}`];
        if (candidate.content) parts.push(candidate.content);
        let text = parts.join('\n\n');
        if (text.length > 200) text = text.slice(0, 199) + '…'; // hard cap: sendTextToChat must never receive >200 chars
        await sendTextToChat(text); // POSTs { text } to /api/chat/inject, no model call
        showToast('Sent to chat', 'info');
      } catch (err) {
        showToast('Could not send to chat: ' + err.message);
      } finally {
        btn.disabled = false;
      }
    };
  });
  const toggleBtn = document.getElementById('discovery-show-all');
  if (toggleBtn) toggleBtn.onclick = () => {
    discoveryShowAllCommunities = !discoveryShowAllCommunities;
    renderDiscoveryTab();
  };
}

function openDiscoveryCandidate(id) {
  const c = discoveryCandidatesCache.find(x => x.id === id);
  if (!c) return;
  const content = document.getElementById('modal-content');
  content.innerHTML = `<button class="close" onclick="closeDetail()">&times;</button>`
    + `<h2>AC-${String(c.id).padStart(3, '0')} · ${escapeHtmlBright(c.title)}</h2>`
    + `<pre>${escapeHtml(c.content)}</pre>`;
  document.getElementById('modal-backdrop').classList.add('open');
}

async function openJobLog(source) {
  const content = document.getElementById('modal-content');
  let data;
  try {
    data = await fetchJson(`/api/job-log/${encodeURIComponent(source)}`);
  } catch (e) {
    alert('Could not load job log: ' + e.message);
    return;
  }
  const stateBadge = (s) => {
    const cls = s === 'done' ? 'ok' : s === 'blocked' ? 'bad'
      : (s === 'needs-clarification' || s === 'awaiting-confirm') ? 'warn' : 'idle';
    return `<span class="badge ${cls}">${escapeHtml(s)}</span>`;
  };
  const rows = (data.runs || []).map((r) => `
    <tr class="clickable" data-task-id="${escapeAttr(r.id)}" title="Open this run's task log">
      <td>${escapeHtmlBright(r.title || r.id)}</td>
      <td>${stateBadge(r.state)}</td>
      <td>${r.at ? new Date(r.at).toLocaleString() : ''}</td>
      <td class="meta">${escapeHtml((r.outcome || '').slice(0, 140))}${(r.outcome || '').length > 140 ? '…' : ''}</td>
    </tr>`).join('');
  const body = (data.runs || []).length === 0
    ? `<div class="empty">No runs of <code>${escapeHtml(source)}</code> in the queue yet.</div>`
    : `<table><thead><tr><th>Run</th><th>State</th><th>When</th><th>Outcome</th></tr></thead><tbody>${rows}</tbody></table>`;
  content.innerHTML = `<button class="close" onclick="closeDetail()">&times;</button>`
    + `<h2>Job Log · ${escapeHtml(source)}</h2>`
    + `<div class="meta" style="margin-bottom:10px">Showing ${(data.runs || []).length} of ${data.total} run(s), newest first.</div>`
    + body;
  document.getElementById('modal-backdrop').classList.add('open');
  content.querySelectorAll('tr[data-task-id]').forEach((row) => {
    row.onclick = () => openTaskAnywhere(row.dataset.taskId);
  });
}

// 2026-09-08, Grimmethy ("too many line breaks, just break between paragraphs headers and
// bullets"): a hand-authored concept description hard-wraps one logical paragraph across
// several source lines (~80-100 chars each) -- this used to treat every non-blank line as
// its own <p>, so a single paragraph rendered as a stack of tiny ones instead of flowing
// text. Standard markdown paragraph semantics instead: consecutive plain-text lines
// accumulate into ONE paragraph (joined with a space, not a break), and a paragraph only
// closes on a blank line, a header, or a list item. Machine-generated report content
// (system-report.js's renderMarkdown) already pushes one fact/sentence per array entry
// with no internal hard-wrapping, so this is a no-op there -- purely additive for the
// concept-description case this was actually reported against.
function renderReportMarkdown(md) {
  // Long-word brightness rule (core-ui.js's escapeHtmlBright/markLongWords/
  // unmarkToBrightSpans): mark BEFORE escaping so sentinels survive every other
  // transform in this function untouched, unmark as the LAST step below.
  const lines = escapeHtml(markLongWords(md)).split('\n');
  let html = '';
  let inList = false;
  let para = null;
  let li = null; // accumulates one list item's text, including hard-wrapped continuation lines
  const closeLi = () => { if (li !== null) { html += `<li>${li}</li>`; li = null; } };
  const closeList = () => { closeLi(); if (inList) { html += '</ul>'; inList = false; } };
  const closePara = () => { if (para !== null) { html += `<p>${para}</p>`; para = null; } };
  const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  for (const line of lines) {
    if (line.startsWith('## ')) { closePara(); closeList(); html += `<h3>${inline(line.slice(3))}</h3>`; }
    else if (line.startsWith('# ')) { closePara(); closeList(); html += `<h2>${inline(line.slice(2))}</h2>`; }
    else if (line.startsWith('- ')) { closePara(); closeLi(); if (!inList) { html += '<ul>'; inList = true; } li = inline(line.slice(2)); }
    else if (line.trim() === '') { closePara(); closeList(); }
    // A hard-wrapped continuation line of the CURRENT list item (e.g. a source line
    // starting with leading spaces right after a `- ` line) stays part of that bullet,
    // not a new paragraph -- same "only break between paragraphs, headers, and bullets"
    // rule this whole function exists to enforce.
    else if (inList && li !== null) { li = `${li} ${inline(line.trim())}`; }
    else { closeList(); para = para === null ? inline(line) : `${para} ${inline(line)}`; }
  }
  closePara();
  closeList();
  return unmarkToBrightSpans(html);
}

async function openReportDetail(period, filename) {
  const backdrop = document.getElementById('modal-backdrop');
  const content = document.getElementById('modal-content');
  let report;
  try {
    report = await fetchJson(`/api/reports/${encodeURIComponent(period)}/${encodeURIComponent(filename)}`);
  } catch (e) {
    content.innerHTML = `<button class="close" onclick="closeDetail()">&times;</button><div class="empty">Error loading report: ${escapeHtml(e.message)}</div>`;
    backdrop.classList.add('open');
    return;
  }
  content.innerHTML = `<button class="close" onclick="closeDetail()">&times;</button>${renderReportMarkdown(report.content)}`;
  backdrop.classList.add('open');
}

async function renderReportsTab() {
  const main = document.getElementById('main');
  try {
    reportsListCache = await fetchJson('/api/reports');
  } catch (e) {
    main.innerHTML = `<div class="empty">Error loading reports: ${escapeHtml(e.message)}</div>`;
    return;
  }

  const filterBar = `
    <div class="row" style="margin-bottom:12px">
      ${['all', 'hourly', 'daily', 'weekly'].map(p => `<button class="${reportsPeriodFilter === p ? 'active' : ''}" data-report-filter="${p}">${p[0].toUpperCase()}${p.slice(1)}</button>`).join('')}
    </div>`;

  const visible = reportsPeriodFilter === 'all' ? reportsListCache : reportsListCache.filter(r => r.period === reportsPeriodFilter);

  if (visible.length === 0) {
    main.innerHTML = filterBar + '<div class="empty">No reports generated yet -- the pipeline files an hourly report as soon as the first hour elapses since it started tracking.</div>';
  } else {
    const rows = visible.map(r => `
      <tr class="clickable" data-open-report-period="${escapeAttr(r.period)}" data-open-report-filename="${escapeAttr(r.filename)}">
        <td><span class="badge">${escapeHtml(r.period)}</span></td>
        <td>${escapeHtml(r.filename)}</td>
        <td>${fmtAge((Date.now() - new Date(r.generatedAt).getTime()) / 1000)} ago</td>
      </tr>`).join('');
    main.innerHTML = filterBar + `<table><thead><tr><th>Period</th><th>Report</th><th>Generated</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  main.querySelectorAll('[data-report-filter]').forEach((btn) => {
    btn.onclick = () => { reportsPeriodFilter = btn.dataset.reportFilter; renderReportsTab(); };
  });
  main.querySelectorAll('[data-open-report-period]').forEach((row) => {
    row.onclick = () => openReportDetail(row.dataset.openReportPeriod, row.dataset.openReportFilename);
  });
}

async function renderTokenfoldTab() {
  const main = document.getElementById('main');
  const data = await fetchJson('/api/tokenfold/stats');
  const openBtn = (port) => `<button onclick="window.open('http://' + location.hostname + ':${port}/tokenfold/dashboard', '_blank')">Open full TokenFold dashboard ↗</button>`;
  if (!data.available) {
    main.innerHTML = `<div class="empty">TokenFold proxy is not running on port ${escapeHtml(String(data.port))} -- it starts automatically with scripts/launch.sh when a tokenfold checkout is installed next to this repo (set AGENT_MANAGER_TOKENFOLD=false to turn that off).</div>`;
    return;
  }
  const s = data.stats || {};
  const modelRows = (s.by_model || []).map(m => `
    <tr><td>${escapeHtml(m.model || '')}</td><td>${(m.n ?? 0).toLocaleString()}</td>
    <td>${(m.saved ?? 0).toLocaleString()}</td><td>${m.avg_pct ?? 0}%</td></tr>`).join('');
  main.innerHTML = `
    <div class="row" style="margin-bottom:12px">${openBtn(escapeAttr(String(data.port)))}</div>
    <div style="font-size:2rem;font-weight:700">${(s.saved ?? 0).toLocaleString()} tokens saved${s.reduction_pct != null ? ` (${s.reduction_pct}%)` : ''}</div>
    <div class="meta" style="margin:6px 0 16px">${(s.n ?? 0).toLocaleString()} requests · original ${(s.orig ?? 0).toLocaleString()} → encoded ${(s.enc ?? 0).toLocaleString()} tokens${s.avg_latency != null ? ` · avg encode ${Number(s.avg_latency).toFixed(1)} ms` : ''}${s.fallback_pct != null ? ` · fallback rate ${Number(s.fallback_pct).toFixed(1)}%` : ''}</div>
    ${modelRows ? `<table><thead><tr><th>Model</th><th>Requests</th><th>Tokens saved</th><th>Avg %</th></tr></thead><tbody>${modelRows}</tbody></table>` : '<div class="empty">No model calls have gone through the proxy yet -- numbers appear as soon as the pipeline makes its first call.</div>'}`;
}

async function renderPromptForgeTab() {
  const main = document.getElementById('main');
  let url = 'http://' + location.hostname + ':7430/';
  try {
    const cfg = await fetchJson('/api/promptforge/config');
    if (cfg && cfg.url) url = cfg.url.replace('localhost', location.hostname);
  } catch (e) { /* fall back to the default host:7430 */ }
  const existing = main.querySelector('iframe.promptforge-frame');
  if (existing) {
    if (existing.getAttribute('src') !== url) existing.setAttribute('src', url);
    return;
  }
  main.innerHTML = `<iframe class="viz promptforge-frame" src="${escapeAttr(url)}" style="width:100%;height:calc(100vh - 120px);border:2px solid var(--border);border-radius:8px"></iframe>`;
}

async function renderAdForgeTab() {
  const main = document.getElementById('main');
  let url = 'http://' + location.hostname + ':7431/';
  try {
    const cfg = await fetchJson('/api/adforge/config');
    if (cfg && cfg.url) url = cfg.url.replace('localhost', location.hostname);
  } catch (e) { /* fall back to the default host:7431 */ }
  const existing = main.querySelector('iframe.adforge-frame');
  if (existing) {
    if (existing.getAttribute('src') !== url) existing.setAttribute('src', url);
    return;
  }
  main.innerHTML = `<iframe class="viz adforge-frame" src="${escapeAttr(url)}" style="width:100%;height:calc(100vh - 120px);border:2px solid var(--border);border-radius:8px"></iframe>`;
}

async function renderScriptForgeTab() {
  const main = document.getElementById('main');
  let url = 'http://' + location.hostname + ':7432/';
  try {
    const cfg = await fetchJson('/api/scriptforge/config');
    if (cfg && cfg.url) url = cfg.url.replace('localhost', location.hostname);
  } catch (e) { /* fall back to the default host:7432 */ }
  const existing = main.querySelector('iframe.scriptforge-frame');
  if (existing) {
    if (existing.getAttribute('src') !== url) existing.setAttribute('src', url);
    return;
  }
  main.innerHTML = `<iframe class="viz scriptforge-frame" src="${escapeAttr(url)}" style="width:100%;height:calc(100vh - 120px);border:2px solid var(--border);border-radius:8px"></iframe>`;
}
