// Needs-Work worker card for the Workers tab (agent-manager-pipeline-ops docs/needs-work-worker.md). Like the branch verifier it is a CLI started by the watchdog trigger (no timer),
// not a lane: same layout as the verifier card (id left; mode badge, trigger badge, "last tick" and the Turn on/off button stacked right; one meta line; click the card to open
// the history and the questions waiting for you). A plain global <script> of pure string builders (no DOM, no fetch, no require), loaded by index.html after
// verifier-worker-panel.js; workers-tab.js appends renderNeedsworkWorkerSection(payload). `payload` is the GET /api/needswork-worker body (routes/needswork_worker.py).

function needsworkWorkerEsc(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function needsworkWorkerInt(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function needsworkWorkerCut(text, max) {
  const t = String(text === undefined || text === null ? '' : text);
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

// 45 -> '45s', 125 -> '2m', 7300 -> '2h 1m', 200000 -> '2d 7h'; unknown -> ''.
function needsworkWorkerAge(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const s = Math.floor(seconds);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 48) return h + 'h ' + (m % 60) + 'm';
  return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
}

function needsworkWorkerModeBadge(mode) {
  if (mode === 'on') return '<span class="badge ok" title="The Needs-Work worker files replacement and mechanism tasks for real">live</span>';
  if (mode === 'off') return '<span class="badge idle" title="NEEDSWORK_MODE=off: the worker does nothing">off</span>';
  if (mode === 'dry-run') return '<span class="badge hold" title="The worker only writes what it WOULD do to its ledger; no task is filed">dry-run</span>';
  return '<span class="badge idle" title="No decision has been recorded yet">no runs yet</span>';
}

// The watchdog trigger (no timer): `t` is payload.trigger {state: 'listening' | 'draining' | 'backlog' | 'idle', endedAgeS, stopped} or null when it has never run.
// The watchdog calls the trigger about once a minute and it rewrites its heartbeat every time, so a heartbeat older than this means the watchdog or the plugin entry is broken.
const needsworkWorkerTriggerSilentS = 300;

function needsworkWorkerTriggerBadge(t) {
  const ended = t && Number.isFinite(t.endedAgeS) ? ' The last drain ended ' + needsworkWorkerAge(t.endedAgeS) + ' ago' + (t.stopped ? ' (' + needsworkWorkerEsc(t.stopped) + ')' : '') + '.' : '';
  const checked = t && Number.isFinite(t.checkedAgeS) ? ' Checked ' + needsworkWorkerAge(t.checkedAgeS) + ' ago.' : '';
  if (t && t.state === 'listening') return '<span class="badge ok" title="The worker is up and waiting: it reacts within seconds of a push or any change it watches.">listening</span>';
  if (t && t.state === 'draining') return '<span class="badge ok" title="A drain is running: the watchdog saw new input and the worker is ticking through it.">draining</span>';
  if (t && Number.isFinite(t.checkedAgeS) && t.checkedAgeS > needsworkWorkerTriggerSilentS) return '<span class="badge warn" title="The watchdog has not called the trigger for ' + needsworkWorkerAge(t.checkedAgeS) + '. It normally does about once a minute: check the watchdog and watchdogScripts on the plugins.json entry.">trigger silent</span>';
  if (t && t.state === 'backlog') return '<span class="badge warn" title="The last drain stopped at its cap with work left; the next watchdog tick continues it.' + ended + checked + '">backlog</span>';
  if (t && t.state === 'idle') return '<span class="badge ok" title="The watchdog trigger is armed: it starts a drain when the input changes.' + ended + checked + '">trigger on</span>';
  return '<span class="badge warn" title="The watchdog trigger has not run yet. Check that watchdogScripts for this worker is set on its plugins.json entry.">no trigger yet</span>';
}

// "trigger checked 12s ago" for the meta line; empty when there is no heartbeat to show.
function needsworkWorkerTriggerCheckedText(t) {
  return t && Number.isFinite(t.checkedAgeS) ? 'trigger checked ' + needsworkWorkerAge(t.checkedAgeS) + ' ago' : '';
}

function needsworkWorkerSwitchBadge(sw) {
  if (!sw) return '';   // only called for a switched-off worker
  const since = sw.disabledAt ? ' since ' + needsworkWorkerEsc(sw.disabledAt) : '';
  return '<span class="badge idle" title="Switched off' + since + ': the worker\'s ticks do nothing until you turn it back on">switched off</span>';
}

function needsworkWorkerSwitchButton(sw) {
  const off = !!(sw && sw.disabled === true);
  const title = off
    ? 'Switch the Needs-Work worker back on: it decides again at its next tick (within a minute).'
    : 'Switch the Needs-Work worker off: new ticks do nothing (a tick already running finishes). The watchdog trigger keeps running; nothing is deleted.';
  return '<button type="button" class="secondary needswork-switch-btn" data-next-enabled="' + (off ? 'true' : 'false') + '" title="' + needsworkWorkerEsc(title)
    + '" style="margin-top:4px">' + (off ? '⏻ Turn on' : '⏻ Turn off') + '</button>';
}

// Open/closed state of the history section; a click on the card flips it and redraws.
let needsworkWorkerExpanded = false;

// How many questions a collapsed card shows, and how long a question may be before it is cut (the full text stays in the tooltip).
const needsworkWorkerHoldLimit = 2;
const needsworkWorkerQuestionChars = 90;

// "FILE-REPLACEMENT-TASK 4 · HOLD-FOR-OWNER 2"; the collapsed card shows the biggest three and a "+n more".
function needsworkWorkerTodayText(p, limit) {
  const entries = Object.entries(p.today || {}).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return 'no decisions today';
  const shown = entries.slice(0, limit || entries.length).map(([k, n]) => needsworkWorkerEsc(k) + ' ' + needsworkWorkerInt(n)).join(' · ');
  return shown + (limit && entries.length > limit ? ' +' + (entries.length - limit) + ' more' : '');
}

function needsworkWorkerCountsText(p) {
  const failed = Number(p.failedToday) > 0 ? ' · <span class="badge warn" title="Actions that failed or were refused; the branch is looked at again later">' + needsworkWorkerInt(p.failedToday) + ' failed</span>' : '';
  return needsworkWorkerInt(p.actedToday) + ' acted today' + failed;
}

function needsworkWorkerBacklogText(b) {
  return b && Number(b.total) > 0 ? needsworkWorkerInt(b.total) + ' branches with a decision' : 'no branch decided yet';
}

// The questions waiting for the owner: at most `limit` of them, each cut at needsworkWorkerQuestionChars with the full question and the recommendation in the tooltip.
function needsworkWorkerHoldsHtml(p, limit) {
  const holds = Array.isArray(p.holds) ? p.holds : [];
  if (!holds.length) return '';
  const shown = limit ? holds.slice(0, limit) : holds;
  const total = Number.isFinite(p.holdCount) ? p.holdCount : holds.length;
  const rows = shown.map((h) => '<div class="meta" style="margin-top:2px" title="' + needsworkWorkerEsc(h.question) + (h.recommendation ? ' — Recommended: ' + needsworkWorkerEsc(h.recommendation) : '') + '">'
    + '<span class="badge warn">question</span> ' + needsworkWorkerEsc(needsworkWorkerCut(h.question, needsworkWorkerQuestionChars))
    + (h.recommendation ? ' → ' + needsworkWorkerEsc(needsworkWorkerCut(h.recommendation, needsworkWorkerQuestionChars)) : '')
    + ' · ' + needsworkWorkerEsc(needsworkWorkerCut(h.branch, 50)) + (h.ageS !== null && h.ageS !== undefined ? ' · ' + needsworkWorkerEsc(needsworkWorkerAge(h.ageS)) : '') + '</div>').join('');
  const more = total > shown.length ? '<div class="meta" style="margin-top:2px">+' + (total - shown.length) + ' more waiting</div>' : '';
  return '<div style="margin-top:6px">' + rows + more + '</div>';
}

function needsworkWorkerRecentHtml(recent) {
  if (!recent || !recent.length) return '<div class="meta" style="margin-top:8px">No decisions recorded yet.</div>';
  const rows = recent.map((r) => '<div class="meta" style="margin-top:2px" title="' + needsworkWorkerEsc(r.branch) + ' — ' + needsworkWorkerEsc(r.reason) + '">'
    + needsworkWorkerEsc(String(r.at || '').slice(11, 16)) + ' · ' + needsworkWorkerEsc(r.outcome || 'no action') + ' · ' + needsworkWorkerEsc(r.project) + ' · '
    + needsworkWorkerEsc(needsworkWorkerCut(r.branch, 60)) + (r.mode === 'dry-run' ? ' · dry-run' : '') + (r.result ? ' · ' + needsworkWorkerEsc(needsworkWorkerCut(r.result, 40)) : '') + '</div>').join('');
  return '<div style="margin-top:8px"><strong>Needs-Work history</strong>' + rows + '</div>';
}

function buildNeedsworkWorkerHtml(p) {
  if (!p || !p.configured) return '';
  const off = !!(p.switch && p.switch.disabled === true);
  const open = needsworkWorkerExpanded === true;
  const age = needsworkWorkerAge(p.lastTickAgeS);
  const head = '<div class="row"><span class="id">🛠 needs-work</span><div class="badge-col">'
    + (off ? needsworkWorkerSwitchBadge(p.switch) : needsworkWorkerModeBadge(p.mode)) + ' ' + needsworkWorkerTriggerBadge(p.trigger)
    + '<span class="state-timer">' + (age ? 'last tick ' + needsworkWorkerEsc(age) + ' ago' : 'no tick recorded yet') + '</span>'
    + needsworkWorkerSwitchButton(p.switch) + '</div></div>';
  const meta = '<div class="meta">' + needsworkWorkerCountsText(p) + ' · ' + needsworkWorkerBacklogText(p.backlog)
    + (needsworkWorkerTriggerCheckedText(p.trigger) ? ' · ' + needsworkWorkerTriggerCheckedText(p.trigger) : '') + ' · today: ' + needsworkWorkerTodayText(p, 3) + '</div>';
  const holds = needsworkWorkerHoldsHtml(p, open ? 0 : needsworkWorkerHoldLimit);
  const toggle = '<div class="meta" style="margin-top:4px">' + (open ? '▾ Hide history' : '▸ Show history') + (p.decisions !== undefined ? ' (' + needsworkWorkerInt(p.decisions) + ' decisions)' : '') + '</div>';
  const detail = open ? '<div class="worker-recent-tasks"><div class="meta" style="margin-top:8px"><strong>Today</strong> ' + needsworkWorkerTodayText(p) + '</div>'
    + needsworkWorkerRecentHtml(p.recent) + '</div>' : '';
  return '<div id="needswork-worker-panel" class="worker-card clickable' + (off ? ' worker-off' : '') + '" data-needswork-expand="1" aria-expanded="' + open + '">'
    + head + meta + holds + toggle + detail + '</div>';
}

// What renderWorkers() appends: nothing at all unless the worker has left any trace (ledger, trigger state or a switched-off marker).
function renderNeedsworkWorkerSection(payload) {
  return buildNeedsworkWorkerHtml(payload);   // returns '' itself unless payload.configured
}

// POST the switch, then redraw the Workers tab. Returns true on success.
async function setNeedsworkWorkerEnabled(enabled) {
  const verb = enabled ? 'on' : 'off';
  let res;
  try {
    res = await fetch('/api/needswork-worker/enabled', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) });
  } catch (e) {
    showToast('Could not switch the Needs-Work worker ' + verb + ': ' + e.message);
    return false;
  }
  if (!res.ok) {
    let why = 'HTTP ' + res.status;
    try { const body = await res.json(); why = body.error || why; } catch (e) { /* keep the HTTP status */ }
    showToast('Could not switch the Needs-Work worker ' + verb + ': ' + why);
    return false;
  }
  await renderWorkers();
  return true;
}

function wireNeedsworkWorkerSwitch(root) {
  root.querySelectorAll('.needswork-switch-btn').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      btn.disabled = true;
      const ok = await setNeedsworkWorkerEnabled(btn.dataset.nextEnabled === 'true');
      if (!ok) btn.disabled = false;
    };
  });
}

// Click anywhere on the card (but the Turn on/off button, which stops propagation) opens or closes the history.
function wireNeedsworkWorkerExpand(root, redraw) {
  root.querySelectorAll('[data-needswork-expand]').forEach((card) => {
    card.onclick = () => { needsworkWorkerExpanded = !needsworkWorkerExpanded; if (typeof redraw === 'function') redraw(); };
  });
}
