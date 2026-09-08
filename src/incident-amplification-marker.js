'use strict';

// Incident Amplification's marker convention (2026-09-08) -- mirrors side-finding.js's
// own injection/extraction shape exactly, but as its own distinct marker rather than
// overloading SIDE-FINDING's simple single-purpose contract: SIDE-FINDING is "noticed in
// passing, don't act"; AMPLIFY is "confirmed root cause, deliberately search broadly for
// the same missing concept elsewhere" -- a heavier, rarer action (a real grep sweep + N
// filed brain-dump entries), not a cheap flag. See src/incident-amplification.js for the
// sweep itself and concepts.json's concept-incident-amplification-f07999 for the design.
//
//   AMPLIFY: <one-line root cause summary>
//   QUERY: <grep query -- the missing-concept pattern to search for>
//   DIR: <optional -- defaults to every searchable dir>
//   EXCLUDE: <optional comma-separated files already fixed by this investigation>
//
// Unlike SIDE-FINDING (on by default everywhere), this is opt-in per caller
// (allowAmplification, default false) -- see the 3 chokepoints' own headers for why.

const path = require('path');

const AMPLIFICATION_INSTRUCTION = (
  'If you have just CONFIRMED (not merely suspected) that a blocked/stuck task\'s root '
  + 'cause is a genuine systemic or mechanism gap in this codebase -- not a model '
  + 'judgment call, not a one-off -- you may trigger a deliberate broad search for the '
  + 'SAME missing concept at other call sites by adding a block anywhere in your '
  + 'response:\n'
  + 'AMPLIFY: <one-line root cause summary>\n'
  + 'QUERY: <grep query -- a literal substring or a few words that would match the same '
  + 'missing-concept pattern elsewhere>\n'
  + 'DIR: <optional -- a specific directory/file to search, omit to search everywhere>\n'
  + 'EXCLUDE: <optional comma-separated files already fixed by this investigation>\n'
  + 'This runs a real broad search and files what it finds as separate brain dump '
  + 'entries for normal triage -- it does NOT fix anything itself. Use this rarely, only '
  + 'once you have a real confirmed root cause, never to pad your answer.'
);

const MAX_AMPLIFY_REQUESTS_PER_RESPONSE = Number(process.env.AGENT_MANAGER_MAX_AMPLIFY_REQUESTS_PER_RESPONSE) || 1;

const AMPLIFY_SPLIT_RE = /(?=^AMPLIFY:\s*)/m;
const AMPLIFY_TITLE_RE = /^AMPLIFY:\s*(.+)$/m;
const QUERY_RE = /^QUERY:\s*(.+)$/m;
const DIR_RE = /^DIR:\s*(.+)$/m;
const EXCLUDE_RE = /^EXCLUDE:\s*(.+)$/m;

// Idempotent -- same reasoning as injectSideFindingInstruction (call() can retry the
// identical prompt several times).
function injectAmplificationInstruction(text) {
  const base = text || '';
  if (base.includes('AMPLIFY:')) return base;
  return `${base}\n\n${AMPLIFICATION_INSTRUCTION}`;
}

// Returns { cleanText, requests: [{rootCauseSummary, query, dir, exclude}] }. Same
// lenient, drop-malformed-not-fail-everything style as extractSideFindings -- a block
// missing QUERY (the one truly required companion field) is dropped, never thrown.
// A block's own scope is bounded to the first blank line, same reasoning as
// extractSideFindings' body bound (so a real AMPLIFY block sitting before a
// RESOLUTION:/OPTIONS: line doesn't swallow it).
function extractAmplificationRequests(text) {
  const source = text || '';
  if (!source.includes('AMPLIFY:')) return { cleanText: source, requests: [] };

  const blocks = source.split(AMPLIFY_SPLIT_RE);
  const requests = [];
  const cleanParts = [];

  for (const block of blocks) {
    const titleMatch = block.match(AMPLIFY_TITLE_RE);
    if (!titleMatch) {
      cleanParts.push(block);
      continue;
    }
    const rootCauseSummary = titleMatch[1].trim();
    const afterTitle = block.slice(block.indexOf(titleMatch[0]) + titleMatch[0].length);
    const paraSplit = afterTitle.match(/\n\s*\n/);
    const scoped = (paraSplit ? afterTitle.slice(0, paraSplit.index) : afterTitle);
    const remainder = paraSplit ? afterTitle.slice(paraSplit.index) : '';
    cleanParts.push(remainder);

    const queryMatch = scoped.match(QUERY_RE);
    if (!rootCauseSummary || !queryMatch) continue; // malformed -- QUERY is required, drop
    if (requests.length >= MAX_AMPLIFY_REQUESTS_PER_RESPONSE) continue;

    const dirMatch = scoped.match(DIR_RE);
    const excludeMatch = scoped.match(EXCLUDE_RE);
    requests.push({
      rootCauseSummary,
      query: queryMatch[1].trim(),
      dir: dirMatch ? dirMatch[1].trim() : undefined,
      exclude: excludeMatch
        ? excludeMatch[1].split(',').map((s) => s.trim()).filter(Boolean).map((p) => path.normalize(p))
        : [],
    });
  }

  const cleanText = cleanParts.join('').replace(/\n{3,}/g, '\n\n').trim();
  return { cleanText, requests };
}

module.exports = {
  AMPLIFICATION_INSTRUCTION,
  MAX_AMPLIFY_REQUESTS_PER_RESPONSE,
  injectAmplificationInstruction,
  extractAmplificationRequests,
};
