'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { listUnverifiedBranchesTool, recordBranchVerdictTool } = require('./chat-branch-verdict.js');
const { saveBranchCheck } = require('./branch-check-store.js');

const SHA = 'a'.repeat(40);

// What check_branch stores for a branch whose covering tests ran green, and the loader that hands it to a merge verdict.
const greenCheck = (over = {}) => ({
  headSha: SHA, branch: 'agent/one', base: 'origin/master', repoRoot: '/repos/agent-manager', changedFiles: ['src/a.js'], docsOnly: false, harness: 'node-test', testsRun: true,
  checked: [
    { kind: 'static', what: 'missing local require in added JavaScript lines', command: '(static scan)', ok: true, summary: 'ok' },
    { kind: 'tests', what: 'node tests (1 covering file)', command: 'node --test src/a.test.js', ok: true, summary: 'exit 0' },
  ],
  notRun: [], durationMs: 5, checkedAt: '2026-10-29T10:00:00.000Z', ...over,
});
const withCheck = (check = greenCheck()) => ({ loadBranchCheck: () => check });
const row = (over = {}) => ({
  branch: 'agent/one', headSha: SHA, subject: 'One', ahead: 1, behind: 2, willConflict: false, hub: null, verdict: null, stale: false,
  project: { label: 'agent-manager', repoRoot: '/repos/agent-manager', active: true }, ...over,
});

// A fake dashboard: records every call and answers the listing and the verdict POST.
function fakeDashboard({ rows = [row()], post = { status: 200, json: { succeeded: true, written: true, headSha: SHA, verdict: 'merge' } }, listStatus = 200 } = {}) {
  const calls = [];
  const request = async (method, url, body) => {
    calls.push({ method, url, body });
    if (method === 'GET') return { status: listStatus, json: listStatus === 200 ? rows : null };
    if (post instanceof Error) throw post;
    return post;
  };
  return { request, calls };
}

test('list_unverified_branches returns only branches with no verdict or a stale one, slimmed to the useful fields', async () => {
  const d = fakeDashboard({ rows: [
    row({ branch: 'agent/none' }),
    row({ branch: 'agent/done', verdict: 'merge' }),
    row({ branch: 'agent/stale', verdict: 'needs-work', stale: true }),
  ] });
  const out = await listUnverifiedBranchesTool({}, { request: d.request });
  assert.equal(out.ok, true);
  assert.deepEqual(out.branches.map((b) => b.branch), ['agent/none', 'agent/stale']);
  assert.equal(out.needingVerdict, 2);
  assert.equal(out.branches[0].project, 'agent-manager');
  assert.equal(out.branches[0].headSha, SHA);
  assert.equal(out.branches[1].currentVerdict, 'needs-work');
  assert.deepEqual(d.calls.map((c) => c.url), ['/api/git/unmerged-branches?projects=all']);
});

test('list_unverified_branches includes hubId alongside hub id and progress when the hub has a record id', async () => {
  const hubbed = row({ branch: 'agent/hubbed', hub: { id: 'adhoc-abc123def456', label: 'HUB0251', progress: 'pending-merge' } });
  const d = fakeDashboard({ rows: [hubbed] });
  const out = await listUnverifiedBranchesTool({}, { request: d.request });
  assert.equal(out.ok, true);
  assert.equal(out.branches.length, 1);
  const hub = out.branches[0].hub;
  assert.deepEqual(hub, { id: 'adhoc-abc123def456', hubId: 'adhoc-abc123def456', progress: 'pending-merge' });
});

test('list_unverified_branches filters by project label or root, honours the limit, and names the known projects for an unknown one', async () => {
  const other = { label: 'sparforge', repoRoot: '/repos/sparforge', active: false };
  const d = fakeDashboard({ rows: [row({ branch: 'a' }), row({ branch: 'b' }), row({ branch: 's', project: other })] });
  assert.deepEqual((await listUnverifiedBranchesTool({ project: 'sparforge' }, { request: d.request })).branches.map((b) => b.branch), ['s']);
  assert.deepEqual((await listUnverifiedBranchesTool({ project: '/repos/agent-manager', limit: 1 }, { request: d.request })).branches.map((b) => b.branch), ['a']);
  const unknown = await listUnverifiedBranchesTool({ project: 'nope' }, { request: d.request });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /agent-manager, sparforge/);
});

test('a listing failure or an unreachable dashboard comes back as a plain error, not an exception', async () => {
  assert.match((await listUnverifiedBranchesTool({}, { request: fakeDashboard({ listStatus: 500 }).request })).error, /HTTP 500/);
  const down = async () => { throw new Error('ECONNREFUSED'); };
  assert.match((await listUnverifiedBranchesTool({}, { request: down })).error, /ECONNREFUSED/);
  assert.match((await recordBranchVerdictTool({ branch: 'agent/one', sha: 'aaaaaaa', verdict: 'merge', reasons: ['x'] }, { request: down })).error, /ECONNREFUSED/);
});

test('record_branch_verdict posts the verdict to the project-scoped route with the FULL head sha and source chat', async () => {
  const d = fakeDashboard();
  const out = await recordBranchVerdictTool({ branch: 'agent/one', sha: SHA.slice(0, 9), verdict: 'merge', reasons: ['ran the covering suite: 14 pass'] }, { request: d.request, ...withCheck() });
  assert.equal(out.ok, true);
  assert.equal(out.written, true);
  const post = d.calls.find((c) => c.method === 'POST');
  assert.equal(post.url, '/api/git/branches/agent/one/verdict?project=%2Frepos%2Fagent-manager');
  assert.deepEqual(post.body, { verdict: 'merge', reasons: ['ran the covering suite: 14 pass'], source: 'chat', sha: SHA });
});

test('record_branch_verdict reports a pending (held-hub) verdict as such', async () => {
  const d = fakeDashboard({ post: { status: 200, json: { succeeded: true, pending: true, headSha: SHA } } });
  const out = await recordBranchVerdictTool({ branch: 'agent/one', sha: SHA, verdict: 'needs-work', reasons: ['x'] }, { request: d.request });
  assert.equal(out.ok, true);
  assert.equal(out.pending, true);
  assert.match(out.message, /pending/i);
});

test('record_branch_verdict accepts only merge / needs-work / discard: HOLD, unverified and anything else are refused before any request', async () => {
  const d = fakeDashboard();
  for (const verdict of ['HOLD', 'hold', 'unverified', 'MERGE', '', undefined]) {
    const out = await recordBranchVerdictTool({ branch: 'agent/one', sha: SHA, verdict, reasons: ['x'] }, { request: d.request });
    assert.equal(out.ok, false, String(verdict));
    assert.match(out.error, /merge \/ needs-work \/ discard/);
  }
  assert.equal(d.calls.length, 0);
});

test('record_branch_verdict refuses empty or malformed reasons, a missing sha and a missing branch before any request', async () => {
  const d = fakeDashboard();
  const base = { branch: 'agent/one', sha: SHA, verdict: 'merge', reasons: ['x'] };
  for (const bad of [{ reasons: [] }, { reasons: ['  '] }, { reasons: 'because' }, { reasons: [1] }, { sha: '' }, { sha: 'zzzzzzz' }, { sha: 'abc' }, { branch: '' }]) {
    assert.equal((await recordBranchVerdictTool({ ...base, ...bad }, { request: d.request })).ok, false, JSON.stringify(bad));
  }
  assert.equal(d.calls.length, 0);
});

test('record_branch_verdict refuses a sha that is not the listed head (moved head) and does not POST', async () => {
  const d = fakeDashboard();
  const out = await recordBranchVerdictTool({ branch: 'agent/one', sha: 'bbbbbbb', verdict: 'merge', reasons: ['x'] }, { request: d.request });
  assert.equal(out.ok, false);
  assert.match(out.error, /moved|older listing/);
  assert.equal(out.headSha, SHA);
  assert.equal(d.calls.some((c) => c.method === 'POST'), false);
});

test('record_branch_verdict: an unlisted branch is a plain error; a branch name in two projects needs the project argument', async () => {
  const other = { label: 'sparforge', repoRoot: '/repos/sparforge', active: false };
  const d = fakeDashboard({ rows: [row(), row({ project: other, headSha: 'c'.repeat(40) })] });
  const args = { sha: SHA, verdict: 'discard', reasons: ['redundant'] };
  assert.match((await recordBranchVerdictTool({ ...args, branch: 'agent/missing' }, { request: d.request })).error, /not a currently listed/);
  assert.match((await recordBranchVerdictTool({ ...args, branch: 'agent/one' }, { request: d.request })).error, /more than one project/);
  const ok = await recordBranchVerdictTool({ ...args, branch: 'agent/one', project: 'agent-manager' }, { request: d.request });
  assert.equal(ok.ok, true);
  assert.equal(d.calls.filter((c) => c.method === 'POST').length, 1);
});

test('record_branch_verdict relays a route refusal (409 moved head, 404) as a readable error with the status', async () => {
  const moved = fakeDashboard({ post: { status: 409, json: { succeeded: false, reason: 'verdict is for an older commit; the branch head has moved', headSha: 'd'.repeat(40) } } });
  const a = await recordBranchVerdictTool({ branch: 'agent/one', sha: SHA, verdict: 'merge', reasons: ['x'] }, { request: moved.request, ...withCheck() });
  assert.equal(a.ok, false);
  assert.equal(a.status, 409);
  assert.match(a.error, /branch head has moved/);
  assert.equal(a.headSha, 'd'.repeat(40));
  const html404 = fakeDashboard({ post: { status: 404, json: null } });
  const b = await recordBranchVerdictTool({ branch: 'agent/one', sha: SHA, verdict: 'merge', reasons: ['x'] }, { request: html404.request, ...withCheck() });
  assert.match(b.error, /HTTP 404/);
});

test('branch names with slashes are encoded per segment so the route sees the real path', async () => {
  const d = fakeDashboard({ rows: [row({ branch: 'agent/decompose-adhoc-x y#1' })] });
  await recordBranchVerdictTool({ branch: 'agent/decompose-adhoc-x y#1', sha: SHA, verdict: 'merge', reasons: ['x'] }, { request: d.request, ...withCheck() });
  assert.match(d.calls.find((c) => c.method === 'POST').url, /^\/api\/git\/branches\/agent\/decompose-adhoc-x%20y%231\/verdict\?project=/);
});

// --- the gate: a merge verdict needs a current, green check of this exact head ---------------------------------------------------------------------------------

const mergeArgs = { branch: 'agent/one', sha: SHA, verdict: 'merge', reasons: ['read the diff: one small change'] };
const posts = (d) => d.calls.filter((c) => c.method === 'POST');

test('a merge verdict with no stored check is refused, names check_branch, and the route is never called', async () => {
  const d = fakeDashboard();
  const out = await recordBranchVerdictTool(mergeArgs, { request: d.request, loadBranchCheck: () => null });
  assert.equal(out.ok, false);
  assert.match(out.error, /^merge refused: there is no current check for this exact head\. Call check_branch for this branch first/);
  assert.match(out.error, /needs-work and discard can be recorded without a check/);
  assert.equal(out.headSha, SHA);
  assert.equal(posts(d).length, 0);
});

test('the check is looked up by the project root and the FULL listed head sha, even when the caller passed a prefix', async () => {
  const d = fakeDashboard();
  const asked = [];
  await recordBranchVerdictTool({ ...mergeArgs, sha: SHA.slice(0, 9) }, { request: d.request, loadBranchCheck: (...args) => { asked.push(args); return greenCheck(); } });
  assert.deepEqual(asked, [['/repos/agent-manager', SHA]]);
});

test('a green check that ran the covering tests lets the merge through to the route', async () => {
  const d = fakeDashboard();
  const out = await recordBranchVerdictTool(mergeArgs, { request: d.request, ...withCheck(greenCheck()) });
  assert.equal(out.ok, true);
  assert.equal(posts(d).length, 1);
});

test('a docs-only check lets a merge through even though no test ran', async () => {
  const d = fakeDashboard();
  const out = await recordBranchVerdictTool(mergeArgs, { request: d.request, ...withCheck(greenCheck({ docsOnly: true, testsRun: false, checked: [], harness: null })) });
  assert.equal(out.ok, true);
  assert.equal(posts(d).length, 1);
});

test('a check that ran only static scans is refused, with what was not run', async () => {
  const d = fakeDashboard();
  const staticOnly = greenCheck({ testsRun: false, harness: null, checked: [greenCheck().checked[0]], notRun: ['no test harness recognised for this repo'] });
  const out = await recordBranchVerdictTool(mergeArgs, { request: d.request, ...withCheck(staticOnly) });
  assert.equal(out.ok, false);
  assert.match(out.error, /^merge refused: the check of this head ran no tests \(no test harness recognised for this repo\)/);
  assert.equal(posts(d).length, 0);
});

test('testsRun has to be exactly true: a truthy stand-in is not accepted', async () => {
  const d = fakeDashboard();
  const out = await recordBranchVerdictTool(mergeArgs, { request: d.request, ...withCheck(greenCheck({ testsRun: 'yes' })) });
  assert.equal(out.ok, false);
  assert.equal(posts(d).length, 0);
});

test('a check with a red entry is refused naming the entry and its summary, even when tests ran', async () => {
  const d = fakeDashboard();
  const red = greenCheck({ checked: [
    { kind: 'static', what: 'undefined logger name in added Python lines', command: '(static scan)', ok: false, summary: 'proxy.py:307 uses logger but the module never imports or assigns it' },
    greenCheck().checked[1],
  ] });
  const out = await recordBranchVerdictTool(mergeArgs, { request: d.request, ...withCheck(red) });
  assert.equal(out.ok, false);
  assert.match(out.error, /1 red entry: undefined logger name in added Python lines \(proxy\.py:307 uses logger/);
  assert.equal(posts(d).length, 0);

  const two = greenCheck({ checked: [{ kind: 'tests', what: 'a', ok: false, summary: 'x' }, { kind: 'tests', what: 'b', ok: false, summary: 'y' }] });
  assert.match((await recordBranchVerdictTool(mergeArgs, { request: fakeDashboard().request, ...withCheck(two) })).error, /2 red entries: a \(x\); b \(y\)/);
});

test('needs-work and discard are never refused, never look up a check, and reach the route', async () => {
  for (const verdict of ['needs-work', 'discard']) {
    const d = fakeDashboard();
    let looked = 0;
    const out = await recordBranchVerdictTool({ ...mergeArgs, verdict }, { request: d.request, loadBranchCheck: () => { looked += 1; return null; } });
    assert.equal(out.ok, true, verdict);
    assert.equal(looked, 0, `${verdict} must not consult the store`);
    assert.equal(posts(d).length, 1);
  }
});

test('a loader that throws is read as no check: the merge is refused, not crashed', async () => {
  const d = fakeDashboard();
  const out = await recordBranchVerdictTool(mergeArgs, { request: d.request, loadBranchCheck: () => { throw new Error('store exploded'); } });
  assert.equal(out.ok, false);
  assert.match(out.error, /no current check/);
  assert.equal(posts(d).length, 0);
});

test('with the real store: a check saved for this repository and head lets the merge through; one saved for another head does not', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-branch-gate-test-'));
  const prev = process.env.AGENT_MANAGER_BRANCH_CHECK_DIR;
  process.env.AGENT_MANAGER_BRANCH_CHECK_DIR = dir;
  t.after(() => { if (prev === undefined) delete process.env.AGENT_MANAGER_BRANCH_CHECK_DIR; else process.env.AGENT_MANAGER_BRANCH_CHECK_DIR = prev; fs.rmSync(dir, { recursive: true, force: true }); });

  const none = fakeDashboard();
  assert.equal((await recordBranchVerdictTool(mergeArgs, { request: none.request })).ok, false, 'nothing stored yet');

  assert.equal(saveBranchCheck('/repos/agent-manager', greenCheck({ headSha: 'b'.repeat(40) })), true);
  const otherHead = fakeDashboard();
  assert.equal((await recordBranchVerdictTool(mergeArgs, { request: otherHead.request })).ok, false, 'a check of a different head is not this head');

  assert.equal(saveBranchCheck('/repos/agent-manager', greenCheck()), true);
  const stored = fakeDashboard();
  assert.equal((await recordBranchVerdictTool(mergeArgs, { request: stored.request })).ok, true);
  assert.equal(posts(stored).length, 1);

  const otherRepo = fakeDashboard({ rows: [row({ project: { label: 'sparforge', repoRoot: '/repos/sparforge', active: false } })] });
  assert.equal((await recordBranchVerdictTool(mergeArgs, { request: otherRepo.request })).ok, false, 'a check of another repository is not this one');
});

test('docsOnly has to be exactly true too, and a malformed stored check is refused rather than crashing the tool', async () => {
  const strict = await recordBranchVerdictTool(mergeArgs, { request: fakeDashboard().request, ...withCheck(greenCheck({ docsOnly: 'yes', testsRun: false, checked: [] })) });
  assert.equal(strict.ok, false);

  for (const malformed of [{ testsRun: false }, { testsRun: true, checked: 'nope' }, { testsRun: true, checked: [] }, { testsRun: true, checked: [{ kind: 'static', what: 's', ok: true }] }, { docsOnly: false }]) {
    const d = fakeDashboard();
    const out = await recordBranchVerdictTool(mergeArgs, { request: d.request, ...withCheck(malformed) });
    assert.equal(out.ok, false, JSON.stringify(malformed));
    assert.match(out.error, /ran no tests \(no reason given\)/);
  }
});

test('a very long red summary is cut so one refusal cannot flood the chat', async () => {
  const long = 'x'.repeat(2000);
  const out = await recordBranchVerdictTool(mergeArgs, { request: fakeDashboard().request, ...withCheck(greenCheck({ checked: [{ kind: 'tests', what: 'big run', ok: false, summary: long }] })) });
  assert.equal(out.ok, false);
  assert.ok(out.error.length < 600, `refusal is ${out.error.length} characters`);
  assert.match(out.error, /big run \(x{200}\)/);
});


test('the refusal reads cleanly when a red entry has no summary and when several things were not run', async () => {
  const bare = await recordBranchVerdictTool(mergeArgs, { request: fakeDashboard().request, ...withCheck(greenCheck({ checked: [{ kind: 'tests', what: 'node tests', ok: false }] })) });
  assert.equal(bare.ok, false);
  assert.match(bare.error, /node tests \(\)/);
  assert.doesNotMatch(bare.error, /undefined/);

  const gaps = await recordBranchVerdictTool(mergeArgs, { request: fakeDashboard().request, ...withCheck(greenCheck({ testsRun: false, checked: [], notRun: ['no harness', 'x.py has no tests'] })) });
  assert.match(gaps.error, /ran no tests \(no harness; x\.py has no tests\)/);

  const text = await recordBranchVerdictTool(mergeArgs, { request: fakeDashboard().request, ...withCheck(greenCheck({ testsRun: false, checked: [], notRun: 'just text' })) });
  assert.equal(text.ok, false);
  assert.match(text.error, /ran no tests \(no reason given\)/);
});
