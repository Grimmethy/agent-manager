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

test('the summary cards sit in a wrapping flex row; the offender table and episode list are untouched', () => {
  const html = build(body());
  assert.match(html, /<div style="display:flex;flex-wrap:wrap;gap:10px"><div style="min-width:120px"><div class="meta">Episodes<\/div>/);
  assert.match(html, /What was biggest when pressure hit/);
  assert.match(html, /<h3>Recent episodes<\/h3>/);
  assert.ok((html.match(/<table>/g) || []).length >= 2, 'the offender and day tables are both rendered');
});

test('offenders_by_day renders newest-first with escaped labels', () => {
  const days = [
    { date: '2026-11-09', episodes: 1, offenders: [{ label: 'llama-server', episodes_in_top: 1, share: 0.5, avg_mb: 2800, max_mb: 2800 }] },
    { date: '2026-11-10', episodes: 1, offenders: [{ label: '<script>x</script>', episodes_in_top: 1, share: 1, avg_mb: 4150, max_mb: 4200 }] },
  ];
  const html = build(body({ summary: { ...body().summary, offenders_by_day: days } }));
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt; 100% 4150 MB/);
  assert.doesNotMatch(html, /<script>x/);
  const section = html.slice(html.indexOf('By day: top offenders'));
  assert.ok(section.indexOf('2026-11-10</td>') < section.indexOf('2026-11-09</td>'), 'the offender day table is newest first');
  assert.match(section, /llama-server 50% 2800 MB/);
});

test('without offenders_by_day the page matches the golden HTML', () => {
  const GOLDEN = '<h2 style="margin:0 0 8px">Memory pressure</h2><div class="row" style="margin-bottom:12px"><button onclick="setTriggersDays(7)">7 days</button> <button class="active" onclick="setTriggersDays(14)">14 days</button> <button onclick="setTriggersDays(30)">30 days</button> <button onclick="setTriggersDays(90)">90 days</button></div>'
    + '<div style="display:flex;flex-wrap:wrap;gap:10px"><div style="min-width:120px"><div class="meta">Episodes</div><div style="font-size:1.5rem;font-weight:700">2</div><div class="meta">1 critical, 1 tight</div></div><div style="min-width:120px"><div class="meta">Time paused</div><div style="font-size:1.5rem;font-weight:700">22 min</div><div class="meta">0% of the window</div></div><div style="min-width:120px"><div class="meta">Longest</div><div style="font-size:1.5rem;font-weight:700">20 min</div></div><div style="min-width:120px"><div class="meta">Lowest available</div><div style="font-size:1.5rem;font-weight:700">970 MB</div></div><div style="min-width:120px"><div class="meta">Would-refuse</div><div style="font-size:1.5rem;font-weight:700">3</div><div class="meta">new work held back (dry-run)</div></div></div>'
    + '<h3>What was biggest when pressure hit</h3><div class="meta" style="margin-bottom:6px">The five largest processes at the moment each episode opened: what to optimise.</div><table><thead><tr><th>Process</th><th>In episodes</th><th>Share</th><th>Avg MB</th><th>Max MB</th></tr></thead><tbody><tr><td>qemu:p40-passthrough</td><td>2</td><td><span style="display:inline-block;height:8px;width:100px;background:var(--accent);vertical-align:middle"></span> 100%</td><td>4150</td><td>4200</td></tr><tr><td>llama-server</td><td>1</td><td><span style="display:inline-block;height:8px;width:50px;background:var(--accent);vertical-align:middle"></span> 50%</td><td>2800</td><td>2800</td></tr></tbody></table>'
    + '<h3>By day</h3><table><thead><tr><th>Day (UTC)</th><th>Episodes</th><th>Paused</th><th>Peak</th></tr></thead><tbody><tr><td>2026-11-10</td><td>1</td><td><span style="display:inline-block;height:8px;width:8px;background:var(--accent);vertical-align:middle"></span> 2.0 h</td><td><span class="badge bad">critical</span></td></tr><tr><td>2026-11-09</td><td>1</td><td><span style="display:inline-block;height:8px;width:1px;background:var(--accent);vertical-align:middle"></span> 10 min</td><td><span class="badge warn">tight</span></td></tr></tbody></table>'
    + '<h3>Why it triggered</h3><table><thead><tr><th>Why it triggered</th><th>Count</th></tr></thead><tbody><tr><td>swap low (N MB free)</td><td>2</td></tr></tbody></table>'
    + '<h3>Recent episodes</h3><table><thead><tr><th>Started</th><th>Length</th><th>Level</th><th>Lowest available</th><th>Reason</th><th>Biggest at the time</th></tr></thead><tbody><tr><td>2026-11-10T20:41:12Z</td><td>20 min</td><td><span class="badge bad">critical</span></td><td>1200 MB</td><td>swap nearly gone (5 MB free)</td><td>qemu:p40-passthrough 4200 MB, llama-server 2800 MB, claude 450 MB</td></tr><tr><td>2026-11-10T18:00:00Z</td><td>2 min</td><td><span class="badge warn">tight</span></td><td>1200 MB</td><td>swap nearly gone (5 MB free)</td><td>qemu:p40-passthrough 4200 MB, llama-server 2800 MB, claude 450 MB</td></tr></tbody></table>';
  assert.equal(build(body()), GOLDEN);
});

test('a day with no offenders says no process data', () => {
  const days = [{ date: '2026-11-10', episodes: 1, offenders: [] }];
  const html = build(body({ summary: { ...body().summary, offenders_by_day: days } }));
  assert.match(html, /<td>2026-11-10<\/td><td>1<\/td><td>no process data<\/td>/);
});
