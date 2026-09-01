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
const { resolveAnchors } = require('./path-prefetch.js');
const { resolveGraphPath } = require('./config.js');
const { writeAtomicSync, writeJsonAtomicSync } = require('./atomic-write.js');

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
    const m = block.match(new RegExp(`^${name}:\\s*(.+)$`, 'mi'));
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
    const m = block.match(new RegExp(`^${name}:\\s*(.+)$`, 'mi'));
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
  } catch {
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

// Parses brain_dump_sort's implement-pass output -- a single JSON object, not markdown
// (see prompts.js's brainDumpSortImplementPrompt for the exact schema this must match).
// Returns null on anything unparseable or missing a required field, rather than throwing
// -- applyBrainDumpSort treats null as "leave the entry as captured, retry next tick,"
// same non-fatal-skip convention every other Group A parser here uses for malformed
// output.
function parseBrainDumpSortResult(implementResponse) {
  const text = (implementResponse || '').trim();
  if (!text) return null;
  let parsed;
  try {
    // Was a bare JSON.parse(text) -- threw on the extremely common case of the local model wrapping
    // its output in a ```json fence despite the prompt asking for none, silently swallowed
    // by the catch below, leaving the entry stuck as 'captured' forever with no automatic
    // retry. Confirmed live 2026-07-26 on a fully-approved (3/3 APPROVE) classification for
    // the "job status blocked -- need archive/requeue button" entry: real, valid JSON, just
    // fenced, parsed successfully by apply-group-b.js's identical case via this same helper
    // but never applied here because parseBrainDumpSortResult had its own unfenced JSON.parse
    // instead of reusing it.
    parsed = parseJsonMaybeFenced(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (!parsed.category || !parsed.secondBrainPath) return null;
  return {
    category: String(parsed.category).trim(),
    // Strip a leading slash -- path.join(secondBrainDir, '/Projects/foo.md') still resolves
    // relative to secondBrainDir on Node/POSIX, but on some platforms an absolute-looking
    // second segment can behave surprisingly; normalizing here removes the ambiguity rather
    // than relying on path.join's platform-specific handling.
    secondBrainPath: String(parsed.secondBrainPath).replace(/^[/\\]+/, '').trim(),
    tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
    actionable: !!parsed.actionable,
    rationale: parsed.rationale ? String(parsed.rationale).trim() : '',
    belongsToProject: parsed.belongsToProject ? String(parsed.belongsToProject).trim() : null,
    requiresResearch: !!parsed.requiresResearch,
    // 2026-08-24 (pipeline hardening, Grimmethy: "duplicate-task detection before
    // filing") -- the classifier is shown a list of already-queued task titles and
    // asked to flag a near-duplicate here; null/absent means it saw nothing similar.
    possibleDuplicateOf: parsed.possibleDuplicateOf ? String(parsed.possibleDuplicateOf).trim() : null,
  };
}

// Bare, undifferentiated filenames that give no hint what the note is actually about --
// confirmed live 2026-08-16: the local model filed a real note (a feature idea about brain-dump
// job context) under plain "ideas.md", indistinguishable at a glance from any other idea
// ever captured. Checked against the FINAL path segment's stem only (no extension) --
// a folder named e.g. "Ideas/" is fine (that's a category), a FILE named "ideas.md" is
// not (that's the note's own name doing zero work). Deliberately short: this is a floor
// against the worst offenders, not a style guide -- most bad names won't match this list
// and are expected to be caught by prompts.js's instructions instead.
const GENERIC_FILENAME_BLOCKLIST = new Set([
  'ideas', 'idea', 'notes', 'note', 'misc', 'miscellaneous', 'stuff', 'todo', 'todos',
  'random', 'general', 'other', 'things', 'inbox', 'info', 'information', 'data', 'new',
  'untitled', 'temp', 'draft', 'journal', 'log',
]);

// Rejects a proposed secondBrainPath outright (returns a reason string) rather than
// silently accepting it -- applyBrainDumpSort treats a rejection the same as unparseable
// JSON (entry left as 'captured', retried next tick with a fresh model call), so a bad
// name never actually lands on disk. Two checks, both about names actively working
// against future retrieval rather than style preference:
//   1. the file's own basename is a bare generic word (see blocklist above) -- a name
//      that describes nothing beyond "this is a note".
//   2. the top-level folder is a different-case duplicate of one that already exists --
//      the exact bug that produced both "Projects/" and "projects/" in this vault
//      (confirmed live 2026-08-16), silently splitting one category across two folders
//      that look identical to a human skimming the sidebar.
// Returns null when the path is fine.
function validateSecondBrainPath(relPath, secondBrainDir) {
  const segments = relPath.split(/[\\/]/).filter(Boolean);
  if (segments.length === 0) return 'secondBrainPath is empty';

  const baseName = segments[segments.length - 1];
  const stem = baseName.replace(/\.[^./]+$/, '').toLowerCase().trim();
  if (GENERIC_FILENAME_BLOCKLIST.has(stem)) {
    return `filename "${baseName}" is too generic to find again later -- name it after the actual subject of the note (e.g. "ebay-cross-post-automation.md", not "ideas.md")`;
  }

  if (segments.length > 1 && secondBrainDir) {
    const topLevel = segments[0];
    let existingNames;
    try {
      existingNames = fs.readdirSync(secondBrainDir, { withFileTypes: true })
        .filter((e) => !e.name.startsWith('.'))
        .map((e) => e.name);
    } catch {
      existingNames = [];
    }
    const conflict = existingNames.find((name) => name.toLowerCase() === topLevel.toLowerCase() && name !== topLevel);
    if (conflict) {
      return `top-level folder "${topLevel}" is a different-case duplicate of the existing "${conflict}" -- reuse "${conflict}" exactly (same capitalization)`;
    }
  }

  return null;
}

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
function appendMarkdownLineAtomic(fullPath, line) {
  const existing = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf8') : null;
  const contents = existing !== null
    ? existing + line
    : `# ${path.basename(fullPath, path.extname(fullPath))}\n${line}`;
  writeAtomicSync(fullPath, contents);
}

// Loads the brain-dump JSON store from disk, returning a normalized { entries: Array } object.
// A missing file or corrupt JSON both yield an empty store rather than throwing.
function loadBrainDump(filePath) {
  let data;
  try {
    data = JSON.parse(fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '{"entries":[]}');
  } catch {
    data = { entries: [] };
  }
  if (!Array.isArray(data.entries)) data.entries = [];
  return data;
}

// Finds a single entry by id in a brain-dump store's entries array, or null if absent.
function findEntry(data, entryId) {
  return data.entries.find((e) => e && e.id === entryId) || null;
}

function applyBrainDumpSort({ implementResponse, task, brainDumpPath, secondBrainDir, pipelineDir }) {
  const { brainDumpEntryId, rawText } = task.promptContext;

  const data = loadBrainDump(brainDumpPath);

  const entry = findEntry(data, brainDumpEntryId);
  if (!entry) {
    return { skipped: true, reason: `brain-dump entry "${brainDumpEntryId}" no longer exists (deleted since this task was drafted)` };
  }
  // The entry may have been edited (the dashboard's PUT resets status back to 'captured' on
  // a text change) or otherwise changed since this task was drafted -- classifying stale
  // text into the entry's CURRENT record would silently mislabel it under a rawText it no
  // longer has. Only apply if the entry is still exactly what this task was drafted against.
  if (entry.status !== 'captured' || entry.rawText !== rawText) {
    return { skipped: true, reason: 'brain-dump entry changed since this task was drafted -- not applying a stale classification' };
  }

  const result = parseBrainDumpSortResult(implementResponse);
  if (!result) {
    return { skipped: true, reason: 'implement pass did not return a valid classification -- entry left as captured for retry' };
  }
  if (!secondBrainDir) {
    return { skipped: true, reason: 'SECOND_BRAIN_DIR is not configured -- cannot file this entry anywhere' };
  }

  const namingError = validateSecondBrainPath(result.secondBrainPath, secondBrainDir);
  if (namingError) {
    return { skipped: true, reason: `rejected secondBrainPath "${result.secondBrainPath}": ${namingError} -- entry left as captured for retry` };
  }

  // Brain Dump #1 follow-up (2026-08-17): a note can be actionable WITHOUT being a code
  // change -- "investigate X, document findings" needs real web research, not a diff
  // against any tracked project. Checked before matchedProject below since the two
  // outcomes are mutually exclusive (the classifier prompt already tells the model never
  // to set both), and a research task has nothing to do with belongsToProject at all.
  if (result.requiresResearch) {
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

    return { file: fullPath, category: result.category, queuedTaskId: queuedId, researchQueued: true };
  }

  const matchedProject = result.actionable && result.belongsToProject
    ? readProjectRegistry().find((p) => p.label === result.belongsToProject)
    : null;

  if (matchedProject) {
    const validDomains = (() => {
      try {
        return Object.keys(JSON.parse(fs.readFileSync(matchedProject.domainsPath, 'utf8')));
      } catch {
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

      return { file: path.join(adhocDir, `${queuedId}.json`), category: result.category, queuedTaskId: queuedId, queuedProject: matchedProject.label };
    }
    // Falls through to the plain-note path below if the matched project has no 'adhoc'
    // domain registered -- same non-fatal-skip convention as everything else here, rather
    // than blocking the whole task over a config gap in a DIFFERENT project.
  }

  const fullPath = path.join(secondBrainDir, result.secondBrainPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const tagsSuffix = result.tags.length ? ` _(${result.tags.join(', ')})_` : '';
  const line = `\n- **${stamp}** ${rawText}${tagsSuffix}\n`;
  appendMarkdownLineAtomic(fullPath, line);

  entry.status = 'sorted';
  entry.sort = {
    category: result.category,
    secondBrainPath: result.secondBrainPath,
    tags: result.tags,
    actionable: result.actionable,
    rationale: result.rationale,
  };
  entry.sortedAt = new Date().toISOString();

  fs.mkdirSync(path.dirname(brainDumpPath), { recursive: true });
  writeJsonAtomicSync(brainDumpPath, data);

  return { file: fullPath, category: result.category };
}

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
//     extract the RECOMMENDED FOLLOW-UP FIX block and append it -- with the full ranked
//     report as context -- to Docs/PIPELINE_FIX_CANDIDATES.md as a `### AC-NNN` candidate,
//     which the pipeline_forensics_fix source then turns into a real src/ diff.
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
  const strength = (section.match(/^Strength:\s*(.+)$/m) || [])[1] || 'Worth exploring';
  const files = (section.match(/^Files:\s*(.+)$/m) || [])[1] || '';
  const title = String(task.title || 'pipeline fix').replace(/^Pipeline forensics:\s*/i, '').slice(0, 100);

  // Body carries the full ranked report so the fix pass sees the whole analysis, not just
  // the one-paragraph Solution.
  const body = [
    section.replace(/^Strength:.*$/m, '').replace(/^Files:.*$/m, '').trim(),
    '',
    '--- full forensic report ---',
    text.slice(0, idx).trim(),
  ].join('\n');

  const block = [`### AC-1 · ${title}`, `Strength: ${strength}`, files ? `Files: ${files}` : '', '', body]
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
  parseBrainDumpSortResult,
  validateSecondBrainPath,
  applyPathPrefetchResolve,
  parsePathPrefetchResolveResult,
  closeBrainDumpEntryResolved,
  applyResearchTask,
};
