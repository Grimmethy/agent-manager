'use strict';

// prompt-blocks.js -- extracted from src/prompts.js ([[hub-task-integration]] node-module decompose).

require('../task-sources.js');

function statedAcceptanceBlock(task) {
  const ctx = (task && task.promptContext) || {};
  const raw = ctx.acceptanceCriteria;
  if (raw == null) return [];
  const items = Array.isArray(raw) ? raw : String(raw).split('\n');
  const bullets = items.map((s) => String(s || '').replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim()).filter(Boolean);
  if (!bullets.length) return [];
  return [
    '',
    'THE TASK STATES THESE ACCEPTANCE CRITERIA (restate them verbatim as your CRITERIA: bullets):',
    ...bullets.map((b, i) => `${i + 1}. ${b}`),
  ];
}

function fixedLiteralsBlock(task) {
  const literals = task.promptContext && Array.isArray(task.promptContext.fixedLiterals)
    ? task.promptContext.fixedLiterals
    : [];
  if (literals.length === 0) return [];
  const lines = [
    '',
    'The following block(s) are FIXED, already-verified content -- they are not something to write or improve, only to place. Copy each one character-for-character into your output at the point it belongs. Do NOT paraphrase, reorder, abbreviate, "correct," or substitute a different-but-similar version from your own knowledge -- any deviation, however minor, is a hard failure that will be mechanically detected and rejected before anyone even reads your reasoning.',
    '',
  ];
  for (const lit of literals) {
    lines.push(`--- FIXED BLOCK: ${lit.name} ---`);
    lines.push(lit.content);
    lines.push('--- END FIXED BLOCK ---');
    lines.push('');
  }
  return lines;
}

function priorRejectionBlock(task) {
  const feedback = Array.isArray(task.priorRejectionFeedback) ? task.priorRejectionFeedback : [];
  if (feedback.length === 0) return '';
  const lines = [
    '',
    `HARD CONSTRAINT: This task has been attempted ${feedback.length} time(s) before and rejected each time. You MUST NOT repeat any of the specific mistakes listed below. If a rejection reason states that a particular line, field, or piece of content already exists, you MUST NOT re-derive or restate that line -- do not produce it again. Read each entry below and ensure your new attempt genuinely avoids the stated mistake:`,
    '',
  ];
  feedback.forEach((reason, i) => lines.push(`${i + 1}. ${reason}`));
  lines.push('');
  return lines.join('\n');
}

function strictCiteConstraintBlock(task) {
  const files = Array.isArray(task.verifiedFiles) ? task.verifiedFiles : [];
  const lines = [
    '',
    'STRICT-CITE CONSTRAINT:',
    files.length === 0
      ? 'The verified-files list is empty. cite only the files explicitly provided in the plan text above -- cite no files beyond what is shown there.'
      : 'cite only the files listed in the verified-files list below. Do NOT cite, reference, or assume the contents of any file not in this list, even if you think you know what it contains.',
    '',
  ];
  if (files.length > 0) {
    lines.push('VERIFIED-FILES LIST:');
    files.forEach(f => lines.push(`  - ${f}`));
  }
  lines.push('');
  return lines.join('\n');
}

module.exports = { statedAcceptanceBlock, fixedLiteralsBlock, priorRejectionBlock, strictCiteConstraintBlock };
