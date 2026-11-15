'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scoreTrial, main, TRIAL_BAR, RESULTS } = require('./farm-trial.js');

const mk = (node, results) => results.map((result, i) => ({ taskId: `${node}-${i}`, node, result }));

test('the bar is 0.8 and the four results are the contract', () => {
  assert.equal(TRIAL_BAR, 0.8);
  assert.deepEqual(RESULTS, ['merged', 'repaired', 'failed', 'abandoned']);
});

test('exactly 80 percent passes (4 of 5) and just under fails (7 of 9, 3 of 4)', () => {
  assert.equal(scoreTrial(mk('grimm', ['merged', 'merged', 'merged', 'merged', 'failed'])).passes, true);
  assert.equal(scoreTrial(mk('grimm', ['merged', 'merged', 'merged', 'merged', 'merged', 'merged', 'merged', 'failed', 'failed'])).passes, false);
  assert.equal(scoreTrial(mk('grimm', ['merged', 'merged', 'merged', 'repaired'])).passes, false);
  assert.equal(scoreTrial(mk('grimm', ['merged'])).passes, true);
  assert.equal(scoreTrial(mk('grimm', ['failed'])).passes, false);
});

test('the result carries total, clean, share and a per-node split', () => {
  const r = scoreTrial([...mk('grimm', ['merged', 'merged', 'repaired']), ...mk('wok', ['merged', 'abandoned'])]);
  assert.deepEqual(r, { total: 5, clean: 3, share: 0.6, passes: false, byNode: { grimm: { total: 3, clean: 2 }, wok: { total: 2, clean: 1 } } });
});

test('repaired, failed and abandoned never count as clean', () => {
  const r = scoreTrial(mk('grimm', ['repaired', 'failed', 'abandoned']));
  assert.equal(r.clean, 0);
  assert.equal(r.share, 0);
  assert.equal(r.total, 3);
});

test('an empty trial is total 0, share 0 and does not pass', () => {
  assert.deepEqual(scoreTrial([]), { total: 0, clean: 0, share: 0, passes: false, byNode: {} });
});

test('a missing or blank node is counted under "unknown"', () => {
  const r = scoreTrial([{ taskId: 'a', result: 'merged' }, { taskId: 'b', node: '', result: 'merged' }, { taskId: 'c', node: 7, result: 'failed' }]);
  assert.deepEqual(r.byNode, { unknown: { total: 3, clean: 2 } });
});

test('an unknown result, a non-object outcome or a non-array throws a clear error', () => {
  assert.throws(() => scoreTrial([{ taskId: 'a', node: 'grimm', result: 'ok' }]), /outcome 0 has an unknown result "ok"/);
  assert.throws(() => scoreTrial([{ node: 'grimm' }]), /outcome 0/);
  assert.throws(() => scoreTrial([null]), /outcome 0/);
  assert.throws(() => scoreTrial([...mk('g', ['merged']), 5]), /outcome 1/);
  assert.throws(() => scoreTrial({ result: 'merged' }), /array/);
  assert.throws(() => scoreTrial('merged'), /array/);
});

function file(content) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'farm-trial-')), 'outcomes.json');
  fs.writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content));
  return f;
}

test('main prints the result JSON and exits 0 when the trial passes, 3 when it fails', () => {
  const out = [];
  assert.equal(main([file(mk('grimm', ['merged', 'merged', 'merged', 'merged', 'repaired']))], (s) => out.push(s)), 0);
  assert.equal(JSON.parse(out.pop()).share, 0.8);
  assert.equal(main([file(mk('grimm', ['merged', 'failed']))], (s) => out.push(s)), 3);
  assert.equal(JSON.parse(out.pop()).passes, false);
  assert.equal(main([file([])], (s) => out.push(s)), 3, 'an empty trial fails');
});

test('main exits 2 for no argument, an unreadable file, junk JSON and a bad outcome, printing nothing to stdout', () => {
  const out = [];
  const errs = process.stderr.write;
  const said = [];
  process.stderr.write = (m) => { said.push(String(m)); return true; };
  try {
    assert.equal(main([], (s) => out.push(s)), 2);
    assert.match(said.pop(), /usage: node src\/farm-trial.js <outcomes.json>/);
    for (const argv of [[], [path.join(os.tmpdir(), 'no-such-outcomes.json')], [file('{oops')], [file([{ taskId: 'a', node: 'g', result: 'nope' }])], [file({ not: 'array' })]]) {
      assert.equal(main(argv, (s) => out.push(s)), 2, JSON.stringify(argv));
    }
  } finally { process.stderr.write = errs; }
  assert.deepEqual(out, []);
});

test('the CLI runs as a real process with a real file', () => {
  const pass = spawnSync(process.execPath, [path.join(__dirname, 'farm-trial.js'), file(mk('grimm', ['merged', 'merged', 'merged', 'merged', 'failed']))], { encoding: 'utf8' });
  assert.equal(pass.status, 0);
  assert.equal(JSON.parse(pass.stdout).clean, 4);
  const fail = spawnSync(process.execPath, [path.join(__dirname, 'farm-trial.js'), file(mk('grimm', ['repaired']))], { encoding: 'utf8' });
  assert.equal(fail.status, 3);
  assert.equal(spawnSync(process.execPath, [path.join(__dirname, 'farm-trial.js')], { encoding: 'utf8' }).status, 2);
});
