'use strict';

// buildRequiredPluginsBannerHtml / loadRequiredPluginsBanner (required-plugins-banner.js): a plain global <script>, loaded into a bare vm context (like cloud-spend-panel.test.js).
// Run: node --test python/dashboard/static/js/required-plugins-banner.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, 'required-plugins-banner.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'index.html'), 'utf8');

function load(extra = {}) {
  const ctx = vm.createContext({ ...extra });
  vm.runInContext(SRC, ctx, { filename: 'required-plugins-banner.js' });
  return ctx;
}
const build = (body) => vm.runInContext(`buildRequiredPluginsBannerHtml(${JSON.stringify(body)})`, load());

const hub = (over = {}) => ({ name: 'agent-manager-hub-tasks', range: '^0.1.0', found: null, status: 'MISSING', message: 'not installed', ...over });

test('nothing to show for ok true, non-objects and no payload', () => {
  assert.equal(build({ ok: true, results: [hub({ status: 'ok' })] }), '');
  assert.equal(build(null), '');
  assert.equal(build('x'), '');
});

test('each unmet status renders its own line and an ok plugin is not listed', () => {
  const html = build({ ok: false, results: [hub(), hub({ name: 'p2', status: 'OUT_OF_RANGE', range: '^2.0.0', message: 'found 1.0.0' }), hub({ name: 'p3', status: 'NO_VERSION', message: 'no version' }), hub({ name: 'fine', status: 'ok' })] });
  assert.match(html, /Required plugins not met:<\/strong> agent-manager cannot start its pipeline until this is fixed\./);
  assert.match(html, /agent-manager-hub-tasks \(MISSING, needs \^0\.1\.0\): not installed/);
  assert.match(html, /p2 \(OUT_OF_RANGE, needs \^2\.0\.0\): found 1\.0\.0/);
  assert.match(html, /p3 \(NO_VERSION/);
  assert.doesNotMatch(html, /fine/);
});

test('a check that could not run says so, and an ok:false body with nothing unmet still gives the heading', () => {
  assert.match(build({ ok: false, error: 'the check exited 2: bad config', results: [] }), /The required-plugins check could not run: the check exited 2: bad config/);
  assert.match(build({ ok: false, results: [] }), /Required plugins not met/);
});

test('HTML in a name, a message or an error is escaped', () => {
  const html = build({ ok: false, results: [hub({ name: '<img src=x>', message: '"><script>' })] });
  assert.doesNotMatch(html, /<img|<script/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.match(build({ ok: false, error: '<b>x</b>' }), /&lt;b&gt;x&lt;\/b&gt;/);
});

function fakePage(fetchImpl) {
  const el = { hidden: true, innerHTML: '' };
  const listeners = [];
  const document = { readyState: 'complete', getElementById: (id) => (id === 'required-plugins-banner' ? el : null), addEventListener: (n, f) => listeners.push([n, f]) };
  const ctx = load({ document, fetch: fetchImpl });
  return { el, ctx, listeners };
}
const flush = () => new Promise((r) => setImmediate(r));
const json = (body) => async () => ({ json: async () => body });

test('load: an unmet body shows the banner, ok true hides it', async () => {
  const bad = fakePage(json({ ok: false, results: [hub()] }));
  await flush();
  assert.equal(bad.el.hidden, false);
  assert.match(bad.el.innerHTML, /MISSING/);
  const good = fakePage(json({ ok: true, results: [] }));
  await flush();
  assert.equal(good.el.hidden, true);
  assert.equal(good.el.innerHTML, '');
});

test('load: a rejected fetch or invalid JSON leaves the banner hidden and does not throw', async () => {
  const rejected = fakePage(async () => { throw new Error('offline'); });
  const invalid = fakePage(async () => ({ json: async () => { throw new SyntaxError('bad'); } }));
  await flush();
  assert.equal(rejected.el.hidden, true);
  assert.equal(invalid.el.hidden, true);
});

test('load waits for DOMContentLoaded while the document is loading, and a bare context does nothing', async () => {
  const el = { hidden: true, innerHTML: '' };
  const listeners = [];
  const document = { readyState: 'loading', getElementById: () => el, addEventListener: (n, f) => listeners.push(n) };
  let calls = 0;
  load({ document, fetch: async () => { calls += 1; return { json: async () => ({ ok: true }) }; } });
  assert.deepEqual(listeners, ['DOMContentLoaded']);
  assert.equal(calls, 0);
  assert.doesNotThrow(() => load());
});

test('no timer of any kind, and index.html wires the banner (div under the header, script after cloud-spend-panel.js)', () => {
  assert.doesNotMatch(SRC, /setInterval|setTimeout/);
  assert.match(INDEX, /<\/header>\s*<div id="required-plugins-banner" role="alert" hidden><\/div>\s*<div class="layout" id="layout">/);
  assert.ok(INDEX.indexOf('/static/js/cloud-spend-panel.js') < INDEX.indexOf('/static/js/required-plugins-banner.js'));
  assert.match(INDEX, /#required-plugins-banner \{[^}]*var\(--bad\)/);
});
