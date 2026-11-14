'use strict';
// Run: TMPDIR=/dev/shm/x node --test python/dashboard/static/js/forge-navigate.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fn = require('./forge-navigate.js');

const ok = (over = {}) => ({ origin: 'http://localhost:7433', data: { type: 'forge-navigate', tab: 'promptforge', handoff: 'abc123def456', ...over.data }, ...(over.origin ? { origin: over.origin } : {}) });
const PORTS = [7430, 7433];

test('ports come from the plugins registered urls', () => {
  assert.deepEqual(fn.forgePortsFromPlugins([{ url: 'http://localhost:7430' }, { url: 'http://localhost:7433/' }, { url: 'http://localhost:7430' }, { url: 'nope' }, {}, null, { url: 'https://x.test' }]), [7430, 7433, 443]);
  assert.deepEqual(fn.forgePortsFromPlugins(undefined), []);
});

test('a well-formed message from the same host on a known port passes', () => {
  assert.equal(fn.isAllowedForgeMessage(ok(), PORTS, 'localhost'), true);
  assert.equal(fn.isAllowedForgeMessage(ok({ origin: 'http://grimm:7430' }), PORTS, 'grimm'), true);
});

test('another hostname fails', () => {
  assert.equal(fn.isAllowedForgeMessage(ok({ origin: 'http://evil.example:7433' }), PORTS, 'localhost'), false);
  assert.equal(fn.isAllowedForgeMessage(ok({ origin: 'http://127.0.0.1:7433' }), PORTS, 'localhost'), false);
});

test('an unknown port fails (including the dashboard itself and no port)', () => {
  assert.equal(fn.isAllowedForgeMessage(ok({ origin: 'http://localhost:7420' }), PORTS, 'localhost'), false);
  assert.equal(fn.isAllowedForgeMessage(ok({ origin: 'http://localhost' }), PORTS, 'localhost'), false);
});

test('a wrong type, a missing or bad handoff, a non-string tab all fail', () => {
  assert.equal(fn.isAllowedForgeMessage(ok({ data: { type: 'other' } }), PORTS, 'localhost'), false);
  assert.equal(fn.isAllowedForgeMessage(ok({ data: { handoff: undefined } }), PORTS, 'localhost'), false);
  assert.equal(fn.isAllowedForgeMessage(ok({ data: { handoff: '../etc/x' } }), PORTS, 'localhost'), false);
  assert.equal(fn.isAllowedForgeMessage(ok({ data: { tab: 7 } }), PORTS, 'localhost'), false);
  assert.equal(fn.isAllowedForgeMessage(ok({ data: { tab: 'a b' } }), PORTS, 'localhost'), false);
  assert.equal(fn.isAllowedForgeMessage({ origin: 'http://localhost:7433', data: 'forge-navigate' }, PORTS, 'localhost'), false);
  assert.equal(fn.isAllowedForgeMessage(null, PORTS, 'localhost'), false);
  assert.equal(fn.isAllowedForgeMessage({ origin: 'null', data: ok().data }, PORTS, 'localhost'), false);
});

function env(over = {}) {
  const posted = [], toasts = [], switched = [];
  const frame = { src: 'http://localhost:7430/', contentWindow: { postMessage: (m, o) => posted.push([m, o]) } };
  const e = {
    hostname: 'localhost', knownPorts: async () => PORTS, findTab: (k) => (k === 'promptforge' ? { key: k, label: 'PromptForge' } : null),
    activeTab: () => 'project', switchTab: (k) => switched.push(k), findFrame: () => null, waitForFrame: async () => frame, toast: (m) => toasts.push(m), label: () => 'PromptForge', ...over,
  };
  return { e, posted, toasts, switched, frame };
}

test('a valid message switches the tab and posts pf-handoff to the frame at the frames own origin, never *', async () => {
  const { e, posted, switched } = env();
  assert.equal(await fn.handleForgeNavigate(ok(), e), 'sent');
  assert.deepEqual(switched, ['promptforge']);
  assert.deepEqual(posted, [[{ type: 'pf-handoff', id: 'abc123def456' }, 'http://localhost:7430']]);
});

test('already on that tab with its frame present: no switch (it would reload the frame), the frame is taken as loaded', async () => {
  let asked;
  const { e, posted, switched } = env({ activeTab: () => 'promptforge', findFrame: () => ({}), waitForFrame: async (t, already) => { asked = already; return { src: 'http://localhost:7430/', contentWindow: { postMessage: (m, o) => posted.push([m, o]) } }; } });
  assert.equal(await fn.handleForgeNavigate(ok(), e), 'sent');
  assert.deepEqual(switched, []);
  assert.equal(asked, true);
  assert.equal(posted.length, 1);
});

test('a message from another origin, with a bad shape, or naming a missing tab does nothing and says nothing', async () => {
  for (const ev of [ok({ origin: 'http://evil.example:7430' }), ok({ data: { type: 'x' } }), ok({ data: { tab: 'nosuchtab' } })]) {
    const { e, posted, switched, toasts } = env();
    assert.equal(await fn.handleForgeNavigate(ev, e), 'ignored');
    assert.deepEqual([posted, switched, toasts], [[], [], []]);
  }
});

test('plugins that cannot be read fall back to the built-in forge ports; an empty list too', async () => {
  for (const kp of [async () => { throw new Error('down'); }, async () => []]) {
    const { e, posted } = env({ knownPorts: kp });
    assert.equal(await fn.handleForgeNavigate(ok(), e), 'sent');
    assert.equal(posted.length, 1);
  }
});

test('a tab whose frame never appears gives the Could not open toast and posts nothing', async () => {
  const { e, posted, toasts } = env({ waitForFrame: async () => null });
  assert.equal(await fn.handleForgeNavigate(ok(), e), 'failed');
  assert.deepEqual(toasts, ['Could not open PromptForge']);
  assert.deepEqual(posted, []);
});

// ---- forgeWaitForFrame with an injected clock and a fake DOM ----
function clock() {
  const timers = []; let id = 0;
  return { setTimeoutFn: (f, ms) => { timers.push({ id: ++id, f, ms, live: true }); return id; }, clearTimeoutFn: (i) => { const t = timers.find((x) => x.id === i); if (t) t.live = false; }, fire: () => timers.filter((t) => t.live).forEach((t) => { t.live = false; t.f(); }), timers };
}

test('waits for the load event of a frame that appears later, and stops observing', async () => {
  const c = clock(); let frame = null, obsCb = null, stopped = 0, loadCb = null, loads = 0;
  const p = fn.forgeWaitForFrame({ findFrame: () => frame, observe: (cb) => { obsCb = cb; return () => { stopped++; }; }, onLoad: (f, cb) => { loads++; loadCb = cb; }, ...c, assumeLoaded: false, ms: 10000 });
  frame = { id: 'f' }; obsCb(); obsCb();                 // appears; a second mutation must not attach a second listener
  assert.equal(typeof loadCb, 'function');
  assert.equal(loads, 1);
  loadCb();
  assert.deepEqual(await p, { id: 'f' });
  assert.equal(stopped, 1);
  assert.equal(c.timers[0].live, false);                 // the timeout was cleared
  assert.equal(c.timers[0].ms, 10000);
});

test('an already-present frame that is assumed loaded resolves at once without observing', async () => {
  const c = clock(); let observed = false;
  const f = { id: 'now' };
  assert.deepEqual(await fn.forgeWaitForFrame({ findFrame: () => f, observe: () => { observed = true; return () => {}; }, onLoad: () => assert.fail('no load wait'), ...c, assumeLoaded: true, ms: 10000 }), f);
  assert.equal(observed, false);
});

test('gives up with null at the timeout when the frame never appears or never loads', async () => {
  const c = clock(); let stopped = 0;
  const p = fn.forgeWaitForFrame({ findFrame: () => null, observe: () => () => { stopped++; }, onLoad: () => {}, ...c, assumeLoaded: false, ms: 10000 });
  c.fire();
  assert.equal(await p, null);
  assert.equal(stopped, 1);
  const c2 = clock();
  const p2 = fn.forgeWaitForFrame({ findFrame: () => ({}), observe: () => () => {}, onLoad: () => {}, ...c2, assumeLoaded: false, ms: 10000 });
  c2.fire();
  assert.equal(await p2, null);
});

test('wiring: the page loads the script, the handler uses the iframes own origin, and no tab renderer or src logic is touched', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'index.html'), 'utf8');
  assert.match(html, /<script src="\/static\/js\/forge-navigate\.js"><\/script>/);
  const src = fs.readFileSync(path.join(__dirname, 'forge-navigate.js'), 'utf8').replace(/^[ \t]*\/\/.*$/gm, '');   // code only: the header comment quotes the forge side's '*'
  assert.match(src, /postMessage\(\{ type: 'pf-handoff', id: handoff \}, origin\)/);
  assert.doesNotMatch(src, /\.src\s*=|setAttribute\('src'/);
  assert.doesNotMatch(src, /postMessage\([^)]*'\*'\)/);
});
