'use strict';

// Draft step: runs a claimed task through plan -> implement -> critique -> (revision)
// against the local Ornith model, then files the result into queue/review/ (success) or
// queue/blocked/ (degenerate response at any pass). No file-moving is done here -- the
// caller (ornith-worker.sh) owns claim/move, same division of labor as apply-task.js vs.
// apply-task.sh.
//
// This is a straight port of the plan/implement/critique/revision sequence in
// src/ornith-worker.ps1 (the only place that logic previously existed), trimmed to the
// domains actually reachable from task-domains.json (deep_dive, project_search,
// brain_dump_sort, secondbrain, default, adhoc) -- arch_discovery/arch_import's extra
// structural-check pass (arch-discovery-structcheck.js) is deliberately NOT ported here
// since neither domain is wired up outside the Windows path yet.
//
// project_search also needs the harness-fetch step ornith-worker.ps1 runs BETWEEN plan and
// implement (real GitHub/Hugging Face search results for the queries the plan pass
// proposed, via project-search-fetch.js) -- missed on the first pass of this port.
// Confirmed live 2026-08-14: without it, task.promptContext.searchResults stayed
// `undefined` for every project_search draft, and Ornith -- explicitly told "write 0 to N
// findings from the REAL results above -- do not invent a project that is not listed" --
// responded by inventing well-known project names from its own training data instead
// (one draft's own text: "actual web search tools are not available in this interface"),
// in the wrong format besides (not the required `### PROJECT: name` blocks), so
// apply-group-a.js's parser found zero real findings in EVERY one of 17+ completed
// project_search tasks despite several genuinely listing real-sounding projects.
//
// CLI: node ornith-draft.js <draft.json>
// Writes ONE line of JSON to stdout:
//   { succeeded: true, blocked: false }
//   { succeeded: true, blocked: true, blockedReason: '...', blockedStage?: '...' }
//   { succeeded: false, reason: '...' }
// The caller re-reads the (possibly mutated) task file from disk afterward -- this script
// writes the updated task JSON back to the SAME path it was given, in place, exactly like
// apply-task.js leaves file-moving to its own caller.

const fs = require('fs');
const { call } = require('./ornith-client.js');
const { buildPlanPrompt, buildImplementPrompt, buildCritiquePrompt, buildRevisionPrompt } = require('./prompts.js');
const { runSearches } = require('./project-search-fetch.js');
const { recordCall: defaultRecordModelCall } = require('./model-stats-client.js');

function writeTaskJson(taskPath, task) {
  fs.writeFileSync(taskPath, JSON.stringify(task, null, 2));
}

/**
 * The actual draft logic, independent of the CLI/stdout wrapper below -- exported so tests
 * can call it directly with a fake ornithCall.
 * @param {object} task - The parsed task record (mutated in place with pass results).
 * @param {object} [deps]
 * @param {function} [deps.ornithCall] - Defaults to ornith-client.js's call().
 * @returns {Promise<{succeeded: boolean, blocked?: boolean, blockedReason?: string, blockedStage?: string, reason?: string}>}
 */
async function draftTask(task, { ornithCall = call, projectSearchFetch = runSearches, recordModelCall = defaultRecordModelCall } = {}) {
  try {
    // Pre-drafted task escape hatch: an explicit task.preDrafted===true flag (set by a
    // human, or an orchestrating agent acting as architect) that already knows the exact
    // implementResponse -- skips plan+implement entirely, straight to critique. Matches
    // ornith-worker.ps1's isPreDrafted check EXACTLY (an explicit flag, requiring non-empty
    // implementResponse) -- NOT "does implementResponse happen to already have a value",
    // which was this file's original (wrong) heuristic. That wrong heuristic meant ANY
    // requeued/retried task (reject-retry-check.js moves blocked->pending without clearing
    // planResponse/implementResponse, by design -- priorRejectionFeedback is what's SUPPOSED
    // to inform the next attempt) hit this branch and skipped straight to critique on its
    // stale, ALREADY-REJECTED implementResponse from the prior attempt -- reject-retry-
    // requeue's entire purpose (a FRESH redraft) silently never happened. Confirmed live
    // 2026-08-14: every task in queue/drafting/ or queue/pending/ with ornithRejectCount>0
    // already had planResponse+implementResponse populated from its original (rejected)
    // attempt.
    const isPreDrafted = task.preDrafted === true && !!task.implementResponse;

    let planResult;
    if (isPreDrafted) {
      if (!task.planResponse) {
        task.planResponse = 'Pre-drafted task: the exact implementResponse below was specified directly by the caller, not produced by a plan+implement pass.';
      }
    } else {
      const planPrompt = buildPlanPrompt(task);
      planResult = await ornithCall({ prompt: planPrompt, think: true, temperature: 0.4, numPredict: 1400 });
      if (planResult.degenerate) {
        return {
          succeeded: true,
          blocked: true,
          blockedReason: `Plan pass degenerate: ${planResult.degenerate}`,
        };
      }
      task.planResponse = planResult.response;

      // project_search's plan pass proposes search queries only (Ornith has no network
      // access); the HARNESS runs them here, between plan and implement, and hands real
      // results to the implement pass -- see ADR-0018 / docs/project-search-pipeline.md.
      // Without this, task.promptContext.searchResults stays undefined and Ornith invents
      // projects from training data instead of reporting on real search results, despite
      // being explicitly told not to (confirmed live 2026-08-14, see this file's header).
      if (task.source === 'project_search') {
        const queries = [...task.planResponse.matchAll(/^QUERY:\s*(.+)$/gm)].map((m) => m[1].trim()).filter(Boolean);
        let searchResults = [];
        if (queries.length > 0) {
          try {
            searchResults = await projectSearchFetch(queries);
          } catch (e) {
            // Non-fatal -- implement proceeds with no results (its own prompt already
            // handles an empty results list: "(no results -- the searches returned nothing
            // usable)"), same as ornith-worker.ps1's own try/catch around this call.
          }
        }
        task.promptContext.searchResults = searchResults;
      }

      const implPrompt = buildImplementPrompt(task, task.planResponse);
      const implStartedAt = new Date().toISOString();
      const implStartMs = Date.now();
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
      const implNumPredict = hasFixedLiterals
        ? Math.min(8000, Math.max(1400, fixedLiteralsChars))
        : Math.min(8000, Math.max(2800, planChars * 2));
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
      const implNumCtx = Math.min(32768, Math.max(8192, Math.ceil(implPrompt.length / 3) + implNumPredict + 2048));
      const implResult = await ornithCall({ prompt: implPrompt, think: !hasFixedLiterals, temperature: 0.4, numPredict: implNumPredict, numCtx: implNumCtx });

      // Records this implement-pass call into model-stats.db (powers the dashboard's
      // Models tab) and stamps task.abCallId so a later outcome (review verdict, watchdog
      // requeue) can be joined back to this same row -- port of ornith-worker.ps1's own
      // record-call-after-implement placement. Confirmed live 2026-08-14: model-stats.db
      // was never created at all (better-sqlite3, the dependency model-stats-db.js needs,
      // wasn't installed -- `npm install` had simply never been run on this Linux install),
      // AND this instrumentation itself had never been ported here regardless.
      task.abCallId = recordModelCall({
        taskId: task.id,
        model: process.env.ORNITH_MODEL || 'ornith',
        startedAt: implStartedAt,
        latencyMs: Date.now() - implStartMs,
        result: implResult,
      });

      if (implResult.degenerate) {
        return {
          succeeded: true,
          blocked: true,
          blockedReason: `Implement pass degenerate: ${implResult.degenerate}`,
        };
      }
      task.implementResponse = implResult.response;
    }

    // Critique + revision: a second, independent model call reviews the drafter's own
    // implement output before it ever reaches the review queue.
    const critiquePrompt = buildCritiquePrompt(task, task.planResponse, task.implementResponse);
    const critiqueResult = await ornithCall({ prompt: critiquePrompt, think: true, temperature: 0.4, numPredict: 900 });

    if (critiqueResult.degenerate) {
      task.critiqueOutcome = 'critique-degenerate';
    } else if (critiqueResult.response.trim() === 'NO ISSUES FOUND') {
      task.critiqueOutcome = 'no-issues';
    } else {
      task.critiqueOutcome = 'issues-flagged';
      const revisePrompt = buildRevisionPrompt(task, task.planResponse, task.implementResponse, critiqueResult.response);
      const reviseResult = await ornithCall({ prompt: revisePrompt, think: true, temperature: 0.4, numPredict: 1400 });
      if (!reviseResult.degenerate) {
        task.implementResponse = reviseResult.response;
        task.revisionApplied = true;
      }
      // Revision came back degenerate: bounded to one attempt, leave original draft
      // intact rather than lose a working draft to a bad revision call.
    }

    task.status = 'needs-review';
    task.history = (task.history || []).concat([{ status: 'needs-review', at: new Date().toISOString() }]);

    return { succeeded: true, blocked: false };
  } catch (e) {
    return { succeeded: false, reason: e.message };
  }
}

async function main() {
  const taskPath = process.argv[2];
  if (!taskPath) {
    process.stdout.write(JSON.stringify({ succeeded: false, reason: 'usage: node ornith-draft.js <draft.json>' }));
    return;
  }

  let task;
  try {
    task = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
  } catch (e) {
    process.stdout.write(JSON.stringify({ succeeded: false, reason: `Could not read/parse task JSON: ${e.message}` }));
    return;
  }

  const result = await draftTask(task);
  // Persist whatever pass results/status landed on the task, even when blocked -- so the
  // caller can move the file and the blocked reason travels with it.
  if (result.succeeded) {
    if (result.blocked) {
      task.blockedReason = result.blockedReason;
      if (result.blockedStage) task.blockedStage = result.blockedStage;
    }
    writeTaskJson(taskPath, task);
  }
  process.stdout.write(JSON.stringify(result));
}

module.exports = { draftTask };

if (require.main === module) {
  main();
}
