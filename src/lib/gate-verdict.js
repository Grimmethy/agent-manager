'use strict';

// gate-verdict.js -- the model-free draft for a pre-dispatch gate 'archive' verdict.
//
// 2026-10-07 (TaxHarvest needs-clarification investigation: 39 of 83 entries): local-draft.js's
// tryPreDispatchGate decides a scanner finding is a deterministic false positive (e.g. "No await
// expression found in flagged snippet"), but draftTask used to return {status:'archived'} -- a shape
// scripts/local-worker.sh does not route -- so the task went to review/ with an EMPTY draft, review
// rejected "the draft is empty" three times, the gate re-archived every redraft, and the task landed in
// needs-clarification. Nothing ever executed the archive. The fix is to express the gate's verdict as what
// the source's own pipeline already understands: a FALSE POSITIVE draft. It then flows through the normal
// review vote and the source's apply() (which records the scanner suppression and the 'dismissed'
// disposition), exactly like a model-written false positive, with zero draft model calls.
//
// Pure and deterministic: every sentence is built from the detector's own reason and the task's own
// snippet, so the reviewer can check it against the code window it is shown.

const EXCERPT_CHARS = 200;

function flaggedCodeOf(task) {
  const pc = (task && typeof task.promptContext === 'object' && task.promptContext) || {};
  const finding = (pc && typeof pc.finding === 'object' && pc.finding)
    || (task && typeof task.finding === 'object' && task.finding) || {};
  const code = pc.flaggedCode || pc.code || pc.ruleCode || pc.snippet
    || finding.flaggedCode || finding.code || finding.snippet;
  return typeof code === 'string' ? code : '';
}

function excerptOf(code) {
  const flat = String(code || '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS - 3)}...` : flat;
}

// gate: { ruleId, reason }. Returns { plan, implementResponse }.
function buildGateFalsePositiveDraft(gate, task) {
  const ruleId = String((gate && gate.ruleId) || 'unknown-rule');
  const reason = String((gate && gate.reason) || 'pre-dispatch gate verdict').trim().replace(/[.\s]+$/, '');
  const excerpt = excerptOf(flaggedCodeOf(task));
  const quoted = excerpt ? ` The flagged code window it examined (excerpt): "${excerpt.replace(/"/g, "'")}".` : '';
  const implementResponse = [
    'FALSE POSITIVE',
    '',
    `The deterministic pre-dispatch check for rule "${ruleId}" found no real instance of the flagged pattern: ${reason}.${quoted} No model was consulted; the verdict comes from the detector registered for this rule, so the same check can be re-run on this snippet.`,
  ].join('\n');
  const plan = [
    'Deterministic pre-dispatch gate verdict (no model call).',
    `Rule: ${ruleId}`,
    `Detector reason: ${reason}`,
    'Verdict: FALSE POSITIVE.',
  ].join('\n');
  return { plan, implementResponse };
}

module.exports = { buildGateFalsePositiveDraft, flaggedCodeOf, excerptOf };
