'use strict';
// Run: node --test python/dashboard/static/js/chips-grid-2.test.js
// Second chip slice (2026-11-02): the Concepts tab tags and the Queue tab flag tags, hub priority row and filter bar use the shared .chip class
// and the 4px grid, and the .empty and .stat-row blocks sit on it too. Follows chips-grid.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'index.html'), 'utf8');
const concepts = fs.readFileSync(path.join(__dirname, 'concepts-and-adhoc-tab.js'), 'utf8');
const queue = fs.readFileSync(path.join(__dirname, 'queue-tab.js'), 'utf8');

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

test('chip colour modifiers: bad, accent and link', () => {
  for (const [sel, v] of [['.chip.chip-bad', 'var(--bad)'], ['.chip.chip-accent', 'var(--accent)'], ['.chip.chip-link', 'var(--link)']]) {
    assert.equal(declaration(rule(sel), 'border-color'), v, sel);
    assert.equal(declaration(rule(sel), 'color'), v, sel);
  }
});

test('chip layout modifiers: solo has no left gap, block has no left gap and a 4px bottom gap', () => {
  assert.equal(declaration(rule('.chip.chip-solo'), 'margin-left'), '0');
  const b = rule('.chip.chip-block');
  assert.equal(declaration(b, 'margin-left'), '0');
  assert.equal(declaration(b, 'margin-bottom'), '4px');
});

test('the three Concepts tags use chip classes with the right colour and keep their titles', () => {
  assert.match(concepts, /<span title="Last researched [^"]*" class="chip">🔬 researched/);
  assert.match(concepts, /Self-reported by the implementing model[^"]*" class="chip chip-warn">🔨/);
  assert.match(concepts, /deterministic match, not self-reported" class="chip chip-accent">📎/);
  assert.doesNotMatch(concepts, /padding:1px 5px/);
  assert.doesNotMatch(concepts, /font-size:11px/);
});

test('the Queue flag tags and hub priority tag use chip classes and the colour comes from a class name', () => {
  assert.equal((queue.match(/class="chip chip-block \$\{col\}"/g) || []).length, 2);
  assert.match(queue, /const col = sf\.confidence === 'high' \? 'chip-bad' : 'chip-warn';/);
  assert.match(queue, /const col = ctf\.confidence === 'strong' \? 'chip-bad' : 'chip-warn';/);
  assert.match(queue, /class="chip chip-link chip-solo">P\$\{/);
  assert.doesNotMatch(queue, /padding:1px 5px/);
  assert.doesNotMatch(queue, /border:1px solid \$\{col\}/);
});

test('the Queue spacing values sit on the 4px grid and its small text is 12px', () => {
  assert.match(queue, /<label class="meta" style="margin-left:16px">Sort hubs/);
  assert.match(queue, /<div class="row" style="margin-bottom:8px"><label class="meta">Task type/);
  assert.match(queue, /`<div style="margin-top:4px">`/);
  assert.match(queue, /<span class="meta" style="font-size:12px">unranked<\/span>/);
  assert.match(queue, /style="padding:0 8px;font-size:12px" title="Set or clear this hub's priority"/);
  assert.doesNotMatch(queue, /font-size:11px/);
});

test('empty and stat-row blocks use grid spacing', () => {
  assert.equal(declaration(rule('.empty'), 'padding'), '32px');
  assert.equal(declaration(rule('.stat-row'), 'margin'), '16px 0');
  assert.match(html, /\.stat-row \{ flex-wrap: wrap; row-gap: 12px; \}/);
});

test('the Concepts lifecycle panel uses 8px spacing above it and 12px stage text', () => {
  assert.match(concepts, /<div class="meta" style="margin-top:8px;display:flex;flex-wrap:wrap;align-items:center;gap:4px">/);
  assert.match(concepts, /border-radius:4px;padding:4px 8px;font-size:12px;line-height:1\.3/);
});
