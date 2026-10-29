'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { listUnverifiedBranchesTool, recordBranchVerdictTool } = require('./chat-branch-verdict.js');

const SHA = 'a'.repeat(40);
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
  const out = await recordBranchVerdictTool({ branch: 'agent/one', sha: SHA.slice(0, 9), verdict: 'merge', reasons: ['ran the covering suite: 14 pass'] }, { request: d.request });
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
  const a = await recordBranchVerdictTool({ branch: 'agent/one', sha: SHA, verdict: 'merge', reasons: ['x'] }, { request: moved.request });
  assert.equal(a.ok, false);
  assert.equal(a.status, 409);
  assert.match(a.error, /branch head has moved/);
  assert.equal(a.headSha, 'd'.repeat(40));
  const html404 = fakeDashboard({ post: { status: 404, json: null } });
  const b = await recordBranchVerdictTool({ branch: 'agent/one', sha: SHA, verdict: 'merge', reasons: ['x'] }, { request: html404.request });
  assert.match(b.error, /HTTP 404/);
});

test('branch names with slashes are encoded per segment so the route sees the real path', async () => {
  const d = fakeDashboard({ rows: [row({ branch: 'agent/decompose-adhoc-x y#1' })] });
  await recordBranchVerdictTool({ branch: 'agent/decompose-adhoc-x y#1', sha: SHA, verdict: 'merge', reasons: ['x'] }, { request: d.request });
  assert.match(d.calls.find((c) => c.method === 'POST').url, /^\/api\/git\/branches\/agent\/decompose-adhoc-x%20y%231\/verdict\?project=/);
});
