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

function applySecondBrainNote({ implementResponse, notePath, secondBrainDir }) {
  const resolvedPath = path.isAbsolute(notePath) ? notePath : path.join(secondBrainDir, notePath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.writeFileSync(resolvedPath, implementResponse || '');

  const markerPath = resolvedPath + '.done';
  fs.writeFileSync(markerPath, '');

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
  fs.writeFileSync(indexPath, indexText);

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
  fs.writeFileSync(coveragePath, JSON.stringify(coverage, null, 2));

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
  fs.writeFileSync(analysisPath, analysisText);

  return { file: analysisPath, itemCount: items.length };
}

// Parses arch_discovery's AND arch_import's implement-pass output (see prompts.js's
// archDiscoveryImplementPrompt / archImportImplementPrompt for the exact
// "### AC-NNN · Title" format both must match) into candidate objects, one per "### AC-"
// heading. arch_import's blocks additionally carry a "Source:" line (provenance back to
// the external project + deep_dive item this was promoted from) -- optional here since
// arch_discovery's own candidates never have one; harmless to look for either way, same
// as Strength:/Files: already being optional-with-fallback below. Deliberately does NOT
// trust the AC-NNN number Ornith picked -- applyArchDiscoveryCandidates re-derives it
// below instead (see that function's comment).
//
// Lenient on the AC-NNN/title separator specifically: replaying the two real
// arch_discovery tasks that failed apply live (2026-07-21) showed Ornith reliably drops
// the "·" the prompt asks for ("### AC-042 Extract Git..." with a plain space, not
// "### AC-042 · Extract Git...") -- a strict match here would have silently produced ZERO
// candidates from real-world output, not an error, which is worse (looks like a clean "no
// friction found" run instead of a parse failure). Accepting a few common separators (or
// none) on READ, while still always WRITING the canonical "· " format below, keeps
// nextArchReviewTask()'s own strict reader (task-sources.js) untouched and correct --
// normalize inconsistency at this one boundary instead of loosening every downstream
// consumer to match Ornith's inconsistency.
// A response that's just a JSON-style empty-string LITERAL (`""` or `''`, two characters)
// is Ornith representing "intentionally nothing" the same way `""` reads in code -- not
// gibberish, not a malformed candidate. Confirmed live 2026-07-21: 4 of 6 arch_import
// "structural check failed" blocks were exactly this, the model correctly following the
// implement prompt's "output the empty string and nothing else" instruction, just typing
// out the literal representation instead of a truly empty string. `.trim()` alone doesn't
// catch this (quote characters aren't whitespace) -- exported so
// arch-discovery-structcheck.js's own emptiness check uses the identical rule, not a
// second copy that could drift.
function isEffectivelyEmptyResponse(text) {
  const t = (text || '').trim();
  return t === '' || t === '""' || t === "''";
}

function parseArchDiscoveryCandidates(implementResponse) {
  const text = (implementResponse || '').trim();
  if (isEffectivelyEmptyResponse(text)) return [];
  const blocks = text.split(/(?=^#{1,6}\s*AC-\d+)/m).map((b) => b.trim()).filter(Boolean);
  return blocks
    .map((block) => {
      const headingLine = block.split('\n')[0];
      const titleMatch = headingLine.match(/AC-\d+\s*(?:[·:—-]\s*)?(.+)/);
      if (!titleMatch) return null;
      const strengthMatch = block.match(/^Strength:\s*(.+)$/m);
      const sourceMatch = block.match(/^Source:\s*(.+)$/m);
      const filesMatch = block.match(/^Files:\s*(.+)$/m);
      // Body is everything after the LAST metadata line present (Files:, else Source:,
      // else the heading) -- the Problem/Solution/Benefits paragraphs, kept verbatim.
      const bodyAnchor = filesMatch ? filesMatch[0] : sourceMatch ? sourceMatch[0] : headingLine;
      const anchorIdx = block.indexOf(bodyAnchor);
      const body = block.slice(anchorIdx + bodyAnchor.length).trim();
      return {
        title: titleMatch[1].trim(),
        strength: strengthMatch ? strengthMatch[1].trim() : 'Strong',
        source: sourceMatch ? sourceMatch[1].trim() : '',
        files: filesMatch ? filesMatch[1].trim() : '',
        body,
      };
    })
    .filter((c) => c && c.title && c.body);
}

function nextAvailableCandidateId(existingText) {
  let max = 0;
  for (const m of (existingText || '').matchAll(/AC-(\d+)/g)) {
    const n = parseInt(m[1], 10);
    if (n > max) max = n;
  }
  return max + 1;
}

// Appends one community's candidate write-up(s) to the project's architecture-candidates
// doc (AGENT_MANAGER_ARCH_CANDIDATES_PATH), which nextArchReviewTask() (task-sources.js)
// re-parses later looking for "### AC-NNN · Title" / "Strength: Strong" / "Files: ..." --
// these two functions' expectations of the format must stay in sync.
//
// Re-derives each candidate's AC-NNN id from the doc's own current max, instead of
// trusting the id Ornith wrote in its markdown. archDiscoveryImplementPrompt only asks it
// to avoid colliding with IDs visible in its OWN plan-time context (one community's worth
// of "candidates already proposed for other communities"), which is a real, observed
// collision source, not hypothetical: two communities drafted around the same time, or a
// plan run before an earlier same-day candidate had actually landed in the doc yet. A
// collision here would silently corrupt arch_review's downstream `AC-\d+`-keyed dedup
// (two different candidates both claiming `arch-review-ac-042` -- the second is silently
// dropped as "already in queue"). Assigned sequentially against the text as it grows
// within this same call, so multiple candidates in one implementResponse never collide
// with each other either.
function applyArchDiscoveryCandidates({ implementResponse, candidatesPath, docTitle = '# Architecture Review Candidates' }) {
  const candidates = parseArchDiscoveryCandidates(implementResponse);
  if (candidates.length === 0) {
    return { skipped: true, reason: 'no candidates in implement response -- nothing to apply' };
  }

  let text = fs.existsSync(candidatesPath) ? fs.readFileSync(candidatesPath, 'utf8') : `${docTitle}\n`;

  const candidateIds = [];
  for (const c of candidates) {
    const id = `AC-${nextAvailableCandidateId(text)}`;
    const lines = [`### ${id} · ${c.title}`, `Strength: ${c.strength}`];
    if (c.source) lines.push(`Source: ${c.source}`);
    if (c.files) lines.push(`Files: ${c.files}`);
    lines.push('', c.body);
    text += '\n' + lines.join('\n') + '\n';
    candidateIds.push(id);
  }

  fs.mkdirSync(path.dirname(candidatesPath), { recursive: true });
  fs.writeFileSync(candidatesPath, text);

  return { file: candidatesPath, candidateCount: candidates.length, candidateIds };
}

// arch_import's apply step (ADR-0020): wraps applyArchDiscoveryCandidates (same
// markdown-candidate append it already does for arch_discovery, since the format is
// byte-compatible modulo the Source: line) with the one extra thing arch_import needs
// that arch_discovery doesn't -- stamping import-coverage.json's item entry as promoted,
// same "mark the source state so it's never re-offered" convention
// applyDeepDiveFindings already uses for deep-dive-coverage.json.
function applyArchImportCandidate({ implementResponse, candidatesPath, importCoveragePath, task }) {
  const { itemId, sourceProject } = task.promptContext;

  const result = applyArchDiscoveryCandidates({ implementResponse, candidatesPath, docTitle: '# Architecture Import Candidates' });

  let coverage;
  try {
    coverage = JSON.parse(fs.existsSync(importCoveragePath) ? fs.readFileSync(importCoveragePath, 'utf8') : '{"items":{}}');
  } catch {
    coverage = { items: {} };
  }
  if (!coverage.items) coverage.items = {};
  const nowIso = new Date().toISOString();
  coverage.items[itemId] = {
    // Was unconditional (promotedAt stamped even when result.skipped) -- confirmed live
    // 2026-07-26: 134/134 "promoted" items had candidateId:null, ARCH_IMPORT_CANDIDATES.md
    // never even existed, and nextArchImportTask()'s `if (promotedAt) continue` treated
    // every one as permanently done. A zero-harness-grounding skip (the documented COMMON
    // case, see ornith-worker.ps1's $skipImplement comment -- 10/14 in the original sample)
    // is NOT the same as "genuinely evaluated, doesn't fit" -- agent-manager's own codebase
    // keeps growing, so a query with zero hits today can have a real hit next week. Only a
    // REAL candidate (result.skipped === false) is a terminal outcome now; a skip just
    // records lastAttemptedAt so nextArchImportTask() can retry it later instead of never.
    promotedAt: result.skipped ? (coverage.items[itemId]?.promotedAt ?? null) : nowIso,
    candidateId: result.skipped ? (coverage.items[itemId]?.candidateId ?? null) : result.candidateIds[0],
    lastAttemptedAt: nowIso,
    projectSlug: sourceProject,
  };
  fs.mkdirSync(path.dirname(importCoveragePath), { recursive: true });
  fs.writeFileSync(importCoveragePath, JSON.stringify(coverage, null, 2));

  // Same shape applyArchDiscoveryCandidates already returns ({skipped,reason} or
  // {file,candidateCount,candidateIds}) -- apply-task.js's generic writeArtifact() flow
  // already knows how to handle both, no extra wrapping needed here.
  return result;
}

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
    // Was a bare JSON.parse(text) -- threw on the extremely common case of Ornith wrapping
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
  };
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
function readProjectRegistry() {
  const registryPath = path.join(__dirname, '..', 'projects.json');
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
function applyBrainDumpSort({ implementResponse, task, brainDumpPath, secondBrainDir }) {
  const { brainDumpEntryId, rawText } = task.promptContext;

  let data;
  try {
    data = JSON.parse(fs.existsSync(brainDumpPath) ? fs.readFileSync(brainDumpPath, 'utf8') : '{"entries":[]}');
  } catch {
    data = { entries: [] };
  }
  if (!Array.isArray(data.entries)) data.entries = [];

  const entry = data.entries.find((e) => e && e.id === brainDumpEntryId);
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
      const adhocDir = path.join(matchedProject.pipelineDir, 'queue', 'adhoc');
      fs.mkdirSync(adhocDir, { recursive: true });
      const adhocTask = {
        id: queuedId,
        domain: 'adhoc',
        source: 'brain_dump',
        title: rawText.slice(0, 120),
        promptContext: { rawText, brainDumpEntryId },
      };
      fs.writeFileSync(path.join(adhocDir, `${queuedId}.json`), JSON.stringify(adhocTask, null, 2));

      // Cross-reference note -- an audit trail, not the record of truth (brain-dump.json's
      // queuedTaskId/queuedAt is that): confirms this entry was routed as real work, not
      // silently dropped, findable the same way every other filed note is.
      const fullPath = path.join(secondBrainDir, result.secondBrainPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      const stamp = new Date().toISOString().slice(0, 10);
      const line = `\n- **${stamp}** Queued as adhoc task \`${queuedId}\` in **${matchedProject.label}** -- ${rawText}\n`;
      if (fs.existsSync(fullPath)) {
        fs.appendFileSync(fullPath, line);
      } else {
        const title = path.basename(result.secondBrainPath, path.extname(result.secondBrainPath));
        fs.writeFileSync(fullPath, `# ${title}\n${line}`);
      }

      entry.status = 'actioned';
      entry.queuedTaskId = queuedId;
      entry.queuedAt = new Date().toISOString();
      fs.mkdirSync(path.dirname(brainDumpPath), { recursive: true });
      fs.writeFileSync(brainDumpPath, JSON.stringify(data, null, 2));

      return { file: fullPath, category: result.category, queuedTaskId: queuedId, queuedProject: matchedProject.label };
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
  if (fs.existsSync(fullPath)) {
    fs.appendFileSync(fullPath, line);
  } else {
    const title = path.basename(result.secondBrainPath, path.extname(result.secondBrainPath));
    fs.writeFileSync(fullPath, `# ${title}\n${line}`);
  }

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
  fs.writeFileSync(brainDumpPath, JSON.stringify(data, null, 2));

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

module.exports = {
  applySecondBrainNote,
  applyProjectSearchFindings,
  parseProjectSearchFindings,
  applyDeepDiveFindings,
  parseDeepDiveItems,
  applyArchDiscoveryCandidates,
  parseArchDiscoveryCandidates,
  applyArchImportCandidate,
  isEffectivelyEmptyResponse,
  applyBrainDumpSort,
  applyVerdictOnly,
  parseBrainDumpSortResult,
};
