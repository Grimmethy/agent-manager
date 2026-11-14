'use strict';

// Lanes read the gpu-broker's memory-pressure marker instead of launching `node mem-guard.js` on every tick (2026-11-02, phase 4 of the
// memory-pressure plan). These tests source the REAL shipped functions from scripts/agent-manager-common.sh in a throwaway bash with a
// fake `node` first on PATH that counts launches, so they measure the thing the change is for: node launches per idle tick.
//   fresh ok marker            -> no yield, ZERO node launches
//   fresh tight/critical       -> yield, ZERO node launches
//   missing / stale / garbage  -> falls back to mem-guard.js exactly as before (one launch, exit 3 = yield)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const COMMON_SH = path.join(__dirname, 'agent-manager-common.sh');

function world({ marker, ageS = 5, guardExit = 0, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memmarker-'));
  const markerPath = path.join(dir, 'marker.json');
  if (marker !== undefined) {
    fs.writeFileSync(markerPath, typeof marker === 'string' ? marker : JSON.stringify(marker));
    const t = (Date.now() - ageS * 1000) / 1000;
    fs.utimesSync(markerPath, t, t);
  }
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const counter = path.join(dir, 'node-launches');
  fs.writeFileSync(path.join(bin, 'node'), `#!/bin/bash\necho "$*" >> ${JSON.stringify(counter)}\nexit ${guardExit}\n`, { mode: 0o755 });
  const run = (fn) => {
    const script = `set -u\nPACKAGE_SRC_DIR=/pkg/src\nsource ${JSON.stringify(COMMON_SH)}\n${fn}\necho "rc=$?"\n`;
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, AGENT_MANAGER_MEM_PRESSURE_MARKER: markerPath, LOG_FILE: path.join(dir, 'log'), HOME: dir, ...env } });
    const launches = fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').split('\n').filter(Boolean) : [];
    return { out: r.stdout.trim(), rc: Number((/rc=(\d+)/.exec(r.stdout) || [])[1]), launches, log: fs.existsSync(path.join(dir, 'log')) ? fs.readFileSync(path.join(dir, 'log'), 'utf8') : '' };
  };
  return { dir, markerPath, run };
}
const marker = (state, extra = {}) => ({ state, seq: 7, at: '2026-11-02T12:00:00Z', reason: 'r', numbers: { available_mb: 900 }, ...extra });
const yields = (r) => r.rc === 0;                  // mem_pressure_high: exit 0 = yield this tick

test('a fresh ok marker: no yield and no node launch at all', () => {
  const w = world({ marker: marker('ok') });
  const r = w.run('mem_pressure_high');
  assert.deepEqual([yields(r), r.launches.length], [false, 0]);
});

test('a fresh tight or critical marker: yield, no node launch, and a log line that names the source', () => {
  for (const state of ['tight', 'critical']) {
    const w = world({ marker: marker(state) });
    const r = w.run('mem_pressure_high');
    assert.deepEqual([yields(r), r.launches.length], [true, 0], state);
    assert.match(r.log, new RegExp(`host memory pressure ${state} \\(broker marker\\)`));
  }
});

test('the real json.dump spacing of the broker marker is parsed, and compact spacing too', () => {
  const dumped = JSON.stringify(marker('critical')).replace(/":/g, '": ').replace(/,"/g, ', "');         // Python json.dump default separators
  assert.equal(yields(world({ marker: dumped }).run('mem_pressure_high')), true);
  assert.equal(yields(world({ marker: JSON.stringify(marker('critical')) }).run('mem_pressure_high')), true);
});

test('no marker: falls back to mem-guard.js exactly as before (one launch; exit 3 yields, exit 0 does not)', () => {
  const none = world({ guardExit: 3 }).run('mem_pressure_high');
  assert.deepEqual([yields(none), none.launches.length], [true, 1]);
  assert.match(none.launches[0], /\/pkg\/src\/mem-guard\.js$/);
  const fine = world({ guardExit: 0 }).run('mem_pressure_high');
  assert.deepEqual([yields(fine), fine.launches.length], [false, 1]);
  assert.equal(yields(world({ guardExit: 1 }).run('mem_pressure_high')), false);          // any other exit fails open
});

const NOW = 1_800_000_000;
function atAge(ageS, limit, extra = {}) {            // exact ages: now is fixed by the test seam and the marker's mtime is an integer second
  const w = world({ marker: marker('ok'), guardExit: 3, env: { AGENT_MANAGER_MEM_MARKER_NOW: String(NOW), AGENT_MANAGER_MEM_MARKER_MAX_AGE_S: String(limit), ...extra } });
  fs.utimesSync(w.markerPath, NOW - ageS, NOW - ageS);
  return w.run('mem_pressure_high');
}

test('the age boundary is exact: a marker exactly at the limit is trusted, one second older is not, and one dated in the future is not', () => {
  assert.equal(atAge(60, 60).launches.length, 0);
  assert.equal(atAge(61, 60).launches.length, 1);
  assert.equal(atAge(0, 60).launches.length, 0);
  assert.equal(atAge(-1, 60).launches.length, 1);
  assert.equal(atAge(-100000, 100000000).launches.length, 1);
});

test('the default marker path is the one the broker writes', () => {
  const src = fs.readFileSync(COMMON_SH, 'utf8');
  assert.match(src, /AGENT_MANAGER_MEM_PRESSURE_MARKER:-\/dev\/shm\/agent-manager-mem-pressure\.json/);
});

test('a stale marker is not trusted: older than the limit falls back, inside it does not', () => {
  assert.equal(world({ marker: marker('ok'), ageS: 331, guardExit: 3 }).run('mem_pressure_high').launches.length, 1);
  assert.equal(world({ marker: marker('ok'), ageS: 329 }).run('mem_pressure_high').launches.length, 0);
  assert.equal(yields(world({ marker: marker('ok'), ageS: 1000, guardExit: 3 }).run('mem_pressure_high')), true);      // stale ok + guard says pressure: the guard wins
  assert.equal(yields(world({ marker: marker('critical'), ageS: 1000, guardExit: 0 }).run('mem_pressure_high')), false); // stale critical is not trusted either
});

test('AGENT_MANAGER_MEM_MARKER_MAX_AGE_S changes the limit; a garbage value falls back to 330', () => {
  assert.equal(world({ marker: marker('ok'), ageS: 100, env: { AGENT_MANAGER_MEM_MARKER_MAX_AGE_S: '60' } }).run('mem_pressure_high').launches.length, 1);
  assert.equal(world({ marker: marker('ok'), ageS: 100, env: { AGENT_MANAGER_MEM_MARKER_MAX_AGE_S: '120' } }).run('mem_pressure_high').launches.length, 0);
  assert.equal(world({ marker: marker('ok'), ageS: 100, env: { AGENT_MANAGER_MEM_MARKER_MAX_AGE_S: 'soon' } }).run('mem_pressure_high').launches.length, 0);
  assert.equal(world({ marker: marker('ok'), ageS: 400, env: { AGENT_MANAGER_MEM_MARKER_MAX_AGE_S: 'soon' } }).run('mem_pressure_high').launches.length, 1);
});

test('a malformed marker (garbage, empty, unknown state, no state) falls back', () => {
  for (const content of ['{not json', '', '{"state": "banana", "seq": 1}', '{"seq": 1}', '[]']) {
    const r = world({ marker: content, guardExit: 3 }).run('mem_pressure_high');
    assert.deepEqual([yields(r), r.launches.length], [true, 1], JSON.stringify(content));
  }
});

test('AGENT_MANAGER_MEM_MARKER=off ignores even a fresh marker', () => {
  const r = world({ marker: marker('critical'), guardExit: 0, env: { AGENT_MANAGER_MEM_MARKER: 'off' } }).run('mem_pressure_high');
  assert.deepEqual([yields(r), r.launches.length], [false, 1]);
});

test('an unreadable marker path falls back (a directory where the file should be)', () => {
  const w = world({ guardExit: 3 });
  fs.mkdirSync(w.markerPath);
  const r = w.run('mem_pressure_high');
  assert.deepEqual([yields(r), r.launches.length], [true, 1]);
});

test('a marker dated in the future is not trusted (clock jump)', () => {
  const r = world({ marker: marker('ok'), ageS: -3600, guardExit: 3 }).run('mem_pressure_high');
  assert.deepEqual([yields(r), r.launches.length], [true, 1]);
});

test('mem_marker_state prints the state for a valid marker and nothing for an invalid one', () => {
  assert.equal(world({ marker: marker('tight') }).run('mem_marker_state').out.split('\n')[0], 'tight');
  const bad = world({ marker: '{x' }).run('mem_marker_state');
  assert.deepEqual([bad.out.split('\n')[0], bad.rc], ['rc=1', 1]);
});

test('one idle tick costs zero node launches with the marker, one without (the measured change)', () => {
  const tick = (w) => { w.run('mem_pressure_high'); return w.run('mem_pressure_high').launches.length; };          // two ticks: launches accumulate in the counter
  assert.equal(tick(world({ marker: marker('ok') })), 0);
  assert.equal(tick(world({ guardExit: 0 })), 2);
});

test('both lanes still ask mem_pressure_high (the wiring this guards)', () => {
  for (const f of ['local-worker.sh', 'review-runner.sh']) {
    assert.match(fs.readFileSync(path.join(__dirname, f), 'utf8'), /if mem_pressure_high; then/, f);
  }
});

// 2026-11-10: swap nearly full with 5.4 GB available and no stall left the marker at tight for hours and every lane idle with tasks waiting.
const calm = (over = {}) => ({ available_mb: 5379, swap_free_mb: 101, swap_total_mb: 6143, mem_some: 0.0, mem_full: 0.0, io_some: 3.63, io_full: 3.23, ...over });
const tightWith = (nums, reason = 'holding tight: swap low (101 MB free)') => marker('tight', { reason, numbers: calm(nums) });

test('tight with plenty of RAM and no stall (the swap-only case): the lane keeps claiming, no node launch, no yield line', () => {
  const w = world({ marker: tightWith({}) });
  const r = w.run('mem_pressure_high');
  assert.deepEqual([yields(r), r.launches.length], [false, 0]);
  assert.equal(r.log, '');
});

test('tight yields as soon as any one stall number or the RAM floor is breached', () => {
  for (const over of [{ mem_some: 5 }, { io_some: 20 }, { io_full: 5 }, { available_mb: 2047 }]) {
    assert.equal(yields(world({ marker: tightWith(over) }).run('mem_pressure_high')), true, JSON.stringify(over));
  }
  for (const over of [{ mem_some: 4.9 }, { io_some: 19.9 }, { io_full: 4.9 }, { available_mb: 2048 }]) {
    assert.equal(yields(world({ marker: tightWith(over) }).run('mem_pressure_high')), false, JSON.stringify(over));
  }
});

test('critical always yields, even with calm numbers', () => {
  assert.equal(yields(world({ marker: marker('critical', { numbers: calm() }) }).run('mem_pressure_high')), true);
});

test('a tight marker with missing, partial or non-numeric numbers still yields (fails closed to the old behaviour)', () => {
  for (const numbers of [undefined, {}, { available_mb: 5379 }, { available_mb: 5379, mem_some: 0, io_some: 1 }, { available_mb: 'lots', mem_some: 0, io_some: 1, io_full: 1 }]) {
    const m = marker('tight'); if (numbers === undefined) delete m.numbers; else m.numbers = numbers;
    assert.equal(yields(world({ marker: m }).run('mem_pressure_high')), true, JSON.stringify(numbers));
  }
});

test('the three stall limits and the RAM floor can be set from the environment; a bad value yields', () => {
  assert.equal(yields(world({ marker: tightWith({ mem_some: 6 }), env: { AGENT_MANAGER_TIGHT_YIELD_MEM_SOME: '8' } }).run('mem_pressure_high')), false);
  assert.equal(yields(world({ marker: tightWith({ io_some: 12 }), env: { AGENT_MANAGER_TIGHT_YIELD_IO_SOME: '10' } }).run('mem_pressure_high')), true);
  assert.equal(yields(world({ marker: tightWith({ io_full: 6 }), env: { AGENT_MANAGER_TIGHT_YIELD_IO_FULL: '7' } }).run('mem_pressure_high')), false);
  assert.equal(yields(world({ marker: tightWith({ available_mb: 3000 }), env: { AGENT_MANAGER_TIGHT_YIELD_AVAILABLE_MB: '4096' } }).run('mem_pressure_high')), true);
  assert.equal(yields(world({ marker: tightWith({}), env: { AGENT_MANAGER_TIGHT_YIELD_IO_FULL: 'lots' } }).run('mem_pressure_high')), true);
});

test('the yield line carries the marker reason and the numbers', () => {
  const r = world({ marker: tightWith({ io_full: 9.5, io_some: 11.25 }, 'holding tight: io stall full 9.5%') }).run('mem_pressure_high');
  assert.equal(yields(r), true);
  assert.match(r.log, /host memory pressure tight \(broker marker\): holding tight: io stall full 9\.5%; avail 5379 MB, mem some 0%, io some 11\.25%, io full 9\.5%/);
  const c = world({ marker: marker('critical', { reason: 'io stall full 47.63%', numbers: calm({ io_full: 47.63 }) }) }).run('mem_pressure_high');
  assert.match(c.log, /host memory pressure critical \(broker marker\): io stall full 47\.63%; avail 5379 MB/);
});
