'use strict';
// Run: node --test python/dashboard/static/js/memory-chip.test.js
// Header memory chip (2026-11-02): shown only while the broker reports tight/critical; text, severity class, tooltip numbers, pause length and the owner-only unload button flag.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { formatPauseLength, memoryChipModel } = require('./core-ui.js');
const { branchListRefreshingHtml } = require('./branch-projects.js');

const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');

test('formatPauseLength: seconds, minutes with seconds, hours with minutes; bad input is empty', () => {
  assert.equal(formatPauseLength(0), '0s');
  assert.equal(formatPauseLength(59.9), '59s');
  assert.equal(formatPauseLength(60), '1m 0s');
  assert.equal(formatPauseLength(125), '2m 5s');
  assert.equal(formatPauseLength(3599), '59m 59s');
  assert.equal(formatPauseLength(3600), '1h 0m');
  assert.equal(formatPauseLength(3725), '1h 2m');
  for (const bad of [-1, NaN, undefined, null, Infinity, 'x']) assert.equal(formatPauseLength(bad), '', String(bad));
});

test('the chip is hidden unless the state is tight or critical', () => {
  for (const m of [undefined, null, {}, { state: 'ok' }, { state: 'unknown' }, { state: 'banana' }]) assert.deepEqual(memoryChipModel(m), { visible: false }, JSON.stringify(m));
});

test('tight is a warning chip and critical a bad one, each with its state in the text', () => {
  const t = memoryChipModel({ state: 'tight', reason: 'r' });
  const c = memoryChipModel({ state: 'critical', reason: 'r' });
  assert.deepEqual([t.visible, t.text, t.className], [true, 'Memory tight', 'chip chip-solo chip-warn']);
  assert.deepEqual([c.visible, c.text, c.className], [true, 'Memory critical', 'chip chip-solo chip-bad']);
});

test('a pause shows its length, a dry-run shows that it would pause, neither shows nothing extra', () => {
  assert.equal(memoryChipModel({ state: 'critical', paused: true, pauseS: 125 }).text, 'Memory critical · new work paused 2m 5s');
  assert.equal(memoryChipModel({ state: 'critical', paused: true, pauseS: null }).text, 'Memory critical · new work paused');
  assert.equal(memoryChipModel({ state: 'tight', wouldPause: true }).text, 'Memory tight · would pause (dry-run)');
  assert.equal(memoryChipModel({ state: 'tight', paused: true, wouldPause: true, pauseS: 5 }).text, 'Memory tight · new work paused 5s');
});

test('the tooltip carries the reason and whichever numbers are present', () => {
  const m = memoryChipModel({ state: 'critical', reason: 'io stall full 57%', numbers: { available_mb: 274, swap_free_mb: 0, io_full: 56.6, mem_full: 7.1 } });
  assert.equal(m.title, 'io stall full 57% — 274 MB available, swap 0 MB free, io stall 56.6%, memory stall 7.1%');
  assert.equal(memoryChipModel({ state: 'tight', reason: 'only a reason' }).title, 'only a reason');
  assert.equal(memoryChipModel({ state: 'tight', numbers: { available_mb: 900 } }).title, '900 MB available');
  assert.equal(memoryChipModel({ state: 'tight' }).title, '');
});

test('the owner unload button is offered only when the broker says it is enabled', () => {
  assert.equal(memoryChipModel({ state: 'tight', canUnload: true }).canUnload, true);
  assert.equal(memoryChipModel({ state: 'tight', canUnload: false }).canUnload, false);
  assert.equal(memoryChipModel({ state: 'tight' }).canUnload, false);
});

test('the branch tab says when it is showing the last list while a refresh runs, and says nothing otherwise', () => {
  assert.equal(branchListRefreshingHtml(false), '');
  assert.equal(branchListRefreshingHtml(undefined), '');
  assert.match(branchListRefreshingHtml(true), /data-list-refreshing/);
  assert.match(branchListRefreshingHtml(true), /Refreshing the branch list/);
});

test('wiring: the header has the chip element, the summary refresh renders it, and the button posts to the dashboard route', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'index.html'), 'utf8');
  assert.match(html, /<span id="memory-chip" hidden><\/span>/);
  const tabs = read('branches-joblist-hardware-tabs.js');
  assert.match(tabs, /counts = await fetchJson\('\/api\/summary'\);[\s\S]{0,200}renderMemoryChip\(counts\.memory\);/);
  assert.match(tabs, /fetch\('\/api\/memory\/unload-ollama', \{ method: 'POST' \}\)/);
  assert.match(tabs, /r\.status === 403 \|\| r\.status === 404/);
  assert.match(tabs, /if \(!model\.visible\) \{ el\.hidden = true; el\.className = ''/);          // a hidden chip must also drop .chip (display:inline-block would beat [hidden])
  assert.match(read('branch-projects.js'), /branchListRefreshing = r\.headers\.get\('X-Branch-Refreshing'\) === '1'/);
  assert.match(read('branch-verdicts.js'), /branchListRefreshingHtml\(branchListRefreshing\)/);
});
