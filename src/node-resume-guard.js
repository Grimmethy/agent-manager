'use strict';
const fs = require('fs');
const path = require('path');

const PARK_AFTER = 4;

// Direct existence checks only; no directory scan.
function handedOff(queueDir, id) {
  return fs.existsSync(path.join(queueDir, 'node-outbox', id + '.json')) ||
    fs.existsSync(path.join(queueDir, 'node-sent', id + '.json'));
}

function readState(countsFile) {
  if (!fs.existsSync(countsFile)) return { counts: {}, history: [] };
  const raw = JSON.parse(fs.readFileSync(countsFile, 'utf8') || '{}');
  return { counts: raw.counts || {}, history: raw.history || [] };
}

function writeState(countsFile, state) {
  fs.mkdirSync(path.dirname(countsFile), { recursive: true });
  fs.writeFileSync(countsFile, JSON.stringify(state, null, 2) + '\n');
}

// Returns 'draft' (resume allowed), 'skip' (already parked, same state), or 'park' (4th unchanged resume).
function decideResume(countsFile, id, stateKey) {
  const state = readState(countsFile);
  let entry = state.counts[id];
  if (!entry || entry.stateKey !== stateKey) {
    entry = { stateKey: stateKey, count: 0, parked: false };
    state.counts[id] = entry;
  }
  if (entry.parked) return 'skip';
  entry.count += 1;
  if (entry.count >= PARK_AFTER) {
    entry.parked = true;
    state.history.push({ id: id, event: 'park', stateKey: stateKey, at: new Date().toISOString() });
    writeState(countsFile, state);
    return 'park';
  }
  writeState(countsFile, state);
  return 'draft';
}

module.exports = { handedOff, decideResume };

if (require.main === module) {
  const [cmd, a, b, c] = process.argv.slice(2);
  if (cmd === 'handed-off' && a && b) {
    console.log(String(handedOff(a, b)));
    process.exit(0);
  }
  if (cmd === 'decide' && a && b && c) {
    console.log(decideResume(a, b, c));
    process.exit(0);
  }
  console.error('usage: node src/node-resume-guard.js handed-off <queueDir> <id> | decide <countsFile> <id> <stateKey>');
  process.exit(2);
}
