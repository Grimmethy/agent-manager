'use strict';

// Test suite for src/context-compaction.js (HUB0155 · 1/3).
// Self-contained: `node src/context-compaction.test.js` runs every case and exits
// non-zero on the first failure (node:test's own failure reporting), zero on
// success. No project-internal imports, no I/O.

const test = require('node:test');
const assert = require('node:assert/strict');

const { TRUNC_MARKER, DEFAULT_SECTION_CAP, compactTailKeep, assembleCappedBlock } = require('./context-compaction.js');

const LONG = 'A'.repeat(1000) + 'B'.repeat(1000); // 2000 A's then 2000 B's

test('exports: exactly the four public names, no extras', () => {
  assert.deepEqual(Object.keys(require('./context-compaction.js')).sort(), [
    'DEFAULT_SECTION_CAP', 'TRUNC_MARKER', 'assembleCappedBlock', 'compactTailKeep',
  ]);
});

test('TRUNC_MARKER is a non-empty string', () => {
  assert.equal(typeof TRUNC_MARKER, 'string');
  assert.ok(TRUNC_MARKER.length > 0);
});

test('DEFAULT_SECTION_CAP is a positive number', () => {
  assert.equal(typeof DEFAULT_SECTION_CAP, 'number');
  assert.ok(Number.isFinite(DEFAULT_SECTION_CAP) && DEFAULT_SECTION_CAP > 0);
});

test('compactTailKeep: short text is returned unchanged', () => {
  assert.equal(compactTailKeep('hello', 100), 'hello');
  assert.equal(compactTailKeep(LONG, LONG.length), LONG);
});

test('compactTailKeep: text exactly at the cap is returned unchanged', () => {
  const s = 'x'.repeat(500);
  assert.equal(compactTailKeep(s, 500), s);
});

test('compactTailKeep: long text is cut to exactly the cap, head and tail kept, marker at the seam', () => {
  const out = compactTailKeep(LONG, 1000, 300);
  assert.equal(out.length, 1000);
  assert.ok(out.includes(TRUNC_MARKER));
  assert.ok(out.startsWith('A'.repeat(300)), 'head (first 300 chars) must survive');
  assert.ok(out.endsWith('B'.repeat(1000 - 300 - TRUNC_MARKER.length)), 'tail must fill the rest of the budget');
  const cut = out.indexOf(TRUNC_MARKER);
  assert.equal(cut, 300, 'marker sits right after the kept head');
});

test('compactTailKeep: custom cap and keep both drive the budget', () => {
  const out = compactTailKeep(LONG, 500, 100);
  assert.equal(out.length, 500);
  assert.ok(out.startsWith('A'.repeat(100)));
  assert.ok(out.endsWith('B'.repeat(500 - 100 - TRUNC_MARKER.length)));
});

test('compactTailKeep: cap too small for the marker -> first cap chars, no marker', () => {
  const cap = TRUNC_MARKER.length - 1;
  const out = compactTailKeep(LONG, cap);
  assert.equal(out.length, cap);
  assert.equal(out, 'A'.repeat(cap));
  assert.ok(!out.includes(TRUNC_MARKER));
});

test('compactTailKeep: cap <= 0 keeps nothing; null input becomes empty string', () => {
  assert.equal(compactTailKeep(LONG, 0), '');
  assert.equal(compactTailKeep(null, 100), '');
  assert.equal(compactTailKeep(undefined, 100), '');
});

test('compactTailKeep: keep clamped to the cap; non-string input coerced', () => {
  const out = compactTailKeep(LONG, 1000, 100000); // keep asks for more than the cap allows
  assert.equal(out.length, 1000);
  assert.ok(out.includes(TRUNC_MARKER));
  assert.equal(compactTailKeep(42, 10), '42');
});

test('assembleCappedBlock: empty array -> empty string', () => {
  assert.equal(assembleCappedBlock([]), '');
});

test('assembleCappedBlock: single string section passes through when short', () => {
  assert.equal(assembleCappedBlock(['just a line']), 'just a line');
});

test('assembleCappedBlock: multiple sections joined by a blank line, each capped to the cap', () => {
  const a = 'A'.repeat(1500);
  const b = 'B'.repeat(1500);
  const cap = 400;
  const out = assembleCappedBlock([a, b], cap);
  const parts = out.split('\n\n');
  assert.equal(parts.length, 2);
  assert.ok(parts[0].startsWith(a.slice(0, Math.min(200, 400 - TRUNC_MARKER.length))));
  assert.ok(parts[0].endsWith(a.slice(-1)));
  assert.ok(parts[1].startsWith('B'));
  assert.ok(!out.includes('A'.repeat(401)), 'no section may exceed its cap');
});

test('assembleCappedBlock: labeled sections render label on its own line', () => {
  const out = assembleCappedBlock([{ label: '## Plan', text: 'do the thing' }]);
  assert.equal(out, '## Plan\ndo the thing');
});

test('assembleCappedBlock: empty sections are dropped, survivors kept', () => {
  const out = assembleCappedBlock(['', { label: '## Keep', text: 'stays' }, null]);
  assert.equal(out, '## Keep\nstays');
});

test('assembleCappedBlock: long labeled section is still capped', () => {
  const long = 'C'.repeat(5000);
  const out = assembleCappedBlock([{ label: '## Big', text: long }], 300);
  const body = out.split('\n')[1];
  assert.ok(!body.includes('C'.repeat(301)), 'body must not exceed the cap');
  assert.ok(out.includes(TRUNC_MARKER));
});

test('assembleCappedBlock: non-array input throws TypeError', () => {
  assert.throws(() => assembleCappedBlock('nope'), TypeError);
  assert.throws(() => assembleCappedBlock(null), TypeError);
});
