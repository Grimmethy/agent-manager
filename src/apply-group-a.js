'use strict';

// Deterministic (no-LLM) writers for "Group A" task sources -- ones whose implement draft
// is already a literal artifact (a vault note to save, etc.), not a prose description of a
// change or grammar-constrained JSON. Part of removing an LLM from the apply step entirely
// -- see apply-task.js, which calls this after a task has already been reviewed and approved.
//
// Only the fully generic writer lives here. Project-specific Group A writers (e.g. a
// county-index-file writer) belong in the CONSUMING project's own registration file and
// get wired in via updateTaskSource(name, { apply }) exactly like this package's own
// arch_review/trouble_log/adhoc sources use the Group B default -- see README.md
// "Registering a custom apply function". arch_discovery's candidate-appender, deep_dive's
// findings-appender, and project_search's index-appender are NOT examples of that: all
// three are built in below, same as this file's other writers -- arch_discovery previously
// had no apply registered at all (an oversight, not a deliberate boundary; every approved
// arch_discovery task failed apply 100% of the time as a result, found live 2026-07-21).

const fs = require('fs');
const path = require('path');
const { parseJsonMaybeFenced } = require('./json-fence.js');
const { resolveAnchors, extractKeywords } = require('./path-prefetch.js');
const { resolveGraphPath } = require('./config.js');
const { writeAtomicSync, writeJsonAtomicSync } = require('./atomic-write.js');
const { allNoteBasenames, resolveNoteLinks, appendMarkdownLineAtomic, loadBrainDump, findEntry, recoverableSortSkip, applyBrainDumpSort, closeBrainDumpEntryResolved } = require('./apply-group-a-brain-dump.js');

const {
  CANONICAL_TOP_LEVEL,
  GENERIC_FILENAME_BLOCKLIST,
  parseBrainDumpSortResult,
  validateSecondBrainPath,
  normalizeSecondBrainPathCase,
  deriveBelongsToProject,
} = require('./brain-dump-sort-classify.js');

// brain_dump_sort entries get MAX_SORT_ATTEMPTS classification passes before the entry is
// left 'captured' for a human -- kept in sync with task-sources.js's own constant.
const MAX_SORT_ATTEMPTS = 3;

function applySecondBrainNote({ implementResponse, notePath, secondBrainDir }) {
  const resolvedPath = path.isAbsolute(notePath) ? notePath : path.join(secondBrainDir, notePath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  writeAtomicSync(resolvedPath, implementResponse || '');

  const markerPath = resolvedPath + '.done';
  writeAtomicSync(markerPath, '');

  return { file: resolvedPath, marker: markerPath };
}

// Parses project_search's implement-pass output (see prompts.js's projectSearchImplementPrompt
// for the exact "### PROJECT: name" format this must match) and appends findings to the
// central cross-project index -- see ADR-0018 / docs/project-search-pipeline.md. Weak
// findings get one table row; Strong findings get a row PLUS a `## Project Name` subsection
// with rationale, matching UsefulProjectIndex/README.md's own documented convention.
function parseProjectSearchFindings(implementResponse) {
  const text = (implementResponse || '').trim();
  if (!text) return [];
  const blocks = text.split(/(?=^### PROJECT: )/m).map((b) => b.trim()).filter(Boolean);
  const field = (block, name) => {
    const m = block.match(new RegExp(`^${name}:\\s*(.+), 'mi'));
    return m ? m[1].trim() : '';
  };
  return blocks
    .map((block) => {
      const nameMatch = block.match(/^### PROJECT:\s*(.+)$/m);
      if (!nameMatch) return null;
      return {
        name: nameMatch[1].trim(),
        source: field(block, 'Source'),
        url: field(block, 'URL'),
        description: field(block, 'Description'),
        relevantTo: field(block, 'Relevant to'),
        strength: field(block, 'Strength'),
        query: field(block, 'Query'),
        rationale: field(block, 'Rationale'),
      };
    })
    .filter((f) => f && f.name && f.url);
}

function applyProjectSearchFindings({ implementResponse, indexPath }) {
  const findings = parseProjectSearchFindings(implementResponse);
  if (findings.length === 0) return { skipped: true, reason: 'no findings in implement response -- nothing to apply' };

  let indexText = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : '# Index\n\n| Project | Source | Description | Relevant to | Status |\n|---|---|---|---|---|\n\n## Notes\n';

  const rows = findings.map((f) => `| [${f.name}](${f.url}) | ${f.source || 'unknown'} | ${f.description} | ${f.relevantTo} | lead |`);
  const strongSubsections = findings
    .filter((f) => /strong/i.test(f.strength))
    .map((f) => {
      const lines = [`### ${f.name}`, ''];
      if (f.query) lines.push(`Found via query: "${f.query}"`, '');
      if (f.rationale) lines.push(f.rationale);
      return lines.join('\n');
    });

  // Insert new rows right after the header row, before any existing rows -- newest leads
  // first, matching how a human would want to scan a growing list.
  const headerLine = '|---|---|---|---|---|';
  const headerIdx = indexText.indexOf(headerLine);
  if (headerIdx === -1) {
    indexText += '\n' + rows.join('\n') + '\n';
  } else {
    const insertAt = headerIdx + headerLine.length;
    indexText = indexText.slice(0, insertAt) + '\n' + rows.join('\n') + indexText.slice(insertAt);
  }

  if (strongSubsections.length > 0) {
    const notesIdx = indexText.indexOf('## Notes');
    const subsectionText = '\n' + strongSubsections.join('\n\n') + '\n';
    indexText = notesIdx === -1
      ? indexText + '\n## Notes\n' + subsectionText
      : indexText.slice(0, notesIdx + '## Notes'.length) + subsectionText + indexText.slice(notesIdx + '## Notes'.length);
  }

  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  writeAtomicSync(indexPath, indexText);

  return { file: indexPath, findingCount: findings.length, strongCount: strongSubsections.length };
}

// Parses deep_dive's implement-pass output (see prompts.js's deepDiveImplementPrompt for
// the exact "### ITEM: title" format this must match) -- see ADR-0019 /
// docs/deep-dive-pipeline.md. Unlike project_search's Strong/Weak split, every item here
// (including Ignore-rated ones) gets written -- an honest "nothing useful here, and why"
// is a valid, auditable outcome, not something to omit.
function parseDeepDiveItems(implementResponse) {
  const text = (implementResponse || '').trim();
  if (!text) return [];
  const blocks = text.split(/(?=^### ITEM: )/m).map((b) => b.trim()).filter(Boolean);
  const field = (block, name) => {
    const m = block.match(new RegExp(`^${name}:\\s*(.+), 'mi'));
    return m ? m[1].trim() : '';
  };
  return blocks
    .map((block) => {
      const titleMatch = block.match(/^### ITEM:\s*(.+)$/m);
      if (!titleMatch) return null;
      return {
        title: titleMatch[1].trim(),
        community: field(block, 'Community'),
        files: field(block, 'Files'),
        rating: field(block, 'Rating'),
        rationale: field(block, 'Rationale'),
      };
    })
    .filter((it) => it && it.title && it.rationale);
}

// Appends one community's action items to UsefulProjectIndex/analysis/<project-slug>.md
// (created with a header on first write) and stamps lastReviewedAt/actionItemCount on the
// matching community entry in deep-dive-coverage.json. Both are plain, non-git writes --
// unlike arch_discovery's candidate append (which lands inside repoRoot and goes through a
// real git branch/commit/push), deep_dive's target lives outside any project's repo root,
// same shape as project_search's INDEX.md write.
function applyDeepDiveFindings({ implementResponse, task, analysisDir, coveragePath }) {
  const items = parseDeepDiveItems(implementResponse);
  const { projectSlug, projectName, communityId, communityName } = task.promptContext;

  // Stamp the tracker regardless of whether there were any items -- a reviewed-but-empty
  // community is a real, distinguishable outcome (see docs/deep-dive-pipeline.md), not the
  // same as "never got to it."
  let coverage;
  try {
    coverage = JSON.parse(fs.existsSync(coveragePath) ? fs.readFileSync(coveragePath, 'utf8') : '{"projects":{}}');
  } catch (err) {
    console.error(`applyDeepDiveFindings: failed to read/parse coverage file at ${coveragePath}: ${err.message}\n${err.stack}`);
    coverage = { projects: {} };
  }
  if (!coverage.projects) coverage.projects = {};
  const proj = coverage.projects[projectSlug];
  // Every item gets a stable, sequential ID at write time (Ignore items too, for the same
  // audit-trail reason arch_discovery's AC-NNN ids are never reused) -- ADR-0020's
  // arch_import consumes these to promote a specific item without re-promoting it later.
  if (proj) {
    if (typeof proj.nextItemId !== 'number') proj.nextItemId = 1;
    for (const it of items) {
      it.stableId = `${projectSlug}-${proj.nextItemId}`;
      proj.nextItemId += 1;
    }
  }
  if (proj && Array.isArray(proj.communities)) {
    const community = proj.communities.find((c) => c.id === communityId);
    if (community) {
      community.lastReviewedAt = new Date().toISOString();
      community.actionItemCount = items.length;
    }
  }
  fs.mkdirSync(path.dirname(coveragePath), { recursive: true });
  writeJsonAtomicSync(coveragePath, coverage);

  if (items.length === 0) {
    return { skipped: true, reason: `community "${communityName}" reviewed, no action items produced` };
  }

  const analysisPath = path.join(analysisDir, `${projectSlug}.md`);
  let analysisText = fs.existsSync(analysisPath)
    ? fs.readFileSync(analysisPath, 'utf8')
    : `# ${projectName} — Deep Dive\n`;

  const sections = items.map((it) => {
    // "(community #N)" suffix disambiguates communities sharing the same directory-based
    // name (build_graph.py's naming heuristic reuses the same top-level-dir name across
    // multiple distinct communities routinely -- e.g. several unrelated "src/components"
    // communities in one repo) -- the dashboard's Scouted Repos detail view (app.py) parses
    // this suffix to filter items by the exact community a user clicked, not just by name.
    const communityLabel = `${it.community || communityName} (community #${communityId})`;
    const lines = [`## ${it.title}`, ''];
    if (it.stableId) lines.push(`**ID:** ${it.stableId}`);
    lines.push(`**Community:** ${communityLabel}`, `**Rating:** ${it.rating || '(unrated)'}`);
    if (it.files) lines.push(`**Files:** ${it.files}`);
    lines.push('', it.rationale);
    return lines.join('\n');
  });

  analysisText += '\n' + sections.join('\n\n') + '\n';

  fs.mkdirSync(analysisDir, { recursive: true });
  writeAtomicSync(analysisPath, analysisText);

  return { file: analysisPath, itemCount: items.length };
}

// AC-NNN candidate-doc primitives (parse / next-id / append) moved to ./candidate-docs.js
// (2026-08-27) so the out-of-tree hygiene plugin can share one copy. Re-exported below so
// existing `require('./apply-group-a.js')` call sites are unchanged.
const {
  isEffectivelyEmptyResponse,
  parseArchDiscoveryCandidates,
  applyArchDiscoveryCandidates,
} = require('./candidate-docs.js');

// applyArchImportCandidate moved to the agent-manager-hygiene plugin (src/arch.js,
// 2026-08-27) -- only arch_import ever used it. applyArchDiscoveryCandidates (re-exported
// above) stays: core backlog_decomposition still appends AC-NNN candidates with it.

// parseBrainDumpSortResult, GENERIC_FILENAME_BLOCKLIST, validateSecondBrainPath moved to
// src/brain-dump-sort-classify.js (2026-09-03) so task-sources.js's registration can
// reference the validator without a require cycle. Still re-exported below for callers/tests.

// Classifies one Brain Dump entry (captured by the dashboard's Brain Dump tab / POST
// /api/brain-dump/capture) into a second-brain destination, appending a dated line to the
// chosen note (creating it if new) and marking the entry 'sorted' in brainDumpPath. A
// non-git write -- brain-dump.json lives in pipelineDir, the note lives under
// secondBrainDir, neither inside repoRoot -- same reasoning as applySecondBrainNote/
// applyProjectSearchFindings/applyDeepDiveFindings above.
// Registered projects (projects.json, at the package root -- one level up from src/), used
// by the belongsToProject routing below. Best-effort: a missing/corrupt registry just
// means no project can match, same convention as task-sources.js's readProjectLabels.
// AGENT_MANAGER_PROJECTS_REGISTRY_PATH override exists purely for this file's own tests
// -- the real registry is a live file the actual running pipeline reads/writes
// concurrently, unsafe to swap out from under it for a test run.
function readProjectRegistry() {
  const registryPath = process.env.AGENT_MANAGER_PROJECTS_REGISTRY_PATH || path.join(__dirname, '..', 'projects.json');
  try {
    const list = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

// Classifies one Brain Dump entry (captured by the dashboard's Brain Dump tab / POST
// /api/brain-dump/capture). Two outcomes: (1) belongsToProject matches a registered
// project AND actionable is true -- queue a real adhoc implementation task in THAT
// project's own queue/adhoc/, mark the entry 'actioned' (not 'sorted'), and drop a short
// cross-reference note in the second brain for an audit trail (added 2026-07-25: every
// actionable entry previously only ever got filed as a passive note, however concrete --
// see the "Job List priority" brain-dump entry that separately went through the manual
// adhoc button, landed in the WRONG project's queue, and blocked on an unrelated
// domain-config error, invisibly, because nothing here ever routed it correctly in the
// first place). (2) Otherwise: original behavior unchanged -- append a dated line to the
// chosen note, mark 'sorted'. A non-git write either way -- brain-dump.json lives in
// pipelineDir, the note lives under secondBrainDir, neither inside repoRoot -- same
// reasoning as applySecondBrainNote/applyProjectSearchFindings/applyDeepDiveFindings above.
//
// Both call sites below used to branch on fs.existsSync and pick appendFileSync (existing
// note) or writeFileSync (new note, with a header) -- appendFileSync has no atomic-rename
// equivalent (you cannot atomically append via a temp-file-and-rename without rewriting
// the whole file anyway), so folding both branches into one read-then-atomic-rewrite here
// gets the append case the same crash-safety as every other writer in this file, not just
// the create case.
// Auto-wikilink on filing (2026-09-03): resolve the classifier's relatedNotes (and, if
// none resolve, a cheap keyword-overlap fallback) to REAL note basenames in the vault so
// `-- see [[a]], [[b]]` can be appended to the filed bullet -- this is how the note graph
// (python/build_note_graph.py) actually gets edges. Case-insensitive basename match,
// mirrors resolve_wikilink in build_note_graph.py. Best-effort: unreadable vault -> [].
// Loads the brain-dump JSON store from disk, returning a normalized { entries: Array } object.
// A missing file or corrupt JSON both yield an empty store rather than throwing.
// Finds a single entry by id in a brain-dump store's entries array, or null if absent.
// A skip the classifier could fix on another pass (malformed JSON, off-taxonomy path,
// entry edited mid-flight, a project config gap). Bump the entry's sortAttempt and persist,
// so nextBrainDumpSortTask regenerates the sort under a fresh id (…-aN) instead of the
// entry being dead behind this task's own record in queue/done/. `recoverable: true` is
// also read by apply-task.js for the doneMarker wording.
// Shared apply for judgment-verdict-only task sources (observability_review, unused_export
// -- fix, 2026-07-26): neither ever produces a real code fix in this task (a genuine issue
// becomes a separate follow-up task, same as arch_discovery filing a candidate rather than
// fixing it immediately), so there is nothing to write and no branch to keep. Always
// {skipped: true}: apply-task.js's git-branch-diff flow treats that as a legitimate
// no-op-this-time outcome (abandons the branch it pre-created, marks the task done with
// `reason` as doneMarker) -- the exact same shape arch_discovery/arch_import already use
// for "nothing groundable/nothing to promote," not a failure path. Plain prose in,
// truncated for the doneMarker/log -- no JSON parsing, so a malformed or refusal-shaped
// response can't produce the "Invalid JSON in Group B implementResponse" apply-stage
// failure this fix exists to close.
function applyVerdictOnly({ implementResponse }) {
  const text = (implementResponse || '').trim();
  const reason = text.length > 0 ? text.slice(0, 500) : '(no verdict text returned)';
  return { skipped: true, reason };
}

// pipeline_forensics (2026-09-01): the implement pass wrote a RANKED root-cause report
// (advisoryProse -- no diff). Two passes:
//  1. First reach here (no task.forensicsReportConfirmedAt): NO CLEAR ROOT CAUSE -> clean
//     skip; otherwise hold at queue/awaiting-confirm/ so a human reads the analysis before
//     a pipeline-fix candidate is filed. `needsConfirmation` is the generic, non-source-
//     name-gated hold apply-task.js already maps to awaiting-confirm/.
//  2. Second reach (dashboard stamped forensicsReportConfirmedAt, task back in approved/):
//     extract the RECOMMENDED FOLLOW-UP FIX block (fix spec only -- Problem/Solution/
//     Benefits, kept lean so nextCandidateFulfillmentTask's 4000-char guard actually lets
//     it through) and append it to Docs/PIPELINE_FIX_CANDIDATES.md as a `### AC-NNN`
//     candidate, which the pipeline_forensics_fix source then turns into a real src/ diff.
function applyForensicsReport({ implementResponse, task }) {
  const { getConfig } = require('./config.js');
  const text = (implementResponse || '').trim();

  if (/^NO CLEAR ROOT CAUSE\b/m.test(text)) {
    return { skipped: true, reason: 'forensic study found no clear root cause; nothing filed' };
  }
  if (!task || !task.forensicsReportConfirmedAt) {
    return {
      succeeded: false,
      needsConfirmation: true,
      reason: 'forensic root-cause report -- held in queue/awaiting-confirm/ for human review before a pipeline-fix candidate is filed',
    };
  }

  const idx = text.search(/^RECOMMENDED FOLLOW-UP FIX\s*$/m);
  if (idx === -1) {
    return { skipped: true, reason: 'confirmed forensic report has no RECOMMENDED FOLLOW-UP FIX section; nothing to file' };
  }
  const section = text.slice(idx).replace(/^RECOMMENDED FOLLOW-UP FIX\s*$/m, '').trim();
  const files = (section.match(/^Files:\s*(.+)$/m) || [])[1] || '';
  const title = String(task.title || 'pipeline fix').replace(/^Pipeline forensics:\s*/i, '').slice(0, 100);
  const modelConfidence = (section.match(/^Strength:\s*(.+)$/m) || [])[1] || 'Worth exploring';

  // Strength is ALWAYS "Strong" here: nextCandidateFulfillmentTask (the pipeline_forensics_fix
  // consumer) only acts on Strong candidates, and every candidate filed from this path has
  // already cleared three gates -- the report's own "NO CLEAR ROOT CAUSE" escape hatch,
  // majority review APPROVE, and an explicit human confirm. The model's own less-certain
  // self-assessment is kept as a visible note, not as a silent block on consumption.
  //
  // The body is the FIX SPEC ONLY (Problem / Solution / Benefits) -- lean enough to clear
  // nextCandidateFulfillmentTask's MAX_ARCH_REVIEW_TASK_CHARS (4000) guard, which the old
  // "embed the whole ranked report for context" body blew past every time (confirmed live
  // 2026-09-01: AC-1/2/3 were all 4.4-6.7KB and silently never consumed). The full ranked
  // analysis stays on the forensic task's own record for a human who wants the deep context.
  const fixSpec = section.replace(/^Strength:.*$/m, '').replace(/^Files:.*$/m, '').trim();
  const body = [
    modelConfidence.trim() !== 'Strong' ? `Model confidence: ${modelConfidence.trim()}` : null,
    fixSpec,
    '',
    `Full ranked root-cause analysis: forensic task ${task.id}`,
  ].filter((l) => l !== null).join('\n');

  // Signature: line -- the pipeline_forensics_fix consumer lifts this into
  // promptContext.signature so apply-task.js's auto-drain can requeue the exact tasks this
  // study clustered once the fix lands (blocked-drain.js). task.promptContext.signature is
  // the same key signatureForClarificationTask derives for those tasks.
  const sig = (task.promptContext && task.promptContext.signature) || '';
  const block = [`### AC-1 · ${title}`, `Strength: Strong`, sig ? `Signature: ${sig}` : '', files ? `Files: ${files}` : '', '', body]
    .filter((l) => l !== null).join('\n');

  const res = applyArchDiscoveryCandidates({
    implementResponse: block,
    candidatesPath: getConfig().pipelineFixCandidatesPath,
    docTitle: '# Pipeline Fix Candidates',
  });
  if (res.skipped) return res;
  // Return res.file so apply-task.js's git-branch-diff flow stages the doc it just wrote
  // (`filesToAdd = [artifact.file]`) -- same shape arch_discovery's apply returns. Without
  // `file` here the flow ran `git add [undefined]` -> "pathspec 'undefined'". pipeline_
  // forensics is directToMain, so this append is committed straight to master.
  return { succeeded: true, file: res.file, doneMarker: `filed ${(res.candidateIds || []).join(', ')} to ${res.file}` };
}

// Extracts the NOW WHAT section's numbered items out of a confirmed debrief report, one
// {title, body} per item, for writeSideFindingInbox() below. Lenient by construction (same
// "drop malformed, never fail everything" discipline as candidate-docs.js's
// parseArchDiscoveryCandidates and side-finding.js's own extractSideFindings): a report
// missing the section (including the whole-response "NO CONFIDENT PATTERN" escape hatch,
// which never contains a "NOW WHAT" heading at all) simply yields no items, and an item not
// shaped like "<change> -- Files: ... Why: ..." still files fine, just with its whole text
// as both title and body rather than being dropped.
function parseDebriefNowWhatItems(text) {
  const idx = (text || '').search(/^NOW WHAT\s*$/m);
  if (idx === -1) return [];
  const section = text.slice(idx).replace(/^NOW WHAT\s*$/m, '').trim();
  if (!section) return [];

  return section.split(/(?=^\d+\.\s+)/m)
    .map((chunk) => chunk.replace(/^\d+\.\s+/, '').trim())
    .filter(Boolean)
    .slice(0, 5) // defensive cap -- the prompt itself already asks for at most 2-3
    .map((item) => {
      const sepIdx = item.indexOf(' -- ');
      const title = (sepIdx === -1 ? item : item.slice(0, sepIdx)).trim();
      const body = (sepIdx === -1 ? item : item.slice(sepIdx + 4)).trim() || title;
      return title ? { title: title.slice(0, 200), body: body.slice(0, 1000) } : null;
    })
    .filter(Boolean);
}

// pipeline_debrief (2026-09-06, see debrief-bundle.js): the implement pass wrote a
// What/So-What/Now-What report over a bounded window of queue/done/ tasks (advisoryProse --
// no diff). Two passes, same shape as applyForensicsReport right above:
//  1. First reach here (no task.debriefReportConfirmedAt): hold at queue/awaiting-confirm/
//     so a human reads the report before its window of done/ tasks is moved off done/'s top
//     level for good.
//  2. Second reach (dashboard stamped debriefReportConfirmedAt, task back in approved/):
//     archive exactly the window's task ids (task.promptContext.taskIds) into the same
//     queue/done/_archived/<YYYY-MM>/ bucket the time-based done-archive.js pass uses
//     (archiveSpecificDoneTasks) -- Grimmethy: "We'll have it archive the 'Done' tasks as
//     part of the process." A task id already gone (raced with the daily time-based pass,
//     or a human archived it by hand meanwhile) is not an error -- archiveSpecificDoneTasks
//     reports it as `missing`, same "already moved, nothing left to do" idempotency
//     archiveDoneTasks itself relies on.
//     THEN (2026-09-06, Grimmethy: "we already have our searches creating brain dumps full
//     of nitpicks... build the brain-dump route"): each NOW WHAT item is filed into
//     queue/side-findings-inbox/ via side-finding.js's writeSideFindingInbox() -- the exact
//     same channel the day's concept-research forks already use -- for side-finding-
//     sweep.js to drain into brain-dump.json (dedup'd against prior debrief findings,
//     since it carries a real `raisedBy`) and from there through the EXISTING
//     brain_dump_sort classifier. Deliberately NOT the pipeline_forensics AC-NNN
//     candidate-doc route: a Now-What item isn't always a scoped diff spec (sometimes it's
//     "source X is unusually cheap, worth noting"), and brain_dump_sort already knows how
//     to split "this is a real scoped idea" (-> adhoc) from "this is a pattern worth
//     remembering" (-> secondbrain) -- reusing it here means a well-formed Now-What
//     recommendation ends up drafted as a real task the same way "Design Option A" (this
//     very feature) did, instead of evaporating once its report is archived.
function applyDebriefReport({ implementResponse, task }) {
  const { archiveSpecificDoneTasks } = require('./done-archive.js');
  const { writeSideFindingInbox } = require('./side-finding.js');
  const { getConfig } = require('./config.js');
  const text = (implementResponse || '').trim();

  if (!text) {
    return { skipped: true, reason: 'debrief report came back empty; nothing to hold or archive' };
  }
  if (!task || !task.debriefReportConfirmedAt) {
    return {
      succeeded: false,
      needsConfirmation: true,
      reason: 'pipeline debrief report -- held in queue/awaiting-confirm/ for human review before its window of done/ tasks is archived',
    };
  }

  const taskIds = (task.promptContext && Array.isArray(task.promptContext.taskIds)) ? task.promptContext.taskIds : [];
  if (!taskIds.length) {
    return { skipped: true, reason: 'confirmed debrief report has no promptContext.taskIds -- nothing to archive' };
  }
  const { pipelineDir } = getConfig();
  const result = archiveSpecificDoneTasks({ pipelineDir, taskIds });

  const nowWhatItems = parseDebriefNowWhatItems(text);
  for (const item of nowWhatItems) {
    writeSideFindingInbox(item, {
      source: 'pipeline_debrief', taskId: task.id, stage: 'now-what', pipelineDir,
    });
  }

  // {skipped: true} (never {succeeded: true} with no `file`) -- this apply never touches
  // the tracked repo's git state at all (it only moves task JSON files under pipelineDir),
  // same shape as applyVerdictOnly right above: apply-task.js's git-branch-diff flow reads
  // `artifact.skipped` BEFORE it ever requires `artifact.file`/`artifact.files` (see its own
  // "artifact.skipped" branch), where a bare {succeeded: true, doneMarker} with no file
  // would instead reach `gitRunner.add([artifact.file])` as `git add [undefined]` and throw.
  return {
    skipped: true,
    reason: `debriefed ${taskIds.length} task(s); archived ${result.moved}, already-moved ${result.missing}${result.errors.length ? `, ${result.errors.length} error(s): ${result.errors.join('; ')}` : ''}; filed ${nowWhatItems.length} Now-What finding(s) to the brain-dump inbox`,
  };
}

// Parses path_prefetch_resolve's implement-pass output -- a single JSON object (see
// prompts.js's pathPrefetchResolveImplementPrompt for the exact schema):
//   { "paths": ["..."], "rationale": "...", "confident": true/false }
// paths may legitimately be empty (the model genuinely couldn't find a match either) --
// rationale/confident are still meaningful in that case, telling the human WHY, same
// value as a "genuinely uncertain" verdict elsewhere in this file.
function parsePathPrefetchResolveResult(implementResponse) {
  const text = (implementResponse || '').trim();
  if (!text) return null;
  let parsed;
  try {
    parsed = parseJsonMaybeFenced(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (!('paths' in parsed)) return null;
  return {
    paths: Array.isArray(parsed.paths) ? parsed.paths.map(String).filter(Boolean) : [],
    rationale: parsed.rationale ? String(parsed.rationale).trim() : '',
    confident: !!parsed.confident,
  };
}

// Writes the LLM's suggestion back onto the ORIGINAL held task in
// queue/needs-clarification/. A non-confident guess stops there -- resolving it stays a
// deliberate human action via the dashboard's clarification picker/resolve endpoint, same
// fail-safe property path-prefetch.js's deterministic pass already has (never silently
// prefetch the wrong file). A CONFIDENT suggestion (2026-08-16) auto-resolves straight
// into queue/adhoc/ instead, off the Needs Clarification list entirely -- see the
// confident-branch below for why. Marks suggestionAttempted regardless of parse success,
// so nextPathPrefetchResolveTask() never re-spends a model call on a held task whose
// implement response came back malformed -- manual resolution is still always available
// either way.
function applyPathPrefetchResolve({ implementResponse, task, pipelineDir }) {
  const heldTaskId = task.promptContext && task.promptContext.heldTaskId;
  if (!heldTaskId) {
    return { skipped: true, reason: 'task has no heldTaskId in promptContext -- cannot locate the task it was meant to resolve' };
  }
  const heldPath = path.join(pipelineDir, 'queue', 'needs-clarification', `${heldTaskId}.json`);
  let held;
  try {
    held = JSON.parse(fs.readFileSync(heldPath, 'utf8'));
  } catch {
    return { skipped: true, reason: `held task '${heldTaskId}' no longer exists in queue/needs-clarification/ (already resolved or rejected since this task was drafted)` };
  }
  if (!held.needsClarification) {
    return { skipped: true, reason: `held task '${heldTaskId}' no longer has needsClarification set -- already resolved` };
  }

  const result = parsePathPrefetchResolveResult(implementResponse);
  // Brain Dump #77: which flag gets marked depends on which tier just ran -- the
  // low-reasoning first attempt sets suggestionAttempted (as before); the automatic
  // high-reasoning retry (task.reasoningTier === 'high', set by
  // nextPathPrefetchResolveTask()) sets highReasoningAttempted instead, so
  // nextPathPrefetchResolveTask()'s eligibility gate can tell the two apart and only
  // require a human once BOTH tiers have been spent.
  // Brain Dump (2026-08-18): a periodic reattempt (task-sources.js's
  // nextPathPrefetchResolveTask, once both automatic tiers are spent) doesn't touch
  // suggestionAttempted/highReasoningAttempted -- both are already true by the time this
  // tier fires. Advances its OWN counter/timestamp instead, which is what the periodic
  // eligibility check reads to know when the next round is due.
  if (task.promptContext && task.promptContext.periodicReattempt) {
    held.needsClarification.lastPeriodicReattemptAt = new Date().toISOString();
    held.needsClarification.periodicReattemptCount = (held.needsClarification.periodicReattemptCount || 0) + 1;
  } else if (task.reasoningTier === 'high') {
    held.needsClarification.highReasoningAttempted = true;
  } else {
    held.needsClarification.suggestionAttempted = true;
  }
  if (result) {
    held.needsClarification.suggested = {
      paths: result.paths,
      rationale: result.rationale,
      confident: result.confident,
      suggestedAt: new Date().toISOString(),
    };
  }

  // Auto-resolve straight into queue/adhoc/ (off the Needs Clarification list entirely)
  // when the suggestion is confident -- per the actual ask (2026-08-16): ending a Discuss
  // session should be enough by itself to close a held task out, not require yet another
  // manual click on top of whatever context the human just supplied, PROVIDED the model's
  // own confidence flag says it's sure. A non-confident guess still lands as `suggested`
  // for the picker UI and requires the human's own Accept Suggestion/manual-path/Proceed
  // click, same as before -- auto-applying a guess the model itself flagged as uncertain
  // would defeat the "never auto-applied" premise this feature shipped with; this only
  // narrows that to "never auto-applied unless the model itself is confident."
  if (result && result.confident && result.paths && result.paths.length) {
    const adhocDir = path.join(pipelineDir, 'queue', 'adhoc');
    fs.mkdirSync(adhocDir, { recursive: true });
    const adhocPath = path.join(adhocDir, `${heldTaskId}.json`);
    if (!fs.existsSync(adhocPath)) {
      held.promptContext = held.promptContext || {};
      held.promptContext.prefetchedPaths = result.paths;
      delete held.needsClarification;
      writeJsonAtomicSync(adhocPath, held);
      fs.unlinkSync(heldPath);
      return { autoResolved: true, heldTaskId, paths: result.paths };
    }
    // adhoc/ already has this id (raced with a manual resolve?) -- fall through to the
    // normal "leave in needs-clarification, marked attempted/suggested" path below rather
    // than clobbering or erroring, same non-fatal-skip convention as everywhere else here.
  }

  writeJsonAtomicSync(heldPath, held);

  return result
    ? { suggested: true, heldTaskId, paths: result.paths, confident: result.confident }
    : { skipped: true, reason: 'implement pass did not return a valid suggestion -- held task marked attempted, left for manual resolution' };
}

// Writes a research task's write-up into SecondBrain, once a human has confirmed it via
// queue/awaiting-confirm/ (see apply-task.js's own gate for research tasks, mirroring the
// existing adhoc-diff confirm gate). Registered as research_task's `apply` in
// task-sources.js -- reached only after the confirm gate has already passed, same
// ordering as applyAdhocDiff's own git-apply step.
function applyResearchTask({ task, secondBrainDir }) {
  const researchDoc = (task && task.researchDoc) || '';
  if (!researchDoc.trim()) {
    return { skipped: true, reason: 'task has no researchDoc -- nothing to file (should not normally be reachable, the confirm gate requires a non-empty researchDoc)' };
  }
  const secondBrainPath = task.promptContext && task.promptContext.secondBrainPath;
  if (!secondBrainPath) {
    return { skipped: true, reason: 'task has no promptContext.secondBrainPath -- do not know where to file this research' };
  }
  if (!secondBrainDir) {
    return { skipped: true, reason: 'SECOND_BRAIN_DIR is not configured -- cannot file this research anywhere' };
  }
  const namingError = validateSecondBrainPath(secondBrainPath, secondBrainDir);
  if (namingError) {
    return { skipped: true, reason: `rejected secondBrainPath "${secondBrainPath}": ${namingError}` };
  }

  const fullPath = path.join(secondBrainDir, secondBrainPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  appendMarkdownLineAtomic(fullPath, `\n## Research -- ${stamp}\n\n${researchDoc}\n`);

  return { file: fullPath };
}

// Auto-closes a Brain Dump entry once agent-manager itself has actually resolved it
// (Brain Dump #67) -- productionizes the exact manual step (hand-editing brain-dump.json
// via a one-off script) a human/Claude session had been doing after every real fix this
// pipeline made to its own repo. Called from apply-task.js after a successful adhoc
// commit+push, AND from applyAdhocDiff's own {skipped} no-change-needed outcome (see
// apply-adhoc-diff.js) -- either way, "resolved" here means the agentic implement pass
// (adhoc-agentic-draft.js) already decided the entry's underlying request is done, not
// that code necessarily changed.
//
// Best-effort like applyBrainDumpSort above: a missing/already-mutated entry is not an
// error, just nothing to close (the entry may have been deleted or hand-edited since
// this task was drafted).
module.exports = {
  applySecondBrainNote,
  applyProjectSearchFindings,
  parseProjectSearchFindings,
  applyDeepDiveFindings,
  parseDeepDiveItems,
  applyArchDiscoveryCandidates,
  parseArchDiscoveryCandidates,
  isEffectivelyEmptyResponse,
  applyBrainDumpSort,
  applyVerdictOnly,
  applyForensicsReport,
  applyDebriefReport,
  parseDebriefNowWhatItems,
  parseBrainDumpSortResult,
  validateSecondBrainPath,
  normalizeSecondBrainPathCase,
  applyPathPrefetchResolve,
  parsePathPrefetchResolveResult,
  closeBrainDumpEntryResolved,
  applyResearchTask,
  loadBrainDump,
};
