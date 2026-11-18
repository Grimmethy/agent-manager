'use strict';

/**
 * cited-code-liveness.js
 *
 * Pure, synchronous guard: does a cited repo-relative file still exist under repoRoot?
 * One-shot fs.statSync -- no timers, no polling.
 *
 * checkCitedCodeLiveness(repoRoot, relPath) -> { path, alive, error? }
 *   - non-string / empty / absolute relPath      -> alive:false, error:'invalid-path'
 *   - relPath resolving outside repoRoot          -> alive:false, error:'outside-repo'
 *   - ENOENT                                      -> alive:false
 *   - regular file                                -> alive:true
 *   - any other throw                             -> alive:false, error: err.message
 */

const fs = require('node:fs');
const path = require('node:path');

function checkCitedCodeLiveness(repoRoot, relPath) {
  const p = typeof relPath === 'string' ? relPath : String(relPath);

  if (typeof relPath !== 'string' || relPath === '' || path.isAbsolute(relPath)
    || typeof repoRoot !== 'string' || repoRoot === '') {
    return { path: p, alive: false, error: 'invalid-path' };
  }

  const root = path.resolve(repoRoot);
  const abs = path.resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return { path: p, alive: false, error: 'outside-repo' };
  }

  try {
    const st = fs.statSync(abs);
    if (st.isFile()) return { path: p, alive: true };
    return { path: p, alive: false };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { path: p, alive: false };
    return { path: p, alive: false, error: err && err.message ? err.message : String(err) };
  }
}

module.exports = { checkCitedCodeLiveness };
