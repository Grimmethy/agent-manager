'use strict';

// apply-group-a-brain-dump.js -- extracted from src/apply-group-a.js ([[hub-task-integration]] node-module decompose).

const fs = require('fs');
const path = require('path');
const { resolveAnchors, extractKeywords } = require('./path-prefetch.js');
const { resolveGraphPath } = require('./config.js');
const { writeAtomicSync, writeJsonAtomicSync } = require('./atomic-write.js');
const {
  CANONICAL_TOP_LEVEL,
  GENERIC_FILENAME_BLOCKLIST,
  parseBrainDumpSortResult,
  validateSecondBrainPath,
  normalizeSecondBrainPathCase,
  deriveBelongsToProject,
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

function recoverableSortSkip(data, entry, brainDumpPath, reason) {
  entry.sortAttempt = (entry.sortAttempt || 0) + 1;
  try {
    fs.mkdirSync(path.dirname(brainDumpPath), { recursive: true });
    writeJsonAtomicSync(brainDumpPath, data);
  } catch { /* best-effort -- reject-retry-check's exhaustion path also bumps sortAttempt */ }
  return { skipped: true, recoverable: true, reason };
}

function applyBrainDumpSort({ implementResponse, task, brainDumpPath, secondBrainDir, pipelineDir }) {
  const { brainDumpEntryId, rawText } = task.promptContext;

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
  if (entry.status !== 'captured' || entry.rawText !== rawText) {
    return recoverableSortSkip(data, entry, brainDumpPath,
      'brain-dump entry changed since this task was drafted -- a fresh sort will classify the current text');
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
      const adhocTask = {
        id: queuedId,
        domain: 'adhoc',
        source: 'brain_dump',
        title: rawText.slice(0, 120),
        promptContext: { rawText, brainDumpEntryId },
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
      let adhocDir = path.join(matchedProject.pipelineDir, 'queue', 'adhoc');
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
      if (result.possibleDuplicateOf) {
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

module.exports = { allNoteBasenames, resolveNoteLinks, appendMarkdownLineAtomic, loadBrainDump, findEntry, recoverableSortSkip, applyBrainDumpSort, closeBrainDumpEntryResolved, readProjectRegistry };
