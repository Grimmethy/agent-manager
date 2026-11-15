'use strict';

// Build evidence pack for brain_dump_resolution_check
// Capped at ~3000 characters total
// Includes: entry text, cited paths with existence/commits, cited identifiers with grep hits, recent commits
//
// 2026-10-30 (HUB0274-01): every git call runs through execFileSync with an argv array, never a shell string, and in the repo being checked
// (`repoRoot`, default the process cwd). Before, the calls were `execSync` strings built from the backticked text of the entry itself, so an entry
// containing `$(...)` could run shell code, the calls ran in whatever directory the process had, `git log --format=%h %s` was split by the shell,
// and every backticked token was looked up as BOTH a path and an identifier. A cited path must now look like a path and a cited identifier like an
// identifier (a token that is neither is ignored), at most MAX_PER_KIND of each.

const { execFileSync } = require('child_process');

const PATH_TOKEN_RE = /^[\w@./-]+\.[A-Za-z0-9]{1,5}(?::\d+(?:-\d+)?)?$/;
const IDENTIFIER_TOKEN_RE = /^[A-Za-z_$][\w$]{3,}(?:\(\))?$/;
const REF_RE = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,99}$/; // a sha or ref name: never starts with '-', so it can never be read as a git option
const MAX_PER_KIND = 4;
const GIT_TIMEOUT_MS = 10000;

function runGit(args, repoRoot) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
}

function buildEvidencePack(entry, masterSha, cap, { repoRoot } = {}) {
  const root = repoRoot || process.cwd();
  const sha = REF_RE.test(String(masterSha || '')) ? String(masterSha) : null;
  const pack = {
    entryText: truncate((entry && entry.rawText) || '', 500),
    citedPaths: [],
    citedIdentifiers: [],
    recentCommits: [],
  };

  const paths = extractPaths(entry && entry.rawText);
  const identifiers = extractIdentifiers(entry && entry.rawText);

  // Check each cited path
  for (const filePath of paths) {
    const exists = checkPathExists(filePath, sha, root);
    const commits = getRecentCommitsForPath(filePath, sha, root);
    pack.citedPaths.push({ path: filePath, exists, commits });
  }

  // Check each cited identifier
  for (const identifier of identifiers) {
    const hits = getGitGrepHits(identifier, sha, root);
    pack.citedIdentifiers.push({ identifier, hits });
  }

  // Get commits since entry's capturedAt that touched cited files
  if (entry && entry.capturedAt && paths.length > 0) {
    pack.recentCommits = getCommitsSince(entry.capturedAt, paths, sha, root);
  }

  // Cap at specified length
  return capEvidencePack(pack, cap);
}

function backtickedTokens(text) {
  const seen = new Set();
  for (const m of String(text || '').matchAll(/`([^`\n]+)`/g)) {
    const token = m[1].trim();
    if (token) seen.add(token);
  }
  return [...seen];
}

// Backticked tokens that look like a file path, a trailing :line or :line-line stripped.
function extractPaths(text) {
  const out = [];
  for (const token of backtickedTokens(text)) {
    if (!PATH_TOKEN_RE.test(token)) continue;
    const p = token.replace(/:\d+(?:-\d+)?$/, '');
    if (!out.includes(p)) out.push(p);
    if (out.length >= MAX_PER_KIND) break;
  }
  return out;
}

// Backticked tokens that look like a code identifier (a call's trailing "()" stripped).
function extractIdentifiers(text) {
  const out = [];
  for (const token of backtickedTokens(text)) {
    if (!IDENTIFIER_TOKEN_RE.test(token)) continue; // no dot allowed, so a path token can never be an identifier
    const id = token.replace(/\(\)$/, '');
    if (!out.includes(id)) out.push(id);
    if (out.length >= MAX_PER_KIND) break;
  }
  return out;
}

function checkPathExists(filePath, sha, repoRoot) {
  if (!sha) return false;
  try {
    runGit(['cat-file', '-e', `${sha}:${filePath}`], repoRoot);
    return true;
  } catch {
    return false;
  }
}

function getRecentCommitsForPath(filePath, sha, repoRoot) {
  if (!sha) return [];
  try {
    return runGit(['log', '-3', '--format=%h %s', sha, '--', filePath], repoRoot).trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function getGitGrepHits(identifier, sha, repoRoot) {
  if (!sha) return [];
  try {
    return runGit(['grep', '-n', '-F', '-e', identifier, sha], repoRoot).trim().split('\n').slice(0, 3).filter(Boolean);
  } catch {
    return [];
  }
}

function getCommitsSince(capturedAt, paths, sha, repoRoot) {
  if (!sha) return [];
  try {
    const since = new Date(capturedAt).toISOString();
    return runGit(['log', '--format=%h %s', `--since=${since}`, sha, '--', ...paths], repoRoot).trim().split('\n').slice(0, 5).filter(Boolean);
  } catch {
    return [];
  }
}

function truncate(text, maxLen) {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '...';
}

function capEvidencePack(pack, cap) {
  const json = JSON.stringify(pack);
  if (json.length <= cap) return pack;

  // Truncate strategically
  pack.entryText = truncate(pack.entryText, 200);
  pack.citedPaths = pack.citedPaths.slice(0, 2);
  pack.citedIdentifiers = pack.citedIdentifiers.slice(0, 2);
  pack.recentCommits = pack.recentCommits.slice(0, 3);

  return pack;
}

module.exports = { buildEvidencePack, extractPaths, extractIdentifiers };
