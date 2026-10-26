'use strict';

// buildCloudSpendHtml / renderCloudSpendSection (cloud-spend-panel.js): a plain global <script> holding only declarations, so it loads into a bare vm context
// (same approach as workers-tab-assignable.test.js).
// Run: node --test python/dashboard/static/js/cloud-spend-panel.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load() {
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'cloud-spend-panel.js'), 'utf8'), ctx, { filename: 'cloud-spend-panel.js' });
  return ctx;
}
const build = (meter) => vm.runInContext(`buildCloudSpendHtml(${JSON.stringify(meter)})`, load());
const section = (meter) => vm.runInContext(`renderCloudSpendSection(${JSON.stringify(meter)})`, load());

const period = (over = {}) => ({ calls: 12, inputTokens: 1234567, outputTokens: 89000, costUsd: 3.456, unpriced: false, ...over });
const live = (over = {}) => ({
  cloudLane: true, available: true, laneId: 'worker-cloud', provider: 'anthropic-api', model: 'claude-haiku-5-5',
  monthToDate: period(), today: period({ calls: 2, inputTokens: 500, outputTokens: 40, costUsd: 0.1 }),
  cap: { usd: null, mode: 'warn', exceeded: false }, ...over,
});

test('priced: shows calls, comma-grouped tokens and the cost for month to date and today', () => {
  const html = build(live());
  assert.match(html, /Cloud spend/);
  assert.match(html, /Month to date<\/strong> 12 calls · 1,234,567 in \/ 89,000 out tokens · \$3\.46/);
  assert.match(html, /Today<\/strong> 2 calls · 500 in \/ 40 out tokens · \$0\.10/);
  assert.match(html, /anthropic-api · claude-haiku-5-5/);
  assert.doesNotMatch(html, /unpriced/);
});

test('unpriced: says which variables to set instead of showing $0.00', () => {
  const html = build(live({ monthToDate: period({ costUsd: 0, unpriced: true }) }));
  assert.match(html, /unpriced -- set CLOUD_PRICE_IN_PER_MTOK\/CLOUD_PRICE_OUT_PER_MTOK/);
  assert.doesNotMatch(html, /Month to date<\/strong>[^<]*\$0\.00/);
});

test('unpriced with some priced spend: shows the priced part and the unpriced note', () => {
  const html = build(live({ monthToDate: period({ costUsd: 1.5, unpriced: true }) }));
  assert.match(html, /\$1\.50 priced, plus unpriced -- set CLOUD_PRICE_IN_PER_MTOK/);
});

test('cap: shows the cap and its mode, with no marker while under it', () => {
  const html = build(live({ cap: { usd: 25, mode: 'hard', exceeded: false } }));
  assert.match(html, /Cap \$25\.00 \(hard\)/);
  assert.doesNotMatch(html, /cap exceeded/);
});

test('cap exceeded: shows the amber warning marker', () => {
  const html = build(live({ cap: { usd: 5, mode: 'warn', exceeded: true } }));
  assert.match(html, /Cap \$5\.00 \(warn\) <span class="badge warn"[^>]*>cap exceeded<\/span>/);
});

test('no cap configured says so', () => {
  assert.match(build(live()), /No monthly cap/);
});

test('gateway down: a plain not-reachable note, with the reason escaped', () => {
  const html = build({ cloudLane: true, available: false, laneId: 'worker-cloud', error: '<script>alert(1)</script> refused' });
  assert.match(html, /Cloud gateway not reachable/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; refused/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /Month to date/);
});

test('no cloud lane (or no meter at all): nothing is rendered, from both entry points', () => {
  for (const m of [{ cloudLane: false, available: false }, null, undefined, {}]) {
    assert.equal(build(m), '');
    assert.equal(section(m), '');
  }
});

test('renderCloudSpendSection renders the panel when a cloud lane exists', () => {
  assert.match(section(live()), /id="cloud-spend-panel"/);
  assert.match(section({ cloudLane: true, available: false }), /Cloud gateway not reachable/);
});

test('missing numbers never print NaN or undefined', () => {
  const html = build({ cloudLane: true, available: true, monthToDate: {}, today: null, cap: null });
  assert.doesNotMatch(html, /NaN|undefined|null/);
  assert.match(html, /0 calls · 0 in \/ 0 out tokens · \$0\.00/);
});
