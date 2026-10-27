'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { recheckAbandoned, loadState } = require('./abandoned-recheck.js');
const { recordBranchRemoval } = require('./branch-removal-ledger.js');

const BR = 'agent/decompose-hub-1791297583352';
const LINES = [
  'export function enrichProperty(property, county, options) { return runAutoEnrich(property); }',
  'async function runAutoEnrich(property, county, opts = {}) { const steps = []; return steps; }',
  'const result = await runAutoEnrich(prop, county, { includeImages: true, taxYear: 2026 });',
  'module.exports = { runAutoEnrich, enrichProperty, resolveCounty, normalizeInput, cleanup };',
  'const status = result.ok ? "enriched" : "failed"; res.json({ status, steps: result.steps });',
];
const DIFF = (file = 'src/enrichment.js') => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,1 +1,5 @@\n${LINES.map((l) => `+${l}`).join('\n')}\n`;
const NOW = Date.parse('2026-10-08T06:00:00Z');
function pipeline() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'abr-'));
  for (const s of ['done', 'approved', 'pending', 'adhoc', 'review', 'blocked']) fs.mkdirSync(path.join(d, 'queue', s), { recursive: true });
  return d;
}
const put = (d, rec) => fs.writeFileSync(path.join(d, 'queue', 'done', `${rec.id}.json`), JSON.stringify(rec));
const read = (d, state, id) => JSON.parse(fs.readFileSync(path.join(d, 'queue', state, `${id}.json`), 'utf8'));
const abandoned = (id, over = {}) => ({ id, rawDiff: DIFF(), terminalDisposition: 'abandoned', history: [{ stage: 'applied', at: '2026-10-07T07:20:18Z', detail: BR }, { stage: 'abandoned', at: '2026-10-07T20:39:01Z', detail: 'branch gone, not on main' }], ...over });
const ctx = (branches = {}) => ({ mainBranch: 'master', onMainIds: new Map(), branchAhead: new Map(Object.entries(branches)) });
// fake git: `show origin/<ref>:<file>` from a table; the shared branch's log/rev-parse/rev-list as configured
const gitFor = ({ main = '', branch = '', branchBodies = 'x\n\nTask: HUB0022-01 (adhoc/manual)\n', branchExists = true } = {}) => (_r, args) => {
  if (args[0] === 'show') { const ref = args[1].split(':')[0]; return ref === 'origin/master' ? main : ref.startsWith('origin/agent/') ? branch : ''; }
  if (args[0] === 'log') return branchBodies;
  if (args[0] === 'rev-parse') return branchExists ? 'sha' : '';
  if (args[0] === 'rev-list') return '1';
  return '';
};
const run = (d, git, extra = {}) => recheckAbandoned({ pipelineDir: d, repoRoot: '/r', ctx: ctx(), git, now: NOW, ...extra });

test('HUB0007-01 shape: abandoned, branch gone, but all its lines are on main -> corrected to superseded', () => {
  const d = pipeline();
  put(d, abandoned('HUB0007-01'));
  const out = run(d, gitFor({ main: LINES.join('\n') }));
  assert.deepEqual(out.corrected, [{ id: 'HUB0007-01', from: 'abandoned', to: 'superseded' }]);
  const rec = read(d, 'done', 'HUB0007-01');
  assert.equal(rec.terminalDisposition, 'superseded');
  assert.match(rec.history.at(-1).detail, /^abandoned-recheck:/);
});

test('a genuinely lost, deliberately discarded task stays abandoned and is stamped as checked (so it is not re-read every tick)', () => {
  const d = pipeline();
  put(d, abandoned('really-lost'));
  recordBranchRemoval(d, { branch: BR, taskId: 'someone', cause: 'discarded', actor: 'dashboard' });
  const out = run(d, gitFor({ branchExists: false }));
  assert.deepEqual([out.corrected, out.restored], [[], []]);
  assert.equal(read(d, 'done', 'really-lost').terminalDisposition, 'abandoned');
  assert.ok(loadState(d).checked['really-lost']);
  assert.equal(run(d, gitFor({ branchExists: false })).rechecked, 0, 'within the throttle window nothing is re-checked');
  assert.equal(run(d, gitFor({ branchExists: false }), { now: NOW + 7 * 3600 * 1000 }).rechecked, 1, 'after the TTL it is');
});

test('HUB0018-01 shape: stacked on a shared branch a requeue deleted, branch back without its commit -> restored to approved/, once', () => {
  const d = pipeline();
  put(d, abandoned('HUB0018-01', { stacked: { branch: BR, seq: 1, total: 2 } }));
  recordBranchRemoval(d, { branch: BR, taskId: 'HUB0022-01', cause: 'superseded-by-requeue', actor: 'dashboard-requeue', now: new Date('2026-10-07T19:57:37Z') });
  const g = gitFor({ main: 'unrelated', branch: 'unrelated' });
  const out = run(d, new Proxy(g, {}), { ctx: ctx({ 'decompose-hub-1791297583352': 1 }) });
  assert.deepEqual(out.restored, [{ id: 'HUB0018-01', branch: BR, removedBy: 'HUB0022-01' }]);
  assert.equal(fs.existsSync(path.join(d, 'queue', 'done', 'HUB0018-01.json')), false);
  const rec = read(d, 'approved', 'HUB0018-01');
  assert.equal(rec.status, 'approved');
  assert.equal(rec.sharedBranchRestored.removedBy, 'HUB0022-01');
});

test('dry run reports but changes nothing; the kill switches AGENT_MANAGER_ABANDONED_RECHECK and AGENT_MANAGER_SHARED_BRANCH_RESTORE are honoured', () => {
  const d = pipeline();
  put(d, abandoned('HUB0007-01'));
  put(d, abandoned('HUB0018-01', { stacked: { branch: BR, seq: 1, total: 2 } }));
  recordBranchRemoval(d, { branch: BR, taskId: 'HUB0022-01', cause: 'superseded-by-requeue', actor: 'dashboard-requeue', now: new Date('2026-10-07T19:57:37Z') });
  const g = gitFor({ main: LINES.join('\n') });
  const dry = run(d, g, { dryRun: true });
  assert.deepEqual(dry.corrected.map((c) => c.id).sort(), ['HUB0007-01', 'HUB0018-01'], 'a dry run still reports what it WOULD correct (both diffs are on main here)');
  assert.equal(read(d, 'done', 'HUB0007-01').terminalDisposition, 'abandoned', 'dry run wrote nothing');
  assert.equal(run(d, g, { env: { AGENT_MANAGER_ABANDONED_RECHECK: 'false' } }).rechecked, 0);
  const d2 = pipeline();
  put(d2, abandoned('HUB0018-01', { stacked: { branch: BR, seq: 1, total: 2 } }));
  recordBranchRemoval(d2, { branch: BR, taskId: 'HUB0022-01', cause: 'superseded-by-requeue', actor: 'dashboard-requeue', now: new Date('2026-10-07T19:57:37Z') });
  const off = run(d2, gitFor({ main: 'u', branch: 'u' }), { ctx: ctx({ x: 1 }), env: { AGENT_MANAGER_SHARED_BRANCH_RESTORE: 'false' } });
  assert.deepEqual(off.restored, []);
  assert.equal(read(d2, 'done', 'HUB0018-01').terminalDisposition, 'abandoned');
});

test('no repo or ctx -> nothing happens; later runs rescan only files touched since the watermark; a record healed elsewhere is dropped from the list', () => {
  const d = pipeline();
  put(d, abandoned('a1'));
  assert.deepEqual(recheckAbandoned({ pipelineDir: d, repoRoot: null, ctx: ctx(), now: NOW }), { rechecked: 0, corrected: [], restored: [], errors: 0 });
  run(d, gitFor());
  const st = loadState(d);
  assert.deepEqual(st.abandoned, ['a1']);
  assert.ok(st.scannedAtMs > 0);
  // healed by someone else: the next due check drops it
  put(d, { ...abandoned('a1'), terminalDisposition: 'merged' });
  run(d, gitFor(), { now: NOW + 7 * 3600 * 1000 });
  assert.deepEqual(loadState(d).abandoned, []);
  // a newly abandoned record is picked up incrementally
  put(d, abandoned('a2'));
  run(d, gitFor(), { now: NOW + 8 * 3600 * 1000 });
  assert.ok(loadState(d).abandoned.includes('a2'));
});
