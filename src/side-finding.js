'use strict';

// Pipeline-wide "side finding" capture (2026-09-05, Grimmethy: "I'm imagining a system
// that creates brain dumps as it churns through the work... models could flag issues that
// aren't directly related to their current task rather than ignoring them").
//
// A model may emit, anywhere in its response, a block of the form:
//   SIDE-FINDING: <one-line title>
//   <1-3 sentences of body text>
// possibly repeated. This module is the symmetric injection/extraction pair for that
// convention -- injectSideFindingInstruction() tells the model the convention exists (it
// won't spontaneously invent undocumented marker syntax), extractSideFindings() pulls any
// such blocks back out before the caller's own RESOLUTION:/OPTIONS:/JSON parsing ever sees
// the text, and writeSideFindingInbox() files each one, best-effort, into
// queue/side-findings-inbox/ for side-finding-sweep.js to drain into brain-dump.json later.
//
// House style matches this codebase's existing marker conventions exactly: RESOLUTION:
// (agentic-draft-common.js), OPTIONS: (same file), and candidate-docs.js's
// parseArchDiscoveryCandidates (split-on-lookahead over a repeating heading, lenient,
// drop-malformed-not-fail-everything).
//
// Wired into exactly two chokepoints -- local-client.js's call()/claude-client.js's
// call() (every plain single-shot pass) and local-tool-client.js's runPlanWithTools()
// (every tool-calling pass) -- so this module itself never needs to know which task
// source or prompt builder is calling it.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SIDE_FINDING_INSTRUCTION = (
  'If, while working on this, you notice a genuine issue, risk, or improvement '
  + "opportunity that is NOT part of this task, you may flag it (don't act on it) by "
  + 'adding a block anywhere in your response:\n'
  + 'SIDE-FINDING: <one-line title>\n'
  + '<1-3 sentences of detail>\n'
  + "Do this rarely -- only for something concrete and worth a human's attention later, "
  + 'never to pad your answer.'
);

const MAX_SIDE_FINDINGS_PER_RESPONSE = Number(process.env.AGENT_MANAGER_MAX_SIDE_FINDINGS_PER_RESPONSE) || 3;

const SIDE_FINDING_SPLIT_RE = /(?=^SIDE-FINDING:\s*)/m;
const SIDE_FINDING_TITLE_RE = /^SIDE-FINDING:\s*(.+)$/m;

// Appends the instruction blurb once. Idempotent (checks it isn't already present) --
// matters because call() can retry the identical prompt several times (CHAT_FLAKE-style
// retries elsewhere, local-client.js's own maxRetries) and must not accumulate copies.
function injectSideFindingInstruction(text) {
  const base = text || '';
  if (base.includes('SIDE-FINDING:')) return base;
  return `${base}\n\n${SIDE_FINDING_INSTRUCTION}`;
}

// Returns { cleanText, findings: [{title, body}] }. cleanText has every matched block
// removed so a caller's own RESOLUTION:/OPTIONS:/JSON parsing never sees them. Lenient:
// a block with no real title or body is dropped, never thrown -- one malformed block must
// never cost the rest of a real response. Capped at MAX_SIDE_FINDINGS_PER_RESPONSE and
// de-duplicated by title WITHIN this one response (a model repeating itself once is not
// three separate findings).
//
// A finding's body is ONLY the immediately-following paragraph (up to the first blank
// line), matching the "1-3 sentences" instruction -- NOT "everything up to the next
// SIDE-FINDING or end of text". Without this bound, a SIDE-FINDING block placed before a
// real RESOLUTION:/OPTIONS: line with nothing else between them would swallow that line
// into the finding's body and silently delete it from cleanText, corrupting the actual
// task response. Whatever follows the finding's own paragraph is preserved back into
// cleanText verbatim.
function extractSideFindings(text) {
  const source = text || '';
  if (!source.includes('SIDE-FINDING:')) return { cleanText: source, findings: [] };

  const blocks = source.split(SIDE_FINDING_SPLIT_RE);
  const findings = [];
  const seenTitles = new Set();
  const cleanParts = [];

  for (const block of blocks) {
    const titleMatch = block.match(SIDE_FINDING_TITLE_RE);
    if (!titleMatch) {
      cleanParts.push(block);
      continue;
    }
    const title = titleMatch[1].trim();
    const afterTitle = block.slice(block.indexOf(titleMatch[0]) + titleMatch[0].length);
    const paraSplit = afterTitle.match(/\n\s*\n/);
    const body = (paraSplit ? afterTitle.slice(0, paraSplit.index) : afterTitle).trim();
    const remainder = paraSplit ? afterTitle.slice(paraSplit.index) : '';
    cleanParts.push(remainder); // whatever comes after this finding's own paragraph stays

    if (!title || !body) continue; // malformed -- drop, don't fail the whole extraction
    const key = title.toLowerCase();
    if (seenTitles.has(key)) continue; // same finding repeated in one response
    if (findings.length >= MAX_SIDE_FINDINGS_PER_RESPONSE) continue;
    seenTitles.add(key);
    findings.push({ title, body });
  }

  const cleanText = cleanParts.join('').replace(/\n{3,}/g, '\n\n').trim();
  return { cleanText, findings };
}

function inboxDir(pipelineDir) {
  return path.join(pipelineDir, 'queue', 'side-findings-inbox');
}

// Best-effort, fire-and-forget: writes ONE independent, uniquely-named file per finding
// (race-free by construction -- no shared file, no read-modify-write here at all; the
// dashboard/CLI single writer is side-finding-sweep.js, later). Never throws past the
// caller -- a disk/permissions problem here must never turn into a pipeline-wide outage
// over what is, after all, an optional side channel.
function writeSideFindingInbox(finding, { source, taskId, stage, pipelineDir }) {
  if (!pipelineDir) return;
  try {
    const dir = inboxDir(pipelineDir);
    fs.mkdirSync(dir, { recursive: true });
    const name = `sf-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.json`;
    const record = {
      title: finding.title,
      body: finding.body,
      source: source || null,
      taskId: taskId || null,
      stage: stage || null,
      extractedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(dir, name), JSON.stringify(record, null, 2));
  } catch (e) {
    console.warn('[side-finding] failed to write inbox entry (non-fatal):', e.message);
  }
}

module.exports = {
  SIDE_FINDING_INSTRUCTION,
  MAX_SIDE_FINDINGS_PER_RESPONSE,
  injectSideFindingInstruction,
  extractSideFindings,
  writeSideFindingInbox,
  inboxDir,
};
