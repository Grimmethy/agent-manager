// Workers tab machine badge: a small label on every worker card naming the machine the lane runs on, so two lanes with the same instance id on different machines cannot be confused. Local instances show the dashboard's known host (workerSwitchHostName() in worker-switch-ui.js); node lanes show their node id once /api/nodes carries lanes. Display only: /api/instances is unchanged.
// A plain global <script> loaded by index.html right before workers-tab.js. Pure string builders (no DOM, no fetch, no timers), so the node --test file can load it directly.

function workerMachineEsc(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Node id wins for node lanes; otherwise the host the dashboard knows. Falls back to 'unknown' so no card renders an ambiguous blank badge.
function workerMachineLabel(inst, host) {
  const nodeId = inst && inst.nodeId ? String(inst.nodeId) : '';
  if (nodeId) return nodeId;
  const h = host ? String(host) : '';
  return h || 'unknown';
}

function workerMachineBadgeHtml(inst, host) {
  const label = workerMachineLabel(inst, host);
  return '<span class="badge idle worker-machine-badge" data-machine="' + workerMachineEsc(label) + '" title="This lane runs on ' + workerMachineEsc(label) + '" style="margin-left:6px">🖥 ' + workerMachineEsc(label) + '</span>';
}

if (typeof module !== 'undefined' && module.exports) module.exports = { workerMachineEsc, workerMachineLabel, workerMachineBadgeHtml };
