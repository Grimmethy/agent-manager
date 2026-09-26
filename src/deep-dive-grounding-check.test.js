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
  assert.equal(r[0].kind, 'class');
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

// --- checkFabricatedSymbols: dotted module paths / slash file paths (kind: 'import') -----

test('checkFabricatedSymbols flags a dotted module path whose final segment is absent from every real file', () => {
  const r = checkFabricatedSymbols(task(), 'Imported via `haystack.converters.TextFileConverter`.');
  assert.equal(r.length, 1);
  assert.equal(r[0].kind, 'import');
  assert.match(r[0].detail, /haystack\.converters\.TextFileConverter/);
});

test('checkFabricatedSymbols flags a slash-separated file path absent from every real file', () => {
  const r = checkFabricatedSymbols(task(), 'Defined in `src/utils/helper`.');
  assert.equal(r.length, 1);
  assert.equal(r[0].kind, 'import');
});

test('checkFabricatedSymbols does not flag a dotted path whose final segment genuinely appears in the file content', () => {
  const r = checkFabricatedSymbols(task(), 'Imported via `haystack.converters.TextFileToDocument`.');
  assert.deepEqual(r, []);
});

test('checkFabricatedSymbols does not flag a path whose WHOLE string appears verbatim even if the final segment alone would not resolve', () => {
  const t = task({ promptContext: { files: [{ path: 'x.py', content: 'see converters/txt.py for details' }] } });
  const r = checkFabricatedSymbols(t, 'Defined in `converters/txt.py`.');
  assert.deepEqual(r, []);
});

test('checkFabricatedSymbols does not run the path-shaped check on a bare class-shaped symbol (no separator)', () => {
  // CLASS_SHAPED_SYMBOL_RE already covers this shape -- PATH_SHAPED_SYMBOL_RE must not
  // double-flag the same fabricated symbol under a second kind.
  const r = checkFabricatedSymbols(task(), 'The draft references `TextFileConverter`.');
  assert.equal(r.length, 1);
  assert.equal(r[0].kind, 'class');
});

// --- checkFabricatedSymbols: __all__ = [...] list (kind: 'all') --------------------------

test('checkFabricatedSymbols flags an identifier inside a literal __all__ list absent from every real file', () => {
  const r = checkFabricatedSymbols(task(), '```python\n__all__ = ["TextFileToDocument", "TextFileConverter"]\n```');
  assert.equal(r.length, 1);
  assert.equal(r[0].kind, 'all');
  assert.match(r[0].detail, /TextFileConverter/);
});

test('checkFabricatedSymbols does not flag an __all__ entry that genuinely appears in the file content', () => {
  const r = checkFabricatedSymbols(task(), '__all__ = ["TextFileToDocument"]');
  assert.deepEqual(r, []);
});

test('checkFabricatedSymbols with no __all__ list at all reports nothing from that check', () => {
  const r = checkFabricatedSymbols(task(), 'No exports list mentioned here.');
  assert.deepEqual(r, []);
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

test('runGroundingCheck ungrounded verdict includes the full ungrounded[] findings array', async () => {
  const r = await runGroundingCheck(task(), 'The draft references `TextFileConverter` and `ConversionError`.', { call: async () => ({ response: 'GROUNDED' }) });
  assert.equal(r.verdict, 'ungrounded');
  assert.equal(r.ungrounded.length, 2);
  assert.deepEqual(r.ungrounded.map((f) => f.kind), ['class', 'class']);
});

test('runGroundingCheck is callable with just (task) -- defaults implementResponse to task.implementResponse', async () => {
  // Fabricated-symbol short-circuit means this never reaches the real localCall default
  // even though none is injected here -- a genuine single-argument call.
  const t = task({ implementResponse: 'The draft references `TextFileConverter`.' });
  const r = await runGroundingCheck(t);
  assert.equal(r.verdict, 'ungrounded');
});

test('runGroundingCheck is callable with just (task) -- falls back to task.draft when implementResponse is absent', async () => {
  const t = task({ draft: 'The draft references `TextFileConverter`.' });
  const r = await runGroundingCheck(t);
  assert.equal(r.verdict, 'ungrounded');
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

// --- AC-75: real path-shaped citations that can never be in a community's file subset ---
// Shapes measured on real done/ deep_dive tasks (omnigent-ai/omnigent 53, 94, 133).

test('checkFabricatedSymbols does not flag the project name / slug / community name', () => {
  const t = task({ promptContext: { projectName: 'omnigent-ai/omnigent', projectSlug: 'omnigent-ai-omnigent', communityName: 'web/src/pages' } });
  assert.deepEqual(checkFabricatedSymbols(t, 'Deep dive: `omnigent-ai/omnigent` covers `web/src/pages`.'), []);
});

test('checkFabricatedSymbols does not flag a Node builtin API path', () => {
  assert.deepEqual(checkFabricatedSymbols(task(), 'It persists via `fs.promises.writeFile` and `path.join`.'), []);
});

test('checkFabricatedSymbols checks a cited file name by its stem, not its extension', () => {
  const t = task({ promptContext: { files: [{ path: 'web/src/blocks.tsx', content: 'export function SystemMessage() {}' }] } });
  assert.deepEqual(checkFabricatedSymbols(t, 'Rendered by `SystemMessage.tsx`.'), []);
  const bad = checkFabricatedSymbols(t, 'Rendered by `GhostMessage.tsx`.');
  assert.equal(bad.length, 1);
  assert.equal(bad[0].kind, 'import');
});

test('checkFabricatedSymbols still flags a fabricated non-builtin dotted path and an unrelated slug', () => {
  assert.equal(checkFabricatedSymbols(task(), 'Uses `made_up.helpers.thing`.').length, 1);
  assert.equal(checkFabricatedSymbols(task(), 'See `someone-else/other-repo`.').length, 1);
});

test('checkFabricatedSymbols still flags a fabricated file name that merely starts like a Node builtin (AC-75)', () => {
  for (const name of ['util.py', 'events.js', 'stream.ts']) {
    assert.equal(checkFabricatedSymbols(task(), `See \`${name}\`.`).length, 1, name);
  }
});
