'use strict';

// Skip / dismiss / early-exit path detector for the review step (brain dump #1667, 2026-10-01).
//
// Why: of 10 needs-work branches examined on 2026-09-30, three added a path that archives, dismisses or early-exits work and wrongly dropped real cases: a
// sync-io-in-loop gate whose startup exemption ran before its hot-path check (a request handler that also called loadConfig() was archived); a confidence gate
// that archived a genuine sequential await because its snippet lacked the loop header; a project_search zero-result early exit whose streak key was the project
// tag, so three empty runs for one project early-exited every project (and blocked instead of finishing). Tests passed in all three. The cost of such a path is the
// real work it silently drops, so the reviewer is told, deterministically, when the diff adds one and what the draft must then show.
//
// What: scan the lines a diff ADDS to non-test .js/.mjs/.cjs/.py files for the shapes those paths take, conservatively (precision over recall: a false alarm
// costs the voters a paragraph, but a noisy detector gets ignored):
//   status-label  -- a status/verdict/outcome/disposition/result set to a string such as 'archived', 'dismissed', 'skipped', 'ignored', 'noop'
//   skip-flag     -- skipped / archived / dismissed / suppressed / shortCircuited set to true
//   early-exit    -- an identifier named like earlyExit / shortCircuit / shouldSkip / shouldDismiss / skipIf
//   gate-function -- a new top-level function or class named like a gate, detector, guard or dedup
// Comment lines and test files never count, and neither does a line the same diff also REMOVES somewhere (a function extraction or move relocates an existing
// gate; it adds no new way to drop work). Pure; never throws.

const { parseDiffFiles, isTestPath } = require('./review-inert.js');

const MAX_PATHS = 8;
const SOURCE_RE = /\.(?:[cm]?js|py)$/;
const COMMENT_RE = /^(?:\/\/|\/\*|\*|#)/;
const STATUS_LABEL_RE = /\b(?:status|verdict|outcome|disposition|result|state)\s*[:=]\s*['"](?:archive[d]?|dismiss(?:ed)?|skip(?:ped)?|ignored|noop|no-op|suppressed|short-circuit(?:ed)?)['"]/i;
const SKIP_FLAG_RE = /\b(?:skipped|archived|dismissed|suppressed|short_?[cC]ircuited|shortCircuited)\s*[:=]\s*true\b/;
const EARLY_EXIT_NAME_RE = /\b[A-Za-z_$]*(?:earlyExit|EarlyExit|early_exit|shortCircuit|ShortCircuit|short_circuit|shouldSkip|should_skip|shouldDismiss|should_dismiss|skipIf|skip_if)[A-Za-z_$0-9]*/;
const GATE_DEF_RE = /^(?:async\s+)?(?:function\*?\s+|def\s+|class\s+|(?:const|let|var)\s+)([A-Za-z_$][\w$]*)/;
const GATE_NAME_RE = /(?:gate|detector|guard|dedup)/i;

// Trimmed text of every line the diff removes, in any file.
function removedLines(diff) {
  const out = new Set();
  for (const line of String(diff || '').split('\n')) {
    if (line.startsWith('-') && !line.startsWith('---')) { const t = line.slice(1).trim(); if (t) out.add(t); }
  }
  return out;
}

function findSkipPaths({ rawDiff } = {}) {
  const result = { total: 0, paths: [] };
  try {
    const seen = new Set();
    const found = [];
    const removed = removedLines(rawDiff);
    for (const entry of parseDiffFiles(rawDiff)) {
      if (entry.isDeleted || entry.isRename || isTestPath(entry.file) || !SOURCE_RE.test(entry.file)) continue;
      for (const { line, text } of entry.added) {
        const t = String(text).trim();
        if (!t || COMMENT_RE.test(t) || removed.has(t)) continue;
        let kind = null;
        let evidence = t;
        if (STATUS_LABEL_RE.test(t)) kind = 'status-label';
        else if (SKIP_FLAG_RE.test(t)) kind = 'skip-flag';
        else if (EARLY_EXIT_NAME_RE.test(t)) { kind = 'early-exit'; evidence = (t.match(EARLY_EXIT_NAME_RE) || [t])[0]; }
        else {                                   // GATE_DEF_RE is anchored at column 0, so only top-level definitions match
          const m = String(text).match(GATE_DEF_RE);
          if (m && m[1].length >= 4 && GATE_NAME_RE.test(m[1])) { kind = 'gate-function'; evidence = m[1]; }
        }
        if (!kind) continue;
        const key = `${entry.file}|${kind}`;
        if (seen.has(key)) continue;           // one report per file and kind: the reviewer needs to know where to look, not every line
        seen.add(key);
        found.push({ file: entry.file, line, kind, text: evidence.slice(0, 120) });
      }
    }
    result.total = found.length;
    result.paths = found.slice(0, MAX_PATHS);
  } catch { /* advisory: a detector failure means "nothing found" */ }
  return result;
}

module.exports = { findSkipPaths, MAX_PATHS };
