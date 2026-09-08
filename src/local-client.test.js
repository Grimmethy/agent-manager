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

function readAuditLog(dir) {
  const p = path.join(dir, 'instances', 'degenerate-audit.log');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('logDegenerateAudit appends one well-formed NDJSON line per call, never throwing on a real pipelineDir', () => {
  withFixtureRepo((mod, dir) => {
    mod.logDegenerateAudit({ source: 'pipeline_debrief', taskId: 't1', stage: 'plan', attempt: 1, degenerate: 'truncated' });
    mod.logDegenerateAudit({ source: 'pipeline_debrief', taskId: 't1', stage: 'plan', attempt: 2, degenerate: 'truncated' });
    const lines = readAuditLog(dir);
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

function readHardFailureAuditLog(dir) {
  const p = path.join(dir, 'instances', 'hard-failure-audit.log');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('logHardFailureAudit appends one well-formed NDJSON line per call, never throwing on a real pipelineDir', () => {
  withFixtureRepo((mod, dir) => {
    mod.logHardFailureAudit({ source: 'pipeline_debrief', taskId: 't1', stage: 'plan', attempt: 1, code: 'OLLAMA_TIMEOUT', timeoutMs: 150000 });
    mod.logHardFailureAudit({ source: 'pipeline_debrief', taskId: 't1', stage: 'plan', attempt: 2, code: 'OLLAMA_TIMEOUT', timeoutMs: 150000 });
    const lines = readHardFailureAuditLog(dir);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].code, 'OLLAMA_TIMEOUT');
    assert.equal(lines[0].timeoutMs, 150000);
    assert.ok(lines[0].at, 'each entry carries its own real timestamp');
    assert.equal(lines[1].attempt, 2);
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
