'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runPlanCritique, parseCritique, deterministicGaps, buildPlanCritiquePrompt, MAX_GAPS } = require('./plan-critique.js');

const task = (over = {}) => ({
  title: 't', source: 'manual',
  planResponse: '1. Edit updateFooCache in `src/foo.js`\n2. run `pytest test_foo.py`',
  promptContext: { rawText: 'change updateFooCache in src/foo.js' },
  _planGrounding: '--- src/foo.js ---\n```\nfunction updateFooCache() { return CACHE; }\n```',
  ...over,
});

test('parseCritique: PLAN OK', () => {
  assert.deepEqual(parseCritique('PLAN OK'), { verdict: 'ok', gaps: [] });
  assert.deepEqual(parseCritique('PLAN OK -- looks fine'), { verdict: 'ok', gaps: [] });
});

test('parseCritique: well-formed GAPS block, enum-filtered, capped', () => {
  const r = parseCritique('GAPS:\n1. MISSING_REQUIREMENT the flag is never set\n2. random noise line\n3. UNVERIFIED_PATH src/nope.js does not exist\n4. NOT_A_TAG whatever');
  assert.equal(r.verdict, 'gaps');
  assert.deepEqual(r.gaps, ['MISSING_REQUIREMENT the flag is never set', 'UNVERIFIED_PATH src/nope.js does not exist']);
});

test('parseCritique: 0 conforming lines -> ok (3b noise)', () => {
  assert.deepEqual(parseCritique('Well, I think the plan could be better and maybe you should...'), { verdict: 'ok', gaps: [] });
});

test('deterministicGaps: flags a cited path absent from the grounding', () => {
  const g = deterministicGaps(task({ planResponse: '1. Edit `src/ghost.js` to add updateFooCache', promptContext: { rawText: 'change updateFooCache' } }));
  assert.ok(g.some((x) => x.startsWith('UNVERIFIED_PATH') && x.includes('src/ghost.js')));
});

test('deterministicGaps: does NOT flag a path the plan is creating', () => {
  const g = deterministicGaps(task({ planResponse: '1. Create a new file `src/brand-new.js` with updateFooCache', promptContext: { rawText: 'change updateFooCache' } }));
  assert.ok(!g.some((x) => x.includes('src/brand-new.js')));
});

test('deterministicGaps: flags a request identifier the plan never mentions', () => {
  const g = deterministicGaps(task({ promptContext: { rawText: 'change updateFooCache and also wire handleRetryTimeout' } }));
  assert.ok(g.some((x) => x.startsWith('MISSING_REQUIREMENT') && x.includes('handleRetryTimeout')));
});

test('deterministicGaps: clean plan -> []', () => {
  assert.deepEqual(deterministicGaps(task()), []);
});

test('runPlanCritique: deterministic gap -> gaps, viaModel false, no model call', async () => {
  let called = false;
  const r = await runPlanCritique(task({ promptContext: { rawText: 'change updateFooCache and handleRetryTimeout' } }), { call: async () => { called = true; return {}; } });
  assert.equal(r.verdict, 'gaps');
  assert.equal(r.viaModel, false);
  assert.equal(called, false);
});

test('runPlanCritique: clean plan -> model call on the critique model, own lock key', async () => {
  const seen = {};
  const r = await runPlanCritique(task(), {
    call: async (opts) => { Object.assign(seen, opts); return { response: 'PLAN OK' }; },
    maybeLockedOn: (model, fn, pass) => { seen.lockModel = model; seen.lockPass = pass; return fn(); },
  });
  assert.equal(r.verdict, 'ok');
  assert.equal(r.viaModel, true);
  assert.equal(seen.model, 'qwen2.5:3b');
  assert.equal(seen.lockModel, 'qwen2.5:3b');
  assert.equal(seen.lockPass, 'plan-critique');
});

test('runPlanCritique: model throw -> ok (advisory), no re-plan triggered', async () => {
  const r = await runPlanCritique(task(), { call: async () => { throw new Error('ollama down'); } });
  assert.equal(r.verdict, 'ok');
  assert.match(r.error, /ollama down/);
});

test('buildPlanCritiquePrompt: strict enum contract, no code-review framing', () => {
  const p = buildPlanCritiquePrompt(task());
  assert.match(p, /PLAN OK/);
  assert.match(p, /MISSING_REQUIREMENT/);
  assert.match(p, /max 5, TAG one of/);
  assert.match(p, /NOT reviewing code/);
});
