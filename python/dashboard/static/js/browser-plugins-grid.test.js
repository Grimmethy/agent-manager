'use strict';
// Run: node --test python/dashboard/static/js/browser-plugins-grid.test.js
// Last slice of small values (2026-11-02), found by probing the remaining tabs: the Brain Dump file browser rows and their badges and buttons (6px padding, 10-11px text),
// the Plugins tab's inline 2px and 6px gaps and 22px headings, and the empty-state note padding on the Adhoc and Queue tabs (10px 4px).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'index.html'), 'utf8');
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const plugins = read('plugins-tab.js');
const bd = read('brain-dump-and-second-brain.js');
const body = (start) => { const i = html.indexOf(start); assert.ok(i >= 0, start); const o = html.indexOf('{', i); return html.slice(o + 1, html.indexOf('}', o)); };
const declaration = (b, prop) => { const m = new RegExp(`(?:^|;|\\s)${prop}:\\s*([^;]+);`).exec(b + ';'); return m ? m[1].trim() : null; };

test('browser rows use 8px padding', () => {
  assert.equal(declaration(body('.browser-entry {'), 'padding'), '8px');
});

test('the git badge and entry count are 12px, the badge with 0 8px padding', () => {
  const g = body('.browser-entry .git-badge {');
  assert.equal(declaration(g, 'font-size'), '12px');
  assert.equal(declaration(g, 'padding'), '0 8px');
  assert.equal(declaration(body('.browser-entry .entry-count {'), 'font-size'), '12px');
});

test('the set-active and create-github-project buttons use 12px text and 4px 8px padding', () => {
  const b = body('.browser-entry .set-active-project, .browser-entry .create-github-project {');
  assert.equal(declaration(b, 'font-size'), '12px');
  assert.equal(declaration(b, 'padding'), '4px 8px');
});

test('the Sync GitHub button uses 4px 12px padding', () => {
  assert.match(bd, /id="bd-sync-github-btn" style="text-transform:none; letter-spacing:normal; font-size:12px; padding:4px 12px;"/);
});

test('Plugins uses 4px description and radio gaps, 4px option gap, 8px label gap and 24px headings, with no 2px or 6px or 22px left', () => {
  assert.equal((plugins.match(/margin-top:4px/g) || []).length, 8);
  assert.match(plugins, /flex-direction:column; gap:4px;/);
  assert.match(plugins, /class="field-label" style="margin-bottom:8px;"/);
  assert.equal((plugins.match(/margin-top:24px/g) || []).length, 2);
  assert.doesNotMatch(plugins, /margin-top:2px|gap:2px|margin-bottom:6px|margin-top:22px/);
});

test('the Plugins Installed note and register path are 12px and no 11px text is left', () => {
  assert.match(plugins, /margin-top:4px; font-size:12px;">Installed: /);
  assert.match(plugins, /font-family:monospace; font-size:12px; color:var\(--muted\);">\$\{escapeHtml\(p\.registerPath/);
  assert.doesNotMatch(plugins, /font-size:11px/);
});

test('the Adhoc and Queue footers use 12px 4px padding', () => {
  for (const f of ['concepts-and-adhoc-tab.js', 'queue-tab.js']) {
    const src = read(f);
    assert.match(src, /<div class="meta" style="padding:12px 4px">Showing /, f);
    assert.doesNotMatch(src, /padding:10px 4px/, f);
  }
});

test('Plugins badges sit 8px from their name and the registered-plugins note has a 16px bottom gap', () => {
  assert.equal((plugins.match(/class="badge (?:idle|ok)" style="margin-left:8px;"/g) || []).length, 3);
  assert.match(plugins, /<div class="meta" style="margin-bottom:16px;">/);
  assert.doesNotMatch(plugins, /margin-left:6px|margin-bottom:14px/);
});

test('every shared text rule that was 10 or 11px is now 12px', () => {
  for (const sel of ['.bench-case-stats {', '.da-tools {', '.wl-call {', '.work-log pre {', '.grill-msg-role {', '.grill-seg-ts {']) assert.equal(declaration(body(sel), 'font-size'), '12px', sel);
});

test('the benchmark stats gap is 8px and the work log call rows have 4px vertical padding', () => {
  assert.equal(declaration(body('.bench-case-stats {'), 'margin-left'), '8px');
  assert.equal(declaration(body('.wl-call {'), 'padding'), '4px 0');
});
