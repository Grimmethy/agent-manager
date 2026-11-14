'use strict';

// buildTriggersMemoryHtml / renderTriggersTab / setTriggersDays (triggers-tab.js): a plain global <script>, loaded into a bare vm context (like cloud-spend-panel.test.js), plus the
// page wiring (index.html, the nav, the live-updates tab list and the tab dispatch).
// Run: node --test python/dashboard/static/js/triggers-tab.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (...p) => fs.readFileSync(path.join(__dirname, ...p), 'utf8');
const SRC = read('triggers-tab.js');
const INDEX = read('..', '..', 'templates', 'index.html');

const load = (extra = {}) => { const ctx = vm.createContext({ ...extra }); vm.runInContext(SRC, ctx, { filename: 'triggers-tab.js' }); return ctx; };
const build = (body, days = 14) => vm.runInContext(`buildTriggersMemoryHtml(${JSON.stringify(body)}, ${days})`, load());

const episode = (over = {}) => ({ start: '2026-11-10T20:41:12Z', pause_s: 1200, open: false, level: 'critical', reason: 'swap nearly gone (5 MB free)', min_available_mb: 1200,
  top: [{ label: 'qemu:p40-passthrough', rss_mb: 4200 }, { label: 'llama-server', rss_mb: 2800 }, { label: 'claude', rss_mb: 450 }, { label: 'extra', rss_mb: 10 }], ...over });
const body = (over = {}) => ({ days: 14, source: { path: '/j.jsonl', exists: true, truncated: false }, episodes: [episode(), episode({ start: '2026-11-10T18:00:00Z', pause_s: 90, level: 'tight' })],
  summary: { episodes: 2, open: 0, total_pause_s: 1290, longest_pause_s: 1200, by_level: { tight: 1, critical: 1 }, refused_total: 3, min_available_mb: 970,
    reasons: [{ reason: 'swap low (N MB free)', count: 2 }], by_day: [{ day: '2026-11-09', episodes: 1, paused_s: 600, peak_level: 'tight' }, { day: '2026-11-10', episodes: 1, paused_s: 7200, peak_level: 'critical' }],
    top_offenders: [{ label: 'qemu:p40-passthrough', episodes: 2, share: 1, max_rss_mb: 4200, avg_rss_mb: 4150 }, { label: 'llama-server', episodes: 1, share: 0.5, max_rss_mb: 2800, avg_rss_mb: 2800 }] }, ...over });

test('the trail shows the cards, the offender ranking, the daily view, the reasons and the recent episodes', () => {
  const html = build(body());
  assert.match(html, /Memory pressure/);
  assert.match(html, /1 critical, 1 tight/);
  assert.match(html, /What was biggest when pressure hit/);
  assert.match(html, /qemu:p40-passthrough<\/td><td>2<\/td><td>.*100%.*<\/td><td>4150<\/td><td>4200/s);
  assert.match(html, /llama-server<\/td><td>1<\/td><td>.*50%/s);
  assert.ok(html.indexOf('2026-11-10</td>') < html.indexOf('2026-11-09</td>'), 'the day table is newest first');
  assert.match(html, /2\.0 h/);
  assert.match(html, /swap low \(N MB free\)<\/td><td>2/);
  assert.match(html, /qemu:p40-passthrough 4200 MB, llama-server 2800 MB, claude 450 MB</);
  assert.doesNotMatch(html, /extra 10 MB/);
  assert.match(html, /Lowest available[\s\S]*970 MB/);
  assert.match(html, /Would-refuse[\s\S]*3/);
});

test('durations: seconds, minutes, hours and an open episode', () => {
  const ctx = load();
  const d = (s) => vm.runInContext(`triggersDuration(${JSON.stringify(s)})`, ctx);
  assert.deepEqual([d(45), d(90), d(7200), d(null)], ['45 s', '2 min', '2.0 h', 'open']);
});

test('the empty states: no journal, no episodes, no payload', () => {
  assert.match(build({ source: { exists: false, path: '/nope' } }), /No memory-pressure journal found at \/nope/);
  assert.match(build(body({ summary: { episodes: 0 }, episodes: [] })), /No pressure episodes in the last 14 days/);
  assert.match(build(null), /No memory-pressure journal found/);
  assert.match(build(body({ days: 7, summary: { episodes: 0 } }), 7), /last 7 days/);
});

test('the window buttons mark the active one and call setTriggersDays', () => {
  const html = build(body(), 30);
  assert.match(html, /<button class="active" onclick="setTriggersDays\(30\)">30 days<\/button>/);
  assert.match(html, /onclick="setTriggersDays\(7\)"/);
  assert.equal((html.match(/class="active"/g) || []).length, 1);
});

test('HTML in a process label, a reason or the source path is escaped', () => {
  const html = build(body({ summary: { ...body().summary, top_offenders: [{ label: '<img src=x>', episodes: 1, share: 1, max_rss_mb: 1, avg_rss_mb: 1 }] }, episodes: [episode({ reason: '"><script>' })] }));
  assert.doesNotMatch(html, /<img|<script/);
  assert.match(build({ source: { exists: false, path: '<b>' } }), /&lt;b&gt;/);
});

test('renderTriggersTab fetches the route for the chosen window and paints #main; setTriggersDays switches the window', async () => {
  const main = { innerHTML: '' };
  const urls = [];
  const ctx = load({ document: { getElementById: (id) => (id === 'main' ? main : null) }, fetchJson: async (u) => { urls.push(u); return body(); } });
  await vm.runInContext('renderTriggersTab()', ctx);
  assert.deepEqual(urls, ['/api/triggers/memory-pressure?days=14']);
  assert.match(main.innerHTML, /Memory pressure/);
  await vm.runInContext('setTriggersDays(90)', ctx);
  assert.deepEqual(urls, ['/api/triggers/memory-pressure?days=14', '/api/triggers/memory-pressure?days=90']);
  assert.match(main.innerHTML, /<button class="active" onclick="setTriggersDays\(90\)">/);
});

test('no timer; index.html, the nav, the icon, the live-updates list and the dispatch know the tab', () => {
  assert.doesNotMatch(SRC, /setInterval|setTimeout/);
  assert.match(INDEX, /\{ key: 'triggers', label: '[^']*Triggers'/);
  assert.match(INDEX, /<script src="\/static\/js\/triggers-tab\.js"><\/script>/);
  assert.match(read('nav-sections.js'), /items: \['hardware', 'models', 'plugins', 'gpu-broker', 'triggers',/);
  assert.match(read('nav-icons.js'), /"triggers": "hourglass"/);
  assert.match(read('live-updates.js'), /NON_QUEUE_TABS = \[[^\]]*'triggers'/);
  assert.match(read('branches-joblist-hardware-tabs.js'), /activeTab === 'triggers'\) await renderTriggersTab\(\)/);
});
