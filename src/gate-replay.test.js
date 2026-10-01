'use strict';

// Tests for src/gate-replay.js and its sandbox-side runner. The replay is exercised for real: a throwaway git repo holds the "base" gate, the working tree holds the
// "diff" version, the corpus is a fake pipeline's queue/done, and `run` is a test double that executes the copied runner with plain node (no bwrap) in the worktree.
//
// Run: node --test src/gate-replay.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const { findGateCandidates, inferFamily, replayGates, replayVerdict } = require('./gate-replay.js');
const { classify } = require('./gate-replay-runner.js');

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
const nodeRun = ({ worktreeDir, args }) => {
  const r = spawnSync(process.execPath, args, { cwd: worktreeDir, encoding: 'utf8', timeout: 60000 });
  return { ran: true, exitCode: r.status, timedOut: false, output: `${r.stdout || ''}${r.stderr || ''}` };
};

// A repo whose committed src/gate.js is `baseSrc`; the working tree gets `afterSrc`. Returns { dir, rawDiff }.
function makeRepo(baseSrc, afterSrc, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-replay-wt-'));
  git(dir, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  if (baseSrc != null) fs.writeFileSync(path.join(dir, 'src', 'gate.js'), baseSrc);
  fs.writeFileSync(path.join(dir, 'README.md'), 'x');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
  fs.writeFileSync(path.join(dir, 'src', 'gate.js'), afterSrc);
  for (const [f, c] of Object.entries(extra)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  git(dir, 'add', '-N', '.');
  return { dir, rawDiff: git(dir, 'diff') };
}

// A fake pipeline: n merged tasks of which `bad` carry the marker word, plus a few unmerged ones.
function makePipeline({ merged = 30, bad = 0, unmerged = 3, marker = 'FORBIDDEN' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-replay-pipe-'));
  const done = path.join(dir, 'queue', 'done');
  fs.mkdirSync(done, { recursive: true });
  for (let i = 0; i < merged + unmerged; i += 1) {
    const isMerged = i < merged;
    const text = i < bad ? `edit ${marker} thing ${i}` : `ordinary draft ${i}`;
    fs.writeFileSync(path.join(done, `t-${i}.json`), JSON.stringify({ id: `t-${i}`, implementResponse: text, mergedAt: isMerged ? `2026-09-${String(10 + (i % 15)).padStart(2, '0')}T00:00:00Z` : undefined }));
  }
  return dir;
}

const BASE_GATE = "'use strict';\nfunction checkDraftQuality(draftText, repoRoot) {\n  return { pass: true, violations: [] };\n}\nmodule.exports = { checkDraftQuality };\n";
const STRICT_GATE = "'use strict';\nfunction checkDraftQuality(draftText, repoRoot) {\n  const bad = /FORBIDDEN/.test(draftText);\n  return { pass: !bad, violations: bad ? [{ type: 'forbidden' }] : [] };\n}\nmodule.exports = { checkDraftQuality };\n";

test('inferFamily maps parameter names to a corpus and returns null for unknown signatures', () => {
  assert.equal(inferFamily(['draftText', 'repoRoot']), 'draft-text');
  assert.equal(inferFamily(['implementResponse', 'fetchedFiles', 'opts']), 'edit-ops');
  assert.equal(inferFamily(['implementResponse']), 'draft-text');
  assert.equal(inferFamily(['text', 'relPath']), 'file-text');
  assert.equal(inferFamily(['task']), null);
  assert.equal(inferFamily([]), null);
});

test('findGateCandidates: an added exported gate function is found; non-gate names, unexported functions and test files are not', () => {
  const after = "function checkThing(draftText) { return true; }\nfunction helperThing(x) { return x; }\nfunction detectHidden(text, relPath) { return []; }\nmodule.exports = { checkThing, helperThing };\n";
  const { dir, rawDiff } = makeRepo(null, after, { 'src/gate.test.js': "function checkInTest(text) { return 1; }\nmodule.exports = { checkInTest };\n" });
  const c = findGateCandidates(rawDiff, dir);
  assert.deepEqual(c.map((x) => x.name), ['checkThing']);
  assert.equal(c[0].isNew, true);
  assert.deepEqual(c[0].params, ['draftText']);
});

test('findGateCandidates: a gate whose BODY changes is found by mapping the touched lines onto its range', () => {
  const base = "'use strict';\nfunction checkOne(draftText) {\n  const a = 1;\n  const b = 2;\n  const c = 3;\n  const d = 4;\n  const e = 5;\n  const f = 6;\n  return draftText.length > 0;\n}\nmodule.exports = { checkOne };\n";
  const after = base.replace('const f = 6;', 'const f = 7; // changed');
  const { dir, rawDiff } = makeRepo(base, after);
  const c = findGateCandidates(rawDiff, dir);
  assert.deepEqual(c.map((x) => x.name), ['checkOne']);
  assert.equal(c[0].isNew, false);
});

test('findGateCandidates: a diff that only DELETES a line inside a gate still finds the gate (a removed guard is a gate change)', () => {
  const base = "'use strict';\nfunction checkOne(draftText) {\n  if (!draftText) return false;\n  if (draftText.length > 9) return false;\n  return true;\n}\nmodule.exports = { checkOne };\n";
  const after = base.replace("  if (draftText.length > 9) return false;\n", '');
  const { dir, rawDiff } = makeRepo(base, after);
  assert.deepEqual(findGateCandidates(rawDiff, dir).map((x) => x.name), ['checkOne']);
});

test('classify normalises the result shapes gates return, and refuses to guess an ambiguous boolean', () => {
  assert.equal(classify({ pass: false, violations: [{ type: 'x' }] }, 'checkX').flagged, true);
  assert.equal(classify({ pass: true, violations: [] }, 'checkX').flagged, false);
  assert.equal(classify({ problem: 'wrong-block' }, 'findUnverifiedEdit').flagged, true);
  assert.equal(classify(null, 'findUnverifiedEdit').flagged, false);
  assert.equal(classify([], 'detectX').flagged, false);
  assert.equal(classify([{ line: 1 }], 'detectX').flagged, true);
  assert.equal(classify(true, 'isTruncated').flagged, true);
  assert.equal(classify(false, 'isValid').flagged, true, 'a false from an isValid-style gate is a flag');
  assert.equal(classify(true, 'isValid').flagged, false);
  assert.equal(classify(true, 'doTheThing').flagged, null);
  assert.equal(classify({ truncated: false, reason: null }, 'detectTruncatedImplementResponse').flagged, false, 'a result object with a boolean verdict field is read by that field');
  assert.equal(classify({ truncated: true, reason: 'truncated output' }, 'detectTruncatedImplementResponse').flagged, true);
});

test('replayGates: a gate that newly flags merged work is measured against the base and the verdict blocks', () => {
  const { dir, rawDiff } = makeRepo(BASE_GATE, STRICT_GATE);
  const pipe = makePipeline({ merged: 30, bad: 6 });
  const r = replayGates({ rawDiff, worktreeDir: dir, pipelineDir: pipe, mainBranch: 'main', run: nodeRun });
  assert.equal(r.candidates.length, 1, JSON.stringify(r.skipped));
  const c = r.candidates[0];
  assert.equal(c.family, 'draft-text');
  assert.equal(c.mergedTotal, 30);
  assert.equal(c.before.flaggedMerged, 0);
  assert.equal(c.after.flaggedMerged, 6);
  assert.equal(c.newlyFlaggedMergedCount, 6);
  assert.ok(Math.abs(c.rateMerged - 0.2) < 1e-9);
  const v = replayVerdict(r);
  assert.equal(v.block, true);
  assert.match(v.reasons[0], /checkDraftQuality .*would flag 6 of 30 already-merged tasks \(20\.0%/);
});

test('replayGates: a gate that flags no merged work passes, even though it flags unmerged work', () => {
  const lenient = STRICT_GATE.replace('/FORBIDDEN/.test(draftText)', '/ZZZNEVER/.test(draftText)');
  const { dir, rawDiff } = makeRepo(BASE_GATE, lenient);
  const pipe = makePipeline({ merged: 30, bad: 0 });
  const r = replayGates({ rawDiff, worktreeDir: dir, pipelineDir: pipe, mainBranch: 'main', run: nodeRun });
  assert.equal(r.candidates[0].after.flaggedMerged, 0);
  assert.equal(replayVerdict(r).block, false);
});

test('replayVerdict: a flag rate under the limit, a base that already flagged the same tasks, or a corpus under 20 merged tasks never blocks', () => {
  const mk = (over) => ({ candidates: [{ name: 'g', file: 'src/g.js', blocking: true, mergedTotal: 100, rateMerged: 0.01, newlyFlaggedMergedCount: 1, after: { flaggedMerged: 1 }, before: null, newlyFlaggedMerged: [{ id: 'a' }], ...over }] });
  assert.equal(replayVerdict(mk({})).block, false, 'under the 2% limit');
  assert.equal(replayVerdict(mk({ rateMerged: 0.1, newlyFlaggedMergedCount: 0 })).block, false, 'nothing is NEWLY flagged');
  assert.equal(replayVerdict(mk({ rateMerged: 0.5, mergedTotal: 10 })).block, false, 'corpus too small to mean anything');
  assert.equal(replayVerdict(mk({ rateMerged: 0.1, blocking: false })).block, false, 'a reported-only family never blocks');
  assert.equal(replayVerdict(mk({ rateMerged: 0.1 })).block, true);
  assert.equal(replayVerdict(mk({ rateMerged: 0.1 }), { maxRate: 0.2 }).block, false, 'the limit is configurable');
});

test('replayGates: no corpus, an unknown signature and a throwing gate are reported without blocking', () => {
  const noCorpus = makeRepo(BASE_GATE, STRICT_GATE);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-replay-empty-'));
  let r = replayGates({ rawDiff: noCorpus.rawDiff, worktreeDir: noCorpus.dir, pipelineDir: empty, mainBranch: 'main', run: nodeRun });
  assert.equal(r.candidates.length, 0);
  assert.match(r.skipped[0].reason, /no corpus/);
  assert.equal(replayVerdict(r).block, false);

  const odd = makeRepo(null, "function checkTask(task, ctx) { return { pass: false }; }\nmodule.exports = { checkTask };\n");
  r = replayGates({ rawDiff: odd.rawDiff, worktreeDir: odd.dir, pipelineDir: makePipeline(), mainBranch: 'main', run: nodeRun });
  assert.match(r.skipped[0].reason, /no corpus for the signature \(checkTask\(task, ctx\)\)/);

  const thrower = makeRepo(null, "function checkBoom(draftText) { throw new Error('boom'); }\nmodule.exports = { checkBoom };\n");
  r = replayGates({ rawDiff: thrower.rawDiff, worktreeDir: thrower.dir, pipelineDir: makePipeline(), mainBranch: 'main', run: nodeRun });
  assert.equal(r.candidates[0].after.flagged, 0, 'a throw is an error, not a flag');
  assert.ok(r.candidates[0].after.errors > 0);
  assert.equal(replayVerdict(r).block, false);
});

test('replayGates: the sandbox being unavailable is reported, and the scratch artifacts are always removed', () => {
  const { dir, rawDiff } = makeRepo(BASE_GATE, STRICT_GATE);
  const r = replayGates({ rawDiff, worktreeDir: dir, pipelineDir: makePipeline({ bad: 3 }), mainBranch: 'main', run: () => ({ ran: false, reason: 'bwrap sandbox unavailable' }) });
  assert.equal(r.candidates.length, 0);
  assert.match(r.skipped[0].reason, /bwrap sandbox unavailable/);
  assert.ok(!fs.existsSync(path.join(dir, '.gate-replay')), 'artifact dir removed');
  assert.ok(!fs.existsSync(path.join(dir, 'src', 'gate.__gate_replay_base.js')), 'base copy removed');
  const ok = replayGates({ rawDiff, worktreeDir: dir, pipelineDir: makePipeline({ bad: 3 }), mainBranch: 'main', run: nodeRun });
  assert.equal(ok.candidates.length, 1);
  assert.ok(!fs.existsSync(path.join(dir, '.gate-replay')), 'artifact dir removed after a real run too');
  assert.ok(!fs.existsSync(path.join(dir, 'src', 'gate.__gate_replay_base.js')));
});

test('replayGates: a new file (no base) has no before side, and the edit-ops family replays merged edits with their fetched files', () => {
  const gate = "function findUnverifiedEdit(implementResponse, fetchedFiles, opts) {\n  const ops = JSON.parse(implementResponse);\n  const bad = ops.some((o) => /BADWORD/.test(o.replace || ''));\n  return bad ? { problem: 'bad' } : null;\n}\nmodule.exports = { findUnverifiedEdit };\n";
  const { dir, rawDiff } = makeRepo(null, gate);
  const pipe = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-replay-pipe-'));
  fs.mkdirSync(path.join(pipe, 'queue', 'done'), { recursive: true });
  for (let i = 0; i < 25; i += 1) {
    const replace = i < 5 ? 'BADWORD here' : 'fine';
    fs.writeFileSync(path.join(pipe, 'queue', 'done', `e-${i}.json`), JSON.stringify({ id: `e-${i}`, mergedAt: '2026-09-20T00:00:00Z',
      implementResponse: JSON.stringify([{ mode: 'edit', file: 'a.js', find: 'x', replace }]), promptContext: { fetchedFiles: [{ path: 'a.js', content: 'x' }] } }));
  }
  const r = replayGates({ rawDiff, worktreeDir: dir, pipelineDir: pipe, mainBranch: 'main', run: nodeRun });
  assert.equal(r.candidates.length, 1, JSON.stringify(r.skipped));
  const c = r.candidates[0];
  assert.equal(c.family, 'edit-ops');
  assert.equal(c.before, null, 'a brand-new gate has no base side');
  assert.equal(c.after.flaggedMerged, 5);
  assert.equal(c.mergedTotal, 25);
  assert.equal(replayVerdict(r).block, true);
});

test('findGateCandidates ignores .cjs/.mjs files: the base copy is named by swapping .js, so for those it would be the file under test itself', () => {
  const { dir, rawDiff } = makeRepo(null, 'x', {});
  fs.writeFileSync(path.join(dir, 'src', 'gate.cjs'), "function checkIt(draftText) { return true; }\nmodule.exports = { checkIt };\n");
  fs.writeFileSync(path.join(dir, 'src', 'gate2.mjs'), "export function checkIt2(draftText) { return true; }\n");
  git(dir, 'add', '-N', '.');
  assert.deepEqual(findGateCandidates(git(dir, 'diff'), dir), []);
});

test('the corpus total size is capped (newest first) so the sandbox input file stays bounded', () => {
  const { dir, rawDiff } = makeRepo(BASE_GATE, STRICT_GATE);
  const pipe = makePipeline({ merged: 60, bad: 0 });
  process.env.AGENT_MANAGER_GATE_REPLAY_MAX_CHARS = '1200';
  try {
    const r = replayGates({ rawDiff, worktreeDir: dir, pipelineDir: pipe, mainBranch: 'main', run: nodeRun });
    const c = r.candidates[0];
    assert.ok(c.total < 63, `capped corpus: ${c.total}`);
    assert.ok(c.total >= 1);
  } finally { delete process.env.AGENT_MANAGER_GATE_REPLAY_MAX_CHARS; }
});
