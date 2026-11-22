'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HELPER = path.join(__dirname, 'lib', 'start-singleton-bg.sh');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'singleton-bg-'));
}

// Runs a bash script that sources the real helper; returns { status, stdout, stderr, ms }.
function runBash(script, env = {}) {
  const t0 = Date.now();
  const r = spawnSync('bash', ['-c', `source "${HELPER}"\n${script}`], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - t0 };
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleepMs(50);
  }
  return false;
}

const STUB = (out) => `sh -c 'echo started-$$ >> "${out}"; sleep 2; echo finished >> "${out}"'`;

test('two back-to-back starts on one lockfile run the command exactly once, and both calls return at once', async () => {
  const dir = tmp();
  const out = path.join(dir, 'out.txt');
  const r = runBash(`start_singleton_bg "${dir}/l.lock" "${dir}/log.txt" ${STUB(out)}\nstart_singleton_bg "${dir}/l.lock" "${dir}/log.txt" ${STUB(out)}`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '', 'the helper must print nothing to stdout');
  assert.ok(r.ms < 1500, `both calls must return well under the stub's 2 s runtime, took ${r.ms} ms`);
  assert.ok(await waitFor(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8').includes('started-')));
  await sleepMs(300);
  const started = fs.readFileSync(out, 'utf8').split('\n').filter((l) => l.startsWith('started-'));
  assert.equal(started.length, 1, `exactly one copy may run, saw: ${started.join(',')}`);
  assert.ok(await waitFor(() => fs.readFileSync(out, 'utf8').includes('finished'), 6000));
});

test('once the first copy has exited, the next start runs again', async () => {
  const dir = tmp();
  const out = path.join(dir, 'out.txt');
  const quick = `sh -c 'echo run-$$ >> "${out}"'`;
  runBash(`start_singleton_bg "${dir}/l.lock" "${dir}/log.txt" ${quick}`);
  assert.ok(await waitFor(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).length === 1));
  await sleepMs(200);
  runBash(`start_singleton_bg "${dir}/l.lock" "${dir}/log.txt" ${quick}`);
  assert.ok(await waitFor(() => fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).length === 2), 'the lock must be free again after the first copy exits');
});

test("the command's stdout and stderr are appended to the log file", async () => {
  const dir = tmp();
  const log = path.join(dir, 'log.txt');
  fs.writeFileSync(log, 'earlier line\n');
  runBash(`start_singleton_bg "${dir}/l.lock" "${log}" sh -c 'echo to-stdout; echo to-stderr >&2'`);
  assert.ok(await waitFor(() => /to-stderr/.test(fs.readFileSync(log, 'utf8')) && /to-stdout/.test(fs.readFileSync(log, 'utf8'))));
  assert.match(fs.readFileSync(log, 'utf8'), /^earlier line\n/, 'existing log content must be kept, not truncated');
});

test('a held lock makes the call a silent no-op even for a different command', async () => {
  const dir = tmp();
  const out = path.join(dir, 'out.txt');
  runBash(`start_singleton_bg "${dir}/l.lock" "${dir}/log.txt" ${STUB(out)}`);
  assert.ok(await waitFor(() => fs.existsSync(out)));
  const other = path.join(dir, 'other.txt');
  const r = runBash(`start_singleton_bg "${dir}/l.lock" "${dir}/log.txt" sh -c 'echo ran > "${other}"'`);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  await sleepMs(500);
  assert.equal(fs.existsSync(other), false, 'the second command must not run while the lock is held');
  assert.ok(await waitFor(() => fs.readFileSync(out, 'utf8').includes('finished'), 6000));
});
