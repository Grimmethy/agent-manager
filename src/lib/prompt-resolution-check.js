'use strict';

// Plan and implement prompt builders for the brain_dump_resolution_check source (HUB0274-04, 2026-10-30): one jotted note, one deterministic
// evidence pack built by git (src/evidence-pack.js), and a three-way answer that src/validate-resolution.js then checks against the pack.
// Registered next to brain_dump_sort in src/prompts.js.

function packJson(task) {
  const ctx = (task && task.promptContext) || {};
  return JSON.stringify(ctx.evidencePack || {}, null, 2);
}

function resolutionCheckPlanPrompt(task) {
  const ctx = (task && task.promptContext) || {};
  return [
    'You are checking whether one jotted note describes something that is ALREADY fixed, or simply untrue, on the current master of the code.',
    '',
    `NOTE: ${ctx.rawText}`,
    '',
    `EVIDENCE PACK (JSON, built by git on master ${ctx.masterSha}):`,
    packJson(task),
    '',
    'The pack lists, for what the note cites: whether each cited path exists on master and its last commits, where each cited identifier occurs (git grep hits), and the commits since the note was captured that touched the cited files.',
    '',
    'Write a short numbered reading of what each piece of evidence shows about the NOTE. If the pack does not settle it, say so: the answer is then "unclear". Do not guess and do not use anything that is not in the pack.',
  ].join('\n');
}

function resolutionCheckImplementPrompt(task, planText) {
  const ctx = (task && task.promptContext) || {};
  return [
    'Earlier you read this evidence:',
    '',
    planText,
    '',
    `NOTE: ${ctx.rawText}`,
    '',
    'Now output ONLY one JSON object, with no prose before or after and no markdown code fences:',
    '',
    '{"resolved": "yes" | "no" | "unclear", "evidence": "<a commit hash, a file:line or a quoted commit subject copied exactly from the evidence pack>"}',
    '',
    'Rules: answer "yes" only when the pack shows that the problem the note describes is already fixed, or that the code it cites does not exist. Answer "no" when the pack shows the problem is still present. Answer "unclear" whenever you are not sure. The evidence field is required for every answer and must be copied exactly from the evidence pack above; an answer whose evidence is not in the pack is discarded.',
  ].join('\n');
}

module.exports = { resolutionCheckPlanPrompt, resolutionCheckImplementPrompt };
