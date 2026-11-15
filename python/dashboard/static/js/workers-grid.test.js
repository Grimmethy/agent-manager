'use strict';
// Run: node --test python/dashboard/static/js/workers-grid.test.js
// Third restyle slice (2026-11-02): the Workers tab's remaining off-grid values after the shared component rules moved onto the 4px grid: the filter bar and
// Claude-pause label, the model select margin, the recent-tasks list, the state timers (11px), the cloud-spend box, and the task-history rules the detail modals share.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'index.html'), 'utf8');
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const workers = read('workers-tab.js');
const cloud = read('cloud-spend-panel.js');
const switchUi = read('worker-switch-ui.js');

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

test('state and stale timers are 12px, not 11px', () => {
  assert.equal(declaration(rule('.stale-timer'), 'font-size'), '12px');
  assert.equal(declaration(rule('.state-timer'), 'font-size'), '12px');
});

test('worker model select, recent-tasks list and task-history rules sit on the grid', () => {
  assert.equal(declaration(rule('.worker-model-select'), 'margin-left'), '12px');
  assert.equal(declaration(rule('.recent-tasks-list'), 'margin'), '8px 0 0');
  assert.equal(declaration(rule('.recent-tasks-list li'), 'gap'), '12px');
  assert.equal(declaration(rule('.task-history'), 'padding-left'), '12px');
  assert.equal(declaration(rule('.task-history'), 'margin-top'), '4px');
  assert.equal(declaration(rule('.task-history-row'), 'padding'), '4px 0');
});

test('the Workers filter bar and the Pause Claude label', () => {
  assert.match(workers, /<div class="worker-filter-bar" style="margin-bottom:12px; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px">/);
  assert.match(workers, /<label style="display:flex; align-items:center; gap:8px; font-size:12px; cursor:pointer"/);
  assert.match(workers, /<input type="checkbox" id="claude-pause-toggle" style="margin:0" /);
  assert.doesNotMatch(workers, /margin-bottom:10px|gap:10px|gap:6px|font-size:0\.9em/);
});

test('the cloud spend box and its source line', () => {
  assert.match(cloud, /const box = 'padding:12px 16px; background:var\(--panel\);/);
  assert.match(cloud, /<div class="meta" style="margin-top:4px">' \+ source/);
  assert.doesNotMatch(cloud, /padding:12px 14px|margin-top:2px/);
});

// Every inline margin, padding and gap pixel value in a source's style="..." and in the cloud panel's single-quoted `box` string.
function inlineSpacing(src) {
  const out = [];
  const chunks = [...src.matchAll(/style="([^"]*)"/g)].map((m) => m[1]);
  for (const m of src.matchAll(/const box = '([^']*)'/g)) chunks.push(m[1]);
  for (const chunk of chunks) {
    for (const part of chunk.split(';')) {
      const i = part.indexOf(':');
      if (i < 0) continue;
      const prop = part.slice(0, i).trim();
      const value = part.slice(i + 1).trim();
      out.push({ prop, value });
    }
  }
  return out;
}
const SPACING_PROP = /^(margin|padding)(-top|-right|-bottom|-left)?$|^gap$|^row-gap$|^column-gap$/;
const pxs = (v) => [...v.matchAll(/(-?\d+(?:\.\d+)?)px/g)].map((m) => parseFloat(m[1]));

for (const [name, src] of [['workers-tab.js', workers], ['cloud-spend-panel.js', cloud], ['worker-switch-ui.js', switchUi]]) {
  test(`every inline margin, padding and gap in ${name} is a multiple of 4px`, () => {
    const bad = inlineSpacing(src).filter((d) => SPACING_PROP.test(d.prop)).filter((d) => pxs(d.value).some((n) => n % 4 !== 0));
    assert.deepEqual(bad, []);
  });
  test(`no inline pixel text size in ${name} is below 12px`, () => {
    const small = inlineSpacing(src).filter((d) => d.prop === 'font-size').filter((d) => pxs(d.value).some((n) => n < 12));
    assert.deepEqual(small, []);
  });
}

test('the scan really sees the inline styles (guards against the extraction going empty)', () => {
  assert.ok(inlineSpacing(workers).length >= 20);
  assert.ok(inlineSpacing(cloud).length >= 8);
});
