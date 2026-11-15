'use strict';

// Helpers the deterministic review gates of runReview use (roadmap step 1, piece P6.4a): which sources are empty-approval or advisory-prose, the
// relocation check, the script-extract and one-pass-decompose re-derivation hooks, the non-implementation patterns, the Group B content decoder and
// the extracted-pieces test. Moved out of review-task.js unchanged; review-task.js imports them and still exports the names it exported before.

const fs = require('fs');
const path = require('path');
const { parseJsonMaybeFenced } = require('./json-fence.js');
const { changedFilesOfDiff } = require('./lib/draft-side-effects.js');
const { getRegisteredSource } = require('./task-source-registry.js');
const { verifyDeterministicDraft } = require('./decompose-review-registry.js');

// Deterministic empty-approve: several task sources' implement prompts explicitly ask for
// the empty string when there's genuinely nothing to change (see prompts.js), a legitimate
// approved outcome at review time -- and (2026-08-22/23) some are further exempted from
// the isNonImplementation gate below (NON_IMPL_PATTERNS / the <80-char-no-code-fence
// heuristic, written assuming every draft is code) because their OWN valid deliverable
// can be a short advisory prose verdict instead -- a real "false positive, here's why"
// paragraph, or staleness_audit's own short "nothing new to add here" report, would
// otherwise trip the same false-positive-for-refusal heuristic.
//
// 2026-08-23 (Grimmethy: "What else needs to be moved in order to properly modularize
// the maintenance tasks?"): both used to be hardcoded arrays here, duplicated ALMOST
// verbatim as local-draft.js's own allowEmptyImplement/CANDIDATE_FULFILLMENT_SOURCES --
// confirmed live, EMPTY_APPROVAL_SOURCES and allowEmptyImplement were the exact same 11
// names, a duplicate-list bug class waiting to happen (add a source to one, forget the
// other). Now read directly off each source's own registerTaskSource() entry
// (emptyApproval/advisoryProse flags) instead -- the actual prerequisite a plugin needed
// to add a new maintenance source without editing this file at all; see
// function-length-review.js's own registration for the pattern.
function isEmptyApprovalSource(source) {
  const entry = getRegisteredSource(source);
  return !!(entry && entry.emptyApproval);
}

function isAdvisoryProseSource(source) {
  const entry = getRegisteredSource(source);
  return !!(entry && entry.advisoryProse);
}

function isEffectivelyEmpty(trimmed) {
  return trimmed === '' || trimmed === '""' || trimmed === "''";
}

// HUB0090 · 2/2 · review-time relocation-validation (sibling of HUB0091's draft-time
// grounding-refresh fallback in local-draft.js -- that one re-fetches BEFORE drafting,
// this one forgives at review time): the ungrounded-url/ungrounded-field deterministic
// gate compares the draft's symbols against the frozen fetchedFiles window, but that
// window is a truncated slice (AC-61; see arch-import-premise-check.js's 2026-09-18
// comment) and the draft may legitimately edit a file OUTSIDE the frozen list -- e.g. a
// symbol moved by a decompose that landed after the frozen snapshot was taken. Before
// that gate auto-rejects, check per flagged target symbol: (a) does the frozen file at
// CURRENT HEAD still contain it (re-fetched whole, past the window) -- if yes the symbol
// was only truncated out of the window, not missing; (b) if the frozen file lacks it but
// the file the draft is actually editing contains it -- the draft is a valid relocation.
// Either way the gate is not disqualifying and the draft goes on to the normal vote.
// Conservative on purpose: a symbol found in NEITHER the frozen file at HEAD nor any of
// the draft's own files stays flagged and the original auto-reject runs unchanged.
function readRepoFileAtHead(repoRoot, relPath) {
  try { return fs.readFileSync(path.resolve(repoRoot, relPath), 'utf8'); }
  catch { return null; } // file gone at HEAD (deleted/renamed) -- caller treats as "lacks symbol"
}

function validateRelocatedDraftSymbols(task, flags, repoRoot) {
  const draftFiles = [...new Set(changedFilesOfDiff((task && task.rawDiff) || ''))];
  const frozenFiles = (((task && task.promptContext) || {}).fetchedFiles) || [];
  const frozen = Array.isArray(frozenFiles) ? frozenFiles.filter((f) => f && typeof f.path === 'string') : [];
  const validated = [];
  const remaining = [];
  for (const flag of flags) {
    const symbol = (flag && typeof flag.detail === 'string' && flag.detail) || null;
    if (!symbol) { remaining.push(flag); continue; }
    let hit = null;
    for (const f of frozen) {
      // AC-61 variant: fetchedFiles[].context is a windowed, truncated slice of each
      // file -- "does the frozen file still contain the symbol" must be answered against
      // the file at current HEAD, so re-fetch the whole file when the window lacks it.
      const inWindow = typeof f.context === 'string' && f.context.includes(symbol);
      const frozenFull = inWindow ? '(window)' : readRepoFileAtHead(repoRoot, f.path);
      if (frozenFull === '(window)' || (frozenFull !== null && frozenFull.includes(symbol))) {
        hit = { type: flag.type, symbol, frozenFile: f.path, draftFile: null, ac61Refetch: frozenFull !== '(window)', note: 'symbol present in the frozen file (outside the truncated window)' };
        break;
      }
      // Relocation: frozen file LACKS the symbol at HEAD while the draft's own edited
      // file CONTAINS it -- pass the gate, don't auto-reject.
      const draftFile = draftFiles.find((d) => {
        const content = readRepoFileAtHead(repoRoot, d);
        return content !== null && content.includes(symbol);
      });
      if (draftFile) {
        hit = { type: flag.type, symbol, frozenFile: f.path, draftFile, ac61Refetch: true, note: 'symbol absent from the frozen file at HEAD but present in the draft\'s own file -- valid relocation' };
        break;
      }
    }
    if (hit) validated.push(hit); else remaining.push(flag);
  }
  return { validated, remaining };
}

// Deterministic review gate for a script-extract decompose move (see local-draft.js's
// tryDeterministicScriptExtractEdit). Real incident, 2026-09-07: the implement pass
// already re-verifies every symbol via a real V8-parser oracle before constructing the
// diff -- there is no judgment call left for a model to make -- but the diff itself can
// be far too large for the review model's own context window to hold at all. Confirmed
// live: a real 26-symbol move produced a 600,794-char implementResponse (~200K tokens)
// against this pipeline's 16,384-token PINNED_NUM_CTX -- the reviewer never actually saw
// the real content and hallucinated "the draft is empty, no IMPLEMENT diff." Re-deriving
// the expected extraction fresh from CURRENT repo state and requiring an exact byte
// match is a strictly STRONGER guarantee than an LLM skim of a diff it can't even fit in
// context -- same "don't ask a model to verify what code can verify with certainty"
// principle as this pipeline's other deterministic gates just above/below this one.
// Deterministic-review hook (S4a of the hub-tasks extraction, 2026-09-24): the actual
// re-derivation/byte-compare logic (all the reasoning above about WHY this gate exists
// still applies) now lives in script-extract.js's own registerDeterministicReview call --
// see decompose-review-registry.js's header. This file only gates on the kind and
// dispatches, so it never needs script-extract.js's implementation, only whatever
// registered against 'script-extract'.
function verifyDeterministicScriptExtractDraft(task, repoRoot, groundingRef) {
  const ctx = task.promptContext;
  if (!(ctx && ctx.deterministicApply === 'script-extract')) return null;
  return verifyDeterministicDraft(task, repoRoot, groundingRef);
}

// Same principle as verifyDeterministicScriptExtractDraft above, for a WHOLE fully-
// mechanical file-decompose filed as one deterministic task ([[hub-task-integration]]):
//   deterministicApply='one-pass-decompose'  -> HTML, decompose-one-pass.js
//   deterministicApply='node-module-decompose' -> src/*.js, decompose-node-module.js
//   deterministicApply='blueprint-decompose' -> Flask blueprint, decompose-flask-blueprint.js
// Deterministic-review hook (S4a of the hub-tasks extraction, 2026-09-24): the shared
// re-derivation/byte-compare logic (verifyOnePassStyleRederivation) and each kind's own
// `rebuild` registration now live in decompose-review-registry.js / each producer's own
// file -- see their headers. This file only gates on the kind and dispatches.
function verifyDeterministicOnePassDecomposeDraft(task, repoRoot) {
  const kind = task.promptContext && task.promptContext.deterministicApply;
  if (kind !== 'one-pass-decompose' && kind !== 'node-module-decompose' && kind !== 'blueprint-decompose') return null;
  return verifyDeterministicDraft(task, repoRoot);
}

// The mode:"read" tool-call request is matched structurally by looksLikeReadToolCall (lib/structured-change.js), not by a bare
// regex: a diff that merely mentions the string must not be rejected as a tool call.
const NON_IMPL_PATTERNS = [
  /^(let me|i need to|i will|i'll|i am going to|i'm going to)\s+(read|check|look at|search|verify|examine|understand)\b/i,
];

function decodeGroupBContent(implementResponse) {
  try {
    const parsed = parseJsonMaybeFenced(implementResponse);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const parts = [];
    for (const item of items) {
      if (item && typeof item.content === 'string') parts.push(item.content);
      if (item && typeof item.find === 'string') parts.push(item.find);
      if (item && typeof item.replace === 'string') parts.push(item.replace);
    }
    return parts.join('\n \n');
  } catch (e) {
    return '';
  }
}

function decodeGroupBContent(implementResponse) {
  try {
    const parsed = parseJsonMaybeFenced(implementResponse);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const parts = [];
    for (const item of items) {
      if (item && typeof item.content === 'string') parts.push(item.content);
      if (item && typeof item.find === 'string') parts.push(item.find);
      if (item && typeof item.replace === 'string') parts.push(item.replace);
    }
    return parts.join('\n \n');
  } catch (e) {
    return '';
  }
}

// Thin wrapper over runReview: keeps task.status in step with the verdict (and so with the
// queue directory review-runner.sh moves the file to next -- approved/ or blocked/). Only
// local-draft.js was ever maintaining task.status ('needs-review'), so every approved task
// kept that stale value and the dashboard list view -- which reads task.status straight
// through task_summary() -- showed the whole approved/ backlog as "needs-review". The
// verdict strings ('approved' / 'blocked') are already exactly the status values we want.
// 2026-11-02 (stalled-task loop: 53 function_length_review candidates parked on missing-code-diff after ~4.4 drafts each): the deliverable for extracting pieces of a long function is the
// NAMED pieces, and the local model will not write a code block for a 500-line extraction. A Solution that names at least two distinct new identifiers (camelCase or snake_case, optionally
// with a leading underscore, longer than five characters) states the concrete change; a Solution that only says "split it into smaller helper functions" does not. Replay over the 53 parked
// drafts: 45 name pieces, 8 are prose-only and stay blocked.
const NAMED_PIECE_RE = /\b_?(?:[a-z]+(?:[A-Z][a-z0-9]+)+|[a-z]+(?:_[a-z0-9]+)+)\b/g;

function namesExtractedPieces(text) {
  const m = /Solution:\s*([\s\S]*?)(?:\n\s*\n(?:Benefits|Strength)|$)/.exec(String(text || ''));
  const solution = m ? m[1] : '';
  const names = new Set((solution.match(NAMED_PIECE_RE) || []).filter((w) => w.replace(/^_/, '').length > 5));
  return names.size >= 2;
}

module.exports = { isEmptyApprovalSource, isAdvisoryProseSource, isEffectivelyEmpty, readRepoFileAtHead, validateRelocatedDraftSymbols, verifyDeterministicScriptExtractDraft, verifyDeterministicOnePassDecomposeDraft, NON_IMPL_PATTERNS, decodeGroupBContent, NAMED_PIECE_RE, namesExtractedPieces };
