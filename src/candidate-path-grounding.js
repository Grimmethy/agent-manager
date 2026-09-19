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

// A backtick-quoted filename ("`core.ts` parses the body") is a path citation, not a symbol
// claim: a source file never contains its own name, so grepping the cited file's CONTENT for
// it always "fails". Real path fabrication is Check 0's job (the Files: line), not this one's.
// Confirmed live 2026-09-19: 7 of the 11 "fabricated symbols" that blocked all of
// PropertyForager's first arch_discovery drafts were filenames (`App.tsx`, `SearchView.tsx`...).
const FILENAME_TOKEN = /^[\w./-]+\.(?:[cm]?[jt]sx?|py|json|md|s?css|html|sh|ps1|ya?ml|toml)$/i;

// A candidate's `Solution:` and `Benefits:` sections describe the PROPOSED state (Benefits also
// names hypothetical additions: "e.g. a `totalPages` counter"), so they legitimately name symbols
// that do not exist yet. Solution: section PROPOSES change, so it legitimately names symbols that do
// not exist yet ("Export a single `LEGAL_DOCS` array", "Extract a `resetResults()` helper",
// "expose it as `ApiError.rawBody`"). CREATE_MODE_VERBS only recognizes a handful of verbs
// within ~60 chars, so proposals phrased any other way were flagged as fabrication -- the
// other 4 of those 11 flags. Claims about EXISTING code live in Problem:, which stays checked.
// Blanked per entry (a write-up may hold several AC-NNN blocks), from the `Solution:` header
// up to the next section header, next `###` entry, or end of text.
const SOLUTION_SECTION = /^[\s>*_-]*(?:solution|benefits)\s*:[\s\S]*?(?=^[\s>*_-]*(?:problem|files|strength)\s*:|^#{2,}\s|(?![\s\S]))/gim;

function stripSolutionSections(text) {
  return String(text || '').replace(SOLUTION_SECTION, '');
}

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

  const raw = stripSolutionSections(text);
  const names = backtickIdentifiers(raw).filter(
    (name) => name.length >= 3 && !SYMBOL_STOPWORDS.has(name.toLowerCase()) && !FILENAME_TOKEN.test(name),
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

// A write-up can hold several `### AC-NNN` entries, each with its OWN `Files:` line, but
// extractFilesLine() returns only the first. Checking every entry's symbols against just the
// first entry's files flags a real symbol from a later entry's file as fabricated (confirmed
// live 2026-09-19: AC-003's `goToClientLogin`/`authMode`, real in App.tsx, were checked
// against AC-001's AppFooter/Login/legalContent and blocked the whole draft). Splits on `###`
// headers; text without one is a single entry, i.e. the previous behavior.
function splitCandidateEntries(text) {
  const raw = String(text || '');
  const parts = raw.split(/^(?=###\s)/m).filter((p) => p.trim());
  return parts.length > 1 ? parts : [raw];
}

// (text, repoRoot, extraRoots) -> { fabricated: [{name}] } -- checkCitedSymbols run once per
// entry against that entry's own resolved Files: line, names de-duplicated across entries.
function checkCitedSymbolsPerEntry(text, repoRoot, extraRoots = []) {
  const fabricated = [];
  const seen = new Set();
  for (const entry of splitCandidateEntries(text)) {
    const { checked } = checkCitedPaths(extractFilesLine(entry), repoRoot, extraRoots);
    for (const f of checkCitedSymbols(entry, checked).fabricated) {
      if (!seen.has(f.name)) { seen.add(f.name); fabricated.push(f); }
    }
  }
  return { fabricated };
}

function formatFabricatedSymbolsReason(fabricated) {
  const names = fabricated.map((f) => '`' + f.name + '`');
  return `fabricated symbol citation(s): ${names.join(', ')} -- not found anywhere in the cited file(s). `
    + 'A redraft cannot make an invented symbol real; re-file with an accurate citation, or archive if nothing applies.';
}

// The symbol check is a literal-text heuristic: it cannot tell "cites code that does not exist"
// from "names a symbol the draft proposes", or a symbol living in a different real file. It was
// a hard, non-retryable block; four separate false-positive classes in one day (filenames,
// Solution:/Benefits: prose, multi-entry drafts) blocked every first arch_discovery draft for
// PropertyForager, so it now WARNS by default: the finding rides to the review votes as
// advisory context (task.groundingWarnings) instead of ending the draft. Path fabrication
// (Check 0) stays a hard block. AGENT_MANAGER_SYMBOL_CHECK_BLOCKING=true restores the block.
function symbolCheckBlocks() {
  return process.env.AGENT_MANAGER_SYMBOL_CHECK_BLOCKING === 'true';
}

function formatSymbolWarnings(fabricated) {
  const names = (fabricated || []).map((f) => '`' + f.name + '`');
  if (!names.length) return [];
  return [`symbol(s) ${names.join(', ')} not found by literal text search in the file(s) this candidate cites`];
}

module.exports = {
  symbolCheckBlocks,
  formatSymbolWarnings,
  extractFilesLine,
  checkCitedPaths,
  formatFabricatedReason,
  checkCitedSymbols,
  splitCandidateEntries,
  checkCitedSymbolsPerEntry,
  formatFabricatedSymbolsReason,
};
