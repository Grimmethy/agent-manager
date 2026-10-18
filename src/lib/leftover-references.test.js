'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  findLeftoverReferences, checkLeftoverReferences, leftoverRefMode, makeGrepBase, splitDiffByFile,
} = require('./leftover-references.js');

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' });

// A real temp repo: `base` files committed, then `draft(dir)` edits the tree and the staged diff is what the draft gate sees.
function scenario(base, draft) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leftover-refs-'));
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 't@t'], dir);
  git(['config', 'user.name', 't'], dir);
  const write = (f, c) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); };
  for (const [f, c] of Object.entries(base)) write(f, c);
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'base'], dir);
  draft({ write, remove: (f) => fs.rmSync(path.join(dir, f)), dir });
  git(['add', '-A'], dir);
  const diff = git(['diff', '--cached', '--full-index', '--binary'], dir);
  const grepBase = makeGrepBase((a, cwd) => git(a, cwd), dir);
  return { diff, grepBase, dir };
}
const run = (base, draft, extra = {}) => { const s = scenario(base, draft); return { ...s, leftovers: findLeftoverReferences({ diff: s.diff, grepBase: s.grepBase, ...extra }) }; };

// ---- the shapes that actually reached review --------------------------------------------------------------------

test('ac-46/47 shape: destructured constants removed but a use left behind in the same file is flagged', () => {
  const { leftovers } = run(
    { 'src/agent-task-db.js': [
      "const { AGENT_TASK_STATUSES } = require('./statuses');",
      'const [',
      '  STATUS_PENDING,',
      '  STATUS_REVIEW,',
      '] = AGENT_TASK_STATUSES;',
      'function claim(prev) {',
      '  if (prev.status !== STATUS_PENDING) return false;',
      '  return true;',
      '}', ''].join('\n') },
    ({ write }) => write('src/agent-task-db.js', [
      "const { AGENT_TASK_STATUSES, STATUS } = require('./statuses');",
      'function claim(prev) {',
      '  if (prev.status !== STATUS_PENDING) return false;',
      '  return true;',
      '}', ''].join('\n')),
  );
  assert.deepEqual(leftovers.map((l) => [l.name, l.scope]), [['STATUS_PENDING', 'same-file']]);
  assert.match(leftovers[0].refs[0].text, /prev\.status !== STATUS_PENDING/);
  assert.equal(leftovers[0].refs[0].file, 'src/agent-task-db.js');
});

test('ac-262 shape: a renamed Python keyword parameter still passed by name at callers is flagged', () => {
  const { leftovers } = run(
    {
      'worker/worker_db.py': 'def write_updates(conn, pid, updates, coord_only=False):\n    return coord_only\n',
      'worker/backfill_unit_range.py': 'import worker_db\nworker_db.write_updates(conn, pid, updates, coord_only=False)\n',
      'worker/worker_control.py': 'db.write_updates(conn, pid, u, coord_only=True)\n',
    },
    ({ write }) => write('worker/worker_db.py', 'def write_updates(conn, pid, updates, touch_enrichment_timestamp=True):\n    return touch_enrichment_timestamp\n'),
  );
  assert.equal(leftovers.length, 1);
  assert.equal(leftovers[0].name, 'coord_only');
  assert.equal(leftovers[0].scope, 'kwarg');
  assert.deepEqual(leftovers[0].refs.map((r) => r.file).sort(), ['worker/backfill_unit_range.py', 'worker/worker_control.py']);
});

test('ac-271 shape: a removed Python import whose name is still used is flagged', () => {
  const { leftovers } = run(
    { 'cadastral/image.py': 'from cadastral_utils import (\n    helper_alpha,\n    DEFAULT_TAX_YEAR,\n)\nyear = DEFAULT_TAX_YEAR\n' },
    ({ write }) => write('cadastral/image.py', 'from cadastral_utils import helper_alpha\nyear = DEFAULT_TAX_YEAR\n'),
  );
  assert.deepEqual(leftovers.map((l) => l.name), ['DEFAULT_TAX_YEAR']);
});

// ---- negatives: no false alarm ----------------------------------------------------------------------------------

test('a rename that updates every use is clean', () => {
  const { leftovers } = run(
    { 'a.js': 'function oldHelper(x) { return x; }\nmodule.exports = { oldHelper };\nconst y = oldHelper(1);\n' },
    ({ write }) => write('a.js', 'function newHelper(x) { return x; }\nmodule.exports = { newHelper };\nconst y = newHelper(1);\n'),
  );
  assert.deepEqual(leftovers, []);
});

test('a name that is declared again (moved) by the diff is not a removal', () => {
  const { leftovers } = run(
    { 'a.js': 'function sharedHelper() { return 1; }\nmodule.exports = { sharedHelper };\n', 'b.js': "const { sharedHelper } = require('./a');\nsharedHelper();\n" },
    ({ write }) => { write('a.js', "module.exports = { sharedHelper: require('./c').sharedHelper };\n"); write('c.js', 'function sharedHelper() { return 1; }\nexports.sharedHelper = sharedHelper;\n'); },
  );
  assert.deepEqual(leftovers, []);
});

test('comment-only mentions, docs files and short names are not references', () => {
  const { leftovers } = run(
    { 'a.js': 'function legacyThing() { return 1; }\nfunction ab() {}\nab();\n', 'b.js': '// legacyThing used to live here\n', 'docs/n.md': 'call legacyThing() to start\n' },
    ({ write }) => write('a.js', 'function other() { return 1; }\n'),
  );
  assert.deepEqual(leftovers, []);
});

test('narrow scope: an unexported name of the same spelling in ANOTHER file is not flagged; an exported one is', () => {
  const base = {
    'a.js': 'function parseRow(r) { return r; }\nparseRow(1);\n',
    'b.js': 'function parseRow(r) { return r + 1; }\nparseRow(2);\n',
  };
  const { leftovers } = run(base, ({ write }) => write('a.js', 'function other(r) { return r; }\nother(1);\n'));
  assert.deepEqual(leftovers, [], 'b.js declares its own parseRow');

  const exported = run(
    { 'a.js': 'function parseRow(r) { return r; }\nmodule.exports = { parseRow };\nexports.parseRow = parseRow;\n', 'c.js': "const m = require('./a');\nm.parseRow(3);\n" },
    ({ write }) => write('a.js', 'function other(r) { return r; }\nmodule.exports = { other };\n'),
  );
  assert.deepEqual(exported.leftovers.map((l) => [l.name, l.scope, l.refs[0].file]), [['parseRow', 'cross-file', 'c.js']]);
});

test('short and generic names are ignored even when a use is left behind', () => {
  const short = run({ 'a.js': 'function ab() {}\nab();\n' }, ({ write }) => write('a.js', 'ab();\n'));
  assert.deepEqual(short.leftovers, [], 'two-letter name');
  const generic = run({ 'a.js': 'const status = 1;\nuse(status);\n' }, ({ write }) => write('a.js', 'use(status);\n'));
  assert.deepEqual(generic.leftovers, [], 'generic word on the stoplist');
  const real = run({ 'a.js': 'const statusMap = 1;\nuse(statusMap);\n' }, ({ write }) => write('a.js', 'use(statusMap);\n'));
  assert.deepEqual(real.leftovers.map((l) => l.name), ['statusMap'], 'the same shape with a real name IS flagged');
});

test('a mention in a comment line left behind does not count as a reference', () => {
  const { leftovers } = run(
    { 'a.js': 'function legacyThing() { return 1; }\n// legacyThing is gone\n# legacyThing too\n' },
    ({ write }) => write('a.js', '// legacyThing is gone\n# legacyThing too\n'),
  );
  assert.deepEqual(leftovers, []);
});

test('an exported name removed from one file: a file that declares its own copy is not flagged, a real importer is', () => {
  const { leftovers } = run(
    {
      'a.js': 'function parseRow(r) { return r; }\nmodule.exports = { parseRow };\nexports.parseRow = parseRow;\n',
      'b.js': 'function parseRow(r) { return r + 1; }\nparseRow(2);\n',
      'c.js': "const m = require('./a');\nm.parseRow(3);\n",
    },
    ({ write }) => write('a.js', 'function other(r) { return r; }\nmodule.exports = { other };\n'),
  );
  assert.deepEqual(leftovers.map((l) => l.refs.map((r) => r.file)), [['c.js']]);
});

test('a use the diff itself ADDS for a name it removed is a leftover', () => {
  const { leftovers } = run(
    { 'a.js': 'function oldFn() { return 1; }\nmodule.exports = { oldFn };\n' },
    ({ write }) => write('a.js', 'const z = oldFn();\nmodule.exports = { z };\n'),
  );
  assert.equal(leftovers.length, 1);
  assert.equal(leftovers[0].refs[0].fromDiff, true);
  assert.match(leftovers[0].refs[0].text, /oldFn\(\)/);
});

// Replay over 213 merged TaxHarvest diffs (2026-10-07) produced six false alarms; each is pinned here.
test('a Python local assignment of the same spelling is not a keyword-argument use', () => {
  const { leftovers } = run(
    {
      'svc/worker_db.py': 'def write_updates(conn, pid, updates, coord_only=False):\n    return coord_only\n',
      'svc/mt.py': 'coord_only = bool(options.get("coord_only") or False)\n',
    },
    ({ write }) => write('svc/worker_db.py', 'def write_updates(conn, pid, updates, touch_enrichment_timestamp=True):\n    return touch_enrichment_timestamp\n'),
  );
  assert.deepEqual(leftovers, []);
  const otherCallee = run(
    { 'svc/worker_db.py': 'def write_updates(conn, coord_only=False):\n    pass\n', 'svc/mt.py': 'settings = _Settings(tax_year=y, coord_only=coord_only)\n' },
    ({ write }) => write('svc/worker_db.py', 'def write_updates(conn, touch_enrichment_timestamp=True):\n    pass\n'),
  );
  assert.deepEqual(otherCallee.leftovers, [], 'another function with a parameter of the same spelling');
  const sameLineAssignment = run(
    { 'svc/worker_db.py': 'def write_updates(conn, coord_only=False):\n    pass\n', 'svc/mt.py': 'write_updates(conn); coord_only = True\n' },
    ({ write }) => write('svc/worker_db.py', 'def write_updates(conn, touch_enrichment_timestamp=True):\n    pass\n'),
  );
  assert.deepEqual(sameLineAssignment.leftovers, [], 'the callee is on the line but the spelling is an assignment, not a keyword argument');
  const sameCallee = run(
    { 'svc/worker_db.py': 'def write_updates(conn, coord_only=False):\n    pass\n', 'svc/caller.py': 'db.write_updates(conn, coord_only=True)\n' },
    ({ write }) => write('svc/worker_db.py', 'def write_updates(conn, touch_enrichment_timestamp=True):\n    pass\n'),
  );
  assert.deepEqual(sameCallee.leftovers.map((l) => l.name), ['coord_only']);
});

test('locals declared inside a removed function body are not names the diff removed', () => {
  const { leftovers } = run(
    { 'q.js': [
      'function moveTask(a) {',
      '  const tempPath = a + ".tmp";',
      '  return tempPath;',
      '}',
      'function atomicCreate(tempPath, destPath) {',
      '  return tempPath + destPath;',
      '}', ''].join('\n') },
    ({ write }) => write('q.js', 'function atomicCreate(tempPath, destPath) {\n  return tempPath + destPath;\n}\n'),
  );
  assert.deepEqual(leftovers, []);
});

test('committed minified bundles and build output never count as references', () => {
  const longLine = `var x=1;${'a=1;'.repeat(200)}exportedThing();`;
  const { leftovers } = run(
    { 'src/a.js': 'function exportedThing() {}\nmodule.exports = { exportedThing };\n', 'frontend/build/assets/index.js': 'exportedThing();\n', 'bundle.js': longLine + '\n' },
    ({ write }) => write('src/a.js', 'function other() {}\nmodule.exports = { other };\n'),
  );
  assert.deepEqual(leftovers, []);
});

test('a property read `obj.name` is not a use of a removed plain binding, but IS a use of a removed export', () => {
  const plain = run(
    { 'r.js': 'const stateCode = 1;\nconst st = prop.county.stateCode;\n' },
    ({ write }) => write('r.js', 'const st = prop.county.stateCode;\n'),
  );
  assert.deepEqual(plain.leftovers, []);
  const exported = run(
    { 'a.js': 'function parseRow() {}\nmodule.exports = { parseRow };\n', 'c.js': "require('./a').parseRow();\n" },
    ({ write }) => write('a.js', 'function other() {}\nmodule.exports = { other };\n'),
  );
  assert.deepEqual(exported.leftovers.map((l) => l.name), ['parseRow']);
});

test('a use in a different file of a NON-exported removed name is left to review', () => {
  const { leftovers } = run(
    { 'a.js': 'function localOnly() { return 1; }\nlocalOnly();\n', 'b.js': 'const x = localOnly;\n' },
    ({ write }) => write('a.js', 'function other() { return 1; }\nother();\n'),
  );
  assert.deepEqual(leftovers, []);
});

test('deleting a whole file is not this gate (the dead-code gate checks importers)', () => {
  const { leftovers } = run(
    { 'ui/form.tsx': 'export function FormRoot() {}\n', 'x.ts': 'const a = FormRoot;\n' },
    ({ remove }) => remove('ui/form.tsx'),
  );
  assert.deepEqual(leftovers, []);
});

test('a still-present declaration in the file means nothing was removed', () => {
  const { leftovers } = run(
    { 'a.js': 'const itemCache = new Map();\nfunction itemCache2() {}\nconst itemCache = 1;\n' },
    ({ write }) => write('a.js', 'const itemCache = new Map();\nfunction itemCache2() {}\n'),
  );
  assert.deepEqual(leftovers, []);
});

test('git grep failing or timing out reads as "no references", never a leftover', () => {
  const s = scenario({ 'a.js': 'function gone() {}\ngone();\n' }, ({ write }) => write('a.js', 'function other() {}\n'));
  const broken = makeGrepBase(() => { throw new Error('timed out'); }, s.dir);
  assert.deepEqual(findLeftoverReferences({ diff: s.diff, grepBase: broken }), []);
  assert.deepEqual(findLeftoverReferences({ diff: s.diff, grepBase: null }), []);
  assert.deepEqual(findLeftoverReferences({ diff: '', grepBase: s.grepBase }), []);
});

// ---- the policy wrapper -----------------------------------------------------------------------------------------

const leftoverScenario = () => scenario(
  { 'a.js': 'const [STATUS_PENDING] = LIST;\nuse(STATUS_PENDING);\n' },
  ({ write }) => write('a.js', 'const [STATUS] = LIST;\nuse(STATUS_PENDING);\n'),
);

test('block mode returns feedback naming the name, file and line; advisory and off never block', () => {
  const s = leftoverScenario();
  const blocked = checkLeftoverReferences({ diff: s.diff, grepBase: s.grepBase, mode: 'block' });
  assert.equal(blocked.action, 'block');
  assert.deepEqual(blocked.names, ['STATUS_PENDING']);
  assert.match(blocked.retryFeedback, /STATUS_PENDING/);
  assert.match(blocked.retryFeedback, /a\.js:2/);
  assert.match(blocked.reason, /still referenced/);
  assert.equal(checkLeftoverReferences({ diff: s.diff, grepBase: s.grepBase, mode: 'advisory' }).action, 'advisory');
  assert.equal(checkLeftoverReferences({ diff: s.diff, grepBase: s.grepBase, mode: 'off' }).action, 'none');
});

test('the same names blocked twice in a row downgrade to an advisory so the task is never stranded', () => {
  const s = leftoverScenario();
  assert.equal(checkLeftoverReferences({ diff: s.diff, grepBase: s.grepBase, mode: 'block', priorNames: ['STATUS_PENDING'] }).action, 'advisory');
  assert.equal(checkLeftoverReferences({ diff: s.diff, grepBase: s.grepBase, mode: 'block', priorNames: ['SOMETHING_ELSE'] }).action, 'block', 'a different set blocks again');
  const adv = checkLeftoverReferences({ diff: s.diff, grepBase: s.grepBase, mode: 'block', priorNames: ['STATUS_PENDING'] });
  assert.match(adv.advisoryText, /not blocking again/);
});

test('a clean diff is action none', () => {
  const s = scenario({ 'a.js': 'function keep() {}\n' }, ({ write }) => write('a.js', 'function keep() { return 1; }\n'));
  assert.equal(checkLeftoverReferences({ diff: s.diff, grepBase: s.grepBase, mode: 'block' }).action, 'none');
});

test('leftoverRefMode defaults to block and only accepts advisory/off', () => {
  assert.equal(leftoverRefMode({}), 'block');
  assert.equal(leftoverRefMode({ AGENT_MANAGER_LEFTOVER_REF_MODE: 'Advisory' }), 'advisory');
  assert.equal(leftoverRefMode({ AGENT_MANAGER_LEFTOVER_REF_MODE: 'off' }), 'off');
  assert.equal(leftoverRefMode({ AGENT_MANAGER_LEFTOVER_REF_MODE: 'garbage' }), 'block');
});

test('splitDiffByFile separates removed and added lines per file and skips headers', () => {
  const m = splitDiffByFile('diff --git a/x.js b/x.js\nindex 1..2 100644\n--- a/x.js\n+++ b/x.js\n@@ -1,2 +1,2 @@\n-old\n+new\n same\n');
  assert.deepEqual(m.get('x.js').removed, ['old']);
  assert.deepEqual(m.get('x.js').added, ['new']);
});
