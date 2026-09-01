'use strict';

// Review step: takes one task sitting in queue/review/ (status "needs-review", written by
// local-draft.js) and decides approved vs. blocked. Port of review-runner.ps1's 'local'
// review-provider path ONLY -- the 'claude' path (a single `claude -p` call that reviews
// AND applies in one shot) is a different reviewProvider mode this deployment never uses
// (REVIEW_PROVIDER env var is unset here, and review-runner.ps1's own default is 'local'),
// so it's out of scope. Under the 'local' path the local model has no tool access -- it produces a
// verdict only -- so APPROVE moves the task to queue/approved/ for apply-task.sh to
// actually execute; it never pushes/writes anything itself.
//
// Trimmed to the domains task-domains.json actually wires up on Linux (deep_dive,
// project_search, brain_dump_sort, secondbrain, default, adhoc, research) -- the
// arch_discovery-only missing-file fact-check filter is left out since that source can't
// reach this script.
//
// 'research' (Grimmethy, 2026-08-20: "Last hours report shows 0 tasks done. Please
// investigate"): task-domains.json never had a research_task entry at all, even though
// local-draft.js has had a real domain==='research' agentic-drafting branch since
// research_task shipped -- every research_task draft that ever reached review hard-failed
// here with "Unknown task domain: research", permanently, not just during a rate-limit
// window. Confirmed live: 3 research_task items sat in queue/review/ since 2026-08-17,
// review-runner.log showing that exact error on every attempt. This is a per-deployment
// task-domains.json config gap (that file is gitignored, "a file YOU own" per README), not
// a code bug -- getDomainConfig() itself was always domain-agnostic. Documented here so a
// fresh deployment's task-domains.json doesn't silently omit it the same way.
//
// CLI: node review-task.js <review.json>
// Writes ONE line of JSON to stdout:
//   { succeeded: true, verdict: 'approved' }
//   { succeeded: true, verdict: 'blocked', blockedReason: '...', blockedStage?: 'review' }
//   { succeeded: false, reason: '...' }
// Same division of labor as local-draft.js/apply-task.js: this script mutates and
// rewrites the task JSON IN PLACE at the given path; the caller (review-runner.sh) owns
// moving the file to queue/approved/ or queue/blocked/.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { getConfig, ensureRegistered } = require('./config.js');
const { checkDraft } = require('./fact-checker.js');
const { resolveModelProfile } = require('./model-provider.js');
const { majorityVote: localMajorityVoteBackend } = require('./local-client.js');
const { recordOutcome: defaultRecordModelOutcome } = require('./model-stats-client.js');
const { parseJsonMaybeFenced } = require('./json-fence.js');
const { appendHistoryEvent, setHistoryPersistHook } = require('./task-history.js');
const { getRegisteredSource, resolveSourceName } = require('./task-source-registry.js');

// Populate the registry with this repo's built-ins AND any AGENT_MANAGER_REGISTER_PATH
// plugin sources (agent-manager-hygiene: observability/performance/function-length/arch/
// unused-export). review-task.js reads each source's advisoryProse/emptyApproval/
// candidateFulfillment flags off the registry -- without this, a plugin source's task is
// treated as unregistered and its short prose verdict gets wrongly auto-rejected. Matches
// apply-task.js / get-grounding-source.js, which already call this at load. (Before the
// 2026-08-27 plugin split, requiring prompts.js -> task-sources.js registered everything
// eagerly; it no longer covers plugin sources.)
ensureRegistered();

function writeTaskJson(taskPath, task) {
  // Atomic: the history persist hook (see main()) rewrites this file on every review
  // checkpoint while votes are still being collected, and the dashboard polls it
  // concurrently -- never leave a half-written file visible. Same-dir tmp so the rename
  // stays on one filesystem.
  const tmp = `${taskPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(task, null, 2));
  fs.renameSync(tmp, taskPath);
}

function getDomainConfig(domainsPath, domain) {
  const domains = JSON.parse(fs.readFileSync(domainsPath, 'utf8'));
  const cfg = domains[domain];
  if (!cfg) throw new Error(`Unknown task domain: ${domain} (valid: ${Object.keys(domains).join(', ')})`);
  return cfg;
}

function getWorkDir(cfg, { repoRoot, secondBrainDir }) {
  if (cfg.workDirKind === 'repoRoot' || cfg.workDirKind === 'taxharvestRoot') return repoRoot;
  if (cfg.workDirKind === 'secondBrainDir') return secondBrainDir;
  throw new Error(`Unknown workDirKind: ${cfg.workDirKind}`);
}

// Local-model review and worker draft calls share one local GPU/model slot -- stagger review's
// start if a worker looks actively mid-call, same contention-avoidance local-worker.ps1's
// Wait-ForLocalAvailability does. Best-effort: never blocks more than ~15s total.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForLocalAvailability(instancesDir, maxWaitAttempts = 3, waitSeconds = 5) {
  for (let i = 0; i < maxWaitAttempts; i++) {
    let busy = false;
    let files = [];
    try { files = fs.readdirSync(instancesDir).filter((f) => f.startsWith('worker-') && f.endsWith('.json')); } catch (e) { /* no instances dir yet */ }
    for (const f of files) {
      try {
        const w = JSON.parse(fs.readFileSync(path.join(instancesDir, f), 'utf8'));
        if (w.status !== 'working') continue;
        if ((Date.now() - new Date(w.lastHeartbeat).getTime()) / 1000 < 10) { busy = true; break; }
      } catch (e) { /* unreadable/mid-write heartbeat -- ignore */ }
    }
    if (!busy) return;
    await sleep(waitSeconds * 1000);
  }
}

// Deterministic empty-approve: several task sources' implement prompts explicitly ask for
// the empty string when there's genuinely nothing to change (see prompts.js), a legitimate
// approved outcome at review time -- and (2026-08-22/23) some are further exempted from
// the isNonImplementation gate below (NON_IMPL_PATTERNS / the <80-char-no-code-fence
// heuristic, written assuming every draft is code) because their OWN valid deliverable
// can be a short advisory prose verdict instead -- a real "false positive, here's why"
// paragraph, or staleness_audit's own short "nothing new to add here" report, would
// otherwise trip the same false-positive-for-refusal heuristic.
//
// 2026-08-23 (Grimmethy: "What else needs to be moved in order to properly modularize
// the maintenance tasks?"): both used to be hardcoded arrays here, duplicated ALMOST
// verbatim as local-draft.js's own allowEmptyImplement/CANDIDATE_FULFILLMENT_SOURCES --
// confirmed live, EMPTY_APPROVAL_SOURCES and allowEmptyImplement were the exact same 11
// names, a duplicate-list bug class waiting to happen (add a source to one, forget the
// other). Now read directly off each source's own registerTaskSource() entry
// (emptyApproval/advisoryProse flags) instead -- the actual prerequisite a plugin needed
// to add a new maintenance source without editing this file at all; see
// function-length-review.js's own registration for the pattern.
function isEmptyApprovalSource(source) {
  const entry = getRegisteredSource(source);
  return !!(entry && entry.emptyApproval);
}
function isAdvisoryProseSource(source) {
  const entry = getRegisteredSource(source);
  return !!(entry && entry.advisoryProse);
}
function isEffectivelyEmpty(trimmed) {
  return trimmed === '' || trimmed === '""' || trimmed === "''";
}

const NON_IMPL_PATTERNS = [
  /"mode"\s*:\s*"read"/,
  /^(let me|i need to|i will|i'll|i am going to|i'm going to)\s+(read|check|look at|search|verify|examine|understand)\b/i,
];

function decodeGroupBContent(implementResponse) {
  try {
    const parsed = parseJsonMaybeFenced(implementResponse);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const parts = [];
    for (const item of items) {
      if (item && typeof item.content === 'string') parts.push(item.content);
      if (item && typeof item.find === 'string') parts.push(item.find);
      if (item && typeof item.replace === 'string') parts.push(item.replace);
    }
    return parts.join('\n \n');
  } catch (e) {
    return '';
  }
}

// review-task.js reads each source's own review-gate guidance off the registry
// (source.reviewGuidance / source.reviewCompletenessQuestion, set in src/task-sources.js
// or by an AGENT_MANAGER_REGISTER_PATH plugin) instead of an if (task.source === ...) chain.
// A field may be a plain string or a (task) => string|null function (the adhoc source
// branches on task.adhocResolution). resolveDynamicReviewField normalizes both to a
// non-empty string or null.
function resolveDynamicReviewField(field, task) {
  const value = typeof field === 'function' ? field(task) : field;
  return typeof value === 'string' && value ? value : null;
}

function buildVerdictPrompt(task, factCheck, groundingText) {
  const lines = [];
  lines.push('You are a review gate in an unattended pipeline. You are producing a VERDICT ONLY -- you have no ability to run commands, write files, or touch git. Do not attempt to.');
  // 2026-08-24 (Grimmethy, caught live): a real, well-sourced research draft citing
  // June/August 2026 press coverage got rejected as fabricated -- the reviewer's own
  // blockedReason literally said "given the current real-world date context (2024/2025)",
  // i.e. it had no actual anchor for "today" and fell back to an assumed date nowhere
  // near this pipeline's real clock. This prompt never stated the real date anywhere
  // before now. Stated once, unconditionally -- affects date-sensitive judgment for any
  // source, not just research (a code claim citing "as of today" could hit the same trap).
  lines.push(`The real current date is ${new Date().toISOString().slice(0, 10)}. Do not assume any earlier date is "now," and do not reject a cited source, URL, or claimed date merely for being after some earlier date you might otherwise assume is current -- judge recency/plausibility against the real date above, not your own training-data intuition of "the present."`);
  lines.push('The drafting model produced the plan and implementation below and cannot verify its own claims -- treat every concrete claim as UNVERIFIED.');
  lines.push('');
  lines.push(`TASK: ${task.title} (domain=${task.domain}, source=${task.source})`);
  lines.push('');
  lines.push('--- PLAN ---');
  lines.push(task.planResponse);
  lines.push('');
  lines.push('--- IMPLEMENT draft ---');
  lines.push(task.implementResponse);
  lines.push('');
  // 2026-08-24 (pipeline hardening): only reaches here when critiqueOutcome ===
  // 'issues-flagged' AND revisionApplied is true -- the unaddressed-critique case
  // (revision failed/never happened) is a deterministic reject BEFORE this prompt is
  // ever built, see reviewTask()'s own gate. This is the "revision was attempted, but
  // did it actually work" case -- reusing the SAME review call to check, rather than a
  // separate cross-check call, since this prompt already reviews the draft in full.
  if (task.critiqueOutcome === 'issues-flagged' && task.revisionApplied && task.critiqueText) {
    lines.push('--- This draft was revised in response to an earlier critique pass ---');
    lines.push(`Before producing the draft above, an independent critique call flagged real problems, and a revision was attempted. The draft above is the REVISED version. Verify the issues below were actually addressed -- if the draft above still has any of these same problems, reject it; do not assume a revision attempt means the issues are fixed.`);
    lines.push(task.critiqueText.length > 4000 ? `${task.critiqueText.slice(0, 4000)}\n...[truncated]` : task.critiqueText);
    lines.push('');
  }
  lines.push('--- Deterministic fact-check pre-filter (necessary, NOT sufficient) ---');
  lines.push(JSON.stringify(factCheck));
  lines.push('');
  if (groundingText) {
    lines.push('--- Real grounding source (the material the drafter was actually given -- use this to verify SPECIFIC claims, not just the fact-check above) ---');
    lines.push(groundingText.length > 40000 ? `${groundingText.slice(0, 40000)}\n...[truncated]` : groundingText);
    lines.push('');
  }
  lines.push('The fact-check above is deterministic and authoritative for file existence -- it already checked the real filesystem. A claimed path listed with "exists": true is CONFIRMED real; do not express doubt about it or re-litigate whether it exists. A path listed with "exists": false AND "isCreateTarget": true is a path this draft is itself WRITING -- a Group B mode:"create" target, or a brain_dump_sort/secondbrain draft\'s "secondBrainPath" destination (filing a brand-new note is the normal, most common outcome). It not existing yet is the EXPECTED case, not evidence of fabrication; do not reject a draft for this. Only "exists": false WITHOUT isCreateTarget is evidence toward fabrication.');
  lines.push('An "imprecise-file-path" flag (or a fileChecks entry with "exists": true and "resolvedVia" other than "exact") means the draft named a REAL file but with a missing or wrong directory prefix (e.g. "app.py" for "server/app.py"). The file exists -- this is a citation-style nit, NOT fabrication. Do NOT reject a draft for an imprecise path that resolves to a real file.');
  lines.push('A "fabricated-commit-reference" flag means the draft cited a specific commit hash (e.g. "already resolved in commit abc1234") that this pipeline confirmed via real `git cat-file` does NOT exist anywhere in this repo\'s history -- this is deterministic and authoritative the same way a missing-file flag is: strong, concrete evidence the draft invented a resolution instead of doing (or honestly reporting it could not do) the real work asked for. commitChecks with "exists": null means the hash could not be checked (no git access) -- treat that as unconfirmed, not as fabrication.');
  lines.push('');
  lines.push('Judge whether this draft is correct, narrowly scoped, and safe to apply as-is. Reject if it is fabricated, over-broad, or the fact-check flags a real problem.');
  lines.push('Also REJECT if the draft consists mainly of meta-commentary, hedging, or a refusal ("I cannot verify this...", "I do not have enough information...", "this cannot be confirmed...") standing in for the real content the task asked for. A draft expressing uncertainty about its OWN claim is itself a reason to reject, not something to average into "seems fine." IMPORTANT EXCEPTION: this rule is about hedging PROSE, not about a genuinely EMPTY response (zero characters, or effectively so) -- several task types below are explicitly instructed to output nothing when there is nothing real to report, and that is NOT the same failure as writing evasive text instead of answering. If the draft is truly empty, judge it ONLY by the source-specific rule below (if any); do not reject an empty draft under this rule merely for containing no implementation.');
  // The PLAN section is drafted BLIND for every adhoc task, and each source's own
  // judging carve-out, now live on the source's reviewGuidance (see resolveDynamicReviewField).
  // candidateSplitProposals stays an explicit check here -- it is a task field, not a source.
  const registeredSource = getRegisteredSource(resolveSourceName(task));
  if (task.candidateSplitProposals) {
    // 2026-08-26, root-caused live via arch-review-ac-4 -- see prompts.js's
    // candidateSplitInstructions and local-draft.js's parseCandidateSplit for the full
    // incident/design. A split proposal deliberately has no diff, and the generic
    // "does it contain real, complete code" completeness question would reject every
    // correct split on sight for exactly that reason.
    lines.push('This candidate-fulfillment drafter judged the original candidate too large/risky to implement safely in one atomic JSON edit, and produced a JSON array of smaller sub-candidates instead of a diff -- there is deliberately no code or diff here, and that is NOT a reason to reject. Judge ONLY the actual SPLIT in the IMPLEMENT draft below. Is it sound: do the sub-candidates, together, actually cover the FULL original candidate scope (no silently dropped requirement)? Is each sub-candidate concrete, independently implementable as a single small edit on its own (not still vague, not itself obviously too large)? Does each have a real title/problem/solution, not a placeholder or a bare reference back to the original candidate? Reject if a requirement was dropped, a sub-candidate is too vague/large to actually help, or a sub-candidate is not genuinely well-formed -- never merely because no code was written, and never because splitting wasn\'t strictly necessary (that\'s a judgment call the drafter is allowed to make conservatively).');
  } else {
    const guidance = resolveDynamicReviewField(registeredSource && registeredSource.reviewGuidance, task);
    if (guidance) lines.push(guidance);
  }
  const completenessQuestion = task.candidateSplitProposals
    // "real, complete code" directly contradicts the split carve-out above, whose whole
    // point is that no code was written yet.
    ? 'Does it contain a well-formed JSON array of sub-candidates, each with a real title/problem/solution, that together cover the original candidate with nothing dropped?'
    : resolveDynamicReviewField(
        registeredSource && registeredSource.reviewCompletenessQuestion, task)
      || 'Does it contain real, complete code (not a bare tool-call request, not meta-commentary like "let me read the file first", not a partial fragment)?';
  lines.push(`Before answering, check the draft against the TASK above point by point: does it touch every file/requirement the task named? ${completenessQuestion} Does anything in it contradict the real grounding source or fact-check above?`);
  lines.push('Respond with EXACTLY one of these two forms, nothing else. BOTH require a concrete, specific reason -- cite an actual file name, field name, or line of the draft. A reason that just restates the verdict word ("looks correct", "seems fine", "meets requirements") is not acceptable and will be discarded as unreasoned.');
  lines.push('APPROVE: <one-sentence reason citing the specific requirement(s) you verified are met>');
  lines.push('REJECT: <one-sentence reason citing the specific problem>');
  return lines.join('\n');
}

// Same classify function as local-client.js's own CLI (mode: 'majority-vote') --
// duplicated rather than imported since it lives inline in that file's CLI section, not
// exported. minReasoningChars=20: discards a vote whose reasoning (after stripping the
// verdict marker + colon) is too short to carry real signal.
function classifyVote(markers, minReasoningChars) {
  return (text) => {
    const lower = text.toLowerCase();
    const marker = markers.find((m) => lower.includes(m.toLowerCase()));
    if (!marker) return null;
    if (minReasoningChars > 0) {
      const stripped = text.replace(new RegExp(`${marker}\\s*:?`, 'i'), '').trim();
      if (stripped.length < minReasoningChars) return null;
    }
    return marker;
  };
}

/**
 * The actual review logic, independent of the CLI/stdout wrapper below -- exported (via
 * the reviewTask wrapper) so tests can call it directly with a fake localMajorityVote.
 */
async function runReview(task, { repoRoot, pipelineDir, secondBrainDir, domainsPath, instancesDir, deepDiveCoveragePath, localMajorityVote = null, recordModelOutcome = defaultRecordModelOutcome } = {}) {
  // Resolved here rather than as a static default param, same reasoning as
  // local-draft.js's draftTask() -- the right backend depends on the task's reasoning
  // tier, only known once the task object is in hand. Passing the whole task (not just
  // task.source) lets a per-instance task.reasoningTier override take effect. An explicit
  // caller override always wins.
  // 2026-08-24 (model-profile-registry.js): same pattern as local-draft.js's own
  // resolvedLocalCall wrapping -- when the task's own source declares a modelProfile,
  // its overrides become defaults spread BEFORE the real majorityVote() call below (opts
  // spread after wins, though the one real call site doesn't set model/numCtx/numPredict/
  // effort/timeoutMs itself today, so the profile's values reliably take effect). Passing
  // both local-only (numCtx/numPredict) and claude-only (effort/timeoutMs) keys
  // unconditionally is safe -- whichever backend's majorityVote() runs only destructures
  // the params it recognizes, ignoring the rest. Skipped for an injected
  // localMajorityVote (test/caller override), same as local-draft.js.
  const modelProfile = resolveModelProfile(task);
  const profileOverrides = modelProfile
    ? {
      model: modelProfile.model, numCtx: modelProfile.numCtx, numPredict: modelProfile.numPredict,
      effort: modelProfile.effort, timeoutMs: modelProfile.timeoutMs,
    }
    : null;
  // 2026-08-27, Grimmethy: "Review should never be gated behind claude. Please allow
  // the local model to review them" -- ALWAYS the local backend, never providerFor(task)
  // (which would route a high-reasoning-tier task to Claude). Root-caused live: this
  // review call had, in practice, ALREADY always run local regardless of tier -- nothing
  // in review-task.js's own require graph ever loaded task-sources.js, so
  // providerFor()'s tier lookup silently saw an empty registry and defaulted to local
  // every time -- but review-runner.sh's separate bash-side pre-check DID load that
  // registry (to compute its own Claude-budget gate), correctly saw a high-tier task,
  // and skipped it whenever Claude was paused/rate-limited: a real task that would have
  // reviewed successfully in seconds sat unreviewed for hours, purely because of a
  // mismatch between what the pre-check assumed would happen and what actually would
  // have. Making this the real, intentional behavior (not an accidental side effect of
  // a missing require) instead of just deleting review-runner.sh's now-dead gate --
  // review-runner.sh's own header already documented the intent ("Reviewer is always
  // Ornith (never Claude)"), this just makes the code match it for real.
  const baseMajorityVote = localMajorityVote || localMajorityVoteBackend;
  const resolvedMajorityVote = profileOverrides && !localMajorityVote
    ? (opts) => baseMajorityVote({ ...profileOverrides, ...opts })
    : baseMajorityVote;
  appendHistoryEvent(task, 'review-started');
  const domainCfg = getDomainConfig(domainsPath, task.domain);
  const workDir = getWorkDir(domainCfg, { repoRoot, secondBrainDir });

  // fact-check: deep_dive's real "repo root" for this purpose is the cloned external
  // project (looked up by promptContext.projectSlug), not agent-manager's own repo --
  // otherwise every referenced file reports as missing.
  let repoRootForCheck = workDir;
  if (task.source === 'deep_dive' && deepDiveCoveragePath && fs.existsSync(deepDiveCoveragePath)) {
    try {
      const ddCoverage = JSON.parse(fs.readFileSync(deepDiveCoveragePath, 'utf8'));
      const ddProj = ddCoverage.projects && ddCoverage.projects[task.promptContext.projectSlug];
      if (ddProj && ddProj.clonePath) repoRootForCheck = ddProj.clonePath;
    } catch (e) { /* fall back to workDir */ }
  } else if (task.source === 'brain_dump_sort' && secondBrainDir) {
    // Same reasoning as deep_dive above: brain_dump_sort's implementResponse names a
    // secondBrainPath, which is a location under the VAULT, never under repoRoot --
    // task-domains.json's brain_dump_sort entry has workDirKind:'repoRoot' (a domain-
    // config default, not specific to this source), so without this override every
    // single brain_dump_sort draft's secondBrainPath got fact-checked against the wrong
    // directory entirely and reported "missing" regardless of whether the destination
    // note already existed. Confirmed live 2026-08-16: this was one of two compounding
    // causes (see buildVerdictPrompt's brain_dump_sort carve-out below for the other)
    // behind EVERY real brain_dump_sort task getting rejected at review.
    repoRootForCheck = secondBrainDir;
  }

  const taskPathForGrounding = path.join(require('os').tmpdir(), `review-grounding-${task.id}.json`);
  let groundingText = '';
  try {
    fs.writeFileSync(taskPathForGrounding, JSON.stringify(task));
    groundingText = execFileSync('node', [path.join(__dirname, 'get-grounding-source.js'), taskPathForGrounding], { encoding: 'utf8' });
  } catch (e) {
    console.error(`[review-task] grounding-source generation failed for ${taskPathForGrounding}: ${e.stack || e.message || String(e)}`);
    groundingText = '';
  } finally {
    try { fs.unlinkSync(taskPathForGrounding); } catch (e) { /* best-effort cleanup */ }
  }

  // Feed the consumer's configured code dirs (AGENT_MANAGER_GREP_DIRS) as extraRoots so
  // resolveAgainstRepo can turn a bare `app.py` into `server/app.py` instead of reporting
  // it "missing" -> "fabricated". Only meaningful when the fact-check runs against
  // agent-manager's OWN repoRoot (the default); for a deep_dive external clone or the
  // second-brain vault, these dirs don't apply and simply won't match -- harmless.
  const factCheckExtraRoots = (repoRootForCheck === workDir)
    ? (() => { try { return getConfig().grepAllowedDirs; } catch { return []; } })()
    : [];
  const factCheck = checkDraft(task.implementResponse || '', repoRootForCheck, groundingText || undefined, factCheckExtraRoots);
  // `imprecise-file-path` is informational (a real file cited with a sloppy prefix) --
  // it must not by itself flip the verdict label to "flagged".
  const factCheckVerdict = (factCheck.flags || []).some((f) => f.type !== 'imprecise-file-path') ? 'flagged' : 'pass';

  // 2026-08-24 (pipeline hardening -- resurrects a real gap closed once already on
  // 2026-08-12 for the old Windows/PowerShell review-runner.ps1, never carried forward
  // across this project's Linux port): fact-checker.js's own comments call ungrounded-url
  // and ungrounded-field "almost never a false positive" -- checkGroundedValues() only
  // ever flags a value when there IS real grounding source text to compare against and
  // the value appears NOWHERE in it, placeholders already exempted. That precision was
  // being wasted as advisory context a review vote could (and did) simply ignore, the
  // same "known-bad signal, only advisory" shape every OTHER deterministic gate in this
  // function already treats as disqualifying. Hard-blocks before spending a review call,
  // same as the empty-response/non-implementation/fixed-literals gates below.
  // 2026-08-25, root-caused live via a real blocked adhoc task (second-brain review
  // sweep): RESOLUTION: decompose (adhoc-agentic-draft.js's "task judged too large,
  // propose sub-tasks instead of a diff" outcome, carved out in buildVerdictPrompt below
  // -- see its own comment) got hard-blocked here anyway, before ever reaching that
  // carve-out, because a decompose proposal's sub-task rawText routinely SUGGESTS names
  // for config/paths a FUTURE sub-task should create (e.g. "add
  // AGENT_MANAGER_SECOND_BRAIN_REVIEW_COVERAGE_PATH, following the pattern of
  // stalenessAuditCoveragePath" -- explicitly marked as a proposal, "e.g.", never a claim
  // that it already exists). checkGroundedValues' whole premise is "a value cited as
  // already-real that appears nowhere in the grounding source is fabricated" -- a
  // category error against text that is deliberately proposing something new, the exact
  // same "new declaration, not a claimed-existing value" distinction NEW_DECLARATION_RE
  // already carves out for a real diff's own `+const NAME = ...` line, just for a
  // decompose proposal's prose instead of a diff. Scoped ONLY to the two high-precision
  // flags that hard-block with no review call at all -- factCheck's OTHER checks (missing-
  // file, fabricated-commit-reference, unconfirmed-relationship) still run and still hard-
  // block a decompose response exactly as before: those check "does this cite something
  // that claims to already exist," which stays a real fabrication signal even in a
  // decompose proposal's prose. And the full factCheck (including these two flags) is
  // still handed to the reviewer model via buildVerdictPrompt below regardless -- this
  // only removes the automatic no-review-call block, not the information itself.
  // 2026-08-26: a `{"mode": "split"}` proposal (see candidateSplitInstructions) is the
  // exact same category as a decompose proposal above -- prose describing FUTURE
  // sub-candidates, which routinely names config/field values a future drafting pass
  // should create, not a claim that something already exists. Same carve-out, same
  // "still checked, just not auto-blocked" scoping.
  const isDecomposeProposal = (task.source === 'manual' && task.adhocResolution === 'decompose') || !!task.candidateSplitProposals;
  const highPrecisionFlags = isDecomposeProposal
    ? []
    : (factCheck.flags || []).filter((f) => f.type === 'ungrounded-url' || f.type === 'ungrounded-field');
  if (highPrecisionFlags.length > 0) {
    const detail = highPrecisionFlags.map((f) => `${f.type}: ${f.detail}`).join('; ');
    const reason = `Deterministic gate: draft cites a value that appears nowhere in its real grounding source -- ${detail}. This fact-check flag is high-precision (almost never a false positive) and treated as disqualifying, not merely advisory context a vote could ignore -- no local-model review call spent on a draft already known to contain a hallucinated value.`;
    task.reviewProvider = 'deterministic-ungrounded-value';
    recordModelOutcome({ callId: task.abCallId, outcome: 'rejected', outcomeStage: 'review', outcomeReason: reason });
    appendHistoryEvent(task, 'blocked', reason);
    return { succeeded: true, verdict: 'blocked', blockedReason: reason, blockedStage: 'review', factCheckVerdict };
  }

  const trimmedImplResponse = (task.implementResponse || '').trim();
  const effectivelyEmpty = isEffectivelyEmpty(trimmedImplResponse);

  if (isEmptyApprovalSource(task.source) && effectivelyEmpty) {
    task.reviewedAt = new Date().toISOString();
    task.reviewProvider = 'deterministic-empty-approve';
    task.localVerdict = `Auto-approved: implementResponse is genuinely empty, a documented valid outcome for ${task.source} (no local-model review call spent -- this is deterministic, not a judgment call)`;
    recordModelOutcome({ callId: task.abCallId, outcome: 'approved', outcomeStage: 'review', outcomeReason: null });
    appendHistoryEvent(task, 'approved', 'deterministic-empty-approve');
    return { succeeded: true, verdict: 'approved', factCheckVerdict };
  }

  let isNonImplementation = false;
  if (!effectivelyEmpty) {
    isNonImplementation = NON_IMPL_PATTERNS.some((pat) => pat.test(trimmedImplResponse));
    if (!isNonImplementation && trimmedImplResponse.length < 80 && !trimmedImplResponse.includes('```')) {
      isNonImplementation = true;
    }
  }
  if (isNonImplementation && !isEmptyApprovalSource(task.source) && !isAdvisoryProseSource(task.source)) {
    const reason = 'Deterministic gate: implementResponse is a bare tool-call request or meta-commentary, not a real implementation attempt -- no local-model review call spent (mechanically detectable, not a judgment call).';
    task.reviewProvider = 'deterministic-non-implementation';
    recordModelOutcome({ callId: task.abCallId, outcome: 'rejected', outcomeStage: 'review', outcomeReason: reason });
    appendHistoryEvent(task, 'blocked', reason);
    return { succeeded: true, verdict: 'blocked', blockedReason: reason, blockedStage: 'review', factCheckVerdict };
  }

  const fixedLiterals = (task.promptContext && task.promptContext.fixedLiterals) || [];
  if (fixedLiterals.length > 0) {
    const decoded = decodeGroupBContent(task.implementResponse || '');
    const compareText = decoded || trimmedImplResponse;
    // .trimEnd() on the literal only, not compareText -- narrowly tolerates a missing
    // trailing newline (never semantically meaningful for "was this copied correctly")
    // without loosening the check anywhere else. Confirmed live 2026-08-14: a whole-file
    // fixedLiterals block ending in "\n" (the normal convention for a source file) was
    // faithfully reproduced character-for-character by the model EXCEPT for that final
    // newline once embedded as a JSON string value -- a false-positive rejection on an
    // otherwise-perfect copy, burning a real retry attempt on a class of mismatch that
    // carries no actual signal about whether the content was copied correctly.
    const missing = fixedLiterals.filter((lit) => !compareText.includes(lit.content.trimEnd()));
    if (missing.length > 0) {
      const missingNames = missing.map((m) => m.name).join(', ');
      const reason = `Deterministic gate: draft does not contain the required fixed block(s) character-for-character: ${missingNames}. These were given verbatim in the task and must be copied exactly, not rewritten from memory -- no local-model review call spent on a draft that already fails a mechanical check.`;
      task.reviewProvider = 'deterministic-fixed-literals';
      recordModelOutcome({ callId: task.abCallId, outcome: 'rejected', outcomeStage: 'review', outcomeReason: reason });
      appendHistoryEvent(task, 'blocked', reason);
      return { succeeded: true, verdict: 'blocked', blockedReason: reason, blockedStage: 'review', factCheckVerdict };
    }
  }

  // 2026-08-24 (pipeline hardening -- same resurrected gap as the ungrounded-value block
  // above, closed once already on 2026-08-12 for review-runner.ps1, never carried
  // forward across this project's Linux port): local-draft.js's own critique+revision
  // pass had already found real issues in this exact draft (task.critiqueOutcome ===
  // 'issues-flagged'), but review-task.js never once read that field -- a draft its own
  // critique had flagged as broken could still win a clean vote, because the review pass
  // simply never knew the critique ran at all. task.revisionApplied is only ever false
  // here when local-draft.js's own follow-up revision call came back degenerate (see its
  // own comment) -- meaning the ORIGINAL, critique-flagged draft is what's about to reach
  // review, with a known, real, already-identified problem review has no visibility into.
  if (task.critiqueOutcome === 'issues-flagged' && !task.revisionApplied) {
    const reason = `Deterministic gate: this draft's own critique pass flagged real issues, and the follow-up revision attempt failed (degenerate) or was never applied -- the draft reaching review is the SAME one the critique already found problems with. No local-model review call spent voting on a draft already known to have unaddressed issues.${task.critiqueText ? ` Critique: ${task.critiqueText.slice(0, 500)}` : ''}`;
    task.reviewProvider = 'deterministic-unaddressed-critique';
    recordModelOutcome({ callId: task.abCallId, outcome: 'rejected', outcomeStage: 'review', outcomeReason: reason });
    appendHistoryEvent(task, 'blocked', reason);
    return { succeeded: true, verdict: 'blocked', blockedReason: reason, blockedStage: 'review', factCheckVerdict };
  }

  await waitForLocalAvailability(instancesDir);

  const verdictPrompt = buildVerdictPrompt(task, factCheck, groundingText);
  // minAgreeing: 2 of 3 -- a genuine majority, matching majorityVote()'s own documented
  // default and intent (an ABSOLUTE count of agreeing real votes, guarding against e.g. 1
  // real + 2 degenerate votes looking like a confident 1-0 consensus -- see that function's
  // comment). This was 3 (i.e. requiring full unanimity from 3 independent, temperature-0.2
  // but still stochastic votes) -- confirmed live 2026-08-16: 23 of 181 blocked tasks,
  // the second-largest group in queue/blocked/, were real 2-1 splits (both real REJECT-
  // majority AND, invisibly, any real APPROVE-majority) discarded as "no confident
  // majority" purely because one of three votes dissented, not because the verdict was
  // actually unclear.
  const voteResult = await resolvedMajorityVote({
    prompt: verdictPrompt,
    classify: classifyVote(['APPROVE', 'REJECT'], 20),
    n: 3,
    minAgreeing: 2,
    temperature: 0.2,
    source: task.source,
  });

  // 2026-08-24, Grimmethy: "are there any efficiency buffs you can think of" -- voteErrors
  // (added alongside majorityVote()'s own per-vote resilience fix, commit 0ac54b9) was
  // computed but never actually read anywhere -- real diagnostic signal (which votes
  // hard-failed, and why) silently discarded on every single review, exactly the kind of
  // "why did this take 3x longer than expected" trail that took hours of manual log
  // archaeology to reconstruct by hand earlier tonight. Surfaced into both voteSummary
  // (so it's visible in the task's own history without opening the raw field) and a new
  // task.voteErrors (so it's queryable structured data, same convention task.localVotes
  // already uses for the real vote responses).
  const voteErrorSuffix = voteResult.voteErrors && voteResult.voteErrors.length > 0
    ? `, ${voteResult.voteErrors.length} vote(s) hard-failed`
    : '';
  const voteSummary = `votes: ${voteResult.realVoteCount}/${voteResult.requestedVotes} real${voteErrorSuffix}`;

  if (!voteResult.confident || !voteResult.verdict) {
    const reason = `Local-model review inconclusive, no confident majority (${voteSummary})`;
    task.reviewProvider = 'local';
    task.localVotes = voteResult.votes;
    task.voteErrors = voteResult.voteErrors;
    recordModelOutcome({ callId: task.abCallId, outcome: 'rejected', outcomeStage: 'review', outcomeReason: reason });
    appendHistoryEvent(task, 'blocked', reason);
    return { succeeded: true, verdict: 'blocked', blockedReason: reason, blockedStage: 'review', factCheckVerdict };
  }

  if (voteResult.verdict === 'APPROVE') {
    const sampleVote = voteResult.votes.find((v) => v.verdict === 'APPROVE');
    task.reviewedAt = new Date().toISOString();
    task.reviewProvider = 'local';
    task.localVerdict = `Confident majority APPROVE (${voteSummary})\n\n${sampleVote ? sampleVote.response : ''}`;
    task.localVotes = voteResult.votes;
    task.voteErrors = voteResult.voteErrors;
    recordModelOutcome({ callId: task.abCallId, outcome: 'approved', outcomeStage: 'review', outcomeReason: null });
    appendHistoryEvent(task, 'approved', voteSummary);
    return { succeeded: true, verdict: 'approved', factCheckVerdict };
  }

  const sampleVote = voteResult.votes.find((v) => v.verdict === 'REJECT');
  const match = sampleVote && sampleVote.response.match(/REJECT:\s*(.+)/);
  const reason = match ? match[1] : `REJECT (${voteSummary})`;
  task.reviewProvider = 'local';
  task.localVotes = voteResult.votes;
  task.voteErrors = voteResult.voteErrors;
  recordModelOutcome({ callId: task.abCallId, outcome: 'rejected', outcomeStage: 'review', outcomeReason: reason });
  appendHistoryEvent(task, 'blocked', reason);
  return { succeeded: true, verdict: 'blocked', blockedReason: reason, blockedStage: 'review', factCheckVerdict };
}

// Thin wrapper over runReview: keeps task.status in step with the verdict (and so with the
// queue directory review-runner.sh moves the file to next -- approved/ or blocked/). Only
// local-draft.js was ever maintaining task.status ('needs-review'), so every approved task
// kept that stale value and the dashboard list view -- which reads task.status straight
// through task_summary() -- showed the whole approved/ backlog as "needs-review". The
// verdict strings ('approved' / 'blocked') are already exactly the status values we want.
async function reviewTask(task, opts = {}) {
  const result = await runReview(task, opts);
  if (result && result.succeeded && (result.verdict === 'approved' || result.verdict === 'blocked')) {
    task.status = result.verdict;
  }
  return result;
}

async function main() {
  const taskPath = process.argv[2];
  if (!taskPath) {
    process.stdout.write(JSON.stringify({ succeeded: false, reason: 'usage: node review-task.js <review.json>' }));
    return;
  }

  let task;
  try {
    task = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
  } catch (e) {
    process.stdout.write(JSON.stringify({ succeeded: false, reason: `Could not read/parse task JSON: ${e.message}` }));
    return;
  }

  // Flush every review checkpoint (review-started, per-vote, verdict) to disk as it's
  // recorded, so the dashboard shows review progressing instead of a frozen file until
  // the whole vote completes -- and so a reviewer killed mid-vote leaves a trace. The
  // authoritative writeTaskJson below still runs on completion; these are additive.
  setHistoryPersistHook(() => {
    try { writeTaskJson(taskPath, task); } catch (_) { /* best-effort */ }
  });

  const { repoRoot, pipelineDir, secondBrainDir, domainsPath, deepDiveCoveragePath } = getConfig();
  const instancesDir = path.join(pipelineDir, 'instances');

  let result;
  try {
    result = await reviewTask(task, { repoRoot, pipelineDir, secondBrainDir, domainsPath, instancesDir, deepDiveCoveragePath });
  } catch (e) {
    process.stdout.write(JSON.stringify({ succeeded: false, reason: e.message }));
    return;
  }

  if (result.succeeded) {
    if (result.verdict === 'blocked') {
      task.blockedReason = result.blockedReason;
      if (result.blockedStage) task.blockedStage = result.blockedStage;
    }
    writeTaskJson(taskPath, task);
  }
  process.stdout.write(JSON.stringify(result));
}

module.exports = { reviewTask, buildVerdictPrompt, NON_IMPL_PATTERNS };

if (require.main === module) {
  main();
}
