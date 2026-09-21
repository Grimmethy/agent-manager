'use strict';

const fs = require('fs');
const path = require('path');
const { snippetFromSection, quotedSymbolsFromSection } = require('./candidate-doc-parsing.js');
const { findFuzzyMatch, windowAroundIndex } = require('./fuzzy-matching.js');

// Same literals as src/sdk/candidate-fulfillment.js (the source these were moved out of)
// -- duplicated here rather than required back, so this module stays self-contained.
const SNIPPET_FIELD_RE = /^Snippet:\s*\n```\n([\s\S]*?)\n```/m;
const MIN_ANCHOR_SYMBOL_CHARS = 4;
const MAX_ANCHOR_OCCURRENCES = 5;
const LINE_CITATION_RE = /\blines?\s+(\d+)/i;
const MAX_FETCHED_FILE_CHARS = 8000;
const MAX_ANCHOR_REGIONS = 5;
const MIN_CONFIDENT_PARTIAL_FRACTION = 0.3; // findPartialMatch tries 0.75, 0.5, 0.35, 0.25, 0.15 of the snippet: the two smallest tiers are the weak guesses
const MAX_FETCHED_FILE_TOTAL_CHARS = 22000;
const MIN_REGION_CHARS = 1400;
const LOW_CONFIDENCE_GROUNDING_NOTE = '[LOW-CONFIDENCE GROUNDING: no reliable anchor found '
  + "for this candidate's cited code -- this window is a best-effort guess and may not "
  + 'contain the real target. If you cannot find the described code here, respond with a '
  + 'clarification request rather than guessing.]\n';

function collectAnchorHits(content, section) {
  const hits = [];
  const seen = new Map();
  const push = (index, length, rank, extra) => {
    if (index == null || index < 0) return;
    const bucket = Math.round(index / 200);
    if (seen.has(bucket)) {
      // Another, independent signal (a quoted symbol / cited line) landing where a weak partial guess already sits corroborates it.
      const prior = seen.get(bucket);
      if (prior.weakPartial && !(extra && extra.weakPartial)) delete prior.weakPartial;
      return;
    }
    const hit = { index, length: Math.max(length || 0, 1), rank, ...extra };
    seen.set(bucket, hit);
    hits.push(hit);
  };

  const snippet = snippetFromSection(section);
  if (snippet) {
    const match = findFuzzyMatch(content, snippet);
    // A PARTIAL match (only the snippet's prefix or suffix was found -- fuzzy-matching.js findPartialMatch) locates the code but is a weaker claim than a whole-snippet match:
    // when under ~30% of the snippet matched (the 0.25 and 0.15 tiers), mark the hit so windowFetchedFileContent does not present it as a confident anchor (review of PR #436). It still ranks first, and a
    // quoted symbol that lands in the same window corroborates it (that hit is not marked, so the window stays 'strong').
    if (match) push(match.index, match.length, 0, match.partial && match.length < snippet.length * MIN_CONFIDENT_PARTIAL_FRACTION ? { weakPartial: true } : undefined);
  }

  // The fenced Snippet: block's own triple backticks otherwise confuse QUOTED_SYMBOL_RE's
  // single-backtick pairing (a real bug, caught by direct test) -- strip it first.
  const prose = (section || '').replace(SNIPPET_FIELD_RE, '');

  for (const symbol of quotedSymbolsFromSection(prose)) {
    if (symbol.length < MIN_ANCHOR_SYMBOL_CHARS) continue;
    const occ = [];
    let from = 0;
    for (;;) {
      const i = content.indexOf(symbol, from);
      if (i === -1 || occ.length > MAX_ANCHOR_OCCURRENCES) break;
      occ.push(i);
      from = i + symbol.length;
    }
    if (occ.length === 0) continue;
    if (occ.length > MAX_ANCHOR_OCCURRENCES) {
      // Too generic to trust as a real anchor, but a weak/last-resort single-window
      // fallback beats blind head-truncation -- rank 3 is never eligible for the
      // multi-region path (see windowFetchedFileContent), only its zero-strong-hits
      // fallback.
      push(occ[0], symbol.length, 3);
      continue;
    }
    for (const i of occ) push(i, symbol.length, 1);
  }

  const lineMatch = prose.match(LINE_CITATION_RE);
  if (lineMatch) {
    const lineNum = Number(lineMatch[1]);
    const lines = content.split('\n');
    if (lineNum >= 1 && lineNum <= lines.length) {
      const idx = lines.slice(0, lineNum - 1).join('\n').length + (lineNum > 1 ? 1 : 0);
      push(idx, 0, 2);
    }
  }

  return hits.sort((a, b) => a.rank - b.rank || a.index - b.index);
}

function windowFetchedFileContent(content, section, maxChars = MAX_FETCHED_FILE_CHARS) {
  if (content.length <= maxChars) {
    return { text: content, confidence: 'strong', anchorCount: 0, usedSnippetFuzzyMatch: false };
  }

  const allHits = collectAnchorHits(content, section);
  const usedSnippetFuzzyMatch = allHits.some((h) => h.rank === 0);
  const strongHits = allHits.filter((h) => h.rank < 3).slice(0, MAX_ANCHOR_REGIONS);

  if (strongHits.length === 0) {
    const weakHit = allHits.find((h) => h.rank === 3);
    if (weakHit) {
      return {
        text: LOW_CONFIDENCE_GROUNDING_NOTE + windowAroundIndex(content, weakHit.index, weakHit.length, maxChars),
        confidence: 'weak',
        anchorCount: 1,
        usedSnippetFuzzyMatch: false,
      };
    }
    return {
      text: LOW_CONFIDENCE_GROUNDING_NOTE + `${content.slice(0, maxChars)}\n...[truncated]`,
      confidence: 'none',
      anchorCount: 0,
      usedSnippetFuzzyMatch: false,
    };
  }
  // Every anchor is a small-fraction partial guess and nothing else corroborates it: use it to place the window, but say so (weak tier + the low-confidence note) rather than
  // reporting a confident anchor. 'weak' is not 'none', so a task is not parked for it (blocked-task-classifiers / reject-retry-check key on 'none').
  if (strongHits.every((h) => h.weakPartial)) {
    return {
      text: LOW_CONFIDENCE_GROUNDING_NOTE + windowAroundIndex(content, strongHits[0].index, strongHits[0].length, maxChars),
      confidence: 'weak',
      anchorCount: 1,
      usedSnippetFuzzyMatch,
    };
  }
  if (strongHits.length === 1) {
    return {
      text: windowAroundIndex(content, strongHits[0].index, strongHits[0].length, maxChars),
      confidence: 'strong',
      anchorCount: 1,
      usedSnippetFuzzyMatch,
    };
  }

  // Equal share of a shared budget, capped at the single-window size, floored so each
  // window is still worth showing.
  const totalBudget = Math.min(MAX_FETCHED_FILE_TOTAL_CHARS, Math.max(maxChars, content.length));
  const perRegion = Math.max(MIN_REGION_CHARS, Math.min(maxChars, Math.floor(totalBudget / strongHits.length)));
  const half = Math.floor(perRegion / 2);

  const ranges = strongHits
    .map((h) => ({ from: Math.max(0, h.index - half), to: Math.min(content.length, h.index + h.length + half) }))
    .sort((a, b) => a.from - b.from);

  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.from <= last.to + 40) last.to = Math.max(last.to, r.to);
    else merged.push({ ...r });
  }

  const out = [];
  if (merged[0].from > 0) out.push('...[truncated]...');
  merged.forEach((r, i) => {
    out.push(content.slice(r.from, r.to));
    if (i < merged.length - 1) out.push('...[gap]...');
    else if (r.to < content.length) out.push('...[truncated]');
  });
  return { text: out.join('\n'), confidence: 'strong', anchorCount: strongHits.length, usedSnippetFuzzyMatch };
}

// The candidate HAS a Snippet and it is nowhere in this file (whole, or via findFuzzyMatch's prefix/suffix fallback). This, not a low window confidence, is what says the cited
// code left: a file can still window "strong" through quoted symbols that merely occur elsewhere in it (observability-fix-ac-111: `abort(404)` is all over app.py).
function snippetMissingFrom(content, section) {
  const snippet = snippetFromSection(section);
  return !!snippet && !looksLikeDiff(snippet) && !findFuzzyMatch(content, snippet);
}

// A change_review candidate's Snippet is a unified DIFF of some commit, not a block of source: it names a file it changed, its '+'/'-' lines never occur in the source, and
// "the diff is not in this file" says nothing about the code having moved (change-review-fix-ac-2's diff of apply-retry-check.js would "relocate" from the test to the source).
function looksLikeDiff(snippet) {
  return /^diff --git /m.test(snippet) || /^@@ -\d+(?:,\d+)? \+\d+/m.test(snippet);
}

// The code a candidate points at can MOVE to another file after the candidate was written (a function extracted into its own module: function-length-fix-ac-10's
// applyBrainDumpSort went from apply-group-a.js to apply-group-a-brain-dump.js; observability-fix-ac-111's report handler went from python/dashboard/app.py into
// python/dashboard/routes/reports.py), leaving the cited file with no anchor at all. Look for the candidate's Snippet in, in order: (1) the SIBLING files of the cited one
// (same directory), then, only if none matched, (2) the whole SUBTREE of the cited file's top-level directory (src/, python/, scripts/, ...). Same extension only, tests and
// vendored/build directories excluded, size and count capped. A tier is accepted only when EXACTLY ONE file matches it (whole snippet, or the prefix/suffix fallback of
// findFuzzyMatch): an ambiguous or missing match is never guessed, and an ambiguous first tier never escalates to the second.
// -> { path (repo-relative), content } | null. Best-effort, never throws.
const RELOCATE_MAX_FILES = 3000;
const RELOCATE_MAX_BYTES = 600000;
const RELOCATE_SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build', 'coverage', '.agent-manager-cache']);

function listCandidateFiles(dir, ext, recursive, budget) {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (budget.left <= 0) return;
      if (e.isDirectory()) { if (recursive && !RELOCATE_SKIP_DIRS.has(e.name)) walk(path.join(d, e.name)); continue; }
      if (!e.isFile() || path.extname(e.name) !== ext || e.name.includes('.test.')) continue;
      budget.left -= 1;
      out.push(path.join(d, e.name));
    }
  };
  walk(dir);
  return out;
}

// A cheap pre-filter: the longest distinctive lines of the snippet; a file containing none of them cannot contain the (even drifted) snippet.
function distinctiveLines(snippet) {
  return snippet.split('\n').map((l) => l.trim()).filter((l) => l.length >= 25).sort((a, b) => b.length - a.length).slice(0, 3);
}

function uniqueMatchIn(files, snippet, root, original, lines) {
  const found = [];
  for (const full of files) {
    if (full === original) continue;
    let content;
    try {
      if (fs.statSync(full).size > RELOCATE_MAX_BYTES) continue;
      content = fs.readFileSync(full, 'utf8');
    } catch { continue; }
    if (lines.length && !lines.some((l) => content.includes(l))) continue;
    if (findFuzzyMatch(content, snippet)) found.push({ path: path.relative(root, full).split(path.sep).join('/'), content });
    if (found.length > 1) return { ambiguous: true };
  }
  return { hit: found.length === 1 ? found[0] : null };
}

function relocateStaleAnchor(repoRoot, relPath, section) {
  try {
    const snippet = snippetFromSection(section);
    if (!snippet || looksLikeDiff(snippet) || !repoRoot || !relPath) return null;
    const root = path.resolve(repoRoot);
    const original = path.resolve(root, relPath);
    if (!original.startsWith(root + path.sep)) return null;
    const ext = path.extname(original);
    const lines = distinctiveLines(snippet);
    const tier1 = uniqueMatchIn(listCandidateFiles(path.dirname(original), ext, false, { left: 500 }), snippet, root, original, lines);
    if (tier1.ambiguous) return null;
    if (tier1.hit) return tier1.hit;
    const top = path.join(root, path.relative(root, original).split(path.sep)[0]);
    if (top === original || !fs.existsSync(top) || !fs.statSync(top).isDirectory()) return null;
    const tier2 = uniqueMatchIn(listCandidateFiles(top, ext, true, { left: RELOCATE_MAX_FILES }), snippet, root, original, lines);
    return tier2.hit || null;
  } catch { return null; }
}

module.exports = { collectAnchorHits, windowFetchedFileContent, relocateStaleAnchor, snippetMissingFrom };
