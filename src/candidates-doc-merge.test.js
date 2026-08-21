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
