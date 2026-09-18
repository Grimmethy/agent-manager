'use strict';

// Deterministic "Check 0" for the candidate-generator grounding checks -- arch_import,
// arch_discovery, deep_dive (concept-candidate-grounding-gate-3e9bec). Their implement
// pass emits a structured write-up with a `Files: a, b, c` line naming destination paths.
// When the model names a path that resolves NOWHERE in the target repo -- not even by
// fact-checker.js's basename walk -- that is not a judgment call and not stochastically
// unlucky: a blind redraft re-invents it (the plan pass proposes fresh search terms each
// attempt, but the model still fabricates the Files: line). Measured cost of discovering
// it the current way: 1 plan + 1 implement + 1 qwen2.5:3b grounding call + a 3-vote
// review round + up to MAX_LOCAL_REJECT_RETRIES blind redraft cycles, each re-fabricating,
// then a human.
//
// This parses ONLY the Files: line (never the Problem/Solution prose, which may mention a
// hypothetical path) and runs the real fs-backed checkFilePaths. The caller turns a
// non-empty `fabricated` list into an `ungrounded` verdict whose reason starts
// "fabricated file path(s): ..."; blocked-task-classifiers.js's `fabricated-file-path`
// classifier then makes that NON-retryable -- straight to needs-clarification, no retry
// budget burned.
//
// Narrow on purpose: only `exists === false` counts. A real file cited with a wrong or
// missing directory prefix (resolvedVia !== 'exact') is a citation nit the existing
// Check 1 / review already handle. A real-but-unsearched file (the "wrong adaptation
// site" case) is out of scope for v1 and stays a retryable `ungrounded` as today.

const fs = require('fs');
const { checkFilePaths } = require('./fact-checker.js');
const { backtickIdentifiers } = require('./task-anchor-files.js');

// The `Files:` line of an AC-NNN / deep-dive write-up. Case-insensitive, tolerant of
// leading markdown (`- `, `> `, `**Files:**`). Returns the value string, or '' if absent.
function extractFilesLine(text) {
  const m = String(text || '').match(/^[\s>*_-]*files\s*:[\s*]*(.+?)[\s*]*$/im);
  return m ? m[1].trim() : '';
}

// (filesLine, repoRoot, extraRoots) -> { fabricated: [{claimedPath, exists, ...}], checked: [...] }
// extraRoots is fact-checker.js's own param shape: repoRoot-relative code dirs
// (getConfig().grepAllowedDirs) so `Files: local-client.js` still resolves to
// `src/local-client.js` and is NOT flagged.
function checkCitedPaths(filesLine, repoRoot, extraRoots = []) {
  if (!filesLine || !repoRoot) return { fabricated: [], checked: [] };
  const checked = checkFilePaths(filesLine, repoRoot, extraRoots);
  const fabricated = checked.filter((r) => r.exists === false);
  return { fabricated, checked };
}

function formatFabricatedReason(fabricated) {
  const paths = fabricated.map((f) => f.claimedPath);
  return `fabricated file path(s): ${paths.join(', ')} -- not present anywhere in the target repo. `
    + 'A redraft cannot make an invented path real; re-file with an accurate citation, or archive if nothing applies.';
}

// 2026-09-17 (needs-clarification bd-1788994211702, "fact-check content verification --
// function/symbol-name grep"): Check 0 above only ever verified the `Files:` line's
// PATHS. A candidate whose Problem/Solution prose cites a specific backtick-quoted
// symbol -- "`resolveDisposition` never checks `task.reviewDisposition`" -- that does not
// actually exist anywhere in the cited (real, existing) file is exactly the same class of
// fabrication as an invented path: not a judgment call, not stochastically unlucky, and a
// blind redraft re-invents the same citation because the plan pass hands back the same
// file content each attempt.
//
// Deliberately grep-based, not an LLM call: fact-checker.js's own existing Check 1
// (candidate-path-grounding's sibling qwen2.5:3b semantic pass) already catches this
// class of mistake sometimes, but stays retryable (blocked-task-classifiers.test.js:
// "a Check-1 fabricated-symbol block stays retryable") because it's a model judgment call
// that can itself be wrong. A literal substring grep against the file the candidate ITSELF
// cited is not a judgment call -- the symbol is either textually present or it isn't.
//
// Only runs against files Check 0 already confirmed EXIST (checkedPaths' exists===true
// entries) -- a symbol cited against a fabricated path is already caught, more
// informatively, by Check 0; piling a second verdict on the same root cause adds nothing.
//
// Create-mode exemption: a candidate proposing to ADD a new symbol legitimately names one
// that doesn't exist yet ("add a `validateSymbolCitation` helper to fact-checker.js").
// CREATE_MODE_VERBS looks for a creation verb in the ~60 chars immediately before the
// backtick mention -- deliberately narrow/local (not a full-document flag) so a create-mode
// verb earlier in an unrelated sentence can't blanket-exempt a later, genuinely fabricated
// "already exists" claim elsewhere in the same write-up.
const CREATE_MODE_VERBS = /\b(?:add|adds|adding|new|create|creates|creating|introduce|introduces|introducing|define|defines|defining|rename(?:d|s)?\s+(?:it\s+)?to|extract(?:ed|s)?\s+into)\s+(?:an?\s+|the\s+)?(?:new\s+)?[^`]{0,40}$/i;

// Backtick-quoted tokens that are common code-prose vocabulary, never a claim that a
// specific symbol already exists in the cited file -- grepping for these would just be
// noise (every file contains "return" or "this").
const SYMBOL_STOPWORDS = new Set([
  'true', 'false', 'null', 'undefined', 'this', 'return', 'function', 'const', 'let', 'var',
  'if', 'else', 'for', 'while', 'class', 'async', 'await', 'require', 'module', 'exports',
  'new', 'delete', 'typeof', 'instanceof', 'catch', 'try', 'throw',
]);

function isCreateModeMention(text, matchIndex) {
  const before = text.slice(Math.max(0, matchIndex - 60), matchIndex);
  return CREATE_MODE_VERBS.test(before);
}

// (text, checkedPaths, repoRoot) -> { fabricated: [{name}], checked: [names] }
// checkedPaths is checkCitedPaths' own `checked` array (or fact-checker.js's
// checkFilePaths shape directly) -- {claimedPath, exists, resolvedPath}[].
function checkCitedSymbols(text, checkedPaths) {
  const existingFiles = (checkedPaths || []).filter((f) => f && f.exists && f.resolvedPath);
  if (!existingFiles.length) return { fabricated: [], checked: [] };

  let fileContents;
  try {
    fileContents = existingFiles.map((f) => fs.readFileSync(f.resolvedPath, 'utf8'));
  } catch {
    return { fabricated: [], checked: [] }; // advisory -- unreadable file, skip
  }

  const raw = String(text || '');
  const names = backtickIdentifiers(raw).filter(
    (name) => name.length >= 3 && !SYMBOL_STOPWORDS.has(name.toLowerCase()),
  );
  const checked = [];
  const fabricated = [];
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const mentionMatch = raw.match(new RegExp('`' + escaped + '\\(?\\)?`'));
    if (mentionMatch && isCreateModeMention(raw, mentionMatch.index)) continue;
    checked.push(name);
    const foundSomewhere = fileContents.some((content) => content.includes(name));
    if (!foundSomewhere) fabricated.push({ name });
  }
  return { fabricated, checked };
}

function formatFabricatedSymbolsReason(fabricated) {
  const names = fabricated.map((f) => '`' + f.name + '`');
  return `fabricated symbol citation(s): ${names.join(', ')} -- not found anywhere in the cited file(s). `
    + 'A redraft cannot make an invented symbol real; re-file with an accurate citation, or archive if nothing applies.';
}

module.exports = {
  extractFilesLine,
  checkCitedPaths,
  formatFabricatedReason,
  checkCitedSymbols,
  formatFabricatedSymbolsReason,
};
