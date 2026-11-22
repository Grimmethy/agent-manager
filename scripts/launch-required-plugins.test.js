'use strict';

// scripts/launch.sh must refuse to start the pipeline daemons when a required plugin is missing or out of range, and say so loudly (src/required-plugins.js,
// config/required-plugins.json). Runs the REAL check block of launch.sh (between its markers) against fixture plugin directories and a fixture plugins.json, and pins the
// call sites by their order in the script: the check runs before the daemon section, an unmet check skips the daemons but not the dashboard, and the script exits with the
// check's code last.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const LAUNCH = path.join(__dirname, 'launch.sh');
const SRC = fs.readFileSync(LAUNCH, 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-reqplug-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const BEGIN = '# --- required plugins (begin) ---';
const END = '# --- required plugins (end) ---';
const block = () => SRC.slice(SRC.indexOf(BEGIN), SRC.indexOf(END) + END.length);

// Runs the extracted block with REPO_DIR set to the real repository and a fixture manifest; returns the exit code of the variable and the streams.
function runBlock(manifestEntries) {
  const manifest = path.join(tmp, `plugins-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(manifest, JSON.stringify(manifestEntries));
  const script = `set -u\nREPO_DIR=${JSON.stringify(REPO)}\n${block()}\necho "RC=$_REQUIRED_PLUGINS_RC"\n`;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: os.homedir(), AGENT_MANAGER_PLUGINS_MANIFEST: manifest } });
  return { rc: Number((/RC=(\d+)/.exec(r.stdout) || [])[1]), stdout: r.stdout, stderr: r.stderr, status: r.status };
}

function hubTasks(version) {
  const dir = path.join(tmp, `hub-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  if (version !== null) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'agent-manager-hub-tasks', version }));
  fs.writeFileSync(path.join(dir, 'register.js'), '// plugin\n');
  return [{ name: 'agent-manager-hub-tasks', registerPath: path.join(dir, 'register.js'), enabled: true }];
}

test('the real block: a met required set leaves the code 0 and prints no error', () => {
  const r = runBlock(hubTasks('0.1.7'));
  assert.equal(r.rc, 0, r.stderr);
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stderr, /ERROR/);
  assert.equal(r.stderr, '', 'nothing on stderr when every required plugin is met');
  assert.match(r.stdout, /ok +agent-manager-hub-tasks 0\.1\.7 satisfies \^0\.1\.0/);
});

test('the real block: a missing, disabled, out-of-range or versionless plugin leaves code 3 and a loud error on stderr', () => {
  const cases = [[[], /\[MISSING\] agent-manager-hub-tasks/], [[{ ...hubTasks('0.1.0')[0], enabled: false }], /\[MISSING\]/], [hubTasks('0.3.0'), /\[OUT_OF_RANGE\] agent-manager-hub-tasks: version 0\.3\.0 is outside \^0\.1\.0/], [hubTasks(null), /\[NO_VERSION\]/]];
  for (const [entries, re] of cases) {
    const r = runBlock(entries);
    assert.equal(r.rc, 3, JSON.stringify(entries));
    assert.equal(r.status, 0, 'the block itself must not abort the script: launch.sh decides what to skip');
    assert.match(r.stderr, /\[required-plugins\] ERROR: 1 required plugin\(s\) unmet/);
    assert.match(r.stderr, re);
    assert.match(r.stdout, /MISSING|OUT_OF_RANGE|NO_VERSION/, 'the status line goes to stdout, the loud failure text to stderr');
  }
});

test('call sites: the check comes before the daemon section, an unmet check skips only the daemons, and the script exits with the check code last', () => {
  assert.doesNotThrow(() => { const r = spawnSync('bash', ['-n', LAUNCH], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); });
  const at = (s) => { const i = SRC.indexOf(s); assert.ok(i >= 0, `launch.sh has no: ${s}`); return i; };
  const check = at(BEGIN);
  const guard = at('if [[ "$_REQUIRED_PLUGINS_RC" -ne 0 ]]; then');
  const daemons = at('elif [[ -n "${AGENT_MANAGER_REPO_ROOT:-}" && -d "${AGENT_MANAGER_REPO_ROOT}" ]]; then');
  const dashboard = at('DASHBOARD_PIDFILE="${PID_DIR}/dashboard.pid"');
  const exitLine = at('exit "$_REQUIRED_PLUGINS_RC"');
  assert.ok(check < guard && guard < daemons && daemons < dashboard && dashboard < exitLine, 'order: check, guard, daemon section, dashboard start, exit');
  assert.match(SRC.slice(guard, daemons), /NOT started/);
  assert.ok(SRC.indexOf('_REQUIRED_PLUGINS_RC=0') > check, 'the code is initialised inside the block');
  assert.equal(SRC.trimEnd().split('\n').pop(), 'exit "$_REQUIRED_PLUGINS_RC"');
});
