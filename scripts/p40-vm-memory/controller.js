#!/usr/bin/env node
'use strict';

// Executor around policy.js: reads the guest's memory stats (virsh dommemstat) and the virtio-mem device's requested/plugged sizes (virsh dumpxml),
// asks policy.decide for the next requested size and applies it with `virsh update-memory-device --live --requested-size`. Everything that touches
// the system goes through the injected `run`, so the tests use fakes. --dry-run only prints decisions. Never defines or restarts a domain.
//   node scripts/p40-vm-memory/controller.js [--domain p40-passthrough] [--alias ua-virtiomem0] [--dry-run] [--once] [--poll 5]

const { spawnSync } = require('child_process');
const fs = require('fs');
const { decide, DEFAULTS } = require('./policy.js');

const URI = 'qemu:///system';

function realRun(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 20000 });
  return { code: r.status === null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function parseDommemstat(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const m = line.trim().match(/^(\w+)\s+(-?\d+)$/);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

// The live domain XML carries the virtio-mem device as <memory model='virtio-mem'> ... <requested> and <current> (the plugged size).
function parseMemoryDevice(xml, alias) {
  const blocks = String(xml).match(/<memory\s+model=['"]virtio-mem['"][\s\S]*?<\/memory>/g) || [];
  for (const b of blocks) {
    const a = (b.match(/<alias\s+name=['"]([^'"]+)['"]/) || [])[1];
    if (alias && a !== alias) continue;
    const kib = (tag) => {
      const m = b.match(new RegExp(`<${tag}\\s+unit=['"](\\w+)['"]>(\\d+)</${tag}>`));
      if (!m) return null;
      const mult = { b: 1 / 1024, B: 1 / 1024, KiB: 1, MiB: 1024, GiB: 1024 * 1024 }[m[1]];
      return mult === undefined ? null : Number(m[2]) * mult;
    };
    return { alias: a || null, sizeKiB: kib('size'), requestedKiB: kib('requested'), currentKiB: kib('current') };
  }
  return null;
}

function hostAvailableKiB(readFile = (p) => fs.readFileSync(p, 'utf8')) {
  const m = readFile('/proc/meminfo').match(/^MemAvailable:\s+(\d+)/m);
  return m ? Number(m[1]) : 0;
}

function readInputs(run, domain, alias, readFile) {
  const st = run('virsh', ['-c', URI, 'dommemstat', domain]);
  const stats = st.code === 0 ? parseDommemstat(st.stdout) : null;
  const xml = run('virsh', ['-c', URI, 'dumpxml', domain]);
  const dev = xml.code === 0 ? parseMemoryDevice(xml.stdout, alias) : null;
  return { stats, dev, hostAvailKiB: hostAvailableKiB(readFile) };
}

function applyRequested(run, domain, alias, targetKiB) {
  const r = run('virsh', ['-c', URI, 'update-memory-device', domain, '--alias', alias, '--live', '--requested-size', String(Math.round(targetKiB))]);
  return { ok: r.code === 0, error: r.code === 0 ? null : (r.stderr || '').trim().slice(0, 200) };
}

// One controller step; `state` carries what the policy needs between polls and is returned updated.
function step({ run, domain, alias, cfg, state, now, readFile, dryRun }) {
  const { stats, dev, hostAvailKiB } = readInputs(run, domain, alias, readFile);
  if (!dev) return { state, record: { at: now, action: 'hold', reason: `no virtio-mem device '${alias}' on ${domain}` } };
  const c = { ...DEFAULTS, ...cfg };
  const usable = stats && (typeof stats.usable === 'number' ? stats.usable : stats.unused);
  const next = { ...state };
  next.highSince = usable != null && usable > c.highKiB ? (state.highSince != null ? state.highSince : now) : null;
  const unsettled = Math.abs((dev.currentKiB || 0) - (dev.requestedKiB || 0)) > c.settleToleranceKiB;
  next.unsettledSince = unsettled ? (state.unsettledSince != null ? state.unsettledSince : now) : null;
  const d = decide({
    stats: stats && usable != null ? { usable, swapOut: stats.swap_out } : null,
    requestedKiB: dev.requestedKiB || 0, pluggedKiB: dev.currentKiB || 0, hostAvailKiB,
    highSince: next.highSince, unsettledSince: next.unsettledSince, prevSwapOut: state.prevSwapOut, lastFailureAt: state.lastFailureAt, now,
  }, c);
  if (stats && typeof stats.swap_out === 'number') next.prevSwapOut = stats.swap_out;
  const record = { at: now, action: d.action, requestedMiB: Math.round((dev.requestedKiB || 0) / 1024), pluggedMiB: Math.round((dev.currentKiB || 0) / 1024),
    usableMiB: usable == null ? null : Math.round(usable / 1024), targetMiB: Math.round(d.targetKiB / 1024), reason: d.reason, dryRun: !!dryRun };
  if (d.action !== 'hold' && !dryRun) {
    const res = applyRequested(run, domain, alias, d.targetKiB);
    record.ok = res.ok;
    if (!res.ok) { record.error = res.error; next.lastFailureAt = now; } else { next.highSince = null; next.unsettledSince = null; }
  }
  return { state: next, record };
}

function main(argv) {
  const get = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const domain = get('--domain', 'p40-passthrough'), alias = get('--alias', 'ua-virtiomem0'), poll = Number(get('--poll', '5'));
  const dryRun = argv.includes('--dry-run'), once = argv.includes('--once');
  let state = { highSince: null, unsettledSince: null, prevSwapOut: null, lastFailureAt: null };
  const tick = () => {
    const r = step({ run: realRun, domain, alias, cfg: {}, state, now: Math.floor(Date.now() / 1000), dryRun });
    state = r.state;
    if (r.record.action !== 'hold' || once) console.log(JSON.stringify(r.record));
    if (!once) setTimeout(tick, poll * 1000);
  };
  tick();
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { parseDommemstat, parseMemoryDevice, hostAvailableKiB, step, applyRequested };
