'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { auditFile, auditFiles } = require('./batch-write-bypass-audit');

// Site is line 6; its loop header is line 3. Lines 5-6 alone look bypass-free.
const LOOP_FILE = [
  'async function importAll(db, rows) {',
  '  const log = [];',
  '  for (const row of rows) {',
  '    log.push(row.id);',
  '    if (!row.id) continue;',
  '    await db.insert(row);',
  '  }',
  '  return log;',
  '}',
].join('\n');

const SINGLE = ['async function saveOne(db, row) {', '  await db.insert(row);', '}'].join('\n');

test('protected case: loop header outside the snippet stays a finding', () => {
  const out = auditFile({ file: 'src/import.js', text: LOOP_FILE });
  assert.equal(out.dismissals.length, 0, 'a genuine loop site must never be dismissed');
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0].key, 'src/import.js:6:insert');
  assert.match(out.findings[0].reason, /enclosing block header @3/);
});

test('a single write with no enclosing loop is dismissed and recorded', () => {
  const history = [];
  const counts = { dismissed: 0, findings: 0 };
  const out = auditFile({ file: 'src/save.js', text: SINGLE, history, counts });
  assert.equal(out.findings.length, 0);
  assert.equal(out.dismissals.length, 1);
  assert.equal(history.length, 1);
  assert.equal(history[0].type, 'batch-write-audit.dismissed');
  assert.equal(history[0].key, 'src/save.js:2:insert');
  assert.equal(history[0].file, 'src/save.js');
  assert.equal(history[0].line, 2);
  assert.equal(history[0].callee, 'insert');
  assert.ok(history[0].reason);
  assert.equal(counts.dismissed, 1);
});

test('two projects are audited independently', () => {
  const out = auditFiles([
    { file: 'projA/x.js', text: LOOP_FILE },
    { file: 'projB/y.js', text: SINGLE },
  ]);
  assert.equal(out.results[0].findings.length, 1);
  assert.equal(out.results[0].dismissals.length, 0);
  assert.equal(out.results[1].findings.length, 0);
  assert.equal(out.results[1].dismissals.length, 1);
  assert.deepEqual(out.counts, { dismissed: 1, findings: 1 });
  assert.equal(out.history.length, out.counts.dismissed, 'every dismissal has a history entry');
});

test('unbalanced braces cannot be dismissed', () => {
  const out = auditFile({ file: 'src/broken.js', text: 'function f(db) {\n  db.insert(1);' });
  assert.equal(out.dismissals.length, 0);
  assert.equal(out.findings.length, 1);
  assert.match(out.findings[0].reason, /unbalanced braces/);
});

test('an unbraced loop body is a finding, not a dismissal', () => {
  const out = auditFile({ file: 'src/unbraced.js', text: 'for (const r of rows)\n  db.insert(r);' });
  assert.equal(out.dismissals.length, 0);
  assert.equal(out.findings.length, 1);
});
