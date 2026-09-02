'use strict';

// Decompose-only pass (2026-09-02). A single model call -- NO tool loop, so it cannot run
// out of turns -- that decides whether an adhoc task is one focused implementation pass or
// a set of independent pieces, and if the latter, produces the sub-task JSON the
// coordinator machinery already consumes (parseSubTaskProposals -> queueSubTasks ->
// queue/coordinating/ -> coordinator-sweep.js).
//
// Three callers:
//   - the PRELIMINARY check (local-draft.js draftAdhocBranch), run after the blind plan
//     and BEFORE any agentic tier -- catches "this is 5 endpoints + a UI + tests" up front
//     instead of burning a 35-turn tier-3 pass on it.
//   - the POST-EXHAUSTION backstop (local-agentic-write-draft.js) -- a rare safety net for
//     a task the preliminary check judged one-pass but that then blew its whole tier-3
//     budget without a single edit.
//   - the REPEATED-DECOMPOSE backstop (local-agentic-write-draft.js) -- the tier-3 model
//     has answered RESOLUTION: decompose on two separate passes but never produced usable
//     sub-task JSON. That is the same "too big for this model" signal as an exhausted
//     budget; do the split for it in one clean call instead of requeueing to escalation.

const { parseSubTaskProposals } = require('./agentic-draft-common.js');

// The size/shape rule the local model needs spelled out -- its whole failure mode is
// "many edits scattered through a 6000-line file", which a new self-contained module
// sidesteps.
const ONE_FILE_RULE = 'Each piece must touch ONE file. Strongly prefer a NEW self-contained file/module over pieces that need edits scattered through a large existing file -- a fresh file written in one pass is what the local model can actually land; broad surgery in a big file is what it fails at.';

function preliminaryPrompt(task) {
  const ctx = (task && task.promptContext) || {};
  return [
    'You are assessing whether a task should be split BEFORE anyone tries to implement it.',
    '',
    'TASK:',
    (ctx.rawText || task.title || '').trim(),
    '',
    'A rough (unverified, blind) plan for it:',
    (task.planResponse || '(none)').trim(),
    '',
    'Decide: is this ONE atomic change that a single focused implementation pass can land,',
    'or does it span multiple INDEPENDENT files / subsystems / deliverables that should',
    'each be their own piece? Touching 2-3 spots in ONE file is still ONE pass -- only split',
    'when it is genuinely multi-part.',
    '',
    ONE_FILE_RULE,
    '',
    'Answer with ONLY a JSON object, nothing else:',
    '{"one_pass": true}',
    'OR',
    '{"one_pass": false, "subtasks": [{"title": "short imperative title", "rawText": "a full, self-contained description of just this piece -- someone implementing only this must not need the original task"}, ...]}',
    'Optionally add "after": N to a subtask (N = 0-based index of an EARLIER subtask it cannot start until that one is merged, e.g. it edits a file the earlier one creates).',
    'Give 2 to 6 subtasks when splitting.',
  ].join('\n');
}

function postExhaustionPrompt(task, priorInvestigation, priorAttempt, opener) {
  const ctx = (task && task.promptContext) || {};
  return [
    opener || 'A full implementation attempt just exhausted its entire turn budget without making a single edit. This task IS too large for one pass -- do not second-guess that. Your job is to split it well.',
    '',
    'TASK:',
    (ctx.rawText || task.title || '').trim(),
    '',
    'A rough (unverified, blind) plan for it:',
    (task.planResponse || '(none)').trim(),
    priorInvestigation ? `\nWhat a read-only investigation pass already found:\n${priorInvestigation}` : '',
    priorAttempt ? `\nWhat the failed implementation pass explored:\n${priorAttempt}` : '',
    '',
    ONE_FILE_RULE,
    '',
    'Answer with ONLY a JSON array, nothing else:',
    '[{"title": "short imperative title", "rawText": "a full, self-contained description of just this piece"}, ...]',
    'Optionally add "after": N (0-based index of an EARLIER piece it depends on). Give 2 to 6 pieces that together cover the whole task with nothing dropped.',
  ].filter(Boolean).join('\n');
}

// Pull the JSON object OR array out of the model's answer and hand the subtask list to
// the existing parser. Returns { subTasks } (>= 2) or null.
function extractSubTasks(text) {
  const raw = (text || '').trim();
  // Try an object with a `subtasks` key first (preliminary mode).
  const objMatch = raw.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const obj = JSON.parse(objMatch[0]);
      if (obj && obj.one_pass === true) return null;
      if (obj && Array.isArray(obj.subtasks)) {
        const subs = parseSubTaskProposals(JSON.stringify(obj.subtasks));
        if (subs && subs.length >= 2) return { subTasks: subs };
        return null;
      }
    } catch { /* fall through to array parse */ }
  }
  // Bare array (post-exhaustion mode, or a model that skipped the wrapper).
  const subs = parseSubTaskProposals(raw);
  if (subs && subs.length >= 2) return { subTasks: subs };
  return null;
}

const REPEATED_DECOMPOSE_OPENER = 'Two separate full implementation attempts on this task both concluded it should be split (they answered RESOLUTION: decompose) but neither produced a usable list of pieces. Take that as settled: this task IS too large / too multi-part for one pass. Your only job now is to split it well.';

// task, { mode: 'preliminary' | 'post-exhaustion' | 'repeated-decompose', call?, claudeCall?, priorAttemptBlock? }
// call / claudeCall are injectable for tests; default to the real local / claude clients.
async function runDecomposePass(task, {
  mode = 'preliminary',
  call = require('./local-client.js').call,
  claudeCall = null,
  priorAttemptBlock = null,
} = {}) {
  const useClaude = process.env.AGENT_MANAGER_CLAUDE_DECOMPOSE === 'true';
  const doCall = useClaude
    ? (claudeCall || require('./claude-client.js').call)
    : call;

  let prompt;
  if (mode === 'post-exhaustion' || mode === 'repeated-decompose') {
    const priorInvestigation = task && typeof task._priorInvestigation === 'string' ? task._priorInvestigation.trim() : '';
    const priorAttempt = typeof priorAttemptBlock === 'string' ? priorAttemptBlock.trim() : '';
    const opener = mode === 'repeated-decompose' ? REPEATED_DECOMPOSE_OPENER : undefined;
    prompt = postExhaustionPrompt(task, priorInvestigation, priorAttempt, opener);
  } else {
    prompt = preliminaryPrompt(task);
  }

  let result;
  try {
    result = useClaude
      ? await doCall({ prompt, maxTurns: 1, permissionMode: 'dontAsk' })
      : await doCall({ prompt, think: true, temperature: 0.3, source: (task && task.source) || 'adhoc' });
  } catch {
    return null; // a failed decompose call is non-fatal -- the caller falls back to its normal path
  }

  return extractSubTasks(result && result.response);
}

module.exports = { runDecomposePass, extractSubTasks, ONE_FILE_RULE, REPEATED_DECOMPOSE_OPENER };
