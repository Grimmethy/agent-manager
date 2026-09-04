'use strict';

// Per-task acceptance criteria for adhoc tasks (2026-09-04) -- component 2 of the "plan
// mode" port. A task can carry an explicit "definition of done"; when it doesn't, the plan
// pass is asked to STATE one. Downstream: tier 3 must report a real check per criterion in
// an "Acceptance:" block, review holds the diff to every criterion, and (opt-in) an
// acceptanceCommand is run against the applied branch before commit.
//
// Nothing here calls a model. reviewGuidance / reviewCompletenessQuestion are already
// per-task dynamic (resolveDynamicReviewField), so the review side needs no plumbing --
// task-sources.js's adhocReviewCompletenessQuestion just folds task.acceptanceCriteria in.

const MAX_CRITERIA = 8;
const MAX_CRITERION_CHARS = 240;

function normalizeList(value) {
  let items = [];
  if (Array.isArray(value)) {
    items = value.map((v) => String(v || '').trim());
  } else if (typeof value === 'string') {
    items = value.split('\n').map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim());
  }
  return items.filter(Boolean).map((s) => s.slice(0, MAX_CRITERION_CHARS)).slice(0, MAX_CRITERIA);
}

// Trailing "CRITERIA:" block in the plan text -> the bullets under it (until a blank line
// or EOF). Tolerates `- `, `* `, `1. `, `1) ` bullets.
function parseCriteriaBlock(planText) {
  const text = String(planText || '');
  const m = text.match(/^\s*CRITERIA:\s*$/im);
  if (!m) return [];
  const rest = text.slice(m.index + m[0].length).split('\n');
  const out = [];
  for (const line of rest) {
    if (!line.trim()) { if (out.length) break; else continue; }
    const b = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.+?)\s*$/);
    if (!b) { if (out.length) break; else continue; }
    out.push(b[1].trim());
  }
  return normalizeList(out);
}

// task -> { criteria: string[], source: 'promptContext' | 'plan-derived' | null }
function resolveAcceptanceCriteria(task) {
  const pc = (task && task.promptContext) || {};
  if (pc.acceptanceCriteria != null) {
    const criteria = normalizeList(pc.acceptanceCriteria);
    if (criteria.length) return { criteria, source: 'promptContext' };
  }
  const fromPlan = parseCriteriaBlock(task && (task.planResponse || task.lastGoodPlan));
  if (fromPlan.length) return { criteria: fromPlan, source: 'plan-derived' };
  return { criteria: [], source: null };
}

// Parse tier 3's "Acceptance:" block out of its final summary.
//   Acceptance:
//   1. <criterion> -- <check you ran> -- <PASS/FAIL + output>
// -> [{ criterion, check, result, pass }]
function parseAcceptanceBlock(summary) {
  const text = String(summary || '');
  const m = text.match(/^\s*Acceptance:\s*$/im);
  if (!m) return [];
  const rest = text.slice(m.index + m[0].length).split('\n');
  const out = [];
  for (const line of rest) {
    if (!line.trim()) { if (out.length) break; else continue; }
    const b = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.+)$/);
    if (!b) { if (out.length) break; else continue; }
    const segs = b[1].split(/\s+--\s+/);
    if (segs.length < 2) { out.push({ criterion: b[1].trim(), check: '', result: '', pass: false }); continue; }
    const criterion = segs[0].trim();
    const check = (segs[1] || '').trim();
    const result = segs.slice(2).join(' -- ').trim() || (segs[1] || '').trim();
    const pass = /\bPASS(?:ED|ES)?\b/i.test(result) && !/\bFAIL(?:ED|S)?\b/i.test(result);
    out.push({ criterion, check, result, pass });
  }
  return out;
}

module.exports = { resolveAcceptanceCriteria, parseAcceptanceBlock, parseCriteriaBlock, normalizeList, MAX_CRITERIA };
