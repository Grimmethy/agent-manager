'use strict';

// AC-NNN candidate-doc primitives: parse an implement-pass response into candidate
// objects, derive the next free AC id, and append candidates to a `Docs/*_CANDIDATES.md`
// doc. Extracted from apply-group-a.js (2026-08-27) so both core and the out-of-tree
// hygiene plugin (agent-manager-hygiene) can share ONE copy of this format -- arch_review /
// arch_import / the observability|performance|function-length _fix sources all read and
// write it, and core backlog_decomposition still appends to it too. apply-group-a.js
// re-exports every name here for back-compat, so existing `require('./apply-group-a.js')`
// call sites (arch-discovery-structcheck.js, adhoc-harness-draft.js, task-sources.js) are
// unchanged.
//
// Dependency-light on purpose: fs, path, ./atomic-write.js only -- nothing that would make
// this a core-only module.

const fs = require('fs');
const path = require('path');
const { writeAtomicSync } = require('./atomic-write.js');

// Parses arch_discovery's AND arch_import's implement-pass output (see prompts.js's
// archDiscoveryImplementPrompt / archImportImplementPrompt for the exact
// "### AC-NNN · Title" format both must match) into candidate objects, one per "### AC-"
// heading. arch_import's blocks additionally carry a "Source:" line (provenance back to
// the external project + deep_dive item this was promoted from) -- optional here since
// arch_discovery's own candidates never have one; harmless to look for either way, same
// as Strength:/Files: already being optional-with-fallback below. Deliberately does NOT
// trust the AC-NNN number the local model picked -- applyArchDiscoveryCandidates re-derives it
// below instead (see that function's comment).
//
// Lenient on the AC-NNN/title separator specifically: replaying the two real
// arch_discovery tasks that failed apply live (2026-07-21) showed the local model reliably drops
// the "·" the prompt asks for ("### AC-042 Extract Git..." with a plain space, not
// "### AC-042 · Extract Git...") -- a strict match here would have silently produced ZERO
// candidates from real-world output, not an error, which is worse (looks like a clean "no
// friction found" run instead of a parse failure). Accepting a few common separators (or
// none) on READ, while still always WRITING the canonical "· " format below, keeps
// nextArchReviewTask()'s own strict reader (task-sources.js) untouched and correct --
// normalize inconsistency at this one boundary instead of loosening every downstream
// consumer to match the local model's inconsistency.
// A response that's just a JSON-style empty-string LITERAL (`""` or `''`, two characters)
// is the local model representing "intentionally nothing" the same way `""` reads in code -- not
// gibberish, not a malformed candidate. Confirmed live 2026-07-21: 4 of 6 arch_import
// "structural check failed" blocks were exactly this, the model correctly following the
// implement prompt's "output the empty string and nothing else" instruction, just typing
// out the literal representation instead of a truly empty string. `.trim()` alone doesn't
// catch this (quote characters aren't whitespace) -- exported so
// arch-discovery-structcheck.js's own emptiness check uses the identical rule, not a
// second copy that could drift.
function isEffectivelyEmptyResponse(text) {
  const t = (text || '').trim();
  return t === '' || t === '""' || t === "''";
}

function parseArchDiscoveryCandidates(implementResponse) {
  const text = (implementResponse || '').trim();
  if (isEffectivelyEmptyResponse(text)) return [];
  const blocks = text.split(/(?=^#{1,6}\s*AC-\d+)/m).map((b) => b.trim()).filter(Boolean);
  return blocks
    .map((block) => {
      const headingLine = block.split('\n')[0];
      const titleMatch = headingLine.match(/AC-\d+\s*(?:[·:—-]\s*)?(.+)/);
      if (!titleMatch) return null;
      const strengthMatch = block.match(/^Strength:\s*(.+)$/m);
      const sourceMatch = block.match(/^Source:\s*(.+)$/m);
      const filesMatch = block.match(/^Files:\s*(.+)$/m);
      // Body is everything after the LAST metadata line present (Files:, else Source:,
      // else the heading) -- the Problem/Solution/Benefits paragraphs, kept verbatim.
      const bodyAnchor = filesMatch ? filesMatch[0] : sourceMatch ? sourceMatch[0] : headingLine;
      const anchorIdx = block.indexOf(bodyAnchor);
      const body = block.slice(anchorIdx + bodyAnchor.length).trim();
      return {
        title: titleMatch[1].trim(),
        strength: strengthMatch ? strengthMatch[1].trim() : 'Strong',
        source: sourceMatch ? sourceMatch[1].trim() : '',
        files: filesMatch ? filesMatch[1].trim() : '',
        body,
      };
    })
    .filter((c) => c && c.title && c.body);
}

function nextAvailableCandidateId(existingText) {
  let max = 0;
  for (const m of (existingText || '').matchAll(/AC-(\d+)/g)) {
    const n = parseInt(m[1], 10);
    if (n > max) max = n;
  }
  return max + 1;
}

// Appends one community's candidate write-up(s) to the project's architecture-candidates
// doc (AGENT_MANAGER_ARCH_CANDIDATES_PATH), which nextArchReviewTask() (task-sources.js)
// re-parses later looking for "### AC-NNN · Title" / "Strength: Strong" / "Files: ..." --
// these two functions' expectations of the format must stay in sync.
//
// Re-derives each candidate's AC-NNN id from the doc's own current max, instead of
// trusting the id the local model wrote in its markdown. archDiscoveryImplementPrompt only asks it
// to avoid colliding with IDs visible in its OWN plan-time context (one community's worth
// of "candidates already proposed for other communities"), which is a real, observed
// collision source, not hypothetical: two communities drafted around the same time, or a
// plan run before an earlier same-day candidate had actually landed in the doc yet. A
// collision here would silently corrupt arch_review's downstream `AC-\d+`-keyed dedup
// (two different candidates both claiming `arch-review-ac-042` -- the second is silently
// dropped as "already in queue"). Assigned sequentially against the text as it grows
// within this same call, so multiple candidates in one implementResponse never collide
// with each other either.
//
// `snippet` (2026-08-27, Grimmethy: "we should be looking for code content instead of
// the line itself" -- root-caused live via observability-fix-ac-26): the real code text a
// candidate is about is available and FRESH at review time (observability-review.js and
// its siblings already compute it as promptContext.snippet, to ground the genuine/
// false-positive judgment), but used to dead-end there -- only the model's own free-text
// Problem/Solution prose survived into the doc, and a model transcribing remembered code
// into prose routinely paraphrases it (confirmed: AC-26's quoted `catch (err) { return
// null; }` vs the real bare `catch {` / `return null;` on separate lines). Writing it here
// as its own deterministic field -- never touched by the model, a straight pass-through of
// what the scanner/reviewer actually read -- means windowFetchedFileContent
// (task-sources.js) gets a real, current anchor instead of reverse-engineering position
// from lossy prose. Optional: arch_review/arch_import_review's own candidates (hand-authored
// or drafted without a pre-existing scan finding) have no such snippet to pass.
function applyArchDiscoveryCandidates({ implementResponse, candidatesPath, docTitle = '# Architecture Review Candidates', snippet = null }) {
  const candidates = parseArchDiscoveryCandidates(implementResponse);
  if (candidates.length === 0) {
    return { skipped: true, reason: 'no candidates in implement response -- nothing to apply' };
  }

  let text = fs.existsSync(candidatesPath) ? fs.readFileSync(candidatesPath, 'utf8') : `${docTitle}\n`;

  const candidateIds = [];
  for (const c of candidates) {
    const id = `AC-${nextAvailableCandidateId(text)}`;
    const lines = [`### ${id} · ${c.title}`, `Strength: ${c.strength}`];
    if (c.source) lines.push(`Source: ${c.source}`);
    if (c.files) lines.push(`Files: ${c.files}`);
    // Fenced, not backtick-inline -- the real snippet is often multi-line and may itself
    // contain backticks (template literals are common in this codebase), so a fence is
    // the only delimiter that can't collide with the content it's wrapping.
    if (snippet) lines.push('Snippet:', '```', snippet, '```');
    lines.push('', c.body);
    text += '\n' + lines.join('\n') + '\n';
    candidateIds.push(id);
  }

  fs.mkdirSync(path.dirname(candidatesPath), { recursive: true });
  writeAtomicSync(candidatesPath, text);

  return { file: candidatesPath, candidateCount: candidates.length, candidateIds };
}

module.exports = {
  isEffectivelyEmptyResponse,
  parseArchDiscoveryCandidates,
  nextAvailableCandidateId,
  applyArchDiscoveryCandidates,
};
