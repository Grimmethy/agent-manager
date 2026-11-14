'use strict';

// Node heartbeat client: run on every machine (grimm, and wok itself) to tell wok's node registry the machine is alive, and to pick up a global pause from wok
// (multi-node plan, piece 2d). One run = build the payload, POST it to the registry intake (src/node-registry-server.js), apply the reply, print one JSON line.
//
// Settings (environment):
//   AGENT_MANAGER_NODE_ID          this machine's registered id (required)
//   AGENT_MANAGER_NODE_URL         the intake URL, e.g. http://192.168.40.11:7471/heartbeat (required). It is the registry INTAKE, not the dashboard: the dashboard's
//                                  LAN gate would need the shared secret that unlocks every write endpoint, the intake needs only this node's own token.
//   AGENT_MANAGER_NODE_TOKEN_FILE  a file holding this node's token (required). The token is never read from the environment, never logged and never in a repo.
//   AGENT_MANAGER_NODE_ADDRESS     optional, the address to report (the intake also checks the address the request really came from)
//   AGENT_MANAGER_NODE_TIMEOUT_MS  POST timeout, default 5000
//
// Payload {id, address?, state: "up", load (1 minute load average), freeRamGb (MemAvailable from /proc/meminfo, else os.freemem), paused (the node pause marker is
// active), at}. State "off" is not sent from here: a machine that is off sends nothing and goes stale.
//
// The reply {ok, globalPause, serverTime} is applied to this machine's markers (src/worker-switch.js):
//   globalPause true   a global pause with source "wok" and a 3 minute expiry, refreshed by every heartbeat, so it ends by itself if wok stops answering. A global
//                      pause someone set here (any other source) is left exactly as it is.
//   globalPause false  the global pause is cleared ONLY when its source is "wok"; one set by anyone else stays.
// A POST that cannot be made, a non-2xx answer or a reply that is not JSON changes nothing and still exits 0: wok being unreachable must neither pause nor
// unpause this machine (the 3 minute expiry covers it). Missing settings are a usage error (exit 2) so a timer shows the unit as failed.

const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const { setPause, clearPause, readPause } = require('./worker-switch.js');

const GLOBAL_PAUSE_TTL_MIN = 3;

function config(env = process.env) {
  const timeout = Number(env.AGENT_MANAGER_NODE_TIMEOUT_MS);
  return {
    id: String(env.AGENT_MANAGER_NODE_ID || '').trim(),
    url: String(env.AGENT_MANAGER_NODE_URL || '').trim(),
    tokenFile: String(env.AGENT_MANAGER_NODE_TOKEN_FILE || '').trim(),
    address: String(env.AGENT_MANAGER_NODE_ADDRESS || '').trim(),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 5000,
  };
}

function readToken(file) {
  const token = fs.readFileSync(file, 'utf8').trim();
  if (!token) throw new Error('the token file is empty');
  return token;
}

// Available memory in GB: MemAvailable counts reclaimable cache, which os.freemem() does not (a busy Linux machine shows almost no "free" memory).
function freeRamGb(readMeminfo = () => fs.readFileSync('/proc/meminfo', 'utf8'), freemem = os.freemem) {
  let bytes = freemem();
  try {
    const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(readMeminfo());
    if (m) bytes = Number(m[1]) * 1024;
  } catch (e) { /* no /proc/meminfo: keep os.freemem */ }
  return Math.round((bytes / (1024 * 1024 * 1024)) * 100) / 100;
}

function buildPayload(cfg, env = process.env, now = Date.now(), deps = {}) {
  const payload = {
    id: cfg.id,
    state: 'up',
    load: Math.round((deps.loadavg || os.loadavg)()[0] * 100) / 100,
    freeRamGb: freeRamGb(deps.readMeminfo, deps.freemem),
    paused: readPause('node', env, now) !== null,
    at: new Date(now).toISOString(),
  };
  if (cfg.address) payload.address = cfg.address;
  return payload;
}

function defaultPost(url, token, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(url); } catch (e) { reject(new Error('invalid AGENT_MANAGER_NODE_URL')); return; }
    const lib = target.protocol === 'https:' ? https : http;
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Content-Length': Buffer.byteLength(body) };
    const req = lib.request(target, { method: 'POST', headers, timeout: timeoutMs }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

// Applies the reply's globalPause to this machine's markers. Returns "set", "cleared" or "none".
function applyReply(reply, env = process.env, now = Date.now()) {
  if (!reply || typeof reply.globalPause !== 'boolean') return 'none';
  const current = readPause('global', env, now);
  if (reply.globalPause) {
    if (current && current.source !== 'wok') return 'none';
    setPause('global', { reason: 'global pause from wok', source: 'wok', ttlMin: GLOBAL_PAUSE_TTL_MIN }, env, now);
    return 'set';
  }
  if (current && current.source === 'wok') {
    clearPause('global', env);
    return 'cleared';
  }
  return 'none';
}

async function runOnce({ env = process.env, now = () => Date.now(), post = defaultPost, deps = {} } = {}) {
  const cfg = config(env);
  const missing = [['AGENT_MANAGER_NODE_ID', cfg.id], ['AGENT_MANAGER_NODE_URL', cfg.url], ['AGENT_MANAGER_NODE_TOKEN_FILE', cfg.tokenFile]].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) return { usage: true, error: `missing settings: ${missing.join(', ')}` };
  let token;
  try {
    token = readToken(cfg.tokenFile);
  } catch (e) {
    return { usage: true, error: `cannot read the token file: ${e.code || e.message}` };
  }
  const at = now();
  let answer;
  try {
    answer = await post(cfg.url, token, JSON.stringify(buildPayload(cfg, env, at, deps)), cfg.timeoutMs);
  } catch (e) {
    return { sent: false, applied: 'none', reason: `could not reach wok: ${String((e && e.message) || e).slice(0, 120)}` };
  }
  if (answer.status < 200 || answer.status >= 300) return { sent: false, applied: 'none', status: answer.status, reason: `wok answered HTTP ${answer.status}` };
  let reply;
  try {
    reply = JSON.parse(answer.text);
  } catch (e) {
    return { sent: true, applied: 'none', status: answer.status, reason: 'the reply was not JSON' };
  }
  return { sent: true, applied: applyReply(reply, env, at), status: answer.status, globalPause: reply && typeof reply.globalPause === 'boolean' ? reply.globalPause : null };
}

async function main(env = process.env, out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(`${s}\n`)) {
  const result = await runOnce({ env });
  if (result.usage) {
    err(result.error);
    return 2;
  }
  out(JSON.stringify(result));
  return 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; });
}

module.exports = { config, readToken, freeRamGb, buildPayload, applyReply, runOnce, main, GLOBAL_PAUSE_TTL_MIN };
