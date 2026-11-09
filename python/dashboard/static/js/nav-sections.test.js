'use strict';
// Run: node --test python/dashboard/static/js/nav-sections.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ns = require('./nav-sections.js');

const t = (key) => ({ key, label: key });
const leaves = (keys) => keys.map(t);
const KEYS = {
  core: ['project', 'workers', 'hardware', 'models', 'joblist', 'plugins', 'deepdive', 'discovery', 'brain-dump', 'filed', 'hygiene', 'concepts', 'reports', 'tokenfold'],
  forges: ['promptforge', 'adforge', 'scriptforge', 'characterforge', 'postforge', 'cutforge', 'voiceforge', 'storyforge', 'videoforge', 'sceneforge', 'stageforge', 'sparforge', 'kaggleforge', 'journalforge', 'gpu-broker', 'annieforge', 'recipeforge', 'intakereel', 'uiforge'],
  status: ['pending', 'drafting', 'review', 'approved', 'blocked', 'needs-clarification', 'awaiting-confirm', 'coordinating', 'done'],
  tail: ['secondbrain', 'agent-manager-wiki', 'wikiforge-wiki', 'propertyforager-wiki', 'books', 'fsbo-callsheet', 'inventory', 'trade-calculator', 'mailroom'],
};
const LIVE = () => [
  ...leaves(KEYS.core),
  { group: 'Forges', children: leaves(KEYS.forges) },
  t('branches'), t('adhoc'),
  { group: 'Job Status', children: leaves(KEYS.status) },
  ...leaves(KEYS.tail),
];
const allKeys = (tabs) => tabs.flatMap((x) => (x.children ? x.children : [x])).map((x) => x.key);
const keysOf = (section) => ns.navSectionTabs(section).map((x) => x.key);

test('the live tab list becomes seven sections in the agreed order', () => {
  const sections = ns.buildNavSections(LIVE());
  assert.deepEqual(sections.map((s) => s.key), ['work', 'queue', 'ideas', 'system', 'forges', 'knowledge', 'business']);
  assert.deepEqual(sections.map((s) => s.label), ['Work', 'Queue', 'Ideas', 'System', 'Forges', 'Knowledge', 'Business']);
});

test('Work holds the daily tabs in order, and only Work starts open', () => {
  const sections = ns.buildNavSections(LIVE());
  assert.deepEqual(keysOf(sections[0]), ['branches', 'workers', 'adhoc', 'project']);
  assert.deepEqual(sections.map((s) => s.defaultOpen), [true, false, false, false, false, false, false]);
});

test('Queue is the job list plus the nine statuses, Ideas / System / Knowledge / Business as agreed', () => {
  const by = Object.fromEntries(ns.buildNavSections(LIVE()).map((s) => [s.key, keysOf(s)]));
  assert.deepEqual(by.queue, ['joblist', ...KEYS.status]);
  assert.deepEqual(by.ideas, ['brain-dump', 'filed', 'concepts', 'discovery', 'deepdive', 'hygiene']);
  assert.deepEqual(by.system, ['hardware', 'models', 'plugins', 'gpu-broker', 'reports', 'tokenfold']);
  assert.deepEqual(by.knowledge, ['secondbrain', 'agent-manager-wiki', 'wikiforge-wiki', 'propertyforager-wiki']);
  assert.deepEqual(by.business, ['books', 'fsbo-callsheet', 'inventory', 'trade-calculator', 'mailroom']);
});

test('Forges is split into Create, Practice and Other; GPU Cards belongs to System, not Forges', () => {
  const forges = ns.buildNavSections(LIVE()).find((s) => s.key === 'forges');
  assert.equal(forges.items.length, 0);
  assert.deepEqual(forges.subgroups.map((g) => g.key), ['create', 'practice', 'other']);
  const sub = Object.fromEntries(forges.subgroups.map((g) => [g.key, g.items.map((x) => x.key)]));
  assert.deepEqual(sub.create, ['promptforge', 'adforge', 'scriptforge', 'characterforge', 'postforge', 'cutforge', 'voiceforge', 'storyforge', 'videoforge', 'sceneforge', 'stageforge']);
  assert.deepEqual(sub.practice, ['sparforge', 'journalforge', 'kaggleforge']);
  assert.deepEqual(sub.other, ['uiforge', 'annieforge', 'recipeforge', 'intakereel']);
});

test('every tab appears exactly once', () => {
  const tabs = LIVE();
  const placed = ns.buildNavSections(tabs).flatMap(keysOf);
  assert.equal(placed.length, new Set(placed).size);
  assert.deepEqual([...placed].sort(), allKeys(tabs).sort());
});

test('a new plugin tab in the Forges group lands in Forges > Other; any other unknown tab lands in More', () => {
  const tabs = LIVE();
  tabs.find((x) => x.group === 'Forges').children.push(t('newforge'));
  tabs.push(t('surprise'));
  const sections = ns.buildNavSections(tabs);
  assert.ok(keysOf(sections.find((s) => s.key === 'forges')).includes('newforge'));
  assert.deepEqual(sections.find((s) => s.key === 'forges').subgroups.find((g) => g.key === 'other').items.map((x) => x.key).slice(-1), ['newforge']);
  const more = sections[sections.length - 1];
  assert.equal(more.key, 'more');
  assert.deepEqual(keysOf(more), ['surprise']);
  assert.equal(more.defaultOpen, false);
});

test('empty sections and sub-groups are left out, a duplicate key is placed once, and bad input is tolerated', () => {
  const sections = ns.buildNavSections([t('workers'), t('workers'), t('promptforge')]);
  assert.deepEqual(sections.map((s) => s.key), ['work', 'forges']);
  assert.deepEqual(sections[1].subgroups.map((g) => g.key), ['create']);
  assert.deepEqual(keysOf(sections[0]), ['workers']);
  assert.deepEqual(ns.buildNavSections([]), []);
  assert.deepEqual(ns.buildNavSections(null), []);
  assert.deepEqual(ns.buildNavSections([null, undefined, {}]), []);
});

test('when a key appears twice the first tab object is the one placed', () => {
  const sections = ns.buildNavSections([{ key: 'workers', label: 'First' }, { key: 'workers', label: 'Second' }, { key: 'zzz', label: 'U1' }, { key: 'zzz', label: 'U2' }]);
  assert.deepEqual(ns.navSectionTabs(sections[0]).map((x) => x.label), ['First']);
  assert.deepEqual(ns.navSectionTabs(sections[1]).map((x) => x.label), ['U1']);
});

test('section membership helpers', () => {
  const sections = ns.buildNavSections(LIVE());
  assert.equal(ns.navSectionContains(sections[1], 'blocked'), true);
  assert.equal(ns.navSectionContains(sections[1], 'workers'), false);
  assert.equal(ns.navSectionContains(sections.find((s) => s.key === 'forges'), 'sparforge'), true);
});

test('open rules: a stored choice wins, otherwise open when it starts open or holds the active tab', () => {
  const o = ns.navSectionOpen;
  assert.equal(o({ stored: 'expanded', defaultOpen: false, containsActive: false }), true);
  assert.equal(o({ stored: 'collapsed', defaultOpen: true, containsActive: true }), false);
  assert.equal(o({ stored: null, defaultOpen: true, containsActive: false }), true);
  assert.equal(o({ stored: null, defaultOpen: false, containsActive: true }), true);
  assert.equal(o({ stored: null, defaultOpen: false, containsActive: false }), false);
  assert.equal(o({ stored: undefined, defaultOpen: undefined, containsActive: undefined }), false);
});

test('Queue summary: badge is the work waiting (not Job List or Done), severity is the worst among the tabs', () => {
  const queue = ns.buildNavSections(LIVE()).find((s) => s.key === 'queue');
  const counts = { pending: 5, drafting: 1, review: 0, approved: 0, blocked: 7, 'needs-clarification': 14, 'awaiting-confirm': 0, coordinating: 1, joblist: 99, done: 392 };
  const sev = { blocked: 'bad', 'needs-clarification': 'warn' };
  assert.deepEqual(ns.navSectionSummary(queue, { countOf: (k) => counts[k], severityOf: (k) => sev[k] || null }), { badge: 28, severity: 'bad' });
  assert.deepEqual(ns.navSectionSummary(queue, { countOf: (k) => counts[k], severityOf: (k) => (k === 'needs-clarification' ? 'warn' : null) }), { badge: 28, severity: 'warn' });
});

test('summary: no badge when the sum is zero or the section has no badge keys; severity looks inside sub-groups', () => {
  const sections = ns.buildNavSections(LIVE());
  const by = Object.fromEntries(sections.map((s) => [s.key, s]));
  assert.deepEqual(ns.navSectionSummary(by.queue, { countOf: () => 0 }), { badge: null, severity: null });
  assert.deepEqual(ns.navSectionSummary(by.queue, {}), { badge: null, severity: null });
  assert.equal(ns.navSectionSummary(by.system, { countOf: () => 5 }).badge, null);
  assert.equal(ns.navSectionSummary(by.ideas, { countOf: (k) => ({ 'brain-dump': 2, filed: 16, concepts: 9 }[k]) }).badge, 18);
  assert.equal(ns.navSectionSummary(by.forges, { severityOf: (k) => (k === 'sparforge' ? 'warn' : null) }).severity, 'warn');
});

// --- the real renderNav on a wide screen, against a small fake DOM ---
function makeEnv({ stored = {}, active = 'project', narrow = false, icons = false, tabs = null } = {}) {
  const store = { ...stored };
  const appended = [];
  const notchCalls = [];
  const mk = (tag) => ({ tag, className: '', style: {}, innerHTML: '', title: '', onclick: null, attrs: {}, children: [], setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); } });
  const nav = { innerHTML: 'old', className: '', appendChild(el) { appended.push(el); } };
  const ctx = vm.createContext({
    console,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } },
    document: { getElementById: (id) => (id === 'nav' ? nav : null), createElement: mk },
    window: { matchMedia: (q) => ({ matches: narrow && /max-width:\s*860px/.test(q), addEventListener() {} }) },
    navNotchUpdate(n) { notchCalls.push(n); },
    counts: { pending: 4, blocked: 7 }, activeTab: active, TAB_COUNT_SEVERITY_THRESHOLDS: { blocked: { bad: 1 } }, switchToTab() {},
    escapeHtml: (s) => String(s),
  });
  if (icons) vm.runInContext(fs.readFileSync(path.join(__dirname, 'nav-icons.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'nav-sections.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'core-ui.js'), 'utf8'), ctx);
  vm.runInContext('TABS = ' + JSON.stringify(tabs || LIVE()), ctx);
  const text = (b) => b.innerHTML.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return { ctx, store, appended, nav, text, notchCalls, sections: () => ctx.buildNavSections(JSON.parse(JSON.stringify(LIVE()))) };
}

test('wide renderNav draws section headers with dividers; only Work is open by default', () => {
  const env = makeEnv();
  env.ctx.renderNav();
  const headers = env.appended.filter((e) => e.className === 'nav-sh');
  assert.deepEqual(headers.map((h) => env.text(h).replace(/\d+$/, '').trim()), ['Work', 'Queue', 'Ideas', 'System', 'Forges', 'Knowledge', 'Business']);
  assert.deepEqual(headers.map((h) => h.attrs['aria-expanded']), ['true', 'false', 'false', 'false', 'false', 'false', 'false']);
  assert.equal(env.appended.filter((e) => e.className === 'nav-div').length, 6);
  const tabButtons = env.appended.filter((e) => !/^nav-/.test(e.className));
  assert.deepEqual(tabButtons.map((b) => env.text(b)), ['branches', 'workers', 'adhoc 0 0', 'project']);
});

test('the Queue header shows the count of work waiting and an attention dot while folded', () => {
  const env = makeEnv();
  env.ctx.renderNav();
  const queue = env.appended.filter((e) => e.className === 'nav-sh')[1];
  assert.match(queue.innerHTML, /<em>11<\/em>/);
  assert.match(queue.innerHTML, /status-dot bad/);
  assert.match(queue.innerHTML, /nav-chev closed/);
});

test('clicking a header saves the choice and re-renders; clicking an open one folds it', () => {
  const env = makeEnv();
  let renders = 0;
  env.ctx.renderNav = ((orig) => () => { renders++; return orig(); })(env.ctx.renderNav);
  env.ctx.renderNav();
  const queue = env.appended.filter((e) => e.className === 'nav-sh')[1];
  queue.onclick();
  assert.equal(env.store.agentManagerNavSection_queue, 'expanded');
  assert.ok(renders >= 2, 're-rendered');
  const env2 = makeEnv({ stored: { agentManagerNavSection_work: 'collapsed' } });
  env2.ctx.renderNav();
  assert.equal(env2.appended.filter((e) => e.className === 'nav-sh')[0].attrs['aria-expanded'], 'false');
  env2.appended.filter((e) => e.className === 'nav-sh')[0].onclick();
});

test('the section holding the active tab opens by itself, and a folded one that holds it is marked', () => {
  const env = makeEnv({ active: 'blocked' });
  env.ctx.renderNav();
  const headers = env.appended.filter((e) => e.className === 'nav-sh');
  assert.equal(headers[1].attrs['aria-expanded'], 'true');
  assert.doesNotMatch(headers[1].innerHTML, /nav-here/, 'no marker while the section is open');
  const env2 = makeEnv({ active: 'blocked', stored: { agentManagerNavSection_queue: 'collapsed' } });
  env2.ctx.renderNav();
  const queue = env2.appended.filter((e) => e.className === 'nav-sh')[1];
  assert.equal(queue.attrs['aria-expanded'], 'false');
  assert.match(queue.innerHTML, /nav-here/);
});

test('Forges shows its three sub-group headers when open, each folded until chosen or active', () => {
  const env = makeEnv({ stored: { agentManagerNavSection_forges: 'expanded' } });
  env.ctx.renderNav();
  const subs = env.appended.filter((e) => /nav-sub-sh/.test(e.className));
  assert.deepEqual(subs.map((s) => env.text(s)), ['Create', 'Practice', 'Other']);
  assert.deepEqual(subs.map((s) => s.attrs['aria-expanded']), ['false', 'false', 'false']);
  const env2 = makeEnv({ stored: { agentManagerNavSection_forges: 'expanded', 'agentManagerNavSection_forges.create': 'expanded' } });
  env2.ctx.renderNav();
  const create = env2.appended.filter((e) => /nav-sub-sh/.test(e.className))[0];
  assert.equal(create.attrs['aria-expanded'], 'true');
  env2.appended.filter((e) => /nav-sub-sh/.test(e.className))[0].onclick();
  assert.equal(env2.store['agentManagerNavSection_forges.create'], 'collapsed');
});

test('renderNav hands the finished nav to the notch on both layouts', () => {
  for (const narrow of [false, true]) {
    const env = makeEnv({ narrow });
    env.ctx.renderNav();
    assert.equal(env.notchCalls.length, 1, narrow ? 'narrow' : 'wide');
    assert.equal(env.notchCalls[0], env.nav);
  }
});

test('the phone layout shows the same sections as the wide one, without the collapse button or the rail', () => {
  const wide = makeEnv(); wide.ctx.renderNav();
  const env = makeEnv({ narrow: true });
  env.ctx.renderNav();
  const heads = (e) => e.appended.filter((x) => x.className === 'nav-sh').map((h) => e.text(h));
  assert.deepEqual(heads(env), heads(wide));
  assert.equal(env.appended.filter((e) => e.className === 'nav-div').length, 6);
  assert.equal(topOf(env), undefined, 'no collapse button on a phone');
  assert.equal(env.nav.className, '');
});

test('a phone ignores a stored collapsed-rail choice (the rail is wide-only)', () => {
  const env = makeEnv({ narrow: true, stored: { agentManagerNavRail: 'collapsed' } });
  env.ctx.renderNav();
  assert.equal(env.nav.className, '');
  assert.ok(env.appended.some((e) => e.className === 'nav-sh'));
});

// --- collapse button and icon rail ---
const topOf = (env) => env.appended.find((e) => e.className === 'nav-top');

test('glyphs: an explicit icon wins, then the leading emoji (including ones with a variation selector or joiners), then the first letter', () => {
  assert.equal(ns.navTabGlyph({ label: '📁 Project', icon: 'P' }), 'P');
  assert.equal(ns.navTabGlyph({ label: '📁 Project' }), '📁');
  assert.equal(ns.navTabGlyph({ label: '🖥️ Hardware' }), '🖥️');
  assert.equal(ns.navTabGlyph({ label: '👨‍👩‍👧 Family' }), '👨‍👩‍👧');
  assert.equal(ns.navTabGlyph({ label: 'FSBO Calls' }), 'F');
  assert.equal(ns.navTabGlyph({ key: 'books' }), 'B');
  assert.equal(ns.navTabGlyph({ label: '' }), '?');
  assert.equal(ns.navTabGlyph(null), '?');
});

test('plain labels drop the leading emoji', () => {
  assert.equal(ns.navTabPlainLabel({ label: '🖥️ Hardware' }), 'Hardware');
  assert.equal(ns.navTabPlainLabel({ label: 'FSBO Calls' }), 'FSBO Calls');
  assert.equal(ns.navTabPlainLabel({ label: '📁' }), '📁');
  assert.equal(ns.navTabPlainLabel(null), '');
});

test('rail entries: a divider between sections, icons for open ones, one button for folded ones', () => {
  const sections = ns.buildNavSections(LIVE());
  const entries = ns.navRailEntries(sections, (s) => s.key === 'work');
  assert.deepEqual(entries.map((e) => e.type), ['tab', 'tab', 'tab', 'tab', 'divider', 'section', 'divider', 'section', 'divider', 'section', 'divider', 'section', 'divider', 'section', 'divider', 'section']);
  assert.deepEqual(entries.filter((e) => e.type === 'tab').map((e) => e.tab.key), ['branches', 'workers', 'adhoc', 'project']);
  assert.deepEqual(entries.filter((e) => e.type === 'section').map((e) => e.section.key), ['queue', 'ideas', 'system', 'forges', 'knowledge', 'business']);
  const allOpen = ns.navRailEntries(sections, () => true);
  assert.equal(allOpen.filter((e) => e.type === 'tab').length, 53);
  assert.equal(allOpen.filter((e) => e.type === 'section').length, 0);
  assert.deepEqual(ns.navRailEntries([], () => true), []);
});

test('the rail key is the stored collapsed marker', () => {
  assert.equal(ns.NAV_RAIL_KEY, 'agentManagerNavRail');
});

test('expanded sidebar: a top row with the round collapse button and the Collapse pill, nav has no rail class', () => {
  const env = makeEnv();
  env.ctx.renderNav();
  const top = topOf(env);
  assert.equal(env.appended[0], top, 'the top row comes first');
  assert.equal(env.nav.className, '');
  const [btn, pill] = top.children;
  assert.equal(btn.className, 'nav-collapse-btn');
  assert.equal(btn.attrs['aria-label'], 'Collapse sidebar');
  assert.equal(btn.attrs['aria-expanded'], 'true');
  assert.match(btn.innerHTML, /M10 3L5 8l5 5/);
  assert.equal(pill.className, 'nav-collapse-pill');
  assert.equal(pill.innerHTML, 'Collapse');
});

test('clicking collapse stores the choice and re-renders as the rail; clicking expand removes it', () => {
  const env = makeEnv();
  env.ctx.renderNav();
  topOf(env).children[0].onclick();
  assert.equal(env.store.agentManagerNavRail, 'collapsed');
  const rail = makeEnv({ stored: { agentManagerNavRail: 'collapsed' } });
  rail.ctx.renderNav();
  rail.appended.find((e) => e.className === 'nav-top').children[0].onclick();
  assert.equal('agentManagerNavRail' in rail.store, false);
});

test('the rail: nav-rail class, a single expand button without the pill, icon buttons for Work and one letter button per folded section', () => {
  const env = makeEnv({ stored: { agentManagerNavRail: 'collapsed' } });
  env.ctx.renderNav();
  assert.equal(env.nav.className, 'nav-rail');
  const top = topOf(env);
  assert.equal(top.children.length, 1);
  assert.equal(top.children[0].attrs['aria-label'], 'Expand sidebar');
  assert.equal(top.children[0].attrs['aria-expanded'], 'false');
  assert.match(top.children[0].innerHTML, /M6 3l5 5-5 5/);
  const tabs = env.appended.filter((e) => /rail-btn/.test(e.className) && !/rail-section/.test(e.className));
  assert.deepEqual(tabs.map((b) => b.title), ['branches', 'workers', 'adhoc', 'project']);
  assert.deepEqual(tabs.map((b) => b.attrs['aria-label']), ['branches', 'workers', 'adhoc', 'project']);
  const folded = env.appended.filter((e) => /rail-section/.test(e.className));
  assert.deepEqual(folded.map((b) => b.attrs['aria-label']), ['Open Queue', 'Open Ideas', 'Open System', 'Open Forges', 'Open Knowledge', 'Open Business']);
  assert.deepEqual(folded.map((b) => env.text(b).replace(/\s+/g, '')), ['Q', 'I', 'S', 'F', 'K', 'B']);
  assert.equal(env.appended.filter((e) => e.className === 'nav-div').length, 6);
  assert.equal(env.appended.filter((e) => /nav-sh/.test(e.className)).length, 0, 'no section headers in the rail');
});

test('rail: the active tab button is marked active, attention dots show on buttons and folded sections', () => {
  const env = makeEnv({ stored: { agentManagerNavRail: 'collapsed', agentManagerNavSection_queue: 'expanded' }, active: 'blocked' });
  env.ctx.renderNav();
  const tabs = env.appended.filter((e) => /rail-btn/.test(e.className) && !/rail-section/.test(e.className));
  const blocked = tabs.find((b) => b.title === 'blocked');
  assert.match(blocked.className, /active/);
  assert.match(blocked.innerHTML, /status-dot bad/);
  assert.equal(tabs.filter((b) => /active/.test(b.className)).length, 1);
  const folded = makeEnv({ stored: { agentManagerNavRail: 'collapsed' } });
  folded.ctx.renderNav();
  const queue = folded.appended.find((e) => e.attrs['aria-label'] === 'Open Queue');
  assert.match(queue.innerHTML, /status-dot bad/);
});

test('clicking a folded section in the rail opens it and widens the sidebar again; clicking a tab switches to it', () => {
  const env = makeEnv({ stored: { agentManagerNavRail: 'collapsed' } });
  const switched = [];
  env.ctx.switchToTab = (k) => switched.push(k);
  env.ctx.renderNav();
  env.appended.find((e) => e.attrs['aria-label'] === 'Open Queue').onclick();
  assert.equal(env.store.agentManagerNavSection_queue, 'expanded');
  assert.equal('agentManagerNavRail' in env.store, false);
  env.appended.find((e) => e.title === 'workers').onclick();
  assert.deepEqual(switched, ['workers']);
});

test('the phone layout has no collapse button and no rail class even when the rail was chosen', () => {
  const env = makeEnv({ narrow: true, stored: { agentManagerNavRail: 'collapsed' } });
  env.ctx.renderNav();
  assert.equal(topOf(env), undefined);
  assert.equal(env.nav.className, '');
  assert.equal(env.appended.filter((e) => /rail-btn/.test(e.className)).length, 0);
});

test('page wiring: index.html styles the collapse button, pill and the 72px rail, the notch hides in the rail', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'index.html'), 'utf8');
  assert.match(html, /nav button\.nav-collapse-btn \{ width: 28px; height: 28px;[^}]*border-radius: 50%;/);
  assert.match(html, /\.nav-collapse-pill \{[^}]*border-radius: 999px; background: var\(--accent\); color: var\(--accent-text\);/);
  assert.match(html, /--accent-text: #0b0d12;/);
  assert.match(html, /nav\.nav-rail \{ width: 72px; \}/);
  assert.match(html, /nav\.nav-rail \.nav-notch \{ display: none; \}/);
  assert.match(html, /nav\.nav-rail button\.rail-btn\.active \{ background: var\(--accent\); color: var\(--accent-text\);/);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\) \{ nav \{ transition: none; \} \}/);
});

// --- line icons in the nav ---
const EMOJI_TABS = () => LIVE().map((x) => (x.children ? x : { ...x, label: ({ branches: '🌿 Hubs', workers: '👷 Workers', adhoc: '📌 Adhoc Tasks', project: '📁 Project' })[x.key] || x.label }));

test('with the icon module, a tab button is the line icon plus the name without its emoji', () => {
  const env = makeEnv({ icons: true, tabs: EMOJI_TABS() });
  env.ctx.renderNav();
  const tabs = env.appended.filter((e) => !/^nav-/.test(e.className));
  const branches = tabs[0];
  assert.match(branches.innerHTML, /^<span class="nav-tab-label"><svg class="nav-ic"/);
  assert.match(branches.innerHTML, /<\/svg><span>Hubs<\/span><\/span>/);
  assert.doesNotMatch(branches.innerHTML, /🌿/);
  assert.match(tabs[1].innerHTML, /<span>Workers<\/span>/);
  assert.equal(tabs.filter((b) => /nav-ic/.test(b.innerHTML)).length, 4);
});

test('the adhoc tab keeps its two counts next to the icon label', () => {
  const env = makeEnv({ icons: true, tabs: EMOJI_TABS() });
  env.ctx.renderNav();
  const adhoc = env.appended.filter((e) => !/^nav-/.test(e.className))[2];
  assert.match(adhoc.innerHTML, /^<span class="nav-tab-label"><svg class="nav-ic"[\s\S]*<span>Adhoc Tasks<\/span><\/span><span class="count">/);
});

test('a tab with no icon keeps its label exactly as it was, and so does everything when the icon module is absent', () => {
  const unknown = [{ key: 'workers', label: 'Workers' }, { key: 'my-plugin-tab', label: '🧪 My Tab' }];
  const env = makeEnv({ icons: true, tabs: unknown, stored: { agentManagerNavSection_more: 'expanded' } });
  env.ctx.renderNav();
  const labelled = env.appended.filter((e) => !/^nav-/.test(e.className));
  assert.match(labelled[1].innerHTML, /^<span>🧪 My Tab<\/span>/);
  const plain = makeEnv({ tabs: EMOJI_TABS() });
  plain.ctx.renderNav();
  assert.match(plain.appended.filter((e) => !/^nav-/.test(e.className))[0].innerHTML, /^<span>🌿 Hubs<\/span>/);
});

test('the rail draws 20px line icons for tabs and for folded sections, and falls back to glyphs and letters without them', () => {
  const env = makeEnv({ icons: true, tabs: EMOJI_TABS(), stored: { agentManagerNavRail: 'collapsed' } });
  env.ctx.renderNav();
  const rail = env.appended.filter((e) => /rail-btn/.test(e.className) && !/rail-section/.test(e.className));
  assert.equal(rail.length, 4);
  for (const b of rail) assert.match(b.innerHTML, /<span class="rail-glyph"><svg class="nav-ic"[^>]*width="20" height="20"/);
  const sections = env.appended.filter((e) => /rail-section/.test(e.className));
  assert.equal(sections.length, 6);
  for (const b of sections) assert.match(b.innerHTML, /<span class="rail-glyph"><svg class="nav-ic"[^>]*width="20" height="20"/);
  const bare = makeEnv({ tabs: EMOJI_TABS(), stored: { agentManagerNavRail: 'collapsed' } });
  bare.ctx.renderNav();
  assert.match(bare.appended.filter((e) => /rail-btn/.test(e.className) && !/rail-section/.test(e.className))[0].innerHTML, /<span class="rail-glyph">🌿<\/span>/);
  assert.match(bare.appended.find((e) => /rail-section/.test(e.className)).innerHTML, /<span class="rail-glyph">Q<\/span>/);
});

test('page wiring: index.html loads nav-sections.js, styles headers and the fading divider, nav is 232px wide', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'index.html'), 'utf8');
  assert.match(html, /<script src="\/static\/js\/nav-sections\.js"><\/script>/);
  assert.match(html, /\.nav-div \{ height: 1px; margin: 12px 8px; background: linear-gradient\(90deg, transparent, var\(--border-strong\), transparent\); \}/);
  assert.match(html, /--border-strong: #5668a0;/);
  assert.match(html, /nav button\.nav-sh \{[^}]*text-transform: uppercase;/);
  assert.match(html, /nav \{ width: 232px;/);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\) \{ \.nav-chev \{ transition: none; \} \}/);
});

test('page wiring: on a phone the nav is ONE sideways row (flex row, no wrap, sections and tabs inline, thin vertical divider)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'index.html'), 'utf8');
  const start = html.indexOf('@media (max-width: 860px)');
  assert.ok(start > 0, 'the phone media query exists');
  const block = html.slice(start, html.indexOf('</style>', start));
  const nav = (block.match(/\n\s*nav \{([^}]*)\}/) || [])[1] || '';
  assert.match(nav, /display:\s*flex/);
  assert.match(nav, /flex-direction:\s*row/);
  assert.match(nav, /overflow-x:\s*auto/);
  assert.doesNotMatch(nav, /max-height/, 'no vertical cap: the row is one line');
  assert.match(block, /nav button[^{]*\{[^}]*white-space:\s*nowrap/);
  assert.match(block, /nav \.nav-div \{[^}]*width:\s*1px/);
});

test('renderNav keeps the sideways scroll position of the phone row when a section is folded or opened', () => {
  const env = makeEnv({ narrow: true });
  // like a real element: emptying it resets the scroll position to the start
  let scroll = 240;
  Object.defineProperty(env.nav, 'scrollLeft', { get: () => scroll, set: (v) => { scroll = v; } });
  Object.defineProperty(env.nav, 'innerHTML', { get: () => '', set: () => { scroll = 0; } });
  env.ctx.renderNav();
  assert.equal(scroll, 240);
});
