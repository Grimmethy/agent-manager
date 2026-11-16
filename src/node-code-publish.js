'use strict';

// Builds the code bundle that nodes pull (FF-4/4a, piece 1a).
// The bundle holds refs/heads/<branch> and is made from refs/remotes/origin/<branch> of repoDir, never from the working copy HEAD.
// repoDir is only read: against it this module runs `rev-parse --verify`, and it is the source of one fetch (run inside a scratch bare repo).
// It is a plain function called by piece 1b from the branch drain: no timer, no poll.

const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const GIT_TIMEOUT_MS = 25000;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SHA_RE = /^[0-9a-f]{40}$/;

function defaultRun(args, cwd) {
  return execFileSync('git', args, {
    cwd: cwd || undefined,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function checkName(label, value) {
  if (typeof value !== 'string' || !SAFE_NAME.test(value) || value.includes('..')) {
    throw new Error(`node-code-publish: invalid ${label}: ${JSON.stringify(value)}`);
  }
}

function buildBundle(options) {
  const opts = options || {};
  const repoDir = opts.repoDir;
  const outDir = opts.outDir;
  const repo = opts.repo === undefined ? 'agent-manager' : opts.repo;
  const branch = opts.branch === undefined ? 'master' : opts.branch;
  const run = opts.run || defaultRun;
  const fs = opts.fs || nodeFs;
  const now = opts.now || Date.now;

  if (!repoDir || typeof repoDir !== 'string') throw new Error('node-code-publish: repoDir is required');
  if (!outDir || typeof outDir !== 'string') throw new Error('node-code-publish: outDir is required');
  checkName('repo', repo);
  checkName('branch', branch);

  const sourceRef = 'refs/remotes/origin/' + branch;
  const headRef = 'refs/heads/' + branch;

  const sha = String(run(['rev-parse', '--verify', sourceRef], repoDir)).trim();
  if (!SHA_RE.test(sha)) throw new Error(`node-code-publish: ${sourceRef} did not resolve to a sha`);

  const bundleName = `${repo}-${sha.slice(0, 8)}.bundle`;
  const finalPath = path.join(outDir, bundleName);
  const partPath = finalPath + '.part';

  fs.mkdirSync(outDir, { recursive: true });
  let scratch = null;
  try {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), `node-code-publish-${now()}-`));
    run(['init', '--bare', '-q', scratch], undefined);
    run(['fetch', '-q', repoDir, `${sourceRef}:${headRef}`], scratch);
    run(['bundle', 'create', partPath, headRef], scratch);
    run(['bundle', 'verify', partPath], scratch);
    const listing = String(run(['ls-remote', partPath, headRef], scratch)).split('\n')[0] || '';
    const listed = listing.split(/\s+/)[0];
    if (listed !== sha) {
      throw new Error(`node-code-publish: refusing, bundle ${headRef} is ${listed || 'missing'} but expected ${sha}`);
    }
    fs.renameSync(partPath, finalPath);
  } catch (err) {
    try { fs.rmSync(partPath, { force: true }); } catch (_) { /* best effort */ }
    throw err;
  } finally {
    if (scratch) {
      try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    }
  }

  return { sha, bundle: bundleName, branch };
}

module.exports = { buildBundle };
