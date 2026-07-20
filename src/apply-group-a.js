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

module.exports = { applySecondBrainNote, applyProjectSearchFindings, parseProjectSearchFindings };
