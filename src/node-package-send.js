'use strict';

// Send command of a node (multi-node plan, piece 7c): ships every drafted record waiting in the node's queue/node-outbox/ (filed there by scripts/local-worker.sh,
// see src/node-outbox.js) to wok's package intake (src/package-intake-server.js) as a version 2 record package (buildRecordPackage in src/review-package.js).
//
//   node src/node-package-send.js --url <wok package intake url> --token-file <file> --node-id <id> --outbox <queue/node-outbox dir>
//
// Each record in the outbox (*.json, sorted by name) is sent with the node's token read from the file (never from the environment, never printed or logged). A 2xx
// answer moves the record to node-sent/, a sibling of the outbox; any other answer, a send that cannot be made, a file that is not a JSON record with a string id,
// or a move that fails leaves the file where it is and counts as failed. Prints one JSON line {sent, failed, remaining}. Exit 0 when nothing failed, 3 when any
// failed, 2 for a missing argument, an unreadable or empty token file, or an outbox that is not a directory (usage on stderr).

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

function moveToSent(file, sentDir) {
  try {
    fs.mkdirSync(sentDir, { recursive: true });
    fs.renameSync(file, path.join(sentDir, path.basename(file)));
    return true;
  } catch (e) {
    return false;
  }
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
  const sentDir = path.join(path.dirname(outbox), 'node-sent');
  const now = deps.now || Date.now;
  let sent = 0;
  let failed = 0;
  for (const name of outboxFiles(outbox)) {
    const file = path.join(outbox, name);
    const record = readJson(file);
    if (!record || typeof record.id !== 'string' || !record.id) { failed += 1; continue; }
    const pkg = buildRecordPackage({ record, nodeId, now: now() });
    const r = await sendPackage(pkg, { url, tokenFile, post: deps.post });
    if (r.ok && moveToSent(file, sentDir)) sent += 1; else failed += 1;
  }
  out(JSON.stringify({ sent, failed, remaining: outboxFiles(outbox).length }));
  return failed ? 3 : 0;
}

if (require.main === module) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });

module.exports = { main, flag, USAGE };
