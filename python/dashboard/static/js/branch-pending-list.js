'use strict';

// Pending-list renderer for the Unmerged Branches tab (backend: python/dashboard/branch_projects.py, `scan_status()`).
// Pure string functions, no DOM, so they are testable from Node. Renders the `scan` field of the route response
// ({pending:[{label,state,startedAt}], errors:[{label,error}]}) as a list of buttons (one per pending project,
// each carrying `data-scan-project` so the click handler can kick that scan) and a failure line per errored project.
//
// The tab polls or reacts to events for refreshes; this module never arms a timer itself.

function _bpEscape(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// Format elapsed seconds as "Xm Ys" (or "now" for < 10 s). No DOM, no timer.
function _formatElapsed(seconds) {
  if (seconds == null || seconds < 0) return '';
  if (seconds < 10) return 'now';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return rm ? `${h}h ${rm}m` : `${h}h`;
  }
  return m ? `${m}m ${s}s` : `${s}s`;
}

// One row for a queued (not yet started) project: no startedAt yet, so just the label and a "waiting" hint.
function _pendingPendingHtml(item) {
  return `<button class="branch-pending-item" data-scan-project="${_bpEscape(item.label)}" title="Click to scan ${_bpEscape(item.label)} now">${_bpEscape(item.label)} <span class="branch-pending-elapsed" aria-label="elapsed">waiting</span></button>`;
}

// One row for a project whose scan started at `startedAt`: elapsed time since then.
function _pendingRunningHtml(item, nowMs) {
  const startedAt = item.startedAt;
  const elapsed = startedAt ? Math.max(0, (nowMs - startedAt * 1000) / 1000) : 0;
  const elapsedStr = _formatElapsed(elapsed);
  return `<button class="branch-pending-item" data-scan-project="${_bpEscape(item.label)}" title="Click to scan ${_bpEscape(item.label)} now">${_bpEscape(item.label)} <span class="branch-pending-elapsed">${_bpEscape(elapsedStr)}</span></button>`;
}

// One row for an errored / timed-out project.
function _errorHtml(item) {
  return `<div class="branch-pending-error" data-scan-project="${_bpEscape(item.label)}" title="Failed: ${_bpEscape(item.error)}">${_bpEscape(item.label)}: ${_bpEscape(item.error)}</div>`;
}

// Render the full pending/scan status panel.
// `scan` is {pending:[{label,state,startedAt}], errors:[{label,error}]}.
// `nowMs` is a millisecond epoch (Date.now() style) used to compute elapsed time from each `startedAt`.
// Returns an empty string when there is nothing to show.
function branchPendingListHtml(scan, nowMs) {
  if (!scan || !Array.isArray(scan.pending) && !Array.isArray(scan.errors)) return '';
  const pending = Array.isArray(scan.pending) ? scan.pending.filter(Boolean) : [];
  const errors = Array.isArray(scan.errors) ? scan.errors.filter(Boolean) : [];
  if (!pending.length && !errors.length) return '';

  const lines = [];
  lines.push('<div class="branch-pending-list" data-pending-list>');
  if (pending.length) {
    lines.push(`<h3 class="branch-pending-title">Scanning (${pending.length} project${pending.length === 1 ? '' : 's'})</h3>`);
    lines.push('<div class="branch-pending-items">');
    for (const item of pending) {
      lines.push(item.startedAt ? _pendingRunningHtml(item, nowMs) : _pendingPendingHtml(item));
    }
    lines.push('</div>');
  }
  if (errors.length) {
    lines.push('<h3 class="branch-pending-title">Errors</h3>');
    lines.push('<div class="branch-pending-errors">');
    for (const item of errors) {
      lines.push(_errorHtml(item));
    }
    lines.push('</div>');
  }
  lines.push('</div>');
  return lines.join('');
}

if (typeof module !== 'undefined') module.exports = { branchPendingListHtml, _bpEscape, _formatElapsed };
