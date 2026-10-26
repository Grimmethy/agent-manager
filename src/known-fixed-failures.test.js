'use strict';

// known-fixed-failures.js entries that re-run the real, now-fixed check (one test per entry added after this file).
// Run: node --test src/known-fixed-failures.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { KNOWN_FIXED, _setEndpointProbe } = require('./known-fixed-failures.js');

const entry = KNOWN_FIXED.find((e) => e.id === 'ungrounded-field-new-env-var');
const BLOCK = (name) => `Deterministic gate: draft cites a value that appears nowhere in its real grounding source -- ungrounded-field: ${name}. This fact-check flag is high-precision`;
const DIFF = (lines) => ['Summary', '', '=== DIFF ===', 'diff --git a/src/a.js b/src/a.js', '@@ -1 +1,2 @@', ...lines].join('\n');

test('ungrounded-field-new-env-var: re-admits only when every flagged name is an env read in the task own diff', () => {
  assert.ok(entry, 'entry registered');
  assert.deepEqual(entry.dirs, ['blocked', 'needs-clarification']);
  const task1890 = { blockedReason: BLOCK('AGENT_MANAGER_EDIT_FILE_TIERS'), implementResponse: DIFF(["+  const v = String(process.env.AGENT_MANAGER_EDIT_FILE_TIERS || '');"]) };
  assert.equal(entry.applies(task1890), true);
  const viaRawDiff = { blockedReason: BLOCK('AGENT_MANAGER_EDIT_FILE_TIERS'), rawDiff: "diff --git a/x b/x\n@@ -1 +1 @@\n+x = os.getenv('AGENT_MANAGER_EDIT_FILE_TIERS')" };
  assert.equal(entry.applies(viaRawDiff), true);
  const oneInvented = { blockedReason: `${BLOCK('AGENT_MANAGER_EDIT_FILE_TIERS')}\n${BLOCK('MADE_UP_FIELD')}`, implementResponse: task1890.implementResponse };
  assert.equal(entry.applies(oneInvented), false);
  assert.equal(entry.applies({ blockedReason: BLOCK('MADE_UP_FIELD'), implementResponse: DIFF(['+const x = 1;']) }), false);
  assert.equal(entry.applies({ blockedReason: 'something else entirely', implementResponse: task1890.implementResponse }), false);
  assert.equal(entry.applies({}), false);
});

test('ungrounded-field-new-env-var: also re-admits a task blocked on a name read through an injected env parameter (env.NAME)', () => {
  const e = KNOWN_FIXED.find((x) => x.id === 'ungrounded-field-new-env-var');
  const impl = ['Summary', '', '=== DIFF ===', 'diff --git a/src/lib/x.js b/src/lib/x.js', '@@ -1 +1,2 @@', "+function on(env = process.env) { return env.AGENT_MANAGER_TRANSIENT_RETRY !== 'off'; }"].join('\n');
  assert.equal(e.applies({ blockedReason: BLOCK('AGENT_MANAGER_TRANSIENT_RETRY'), implementResponse: impl }), true);
  assert.equal(e.applies({ blockedReason: BLOCK('SOME_OTHER_NAME'), implementResponse: impl }), false);
});

// --- ungrounded-field-test-fixture (2026-10-19) ---------------------------------------------------------------

test('ungrounded-field-test-fixture: re-admits only when every flagged name is only in the task own added test files', () => {
  const fx = KNOWN_FIXED.find((e) => e.id === 'ungrounded-field-test-fixture');
  assert.ok(fx, 'entry registered');
  assert.deepEqual(fx.dirs, ['blocked', 'needs-clarification']);
  const diff = (...lines) => ['Summary', '', '=== DIFF ===', 'diff --git a/src/audit.test.js b/src/audit.test.js', '@@ -1 +1,3 @@', ...lines].join('\n');
  const task1891 = { blockedReason: BLOCK('SENTINEL_THOUGHT'), implementResponse: diff("+  thinking: 'SENTINEL_THOUGHT '.repeat(500),") };
  assert.equal(fx.applies(task1891), true);
  assert.equal(fx.applies({ blockedReason: BLOCK('SENTINEL_THOUGHT'), rawDiff: task1891.implementResponse }), true);
  assert.equal(fx.applies({ blockedReason: `${BLOCK('SENTINEL_THOUGHT')}\n${BLOCK('MADE_UP_FIELD')}`, implementResponse: task1891.implementResponse }), false, 'one name that does not qualify');
  const alsoProd = `${task1891.implementResponse}\ndiff --git a/src/x.js b/src/x.js\n@@ -1 +1,2 @@\n+const t = 'SENTINEL_THOUGHT';`;
  assert.equal(fx.applies({ blockedReason: BLOCK('SENTINEL_THOUGHT'), implementResponse: alsoProd }), false, 'production code uses it too');
  assert.equal(fx.applies({ blockedReason: 'something else', implementResponse: task1891.implementResponse }), false);
  assert.equal(fx.applies({}), false);
});

// --- lane-endpoint-outage-parked (2026-10-23) -----------------------------------------------------------------------------------------------

test('lane-endpoint-outage-parked: re-admits a task parked on an unreachable or silent lane endpoint only while that endpoint answers', () => {
  const e = KNOWN_FIXED.find((x) => x.id === 'lane-endpoint-outage-parked');
  assert.ok(e, 'entry registered');
  assert.deepEqual(e.dirs, ['blocked', 'needs-clarification'], 'the same outage also escalated tasks to needs-clarification');
  const URL = 'http://100.96.112.78:11434';
  const refused = { blockedReason: `draft call failed on an apparent infra outage that did not clear even after 3 requeue round(s) -- giving up rather than retrying forever (most recent: {"succeeded":false,"reason":"Ollama endpoint ${URL} is not reachable (ECONNREFUSED: connect ECONNREFUSED 100.96.112.78:11434)"})` };
  const silent = { blockedReason: `draft call failed 7 times in a row (most recent: {"succeeded":false,"reason":"Ollama endpoint ${URL} did not answer within 5000ms"}) -- giving up rather than retrying every tick forever and starving this lane` };
  const probed = [];
  try {
    _setEndpointProbe((u) => { probed.push(u); return true; });
    assert.equal(e.applies(refused), true, 'refused text, endpoint back');
    assert.equal(e.applies(silent), true, 'silent text, endpoint back');
    assert.deepEqual([...new Set(probed)], [URL], 'the endpoint named in the failure is the one probed');
    assert.equal(e.applies({ blockedReason: 'draft call failed 7 times in a row (most recent: {"reason":"model returned an empty response"})' }), false, 'a different failure is untouched');
    assert.equal(e.applies({}), false);
    _setEndpointProbe(() => false);
    assert.equal(e.applies(refused), false, 'the endpoint is still down: leave the task parked');
  } finally { _setEndpointProbe(null); }
});

test('lane-endpoint-outage-parked: probes each endpoint once per sweep, and the default probe answers false for a closed port', () => {
  const e = KNOWN_FIXED.find((x) => x.id === 'lane-endpoint-outage-parked');
  let calls = 0;
  try {
    _setEndpointProbe(() => { calls += 1; return true; });
    const task = { blockedReason: 'x (most recent: {"reason":"Ollama endpoint http://127.0.0.1:9 is not reachable (ECONNREFUSED)"})' };
    for (let i = 0; i < 5; i += 1) e.applies(task);
    assert.equal(calls, 1, 'cached for the sweep');
    // real default probe against a closed port (nothing listens on port 9)
    _setEndpointProbe(null);
    assert.equal(e.applies(task), false, 'closed port is not answering');
  } finally { _setEndpointProbe(null); }
});

// --- forbidden-path-exemption-and-created-targets (2026-10-26) -----------------------------------------------------------------------------
test('forbidden-path-exemption-and-created-targets: re-admits a parked task only when the current gate no longer forbids the path its block named', () => {
  const e = KNOWN_FIXED.find((x) => x.id === 'forbidden-path-exemption-and-created-targets');
  assert.ok(e, 'entry registered');
  assert.deepEqual(e.dirs, ['blocked', 'needs-clarification']);
  const block = (p) => `Agentic implement pass produced a diff that is not a real implementation -- diff touches ${p} (matches forbidden "${p}") -- the task explicitly says not to`;
  // HUB0040 2/3: the plan's "other than x" sentence named the one file that may change
  const t40 = {
    blockedReason: block('src/decompose-premise-check.js'),
    promptContext: { rawText: 'In src/decompose-premise-check.js, locate the PATH_RE capture loop. Replace the raw captured path value.' },
    planResponse: '- Does not touch any file other than `src/decompose-premise-check.js`.',
  };
  assert.equal(e.applies(t40), true);
  // HUB0125 1/2: the file the task says to create is named by its own "do not also modify" sentence
  const t125 = {
    blockedReason: block('docs/audit-batch-write-bypass-2026-10-02.md'),
    promptContext: { rawText: 'Create docs/audit-batch-write-bypass-2026-10-02.md. It must contain a markdown table.' },
    planResponse: 'The deliverable is exactly one file. Do not also modify `docs/audit-batch-write-bypass-2026-10-02.md` as a side effect.',
  };
  assert.equal(e.applies(t125), true);
  // a genuine restriction on the named file still forbids it, so the task stays parked
  const real = { blockedReason: block('src/a.js'), promptContext: { rawText: 'Edit src/b.js. Do not touch src/a.js.' }, planResponse: '' };
  assert.equal(e.applies(real), false);
  assert.equal(e.applies({ blockedReason: 'something else' }), false);
  assert.equal(e.applies({}), false);
});

test('docs-only gate entries re-admit a documentation task whose declared edit targets are all docs (taskWantsCodeChange agrees with the gate)', () => {
  const e = KNOWN_FIXED.find((x) => x.id === 'docs-only-gate-read-only-deliverable');
  const reason = 'diff only touches documentation (docs/local-delegation.md) -- the task asks for a code change';
  const task = { blockedReason: reason, promptContext: { rawText: 'Edit `docs/local-delegation.md` to add a subsection explaining `OLLAMA_KV_CACHE_TYPE`. Add a note about src/gpu-vram.js.' }, planResponse: 'Edit `docs/local-delegation.md`.' };
  assert.equal(e.applies(task), true);
  const wantsCode = { blockedReason: reason, promptContext: { rawText: 'Create docs/audit/paths.md listing the routes. Then update the timeout handling in src/local-tool-client.js.' } };
  assert.equal(e.applies(wantsCode), false);
});

// --- stacked-sibling-missing-from-tree (2026-10-26) --------------------------------------------------------------------------------------------
// Real git, nothing faked: a bare "origin" with main and a stacked branch that is ahead of main, and a clone as the repo root.
function stackedFixture({ withBranch, commits = 1 }) {
  const { execFileSync } = require('child_process');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kff-stacked-'));
  const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' });
  git(tmp, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  git(tmp, 'clone', '-q', 'origin.git', 'work');
  const work = path.join(tmp, 'work');
  fs.writeFileSync(path.join(work, 'a.txt'), 'base\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'base');
  git(work, 'push', '-q', 'origin', 'HEAD:main');
  if (withBranch) {
    git(work, 'checkout', '-q', '-b', 'agent/stack');
    if (commits > 0) {
      fs.writeFileSync(path.join(work, 'guard.txt'), 'sibling code\n');
      git(work, 'add', '.');
      git(work, 'commit', '-q', '-m', 'sibling 1/2');
    }
    git(work, 'push', '-q', 'origin', 'agent/stack');
  }
  git(tmp, 'clone', '-q', 'origin.git', 'root');
  return path.join(tmp, 'root');
}

test('stacked-sibling-missing-from-tree: re-admits only a stacked piece whose failure names the unmerged sibling AND whose shared branch exists with commits', () => {
  const e = KNOWN_FIXED.find((x) => x.id === 'stacked-sibling-missing-from-tree');
  assert.ok(e, 'entry registered');
  assert.deepEqual(e.dirs, ['blocked', 'needs-clarification']);
  const prev = process.env.AGENT_MANAGER_REPO_ROOT;
  try {
    const root = stackedFixture({ withBranch: true });
    process.env.AGENT_MANAGER_REPO_ROOT = root;
    const failure = 'The 1/2 sibling (HUB0123 · 1/2 · Add the guard) has not been merged into the working tree. Test 1 cannot pass without that code path.';
    const task = { blockedReason: failure, stacked: { branch: 'agent/stack', seq: 2, total: 2 } };
    assert.equal(e.applies(task), true);
    assert.equal(e.applies({ priorRejectionFeedback: ['the guard from sibling HUB0123 · 1/2 is not yet merged'], stacked: task.stacked }), true, 'feedback text counts too');
    assert.equal(e.applies({ blockedReason: failure }), false, 'not a stacked piece');
    assert.equal(e.applies({ blockedReason: 'something else entirely', stacked: task.stacked }), false, 'a different failure');
    assert.equal(e.applies({ blockedReason: failure, stacked: { branch: 'agent/does-not-exist', seq: 2, total: 2 } }), false, 'the shared branch is missing');
    const emptyRoot = stackedFixture({ withBranch: false });
    process.env.AGENT_MANAGER_REPO_ROOT = emptyRoot;
    assert.equal(e.applies(task), false, 'no such branch in this repo');
    process.env.AGENT_MANAGER_REPO_ROOT = stackedFixture({ withBranch: true, commits: 0 });
    assert.equal(e.applies(task), false, 'the shared branch exists but carries no commits beyond main, so there is no sibling code to find');
    assert.equal(e.applies({}), false);
  } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_REPO_ROOT; else process.env.AGENT_MANAGER_REPO_ROOT = prev;
  }
});

test('stacked-sibling-missing-from-tree: the failure pattern matches the wordings seen on the parked pieces and not an ordinary test failure', () => {
  const { SIBLING_NOT_IN_TREE_RE: re } = require('./known-fixed-failures.js');
  for (const t of [
    'The 1/2 sibling (HUB0123 · 1/2) has not been merged into the working tree.',
    'fails because the `decompose-loop-premise-invalid` guard from sibling HUB0123 · 1/2 is not yet merged',
    'the sibling piece is not yet present in the tree',
    'the sibling piece is not merged',
  ]) assert.equal(re.test(t), true, t);
  for (const t of ['expected 2 but got 1', 'the sibling merged cleanly and the tests pass', 'The draft claims `# pass 97` but the real output shows `# pass 96`']) assert.equal(re.test(t), false, t);
});
