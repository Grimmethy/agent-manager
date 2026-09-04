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
const { resolveAcceptanceCriteria } = require('./acceptance-criteria.js');
const { runOrientPass } = require('./orient-pass.js');
const { runSearches } = require('./project-search-fetch.js');
const { fetchForQueries: archImportFetch } = require('./arch-import-fetch.js');
const { recordCall: defaultRecordModelCall } = require('./model-stats-client.js');
const { appendHistoryEvent, setHistoryPersistHook } = require('./task-history.js');
const {
  beginDraftAttempt, recordPlan, recordImplement, recordCritique, recordOrient, recordTier, finalizeDraftAttempt,
} = require('./draft-attempt-record.js');
const { appendTierWorkLog, pruneWorkLogs } = require('./work-log.js');
const { providerFor, labelFor, resolveModelProfile } = require('./model-provider.js');
const { getConfig, ensureRegistered } = require('./config.js');
const { withLock: defaultWithLock } = require('./single-flight-lock.js');
const gpuArbiter = require('./gpu-arbiter.js');
const { parseClarificationOptions } = require('./agentic-draft-common.js');
const { runDecomposePass } = require('./decompose-pass.js');
const { draftAdhocViaHarnessSearch } = require('./adhoc-harness-draft.js');
const { draftAdhocViaLocalAgentic } = require('./local-agentic-draft.js');
const { draftAdhocViaLocalAgenticWrite } = require('./local-agentic-write-draft.js');
const { draftResearchImplement } = require('./research-agentic-draft.js');
const { resolveSourceName, getRegisteredSource } = require('./task-source-registry.js');
const { selectAbModel } = require('./ab-model-select.js');
const { resolveStrategy } = require('./model-strategies.js');
const { parseJsonMaybeFenced } = require('./json-fence.js');
const { isClaudePaused } = require('./claude-pause.js');
const { writeHeartbeatFile } = require('./heartbeat.js');
const { PINNED_NUM_CTX } = require('./gpu-capacity.js');

// Populate the registry with this repo's built-ins AND any AGENT_MANAGER_REGISTER_PATH
// plugin sources (agent-manager-hygiene). local-draft.js's draft path calls
// buildPlanPrompt/buildImplementPrompt (prompts.js), which look the builder up by source
// name on the registry -- without this, a plugin-source task (arch_review,
// observability_fix, ...) hits genericFallbackPlanPrompt and dies with "no prompt template
// for domain=default source=arch_review". Matches apply-task.js / get-grounding-source.js.
// (Before the 2026-08-27 plugin split, requiring prompts.js -> task-sources.js registered
// everything eagerly; it no longer covers plugin sources.)
ensureRegistered();

function writeTaskJson(taskPath, task) {
  // Atomic write: the history persist hook (see main()) rewrites this file on every
  // checkpoint while a draft is in flight, and the dashboard polls it concurrently -- a
  // half-written file must never be observable. Same-dir tmp keeps the rename on one fs.
  const tmp = `${taskPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(task, null, 2));
  fs.renameSync(tmp, taskPath);
}

// research_task drafting is the one path with no local equivalent -- WebSearch/WebFetch
// exist only in the Claude Code CLI (2026-09-01: everything else in the reasoning path
// now runs on the local model). So research runs ONLY when a deployment has explicitly
// opted it onto Claude (AGENT_MANAGER_CLAUDE_SOURCES) AND a token is set AND Claude isn't
// paused; otherwise the task blocks cleanly with a legible reason instead of wedging.
// Returns { ok: true } or { ok: false, reason }.
function researchClaudeStatus(task, isClaudePausedFn) {
  const src = resolveSourceName(task) || task.source || 'research_task';
  const optedIn = (process.env.AGENT_MANAGER_CLAUDE_SOURCES || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (!optedIn.includes(src)) {
    return { ok: false, reason: `research_task drafting needs the Claude Code CLI (WebSearch/WebFetch) -- there is no local web-research capability. Add "${src}" to AGENT_MANAGER_CLAUDE_SOURCES (and set CLAUDE_CODE_OAUTH_TOKEN) to enable it.` };
  }
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { ok: false, reason: 'research_task drafting needs Claude (WebSearch/WebFetch) but CLAUDE_CODE_OAUTH_TOKEN is not set.' };
  }
  if (isClaudePausedFn()) {
    return { ok: false, reason: 'research_task drafting needs Claude (WebSearch/WebFetch) but Claude is manually paused from the Workers tab.' };
  }
  return { ok: true };
}

// A one-line summary for the 'draft-done' checkpoint, assembled from whatever the draft
// branch already stamped on the task (adhoc resolution, retry count, model). Returns
// undefined when there's nothing worth showing -- appendHistoryEvent then omits `detail`.
function draftDoneDetail(task) {
  const parts = [];
  if (task.adhocResolution) parts.push(`resolution=${task.adhocResolution}`);
  if (task.localRejectCount) parts.push(`retry ${task.localRejectCount}`);
  const model = task.draftModelDisplay || task.draftModel;
  if (model) parts.push(model);
  return parts.join(', ') || undefined;
}

// The draft phase is complete and the task is heading to review. Emit an explicit
// 'draft-done' checkpoint -- bookend to the 'draft-started' event above, and the same
// -started/-done pairing plan/implement/critique/review already have -- BEFORE the
// terminal 'needs-review' entry, so the per-task Pipeline History shows the draft phase
// closing, not just the next state opening. (local-worker.ps1 records this seam as
// Invoke-TaskDb 'draft-done'; the bash port never substituted a history event for it.)
// Every draft-success return in draftTask/draftAdhocBranch/research/product_spec funnels
// through here. Idempotent w.r.t. task.status.
function concludeDraft(task) {
  task.status = 'needs-review';
  appendHistoryEvent(task, 'draft-done', draftDoneDetail(task));
  appendHistoryEvent(task, 'needs-review');
}

// task-sources.js's nextCandidateFulfillmentTask() -- the shared candidate-consumer every
// candidateFulfillment: true source uses, each fetching real file content (fetchedFiles)
// for the exact files their own candidate names, so their implement pass always has real
// content to ground a find/replace in. 2026-08-23: was a hardcoded array here (a near-
// duplicate of allowEmptyImplement just below, and of review-task.js's own now-removed
// EMPTY_APPROVAL_SOURCES) -- now reads the flag straight off each source's own
// registerTaskSource() entry instead, so a plugin's own registration is the only place
// that needs to say so. See function-length-review.js's registration for the pattern.
function isCandidateFulfillmentSource(source) {
  const entry = getRegisteredSource(source);
  return !!(entry && entry.candidateFulfillment);
}

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
function refreshCandidateFetchedFiles(task) {
  const pc = task && task.promptContext;
  if (!pc || !Array.isArray(pc.fetchedFiles) || pc.fetchedFiles.length === 0) return;
  let repoRoot;
  try { ({ repoRoot } = getConfig()); } catch (err) { console.warn('[local-draft] getConfig failed:', err.message); return; }
  if (!repoRoot) return;
  let windowFetchedFileContent;
  try { ({ windowFetchedFileContent } = require('./sdk/candidate-fulfillment.js')); } catch (err) { console.warn('[local-draft] candidate-fulfillment require failed:', err.message); return; }
  const resolvedRoot = path.resolve(repoRoot);
  const section = pc.body || '';
  pc.fetchedFiles = pc.fetchedFiles.map((f) => {
    if (!f || !f.path) return f;
    try {
      const full = path.resolve(resolvedRoot, f.path);
      if (full !== resolvedRoot && !full.startsWith(resolvedRoot + path.sep)) return f;
      return { ...f, content: windowFetchedFileContent(fs.readFileSync(full, 'utf8'), section) };
    } catch (err) {
      console.warn('[local-draft] file enrich failed:', f.path, err.message);
      return f;
    }
  });
}
function isEmptyApprovalSource(source) {
  const entry = getRegisteredSource(source);
  return !!(entry && entry.emptyApproval);
}
// Same shape as isEmptyApprovalSource/isCandidateFulfillmentSource above -- reads the
// advisoryProse flag straight off each source's own registerTaskSource() entry (same
// flag review-task.js's own isAdvisoryProseSource() already reads, not exported from
// there so re-declared here rather than reached into a sibling module's internals).
function isAdvisoryProseSource(source) {
  const entry = getRegisteredSource(source);
  return !!(entry && entry.advisoryProse);
}

// Between plan and implement, several task sources need the QUERY: lines their plan pass
// proposed actually run against a real search harness, with the hits handed to the
// implement pass as grounding (rather than leaving the local model to invent file paths or
// projects -- see this file's header). `harnessSearch` on the source's registration says
// which harness: 'archImport' greps agent-manager's own repo (archImportFetch ->
// promptContext.harnessHits/harnessFiles); 'projectSearch' hits the GitHub/HF search APIs
// (-> promptContext.searchResults). ADR-0022 Stage A4 -- one generic step here replaces six
// near-identical `if (task.source === ...)` branches.
function parseHarnessQueries(planResponse) {
  return [...(planResponse || '').matchAll(/^QUERY:\s*(.+)$/gm)].map((m) => m[1].trim()).filter(Boolean);
}

async function runHarnessSearch(kind, task, { projectSearchFetch, archImportFetch }) {
  const queries = parseHarnessQueries(task.planResponse);
  if (kind === 'projectSearch') {
    let searchResults = [];
    if (queries.length > 0) {
      try {
        searchResults = await projectSearchFetch(queries);
      } catch (e) {
        console.warn(`[local-draft] projectSearchFetch failed, proceeding with no results:`, e?.message ?? e);
        // Non-fatal -- implement proceeds with no results (its own prompt handles an empty
        // list: "(no results -- the searches returned nothing usable)").
      }
    }
    task.promptContext.searchResults = searchResults;
    appendHistoryEvent(task, 'harness-search', `${queries.length} quer(y/ies), ${searchResults.length} result(s)`);
    return;
  }
  // 'archImport' -- also pipeline_self_audit / pipeline_health_audit / ui_visibility_audit /
  // staleness_audit: literally the same archImportFetch of agent-manager's own repo, the
  // only difference being what promptContext text the implement prompt renders around the
  // hits (which lives in the prompt, not this step).
  let harnessHits = [];
  let harnessFiles = [];
  if (queries.length > 0) {
    try {
      const result = archImportFetch(queries);
      harnessHits = result.hits || [];
      harnessFiles = result.files || [];
    } catch (e) {
      console.warn(`archImportFetch failed, continuing with empty harness data: ${e && e.message ? e.message : e}`);
    }
  }
  task.promptContext.harnessHits = harnessHits;
  task.promptContext.harnessFiles = harnessFiles;
  appendHistoryEvent(task, 'harness-search', `${queries.length} quer(y/ies), ${harnessHits.length} hit(s), ${harnessFiles.length} file(s)`);
}


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
function extractCandidateSnippet(body) {
  const m = /(?:^|\n)\s*Snippet:\s*```[\w-]*\n([\s\S]*?)```/i.exec(String(body || ''));
  return m ? m[1].replace(/\s+$/, '') : '';
}

// An import/logger line an `_fix` edit routinely re-adds even when the file already has it
// (observed live: 5 blocked observability_fix tasks -- "duplicate import logging").
const REDUNDANT_LINE_RE = /^\s*(?:import logging|from logging import|(?:logger|log|_log|LOG|LOGGER)\s*=\s*logging\.getLogger\([^)]*\))\s*$/;

// The most distinctive single line of a snippet (longest non-trivial, non-comment line) --
// used to locate the flagged block inside the real file even when leading/trailing lines
// of the snippet were paraphrased or reindented.
function distinctiveLine(snippet) {
  return (snippet || '').split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length >= 12 && !/^(#|\/\/|\*|"""|''')/.test(l))
    .sort((a, b) => b.length - a.length)[0] || '';
}

// 2026-09-02: a candidate-fulfillment edit whose `find` string is a real substring of the
// file but sits far from the block the candidate actually flagged (observed live: 8 blocked
// observability_fix tasks -- the model targeted `except OSError:` when the flag was
// `except Exception:`, an `except` that returns a 504, a catch that already had logging).
function findEditFarFromAnchor(find, content, anchorSnippet) {
  const anchor = distinctiveLine(anchorSnippet);
  if (anchor.length < 12) return false;                 // no usable anchor
  if (anchorSnippet.replace(/\s+/g, ' ').includes(find.replace(/\s+/g, ' ').trim())) return false; // find IS in the snippet -- correct block
  const anchorIdx = content.indexOf(anchor);
  if (anchorIdx === -1) return false;                   // snippet stale/paraphrased -- can't judge, don't false-positive
  const findIdx = content.indexOf(find);
  return findIdx !== -1 && Math.abs(findIdx - anchorIdx) > 600; // ~15 lines away = a different block
}

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
function parseCandidateSplit(implementResponse) {
  const trimmed = (implementResponse || '').trim();
  if (!trimmed || trimmed === '""' || trimmed === "''") return null;
  let parsed;
  try {
    parsed = parseJsonMaybeFenced(trimmed);
  } catch {
    return null; // malformed JSON is a separate, pre-existing failure mode -- not this check's job
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.mode !== 'split') return null;
  const raw = Array.isArray(parsed.candidates) ? parsed.candidates : [];
  const valid = raw.filter((c) => c && typeof c.title === 'string' && c.title.trim()
    && typeof c.problem === 'string' && c.problem.trim()
    && typeof c.solution === 'string' && c.solution.trim());
  if (valid.length < 2) {
    return { invalid: true, reason: `Implement pass said mode "split" but only ${valid.length} of ${raw.length} proposed sub-candidate(s) had a real title/problem/solution -- at least 2 well-formed sub-candidates are required` };
  }
  return { candidates: valid };
}

// Resolves the per-call backend, its think capability, and the lock wrapper for one
// draftTask() run -- all of it depends on the task object (reasoning tier, model profile,
// resolved label), none of it mutates the task. Returns the four things every real
// model-call site below shares.
function resolveDraftContext(task, { localCall, withLockFn }) {
  // Resolved here rather than as a static default param: the right backend depends on the
  // task's reasoning tier (model-provider.js's reasoningTierFor()), which isn't known
  // until the task object itself is in hand -- passing the whole task (not just
  // task.source) lets a per-instance task.reasoningTier override take effect, e.g. Brain
  // Dump #77's automatic high-reasoning retry for a needs-clarification task. Explicit
  // test/caller overrides (localCall passed in) always win -- this only fills the gap
  // production code leaves (local-draft.js's own main() calls draftTask(task) with no
  // second argument at all).
  // 2026-08-24 (model-profile-registry.js): when the task's own source declares a
  // modelProfile, its model/numCtx/numPredict become defaults for every real call below --
  // spread BEFORE each call site's own opts so a pass's own tuned numPredict (plan=1400,
  // critique=900, ...) still wins over the profile's generic default, while model/numCtx
  // (never set by any call site's own opts today) reliably take effect. Skipped entirely
  // for an injected localCall (test/caller override) -- that already wins outright, same
  // as it always has; wrapping it here would silently change what a test believes it's
  // calling.
  const modelProfile = resolveModelProfile(task);
  const profileOverrides = modelProfile
    ? { model: modelProfile.model, numCtx: modelProfile.numCtx, numPredict: modelProfile.numPredict }
    : null;
  const baseLocalCall = localCall || providerFor(task).call;
  const resolvedLocalCall = profileOverrides && !localCall
    ? (opts) => baseLocalCall({ ...profileOverrides, ...opts })
    : baseLocalCall;
  // 2026-08-24 (root-caused live: every brain_dump_sort draft failed outright with
  // "does not support thinking" for as long as the brain-dump-cheap-local profile
  // existed) -- unlike model/numCtx/numPredict above, `think` can't just join
  // profileOverrides: every call site below passes its OWN explicit think value as part
  // of `opts` (plan/critique/revise: true; implement: !hasFixedLiterals), and opts is
  // spread AFTER profileOverrides in resolvedLocalCall above, so a profile-level think
  // override would never actually take effect no matter what value it held. Each call
  // site below now ANDs its own reasoning-needed value with this, instead.
  const profileSupportsThink = !modelProfile || modelProfile.think !== false;

  // Real plan/implement lock split (2026-08-22, Grimmethy: "build it now" -- see
  // single-flight-lock.js's own header for the full incident this fixes). Every real
  // resolvedLocalCall() invocation below -- plan, the non-A/B implement branch, critique,
  // revision -- shares the SAME resolved backend for one draftTask() call (it's computed
  // once, above), so this is computed once too rather than re-checked at each call site.
  // Deliberately based on labelFor(task) ALONE, not on whether localCall was injected --
  // an earlier version of this gated on `!localCall` too (skip locking whenever a test
  // supplies a mock call), but that conflated "is this call actually local" with "are we
  // in a test," which meant a test asserting real locking behavior for a normal task
  // would have to leave localCall unset and make a real Ollama/Claude call to exercise
  // it. A real flock acquire/release is single-digit milliseconds (confirmed live) --
  // cheap enough that tests just inject withLockFn as a lightweight in-memory spy instead
  // (see local-draft.test.js), and production behavior stays exactly what labelFor(task)
  // says regardless of how a test wires the rest of this function. For adhoc, the IMPLEMENT
  // path is a tiered ladder (draftAdhocBranch) whose tiers manage their own locks; for
  // research (when opted into Claude), the implement call is a Claude call that never
  // touches the local GPU. For every other task, plan and implement resolve to the SAME
  // backend, so locking around each call individually (rather than one lock spanning the
  // whole function) costs a few extra flock round-trips in exchange for never holding the
  // lock across an off-GPU call by construction.
  // labelFor(task) can genuinely return undefined now (LOCAL_MODEL has no hardcoded
  // fallback string as of the earlier fix today -- see local-client.js's own comment) --
  // treat that the same safe-default way as everywhere else in this codebase treats an
  // unresolved label ("assume local, lock" rather than risk skipping a real local call's
  // protection): `(label || '')` so `.startsWith` never throws on undefined, and an empty
  // string correctly fails the 'claude:' prefix check.
  const resolvedLabel = labelFor(task) || '';
  const resolvedCallIsLocal = !resolvedLabel.startsWith('claude:');
  const instancesDir = path.join(getConfig().pipelineDir, 'instances');
  // Locked per-model, not globally (2026-08-25 -- see single-flight-lock.js's own header
  // for the full "worker-1 and reasoning taking turns" incident this fixes): resolvedLabel
  // IS the resolved local model name whenever resolvedCallIsLocal is true (labelFor()
  // returns the bare model string for local, "claude:<model>" otherwise), so it's reused
  // directly as the lock key -- no separate resolution needed.
  // Restores the 2026-08-19 "queued" (waiting on the lock) vs "working" (actually
  // computing) heartbeat distinction that the 2026-08-22 plan/implement lock split
  // (see the header comment on local-worker.sh's own draft_display_model block) made
  // bash unable to report any more -- the real wait now happens right here, inside this
  // node process, so this is the one place that can still see it. `pass` labels which
  // sub-call is queued/working (plan/implement/critique/revise/...), same convention
  // local-worker.sh's own write_heartbeat_file calls already use for currentPass.
  // AGENT_MANAGER_INSTANCE_ID is exported by local-worker.sh specifically so a node
  // child can identify itself this way (see review-runner.sh's own identical export and
  // comment) -- best-effort no-op when absent (e.g. a direct CLI/test invocation with no
  // real daemon wrapper) rather than a hard requirement.
  const instanceId = process.env.AGENT_MANAGER_INSTANCE_ID;
  // Route the real GPU wait through the arbiter (priority class 'draft' -- below an
  // interactive chat/Discuss turn and below a reviewer vote), unless a test injected its
  // own withLockFn spy. gpu-arbiter.js wraps single-flight-lock.js's flock and adds the
  // cross-lane priority ordering + cancellation this used to lack.
  const usingInjectedLock = withLockFn !== defaultWithLock;
  const maybeLocked = (isLocal, fn, pass) => {
    if (!isLocal) return fn();
    if (instanceId) writeHeartbeatFile(instancesDir, instanceId, 'queued', resolvedLabel, task.id, pass);
    const run = () => {
      if (instanceId) writeHeartbeatFile(instancesDir, instanceId, 'working', resolvedLabel, task.id, pass);
      return fn();
    };
    if (usingInjectedLock) return withLockFn(instancesDir, run, resolvedLabel);
    return gpuArbiter.withGpu(instancesDir, { cls: 'draft', model: resolvedLabel, taskId: task.id, phase: pass }, run);
  };

  return { resolvedLocalCall, profileSupportsThink, resolvedCallIsLocal, maybeLocked };
}

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
function runStalenessFastpath(task, attempt) {
  const { deterministicRecheck } = require('./staleness-fastpath.js');
  const verdict = deterministicRecheck(task, getConfig().repoRoot);
  if (!verdict) return null;
  task.planResponse = 'Deterministic recheck: the original finding came from a scanner rule this pipeline can re-run directly against the file\'s current content -- no search terms or model judgment needed.';
  recordPlan(attempt, { text: task.planResponse, attempts: 0 });
  appendHistoryEvent(task, 'plan-done', 'deterministic recheck, no model call');
  task.promptContext.harnessHits = verdict.hits;
  task.promptContext.harnessFiles = [];
  appendHistoryEvent(task, 'harness-search', `deterministic re-scan, ${verdict.hits.length} hit(s)`);
  task.implementResponse = verdict.reportText;
  recordImplement(attempt, { text: task.implementResponse, note: `deterministic recheck: ${verdict.recommendation}` });
  appendHistoryEvent(task, 'implement-done', `deterministic recheck: ${verdict.recommendation}`);
  task.critiqueOutcome = 'no-issues';
  recordCritique(attempt, { outcome: 'no-issues' });
  appendHistoryEvent(task, 'critique-done', 'no-issues (deterministic report, nothing for a critique pass to add)');
  concludeDraft(task);
  return { succeeded: true, blocked: false };
}

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
async function draftAdhocBranch(task, {
  maybeLocked, recordModelCall, attempt, resolvedLocalCall, resolvedCallIsLocal,
  draftAdhocViaHarnessSearchFn, draftAdhocViaLocalAgenticFn, draftAdhocViaLocalAgenticWriteFn,
}) {
  // Tiered LOCAL escalation (2026-09-01, Grimmethy: "reasoning workers are supposed to go
  // through qwen. Claude needs to be removed as a dependency from that system"). Every
  // tier runs the local model against an isolated worktree:
  //   1. harness-search  -- cheap, single-shot, grep-grounded blind diff (proven).
  //   2. local-agentic   -- multi-turn, READ-ONLY tools, emits a Group-B diff (opt-in).
  //   3. local-agentic-WRITE -- multi-turn with real edit/write/run_bash in a worktree
  //      (default-on; this is what the deleted Claude adhoc-agentic-draft.js used to do).
  // Tiers 1-2 return {applied, succeeded, reason?}: applied -> done; declined -> next
  // tier. Tier 3 returns a terminal draftTask-shaped verdict (implemented / blocked /
  // needs-clarification) -- if it can't do the task it BLOCKS for a human. No Claude
  // fallback. All tiers are unconditionally lock-wrapped (always local).
  //
  // Each tier is bracketed with an 'implement-started' checkpoint. The ladder emits no
  // other history until a tier resolves, and tier 3 is a multi-turn agentic pass that
  // routinely runs for many minutes -- so without these, a task killed mid-ladder (or one
  // that keeps dying in tier 3) shows only '... -> plan-done' and the Pipeline History
  // looks cut short. With main()'s persist hook each one lands on disk the moment it fires,
  // so the log shows exactly how far the draft got. (2026-08-31, Grimmethy: "the task log
  // gets cut short" -- observed on a stubborn brain-dump adhoc looping in tier 3.)

  // PRELIMINARY DECOMPOSE CHECK (2026-09-02): one cheap model call, no tool loop, run
  // BEFORE any agentic tier. A task that is genuinely 5 endpoints + a UI + tests wastes a
  // full 35-turn tier-3 pass (and 2 retries) discovering that; catch it here instead. Only
  // on a FRESH task -- a retry / re-scoped / already-decomposed task has specific feedback
  // to act on and skips this. The decompose verdict flows straight to review -> coordinator
  // exactly like a RESOLUTION: decompose from tier 3.
  const preliminaryDecomposeEnabled = process.env.AGENT_MANAGER_PRELIMINARY_DECOMPOSE !== 'false';
  const isFreshAdhoc = !task.localRejectCount
    && !(Array.isArray(task.priorRejectionFeedback) && task.priorRejectionFeedback.length)
    && !task.rescopedFromDecompose
    && !task.autoDecomposeCount
    && !task.atomic // a file-decompose child IS the output of a decomposition -- re-splitting it loops
    && task.adhocResolution !== 'decompose';
  if (preliminaryDecomposeEnabled && isFreshAdhoc) {
    const split = await maybeLocked(resolvedCallIsLocal !== false, () => runDecomposePass(task, { mode: 'preliminary', call: resolvedLocalCall }), 'decompose-check');
    if (split && split.subTasks.length >= 2) {
      appendHistoryEvent(task, 'implement-started', `adhoc: preliminary size check -> decompose (${split.subTasks.length} pieces)`);
      task.adhocResolution = 'decompose';
      task.subTaskProposals = split.subTasks;
      task.rawDiff = '';
      task.implementResponse = `Preliminary size check: this task spans ${split.subTasks.length} independent pieces, so it was decomposed before any implementation attempt.`;
      concludeDraft(task);
      return { succeeded: true, blocked: false };
    }
  }

  appendHistoryEvent(task, 'implement-started', 'adhoc tier 1/3: harness-search (cheap grep-grounded blind diff)');
  const harnessResult = await maybeLocked(true, () => draftAdhocViaHarnessSearchFn(task), 'harness-search');
  recordTier(attempt, {
    tier: 'harness-search', applied: harnessResult.applied, reason: harnessResult.reason,
    response: harnessResult.applied ? task.implementResponse : undefined,
    rawDiff: harnessResult.applied ? task.rawDiff : undefined,
  });
  if (!harnessResult.applied && harnessResult.succeeded === false) {
    return { succeeded: false, reason: harnessResult.reason };
  }

  let localTierApplied = harnessResult.applied;
  // Carried from a declined tier 2 into the tier-3 write prompt (see the tier-3 call
  // below) so tier 3 starts from the read-only pass's map instead of re-orienting from
  // cold and running out of turns before it edits anything.
  let priorInvestigation = null;
  if (!localTierApplied) {
    appendHistoryEvent(task, 'implement-started', 'adhoc tier 2/3: local-agentic (multi-turn, read-only tools)');
    const localAgenticResult = await maybeLocked(true, () => draftAdhocViaLocalAgenticFn(task), 'local-agentic');
    recordTier(attempt, {
      tier: 'local-agentic', applied: localAgenticResult.applied, reason: localAgenticResult.reason,
      response: localAgenticResult.response, turnsUsed: localAgenticResult.turnsUsed,
      toolCallLog: localAgenticResult.toolCallLog,
    });
    appendTierWorkLog(task, { tier: 'local-agentic', turnsUsed: localAgenticResult.turnsUsed, toolCallLog: localAgenticResult.toolCallLog, finalMessage: localAgenticResult.response });
    if (!localAgenticResult.applied && localAgenticResult.succeeded === false) {
      return { succeeded: false, reason: localAgenticResult.reason };
    }
    if (!localAgenticResult.applied && localAgenticResult.investigationSummary) {
      priorInvestigation = localAgenticResult.investigationSummary;
    }
    localTierApplied = localAgenticResult.applied;
  }

  if (localTierApplied) {
    const appliedTier = harnessResult.applied ? 'harness-search' : 'local-agentic (read-only)';
    appendHistoryEvent(task, 'implement-done', `${appliedTier} tier applied, ${(task.implementResponse || '').length} chars, resolution=${task.adhocResolution}, model=${task.draftModel}`);
    concludeDraft(task);
    return { succeeded: true, blocked: false };
  }

  // Tier 3: local write-agentic. Returns the same verdict shape the Claude tier did
  // (succeeded/blocked/blockedReason/needsClarification); a non-succeeded result is a
  // genuine infra error (retry), everything else is terminal.
  appendHistoryEvent(task, 'implement-started', 'adhoc tier 3/3: local-agentic-write (multi-turn edit/write/run_bash in a worktree -- can take many minutes)');
  // Transient -- buildWriteAgenticPrompt reads it synchronously at the top of
  // draftAdhocViaLocalAgenticWrite; delete it right after so it is never persisted on the
  // task (same pattern as runPlanPass's task._seedPlan).
  if (priorInvestigation) {
    task._priorInvestigation = priorInvestigation;
  } else if (typeof task.orientNotes === 'string' && task.orientNotes.trim()) {
    // The pre-plan orient pass (component 3) already mapped this task -- feed its report to
    // tier 3 so it starts from confirmed findings instead of a blind re-grep.
    task._priorInvestigation = `Pre-plan orientation report (read-only pass, before the plan):\n\n${task.orientNotes.trim()}`;
  } else if (task.planWasGrounded && process.env.AGENT_MANAGER_ADHOC_PLAN_GROUNDING !== 'false') {
    // No agentic exploration ran, but the plan pass built deterministic grounding. Rebuild
    // it (cheap, no LLM) so tier 3 starts from verified file content instead of a blind re-grep.
    try {
      const g = buildPlanGrounding(task);
      if (g) task._priorInvestigation = `Deterministic grep grounding (no agentic exploration was run -- verify anything not shown):\n\n${g.text}`;
    } catch { /* non-fatal */ }
  }
  const agenticResult = await maybeLocked(true, () => draftAdhocViaLocalAgenticWriteFn(task, { recordModelCall }), 'local-agentic-write');
  delete task._priorInvestigation;
  recordTier(attempt, {
    tier: 'local-agentic-write',
    resolution: agenticResult.resolution || task.adhocResolution,
    blocked: agenticResult.blocked,
    reason: agenticResult.reason || agenticResult.blockedReason,
    response: agenticResult.response,
    rawDiff: agenticResult.capturedDiff || (agenticResult.blocked ? undefined : task.rawDiff),
    turnsUsed: agenticResult.turnsUsed,
    toolCallLog: agenticResult.toolCallLog,
  });
  appendTierWorkLog(task, { tier: 'local-agentic-write', turnsUsed: agenticResult.turnsUsed, toolCallLog: agenticResult.toolCallLog, finalMessage: agenticResult.response });
  if (!agenticResult.succeeded) {
    return { succeeded: false, reason: agenticResult.reason };
  }
  if (agenticResult.blocked) {
    appendHistoryEvent(task, 'blocked', agenticResult.blockedReason);
    return { succeeded: true, blocked: true, blockedReason: agenticResult.blockedReason };
  }
  // 2026-08-24 (RESOLUTION: needs-human-decision, adhoc-agentic-draft.js): a real
  // open product/design question, not a diff or a sub-task list -- nothing here for
  // an automatic reviewer to verify against real repo state, so this skips review-
  // task.js/apply-task.js entirely and goes straight to queue/needs-clarification/
  // (local-worker.sh's own move-destination branch) for a human to actually answer.
  // Reuses `needsClarification`'s FIELD NAME (not path_prefetch_resolve's specific
  // shape) so the dashboard's existing "does this task have needsClarification"
  // check and Discuss button pick it up; `reason: 'design-decision'` is what
  // distinguishes this from path_prefetch's own ambiguous/no-match held tasks (see
  // python/dashboard/app.py's api_discuss_end, which branches on this exact field).
  if (agenticResult.needsClarification) {
    // 2026-08-24 (Grimmethy: multiple-choice shortcut) -- options is undefined
    // (never a key at all, not even null) when the model didn't offer a clean
    // 2+ option OPTIONS block, so the dashboard's existing `nc.options` check
    // stays a plain truthy test either way.
    const options = parseClarificationOptions(task.implementResponse);
    task.needsClarification = {
      reason: 'design-decision', openQuestions: task.implementResponse,
      ...(options ? { options } : {}),
    };
    appendHistoryEvent(task, 'implement-done', `agentic, ${(task.implementResponse || '').length} chars, resolution=${task.adhocResolution}`);
    appendHistoryEvent(task, 'needs-clarification');
    return { succeeded: true, blocked: false, needsClarification: true };
  }
  appendHistoryEvent(task, 'implement-done', `agentic, ${(task.implementResponse || '').length} chars, resolution=${task.adhocResolution}`);
  concludeDraft(task);
  return { succeeded: true, blocked: false };
}

// research_task (Brain Dump #1 follow-up, 2026-08-17): same reasoning as the adhoc branch
// -- a real agentic Claude call (WebSearch/WebFetch this time, not
// Read/Grep/Glob/Edit/Write/Bash against a code repo) already did its own investigation
// and produced the final write-up; the local model's own plan/critique/revision loop
// would add nothing (there's no repo state to reason about, and "revision" of a research
// write-up the model already finished is redundant with the normal review-task.js pass
// this still flows into afterward).
async function draftResearchBranch(task, { recordModelCall, draftResearchImplementFn, isClaudePausedFn = isClaudePaused, attempt }) {
  // research_task has no local implementation -- WebSearch/WebFetch are Claude-only. It
  // runs only when explicitly opted onto Claude AND a token is set AND Claude isn't
  // paused; otherwise it blocks cleanly for a human (draftTask hoists the same check
  // ahead of the plan pass, this is defence-in-depth).
  const claudeStatus = researchClaudeStatus(task, isClaudePausedFn);
  if (!claudeStatus.ok) {
    appendHistoryEvent(task, 'blocked', claudeStatus.reason);
    return { succeeded: true, blocked: true, blockedReason: claudeStatus.reason };
  }
  appendHistoryEvent(task, 'implement-started', 'agentic research (WebSearch/WebFetch, multi-turn -- can take minutes)');
  const researchResult = await draftResearchImplementFn(task, { recordModelCall });
  if (!researchResult.succeeded) {
    return { succeeded: false, reason: researchResult.reason };
  }
  if (researchResult.blocked) {
    recordTier(attempt, { tier: 'agentic-research', blocked: true, reason: researchResult.blockedReason });
    appendHistoryEvent(task, 'blocked', researchResult.blockedReason);
    return { succeeded: true, blocked: true, blockedReason: researchResult.blockedReason };
  }
  recordTier(attempt, { tier: 'agentic-research', resolution: 'implemented', response: task.implementResponse });
  appendHistoryEvent(task, 'implement-done', `agentic research, ${(task.implementResponse || '').length} chars`);
  concludeDraft(task);
  return { succeeded: true, blocked: false };
}

// Fix (2026-08-31, bra-1788142124203): a plan can clear detectDegenerate (non-empty, no
// repeat/gibberish loop) while still being useless -- e.g. a lone "1. Inspect the current
// code" bullet. That stub then reaches every implement tier with no map, and for adhoc the
// tier-3 agent burns its whole turn budget re-discovering what the task text already said.
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

// The plan pass plus its harness-search grounding step. Mutates task.planResponse (and,
// for a harnessSearch source, task.promptContext.harnessHits/searchResults) and emits the
// plan-done / harness-search history events. Returns { blocked: true, blockedReason } --
// after emitting the 'blocked' event -- when the plan pass produced no usable plan (and no
// prior plan to fall back on), else { blocked: false }.
async function runPlanPass(task, {
  maybeLocked, resolvedCallIsLocal, resolvedLocalCall, profileSupportsThink, projectSearchFetch, attempt,
  runOrientPassFn = runOrientPass,
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
    try { grounding = buildPlanGrounding(task); } catch { grounding = null; }
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
        task.orientNotes = orient.notes;      // persisted -- fed to tier 3, visible for debugging
        task.oriented = true;
      }
    } catch (e) {
      appendHistoryEvent(task, 'advisory', `orient pass errored (non-fatal): ${String(e && e.message || e).slice(0, 160)}`);
    }
  }

  if (seedPlan) task._seedPlan = seedPlan;
  const planPrompt = buildPlanPrompt(task);
  delete task._seedPlan; // transient -- the seed is baked into planPrompt now; never persist it
  delete task._planGrounding; // transient -- baked into planPrompt; planWasGrounded persists

  const callPlan = () => maybeLocked(resolvedCallIsLocal, () => resolvedLocalCall({ prompt: planPrompt, think: profileSupportsThink, temperature: 0.4, numPredict: 1400, allowEmpty: allowEmptyPlan, source: task.source, ...researchPlanTools }), 'plan');
  const planLen = (r) => (r && !r.degenerate ? ((r.response || '').trim().length) : -1);

  let planResult = await callPlan();
  let totalAttempts = planResult.attempts || 1;
  let reRolled = false;
  if (substanceGated && !planResult.degenerate && planIsThin(planResult.response)) {
    // One thin (but not degenerate) roll -- give it exactly one more, then keep whichever
    // of the two rolls carries more content.
    reRolled = true;
    const reRoll = await callPlan();
    totalAttempts += reRoll.attempts || 1;
    if (planLen(reRoll) > planLen(planResult)) planResult = reRoll;
  }

  if (planResult.degenerate) {
    const blockedReason = `Plan pass degenerate: ${planResult.degenerate}`;
    recordPlan(attempt, { degenerate: planResult.degenerate, attempts: totalAttempts });
    appendHistoryEvent(task, 'blocked', blockedReason);
    return { blocked: true, blockedReason };
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
    await runHarnessSearch(harnessKind, task, { projectSearchFetch, archImportFetch });
  }
  return { blocked: false };
}

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
function tryDeterministicLiteralEdit(task, attempt) {
  const literalEditLiterals = (task.promptContext && Array.isArray(task.promptContext.fixedLiterals))
    ? task.promptContext.fixedLiterals
    : [];
  if (!(task.promptContext && typeof task.promptContext.file === 'string' && task.promptContext.file
    && typeof task.promptContext.find === 'string' && task.promptContext.find
    && literalEditLiterals.length === 1 && typeof literalEditLiterals[0].content === 'string' && literalEditLiterals[0].content)) {
    return null;
  }
  task.implementResponse = JSON.stringify({
    mode: 'edit',
    file: task.promptContext.file,
    find: task.promptContext.find,
    replace: literalEditLiterals[0].content,
  });
  recordImplement(attempt, { text: task.implementResponse, note: 'deterministic find/replace (fully specified in the task)' });
  appendHistoryEvent(task, 'implement-done', 'deterministic find/replace (file, find, and the single fixedLiterals block were all fully specified in the task -- constructed directly instead of asking the model to reproduce content it was already handed verbatim)');
  concludeDraft(task);
  return { succeeded: true, blocked: false };
}

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
async function runCritiqueAndRevision(task, {
  maybeLocked, resolvedCallIsLocal, resolvedLocalCall, profileSupportsThink, attempt,
}) {
  if (isAdvisoryProseSource(resolveSourceName(task))) {
    task.critiqueOutcome = 'skipped-advisory-prose';
    recordCritique(attempt, { outcome: task.critiqueOutcome });
    appendHistoryEvent(task, 'critique-done', task.critiqueOutcome);
    return;
  }
  const critiquePrompt = buildCritiquePrompt(task, task.planResponse, task.implementResponse);
  const critiqueResult = await maybeLocked(resolvedCallIsLocal, () => resolvedLocalCall({ prompt: critiquePrompt, think: profileSupportsThink, temperature: 0.4, numPredict: 900, source: task.source }), 'critique');

  if (critiqueResult.degenerate) {
    task.critiqueOutcome = 'critique-degenerate';
  } else if (critiqueResult.response.trim() === 'NO ISSUES FOUND') {
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
    const reviseResult = await maybeLocked(resolvedCallIsLocal, () => resolvedLocalCall({ prompt: revisePrompt, think: profileSupportsThink, temperature: 0.4, numPredict: 1400, source: task.source }), 'revise');
    if (!reviseResult.degenerate) {
      task.implementResponse = reviseResult.response;
      task.revisionApplied = true;
    }
    // Revision came back degenerate: bounded to one attempt, leave original draft
    // intact rather than lose a working draft to a bad revision call.
  }
  recordCritique(attempt, { outcome: task.critiqueOutcome, revised: !!task.revisionApplied });
  appendHistoryEvent(task, 'critique-done', task.revisionApplied ? `${task.critiqueOutcome}, revised` : task.critiqueOutcome);
}

// Token budget for the implement pass: how many tokens it may generate (implNumPredict),
// the context window that has to hold prompt + thinking trace + that output (implNumCtx),
// whether the task carries fixedLiterals to transcribe verbatim (hasFixedLiterals), and
// whether an empty implement response is a valid answer for this source
// (allowEmptyImplement). Pure -- derived from the task and the built implement prompt.
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
  const isWholeDocReport = task.source === 'pipeline_forensics';
  const implNumPredictCeiling = (task.source === 'product_spec' || task.source === 'backlog_decomposition' || task.source === 'product_spec_outline' || isWholeDocReport) ? 16000 : 8000;
  const forensicsFloor = isWholeDocReport
    ? Math.max(6000, Math.ceil(((task.promptContext && task.promptContext.evidenceText) || '').length / 8))
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
  const implNumCtx = Math.min(32768, Math.max(PINNED_NUM_CTX, Math.ceil(implPrompt.length / 3) + implNumPredict + 2048));
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
  const implNoThink = hasFixedLiterals || task.source === 'pipeline_forensics';
  return { hasFixedLiterals, implNoThink, implNumPredict, implNumCtx, allowEmptyImplement };
}

// Post-processing for the five candidate-fulfillment sources only, which are the only
// ones with a `{"mode":"split"}` path and with fetchedFiles to verify a find against.
// Mutates task (candidateSplitProposals / implementResponse) and emits the implement-done
// or blocked history event. Returns { done: true, result } when it fully resolved the
// task (a valid split, or a blocked invalid split), else { done: false } so the caller
// falls through to critique.
async function finalizeCandidateFulfillment(task, {
  maybeLocked, resolvedCallIsLocal, resolvedLocalCall, profileSupportsThink,
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
    const retryPrompt = `${implPrompt}\n\n${correction}`;
    const retryResult = await maybeLocked(resolvedCallIsLocal, () => resolvedLocalCall({ prompt: retryPrompt, think: profileSupportsThink && !implNoThink, temperature: 0.4, numPredict: implNumPredict, numCtx: implNumCtx, allowEmpty: allowEmptyImplement, source: task.source }), 'implement-retry');
    if (!retryResult.degenerate) {
      task.implementResponse = retryResult.response;
    }
    const note = `retried once (${unverified.problem})`;
    recordImplement(attempt, { text: task.implementResponse, attempts: implResult.attempts, note });
    appendHistoryEvent(task, 'implement-done', `${implResult.attempts} attempt(s), ${task.implementResponse.length} chars (${note})`);
  } else {
    recordImplement(attempt, { text: task.implementResponse, attempts: implResult.attempts });
    appendHistoryEvent(task, 'implement-done', `${implResult.attempts} attempt(s), ${task.implementResponse.length} chars`);
  }
  return { done: false };
}

// Makes the one real implement-pass model call and records it. Picks the backend --
// normally the task's resolved local/Claude call, but an A/B candidate from
// LOCAL_AB_MODELS overrides that -- runs it under the lock when it's local, records the
// call into model-stats.db, and stamps task.abCallId / task.draftModel. Returns the raw
// call result (which may carry `degenerate`); the caller owns what to do with it.
async function callImplementModel(task, ctx, { recordModelCall, implPrompt, budget }) {
  const { maybeLocked, resolvedCallIsLocal, resolvedLocalCall, profileSupportsThink } = ctx;
  const { hasFixedLiterals, implNoThink, implNumPredict, implNumCtx, allowEmptyImplement } = budget;
  const implStartedAt = new Date().toISOString();
  const implStartMs = Date.now();

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
    const { call: abClaudeCall } = require('./claude-client.js');
    // Never local -- a claude: A/B candidate never touches the local GPU, so no lock.
    implResult = await abClaudeCall({ prompt: implPrompt, model: abModel.slice('claude:'.length), maxTurns: 1, permissionMode: 'dontAsk' });
  } else if (abModel) {
    const { call: abLocalCall } = require('./local-client.js');
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
    implResult = await maybeLocked(resolvedCallIsLocal, () => resolvedLocalCall({ prompt: implPrompt, think: profileSupportsThink && !implNoThink, temperature: 0.4, numPredict: implNumPredict, numCtx: implNumCtx, allowEmpty: allowEmptyImplement, source: task.source }), 'implement');
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
  });
  // Stamped onto the task itself (not just recorded into model-stats.db, which
  // apply-task.js has no access path back to via just task.abCallId) so its commit
  // message can attribute Co-Authored-By to whichever backend actually drafted the
  // change instead of always crediting the local model -- see apply-task.js's own comment.
  task.draftModel = abModel || labelFor(task.source);
  return implResult;
}

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

  // Bookend to 'implement-done' below -- same -started/-done pairing plan/critique/review
  // have. A single implement call can legitimately run close to its timeout; with the
  // persist hook this makes a draft killed mid-call show 'implement-started' rather than
  // ending at 'plan-done'.
  appendHistoryEvent(task, 'implement-started', hasFixedLiterals ? 'fixed-literals implement pass' : 'implement pass');
  const implResult = await callImplementModel(task, ctx, { recordModelCall, implPrompt, budget });

  if (implResult.degenerate) {
    const blockedReason = `Implement pass degenerate: ${implResult.degenerate}`;
    recordImplement(attempt, { degenerate: implResult.degenerate, attempts: implResult.attempts });
    appendHistoryEvent(task, 'blocked', blockedReason);
    return { done: true, result: { succeeded: true, blocked: true, blockedReason } };
  }
  task.implementResponse = implResult.response;

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
  recordImplement(attempt, { text: task.implementResponse, attempts: implResult.attempts });
  appendHistoryEvent(task, 'implement-done', `${implResult.attempts} attempt(s), ${task.implementResponse.length} chars`);
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
  draftAdhocViaHarnessSearchFn = draftAdhocViaHarnessSearch,
  draftAdhocViaLocalAgenticFn = draftAdhocViaLocalAgentic,
  draftAdhocViaLocalAgenticWriteFn = draftAdhocViaLocalAgenticWrite,
  draftResearchImplementFn = draftResearchImplement, withLockFn = defaultWithLock,
  isClaudePausedFn = isClaudePaused, runOrientPassFn = runOrientPass,
} = {}) {
  const { resolvedLocalCall, profileSupportsThink, resolvedCallIsLocal, maybeLocked } =
    resolveDraftContext(task, { localCall, withLockFn });

  try {
    appendHistoryEvent(task, 'draft-started', task.localRejectCount ? `retry ${task.localRejectCount}` : undefined);

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
      if (task.domain === 'research') {
        const claudeStatus = researchClaudeStatus(task, isClaudePausedFn);
        if (!claudeStatus.ok) {
          appendHistoryEvent(task, 'blocked', claudeStatus.reason);
          return { succeeded: true, blocked: true, blockedReason: claudeStatus.reason };
        }
      }

      const planOutcome = await runPlanPass(task, {
        maybeLocked, resolvedCallIsLocal, resolvedLocalCall, profileSupportsThink, projectSearchFetch, attempt, runOrientPassFn,
      });
      if (planOutcome.blocked) {
        return { succeeded: true, blocked: true, blockedReason: planOutcome.blockedReason };
      }

      const literalEditResult = tryDeterministicLiteralEdit(task, attempt);
      if (literalEditResult) return literalEditResult;

      // adhoc-shaped tasks implement via a tiered LOCAL agentic ladder (harness-search ->
      // read-only agentic -> write agentic in an isolated worktree) instead of the blind
      // JSON-diff pass below -- see draftAdhocBranch(). Every path there returns a final
      // draftTask result; nothing here calls Claude.
      if (resolveSourceName(task) === 'adhoc') {
        return await draftAdhocBranch(task, {
          maybeLocked, recordModelCall, attempt, resolvedLocalCall, resolvedCallIsLocal,
          draftAdhocViaHarnessSearchFn, draftAdhocViaLocalAgenticFn, draftAdhocViaLocalAgenticWriteFn,
        });
      }

      // research_task implements via a real agentic Claude (WebSearch/WebFetch) call -- see
      // draftResearchBranch(). Same "the agentic pass already produced the final artifact,
      // skip the local plan/critique/revision loop" reasoning as the adhoc branch.
      if (task.domain === 'research') {
        return await draftResearchBranch(task, { recordModelCall, draftResearchImplementFn, isClaudePausedFn, attempt });
      }

      const implementOutcome = await runImplementPass(task, {
        maybeLocked, resolvedCallIsLocal, resolvedLocalCall, profileSupportsThink,
      }, { recordModelCall, attempt });
      if (implementOutcome.done) return implementOutcome.result;
    }

    await runCritiqueAndRevision(task, {
      maybeLocked, resolvedCallIsLocal, resolvedLocalCall, profileSupportsThink, attempt,
    });

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

  // Flush every Pipeline-History checkpoint to disk the moment it's recorded, so a long
  // draft's progress (draft-started, plan-done, harness-search, implement-done, ...) shows
  // up in the dashboard while the draft is still running -- and survives the worker being
  // killed mid-draft (chat preempt, stop.sh) instead of vanishing with the process. The
  // authoritative writeTaskJson below still runs on completion; these are additive.
  setHistoryPersistHook(() => {
    try { writeTaskJson(taskPath, task); } catch (_) { /* best-effort */ }
  });

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
  // Housekeeping: drop worklogs for tasks that have left the pre-merge queue (reached
  // done/ or gone). Cheap, best-effort, and runs on every draft so queue/worklogs/ stays
  // bounded even when the apply loop (the other prune caller) is disabled.
  try { pruneWorkLogs(); } catch (_) { /* best-effort */ }
  process.stdout.write(JSON.stringify(result));
}

module.exports = { draftTask, findUnverifiedEdit, extractCandidateSnippet, parseCandidateSplit, concludeDraft, draftDoneDetail, computeImplementBudget, planIsThin, bestPriorPlan, refreshCandidateFetchedFiles };

if (require.main === module) {
  main();
}
