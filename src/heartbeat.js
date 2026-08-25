'use strict';

// JS-side equivalent of agent-manager-common.sh's write_heartbeat_file -- same file
// shape, same instances/<instanceId>.json target, same stateSince-preservation logic --
// needed because a real local-model call's lock-wait now happens INSIDE the node
// process (single-flight-lock.js's withLock, since the 2026-08-22 plan/implement lock
// split moved locking out of bash and down to the individual sub-call), so bash itself
// has nothing left to report a "queued" (waiting on the lock) vs "working" (actually
// computing) distinction from -- see local-draft.js's own maybeLocked() for the actual
// queued/working transition this writes.
//
// 2026-08-25, Grimmethy: "Is there a way we can maintain the improved speed but get that
// extra status differentiation back?" -- the 2026-08-19 queued/working distinction and
// the 2026-08-22 per-sub-call lock scoping were never actually in tension; the
// distinction just needed to move to wherever the real wait now happens.

const fs = require('fs');
const path = require('path');

function writeHeartbeatFile(instancesDir, instanceId, status, model, taskId, pass, startedAt) {
  const hbPath = path.join(instancesDir, `${instanceId}.json`);
  fs.mkdirSync(instancesDir, { recursive: true });
  const now = new Date().toISOString();
  let stateSince = now;
  try {
    const prev = JSON.parse(fs.readFileSync(hbPath, 'utf8'));
    const prevKey = `${prev.status}|${prev.currentPass || ''}|${prev.currentTaskId || ''}`;
    const key = `${status}|${pass || ''}|${taskId || ''}`;
    if (prevKey === key && prev.stateSince && String(prev.pid) === String(process.pid)) stateSince = prev.stateSince;
    // startedAt isn't passed on every write (bash's own callers don't always have it
    // handy either -- see that function's own optional-startedAt treatment); fall back
    // to whatever the file already recorded so a mid-task heartbeat write never blanks
    // out the worker's own uptime display.
    if (!startedAt && prev.startedAt) startedAt = prev.startedAt;
  } catch (e) {
    // missing/corrupt heartbeat file -- fresh state, nothing to preserve.
  }
  const hb = {
    instanceId, pid: process.pid, model: model || null, status,
    currentTaskId: taskId || null, currentPass: pass || null,
    lastHeartbeat: now, stateSince,
  };
  if (startedAt) hb.startedAt = startedAt;
  fs.writeFileSync(hbPath, JSON.stringify(hb, null, 2));
}

module.exports = { writeHeartbeatFile };
