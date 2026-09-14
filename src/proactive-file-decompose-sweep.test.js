'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  sweep, isDue, markChecked, hasExistingRequestFor, isRequestResolved,
  countOutstandingDecomposeBranches, CHECK_INTERVAL_MS, TIER1_CAP, TIER2_CAP,
} = require('./proactive-file-decompose-sweep.js');

function tmpPipeline(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proactive-decompose-'));
  for (const s of ['file-decompose-requests', 'coordinating', 'adhoc', 'pending', 'done', 'done/_archived_no_action', 'instances']) {
    fs.mkdirSync(path.join(dir, 'queue', s), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, 'queue', 'file-length-flags.json'), JSON.stringify({
    findings: files.map((f) => ({ file: f, lines: 6000 })),
  }));
  return dir;
}

function writeFixtureSource(dir, relPath, symbolNames) {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, symbolNames.map((n) => `function ${n}() {}`).join('\n') + '\n');
}

function fakeCall(moves) {
  return async () => ({ response: JSON.stringify(moves) });
}

const SYMS = ['renderA', 'renderB', 'renderC', 'renderD', 'extra1', 'extra2'];
const MOVES = [
  { newFile: 'src/lib/a.js', kind: 'script-extract', symbols: ['renderA', 'renderB'] },
  { newFile: 'src/lib/b.js', kind: 'script-extract', symbols: ['renderC', 'renderD'] },
];

// 2026-09-14: CHECK_INTERVAL_MS is now a short floor (minutes, not a day -- see the
// module header's THROTTLE note) so the sweep can respond to a freshly-merged branch
// within about a minute rather than waiting up to 24h. Read the real exported constant
// rather than hardcoding a duration, so this test tracks whatever it's actually set to.
test('isDue: true on a fresh instancesDir (never checked), false right after markChecked, true again after CHECK_INTERVAL_MS', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proactive-instances-'));
  assert.equal(isDue(dir), true);
  const now = new Date('2026-01-01T00:00:00Z');
  markChecked(dir, now);
  assert.equal(isDue(dir, now), false);
  assert.equal(isDue(dir, new Date(now.getTime() + CHECK_INTERVAL_MS - 1)), false);
  assert.equal(isDue(dir, new Date(now.getTime() + CHECK_INTERVAL_MS + 1)), true);
});

test('sweep: not due and not forced -> no-op, nothing filed', async () => {
  const dir = tmpPipeline(['src/big.js']);
  markChecked(path.join(dir, 'instances'));
  writeFixtureSource(dir, 'src/big.js', SYMS);
  const summary = await sweep({ pipelineDir: dir, repoRoot: dir, call: fakeCall(MOVES) });
  assert.equal(summary.due, false);
  assert.equal(fs.readdirSync(path.join(dir, 'queue', 'file-decompose-requests')).length, 0);
});

test('sweep: force=true runs even when not due, and files a request for a genuinely oversized file', async () => {
  const dir = tmpPipeline(['src/big.js']);
  markChecked(path.join(dir, 'instances'));
  writeFixtureSource(dir, 'src/big.js', SYMS);

  const summary = await sweep({ pipelineDir: dir, repoRoot: dir, call: fakeCall(MOVES), force: true });
  assert.equal(summary.filed, 1);

  const reqs = fs.readdirSync(path.join(dir, 'queue', 'file-decompose-requests'));
  assert.equal(reqs.length, 1);
  const req = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'file-decompose-requests', reqs[0]), 'utf8'));
  assert.equal(req.sourceFile, 'src/big.js');
  assert.match(req.note, /no waiting task/);

  // Hub/one-pass materialised in the same run -- not left as a dangling request.
  assert.ok(req.hubId || req.onePassTaskId, 'request was processed into a real hub or one-pass task this same run');
});

test('sweep: due (no force needed) also files, and marks the schedule so the next call is not due', async () => {
  const dir = tmpPipeline(['src/big.js']);
  writeFixtureSource(dir, 'src/big.js', SYMS);

  const summary = await sweep({ pipelineDir: dir, repoRoot: dir, call: fakeCall(MOVES) });
  assert.equal(summary.due, true);
  assert.equal(summary.filed, 1);
  assert.equal(isDue(path.join(dir, 'instances')), false, 'schedule stamped after a real run');
});

test('sweep: a file that already has ANY existing file-decompose-request is skipped, not re-filed', async () => {
  const dir = tmpPipeline(['src/big.js']);
  writeFixtureSource(dir, 'src/big.js', SYMS);
  fs.writeFileSync(path.join(dir, 'queue', 'file-decompose-requests', 'hand-authored.json'),
    JSON.stringify({ id: 'hand-authored', sourceFile: 'src/big.js', moves: [] }));

  const summary = await sweep({ pipelineDir: dir, repoRoot: dir, call: fakeCall(MOVES), force: true });
  assert.equal(summary.filed, 0);
  assert.equal(summary.skipped, 1);
  assert.equal(fs.readdirSync(path.join(dir, 'queue', 'file-decompose-requests')).length, 1, 'still just the one pre-existing request');
});

// 2026-09-14 regression, caught live on this feature's own first production run: app.py
// had 8 RESOLVED requests already on file (this session's own manual slices, each
// stamped hubId/onePassTaskId once processed) -- the original check counted every one as
// still "outstanding" and would have skipped app.py forever, since a file this large
// legitimately needs many successive requests over time.
test('isRequestResolved: false with no linked hub/onePassTaskId yet; true once the linked task reached queue/done/', () => {
  const dir = tmpPipeline([]);
  assert.equal(isRequestResolved(dir, { sourceFile: 'x.py', moves: [] }), false, 'never processed yet -- not resolved');
  assert.equal(isRequestResolved(dir, { sourceFile: 'x.py', onePassTaskId: 'op-1' }), false, 'linked but the task has not landed in done/ yet');

  fs.writeFileSync(path.join(dir, 'queue', 'done', 'op-1.json'), JSON.stringify({ id: 'op-1' }));
  assert.equal(isRequestResolved(dir, { sourceFile: 'x.py', onePassTaskId: 'op-1' }), true);
});

test('isRequestResolved: also true for a hub that reached done/, or a task an operator discarded to done/_archived_no_action/', () => {
  const dir = tmpPipeline([]);
  fs.writeFileSync(path.join(dir, 'queue', 'done', 'hub-1.json'), JSON.stringify({ id: 'hub-1' }));
  assert.equal(isRequestResolved(dir, { sourceFile: 'x.py', hubId: 'hub-1' }), true);

  fs.writeFileSync(path.join(dir, 'queue', 'done', '_archived_no_action', 'op-2.json'), JSON.stringify({ id: 'op-2' }));
  assert.equal(isRequestResolved(dir, { sourceFile: 'x.py', onePassTaskId: 'op-2' }), true, 'a discarded/dismissed task still counts as resolved -- it no longer blocks a fresh slice');
});

// 2026-09-14, caught live on the deployed fix's first forced run: done-archive.js's own
// routine retention sweep had already relocated 2 of app.py's resolved hubs from
// queue/done/ into a dated queue/done/_archived/<YYYY-MM>/ bucket by the time this ran --
// isRequestResolved's first version didn't know about that bucket, so those requests
// still read as unresolved and kept blocking app.py exactly like the original bug.
test('isRequestResolved: also true once done-archive.js has relocated the linked task into a dated done/_archived/<YYYY-MM>/ bucket', () => {
  const dir = tmpPipeline([]);
  const monthDir = path.join(dir, 'queue', 'done', '_archived', '2026-09');
  fs.mkdirSync(monthDir, { recursive: true });
  fs.writeFileSync(path.join(monthDir, 'hub-old.json'), JSON.stringify({ id: 'hub-old' }));
  assert.equal(isRequestResolved(dir, { sourceFile: 'x.py', hubId: 'hub-old' }), true);
});

test('hasExistingRequestFor: a file whose only requests are all RESOLVED is treated as free for a new one', () => {
  const dir = tmpPipeline([]);
  fs.writeFileSync(path.join(dir, 'queue', 'done', 'op-done.json'), JSON.stringify({ id: 'op-done' }));
  fs.writeFileSync(path.join(dir, 'queue', 'file-decompose-requests', 'old-resolved.json'),
    JSON.stringify({ id: 'old-resolved', sourceFile: 'python/dashboard/app.py', onePassTaskId: 'op-done' }));

  assert.equal(hasExistingRequestFor(dir, 'python/dashboard/app.py'), false, 'the one existing request for this file is fully resolved -- not blocking');
});

test('sweep: a big file with only RESOLVED prior requests (this session\'s own app.py shape) is picked up again, not skipped forever', async () => {
  const dir = tmpPipeline(['src/big.js']);
  writeFixtureSource(dir, 'src/big.js', SYMS);
  fs.writeFileSync(path.join(dir, 'queue', 'done', 'op-done.json'), JSON.stringify({ id: 'op-done' }));
  fs.writeFileSync(path.join(dir, 'queue', 'file-decompose-requests', 'old-resolved.json'),
    JSON.stringify({ id: 'old-resolved', sourceFile: 'src/big.js', onePassTaskId: 'op-done' }));

  const summary = await sweep({ pipelineDir: dir, repoRoot: dir, call: fakeCall(MOVES), force: true });
  assert.equal(summary.filed, 1, 'the file gets a fresh request even with 8 (here: 1) resolved ones already on file');
  assert.equal(fs.readdirSync(path.join(dir, 'queue', 'file-decompose-requests')).length, 2);
});

// 2026-09-14 fix (screaminggoatclubmt: "why is that timer set to a week" -- the hot-file
// check used to run HERE, before a plan even existed, and blocked this exact fixture's
// Tier-1-eligible plan (self-contained JS functions -> planIsFullyMechanicalNodeModule)
// for a full week even though a Tier-1 one-pass is a single commit that can't go stale.
// It now only applies inside file-decompose-to-hub.js's Tier-2 hub path (hot-file-guard.js)
// -- this fixture is Tier-1-eligible, so a recent commit no longer blocks it at all.
test('sweep: a file with a recent commit (hot file) still files -- this fixture is Tier-1-eligible (self-contained JS), which is exempt from the hot-file guard', async () => {
  const dir = tmpPipeline(['src/big.js']);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'x'], { cwd: dir });
  writeFixtureSource(dir, 'src/big.js', SYMS);
  // A leading side-effect require() -- 2026-09-14: validatePlan now only routes a .js
  // source through the CommonJS one-pass builder when it actually looks like a Node
  // module (require()/module.exports somewhere); this fixture needs to genuinely look
  // like one to stay Tier-1-eligible. A bare `require('fs')` (not bound to a name, and
  // referencing none of the symbol names) satisfies that without creating a spurious
  // cross-reference the fan-out filter would then have to treat as real -- a trailing
  // `module.exports = { every symbol }` line was tried first and rejected the whole
  // fixture instead, since IT genuinely references every symbol from outside each one's
  // own section.
  fs.writeFileSync(path.join(dir, 'src/big.js'), `require('fs');\n\n${fs.readFileSync(path.join(dir, 'src/big.js'), 'utf8')}`);
  execFileSync('git', ['add', 'src/big.js'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'recent'], { cwd: dir });

  const summary = await sweep({ pipelineDir: dir, repoRoot: dir, call: fakeCall(MOVES), force: true });
  assert.equal(summary.filed, 1);
  assert.equal(summary.deferred, 0);
});

// The hot-file guard's actual remaining target: a plan that is NOT Tier-1-eligible (forced
// here via AGENT_MANAGER_DECOMPOSE_NODE_MODULE=false, same fixture) falls through to the
// multi-day Tier-2 hub path in file-decompose-to-hub.js, which IS still hot-file-gated.
test('sweep: a file with a recent commit whose plan is NOT Tier-1-eligible is deferred, not filed', async () => {
  const dir = tmpPipeline(['src/big.js']);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'x'], { cwd: dir });
  writeFixtureSource(dir, 'src/big.js', SYMS);
  execFileSync('git', ['add', 'src/big.js'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'recent'], { cwd: dir });

  const prev = process.env.AGENT_MANAGER_DECOMPOSE_NODE_MODULE;
  process.env.AGENT_MANAGER_DECOMPOSE_NODE_MODULE = 'false';
  try {
    const summary = await sweep({ pipelineDir: dir, repoRoot: dir, call: fakeCall(MOVES), force: true });
    assert.equal(summary.filed, 0);
    assert.equal(summary.deferred, 1);
  } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_DECOMPOSE_NODE_MODULE; else process.env.AGENT_MANAGER_DECOMPOSE_NODE_MODULE = prev;
  }
});

test('sweep: bounded to MAX_FILES_PER_RUN (1) even with 2 eligible oversized files', async () => {
  const dir = tmpPipeline(['src/big1.js', 'src/big2.js']);
  writeFixtureSource(dir, 'src/big1.js', SYMS);
  writeFixtureSource(dir, 'src/big2.js', SYMS);

  const summary = await sweep({ pipelineDir: dir, repoRoot: dir, call: fakeCall(MOVES), force: true });
  assert.equal(summary.filed, 1);
  assert.equal(fs.readdirSync(path.join(dir, 'queue', 'file-decompose-requests')).length, 1);
});

test('sweep: AGENT_MANAGER_PROACTIVE_FILE_DECOMPOSE=false is a total no-op, even with force', async () => {
  const dir = tmpPipeline(['src/big.js']);
  writeFixtureSource(dir, 'src/big.js', SYMS);
  const prev = process.env.AGENT_MANAGER_PROACTIVE_FILE_DECOMPOSE;
  process.env.AGENT_MANAGER_PROACTIVE_FILE_DECOMPOSE = 'false';
  try {
    const summary = await sweep({ pipelineDir: dir, repoRoot: dir, call: fakeCall(MOVES), force: true });
    assert.equal(summary.filed, 0);
    assert.equal(fs.readdirSync(path.join(dir, 'queue', 'file-decompose-requests')).length, 0);
  } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_PROACTIVE_FILE_DECOMPOSE; else process.env.AGENT_MANAGER_PROACTIVE_FILE_DECOMPOSE = prev;
  }
});

test('sweep: no oversized files at all -> due but nothing to do, still marks checked', async () => {
  const dir = tmpPipeline([]);
  const summary = await sweep({ pipelineDir: dir, repoRoot: dir, call: fakeCall(MOVES) });
  assert.equal(summary.due, true);
  assert.equal(summary.filed, 0);
  assert.equal(isDue(path.join(dir, 'instances')), false, 'still marks checked on a clean run');
});

// --- outstanding-branches cap (2026-09-14) -------------------------------------------

function writeDecomposeTask(dir, subdir, id, { decomposedFrom, deterministicApply, applied = true, merged = false }) {
  const promptContext = { decomposedFrom };
  if (deterministicApply) promptContext.deterministicApply = deterministicApply;
  const history = [];
  if (applied) history.push({ stage: 'applied', at: new Date().toISOString() });
  if (merged) history.push({ stage: 'merged', at: new Date().toISOString() });
  fs.writeFileSync(path.join(dir, 'queue', subdir, `${id}.json`), JSON.stringify({ id, promptContext, history }, null, 2));
}

test('countOutstandingDecomposeBranches: counts applied-not-merged decompose tasks, split Tier1/Tier2; ignores merged, un-applied, and non-decompose tasks', () => {
  const dir = tmpPipeline([]);
  // Tier1: one-pass, applied, not merged -- counts
  writeDecomposeTask(dir, 'done', 'onepass-1', { decomposedFrom: 'file-decompose-a', deterministicApply: 'one-pass-decompose' });
  // Tier2: a hub move child, applied, not merged -- counts
  writeDecomposeTask(dir, 'done', 'move-1', { decomposedFrom: 'file-decompose-hub-b' });
  // Already merged -- does not count
  writeDecomposeTask(dir, 'done', 'onepass-2', { decomposedFrom: 'file-decompose-c', deterministicApply: 'one-pass-decompose', merged: true });
  // Not yet applied -- does not count
  writeDecomposeTask(dir, 'adhoc', 'onepass-3', { decomposedFrom: 'file-decompose-d', deterministicApply: 'one-pass-decompose', applied: false });
  // Not decompose-derived at all -- does not count even though applied
  writeDecomposeTask(dir, 'done', 'unrelated-1', { decomposedFrom: 'adhoc-brain-dump-bd-123' });
  // The coordinator hub record itself (self-referential decomposedFrom, no `applied` stage) -- must not double-count
  fs.writeFileSync(path.join(dir, 'queue', 'coordinating', 'file-decompose-hub-b.json'),
    JSON.stringify({ id: 'file-decompose-hub-b', promptContext: { decomposedFrom: 'file-decompose-hub-b' }, history: [] }));

  const counts = countOutstandingDecomposeBranches(dir);
  assert.equal(counts.tier1, 1);
  assert.equal(counts.tier2, 1);
});

test('sweep: both tier caps full -> capped, nothing filed, schedule still marked', async () => {
  const dir = tmpPipeline(['src/big.js']);
  writeFixtureSource(dir, 'src/big.js', SYMS);
  for (let i = 0; i < TIER1_CAP; i += 1) {
    writeDecomposeTask(dir, 'done', `onepass-${i}`, { decomposedFrom: `file-decompose-t1-${i}`, deterministicApply: 'one-pass-decompose' });
  }
  for (let i = 0; i < TIER2_CAP; i += 1) {
    writeDecomposeTask(dir, 'done', `move-${i}`, { decomposedFrom: `file-decompose-hub-t2-${i}` });
  }

  const summary = await sweep({ pipelineDir: dir, repoRoot: dir, call: fakeCall(MOVES), force: true });
  assert.equal(summary.capped, true);
  assert.equal(summary.filed, 0);
  assert.equal(fs.readdirSync(path.join(dir, 'queue', 'file-decompose-requests')).length, 0);
  assert.equal(isDue(path.join(dir, 'instances')), false, 'schedule still marked so the floor interval still applies');
});

test('sweep: Tier1 at cap but Tier2 has room -> still proceeds (only ONE tier needs headroom)', async () => {
  const dir = tmpPipeline(['src/big.js']);
  writeFixtureSource(dir, 'src/big.js', SYMS);
  for (let i = 0; i < TIER1_CAP; i += 1) {
    writeDecomposeTask(dir, 'done', `onepass-${i}`, { decomposedFrom: `file-decompose-t1-${i}`, deterministicApply: 'one-pass-decompose' });
  }

  const summary = await sweep({ pipelineDir: dir, repoRoot: dir, call: fakeCall(MOVES), force: true });
  assert.equal(summary.capped, false);
  assert.equal(summary.filed, 1);
});
