'use strict';

// Deterministic validator for brain_dump_resolution_check
// Validates that verdict evidence is grounded in the evidence pack
// Downgrades 'yes' to 'unclear' if evidence not grounded

function validateResolutionVerdict(verdict, evidence, pack) {
  // Must have verdict object with resolved field
  if (!verdict || typeof verdict !== 'object' || !['yes', 'no', 'unclear'].includes(verdict.resolved)) {
    return { resolved: 'unclear', evidence: '', error: 'invalid verdict format' };
  }

  // Evidence must be a non-empty string
  if (!evidence || typeof evidence !== 'string' || !evidence.trim()) {
    return { resolved: 'unclear', evidence: '', error: 'missing evidence' };
  }

  // For 'yes', evidence must be grounded in the pack
  if (verdict.resolved === 'yes') {
    const packText = JSON.stringify(pack);
    
    // Check if evidence contains a commit hash, file:line, or quoted subject that appears in pack
    const hasCommitHash = /\b[0-9a-f]{7,40}\b/.test(evidence);
    const hasFileLine = /[^:\s]+:\d+/.test(evidence);
    const hasQuotedSubject = /"[^"]{5,}"/.test(evidence);
    
    // Grounded if any of these patterns appear in the pack
    const isGrounded = (hasCommitHash || hasFileLine || hasQuotedSubject) && 
                       (hasCommitHash && /\b[0-9a-f]{7,40}\b/.test(packText) ||
                        hasFileLine && /[^:\s]+:\d+/.test(packText) ||
                        hasQuotedSubject && /"[^"]{5,}"/.test(packText));
    
    if (!isGrounded) {
      return { resolved: 'unclear', evidence: '', error: 'evidence not grounded in pack' };
    }
  }

  return { resolved: verdict.resolved, evidence: evidence.trim() };
}

module.exports = { validateResolutionVerdict };
