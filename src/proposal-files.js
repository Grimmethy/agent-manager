'use strict';

// `files` on a decompose proposal: the repo paths the piece creates or edits. queueSubTasks turns it into the piece's `Files:` line, which
// adhoc-diff-sanity.js (extractDeclaredFiles) treats as the authoritative scope: a docs-only piece is then not flagged "docs-only", and a path the
// piece declares is never "forbidden". 2026-10-23: HUB0008-11 (docs piece) and HUB0011-02 (adds tests to a file its text also said not to touch)
// were blocked by those gates because pieces never carried the line.

const MAX_FILES = 12;
const MAX_PATH_CHARS = 200;

// -> deduplicated array of 1..12 trimmed path strings, or undefined when nothing usable. Entries that are not strings, are blank, are too long, or
// contain whitespace or a comma (they would break the comma-separated Files: line) are dropped.
function validProposalFiles(value) {
  if (!Array.isArray(value)) return undefined;
  const out = [];
  for (const v of value) {
    if (typeof v !== 'string') continue;
    const p = v.trim();
    if (!p || p.length > MAX_PATH_CHARS || /[\s,]/.test(p) || out.includes(p)) continue;
    out.push(p);
    if (out.length === MAX_FILES) break;
  }
  return out.length ? out : undefined;
}

module.exports = { MAX_FILES, MAX_PATH_CHARS, validProposalFiles };
