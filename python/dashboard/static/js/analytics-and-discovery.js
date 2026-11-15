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

// "Show leads scouted for other projects" -- off by default: the tab lists exactly what THIS project's pipeline works on.
let ddShowAll = false;

function ddStatusLabel(p) {
  if (p.status === 'queued') return '<span class="pill" title="Tagged for this project: the next worker tick clones and graphs it">queued to clone</span>';
  if (p.status === 'other-project') return '<span class="pill" title="Scouted for a different project: this pipeline will not work on it">other project</span>';
  return '';
}

async function renderDeepDiveTab() {
  const projects = await fetchJson('/api/deep-dive/projects' + (ddShowAll ? '?scope=all' : ''));
  const main = document.getElementById('main');
  const showAllToggle = `<label class="muted" style="margin-left:12px"><input type="checkbox" id="dd-show-all" ${ddShowAll ? 'checked' : ''}> also show leads scouted for other projects</label>`;
  const bar = DEEP_DIVE_ADD_BAR.replace('</div>', showAllToggle + '</div>');
  const wireToggle = () => {
    const cb = document.getElementById('dd-show-all');
    if (cb) cb.onchange = () => { ddShowAll = cb.checked; renderDeepDiveTab(); };
  };
  if (projects.length === 0) {
    main.innerHTML = bar + '<div class="empty">No repos scouted for this project yet -- project_search hasn\'t landed a Strong lead tagged for it, or add one above.</div>';
    wireDeepDiveAddBar();
    wireToggle();
    return;
  }
  const rows = projects.map(p => `
    <tr class="clickable ${p.hotlist ? 'top-row' : ''} ${p.status === 'other-project' ? 'muted' : ''}" data-slug="${escapeAttr(p.slug)}" data-status="${escapeAttr(p.status || 'cloned')}">
      <td onclick="event.stopPropagation()"><input type="checkbox" class="hotlist-toggle" data-slug="${escapeAttr(p.slug)}" ${p.hotlist ? 'checked' : ''} ${p.status === 'cloned' ? '' : 'disabled'} title="Move this repo to the top of the research priority list (available once it has been cloned)"></td>
      <td>${escapeHtml(p.slug)} ${ddStatusLabel(p)}</td>
      <td>${p.relevantTo ? escapeHtml(p.relevantTo) : ''}</td>
      <td title="${escapeAttr(p.description || '')}">${escapeHtml(p.reason || '')}</td>
      <td>${p.sourceUrl ? `<a href="${escapeAttr(p.sourceUrl)}" target="_blank" onclick="event.stopPropagation()">${escapeHtml(p.sourceUrl)}</a>` : ''}</td>
      <td>${p.reviewedCount} / ${p.communityCount}</td>
      <td>${p.totalActionItems}</td>
      <td>${p.clonedAt ? new Date(p.clonedAt).toLocaleString() : ''}</td>
    </tr>
  `).join('');
  main.innerHTML = bar + `<div class="table-scroll"><table><thead><tr><th>Hot</th><th>Project</th><th>Scouted for</th><th>Why it matters there</th><th>Source</th><th>Communities Reviewed</th><th>Action Items</th><th>Cloned</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  wireDeepDiveAddBar();
  wireToggle();
  main.querySelectorAll('tr.clickable').forEach(row => {
    // only a cloned lead has communities/analysis to open
    if (row.dataset.status === 'cloned') row.onclick = () => openDeepDiveDetail(row.dataset.slug);
    else row.style.cursor = 'default';
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
