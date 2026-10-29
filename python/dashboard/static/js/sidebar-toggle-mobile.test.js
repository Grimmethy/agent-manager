'use strict';

// Phone layout of the persistent-sidebar (Chat) plugin, 2026-10-14: at <= 860px the sidebar is a fixed bottom sheet (z-index 15) and its
// "Chat" toggle is a pill at the bottom right (z-index 5), so the sheet COVERED the only control that hides it: on a phone, once the sheet
// was open it could not be closed. The sheet also opened expanded on a first visit. The fix lifts the pill above the sheet (and above its
// top edge while it is open) and starts a first visit on a narrow screen collapsed. The CSS test reads templates/index.html; the behaviour
// tests load the REAL sidebar-and-claude-panels.js into a vm with a tiny fake DOM (it is a plain global <script> in the browser).
//
// Run: node --test python/dashboard/static/js/sidebar-toggle-mobile.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'index.html'), 'utf8');
const SRC = fs.readFileSync(path.join(__dirname, 'sidebar-and-claude-panels.js'), 'utf8');

// ---- the CSS ---------------------------------------------------------------------------------------------------------------------

function mobileCss() {
  const start = HTML.indexOf('@media (max-width: 860px)');
  assert.ok(start > 0, 'the phone media query exists');
  let depth = 0, i = HTML.indexOf('{', start);
  const from = i;
  for (; i < HTML.length; i++) { if (HTML[i] === '{') depth++; else if (HTML[i] === '}' && --depth === 0) break; }
  return HTML.slice(from + 1, i);
}
const rule = (css, selector) => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp('(?:^|[}\\s])' + esc + '\\s*\\{([^}]*)\\}').exec(css);
  return m ? m[1] : null;
};

test('on a phone the toggle pill sits above the chat sheet (a higher z-index), so it can always be tapped', () => {
  const css = mobileCss();
  const sheet = rule(css, '.plugin-sidebar'), toggle = rule(css, '.plugin-sidebar-toggle');
  const z = body => { const m = /z-index:\s*(\d+)/.exec(body || ''); return m ? Number(m[1]) : null; };
  assert.ok(z(sheet) !== null && z(toggle) !== null, 'both rules set a z-index in the phone block');
  assert.ok(z(toggle) > z(sheet), `toggle z-index ${z(toggle)} must beat the sheet's ${z(sheet)}`);
});

test('while the sheet is open the pill moves up to the sheet\'s top edge instead of hiding under the chat box', () => {
  const css = mobileCss();
  const open = rule(css, '.plugin-sidebar-toggle.sidebar-open');
  assert.ok(open, 'a .sidebar-open rule exists for the pill');
  assert.match(open, /bottom:\s*calc\(65vh/);       // the sheet is 65vh tall
  assert.match(rule(css, '.plugin-sidebar'), /height:\s*65vh/);
});

// ---- the behaviour ---------------------------------------------------------------------------------------------------------------

function fakeDom({narrow, stored}) {
  const store = new Map(stored == null ? [] : [['agentManagerPluginSidebar:chat', stored]]);
  const mk = tag => {
    const cls = new Set();
    const el = {tagName: tag, dataset: {}, children: [], style: {}, onclick: null, parent: null,
      classList: {add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c),
        toggle: (c, force) => { const on = force === undefined ? !cls.has(c) : force; on ? cls.add(c) : cls.delete(c); return on; }},
      appendChild(c) { c.parent = el; el.children.push(c); return c; }, remove() { if (el.parent) el.parent.children = el.parent.children.filter(x => x !== el); },
      querySelector: () => null, querySelectorAll: () => []};
    Object.defineProperty(el, 'className', {get: () => [...cls].join(' '), set: v => { cls.clear(); String(v).split(/\s+/).filter(Boolean).forEach(c => cls.add(c)); }});
    return el;
  };
  const layout = mk('div'), body = mk('body');
  const all = sel => {
    const out = [];
    const walk = n => { for (const c of n.children) { out.push(c); walk(c); } };
    walk(layout); walk(body);
    const cls = /^\.([\w-]+)/.exec(sel)[1];
    const dp = /\[data-plugin="([^"]+)"\]/.exec(sel);
    return out.filter(e => e.classList.contains(cls) && (!dp || e.dataset.plugin === dp[1]));
  };
  layout.querySelectorAll = all;
  const document = {getElementById: id => (id === 'layout' ? layout : null), createElement: mk, body, querySelectorAll: all, querySelector: s => all(s)[0] || null};
  const localStorage = {getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v))};
  const window = {matchMedia: q => ({matches: /max-width:\s*860px/.test(q) ? narrow : false})};
  return {document, localStorage, window, store};
}

function load({narrow, stored}) {
  const dom = fakeDom({narrow, stored});
  const fetched = [];
  const ctx = vm.createContext({...dom, console, fetch: async (url) => {
    fetched.push(url);
    if (String(url).startsWith('/api/plugins') && !String(url).includes('/proxy/')) {
      return {ok: true, json: async () => ({plugins: [{name: 'chat', slotKind: 'persistent-sidebar', active: true, url: 'http://localhost:7442', sidebarLabel: 'Chat'}]})};
    }
    return {ok: true, json: async () => ({})};
  }, fetchJson: async u => ({plugins: [{name: 'chat', slotKind: 'persistent-sidebar', active: true, url: 'http://localhost:7442', sidebarLabel: 'Chat'}]})});
  vm.runInContext(SRC, ctx);
  return {ctx, dom, fetched};
}
const parts = dom => ({aside: dom.document.querySelector('.plugin-sidebar'), toggle: dom.document.querySelector('.plugin-sidebar-toggle')});

test('first visit on a narrow screen starts COLLAPSED (a phone is not handed a 65vh chat sheet), and the pill is not marked open', async () => {
  const {ctx, dom} = load({narrow: true, stored: null});
  await vm.runInContext('mountPersistentSidebarPlugins()', ctx);
  const {aside, toggle} = parts(dom);
  assert.ok(aside.classList.contains('sidebar-collapsed'));
  assert.equal(toggle.classList.contains('sidebar-open'), false);
});

test('first visit on a wide screen starts expanded as before, and the pill is marked open', async () => {
  const {ctx, dom} = load({narrow: false, stored: null});
  await vm.runInContext('mountPersistentSidebarPlugins()', ctx);
  const {aside, toggle} = parts(dom);
  assert.equal(aside.classList.contains('sidebar-collapsed'), false);
  assert.equal(toggle.classList.contains('sidebar-open'), true);
});

test('a stored choice always wins over the screen size (expanded stays expanded on a phone, collapsed stays collapsed on a desktop)', async () => {
  let t = load({narrow: true, stored: 'expanded'});
  await vm.runInContext('mountPersistentSidebarPlugins()', t.ctx);
  assert.equal(parts(t.dom).aside.classList.contains('sidebar-collapsed'), false);
  assert.equal(parts(t.dom).toggle.classList.contains('sidebar-open'), true);
  t = load({narrow: false, stored: 'collapsed'});
  await vm.runInContext('mountPersistentSidebarPlugins()', t.ctx);
  assert.equal(parts(t.dom).aside.classList.contains('sidebar-collapsed'), true);
  assert.equal(parts(t.dom).toggle.classList.contains('sidebar-open'), false);
});

test('tapping the pill toggles the sheet, the pill\'s open marker and the stored choice together', async () => {
  const {ctx, dom} = load({narrow: true, stored: null});
  await vm.runInContext('mountPersistentSidebarPlugins()', ctx);
  const {aside, toggle} = parts(dom);
  toggle.onclick();                                                   // open
  assert.equal(aside.classList.contains('sidebar-collapsed'), false);
  assert.equal(toggle.classList.contains('sidebar-open'), true);
  assert.equal(dom.store.get('agentManagerPluginSidebar:chat'), 'expanded');
  toggle.onclick();                                                   // hide again
  assert.equal(aside.classList.contains('sidebar-collapsed'), true);
  assert.equal(toggle.classList.contains('sidebar-open'), false);
  assert.equal(dom.store.get('agentManagerPluginSidebar:chat'), 'collapsed');
});

test('"Send to chat" un-collapses the sheet AND marks the pill open, so the pill is where the sheet\'s top edge is', async () => {
  const {ctx, dom} = load({narrow: true, stored: null});
  await vm.runInContext('mountPersistentSidebarPlugins()', ctx);
  await vm.runInContext('sendTextToChat("hello")', ctx);
  const {aside, toggle} = parts(dom);
  assert.equal(aside.classList.contains('sidebar-collapsed'), false);
  assert.equal(toggle.classList.contains('sidebar-open'), true);
});
