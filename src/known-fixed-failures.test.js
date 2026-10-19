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
