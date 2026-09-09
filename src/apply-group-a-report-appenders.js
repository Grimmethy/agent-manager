'use strict';

// apply-group-a-report-appenders.js -- extracted from src/apply-group-a.js ([[hub-task-integration]] node-module decompose).

const fs = require('fs');
const path = require('path');
const { writeAtomicSync, writeJsonAtomicSync } = require('./atomic-write.js');
const {
  isEffectivelyEmptyResponse,
  parseArchDiscoveryCandidates,
  applyArchDiscoveryCandidates,
} = require('./candidate-docs.js');

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

module.exports = { parseProjectSearchFindings, applyProjectSearchFindings, parseDeepDiveItems, applyDeepDiveFindings, applyForensicsReport, parseDebriefNowWhatItems, applyDebriefReport };
