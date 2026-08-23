'use strict';

// Deterministic, dependency-free function-length scanner -- first member of the
// "maintenance" task-source family (2026-08-23, Grimmethy: "Let's start with the modular
// approach with the intent to further separate it into a fully separate npm later" --
// following the NASA/JPL "Power of 10" discussion: "No function should be longer than
// what can be printed on a single sheet of paper... typically ~60 lines"). Same split as
// observability-scan.js/performance-scan.js: this module ONLY detects and flags
// candidates; a downstream review task judges genuine issue vs. false positive (a long
// but linear, single-purpose sequence -- a big switch, a prompt-builder -- is not
// automatically a problem) and proposes a decomposition, exactly the same division of
// labor that keeps performance_review calibrated well rather than noisy.
//
// Deliberately kept in its own src/maintenance/ directory with the narrowest possible
// dependency on the rest of this package (only observability-scan.js's generic,
// non-observability-specific utilities: extractBraceBody, listSourceFiles,
// isLikelyMinified, lineOfIndex) -- everything else here is self-contained, so a future
// extraction to a standalone npm package only has to resolve that one small utility
// dependency, not untangle this module from the rest of the pipeline.
//
// Regex-based function-boundary detection, not a real parser -- same accepted tradeoff
// as every other rule in observability-scan.js/performance-scan.js: false positives and
// false negatives are both expected and are the review stage's job to filter, not this
// script's. JS/TS only for this first version (brace-delimited); Python's indentation-
// delimited functions would need a different boundary detector and are an explicit
// future extension, not silently pretended to be covered here.

const fs = require('fs');
const path = require('path');
const { extractBraceBody, listSourceFiles, isLikelyMinified, lineOfIndex } = require('../observability-scan.js');

const SCAN_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx'];

// Starting calibration, not a strict NASA-60 mandate -- this codebase's own real style
// (heavily commented, verbose identifiers) runs longer than typical C, and the review
// stage's own genuine-vs-false-positive judgment is what actually calibrates this, the
// same way performance_review's heuristics stay useful despite firing on plenty of
// eventual false positives. Override via env var per-deployment, same convention
// staleness-audit.js's own AGENT_MANAGER_STALENESS_THRESHOLD_DAYS uses.
const DEFAULT_MAX_FUNCTION_LINES = 100;
function maxFunctionLines() {
  const raw = process.env.AGENT_MANAGER_MAX_FUNCTION_LINES;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 10 ? parsed : DEFAULT_MAX_FUNCTION_LINES;
}

// Three separate, narrow patterns rather than one broad one -- same "one regex per real
// shape, not a single clever catch-all" style observability-scan.js's own rules use, so
// each shape's match position is unambiguous. `name` capture groups exist for the two
// assignment forms so a finding can report a real identifier instead of "(anonymous)".
const NAMED_FUNCTION_RE = /\bfunction\s*\*?\s*[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/g;
const ARROW_ASSIGNMENT_RE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>\s*\{/g;
const FUNCTION_EXPRESSION_ASSIGNMENT_RE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\s*\*?\s*\([^)]*\)\s*\{/g;

function countLines(text) {
  if (!text) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') n++;
  return n;
}

// Scans one already-read file's text for over-length functions, deduping by the opening
// brace's own position so a construct matched by more than one pattern (shouldn't happen
// given how narrow each is, but cheap to guard) is never reported twice.
function findLongFunctions(text, relPath, threshold = maxFunctionLines()) {
  const findings = [];
  const seenBraceIndex = new Set();

  const patterns = [
    { re: NAMED_FUNCTION_RE, nameGroup: null },
    { re: ARROW_ASSIGNMENT_RE, nameGroup: 1 },
    { re: FUNCTION_EXPRESSION_ASSIGNMENT_RE, nameGroup: 1 },
  ];

  for (const { re, nameGroup } of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const openIndex = m.index + m[0].length - 1;
      if (seenBraceIndex.has(openIndex)) continue;
      seenBraceIndex.add(openIndex);

      const body = extractBraceBody(text, openIndex);
      if (body === null) continue;
      const lines = countLines(body);
      if (lines <= threshold) continue;

      const name = nameGroup ? m[nameGroup] : (m[0].match(/function\s*\*?\s*([A-Za-z_$][\w$]*)/) || [])[1];
      findings.push({
        rule: 'function-too-long',
        file: relPath,
        line: lineOfIndex(text, m.index),
        detail: `${name ? `function "${name}"` : 'this function'} is ${lines} lines long (threshold ${threshold}) -- consider decomposing into smaller, single-purpose functions`,
      });
    }
  }

  return findings;
}

// Scans one project (a real repoRoot, already checked out -- this module never clones or
// mutates anything). Returns findings with projectSlug/scannedAt attached, ready to
// append to a persistent flags file, same shape observability-scan.js's own scanProject
// returns.
function scanProject(clonePath, projectSlug) {
  const allFiles = listSourceFiles(clonePath, SCAN_EXTENSIONS);
  const scannedAt = new Date().toISOString();
  const findings = [];
  const threshold = maxFunctionLines();

  for (const file of allFiles) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (isLikelyMinified(text)) continue;
    const relPath = path.relative(clonePath, file).replace(/\\/g, '/');
    findings.push(...findLongFunctions(text, relPath, threshold));
  }

  return findings.map((f) => ({ ...f, projectSlug, scannedAt }));
}

module.exports = {
  scanProject,
  findLongFunctions,
  countLines,
  maxFunctionLines,
  DEFAULT_MAX_FUNCTION_LINES,
};
