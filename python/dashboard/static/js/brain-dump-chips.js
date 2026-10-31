// Chips for the Brain Dump cards (HUB0274-07, 2026-10-30): "possibly resolved" (entry.possiblyResolved, written by the brain_dump_resolution_check
// source) and "target check" (entry.targetCheck, written by the pre-queue target check). They only ADD information to the card; nothing is hidden,
// closed or suppressed because of them. A plain <script> in the dashboard and a CommonJS module under node (test/brain-dump-chips.test.js), like
// branch-projects.js.

function bdChipEscape(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function bdChipClip(text, max) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

// -> '' when the entry carries neither field, else the chip HTML. `escapeHtml` is the dashboard's text escaper; titles use the local attribute escaper.
function brainDumpChipsHtml(entry, escapeHtml) {
  if (!entry || typeof entry !== 'object') return '';
  const text = typeof escapeHtml === 'function' ? escapeHtml : bdChipEscape;
  const chips = [];
  const resolved = entry.possiblyResolved;
  if (resolved && typeof resolved === 'object') {
    const evidence = bdChipClip(resolved.evidence, 300);
    chips.push(
      `<span class="badge warn" style="margin-left:6px" title="${bdChipEscape('Possibly already fixed on master (not closed, check it): ' + evidence)}">possibly resolved</span>`
      + (evidence ? `<span class="muted" style="font-size:11px;margin-left:4px">${text(evidence)}</span>` : ''),
    );
  }
  const target = entry.targetCheck;
  if (target && typeof target === 'object') {
    const raw = Array.isArray(target.reasons) ? target.reasons.join('; ') : target.reasons;
    const reasons = bdChipClip(raw, 300);
    chips.push(
      `<span class="badge warn" style="margin-left:6px" title="${bdChipEscape('Held back from queueing by the target check: ' + reasons)}">target check</span>`
      + (reasons ? `<span class="muted" style="font-size:11px;margin-left:4px">${text(reasons)}</span>` : ''),
    );
  }
  return chips.join('');
}

// Returns {refused: true, message} for HTTP 409 (message = server response text trimmed to 400 chars),
// or {refused: false} for any other status. Used by the /api/brain-dump/<id>/prioritize click handlers
// (brain-dump-and-second-brain.js) to surface a "refused" response from the server.
function prioritizeRefusal(status, text) {
  if (status === 409) {
    const message = String(text == null ? '' : text);
    return { refused: true, message: message.slice(0, 400) };
  }
  return { refused: false };
}

if (typeof module !== 'undefined') module.exports = { bdChipEscape, bdChipClip, brainDumpChipsHtml, prioritizeRefusal };
