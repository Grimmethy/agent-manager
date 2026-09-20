'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTypographic, decodeTypographicEscapes, resolveFind, retypographize, canonicalizeEdits } = require('./find-canonicalize.js');

// A trimmed copy of the PF PropertyDetailPanel.tsx block that broke function-length-fix-ac-3: a JSX paragraph with a curly-quoted “Owner”.
const FILE = [
  'function ExpandedDetail() {',
  '  return (',
  '    <div>',
  "      {phone ? <a href={tel}>{phone}</a> : (",
  '        <p className="text-xs">',
  '          Not a lead? Mark it as “Owner” and we will follow up — usually within a day.',
  '        </p>',
  '      )}',
  '    </div>',
  '  );',
  '}',
].join('\n');
const files = [{ path: 'src/P.tsx', content: FILE }];
const realBlock = ['        <p className="text-xs">', '          Not a lead? Mark it as “Owner” and we will follow up — usually within a day.', '        </p>'].join('\n');
const straight = realBlock.replace(/[“”]/g, '"').replace('—', '-');
const edit = (over) => JSON.stringify([{ mode: 'edit', file: 'src/P.tsx', find: straight, replace: '<Card>\n' + straight + '\n</Card>', ...over }]);

test('normalizeTypographic maps quotes, dashes and special spaces 1:1 (length never changes)', () => {
  const s = '“a” ‘b’ c–d e—f g h';
  assert.equal(normalizeTypographic(s), '"a" \'b\' c-d e-f g h');
  assert.equal(normalizeTypographic(s).length, s.length);
});

test('decodeTypographicEscapes decodes ONLY typographic \\u escapes -- a real source escape stays', () => {
  assert.equal(decodeTypographicEscapes('\\u201cOwner\\u201d \\u2014 x'), '“Owner” — x');
  assert.equal(decodeTypographicEscapes('const nl = "\\u0041\\u000a";'), 'const nl = "\\u0041\\u000a";');
});

test('resolveFind: exact stays exact; a straight-quote find resolves to the file real span; missing/ambiguous are reported', () => {
  assert.equal(resolveFind(FILE, 'Not a lead?').status, 'exact');
  const r = resolveFind(FILE, straight);
  assert.equal(r.status, 'normalized');
  assert.equal(r.real, realBlock);
  assert.equal(resolveFind(FILE, 'text that is nowhere in the file').status, 'missing');
  const twice = 'x “Owner” y\nx “Owner” y';
  assert.equal(resolveFind(twice, 'x "Owner" y').status, 'ambiguous', 'two possible locations: refuse to guess');
});

test('resolveFind: a literal backslash-u escape find (the second way the model got it wrong) resolves too', () => {
  const escaped = realBlock.replace('“Owner”', '\\u201cOwner\\u201d').replace('—', '\\u2014');
  const r = resolveFind(FILE, escaped);
  assert.equal(r.status, 'normalized');
  assert.equal(r.real, realBlock);
});

test('canonicalizeEdits: rewrites the find to the real text AND gives the replacement its curly quotes and dash back', () => {
  const r = canonicalizeEdits(edit(), files);
  assert.equal(r.changed, true);
  assert.deepEqual(r.fixes, [{ file: 'src/P.tsx', findChars: straight.length, changedChars: 3 }]);
  const [e] = JSON.parse(r.text);
  assert.equal(e.find, realBlock);
  assert.equal(e.replace, '<Card>\n' + realBlock + '\n</Card>');
  assert.ok(FILE.includes(e.find), 'the canonical find is now an exact substring of the file');
});

test('canonicalizeEdits: a replacement that wraps the block differently still gets its typography back; an unrelated straight quote is left alone', () => {
  const r = canonicalizeEdits(edit({ replace: '<Card title="x">' + straight + '</Card> // say "hello" here' }), files);
  const [e] = JSON.parse(r.text);
  assert.ok(e.replace.includes('Mark it as “Owner” and'), e.replace);
  assert.ok(e.replace.includes('— usually'), e.replace);
  assert.ok(e.replace.endsWith('// say "hello" here'), 'a straight quote that has nothing to do with the moved text is untouched');
});

test('canonicalizeEdits: over-escaped find AND replace are both fixed', () => {
  const esc = (s) => s.replace(/"Owner"/, '\\u201cOwner\\u201d').replace(/-/g, (m, i, all) => (all.slice(i - 1, i + 2) === ' - ' ? '\\u2014' : m));
  const r = canonicalizeEdits(edit({ find: esc(straight), replace: esc(straight) + '\n<Extra/>' }), files);
  assert.equal(r.changed, true);
  const [e] = JSON.parse(r.text);
  assert.equal(e.find, realBlock);
  assert.equal(e.replace, realBlock + '\n<Extra/>');
});

test('canonicalizeEdits: leaves everything it cannot safely resolve exactly as it was', () => {
  const same = (input) => { const r = canonicalizeEdits(input, files); assert.equal(r.changed, false); assert.equal(r.text, input); };
  same(edit({ find: realBlock }));                                                     // already exact
  same(edit({ find: 'something else entirely' }));                                     // not in the file at all
  same(edit({ file: 'src/other.tsx' }));                                               // file not fetched
  same(JSON.stringify([{ mode: 'create', file: 'src/P.tsx', find: straight, content: 'x' }])); // not an edit
  same('not json at all');
  same('');
  same(null);
  const dup = [{ path: 'src/D.tsx', content: 'a “Owner” b\nc\na “Owner” b' }];
  const amb = JSON.stringify([{ mode: 'edit', file: 'src/D.tsx', find: 'a "Owner" b', replace: 'z' }]);
  assert.equal(canonicalizeEdits(amb, dup).changed, false, 'ambiguous after normalisation: never guess');
});

test('canonicalizeEdits: keeps the response shape (single object stays an object; a fenced array is accepted) and only touches what needs it', () => {
  const single = canonicalizeEdits(JSON.stringify({ mode: 'edit', file: 'src/P.tsx', find: straight, replace: 'x' }), files);
  assert.equal(Array.isArray(JSON.parse(single.text)), false);
  assert.equal(JSON.parse(single.text).find, realBlock);
  const fenced = canonicalizeEdits('```json\n' + edit() + '\n```', files);
  assert.equal(fenced.changed, true);
  const mixed = canonicalizeEdits(JSON.stringify([
    { mode: 'edit', file: 'src/P.tsx', find: 'function ExpandedDetail() {', replace: 'function ExpandedDetail2() {' }, // exact: untouched
    { mode: 'edit', file: 'src/P.tsx', find: straight, replace: 'y' },
  ]), files);
  const [a, b] = JSON.parse(mixed.text);
  assert.equal(a.find, 'function ExpandedDetail() {');
  assert.equal(b.find, realBlock);
  assert.equal(mixed.fixes.length, 1);
});

test('retypographize: context-anchored, does not touch a lookalike elsewhere in the replacement', () => {
  const real = 'He said “go” now';
  const candidate = 'He said "go" now';
  assert.equal(retypographize('A: He said "go" now; B: "go" alone', candidate, real), 'A: He said “go” now; B: "go" alone');
});
