// Pure text helpers for branch cards. No DOM, no imports, no I/O.

const MAX_CHARS = 160;
const ELLIPSIS = '\u2026';
const MINUS = '\u2212';

// Returns the first sentence of a verdict reason.
// A sentence ends at '.', '!' or '?' followed by whitespace or end of text.
// A first sentence that already ends with a sentence mark is returned whole,
// even if it is longer than MAX_CHARS. Without a sentence mark, the trimmed
// text is returned as-is when it fits in MAX_CHARS; otherwise it is cut at the
// last word boundary so that the result plus the ellipsis fits in MAX_CHARS.
export function firstSentence(reason) {
  if (reason === null || reason === undefined) return '';
  const text = String(reason).replace(/\s+/g, ' ').trim();
  if (!text) return '';

  const match = text.match(/^(.+?[.!?])(\s|$)/);
  if (match) return match[1];

  if (text.length <= MAX_CHARS) return text;

  // Reserve one character for the ellipsis.
  let head = text.slice(0, MAX_CHARS - 1);
  const lastSpace = head.lastIndexOf(' ');
  if (lastSpace > 0) head = head.slice(0, lastSpace);
  return head.trimEnd() + ELLIPSIS;
}

// Builds '<subject> (<n> files, +<ins> −<del>)'.
// Returns the subject alone when any diffstat value is missing, and '' when
// the subject is empty. Accepts only these fields; never reads a draft summary.
export function buildWhatItChanges({ commitSubject, filesChanged, insertions, deletions } = {}) {
  const subject = typeof commitSubject === 'string' ? commitSubject.trim() : '';
  if (!subject) return '';
  if (filesChanged == null || insertions == null || deletions == null) return subject;
  return `${subject} (${filesChanged} files, +${insertions} ${MINUS}${deletions})`;
}
