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
const { buildPlanPrompt, buildImplementPrompt, buildCritiquePrompt, buildRevisionPrompt } = require('./prompts.js');
const { runSearches } = require('./project-search-fetch.js');
const { fetchForQueries: archImportFetch } = require('./arch-import-fetch.js');
const { recordCall: defaultRecordModelCall } = require('./model-stats-client.js');
const { appendHistoryEvent } = require('./task-history.js');
const { providerFor, labelFor } = require('./model-provider.js');
const { draftAdhocImplement } = require('./adhoc-agentic-draft.js');
const { draftResearchImplement } = require('./research-agentic-draft.js');
const { resolveSourceName } = require('./task-source-registry.js');
const { selectAbModel } = require('./ab-model-select.js');
const { resolveStrategy } = require('./model-strategies.js');

function writeTaskJson(taskPath, task) {
  fs.writeFileSync(taskPath, JSON.stringify(task, null, 2));
}

/**
 * The actual draft logic, independent of the CLI/stdout wrapper below -- exported so tests
 * can call it directly with a fake ornithCall.
 * @param {object} task - The parsed task record (mutated in place with pass results).
 * @param {object} [deps]
 * @param {function} [deps.ornithCall] - Defaults to model-provider.js's per-task-source
 *   pick (ornith-client.js's call() unless task.source is listed in
 *   AGENT_MANAGER_CLAUDE_SOURCES, in which case claude-client.js's call()).
 * @returns {Promise<{succeeded: boolean, blocked?: boolean, blockedReason?: string, blockedStage?: string, reason?: string}>}
 */
async function draftTask(task, { ornithCall = null, projectSearchFetch = runSearches, recordModelCall = defaultRecordModelCall, draftAdhocImplementFn = draftAdhocImplement, draftResearchImplementFn = draftResearchImplement } = {}) {
  // Resolved here rather than as a static default param: the right backend depends on the
  // task's reasoning tier (model-provider.js's reasoningTierFor()), which isn't known
  // until the task object itself is in hand -- passing the whole task (not just
  // task.source) lets a per-instance task.reasoningTier override take effect, e.g. Brain
  // Dump #77's automatic high-reasoning retry for a needs-clarification task. Explicit
  // test/caller overrides (ornithCall passed in) always win -- this only fills the gap
  // production code leaves (ornith-draft.js's own main() calls draftTask(task) with no
  // second argument at all).
  const resolvedOrnithCall = ornithCall || providerFor(task).call;
  try {
    appendHistoryEvent(task, 'draft-started', task.ornithRejectCount ? `retry ${task.ornithRejectCount}` : undefined);
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
      planResult = await resolvedOrnithCall({ prompt: planPrompt, think: true, temperature: 0.4, numPredict: 1400 });
      if (planResult.degenerate) {
        const blockedReason = `Plan pass degenerate: ${planResult.degenerate}`;
        appendHistoryEvent(task, 'blocked', blockedReason);
        return {
          succeeded: true,
          blocked: true,
          blockedReason,
        };
      }
      task.planResponse = planResult.response;
      appendHistoryEvent(task, 'plan-done', `${planResult.attempts} attempt(s), ${task.planResponse.length} chars`);

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
        appendHistoryEvent(task, 'harness-search', `${queries.length} quer(y/ies), ${searchResults.length} result(s)`);
      }

      // arch_import's plan pass proposes search terms for agent-manager's OWN repo (same
      // two-call shape as project_search above, grep instead of an HTTP API -- see
      // arch-import-fetch.js and archImportImplementPrompt in prompts.js), but this branch
      // was never ported here (see this file's header: arch_import's extra pass was
      // "deliberately NOT ported ... since neither domain is wired up outside the Windows
      // path yet"), even though task-sources.js keeps generating real arch_import tasks
      // that flow through this same generic pending/ pipeline regardless. Without it,
      // task.promptContext.harnessHits/harnessFiles stayed permanently undefined, so
      // archImportImplementPrompt's hits.length>0 branch was unreachable for every single
      // arch_import task -- confirmed live 2026-08-16: 44 of the arch_import tasks in
      // queue/blocked/, every one of them with harnessHits.length===0, either correctly
      // (but uselessly) reporting "nothing found" or -- far more often -- fabricating
      // plausible-looking file paths/imports the fact-check then caught as non-existent,
      // because implement was never given any real grounding to work from.
      if (task.source === 'arch_import') {
        const queries = [...task.planResponse.matchAll(/^QUERY:\s*(.+)$/gm)].map((m) => m[1].trim()).filter(Boolean);
        let harnessHits = [];
        let harnessFiles = [];
        if (queries.length > 0) {
          try {
            const result = archImportFetch(queries);
            harnessHits = result.hits || [];
            harnessFiles = result.files || [];
          } catch (e) {
            // Non-fatal -- implement proceeds with no hits (its own prompt already handles
            // an empty hits list: "(no matches -- the searches found nothing ...)"), same
            // try/catch treatment project_search's branch above gives its own fetch call.
          }
        }
        task.promptContext.harnessHits = harnessHits;
        task.promptContext.harnessFiles = harnessFiles;
        appendHistoryEvent(task, 'harness-search', `${queries.length} quer(y/ies), ${harnessHits.length} hit(s), ${harnessFiles.length} file(s)`);
      }

      // pipeline_self_audit (2026-08-20, moved off Claude -- see pipeline-self-audit.js's
      // own header): exact same two-call shape as arch_import immediately above, and
      // literally the SAME archImportFetch -- both search agent-manager's own repo, the
      // only difference is what's IN promptContext (a failure-pattern's evidence vs. an
      // external finding's rationale), which lives entirely in the prompt text, not this
      // harness step.
      if (task.source === 'pipeline_self_audit') {
        const queries = [...task.planResponse.matchAll(/^QUERY:\s*(.+)$/gm)].map((m) => m[1].trim()).filter(Boolean);
        let harnessHits = [];
        let harnessFiles = [];
        if (queries.length > 0) {
          try {
            const result = archImportFetch(queries);
            harnessHits = result.hits || [];
            harnessFiles = result.files || [];
          } catch (e) {
            // Non-fatal -- same try/catch treatment arch_import's own branch above gives.
          }
        }
        task.promptContext.harnessHits = harnessHits;
        task.promptContext.harnessFiles = harnessFiles;
        appendHistoryEvent(task, 'harness-search', `${queries.length} quer(y/ies), ${harnessHits.length} hit(s), ${harnessFiles.length} file(s)`);
      }

      // adhoc-shaped tasks ("Process now" queues one of these -- see
      // task-source-registry.js's resolveSourceName() for why this checks the SAME
      // resolved name apply-task.js's own writeArtifact() dispatch uses, not a raw
      // task.domain === 'adhoc' check: this project's own task-domains.json has both
      // 'default' and 'adhoc' keys, and default_task_domain() prefers 'default', so a
      // real "Process now" task here carries domain:'default' despite being adhoc-shaped
      // in every other respect -- confirmed live 2026-08-17 testing this exact feature)
      // implement via a real agentic Claude Code CLI call against an isolated git
      // worktree instead of the blind JSON-diff implement pass below -- see
      // adhoc-agentic-draft.js's own header (Brain Dump #67: formalize brain-dump
      // processing inside the app itself, with real file access/test-running instead of
      // a human doing it by hand outside the app). Critique+revision (below) is
      // deliberately skipped for this branch: a blind text-completion "revision" of an
      // already-real unified diff would almost certainly corrupt it (diffs are strict,
      // line-based format; a freeform rewrite is not a safe way to edit one) -- this
      // branch returns directly instead.
      if (resolveSourceName(task) === 'adhoc') {
        const agenticResult = await draftAdhocImplementFn(task, { recordModelCall });
        if (!agenticResult.succeeded) {
          return { succeeded: false, reason: agenticResult.reason };
        }
        if (agenticResult.blocked) {
          appendHistoryEvent(task, 'blocked', agenticResult.blockedReason);
          return { succeeded: true, blocked: true, blockedReason: agenticResult.blockedReason };
        }
        appendHistoryEvent(task, 'implement-done', `agentic, ${(task.implementResponse || '').length} chars, resolution=${task.adhocResolution}`);
        task.status = 'needs-review';
        appendHistoryEvent(task, 'needs-review');
        return { succeeded: true, blocked: false };
      }

      // research_task (Brain Dump #1 follow-up, 2026-08-17): same reasoning as the adhoc
      // branch above -- a real agentic Claude call (WebSearch/WebFetch this time, not
      // Read/Grep/Glob/Edit/Write/Bash against a code repo) already did its own
      // investigation and produced the final write-up; Ornith's own plan/critique/
      // revision loop would add nothing (there's no repo state to reason about, and
      // "revision" of a research write-up the model already finished is redundant with
      // the normal review-task.js pass this still flows into afterward).
      if (task.domain === 'research') {
        const researchResult = await draftResearchImplementFn(task, { recordModelCall });
        if (!researchResult.succeeded) {
          return { succeeded: false, reason: researchResult.reason };
        }
        if (researchResult.blocked) {
          appendHistoryEvent(task, 'blocked', researchResult.blockedReason);
          return { succeeded: true, blocked: true, blockedReason: researchResult.blockedReason };
        }
        appendHistoryEvent(task, 'implement-done', `agentic research, ${(task.implementResponse || '').length} chars`);
        task.status = 'needs-review';
        appendHistoryEvent(task, 'needs-review');
        return { succeeded: true, blocked: false };
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
      // These four sources' implement prompts explicitly tell Ornith to output the empty
      // string when nothing genuinely applies (see prompts.js) -- an empty response from
      // them is a valid, intended answer, not a failed call, so the degenerate-output
      // detector's 'empty' check must not fire for them (see ornith-client.js's call()
      // comment for the live-confirmed backlog this caused).
      const allowEmptyImplement = ['arch_discovery', 'deep_dive', 'arch_import', 'project_search', 'pipeline_self_audit'].includes(task.source);

      // A/B candidate selection for the implement pass ONLY (2026-08-19, port of
      // ornith-worker.ps1's Select-AbModel -- see ab-model-select.js's own header for why
      // this had zero real callers on Linux until now). ORNITH_AB_MODELS is a
      // comma-separated list, each entry either a bare Ollama model tag, a
      // model-strategies.js registry name, or a "claude:<model>" entry (new: this is the
      // extension that lets an A/B run directly compare a local model against Claude,
      // not just two local models). Empty/single-entry list -> selectAbModel returns null
      // -> abModel stays null -> falls through to resolvedOrnithCall exactly as before,
      // the same backward-compatibility guarantee model-strategies.js's own resolveStrategy()
      // already promises. When abModel IS set, it deliberately overrides providerFor(task)'s
      // normal tier-based routing rather than deferring to it -- the whole point of a
      // cross-provider A/B entry is to run BOTH sides against the same real tasks
      // regardless of which tier/provider that task would have used by default.
      const abCandidates = (process.env.ORNITH_AB_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean);
      const abCandidateName = selectAbModel(task.id, abCandidates);
      const abStrategy = abCandidateName ? resolveStrategy(abCandidateName) : null;
      const abModel = abStrategy ? abStrategy.model : null;

      let implResult;
      if (abModel && abModel.startsWith('claude:')) {
        const { call: abClaudeCall } = require('./claude-client.js');
        implResult = await abClaudeCall({ prompt: implPrompt, model: abModel.slice('claude:'.length), maxTurns: 1, permissionMode: 'dontAsk' });
      } else if (abModel) {
        const { call: abOrnithCall } = require('./ornith-client.js');
        implResult = await abOrnithCall({
          prompt: implPrompt,
          think: abStrategy.think != null ? abStrategy.think : !hasFixedLiterals,
          temperature: abStrategy.temperature != null ? abStrategy.temperature : 0.4,
          numPredict: abStrategy.numPredict != null ? abStrategy.numPredict : implNumPredict,
          numCtx: implNumCtx,
          allowEmpty: allowEmptyImplement,
          model: abModel,
        });
      } else {
        implResult = await resolvedOrnithCall({ prompt: implPrompt, think: !hasFixedLiterals, temperature: 0.4, numPredict: implNumPredict, numCtx: implNumCtx, allowEmpty: allowEmptyImplement });
      }

      // Records this implement-pass call into model-stats.db (powers the dashboard's
      // Models tab) and stamps task.abCallId so a later outcome (review verdict, watchdog
      // requeue) can be joined back to this same row -- port of ornith-worker.ps1's own
      // record-call-after-implement placement. Confirmed live 2026-08-14: model-stats.db
      // was never created at all (better-sqlite3, the dependency model-stats-db.js needs,
      // wasn't installed -- `npm install` had simply never been run on this Linux install),
      // AND this instrumentation itself had never been ported here regardless.
      task.abCallId = recordModelCall({
        taskId: task.id,
        // Reflects whichever backend actually served this call -- was hardcoded
        // 'ornith' from before model-provider.js's per-task-source routing existed,
        // which would have silently mislabeled every Claude-served call as Ornith in
        // model-stats.db (the Models tab's own data source) the moment that routing
        // was used for anything. abModel (when an A/B candidate was actually selected)
        // takes precedence over labelFor(task) the same way it took precedence over
        // resolvedOrnithCall above -- labelFor(task) only knows about providerFor(task)'s
        // normal tier routing, not this call's deliberate override of it.
        model: abModel || labelFor(task),
        candidates: abCandidates.length > 1 ? abCandidates.join(',') : null,
        startedAt: implStartedAt,
        latencyMs: Date.now() - implStartMs,
        result: implResult,
      });
      // Stamped onto the task itself (not just recorded into model-stats.db, which
      // apply-task.js has no access path back to via just task.abCallId) so its commit
      // message can attribute Co-Authored-By to whichever backend actually drafted the
      // change instead of always crediting Ornith -- see apply-task.js's own comment.
      task.draftModel = abModel || labelFor(task.source);

      if (implResult.degenerate) {
        const blockedReason = `Implement pass degenerate: ${implResult.degenerate}`;
        appendHistoryEvent(task, 'blocked', blockedReason);
        return {
          succeeded: true,
          blocked: true,
          blockedReason,
        };
      }
      task.implementResponse = implResult.response;
      appendHistoryEvent(task, 'implement-done', `${implResult.attempts} attempt(s), ${task.implementResponse.length} chars`);
    }

    // Critique + revision: a second, independent model call reviews the drafter's own
    // implement output before it ever reaches the review queue.
    const critiquePrompt = buildCritiquePrompt(task, task.planResponse, task.implementResponse);
    const critiqueResult = await resolvedOrnithCall({ prompt: critiquePrompt, think: true, temperature: 0.4, numPredict: 900 });

    if (critiqueResult.degenerate) {
      task.critiqueOutcome = 'critique-degenerate';
    } else if (critiqueResult.response.trim() === 'NO ISSUES FOUND') {
      task.critiqueOutcome = 'no-issues';
    } else {
      task.critiqueOutcome = 'issues-flagged';
      const revisePrompt = buildRevisionPrompt(task, task.planResponse, task.implementResponse, critiqueResult.response);
      const reviseResult = await resolvedOrnithCall({ prompt: revisePrompt, think: true, temperature: 0.4, numPredict: 1400 });
      if (!reviseResult.degenerate) {
        task.implementResponse = reviseResult.response;
        task.revisionApplied = true;
      }
      // Revision came back degenerate: bounded to one attempt, leave original draft
      // intact rather than lose a working draft to a bad revision call.
    }
    appendHistoryEvent(task, 'critique-done', task.revisionApplied ? `${task.critiqueOutcome}, revised` : task.critiqueOutcome);

    task.status = 'needs-review';
    appendHistoryEvent(task, 'needs-review');

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
