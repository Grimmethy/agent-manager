'use strict';

// Tests for serial-intent.js (brain dump #1661). Run: node --test src/serial-intent.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectSerialIntent } = require('./serial-intent.js');

const sig = (snippet) => detectSerialIntent(snippet).signals;

test('a plain independent loop shows no evidence of serial intent, so it goes to the normal pipeline', () => {
  const independent = ['async function loadAll(urls) {', '  const out = [];', '  for (const u of urls) {', '    const r = await fetch(u);', '    out.push(r);', '  }', '  return out;', '}'].join('\n');
  assert.deepEqual(detectSerialIntent(independent), { intentional: false, signals: [] });
  assert.deepEqual(detectSerialIntent(''), { intentional: false, signals: [] });
  for (const bad of [undefined, null, 12, {}, [], '   \n  ']) assert.deepEqual(detectSerialIntent(bad), { intentional: false, signals: [] });
});

test('the two real findings that were MERGED as fixes show no serial intent (they are majority-vote loops, genuinely parallelisable)', () => {
  const claudeClient = ['async function majorityVote({ prompt, classify, n = 3, minAgreeing = 2, temperature = 0.2, model, effort, timeoutMs, taskId, stage }) {', '  const votes = [];', '  const voteErrors = [];', '  for (let i = 0; i < n; i++) {', '    let result;', '    try {', '      // allowSideFindings:false -- a vote is a binary classifier, not an exploratory pass;'].join('\n');
  const localClient = ['async function majorityVote({ prompt, classify, n = 3, minAgreeing = 2, temperature = 0.2, source, model, numCtx, numPredict, taskId, stage }) {', '  const votes = [];', '  const voteErrors = [];', '  for (let i = 0; i < n; i++) {', '    let result;', '    try {', '      result = await call({ prompt, think: false, temperature, source, model, numCtx, numPredict, taskId, stage, allowSideFindings: false }, 1);'].join('\n');
  assert.deepEqual(sig(claudeClient), []);
  assert.deepEqual(sig(localClient), [], 'a default parameter in the function signature (temperature = 0.2) is not a reassignment inside the loop');
});

test('a comment that says the order matters, or that the work is rate limited or locked, is evidence', () => {
  for (const c of ['// must run in order', '// one at a time: the API is rate limited', '/* serialize these writes */', '# sequential on purpose', '// single-flight so the GPU is not oversubscribed', '// do not parallelize, the mocks are process-global']) {
    assert.deepEqual(sig(`for (const x of xs) {\n  ${c}\n  await step(x);\n}`), ['comment-says-serial'], c);
  }
  assert.deepEqual(sig('for (const x of xs) {\n  const note = "sequential";\n  await step(x);\n}'), [], 'the word in a string is not a comment');
});

test('a poll, sleep or backoff awaited in the loop is evidence', () => {
  for (const line of ['await sleep(500);', 'await delay(ms);', 'await new Promise(r => setTimeout(r, 1000));', 'await waitFor(ready);', 'await asyncio.sleep(2)', 'await backoff(n);']) {
    assert.ok(sig(`while (!done) {\n  ${line}\n}`).includes('poll-or-backoff-sleep'), line);
  }
});

test('retry and attempt loops are evidence', () => {
  assert.ok(sig('for (let attempt = 0; attempt < max; attempt++) {\n  const r = await callOnce(opts);\n}').includes('retry-loop'));
  assert.ok(sig('while (retries > 0) {\n  await post(body);\n  retries--;\n}').includes('retry-loop'));
});

test('a pagination cursor is evidence, whether it is assigned in the loop or tested in its condition', () => {
  assert.ok(sig('do {\n  const page = await list({ cursor });\n  cursor = page.next;\n} while (cursor);').includes('pagination-cursor'));
  assert.ok(sig('while (hasMore) {\n  const r = await fetchPage(token);\n}').includes('pagination-cursor'));
  assert.ok(sig('let offset = 0;\nfor (;;) {\n  const rows = await query(offset);\n  offset = offset + rows.length;\n}').includes('pagination-cursor'));
});

test('an unbounded consumer loop and async iteration are evidence', () => {
  assert.ok(sig('while (true) {\n  const job = await queue.take();\n  run(job);\n}').includes('unbounded-consumer-loop'));
  assert.ok(sig('for (;;) {\n  await tick();\n}').includes('unbounded-consumer-loop'));
  assert.ok(sig('while True:\n    msg = await q.get()').includes('unbounded-consumer-loop'));
  assert.ok(sig('for await (const chunk of stream) {\n  await sink(chunk);\n}').includes('async-iteration'));
  assert.ok(sig('async for msg in stream:\n    await handle(msg)').includes('async-iteration'));
});

test('an early break or return AFTER the await is evidence; one before the await is not', () => {
  assert.ok(sig('for (const s of servers) {\n  const r = await probe(s);\n  if (r.ok) return r;\n}').includes('early-exit-after-await'));
  assert.ok(sig('for (const s of servers) {\n  const r = await probe(s);\n  if (r.ok) break;\n}').includes('early-exit-after-await'));
  assert.ok(sig('for (const s of servers) {\n  return await probe(s);\n}').includes('early-exit-after-await'));
  assert.deepEqual(sig('for (const s of servers) {\n  if (!s) return;\n  const r = await probe(s);\n  out.push(r);\n}'), []);
});

test('loop-carried state is evidence: a condition variable updated in the body, or an awaited argument reassigned after the await', () => {
  assert.ok(sig('while (node) {\n  const r = await visit(node);\n  node = r.next;\n}').includes('loop-condition-updated-in-body'));
  assert.ok(sig('let prev = seed;\nfor (const x of xs) {\n  const r = await step(prev, x);\n  prev = r;\n}').includes('awaited-argument-updated-in-body'));
  // a variable declared INSIDE the loop is per-iteration, not carried
  assert.deepEqual(sig('for (const x of xs) {\n  let prev = 0;\n  const r = await step(prev, x);\n  prev = r;\n  out.push(prev);\n}'), []);
  // a for-loop counter is not loop-carried data
  assert.deepEqual(sig('for (let i = 0; i < n; i++) {\n  const r = await f(i);\n  out.push(r);\n}'), []);
});

test('several signals are each reported once, and the result is intentional only when there is at least one', () => {
  const r = detectSerialIntent('for (let attempt = 0; attempt < 3; attempt++) {\n  await sleep(100);\n  const x = await go();\n  if (x) break;\n}');
  assert.equal(r.intentional, true);
  assert.deepEqual([...r.signals].sort(), ['early-exit-after-await', 'poll-or-backoff-sleep', 'retry-loop']);
  assert.equal(new Set(r.signals).size, r.signals.length);
});
