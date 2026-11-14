'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chooseAddress, tcpProbe, main, DEFAULT_TIMEOUT_MS } = require('./node-address.js');

function fakeProbe(up) {
  const calls = [];
  return { calls, probe: async (host, port) => { calls.push([host, port]); return up.includes(host); } };
}

test('the LAN address wins when it answers, and the tailnet one is not even tried', async () => {
  const f = fakeProbe(['192.168.40.83', '100.64.0.2']);
  assert.deepEqual(await chooseAddress({ lan: '192.168.40.83', tailnet: '100.64.0.2', port: 7472, probe: f.probe }), { address: '192.168.40.83', via: 'lan' });
  assert.deepEqual(f.calls, [['192.168.40.83', 7472]]);
});

test('the tailnet address is the fallback when the LAN one does not answer', async () => {
  const f = fakeProbe(['100.64.0.2']);
  assert.deepEqual(await chooseAddress({ lan: '192.168.40.83', tailnet: '100.64.0.2', port: 7472, probe: f.probe }), { address: '100.64.0.2', via: 'tailnet' });
  assert.deepEqual(f.calls, [['192.168.40.83', 7472], ['100.64.0.2', 7472]]);
});

test('neither answering gives {address: null, via: null}', async () => {
  const f = fakeProbe([]);
  assert.deepEqual(await chooseAddress({ lan: 'a', tailnet: 'b', port: 1, probe: f.probe }), { address: null, via: null });
  assert.equal(f.calls.length, 2);
});

test('a missing, blank or non-string address is skipped without a probe', async () => {
  const f = fakeProbe(['100.64.0.2', 'only-lan']);
  assert.deepEqual(await chooseAddress({ tailnet: '100.64.0.2', port: 7472, probe: f.probe }), { address: '100.64.0.2', via: 'tailnet' });
  assert.deepEqual(await chooseAddress({ lan: '  ', tailnet: '100.64.0.2', port: 7472, probe: f.probe }), { address: '100.64.0.2', via: 'tailnet' });
  assert.deepEqual(await chooseAddress({ lan: 5, tailnet: null, port: 7472, probe: f.probe }), { address: null, via: null });
  assert.deepEqual(await chooseAddress({ lan: 'only-lan', port: 7472, probe: f.probe }), { address: 'only-lan', via: 'lan' });
  assert.deepEqual(await chooseAddress({ port: 1, probe: f.probe }), { address: null, via: null });
  assert.deepEqual(await chooseAddress(), { address: null, via: null });
  assert.deepEqual(f.calls.map((c) => c[0]), ['100.64.0.2', '100.64.0.2', 'only-lan'], 'only real addresses were probed');
});

test('addresses are trimmed in the answer; a throwing probe counts as not answering', async () => {
  const f = fakeProbe(['lan1']);
  assert.deepEqual(await chooseAddress({ lan: ' lan1 ', tailnet: 'x', port: 1, probe: f.probe }), { address: 'lan1', via: 'lan' });
  const boom = async (host) => { if (host === 'lan1') throw new Error('network down'); return true; };
  assert.deepEqual(await chooseAddress({ lan: 'lan1', tailnet: 'ts', port: 1, probe: boom }), { address: 'ts', via: 'tailnet' });
});

test('a truthy but non-boolean probe answer counts as up, a falsy one as down', async () => {
  assert.deepEqual(await chooseAddress({ lan: 'a', tailnet: 'b', port: 1, probe: async (h) => (h === 'a' ? 0 : 'yes') }), { address: 'b', via: 'tailnet' });
});

async function listening() {
  const server = net.createServer((s) => s.end());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close: () => new Promise((r) => { server.close(r); }) };
}

test('the default probe: an open port is true, a closed port is false, and nothing answering times out quickly', async () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 1500);
  const s = await listening();
  try { assert.equal(await tcpProbe('127.0.0.1', s.port), true); } finally { await s.close(); }
  assert.equal(await tcpProbe('127.0.0.1', s.port), false, 'closed port');
  const started = Date.now();
  assert.equal(await tcpProbe('10.255.255.1', 9, 200), false, 'an address that never answers');
  assert.ok(Date.now() - started < 3000, 'the injected timeout was honoured');
});

test('chooseAddress with the default probe against a real local server: LAN first, tailnet fallback, with the timeout injectable', async () => {
  const s = await listening();
  try {
    assert.deepEqual(await chooseAddress({ lan: '127.0.0.1', tailnet: '127.0.0.2', port: s.port }), { address: '127.0.0.1', via: 'lan' });
    assert.deepEqual(await chooseAddress({ lan: '10.255.255.1', tailnet: '127.0.0.1', port: s.port, timeoutMs: 200 }), { address: '127.0.0.1', via: 'tailnet' });
  } finally { await s.close(); }
});

test('main prints the choice and exits 0 or 3; usage errors exit 2 and print nothing', async () => {
  const out = [];
  const errs = process.stderr.write;
  process.stderr.write = () => true;
  try {
    const up = { probe: async (h) => h === 'ts' };
    assert.equal(await main(['lan', 'ts', '7472'], up, (s) => out.push(JSON.parse(s))), 0);
    assert.deepEqual(out.pop(), { address: 'ts', via: 'tailnet' });
    assert.equal(await main(['lan', '', '7472'], { probe: async () => false }, (s) => out.push(JSON.parse(s))), 3);
    assert.deepEqual(out.pop(), { address: null, via: null });
    assert.equal(await main(['', 'ts', '7472'], up, (s) => out.push(JSON.parse(s))), 0, 'an empty LAN address goes straight to the tailnet');
    out.pop();
    for (const argv of [[], ['lan'], ['lan', 'ts'], ['lan', 'ts', 'x'], ['lan', 'ts', '0'], ['lan', 'ts', '65536'], ['lan', 'ts', '1.5']]) {
      assert.equal(await main(argv, up, () => assert.fail('no output on usage errors')), 2, JSON.stringify(argv));
    }
    assert.equal(await main(['lan', 'ts', '65535'], up, (s) => out.push(s)), 0);
    assert.equal(await main(['lan', 'ts', '1'], up, (s) => out.push(s)), 0);
  } finally { process.stderr.write = errs; }
});

test('the real CLI as a child process against a real local server', async () => {
  const s = await listening();
  const run = (args) => new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(__dirname, 'node-address.js'), ...args]);
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('close', (code) => resolve({ code, out }));
  });
  try {
    const r = await run(['127.0.0.1', '', String(s.port)]);
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out), { address: '127.0.0.1', via: 'lan' });
  } finally { await s.close(); }
  const closed = await run(['127.0.0.1', '', String(s.port)]);
  assert.equal(closed.code, 3);
  assert.deepEqual(JSON.parse(closed.out), { address: null, via: null });
  assert.equal((await run(['only-one'])).code, 2);
});

function fakeSocket() {
  const sock = new EventEmitter();
  sock.destroyed = 0;
  sock.timeoutMs = null;
  sock.setTimeout = (ms, cb) => { sock.timeoutMs = ms; sock.onTimeout = cb; };
  sock.destroy = () => { sock.destroyed += 1; };
  return sock;
}

test('tcpProbe with a fake socket: connect is true, an error is false, a timeout is false, and the socket is destroyed exactly once each time', async () => {
  for (const [event, expected] of [['connect', true], ['error', false], ['timeout', false]]) {
    const sock = fakeSocket();
    const p = tcpProbe('h', 1, 321, () => sock);
    assert.equal(sock.timeoutMs, 321, 'the timeout given is the timeout used');
    if (event === 'timeout') sock.onTimeout(); else sock.emit(event);
    const answer = await Promise.race([p, new Promise((r) => setTimeout(() => r('never settled'), 500))]);
    assert.equal(answer, expected, event);
    assert.equal(sock.destroyed, 1, event);
  }
});

test('tcpProbe settles once: a connect followed by a late timeout or error changes nothing and does not destroy twice', async () => {
  const sock = fakeSocket();
  const p = tcpProbe('h', 1, 100, () => sock);
  sock.emit('connect');
  sock.onTimeout();
  assert.equal(await p, true);
  assert.equal(sock.destroyed, 1);
});

test('tcpProbe passes host and port to connect and defaults to a 1500 ms timeout', async () => {
  const sock = fakeSocket();
  let args = null;
  const p = tcpProbe('192.168.40.83', 7472, undefined, (a) => { args = a; return sock; });
  assert.deepEqual(args, { host: '192.168.40.83', port: 7472 });
  assert.equal(sock.timeoutMs, 1500);
  sock.emit('connect');
  await p;
});

test('chooseAddress hands its timeoutMs and connect to the default probe', async () => {
  const sock = fakeSocket();
  const p = chooseAddress({ lan: 'h', tailnet: '', port: 9, timeoutMs: 777, connect: () => sock });
  await new Promise((r) => setImmediate(r));
  assert.equal(sock.timeoutMs, 777);
  sock.onTimeout();
  assert.deepEqual(await p, { address: null, via: null });
});
