'use strict';

// premium-provenance.js: the "Set by <who> <time>" line under the Premium Priority button. A plain global <script> (declarations only), loaded into a bare vm context.
// The load order against task-detail-modal.js and the modal's call are checked by pinning the real source text below.
// Run: node --test python/dashboard/static/js/premium-provenance.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, 'premium-provenance.js'), 'utf8'), ctx, { filename: 'premium-provenance.js' });
const text = (task, now) => { ctx.__t = task; ctx.__n = now; return vm.runInContext('premiumProvenanceText(__t, __n)', ctx); };
const NOW = Date.parse('2026-10-30T12:00:00Z');

test('each setter label is shown in words with a relative time', () => {
  const at = '2026-10-30T11:30:00Z';
  assert.equal(text({ premiumPriority: true, premiumSetBy: 'operator-ui', premiumSetAt: at }, NOW), 'Set by operator (task modal) 30 min ago');
  assert.equal(text({ premiumPriority: true, premiumSetBy: 'operator-bulk', premiumSetAt: at }, NOW), 'Set by operator (bulk) 30 min ago');
  assert.equal(text({ premiumPriority: true, premiumSetBy: 'chat-queue', premiumSetAt: at }, NOW), 'Set by Chat 30 min ago');
  assert.equal(text({ premiumPriority: true, premiumSetBy: 'cli', premiumSetAt: at }, NOW), 'Set by the command line 30 min ago');
  assert.equal(text({ premiumPriority: true, premiumSetBy: 'source', premiumSetAt: at }, NOW), 'Set by its task source 30 min ago');
});

test('an old premium task without the fields shows "origin unknown", never an error', () => {
  assert.equal(text({ premiumPriority: true }, NOW), 'origin unknown');
  assert.equal(text({ premiumPriority: true, premiumSetBy: 'chat-queue' }, NOW), 'Set by Chat');
  assert.equal(text({ premiumPriority: true, premiumSetBy: 'chat-queue', premiumSetAt: 'garbage' }, NOW), 'Set by Chat');
  assert.equal(text(null, NOW), '');
  assert.equal(text({}, NOW), '');
});

test('a cleared task shows who cleared it; the last set info is kept on the record, not shown', () => {
  assert.equal(text({ premiumSetBy: 'chat-queue', premiumSetAt: '2026-10-29T00:00:00Z', premiumClearedBy: 'operator-ui', premiumClearedAt: '2026-10-30T11:59:30Z' }, NOW), 'Cleared by operator (task modal) just now');
});

test('relative time buckets', () => {
  const t = (iso) => text({ premiumPriority: true, premiumSetBy: 'cli', premiumSetAt: iso }, NOW);
  assert.match(t('2026-10-30T09:00:00Z'), /3 h ago$/);
  assert.match(t('2026-10-27T12:00:00Z'), /3 d ago$/);
});

test('the modal and the page are wired: premium-provenance.js loads before task-detail-modal.js and the modal calls premiumProvenanceText', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'index.html'), 'utf8');
  const a = html.indexOf('js/premium-provenance.js');
  const b = html.indexOf('js/task-detail-modal.js');
  assert.ok(a > 0 && b > a, 'premium-provenance.js must be loaded, and before task-detail-modal.js');
  const modal = fs.readFileSync(path.join(__dirname, 'task-detail-modal.js'), 'utf8');
  assert.match(modal, /premiumProvenanceText\(task, Date\.now\(\)\)/);
  assert.match(modal, /task\.premiumSetBy = 'operator-ui'/, 'the in-place re-render after a toggle must carry the same fields the route stamps');
});
