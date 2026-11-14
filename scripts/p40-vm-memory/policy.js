'use strict';

// Pure policy for the P40 VM's virtio-mem device (docs/agents/p40-vm-memory.md): given the guest's memory stats and the device's requested and
// plugged sizes, decide the next requested size. No I/O here; controller.js reads the inputs and applies the result, so every rule is unit-tested.
//
// Why requested AND plugged: the guest plugs or unplugs blocks to reach the requested size, and an unplug can be partial (pages it cannot move).
// A new decision made while plugged is still catching up would stack requests on a guess, so the policy waits for the device to settle.
// Sizes are KiB throughout (libvirt's unit).

const DEFAULTS = Object.freeze({
  stepKiB: 256 * 1024,
  lowKiB: 1536 * 1024,        // grow when the guest's usable memory is under this
  highKiB: 2560 * 1024,       // shrink only while usable stays over this
  capKiB: 2 * 1024 * 1024,    // the device's whole region: never request more than this
  hostReserveKiB: 2 * 1024 * 1024,  // wok must keep this much MemAvailable after a grow
  shrinkAfterS: 300,          // seconds usable must stay high before a shrink
  settleToleranceKiB: 2048,   // plugged within one 2 MiB block of requested counts as settled
  stuckAfterS: 120,           // a plug/unplug in flight longer than this is declared stuck
  backoffS: 60,               // after a failed update, do nothing for this long
  swapSlackKiB: 512,          // swap-out growth under this between polls is noise
});

/**
 * @param {object} s   { stats:{usable,swapOut}|null, requestedKiB, pluggedKiB, hostAvailKiB, highSince:number|null, unsettledSince:number|null,
 *                       prevSwapOut:number|null, lastFailureAt:number|null, now:number }
 * @param {object} [cfg]
 * @returns {{action:'grow'|'shrink'|'hold'|'accept', targetKiB:number, reason:string}}
 */
function decide(s, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const req = s.requestedKiB;
  const hold = (reason) => ({ action: 'hold', targetKiB: req, reason });
  if (!s.stats || typeof s.stats.usable !== 'number') return hold('no guest memory stats');
  if (s.lastFailureAt != null && s.now - s.lastFailureAt < c.backoffS) return hold(`backing off after a failed update (${c.backoffS}s)`);

  const diff = Math.abs(s.pluggedKiB - req);
  if (diff > c.settleToleranceKiB) {
    const waited = s.unsettledSince != null ? s.now - s.unsettledSince : 0;
    if (waited >= c.stuckAfterS && s.pluggedKiB < req) {
      // The guest could not give memory back (or could not take it): stop asking for what it will not do, so the next decision starts from fact.
      return { action: 'accept', targetKiB: Math.max(0, s.pluggedKiB), reason: `stuck ${waited}s: plugged ${Math.round(s.pluggedKiB / 1024)} MiB of ${Math.round(req / 1024)} MiB requested; accepting what the guest has` };
    }
    return hold(`waiting for plug/unplug: plugged ${Math.round(s.pluggedKiB / 1024)} MiB, requested ${Math.round(req / 1024)} MiB`);
  }

  const swapped = s.prevSwapOut != null && typeof s.stats.swapOut === 'number' && s.stats.swapOut > s.prevSwapOut + c.swapSlackKiB;
  if ((s.stats.usable < c.lowKiB || swapped) && req < c.capKiB) {
    const target = Math.min(c.capKiB, req + c.stepKiB);
    if (s.hostAvailKiB - (target - req) < c.hostReserveKiB) return hold('guest is short but wok would drop under its memory reserve');
    return { action: 'grow', targetKiB: target, reason: `usable ${Math.round(s.stats.usable / 1024)} MiB under ${Math.round(c.lowKiB / 1024)} MiB${swapped ? ' and swapping' : ''}` };
  }
  if (s.stats.usable > c.highKiB && req > 0 && s.highSince != null && s.now - s.highSince >= c.shrinkAfterS) {
    return { action: 'shrink', targetKiB: Math.max(0, req - c.stepKiB), reason: `usable over ${Math.round(c.highKiB / 1024)} MiB for ${s.now - s.highSince}s` };
  }
  return hold(`ok (usable ${Math.round(s.stats.usable / 1024)} MiB)`);
}

module.exports = { decide, DEFAULTS };
