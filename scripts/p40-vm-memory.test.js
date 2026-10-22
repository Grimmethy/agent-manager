'use strict';

// Tests for scripts/p40-vm-memory/ (docs/agents/p40-vm-memory.md): the virtio-mem policy, the controller against a fake virsh, the read-only precheck,
// the XML conversion against a copy of the live domain XML, the measurement sampler and the offline guest-disk script against fake binaries.
// Nothing here calls the real virsh, ssh, qemu-nbd or touches a disk.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DIR = path.join(__dirname, 'p40-vm-memory');
const { decide, DEFAULTS } = require(path.join(DIR, 'policy.js'));
const ctl = require(path.join(DIR, 'controller.js'));
const { evaluate, format, versionAtLeast } = require(path.join(DIR, 'precheck.js'));
const { convert } = require(path.join(DIR, 'convert-xml.js'));
const { sample } = require(path.join(DIR, 'measure.js'));
const FIXTURE_XML = fs.readFileSync(path.join(DIR, 'fixtures', 'p40-passthrough.xml'), 'utf8');

const MiB = 1024;
const base = (o = {}) => ({ stats: { usable: 3000 * MiB, swapOut: 0 }, requestedKiB: 0, pluggedKiB: 0, hostAvailKiB: 8000 * MiB, highSince: null, unsettledSince: null,
  prevSwapOut: 0, lastFailureAt: null, now: 1000, ...o });

// ---- policy ----
test('grows a step when the guest has little usable memory', () => {
  const d = decide(base({ stats: { usable: 500 * MiB } }));
  assert.equal(d.action, 'grow'); assert.equal(d.targetKiB, DEFAULTS.stepKiB);
});
test('grows when the guest is swapping even with usable memory', () => {
  assert.equal(decide(base({ stats: { usable: 2000 * MiB, swapOut: 9000 }, prevSwapOut: 0 })).action, 'grow');
  assert.equal(decide(base({ stats: { usable: 2000 * MiB, swapOut: 100 }, prevSwapOut: 0 })).action, 'hold', 'swap noise under the slack is ignored');
});
test('never requests past the cap', () => {
  assert.equal(decide(base({ stats: { usable: 100 * MiB }, requestedKiB: DEFAULTS.capKiB, pluggedKiB: DEFAULTS.capKiB })).action, 'hold');
  const d = decide(base({ stats: { usable: 100 * MiB }, requestedKiB: DEFAULTS.capKiB - 1000, pluggedKiB: DEFAULTS.capKiB - 1000 }));
  assert.equal(d.targetKiB, DEFAULTS.capKiB);
});
test('holds when the host would fall under its reserve', () => {
  const d = decide(base({ stats: { usable: 100 * MiB }, hostAvailKiB: DEFAULTS.hostReserveKiB + 10 }));
  assert.equal(d.action, 'hold'); assert.match(d.reason, /reserve/);
});
test('waits while a plug or unplug is still in flight', () => {
  const d = decide(base({ stats: { usable: 100 * MiB }, requestedKiB: 512 * MiB, pluggedKiB: 256 * MiB, unsettledSince: 990 }));
  assert.equal(d.action, 'hold'); assert.match(d.reason, /waiting for plug/);
});
test('accepts what the guest has when an unplug is stuck past the limit', () => {
  const d = decide(base({ stats: { usable: 3000 * MiB }, requestedKiB: 0, pluggedKiB: 256 * MiB, unsettledSince: 1000 - DEFAULTS.stuckAfterS - 1 }));
  assert.equal(d.action, 'hold', 'plugged above requested (an unplug in flight) is waited out, not accepted away');
  const g = decide(base({ stats: { usable: 3000 * MiB }, requestedKiB: 512 * MiB, pluggedKiB: 256 * MiB, unsettledSince: 1000 - DEFAULTS.stuckAfterS - 1 }));
  assert.equal(g.action, 'accept'); assert.equal(g.targetKiB, 256 * MiB);
});
test('shrinks only after usable stayed high long enough, and never below zero', () => {
  const s = base({ stats: { usable: 3500 * MiB }, requestedKiB: 512 * MiB, pluggedKiB: 512 * MiB });
  assert.equal(decide({ ...s, highSince: 900 }).action, 'hold');
  const d = decide({ ...s, highSince: 1000 - DEFAULTS.shrinkAfterS });
  assert.equal(d.action, 'shrink'); assert.equal(d.targetKiB, 512 * MiB - DEFAULTS.stepKiB);
  assert.equal(decide(base({ stats: { usable: 3500 * MiB }, highSince: 0 })).action, 'hold', 'nothing to give back at zero');
});
test('backs off after a failed update and holds without stats', () => {
  assert.match(decide(base({ stats: { usable: 100 * MiB }, lastFailureAt: 990 })).reason, /backing off/);
  assert.equal(decide(base({ lastFailureAt: 1000 - DEFAULTS.backoffS - 1, stats: { usable: 100 * MiB } })).action, 'grow');
  assert.equal(decide(base({ stats: null })).action, 'hold');
});

// ---- controller ----
const DEV_XML = (req, cur) => `<domain><devices><memory model='virtio-mem'><target><size unit='KiB'>2097152</size><node>0</node><block unit='KiB'>2048</block>` +
  `<requested unit='KiB'>${req}</requested><current unit='KiB'>${cur}</current></target><alias name='ua-virtiomem0'/></memory></devices></domain>`;
function fakeRun(log, { stats, xml, updateCode = 0 }) {
  return (cmd, args) => {
    log.push(args.join(' '));
    if (args.includes('dommemstat')) return { code: 0, stdout: stats, stderr: '' };
    if (args.includes('dumpxml')) return { code: 0, stdout: xml, stderr: '' };
    if (args.includes('update-memory-device')) return { code: updateCode, stdout: '', stderr: updateCode ? 'boom' : '' };
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
}
const MEMINFO = (kib) => () => `MemTotal: 20000000 kB\nMemAvailable: ${kib} kB\n`;
const STATS_LOW = 'actual 4194304\nusable 400000\nswap_out 0\n';

test('parseMemoryDevice reads requested and plugged sizes and the alias', () => {
  const d = ctl.parseMemoryDevice(DEV_XML(262144, 131072), 'ua-virtiomem0');
  assert.deepEqual(d, { alias: 'ua-virtiomem0', sizeKiB: 2097152, requestedKiB: 262144, currentKiB: 131072 });
  assert.equal(ctl.parseMemoryDevice(DEV_XML(0, 0), 'other'), null);
});
test('a controller step grows through virsh update-memory-device with the right size', () => {
  const log = [];
  const r = ctl.step({ run: fakeRun(log, { stats: STATS_LOW, xml: DEV_XML(0, 0) }), domain: 'p40', alias: 'ua-virtiomem0', cfg: {}, state: {}, now: 1000, readFile: MEMINFO(8000000) });
  assert.equal(r.record.action, 'grow');
  assert.ok(log.some((l) => l.includes('update-memory-device p40 --alias ua-virtiomem0 --live --requested-size 262144')), log.join('\n'));
});
test('dry-run decides but never calls update-memory-device', () => {
  const log = [];
  const r = ctl.step({ run: fakeRun(log, { stats: STATS_LOW, xml: DEV_XML(0, 0) }), domain: 'p40', alias: 'ua-virtiomem0', cfg: {}, state: {}, now: 1000, readFile: MEMINFO(8000000), dryRun: true });
  assert.equal(r.record.action, 'grow'); assert.equal(r.record.dryRun, true);
  assert.ok(!log.some((l) => l.includes('update-memory-device')));
});
test('a failed update is recorded and starts the back-off', () => {
  const log = [];
  const r = ctl.step({ run: fakeRun(log, { stats: STATS_LOW, xml: DEV_XML(0, 0), updateCode: 1 }), domain: 'p40', alias: 'ua-virtiomem0', cfg: {}, state: {}, now: 1000, readFile: MEMINFO(8000000) });
  assert.equal(r.record.ok, false); assert.equal(r.state.lastFailureAt, 1000);
  const again = ctl.step({ run: fakeRun([], { stats: STATS_LOW, xml: DEV_XML(0, 0) }), domain: 'p40', alias: 'ua-virtiomem0', cfg: {}, state: r.state, now: 1010, readFile: MEMINFO(8000000) });
  assert.match(again.record.reason, /backing off/);
});
test('no virtio-mem device means hold, never a write', () => {
  const log = [];
  const r = ctl.step({ run: fakeRun(log, { stats: STATS_LOW, xml: '<domain/>' }), domain: 'p40', alias: 'ua-virtiomem0', cfg: {}, state: {}, now: 1, readFile: MEMINFO(8000000) });
  assert.equal(r.record.action, 'hold'); assert.ok(!log.some((l) => l.includes('update-memory-device')));
});

// ---- precheck ----
const GOOD = { qemuVersion: '8.2.2', libvirtVersion: '10.0.0', qemuHasVirtioMem: true, dmaEntryLimit: '65535', guestFacts: { kernel: '6.8.0', virtioMemModule: true, hotremove: true }, domainXml: FIXTURE_XML };
test('precheck says GO on the live-shaped facts and carries the memlock warning', () => {
  const r = evaluate(GOOD);
  assert.equal(r.go, true, JSON.stringify(r.blockers));
  assert.ok(r.checks.some((c) => c.warn && /locked-memory/.test(c.name)));
  assert.match(format(r), /^GO:|\nGO:/m);
});
test('precheck says NO-GO and names the reason for each blocker', () => {
  for (const [patch, needle] of [[{ qemuVersion: '5.2.0' }, /QEMU 6\.1/], [{ libvirtVersion: '7.0.0' }, /libvirt 8\.1/], [{ qemuHasVirtioMem: false }, /virtio-mem device/],
    [{ dmaEntryLimit: '1000' }, /dma_entry_limit/], [{ guestFacts: null }, /virtio_mem driver/], [{ guestFacts: { kernel: 'k', virtioMemModule: true, hotremove: false } }, /hot-remove/],
    [{ domainXml: FIXTURE_XML.replace("model='virtio'", "model='virtio-mem'") }, /already defined/], [{ domainXml: FIXTURE_XML.replace('<vcpu', '<maxMemory slots="1" unit="KiB">1</maxMemory><vcpu') }, /maxMemory> or NUMA/]]) {
    const r = evaluate({ ...GOOD, ...patch });
    assert.equal(r.go, false, needle.toString());
    assert.ok(r.blockers.some((b) => needle.test(b)), `${needle}: ${r.blockers.join(' | ')}`);
  }
  assert.equal(versionAtLeast('10.0.0', 8, 1), true); assert.equal(versionAtLeast('8.0.9', 8, 1), false);
});

// ---- convert-xml ----
test('conversion adds maxMemory, a NUMA cell and one virtio-mem device and keeps everything else', () => {
  const out = convert(FIXTURE_XML);
  assert.match(out, /<maxMemory slots='1' unit='KiB'>6291456<\/maxMemory>/);
  assert.match(out, /<memory unit='KiB'>4194304<\/memory>/);
  assert.match(out, /<cell id='0' cpus='0-1' memory='4194304' unit='KiB'\/>/);
  assert.equal((out.match(/model='virtio-mem'/g) || []).length, 1);
  assert.match(out, /<requested unit='KiB'>0<\/requested>/);
  assert.match(out, /<hostdev/, 'the passthrough device is untouched');
  assert.ok(out.indexOf('<maxMemory') < out.indexOf("<memory unit='KiB'>"), 'maxMemory precedes memory as libvirt requires');
});
test('conversion refuses XML it does not understand', () => {
  assert.throws(() => convert('<nope/>'), /not a libvirt domain/);
  assert.throws(() => convert(convert(FIXTURE_XML)), /already has a virtio-mem|already has maxMemory/);
  assert.throws(() => convert(FIXTURE_XML.replace('<vcpu', "<maxMemory slots='1' unit='KiB'>9</maxMemory><vcpu")), /already has maxMemory or a NUMA cell/);
  assert.throws(() => convert(FIXTURE_XML.replace('<devices>', '<numa><cell id="0"/></numa><devices>')), /already has maxMemory or a NUMA cell/);
  assert.throws(() => convert(FIXTURE_XML.replace(/<vcpu[^>]*>\d+<\/vcpu>/, '')), /unexpected XML shape/);
  assert.throws(() => convert(FIXTURE_XML, { regionKiB: 1000 }), /multiple of the block/);
});
test('the conversion CLI writes the new XML and an identical rollback copy and never runs virsh define', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vmem-conv-'));
  const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin);
  const callLog = path.join(tmp, 'virsh-calls.log');
  fs.writeFileSync(path.join(bin, 'virsh'), `#!/bin/bash\necho "$@" >> ${callLog}\nexit 0\n`, { mode: 0o755 });
  const inFile = path.join(tmp, 'cur.xml'); fs.writeFileSync(inFile, FIXTURE_XML);
  const r = spawnSync('node', [path.join(DIR, 'convert-xml.js'), '--in', inFile, '--out-dir', path.join(tmp, 'out')], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(tmp, 'out', 'p40-passthrough.rollback.xml'), 'utf8'), FIXTURE_XML);
  assert.match(fs.readFileSync(path.join(tmp, 'out', 'p40-passthrough.virtio-mem.xml'), 'utf8'), /virtio-mem/);
  assert.match(r.stdout, /nothing was defined or restarted/);
  assert.ok(!fs.existsSync(callLog) || !/define|shutdown|start/.test(fs.readFileSync(callLog, 'utf8')), 'no virsh define/shutdown/start was called');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---- measure ----
test('the sampler reports RSS, requested/plugged, guest usable and host available together', () => {
  const files = { '/proc/4242/status': 'Name: qemu\nVmRSS:\t 6344000 kB\n', '/proc/meminfo': 'MemAvailable: 5900000 kB\n' };
  const run = (c, a) => (a.includes('dumpxml') ? { stdout: DEV_XML(524288, 262144) } : { stdout: 'actual 4194304\nusable 3300000\n' });
  const s = sample({ run, readFile: (p) => files[p], pidOf: () => 4242, domain: 'p40-passthrough', alias: 'ua-virtiomem0', now: 'T' });
  assert.deepEqual(s, { at: 'T', qemuRssMiB: 6195, requestedMiB: 512, pluggedMiB: 256, guestUsableMiB: 3223, hostAvailableMiB: 5762 });
});

// ---- offline guest-disk script (fake binaries; no disk is touched) ----
function offlineEnv({ domstate = 'shut off', attached = false, node = false, backing = 'nbd0' } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vmem-off-'));
  const sys = path.join(tmp, 'sys'); fs.mkdirSync(sys);
  const nodeFile = path.join(tmp, 'node'); const mnt = path.join(tmp, 'mnt'); const log = path.join(tmp, 'calls.log');
  if (attached) fs.writeFileSync(path.join(sys, 'pid'), '1234');
  if (node) fs.writeFileSync(nodeFile, '');
  const fake = (name, body) => { const p = path.join(tmp, name); fs.writeFileSync(p, `#!/bin/bash\necho "${name} $@" >> ${log}\n${body}\n`, { mode: 0o755 }); return p; };
  const env = {
    ...process.env, P40_ALLOW_NONROOT: '1', NBD_SETTLE: '0', NBD_SYS: sys, NODE: nodeFile, MNT: mnt, DM: 'ubuntu--vg-ubuntu--lv',
    VIRSH: fake('virsh', `echo "${domstate}"`),
    QEMU_NBD: fake('qemu-nbd', `if [ "$1" = "--connect=/dev/nbd0" ]; then echo 4242 > ${sys}/pid; touch ${nodeFile}; else rm -f ${sys}/pid; fi`),
    DMSETUP: fake('dmsetup', `if [ "$1" = "deps" ]; then echo "1 dependencies : (${backing}p3)"; elif [ "$1" = "remove" ]; then rm -f ${nodeFile}; fi`),
    MODPROBE: fake('modprobe', ''), PARTPROBE: fake('partprobe', ''), LVM: fake('lvm', ''), PGREP: fake('pgrep', 'exit 1'),
    MOUNT: fake('mount', ''), UMOUNT: fake('umount', ''),
  };
  return { env, tmp, log, sys, nodeFile, mnt, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '') };
}
const runOffline = (e, args = []) => spawnSync('bash', [path.join(DIR, 'offline-apply-udev.sh'), ...args], { encoding: 'utf8', env: { ...e.env, RULE_DST: 'rules/99.rules', RULE_SRC: path.join(DIR, 'guest', '99-virtio-mem-online-movable.rules') } });

test('offline script refuses while the VM is running', () => {
  const e = offlineEnv({ domstate: 'running' }); const r = runOffline(e);
  assert.notEqual(r.status, 0); assert.match(r.stdout, /not shut off/); assert.ok(!/qemu-nbd/.test(e.calls()), 'attached nothing'); fs.rmSync(e.tmp, { recursive: true, force: true });
});
test('offline script refuses when an nbd attach or mapper node is left over and points at --cleanup', () => {
  for (const o of [{ attached: true }, { node: true }]) {
    const e = offlineEnv(o); const r = runOffline(e);
    assert.notEqual(r.status, 0); assert.match(r.stdout, /leftover attach/); assert.match(r.stdout, /--cleanup/);
    assert.ok(!/qemu-nbd --connect/.test(e.calls())); fs.rmSync(e.tmp, { recursive: true, force: true });
  }
});
test('offline script aborts and still cleans up when the mapper node is not backed by the nbd device', () => {
  const e = offlineEnv({ backing: 'sda' }); const r = runOffline(e);
  assert.notEqual(r.status, 0); assert.match(r.stdout, /not backed by the nbd device/);
  assert.ok(!/^mount /m.test(e.calls()), 'never mounted a host disk'); assert.ok(/qemu-nbd --disconnect/.test(e.calls()), 'disconnected on the way out');
  fs.rmSync(e.tmp, { recursive: true, force: true });
});
test('offline script installs the rule on the happy path, is idempotent, and always detaches', () => {
  const e = offlineEnv(); const r = runOffline(e);
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /installed \/rules\/99\.rules/);
  assert.match(e.calls(), /qemu-nbd --connect=\/dev\/nbd0/); assert.match(e.calls(), /dmsetup remove/); assert.match(e.calls(), /qemu-nbd --disconnect/);
  assert.ok(!fs.existsSync(path.join(e.sys, 'pid')), 'nbd detached'); assert.ok(!fs.existsSync(e.nodeFile), 'mapper node removed');
  fs.rmSync(e.tmp, { recursive: true, force: true });
});
test('offline script --cleanup removes a leftover attach but leaves a node that is not backed by nbd', () => {
  const e = offlineEnv({ attached: true, node: true }); const r = runOffline(e, ['--cleanup']);
  assert.equal(r.status, 0, r.stdout); assert.ok(!fs.existsSync(e.nodeFile)); assert.ok(!fs.existsSync(path.join(e.sys, 'pid')));
  fs.rmSync(e.tmp, { recursive: true, force: true });
  const f = offlineEnv({ node: true, backing: 'sda' }); const q = runOffline(f, ['--cleanup']);
  assert.match(q.stdout, /not backed by an nbd device/); assert.ok(fs.existsSync(f.nodeFile), 'did not touch a node that is not nbd-backed');
  fs.rmSync(f.tmp, { recursive: true, force: true });
});
