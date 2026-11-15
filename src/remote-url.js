// Remote URL reader (HUB0402 subtask 1): returns the `origin` URL of the git checkout at repoRoot, trimmed, or '' on any failure
// (missing repoRoot, not a git directory, no origin remote, timeout). One git process per call.

'use strict';

const { execFileSync } = require('node:child_process');

function readRemoteUrl(repoRoot) {
  try {
    const out = execFileSync('git', ['-C', repoRoot, 'remote', 'get-url', 'origin'], { timeout: 5000, encoding: 'utf8' });
    return String(out).trim();
  } catch (e) {
    return '';
  }
}

module.exports = { readRemoteUrl };
