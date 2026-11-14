'use strict';

// HUB0274-08: scripts/check-brain-dump-targets.js, the one-entry target check behind the dashboard's "Process now" warning.
// The pure main(raw) is tested directly and the CLI once through a real child process.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { main } = require('../scripts/check-brain-dump-targets.js');

const OK = { verdict: 'ok', reasons: [] };

test('an entry citing only missing paths is suspect with the reason', () => {
  const r = main(JSON.stringify({ id: 'bd-1', rawText: 'see `src/does-not-exist-a.js` and `src/does-not-exist-b.js`' }));
  assert.equal(r.verdict, 'suspect');
  assert.match(r.reasons[0], /every cited path is missing/);
});

test('an entry citing a path that exists is ok', () => {
  assert.deepEqual(main(JSON.stringify({ id: 'bd-2', rawText: 'the helper in `src/evidence-pack.js` is wrong' })), OK);
});

test('an entry with no cited paths is ok', () => {
  assert.deepEqual(main(JSON.stringify({ id: 'bd-3', rawText: 'just an idea' })), OK);
});

test('garbage, empty and field-less input fail open', () => {
  assert.deepEqual(main('not json'), OK);
  assert.deepEqual(main(''), OK);
  assert.deepEqual(main(JSON.stringify({ id: 'bd-4' })), OK);
  assert.deepEqual(main('null'), OK);
});

test('the kill switch fails open', () => {
  const prev = process.env.AGENT_MANAGER_BRAIN_DUMP_TARGET_CHECK;
  process.env.AGENT_MANAGER_BRAIN_DUMP_TARGET_CHECK = 'false';
  try {
    assert.deepEqual(main(JSON.stringify({ id: 'bd-5', rawText: 'see `src/does-not-exist-a.js`' })), OK);
  } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_BRAIN_DUMP_TARGET_CHECK; else process.env.AGENT_MANAGER_BRAIN_DUMP_TARGET_CHECK = prev;
  }
});

test('the CLI reads stdin, prints exactly one JSON line and exits 0, also for garbage input', () => {
  const script = path.join(__dirname, '..', 'scripts', 'check-brain-dump-targets.js');
  const run = (input) => spawnSync('node', [script], { input, encoding: 'utf8', timeout: 20000 });
  const a = run(JSON.stringify({ id: 'bd-6', rawText: 'see `src/does-not-exist-a.js`' }));
  assert.equal(a.status, 0);
  assert.equal(a.stdout.trim().split('\n').length, 1);
  assert.equal(JSON.parse(a.stdout).verdict, 'suspect');
  const b = run('garbage');
  assert.equal(b.status, 0);
  assert.deepEqual(JSON.parse(b.stdout), OK);
});
