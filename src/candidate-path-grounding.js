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
const path = require('path');
const { checkFilePaths, resolveAgainstRepoDetailed } = require('./fact-checker.js');
const { backtickIdentifiers } = require('./task-anchor-files.js');

// The `Files:` line of an AC-NNN / deep-dive write-up. Case-insensitive, tolerant of
// leading markdown (`- `, `> `, `**Files:**`). Returns the value string, or '' if absent.
function extractFilesLine(text) {
  const m = String(text || '').match(/^[\s>*_-]*files\s*:[\s*]*(.+?)[\s*]*$/im);
  return m ? m[1].trim() : '';
}

// ONE definition of "which real file does this Files: entry name?", shared by the discovery-time
// check (checkCitedPaths), the write-time normalization (normalizeFilesLine, used when a candidate is
// appended to a Docs/*_CANDIDATES.md) and the fulfillment-time fetch (sdk/lib/candidate-lifecycle.js).
// They used to disagree (2026-09-19, PropertyForager arch-review-ac-1): the check resolved an entry by
// exact path / configured code dir / unique basename, but the fetch read the EXACT repo-relative path
// only -- so `Files: SearchView.tsx` passed the check, then fetched nothing and the drafter saw no code;
// and an extension-less `Files: SearchView` was never checked at all (extractFilePaths only matches
// tokens with an extension), so it slipped through as vacuously fine.
//
// resolveCitedFile: exact / extraRoots prefix / unique basename (fact-checker's resolver), and for an
// extension-less entry also probes the common code extensions. Returns
// { claimedPath, exists, resolvedPath, resolvedVia, relPath, isFile }.
const PROBE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.py'];

function cleanEntry(raw) {
  return String(raw || '').trim().replace(/^[`'"]+|[`'"]+$/g, '').replace(/\s*\([^)]*\)\s*$/, '').trim();
}

// 2026-09-24 (arch-discovery-community-19 false positive): a plain `.split(',')` on the
// Files: line breaks a legitimate parenthetical annotation apart at the commas INSIDE it --
// `Files: budget-health module (functions: computeBudgetHealthy, estimateBudgetCeiling,
// usageTokenCount)` split into "budget-health module (functions: computeBudgetHealthy",
// " estimateBudgetCeiling", " usageTokenCount)". cleanEntry's own trailing-paren strip only
// catches a *complete* `(...)` group, so the two inner fragments survive as bare
// FILE_LIKE_ENTRY-shaped identifiers, get probed as file paths, fail to resolve (they're
// function names, not files), and the whole real, well-grounded finding gets blocked as
// "fabricated" -- confirmed live: estimateBudgetCeiling has existed in budget-monitor.js
// since 2026-08-17. Splits only on a comma OUTSIDE any parenthesized span, so the
// annotation stays intact as one entry for cleanEntry's existing whole-group strip to handle.
function splitFilesLineEntries(filesLine) {
  const out = [];
  let depth = 0;
  let start = 0;
  const s = String(filesLine || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ',' && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

function resolveCitedFile(repoRoot, claimed, extraRoots = []) {
  const claimedPath = cleanEntry(claimed);
  const none = { claimedPath, exists: false, resolvedPath: null, resolvedVia: null, relPath: null, isFile: false };
  if (!claimedPath || !repoRoot) return none;
  let r = resolveAgainstRepoDetailed(repoRoot, claimedPath, extraRoots);
  if (!r.resolvedPath && !path.extname(claimedPath)) {
    for (const ext of PROBE_EXTENSIONS) {
      const probed = resolveAgainstRepoDetailed(repoRoot, claimedPath + ext, extraRoots);
      if (probed.resolvedPath) { r = { resolvedPath: probed.resolvedPath, resolvedVia: probed.resolvedVia === 'exact' ? 'extension' : probed.resolvedVia }; break; }
    }
  }
  if (!r.resolvedPath) return none;
  let isFile = false;
  try { isFile = fs.statSync(r.resolvedPath).isFile(); } catch { /* raced away -- treated as not a file */ }
  const relPath = path.relative(repoRoot, r.resolvedPath).split(path.sep).join('/');
  return { claimedPath, exists: true, resolvedPath: r.resolvedPath, resolvedVia: r.resolvedVia, relPath, isFile };
}

// An extension-less Files: entry worth checking: identifier- or slash-path-shaped. Prose ("the search
// component"), globs ("src/*") and dotfiles are skipped so they can't become false "fabricated" blocks.
const FILE_LIKE_ENTRY = /^[A-Za-z_][\w.-]*(?:\/[\w.-]+)*$/;

// 2026-09-21 (PF arch-discovery-community-5): the working tree is MUTABLE. The shared checkout sat on a stale `agent/triage-queue` branch (no
// dealCsv.ts) while a draft ran, so three real files read as "fabricated", the block was made non-retryable, and a valid task died. A path is
// only invented if it is missing from the working tree AND from origin/<main> (git's object database, immune to whatever branch the checkout
// happens to be on). Returns the repo-relative path it resolves to at that ref, or null. Never throws; an unreadable ref reads as "not found",
// which leaves the working-tree verdict in force. Kill switch: AGENT_MANAGER_CANDIDATE_GROUNDING_MAIN_REF=false.
function mainRefEnabled() { return process.env.AGENT_MANAGER_CANDIDATE_GROUNDING_MAIN_REF !== 'false'; }
function resolveCitedFileAtMain(repoRoot, claimed, extraRoots = [], mainBranch = null) {
  const claimedPath = cleanEntry(claimed);
  if (!claimedPath || !repoRoot || !mainRefEnabled()) return null;
  try {
    const { resolveAtRef } = require('./stacked-grounding.js');
    const branch = mainBranch || require('./git-runner.js').detectDefaultBranch(repoRoot);
    const tries = path.extname(claimedPath) ? [claimedPath] : PROBE_EXTENSIONS.map((e) => claimedPath + e);
    for (const t of tries) {
      const hit = resolveAtRef(repoRoot, branch, t, extraRoots);
      if (hit) return hit;
    }
  } catch { /* fall through: not found */ }
  return null;
}

// (filesLine, repoRoot, extraRoots) -> { fabricated: [{claimedPath, exists, ...}], checked: [...] }
// extraRoots is fact-checker.js's own param shape: repoRoot-relative code dirs
// (getConfig().grepAllowedDirs) so `Files: local-client.js` still resolves to
// `src/local-client.js` and is NOT flagged.
function checkCitedPaths(filesLine, repoRoot, extraRoots = [], { mainBranch = null } = {}) {
  if (!filesLine || !repoRoot) return { fabricated: [], checked: [] };
  const checked = checkFilePaths(filesLine, repoRoot, extraRoots);
  // Extension-less entries (see resolveCitedFile's header): the regex above never sees them.
  const seen = new Set(checked.map((r) => r.claimedPath));
  for (const raw of splitFilesLineEntries(filesLine)) {
    const entry = cleanEntry(raw);
    if (!entry || path.extname(entry) || !FILE_LIKE_ENTRY.test(entry) || seen.has(entry)) continue;
    seen.add(entry);
    const r = resolveCitedFile(repoRoot, entry, extraRoots);
    checked.push({ claimedPath: entry, exists: r.exists, resolvedPath: r.resolvedPath, resolvedVia: r.resolvedVia });
  }
  // Rescue: a working-tree miss that exists at origin/<main> is not invented (see resolveCitedFileAtMain).
  for (const r of checked) {
    if (r.exists !== false) continue;
    const hit = resolveCitedFileAtMain(repoRoot, r.claimedPath, extraRoots, mainBranch);
    if (hit) { r.exists = true; r.resolvedPath = path.join(repoRoot, hit); r.resolvedVia = 'origin-main'; }
  }
  const fabricated = checked.filter((r) => r.exists === false);
  return { fabricated, checked };
}

// Inverse of formatFabricatedReason: the paths a "fabricated file path(s): a, b -- not present anywhere in the target repo" reason names,
// matched against that exact producer (never a looser pattern, so it can't fire on another gate's wording). [] when it isn't one.
const FABRICATED_REASON_RE = /fabricated file path\(s\):\s*(.+?)\s*--\s*not present anywhere in the target repo/i;
function parseFabricatedPaths(text) {
  const m = FABRICATED_REASON_RE.exec(String(text || ''));
  return m ? m[1].split(',').map((x) => x.trim()).filter(Boolean) : [];
}

// Rewrites each Files: entry that resolves to a real FILE by anything other than its exact
// repo-relative path (bare basename, missing extension, code-dir prefix) to that repo-relative path, so
// the candidate a human and the fulfillment fetch both read names the real file. Entries that already
// are exact, or resolve to nothing, are left byte-for-byte as written.
function normalizeFilesLine(filesLine, repoRoot, extraRoots = []) {
  if (!filesLine || !repoRoot) return filesLine;
  return String(filesLine).split(',').map((raw) => {
    const r = resolveCitedFile(repoRoot, raw, extraRoots);
    const exact = cleanEntry(raw).replace(/\\/g, '/').replace(/^\.?\//, '');
    return (r.exists && r.isFile && r.relPath && r.relPath !== exact) ? r.relPath : raw.trim();
  }).join(', ');
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
  resolveCitedFile,
  resolveCitedFileAtMain,
  parseFabricatedPaths,
  normalizeFilesLine,
  symbolCheckBlocks,
  formatSymbolWarnings,
  extractFilesLine,
  splitFilesLineEntries,
  checkCitedPaths,
  formatFabricatedReason,
  checkCitedSymbols,
  splitCandidateEntries,
  checkCitedSymbolsPerEntry,
  formatFabricatedSymbolsReason,
};
