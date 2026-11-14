'use strict';
// Run: node --test python/dashboard/static/js/nav-icons.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const icons = require('./nav-icons.js');
const ns = require('./nav-sections.js');

const LIVE_KEYS = [
  'project', 'workers', 'hardware', 'models', 'joblist', 'plugins', 'deepdive', 'discovery', 'brain-dump', 'filed', 'hygiene', 'concepts', 'reports', 'tokenfold', 'triggers',
  'promptforge', 'adforge', 'scriptforge', 'characterforge', 'postforge', 'cutforge', 'voiceforge', 'storyforge', 'videoforge', 'sceneforge', 'stageforge', 'sparforge',
  'kaggleforge', 'journalforge', 'gpu-broker', 'annieforge', 'recipeforge', 'intakereel', 'uiforge', 'branches', 'adhoc',
  'pending', 'drafting', 'review', 'approved', 'blocked', 'needs-clarification', 'awaiting-confirm', 'coordinating', 'done',
  'secondbrain', 'agent-manager-wiki', 'wikiforge-wiki', 'propertyforager-wiki', 'books', 'fsbo-callsheet', 'inventory', 'trade-calculator', 'mailroom',
];

test('every one of the 54 live tabs has an icon, and the icon exists', () => {
  assert.equal(LIVE_KEYS.length, 54);
  for (const key of LIVE_KEYS) {
    const name = icons.NAV_TAB_ICONS[key];
    assert.ok(name, `no icon for ${key}`);
    assert.ok(icons.NAV_ICON_PATHS[name], `${key} points at missing icon ${name}`);
  }
});

test('every section has an icon, including More, and every icon in the table is used', () => {
  for (const s of ns.NAV_SECTIONS.map((x) => x.key).concat(['more'])) assert.ok(icons.NAV_ICON_PATHS[icons.NAV_SECTION_ICONS[s]], s);
  const used = new Set([...Object.values(icons.NAV_TAB_ICONS), ...Object.values(icons.NAV_SECTION_ICONS)]);
  assert.deepEqual([...used].sort(), Object.keys(icons.NAV_ICON_PATHS).sort());
});

test('no two tabs in the same section share an icon', () => {
  const tabs = LIVE_KEYS.map((key) => ({ key, label: key }));
  for (const section of ns.buildNavSections(tabs)) {
    const names = ns.navSectionTabs(section).map((t) => icons.NAV_TAB_ICONS[t.key]);
    assert.equal(names.length, new Set(names).size, `${section.key} repeats an icon`);
  }
});

test('the markup is plain shapes only: no scripts, handlers, links or unknown tags, and every tag is closed', () => {
  const allowed = new Set(['path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse']);
  for (const [name, inner] of Object.entries(icons.NAV_ICON_PATHS)) {
    const tags = [...inner.matchAll(/<\s*([a-zA-Z]+)/g)].map((m) => m[1]);
    assert.ok(tags.length > 0, name);
    for (const t of tags) assert.ok(allowed.has(t), `${name} uses <${t}>`);
    assert.doesNotMatch(inner, /\bon\w+\s*=|javascript:|href|<script|<style|url\(/i, name);
    assert.equal((inner.match(/\/>/g) || []).length, tags.length, `${name} has an unclosed tag`);
    assert.doesNotMatch(inner, /\n/, `${name} is on one line`);
  }
});

test('navIconSvg draws a 24-box stroke icon at the requested size and rejects unknown names', () => {
  const svg = icons.navIconSvg('git-branch');
  assert.match(svg, /^<svg class="nav-ic" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">/);
  assert.ok(svg.endsWith('</svg>'));
  assert.match(icons.navIconSvg('git-branch', 20), /width="20" height="20"/);
  assert.match(icons.navIconSvg('git-branch', 17.6), /width="18" height="18"/);
  for (const bad of [0, -4, NaN, 'x', Infinity]) assert.match(icons.navIconSvg('git-branch', bad), /width="16" height="16"/, String(bad));
  assert.equal(icons.navIconSvg('nope'), '');
  assert.equal(icons.navIconSvg(undefined), '');
});

test('navTabIcon: the key maps to its icon, an explicit known icon wins, an unknown one falls back, unknown tabs get nothing', () => {
  assert.equal(icons.navTabIcon({ key: 'branches' }), icons.navIconSvg('git-branch'));
  assert.equal(icons.navTabIcon({ key: 'branches', icon: 'mail' }), icons.navIconSvg('mail'));
  assert.equal(icons.navTabIcon({ key: 'branches', icon: 'not-an-icon' }), icons.navIconSvg('git-branch'));
  assert.equal(icons.navTabIcon({ key: 'some-new-plugin' }), '');
  assert.equal(icons.navTabIcon(null), '');
  assert.match(icons.navTabIcon({ key: 'books' }, 20), /width="20"/);
});

test('navSectionIcon: one per section, none for unknown or missing', () => {
  assert.equal(icons.navSectionIcon({ key: 'queue' }), icons.navIconSvg('list-todo'));
  assert.equal(icons.navSectionIcon({ key: 'forges' }), icons.navIconSvg('hammer'));
  assert.equal(icons.navSectionIcon({ key: 'more' }), icons.navIconSvg('folder-open'));
  assert.equal(icons.navSectionIcon({ key: 'nope' }), '');
  assert.equal(icons.navSectionIcon(null), '');
});

test('the Lucide ISC notice travels with the icons', () => {
  const src = fs.readFileSync(path.join(__dirname, 'nav-icons.js'), 'utf8');
  assert.match(src, /Lucide \(https:\/\/lucide\.dev/);
  assert.match(src, /ISC License/);
  assert.match(src, /Copyright \(c\) \d{4} Lucide Icons and Contributors/);
  assert.match(src, /Permission to use, copy, modify, and\/or distribute this software for any/);
});

test('page wiring: index.html loads nav-icons.js before nav-sections.js and styles the icons', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'index.html'), 'utf8');
  assert.ok(html.indexOf('/static/js/nav-icons.js') > 0);
  assert.ok(html.indexOf('/static/js/nav-icons.js') < html.indexOf('/static/js/nav-sections.js'));
  assert.match(html, /\.nav-tab-label \{ display: inline-flex; align-items: center; gap: 10px;/);
  assert.match(html, /\.nav-ic \{ flex: none; color: var\(--muted\); \}/);
  assert.match(html, /nav button\.active \.nav-ic \{ color: var\(--accent\); \}/);
  assert.match(html, /nav\.nav-rail button\.rail-btn\.active \.nav-ic \{ color: var\(--accent-text\); \}/);
});
