'use strict';

// Regression: scripts/stop.sh used to leave a stopped daemon's in-flight child (node
// local-draft.js) alive and reparented to init. With its pidfile gone nothing could kill it,
// yet the dashboard's daemon pgrep kept reporting the pipeline running, so Start returned 409
// and Stop was a no-op. stop.sh must reap such orphans, including on the "no pidfiles" path.
// Uses AGENT_MANAGER_STOP_ORPHAN_PATTERN so it never touches a real pipeline's drafts.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const STOP_SH = path.join(__dirname, '..', 'scripts', 'stop.sh');

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('stop.sh reaps an orphaned draft process when no pidfiles exist', { skip: process.platform === 'win32' }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-orphan-'));
  const marker = `orphan-fake-${process.pid}-${Date.now()}`;
  const fake = path.join(tmp, 'src', `${marker}.js`);
  fs.mkdirSync(path.dirname(fake));
  fs.writeFileSync(fake, 'setInterval(() => {}, 1000);\n');
  const child = spawn('node', [fake], { detached: true, stdio: 'ignore' });
  child.unref();
  try {
    assert.ok(alive(child.pid), 'fake orphan should be running before stop');
    const res = spawnSync('bash', [STOP_SH, '--keep-dashboard'], {
      env: { ...process.env, HOME: tmp, AGENT_MANAGER_STOP_ORPHAN_PATTERN: marker },
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /killed orphaned draft\/apply process/);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(alive(child.pid), false, 'orphan must be dead after stop.sh');
  } finally {
    try { process.kill(child.pid, 'SIGKILL'); } catch { /* already dead */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
