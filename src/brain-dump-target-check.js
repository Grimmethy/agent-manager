'use strict';

// Deterministic pre-queue target check for brain_dump_sort (2026-10-24, discard analysis: brain-dump-derived adhoc tasks were discarded 24% of
// the time, 6x the rate of other adhoc work). Looks only at what the entry's own text cites; it never calls a model.
//
// An entry is 'suspect' (not queued as a task) when
//   (a) it cites repo paths and EVERY one is missing from the matched project's repo (one missing path alone is not enough: files can be new);
//   (b) a cited path has an `archive/` segment (retired code: TaxHarvest's client-deliverables flow lives under TaxHarvest/archive/);
//   (c) it uses one of the explicit hub-sequencing phrasings ('dependency-ordering hazard', 'absent on the shared branch'): a sequencing note about
//       unmerged siblings, not a code defect (the 'Prerequisite modules absent' entry led to a branch that copied three modules the hub stack already held).
//       A bare 'pending-merge' next to a hub id is NOT enough: a replay over brain-dump adhoc verdicts flagged a merged HUB0007 usage-fields fix that way.
// Fail open: when the repo cannot be listed (no git, unreadable) a path counts as present, so uncertainty never blocks an entry.
//
// Kill switch: AGENT_MANAGER_BRAIN_DUMP_TARGET_CHECK=false.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Backticked tokens that look like repo paths: a known source/doc extension, optional :line or :line-line suffix.
const PATH_RE = /`([A-Za-z0-9_][A-Za-z0-9_.\-/]*\.(?:js|mjs|cjs|ts|tsx|jsx|py|md|json|sh|ps1|html|css|ya?ml|toml|txt))(?::\d+(?:-\d+)?)?`/g;
const HUB_SEQUENCING_RES = [
  /dependency-ordering hazard/i,
  /\babsent on the shared branch\b/i,
];

function isEnabled(env = process.env) {
  return env.AGENT_MANAGER_BRAIN_DUMP_TARGET_CHECK !== 'false';
}

function citedPaths(text) {
  const out = [];
  const src = String(text == null ? '' : text);
  PATH_RE.lastIndex = 0;
  let m;
  while ((m = PATH_RE.exec(src))) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

// -> (relPath) => boolean for `repoRoot`: present at repoRoot/relPath or as the tail of a tracked file (a monorepo prefix such as TaxHarvest/).
// A listing failure answers true for everything (fail open).
function defaultExists(repoRoot) {
  let tracked;
  return (rel) => {
    try {
      if (fs.existsSync(path.join(repoRoot, rel))) return true;
      if (tracked === undefined) {
        tracked = execFileSync('git', ['-C', repoRoot, 'ls-files'], { encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 * 1024 }).split('\n');
      }
      const tail = '/' + rel;
      return tracked.some((f) => f === rel || f.endsWith(tail));
    } catch {
      return true;
    }
  };
}

// -> { verdict: 'ok' | 'suspect', reasons: string[], cited: string[] }
function checkEntryTargets(entryText, { repoRoot, exists } = {}) {
  const text = String(entryText == null ? '' : entryText);
  const cited = citedPaths(text);
  const reasons = [];
  if (cited.length) {
    const has = exists || (repoRoot ? defaultExists(repoRoot) : () => true);
    const missing = cited.filter((p) => !has(p));
    if (missing.length === cited.length) reasons.push(`every cited path is missing from the target repo (${missing.slice(0, 4).join(', ')})`);
    const archived = cited.filter((p) => /(^|\/)archive\//.test(p));
    if (archived.length) reasons.push(`cites retired code under archive/ (${archived.slice(0, 3).join(', ')})`);
  }
  if (HUB_SEQUENCING_RES.some((re) => re.test(text))) reasons.push("describes a stacked hub piece as a dependency-ordering hazard / absent on the shared branch: a sequencing note, not a code defect");
  return { verdict: reasons.length ? 'suspect' : 'ok', reasons, cited };
}

module.exports = { checkEntryTargets, citedPaths, defaultExists, isEnabled };
