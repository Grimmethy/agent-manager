'use strict';
// Run: node --test python/dashboard/static/js/nav-notch.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const nn = require('./nav-notch.js');

test('the ball is centred vertically on the active button', () => {
  assert.equal(nn.navNotchTop(100, 40), 114);
  assert.equal(nn.navNotchTop(0, 12), 0);
  assert.equal(nn.navNotchTop(51, 35, 12), 63);
});

test('keyframes start on the old row, arc outward and larger at the midpoint, end on the new row', () => {
  const k = nn.navNotchKeyframes(10, 50);
  assert.equal(k.length, 3);
  assert.equal(k[0].transform, 'translate(0px, 10px) scale(1)');
  assert.equal(k[1].transform, `translate(${nn.NAV_NOTCH_HOP_PX}px, 30px) scale(1.25)`);
  assert.equal(k[1].offset, 0.5);
  assert.equal(k[2].transform, 'translate(0px, 50px) scale(1)');
});

test('keyframes work when moving up the list', () => {
  const k = nn.navNotchKeyframes(200, 20);
  assert.equal(k[0].transform, 'translate(0px, 200px) scale(1)');
  assert.match(k[1].transform, /, 110px\)/);
  assert.equal(k[2].transform, 'translate(0px, 20px) scale(1)');
});

test('the hop fits the 200 ms motion budget', () => {
  assert.equal(nn.NAV_NOTCH_MS, 200);
  assert.equal(nn.navNotchPlan({ lastKey: 'a', lastTop: 1, activeKey: 'b', newTop: 9, reducedMotion: false }).durationMs, 200);
});

const base = { lastKey: 'workers', lastTop: 63, activeKey: 'branches', newTop: 1232, reducedMotion: false };

test('a changed active tab with a previous position animates', () => {
  const plan = nn.navNotchPlan(base);
  assert.equal(plan.animate, true);
  assert.equal(plan.keyframes.length, 3);
});

test('no animation on a re-render of the same tab', () => {
  const plan = nn.navNotchPlan({ ...base, activeKey: 'workers', newTop: 63 });
  assert.equal(plan.animate, false);
  assert.equal(plan.keyframes, null);
});

test('no animation when the same tab moved because a group expanded', () => {
  assert.equal(nn.navNotchPlan({ ...base, activeKey: 'workers', newTop: 200 }).animate, false);
});

test('no animation on the first render', () => {
  assert.equal(nn.navNotchPlan({ ...base, lastTop: null, lastKey: null }).animate, false);
  assert.equal(nn.navNotchPlan({ ...base, lastTop: undefined, lastKey: undefined }).animate, false);
});

test('no animation unless BOTH a previous tab and a previous position are known', () => {
  assert.equal(nn.navNotchPlan({ ...base, lastTop: null }).animate, false);
  assert.equal(nn.navNotchPlan({ ...base, lastTop: undefined }).animate, false);
  assert.equal(nn.navNotchPlan({ ...base, lastKey: null }).animate, false);
  assert.equal(nn.navNotchPlan({ ...base, lastKey: undefined }).animate, false);
});

test('no animation when the tab changed but the ball would not move', () => {
  assert.equal(nn.navNotchPlan({ ...base, newTop: 63 }).animate, false);
});

test('reduced motion disables the animation', () => {
  assert.equal(nn.navNotchPlan({ ...base, reducedMotion: true }).animate, false);
});

// --- navNotchUpdate against a tiny fake DOM ---
// The module keeps the last active tab and position between renders (that is how it knows whether to animate), so these four tests run in order: project, workers (moved), workers (same), no active button.
function fakeEnv(activeTabKey) {
  const appended = [];
  const animations = [];
  global.activeTab = activeTabKey;
  global.document = {
    createElement: () => {
      const el = { className: '', style: {}, attrs: {}, innerHTML: '', setAttribute(k, v) { this.attrs[k] = v; }, animate(frames, opts) { animations.push({ frames, opts }); } };
      return el;
    },
  };
  const nav = { querySelector: (sel) => (sel === 'button.active' && nav.active) || null, appendChild: (el) => appended.push(el), active: { offsetTop: 100, offsetHeight: 40 } };
  return { nav, appended, animations };
}

test('navNotchUpdate adds one hidden-from-screen-readers ball positioned on the active button', () => {
  const env = fakeEnv('project');
  const plan = nn.navNotchUpdate(env.nav);
  assert.equal(env.appended.length, 1);
  assert.equal(env.appended[0].className, 'nav-notch');
  assert.equal(env.appended[0].attrs['aria-hidden'], 'true');
  assert.match(env.appended[0].innerHTML, /nav-notch-ball/);
  assert.equal(env.appended[0].style.transform, 'translate(0px, 114px)');
  assert.equal(plan.animate, false);
  assert.equal(env.animations.length, 0);
});

test('navNotchUpdate animates when the active tab changes on the next render', () => {
  const env = fakeEnv('workers');
  env.nav.active = { offsetTop: 400, offsetHeight: 40 };
  nn.navNotchUpdate(env.nav);
  assert.equal(env.animations.length, 1);
  assert.equal(env.animations[0].opts.duration, 200);
  assert.equal(env.animations[0].frames[0].transform, 'translate(0px, 114px) scale(1)');
  assert.equal(env.animations[0].frames[2].transform, 'translate(0px, 414px) scale(1)');
});

test('a re-render of the same tab only places the ball', () => {
  const env = fakeEnv('workers');
  env.nav.active = { offsetTop: 400, offsetHeight: 40 };
  nn.navNotchUpdate(env.nav);
  assert.equal(env.animations.length, 0);
  assert.equal(env.appended[0].style.transform, 'translate(0px, 414px)');
});

test('navNotchUpdate does nothing without an active button or nav', () => {
  const env = fakeEnv('x');
  env.nav.active = null;
  assert.equal(nn.navNotchUpdate(env.nav), null);
  assert.equal(env.appended.length, 0);
  assert.equal(nn.navNotchUpdate(null), null);
});

test('the page wiring: renderNav calls it, index.html loads it and hides it on the narrow layout', () => {
  const core = fs.readFileSync(path.join(__dirname, 'core-ui.js'), 'utf8');
  assert.match(core, /if \(typeof navNotchUpdate === 'function'\) navNotchUpdate\(nav\);/);
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'index.html'), 'utf8');
  assert.match(html, /<script src="\/static\/js\/nav-notch\.js"><\/script>/);
  assert.ok(html.indexOf('/static/js/nav-notch.js') > html.indexOf("filename='js/core-ui.js'"), 'nav-notch.js loads after core-ui.js');
  assert.match(html, /@media \(max-width: 860px\) \{[\s\S]*?\.nav-notch \{ display: none; \}/);
  assert.match(html, /\.nav-notch \{ position: absolute;/);
});
