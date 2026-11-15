'use strict';
// Run: node --test python/dashboard/static/js/control-spacing.test.js
// Control spacing slice (2026-11-02): text-input padding, checkbox margins and the em-based text sizes on the Project tab sit on the 4px grid / 12px floor.
// Measured on the live Project tab before the change: checkboxes 3px margins, text inputs 10px side padding, a 0.85em (11.9px) note.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'index.html'), 'utf8');
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const project = read('project-tab.js');
const plugins = read('plugins-tab.js');
const modal = read('task-detail-modal.js');
const body = (start) => { const i = html.indexOf(start); assert.ok(i >= 0, start); const o = html.indexOf('{', i); return html.slice(o + 1, html.indexOf('}', o)); };
const declaration = (b, prop) => { const m = new RegExp(`(?:^|;|\\s)${prop}:\\s*([^;]+);`).exec(b + ';'); return m ? m[1].trim() : null; };

test('the path, capture and grill answer inputs use 8px 12px padding', () => {
  for (const sel of ['.path-row input {', '.capture-row input {', '.grill-session .grill-answer {']) assert.equal(declaration(body(sel), 'padding'), '8px 12px', sel);
});

test('the grill answer box sits 8px below its question', () => {
  assert.equal(declaration(body('.grill-session .grill-answer {'), 'margin-top'), '8px');
});

test('checkboxes and radios get a 4px margin instead of the browser 3px 3px 3px 4px', () => {
  assert.equal(declaration(body('input[type="checkbox"], input[type="radio"] {'), 'margin'), '4px');
});

test('the Project tab toggles use 13px text and its note 12px, with no em sizes left', () => {
  assert.equal((project.match(/font-size:13px/g) || []).length, 2);
  assert.match(project, /<span class="meta" style="font-size:12px;">Which job types run/);
  assert.doesNotMatch(project, /font-size:0\.\d+em/);
});

test('the Plugins rows and the clarify answer buttons use 8px 12px padding', () => {
  assert.equal((plugins.match(/gap:8px; padding:8px 12px; cursor:pointer;/g) || []).length, 2);
  assert.match(modal, /style="text-align:left;padding:8px 12px"/);
  for (const src of [plugins, modal]) assert.doesNotMatch(src, /padding:8px 10px/);
});
