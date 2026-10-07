'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isStructuredGroupBChange, looksLikeReadToolCall, isRepoRelativePath } = require('./structured-change.js');

test('valid delete, edit and create items, alone or in an array, are structured changes', () => {
  assert.equal(isStructuredGroupBChange('{"mode": "delete", "file": "TaxHarvest/frontend/src/components/ui/form.tsx"}'), true);
  assert.equal(isStructuredGroupBChange('{"mode":"edit","file":"a.js","find":"x","replace":""}'), true, 'an empty replace is a valid deletion edit');
  assert.equal(isStructuredGroupBChange('{"mode":"create","file":"a.js","content":""}'), true);
  assert.equal(isStructuredGroupBChange('[{"mode":"delete","file":"a.js"},{"mode":"edit","file":"b.js","find":"q","replace":"r"}]'), true);
  assert.equal(isStructuredGroupBChange('```json\n{"mode":"delete","file":"a.js"}\n```'), true, 'a single wrapping fence is tolerated');
  assert.equal(isStructuredGroupBChange('  \n{"mode":"delete","file":"a.js"}\n  '), true);
});

test('everything else is not: read mode, prose, wrong fields, empty, malformed, surrounding chatter, unsafe paths', () => {
  const no = [
    '{"mode": "read", "file": "a.js"}',
    'I will delete form.tsx now.',
    'Sure: {"mode":"delete","file":"a.js"}',
    '{"mode":"delete","file":"a.js"} and that is all',
    '{"mode":"delete"}',
    '{"mode":"delete","file":""}',
    '{"mode":"delete","file":" a.js"}',
    '{"mode":"delete","file":"../x.js"}',
    '{"mode":"delete","file":"a/../../x.js"}',
    '{"mode":"delete","file":"/etc/passwd"}',
    '{"mode":"delete","file":"C:\\\\x.js"}',
    '{"mode":"edit","file":"a.js","find":"","replace":"y"}',
    '{"mode":"edit","file":"a.js","find":"x"}',
    '{"mode":"create","file":"a.js"}',
    '{"file":"a.js","find":"x","replace":"y"}',
    '{"mode":"rename","file":"a.js"}',
    '[]', '{}', '[1,2]', 'null', '', '{"mode":"delete","file":"a.js"',
    '[{"mode":"delete","file":"a.js"},{"mode":"read","file":"b.js"}]',
  ];
  for (const t of no) assert.equal(isStructuredGroupBChange(t), false, JSON.stringify(t));
  for (const t of [undefined, null, 5, {}, []]) assert.equal(isStructuredGroupBChange(t), false);
});

test('isRepoRelativePath accepts plain relative paths only', () => {
  assert.equal(isRepoRelativePath('a/b/c.tsx'), true);
  for (const p of ['', ' ', '/a', '../a', 'a/..', 'C:/a', 'a\\..\\b', null, 3]) assert.equal(isRepoRelativePath(p), false, String(p));
});

test('looksLikeReadToolCall: a real read request is one, a long diff that merely mentions the marker is not', () => {
  assert.equal(looksLikeReadToolCall('{"mode": "read", "file": "a.js"}'), true);
  assert.equal(looksLikeReadToolCall('{"file": "a.js", "mode": "read"}'), true, 'key order does not matter');
  assert.equal(looksLikeReadToolCall('[{"mode":"read","file":"a.js"},{"mode":"read","file":"b.js"}]'), true);
  assert.equal(looksLikeReadToolCall('```json\n{"mode": "read", "file": "a.js"}\n```'), true);
  assert.equal(looksLikeReadToolCall('I will read it. {"mode":"read","file":"a.js"}'), true, 'a short fragment containing the marker');
  const longDiff = `Added a test.\n\n=== DIFF ===\n${'diff --git a/x b/x\n+  assert.equal(gate(\'{"mode": "read", "file": "a.js"}\'), true);\n'.repeat(20)}`;
  assert.ok(longDiff.length > 200);
  assert.equal(looksLikeReadToolCall(longDiff), false, 'a diff mentioning the string is not a read request');
  assert.equal(looksLikeReadToolCall('{"mode":"delete","file":"a.js"}'), false);
  for (const t of [undefined, null, 5, '', 'plain prose']) assert.equal(looksLikeReadToolCall(t), false);
  assert.equal(looksLikeReadToolCall(`${'x'.repeat(300)} {"mode":"read","file":"a.js"}`), false, 'long non-JSON text is not parsed as a request');
  assert.equal(looksLikeReadToolCall(`{"mode":"read","file":"${'f'.repeat(300)}"}`), true, 'a long but pure read request still is one');
});
