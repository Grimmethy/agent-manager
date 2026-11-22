'use strict';
// Unit-file and installer checks for the crash-recovery units. The installer runs only into a temp directory.
// scripts/crash-recover.js is never required or executed here.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SYSTEMD = path.join(__dirname, 'systemd');
const INSTALLER = path.join(__dirname, 'install-crash-recovery.sh');
const CRASH = 'agent-manager-crash-recover.service';
const DASH = 'agent-manager-dashboard.service';

function unit(name) {
  return fs.readFileSync(path.join(SYSTEMD, name), 'utf8');
}

function keys(text) {
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('['));
}

function runInstaller(dest) {
  return spawnSync('bash', [INSTALLER, dest], { encoding: 'utf8' });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'crash-units-'));
}

test('crash-recover unit is a oneshot ordered after network-online with no Restart=', () => {
  const k = keys(unit(CRASH));
  assert.ok(k.includes('Type=oneshot'));
  assert.ok(k.includes('After=network-online.target'));
  assert.ok(k.includes('Wants=network-online.target'));
  assert.ok(k.includes('ExecStart=/usr/bin/env node scripts/crash-recover.js'));
  assert.ok(!k.some((l) => l.startsWith('Restart=')));
});

test('dashboard user unit restarts always, orders after network-online, no tailscaled dependency', () => {
  const text = unit(DASH);
  const k = keys(text);
  assert.ok(k.includes('Restart=always'));
  assert.ok(k.includes('After=network-online.target'));
  assert.ok(k.includes('Wants=network-online.target'));
  assert.ok(k.some((l) => l.startsWith('ExecStart=') && l.includes('python/dashboard/app.py')));
  assert.ok(!text.includes('tailscaled.service'));
});

test('no am-node-registry drop-in is created (no base unit in repo)', () => {
  assert.ok(!fs.existsSync(path.join(SYSTEMD, 'am-node-registry.service.d')));
});

test('installer copies both units with @REPO@ rendered, prints commands, enables nothing', () => {
  const dest = tempDir();
  const r = runInstaller(dest);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(dest, CRASH)));
  assert.ok(fs.existsSync(path.join(dest, DASH)));
  assert.ok(!fs.readFileSync(path.join(dest, CRASH), 'utf8').includes('@REPO@'));
  assert.doesNotMatch(r.stdout, /am-node-registry/);
  const last = r.stdout.trimEnd().split('\n').pop();
  assert.strictEqual(last, 'Nothing was enabled or started');
});

test('a differing dashboard copy does not stop the crash-recover copy', () => {
  const dest = tempDir();
  fs.writeFileSync(path.join(dest, DASH), 'old owner copy\n');
  const r = runInstaller(dest);
  assert.strictEqual(r.status, 3);
  assert.ok(fs.existsSync(path.join(dest, CRASH)));
  assert.match(r.stdout, /differs \(not overwritten\) .*agent-manager-dashboard/);
  assert.strictEqual(fs.readFileSync(path.join(dest, DASH), 'utf8'), 'old owner copy\n');
});
