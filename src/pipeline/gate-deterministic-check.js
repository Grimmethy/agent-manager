'use strict';

// Deterministic review gate (2026-09-14, HUB0137). Replaces the LLM's "does the draft
// actually cover this case, and does the named test pass" judgment with two cheap,
// reproducible facts:
//   1. The draft file literally contains the test name (substring search, no shell-out --
//      locale/escaping independent and deterministic).
//   2. `node --test <testFile>` exits 0 under a controlled child environment.
//
// Precedent: src/scoped-test-runner.js (same `node --test` + execFileSync shape, same
// NODE_TEST_CONTEXT hazard) and src/acceptance-command-gate.js (same execFileSync import
// discipline). This module intentionally keeps the required three-argument signature and
// adds only a minimal opts bag (timeout/cwd override) so the integration stage (HUB0137
// 3/3) has a seam to tune the timeout.

const fs = require('fs');
const { execFileSync } = require('child_process');

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Gate a review on two deterministic facts: the draft names the test, and that test passes.
 *
 * @param {string} draftPath    Path to the draft file to search for the test name.
 * @param {string} testFilePath Path to the test file to run with `node --test`.
 * @param {string} testName     The exact test name that must appear in the draft.
 * @param {object} [opts]
 * @param {number} [opts.timeout] Timeout (ms) for the `node --test` invocation (default 30_000).
 * @param {string} [opts.cwd]     Working directory the test file is resolved/run against
 *                                (default process.cwd()).
 * @returns {{ approved: boolean,
 *             reason: 'test-passed' | 'test-name-not-found' | 'test-failed' }}
 *   - `{ approved: false, reason: 'test-name-not-found' }` -- draft missing/unreadable, or
 *     does not contain `testName`. The test is NOT run in this case.
 *   - `{ approved: false, reason: 'test-failed' }` -- draft names the test but the test
 *     run fails (non-zero exit) or times out (a test that didn't finish is a failed test).
 *   - `{ approved: true, reason: 'test-passed' }` -- both checks pass.
 */
function gateDeterministicCheck(draftPath, testFilePath, testName, opts = {}) {
  const { timeout = DEFAULT_TIMEOUT_MS, cwd = process.cwd() } = opts;

  // (1) Name-presence: a plain substring search on the draft itself. A missing or
  //     unreadable draft is "name not found", never a crash -- this is a gate, and a gate
  //     that throws is strictly worse than one that rejects. An empty name is a false
  //     positive (String.prototype.includes('') is always true), so it is rejected too.
  let nameFound = false;
  if (typeof testName === 'string' && testName.length > 0) {
    try {
      nameFound = fs.readFileSync(draftPath, 'utf8').includes(testName);
    } catch {
      nameFound = false;
    }
  }
  if (!nameFound) return { approved: false, reason: 'test-name-not-found' };

  // (2) Run the named test file. CRITICAL: strip NODE_TEST_CONTEXT (and the rest of the
  //     NODE_TEST_* family) from the child environment. A child `node --test` that inherits
  //     NODE_TEST_CONTEXT believes it is a worker reporting results to a parent runner over
  //     IPC and exits 0 REGARDLESS of whether its own tests pass -- the exact way a gate can
  //     silently produce a false "passed" for a test that fails every time (see
  //     src/scoped-test-runner.js). A timed-out run is a failed run from the gate's view.
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  for (const k of Object.keys(childEnv)) {
    if (k.startsWith('NODE_TEST_')) delete childEnv[k];
  }

  try {
    execFileSync('node', ['--test', testFilePath], {
      cwd,
      timeout,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv,
    });
  } catch {
    return { approved: false, reason: 'test-failed' };
  }

  return { approved: true, reason: 'test-passed' };
}

module.exports = { gateDeterministicCheck, DEFAULT_TIMEOUT_MS };
