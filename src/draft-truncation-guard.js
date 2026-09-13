'use strict';

// Truncation guard for LLM draft output (ported from python/dashboard/
// draft_truncation_guard.py -- that port was never wired into anything: the PLAN table /
// IMPLEMENT section convention it checks for is exclusively a src/local-draft.js concept,
// nothing in python/dashboard/ ever produces or consumes it. This is the real port,
// wired into local-client.js's detectDegenerate() as an ADDITIONAL truncation signal
// alongside the existing doneReason==='length' check -- the brain-dump this was filed
// against named a real case that check misses: a draft whose PLAN table or IMPLEMENT
// section is cut off mid-content even though Ollama's own doneReason wasn't 'length'.
//
// Pure function: no I/O, no network, no side effects.

// Deliberately conservative (a false negative just costs one extra requeue pass; a false
// positive would wrongly discard a good draft):
//   - empty/whitespace-only input -> false (silent; handled elsewhere as "degenerate: empty")
//   - last non-empty line starts with "|" -> true: an unclosed markdown table row
//   - an IMPLEMENT heading is present but no non-empty, non-heading line follows it ->
//     true: the IMPLEMENT section is missing its body entirely
//   - after the IMPLEMENT heading, the count of code-fence lines (```) is odd -> true: a
//     code block was opened but never closed
//   - otherwise -> false
function isDraftTruncated(draftText) {
  if (!draftText || !draftText.trim()) return false;

  const lines = draftText.split('\n');
  const nonEmpty = lines.filter((ln) => ln.trim());
  if (!nonEmpty.length) return false;

  // --- PLAN table truncation ---
  if (nonEmpty[nonEmpty.length - 1].trimStart().startsWith('|')) return true;

  // --- IMPLEMENT section truncation ---
  const implIdx = lines.findIndex((ln) => /^#{1,3}\s+IMPLEMENT/i.test(ln));
  if (implIdx !== -1) {
    const after = lines.slice(implIdx + 1);
    const hasContent = after.some((ln) => {
      const t = ln.trim();
      return t && !/^#{1,6}\s/.test(t);
    });
    if (!hasContent) return true;

    const fenceCount = after.filter((ln) => ln.trim().startsWith('```')).length;
    if (fenceCount % 2 !== 0) return true;
  }

  return false;
}

module.exports = { isDraftTruncated };
