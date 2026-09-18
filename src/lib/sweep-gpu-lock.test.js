'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// getConfig() requires AGENT_MANAGER_REPO_ROOT at load time -- force it to a throwaway
// dir unconditionally (same convention as apply-task.test.js) so an ambient real repo
// root in the shell env can never leak into these tests.
process.env.AGENT_MANAGER_REPO_ROOT = path.join(os.tmpdir(), 'sweep-gpu-lock-test-repo-root');

test('lockedModelFn: passes args through and returns the wrapped fn result', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-gpu-lock-test-'));
  const prevPipelineDir = process.env.AGENT_MANAGER_PIPELINE_DIR;
  process.env.AGENT_MANAGER_PIPELINE_DIR = dir;
  delete require.cache[require.resolve('../config.js')];
  delete require.cache[require.resolve('./sweep-gpu-lock.js')];
  const { lockedModelFn } = require('./sweep-gpu-lock.js');
  try {
    const calls = [];
    const fn = async (opts) => { calls.push(opts); return { ok: true, opts }; };
    const locked = lockedModelFn(fn, { phase: 'test-sweep' });
    const result = await locked({ prompt: 'hi' });
    assert.deepEqual(calls, [{ prompt: 'hi' }]);
    assert.deepEqual(result, { ok: true, opts: { prompt: 'hi' } });
  } finally {
    if (prevPipelineDir === undefined) delete process.env.AGENT_MANAGER_PIPELINE_DIR;
    else process.env.AGENT_MANAGER_PIPELINE_DIR = prevPipelineDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// single-flight-lock.js's acquire() has a reentrant fast path keyed by this SAME node
// process already holding the lock (see its own header bug (1)) -- concurrent unawaited
// calls from one process legitimately bypass the real flock, matching how a caller that
// already holds the lock is allowed to call back into a locked helper without deadlocking
// itself. That's not the topology this fix protects: in production, the sweep and the
// draft/review workers are always SEPARATE OS processes (queue-watcher.sh spawns each
// sweep fresh). Verify serialization the way gpu-arbiter.test.js itself does -- across
// real child processes racing the same lockKey.
test('lockedModelFn: serializes ACROSS separate processes on the same lockKey', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-gpu-lock-test-'));
  const repoRoot = path.join(os.tmpdir(), 'sweep-gpu-lock-test-repo-root');
  const outFile = path.join(dir, 'order.log');
  fs.writeFileSync(outFile, '');
  const MOD = require.resolve('./sweep-gpu-lock.js');
  const { spawn } = require('child_process');

  const childJs = (label) => `
    process.env.AGENT_MANAGER_PIPELINE_DIR = ${JSON.stringify(dir)};
    process.env.AGENT_MANAGER_REPO_ROOT = ${JSON.stringify(repoRoot)};
    const fs = require('fs');
    const { lockedModelFn } = require(${JSON.stringify(MOD)});
    const locked = lockedModelFn(async () => {
      fs.appendFileSync(${JSON.stringify(outFile)}, 'start-${label}\\n');
      await new Promise((r) => setTimeout(r, 100));
      fs.appendFileSync(${JSON.stringify(outFile)}, 'end-${label}\\n');
    }, { phase: 'test-sweep-${label}' });
    locked().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
  `;
  const spawnChild = (label) => spawn(process.execPath, ['-e', childJs(label)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const waitExit = (cp) => new Promise((res) => cp.on('exit', (code) => res(code)));

  // Wait for c1 to actually be INSIDE its locked section (not just a fixed sleep -- under
  // full-suite load a fixed delay is flaky) before spawning c2, so the ordering assertion
  // below is deterministic regardless of system load.
  const waitForLine = async (needle, deadline) => {
    while (Date.now() < deadline) {
      if (fs.readFileSync(outFile, 'utf8').includes(needle)) return true;
      await new Promise((r) => setTimeout(r, 5));
    }
    return false;
  };
  const c1 = spawnChild('a');
  const sawStart = await waitForLine('start-a', Date.now() + 5000);
  assert.equal(sawStart, true, 'c1 never reached its locked section');
  const c2 = spawnChild('b');
  const [code1, code2] = await Promise.all([waitExit(c1), waitExit(c2)]);
  assert.equal(code1, 0);
  assert.equal(code2, 0);

  const lines = fs.readFileSync(outFile, 'utf8').trim().split('\n');
  // If the two processes had run concurrently, 'start-b' would appear before 'end-a'.
  // Serialized, the winner's start/end must be fully bracketed before the loser starts.
  assert.deepEqual(lines, ['start-a', 'end-a', 'start-b', 'end-b']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('lockedModelFn: non-function input passes through unchanged (guards optional call/majorityVote)', () => {
  const { lockedModelFn } = require('./sweep-gpu-lock.js');
  assert.equal(lockedModelFn(null), null);
  assert.equal(lockedModelFn(undefined), undefined);
});
