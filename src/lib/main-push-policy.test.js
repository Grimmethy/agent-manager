'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assertMainPushReady, ungatedMainPushAllowed } = require('./main-push-policy.js');

const SHA = 'a'.repeat(40);
const NOW = new Date('2026-11-10T12:00:00Z');

function pipeline(store) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-push-'));
  fs.mkdirSync(path.join(dir, 'queue'), { recursive: true });
  if (store !== undefined) fs.writeFileSync(path.join(dir, 'queue', 'branch-verdicts.json'), JSON.stringify(store));
  return dir;
}
const rec = (over = {}) => ({ verdict: 'merge', reasons: ['ok'], source: 'chat', verifiedAt: '2026-11-10T11:00:00Z', ...over });
const ledger = (dir) => {
  const f = path.join(dir, 'queue', 'main-push-ledger.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};
function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  try { return fn(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}
const call = (dir, branch = 'agent/x', sha = SHA, extra = {}) => assertMainPushReady(branch, sha, { pipelineDir: dir, now: NOW, caller: 't', ...extra });

test('a chat merge verdict for the exact head sha is allowed and writes no ledger row', () => {
  const dir = pipeline({ 'agent/x': { [SHA]: rec() } });
  withEnv({ AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH: undefined }, () => assert.deepEqual(call(dir), { allowed: true, bypass: false }));
  assert.deepEqual(ledger(dir), []);
});

test('a manual merge verdict is allowed too', () => {
  const dir = pipeline({ 'agent/x': { [SHA]: rec({ source: 'manual' }) } });
  withEnv({ AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH: undefined }, () => assert.equal(call(dir).allowed, true));
});

test('a verdict for another sha does not vouch for this one, and the refusal is ledgered', () => {
  const dir = pipeline({ 'agent/x': { ['b'.repeat(40)]: rec() } });
  withEnv({ AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH: undefined }, () => {
    assert.throws(() => call(dir, 'agent/x', SHA, { taskId: 'T1' }), (e) => e.code === 'MAIN_PUSH_NOT_READY' && /no verdict recorded/.test(e.message));
  });
  const rows = ledger(dir);
  assert.equal(rows.length, 1);
  assert.deepEqual({ outcome: rows[0].outcome, branch: rows[0].branch, headSha: rows[0].headSha, caller: rows[0].caller, taskId: rows[0].taskId }, { outcome: 'refused', branch: 'agent/x', headSha: SHA, caller: 't', taskId: 'T1' });
  assert.equal(rows[0].at, NOW.toISOString());
});

test('needs-work, hold and discard verdicts are refused', () => {
  for (const verdict of ['needs-work', 'hold', 'discard']) {
    const dir = pipeline({ 'agent/x': { [SHA]: rec({ verdict }) } });
    withEnv({ AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH: undefined }, () => assert.throws(() => call(dir), /not 'merge'/));
  }
});

test('a merge verdict from the deterministic check or the worker is not a READY record', () => {
  for (const source of ['deterministic', 'worker']) {
    const dir = pipeline({ 'agent/x': { [SHA]: rec({ source }) } });
    withEnv({ AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH: undefined }, () => assert.throws(() => call(dir), /not a human source/));
  }
});

test('a missing or unparseable verifiedAt is refused', () => {
  for (const verifiedAt of [undefined, 'yesterday-ish']) {
    const dir = pipeline({ 'agent/x': { [SHA]: rec({ verifiedAt }) } });
    withEnv({ AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH: undefined }, () => assert.throws(() => call(dir), /valid verifiedAt/));
  }
});

test('the optional max age refuses an old record and is off when unset', () => {
  const dir = pipeline({ 'agent/x': { [SHA]: rec({ verifiedAt: '2026-11-08T00:00:00Z' }) } });
  withEnv({ AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH: undefined, AGENT_MANAGER_MAIN_PUSH_READY_MAX_AGE_HOURS: '24' }, () => assert.throws(() => call(dir), /older than 24 hour/));
  withEnv({ AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH: undefined, AGENT_MANAGER_MAIN_PUSH_READY_MAX_AGE_HOURS: undefined }, () => assert.equal(call(dir).allowed, true));
});

test('a missing store, and empty branch or sha, are refused', () => {
  withEnv({ AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH: undefined }, () => {
    assert.throws(() => call(pipeline()), /no verdict recorded/);
    assert.throws(() => call(pipeline({ 'agent/x': { [SHA]: rec() } }), '', SHA), /both required/);
    assert.throws(() => call(pipeline({ 'agent/x': { [SHA]: rec() } }), 'agent/x', ''), /both required/);
  });
});

test('the env bypass allows without a record, warns, and writes no ledger row', () => {
  const dir = pipeline();
  const warnings = [];
  const orig = console.warn; console.warn = (m) => warnings.push(String(m));
  try {
    withEnv({ AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH: 'true' }, () => {
      assert.equal(ungatedMainPushAllowed(), true);
      assert.deepEqual(call(dir), { allowed: true, bypass: true });
    });
  } finally { console.warn = orig; }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH=true/);
  assert.deepEqual(ledger(dir), []);
});

test('any other value of the env var is not a bypass', () => {
  const dir = pipeline();
  withEnv({ AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH: '1' }, () => assert.throws(() => call(dir), (e) => e.code === 'MAIN_PUSH_NOT_READY'));
});

test('assertMainWriteAllowed reads the head through the runner, asks the gate with the caller, and refuses an unreadable head', () => {
  const dir = pipeline({ main: { [SHA]: rec() } });
  const calls = [];
  withEnv({ AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH: undefined }, () => {
    const { assertMainWriteAllowed } = require('./main-push-policy.js');
    assert.deepEqual(assertMainWriteAllowed((args) => { calls.push(args); return `${SHA}\n`; }, 'main', 'caller-x', { pipelineDir: dir, now: NOW }), { allowed: true, bypass: false });
    assert.deepEqual(calls, [['rev-parse', 'main']]);
    assert.throws(() => assertMainWriteAllowed(() => { throw new Error('no such ref'); }, 'main', 'caller-y', { pipelineDir: dir, now: NOW }), /both required/);
  });
  assert.equal(ledger(dir).length, 1);
  assert.equal(ledger(dir)[0].caller, 'caller-y');
});

test('without a configured pipeline directory the gate refuses and writes no ledger row instead of throwing a config error', () => {
  withEnv({ AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH: undefined, AGENT_MANAGER_REPO_ROOT: undefined, AGENT_MANAGER_PIPELINE_DIR: undefined }, () => {
    assert.throws(() => assertMainPushReady('main', SHA, { now: NOW }), (e) => e.code === 'MAIN_PUSH_NOT_READY');
  });
});
