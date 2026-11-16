'use strict';
// Reads the published code manifest for the agent-manager code-publish feature.
// readPublished() reads AGENT_MANAGER_CODE_PUBLISH_DIR at call time and parses
// <dir>/published.json, which is expected to hold an array of {repo, sha}.
// Returns [{repo, sha}] on success and [] on any failure: env var unset or empty,
// file missing or unreadable, invalid JSON, or non-array content.
// Read-only; no timers or scheduled work.

const fs = require('node:fs');
const path = require('node:path');

function readPublished() {
  const dir = process.env.AGENT_MANAGER_CODE_PUBLISH_DIR;
  if (!dir) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'published.json'), 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e) => e && typeof e.repo === 'string' && typeof e.sha === 'string')
      .map((e) => ({ repo: e.repo, sha: e.sha }));
  } catch {
    return [];
  }
}

module.exports = { readPublished };
