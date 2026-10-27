#!/usr/bin/env node
'use strict';

// Tailnet gateway: owner-only TCP forwarding from this machine's Tailscale address to the loopback-only dashboard and plugin servers.
//
// WHY: the dashboard (and every plugin) trusts LOOPBACK as "the owner" (python/dashboard/app.py lan_mutation_gate), and `tailscale serve`
// proxies from loopback, so everything behind it is open to any device the tailnet's rules let in (verified 2026-10-14: a token-less POST
// through the ts.net name succeeded). This gateway binds ONLY to the Tailscale address, asks tailscaled who each caller is (`tailscale
// whois`), and forwards only callers owned by AGENT_MANAGER_TAILNET_OWNERS. Everyone else is closed before a byte reaches Agent Manager.
// Plain TCP, so any plugin works unchanged (no path rewriting): the phone opens http://<tailnet ip>:7420 and each plugin tab loads
// http://<same host>:<plugin port>, which this gateway forwards port for port. Traffic rides the Tailscale tunnel (encrypted).
//
// Fails closed everywhere: no owners configured, a non-Tailscale bind address, or a whois error all mean "refuse", never "open".
//
// Env: AGENT_MANAGER_TAILNET_OWNERS (required, comma separated Tailscale login names), AGENT_MANAGER_DASHBOARD_PORT (default 7420),
// AGENT_MANAGER_PLUGINS_PATH (default <repo>/plugins.json), AGENT_MANAGER_TAILNET_EXTRA_PORTS, AGENT_MANAGER_TAILNET_BIND (override the
// address, must still be a Tailscale one). See docs/agents/tailnet-gateway.md.

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const {execFile} = require('node:child_process');

const REPO = path.resolve(__dirname, '..');

// ---- who is calling ---------------------------------------------------------------------------------------------------------------

/** The owner login and node name out of `tailscale whois --json <ip>`. Throws when the reply has no user (a tagged device has none). */
function parseWhois(j) {
  if (!j || typeof j !== 'object') throw new Error('whois reply was not an object');
  const login = j.UserProfile && j.UserProfile.LoginName;
  if (!login) throw new Error('whois reply has no user profile (a tagged or unknown device)');
  return {login: String(login).toLowerCase(), node: (j.Node && j.Node.Name) || ''};
}

/** whois(ip) -> {login, node} by running the tailscale CLI. */
function createWhois({bin = 'tailscale', exec = execFile, timeoutMs = 4000} = {}) {
  return ip => new Promise((resolve, reject) => {
    exec(bin, ['whois', '--json', ip], {timeout: timeoutMs}, (err, stdout) => {
      if (err) return reject(new Error('tailscale whois ' + ip + ' failed: ' + (err.message || err)));
      try { resolve(parseWhois(JSON.parse(String(stdout)))); } catch (e) { reject(e); }
    });
  });
}

/**
 * authorize(ip) -> {allowed, login, node, reason}. An answer is cached per address (allow for allowTtlMs, a refusal for the shorter
 * denyTtlMs, a whois error for 5 s) so a page load that opens a dozen connections costs one lookup. A whois error is a refusal.
 */
function makeAuthorizer({owners, whois, allowTtlMs = 60000, denyTtlMs = 10000, errorTtlMs = 5000, now = Date.now}) {
  const allowed = new Set((owners || []).map(o => String(o).trim().toLowerCase()).filter(Boolean));
  if (!allowed.size) throw new Error('no owners configured: refusing to build an authorizer that would let everyone in');
  const cache = new Map();
  return async function authorize(ip) {
    const hit = cache.get(ip);
    if (hit && hit.until > now()) return hit.result;
    let result, ttl;
    try {
      const who = await whois(ip);
      const login = String(who.login || '').toLowerCase();
      const ok = allowed.has(login);
      result = {allowed: ok, login, node: who.node || '', reason: ok ? 'owner' : 'not an owner: ' + (login || 'unknown login')};
      ttl = ok ? allowTtlMs : denyTtlMs;
    } catch (e) {
      result = {allowed: false, login: '', node: '', reason: 'whois failed: ' + (e && e.message || e)};
      ttl = errorTtlMs;
    }
    cache.set(ip, {result, until: now() + ttl});
    return result;
  };
}

// ---- where it listens -------------------------------------------------------------------------------------------------------------

/** Throws unless `ip` is a Tailscale address (100.64.0.0/10 or fd7a:115c:a1e0::/48). The gateway must never listen anywhere else. */
function assertTailnetAddress(ip) {
  const s = String(ip == null ? '' : ip).trim().toLowerCase();
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    if ([a, b, c, d].every(n => n <= 255) && a === 100 && b >= 64 && b <= 127) return s;
  } else if (/^fd7a:115c:a1e0:/.test(s) || s === 'fd7a:115c:a1e0::') {
    return s;
  }
  throw new Error('refusing to bind ' + JSON.stringify(ip) + ': not a Tailscale (tailnet) address');
}

/** The sorted unique ports the gateway should open: the dashboard, every plugins.json url port, and any extras. */
function portsFromPluginsJson(file, {dashboardPort = 7420, extraPorts = []} = {}) {
  const ports = new Set([dashboardPort, ...extraPorts].map(Number).filter(validPort));
  let list = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.plugins) ? parsed.plugins : []);
  } catch (e) {
    if (e.code !== 'ENOENT') process.stderr.write('[tailnet-gateway] could not read ' + file + ': ' + e.message + '\n');   // missing = no plugins yet
  }
  for (const p of list) {
    const m = p && typeof p.url === 'string' && /^https?:\/\/[^/:]+:(\d{1,5})(?:\/|$)/.exec(p.url);
    if (m && validPort(Number(m[1]))) ports.add(Number(m[1]));
  }
  return [...ports].sort((x, y) => x - y);
}

function validPort(n) { return Number.isInteger(n) && n >= 1 && n <= 65535; }

// ---- the forwarding ---------------------------------------------------------------------------------------------------------------

/**
 * createGateway({bind, ports, target, authorize, log}): listen on bind:port for each port and, for an authorized caller, pipe the
 * connection to target:port (same port number). listen()/addPorts() resolve {listening, skipped:[{port, error}]}: a port that cannot
 * be opened (for example a plugin that already binds 0.0.0.0 on it) is skipped with the reason, never fatal.
 */
function createGateway({bind, ports, target = '127.0.0.1', authorize, log = () => {}, connectTimeoutMs = 5000}) {
  const servers = new Map();
  const stats = {accepted: 0, denied: 0};

  function onConnection(port) {
    return client => {
      client.pause();    // nothing is read until the caller is vetted, then pipe() resumes it: early bytes are kept, not dropped
      client.on('error', () => client.destroy());
      const peer = String(client.remoteAddress || '').replace(/^::ffff:/, '');
      authorize(peer).then(who => {
        if (!who.allowed) {
          stats.denied++;
          log('deny ' + peer + ' -> :' + port + ' (' + who.reason + ')');
          client.destroy();
          return;
        }
        const up = net.connect({host: target, port});
        up.setTimeout(connectTimeoutMs, () => { if (up.connecting) up.destroy(); });
        up.once('connect', () => {
          up.setTimeout(0);
          stats.accepted++;
          client.pipe(up);
          up.pipe(client);
        });
        up.on('error', () => { client.destroy(); up.destroy(); });
        client.on('close', () => up.destroy());
        up.on('close', () => client.destroy());
      }).catch(e => { log('deny ' + peer + ' -> :' + port + ' (authorizer error: ' + (e && e.message || e) + ')'); client.destroy(); });
    };
  }

  function open(port) {
    return new Promise(resolve => {
      const srv = net.createServer(onConnection(port));
      srv.once('error', e => resolve({port, error: (e.code || '') + ' ' + e.message}));
      srv.listen(port, bind, () => { srv.removeAllListeners('error'); srv.on('error', e => log('listener :' + port + ' error: ' + e.message)); servers.set(port, srv); resolve({port}); });
    });
  }

  async function addPorts(list) {
    const res = {listening: [], skipped: []};
    for (const p of list) {
      if (servers.has(p)) continue;
      const r = await open(p);
      if (r.error) res.skipped.push(r); else res.listening.push(p);
    }
    return res;
  }

  async function close() {
    await Promise.all([...servers.values()].map(s => new Promise(r => s.close(r))));
    servers.clear();
  }

  return {listen: () => addPorts(ports), addPorts, close, stats, ports: () => [...servers.keys()].sort((a, b) => a - b)};
}

// ---- running it -------------------------------------------------------------------------------------------------------------------

function tailnetIpv4(exec = execFile) {
  return new Promise((resolve, reject) => exec('tailscale', ['ip', '-4'], {timeout: 4000}, (err, out) => {
    if (err) return reject(new Error('tailscale ip -4 failed: ' + err.message));
    const ip = String(out).split('\n')[0].trim();
    ip ? resolve(ip) : reject(new Error('tailscale ip -4 printed no address'));
  }));
}

async function main(env = process.env) {
  const log = line => process.stdout.write(new Date().toISOString() + ' ' + line + '\n');
  const owners = String(env.AGENT_MANAGER_TAILNET_OWNERS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!owners.length) throw new Error('AGENT_MANAGER_TAILNET_OWNERS is required (comma separated Tailscale login names), refusing to start');
  const bind = assertTailnetAddress(env.AGENT_MANAGER_TAILNET_BIND || await tailnetIpv4());
  const pluginsPath = env.AGENT_MANAGER_PLUGINS_PATH || path.join(REPO, 'plugins.json');
  const portOpts = {dashboardPort: Number(env.AGENT_MANAGER_DASHBOARD_PORT) || 7420,
    extraPorts: String(env.AGENT_MANAGER_TAILNET_EXTRA_PORTS || '').split(',').map(s => Number(s.trim())).filter(Boolean)};
  const gateway = createGateway({bind, ports: portsFromPluginsJson(pluginsPath, portOpts), authorize: makeAuthorizer({owners, whois: createWhois()}), log});
  const res = await gateway.listen();
  log('listening on ' + bind + ' for ' + owners.join(', ') + ': ' + res.listening.join(' '));
  for (const s of res.skipped) log('SKIPPED :' + s.port + ' (' + s.error + ')');
  const rescan = setInterval(() => {    // a plugin added to plugins.json gets its port opened without a restart
    gateway.addPorts(portsFromPluginsJson(pluginsPath, portOpts)).then(r => {
      if (r.listening.length) log('now also listening on ' + r.listening.join(' '));
    }).catch(e => log('rescan error: ' + e.message));
  }, 60000);
  const stop = () => { clearInterval(rescan); gateway.close().then(() => process.exit(0)); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return gateway;
}

module.exports = {parseWhois, createWhois, makeAuthorizer, assertTailnetAddress, portsFromPluginsJson, createGateway, tailnetIpv4, main};

if (require.main === module) {
  main().catch(e => { process.stderr.write('[tailnet-gateway] ' + e.message + '\n'); process.exit(1); });
}
