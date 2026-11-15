'use strict';

// Tests for src/review-comment-only.js (2026-10-31): is a unified diff a comment-only change? Real diffs, no mocks.
// Run: node --test src/review-comment-only.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeCommentOnly, familyOf } = require('./review-comment-only.js');

// A one-hunk diff for `file` built from `lines` (each ' x' context, '-x' removed, '+x' added).
function diff(file, lines, { top = false } = {}) {
  const oldN = lines.filter((l) => l[0] !== '+').length;
  const newN = lines.filter((l) => l[0] !== '-').length;
  return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -${top ? 1 : 10},${oldN} +${top ? 1 : 10},${newN} @@\n${lines.join('\n')}\n`;
}
const yes = (d, msg) => { const r = analyzeCommentOnly(d); assert.equal(r.commentOnly, true, `${msg || ''} -> ${r.reason}`); return r; };
const no = (d, msg) => { const r = analyzeCommentOnly(d); assert.equal(r.commentOnly, false, `${msg || ''} (expected NOT comment-only)`); return r; };

// ---- JS / TS ----
test('a JS test edit that only adds // comments (the questforge shape) is comment-only', () => {
  const r = yes(diff('test/schedule.test.js', [
    " test('dueDefs does not mutate the input defs array', () => {",
    '   const defs = makeDefs()',
    '+  // intentional: deep clone for immutability check — not a hot path',
    '   const original = JSON.parse(JSON.stringify(defs))',
    '   dueDefs(defs, day)',
    '   assert.deepEqual(defs, original)',
  ]));
  assert.deepEqual(r.files, [{ path: 'test/schedule.test.js', removed: 0, added: 1 }]);
});

test('adding a trailing comment to a code line, and rewording one, are comment-only', () => {
  yes(diff('src/a.js', [' const a = 1', '-const b = compute(a)', '+const b = compute(a) // why: cached upstream', ' use(b)']));
  yes(diff('src/a.js', ['-const b = compute(a) // old reason', '+const b = compute(a) // the real reason', ' use(b)']));
});

test('removing a comment, and adding or removing blank lines around one, are comment-only', () => {
  yes(diff('src/a.js', [' const a = 1', '-// stale note', '-', ' use(a)']));
  yes(diff('src/a.js', [' const a = 1', '+', '+// new note', '+', ' use(a)']));
});

test('a multi-line block comment added whole (opener inside the hunk) is comment-only', () => {
  yes(diff('src/a.js', [' function f() {', '+  /*', '+   * explains why', '+   * and what',  '+   */', '   return 1', ' }']));
});

test('a reworded block-comment line is comment-only when the opener is in the hunk, and NOT when the opener is OUTSIDE it (cannot be proven)', () => {
  yes(diff('src/a.js', [' /**', '- * Old text of the second line.', '+ * New text of the second line.', '  */']), 'the opener is a context line, so the reword is provable');
  // the opener is not in the hunk at all:
  no(diff('src/a.js', ['   * more detail', '-   * old wording', '+   * new wording', '   */', ' function f() {}']));
});

test('one changed code line next to comment changes is NOT comment-only', () => {
  no(diff('src/a.js', ['-const n = 1', '+const n = 2 // bumped', ' use(n)']));
  no(diff('src/a.js', [' const n = 1', '+// note', '+doSomething()', ' use(n)']));
});

test('a string literal containing // is code, not a comment', () => {
  no(diff('src/a.js', ["-const url = 'http://a.example/x'", "+const url = 'http://b.example/x'"]), 'changed URL string');
  no(diff('src/a.js', [' const a = 1', '+const slashes = "//"', ' use(a)']), 'an added line that is only a string with //');
  yes(diff('src/a.js', ["-const url = 'http://a.example/x'", "+const url = 'http://a.example/x' // pinned"]), 'same string, comment added');
});

test('a template literal that spans lines is code, even when a line in it starts with //', () => {
  no(diff('src/a.js', [' const t = `', '-// old line of the template', '+// new line of the template', ' `']));
});

test('whitespace-only reformatting with no comment involved is NOT comment-only', () => {
  no(diff('src/a.js', ['-const a   =  1', '+const a = 1', ' use(a)']));
});

// ---- Python ----
test('a Python docstring-only edit (def line in view) is comment-only', () => {
  yes(diff('src/m.py', [
    ' def load(path):',
    '-    """Load the file."""',
    '+    """Load the file and return its parsed rows (empty when missing)."""',
    '     return parse(path)',
  ]));
  yes(diff('src/m.py', [' class Store:', '+    """Holds rows."""', '     def __init__(self): pass']));
});

test('a multi-line Python docstring reworded inside a hunk that shows its opener is comment-only', () => {
  yes(diff('src/m.py', [
    ' def load(path):',
    '     """',
    '-    Load the file.',
    '+    Load the file; returns [] when it is missing.',
    '     """',
    '     return parse(path)',
  ]));
});

test('Python # comments are comment-only; changed indentation or code is not', () => {
  yes(diff('src/m.py', [' x = 1', '+# explain x', ' y = 2  # old', ' z = 3']));
  yes(diff('src/m.py', ['-y = 2  # old', '+y = 2  # new']));
  no(diff('src/m.py', ['-    y = 2', '+  y = 2  # reindented']), 'leading indentation is part of the code');
  no(diff('src/m.py', ['-y = 2  # old', '+y = 3  # new']));
});

test('a triple-quoted STRING that is not a docstring is code', () => {
  no(diff('src/m.py', ['-SQL = """select 1"""', '+SQL = """select 2"""']), 'assigned string');
  no(diff('src/m.py', [' run(', '-    """select 1""",', '+    """select 2""",', ' )']), 'a string argument at the start of a line is not after a def');
});

test('a Python docstring edit with no def/class line in the hunk is not provable, so it is NOT comment-only', () => {
  no(diff('src/m.py', ['     """', '-    old', '+    new', '     """']));
});

// ---- other file types, shapes ----
test('# comment edits in shell / yaml / toml are comment-only; ${#var} is code', () => {
  yes(diff('scripts/run.sh', [' echo hi', '+# say hi', ' echo bye']));
  yes(diff('config.yaml', [' a: 1', '+# the b setting', ' b: 2']));
  no(diff('scripts/run.sh', ['-echo ${#name}', '+echo ${#other}']));
  no(diff('scripts/run.sh', ['-url="http://x/#frag"', '+url="http://x/#other"']), 'a # inside a string is not a comment');
});

test('Markdown, unknown file types, new, deleted, renamed and binary files are NOT comment-only', () => {
  no(diff('docs/a.md', [' text', '+<!-- note -->']));
  no(diff('data/x.csv', ['+# looks like a comment']));
  no('diff --git a/src/n.js b/src/n.js\nnew file mode 100644\n--- /dev/null\n+++ b/src/n.js\n@@ -0,0 +1 @@\n+// only a comment\n');
  no('diff --git a/src/o.js b/src/o.js\ndeleted file mode 100644\n--- a/src/o.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-// gone\n');
  no('diff --git a/src/a.js b/src/b.js\nsimilarity index 90%\nrename from src/a.js\nrename to src/b.js\n');
  no('diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n');
});

test('a diff with one comment-only file and one code file is NOT comment-only', () => {
  no(diff('src/a.js', [' a', '+// note']) + diff('src/b.js', ['-b', '+c']));
  yes(diff('src/a.js', [' a', '+// note']) + diff('src/m.py', [' x = 1', '+# note']));
});

test('empty and garbage input are NOT comment-only and never throw', () => {
  for (const bad of ['', '   ', null, undefined, 'not a diff at all', '@@ -1 +1 @@\n-a\n+b\n']) assert.equal(analyzeCommentOnly(bad).commentOnly, false);
});

test('familyOf maps extensions, case-insensitively, and rejects the rest', () => {
  assert.equal(familyOf('a/b.TS'), 'c');
  assert.equal(familyOf('x.py'), 'py');
  assert.equal(familyOf('x.yml'), 'hash');
  assert.equal(familyOf('x.md'), null);
  assert.equal(familyOf('Makefile'), null);
});
