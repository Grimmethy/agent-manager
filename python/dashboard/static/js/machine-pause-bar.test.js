'use strict';

// machine-pause-bar.js: the Pause / Resume this machine and Pause / Resume everything bar of the Workers tab. A plain global <script> holding only declarations, so it
// loads into a bare vm context together with worker-switch-ui.js (which provides workerSwitchEsc and calls renderMachinePauseBar from wireWorkerSwitchButtons).
// fetch, showToast and renderWorkers are injected as fakes.
// Run: node --test python/dashboard/static/js/machine-pause-bar.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load(extra = {}) {
  const calls = { fetch: [], toasts: [], renders: 0 };
  const ctx = vm.createContext({
    showToast: (m) => calls.toasts.push(m),
    renderWorkers: async () => { calls.renders += 1; },
    fetch: async (url, init) => { calls.fetch.push({ url, init }); return { ok: true, status: 200, json: async () => ({}) }; },
    ...extra,
  });
  for (const file of ['worker-switch-ui.js', 'machine-pause-bar.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), ctx, { filename: file });
  return { ctx, calls };
}
const call = (ctx, expr, arg) => { ctx.__arg = arg; return vm.runInContext(`${expr}(__arg)`, ctx); };

const pauseMarker = (over = {}) => ({ scope: 'node', reason: '', source: 'operator', setAt: '2026-11-11T12:00:00.000Z', expiresAt: null, ...over });
const idleStatus = { node: null, global: null, workers: [] };

test('buildMachinePauseHtml: nothing without a usable status', () => {
  const { ctx } = load();
  for (const bad of [null, undefined, 'x', 5]) assert.equal(call(ctx, 'buildMachinePauseHtml', bad), '');
});

test('buildMachinePauseHtml: idle offers Pause this machine and Pause everything (next paused true) and no note', () => {
  const { ctx } = load();
  const html = call(ctx, 'buildMachinePauseHtml', idleStatus);
  assert.match(html, /^<div class="machine-pause-bar">/);
  assert.match(html, /data-scope="node" data-next-paused="true"[^>]*>⏸ Pause this machine<\/button>/);
  assert.match(html, /data-scope="global" data-next-paused="true"[^>]*>⏸ Pause everything<\/button>/);
  assert.ok(!html.includes('machine-pause-note'));
});

test('buildMachinePauseHtml: an active node pause offers Resume this machine and says who, why and until when; the global button stays Pause', () => {
  const { ctx } = load();
  const html = call(ctx, 'buildMachinePauseHtml', { ...idleStatus, node: pauseMarker({ source: 'site-traffic', reason: 'site in use', expiresAt: new Date(2026, 10, 11, 9, 5).toISOString() }) });
  assert.match(html, /data-scope="node" data-next-paused="false"[^>]*>▶ Resume this machine<\/button>/);
  assert.match(html, /data-scope="global" data-next-paused="true"[^>]*>⏸ Pause everything<\/button>/);
  assert.match(html, /This machine paused by site-traffic \(site in use\), until 09:05/);
});

test('buildMachinePauseHtml: an active global pause offers Resume everything, a pause with no expiry says until resumed, and both notes can show', () => {
  const { ctx } = load();
  const html = call(ctx, 'buildMachinePauseHtml', { ...idleStatus, node: pauseMarker(), global: pauseMarker({ scope: 'global', source: 'dashboard' }) });
  assert.match(html, /data-scope="global" data-next-paused="false"[^>]*>▶ Resume everything<\/button>/);
  assert.match(html, /This machine paused by operator, until resumed/);
  assert.match(html, /Everything paused by dashboard, until resumed/);
});

test('buildMachinePauseHtml: an unparseable expiry reads as until resumed and hostile text in a reason or source is escaped', () => {
  const { ctx } = load();
  const html = call(ctx, 'buildMachinePauseHtml', { ...idleStatus, node: pauseMarker({ expiresAt: 'soon', reason: '<img onerror=x>', source: '"><b>' }) });
  assert.match(html, /until resumed/);
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('"><b>'));
  assert.match(html, /&lt;img onerror=x&gt;/);
});

test('setMachinePause: pausing posts to /api/pause/<scope>, resuming to /api/resume/<scope>, and success re-renders once', async () => {
  const { ctx, calls } = load();
  assert.equal(await vm.runInContext("setMachinePause('node', true)", ctx), true);
  assert.equal(await vm.runInContext("setMachinePause('global', false)", ctx), true);
  assert.deepEqual(calls.fetch.map((f) => [f.url, f.init.method]), [['/api/pause/node', 'POST'], ['/api/resume/global', 'POST']]);
  assert.deepEqual(calls.fetch.map((f) => [f.init.body, f.init.headers['Content-Type']]), [['{}', 'application/json'], ['{}', 'application/json']]);
  assert.equal(calls.renders, 2);
  assert.equal(calls.toasts.length, 0);
});

test('setMachinePause: an HTTP error shows the server description and does not re-render; so does a rejected fetch', async () => {
  const bad = load({ fetch: async () => ({ ok: false, status: 400, json: async () => ({ description: 'scope must be one of node, global' }) }) });
  assert.equal(await vm.runInContext("setMachinePause('x', true)", bad.ctx), false);
  assert.match(bad.calls.toasts[0], /Could not pause x: scope must be one of node, global/);
  assert.equal(bad.calls.renders, 0);
  const noBody = load({ fetch: async () => ({ ok: false, status: 502, json: async () => { throw new Error('html'); } }) });
  assert.equal(await vm.runInContext("setMachinePause('node', false)", noBody.ctx), false);
  assert.match(noBody.calls.toasts[0], /Could not resume node: HTTP 502/);
  const down = load({ fetch: async () => { throw new Error('offline'); } });
  assert.equal(await vm.runInContext("setMachinePause('node', true)", down.ctx), false);
  assert.match(down.calls.toasts[0], /Could not pause node: offline/);
  assert.equal(down.calls.renders, 0);
});

function fakeRoot() {
  const r = { html: [], removed: 0, btns: [], oldBar: true };
  r.querySelector = (sel) => (sel === '.machine-pause-bar' && r.oldBar ? { remove: () => { r.removed += 1; r.oldBar = false; } } : null);
  r.insertAdjacentHTML = (pos, html) => { r.html.push([pos, html]); };
  r.querySelectorAll = (sel) => (sel === '.machine-pause-btn' ? r.btns : []);
  return r;
}

test('renderMachinePauseBar: reads /api/pause, removes a stale bar and inserts the new one at the top, then wires its buttons', async () => {
  const seen = [];
  const { ctx, calls } = load({ fetch: async (url, init) => { seen.push(url); return { ok: true, status: 200, json: async () => idleStatus }; } });
  const root = fakeRoot();
  const btn = { dataset: { scope: 'node', nextPaused: 'true' }, disabled: false, onclick: null };
  root.btns = [btn];
  ctx.__root = root;
  await vm.runInContext('renderMachinePauseBar(__root)', ctx);
  assert.deepEqual(seen, ['/api/pause']);
  assert.equal(root.removed, 1);
  assert.equal(root.html.length, 1);
  assert.equal(root.html[0][0], 'afterbegin');
  assert.match(root.html[0][1], /machine-pause-bar/);
  let stopped = 0;
  btn.onclick({ stopPropagation: () => { stopped += 1; } });
  await new Promise((r) => setImmediate(r));
  assert.equal(stopped, 1);
  assert.equal(btn.disabled, true);
  assert.deepEqual(seen, ['/api/pause', '/api/pause/node']);
  assert.equal(calls.renders, 1);
});

test('renderMachinePauseBar: fails soft (no bar, no toast) when the status cannot be read, and ignores a root without DOM methods', async () => {
  for (const f of [async () => { throw new Error('down'); }, async () => ({ ok: false, status: 500, json: async () => ({}) })]) {
    const { ctx, calls } = load({ fetch: f });
    const root = fakeRoot();
    ctx.__root = root;
    await vm.runInContext('renderMachinePauseBar(__root)', ctx);
    assert.equal(root.html.length, 0);
    assert.equal(calls.toasts.length, 0);
  }
  const { ctx, calls } = load();
  ctx.__root = { querySelectorAll: () => [] };
  await vm.runInContext('renderMachinePauseBar(__root)', ctx);
  await vm.runInContext('renderMachinePauseBar(null)', ctx);
  assert.equal(calls.fetch.length, 0);
});

test('wireWorkerSwitchButtons also draws the machine pause bar', async () => {
  const seen = [];
  const { ctx } = load({ fetch: async (url) => { seen.push(url); return { ok: true, status: 200, json: async () => idleStatus }; } });
  const root = fakeRoot();
  root.oldBar = false;
  ctx.__root = root;
  vm.runInContext('wireWorkerSwitchButtons(__root)', ctx);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, ['/api/pause']);
  assert.equal(root.html.length, 1);
});

test('wiring: index.html loads machine-pause-bar.js after worker-switch-ui.js and styles the bar', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'index.html'), 'utf8');
  const a = html.indexOf('static/js/worker-switch-ui.js');
  const b = html.indexOf('static/js/machine-pause-bar.js');
  assert.ok(a > -1 && b > a, 'machine-pause-bar.js is loaded after worker-switch-ui.js');
  assert.match(html, /\.machine-pause-bar \{ display: flex; flex-wrap: wrap;/);
});

test('buildMachinePauseHtml: each note says which machines it covers in its title', () => {
  const { ctx } = load();
  const nodeOnly = call(ctx, 'buildMachinePauseHtml', { ...idleStatus, node: pauseMarker() });
  assert.match(nodeOnly, /title="Workers on this machine claim nothing new while this lasts/);
  const globalOnly = call(ctx, 'buildMachinePauseHtml', { ...idleStatus, global: pauseMarker({ scope: 'global' }) });
  assert.match(globalOnly, /title="Workers on every machine claim nothing new while this lasts/);
});

test('renderMachinePauseBar: a root that can insert HTML but cannot querySelector is ignored without a request', async () => {
  const { ctx, calls } = load();
  ctx.__root = { insertAdjacentHTML: () => { throw new Error('must not insert'); }, querySelectorAll: () => [] };
  await vm.runInContext('renderMachinePauseBar(__root)', ctx);
  assert.equal(calls.fetch.length, 0);
});
