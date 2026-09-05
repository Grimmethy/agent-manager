'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runGroundingCheck, checkFabricatedSymbols, parseGroundingVerdict,
} = require('./deep-dive-grounding-check.js');

// Real incident shape: the draft cites `TextFileConverter`/`ConversionError`, but the
// real file names the class `TextFileToDocument`.
const REAL_FILE = {
  path: 'haystack/components/converters/txt.py',
  content: [
    '@component',
    'class TextFileToDocument:',
    '    """Converts text files into Documents."""',
    '    def run(self, sources):',
    '        return {"documents": []}',
  ].join('\n'),
};

const task = (over = {}) => ({
  source: 'deep_dive',
  promptContext: { projectName: 'deepset-ai/haystack', communityName: 'converters', files: [REAL_FILE], ...over.promptContext },
  ...over,
});

// --- checkFabricatedSymbols (free, deterministic) ---------------------------------------

test('checkFabricatedSymbols flags a class-shaped symbol absent from every real file', () => {
  const r = checkFabricatedSymbols(task(), 'The draft references `TextFileConverter`.');
  assert.equal(r.length, 1);
  assert.equal(r[0].kind, 'fabricated-symbol');
  assert.match(r[0].detail, /`TextFileConverter`/);
});

test('checkFabricatedSymbols flags EACH distinct fabricated symbol, not just the first', () => {
  const r = checkFabricatedSymbols(task(), 'The draft references `TextFileConverter` and `ConversionError`.');
  assert.equal(r.length, 2);
  assert.match(r.map((c) => c.detail).join(' '), /TextFileConverter/);
  assert.match(r.map((c) => c.detail).join(' '), /ConversionError/);
});

test('checkFabricatedSymbols does not flag a real symbol that genuinely appears in the file content', () => {
  const r = checkFabricatedSymbols(task(), 'The draft correctly describes `TextFileToDocument`.');
  assert.deepEqual(r, []);
});

test('checkFabricatedSymbols ignores lowercase/generic backtick terms (not class-shaped)', () => {
  const r = checkFabricatedSymbols(task(), 'It uses a `pipeline` and reads `config` values.');
  assert.deepEqual(r, []);
});

test('checkFabricatedSymbols returns nothing when the task has no real files to check against', () => {
  const r = checkFabricatedSymbols(task({ promptContext: { files: [] } }), 'References `TotallyMadeUp`.');
  assert.deepEqual(r, []);
});

test('checkFabricatedSymbols reports only the first occurrence of a repeated fabricated symbol, not once per mention', () => {
  const r = checkFabricatedSymbols(task(), 'Uses `TextFileConverter` here and `TextFileConverter` again there.');
  assert.equal(r.length, 1);
});

// --- parseGroundingVerdict ----------------------------------------------------------------

test('parseGroundingVerdict parses GROUNDED and NOT_GROUNDED, treats noise as ok', () => {
  assert.deepEqual(parseGroundingVerdict('GROUNDED'), { verdict: 'ok' });
  assert.deepEqual(parseGroundingVerdict('NOT_GROUNDED -- the real file uses @tool, not @register_for_llm'),
    { verdict: 'ungrounded', reason: 'the real file uses @tool, not @register_for_llm' });
  assert.deepEqual(parseGroundingVerdict('unrelated 3b noise'), { verdict: 'ok' });
});

// --- runGroundingCheck end-to-end (mocked model call) ------------------------------------

test('runGroundingCheck catches a fabricated class name deterministically, no model call', async () => {
  let calls = 0;
  const call = async () => { calls += 1; return { response: 'GROUNDED' }; };
  const r = await runGroundingCheck(task(), 'The draft references `TextFileConverter` and `ConversionError`.', { call });
  assert.equal(r.verdict, 'ungrounded');
  assert.equal(calls, 0, 'the deterministic check must short-circuit before any model call');
});

test('runGroundingCheck falls back to the cheap model for a contradiction the deterministic check cannot catch', async () => {
  const call = async () => ({ response: 'NOT_GROUNDED -- the real class is decorated with @tool(approval_mode=...), not @register_for_llm' });
  const r = await runGroundingCheck(task(), 'The tools are registered via `TextFileToDocument`\'s own decorator, using @register_for_llm.', { call });
  assert.equal(r.verdict, 'ungrounded');
  assert.match(r.reason, /@register_for_llm/);
});

test('runGroundingCheck passes through a genuinely well-grounded write-up', async () => {
  const call = async () => ({ response: 'GROUNDED' });
  const r = await runGroundingCheck(task(), 'The `TextFileToDocument` class converts text files into Documents via its run() method.', { call });
  assert.deepEqual(r, { verdict: 'ok' });
});

test('runGroundingCheck is advisory: a throwing/failing model call never blocks the draft', async () => {
  const call = async () => { throw new Error('model call timed out'); };
  const r = await runGroundingCheck(task(), 'Describes `TextFileToDocument` correctly.', { call });
  assert.equal(r.verdict, 'ok');
});

test('runGroundingCheck treats a legitimate empty ("found nothing") draft as ok with no model call', async () => {
  let calls = 0;
  const call = async () => { calls += 1; return { response: 'NOT_GROUNDED -- x' }; };
  const r = await runGroundingCheck(task(), '', { call });
  assert.deepEqual(r, { verdict: 'ok' });
  assert.equal(calls, 0);
});

test('runGroundingCheck is a no-op when AGENT_MANAGER_DEEP_DIVE_GROUNDING_CHECK=false', async () => {
  process.env.AGENT_MANAGER_DEEP_DIVE_GROUNDING_CHECK = 'false';
  try {
    const call = async () => ({ response: 'NOT_GROUNDED -- anything' });
    const r = await runGroundingCheck(task(), 'References `TextFileConverter`.', { call });
    assert.deepEqual(r, { verdict: 'ok' });
  } finally {
    delete process.env.AGENT_MANAGER_DEEP_DIVE_GROUNDING_CHECK;
  }
});

test('runGroundingCheck skips the model call when the task has no real files fetched at all', async () => {
  let calls = 0;
  const call = async () => { calls += 1; return { response: 'NOT_GROUNDED -- x' }; };
  const r = await runGroundingCheck(task({ promptContext: { files: [] } }), 'Some claim about `Whatever`.', { call });
  assert.deepEqual(r, { verdict: 'ok' });
  assert.equal(calls, 0);
});
