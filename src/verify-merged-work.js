'use strict';

// Content-based "did this actually land" checker (2026-09-16, Grimmethy: "we need to look
// at the system side fix" -- prompted by a real investigation mistake this session: a
// task's own history claimed `terminalDisposition: 'merged'`, and its commit's exact SHA
// was NOT a `git merge-base --is-ancestor` of current master, which was (wrongly) read as
// "this work is lost" -- the SAME class of check that correctly caught a REAL lost-work
// incident earlier the same night (adhoc-wire-the-guard-into-src-local-draft-js-before-
// runcritiqueandrevision-1788967408974-1, confirmed genuinely absent by hand). The
// difference: the file the second task touched had since been extracted into a new module
// by an unrelated refactor, which rewrites git history around the original commit without
// dropping its actual CONTENT -- ancestor-checking a single SHA cannot tell these two
// cases apart, only reading the CURRENT repo's real content can.
//
// This module answers the more reliable question directly: does the code this task's own
// diff added still exist SOMEWHERE (not necessarily at the same path) in the current repo?
// Same "don't ask a model (or a single git check) to verify what code can verify with
// certainty" principle review-task.js's other deterministic gates already use -- see
// fact-checker.js's own header.
//
// Deliberately narrow: this is a REPORTING tool (present / partial / missing / unknown),
// never an auto-action -- a low ratio is evidence worth a human or agent looking closer
// (exactly what this session did by hand for the real 2026-09-10 incident), not grounds
// for automatically reverting, re-queueing, or re-implementing anything.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseChangedFiles } = require('./adhoc-diff-sanity.js');
const { findByBasename } = require('./fact-checker.js');

const REPO_GREP_TIMEOUT_MS = 5000;
// Only a genuinely distinctive line is worth a repo-wide git-grep fallback -- a short or
// generic missing line (a plain "const x = 1;") would just find unrelated matches
// elsewhere and manufacture false confidence that the diff's real content survived.
const MIN_GREP_LINE_LENGTH = 25;
const MAX_GREP_CALLS_PER_FILE = 15;

// Literal, fixed-string repo-wide search (mirrors fact-checker.js's own private
// existsLiterallyInRepo -- not exported there, so reimplemented here rather than widening
// that file's public surface for this one caller). Best-effort: any git failure (no repo,
// binary content, grep timeout) is treated as "not found", never thrown.
function existsLiterallyInRepo(value, repoRoot) {
  try {
    execFileSync('git', ['grep', '-q', '-F', '-e', value], {
      cwd: repoRoot, timeout: REPO_GREP_TIMEOUT_MS, stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

// A line worth checking for: real content, not diff furniture or a line too short/generic
// to mean anything on its own (a bare '}' or ');' appears constantly in real code and
// proves nothing about THIS diff having landed). Comments count -- a distinctive comment
// is still real evidence.
const TRIVIAL_LINE_RE = /^[{}()[\];,.]+$/;
function isMeaningfulLine(line) {
  const t = line.trim();
  if (t.length < 8) return false;
  if (TRIVIAL_LINE_RE.test(t)) return false;
  return true;
}

// Every `+` line (never `+++`) belonging to ONE file's own section of a unified diff --
// sections are delimited by `diff --git a/<old> b/<new>` lines, the same boundary
// parseChangedFiles already keys off. targetPath matches whichever side (a/ or b/) the
// caller names (an edit/create checks the b/ side; a delete would check a/, though this
// module does not attempt to verify deletions -- see verifyMergedWorkPresent's own note).
function extractAddedLinesForFile(diff, targetPath) {
  const lines = String(diff || '').split('\n');
  const out = [];
  let inSection = false;
  for (const line of lines) {
    if (/^diff --git /.test(line)) {
      inSection = line === `diff --git a/${targetPath} b/${targetPath}`
        || line.endsWith(` b/${targetPath}`)
        || line.includes(` a/${targetPath} b/`);
      continue;
    }
    if (!inSection) continue;
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) out.push(line.slice(1));
  }
  return out;
}


// task -> the diff text to verify. Accepts either a raw diff string directly, or a task
// object -- checks task.rawDiff first (the structured field apply-task.js's own commit
// step reads), then falls back to extracting the '=== DIFF ===' section of
// implementResponse (the shape this session's own manually-filed queue/review tasks use).
function resolveDiffText(taskOrDiff) {
  if (typeof taskOrDiff === 'string') return taskOrDiff;
  const task = taskOrDiff || {};
  if (typeof task.rawDiff === 'string' && task.rawDiff.trim()) return task.rawDiff;
  const ir = typeof task.implementResponse === 'string' ? task.implementResponse : '';
  const marker = '=== DIFF ===';
  const idx = ir.indexOf(marker);
  return idx === -1 ? '' : ir.slice(idx + marker.length);
}

// verifyMergedWorkPresent(taskOrDiff, repoRoot) -> {
//   verdict: 'present' | 'partial' | 'missing' | 'unknown',
//   ratio: number | null,        -- foundLines / meaningfulLines, null when nothing to check
//   totalMeaningfulLines, totalFoundLines,
//   files: [{ path, kind, existsAtOriginalPath, relocatedTo, meaningfulLineCount, foundCount, missingLines }],
// }
//
// Only 'create'/'edit' files are verified -- a 'delete' entry's whole point is that the
// file is GONE, so checking for its added lines' presence would be backwards; it is
// listed with checked:false rather than silently dropped, so a caller can see it was
// deliberately skipped, not missed.
//
// verdict thresholds (only meaningful when totalMeaningfulLines > 0):
//   ratio >= 0.8  -> 'present'  (the diff's real content is still there)
//   ratio >= 0.3  -> 'partial'  (some but not most -- worth a closer look, not an alarm)
//   ratio <  0.3  -> 'missing'  (the diff's real content is not findable -- the strongest
//                                signal this module can give that work was actually lost)
//   totalMeaningfulLines === 0 -> 'unknown' (a diff with nothing substantial to check --
//                                whitespace/formatting-only, or unparseable)
function verifyMergedWorkPresent(taskOrDiff, repoRoot) {
  const diff = resolveDiffText(taskOrDiff);
  const changedFiles = parseChangedFiles(diff);
  const files = [];
  let totalMeaningfulLines = 0;
  let totalFoundLines = 0;

  for (const cf of changedFiles) {
    if (cf.kind === 'delete') {
      files.push({ path: cf.path, kind: cf.kind, checked: false });
      continue;
    }
    const addedLines = extractAddedLinesForFile(diff, cf.path);
    const meaningful = addedLines.filter(isMeaningfulLine);

    const absPath = path.join(repoRoot, cf.path);
    let content = null;
    try { content = fs.readFileSync(absPath, 'utf8'); } catch { /* not at this path (anymore) */ }
    const existsAtOriginalPath = content !== null;

    let relocatedTo = null;
    if (!existsAtOriginalPath) {
      const basename = path.basename(cf.path);
      const candidates = findByBasename(repoRoot, basename, 5);
      if (candidates.length === 1) {
        relocatedTo = path.relative(repoRoot, candidates[0]);
        try { content = fs.readFileSync(candidates[0], 'utf8'); } catch { content = null; }
      }
    }

    let missingLines = [];
    let found = 0;
    if (content !== null) {
      for (const line of meaningful) {
        if (content.includes(line)) found += 1;
        else missingLines.push(line);
      }
    } else {
      missingLines = meaningful.slice();
    }

    // A file whose specific code section moved into a DIFFERENT file the refactor also
    // created/renamed (the real 2026-09-16 false-positive: local-draft.js still exists,
    // unrelated content -- the pre-filter block moved into a NEW file, lib/draft-
    // context.js, that findByBasename('local-draft.js', ...) would never find since it's
    // not named that). For each still-missing, sufficiently distinctive line, fall back to
    // a repo-wide literal search -- if found ANYWHERE, it survived a refactor rather than
    // being lost, even though this function can't say exactly where it landed. Capped
    // (MAX_GREP_CALLS_PER_FILE) so a diff with many long missing lines can't make this
    // slow; the remaining unchecked lines stay conservatively counted as missing.
    if (missingLines.length) {
      const stillMissing = [];
      let elsewhereFound = 0;
      let grepCalls = 0;
      for (const line of missingLines) {
        const trimmed = line.trim();
        if (grepCalls < MAX_GREP_CALLS_PER_FILE && trimmed.length >= MIN_GREP_LINE_LENGTH) {
          grepCalls += 1;
          if (existsLiterallyInRepo(trimmed, repoRoot)) { elsewhereFound += 1; continue; }
        }
        stillMissing.push(line);
      }
      found += elsewhereFound;
      missingLines = stillMissing;
    }

    totalMeaningfulLines += meaningful.length;
    totalFoundLines += found;
    files.push({
      path: cf.path,
      kind: cf.kind,
      checked: true,
      existsAtOriginalPath,
      relocatedTo,
      meaningfulLineCount: meaningful.length,
      foundCount: found,
      missingLines: missingLines.slice(0, 5),
    });
  }

  const ratio = totalMeaningfulLines > 0 ? totalFoundLines / totalMeaningfulLines : null;
  let verdict;
  if (ratio === null) verdict = 'unknown';
  else if (ratio >= 0.8) verdict = 'present';
  else if (ratio >= 0.3) verdict = 'partial';
  else verdict = 'missing';

  return { verdict, ratio, totalMeaningfulLines, totalFoundLines, files };
}

function main() {
  const taskPath = process.argv[2];
  const repoRoot = process.argv[3] || process.cwd();
  if (!taskPath) {
    process.stdout.write(JSON.stringify({ error: 'usage: node verify-merged-work.js <task.json> [repoRoot]' }));
    process.exitCode = 1;
    return;
  }
  const task = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
  const result = verifyMergedWorkPresent(task, repoRoot);
  process.stdout.write(JSON.stringify(result, null, 2));
}

module.exports = { verifyMergedWorkPresent, extractAddedLinesForFile, isMeaningfulLine, resolveDiffText };

if (require.main === module) {
  main();
}
