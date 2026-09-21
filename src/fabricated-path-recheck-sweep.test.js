'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sweepFabricatedPathRecheck } = require('./fabricated-path-recheck-sweep.js');
const { formatFabricatedReason } = require('./candidate-path-grounding.js');

const REASON = `Ungrounded draft: ${formatFabricatedReason([{ claimedPath: 'src/lib/dealCsv.ts' }, { claimedPath: 'src/lib/dealAnalyzer.ts' }])}`;

function pipeline(tasks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fprs-'));
  for (const [state, t] of tasks) {
    fs.mkdirSync(path.join(dir, 'queue', state), { recursive: true });
    fs.writeFileSync(path.join(dir, 'queue', state, `${t.id}.json`), JSON.stringify(t));
  }
  return dir;
}
const blocked = (over = {}) => ({
  id: 'arch-discovery-community-5', domain: 'default', source: 'arch_discovery', title: 't', promptContext: { communityId: 5 },
  status: 'pending', createdAt: '2026-09-21T00:19:00Z', blockedStage: 'review', blockedReason: REASON,
  history: [{ stage: 'created', at: '2026-09-21T00:19:00Z' }, { stage: 'blocked', at: '2026-09-21T00:27:00Z', detail: REASON }], ...over,
});
const has = (dir, state, id) => fs.existsSync(path.join(dir, 'queue', state, `${id}.json`));
const run = (dir, over = {}) => sweepFabricatedPathRecheck({ pipelineDir: dir, repoRoot: null, fetch: false, existsAtMain: () => true, ...over });

test('requeues a task whose "fabricated" paths all exist on main, as a fresh pending task', () => {
  const dir = pipeline([['blocked', blocked()]]);
  const s = run(dir);
  assert.equal(s.requeued.length, 1);
  assert.ok(!has(dir, 'blocked', 'arch-discovery-community-5'));
  const t = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'pending', 'arch-discovery-community-5.json'), 'utf8'));
  assert.equal(t.status, 'pending');
  assert.equal(t.blockedReason, undefined, 'blocked state is not carried over');
  assert.deepEqual(t.requeuedForFixes, ['fabricated-path-exists-on-main']);
  assert.match(t.history[t.history.length - 1].detail, /exists on origin\/main/);
});

// The real record's shape: local-draft.js stamps reviewInconclusive:true on exactly this gate's blocks.
test('requeues a reviewInconclusive:true task (the gate\'s own stamp), not just an unstamped one', () => {
  const dir = pipeline([['blocked', blocked({ reviewInconclusive: true })]]);
  assert.equal(run(dir).requeued.length, 1);
});

test('leaves the task when ANY cited path is absent on main (a genuine fabrication)', () => {
  const dir = pipeline([['blocked', blocked()]]);
  const s = run(dir, { existsAtMain: (p) => p.endsWith('dealCsv.ts') });
  assert.equal(s.requeued.length, 0);
  assert.ok(has(dir, 'blocked', 'arch-discovery-community-5'));
});

test('once per task: a task already requeued for this is left for a human', () => {
  const dir = pipeline([['blocked', blocked({ requeuedForFixes: ['fabricated-path-exists-on-main'] })]]);
  assert.equal(run(dir).requeued.length, 0);
  assert.ok(has(dir, 'blocked', 'arch-discovery-community-5'));
});

test('never touches an applied task or an unexhausted design question', () => {
  const applied = blocked({ id: 'a', history: [{ stage: 'applied', at: 'x' }] });
  const inconclusive = blocked({ id: 'b', reviewInconclusive: false, blockedReason: 'Ungrounded draft: something else' });
  const design = blocked({ id: 'c', needsClarification: { reason: 'design-decision', openQuestions: REASON } });
  const dir = pipeline([['blocked', applied], ['blocked', inconclusive], ['needs-clarification', design]]);
  assert.equal(run(dir).requeued.length, 0);
});

test('ignores a block that is not the fabricated-path gate', () => {
  const dir = pipeline([['blocked', blocked({ blockedReason: 'draft call failed 3 times', history: [] })]]);
  const s = run(dir);
  assert.equal(s.checked, 0);
  assert.equal(s.requeued.length, 0);
});

test('a needs-clarification escalation of retry exhaustion is requeued too', () => {
  const t = blocked({ blockedReason: undefined, needsClarification: { reason: 'design-decision', openQuestions: REASON },
    history: [{ stage: 'exhausted', at: 'x' }] });
  const dir = pipeline([['needs-clarification', t]]);
  assert.equal(run(dir).requeued.length, 1);
});

test('a probe that throws counts as unknown, not "exists"', () => {
  const dir = pipeline([['blocked', blocked()]]);
  assert.equal(run(dir, { existsAtMain: () => { throw new Error('git down'); } }).requeued.length, 0);
});

test('dry run reports but moves nothing; kill switch does nothing', () => {
  const dir = pipeline([['blocked', blocked()]]);
  assert.equal(run(dir, { dryRun: true }).requeued.length, 1);
  assert.ok(has(dir, 'blocked', 'arch-discovery-community-5'));
  process.env.AGENT_MANAGER_FABRICATED_PATH_RECHECK = 'false';
  try { assert.equal(run(dir).requeued.length, 0); } finally { delete process.env.AGENT_MANAGER_FABRICATED_PATH_RECHECK; }
  assert.ok(has(dir, 'blocked', 'arch-discovery-community-5'));
});

test('a stale copy in derived/ is replaced; a real duplicate in pending/ blocks', () => {
  const d = blocked({ id: 'dv', source: 'derived_task', domain: 'adhoc' });
  const dir = pipeline([['blocked', d], ['derived', { id: 'dv', stale: true }]]);
  assert.equal(run(dir).requeued.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'derived', 'dv.json'), 'utf8')).stale, undefined);
  const dir2 = pipeline([['blocked', blocked()], ['pending', { id: 'arch-discovery-community-5' }]]);
  assert.equal(run(dir2).requeued.length, 0);
});

test('end to end with real git: stale checkout, file on origin/main -> requeued; invented file -> left', () => {
  const { execFileSync } = require('child_process');
  const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fprs-git-'));
  const origin = path.join(root, 'o.git'); const work = path.join(root, 'w');
  g(root, 'init', '-q', '--bare', '-b', 'main', origin); g(root, 'clone', '-q', origin, work);
  g(work, 'config', 'user.email', 't@t'); g(work, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(work, 'a.txt'), 'x'); g(work, 'add', '-A'); g(work, 'commit', '-qm', 'b'); g(work, 'push', '-q', 'origin', 'HEAD:main'); g(work, 'branch', 'stale');
  fs.mkdirSync(path.join(work, 'src', 'lib'), { recursive: true });
  for (const f of ['dealCsv.ts', 'dealAnalyzer.ts']) fs.writeFileSync(path.join(work, 'src', 'lib', f), '//');
  g(work, 'add', '-A'); g(work, 'commit', '-qm', 'c'); g(work, 'push', '-q', 'origin', 'HEAD:main'); g(work, 'checkout', '-q', 'stale');
  const dir = pipeline([['blocked', blocked()], ['blocked', blocked({ id: 'inv', blockedReason: `Ungrounded draft: ${formatFabricatedReason([{ claimedPath: 'src/lib/nope.ts' }])}` })]]);
  const s = sweepFabricatedPathRecheck({ pipelineDir: dir, repoRoot: work, mainBranch: 'main', fetch: false });
  assert.deepEqual(s.requeued.map((r) => r.id), ['arch-discovery-community-5']);
  assert.ok(has(dir, 'blocked', 'inv'));
});
