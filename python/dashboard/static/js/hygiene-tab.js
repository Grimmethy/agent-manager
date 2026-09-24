// Hygiene tab (2026-09-19, Grimmethy): a read-only picture of how much hygiene work is waiting, for the ACTIVE project
// (whatever the Project tab targets). Hygiene findings live in scanner flag files and candidate docs, so the queue only
// shows the slice already tasked -- this joins every stage: flags -> candidates -> tasks -> awaiting your merge.
// Backend: GET /api/hygiene/inventory (routes/hygiene.py, src/hygiene-inventory.js). Nothing here writes.
//
// Like Brain Dump / Filed Findings / Branches, this tab opts out of the generic 5s full re-render (branches-joblist-
// hardware-tabs.js's refresh()): expanding a family and reading its list must not be wiped mid-click. It runs its own
// 30s poll instead (enterHygieneTab / leaveHygieneTab, wired in core-ui.js).

let hygieneData = null;
let hygieneError = null;
let hygieneExpanded = null;          // family key currently expanded
let hygieneFlagFilter = 'waiting';
let hygieneCandFilter = 'all';
let hygienePollTimer = null;
let hygieneLoading = false;
const HYGIENE_POLL_MS = 30000;
const HYGIENE_LIST_CAP = 100;

const HYGIENE_STATUS_BADGE = {
  waiting: 'warn', ineligible: 'bad', stale: 'idle', 'awaiting-merge': 'warn', queued: 'idle', blocked: 'bad',
  done: 'ok', digest: 'idle', suppressed: 'idle', 'not-actionable': 'idle',
};

// What each flag status means -- shown as the badge tooltip and the header tooltip. "suppressed" and "done: noop/dismissed" read as
// "nothing happened" but mean the opposite: a review already looked and judged the flag not worth a change.
const HYGIENE_STATUS_HELP = {
  waiting: 'A worker will pick this up next.',
  queued: 'A task for it is in the pipeline.',
  blocked: 'Its task needs a human decision.',
  done: 'Reviewed and closed -- see the disposition. dismissed / noop = the review found nothing to change (a scanner false positive).',
  digest: 'Low confidence: not reviewed yet; will be reviewed in the daily batched digest task.',
  suppressed: 'A review already judged this a false positive (or it was suppressed by hand); it is not re-reviewed.',
  stale: 'The file changed or is gone, so the flag no longer applies. (Change review: the commit is older than the review window, so it was aged out and will not be reviewed.)',
};

function hygieneBadge(status, title) {
  const cls = HYGIENE_STATUS_BADGE[status] || 'idle';
  const tip = title || HYGIENE_STATUS_HELP[status] || '';
  return `<span class="badge ${cls}"${tip ? ` title="${escapeAttr(tip)}"` : ''}>${escapeHtml(status)}</span>`;
}

function hygieneDate(iso) {
  return iso ? String(iso).slice(0, 10) : '';
}

async function enterHygieneTab() {
  renderHygieneShell();
  await loadHygiene();
  if (hygienePollTimer) clearInterval(hygienePollTimer);
  hygienePollTimer = setInterval(() => { if (activeTab === 'hygiene') loadHygiene({ quiet: true }); }, HYGIENE_POLL_MS);
}

function leaveHygieneTab() {
  if (hygienePollTimer) clearInterval(hygienePollTimer);
  hygienePollTimer = null;
}

// renderMain() dispatches here; identical to entering the tab minus the timer (enterHygieneTab owns that).
async function renderHygieneTab() {
  renderHygieneShell();
  if (hygieneData) renderHygiene();
  await loadHygiene();
}

function renderHygieneShell() {
  document.getElementById('main').innerHTML = '<div id="hygiene-root"><div class="empty">Loading hygiene inventory...</div></div>';
}

async function loadHygiene({ refresh = false, quiet = false } = {}) {
  if (hygieneLoading) return;
  hygieneLoading = true;
  try {
    // A cold inventory of a big repo can take ~15s the first time, so allow more than fetchJson's 8s default.
    hygieneData = await fetchJson('/api/hygiene/inventory' + (refresh ? '?refresh=1' : ''), { timeoutMs: 60000 });
    hygieneError = null;
  } catch (e) {
    hygieneError = e.message;
    if (quiet && hygieneData) { hygieneLoading = false; return; } // keep showing the last good data on a background miss
  }
  hygieneLoading = false;
  if (activeTab === 'hygiene') renderHygiene();
}

function renderHygiene() {
  const root = document.getElementById('hygiene-root');
  if (!root) return;
  if (hygieneError && !hygieneData) { root.innerHTML = `<div class="empty">Could not load the hygiene inventory: ${escapeHtml(hygieneError)}</div>`; return; }
  const d = hygieneData;
  if (!d || d.available === false) { root.innerHTML = `<div class="empty">Hygiene inventory unavailable: ${escapeHtml((d && d.reason) || 'unknown')}</div>`; return; }

  const t = d.totals || {};
  const waiting = (t.waitingFlags || 0) + (t.waitingCandidates || 0);
  const est = d.estimate && d.estimate.available ? d.estimate : null;
  const estText = est ? (est.hours >= 1 ? `≈ ${est.hours} h` : `≈ ${Math.round(est.seconds / 60)} min`) : '—';
  const estTitle = est
    ? `${est.note}. ${est.unitsWithoutBasis ? est.unitsWithoutBasis + ' unit(s) have too little history to estimate. ' : ''}`
    : (d.estimate && d.estimate.reason) || 'no estimate available';

  const stat = (n, label, title, cls) => `<div class="stat" title="${escapeAttr(title)}"><strong${cls ? ` style="color:var(--${cls})"` : ''}>${n}</strong>${escapeHtml(label)}</div>`;
  const notes = (d.notes || []).map((n) => `<div class="stat" style="color:var(--warn)">${escapeHtml(n)}</div>`).join('');

  root.innerHTML = `
    <div class="field-label" style="display:flex; justify-content:space-between; align-items:center;">
      <span>Hygiene backlog for <strong style="color:var(--text)">${escapeHtml(d.projectTag)}</strong> -- read-only. Switch projects on the Project tab.</span>
      <span><span class="stat" style="display:inline">updated ${escapeHtml(hygieneDate(d.generatedAt))} ${escapeHtml(String(d.generatedAt || '').slice(11, 19))}Z</span>
        <button class="secondary" id="hygiene-refresh" style="margin-left:8px">Refresh</button></span>
    </div>
    <div class="stat-row">
      ${stat(waiting, 'waiting on a worker', 'Scanner flags a review will pick up next, plus Strong candidates a fix/review task will be created for.', waiting ? 'warn' : '')}
      ${stat(t.inFlight || 0, 'in flight', 'Tasks pending, drafting, in review or approved.', '')}
      ${stat(t.needsHuman || 0, 'need your decision', 'Tasks blocked, needing clarification, awaiting confirm, or coordinating.', t.needsHuman ? 'bad' : '')}
      ${stat(t.awaitingMerge || 0, 'awaiting your merge', 'Work pushed to a branch (candidates or fixes) that is not on the default branch yet.', t.awaitingMerge ? 'warn' : '')}
      ${stat(t.stuckCandidates || 0, 'stuck', 'Strong candidates the pipeline will NEVER pick up as written: oversized, waiting on a dependency that is not merged, or a placeholder body.', t.stuckCandidates ? 'bad' : '')}
      ${stat(estText, 'of model time', estTitle, '')}
    </div>
    ${notes}
    ${(d.families || []).length ? '' : '<div class="empty">No hygiene task sources are registered for this project -- load the agent-manager-hygiene plugin (Plugins tab) to see its backlog here.</div>'}
    <table>
      <thead><tr>
        <th>Family</th><th title="Scanner flags: waiting / total for this project">Flags</th><th title="Candidates in the docs: waiting · stuck · awaiting merge">Candidates</th>
        <th>In flight</th><th>Need you</th><th title="Finished tasks: merged / dismissed / no-op / other">Done</th><th>Oldest waiting</th>
      </tr></thead>
      <tbody>${(d.families || []).map((f) => hygieneFamilyRows(f)).join('')}</tbody>
    </table>
    ${hygieneFileLength(d.fileLength)}
    <div class="stat" style="margin-top:14px">Flag counts are approximate: the review re-locates each flag against the current file and can discard it as stale when it gets there. Candidate "stuck" reasons mirror the real fulfillment rules.</div>
  `;
  const btn = document.getElementById('hygiene-refresh');
  if (btn) btn.onclick = async () => { btn.disabled = true; btn.textContent = 'Refreshing...'; await loadHygiene({ refresh: true }); };
  root.querySelectorAll('tr[data-hyg-family]').forEach((row) => {
    row.onclick = () => { hygieneExpanded = hygieneExpanded === row.dataset.hygFamily ? null : row.dataset.hygFamily; renderHygiene(); };
  });
  const ff = document.getElementById('hyg-flag-filter'); if (ff) ff.onchange = (e) => { hygieneFlagFilter = e.target.value; renderHygiene(); };
  const cf = document.getElementById('hyg-cand-filter'); if (cf) cf.onchange = (e) => { hygieneCandFilter = e.target.value; renderHygiene(); };
}

function hygieneFamilyRows(f) {
  const fl = f.flags; const c = f.candidates && f.candidates.totals; const o = f.open || {}; const tk = f.tasks || { done: {} };
  const done = tk.done || {};
  const otherDone = Object.entries(done).filter(([k]) => !['merged', 'dismissed', 'noop'].includes(k)).reduce((n, [, v]) => n + v, 0);
  const flagsCell = fl ? `<strong style="color:var(--${fl.counts.waiting ? 'warn' : 'muted'})">${fl.counts.waiting}</strong> / ${fl.total}` : '<span class="stat">—</span>';
  const candCell = c ? `${c.waiting} · <span style="color:var(--${c.ineligible ? 'bad' : 'muted'})">${c.ineligible}</span> · ${c.awaitingMerge}` : '<span class="stat">—</span>';
  const doneCell = `${done.merged || 0} / ${done.dismissed || 0} / ${done.noop || 0}${otherDone ? ' / ' + otherDone : ''}`;
  const open = hygieneExpanded === f.key;
  const row = `<tr class="clickable" data-hyg-family="${escapeAttr(f.key)}">
    <td>${open ? '▾' : '▸'} ${escapeHtml(f.label)}</td><td>${flagsCell}</td><td>${candCell}</td>
    <td>${o.inFlight || 0}</td><td style="color:var(--${o.needsHuman ? 'bad' : 'muted'})">${o.needsHuman || 0}</td><td>${doneCell}</td>
    <td>${fl && fl.oldestWaitingAt ? escapeHtml(hygieneDate(fl.oldestWaitingAt)) : ''}</td></tr>`;
  return open ? row + `<tr><td colspan="7" style="background:var(--panel)">${hygieneFamilyDetail(f)}</td></tr>` : row;
}

function hygieneFamilyDetail(f) {
  const parts = [];
  const fl = f.flags;
  if (fl) {
    const statuses = ['waiting', 'blocked', 'queued', 'done', 'digest', 'suppressed', 'stale'];
    const shown = fl.items.filter((i) => hygieneFlagFilter === 'all' || i.status === hygieneFlagFilter);
    parts.push(`<div class="field-label" style="display:flex; justify-content:space-between">
      <span title="${escapeAttr(statuses.map((s) => `${s}: ${HYGIENE_STATUS_HELP[s]}`).join('\n'))}">Scanner flags -- ${escapeHtml(statuses.map((s) => `${s} ${fl.counts[s] || 0}`).join(' · '))}</span>
      <select id="hyg-flag-filter" style="text-transform:none; letter-spacing:normal; font-size:12px">
        ${['waiting', 'all', ...statuses.filter((s) => s !== 'waiting')].map((s) => `<option value="${s}" ${hygieneFlagFilter === s ? 'selected' : ''}>${s}</option>`).join('')}
      </select></div>
      ${shown.length ? `<table><thead><tr><th>Rule</th><th>Where</th><th>Conf.</th><th>Scanned</th><th>Status</th></tr></thead><tbody>
        ${shown.slice(0, HYGIENE_LIST_CAP).map((i) => `<tr><td>${escapeHtml(i.rule || '')}</td><td>${escapeHtml((i.file || '(repo)') + (i.line ? ':' + i.line : ''))}</td><td>${escapeHtml(i.confidence || '')}</td><td>${escapeHtml(hygieneDate(i.scannedAt))}</td>
        <td>${hygieneBadge(i.status)} ${i.taskState ? `<span class="stat" style="display:inline">${escapeHtml(i.taskState + (i.disposition ? ': ' + i.disposition : ''))}</span>` : ''}</td></tr>`).join('')}
      </tbody></table>${shown.length > HYGIENE_LIST_CAP ? `<div class="stat">showing the first ${HYGIENE_LIST_CAP} of ${shown.length}</div>` : ''}${fl.truncated ? '<div class="stat">the flag list itself was capped by the server; counts above cover every flag</div>' : ''}`
        : '<div class="empty">No flags with this status.</div>'}`);
  }
  const docs = f.candidates && f.candidates.docs;
  if (docs && docs.some((x) => x.total)) {
    const statuses = ['all', 'waiting', 'ineligible', 'awaiting-merge', 'queued', 'blocked', 'done', 'not-actionable'];
    parts.push(`<div class="field-label" style="display:flex; justify-content:space-between"><span>Candidates</span>
      <select id="hyg-cand-filter" style="text-transform:none; letter-spacing:normal; font-size:12px">${statuses.map((s) => `<option value="${s}" ${hygieneCandFilter === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>`);
    for (const doc of docs.filter((x) => x.total)) {
      const items = doc.items.filter((i) => hygieneCandFilter === 'all' || i.status === hygieneCandFilter);
      parts.push(`<div class="stat" style="margin:8px 0 4px">${escapeHtml(doc.relPath)} -- ${escapeHtml(Object.entries(doc.byStatus).map(([k, v]) => `${k} ${v}`).join(' · '))}</div>
        ${items.length ? `<table><thead><tr><th>ID</th><th>Strength</th><th>Title</th><th>Status</th></tr></thead><tbody>
        ${items.slice(0, HYGIENE_LIST_CAP).map((i) => `<tr><td>${escapeHtml(i.id)}</td><td>${escapeHtml(i.strength)}</td><td>${escapeHtml(i.title)}<div class="stat">${escapeHtml(i.files || '')}</div></td>
          <td>${hygieneBadge(i.status, i.reason)} ${i.reason ? `<div class="stat">${escapeHtml(i.reason)}</div>` : ''}${i.location && i.location !== 'main' ? `<div class="stat">${escapeHtml(i.location)}</div>` : ''}${i.taskState ? `<div class="stat">${escapeHtml(i.taskState + (i.disposition ? ': ' + i.disposition : ''))}</div>` : ''}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">No candidates with this status.</div>'}`);
    }
  }
  const tk = f.tasks || {};
  parts.push(`<div class="stat" style="margin-top:10px">Tasks (${tk.total || 0}): ${escapeHtml(Object.entries(tk.byState || {}).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none open')}
    -- by source: ${escapeHtml(Object.entries(tk.bySource || {}).map(([k, v]) => `${k} ${v}`).join(', ') || 'none')}${tk.archivedOlder ? ` -- ${tk.archivedOlder} older archived` : ''}</div>`);
  return parts.join('');
}

function hygieneFileLength(fl) {
  if (!fl || !fl.total) return '';
  return `<div class="stat" style="margin-top:14px"><strong style="color:var(--text)">${fl.total}</strong> oversized file(s) flagged by the advisory file-length scan -- nothing tasks these automatically.
    ${escapeHtml((fl.items || []).slice(0, 8).map((i) => i.file + (i.lines ? ` (${i.lines})` : '')).join(', '))}${fl.total > 8 ? ', ...' : ''}</div>`;
}
