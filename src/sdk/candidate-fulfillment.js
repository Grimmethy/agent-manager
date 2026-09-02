'use strict';

// The candidate-fulfillment SDK. Everything a task source needs to turn an "### AC-NNN"
// candidates doc (Strength / Files / Problem / Solution / optional Snippet) into ONE
// grounded fulfillment task at a time: parse the doc, pick the oldest actionable Strong
// candidate, read + window its real referenced file content so the implement pass is
// grounded in current reality rather than the candidate's own (possibly stale) prose.
//
// ADR-0022 Stage D: moved verbatim out of task-sources.js. Core SHIPS and DOCUMENTS this
// (see docs/PLUGIN_API.md "SDK helpers") but registers nothing with it -- agent-manager's
// own backlog_fulfillment and the agent-manager-hygiene plugin's arch_review /
// *_fix sources are all just consumers. Also re-exports candidate-docs.js (the AC-NNN
// write side) so a plugin has one import for the whole candidate lifecycle.
//
// taskIdExistsInQueue is a general queue primitive that lives in task-sources.js; it is
// require()d lazily inside nextCandidateFulfillmentTask (never at module load) so this
// module has no load-time dependency on the monolith it was extracted from.

const fs = require('fs');
const path = require('path');
const { getConfig } = require('../config.js');
const candidateDocs = require('../candidate-docs.js');

function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

const MAX_ARCH_REVIEW_TASK_CHARS = 4000;

const MAX_FETCHED_FILE_CHARS = 8000;

// Multi-region grounding (2026-09-02). A single 8000-char window centred on whichever
// symbol the candidate happened to name FIRST left the drafter blind to every other edit
// site a multi-part candidate needs -- root-caused live across the pipeline_forensics_fix
// blocked backlog: "defined the `finalizeResolution` helper but never called it" (ac-6),
// "added `rejectionFeedbackBlock` after `ensureRegistered();` but never wired it into the
// retry path" (ac-8) -- in both the helper-insertion point was in the window and the
// call/teardown site was not. Fix: window EVERY distinct location a candidate points at
// (its Snippet, every backtick-quoted symbol AND all of that symbol's occurrences, a
// cited line), merge overlaps, and emit them in file order joined by `...[gap]...`,
// under a shared total budget so a chatty candidate can't blow the prompt.
const MAX_FETCHED_FILE_TOTAL_CHARS = 22000;
const MIN_REGION_CHARS = 1400;
const MAX_ANCHOR_REGIONS = 5;
const MAX_ANCHOR_OCCURRENCES = 5; // a symbol appearing more than this is too generic to anchor on
const MIN_ANCHOR_SYMBOL_CHARS = 4;

// Backtick-quoted spans in a candidate's Problem/Solution prose -- review-task.js's own
// blockedReason prose already leans on this exact "`identifier`" convention (see
// app.py's _quoted_symbols, same idea, JS side), and arch_review/observability_fix
// candidates write the same way: they quote the actual code symbol or snippet they're
// pointing at ("the `catch (e)` block", "`taskIdExistsInQueue`"), not just a description
// of it.
const QUOTED_SYMBOL_RE = /`([^`]{3,80})`/g;

function quotedSymbolsFromSection(section) {
  return [...(section || '').matchAll(QUOTED_SYMBOL_RE)].map((m) => m[1]).filter(Boolean);
}

// 2026-08-27 (Grimmethy: "we should be looking for code content instead of the line
// itself"): a `Snippet:` field, when present, is a deterministic pass-through of the
// REAL code text observability-review.js/performance-review.js/function-length-review.js
// already read at review time to ground their own genuine/false-positive judgment (see
// apply-group-a.js's applyArchDiscoveryCandidates for where this gets written) -- never
// touched by the model, so it doesn't carry the paraphrase risk a quoted-symbol-in-prose
// citation does. Fenced (see that same header for why), so this just extracts what's
// between the fence markers.
const SNIPPET_FIELD_RE = /^Snippet:\s*\n```\n([\s\S]*?)\n```/m;

function snippetFromSection(section) {
  const m = (section || '').match(SNIPPET_FIELD_RE);
  return m ? m[1] : null;
}

function stripWhitespace(s) {
  return s.replace(/\s+/g, '');
}

// Maps an index into stripWhitespace(content) back to the corresponding index in the
// real content, by walking content and counting non-whitespace chars until reaching
// targetStrippedCount of them. O(content.length); fine at this pipeline's file sizes
// (low hundreds of KB at most).
function realIndexForStrippedIndex(content, targetStrippedCount) {
  let count = 0;
  for (let i = 0; i < content.length; i++) {
    if (count === targetStrippedCount) return i;
    if (!/\s/.test(content[i])) count++;
  }
  return content.length;
}

// Exact match first (fast path, the common case for a snippet that hasn't been touched
// since it was captured). Falls back to a whitespace-tolerant match -- real code
// reformatted by an unrelated change (re-indented, re-wrapped, a stray space added or
// removed) still has the same tokens in the same order, so comparing both sides with ALL
// whitespace stripped finds it without requiring byte-for-byte whitespace to match too
// (a regex that only collapses whitespace the snippet ALREADY had misses a spot where
// formatting ADDED whitespace the snippet never had at all -- confirmed by direct test,
// not just reasoned about). Still fails closed (returns null) on genuinely different
// code, e.g. observability-fix-ac-26's paraphrased `catch (err)` vs the real bare `catch
// {` -- that's a real, accepted gap (see windowFetchedFileContent's own header), not
// something a formatting-only tolerance should try to paper over.
function findFuzzyMatch(content, snippet) {
  const trimmed = (snippet || '').trim();
  if (!trimmed) return null;
  const idx = content.indexOf(trimmed);
  if (idx !== -1) return { index: idx, length: trimmed.length };

  const strippedSnippet = stripWhitespace(trimmed);
  if (!strippedSnippet) return null;
  const strippedContent = stripWhitespace(content);
  const strippedIdx = strippedContent.indexOf(strippedSnippet);
  if (strippedIdx === -1) return null;

  const realStart = realIndexForStrippedIndex(content, strippedIdx);
  const realEnd = realIndexForStrippedIndex(content, strippedIdx + strippedSnippet.length);
  return { index: realStart, length: Math.max(realEnd - realStart, 1) };
}

// Candidate prose reliably says "at line NNN" / "lines NNN-MMM" even when its own
// backtick-quoted code snippet has drifted from the real file (paraphrased rather than
// copy-pasted -- see windowFetchedFileContent's own header for why that quote match can
// fail). Takes the FIRST number after "line"/"lines" -- a range's start is close enough
// to center a window on, and matches this doc format's own convention of citing the
// start of a block ("lines 1255-1270" for a try, "line 1271" for its catch).
const LINE_CITATION_RE = /\blines?\s+(\d+)/i;

function windowAroundIndex(content, idx, matchLen, maxChars) {
  const half = Math.floor(maxChars / 2);
  const from = Math.max(0, idx - half);
  const to = Math.min(content.length, idx + matchLen + half);
  const windowed = content.slice(from, to);
  const prefix = from > 0 ? '...[truncated]...\n' : '';
  const suffix = to < content.length ? '\n...[truncated]' : '';
  return `${prefix}${windowed}${suffix}`;
}

// 2026-08-27 (Grimmethy, investigating a fresh round of blocked observability_fix/
// arch_review tasks after the AC-3 grounding-staleness fix): a flat truncation from byte 0
// -- what this used to be -- routinely cut a large file (task-sources.js is 136KB,
// apply-task.js 35KB) off before the actual catch block / function the candidate names
// ever appeared, especially since MAX_FETCHED_FILE_CHARS is only 8000. Confirmed live via
// observability-fix-ac-9: the candidate named a specific catch block in
// dead-process-check.js, the flat-truncated snapshot cut off before it, and the drafter --
// given no real evidence of where the real target was -- hallucinated an edit to a
// plausible-sounding but nonexistent src/pipeline/processor.js instead.
//
// Fix: same "center the window on the actual thing being discussed" principle
// get-grounding-source.js's extractContentWindow already applies for a cited line number.
// Three anchor strategies, tried in order, strongest first: (1) a `Snippet:` field --
// real code text a scanner/reviewer actually read, never touched by the model, matched
// fuzzily (see findFuzzyMatch) rather than requiring byte-identical text; (2) the
// candidate's own backtick-quoted symbol/snippet FROM PROSE, if it's an exact substring
// of the real file -- weaker than (1) because it's the model's own transcription, which
// can paraphrase (see observability-fix-ac-26 below); (3) a "line NNN" citation from its
// Problem/Solution prose, for when neither code-content anchor matches but the cited line
// number is still close to the real target. Only falls back to flat truncation-from-start
// when NONE of the three are present or match -- same "stale grounding beats no
// grounding" tolerance used elsewhere in this pipeline.
//
// (1) is the durable fix -- (2) and (3) predate it and stay as fallbacks for any
// candidate written before a source carried Snippet: through (or arch_review/
// arch_import_review candidates, which have no scan finding to source one from at all).
// Neither fallback is a guarantee: investigating observability-fix-ac-26 live (created
// before this file's own Snippet: support existed), its quoted `catch (err) { return
// null; }` doesn't match the real bare `catch {` / `return null;` on separate lines
// (quote-match fails, as expected), and its own "at line 1271" citation had drifted ~80
// lines / ~4800 chars from the real target -- just outside this function's half-window
// radius, so that specific candidate still misses even with the line fallback. A citation
// drifted by more than half of MAX_FETCHED_FILE_CHARS from current reality is a real,
// accepted gap for (2)/(3), not something worth chasing with an ever-larger window at the
// cost of every other candidate's prompt size.
// Every distinct index in `content` the candidate `section` points at, strongest anchor
// first: (0) a Snippet: field's fuzzy match; (1) each backtick-quoted prose symbol, at
// EVERY one of its occurrences (a helper name sits at its definition AND its call sites --
// a multi-part candidate needs all of them), unless the symbol is so common it is noise;
// (2) a cited line number. De-duped to one hit per ~200-char neighbourhood.
function collectAnchorHits(content, section) {
  const hits = [];
  const seen = new Set();
  const push = (index, length, rank) => {
    if (index == null || index < 0) return;
    const bucket = Math.round(index / 200);
    if (seen.has(bucket)) return;
    seen.add(bucket);
    hits.push({ index, length: Math.max(length || 0, 1), rank });
  };

  const snippet = snippetFromSection(section);
  if (snippet) {
    const match = findFuzzyMatch(content, snippet);
    if (match) push(match.index, match.length, 0);
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
    if (occ.length === 0 || occ.length > MAX_ANCHOR_OCCURRENCES) continue;
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
  if (content.length <= maxChars) return content;

  const hits = collectAnchorHits(content, section).slice(0, MAX_ANCHOR_REGIONS);
  if (hits.length === 0) {
    return `${content.slice(0, maxChars)}\n...[truncated]`;
  }
  if (hits.length === 1) {
    return windowAroundIndex(content, hits[0].index, hits[0].length, maxChars);
  }

  // Equal share of a shared budget, capped at the single-window size, floored so each
  // window is still worth showing.
  const totalBudget = Math.min(MAX_FETCHED_FILE_TOTAL_CHARS, Math.max(maxChars, content.length));
  const perRegion = Math.max(MIN_REGION_CHARS, Math.min(maxChars, Math.floor(totalBudget / hits.length)));
  const half = Math.floor(perRegion / 2);

  const ranges = hits
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
  return out.join('\n');
}

// Shared by arch_review (candidatesPath=archReviewCandidatesPath) and arch_import_review
// (candidatesPath=archImportCandidatesPath) -- both consume an identically-shaped
// "### AC-NNN · Title / Strength: ... / Files: ..." candidates doc and turn the oldest
// Strong one into a real fulfillment task, differing only in WHICH doc and what `source`
// gets stamped on the resulting task. Was nextArchReviewTask() until ADR-0020's
// arch_import_review needed the exact same logic against a second doc -- parameterized
// instead of copy-pasting a second near-identical function that would inevitably drift
// (see this whole session's running theme of exactly that happening elsewhere).
function nextCandidateFulfillmentTask(candidatesPath, sourceName) {
  // lazy (see module header) -- task-sources.js is fully loaded by the time any
  // next() poll calls this.
  const { taskIdExistsInQueue } = require('../task-sources.js');
  const { defaultDomain } = getConfig();
  const text = readIfExists(candidatesPath);
  if (!text) return null;

  const sections = [];
  let pos = 0;
  while (pos < text.length) {
    const start = text.indexOf('### ', pos);
    if (start === -1) break;

    const nextH2 = text.indexOf('\n## ', start + 3);
    const nextH3 = text.indexOf('\n### ', start + 3);
    let end;
    if (nextH2 !== -1 && nextH3 !== -1) {
      end = Math.min(nextH2, nextH3);
    } else if (nextH2 !== -1) {
      end = nextH2;
    } else if (nextH3 !== -1) {
      end = nextH3;
    } else {
      end = -1;
    }

    const sectionText = end === -1 ? text.slice(start) : text.slice(start, end);
    sections.push(sectionText);
    pos = end === -1 ? text.length : end + 1;
  }

  for (const section of sections) {
    const headingLine = section.split('\n')[0];

    const idMatch = headingLine.match(/AC-\d+/);
    if (!idMatch) continue;
    const candidateId = idMatch[0];

    const strengthMatch = section.match(/^Strength:\s*(.+)$/m);
    if (!strengthMatch || strengthMatch[1].trim() !== 'Strong') continue;

    if (section.length > MAX_ARCH_REVIEW_TASK_CHARS) continue;

    // 2026-08-24 -- caught live: a real task (arch-review-ac-10, "AC-10 · Example
    // candidate", Files: foo.js) sat permanently un-completable for weeks, repeatedly
    // bulk-requeued on the assumption it was a "crash-bug casualty" rather than ever
    // having its own content re-examined -- its Problem/Solution sections were literally
    // "Problem: ...\nSolution: ..." (an unfilled template placeholder), not a real
    // finding. Traced to a real, if narrow, gap: this function has always trusted ANY
    // "Strength: Strong" section as actionable with no check that its content is real.
    // Deliberately NOT rejecting on "no referenced files exist" (see fetchedFiles'
    // own comment below -- a candidate proposing a genuinely NEW file is a valid,
    // intended shape, not a stale one) -- an ellipsis-only Problem/Solution body is a
    // much more specific, unambiguous signal: no real LLM-drafted finding ever produces
    // literally just "..." as its entire problem or solution description, regardless of
    // whether the files it names exist yet.
    const problemMatch = section.match(/^Problem:\s*\n?([\s\S]*?)(?=\n(?:Solution|Benefits):|$)/m);
    const solutionMatch = section.match(/^Solution:\s*\n?([\s\S]*?)(?=\nBenefits:|$)/m);
    const isPlaceholderBody = (m) => !m || m[1].trim() === '' || /^\.{3,}$/.test(m[1].trim());
    if (isPlaceholderBody(problemMatch) || isPlaceholderBody(solutionMatch)) continue;

    const taskId = sourceName.replace(/_/g, '-') + '-' + candidateId.toLowerCase();
    if (taskIdExistsInQueue(taskId)) continue;

    const titleMatch = headingLine.match(/AC-\d+\s*·\s*(.+)/);
    const titleText = (titleMatch ? titleMatch[1] : headingLine.replace(/^###\s*/, '')).trim();

    let filesArray = [];
    const filesMatch = section.match(/^Files:\s*(.+)$/m);
    if (filesMatch) {
      filesArray = filesMatch[1].split(',').map((f) => f.trim());
    }

    // 2026-09-02: the `Files:` line is frequently incomplete -- a candidate whose Solution
    // says "call `buildPlanPrompt` with a second arg" needs prompts.js in view to see that
    // function's real signature, but only lists local-draft.js (pipeline-forensics-fix-ac-7
    // /-ac-14). Also read any repo-relative source path the Problem/Solution prose names
    // into fetchedFiles (NOT into `files` -- those stay the candidate's declared edit
    // targets, which the review/decompose gates count against), so the drafter can ground
    // a cross-file change instead of editing blind or refusing.
    const contextFiles = [...new Set(
      [...section.matchAll(/(?<![\w/.-])((?:src|python|scripts|lib)\/[\w./-]+\.(?:js|ts|py|mjs|cjs))\b/g)].map((m) => m[1]),
    )].filter((p) => !filesArray.includes(p)).slice(0, 3);

    // Grounding fix (2026-08-21, confirmed live: observability-fix-ac-5 fabricated a
    // plausible-but-wrong `find` string -- "catch { return []; }" -- that matched nothing
    // in the real file, because this candidate's own implement pass was never shown real
    // file content, only its own prose write-up from whenever the candidate was originally
    // drafted, possibly hours or days earlier by a different pass entirely. Every OTHER
    // fulfillment-style source (arch_import, pipeline_self_audit) grounds its implement
    // pass in real, freshly-read file content; this generic consumer -- shared by
    // arch_review, arch_import_review, observability_fix, performance_fix, and
    // backlog_fulfillment all at once -- never did. Unlike arch_import's own harness
    // grounding (which has to SEARCH for candidate files because it doesn't know them yet),
    // this already knows exactly which files from the candidate's own "Files:" line, so no
    // search step is needed -- just read them, best-effort. A file that doesn't exist
    // (a candidate proposing a brand-new file, or a stale/illustrative path) is not an
    // error -- see fetchedFiles' own promptContext field, which the implement prompt is
    // told explicitly means "ground a create, or flag the mismatch, don't invent content."
    const { repoRoot } = getConfig();
    const readWindowed = (relPath, isContext) => {
      try {
        const full = path.resolve(repoRoot, relPath);
        if (!full.startsWith(path.resolve(repoRoot) + path.sep) && full !== path.resolve(repoRoot)) return null;
        const content = fs.readFileSync(full, 'utf8');
        const entry = { path: relPath, content: windowFetchedFileContent(content, section) };
        if (isContext) entry.context = true; // referenced in prose, not a declared edit target
        return entry;
      } catch {
        return null; // doesn't exist / unreadable -- not an error, see comment above
      }
    };
    const declaredFetched = filesArray.map((p) => readWindowed(p, false)).filter(Boolean);
    const contextFetched = contextFiles.map((p) => readWindowed(p, true)).filter(Boolean);
    const fetchedFiles = [...declaredFetched, ...contextFetched];

    // Path-hallucination guard (2026-08-26, Grimmethy: "Can we answer why it didn't get
    // correct files to begin with?" -- arch-review-ac-7 investigation). Same shape as the
    // isPlaceholderBody skip above (a real, precedented gap: arch-review-ac-10 sat
    // permanently un-completable for weeks because this function trusted ANY
    // "Strength: Strong" section as actionable with no check its content was real) but for
    // the "Files:" line instead of the Problem/Solution body. Confirmed live: AC-7 listed
    // 5 files (none with a directory prefix, two -- resolveGraphPath.js/getConfig.js --
    // not real files at all, both actually live together in src/config.js) despite
    // archReviewImplementPrompt's own explicit instruction to copy paths exactly as given
    // -- the model just didn't follow it. Every one of the 5 silently failed to resolve
    // above, leaving fetchedFiles empty, and the task was queued anyway, doomed to the same
    // "no real implementation code" degenerate/blocked cycle every single pass. Deliberately
    // NOT skipping on filesArray.length === 1 with zero fetchedFiles -- see this function's
    // own comment above: a candidate proposing ONE genuinely brand-new file is a valid,
    // intended shape (fetchedFiles' own promptContext meaning is "ground a create, or flag
    // the mismatch"). Multiple listed files where NONE resolve is a much stronger signal --
    // no real architectural finding proposes touching several already-existing-sounding
    // files that are ALL, simultaneously, brand new.
    if (filesArray.length >= 2 && declaredFetched.length === 0) continue;

    // Deterministic, one-level candidate pre-split (2026-09-02). A candidate declaring >=2
    // files, or laying out >=3 numbered edit steps in its Solution, is more than the local
    // 27B reliably lands in a single diff (pipeline-forensics-fix-ac-1/-ac-14 blocked+
    // exhausted exactly this way). `mustPreSplit` tells the implement pass to decompose it
    // into single-concern sub-candidates FIRST. Every sub-candidate the split writes back
    // carries `Split-Depth: 1`; this reader refuses to pre-split anything already at depth
    // >= 1, a hard recursion stop that does NOT depend on the model's judgement (the earlier
    // model-driven re-split went infinite -- AC-4..AC-12, 2026-09-01).
    const depthMatch = section.match(/^Split-Depth:\s*(\d+)\s*$/m);
    const splitDepth = depthMatch ? Number(depthMatch[1]) : 0;
    // Count numbered steps off the raw section (the Solution-only capture above stops at
    // the first end-of-line under /m, so it can't be used for this).
    const solutionSlice = section.split(/^Solution:/m)[1] ? section.split(/^Solution:/m)[1].split(/^Benefits:/m)[0] : '';
    const numberedSteps = (solutionSlice.match(/(?:^|\n)\s*\d+[.)]\s+\S/g) || []).length;
    const mustPreSplit = splitDepth === 0 && (filesArray.length >= 2 || numberedSteps >= 3);

    return {
      id: taskId,
      domain: defaultDomain,
      source: sourceName,
      title: `${candidateId} · ${titleText}`,
      promptContext: {
        candidateId,
        title: titleText,
        files: filesArray,
        fetchedFiles,
        body: section,
        splitDepth,
        mustPreSplit,
      },
    };
  }

  return null;
}

module.exports = {
  ...candidateDocs,
  nextCandidateFulfillmentTask,
  windowFetchedFileContent,
  // lower-level helpers, exported for the plugin's own grounding tests
  findFuzzyMatch,
  windowAroundIndex,
  collectAnchorHits,
  snippetFromSection,
  quotedSymbolsFromSection,
  MAX_FETCHED_FILE_CHARS,
  MAX_ARCH_REVIEW_TASK_CHARS,
};
