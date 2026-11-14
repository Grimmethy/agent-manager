'use strict';

// Package intake (multi-node plan, piece 4e): the endpoint on wok where a node posts the review package of a task it finished (src/review-package.js).
// Separate from the dashboard on purpose, like src/node-registry-server.js: a node holds only its own token, and this endpoint can only store a package.
//
//   POST /package   Authorization: Bearer <that node's token>, JSON = a review package (version 1, taskId, nodeId, branch, sha, record, builtAt)
//                   -> 200 {ok: true, taskId}
//                   A version 2 package (the drafted record, no branch) also REPLACES the leased original in queue/pending or queue/adhoc: the node's record
//                   (leasedTo removed, fromNode set, status needs-review) is written to queue/review/ under the original file name and the original is deleted.
//   400 bad or oversized (over 4 MB) body, a package that validatePackage refuses, or a task id that is not /^[A-Za-z0-9._-]{1,200}$/;
//   401 missing or wrong token (the node id comes from the package; unknown and wrong give the same answer);
//   403 the request does not come from the address the node was registered with; 404 any other path; 405 any other method on /package;
//   409 the task has no lease, or its lease belongs to another node, or (version 2) there is no original record to replace (nothing is stored then).
//
// The package is written atomically to <AGENT_MANAGER_PIPELINE_DIR>/queue/node-packages/<taskId>.json (a resend replaces it), the lease is ended with
// returnLease() (src/lease-ledger.js) and one summary-level notification (src/notify.js, key node-package:<taskId>) is sent; the notice is best effort.
// Settings: AGENT_MANAGER_PIPELINE_DIR, AGENT_MANAGER_PACKAGE_BIND (default 127.0.0.1), AGENT_MANAGER_PACKAGE_PORT (default 7473),
// AGENT_MANAGER_NODES_DIR (the registry, as in docs/agents/nodes.md). Run: node src/package-intake-server.js

const fs = require('fs');
const path = require('path');
const http = require('http');
const { verifyToken, loadNodes } = require('./node-registry.js');
const { validatePackage, RECORD_PACKAGE_VERSION } = require('./review-package.js');
const { findRecordFile } = require('./lend-task.js');
const { leaseFor, returnLease } = require('./lease-ledger.js');
const { writeJsonAtomicSync } = require('./atomic-write.js');
const { notify } = require('./notify.js');
const { normalizeIp, bearer, TASK_ID_RE } = require('./node-intake-server.js');

const MAX_BODY_BYTES = 4 * 1024 * 1024;

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

// Why a package is refused before auth-independent storage, or '' when it is fine (shape and a task id that is safe as a file name).
function refusal(pkg) {
  const v = validatePackage(pkg);
  if (!v.ok) return v.reason;
  if (!TASK_ID_RE.test(pkg.taskId)) return 'task id is not valid';
  return '';
}

function storePackage(pipelineDir, pkg) {
  const dir = path.join(pipelineDir, 'queue', 'node-packages');
  fs.mkdirSync(dir, { recursive: true });
  writeJsonAtomicSync(path.join(dir, `${pkg.taskId}.json`), pkg);
}

// The leased original on wok (queue/pending or queue/adhoc, the file named after the task id), or null when it is missing or is not that task's record.
function findOriginal(pipelineDir, taskId) {
  const file = findRecordFile(pipelineDir, taskId);
  if (!file) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).id === taskId ? file : null;
  } catch (e) {
    return null;
  }
}

// Files the node's drafted record in wok's queue/review/ under the original's file name, then removes the original (write first, so a crash never loses the task).
function replaceWithDraft(pipelineDir, originalFile, pkg, atMs) {
  const draft = { ...pkg.record, fromNode: pkg.nodeId, status: 'needs-review' };
  delete draft.leasedTo;
  draft.history = [...(Array.isArray(draft.history) ? draft.history : []), { stage: 'node-draft-received', at: new Date(atMs).toISOString(), detail: `drafted on ${pkg.nodeId}` }];
  const dir = path.join(pipelineDir, 'queue', 'review');
  fs.mkdirSync(dir, { recursive: true });
  writeJsonAtomicSync(path.join(dir, path.basename(originalFile)), draft);
  fs.unlinkSync(originalFile);
}

function createServer({ env = process.env, now = () => Date.now(), send: sendNotice = notify } = {}) {
  const pipelineDir = String(env.AGENT_MANAGER_PIPELINE_DIR || '').trim();
  if (!pipelineDir) throw new Error('AGENT_MANAGER_PIPELINE_DIR must be set');
  return http.createServer(async (req, res) => {
    try {
      const url = String(req.url || '').split('?')[0];
      if (url !== '/package') return send(res, 404, { ok: false, error: 'not found' });
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' });
      let pkg;
      try {
        pkg = JSON.parse(await readBody(req));
      } catch (e) {
        if (e.status) res.once('finish', () => req.destroy());
        return send(res, 400, { ok: false, error: e.status ? e.message : 'body must be JSON' }, e.status ? { Connection: 'close' } : {});
      }
      const nodeId = pkg && typeof pkg === 'object' ? pkg.nodeId : undefined;
      if (!verifyToken(nodeId, bearer(req.headers.authorization), env)) return send(res, 401, { ok: false, error: 'bad or missing token' });
      const registered = loadNodes(env)[nodeId];
      if (registered && registered.address && normalizeIp(req.socket.remoteAddress) !== registered.address) {
        return send(res, 403, { ok: false, error: 'request does not come from the registered address' });
      }
      const why = refusal(pkg);
      if (why) return send(res, 400, { ok: false, error: why });
      const lease = leaseFor(pkg.taskId, env);
      if (!lease || lease.nodeId !== nodeId) return send(res, 409, { ok: false, error: 'no lease for this task on this node' });

      const original = pkg.version === RECORD_PACKAGE_VERSION ? findOriginal(pipelineDir, pkg.taskId) : null;
      if (pkg.version === RECORD_PACKAGE_VERSION && !original) return send(res, 409, { ok: false, error: 'no original record for this task' });
      storePackage(pipelineDir, pkg);
      if (original) replaceWithDraft(pipelineDir, original, pkg, now());
      returnLease(pkg.taskId, { now: now(), env });
      try {
        await sendNotice({ level: 'summary', key: `node-package:${pkg.taskId}`, title: `Node ${nodeId}: review package arrived`, text: pkg.branch ? `Task ${pkg.taskId} came back from ${nodeId} on ${pkg.branch}.` : `Task ${pkg.taskId} was drafted on ${nodeId} and is waiting in review.` }, { env, now });
      } catch (e) { /* the notice is best effort */ }
      return send(res, 200, { ok: true, taskId: pkg.taskId });
    } catch (e) {
      return send(res, 500, { ok: false, error: 'internal error' });
    }
  });
}

if (require.main === module) {
  const host = String(process.env.AGENT_MANAGER_PACKAGE_BIND || '').trim() || '127.0.0.1';
  const port = Number(process.env.AGENT_MANAGER_PACKAGE_PORT) || 7473;
  let server;
  try {
    server = createServer();
  } catch (e) {
    process.stderr.write(`package intake: ${e.message}\n`);
    process.exit(2);
  }
  server.listen(port, host, () => process.stdout.write(`package intake listening on ${host}:${port}\n`));
}

module.exports = { createServer, refusal, storePackage, findOriginal, replaceWithDraft, MAX_BODY_BYTES };
