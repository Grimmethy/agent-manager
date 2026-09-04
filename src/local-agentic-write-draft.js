'use strict';

// Adhoc draft tier 3, LOCAL (2026-09-01, Grimmethy: "Those reasoning workers are supposed
// to go through qwen. Claude needs to be removed as a dependency from that system."). The
// local-model replacement for the deleted Claude adhoc-agentic-draft.js: a real multi-turn
// investigate -> edit -> verify loop via local-tool-client.js's runPlanWithTools() with
// its WRITE tool set (write_file / edit_file / run_bash, bwrap-sandboxed), pointed at an
// ISOLATED git worktree so nothing touches the real apply-target tree -- only the
// resulting `git diff` survives, captured the same way the Claude tier did.
//
// This is now the primary adhoc implement path, not an experiment: default-ON, gated only
// by AGENT_MANAGER_LOCAL_AGENTIC_WRITE=false and the shared queue/.chat-write-tools-disabled
// kill switch. It runs AFTER the cheaper local tiers (adhoc-harness-draft.js tier 1,
// local-agentic-draft.js tier 2 read-only); if it also declines, the task blocks for a
// human -- there is no Claude fallback.
//
// Known limits vs. the old Claude tier (accepted trade-offs): runPlanWithTools's per-turn
// 240s ceiling and 30s-per-command run_bash timeout (so the prompt asks for TARGETED
// checks -- py_compile on changed files, one test module -- not a full suite), a smaller
// turn budget, and the local model being materially less reliable at agentic tool use
// (docs/pipeline-incident-2026-07-19.md). Mitigations: the isolated worktree (a bad edit
// can't corrupt the real tree), human-gated review still decides whether the diff applies,
// and dead-process-check.js's zombie-restart threshold bounds a stuck run.

const path = require('path');
const fs = require('fs');
const { getConfig } = require('./config.js');
const { runPlanWithTools, ORIENT_TURN_LIMIT } = require('./local-tool-client.js');
const { recordCall: defaultRecordModelCall } = require('./model-stats-client.js');
const { runAgenticDraftInWorktree, priorRejectionBlock } = require('./agentic-draft-common.js');
const { runDecomposePass } = require('./decompose-pass.js');
const { anchorFilesPromptBlock } = require('./task-anchor-files.js');

// A leaf that blows a full tier-3 budget with zero edits is auto-decomposed as a backstop
// (the preliminary check in local-draft.js should catch most of these first). Bounded: a
// child that was auto-decomposed and STILL exhausts gets one more split, then falls
// through to the existing retry -> escalate path.
const MAX_AUTO_DECOMPOSE = Number(process.env.AGENT_MANAGER_MAX_AUTO_DECOMPOSE) || 2;

// 2026-08-31 (bra-1788142124203): raised 20 -> 35. A real tier-3 run hit the old 20-turn
// cap having made 13 tool calls -- all read-only orientation, zero edits -- and blocked
// before it could implement anything. 35 turns is ~9 min at the observed ~15s/turn,
// comfortably inside dead-process-check.js's 1680s (28 min) zombie threshold. Env
// override still wins.
const LOCAL_AGENTIC_WRITE_MAX_TURNS = Number(process.env.AGENT_MANAGER_LOCAL_AGENTIC_WRITE_MAX_TURNS) || 35;

function isEnabled() {
  return process.env.AGENT_MANAGER_LOCAL_AGENTIC_WRITE !== 'false';
}

// Same shared kill switch runPlanWithTools({allowWrite}) checks (queue/.chat-write-tools-
// disabled). Checked here too so a disabled tier returns a clean decline instead of
// letting runPlanWithTools silently drop to its no-tools fallback (a plain completion,
// useless for a draft).
function writeToolsDisabled() {
  try {
    const { pipelineDir } = getConfig();
    return fs.existsSync(path.join(pipelineDir, 'queue', '.chat-write-tools-disabled'));
  } catch {
    return false;
  }
}

function localDraftModelLabel() {
  return process.env.LOCAL_MODEL;
}

// The blind plan from runPlanPass (task.planResponse), handed to tier 3 as a starting
// point. WITHOUT the disclaimer, tier 3 previously started cold and burned its whole turn
// budget re-grepping for targets the plan already named -- but the plan is a no-tool
// completion (see runPlanPass), so its file paths / line numbers / "already exists" claims
// are guesses and are frequently stale. The disclaimer keeps the model from trusting them
// blindly while still giving it a map. Returns '' when there is no plan.
function blindPlanBlock(task) {
  const plan = task && typeof task.planResponse === 'string' ? task.planResponse.trim() : '';
  if (!plan) return '';
  const lead = task && task.planWasGrounded
    ? 'A PLAN for this task was drafted earlier with LIMITED file access -- a deterministic grep plus the specific files the task names. The paths and symbols it cites are likely real, but line numbers may be stale and anything beyond the shown files is unverified. Confirm with read_file / grep_codebase before you rely on it; where the plan and the real code disagree, the real code wins.'
    : 'A PLAN for this task was drafted earlier by a separate pass that could NOT read any files. Use it as a map of intent and rough shape -- but every path, line number, function name and "already exists / does not exist" claim in it is UNVERIFIED. Confirm each against the real code with read_file / grep_codebase before you rely on it; where the plan and the real code disagree, the real code wins.';
  return [lead, '', plan, ''].join('\n');
}

// The read-only investigation tier 2 already did (task._priorInvestigation, built by
// draftAdhocBranch from the declined tier-2 result). Tier 2 spends real turns reading files
// and grepping; without this, tier 3 repeats all of that from scratch and runs out of
// budget before it edits anything. Returns '' when tier 2 produced nothing worth carrying.
function priorInvestigationBlock(task) {
  const inv = task && typeof task._priorInvestigation === 'string' ? task._priorInvestigation.trim() : '';
  if (!inv) return '';
  return [
    'PRIOR INVESTIGATION -- a read-only pass already explored this task. Treat it as a map to build on, NOT as verified conclusions: it did not reach a decision, and its own reads may be incomplete. Start from what it already found rather than re-grepping the tree from scratch, then go make the change.',
    '',
    inv,
    '',
  ].join('\n');
}

// A task carrying promptContext.decomposedFrom was itself split off a larger feature by a
// prior decompose pass; one carrying rescopedFromDecompose was re-scoped down to a single
// sub-task the model proposed. Either way it is a confirmed-atomic leaf -- offering it the
// "decompose / too large" escape hatch (which it then over-picks and dead-ends on) is
// exactly wrong.
function isLeafTask(task) {
  const ctx = (task && task.promptContext) || {};
  return !!(ctx.decomposedFrom || (task && task.rescopedFromDecompose));
}

// A leaf is normally forbidden RESOLUTION: decompose (a prior split supposedly made it
// atomic). But that assumption is disproven the moment the leaf blows a full 35-turn pass
// with zero edits, has already tried to decompose on a prior pass, or has already been
// auto-decomposed once -- in those cases let it split again. MAX_AUTO_DECOMPOSE + review
// still bound runaway splitting.
function leafDecomposeLocked(task) {
  return isLeafTask(task)
    && !(task && task.autoDecomposeCount)
    && !(task && task.turnBudgetExhaustedBefore)
    && !(task && Number(task.decomposeBlockCount) > 0);
}

// A prior tier-3 (local-agentic-write) attempt on this same task that ended WITHOUT an
// edit still produced a real final message -- often (see the /api/chat/inject forensics) an
// accurate, detailed spec of exactly the change, it just never committed to writing it.
// draft-attempt-record.js keeps that text on task.draftAttempts[].tiers[].response across
// reject-retry requeues. Feed the most recent one back so the next attempt starts from its
// own verified findings instead of re-orienting from scratch. Returns '' when there is none.
function priorAttemptAnalysisBlock(task) {
  const attempts = Array.isArray(task && task.draftAttempts) ? task.draftAttempts : [];
  let response = '';
  for (let i = attempts.length - 1; i >= 0 && !response; i--) {
    const tiers = Array.isArray(attempts[i] && attempts[i].tiers) ? attempts[i].tiers : [];
    for (let j = tiers.length - 1; j >= 0; j--) {
      const t = tiers[j];
      if (t && t.tier === 'local-agentic-write' && typeof t.response === 'string' && t.response.trim()) {
        response = t.response.trim();
        break;
      }
    }
  }
  if (!response) return '';
  const CAP = 2500;
  return [
    'YOUR OWN PRIOR ATTEMPT at this task ended without making an edit. Here is the analysis it produced -- treat its file/line findings as verified starting points, confirm them quickly, then GO EDIT. Do not re-run the whole investigation.',
    '',
    response.length > CAP ? `${response.slice(0, CAP)}\n...[truncated]` : response,
    '',
  ].join('\n');
}

function buildWriteAgenticPrompt(task) {
  const ctx = task.promptContext || {};
  const leaf = leafDecomposeLocked(task);
  const stillLostAdvice = leaf
    ? `If you are still lost about where to make the change after ${ORIENT_TURN_LIMIT} turns, answer RESOLUTION: needs-human-decision AND name the one concrete fact you are missing -- do not keep grepping, and do NOT answer RESOLUTION: decompose.`
    : `If you are still lost about where to make the change after ${ORIENT_TURN_LIMIT} turns, that is a signal to answer RESOLUTION: decompose or RESOLUTION: needs-human-decision, not to keep grepping.`;
  const tooLargeClause = leaf
    ? 'This task has already been scoped by a prior decompose pass to be implementable in ONE pass. If you genuinely cannot, answer RESOLUTION: needs-human-decision with the specific blocker -- do not answer RESOLUTION: decompose and do not leave a partial edit.'
    : 'If the task is simply TOO LARGE to implement confidently in one pass (many files/subsystems, or you can tell you would run out of turns partway through), do NOT attempt a partial implementation and do NOT make any code changes. Instead split it into 2-6 smaller, independently-implementable pieces that together cover the original task. Each piece should touch ONE file; strongly prefer a NEW self-contained file/module over pieces that need edits scattered through a large existing file.';
  return [
    'You are implementing a real fix for a task submitted directly by a human, working inside a real git checkout of this repository on a fresh throwaway branch. You have real read/edit/write and shell (run_bash) tools against this checkout -- use them. run_bash commands are sandboxed and time out after ~30 seconds each, so run TARGETED checks (e.g. `python3 -m py_compile <the .py files you changed>`, a single relevant test module) rather than a whole test suite.',
    'Use grep_codebase / read_file / list_directory for exploration -- they are faster and cheaper than shelling out, and your turn budget is limited. Prefer read_file with offset/limit to page a large file and grep_codebase to locate code; a quick `run_bash` `sed -n \'3600,3700p\' path` slice is fine for a fast look, just do not burn turns re-listing the tree. Reserve run_bash otherwise for the final targeted check on files you actually changed.',
    'Files here can be thousands of lines. read_file returns a WINDOW of lines: check `totalLines` and `nextOffset` in the result and re-call with a higher `offset` to page -- never assume the first window is the whole file. grep_codebase searches this repo\'s configured dirs (or a subpath, or "." for all); it is a literal substring / all-words match, not a regex, and returns matching lines only -- read_file around a hit for context.',
    `TURN BUDGET: you have about ${LOCAL_AGENTIC_WRITE_MAX_TURNS} turns total. Spend at most the first ~${ORIENT_TURN_LIMIT} on orientation (grep/read/list). By then you MUST have either started editing with edit_file/write_file, or concluded with a RESOLUTION: line. Do not keep exploring past that -- a rough first edit you then fix is far better than running out of turns having changed nothing. ${stillLostAdvice}`,
    '',
    `Title: ${task.title || ''}`,
    leaf ? 'This task is a CONFIRMED-ATOMIC LEAF: a prior decompose pass already split the larger feature and this is one indivisible piece. It MUST be implemented in this pass with edit_file / write_file. Do NOT answer RESOLUTION: decompose.' : '',
    ctx.decomposedFrom ? `(decomposed from parent task ${ctx.decomposedFrom})` : '',
    '',
    ctx.rawText || JSON.stringify(ctx).slice(0, 4000),
    '',
    anchorFilesPromptBlock(task),
    priorRejectionBlock(task),
    blindPlanBlock(task),
    priorInvestigationBlock(task),
    priorAttemptAnalysisBlock(task),
    'First, investigate whether this specific request is ALREADY satisfied by the CURRENT code -- read the real files. A commit or feature that MENTIONS the same topic is NOT proof this request is done. Two things especially: (a) if the request asks to EXTEND something ("X should ALSO ...", "WHEN Y, ALSO do Z", a reference to an existing UI element/endpoint), the base feature already existing is NOT enough -- the SPECIFIC delta being asked for must be present. (b) a feature with the same NAME may act on a DIFFERENT object than the one this request names. Before RESOLUTION: no-changes-needed you MUST enumerate every concrete object the request names and, for EACH, point at the specific CURRENT file:symbol that already implements it. If any one is not covered, this is NOT no-changes-needed -- implement the missing part (or ask, per below).',
    '',
    'If it is NOT already resolved and is a concrete, scoped change you can make confidently: implement it with edit_file / write_file. Read whatever real files you need first -- do not guess at code you have not looked at. Run a targeted check (py_compile / one test module) for what you changed before finishing, and fix any failure your own change introduced.',
    '',
    tooLargeClause,
    '',
    'If implementing genuinely requires a PRODUCT/DESIGN DECISION only a human should make (which library/approach when none exists yet, what data to keep and for how long, which of several reasonable designs) -- NOT the same as too large, NOT the same as already resolved -- do not guess and do not falsely claim nothing needs to change. Stop and state the real open question(s).',
    '',
    'When you are completely done, end your FINAL message with exactly one of these four lines (nothing after it on that line):',
    'RESOLUTION: implemented',
    'RESOLUTION: no-changes-needed',
    'RESOLUTION: decompose',
    'RESOLUTION: needs-human-decision',
    '',
    'If RESOLUTION: implemented -- follow with a short (2-4 sentence) plain-English summary of what you did.',
    '',
    'If RESOLUTION: no-changes-needed -- follow with a short summary, then an "Already covered:" block: one line per concrete object the request names, as `<object> -- <path>:<symbol>`. If you cannot fill in a real file:symbol for every object, it is NOT no-changes-needed.',
    '',
    'If RESOLUTION: decompose -- follow it immediately with a JSON array of the sub-tasks, in exactly this shape (a full, self-contained description for each -- someone implementing just that one piece must not need the original task):',
    '[{"title": "short imperative title", "rawText": "a full, self-contained description of just this piece"}, ...]',
    'You MAY add "after": N to a sub-task, where N is the 0-based index of an EARLIER sub-task in this same array, ONLY when the piece genuinely cannot start until that earlier one is merged -- e.g. it edits a file the earlier one creates. Omit "after" for pieces that can proceed independently (the common case).',
    'Each piece should touch ONE file; strongly prefer a NEW self-contained file/module over pieces that need edits scattered through a large existing file.',
    'Then a short (1-3 sentence) explanation of why you split it this way.',
    '',
    'If RESOLUTION: needs-human-decision -- follow it with the specific open question(s), plainly stated, and enough real context for a human to answer without re-investigating. Then, if the answer space is a small number of genuinely distinct choices, ALSO give 2-4 options in exactly this format:',
    'OPTIONS:',
    '1. <short label, under 8 words> :: <one-sentence description of what choosing this means>',
    '2. <short label, under 8 words> :: <one-sentence description of what choosing this means>',
    '(a free-text "Other" answer is always available separately -- do not add an "other" option yourself. If the answer space is open-ended, omit OPTIONS entirely.)',
  ].join('\n');
}

/**
 * Adhoc tier-3, local. Same return contract as the (deleted) Claude draftAdhocImplement:
 * { succeeded, blocked?, blockedReason?, needsClarification? } plus a `reason` on a
 * "declined, try the next path" outcome. draftAdhocBranch calls this where the Claude
 * call used to be; a non-succeeded/declined result there means "block for human".
 *
 * @param {object} task
 * @param {object} [deps]
 * @param {function} [deps.runPlan] - defaults to local-tool-client.js runPlanWithTools.
 * @param {function} [deps.runInWorktree] - full override of the worktree run (tests).
 * @param {function} [deps.recordModelCall]
 */
async function draftAdhocViaLocalAgenticWrite(task, {
  runPlan = runPlanWithTools,
  runInWorktree,
  recordModelCall = defaultRecordModelCall,
} = {}) {
  // A deliberately-disabled tier is a clean block for a human, not an infra failure to
  // retry -- return the {succeeded:true, blocked:true} shape so draftAdhocBranch routes
  // the task to queue/blocked/ with a legible reason.
  if (!isEnabled()) {
    return { succeeded: true, blocked: true, blockedReason: 'local write-agentic adhoc tier is disabled (AGENT_MANAGER_LOCAL_AGENTIC_WRITE=false) and the cheaper local tiers could not complete this task -- needs a human.' };
  }
  if (writeToolsDisabled()) {
    return { succeeded: true, blocked: true, blockedReason: 'local write-agentic adhoc tier is disabled (queue/.chat-write-tools-disabled kill switch) and the cheaper local tiers could not complete this task -- needs a human.' };
  }

  const prompt = buildWriteAgenticPrompt(task);
  const started = Date.now();

  const doRun = runInWorktree || (async (worktreeDir) => {
    const result = await runPlan({
      prompt,
      maxTurns: LOCAL_AGENTIC_WRITE_MAX_TURNS,
      source: task.source,
      allowWrite: true,
      primaryRoot: worktreeDir,
      // On a cap-exhausted run, spend one more no-tools turn forcing a RESOLUTION line
      // so resolveAgenticDraft has something to route on instead of a hard block.
      forceSummaryOnCap: true,
      // Edit-by-turn-N forcing function: this tier's whole job is to produce a diff, and
      // it has repeatedly burned its entire budget on read-only orientation. If it hasn't
      // edited anything by ORIENT_TURN_LIMIT turns, runPlanWithTools pushes one firm
      // "stop exploring, act now" message.
      nudgeToEditEarly: true,
      // A confirmed-atomic leaf (decomposedFrom / rescopedFromDecompose) that still hasn't
      // edited a few turns after the soft nudge gets one firmer push: edit now or conclude
      // needs-human-decision -- decompose is off the table for a leaf.
      leafMustEdit: leafDecomposeLocked(task),
    });
    modelStatsSafe(recordModelCall, {
      taskId: task.id, stage: 'implement', model: localDraftModelLabel(),
      startedAt: new Date(started).toISOString(), latencyMs: Date.now() - started,
      result, source: task.source,
    });
    return result;
  });

  try {
    const verdict = await runAgenticDraftInWorktree(task, {
      runInWorktree: doRun,
      modelLabel: localDraftModelLabel(),
    });

    // Backstop: instead of requeueing for ANOTHER doomed 35-turn pass, run a single-call
    // decompose pass. Two triggers, both meaning "this model cannot land this in one pass":
    //   - turnBudgetExhausted: a pass burned its whole budget without a single edit.
    //   - decomposeBlockCount >= 2: the model answered RESOLUTION: decompose on two separate
    //     passes but never produced usable sub-task JSON (agentic-draft-common.js counts it).
    // Fires on ANY give-up verdict, not just verdict.blocked: confirmed live 2026-09-02
    // (second-brain note-graph, gpu-single-flight-lock, job-list) -- after two decompose
    // blocks the model punts the 3rd pass to needs-human-decision (a no-RESOLUTION forced
    // summary, or a real needs-human-decision), which is `blocked:false, needsClarification:
    // true`, so this gate was skipped and the deterministic split never ran -- all three
    // landed in needs-clarification/ with a placeholder non-question instead of a coordinator.
    const autoN = Number(task.autoDecomposeCount) || 0;
    const repeatedDecompose = (Number(task.decomposeBlockCount) || 0) >= 2;
    const gaveUp = verdict.blocked || verdict.needsClarification;
    // A file-decompose child is already a single verbatim move -- splitting it again just
    // produces a hub of one sub-task and loops. If it can't land, it needs a human, not
    // another decompose pass.
    if (!task.atomic && gaveUp && (task.turnBudgetExhausted || repeatedDecompose) && autoN < MAX_AUTO_DECOMPOSE) {
      const mode = task.turnBudgetExhausted ? 'post-exhaustion' : 'repeated-decompose';
      const split = await runDecomposePass(task, {
        mode,
        priorAttemptBlock: priorAttemptAnalysisBlock(task),
      });
      if (split && split.subTasks.length >= 2) {
        task.autoDecomposeCount = autoN + 1;
        task.adhocResolution = 'decompose';
        task.subTaskProposals = split.subTasks;
        task.rawDiff = '';
        const why = task.turnBudgetExhausted
          ? 'a turn-budget-exhausted implement pass'
          : 'two implement passes that both chose RESOLUTION: decompose without usable pieces';
        task.implementResponse = `Auto-decomposed after ${why} (${split.subTasks.length} pieces).\n\n${verdict.blockedReason || ''}`;
        delete task.turnBudgetExhausted;
        delete task.retryableDraftBlock;
        delete task.rescopedRawText;
        // The give-up verdict may have stamped a needs-clarification routing on the task
        // (needs-human-decision / no-RESOLUTION forced summary) -- clear it so recordApplyOutcome
        // routes this to the decompose/coordinator path, not queue/needs-clarification/.
        delete task.needsClarification;
        delete task.priorPartialDiff;
        delete task.isAgenticContinuation;
        return {
          succeeded: true, blocked: false, resolution: 'decompose',
          response: verdict.response, toolCallLog: verdict.toolCallLog, turnsUsed: verdict.turnsUsed,
        };
      }
    }
    return verdict;
  } catch (e) {
    return { succeeded: false, reason: `local write-agentic draft failed: ${e.message}` };
  }
}

function modelStatsSafe(fn, args) {
  try { fn(args); } catch { /* telemetry must never break a draft */ }
}

module.exports = {
  draftAdhocViaLocalAgenticWrite, isEnabled, buildWriteAgenticPrompt, LOCAL_AGENTIC_WRITE_MAX_TURNS,
  isLeafTask, priorAttemptAnalysisBlock,
};
