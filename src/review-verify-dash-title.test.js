'use strict';
// Regression: a diff-added test title that starts with two dashes must not break the narrowed node --test run.
// The two-argument form (--test-name-pattern, <pattern>) exits 9; the equals form runs the test. review-verify.js uses the equals form.
// Kept in its own file so src/review-verify.test.js does not grow past its size-ratchet cap.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DASH_TITLE = '--once on a switched-off worker';
const PLAIN_TITLE = 'an ordinary title';

// Strip NODE_TEST_CONTEXT: a nested node --test under the outer runner otherwise prints nothing to stdout.
function childEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function withTempTest(title, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-verify-dash-'));
  try {
    const file = path.join(dir, 'tmp-title.test.js');
    fs.writeFileSync(file, "const test = require('node:test');\ntest(" + JSON.stringify(title) + ", () => {});\n");
    return fn(dir, file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runFiltered(title, dir, file) {
  return spawnSync(process.execPath, ['--test', '--test-name-pattern=' + title, file], { cwd: dir, encoding: 'utf8', env: childEnv() });
}

test('a dash-title test runs under the equals-form --test-name-pattern', () => {
  withTempTest(DASH_TITLE, (dir, file) => {
    const r = runFiltered(DASH_TITLE, dir, file);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /# pass 1/);
  });
});

test('an ordinary title still works under the equals-form --test-name-pattern', () => {
  withTempTest(PLAIN_TITLE, (dir, file) => {
    const r = runFiltered(PLAIN_TITLE, dir, file);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /# pass 1/);
  });
});

test('review-verify.js builds the node --test filter in the equals form and not the two-element pair', () => {
  const src = fs.readFileSync(path.join(__dirname, 'review-verify.js'), 'utf8');
  assert.equal(src.includes("'--test-name-pattern', pattern"), false);
  assert.equal(src.includes('--test-name-pattern=${pattern}'), true);
});
