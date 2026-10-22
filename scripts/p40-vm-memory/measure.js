#!/usr/bin/env node
'use strict';

// Logs, as JSON lines, the numbers that prove (or disprove) "the host gets the memory back": the QEMU process RSS, the virtio-mem requested and
// plugged sizes, the guest's usable memory and wok's MemAvailable, sampled together. Read-only.
//   node scripts/p40-vm-memory/measure.js [--domain p40-passthrough] [--alias ua-virtiomem0] [--every 10] [--once]

const fs = require('fs');
const { spawnSync } = require('child_process');
const { parseDommemstat, parseMemoryDevice, hostAvailableKiB } = require('./controller.js');

const mib = (kib) => (kib == null ? null : Math.round(kib / 1024));

function sample({ run, readFile, pidOf, domain, alias, now }) {
  const pid = pidOf(domain);
  let rss = null;
  if (pid) { const m = String(readFile(`/proc/${pid}/status`)).match(/^VmRSS:\s+(\d+)/m); rss = m ? Number(m[1]) : null; }
  const dev = parseMemoryDevice(run('virsh', ['-c', 'qemu:///system', 'dumpxml', domain]).stdout, alias);
  const stats = parseDommemstat(run('virsh', ['-c', 'qemu:///system', 'dommemstat', domain]).stdout);
  return { at: now, qemuRssMiB: mib(rss), requestedMiB: dev ? mib(dev.requestedKiB) : null, pluggedMiB: dev ? mib(dev.currentKiB) : null,
    guestUsableMiB: mib(stats.usable != null ? stats.usable : stats.unused), hostAvailableMiB: mib(hostAvailableKiB(readFile)) };
}

function main(argv) {
  const get = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const run = (c, a) => { const r = spawnSync(c, a, { encoding: 'utf8', timeout: 20000 }); return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }; };
  const pidOf = (dom) => { const r = run('pgrep', ['-f', `guest=${dom},`]); return Number((r.stdout.split('\n')[0] || '').trim()) || null; };
  const tick = () => {
    console.log(JSON.stringify(sample({ run, readFile: (p) => fs.readFileSync(p, 'utf8'), pidOf, domain: get('--domain', 'p40-passthrough'), alias: get('--alias', 'ua-virtiomem0'), now: new Date().toISOString() })));
    if (!argv.includes('--once')) setTimeout(tick, Number(get('--every', '10')) * 1000);
  };
  tick();
}
if (require.main === module) main(process.argv.slice(2));
module.exports = { sample };
