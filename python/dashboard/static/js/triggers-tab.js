// Triggers tab: the data trail of host memory pressure, so we know what needs optimising. GET /api/triggers/memory-pressure folds the gpu-broker's journal
// (~/.local/state/gpu-broker/mem-pressure-journal.jsonl) into episodes (pressure opened -> closed), the processes that were biggest when pressure hit, a daily view and the
// reasons it triggered. A plain global <script> (declarations only): buildTriggersMemoryHtml is a pure string builder, testable in a bare vm context. The tab renders when it is
// opened and when a window button is clicked: no timer (ADR-0024, static/js/no-timer-redraws.test.js).

let triggersDays = 14;

function triggersEsc(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function triggersDuration(seconds) {
  const s = Number(seconds);
  if (seconds === null || seconds === undefined || !Number.isFinite(s)) return 'open';
  if (s >= 3600) return (s / 3600).toFixed(1) + ' h';
  if (s >= 60) return Math.round(s / 60) + ' min';
  return Math.round(s) + ' s';
}

const triggersLevelBadge = (level) => `<span class="badge ${level === 'critical' ? 'bad' : 'warn'}">${triggersEsc(level)}</span>`;
const triggersBar = (fraction) => `<span style="display:inline-block;height:8px;width:${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}px;background:var(--accent);vertical-align:middle"></span>`;
const triggersCard = (label, value, note) => `<div style="min-width:120px"><div class="meta">${triggersEsc(label)}</div><div style="font-size:1.5rem;font-weight:700">${triggersEsc(value)}</div>${note ? `<div class="meta">${triggersEsc(note)}</div>` : ''}</div>`;
const triggersTable = (head, rows) => `<table><thead><tr>${head.map((h) => `<th>${triggersEsc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;

// The window buttons plus the memory-pressure trail for `body` (the route's payload); an empty-state sentence when there is nothing to show.
function buildTriggersMemoryHtml(body, days) {
  const win = [7, 14, 30, 90].map((n) => `<button${n === days ? ' class="active"' : ''} onclick="setTriggersDays(${n})">${n} days</button>`).join(' ');
  const head = `<h2 style="margin:0 0 8px">Memory pressure</h2><div class="row" style="margin-bottom:12px">${win}</div>`;
  const b = body && typeof body === 'object' ? body : {};
  const s = b.summary || {};
  if (!b.source || !b.source.exists) return head + `<div class="empty">No memory-pressure journal found${b.source && b.source.path ? ' at ' + triggersEsc(b.source.path) : ''}. The gpu-broker writes it on every pressure change.</div>`;
  if (!s.episodes) return head + `<div class="empty">No pressure episodes in the last ${triggersEsc(b.days || days)} days.</div>`;
  const window = (b.days || days) * 86400;
  const cards = [
    triggersCard('Episodes', s.episodes, `${(s.by_level || {}).critical || 0} critical, ${(s.by_level || {}).tight || 0} tight${s.open ? ', ' + s.open + ' open' : ''}`),
    triggersCard('Time paused', triggersDuration(s.total_pause_s), Math.round((s.total_pause_s / window) * 100) + '% of the window'),
    triggersCard('Longest', triggersDuration(s.longest_pause_s)),
    triggersCard('Lowest available', s.min_available_mb == null ? '-' : s.min_available_mb + ' MB'),
    triggersCard('Would-refuse', s.refused_total || 0, 'new work held back (dry-run)'),
  ].join('');
  const offenders = triggersTable(['Process', 'In episodes', 'Share', 'Avg MB', 'Max MB'], (s.top_offenders || []).map((o) =>
    `<tr><td>${triggersEsc(o.label)}</td><td>${triggersEsc(o.episodes)}</td><td>${triggersBar(o.share)} ${Math.round(o.share * 100)}%</td><td>${triggersEsc(o.avg_rss_mb)}</td><td>${triggersEsc(o.max_rss_mb)}</td></tr>`));
  const byDay = triggersTable(['Day (UTC)', 'Episodes', 'Paused', 'Peak'], (s.by_day || []).slice().reverse().map((d) =>
    `<tr><td>${triggersEsc(d.day)}</td><td>${triggersEsc(d.episodes)}</td><td>${triggersBar(d.paused_s / 86400)} ${triggersDuration(d.paused_s)}</td><td>${triggersLevelBadge(d.peak_level)}</td></tr>`));
  const reasons = triggersTable(['Why it triggered', 'Count'], (s.reasons || []).map((r) => `<tr><td>${triggersEsc(r.reason)}</td><td>${triggersEsc(r.count)}</td></tr>`));
  const recent = triggersTable(['Started', 'Length', 'Level', 'Lowest available', 'Reason', 'Biggest at the time'], (b.episodes || []).slice(0, 25).map((e) =>
    `<tr><td>${triggersEsc(e.start)}</td><td>${triggersDuration(e.pause_s)}</td><td>${triggersLevelBadge(e.level)}</td><td>${e.min_available_mb == null ? '-' : triggersEsc(e.min_available_mb) + ' MB'}</td><td>${triggersEsc(e.reason)}</td>` +
    `<td>${(e.top || []).slice(0, 3).map((p) => triggersEsc(p.label) + ' ' + triggersEsc(p.rss_mb) + ' MB').join(', ')}</td></tr>`));
  return head + `<div class="row" style="gap:24px;margin-bottom:16px">${cards}</div>`
    + `<h3>What was biggest when pressure hit</h3><div class="meta" style="margin-bottom:6px">The five largest processes at the moment each episode opened: what to optimise.</div>${offenders}`
    + `<h3>By day</h3>${byDay}<h3>Why it triggered</h3>${reasons}<h3>Recent episodes</h3>${recent}`;
}

async function renderTriggersTab() {
  const main = document.getElementById('main');
  main.innerHTML = buildTriggersMemoryHtml(await fetchJson('/api/triggers/memory-pressure?days=' + triggersDays), triggersDays);
}

function setTriggersDays(days) {
  triggersDays = days;
  return renderTriggersTab();
}
