'use strict';

// Node intake for the node registry (src/node-registry.js): the small HTTP endpoints other machines call, kept separate from the dashboard on purpose.
//
// Why not a dashboard route: the dashboard binds loopback by default and, when it is opened to the LAN, protects EVERY write endpoint with one shared secret
// (lan_mutation_gate in python/dashboard/app.py). A node client holding that secret could merge branches. Here a node holds only its own token, and the
// server accepts nothing but these node routes.
//
//   POST /heartbeat    Authorization: Bearer <that node's token>, JSON {id, address?, state, load, freeRamGb, paused, at}
//                      -> 200 {ok: true, globalPause: bool, serverTime: ISO}
//   POST /claim        JSON {id, classes?} -> 200 {ok: true, task, lease, repo} | 200 {ok: true, task: null, retryAfterSec: 60}
//                      (a paused node always gets the retryAfterSec answer)
//   POST /event        JSON {id, taskId, event} -> 200 {ok: true}; 400 on an event outside drafted/reviewed/applied/merged/blocked/failed;
//                      503 {ok: false, error: 'events unavailable'} when no recordEvent is injected
//   POST /release      JSON {id, taskId} -> 200 {ok: true}; 409 unless the lease on taskId belongs to this node
//   400 bad or oversized body or an unusable field, 401 missing or wrong token (the same answer for an unknown node, so ids cannot be probed),
//   403 the request does not come from the address the node was registered with, 404 any other path, 405 any other method on a node route.
//
// globalPause is true while a global pause marker (src/worker-switch.js _pause-global) is active on this machine and was not itself set from wok's heartbeat
// reply, so a node that applied the pause cannot echo it back. Every heartbeat is followed by sweepStale(), so one node's heartbeat checks all the others.
//
// Settings: AGENT_MANAGER_NODES_BIND (default 127.0.0.1; set it to the LAN address to accept other machines), AGENT_MANAGER_NODES_PORT (default 7471).
// Run: node src/node-registry-server.js

const http = require('http');
const { verifyToken, recordHeartbeat, loadNodes, sweepStale } = require('./node-registry.js');
const { readPause } = require('./worker-switch.js');
const { claimNext } = require('./node-claim.js');
const { leaseFor, returnLease, settleExpired } = require('./lease-ledger.js');
const { makeAskNode } = require('./node-status-client.js');

const MAX_BODY_BYTES = 8 * 1024;
const RETRY_AFTER_SEC = 60;
const EVENTS = ['drafted', 'reviewed', 'applied', 'merged', 'blocked', 'failed'];

function normalizeIp(ip) {
  return String(ip || '').replace(/^::ffff:/, '');
}

function bearer(header) {
  const m = /^Bearer (\S+)$/.exec(String(header || ''));
  return m ? m[1] : '';
}

function send(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...extraHeaders });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (c) => {
      if (tooLarge) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) { tooLarge = true; reject(Object.assign(new Error('body too large'), { status: 400 })); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// AGENT_MANAGER_NODE_PIPELINE_DIRS is a comma-separated list of pipeline directories; blanks and empty entries are dropped.
function parsePipelineDirs(value) {
  return String(value || '').split(',').map((d) => d.trim()).filter((d) => d.length > 0);
}

function createServer({
  env = process.env,
  now = () => Date.now(),
  sweep = sweepStale,
  claimNext: claim = claimNext,
  recordEvent,
  returnLease: release = returnLease,
  leaseFor: lookupLease = leaseFor,
  pipelineDirs = [],
  settleAskNode: settleAskNodeOpt,
} = {}) {
  const settleAskNode = settleAskNodeOpt ?? makeAskNode({env});
  const handleHeartbeat = async (res, payload) => {
    try {
      recordHeartbeat(payload, env, now());
    } catch (e) {
      return send(res, 400, { ok: false, error: e.message });
    }
    try {
      await sweep(env, now());
    } catch (e) { /* the alert is best effort: a failed sweep must not fail the heartbeat */ }
    const pause = readPause('global', env, now());
    return send(res, 200, { ok: true, globalPause: pause !== null && pause.source !== 'wok', serverTime: new Date(now()).toISOString() });
  };

  const handleClaim = async (res, payload, registered) => {
    const idle = () => send(res, 200, { ok: true, task: null, retryAfterSec: RETRY_AFTER_SEC });
    if (registered && registered.paused) return idle();
    try {
      await settleExpired({ askNode: settleAskNode, pipelineDirs, now: now(), env });
    } catch (e) { /* settle is best effort: a failed settlement must not fail the claim */ }
    const result = claim({ nodeId: payload.id, claimant: payload.id, classes: payload.classes, pipelineDirs, env, now: now() });
    if (!result || !result.task) return idle();
    return send(res, 200, { ok: true, task: result.task, lease: result.lease, repo: result.repo });
  };

  const handleEvent = async (res, payload) => {
    if (!EVENTS.includes(payload.event)) return send(res, 400, { ok: false, error: `event must be one of ${EVENTS.join(', ')}` });
    if (typeof payload.taskId !== 'string' || !payload.taskId) return send(res, 400, { ok: false, error: 'taskId required' });
    if (typeof recordEvent !== 'function') return send(res, 503, { ok: false, error: 'events unavailable' });
    await recordEvent({ id: payload.id, taskId: payload.taskId, event: payload.event });
    return send(res, 200, { ok: true });
  };

  const handleRelease = async (res, payload) => {
    if (typeof payload.taskId !== 'string' || !payload.taskId) return send(res, 400, { ok: false, error: 'taskId required' });
    const lease = lookupLease(payload.taskId, env);
    if (!lease || lease.nodeId !== payload.id) return send(res, 409, { ok: false, error: 'lease is not held by this node' });
    const returned = release(payload.taskId, { env });
    if (!returned) return send(res, 409, { ok: false, error: 'no lent lease for this task' });
    return send(res, 200, { ok: true });
  };

  const routes = {
    '/heartbeat': handleHeartbeat,
    '/claim': handleClaim,
    '/event': handleEvent,
    '/release': handleRelease,
  };

  return http.createServer(async (req, res) => {
    try {
      const url = String(req.url || '').split('?')[0];
      const route = Object.prototype.hasOwnProperty.call(routes, url) ? routes[url] : null;
      if (!route) return send(res, 404, { ok: false, error: 'not found' });
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' });

      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch (e) {
        // Answer first, then drop the connection, so an oversized upload gets its 400 and is not read to the end.
        if (e.status) res.once('finish', () => req.destroy());
        return send(res, 400, { ok: false, error: e.status ? e.message : 'body must be JSON' }, e.status ? { Connection: 'close' } : {});
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return send(res, 400, { ok: false, error: 'body must be a JSON object' });

      if (!verifyToken(payload.id, bearer(req.headers.authorization), env)) return send(res, 401, { ok: false, error: 'bad or missing token' });
      const registered = loadNodes(env)[payload.id];
      if (registered && registered.address && normalizeIp(req.socket.remoteAddress) !== registered.address) {
        return send(res, 403, { ok: false, error: 'request does not come from the registered address' });
      }

      return await route(res, payload, registered);
    } catch (e) {
      return send(res, 500, { ok: false, error: 'internal error' });
    }
  });
}

if (require.main === module) {
  const host = String(process.env.AGENT_MANAGER_NODES_BIND || '').trim() || '127.0.0.1';
  const port = Number(process.env.AGENT_MANAGER_NODES_PORT) || 7471;
  // The standalone service records node events on the lease ledger and claims from the pipelines named in AGENT_MANAGER_NODE_PIPELINE_DIRS.
  createServer({
    recordEvent: (e) => require('./lease-ledger.js').recordEvent(e.taskId, e.event),
    pipelineDirs: parsePipelineDirs(process.env.AGENT_MANAGER_NODE_PIPELINE_DIRS),
  }).listen(port, host, () => process.stdout.write(`node registry intake listening on ${host}:${port}\n`));
}

module.exports = { createServer, normalizeIp, bearer, parsePipelineDirs };
