'use strict';

// chat-status.js -- pure read-only status of a repo's checkout vs origin.
//
// Called from the chat layer to surface whether the working tree is up to date with
// origin, how far behind it is, and whether any files are dirty. The chat uses this
// to warn the user before a write-agentic or queue_reviewed_task call that would
// ship stale/modified state without their knowledge.
//
// Pure function: takes repoRoot + the chat's toolNames + the upstream gates, runs
// only read-only git/fs ops, returns a plain status object. No HTTP, no writes, no
// side effects. Tests inject `opts.runGit` / `opts.statSync` to avoid touching the
// real filesystem.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const EXPECTED_CHAT_TOOLS = [
  'check_branch',
  'record_branch_verdict',
  'list_unverified_branches',
  'queue_reviewed_task',
  'run_bash',
  'read_file',
  'grep_codebase',
  'search_tasks',
  'read_task',
];

const STALE_FETCH_HOURS = 24;
const GIT_TIMEOUT_MS = 10_000;

// Default read-only git runner. Tests swap in `opts.runGit` to avoid real git.
function defaultRunGit(repoRoot, args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function chatStatus({ repoRoot, toolNames, gates }, opts = {}) {
  const runGit = opts.runGit || defaultRunGit;
  const statSync = opts.statSync || fs.statSync.bind(fs);

  // --- FETCH_HEAD mtime ---------------------------------------------------
  let lastFetchAt = null;
  let behindMayBeStale = false;
  try {
    const fetchHeadPath = path.join(repoRoot, '.git', 'FETCH_HEAD');
    const stat = statSync(fetchHeadPath);
    lastFetchAt = stat.mtime.toISOString();
    const hoursSince = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60);
    behindMayBeStale = hoursSince > STALE_FETCH_HOURS;
  } catch {
    behindMayBeStale = true;
  }

  // --- Read-only git queries ---------------------------------------------
  let checkoutHead = null;
  let originBase = null;
  let originBaseHead = null;
  let behind = 0;
  let dirtyFiles = [];

  const safe = (args) => {
    try {
      return runGit(repoRoot, args);
    } catch {
      return null;
    }
  };

  checkoutHead = safe(['rev-parse', 'HEAD']);
  originBase = safe(['rev-parse', 'origin/HEAD']);
  originBaseHead = safe(['rev-parse', 'origin/HEAD^{commit}']);

  const behindRaw = safe(['rev-list', '--count', 'HEAD..origin/HEAD']);
  if (behindRaw !== null) {
    const n = Number(behindRaw);
    behind = Number.isFinite(n) ? n : 0;
  }

  const porcelain = safe(['status', '--porcelain']);
  if (porcelain !== null) {
    dirtyFiles = porcelain.split('\n').filter((line) => line.length > 0);
  }

  // --- Tool / gate accounting --------------------------------------------
  const tools = EXPECTED_CHAT_TOOLS.filter((t) => toolNames && toolNames.includes(t));
  const missingExpectedTools = EXPECTED_CHAT_TOOLS.filter((t) => !(toolNames && toolNames.includes(t)));

  const mergeVerdictNeedsCheck =
    !!(toolNames && toolNames.includes('record_branch_verdict')) &&
    !!(toolNames && toolNames.includes('check_branch'));

  const warning =
    missingExpectedTools.length > 0
      ? `missing chat tools: ${missingExpectedTools.join(', ')}`
      : behindMayBeStale
        ? 'last fetch is older than 24 hours; behind count may be stale'
        : null;

  return {
    checkoutHead,
    originBase,
    originBaseHead,
    behind,
    lastFetchAt,
    behindMayBeStale,
    dirtyFileCount: dirtyFiles.length,
    dirtyFiles,
    tools,
    missingExpectedTools,
    gates: { mergeVerdictNeedsCheck },
    warning,
  };
}

module.exports = { chatStatus, EXPECTED_CHAT_TOOLS };
