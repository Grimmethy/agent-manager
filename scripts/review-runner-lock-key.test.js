'use strict';

// One role per cycle per lane: a review and a worker draft on the SAME Ollama endpoint must exclude each other.
//
// Worker drafts lock through src/gpu-arbiter.js -> src/single-flight-lock.js keyed by localOllamaLockKey() (`ollama-<host>-<port>`). The review daemon used to lock
// with acquire_single_flight_lock "$LOCAL_MODEL": a different key -> a different lockfile for the same GPU, so the two never excluded each other (2026-10-21,
// worker-p40 + reviewer-p40 on the P40 VM, llama-server OOM-killed). These tests run the REAL shipped review_lock_key (extracted from review-runner.sh) and the REAL
// acquire_single_flight_lock against a lock held by the JS side, so they fail if the review goes back to the model-name key.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SRC = path.join(__dirname, '..', 'src');
const COMMON_SH = path.join(__dirname, 'agent-manager-common.sh');
const RUNNER_SH = path.join(__dirname, 'review-runner.sh');
const sfl = require(path.join(SRC, 'single-flight-lock.js'));
const { localOllamaLockKey } = require(path.join(SRC, 'lib', 'ollama-lock-key.js'));

const P40_URL = 'http://192.168.122.29:11434';
const MODEL = 'qwen3.8-p40:27b-q4_K_M';

// The shipped function text, so the test exercises the real thing and not a copy.
function reviewLockKeyFn() {
  const m = fs.readFileSync(RUNNER_SH, 'utf8').match(/^review_lock_key\(\) \{[\s\S]*?^\}/m);
  assert.ok(m, 'review_lock_key() must exist in review-runner.sh');
  return m[0];
}

function bash(script, env) {
  return spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 30000, env: { ...process.env, ...env } });
}

function keyFromRunner(env) {
  const r = bash([`PACKAGE_SRC_DIR=${JSON.stringify(SRC)}`, reviewLockKeyFn(), 'review_lock_key'].join('\n'), env);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

function acquireFromBash(instancesDir, key, timeoutSecs) {
  const script = [
    'set -u',
    `INSTANCES_DIR=${JSON.stringify(instancesDir)}`,
    `source ${JSON.stringify(COMMON_SH)}`,
    `acquire_single_flight_lock ${JSON.stringify(key)} skip; echo "rc=$?"`,
  ].join('\n');
  return bash(script, { SINGLE_FLIGHT_LOCK_TIMEOUT_SECS: String(timeoutSecs) }).stdout;
}

test('the review daemon locks on the same endpoint key the worker drafts use', () => {
  assert.equal(keyFromRunner({ OLLAMA_URL: P40_URL, LOCAL_MODEL: MODEL }), localOllamaLockKey({ OLLAMA_URL: P40_URL }));
  assert.equal(keyFromRunner({ OLLAMA_URL: P40_URL, LOCAL_MODEL: MODEL }), 'ollama-192.168.122.29-11434');
  // unset OLLAMA_URL -> the host's own Ollama, exactly as the JS side resolves it
  assert.equal(keyFromRunner({ OLLAMA_URL: '', LOCAL_MODEL: MODEL }), localOllamaLockKey({}));
});

test('review-runner.sh takes the lock with review_lock_key, not the model name', () => {
  const src = fs.readFileSync(RUNNER_SH, 'utf8');
  assert.match(src, /acquire_single_flight_lock "\$\(review_lock_key\)"/);
  assert.doesNotMatch(src, /acquire_single_flight_lock "\$\{LOCAL_MODEL:-\}"/);
});

test('a draft holding the endpoint lock blocks a review on that endpoint, not one on another endpoint', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-lock-key-test-'));
  const draftKey = localOllamaLockKey({ OLLAMA_URL: P40_URL });
  const handle = sfl.acquire(dir, draftKey, { skipPriorityBackoff: true });
  try {
    const reviewKey = keyFromRunner({ OLLAMA_URL: P40_URL, LOCAL_MODEL: MODEL });
    assert.match(acquireFromBash(dir, reviewKey, 2), /rc=1/, 'a review on the same endpoint must wait for the draft');
    const otherKey = keyFromRunner({ OLLAMA_URL: 'http://localhost:11434', LOCAL_MODEL: 'qwen3.8:27b-q4_K_M' });
    assert.match(acquireFromBash(dir, otherKey, 2), /rc=0/, 'a different endpoint is a different GPU: no wait');
    // The old model-name key is what let the two overlap -- it takes a different lockfile for the same GPU.
    assert.match(acquireFromBash(dir, MODEL, 2), /rc=0/, 'sanity: the old model-name key never saw the draft lock');
  } finally {
    sfl.release(handle);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'review-lock-key-test-'));
  try {
    assert.match(acquireFromBash(dir2, localOllamaLockKey({ OLLAMA_URL: P40_URL }), 2), /rc=0/, 'free lock: the review proceeds');
  } finally {
    fs.rmSync(dir2, { recursive: true, force: true });
  }
});

test('review_lock_key falls back to the model name when node cannot run the helper', () => {
  const r = bash([`PACKAGE_SRC_DIR=/nonexistent`, `LOCAL_MODEL=${MODEL}`, reviewLockKeyFn(), 'review_lock_key'].join('\n'), {});
  assert.equal(r.stdout, MODEL);
});
