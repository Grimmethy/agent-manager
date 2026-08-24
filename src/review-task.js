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
const { getConfig } = require('./config.js');
const { checkDraft } = require('./fact-checker.js');
const { providerFor, resolveModelProfile } = require('./model-provider.js');
const { recordOutcome: defaultRecordModelOutcome } = require('./model-stats-client.js');
const { parseJsonMaybeFenced } = require('./json-fence.js');
const { appendHistoryEvent } = require('./task-history.js');
const { getRegisteredSource } = require('./task-source-registry.js');

function writeTaskJson(taskPath, task) {
  fs.writeFileSync(taskPath, JSON.stringify(task, null, 2));
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
  lines.push('The fact-check above is deterministic and authoritative for file existence -- it already checked the real filesystem. A claimed path listed with "exists": true is CONFIRMED real; do not express doubt about it or re-litigate whether it exists. A path listed with "exists": false AND "isCreateTarget": true is this draft\'s own mode:"create" target -- it not existing yet is the normal, EXPECTED case for a create (that is the entire point of creating it), and is NOT evidence of fabrication; do not reject a draft for this. Only "exists": false WITHOUT isCreateTarget is evidence toward fabrication.');
  lines.push('A "fabricated-commit-reference" flag means the draft cited a specific commit hash (e.g. "already resolved in commit abc1234") that this pipeline confirmed via real `git cat-file` does NOT exist anywhere in this repo\'s history -- this is deterministic and authoritative the same way a missing-file flag is: strong, concrete evidence the draft invented a resolution instead of doing (or honestly reporting it could not do) the real work asked for. commitChecks with "exists": null means the hash could not be checked (no git access) -- treat that as unconfirmed, not as fabrication.');
  lines.push('');
  lines.push('Judge whether this draft is correct, narrowly scoped, and safe to apply as-is. Reject if it is fabricated, over-broad, or the fact-check flags a real problem.');
  lines.push('Also REJECT if the draft consists mainly of meta-commentary, hedging, or a refusal ("I cannot verify this...", "I do not have enough information...", "this cannot be confirmed...") standing in for the real content the task asked for. A draft expressing uncertainty about its OWN claim is itself a reason to reject, not something to average into "seems fine." IMPORTANT EXCEPTION: this rule is about hedging PROSE, not about a genuinely EMPTY response (zero characters, or effectively so) -- several task types below are explicitly instructed to output nothing when there is nothing real to report, and that is NOT the same failure as writing evasive text instead of answering. If the draft is truly empty, judge it ONLY by the source-specific rule below (if any); do not reject an empty draft under this rule merely for containing no implementation.');
  // 2026-08-24: stated ONCE, unconditionally, for every adhoc (source==='manual') task
  // regardless of which resolution branch fires below -- NOT duplicated inside each
  // individual carve-out the way it used to be. Caught live: the decompose carve-out
  // originally had its own copy of this exact instruction, added only after a real
  // decomposition got wrongly rejected over a broken snippet in the (unrelated, blind)
  // PLAN section; the plain manual/diff carve-out already had its own independent copy.
  // Two copies of the same guarantee, easy to keep in sync by accident today -- but the
  // NEXT new adhoc resolution type (or any future source-specific carve-out that forgets
  // to repeat it) would silently reintroduce the identical bug, since nothing actually
  // GUARANTEES this protection exists beyond each carve-out author remembering to restate
  // it. Hoisted here so it structurally can't be missed again, and removed from both
  // carve-outs below (each keeps only its own resolution-specific judging criteria).
  if (task.source === 'manual') {
    lines.push('The PLAN section above was drafted BLIND, by an earlier and separate pass, before any real investigation happened -- true for EVERY adhoc task here, regardless of how it ultimately resolved (implemented, decomposed, or otherwise). It is exploratory scratch work, not the deliverable, and may itself be rough, incomplete, wrong, or even contain broken/truncated example code. NEVER reject over a problem in the PLAN itself (a syntax error in an illustrative snippet there, a design the real work ends up doing differently, a file or approach it guessed at that turned out wrong) -- judge ONLY the actual IMPLEMENT draft below, produced after real investigation.');
  }
  if (task.source === 'arch_discovery') {
    lines.push('This is an architecture-discovery task: finding ZERO real issues in the given files is a valid, EXPECTED, and often correct outcome -- do not reject a draft merely for concluding there is nothing worth flagging. Only reject an empty result if the draft itself looks like it never actually engaged with the given file content (e.g. generic boilerplate with no reference to anything specific in the files).');
  } else if (task.source === 'project_search') {
    lines.push('This is a project-search task: the drafter was told it is correct to report zero findings when none of the real, harness-fetched GitHub/HuggingFace search results were genuinely useful -- do not reject a draft merely for reporting no findings. Only reject an empty result if the draft invents a project/URL not present in the actual search results given to it, or if the search results plainly did contain something usable that the draft ignored.');
  } else if (task.source === 'deep_dive') {
    lines.push('This is a deep-dive task: reject an item only if it references a file, function, or behavior NOT present in the given community file content above, or if its Rating/Rationale plainly contradicts what the given files actually show. Do NOT reject an item merely because it is rated Ignore -- an honest "considered and does not apply, here is why" is exactly as valid an outcome as a Use or Adapt rating, same as an architecture-discovery task finding zero real issues.');
  } else if (task.source === 'arch_import') {
    lines.push("This is an architecture-import task (an idea from an external project, being checked against agent-manager's own code): the drafter was told to output nothing if the harness search found no real agent-manager files this idea concretely applies to -- do not reject an empty result on that basis alone. Reject only if the draft names a file the harness search results do NOT show, or proposes something contradicted by the real file content given.");
  } else if (task.source === 'brain_dump_sort') {
    lines.push('This is a brain-dump CLASSIFICATION task, not a code-change task: the implement draft is a JSON metadata object (category/secondBrainPath/tags/actionable/rationale/belongsToProject) that files a note into a personal vault -- do not reject it for lacking implementation code or for being "just documentation," that was never the ask. secondBrainPath names the note file to create or append to; it commonly does NOT exist yet -- filing something brand new is the normal, most common, correct outcome, so a "missing-file" fact-check flag on secondBrainPath ALONE is expected and is NOT evidence of fabrication (unlike a missing-file flag on a claimed source-code reference elsewhere, which would be). Reject only if: the JSON itself is malformed or missing a required field, category is not one of task/reference/idea/journal/question, secondBrainPath is an obviously wrong or nonsensical destination given what the note is actually about, or belongsToProject names a project that plainly was not among the tracked projects listed in the PLAN above.');
  } else if (task.source === 'manual' && task.adhocResolution === 'decompose') {
    // 2026-08-24: RESOLUTION: decompose is a legitimate third outcome (adhoc-agentic-
    // draft.js), not a cop-out -- the drafter investigated for real, judged the task too
    // large for one confident pass, and produced a JSON list of smaller sub-tasks instead
    // of a diff. Without this carve-out the generic "does it contain real, complete code"
    // completeness question and the manual-source carve-out just below it (which assumes
    // every adhoc draft either has a diff or is wrong) would reject every correct
    // decomposition on sight for containing no code -- the exact false-reject failure mode
    // that motivated writing this carve-out in the first place. The "PLAN was drafted
    // blind, don't judge it" instruction lives in the unconditional source==='manual'
    // block above now, not repeated here -- see its own comment for why.
    lines.push('This is an adhoc task the drafter chose to DECOMPOSE rather than implement directly: it judged the task too large/broad to implement confidently in one pass and produced a JSON array of smaller sub-tasks instead of a diff -- there is deliberately no code or diff here, and that is NOT a reason to reject. Judge ONLY the actual DECOMPOSITION in the IMPLEMENT draft below. Is it sound: do the sub-tasks, together, actually cover everything the original TASK asked for (no silently dropped requirement)? Is each sub-task concrete and independently implementable on its own (not still vague, not itself obviously too large)? Is the JSON well-formed with a real title and a self-contained rawText for each entry? Reject if a requirement was dropped, a sub-task is too vague/large to actually help, or the JSON itself is malformed -- never because of something in the PLAN, and never merely because no code was written.');
  } else if (task.source === 'manual') {
    lines.push("This is an adhoc task: the IMPLEMENT draft comes from a real agentic pass that ran Read/Grep/Glob/Bash against the actual repo and produced the real `git diff` shown (see the DIFF section of the implement draft). Grounded investigation is frequently more accurate than the blind plan that preceded it -- do NOT reject the implement draft merely because it touches different files, a different number of files, or a narrower/broader scope than the plan named; that is the expected, normal outcome of the plan being wrong about something the real investigation then corrected, not a sign of an over-broad or off-task draft. Judge the diff against the TASK's actual request and the real repo state (fact-check/grounding above), not against the plan's stated scope. Reject only if the diff itself is wrong given the real repo state, contradicts the task's actual ask, or the draft's own RESOLUTION/summary text is inconsistent with what the diff actually does.");
  } else if (task.source === 'staleness_audit') {
    // Fix, 2026-08-22 (Grimmethy: caught this live -- a real staleness_audit report got
    // rejected as "meta-commentary and hedging... rather than providing the requested
    // implementation") -- staleness_audit's implement draft is DELIBERATELY an advisory
    // prose report, never code (see stalenessAuditImplementPrompt, prompts.js: "Write a
    // short advisory report... not a diff"). This is the ONE source whose entire
    // contract is the exact language pattern the generic instruction above tells a
    // reviewer to reject on sight ("here's what I found, you decide," hedged language
    // about what's confirmed vs. unconfirmed) -- without this carve-out, EVERY correctly-
    // written staleness_audit report is structurally guaranteed to be rejected by the
    // generic hedging rule, regardless of how accurate its analysis actually is.
    lines.push('This is a staleness-audit task: the implement draft is DELIBERATELY an advisory prose report, not code or a diff -- there is nothing to implement here, the whole point is a grounded opinion on whether an old flagged task is still worth chasing. Hedged, uncertain language ("inconclusive," "cannot confirm," "needs further investigation") is the EXPECTED and CORRECT way to report a genuinely inconclusive finding -- do NOT reject it under the generic hedging rule above; that rule exists for tasks asking for real content the model is dodging, not for a task whose deliverable IS a calibrated judgment call. IMPORTANT: a RECOMMENDATION: archive verdict now has a REAL, AUTOMATIC effect once you approve this report -- it moves the original flagged task out of the queue for good, with no further human check. If it recommends "archive," verify that call is actually earned by the real evidence shown above (the harness search genuinely supports the concern being resolved/ungrounded), not just asserted -- reject an under-supported "archive" the same as you would a fabricated code change. "worth a fresh investigation" carries no such risk (it takes no action at all), so hold it to the normal calibrated-judgment bar only. Reject only if: it lacks an explicit RECOMMENDATION line, it contradicts the real harness search results shown above (claims a match was found when harnessHits is empty, or vice versa), it fabricates a claim about the original flagged task not present in the evidence text it was given, or it recommends "archive" without the real evidence above actually supporting that conclusion.');
  }
  const completenessQuestion = task.source === 'brain_dump_sort'
    // Deliberately NOT "does it contain real, complete code" -- confirmed live
    // 2026-08-16: that phrasing, left unconditional, directly contradicted the
    // brain_dump_sort carve-out above (a reviewer told two conflicting things in the
    // same prompt, one of which it's more likely to weight since it comes last) and
    // was one of two compounding causes behind every brain_dump_sort draft getting
    // rejected regardless of how correct the classification actually was.
    ? 'Does it contain a complete, valid classification JSON (not a bare tool-call request, not meta-commentary, not a truncated/partial JSON fragment)?'
    : task.source === 'staleness_audit'
      // Same reasoning as the brain_dump_sort carve-out just above -- "real, complete
      // code" directly contradicts this source's own advisory-prose carve-out.
      ? 'Does it contain a genuine three-part analysis (does the concern still hold, was the original fabrication finding genuine, and an explicit RECOMMENDATION), grounded in the real harness search results shown above rather than invented?'
      : task.source === 'manual' && task.adhocResolution === 'decompose'
        // Same reasoning again -- "real, complete code" directly contradicts the
        // decompose carve-out above, whose whole point is that no code was written.
        ? 'Does it contain a well-formed JSON array of sub-tasks, each with a real title and a self-contained rawText, that together cover the original task with nothing dropped?'
        : 'Does it contain real, complete code (not a bare tool-call request, not meta-commentary like "let me read the file first", not a partial fragment)?';
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
 * The actual review logic, independent of the CLI/stdout wrapper below -- exported so
 * tests can call it directly with a fake localMajorityVote.
 */
async function reviewTask(task, { repoRoot, pipelineDir, secondBrainDir, domainsPath, instancesDir, deepDiveCoveragePath, localMajorityVote = null, recordModelOutcome = defaultRecordModelOutcome } = {}) {
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
  const baseMajorityVote = localMajorityVote || providerFor(task).majorityVote;
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
    groundingText = '';
  } finally {
    try { fs.unlinkSync(taskPathForGrounding); } catch (e) { /* best-effort cleanup */ }
  }

  const factCheck = checkDraft(task.implementResponse || '', repoRootForCheck, groundingText || undefined);
  const factCheckVerdict = factCheck.flags && factCheck.flags.length > 0 ? 'flagged' : 'pass';

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
  const highPrecisionFlags = (factCheck.flags || []).filter((f) => f.type === 'ungrounded-url' || f.type === 'ungrounded-field');
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
