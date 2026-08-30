'use strict';

// Unit tests for product-spec-assembly.js -- the brownfield product_spec skeleton/marker
// helpers and the product_spec_outline apply. The load-bearing invariant: the section
// implement prompt's `find` string (pendingBlock) must be byte-identical to what
// buildSkeleton actually writes into the doc, or every section edit fails to apply.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const {
  SPEC_DOC_TITLE,
  sectionMarkers,
  pendingBlock,
  filledBlock,
  buildSkeleton,
  sanitizeTitle,
  applyProductSpecOutline,
} = require('./product-spec-assembly.js');

test('pendingBlock output is a verbatim substring of the skeleton buildSkeleton writes (the find/skeleton byte-identity guarantee)', () => {
  const candidates = [
    { id: 'AC-1', title: 'Data Model' },
    { id: 'AC-2', title: 'Generate API' },
  ];
  const skeleton = buildSkeleton(candidates);
  for (const c of candidates) {
    assert.ok(skeleton.includes(pendingBlock(c.id, c.title)), `skeleton must contain pendingBlock(${c.id}) verbatim`);
  }
});

test('filledBlock keeps the exact same open/close markers as pendingBlock (so a filled section is never re-matched by a later run)', () => {
  const { open, close } = sectionMarkers('AC-3');
  const pending = pendingBlock('AC-3', 'API');
  const filled = filledBlock('AC-3', 'API', 'The API accepts a prompt string.');
  assert.ok(pending.startsWith(open) && pending.trimEnd().endsWith(close));
  assert.ok(filled.startsWith(open) && filled.trimEnd().endsWith(close));
  assert.ok(!filled.includes('_(pending)_'), 'a filled block no longer contains the placeholder line');
  assert.ok(pending.includes('_(pending)_'));
});

test('buildSkeleton emits sections in array order under the doc title', () => {
  const skeleton = buildSkeleton([
    { id: 'AC-1', title: 'First' },
    { id: 'AC-2', title: 'Second' },
    { id: 'AC-3', title: 'Third' },
  ]);
  assert.ok(skeleton.startsWith(SPEC_DOC_TITLE + '\n'));
  assert.ok(skeleton.indexOf('## First') < skeleton.indexOf('## Second'));
  assert.ok(skeleton.indexOf('## Second') < skeleton.indexOf('## Third'));
  assert.ok(skeleton.endsWith('\n'));
});

test('sanitizeTitle collapses whitespace and neutralizes a stray "-->" that could be read as a marker close', () => {
  assert.equal(sanitizeTitle('  Data   Model  '), 'Data Model');
  assert.equal(sanitizeTitle('weird --> title'), 'weird → title');
  assert.equal(sanitizeTitle(''), 'Untitled');
  assert.equal(sanitizeTitle(null), 'Untitled');
});

function fakeImplement(...titles) {
  return titles
    .map((t, i) => [
      `### AC-00${i + 1} · ${t}`,
      'Strength: Strong',
      'Files: server/app.py',
      '',
      'Problem:', `why ${t} matters`,
      'Solution:', `document ${t}`,
      'Benefits:', `${t} is settled`,
    ].join('\n'))
    .join('\n\n');
}

test('applyProductSpecOutline writes the outline doc AND seeds the ordered marker skeleton; files = [outline, spec]', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-outline-apply-'));
  const candidatesPath = path.join(dir, 'Docs', 'PRODUCT_SPEC_OUTLINE.md');
  const specPath = path.join(dir, 'Docs', 'PRODUCT_SPEC.md');

  const res = applyProductSpecOutline({ implementResponse: fakeImplement('Data Model', 'Generate API'), candidatesPath, specPath });

  assert.deepEqual(res.files, [candidatesPath, specPath]);
  assert.equal(res.candidateIds.length, 2);

  const outline = fs.readFileSync(candidatesPath, 'utf8');
  assert.ok(outline.includes('### AC-1 · Data Model'));
  assert.ok(outline.includes('### AC-2 · Generate API'));

  const skeleton = fs.readFileSync(specPath, 'utf8');
  // Marker blocks, in order, each still a placeholder, each matching what the section
  // prompt will hand the model as its `find`.
  assert.ok(skeleton.includes(pendingBlock('AC-1', 'Data Model')));
  assert.ok(skeleton.includes(pendingBlock('AC-2', 'Generate API')));
  assert.ok(skeleton.indexOf('AC-1') < skeleton.indexOf('AC-2'));
});

test('applyProductSpecOutline on an empty implement response -> {skipped}, writes nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-outline-empty-'));
  const candidatesPath = path.join(dir, 'Docs', 'PRODUCT_SPEC_OUTLINE.md');
  const specPath = path.join(dir, 'Docs', 'PRODUCT_SPEC.md');

  const res = applyProductSpecOutline({ implementResponse: '""', candidatesPath, specPath });

  assert.equal(res.skipped, true);
  assert.equal(fs.existsSync(candidatesPath), false);
  assert.equal(fs.existsSync(specPath), false);
});

test('applyProductSpecOutline leaves an already-existing spec doc untouched (skeleton only seeds a fresh doc)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-outline-existing-'));
  const candidatesPath = path.join(dir, 'Docs', 'PRODUCT_SPEC_OUTLINE.md');
  const specPath = path.join(dir, 'Docs', 'PRODUCT_SPEC.md');
  fs.mkdirSync(path.dirname(specPath), { recursive: true });
  fs.writeFileSync(specPath, '# Hand-written spec\n\nkeep me\n');

  const res = applyProductSpecOutline({ implementResponse: fakeImplement('Data Model'), candidatesPath, specPath });

  assert.deepEqual(res.files, [candidatesPath], 'only the outline doc is (re)written when the spec already exists');
  assert.equal(fs.readFileSync(specPath, 'utf8'), '# Hand-written spec\n\nkeep me\n');
});
