'use strict';

// known-fixed-failures.js entries that re-run the real, now-fixed check (one test per entry added after this file).
// Run: node --test src/known-fixed-failures.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { KNOWN_FIXED } = require('./known-fixed-failures.js');

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
