'use strict';
// Shell-level test of the watchdog helper with REAL fake plugin scripts. Everything lives in a temp dir: HOME, HOME_LOGS and the plugins manifest are
// all redirected there, so even a broken rule can only write inside it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HELPER = path.join(__dirname, 'run-plugin-watchdog-scripts.sh');

function setup(scripts, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpws-'));
  const plug = path.join(dir, 'plug');
  fs.mkdirSync(plug);
  fs.writeFileSync(path.join(plug, 'register.js'), 'module.exports = {};\n');
  for (const [name, body] of Object.entries(scripts)) fs.writeFileSync(path.join(plug, name), body);
  const manifest = path.join(dir, 'plugins.json');
  fs.writeFileSync(manifest, JSON.stringify([{ name: 'demo', registerPath: path.join(plug, 'register.js'), enabled: true, watchdogScripts: Object.keys(scripts) }]));
  const logs = path.join(dir, 'logs');
  fs.mkdirSync(logs);
  const env = { ...process.env, HOME: dir, HOME_LOGS: logs, AGENT_MANAGER_PLUGINS_MANIFEST: manifest, AGENT_MANAGER_PLUGIN_WATCHDOG_TIMEOUT_SECS: '1', ...extraEnv };
  return { dir, logs, run: () => spawnSync('bash', [HELPER], { env, encoding: 'utf8', timeout: 30000 }) };
}

test('runs each script, logs its first stdout line only, and exits 0', () => {
  const s = setup({ 'a.js': "console.log('idle');console.log('second line');", 'b.js': "console.log('sweep started');" });
  const r = s.run();
  assert.equal(r.status, 0);
  assert.match(r.stderr, /\[watchdog\] demo:a\.js: idle\n/);
  assert.match(r.stderr, /\[watchdog\] demo:b\.js: sweep started\n/);
  assert.doesNotMatch(r.stderr, /second line/);
});

test('a script that exits 1 and one that outlives the timeout are each logged once and the next script still runs', () => {
  const s = setup({
    '1-bad.js': 'process.exit(1);',
    '2-slow.js': 'setTimeout(() => console.log("late"), 8000);',
    '3-ok.js': "console.log('still ran');",
  });
  const t0 = Date.now();
  const r = s.run();
  assert.equal(r.status, 0);
  assert.match(r.stderr, /demo:1-bad\.js: exit 1\n/);
  assert.match(r.stderr, /demo:2-slow\.js: timed out after 1s\n/);
  assert.match(r.stderr, /demo:3-ok\.js: still ran\n/);
  assert.ok(Date.now() - t0 < 7000, 'the timeout cut the slow script short');
  assert.doesNotMatch(r.stderr, /late/);
});

test('a script that reads stdin cannot swallow the rest of the list', () => {
  const s = setup({ '1-reads.js': "process.stdin.resume();process.stdin.on('data',()=>{});process.stdin.on('end',()=>console.log('read done'));", '2-next.js': "console.log('next ran');" });
  const r = s.run();
  assert.match(r.stderr, /demo:2-next\.js: next ran\n/);
});

test("a script's stderr goes to its per-plugin log, not the tick output", () => {
  const s = setup({ 'a.js': "console.error('trouble here');console.log('ok');" });
  const r = s.run();
  assert.doesNotMatch(r.stderr, /trouble here/);
  assert.match(fs.readFileSync(path.join(s.logs, 'watchdog-plugin-demo.log'), 'utf8'), /trouble here/);
});

test('the kill switch runs nothing', () => {
  const s = setup({ 'a.js': "console.log('should not run');" }, { AGENT_MANAGER_PLUGIN_WATCHDOG_SCRIPTS: 'off' });
  const r = s.run();
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
});

test('an empty manifest runs nothing and prints nothing', () => {
  const s = setup({});
  fs.writeFileSync(path.join(s.dir, 'plugins.json'), '[]');
  const r = s.run();
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
});
