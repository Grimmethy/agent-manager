'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('fs');
const path = require('path');
const { buildCritiquePrompt } = require('./prompts.js');

// Real failing content, not synthetic: this is the actual blocked task found live
// 2026-07-21 (deep-dive-autogen-microsoft-20, still sitting in queue/blocked/ at the time
// this test was written). Its promptContext serializes to ~13.6KB -- comfortably over the
// old 3000-char critique truncation cap (which cut it off mid-file, before the second
// community file even started) and comfortably under the new 40000-char cap that matches
// what deep_dive's own plan/implement prompts already received untruncated.
const realTaskPath = path.join(__dirname, '..', 'queue', 'blocked', 'deep-dive-autogen-microsoft-20.json');

function loadRealTaskOrSkip() {
  if (!fs.existsSync(realTaskPath)) return null;
  return JSON.parse(fs.readFileSync(realTaskPath, 'utf8'));
}

test('buildCritiquePrompt does not truncate a real deep_dive promptContext that exceeds the old 3000-char cap', () => {
  const task = loadRealTaskOrSkip();
  if (!task) return; // task since archived/moved on -- not this test's job to pin queue state
  const ctxJson = JSON.stringify(task.promptContext);
  assert.ok(ctxJson.length > 3000, 'fixture assumption: real promptContext must exceed the old cap to prove the fix');

  const prompt = buildCritiquePrompt(task, 'plan text', 'implement text');
  assert.ok(!prompt.includes('...[truncated]'), 'critique prompt should not truncate content that fits under the new 40000-char cap');
  // The second (lower-degree) file's content must actually be present, not cut off before it started.
  assert.ok(prompt.includes('await self.stop()'), 'expected content near the real end of the file to survive into the critique prompt, not just its first ~3000 chars');
});

test('buildCritiquePrompt still truncates a promptContext larger than the new cap', () => {
  const task = { title: 't', domain: 'adhoc', source: 'adhoc', promptContext: { blob: 'x'.repeat(50000) } };
  const prompt = buildCritiquePrompt(task, 'plan', 'impl');
  assert.ok(prompt.includes('...[truncated]'), 'a genuinely oversized promptContext should still be capped, not passed through unbounded');
});
