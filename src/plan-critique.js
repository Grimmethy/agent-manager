'use strict';

// Pre-implement plan critique for adhoc tasks (2026-09-04) -- component 4 of the "plan
// mode" port. Before the implement ladder burns turns on a bad plan, check the plan (now
// grounded, #80) against the real repo content for mechanical gaps. A DETERMINISTIC
// pre-filter does the high-value checks with no model at all; a small qwen2.5:3b call on
// its OWN GPU lock key (parallelisable with a busy main lane) is the fallback for
// semantic gaps.
//
// Advisory, never blocking: a "gaps" verdict triggers exactly ONE bounded re-plan
// (local-draft.js), and the re-planned plan is still verified from scratch by tier 3.
// Worst case is one wasted ~60s plan roll. The 3b's output is a strict enum contract;
// anything non-conforming is discarded, and 0 surviving lines is treated as "ok" (the
// documented 3b-noise mitigation -- see task-sources.js's prior qwen2.5:3b-review note).

const { taskIdentifiers } = require('./task-anchor-files.js');
const { call: localCall } = require('./local-client.js');

const GAP_TAGS = ['MISSING_REQUIREMENT', 'UNVERIFIED_PATH', 'SCOPE_TOO_BIG', 'NO_VERIFICATION'];
const MAX_GAPS = 5;
const CRITIQUE_MODEL = process.env.AGENT_MANAGER_PLAN_CRITIQUE_MODEL || 'qwen2.5:3b';
const CRITIQUE_NUM_CTX = 8192;

function clip(s, n) {
  const str = String(s || '');
  return str.length > n ? `${str.slice(0, n)}\n...[truncated]` : str;
}

// Deterministic checks -- no model. Returns string[] of gap lines ("TAG detail").
function deterministicGaps(task) {
  const plan = String(task.planResponse || '');
  const rawText = String((task.promptContext && task.promptContext.rawText) || '');
  const grounding = String(task._planGrounding || task.orientNotes || task._priorInvestigation || '');
  const gaps = [];

  // Every repo path / `path:line` the plan cites must appear in the grounding (or be one
  // the plan is CREATING). Backtick-quoted paths and bare src|python|... paths.
  const citedPaths = new Set();
  for (const m of plan.matchAll(/`((?:src|python|scripts|lib|test|tests|docs)\/[\w./@-]+)`/g)) citedPaths.add(m[1]);
  for (const m of plan.matchAll(/\b((?:src|python|scripts|lib|test|tests|docs)(?:\/[\w.@-]+)+\.\w{1,5})\b/g)) citedPaths.add(m[1]);
  const createsPath = (p) => new RegExp(`\\b(?:new file|create|add(?:ing)?)\\b[^.\\n]{0,60}${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(plan);
  for (const p of citedPaths) {
    if (grounding.includes(p) || createsPath(p)) continue;
    gaps.push(`UNVERIFIED_PATH the plan cites ${p} as existing but it is not in the grounded repo content and the plan is not creating it`);
    if (gaps.length >= MAX_GAPS) return gaps;
  }

  // Every distinctive identifier the REQUEST names should be addressed somewhere in the plan.
  for (const id of taskIdentifiers(rawText)) {
    if (plan.includes(id)) continue;
    gaps.push(`MISSING_REQUIREMENT the request names \`${id}\` but the plan never mentions it`);
    if (gaps.length >= MAX_GAPS) return gaps;
  }

  return gaps;
}

function buildPlanCritiquePrompt(task) {
  const plan = String(task.planResponse || '');
  const rawText = String((task.promptContext && task.promptContext.rawText) || '');
  const grounding = String(task._planGrounding || task.orientNotes || task._priorInvestigation || '');
  return [
    'You are a plan reviewer. You are NOT reviewing code -- only whether this PLAN, as written, is safe to hand to an implementer. You have the real repo content the planner used, below.',
    '',
    `TASK: ${task.title || ''}`,
    `REQUEST: ${clip(rawText, 3000)}`,
    '',
    '--- PLAN ---',
    plan,
    '',
    '--- REAL REPO CONTENT THE PLANNER HAD ---',
    clip(grounding, 8000) || '(none)',
    '',
    'Check ONLY these, mechanically:',
    '- MISSING_REQUIREMENT: a concrete thing the REQUEST names (endpoint, file, flag, behavior) that the PLAN never addresses.',
    '- UNVERIFIED_PATH: the PLAN cites a path/symbol as existing that does NOT appear in the repo content above (and the plan is not creating it).',
    '- SCOPE_TOO_BIG: the PLAN spans many files/subsystems and should be decomposed.',
    '- NO_VERIFICATION: the PLAN states no way to check the change is correct when done.',
    '',
    'Output EXACTLY one of:',
    '  PLAN OK',
    'or:',
    '  GAPS:',
    '  1. <TAG> <one specific concrete gap, <=140 chars>',
    `  ... (max ${MAX_GAPS}, TAG one of: ${GAP_TAGS.join(', ')})`,
    'Nothing else. Do not comment on style, wording, or design choices.',
  ].join('\n');
}

function parseCritique(text) {
  const t = String(text || '').trim();
  const firstLine = (t.split('\n').find((l) => l.trim()) || '').trim();
  if (/^PLAN OK\b/i.test(firstLine)) return { verdict: 'ok', gaps: [] };
  const gaps = [];
  for (const line of t.split('\n')) {
    const m = line.match(/^\s*\d+[.)]\s+([A-Z_]+)\s+(.{1,140})\s*$/);
    if (m && GAP_TAGS.includes(m[1])) gaps.push(`${m[1]} ${m[2].trim()}`);
    if (gaps.length >= MAX_GAPS) break;
  }
  return gaps.length ? { verdict: 'gaps', gaps } : { verdict: 'ok', gaps: [] };
}

// task, { call?, maybeLockedOn } -> { verdict: 'ok'|'gaps', gaps: string[], viaModel: bool }
async function runPlanCritique(task, { call = localCall, maybeLockedOn } = {}) {
  const det = deterministicGaps(task);
  if (det.length) return { verdict: 'gaps', gaps: det.slice(0, MAX_GAPS), viaModel: false };

  const prompt = buildPlanCritiquePrompt(task);
  const fn = () => call({ prompt, model: CRITIQUE_MODEL, numCtx: CRITIQUE_NUM_CTX, think: false, temperature: 0.2, numPredict: 500, source: task.source });
  let result;
  try {
    result = maybeLockedOn ? await maybeLockedOn(CRITIQUE_MODEL, fn, 'plan-critique') : await fn();
  } catch (e) {
    // Critique is advisory -- a failed run just means no re-plan.
    return { verdict: 'ok', gaps: [], viaModel: true, error: String(e && e.message || e).slice(0, 160) };
  }
  if (result && result.degenerate) return { verdict: 'ok', gaps: [], viaModel: true };
  return { ...parseCritique(result && result.response), viaModel: true };
}

module.exports = { runPlanCritique, buildPlanCritiquePrompt, parseCritique, deterministicGaps, GAP_TAGS, MAX_GAPS };
