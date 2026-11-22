'use strict';

// scripts/queue-watcher.sh checks the required plugins (config/required-plugins.json, src/required-plugins.js) on every tick and writes each unmet one to its log as a loud, readable
// error. Runs the REAL block of the script (between its markers) against fixture plugin directories and a fixture plugins.json, and pins where the block sits: inside the tick
// loop and before the hub-tasks sweeps.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SRC_DIR = path.join(__dirname, '..', 'src');
const WATCHER = path.join(__dirname, 'queue-watcher.sh');
const TEXT = fs.readFileSync(WATCHER, 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-reqplug-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const BEGIN = '# --- required plugins (begin) ---';
const END = '# --- required plugins (end) ---';
const block = () => TEXT.slice(TEXT.indexOf(BEGIN), TEXT.indexOf(END) + END.length);

// The extracted block under the strictest shell options the script could ever use, then a marker proving the script would carry on.
function runBlock(entries) {
  const manifest = path.join(tmp, `plugins-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(manifest, JSON.stringify(entries));
  const script = `set -eu\nPACKAGE_SRC_DIR=${JSON.stringify(SRC_DIR)}\n${block()}\necho CARRIED_ON\n`;
  return spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: os.homedir(), AGENT_MANAGER_PLUGINS_MANIFEST: manifest } });
}

function hubTasks(version, enabled = true) {
  const dir = path.join(tmp, `hub-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  if (version !== null) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'agent-manager-hub-tasks', version }));
  fs.writeFileSync(path.join(dir, 'register.js'), '// plugin\n');
  return [{ name: 'agent-manager-hub-tasks', registerPath: path.join(dir, 'register.js'), enabled }];
}

test('the real block: a met required set writes nothing to either stream and the script carries on', () => {
  const r = runBlock(hubTasks('0.1.4'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'CARRIED_ON');
  assert.equal(r.stderr, '');
});

test('the real block: a missing, disabled, out-of-range or versionless plugin gives a loud [watchdog] error naming the problem, and the script still carries on', () => {
  const cases = [[[], /\[MISSING\] agent-manager-hub-tasks/], [hubTasks('0.1.0', false), /\[MISSING\]/], [hubTasks('0.3.0'), /\[OUT_OF_RANGE\] agent-manager-hub-tasks: version 0\.3\.0 is outside \^0\.1\.0/], [hubTasks(null), /\[NO_VERSION\]/]];
  for (const [entries, re] of cases) {
    const r = runBlock(entries);
    assert.equal(r.status, 0, 'a tick must not abort when a plugin is unmet');
    assert.equal(r.stdout.trim(), 'CARRIED_ON', 'the status lines are dropped, only the failure text is kept');
    assert.match(r.stderr, /^\[watchdog\] \[required-plugins\] ERROR: 1 required plugin\(s\) unmet/);
    assert.match(r.stderr, re);
  }
});

test('call site: the block sits inside the tick loop, before the hub-tasks sweeps, and the markers are unique', () => {
  assert.doesNotThrow(() => { const r = spawnSync('bash', ['-n', WATCHER], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); });
  assert.equal(TEXT.split(BEGIN).length, 2);
  assert.equal(TEXT.split(END).length, 2);
  const loop = TEXT.indexOf('\nwhile :; do');
  const begin = TEXT.indexOf(BEGIN);
  const hub = TEXT.indexOf('_hub_tasks_root="$(resolve_plugin_root "agent-manager-hub-tasks")"');
  assert.ok(loop >= 0 && hub >= 0, 'the script still has its tick loop and the hub-tasks resolution');
  assert.ok(loop < begin && begin < hub, 'order: tick loop, required plugins block, hub-tasks sweeps');
});
