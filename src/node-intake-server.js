'use strict';

// Node intake (multi-node plan, piece 4c): the small HTTP endpoint on a node (for example grimm) through which wok LENDS it a task. Kept apart from the
// dashboard on purpose, like src/node-registry-server.js: it holds one secret that can do one thing, put a task record in this machine's queue/adhoc/.
//
//   POST /lend   Authorization: Bearer <lender token>, JSON {task: <record>, lease: {taskId, nodeId, expiresAt}}   -> 200 {ok: true, taskId}
//   400 bad or oversized (over 1 MB) body, a task id that is not /^[A-Za-z0-9._-]{1,200}$/, or a lease that does not match the task,
//   401 missing or wrong token, 403 the request does not come from AGENT_MANAGER_LENDER_ADDRESS (when that is set), 404 any other path,
//   405 any other method on /lend, 409 a record with that id is already in queue/adhoc/ (it is never overwritten).
//
//   POST /status Authorization: Bearer <lender token>, JSON {taskIds: [...]} -> 200 {ok: true, tasks: {<id>: 'in-progress'|'merged'|'unknown'}}
//   400 bad or oversized body, taskIds not an array, more than 50 ids, any id not matching TASK_ID_RE,
//   401 missing or wrong token, 403 the request does not come from AGENT_MANAGER_LENDER_ADDRESS (when that is set), 404 any other path,
//   405 any other method on /status.
//
// The /status endpoint answers where a task is in the pipeline without modifying anything. 'in-progress' means the record is in queue/adhoc, pending,
// drafting, review, approved, node-outbox or coordinating. 'merged' means the record is in queue/done with a mergedAt, or its history has an 'applied' stage
// and its branch is an ancestor of origin/<base> (checked via an injectable git function, default git merge-base --is-ancestor). Anything else is 'unknown'.
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

const MAX_STATUS_IDS = 50;

// Validates the body for POST /status. Returns {ok: true} or {ok: false, status: 400, error: '<reason>'}.
function validateStatusBody(body) {
  if (!isObject(body)) return { ok: false, status: 400, error: 'body must be a JSON object' };
  const taskIds = body.taskIds;
  if (!Array.isArray(taskIds)) return { ok: false, status: 400, error: 'taskIds must be an array' };
  if (taskIds.length > MAX_STATUS_IDS) return { ok: false, status: 400, error: 'too many taskIds' };
  for (const id of taskIds) {
    if (typeof id !== 'string' || !TASK_ID_RE.test(id)) return { ok: false, status: 400, error: 'invalid taskId' };
  }
  return { ok: true };
}

// Detects where a task is in the pipeline without modifying anything.
// 'in-progress' = record is in queue/adhoc, pending, drafting, review, approved, node-outbox or coordinating.
// 'merged' = record is in queue/done with mergedAt, OR history has applied stage and branch is ancestor of origin/<base>.
// 'blocked' = record is in queue/blocked or queue/needs-clarification (and is not merged): the node cannot go on with it, so wok should take it back.
// 'unknown' = anything else (awaiting-confirm, absent).
function detectTaskState(taskId, pipelineDir, gitFn, repoDir = process.cwd(), { env = process.env, baseGitFn = defaultBaseGitFn } = {}) {
  const queueDir = path.join(pipelineDir, 'queue');
  const inProgressStates = ['adhoc', 'pending', 'drafting', 'review', 'approved', 'node-outbox', 'coordinating'];
  for (const state of inProgressStates) {
    const file = path.join(queueDir, state, `${taskId}.json`);
    if (fs.existsSync(file)) return 'in-progress';
  }
  // Read-only lookup of a task that is not live: done, blocked, needs-clarification or awaiting-confirm.
  let record = null;
  let recordState = '';
  for (const state of ['done', 'blocked', 'needs-clarification', 'awaiting-confirm']) {
    const file = path.join(queueDir, state, `${taskId}.json`);
    if (!fs.existsSync(file)) continue;
    recordState = state;
    try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { record = null; }
    break;
  }
  if (recordState === 'done' && record && record.mergedAt) return 'merged';
  // The applied stage's detail is the task branch; it counts as merged when that branch is an ancestor of origin/<base> in the node repo.
  const applied = record && Array.isArray(record.history) ? record.history.find((h) => h && h.stage === 'applied') : null;
  if (applied && typeof applied.detail === 'string' && applied.detail && typeof gitFn === 'function') {
    // The repo is the one the task was applied in (the record's generatedForRepoRoot), not the server's own checkout.
    const recorded = record && typeof record.generatedForRepoRoot === 'string' ? record.generatedForRepoRoot.trim() : '';
    const repo = recorded || repoDir;
    if (!repo || !fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) return 'unknown';
    const base = resolveBase(repo, env, baseGitFn);
    try { if (gitFn(applied.detail, `origin/${base}`, repo)) return 'merged'; } catch (e) { /* not merged */ }
  }
  if (recordState === 'blocked' || recordState === 'needs-clarification') return 'blocked';
  return 'unknown';
}

// The reason a task sits in queue/blocked or queue/needs-clarification on this node: the record's blockedReason (blocked) or its
// needs-clarification openQuestions, trimmed and capped at MAX_REASON_CHARS; '' when there is none or the record cannot be read.
const MAX_REASON_CHARS = 300;
function blockedReasonOf(taskId, pipelineDir) {
  for (const state of ['blocked', 'needs-clarification']) {
    const file = path.join(pipelineDir, 'queue', state, `${taskId}.json`);
    if (!fs.existsSync(file)) continue;
    try {
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      const nc = record && record.needsClarification && typeof record.needsClarification === 'object' ? record.needsClarification.openQuestions : '';
      const raw = (record && typeof record.blockedReason === 'string' && record.blockedReason) || (typeof nc === 'string' ? nc : '');
      return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_CHARS);
    } catch (e) { return ''; }
  }
  return '';
}

// Runs one read-only git command in repoDir and returns its trimmed stdout, or '' when git fails. Never fetches, checks out or writes.
function defaultBaseGitFn(repoDir, args) {
  const { execFileSync } = require('child_process');
  try {
    return String(execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 })).trim();
  } catch (e) {
    return '';
  }
}

// The base branch the merged check uses for one repo: AGENT_MANAGER_MERGED_BASE when set, else origin/HEAD's branch, else master when origin/master exists, else main.
function resolveBase(repoDir, env = process.env, runGit = defaultBaseGitFn) {
  const override = String(env.AGENT_MANAGER_MERGED_BASE || '').trim();
  if (override) return override;
  const head = runGit(repoDir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (head) return head.replace(/^origin\//, '');
  if (runGit(repoDir, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/master'])) return 'master';
  return 'main';
}

// Default git function: checks if the task's branch is an ancestor of the given base using git merge-base --is-ancestor.
function defaultGitFn(branch, base, repoDir) {
  const { execFileSync } = require('child_process');
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', branch, base], { cwd: repoDir, stdio: 'ignore', timeout: 10000 });
    return true;
  } catch (e) {
    return false;
  }
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

// Promotes leased, dependency-resolved adhoc tasks to pending on this node.
// A task is promoted when:
// - It is in queue/adhoc/
// - It has leasedTo set to this node (nodeId)
// - It has no dependsOn (or dependsOn is empty)
// - Its dependsOnResolved.ids is empty (all dependencies satisfied)
// - It is not shadowed by a record in queue/blocked/ with the same id
// Returns the number of tasks promoted.
function promoteLeasedAdhoc(pipelineDir, nodeId) {
  const adhocDir = path.join(pipelineDir, 'queue', 'adhoc');
  const pendingDir = path.join(pipelineDir, 'queue', 'pending');
  const blockedDir = path.join(pipelineDir, 'queue', 'blocked');
  
  let promoted = 0;
  
  try {
    fs.mkdirSync(pendingDir, { recursive: true });
    fs.mkdirSync(blockedDir, { recursive: true });
  } catch (e) {
    return 0;
  }
  
  let adhocFiles;
  try {
    adhocFiles = fs.readdirSync(adhocDir).filter(f => f.endsWith('.json'));
  } catch (e) {
    return 0;
  }
  
  // Build set of ids in blocked/ for shadow check
  const blockedIds = new Set();
  try {
    const blockedFiles = fs.readdirSync(blockedDir).filter(f => f.endsWith('.json'));
    for (const f of blockedFiles) {
      blockedIds.add(f.replace('.json', ''));
    }
  } catch (e) {
    // If we can't read blocked/, proceed without shadow check
  }
  
  for (const file of adhocFiles) {
    const id = file.replace('.json', '');
    
    // Skip if shadowed by a blocked record
    if (blockedIds.has(id)) continue;
    
    let record;
    try {
      record = JSON.parse(fs.readFileSync(path.join(adhocDir, file), 'utf8'));
    } catch (e) {
      continue;
    }
    
    // Check if leased to this node
    if (record.leasedTo !== nodeId) continue;
    
    // Check if no dependsOn (or empty)
    if (record.dependsOn && record.dependsOn.length > 0) continue;
    
    // Check if dependsOnResolved is satisfied (empty ids)
    if (!record.dependsOnResolved || !Array.isArray(record.dependsOnResolved.ids) || record.dependsOnResolved.ids.length > 0) continue;
    
    // Promote: move from adhoc to pending
    const src = path.join(adhocDir, file);
    const dst = path.join(pendingDir, file);
    
    // Skip if already in pending
    if (fs.existsSync(dst)) continue;
    
    try {
      // Use rename for atomic move within same filesystem
      fs.renameSync(src, dst);
      promoted++;
    } catch (e) {
      // If rename fails (cross-filesystem), try copy+delete
      try {
        const data = fs.readFileSync(src, 'utf8');
        fs.writeFileSync(dst, data);
        fs.unlinkSync(src);
        promoted++;
      } catch (e2) {
        // Skip on failure
      }
    }
  }
  
  return promoted;
}

function createServer({ env = process.env, gitFn, repoDir = process.cwd() } = {}) {
  const token = readToken(env);
  const pipelineDir = String(env.AGENT_MANAGER_PIPELINE_DIR || '').trim();
  if (!pipelineDir) throw new Error('AGENT_MANAGER_PIPELINE_DIR must be set');
  const lender = String(env.AGENT_MANAGER_LENDER_ADDRESS || '').trim();

  const handleLend = async (res, payload) => {
    const task = isObject(payload) ? payload.task : null;
    const lease = isObject(payload) ? payload.lease : null;
    if (!isObject(task) || !isObject(lease)) return send(res, 400, { ok: false, error: 'body needs a task object and a lease object' });
    if (typeof task.id !== 'string' || !TASK_ID_RE.test(task.id)) return send(res, 400, { ok: false, error: 'task id is not valid' });
    if (lease.taskId !== task.id || typeof lease.nodeId !== 'string' || !lease.nodeId.trim()) return send(res, 400, { ok: false, error: 'lease does not match the task' });

    if (!writeAdhoc(pipelineDir, { ...task, leasedTo: lease.nodeId.trim() })) return send(res, 409, { ok: false, error: 'a task with that id is already queued' });
    
    // Promote any leased, dependency-resolved adhoc tasks to pending
    promoteLeasedAdhoc(pipelineDir, lease.nodeId.trim());
    
    return send(res, 200, { ok: true, taskId: task.id });
  };

  const handleStatus = async (res, payload) => {
    const validation = validateStatusBody(payload);
    if (!validation.ok) return send(res, validation.status, { ok: false, error: validation.error });
    const git = typeof gitFn === 'function' ? gitFn : defaultGitFn;
    const tasks = {};
    const reasons = {};
    for (const taskId of payload.taskIds) {
      tasks[taskId] = detectTaskState(taskId, pipelineDir, git, repoDir, { env });
      if (tasks[taskId] === 'blocked') reasons[taskId] = blockedReasonOf(taskId, pipelineDir);
    }
    return send(res, 200, { ok: true, tasks, reasons });
  };

  const routes = {
    '/lend': handleLend,
    '/status': handleStatus,
  };

  return http.createServer(async (req, res) => {
    try {
      const url = String(req.url || '').split('?')[0];
      const route = Object.prototype.hasOwnProperty.call(routes, url) ? routes[url] : null;
      if (!route) return send(res, 404, { ok: false, error: 'not found' });
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
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return send(res, 400, { ok: false, error: 'body must be a JSON object' });
      return await route(res, payload);
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

module.exports = { createServer, blockedReasonOf, normalizeIp, bearer, sameToken, writeAdhoc, promoteLeasedAdhoc, TASK_ID_RE, MAX_BODY_BYTES, validateStatusBody, detectTaskState, defaultGitFn, resolveBase, defaultBaseGitFn };
