'use strict';
// Run: node --test python/dashboard/static/js/table-scroll.test.js
// Wide-table slice (2026-11-02): the Job List table is 12 columns and measured 1669px in a 754px tab, which made the whole tab scroll sideways; the Scouted Repos
// table measured 986px. Both now scroll inside their own bordered box, and the Job List spacing sits on the 4px grid.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'index.html'), 'utf8');
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const jobs = read('branches-joblist-hardware-tabs.js');
const discovery = read('analytics-and-discovery.js');
const body = (start) => { const i = html.indexOf(start); assert.ok(i >= 0, start); const o = html.indexOf('{', i); return html.slice(o + 1, html.indexOf('}', o)); };
const declaration = (b, prop) => { const m = new RegExp(`(?:^|;|\\s)${prop}:\\s*([^;]+);`).exec(b + ';'); return m ? m[1].trim() : null; };

test('.table-scroll scrolls sideways inside a 2px --border box with an 8px radius and a 16px bottom gap', () => {
  const b = body('.table-scroll {');
  assert.equal(declaration(b, 'overflow-x'), 'auto');
  assert.equal(declaration(b, 'border'), '2px solid var(--border)');
  assert.equal(declaration(b, 'border-radius'), '8px');
  assert.equal(declaration(b, 'margin-bottom'), '16px');
  assert.equal(declaration(body('.table-scroll > table {'), 'margin'), '0');
});

test('the Job List table sits inside .table-scroll and the wrapper closes after the table', () => {
  assert.match(jobs, /\+ `<div class="table-scroll"><table><thead><tr><th>Active<\/th>/);
  assert.match(jobs, /<th>Description<\/th><\/tr><\/thead><tbody>\$\{rows\}<\/tbody><\/table><\/div>`/);
});

test('the Scouted Repos table sits inside .table-scroll and the wrapper closes after the table', () => {
  assert.match(discovery, /main\.innerHTML = bar \+ `<div class="table-scroll"><table><thead><tr><th>Hot<\/th>/);
  assert.match(discovery, /<\/tbody><\/table><\/div>`;/);
});

test('the Job List summary tiles use 12px padding and the two panels 16px', () => {
  assert.match(jobs, /border-radius:8px; padding:12px; text-align:center;/);
  assert.equal((jobs.match(/min-width:320px; background:var\(--panel\); border:1px solid var\(--border\); border-radius:8px; padding:16px;/g) || []).length, 2);
  assert.doesNotMatch(jobs, /padding:10px 12px; text-align:center;/);
  assert.doesNotMatch(jobs, /border-radius:8px; padding:14px;/);
});

test('the Job List family toggle, reset button row and list use 8px values', () => {
  assert.match(jobs, /font:inherit;padding:0 8px 0 0">/);
  assert.match(jobs, /<div style="margin-bottom:8px"><button id="reset-job-type-counts"/);
  assert.match(jobs, /<div style="margin-bottom:8px;">\$\{items\}<\/div>/);
});

test('the priority input has 8px padding and the capture row a 16px bottom gap', () => {
  assert.equal(declaration(body('.priority-input {'), 'padding'), '8px');
  assert.equal(declaration(body('.capture-row {'), 'margin-bottom'), '16px');
});
