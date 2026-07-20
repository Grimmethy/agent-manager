'use strict';

// Deterministic (no-LLM) writers for "Group A" task sources -- ones whose implement draft
// is already a literal artifact (a vault note to save, etc.), not a prose description of a
// change or grammar-constrained JSON. Part of removing an LLM from the apply step entirely
// -- see apply-task.js, which calls this after a task has already been reviewed and approved.
//
// Only the fully generic writer lives here. Project-specific Group A writers (e.g. a
// county-index-file writer, a markdown-candidate-appender) belong in the CONSUMING
// project's own registration file and get wired in via updateTaskSource(name, { apply })
// exactly like this package's own arch_review/trouble_log/adhoc sources use the Group B
// default -- see README.md "Registering a custom apply function".

const fs = require('fs');
const path = require('path');

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
    const lines = [`## ${it.title}`, '', `**Community:** ${it.community || communityName}`, `**Rating:** ${it.rating || '(unrated)'}`];
    if (it.files) lines.push(`**Files:** ${it.files}`);
    lines.push('', it.rationale);
    return lines.join('\n');
  });

  analysisText += '\n' + sections.join('\n\n') + '\n';

  fs.mkdirSync(analysisDir, { recursive: true });
  fs.writeFileSync(analysisPath, analysisText);

  return { file: analysisPath, itemCount: items.length };
}

module.exports = {
  applySecondBrainNote,
  applyProjectSearchFindings,
  parseProjectSearchFindings,
  applyDeepDiveFindings,
  parseDeepDiveItems,
};
