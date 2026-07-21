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
const { parseArchDiscoveryCandidates, isEffectivelyEmptyResponse } = require('./apply-group-a.js');

const REQUIRED_SECTIONS = ['Problem:', 'Solution:', 'Benefits:'];

function checkStructure(implementResponse) {
  const text = (implementResponse || '').trim();
  // isEffectivelyEmptyResponse also catches a bare `""`/`''` -- confirmed live
  // 2026-07-21: 4 of 6 real arch_import "structural check failed" blocks were exactly
  // this, Ornith correctly following "output the empty string" by typing its literal
  // representation instead of a truly empty response. Without this, a CORRECTLY-followed
  // instruction was being reported as a structural failure.
  if (isEffectivelyEmptyResponse(text)) return { ok: true, reason: 'empty response -- valid outcome, means no real friction found' };

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

// Matches queue-watchdog.ps1's own $MaxOrnithRejectRetries=2 (a total of 3 failures
// before giving up) -- same tolerance, different failure axis.
const MAX_STRUCT_FAILURES = 3;

// A structural-check failure never accumulates toward queue-watchdog.ps1's own
// exhausted-retry stamp: Test-ReviewRejection only recognizes blockedStage:'review', and a
// structural block leaves blockedStage unset entirely (it fires INSIDE ornith-worker.ps1,
// before the task ever reaches review). Without this, a community/item that always fails
// structurally -- never once reaching review -- gets re-selected by nextArchDiscoveryTask()/
// nextArchImportTask() FOREVER, since their own "oldest lastReviewedAt"/"not yet promoted"
// picks never advance. Confirmed live 2026-07-21: arch-discovery-community-0 hit the exact
// same structural failure 3 times in under an hour; its lastReviewedAt hadn't moved since
// the previous day.
//
// Mirrors the exhaustion-stamp CONVENTION already established twice in this codebase
// (queue-watchdog.ps1's own arch_discovery exhausted-retry stamp; applyArchImportCandidate's
// candidateId:null-on-skip) rather than inventing a new one: a real, negative "tried,
// never worked, move on" outcome, distinct from both "never tried" and a real success.
function recordArchDiscoveryStructFailure(communityCoveragePath, communityId) {
  let coverage;
  try {
    coverage = JSON.parse(fs.readFileSync(communityCoveragePath, 'utf8'));
  } catch {
    return { exhausted: false, failCount: 0 };
  }
  if (!coverage || !Array.isArray(coverage.communities)) return { exhausted: false, failCount: 0 };

  const entry = coverage.communities.find((c) => c.id === communityId);
  if (!entry) return { exhausted: false, failCount: 0 };

  entry.structCheckFailCount = (entry.structCheckFailCount || 0) + 1;
  const exhausted = entry.structCheckFailCount >= MAX_STRUCT_FAILURES;
  if (exhausted && !entry.lastReviewedAt) {
    entry.lastReviewedAt = new Date().toISOString();
    entry.lastCandidateCount = -1; // same sentinel queue-watchdog.ps1 already uses for "exhausted, no real candidate count"
  }

  fs.writeFileSync(communityCoveragePath, JSON.stringify(coverage, null, 2));
  return { exhausted, failCount: entry.structCheckFailCount };
}

// Same shape of fix as recordArchDiscoveryStructFailure, for arch_import's per-item
// import-coverage.json instead of arch_discovery's per-community community-coverage.json.
function recordArchImportStructFailure(importCoveragePath, itemId) {
  let coverage;
  try {
    coverage = JSON.parse(fs.readFileSync(importCoveragePath, 'utf8'));
  } catch {
    return { exhausted: false, failCount: 0 };
  }
  if (!coverage || !coverage.items || !coverage.items[itemId]) return { exhausted: false, failCount: 0 };

  const entry = coverage.items[itemId];
  entry.structCheckFailCount = (entry.structCheckFailCount || 0) + 1;
  const exhausted = entry.structCheckFailCount >= MAX_STRUCT_FAILURES;
  if (exhausted && !entry.promotedAt) {
    entry.promotedAt = new Date().toISOString();
    entry.candidateId = null; // same sentinel applyArchImportCandidate already uses for "considered, no candidate came of it"
  }

  fs.writeFileSync(importCoveragePath, JSON.stringify(coverage, null, 2));
  return { exhausted, failCount: entry.structCheckFailCount };
}

// CLI: node arch-discovery-structcheck.js <textPath> [source] [communityId|itemId]
// The two extra args are optional -- when omitted (or when checkStructure passes), only
// the structural check itself runs, same as before. When given AND the check fails, the
// matching exhaustion tracker also runs, and 'exhausted'/'failCount' are included in the
// JSON response. Resolves communityCoveragePath/importCoveragePath itself via
// getConfig() (same pattern arch-import-fetch.js already uses) rather than requiring the
// caller (ornith-worker.ps1) to know about this package's own config paths -- it doesn't
// have them in scope today, and shouldn't need to just to pass one through.
if (require.main === module) {
  const [, , textPath, source, idArg] = process.argv;
  const implementResponse = fs.readFileSync(textPath, 'utf8');
  const result = checkStructure(implementResponse);

  if (!result.ok && source && idArg) {
    const { getConfig } = require('./config.js');
    if (source === 'arch_discovery') {
      Object.assign(result, recordArchDiscoveryStructFailure(getConfig().communityCoveragePath, Number(idArg)));
    } else if (source === 'arch_import') {
      Object.assign(result, recordArchImportStructFailure(getConfig().importCoveragePath, idArg));
    }
  }

  process.stdout.write(JSON.stringify(result));
}

module.exports = { checkStructure, recordArchDiscoveryStructFailure, recordArchImportStructFailure };
