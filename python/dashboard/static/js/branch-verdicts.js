'use strict';

// Verdict rendering for the Unmerged Branches tab (backend: python/dashboard/branch_verdicts.py).
// Kept out of branches-joblist-hardware-tabs.js on purpose (hot file) -- that file only calls the helpers
// below. Pure string/array functions, no DOM, so they are testable from Node.
//
// Border color per card: green = merge, yellow = needs-work, red = discard, grey = unverified or stale.

const BRANCH_VERDICT_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'unverified', label: 'Unverified' },
  { key: 'merge', label: 'Ready to merge' },
  { key: 'needs-work', label: 'Needs work' },
  { key: 'discard', label: 'Discard' },
];

let branchVerdictFilter = 'all';

// The bucket a branch falls in. A stale verdict is "unverified" -- it vouches for an older commit.
function branchVerdictKey(b) {
  if (!b || b.stale || !b.verdict) return 'unverified';
  return ['merge', 'needs-work', 'discard'].includes(b.verdict) ? b.verdict : 'unverified';
}

function branchVerdictColorVar(key) {
  return { merge: 'var(--ok)', 'needs-work': 'var(--warn)', discard: 'var(--bad)' }[key] || 'var(--muted)';
}

// Inline style for the card: a colored left border plus a thin outline in the same color.
function branchVerdictBorderStyle(b) {
  const c = branchVerdictColorVar(branchVerdictKey(b));
  return `border-left:5px solid ${c};border-color:${c};`;
}

function _bvEscape(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

const _BV_BADGE_CLASS = { merge: 'ok', 'needs-work': 'warn', discard: 'bad' };
const _BV_WORD = { merge: 'merge', 'needs-work': 'needs work', discard: 'discard' };

// Badge with the verdict word plus a one-line reason under the title.
function branchVerdictBadgeHtml(b) {
  const key = branchVerdictKey(b);
  const first = (b && Array.isArray(b.reasons) && b.reasons[0]) || '';
  if (key === 'unverified') {
    const note = b && b.stale ? 'verdict is for an older commit' : '';
    return `<span class="badge idle" data-verdict="unverified">unverified</span>` + (note ? `<div class="meta" style="font-size:12px">${_bvEscape(note)}</div>` : '');
  }
  const src = b.source ? ` title="${_bvEscape('source: ' + b.source)}"` : '';
  return `<span class="badge ${_BV_BADGE_CLASS[key]}" data-verdict="${key}"${src}>${_BV_WORD[key]}</span>`
    + (first ? `<div class="meta" style="font-size:12px">${_bvEscape(first)}</div>` : '');
}

// Full reasons list, for the detail view.
function branchVerdictDetailHtml(b) {
  const key = branchVerdictKey(b);
  const reasons = Array.isArray(b && b.reasons) ? b.reasons : [];
  let html = `<div class="field-label">Verdict</div><div>${branchVerdictBadgeHtml({ ...b, reasons: [] })}`;
  if (b && b.source) html += ` <span class="meta">${_bvEscape(b.source)}${b.verifiedAt ? ' · ' + _bvEscape(b.verifiedAt) : ''}</span>`;
  html += '</div>';
  if (reasons.length) html += '<ul style="margin:4px 0 0 18px">' + reasons.map((r) => `<li>${_bvEscape(r)}</li>`).join('') + '</ul>';
  return key === 'unverified' && !reasons.length && !(b && b.stale) ? '' : html;
}

function filterBranchesByVerdict(branches, filterKey) {
  if (!filterKey || filterKey === 'all') return branches;
  return branches.filter((b) => branchVerdictKey(b) === filterKey);
}

function branchVerdictFilterBarHtml(branches, activeKey) {
  const counts = {};
  for (const b of branches) counts[branchVerdictKey(b)] = (counts[branchVerdictKey(b)] || 0) + 1;
  return '<div class="row" data-verdict-filter-bar style="gap:8px;margin-bottom:10px">' + BRANCH_VERDICT_FILTERS.map((f) => {
    const n = f.key === 'all' ? branches.length : (counts[f.key] || 0);
    const cls = f.key === activeKey ? 'action' : 'secondary';
    return `<button class="${cls}" data-verdict-filter="${f.key}">${_bvEscape(f.label)} (${n})</button>`;
  }).join('') + '</div>';
}

// Browser-only: (re)build the filter bar + filtered card list into `main`. Uses the globals
// branchCardHtml / wireBranchCard from branches-joblist-hardware-tabs.js at CALL time.
function renderBranchListInto(main, branches) {
  const shown = filterBranchesByVerdict(branches, branchVerdictFilter);
  main.innerHTML = branchVerdictFilterBarHtml(branches, branchVerdictFilter)
    + (shown.length ? shown.map(branchCardHtml).join('') : '<div class="empty">No branches match this filter.</div>');
  main.querySelectorAll('[data-branch-row]').forEach(wireBranchCard);
  wireBranchVerdictFilterBar(main);
}

function wireBranchVerdictFilterBar(main) {
  main.querySelectorAll('[data-verdict-filter]').forEach((btn) => {
    btn.onclick = () => { branchVerdictFilter = btn.dataset.verdictFilter; renderBranchListInto(main, currentBranches); };
  });
}

// Background poll: only the counts on the bar change -- swap the bar, leave the cards alone.
function refreshBranchVerdictFilterBar(main, branches) {
  const bar = main.querySelector('[data-verdict-filter-bar]');
  if (!bar) return;
  bar.outerHTML = branchVerdictFilterBarHtml(branches, branchVerdictFilter);
  wireBranchVerdictFilterBar(main);
}

if (typeof module !== 'undefined') module.exports = { branchVerdictKey, branchVerdictBorderStyle, branchVerdictBadgeHtml, branchVerdictDetailHtml, filterBranchesByVerdict, branchVerdictFilterBarHtml, BRANCH_VERDICT_FILTERS };
