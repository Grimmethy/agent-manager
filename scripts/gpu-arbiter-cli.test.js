'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, 'gpu-arbiter-cli.js');

function runCli(args, pipelineDir) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENT_MANAGER_REPO_ROOT: pipelineDir,
      AGENT_MANAGER_PIPELINE_DIR: pipelineDir,
      LOCAL_MODEL: 'test-model',
    },
  });
}

function tmpPipeline() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'arb-cli-'));
  fs.mkdirSync(path.join(d, 'instances'), { recursive: true });
  return d;
}

function writeTicket(pipelineDir, model, name, obj) {
  const dir = path.join(pipelineDir, 'instances', '.gpu-tickets.' + model.replace(/[^A-Za-z0-9._-]+/g, '_'));
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, name);
  fs.writeFileSync(fp, JSON.stringify(obj));
  return fp;
}

test('cancel-below marks a lower-class ticket cancelRequested', () => {
  const pd = tmpPipeline();
  // a live-pid draft ticket (this test process, so pidAlive() is true and it won't be swept)
  const fp = writeTicket(pd, 'test-model', '0000000000000001.' + process.pid + '.a.json',
    { pid: process.pid, cls: 'draft', taskId: 't1', holding: false });

  const r = runCli(['cancel-below', '--cls', 'interactive'], pd);
  assert.equal(r.status, 0, r.stderr);
  const rows = JSON.parse(r.stdout);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cls, 'draft');
  assert.equal(rows[0].action, 'cancel-marked');
  assert.equal(JSON.parse(fs.readFileSync(fp, 'utf8')).cancelRequested, true);
});

test('cancel-below leaves an equal/higher class alone', () => {
  const pd = tmpPipeline();
  writeTicket(pd, 'test-model', '0000000000000001.' + process.pid + '.b.json',
    { pid: process.pid, cls: 'interactive', taskId: 'chat', holding: false });
  const r = runCli(['cancel-below', '--cls', 'interactive'], pd);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), []);
});

test('status reports the holder and waiters', () => {
  const pd = tmpPipeline();
  writeTicket(pd, 'test-model', '0000000000000001.' + process.pid + '.h.json',
    { pid: process.pid, cls: 'review', taskId: 'rv', holding: true });
  writeTicket(pd, 'test-model', '0000000000000002.' + process.pid + '.w.json',
    { pid: process.pid, cls: 'draft', taskId: 'w1', holding: false });
  const r = runCli(['status'], pd);
  assert.equal(r.status, 0, r.stderr);
  const st = JSON.parse(r.stdout);
  assert.equal(st.holder.cls, 'review');
  assert.ok(st.waiting.some((w) => w.cls === 'draft' && w.taskId === 'w1'));
});

test('unknown subcommand exits non-zero with a usage line', () => {
  const pd = tmpPipeline();
  const r = runCli(['frobnicate'], pd);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /usage:/);
});

// --- hold (2026-10-18, brain-dump 1902) ----------------------------------------------------
// A long-lived reservation for non-Node callers: a place ticket held on behalf of --pid.

const { spawn } = require('child_process');

const HOLD_KEY = 'ollama-test-host-11434';

function holdTicketsDir(pd, key = HOLD_KEY) {
  return path.join(pd, 'instances', '.gpu-tickets.' + key.replace(/[^A-Za-z0-9._-]+/g, '_'));
}

function cliEnv(pd, extra = {}) {
  return { ...process.env, AGENT_MANAGER_REPO_ROOT: pd, AGENT_MANAGER_PIPELINE_DIR: pd, LOCAL_MODEL: 'test-model', ...extra };
}

// Spawns `hold`; resolves lines as they arrive and the exit code.
function startHold(args, pd) {
  const cp = spawn(process.execPath, [CLI, 'hold', ...args], { env: cliEnv(pd), stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = [];
  let buf = '';
  let err = '';
  const waiters = [];
  cp.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      lines.push(line);
      for (const w of waiters.splice(0)) w();
    }
  });
  cp.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((res) => cp.on('exit', (code, sig) => res({ code, sig, err })));
  const waitFor = (event, ms = 10000) => new Promise((res, rej) => {
    const deadline = setTimeout(() => rej(new Error(`no '${event}' line within ${ms}ms; got ${JSON.stringify(lines)} stderr=${err}`)), ms);
    const check = () => {
      const hit = lines.find((l) => l.event === event);
      if (hit) { clearTimeout(deadline); res(hit); } else waiters.push(check);
    };
    check();
  });
  return { cp, lines, waitFor, exited };
}

function sleeper() {
  return spawn('sleep', ['60'], { stdio: 'ignore' });
}

function historyLines(pd) {
  const p = path.join(pd, 'instances', 'pipeline-history.log');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('hold: takes a review place ticket for --pid, shows in status reserved, releases owner-exited when that pid exits, logs gpu-hold start/release', async () => {
  const pd = tmpPipeline();
  const owner = sleeper();
  const h = startHold(['--key', HOLD_KEY, '--pid', String(owner.pid), '--task', 'job-1'], pd);
  try {
    const held = await h.waitFor('held');
    assert.equal(held.cls, 'review');
    assert.equal(held.ownerPid, owner.pid);
    assert.equal(held.taskId, 'job-1');
    const files = fs.readdirSync(holdTicketsDir(pd)).filter((n) => n.endsWith('.json'));
    assert.equal(files.length, 1);
    const ticket = JSON.parse(fs.readFileSync(path.join(holdTicketsDir(pd), files[0]), 'utf8'));
    assert.equal(ticket.place, true);
    assert.equal(ticket.cls, 'review');
    assert.equal(ticket.ownerPid, owner.pid);
    assert.equal(ticket.pid, h.cp.pid, 'the hold process itself owns the ticket');

    const st = runCli(['status', '--key', HOLD_KEY], pd);
    assert.equal(st.status, 0, st.stderr);
    const parsed = JSON.parse(st.stdout);
    assert.equal(parsed.holder, null);
    assert.deepEqual(parsed.waiting, []);
    assert.equal(parsed.reserved.length, 1);
    assert.equal(parsed.reserved[0].ownerPid, owner.pid);
    assert.equal(parsed.reserved[0].taskId, 'job-1');

    owner.kill('SIGKILL');
    const released = await h.waitFor('released');
    assert.equal(released.reason, 'owner-exited');
    assert.ok(released.heldMs >= 0);
    const ex = await h.exited;
    assert.equal(ex.code, 0, ex.err);
    assert.deepEqual(fs.readdirSync(holdTicketsDir(pd)).filter((n) => n.endsWith('.json')), [], 'ticket removed on release');

    const events = historyLines(pd).filter((e) => e.type === 'gpu-hold');
    assert.deepEqual(events.map((e) => e.event), ['start', 'release']);
    assert.equal(events[1].reason, 'owner-exited');
    assert.equal(events[1].key, HOLD_KEY);
    assert.equal(events[1].ownerPid, owner.pid);
    assert.equal(events[1].taskId, 'job-1');
    assert.equal(typeof events[1].heldMs, 'number');
  } finally {
    owner.kill('SIGKILL');
    h.cp.kill('SIGKILL');
  }
});

test('hold: SIGTERM to the hold process releases with reason signal:SIGTERM', async () => {
  const pd = tmpPipeline();
  const owner = sleeper();
  const h = startHold(['--key', HOLD_KEY, '--pid', String(owner.pid)], pd);
  try {
    await h.waitFor('held');
    h.cp.kill('SIGTERM');
    const released = await h.waitFor('released');
    assert.equal(released.reason, 'signal:SIGTERM');
    assert.equal((await h.exited).code, 0);
    assert.deepEqual(fs.readdirSync(holdTicketsDir(pd)).filter((n) => n.endsWith('.json')), []);
  } finally {
    owner.kill('SIGKILL');
    h.cp.kill('SIGKILL');
  }
});

test('hold: a higher class cancel-below marks the hold and it releases with reason cancelled', async () => {
  const pd = tmpPipeline();
  const owner = sleeper();
  const h = startHold(['--key', HOLD_KEY, '--pid', String(owner.pid)], pd);
  try {
    await h.waitFor('held');
    const r = runCli(['cancel-below', '--key', HOLD_KEY, '--cls', 'interactive'], pd);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout)[0].action, 'cancel-marked');
    const released = await h.waitFor('released');
    assert.equal(released.reason, 'cancelled');
    assert.equal((await h.exited).code, 0);
  } finally {
    owner.kill('SIGKILL');
    h.cp.kill('SIGKILL');
  }
});

test('hold: refuses an unknown --cls, a dead or missing --pid, and no --key/--local -- non-zero exit, no ticket written', () => {
  const pd = tmpPipeline();
  const cases = [
    ['--key', HOLD_KEY, '--pid', String(process.pid), '--cls', 'bogus'],
    ['--key', HOLD_KEY, '--pid', '999999999'],
    ['--key', HOLD_KEY],
    ['--pid', String(process.pid)],
  ];
  for (const args of cases) {
    const r = spawnSync(process.execPath, [CLI, 'hold', ...args], { encoding: 'utf8', env: cliEnv(pd), timeout: 10000 });
    assert.notEqual(r.status, 0, `${args.join(' ')} should be refused`);
    assert.match(r.stderr, /gpu-arbiter-cli hold:/);
  }
  assert.equal(fs.existsSync(holdTicketsDir(pd)), false, 'no ticket dir for the named key');
  assert.deepEqual(fs.readdirSync(path.join(pd, 'instances')).filter((n) => n.startsWith('.gpu-tickets')), [], 'no ticket dir at all');
});

test('hold: a draft-class acquire on the held key times out while the hold is live and succeeds once it is released', async () => {
  const pd = tmpPipeline();
  const owner = sleeper();
  const h = startHold(['--key', HOLD_KEY, '--pid', String(owner.pid)], pd);
  const arbPath = path.join(__dirname, '..', 'src', 'gpu-arbiter.js');
  const inst = path.join(pd, 'instances');
  const tryDraft = () => spawnSync(process.execPath, ['-e', `
    const arb = require(${JSON.stringify(arbPath)});
    try { const g = arb.acquire(${JSON.stringify(inst)}, { cls: 'draft', model: 'm', lockKey: ${JSON.stringify(HOLD_KEY)}, taskId: 'lane-draft' }); g.release(); process.stdout.write('acquired'); }
    catch (e) { process.stdout.write('error:' + e.message); }
  `], { encoding: 'utf8', env: { ...process.env, SINGLE_FLIGHT_LOCK_TIMEOUT_SECS: '1' }, timeout: 15000 });
  try {
    await h.waitFor('held');
    const blocked = tryDraft();
    assert.match(blocked.stdout, /^error:.*timed out waiting to reach the head of the queue/, blocked.stdout + blocked.stderr);
    owner.kill('SIGKILL');
    await h.waitFor('released');
    await h.exited;
    const free = tryDraft();
    assert.equal(free.stdout, 'acquired', free.stdout + free.stderr);
  } finally {
    owner.kill('SIGKILL');
    h.cp.kill('SIGKILL');
  }
});
