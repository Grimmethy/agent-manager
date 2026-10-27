'use strict';

// worker-switch-ui.js: the Workers tab Turn on / Turn off button. A plain global <script> holding only declarations, so it loads into a bare vm context
// (same approach as cloud-spend-panel.test.js). fetch, showToast and renderWorkers are injected as fakes.
// Run: node --test python/dashboard/static/js/worker-switch-ui.test.js

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
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'worker-switch-ui.js'), 'utf8'), ctx, { filename: 'worker-switch-ui.js' });
  return { ctx, calls };
}
const call = (ctx, expr, arg) => { ctx.__arg = arg; return vm.runInContext(`${expr}(__arg)`, ctx); };

const on = { instanceId: 'worker-cloud', switchable: true, disabled: false, status: 'working' };

test('workerSwitchState: null without a switch, otherwise on, off, or going off (working or idle)', () => {
  const { ctx } = load();
  const s = (inst) => call(ctx, 'workerSwitchState', inst);
  assert.equal(s(null), null);
  assert.equal(s({ instanceId: 'reviewer', status: 'idle' }), null);
  assert.equal(s({ instanceId: 'worker-cloud', switchable: false, disabled: true }), null);
  assert.equal(s({ ...on }), 'on');
  assert.equal(s({ ...on, disabled: false, status: 'offline' }), 'on');
  assert.equal(s({ ...on, disabled: true, status: 'disabled' }), 'off');
  assert.equal(s({ ...on, disabled: true, status: 'offline' }), 'off');
  assert.equal(s({ ...on, disabled: true, status: 'working' }), 'going-off-working');
  assert.equal(s({ ...on, disabled: true, status: 'queued' }), 'going-off-working');
  assert.equal(s({ ...on, disabled: true, status: 'idle' }), 'going-off-idle');
});

test('buildWorkerSwitchHtml: a worker that is on offers Turn off and sends enabled false', () => {
  const { ctx } = load();
  const html = call(ctx, 'buildWorkerSwitchHtml', on);
  assert.match(html, /class="secondary worker-switch-btn"/);
  assert.match(html, /data-instance-id="worker-cloud"/);
  assert.match(html, /data-next-enabled="false"/);
  assert.match(html, /⏻ Turn off<\/button>/);
  assert.match(html, /finishes the task it is on, then claims nothing/);
  assert.doesNotMatch(html, /badge/);
});

test('buildWorkerSwitchHtml: an off worker offers Turn on (enabled true) with no note; a worker still on a task shows turning off after this task; an idle one turning off', () => {
  const { ctx } = load();
  const off = call(ctx, 'buildWorkerSwitchHtml', { ...on, disabled: true, status: 'disabled' });
  assert.match(off, /data-next-enabled="true"/);
  assert.match(off, /⏻ Turn on<\/button>/);
  assert.doesNotMatch(off, /badge/);
  const working = call(ctx, 'buildWorkerSwitchHtml', { ...on, disabled: true, status: 'working' });
  assert.match(working, /data-next-enabled="true"/);
  assert.match(working, /<span class="badge warn"[^>]*>turning off after this task<\/span>/);
  const idle = call(ctx, 'buildWorkerSwitchHtml', { ...on, disabled: true, status: 'idle' });
  assert.match(idle, /<span class="badge warn"[^>]*>turning off…<\/span>/);
  assert.doesNotMatch(idle, /after this task/);
});

test('buildWorkerSwitchHtml: nothing for a reviewer, the watchdog or an instance without the flag, and a hostile id is escaped', () => {
  const { ctx } = load();
  for (const inst of [{ instanceId: 'reviewer', status: 'idle' }, { instanceId: 'watchdog', status: 'idle' }, { instanceId: 'worker-x', status: 'idle' }, null, undefined]) {
    assert.equal(call(ctx, 'buildWorkerSwitchHtml', inst), '');
  }
  const html = call(ctx, 'buildWorkerSwitchHtml', { ...on, instanceId: 'worker-"><img src=x onerror=alert(1)>' });
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('"><'));
  assert.match(html, /&quot;&gt;&lt;img/);
});

test('workerCardOffClass: only a switchable disabled instance dims its card', () => {
  const { ctx } = load();
  assert.equal(call(ctx, 'workerCardOffClass', { ...on, disabled: true }), ' worker-off');
  assert.equal(call(ctx, 'workerCardOffClass', { ...on, disabled: true, status: 'working' }), ' worker-off');
  assert.equal(call(ctx, 'workerCardOffClass', on), '');
  assert.equal(call(ctx, 'workerCardOffClass', { instanceId: 'reviewer', disabled: true }), '');
  assert.equal(call(ctx, 'workerCardOffClass', null), '');
});

test('setWorkerEnabled: success posts the JSON body to the encoded url and re-renders once', async () => {
  const { ctx, calls } = load();
  const ok = await vm.runInContext("setWorkerEnabled('worker-cloud', false)", ctx);
  assert.equal(ok, true);
  assert.equal(calls.fetch.length, 1);
  assert.equal(calls.fetch[0].url, '/api/instances/worker-cloud/enabled');
  assert.equal(calls.fetch[0].init.method, 'POST');
  assert.equal(calls.fetch[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls.fetch[0].init.body), { enabled: false });
  assert.equal(calls.renders, 1);
  assert.deepEqual(calls.toasts, []);
  await vm.runInContext("setWorkerEnabled('worker-3090', true)", ctx);
  assert.deepEqual(JSON.parse(calls.fetch[1].init.body), { enabled: true });
});

test('setWorkerEnabled: an HTTP error shows the server description in a toast and does not re-render; so does a rejected fetch', async () => {
  const http = load({ fetch: async () => ({ ok: false, status: 404, json: async () => ({ description: "'worker-typo' is not a defined worker lane" }) }) });
  assert.equal(await vm.runInContext("setWorkerEnabled('worker-typo', false)", http.ctx), false);
  assert.equal(http.calls.renders, 0);
  assert.equal(http.calls.toasts.length, 1);
  assert.match(http.calls.toasts[0], /Could not switch worker-typo off: 'worker-typo' is not a defined worker lane/);
  const plain = load({ fetch: async () => ({ ok: false, status: 500, json: async () => { throw new Error('not json'); } }) });
  assert.equal(await vm.runInContext("setWorkerEnabled('worker-cloud', true)", plain.ctx), false);
  assert.match(plain.calls.toasts[0], /Could not switch worker-cloud on: HTTP 500/);
  const down = load({ fetch: async () => { throw new Error('network down'); } });
  assert.equal(await vm.runInContext("setWorkerEnabled('worker-cloud', false)", down.ctx), false);
  assert.match(down.calls.toasts[0], /Could not switch worker-cloud off: network down/);
  assert.equal(down.calls.renders, 0);
});

test('wireWorkerSwitchButtons: a click stops the card from expanding, disables the button and posts the right value', async () => {
  const { ctx, calls } = load();
  const mkBtn = (id, next) => ({ dataset: { instanceId: id, nextEnabled: next }, disabled: false, onclick: null });
  const offBtn = mkBtn('worker-cloud', 'false');
  const onBtn = mkBtn('worker-3090', 'true');
  ctx.__root = { querySelectorAll: (sel) => (sel === '.worker-switch-btn' ? [offBtn, onBtn] : []) };
  vm.runInContext('wireWorkerSwitchButtons(__root)', ctx);
  let stopped = 0;
  offBtn.onclick({ stopPropagation: () => { stopped += 1; } });
  onBtn.onclick({ stopPropagation: () => { stopped += 1; } });
  await new Promise((r) => setImmediate(r));
  assert.equal(stopped, 2);
  assert.equal(offBtn.disabled, true);
  assert.equal(onBtn.disabled, true);
  assert.deepEqual(calls.fetch.map((f) => [f.url, JSON.parse(f.init.body).enabled]), [['/api/instances/worker-cloud/enabled', false], ['/api/instances/worker-3090/enabled', true]]);
});

test('wiring: workers-tab.js has the three guarded hooks and index.html loads worker-switch-ui.js after workers-tab.js with the dimming rule', () => {
  const tab = fs.readFileSync(path.join(__dirname, 'workers-tab.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'index.html'), 'utf8');
  assert.match(tab, /worker-card clickable\$\{typeof workerCardOffClass === 'function' \? workerCardOffClass\(inst\) : ''\}/);
  assert.match(tab, /\$\{typeof buildWorkerSwitchHtml === 'function' \? buildWorkerSwitchHtml\(inst\) : ''\}/);
  assert.match(tab, /if \(typeof wireWorkerSwitchButtons === 'function'\) wireWorkerSwitchButtons\(main\);/);
  const a = html.indexOf('static/js/workers-tab.js');
  const b = html.indexOf('static/js/worker-switch-ui.js');
  assert.ok(a > -1 && b > a, 'worker-switch-ui.js is loaded after workers-tab.js');
  assert.match(html, /\.worker-card\.worker-off \{ opacity: \.65; \}/);
});
