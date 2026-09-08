'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { execFileSync } = require('child_process');
const {
  autoConfirmReview, classifyVote, parseDeleteItems, buildForensicsConfirmPrompt, buildDebriefConfirmPrompt,
  gatherDeleteReferences,
} = require('./auto-confirm-review.js');

function makePipeline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-confirm-test-'));
  for (const s of ['awaiting-confirm', 'approved', 'done/_archived_no_action']) {
    fs.mkdirSync(path.join(dir, 'queue', s), { recursive: true });
  }
  return dir;
}
const put = (dir, task) => fs.writeFileSync(
  path.join(dir, 'queue', 'awaiting-confirm', `${task.id}.json`), JSON.stringify(task, null, 2));
const at = (dir, state, id) => path.join(dir, 'queue', state, `${id}.json`);
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const exists = (p) => fs.existsSync(p);

// a majorityVote stub matching src/local-client.js's real return shape
const voteOf = (verdict, reason) => async () => ({
  verdict, confident: !!verdict, votes: verdict ? [{ verdict, response: `${verdict}: ${reason}` }] : [],
  realVoteCount: verdict ? 2 : 1, requestedVotes: 3, voteErrors: [],
});
const commonArgs = (dir) => ({
  pipelineDir: dir, repoRoot: dir, grepDirs: ['src'],
  candidatesPath: path.join(dir, 'CANDIDATES.md'),
});

const FORENSICS = {
  id: 'pf-1', source: 'pipeline_forensics', status: 'awaiting-confirm', history: [],
  title: 'Pipeline forensics: observability_review',
  implementResponse: 'ROOT CAUSE RANKING\n1. ...\nRECOMMENDED FOLLOW-UP FIX\nFiles: src/prompts.js',
};
const DEBRIEF = {
  id: 'pd-1', source: 'pipeline_debrief', status: 'awaiting-confirm', history: [],
  title: 'Pipeline debrief: 25 completed tasks',
  promptContext: { windowStart: '2026-09-06T00:00:00.000Z', windowEnd: '2026-09-06T01:00:00.000Z', taskIds: ['t1', 't2'] },
  implementResponse: 'WHAT\nstuff shipped\n\nSO WHAT\na pattern\n\nSURVIVORSHIP-BIAS CHECK\nchecked\n\nNOW WHAT\n1. Do a thing. -- Files: src/a.js. Why: reason.',
};
const DELETE_BATCH = {
  id: 'ob-1', source: 'observability_fix', status: 'awaiting-confirm', history: [],
  title: 'remove the dead shim', planResponse: 'delete src/old-shim.js, it is unused',
  implementResponse: JSON.stringify([{ mode: 'delete', file: 'src/old-shim.js' }]),
};

test('classifyVote maps a marker line, rejects too-short reasoning', () => {
  const c = classifyVote(['CONFIRM', 'DENY'], 15);
  assert.equal(c('CONFIRM: this is a solid, well-scoped pipeline fix'), 'CONFIRM');
  assert.equal(c('DENY: dupe of AC-4 and also touches unrelated files'), 'DENY');
  assert.equal(c('CONFIRM: ok'), null); // under 15 chars of reasoning
  assert.equal(c('no verdict here'), null);
});

test('parseDeleteItems pulls {mode:delete} items, tolerates non-delete/garbage', () => {
  assert.deepEqual(parseDeleteItems('[{"mode":"delete","file":"a.js"},{"mode":"edit","file":"b.js"}]'),
    [{ mode: 'delete', file: 'a.js' }]);
  assert.deepEqual(parseDeleteItems('not json'), []);
  assert.deepEqual(parseDeleteItems('{"mode":"create","file":"c.js"}'), []);
});

test('forensics prompt includes the report and the existing candidates doc', () => {
  const p = buildForensicsConfirmPrompt(FORENSICS, '### AC-4 · something\nSignature: x');
  assert.match(p, /RECOMMENDED FOLLOW-UP FIX/);
  assert.match(p, /AC-4/);
  assert.match(p, /CONFIRM: /);
  assert.match(p, /DENY: /);
});

test('confident CONFIRM: forensics task moves to approved/ with forensicsReportConfirmedAt', async () => {
  const dir = makePipeline();
  put(dir, FORENSICS);
  fs.writeFileSync(path.join(dir, 'CANDIDATES.md'), '# Pipeline Fix Candidates\n');
  const s = await autoConfirmReview({ ...commonArgs(dir), majorityVote: voteOf('CONFIRM', 'real fix, not a dupe') });

  assert.deepEqual({ confirmed: s.confirmed, denied: s.denied, escalated: s.escalated }, { confirmed: 1, denied: 0, escalated: 0 });
  assert.ok(!exists(at(dir, 'awaiting-confirm', 'pf-1')));
  const moved = read(at(dir, 'approved', 'pf-1'));
  assert.ok(moved.forensicsReportConfirmedAt, 'gate stamp set');
  assert.ok(moved.autoConfirmReviewedAt);
  assert.equal(moved.autoConfirmDecision, 'confirm');
  assert.equal(moved.status, 'approved');
  assert.ok(moved.history.some((h) => h.stage === 'approved' && /auto-confirmed/.test(h.detail)));
});

test('confident DENY: forensics task is archived to _archived_no_action/', async () => {
  const dir = makePipeline();
  put(dir, FORENSICS);
  const s = await autoConfirmReview({ ...commonArgs(dir), majorityVote: voteOf('DENY', 'NO CLEAR ROOT CAUSE') });

  assert.equal(s.denied, 1);
  assert.ok(!exists(at(dir, 'awaiting-confirm', 'pf-1')));
  const arch = read(at(dir, 'done/_archived_no_action', 'pf-1'));
  assert.equal(arch.status, 'done');
  assert.equal(arch.autoConfirmDecision, 'deny');
  assert.match(arch.doneMarker, /auto-denied/);
});

test('debrief prompt includes the report and the window summary', () => {
  const p = buildDebriefConfirmPrompt(DEBRIEF);
  assert.match(p, /WHAT/);
  assert.match(p, /NOW WHAT/);
  assert.match(p, /2 completed task\(s\)/);
  assert.match(p, /CONFIRM: /);
  assert.match(p, /DENY: /);
});

test('debrief gate requests only 1 vote (vs. forensics\' 3) -- lower stakes, no code diff, already majority-reviewed', async () => {
  const dir = makePipeline();
  put(dir, DEBRIEF);
  const calls = [];
  const capturingVote = async (opts) => { calls.push(opts); return { verdict: 'CONFIRM', confident: true, votes: [{ verdict: 'CONFIRM', response: 'CONFIRM: fine' }], realVoteCount: 1, requestedVotes: opts.n, voteErrors: [] }; };
  await autoConfirmReview({ ...commonArgs(dir), majorityVote: capturingVote });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].n, 1);
  assert.equal(calls[0].minAgreeing, 1);
});

test('forensics gate still requests the heavier default (3 votes, 2 agreeing) -- unaffected by the debrief-specific override', async () => {
  const dir = makePipeline();
  put(dir, FORENSICS);
  fs.writeFileSync(path.join(dir, 'CANDIDATES.md'), '# Pipeline Fix Candidates\n');
  const calls = [];
  const capturingVote = async (opts) => { calls.push(opts); return { verdict: 'CONFIRM', confident: true, votes: [{ verdict: 'CONFIRM', response: 'CONFIRM: fine' }], realVoteCount: 2, requestedVotes: opts.n, voteErrors: [] }; };
  await autoConfirmReview({ ...commonArgs(dir), majorityVote: capturingVote });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].n, 3);
  assert.equal(calls[0].minAgreeing, 2);
});

test('confident CONFIRM: debrief task moves to approved/ with debriefReportConfirmedAt', async () => {
  const dir = makePipeline();
  put(dir, DEBRIEF);
  const s = await autoConfirmReview({ ...commonArgs(dir), majorityVote: voteOf('CONFIRM', 'grounded in real task ids and costs') });

  assert.deepEqual({ confirmed: s.confirmed, denied: s.denied, escalated: s.escalated }, { confirmed: 1, denied: 0, escalated: 0 });
  assert.ok(!exists(at(dir, 'awaiting-confirm', 'pd-1')));
  const moved = read(at(dir, 'approved', 'pd-1'));
  assert.ok(moved.debriefReportConfirmedAt, 'gate stamp set');
  assert.ok(!moved.forensicsReportConfirmedAt, 'only the debrief gate stamp');
  assert.equal(moved.autoConfirmDecision, 'confirm');
});

test('confident DENY: debrief task is archived to _archived_no_action/', async () => {
  const dir = makePipeline();
  put(dir, DEBRIEF);
  const s = await autoConfirmReview({ ...commonArgs(dir), majorityVote: voteOf('DENY', 'NOW WHAT is vague hand-waving') });

  assert.equal(s.denied, 1);
  assert.ok(!exists(at(dir, 'awaiting-confirm', 'pd-1')));
  const arch = read(at(dir, 'done/_archived_no_action', 'pd-1'));
  assert.equal(arch.autoConfirmDecision, 'deny');
  assert.match(arch.doneMarker, /auto-denied/);
});

test('confident CONFIRM: delete batch gets deleteConfirmedAt and goes to approved/', async () => {
  const dir = makePipeline();
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'old-shim.js'), '// dead');
  put(dir, DELETE_BATCH);
  const s = await autoConfirmReview({ ...commonArgs(dir), majorityVote: voteOf('CONFIRM', 'no references, plan asks for it') });

  assert.equal(s.confirmed, 1);
  const moved = read(at(dir, 'approved', 'ob-1'));
  assert.ok(moved.deleteConfirmedAt);
  assert.ok(!moved.forensicsReportConfirmedAt, 'only the delete gate stamp');
});

test('inconclusive vote: task stays put, stamped reviewed, and a 2nd pass is a no-op', async () => {
  const dir = makePipeline();
  put(dir, FORENSICS);
  const args = { ...commonArgs(dir), majorityVote: voteOf(null) };

  const s1 = await autoConfirmReview(args);
  assert.equal(s1.escalated, 1);
  const held = read(at(dir, 'awaiting-confirm', 'pf-1'));
  assert.ok(exists(at(dir, 'awaiting-confirm', 'pf-1')));
  assert.ok(held.autoConfirmReviewedAt);
  assert.equal(held.autoConfirmDecision, 'escalate');
  assert.ok(held.history.some((h) => h.stage === 'advisory' && /inconclusive/.test(h.detail)));

  let voteCalls = 0;
  const s2 = await autoConfirmReview({ ...commonArgs(dir), majorityVote: async () => { voteCalls += 1; return voteOf('CONFIRM', 'x')(); } });
  assert.equal(voteCalls, 0, 'already-reviewed task is skipped');
  assert.equal(s2.checked, 0);
});

test('all votes hard-fail (majorityVote throws): task stays, NOT stamped, retried next tick', async () => {
  const dir = makePipeline();
  put(dir, FORENSICS);
  const boom = async () => { throw new Error('every vote timed out'); };
  const s = await autoConfirmReview({ ...commonArgs(dir), majorityVote: boom });

  assert.equal(s.errors, 1);
  const held = read(at(dir, 'awaiting-confirm', 'pf-1'));
  assert.ok(exists(at(dir, 'awaiting-confirm', 'pf-1')));
  assert.ok(!held.autoConfirmReviewedAt, 'not stamped -- will retry');
  assert.ok(held.history.some((h) => /could not run/.test(h.detail || '')));
});

test('unrecognised hold (no forensics, no delete): left for a human, stamped', async () => {
  const dir = makePipeline();
  put(dir, { id: 'weird-1', source: 'observability_fix', status: 'awaiting-confirm', history: [],
    implementResponse: JSON.stringify([{ mode: 'edit', file: 'a.js', find: 'x', replace: 'y' }]) });
  let voteCalls = 0;
  const s = await autoConfirmReview({ ...commonArgs(dir), majorityVote: async () => { voteCalls += 1; return voteOf('CONFIRM')(); } });

  assert.equal(voteCalls, 0);
  assert.equal(s.escalated, 1);
  const held = read(at(dir, 'awaiting-confirm', 'weird-1'));
  assert.equal(held.autoConfirmDecision, 'escalate');
  assert.match(held.autoConfirmReviewNote, /does not recognise/);
});

test('malformed JSON file: counted as an error, others still processed', async () => {
  const dir = makePipeline();
  fs.writeFileSync(at(dir, 'awaiting-confirm', 'broken'), '{ not json');
  put(dir, FORENSICS);
  const s = await autoConfirmReview({ ...commonArgs(dir), majorityVote: voteOf('CONFIRM', 'fine fix here') });

  assert.equal(s.errors, 1);
  assert.equal(s.confirmed, 1);
});

test('kill switch: AGENT_MANAGER_AUTO_CONFIRM_REVIEW=false returns early, touches nothing', async () => {
  const dir = makePipeline();
  put(dir, FORENSICS);
  const prev = process.env.AGENT_MANAGER_AUTO_CONFIRM_REVIEW;
  process.env.AGENT_MANAGER_AUTO_CONFIRM_REVIEW = 'false';
  try {
    const s = await autoConfirmReview({ ...commonArgs(dir), majorityVote: voteOf('CONFIRM', 'x') });
    assert.deepEqual(s, { checked: 0, confirmed: 0, denied: 0, escalated: 0, errors: 0 });
    assert.ok(exists(at(dir, 'awaiting-confirm', 'pf-1')));
  } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_AUTO_CONFIRM_REVIEW;
    else process.env.AGENT_MANAGER_AUTO_CONFIRM_REVIEW = prev;
  }
});

// --- gatherDeleteReferences: stacked-branch grounding (2026-09-08 incident) -------------
// A stacked task's delete-reference scan used to always grep repoRoot's plain working tree
// (main) -- a real reference to the file-being-deleted, added by a sibling task and sitting
// only on the shared stacked branch, was invisible, making a delete look safer than it is.

function makeGitRepoWithStackedBranch() {
  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-confirm-stacked-origin-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-confirm-stacked-repo-'));
  execFileSync('git', ['init', '--bare', '-b', 'main', bareDir]);
  execFileSync('git', ['clone', bareDir, repoDir]);
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'src', 'old-module.js'), '// to be deleted\n');
  execFileSync('git', ['add', '-A'], { cwd: repoDir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoDir });
  execFileSync('git', ['push', 'origin', 'main'], { cwd: repoDir });

  execFileSync('git', ['checkout', '-b', 'agent/stacked-family'], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, 'src', 'new-caller.js'), "const oldModule = require('./old-module.js');\n");
  execFileSync('git', ['add', 'src/new-caller.js'], { cwd: repoDir });
  execFileSync('git', ['commit', '-q', '-m', 'sibling adds a real reference'], { cwd: repoDir });
  execFileSync('git', ['push', 'origin', 'agent/stacked-family'], { cwd: repoDir });
  execFileSync('git', ['checkout', 'main'], { cwd: repoDir });

  return repoDir;
}

test('gatherDeleteReferences finds a stacked task\'s sibling-added reference living only on the stacked branch', () => {
  const repoRoot = makeGitRepoWithStackedBranch();
  const task = { id: 't-stacked', stacked: { branch: 'agent/stacked-family', seq: 2, total: 2 } };
  const refs = gatherDeleteReferences(repoRoot, ['src'], ['src/old-module.js'], task);
  assert.match(refs['src/old-module.js'], /possible reference line/);
  assert.match(refs['src/old-module.js'], /new-caller\.js/);
});

test('gatherDeleteReferences reports no references for a NON-stacked task (the sibling reference only exists on another branch)', () => {
  const repoRoot = makeGitRepoWithStackedBranch();
  const refs = gatherDeleteReferences(repoRoot, ['src'], ['src/old-module.js']);
  assert.match(refs['src/old-module.js'], /no references found/);
});
