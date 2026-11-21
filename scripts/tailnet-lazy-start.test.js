'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const {findLazyPlugin, requestPluginStart, waitForUpstream} = require('./tailnet-lazy-start.js');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise(resolve => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(() => resolve());
  });
}

test('findLazyPlugin returns null for non-lazy and unknown ports, and the entry for a lazy port', () => {
  const registry = {plugins: [
    {name: 'lazy-one', url: 'http://127.0.0.1:7501/', process: {command: 'node', args: []}},
    {name: 'plain-one', url: 'http://127.0.0.1:7502/'},
  ]};
  assert.equal(findLazyPlugin(7502, registry), null);
  assert.equal(findLazyPlugin(9999, registry), null);
  assert.equal(findLazyPlugin(7501, registry).name, 'lazy-one');
});

test('requestPluginStart shares one HTTP request across concurrent calls for one plugin', async () => {
  let hits = 0;
  const srv = http.createServer((req, res) => {
    hits++;
    setTimeout(() => {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end('{"ok":true}');
    }, 50);
  });
  const port = await listen(srv);
  const saved = process.env.AGENT_MANAGER_DASHBOARD_PORT;
  process.env.AGENT_MANAGER_DASHBOARD_PORT = String(port);
  try {
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => requestPluginStart('dedupe-plugin')));
    assert.equal(hits, 1);
    for (const r of results) assert.deepEqual(r, {ok: true});
  } finally {
    if (saved === undefined) delete process.env.AGENT_MANAGER_DASHBOARD_PORT;
    else process.env.AGENT_MANAGER_DASHBOARD_PORT = saved;
    await closeServer(srv);
  }
});

test('requestPluginStart rejects after the 3 s timeout when the dashboard never answers', async () => {
  const sockets = new Set();
  const srv = net.createServer(sock => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
  });
  const port = await listen(srv);
  const saved = process.env.AGENT_MANAGER_DASHBOARD_PORT;
  process.env.AGENT_MANAGER_DASHBOARD_PORT = String(port);
  try {
    const started = Date.now();
    await assert.rejects(requestPluginStart('stalled-plugin'), /timed out after 3000 ms/);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 2900 && elapsed < 4500, 'elapsed ' + elapsed + ' ms');
  } finally {
    if (saved === undefined) delete process.env.AGENT_MANAGER_DASHBOARD_PORT;
    else process.env.AGENT_MANAGER_DASHBOARD_PORT = saved;
    for (const s of sockets) s.destroy();
    await new Promise(resolve => srv.close(() => resolve()));
  }
}, {timeout: 10000});

test('waitForUpstream returns false after the attempt limit on a port that never listens', async () => {
  const probe = net.createServer();
  const port = await listen(probe);
  await new Promise(resolve => probe.close(() => resolve()));
  const result = await waitForUpstream(port, {attempts: 3, delayMs: 10});
  assert.equal(result, false);
});
