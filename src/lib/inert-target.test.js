'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  summariseReplay, inertTargetMode, readFlags, primarySymbol, findInertTarget, nowReferenced, genuineVerdictIndex, hasGenuineVerdict, formatInertTargetSection,
} = require('./inert-target.js');

const RS = 'TaxHarvest/backend/src/services/runStore.js';
const flag = (symbol, definedIn, callSites = []) => ({ symbol, definedIn, callSites, scannedAt: '2026-10-08T05:00:00Z' });
const task = (title, rawText = '') => ({ id: 't', source: 'derived_task', title, promptContext: { rawText } });

test('primarySymbol: the first backticked identifier of the title, else of the body; dotted or empty -> null', () => {
  assert.equal(primarySymbol(task("`_patchRun` silently drops status changes", 'In `runStore.js`, `other` ...')), '_patchRun');
  assert.equal(primarySymbol(task('silently drops status changes', 'In `runStore.js`, `_patchRun()` unconditionally deletes')), '_patchRun', 'a file name with a dot is not an identifier; the first identifier in the body wins when the title has none');
  assert.equal(primarySymbol(task('no code here', 'plain prose only')), null);
  assert.equal(primarySymbol(task('uses `run.stopRequested` only', 'and `a.b.c`')), null);
  assert.equal(primarySymbol(null), null);
});

test('findInertTarget: the primary symbol flagged unreferenced in a CITED file matches (the patchRun finding)', () => {
  const t = task("`_patchRun` silently drops status changes when run is already 'Stopped'", 'In `runStore.js`, `_patchRun` (lines 38-43) deletes p.status');
  const flags = [flag('_patchRun', RS), flag('getAllRuns', RS, [{ file: 'a.js', line: 1 }])];
  assert.deepEqual(findInertTarget(t, flags, ['runStore.js']), { symbol: '_patchRun', definedIn: RS });
  assert.deepEqual(findInertTarget(t, flags, [RS]), { symbol: '_patchRun', definedIn: RS });
});

test('findInertTarget: a CALLED symbol, a different file, a non-primary symbol and an ambiguous name are not matched', () => {
  const called = task('`getAllRuns` returns the wrong map', 'in `runStore.js`');
  assert.equal(findInertTarget(called, [flag('getAllRuns', RS, [{ file: 'b.js', line: 2 }])], ['runStore.js']), null, 'it has a caller');

  const wrongFile = task('`_patchRun` bug', 'in `other.js`');
  assert.equal(findInertTarget(wrongFile, [flag('_patchRun', RS)], ['other.js']), null, 'the cited file is not where the flagged symbol lives');

  const nonPrimary = task('`getAllRuns` returns the wrong map', 'mentions `_patchRun` in passing, in `runStore.js`');
  assert.equal(findInertTarget(nonPrimary, [flag('_patchRun', RS), flag('getAllRuns', RS, [{ file: 'b.js', line: 2 }])], ['runStore.js']), null, 'only the primary symbol counts');

  const ambiguous = task('`getRun` is wrong', 'in `runs.ts`');
  assert.equal(findInertTarget(ambiguous, [flag('getRun', 'a/runs.ts'), flag('getRun', 'b/runs.ts', [{ file: 'c.ts', line: 1 }])], ['runs.ts']), null, 'one same-named definition IS called');

  assert.equal(findInertTarget(task('`_patchRun` bug', ''), [flag('_patchRun', RS)], []), null, 'no cited file');
  assert.equal(findInertTarget(task('`_patchRun` bug', ''), [], [RS]), null, 'no flags');
  assert.equal(findInertTarget(task('plain', 'plain'), [flag('x', RS)], [RS]), null);
});

test('nowReferenced: true only when the same symbol in the same file now has call sites', () => {
  assert.equal(nowReferenced('_patchRun', RS, [flag('_patchRun', RS, [{ file: 'a.js', line: 3 }])]), true);
  assert.equal(nowReferenced('_patchRun', RS, [flag('_patchRun', RS)]), false);
  assert.equal(nowReferenced('_patchRun', RS, [flag('_patchRun', 'other/file.js', [{ file: 'a.js', line: 3 }])]), false);
  assert.equal(nowReferenced('_patchRun', RS, []), false);
});

function doneDirWith(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inert-done-'));
  for (const [name, rec] of Object.entries(records)) fs.writeFileSync(path.join(dir, name), JSON.stringify(rec));
  return dir;
}
const triage = (symbol, definedIn, implementResponse, over = {}) => ({ id: `deadcode-${symbol}`, source: 'deadcode_triage', promptContext: { symbol, definedIn }, implementResponse, ...over });
const GENUINE = '### AC-017 · Remove unused `_patchRun`\n\nStrength: Strong\nFiles: x\n\nProblem: p';

test('genuineVerdictIndex: only a triage record carrying the vetted Strong candidate counts', () => {
  const dir = doneDirWith({
    'deadcode-a.json': triage('_patchRun', RS, GENUINE),
    'deadcode-b.json': triage('maybeUsed', RS, 'FALSE POSITIVE -- it is loaded through a route table the search cannot see.'),
    'deadcode-c.json': triage('weak', RS, '### AC-018 · Remove `weak`\nStrength: Worth exploring\nFiles: x'),
    'deadcode-d.json': triage('dropped', RS, GENUINE, { terminalDisposition: 'abandoned' }),
    'deadcode-e.json': { ...triage('wrongsource', RS, GENUINE), source: 'manual' },
    'unrelated.json': triage('notprefixed', RS, GENUINE),
    'deadcode-bad.json': 'not json',
  });
  fs.writeFileSync(path.join(dir, 'deadcode-bad.json'), '{oops');
  const idx = genuineVerdictIndex(dir);
  assert.equal(hasGenuineVerdict(idx, { symbol: '_patchRun', definedIn: RS }), true);
  for (const s of ['maybeUsed', 'weak', 'dropped', 'wrongsource', 'notprefixed']) assert.equal(hasGenuineVerdict(idx, { symbol: s, definedIn: RS }), false, s);
  assert.equal(hasGenuineVerdict(idx, { symbol: '_patchRun', definedIn: 'elsewhere/runStore.js' }), false, 'same symbol, different file');
  assert.equal(hasGenuineVerdict(new Set(), { symbol: 'x', definedIn: 'y' }), false);
  assert.deepEqual([...genuineVerdictIndex('/no/such/dir')], []);
});

test('readFlags tolerates a missing, corrupt or wrongly-shaped file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inert-flags-'));
  assert.deepEqual(readFlags(dir), []);
  fs.mkdirSync(path.join(dir, 'queue'));
  fs.writeFileSync(path.join(dir, 'queue', 'dead-code-flags.json'), '{nope');
  assert.deepEqual(readFlags(dir), []);
  fs.writeFileSync(path.join(dir, 'queue', 'dead-code-flags.json'), JSON.stringify([flag('a', 'f.js'), { symbol: 'b' }, null, { symbol: 'c', definedIn: 'g.js', callSites: 'x' }]));
  assert.deepEqual(readFlags(dir).map((f) => f.symbol), ['a']);
});

test('inertTargetMode defaults to retire; hold and off are honoured; junk falls back', () => {
  assert.equal(inertTargetMode({}), 'retire');
  assert.equal(inertTargetMode({ AGENT_MANAGER_DERIVED_INERT_TARGET: 'HOLD' }), 'hold');
  assert.equal(inertTargetMode({ AGENT_MANAGER_DERIVED_INERT_TARGET: 'off' }), 'off');
  assert.equal(inertTargetMode({ AGENT_MANAGER_DERIVED_INERT_TARGET: 'whatever' }), 'retire');
});

test('formatInertTargetSection names the symbol and file, and is empty without a stamp', () => {
  assert.equal(formatInertTargetSection(null), '');
  assert.equal(formatInertTargetSection({}), '');
  const s = formatInertTargetSection({ symbol: '_patchRun', definedIn: RS });
  assert.match(s, /`_patchRun`.*runStore\.js.*NO call sites/s);
});

test('summariseReplay: a matched task that was MERGED is reported as a false positive; a matched unworked one is not; an unmatched merged one is ignored', () => {
  const flags = [flag('_patchRun', RS)];
  const genuine = new Set([`_patchRun|${RS}`]);
  const cited = () => ['runStore.js'];
  const mk = (id, over = {}) => ({ id, source: 'derived_task', title: '`_patchRun` drops status', promptContext: { rawText: 'in `runStore.js`' }, ...over });
  const entries = [
    { state: 'derived', task: mk('open-one') },
    { state: 'done', task: mk('merged-one', { terminalDisposition: 'merged' }) },
    { state: 'done', task: mk('applied-one', { terminalDisposition: 'pending-merge' }) },
    { state: 'done', task: { id: 'unrelated-merged', source: 'derived_task', title: '`getAllRuns` is wrong', promptContext: { rawText: 'in `runStore.js`' }, terminalDisposition: 'merged' } },
    { state: 'done', task: mk('not-derived', { source: 'manual' }) },
  ];
  const r = summariseReplay(entries, flags, genuine, cited);
  assert.equal(r.total, 4, 'only derived_task records are counted');
  assert.deepEqual(r.matches.map((m) => m.id), ['open-one', 'merged-one', 'applied-one']);
  assert.deepEqual(r.falsePositives.map((m) => m.id), ['merged-one', 'applied-one']);
  assert.equal(r.matches[0].action, 'retire');
  assert.equal(summariseReplay(entries, flags, new Set(), cited).matches[0].action, 'hold');
  assert.deepEqual(summariseReplay([], flags, genuine, cited), { total: 0, matches: [], falsePositives: [] });
});
