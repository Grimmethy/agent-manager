'use strict';

// A git NETWORK failure at apply (the four messages below) is infrastructure like a git timeout: the approved result is released to approved/ to
// re-apply (bounded by APPLY_TIMEOUT_MAX_RELEASES), no redraft and no applyRetryCount burned. A non-network apply failure is unchanged.
// node:test / node:assert, temp dirs, injected isApplyCloneClean and recordModelOutcome; no network, no child processes, no timers.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { applyRetryCheck, isGitTimeoutFailure, isInfraApplyFailure } = require('./apply-retry-check.js');

const DNS_REASON = "fatal: unable to access 'https://github.com/Grimmethy/agent-manager.git/': Could not resolve host: github.com";
const PHRASES = ['Could not resolve host: github.com', 'Connection timed out after 30001 milliseconds', 'Connection refused', 'Temporary failure in name resolution'];

function setupDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-retry-net-'));
  const blockedDir = path.join(root, 'queue', 'blocked');
  const pendingDir = path.join(root, 'queue', 'pending');
  const approvedDir = path.join(root, 'queue', 'approved');
  for (const d of [blockedDir, pendingDir, approvedDir]) fs.mkdirSync(d, { recursive: true });
  return { root, blockedDir, pendingDir, approvedDir };
}
function writeBlocked(dir, id, extra = {}) {
  const task = { id, blockedStage: 'apply', blockedReason: DNS_REASON, applyRetryCount: 0, history: [], implementResponse: '### AC-1 x', ...extra };
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(task));
}

test('each of the four git network messages at apply is classed as a git timeout / infra failure', () => {
  for (const p of PHRASES) {
    const task = { blockedStage: 'apply', blockedReason: `fatal: unable to access 'https://github.com/x/y.git/': ${p}` };
    assert.equal(isGitTimeoutFailure(task), true, p);
    assert.equal(isInfraApplyFailure(task), true, p);
  }
});

test('the network patterns match regardless of letter case (the pattern keeps its /i flag)', () => {
  assert.equal(isGitTimeoutFailure({ blockedStage: 'apply', blockedReason: 'COULD NOT RESOLVE HOST: github.com' }), true);
  assert.equal(isGitTimeoutFailure({ blockedStage: 'apply', blockedReason: 'connection refused' }), true);
});

test('a network message outside the apply stage, and a non-network apply failure, are not classed as infra', () => {
  assert.equal(isInfraApplyFailure({ blockedStage: 'review', blockedReason: DNS_REASON }), false);
  assert.equal(isInfraApplyFailure({ blockedStage: 'apply', blockedReason: 'git apply failed: patch does not apply' }), false);
});

test('a DNS apply failure is released to approved/ to re-apply: no redraft, no retry burned, counted in applyTimeoutReleases', () => {
  const { blockedDir, pendingDir, approvedDir } = setupDirs();
  writeBlocked(blockedDir, 'dns-1', { applyRetryCount: 2 });
  const summary = applyRetryCheck({ blockedDir, pendingDir, approvedDir, recordModelOutcome: () => {}, isApplyCloneClean: () => true });
  assert.equal(summary.released, 1);
  assert.equal(summary.exhausted, 0);
  const r = JSON.parse(fs.readFileSync(path.join(approvedDir, 'dns-1.json'), 'utf8'));
  assert.equal(r.applyTimeoutReleases, 1);
  assert.equal(r.applyRetryCount, 2);
  assert.equal(r.status, 'approved');
  assert.equal(fs.existsSync(path.join(pendingDir, 'dns-1.json')), false, 'no redraft');
});

test('after APPLY_TIMEOUT_MAX_RELEASES network failures the record is no longer released as infra', () => {
  const mk = (n) => ({ blockedStage: 'apply', blockedReason: DNS_REASON, applyTimeoutReleases: n });
  assert.equal(isInfraApplyFailure(mk(3)), true);
  assert.equal(isInfraApplyFailure(mk(4)), false);
});
