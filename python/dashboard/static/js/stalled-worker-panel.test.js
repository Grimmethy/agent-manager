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
  assert.match(dry, /Stalled-task worker/);
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
  assert.match(build(live({ lastTickAgeS: 125 })), /Last tick 2m ago/);
  assert.match(build(live({ lastTickAgeS: null })), /No tick recorded yet/);
});

test('the token budget line shows used of per-hour with a percentage, and flags a spent budget', () => {
  assert.match(build(live()), /1,350,000 of 5,400,000 tokens this hour \(25%\)/);
  assert.match(build(live()), /claude-subscription · claude-sonnet-5-5/);
  assert.doesNotMatch(build(live()), /budget spent/);
  assert.match(build(live({ budget: { perHour: 100, used: 100 } })), /budget spent/);
  assert.match(build(live({ budget: { perHour: 0, used: 5 } })), /\(0%\)/);
});

test('a gateway that is down says so, with the reason escaped', () => {
  const html = build(live({ budget: null, gateway: { available: false, error: '<boom> refused' } }));
  assert.match(html, /Model gateway not reachable \(&lt;boom&gt; refused\)\./);
  assert.doesNotMatch(html, /tokens this hour/);
  assert.match(build(live({ budget: null, gateway: { available: false } })), /Model gateway not reachable\./);
});

test('the stalled count and the top buckets are listed, long reasons cut, empty reasons named', () => {
  const html = build(live());
  assert.match(html, /<strong>580<\/strong> stalled across 33 projects/);
  assert.match(html, /18 · blocked · plan cites missing-file target\(s\): &lt;path&gt;/);
  assert.match(build(live({ stalled: { total: 1, projects: 1, topBuckets: [{ state: 'blocked', signature: 'x'.repeat(300), count: 1 }] } })), /x{110}</);
  assert.doesNotMatch(build(live({ stalled: { total: 1, projects: 1, topBuckets: [{ state: 'blocked', signature: 'x'.repeat(300), count: 1 }] } })), /x{111}/);
  assert.match(build(live({ stalled: { total: 1, projects: 1, topBuckets: [{ state: 'blocked', signature: '', count: 1 }] } })), /\(no reason recorded\)/);
  assert.match(build(live({ stalled: null })), /No stalled-task index yet\./);
});

test('today lists outcomes biggest first, or says there were none', () => {
  const html = build(live());
  assert.ok(html.indexOf('ESCALATE-MECHANISM 5') > -1 && html.indexOf('ESCALATE-MECHANISM 5') < html.indexOf('ARCHIVE-DUPLICATE 2'));
  assert.match(build(live({ today: {} })), /No decisions today\./);
  assert.match(build(live({ today: undefined })), /No decisions today\./);
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
  assert.match(html, /<strong>Recent<\/strong>/);
  assert.match(html, /11:16 · ESCALATE-MECHANISM · alpha · adhoc-x-1 · dry-run/);
  assert.doesNotMatch(build(live({ recent: [{ at: '2026-11-02T11:16:31Z', project: 'p', taskId: 't', outcome: 'O', mode: 'on' }] })), /· dry-run<\/div>/);
  assert.doesNotMatch(build(live({ recent: [] })), /Recent/);
});

test('every dynamic value is escaped', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const html = build(live({
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
  assert.match(build(live({ budget: {}, gateway: { available: true } })), /Model gateway not reachable/);
  assert.match(build(live({ budget: { used: 5 }, gateway: { available: true } })), /Model gateway not reachable/);
  assert.match(build(live({ budget: { perHour: 540000, used: 138240 } })), /\(26%\)/);
  assert.match(build(live({ budget: { perHour: 1000, used: 254 } })), /\(25%\)/);
});

test('today lists the biggest outcome first whatever the order it arrived in', () => {
  const html = build(live({ today: { SMALL: 1, BIG: 9, MID: 4 } }));
  assert.ok(html.indexOf('BIG 9') < html.indexOf('MID 4') && html.indexOf('MID 4') < html.indexOf('SMALL 1'));
});

test('the ledger decision count is only mentioned when the payload carries one', () => {
  assert.match(build(live({ decisions: 7 })), /7 decisions in the ledger tail/);
  assert.match(build(live({ decisions: 0 })), /0 decisions in the ledger tail/);
  const { decisions, ...without } = live();
  assert.doesNotMatch(build(without), /decisions in the ledger tail/);
});

test('a hold only minutes old shows its exact age, not zero hours', () => {
  assert.match(build(live({ holds: [{ taskId: 't', project: 'p', question: 'Q', ageHours: 0, ageS: 100, dryRun: false }] })), /p · t · 1m/);
  assert.match(build(live({ holds: [{ taskId: 't', project: 'p', question: 'Q', ageHours: 0, ageS: 45, dryRun: false }] })), /p · t · 45s/);
});
