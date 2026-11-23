'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { on, markerPath } = require('../src/forge-mode.js');

function makeIo({ availKB = 20000000, acquireStatus = 200, marker = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mode-'));
  const proc = path.join(home, 'proc');
  fs.mkdirSync(path.join(proc, 'pressure'), { recursive: true });
  fs.writeFileSync(path.join(proc, 'meminfo'), `MemAvailable: ${availKB} kB\n`);
  fs.writeFileSync(path.join(proc, 'pressure', 'io'), 'some avg10=1.00 avg60=0.00 avg300=0.00 total=0\n');
  const env = { HOME: home, FORGE_MODE_PROC: proc };
  if (marker) {
    fs.mkdirSync(path.dirname(markerPath(env)), { recursive: true });
    fs.writeFileSync(markerPath(env), JSON.stringify(marker));
  }
  const calls = [];
  const lines = [];
  return {
    env, calls, lines,
    now: () => Date.now(),
    sleep: async () => {},
    log: (l) => lines.push(l),
    exec: () => ({ status: 0, stdout: '', stderr: '' }),
    modelsMB: async () => 0,
    pf: async (method, p) => {
      calls.push(`${method} ${p}`);
      if (p === '/api/gpu/acquire') return { status: acquireStatus, json: {} };
      return { status: 200, json: { active: false } };
    },
    markerExists: () => fs.existsSync(markerPath(env)),
  };
}

test('a refused GPU acquire rolls back and leaves no marker', async () => {
  const io = makeIo({ acquireStatus: 500 });
  assert.strictEqual(await on({ vm: 'keep' }, io), 1);
  assert.strictEqual(io.markerExists(), false);
  assert.ok(io.calls.includes('POST /api/gpu/acquire'));
});

test('a refused preflight leaves no marker and takes no GPU session', async () => {
  const io = makeIo({ availKB: 1000000 });
  assert.strictEqual(await on({ vm: 'keep' }, io), 1);
  assert.strictEqual(io.markerExists(), false);
  assert.ok(!io.calls.some((c) => c.includes('acquire')));
});

test('an exception after the marker is written rolls it back', async () => {
  const io = makeIo();
  io.pf = async (method, p) => {
    if (p === '/api/gpu/acquire') throw new Error('boom');
    return { status: 200, json: {} };
  };
  assert.strictEqual(await on({ vm: 'keep' }, io), 1);
  assert.strictEqual(io.markerExists(), false);
});

test('a stale marker from a killed on() run is cleared and on() proceeds', async () => {
  const deadPid = 2147483640;
  const io = makeIo({ marker: { since: new Date().toISOString(), vm: 'keep', vmShutDown: false, gpu: false, settling: true, ownerPid: deadPid } });
  assert.strictEqual(await on({ vm: 'keep' }, io), 0);
  const st = JSON.parse(fs.readFileSync(markerPath(io.env), 'utf8'));
  assert.strictEqual(st.settling, false);
  assert.strictEqual(st.ownerPid, process.pid);
});

test('a marker whose owner is still alive makes on() refuse', async () => {
  const io = makeIo({ marker: { since: new Date().toISOString(), vm: 'keep', vmShutDown: false, gpu: false, settling: true, ownerPid: process.pid } });
  assert.strictEqual(await on({ vm: 'keep' }, io), 0);
  assert.ok(io.lines.some((l) => l.includes('already in forge mode')));
  assert.ok(!io.calls.some((c) => c.includes('acquire')));
});
