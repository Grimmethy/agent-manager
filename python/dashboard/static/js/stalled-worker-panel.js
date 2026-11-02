// Stalled-task worker panel for the Workers tab (agent-manager-pipeline-ops). The worker is a CLI run by a user systemd timer, not a lane, so this panel is how it
// shows up: mode, whether its timer is active, how long ago it last ran, this hour's token budget, how many tasks are stalled and in which buckets, today's
// decisions, the questions waiting for the owner, and the most recent decisions. A plain global <script> (no require/module.exports), loaded by index.html right after
// cloud-spend-panel.js; workers-tab.js appends renderStalledWorkerSection(payload). `payload` is the GET /api/stalled-worker body (routes/stalled_worker.py). All
// functions are pure string builders (no DOM, no fetch), so they are unit-testable in a bare vm context.

function stalledWorkerEsc(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function stalledWorkerInt(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// 45 -> '45s', 125 -> '2m', 7300 -> '2h 1m', 200000 -> '2d 7h'; unknown -> ''.
function stalledWorkerAge(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const s = Math.floor(seconds);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 48) return h + 'h ' + (m % 60) + 'm';
  return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
}

function stalledWorkerModeBadge(mode) {
  if (mode === 'on') return '<span class="badge ok" title="The worker archives, requeues and files for real">live</span>';
  if (mode === 'off') return '<span class="badge idle" title="STALLED_WORKER_MODE=off: the worker does nothing">off</span>';
  if (mode === 'dry-run') return '<span class="badge hold" title="The worker only writes what it WOULD do to its ledger; no queue changes">dry-run</span>';
  return '<span class="badge idle" title="No decision has been recorded yet">no runs yet</span>';
}

function stalledWorkerTimerBadge(active) {
  if (active === true) return '<span class="badge ok" title="The user systemd timer stalled-tick.timer is running">timer on</span>';
  if (active === false) return '<span class="badge warn" title="stalled-tick.timer is not running, so no new ticks happen">timer stopped</span>';
  return '<span class="badge idle" title="The timer state could not be read">timer unknown</span>';
}

// The operator's on/off switch (the marker file the worker's tick checks first). `sw` is payload.switch: {disabled, disabledAt}.
function stalledWorkerSwitchBadge(sw) {
  if (!sw || sw.disabled !== true) return '';
  const since = sw.disabledAt ? ' since ' + stalledWorkerEsc(sw.disabledAt) : '';
  return '<span class="badge idle" title="Switched off' + since + ': the worker\'s ticks do nothing until you turn it back on">switched off</span>';
}

function stalledWorkerSwitchButton(sw) {
  const off = !!(sw && sw.disabled === true);
  const title = off
    ? 'Switch the worker back on: it starts working again at its next tick (within 10 minutes).'
    : 'Switch the worker off: new ticks do nothing (a tick already running finishes). The timer keeps running; nothing is deleted.';
  return '<button type="button" class="secondary stalled-switch-btn" data-next-enabled="' + (off ? 'true' : 'false') + '" title="' + stalledWorkerEsc(title)
    + '" style="margin-left:8px">' + (off ? '\u23FB Turn on' : '\u23FB Turn off') + '</button>';
}

function stalledWorkerBudgetLine(p) {
  const b = p.budget;
  const source = [p.provider, p.model].filter(Boolean).map(stalledWorkerEsc).join(' · ');
  if (!b || !Number.isFinite(Number(b.perHour))) {
    const why = p.gateway && p.gateway.error ? ' (' + stalledWorkerEsc(p.gateway.error) + ')' : '';
    return '<div class="meta" style="margin-top:4px">Model gateway not reachable' + why + '.</div>';
  }
  const pct = Number(b.perHour) > 0 ? Math.round((Number(b.used) / Number(b.perHour)) * 100) : 0;
  return '<div style="margin-top:4px">' + (source ? '<span class="meta">' + source + '</span> · ' : '')
    + stalledWorkerInt(b.used) + ' of ' + stalledWorkerInt(b.perHour) + ' tokens this hour (' + pct + '%)'
    + (Number(b.used) >= Number(b.perHour) ? ' <span class="badge warn" title="The gateway answers 429 until older calls leave the 60-minute window">budget spent</span>' : '') + '</div>';
}

function stalledWorkerStalledLine(stalled) {
  if (!stalled) return '<div class="meta" style="margin-top:4px">No stalled-task index yet.</div>';
  const top = (stalled.topBuckets || []).map((b) => '<div class="meta" style="margin-left:12px">'
    + stalledWorkerInt(b.count) + ' · ' + stalledWorkerEsc(b.state) + ' · ' + stalledWorkerEsc(String(b.signature || '(no reason recorded)').slice(0, 110)) + '</div>').join('');
  return '<div style="margin-top:8px"><strong>' + stalledWorkerInt(stalled.total) + '</strong> stalled across ' + stalledWorkerInt(stalled.projects) + ' projects</div>' + top;
}

function stalledWorkerTodayLine(p) {
  const entries = Object.entries(p.today || {}).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return '<div class="meta" style="margin-top:8px">No decisions today.</div>';
  return '<div style="margin-top:8px"><strong>Today</strong> ' + entries.map(([k, n]) => stalledWorkerEsc(k) + ' ' + stalledWorkerInt(n)).join(' · ') + '</div>';
}

function stalledWorkerHoldsHtml(holds) {
  if (!holds || !holds.length) return '';
  const rows = holds.map((h) => '<div style="margin-left:12px">' + stalledWorkerEsc(h.question || '(no question recorded)')
    + ' <span class="meta">' + stalledWorkerEsc(h.project) + ' · ' + stalledWorkerEsc(String(h.taskId || '').slice(0, 60))
    + (Number.isFinite(h.ageS) ? ' · ' + stalledWorkerEsc(stalledWorkerAge(h.ageS)) : '') + (h.dryRun ? ' · dry-run' : '') + '</span></div>').join('');
  return '<div style="margin-top:8px"><strong>Waiting for you</strong>' + rows + '</div>';
}

function stalledWorkerRecentHtml(recent) {
  if (!recent || !recent.length) return '';
  const rows = recent.map((r) => '<div class="meta" style="margin-left:12px">' + stalledWorkerEsc(String(r.at || '').slice(11, 16)) + ' · ' + stalledWorkerEsc(r.outcome)
    + ' · ' + stalledWorkerEsc(r.project) + ' · ' + stalledWorkerEsc(String(r.taskId || '').slice(0, 48)) + (r.mode === 'dry-run' ? ' · dry-run' : '') + '</div>').join('');
  return '<div style="margin-top:8px"><strong>Recent</strong>' + rows + '</div>';
}

function buildStalledWorkerHtml(p) {
  if (!p || !p.configured) return '';
  const off = !!(p.switch && p.switch.disabled === true);
  const box = 'padding:12px 16px; background:var(--panel); border:1px solid var(--border); border-radius:8px; margin:12px 0;' + (off ? ' opacity:.65;' : '');
  const age = stalledWorkerAge(p.lastTickAgeS);
  const title = '<div style="font-weight:600">\u{1F9F9} Stalled-task worker ' + (off ? stalledWorkerSwitchBadge(p.switch) : stalledWorkerModeBadge(p.mode)) + ' ' + stalledWorkerTimerBadge(p.timerActive)
    + stalledWorkerSwitchButton(p.switch) + '</div>';
  const last = '<div class="meta" style="margin-top:4px">' + (age ? 'Last tick ' + stalledWorkerEsc(age) + ' ago' : 'No tick recorded yet')
    + (p.decisions !== undefined ? ' · ' + stalledWorkerInt(p.decisions) + ' decisions in the ledger tail' : '') + '</div>';
  return '<div id="stalled-worker-panel" style="' + box + '">' + title + last + stalledWorkerBudgetLine(p) + stalledWorkerStalledLine(p.stalled)
    + stalledWorkerTodayLine(p) + stalledWorkerHoldsHtml(p.holds) + stalledWorkerRecentHtml(p.recent) + '</div>';
}

// What renderWorkers() appends: nothing at all unless the worker has left any trace (ledger, index, running timer or a reachable gateway).
function renderStalledWorkerSection(payload) {
  return buildStalledWorkerHtml(payload);   // returns '' itself unless payload.configured
}

// POST the switch, then redraw the Workers tab (same flow as worker-switch-ui.js setWorkerEnabled). Returns true on success.
async function setStalledWorkerEnabled(enabled) {
  const verb = enabled ? 'on' : 'off';
  let res;
  try {
    res = await fetch('/api/stalled-worker/enabled', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) });
  } catch (e) {
    showToast('Could not switch the stalled-task worker ' + verb + ': ' + e.message);
    return false;
  }
  if (!res.ok) {
    let why = 'HTTP ' + res.status;
    try { const body = await res.json(); why = body.error || why; } catch (e) { /* keep the HTTP status */ }
    showToast('Could not switch the stalled-task worker ' + verb + ': ' + why);
    return false;
  }
  await renderWorkers();
  return true;
}

function wireStalledWorkerSwitch(root) {
  root.querySelectorAll('.stalled-switch-btn').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      btn.disabled = true;
      const ok = await setStalledWorkerEnabled(btn.dataset.nextEnabled === 'true');
      if (!ok) btn.disabled = false;       // a failed switch leaves the panel as it was, and the button usable
    };
  });
}
