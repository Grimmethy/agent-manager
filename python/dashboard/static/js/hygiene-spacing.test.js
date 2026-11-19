// Source assertions: the Hygiene tab's .stat notes use a 4px-grid shared class, not an inline 14px margin.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const js = fs.readFileSync(path.join(__dirname, 'hygiene-tab.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'index.html'), 'utf8');

test('hygiene tab has no off-grid 14px margin-top', () => {
  assert.doesNotMatch(js, /margin-top:\s*14px/);
  assert.equal((js.match(/class="stat stat-note"/g) || []).length, 2);
});

test('.stat-note margin-top is on the 4px grid', () => {
  const m = html.match(/\.stat\.stat-note\s*\{\s*margin-top:\s*(\d+)px/);
  assert.ok(m, '.stat.stat-note rule present');
  assert.equal(Number(m[1]) % 4, 0);
});
