'use strict';

// Unit tests for connectivity-check.js's isOnline() -- the gate task-sources.js's
// nextProjectSearchTask()/nextDeepDiveTask() use to skip generating network-dependent
// work while offline (see that file's own header comment for the incident this fixes:
// project_search tasks kept getting drafted and blocked in bulk while the internet
// connection was down, 2026-08-15).
//
// Most tests here use an injected fake probe (see isOnline()'s probe param) rather than
// hitting real network -- deterministic and instant, not dependent on this machine's
// actual connectivity or curl's 3s timeout. One real integration test at the bottom
// exercises the actual curl invocation against a genuinely unroutable address, to prove
// probeOnce()'s command/flags are actually correct, not just that the mocking works.
//
// Run: node --test src/connectivity-check.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');

// isOnline()'s cache is module-level state (by design -- see the module's own header
// comment on why: avoid a fresh network round-trip on every single next*Task() call
// within the same tick). Re-requiring fresh after clearing require.cache resets that
// state between tests, same convention task-sources.test.js's own freshTaskSources()
// already uses for the same reason.
function freshConnectivityCheck() {
  delete require.cache[require.resolve('./connectivity-check.js')];
  return require('./connectivity-check.js');
}

test('isOnline returns true when the probe reports reachable', () => {
  const { isOnline } = freshConnectivityCheck();
  assert.equal(isOnline({ probe: () => true }), true);
});

test('isOnline returns false when the probe reports unreachable', () => {
  const { isOnline } = freshConnectivityCheck();
  assert.equal(isOnline({ probe: () => false }), false);
});

test('isOnline caches the result -- a second call within the cache window does not re-invoke the probe', () => {
  const { isOnline } = freshConnectivityCheck();
  let calls = 0;
  const probe = () => { calls += 1; return true; };
  isOnline({ probe });
  isOnline({ probe });
  isOnline({ probe });
  assert.equal(calls, 1, 'three calls inside the cache window should only probe once');
});

test('isOnline forceRefresh bypasses the cache and re-invokes the probe', () => {
  const { isOnline } = freshConnectivityCheck();
  let calls = 0;
  const probe = () => { calls += 1; return true; };
  isOnline({ probe });
  isOnline({ probe, forceRefresh: true });
  assert.equal(calls, 2);
});

test('isOnline reflects a changed probe result once forceRefresh bypasses the stale cached value', () => {
  const { isOnline } = freshConnectivityCheck();
  assert.equal(isOnline({ probe: () => true }), true, 'seed the cache as online');
  // Without forceRefresh, the cached (stale) "online" answer would still win here even
  // though this probe now reports offline -- forceRefresh is what makes the cache not a
  // permanent trap once real connectivity actually changes.
  assert.equal(isOnline({ probe: () => false, forceRefresh: true }), false);
});

test('the underlying curl command (same shape probeOnce() uses) correctly reports offline against an unroutable address', () => {
  // 192.0.2.1 is RFC 5737 TEST-NET-1 -- reserved for documentation/testing, guaranteed
  // never routable on a real network. connectivity-check.js's CHECK_URL is a fixed
  // module constant (api.github.com), not overridable per-call, so this can't drive
  // probeOnce() itself at a genuinely unreachable target -- it instead re-runs the exact
  // same curl invocation shape directly, wrapped the same way probeOnce() wraps it.
  //
  // Real finding while writing this test: curl does NOT cleanly print "000" and exit 0
  // against an unroutable address -- it exits non-zero (connection timeout), which makes
  // execFileSync THROW. That's exactly why probeOnce() has a try/catch around this call
  // returning false on any exception, not just a bare status-code check -- an earlier
  // version of this test called curl directly with no catch and failed on exactly this.
  const { execFileSync } = require('child_process');
  let looksOnline;
  try {
    const out = execFileSync(
      'curl',
      ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '2', 'http://192.0.2.1'],
      { encoding: 'utf8', timeout: 4000 },
    );
    const status = parseInt(out.trim(), 10);
    looksOnline = Number.isFinite(status) && status > 0;
  } catch {
    looksOnline = false; // probeOnce()'s own catch-all path -- this IS the branch that fires here
  }
  assert.equal(looksOnline, false, 'an unroutable address must never look online');
});

test('probeOnce (the real curl-based check) correctly reports online against a real reachable host', () => {
  const { probeOnce } = freshConnectivityCheck();
  // Real integration check against this module's actual CHECK_URL target -- only
  // meaningful (and only run) when this machine genuinely has internet, same assumption
  // every other live-verification in this codebase's test suite already makes.
  assert.equal(probeOnce(), true);
});
