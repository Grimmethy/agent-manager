'use strict';

// Run: node --test src/cloud-dial.test.js
// Every test uses a private temp state file through AGENT_MANAGER_CLOUD_DIAL_PATH; nothing touches the real dial.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const dial = require('./cloud-dial.js');

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-dial-'));
  const file = path.join(dir, 'state', 'cloud-dial.json');
  const env = { ...process.env, AGENT_MANAGER_CLOUD_DIAL_PATH: file };
  return { dir, file, env };
}

const LANES = ['worker-cloud', 'worker-cloud2', 'worker-cloud3', 'worker-cloud10'];

test('lane order is natural: cloud first, then by number, cloud10 after cloud3', () => {
  const shuffled = ['worker-cloud10', 'worker-cloud3', 'worker-cloud', 'worker-cloud2'];
  assert.deepEqual(LANES.map((l) => dial.laneRank(l, shuffled)), [0, 1, 2, 3]);
  assert.equal(dial.laneRank('cloud', ['cloud2', 'cloud']), 0, 'ids without the worker- prefix rank the same way');
  const nine = ['cloud', ...Array.from({ length: 11 }, (_, i) => `cloud${i + 2}`)];
  assert.equal(dial.laneRank('cloud10', [...nine].reverse()), 9);
  assert.equal(dial.laneRank('cloud9', [...nine].reverse()), 8);
});

test('laneRank is -1 for a lane that is not in the list and ignores non-cloud ids', () => {
  assert.equal(dial.laneRank('worker-cloud5', LANES), -1);
  assert.equal(dial.laneRank('worker-3090', ['worker-3090', 'worker-cloud']), -1);
  assert.equal(dial.laneRank('worker-cloud', ['worker-3090', 'worker-cloud']), 0);
  assert.equal(dial.laneRank('worker-cloud', undefined), -1);
});

test('unset dial turns nothing off, and set/unset round-trip through the file', () => {
  const { env, file } = sandbox();
  assert.deepEqual(dial.read(env), { count: null, mode: 'manual', setAt: null, setBy: null });
  for (const l of LANES) assert.equal(dial.isLaneOff(l, env, LANES), false);
  const s = dial.setCount(3, 'tester', env, Date.parse('2026-11-16T00:00:00Z'));
  assert.equal(s.count, 3);
  assert.equal(s.setBy, 'tester');
  assert.equal(s.setAt, '2026-11-16T00:00:00.000Z');
  assert.equal(dial.read(env).count, 3);
  assert.equal(dial.unset('tester', env).count, null);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).count, null);
  for (const l of LANES) assert.equal(dial.isLaneOff(l, env, LANES), false);
});

test('rank edges: count 0 turns every lane off, count N keeps the first N, a count above the lane count turns none off', () => {
  const { env } = sandbox();
  dial.setCount(0, 't', env);
  assert.deepEqual(LANES.map((l) => dial.isLaneOff(l, env, LANES)), [true, true, true, true]);
  dial.setCount(2, 't', env);
  assert.deepEqual(LANES.map((l) => dial.isLaneOff(l, env, LANES)), [false, false, true, true]);
  dial.setCount(4, 't', env);
  assert.deepEqual(LANES.map((l) => dial.isLaneOff(l, env, LANES)), [false, false, false, false]);
  dial.setCount(500, 't', env);
  assert.deepEqual(LANES.map((l) => dial.isLaneOff(l, env, LANES)), [false, false, false, false], 'no upper bound on the count');
});

test('a lane that is not a known cloud lane is never off', () => {
  const { env } = sandbox();
  dial.setCount(0, 't', env);
  assert.equal(dial.isLaneOff('worker-3090', env, LANES), false);
  assert.equal(dial.isLaneOff('worker-cloud99', env, LANES), false);
  assert.equal(dial.isLaneOff(undefined, env, LANES), false);
});

test('fail open: missing, unreadable, malformed and wrong-typed state all mean not off', () => {
  const { env, file, dir } = sandbox();
  assert.equal(dial.isLaneOff('worker-cloud3', env, LANES), false, 'no file');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const body of ['', '{not json', '[]', 'null', '42', '{"count":"2"}', '{"count":-1}', '{"count":1.5}', '{"count":true}', '{"count":null}']) {
    fs.writeFileSync(file, body);
    assert.equal(dial.read(env).count, null, `count must read as unset for ${JSON.stringify(body)}`);
    for (const l of LANES) assert.equal(dial.isLaneOff(l, env, LANES), false, `lane off for ${JSON.stringify(body)}`);
  }
  fs.rmSync(file);
  fs.mkdirSync(file); // a directory where the file should be: unreadable
  assert.equal(dial.isLaneOff('worker-cloud3', env, LANES), false, 'unreadable path');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('setCount rejects negative, fractional, non-numeric and boolean values and writes nothing', () => {
  const { env, file } = sandbox();
  for (const bad of [-1, 1.5, NaN, Infinity, 'abc', '', '-2', '1.5', true, false, null, undefined, {}, []]) {
    assert.throws(() => dial.setCount(bad, 't', env), /invalid dial count/, `should reject ${JSON.stringify(bad)}`);
  }
  assert.equal(fs.existsSync(file), false);
  assert.equal(dial.setCount('7', 't', env).count, 7, 'a plain integer string from the CLI is accepted');
});

test('mode: manual or auto only, kept when the count changes', () => {
  const { env } = sandbox();
  assert.equal(dial.setMode('auto', 't', env).mode, 'auto');
  assert.equal(dial.setCount(2, 't', env).mode, 'auto');
  assert.equal(dial.unset('t', env).mode, 'auto');
  assert.throws(() => dial.setMode('turbo', 't', env), /invalid dial mode/);
  assert.equal(dial.read(env).mode, 'auto');
});

test('no temp file is left in the state directory after writes', () => {
  const { env, file } = sandbox();
  dial.setCount(1, 't', env);
  dial.setMode('auto', 't', env);
  dial.unset('t', env);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['cloud-dial.json']);
});

test('CLI: get, set, unset, mode and is-off exit codes', () => {
  const { env, dir } = sandbox();
  const lanes = path.join(dir, 'lanes.json'); // each lane needs its own endpoint: the registry refuses two lanes on one
  fs.writeFileSync(lanes, JSON.stringify([
    { gpu: 'cloud', ollamaUrl: 'http://127.0.0.1:9', model: 'haiku', provider: 'cloud', preempt: 'never' },
    { gpu: 'cloud2', ollamaUrl: 'http://127.0.0.1:8', model: 'haiku', provider: 'cloud', preempt: 'never' },
    { gpu: 'cloud3', ollamaUrl: 'http://127.0.0.1:7', model: 'haiku', provider: 'cloud', preempt: 'never', enabled: false },
  ]));
  const e = { ...env, AGENT_MANAGER_LANES_PATH: lanes, AGENT_MANAGER_LOCAL_GPU: 'testgpu' };
  const run = (...args) => spawnSync('node', [path.join(__dirname, 'cloud-dial.js'), ...args], { encoding: 'utf8', env: e });
  assert.equal(JSON.parse(run('get').stdout).count, null);
  assert.equal(run('is-off', 'worker-cloud2').status, 1, 'unset: not off');
  assert.equal(JSON.parse(run('set', '1').stdout).count, 1);
  const off = run('is-off', 'worker-cloud2');
  assert.equal(off.status, 0);
  assert.equal(off.stdout, '', 'is-off prints nothing');
  assert.equal(run('is-off', 'worker-cloud').status, 1);
  assert.equal(run('is-off', 'worker-cloud3').status, 1, 'a disabled lane is not in the cloud lane list');
  assert.equal(run('set', '-1').status, 1);
  assert.equal(JSON.parse(run('get').stdout).count, 1, 'a rejected set leaves the count alone');
  assert.equal(JSON.parse(run('mode', 'auto').stdout).mode, 'auto');
  assert.equal(run('mode', 'nope').status, 1);
  assert.equal(JSON.parse(run('unset').stdout).count, null);
  assert.equal(run('bogus').status, 2);
});

test('status: the state plus every cloud lane in lane order with rank and off, agreeing with isLaneOff', () => {
  const { env } = sandbox();
  const shuffled = ['worker-cloud10', 'worker-cloud3', 'worker-cloud', 'worker-cloud2', 'worker-3090'];
  let s = dial.status(env, shuffled);
  assert.deepEqual(s.lanes.map((l) => l.id), ['worker-cloud', 'worker-cloud2', 'worker-cloud3', 'worker-cloud10'], 'natural order, non-cloud ids left out');
  assert.deepEqual(s.lanes.map((l) => l.rank), [0, 1, 2, 3]);
  assert.deepEqual(s.lanes.map((l) => l.off), [false, false, false, false], 'unset: nothing off');
  assert.equal(s.count, null);
  dial.setCount(2, 'tester', env);
  s = dial.status(env, shuffled);
  assert.equal(s.count, 2);
  assert.equal(s.setBy, 'tester');
  assert.deepEqual(s.lanes.map((l) => l.off), [false, false, true, true]);
  for (const l of s.lanes) assert.equal(l.off, dial.isLaneOff(l.id, env, shuffled), `${l.id}: status and isLaneOff must agree`);
  dial.setCount(0, 't', env);
  assert.deepEqual(dial.status(env, shuffled).lanes.map((l) => l.off), [true, true, true, true]);
  dial.setCount(99, 't', env);
  assert.deepEqual(dial.status(env, shuffled).lanes.map((l) => l.off), [false, false, false, false]);
  assert.deepEqual(dial.status(env, []).lanes, []);
  assert.deepEqual(dial.status(env, ['worker-cloud', 'worker-cloud']).lanes.map((l) => l.id), ['worker-cloud'], 'duplicates collapse');
});

test('status on a broken state file reads as unset with no lane off', () => {
  const { env, file } = sandbox();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{not json');
  const s = dial.status(env, ['worker-cloud', 'worker-cloud2']);
  assert.equal(s.count, null);
  assert.deepEqual(s.lanes.map((l) => l.off), [false, false]);
});

test('CLI status prints the JSON for the enabled cloud lanes of the registry', () => {
  const { env, dir } = sandbox();
  const lanes = path.join(dir, 'lanes.json');
  fs.writeFileSync(lanes, JSON.stringify([
    { gpu: 'cloud2', ollamaUrl: 'http://127.0.0.1:8', model: 'haiku', provider: 'cloud', preempt: 'never' },
    { gpu: 'cloud', ollamaUrl: 'http://127.0.0.1:9', model: 'haiku', provider: 'cloud', preempt: 'never' },
    { gpu: 'cloud3', ollamaUrl: 'http://127.0.0.1:7', model: 'haiku', provider: 'cloud', preempt: 'never', enabled: false },
  ]));
  const e = { ...env, AGENT_MANAGER_LANES_PATH: lanes, AGENT_MANAGER_LOCAL_GPU: 'testgpu' };
  const run = (...args) => spawnSync('node', [path.join(__dirname, 'cloud-dial.js'), ...args], { encoding: 'utf8', env: e });
  run('set', '1');
  const out = JSON.parse(run('status').stdout);
  assert.equal(out.count, 1);
  assert.deepEqual(out.lanes, [{ id: 'worker-cloud', rank: 0, off: false }, { id: 'worker-cloud2', rank: 1, off: true }]);
});
