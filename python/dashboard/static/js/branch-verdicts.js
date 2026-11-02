'use strict';

// Verdict rendering for the Unmerged Branches tab (backend: python/dashboard/branch_verdicts.py).
// Kept out of branches-joblist-hardware-tabs.js on purpose (hot file) -- that file only calls the helpers
// below. Pure string/array functions, no DOM, so they are testable from Node.
//
// The verdict is shown by the badge (green = merge, yellow = needs-work, blue = hold (sound, waiting on its hub or a sibling), red = discard, grey = unverified or stale),
// not by the card border: every card keeps the standard 2px --border blue the other tabs use (owner, 2026-11-02).

const BRANCH_VERDICT_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'unverified', label: 'Unverified' },
  { key: 'merge', label: 'Ready to merge' },
  { key: 'needs-work', label: 'Needs work' },
  { key: 'hold', label: 'Hold' },
  { key: 'discard', label: 'Discard' },
];

let branchVerdictFilter = 'all';

// The bucket a branch falls in. A stale verdict is "unverified" -- it vouches for an older commit.
function branchVerdictKey(b) {
  if (!b || b.stale || !b.verdict) return 'unverified';
  return ['merge', 'needs-work', 'hold', 'discard'].includes(b.verdict) ? b.verdict : 'unverified';
}

// Inline style for the card border: none. The card falls back to the shared .worker-card border (2px solid var(--border)). Kept as a function so the
// one caller in branches-joblist-hardware-tabs.js does not change.
function branchVerdictBorderStyle() {
  return '';
}

function _bvEscape(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

const _BV_BADGE_CLASS = { merge: 'ok', 'needs-work': 'warn', hold: 'hold', discard: 'bad' };
const _BV_WORD = { merge: 'merge', 'needs-work': 'needs work', hold: 'hold', discard: 'discard' };

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
  if (reasons.length) html += '<ul style="margin:4px 0 0 16px">' + reasons.map((r) => `<li>${_bvEscape(r)}</li>`).join('') + '</ul>';
  return key === 'unverified' && !reasons.length && !(b && b.stale) ? '' : html;
}

function filterBranchesByVerdict(branches, filterKey) {
  if (!filterKey || filterKey === 'all') return branches;
  return branches.filter((b) => branchVerdictKey(b) === filterKey);
}

function branchVerdictFilterBarHtml(branches, activeKey) {
  const counts = {};
  for (const b of branches) counts[branchVerdictKey(b)] = (counts[branchVerdictKey(b)] || 0) + 1;
  // .row is only a flex container inside a card (templates/index.html), so the bar sets its own flex: that is what lets the Discard-all button's margin-left:auto push it right.
  return '<div class="row" data-verdict-filter-bar style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:12px">' + BRANCH_VERDICT_FILTERS.map((f) => {
    const n = f.key === 'all' ? branches.length : (counts[f.key] || 0);
    const cls = f.key === activeKey ? 'action' : 'secondary';
    return `<button class="${cls}" data-verdict-filter="${f.key}">${_bvEscape(f.label)} (${n})</button>`;
  }).join('') + discardAllButtonHtml(branches, activeKey) + '</div>';
}

// ---- Discard all (owner request 2026-10-31) -- pure helpers; the browser wiring is wireDiscardAll below. Server: POST /api/git/branches/discard-batch.
// The rolling candidate-doc branch is regenerated and handled separately: left out unless the owner opts in.
const DISCARD_TRIAGE_BRANCH = 'agent/triage-queue';
const DISCARD_ALL_LIST_LIMIT = 15;
let discardAllRunning = false;
// A card's content ends 18px inside the card (2px border + 16px padding, .worker-card in templates/index.html): the Discard-all button keeps the same inset so its
// right edge lines up with the Discard buttons on the cards below it.
const DISCARD_ALL_INSET_PX = 18;

// Cards whose CURRENT verdict is discard. A stale verdict reads as unverified (branchVerdictKey), so it can never be in here.
function discardAllCandidates(branches, includeTriage) {
  return (Array.isArray(branches) ? branches : []).filter((b) => branchVerdictKey(b) === 'discard' && (includeTriage || b.branch !== DISCARD_TRIAGE_BRANCH));
}

function discardAllButtonHtml(branches, activeKey) {
  if (activeKey !== 'discard') return '';
  const n = discardAllCandidates(branches, false).length;
  if (!n) return '';
  return `<button class="secondary" data-discard-all style="margin-left:auto;margin-right:${DISCARD_ALL_INSET_PX}px"${discardAllRunning ? ' disabled' : ''} title="Permanently delete every remote branch with a current discard verdict (one confirmation).">`
    + `${discardAllRunning ? 'Discarding...' : `Discard all (${n})`}</button>`;
}

function _discardProjectLabel(b) {
  return (b && b.project && !b.project.active && b.project.label) ? ` [${b.project.label}]` : '';
}

// A branch that is a piece of a hub that is not finished: discarding it alone may unblock or orphan its siblings.
function discardOpenHubBranches(candidates) {
  return candidates.filter((b) => b.hub && b.hub.state && !['done', 'retired'].includes(b.hub.state));
}

function discardAllDialogText(candidates) {
  const n = candidates.length;
  const shown = candidates.slice(0, DISCARD_ALL_LIST_LIMIT).map((b) => `  - ${b.branch}${_discardProjectLabel(b)}`);
  const more = n > shown.length ? [`  ... and ${n - shown.length} more`] : [];
  const hubs = discardOpenHubBranches(candidates);
  const hubLines = hubs.length
    ? ['', `WARNING: ${hubs.length} of these ${hubs.length === 1 ? 'is a piece' : 'are pieces'} of a hub that is still open (discarding a piece alone may unblock or orphan its siblings):`]
      .concat(hubs.slice(0, DISCARD_ALL_LIST_LIMIT).map((b) => `  - ${b.branch} (hub ${b.hub.id || '?'}, ${b.hub.state})`))
    : [];
  return [`Discard ${n} branch${n === 1 ? '' : 'es'}?`, '', ...shown, ...more, ...hubLines, '',
    'This PERMANENTLY DELETES the remote branches and archives their tasks as dismissed. The commits stay recoverable under refs/discarded/* in the repo.',
    '', `Type ${n} to confirm:`].join('\n');
}

function discardAllConfirmOk(typed, n) {
  return typeof typed === 'string' && typed.trim() === String(n);
}

function discardAllPayload(candidates, includeTriage) {
  return { branches: candidates.map((b) => ({ branch: b.branch, project: branchProjectRequestRoot(b), sha: b.headSha })), includeTriage: !!includeTriage };
}

// "Discarded X of N" plus one line per failure.
function discardAllResultText(result) {
  const results = Array.isArray(result && result.results) ? result.results : [];
  const ok = results.filter((r) => r.succeeded).length;
  const failed = results.filter((r) => !r.succeeded);
  return [`Discarded ${ok} of ${results.length}`].concat(failed.map((r) => `  - ${r.branch}: ${r.reason || 'failed'}`)).join('\n');
}

async function runDiscardAll(main) {
  const triage = discardAllCandidates(currentBranches, true).filter((b) => b.branch === DISCARD_TRIAGE_BRANCH);
  let includeTriage = false;
  if (triage.length && confirm(`Also include ${DISCARD_TRIAGE_BRANCH}${_discardProjectLabel(triage[0])}? It is the rolling candidate-doc branch and normally left out. OK = include it, Cancel = leave it out.`)) includeTriage = true;
  const candidates = discardAllCandidates(currentBranches, includeTriage);
  if (!candidates.length) return;
  const typed = prompt(discardAllDialogText(candidates));
  if (!discardAllConfirmOk(typed, candidates.length)) return;
  discardAllRunning = true;
  refreshBranchVerdictFilterBar(main, currentBranches);
  let text;
  try {
    const resp = await fetch('/api/git/branches/discard-batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(discardAllPayload(candidates, includeTriage)) });
    const result = await resp.json();
    text = resp.ok ? discardAllResultText(result) : `Nothing was discarded: ${result.reason || 'HTTP ' + resp.status}`;
  } catch (e) {
    text = 'Discard all failed: ' + e.message;
  }
  discardAllRunning = false;
  await renderBranchesTab();
  alert(text);
}

// Browser-only: (re)build the filter bar + filtered card list into `main`. Uses the globals
// branchCardHtml / wireBranchCard from branches-joblist-hardware-tabs.js at CALL time.
// Hubs whose built pieces are pushed but held out of the list until every piece is built (server: partition_held_hub_branches).
function heldHubsHtml(groups) {
  const list = Array.isArray(groups) ? groups : [];
  if (!list.length) return '<div data-held-hubs></div>';
  const rows = list.map((g) => {
    const p = g.progress || {};
    const waiting = (g.waitingOn || []).map(_bvEscape).join(', ');
    return `<div class="meta" style="margin:4px 0">${_bvEscape(String(g.title || g.hubId).slice(0, 70))}: ${p.built || 0} of ${p.total || 0} built, `
      + `${(g.branches || []).length} held${waiting ? ', waiting on ' + waiting : ''}</div>`;
  }).join('');
  return '<div data-held-hubs style="margin-top:16px;padding:8px 12px;border:1px dashed #888;border-radius:6px">'
    + `<div class="meta"><b>Waiting on siblings (${list.length})</b> -- pushed, but not listed until every piece of the hub is built</div>${rows}</div>`;
}

function renderBranchListInto(main, branches) {
  const shown = filterBranchesByVerdict(branches, branchVerdictFilter);
  main.innerHTML = branchVerdictFilterBarHtml(branches, branchVerdictFilter)
    + (typeof branchProjectsPendingHtml === 'function' ? branchProjectsPendingHtml(branchProjectsPending) : '')
    + (typeof branchListRefreshingHtml === 'function' ? branchListRefreshingHtml(branchListRefreshing) : '')
    + (shown.length ? (typeof branchListWithProjectHeadersHtml === 'function' ? branchListWithProjectHeadersHtml(shown, branchCardHtml) : shown.map(branchCardHtml).join('')) : `<div class="empty">${branches.length ? 'No branches match this filter.' : 'Nothing is ready to verify yet.'}</div>`)
    + heldHubsHtml(typeof currentHeldHubs === 'undefined' ? [] : currentHeldHubs);
  main.querySelectorAll('[data-branch-row]').forEach(wireBranchCard);
  wireBranchVerdictFilterBar(main);
}

function wireBranchVerdictFilterBar(main) {
  const all = main.querySelector('[data-discard-all]');
  if (all) all.onclick = () => runDiscardAll(main);
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

if (typeof module !== 'undefined') module.exports = { branchVerdictKey, branchVerdictBorderStyle, branchVerdictBadgeHtml, branchVerdictDetailHtml, filterBranchesByVerdict, branchVerdictFilterBarHtml, BRANCH_VERDICT_FILTERS, heldHubsHtml, discardAllCandidates, discardAllButtonHtml, DISCARD_ALL_INSET_PX, discardAllDialogText, discardAllConfirmOk, discardAllPayload, discardAllResultText, discardOpenHubBranches };
