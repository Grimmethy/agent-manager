'use strict';

// Grounding and the fact-check, the first stage runReview runs after the early gates (roadmap step 1, piece P6.3b): resolve the domain config and work dir,
// the repo root the fact-check runs against, the grounding source text, the extra roots and the stacked grounding ref; run the pre-validation gate for sources
// that register it; then run the fact-checker. prepareFactCheck returns { early } (a blocked review result) or the values the rest of runReview needs.
// Moved out of review-task.js with the helpers only they use; review-task.js imports and re-exports getDomainConfig and logFactCheckAudit.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { getConfig } = require('./config.js');
const { checkDraft, preValidateCitedPaths } = require('./fact-checker.js');
const { resolveGroundingRef } = require('./stacked-grounding.js');
const { getRegisteredSource, resolveSourceName } = require('./task-source-registry.js');
const { appendHistoryEvent } = require('./task-history.js');
const { logPipelineEvent } = require('./pipeline-history.js');

function getDomainConfig(domainsPath, domain) {
  const domains = JSON.parse(fs.readFileSync(domainsPath, 'utf8'));
  const cfg = domains[domain];
  if (!cfg) {
    // Self-heal: if the domain is a standard one (derived from task-source-registry.js),
    // add it to the pipeline's task-domains.json and continue. This prevents tasks from
    // being permanently blocked due to a missing key.
    const { isStandardDomain, getDomainShape } = require('./task-domains-registry.js');
    if (isStandardDomain(domain)) {
      const shape = getDomainShape(domain);
      domains[domain] = shape;
      // Atomic write: write to tmp, then rename.
      const tmp = `${domainsPath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(domains, null, 2) + '\n');
      fs.renameSync(tmp, domainsPath);
      // Log the self-heal action.
      try {
        const { logPipelineEvent } = require('./pipeline-history.js');
        logPipelineEvent(path.dirname(domainsPath), 'task-domain-self-heal', {
          domain,
          shape,
          at: new Date().toISOString(),
        });
      } catch { /* pipeline-history may not be available in all contexts */ }
      return shape;
    }
    // Genuinely unknown domain: block with a clear message naming the file to edit.
    throw new Error(`Unknown task domain: ${domain} (valid: ${Object.keys(domains).join(', ')}) in ${domainsPath} -- add "${domain}" to ${domainsPath} or run scripts/ensure-task-domains.sh <that pipeline dir>`);
  }
  return cfg;
}

function getWorkDir(cfg, { repoRoot, secondBrainDir }) {
  if (cfg.workDirKind === 'repoRoot' || cfg.workDirKind === 'taxharvestRoot') return repoRoot;
  if (cfg.workDirKind === 'secondBrainDir') return secondBrainDir;
  throw new Error(`Unknown workDirKind: ${cfg.workDirKind}`);
}

// 2026-09-08, Second Brain [[dspy-deterministic-prompt-tuning]] research applied: DSPy's
// optimizer family compiles a signature against a real, labeled corpus of outcomes rather
// than trusting a hand-tuned heuristic's own self-assessment. fact-checker.js's own header
// comment calls the ungrounded-url/ungrounded-field gate "high-precision, almost never a
// false positive" -- but this session's own investigation found 4 confirmed false
// positives against that exact claim (a newly-declared constant, a real field outside the
// diff's touched files, a field on an unchanged diff context line, a self-invented shell
// echo marker), discovered only by manually grepping every historical hard-block and
// hand-auditing each one -- there was no standing record of this gate's own real
// true/false-positive rate at all. One NDJSON line per hard block (not just the terminal
// verdict already in the task's own history) means a future audit is `grep`, not manual
// archaeology across queue/done/ -- same discipline local-client.js's degenerate-audit.log
// and local-tool-client.js's context-budget-audit.log already established for their own
// gates. Best-effort: must never affect the real review outcome.
// 2026-09-08: now a thin wrapper over pipeline-history.js's unified writer -- see that
// file's own header for why the 4 separately-invented per-class log files (this one
// included) were consolidated into one NDJSON stream discriminated by `type`, mirroring
// dspy.settings.GLOBAL_HISTORY. Same call signature as before; no call site changed.
function logFactCheckAudit(pipelineDir, entry) {
  logPipelineEvent(pipelineDir, 'fact-check-block', entry);
}

// The repo root the fact-check runs against: the work dir, or for deep_dive the cloned external project.
function resolveRepoRootForCheck({ task, workDir, deepDiveCoveragePath }) {
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
  }
  return repoRootForCheck;
}

// The grounding source text for the reviewers (get-grounding-source.js); '' when generation fails.
function buildGroundingText(task) {
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
  return groundingText;
}

// The extra roots handed to the fact-checker (the consumer's configured code dirs), only when checking agent-manager's own repo root.
function resolveExtraRoots({ repoRootForCheck, workDir }) {
  const factCheckExtraRoots = (repoRootForCheck === workDir)
    ? (() => { try { return getConfig().grepAllowedDirs; } catch { return []; } })()
    : [];
  return factCheckExtraRoots;
}

// The pre-validation gate: a blocked review result for a draft that fails it, else null.
function preValidationGate({ task, repoRootForCheck, factCheckExtraRoots, pipelineDir, recordModelOutcome }) {
  // Pre-fact-check gate for sources registering preValidateCitedPaths -- project_search / arch_import (2026-09-08 brain-dump request):
  // those two sources' drafts are plain prose citing specific files and line numbers as
  // evidence for a claim, not a Group B diff -- checkDraft's own fabricated-path handling
  // is tuned for a diff's claimed file targets, not "does this cited EVIDENCE actually
  // exist." Cheaper and runs first: a draft that fails this never reaches the rest of the
  // fact-checker or a review call at all. blockedReason is prefixed 'ungrounded draft:
  // fabricated file path' so blocked-task-classifiers.js's hasFabricatedFilePath treats
  // it as the same retryable:false category a real diff-side fabrication already is.
  const preValidateSource = resolveSourceName(task);
  const preValidateEntry = getRegisteredSource(preValidateSource);
  // `preValidateCitedPaths: true` on the source's registration (project_search in core, arch_import in the hygiene plugin).
  if (preValidateEntry && preValidateEntry.preValidateCitedPaths === true) {
    const preValidation = preValidateCitedPaths(task.implementResponse || '', repoRootForCheck, factCheckExtraRoots);
    if (!preValidation.valid) {
      const reason = `ungrounded draft: fabricated file path -- pre-validation: ${preValidation.failures.join('; ')}`;
      task.reviewProvider = 'deterministic-pre-validation';
      logFactCheckAudit(pipelineDir, {
        taskId: task.id, source: preValidateSource, reason,
        flags: preValidation.failures.map((f) => ({ type: 'pre-validation', detail: f })),
      });
      recordModelOutcome({ callId: task.abCallId, outcome: 'rejected', outcomeStage: 'review', outcomeReason: reason });
      appendHistoryEvent(task, 'blocked', reason);
      return { succeeded: true, verdict: 'blocked', blockedReason: reason, blockedStage: 'review', factCheckVerdict: 'skipped' };
    }
  }
  return null;
}

// ctx: { task, repoRoot, secondBrainDir, domainsPath, deepDiveCoveragePath, pipelineDir, recordModelOutcome }
// -> { early } or { factCheck, factCheckVerdict, repoRootForCheck, groundingText, factCheckExtraRoots, groundingRef }.
function prepareFactCheck({ task, repoRoot, secondBrainDir, domainsPath, deepDiveCoveragePath, pipelineDir, recordModelOutcome }) {
  const domainCfg = getDomainConfig(domainsPath, task.domain);
  const workDir = getWorkDir(domainCfg, { repoRoot, secondBrainDir });
  const repoRootForCheck = resolveRepoRootForCheck({ task, workDir, deepDiveCoveragePath });
  const groundingText = buildGroundingText(task);
  const factCheckExtraRoots = resolveExtraRoots({ repoRootForCheck, workDir });
  // 2026-09-08, root-caused live: a stacked task correctly citing a sibling's real,
  // committed-but-unmerged value was hard-blocked as "cites a value that appears nowhere
  // in its real grounding source" -- the grep ran against repoRootForCheck's plain working
  // tree, never the shared stacked branch. resolveGroundingRef is null for any non-stacked
  // task (the overwhelming majority) or when the deep_dive external-clone repoRootForCheck
  // swap already happened above, so this only diverges for the exact stacked case.
  const groundingRef = (repoRootForCheck === workDir) ? resolveGroundingRef(task, repoRootForCheck) : null;
  const early = preValidationGate({ task, repoRootForCheck, factCheckExtraRoots, pipelineDir, recordModelOutcome });
  if (early) return { early };
  const factCheck = checkDraft(task.implementResponse || '', repoRootForCheck, groundingText || undefined, factCheckExtraRoots, groundingRef);
  // `imprecise-file-path` is informational (a real file cited with a sloppy prefix) --
  // it must not by itself flip the verdict label to "flagged".
  const factCheckVerdict = (factCheck.flags || []).some((f) => f.type !== 'imprecise-file-path') ? 'flagged' : 'pass';
  return { factCheck, factCheckVerdict, repoRootForCheck, groundingText, factCheckExtraRoots, groundingRef };
}

module.exports = { getDomainConfig, getWorkDir, logFactCheckAudit, resolveRepoRootForCheck, buildGroundingText, resolveExtraRoots, preValidationGate, prepareFactCheck };
