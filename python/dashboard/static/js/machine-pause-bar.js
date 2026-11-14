// Machine pause bar (multi-node plan): Pause / Resume this machine and Pause / Resume everything above the Workers tab cards, with a note for each active pause (who
// set it, why, until when). Reads GET /api/pause (fail soft: no bar when it cannot be read) and posts POST /api/pause/<scope> or /api/resume/<scope>; the pause markers
// are src/worker-switch.js _pause-node / _pause-global (docs/agents/lanes.md "Pausing a machine"). A plain global <script> loaded by index.html right after
// worker-switch-ui.js, whose wireWorkerSwitchButtons() calls renderMachinePauseBar(root) when this file is loaded (so both the list and the graph view get the bar).
// Uses these globals from the other scripts: workerSwitchEsc (worker-switch-ui.js), showToast, renderWorkers. The builders are pure string functions (no DOM).

function machinePauseUntil(iso) {
  if (!iso) return 'until resumed';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'until resumed';
  const two = (n) => String(n).padStart(2, '0');
  return 'until ' + two(d.getHours()) + ':' + two(d.getMinutes());
}

function machinePauseNote(marker, label) {
  if (!marker) return '';
  const text = label + ' paused' + (marker.source ? ' by ' + marker.source : '') + (marker.reason ? ' (' + marker.reason + ')' : '') + ', ' + machinePauseUntil(marker.expiresAt);
  return ' <span class="badge warn machine-pause-note" title="Workers on ' + (label === 'Everything' ? 'every machine' : 'this machine') + ' claim nothing new while this lasts; tasks in flight finish">' + workerSwitchEsc(text) + '</span>';
}

// status is the GET /api/pause body {node, global, workers}; '' when it is not usable.
function buildMachinePauseHtml(status) {
  if (!status || typeof status !== 'object') return '';
  const node = status.node || null;
  const glob = status.global || null;
  const button = (scope, active, resumeText, pauseText, title) => '<button type="button" class="secondary machine-pause-btn" data-scope="' + scope
    + '" data-next-paused="' + (active ? 'false' : 'true') + '" title="' + workerSwitchEsc(title) + '">' + (active ? resumeText : pauseText) + '</button>';
  return '<div class="machine-pause-bar">'
    + button('node', !!node, '▶ Resume this machine', '⏸ Pause this machine', 'Workers on this machine claim nothing new until you resume; tasks in flight finish.')
    + ' '
    + button('global', !!glob, '▶ Resume everything', '⏸ Pause everything', 'Pause every machine (the other machines pick it up at their next heartbeat); tasks in flight finish.')
    + machinePauseNote(node, 'This machine') + machinePauseNote(glob, 'Everything')
    + '</div>';
}

async function setMachinePause(scope, paused) {
  const verb = paused ? 'pause' : 'resume';
  let res;
  try {
    res = await fetch('/api/' + (paused ? 'pause/' : 'resume/') + encodeURIComponent(scope), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
  } catch (e) {
    showToast('Could not ' + verb + ' ' + scope + ': ' + e.message);
    return false;
  }
  if (!res.ok) {
    let why = 'HTTP ' + res.status;
    try {
      const body = await res.json();
      why = body.description || body.error || why;
    } catch (e) {
      // keep the HTTP status
    }
    showToast('Could not ' + verb + ' ' + scope + ': ' + why);
    return false;
  }
  await renderWorkers();
  return true;
}

// The bar as it was last drawn. renderWorkers() replaces all of #main on every workers event, which throws the bar away; the bar is put back from this at once, before /api/pause
// answers, so it does not vanish and reappear on every redraw (2026-11-13: the Workers tab redrew every ~1.7 s while the lanes cycled and the bar flickered each time).
let machinePauseLastHtml = '';

function paintMachinePauseBar(root, html) {
  const old = root.querySelector('.machine-pause-bar');
  if (old) old.remove();
  if (!html) return;
  root.insertAdjacentHTML('afterbegin', html);
  root.querySelectorAll('.machine-pause-btn').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      btn.disabled = true;
      setMachinePause(btn.dataset.scope, btn.dataset.nextPaused === 'true');
    };
  });
}

async function renderMachinePauseBar(root) {
  if (!root || typeof root.querySelector !== 'function' || typeof root.insertAdjacentHTML !== 'function') return;
  const shown = machinePauseLastHtml;
  if (shown) paintMachinePauseBar(root, shown);
  let status = null;
  try {
    const res = await fetch('/api/pause');
    if (res.ok) status = await res.json();
  } catch (e) {
    return; // fail soft: the bar stays as drawn (none when there was none), no error
  }
  const html = buildMachinePauseHtml(status);
  machinePauseLastHtml = html;
  if (html !== shown || !root.querySelector('.machine-pause-bar')) paintMachinePauseBar(root, html);
}
