'use strict';

// HUB0274-07: the Brain Dump card chips. python/dashboard/static/js/brain-dump-chips.js is a plain <script> in the dashboard and a CommonJS module
// here (the same pattern as branch-projects.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const { brainDumpChipsHtml, prioritizeRefusal } = require('../python/dashboard/static/js/brain-dump-chips.js');

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

test('neither field gives an empty string', () => {
  assert.strictEqual(brainDumpChipsHtml({ id: 'bd-1', rawText: 'x' }, escapeHtml), '');
  assert.strictEqual(brainDumpChipsHtml(null, escapeHtml), '');
  assert.strictEqual(brainDumpChipsHtml(undefined), '');
});

test('possiblyResolved gives the chip and the evidence', () => {
  const html = brainDumpChipsHtml({ possiblyResolved: { evidence: 'commit 4e8054e added the hold subcommand', masterSha: 'abc', checkedAt: 'x' } }, escapeHtml);
  assert.match(html, /class="badge warn"[^>]*>possibly resolved<\/span>/);
  assert.match(html, />commit 4e8054e added the hold subcommand<\/span>/);
  assert.match(html, /title="Possibly already fixed on master \(not closed, check it\): commit 4e8054e/);
  assert.doesNotMatch(html, /target check/);
});

test('targetCheck gives the chip and the reasons joined', () => {
  const html = brainDumpChipsHtml({ targetCheck: { verdict: 'suspect', reasons: ['every cited path is missing', 'cites archive/ code'], at: 'x' } }, escapeHtml);
  assert.match(html, />target check<\/span>/);
  assert.match(html, /every cited path is missing; cites archive\/ code/);
  assert.doesNotMatch(html, /possibly resolved/);
});

test('HTML in the evidence and the reasons is escaped in text and in attributes', () => {
  const evil = '<img src=x onerror=alert(1)> "quoted" \'single\'';
  const html = brainDumpChipsHtml({ possiblyResolved: { evidence: evil }, targetCheck: { reasons: [evil] } }, escapeHtml);
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /title="[^"]*"[^>]*"[^>]*onerror/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&quot;quoted&quot;/);
  // without the dashboard's escaper the module still escapes
  assert.doesNotMatch(brainDumpChipsHtml({ possiblyResolved: { evidence: evil } }), /<img/);
});

test('both fields give both chips, and an overlong evidence line is clipped', () => {
  const html = brainDumpChipsHtml({ possiblyResolved: { evidence: 'e'.repeat(1000) }, targetCheck: { reasons: 'one reason as a string' } }, escapeHtml);
  assert.match(html, /possibly resolved/);
  assert.match(html, /target check/);
  assert.match(html, /one reason as a string/);
  assert.ok(!html.includes('e'.repeat(400)), 'evidence is clipped to 300 characters');
  assert.match(html, /\.\.\./);
});

// HUB0279-03: prioritizeRefusal(status, text) -- how the Process now handlers read the server's answer (409 = held back by the target check).
test('prioritizeRefusal: a 409 with text is refused and carries the message', () => {
  assert.deepEqual(prioritizeRefusal(409, 'Process now was not run: target missing'), { refused: true, message: 'Process now was not run: target missing' });
});

test('prioritizeRefusal: 200, 404 and 500 are not refusals', () => {
  for (const status of [200, 404, 500]) assert.deepEqual(prioritizeRefusal(status, 'anything'), { refused: false });
});

test('prioritizeRefusal: only the number 409 counts (not other 4xx, not the string "409")', () => {
  assert.deepEqual(prioritizeRefusal(400, 'x'), { refused: false });
  assert.deepEqual(prioritizeRefusal(422, 'x'), { refused: false });
  assert.deepEqual(prioritizeRefusal('409', 'x'), { refused: false });
});

test('prioritizeRefusal: an overlong message is trimmed to 400 characters and a 400-character one is kept whole', () => {
  assert.equal(prioritizeRefusal(409, 'a'.repeat(1000)).message.length, 400);
  assert.equal(prioritizeRefusal(409, 'b'.repeat(400)).message, 'b'.repeat(400));
});

test('prioritizeRefusal: undefined and null text give an empty message, a number is turned into text', () => {
  assert.deepEqual(prioritizeRefusal(409, undefined), { refused: true, message: '' });
  assert.deepEqual(prioritizeRefusal(409, null), { refused: true, message: '' });
  assert.deepEqual(prioritizeRefusal(409, 12345), { refused: true, message: '12345' });
});
