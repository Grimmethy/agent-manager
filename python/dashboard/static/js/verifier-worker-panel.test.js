'use strict';

// buildVerifierWorkerHtml / renderVerifierWorkerSection (verifier-worker-panel.js): a plain global <script> of pure string builders, loaded into a bare vm context
// like stalled-worker-panel.test.js. Run: node --test python/dashboard/static/js/verifier-worker-panel.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load() {
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'verifier-worker-panel.js'), 'utf8'), ctx, { filename: 'verifier-worker-panel.js' });
  return ctx;
}
const call = (fn, ...args) => vm.runInContext(`${fn}(${args.map((a) => JSON.stringify(a)).join(',')})`, load());
const build = (p) => call('buildVerifierWorkerHtml', p);
const section = (p) => call('renderVerifierWorkerSection', p);
const buildOpen = (p) => { const ctx = load(); vm.runInContext('verifierWorkerExpanded = true', ctx); return vm.runInContext(`buildVerifierWorkerHtml(${JSON.stringify(p)})`, ctx); };

const live = (over = {}) => ({
  configured: true, mode: 'on', switch: { disabled: false, disabledAt: null }, trigger: { state: 'idle', checkedAgeS: 12, endedAgeS: 90, stopped: 'idle' }, lastTickAgeS: 125, decisions: 7, recordedToday: 5, failedToday: 0,
  indexed: { branches: 80, builtAt: '2026-11-02T20:00:00Z' }, today: { merge: 3, 'needs-work': 2, 'no verdict': 1 },
  recent: [{ at: '2026-11-02T20:37:18Z', project: 'alpha', branch: 'agent/x-1', verdict: 'merge', mode: 'on', result: 'recorded', reason: 'Automated check: ok' }], ...over,
});

test('nothing is drawn unless the verifier has left a trace', () => {
  for (const p of [undefined, null, {}, { configured: false }]) { assert.equal(build(p), ''); assert.equal(section(p), ''); }
  assert.match(section(live()), /id="verifier-worker-panel"/);
});

test('same card template as the lane workers: id left, badge column right, one meta line', () => {
  const h = build(live());
  assert.match(h, /class="worker-card clickable"/);
  assert.match(h, /<span class="id">[^<]*branch-verifier<\/span><div class="badge-col">/);
  assert.match(h, /class="state-timer">last tick 2m ago</);
  assert.equal((h.match(/class="meta"/g) || []).length >= 2, true);
  assert.match(h, /5 recorded today/);
  assert.match(h, /80 pushed branches indexed/);
  assert.match(h, /today: merge 3 · needs-work 2 · no verdict 1/);
});

test('mode badge: live, dry-run, off, none', () => {
  assert.match(build(live({ mode: 'on' })), /badge ok[^>]*>live</);
  assert.match(build(live({ mode: 'dry-run' })), /badge hold[^>]*>dry-run</);
  assert.match(build(live({ mode: 'off' })), /badge idle[^>]*>off</);
  assert.match(build(live({ mode: null })), /no runs yet/);
});

test('trigger badge: armed, draining, backlog (with the last drain), never run, escaped', () => {
  assert.match(build(live()), /class="badge ok"[^>]*>trigger on</);
  assert.match(build(live({ trigger: { state: 'draining' } })), /class="badge ok"[^>]*>draining</);
  assert.match(build(live({ trigger: { state: 'backlog', endedAgeS: 30, stopped: 'cap' } })), /class="badge warn"[^>]*The last drain ended 30s ago \(cap\)[^>]*>backlog</);
  assert.match(build(live({ trigger: null })), /class="badge warn"[^>]*watchdogScripts[^>]*>no trigger yet</);
  assert.match(build(live()), /The last drain ended 1m ago \(idle\)/);
  assert.doesNotMatch(build(live({ trigger: { state: 'idle' } })), /last drain ended/);
  assert.doesNotMatch(build(live({ trigger: { state: 'idle', endedAgeS: 5, stopped: '<b>' } })), /<b>/);
});

test('switched off: dimmed card, says so instead of the mode, button offers Turn on', () => {
  const h = build(live({ switch: { disabled: true, disabledAt: '2026-11-02T20:00:00.000Z' } }));
  assert.match(h, /worker-off/);
  assert.match(h, /switched off/);
  assert.doesNotMatch(h, />live</);
  assert.match(h, /data-next-enabled="true"[^>]*>[^<]*Turn on/);
  assert.match(build(live()), /data-next-enabled="false"[^>]*>[^<]*Turn off/);
  assert.doesNotMatch(build(live()), /worker-off/);
});

test('failed posts show a warning badge only when there are some', () => {
  assert.doesNotMatch(build(live({ failedToday: 0 })), /failed/);
  assert.match(build(live({ failedToday: 2 })), /badge warn[^>]*>2 failed</);
});

test('today shows the biggest three with "+n more" and the full list when open; exactly three shows no "+0 more"', () => {
  const four = { today: { a: 4, b: 3, c: 2, d: 1 } };
  assert.match(build(live(four)), /today: a 4 · b 3 · c 2 \+1 more/);
  assert.doesNotMatch(build(live({ today: { a: 4, b: 3, c: 2 } })), /more/);
  assert.match(buildOpen(live(four)), /<strong>Today<\/strong> a 4 · b 3 · c 2 · d 1/);
  assert.match(build(live({ today: {} })), /no verdicts today/);
});

test('click-to-expand: collapsed hides the history, open shows it, aria-expanded follows', () => {
  const closed = build(live());
  assert.match(closed, /aria-expanded="false"/);
  assert.match(closed, /▸ Show history \(7 decisions\)/);
  assert.doesNotMatch(closed, /Verifier history/);
  const open = buildOpen(live());
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /▾ Hide history/);
  assert.match(open, /Verifier history/);
  assert.match(open, /20:37 · merge · alpha · agent\/x-1 · recorded/);
});

test('history: empty message, dry-run marker, long branch cut with a full-text title', () => {
  assert.match(buildOpen(live({ recent: [] })), /No verdicts recorded yet/);
  const long = 'agent/' + 'z'.repeat(80);
  const h = buildOpen(live({ recent: [{ at: '2026-11-02T20:37:18Z', project: 'p', branch: long, verdict: null, mode: 'dry-run', result: 'planned only', reason: 'why' }] }));
  assert.match(h, /no verdict · p · agent\/z+… · dry-run/);
  assert.ok(h.includes('title="' + long + ' — why"'));
});

test('every value is escaped', () => {
  const h = buildOpen(live({ recent: [{ at: 'x', project: '<b>p</b>', branch: '<img src=x>', verdict: '"><script>', mode: 'on', result: '<i>', reason: '<u>' }], today: { '<s>': 1 } }));
  assert.doesNotMatch(h, /<img|<script|<b>p|<s>|<i>|<u>/);
  assert.match(h, /&lt;img src=x&gt;/);
});

test('no branch index yet says so', () => {
  assert.match(build(live({ indexed: null })), /no branch index yet/);
});

test('no tick recorded yet', () => {
  assert.match(build(live({ lastTickAgeS: null })), /no tick recorded yet/);
});

test('the escapes cover & and quotes (a quote in a title attribute cannot break out)', () => {
  const h = buildOpen(live({ recent: [{ at: 'x', project: 'a&b', branch: 'q"q', verdict: 'merge', mode: 'on', result: 'ok', reason: 'r"r' }] }));
  assert.match(h, /a&amp;b/);
  assert.ok(h.includes('title="q&quot;q — r&quot;r"'));
  assert.doesNotMatch(h, /a&b/);
});

test('ages: seconds, minutes, hours, days, unknown', () => {
  const age = (s) => call('verifierWorkerAge', s);
  assert.equal(age(45), '45s');
  assert.equal(age(0), '0s');
  assert.equal(age(125), '2m');
  assert.equal(age(7300), '2h 1m');
  assert.equal(age(200000), '2d 7h');
  assert.equal(age(-1), '');
  assert.equal(age(null), '');
});

test('a branch name of exactly the cut length is shown whole, one longer is cut', () => {
  const mk = (b) => buildOpen(live({ recent: [{ at: 'x', project: 'p', branch: b, verdict: 'merge', mode: 'on', result: 'ok', reason: '' }] }));
  const exact = 'a'.repeat(60);
  assert.match(mk(exact), new RegExp(' · ' + exact + ' · ok'));
  assert.match(mk(exact + 'b'), /a{59}… · ok/);
});

// ---- the wiring: a fake DOM root and stubbed fetch/showToast/renderWorkers ----
function wired(fetchImpl) {
  const toasts = [];
  let redraws = 0;
  const ctx = vm.createContext({ fetch: fetchImpl, showToast: (m) => toasts.push(m), renderWorkers: async () => { redraws += 1; } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'verifier-worker-panel.js'), 'utf8'), ctx);
  return { ctx, toasts, redraws: () => redraws };
}
const fakeRoot = (selector, el) => ({ querySelectorAll: (sel) => (sel === selector ? [el] : []) });

test('clicking the card flips the history and asks for a redraw', () => {
  const { ctx } = wired(async () => ({ ok: true }));
  const card = {};
  let redraws = 0;
  ctx.__redraw = () => { redraws += 1; };
  ctx.__root = fakeRoot('[data-verifier-expand]', card);
  vm.runInContext('wireVerifierWorkerExpand(__root, __redraw)', ctx);
  card.onclick();
  assert.equal(vm.runInContext('verifierWorkerExpanded', ctx), true);
  card.onclick();
  assert.equal(vm.runInContext('verifierWorkerExpanded', ctx), false);
  assert.equal(redraws, 2);
});

test('the Turn off button posts {enabled:false}, stops the click reaching the card and redraws', async () => {
  const calls = [];
  const { ctx, redraws } = wired(async (url, opts) => { calls.push([url, JSON.parse(opts.body), opts.method]); return { ok: true }; });
  let stopped = false;
  const btn = { dataset: { nextEnabled: 'false' }, disabled: false };
  ctx.__root = fakeRoot('.verifier-switch-btn', btn);
  vm.runInContext('wireVerifierWorkerSwitch(__root)', ctx);
  await btn.onclick({ stopPropagation: () => { stopped = true; } });
  assert.deepEqual(calls, [['/api/branch-verifier/enabled', { enabled: false }, 'POST']]);
  assert.equal(stopped, true);
  assert.equal(redraws(), 1);
});

test('a failed switch toasts the server reason, keeps the button usable and does not redraw', async () => {
  const { ctx, toasts, redraws } = wired(async () => ({ ok: false, status: 500, json: async () => ({ error: 'disk full' }) }));
  const btn = { dataset: { nextEnabled: 'true' }, disabled: false };
  ctx.__root = fakeRoot('.verifier-switch-btn', btn);
  vm.runInContext('wireVerifierWorkerSwitch(__root)', ctx);
  await btn.onclick({ stopPropagation() {} });
  assert.equal(btn.disabled, false);
  assert.equal(redraws(), 0);
  assert.match(toasts[0], /branch verifier on: disk full/);
});

test('a network error toasts too, and an unreadable error body falls back to the HTTP status', async () => {
  let r = wired(async () => { throw new Error('offline'); });
  assert.equal(await vm.runInContext('setVerifierWorkerEnabled(false)', r.ctx), false);
  assert.match(r.toasts[0], /off: offline/);
  r = wired(async () => ({ ok: false, status: 502, json: async () => { throw new Error('x'); } }));
  assert.equal(await vm.runInContext('setVerifierWorkerEnabled(true)', r.ctx), false);
  assert.match(r.toasts[0], /on: HTTP 502/);
});

test('the trigger heartbeat: "checked Ns ago" on the meta line and in the badge title, "trigger silent" past five minutes, never for a running drain', () => {
  assert.match(build(live()), /<div class="meta">[^<]*trigger checked 12s ago/);
  assert.match(build(live()), /class="badge ok"[^>]*Checked 12s ago\.[^>]*>trigger on</);
  assert.doesNotMatch(build(live({ trigger: { state: 'idle', endedAgeS: 90 } })), /trigger checked/);
  assert.doesNotMatch(build(live({ trigger: null })), /trigger checked/);
  const silent = build(live({ trigger: { state: 'idle', checkedAgeS: 301 } }));
  assert.match(silent, /class="badge warn"[^>]*has not called the trigger for 5m[^>]*>trigger silent</);
  assert.doesNotMatch(silent, />trigger on</);
  assert.match(build(live({ trigger: { state: 'idle', checkedAgeS: 300 } })), />trigger on</);                       // exactly five minutes is still fine
  assert.match(build(live({ trigger: { state: 'backlog', checkedAgeS: 9999 } })), />trigger silent</);
  assert.match(build(live({ trigger: { state: 'draining', checkedAgeS: 9999 } })), />draining</);
  assert.match(build(live({ trigger: { state: 'backlog', checkedAgeS: 20, endedAgeS: 30, stopped: 'cap' } })), /class="badge warn"[^>]*Checked 20s ago[^>]*>backlog</);
});

test('listening: a drain that is up and waiting is a green badge that never turns into "trigger silent", whatever the heartbeat age', () => {
  assert.match(build(live({ trigger: { state: 'listening', checkedAgeS: 5 } })), /class="badge ok"[^>]*up and waiting[^>]*>listening</);
  assert.match(build(live({ trigger: { state: 'listening', checkedAgeS: 9999 } })), />listening</);
  assert.doesNotMatch(build(live({ trigger: { state: 'listening', checkedAgeS: 9999 } })), /trigger silent/);
  assert.doesNotMatch(build(live({ trigger: { state: 'listening' } })), />draining</);
});
