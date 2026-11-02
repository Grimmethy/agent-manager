'use strict';

// buildStalledWorkerHtml / renderStalledWorkerSection (stalled-worker-panel.js): a plain global <script> of pure string builders, loaded into a bare vm context
// like cloud-spend-panel.test.js. Run: node --test python/dashboard/static/js/stalled-worker-panel.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load() {
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'stalled-worker-panel.js'), 'utf8'), ctx, { filename: 'stalled-worker-panel.js' });
  return ctx;
}
const call = (fn, arg) => vm.runInContext(`${fn}(${JSON.stringify(arg)})`, load());
const build = (p) => call('buildStalledWorkerHtml', p);
const section = (p) => call('renderStalledWorkerSection', p);
// The card opened by a click: the same builder after stalledWorkerExpanded was flipped.
const buildOpen = (p) => { const ctx = load(); vm.runInContext('stalledWorkerExpanded = true', ctx); return vm.runInContext(`buildStalledWorkerHtml(${JSON.stringify(p)})`, ctx); };

const live = (over = {}) => ({
  configured: true, mode: 'dry-run', timerActive: true, lastTickAgeS: 125, decisions: 7,
  stalled: { total: 580, projects: 33, topBuckets: [{ state: 'blocked', signature: 'plan cites missing-file target(s): <path>', count: 18 }] },
  today: { 'ESCALATE-MECHANISM': 5, 'ARCHIVE-DUPLICATE': 2 },
  holds: [{ taskId: 'adhoc-x-1', project: 'alpha', question: 'Which API?', ageHours: 5.5, ageS: 19800, dryRun: true }],
  recent: [{ at: '2026-11-02T11:16:31Z', project: 'alpha', taskId: 'adhoc-x-1', outcome: 'ESCALATE-MECHANISM', mode: 'dry-run', result: 'x' }],
  budget: { perHour: 5400000, used: 1350000, remaining: 4050000 }, provider: 'claude-subscription', model: 'claude-sonnet-5-5', gateway: { available: true }, ...over,
});

test('nothing is drawn unless the worker has left a trace', () => {
  for (const p of [undefined, null, {}, { configured: false }]) { assert.equal(build(p), ''); assert.equal(section(p), ''); }
  assert.match(section(live()), /id="stalled-worker-panel"/);
});

test('the title carries the mode badge and the timer badge', () => {
  const dry = build(live());
  assert.match(dry, /class="worker-card clickable"/);
  assert.match(dry, /<span class="id">[^<]*stalled-worker<\/span><div class="badge-col">/);
  assert.match(dry, /class="badge hold"[^>]*>dry-run</);
  assert.match(dry, /class="badge ok"[^>]*>timer on</);
  assert.match(build(live({ mode: 'on' })), /class="badge ok"[^>]*>live</);
  assert.match(build(live({ mode: 'off' })), /class="badge idle"[^>]*>off</);
  assert.match(build(live({ mode: null })), />no runs yet</);
  assert.match(build(live({ timerActive: false })), /class="badge warn"[^>]*>timer stopped</);
  assert.match(build(live({ timerActive: null })), />timer unknown</);
});

test('the age helper: seconds, minutes, hours with minutes, days with hours, and nothing for unknown values', () => {
  const age = (s) => call('stalledWorkerAge', s);
  assert.deepEqual([age(45), age(125), age(7300), age(3600 * 47 + 59 * 60), age(3600 * 48), age(200000)], ['45s', '2m', '2h 1m', '47h 59m', '2d 0h', '2d 7h']);
  for (const bad of [null, -1, NaN, 'x']) assert.equal(age(bad), '', String(bad));
  assert.match(build(live({ lastTickAgeS: 125 })), /last tick 2m ago/);
  assert.match(build(live({ lastTickAgeS: null })), /no tick recorded yet/);
});

test('the token budget line shows used of per-hour with a percentage, and flags a spent budget', () => {
  assert.match(build(live()), /1,350,000 of 5,400,000 tokens this hour \(25%\)/);
  assert.match(build(live()), /claude-subscription · claude-sonnet-5-5/);
  assert.match(build(live()), /<div class="meta">[^\n]*tokens this hour/);
  assert.doesNotMatch(build(live()), /budget spent/);
  assert.match(build(live({ budget: { perHour: 100, used: 100 } })), /budget spent/);
  assert.match(build(live({ budget: { perHour: 0, used: 5 } })), /\(0%\)/);
});

test('a gateway that is down says so, with the reason escaped', () => {
  const html = build(live({ budget: null, gateway: { available: false, error: '<boom> refused' } }));
  assert.match(html, /gateway not reachable \(&lt;boom&gt; refused\)/);
  assert.doesNotMatch(html, /tokens this hour/);
  assert.match(build(live({ budget: null, gateway: { available: false } })), /gateway not reachable(?! \()/);
});

test('the stalled count and the top buckets are listed, long reasons cut, empty reasons named', () => {
  const html = buildOpen(live());
  assert.match(build(live()), /580 stalled across 33 projects/);
  assert.doesNotMatch(build(live()), /plan cites missing-file/);   // the buckets are behind the click
  assert.match(html, /18 · blocked · plan cites missing-file target\(s\): &lt;path&gt;/);
  assert.match(buildOpen(live({ stalled: { total: 1, projects: 1, topBuckets: [{ state: 'blocked', signature: 'x'.repeat(300), count: 1 }] } })), /x{109}\u2026</);
  assert.doesNotMatch(buildOpen(live({ stalled: { total: 1, projects: 1, topBuckets: [{ state: 'blocked', signature: 'x'.repeat(300), count: 1 }] } })).replace(/title="[^"]*"/g, ''), /x{110}/);   // the tooltip keeps the full text
  assert.match(buildOpen(live({ stalled: { total: 1, projects: 1, topBuckets: [{ state: 'blocked', signature: '', count: 1 }] } })), /\(no reason recorded\)/);
  assert.match(build(live({ stalled: null })), /no stalled-task index yet/);
});

test('today lists outcomes biggest first, or says there were none', () => {
  const html = build(live());
  assert.ok(html.indexOf('ESCALATE-MECHANISM 5') > -1 && html.indexOf('ESCALATE-MECHANISM 5') < html.indexOf('ARCHIVE-DUPLICATE 2'));
  assert.match(build(live({ today: {} })), /no decisions today/);
  assert.match(build(live({ today: undefined })), /no decisions today/);
});

test('questions waiting for the owner show the question, project, task, age and a dry-run marker; none means no section', () => {
  const html = build(live());
  assert.match(html, /<strong>Waiting for you<\/strong>/);
  assert.match(html, /Which API\?/);
  assert.match(html, /alpha · adhoc-x-1 · 5h 30m · dry-run/);
  assert.match(build(live({ holds: [{ taskId: 't', project: 'p', question: null, ageHours: null, ageS: null, dryRun: false }] })), /\(no question recorded\)/);
  assert.doesNotMatch(build(live({ holds: [{ taskId: 't', project: 'p', question: 'Q', ageHours: null, ageS: null, dryRun: false }] })), /p · t · dry-run/);
  assert.match(build(live({ holds: [{ taskId: 't', project: 'p', question: 'Q', ageHours: null, ageS: null, dryRun: true }] })), /p · t · dry-run/);
  assert.doesNotMatch(build(live({ holds: [] })), /Waiting for you/);
  assert.doesNotMatch(build(live({ holds: undefined })), /Waiting for you/);
});

test('recent decisions show time, outcome, project, task and a dry-run marker', () => {
  const html = build(live());
  assert.doesNotMatch(html, /Worker history/);   // closed by default
  const open = buildOpen(live());
  assert.match(open, /<strong>Worker history<\/strong>/);
  assert.match(open, /11:16 · ESCALATE-MECHANISM · alpha · adhoc-x-1 · dry-run/);
  assert.doesNotMatch(buildOpen(live({ recent: [{ at: '2026-11-02T11:16:31Z', project: 'p', taskId: 't', outcome: 'O', mode: 'on' }] })), /· dry-run<\/div>/);
  assert.match(buildOpen(live({ recent: [] })), /No decisions recorded yet/);
});

test('every dynamic value is escaped', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const html = buildOpen(live({
    provider: evil, holds: [{ taskId: evil, project: evil, question: evil, ageHours: 1, ageS: 3600, dryRun: true }],
    recent: [{ at: '2026-11-02T11:16:31Z', project: evil, taskId: evil, outcome: evil, mode: 'on' }], today: { [evil]: 1 },
    stalled: { total: 1, projects: 1, topBuckets: [{ state: evil, signature: evil, count: 1 }] },
  }));
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test('wiring: loaded after the cloud panel, fetched with a soft failure, appended in the Workers tab, and the route is registered', () => {
  const root = path.join(__dirname, '..', '..');
  const index = fs.readFileSync(path.join(root, 'templates', 'index.html'), 'utf8');
  assert.ok(index.indexOf('stalled-worker-panel.js') > index.indexOf('cloud-spend-panel.js'));
  const tab = fs.readFileSync(path.join(__dirname, 'workers-tab.js'), 'utf8');
  assert.match(tab, /fetchJson\('\/api\/stalled-worker'\)\.catch\(\(\) => null\)/);
  assert.match(tab, /renderStalledWorkerSection\(stalledWorker\)/);
  assert.match(fs.readFileSync(path.join(root, 'app.py'), 'utf8'), /app\.register_blueprint\(stalled_worker_bp\)/);
});

test('escaping covers ampersands and quotes, not only angle brackets', () => {
  const html = build(live({ holds: [{ taskId: 't', project: 'p', question: 'Fish & "chips"', ageHours: 1, ageS: 3600, dryRun: false }] }));
  assert.match(html, /Fish &amp; &quot;chips&quot;/);
  assert.doesNotMatch(html, /Fish & /);
});

test('age thresholds sit exactly on the minute and the hour', () => {
  const age = (s) => call('stalledWorkerAge', s);
  assert.deepEqual([age(59), age(60), age(3599), age(3600), age(86400 + 1)], ['59s', '1m', '59m', '1h 0m', '24h 0m']);
});

test('a budget without a per-hour figure counts as no meter, and the percentage rounds to the nearest whole number', () => {
  assert.match(build(live({ budget: {}, gateway: { available: true } })), /gateway not reachable/);
  assert.match(build(live({ budget: { used: 5 }, gateway: { available: true } })), /gateway not reachable/);
  assert.match(build(live({ budget: { perHour: 540000, used: 138240 } })), /\(26%\)/);
  assert.match(build(live({ budget: { perHour: 1000, used: 254 } })), /\(25%\)/);
});

test('today lists the biggest outcome first whatever the order it arrived in', () => {
  const html = build(live({ today: { SMALL: 1, BIG: 9, MID: 4 } }));
  assert.ok(html.indexOf('BIG 9') < html.indexOf('MID 4') && html.indexOf('MID 4') < html.indexOf('SMALL 1'));
});

test('the ledger decision count is only mentioned when the payload carries one', () => {
  assert.match(build(live({ decisions: 7 })), /Show history \(7 decisions\)/);
  assert.match(build(live({ decisions: 0 })), /Show history \(0 decisions\)/);
  const { decisions, ...without } = live();
  assert.doesNotMatch(build(without), /decisions\)/);
});

test('a hold only minutes old shows its exact age, not zero hours', () => {
  assert.match(build(live({ holds: [{ taskId: 't', project: 'p', question: 'Q', ageHours: 0, ageS: 100, dryRun: false }] })), /p · t · 1m/);
  assert.match(build(live({ holds: [{ taskId: 't', project: 'p', question: 'Q', ageHours: 0, ageS: 45, dryRun: false }] })), /p · t · 45s/);
});

// ---- the on/off switch (2026-11-02) ----
const off = { disabled: true, disabledAt: '2026-11-02T12:00:00.000Z' };
const on = { disabled: false, disabledAt: null };

test('an enabled worker offers Turn off (next-enabled=false) and shows its mode badge; a payload without a switch field behaves as enabled', () => {
  for (const html of [build(live({ switch: on })), build(live())]) {
    assert.match(html, /<button type="button" class="secondary stalled-switch-btn" data-next-enabled="false"[^>]*>⏻ Turn off<\/button>/);
    assert.match(html, /class="badge hold"[^>]*>dry-run</);
    assert.doesNotMatch(html, /switched off/);
    assert.doesNotMatch(html, /opacity:\.65/);
  }
});

test('a switched-off worker offers Turn on (next-enabled=true), shows the switched-off badge with its time instead of the mode, and dims the panel', () => {
  const html = build(live({ switch: off }));
  assert.match(html, /data-next-enabled="true"[^>]*>⏻ Turn on<\/button>/);
  assert.match(html, /class="badge idle"[^>]*>switched off</);
  assert.match(html, /Switched off since 2026-11-02T12:00:00\.000Z/);
  assert.doesNotMatch(html, /class="badge hold"[^>]*>dry-run</);
  assert.match(html, /class="worker-card clickable worker-off"/);
  assert.match(html, /timer on/);                                            // the timer badge stays: the timer keeps running
  assert.match(build(live({ switch: { disabled: true } })), /class="badge idle"[^>]*>switched off</);
  assert.doesNotMatch(build(live({ switch: { disabled: true } })), /since/);
});

test('the switch time is escaped', () => {
  assert.doesNotMatch(build(live({ switch: { disabled: true, disabledAt: '<img src=x onerror=1>' } })), /<img/);
});

// A bare vm context with the three globals the click handler uses: fetch, showToast, renderWorkers.
function loadSwitch({ fetchImpl, rendered = [], toasts = [] }) {
  const ctx = vm.createContext({ fetch: fetchImpl, showToast: (m) => toasts.push(m), renderWorkers: async () => { rendered.push(1); }, JSON, Error });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'stalled-worker-panel.js'), 'utf8'), ctx, { filename: 'stalled-worker-panel.js' });
  return ctx;
}

test('switching posts {enabled} as JSON to the dashboard route and redraws the Workers tab on success', async () => {
  const calls = []; const rendered = []; const toasts = [];
  const ctx = loadSwitch({ rendered, toasts, fetchImpl: async (url, init) => { calls.push([url, init.method, init.headers['Content-Type'], init.body]); return { ok: true, status: 200 }; } });
  assert.strictEqual(await ctx.setStalledWorkerEnabled(false), true);
  assert.strictEqual(await ctx.setStalledWorkerEnabled(true), true);
  assert.deepStrictEqual(calls, [['/api/stalled-worker/enabled', 'POST', 'application/json', '{"enabled":false}'], ['/api/stalled-worker/enabled', 'POST', 'application/json', '{"enabled":true}']]);
  assert.strictEqual(rendered.length, 2);
  assert.deepStrictEqual(toasts, []);
});

test('a refused or failed switch shows a toast naming the direction and the reason, and does not redraw', async () => {
  const mk = (fetchImpl) => { const rendered = []; const toasts = []; return { rendered, toasts, ctx: loadSwitch({ rendered, toasts, fetchImpl }) }; };
  const a = mk(async () => ({ ok: false, status: 500, json: async () => ({ error: 'could not change the switch: disk full' }) }));
  assert.strictEqual(await a.ctx.setStalledWorkerEnabled(false), false);
  assert.deepStrictEqual(a.toasts, ['Could not switch the stalled-task worker off: could not change the switch: disk full']);
  assert.strictEqual(a.rendered.length, 0);
  const b = mk(async () => ({ ok: false, status: 502, json: async () => { throw new Error('not json'); } }));
  assert.strictEqual(await b.ctx.setStalledWorkerEnabled(true), false);
  assert.deepStrictEqual(b.toasts, ['Could not switch the stalled-task worker on: HTTP 502']);
  const c = mk(async () => { throw new Error('network down'); });
  assert.strictEqual(await c.ctx.setStalledWorkerEnabled(true), false);
  assert.deepStrictEqual(c.toasts, ['Could not switch the stalled-task worker on: network down']);
  assert.strictEqual(c.rendered.length + b.rendered.length, 0);
});

test('clicking the button disables it, switches in the direction it names, and re-enables it only when the switch failed', async () => {
  for (const [ok, nextEnabled, expectDisabledAfter] of [[true, 'false', true], [false, 'true', false]]) {
    const calls = [];
    const ctx = loadSwitch({ fetchImpl: async (url, init) => { calls.push(init.body); return ok ? { ok: true, status: 200 } : { ok: false, status: 500, json: async () => ({}) }; } });
    let stopped = false;
    const btn = { dataset: { nextEnabled }, disabled: false, onclick: null };
    ctx.wireStalledWorkerSwitch({ querySelectorAll: (sel) => { assert.strictEqual(sel, '.stalled-switch-btn'); return [btn]; } });
    await btn.onclick({ stopPropagation: () => { stopped = true; } });
    assert.strictEqual(stopped, true);
    assert.deepStrictEqual(calls, [JSON.stringify({ enabled: nextEnabled === 'true' })]);
    assert.strictEqual(btn.disabled, expectDisabledAfter);
  }
});

test('wiring: the Workers tab wires the stalled-task switch next to the lane switches', () => {
  assert.match(fs.readFileSync(path.join(__dirname, 'workers-tab.js'), 'utf8'), /if \(typeof wireStalledWorkerSwitch === 'function'\) wireStalledWorkerSwitch\(main\);/);
});

test('only a strict true counts as switched off: other truthy values and a false switch show the on state', () => {
  const badge = (sw) => call('stalledWorkerSwitchBadge', sw);
  const button = (sw) => call('stalledWorkerSwitchButton', sw);
  assert.strictEqual(badge({ disabled: false }), '');
  assert.strictEqual(badge(null), '');
  assert.strictEqual(badge(undefined), '');
  assert.match(badge({ disabled: true }), /switched off/);
  for (const sw of [{ disabled: 1 }, { disabled: 'yes' }, { disabled: false }, {}, null]) {
    assert.match(button(sw), /data-next-enabled="false"[^>]*>\u23FB Turn off</, JSON.stringify(sw));
    assert.strictEqual(badge(sw), '', JSON.stringify(sw));
  }
  assert.match(button({ disabled: true }), /data-next-enabled="true"[^>]*>\u23FB Turn on</);
});

// ---- lane-card layout, truncation and click-to-expand (2026-11-02) ----
test('collapsed: no history, one meta line, a Show history toggle, aria-expanded false; opened: history, Hide toggle, aria-expanded true', () => {
  const closed = build(live());
  assert.match(closed, /aria-expanded="false"/);
  assert.match(closed, /\u25b8 Show history/);
  assert.doesNotMatch(closed, /Worker history|Biggest buckets/);
  const open = buildOpen(live());
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /\u25be Hide history/);
  assert.match(open, /Worker history/);
  assert.match(open, /Biggest buckets/);
});

test('the Turn on/off button sits in the right-hand badge column under the status badges, not in a title line', () => {
  const html = build(live());
  const col = html.slice(html.indexOf('badge-col'), html.indexOf('</div></div>', html.indexOf('badge-col')));
  assert.match(col, /badge hold/);
  assert.match(col, /state-timer[^>]*>last tick 2m ago/);
  assert.match(col, /stalled-switch-btn/);
  assert.ok(col.indexOf('badge hold') < col.indexOf('stalled-switch-btn'));
});

test('collapsed card shows only the biggest three outcomes with a +n more, and the full list when opened', () => {
  const today = { A: 9, B: 8, C: 7, D: 6, E: 5 };
  const closed = build(live({ today }));
  assert.match(closed, /A 9 · B 8 · C 7 \+2 more/);
  assert.doesNotMatch(closed, /D 6/);
  assert.match(buildOpen(live({ today })), /A 9 · B 8 · C 7 · D 6 · E 5/);
});

test('long questions and task ids are cut with an ellipsis and keep the full text in the tooltip; only two holds show when collapsed', () => {
  const q = 'Q'.repeat(200);
  const holds = [1, 2, 3].map((n) => ({ taskId: 't' + n, project: 'p', question: q, ageHours: 1, ageS: 3600, dryRun: false }));
  const closed = build(live({ holds }));
  assert.match(closed, /Q{89}\u2026/);
  assert.doesNotMatch(closed, /Q{91}</);
  assert.match(closed, new RegExp('title="' + 'Q'.repeat(200)));
  assert.match(closed, /\+1 more \(click the card\)/);
  assert.equal((closed.match(/p · t\d/g) || []).length, 2);
  const open = buildOpen(live({ holds }));
  assert.equal((open.match(/p · t\d/g) || []).length, 3);
  assert.doesNotMatch(open, /click the card/);
});

test('wiring: clicking the card flips the open state and redraws; a click on the switch button does not reach the card', async () => {
  const ctx = load();
  const calls = [];
  const card = { onclick: null };
  const root = { querySelectorAll: (sel) => (sel === '[data-stalled-expand]' ? [card] : []) };
  ctx.redraw = () => calls.push(vm.runInContext('stalledWorkerExpanded', ctx));
  vm.runInContext('wireStalledWorkerExpand', ctx)(root, ctx.redraw);
  card.onclick(); card.onclick();
  assert.deepEqual(calls, [true, false]);
  assert.match(fs.readFileSync(path.join(__dirname, 'workers-tab.js'), 'utf8'), /wireStalledWorkerExpand\(main, renderWorkers\)/);
  assert.match(fs.readFileSync(path.join(__dirname, 'stalled-worker-panel.js'), 'utf8'), /e\.stopPropagation\(\)/);
});

test('exactly three outcomes show no "more"; a long gateway error is cut in the card line', () => {
  const three = build(live({ today: { A: 3, B: 2, C: 1 } }));
  assert.match(three, /A 3 · B 2 · C 1</);
  assert.doesNotMatch(three, /more/);
  const err = build(live({ budget: null, gateway: { available: false, error: 'E'.repeat(100) } }));
  assert.match(err, /\(E{39}…\)/);
  assert.doesNotMatch(err, /E{41}/);
});
