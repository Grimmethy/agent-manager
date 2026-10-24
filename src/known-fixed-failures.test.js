'use strict';

// known-fixed-failures.js entries that re-run the real, now-fixed check (one test per entry added after this file).
// Run: node --test src/known-fixed-failures.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { KNOWN_FIXED, _setEndpointProbe } = require('./known-fixed-failures.js');

const entry = KNOWN_FIXED.find((e) => e.id === 'ungrounded-field-new-env-var');
const BLOCK = (name) => `Deterministic gate: draft cites a value that appears nowhere in its real grounding source -- ungrounded-field: ${name}. This fact-check flag is high-precision`;
const DIFF = (lines) => ['Summary', '', '=== DIFF ===', 'diff --git a/src/a.js b/src/a.js', '@@ -1 +1,2 @@', ...lines].join('\n');

test('ungrounded-field-new-env-var: re-admits only when every flagged name is an env read in the task own diff', () => {
  assert.ok(entry, 'entry registered');
  assert.deepEqual(entry.dirs, ['blocked', 'needs-clarification']);
  const task1890 = { blockedReason: BLOCK('AGENT_MANAGER_EDIT_FILE_TIERS'), implementResponse: DIFF(["+  const v = String(process.env.AGENT_MANAGER_EDIT_FILE_TIERS || '');"]) };
  assert.equal(entry.applies(task1890), true);
  const viaRawDiff = { blockedReason: BLOCK('AGENT_MANAGER_EDIT_FILE_TIERS'), rawDiff: "diff --git a/x b/x\n@@ -1 +1 @@\n+x = os.getenv('AGENT_MANAGER_EDIT_FILE_TIERS')" };
  assert.equal(entry.applies(viaRawDiff), true);
  const oneInvented = { blockedReason: `${BLOCK('AGENT_MANAGER_EDIT_FILE_TIERS')}\n${BLOCK('MADE_UP_FIELD')}`, implementResponse: task1890.implementResponse };
  assert.equal(entry.applies(oneInvented), false);
  assert.equal(entry.applies({ blockedReason: BLOCK('MADE_UP_FIELD'), implementResponse: DIFF(['+const x = 1;']) }), false);
  assert.equal(entry.applies({ blockedReason: 'something else entirely', implementResponse: task1890.implementResponse }), false);
  assert.equal(entry.applies({}), false);
});

// --- ungrounded-field-test-fixture (2026-10-19) ---------------------------------------------------------------

test('ungrounded-field-test-fixture: re-admits only when every flagged name is only in the task own added test files', () => {
  const fx = KNOWN_FIXED.find((e) => e.id === 'ungrounded-field-test-fixture');
  assert.ok(fx, 'entry registered');
  assert.deepEqual(fx.dirs, ['blocked', 'needs-clarification']);
  const diff = (...lines) => ['Summary', '', '=== DIFF ===', 'diff --git a/src/audit.test.js b/src/audit.test.js', '@@ -1 +1,3 @@', ...lines].join('\n');
  const task1891 = { blockedReason: BLOCK('SENTINEL_THOUGHT'), implementResponse: diff("+  thinking: 'SENTINEL_THOUGHT '.repeat(500),") };
  assert.equal(fx.applies(task1891), true);
  assert.equal(fx.applies({ blockedReason: BLOCK('SENTINEL_THOUGHT'), rawDiff: task1891.implementResponse }), true);
  assert.equal(fx.applies({ blockedReason: `${BLOCK('SENTINEL_THOUGHT')}\n${BLOCK('MADE_UP_FIELD')}`, implementResponse: task1891.implementResponse }), false, 'one name that does not qualify');
  const alsoProd = `${task1891.implementResponse}\ndiff --git a/src/x.js b/src/x.js\n@@ -1 +1,2 @@\n+const t = 'SENTINEL_THOUGHT';`;
  assert.equal(fx.applies({ blockedReason: BLOCK('SENTINEL_THOUGHT'), implementResponse: alsoProd }), false, 'production code uses it too');
  assert.equal(fx.applies({ blockedReason: 'something else', implementResponse: task1891.implementResponse }), false);
  assert.equal(fx.applies({}), false);
});

// --- lane-endpoint-outage-parked (2026-10-23) -----------------------------------------------------------------------------------------------

test('lane-endpoint-outage-parked: re-admits a task parked on an unreachable or silent lane endpoint only while that endpoint answers', () => {
  const e = KNOWN_FIXED.find((x) => x.id === 'lane-endpoint-outage-parked');
  assert.ok(e, 'entry registered');
  assert.deepEqual(e.dirs, ['blocked', 'needs-clarification'], 'the same outage also escalated tasks to needs-clarification');
  const URL = 'http://100.96.112.78:11434';
  const refused = { blockedReason: `draft call failed on an apparent infra outage that did not clear even after 3 requeue round(s) -- giving up rather than retrying forever (most recent: {"succeeded":false,"reason":"Ollama endpoint ${URL} is not reachable (ECONNREFUSED: connect ECONNREFUSED 100.96.112.78:11434)"})` };
  const silent = { blockedReason: `draft call failed 7 times in a row (most recent: {"succeeded":false,"reason":"Ollama endpoint ${URL} did not answer within 5000ms"}) -- giving up rather than retrying every tick forever and starving this lane` };
  const probed = [];
  try {
    _setEndpointProbe((u) => { probed.push(u); return true; });
    assert.equal(e.applies(refused), true, 'refused text, endpoint back');
    assert.equal(e.applies(silent), true, 'silent text, endpoint back');
    assert.deepEqual([...new Set(probed)], [URL], 'the endpoint named in the failure is the one probed');
    assert.equal(e.applies({ blockedReason: 'draft call failed 7 times in a row (most recent: {"reason":"model returned an empty response"})' }), false, 'a different failure is untouched');
    assert.equal(e.applies({}), false);
    _setEndpointProbe(() => false);
    assert.equal(e.applies(refused), false, 'the endpoint is still down: leave the task parked');
  } finally { _setEndpointProbe(null); }
});

test('lane-endpoint-outage-parked: probes each endpoint once per sweep, and the default probe answers false for a closed port', () => {
  const e = KNOWN_FIXED.find((x) => x.id === 'lane-endpoint-outage-parked');
  let calls = 0;
  try {
    _setEndpointProbe(() => { calls += 1; return true; });
    const task = { blockedReason: 'x (most recent: {"reason":"Ollama endpoint http://127.0.0.1:9 is not reachable (ECONNREFUSED)"})' };
    for (let i = 0; i < 5; i += 1) e.applies(task);
    assert.equal(calls, 1, 'cached for the sweep');
    // real default probe against a closed port (nothing listens on port 9)
    _setEndpointProbe(null);
    assert.equal(e.applies(task), false, 'closed port is not answering');
  } finally { _setEndpointProbe(null); }
});
