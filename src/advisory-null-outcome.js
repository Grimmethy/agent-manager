'use strict';

// Honest "nothing found" outcomes for the advisory report sources (2026-09-27).
//
// pipeline_debrief, pipeline_forensics and pipeline_health_audit each instruct the drafter to
// answer with a specific null form when the evidence supports no finding (prompts.js: debrief
// `NO CONFIDENT INEFFICIENCY`, forensics `NO CLEAR ROOT CAUSE -- <signal needed>`, health audit
// `FALSE POSITIVE -- <justification>`). Drafts followed those instructions and were then rejected
// anyway -- 18 debriefs blocked at the SO WHAT gate (which only accepted the sentinel as the very
// first thing in the response), 3 forensics nulls rejected 2/2 by the LLM vote despite reviewGuidance
// saying a null is valid, 4 health-audit `FALSE POSITIVE --` lines rejected as "refusals" (that
// source has no reviewGuidance). An honest null could only get through by being fabricated into a
// finding.
//
// classifyNullOutcome is the single, purely deterministic recogniser of a well-formed null (no model
// call). A null needs a real justification after the marker, not just the marker: a bare
// `NO CONFIDENT INEFFICIENCY`, or `NO CONFIDENT INEFFICIENCY does not apply ...`, is NOT a null and
// keeps its old path. Used by review-task.js (deterministic approval, no vote), the debrief SO WHAT
// gate, and applyDebriefReport (close as a no-op + archive the window).
//
// Kill switch: AGENT_MANAGER_NULL_OUTCOME_APPROVAL=false.

const MIN_JUSTIFICATION_CHARS = 40;
const SEP = '(?:--|\\u2014|\\u2013|:)';

// Whole response is the null line (+ its justification, which may wrap onto further lines).
const FORENSICS_RE = new RegExp(`^\\s*NO CLEAR ROOT CAUSE\\s*${SEP}\\s*([\\s\\S]{${MIN_JUSTIFICATION_CHARS},})$`);
const HEALTH_AUDIT_RE = new RegExp(`^\\s*FALSE POSITIVE\\s*${SEP}\\s*([\\s\\S]{${MIN_JUSTIFICATION_CHARS},})$`);
// A LINE of the report (the drafts put it after the WHAT / SO WHAT sections), justification on the same line.
const DEBRIEF_LINE_RE = new RegExp(`^[ \\t]*NO CONFIDENT INEFFICIENCY[ \\t]*${SEP}[ \\t]*(\\S[^\\n]{${MIN_JUSTIFICATION_CHARS - 1},})$`, 'm');
// A numbered NOW WHAT list means the report DID flag something -- the null line would contradict it.
const DEBRIEF_HAS_ITEMS_RE = /^\s*NOW WHAT\s*\n\s*1[.)]/m;

function isEnabled() {
  return process.env.AGENT_MANAGER_NULL_OUTCOME_APPROVAL !== 'false';
}

// (resolved source name, implement response text) -> { kind, justification } | null
function classifyNullOutcome(source, text) {
  if (!isEnabled()) return null;
  const t = String(text || '');
  if (!t.trim()) return null;

  if (source === 'pipeline_forensics') {
    const m = FORENSICS_RE.exec(t);
    return m ? { kind: 'no-clear-root-cause', justification: m[1].trim() } : null;
  }
  if (source === 'pipeline_debrief') {
    if (DEBRIEF_HAS_ITEMS_RE.test(t)) return null;
    const m = DEBRIEF_LINE_RE.exec(t);
    return m ? { kind: 'no-confident-inefficiency', justification: m[1].trim() } : null;
  }
  if (source === 'pipeline_health_audit') {
    if (/```/.test(t) || /"mode"\s*:/.test(t)) return null; // a file-change JSON, not a plain verdict
    const m = HEALTH_AUDIT_RE.exec(t);
    return m ? { kind: 'false-positive', justification: m[1].trim() } : null;
  }
  return null;
}

module.exports = { classifyNullOutcome, MIN_JUSTIFICATION_CHARS, isEnabled };
