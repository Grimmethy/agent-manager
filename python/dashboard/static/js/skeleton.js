'use strict';

// Skeleton shimmer for loading states (the "Skeleton Shimmer" option of the reel 'Thinking... Part 1': a skeleton list whose soft light band
// sweeps left to right every 1.4 s). Tabs fetch before they draw, so on a slow tab the PREVIOUS tab's content used to sit on screen as if the click
// had done nothing; switchToTab (core-ui.js) now shows this placeholder straight away and the tab's own render replaces it. The plugin-tab
// "Loading..." / "Starting ..." messages reuse it with a caption. Pure string helpers first (testable from Node), then one tiny DOM function.

const SKELETON_SWEEP_MS = 1400;          // mirrored by the CSS animation duration in templates/index.html
const SKELETON_MAX_ROWS = 8;
const SKELETON_LINE_WIDTHS = [90, 70, 45];   // percent; each row's three text lines

function _skEscape(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function skeletonRowHtml(index) {
  // Rotate the widths per row so the list does not look stamped out.
  const lines = SKELETON_LINE_WIDTHS.map((w, i) => `<span class="skeleton-line" style="width:${SKELETON_LINE_WIDTHS[(i + index) % SKELETON_LINE_WIDTHS.length]}%"></span>`).join('');
  return `<div class="skeleton-row"><span class="skeleton-block"></span><span class="skeleton-lines">${lines}</span></div>`;
}

// rows is clamped to 1..SKELETON_MAX_ROWS (default 4). caption, when given, is shown above the rows and read out by screen readers.
function skeletonHtml({ rows = 4, caption = '' } = {}) {
  const n = Math.max(1, Math.min(SKELETON_MAX_ROWS, Math.round(Number(rows)) || 4));
  const label = caption ? _skEscape(caption) : 'Loading...';
  let body = '';
  for (let i = 0; i < n; i++) body += skeletonRowHtml(i);
  return `<div class="skeleton" role="status" aria-busy="true" data-skeleton><span class="skeleton-sr">${label}</span>`
    + (caption ? `<div class="skeleton-caption">${label}</div>` : '')
    + `<div class="skeleton-title"></div>${body}</div>`;
}

// Replaces #main with the skeleton. Called from switchToTab, never from the 5 second refresh, so a poll cannot make the page flash.
function showTabSkeleton() {
  const main = typeof document !== 'undefined' ? document.getElementById('main') : null;
  if (!main) return false;
  main.innerHTML = skeletonHtml();
  return true;
}

if (typeof module !== 'undefined') module.exports = { SKELETON_SWEEP_MS, SKELETON_MAX_ROWS, SKELETON_LINE_WIDTHS, skeletonRowHtml, skeletonHtml, showTabSkeleton };
