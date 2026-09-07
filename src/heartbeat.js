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
  let daemonPid;
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
    // daemonPid (2026-09-07, Grimmethy: "the p40 has 2 tasks running on it and the gtx
    // is idle" -- root-caused live to a DIFFERENT, deeper bug than the P40 routing one:
    // this `pid` field is overwritten with THIS NODE CHILD's own process.pid every time
    // a real call is in flight, clobbering whatever the parent bash daemon last recorded
    // there (agent-manager-common.sh's write_heartbeat_file, using its own stable $$).
    // check_instance_liveness's "is this instance already claimed" guard reads that same
    // `pid` field -- so the moment a child exits (task done) and the daemon hasn't yet
    // looped back to write a fresh "idle" heartbeat, the file shows a now-dead child pid,
    // and the guard wrongly concludes the instance is unclaimed. Confirmed live: every
    // worker-* lane had TWO concurrent local-worker.sh processes running simultaneously.
    // daemonPid is a SEPARATE field only the bash wrapper ever sets -- this function
    // (only ever called from a spawned child, never the daemon itself) must carry
    // forward whatever value is already on disk rather than setting its own, so the
    // child's own pid never leaks into the field the liveness guard actually trusts.
    if (prev.daemonPid != null) daemonPid = prev.daemonPid;
  } catch (e) {
    // missing/corrupt heartbeat file -- fresh state, nothing to preserve.
  }
  const hb = {
    instanceId, pid: process.pid, model: model || null, status,
    currentTaskId: taskId || null, currentPass: pass || null,
    lastHeartbeat: now, stateSince,
  };
  if (startedAt) hb.startedAt = startedAt;
  if (daemonPid != null) hb.daemonPid = daemonPid;
  fs.writeFileSync(hbPath, JSON.stringify(hb, null, 2));
}

module.exports = { writeHeartbeatFile };
