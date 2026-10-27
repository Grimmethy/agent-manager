'use strict';

// The per-item claim in scripts/review-runner.sh (two review daemons share queue/review/). The functions are lifted out of the script between their
// markers and run in a real bash, so this tests the shipped code, not a copy.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const SRC = fs.readFileSync(path.join(__dirname, 'review-runner.sh'), 'utf8');
const START = SRC.indexOf('CLAIM_DIR=');
const END = SRC.indexOf('trap release_current_claim EXIT');
assert.ok(START > 0 && END > START, 'claim block markers found in review-runner.sh');
const BLOCK = SRC.slice(START, END);

function runBash(instancesDir, instanceId, body) {
  const script = `set -u\nINSTANCES_DIR=${JSON.stringify(instancesDir)}\nINSTANCE_ID=${JSON.stringify(instanceId)}\n${BLOCK}\n${body}`;
  return spawnSync('bash', ['-c', script], { encoding: 'utf8' });
}

test('a claimed item is refused to the other daemon while the owner is alive, and a released claim is gone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-claim-'));
  const holder = spawn('sleep', ['20']);
  try {
    fs.mkdirSync(path.join(dir, 'review-claims', 'task-1.json.d'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'review-claims', 'task-1.json.d', 'owner'), `${holder.pid} reviewer\n`);
    const b = runBash(dir, 'reviewer-p40', 'claim_review_item task-1.json; echo rc=$?');
    assert.match(b.stdout, /rc=1/, 'a live owner keeps the claim: ' + b.stdout + b.stderr);
    const c = runBash(dir, 'reviewer-p40', 'claim_review_item task-2.json; echo rc=$?; release_current_claim; test -d "$CLAIM_DIR/task-2.json.d" && echo still-there || echo released');
    assert.match(c.stdout, /rc=0/);
    assert.match(c.stdout, /released/);
  } finally {
    holder.kill();
  }
});

test('a claim whose owner is dead is taken over; the new owner is recorded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-claim-stale-'));
  fs.mkdirSync(path.join(dir, 'review-claims', 'task-9.json.d'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'review-claims', 'task-9.json.d', 'owner'), '999999 reviewer\n');
  const r = runBash(dir, 'reviewer-p40', 'claim_review_item task-9.json; echo rc=$?; cat "$CLAIM_DIR/task-9.json.d/owner"');
  assert.match(r.stdout, /rc=0/);
  assert.match(r.stdout, /reviewer-p40/);
});

test('two daemons racing for the same item: exactly one wins', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-claim-race-'));
  const script = `set -u\nINSTANCES_DIR=${JSON.stringify(dir)}\n${BLOCK}\nfor n in 1 2 3 4 5 6 7 8; do ( INSTANCE_ID=d$n; claim_review_item task-race.json && echo "win d$n"; sleep 2 ) & done; wait`;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  assert.equal((r.stdout.match(/^win /gm) || []).length, 1, r.stdout + r.stderr);
});

test('review-runner.sh releases the claim at the top of each item, after the loop and on exit', () => {
  assert.match(SRC, /for name in "\$\{items\[@\]\}"; do\s*\n\s*release_current_claim/);
  assert.match(SRC, /\n  done\n  release_current_claim/);
  assert.match(SRC, /trap release_current_claim EXIT/);
  assert.match(SRC, /claim_review_item "\$name" \|\| continue/);
});
