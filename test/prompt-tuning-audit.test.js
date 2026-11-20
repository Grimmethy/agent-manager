'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { gatherCorpus, promptTemplateText } = require('../src/prompt-tuning-audit.js');

const TARGET = 'brain_dump_sort';

function makeRepo(nMatching) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pta-'));
  const dir = path.join(root, 'queue', 'done');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < nMatching; i++) {
    const rec = { promptTarget: TARGET, input: 'in ' + i, output: 'out ' + i, verdict: 'pass', reason: 'r' + i };
    fs.writeFileSync(path.join(dir, 't' + i + '.json'), JSON.stringify(rec));
  }
  return root;
}

function withMin(value, fn) {
  const prev = process.env.PROMPT_TUNING_MIN_OUTCOMES;
  process.env.PROMPT_TUNING_MIN_OUTCOMES = String(value);
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.PROMPT_TUNING_MIN_OUTCOMES;
    else process.env.PROMPT_TUNING_MIN_OUTCOMES = prev;
  }
}

test('below threshold is not ready', () => {
  const root = makeRepo(4);
  const r = withMin(5, () => gatherCorpus(root, TARGET));
  assert.strictEqual(r.count, 4);
  assert.strictEqual(r.ready, false);
});

test('at threshold is ready', () => {
  const root = makeRepo(5);
  const r = withMin(5, () => gatherCorpus(root, TARGET));
  assert.strictEqual(r.count, 5);
  assert.strictEqual(r.ready, true);
});

test('tuples are capped at 20 while count reports every match', () => {
  const root = makeRepo(25);
  const r = withMin(5, () => gatherCorpus(root, TARGET));
  assert.strictEqual(r.count, 25);
  assert.strictEqual(r.tuples.length, 20);
  assert.strictEqual(r.ready, true);
  assert.deepStrictEqual(Object.keys(r.tuples[0]).sort(), ['input', 'output', 'reason', 'verdict']);
});

test('promptTemplateText slices the function to its matching brace, skipping braces in strings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pta-src-'));
  fs.mkdirSync(path.join(root, 'src', 'lib'), { recursive: true });
  const fixture = [
    'function brainDumpSortPlanPrompt(task) {',
    "  const s = '} not a close {';",
    '  return `x ${task.id} } ${"{"}`;',
    '}',
    'module.exports = {};',
  ].join('\n');
  fs.writeFileSync(path.join(root, 'src', 'lib', 'prompt-planning.js'), fixture);
  const text = promptTemplateText(root, TARGET);
  assert.ok(text.startsWith('function brainDumpSortPlanPrompt'));
  assert.ok(text.endsWith('}'));
  assert.ok(!text.includes('module.exports'));
});

test('promptTemplateText throws when the function is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pta-miss-'));
  fs.mkdirSync(path.join(root, 'src', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'lib', 'prompt-planning.js'), 'const x = 1;\n');
  assert.throws(() => promptTemplateText(root, TARGET), /not found/);
});
