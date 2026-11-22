'use strict';
// Run: node --test python/dashboard/static/js/branches-grid.test.js
// Second restyle slice (2026-11-02): the inline styles in the Unmerged Branches card, detail modal and filter bar sit on the 4px grid, with 12px as the smallest text.
// The shared component rules were done in shared-grid.test.js's slice; what was left here was inline `style="..."` spacing (6px, 10px, 14px, 18px, 2px) and 11px/13px text.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tabs = fs.readFileSync(path.join(__dirname, 'branches-joblist-hardware-tabs.js'), 'utf8');
const verdicts = fs.readFileSync(path.join(__dirname, 'branch-verdicts.js'), 'utf8');

const between = (src, from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + from.length);
  assert.ok(a >= 0 && b > a, `cannot slice ${from} .. ${to}`);
  return src.slice(a, b);
};
const card = between(tabs, 'function branchCardHtml(b) {', 'function wireBranchCard(card) {');
const modal = between(tabs, 'async function renderBranchDetailModal(b) {', 'async function renderJobListTab() {');

// Every inline style="..." in a template, as an array of {prop, value} declarations.
function inlineDeclarations(src) {
  const out = [];
  for (const m of src.matchAll(/style="([^"]*)"/g)) {
    for (const part of m[1].split(';')) {
      const i = part.indexOf(':');
      if (i > 0) out.push({ prop: part.slice(0, i).trim(), value: part.slice(i + 1).trim() });
    }
  }
  return out;
}
const pxValues = (value) => [...value.matchAll(/(-?\d+(?:\.\d+)?)px/g)].map((m) => parseFloat(m[1]));
const SPACING_PROP = /^(margin|padding)(-top|-right|-bottom|-left)?$|^gap$|^row-gap$|^column-gap$/;

test('the Unmerged Branches card: chip wrapper, description and branch name', () => {
  assert.match(card, /<div style="margin-bottom:8px">\$\{branchProjectChipHtml\(b\)\}<\/div>/);
  assert.match(card, /style="margin-top:8px;font-size:14px;color:var\(--text\)">\$\{escapeHtml\(b\.description\)\}/);
  assert.match(card, /style="font-family:monospace;font-size:12px;margin-top:4px">\$\{escapeHtml\(b\.branch\)\}/);
});

test('the detail modal: branch line, hub badges, task history spacing', () => {
  assert.match(modal, /style="font-family:monospace;font-size:12px">\$\{escapeHtml\(b\.branch\)\}/);
  assert.equal((modal.match(/class="badge (?:bad|ok)" style="margin-bottom:8px"/g) || []).length, 3);
  assert.equal((modal.match(/class="task-history" style="margin-top:8px"/g) || []).length, 2);
  assert.equal((modal.match(/class="meta" style="margin-top:4px">task <code>/g) || []).length, 2);
  assert.doesNotMatch(modal, /margin-bottom:6px|margin-top:6px|margin-top:2px|font-size:11px/);
});

test('the verdict panel, filter bar and held-hubs box', () => {
  assert.match(verdicts, /<ul style="margin:4px 0 0 16px">/);
  assert.match(verdicts, /data-verdict-filter-bar style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:12px">/);
  assert.match(verdicts, /class="meta" style="margin:4px 0">/);
  assert.match(verdicts, /data-held-hubs style="margin-top:16px;padding:8px 12px;border:1px dashed #888;border-radius:6px"/);
  assert.doesNotMatch(verdicts, /margin:4px 0 0 18px|margin-bottom:10px|margin:2px 0|margin-top:14px|padding:8px 10px/);
});

for (const [name, src] of [['card', card], ['detail modal', modal], ['verdict helpers', verdicts]]) {
  test(`every inline margin, padding and gap in the ${name} is a multiple of 4px`, () => {
    const bad = inlineDeclarations(src).filter((d) => SPACING_PROP.test(d.prop)).filter((d) => pxValues(d.value).some((n) => n % 4 !== 0));
    assert.deepEqual(bad, []);
  });
  test(`no inline text in the ${name} is smaller than 12px`, () => {
    const small = inlineDeclarations(src).filter((d) => d.prop === 'font-size').filter((d) => pxValues(d.value).some((n) => n < 12));
    assert.deepEqual(small, []);
  });
}

test('the scan really sees inline styles in each slice (guards against the extraction going empty)', () => {
  assert.ok(inlineDeclarations(card).length >= 5);
  assert.ok(inlineDeclarations(modal).length >= 10);
  assert.ok(inlineDeclarations(verdicts).length >= 4);
});
