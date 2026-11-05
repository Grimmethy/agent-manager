'use strict';

// buildPipelineOpsWorkerHtml / renderPipelineOpsWorkersSection (pipeline-ops-workers-panel.js): a plain global <script> of pure string builders, loaded into a bare vm context like
// needswork-worker-panel.test.js. Run: node --test python/dashboard/static/js/pipeline-ops-workers-panel.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load() {
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'pipeline-ops-workers-panel.js'), 'utf8'), ctx, { filename: 'pipeline-ops-workers-panel.js' });
  return ctx;
}
const call = (fn, ...args) => vm.runInContext(`${fn}(${args.map((a) => JSON.stringify(a)).join(',')})`, load());
const build = (name, p) => call('buildPipelineOpsWorkerHtml', name, p);
const section = (p) => call('renderPipelineOpsWorkersSection', p);
const buildOpen = (name, p) => { const ctx = load(); vm.runInContext(`poWorkerExpanded[${JSON.stringify(name)}] = true`, ctx); return vm.runInContext(`buildPipelineOpsWorkerHtml(${JSON.stringify(name)},${JSON.stringify(p)})`, ctx); };

const hold = (n, over = {}) => ({ key: `repo-${n}`, question: `Question ${n}?`, recommendation: `Answer ${n}`, at: '2026-11-04T05:00:00Z', ageS: 3600, ...over });
const live = (over = {}) => ({
  configured: true, name: 'scout', mode: 'dry-run', switch: { disabled: false, disabledAt: null }, trigger: { state: 'listening', checkedAgeS: 12, endedAgeS: 90, stopped: 'idle' }, lastTickAgeS: 125,
  decisions: 7, actedToday: 5, failedToday: 0, items: { total: 9, byOutcome: { 'NO-NEW-POLLS': 4 } }, holdCount: 0, holds: [],
  today: { 'FILE-TASK': 3, 'NO-NEW-POLLS': 2, 'BASELINE-CREATED': 1 },
  recent: [{ at: '2026-11-04T05:37:18Z', key: 'alpha', outcome: 'NO-NEW-POLLS', mode: 'dry-run', action: 'none', result: 'no action', reason: 'nothing new' }], ...over,
});

test('nothing is drawn unless a worker has left a trace; unconfigured workers draw nothing', () => {
  assert.equal(section(null), '');
  assert.equal(section({}), '');
  assert.equal(section({ workers: {} }), '');
  assert.equal(section({ workers: { scout: { configured: false, name: 'scout' }, checker: { configured: false } } }), '');
  assert.equal(build('scout', { configured: false }), '');
  assert.equal(build('scout', null), '');
});

test('one card per configured worker, in the fixed order, with unknown workers last', () => {
  const html = section({ workers: { steward: live({ name: 'steward' }), custom: live({ name: 'custom' }), scout: live(), merger: { configured: false }, checker: live({ name: 'checker' }) } });
  const ids = [...html.matchAll(/id="po-worker-panel-([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['scout', 'checker', 'steward', 'custom']);
  assert.match(html, /🔎 poll scout/);
  assert.match(html, /✅ merge-ready checker/);
  assert.match(html, /📉 idle-cost steward/);
});

test('the card has the id, the mode and trigger badges, the age of the last tick, the meta line and the switch', () => {
  const html = build('scout', live());
  assert.match(html, /<span class="id">🔎 poll scout<\/span>/);
  assert.match(html, /<span class="badge hold"[^>]*>dry-run<\/span>/);
  assert.match(html, /<span class="badge ok"[^>]*>listening<\/span>/);
  assert.match(html, /last tick 2m ago/);
  assert.match(html, /5 acted today/);
  assert.match(html, /9 items with a decision/);
  assert.match(html, /trigger checked 12s ago/);
  assert.match(html, /today: FILE-TASK 3 · NO-NEW-POLLS 2 · BASELINE-CREATED 1/);
  assert.match(html, /data-po-worker-expand="scout"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /▸ Show history \(7 decisions\)/);
  assert.match(html, /⏻ Turn off/);
  assert.match(html, /data-po-worker="scout" data-next-enabled="false"/);
});

test('mode badges: live, off, dry-run, and no runs yet', () => {
  assert.match(build('scout', live({ mode: 'on' })), /<span class="badge ok"[^>]*>live<\/span>/);
  assert.match(build('merger', live({ mode: 'on' })), /merges branches the checker approved/);
  assert.match(build('scout', live({ mode: 'off' })), /<span class="badge idle"[^>]*>off<\/span>/);
  assert.match(build('scout', live({ mode: null })), /no runs yet/);
});

test('trigger badges: listening, draining, silent, backlog, idle, and none yet', () => {
  const t = (trigger) => build('scout', live({ trigger }));
  assert.match(t({ state: 'draining' }), />draining<\/span>/);
  assert.match(t({ state: 'idle', checkedAgeS: 10 }), />trigger on<\/span>/);
  assert.match(t({ state: 'backlog', checkedAgeS: 10 }), />backlog<\/span>/);
  assert.match(t({ state: 'idle', checkedAgeS: 301 }), />trigger silent<\/span>/);
  assert.match(t({ state: 'listening', checkedAgeS: 301 }), />listening<\/span>/);   // a drain that is up and listening needs no watchdog to react
  assert.match(t({ state: 'idle', checkedAgeS: 299 }), />trigger on<\/span>/);
  assert.match(t({ state: 'idle', checkedAgeS: 300 }), />trigger on<\/span>/);        // exactly the limit is still on time
  assert.match(t(null), />no trigger yet<\/span>/);
  assert.doesNotMatch(t(null), /trigger checked/);
  assert.match(t({ state: 'idle', checkedAgeS: 5, endedAgeS: 90, stopped: 'idle' }), /The last drain ended 1m ago \(idle\)/);
});

test('ages: seconds, minutes, hours with minutes, days with hours; unknown is empty', () => {
  const age = (n) => vm.runInContext(`poWorkerAge(${n})`, load());
  assert.deepEqual([age(45), age(125), age(7300), age(47 * 3600 + 120), age(48 * 3600), age(200000)], ['45s', '2m', '2h 1m', '47h 2m', '2d 0h', '2d 7h']);
  assert.deepEqual([age(-1), age('null'), age('NaN')], ['', '', '']);
});

test('a switched-off worker says switched off, dims the card and offers Turn on', () => {
  const html = build('scout', live({ switch: { disabled: true, disabledAt: '2026-11-04T05:00:00Z' } }));
  assert.match(html, /switched off/);
  assert.match(html, /since 2026-11-04T05:00:00Z/);
  assert.match(html, /worker-off/);
  assert.match(html, /⏻ Turn on/);
  assert.match(html, /data-next-enabled="true"/);
  assert.doesNotMatch(html, />dry-run<\/span>/);
});

test('failures are shown as a warning badge and a quiet day says so', () => {
  assert.match(build('scout', live({ failedToday: 2 })), /2 failed<\/span>/);
  assert.doesNotMatch(build('scout', live({ failedToday: 0 })), /failed</);
  assert.match(build('scout', live({ items: { total: 0, byOutcome: {} } })), /nothing decided yet/);
  assert.match(build('scout', live({ today: {} })), /no decisions today/);
  assert.match(build('scout', live({ lastTickAgeS: null })), /no tick recorded yet/);
});

test('questions waiting for the owner: two shown collapsed with the rest counted, all shown open, each cut with the full text in the tooltip', () => {
  const holds = [hold(1), hold(2), hold(3, { question: 'Q'.repeat(200), recommendation: null, ageS: null })];
  const closed = build('scout', live({ holds, holdCount: 5 }));
  assert.equal((closed.match(/badge warn">question/g) || []).length, 2);
  assert.match(closed, /\+3 more waiting/);
  assert.match(closed, /Question 1\? → Answer 1 · repo-1 · 1h 0m/);
  const open = buildOpen('scout', live({ holds, holdCount: 3 }));
  assert.equal((open.match(/badge warn">question/g) || []).length, 3);
  assert.doesNotMatch(open, /more waiting/);
  assert.ok(open.includes('Q'.repeat(89) + '…'));
  assert.ok(!open.includes('Q'.repeat(90) + '…'));
  assert.ok(open.includes('title="' + 'Q'.repeat(200) + '"'));
  assert.doesNotMatch(build('scout', live({ holds: [] })), /question/);
});

test('open: the history lists the recent decisions with the time, outcome, key, mode and result; collapsed it does not', () => {
  const open = buildOpen('scout', live());
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /▾ Hide history/);
  assert.match(open, /<strong>🔎 poll scout history<\/strong>/);
  assert.match(open, /05:37 · NO-NEW-POLLS · alpha · dry-run · no action/);
  assert.match(open, /<strong>Today<\/strong> FILE-TASK 3/);
  assert.match(buildOpen('scout', live({ recent: [] })), /No decisions recorded yet/);
  assert.doesNotMatch(build('scout', live()), /history<\/strong>/);
  assert.match(buildOpen('scout', live({ recent: [{ at: null, key: 'a', outcome: null, mode: 'on', result: null, reason: null }] })), /· no outcome · a/);
});

test('cards are expanded one by one', () => {
  const ctx = load();
  vm.runInContext('poWorkerExpanded.scout = true', ctx);
  const html = vm.runInContext(`renderPipelineOpsWorkersSection(${JSON.stringify({ workers: { scout: live(), checker: live({ name: 'checker' }) } })})`, ctx);
  assert.match(html, /id="po-worker-panel-scout"[^>]*aria-expanded="true"/);
  assert.match(html, /id="po-worker-panel-checker"[^>]*aria-expanded="false"/);
});

test('everything from the payload is escaped', () => {
  const html = buildOpen('scout', live({ holds: [hold(1, { question: '<img src=x onerror=alert(1)>', key: '"><script>' })], holdCount: 1, recent: [{ at: '2026-11-04T05:37:18Z', key: '<b>k</b>', outcome: '<i>', mode: 'on', result: '"r"', reason: '<s>' }] }));
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<b>k/);
  assert.match(html, /&lt;img src=x/);
});

test('the Turn on/off button posts to the worker route, toasts a failure, and the wiring flips one card', async () => {
  const ctx = load();
  const calls = [];
  ctx.fetch = async (url, init) => { calls.push([url, JSON.parse(init.body)]); return { ok: true, json: async () => ({}) }; };
  let redraws = 0;
  ctx.renderWorkers = async () => { redraws += 1; };
  ctx.showToast = () => {};
  assert.equal(await vm.runInContext('setPipelineOpsWorkerEnabled("scout", false)', ctx), true);
  assert.deepEqual(calls, [['/api/pipeline-ops-workers/scout/enabled', { enabled: false }]]);
  assert.equal(redraws, 1);
  const toasts = [];
  ctx.showToast = (m) => toasts.push(m);
  ctx.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: 'disk full' }) });
  assert.equal(await vm.runInContext('setPipelineOpsWorkerEnabled("scout", true)', ctx), false);
  assert.match(toasts[0], /scout worker on: disk full/);
  ctx.fetch = async () => ({ ok: false, status: 404, json: async () => { throw new Error('no body'); } });
  assert.equal(await vm.runInContext('setPipelineOpsWorkerEnabled("scout", false)', ctx), false);
  assert.match(toasts[1], /off: HTTP 404/);
  ctx.fetch = async () => { throw new Error('offline'); };
  assert.equal(await vm.runInContext('setPipelineOpsWorkerEnabled("scout", false)', ctx), false);
  assert.match(toasts[2], /off: offline/);
  assert.equal(redraws, 1);

  // wiring: a click on the button posts with the worker and the next state; a click on a card flips only that card
  const clicks = [];
  const btn = { dataset: { poWorker: 'checker', nextEnabled: 'true' }, disabled: false, onclick: null };
  const card = { dataset: { poWorkerExpand: 'checker' }, onclick: null };
  const root = { querySelectorAll: (sel) => (sel === '.po-worker-switch-btn' ? [btn] : sel === '[data-po-worker-expand]' ? [card] : []) };
  ctx.fetch = async (url, init) => { clicks.push([url, JSON.parse(init.body)]); return { ok: true, json: async () => ({}) }; };
  vm.runInContext('wirePipelineOpsWorkerSwitch', ctx)(root);
  let stopped = false;
  await btn.onclick({ stopPropagation: () => { stopped = true; } });
  assert.equal(stopped, true);
  assert.deepEqual(clicks, [['/api/pipeline-ops-workers/checker/enabled', { enabled: true }]]);
  assert.equal(btn.disabled, true);                                   // success: the tab redraws, the old button stays disabled
  btn.dataset.nextEnabled = 'false';
  await btn.onclick({ stopPropagation: () => {} });
  assert.deepEqual(clicks[1], ['/api/pipeline-ops-workers/checker/enabled', { enabled: false }]);
  ctx.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: 'x' }) });
  await btn.onclick({ stopPropagation: () => {} });
  assert.equal(btn.disabled, false);                                  // failure: the button is usable again
  vm.runInContext('wirePipelineOpsWorkerExpand', ctx)(root, () => { redraws += 100; });
  card.onclick();
  assert.equal(vm.runInContext('poWorkerExpanded.checker', ctx), true);
  assert.equal(vm.runInContext('poWorkerExpanded.scout === true', ctx), false);
  card.onclick();
  assert.equal(vm.runInContext('poWorkerExpanded.checker', ctx), false);
  assert.equal(redraws, 203);
});

test('workers-tab.js fetches, renders and wires the cards, app.py registers the route and index.html loads the script after the context panel', () => {
  const tab = fs.readFileSync(path.join(__dirname, 'workers-tab.js'), 'utf8');
  assert.match(tab, /fetchJson\('\/api\/pipeline-ops-workers'\)\.catch\(\(\) => null\)/);
  assert.match(tab, /renderPipelineOpsWorkersSection\(pipelineOpsWorkers\)/);
  // the call is its own term of the concatenation, not the else branch of the context cards' ternary (found in the real browser: the cards were dropped whenever the context renderer existed)
  assert.match(tab, /renderContextWorkerSection\(contextMapWorker, contextMemoryWorker\) : ''\) \+ \(typeof renderPipelineOpsWorkersSection === 'function' \? renderPipelineOpsWorkersSection\(pipelineOpsWorkers\) : ''\)/);
  assert.match(tab, /if \(typeof wirePipelineOpsWorkerSwitch === 'function'\) wirePipelineOpsWorkerSwitch\(main\);/);
  assert.match(tab, /if \(typeof wirePipelineOpsWorkerExpand === 'function'\) wirePipelineOpsWorkerExpand\(main, renderWorkers\);/);
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'index.html'), 'utf8');
  assert.ok(html.indexOf('/static/js/pipeline-ops-workers-panel.js') > html.indexOf('/static/js/context-worker-panel.js'));
  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'app.py'), 'utf8');
  assert.match(app, /from routes\.pipeline_ops_workers import pipeline_ops_workers_bp/);
  assert.match(app, /app\.register_blueprint\(pipeline_ops_workers_bp\)/);
});
