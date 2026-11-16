'use strict';

// Pre-draft premise check: does a task claim to CREATE a file that already exists at the
// grounding ref? Read-only git only (cat-file, log). Never throws; any error -> proceed.
// The caller resolves groundingRef (via the stacked-grounding.js resolver) and
// passes the plain branch name in; this module reads origin/<groundingRef>.

const path = require('path');
const { execFileSync } = require('child_process');

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
const GIT_TIMEOUT_MS = 60_000;
const EXT_ALT = 'js|ts|py|ps1|sh';
// Same shape as apply-adhoc-diff.js CREATED_FILE_RE, but global (path = capture group 1).
const CREATED_FILE_RE = /\b(?:create|add|write|scaffold)\b(?:[^.\n]{0,60}?)\b([\w./-]+\.(?:js|ts|py|ps1|sh))\b/gi;
const PATH_LIKE_RE_SRC = `\\b([\\w./-]+\\.(?:${EXT_ALT}))\\b`;

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: GIT_ENV,
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function normalizePath(p) {
  const s = path.posix.normalize(String(p || '').replace(/\\/g, '/').replace(/^(\.\/)+/, ''));
  if (!s || s === '.' || s.startsWith('/') || /^[A-Za-z]:/.test(s) || s.split('/').includes('..')) return null;
  return s;
}

function existsAtRef(repoRoot, ref, file) {
  try {
    git(['cat-file', '-e', `origin/${ref}:${file}`], repoRoot);
    return true;
  } catch {
    return false;
  }
}

function logLineAtRef(repoRoot, ref, file) {
  try {
    return git(['log', '-1', '--format=%h %s', `origin/${ref}`, '--', file], repoRoot).trim();
  } catch {
    return '';
  }
}

function checkPremise({ repoRoot, taskText, groundingRef } = {}) {
  try {
    const text = String(taskText || '');

    // Claimed created files: fresh global regex per call so no lastIndex state leaks.
    const claimed = [];
    const claimedSet = new Set();
    const createdRe = new RegExp(CREATED_FILE_RE.source, 'gi');
    for (let m = createdRe.exec(text); m !== null; m = createdRe.exec(text)) {
      const p = normalizePath(m[1]);
      if (p && !claimedSet.has(p)) {
        claimedSet.add(p);
        claimed.push(p);
      }
    }

    // Existence check at the grounding ref (skipped when no ref is supplied).
    const ref = typeof groundingRef === 'string' && groundingRef.trim() ? groundingRef.trim() : null;
    if (ref && claimed.length) {
      const built = [];
      for (const p of claimed) {
        if (existsAtRef(repoRoot, ref, p)) {
          built.push({ path: p, logLine: logLineAtRef(repoRoot, ref, p) });
        }
      }
      if (built.length) return { kind: 'stop', reason: 'premise-already-built', files: built };
    }

    // Other path-like files named in the task that are not claimed as created files.
    const others = [];
    const otherSeen = new Set();
    const pathRe = new RegExp(PATH_LIKE_RE_SRC, 'gi');
    for (let m = pathRe.exec(text); m !== null; m = pathRe.exec(text)) {
      const p = normalizePath(m[1]);
      if (!p || claimedSet.has(p) || otherSeen.has(p)) continue;
      otherSeen.add(p);
      others.push({ path: p });
    }
    if (others.length) return { kind: 'note', files: others };

    return { kind: 'proceed' };
  } catch {
    return { kind: 'proceed' };
  }
}

module.exports = { checkPremise };
