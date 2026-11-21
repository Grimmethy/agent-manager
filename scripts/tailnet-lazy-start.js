'use strict';

// Lazy-start helpers for the tailnet gateway: find a lazy plugin by its port, ask the dashboard to start it, and wait for its port to accept connections.
// Uses only node:http and node:net. Contains no gateway-specific code.

const http = require('node:http');
const net = require('node:net');

const LOOPBACK = '127.0.0.1';
const inFlight = new Map();   // plugin name -> pending start promise, so concurrent requests share one POST

function pluginList(registry) {
  if (Array.isArray(registry)) return registry;
  return registry && Array.isArray(registry.plugins) ? registry.plugins : [];
}

/** The plugins.json entry that has a `process` block and a url on `port`, or null. */
function findLazyPlugin(port, registry) {
  const want = Number(port);
  for (const p of pluginList(registry)) {
    if (!p || !p.process || typeof p.url !== 'string') continue;
    const m = /^https?:\/\/[^/:]+:(\d{1,5})(?:\/|$)/.exec(p.url);
    if (m && Number(m[1]) === want) return p;
  }
  return null;
}

/**
 * POST /api/plugins/<name>/ensure-started on the dashboard (loopback, AGENT_MANAGER_DASHBOARD_PORT).
 * Concurrent calls for the same name share one in-flight request. Times out after opts.timeoutMs (default 3000).
 */
function requestPluginStart(name, opts = {}) {
  if (inFlight.has(name)) return inFlight.get(name);
  const timeoutMs = opts.timeoutMs || 3000;
  const port = Number(process.env.AGENT_MANAGER_DASHBOARD_PORT) || 7420;
  const promise = new Promise((resolve, reject) => {
    const req = http.request({
      host: LOOPBACK,
      port,
      method: 'POST',
      path: '/api/plugins/' + encodeURIComponent(name) + '/ensure-started',
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('error', reject);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch (e) { parsed = null; }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed || {});
        else reject(new Error('ensure-started ' + name + ' returned HTTP ' + res.statusCode));
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('ensure-started ' + name + ' timed out after ' + timeoutMs + ' ms')));
    req.on('error', reject);
    req.end();
  });
  inFlight.set(name, promise);
  promise.finally(() => inFlight.delete(name)).catch(() => {});
  return promise;
}

/** One connect attempt to 127.0.0.1:port. Resolves true on connect, false otherwise. */
function connectOnce(port) {
  return new Promise(resolve => {
    const sock = net.connect({host: LOOPBACK, port});
    sock.setTimeout(1000, () => { sock.destroy(); resolve(false); });
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => { sock.destroy(); resolve(false); });
  });
}

/** Bounded retry: resolves true once the upstream accepts a connection, false after opts.attempts tries spaced opts.delayMs apart. */
async function waitForUpstream(port, opts = {attempts: 60, delayMs: 250}) {
  const attempts = opts.attempts ?? 60;
  const delayMs = opts.delayMs ?? 250;
  for (let i = 0; i < attempts; i++) {
    if (await connectOnce(port)) return true;
    if (i < attempts - 1) await new Promise(r => setTimeout(r, delayMs));
  }
  return false;
}

module.exports = {findLazyPlugin, requestPluginStart, waitForUpstream};
