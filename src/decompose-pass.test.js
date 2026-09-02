'use strict';

// Tests for the single-call decompose primitive (src/decompose-pass.js). No tool loop,
// so a stubbed `call` fully exercises it.

const test = require('node:test');
const assert = require('node:assert/strict');

const { runDecomposePass, extractSubTasks, ONE_FILE_RULE, REPEATED_DECOMPOSE_OPENER } = require('./decompose-pass.js');

const THREE = JSON.stringify({
  one_pass: false,
  subtasks: [
    { title: 'Add catalog schema module', rawText: 'Create python/dashboard/plugins_catalog.py defining the catalog schema.' },
    { title: 'Add GET /api/plugins endpoint', rawText: 'Add a GET /api/plugins endpoint that reads the catalog file.', after: 0 },
    { title: 'Add plugins UI tab', rawText: 'Add a Plugins tab to the dashboard listing catalog entries.', after: 1 },
  ],
});

function stubCall(response) {
  return async () => ({ response });
}

test('runDecomposePass (preliminary): {"one_pass": true} -> null', async () => {
  const out = await runDecomposePass({ source: 'manual', promptContext: { rawText: 'x' } }, { call: stubCall('{"one_pass": true}') });
  assert.equal(out, null);
});

test('runDecomposePass (preliminary): one_pass false + 3 subtasks -> subTasks list', async () => {
  const out = await runDecomposePass({ source: 'manual', promptContext: { rawText: 'x' } }, { call: stubCall(THREE) });
  assert.ok(out && Array.isArray(out.subTasks));
  assert.equal(out.subTasks.length, 3);
  assert.equal(out.subTasks[0].title, 'Add catalog schema module');
  assert.equal(out.subTasks[1].after, 0);
});

test('runDecomposePass: garbage / prose -> null', async () => {
  const out = await runDecomposePass({ promptContext: { rawText: 'x' } }, { call: stubCall('I think you should probably split this up somehow.') });
  assert.equal(out, null);
});

test('runDecomposePass: a call that throws -> null (non-fatal)', async () => {
  const out = await runDecomposePass({ promptContext: { rawText: 'x' } }, { call: async () => { throw new Error('boom'); } });
  assert.equal(out, null);
});

test('runDecomposePass (preliminary): a single subtask is not a split -> null', async () => {
  const one = JSON.stringify({ one_pass: false, subtasks: [{ title: 'only', rawText: 'just one thing' }] });
  const out = await runDecomposePass({ promptContext: { rawText: 'x' } }, { call: stubCall(one) });
  assert.equal(out, null);
});

test('runDecomposePass (post-exhaustion): a bare JSON array is accepted', async () => {
  const arr = JSON.stringify([
    { title: 'piece one', rawText: 'do part one in its own file' },
    { title: 'piece two', rawText: 'do part two in its own file' },
  ]);
  const out = await runDecomposePass(
    { promptContext: { rawText: 'x' } },
    { mode: 'post-exhaustion', call: stubCall(arr) },
  );
  assert.equal(out.subTasks.length, 2);
});

test('the preliminary prompt spells out the one-file / prefer-a-new-file rule', async () => {
  let seenPrompt = '';
  await runDecomposePass(
    { source: 'manual', title: 'do a big thing', promptContext: { rawText: 'do a big thing' } },
    { call: async ({ prompt }) => { seenPrompt = prompt; return { response: '{"one_pass": true}' }; } },
  );
  assert.ok(seenPrompt.includes(ONE_FILE_RULE));
  assert.match(seenPrompt, /NEW self-contained file/);
});

test('runDecomposePass (repeated-decompose): uses the repeated-decompose opener, still accepts a bare array', async () => {
  let seenPrompt = '';
  const arr = JSON.stringify([
    { title: 'piece one', rawText: 'do part one in its own file' },
    { title: 'piece two', rawText: 'do part two in its own file' },
  ]);
  const out = await runDecomposePass(
    { promptContext: { rawText: 'x' } },
    { mode: 'repeated-decompose', call: async ({ prompt }) => { seenPrompt = prompt; return { response: arr }; } },
  );
  assert.equal(out.subTasks.length, 2);
  assert.ok(seenPrompt.startsWith(REPEATED_DECOMPOSE_OPENER));
  assert.match(seenPrompt, /two separate full implementation attempts/i);
  assert.ok(seenPrompt.includes(ONE_FILE_RULE));
});

test('extractSubTasks is directly usable and mirrors runDecomposePass parsing', () => {
  assert.equal(extractSubTasks('{"one_pass": true}'), null);
  assert.equal(extractSubTasks(THREE).subTasks.length, 3);
  assert.equal(extractSubTasks(''), null);
});

test('extractSubTasks strips a leaked <think> block whose brackets would otherwise break the greedy array match', () => {
  const arr = JSON.stringify([
    { title: 'piece one', rawText: 'do part one in its own file' },
    { title: 'piece two', rawText: 'do part two in its own file' },
  ]);
  const withThink = `<think>\nLet me consider the pieces: [cache module], [routes], [tests].\nActually [a], [b].\n</think>\n${arr}`;
  const out = extractSubTasks(withThink);
  assert.ok(out, 'must recover the real array after the think block');
  assert.equal(out.subTasks.length, 2);
});

test('extractSubTasks drops an unclosed <think> prefix (ran out of budget mid-reasoning)', () => {
  const arr = JSON.stringify([{ title: 'a', rawText: 'aaa' }, { title: 'b', rawText: 'bbb' }]);
  // Real shape: reasoning first, THEN the answer -- but if <think> is unclosed there is no
  // answer to recover, so this asserts we at least do not crash / mis-parse the reasoning.
  assert.equal(extractSubTasks('<think> considering [x] and [y] but never finished'), null);
  // Closed think followed by the array still works.
  assert.equal(extractSubTasks(`<think>done thinking</think>\n${arr}`).subTasks.length, 2);
});

test('runDecomposePass calls the local model with think:false (think:true truncates the JSON on qwen3)', async () => {
  let seenOpts = null;
  await runDecomposePass(
    { promptContext: { rawText: 'x' } },
    { mode: 'repeated-decompose', call: async (opts) => { seenOpts = opts; return { response: '[]' }; } },
  );
  assert.equal(seenOpts.think, false);
});
