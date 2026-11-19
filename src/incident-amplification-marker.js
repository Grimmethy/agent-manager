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
// Block parsing is delegated to the shared helper in src/marker-extraction.js
// (extractMarkers, block mode, AMPLIFY_OPTIONS). This module supplies only its own
// per-response cap (env-driven) and path.normalize for EXCLUDE entries.
//
// Unlike SIDE-FINDING (on by default everywhere), this is opt-in per caller
// (allowAmplification, default false) -- see the 3 chokepoints' own headers for why.

const path = require('path');
const { extractMarkers, AMPLIFY_OPTIONS } = require('./marker-extraction.js');

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
// A block's own scope is bounded to the first blank line (handled by the shared helper).
function extractAmplificationRequests(text) {
  return extractMarkers(text || '', {
    ...AMPLIFY_OPTIONS,
    maxItems: MAX_AMPLIFY_REQUESTS_PER_RESPONSE,
    normalizePath: path.normalize,
  });
}

module.exports = {
  AMPLIFICATION_INSTRUCTION,
  MAX_AMPLIFY_REQUESTS_PER_RESPONSE,
  injectAmplificationInstruction,
  extractAmplificationRequests,
};
