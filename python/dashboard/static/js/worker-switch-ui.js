// Workers tab on/off switch: the Turn on / Turn off button on each worker card, the note shown while a switched-off worker finishes its task, and the POST that flips it
// (POST /api/instances/<id>/enabled; docs/agents/lanes.md "Switching a worker off"). A plain global <script> (no require/module.exports) loaded by index.html right
// after workers-tab.js, whose renderWorkers() calls buildWorkerSwitchHtml(inst) and workerCardOffClass(inst) while building a card and wireWorkerSwitchButtons(main)
// afterwards. The builders are pure string functions (no DOM), so they load into a bare vm context for tests.

function workerSwitchEsc(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// null (no switch on this card) | 'on' | 'off' | 'going-off-working' | 'going-off-idle'. A worker switched off that is still on a task keeps its real status until it finishes;
// once idle its heartbeat status becomes disabled.
function workerSwitchState(inst) {
  if (!inst || inst.switchable !== true) return null;
  if (!inst.disabled) return 'on';
  if (inst.status === 'disabled' || inst.status === 'offline') return 'off';
  if (inst.status === 'working' || inst.status === 'queued') return 'going-off-working';
  return 'going-off-idle';
}

function buildWorkerSwitchHtml(inst) {
  const state = workerSwitchState(inst);
  if (!state) return '';
  const turningOn = state !== 'on';
  const title = turningOn
    ? 'Switch this worker back on: it starts claiming tasks again within about one tick (30 seconds).'
    : 'Switch this worker off: it finishes the task it is on, then claims nothing until you turn it back on. The process keeps running.';
  const notes = {
    'going-off-working': '<span class="badge warn" title="Switched off: it finishes its current task, then claims nothing">turning off after this task</span>',
    'going-off-idle': '<span class="badge warn" title="Switched off: it stops claiming at its next tick">turning off…</span>',
  };
  return '<button type="button" class="secondary worker-switch-btn" data-instance-id="' + workerSwitchEsc(inst.instanceId)
    + '" data-next-enabled="' + (turningOn ? 'true' : 'false') + '" title="' + workerSwitchEsc(title) + '" style="margin-top:4px">'
    + (turningOn ? '⏻ Turn on' : '⏻ Turn off') + '</button>' + (notes[state] ? ' ' + notes[state] : '');
}

function workerCardOffClass(inst) {
  return inst && inst.switchable === true && inst.disabled ? ' worker-off' : '';
}

async function setWorkerEnabled(instanceId, enabled) {
  const verb = enabled ? 'on' : 'off';
  let res;
  try {
    res = await fetch('/api/instances/' + encodeURIComponent(instanceId) + '/enabled', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
  } catch (e) {
    showToast('Could not switch ' + instanceId + ' ' + verb + ': ' + e.message);
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
    showToast('Could not switch ' + instanceId + ' ' + verb + ': ' + why);
    return false;
  }
  await renderWorkers();
  return true;
}

function wireWorkerSwitchButtons(root) {
  root.querySelectorAll('.worker-switch-btn').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation(); // the card itself expands on click
      btn.disabled = true;
      setWorkerEnabled(btn.dataset.instanceId, btn.dataset.nextEnabled === 'true');
    };
  });
}
