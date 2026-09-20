'use strict';

// Draft step: runs a claimed task through plan -> implement -> critique -> (revision)
// against the local model, then files the result into queue/review/ (success) or
// queue/blocked/ (degenerate response at any pass). No file-moving is done here -- the
// caller (local-worker.sh) owns claim/move, same division of labor as apply-task.js vs.
// apply-task.sh.
//
// This is a straight port of the plan/implement/critique/revision sequence in
// src/local-worker.ps1 (the only place that logic previously existed), trimmed to the
// domains actually reachable from task-domains.json (deep_dive, project_search,
// brain_dump_sort, secondbrain, default, adhoc) -- arch_discovery/arch_import's extra
// structural-check pass (arch-discovery-structcheck.js) is deliberately NOT ported here
// since neither domain is wired up outside the Windows path yet.
//
// project_search also needs the harness-fetch step local-worker.ps1 runs BETWEEN plan and
// implement (real GitHub/Hugging Face search results for the queries the plan pass
// proposed, via project-search-fetch.js) -- missed on the first pass of this port.
// Confirmed live 2026-08-14: without it, task.promptContext.searchResults stayed
// `undefined` for every project_search draft, and the local model -- explicitly told "write 0 to N
// findings from the REAL results above -- do not invent a project that is not listed" --
// responded by inventing well-known project names from its own training data instead
// (one draft's own text: "actual web search tools are not available in this interface"),
// in the wrong format besides (not the required `### PROJECT: name` blocks), so
// apply-group-a.js's parser found zero real findings in EVERY one of 17+ completed
// project_search tasks despite several genuinely listing real-sounding projects.
//
// CLI: node local-draft.js <draft.json>
// Writes ONE line of JSON to stdout:
//   { succeeded: true, blocked: false }
//   { succeeded: true, blocked: false, needsClarification: true }
//   { succeeded: true, blocked: true, blockedReason: '...', blockedStage?: '...' }
//   { succeeded: false, reason: '...' }
// The caller re-reads the (possibly mutated) task file from disk afterward -- this script
// writes the updated task JSON back to the SAME path it was given, in place, exactly like
// apply-task.js leaves file-moving to its own caller.

const fs = require('fs');
const path = require('path');
const { buildPlanPrompt, buildImplementPrompt, buildCritiquePrompt, buildRevisionPrompt } = require('./prompts.js');
const { buildPlanGrounding } = require('./plan-grounding.js');
const { buildHubStatusGrounding } = require('./hub-status-grounding.js');
const { resolveAcceptanceCriteria } = require('./acceptance-criteria.js');
const { runOrientPass } = require('./orient-pass.js');
const { runPlanCritique } = require('./plan-critique.js');
const { runSearches } = require('./project-search-fetch.js');
const { fetchForQueries: archImportFetch } = require('./arch-import-fetch.js');
const { resolveAccessibleRoots } = require('./accessible-roots.js');
const { recordCall: defaultRecordModelCall } = require('./model-stats-client.js');
const { appendHistoryEvent, setHistoryPersistHook } = require('./task-history.js');
const {
  beginDraftAttempt, recordPlan, recordImplement, recordCritique, recordOrient, recordPlanCritique, recordTier, finalizeDraftAttempt,
} = require('./draft-attempt-record.js');
const { appendTierWorkLog, pruneWorkLogs } = require('./work-log.js');
const { providerFor, labelFor, resolveModelProfile } = require('./model-provider.js');
const { getConfig, ensureRegistered } = require('./config.js');
const { missingFileCheck } = require('./draft-file-guard.js');
const { planTargetGuard } = require('./plan-target-guard.js');
const { withLock: defaultWithLock } = require('./single-flight-lock.js');
const gpuArbiter = require('./gpu-arbiter.js');
const { parseClarificationOptions } = require('./agentic-draft-common.js');
const { resolveGroundingRef, readFileAtRef } = require('./stacked-grounding.js');
const { runDecomposePass } = require('./decompose-pass.js');
const { checkDraft } = require('./fact-checker.js');
const { draftAdhocViaLocalAgenticWrite } = require('./local-agentic-write-draft.js');
const { draftResearchImplement } = require('./research-agentic-draft.js');
const { resolveSourceName, getRegisteredSource } = require('./task-source-registry.js');
const { selectAbModel } = require('./ab-model-select.js');
const { resolveStrategy } = require('./model-strategies.js');
const { parseJsonMaybeFenced } = require('./json-fence.js');
const { isClaudePaused } = require('./claude-pause.js');
const { writeHeartbeatFile } = require('./heartbeat.js');
const { PINNED_NUM_CTX, EXTENDED_NUM_CTX } = require('./gpu-capacity.js');
const { postJson } = require('./ollama-http.js');
const { checkOllamaReachable } = require('./ollama-health.js');
const { logPipelineEvent } = require('./pipeline-history.js');
const { PER_CALL_TIMEOUT_CEILING_MS } = require('./local-client.js');
const { getModelProfile } = require('./model-profile-registry.js');
const { localOllamaLockKey, writeTaskJson, researchClaudeStatus, isResearchDomainTask, draftDoneDetail, concludeDraft } = require('./lib/draft-lifecycle.js');
const { isCandidateFulfillmentSource, refreshCandidateFetchedFiles, isEmptyApprovalSource, isAdvisoryProseSource, parseHarnessQueries, runHarnessSearch, extractCandidateSnippet, distinctiveLine, findEditFarFromAnchor } = require('./lib/harness-search.js');
const { usesGroupB } = require('./lib/apply-core.js');
const { resolveDraftContext, runStalenessFastpath, draftAdhocBranch, draftResearchBranch } = require('./lib/draft-context.js');
const { computePlanNumPredict, tryDeterministicScriptExtractEdit, tryDeterministicOnePassDecompose, tryDeterministicNodeModuleDecompose, tryDeterministicBlueprintDecompose, tryDeterministicLiteralEdit } = require('./lib/deterministic-extract.js');
const { runCritiqueAndRevision, ensureHeadroomForExtendedContext, computeImplementBudget, callImplementModel } = require('./lib/implement-critique.js');

// 2026-09-08, Grimmethy: "fix worker-1" -- see gpu-arbiter.js's own header for the
// incident (worker-1's qwen2.5:3b starved into repeated hard OLLAMA_TIMEOUTs by
// worker-reasoning's qwen3.8:27b-q4_K_M generating concurrently on the same physical
// GPU). Same OLLAMA_URL default local-client.js/local-tool-client.js already use for the
// real call itself -- this process's own env IS the real endpoint it's about to hit, so
// reading it here (rather than threading a new param through) is exact by construction.
// 2026-09-08, Second Brain [[dspy-refine]] research: dspy.Refine deliberately samples
// EVERY retry at temperature=1.0 (a distinct rollout_id per attempt) specifically to
// avoid attempts collapsing into near-identical repeats -- confirmed against the real
// dspy source, not assumed. Every retry-capable call site below (the plan re-roll,
// implement-retry) used the exact same fixed 0.4 as the first attempt, with no diversity
// mechanism at all -- a second real incident (arch-import-review-ac-4, three retries at
// the same temperature reproducing the same truncated-JSON split three times running)
// makes the cost of that concrete, not just theoretical. Scoped to retry-capable call
// sites ONLY (a call that has ALREADY failed once) -- never the first attempt, so a
// currently-succeeding first try never regresses; more sampling diversity on a call that
// already failed can only help, never hurt.
const RETRY_TEMPERATURE = 1.0;

// Populate the registry with this repo's built-ins AND any AGENT_MANAGER_REGISTER_PATH
// plugin sources (agent-manager-hygiene). local-draft.js's draft path calls
// buildPlanPrompt/buildImplementPrompt (prompts.js), which look the builder up by source
// name on the registry -- without this, a plugin-source task (arch_review,
// observability_fix, ...) hits genericFallbackPlanPrompt and dies with "no prompt template
// for domain=default source=arch_review". Matches apply-task.js / get-grounding-source.js.
// (Before the 2026-08-27 plugin split, requiring prompts.js -> task-sources.js registered
// everything eagerly; it no longer covers plugin sources.)
ensureRegistered();

// research_task drafting is the one path with no local equivalent -- WebSearch/WebFetch
// exist only in the Claude Code CLI (2026-09-01: everything else in the reasoning path
// now runs on the local model). So research runs ONLY when a deployment has explicitly
// opted it onto Claude (AGENT_MANAGER_CLAUDE_SOURCES) AND a token is set AND Claude isn't
// paused; otherwise the task blocks cleanly with a legible reason instead of wedging.
// Returns { ok: true } or { ok: false, reason }.
// 2026-09: routing into the research branch was keyed only on task.domain === 'research',
// so a task titled "Research: ..." that arrived through a different domain (e.g. an
// adhoc-sourced brain-dump spawn) fell straight into the adhoc tier ladder / plan-stage
// model call instead of draftResearchBranch. Same pre-model-call string-gate style as
// detectExternalDependency in local-agentic-write-draft.js: cheap, O(title), deterministic.
// A one-line summary for the 'draft-done' checkpoint, assembled from whatever the draft
// branch already stamped on the task (adhoc resolution, retry count, model). Returns
// undefined when there's nothing worth showing -- appendHistoryEvent then omits `detail`.
// The draft phase is complete and the task is heading to review. Emit an explicit
// 'draft-done' checkpoint -- bookend to the 'draft-started' event above, and the same
// -started/-done pairing plan/implement/critique/review already have -- BEFORE the
// terminal 'needs-review' entry, so the per-task Pipeline History shows the draft phase
// closing, not just the next state opening. (local-worker.ps1 records this seam as
// Invoke-TaskDb 'draft-done'; the bash port never substituted a history event for it.)
// Every draft-success return in draftTask/draftAdhocBranch/research/product_spec funnels
// through here. Idempotent w.r.t. task.status.
// task-sources.js's nextCandidateFulfillmentTask() -- the shared candidate-consumer every
// candidateFulfillment: true source uses, each fetching real file content (fetchedFiles)
// for the exact files their own candidate names, so their implement pass always has real
// content to ground a find/replace in. 2026-08-23: was a hardcoded array here (a near-
// duplicate of allowEmptyImplement just below, and of review-task.js's own now-removed
// EMPTY_APPROVAL_SOURCES) -- now reads the flag straight off each source's own
// registerTaskSource() entry instead, so a plugin's own registration is the only place
// that needs to say so. See function-length-review.js's registration for the pattern.
// promptContext.fetchedFiles is a snapshot taken ONCE at candidate-creation
// (nextCandidateFulfillmentTask, task-sources.js) and, until now, never refreshed before
// the DRAFT prompt was built -- only before review (get-grounding-source.js's
// refreshFetchedFileContent). Confirmed live 2026-09-02: 10 blocked observability_fix
// tasks kept re-drafting a duplicate `import logging` / a stale `except` target, because a
// SIBLING AC on the same file (app.py, hardware_stats.py, ...) had merged its own import
// addition in the meantime and the frozen snapshot still showed the pre-merge file. Re-read
// each fetched path from disk here, re-windowed the same way, so plan + implement +
// findUnverifiedEdit all see current reality. Best-effort: a deleted/moved/unreadable path
// keeps its frozen copy (stale grounding beats none), same fallback as the review path.
// Same shape as isEmptyApprovalSource/isCandidateFulfillmentSource above -- reads the
// advisoryProse flag straight off each source's own registerTaskSource() entry (same
// flag review-task.js's own isAdvisoryProseSource() already reads, not exported from
// there so re-declared here rather than reached into a sibling module's internals).
// Between plan and implement, several task sources need the QUERY: lines their plan pass
// proposed actually run against a real search harness, with the hits handed to the
// implement pass as grounding (rather than leaving the local model to invent file paths or
// projects -- see this file's header). `harnessSearch` on the source's registration says
// which harness: 'archImport' greps agent-manager's own repo (archImportFetch ->
// promptContext.harnessHits/harnessFiles); 'projectSearch' hits the GitHub/HF search APIs
// (-> promptContext.searchResults). ADR-0022 Stage A4 -- one generic step here replaces six
// near-identical `if (task.source === ...)` branches.
// 2026-08-23, Grimmethy: "build it" -- caught live: even with real fetchedFiles content
// given (task-sources.js's own 2026-08-21 grounding fix), the model still routinely wrote
// a plausible-but-fabricated `find` string that matched nothing in the real file --
// confirmed on observability-fix-ac-27, where the fetched 8000-char excerpt of a large
// file simply didn't happen to contain the section the candidate actually concerned, and
// the model guessed instead of reporting that gap. This previously surfaced only at
// APPLY time (apply-group-b.js's own "find string not found" error), well after a full,
// real review cycle had already been spent on a draft that was never going to apply.
// Verifies the SAME thing apply-group-b.js will eventually check, just immediately after
// implement instead of after a wasted review -- returns the first mismatch found, or
// null if every edit-mode item's find string genuinely appears in its named file's
// fetched content (a `create` item, or a file fetchedFiles doesn't have -- fetch failed,
// or it's a legitimate new file -- is not checked here; only a verifiable claim is).
// A candidate-fulfillment task's promptContext.body carries the flagged code as a
// `Snippet:` fenced block (observability_* / performance_* / function_length_* candidates).
// Pull it out so the implement-verify step can check the model edited THAT block.
// An import/logger line an `_fix` edit routinely re-adds even when the file already has it
// (observed live: 5 blocked observability_fix tasks -- "duplicate import logging").
const REDUNDANT_LINE_RE = /^\s*(?:import logging|from logging import|(?:logger|log|_log|LOG|LOGGER)\s*=\s*logging\.getLogger\([^)]*\))\s*$/;

// The most distinctive single line of a snippet (longest non-trivial, non-comment line) --
// used to locate the flagged block inside the real file even when leading/trailing lines
// of the snippet were paraphrased or reindented.
// 2026-09-02: a candidate-fulfillment edit whose `find` string is a real substring of the
// file but sits far from the block the candidate actually flagged (observed live: 8 blocked
// observability_fix tasks -- the model targeted `except OSError:` when the flag was
// `except Exception:`, an `except` that returns a 504, a catch that already had logging).
// A `function NAME(` / `const NAME = (…) =>` / `const NAME = function` / `NAME = async` --
// the declaration forms a candidate-fulfillment diff introduces a new helper as.
const HELPER_DECL_RE = /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(|(?:^|\n)\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g;

function helpersDeclaredIn(text) {
  const names = new Set();
  let m;
  HELPER_DECL_RE.lastIndex = 0;
  while ((m = HELPER_DECL_RE.exec(String(text || '')))) names.add(m[1] || m[2]);
  return [...names];
}

// AC-20 (pipeline_forensics_fix): a compliant implement output is EITHER real JSON (a
// Group B diff or a candidate split array -- parseJsonMaybeFenced succeeds) OR the
// literal FALSE POSITIVE escape line groupBJsonInstructions instructs the model to use
// when there's nothing to change. Anything else -- prose, hedging, a description of the
// code instead of a diff -- is neither, and would otherwise flow straight into critique
// and a full review-vote cycle before finally being rejected there for the exact same
// reason. Checked right before the implement->critique hand-off, in both implement
// paths (finalizeCandidateFulfillment and runImplementPass's own tail) -- harmless for a
// normal Group-B diff response, which is already valid JSON and passes immediately.
function isImplementOutputCompliant(task, implementResponse) {
  // Scoped to sources that actually use groupBJsonInstructions (prompts.js) -- the
  // instruction block this FALSE POSITIVE escape line lives in, and the only shape this
  // gate knows how to validate. A source with its own custom apply() (usesGroupB false --
  // advisoryProse candidate write-ups, product_spec's outline/markdown, etc.) was never
  // asked to produce JSON or a FALSE POSITIVE line in the first place; its own compliant
  // output is prose by design, so there is nothing for this gate to check. Confirmed live:
  // without this scoping, an advisoryProse source's normal "### AC-NNN" candidate
  // write-up and a product_spec_outline's markdown both got misread as non-compliant,
  // triggering a spurious extra implement call.
  if (!usesGroupB(task)) return true;
  const trimmed = (implementResponse || '').trim();
  if (trimmed.includes('FALSE POSITIVE')) return true;
  try {
    const parsed = parseJsonMaybeFenced(trimmed);
    return parsed !== null && parsed !== undefined;
  } catch {
    return false;
  }
}

// implementResponse + the candidate's fetched files (+ optionally the flagged code snippet,
// the candidate's declared Files: list) -> the first problem found, or null. Verifies the
// SAME things apply-group-b.js will eventually check PLUS the two integration failures the
// local model repeatedly ships (helper added but never called; a multi-file candidate's
// second file left untouched), immediately after implement instead of after a wasted
// review cycle.
// `problem`: 'find-missing' (default), 'wrong-block', 'duplicate-import',
//            'helper-not-wired', 'files-incomplete'.
function findUnverifiedEdit(implementResponse, fetchedFiles, { anchorSnippet = '', declaredFiles = [] } = {}) {
  const trimmed = (implementResponse || '').trim();
  if (!trimmed || trimmed === '""' || trimmed === "''") return null; // effectively empty -- nothing to verify
  let parsed;
  try {
    parsed = parseJsonMaybeFenced(trimmed);
  } catch {
    return null; // malformed JSON is a separate, pre-existing failure mode -- not this check's job
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const byPath = new Map((fetchedFiles || []).map((f) => [f.path, f.content]));
  const snippet = typeof anchorSnippet === 'string' ? anchorSnippet.trim() : '';

  // (a) A multi-file candidate whose declared Files: list is not fully covered by the diff
  //     -- the local model routinely edits file 1 and silently drops file 2
  //     (pipeline-forensics-fix-ac-1, -ac-14).
  const editable = new Set(
    items.filter((it) => it && (it.mode === 'edit' || it.mode === 'create' || it.mode === 'delete')).map((it) => it.file),
  );
  const declared = (declaredFiles || []).filter(Boolean);
  if (declared.length >= 2) {
    const missing = declared.filter((f) => !editable.has(f));
    if (missing.length > 0 && missing.length < declared.length) {
      return { problem: 'files-incomplete', missing, declared };
    }
  }

  // (b) A helper defined by the diff that nothing in the diff calls and the file does not
  //     already call -- "added finalizeResolution but never invoked it"
  //     (pipeline-forensics-fix-ac-6, -ac-8, -ac-4).
  const allAdded = items.map((it) => String(it && (it.replace ?? it.content) || '')).join('\n');
  const allFinds = items.map((it) => String(it && it.find || '')).join('\n');
  for (const item of items) {
    if (!item || (item.mode !== 'edit' && item.mode !== 'create')) continue;
    const added = String(item.replace ?? item.content ?? '');
    const findText = String(item.find ?? '');
    const fileContent = byPath.get(item.file) || '';
    for (const helper of helpersDeclaredIn(added)) {
      if (findText.includes(helper)) continue;                 // rewriting an existing decl, not adding
      if (new RegExp(`\\b${helper}\\s*\\(`).test(fileContent)) continue; // file already calls it
      const callRe = new RegExp(`\\b${helper}\\s*[(\`]|=\\s*${helper}\\b|\\b${helper}\\s*;`);
      const otherRefs = (allAdded.match(new RegExp(`\\b${helper}\\b`, 'g')) || []).length;
      const wiredElsewhere = allFinds.includes(helper) || callRe.test(allAdded.replace(added, ''));
      if (otherRefs <= 1 && !wiredElsewhere) {
        return { problem: 'helper-not-wired', helper, file: item.file };
      }
    }
  }

  for (const item of items) {
    if (!item || (item.mode !== 'edit' && item.mode !== 'create')) continue;
    const content = byPath.get(item.file);

    // Re-adding an import/logger line the file already has.
    const added = String(item.replace ?? item.content ?? '');
    const findText = String(item.find ?? '');
    if (content != null && added) {
      for (const line of added.split('\n')) {
        if (!REDUNDANT_LINE_RE.test(line)) continue;
        const t = line.trim();
        if (findText.includes(t)) continue; // the model is rewriting that exact line, not adding a second
        if (content.split('\n').some((cl) => cl.trim() === t)) {
          return { file: item.file, problem: 'duplicate-import', duplicateLine: t };
        }
      }
    }

    if (item.mode !== 'edit' || !findText) continue;
    if (content == null) continue; // no fetched content to verify against -- not this check's job
    if (!content.includes(findText)) {
      return { file: item.file, find: findText, problem: 'find-missing' };
    }
    if (snippet && findEditFarFromAnchor(findText, content, snippet)) {
      return { file: item.file, find: findText, problem: 'wrong-block', anchorSnippet: snippet };
    }
  }
  return null;
}

// 2026-08-26, root-caused live via arch-review-ac-4 (see prompts.js's
// candidateSplitInstructions for the full incident/design) -- detects a `{"mode":
// "split"}` implement response for a candidate-fulfillment source before it ever reaches
// critique (there's no diff to critique, same reasoning adhoc-agentic-draft.js's own
// RESOLUTION: decompose already established). Returns null for anything that isn't a
// split attempt at all (the normal edit/create/delete/empty paths continue exactly as
// before); { invalid: true, reason } if the model said "split" but didn't follow through
// with well-formed sub-candidates (a real, distinguishable failure -- blocked outright,
// same "fail loud, don't silently downgrade" treatment RESOLUTION: decompose's own
// invalid-JSON case gets); { candidates } on a genuine, well-formed split.
//
// 2026-09-08, Second Brain [[dspy-signatures]] research applied: DSPy validates a call's
// output SHAPE deterministically before ever considering the call complete, rather than
// scanning free text after the fact and hoping a heuristic classifies it correctly --
// root-caused live (arch-import-review-ac-4) that this function's own "malformed JSON is
// a separate failure mode, not this check's job" carve-out was silently absorbing a REAL
// split attempt: the model's response genuinely began `{"mode":"split","candidates":[...`
// but got cut off mid-JSON (numPredict exhausted mid-response), so JSON.parse threw and
// this returned null -- indistinguishable from "never attempted a split at all". The
// truncated response then fell through as ordinary prose, got scanned by fact-checker's
// ALL-CAPS-field heuristic (unrelated to this check), and blocked on hallucinated-looking
// constant names three retries running before exhausting -- the REAL failure (ran out of
// output budget mid-split) was never surfaced at all. SPLIT_MODE_MARKER_RE recognizes
// "this was clearly attempting mode:split" even when the JSON is broken, so a truncated
// split attempt gets its own loud, distinguishable, actionable failure (the existing
// `invalid: true` path below) instead of silently masquerading as plain prose.
const SPLIT_MODE_MARKER_RE = /"mode"\s*:\s*"split"/;

function parseCandidateSplit(implementResponse) {
  const trimmed = (implementResponse || '').trim();
  if (!trimmed || trimmed === '""' || trimmed === "''") return null;
  const looksLikeSplitAttempt = SPLIT_MODE_MARKER_RE.test(trimmed);
  let parsed;
  try {
    parsed = parseJsonMaybeFenced(trimmed);
  } catch {
    if (looksLikeSplitAttempt) {
      return { invalid: true, reason: 'Implement pass appears to have attempted mode "split" (the response contains "mode":"split") but the JSON is truncated or malformed and could not be parsed -- likely ran out of output budget mid-response. Retry with fewer/shorter sub-candidates, or increase the implement budget.' };
    }
    return null; // malformed JSON with no split marker is a separate, pre-existing failure mode -- not this check's job
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.mode !== 'split') return null;
  const raw = Array.isArray(parsed.candidates) ? parsed.candidates : [];
  const isValidShape = (c) => c && typeof c.title === 'string' && c.title.trim()
    && typeof c.problem === 'string' && c.problem.trim()
    && typeof c.solution === 'string' && c.solution.trim();

  // dependsOn (2026-09-05, see prompts.js's candidateSplitInstructions for the incident:
  // two sibling sub-candidates, one structurally depending on the other, both offered for
  // drafting in the SAME tick because nothing tracked the relationship the model's own
  // prose already stated). The model writes dependsOn as a 0-based index into its OWN,
  // pre-filter candidates array -- remap it into the POST-filter `valid` array's own index
  // space here, since a candidate with a malformed shape can be dropped between the two,
  // and that's the index space applyCandidateSplit (apply-task.js) actually numbers
  // against. A malformed/self/forward/dangling reference just means "no dependency"
  // rather than corrupting the ordering of everything downstream.
  const rawToValidIndex = raw.map(() => -1);
  const valid = [];
  raw.forEach((c, i) => {
    if (!isValidShape(c)) return;
    rawToValidIndex[i] = valid.length;
    valid.push({ ...c, _rawIndex: i });
  });

  if (valid.length < 2) {
    return { invalid: true, reason: `Implement pass said mode "split" but only ${valid.length} of ${raw.length} proposed sub-candidate(s) had a real title/problem/solution -- at least 2 well-formed sub-candidates are required` };
  }

  valid.forEach((c, finalIndex) => {
    const depRaw = raw[c._rawIndex].dependsOn;
    let dep = null;
    if (Number.isInteger(depRaw) && depRaw >= 0 && depRaw < raw.length) {
      const depFinal = rawToValidIndex[depRaw];
      if (depFinal !== -1 && depFinal < finalIndex) dep = depFinal;
    }
    c.dependsOn = dep;
    delete c._rawIndex;
  });

  return { candidates: valid };
}

// Resolves the per-call backend, its think capability, and the lock wrapper for one
// draftTask() run -- all of it depends on the task object (reasoning tier, model profile,
// resolved label), none of it mutates the task. Returns the four things every real
// model-call site below shares.
// Deterministic staleness-recheck short-circuit (2026-08-23, Grimmethy: "How do we
// systematically solve this issue in the future. We need to harden the system so that we
// don't have to keep manually following up on these" -- see staleness-fastpath.js's own
// header for the incident this fixes: a staleness_audit task for a scanner-originated
// finding burned all 3 infra-requeue rounds on real local-model timeouts over ~2 hours
// and permanently blocked, needing a human to manually re-derive an answer a regex could
// give with certainty). When the ORIGINAL flagged task came from a scanner rule this
// pipeline can re-run directly (observability_review/performance_review -- see
// staleness-fastpath.js's RULE_DETECTORS), skip the plan+implement local-model calls
// ENTIRELY and report the real, current re-scan result instead -- same "the answer is
// already 100% determined, construct it directly" reasoning the deterministic
// find/replace short-circuit below already applies to a different case. Populates
// harnessHits the same shape the existing harness-grounded branch would have, so
// stalenessAuditImplementPrompt/review-task.js's own evidence-consistency checks see
// real, true evidence either way -- this still goes through the SAME critique-skip-
// then-review pipeline as every other staleness_audit report, preserving the "archive
// only takes effect after an independent review vote" safety property
// staleness-auto-archive.js depends on; only the two calls that were actually timing out
// are removed.
//
// Returns the draftTask result object when it fully handled the task (plan + implement +
// critique-skip all constructed directly, task left at needs-review); returns null when
// the original finding isn't from a deterministically re-runnable rule, so the caller
// falls through to the normal harness-grounded local-model path unchanged.
// adhoc-shaped tasks ("Process now" queues one of these -- see task-source-registry.js's
// resolveSourceName() for why this checks the SAME resolved name apply-task.js's own
// writeArtifact() dispatch uses, not a raw task.domain === 'adhoc' check: this project's
// own task-domains.json has both 'default' and 'adhoc' keys, and default_task_domain()
// prefers 'default', so a real "Process now" task here carries domain:'default' despite
// being adhoc-shaped in every other respect -- confirmed live 2026-08-17 testing this
// exact feature) implement via a real agentic Claude Code CLI call against an isolated git
// worktree instead of the blind JSON-diff implement pass -- see adhoc-agentic-draft.js's
// own header (Brain Dump #67: formalize brain-dump processing inside the app itself, with
// real file access/test-running instead of a human doing it by hand outside the app).
// Critique+revision is deliberately skipped for this branch: a blind text-completion
// "revision" of an already-real unified diff would almost certainly corrupt it (diffs are
// strict, line-based format; a freeform rewrite is not a safe way to edit one) -- every
// path here returns a final draftTask result directly instead.
// research_task (Brain Dump #1 follow-up, 2026-08-17): same reasoning as the adhoc branch
// -- a real agentic Claude call (WebSearch/WebFetch this time, not
// Read/Grep/Glob/Edit/Write/Bash against a code repo) already did its own investigation
// and produced the final write-up; the local model's own plan/critique/revision loop
// would add nothing (there's no repo state to reason about, and "revision" of a research
// write-up the model already finished is redundant with the normal review-task.js pass
// this still flows into afterward).
// Fix (2026-08-31, bra-1788142124203): a plan can clear detectDegenerate (non-empty, no
// repeat/gibberish loop) while still being useless -- e.g. a lone "1. Inspect the current
// code" bullet. That stub then reaches implement with no map, and for adhoc the
// write-agentic pass burns its whole turn budget re-discovering what the task text already said.
const MIN_PLAN_CHARS = 200;

function planIsThin(text) {
  if (typeof text !== 'string') return true;
  if (text.trim().length < MIN_PLAN_CHARS) return true;
  // Count numbered steps whether the model wrote a bare list ("1.", "2)") or hung the
  // number off a markdown heading ("## 1.", "### 2)") -- the latter is a real, structured
  // plan and was being false-flagged as thin (bra-1788142124203 follow-up).
  const numberedSteps = (text.match(/^\s*(?:#{1,6}\s*)?\d+[.)]/gm) || []).length;
  return numberedSteps < 2;
}

// The best plan a PRIOR attempt on this same task already produced: newest non-degenerate,
// non-thin draftAttempts[].plan.text, else task.lastGoodPlan (kept outside the
// draftAttempts array precisely so draft-attempt-record.js's collapse of old records can't
// drop it). null when there is nothing worth reusing. During runPlanPass the current
// attempt is not yet on task.draftAttempts, so this only ever sees earlier attempts.
function bestPriorPlan(task) {
  const attempts = Array.isArray(task && task.draftAttempts) ? task.draftAttempts : [];
  for (let i = attempts.length - 1; i >= 0; i--) {
    const plan = attempts[i] && attempts[i].plan;
    if (plan && !plan.degenerate && typeof plan.text === 'string' && !planIsThin(plan.text)) {
      return plan.text;
    }
  }
  if (task && typeof task.lastGoodPlan === 'string' && !planIsThin(task.lastGoodPlan)) {
    return task.lastGoodPlan;
  }
  return null;
}

// 2026-09-06: root-caused live -- 19 brain_dump_sort-spawned adhoc tasks ("implement
// this research finding/design option") ALL blocked "Plan pass degenerate: truncated"
// with EXACTLY 3/3 internal call() retries and 0 visible chars every time, regardless
// of promptContext.rawText length (396 to 1,619 chars, no correlation) -- ruling out
// "input too large" as the cause. These are fundamentally more open-ended than a
// typical concrete-bug-fix adhoc task ("here's a finding, figure out how to approach
// it" vs. "fix this specific thing"), and think:true reasoning apparently indulges
// extensively on that open-endedness before ever emitting visible plan text, hitting
// the 1400-token ceiling identically on every attempt -- a genuinely different failure
// shape from a stochastic partial truncation. 2800 matches adhoc-harness-draft.js's
// own real precedent for a similarly demanding pass (its implement call), not an
// arbitrary guess. Keyed on promptContext.brainDumpEntryId (a real structured field,
// not a text-content heuristic) -- present on every brain_dump_sort-spawned adhoc
// task; a higher ceiling costs nothing for a task that doesn't need it, since
// numPredict only bounds the MAXIMUM, never forces more tokens to be spent.
//
// 2026-09-06: same failure shape, different trigger -- 2 real pipeline_debrief tasks
// blocked "Plan pass degenerate: truncated" (confirmed via model_calls: doneReason
// 'length', i.e. the 1400-token ceiling hit before any visible QUERY: text). Its plan
// prompt embeds the SAME kind of large evidence-bundle text (debrief-bundle.js /
// forensic-bundle.js, up to a 28000-char DEFAULT_BUDGET_CHARS blob) that pipeline_
// forensics' own implement-side fix (isWholeDocReport, computeImplementBudget below)
// was built for -- and think:true reasons extensively about that blob before ever
// emitting the plan's own short output, the exact same mechanism as the brain-dump-
// entry case above. Checked live: the one window that stayed under ~22KB of evidence
// text passed its plan call fine at 1400; the one at the 28000-char cap did not --
// correlates with evidence size, not source identity, so this checks
// promptContext.evidenceText's length directly rather than hardcoding source names (a
// future evidence-bundling source gets this for free without needing its own carve-out
// here). Extracted to its own pure function (mirrors computeImplementBudget) purely for
// direct unit-testability.
// 2026-09-11 (screaminggoatclubmt, from the biggest single blocked-task cluster found
// live -- 21 of ~99 blocked tasks, all "Plan pass degenerate: truncated"): the two checks
// above only ever fired for promptContext.brainDumpEntryId or a specifically-named
// evidenceText field, so change_review/observability_fix/performance_fix/arch_discovery
// -- none of which use either field -- never got the higher budget despite hitting the
// EXACT same failure shape (0 visible chars, doneReason 'length', at the 1400 ceiling):
// change_review's plan prompt embeds a full diff (up to change-review.js's own 22000-char
// CHANGE_REVIEW_CONTEXT_BUDGET_CHARS) and asks the model to "walk EVERY changed hunk"
// before writing anything -- the same "reason extensively before emitting visible text"
// mechanism as the evidence-bundle case, just via a different field name. Checked live
// against the 14 real blocked instances of this cluster: promptContext sizes ranged
// 7170-21381 chars; the smallest observed failure was 7170, so 6000 leaves real margin
// without needing to hardcode these source names (a future large-context source gets
// this for free, same discipline as the evidenceText check already established here).
// The plan pass plus its harness-search grounding step. Mutates task.planResponse (and,
// for a harnessSearch source, task.promptContext.harnessHits/searchResults) and emits the
// plan-done / harness-search history events. Returns { blocked: true, blockedReason } --
// after emitting the 'blocked' event -- when the plan pass produced no usable plan (and no
// prior plan to fall back on), else { blocked: false }.
async function runPlanPass(task, {
  maybeLocked, resolvedCallIsLocal, resolvedLocalCall, profileSupportsThink, projectSearchFetch, attempt,
  runOrientPassFn = runOrientPass, recordModelCall,
}) {
  // 2026-08-25, root-caused live via a real blocked research_task (Toregem BioPharma
  // trial lookup): researchPlanPrompt's own header used to call the research plan pass
  // "intentionally throwaway" and never gave it tool access -- so it could (and did)
  // invent a plausible-looking-but-fake registry ID and site with nothing to check it
  // against, before any real research had happened. That fabrication then leaked into
  // review as if it were a verified requirement (buildVerdictPrompt hands the reviewer
  // task.planResponse directly), and three straight implement attempts got rejected for
  // "failing" to reproduce a record that never existed. Same class of fix as
  // draftResearchImplement's own WebSearch/WebFetch grant: give the PLAN pass real tool
  // access too, for research_task only, so any specific fact-like claim it makes (an
  // ID, a date, a site) has actually been looked up, not guessed. Scoped narrowly to
  // task.domain === 'research' -- every other source's plan pass is unaffected, kept as
  // a plain no-tool completion exactly as before.
  const researchPlanTools = task.domain === 'research' ? { allowedTools: 'WebSearch,WebFetch', maxTurns: 8 } : null;
  // arch_discovery / arch_import are GENERATORS registered emptyApproval:true -- their
  // own plan prompt explicitly invites "found nothing" as the correct answer, and an
  // empty implement already auto-approves as "no candidates -- nothing to apply". An
  // empty PLAN is just the terser form of that same conclusion. Confirmed live:
  // arch-discovery-community-11 (src/gpu-guard.js + its test, a clean well-documented
  // utility with no real architectural friction) blocked TWICE on "Plan pass
  // degenerate: empty", while community-10 -- same no-friction outcome -- only passed
  // because its model happened to write a 646-char "nothing found" paragraph before
  // the (also-empty) implement pass carried it to the auto-approve path. Without this,
  // every clean community is a coin-flip between those two fates. Candidate-
  // FULFILLMENT sources (arch_review, observability_fix, ...) are excluded: they have a
  // specific candidate to implement, so an empty plan there is a genuine model failure.
  // advisoryProse sources (pipeline_forensics, staleness_audit, observability_review, ...)
  // produce a prose report/verdict, not a code diff -- the plan pass's QUERY-line output is
  // supplementary grounding, never a required artifact, and critique is already skipped for
  // them (runCritiqueAndRevision). An empty plan roll must not block the whole draft:
  // confirmed live 2026-09-01, the pipeline_forensics study of the "empty-degenerate-draft"
  // signature blocked at "Plan pass degenerate: empty" -- a 1400-token plan budget spent on
  // the think trace against a 26KB evidence prompt -- so the report pass (which PR #64 gave
  // a real 16K budget) never ran at all. Let it fall through to implement, same as the
  // emptyApproval generators below.
  const allowEmptyPlan = (isEmptyApprovalSource(task.source) && !isCandidateFulfillmentSource(task.source))
    || isAdvisoryProseSource(resolveSourceName(task));
  // Fix 1/2 (2026-08-31, bra-1788142124203): for adhoc tasks, gate the plan on real
  // substance and, when a prior attempt on this same task already produced a good plan,
  // seed the pass with it rather than cold-roll every retry. Scoped to adhoc -- the
  // domain the incident lives in; other sources' plan passes are unchanged. Never blocks
  // on its own: a thin plan with no prior plan to fall back on still proceeds (with a
  // note), exactly as before -- the implement tiers, not this gate, decide feasibility.
  const substanceGated = resolveSourceName(task) === 'adhoc';
  const seedPlan = substanceGated ? bestPriorPlan(task) : null;

  // Grounded plan (2026-09-04): give the adhoc plan pass real repo content -- the files the
  // task names + a grep on its identifiers -- so it stops inventing paths/symbols.
  // Deterministic, no LLM. Kill switch AGENT_MANAGER_ADHOC_PLAN_GROUNDING=false.
  let grounding = null;
  if (substanceGated && process.env.AGENT_MANAGER_ADHOC_PLAN_GROUNDING !== 'false') {
    try { grounding = buildPlanGrounding(task); } catch (err) { console.warn(`[adhoc-plan] buildPlanGrounding failed, proceeding without grounding | task=${task.id} | ${err.message} | ${err.stack}`); grounding = null; }
    if (grounding) {
      task._planGrounding = grounding.text;
      task.planWasGrounded = true;
    }
  }

  // Agentic orient pass (component 3): when the task names something concrete but the
  // deterministic grounding did NOT already fully cover it, read the surrounding code with
  // read-only tools before planning. runOrientPass skips itself (0 GPU) when grounding
  // already covers the task or when there's nothing concrete to orient on. Kill switch
  // AGENT_MANAGER_ADHOC_ORIENT=false.
  if (substanceGated && grounding && process.env.AGENT_MANAGER_ADHOC_ORIENT !== 'false') {
    try {
      const orient = await runOrientPassFn(task, { grounding, maybeLocked });
      recordOrient(attempt, { turnsUsed: orient.turnsUsed, skipped: orient.skipped });
      appendHistoryEvent(task, 'orient-done', orient.skipped ? 'skipped (grep-covered)' : `${orient.turnsUsed} turn(s)`);
      if (!orient.skipped && orient.notes) {
        task._planGrounding = orient.notes;   // richer than the deterministic text
        task.orientNotes = orient.notes;      // persisted -- fed to the write-agentic pass, visible for debugging
        task.oriented = true;
      }
    } catch (e) {
      appendHistoryEvent(task, 'advisory', `orient pass errored (non-fatal): ${String(e && e.message || e).slice(0, 160)}`);
    }
  }

  // Hub status grounding (2026-09-09) -- see hub-status-grounding.js's own header for the
  // real incident this closes. Cheap/deterministic like buildPlanGrounding above; null for
  // any non-decomposed task, so this is a no-op for the overwhelming majority of tasks.
  try { task._hubStatusGrounding = buildHubStatusGrounding(task); } catch { task._hubStatusGrounding = null; }

  if (seedPlan) task._seedPlan = seedPlan;
  const planPrompt = buildPlanPrompt(task);
  delete task._seedPlan; // transient -- the seed is baked into planPrompt now; never persist it
  delete task._planGrounding; // transient -- baked into planPrompt; planWasGrounded persists
  delete task._hubStatusGrounding; // transient -- baked into planPrompt

  const planNumPredict = computePlanNumPredict(task);
  const callPlan = (temperature = 0.4) => maybeLocked(resolvedCallIsLocal, () => resolvedLocalCall({ prompt: planPrompt, think: profileSupportsThink, temperature, numPredict: planNumPredict, allowEmpty: allowEmptyPlan, source: task.source, taskId: task.id, stage: 'plan', ...researchPlanTools }), 'plan');
  const planLen = (r) => (r && !r.degenerate ? ((r.response || '').trim().length) : -1);

  // Records the plan pass into model-stats.db, same as callImplementModel's own
  // recordModelCall below in this file -- previously the ONLY stage ever recorded there
  // at all, leaving the plan stage (and any re-roll -- a second, genuinely separate call)
  // entirely invisible to every cost/degenerate-rate/token-efficiency stat this pipeline
  // computes (2026-09-06, Grimmethy: "We need to fix cost tracking before we can even
  // begin to properly work on this problem"). recordModelCall may be omitted by a test
  // double, same optional-call convention callImplementModel's callers already rely on.
  let startedAt = new Date().toISOString();
  let startMs = Date.now();
  let planResult = await callPlan();
  if (recordModelCall) {
    recordModelCall({ taskId: task.id, model: labelFor(task), startedAt, latencyMs: Date.now() - startMs, result: planResult, source: task.source, stage: 'plan' });
  }
  let totalAttempts = planResult.attempts || 1;
  let reRolled = false;
  if (substanceGated && !planResult.degenerate && planIsThin(planResult.response)) {
    // One thin (but not degenerate) roll -- give it exactly one more, then keep whichever
    // of the two rolls carries more content.
    reRolled = true;
    startedAt = new Date().toISOString();
    startMs = Date.now();
    const reRoll = await callPlan(RETRY_TEMPERATURE);
    if (recordModelCall) {
      recordModelCall({ taskId: task.id, model: labelFor(task), startedAt, latencyMs: Date.now() - startMs, result: reRoll, source: task.source, stage: 'plan' });
    }
    totalAttempts += reRoll.attempts || 1;
    if (planLen(reRoll) > planLen(planResult)) planResult = reRoll;
  }

  if (planResult.degenerate) {
    const blockedReason = `Plan pass degenerate: ${planResult.degenerate}`;
    recordPlan(attempt, { degenerate: planResult.degenerate, attempts: totalAttempts });
    appendHistoryEvent(task, 'blocked', blockedReason);
    // 2026-09-17: this used to set no blockedStage at all -- invisible to reject-retry-
    // check.js's entry gate (isReviewRejection/retryableDraftBlock/isPreCritiqueBlock/
    // isDraftFailureBlock all miss it), so a task landing here via 'blocked' with
    // status left at 'pending' (never even flipped to 'blocked') just sat in queue/
    // blocked/ forever with zero automated retry -- confirmed live: 2 of 4 stuck-child
    // hubs in Hub Tasks were gated on exactly this shape. 'plan' is deliberately not
    // 'review'/'apply'/'pre-critique'/'draft' so none of those checks accidentally match it.
    return { blocked: true, blockedReason, blockedStage: 'plan' };
  }

  const stillThin = substanceGated && planIsThin(planResult.response);

  if (stillThin && seedPlan) {
    // Thin rolls, but a real plan from a prior attempt exists -- reuse it verbatim rather
    // than hand the implement tiers a stub with no map.
    task.planResponse = seedPlan;
    task.lastGoodPlan = seedPlan;
    recordPlan(attempt, { text: seedPlan, attempts: totalAttempts, reRolled, seededFromPrior: true });
    appendHistoryEvent(task, 'plan-done', `${totalAttempts} attempt(s), reused a prior attempt's plan (${seedPlan.length} chars) after ${reRolled ? 'two thin rolls' : 'a thin roll'}`);
  } else {
    task.planResponse = planResult.response;
    // Fix 2b: keep the last good plan outside draftAttempts (so record collapse can't drop
    // it -- it is the seed source for any later retry). Never store a thin one.
    if (!stillThin) task.lastGoodPlan = planResult.response;
    recordPlan(attempt, {
      text: planResult.response,
      attempts: totalAttempts,
      ...(reRolled ? { reRolled: true } : {}),
      ...(seedPlan ? { seededFromPrior: true } : {}),
      ...(stillThin ? { thin: true } : {}),
      ...(grounding ? { grounded: true, groundingChars: grounding.text.length, anchorPaths: grounding.anchorPaths } : {}),
    });
    const notes = [
      seedPlan ? 'seeded from a prior plan' : null,
      reRolled ? 're-rolled once' : null,
      stillThin ? 'still thin, no prior plan to fall back on' : null,
    ].filter(Boolean);
    appendHistoryEvent(task, 'plan-done', `${totalAttempts} attempt(s), ${task.planResponse.length} chars${notes.length ? `, ${notes.join(', ')}` : ''}`);
  }

  // Acceptance criteria (2026-09-04): a "definition of done" the implement + review are
  // held to. From promptContext.acceptanceCriteria if the caller gave one, else the
  // trailing CRITERIA: block the plan pass was asked to write. Kill switch
  // AGENT_MANAGER_ADHOC_ACCEPTANCE=false.
  if (substanceGated && process.env.AGENT_MANAGER_ADHOC_ACCEPTANCE !== 'false') {
    const ac = resolveAcceptanceCriteria(task);
    task.acceptanceCriteria = ac.criteria;
    task.acceptanceCriteriaSource = ac.source;
  }

  // Harness-search grounding step: run the plan pass's proposed QUERY: lines against a
  // real search harness and hand the hits to implement. Which harness (if any) is
  // declared per source via `harnessSearch` on its registration -- see runHarnessSearch
  // above. Replaces the per-source branches this used to be (project_search,
  // arch_import, pipeline_self_audit, pipeline_health_audit, ui_visibility_audit,
  // staleness_audit).
  const harnessKind = getRegisteredSource(resolveSourceName(task))?.harnessSearch;
  if (harnessKind) {
    // Cross-repo (2026-09-04): every 'archImport'-kind source is fundamentally "what does
    // this pipeline's own code do" -- collapses to [repoRoot] with zero plugins loaded, so
    // this is additive only (see accessible-roots.js's own header for the incident this
    // closes). 'projectSearch' ignores `roots` entirely (external API, not a repo grep).
    const roots = resolveAccessibleRoots();
    await runHarnessSearch(harnessKind, task, { projectSearchFetch, archImportFetch, roots });
  }
  return { blocked: false };
}

// Deterministic script-extract move short-circuit (2026-09-07, "Ghost in the Machine"
// concept, Grimmethy: "Build the thing please" -- real incident: a script-extract
// decompose move-child (tasks-and-branches.js) was left to the model as a text-
// generation task even though this exact extraction is 100% mechanical. The model
// reinvented a worse, hand-rolled Python brace-scanner, got 8 of 26 symbols right, ran
// out of context, and correctly escalated rather than claim false success -- but every
// one of the 26 resolves cleanly via script-extract.js's real V8-parser oracle, confirmed
// live by re-running it against the actual file). file-decompose-to-hub.js's
// validatePlan() already ran this exact check at plan-validation time and only stamps
// promptContext.deterministicApply when every symbol resolved cleanly THEN -- this
// re-resolves against CURRENT file content (an earlier stacked move on the same branch
// may have already changed it) rather than trusting a stale plan-time snapshot, and
// falls through to the normal model-driven path (returns null) if anything has drifted
// since, exactly the same "advisory-only, never trust a stale check" discipline
// staticCheckMove's own .py path already uses. Placed even before runPlanPass (unlike
// tryDeterministicLiteralEdit below, which still lets a plan pass run) since there is no
// judgment call left at all for this move kind -- skipping the plan/orient passes too,
// not just implement.
// Deterministic ONE-PASS decompose ([[hub-task-integration]], spec Docs/hub-task-independent-
// merge.md Tier 1, 2026-09-09). Same idea as tryDeterministicScriptExtractEdit above but for
// a WHOLE fully-mechanical HTML file-decompose: file-decompose-to-hub.js files one task with
// promptContext.deterministicApply='one-pass-decompose' + moves:[{newFile,symbols}] instead
// of a stacked hub of N move children + a wiring child. This produces every new module file
// + the reduced source + the <script> wiring as one Group-B change set, no model call, and
// captures the real diff against fresh origin/<main> -- so the split lands as ONE verified
// commit that can't go days-stale. Falls through (returns null) if any symbol no longer
// resolves cleanly against the current file.
// Deterministic ONE-PASS CommonJS decompose ([[hub-task-integration]], 2026-09-09). The
// src/*.js analogue of tryDeterministicOnePassDecompose above: file-decompose-to-hub.js
// files one task with promptContext.deterministicApply='node-module-decompose' when every
// move is a self-contained cluster of top-level function declarations. decompose-node-
// module.js produces every new module (require lines + moved fns verbatim + module.exports)
// + the reduced source (moved fns gone, `const { ... } = require('./<mod>.js')` added,
// module.exports untouched) as one Group-B change set, no model call. Falls through
// (returns null) if a symbol no longer resolves or a move stopped being self-contained
// against the current file, or if any produced file fails `node --check`.
// Deterministic ONE-PASS Flask-Blueprint decompose ([[hub-task-integration]], 2026-09-09).
// The .py analogue of the two functions above: file-decompose-to-hub.js files one task
// with promptContext.deterministicApply='blueprint-decompose' when every move is a
// flask-blueprint route group. decompose-flask-blueprint.js (AST via scripts/decompose-
// blueprint-extract.py) produces every new routes/<x>.py + the reduced app.py (spans
// removed AND register_blueprint wired) as one Group-B change set, py_compile-verified,
// zero model calls. This is what the local 27B kept failing at -- it burns its whole turn
// budget orienting on a large app.py and runs out before the edits (the 2026-09-09
// blueprint hub: ~4 attempts per child, brain-dump failed all 6). Falls through (returns
// null) on any drift / compile failure / empty diff.
// Deterministic find/replace short-circuit (2026-08-23, Grimmethy: "build it" -- caught
// live via a Grill-skills adhoc task exhausting both retries because the model couldn't
// reliably reproduce a 4362-char fixedLiterals block character-for-character in a JSON
// string, despite the exact find text AND the exact replace content both already being
// fully specified in the task itself -- there was never any real judgment call for a
// model to make, only a copy-accuracy risk). When a task's promptContext gives
// file+find+exactly-one-fixedLiterals-block all fully spelled out, the correct
// groupBJsonInstructions edit directive is 100% determined already -- constructing it
// directly in code guarantees an exact match every time and skips a model call (and its
// failure mode) entirely. Domain/source-agnostic and placed before the adhoc branch so an
// adhoc-shaped task authored this way never even reaches the expensive Claude agentic
// tiers for something that needed zero real reasoning. Returns the finished draftTask
// result when it constructed the edit directly, else null.
// Critique + revision: a second, independent model call reviews the drafter's own
// implement output before it ever reaches the review queue. Mutates task.critiqueOutcome
// (and, when issues were flagged, task.critiqueText / task.implementResponse /
// task.revisionApplied) and emits the critique-done history event.
//
// Skipped for advisoryProse sources (2026-08-25, "look for other opportunities" to
// shave draft-side time -- observability_review/performance_review dominate ALL
// draft-side wall-clock time across this pipeline's history by volume, 1341+453 runs).
// Measured against real historical data before changing this: critique was a
// measurable no-op (NO ISSUES FOUND or the critique call itself degenerating, either
// way changing nothing) 90.9% of the time for observability_review and 94.9% for
// performance_review -- 12.2 combined hours of real wall-clock time spent on a
// self-review pass whose own output almost never mattered, for exactly the source
// TYPE this makes the most sense for: an advisoryProse draft is a short prose verdict
// or a small fixed-format candidate block, not a code diff -- the failure modes
// critique exists to catch (a missed edge case, a wrong assumption baked into a code
// change) don't really apply to "did I phrase this false-positive explanation
// correctly," and the SAME judgment already goes through the full independent
// majority-vote review immediately afterward regardless, providing the actual
// "catch a bad verdict" safety net this critique pass was redundantly duplicating.
// Unlike the cheap-model experiment from the same investigation (which changed WHICH
// model does the judgment and measurably made it worse), this changes nothing about
// model choice or the judgment itself -- it only removes a self-review layer already
// shown, on real data, to almost never do anything.
// 2026-09-07, Grimmethy: "If we need to go higher the task can request the 3b model be
// dropped until the end of that task." A call using EXTENDED_NUM_CTX (see gpu-capacity.js's
// own comment on it) doesn't fit on this box alongside the resident qwen2.5:3b utility
// model -- explicitly evict it first via keep_alive:0 rather than letting Ollama's own
// conservative peak-VRAM safety margin discover the collision mid-load, which is the exact
// eviction/reload livelock this same session's launch.sh pre-warm fix was written to avoid
// for the OTHER load-order case. Best-effort: a failed unload just means the upcoming
// extended-context call may itself trigger Ollama's own eviction instead, no worse than
// before this existed, so this must never throw or block the real call.
//
// 2026-09-08, Grimmethy: "I'd like to see an audit log for this error. Please harden the
// eviction path" -- root-caused live: worker-1 and worker-reasoning both stacked up
// repeated OLLAMA_TIMEOUTs (150s ceiling) while `ollama ps` showed ZERO models resident
// and a fresh llama-server was cold-loading the 27B model's tensors from disk. This
// function was the prime suspect (evicts the small model to make room, best-effort and
// entirely UNLOGGED, so there was no way to confirm it after the fact) but couldn't be
// proven from the audit trail that existed at the time. Two changes:
//   1. logPipelineEvent (unified NDJSON stream, same as hard-failure/degenerate/
//      context-budget) now records every real eviction attempt -- taskId, source,
//      implNumCtx, the model evicted, and whether the eviction call itself succeeded --
//      so the NEXT time this exact symptom recurs, `grep model-eviction
//      instances/pipeline-history.log` answers "was this the cause?" directly instead of
//      needing a live nvidia-smi/journalctl investigation to infer it.
//   2. Returns `{ evicted }` so the caller can warn its own next real call that a cold
//      reload is now likely -- see callImplementModel's own coldLoadExpected use just
//      below, which adds a generous timeout bump specifically for that one call instead
//      of leaving it to race the same 150-240s ceiling a fresh multi-minute tensor load
//      from disk has no chance of finishing inside.
// Token budget for the implement pass: how many tokens it may generate (implNumPredict),
// the context window that has to hold prompt + thinking trace + that output (implNumCtx),
// whether the task carries fixedLiterals to transcribe verbatim (hasFixedLiterals), and
// whether an empty implement response is a valid answer for this source
// (allowEmptyImplement). Pure -- derived from the task and the built implement prompt.
// Post-processing for the five candidate-fulfillment sources only, which are the only
// ones with a `{"mode":"split"}` path and with fetchedFiles to verify a find against.
// Mutates task (candidateSplitProposals / implementResponse) and emits the implement-done
// or blocked history event. Returns { done: true, result } when it fully resolved the
// task (a valid split, or a blocked invalid split), else { done: false } so the caller
// falls through to critique.
function candidateSplitToHubEnabled() {
  return process.env.AGENT_MANAGER_CANDIDATE_SPLIT_TO_HUB !== 'false';
}

async function finalizeCandidateFulfillment(task, {
  maybeLocked, maybeLockedOn, resolvedCallIsLocal, resolvedLocalCall, profileSupportsThink,
}, { implResult, implPrompt, hasFixedLiterals, implNoThink, implNumPredict, implNumCtx, allowEmptyImplement, attempt }) {
  const split = parseCandidateSplit(task.implementResponse);
  if (split) {
    const pc = task.promptContext || {};
    const atSplitCap = (pc.splitDepth || 0) >= 1;
    // A noCandidateSplit source's candidate is already a decomposition, EXCEPT when the
    // deterministic pre-split gate (nextCandidateFulfillmentTask) marked it too broad to
    // land in one diff -- that split IS wanted. But a candidate already at Split-Depth >= 1
    // is never re-split, whatever the source: the hard recursion stop.
    const entry = getRegisteredSource(resolveSourceName(task));
    const splitBlocked = atSplitCap || (entry && entry.noCandidateSplit && !pc.mustPreSplit);
    // A source can register a `premiseCheck(task, {call, maybeLockedOn})` -- generic,
    // source-agnostic hook, same convention as `noCandidateSplit` above -- run BEFORE a
    // split is honored, never after: this is the fan-out point, so it's the cheapest place
    // to stop a candidate whose Problem statement makes a checkable claim about the
    // codebase that the fetched content contradicts (arch-import-premise-check.js in the
    // hygiene plugin; see AC-8, which split into 3 children before anyone checked its
    // premise was false). Skipped once splitBlocked is already true -- cheapest check first.
    if (!splitBlocked && entry && typeof entry.premiseCheck === 'function') {
      let premise;
      try {
        premise = await entry.premiseCheck(task, { call: resolvedLocalCall, maybeLockedOn });
      } catch (e) {
        // AC-170: log the swallowed premiseCheck exception so operators can see it.
        // entry.name / entry.sourceName are not confirmed present; fall back to constructor name.
        console.error(`[premiseCheck] task=${task.id || task.name || 'unknown'} source=${entry.name || entry.sourceName || entry.constructor?.name || 'unknown-source'} error=${e?.message ?? String(e)}`, e?.stack);
        premise = null; // advisory mechanism -- a throwing premiseCheck must never block a real split
      }
      if (premise && premise.verdict === 'invalid-premise') {
        const reason = `Invalid premise: ${String(premise.reason || '(no detail)')}`.slice(0, 500);
        recordImplement(attempt, { text: task.implementResponse, attempts: implResult.attempts, note: reason });
        appendHistoryEvent(task, 'blocked', reason);
        return { done: true, result: { succeeded: true, blocked: true, blockedReason: reason } };
      }
    }
    // A blocked split used to stop here, "for a human to narrow the fix" -- PropertyForager function-length-fix-ac-2 (a candidate that
    // proposed four extractions), arch-review-ac-6 (a Split-Depth 1 sub-candidate still too big). Agent-manager already has a system
    // for work that is too big for one pass: a coordinator hub of ordered adhoc sub-tasks (see apply-adhoc-diff.js). Route the
    // well-formed split there; the review pass judges it as it does any candidate split (coverage of the original), and apply
    // (apply-core.js writeArtifact) queues the pieces. The doc-split's re-split loop cannot recur: children are adhoc tasks that
    // produce real diffs and carry `decomposedFrom`, which marks them as leaves. AGENT_MANAGER_CANDIDATE_SPLIT_TO_HUB=false restores
    // the old block.
    if (splitBlocked && !split.invalid && candidateSplitToHubEnabled()) {
      const childDepth = (pc.splitDepth || 0) + 1;
      task.candidateSplitProposals = split.candidates.map((c) => ({ ...c, splitDepth: childDepth }));
      task.candidateSplitRoute = 'hub';
      const why = atSplitCap ? 'a Split-Depth >= 1 sub-candidate' : 'a source whose candidates are already decompositions';
      recordImplement(attempt, { text: task.implementResponse, attempts: implResult.attempts, note: `too large for one pass (${why}) -- split into ${split.candidates.length} piece(s) routed to a coordinator hub` });
      appendHistoryEvent(task, 'implement-done', `${implResult.attempts} attempt(s), too large for one pass (${why}) -- ${split.candidates.length} piece(s) routed to a coordinator hub: ${split.candidates.map((c) => c.title).join('; ')}`);
      concludeDraft(task);
      return { done: true, result: { succeeded: true, blocked: false } };
    }
    if (splitBlocked) {
      const reason = atSplitCap
        ? 'implement pass tried to split a sub-candidate that is already a one-level decomposition (Split-Depth >= 1) -- blocked for a human to narrow the fix'
        : 'implement pass tried to split a candidate that must be implemented directly (this source does not allow re-splitting) -- blocked for a human to narrow the fix';
      recordImplement(attempt, { text: task.implementResponse, attempts: implResult.attempts, note: reason });
      appendHistoryEvent(task, 'blocked', reason);
      return { done: true, result: { succeeded: true, blocked: true, blockedReason: reason } };
    }
    if (split.invalid) {
      recordImplement(attempt, { text: task.implementResponse, attempts: implResult.attempts, note: `invalid candidate split: ${split.reason}` });
      appendHistoryEvent(task, 'blocked', split.reason);
      return { done: true, result: { succeeded: true, blocked: true, blockedReason: split.reason } };
    }
    const childDepth = (pc.splitDepth || 0) + 1;
    task.candidateSplitProposals = split.candidates.map((c) => ({ ...c, splitDepth: childDepth }));
    recordImplement(attempt, { text: task.implementResponse, attempts: implResult.attempts, note: `split into ${split.candidates.length} sub-candidate(s)` });
    appendHistoryEvent(task, 'implement-done', `${implResult.attempts} attempt(s), split into ${split.candidates.length} sub-candidate(s): ${split.candidates.map((c) => c.title).join('; ')}`);
    concludeDraft(task);
    return { done: true, result: { succeeded: true, blocked: false } };
  }
  const anchorSnippet = extractCandidateSnippet(task.promptContext && task.promptContext.body);
  const unverified = findUnverifiedEdit(
    task.implementResponse,
    task.promptContext && task.promptContext.fetchedFiles,
    { anchorSnippet, declaredFiles: (task.promptContext && task.promptContext.files) || [] },
  );
  if (unverified) {
    let correction;
    if (unverified.problem === 'files-incomplete') {
      correction = `This candidate's "Files:" line names ${unverified.declared.length} files that all need changes: ${unverified.declared.join(', ')}. Your previous attempt only edits ${unverified.declared.filter((f) => !unverified.missing.includes(f)).join(', ') || '(none of them)'} and leaves ${unverified.missing.join(', ')} untouched. Add the edit(s) to ${unverified.missing.join(' and ')} that the Solution describes -- the change is not complete without them.`;
    } else if (unverified.problem === 'helper-not-wired') {
      correction = `Your previous attempt defines \`${unverified.helper}\` in ${unverified.file} but nothing ever calls it -- neither another edit in your diff nor the file's existing code. A new helper that is never invoked is a no-op. Add the edit that actually calls \`${unverified.helper}\` at the site the candidate's Solution describes (and, if the Solution says to, the edit that clears/resets any field it uses afterwards).`;
    } else if (unverified.problem === 'duplicate-import') {
      correction = `Your previous attempt for ${unverified.file} ADDS the line \`${unverified.duplicateLine}\`, but that line ALREADY EXISTS in the file's real content shown above. Do not add it again -- reuse the existing import/logger. If a module logger genuinely does not exist yet, add ONE line at the top of the file with the other imports, never inside a function.`;
    } else if (unverified.problem === 'wrong-block') {
      correction = `Your previous "find" string for ${unverified.file} matches the file -- but a DIFFERENT block than the one this candidate flagged. The flagged code is:\n\n${unverified.anchorSnippet}\n\nYour "find" must be a verbatim substring of THAT block (or the real file text immediately around it) -- not a similar-looking try/except/catch elsewhere in the file. Copy from the flagged block above.`;
    } else {
      correction = `Your previous attempt proposed this "find" string for ${unverified.file}, but it does not appear verbatim anywhere in that file's real content given above:\n\n${unverified.find}\n\nLook again at the REAL file content above and either copy an EXACT substring that is actually there, or -- if nothing in the real file content genuinely matches what this candidate describes -- output the empty string instead of guessing.`;
    }
    // 2026-09-10, brain-dump bd-1788748625403 ("before spending a second implement
    // attempt on an observability_fix requeue, feed the prior rejection reason"): this
    // correction text was built for ONE inline retry here and then discarded -- if this
    // candidate still gets rejected later (critique/review) and reject-retry-check.js
    // redrafts it from scratch, the fresh attempt had no memory of this exact mistake and
    // could easily reproduce it. Pushing it onto task.priorRejectionFeedback lets
    // priorRejectionBlock() (prompts.js/lib/prompt-blocks.js) fold it into the next
    // attempt's prompt as a hard constraint, same as every other rejection reason already
    // does -- no signature changes, just one more caller of the existing mechanism.
    task.priorRejectionFeedback = Array.isArray(task.priorRejectionFeedback) ? task.priorRejectionFeedback : [];
    task.priorRejectionFeedback.push(correction);
    const retryPrompt = `${implPrompt}\n\n${correction}`;
    const retryResult = await maybeLocked(resolvedCallIsLocal, () => resolvedLocalCall({ prompt: retryPrompt, think: profileSupportsThink && !implNoThink, temperature: RETRY_TEMPERATURE, numPredict: implNumPredict, numCtx: implNumCtx, allowEmpty: allowEmptyImplement, source: task.source, taskId: task.id, stage: 'implement-retry' }), 'implement-retry');
    if (!retryResult.degenerate) {
      task.implementResponse = retryResult.response;
    }
    const note = `retried once (${unverified.problem})`;
    recordImplement(attempt, { text: task.implementResponse, attempts: implResult.attempts, note, promptVariant: 'strict-cite' });
    appendHistoryEvent(task, 'implement-done', `${implResult.attempts} attempt(s), ${task.implementResponse.length} chars (${note})`);
  } else {
    recordImplement(attempt, { text: task.implementResponse, attempts: implResult.attempts });
    appendHistoryEvent(task, 'implement-done', `${implResult.attempts} attempt(s), ${task.implementResponse.length} chars`);
  }
  if (!task.nonCompliantImplementRetried && !isImplementOutputCompliant(task, task.implementResponse)) {
    task.nonCompliantImplementRetried = true;
    console.warn(`[local-draft] non-compliant implement output (missing JSON and missing FALSE POSITIVE token) -- retrying once, task=${task.id}, source=${task.source}`);
    const retryResult = await maybeLocked(resolvedCallIsLocal, () => resolvedLocalCall({ prompt: implPrompt, think: profileSupportsThink && !implNoThink, temperature: RETRY_TEMPERATURE, numPredict: implNumPredict, numCtx: implNumCtx, allowEmpty: allowEmptyImplement, source: task.source, taskId: task.id, stage: 'implement-retry' }), 'implement-retry');
    if (!retryResult.degenerate) {
      task.implementResponse = retryResult.response;
    }
    appendHistoryEvent(task, 'implement-retry', 'non-compliant output (missing JSON and missing FALSE POSITIVE token) -- retried once before critique');
  }
  return { done: false };
}

// Makes the one real implement-pass model call and records it. Picks the backend --
// normally the task's resolved local/Claude call, but an A/B candidate from
// LOCAL_AB_MODELS overrides that -- runs it under the lock when it's local, records the
// call into model-stats.db, and stamps task.abCallId / task.draftModel. Returns the raw
// call result (which may carry `degenerate`); the caller owns what to do with it.
// The implement pass: the deterministic zero-hit skip, the token-budgeted implement call
// (with optional A/B model override), model-stats recording, degenerate-output blocking,
// and candidate-fulfillment post-processing. Mutates task (implementResponse, abCallId,
// draftModel, ...) and emits its own history events. Returns { done: true, result } when
// a terminal outcome was reached (deterministic empty, degenerate block, or a candidate
// split), else { done: false } so draftTask continues to critique + revision.
async function runImplementPass(task, ctx, { recordModelCall, attempt }) {
  const { maybeLocked, resolvedCallIsLocal, resolvedLocalCall, profileSupportsThink } = ctx;

  // 2026-08-23, Grimmethy: "Investigate: arch_review/arch_import drafts hedge instead
  // of grounding in real source" -- confirmed live: even with archImportImplementPrompt's
  // explicit "if the searches found nothing... output the empty string" instruction,
  // the model frequently fabricated a plausible-looking candidate anyway (invented
  // file paths, classes, APIs) rather than reliably following it -- caught by fact-
  // check/review every time (so nothing wrong ever shipped), but burning a real call
  // and a full review cycle on a draft that was doomed from the moment harness search
  // came back empty. Skipping the implement call entirely on a genuine zero-hit
  // search removes the temptation altogether -- deterministic, not a prompt tweak the
  // model can still ignore. The source opts in via `skipImplementWhenNoHarnessHits` on
  // its registration (ADR-0022 Stage A4) and is also an emptyApproval source, so this
  // empty implementResponse auto-approves with zero further local-model spend -- the
  // exact outcome a compliant model would have produced anyway.
  const skipImplementOnNoHits = getRegisteredSource(resolveSourceName(task))?.skipImplementWhenNoHarnessHits;
  if (skipImplementOnNoHits && Array.isArray(task.promptContext.harnessHits) && task.promptContext.harnessHits.length === 0) {
    task.implementResponse = '';
    recordImplement(attempt, { note: 'deterministic empty (harness search found zero real matches)' });
    appendHistoryEvent(task, 'implement-done', 'deterministic empty (harness search found zero real matches -- implement call skipped, not left to the model to follow the empty-string instruction)');
    concludeDraft(task);
    return { done: true, result: { succeeded: true, blocked: false } };
  }

  const implPrompt = buildImplementPrompt(task, task.planResponse);
  const budget = computeImplementBudget(task, implPrompt);
  const { hasFixedLiterals, implNoThink, implNumPredict, implNumCtx, allowEmptyImplement } = budget;
  const { evicted: coldLoadExpected } = await ensureHeadroomForExtendedContext(implNumCtx, task);

  // Bookend to 'implement-done' below -- same -started/-done pairing plan/critique/review
  // have. A single implement call can legitimately run close to its timeout; with the
  // persist hook this makes a draft killed mid-call show 'implement-started' rather than
  // ending at 'plan-done'.
  appendHistoryEvent(task, 'implement-started', hasFixedLiterals ? 'fixed-literals implement pass' : 'implement pass');
  const implCallStartMs = Date.now();
  let implResult = await callImplementModel(task, ctx, { recordModelCall, implPrompt, budget, coldLoadExpected });
  let implLatencyMs = Date.now() - implCallStartMs;

  if (implResult.degenerate) {
    const blockedReason = `Implement pass degenerate: ${implResult.degenerate}`;
    recordImplement(attempt, { degenerate: implResult.degenerate, attempts: implResult.attempts });
    appendHistoryEvent(task, 'blocked', blockedReason);
    return { done: true, result: { succeeded: true, blocked: true, blockedReason } };
  }
  task.implementResponse = implResult.response;

  // evalTok/latency cap routing (2026-09-08, brain-dump bd-1788725054994 "cap the
  // implement-pass token/latency budget per draft and route oversized drafts to
  // strict-cite retry"): computeImplementBudget's evalTokCap/latencyMsCap (added
  // 2026-09-10) sat inert until now -- nothing ever read them, and prompts.js's
  // strictCiteConstraintBlock (added alongside them) was never invoked either. A draft
  // that blows well past the normal generation length or latency for an implement pass
  // is usually not a legitimately large but correct change -- it is the model
  // re-deriving or hedging on context it was already given. One bounded retry with the
  // strict-cite prompt variant reins it back in without burning a second full free-form
  // pass. Capped at exactly one retry -- oversizedImplementRetried guards against
  // retrying the retry, so a second oversized result is left as-is and flows through the
  // normal postImplementCheck/candidate-fulfillment/review path below unchanged.
  const isOversized = (Number(implResult.eval_count) || 0) > budget.evalTokCap
    || implLatencyMs > budget.latencyMsCap;
  if (isOversized && !task.oversizedImplementRetried) {
    task.oversizedImplementRetried = true;
    const strictPrompt = buildImplementPrompt(task, task.planResponse, { strictCite: true });
    const retryStartMs = Date.now();
    const retryResult = await callImplementModel(task, ctx, { recordModelCall, implPrompt: strictPrompt, budget, coldLoadExpected: false });
    const retryLatencyMs = Date.now() - retryStartMs;
    appendHistoryEvent(
      task,
      'implement-oversized',
      `evalTok=${implResult.eval_count || 0} latencyMs=${implLatencyMs} (caps ${budget.evalTokCap}/${budget.latencyMsCap}ms) -- retried once with strict-cite, ${retryResult.degenerate ? `retry degenerate (${retryResult.degenerate}), keeping original` : `retry evalTok=${retryResult.eval_count || 0} latencyMs=${retryLatencyMs}`}`,
    );
    if (!retryResult.degenerate) {
      implResult = retryResult;
      implLatencyMs = retryLatencyMs;
      task.implementResponse = retryResult.response;
    }
  }

  // A source can register a `postImplementCheck(task, implementResponse, {call,
  // maybeLockedOn})` -- generic, source-agnostic hook, same convention as premiseCheck
  // above but for the implement pass's OWN output rather than a candidate-fulfillment
  // split decision. Catches a draft that hallucinates a detail contradicting its own real
  // grounding BEFORE it burns a full local review vote round on something already doomed
  // to be rejected for exactly that reason (function-length-grounding-check.js in the
  // hygiene plugin, 2026-09-05: 8 of 9 blocked function_length_review tasks shared this
  // exact shape -- "proposes extracting X, but the grounding source shows Y"). Routes an
  // ungrounded verdict into the SAME blockedStage:'review' path a real review rejection
  // takes -- reject-retry-check.js's existing, already-proven redraft/priorRejectionFeedback/
  // exhaustion machinery handles everything from here, unchanged; this hook only decides
  // WHETHER a rejection happens; never invents a new one.
  //
  // 2026-09-06: also accepts verdict:'invalid-premise' (src/candidate-premise-check.js,
  // wired onto pipeline_forensics_fix -- AC-16/AC-18 drafted a real, well-implemented
  // guard against a prerequisite that was never actually built) -- a DISTINCT blockedReason
  // prefix from 'ungrounded' (matching the wording finalizeCandidateFulfillment's own
  // split-gated premiseCheck already uses) so blocked-task-classifiers.js can tell "the
  // draft fabricated something" (model-side, worth a feedback-driven retry) apart from
  // "the CANDIDATE itself rests on a false premise" (retrying redrafts against the exact
  // same false premise every time -- structurally futile, not stochastically unlucky).
  const postImplementEntry = getRegisteredSource(resolveSourceName(task));
  if (postImplementEntry && typeof postImplementEntry.postImplementCheck === 'function') {
    let grounding;
    try {
      grounding = await postImplementEntry.postImplementCheck(task, task.implementResponse, { call: resolvedLocalCall, maybeLockedOn: ctx.maybeLockedOn });
    } catch (e) {
      grounding = null; // advisory -- a throwing check must never block a real draft
    }
    if (grounding && (grounding.verdict === 'ungrounded' || grounding.verdict === 'invalid-premise')) {
      const prefix = grounding.verdict === 'invalid-premise' ? 'Invalid premise' : 'Ungrounded draft';
      const blockedReason = `${prefix}: ${String(grounding.reason || '(no detail)')}`.slice(0, 500);
      recordImplement(attempt, { text: task.implementResponse, attempts: implResult.attempts, note: blockedReason });
      appendHistoryEvent(task, 'blocked', blockedReason);
      task.blockedStage = 'review';
      task.blockedReason = blockedReason;
      // Stochastic harness gate, not a genuine reviewer rejection -- reject-retry-check.js's
      // isReviewRejection() currently keys only on blockedStage:'review', which silently
      // conflates a re-roll-worthy gate flake with a real REJECT verdict. This structured
      // flag lets downstream consumers (retry, drain, self-audit) tell them apart without
      // depending on blockedStage alone. Never set at a genuine review-time rejection site
      // (see src/review-task.js's own blockedStage:'review' assignments, which do not set
      // this) -- only here and postImplementCheck's sibling gate in implement-critique.js.
      task.reviewInconclusive = true;
      task.priorRejectionFeedback = Array.isArray(task.priorRejectionFeedback) ? task.priorRejectionFeedback : [];
      task.priorRejectionFeedback.push(blockedReason);
      return { done: true, result: { succeeded: true, blocked: true, blockedReason } };
    }
    // An 'ok' verdict may still carry `warnings`: things the check could not verify but that
    // are not proof of a defect (e.g. a symbol not found by literal grep in the cited files).
    // Kept on the task for review-task.js's buildVerdictPrompt so the votes can weigh them,
    // instead of blocking a draft on a heuristic. Reset every pass so a redraft never
    // inherits a stale warning.
    delete task.groundingWarnings;
    if (grounding && grounding.verdict === 'ok' && Array.isArray(grounding.warnings) && grounding.warnings.length) {
      task.groundingWarnings = grounding.warnings.slice(0, 10).map((w) => String(w).slice(0, 300));
      appendHistoryEvent(task, 'grounding-warning', task.groundingWarnings.join('; ').slice(0, 300));
    }
  }

  // Deterministic find-verification retry (see findUnverifiedEdit's own header) --
  // ONLY for the five candidate-fulfillment sources, which are the only ones with
  // fetchedFiles to verify against. Bounded to a single retry, same "one real second
  // chance, then let the existing downstream gates catch it" shape as the adhoc
  // turn-budget retry -- a find string that's still wrong on a second, explicitly-
  // warned attempt is a genuine mismatch (stale/truncated fetched content, a
  // candidate whose Problem no longer matches current code, etc.), not something a
  // third guess would likely fix either.
  if (isCandidateFulfillmentSource(task.source)) {
    return await finalizeCandidateFulfillment(task, ctx, {
      implResult, implPrompt, hasFixedLiterals, implNoThink, implNumPredict, implNumCtx, allowEmptyImplement, attempt,
    });
  }
  recordImplement(attempt, {
    text: task.implementResponse,
    attempts: implResult.attempts,
    ...(task.oversizedImplementRetried ? { promptVariant: 'oversized-strict-cite' } : {}),
  });
  appendHistoryEvent(task, 'implement-done', `${implResult.attempts} attempt(s), ${task.implementResponse.length} chars`);
  if (!task.nonCompliantImplementRetried && !isImplementOutputCompliant(task, task.implementResponse)) {
    task.nonCompliantImplementRetried = true;
    console.warn(`[local-draft] non-compliant implement output (missing JSON and missing FALSE POSITIVE token) -- retrying once, task=${task.id}, source=${task.source}`);
    const retryResult = await callImplementModel(task, ctx, { recordModelCall, implPrompt, budget, coldLoadExpected: false });
    if (!retryResult.degenerate) {
      task.implementResponse = retryResult.response;
    }
    appendHistoryEvent(task, 'implement-retry', 'non-compliant output (missing JSON and missing FALSE POSITIVE token) -- retried once before critique');
  }
  return { done: false };
}

/**
 * The actual draft logic, independent of the CLI/stdout wrapper below -- exported so tests
 * can call it directly with a fake localCall.
 * @param {object} task - The parsed task record (mutated in place with pass results).
 * @param {object} [deps]
 * @param {function} [deps.localCall] - Defaults to model-provider.js's per-task-source
 *   pick (local-client.js's call() unless task.source is listed in
 *   AGENT_MANAGER_CLAUDE_SOURCES, in which case claude-client.js's call()).
 * @param {function} [deps.withLockFn] - Defaults to single-flight-lock.js's real withLock.
 *   Tests can inject a no-op ((dir, fn) => fn()) to skip touching a real lockfile.
 * @returns {Promise<{succeeded: boolean, blocked?: boolean, blockedReason?: string, blockedStage?: string, needsClarification?: boolean, reason?: string}>}
 */
async function draftTask(task, deps = {}) {
  // One append-only record per draftTask() run (draft-attempt-record.js). runDraftPasses
  // threads `attempt` through every pass and records into it as output is produced;
  // finalizeDraftAttempt stamps the terminal verdict, pushes it onto task.draftAttempts,
  // and emits a 'draft-attempt' history event so main()'s persist hook flushes the record
  // to disk -- including on the succeeded:false path, where main()'s own terminal
  // writeTaskJson is skipped. Without this, a task that fails N times in a row keeps only
  // the LAST attempt's planResponse (overwritten every run) and none of the tier detail.
  const attempt = beginDraftAttempt(task);
  const result = await runDraftPasses(task, attempt, deps);
  finalizeDraftAttempt(task, attempt, result, { emitHistory: appendHistoryEvent });
  return result;
}

async function runDraftPasses(task, attempt, {
  localCall = null, projectSearchFetch = runSearches, recordModelCall = defaultRecordModelCall,
  draftAdhocViaLocalAgenticWriteFn = draftAdhocViaLocalAgenticWrite,
  draftResearchImplementFn = draftResearchImplement, withLockFn = defaultWithLock,
  isClaudePausedFn = isClaudePaused, runOrientPassFn = runOrientPass, runPlanCritiqueFn = runPlanCritique,
} = {}) {
  const { resolvedLocalCall, profileSupportsThink, resolvedCallIsLocal, maybeLocked, maybeLockedOn } =
    resolveDraftContext(task, { localCall, withLockFn });

  try {
    appendHistoryEvent(task, 'draft-started', task.localRejectCount ? `retry ${task.localRejectCount}` : undefined);

    // A requeue (reject-retry-check.js) deliberately leaves the PRIOR attempt's blockedStage/blockedReason on the record -- its
    // reason was already captured into priorRejectionFeedback, and the stamps stay for history. But this run's own gates (the
    // postImplementCheck disposition, the grounding gate inside critique, ...) signal a block by stamping task.blockedStage during
    // the run, and the post-critique `if (task.blockedStage)` cannot tell a stale stamp from a fresh one. So a retry whose plan,
    // implement and critique ALL succeeded came back "blocked" with the first attempt's reason (change-review-8c6fe80: attempts 2
    // and 3 both produced a clean draft and were recorded as 'Plan pass degenerate: truncated'; both retries burned, task escalated
    // to a human). Start every attempt with a clean slate; a block in THIS run stamps them again, and main() persists the result.
    delete task.blockedStage;
    delete task.blockedReason;
    // Same for a previous attempt's split: a redraft that produces a normal diff must not carry the old proposals into apply
    // (writeArtifact keys on task.candidateSplitProposals first, so stale ones would file/queue a split instead of the fix).
    delete task.candidateSplitProposals;
    delete task.candidateSplitRoute;

    // Fail-fast Ollama pre-flight (src/ollama-health.js): if this draft is about to
    // hit a REAL local Ollama endpoint (no injected localCall -- unit tests pass fakes,
    // so localCall===null means the default model-provider.js pick) and it resolves to
    // a local call, probe the endpoint now. A rejection throws and falls into this
    // function's existing catch below ({ succeeded: false, reason }) -- a one-line
    // diagnostic in ~5s instead of stalling on the first generate call's 4-minute
    // socket timeout with the identical, less actionable symptom.
    if (localCall === null && resolvedCallIsLocal) {
      // sub-task-2 normative URL spec (src/ollama-health.js): URL MUST stay env-var-first process.env.OLLAMA_URL ||
      // 'http://localhost:11434' -- do NOT replace with a bare 'http://localhost:11434' literal (P40 lane src/dead-process-check.js and TokenFold scripts/launch.sh both set OLLAMA_URL).
      await checkOllamaReachable(process.env.OLLAMA_URL || 'http://localhost:11434');
    }

    // Re-ground a candidate-fulfillment task against CURRENT file content before any
    // prompt is built (see refreshCandidateFetchedFiles) -- a sibling AC on the same file
    // may have merged since the frozen fetchedFiles snapshot was taken.
    if (isCandidateFulfillmentSource(resolveSourceName(task))) {
      refreshCandidateFetchedFiles(task);
    }

    // Deterministic staleness-recheck short-circuit -- see runStalenessFastpath().
    if (task.source === 'staleness_audit') {
      const fastpathResult = runStalenessFastpath(task, attempt);
      if (fastpathResult) return fastpathResult;
      // else: not a rule this file knows how to re-run deterministically (adhoc,
      // project_search, arch_review, an unrecognized rule, ...) -- fall through to the
      // existing harness-grounded local-model path below, completely unchanged.
    }

    // Deterministic script-extract move short-circuit -- see
    // tryDeterministicScriptExtractEdit()'s own header for the full incident.
    const scriptExtractResult = tryDeterministicScriptExtractEdit(task, attempt);
    if (scriptExtractResult) return scriptExtractResult;

    // Deterministic ONE-PASS decompose (a whole fully-mechanical HTML file-decompose in a
    // single task, no stacked hub) -- see tryDeterministicOnePassDecompose()'s header.
    const onePassResult = tryDeterministicOnePassDecompose(task, attempt);
    if (onePassResult) return onePassResult;

    // Same, for a plain CommonJS source (src/*.js) -- see
    // tryDeterministicNodeModuleDecompose()'s header.
    const nodeModuleResult = tryDeterministicNodeModuleDecompose(task, attempt);
    if (nodeModuleResult) return nodeModuleResult;

    // Same, for an all-flask-blueprint .py decompose -- see
    // tryDeterministicBlueprintDecompose()'s header.
    const blueprintResult = tryDeterministicBlueprintDecompose(task, attempt);
    if (blueprintResult) return blueprintResult;

    // Pre-drafted task escape hatch: an explicit task.preDrafted===true flag (set by a
    // human, or an orchestrating agent acting as architect) that already knows the exact
    // implementResponse -- skips plan+implement entirely, straight to critique. Matches
    // local-worker.ps1's isPreDrafted check EXACTLY (an explicit flag, requiring non-empty
    // implementResponse) -- NOT "does implementResponse happen to already have a value",
    // which was this file's original (wrong) heuristic. That wrong heuristic meant ANY
    // requeued/retried task (reject-retry-check.js moves blocked->pending without clearing
    // planResponse/implementResponse, by design -- priorRejectionFeedback is what's SUPPOSED
    // to inform the next attempt) hit this branch and skipped straight to critique on its
    // stale, ALREADY-REJECTED implementResponse from the prior attempt -- reject-retry-
    // requeue's entire purpose (a FRESH redraft) silently never happened. Confirmed live
    // 2026-08-14: every task in queue/drafting/ or queue/pending/ with localRejectCount>0
    // already had planResponse+implementResponse populated from its original (rejected)
    // attempt.
    const isPreDrafted = task.preDrafted === true && !!task.implementResponse;

    if (isPreDrafted) {
      if (!task.planResponse) {
        task.planResponse = 'Pre-drafted task: the exact implementResponse below was specified directly by the caller, not produced by a plan+implement pass.';
      }
      recordPlan(attempt, { text: task.planResponse, attempts: 0 });
      recordImplement(attempt, { text: task.implementResponse, note: 'pre-drafted (caller-supplied implementResponse)' });
    } else {
      // research_task's plan pass grants Claude-only WebSearch/WebFetch. If research
      // can't run on Claude (not opted in / no token / paused) block BEFORE the plan
      // pass rather than run a webless plan that produces nothing usable.
      if (task.domain === 'research' || isResearchDomainTask(task)) {
        const claudeStatus = researchClaudeStatus(task, isClaudePausedFn);
        if (!claudeStatus.ok) {
          appendHistoryEvent(task, 'blocked', claudeStatus.reason);
          return { succeeded: true, blocked: true, blockedReason: claudeStatus.reason };
        }
      }

      // 2026-09: a Research:-titled task is a research task no matter what domain/source
      // it arrived with. Short-circuit HERE -- before runPlanPass (a plan-stage model
      // call) and before the adhoc branch below whose tier ladder would otherwise swallow
      // it -- so it always routes through draftResearchBranch (which internally re-checks
      // the same researchClaudeStatus gate, so an unopted/paused Claude still blocks
      // cleanly instead of wedging).
      if (isResearchDomainTask(task)) {
        return await draftResearchBranch(task, { recordModelCall, draftResearchImplementFn, isClaudePausedFn, attempt });
      }

      const planOutcome = await runPlanPass(task, {
        maybeLocked, resolvedCallIsLocal, resolvedLocalCall, profileSupportsThink, projectSearchFetch, attempt, runOrientPassFn, recordModelCall,
      });
      if (planOutcome.blocked) {
        // blockedStage must propagate here -- dropping it (the previous behavior) is
        // exactly what made a plan-pass-degenerate block invisible to reject-retry-
        // check.js's entry gate even after runPlanPass started setting blockedStage:'plan'.
        return { succeeded: true, blocked: true, blockedReason: planOutcome.blockedReason, blockedStage: planOutcome.blockedStage };
      }

      // Hard PRE-implementation guard (2026-09-17, needs-clarification bd-1788967312693,
      // "pre-implementation timing ambiguity" -- user-selected resolution): the pre-
      // critique guard further below only ever runs AFTER runImplementPass, so it saves
      // the critique/revision turn but still spends the full implement pass on a plan
      // that names a file that was never real. adhoc's own plan already declares its
      // edit targets in prose (plan-target-guard.js's planTargetGuard, reusing the same
      // extractDeclaredTargets primitive reject-retry-check.js's forbidden-path rescue
      // already trusts) -- checking those here, right after the plan pass, catches the
      // identical fabrication one stage earlier. Scoped to adhoc only: a generator-stage
      // source's plan legitimately proposes a not-yet-real or external-repo target (see
      // the pre-critique guard's own scoping comment further below for the full
      // reasoning) -- adhoc always targets THIS repo's own files.
      if (resolveSourceName(task) === 'adhoc' && typeof task.planResponse === 'string' && task.planResponse) {
        const { repoRoot, grepAllowedDirs } = getConfig();
        const preImplementGuard = planTargetGuard(task, task.planResponse, repoRoot, grepAllowedDirs);
        if (preImplementGuard.blocked) {
          appendHistoryEvent(task, 'blocked', preImplementGuard.reason);
          return {
            succeeded: true,
            blocked: true,
            blockedReason: preImplementGuard.reason,
            blockedStage: 'pre-implement',
          };
        }
      }

      const literalEditResult = tryDeterministicLiteralEdit(task, attempt);
      if (literalEditResult) return literalEditResult;

      // Plan critique (component 4): check the grounded plan for mechanical gaps before the
      // implement ladder burns turns. A deterministic pre-filter does the high-value checks;
      // a small qwen2.5:3b call on its own lock key is the semantic fallback. Advisory --
      // "gaps" triggers exactly one bounded re-plan. Default OFF (=== 'true' to enable).
      if (resolveSourceName(task) === 'adhoc'
          && process.env.AGENT_MANAGER_ADHOC_PLAN_CRITIQUE === 'true'
          && !task._planCritiqueRevised) {
        try {
          const critique = await runPlanCritiqueFn(task, { maybeLockedOn });
          recordPlanCritique(attempt, { verdict: critique.verdict, gapCount: critique.gaps.length, viaModel: critique.viaModel });
          appendHistoryEvent(task, 'plan-critique-done', critique.verdict === 'ok' ? 'ok' : `${critique.gaps.length} gap(s): ${critique.gaps.map((g) => g.split(' ')[0]).join(',')}`);
          if (critique.verdict === 'gaps') {
            task._planCritiqueFeedback = critique.gaps;
            task._planCritiqueRevised = true;
            if (critique.gaps.some((g) => g.startsWith('SCOPE_TOO_BIG'))) {
              task._decomposeHint = critique.gaps.find((g) => g.startsWith('SCOPE_TOO_BIG'));
            }
            const rePlan = await runPlanPass(task, {
              maybeLocked, resolvedCallIsLocal, resolvedLocalCall, profileSupportsThink, projectSearchFetch, attempt, runOrientPassFn,
            });
            delete task._planCritiqueFeedback;
            if (rePlan.blocked) return { succeeded: true, blocked: true, blockedReason: rePlan.blockedReason, blockedStage: rePlan.blockedStage };
          }
        } catch (e) {
          appendHistoryEvent(task, 'advisory', `plan-critique errored (non-fatal): ${String(e && e.message || e).slice(0, 160)}`);
        }
      }

      // adhoc-shaped tasks implement via a single LOCAL write-agentic pass in an isolated
      // worktree instead of the blind JSON-diff pass below -- see draftAdhocBranch().
      // Every path there returns a final draftTask result; nothing here calls Claude.
      if (resolveSourceName(task) === 'adhoc') {
        return await draftAdhocBranch(task, {
          maybeLocked, recordModelCall, attempt, resolvedLocalCall, resolvedCallIsLocal,
          draftAdhocViaLocalAgenticWriteFn,
        });
      }

      // research_task implements via a real agentic Claude (WebSearch/WebFetch) call -- see
      // draftResearchBranch(). Same "the agentic pass already produced the final artifact,
      // skip the local plan/critique/revision loop" reasoning as the adhoc branch.
      if (task.domain === 'research' || isResearchDomainTask(task)) {
        return await draftResearchBranch(task, { recordModelCall, draftResearchImplementFn, isClaudePausedFn, attempt });
      }

      const implementOutcome = await runImplementPass(task, {
        maybeLocked, resolvedCallIsLocal, resolvedLocalCall, profileSupportsThink,
      }, { recordModelCall, attempt });
      if (implementOutcome.done) return implementOutcome.result;
    }

    // Hard pre-critique guard (2026-09-16, recovering a real approved-but-lost fix --
    // see draft-file-guard.js's own header): if the implement response names file(s)
    // that do not exist in the repo (and are not a legitimate create-mode target), block
    // BEFORE critique/revision spends a turn revising phantom code. This is the single
    // rejection cause shared by the costliest fulfillment candidate reworks (observability_
    // fix et al) -- catching it here, before review, removes an entire review+redraft
    // cycle per occurrence. missingFileCheck's signature is (draftText, repoRoot,
    // extraRoots) -- positional, not an options object.
    //
    // Scoped to candidateFulfillment sources only: a fulfillment candidate's Files: line
    // is always THIS repo's own real path (see e.g. pipeline_forensics_fix's own
    // registration comment: "the candidate's Files: line is always this pipeline's OWN
    // src/..."), so a citation that resolves nowhere really is a fabrication. A
    // generator/recommendation-stage source (deep_dive, arch_discovery, product_spec_
    // outline, ...) legitimately cites paths that don't resolve against THIS repoRoot --
    // an external project's own file (deep_dive) or a not-yet-real target the outline is
    // merely proposing -- so the guard must not run for those at all.
    if (isCandidateFulfillmentSource(resolveSourceName(task))
      && typeof task.implementResponse === 'string' && task.implementResponse.length > 0) {
      const { repoRoot, grepAllowedDirs } = getConfig();
      const guardResult = missingFileCheck(task.implementResponse, repoRoot, grepAllowedDirs);
      if (guardResult.blocked) {
        appendHistoryEvent(task, 'blocked', guardResult.reason);
        return {
          succeeded: true,
          blocked: true,
          blockedReason: guardResult.reason,
          blockedStage: 'pre-critique',
        };
      }
    }

    await runCritiqueAndRevision(task, {
      maybeLocked, resolvedCallIsLocal, resolvedLocalCall, profileSupportsThink, attempt, recordModelCall,
    });

    // Grounding gate fired inside critique (see runCritiqueAndRevision): the draft is
    // already stamped blockedStage/blockedReason -- dispose it exactly like the
    // postImplementCheck disposition in runImplementPass, before concludeDraft.
    if (task.blockedStage) {
      return { succeeded: true, blocked: true, blockedReason: task.blockedReason };
    }

    concludeDraft(task);

    return { succeeded: true, blocked: false };
  } catch (e) {
    console.error('[local-draft] draftTask failed:', e.stack || String(e));
    if (e.cause) console.error('[local-draft] draftTask cause:', e.cause.stack || String(e.cause));
    return { succeeded: false, reason: e.message };
  }
}

async function main() {
  const taskPath = process.argv[2];
  if (!taskPath) {
    process.stdout.write(JSON.stringify({ succeeded: false, reason: 'usage: node local-draft.js <draft.json>' }));
    return;
  }

  let task;
  try {
    task = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
  } catch (e) {
    process.stdout.write(JSON.stringify({ succeeded: false, reason: `Could not read/parse task JSON: ${e.message}` }));
    return;
  }

  // Defense-in-depth (2026-09-07): scripts/local-worker.sh's own claim step already
  // deletes pinnedWorker the moment it `mv`s a task out of pending/ (a one-shot operator
  // assignment shouldn't keep re-attracting the same task to the same lane on some later
  // ordinary requeue -- see that script's own comment). That happens in a separate bash+
  // node subprocess before this process even starts, so it can't be un-done here -- but
  // stripping it again from THIS process's own in-memory copy costs nothing and closes
  // off any path (a resumed leftover-drafting item that skipped the claim step, a future
  // code path that reads the task some other way) where a stale pin could survive into
  // whatever writeTaskJson persists next, instead of being a live guess about which path
  // missed it.
  if (task.pinnedWorker) delete task.pinnedWorker;

  // Flush every Pipeline-History checkpoint to disk the moment it's recorded, so a long
  // draft's progress (draft-started, plan-done, harness-search, implement-done, ...) shows
  // up in the dashboard while the draft is still running -- and survives the worker being
  // killed mid-draft (chat preempt, stop.sh) instead of vanishing with the process. The
  // authoritative writeTaskJson below still runs on completion; these are additive.
  setHistoryPersistHook(() => {
    try { writeTaskJson(taskPath, task); } catch (_) { /* best-effort */ }
  });

  // 2026-09-07 (Grimmethy, live-testing the Workers-tab assign-task override: "kicking
  // out the old task but not loading in the task I selected"): root-caused via
  // local-worker-<instance>.log -- draftTask() CAN throw uncaught (confirmed live:
  // "Error: gpu-arbiter: cancelled while waiting", "'draft' ticket ... timed out waiting
  // to reach the head of the queue", both real outcomes of chat-preempt's/assign-task's
  // own cancel/kill mechanisms doing exactly what they're supposed to do to a lower-
  // priority in-flight call). Before this fix, an uncaught rejection here meant `main()`
  // died before EVER reaching the process.stdout.write below -- local-worker.sh's
  // `draft_result="$(node local-draft.js ...)"` captured empty stdout, and its own
  // visible "draft call failed for X: %s" log line printed that empty string, hiding the
  // real reason in a different log file (LOG_FILE, this call's stderr) an operator would
  // have to already know to go look at. Catching it here and returning the same
  // {succeeded:false, reason} shape the two parse-error branches above already use means
  // the real reason always reaches BOTH the visible per-tick log line and (via
  // local-worker.sh's normal draft_succeeded===false handling) the task's own retry/
  // infra-requeue bookkeeping, instead of a crash bypassing that entirely.
  let result;
  try {
    result = await draftTask(task);
  } catch (e) {
    result = { succeeded: false, reason: `draftTask threw: ${e && e.message ? e.message : e}` };
    process.stdout.write(JSON.stringify(result));
    return;
  }
  // Persist whatever pass results/status landed on the task, even when blocked -- so the
  // caller can move the file and the blocked reason travels with it.
  if (result.succeeded) {
    if (result.blocked) {
      task.blockedReason = result.blockedReason;
      if (result.blockedStage) task.blockedStage = result.blockedStage;
    }
    writeTaskJson(taskPath, task);
  }
  // Housekeeping: drop worklogs for tasks that have left the pre-merge queue (reached
  // done/ or gone). Cheap, best-effort, and runs on every draft so queue/worklogs/ stays
  // bounded even when the apply loop (the other prune caller) is disabled.
  try { pruneWorkLogs(); } catch (_) { /* best-effort */ }
  process.stdout.write(JSON.stringify(result));
}

module.exports = { draftTask, findUnverifiedEdit, extractCandidateSnippet, parseCandidateSplit, concludeDraft, draftDoneDetail, computeImplementBudget, computePlanNumPredict, planIsThin, bestPriorPlan, refreshCandidateFetchedFiles, isCandidateFulfillmentSource, ensureHeadroomForExtendedContext, RETRY_TEMPERATURE, localOllamaLockKey, callImplementModel, installStdoutEpipeGuard };

// 2026-09-17, pipeline hardening: process.stdout is an EventEmitter -- a write that hits a
// broken pipe (the parent shell/Python reader already exited, e.g. because IT crashed on
// something unrelated) fails asynchronously as an 'error' event, not a thrown exception,
// so it is NOT caught by the try/catch already wrapping draftTask() above. With no
// listener, Node's default behavior for an unhandled stream 'error' is to crash the WHOLE
// process -- confirmed live: a task testing the Python<->Node plumbing chain hit a broken
// streaming path on the Python side ('FakeProc' object has no attribute 'poll'), which
// closed its read end while this process's own final process.stdout.write was still in
// flight; the resulting EPIPE killed local-draft.js outright, and local-worker.sh's
// wrapping bash loop -- which never crashes itself, so nothing restarted this lane's
// underlying work -- was left running with no visible sign anything had gone wrong (the
// worker's own log file, redirected from this same now-defunct process, simply went
// silent for the rest of the incident). A broken pipe here means only that whoever was
// going to read this run's result is already gone; the RIGHT behavior is to note that and
// exit cleanly, not to take the whole worker down with it. Exported (rather than inlined
// in the require.main block below) so it's independently testable without spawning a real
// subprocess and simulating an OS-level broken pipe.
function installStdoutEpipeGuard(label, stream = process.stdout) {
  // `stream` is injectable so tests can drive this against a throwaway EventEmitter
  // instead of the real process.stdout -- emitting a synthetic 'error' on the real stream
  // leaves it internally marked errored/destroyed for the rest of the process, which broke
  // the test runner's own stdout-based TAP reporting the first time this was tried.
  stream.on('error', (err) => {
    if (err && err.code === 'EPIPE') {
      process.exitCode = 0;
      return;
    }
    // Anything else on stdout is unexpected enough to want visible on stderr, but still
    // not worth crashing over -- this process's real job (draftTask) already ran; only
    // the final write of its result failed.
    try { process.stderr.write(`[${label}] stdout write failed (non-fatal): ${err && err.message}\n`); } catch (_) { /* stderr may also be broken; nothing more to do */ }
  });
}

if (require.main === module) {
  // Scoped to the CLI entry, not module load -- this file's exports (draftTask et al.) are
  // required as a library by other long-running processes and tests that must keep Node's
  // normal stdout error behavior, not silently inherit a guard meant only for this
  // standalone subprocess's own stdout.
  installStdoutEpipeGuard('local-draft');
  main();
}
