'use strict';
// Run: node --test python/dashboard/static/js/skeleton.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sk = require('./skeleton.js');

const count = (s, re) => (s.match(re) || []).length;

test('the default skeleton is a status region with a title bar, 4 rows, each with a block and 3 lines', () => {
  const h = sk.skeletonHtml();
  assert.match(h, /^<div class="skeleton" role="status" aria-busy="true" data-skeleton>/);
  assert.equal(count(h, /class="skeleton-row"/g), 4);
  assert.equal(count(h, /class="skeleton-block"/g), 4);
  assert.equal(count(h, /class="skeleton-line"/g), 12);
  assert.equal(count(h, /class="skeleton-title"/g), 1);
});

test('screen readers get "Loading..." and there is no visible caption by default', () => {
  const h = sk.skeletonHtml();
  assert.match(h, /<span class="skeleton-sr">Loading\.\.\.<\/span>/);
  assert.doesNotMatch(h, /skeleton-caption/);
});

test('a caption is shown, read out and escaped', () => {
  const h = sk.skeletonHtml({ caption: 'Starting <b>Forge</b> & "co"...' });
  assert.match(h, /<div class="skeleton-caption">Starting &lt;b&gt;Forge&lt;\/b&gt; &amp; &quot;co&quot;\.\.\.<\/div>/);
  assert.match(h, /<span class="skeleton-sr">Starting &lt;b&gt;/);
  assert.doesNotMatch(h, /<b>Forge/);
});

test('rows are clamped to 1..8 and fall back to 4 for nonsense', () => {
  assert.equal(count(sk.skeletonHtml({ rows: 0 }), /class="skeleton-row"/g), 4);   // 0 is not a usable count -> default
  assert.equal(count(sk.skeletonHtml({ rows: 1 }), /class="skeleton-row"/g), 1);
  assert.equal(count(sk.skeletonHtml({ rows: 8 }), /class="skeleton-row"/g), 8);
  assert.equal(count(sk.skeletonHtml({ rows: 50 }), /class="skeleton-row"/g), 8);
  assert.equal(count(sk.skeletonHtml({ rows: -3 }), /class="skeleton-row"/g), 1);
  assert.equal(count(sk.skeletonHtml({ rows: 'abc' }), /class="skeleton-row"/g), 4);
  assert.equal(count(sk.skeletonHtml({ rows: 2.6 }), /class="skeleton-row"/g), 3);
});

test('line widths rotate per row so the list does not look stamped out', () => {
  const a = sk.skeletonRowHtml(0);
  const b = sk.skeletonRowHtml(1);
  assert.deepEqual([...a.matchAll(/width:(\d+)%/g)].map((m) => Number(m[1])), [90, 70, 45]);
  assert.deepEqual([...b.matchAll(/width:(\d+)%/g)].map((m) => Number(m[1])), [70, 45, 90]);
  assert.notEqual(a, b);
});

test('constants: a 1.4 s sweep and at most 8 rows', () => {
  assert.equal(sk.SKELETON_SWEEP_MS, 1400);
  assert.equal(sk.SKELETON_MAX_ROWS, 8);
  assert.deepEqual(sk.SKELETON_LINE_WIDTHS, [90, 70, 45]);
});

test('showTabSkeleton replaces #main and reports whether it could', () => {
  const main = { innerHTML: '<table>old tab</table>' };
  global.document = { getElementById: (id) => (id === 'main' ? main : null) };
  assert.equal(sk.showTabSkeleton(), true);
  assert.match(main.innerHTML, /data-skeleton/);
  assert.doesNotMatch(main.innerHTML, /old tab/);
  global.document = { getElementById: () => null };
  assert.equal(sk.showTabSkeleton(), false);
  delete global.document;
  assert.equal(sk.showTabSkeleton(), false);
});

test('page wiring: switchToTab shows it, plugin tab placeholders reuse it, index.html loads it and styles the 1.4 s sweep with a reduced-motion stop', () => {
  const core = fs.readFileSync(path.join(__dirname, 'core-ui.js'), 'utf8');
  const sw = core.slice(core.indexOf('function switchToTab'), core.indexOf('function renderTabButton'));
  assert.match(sw, /renderNav\(\);\n\s*if \(typeof showTabSkeleton === 'function'\) showTabSkeleton\(\);/);
  assert.ok(sw.indexOf('showTabSkeleton') < sw.indexOf("if (key === 'project') enterProjectTab()"), 'the skeleton goes up before the tab starts loading');
  assert.match(core, /skeletonHtml\(\{ caption: `Starting \$\{tab\.label\}\.\.\.` \}\)/);
  assert.match(core, /skeletonHtml\(\{ caption: `Loading \$\{tab\.label\}\.\.\.` \}\)/);
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'index.html'), 'utf8');
  assert.match(html, /<script src="\/static\/js\/skeleton\.js"><\/script>/);
  assert.match(html, /animation: skeleton-sweep 1\.4s linear infinite/);
  assert.match(html, /@keyframes skeleton-sweep \{ to \{ transform: translateX\(100%\); \} \}/);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\) \{ \.skeleton-title::after, \.skeleton-block::after, \.skeleton-line::after \{ animation: none; \} \}/);
});
