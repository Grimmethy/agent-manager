'use strict';

// buildNeedsworkWorkerHtml / renderNeedsworkWorkerSection (needswork-worker-panel.js): a plain global <script> of pure string builders, loaded into a bare vm context like
// verifier-worker-panel.test.js. Run: node --test python/dashboard/static/js/needswork-worker-panel.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load() {
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'needswork-worker-panel.js'), 'utf8'), ctx, { filename: 'needswork-worker-panel.js' });
  return ctx;
}
const call = (fn, ...args) => vm.runInContext(`${fn}(${args.map((a) => JSON.stringify(a)).join(',')})`, load());
const build = (p) => call('buildNeedsworkWorkerHtml', p);
const section = (p) => call('renderNeedsworkWorkerSection', p);
const buildOpen = (p) => { const ctx = load(); vm.runInContext('needsworkWorkerExpanded = true', ctx); return vm.runInContext(`buildNeedsworkWorkerHtml(${JSON.stringify(p)})`, ctx); };

const hold = (n, over = {}) => ({ branch: `agent/b${n}`, project: 'alpha', question: `Question ${n}?`, recommendation: `Answer ${n}`, at: '2026-11-03T05:00:00Z', ageS: 3600, ...over });
const live = (over = {}) => ({
  configured: true, mode: 'on', switch: { disabled: false, disabledAt: null }, trigger: { state: 'idle', checkedAgeS: 12, endedAgeS: 90, stopped: 'idle' }, lastTickAgeS: 125, decisions: 7,
  actedToday: 5, failedToday: 0, backlog: { total: 9, byOutcome: { 'HOLD-FOR-OWNER': 4 } }, holdCount: 0, holds: [],
  today: { 'FILE-REPLACEMENT-TASK': 3, 'HOLD-FOR-OWNER': 2, 'REDRAFT-DELEGATED': 1 },
  recent: [{ at: '2026-11-03T05:37:18Z', project: 'alpha', branch: 'agent/x-1', outcome: 'HOLD-FOR-OWNER', mode: 'on', result: 'held', reason: 'rival stacks' }], ...over,
});

test('nothing is drawn unless the worker has left a trace', () => {
  for (const p of [undefined, null, {}, { configured: false }]) { assert.equal(build(p), ''); assert.equal(section(p), ''); }
  assert.match(section(live()), /id="needswork-worker-panel"/);
});

test('same card template as the lane workers: id left, badge column right, one meta line', () => {
  const h = build(live());
  assert.match(h, /class="worker-card clickable"/);
  assert.match(h, /<span class="id">[^<]*needs-work<\/span><div class="badge-col">/);
  assert.match(h, /class="state-timer">last tick 2m ago</);
  assert.match(h, /5 acted today/);
  assert.match(h, /9 branches with a decision/);
  assert.match(h, /trigger checked 12s ago/);
  assert.match(h, /FILE-REPLACEMENT-TASK 3 · HOLD-FOR-OWNER 2 · REDRAFT-DELEGATED 1/);
});

test('mode badges: live, dry-run, off and no runs yet', () => {
  assert.match(build(live({ mode: 'on' })), /badge ok" title="[^"]*">live</);
  assert.match(build(live({ mode: 'dry-run' })), /badge hold" title="[^"]*">dry-run</);
  assert.match(build(live({ mode: 'off' })), /badge idle" title="NEEDSWORK_MODE=off[^"]*">off</);
  assert.match(build(live({ mode: null })), />no runs yet</);
});

test('a switched-off worker says so, dims the card and offers Turn on', () => {
  const h = build(live({ switch: { disabled: true, disabledAt: '2026-11-03T01:00:00.000Z' } }));
  assert.match(h, /worker-card clickable worker-off/);
  assert.match(h, />switched off</);
  assert.match(h, /since 2026-11-03T01:00:00.000Z/);
  assert.match(h, /data-next-enabled="true"[^>]*>⏻ Turn on</);
  assert.match(build(live()), /data-next-enabled="false"[^>]*>⏻ Turn off</);
  assert.doesNotMatch(build(live({ switch: { disabled: true } })), />live</);
});

test('trigger badge states come through, and a silent heartbeat does not hide a live drain', () => {
  assert.match(build(live({ trigger: { state: 'listening', checkedAgeS: 9999 } })), />listening</);
  assert.match(build(live({ trigger: { state: 'draining', checkedAgeS: 9999 } })), />draining</);
  assert.match(build(live({ trigger: { state: 'idle', checkedAgeS: 400 } })), />trigger silent</);
  assert.match(build(live({ trigger: { state: 'backlog', checkedAgeS: 5 } })), />backlog</);
  assert.match(build(live({ trigger: { state: 'idle', checkedAgeS: 5 } })), />trigger on</);
  assert.match(build(live({ trigger: null })), />no trigger yet</);
});

test('no holds draws no question rows and no empty box; exactly two show both and no "more"', () => {
  assert.doesNotMatch(build(live()), /badge warn">question/);
  assert.doesNotMatch(build(live()), /margin-top:6px"><\/div>/);
  assert.match(build(live()), /data-needswork-expand="1"/);
  const two = build(live({ holdCount: 2, holds: [hold(1), hold(2)] }));
  assert.equal((two.match(/badge warn">question</g) || []).length, 2);
  assert.doesNotMatch(two, /more waiting/);
  assert.doesNotMatch(two, /\+0 more/);
});

test('three holds show two on the collapsed card and "+1 more waiting"; the open card shows all three', () => {
  const p = live({ holdCount: 3, holds: [hold(1), hold(2), hold(3)] });
  const closed = build(p);
  assert.equal((closed.match(/badge warn">question</g) || []).length, 2);
  assert.match(closed, /\+1 more waiting/);
  const open = buildOpen(p);
  assert.equal((open.match(/badge warn">question</g) || []).length, 3);
  assert.doesNotMatch(open, /more waiting/);
});

test('the "more" count uses holdCount when the payload was capped', () => {
  const h = build(live({ holdCount: 60, holds: [hold(1), hold(2), hold(3)] }));
  assert.match(h, /\+58 more waiting/);
});

test('a question is cut at 90 characters with an ellipsis and the full text and recommendation in the tooltip; exactly 90 is not cut', () => {
  const long = 'Q'.repeat(120);
  const h = build(live({ holdCount: 1, holds: [hold(1, { question: long, recommendation: 'R'.repeat(120) })] }));
  assert.ok(h.includes('question</span> ' + 'Q'.repeat(89) + '… → '));   // visible text: 89 characters and an ellipsis
  assert.ok(h.includes('title="' + long + ' — Recommended: ' + 'R'.repeat(120) + '"'));
  const exact = build(live({ holdCount: 1, holds: [hold(1, { question: 'Q'.repeat(90), recommendation: null })] }));
  assert.ok(exact.includes('badge warn">question</span> ' + 'Q'.repeat(90) + ' ·'));
  assert.ok(!exact.includes('…'));
});

test('everything from the payload is escaped, including an HTML-looking question and branch', () => {
  const h = buildOpen(live({ holdCount: 1, holds: [hold(1, { question: '<img src=x onerror=alert(1)>', recommendation: '"><script>x</script>', branch: '<b>agent</b>' })],
    recent: [{ at: '2026-11-03T05:37:18Z', project: '<p>', branch: '<i>b</i>', outcome: '<u>o</u>', mode: 'on', result: '<s>r</s>', reason: '<em>why</em>' }] }));
  assert.doesNotMatch(h, /<img|<script|<b>|<i>|<p>|<u>|<s>|<em>/);
  assert.match(h, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('a double quote in a question cannot break out of the tooltip attribute', () => {
  const h = build(live({ holdCount: 1, holds: [hold(1, { question: 'x" onmouseover="boom', recommendation: null })] }));
  assert.doesNotMatch(h, /" onmouseover="/);
  assert.match(h, /x&quot; onmouseover=&quot;boom/);
});

test('the open card lists every outcome of today and the recent decisions; the closed card does not', () => {
  const open = buildOpen(live());
  assert.match(open, /Needs-Work history/);
  assert.match(open, /HOLD-FOR-OWNER · alpha · agent\/x-1 · held/);
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /▾ Hide history/);
  const closed = build(live());
  assert.doesNotMatch(closed, /Needs-Work history/);
  assert.match(closed, /▸ Show history \(7 decisions\)/);
  assert.match(buildOpen(live({ recent: [] })), /No decisions recorded yet/);
});

test('the meta line shows the biggest three outcomes and "+n more" beyond that', () => {
  const h = build(live({ today: { A: 5, B: 4, C: 3, D: 2 } }));
  assert.match(h, /A 5 · B 4 · C 3 \+1 more/);
  assert.match(build(live({ today: {} })), /no decisions today/);
});

test('failed actions get a warning badge; none means no badge; a zero backlog reads "no branch decided yet"', () => {
  assert.match(build(live({ failedToday: 2 })), /badge warn" title="Actions that failed[^"]*">2 failed</);
  assert.doesNotMatch(build(live({ failedToday: 0 })), /failed</);
  assert.match(build(live({ backlog: { total: 0, byOutcome: {} } })), /no branch decided yet/);
});

test('the Turn on/off button posts to the needswork route and the expand wiring flips the card', async () => {
  const ctx = load();
  const calls = [];
  ctx.fetch = async (url, init) => { calls.push([url, JSON.parse(init.body)]); return { ok: true, json: async () => ({}) }; };
  ctx.renderWorkers = async () => {};
  ctx.showToast = () => {};
  const ok = await vm.runInContext('setNeedsworkWorkerEnabled(false)', ctx);
  assert.equal(ok, true);
  assert.deepEqual(calls, [['/api/needswork-worker/enabled', { enabled: false }]]);
  ctx.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: 'disk full' }) });
  const toasts = [];
  ctx.showToast = (m) => toasts.push(m);
  assert.equal(await vm.runInContext('setNeedsworkWorkerEnabled(true)', ctx), false);
  assert.match(toasts[0], /Needs-Work worker on: disk full/);
});

test('workers-tab.js fetches, renders and wires the card, and index.html loads the script after the verifier panel', () => {
  const tab = fs.readFileSync(path.join(__dirname, 'workers-tab.js'), 'utf8');
  assert.match(tab, /fetchJson\('\/api\/needswork-worker'\)\.catch\(\(\) => null\)/);
  assert.match(tab, /renderNeedsworkWorkerSection\(needsworkWorker\)/);
  assert.match(tab, /if \(typeof wireNeedsworkWorkerSwitch === 'function'\) wireNeedsworkWorkerSwitch\(main\);/);
  assert.match(tab, /if \(typeof wireNeedsworkWorkerExpand === 'function'\) wireNeedsworkWorkerExpand\(main, renderWorkers\);/);
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'index.html'), 'utf8');
  assert.ok(html.indexOf('/static/js/needswork-worker-panel.js') > html.indexOf('/static/js/verifier-worker-panel.js'));
});
