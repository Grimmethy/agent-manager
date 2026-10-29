'use strict';

// Tailnet gateway (scripts/tailnet-gateway.js): owner-only TCP forwarding from this machine's Tailscale address to the loopback-only
// dashboard and plugin servers. No real tailscale and no network beyond 127.0.0.x: whois is injected.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const gw = require('./tailnet-gateway.js');

const OWNER = 'grimmethy@gmail.com';
const whoisJson = (login, extra = {}) => ({Node: {Name: 'x.tail.ts.net.'}, UserProfile: {LoginName: login}, ...extra});

test('parseWhois: the login is lower-cased and the node name kept; a reply without a user profile is an error', () => {
  assert.deepEqual(gw.parseWhois(whoisJson('Grimmethy@Gmail.com')), {login: OWNER, node: 'x.tail.ts.net.'});
  assert.throws(() => gw.parseWhois({Node: {Name: 'n'}}), /user/i);
  assert.throws(() => gw.parseWhois(null), /whois/i);
});

test('assertTailnetAddress: only Tailscale addresses (100.64.0.0/10 and fd7a:115c:a1e0::/48) may be bound', () => {
  for (const ok of ['100.66.239.100', '100.64.0.1', '100.127.255.255', 'fd7a:115c:a1e0::1', 'FD7A:115C:A1E0:ab12::5']) {
    assert.doesNotThrow(() => gw.assertTailnetAddress(ok), ok);
  }
  for (const bad of ['0.0.0.0', '127.0.0.1', '192.168.1.5', '100.128.0.1', '100.63.255.255', '::', '', 'localhost', undefined]) {
    assert.throws(() => gw.assertTailnetAddress(bad), /tailscale|tailnet/i, String(bad));
  }
});

test('makeAuthorizer: an owner passes, anyone else is refused with the login in the reason', async () => {
  const auth = gw.makeAuthorizer({owners: [OWNER], whois: async ip => (ip === '100.1.1.1' ? {login: OWNER, node: 'phone'} : {login: 'gypsy46n2@github', node: 'desktop'})});
  assert.deepEqual(await auth('100.1.1.1'), {allowed: true, login: OWNER, node: 'phone', reason: 'owner'});
  const no = await auth('100.2.2.2');
  assert.equal(no.allowed, false);
  assert.match(no.reason, /gypsy46n2@github/);
});

test('makeAuthorizer: owner match is case-insensitive and any listed owner passes', async () => {
  const auth = gw.makeAuthorizer({owners: ['A@x.com', ' b@x.com '], whois: async ip => ({login: ip === '1' ? 'a@x.com' : 'b@x.com', node: 'n'})});
  assert.equal((await auth('1')).allowed, true);
  assert.equal((await auth('2')).allowed, true);
});

test('makeAuthorizer fails CLOSED: a whois error is a refusal, never an allow', async () => {
  const auth = gw.makeAuthorizer({owners: [OWNER], whois: async () => { throw new Error('tailscaled is down'); }});
  const r = await auth('100.1.1.1');
  assert.equal(r.allowed, false);
  assert.match(r.reason, /tailscaled is down/);
});

test('makeAuthorizer with no owners refuses everyone (an empty list must never mean "open")', async () => {
  assert.throws(() => gw.makeAuthorizer({owners: [], whois: async () => ({login: OWNER, node: 'n'})}), /owner/i);
});

test('makeAuthorizer caches an answer for a while: allow longer than deny, and a stale entry is looked up again', async () => {
  let calls = 0, now = 1000;
  const auth = gw.makeAuthorizer({owners: [OWNER], allowTtlMs: 60000, denyTtlMs: 10000, now: () => now,
    whois: async ip => { calls++; return {login: ip === 'good' ? OWNER : 'other@x.com', node: 'n'}; }});
  await auth('good'); await auth('good'); await auth('bad'); await auth('bad');
  assert.equal(calls, 2);                                   // one lookup per address
  now += 11000; await auth('bad'); await auth('good');
  assert.equal(calls, 3);                                   // the deny expired (10 s), the allow did not (60 s)
  now += 50000; await auth('good');
  assert.equal(calls, 4);
});

test('portsFromPluginsJson: the dashboard port plus every plugin url port, unique and sorted; entries without a usable url are ignored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-'));
  const p = path.join(dir, 'plugins.json');
  fs.writeFileSync(p, JSON.stringify([
    {name: 'a', url: 'http://localhost:7430'}, {name: 'b', url: 'http://localhost:7421'}, {name: 'c', url: 'http://localhost:7421'},
    {name: 'd'}, {name: 'e', url: 'not a url'}, {name: 'f', url: 'http://localhost:99999'}, {name: 'g', url: 'http://localhost:7437/'},
  ]));
  assert.deepEqual(gw.portsFromPluginsJson(p, {dashboardPort: 7420}), [7420, 7421, 7430, 7437]);
  assert.deepEqual(gw.portsFromPluginsJson(path.join(dir, 'missing.json'), {dashboardPort: 7420}), [7420]);   // a missing file is not fatal
  fs.writeFileSync(p, '{"plugins": [{"url": "http://localhost:8001"}]}');
  assert.deepEqual(gw.portsFromPluginsJson(p, {dashboardPort: 7420, extraPorts: [9000]}), [7420, 8001, 9000]);   // {plugins: [...]} shape too
});

// --- the forwarding itself: gateway on 127.0.0.2:P, upstream on 127.0.0.1:P, callers pick their "tailnet address" with localAddress ---

function listenEcho() {
  return new Promise(resolve => {
    const seen = {connections: 0, bytes: 0};
    const srv = net.createServer(s => { seen.connections++; s.on('data', d => { seen.bytes += d.length; s.write(d); }); s.on('error', () => {}); });
    srv.listen(0, '127.0.0.1', () => resolve({srv, port: srv.address().port, seen}));
  });
}

function roundTrip(port, local, payload) {
  return new Promise(resolve => {
    const got = [];
    const c = net.connect({host: '127.0.0.2', port, localAddress: local});
    c.on('connect', () => c.write(payload));
    c.on('data', d => { got.push(d); if (Buffer.concat(got).length >= payload.length) c.end(); });
    c.on('close', () => resolve(Buffer.concat(got)));
    c.on('error', () => {});
    setTimeout(() => { c.destroy(); }, 3000);
  });
}

async function withGateway(fn, {whois, owners = [OWNER], upstream} = {}) {
  const up = upstream || await listenEcho();
  const logs = [];
  const g = gw.createGateway({bind: '127.0.0.2', ports: [up.port], target: '127.0.0.1', log: l => logs.push(l),
    authorize: gw.makeAuthorizer({owners, whois: whois || (async ip => ({login: ip === '127.0.0.3' ? OWNER : 'other@x.com', node: ip}))})});
  const res = await g.listen();
  try { await fn({up, g, res, logs, port: up.port}); } finally { await g.close(); up.srv.close(); }
}

test('an owner connection is forwarded both ways, including a payload bigger than one chunk', () => withGateway(async ({port}) => {
  assert.equal((await roundTrip(port, '127.0.0.3', Buffer.from('hello'))).toString(), 'hello');
  const big = Buffer.alloc(300000, 'x');
  const back = await roundTrip(port, '127.0.0.3', big);
  assert.equal(back.length, big.length);
}));

test('a refused caller is closed before ANYTHING reaches the upstream, and the refusal is logged with the login', () => withGateway(async ({port, up, logs}) => {
  const back = await roundTrip(port, '127.0.0.4', Buffer.from('let me in'));
  assert.equal(back.length, 0);
  assert.equal(up.seen.connections, 0);
  assert.ok(logs.some(l => /deny/i.test(l) && /other@x\.com/.test(l)), logs.join('\n'));
}));

test('a whois failure closes the connection too (fail closed) and nothing reaches the upstream', () => withGateway(async ({port, up}) => {
  const back = await roundTrip(port, '127.0.0.3', Buffer.from('hi'));
  assert.equal(back.length, 0);
  assert.equal(up.seen.connections, 0);
}, {whois: async () => { throw new Error('no tailscaled'); }}));

test('bytes sent while the whois lookup is still running are not lost', () => withGateway(async ({port}) => {
  assert.equal((await roundTrip(port, '127.0.0.3', Buffer.from('early bytes'))).toString(), 'early bytes');
}, {whois: async () => { await new Promise(r => setTimeout(r, 150)); return {login: OWNER, node: 'slow'}; }}));

test('an upstream that is down just closes the owner connection (a lazily-started plugin is not up yet)', async () => {
  const up = await listenEcho();
  const {port} = up; up.srv.close(); await new Promise(r => setTimeout(r, 30));
  await withGateway(async ({port: p}) => {
    const back = await roundTrip(p, '127.0.0.3', Buffer.from('anyone?'));
    assert.equal(back.length, 0);
  }, {upstream: {srv: {close() {}}, port, seen: {connections: 0}}});
});

test('a port already taken (a plugin that binds 0.0.0.0) is skipped with the reason, the others still listen', async () => {
  const taken = net.createServer(); await new Promise(r => taken.listen(0, '0.0.0.0', r));
  const free = await listenEcho();
  const g = gw.createGateway({bind: '127.0.0.2', ports: [taken.address().port, free.port], target: '127.0.0.1', log: () => {},
    authorize: gw.makeAuthorizer({owners: [OWNER], whois: async () => ({login: OWNER, node: 'n'})})});
  const res = await g.listen();
  try {
    assert.deepEqual(res.listening, [free.port]);
    assert.equal(res.skipped.length, 1);
    assert.equal(res.skipped[0].port, taken.address().port);
    assert.match(res.skipped[0].error, /EADDRINUSE/);
  } finally { await g.close(); free.srv.close(); taken.close(); }
});

test('close() stops listening: the port refuses new connections afterwards', async () => {
  const up = await listenEcho();
  const g = gw.createGateway({bind: '127.0.0.2', ports: [up.port], target: '127.0.0.1', log: () => {},
    authorize: gw.makeAuthorizer({owners: [OWNER], whois: async () => ({login: OWNER, node: 'n'})})});
  await g.listen(); await g.close();
  await new Promise(resolve => { const c = net.connect({host: '127.0.0.2', port: up.port}); c.on('error', e => { assert.equal(e.code, 'ECONNREFUSED'); resolve(); }); c.on('connect', () => { c.destroy(); assert.fail('still listening'); }); });
  up.srv.close();
});

test('addPorts opens listeners for ports that appear later (a plugin added to plugins.json) and ignores ones already open', async () => {
  const a = await listenEcho(), b = await listenEcho();
  const g = gw.createGateway({bind: '127.0.0.2', ports: [a.port], target: '127.0.0.1', log: () => {},
    authorize: gw.makeAuthorizer({owners: [OWNER], whois: async () => ({login: OWNER, node: 'n'})})});
  await g.listen();
  try {
    const res = await g.addPorts([a.port, b.port]);
    assert.deepEqual(res.listening, [b.port]);
    assert.equal((await roundTrip(b.port, '127.0.0.3', Buffer.from('new'))).toString(), 'new');
  } finally { await g.close(); a.srv.close(); b.srv.close(); }
});
