'use strict';

// Tests for hygiene-inventory.js -- the read-only backlog view behind the dashboard's Hygiene tab.
// Real files and real git (a bare repo standing in for GitHub); no mocks of the queue or the docs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// The metadata cache lives under $HOME/.local/state -- keep the tests out of the real one.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hyginv-home-'));

const { buildHygieneInventory, makeTaskLookup, scanTaskFunnel, parseCandidateHeaders } = require('./hygiene-inventory.js');

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function writeTask(queue, state, id, extra = {}) {
  const dir = state.includes('/') ? path.join(queue, state) : path.join(queue, state);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, source: 'observability_review', ...extra }));
}

const block = (n, { strength = 'Strong', dependsOn = null, body = 'Something concrete is wrong here.', pad = 0 } = {}) => [
  `### AC-${n} · Candidate ${n}`, `Strength: ${strength}`, `Files: src/a${n}.ts`, ...(dependsOn ? [`Depends-On: ${dependsOn}`] : []), '',
  'Problem:', body + ' '.repeat(0) + 'x'.repeat(pad), '', 'Solution:', 'Do the thing.', '', 'Benefits:', 'Better.', '',
].join('\n');

// --- parse ----------------------------------------------------------------------------------------------------------

test('parseCandidateHeaders: id/title/strength/files plus the facts the eligibility rules read', () => {
  const text = ['# Doc', '', block(1), block(2, { strength: 'Worth exploring' }), block(3, { dependsOn: 'AC-1' }), block(4, { body: '...' }), block(5, { pad: 5000 })].join('\n');
  const c = parseCandidateHeaders(text);
  assert.deepEqual(c.map((x) => x.n), [1, 2, 3, 4, 5]);
  assert.equal(c[0].strength, 'Strong');
  assert.equal(c[1].strength, 'Worth exploring');
  assert.equal(c[2].dependsOn, 'AC-1');
  assert.equal(c[3].placeholder, true, 'an ellipsis-only Problem is a placeholder');
  assert.equal(c[0].placeholder, false);
  assert.ok(c[4].chars > 4000);
  assert.equal(c[0].files, 'src/a1.ts');
});

// --- task lookup + funnel -------------------------------------------------------------------------------------------

function queueFixture() {
  const pipe = fs.mkdtempSync(path.join(os.tmpdir(), 'hyginv-pipe-'));
  const q = path.join(pipe, 'queue');
  writeTask(q, 'pending', 'observability-p-rule-a-ts-1');
  writeTask(q, 'drafting/worker-1', 'performance-p-rule-b-ts-2', { source: 'performance_review' });
  writeTask(q, 'blocked', 'function-length-p-c-ts-3', { source: 'function_length_review' });
  writeTask(q, 'done', 'observability-p-rule-d-ts-4', { terminalDisposition: 'dismissed' });
  writeTask(q, 'done', 'observability-p-rule-e-ts-5', { terminalDisposition: 'pending-merge' });
  writeTask(q, 'done', 'observability-p-rule-f-ts-6', {});                                   // no disposition recorded
  writeTask(q, 'done/_archived_no_action', 'arch-review-ac-3', { source: 'arch_review', terminalDisposition: 'noop' });
  writeTask(q, 'done/_archived/2026-08', 'change-review-abc1234', { source: 'change_review' });
  writeTask(q, 'pending', 'brain-dump-sort-zzz', { source: 'brain_dump_sort' });              // not a hygiene family
  return { pipe, q };
}

test('makeTaskLookup: finds a task in any state (incl. drafting subfolders and both archives) with its disposition', () => {
  const { q } = queueFixture();
  const ts = makeTaskLookup(q);
  assert.deepEqual(ts('observability-p-rule-a-ts-1'), { state: 'pending', disposition: null });
  assert.deepEqual(ts('performance-p-rule-b-ts-2'), { state: 'drafting', disposition: null });
  assert.deepEqual(ts('function-length-p-c-ts-3'), { state: 'blocked', disposition: null });
  assert.deepEqual(ts('observability-p-rule-d-ts-4'), { state: 'done', disposition: 'dismissed' });
  assert.deepEqual(ts('observability-p-rule-f-ts-6'), { state: 'done', disposition: 'unclassified' });
  assert.deepEqual(ts('arch-review-ac-3'), { state: 'archived', disposition: 'noop' });
  assert.equal(ts('change-review-abc1234').state, 'archived');
  assert.equal(ts('nope'), null);
});

test('scanTaskFunnel: per-family counts by state and disposition; only hygiene-prefixed files are counted', () => {
  const { q } = queueFixture();
  const f = scanTaskFunnel(q);
  assert.deepEqual(f.observability.byState, { pending: 1 });
  assert.deepEqual(f.observability.done, { dismissed: 1, 'pending-merge': 1, unclassified: 1 });
  assert.equal(f.observability.awaitingMerge, 1);
  assert.deepEqual(f.performance.byState, { drafting: 1 });
  assert.deepEqual(f.function_length.byState, { blocked: 1 });
  assert.deepEqual(f.arch.done, { noop: 1 });
  assert.equal(f.change_review.archivedOlder, 1, 'month buckets are counted by filename, never read');
  const total = Object.values(f).reduce((n, x) => n + x.total, 0);
  assert.equal(total, 7, 'the brain-dump-sort task is not a hygiene family, and the month-archived task is counted in archivedOlder, not total');
});

// --- the whole picture ----------------------------------------------------------------------------------------------

function docRepo() {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'hyginv-git-'));
  const origin = path.join(T, 'origin.git');
  const work = path.join(T, 'work');
  git(['init', '--bare', '-q', '-b', 'main', origin], T);
  git(['clone', '-q', origin, work], T);
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 't']]) git(['config', k, v], work);
  fs.mkdirSync(path.join(work, 'Docs'));
  const doc = path.join(work, 'Docs', 'ARCH_REVIEW_CANDIDATES.md');
  fs.writeFileSync(doc, ['# Arch', '',
    block(1),                                         // Strong, eligible, no task  -> waiting
    block(2, { pad: 5000 }),                          // Strong but oversized       -> ineligible
    block(3, { dependsOn: 'AC-9' }),                  // depends on an unmerged one -> ineligible
    block(4, { strength: 'Worth exploring' }),        // not Strong                 -> not-actionable
    block(5),                                         // has a done task            -> done
    block(6),                                         // has a pending task         -> queued
  ].join('\n'));
  git(['add', '.'], work); git(['commit', '-qm', 'main'], work); git(['push', '-q', 'origin', 'main'], work);
  git(['remote', 'set-head', 'origin', 'main'], work);
  // An unmerged agent branch adds AC-7 (and re-uses id 1, which must be ignored: main already has it).
  git(['checkout', '-q', '-b', 'agent/arch-review-ac-1', 'main'], work);
  fs.appendFileSync(doc, '\n' + block(7) + '\n' + block(1, { pad: 1 }) + '\n');
  git(['commit', '-qam', 'branch'], work); git(['push', '-q', 'origin', 'agent/arch-review-ac-1'], work);
  git(['checkout', '-q', 'main'], work);
  return { work, doc };
}

function fakeRegistry({ withPluginHooks = true, hookThrows = false } = {}) {
  const reg = {};
  return {
    reg,
    getRegisteredSource: (n) => reg[n] || null,
    register(name, cfg) { reg[name] = { name, ...cfg }; },
  };
}

test('buildHygieneInventory: candidate docs -- waiting / oversized / dependency-blocked / not-actionable / done / queued / awaiting-merge', () => {
  const { work, doc } = docRepo();
  const pipe = fs.mkdtempSync(path.join(os.tmpdir(), 'hyginv-pipe2-'));
  const q = path.join(pipe, 'queue');
  writeTask(q, 'done', 'arch-review-ac-5', { source: 'arch_review', terminalDisposition: 'merged' });
  writeTask(q, 'pending', 'arch-review-ac-6', { source: 'arch_review' });
  const r = fakeRegistry();
  r.register('arch_review', { candidatesPath: () => doc });
  const inv = buildHygieneInventory({ getRegisteredSource: r.getRegisteredSource, getConfig: () => ({ repoRoot: work, pipelineDir: pipe }), isDependencySatisfied: () => false });
  const arch = inv.families.find((f) => f.key === 'arch');
  const docInv = arch.candidates.docs[0];
  const byId = Object.fromEntries(docInv.items.map((i) => [i.id, i]));
  assert.equal(byId['AC-1'].status, 'waiting');
  assert.equal(byId['AC-2'].status, 'ineligible');
  assert.match(byId['AC-2'].reason, /oversized: \d+ chars > the 4000-char limit/);
  assert.equal(byId['AC-3'].status, 'ineligible');
  assert.match(byId['AC-3'].reason, /depends on AC-9, which is not merged/);
  assert.equal(byId['AC-4'].status, 'not-actionable');
  assert.equal(byId['AC-5'].status, 'done');
  assert.equal(byId['AC-5'].disposition, 'merged');
  assert.equal(byId['AC-6'].status, 'queued');
  assert.equal(byId['AC-7'].status, 'awaiting-merge');
  assert.equal(byId['AC-7'].location, 'unmerged:agent/arch-review-ac-1');
  assert.equal(docInv.items.filter((i) => i.id === 'AC-1').length, 1, 'an id the branch re-uses is not listed twice');
  assert.deepEqual(arch.open, { waitingFlags: 0, waitingCandidates: 1, stuckCandidates: 2, inFlight: 1, needsHuman: 0, awaitingMerge: 1 });
  assert.equal(inv.totals.stuckCandidates, 2);
});

test('buildHygieneInventory: dependency satisfied -> the dependent candidate is waiting, not stuck', () => {
  const { work, doc } = docRepo();
  const pipe = fs.mkdtempSync(path.join(os.tmpdir(), 'hyginv-pipe3-'));
  const r = fakeRegistry();
  r.register('arch_review', { candidatesPath: () => doc });
  const inv = buildHygieneInventory({ getRegisteredSource: r.getRegisteredSource, getConfig: () => ({ repoRoot: work, pipelineDir: pipe }), isDependencySatisfied: () => true });
  const item = inv.families.find((f) => f.key === 'arch').candidates.docs[0].items.find((i) => i.id === 'AC-3');
  assert.equal(item.status, 'waiting');
});

test('buildHygieneInventory: flags come from the plugin hook (given taskState), and a throwing hook or a missing plugin degrades to a note / unavailable', () => {
  const { work } = docRepo();
  const pipe = fs.mkdtempSync(path.join(os.tmpdir(), 'hyginv-pipe4-'));
  writeTask(path.join(pipe, 'queue'), 'done', 'observability-p-x-1', { terminalDisposition: 'dismissed' });
  const r = fakeRegistry();
  let received = null;
  r.register('observability_review', { inventory: ({ taskState }) => { received = taskState('observability-p-x-1'); return { total: 3, counts: { waiting: 2, queued: 0, blocked: 0, done: 1, digest: 0, suppressed: 0, stale: 0 }, waitingByConfidence: { high: 2 }, oldestWaitingAt: '2026-09-01T00:00:00Z', items: [], doneByDisposition: {}, truncated: false, approximate: true }; } });
  r.register('performance_review', { inventory: () => { throw new Error('boom'); } });
  const inv = buildHygieneInventory({ getRegisteredSource: r.getRegisteredSource, getConfig: () => ({ repoRoot: work, pipelineDir: pipe }), isDependencySatisfied: () => true });
  assert.deepEqual(received, { state: 'done', disposition: 'dismissed' }, 'the hook is handed a working taskState');
  const obs = inv.families.find((f) => f.key === 'observability');
  assert.equal(obs.available, true);
  assert.equal(obs.open.waitingFlags, 2);
  assert.equal(inv.totals.waitingFlags, 2);
  const perf = inv.families.find((f) => f.key === 'performance');
  assert.equal(perf.flags, null);
  assert.ok(inv.notes.some((n) => /performance: flag inventory failed: boom/.test(n)));
  const unused = inv.families.find((f) => f.key === 'unused_export');
  assert.equal(unused.available, false, 'a plugin that is not loaded shows as unavailable, not as zero work');
});

test('buildHygieneInventory: is a PURE READ of the pipeline -- the queue and repo are byte-for-byte unchanged', () => {
  const { work, doc } = docRepo();
  const { pipe, q } = queueFixture();
  const snapshot = () => {
    const out = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else out.push(`${f}:${fs.statSync(f).mtimeMs}:${fs.statSync(f).size}`); } };
    walk(pipe); walk(path.join(work, 'Docs'));
    return out.sort();
  };
  const before = snapshot();
  const headBefore = git(['rev-parse', 'HEAD'], work);
  const r = fakeRegistry();
  r.register('arch_review', { candidatesPath: () => doc });
  buildHygieneInventory({ getRegisteredSource: r.getRegisteredSource, getConfig: () => ({ repoRoot: work, pipelineDir: pipe }), isDependencySatisfied: () => true });
  assert.deepEqual(snapshot(), before);
  assert.equal(git(['rev-parse', 'HEAD'], work), headBefore);
  assert.equal(git(['branch', '--show-current'], work), 'main');
});

test('the metadata cache is keyed by mtime+size: a changed file is re-read, and the result is identical warm or cold', () => {
  const { pipe, q } = queueFixture();
  const cfg = { getRegisteredSource: () => null, getConfig: () => ({ repoRoot: pipe, pipelineDir: pipe }), isDependencySatisfied: () => true };
  const cold = buildHygieneInventory(cfg);
  const warm = buildHygieneInventory(cfg);
  for (const x of [cold, warm]) delete x.generatedAt;
  assert.deepEqual(warm, cold);
  // Change a task's disposition on disk: the cache must notice.
  writeTask(q, 'done', 'observability-p-rule-d-ts-4', { terminalDisposition: 'merged', padding: 'x'.repeat(50) });
  const after = buildHygieneInventory(cfg);
  assert.equal(after.families.find((f) => f.key === 'observability').tasks.done.merged, 1);
  assert.equal(after.families.find((f) => f.key === 'observability').tasks.done.dismissed, undefined);
});
