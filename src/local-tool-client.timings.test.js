'use strict';
// HUB0464 3/3: node:test coverage for per-turn timings. Drives runPlanWithTools through
// a fake Ollama seam (same shape as withMockedChat in local-tool-client.test.js). No real model.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const MODULE_IDS = ['./ollama-http.js', './single-flight-lock.js', './local-client.js', './local-tool-client.js'];

function clearModules() {
  for (const relId of MODULE_IDS) delete require.cache[require.resolve(relId)];
}

function withFakeModel(scriptedTurns, fn, { throwOnFirstCall = null, killSwitch = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-tool-client-timings-test-'));
  process.env.AGENT_MANAGER_REPO_ROOT = dir;
  process.env.AGENT_MANAGER_PIPELINE_DIR = dir;
  if (killSwitch) {
    fs.mkdirSync(path.join(dir, 'queue'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'queue', killSwitch), '');
  }
  const queue = scriptedTurns.slice();
  const stub = (relId, exportsObj) => {
    const resolved = require.resolve(relId);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
  };
  clearModules();
  let calls = 0;
  stub('./ollama-http.js', {
    postJson: async () => {
      calls += 1;
      if (throwOnFirstCall && calls === 1) throw new Error(throwOnFirstCall);
      const turn = queue.length ? queue.shift() : {};
      const { _usage, _done_reason, ...message } = turn || {};
      return { message, ...(_usage || {}), ...(_done_reason !== undefined ? { done_reason: _done_reason } : {}) };
    },
    postJsonStream: async () => { throw new Error('streaming path not exercised in this test'); },
  });
  stub('./single-flight-lock.js', { withLock: (_dir, f) => f() });
  stub('./local-client.js', { call: async () => ({ response: 'fallback reply' }), KEEP_ALIVE: '8760h' });
  try {
    const mod = require('./local-tool-client.js');
    return fn(mod, dir);
  } finally {
    clearModules();
  }
}

const toolTurn = (name = 'list_directory', args = { path: '.' }) => ({
  role: 'assistant',
  content: '',
  tool_calls: [{ function: { name, arguments: args } }],
});

const finalTurn = (content = 'here is the answer') => ({ role: 'assistant', content });

test('timings: a 3-turn run with one tool call per turn reports turns 1..3 with numeric timings', async () => {
  await withFakeModel([toolTurn(), toolTurn(), finalTurn()], async (mod) => {
    const result = await mod.runPlanWithTools({ prompt: 'hi', maxTurns: 5, source: 'test' });
    assert.ok(Array.isArray(result.timings), 'result.timings must be an array');
    assert.equal(result.timings.length, 3);
    assert.deepEqual(result.timings.map((t) => t.turn), [1, 2, 3]);
    for (const t of result.timings) {
      assert.ok(Number.isInteger(t.modelCallMs), `modelCallMs must be an integer, got ${t.modelCallMs}`);
      assert.ok(Number.isInteger(t.toolExecMs), `toolExecMs must be an integer, got ${t.toolExecMs}`);
    }
  });
});

test('timings: a forced summary on turn 2 puts forcedSummaryMs only on the turn-2 entry', async () => {
  // maxTurns: 2 with forceSummaryOnCap hits the cap after turn 2 and runs the forced summary turn.
  await withFakeModel([toolTurn(), toolTurn(), finalTurn('RESOLUTION: implemented')], async (mod) => {
    const result = await mod.runPlanWithTools({ prompt: 'hi', maxTurns: 2, forceSummaryOnCap: true, source: 'test' });
    assert.ok(Array.isArray(result.timings), 'result.timings must be an array');
    const turn2 = result.timings.find((t) => t.turn === 2);
    assert.ok(turn2, 'expected a turn-2 entry');
    assert.ok(Number.isInteger(turn2.forcedSummaryMs), 'turn-2 entry must carry forcedSummaryMs');
    for (const t of result.timings) {
      if (t.turn === 2) continue;
      assert.ok(!('forcedSummaryMs' in t), `turn ${t.turn} must not carry forcedSummaryMs`);
    }
  });
});

test('timings: a tools-disabled run has no timings key', async () => {
  await withFakeModel([finalTurn()], async (mod) => {
    const result = await mod.runPlanWithTools({ prompt: 'hi', source: 'test' });
    assert.ok(!('timings' in result), 'tools-disabled result must not have a timings key');
  }, { killSwitch: '.arch-discovery-tools-disabled' });
});

test('timings: a model call that throws on turn 1 is surfaced as a rejection (no partial result to carry a turn-1 entry)', async () => {
  // OPEN QUESTION for the implementer: when the first model call throws, chatTurnWithFlakeRecovery
  // returns flakeErr and runPlanWithTools rethrows it, so no result is returned and the turn-1
  // timing entry is never exposed. This test pins the current rejection behaviour and does not
  // assert a turn-1 timing entry. Attach timings to thrown errors or a partial result to change it.
  await withFakeModel([], async (mod) => {
    await assert.rejects(
      () => mod.runPlanWithTools({ prompt: 'hi', source: 'test' }),
      /boom: model unreachable/,
    );
  }, { throwOnFirstCall: 'boom: model unreachable' });
});

test('timings: existing result shape is preserved on a standard run', async () => {
  await withFakeModel([finalTurn('here is the answer')], async (mod) => {
    const result = await mod.runPlanWithTools({ prompt: 'hi', source: 'test' });
    assert.equal(typeof result, 'object');
    assert.equal(typeof result.response, 'string');
    assert.match(result.response, /here is the answer/);
    assert.equal(result.commandProposals, undefined);
  });
});
