'use strict';

// candidate-lifecycle.js -- extracted from src/sdk/candidate-fulfillment.js ([[hub-task-integration]] node-module decompose).

const fs = require('fs');
const path = require('path');
const { getConfig } = require('../../config.js');
const { computePremiseEvidence } = require('../../candidate-premise-check.js');
const { signatureForClarificationTask } = require('../../pipeline-forensics.js');
const { appendHistoryEvent } = require('../../task-history.js');
const { readIfExists, quotedSymbolsFromSection, snippetFromSection } = require('./candidate-doc-parsing.js');
const { collectAnchorHits, windowFetchedFileContent } = require('./file-grounding.js');

const MAX_ARCH_REVIEW_TASK_CHARS = 4000;

const SIGNATURE_RE = /\b([a-z][a-z0-9_]*)::([a-z][a-z0-9-]*)\b/g;

function extractCandidateSignatures(section) {
  const found = new Set();
  let m;
  SIGNATURE_RE.lastIndex = 0;
  while ((m = SIGNATURE_RE.exec(section))) found.add(`${m[1]}::${m[2]}`);
  return [...found];
}

function liveSignatureCount(pipelineDir, signature) {
  const dir = path.join(pipelineDir, 'queue', 'needs-clarification');
  let names;
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return null; }
  let count = 0;
  for (const name of names) {
    try {
      const task = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (signatureForClarificationTask(task) === signature) count += 1;
    } catch { /* unparseable -- not this check's problem */ }
  }
  return count;
}

function staleSignatureReason(pipelineDir, section) {
  const signatures = extractCandidateSignatures(section);
  if (!signatures.length) return null;
  const zeroed = [];
  for (const sig of signatures) {
    const count = liveSignatureCount(pipelineDir, sig);
    if (count === 0) zeroed.push(sig);
    else if (count === null) return null; // can't determine -- don't guess
  }
  if (zeroed.length !== signatures.length) return null; // at least one signature still live
  return `every signature this candidate names (${zeroed.join(', ')}) has ZERO live queue/needs-clarification/ members -- the cluster that motivated it no longer exists`;
}

function archiveStaleCandidate({ pipelineDir, taskId, domain, sourceName, titleText, candidateId, section, reason }) {
  const record = {
    id: taskId,
    domain,
    source: sourceName,
    title: `${candidateId} · ${titleText}`,
    promptContext: { candidateId, title: titleText, body: section },
    history: [],
  };
  appendHistoryEvent(record, 'created', sourceName);
  appendHistoryEvent(record, 'archived', `pre-draft premise recheck: ${reason}`);
  const dir = path.join(pipelineDir, 'queue', 'done', '_archived_no_action');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${taskId}.json`), JSON.stringify(record, null, 2));
}

function nextCandidateFulfillmentTask(candidatesPath, sourceName) {
  // lazy (see module header) -- task-sources.js is fully loaded by the time any
  // next() poll calls this.
  const { taskIdExistsInQueue, isDependencySatisfied } = require('../../task-sources.js');
  const { defaultDomain, pipelineDir } = getConfig();
  const text = readIfExists(candidatesPath);
  if (!text) return null;

  const sections = [];
  let pos = 0;
  while (pos < text.length) {
    const start = text.indexOf('### ', pos);
    if (start === -1) break;

    const nextH2 = text.indexOf('\n## ', start + 3);
    const nextH3 = text.indexOf('\n### ', start + 3);
    let end;
    if (nextH2 !== -1 && nextH3 !== -1) {
      end = Math.min(nextH2, nextH3);
    } else if (nextH2 !== -1) {
      end = nextH2;
    } else if (nextH3 !== -1) {
      end = nextH3;
    } else {
      end = -1;
    }

    const sectionText = end === -1 ? text.slice(start) : text.slice(start, end);
    sections.push(sectionText);
    pos = end === -1 ? text.length : end + 1;
  }

  for (const section of sections) {
    const headingLine = section.split('\n')[0];

    const idMatch = headingLine.match(/AC-\d+/);
    if (!idMatch) continue;
    const candidateId = idMatch[0];

    // Depends-On: AC-NNN (2026-09-05, see prompts.js's candidateSplitInstructions for the
    // incident: two sibling split candidates, one structurally depending on the other,
    // both offered for drafting the same tick because nothing tracked the relationship).
    // Reuses nextAdhocTask's own isDependencySatisfied -- "satisfied" means MERGED, not
    // just done, same reasoning: a candidateFulfillment source without directToMain still
    // drafts from a fresh worktree off origin/<mainBranch>, so a dependency only reached
    // done/ (branch pushed, not yet merged) is not actually visible to this draft yet.
    // Skips PAST this candidate (does not block the whole lane) so a later, independent
    // one still gets picked up this same call.
    const dependsOnMatch = section.match(/^Depends-On:\s*(AC-\d+)\s*$/m);
    if (dependsOnMatch) {
      const depTaskId = `${sourceName.replace(/_/g, '-')}-${dependsOnMatch[1].toLowerCase()}`;
      if (!isDependencySatisfied(pipelineDir, depTaskId)) continue;
    }

    const strengthMatch = section.match(/^Strength:\s*(.+)$/m);
    if (!strengthMatch || strengthMatch[1].trim() !== 'Strong') continue;

    if (section.length > MAX_ARCH_REVIEW_TASK_CHARS) continue;

    // 2026-08-24 -- caught live: a real task (arch-review-ac-10, "AC-10 · Example
    // candidate", Files: foo.js) sat permanently un-completable for weeks, repeatedly
    // bulk-requeued on the assumption it was a "crash-bug casualty" rather than ever
    // having its own content re-examined -- its Problem/Solution sections were literally
    // "Problem: ...\nSolution: ..." (an unfilled template placeholder), not a real
    // finding. Traced to a real, if narrow, gap: this function has always trusted ANY
    // "Strength: Strong" section as actionable with no check that its content is real.
    // Deliberately NOT rejecting on "no referenced files exist" (see fetchedFiles'
    // own comment below -- a candidate proposing a genuinely NEW file is a valid,
    // intended shape, not a stale one) -- an ellipsis-only Problem/Solution body is a
    // much more specific, unambiguous signal: no real LLM-drafted finding ever produces
    // literally just "..." as its entire problem or solution description, regardless of
    // whether the files it names exist yet.
    const problemMatch = section.match(/^Problem:\s*\n?([\s\S]*?)(?=\n(?:Solution|Benefits):|$)/m);
    const solutionMatch = section.match(/^Solution:\s*\n?([\s\S]*?)(?=\nBenefits:|$)/m);
    const isPlaceholderBody = (m) => !m || m[1].trim() === '' || /^\.{3,}$/.test(m[1].trim());
    if (isPlaceholderBody(problemMatch) || isPlaceholderBody(solutionMatch)) continue;

    const taskId = sourceName.replace(/_/g, '-') + '-' + candidateId.toLowerCase();
    if (taskIdExistsInQueue(taskId)) continue;

    const titleMatch = headingLine.match(/AC-\d+\s*·\s*(.+)/);
    const titleText = (titleMatch ? titleMatch[1] : headingLine.replace(/^###\s*/, '')).trim();

    let filesArray = [];
    const filesMatch = section.match(/^Files:\s*(.+)$/m);
    if (filesMatch) {
      filesArray = filesMatch[1].split(',').map((f) => f.trim());
    }

    // 2026-09-02: the `Files:` line is frequently incomplete -- a candidate whose Solution
    // says "call `buildPlanPrompt` with a second arg" needs prompts.js in view to see that
    // function's real signature, but only lists local-draft.js (pipeline-forensics-fix-ac-7
    // /-ac-14). Also read any repo-relative source path the Problem/Solution prose names
    // into fetchedFiles (NOT into `files` -- those stay the candidate's declared edit
    // targets, which the review/decompose gates count against), so the drafter can ground
    // a cross-file change instead of editing blind or refusing.
    const contextFiles = [...new Set(
      [...section.matchAll(/(?<![\w/.-])((?:src|python|scripts|lib)\/[\w./-]+\.(?:js|ts|py|mjs|cjs))\b/g)].map((m) => m[1]),
    )].filter((p) => !filesArray.includes(p)).slice(0, 3);

    // Grounding fix (2026-08-21, confirmed live: observability-fix-ac-5 fabricated a
    // plausible-but-wrong `find` string -- "catch { return []; }" -- that matched nothing
    // in the real file, because this candidate's own implement pass was never shown real
    // file content, only its own prose write-up from whenever the candidate was originally
    // drafted, possibly hours or days earlier by a different pass entirely. Every OTHER
    // fulfillment-style source (arch_import, pipeline_self_audit) grounds its implement
    // pass in real, freshly-read file content; this generic consumer -- shared by
    // arch_review, arch_import_review, observability_fix, performance_fix, and
    // backlog_fulfillment all at once -- never did. Unlike arch_import's own harness
    // grounding (which has to SEARCH for candidate files because it doesn't know them yet),
    // this already knows exactly which files from the candidate's own "Files:" line, so no
    // search step is needed -- just read them, best-effort. A file that doesn't exist
    // (a candidate proposing a brand-new file, or a stale/illustrative path) is not an
    // error -- see fetchedFiles' own promptContext field, which the implement prompt is
    // told explicitly means "ground a create, or flag the mismatch, don't invent content."
    const { repoRoot } = getConfig();
    const readWindowed = (relPath, isContext) => {
      try {
        const full = path.resolve(repoRoot, relPath);
        if (!full.startsWith(path.resolve(repoRoot) + path.sep) && full !== path.resolve(repoRoot)) return null;
        const content = fs.readFileSync(full, 'utf8');
        const windowed = windowFetchedFileContent(content, section);
        const entry = { path: relPath, content: windowed.text, anchorConfidence: windowed.confidence };
        if (isContext) entry.context = true; // referenced in prose, not a declared edit target
        return entry;
      } catch {
        return null; // doesn't exist / unreadable -- not an error, see comment above
      }
    };
    const declaredFetched = filesArray.map((p) => readWindowed(p, false)).filter(Boolean);
    const contextFetched = contextFiles.map((p) => readWindowed(p, true)).filter(Boolean);
    const fetchedFiles = [...declaredFetched, ...contextFetched];

    // Pre-draft premise recheck (see this file's own header comment above
    // staleSignatureReason/archiveStaleCandidate for the full incident): either check
    // hitting skips a full plan/implement/review cycle entirely -- filed straight to
    // done/_archived_no_action/, loop continues to the next candidate in the doc.
    const staleReason = staleSignatureReason(pipelineDir, section);
    const evidence = computePremiseEvidence({ promptContext: { body: section, fetchedFiles } });
    const invalidPremiseReason = evidence.contradictions.length ? evidence.contradictions[0].detail : null;
    if (staleReason || invalidPremiseReason) {
      archiveStaleCandidate({
        pipelineDir, taskId, domain: defaultDomain, sourceName, titleText, candidateId, section,
        reason: staleReason || invalidPremiseReason,
      });
      continue;
    }

    // Path-hallucination guard (2026-08-26, Grimmethy: "Can we answer why it didn't get
    // correct files to begin with?" -- arch-review-ac-7 investigation). Same shape as the
    // isPlaceholderBody skip above (a real, precedented gap: arch-review-ac-10 sat
    // permanently un-completable for weeks because this function trusted ANY
    // "Strength: Strong" section as actionable with no check its content was real) but for
    // the "Files:" line instead of the Problem/Solution body. Confirmed live: AC-7 listed
    // 5 files (none with a directory prefix, two -- resolveGraphPath.js/getConfig.js --
    // not real files at all, both actually live together in src/config.js) despite
    // archReviewImplementPrompt's own explicit instruction to copy paths exactly as given
    // -- the model just didn't follow it. Every one of the 5 silently failed to resolve
    // above, leaving fetchedFiles empty, and the task was queued anyway, doomed to the same
    // "no real implementation code" degenerate/blocked cycle every single pass. Deliberately
    // NOT skipping on filesArray.length === 1 with zero fetchedFiles -- see this function's
    // own comment above: a candidate proposing ONE genuinely brand-new file is a valid,
    // intended shape (fetchedFiles' own promptContext meaning is "ground a create, or flag
    // the mismatch"). Multiple listed files where NONE resolve is a much stronger signal --
    // no real architectural finding proposes touching several already-existing-sounding
    // files that are ALL, simultaneously, brand new.
    if (filesArray.length >= 2 && declaredFetched.length === 0) continue;

    // Deterministic, one-level candidate pre-split (2026-09-02). A candidate declaring >=2
    // files, or laying out >=3 numbered edit steps in its Solution, is more than the local
    // 27B reliably lands in a single diff (pipeline-forensics-fix-ac-1/-ac-14 blocked+
    // exhausted exactly this way). `mustPreSplit` tells the implement pass to decompose it
    // into single-concern sub-candidates FIRST. Every sub-candidate the split writes back
    // carries `Split-Depth: 1`; this reader refuses to pre-split anything already at depth
    // >= 1, a hard recursion stop that does NOT depend on the model's judgement (the earlier
    // model-driven re-split went infinite -- AC-4..AC-12, 2026-09-01).
    const depthMatch = section.match(/^Split-Depth:\s*(\d+)\s*$/m);
    const splitDepth = depthMatch ? Number(depthMatch[1]) : 0;
    // Count numbered steps off the raw section (the Solution-only capture above stops at
    // the first end-of-line under /m, so it can't be used for this).
    const solutionSlice = section.split(/^Solution:/m)[1] ? section.split(/^Solution:/m)[1].split(/^Benefits:/m)[0] : '';
    const numberedSteps = (solutionSlice.match(/(?:^|\n)\s*\d+[.)]\s+\S/g) || []).length;
    const mustPreSplit = splitDepth === 0 && (filesArray.length >= 2 || numberedSteps >= 3);

    // "detect and label, never silently discard" (this function's existing placeholder/
    // hallucination-guard convention, see comments above): a 'weak' fallback is still worth
    // a real attempt, but if EVERY declared file came back with zero anchors at all, stamp
    // that explicitly rather than letting the implement pass silently guess against noise.
    const groundingConfidence = declaredFetched.length > 0 && declaredFetched.every((f) => f.anchorConfidence === 'none')
      ? 'none'
      : null;

    return {
      id: taskId,
      domain: defaultDomain,
      source: sourceName,
      title: `${candidateId} · ${titleText}`,
      promptContext: {
        candidateId,
        title: titleText,
        files: filesArray,
        fetchedFiles,
        body: section,
        splitDepth,
        mustPreSplit,
        ...(groundingConfidence ? { groundingConfidence } : {}),
      },
    };
  }

  return null;
}

module.exports = { extractCandidateSignatures, liveSignatureCount, staleSignatureReason, archiveStaleCandidate, nextCandidateFulfillmentTask, SIGNATURE_RE, MAX_ARCH_REVIEW_TASK_CHARS };
