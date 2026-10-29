#!/usr/bin/env node
'use strict';

// Read-only go/no-go for converting the P40 VM to virtio-mem (docs/agents/p40-vm-memory.md). Changes nothing: every probe is a read (virsh, qemu
// --version, /sys, one ssh to the guest). Probes are injected so the tests run on fixtures. Exit code 0 only on GO.
//   node scripts/p40-vm-memory/precheck.js [--domain p40-passthrough] [--guest 192.168.122.29]

const { spawnSync } = require('child_process');
const fs = require('fs');

function versionAtLeast(text, major, minor) {
  const m = String(text || '').match(/(\d+)\.(\d+)/);
  return !!m && (Number(m[1]) > major || (Number(m[1]) === major && Number(m[2]) >= minor));
}

// probes: { qemuVersion, libvirtVersion, qemuHasVirtioMem, dmaEntryLimit, guestFacts:{virtioMemModule,hotremove,kernel}|null, domainXml }
function evaluate(p) {
  const checks = [];
  const add = (name, ok, detail, warn = false) => checks.push({ name, ok: !!ok, warn: !!warn && !ok, detail });
  add('QEMU 6.1 or newer (virtio-mem with VFIO via RamDiscardManager)', versionAtLeast(p.qemuVersion, 6, 1), `QEMU ${p.qemuVersion || 'unknown'}`);
  add('libvirt 8.1 or newer (virsh update-memory-device)', versionAtLeast(p.libvirtVersion, 8, 1), `libvirt ${p.libvirtVersion || 'unknown'}`);
  add('QEMU lists the virtio-mem device', p.qemuHasVirtioMem, p.qemuHasVirtioMem ? 'virtio-mem-pci present' : 'device not listed by qemu -device help');
  const lim = Number(p.dmaEntryLimit);
  add('vfio dma_entry_limit has room for the region (>= 8192)', lim >= 8192, `dma_entry_limit = ${Number.isFinite(lim) ? lim : 'unreadable'}`);
  const g = p.guestFacts;
  add('guest has the virtio_mem driver', g && g.virtioMemModule, g ? `kernel ${g.kernel}` : 'guest unreachable over ssh');
  add('guest kernel supports memory hot-remove', g && g.hotremove, g ? (g.hotremove ? 'CONFIG_MEMORY_HOTREMOVE=y' : 'CONFIG_MEMORY_HOTREMOVE not set') : 'guest unreachable over ssh');
  const x = String(p.domainXml || '');
  add('domain XML is readable', x.includes('<domain'), x.includes('<domain') ? 'ok' : 'empty or unreadable dumpxml');
  add('domain is q35', /machine=['"]pc-q35/.test(x), (x.match(/machine=['"]([^'"]+)/) || [])[1] || 'unknown machine type');
  add('a VFIO device is passed through (the reason the balloon cannot return memory)', /<hostdev[^>]*>[\s\S]*?<driver\s+name=['"]vfio['"]/.test(x) || /<hostdev/.test(x), /<hostdev/.test(x) ? 'hostdev present' : 'no hostdev: a plain balloon would already work');
  add('no virtio-mem device already defined', !/model=['"]virtio-mem['"]/.test(x), /model=['"]virtio-mem['"]/.test(x) ? 'a virtio-mem device already exists' : 'none yet');
  add('no <maxMemory> or NUMA cell already in the XML', !/<maxMemory/.test(x) && !/<numa>/.test(x), /<maxMemory|<numa>/.test(x) ? 'XML already has maxMemory or numa: convert-xml.js refuses to guess' : 'clean');
  add('VFIO locked-memory limit: no explicit <hard_limit>', /<hard_limit/.test(x), /<hard_limit/.test(x) ? 'explicit hard_limit set: it must cover base + region' : 'none set, libvirt derives it: after conversion read /proc/<qemu pid>/limits and confirm Max locked memory >= base + region (the oVirt hot-add crash)', true);
  const bad = checks.filter((c) => !c.ok && !c.warn);
  return { go: bad.length === 0, checks, blockers: bad.map((c) => c.name) };
}

function format(report) {
  const lines = report.checks.map((c) => `${c.ok ? 'PASS' : c.warn ? 'WARN' : 'FAIL'}  ${c.name}  --  ${c.detail}`);
  lines.push('', report.go ? 'GO: every blocking check passed (warnings still need the post-conversion checks in the runbook).' : `NO-GO: ${report.blockers.length} blocking check(s) failed.`);
  return lines.join('\n');
}

function sh(cmd, args, timeout = 15000) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout });
  return { code: r.status === null ? 1 : r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function liveProbes(domain, guest) {
  const q = sh('qemu-system-x86_64', ['--version']).out;
  const v = sh('virsh', ['--version']).out;
  const devs = sh('qemu-system-x86_64', ['-device', 'help']).out;
  let dma = null;
  try { dma = fs.readFileSync('/sys/module/vfio_iommu_type1/parameters/dma_entry_limit', 'utf8').trim(); } catch { /* unreadable stays null */ }
  const gr = sh('ssh', ['-o', 'ConnectTimeout=6', '-o', 'BatchMode=yes', guest,
    'uname -r; ls /lib/modules/$(uname -r)/kernel/drivers/virtio/ 2>/dev/null | grep -c virtio_mem; grep -c "^CONFIG_MEMORY_HOTREMOVE=y" /boot/config-$(uname -r) 2>/dev/null'], 20000);
  let guestFacts = null;
  if (gr.code === 0) { const [kernel, mod, hot] = gr.out.trim().split('\n'); guestFacts = { kernel, virtioMemModule: Number(mod) > 0, hotremove: Number(hot) > 0 }; }
  return { qemuVersion: (q.match(/version\s+([\d.]+)/) || [])[1], libvirtVersion: v.trim(), qemuHasVirtioMem: /virtio-mem/.test(devs), dmaEntryLimit: dma, guestFacts,
    domainXml: sh('virsh', ['-c', 'qemu:///system', 'dumpxml', '--inactive', domain]).out };
}

if (require.main === module) {
  const a = process.argv.slice(2), get = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const report = evaluate(liveProbes(get('--domain', 'p40-passthrough'), get('--guest', '192.168.122.29')));
  console.log(format(report));
  process.exit(report.go ? 0 : 1);
}
module.exports = { evaluate, format, versionAtLeast };
