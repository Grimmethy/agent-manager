// Branch-verifier card for the Workers tab (agent-manager-pipeline-ops). The verifier is a CLI run by a user systemd timer, not a lane, so this card is how it shows up:
// same layout as the lane workers and the stalled-task card (id left; mode badge, timer badge, "last tick" and the Turn on/off button stacked right; one meta line; click the
// card to open the history). A plain global <script> of pure string builders (no DOM, no fetch, no require), loaded by index.html after stalled-worker-panel.js;
// workers-tab.js appends renderVerifierWorkerSection(payload). `payload` is the GET /api/branch-verifier body (routes/verifier_worker.py).

function verifierWorkerEsc(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function verifierWorkerInt(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function verifierWorkerCut(text, max) {
  const t = String(text === undefined || text === null ? '' : text);
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

// 45 -> '45s', 125 -> '2m', 7300 -> '2h 1m', 200000 -> '2d 7h'; unknown -> ''.
function verifierWorkerAge(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const s = Math.floor(seconds);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 48) return h + 'h ' + (m % 60) + 'm';
  return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
}

function verifierWorkerModeBadge(mode) {
  if (mode === 'on') return '<span class="badge ok" title="The verifier records its verdicts on the branch cards for real">live</span>';
  if (mode === 'off') return '<span class="badge idle" title="VERIFIER_MODE=off: the verifier does nothing">off</span>';
  if (mode === 'dry-run') return '<span class="badge hold" title="The verifier only writes what it WOULD record to its ledger; no card changes">dry-run</span>';
  return '<span class="badge idle" title="No decision has been recorded yet">no runs yet</span>';
}

function verifierWorkerTimerBadge(active) {
  if (active === true) return '<span class="badge ok" title="The user systemd timer verify-tick.timer is running">timer on</span>';
  if (active === false) return '<span class="badge warn" title="verify-tick.timer is not running, so no new ticks happen">timer stopped</span>';
  return '<span class="badge idle" title="The timer state could not be read">timer unknown</span>';
}

function verifierWorkerSwitchBadge(sw) {
  if (!sw) return '';   // only called for a switched-off verifier
  const since = sw.disabledAt ? ' since ' + verifierWorkerEsc(sw.disabledAt) : '';
  return '<span class="badge idle" title="Switched off' + since + ': the verifier\'s ticks do nothing until you turn it back on">switched off</span>';
}

function verifierWorkerSwitchButton(sw) {
  const off = !!(sw && sw.disabled === true);
  const title = off
    ? 'Switch the verifier back on: it starts verifying again at its next tick (within a minute).'
    : 'Switch the verifier off: new ticks do nothing (a tick already running finishes). The timer keeps running; nothing is deleted.';
  return '<button type="button" class="secondary verifier-switch-btn" data-next-enabled="' + (off ? 'true' : 'false') + '" title="' + verifierWorkerEsc(title)
    + '" style="margin-top:4px">' + (off ? '⏻ Turn on' : '⏻ Turn off') + '</button>';
}

// Open/closed state of the history section; a click on the card flips it and redraws.
let verifierWorkerExpanded = false;

// "merge 4 · needs-work 2 · no verdict 1"; the collapsed card shows the biggest three and a "+n more".
function verifierWorkerTodayText(p, limit) {
  const entries = Object.entries(p.today || {}).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return 'no verdicts today';
  const shown = entries.slice(0, limit || entries.length).map(([k, n]) => verifierWorkerEsc(k) + ' ' + verifierWorkerInt(n)).join(' · ');
  return shown + (limit && entries.length > limit ? ' +' + (entries.length - limit) + ' more' : '');
}

function verifierWorkerCountsText(p) {
  const failed = Number(p.failedToday) > 0 ? ' · <span class="badge warn" title="Posts that failed, were refused or found the branch head moved; the branch is looked at again later">' + verifierWorkerInt(p.failedToday) + ' failed</span>' : '';
  return verifierWorkerInt(p.recordedToday) + ' recorded today' + failed;
}

function verifierWorkerIndexText(indexed) {
  return indexed ? verifierWorkerInt(indexed.branches) + ' pushed branches indexed' : 'no branch index yet';
}

function verifierWorkerRecentHtml(recent) {
  if (!recent || !recent.length) return '<div class="meta" style="margin-top:8px">No verdicts recorded yet.</div>';
  const rows = recent.map((r) => '<div class="meta" style="margin-top:2px" title="' + verifierWorkerEsc(r.branch) + ' — ' + verifierWorkerEsc(r.reason) + '">'
    + verifierWorkerEsc(String(r.at || '').slice(11, 16)) + ' · ' + verifierWorkerEsc(r.verdict || 'no verdict') + ' · ' + verifierWorkerEsc(r.project) + ' · '
    + verifierWorkerEsc(verifierWorkerCut(r.branch, 60)) + (r.mode === 'dry-run' ? ' · dry-run' : '') + (r.result ? ' · ' + verifierWorkerEsc(verifierWorkerCut(r.result, 40)) : '') + '</div>').join('');
  return '<div style="margin-top:8px"><strong>Verifier history</strong>' + rows + '</div>';
}

function buildVerifierWorkerHtml(p) {
  if (!p || !p.configured) return '';
  const off = !!(p.switch && p.switch.disabled === true);
  const open = verifierWorkerExpanded === true;
  const age = verifierWorkerAge(p.lastTickAgeS);
  const head = '<div class="row"><span class="id">✅ branch-verifier</span><div class="badge-col">'
    + (off ? verifierWorkerSwitchBadge(p.switch) : verifierWorkerModeBadge(p.mode)) + ' ' + verifierWorkerTimerBadge(p.timerActive)
    + '<span class="state-timer">' + (age ? 'last tick ' + verifierWorkerEsc(age) + ' ago' : 'no tick recorded yet') + '</span>'
    + verifierWorkerSwitchButton(p.switch) + '</div></div>';
  const meta = '<div class="meta">' + verifierWorkerCountsText(p) + ' · ' + verifierWorkerIndexText(p.indexed) + ' · today: ' + verifierWorkerTodayText(p, 3) + '</div>';
  const toggle = '<div class="meta" style="margin-top:4px">' + (open ? '▾ Hide history' : '▸ Show history') + (p.decisions !== undefined ? ' (' + verifierWorkerInt(p.decisions) + ' decisions)' : '') + '</div>';
  const detail = open ? '<div class="worker-recent-tasks"><div class="meta" style="margin-top:8px"><strong>Today</strong> ' + verifierWorkerTodayText(p) + '</div>'
    + verifierWorkerRecentHtml(p.recent) + '</div>' : '';
  return '<div id="verifier-worker-panel" class="worker-card clickable' + (off ? ' worker-off' : '') + '" data-verifier-expand="1" aria-expanded="' + open + '">'
    + head + meta + toggle + detail + '</div>';
}

// What renderWorkers() appends: nothing at all unless the verifier has left any trace (ledger, index, running timer or a switched-off marker).
function renderVerifierWorkerSection(payload) {
  return buildVerifierWorkerHtml(payload);   // returns '' itself unless payload.configured
}

// POST the switch, then redraw the Workers tab. Returns true on success.
async function setVerifierWorkerEnabled(enabled) {
  const verb = enabled ? 'on' : 'off';
  let res;
  try {
    res = await fetch('/api/branch-verifier/enabled', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) });
  } catch (e) {
    showToast('Could not switch the branch verifier ' + verb + ': ' + e.message);
    return false;
  }
  if (!res.ok) {
    let why = 'HTTP ' + res.status;
    try { const body = await res.json(); why = body.error || why; } catch (e) { /* keep the HTTP status */ }
    showToast('Could not switch the branch verifier ' + verb + ': ' + why);
    return false;
  }
  await renderWorkers();
  return true;
}

function wireVerifierWorkerSwitch(root) {
  root.querySelectorAll('.verifier-switch-btn').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      btn.disabled = true;
      const ok = await setVerifierWorkerEnabled(btn.dataset.nextEnabled === 'true');
      if (!ok) btn.disabled = false;
    };
  });
}

// Click anywhere on the card (but the Turn on/off button, which stops propagation) opens or closes the history.
function wireVerifierWorkerExpand(root, redraw) {
  root.querySelectorAll('[data-verifier-expand]').forEach((card) => {
    card.onclick = () => { verifierWorkerExpanded = !verifierWorkerExpanded; if (typeof redraw === 'function') redraw(); };
  });
}
