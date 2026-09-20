'use strict';

// implement-critique.js -- extracted from src/local-draft.js ([[hub-task-integration]] node-module decompose).

const { buildPlanPrompt, buildImplementPrompt, buildCritiquePrompt, buildRevisionPrompt } = require('../prompts.js');
const { appendHistoryEvent, setHistoryPersistHook } = require('../task-history.js');
const {
  beginDraftAttempt, recordPlan, recordImplement, recordCritique, recordOrient, recordPlanCritique, recordTier, finalizeDraftAttempt,
} = require('../draft-attempt-record.js');
const { providerFor, labelFor, resolveModelProfile } = require('../model-provider.js');
const { getConfig, ensureRegistered } = require('../config.js');
const { resolveSourceName, getRegisteredSource } = require('../task-source-registry.js');
const { symbolCheckBlocks } = require('../candidate-path-grounding.js');
const { usesGroupB } = require('./apply-core.js');
const { parseJsonMaybeFenced } = require('../json-fence.js');
const { selectAbModel } = require('../ab-model-select.js');
const { resolveStrategy } = require('../model-strategies.js');
const { PINNED_NUM_CTX, EXTENDED_NUM_CTX } = require('../gpu-capacity.js');
const { postJson } = require('../ollama-http.js');
const { logPipelineEvent } = require('../pipeline-history.js');
const { PER_CALL_TIMEOUT_CEILING_MS } = require('../local-client.js');
const { getModelProfile } = require('../model-profile-registry.js');
const { isCandidateFulfillmentSource, refreshCandidateFetchedFiles, isEmptyApprovalSource, isAdvisoryProseSource, parseHarnessQueries, runHarnessSearch, extractCandidateSnippet, distinctiveLine, findEditFarFromAnchor } = require('./harness-search.js');

// For a Group B source (JSON edits, or the FALSE POSITIVE escape line) the revision must still be that shape. Any other source's
// revision is free-form by design, so it is always kept, exactly as before.
function revisionKeepsAnswerShape(task, revised) {
  if (!usesGroupB(task)) return true;
  const text = String(revised || '').trim();
  if (!text) return false;
  if (text.includes('FALSE POSITIVE')) return true;
  try {
    const parsed = parseJsonMaybeFenced(text);
    return parsed !== null && parsed !== undefined;
  } catch {
    return false;
  }
}

async function runCritiqueAndRevision(task, {
  maybeLocked, resolvedCallIsLocal, resolvedLocalCall, profileSupportsThink, attempt, recordModelCall,
}) {
  if (isAdvisoryProseSource(resolveSourceName(task))) {
    return;
  }

  // Advisory pre-critique fact-check on the IMPLEMENT RESPONSE (brain-dump
  // bd-1788725054994): missingFileCheck (src/draft-file-guard.js -- a pure checkDraft
  // wrapper) flags file paths the draft names that do not exist in the repo and are not
  // its own create targets. Merged into task.preFilterFlags so buildCritiquePrompt
  // surfaces them to the critic as leads. Deliberately NOT a hard block: checkFilePaths
  // over-matches prose/example paths, which is exactly why review-task.js has always
  // treated missing-file as a reviewer hint, never an auto-reject. Best-effort -- any
  // failure leaves task.preFilterFlags untouched and critique proceeds unchanged.
  try {
    const cfg = getConfig();
    const { missing } = require('../draft-file-guard.js').missingFileCheck(
      task.implementResponse || '',
      cfg.repoRoot,
      Array.isArray(cfg.grepAllowedDirs) ? cfg.grepAllowedDirs : [],
    );
    if (Array.isArray(missing) && missing.length) {
      const existing = Array.isArray(task.preFilterFlags) ? task.preFilterFlags : [];
      const seen = new Set(existing.map((f) => `${f.type} ${f.detail}`));
      const added = missing
        .map((p) => ({ type: 'missing-file', detail: p }))
        .filter((f) => !seen.has(`${f.type} ${f.detail}`));
      if (added.length) task.preFilterFlags = [...existing, ...added];
    }
  } catch (err) {
    console.warn('[local-draft] pre-critique missing-file check failed (advisory):', (err && err.message) || err);
  }

  const critiquePrompt = buildCritiquePrompt(task, task.planResponse, task.implementResponse);
  let startedAt = new Date().toISOString();
  let startMs = Date.now();
  const critiqueResult = await maybeLocked(resolvedCallIsLocal, () => resolvedLocalCall({ prompt: critiquePrompt, think: profileSupportsThink, temperature: 0.4, numPredict: 900, source: task.source, taskId: task.id, stage: 'critique' }), 'critique');
  // Records the critique (and, when triggered, revise) call into model-stats.db -- see
  // runPlanPass's own identical comment for the full incident this closes (2026-09-06,
  // Grimmethy: "We need to fix cost tracking before we can even begin to properly work
  // on this problem").
  if (recordModelCall) {
    recordModelCall({ taskId: task.id, model: labelFor(task), startedAt, latencyMs: Date.now() - startMs, result: critiqueResult, source: task.source, stage: 'critique' });
  }

  // Gate critique-done on a grounding check: for sources whose drafts cite REAL code
  // (deep_dive, or any registered source with its own postImplementCheck), an ungrounded
  // draft must not reach the review queue -- block it right here, before any revise call
  // or degenerate/no-issues assignment. Advisory: a throwing check never blocks a real
  // draft (same contract as the postImplementCheck disposition in runImplementPass).
  {
    const src = resolveSourceName(task);
    const regEntry = getRegisteredSource(src);
    const realFiles = (task.promptContext && Array.isArray(task.promptContext.files))
      ? task.promptContext.files.filter((f) => f && typeof f.content === 'string')
      : [];
    if (realFiles.length > 0 && (src === 'deep_dive' || (regEntry && typeof regEntry.postImplementCheck === 'function'))) {
      let groundingVerdict = null;
      try {
        groundingVerdict = await require('../deep-dive-grounding-check.js').runGroundingCheck(task, task.implementResponse, { call: resolvedLocalCall });
      } catch (e) {
        console.warn('[local-draft] grounding check failed (advisory):', (e && e.message) || e);
      }
      // The generic check below was written for deep_dive write-ups. On the arch candidate
      // generators (candidateDocFormat: arch_discovery/arch_import) it hard-blocked real drafts:
      // it greps backticked filenames (`legalContent.tsx` -- TS imports omit the extension, so
      // ".tsx" never appears in any file's content) and proposed class-shaped names against the
      // fetched content (2026-09-19, PF arch-discovery-community-1). Same decision as their own
      // postImplementCheck symbol check: warn (task.groundingWarnings -> the review votes), don't
      // block. AGENT_MANAGER_SYMBOL_CHECK_BLOCKING=true restores the block.
      if (groundingVerdict && groundingVerdict.verdict === 'ungrounded'
          && regEntry && regEntry.candidateDocFormat && !symbolCheckBlocks()) {
        const warning = `critique-time grounding check could not verify: ${String(groundingVerdict.reason || '(no detail)').slice(0, 250)}`;
        task.groundingWarnings = [...(Array.isArray(task.groundingWarnings) ? task.groundingWarnings : []), warning].slice(0, 10);
        appendHistoryEvent(task, 'grounding-warning', warning.slice(0, 300));
      } else if (groundingVerdict && groundingVerdict.verdict === 'ungrounded') {
        const blockedReason = `Ungrounded draft: ${String(groundingVerdict.reason || '(no detail)')}`.slice(0, 500);
        task.critiqueOutcome = 'grounding-failed';
        task.blockedStage = 'review';
        task.blockedReason = blockedReason;
        // Stochastic harness gate, not a genuine reviewer rejection -- see local-draft.js's
        // sibling postImplementCheck gate for the full reasoning; this is its other real
        // site (moved here from local-draft.js by the #226 decompose).
        task.reviewInconclusive = true;
        task.priorRejectionFeedback = Array.isArray(task.priorRejectionFeedback) ? task.priorRejectionFeedback : [];
        task.priorRejectionFeedback.push(blockedReason);
        recordCritique(attempt, { outcome: 'grounding-failed' });
        appendHistoryEvent(task, 'critique-done', blockedReason);
        return;
      }
    }
  }

  // task.critiqueOutcome is a STRING enum, NOT an object: it has no `.facts` property.
  // The only values it ever holds are the four outcome literals assigned just below
  // ('no-issues' | 'grounding-failed' | 'critique-degenerate' | 'issues-flagged').
  // Structured findings live in a SEPARATE field -- task.preFilterFlags (an
  // Array<{ type: string, detail: string }>, populated by the pre-filter fact-check
  // and the missingFileCheck advisory above) -- NOT on critiqueOutcome itself.
  /** @type {'no-issues'|'grounding-failed'|'critique-degenerate'|'issues-flagged'} */
  if (critiqueResult.degenerate) {
    task.critiqueOutcome = 'critique-degenerate';
    // 2026-09 (degenerate-as-skip): a degenerate critique response is a FAILURE of the
    // critic call, not a completed critique pass -- falling through to the shared
    // recordCritique() / 'critique-done' tail made it look like a pass signal downstream.
    // Mirror the advisory-prose early-return above: mark the outcome, log the skip, and
    // stop before the shared recordCritique / 'critique-done' tail.
    appendHistoryEvent(task, 'critique-skipped', 'degenerate model response -- not a pass signal');
    return;
  }
  if (critiqueResult.response.trim() === 'NO ISSUES FOUND') {
    task.critiqueOutcome = 'no-issues';
  } else {
    task.critiqueOutcome = 'issues-flagged';
    // 2026-08-24 (pipeline hardening): only the OUTCOME enum used to survive past this
    // function -- the actual critique text was discarded the moment the revision call
    // finished, so review-task.js's buildVerdictPrompt had no way to show a reviewer
    // what the critique actually found, even when a revision WAS applied and the
    // reviewer might want to verify it really addressed those specific points.
    task.critiqueText = critiqueResult.response;
    const revisePrompt = buildRevisionPrompt(task, task.planResponse, task.implementResponse, critiqueResult.response);
    startedAt = new Date().toISOString();
    startMs = Date.now();
    const reviseResult = await maybeLocked(resolvedCallIsLocal, () => resolvedLocalCall({ prompt: revisePrompt, think: profileSupportsThink, temperature: 0.4, numPredict: 1400, source: task.source, taskId: task.id, stage: 'revise' }), 'revise');
    if (recordModelCall) {
      recordModelCall({ taskId: task.id, model: labelFor(task), startedAt, latencyMs: Date.now() - startMs, result: reviseResult, source: task.source, stage: 'revise' });
    }
    // A revision that is not the answer SHAPE this source requires is not a revision. PF function-length-fix-ac-3 (2026-09-20): the
    // critique correctly spotted a curly-vs-straight quote mismatch, and the revise call answered with commentary about it ("The critique
    // flags a mismatch...") instead of the corrected edits; that prose replaced the draft, review's deterministic gate rejected it as
    // meta-commentary, and all three redrafts died the same way (21 agent-manager tasks have hit the same gate). Keep the original.
    const revised = reviseResult.response;
    if (!reviseResult.degenerate && revisionKeepsAnswerShape(task, revised)) {
      task.implementResponse = revised;
      task.revisionApplied = true;
    } else if (!reviseResult.degenerate) {
      task.revisionDiscarded = true;
      appendHistoryEvent(task, 'advisory', `critique revision discarded: not valid edits (${String(revised || '').trim().slice(0, 80).replace(/\s+/g, ' ')}...) -- kept the original draft`);
    }
    // Revision came back degenerate: bounded to one attempt, leave original draft
    // intact rather than lose a working draft to a bad revision call.
  }
  recordCritique(attempt, { outcome: task.critiqueOutcome, revised: !!task.revisionApplied });
  appendHistoryEvent(task, 'critique-done', task.revisionApplied ? `${task.critiqueOutcome}, revised` : task.critiqueOutcome);
}

async function ensureHeadroomForExtendedContext(implNumCtx, task) {
  if (!(implNumCtx > PINNED_NUM_CTX)) return { evicted: false };
  const smallModel = getModelProfile('brain-dump-cheap-local')?.model;
  if (!smallModel) return { evicted: false };
  const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
  let succeeded = false;
  let errorMessage = null;
  try {
    await postJson(`${ollamaUrl}/api/generate`, { model: smallModel, keep_alive: 0 }, 10_000);
    succeeded = true;
  } catch (err) {
    // best-effort -- see comment above -- but still logged below either way.
    errorMessage = String((err && err.message) || err).slice(0, 300);
  }
  try {
    const { pipelineDir } = getConfig();
    logPipelineEvent(pipelineDir, 'model-eviction', {
      taskId: task && task.id, source: task && task.source, implNumCtx,
      evictedModel: smallModel, succeeded, errorMessage,
      instanceId: process.env.AGENT_MANAGER_INSTANCE_ID || null,
    });
  } catch { /* best-effort -- see logPipelineEvent's own header */ }
  return { evicted: succeeded };
}

function computeImplementBudget(task, implPrompt) {
  // A fixedLiterals task must reproduce that content verbatim, character for
  // character, inside a JSON string value -- JSON-string-escaping alone (every
  // newline becomes a literal \n) inflates the character count well above the raw
  // source, and generation is token-bounded, not character-bounded. The flat 1400
  // cap silently truncated mid-file on a real 190-line fixedLiterals task (confirmed
  // live 2026-08-14: a 6135-char literal, escaping to ~6900 JSON chars, cut off at
  // 5024 chars of output -- caught downstream as "Unterminated string in JSON", not
  // as the token-budget problem it actually was). ~3 chars/token is a conservative
  // (i.e. UNDER-estimating true token count, so this errs toward too much budget
  // rather than too little) ratio for English/code mixed text; the 2x multiplier
  // covers JSON-escaping overhead plus the surrounding {"mode":...,"content":...}
  // envelope. Floor keeps the original 1400 for every task that never had this
  // problem; ceiling bounds worst-case latency/cost for a pathologically large task.
  const fixedLiteralsChars = (task.promptContext && Array.isArray(task.promptContext.fixedLiterals))
    ? task.promptContext.fixedLiterals.reduce((sum, lit) => sum + (lit.content ? lit.content.length : 0), 0)
    : 0;
  const hasFixedLiterals = fixedLiteralsChars > 0;
  // Non-fixedLiterals tasks still run think:true below, so the same starvation this
  // comment block documents for fixedLiterals (reasoning trace consuming the budget
  // before real output is produced) applies to them too -- 1400 was too tight even
  // before accounting for a thinking trace. A flat 2800 floor (tried live 2026-08-16)
  // cleared small/medium tasks but still truncated large multi-file ones -- a
  // 4912-char plan (8 files: chat-server.js, tool-registry.js, priority-scheduler.js,
  // agent-manager.js, ChatPopup.tsx, ToolTogglePanel.tsx, useChatSocket.ts, plus
  // message-protocol.js) cut off after only 1 of 8 files at 4061 output chars, and a
  // 2155-char plan cut off mid-function at 3088 chars. Scaling by plan size (same
  // principle as the fixedLiterals content-derived floor above, just keyed off the
  // plan instead of literal content since there's no literal to measure) tracks task
  // complexity better than either flat number: a plan enumerating many files/steps is
  // the leading signal for how much output the implement pass will need. ~2 chars of
  // plan per token of implement output is calibrated to comfortably clear both
  // real-world cutoffs above; floor keeps the 2800 that already worked for
  // small/medium tasks, ceiling bounds worst-case latency/cost.
  const planChars = (task.planResponse || '').length;
  // product_spec (confirmed live 2026-08-20, romance-plugin's first bootstrap run):
  // this source's implement pass produces a whole standalone document (entities,
  // relationships, a state machine, an API table, decisions) rather than a bounded
  // code diff -- the SAME planChars*2 scaling that comfortably covers "8 files changed"
  // for a code task genuinely undershoots "write the full spec," and got caught mid-
  // document by review's truncation check (correctly -- the alternative is a silently
  // incomplete spec landing as though it were complete). Every OTHER Group B source's
  // output is bounded by how much of an existing file it's allowed to touch; a spec
  // doc has no such natural ceiling, so it gets a higher one instead of the shared
  // 8000-token cap "bounds worst-case latency/cost" default.
  // backlog_decomposition (2026-08-20): same "whole document, no natural ceiling"
  // class as product_spec right above -- its implement pass writes MULTIPLE full
  // AC-NNN candidate write-ups (Problem/Solution/Benefits each) in one call, easily
  // exceeding what a single code diff needs. product_spec_outline (2026-08-30) is the
  // brownfield analogue of backlog_decomposition -- it writes the same multi-candidate
  // AC-NNN block list -- so it belongs in the same higher-ceiling class.
  // pipeline_forensics (2026-09-01): the same "whole document, no natural ceiling" class
  // as product_spec -- its implement pass writes a full ranked root-cause report (RANKING /
  // CONTRAST / RECOMMENDED FIX). But its PLAN is deliberately tiny (2-3 `QUERY:` lines), so
  // the planChars*2 floor lands on 2800 -- and think:true then spends that entire budget on
  // the reasoning trace, emitting zero final content (confirmed live on the first real run:
  // eval_count 2800, implementResponse empty). Its "how much output" signal is the evidence
  // blob, not the plan, so it gets its own higher floor plus the 16000 ceiling.
  // pipeline_debrief (2026-09-06): the identical shape -- a full What/So-What/Now-What
  // report over an evidence blob (debrief-bundle.js), tiny plan. Confirmed live: 2 real
  // debrief tasks blocked "Plan pass degenerate: truncated"/"Implement pass degenerate:
  // truncated" back to back, one of them AFTER its plan pass succeeded -- the implement
  // pass alone still exhausted the un-widened 2800 floor. Belongs in this class for the
  // exact reason pipeline_forensics does.
  const isWholeDocReport = task.source === 'pipeline_forensics' || task.source === 'pipeline_debrief';
  // change_review (2026-09-19, ghost-in-the-machine retroactive audit of the blocked/
  // bucket): the SAME "how much output" signal is the evidence blob, not the plan" shape
  // pipeline_forensics/pipeline_debrief already document above -- its implement pass must
  // walk every hunk of task.promptContext.unitDiff and write a full per-hunk verdict, but
  // that diff is not reflected in planChars at all (change-review.js's own PART 1 plan
  // pass is a short hunk-classification list, not sized to the diff). Confirmed live:
  // change-review-7eecbfa (15057-char diff) and change-review-b8a6f21 (12202-char diff)
  // both hit a 0-char PLAN (the same think:true-eats-the-budget starvation the forensics
  // comment above describes) which collapsed their implement floor to the un-widened 2800,
  // and both then got blocked/exhausted for a review "truncated mid-sentence" -- an
  // unwinnable loop identical in shape to the forensics one, just never given the same fix.
  const isChangeReview = task.source === 'change_review';
  const implNumPredictCeiling = (task.source === 'product_spec' || task.source === 'backlog_decomposition' || task.source === 'product_spec_outline' || isWholeDocReport || isChangeReview) ? 16000 : 8000;
  const unitDiffChars = isChangeReview ? ((task.promptContext && task.promptContext.unitDiff) || '').length : 0;
  // Only above the same 10000-char threshold deterministic-extract.js's computePlanNumPredict
  // uses for the identical reason -- a smaller change_review diff already clears the normal
  // planChars*2 floor below just fine and doesn't need the wider budget.
  const forensicsFloor = isWholeDocReport
    ? Math.max(6000, Math.ceil(((task.promptContext && task.promptContext.evidenceText) || '').length / 8))
    : (isChangeReview && unitDiffChars > 10000)
      ? Math.max(6000, Math.ceil(unitDiffChars / 3))
      : 2800;
  const implNumPredict = hasFixedLiterals
    ? Math.min(implNumPredictCeiling, Math.max(1400, fixedLiteralsChars))
    : Math.min(implNumPredictCeiling, Math.max(forensicsFloor, planChars * 2));
  // think:false when fixedLiterals are present -- num_predict is a cap on TOTAL
  // generated tokens, thinking trace included, so a "think" pass spent reasoning
  // about a plain transcription task eats directly into the same budget the actual
  // output needs. Confirmed live 2026-08-14: raising numPredict from 1400 to 2908
  // for a 4362-char fixedLiterals task STILL truncated at exactly the same char
  // count as the too-small budget before it -- the extra room was being consumed by
  // reasoning, not reaching the output at all. There is nothing to reason about when
  // the task is "copy this exact block character-for-character" -- skip thinking
  // entirely and hand the full budget to the transcription itself.
  //
  // num_ctx must cover prompt + thinking trace + output together, not just output --
  // the 8192 callOnce default was sized for the old flat 1400 numPredict, so scaling
  // numPredict up to 8000 without also raising this would let the context window
  // itself truncate (silently dropping the oldest prompt tokens, e.g. the task
  // instructions) before generation even gets to use the larger output budget. Model
  // supports up to 262144 (`ollama show ornith:35b`), so there's ample headroom;
  // ~3 chars/token for the prompt (same conservative ratio used above) plus the full
  // output budget plus a fixed margin for the thinking trace.
  //
  // FLOOR at PINNED_NUM_CTX (2026-08-31): Ollama fully reloads the model on ANY num_ctx
  // change (~55-100s for the 27B). This value used to vary per-prompt and usually landed
  // on the 8192 floor -- so every draft flipped num_ctx away from the plan pass's and the
  // Chat tool-loop's PINNED_NUM_CTX and paid a reload, WHILE HOLDING the single-flight GPU
  // lock. Confirmed live as the cause of `flock -w 600` lock-acquisition timeouts under
  // 3-way lane contention (worker-1 + worker-reasoning + reviewer), which requeued adhoc
  // drafts indefinitely. Raising the floor to PINNED_NUM_CTX makes the normal case a
  // single stable value shared with every other local-model call -> no reload. The
  // computed need is almost always below the floor anyway; only the whole-document
  // sources (product_spec family, implNumPredict up to 16000) still grow past it, and a
  // one-time reload there beats a truncated spec.
  const implNumCtx = Math.min(EXTENDED_NUM_CTX, Math.max(PINNED_NUM_CTX, Math.ceil(implPrompt.length / 3) + implNumPredict + 2048));
  // Several sources' implement prompts explicitly tell the local model to output the empty
  // string when nothing genuinely applies (see prompts.js) -- an empty response from
  // them is a valid, intended answer, not a failed call, so the degenerate-output
  // detector's 'empty' check must not fire for them (see local-client.js's call()
  // comment for the live-confirmed backlog this caused). The candidateFulfillment
  // ones (arch_review/arch_import_review/observability_fix/performance_fix/
  // backlog_fulfillment/...) are grounded in real fetched file content and explicitly
  // told to output empty rather than fabricate a find/replace when the named file(s)
  // couldn't be read -- a legitimate, expected outcome, same reasoning as arch_import's
  // own empty-on-no-match case. isEmptyApprovalSource() reads this straight off each
  // source's own registerTaskSource() entry now (see its own comment above) instead of
  // a hardcoded array.
  const allowEmptyImplement = isEmptyApprovalSource(task.source);
  // pipeline_forensics: the implement prompt's METHOD section already forces explicit
  // step-by-step reasoning INTO the report itself (a counterfactual line per ranked cause,
  // the contrast paragraph). qwen3 think:true then runs a SECOND full reasoning pass
  // first and, on a task this analytically heavy against ~26KB of evidence, spends the
  // entire num_predict budget inside <think> -- emitting an empty final answer. Confirmed
  // live 2026-09-01: 3 consecutive attempts, ~166s eval each, implementResponse empty
  // every time (this is the same "reasoning trace eats the budget" starvation the
  // fixedLiterals branch above already fixes by disabling think). Hand the whole budget
  // to the report.
  // pipeline_debrief (2026-09-06): same shape -- its METHOD section forces the same kind
  // of explicit reasoning into the report (per-item counterfactual-style Why:, the
  // survivorship-bias check), same evidence-blob size class. Confirmed live: 2 real
  // debrief tasks hit "degenerate: truncated" (doneReason 'length') back to back,
  // including one whose PLAN pass had already succeeded -- the implement pass alone still
  // burned its entire budget on a redundant think trace.
  const implNoThink = hasFixedLiterals || task.source === 'pipeline_forensics' || task.source === 'pipeline_debrief';
  return {
    hasFixedLiterals,
    implNoThink,
    implNumPredict,
    implNumCtx,
    allowEmptyImplement,
    // evalTokCap / latencyMsCap (2026-09-08): hard ceilings on the implement pass's
    // token generation and wall-clock latency, exposed alongside the token/context
    // budgets above. Inert for the local-call path (callImplementModel destructures only
    // the five fields it consumes), but present on the budget object so downstream
    // consumers (retry routing, attempt recording) can read a single cap source.
    evalTokCap: 1000,
    latencyMsCap: 20000,
  };
}

async function callImplementModel(task, ctx, { recordModelCall, implPrompt, budget, coldLoadExpected = false }) {
  const { maybeLocked, resolvedCallIsLocal, resolvedLocalCall, profileSupportsThink } = ctx;
  const { hasFixedLiterals, implNoThink, implNumPredict, implNumCtx, allowEmptyImplement } = budget;
  const implStartedAt = new Date().toISOString();
  const implStartMs = Date.now();
  // coldLoadExpected (2026-09-08, see ensureHeadroomForExtendedContext's own header for
  // the incident): ensureHeadroomForExtendedContext just evicted the small model to make
  // room for THIS call, so a cold multi-minute tensor reload from disk is now likely --
  // give this one call extra headroom on top of the normal throughput-based ceiling
  // rather than let it race the same 150-240s window a fresh load has no chance of
  // finishing inside. COLD_LOAD_TIMEOUT_BUMP_MS (3 min) is a real observed load time for
  // the 18GB q4_K_M model this eviction path exists for.
  const COLD_LOAD_TIMEOUT_BUMP_MS = 180_000;
  const coldLoadTimeoutMs = coldLoadExpected ? PER_CALL_TIMEOUT_CEILING_MS + COLD_LOAD_TIMEOUT_BUMP_MS : undefined;

  // A/B candidate selection for the implement pass ONLY (2026-08-19, port of
  // local-worker.ps1's Select-AbModel -- see ab-model-select.js's own header for why
  // this had zero real callers on Linux until now). LOCAL_AB_MODELS is a
  // comma-separated list, each entry either a bare Ollama model tag, a
  // model-strategies.js registry name, or a "claude:<model>" entry (new: this is the
  // extension that lets an A/B run directly compare a local model against Claude,
  // not just two local models). Empty/single-entry list -> selectAbModel returns null
  // -> abModel stays null -> falls through to resolvedLocalCall exactly as before,
  // the same backward-compatibility guarantee model-strategies.js's own resolveStrategy()
  // already promises. When abModel IS set, it deliberately overrides providerFor(task)'s
  // normal tier-based routing rather than deferring to it -- the whole point of a
  // cross-provider A/B entry is to run BOTH sides against the same real tasks
  // regardless of which tier/provider that task would have used by default.
  const abCandidates = (process.env.LOCAL_AB_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const abCandidateName = selectAbModel(task.id, abCandidates);
  const abStrategy = abCandidateName ? resolveStrategy(abCandidateName) : null;
  const abModel = abStrategy ? abStrategy.model : null;

  let implResult;
  if (abModel && abModel.startsWith('claude:')) {
    const { call: abClaudeCall } = require('../claude-client.js');
    // Never local -- a claude: A/B candidate never touches the local GPU, so no lock.
    implResult = await abClaudeCall({ prompt: implPrompt, model: abModel.slice('claude:'.length), maxTurns: 1, permissionMode: 'dontAsk' });
  } else if (abModel) {
    const { call: abLocalCall } = require('../local-client.js');
    // Always local -- this branch only exists because abModel resolved to a bare
    // Ollama tag, not a "claude:" one, so it always needs the real lock (unlike
    // resolvedCallIsLocal above, this doesn't depend on whether localCall was
    // test-injected, since this branch never calls resolvedLocalCall at all).
    implResult = await maybeLocked(true, () => abLocalCall({
      prompt: implPrompt,
      think: abStrategy.think != null ? abStrategy.think : !hasFixedLiterals,
      temperature: abStrategy.temperature != null ? abStrategy.temperature : 0.4,
      numPredict: abStrategy.numPredict != null ? abStrategy.numPredict : implNumPredict,
      numCtx: implNumCtx,
      allowEmpty: allowEmptyImplement,
      model: abModel,
    }), 'implement');
  } else {
    implResult = await maybeLocked(resolvedCallIsLocal, () => resolvedLocalCall({ prompt: implPrompt, think: profileSupportsThink && !implNoThink, temperature: 0.4, numPredict: implNumPredict, numCtx: implNumCtx, allowEmpty: allowEmptyImplement, source: task.source, taskId: task.id, stage: 'implement', timeoutMs: coldLoadTimeoutMs }), 'implement');
  }

  // Records this implement-pass call into model-stats.db (powers the dashboard's
  // Models tab) and stamps task.abCallId so a later outcome (review verdict, watchdog
  // requeue) can be joined back to this same row -- port of local-worker.ps1's own
  // record-call-after-implement placement. Confirmed live 2026-08-14: model-stats.db
  // was never created at all (better-sqlite3, the dependency model-stats-db.js needs,
  // wasn't installed -- `npm install` had simply never been run on this Linux install),
  // AND this instrumentation itself had never been ported here regardless.
  task.abCallId = recordModelCall({
    taskId: task.id,
    // Reflects whichever backend actually served this call -- was hardcoded
    // 'ornith' from before model-provider.js's per-task-source routing existed,
    // which would have silently mislabeled every Claude-served call as the local model in
    // model-stats.db (the Models tab's own data source) the moment that routing
    // was used for anything. abModel (when an A/B candidate was actually selected)
    // takes precedence over labelFor(task) the same way it took precedence over
    // resolvedLocalCall above -- labelFor(task) only knows about providerFor(task)'s
    // normal tier routing, not this call's deliberate override of it.
    model: abModel || labelFor(task),
    candidates: abCandidates.length > 1 ? abCandidates.join(',') : null,
    startedAt: implStartedAt,
    latencyMs: Date.now() - implStartMs,
    result: implResult,
    // source (2026-09-06, Grimmethy: "We need to fix cost tracking before we can even
    // begin to properly work on this problem" -- an efficiency analysis found every
    // per-source cost/degenerate-rate breakdown was blind, because this call never
    // passed it: 705 of 797 real model_calls rows in a 48h sample had source=NULL,
    // forcing every prior analysis to guess a source from the task_id string instead of
    // reading the real field this row already had access to).
    source: task.source,
    stage: 'implement',
  });
  // Stamped onto the task itself (not just recorded into model-stats.db, which
  // apply-task.js has no access path back to via just task.abCallId) so its commit
  // message can attribute Co-Authored-By to whichever backend actually drafted the
  // change instead of always crediting the local model -- see apply-task.js's own comment.
  task.draftModel = abModel || labelFor(task.source);
  return implResult;
}

module.exports = { revisionKeepsAnswerShape, runCritiqueAndRevision, ensureHeadroomForExtendedContext, computeImplementBudget, callImplementModel };
