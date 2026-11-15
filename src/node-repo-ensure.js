'use strict';

// Repo on demand (multi-node plan, FF-3 piece 3f): makes sure a task's repository is checked out on this node.
//   ensureRepo({name, remoteUrl, baseBranch}, {reposDir, git, env, validate}) -> {ok, path, head, updated, reason?}
// reposDir/<name> is cloned from remoteUrl when it is missing, otherwise `git fetch origin` runs there. The checked-out base branch is then
// fast-forwarded to origin/<baseBranch> ONLY when it is the branch checked out, the tree has no tracked changes and the update is a fast-forward;
// a dirty, diverged or other-branch checkout is left alone and reported as {ok:true, updated:false, reason}. Nothing here deletes, resets or force-moves anything.
// Safety: the name may only hold letters, digits, dots, dashes and underscores (and is not . or ..); the url must be https://github.com/<owner>/<name>(.git)
// (tests inject a different `validate`). git is an injected function (args, cwd) -> {ok, out}; the default runs the real git with a timeout.
// Settings: AGENT_MANAGER_NODE_REPOS_DIR (default /workspace/GitHub). No timers, no network except what git itself does.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DEFAULT_REPOS_DIR = '/workspace/GitHub';
const GIT_TIMEOUT_MS = 120000;
const NAME_RE = /^[A-Za-z0-9._-]+$/;
const URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?(\.git)?$/;

function defaultGit(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
  if (r.error || r.status !== 0) return { ok: false, out: String(r.stderr || (r.error && r.error.message) || '').trim() };
  return { ok: true, out: String(r.stdout || '').trim() };
}

function defaultValidate(remoteUrl) {
  return typeof remoteUrl === 'string' && URL_RE.test(remoteUrl);
}

function validName(name) {
  return typeof name === 'string' && NAME_RE.test(name) && name !== '.' && name !== '..';
}

// The base branch to follow: the one asked for, else origin/HEAD's, else main.
function resolveBase(git, repoPath, baseBranch) {
  if (typeof baseBranch === 'string' && baseBranch.trim()) return baseBranch.trim();
  const head = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoPath);
  return head.ok && head.out ? head.out.replace(/^origin\//, '') : 'main';
}

// Fast-forwards the checked-out base branch when that is safe. -> { updated, reason? }
function fastForward(git, repoPath, base) {
  const current = git(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
  if (!current.ok || current.out !== base) return { updated: false, reason: `checked out branch is not ${base}` };
  const dirty = git(['status', '--porcelain', '--untracked-files=no'], repoPath);
  if (!dirty.ok) return { updated: false, reason: 'cannot read the working tree status' };
  if (dirty.out) return { updated: false, reason: 'tracked changes in the working tree' };
  const remote = git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`], repoPath);
  if (!remote.ok || !remote.out) return { updated: false, reason: `origin/${base} does not exist` };
  const local = git(['rev-parse', 'HEAD'], repoPath);
  if (local.ok && local.out === remote.out) return { updated: false, reason: 'already up to date' };
  const ancestor = git(['merge-base', '--is-ancestor', 'HEAD', `origin/${base}`], repoPath);
  if (!ancestor.ok) return { updated: false, reason: `local ${base} has diverged from origin/${base}` };
  const merged = git(['merge', '--ff-only', `origin/${base}`], repoPath);
  return merged.ok ? { updated: true } : { updated: false, reason: 'fast-forward failed' };
}

function ensureRepo(spec, { reposDir, git = defaultGit, env = process.env, validate = defaultValidate } = {}) {
  const { name, remoteUrl, baseBranch } = spec || {};
  if (!validName(name)) return { ok: false, reason: 'invalid repo name' };
  if (!validate(remoteUrl)) return { ok: false, reason: 'invalid remote url' };
  const root = path.resolve(reposDir || env.AGENT_MANAGER_NODE_REPOS_DIR || DEFAULT_REPOS_DIR);
  const repoPath = path.join(root, name);

  if (!fs.existsSync(path.join(repoPath, '.git'))) {
    try { fs.mkdirSync(root, { recursive: true }); } catch (e) { return { ok: false, reason: 'cannot create the repos directory' }; }
    const cloned = git(['clone', '--', remoteUrl, repoPath], root);
    if (!cloned.ok) return { ok: false, path: repoPath, reason: 'clone failed' };
    const head = git(['rev-parse', 'HEAD'], repoPath);
    return { ok: true, path: repoPath, head: head.ok ? head.out : '', updated: true, reason: 'cloned' };
  }

  const fetched = git(['fetch', 'origin'], repoPath);
  if (!fetched.ok) return { ok: false, path: repoPath, reason: 'fetch failed' };
  const base = resolveBase(git, repoPath, baseBranch);
  const result = fastForward(git, repoPath, base);
  const head = git(['rev-parse', 'HEAD'], repoPath);
  const out = { ok: true, path: repoPath, head: head.ok ? head.out : '', updated: result.updated };
  if (result.reason) out.reason = result.reason;
  return out;
}

module.exports = { ensureRepo, defaultGit, defaultValidate, validName, DEFAULT_REPOS_DIR };
