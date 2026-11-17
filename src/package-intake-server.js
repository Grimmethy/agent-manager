'use strict';

// Package intake (multi-node plan, piece 4e): the endpoint on wok where a node posts the review package of a task it finished (src/review-package.js).
// Separate from the dashboard on purpose, like src/node-registry-server.js: a node holds only its own token, and this endpoint can only store a package.
//
//   POST /package   Authorization: Bearer <that node's token>, JSON = a review package (version 1, taskId, nodeId, branch, sha, record, builtAt)
//                   -> 200 {ok: true, taskId}
//                   A version 2 package (the drafted record, no branch) also REPLACES the leased original in queue/pending or queue/adhoc: the node's record
//                   (leasedTo removed, fromNode set, status needs-review) is written to queue/review/ under the original file name and the original is deleted.
//                   A version 2 STOP record (isStopRecord in src/review-package.js: the node stopped on an open question, no diff) goes to queue/needs-clarification/
//                   instead, without a needs-review status, with a node-stop-received history entry; the lease is returned and then marked with the event 'blocked'.
//   400 bad or oversized (over 4 MB) body, a package that validatePackage refuses, or a task id that is not /^[A-Za-z0-9._-]{1,200}$/;
//   401 missing or wrong token (the node id comes from the package; unknown and wrong give the same answer);
//   403 the request does not come from the address the node was registered with; 404 any other path; 405 any other method on /package;
//   409 the task has no lease, or its lease belongs to another node, or (version 2) there is no original record to replace (nothing is stored then).
//
//   GET /code/latest  Authorization: Bearer <that node's token>, X-Node-Id: <the node id> (a GET has no body to carry it)
//                   -> 200 the JSON array in latest.json of the code publish directory (AGENT_MANAGER_CODE_PUBLISH_DIR, default <pipeline dir>/code-publish);
//                   503 {error: 'nothing published'} when the file is missing, unparsable or not an array. Read-only, no timer: a node asks, wok never pushes.
//                   401 missing or wrong token or node id (unknown and wrong give the same answer); 403 wrong address (as for POST /package);
//                   405 any other method on /code/latest.
//
//   GET /code/<name>.bundle  the same two headers and the same 401 and 403 checks. Streams the bundle file named <name>.bundle from the code publish directory
//                   (Content-Type application/octet-stream, Content-Length from fs.stat) only when that exact name is the `bundle` of an entry in the current
//                   latest.json; 404 for any other name, a name outside letters, digits, dot, underscore and dash (1 to 200 characters, ending in .bundle),
//                   an unlisted or missing file, and any traversal; 405 for another method on such a name; 500 when the file cannot be read before the headers go out.
//                   Every other path is 404.
//
// The package is written atomically to <AGENT_MANAGER_PIPELINE_DIR>/queue/node-packages/<taskId>.json (a resend replaces it), the lease is ended with
// returnLease() (src/lease-ledger.js) and one summary-level notification (src/notify.js, key node-package:<taskId>) is sent; the notice is best effort.
// Settings: AGENT_MANAGER_PIPELINE_DIR, AGENT_MANAGER_PACKAGE_BIND (default 127.0.0.1), AGENT_MANAGER_PACKAGE_PORT (default 7473),
// AGENT_MANAGER_NODES_DIR (the registry, as in docs/agents/nodes.md). Run: node src/package-intake-server.js

const fs = require('fs');
const path = require('path');
const http = require('http');
const { verifyToken, loadNodes } = require('./node-registry.js');
const { validatePackage, RECORD_PACKAGE_VERSION, isStopRecord } = require('./review-package.js');
const { findRecordFile } = require('./lend-task.js');
const { leaseFor, returnLease, recordEvent } = require('./lease-ledger.js');
const { writeJsonAtomicSync } = require('./atomic-write.js');
const { notify } = require('./notify.js');
const { normalizeIp, bearer, TASK_ID_RE } = require('./node-intake-server.js');

const MAX_BODY_BYTES = 4 * 1024 * 1024;

const BUNDLE_NAME_RE = /^[A-Za-z0-9._-]{1,200}$/;

function publishDir(env, pipelineDir) {
  return String(env.AGENT_MANAGER_CODE_PUBLISH_DIR || '').trim() || path.join(pipelineDir, 'code-publish');
}

// The list published for the nodes: latest.json in the code publish directory, or null when there is none to serve.
function readPublished(env, pipelineDir) {
  const dir = publishDir(env, pipelineDir);
  try {
    const list = JSON.parse(fs.readFileSync(path.join(dir, 'latest.json'), 'utf8'));
    return Array.isArray(list) ? list : null;
  } catch (e) {
    return null;
  }
}

// Streams one listed bundle: a missing or non-regular file is a 404, a read error before the headers go out is a 500, one after them ends the connection.
function streamBundle(res, file) {
  let size;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return send(res, 404, { ok: false, error: 'not found' });
    size = stat.size;
  } catch (e) {
    return send(res, 404, { ok: false, error: 'not found' });
  }
  const stream = fs.createReadStream(file);
  stream.once('open', () => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': size });
    stream.pipe(res);
  });
  stream.once('error', () => {
    if (res.headersSent) return res.destroy();
    return send(res, 500, { ok: false, error: 'could not read the bundle' });
  });
  return undefined;
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
// extraDirs are the other pipelines the registry hands tasks out of (AGENT_MANAGER_NODE_PIPELINE_DIRS): the original may sit in any of them, the draft always lands in pipelineDir's queue/review.
function findOriginal(pipelineDir, taskId, extraDirs = []) {
  for (const dir of [pipelineDir, ...extraDirs]) {
    const file = findRecordFile(dir, taskId);
    if (!file) continue;
    try {
      if (JSON.parse(fs.readFileSync(file, 'utf8')).id === taskId) return file;
    } catch (e) { /* an unreadable record is not the original: try the next pipeline */ }
  }
  return null;
}

// AGENT_MANAGER_NODE_PIPELINE_DIRS: a comma separated list of pipeline directories (blanks and empty entries dropped).
function nodePipelineDirs(env) {
  return String(env.AGENT_MANAGER_NODE_PIPELINE_DIRS || '').split(',').map((d) => d.trim()).filter((d) => d.length > 0);
}

// Files the node's drafted record in wok's queue/review/ under the original's file name, then removes the original (write first, so a crash never loses the task).
// A STOP record (isStopRecord: the node stopped on an open question, no diff) is filed in queue/needs-clarification/ instead, keeps its needsClarification and
// adhocResolution, gets no needs-review status and a node-stop-received history entry naming the node and the reason.
function replaceWithDraft(pipelineDir, originalFile, pkg, atMs) {
  const stop = isStopRecord(pkg.record);
  const draft = stop ? { ...pkg.record, fromNode: pkg.nodeId } : { ...pkg.record, fromNode: pkg.nodeId, status: 'needs-review' };
  delete draft.leasedTo;
  const at = new Date(atMs).toISOString();
  const entry = stop
    ? { stage: 'node-stop-received', at, detail: `stopped on ${pkg.nodeId}: ${pkg.record.needsClarification.reason}` }
    : { stage: 'node-draft-received', at, detail: `drafted on ${pkg.nodeId}` };
  draft.history = [...(Array.isArray(draft.history) ? draft.history : []), entry];
  const dir = path.join(pipelineDir, 'queue', stop ? 'needs-clarification' : 'review');
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
      const codeMatch = /^\/code\/([^/]+)$/.exec(url);
      const bundleName = codeMatch ? codeMatch[1] : null;
      const isBundle = bundleName !== null && bundleName.endsWith('.bundle') && BUNDLE_NAME_RE.test(bundleName);
      if (url === '/code/latest' || isBundle) {
        if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'GET only' });
        const askId = String(req.headers['x-node-id'] || '').trim();
        if (!verifyToken(askId, bearer(req.headers.authorization), env)) return send(res, 401, { ok: false, error: 'bad or missing token' });
        const known = loadNodes(env)[askId];
        if (known && known.address && normalizeIp(req.socket.remoteAddress) !== known.address) {
          return send(res, 403, { ok: false, error: 'request does not come from the registered address' });
        }
        const published = readPublished(env, pipelineDir);
        if (url === '/code/latest') {
          if (!published) return send(res, 503, { ok: false, error: 'nothing published' });
          return send(res, 200, published);
        }
        const listed = (published || []).some((entry) => entry && typeof entry === 'object' && entry.bundle === bundleName);
        if (!listed) return send(res, 404, { ok: false, error: 'not found' });
        return streamBundle(res, path.join(publishDir(env, pipelineDir), bundleName));
      }
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

      const original = pkg.version === RECORD_PACKAGE_VERSION ? findOriginal(pipelineDir, pkg.taskId, nodePipelineDirs(env)) : null;
      if (pkg.version === RECORD_PACKAGE_VERSION && !original) return send(res, 409, { ok: false, error: 'no original record for this task' });
      storePackage(pipelineDir, pkg);
      if (original) replaceWithDraft(pipelineDir, original, pkg, now());
      returnLease(pkg.taskId, { now: now(), env });
      const stopped = pkg.version === RECORD_PACKAGE_VERSION && isStopRecord(pkg.record);
      if (stopped) recordEvent(pkg.taskId, 'blocked', { now: now(), env });
      try {
        const notice = stopped
          ? { level: 'summary', key: `node-package:${pkg.taskId}`, title: `Node ${nodeId}: task stopped with a question`, text: `Task ${pkg.taskId} stopped on ${nodeId} and needs a decision.` }
          : { level: 'summary', key: `node-package:${pkg.taskId}`, title: `Node ${nodeId}: review package arrived`, text: pkg.branch ? `Task ${pkg.taskId} came back from ${nodeId} on ${pkg.branch}.` : `Task ${pkg.taskId} was drafted on ${nodeId} and is waiting in review.` };
        await sendNotice(notice, { env, now });
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

module.exports = { createServer, refusal, storePackage, findOriginal, nodePipelineDirs, replaceWithDraft, MAX_BODY_BYTES };
