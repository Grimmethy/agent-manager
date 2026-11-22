'use strict';
// Run: node --test python/dashboard/static/js/chips-grid.test.js
// Guards the Filed Findings / Brain Dump restyle slice (2026-11-02): entry cards and their tags sit on the 4px grid with 12px text.
// Measured before the change on Filed Findings: 21% of spacing values off the 4px grid and 47 text elements under 12px,
// almost all from hand-written inline styles (padding:1px 5px, margin-left:6px, font-size:11px) and the .bd-entry rule.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'index.html'), 'utf8');
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const entries = read('brain-dump-and-second-brain.js');
const chips = read('brain-dump-chips.js');

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(html);
  assert.ok(m, `rule not found: ${selector}`);
  return m[1];
}
const declaration = (body, prop) => {
  const m = new RegExp(`(?:^|;|\\s)${prop}:\\s*([^;]+);`).exec(body + ';');
  return m ? m[1].trim() : null;
};

test('entry card padding is 12px all round', () => {
  assert.equal(declaration(rule('.bd-entry'), 'padding'), '12px');
});

test('entry meta text is 12px', () => {
  assert.equal(declaration(rule('.bd-entry .meta'), 'font-size'), '12px');
});

test('.chip is a 12px outlined tag with 4px 8px padding, 8px left gap and a 4px radius', () => {
  const c = rule('.chip');
  assert.equal(declaration(c, 'padding'), '4px 8px');
  assert.equal(declaration(c, 'margin-left'), '8px');
  assert.equal(declaration(c, 'font-size'), '12px');
  assert.equal(declaration(c, 'border-radius'), '4px');
  assert.equal(declaration(c, 'border'), '1px solid var(--muted)');
});

test('chip modifiers: warn colours, clickable shows a pointer', () => {
  const w = rule('.chip.chip-warn');
  assert.equal(declaration(w, 'border-color'), 'var(--warn)');
  assert.equal(declaration(w, 'color'), 'var(--warn)');
  assert.equal(declaration(rule('.chip.clickable'), 'cursor'), 'pointer');
});

test('chip spacing helpers sit on the grid', () => {
  assert.equal(declaration(rule('.chip-gap'), 'margin-left'), '8px');
  const n = rule('.chip-note');
  assert.equal(declaration(n, 'margin-left'), '4px');
  assert.equal(declaration(n, 'font-size'), '12px');
});

test('the three entry tags use the chip class, not inline boxes', () => {
  assert.match(entries, /class="chip chip-warn">🔁 seen/);
  assert.match(entries, /<span class="chip clickable" data-open-task=/);
  assert.match(entries, /<span class="chip" title="Flagged automatically while working on a /);
  assert.doesNotMatch(entries, /padding:1px 5px/);
  assert.doesNotMatch(entries, /font-size:11px/);
});

test('the possibly-resolved and target-check chips use the gap and note classes', () => {
  assert.equal((chips.match(/class="badge warn chip-gap"/g) || []).length, 2);
  assert.equal((chips.match(/class="muted chip-note"/g) || []).length, 2);
  assert.doesNotMatch(chips, /style=/);
});
