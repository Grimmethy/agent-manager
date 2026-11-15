'use strict';

// Node status client (FF-3 wiring): asks a node where a task is, over the node intake's POST /status (src/node-intake-server.js).
//   makeAskNode({env, post, readRegistry}) -> async askNode(nodeId, taskId) -> 'merged' | 'in-progress' | 'unknown'
// This is the askNode that settleExpired (src/lease-ledger.js) calls for an overdue lease. The address comes from the node registry
// (nodes.json), the bearer token from AGENT_MANAGER_LENDER_TOKEN_FILE (trimmed), the port from AGENT_MANAGER_INTAKE_PORT (default 7472).
// ANY problem (unknown node, no address, no token, a non-2xx answer, bad JSON, a timeout, a throw) answers 'unknown' and nothing here throws:
// 'unknown' makes settleExpired put the task back in the pool, which is the safe direction. No timers beyond the request timeout.

const fs = require('node:fs');
const http = require('node:http');
const { loadNodes } = require('./node-registry.js');

const DEFAULT_PORT = 7472;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_BODY_BYTES = 64 * 1024;
const ADDRESS_RE = /^[A-Za-z0-9._-]+$/;

// POST with a JSON body; resolves { status, body } (body is the response text, capped). Rejects on a network error or timeout.
function defaultPost(url, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request(target, { method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }, timeout: timeoutMs }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size <= MAX_BODY_BYTES) chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

function readToken(file) {
  try { return fs.readFileSync(String(file || ''), 'utf8').trim(); } catch (e) { return ''; }
}

function statusUrl(address, env) {
  const port = Number(env.AGENT_MANAGER_INTAKE_PORT) || DEFAULT_PORT;
  return 'http://' + address + ':' + port + '/status';
}

function makeAskNode({ env = process.env, post = defaultPost, readRegistry = (e) => loadNodes(e) } = {}) {
  return async function askNode(nodeId, taskId) {
    try {
      const node = readRegistry(env)[nodeId];
      const address = node && typeof node.address === 'string' ? node.address.trim() : '';
      if (!ADDRESS_RE.test(address)) return 'unknown';
      const token = readToken(env.AGENT_MANAGER_LENDER_TOKEN_FILE);
      if (!token) return 'unknown';
      const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
      const res = await post(statusUrl(address, env), headers, JSON.stringify({ taskIds: [taskId] }), REQUEST_TIMEOUT_MS);
      const status = Number(res && res.status) || 0;
      if (status < 200 || status >= 300) return 'unknown';
      const parsed = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
      const answer = parsed && parsed.ok === true && parsed.tasks ? parsed.tasks[taskId] : undefined;
      return answer === 'merged' || answer === 'in-progress' ? answer : 'unknown';
    } catch (e) {
      return 'unknown';
    }
  };
}

module.exports = { makeAskNode, defaultPost, statusUrl, DEFAULT_PORT, REQUEST_TIMEOUT_MS };
