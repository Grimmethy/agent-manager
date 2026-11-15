// Plugin sync matcher and checkout classifier (HUB0429 1/6).
// Pure helpers: matchPluginsByRemote compares origin remotes, classifyCheckout reads git state
// without changing it, and fastForwardClean pulls only a clean checkout that is behind.
// Nothing here runs on a clock; callers invoke these exports when a merge happens.

'use strict';

const { execFileSync } = require('node:child_process');
const { readRemoteUrl } = require('./remote-url');

const READ_TIMEOUT_MS = 5000;
const PULL_TIMEOUT_MS = 60000;

function normaliseRemote(url) {
  if (!url) return '';
  let s = String(url).trim();
  while (s.endsWith('/')) s = s.slice(0, -1);
  if (s.endsWith('.git')) s = s.slice(0, -4);
  while (s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

function runGit(cwd, args, timeout) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function matchPluginsByRemote(remoteUrl, entries) {
  const want = normaliseRemote(remoteUrl);
  if (!want || !Array.isArray(entries)) return [];
  return entries.filter((entry) => {
    if (!entry || typeof entry.registerPath !== 'string') return false;
    const dir = entry.registerPath.trim();
    if (!dir) return false;
    const got = normaliseRemote(readRemoteUrl(dir));
    return got !== '' && got === want;
  });
}

function classifyCheckout(cwd, mergedCommit) {
  const status = runGit(cwd, ['status', '--porcelain'], READ_TIMEOUT_MS);
  if (status.trim() !== '') {
    return { state: 'skipped-dirty', reason: 'working tree has uncommitted changes' };
  }

  const head = runGit(cwd, ['rev-parse', 'HEAD'], READ_TIMEOUT_MS).trim();
  if (head === mergedCommit) {
    return { state: 'up-to-date', reason: 'HEAD equals the merged commit' };
  }

  let isAncestor;
  try {
    runGit(cwd, ['merge-base', '--is-ancestor', mergedCommit, 'HEAD'], READ_TIMEOUT_MS);
    isAncestor = true;
  } catch (e) {
    if (e && e.status === 1) {
      isAncestor = false;
    } else {
      throw e;
    }
  }

  if (!isAncestor) {
    return { state: 'behind', reason: 'merged commit is not an ancestor of HEAD' };
  }
  return { state: 'updated-needed', reason: 'merged commit is an ancestor of HEAD but HEAD differs' };
}

function fastForwardClean(cwd, mergedCommit) {
  const classification = classifyCheckout(cwd, mergedCommit);
  if (classification.state !== 'behind') {
    return { ...classification, pulled: false };
  }
  try {
    runGit(cwd, ['pull', '--ff-only'], PULL_TIMEOUT_MS);
    return { ...classification, pulled: true };
  } catch (e) {
    return { ...classification, pulled: false, error: String((e && e.message) || e) };
  }
}

module.exports = { matchPluginsByRemote, classifyCheckout, fastForwardClean };
