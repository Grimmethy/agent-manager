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
const { computePremiseEvidence } = require('../candidate-premise-check.js');
const { signatureForClarificationTask } = require('../pipeline-forensics.js');
const { appendHistoryEvent } = require('../task-history.js');
const { readIfExists, quotedSymbolsFromSection, snippetFromSection } = require('./lib/candidate-doc-parsing.js');
const { findFuzzyMatch, windowAroundIndex } = require('./lib/fuzzy-matching.js');
const { collectAnchorHits, windowFetchedFileContent } = require('./lib/file-grounding.js');
const { extractCandidateSignatures, liveSignatureCount, staleSignatureReason, archiveStaleCandidate, nextCandidateFulfillmentTask, SIGNATURE_RE, MAX_ARCH_REVIEW_TASK_CHARS } = require('./lib/candidate-lifecycle.js');

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
// a symbol appearing more than this is too generic to anchor on with real confidence --
// but see collectAnchorHits' rank-3 fallback below: dropping it entirely (the original
// behavior) let observability-fix-ac-111 (2026-09-04) reproduce the exact same 22,000-char
// noise window on every retry, because every other candidate symbol occurred >5 times in
// the real 7333-line file and the ONLY hits left standing were two false positives that
// windowFetchedFileContent then spread across the whole shared budget as if confident.
const MAX_ANCHOR_OCCURRENCES = 5;
const MIN_ANCHOR_SYMBOL_CHARS = 4;

// Backtick-quoted spans in a candidate's Problem/Solution prose -- review-task.js's own
// blockedReason prose already leans on this exact "`identifier`" convention (see
// app.py's _quoted_symbols, same idea, JS side), and arch_review/observability_fix
// candidates write the same way: they quote the actual code symbol or snippet they're
// pointing at ("the `catch (e)` block", "`taskIdExistsInQueue`"), not just a description
// of it.
const QUOTED_SYMBOL_RE = /`([^`]{3,80})`/g;

// 2026-08-27 (Grimmethy: "we should be looking for code content instead of the line
// itself"): a `Snippet:` field, when present, is a deterministic pass-through of the
// REAL code text observability-review.js/performance-review.js/function-length-review.js
// already read at review time to ground their own genuine/false-positive judgment (see
// apply-group-a.js's applyArchDiscoveryCandidates for where this gets written) -- never
// touched by the model, so it doesn't carry the paraphrase risk a quoted-symbol-in-prose
// citation does. Fenced (see that same header for why), so this just extracts what's
// between the fence markers.
const SNIPPET_FIELD_RE = /^Snippet:\s*\n```\n([\s\S]*?)\n```/m;

// Maps an index into stripWhitespace(content) back to the corresponding index in the
// real content, by walking content and counting non-whitespace chars until reaching
// targetStrippedCount of them. O(content.length); fine at this pipeline's file sizes
// (low hundreds of KB at most).
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
// Candidate prose reliably says "at line NNN" / "lines NNN-MMM" even when its own
// backtick-quoted code snippet has drifted from the real file (paraphrased rather than
// copy-pasted -- see windowFetchedFileContent's own header for why that quote match can
// fail). Takes the FIRST number after "line"/"lines" -- a range's start is close enough
// to center a window on, and matches this doc format's own convention of citing the
// start of a block ("lines 1255-1270" for a try, "line 1271" for its catch).
const LINE_CITATION_RE = /\blines?\s+(\d+)/i;

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
const LOW_CONFIDENCE_GROUNDING_NOTE = '[LOW-CONFIDENCE GROUNDING: no reliable anchor found '
  + "for this candidate's cited code -- this window is a best-effort guess and may not "
  + 'contain the real target. If you cannot find the described code here, respond with a '
  + 'clarification request rather than guessing.]\n';

// Returns { text, confidence, anchorCount, usedSnippetFuzzyMatch }. confidence is
// 'strong' (a real rank 0/1/2 hit anchored the window), 'weak' (only the rank-3
// too-generic-to-trust fallback fired), or 'none' (flat head-truncation, no hits at all).
// usedSnippetFuzzyMatch is true only when the frozen candidate Snippet still fuzzy-matches
// the CURRENT file content (rank 0) -- this is the "has grounding gone stale since this
// task was generated" signal context-trim-sweep.js re-checks on every retry.
// Shared by arch_review (candidatesPath=archReviewCandidatesPath) and arch_import_review
// (candidatesPath=archImportCandidatesPath) -- both consume an identically-shaped
// "### AC-NNN · Title / Strength: ... / Files: ..." candidates doc and turn the oldest
// Strong one into a real fulfillment task, differing only in WHICH doc and what `source`
// gets stamped on the resulting task. Was nextArchReviewTask() until ADR-0020's
// arch_import_review needed the exact same logic against a second doc -- parameterized
// instead of copy-pasting a second near-identical function that would inevitably drift
// (see this whole session's running theme of exactly that happening elsewhere).
// Pre-draft premise recheck (2026-09-06, Grimmethy: "a post-op blocked task investigator
// ... surely we already have post op tasks that can sort these better?"). Root incident:
// AC-4 and AC-7 (both pipeline_forensics_fix candidates) each burned multiple full plan/
// implement/review cycles before review finally caught, by hand, that their premise was
// stale -- AC-4's own manual::no-resolution-line cluster had shrunk to ZERO live
// needs-clarification members since it was filed (the safety net it wanted to add had
// already shipped elsewhere); AC-7's proposed retry-on-empty-plan mechanism already
// existed, one file over, in local-client.js. staleness-audit.js's existing invalid-
// premise/already-implemented checks could not have caught either: they only fire when a
// candidate's OWN named files are entirely missing from the repo, or when it asks to
// CREATE something that already exists -- neither AC-4 nor AC-7 named a missing file, and
// neither asked to create anything. This closes that specific gap, cheaply and
// deterministically (no model call), for every candidate-fulfillment source at once:
//
//   1. Signature staleness: a candidate produced by a pipeline_forensics/pipeline_self_
//      audit cluster study often names the real `<source>::<category>` signature that
//      motivated it, in its title or Problem prose (e.g. "the manual::no-resolution-line
//      signature", or a title like "... same signature (manual::fabricated-ungrounded-
//      claim)"). Re-derive the LIVE count of queue/needs-clarification/ tasks that still
//      carry that exact signature (signatureForClarificationTask, the same function
//      pipeline_forensics' own cluster detector uses) -- if it has dropped to zero, the
//      problem this candidate targets no longer exists in the current backlog.
//   2. Citation/prerequisite premise: reuses candidate-premise-check.js's existing,
//      already-tested computePremiseEvidence() verbatim (built for the POST-implement
//      hook) against the candidate's OWN body + the real fetchedFiles this function just
//      read -- a fabricated citation or an unverified "the existing X already..." claim is
//      just as detectable before a draft as after one; nothing about that check depends
//      on implementResponse.
//
// Either hit skips a full draft cycle entirely -- the candidate is filed straight to
// queue/done/_archived_no_action/ (same location/shape a human's manual archive uses,
// full audit trail preserved) instead of ever reaching queue/pending/, and the loop moves
// on to the next candidate in the doc. Never silent: a task-shaped record with a real
// 'archived' history entry lands exactly where a human archiving it by hand would put it,
// so nothing about this is invisible to the dashboard's Done/Archived view.
// Zero live members for EVERY signature this candidate names is unambiguous ("nothing
// left to fix"); a candidate naming no signature at all, or one whose count could not be
// determined (no needs-clarification/ dir), is never flagged by this check -- it has
// nothing to disprove, same "no real claim, no verdict" discipline computePremiseEvidence
// applies to citations.
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
