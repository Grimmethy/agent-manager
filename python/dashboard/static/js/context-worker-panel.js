// Context-worker cards for the Workers tab (agent-manager-context-ops docs/context-workers-spec.md and docs/context-impact-spec.md): the codebase-map worker, the memory-index worker and the context-impact worker. Like the branch verifier and the
// Needs-Work worker they are CLIs started by the watchdog trigger (no timer), not lanes: same layout as the Needs-Work card (id left; mode badge, trigger badge, "last tick" and the
// Turn on/off button stacked right; one meta line; click the card to open the recent decisions). A plain global <script> of pure string builders (no DOM, no fetch, no require), loaded
// by index.html after needswork-worker-panel.js; workers-tab.js appends renderContextWorkerSection(mapPayload, memoryPayload, nowMs, impactPayload). Each payload is a GET /api/context-worker/<map|memory|impact>
// body (routes/context_worker.py). A DRY-RUN decision is shown plainly as a dry-run twin that was NOT acted; a switched-off worker says "switched off", never an error.

function contextWorkerEsc(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function contextWorkerInt(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function contextWorkerCut(text, max) {
  const t = String(text === undefined || text === null ? '' : text);
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

// 45 -> '45s', 125 -> '2m', 7300 -> '2h 1m', 200000 -> '2d 7h'; unknown -> ''.
function contextWorkerAge(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const s = Math.floor(seconds);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 48) return h + 'h ' + (m % 60) + 'm';
  return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
}

// Seconds from an ISO timestamp to `nowMs`; null when the timestamp is missing or unreadable.
function contextWorkerAgeSince(iso, nowMs) {
  const t = Date.parse(iso);
  return Number.isFinite(t) && Number.isFinite(nowMs) ? Math.max(0, Math.floor((nowMs - t) / 1000)) : null;
}

// The three workers: payload.name -> title, icon and what the Turn off button says it switches.
const contextWorkerInfo = {
  map: { title: 'Context map worker', icon: '🗺', what: 'the codebase-map worker' },
  memory: { title: 'Context memory worker', icon: '🧠', what: 'the memory-index worker' },
  impact: { title: 'Context impact worker', icon: '📈', what: 'the context-impact worker' },
};
const contextWorkerKnown = (name) => Object.prototype.hasOwnProperty.call(contextWorkerInfo, name);

function contextWorkerModeBadge(mode) {
  if (mode === 'on') return '<span class="badge ok" title="The worker acts for real: the map worker files one adhoc task per map, the memory worker writes a proposal file">live</span>';
  if (mode === 'off') return '<span class="badge idle" title="The mode is off: the worker does nothing">off</span>';
  if (mode === 'dry-run') return '<span class="badge hold" title="DRY RUN: the worker only writes what it WOULD do to its ledger; nothing is filed or written">DRY RUN</span>';
  return '<span class="badge idle" title="No decision has been recorded yet">no runs yet</span>';
}

// The watchdog trigger (no timer): `t` is payload.trigger {state: 'listening' | 'draining' | 'backlog' | 'idle', endedAgeS, checkedAgeS, stopped} or null when it has never run.
// The watchdog calls the trigger about once a minute and it rewrites its heartbeat every time, so a heartbeat older than this means the watchdog or the plugin entry is broken.
const contextWorkerTriggerSilentS = 300;

function contextWorkerTriggerBadge(t) {
  const ended = t && Number.isFinite(t.endedAgeS) ? ' The last drain ended ' + contextWorkerAge(t.endedAgeS) + ' ago' + (t.stopped ? ' (' + contextWorkerEsc(t.stopped) + ')' : '') + '.' : '';
  const checked = t && Number.isFinite(t.checkedAgeS) ? ' Checked ' + contextWorkerAge(t.checkedAgeS) + ' ago.' : '';
  if (t && t.state === 'listening') return '<span class="badge ok" title="The worker is up and waiting: it reacts within seconds of a commit or any change it watches.">listening</span>';
  if (t && t.state === 'draining') return '<span class="badge ok" title="A drain is running: the watchdog saw new input and the worker is ticking through it.">draining</span>';
  if (t && Number.isFinite(t.checkedAgeS) && t.checkedAgeS > contextWorkerTriggerSilentS) return '<span class="badge warn" title="The watchdog has not called the trigger for ' + contextWorkerAge(t.checkedAgeS) + '. It normally does about once a minute: check the watchdog and watchdogScripts on the plugins.json entry.">trigger silent</span>';
  if (t && t.state === 'backlog') return '<span class="badge warn" title="The last drain stopped at its cap with work left; the next watchdog tick continues it.' + ended + checked + '">backlog</span>';
  if (t && t.state === 'idle') return '<span class="badge ok" title="The watchdog trigger is armed: it starts a drain when the input changes.' + ended + checked + '">trigger on</span>';
  return '<span class="badge warn" title="The watchdog trigger has not run yet. Check that watchdogScripts for this worker is set on its plugins.json entry.">no trigger yet</span>';
}

function contextWorkerTriggerCheckedText(t) {
  return t && Number.isFinite(t.checkedAgeS) ? 'trigger checked ' + contextWorkerAge(t.checkedAgeS) + ' ago' : '';
}

function contextWorkerSwitchBadge(sw) {
  const since = sw && sw.disabledAt ? ' since ' + contextWorkerEsc(sw.disabledAt) : '';
  return '<span class="badge idle" title="Switched off' + since + ': the worker\'s ticks do nothing until you turn it back on">switched off</span>';
}

function contextWorkerSwitchButton(name, sw) {
  const off = !!(sw && sw.disabled === true);
  const what = (contextWorkerInfo[name] || { what: 'the worker' }).what;
  const title = off
    ? 'Switch ' + what + ' back on: it decides again at its next tick (within a minute).'
    : 'Switch ' + what + ' off: new ticks do nothing (a tick already running finishes). The watchdog trigger keeps running; nothing is deleted.';
  return '<button type="button" class="secondary context-worker-switch-btn" data-worker="' + contextWorkerEsc(name) + '" data-next-enabled="' + (off ? 'true' : 'false') + '" title="' + contextWorkerEsc(title)
    + '" style="margin-top:4px">' + (off ? '⏻ Turn on' : '⏻ Turn off') + '</button>';
}

// Open/closed state of each card's recent-decisions section; a click on the card flips it and redraws.
const contextWorkerExpanded = { map: false, memory: false, impact: false };

// How many questions a collapsed card shows, and how long one may be before it is cut (the full text stays in the tooltip).
const contextWorkerHoldLimit = 2;
const contextWorkerQuestionChars = 90;

// "FILE-TASK 1 · NOTHING-TO-FIX 2 · FILE-TASK 3 (dry run, not acted)": real decisions first, then their dry-run twins marked as not acted; the collapsed card shows the biggest three.
function contextWorkerTodayText(p, limit) {
  const today = p.today || {};
  const real = Object.entries(today.byOutcome || {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => contextWorkerEsc(k) + ' ' + contextWorkerInt(n));
  const dry = Object.entries((today.dryRun || {}).byOutcome || {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => contextWorkerEsc(k) + ' ' + contextWorkerInt(n) + ' (dry run, not acted)');
  const all = real.concat(dry);
  if (!all.length) return 'no decisions today';
  const shown = limit ? all.slice(0, limit) : all;
  return shown.join(' · ') + (limit && all.length > limit ? ' +' + (all.length - limit) + ' more' : '');
}

function contextWorkerCountsText(p) {
  return contextWorkerInt(p.actedToday) + ' acted today';
}

// "14 rows to rewrite, 0 fixes, 5 suggestions" (the map worker's newest findings); the uncited-file count goes in the tooltip. '' without findings.
function contextWorkerFindingsHtml(f) {
  if (!f || typeof f !== 'object') return '';
  const plural = (n, one, many) => contextWorkerInt(n) + ' ' + (Number(n) === 1 ? one : many);
  const suggestions = f.suggestions && typeof f.suggestions === 'object' ? f.suggestions : {};
  const text = plural(f.rewriteRows, 'row to rewrite', 'rows to rewrite') + ', ' + plural(f.fixRanges, 'fix', 'fixes') + ', ' + plural(suggestions.anchors, 'suggestion', 'suggestions');
  const rows = Number(suggestions.rows) > 0 ? ' · ' + contextWorkerInt(suggestions.rows) + ' source files are not cited by the map' : '';
  return '<div class="meta" style="margin-top:2px" title="' + contextWorkerEsc('Findings ' + String(f.hash || '').slice(0, 12) + rows) + '">map: ' + contextWorkerEsc(text) + '</div>';
}

// The impact worker's own lines (payload.impact from routes/context_worker.py): what its newest decision found, the investigation tasks it has filed, the intervention ledger per kind and the
// authority gate. Collapsed: two lines; open: the lists behind them. A missing section (its reader failed) draws nothing; fields that are not lists or numbers read as empty or zero.
const contextWorkerImpactShown = 3;

function contextWorkerImpactHtml(impact, open) {
  if (!impact || typeof impact !== 'object') return '';
  const list = (v) => (Array.isArray(v) ? v : []);
  const names = (v) => list(v).filter((x) => typeof x === 'string');
  const latest = impact.latest && typeof impact.latest === 'object' ? impact.latest : null;
  const regressed = names(latest && latest.regressed);
  const improved = names(latest && latest.improved);
  const insufficient = names(latest && latest.insufficient);
  const wouldFile = names(latest && latest.wouldFile);
  const filedCount = Number(impact.filedCount) > 0 ? Math.floor(Number(impact.filedCount)) : 0;
  const shown = (arr) => arr.slice(0, contextWorkerImpactShown).map((x) => contextWorkerEsc(contextWorkerCut(x, 48))).join(', ') + (arr.length > contextWorkerImpactShown ? ' +' + (arr.length - contextWorkerImpactShown) + ' more' : '');
  const line = (text, tip) => '<div class="meta" style="margin-top:2px"' + (tip ? ' title="' + contextWorkerEsc(tip) + '"' : '') + '>' + text + '</div>';
  const summary = latest
    ? 'impact: ' + contextWorkerInt(regressed.length) + ' regressed, ' + contextWorkerInt(improved.length) + ' improved, ' + contextWorkerInt(insufficient.length) + ' channel' + (insufficient.length === 1 ? '' : 's') + ' short of data'
    : 'impact: no decision yet';
  const interventions = impact.interventions && typeof impact.interventions === 'object' ? impact.interventions : {};
  const kindText = (kind) => {
    const c = interventions[kind] && typeof interventions[kind] === 'object' ? interventions[kind] : {};
    return kind + ' ' + contextWorkerInt(c.HELPED) + ' helped / ' + contextWorkerInt(c['NO-EFFECT']) + ' no effect / ' + contextWorkerInt(c.HARMED) + ' harmed / ' + contextWorkerInt(c.open) + ' waiting';
  };
  const gate = impact.gate && typeof impact.gate === 'object' ? impact.gate : {};
  const gateText = 'authority gate ' + (gate.open === true ? 'OPEN' : 'closed') + ' (' + contextWorkerInt(gate.evaluated) + ' map edit' + (Number(gate.evaluated) === 1 ? '' : 's') + ' evaluated, ' + contextWorkerInt(gate.helped) + ' helped)';
  let html = line(contextWorkerEsc(summary) + (regressed.length ? ' · ' + shown(regressed) : ''), regressed.join(', '))
    + line(contextWorkerInt(filedCount) + ' investigation task' + (filedCount === 1 ? '' : 's') + ' filed · ' + contextWorkerEsc(gateText), 'The gate opens at 3 evaluated map edits with more than half helped: only then may a change of the default grounding source be proposed.');
  if (!open) return html;
  if (improved.length) html += line('improved: ' + shown(improved));
  if (insufficient.length) html += line('not enough data: ' + shown(insufficient), insufficient.join(', '));
  if (wouldFile.length) html += line('dry run: would file ' + contextWorkerInt(wouldFile.length) + ' investigation task' + (wouldFile.length === 1 ? '' : 's') + ': ' + shown(wouldFile), wouldFile.join(', '));
  const filed = list(impact.filed).filter((f) => f && typeof f === 'object' && typeof f.taskId === 'string');
  if (filed.length) html += line('filed: ' + filed.slice(-contextWorkerImpactShown).map((f) => contextWorkerEsc(contextWorkerCut(f.taskId, 40))).join(', ') + (filed.length > contextWorkerImpactShown ? ' (newest ' + contextWorkerImpactShown + ' of ' + contextWorkerInt(filedCount) + ')' : ''), filed.map((f) => f.taskId).join(', '));
  html += line(contextWorkerEsc(kindText('map-edit'))) + line(contextWorkerEsc(kindText('memory-edit')));
  return html;
}

// "last decision: FILE-TASK (DRY RUN, not acted) 12m ago: 14 findings (0 fix, 14 rewrite)".
function contextWorkerLastDecisionHtml(p, nowMs) {
  const d = p.lastDecision;
  if (!d) return '';
  const age = contextWorkerAge(contextWorkerAgeSince(d.at, nowMs));
  const dry = d.mode === 'dry-run' || d.executed === false;
  return '<div class="meta" style="margin-top:2px" title="' + contextWorkerEsc(d.summary) + '">last decision: ' + contextWorkerEsc(d.outcome || 'no action') + (dry ? ' (DRY RUN, not acted)' : '')
    + (age ? ' ' + contextWorkerEsc(age) + ' ago' : '') + (d.summary && d.summary !== d.outcome ? ': ' + contextWorkerEsc(contextWorkerCut(d.summary, contextWorkerQuestionChars)) : '') + '</div>';
}

function contextWorkerErrorHtml(e) {
  if (!e || !Number(e.count) || !e.last) return '';
  return '<div class="meta" style="margin-top:2px" title="' + contextWorkerEsc(e.last.error) + '"><span class="badge warn">error</span> ' + contextWorkerInt(e.count) + ' error' + (Number(e.count) === 1 ? '' : 's')
    + ', last: ' + contextWorkerEsc(contextWorkerCut(e.last.error || 'no message', contextWorkerQuestionChars)) + '</div>';
}

// The questions waiting for the owner: at most `limit` of them, each cut at contextWorkerQuestionChars with the full question and the recommendation in the tooltip.
function contextWorkerHoldsHtml(p, limit) {
  const holds = Array.isArray(p.holds) ? p.holds : [];
  if (!holds.length) return '';
  const shown = limit ? holds.slice(0, limit) : holds;
  const total = Number.isFinite(p.holdCount) ? p.holdCount : holds.length;
  const rows = shown.map((h) => '<div class="meta" style="margin-top:2px" title="' + contextWorkerEsc(h.question) + (h.recommendation ? ' — Recommended: ' + contextWorkerEsc(h.recommendation) : '') + '">'
    + '<span class="badge warn">question</span> ' + contextWorkerEsc(contextWorkerCut(h.question, contextWorkerQuestionChars))
    + (h.recommendation ? '<br>→ ' + contextWorkerEsc(contextWorkerCut(h.recommendation, contextWorkerQuestionChars)) : '')
    + (h.ageS !== null && h.ageS !== undefined && contextWorkerAge(h.ageS) ? ' · ' + contextWorkerEsc(contextWorkerAge(h.ageS)) : '') + '</div>').join('');
  const more = total > shown.length ? '<div class="meta" style="margin-top:2px">+' + (total - shown.length) + ' more waiting</div>' : '';
  return '<div style="margin-top:6px">' + rows + more + '</div>';
}

function contextWorkerRecentHtml(recent) {
  if (!recent || !recent.length) return '<div class="meta" style="margin-top:8px">No decisions recorded yet.</div>';
  const rows = recent.map((r) => '<div class="meta" style="margin-top:2px" title="' + contextWorkerEsc(r.summary) + '">'
    + contextWorkerEsc(String(r.at || '').slice(11, 16)) + ' · ' + contextWorkerEsc(r.outcome || 'no action') + (r.mode === 'dry-run' || r.executed === false ? ' · DRY RUN, not acted' : '')
    + (r.summary && r.summary !== r.outcome ? ' · ' + contextWorkerEsc(contextWorkerCut(r.summary, 60)) : '') + '</div>').join('');
  return '<div style="margin-top:8px"><strong>Recent decisions</strong>' + rows + '</div>';
}

// One card. `p` is the payload; `nowMs` (default Date.now()) only dates the last decision.
function buildContextWorkerHtml(p, nowMs) {
  if (!p || !p.configured) return '';
  const name = contextWorkerKnown(p.name) ? p.name : 'map';
  const info = contextWorkerInfo[name];
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const off = !!(p.switch && p.switch.disabled === true);
  const open = contextWorkerExpanded[name] === true;
  const age = contextWorkerAge(p.lastTickAgeS);
  const head = '<div class="row"><span class="id">' + info.icon + ' ' + contextWorkerEsc(info.title) + '</span><div class="badge-col">'
    + (off ? contextWorkerSwitchBadge(p.switch) : contextWorkerModeBadge(p.mode)) + ' ' + contextWorkerTriggerBadge(p.trigger)
    + '<span class="state-timer">' + (age ? 'last tick ' + contextWorkerEsc(age) + ' ago' : 'no tick recorded yet') + '</span>'
    + contextWorkerSwitchButton(name, p.switch) + '</div></div>';
  const meta = '<div class="meta">' + contextWorkerCountsText(p) + (contextWorkerTriggerCheckedText(p.trigger) ? ' · ' + contextWorkerTriggerCheckedText(p.trigger) : '')
    + ' · today: ' + contextWorkerTodayText(p, 3) + '</div>';
  const holds = contextWorkerHoldsHtml(p, open ? 0 : contextWorkerHoldLimit);
  const toggle = '<div class="meta" style="margin-top:4px">' + (open ? '▾ Hide decisions' : '▸ Show decisions') + (p.decisions !== undefined ? ' (' + contextWorkerInt(p.decisions) + ' in the ledger)' : '') + '</div>';
  const detail = open ? '<div class="worker-recent-tasks"><div class="meta" style="margin-top:8px"><strong>Today</strong> ' + contextWorkerTodayText(p) + '</div>'
    + contextWorkerRecentHtml(p.recent) + '</div>' : '';
  return '<div id="context-' + name + '-worker-panel" class="worker-card clickable' + (off ? ' worker-off' : '') + '" data-context-expand="' + name + '" aria-expanded="' + open + '">'
    + head + meta + contextWorkerLastDecisionHtml(p, now) + contextWorkerFindingsHtml(p.findings) + (name === 'impact' ? contextWorkerImpactHtml(p.impact, open) : '') + contextWorkerErrorHtml(p.errors) + holds + toggle + detail + '</div>';
}

// What renderWorkers() appends: the map card, the memory card, then the impact card, each nothing at all unless that worker has left a trace (ledger, trigger state or a switched-off marker).
// `nowMs` only dates the last decision; the fourth argument is optional so a caller that knows two workers still works.
function renderContextWorkerSection(mapPayload, memoryPayload, nowMs, impactPayload) {
  return buildContextWorkerHtml(mapPayload, nowMs) + buildContextWorkerHtml(memoryPayload, nowMs) + buildContextWorkerHtml(impactPayload, nowMs);
}

// POST the switch, then redraw the Workers tab. Returns true on success.
async function setContextWorkerEnabled(name, enabled) {
  const verb = enabled ? 'on' : 'off';
  const title = (contextWorkerInfo[name] || { title: 'Context worker' }).title;
  let res;
  try {
    res = await fetch('/api/context-worker/' + encodeURIComponent(name) + '/enabled', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) });
  } catch (e) {
    showToast('Could not switch the ' + title + ' ' + verb + ': ' + e.message);
    return false;
  }
  if (!res.ok) {
    let why = 'HTTP ' + res.status;
    try { const body = await res.json(); why = body.error || why; } catch (e) { /* keep the HTTP status */ }
    showToast('Could not switch the ' + title + ' ' + verb + ': ' + why);
    return false;
  }
  await renderWorkers();
  return true;
}

function wireContextWorkerSwitch(root) {
  root.querySelectorAll('.context-worker-switch-btn').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      btn.disabled = true;
      const ok = await setContextWorkerEnabled(btn.dataset.worker, btn.dataset.nextEnabled === 'true');
      if (!ok) btn.disabled = false;
    };
  });
}

// Click anywhere on a card (but the Turn on/off button, which stops propagation) opens or closes its decisions.
function wireContextWorkerExpand(root, redraw) {
  root.querySelectorAll('[data-context-expand]').forEach((card) => {
    card.onclick = () => { const n = card.dataset.contextExpand; contextWorkerExpanded[n] = !contextWorkerExpanded[n]; if (typeof redraw === 'function') redraw(); };
  });
}
