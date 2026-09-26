'use strict';

// apply-group-a-brain-dump.js -- extracted from src/apply-group-a.js ([[hub-task-integration]] node-module decompose).

const fs = require('fs');
const path = require('path');
const { resolveAnchors, extractKeywords } = require('./path-prefetch.js');
const { resolveGraphPath } = require('./config.js');
const { writeAtomicSync, writeJsonAtomicSync } = require('./atomic-write.js');
const { normalizeTokens, jaccardSimilarity } = require('./text-similarity.js');
const {
  CANONICAL_TOP_LEVEL,
  GENERIC_FILENAME_BLOCKLIST,
  parseBrainDumpSortResult,
  validateSecondBrainPath,
  normalizeSecondBrainPathCase,
  deriveBelongsToProject,
  isInvestigationFinding,
} = require('./brain-dump-sort-classify.js');

function readProjectRegistry() {
  const registryPath = process.env.AGENT_MANAGER_PROJECTS_REGISTRY_PATH || path.join(__dirname, '..', 'projects.json');
  try {
    const list = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function sameDir(a, b) {
  const real = (x) => { try { return fs.realpathSync(x); } catch { return path.resolve(x); } };
  return !!a && !!b && real(a) === real(b);
}

// A machine-raised finding (entry.raisedBy.repoRoot, stamped by side-finding.js) belongs to
// the project whose pipeline raised it. brain-dump.json is global, so the classifier could
// only guess -- and its own-project bias sent PF-Client-Portal findings to agent-manager
// (2026-09-19). Returns the registered project entry for that repo, or null.
function originProjectFor(entry, registry) {
  const root = entry && entry.raisedBy && entry.raisedBy.repoRoot;
  if (!root) return null;
  return registry.find((p) => sameDir(p.repoRoot, root)) || null;
}

// Validates a classifier-reported possibleDuplicateOf against the REAL candidate list it
// was actually shown (task.promptContext.existingQueuedTitles, built by task-sources.js's
// existingQueuedTaskTitles()) -- 2026-09-16, pipeline hardening: root-caused live that the
// classifier's possibleDuplicateOf field was never checked against that list at all, so the
// local model could (and, confirmed across a live needs-clarification queue, routinely did)
// return a string that matches NEITHER a real queued title NOR anything resembling one --
// two confirmed shapes: (a) echoing a quoted/bracketed phrase from INSIDE the note's own
// rawText as if it were an external match, (b) a plausible-sounding but entirely invented
// slug (e.g. "agent-manager-apply-target") that isn't a real task title at all (real titles
// are full sentences). Both false-positive shapes permanently routed the note to
// needs-clarification for a human to manually discover it was never a real duplicate --
// confirmed on ~43% of one live needs-clarification queue. Tolerant matching (exact,
// substring either direction for a truncated title, or Jaccard >= 0.5 for a close
// paraphrase) so a genuine match phrased slightly differently than the 140-char-truncated
// title still passes; anything below that bar is almost certainly a hallucination, not a
// real duplicate the classifier actually found.
const DUPLICATE_MATCH_JACCARD_THRESHOLD = 0.5;
function isValidDuplicateMatch(candidate, existingTitles) {
  const c = String(candidate || '').trim();
  if (!c || !Array.isArray(existingTitles) || existingTitles.length === 0) return false;
  const cLower = c.toLowerCase();
  const cTokens = normalizeTokens(c);
  return existingTitles.some((title) => {
    const t = String(title || '').trim();
    if (!t) return false;
    const tLower = t.toLowerCase();
    if (cLower === tLower) return true;
    if (cLower.includes(tLower) || tLower.includes(cLower)) return true;
    return jaccardSimilarity(cTokens, normalizeTokens(t)) >= DUPLICATE_MATCH_JACCARD_THRESHOLD;
  });
}

function allNoteBasenames(secondBrainDir) {
  const names = new Set();
  const walk = (abs, depth) => {
    if (depth > 5) return;
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) walk(path.join(abs, e.name), depth + 1);
      else if (e.name.endsWith('.md')) names.add(e.name.replace(/\.md$/, ''));
    }
  };
  if (secondBrainDir) walk(secondBrainDir, 0);
  return names;
}

function resolveNoteLinks(result, secondBrainDir, selfBasename) {
  const existing = allNoteBasenames(secondBrainDir);
  const byLower = new Map([...existing].map((n) => [n.toLowerCase(), n]));
  const isSelf = (n) => selfBasename && n.toLowerCase() === selfBasename.toLowerCase();

  const linked = [];
  for (const raw of (result.relatedNotes || [])) {
    const hit = byLower.get(String(raw).toLowerCase());
    if (hit && !isSelf(hit) && !linked.includes(hit)) linked.push(hit);
  }
  if (linked.length > 0) return linked.slice(0, 5);

  // Fallback: no explicit relatedNotes resolved -- link the 1-2 existing notes whose
  // basename shares >= 2 distinctive tokens with this note's tags + path stem. No model call.
  const noteTokens = new Set([
    ...extractKeywords((result.tags || []).join(' ')),
    ...extractKeywords(String(result.secondBrainPath || '').replace(/[/\\.]/g, ' ')),
  ].map((k) => k.lower));
  if (noteTokens.size === 0) return [];
  const scored = [];
  for (const name of existing) {
    if (isSelf(name)) continue;
    const overlap = extractKeywords(name.replace(/[-_]/g, ' ')).filter((k) => noteTokens.has(k.lower)).length;
    if (overlap >= 2) scored.push({ name, overlap });
  }
  scored.sort((a, b) => b.overlap - a.overlap);
  return scored.slice(0, 2).map((s) => s.name);
}

function appendMarkdownLineAtomic(fullPath, line) {
  const existing = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf8') : null;
  const contents = existing !== null
    ? existing + line
    : `# ${path.basename(fullPath, path.extname(fullPath))}\n${line}`;
  writeAtomicSync(fullPath, contents);
}

function loadBrainDump(filePath) {
  let data;
  try {
    data = JSON.parse(fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '{"entries":[]}');
  } catch (err) {
    console.error(`[loadBrainDump] ${filePath}: ${err.message}${err.stack ? `\n${err.stack}` : ''} — returning empty store`);
    data = { entries: [] };
  }
  if (!Array.isArray(data.entries)) data.entries = [];
  return data;
}

function findEntry(data, entryId) {
  return data.entries.find((e) => e && e.id === entryId) || null;
}

// Kept in sync with apply-group-a.js's own MAX_SORT_ATTEMPTS (task-sources.js keeps the
// same copy) -- all three count the SAME per-entry sort budget, so a literal number in
// only one of them would let a pass retry past the bound the others enforce. (Not
// imported from apply-group-a.js: it requires THIS module, and its module.exports
// assignment runs last, so a circular require could hand us undefined.)
const MAX_SORT_ATTEMPTS = 3;

function recoverableSortSkip(data, entry, brainDumpPath, reason) {
  entry.sortAttempt = (entry.sortAttempt || 0) + 1;
  try {
    fs.mkdirSync(path.dirname(brainDumpPath), { recursive: true });
    writeJsonAtomicSync(brainDumpPath, data);
  } catch { /* best-effort -- reject-retry-check's exhaustion path also bumps sortAttempt */ }
  return { skipped: true, recoverable: true, reason };
}

function applyBrainDumpSort({ implementResponse, task, brainDumpPath, secondBrainDir, pipelineDir }) {
  const { brainDumpEntryId, rawText, existingQueuedTitles } = task.promptContext;

  const data = loadBrainDump(brainDumpPath);

  const entry = findEntry(data, brainDumpEntryId);
  if (!entry) {
    // Terminal: the entry is gone, there is nothing to regenerate.
    return { skipped: true, reason: `brain-dump entry "${brainDumpEntryId}" no longer exists (deleted since this task was drafted)` };
  }
  // The entry may have been edited (the dashboard's PUT resets status back to 'captured' on
  // a text change) or otherwise changed since this task was drafted -- classifying stale
  // text into the entry's CURRENT record would silently mislabel it under a rawText it no
  // longer has. Only apply if the entry is still exactly what this task was drafted against.
  if (entry.suppressed) {
    // A human retired this finding after its sort task was queued -- sorting it now would
    // still file a note or queue a task for something they already dismissed.
    return { skipped: true, reason: 'brain-dump entry was suppressed since this task was queued -- not sorting it' };
  }
  if (entry.status !== 'captured' || entry.rawText !== rawText) {
    if (entry.rawText === rawText) {
      // Status-only drift (text unchanged, entry already sorted/actioned): re-running
      // the pass would re-apply work that is already done. Keep HUB0050's distinct
      // non-success shape -- no sortAttempt write (the entry is left exactly as-is),
      // no recoverable flag, and success:false so the caller's stale check
      // (apply-group-a.js) can route it away from the done transition.
      return {
        skipped: true,
        stale: true,
        success: false,
        reason: 'brain-dump entry changed since this task was drafted -- a fresh sort will classify the current text',
      };
    }
    // Refresh branch (HUB0052 2/3): the entry's text changed after this task was
    // drafted (the dashboard's PUT resets status to 'captured' on a text change) --
    // implementResponse was classified against the OLD text, but re-running this SAME
    // pass against the entry's CURRENT text is still a valid classification of what
    // the entry actually says now, so apply it instead of dropping it. Substitute
    // entry.rawText into promptContext (deriveBelongsToProject, the research branch,
    // and the adhoc branch all read the text from there) and re-run the whole
    // classify+apply pipeline below. Mirrors the duplicate-gate retry pattern further
    // down: the budget counter lives on the ENTRY (the object that persists across
    // repeated classification attempts of the same note), recoverableSortSkip bounds
    // it (it bumps sortAttempt, and nextBrainDumpSortTask() stops regenerating once
    // sortAttempt >= MAX_SORT_ATTEMPTS), and the entry is left exactly as-is on the
    // way out.
    if ((entry.sortAttempt || 0) >= MAX_SORT_ATTEMPTS) {
      return recoverableSortSkip(data, entry, brainDumpPath,
        'brain-dump entry changed since this task was drafted and the sort budget is exhausted -- not re-classifying the current text');
    }
    const refreshed = applyBrainDumpSort({
      implementResponse,
      task: { ...task, promptContext: { ...task.promptContext, rawText: entry.rawText } },
      brainDumpPath,
      secondBrainDir,
      pipelineDir,
    });
    if (!refreshed || refreshed.skipped) {
      // Re-validation failed (every internal failure path is a recoverableSortSkip,
      // which already bumped and persisted entry.sortAttempt) or a terminal skip --
      // return the shape untouched; refreshed:true marks a SUCCESS only.
      return refreshed;
    }
    return { ...refreshed, refreshed: true };
  }

  if (!secondBrainDir) {
    // Terminal: no vault configured, no retry will help.
    return { skipped: true, reason: 'SECOND_BRAIN_DIR is not configured -- cannot file this entry anywhere' };
  }

  const result = parseBrainDumpSortResult(implementResponse);
  if (!result) {
    return recoverableSortSkip(data, entry, brainDumpPath,
      'implement pass did not return a valid classification JSON');
  }

  const trackedLabels = readProjectRegistry().map((p) => p.label).filter(Boolean);
  result.secondBrainPath = normalizeSecondBrainPathCase(result.secondBrainPath, trackedLabels);
  result.secondBrainPath = path.normalize(result.secondBrainPath);
  // normalizeSecondBrainPathCase above only corrects against the CANONICAL_TOP_LEVEL
  // constant + the project registry's own label spelling -- it trusts the registry, not
  // the disk. If a tracked project's real on-disk folder casing has ever drifted from
  // its registry label (a manual rename, or the label recorded before the folder existed),
  // that correction can hand validateSecondBrainPath's OWN on-disk conflict check a
  // spelling that doesn't match what's actually there, tripping its "different-case
  // duplicate" rejection for a folder that in fact already exists -- the silent no-op
  // this whole task is about. Resolve the first segment against disk directly, but only
  // when exactly one entry matches case-insensitively (0 or 2+ matches is ambiguous or
  // missing -- leave the path as-is and let validateSecondBrainPath's own rejection,
  // "different-case duplicate" included, be the fallback).
  if (secondBrainDir) {
    const segments = result.secondBrainPath.split(/[\\/]/).filter(Boolean);
    if (segments.length > 0) {
      let entries;
      try {
        entries = fs.readdirSync(secondBrainDir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith('.'));
      } catch {
        entries = [];
      }
      const matches = entries.filter((e) => e.name.toLowerCase() === segments[0].toLowerCase());
      if (matches.length === 1 && matches[0].name !== segments[0]) {
        segments[0] = matches[0].name;
        result.secondBrainPath = segments.join('/');
      }
    }
  }
  const namingError = validateSecondBrainPath(result.secondBrainPath, secondBrainDir, trackedLabels);
  if (namingError) {
    return recoverableSortSkip(data, entry, brainDumpPath,
      `rejected secondBrainPath "${result.secondBrainPath}": ${namingError}`);
  }

  // Deterministic belongsToProject recovery -- the classifier routinely leaves this null
  // for a note that is plainly a concrete change to this pipeline's own code (the dominant
  // failure of the blocked backlog). May also flip actionable true.
  {
    const derived = deriveBelongsToProject(result, task.promptContext);
    result.belongsToProject = derived.belongsToProject;
    result.actionable = derived.actionable;
  }

  // Origin routing: a finding raised by project X's pipeline is about project X, whatever
  // the classifier guessed. Overrides the label; and a note filed under a DIFFERENT tracked
  // project's vault folder moves to X's folder when that folder exists.
  {
    const origin = originProjectFor(entry, readProjectRegistry());
    if (origin && origin.label) {
      result.belongsToProject = origin.label;
      const segments = result.secondBrainPath.split(/[\\/]/).filter(Boolean);
      if (segments.length > 1 && segments[0] !== origin.label
          && trackedLabels.includes(segments[0])
          && fs.existsSync(path.join(secondBrainDir, origin.label))) {
        segments[0] = origin.label;
        result.secondBrainPath = segments.join('/');
      }
    }
  }

  // Investigation-shaped machine findings become notes, never code tasks (see
  // isInvestigationFinding's header). Applied AFTER origin routing so the note still files
  // under the raising project's vault folder.
  if (entry.raisedBy && isInvestigationFinding(rawText)) {
    result.belongsToProject = null;
    result.actionable = false;
  }

  // Brain Dump #1 follow-up (2026-08-17): a note can be actionable WITHOUT being a code
  // change -- "investigate X, document findings" needs real web research, not a diff
  // against any tracked project. Only when NO tracked project was named/recovered -- a
  // note tied to a project routes to that project's queue below, never to research.
  if (result.requiresResearch && !result.belongsToProject) {
    if (!pipelineDir) {
      return { skipped: true, reason: 'no pipelineDir available -- cannot queue a research task' };
    }
    const queuedId = `research-brain-dump-${brainDumpEntryId}-${Date.now()}`;
    const researchTask = {
      id: queuedId,
      domain: 'research',
      source: 'research_task',
      title: rawText.slice(0, 120),
      promptContext: { rawText, brainDumpEntryId, secondBrainPath: result.secondBrainPath, tags: result.tags },
    };
    const researchDir = path.join(pipelineDir, 'queue', 'research');
    fs.mkdirSync(researchDir, { recursive: true });
    writeJsonAtomicSync(path.join(researchDir, `${queuedId}.json`), researchTask);

    // Same audit-trail cross-reference convention the adhoc branch below already uses --
    // an entry findable in the note it will eventually gain real content in, not the
    // record of truth (brain-dump.json's queuedTaskId/queuedAt is that).
    const fullPath = path.join(secondBrainDir, result.secondBrainPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    appendMarkdownLineAtomic(fullPath, `\n- **${stamp}** Queued as research task \`${queuedId}\` -- ${rawText}\n`);

    entry.status = 'actioned';
    entry.queuedTaskId = queuedId;
    entry.queuedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(brainDumpPath), { recursive: true });
    writeJsonAtomicSync(brainDumpPath, data);

    return { file: fullPath, queuedTaskId: queuedId, researchQueued: true };
  }

  // A note naming a tracked project IS work -- queue a real adhoc task in that project's
  // own queue. The old `result.actionable &&` precondition is dropped (2026-09-03, user:
  // "a note describing a concrete change to a tracked project always becomes a work task"):
  // a project-labelled note the classifier forgot to mark actionable is still a task, and
  // deriveBelongsToProject already forces actionable when it recovers a self-project label.
  const matchedProject = result.belongsToProject
    ? readProjectRegistry().find((p) => p.label === result.belongsToProject)
    : null;

  if (result.belongsToProject && !matchedProject) {
    // reviewBrainDumpSort should have blocked a non-tracked label; if one slipped through,
    // don't silently downgrade it to a passive note -- that masks the misclassification.
    return recoverableSortSkip(data, entry, brainDumpPath,
      `belongsToProject "${result.belongsToProject}" does not match any registered project -- a corrected pass should name a tracked label or null`);
  }

  if (matchedProject) {
    const validDomains = (() => {
      try {
        return Object.keys(JSON.parse(fs.readFileSync(matchedProject.domainsPath, 'utf8')));
      } catch (err) {
        const reason = err && err.message ? err.message : String(err);
        process.stderr.write(`[apply-group-a] failed to read domains from ${matchedProject.domainsPath}: ${reason}\n`);
        return [];
      }
    })();

    if (validDomains.includes('adhoc')) {
      const queuedId = `adhoc-brain-dump-${brainDumpEntryId}-${Date.now()}`;
      // A brain-dump entry with a `raisedBy` was machine-filed (side-finding-sweep.js:
      // a pipeline_debrief Now-What item, or any pass's writeSideFindingInbox side
      // finding) -- NOT a human handing the pipeline a task. Route it to queue/derived/
      // (source: derived_task, priority 48) instead of queue/adhoc/ (priority 10, preempts
      // every deterministic source), so this whole class is its own throttleable Job List
      // lane. A human-typed entry has no raisedBy and stays genuine adhoc. If it still
      // needs clarification (below), it goes to needs-clarification either way -- a human
      // resolving it there re-files it as real adhoc, which is correct (they vouched for it).
      const isDerived = !!(entry && entry.raisedBy);
      const adhocTask = {
        id: queuedId,
        domain: 'adhoc',
        source: isDerived ? 'derived_task' : 'brain_dump',
        title: rawText.slice(0, 120),
        promptContext: isDerived
          ? { rawText, brainDumpEntryId, derivedFrom: entry.raisedBy }
          : { rawText, brainDumpEntryId },
      };

      // Path-prefetch (context-aware-file-path-prefetch-job.md, 2026-08-16): resolve
      // anchor keywords from this task's title/rawText against the target project's own
      // dependency graph BEFORE it's ever claimed for drafting, so the plan/implement
      // passes already have real, validated file paths in promptContext instead of the
      // model searching for them (or worse, inventing them) from scratch on every call.
      // 'greenfield' (no graph built yet for this project) is explicitly NOT an error --
      // per the Discuss session's own note, that's just "nothing to prefetch," and the
      // task queues normally. 'no-match'/'ambiguous' are the two cases the Grill Me/
      // Discuss sessions asked to be held for a human rather than silently guessed at:
      // written to queue/needs-clarification/ instead of queue/adhoc/, invisible to
      // nextAdhocTask() (which only ever scans queue/adhoc/) until a human resolves it
      // via the dashboard.
      // graphPathOverride via config.js's resolveGraphPath() (not path-prefetch.js's own
      // graphify-out/graph.json default) -- confirmed live 2026-08-16: the dashboard's
      // Build Graph button writes to .agent-manager-cache/, not graphify-out/, so without
      // this override every real project's graph looked absent ('greenfield') even after
      // a real build, and this fast path silently never matched anything.
      const anchorResult = resolveAnchors({
        repoRoot: matchedProject.repoRoot,
        title: adhocTask.title,
        rawText,
        graphPathOverride: resolveGraphPath(matchedProject.repoRoot),
        // uiVocabHubFiles (2026-08-20, see path-prefetch.js's UI_VOCAB header): opt-in
        // per project in projects.json -- a project with no UI hub file(s) declared here
        // simply never triggers the fallback, same behavior as before this existed.
        uiVocabHubFiles: matchedProject.uiVocabHubFiles || [],
      });
      let adhocDir = path.join(matchedProject.pipelineDir, 'queue', isDerived ? 'derived' : 'adhoc');
      if (anchorResult.status === 'matched') {
        adhocTask.promptContext.prefetchedPaths = anchorResult.paths;
      } else if (anchorResult.status === 'no-match') {
        adhocDir = path.join(matchedProject.pipelineDir, 'queue', 'needs-clarification');
        adhocTask.needsClarification = { reason: 'no-match' };
      } else if (anchorResult.status === 'ambiguous') {
        adhocDir = path.join(matchedProject.pipelineDir, 'queue', 'needs-clarification');
        adhocTask.needsClarification = { reason: 'ambiguous', candidates: anchorResult.candidates };
        if (anchorResult.paths.length > 0) adhocTask.promptContext.prefetchedPaths = anchorResult.paths;
      }
      // 'greenfield': adhocTask left exactly as constructed above, queues normally with
      // no prefetchedPaths field at all -- there is nothing to prefetch from yet.

      // 2026-08-24 (pipeline hardening, Grimmethy: "duplicate-task detection before
      // filing") -- brainDumpSortPlanPrompt/ImplementPrompt already showed the classifier
      // every currently-queued task title and asked it to flag a real match. Overrides
      // whatever the anchor-resolution logic above decided (even a confident path match
      // isn't worth drafting if the whole task is a duplicate) -- held for a human via the
      // SAME multiple-choice/free-text picker the "needs a human decision" adhoc path
      // already uses (adhoc-agentic-draft.js's RESOLUTION: needs-human-decision), not a
      // new UI: no structured options here since this is really a binary "is this real"
      // call the existing generic Archive button on every needs-clarification row (for
      // "yes, duplicate") plus the free-text Other box (for "no, here's why not") already
      // fully cover.
      // Validate BEFORE trusting it -- see isValidDuplicateMatch's own header for the
      // incident this closes. A classifier answer that matches nothing in the real
      // candidate list it was shown is treated as no match at all, not a duplicate flag.
      if (result.possibleDuplicateOf && !isValidDuplicateMatch(result.possibleDuplicateOf, existingQueuedTitles)) {
        console.warn(`[apply-group-a-brain-dump] possible-duplicate gate: entry ${brainDumpEntryId} claimed a duplicate of "${result.possibleDuplicateOf}" but that does not match any real candidate title shown to the classifier -- discarding as a hallucinated match, not routing to needs-clarification`);
        result.possibleDuplicateOf = null;
      }
      if (result.possibleDuplicateOf) {
        // Bounded one-retry gate (2026-09-15, brain-dump bd-1788900769368: "All three
        // 'failing' tasks share identical death signature... with zero model_calls" --
        // root-caused live: a fuzzy title-match false positive here used to route
        // straight to needs-clarification every time, with no way back -- this decision
        // happens at APPLY time for the brain_dump_sort CLASSIFICATION task, before the
        // downstream adhoc task this block builds ever exists, so reject-retry-check.js's
        // retry machinery (which only ever sees adhoc/research tasks, not this one) can
        // never reach it. Mirrors needs-clarification-triage.js's own ncTriageAttempts/
        // MAX_REQUEUES pattern -- and reuses recoverableSortSkip, the SAME mechanism this
        // file already relies on for every other "give it one more classification pass"
        // case just above -- by leaving entry.status as 'captured' (not writing the
        // downstream adhoc task, not marking the entry actioned), nextBrainDumpSortTask()
        // naturally re-drafts a fresh classification of this same note later, which may
        // well not repeat the same fuzzy match on a differently-worded pass. The counter
        // lives on the brain-dump ENTRY (not the classification task or the not-yet-built
        // adhocTask) since the entry is the one object that genuinely persists across
        // repeated classification attempts of the same logical note.
        const duplicateGateAttempts = Number(entry.duplicateGateAttempts) || 0;
        if (duplicateGateAttempts < 1) {
          entry.duplicateGateAttempts = duplicateGateAttempts + 1;
          console.warn(`[apply-group-a-brain-dump] possible-duplicate gate: entry ${brainDumpEntryId} matched against "${result.possibleDuplicateOf}" (duplicateGateAttempts=${entry.duplicateGateAttempts}) -- retrying with a fresh classification pass instead of routing to needs-clarification`);
          return recoverableSortSkip(data, entry, brainDumpPath,
            `possible duplicate of "${result.possibleDuplicateOf}" on the first flag -- retrying with a fresh classification pass`);
        }
        console.warn(`[apply-group-a-brain-dump] possible-duplicate gate: entry ${brainDumpEntryId} matched against "${result.possibleDuplicateOf}" again (duplicateGateAttempts=${duplicateGateAttempts}) -- routing to needs-clarification`);
        adhocDir = path.join(matchedProject.pipelineDir, 'queue', 'needs-clarification');
        adhocTask.needsClarification = {
          reason: 'design-decision',
          openQuestions: (
            `This brain-dump note was flagged as a possible duplicate of an already-` +
            `queued task:\n\n  "${result.possibleDuplicateOf}"\n\n` +
            `NOTE (this task's own text): ${rawText}\n\n` +
            'If this genuinely is the same underlying feature/fix, use the Archive ' +
            'button on this row instead of answering below. If it is NOT actually a ' +
            'duplicate (different scope, different project, coincidental overlap), ' +
            'explain why in the box below and submit to send it to drafting.'
          ),
        };
      }

      adhocTask.generatedForRepoRoot = matchedProject.repoRoot;

      fs.mkdirSync(adhocDir, { recursive: true });
      writeJsonAtomicSync(path.join(adhocDir, `${queuedId}.json`), adhocTask);

      entry.status = 'actioned';
      entry.queuedTaskId = queuedId;
      entry.queuedAt = new Date().toISOString();
      fs.mkdirSync(path.dirname(brainDumpPath), { recursive: true });
      writeJsonAtomicSync(brainDumpPath, data);

      return { file: path.join(adhocDir, `${queuedId}.json`), queuedTaskId: queuedId, queuedProject: matchedProject.label };
    }
    // Matched a real project but it has no 'adhoc' domain -- a config gap that needs a
    // human, not a silent downgrade to a passive note.
    return recoverableSortSkip(data, entry, brainDumpPath,
      `matched project "${matchedProject.label}" has no 'adhoc' domain registered -- cannot queue work there`);
  }

  // Passive vault note -- the fallback for a genuine observation / journal / reference
  // entry not tied to any tracked project.
  const fullPath = path.join(secondBrainDir, result.secondBrainPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const tagsSuffix = result.tags.length ? ` _(${result.tags.join(', ')})_` : '';
  const links = resolveNoteLinks(result, secondBrainDir, path.basename(result.secondBrainPath, '.md'));
  const wikiSuffix = links.length ? ` -- see ${links.map((n) => `[[${n}]]`).join(', ')}` : '';
  const line = `\n- **${stamp}** ${rawText}${tagsSuffix}${wikiSuffix}\n`;
  appendMarkdownLineAtomic(fullPath, line);

  entry.status = 'sorted';
  entry.sort = {
    secondBrainPath: result.secondBrainPath,
    tags: result.tags,
    actionable: result.actionable,
    rationale: result.rationale,
  };
  entry.sortedAt = new Date().toISOString();

  fs.mkdirSync(path.dirname(brainDumpPath), { recursive: true });
  writeJsonAtomicSync(brainDumpPath, data);

  return { file: fullPath };
}

function closeBrainDumpEntryResolved({ brainDumpPath, brainDumpEntryId, note }) {
  if (!brainDumpPath || !brainDumpEntryId) return { skipped: true, reason: 'no brainDumpPath/brainDumpEntryId to close' };

  let data;
  try {
    data = JSON.parse(fs.existsSync(brainDumpPath) ? fs.readFileSync(brainDumpPath, 'utf8') : '{"entries":[]}');
  } catch {
    return { skipped: true, reason: 'brain-dump.json unreadable -- not closing anything' };
  }
  if (!Array.isArray(data.entries)) return { skipped: true, reason: 'brain-dump.json has no entries array' };

  const entry = data.entries.find((e) => e && e.id === brainDumpEntryId);
  if (!entry) return { skipped: true, reason: `brain-dump entry "${brainDumpEntryId}" no longer exists` };

  entry.status = 'actioned';
  entry.resolvedNote = note;
  entry.resolvedAt = new Date().toISOString();
  writeJsonAtomicSync(brainDumpPath, data);
  return { closed: true, entryId: brainDumpEntryId };
}

module.exports = { allNoteBasenames, resolveNoteLinks, appendMarkdownLineAtomic, loadBrainDump, findEntry, recoverableSortSkip, applyBrainDumpSort, closeBrainDumpEntryResolved, readProjectRegistry, isValidDuplicateMatch, originProjectFor };
