'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runOrientPass, buildOrientPrompt, ORIENT_TURNS } = require('./orient-pass.js');

const task = (rawText, extra = {}) => ({ source: 'manual', domain: 'default', title: 't', promptContext: { rawText, ...extra } });
const covering = { text: 'GREP HITS:\nsrc/foo.js:1: function updateFooCache() {}', anchorPaths: [], grepHits: [{ file: 'src/foo.js', line: 1, text: 'function updateFooCache() {}' }] };
const weak = { text: '', anchorPaths: [], grepHits: [] };

test('buildOrientPrompt: ORIENTATION REPORT contract, seeds the grep grounding, no RESOLUTION verbs', () => {
  const p = buildOrientPrompt(task('add updateFooCache'), 'GREP HITS:\nsrc/foo.js:1: x');
  assert.match(p, /ORIENTATION REPORT/);
  assert.match(p, /CURRENT STATE:/);
  assert.match(p, /EDIT LOCATION/);
  assert.match(p, /CONFIRM it and FILL THE GAPS/);
  assert.doesNotMatch(p, /RESOLUTION: implemented/);
});

test('skips (0 GPU) when the deterministic grounding already covers the task', async () => {
  let ran = false;
  const r = await runOrientPass(task('fix updateFooCache in src/foo.js'), {
    grounding: covering, runPlan: async () => { ran = true; return {}; },
  });
  assert.equal(r.skipped, true);
  assert.equal(r.turnsUsed, 0);
  assert.equal(ran, false, 'runPlan must not be called on a covered task');
  assert.equal(r.notes, covering.text);
});

test('AGENT_MANAGER_ADHOC_ORIENT_ALWAYS=true forces a run even when covered', async () => {
  process.env.AGENT_MANAGER_ADHOC_ORIENT_ALWAYS = 'true';
  try {
    let ran = false;
    await runOrientPass(task('fix updateFooCache in src/foo.js'), {
      grounding: covering, runPlan: async () => { ran = true; return { response: 'CURRENT STATE: ok', turnsUsed: 1 }; },
    });
    assert.equal(ran, true);
  } finally { delete process.env.AGENT_MANAGER_ADHOC_ORIENT_ALWAYS; }
});

test('runs the read-only pass with maxTurns=ORIENT_TURNS when grounding is weak; report -> notes', async () => {
  const seen = {};
  const r = await runOrientPass(task('improve dashboard performance broadly'), {
    grounding: weak,
    runPlan: async (opts) => { Object.assign(seen, opts); return { response: 'CURRENT STATE: the dashboard renders X\nKEY FILES/SYMBOLS: python/dashboard/app.py:10 -- the render loop', toolCallLog: [{ tool: 'read_file', args: { path: 'python/dashboard/app.py' } }], turnsUsed: 6 }; },
  });
  assert.equal(seen.maxTurns, ORIENT_TURNS);
  assert.equal(r.skipped, false);
  assert.equal(r.turnsUsed, 6);
  assert.match(r.notes, /CURRENT STATE: the dashboard renders X/);
  assert.match(r.notes, /Files already read: python\/dashboard\/app\.py/);
});

test('runPlan throwing -> skipped with the deterministic grounding as fallback notes, no throw', async () => {
  const r = await runOrientPass(task('architectural thing'), {
    grounding: { text: 'GREP HITS:\nsrc/a.js:2: x', anchorPaths: [], grepHits: [] },
    runPlan: async () => { throw new Error('ollama down'); },
  });
  assert.equal(r.skipped, true);
  assert.match(r.notes, /src\/a\.js:2/);
  assert.match(r.error, /ollama down/);
});

test('notes are capped', async () => {
  const r = await runOrientPass(task('x'), {
    grounding: weak,
    runPlan: async () => ({ response: 'CURRENT STATE: ' + 'y'.repeat(20000), turnsUsed: 8 }),
  });
  assert.ok(r.notes.length <= 4100, `notes were ${r.notes.length}`);
});
