'use strict';

// Brownfield product_spec assembly primitives (2026-08-30 redesign). Brownfield mode no
// longer runs a subscription-agent pass over the whole spec; it decomposes the request
// into an ordered list of `### AC-NNN` section candidates (product_spec_outline, reusing
// the backlog_decomposition machinery) and then drafts each section one at a time on the
// LOCAL model (product_spec_section, a candidate-fulfillment consumer).
//
// The assembled artifact is a single `Docs/PRODUCT_SPEC.md`. To let independent,
// possibly-concurrent section tasks each write into that one file without stepping on each
// other, the outline generator's apply pre-seeds the doc as an ORDERED skeleton in which
// every section is a paired-comment-marker block:
//
//   <!-- section:AC-3 -->
//   ## Some Section Title
//
//   _(pending)_
//   <!-- /section:AC-3 -->
//
// Each section-fulfiller emits ONE Group-B `edit` whose `find` is that exact block
// (pendingBlock) and whose `replace` is the same block with the prose filled in
// (filledBlock). Different sections touch DISJOINT byte ranges of the file, so their
// branches merge cleanly regardless of order, the doc order is fixed by the skeleton, and
// `find` is four short lines the model just copies -- never the "echo back the whole
// document" failure mode.
//
// pendingBlock() is the single source of truth for that anchor string: the skeleton
// writer (buildSkeleton, here) and the section implement prompt (prompts.js) BOTH derive
// their block text from it, so the `find` the model is told to use is byte-identical to
// what actually sits in the doc.

const fs = require('fs');
const path = require('path');
const { writeAtomicSync } = require('./atomic-write.js');
const { applyArchDiscoveryCandidates, parseArchDiscoveryCandidates } = require('./candidate-docs.js');

const SPEC_DOC_TITLE = '# Product Specification';
const OUTLINE_DOC_TITLE = '# Product Spec Outline';
const SPEC_PENDING_PLACEHOLDER = '_(pending)_';

// A section title is always a single line by construction (parseArchDiscoveryCandidates
// takes it from the heading line only). Still normalize defensively so the skeleton block
// and the section prompt's `find` can never diverge on whitespace, and so a stray `-->`
// in a model-written title can't be confused with a marker's close. Applied INSIDE
// pendingBlock/filledBlock so every call site normalizes identically.
function sanitizeTitle(raw) {
  const s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').replace(/-->/g, '→').trim();
  return s || 'Untitled';
}

function sectionMarkers(candidateId) {
  return { open: `<!-- section:${candidateId} -->`, close: `<!-- /section:${candidateId} -->` };
}

// The `find` anchor: an un-drafted section, exactly as buildSkeleton writes it.
function pendingBlock(candidateId, title) {
  const { open, close } = sectionMarkers(candidateId);
  return `${open}\n## ${sanitizeTitle(title)}\n\n${SPEC_PENDING_PLACEHOLDER}\n${close}`;
}

// The `replace`: same markers and heading, prose swapped in for the placeholder. Keeps the
// markers so a re-run's pendingBlock `find` no longer matches (the `_(pending)_` line is
// gone) -- a section can't be double-drafted.
function filledBlock(candidateId, title, body) {
  const { open, close } = sectionMarkers(candidateId);
  return `${open}\n## ${sanitizeTitle(title)}\n\n${String(body == null ? '' : body).trim()}\n${close}`;
}

// candidates: [{ id: 'AC-3', title: '...' }] in the order they should appear in the doc.
function buildSkeleton(candidates) {
  const blocks = (candidates || []).map((c) => pendingBlock(c.id, c.title));
  return [SPEC_DOC_TITLE, '', ...blocks.flatMap((b) => [b, ''])].join('\n').trimEnd() + '\n';
}

// Registered as product_spec_outline's `apply`. Appends the section candidates to the
// outline doc (the generic AC-NNN writer, unchanged) AND, only if the spec doc does not
// exist yet, seeds it with the ordered marker skeleton. A re-decomposition against an
// already-existing spec deliberately does NOT touch the skeleton for now -- that path
// (merging a fresh outline into a partly-written spec) is out of scope for v1.
function applyProductSpecOutline({ implementResponse, candidatesPath, specPath }) {
  const res = applyArchDiscoveryCandidates({ implementResponse, candidatesPath, docTitle: OUTLINE_DOC_TITLE });
  if (res.skipped) return res; // empty outline -> emptyApproval auto-approves; no skeleton

  const files = [candidatesPath];
  if (!fs.existsSync(specPath)) {
    // parseArchDiscoveryCandidates here returns the SAME candidate list, in the SAME
    // order, that applyArchDiscoveryCandidates just iterated to assign res.candidateIds --
    // so candidateIds[i] pairs with parsed[i].title, and that title is byte-identical to
    // what nextCandidateFulfillmentTask will later read back as promptContext.title.
    const parsed = parseArchDiscoveryCandidates(implementResponse);
    const pairs = res.candidateIds.map((id, i) => ({ id, title: (parsed[i] && parsed[i].title) || id }));
    fs.mkdirSync(path.dirname(specPath), { recursive: true });
    writeAtomicSync(specPath, buildSkeleton(pairs));
    files.push(specPath);
  }
  return { ...res, files };
}

module.exports = {
  SPEC_DOC_TITLE,
  OUTLINE_DOC_TITLE,
  SPEC_PENDING_PLACEHOLDER,
  sanitizeTitle,
  sectionMarkers,
  pendingBlock,
  filledBlock,
  buildSkeleton,
  applyProductSpecOutline,
};
