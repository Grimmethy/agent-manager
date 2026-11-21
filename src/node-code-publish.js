'use strict';

// Builds the code bundle that nodes pull (FF-4/4a, piece 1a).
// The bundle holds refs/heads/<branch> and is made from refs/remotes/origin/<branch> of repoDir, never from the working copy HEAD.
// repoDir is only read: against it this module runs `rev-parse --verify`, and it is the source of one fetch (run inside a scratch bare repo).
// It is a plain function called by piece 1b from the branch drain: no timer, no poll.

const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { writeJsonAtomicSync } = require('./atomic-write');

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

const KEEP_PER_REPO = 3;
const LATEST_NAME = 'latest.json';

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Reads latest.json through the injected fs. Missing, unparsable or non-array content gives []; never throws.
function readList(outDir, fs) {
  try {
    const parsed = JSON.parse(String(fs.readFileSync(path.join(outDir, LATEST_NAME), 'utf8')));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e) => e && typeof e === 'object' && typeof e.repo === 'string');
  } catch (_) {
    return [];
  }
}

function resolveOutDir(opts) {
  if (opts.outDir) return opts.outDir;
  if (process.env.AGENT_MANAGER_CODE_PUBLISH_DIR) return process.env.AGENT_MANAGER_CODE_PUBLISH_DIR;
  const pipelineDir = opts.pipelineDir || process.env.AGENT_MANAGER_PIPELINE_DIR || process.env.AGENT_MANAGER_REPO_ROOT;
  if (!pipelineDir) {
    throw new Error('node-code-publish: outDir, AGENT_MANAGER_CODE_PUBLISH_DIR or AGENT_MANAGER_PIPELINE_DIR is required');
  }
  return path.join(pipelineDir, 'code-publish');
}

// Keeps the KEEP_PER_REPO newest bundles for this repo (plus the one latest.json names). Other repos are never touched.
function pruneOld(outDir, repo, keepName, fs) {
  try {
    const re = new RegExp('^' + escapeRegExp(repo) + '-[0-9a-f]{8}\\.bundle$');
    const mine = fs.readdirSync(outDir).filter((n) => re.test(n)).map((name) => {
      let mtime = 0;
      try { mtime = fs.statSync(path.join(outDir, name)).mtimeMs; } catch (_) { /* treat as oldest */ }
      return { name, mtime };
    });
    mine.sort((a, b) => (b.mtime - a.mtime) || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
    const keep = new Set([keepName]);
    for (const m of mine) {
      if (keep.size >= KEEP_PER_REPO) break;
      keep.add(m.name);
    }
    for (const m of mine) {
      if (keep.has(m.name)) continue;
      try { fs.unlinkSync(path.join(outDir, m.name)); } catch (_) { /* best effort */ }
    }
  } catch (_) {
    // a prune failure must not fail the publish
  }
}

// Builds the bundle first, then writes latest.json. Same current sha with the bundle present writes nothing.
function publishCode(options) {
  const opts = options || {};
  const repo = opts.repo === undefined ? 'agent-manager' : opts.repo;
  const branch = opts.branch === undefined ? 'master' : opts.branch;
  const run = opts.run || defaultRun;
  const fs = opts.fs || nodeFs;
  if (!opts.repoDir || typeof opts.repoDir !== 'string') throw new Error('node-code-publish: repoDir is required');
  checkName('repo', repo);
  checkName('branch', branch);
  const outDir = resolveOutDir(opts);

  const currentSha = String(run(['rev-parse', '--verify', 'refs/remotes/origin/' + branch], opts.repoDir)).trim();
  const existing = readList(outDir, fs).find((e) => e.repo === repo);
  if (existing && existing.sha === currentSha && typeof existing.bundle === 'string'
      && fs.existsSync(path.join(outDir, path.basename(existing.bundle)))) {
    return { reason: 'current', sha: currentSha, bundle: existing.bundle, branch };
  }

  const result = buildBundle({ ...opts, repo, branch, outDir, run, fs });
  const entry = { repo, sha: result.sha, bundle: path.basename(result.bundle), branch: result.branch };
  const others = readList(outDir, fs).filter((e) => e.repo !== repo);
  writeJsonAtomicSync(path.join(outDir, LATEST_NAME), [...others, entry]);
  pruneOld(outDir, repo, entry.bundle, fs);
  return { reason: 'published', sha: result.sha, bundle: entry.bundle, branch: result.branch };
}

// Returns this repo's entry from latest.json, or null. Never throws.
function readPublished(outDir, repo) {
  try {
    return readList(outDir, nodeFs).find((e) => e.repo === repo) || null;
  } catch (_) {
    return null;
  }
}

module.exports = { buildBundle, publishCode, readPublished };
