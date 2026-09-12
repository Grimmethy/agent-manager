'use strict';

// Unit tests for local-client.js's detectDegenerate() -- pure and easy to test in
// isolation, unlike call()/callOnce() which need real (or heavily mocked) HTTP/GPU-
// capacity/throughput plumbing. No test file existed for this module before; scoped to
// just this function rather than building out a full harness for the rest.
//
// Run: node --test src/local-client.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { detectDegenerate } = require('./local-client.js');

test('detectDegenerate flags a genuinely empty response as "empty"', () => {
  assert.equal(detectDegenerate(''), 'empty');
  assert.equal(detectDegenerate('   '), 'empty');
  assert.equal(detectDegenerate(null), 'empty');
});

test('detectDegenerate respects allowEmpty for a genuinely empty response', () => {
  assert.equal(detectDegenerate('', { allowEmpty: true }), null);
});

// Re-applied fresh 2026-08-21 (originally drafted on the now-9-days-stale
// review-pipeline-hardening branch, which had diverged too far from current
// local-client.js to merge cleanly -- see this session's branch-conflict investigation).
test('detectDegenerate flags the literal two-character JSON-style empty-string quirk ("" or \'\') the same as genuine emptiness', () => {
  assert.equal(detectDegenerate('""'), 'empty');
  assert.equal(detectDegenerate("''"), 'empty');
  // Whitespace-padded is still the same quirk.
  assert.equal(detectDegenerate('  ""  '), 'empty');
});

test('detectDegenerate respects allowEmpty for the two-character quirk too, not just genuine emptiness', () => {
  assert.equal(detectDegenerate('""', { allowEmpty: true }), null);
  assert.equal(detectDegenerate("''", { allowEmpty: true }), null);
});

test('detectDegenerate does not false-positive on real short JSON containing quotes', () => {
  // A real, non-degenerate two-character-adjacent string should not be caught -- only the
  // EXACT literal '""'/"''" (nothing else) counts as the quirk.
  assert.equal(detectDegenerate('{"a":1}'), null);
});

test('detectDegenerate still flags repeated-character garbage', () => {
  assert.equal(detectDegenerate('0'.repeat(30)), 'repeated-character');
});

test('detectDegenerate still flags a repetition loop', () => {
  const chunk = 'the quick brown fox jumps over';
  const text = Array(4).fill(chunk).join(' more filler text here to pad it out ');
  assert.equal(detectDegenerate(text), 'repetition-loop');
});

test('detectDegenerate still flags non-ascii gibberish', () => {
  assert.equal(detectDegenerate('こんにちは世界これは日本語のテキストです'), 'non-ascii-gibberish');
});

test('detectDegenerate returns null for genuinely fine text', () => {
  assert.equal(detectDegenerate('This is a normal, real response with real content in it.'), null);
});

// --- done_reason:"length" (2026-09-05) -------------------------------------------------
// Root-caused a real blocked-task cluster: a plan pass came back real-looking text that
// just stopped mid-sentence because Ollama hit num_predict before a natural stop -- none
// of the existing text-shape heuristics above ever catch that (it isn't empty, garbage,
// repetitive, or non-ascii), so it needs its own, authoritative signal.

test('detectDegenerate flags a done_reason:"length" response as "truncated", even though the text itself looks fine', () => {
  assert.equal(detectDegenerate('**Scope:** `src/x.js` only. No other', { doneReason: 'length' }), 'truncated');
});

test('detectDegenerate treats done_reason:"length" as truncated even when allowEmpty is set (never a trustworthy intentional empty)', () => {
  assert.equal(detectDegenerate('', { allowEmpty: true, doneReason: 'length' }), 'truncated');
});

test('detectDegenerate does not flag a genuinely complete response (done_reason:"stop" or omitted)', () => {
  assert.equal(detectDegenerate('a real, complete response.', { doneReason: 'stop' }), null);
  assert.equal(detectDegenerate('a real, complete response.'), null);
});

// --- logDegenerateAudit (2026-09-06) ----------------------------------------------------
// Same pattern as local-tool-client.test.js's logContextAudit tests: a fixture repo sets
// AGENT_MANAGER_REPO_ROOT/AGENT_MANAGER_PIPELINE_DIR and requires the module fresh, since
// resolvePipelineDir() reads those env vars at call time.

function withFixtureRepo(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-client-test-'));
  process.env.AGENT_MANAGER_REPO_ROOT = dir;
  process.env.AGENT_MANAGER_PIPELINE_DIR = dir;
  delete require.cache[require.resolve('./local-client.js')];
  const mod = require('./local-client.js');
  return fn(mod, dir);
}

// 2026-09-08: both audit functions now write into pipeline-history.js's unified
// instances/pipeline-history.log, discriminated by `type` -- see that module's own
// header for why the 4 separately-invented per-class log files were consolidated.
function readAuditLog(dir, type) {
  const p = path.join(dir, 'instances', 'pipeline-history.log');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === type);
}

test('logDegenerateAudit appends one well-formed NDJSON line per call, tagged type:degenerate, never throwing on a real pipelineDir', () => {
  withFixtureRepo((mod, dir) => {
    mod.logDegenerateAudit({ source: 'pipeline_debrief', taskId: 't1', stage: 'plan', attempt: 1, degenerate: 'truncated' });
    mod.logDegenerateAudit({ source: 'pipeline_debrief', taskId: 't1', stage: 'plan', attempt: 2, degenerate: 'truncated' });
    const lines = readAuditLog(dir, 'degenerate');
    assert.equal(lines.length, 2);
    assert.equal(lines[0].source, 'pipeline_debrief');
    assert.equal(lines[0].attempt, 1);
    assert.ok(lines[0].at, 'each entry carries its own real timestamp');
    assert.equal(lines[1].attempt, 2);
  });
});

test('logDegenerateAudit is advisory: a broken pipelineDir never throws or breaks the caller', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-client-test-broken-'));
  process.env.AGENT_MANAGER_REPO_ROOT = path.join(dir, 'does-not-exist-and-is-a-file');
  fs.writeFileSync(process.env.AGENT_MANAGER_REPO_ROOT, 'x'); // a FILE where a dir is expected -- mkdirSync must fail
  process.env.AGENT_MANAGER_PIPELINE_DIR = process.env.AGENT_MANAGER_REPO_ROOT;
  delete require.cache[require.resolve('./local-client.js')];
  const mod = require('./local-client.js');
  assert.doesNotThrow(() => mod.logDegenerateAudit({ source: 'x' }));
});

// --- logHardFailureAudit (2026-09-08, Second Brain [[dspy]] research applied) -----------
// Same shape/discipline as logDegenerateAudit above, for the OTHER half of a call's
// possible outcomes: never getting a response at all. This session diagnosed 3 completely
// different root causes that all surfaced as the identical generic "Ollama request timed
// out" symptom, each needing a fresh multi-hour live investigation -- one NDJSON line per
// hard-failed attempt, tagged with ollama-http.js's own error `code`, closes that gap.

test('logHardFailureAudit appends one well-formed NDJSON line per call, tagged type:hard-failure, never throwing on a real pipelineDir', () => {
  withFixtureRepo((mod, dir) => {
    mod.logHardFailureAudit({ source: 'pipeline_debrief', taskId: 't1', stage: 'plan', attempt: 1, code: 'OLLAMA_TIMEOUT', timeoutMs: 150000 });
    mod.logHardFailureAudit({ source: 'pipeline_debrief', taskId: 't1', stage: 'plan', attempt: 2, code: 'OLLAMA_TIMEOUT', timeoutMs: 150000 });
    const lines = readAuditLog(dir, 'hard-failure');
    assert.equal(lines.length, 2);
    assert.equal(lines[0].code, 'OLLAMA_TIMEOUT');
    assert.equal(lines[0].timeoutMs, 150000);
    assert.ok(lines[0].at, 'each entry carries its own real timestamp');
    assert.equal(lines[1].attempt, 2);
  });
});

// --- computeLoadContext / systemLoadContext (2026-09-12, "The log needs to reflect the
// CPU contention as the reason for the error"): a hard failure's message (ECONNREFUSED,
// socket hang up, ...) only ever said WHAT happened at the socket, never WHY -- this
// session repeatedly had to manually correlate a burst of these against `uptime`'s load
// average by hand to notice the P40 VM and the local GPU lane were both saturating the
// host's cores at the same moment. Pure threshold math, tested with controlled inputs
// rather than the real live machine's own (unpredictable, test-environment-dependent)
// load average. ---

test('computeLoadContext reports the real numbers on every call, even below the contention threshold', () => {
  const { computeLoadContext } = require('./local-client.js');
  const ctx = computeLoadContext(1.0, 4);
  assert.equal(ctx.loadAvg1m, 1.0);
  assert.equal(ctx.cpuCount, 4);
  assert.equal(ctx.loadRatio, 0.25);
  assert.equal('likelySystemCause' in ctx, false, 'well below the threshold -- must not claim contention');
});

test('computeLoadContext sets likelySystemCause once loadRatio crosses the threshold -- calibrated against this session\'s own real confirmed incidents', () => {
  const { computeLoadContext, CPU_CONTENTION_LOAD_RATIO_THRESHOLD } = require('./local-client.js');
  // Real observed values during confirmed live P40 connection failures on a 4-core host.
  const ctx = computeLoadContext(7.7, 4);
  assert.equal(ctx.loadRatio, 1.93);
  assert.ok(ctx.loadRatio >= CPU_CONTENTION_LOAD_RATIO_THRESHOLD);
  assert.match(ctx.likelySystemCause, /host CPU contention/);
  assert.match(ctx.likelySystemCause, /7\.7/);
  assert.match(ctx.likelySystemCause, /4 cores/);
});

test('computeLoadContext is a hard boundary at the threshold, not a loose one', () => {
  const { computeLoadContext, CPU_CONTENTION_LOAD_RATIO_THRESHOLD } = require('./local-client.js');
  const justBelow = computeLoadContext(CPU_CONTENTION_LOAD_RATIO_THRESHOLD * 4 - 0.1, 4);
  const justAt = computeLoadContext(CPU_CONTENTION_LOAD_RATIO_THRESHOLD * 4, 4);
  assert.equal('likelySystemCause' in justBelow, false);
  assert.equal('likelySystemCause' in justAt, true);
});

test('computeLoadContext never throws on invalid input and reports nothing rather than a garbage value', () => {
  const { computeLoadContext } = require('./local-client.js');
  assert.deepEqual(computeLoadContext(NaN, 4), {});
  assert.deepEqual(computeLoadContext(1.0, 0), {});
  assert.deepEqual(computeLoadContext(undefined, undefined), {});
});

test('logHardFailureAudit includes real system load fields on every entry, using the actual live host', () => {
  withFixtureRepo((mod, dir) => {
    mod.logHardFailureAudit({ source: 'pipeline_debrief', taskId: 't2', stage: 'plan', attempt: 1, code: 'OLLAMA_CONNECTION_ERROR' });
    const lines = readAuditLog(dir, 'hard-failure');
    assert.equal(lines.length, 1);
    assert.equal(typeof lines[0].loadAvg1m, 'number');
    assert.equal(typeof lines[0].cpuCount, 'number');
    assert.equal(typeof lines[0].loadRatio, 'number');
    // likelySystemCause is intentionally NOT asserted here either way -- it depends on
    // the real load of whatever machine runs this test, which this test must not assume.
  });
});

test('logHardFailureAudit is advisory: a broken pipelineDir never throws or breaks the caller', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-client-test-broken-hf-'));
  process.env.AGENT_MANAGER_REPO_ROOT = path.join(dir, 'does-not-exist-and-is-a-file');
  fs.writeFileSync(process.env.AGENT_MANAGER_REPO_ROOT, 'x');
  process.env.AGENT_MANAGER_PIPELINE_DIR = process.env.AGENT_MANAGER_REPO_ROOT;
  delete require.cache[require.resolve('./local-client.js')];
  const mod = require('./local-client.js');
  assert.doesNotThrow(() => mod.logHardFailureAudit({ source: 'x' }));
});

// --- IS_P40_ENDPOINT / resolveRequestTimeoutMs (2026-09-11) -----------------------------
// Root-caused live: "p40 is entirely blocked by ollama timeouts" -- 100% of real
// worker-p40/worker-reasoning-p40 draft calls hit OLLAMA_TIMEOUT at exactly the standard
// 240s ceiling once a plan pass needed the 2800-token budget, because at the P40's real
// ~9.3 tok/s that generation alone needs ~301s. OLLAMA_URL/AGENT_MANAGER_P40_OLLAMA_URL
// are both resolved once at module load from process.env (same pattern local-client.js
// already uses for OLLAMA_URL itself), so each test re-requires the module fresh after
// setting env, same discipline as this file's existing withFixtureRepo helper.
function withEnv(envOverrides, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(envOverrides)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  delete require.cache[require.resolve('./local-client.js')];
  try {
    return fn(require('./local-client.js'));
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    delete require.cache[require.resolve('./local-client.js')];
  }
}

test('IS_P40_ENDPOINT is true only when OLLAMA_URL matches AGENT_MANAGER_P40_OLLAMA_URL exactly', () => {
  withEnv({ OLLAMA_URL: 'http://192.168.122.29:11434', AGENT_MANAGER_P40_OLLAMA_URL: 'http://192.168.122.29:11434' }, (mod) => {
    assert.equal(mod.IS_P40_ENDPOINT, true);
  });
  withEnv({ OLLAMA_URL: 'http://localhost:11434', AGENT_MANAGER_P40_OLLAMA_URL: 'http://192.168.122.29:11434' }, (mod) => {
    assert.equal(mod.IS_P40_ENDPOINT, false, 'the local GPU lane must not be treated as the P40 lane');
  });
  withEnv({ OLLAMA_URL: 'http://localhost:11434', AGENT_MANAGER_P40_OLLAMA_URL: undefined }, (mod) => {
    assert.equal(mod.IS_P40_ENDPOINT, false, 'no P40 configured at all must never match');
  });
});

test('resolveRequestTimeoutMs gives the P40 endpoint its 900s exception, past the standard 240s ceiling, for a real large-plan-pass shaped call', () => {
  withEnv({ OLLAMA_URL: 'http://192.168.122.29:11434', AGENT_MANAGER_P40_OLLAMA_URL: 'http://192.168.122.29:11434' }, (mod) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-client-p40-timeout-'));
    // Real observed P40 throughput (~9.3 tok/s) and the computePlanNumPredict 2800-token
    // budget large-context sources now get (local-draft.js).
    fs.writeFileSync(path.join(dir, '.local-throughput.http___192_168_122_29_11434.json'), JSON.stringify({ tokensPerSecond: 9.3 }));
    const ms = mod.resolveRequestTimeoutMs({ promptTokens: 4000, numPredict: 2800, instancesDir: dir });
    assert.ok(ms > mod.PER_CALL_TIMEOUT_CEILING_MS, `a real P40 large-plan call must get more than the standard 240s ceiling, got ${ms}`);
    assert.ok(ms <= mod.P40_PER_CALL_TIMEOUT_CEILING_MS, `still bounded by the P40 exception itself, got ${ms}`);
  });
});

test('resolveRequestTimeoutMs keeps the standard 240s-derived ceiling for the local (non-P40) endpoint, even for the same large numPredict', () => {
  withEnv({ OLLAMA_URL: 'http://localhost:11434', AGENT_MANAGER_P40_OLLAMA_URL: 'http://192.168.122.29:11434' }, (mod) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-client-local-timeout-'));
    const ms = mod.resolveRequestTimeoutMs({ promptTokens: 4000, numPredict: 2800, instancesDir: dir });
    assert.ok(ms <= mod.PER_CALL_TIMEOUT_CEILING_MS, `the local GPU lane must stay within the documented 240s ceiling, got ${ms}`);
  });
});

// 2026-09-12, root-caused live: worker-reasoning-p40 STILL hit OLLAMA_TIMEOUT after the
// endpoint-keying fix above had landed and been verified working. The P40's own Ollama
// instance serves TWO very differently-sized models over the SAME endpoint --
// qwen3.8-p40:27b-q4_K_M (~10 tok/s real) for most tasks, and qwen2.5:3b (confirmed live
// at 47-65 tok/s on the SAME physical GPU) for brain_dump_sort tasks, which
// worker-p40/worker-reasoning-p40 also run. A prior sample recorded for the small model
// must not calibrate the big model's own timeout on the same endpoint.
test('resolveRequestTimeoutMs on the P40 endpoint is calibrated per MODEL, not just per endpoint -- a fast small-model sample must not speed up the big model\'s timeout', () => {
  withEnv({ OLLAMA_URL: 'http://192.168.122.29:11434', AGENT_MANAGER_P40_OLLAMA_URL: 'http://192.168.122.29:11434' }, (mod) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-client-p40-model-mix-'));
    // A real recorded sample for the SMALL model (qwen2.5:3b, brain_dump_sort tasks) at
    // its real fast speed -- must not affect the big model's own timeout calibration.
    require('./local-throughput.js').recordSample(dir, { evalCount: 500, evalDurationNs: 10_000_000_000, endpoint: 'http://192.168.122.29:11434', model: 'qwen2.5:3b' });
    const msBigModel = mod.resolveRequestTimeoutMs({ promptTokens: 4000, numPredict: 2800, instancesDir: dir, model: 'qwen3.8-p40:27b-q4_K_M' });
    // No sample yet for the big model -> falls back to the conservative 15 tok/s floor,
    // NOT the small model's 50 tok/s -- so the computed timeout must still land near/at
    // the P40 ceiling for a large plan-pass shaped call, not the shorter time the small
    // model's speed would imply.
    assert.ok(msBigModel > mod.PER_CALL_TIMEOUT_CEILING_MS, `the big model's timeout must not be sped up by the small model's sample on the same endpoint, got ${msBigModel}`);
  });
});
