'use strict';

// Dashboard columns, 2026-10-25: nav (200px) + main + the 380px chat sidebar must always fit the window. A flex item's default min-width:auto kept
// main at its widest child (the Project tab's 802px visualization iframe, 842px with padding), so at a 1366px window the page was 1422px wide, scrolled
// sideways and clipped the sidebar's right edge. main now gives way (min-width:0) and scrolls wide content inside itself. Pure text checks on
// templates/index.html.
//
// Run: node --test python/dashboard/static/js/layout-overflow.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'index.html'), 'utf8');

// The declaration block of `selector` at the top level of the stylesheet, i.e. outside every @media block.
function baseRule(selector) {
  const css = HTML.slice(HTML.indexOf('<style'), HTML.indexOf('</style>')).replace(/\/\*[\s\S]*?\*\//g, '');
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp('(?:^|[}\\s])' + esc + '\\s*\\{([^{}]*)\\}').exec(stripNested(css));
  return m ? m[1] : null;
}

// Drops every nested block (the @media bodies) so only top-level rules remain.
function stripNested(css) {
  let out = '', depth = 0, atRule = false;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') {
      if (depth === 0) {
        const head = out.slice(out.lastIndexOf('}') + 1);
        atRule = /^\s*@/.test(head);
      }
      depth++;
      if (atRule) { out = out.slice(0, out.lastIndexOf('}') + 1); continue; }
    } else if (ch === '}') {
      depth--;
      if (atRule) { if (depth === 0) atRule = false; continue; }
    } else if (atRule) continue;
    out += ch;
  }
  return out;
}

test('main (outside the phone media query) can shrink and scrolls wide content inside itself', () => {
  const main = baseRule('main');
  assert.ok(main, 'a base main rule exists');
  assert.match(main, /min-width:\s*0\b/, 'main must declare min-width: 0 so it can shrink');
  assert.match(main, /overflow-x:\s*auto/, 'wide content scrolls inside main');
  assert.match(main, /flex:\s*1\b/, 'main still takes the free space');
});

test('the side columns keep their fixed width and refuse to shrink, so main is the column that gives way', () => {
  assert.match(baseRule('nav') || '', /width:\s*200px/);
  assert.match(baseRule('nav') || '', /flex-shrink:\s*0/);
  assert.match(baseRule('.plugin-sidebar') || '', /width:\s*380px/);
  assert.match(baseRule('.plugin-sidebar') || '', /flex-shrink:\s*0/);
});
