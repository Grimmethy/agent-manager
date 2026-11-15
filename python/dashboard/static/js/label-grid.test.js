'use strict';
// Run: node --test python/dashboard/static/js/label-grid.test.js
// Last small values found on the live tabs (2026-11-02): the shared .field-label rule (11px text, 14px top margin) on Discovery, Filed Findings and others,
// the branch-scan banner margin (10px) on Unmerged Branches, and the Plugins boxes (12px 14px).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'index.html'), 'utf8');
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const projects = read('branch-projects.js');
const plugins = read('plugins-tab.js');
const body = (start) => { const i = html.indexOf(start); assert.ok(i >= 0, start); const o = html.indexOf('{', i); return html.slice(o + 1, html.indexOf('}', o)); };
const declaration = (b, prop) => { const m = new RegExp(`(?:^|;|\\s)${prop}:\\s*([^;]+);`).exec(b + ';'); return m ? m[1].trim() : null; };

test('.field-label is 12px text with a 16px top margin', () => {
  const b = body('.field-label {');
  assert.equal(declaration(b, 'font-size'), '12px');
  assert.equal(declaration(b, 'margin-top'), '16px');
  assert.equal(declaration(b, 'text-transform'), 'uppercase');
});

test('the branch scan banner has an 8px bottom margin', () => {
  assert.match(projects, /data-projects-pending style="margin:0 0 8px"/);
  assert.doesNotMatch(projects, /margin:0 0 10px/);
});

test('the three Plugins boxes use 12px 16px padding', () => {
  assert.equal((plugins.match(/padding:12px 16px;/g) || []).length, 3);
  assert.doesNotMatch(plugins, /padding:12px 14px/);
});
