'use strict';

// Deterministic validator for brain_dump_resolution_check
// Validates that verdict evidence is grounded in the evidence pack
// Downgrades 'yes' to 'unclear' if evidence not grounded

// Every string value of the pack, joined (so JSON escaping of quotes in a commit subject never hides a match).
function packStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => packStrings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => packStrings(v, out));
  return out;
}

const HASH_RE = /\b[0-9a-f]{7,40}\b/g;
const FILE_LINE_RE = /[\w@./-]+:\d+/g;
const QUOTED_RE = /"([^"]{5,})"/g;

// True when the evidence names at least one commit hash (a short and a long form of the same hash count as the same), file:line or quoted phrase that the pack contains.
function isGroundedInPack(evidence, pack) {
  const text = packStrings(pack).join('\n');
  const packHashes = text.match(HASH_RE) || [];
  const hashHit = (evidence.match(HASH_RE) || []).some((h) => packHashes.some((p) => h.startsWith(p) || p.startsWith(h)));
  const fileLineHit = (evidence.match(FILE_LINE_RE) || []).some((t) => text.includes(t));
  const quotedHit = [...evidence.matchAll(QUOTED_RE)].some((m) => text.includes(m[1]));
  return hashHit || fileLineHit || quotedHit;
}

function validateResolutionVerdict(verdict, evidence, pack) {
  // Must have verdict object with resolved field
  if (!verdict || typeof verdict !== 'object' || !['yes', 'no', 'unclear'].includes(verdict.resolved)) {
    return { resolved: 'unclear', evidence: '', error: 'invalid verdict format' };
  }

  // Evidence must be a non-empty string
  if (!evidence || typeof evidence !== 'string' || !evidence.trim()) {
    return { resolved: 'unclear', evidence: '', error: 'missing evidence' };
  }

  // For 'yes', evidence must quote something that is LITERALLY in the pack (2026-10-30, HUB0274-02): the old check only asked that the evidence contain
  // some hash/file:line/quoted phrase and that the pack contain some string of the same shape, so a made-up hash passed whenever the pack held any other.
  if (verdict.resolved === 'yes' && !isGroundedInPack(evidence, pack)) {
    return { resolved: 'unclear', evidence: '', error: 'evidence not grounded in pack' };
  }

  return { resolved: verdict.resolved, evidence: evidence.trim() };
}

module.exports = { validateResolutionVerdict };
