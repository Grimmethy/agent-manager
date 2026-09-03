'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const arb = require('./gpu-arbiter.js');

const MOD = require.resolve('./gpu-arbiter.js');

function tmpInst() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-arbiter-test-'));
}

// Run a snippet in a fresh node process (arb.acquire blocks synchronously, so in-process
// contention tests need real children -- same shape as single-flight-lock.test.js).
function child(js) {
  return spawn(process.execPath, ['-e', `const arb = require(${JSON.stringify(MOD)}); ${js}`], { stdio: ['ignore', 'pipe', 'pipe'] });
}
function waitExit(cp) {
  return new Promise((res) => {
    let out = ''; let err = '';
    cp.stdout.on('data', (d) => { out += d; });
    cp.stderr.on('data', (d) => { err += d; });
    cp.on('exit', (code, sig) => res({ code, sig, out, err }));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('withGpu: acquire, run, release -- ticket dir empties afterward', async () => {
  const inst = tmpInst();
  let ran = false;
  const r = await arb.withGpu(inst, { cls: 'draft', model: 'm', taskId: 't1' }, async () => {
    ran = true;
    const live = arb.liveTickets(inst, 'm');
    assert.equal(live.length, 1);
    assert.equal(live[0].holding, true);
    return 42;
  });
  assert.equal(ran, true);
  assert.equal(r, 42);
  assert.deepEqual(arb.liveTickets(inst, 'm'), []);
});

test('priority: a draft acquire waits while an interactive ticket is live, proceeds once it releases', async () => {
  const inst = tmpInst();
  // interactive holder in a child, holds for 1.2s
  const holder = child(`
    const h = arb.acquire(${JSON.stringify(inst)}, { cls: 'interactive', model: 'm', taskId: 'chat' });
    setTimeout(() => { h.release(); process.exit(0); }, 1200);
  `);
  await sleep(300); // let it acquire

  const start = Date.now();
  const draft = child(`
    const s = Date.now();
    const h = arb.acquire(${JSON.stringify(inst)}, { cls: 'draft', model: 'm', taskId: 'w1' });
    process.stdout.write(String(Date.now() - s));
    h.release();
  `);
  const [dr] = await Promise.all([waitExit(draft), waitExit(holder)]);
  const waited = Number(dr.out);
  assert.ok(waited >= 700, `draft should have waited for the interactive holder, waited ${waited}ms (child err: ${dr.err})`);
  assert.equal(dr.code, 0);
});

test('cancelBelow: marks a lower-class holder cancelRequested and SIGKILLs it', async () => {
  const inst = tmpInst();
  const draft = child(`
    let cancelled = false;
    const h = arb.acquire(${JSON.stringify(inst)}, { cls: 'draft', model: 'm', taskId: 'w1', onCancel: () => { cancelled = true; } });
    // hold "forever" -- the parent will cancelBelow + kill us
    setInterval(() => {}, 1000);
  `);
  await sleep(600); // acquire + become holder
  let live = arb.liveTickets(inst, 'm');
  assert.equal(live.length, 1);
  assert.equal(live[0].holding, true);

  const affected = arb.cancelBelow(inst, 'm', 'interactive');
  assert.equal(affected.length, 1);
  assert.equal(affected[0].cls, 'draft');
  assert.equal(affected[0].action, 'killed');

  const res = await waitExit(draft);
  assert.ok(res.sig === 'SIGKILL' || res.code !== 0, `child should have been killed (sig=${res.sig} code=${res.code})`);
  // its ticket is swept on the next read (dead pid)
  assert.deepEqual(arb.liveTickets(inst, 'm'), []);
});

test('cancelBelow leaves an equal-or-higher class alone', async () => {
  const inst = tmpInst();
  const review = child(`
    const h = arb.acquire(${JSON.stringify(inst)}, { cls: 'review', model: 'm', taskId: 'rv' });
    setTimeout(() => { h.release(); process.exit(0); }, 800);
  `);
  await sleep(400);
  const affected = arb.cancelBelow(inst, 'm', 'review'); // review is NOT below review
  assert.deepEqual(affected, []);
  const res = await waitExit(review);
  assert.equal(res.code, 0);
});

test('holdPlace: another pid at the same class waits behind the place; the placeholder pid does not', async () => {
  const inst = tmpInst();
  // this process holds an interactive place for the whole test
  const place = arb.holdPlace(inst, { cls: 'interactive', model: 'm', taskId: 'chat-loop' });
  try {
    // a DIFFERENT pid asking for interactive must wait behind the place (older seq)
    const other = child(`
      const s = Date.now();
      const h = arb.acquire(${JSON.stringify(inst)}, { cls: 'interactive', model: 'm', taskId: 'other' });
      process.stdout.write('got:' + (Date.now() - s));
      h.release();
    `);
    await sleep(500);
    // still waiting -- our place blocks it
    assert.equal(other.exitCode, null, 'the other pid should still be blocked behind our place');

    // OUR pid's inner acquire proceeds immediately despite our own older place ticket
    const t0 = Date.now();
    await arb.withGpu(inst, { cls: 'interactive', model: 'm', taskId: 'chat-turn' }, async () => {});
    assert.ok(Date.now() - t0 < 800, 'the placeholder pid must not block on its own place');

    place.release();
    const res = await waitExit(other);
    assert.match(res.out, /^got:/);
  } finally {
    place.release();
  }
});

test('status: reports the holder and the waiting queue', async () => {
  const inst = tmpInst();
  const holder = child(`
    const h = arb.acquire(${JSON.stringify(inst)}, { cls: 'review', model: 'm', taskId: 'rv' });
    setTimeout(() => { h.release(); process.exit(0); }, 1500);
  `);
  await sleep(400);
  const waiter = child(`
    const h = arb.acquire(${JSON.stringify(inst)}, { cls: 'draft', model: 'm', taskId: 'w1' });
    setTimeout(() => { h.release(); process.exit(0); }, 200);
  `);
  await sleep(400);

  const st = arb.status(inst, 'm');
  assert.equal(st.holder && st.holder.cls, 'review');
  assert.equal(st.holder.taskId, 'rv');
  assert.ok(st.waiting.some((w) => w.cls === 'draft' && w.taskId === 'w1'), JSON.stringify(st));

  await Promise.all([waitExit(holder), waitExit(waiter)]);
});

test('liveTickets sweeps a ticket whose pid is dead', async () => {
  const inst = tmpInst();
  const dir = arb.ticketsDir(inst, 'm');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '0000000000000001.999999.dead.json'),
    JSON.stringify({ pid: 999999, cls: 'draft', holding: true }));
  assert.deepEqual(arb.liveTickets(inst, 'm'), []);
  assert.equal(fs.existsSync(path.join(dir, '0000000000000001.999999.dead.json')), false);
});

test('classRank: unknown class falls back to the default (draft)', () => {
  assert.equal(arb.classRank('interactive'), 0);
  assert.equal(arb.classRank('audit'), 3);
  assert.equal(arb.classRank('nonsense'), arb.classRank('draft'));
});
