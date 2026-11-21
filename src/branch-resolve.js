'use strict';

// Resolves a branch-name fragment against rows that are already filtered by project.
// Exact match wins. Otherwise a case-insensitive contains match is tried, but only for fragments of at least 12 characters.
// The helper does no project filtering and never touches sha or merge-check data.

const MIN_CONTAINS_LENGTH = 12;
const MAX_CANDIDATES = 5;
const CANDIDATE_TAIL = 60;
const MAX_NEAREST = 3;

function sharedPrefixLength(a, b) {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

function resolveBranchName(fragment, rows) {
  const list = Array.isArray(rows) ? rows : [];

  const exact = list.filter((r) => r.branch === fragment);
  if (exact.length > 1) return { error: 'multi-project' };
  if (exact.length === 1) return { mode: 'exact', row: exact[0] };

  if (fragment.length >= MIN_CONTAINS_LENGTH) {
    const needle = fragment.toLowerCase();
    const hits = list.filter((r) => r.branch.toLowerCase().includes(needle));
    if (hits.length === 1) return { mode: 'contains', row: hits[0] };
    if (hits.length > 1) {
      return {
        error: 'ambiguous',
        candidates: hits.slice(0, MAX_CANDIDATES).map((r) => r.branch.slice(-CANDIDATE_TAIL)),
      };
    }
  }

  const ranked = list
    .map((r) => ({ branch: r.branch, shared: sharedPrefixLength(fragment, r.branch) }))
    .sort((a, b) => {
      if (b.shared !== a.shared) return b.shared - a.shared;
      if (a.branch < b.branch) return -1;
      if (a.branch > b.branch) return 1;
      return 0;
    });

  const nearest = [];
  for (const { branch } of ranked) {
    if (!nearest.includes(branch)) nearest.push(branch);
    if (nearest.length === MAX_NEAREST) break;
  }
  return { error: 'none', nearest };
}

module.exports = { resolveBranchName };
