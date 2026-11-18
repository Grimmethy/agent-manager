'use strict';

/**
 * cited-code-liveness-check.js
 *
 * Pure guard: determines whether the code a candidate CITES is still alive in the
 * repo -- i.e. whether the premise of the candidate ("the bug is at <file>, and
 * <symbol> is there") still holds against the CURRENT working tree. A citation is
 * alive if:
 *   (1) the cited file exists at the cited repo-relative path, AND
 *   (2) if a specific symbol was cited, that symbol still appears in the file.
 *
 * This exists because pipeline_forensics_fix candidates (ac-6, ac-8, ac-131's
 * neighbors, found live 2026-09-15) escalated to needs-clarification/ with the
 * IDENTICAL generic grounding-fetch failure ("could not find a reliable anchor")
 * -- each one's own openQuestions named the likely cause: "the candidate's own
 * citation of the target code is stale or wrong (possibly already fixed by a
 * sibling task)". refreshCandidateFetchedFiles() re-derives the SAME deterministic
 * anchor search against the SAME unchanged file on every retry (see needs-
 * clarification-triage.js bucket I), so a blind requeue can only ever reproduce the
 * identical failure. A deterministic "does the cited code still exist as described"
 * PRE-CHECK, run before a forensics candidate is ever drafted, resolves most of these
 * without ever reaching the grounding-fetch -> rejection -> needs-clarification cycle.
 *
 * Structurally parallel to branch-liveness-check.js (CLI, JSON stdout, exit codes
 * 0/1/2, pure read + string search, no LLM, no side effects).
 *
 * CLI:
 *   node src/cited-code-liveness-check.js --repo <path> --file <cited-path> [--symbol <name>]
 *   stdout: one JSON object  { citedPath, alive, reason }
 *   exit:   0 alive · 1 dead (stale premise) · 2 operational error
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * Pure check: does the code at `citedPath` (repo-relative) still exist, and if a
 * `symbol` was cited, does it still appear in the file?
 *
 * @param {string}  repoRoot    Absolute or relative path to the repo working tree.
 * @param {string}  citedPath   Repo-relative path of the cited file (e.g. "src/foo.js").
 * @param {string}  [symbol]    Optional: a specific symbol the candidate cited. When
 *                              omitted or empty, only file existence is checked
 *                              (graceful degrade -- the grounding-fetch still runs).
 * @returns {{citedPath: string, alive: boolean, reason: string, error?: boolean}}
 */
function checkCitedCodeLiveness(repoRoot, citedPath, symbol) {
  const cp = String(citedPath || '').replace(/^\.\//, '').replace(/[`'".,;:)]+$/, '');
  const out = { citedPath: cp, alive: false, reason: '' };

  // Operational guard: repoRoot must exist and be a readable directory.
  if (!repoRoot || !cp) {
    out.alive = false;
    out.reason = 'operational error: repoRoot and citedPath are both required';
    out.error = true;
    return out;
  }

  // Path-escape guard: the cited path must resolve INSIDE repoRoot.
  const resolvedRoot = path.resolve(repoRoot);
  const full = path.resolve(resolvedRoot, cp);
  if (full !== resolvedRoot && !full.startsWith(resolvedRoot + path.sep)) {
    out.alive = false;
    out.reason = 'operational error: cited path escapes the repo root';
    out.error = true;
    return out;
  }

  // (1) Does the cited file still exist?
  let fileText;
  try {
    fileText = fs.readFileSync(full, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      out.alive = false;
      out.reason = 'cited file no longer exists';
      return out;
    }
    out.alive = false;
    out.reason = 'operational error: ' + (err && err.message ? err.message : 'unreadable');
    out.error = true;
    return out;
  }

  // (2) If a specific symbol was cited, does it still appear in the file?
  const sym = String(symbol || '').trim();
  if (sym) {
    const escaped = sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('\\b' + escaped + '\\b');
    if (!re.test(fileText)) {
      out.alive = false;
      out.reason = 'cited symbol not found in file (possibly refactored or removed)';
      return out;
    }
    out.alive = true;
    out.reason = 'file present and cited symbol found';
    return out;
  }

  // (3) No specific symbol cited -- degrade gracefully: file present is enough.
  out.alive = true;
  out.reason = 'file present; no specific anchor to verify';
  return out;
}

/**
 * CLI entry point:
 *   node src/cited-code-liveness-check.js --repo <path> --file <cited-path> [--symbol <name>]
 * Prints one JSON object on stdout; exit 0 (alive) / 1 (dead) / 2 (operational error).
 */
function main() {
  const argv = process.argv.slice(2);
  let repo = null;
  let file = null;
  let symbol = null;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo' && i + 1 < argv.length) { repo = argv[++i]; }
    else if (argv[i] === '--file' && i + 1 < argv.length) { file = argv[++i]; }
    else if (argv[i] === '--symbol' && i + 1 < argv.length) { symbol = argv[++i]; }
  }

  if (!repo || !file) {
    process.stdout.write(JSON.stringify({ citedPath: file, alive: false, reason: 'missing --repo or --file', error: true }) + '\n');
    process.exit(2);
  }

  const result = checkCitedCodeLiveness(repo, file, symbol);
  process.stdout.write(JSON.stringify(result) + '\n');

  if (result.error === true) process.exit(2);
  process.exit(result.alive ? 0 : 1);
}

module.exports = { checkCitedCodeLiveness };

if (require.main === module) {
  main();
}
