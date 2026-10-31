'use strict';

// Task source: brain_dump_resolution_check
// Checks if brain-dump entries are already fixed on master.
// Deterministic evidence pack built before model call, capped at ~3000 chars.
// Deterministic validator downgrades 'yes' if evidence not grounded in pack.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildEvidencePack, extractPaths } = require('./evidence-pack.js');
const { validateResolutionVerdict } = require('./validate-resolution.js');

const TASK_CLASS = 'brain_dump_resolution_check';
const EVIDENCE_CAP = 3000;
const CHECKED_META_KEY = 'resolutionCheck';

// Filter entries that should be checked
function shouldCheckEntry(entry) {
  if (entry.status !== 'sorted' && entry.status !== 'captured') return false;
  if (entry.suppressed) return false;
  if (!hasCodeReference(entry.rawText)) return false;
  if (looksLikeResearch(entry.rawText)) return false;
  return true;
}

// Check if entry has backticked code references
function hasCodeReference(text) {
  return /`[^`]+`/.test(text || '');
}

// Check if entry looks like research/links
function looksLikeResearch(text) {
  return /https?:\/\//.test(text || '') || /\b(research|paper|link)\b/i.test(text || '');
}

// An entry has been checked once it carries entry.resolutionCheck. Whether it must be checked AGAIN depends on its cited files (see
// selectEntryToCheck), not on whether master moved (2026-10-30, HUB0274-03: the old rule compared the entry's sha with the CURRENT master sha, so once
// the source worked every master move would have re-checked every entry).
function isAlreadyChecked(entry) {
  return !!(entry && entry[CHECKED_META_KEY]);
}

function sameShas(a, b) {
  const ka = Object.keys(a || {}).sort();
  const kb = Object.keys(b || {}).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && (a[k] || null) === (b[k] || null));
}

function taskIdFor(entry, masterSha) {
  return `brain-dump-resolution-check-${entry.id}-${String(masterSha || 'unknown').slice(0, 7)}`;
}

const byCapturedAt = (a, b) => String(a.capturedAt || '').localeCompare(String(b.capturedAt || ''));

// Pure: the ONE entry to check next, or null. Never-checked entries first (oldest first), then checked entries whose cited files changed since the
// last check (oldest first). ctx: citedShasFor(entry) -> { relPath: lastCommitSha|null }, taskExists(taskId) -> bool, and optionally
// masterShaFor(entry) -> sha (used for the task id and as a fast path: an entry checked at the current master sha has nothing to re-check).
function selectEntryToCheck(entries, { citedShasFor, taskExists, masterShaFor } = {}) {
  const candidates = (Array.isArray(entries) ? entries : []).filter((e) => e && shouldCheckEntry(e));
  const pending = (e) => !(taskExists && taskExists(taskIdFor(e, masterShaFor && masterShaFor(e))));
  const never = candidates.filter((e) => !isAlreadyChecked(e) && pending(e)).sort(byCapturedAt);
  if (never.length) return never[0];
  const changed = candidates.filter((e) => {
    if (!isAlreadyChecked(e) || !pending(e)) return false;
    const check = e[CHECKED_META_KEY];
    if (masterShaFor && check.masterSha && check.masterSha === masterShaFor(e)) return false;
    return !sameShas(citedShasFor ? citedShasFor(e) : {}, check.citedShas);
  }).sort(byCapturedAt);
  return changed[0] || null;
}

function gitOut(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).trim();
  } catch {
    return '';
  }
}

// The registered project in entry.raisedBy.repoRoot, else the core checkout.
function repoRootFor(entry) {
  const core = process.env.AGENT_MANAGER_CORE_REPO_ROOT || path.resolve(__dirname, '..');
  const raised = entry && entry.raisedBy && entry.raisedBy.repoRoot;
  if (!raised) return core;
  try {
    const { readProjectRegistry, originProjectFor } = require('./apply-group-a-brain-dump.js'); // lazy: that module pulls in the task sources
    const project = originProjectFor(entry, readProjectRegistry());
    return (project && project.repoRoot) || core;
  } catch {
    return core;
  }
}

// -> { relPath: last commit sha or null } for the path-like backticked tokens of the entry, in repoRoot.
function citedShasFor(entry, repoRoot) {
  const out = {};
  for (const rel of extractPaths(entry.rawText)) out[rel] = gitOut(['log', '-1', '--format=%H', '--', rel], repoRoot) || null;
  return out;
}

// Next function (registry signature: NO arguments, ONE task or null), modelled on nextBrainDumpSortTask in src/task-sources.js.
function next() {
  const { getConfig } = require('./config.js');
  const { brainDumpPath } = getConfig();
  if (!brainDumpPath || !fs.existsSync(brainDumpPath)) return null;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(brainDumpPath, 'utf8'));
  } catch {
    return null;
  }
  const { taskIdExistsInQueue } = require('./task-sources.js'); // lazy: task-sources.js requires this module
  const headByRoot = new Map();
  const headOf = (root) => {
    if (!headByRoot.has(root)) headByRoot.set(root, gitOut(['rev-parse', 'HEAD'], root));
    return headByRoot.get(root);
  };
  const shaMemo = new Map();
  const entry = selectEntryToCheck(data && data.entries, {
    masterShaFor: (e) => headOf(repoRootFor(e)),
    taskExists: taskIdExistsInQueue,
    citedShasFor: (e) => {
      const root = repoRootFor(e);
      const out = {};
      for (const rel of extractPaths(e.rawText)) {
        const key = `${root}\0${rel}`;
        if (!shaMemo.has(key)) shaMemo.set(key, gitOut(['log', '-1', '--format=%H', '--', rel], root) || null);
        out[rel] = shaMemo.get(key);
      }
      return out;
    },
  });
  if (!entry) return null;
  const repoRoot = repoRootFor(entry);
  const masterSha = headOf(repoRoot);
  if (!masterSha) return null;
  return {
    id: taskIdFor(entry, masterSha),
    domain: TASK_CLASS,
    source: TASK_CLASS,
    title: `Check whether a brain-dump entry is already fixed: ${String(entry.rawText || '').replace(/\s+/g, ' ').slice(0, 80)}`,
    promptContext: {
      rawText: entry.rawText,
      brainDumpEntryId: entry.id,
      evidencePack: buildEvidencePack(entry, masterSha, EVIDENCE_CAP, { repoRoot }),
      masterSha,
      citedShas: citedShasFor(entry, repoRoot),
    },
  };
}

// Apply function: sets possiblyResolved on validated 'yes', records check otherwise
function apply(options) {
  const { entry, verdict, evidence, masterSha } = options;
  
  if (verdict.resolved === 'yes') {
    entry.possiblyResolved = {
      evidence: evidence,
      masterSha: masterSha,
      checkedAt: new Date().toISOString(),
    };
  } else {
    entry[CHECKED_META_KEY] = {
      at: new Date().toISOString(),
      masterSha: masterSha,
      verdict: verdict.resolved,
    };
  }
}

// Validate verdict deterministically
function validate(options) {
  const { verdict, evidence, evidencePack } = options;
  return validateResolutionVerdict(verdict, evidence, evidencePack);
}

// Local call function (injected in tests)
function localCall(options) {
  const { entry, evidencePack } = options;
  // Default response: unclear
  return { resolved: 'unclear', evidence: '' };
}

module.exports = {
  TASK_CLASS,
  EVIDENCE_CAP,
  CHECKED_META_KEY,
  next,
  apply,
  validate,
  localCall,
  hasCodeReference,
  looksLikeResearch,
  isAlreadyChecked,
  selectEntryToCheck,
  repoRootFor,
  citedShasFor,
};
