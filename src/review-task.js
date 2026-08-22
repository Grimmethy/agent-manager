'use strict';

// Review step: takes one task sitting in queue/review/ (status "needs-review", written by
// ornith-draft.js) and decides approved vs. blocked. Port of review-runner.ps1's 'ornith'
// review-provider path ONLY -- the 'claude' path (a single `claude -p` call that reviews
// AND applies in one shot) is a different reviewProvider mode this deployment never uses
// (REVIEW_PROVIDER env var is unset here, and review-runner.ps1's own default is 'ornith'),
// so it's out of scope. Under the 'ornith' path Ornith has no tool access -- it produces a
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
// ornith-draft.js has had a real domain==='research' agentic-drafting branch since
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
// Same division of labor as ornith-draft.js/apply-task.js: this script mutates and
// rewrites the task JSON IN PLACE at the given path; the caller (review-runner.sh) owns
// moving the file to queue/approved/ or queue/blocked/.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { getConfig } = require('./config.js');
const { checkDraft } = require('./fact-checker.js');
const { providerFor } = require('./model-provider.js');
const { recordOutcome: defaultRecordModelOutcome } = require('./model-stats-client.js');
const { parseJsonMaybeFenced } = require('./json-fence.js');
const { appendHistoryEvent } = require('./task-history.js');

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

// Ornith review and worker draft calls share one local GPU/model slot -- stagger review's
// start if a worker looks actively mid-call, same contention-avoidance ornith-worker.ps1's
// Wait-ForOrnithAvailability does. Best-effort: never blocks more than ~15s total.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForOrnithAvailability(instancesDir, maxWaitAttempts = 3, waitSeconds = 5) {
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

// Deterministic empty-approve: several sources' implement prompts explicitly instruct
// "output the empty string if there's nothing real to report" -- an honest empty result is
// a valid, documented outcome for these, not a failure. Same isEffectivelyEmpty check as
// apply-group-a.js's own definition.
// arch_review/arch_import_review/observability_fix/performance_fix/backlog_fulfillment
// (2026-08-21): joined this list alongside ornith-draft.js's own allowEmptyImplement update
// -- see task-sources.js's nextCandidateFulfillmentTask header for the grounding fix this
// is part of.
const EMPTY_APPROVAL_SOURCES = [
  'arch_discovery', 'project_search', 'deep_dive', 'arch_import', 'pipeline_self_audit',
  'arch_review', 'arch_import_review', 'observability_fix', 'performance_fix', 'backlog_fulfillment',
];
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
  lines.push('--- Deterministic fact-check pre-filter (necessary, NOT sufficient) ---');
  lines.push(JSON.stringify(factCheck));
  lines.push('');
  if (groundingText) {
    lines.push('--- Real grounding source (the material the drafter was actually given -- use this to verify SPECIFIC claims, not just the fact-check above) ---');
    lines.push(groundingText.length > 40000 ? `${groundingText.slice(0, 40000)}\n...[truncated]` : groundingText);
    lines.push('');
  }
  lines.push('The fact-check above is deterministic and authoritative for file existence -- it already checked the real filesystem. A claimed path listed with "exists": true is CONFIRMED real; do not express doubt about it or re-litigate whether it exists. A path listed with "exists": false AND "isCreateTarget": true is this draft\'s own mode:"create" target -- it not existing yet is the normal, EXPECTED case for a create (that is the entire point of creating it), and is NOT evidence of fabrication; do not reject a draft for this. Only "exists": false WITHOUT isCreateTarget is evidence toward fabrication.');
  lines.push('');
  lines.push('Judge whether this draft is correct, narrowly scoped, and safe to apply as-is. Reject if it is fabricated, over-broad, or the fact-check flags a real problem.');
  lines.push('Also REJECT if the draft consists mainly of meta-commentary, hedging, or a refusal ("I cannot verify this...", "I do not have enough information...", "this cannot be confirmed...") standing in for the real content the task asked for. A draft expressing uncertainty about its OWN claim is itself a reason to reject, not something to average into "seems fine." IMPORTANT EXCEPTION: this rule is about hedging PROSE, not about a genuinely EMPTY response (zero characters, or effectively so) -- several task types below are explicitly instructed to output nothing when there is nothing real to report, and that is NOT the same failure as writing evasive text instead of answering. If the draft is truly empty, judge it ONLY by the source-specific rule below (if any); do not reject an empty draft under this rule merely for containing no implementation.');
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
  }
  const completenessQuestion = task.source === 'brain_dump_sort'
    // Deliberately NOT "does it contain real, complete code" -- confirmed live
    // 2026-08-16: that phrasing, left unconditional, directly contradicted the
    // brain_dump_sort carve-out above (a reviewer told two conflicting things in the
    // same prompt, one of which it's more likely to weight since it comes last) and
    // was one of two compounding causes behind every brain_dump_sort draft getting
    // rejected regardless of how correct the classification actually was.
    ? 'Does it contain a complete, valid classification JSON (not a bare tool-call request, not meta-commentary, not a truncated/partial JSON fragment)?'
    : 'Does it contain real, complete code (not a bare tool-call request, not meta-commentary like "let me read the file first", not a partial fragment)?';
  lines.push(`Before answering, check the draft against the TASK above point by point: does it touch every file/requirement the task named? ${completenessQuestion} Does anything in it contradict the real grounding source or fact-check above?`);
  lines.push('Respond with EXACTLY one of these two forms, nothing else. BOTH require a concrete, specific reason -- cite an actual file name, field name, or line of the draft. A reason that just restates the verdict word ("looks correct", "seems fine", "meets requirements") is not acceptable and will be discarded as unreasoned.');
  lines.push('APPROVE: <one-sentence reason citing the specific requirement(s) you verified are met>');
  lines.push('REJECT: <one-sentence reason citing the specific problem>');
  return lines.join('\n');
}

// Same classify function as ornith-client.js's own CLI (mode: 'majority-vote') --
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
 * tests can call it directly with a fake ornithMajorityVote.
 */
async function reviewTask(task, { repoRoot, pipelineDir, secondBrainDir, domainsPath, instancesDir, deepDiveCoveragePath, ornithMajorityVote = null, recordModelOutcome = defaultRecordModelOutcome } = {}) {
  // Resolved here rather than as a static default param, same reasoning as
  // ornith-draft.js's draftTask() -- the right backend depends on the task's reasoning
  // tier, only known once the task object is in hand. Passing the whole task (not just
  // task.source) lets a per-instance task.reasoningTier override take effect. An explicit
  // caller override always wins.
  const resolvedMajorityVote = ornithMajorityVote || providerFor(task).majorityVote;
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

  const trimmedImplResponse = (task.implementResponse || '').trim();
  const effectivelyEmpty = isEffectivelyEmpty(trimmedImplResponse);

  if (EMPTY_APPROVAL_SOURCES.includes(task.source) && effectivelyEmpty) {
    task.reviewedAt = new Date().toISOString();
    task.reviewProvider = 'deterministic-empty-approve';
    task.ornithVerdict = `Auto-approved: implementResponse is genuinely empty, a documented valid outcome for ${task.source} (no Ornith vote spent -- this is deterministic, not a judgment call)`;
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
  if (isNonImplementation && !EMPTY_APPROVAL_SOURCES.includes(task.source)) {
    const reason = 'Deterministic gate: implementResponse is a bare tool-call request or meta-commentary, not a real implementation attempt -- no Ornith review call spent (mechanically detectable, not a judgment call).';
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
      const reason = `Deterministic gate: draft does not contain the required fixed block(s) character-for-character: ${missingNames}. These were given verbatim in the task and must be copied exactly, not rewritten from memory -- no Ornith review call spent on a draft that already fails a mechanical check.`;
      task.reviewProvider = 'deterministic-fixed-literals';
      recordModelOutcome({ callId: task.abCallId, outcome: 'rejected', outcomeStage: 'review', outcomeReason: reason });
      appendHistoryEvent(task, 'blocked', reason);
      return { succeeded: true, verdict: 'blocked', blockedReason: reason, blockedStage: 'review', factCheckVerdict };
    }
  }

  await waitForOrnithAvailability(instancesDir);

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

  const voteSummary = `votes: ${voteResult.realVoteCount}/${voteResult.requestedVotes} real`;

  if (!voteResult.confident || !voteResult.verdict) {
    const reason = `Ornith review inconclusive, no confident majority (${voteSummary})`;
    task.reviewProvider = 'ornith';
    task.ornithVotes = voteResult.votes;
    recordModelOutcome({ callId: task.abCallId, outcome: 'rejected', outcomeStage: 'review', outcomeReason: reason });
    appendHistoryEvent(task, 'blocked', reason);
    return { succeeded: true, verdict: 'blocked', blockedReason: reason, blockedStage: 'review', factCheckVerdict };
  }

  if (voteResult.verdict === 'APPROVE') {
    const sampleVote = voteResult.votes.find((v) => v.verdict === 'APPROVE');
    task.reviewedAt = new Date().toISOString();
    task.reviewProvider = 'ornith';
    task.ornithVerdict = `Confident majority APPROVE (${voteSummary})\n\n${sampleVote ? sampleVote.response : ''}`;
    task.ornithVotes = voteResult.votes;
    recordModelOutcome({ callId: task.abCallId, outcome: 'approved', outcomeStage: 'review', outcomeReason: null });
    appendHistoryEvent(task, 'approved', voteSummary);
    return { succeeded: true, verdict: 'approved', factCheckVerdict };
  }

  const sampleVote = voteResult.votes.find((v) => v.verdict === 'REJECT');
  const match = sampleVote && sampleVote.response.match(/REJECT:\s*(.+)/);
  const reason = match ? match[1] : `REJECT (${voteSummary})`;
  task.reviewProvider = 'ornith';
  task.ornithVotes = voteResult.votes;
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

module.exports = { reviewTask, buildVerdictPrompt };

if (require.main === module) {
  main();
}
