'use strict';

// HUB0274-07: the Brain Dump card chips. python/dashboard/static/js/brain-dump-chips.js is a plain <script> in the dashboard and a CommonJS module
// here (the same pattern as branch-projects.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const { brainDumpChipsHtml } = require('../python/dashboard/static/js/brain-dump-chips.js');

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
