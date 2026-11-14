'use strict';

// Node intake (multi-node plan, piece 4c): the small HTTP endpoint on a node (for example grimm) through which wok LENDS it a task. Kept apart from the
// dashboard on purpose, like src/node-registry-server.js: it holds one secret that can do one thing, put a task record in this machine's queue/adhoc/.
//
//   POST /lend   Authorization: Bearer <lender token>, JSON {task: <record>, lease: {taskId, nodeId, expiresAt}}   -> 200 {ok: true, taskId}
//   400 bad or oversized (over 1 MB) body, a task id that is not /^[A-Za-z0-9._-]{1,200}$/, or a lease that does not match the task,
//   401 missing or wrong token, 403 the request does not come from AGENT_MANAGER_LENDER_ADDRESS (when that is set), 404 any other path,
//   405 any other method on /lend, 409 a record with that id is already in queue/adhoc/ (it is never overwritten).
//
// The record is written, stamped with `leasedTo: <lease.nodeId>`, atomically into <AGENT_MANAGER_PIPELINE_DIR>/queue/adhoc/<id>.json.
// Settings: AGENT_MANAGER_LENDER_TOKEN_FILE (a file, mode 600, holding the lender token; never read from the environment; a missing or empty file means the
// server refuses to start, exit 2), AGENT_MANAGER_LENDER_ADDRESS (the one address allowed to lend; unset = any address that holds the token),
// AGENT_MANAGER_PIPELINE_DIR, AGENT_MANAGER_INTAKE_BIND (default 127.0.0.1), AGENT_MANAGER_INTAKE_PORT (default 7472).
// Run: node src/node-intake-server.js

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const MAX_BODY_BYTES = 1024 * 1024;
const TASK_ID_RE = /^[A-Za-z0-9._-]{1,200}$/;

function normalizeIp(ip) {
  return String(ip || '').replace(/^::ffff:/, '');
}

function bearer(header) {
  const m = /^Bearer (\S+)$/.exec(String(header || ''));
  return m ? m[1] : '';
}

function sameToken(given, expected) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
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

function readToken(env) {
  const file = String(env.AGENT_MANAGER_LENDER_TOKEN_FILE || '').trim();
  let token = '';
  try { token = file ? fs.readFileSync(file, 'utf8').trim() : ''; } catch (e) { token = ''; }
  if (!token) throw new Error('AGENT_MANAGER_LENDER_TOKEN_FILE must name a readable, non-empty token file');
  return token;
}

function isObject(v) {
  return Boolean(v) && typeof v === 'object';
}

// Writes the record into queue/adhoc/ without ever replacing a file that is there. Returns false when the id is already taken.
function writeAdhoc(pipelineDir, record) {
  const dir = path.join(pipelineDir, 'queue', 'adhoc');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${record.id}.json`);
  const tmp = path.join(dir, `.${record.id}.json.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
  try {
    fs.linkSync(tmp, target);
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  } finally {
    fs.unlinkSync(tmp);
  }
}

function createServer({ env = process.env } = {}) {
  const token = readToken(env);
  const pipelineDir = String(env.AGENT_MANAGER_PIPELINE_DIR || '').trim();
  if (!pipelineDir) throw new Error('AGENT_MANAGER_PIPELINE_DIR must be set');
  const lender = String(env.AGENT_MANAGER_LENDER_ADDRESS || '').trim();
  return http.createServer(async (req, res) => {
    try {
      const url = String(req.url || '').split('?')[0];
      if (url !== '/lend') return send(res, 404, { ok: false, error: 'not found' });
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' });
      if (!sameToken(bearer(req.headers.authorization), token)) return send(res, 401, { ok: false, error: 'bad or missing token' });
      if (lender && normalizeIp(req.socket.remoteAddress) !== lender) return send(res, 403, { ok: false, error: 'request does not come from the lender address' });

      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch (e) {
        if (e.status) res.once('finish', () => req.destroy());
        return send(res, 400, { ok: false, error: e.status ? e.message : 'body must be JSON' }, e.status ? { Connection: 'close' } : {});
      }
      const task = isObject(payload) ? payload.task : null;
      const lease = isObject(payload) ? payload.lease : null;
      if (!isObject(task) || !isObject(lease)) return send(res, 400, { ok: false, error: 'body needs a task object and a lease object' });
      if (typeof task.id !== 'string' || !TASK_ID_RE.test(task.id)) return send(res, 400, { ok: false, error: 'task id is not valid' });
      if (lease.taskId !== task.id || typeof lease.nodeId !== 'string' || !lease.nodeId.trim()) return send(res, 400, { ok: false, error: 'lease does not match the task' });

      if (!writeAdhoc(pipelineDir, { ...task, leasedTo: lease.nodeId.trim() })) return send(res, 409, { ok: false, error: 'a task with that id is already queued' });
      return send(res, 200, { ok: true, taskId: task.id });
    } catch (e) {
      return send(res, 500, { ok: false, error: 'internal error' });
    }
  });
}

if (require.main === module) {
  const host = String(process.env.AGENT_MANAGER_INTAKE_BIND || '').trim() || '127.0.0.1';
  const port = Number(process.env.AGENT_MANAGER_INTAKE_PORT) || 7472;
  let server;
  try {
    server = createServer();
  } catch (e) {
    process.stderr.write(`node intake: ${e.message}\n`);
    process.exit(2);
  }
  server.listen(port, host, () => process.stdout.write(`node intake listening on ${host}:${port}\n`));
}

module.exports = { createServer, normalizeIp, bearer, sameToken, writeAdhoc, TASK_ID_RE, MAX_BODY_BYTES };
