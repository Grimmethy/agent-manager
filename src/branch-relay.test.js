'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { relayBranch, safeBranch, safeNodeUrl, defaultGit, GIT_TIMEOUT_MS } = require('./branch-relay.js');

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// node: a repo with agent/x at one commit; origin: a bare repo; work: a clone of origin (the relay's repoRoot).
function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-relay-'));
  const origin = path.join(root, 'origin.git');
  const node = path.join(root, 'node');
  const work = path.join(root, 'work');
  git(root, 'init', '-q', '--bare', origin);
  git(root, 'init', '-q', node);
  fs.writeFileSync(path.join(node, 'a.txt'), '1');
  git(node, 'add', '.');
  git(node, 'commit', '-q', '-m', 'base');
  git(node, 'branch', '-M', 'main');
  git(node, 'checkout', '-q', '-b', 'agent/x');
  fs.writeFileSync(path.join(node, 'b.txt'), '2');
  git(node, 'add', '.');
  git(node, 'commit', '-q', '-m', 'work');
  git(node, 'checkout', '-q', 'main');
  git(root, 'clone', '-q', origin, work);
  return { root, origin, node, work, sha: git(node, 'rev-parse', 'agent/x') };
}

const originHas = (w, branch) => git(w.origin, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`);

test('a branch built on the node is fetched, pushed to origin and verified; the private ref is cleaned up', () => {
  const w = world();
  const r = relayBranch({ branch: 'agent/x', sha: w.sha, nodeUrl: w.node, repoRoot: w.work });
  assert.deepEqual(r, { ok: true, reason: '' });
  assert.equal(originHas(w, 'agent/x'), w.sha);
  assert.equal(git(w.work, 'for-each-ref', 'refs/relay'), '');
});

test('relaying the same sha again is fine', () => {
  const w = world();
  assert.equal(relayBranch({ branch: 'agent/x', sha: w.sha, nodeUrl: w.node, repoRoot: w.work }).ok, true);
  assert.equal(relayBranch({ branch: 'agent/x', sha: w.sha, nodeUrl: w.node, repoRoot: w.work }).ok, true);
});

test('a sha that does not match the fetched head is refused and nothing reaches origin', () => {
  const w = world();
  const r = relayBranch({ branch: 'agent/x', sha: 'f'.repeat(40), nodeUrl: w.node, repoRoot: w.work });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not the requested/);
  assert.throws(() => originHas(w, 'agent/x'));
  assert.equal(git(w.work, 'for-each-ref', 'refs/relay'), '', 'the private ref is removed even on refusal');
});

test('a branch outside agent/ or with a bad shape is refused before any git runs', () => {
  const calls = [];
  const spy = (args) => { calls.push(args); return ''; };
  for (const branch of ['main', 'agent', 'agent/', 'agent/../x', 'agent/x.lock', 'agent/x/', 'agent/a b', '-agent/x', undefined, 7, 'agent/' + 'a'.repeat(201)]) {
    const r = relayBranch({ branch, sha: 'a'.repeat(40), nodeUrl: '/tmp/x', repoRoot: '/tmp', git: spy });
    assert.equal(r.ok, false, String(branch));
    assert.match(r.reason, /agent\//);
  }
  assert.deepEqual(calls, []);
});

test('http(s), scp-style, option-looking, empty and non-string node urls are refused; ssh://, git:// and absolute paths are accepted', () => {
  for (const u of ['http://x/y.git', 'https://x/y.git', 'user@host:path', '--upload-pack=evil', '-x', '', 'relative/path', undefined, 5]) {
    assert.equal(safeNodeUrl(u), false, String(u));
    assert.match(relayBranch({ branch: 'agent/x', sha: 'a'.repeat(40), nodeUrl: u, repoRoot: '/tmp', git: () => '' }).reason, /nodeUrl/);
  }
  for (const u of ['ssh://grimm/srv/repo.git', 'git://grimm/repo.git', '/srv/repo.git']) assert.equal(safeNodeUrl(u), true, u);
  assert.equal(safeBranch('agent/x'), true);
  assert.equal(safeBranch('agent/x/y-1.2_z'), true);
});

test('a bad sha or a missing repoRoot is refused', () => {
  for (const sha of ['abc', 'A'.repeat(40), 'a'.repeat(41), undefined, 5]) assert.match(relayBranch({ branch: 'agent/x', sha, nodeUrl: '/tmp/x', repoRoot: '/tmp', git: () => '' }).reason, /sha/);
  assert.match(relayBranch({ branch: 'agent/x', sha: 'a'.repeat(40), nodeUrl: '/tmp/x', repoRoot: '', git: () => '' }).reason, /repoRoot/);
});

test('a node url that cannot be fetched is a refusal with a reason, not an exception', () => {
  const w = world();
  const r = relayBranch({ branch: 'agent/x', sha: w.sha, nodeUrl: path.join(w.root, 'no-such-repo'), repoRoot: w.work });
  assert.equal(r.ok, false);
  assert.match(r.reason, /fetch from the node failed/);
});

test('a branch the node does not have is a fetch failure', () => {
  const w = world();
  const r = relayBranch({ branch: 'agent/missing', sha: w.sha, nodeUrl: w.node, repoRoot: w.work });
  assert.equal(r.ok, false);
  assert.match(r.reason, /fetch from the node failed/);
});

test('a rejected push (origin already has a different agent/x) is reported, never forced, and origin keeps its branch', () => {
  const w = world();
  git(w.work, 'checkout', '-q', '-b', 'other');
  fs.writeFileSync(path.join(w.work, 'c.txt'), '3');
  git(w.work, 'add', '.');
  git(w.work, 'commit', '-q', '-m', 'diverged');
  git(w.work, 'push', '-q', 'origin', 'other:agent/x');
  const before = originHas(w, 'agent/x');
  const r = relayBranch({ branch: 'agent/x', sha: w.sha, nodeUrl: w.node, repoRoot: w.work });
  assert.equal(r.ok, false);
  assert.match(r.reason, /push to origin failed/);
  assert.equal(originHas(w, 'agent/x'), before);
});

test('the steps and their arguments: fetch with --no-tags and a -- separator, push without force, ls-remote, then ref cleanup', () => {
  const calls = [];
  const sha = 'a'.repeat(40);
  const fake = (args) => {
    calls.push(args);
    if (args[0] === 'rev-parse') return `${sha}\n`;
    if (args[0] === 'ls-remote') return `${sha}\trefs/heads/agent/x\n`;
    return '';
  };
  const r = relayBranch({ branch: 'agent/x', sha, nodeUrl: '/srv/n.git', repoRoot: '/repo', git: fake });
  assert.equal(r.ok, true);
  assert.deepEqual(calls, [
    ['fetch', '--no-tags', '--', '/srv/n.git', '+refs/heads/agent/x:refs/relay/agent/x'],
    ['rev-parse', '--verify', 'refs/relay/agent/x'],
    ['push', 'origin', `${sha}:refs/heads/agent/x`],
    ['ls-remote', 'origin', 'refs/heads/agent/x'],
    ['update-ref', '-d', 'refs/relay/agent/x'],
  ]);
  assert.ok(!calls.flat().some((a) => /force|--delete|^\+.*:refs\/heads/.test(a)));
});

test('an origin that does not show the sha after the push is a failure; a throwing git is a failure, not an exception', () => {
  const sha = 'a'.repeat(40);
  const lies = (args) => (args[0] === 'rev-parse' ? sha : args[0] === 'ls-remote' ? `${'b'.repeat(40)}\trefs/heads/agent/x` : '');
  assert.match(relayBranch({ branch: 'agent/x', sha, nodeUrl: '/n', repoRoot: '/r', git: lies }).reason, /origin does not show/);
  const boom = (args) => { if (args[0] === 'rev-parse') throw new Error('disk gone'); return ''; };
  const r = relayBranch({ branch: 'agent/x', sha, nodeUrl: '/n', repoRoot: '/r', git: boom });
  assert.equal(r.ok, false);
  assert.match(r.reason, /git failed: disk gone/);
});

test('the default git runner turns prompts off and has a 60 second timeout per command', () => {
  assert.equal(GIT_TIMEOUT_MS, 60000);
  const out = defaultGit(['-c', 'alias.show-prompt=!echo prompt=$GIT_TERMINAL_PROMPT', 'show-prompt'], os.tmpdir());
  assert.equal(out.trim(), 'prompt=0');
});
