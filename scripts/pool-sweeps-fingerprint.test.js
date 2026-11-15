'use strict';

// pool-sweeps.sh skips a project's whole pass when the queue stages housekeeping acts on did not change since its last pass, but still sweeps at least every
// AGENT_MANAGER_POOL_SWEEP_MAX_IDLE_SECS (CPU analysis 2026-11-07: 39 of 42 pool projects counted as active, half unchanged for hours, each paying ~23 node starts per interval).
// Run for real in a sandbox: a private copy of the script beside stub sweeps (src/*.js that print one line), a throwaway pipeline dir and a private HOME.
// Run: node --test scripts/pool-sweeps-fingerprint.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REAL = path.join(__dirname, 'pool-sweeps.sh');
const SWEEPS = ['reject-retry-check', 'apply-retry-check', 'expiry-sweep', 'blocked-cluster-sweep', 'merged-work-sweep'];

function sandbox(extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-fp-'));
  const mk = (...p) => { const d = path.join(root, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
  const scripts = mk('repo', 'scripts');
  const src = mk('repo', 'src');
  fs.copyFileSync(REAL, path.join(scripts, 'pool-sweeps.sh'));
  for (const s of SWEEPS) fs.writeFileSync(path.join(src, `${s}.js`), "console.log('stub ran')\n");
  for (const s of ['done-archive', 'reclaim-orphaned-drafts', 'resolve-plugin-root']) fs.writeFileSync(path.join(src, `${s}.js`), '');
  const pipe = mk('pipe');
  for (const d of ['blocked', 'needs-clarification', 'coordinating', 'awaiting-confirm', 'approved', 'review', 'drafting', 'instances']) mk('pipe', d === 'instances' ? 'instances' : path.join('queue', d));
  mk('home');
  const env = {
    ...process.env, HOME: path.join(root, 'home'), HOME_LOGS: path.join(root, 'logs'),
    AGENT_MANAGER_BORROWING_FROM: 'sandbox', AGENT_MANAGER_PIPELINE_DIR: pipe, AGENT_MANAGER_POOL_SWEEP_INTERVAL_SECS: '0',
    ...extraEnv,
  };
  delete env.POOL_SWEEPS_FORCE;
  const run = (over = {}) => {
    const r = spawnSync('bash', [path.join(scripts, 'pool-sweeps.sh')], { encoding: 'utf8', env: { ...env, ...over }, timeout: 120000 });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.split('\n').filter((l) => l.includes('stub ran')).length;
  };
  const put = (stage, name, body = '{}') => fs.writeFileSync(path.join(pipe, 'queue', stage, name), body);
  const stamp = path.join(pipe, 'instances', '.pool-sweeps-fingerprint');
  return { root, pipe, run, put, stamp };
}

test('an unchanged queue is swept once; the next pass is skipped and leaves the stamp alone', () => {
  const sb = sandbox();
  sb.put('blocked', 'a.json');
  assert.equal(sb.run(), SWEEPS.length);
  const first = fs.readFileSync(sb.stamp, 'utf8');
  assert.match(first, /^\d{9,}\n.*blocked\/a\.json /s);
  assert.equal(sb.run(), 0);
  assert.equal(fs.readFileSync(sb.stamp, 'utf8'), first);
});

test('a project with nothing in any stage never reaches the fingerprint (no stamp)', () => {
  const sb = sandbox();
  assert.equal(sb.run(), 0);
  assert.equal(fs.existsSync(sb.stamp), false);
});

test('an added, rewritten, removed or renamed file in any stage is swept at once', () => {
  const sb = sandbox();
  sb.put('blocked', 'a.json');
  assert.equal(sb.run(), SWEEPS.length);
  assert.equal(sb.run(), 0);
  sb.put('needs-clarification', 'b.json');
  assert.equal(sb.run(), SWEEPS.length, 'a file added to another stage');
  assert.equal(sb.run(), 0);
  sb.put('blocked', 'a.json', '{"changed":"longer body"}');
  assert.equal(sb.run(), SWEEPS.length, 'a file rewritten with another size');
  assert.equal(sb.run(), 0);
  fs.renameSync(path.join(sb.pipe, 'queue', 'blocked', 'a.json'), path.join(sb.pipe, 'queue', 'review', 'a.json'));
  assert.equal(sb.run(), SWEEPS.length, 'a file moved to another stage');
  assert.equal(sb.run(), 0);
  fs.unlinkSync(path.join(sb.pipe, 'queue', 'needs-clarification', 'b.json'));
  assert.equal(sb.run(), SWEEPS.length, 'a file removed while another stays');
  assert.equal(sb.run(), 0);
});

test('a drafting task in a lane folder counts, and the done folder, which housekeeping does not act on, does not', () => {
  const sb = sandbox();
  fs.mkdirSync(path.join(sb.pipe, 'queue', 'drafting', 'lane1'), { recursive: true });
  fs.writeFileSync(path.join(sb.pipe, 'queue', 'drafting', 'lane1', 'd.json'), '{}');
  assert.equal(sb.run(), SWEEPS.length);
  assert.equal(sb.run(), 0);
  fs.mkdirSync(path.join(sb.pipe, 'queue', 'done'), { recursive: true });
  fs.writeFileSync(path.join(sb.pipe, 'queue', 'done', 'x.json'), '{}');
  assert.equal(sb.run(), 0, 'done/ is not part of the fingerprint');
});

test('an unchanged project is still swept once the idle limit has passed; the limit is tunable and 0 turns the skip off', () => {
  const sb = sandbox();
  sb.put('blocked', 'a.json');
  assert.equal(sb.run(), SWEEPS.length);
  const body = fs.readFileSync(sb.stamp, 'utf8');
  const old = String(Math.floor(Date.now() / 1000) - 1900);
  fs.writeFileSync(sb.stamp, old + body.slice(body.indexOf('\n')));
  assert.equal(sb.run(), SWEEPS.length, 'last pass 1900 s ago, default limit 1800');
  assert.equal(sb.run(), 0);
  const recent = String(Math.floor(Date.now() / 1000) - 100);
  fs.writeFileSync(sb.stamp, recent + fs.readFileSync(sb.stamp, 'utf8').slice(fs.readFileSync(sb.stamp, 'utf8').indexOf('\n')));
  assert.equal(sb.run({ AGENT_MANAGER_POOL_SWEEP_MAX_IDLE_SECS: '50' }), SWEEPS.length, 'last pass 100 s ago, limit 50');
  assert.equal(sb.run({ AGENT_MANAGER_POOL_SWEEP_MAX_IDLE_SECS: '0' }), SWEEPS.length, '0 = every pass');
  assert.equal(sb.run({ AGENT_MANAGER_POOL_SWEEP_MAX_IDLE_SECS: 'soon' }), 0, 'a bad value falls back to 1800');
});

test('a rewrite that keeps the size but changes the modification time is swept', () => {
  const sb = sandbox();
  sb.put('blocked', 'a.json', '{"x":1}');
  assert.equal(sb.run(), SWEEPS.length);
  assert.equal(sb.run(), 0);
  const f = path.join(sb.pipe, 'queue', 'blocked', 'a.json');
  fs.writeFileSync(f, '{"x":2}');
  const t = (Date.now() / 1000) + 5;
  fs.utimesSync(f, t, t);
  assert.equal(sb.run(), SWEEPS.length);
});

test('a rewrite with another size but the same modification time is swept', () => {
  const sb = sandbox();
  sb.put('blocked', 'a.json', '{"x":1}');
  const f = path.join(sb.pipe, 'queue', 'blocked', 'a.json');
  const st = fs.statSync(f);
  assert.equal(sb.run(), SWEEPS.length);
  assert.equal(sb.run(), 0);
  fs.writeFileSync(f, '{"x":1,"more":"text"}');
  fs.utimesSync(f, st.atime, st.mtime);
  assert.equal(sb.run(), SWEEPS.length);
});

test('a stamp dated in the future does not skip passes', () => {
  const sb = sandbox();
  sb.put('blocked', 'a.json');
  assert.equal(sb.run(), SWEEPS.length);
  const body = fs.readFileSync(sb.stamp, 'utf8');
  fs.writeFileSync(sb.stamp, String(Math.floor(Date.now() / 1000) + 86400) + body.slice(body.indexOf('\n')));
  assert.equal(sb.run(), SWEEPS.length);
  assert.equal(sb.run(), 0, 'and the rewritten stamp skips again');
});

test('POOL_SWEEPS_FORCE sweeps an unchanged project', () => {
  const sb = sandbox();
  sb.put('blocked', 'a.json');
  assert.equal(sb.run(), SWEEPS.length);
  assert.equal(sb.run(), 0);
  assert.equal(sb.run({ POOL_SWEEPS_FORCE: 'true' }), SWEEPS.length);
});

test('a garbled or empty stamp sweeps and is rewritten', () => {
  for (const body of ['', 'soon\nnothing', '123\n']) {
    const sb = sandbox();
    sb.put('blocked', 'a.json');
    fs.writeFileSync(sb.stamp, body);
    assert.equal(sb.run(), SWEEPS.length, JSON.stringify(body));
    assert.match(fs.readFileSync(sb.stamp, 'utf8'), /^\d{9,}\n.*blocked\/a\.json /s);
  }
});

test('the stamp is per pipeline directory', () => {
  const a = sandbox();
  const b = sandbox();
  a.put('blocked', 'a.json');
  b.put('blocked', 'a.json');
  assert.equal(a.run(), SWEEPS.length);
  assert.equal(b.run(), SWEEPS.length, 'another project is not skipped because this one just ran');
  assert.equal(a.run(), 0);
  assert.equal(b.run(), 0);
});
