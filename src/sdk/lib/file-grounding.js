'use strict';

const fs = require('fs');
const path = require('path');
const { snippetFromSection, quotedSymbolsFromSection, stripWhitespace, realIndexForStrippedIndex } = require('./candidate-doc-parsing.js');
const { findFuzzyMatch, windowAroundIndex, MIN_PARTIAL_CHARS } = require('./fuzzy-matching.js');

// Same literals as src/sdk/candidate-fulfillment.js (the source these were moved out of)
// -- duplicated here rather than required back, so this module stays self-contained.
const SNIPPET_FIELD_RE = /^Snippet:\s*\n```\n([\s\S]*?)\n```/m;
const MIN_ANCHOR_SYMBOL_CHARS = 4;
const MAX_ANCHOR_OCCURRENCES = 5;
const LINE_CITATION_RE = /\blines?\s+(\d+)/i;
const MAX_FETCHED_FILE_CHARS = 8000;
const MAX_ANCHOR_REGIONS = 5;
// Anchors for code the candidate QUOTES at length (2026-10-04, arch-review-ac-42): a backtick span of more than QUOTED_SYMBOL's 80 chars is a code statement, not a
// symbol, so quotedSymbolsFromSection never anchored on it and the window missed the very statement the candidate edits (the file's last line). Its first
// LONG_SPAN_PREFIX_CHARS chars locate it. Rank 0.5 sorts it ahead of the quoted symbols (rank 1) so the MAX_ANCHOR_REGIONS cap cannot drop it, and it is not rank 0,
// which usedSnippetFuzzyMatch tests.
const LONG_SPAN_MIN_CHARS = 81;
const LONG_SPAN_MAX_CHARS = 400;
const LONG_SPAN_PREFIX_CHARS = 60;
const LONG_SPAN_MIN_STRIPPED_CHARS = 30; // the prefix without whitespace must still be distinctive
const LONG_SPAN_RANK = 0.5;
// A section that says where in the file the change goes ("ends with", "at the end of the file") but quotes nothing locatable. Narrower than task-anchor-files.js's
// WINDOW_TAIL_CUES on purpose: that one also matches a bare "append", and a bare "ends with" / "last line" ("the gap between last line read and ...") is ordinary prose, so only phrases that
// name a position in the FILE count.
const TAIL_CUE_RE = /\b(?:(?:at|to|near) the (?:very )?(?:bottom|end) of (?:the )?file|(?:end|bottom) of (?:the )?file|file(?:'s)? (?:last|final) (?:line|statement)|(?:last|final) (?:line|statement) of (?:the )?file|file ends with)\b/i;
const TAIL_ANCHOR_CHARS = 200;
const MIN_CONFIDENT_PARTIAL_FRACTION = 0.3; // findPartialMatch tries 0.75, 0.5, 0.35, 0.25, 0.15 of the snippet: the two smallest tiers are the weak guesses
const MAX_FETCHED_FILE_TOTAL_CHARS = 22000;
const MIN_REGION_CHARS = 1400;
const LOW_CONFIDENCE_GROUNDING_NOTE = '[LOW-CONFIDENCE GROUNDING: no reliable anchor found '
  + "for this candidate's cited code -- this window is a best-effort guess and may not "
  + 'contain the real target. If you cannot find the described code here, respond with a '
  + 'clarification request rather than guessing.]\n';

// Backtick spans of LONG_SPAN_MIN_CHARS..LONG_SPAN_MAX_CHARS, paired line by line (1st with 2nd backtick, 3rd with 4th, ...), so the closing backtick of one short
// span and the opening backtick of the next cannot pair up and turn the prose between them into a fake "span".
function longQuotedSpans(prose) {
  const spans = [];
  for (const line of String(prose || '').split('\n')) {
    const ticks = [];
    for (let i = line.indexOf('`'); i !== -1; i = line.indexOf('`', i + 1)) ticks.push(i);
    for (let k = 0; k + 1 < ticks.length; k += 2) {
      const span = line.slice(ticks[k] + 1, ticks[k + 1]).trim();
      if (span.length >= LONG_SPAN_MIN_CHARS && span.length <= LONG_SPAN_MAX_CHARS) spans.push(span);
    }
  }
  return spans;
}

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

  // Whitespace-insensitive, like the Snippet match: a candidate quotes a statement flattened onto one line (`main().catch(...)`) that the file lays out over several.
  let strippedContent = null;
  for (const span of longQuotedSpans(prose)) {
    const needle = stripWhitespace(span.slice(0, LONG_SPAN_PREFIX_CHARS));
    if (needle.length < LONG_SPAN_MIN_STRIPPED_CHARS) continue;
    if (strippedContent === null) strippedContent = stripWhitespace(content);
    const occ = [];
    for (let from = 0; ;) {
      const i = strippedContent.indexOf(needle, from);
      if (i === -1 || occ.length > MAX_ANCHOR_OCCURRENCES) break;
      occ.push(i);
      from = i + needle.length;
    }
    // Nowhere in the file, or too generic to place anything: ignore it (never the rank-3 single-window fallback quoted symbols get).
    if (occ.length === 0 || occ.length > MAX_ANCHOR_OCCURRENCES) continue;
    for (const i of occ) push(realIndexForStrippedIndex(content, i), span.length, LONG_SPAN_RANK);
  }

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

  // Pushed LAST so a real anchor near the end of the file keeps its own bucket. A tail hit only positions a window next to real anchors (see windowFetchedFileContent):
  // it is never evidence that the cited code was found.
  if (TAIL_CUE_RE.test(prose) && content.length > TAIL_ANCHOR_CHARS) push(content.length - TAIL_ANCHOR_CHARS, TAIL_ANCHOR_CHARS, LONG_SPAN_RANK, { tailCue: true });

  return hits.sort((a, b) => a.rank - b.rank || a.index - b.index);
}

// Which anchors get a region (2026-10-04, arch-review-ac-52): the cap used to be `hits.slice(0, MAX_ANCHOR_REGIONS)` on hits sorted by (rank, index), i.e. the FIVE EARLIEST hits, so anchors packed
// into the top of a 20k-char file used up every slot and the real edit sites further down were never shown (203 of 408 candidate section/file pairs had more than five anchors, and in 158 one lay
// outside the window). Each pick shows the file from `half` before it to `half` after it, so with more than MAX_ANCHOR_REGIONS hits this chooses, greedily, the hit whose window covers the most
// remaining anchors (a protected rank-0 / rank-0.5 hit counts PROTECTED_HIT_WEIGHT, a quoted symbol 1, a cited line 0.5), removes what that window covers, and repeats. Ties keep the (rank, index)
// order, so when no two hits are within a window of each other the picks equal the old first five; with the cap or fewer hits the array is returned untouched. The picks come back sorted by
// (rank, index) so hits[0] still means "the best hit". (Clustering hits by distance first was tried and rejected: hits a little under a window apart chain into ONE cluster, and picking inside it
// by position is the old bug again.)
const PROTECTED_HIT_WEIGHT = 1000;
function selectAnchorHits(hits, maxChars, contentLength) {
  if (hits.length <= MAX_ANCHOR_REGIONS) return hits;
  const totalBudget = Math.min(MAX_FETCHED_FILE_TOTAL_CHARS, Math.max(maxChars, contentLength));
  const half = Math.floor(Math.max(MIN_REGION_CHARS, Math.min(maxChars, Math.floor(totalBudget / MAX_ANCHOR_REGIONS))) / 2);
  const byRankIndex = (a, b) => a.rank - b.rank || a.index - b.index;
  const weight = (h) => (h.rank < 1 ? PROTECTED_HIT_WEIGHT : h.rank === 1 ? 1 : 0.5);
  let remaining = [...hits].sort(byRankIndex);
  const picks = [];
  while (picks.length < MAX_ANCHOR_REGIONS && remaining.length > 0) {
    let best = null;
    let bestWeight = -1;
    for (const c of remaining) {
      let w = 0;
      for (const h of remaining) if (Math.abs(h.index - c.index) <= half) w += weight(h);
      if (w > bestWeight) { best = c; bestWeight = w; }
    }
    picks.push(best);
    remaining = remaining.filter((h) => Math.abs(h.index - best.index) > half);
  }
  return picks.sort(byRankIndex);
}

function windowFetchedFileContent(content, section, maxChars = MAX_FETCHED_FILE_CHARS) {
  if (content.length <= maxChars) {
    return { text: content, confidence: 'strong', anchorCount: 0, usedSnippetFuzzyMatch: false };
  }

  const collected = collectAnchorHits(content, section);
  // A tail-cue hit only places a region NEXT TO a real anchor; with none it is dropped and today's weak/none paths run unchanged, so a cue can never turn 'none' or
  // 'weak' into 'strong' (known-fixed-failures, blocked-task-classifiers and reject-retry-check all key on the confidence).
  const allHits = collected.some((h) => h.rank < 3 && !h.tailCue) ? collected : collected.filter((h) => !h.tailCue);
  const usedSnippetFuzzyMatch = allHits.some((h) => h.rank === 0);
  const strongHits = selectAnchorHits(allHits.filter((h) => h.rank < 3), maxChars, content.length);
  const realStrongHits = strongHits.filter((h) => !h.tailCue);

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
  if (realStrongHits.every((h) => h.weakPartial)) {
    return {
      text: LOW_CONFIDENCE_GROUNDING_NOTE + windowAroundIndex(content, realStrongHits[0].index, realStrongHits[0].length, maxChars),
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
  return { text: out.join('\n'), confidence: 'strong', anchorCount: realStrongHits.length, usedSnippetFuzzyMatch };
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
// vendored/build directories excluded, size and count capped. A tier is accepted only when EXACTLY ONE file matches it, and only on the WHOLE snippet (never findFuzzyMatch's prefix/suffix
// fallback): an ambiguous or missing match is never guessed, and an ambiguous first tier never escalates to the second.
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
    // WHOLE snippet only (whitespace drift allowed, no prefix/suffix fallback): a unique 120-char prologue or tail in an unrelated file (a shared import block, a common
    // signature) is a coincidence, not the place the code moved to, and following it would rewrite the declared edit target (review of PR #437).
    const m = findFuzzyMatch(content, snippet);
    if (m && !m.partial) found.push({ path: path.relative(root, full).split(path.sep).join('/'), content });
    if (found.length > 1) return { ambiguous: true };
  }
  return { hit: found.length === 1 ? found[0] : null };
}

function relocateStaleAnchor(repoRoot, relPath, section) {
  try {
    const snippet = snippetFromSection(section);
    if (!snippet || looksLikeDiff(snippet) || !repoRoot || !relPath) return null;
    // A short snippet is not distinctive enough to follow: two lines like `def f():\n    return 1` occur in any sibling (caught by local-draft.test.js: a deleted file's entry was
    // relocated to a neighbour on exactly that). Same floor findFuzzyMatch's partial fallback uses.
    if (snippet.replace(/\s+/g, '').length < MIN_PARTIAL_CHARS) return null;
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

module.exports = { collectAnchorHits, windowFetchedFileContent, relocateStaleAnchor, snippetMissingFrom, selectAnchorHits };
