'use strict';

// Tests for the check_branch chat tool (chat-branch-check.js). The dashboard is a fake, the check and the store are injected, so nothing here runs git or a test suite.
// Run: node --test src/chat-branch-check.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkBranchTool } = require('./chat-branch-check.js');

const SHA = 'a'.repeat(40);
const row = (over = {}) => ({
  branch: 'agent/one', headSha: SHA, mainBranch: 'master', subject: 'One', ahead: 1, behind: 0, hub: null, verdict: null, stale: false,
  project: { label: 'agent-manager', repoRoot: '/repos/agent-manager', active: true }, ...over,
});

function fakeDashboard({ rows = [row()], status = 200, throws = null } = {}) {
  const calls = [];
  const request = async (method, url) => {
    calls.push({ method, url });
    if (throws) throw throws;
    return { status, json: status === 200 ? rows : null };
  };
  return { request, calls };
}

const green = (over = {}) => ({
  headSha: SHA, branch: 'agent/one', base: 'origin/master', repoRoot: '/repos/agent-manager', changedFiles: ['src/a.js'], docsOnly: false, harness: 'node-test', testsRun: true,
  checked: [
    { kind: 'static', what: 'missing local require in added JavaScript lines', command: '(static scan)', ok: true, summary: 'ok' },
    { kind: 'tests', what: 'node tests (1 covering file)', command: 'node --test src/a.test.js', ok: true, summary: 'exit 0' },
  ],
  notRun: [], durationMs: 10, checkedAt: '2026-10-29T10:00:00.000Z', ...over,
});

// A runBranchCheck and a store that record what they are given.
function fakes({ result = green(), saves = true, runThrows = null, saveThrows = null } = {}) {
  const ran = [];
  const saved = [];
  return {
    ran, saved,
    runBranchCheck: async (args) => { ran.push(args); if (runThrows) throw runThrows; return result; },
    saveBranchCheck: (repoRoot, r) => { saved.push({ repoRoot, result: r }); if (saveThrows) throw saveThrows; return saves; },
  };
}

test('a listed branch is checked at the head the dashboard reports, saved, and its fields are relayed', async () => {
  const d = fakeDashboard();
  const f = fakes();
  const out = await checkBranchTool({ branch: 'agent/one' }, { request: d.request, runBranchCheck: f.runBranchCheck, saveBranchCheck: f.saveBranchCheck });
  assert.equal(out.ok, true);
  assert.deepEqual(f.ran, [{ repoRoot: '/repos/agent-manager', branch: 'agent/one', headSha: SHA, base: 'origin/master' }]);
  assert.equal(f.saved.length, 1);
  assert.equal(f.saved[0].repoRoot, '/repos/agent-manager');
  assert.deepEqual(f.saved[0].result, green(), 'what was stored is exactly what the check returned');
  const r = f.saved[0].result;
  assert.deepEqual({ headSha: out.headSha, harness: out.harness, docsOnly: out.docsOnly, testsRun: out.testsRun, checked: out.checked, notRun: out.notRun },
    { headSha: r.headSha, harness: r.harness, docsOnly: r.docsOnly, testsRun: r.testsRun, checked: r.checked, notRun: r.notRun });
  assert.deepEqual(d.calls.map((c) => c.url), ['/api/git/unmerged-branches?projects=all']);
});

test('the base ref is origin/ plus the main branch of THAT branch\'s row', async () => {
  const d = fakeDashboard({ rows: [row({ mainBranch: 'main', branch: 'agent/two' })] });
  const f = fakes();
  await checkBranchTool({ branch: 'agent/two' }, { request: d.request, runBranchCheck: f.runBranchCheck, saveBranchCheck: f.saveBranchCheck });
  assert.equal(f.ran[0].base, 'origin/main');
});

test('a branch that is not listed, one listed in two projects, and an unknown project all give relayable errors and run nothing', async () => {
  const other = { label: 'sparforge', repoRoot: '/repos/sparforge', active: false };
  const d = fakeDashboard({ rows: [row(), row({ project: other }), row({ branch: 'agent/solo', project: other })] });
  const f = fakes();
  const opts = { request: d.request, runBranchCheck: f.runBranchCheck, saveBranchCheck: f.saveBranchCheck };

  const missing = await checkBranchTool({ branch: 'agent/nope' }, opts);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /"agent\/nope" is not a currently listed unmerged branch; call list_unverified_branches/);

  const both = await checkBranchTool({ branch: 'agent/one' }, opts);
  assert.equal(both.ok, false);
  assert.match(both.error, /listed in more than one project \(agent-manager, sparforge\); pass "project"/);

  const unknown = await checkBranchTool({ branch: 'agent/one', project: 'nowhere' }, opts);
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /"agent\/one" in project "nowhere" is not a currently listed/);

  assert.equal(f.ran.length, 0);
  assert.equal(f.saved.length, 0);
});

test('the project argument picks the right row by label or by repo root', async () => {
  const other = { label: 'sparforge', repoRoot: '/repos/sparforge', active: false };
  const d = fakeDashboard({ rows: [row(), row({ project: other, headSha: 'b'.repeat(40) })] });
  const f = fakes();
  const opts = { request: d.request, runBranchCheck: f.runBranchCheck, saveBranchCheck: f.saveBranchCheck };
  await checkBranchTool({ branch: 'agent/one', project: 'sparforge' }, opts);
  await checkBranchTool({ branch: 'agent/one', project: '/repos/agent-manager' }, opts);
  assert.deepEqual(f.ran.map((a) => [a.repoRoot, a.headSha]), [['/repos/sparforge', 'b'.repeat(40)], ['/repos/agent-manager', SHA]]);
});

test('a check that throws gives { ok: false, error } and a store that throws or refuses still returns the result with a note', async () => {
  const d = fakeDashboard();
  const boom = await checkBranchTool({ branch: 'agent/one' }, { request: d.request, ...fakes({ runThrows: new Error('worktree add exploded') }) });
  assert.equal(boom.ok, false);
  assert.match(boom.error, /the check could not run: worktree add exploded/);

  const refused = await checkBranchTool({ branch: 'agent/one' }, { request: d.request, ...fakes({ saves: false }) });
  assert.equal(refused.ok, true);
  assert.match(refused.message, /could not be stored, so a merge verdict will need this check run again/);

  const threw = await checkBranchTool({ branch: 'agent/one' }, { request: d.request, ...fakes({ saveThrows: new Error('disk full') }) });
  assert.equal(threw.ok, true);
  assert.match(threw.message, /could not be stored/);

  const stored = await checkBranchTool({ branch: 'agent/one' }, { request: d.request, ...fakes() });
  assert.doesNotMatch(stored.message, /could not be stored/);
});

test('bad arguments and a dashboard that does not answer give errors, not exceptions', async () => {
  const f = fakes();
  for (const args of [{}, { branch: '' }, { branch: '   ' }, { branch: 42 }]) {
    const out = await checkBranchTool(args, { request: fakeDashboard().request, ...f });
    assert.equal(out.ok, false);
    assert.match(out.error, /requires a non-empty "branch"/);
  }
  const down = await checkBranchTool({ branch: 'agent/one' }, { request: fakeDashboard({ throws: new Error('connect refused') }).request, ...f });
  assert.equal(down.ok, false);
  assert.match(down.error, /dashboard did not answer the branch listing \(connect refused\)/);
  const bad = await checkBranchTool({ branch: 'agent/one' }, { request: fakeDashboard({ status: 500 }).request, ...f });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /branch listing failed \(HTTP 500\)/);
  assert.equal(f.ran.length, 0);
});

test('a listing row without a project root, head sha or main branch cannot be checked', async () => {
  const f = fakes();
  for (const bad of [row({ project: { label: 'x' } }), row({ headSha: '' }), row({ mainBranch: undefined })]) {
    const out = await checkBranchTool({ branch: 'agent/one' }, { request: fakeDashboard({ rows: [bad] }).request, ...f });
    assert.equal(out.ok, false);
    assert.match(out.error, /has no project root, head sha or main branch/);
  }
  assert.equal(f.ran.length, 0);
});

test('the message says in one sentence what ran, what was red and what was not run', async () => {
  const d = fakeDashboard();
  const say = async (result) => (await checkBranchTool({ branch: 'agent/one' }, { request: d.request, ...fakes({ result }) })).message;

  assert.equal(await say(green()), `1 test run(s) and 1 static scan(s) ran on ${SHA.slice(0, 9)}: all green.`);

  const red = green({ checked: [{ kind: 'static', what: 'undefined logger name in added Python lines', command: '-', ok: false, summary: 'proxy.py:307 uses logger' }, green().checked[1]] });
  assert.match(await say(red), /1 red \(undefined logger name in added Python lines\)/);

  const noTests = green({ testsRun: false, harness: null, checked: [], notRun: ['no test harness recognised for this repo'] });
  assert.equal(await say(noTests), `nothing ran on ${SHA.slice(0, 9)}. Not run: no test harness recognised for this repo.`);

  const docs = green({ docsOnly: true, checked: [], testsRun: false, notRun: [] });
  assert.match(await say(docs), /The branch changes only documentation\./);

  const partial = green({ notRun: ['2 more covering test files not run: a, b', 'changed files this harness does not run tests for: x.py'] });
  assert.match(await say(partial), /Not run: 2 more covering test files not run: a, b; changed files this harness does not run tests for: x\.py\./);
});

test('without an injected transport the tool talks to the dashboard port itself (a closed port gives a connection error, not a crash)', async () => {
  const net = require('node:net');
  const port = await new Promise((resolve) => { const srv = net.createServer(); srv.listen(0, '127.0.0.1', () => { const { port: p } = srv.address(); srv.close(() => resolve(p)); }); });
  const prev = process.env.AGENT_MANAGER_DASHBOARD_PORT;
  process.env.AGENT_MANAGER_DASHBOARD_PORT = String(port);
  try {
    const out = await checkBranchTool({ branch: 'agent/one' });
    assert.equal(out.ok, false);
    assert.match(out.error, /dashboard did not answer the branch listing \(.*ECONNREFUSED/);
  } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_DASHBOARD_PORT; else process.env.AGENT_MANAGER_DASHBOARD_PORT = prev;
  }
});

