'use strict';

// Tests for review-undefined-after-removal.js (brain dump #1768). Run: node --test src/review-undefined-after-removal.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { findUndefinedAfterRemoval, removedDeclarations, boundNames, usesOf, stripNonCode, applyHunks, changesFromDiff, changesFromEdits } = require('./review-undefined-after-removal.js');

// The shape of TaxHarvest arch-review-ac-46: a positional destructuring is replaced by a keyed object, and one use survives on a line no edit touched.
const BASE = [
  "const { AGENT_TASK_STATUSES } = require('./agent-task-statuses');",
  'const [STATUS_PENDING, STATUS_DRAFTING] = AGENT_TASK_STATUSES;',
  '',
  'function create(id) {',
  '  return { id, status: STATUS_PENDING };',
  '}',
  '',
  'function claim(prev) {',
  '  if (prev.status && prev.status !== STATUS_PENDING) {',
  '    return STATUS_DRAFTING;',
  '  }',
  '  return null;',
  '}',
  '',
].join('\n');
const read = (map) => (file) => (Object.prototype.hasOwnProperty.call(map, file) ? map[file] : null);
const find = (args, files = { 'src/db.js': BASE }) => findUndefinedAfterRemoval({ readBase: read(files), ...args });
const names = (r) => r.uses.map((u) => u.name);

const INCIDENT_EDITS = [
  { mode: 'edit', file: 'src/db.js', find: "const { AGENT_TASK_STATUSES } = require('./agent-task-statuses');\nconst [STATUS_PENDING, STATUS_DRAFTING] = AGENT_TASK_STATUSES;", replace: "const { STATUS } = require('./agent-task-statuses');" },
  { mode: 'edit', file: 'src/db.js', find: 'status: STATUS_PENDING };', replace: 'status: STATUS.pending };' },
  { mode: 'edit', file: 'src/db.js', find: 'return STATUS_DRAFTING;', replace: 'return STATUS.drafting;' },
];

test('the incident as an edit array: the use on a line no edit touched is reported with its identifier and line number', () => {
  const r = find({ edits: INCIDENT_EDITS });
  assert.deepEqual(names(r), ['STATUS_PENDING']);
  assert.equal(r.uses[0].file, 'src/db.js');
  assert.equal(r.uses[0].lines.length, 1);
  assert.equal(r.uses[0].lines[0].line, 8);                       // BASE line 9; the post-change file is one line shorter (two lines became one) -> line 8 of the new file
  assert.match(r.uses[0].lines[0].text, /prev\.status !== STATUS_PENDING/);
  assert.equal(r.unknown, 0);
});

test('the same incident as a unified diff gives the same answer', () => {
  const diff = [
    'diff --git a/src/db.js b/src/db.js', '--- a/src/db.js', '+++ b/src/db.js', '@@ -1,6 +1,5 @@',
    "-const { AGENT_TASK_STATUSES } = require('./agent-task-statuses');", '-const [STATUS_PENDING, STATUS_DRAFTING] = AGENT_TASK_STATUSES;', "+const { STATUS } = require('./agent-task-statuses');", ' ', ' function create(id) {',
    '-  return { id, status: STATUS_PENDING };', '+  return { id, status: STATUS.pending };', ' }', '',
    '@@ -8,4 +7,4 @@', ' function claim(prev) {', '   if (prev.status && prev.status !== STATUS_PENDING) {', '-    return STATUS_DRAFTING;', '+    return STATUS.drafting;', '   }', '',
  ].join('\n');
  const r = find({ rawDiff: diff });
  assert.deepEqual(names(r), ['STATUS_PENDING']);
  assert.equal(r.uses[0].lines[0].line, 8);
});

test('a complete rename leaves nothing behind', () => {
  const edits = [...INCIDENT_EDITS, { mode: 'edit', file: 'src/db.js', find: 'prev.status !== STATUS_PENDING', replace: 'prev.status !== STATUS.pending' }];
  const r = find({ edits });
  assert.deepEqual(r.uses, []);
  assert.equal(r.considered, 3);                                   // AGENT_TASK_STATUSES, STATUS_PENDING, STATUS_DRAFTING lose their declaration; none is used any more
});

test('a declaration moved to another file of the same change is not reported (browser-global scripts keep calling it)', () => {
  const files = { 'static/a.js': 'function renderRow(r) { return r; }\nrenderRow(1);\n' };
  const edits = [
    { mode: 'edit', file: 'static/a.js', find: 'function renderRow(r) { return r; }\n', replace: '' },
    { mode: 'create', file: 'static/b.js', content: 'function renderRow(r) { return r; }\n' },
  ];
  assert.deepEqual(find({ edits }, files).uses, []);                // declared again by text the change adds elsewhere: a move, not a removal
  assert.deepEqual(names(find({ edits: [edits[0]] }, files)), ['renderRow']);   // the same removal with no new declaration anywhere is reported
  const inFile = [{ mode: 'edit', file: 'src/db.js', find: 'const [STATUS_PENDING, STATUS_DRAFTING] = AGENT_TASK_STATUSES;', replace: "const { STATUS_PENDING, STATUS_DRAFTING } = require('./statuses');" }];
  assert.deepEqual(find({ edits: inFile }).uses, []);               // re-declared by the replacement in the same file
});

test('a name the file still declares somewhere (an inner scope or a parameter) is skipped', () => {
  const base = 'const total = 1;\nfunction f(items) {\n  return items.map((total) => total + 1);\n}\nconsole.log(total);\n';
  const r = find({ edits: [{ mode: 'edit', file: 'src/a.js', find: 'const total = 1;\n', replace: '' }] }, { 'src/a.js': base });
  assert.deepEqual(r.uses, []);                                     // `total` is also an arrow parameter in the file: ambiguous scope, never reported
  const base2 = 'const total = 1;\nfunction g() { return total; }\n';
  assert.deepEqual(names(find({ edits: [{ mode: 'edit', file: 'src/a.js', find: 'const total = 1;\n', replace: '' }] }, { 'src/a.js': base2 })), ['total']);
});

test('mentions in comments and strings, member accesses and object keys are not uses', () => {
  const base = "const label = 'x';\n// label is documented here\nconst msg = 'the label is red';\nconst o = { label: 1 };\nconst p = other.label;\nconst q = `${label}`;\n";
  const r = find({ edits: [{ mode: 'edit', file: 'src/a.js', find: "const label = 'x';\n", replace: '' }] }, { 'src/a.js': base });
  assert.deepEqual(r.uses.map((u) => u.lines.map((l) => l.line)), [[5]]);        // only the template-literal expression `${label}` is real code (post-change line 5)
  const none = find({ edits: [{ mode: 'edit', file: 'src/a.js', find: "const label = 'x';\n", replace: '' }] }, { 'src/a.js': "const label = 'x';\n// label\nconst m = 'label';\nconst o = { label: 1 };\nconst p = other.label;\n" });
  assert.deepEqual(none.uses, []);
});

test('a spread of the removed name is a use', () => {
  const r = find({ edits: [{ mode: 'edit', file: 'src/a.js', find: 'const base = {};\n', replace: '' }] }, { 'src/a.js': 'const base = {};\nconst merged = { ...base, a: 1 };\n' });
  assert.deepEqual(names(r), ['base']);
});

test('globals are never reported, and neither is a name the file only uses as a property', () => {
  const r = find({ edits: [{ mode: 'edit', file: 'src/a.js', find: "const { URL } = require('url');\n", replace: '' }] }, { 'src/a.js': "const { URL } = require('url');\nconst u = new URL('http://x');\n" });
  assert.deepEqual(r.uses, []);
});

test('non-JS files are ignored and an unreadable base counts as unknown, never as a finding', () => {
  const py = find({ edits: [{ mode: 'edit', file: 'tool.py', find: 'const total = 1;', replace: '' }] }, { 'tool.py': 'const total = 1;\nprint(total)\n' });
  assert.deepEqual([py.considered, py.uses.length], [0, 0]);
  const missing = find({ edits: [{ mode: 'edit', file: 'src/gone.js', find: 'const total = 1;', replace: '' }] }, {});
  assert.deepEqual([missing.uses.length, missing.unknown], [0, 1]);
  const nomatch = find({ edits: [{ mode: 'edit', file: 'src/a.js', find: 'const total = 2;', replace: '' }] }, { 'src/a.js': 'const total = 1;\nuse(total);\n' });
  assert.deepEqual([nomatch.uses.length, nomatch.unknown], [0, 1]);   // the find text is not in the base: nothing can be said
});

test('a deleted file and a brand-new file are handled without reporting the file own declarations', () => {
  const del = find({ edits: [{ mode: 'delete', file: 'src/db.js' }] });
  assert.deepEqual([del.considered, del.uses.length], [0, 0]);
  const created = find({ edits: [{ mode: 'create', file: 'src/new.js', content: 'const a = 1;\nmodule.exports = { a };\n' }] }, {});
  assert.deepEqual(created.uses, []);
});

test('never throws on junk input', () => {
  for (const args of [undefined, {}, { rawDiff: 5 }, { edits: 'x' }, { edits: [null, 7, {}] }, { rawDiff: 'diff --git a/x.js b/x.js\n@@ garbage' }]) {
    const r = findUndefinedAfterRemoval(args);
    assert.ok(Array.isArray(r.uses));
  }
  const exploding = findUndefinedAfterRemoval({ edits: INCIDENT_EDITS, readBase: () => { throw new Error('git blew up'); } });
  assert.deepEqual([exploding.uses.length, exploding.unknown], [0, 1]);
});

test('removedDeclarations reads variables, destructuring, functions, classes and imports, and ignores code inside strings and comments', () => {
  const text = [
    'const aa = 1; let bb = 2; var cc;', 'const { dd, ee: ff, gg = 3, ...hh } = obj;', 'const [ii, , jj, ...kk] = arr;', 'async function ll() {}', 'function* mm() {}', 'class Nn {}',
    "import oo from 'x';", "import pp, { qq as rr } from 'y';", "import { ss } from 'z';", "import * as tt from 'w';", '// const hidden = 1;', "const text = 'const inString = 1';", 'const x = 1;',
  ].join('\n');
  assert.deepEqual([...removedDeclarations(text)].sort(), ['Nn', 'aa', 'bb', 'cc', 'dd', 'ff', 'gg', 'hh', 'ii', 'jj', 'kk', 'll', 'mm', 'oo', 'pp', 'rr', 'ss', 'text', 'tt']);   // one-letter names are not reported (noise)
});

test('boundNames adds parameters and catch bindings, and does not treat an if() condition as a parameter list', () => {
  const b = boundNames('function f(alpha, beta = 1) {}\nconst g = (gamma) => gamma;\nconst h = delta => delta;\ntry {} catch (epsilon) {}\nif (zeta) {\n}\nwhile (eta) {\n}\n');
  for (const nm of ['alpha', 'beta', 'gamma', 'delta', 'epsilon']) assert.ok(b.has(nm), nm);
  assert.equal(b.has('zeta'), false);
  assert.equal(b.has('eta'), false);
});

test('stripNonCode keeps line numbers and template expressions, and blanks comments and string contents', () => {
  const src = "a = 'x y';\n/* c1\nc2 */ b = `t ${inner + `n ${deep}`} u`;\n// tail\nc = 1;";
  const out = stripNonCode(src);
  assert.equal(out.split('\n').length, src.split('\n').length);
  assert.doesNotMatch(out, /x y|c1|c2|tail/);
  assert.match(out, /inner/);
  assert.match(out, /deep/);
});

test('a regex literal is not code (its words are not uses) and a division is not mistaken for one', () => {
  const out = stripNonCode("const r = /filed 1 item(s) to \\/x\\/[/]/g;\nconst q = a / filed / b;\nreturn /filed/;\n");   // (a regex right after a ')' is read as a division: a known, rare gap)
  const lines = out.split('\n');
  assert.doesNotMatch(lines[0], /filed|item/);
  assert.match(lines[1], /a \/ filed \/ b/);                       // division: kept as code
  assert.doesNotMatch(lines[2], /filed/);
  const r = find({ edits: [{ mode: 'edit', file: 'src/a.js', find: 'const filed = 1;\n', replace: '' }] }, { 'src/a.js': 'const filed = 1;\nassert.match(reason, /routed 1 item, filed 1/);\n' });
  assert.deepEqual(r.uses, []);
});

test('applyHunks refuses a diff whose context does not match the base', () => {
  const good = changesFromDiff('diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n')[0].hunks;
  assert.equal(applyHunks('one\ntwo\n', good), 'one\nTWO\n');
  assert.equal(applyHunks('uno\ntwo\n', good), null);
  const ins = changesFromDiff('diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1,0 +2,1 @@\n+mid\n')[0].hunks;
  assert.equal(applyHunks('one\ntwo\n', ins), 'one\nmid\ntwo\n');
});

test('changesFromEdits groups ops per file in order and keeps create/delete apart', () => {
  const c = changesFromEdits([{ mode: 'edit', file: 'a.js', find: 'x', replace: 'y' }, { mode: 'edit', file: 'a.js', find: 'y', replace: 'z' }, { mode: 'create', file: 'b.js', content: 'q' }, { mode: 'delete', file: 'c.js' }]);
  assert.deepEqual(c.map((x) => [x.file, x.edits.length, x.isNew, x.isDeleted]), [['a.js', 2, false, false], ['b.js', 0, true, false], ['c.js', 0, false, true]]);
});

test('usesOf reports each line once and only real uses', () => {
  const post = 'const x = f(name, name);\nobj.name = 1;\nreturn { name: 1 };\nreturn { name };\n';
  assert.deepEqual(usesOf(post, 'name').map((u) => u.line), [1, 4]);
});
