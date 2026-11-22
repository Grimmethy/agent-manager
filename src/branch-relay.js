'use strict';

// LAN branch relay (multi-node plan, piece 4f): wok fetches the branch a node built over the LAN and pushes it to origin (GitHub), so the dashboard, the
// verifier and the merge route see an ordinary agent/ branch and nothing downstream changes.
//
//   relayBranch({branch, sha, nodeUrl, repoRoot, git}) -> {ok, reason}
//
// Steps, in repoRoot: fetch the branch from nodeUrl into the private ref refs/relay/<branch>; refuse unless its head is exactly `sha`; push
// `<sha>:refs/heads/<branch>` to origin (never forced, never a delete, so a rejected non-fast-forward stays rejected); prove it with
// `git ls-remote origin refs/heads/<branch>`; remove the private ref. Only branches under agent/ and only ssh://, git:// or absolute-path node urls are
// accepted (never http, never an option-looking value). Nothing here runs by itself: the owner or a later piece calls it.

const { execFileSync } = require('child_process');

const BRANCH_RE = /^agent\/[A-Za-z0-9._\/-]{1,200}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const GIT_TIMEOUT_MS = 60000;

function defaultGit(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}

function safeBranch(branch) {
  return typeof branch === 'string' && BRANCH_RE.test(branch) && !branch.includes('..') && !branch.endsWith('/') && !branch.endsWith('.lock');
}

function safeNodeUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  return url.startsWith('ssh://') || url.startsWith('git://') || (url.startsWith('/') && !url.includes('\0'));
}

function firstLine(e) {
  const text = String((e && (e.stderr || e.message)) || e || '').trim();
  return text.split('\n')[0].slice(0, 200);
}

function relayBranch({ branch, sha, nodeUrl, repoRoot, git = defaultGit } = {}) {
  if (!safeBranch(branch)) return { ok: false, reason: 'branch must be under agent/' };
  if (typeof sha !== 'string' || !SHA_RE.test(sha)) return { ok: false, reason: 'sha must be 40 hex characters' };
  if (!safeNodeUrl(nodeUrl)) return { ok: false, reason: 'nodeUrl must be an ssh://, git:// or absolute path url' };
  if (typeof repoRoot !== 'string' || !repoRoot) return { ok: false, reason: 'repoRoot is required' };
  const ref = `refs/relay/${branch}`;
  try {
    try {
      git(['fetch', '--no-tags', '--', nodeUrl, `+refs/heads/${branch}:${ref}`], repoRoot);
    } catch (e) {
      return { ok: false, reason: `fetch from the node failed: ${firstLine(e)}` };
    }
    const fetched = String(git(['rev-parse', '--verify', ref], repoRoot)).trim();
    if (fetched !== sha) return { ok: false, reason: `the node's branch is at ${fetched.slice(0, 12)}, not the requested ${sha.slice(0, 12)}` };
    try {
      git(['push', 'origin', `${sha}:refs/heads/${branch}`], repoRoot);
    } catch (e) {
      return { ok: false, reason: `push to origin failed: ${firstLine(e)}` };
    }
    const remote = String(git(['ls-remote', 'origin', `refs/heads/${branch}`], repoRoot)).trim().split(/\s+/)[0];
    if (remote !== sha) return { ok: false, reason: 'origin does not show the pushed sha' };
    return { ok: true, reason: '' };
  } catch (e) {
    return { ok: false, reason: `git failed: ${firstLine(e)}` };
  } finally {
    try { git(['update-ref', '-d', ref], repoRoot); } catch (e) { /* the private ref may not exist */ }
  }
}

module.exports = { defaultGit, relayBranch, safeBranch, safeNodeUrl, BRANCH_RE, SHA_RE, GIT_TIMEOUT_MS };
