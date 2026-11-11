'use strict';

// Node registry: which machines are part of this Agent Manager, whether they are alive, and who to tell when one goes quiet (multi-node plan, piece 2c).
//
// Two small files in the nodes directory (AGENT_MANAGER_NODES_DIR, default $HOME/.local/state/agent-manager/nodes), both outside any repository:
//   nodes.json         a map id -> record {id, address, cores, ramGb, gpu, allowedProviders, concurrencyCap, pauseRules, lastSeen, lastAddress, state, load,
//                      freeRamGb, paused}; written atomically.
//   nodes-tokens.json  a map id -> token string, mode 600. A token is created when a node is registered and printed ONCE; it is never part of a node record.
//
// A heartbeat (recordHeartbeat) refreshes lastSeen and the reported state. The status of a node is computed, never stored:
//   stale   no heartbeat for AGENT_MANAGER_NODE_STALE_MIN minutes (default 5), or never one
//   off     the node reported state "off" (an operator turned it off on purpose)
//   paused  the node reported that its machine pause is active
//   up      otherwise
// sweepStale raises ONE urgent notification (src/notify.js, key stale-node:<id>, which de-duplicates by key itself) for every node that has been seen
// before and has gone stale. It is called after every heartbeat, so a heartbeat from any node (wok heartbeats too) checks all the others: an event, not a
// polling loop. A node that never sent a heartbeat, and a node that is off, raise nothing.
//
// CLI (the dashboard's GET /api/nodes shells out to `list`):
//   node src/node-registry.js register <id> [--address <ip>] [--cores <n>] [--ram-gb <n>] [--gpu <text>] [--providers <a,b>] [--cap <n>] [--rotate]
//   node src/node-registry.js list

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { writeJsonAtomicSync } = require('./atomic-write.js');
const { notify } = require('./notify.js');

const NODE_ID_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const HEARTBEAT_STATES = ['up', 'off'];

function nodesDir(env = process.env) {
  const override = String(env.AGENT_MANAGER_NODES_DIR || '').trim();
  if (override) return override;
  return path.join(env.HOME || os.homedir(), '.local', 'state', 'agent-manager', 'nodes');
}

function staleMinutes(env = process.env) {
  const n = Number(env.AGENT_MANAGER_NODE_STALE_MIN);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

function isValidNodeId(id) {
  return typeof id === 'string' && NODE_ID_RE.test(id);
}

function readMap(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    return {};
  }
}

const loadNodes = (env = process.env) => readMap(path.join(nodesDir(env), 'nodes.json'));
const loadTokens = (env = process.env) => readMap(path.join(nodesDir(env), 'nodes-tokens.json'));

function saveNodes(nodes, env = process.env) {
  fs.mkdirSync(nodesDir(env), { recursive: true });
  writeJsonAtomicSync(path.join(nodesDir(env), 'nodes.json'), nodes);
}

function saveTokens(tokens, env = process.env) {
  const dir = nodesDir(env);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'nodes-tokens.json');
  writeJsonAtomicSync(file, tokens);
  fs.chmodSync(file, 0o600);
}

function positiveNumber(value, name) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return n;
}

// Creates or updates a node and returns {record, token}. The token is returned only when a new one was made (a new node, or rotate true); updating an
// existing node's details keeps its token and returns token null.
function registerNode(spec = {}, env = process.env, { rotate = false } = {}) {
  if (!isValidNodeId(spec.id)) throw new Error(`invalid node id ${JSON.stringify(spec.id)} (lowercase letters, digits and dashes, at most 31 characters)`);
  const nodes = loadNodes(env);
  const tokens = loadTokens(env);
  const previous = nodes[spec.id] || {};
  const providers = Array.isArray(spec.allowedProviders) ? spec.allowedProviders.map(String) : [];
  const record = {
    ...previous,
    id: spec.id,
    address: String(spec.address || ''),
    cores: positiveNumber(spec.cores, 'cores'),
    ramGb: positiveNumber(spec.ramGb, 'ramGb'),
    gpu: String(spec.gpu || ''),
    allowedProviders: providers,
    concurrencyCap: positiveNumber(spec.concurrencyCap, 'concurrencyCap'),
    pauseRules: spec.pauseRules && typeof spec.pauseRules === 'object' ? spec.pauseRules : (previous.pauseRules || {}),
    lastSeen: previous.lastSeen || null,
  };
  nodes[spec.id] = record;
  let token = null;
  if (!tokens[spec.id] || rotate) {
    token = crypto.randomBytes(24).toString('hex');
    tokens[spec.id] = token;
    saveTokens(tokens, env);
  }
  saveNodes(nodes, env);
  return { record, token };
}

// Constant-time token check: both sides are hashed first so the comparison always sees equal lengths.
function verifyToken(id, token, env = process.env) {
  if (!isValidNodeId(id) || typeof token !== 'string' || token === '') return false;
  const expected = loadTokens(env)[id];
  if (typeof expected !== 'string') return false;
  const digest = (s) => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(digest(expected), digest(token));
}

function numberOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// Records a heartbeat for a registered node and returns its record. Throws on an unknown node, an unusable state or a non-boolean paused.
function recordHeartbeat(payload = {}, env = process.env, now = Date.now()) {
  const nodes = loadNodes(env);
  const record = nodes[payload.id];
  if (!isValidNodeId(payload.id) || !record) throw new Error(`unknown node ${JSON.stringify(payload.id)}`);
  const state = payload.state === undefined ? 'up' : payload.state;
  if (!HEARTBEAT_STATES.includes(state)) throw new Error(`state must be one of ${HEARTBEAT_STATES.join(', ')}`);
  if (payload.paused !== undefined && typeof payload.paused !== 'boolean') throw new Error('paused must be true or false');
  const updated = {
    ...record,
    lastSeen: new Date(now).toISOString(),
    lastAddress: typeof payload.address === 'string' ? payload.address.slice(0, 64) : (record.lastAddress || ''),
    state,
    load: numberOrNull(payload.load),
    freeRamGb: numberOrNull(payload.freeRamGb),
    paused: payload.paused === true,
  };
  nodes[payload.id] = updated;
  saveNodes(nodes, env);
  return updated;
}

function statusOf(record, env = process.env, now = Date.now()) {
  const seen = Date.parse(record.lastSeen);
  if (!Number.isFinite(seen) || now - seen > staleMinutes(env) * 60 * 1000) return 'stale';
  if (record.state === 'off') return 'off';
  if (record.paused === true) return 'paused';
  return 'up';
}

function listNodes(env = process.env, now = Date.now()) {
  const nodes = loadNodes(env);
  return Object.keys(nodes).sort().map((id) => ({ ...nodes[id], status: statusOf(nodes[id], env, now) }));
}

// One urgent notification per stale node that has been seen before (notify() de-duplicates by key). Returns the ids it tried to raise.
async function sweepStale(env = process.env, now = Date.now(), send = notify) {
  const raised = [];
  for (const node of listNodes(env, now)) {
    if (node.status !== 'stale' || !node.lastSeen || node.state === 'off') continue;
    const minutes = Math.round((now - Date.parse(node.lastSeen)) / 60000);
    await send({ level: 'urgent', key: `stale-node:${node.id}`, title: `${node.id} is not answering`, text: `No heartbeat from ${node.id} for ${minutes} minutes.` }, { env, now: () => now });
    raised.push(node.id);
  }
  return raised;
}

function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const name = argv[i].slice(2);
    out[name] = i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}

function main(argv, env = process.env, log = (s) => process.stdout.write(`${s}\n`)) {
  const [cmd, id, ...rest] = argv;
  if (cmd === 'list') { log(JSON.stringify(listNodes(env))); return 0; }
  if (cmd === 'register') {
    const f = flags(rest);
    const providers = typeof f.providers === 'string' ? f.providers.split(',').map((s) => s.trim()).filter(Boolean) : [];
    const { record, token } = registerNode({ id, address: f.address, cores: f.cores, ramGb: f['ram-gb'], gpu: f.gpu, allowedProviders: providers, concurrencyCap: f.cap }, env, { rotate: f.rotate === true });
    log(JSON.stringify({ record, token }));
    return 0;
  }
  process.stderr.write('usage: node src/node-registry.js register <id> [--address <ip>] [--cores <n>] [--ram-gb <n>] [--gpu <text>] [--providers a,b] [--cap <n>] [--rotate] | list\n');
  return 2;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { nodesDir, staleMinutes, isValidNodeId, loadNodes, loadTokens, registerNode, verifyToken, recordHeartbeat, statusOf, listNodes, sweepStale, main };
