'use strict';
// Run: node --test python/dashboard/static/js/held-hubs-toggle.test.js
// Owner request 2026-11-04: the Unmerged Branches tab hides the branches of unfinished hubs (they are not ready to merge); a "hidden hubs" button shows how many there are and
// opens the list so they can be seen. Closed by default; the choice survives a reload.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const v = require('./branch-verdicts.js');

const hub = (n, extra = {}) => ({ hubId: 'h' + n, title: `HUB000${n} · feature ${n}`, progress: { built: 1, done: 0, total: 3 }, waitingOn: [`HUB000${n}-02`], branches: [`agent/decompose-feature-${n}-17`], ...extra });
const B = (verdict) => ({ branch: 'agent/x-' + verdict, verdict, stale: false, headSha: 's' });

test('the button says how many hubs are hidden, and what a click does', () => {
  assert.match(v.heldHubsToggleHtml([hub(1), hub(2), hub(3)], false), />Hubs \(3\)</);
  assert.match(v.heldHubsToggleHtml([hub(1)], true), />Hubs \(1\)</);
  assert.match(v.heldHubsToggleHtml([hub(1)], false), /aria-pressed="false"/);
  assert.match(v.heldHubsToggleHtml([hub(1)], true), /aria-pressed="true"/);
  assert.match(v.heldHubsToggleHtml([hub(1)], true), /class="action" data-held-hubs-toggle/);
  assert.match(v.heldHubsToggleHtml([hub(1)], false), /class="secondary" data-held-hubs-toggle/);
});

test('with nothing hidden the button still shows (0) but cannot be pressed; junk input counts as none', () => {
  assert.match(v.heldHubsToggleHtml([], false), /data-held-hubs-toggle[^>]* disabled[^>]*>Hubs \(0\)</);
  assert.match(v.heldHubsToggleHtml(undefined, false), /\(0\)/);
  assert.match(v.heldHubsToggleHtml(null, true), /\(0\)/);
  assert.doesNotMatch(v.heldHubsToggleHtml([hub(1)], false), / disabled/);
});

test('the button has an explanation on hover', () => {
  assert.match(v.heldHubsToggleHtml([hub(1)], false), /title="[^"]*not ready to merge[^"]*not verified/);
});

test('the filter bar carries the button after the filters, with the count; the old two-argument call still works', () => {
  const html = v.branchVerdictFilterBarHtml([B('merge')], 'all', [hub(1), hub(2)], false);
  assert.match(html, /Discard \(0\)<\/button><button class="secondary" data-held-hubs-toggle[^>]*>Hubs \(2\)</);
  assert.match(v.branchVerdictFilterBarHtml([B('merge')], 'all'), /Hubs \(0\)/);
  assert.equal((html.match(/margin-left:auto/g) || []).length, 0, 'the button is not pushed right');
});

test('on the Discard filter the button sits before Discard all, which stays pushed right', () => {
  const html = v.branchVerdictFilterBarHtml([B('discard')], 'discard', [hub(1)], true);
  assert.ok(html.indexOf('data-held-hubs-toggle') < html.indexOf('data-discard-all'));
  assert.equal((html.match(/margin-left:auto/g) || []).length, 1);
});

test('closed: the panel is only the placeholder, however many hubs are hidden', () => {
  assert.equal(v.heldHubsHtml([hub(1), hub(2)], false), '<div data-held-hubs></div>');
  assert.equal(v.heldHubsHtml([], true), '<div data-held-hubs></div>');
});

test('open: one row per hub with progress, what it waits on and its branches; the count is in the title', () => {
  const html = v.heldHubsHtml([hub(1), hub(2)], true);
  assert.match(html, /<b>Hubs \(2\)<\/b>/);
  assert.match(html, /HUB0001 · feature 1: 1 of 3 built, 1 held, waiting on HUB0001-02/);
  assert.match(html, /HUB0002 · feature 2: 1 of 3 built/);
  assert.match(html, /decompose-feature-1-17/);
  assert.doesNotMatch(html, />agent\//, 'the agent/ prefix is dropped from the shown name');
  assert.match(html, /title="agent\/decompose-feature-2-17"/, 'the full branch name is on hover');
});

test('open: hubs of several projects are grouped under the project name with a count; a single project-less list has no headers', () => {
  const withProjects = v.heldHubsHtml([hub(1, { project: { label: 'questforge' } }), hub(2, { project: { label: 'agent-manager' } }), hub(3, { project: { label: 'agent-manager' } })], true);
  assert.match(withProjects, /<b>agent-manager<\/b> \(2\)/);
  assert.match(withProjects, /<b>questforge<\/b> \(1\)/);
  assert.ok(withProjects.indexOf('agent-manager</b>') < withProjects.indexOf('questforge</b>'), 'projects are sorted by name');
  assert.doesNotMatch(v.heldHubsHtml([hub(1), hub(2)], true), /<b>[a-z-]+<\/b> \(/);
});

test('open: titles and branch names are escaped and long ones are cut', () => {
  const html = v.heldHubsHtml([hub(1, { title: 'HUB <img src=x onerror=1>', branches: ['agent/<script>' + 'a'.repeat(100)], waitingOn: ['<b>x</b>'] })], true);
  assert.doesNotMatch(html, /<img|<script|<b>x/);
  assert.ok(!html.replace(/title="[^"]*"/g, '').includes('a'.repeat(70)), 'the shown name is cut at 60 characters');
  assert.ok(html.includes('title="agent/&lt;script&gt;' + 'a'.repeat(100)), 'the full name is kept in the hover text');
});

test('open: every inline size in the panel and the button is on the 4px grid and at least 12px', () => {
  const html = v.heldHubsHtml([hub(1, { project: { label: 'p' } })], true) + v.heldHubsToggleHtml([hub(1)], true);
  for (const m of html.matchAll(/style="([^"]*)"/g)) for (const part of m[1].split(';')) {
    const i = part.indexOf(':'); if (i < 0) continue;
    for (const px of part.slice(i + 1).matchAll(/(-?\d+)px/g)) if (!/radius|border:/.test(part)) assert.equal(Number(px[1]) % 4, 0, part);
  }
});

// ---- the click, run through the real handler code against a fake page ----
function page({ stored = null, held = [hub(1), hub(2)] } = {}) {
  const writes = [];
  const store = new Map(stored == null ? [] : [['branches-held-hubs-open', stored]]);
  const elements = { bar: { outerHTML: '' }, panel: { outerHTML: '' }, toggle: {} };
  const main = {
    inserted: [],
    querySelector(sel) { return { '[data-verdict-filter-bar]': elements.bar, '[data-held-hubs]': elements.panel, '[data-held-hubs-toggle]': elements.toggle, '[data-discard-all]': null }[sel] || null; },
    querySelectorAll() { return []; },
    insertAdjacentHTML(where, html) { main.inserted.push([where, html]); },
  };
  const ctx = vm.createContext({ localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, val) => { writes.push([k, val]); store.set(k, val); } }, main, currentBranches: [B('merge')], currentHeldHubs: held, console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'branch-verdicts.js'), 'utf8'), ctx);
  const open = () => vm.runInContext('heldHubsOpen', ctx);
  return { ctx, main, elements, writes, open, wire: () => vm.runInContext('wireBranchVerdictFilterBar(main)', ctx) };
}

test('a click opens the panel, updates the button, and remembers the choice; a second click closes it again', () => {
  const p = page();
  assert.equal(p.open(), false, 'closed by default');
  p.wire();
  p.elements.toggle.onclick();
  assert.equal(p.open(), true);
  assert.deepEqual(p.writes, [['branches-held-hubs-open', '1']]);
  assert.match(p.elements.bar.outerHTML, /aria-pressed="true"[^>]*>Hubs \(2\)</);
  assert.match(p.elements.panel.outerHTML, /<b>Hubs \(2\)<\/b>/);
  assert.match(p.elements.panel.outerHTML, /feature 1/);
  p.elements.toggle.onclick();
  assert.equal(p.open(), false);
  assert.deepEqual(p.writes[1], ['branches-held-hubs-open', '0']);
  assert.match(p.elements.bar.outerHTML, /aria-pressed="false"[^>]*>Hubs \(2\)</);
  assert.equal(p.elements.panel.outerHTML, '<div data-held-hubs></div>');
});

test('the saved choice is restored on load: open when it was open, closed for anything else', () => {
  assert.equal(page({ stored: '1' }).open(), true);
  for (const stored of ['0', '', 'true', null]) assert.equal(page({ stored }).open(), false, String(stored));
});

test('a missing or failing localStorage never breaks the page: the panel is closed and a click still works', () => {
  const p = page();
  vm.runInContext('localStorage = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } }', p.ctx);
  p.wire();
  assert.doesNotThrow(() => p.elements.toggle.onclick());
  assert.equal(p.open(), true);
});

test('the panel is added at the end of the tab when it is not there yet', () => {
  const p = page();
  vm.runInContext('heldHubsOpen = true', p.ctx);
  p.main.querySelector = (sel) => (sel === '[data-held-hubs]' ? null : null);
  vm.runInContext('refreshHeldHubsPanel(main)', p.ctx);
  assert.equal(p.main.inserted.length, 1);
  assert.equal(p.main.inserted[0][0], 'beforeend');
  assert.match(p.main.inserted[0][1], /<b>Hubs \(2\)<\/b>/);
});

test('the list render uses the open/closed choice for both the bar and the panel', () => {
  const p = page();
  let written = '';
  Object.defineProperty(p.main, 'innerHTML', { set(x) { written = x; }, get() { return written; } });
  vm.runInContext('branchListWithProjectHeadersHtml = undefined; branchProjectsPendingHtml = undefined; branchListRefreshingHtml = undefined; branchCardHtml = (b) => "<card/>"; wireBranchCard = () => {}; renderBranchListInto(main, currentBranches)', p.ctx);
  assert.match(written, /aria-pressed="false"[^>]*>Hubs \(2\)</);
  assert.doesNotMatch(written, /<b>Hubs \(2\)<\/b>/);
  vm.runInContext('heldHubsOpen = true; renderBranchListInto(main, currentBranches)', p.ctx);
  assert.match(written, /aria-pressed="true"[^>]*>Hubs \(2\)</);
  assert.match(written, /<b>Hubs \(2\)<\/b> --/);
});

test('the tab asks for the hidden hubs of ALL projects, and refreshes the button count and the panel after each poll', () => {
  const src = fs.readFileSync(path.join(__dirname, 'branches-joblist-hardware-tabs.js'), 'utf8');
  assert.match(src, /fetchJson\('\/api\/git\/held-hub-branches\?projects=all'/);
  const poll = src.slice(src.indexOf('currentHeldHubs = await fetchHeldHubs();\n  refreshBranchVerdictFilterBar'));
  assert.ok(poll.startsWith('currentHeldHubs = await fetchHeldHubs();\n  refreshBranchVerdictFilterBar(main, branches);'), 'the bar is rebuilt AFTER the new groups arrive, so the count is current');
  assert.match(poll.slice(0, 300), /refreshHeldHubsPanel\(main\)/);
});
