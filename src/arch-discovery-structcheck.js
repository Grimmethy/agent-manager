'use strict';

// CLI: node arch-discovery-structcheck.js <path to a text file containing implementResponse>
// (a raw-text temp file, same convention as ornith-worker.ps1's $planTextPath/$implTextPath/
// $critiqueTextPath -- NOT a task JSON path. At the point this runs, the task's revised
// implementResponse only exists in ornith-worker.ps1's in-memory $task object, not yet
// written back to the task JSON on disk.)
// Deterministic structural sanity check for arch_discovery's implement/revision output,
// run by ornith-worker.ps1 right after critique/revision, before the task reaches review.
//
// Reproduced live 2026-07-21: ornith-worker.ps1's Critique pass correctly flagged a draft
// as unverifiable, triggered a Revision pass -- and the REVISION pass itself then produced
// fluent, on-topic English refusing to verify the draft ("I cannot verify this draft
// against the provided inputs...") instead of either fixing it or outputting nothing.
// That's coherent prose, not gibberish/empty/repeated-character, so ornith-client.js's
// generic detectDegenerate() never flags it -- it sailed through a 2/3 APPROVE review
// vote and would have landed in the real architecture-candidates doc via
// apply-group-a.js's applyArchDiscoveryCandidates.
//
// This reuses that SAME apply-time parser (parseArchDiscoveryCandidates) rather than a
// separate ad-hoc check, so "does this look like a real candidate" is answered identically
// wherever it's asked -- structural drift between a pre-review sanity check and the real
// apply step would just recreate the exact bug class this whole session has been about.

const fs = require('fs');
const { parseArchDiscoveryCandidates } = require('./apply-group-a.js');

const REQUIRED_SECTIONS = ['Problem:', 'Solution:', 'Benefits:'];

function checkStructure(implementResponse) {
  const text = (implementResponse || '').trim();
  if (!text) return { ok: true, reason: 'empty response -- valid outcome, means no real friction found' };

  const candidates = parseArchDiscoveryCandidates(text);
  if (candidates.length === 0) {
    return { ok: false, reason: 'non-empty response but zero "### AC-NNN" candidate headings found -- does not match the required format' };
  }

  const malformed = candidates.filter((c) => REQUIRED_SECTIONS.some((section) => !new RegExp(`^${section}`, 'im').test(c.body)));
  if (malformed.length > 0) {
    return {
      ok: false,
      reason: `${malformed.length}/${candidates.length} candidate(s) missing a required Problem:/Solution:/Benefits: section -- likely meta-commentary or a refusal (e.g. "I cannot verify..."), not a real candidate write-up`,
    };
  }

  return { ok: true };
}

if (require.main === module) {
  const textPath = process.argv[2];
  const implementResponse = fs.readFileSync(textPath, 'utf8');
  process.stdout.write(JSON.stringify(checkStructure(implementResponse)));
}

module.exports = { checkStructure };
