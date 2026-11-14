'use strict';

// HUB0364: every way git-runner.js can write to the remote's main branch goes through assertMainPushReady (src/lib/main-push-policy.js): pushMain,
// push('<main branch>') and the fast-forward push inside resetToMain. Real temporary repositories; the pipeline directory is a temporary one so the READY
// record (queue/branch-verdicts.json) and the refusal ledger (queue/main-push-ledger.jsonl) can be read back.
// Run: node --test src/git-runner-main-gate.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createRealGitRunner } = require('./git-runner.js');

const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' });

function setup() {
  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-gate-origin-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-gate-repo-'));
  const pipelineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-gate-pipe-'));
  fs.mkdirSync(path.join(pipelineDir, 'queue'), { recursive: true });
  git(['init', '--bare', '-b', 'main', bareDir]);
  git(['clone', bareDir, repoDir]);
  git(['config', 'user.email', 't@x'], repoDir); git(['config', 'user.name', 'T'], repoDir);
  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'v1\n');
  git(['add', 'a.txt'], repoDir); git(['commit', '-m', 'init'], repoDir); git(['push', 'origin', 'main'], repoDir);
  return { bareDir, repoDir, pipelineDir };
}
const localCommit = (repoDir, text) => { fs.writeFileSync(path.join(repoDir, 'a.txt'), text); git(['add', 'a.txt'], repoDir); git(['commit', '-m', text.trim()], repoDir); return git(['rev-parse', 'HEAD'], repoDir).trim(); };
const originMain = (bareDir) => git(['rev-parse', 'main'], bareDir).trim();
const record = (pipelineDir, sha, over = {}) => fs.writeFileSync(path.join(pipelineDir, 'queue', 'branch-verdicts.json'), JSON.stringify({ main: { [sha]: { verdict: 'merge', reasons: ['ok'], source: 'chat', verifiedAt: new Date().toISOString(), ...over } } }));
const ledger = (pipelineDir) => { const f = path.join(pipelineDir, 'queue', 'main-push-ledger.jsonl'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []; };

function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  const warnings = []; const origWarn = console.warn; console.warn = (m) => warnings.push(String(m));
  try { return fn(warnings); } finally { console.warn = origWarn; for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}
const gated = (s, extra = {}) => ({ AGENT_MANAGER_REPO_ROOT: s.repoDir, AGENT_MANAGER_PIPELINE_DIR: s.pipelineDir, AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH: undefined, ...extra });

test('pushMain with no READY record refuses, pushes nothing and writes a ledger row naming the caller', () => {
  const s = setup(); const before = originMain(s.bareDir); const sha = localCommit(s.repoDir, 'v2\n');
  withEnv(gated(s), () => {
    assert.throws(() => createRealGitRunner(s.repoDir).pushMain(), (e) => e.code === 'MAIN_PUSH_NOT_READY' && /main write refused/.test(e.message));
  });
  assert.equal(originMain(s.bareDir), before);
  const rows = ledger(s.pipelineDir);
  assert.equal(rows.length, 1);
  assert.deepEqual({ outcome: rows[0].outcome, branch: rows[0].branch, headSha: rows[0].headSha, caller: rows[0].caller }, { outcome: 'refused', branch: 'main', headSha: sha, caller: 'git-runner:pushMain' });
});

test('pushMain with a chat merge record for exactly the local head pushes it', () => {
  const s = setup(); const sha = localCommit(s.repoDir, 'v2\n'); record(s.pipelineDir, sha);
  withEnv(gated(s), () => createRealGitRunner(s.repoDir).pushMain());
  assert.equal(originMain(s.bareDir), sha);
  assert.deepEqual(ledger(s.pipelineDir), []);
});

test('a record for an older head does not cover a newer commit (the head moved after the record)', () => {
  const s = setup(); const old = localCommit(s.repoDir, 'v2\n'); record(s.pipelineDir, old); const before = originMain(s.bareDir); localCommit(s.repoDir, 'v3\n');
  withEnv(gated(s), () => assert.throws(() => createRealGitRunner(s.repoDir).pushMain(), /no verdict recorded/));
  assert.equal(originMain(s.bareDir), before);
});

test('a merge record from the worker source is not READY', () => {
  const s = setup(); const sha = localCommit(s.repoDir, 'v2\n'); record(s.pipelineDir, sha, { source: 'worker' });
  withEnv(gated(s), () => assert.throws(() => createRealGitRunner(s.repoDir).pushMain(), /not a human source/));
});

test("push('<main branch>') is routed through the same gate, while a throwaway agent branch is not", () => {
  const s = setup(); const before = originMain(s.bareDir); const sha = localCommit(s.repoDir, 'v2\n');
  withEnv(gated(s), () => {
    const runner = createRealGitRunner(s.repoDir);
    assert.throws(() => runner.push('main'), /main write refused/);
    git(['checkout', '-q', '-b', 'agent/x-1'], s.repoDir);
    runner.push('agent/x-1');
  });
  assert.equal(originMain(s.bareDir), before);
  assert.equal(git(['rev-parse', 'agent/x-1'], s.bareDir).trim(), sha);
});

test('the env bypass lets pushMain through with a warning and no ledger row', () => {
  const s = setup(); const sha = localCommit(s.repoDir, 'v2\n');
  withEnv(gated(s, { AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH: 'true' }), (warnings) => {
    createRealGitRunner(s.repoDir).pushMain();
    assert.ok(warnings.some((w) => /AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH=true/.test(w) && /git-runner:pushMain/.test(w)));
  });
  assert.equal(originMain(s.bareDir), sha);
  assert.deepEqual(ledger(s.pipelineDir), []);
});

test('the fast-forward push inside resetToMain also asks the gate (under the bypass it warns with its own caller)', () => {
  const s = setup(); const sha = localCommit(s.repoDir, 'v2\n');
  withEnv(gated(s, { AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH: 'true' }), (warnings) => {
    createRealGitRunner(s.repoDir).resetToMain();
    assert.ok(warnings.some((w) => /git-runner:resetToMain:fast-forward/.test(w)));
  });
  assert.equal(originMain(s.bareDir), sha);
});
