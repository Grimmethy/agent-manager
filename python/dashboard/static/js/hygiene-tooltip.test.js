'use strict';
// The Scanner-flags header tooltip in hygieneFamilyDetail (hygiene-tab.js) joins its help strings with an encoded newline ('&#10;') so the title attribute never holds a raw newline. Run: node --test python/dashboard/static/js/hygiene-tooltip.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const tab = fs.readFileSync(path.join(__dirname, 'hygiene-tab.js'), 'utf8');
// escapeAttr as defined in branches-joblist-hardware-tabs.js (escapes double quotes only).
const escapeAttr = (s) => String(s).replace(/"/g, '&quot;');
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

test('the Scanner-flags header tooltip has no raw newline in its title attribute', () => {
  const ctx = vm.createContext({ escapeAttr, escapeHtml, console });
  vm.runInContext(tab, ctx);
  ctx.f = {
    key: 'k', label: 'K',
    flags: { counts: {}, total: 0, items: [], truncated: false, oldestWaitingAt: null },
    candidates: { docs: [] },
    tasks: {},
  };
  const html = vm.runInContext('hygieneFamilyDetail(f)', ctx);
  const m = html.match(/<span title="([^"]*)">Scanner flags/);
  assert.ok(m, 'header span with a title attribute is rendered');
  assert.ok(!m[1].includes('\n'), 'title attribute contains no raw newline');
  assert.ok(m[1].includes('&#10;'), 'help strings are joined with an encoded newline');
});
