'use strict';

// Unit tests for mergeCandidatesDoc() -- the structural 3-way merge for
// Docs/*_CANDIDATES.md, built after 9 real observability_review branches all collided on
// the same file (2026-08-21) despite each branch's actual source-code diff being
// conflict-free. See candidates-doc-merge.js's own header comment for the full story.
//
// Run: node --test src/candidates-doc-merge.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeCandidatesDoc } = require('./candidates-doc-merge.js');

function doc(...blocks) {
  return `# Candidates\n\n${blocks.join('\n\n')}\n`;
}

function block(id, title, extra = 'Strength: Strong\nFiles: x.js\n\nProblem: p\n\nSolution: s') {
  return `### AC-${id} · ${title}\n${extra}`;
}

test('two branches independently replacing the SAME slot both survive, theirs renumbered', () => {
  const ancestor = doc(block(1, 'old candidate one'), block(9, 'stale slot'));
  const ours = doc(block(1, 'old candidate one'), block(9, 'ours new fix -- fact-checker'));
  const theirs = doc(block(1, 'old candidate one'), block(9, 'theirs new fix -- grep-codebase-tool'));

  const merged = mergeCandidatesDoc({ ancestorText: ancestor, oursText: ours, theirsText: theirs });

  assert.match(merged, /### AC-9 · ours new fix -- fact-checker/);
  assert.match(merged, /### AC-10 · theirs new fix -- grep-codebase-tool/);
  assert.match(merged, /### AC-1 · old candidate one/);
});

test('nine independently-colliding branches all survive across repeated pairwise merges', () => {
  const ancestor = doc(block(1, 'seed'), block(9, 'stale slot'));
  let current = doc(block(1, 'seed'), block(9, 'branch-0 fix'));

  for (let i = 1; i < 9; i++) {
    const theirs = doc(block(1, 'seed'), block(9, `branch-${i} fix`));
    current = mergeCandidatesDoc({ ancestorText: ancestor, oursText: current, theirsText: theirs });
    assert.ok(current, `merge ${i} produced a result`);
  }

  for (let i = 0; i < 9; i++) {
    assert.match(current, new RegExp(`branch-${i} fix`), `branch-${i}'s candidate survived`);
  }
});

test('a slot theirs never touched is left exactly as ours has it', () => {
  const ancestor = doc(block(1, 'a'), block(2, 'b'));
  const ours = doc(block(1, 'a'), block(2, 'b changed by ours'));
  const theirs = doc(block(1, 'a'), block(2, 'b'));

  const merged = mergeCandidatesDoc({ ancestorText: ancestor, oursText: ours, theirsText: theirs });
  assert.match(merged, /b changed by ours/);
});

test('a slot ours never touched picks up theirs\' edit', () => {
  const ancestor = doc(block(1, 'a'), block(2, 'b'));
  const ours = doc(block(1, 'a'), block(2, 'b'));
  const theirs = doc(block(1, 'a'), block(2, 'b changed by theirs'));

  const merged = mergeCandidatesDoc({ ancestorText: ancestor, oursText: ours, theirsText: theirs });
  assert.match(merged, /b changed by theirs/);
});

test('identical edits on both sides do not duplicate', () => {
  const ancestor = doc(block(1, 'a'));
  const ours = doc(block(1, 'a changed'));
  const theirs = doc(block(1, 'a changed'));

  const merged = mergeCandidatesDoc({ ancestorText: ancestor, oursText: ours, theirsText: theirs });
  const occurrences = (merged.match(/### AC-1/g) || []).length;
  assert.equal(occurrences, 1);
});

test('a brand-new slot only theirs added (past both sides\' known max) is kept, not renumbered away', () => {
  const ancestor = doc(block(1, 'a'));
  const ours = doc(block(1, 'a'));
  const theirs = doc(block(1, 'a'), block(2, 'brand new from theirs'));

  const merged = mergeCandidatesDoc({ ancestorText: ancestor, oursText: ours, theirsText: theirs });
  assert.match(merged, /### AC-2 · brand new from theirs/);
});

test('returns null (declines to resolve) when the input has no AC-N headings at all', () => {
  const merged = mergeCandidatesDoc({
    ancestorText: 'not a candidates doc',
    oursText: 'still not one',
    theirsText: 'nope',
  });
  assert.equal(merged, null);
});

test('output stays parseable by the same AC-N heading convention apply-group-a.js reads', () => {
  const ancestor = doc(block(1, 'a'), block(9, 'stale'));
  const ours = doc(block(1, 'a'), block(9, 'ours fix'));
  const theirs = doc(block(1, 'a'), block(9, 'theirs fix'));

  const merged = mergeCandidatesDoc({ ancestorText: ancestor, oursText: ours, theirsText: theirs });
  const headings = merged.match(/^### AC-\d+ · .+$/gm);
  assert.equal(headings.length, 3);
});

// 2026-10-07 (TaxHarvest): the driver ignored DELETIONS, so a candidate retracted on main (AC-262..265) survived every merge of main into the rolling
// triage branch. A block the ancestor had, theirs removed and ours never touched is now dropped.
test('a block theirs deleted and ours left alone is dropped (the retraction propagates)', () => {
  const ancestor = doc(block(1, 'keep me'), block(2, 'retract me'), block(3, 'also keep'));
  const ours = doc(block(1, 'keep me'), block(2, 'retract me'), block(3, 'also keep'), block(10, 'branch-only new candidate'));
  const theirs = doc(block(1, 'keep me'), block(3, 'also keep'));

  const merged = mergeCandidatesDoc({ ancestorText: ancestor, oursText: ours, theirsText: theirs });

  assert.doesNotMatch(merged, /AC-2 ·/, 'the retracted block is gone');
  assert.match(merged, /### AC-1 · keep me/);
  assert.match(merged, /### AC-3 · also keep/);
  assert.match(merged, /### AC-10 · branch-only new candidate/, 'a block only the branch has is untouched');
  assert.doesNotMatch(merged, /undefined/);
  assert.equal(merged, doc(block(1, 'keep me'), block(3, 'also keep'), block(10, 'branch-only new candidate')), 'exactly the surviving blocks, no stray gap where the retracted one was');
});

test('a block ours EDITED is kept even though theirs deleted it (never silently drop changed content)', () => {
  const ancestor = doc(block(1, 'seed'), block(2, 'retract me'));
  const ours = doc(block(1, 'seed'), block(2, 'retract me', 'Strength: Strong\nFiles: x.js\n\nProblem: ours reworked this'));
  const theirs = doc(block(1, 'seed'));
  const merged = mergeCandidatesDoc({ ancestorText: ancestor, oursText: ours, theirsText: theirs });
  assert.match(merged, /### AC-2 · retract me/);
  assert.match(merged, /ours reworked this/);
});

test('a block both sides deleted stays deleted, and a block only ours deleted is not resurrected', () => {
  const ancestor = doc(block(1, 'seed'), block(2, 'both delete'), block(3, 'ours deletes'));
  const ours = doc(block(1, 'seed'));
  const theirs = doc(block(1, 'seed'), block(3, 'ours deletes'));
  const merged = mergeCandidatesDoc({ ancestorText: ancestor, oursText: ours, theirsText: theirs });
  assert.doesNotMatch(merged, /AC-2 ·/);
  assert.doesNotMatch(merged, /AC-3 ·/, 'theirs did not touch AC-3, so ours deleting it stands');
});

test('an empty or non-candidate theirs is NOT read as "everything was retracted"', () => {
  const ancestor = doc(block(1, 'seed'), block(2, 'second'));
  const ours = doc(block(1, 'seed'), block(2, 'second'), block(3, 'new'));
  const merged = mergeCandidatesDoc({ ancestorText: ancestor, oursText: ours, theirsText: '# Candidates\n\nnothing here\n' });
  assert.match(merged, /### AC-1 · seed/);
  assert.match(merged, /### AC-2 · second/);
  assert.match(merged, /### AC-3 · new/);
});

test('a deletion on theirs does not disturb a same-slot collision elsewhere in the same merge', () => {
  const ancestor = doc(block(1, 'seed'), block(2, 'retract me'), block(9, 'stale slot'));
  const ours = doc(block(1, 'seed'), block(2, 'retract me'), block(9, 'ours new fix'));
  const theirs = doc(block(1, 'seed'), block(9, 'theirs new fix'));
  const merged = mergeCandidatesDoc({ ancestorText: ancestor, oursText: ours, theirsText: theirs });
  assert.doesNotMatch(merged, /AC-2 ·/);
  assert.match(merged, /### AC-9 · ours new fix/);
  assert.match(merged, /### AC-\d+ · theirs new fix/);
});
