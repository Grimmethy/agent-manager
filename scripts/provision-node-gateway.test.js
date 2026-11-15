'use strict';
// Tests for scripts/provision-node-gateway.sh (multi-node plan, piece 8c): a fake cloud-providers directory in a temp dir, the script run with spawnSync.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'provision-node-gateway.sh');
const FORBIDDEN = ['ANTHROPIC_API_KEY', 'CLOUD_SUBSCRIPTION_CONFIRMED', 'CLAUDE_CODE_OAUTH_TOKEN'];

function tmp() { return fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'prov-gateway-'))); }
function makeGateway(root) {
  const dir = path.join(root, 'cloud-providers');
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'run.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'bin', 'cloud-providers.js'), '// fake\n');
  return dir;
}
function run(args) { return spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' }); }

test('writes the unit with the exact lines and no secret or confirmation', () => {
  const root = tmp();
  const gateway = makeGateway(root);
  const units = path.join(root, 'units');
  const r = run([gateway, units]);
  assert.equal(r.status, 0, r.stderr);
  const unit = fs.readFileSync(path.join(units, 'am-cloud-gateway.service'), 'utf8');
  assert.equal(unit, [
    '[Unit]', 'Description=Agent Manager cloud-providers gateway (loopback only)', '',
    '[Service]', `WorkingDirectory=${gateway}`, 'Environment=CLOUD_PROVIDERS_PORT=7450', 'Environment=CLOUD_PROVIDER=claude-subscription',
    `ExecStart=${gateway}/run.sh`, 'Restart=on-failure', 'Nice=10', '', '[Install]', 'WantedBy=default.target', '',
  ].join('\n'));
  for (const word of FORBIDDEN) assert.equal(unit.includes(word), false, `the unit must not contain ${word}`);
  assert.equal(/\bKEY\b|PASSWORD|SECRET/i.test(unit), false);
});

test('the confirmation exists only as an .example template that systemd does not read', () => {
  const root = tmp();
  const units = path.join(root, 'units');
  assert.equal(run([makeGateway(root), units]).status, 0);
  assert.deepEqual(fs.readdirSync(units).sort(), ['am-cloud-gateway.confirm-subscription.conf.example', 'am-cloud-gateway.service']);
  const template = fs.readFileSync(path.join(units, 'am-cloud-gateway.confirm-subscription.conf.example'), 'utf8');
  assert.match(template, /^\[Service\]$/m);
  assert.match(template, /^Environment=CLOUD_SUBSCRIPTION_CONFIRMED=1$/m);
  assert.match(template, /explicit confirmation/);
  assert.match(template, /consumer terms/);
  assert.equal(template.includes('ANTHROPIC_API_KEY') || template.includes('CLAUDE_CODE_OAUTH_TOKEN'), false);
});

test('a second run writes identical bytes and the port argument is used', () => {
  const root = tmp();
  const gateway = makeGateway(root);
  const units = path.join(root, 'units');
  assert.equal(run([gateway, units, '7461']).status, 0);
  const before = fs.readdirSync(units).map((f) => fs.readFileSync(path.join(units, f), 'utf8'));
  assert.match(before.join('\n'), /Environment=CLOUD_PROVIDERS_PORT=7461/);
  const again = run([gateway + '/', units, '7461']);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(fs.readdirSync(units).map((f) => fs.readFileSync(path.join(units, f), 'utf8')), before);
});

test('the output says nothing was enabled or started and names the owner steps', () => {
  const root = tmp();
  const r = run([makeGateway(root), path.join(root, 'units')]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Nothing was enabled or started/);
  assert.match(r.stdout, /confirmation was NOT given/);
  assert.match(r.stdout, /claude auth login/);
});

test('port edge cases: 1024 and 65535 are accepted, 1023, 65536, abc, empty and a negative number are refused', () => {
  const root = tmp();
  const gateway = makeGateway(root);
  for (const ok of ['1024', '65535', '08080']) {
    const units = path.join(root, `ok-${ok}`);
    assert.equal(run([gateway, units, ok]).status, 0, `port ${ok}`);
  }
  assert.match(fs.readFileSync(path.join(root, 'ok-08080', 'am-cloud-gateway.service'), 'utf8'), /CLOUD_PROVIDERS_PORT=8080\n/);
  for (const bad of ['1023', '65536', 'abc', '', '-1', '80.5', '7450 ']) {
    const units = path.join(root, `bad-${bad.replace(/\W/g, '_') || 'empty'}`);
    const r = run([gateway, units, bad]);
    assert.equal(r.status, 2, `port ${JSON.stringify(bad)}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /the port must be an integer from 1024 to 65535/);
    assert.equal(fs.existsSync(units), false);
  }
});

test('refusals exit 2 and write nothing', () => {
  const root = tmp();
  const gateway = makeGateway(root);
  const noRun = path.join(root, 'no-run');
  fs.mkdirSync(path.join(noRun, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(noRun, 'bin', 'cloud-providers.js'), '//\n');
  const notExecutable = path.join(root, 'not-exec');
  fs.mkdirSync(path.join(notExecutable, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(notExecutable, 'run.sh'), 'x\n', { mode: 0o644 });
  fs.writeFileSync(path.join(notExecutable, 'bin', 'cloud-providers.js'), '//\n');
  const noBin = path.join(root, 'no-bin');
  fs.mkdirSync(noBin);
  fs.writeFileSync(path.join(noBin, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
  const units = path.join(root, 'units');
  const cases = [
    [[], /usage/], [[gateway], /usage/], [[gateway, units, '7450', 'extra'], /usage/],
    [['relative/dir', units], /absolute path/], [[gateway, 'relative-units'], /absolute path/], [[`${gateway}$(touch ${root}/evil)`, units], /absolute path/],
    [[gateway, `${units} with space`], /absolute path/], [[path.join(root, 'missing'), units], /no executable run\.sh/],
    [[noRun, units], /no executable run\.sh/], [[notExecutable, units], /no executable run\.sh/], [[noBin, units], /no bin\/cloud-providers\.js/],
  ];
  for (const [args, message] of cases) {
    const r = run(args);
    assert.equal(r.status, 2, `args ${JSON.stringify(args)}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, message);
    assert.match(r.stderr, /provision-node-gateway:/);
  }
  assert.equal(fs.existsSync(units), false, 'a refused call creates no unit directory');
  assert.equal(fs.existsSync(path.join(root, 'evil')), false);
});
