'use strict';
// Run: node --test python/dashboard/static/js/form-controls.test.js
// Guards the form-control base style (2026-11-02): bare inputs, selects and textareas used to show the browser's white and light-grey boxes on the dark theme
// (measured live: select background rgb(239,239,239), text input rgb(255,255,255)). One zero-specificity base style fixes them without touching controls that already carry their own rule.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'index.html'), 'utf8');
const body = (selectorStart) => {
  const i = html.indexOf(selectorStart);
  assert.ok(i >= 0, `rule not found: ${selectorStart}`);
  const open = html.indexOf('{', i);
  return html.slice(open + 1, html.indexOf('}', open));
};
const declaration = (b, prop) => {
  const m = new RegExp(`(?:^|;|\\s)${prop}:\\s*([^;]+);`).exec(b + ';');
  return m ? m[1].trim() : null;
};
const BASE = ':where(input:not([type="checkbox"], [type="radio"], [type="range"], [type="file"], [type="hidden"], [type="color"]), select, textarea)';

test('the base selector is wrapped in :where so it has zero specificity and every existing control rule still wins', () => {
  assert.ok(html.includes(BASE + ' {'));
});

test('base controls are dark panels with a --border-strong outline, 6px radius, 4px 8px padding and 13px inherited-family text', () => {
  const b = body(BASE);
  assert.equal(declaration(b, 'background'), 'var(--panel)');
  assert.equal(declaration(b, 'color'), 'var(--text)');
  assert.equal(declaration(b, 'border'), '1px solid var(--border-strong)');
  assert.equal(declaration(b, 'border-radius'), '6px');
  assert.equal(declaration(b, 'padding'), '4px 8px');
  assert.equal(declaration(b, 'font-size'), '13px');
  assert.equal(declaration(b, 'font-family'), 'inherit');
});

test('checkboxes, radios, ranges, file pickers, hidden and colour inputs are left alone', () => {
  for (const t of ['checkbox', 'radio', 'range', 'file', 'hidden', 'color']) assert.ok(BASE.includes(`[type="${t}"]`) && html.includes(`[type="${t}"]`), t);
});

test('the page asks for dark native widgets and a blue accent for checkboxes', () => {
  const b = body(':root { color-scheme: dark;');
  assert.equal(declaration(b, 'color-scheme'), 'dark');
  assert.equal(declaration(b, 'accent-color'), 'var(--accent)');
});

test('keyboard focus shows a 2px blue ring offset by 2px', () => {
  const b = body(':where(input, select, textarea):focus-visible');
  assert.equal(declaration(b, 'outline'), '2px solid var(--accent)');
  assert.equal(declaration(b, 'outline-offset'), '2px');
});

test('disabled controls dim and show the not-allowed cursor; placeholders use the muted colour', () => {
  const d = body(':where(input, select, textarea):disabled');
  assert.equal(declaration(d, 'opacity'), '.5');
  assert.equal(declaration(d, 'cursor'), 'not-allowed');
  assert.equal(declaration(body(':where(input, textarea)::placeholder'), 'color'), 'var(--muted)');
});

test('a control with its own class rule still wins: .capture-row input keeps its 2px --border outline', () => {
  const b = body('.capture-row input');
  assert.match(b, /border: 2px solid var\(--border\)/);
});
