'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'src', 'requeue-attribution.js');

// Runs the classify CLI on a payload file with a throwaway pipeline dir.
function runCli(payloadText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-cli-'));
  const payloadPath = path.join(dir, 'payload.json');
  fs.writeFileSync(payloadPath, payloadText);
  return spawnSync(process.execPath, [CLI, 'classify', payloadPath], {
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, AGENT_MANAGER_PIPELINE_DIR: dir },
  });
}

test('valid payload prints a JSON result to stdout and exits 0', () => {
  const r = runCli(JSON.stringify({
    task: { id: 'CLI-TEST-1' },
    reasonHint: 'some requeue reason',
    requeueWriter: 'operator-manual',
    actor: 'operator-manual',
  }));
  assert.strictEqual(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.strictEqual(typeof parsed.signature, 'string');
});

test('missing taskFile exits nonzero with empty stdout and a stderr message', () => {
  const missing = path.join(os.tmpdir(), `ra-cli-missing-${process.pid}-${Date.now()}.json`);
  const r = runCli(JSON.stringify({ taskFile: missing, reasonHint: 'x' }));
  assert.notStrictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
  assert.match(r.stderr, /taskFile not found/);
});

test('invalid JSON payload exits nonzero with a stderr message', () => {
  const r = runCli('not json{');
  assert.notStrictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
  assert.ok(r.stderr.length > 0);
});
