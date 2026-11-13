'use strict';

// Forge mode (2026-11-12): put the machine into 'image run' state for the duration of a run and put everything back after, with ONE command
//   node src/forge-mode.js on [--vm off|keep] | off | status [--json] | expire        (scripts/forge-mode.sh is the thin wrapper; the dashboard route calls the same functions)
// The pipeline is PAUSED, not stopped: nothing is killed, nothing has to be restarted by hand afterwards.
//   marker      ~/.local/state/agent-manager/pipeline-paused (JSON): drains finish their tick and exit and no trigger starts one while it exists (the drains' marker check accepts it
//               next to pipeline-stopped); the watchdog's triggers start the drains again on their next wake after `off` removes it.
//   GPU session POST <PromptForge>/api/gpu/acquire {owner:'forge-mode'}: PromptForge evicts the local models and starts ComfyUI, and while the lease is held the workers and reviewers idle
//               by themselves (scripts/agent-manager-common.sh comfyui_lease_held) and resume when it is released. No second mechanism is invented here.
//   P40 VM      --vm off shuts the libvirt domain down gracefully and waits for 'shut off'; `off` starts it again only if forge mode shut it down. Default: keep.
// `on` refuses first, with the numbers and what holds the memory, when MemAvailable after the planned steps would be under 10 GB or the I/O pressure (some, 10 s) is 50 percent or more.
// A failing step rolls the earlier ones back. Forge mode ends by itself after 6 hours or when the GPU session is gone (`expire`, called by the watchdog). One log line per step.
// Standard library only; every side effect goes through an injectable `io` so the tests never touch the machine.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');

const MIN_AVAIL_MB = 10240;
const MAX_IO_SOME10 = 50;
const MAX_AGE_MIN = 360;
const VM_WAIT_S = 180;

const stateDir = (env) => path.join((env && env.HOME) || os.homedir(), '.local', 'state', 'agent-manager');
const markerPath = (env) => path.join(stateDir(env), 'pipeline-paused');

function readMarker(env) {
  try { return JSON.parse(fs.readFileSync(markerPath(env), 'utf8')); } catch { return null; }
}

// ---- readings (from /proc, or FORGE_MODE_PROC for tests) ----
function readings(env = process.env) {
  const proc = env.FORGE_MODE_PROC || '/proc';
  let availMB = null, io = null;
  try { const m = /MemAvailable:\s+(\d+) kB/.exec(fs.readFileSync(path.join(proc, 'meminfo'), 'utf8')); if (m) availMB = Number(m[1]) / 1024; } catch { /* unreadable */ }
  try { const m = /^some avg10=([\d.]+)/m.exec(fs.readFileSync(path.join(proc, 'pressure', 'io'), 'utf8')); if (m) io = Number(m[1]); } catch { /* unreadable */ }
  return { availMB, io };
}

function topRss(exec, n = 5) {
  const r = exec('ps', ['-eo', 'rss=,comm=', '--sort=-rss']);
  return String(r.stdout || '').split('\n').filter(Boolean).slice(0, n).map((l) => { const [rss, ...c] = l.trim().split(/\s+/); return `${c.join(' ')} ${(Number(rss) / 1024).toFixed(0)} MB`; });
}

// -> { ok, reasons[], top[] }. plannedFreeMB: what the planned steps will give back (the VM when it goes, the models PromptForge evicts).
function preflight({ availMB, io, plannedFreeMB = 0, minAvailMB = MIN_AVAIL_MB, maxIo = MAX_IO_SOME10, top = [] }) {
  const reasons = [];
  if (availMB === null || availMB === undefined) reasons.push('MemAvailable is unreadable');
  else if (availMB + plannedFreeMB < minAvailMB) reasons.push(`MemAvailable ${Math.round(availMB)} MB + ${Math.round(plannedFreeMB)} MB freed by the plan = ${Math.round(availMB + plannedFreeMB)} MB, under the ${minAvailMB} MB needed`);
  if (io !== null && io !== undefined && io >= maxIo) reasons.push(`I/O pressure (some, 10 s) is ${io}%, the limit is under ${maxIo}%`);
  return { ok: reasons.length === 0, reasons, top };
}

// ---- real io (replaced in tests) ----
function realIo(env = process.env) {
  const pf = (env.FORGE_MODE_PF_URL || 'http://localhost:7430').replace(/\/$/, '');
  const request = (method, p, body) => new Promise((resolve) => {
    const u = new URL(pf + p);
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}, timeout: 60000 }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { /* not json */ } resolve({ status: res.statusCode, json: j }); });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message })); req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (data) req.write(data); req.end();
  });
  return {
    env,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (line) => process.stdout.write(`[forge-mode] ${line}\n`),
    exec: (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 60000 }); return { status: r.status === null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '' }; },
    pf: request,
    modelsMB: async () => { try { const o = (env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, ''); const r = await new Promise((res) => { const u = new URL(o + '/api/ps'); http.get({ hostname: u.hostname, port: u.port, path: u.pathname, timeout: 5000 }, (rs) => { const c = []; rs.on('data', (d) => c.push(d)); rs.on('end', () => { try { res(JSON.parse(Buffer.concat(c).toString())); } catch { res(null); } }); }).on('error', () => res(null)); }); return r && r.models ? r.models.reduce((a, m) => a + (m.size || 0), 0) / 1048576 : 0; } catch { return 0; } },
  };
}

const domain = (env) => env.FORGE_MODE_VM_DOMAIN || 'p40-passthrough';
const virsh = (io, ...args) => io.exec('virsh', ['-c', 'qemu:///system', ...args]);
const vmState = (io) => String(virsh(io, 'domstate', domain(io.env)).stdout || '').trim();

async function waitVm(io, want, seconds) {
  const t0 = io.now();
  for (;;) {
    if (vmState(io) === want) return true;
    if ((io.now() - t0) / 1000 >= seconds) return false;
    await io.sleep(3000);
  }
}

// ---- on ----
async function on({ vm = 'keep' } = {}, io = realIo()) {
  const env = io.env;
  if (readMarker(env)) { io.log('already in forge mode (see status)'); return 0; }
  const vmRunning = vm === 'off' && vmState(io) === 'running';
  const rd = readings(env);
  const planned = (vmRunning ? Number(env.FORGE_MODE_VM_MB || 4300) : 0) + (await io.modelsMB());
  const pre = preflight({ ...rd, plannedFreeMB: planned, top: topRss(io.exec) });
  if (!pre.ok) {
    io.log(`refused: ${pre.reasons.join('; ')}`);
    if (pre.top.length) io.log(`holding memory: ${pre.top.join(', ')}`);
    if (vm !== 'off') io.log('hint: --vm off shuts the P40 VM down and frees about 4 GB');
    return 1;
  }
  io.log(`preflight ok (MemAvailable ${Math.round(rd.availMB)} MB, I/O ${rd.io}%)`);
  const undo = [];
  const fail = async (why) => { io.log(`failed: ${why}; rolling back`); for (const u of undo.reverse()) await u(); return 1; };
  const state = { since: new Date(io.now()).toISOString(), vm, vmShutDown: false, gpu: false };
  fs.mkdirSync(stateDir(env), { recursive: true });
  fs.writeFileSync(markerPath(env), JSON.stringify(state));
  undo.push(async () => { try { fs.unlinkSync(markerPath(env)); io.log('rolled back: marker removed'); } catch { /* gone */ } });
  io.log('step 1: pipeline-paused marker created (drains finish their tick and exit; no trigger starts one)');
  const acq = await io.pf('POST', '/api/gpu/acquire', { owner: 'forge-mode' });
  if (acq.status !== 200) return fail(`GPU session refused (${acq.status || acq.error})`);
  state.gpu = true;
  undo.push(async () => { await io.pf('POST', '/api/gpu/release', {}); io.log('rolled back: GPU session released'); });
  io.log('step 2: GPU session taken (local models evicted, ComfyUI started; workers idle while the lease is held)');
  if (vm === 'off' && vmRunning) {
    const sd = virsh(io, 'shutdown', domain(env));
    if (sd.status !== 0) return fail(`virsh shutdown failed (${String(sd.stderr).trim()})`);
    if (!(await waitVm(io, 'shut off', VM_WAIT_S))) return fail(`the VM did not shut off within ${VM_WAIT_S} s`);
    state.vmShutDown = true;
    undo.push(async () => { virsh(io, 'start', domain(env)); io.log('rolled back: VM started'); });
    io.log('step 3: P40 VM shut off');
  } else io.log(`step 3: P40 VM left as it is (${vm === 'off' ? 'not running' : 'keep'})`);
  fs.writeFileSync(markerPath(env), JSON.stringify(state));
  io.log('forge mode is on (it ends by itself after 6 hours or when the GPU session is gone)');
  return 0;
}

// ---- off ----
async function off(io = realIo(), reason = '') {
  const env = io.env;
  const st = readMarker(env);
  if (!st) { io.log('not in forge mode'); return 0; }
  let code = 0;
  io.log(`turning forge mode off${reason ? ` (${reason})` : ''}`);
  if (st.vmShutDown) { const r = virsh(io, 'start', domain(env)); io.log(r.status === 0 ? 'step 1: P40 VM started' : `step 1: P40 VM start FAILED (${String(r.stderr).trim()})`); if (r.status !== 0) code = 1; } else io.log('step 1: P40 VM was not shut down by forge mode: untouched');
  const rel = await io.pf('POST', '/api/gpu/release', {});
  io.log(rel.status === 200 ? 'step 2: GPU session released (workers resume by themselves)' : `step 2: GPU session release FAILED (${rel.status || rel.error}); it ends by itself after 20 minutes idle`);
  if (rel.status !== 200) code = 1;
  try { fs.unlinkSync(markerPath(env)); } catch { /* gone */ }
  io.log('step 3: pipeline-paused marker removed (the triggers restart the drains on their next wake)');
  return code;
}

// ---- status / expire ----
async function status(io = realIo()) {
  const env = io.env;
  const st = readMarker(env);
  const rd = readings(env);
  const g = await io.pf('GET', '/api/gpu/status');
  const age = st ? Math.max(0, Math.round((io.now() - Date.parse(st.since)) / 60000)) : null;
  return { paused: !!st, since: st ? st.since : null, ageMin: age, expiresInMin: st ? Math.max(0, MAX_AGE_MIN - age) : null, vm: { domain: domain(env), state: vmState(io), shutDownByForgeMode: !!(st && st.vmShutDown) },
    gpuSession: { active: !!(g.json && g.json.active), reachable: g.status === 200 }, memAvailMB: rd.availMB === null ? null : Math.round(rd.availMB), ioSome10: rd.io, top: topRss(io.exec, 3) };
}

async function expire(io = realIo()) {
  const st = readMarker(io.env);
  if (!st) return { expired: false, reason: 'not in forge mode' };
  const age = (io.now() - Date.parse(st.since)) / 60000;
  const g = await io.pf('GET', '/api/gpu/status');
  const gone = g.status === 200 && g.json && g.json.active === false;
  if (age >= MAX_AGE_MIN || gone) { const why = age >= MAX_AGE_MIN ? `${Math.round(age)} min old` : 'the GPU session is gone'; await off(io, why); return { expired: true, reason: why }; }
  return { expired: false, reason: 'still running' };
}

async function main(argv, io = realIo()) {
  const cmd = argv[0];
  if (cmd === 'on') { const i = argv.indexOf('--vm'); return on({ vm: i >= 0 ? argv[i + 1] : 'keep' }, io); }
  if (cmd === 'off') return off(io);
  if (cmd === 'status') { const s = await status(io); if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(s)}\n`); else io.log(`${s.paused ? `PAUSED since ${s.since} (${s.ageMin} min, ends in ${s.expiresInMin} min)` : 'not in forge mode'}; GPU session ${s.gpuSession.active ? 'active' : 'none'}; VM ${s.vm.state}; MemAvailable ${s.memAvailMB} MB; I/O ${s.ioSome10}%`); return 0; }
  if (cmd === 'expire') { const r = await expire(io); io.log(`expire: ${r.reason}`); return 0; }
  process.stderr.write('usage: forge-mode.sh on [--vm off|keep] | off | status [--json] | expire\n');
  return 2;
}

if (require.main === module) main(process.argv.slice(2)).then((c) => process.exit(c)).catch((e) => { process.stderr.write(`[forge-mode] failed: ${e && e.message ? e.message : e}\n`); process.exit(1); });

module.exports = { MIN_AVAIL_MB, MAX_IO_SOME10, MAX_AGE_MIN, VM_WAIT_S, markerPath, readMarker, readings, preflight, on, off, status, expire, main, realIo };
