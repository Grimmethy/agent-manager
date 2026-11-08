'use strict';

// apply-clone-dirt.js -- tell GENERATED dirt in the apply clone apart from someone's real uncommitted work, and restore the former.
//
// Why (2026-10-09, TaxHarvest): the repo tracks 31 __pycache__/*.pyc files, so any Python run from the checkout rewrites them. For TaxHarvest the apply
// clone IS the live checkout (AGENT_MANAGER_APPLY_REPO_ROOT unset), which git-runner.js treats as shared and never self-heals, so the dirt was permanent:
// apply-retry-check's isApplyCloneClean() said "dirty" forever and ten approved, infra-held tasks never released.
//
// Scope is deliberately tiny: only an UNSTAGED modification or deletion of a tracked file whose path is a compiled Python cache is restored
// (`git checkout -- <paths>`: worktree only, index and every other file untouched). Anything else stays "other" and keeps blocking.
//
// AGENT_MANAGER_APPLY_CLONE_HEAL=off|dry-run|on (default dry-run: report what would be restored, restore nothing).

const GENERATED_RE = /(?:^|\/)__pycache__\/|\.py[co]$/;
const isGeneratedPath = (p) => GENERATED_RE.test(String(p || '').replace(/\\/g, '/'));

function healMode() {
  const v = String(process.env.AGENT_MANAGER_APPLY_CLONE_HEAL || 'dry-run').toLowerCase();
  return v === 'off' || v === 'false' || v === '0' ? 'off' : v === 'on' || v === 'true' || v === '1' ? 'on' : 'dry-run';
}

// `git status --porcelain --untracked-files=no` output -> { generated: [paths], other: [raw lines] }
function classifyStatus(porcelain) {
  const generated = [];
  const other = [];
  for (const line of String(porcelain || '').split('\n').filter(Boolean)) {
    const x = line[0];
    const y = line[1];
    const file = line.slice(3).replace(/^"|"$/g, '');
    if (x === ' ' && (y === 'M' || y === 'D') && isGeneratedPath(file)) generated.push(file);
    else other.push(line);
  }
  return { generated, other };
}

// run(args) -> stdout (throws on failure). Returns { mode, restored, wouldRestore, other }. Never throws: a failed restore leaves the file in `other`.
function healGeneratedDirt(run, { mode = healMode() } = {}) {
  const result = { mode, restored: [], wouldRestore: [], other: [] };
  if (mode === 'off') return result;
  let status;
  try { status = run(['status', '--porcelain', '--untracked-files=no']); } catch { return result; }
  const { generated, other } = classifyStatus(status);
  result.other = other;
  if (!generated.length) return result;
  if (mode !== 'on') { result.wouldRestore = generated; result.other = other.concat(generated.map((f) => ` M ${f}`)); return result; }
  try {
    run(['checkout', '--', ...generated]);
    result.restored = generated;
  } catch {
    result.other = other.concat(generated.map((f) => ` M ${f}`));
  }
  return result;
}

// Known pipeline paths that are safe to ignore when checking apply clone cleanliness.
// These are docs/references that may be touched by the pipeline itself (e.g. CHANGE_REVIEW_CANDIDATES.md
// is updated by the change-review subsystem) and do NOT represent a real draft conflict.
const KNOWN_PIPELINE_PATHS = ['Docs/CHANGE_REVIEW_CANDIDATES.md'];

// Check if a path is one of the known pipeline paths that should be ignored when
// checking apply clone cleanliness. Used to filter out false positives where the
// pipeline itself wrote to a tracked file (e.g. updating CHANGE_REVIEW_CANDIDATES.md).
function isKnownPipelinePath(p) {
  return KNOWN_PIPELINE_PATHS.includes(String(p || '').replace(/\\/g, '/'));
}

// Validate the apply clone is clean (no uncommitted tracked changes), filtering out
// known pipeline paths that are safe to ignore. Returns { clean, dirtyPaths, reason }.
// `clean` is true when there are no uncommitted tracked changes after filtering known
// pipeline paths. `dirtyPaths` lists the remaining dirty paths (not filtered).
// `reason` is null when clean, otherwise a human-readable description of what's dirty.
function checkApplyCloneCleanliness() {
  try {
    const { applyRepoRoot } = require('./config.js').getConfig();
    const run = (args) => require('child_process').execFileSync('git', args, { cwd: applyRepoRoot, encoding: 'utf8', stdio: 'pipe', timeout: 30_000 });
    const porcelain = run(['status', '--porcelain', '--untracked-files=no']);
    const lines = String(porcelain || '').split('\n').filter(Boolean);
    if (!lines.length) return { clean: true, dirtyPaths: [], reason: null };
    const dirtyPaths = [];
    for (const line of lines) {
      const file = line.slice(3).replace(/^"|"$/g, '');
      if (!isKnownPipelinePath(file)) dirtyPaths.push(file);
    }
    if (!dirtyPaths.length) return { clean: true, dirtyPaths: [], reason: null };
    const reason = `apply clone is dirty (uncommitted tracked changes: ${dirtyPaths[0]}) -- refusing to switch branches`;
    return { clean: false, dirtyPaths, reason };
  } catch {
    return { clean: false, dirtyPaths: [], reason: 'apply clone check failed (git error)' };
  }
}

module.exports = { isGeneratedPath, classifyStatus, healGeneratedDirt, healMode, isKnownPipelinePath, checkApplyCloneCleanliness };
