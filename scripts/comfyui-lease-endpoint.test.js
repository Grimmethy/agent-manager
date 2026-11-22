'use strict';

// comfyui_lease_held (agent-manager-common.sh) is the shell twin of gpu-guard.js. With an endpoint argument it must give the SAME answer as
// leaseHeldFor for every lease shape, because the worker and reviewer daemons use the shell one to yield their ticks while local-client.js uses the
// JS one to refuse a call. If they disagreed, a lane could keep ticking while its calls are refused (or the reverse). Also checks that both daemons
// pass their own lane's endpoint.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { leaseHeldFor } = require('../src/gpu-guard.js');

const COMMON = path.join(__dirname, 'agent-manager-common.sh');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-endpoint-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const P40 = 'http://192.168.122.29:11434';
const HOST = 'http://localhost:11434';
const iso = (agoS) => new Date(Date.now() - agoS * 1000).toISOString();

function leaseFile(name, body) {
  const p = path.join(tmp, `${name}.json`);
  if (body !== null) fs.writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body));
  return p;
}
// exit status of `comfyui_lease_held [endpoint]` sourced from the real script: 0 = held, 1 = not held
function shellHeld(leasePath, endpoint) {
  const args = ['-c', 'source "$1"; shift; comfyui_lease_held "$@"', 'bash', COMMON, ...(endpoint ? [endpoint] : [])];
  const r = spawnSync('bash', args, { env: { PATH: process.env.PATH, HOME: os.homedir(), AGENT_MANAGER_COMFY_LEASE_PATH: leasePath }, encoding: 'utf8' });
  assert.ok(r.status === 0 || r.status === 1, `unexpected exit ${r.status}: ${r.stderr}`);
  return r.status === 0;
}

const FRESH = { acquiredAt: iso(0), refreshedAt: iso(0) };
const CASES = {
  'unscoped (PromptForge)': { holder: 'promptforge', ...FRESH },
  'empty endpoints list': { holder: 'kaggleforge', endpoints: [], ...FRESH },
  'scoped to the P40': { holder: 'kaggleforge', endpoints: [P40], ...FRESH },
  'scoped to the host (localhost)': { holder: 'kaggleforge', endpoints: [HOST], ...FRESH },
  'scoped to both': { holder: 'kaggleforge', endpoints: [P40, HOST], ...FRESH },
  'scoped to the P40 but stale refresh': { holder: 'kaggleforge', endpoints: [P40], acquiredAt: iso(0), refreshedAt: iso(600) },
  'scoped to the P40 but past the MAX ceiling': { holder: 'kaggleforge', endpoints: [P40], acquiredAt: iso(1000), refreshedAt: iso(0) },
  'unscoped but stale': { holder: 'promptforge', acquiredAt: iso(0), refreshedAt: iso(600) },
  'malformed file': '{not json',
  'no file': null,
};
const ENDPOINTS = [P40, HOST, 'http://127.0.0.1:11434', 'http://192.168.122.29:11435', 'http://rx580:11434'];

test('shell comfyui_lease_held <endpoint> agrees with gpu-guard.js leaseHeldFor for every lease shape and endpoint', () => {
  let n = 0;
  for (const [label, body] of Object.entries(CASES)) {
    const p = leaseFile(label.replace(/\W+/g, '-'), body);
    for (const ep of ENDPOINTS) {
      assert.equal(shellHeld(p, ep), leaseHeldFor(ep, p), `${label} @ ${ep}`);
      n += 1;
    }
  }
  assert.equal(n, Object.keys(CASES).length * ENDPOINTS.length);
});

test('shell, scoped lease: held only for the leased card', () => {
  const p = leaseFile('scoped-p40', CASES['scoped to the P40']);
  assert.equal(shellHeld(p, P40), true);
  assert.equal(shellHeld(p, HOST), false);
  assert.equal(shellHeld(p, 'http://127.0.0.1:11434'), false);
});

test('shell, no endpoint argument: unchanged meaning (any fresh lease = held, scoped or not), stale and missing = not held', () => {
  assert.equal(shellHeld(leaseFile('a', CASES['unscoped (PromptForge)'])), true);
  assert.equal(shellHeld(leaseFile('b', CASES['scoped to the P40'])), true);
  assert.equal(shellHeld(leaseFile('c', CASES['unscoped but stale'])), false);
  assert.equal(shellHeld(leaseFile('d', CASES['scoped to the P40 but past the MAX ceiling'])), false);
  assert.equal(shellHeld(leaseFile('e', null)), false);
});

test('local-worker.sh and review-runner.sh pass their own lane endpoint to comfyui_lease_held', () => {
  for (const f of ['local-worker.sh', 'review-runner.sh']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    const calls = src.split('\n').filter((l) => /\bcomfyui_lease_held\b/.test(l) && /\bif\b/.test(l));
    assert.ok(calls.length >= 1, `${f} has a lease check`);
    for (const l of calls) assert.match(l, /comfyui_lease_held "\$\{OLLAMA_URL:-http:\/\/localhost:11434\}"/, `${f}: ${l.trim()}`);
  }
});
