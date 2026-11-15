'use strict';

// The watchdog's pool sweep behind src/sweep-gate.js (2026-11-03, ADR-0024). The REAL shipped bash is run against stub node scripts in a throwaway directory:
// sweep_gate_skips (scripts/agent-manager-common.sh) and the "Pool sweep" block of scripts/queue-watcher.sh (cut out by its own markers and run as it ships).
// Run: node --test scripts/sweep-gate-wiring.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const COMMON_SH = path.join(__dirname, 'agent-manager-common.sh');
const WATCHER_SH = path.join(__dirname, 'queue-watcher.sh');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-gate-wiring-')); }

function stubDir(files) {
  const dir = tmpDir();
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

function skips(src, args) {
  const r = spawnSync('bash', ['-c', `source ${JSON.stringify(COMMON_SH)}; sweep_gate_skips ${args}`], { env: { ...process.env, PACKAGE_SRC_DIR: src }, encoding: 'utf8' });
  return r.status;
}

const gateStub = (answer) => `process.stdout.write(${JSON.stringify(answer)});`;

test('sweep_gate_skips succeeds only for the exact answer skip', () => {
  assert.equal(skips(stubDir({ 'sweep-gate.js': gateStub('skip\n') }), 'project /p'), 0);
  assert.equal(skips(stubDir({ 'sweep-gate.js': gateStub('run\n') }), 'project /p'), 1);
});

test('sweep_gate_skips fails open: garbage, empty output, a crash and a missing script all mean run', () => {
  assert.equal(skips(stubDir({ 'sweep-gate.js': gateStub('skipped soon\n') }), 'project /p'), 1);
  assert.equal(skips(stubDir({ 'sweep-gate.js': gateStub('') }), 'project /p'), 1);
  assert.equal(skips(stubDir({ 'sweep-gate.js': 'throw new Error("boom")' }), 'project /p'), 1);
  assert.equal(skips(stubDir({}), 'project /p'), 1);
});

test('sweep_gate_skips passes its arguments through untouched', () => {
  const out = path.join(tmpDir(), 'args.txt');
  const src = stubDir({ 'sweep-gate.js': `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2))); process.stdout.write('skip');` });
  assert.equal(skips(src, 'project "/a dir/with space"'), 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), ['project', '/a dir/with space']);
});

function poolBlock() {
  const lines = fs.readFileSync(WATCHER_SH, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.includes('AGENT_MANAGER_SWEEP_POOL=${AGENT_MANAGER_SWEEP_POOL:=true}'));
  assert.ok(start >= 0, 'the pool sweep block start marker is in queue-watcher.sh');
  const end = lines.findIndex((l, i) => i > start && l.startsWith('    fi'));
  assert.ok(end > start, 'the pool sweep block end is in queue-watcher.sh');
  return lines.slice(start, end + 1).join('\n');
}

function runPoolBlock({ gate, extraEnv = {} }) {
  const log = path.join(tmpDir(), 'calls.log');
  const rec = (name) => `require('fs').appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(name)} + ' ' + (process.env.POOL_MARK || '-') + '\\n'); console.log('checked 0');`;
  const src = stubDir({
    'pool-projects.js': `const a = process.argv.slice(2); if (a[0] === '--all') console.log(['/pipe/A', '/pipe/B'].join('\\n')); else if (a[0] === '--env-args') console.log('POOL_MARK=' + a[1]);`,
    'sweep-gate.js': `const a = process.argv.slice(2); require('fs').appendFileSync(${JSON.stringify(log)}, 'gate ' + a.join(' ') + '\\n'); process.stdout.write(${JSON.stringify(gate)}[a[1]] || 'run');`,
    'branch-defect-readmit-sweep.js': rec('defect'),
    'branch-conflict-readmit-sweep.js': rec('conflict'),
    'redo-supersede-sweep.js': rec('redo'),
  });
  const script = `PACKAGE_SRC_DIR=${JSON.stringify(src)}; source ${JSON.stringify(COMMON_SH)}\n${poolBlock()}`;
  const r = spawnSync('bash', ['-c', script], { env: { ...process.env, ...extraEnv }, encoding: 'utf8' });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  return { r, calls };
}

test('pool loop: a skipped project runs nothing; a project that must run gets the defect and conflict sweeps, never the global redo sweep', () => {
  const { r, calls } = runPoolBlock({ gate: { '/pipe/A': 'skip' } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(calls, ['gate project /pipe/A', 'gate project /pipe/B', 'defect /pipe/B', 'conflict /pipe/B']);
});

test('pool loop: when no project is skipped both get both sweeps and still no redo sweep', () => {
  const { calls } = runPoolBlock({ gate: {} });
  assert.deepEqual(calls.filter((c) => !c.startsWith('gate')), ['defect /pipe/A', 'conflict /pipe/A', 'defect /pipe/B', 'conflict /pipe/B']);
});

test('pool loop: a gate that crashes means run (fail open)', () => {
  const log = path.join(tmpDir(), 'c.log');
  const src = stubDir({
    'pool-projects.js': `const a = process.argv.slice(2); if (a[0] === '--all') console.log('/pipe/A'); else console.log('POOL_MARK=x');`,
    'sweep-gate.js': 'process.exit(3)',
    'branch-defect-readmit-sweep.js': `require('fs').appendFileSync(${JSON.stringify(log)}, 'defect\\n'); console.log('checked 1');`,
    'branch-conflict-readmit-sweep.js': `require('fs').appendFileSync(${JSON.stringify(log)}, 'conflict\\n'); console.log('checked 1');`,
  });
  const r = spawnSync('bash', ['-c', `PACKAGE_SRC_DIR=${JSON.stringify(src)}; source ${JSON.stringify(COMMON_SH)}\n${poolBlock()}`], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['defect', 'conflict']);
});

test('pool loop: AGENT_MANAGER_SWEEP_POOL=false still runs nothing, not even the gate', () => {
  const { calls } = runPoolBlock({ gate: {}, extraEnv: { AGENT_MANAGER_SWEEP_POOL: 'false' } });
  assert.deepEqual(calls, []);
});

test('active project: the defect and conflict sweeps sit behind the project gate and the redo sweep behind the global gate, and redo is run in one place only', () => {
  const text = fs.readFileSync(WATCHER_SH, 'utf8');
  assert.match(text, /if sweep_gate_skips project "\$PIPELINE_DIR"; then conflict_readmit_result="skipped: nothing changed"\n\s+else conflict_readmit_result="\$\(node "\$\{PACKAGE_SRC_DIR\}\/branch-conflict-readmit-sweep\.js"/);
  assert.match(text, /if sweep_gate_skips project "\$PIPELINE_DIR"; then defect_readmit_result="skipped: nothing changed"\n\s+else defect_readmit_result="\$\(node "\$\{PACKAGE_SRC_DIR\}\/branch-defect-readmit-sweep\.js"/);
  assert.match(text, /if sweep_gate_skips global-redo; then redo_supersede_result="skipped: nothing changed"\n\s+else redo_supersede_result="\$\(node "\$\{PACKAGE_SRC_DIR\}\/redo-supersede-sweep\.js"/);
  assert.equal((text.match(/node "\$\{PACKAGE_SRC_DIR\}\/redo-supersede-sweep\.js"/g) || []).length, 1);
  assert.equal((text.match(/\$\{_sweep\}/g) || []).length, 1);
  assert.doesNotMatch(text, /for _sweep in [^;]*redo-supersede-sweep\.js/);
});
