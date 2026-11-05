// Cards for the agent-manager-pipeline-ops workers built on src/worker-kit.js (the poll scout, then the merge-ready checker, the merger and the idle-cost steward) for the Workers tab.
// Like the branch verifier and the Needs-Work worker they are CLIs started by the watchdog trigger (no timer), not lanes: same layout as the Needs-Work card (id left; mode badge, trigger
// badge, "last tick" and the Turn on/off button stacked right; one meta line; click the card to open the history and the questions waiting for you). ONE data-driven card for every
// worker: a plain global <script> of pure string builders (no DOM, no fetch, no require), loaded by index.html after needswork-worker-panel.js; workers-tab.js appends
// renderPipelineOpsWorkersSection(payload). `payload` is the GET /api/pipeline-ops-workers body (routes/pipeline_ops_workers.py): {workers: {<name>: card payload}}.

function poWorkerEsc(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function poWorkerInt(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function poWorkerCut(text, max) {
  const t = String(text === undefined || text === null ? '' : text);
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

// 45 -> '45s', 125 -> '2m', 7300 -> '2h 1m', 200000 -> '2d 7h'; unknown -> ''.
function poWorkerAge(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const s = Math.floor(seconds);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 48) return h + 'h ' + (m % 60) + 'm';
  return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
}

// The cards in the order they are shown, with the name on the card and what the worker does (the tooltip of the mode badge).
const poWorkerInfo = {
  scout: { label: '🔎 poll scout', does: 'files one low-priority task per repo for new polls' },
  checker: { label: '✅ merge-ready checker', does: 'records a merge verdict for branches that pass every check' },
  merger: { label: '🔀 merger', does: 'merges branches the checker approved' },
  steward: { label: '📉 idle-cost steward', does: 'files a task for the worst rising idle-cost originator' },
};
const poWorkerOrder = ['scout', 'checker', 'merger', 'steward'];

function poWorkerLabel(name) {
  return poWorkerInfo[name] ? poWorkerInfo[name].label : name;
}

function poWorkerModeBadge(name, mode) {
  const does = poWorkerInfo[name] ? poWorkerInfo[name].does : 'acts';
  if (mode === 'on') return '<span class="badge ok" title="Live: the worker ' + poWorkerEsc(does) + '">live</span>';
  if (mode === 'off') return '<span class="badge idle" title="MODE=off: the worker does nothing">off</span>';
  if (mode === 'dry-run') return '<span class="badge hold" title="The worker only writes what it WOULD do to its ledger; nothing is ' + poWorkerEsc(does) + '">dry-run</span>';
  return '<span class="badge idle" title="No decision has been recorded yet">no runs yet</span>';
}

// The watchdog calls the trigger about once a minute and it rewrites its heartbeat every time, so a heartbeat older than this means the watchdog or the plugin entry is broken.
const poWorkerTriggerSilentS = 300;

function poWorkerTriggerBadge(t) {
  const ended = t && Number.isFinite(t.endedAgeS) ? ' The last drain ended ' + poWorkerAge(t.endedAgeS) + ' ago' + (t.stopped ? ' (' + poWorkerEsc(t.stopped) + ')' : '') + '.' : '';
  const checked = t && Number.isFinite(t.checkedAgeS) ? ' Checked ' + poWorkerAge(t.checkedAgeS) + ' ago.' : '';
  if (t && t.state === 'listening') return '<span class="badge ok" title="The worker is up and waiting: it reacts within seconds of a change it watches.">listening</span>';
  if (t && t.state === 'draining') return '<span class="badge ok" title="A drain is running: the watchdog saw new input and the worker is ticking through it.">draining</span>';
  if (t && Number.isFinite(t.checkedAgeS) && t.checkedAgeS > poWorkerTriggerSilentS) return '<span class="badge warn" title="The watchdog has not called the trigger for ' + poWorkerAge(t.checkedAgeS) + '. It normally does about once a minute: check the watchdog and the watchdogScripts entry.">trigger silent</span>';
  if (t && t.state === 'backlog') return '<span class="badge warn" title="The last drain stopped at its cap with work left; the next watchdog tick continues it.' + ended + checked + '">backlog</span>';
  if (t && t.state === 'idle') return '<span class="badge ok" title="The watchdog trigger is armed: it starts a drain when the input changes.' + ended + checked + '">trigger on</span>';
  return '<span class="badge warn" title="The watchdog trigger has not run yet. Check that watchdogScripts for this worker is set on its plugins.json entry.">no trigger yet</span>';
}

function poWorkerTriggerCheckedText(t) {
  return t && Number.isFinite(t.checkedAgeS) ? 'trigger checked ' + poWorkerAge(t.checkedAgeS) + ' ago' : '';
}

function poWorkerSwitchBadge(sw) {
  if (!sw) return '';   // only called for a switched-off worker
  const since = sw.disabledAt ? ' since ' + poWorkerEsc(sw.disabledAt) : '';
  return '<span class="badge idle" title="Switched off' + since + ': the worker\'s ticks do nothing until you turn it back on">switched off</span>';
}

function poWorkerSwitchButton(name, sw) {
  const off = !!(sw && sw.disabled === true);
  const title = off
    ? 'Switch the ' + name + ' worker back on: it decides again at its next tick (within a minute).'
    : 'Switch the ' + name + ' worker off: new ticks do nothing (a tick already running finishes). The watchdog trigger keeps running; nothing is deleted.';
  return '<button type="button" class="secondary po-worker-switch-btn" data-po-worker="' + poWorkerEsc(name) + '" data-next-enabled="' + (off ? 'true' : 'false') + '" title="' + poWorkerEsc(title)
    + '" style="margin-top:4px">' + (off ? '⏻ Turn on' : '⏻ Turn off') + '</button>';
}

// Which cards are open (a click on a card flips its flag and redraws), by worker name.
const poWorkerExpanded = {};

const poWorkerHoldLimit = 2;
const poWorkerQuestionChars = 90;

// "FILE-TASK 4 · HOLD-FOR-OWNER 2"; the collapsed card shows the biggest three and a "+n more".
function poWorkerTodayText(p, limit) {
  const entries = Object.entries(p.today || {}).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return 'no decisions today';
  const shown = entries.slice(0, limit || entries.length).map(([k, n]) => poWorkerEsc(k) + ' ' + poWorkerInt(n)).join(' · ');
  return shown + (limit && entries.length > limit ? ' +' + (entries.length - limit) + ' more' : '');
}

function poWorkerCountsText(p) {
  const failed = Number(p.failedToday) > 0 ? ' · <span class="badge warn" title="Actions that failed or were refused; the item is looked at again later">' + poWorkerInt(p.failedToday) + ' failed</span>' : '';
  return poWorkerInt(p.actedToday) + ' acted today' + failed;
}

function poWorkerItemsText(i) {
  return i && Number(i.total) > 0 ? poWorkerInt(i.total) + ' items with a decision' : 'nothing decided yet';
}

// The questions waiting for the owner: at most `limit` of them (0 = all), each cut at poWorkerQuestionChars with the full question and the recommendation in the tooltip.
function poWorkerHoldsHtml(p, limit) {
  const holds = Array.isArray(p.holds) ? p.holds : [];
  if (!holds.length) return '';
  const shown = limit ? holds.slice(0, limit) : holds;
  const total = Number.isFinite(p.holdCount) ? p.holdCount : holds.length;
  const rows = shown.map((h) => '<div class="meta" style="margin-top:2px" title="' + poWorkerEsc(h.question) + (h.recommendation ? ' — Recommended: ' + poWorkerEsc(h.recommendation) : '') + '">'
    + '<span class="badge warn">question</span> ' + poWorkerEsc(poWorkerCut(h.question, poWorkerQuestionChars))
    + (h.recommendation ? ' → ' + poWorkerEsc(poWorkerCut(h.recommendation, poWorkerQuestionChars)) : '')
    + ' · ' + poWorkerEsc(poWorkerCut(h.key, 50)) + (h.ageS !== null && h.ageS !== undefined ? ' · ' + poWorkerEsc(poWorkerAge(h.ageS)) : '') + '</div>').join('');
  const more = total > shown.length ? '<div class="meta" style="margin-top:2px">+' + (total - shown.length) + ' more waiting</div>' : '';
  return '<div style="margin-top:6px">' + rows + more + '</div>';
}

function poWorkerRecentHtml(name, recent) {
  if (!recent || !recent.length) return '<div class="meta" style="margin-top:8px">No decisions recorded yet.</div>';
  const rows = recent.map((r) => '<div class="meta" style="margin-top:2px" title="' + poWorkerEsc(r.key) + ' — ' + poWorkerEsc(r.reason) + '">'
    + poWorkerEsc(String(r.at || '').slice(11, 16)) + ' · ' + poWorkerEsc(r.outcome || 'no outcome') + ' · ' + poWorkerEsc(poWorkerCut(r.key, 60))
    + (r.mode === 'dry-run' ? ' · dry-run' : '') + (r.result ? ' · ' + poWorkerEsc(poWorkerCut(r.result, 40)) : '') + '</div>').join('');
  return '<div style="margin-top:8px"><strong>' + poWorkerEsc(poWorkerLabel(name)) + ' history</strong>' + rows + '</div>';
}

function buildPipelineOpsWorkerHtml(name, p) {
  if (!p || !p.configured) return '';
  const off = !!(p.switch && p.switch.disabled === true);
  const open = poWorkerExpanded[name] === true;
  const age = poWorkerAge(p.lastTickAgeS);
  const head = '<div class="row"><span class="id">' + poWorkerEsc(poWorkerLabel(name)) + '</span><div class="badge-col">'
    + (off ? poWorkerSwitchBadge(p.switch) : poWorkerModeBadge(name, p.mode)) + ' ' + poWorkerTriggerBadge(p.trigger)
    + '<span class="state-timer">' + (age ? 'last tick ' + poWorkerEsc(age) + ' ago' : 'no tick recorded yet') + '</span>'
    + poWorkerSwitchButton(name, p.switch) + '</div></div>';
  const meta = '<div class="meta">' + poWorkerCountsText(p) + ' · ' + poWorkerItemsText(p.items)
    + (poWorkerTriggerCheckedText(p.trigger) ? ' · ' + poWorkerTriggerCheckedText(p.trigger) : '') + ' · today: ' + poWorkerTodayText(p, 3) + '</div>';
  const holds = poWorkerHoldsHtml(p, open ? 0 : poWorkerHoldLimit);
  const toggle = '<div class="meta" style="margin-top:4px">' + (open ? '▾ Hide history' : '▸ Show history') + (p.decisions !== undefined ? ' (' + poWorkerInt(p.decisions) + ' decisions)' : '') + '</div>';
  const detail = open ? '<div class="worker-recent-tasks"><div class="meta" style="margin-top:8px"><strong>Today</strong> ' + poWorkerTodayText(p) + '</div>'
    + poWorkerRecentHtml(name, p.recent) + '</div>' : '';
  return '<div id="po-worker-panel-' + poWorkerEsc(name) + '" class="worker-card clickable' + (off ? ' worker-off' : '') + '" data-po-worker-expand="' + poWorkerEsc(name) + '" aria-expanded="' + open + '">'
    + head + meta + holds + toggle + detail + '</div>';
}

// What renderWorkers() appends: one card per configured worker, in poWorkerOrder; nothing at all unless a worker has left a trace (ledger, trigger state or a switched-off marker).
function renderPipelineOpsWorkersSection(payload) {
  const workers = payload && typeof payload.workers === 'object' && payload.workers ? payload.workers : {};
  const names = poWorkerOrder.filter((n) => workers[n]).concat(Object.keys(workers).filter((n) => poWorkerOrder.indexOf(n) < 0));
  return names.map((n) => buildPipelineOpsWorkerHtml(n, workers[n])).join('');
}

// POST the switch, then redraw the Workers tab. Returns true on success.
async function setPipelineOpsWorkerEnabled(name, enabled) {
  const verb = enabled ? 'on' : 'off';
  let res;
  try {
    res = await fetch('/api/pipeline-ops-workers/' + encodeURIComponent(name) + '/enabled', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) });
  } catch (e) {
    showToast('Could not switch the ' + name + ' worker ' + verb + ': ' + e.message);
    return false;
  }
  if (!res.ok) {
    let why = 'HTTP ' + res.status;
    try { const body = await res.json(); why = body.error || why; } catch (e) { /* keep the HTTP status */ }
    showToast('Could not switch the ' + name + ' worker ' + verb + ': ' + why);
    return false;
  }
  await renderWorkers();
  return true;
}

function wirePipelineOpsWorkerSwitch(root) {
  root.querySelectorAll('.po-worker-switch-btn').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      btn.disabled = true;
      const ok = await setPipelineOpsWorkerEnabled(btn.dataset.poWorker, btn.dataset.nextEnabled === 'true');
      if (!ok) btn.disabled = false;
    };
  });
}

// Click anywhere on a card (but its Turn on/off button, which stops propagation) opens or closes that card's history.
function wirePipelineOpsWorkerExpand(root, redraw) {
  root.querySelectorAll('[data-po-worker-expand]').forEach((card) => {
    card.onclick = () => { const n = card.dataset.poWorkerExpand; poWorkerExpanded[n] = !poWorkerExpanded[n]; if (typeof redraw === 'function') redraw(); };
  });
}
