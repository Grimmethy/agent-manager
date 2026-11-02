'use strict';
// Run: node --test python/dashboard/static/js/shared-grid.test.js
// Guards the first restyle slice (2026-11-02): the shared component rules sit on the 4px grid and the 12/14px type sizes of the Agent Manager brand
// (brands/agent-manager/tokens.json in the uiforge repo). Measured before the change: 54% of the spacing values on Unmerged Branches and 57% on Workers
// were off a 4px grid, nearly all from these rules.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'index.html'), 'utf8');
const projects = fs.readFileSync(path.join(__dirname, 'branch-projects.js'), 'utf8');

// The body of the first top-level rule whose selector is exactly `selector` (the stylesheet writes rules on one line).
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
const px = (value) => (value || '').split(/\s+/).filter(Boolean).map((v) => (v === '0' ? 0 : parseFloat(v)));

const SHARED = ['th', 'td', '.badge', '.badge-col', '.worker-card', '.worker-card .meta', 'button.action', 'button.secondary', 'button.danger', '.worker-filter-bar button', 'nav button.nav-sh'];

test('table cells', () => {
  assert.equal(declaration(rule('th'), 'padding'), '8px 12px');
  assert.equal(declaration(rule('td'), 'padding'), '8px 12px');
});

test('badges are 20px tall pills with 12px text and no vertical padding', () => {
  const b = rule('.badge');
  assert.equal(declaration(b, 'padding'), '0 8px');
  assert.equal(declaration(b, 'line-height'), '20px');
  assert.equal(declaration(b, 'font-size'), '12px');
  assert.equal(declaration(rule('.badge-col'), 'gap'), '4px');
});

test('cards', () => {
  const c = rule('.worker-card');
  assert.equal(declaration(c, 'padding'), '16px');
  assert.equal(declaration(c, 'margin-bottom'), '12px');
  assert.equal(declaration(c, 'border-radius'), '10px');
  assert.equal(declaration(c, 'border'), '2px solid var(--border)');
  assert.equal(declaration(rule('.worker-card .meta'), 'margin-top'), '8px');
  assert.equal(declaration(rule('.worker-card .meta'), 'font-size'), '12px');
});

test('buttons share 14px text and the same horizontal padding', () => {
  for (const sel of ['button.action', 'button.secondary', 'button.danger']) {
    assert.equal(declaration(rule(sel), 'font-size'), '14px', sel);
    assert.equal(declaration(rule(sel), 'padding'), '8px 16px', sel);
  }
  assert.equal(declaration(rule('.worker-filter-bar button'), 'padding'), '8px 12px');
});

test('the Unmerged Branches filter chips keep 12px sides so the row stays on one line', () => {
  assert.equal(declaration(rule('[data-verdict-filter-bar] button'), 'padding'), '8px 12px');
});

test('sidebar rows and section headers', () => {
  const nav = /\n\s*nav button \{ display: flex; justify-content: space-between; width: 100%; ([^}]*)\}/.exec(html);
  assert.ok(nav, 'nav button rule');
  assert.equal(declaration(nav[1], 'padding'), '8px 20px');
  assert.equal(declaration(nav[1], 'font-size'), '14px');
  assert.equal(declaration(rule('nav button.nav-sh'), 'padding'), '8px 20px');
});

test('every padding, margin and gap in the shared rules is a multiple of 4px', () => {
  for (const sel of SHARED) {
    const body = rule(sel);
    for (const prop of ['padding', 'margin', 'margin-top', 'margin-bottom', 'gap', 'line-height']) {
      const v = declaration(body, prop);
      if (!v) continue;
      for (const n of px(v)) assert.equal(n % 4, 0, `${sel} ${prop}: ${v}`);
    }
  }
  const navRule = /\n\s*nav button \{ display: flex; justify-content: space-between; width: 100%; ([^}]*)\}/.exec(html)[1];
  for (const n of px(declaration(navRule, 'padding'))) assert.equal(n % 4, 0);
});

test('no text in the shared rules is below 12px', () => {
  for (const sel of SHARED) {
    const fs = declaration(rule(sel), 'font-size');
    if (fs) assert.ok(parseFloat(fs) >= 12, `${sel} font-size ${fs}`);
  }
});

test('the project banner in the Unmerged Branches tab', () => {
  const m = /data-project-header[^`]*style="([^"]*)"/.exec(projects);
  assert.ok(m, 'banner style');
  assert.match(m[1], /margin:16px 0 8px;padding:8px 12px;/);
  assert.doesNotMatch(m[1], /18px|6px 10px/);
  assert.match(projects, /font-family:monospace;font-size:12px;margin-left:auto/);
});
