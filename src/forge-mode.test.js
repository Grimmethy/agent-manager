'use strict';

// src/forge-mode.js (Forge mode). Unit tests inject every side effect; the CLI test runs the real script against a temp HOME, a fake PromptForge over HTTP, a fake virsh on PATH and fake /proc files.
// Nothing here touches the real machine.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const fm = require('./forge-mode.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mode-'));
const marker = (home) => path.join(home, '.local', 'state', 'agent-manager', 'pipeline-paused');

function procDir(availMB, io) {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'pressure'));
  fs.writeFileSync(path.join(d, 'meminfo'), `MemTotal: 20000000 kB\nMemAvailable: ${Math.round(availMB * 1024)} kB\n`);
  fs.writeFileSync(path.join(d, 'pressure', 'io'), `some avg10=${io} avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n`);
  return d;
}

// An injected io: virsh state machine, PromptForge calls recorded in order.
function world({ availMB = 12000, io = 10, vm = 'running', acquireStatus = 200, shutdownOk = true, shutsOff = true, gpuActive = true, vmMB } = {}) {
  const home = tmp();
  const calls = [];
  let clock = Date.parse('2026-11-12T12:00:00Z');
  const state = { vm };
  const env = { HOME: home, FORGE_MODE_PROC: procDir(availMB, io) };
  if (vmMB !== undefined) env.FORGE_MODE_VM_MB = String(vmMB);
  const i = {
    env, now: () => clock, sleep: async (ms) => { clock += ms; }, log: (l) => calls.push(`log:${l}`),
    exec: (cmd, args) => {
      if (cmd === 'ps') return { status: 0, stdout: '4000000 qemu-system-x86\n3000000 llama-server\n500000 claude\n100 bash\n' };
      const verb = args[2];
      if (verb === 'domstate') return { status: 0, stdout: `${state.vm}\n` };
      if (verb === 'shutdown') { calls.push('virsh shutdown'); if (!shutdownOk) return { status: 1, stdout: '', stderr: 'boom' }; if (shutsOff) state.vm = 'shut off'; return { status: 0, stdout: '' }; }
      if (verb === 'start') { calls.push('virsh start'); state.vm = 'running'; return { status: 0, stdout: '' }; }
      return { status: 1, stdout: '' };
    },
    pf: async (method, p, body) => {
      if (p === '/api/gpu/acquire') { calls.push(`acquire:${body.owner}:marker=${fs.existsSync(marker(home))}`); return { status: acquireStatus, json: {} }; }
      if (p === '/api/gpu/release') { calls.push('release'); return { status: 200, json: {} }; }
      if (p === '/api/gpu/status') return { status: 200, json: { active: gpuActive } };
      return { status: 404 };
    },
    modelsMB: async () => 0,
  };
  return { home, calls, state, io: i, steps: () => calls.filter((c) => !c.startsWith('log:')), logs: () => calls.filter((c) => c.startsWith('log:')).join('\n') };
}

test('preflight: MemAvailable after the plan needs 10240 MB (boundary included), I/O some 10 s must be under 50, unreadable memory refuses', () => {
  assert.equal(fm.preflight({ availMB: 10240, io: 49.9 }).ok, true);
  assert.equal(fm.preflight({ availMB: 10239, io: 10 }).ok, false);
  assert.equal(fm.preflight({ availMB: 6000, io: 10, plannedFreeMB: 4300 }).ok, true);
  assert.equal(fm.preflight({ availMB: 5000, io: 10, plannedFreeMB: 4300 }).ok, false);
  const hi = fm.preflight({ availMB: 20000, io: 50 });
  assert.equal(hi.ok, false);
  assert.match(hi.reasons[0], /I\/O pressure/);
  assert.equal(fm.preflight({ availMB: null, io: 1 }).ok, false);
  assert.equal(fm.preflight({ availMB: 20000, io: null }).ok, true);
});

test('on refuses with the numbers, the top memory holders and a hint, and changes nothing', async () => {
  const w = world({ availMB: 2000, vm: 'running' });
  assert.equal(await fm.on({ vm: 'keep' }, w.io), 1);
  assert.match(w.logs(), /refused: MemAvailable 2000 MB .* under the 10240 MB needed/);
  assert.match(w.logs(), /holding memory: qemu-system-x86 3906 MB, llama-server 2930 MB/);
  assert.match(w.logs(), /hint: --vm off/);
  assert.deepEqual(w.steps(), []);
  assert.equal(fs.existsSync(marker(w.home)), false);
});

test('on refuses on high I/O pressure even with plenty of memory', async () => {
  const w = world({ availMB: 15000, io: 80 });
  assert.equal(await fm.on({}, w.io), 1);
  assert.match(w.logs(), /I\/O pressure \(some, 10 s\) is 80%/);
  assert.deepEqual(w.steps(), []);
});

test('on with --vm off counts the VM memory as freed, then: marker first, GPU session second, VM shutdown third', async () => {
  const w = world({ availMB: 6500, vm: 'running' });
  assert.equal(await fm.on({ vm: 'off' }, w.io), 0);
  assert.deepEqual(w.steps(), ['acquire:forge-mode:marker=true', 'virsh shutdown']);                // the marker existed when the GPU session was asked for
  const st = JSON.parse(fs.readFileSync(marker(w.home), 'utf8'));
  assert.deepEqual([st.vm, st.vmShutDown], ['off', true]);
  assert.equal(w.state.vm, 'shut off');
});

test('on with the default keep never touches the VM; on twice is a no-op', async () => {
  const w = world();
  assert.equal(await fm.on({}, w.io), 0);
  assert.deepEqual(w.steps(), ['acquire:forge-mode:marker=true']);
  assert.equal(await fm.on({}, w.io), 0);
  assert.deepEqual(w.steps(), ['acquire:forge-mode:marker=true']);
  assert.match(w.logs(), /already in forge mode/);
});

test('--vm off with the VM already off leaves it alone and remembers it was not ours to start', async () => {
  const w = world({ vm: 'shut off', availMB: 11000 });
  assert.equal(await fm.on({ vm: 'off' }, w.io), 0);
  assert.equal(w.steps().includes('virsh shutdown'), false);
  assert.equal(JSON.parse(fs.readFileSync(marker(w.home), 'utf8')).vmShutDown, false);
});

test('rollback: a refused GPU session removes the marker and touches nothing else', async () => {
  const w = world({ acquireStatus: 503 });
  assert.equal(await fm.on({ vm: 'off' }, w.io), 1);
  assert.equal(fs.existsSync(marker(w.home)), false);
  assert.deepEqual(w.steps(), ['acquire:forge-mode:marker=true']);
  assert.match(w.logs(), /failed: GPU session refused \(503\); rolling back/);
});

test('rollback: a VM that will not shut off releases the GPU session and removes the marker, and does not start a VM it never stopped', async () => {
  const w = world({ availMB: 7000, shutsOff: false });
  assert.equal(await fm.on({ vm: 'off' }, w.io), 1);
  assert.deepEqual(w.steps(), ['acquire:forge-mode:marker=true', 'virsh shutdown', 'release']);
  assert.equal(fs.existsSync(marker(w.home)), false);
  assert.match(w.logs(), /did not shut off within 180 s/);
});

test('rollback: a failing virsh shutdown releases the GPU session and removes the marker', async () => {
  const w = world({ availMB: 7000, shutdownOk: false });
  assert.equal(await fm.on({ vm: 'off' }, w.io), 1);
  assert.deepEqual(w.steps(), ['acquire:forge-mode:marker=true', 'virsh shutdown', 'release']);
  assert.equal(fs.existsSync(marker(w.home)), false);
});

test('off reverses in the opposite order: the VM first (only if forge mode shut it down), then the GPU session, then the marker', async () => {
  const w = world({ availMB: 7000 });
  await fm.on({ vm: 'off' }, w.io);
  w.calls.length = 0;
  assert.equal(await fm.off(w.io), 0);
  assert.deepEqual(w.steps(), ['virsh start', 'release']);
  assert.equal(fs.existsSync(marker(w.home)), false);
  assert.equal(w.state.vm, 'running');
  const logs = w.logs();
  assert.ok(logs.indexOf('step 1: P40 VM started') < logs.indexOf('step 2: GPU session released') && logs.indexOf('step 2') < logs.indexOf('step 3: pipeline-paused marker removed'));
});

test('off does not start a VM that forge mode did not stop, and off when not in forge mode does nothing', async () => {
  const w = world();
  await fm.on({}, w.io);
  w.calls.length = 0;
  await fm.off(w.io);
  assert.deepEqual(w.steps(), ['release']);
  w.calls.length = 0;
  assert.equal(await fm.off(w.io), 0);
  assert.deepEqual(w.steps(), []);
  assert.match(w.logs(), /not in forge mode/);
});

test('off still removes the marker when the GPU release fails, and says so (exit 1)', async () => {
  const w = world();
  await fm.on({}, w.io);
  const orig = w.io.pf;
  w.io.pf = async (m, p, b) => (p === '/api/gpu/release' ? { status: 500 } : orig(m, p, b));
  assert.equal(await fm.off(w.io), 1);
  assert.equal(fs.existsSync(marker(w.home)), false);
  assert.match(w.logs(), /release FAILED \(500\)/);
});

test('expiry: ends by itself after 6 hours or when the GPU session is gone, not before', async () => {
  const w = world();
  await fm.on({}, w.io);
  assert.deepEqual(await fm.expire(w.io), { expired: false, reason: 'still running' });
  await w.io.sleep(359 * 60000);
  assert.equal((await fm.expire(w.io)).expired, false);
  await w.io.sleep(60000);                                                  // 360 minutes: inclusive
  const r = await fm.expire(w.io);
  assert.equal(r.expired, true);
  assert.match(r.reason, /360 min old/);
  assert.equal(fs.existsSync(marker(w.home)), false);
  const w2 = world({ gpuActive: false });
  await fm.on({}, w2.io);
  const r2 = await fm.expire(w2.io);
  assert.deepEqual([r2.expired, r2.reason], [true, 'the GPU session is gone']);
  assert.deepEqual(await fm.expire(w2.io), { expired: false, reason: 'not in forge mode' });
});

test('status: what is paused, who holds the GPU, memory, I/O and the age', async () => {
  const w = world({ availMB: 9000, io: 12.5 });
  let s = await fm.status(w.io);
  assert.deepEqual([s.paused, s.ageMin, s.vm.state, s.memAvailMB, s.ioSome10], [false, null, 'running', 9000, 12.5]);
  await fm.on({}, (() => { const x = world({ availMB: 12000 }); Object.assign(w.io.env, { FORGE_MODE_PROC: x.io.env.FORGE_MODE_PROC }); return w.io; })());
  await w.io.sleep(90 * 60000);
  s = await fm.status(w.io);
  assert.deepEqual([s.paused, s.ageMin, s.expiresInMin, s.gpuSession.active, s.vm.shutDownByForgeMode], [true, 90, 270, true, false]);
  assert.deepEqual(s.top, ['qemu-system-x86 3906 MB', 'llama-server 2930 MB', 'claude 488 MB']);
});

// ---- the real script ----
test('scripts/forge-mode.sh is a thin wrapper over src/forge-mode.js', () => {
  const sh = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'forge-mode.sh'), 'utf8');
  assert.match(sh, /exec node ".*\/\.\.\/src\/forge-mode\.js" "\$@"/);
  assert.ok(fs.statSync(path.join(__dirname, '..', 'scripts', 'forge-mode.sh')).mode & 0o100);
});

test('CLI end to end: on --vm off, status --json, off, against a fake PromptForge, a fake virsh and fake /proc', async () => {
  const home = tmp();
  const bin = tmp();
  const vmFile = path.join(bin, 'vm-state');
  fs.writeFileSync(vmFile, 'running\n');
  fs.writeFileSync(path.join(bin, 'virsh'), `#!/usr/bin/env bash\ncase "$3" in domstate) cat "${vmFile}";; shutdown) echo "shut off" > "${vmFile}"; echo shutdown >> "${bin}/log";; start) echo running > "${vmFile}"; echo start >> "${bin}/log";; esac\n`, { mode: 0o755 });
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => { seen.push(`${req.method} ${req.url} ${b}`); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(req.url === '/api/gpu/status' ? { active: true } : { ok: true })); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, FORGE_MODE_PF_URL: `http://127.0.0.1:${srv.address().port}`, FORGE_MODE_PROC: procDir(7000, 5), OLLAMA_URL: 'http://127.0.0.1:1' };
  const run = (...args) => new Promise((resolve) => {
    const c = spawn('bash', [path.join(__dirname, '..', 'scripts', 'forge-mode.sh'), ...args], { env });
    let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; }); c.on('close', (code) => resolve({ code, out }));
  });
  try {
    const on = await run('on', '--vm', 'off');
    assert.equal(on.code, 0, on.out);
    assert.ok(fs.existsSync(marker(home)));
    assert.equal(fs.readFileSync(vmFile, 'utf8').trim(), 'shut off');
    assert.ok(seen.some((s) => s.startsWith('POST /api/gpu/acquire') && s.includes('"owner":"forge-mode"')));
    const st = await run('status', '--json');
    assert.equal(JSON.parse(st.out).paused, true);
    const off = await run('off');
    assert.equal(off.code, 0, off.out);
    assert.equal(fs.existsSync(marker(home)), false);
    assert.equal(fs.readFileSync(vmFile, 'utf8').trim(), 'running');
    assert.ok(seen.some((s) => s.startsWith('POST /api/gpu/release')));
    assert.deepEqual(fs.readFileSync(path.join(bin, 'log'), 'utf8').trim().split('\n'), ['shutdown', 'start']);
    assert.equal((await run('bogus')).code, 2);
  } finally { srv.close(); }
});
