'use strict';

// Send command of a node (multi-node plan, piece 7c): ships every drafted record waiting in the node's queue/node-outbox/ (filed there by scripts/local-worker.sh,
// see src/node-outbox.js) to wok's package intake (src/package-intake-server.js) as a version 2 record package (buildRecordPackage in src/review-package.js).
//
//   node src/node-package-send.js --url <wok package intake url> --token-file <file> --node-id <id> --outbox <queue/node-outbox dir>
//
// Each record in the outbox (*.json, sorted by name) is sent with the node's token read from the file (never from the environment, never printed or logged). A 2xx
// answer moves the record to node-sent/, a sibling of the outbox; any other answer, a send that cannot be made, a file that is not a JSON record with a string id,
// or a move that fails leaves the file where it is and counts as failed. HTTP 400 is the exception: the package can never be accepted as it stands, so the file
// is moved to node-refused/ (a sibling of node-sent/) with a <name>.reason.txt beside it reading `HTTP 400 at <ISO time>: <first 300 chars of the response body>` (or `(no body)` when the body is empty), and counts as refused, not failed.
// A record whose draft is empty (no implementResponse; see hasDraft in src/rereview-task.js) is skipped before it is built: it stays in the outbox, its file name and the reason are logged on stderr, and it counts as neither sent nor failed.
// A failed send logs one stderr line with the reason (`failed <name>: HTTP 503 <body>` or the stage that failed). A record that failed BACKOFF_AFTER times in a row (default 3,
// AGENT_MANAGER_NODE_SEND_BACKOFF_AFTER) is not tried again for AGENT_MANAGER_NODE_SEND_BACKOFF_MS (default 10 minutes): the state lives in node-send-backoff.json next to the
// outbox, the record stays in the outbox, and it is counted in `backedOff`, not in `failed`. Why the unit looped: am-node-send.path (PathChanged on the outbox) starts a run for every new
// drafted record, and each run re-posted every stuck record and exited 3, so one stuck record made every run fail and log nothing about why.
// Prints one JSON line {sent, failed, refused, remaining} plus backedOff when some record was skipped for its backoff. Exit 0 when nothing failed (refused alone is 0, a backed-off record alone is 0), 3 when any failed, 2 for a missing argument, an
// unreadable or empty token file, or an outbox that is not a directory (usage on stderr).

const fs = require('fs');
const path = require('path');
const { buildRecordPackage, sendPackage } = require('./review-package.js');

const USAGE = 'usage: node src/node-package-send.js --url <package intake url> --token-file <file> --node-id <id> --outbox <queue/node-outbox dir>\n';

// The value after a flag, or undefined when the flag is absent, last, or followed by another flag.
function flag(argv, name) {
  const i = argv.indexOf(name);
  const value = i >= 0 ? argv[i + 1] : undefined;
  return value === undefined || value.startsWith('--') ? undefined : value;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function outboxFiles(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
}

const BACKOFF_FILE = 'node-send-backoff.json';
const positive = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

// -> { name: { fails, reason, nextTryAt } }; {} when the file is missing or unreadable. Writes are best effort: a lost state only costs an earlier retry.
function readBackoff(file) {
  const v = readJson(file);
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}
function writeBackoff(file, state) {
  try { fs.writeFileSync(file, JSON.stringify(state)); } catch (e) { /* best effort */ }
}

// What the log says about a failed send, for the stderr line.
function reasonOf(r) {
  if (!r) return 'send failed';
  if (!r.status) return 'no answer from wok (network error, timeout or unreadable token)';
  return `HTTP ${r.status}${r.body ? ' ' + String(r.body).replace(/\s+/g, ' ').slice(0, 200) : ''}`;
}

function moveToSent(file, sentDir) {
  try {
    fs.mkdirSync(sentDir, { recursive: true });
    fs.renameSync(file, path.join(sentDir, path.basename(file)));
    return true;
  } catch (e) {
    return false;
  }
}

function moveToRefused(file, refusedDir, line) {
  try {
    fs.mkdirSync(refusedDir, { recursive: true });
    fs.renameSync(file, path.join(refusedDir, path.basename(file)));
  } catch (e) {
    return false;
  }
  try { fs.writeFileSync(path.join(refusedDir, `${path.basename(file)}.reason.txt`), `${line}\n`); } catch (e) { /* the file is already out of the outbox */ }
  return true;
}

async function main(argv, env = process.env, deps = {}, out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(s)) {
  const url = flag(argv, '--url');
  const tokenFile = flag(argv, '--token-file');
  const nodeId = flag(argv, '--node-id');
  const outbox = flag(argv, '--outbox');
  if (!url || !tokenFile || !nodeId || !outbox) { err(USAGE); return 2; }
  let token = '';
  try { token = fs.readFileSync(tokenFile, 'utf8').trim(); } catch (e) { token = ''; }
  if (!token) { err('the token file is missing or empty\n'); return 2; }
  if (!fs.existsSync(outbox) || !fs.statSync(outbox).isDirectory()) { err('the outbox is not a directory\n'); return 2; }
  // Loaded here, not at the top: rereview-task.js pulls in modules that read the home directory, so the usage path must not load it.
  const { hasDraft } = require('./rereview-task.js');
  const sentDir = path.join(path.dirname(outbox), 'node-sent');
  const refusedDir = path.join(path.dirname(outbox), 'node-refused');
  const now = deps.now || Date.now;
  let sent = 0;
  let failed = 0;
  let refused = 0;
  let skippedUndrafted = 0;
  let backedOff = 0;
  const backoffFile = path.join(path.dirname(outbox), BACKOFF_FILE);
  const backoff = readBackoff(backoffFile);
  const backoffAfter = positive(env.AGENT_MANAGER_NODE_SEND_BACKOFF_AFTER, 3);
  const backoffMs = positive(env.AGENT_MANAGER_NODE_SEND_BACKOFF_MS, 10 * 60 * 1000);
  const fail = (name, reason) => {
    failed += 1;
    const prev = backoff[name] || { fails: 0 };
    const fails = (Number(prev.fails) || 0) + 1;
    backoff[name] = { fails, reason, nextTryAt: fails >= backoffAfter ? now() + backoffMs : 0 };
    err(`failed ${name}: ${reason}${fails >= backoffAfter ? ` (${fails} in a row; not tried again for ${Math.round(backoffMs / 60000)} min)` : ''}\n`);
  };
  for (const name of outboxFiles(outbox)) {
    const file = path.join(outbox, name);
    if (backoff[name] && Number(backoff[name].nextTryAt) > now()) { backedOff += 1; continue; }
    const record = readJson(file);
    if (!record || typeof record.id !== 'string' || !record.id) { fail(name, 'not a JSON record with a string id'); continue; }
    if (!hasDraft(record)) { skippedUndrafted += 1; err(`skipped ${name}: the record has no draft (implementResponse is empty); it stays in the outbox\n`); continue; }
    const pkg = buildRecordPackage({ record, nodeId, now: now() });
    const r = await sendPackage(pkg, { url, tokenFile, post: deps.post });
    if (r.ok) { if (moveToSent(file, sentDir)) { sent += 1; } else fail(name, `accepted (HTTP ${r.status}) but could not be moved to node-sent`); }
    else if (r.status === 400) { const body = r.body ? String(r.body).slice(0, 300) : '(no body)'; if (moveToRefused(file, refusedDir, `HTTP 400 at ${new Date(now()).toISOString()}: ${body}`)) { refused += 1; } else fail(name, 'HTTP 400 and the refile into node-refused failed'); }
    else fail(name, reasonOf(r));
  }
  for (const name of Object.keys(backoff)) if (!fs.existsSync(path.join(outbox, name))) delete backoff[name];
  writeBackoff(backoffFile, backoff);
  out(JSON.stringify({ sent, failed, refused, remaining: outboxFiles(outbox).length, ...(backedOff ? { backedOff } : {}) }));
  return failed ? 3 : 0;
}

if (require.main === module) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });

module.exports = { main, flag, USAGE };
