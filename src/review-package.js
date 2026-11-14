'use strict';

// Review package (multi-node plan, piece 4d): what a node sends back to wok when it has finished a lent task: {version:1, taskId, nodeId, branch, sha,
// record, builtAt}. Version 2 (the record package, piece 7a) is {version:2, kind:'record', taskId, nodeId, record, builtAt}: the node stopped after the
// draft and ships the drafted record itself, which carries the diff (rawDiff), so there is no branch or sha; wok files it in its own queue/review/. The record is copied WITHOUT the votes and history (they belong to the pipeline that produced them) and without any key that looks
// like a secret, at any depth, so a package never carries a token or a password. A package never contains live client data: the record is the task, and
// the work is the branch the relay (piece 4f) moves.
//
// buildPackage and validatePackage are pure; sendPackage POSTs to wok's package intake (piece 4e) with the node's token read from a file.

const fs = require('fs');
const http = require('http');
const https = require('https');

const PACKAGE_VERSION = 1;
const RECORD_PACKAGE_VERSION = 2;
const PACKAGE_STRIP = ['localVotes', 'history'];
const RECORD_PACKAGE_STRIP = [...PACKAGE_STRIP, 'leasedTo'];
const SECRET_KEY_RE = /token|secret|password/i;
const SEND_TIMEOUT_MS = 15000;
const SHA_RE = /^[0-9a-f]{40}$/;

// Deep copy of value without the secret-looking keys (at every depth, inside arrays too).
function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (!SECRET_KEY_RE.test(k)) out[k] = scrub(v);
    }
    return out;
  }
  return value;
}

function buildPackage({ record, nodeId, branch, sha, now = Date.now() }) {
  const copy = scrub(record && typeof record === 'object' ? record : {});
  for (const key of PACKAGE_STRIP) delete copy[key];
  return { version: PACKAGE_VERSION, taskId: record ? record.id : undefined, nodeId, branch, sha, record: copy, builtAt: new Date(now).toISOString() };
}

// Version 2: the drafted record as the package. Same scrubbing as buildPackage, and the lease stamp goes too (the record leaves the node's lease behind).
function buildRecordPackage({ record, nodeId, now = Date.now() }) {
  const copy = scrub(record && typeof record === 'object' ? record : {});
  for (const key of RECORD_PACKAGE_STRIP) delete copy[key];
  return { version: RECORD_PACKAGE_VERSION, kind: 'record', taskId: record ? record.id : undefined, nodeId, record: copy, builtAt: new Date(now).toISOString() };
}

function validatePackage(pkg) {
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) return { ok: false, reason: 'package must be an object' };
  if (pkg.version !== PACKAGE_VERSION && pkg.version !== RECORD_PACKAGE_VERSION) return { ok: false, reason: 'unsupported version' };
  if (!pkg.record || typeof pkg.record !== 'object' || Array.isArray(pkg.record)) return { ok: false, reason: 'record must be an object' };
  if (typeof pkg.taskId !== 'string' || !pkg.taskId || pkg.taskId !== pkg.record.id) return { ok: false, reason: 'taskId must equal record.id' };
  if (typeof pkg.nodeId !== 'string' || !pkg.nodeId) return { ok: false, reason: 'nodeId is missing' };
  if (pkg.version === RECORD_PACKAGE_VERSION) {
    if (pkg.kind !== 'record') return { ok: false, reason: "kind must be 'record'" };
    if (typeof pkg.record.rawDiff !== 'string' || !pkg.record.rawDiff) return { ok: false, reason: 'record.rawDiff must be a non-empty string' };
    return { ok: true, reason: '' };
  }
  if (typeof pkg.sha !== 'string' || !SHA_RE.test(pkg.sha)) return { ok: false, reason: 'sha must be 40 hex characters' };
  if (typeof pkg.branch !== 'string' || !pkg.branch.startsWith('agent/')) return { ok: false, reason: 'branch must start with agent/' };
  return { ok: true, reason: '' };
}

// Default transport: one POST, resolves {status}; rejects on a network error or a timeout.
function httpPost(url, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request(target, { method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }, timeout: timeoutMs }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

// POSTs the package with the node's token (read from tokenFile). Never throws: {ok, status} where status is 0 when nothing was sent or answered.
async function sendPackage(pkg, { url, tokenFile, post = httpPost } = {}) {
  let token = '';
  try { token = fs.readFileSync(tokenFile, 'utf8').trim(); } catch (e) { token = ''; }
  if (!token) return { ok: false, status: 0 };
  try {
    const res = await post(url, { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, JSON.stringify(pkg), SEND_TIMEOUT_MS);
    const status = Number(res && res.status) || 0;
    return { ok: status >= 200 && status < 300, status };
  } catch (e) {
    return { ok: false, status: 0 };
  }
}

module.exports = { PACKAGE_VERSION, RECORD_PACKAGE_VERSION, PACKAGE_STRIP, RECORD_PACKAGE_STRIP, SECRET_KEY_RE, SEND_TIMEOUT_MS, scrub, buildPackage, buildRecordPackage, validatePackage, sendPackage, httpPost };
