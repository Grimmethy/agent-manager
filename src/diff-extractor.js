'use strict';

// Unified diff extractor (HUB0184 1/4) -- the SINGLE entry point every other piece in this
// hub (the review-task.js verification gate, the grounding-recheck-sweep guard, the shared
// tests) calls to get "the real diff for this task, whatever source produced it."
//
// Every task source in this codebase lands its produced change on the task object in one of
// a small number of shapes, and before this module existed each consumer re-derived them on
// its own (which is the root cause this hub fixes -- verification previously only ran for
// one shape, the adhoc `task.rawDiff` one, and silently skipped the others):
//
//   1. task.rawDiff                      -- a real unified diff captured from an isolated
//                                          git worktree. BOTH the adhoc agentic tiers
//                                          (agentic-draft-common.js) and the Group-B
//                                          worktree capture (group-b-worktree-diff.js's
//                                          captureGroupBDiffInWorktree, as stamped by
//                                          deterministic-draft-registry.js's
//                                          runOnePassStyleDraft) land here.
//   2. task.implementResponse.diff       -- object form, a string .diff member.
//   3. task.implementResponse as a string that IS a unified diff (agentic-draft-common.js
//                                          stamps `task.implementResponse = task.rawDiff` on
//                                          the implemented branch), or a summary prose with
//                                          a trailing `=== DIFF ===\n<diff>` section (the
//                                          exact shape validate-implement-truncation.js and
//                                          verify-merged-work.js already extract from).
//   4. A Group-B edit set: task.editSet (structured object/array of {mode, file, ...}), or
//                                          the same entries as the JSON string
//                                          task.implementResponse already applies
//                                          (apply-group-b.js). `create` entries carry their
//                                          full content, so a create-only set can be turned
//                                          into a REAL, `git apply`-able unified diff
//                                          without touching any repo; `edit`/`delete`
//                                          entries carry find/replace against content this
//                                          module does not have, so they cannot be turned
//                                          into a real diff here -- the honest answer is
//                                          null (a Group-B task that actually changed
//                                          anything already has its captured worktree diff
//                                          on task.rawDiff, source 1).
//
// Canonical return shape (or null when NO real diff exists, which is the normal
// no-changes-needed case):
//
//   { unifiedDiff: string, touchedFiles: string[] }
//
// Docs-only skip: a change that touches ONLY documentation (a .md/.rst/... file, a docs/
// or doc/ or adr/ directory, a README/AGENTS-style root file -- the SAME canonical
// classification adhoc-diff-sanity.js's own DOC_PATH_RE uses, mirrored here because that
// module does not export the predicate) is not a code change: it is not something the
// verification gate exists to gate, so this returns null for it too. An explicit
// docs-only flag (task.docsOnly / task.skipCodeReview) short-circuits before the cascade.

const { parseChangedFiles } = require('./adhoc-diff-sanity.js');

// Same classification adhoc-diff-sanity.js's DOC_PATH_RE applies (kept in sync with it;
// that module does not export the predicate, so it is mirrored rather than duplicated
// silently -- if the two ever disagree, adhoc-diff-sanity.js's is the substance-gate
// authority and this one is only a skip signal).
const DOCS_ONLY_PATH_RE = /(^|\/)(docs?|adr)(\/|$)|(^|\/)(README|CHANGELOG|CHANGES|HISTORY|CONTRIBUTING|AGENTS)(\.[\w-]+)?$|\.(md|mdx|markdown|rst|txt|adoc)$/i;

// Explicit source-set / flag names that mean "this task is documentation by intent."
// None of these is a registered source name in prompts.js today; the list exists so a
// future docs-only source (or a human filing) can declare itself without this module
// having to re-guess from the prose.
const DOCS_ONLY_SOURCES = new Set(['docs', 'documentation', 'doc', 'adr', 'docs-only']);

function isDocOnlyPath(p) {
  return DOCS_ONLY_PATH_RE.test(String(p || ''));
}

function normalizePath(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '');
}

// Does a (trimmed) text START with a real unified-diff header -- `diff --git x y` or
// `GIT binary patch` (the two valid leading shapes normalizeDiffOutput documents)? Checks
// the FIRST LINE only: a real diff is multi-line, so anchoring `^...$` against the whole
// string (without the `m` flag) would never match it.
function startsWithDiffHeader(text) {
  const firstLine = String(text || '').trim().split('\n')[0].trim();
  return /^(?:diff --git \S+ \S+|GIT binary patch)$/.test(firstLine);
}

// Last `=== DIFF ===` line of a text (the marker agentic-draft-common.js,
// validate-implement-truncation.js and verify-merged-work.js all use), or -1.
function diffMarkerIndex(text) {
  // [ \t] only, NOT \s -- \s crosses newlines and would drag the previous line into the
  // match, so lastIndexOf would point at the wrong (newline-prefixed) position.
  const matches = text.match(/^[ \t]*=== DIFF ===[ \t]*$/gm);
  if (!matches || matches.length === 0) return -1;
  const m = matches[matches.length - 1];
  return text.lastIndexOf(m);
}

// The task's unified diff string, from whichever source actually carries one, or ''.
function findUnifiedDiff(task) {
  // 1) task.rawDiff -- the canonical captured-worktree diff (adhoc tiers AND Group-B
  //    worktree capture both land here; see this file's header).
  if (typeof task.rawDiff === 'string' && task.rawDiff.trim()) return task.rawDiff.trim();

  const impl = task.implementResponse;
  if (impl && typeof impl === 'object') {
    // 2) implementResponse.diff (object form).
    if (typeof impl.diff === 'string' && impl.diff.trim() && startsWithDiffHeader(impl.diff)) {
      return impl.diff.trim();
    }
    return '';
  }

  if (typeof impl === 'string' && impl.trim()) {
    const trimmed = impl.trim();
    // 3a) implementResponse that IS itself a unified diff.
    if (startsWithDiffHeader(trimmed)) return trimmed;
    // 3b) summary prose with a trailing `=== DIFF ===\n<diff>` section.
    const idx = diffMarkerIndex(trimmed);
    if (idx >= 0) {
      const after = trimmed.slice(idx).replace(/^=== DIFF ===[ \t]*(?:\r?\n)?/, '').trim();
      if (after && startsWithDiffHeader(after)) return after;
    }
  }
  return '';
}

function normalizeTouchedFiles(task, unifiedDiff) {
  if (Array.isArray(task.touchedFiles)) {
    const files = task.touchedFiles.filter((f) => typeof f === 'string' && f.trim()).map(normalizePath);
    if (files.length > 0) return [...new Set(files)];
  }
  const files = parseChangedFiles(unifiedDiff).map((f) => normalizePath(f.path));
  return [...new Set(files)];
}

function isEditSetEntry(item) {
  return Boolean(item && typeof item === 'object' && typeof item.file === 'string' && item.file.trim());
}

// The task's Group-B edit set as an array of {mode, file, ...} entries, or null if the
// task carries none (a prose implementResponse summary that is not valid JSON, an empty
// array, or JSON without any `file`-bearing entry all mean "no edit set here").
function extractEditSet(task) {
  let items = null;
  if (Array.isArray(task.editSet)) items = task.editSet;
  else if (task.editSet && typeof task.editSet === 'object') items = [task.editSet];
  else if (typeof task.implementResponse === 'string' && task.implementResponse.trim()) {
    try {
      // parseJsonMaybeFenced via apply-group-b.js's own dependency -- same parser the
      // real applier uses, so "is this an edit set?" agrees with "can this be applied?".
      // Lazy require (inside the function) keeps the module's import graph flat; either
      // works, but grouping the parse in one place is what apply-group-b.js itself does.
      const { parseJsonMaybeFenced } = require('./json-fence.js');
      const parsed = parseJsonMaybeFenced(task.implementResponse);
      if (Array.isArray(parsed)) items = parsed;
      else if (parsed && typeof parsed === 'object') items = [parsed];
    } catch {
      items = null; // not JSON at all -- prose summary, not an edit set
    }
  }
  if (!items) return null;
  const valid = items.filter(isEditSetEntry);
  return valid.length > 0 ? valid : null;
}

// A REAL (git-apply-able) unified diff for a Group-B edit set, only when every entry is a
// `create` with full content -- the one edit-set shape that needs no prior file content to
// be exact. Anything else (edit/delete modes) needs content this module does not have, so
// it returns null rather than inventing a hunk `git apply` would reject.
function synthesizeCreateDiff(items) {
  if (items.some((it) => it.mode !== 'create')) return null;
  const lines = [];
  for (const it of items) {
    const file = normalizePath(it.file);
    const content = typeof it.content === 'string' ? it.content.replace(/\n$/, '') : '';
    const newLines = content ? content.split('\n').length : 0;
    lines.push(`diff --git a/${file} b/${file}`, 'new file mode 100644', '--- /dev/null', `+++ b/${file}`, `@@ -0,0 +1,${newLines} @@`);
    for (const l of (content ? content.split('\n') : [])) lines.push(`+${l}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Single entry point for "what diff did this task produce, and which files does it touch?"
 * regardless of which source produced it. See this file's header for the exact source
 * cascade.
 *
 * @param {object} task - The task object (as stored in the queue; only its own fields are
 *   read -- no repo, no git, no side effects).
 * @returns {{ unifiedDiff: string, touchedFiles: string[] } | null} The canonical shape,
 *   or null when no real diff exists (no-changes-needed task, or a docs-only change).
 */
function extractTaskDiff(task) {
  if (!task || typeof task !== 'object') return null;

  // Docs-only skip: explicit flag / source-set short-circuit, before the cascade.
  if (task.docsOnly === true || task.skipCodeReview === true) return null;
  if (typeof task.source === 'string' && DOCS_ONLY_SOURCES.has(task.source.trim().toLowerCase())) return null;

  let unifiedDiff = findUnifiedDiff(task);

  // Group-B edit-set fallback: only a create-only set can be turned into a real diff
  // without the pre-edit file content; an edit/delete set with no captured rawDiff has no
  // real diff to offer (null), never a fabricated one.
  if (!unifiedDiff) {
    const editSet = extractEditSet(task);
    if (editSet) unifiedDiff = synthesizeCreateDiff(editSet);
  }

  if (!unifiedDiff) return null; // no real diff at all (no-changes-needed)

  const touchedFiles = normalizeTouchedFiles(task, unifiedDiff);
  if (touchedFiles.length > 0 && touchedFiles.every(isDocOnlyPath)) return null; // docs-only change
  return { unifiedDiff, touchedFiles };
}

module.exports = { extractTaskDiff, DOCS_ONLY_SOURCES };
