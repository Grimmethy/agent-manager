'use strict';

// Generic premise-verification for candidate-fulfillment drafts (2026-09-06). Adapted
// from the hygiene plugin's arch-import-premise-check.js (same real deterministic-first/
// cheap-model-fallback algorithm, copied here rather than required across the plugin
// boundary -- core agent-manager must not depend on an optional plugin to function).
//
// Root incident this closes: AC-16/AC-18 (pipeline_forensics_fix candidates, both
// literal duplicates) proposed guarding reject-retry-check.js against a feasibility-gate
// stamp ("AC-13a") that the candidate's own Problem statement assumed already existed in
// the codebase -- it never did. The candidates were both `noCandidateSplit: true` and
// already past any split cap, so finalizeCandidateFulfillment's existing `premiseCheck`
// hook (gated on a real split attempt, see its own header) could NEVER have caught this
// regardless of registration -- confirmed by reading that gate directly before building
// this, not assumed. The model faithfully implemented exactly what the (falsely-premised)
// candidate asked for; nothing checked whether the candidate's OWN claim about the
// codebase's current state was true before a full plan+implement cycle was spent on it.
//
// This module runs the SAME check at the postImplementCheck chokepoint instead (see
// local-draft.js's runImplementPass) -- unconditional on every implement pass for a
// registered source, not gated on splitting -- since a false premise is just as real
// (and just as structurally unfixable by a blind redraft) whether or not the draft
// attempts to decompose the candidate further.
//
// Kill switch: AGENT_MANAGER_CANDIDATE_PREMISE_CHECK=false.

const PREMISE_CHECK_MODEL = process.env.AGENT_MANAGER_CANDIDATE_PREMISE_MODEL || 'qwen2.5:3b';
const PREMISE_CHECK_NUM_CTX = 8192;

function isEnabled() {
  return process.env.AGENT_MANAGER_CANDIDATE_PREMISE_CHECK !== 'false';
}

function clip(s, n) {
  const str = String(s || '');
  return str.length > n ? `${str.slice(0, n)}\n...[truncated]` : str;
}

function fetchedFilesOf(task) {
  return (task.promptContext && task.promptContext.fetchedFiles) || [];
}

function fetchedContentFor(task, relPath) {
  const hit = fetchedFilesOf(task).find((f) => f && f.path === relPath);
  return hit ? String(hit.content || '') : null;
}

// --- Check 1: citation existence ---------------------------------------------------------
// A path citation followed, within the same sentence, by a backtick-quoted symbol --
// check the symbol actually appears in that file's real fetched content. Cheap,
// high-confidence: a cited symbol absent from its own cited file is fabricated, not a
// judgment call.
const CITED_PATH_RE = /`((?:src|python|scripts|lib|docs)\/[\w./-]+\.\w{1,5})(?::\d+)?`/g;
const CITATION_WINDOW_CHARS = 220;
const CITED_SYMBOL_RE = /`([A-Za-z_][A-Za-z0-9_]{3,}\(?)`/g;

function checkCitations(task, body) {
  const contradictions = [];
  if (!fetchedFilesOf(task).length) return contradictions;
  let pm;
  CITED_PATH_RE.lastIndex = 0;
  while ((pm = CITED_PATH_RE.exec(body))) {
    const relPath = pm[1];
    const content = fetchedContentFor(task, relPath);
    if (content === null) continue; // file wasn't fetched -- nothing to check
    const window = body.slice(pm.index, pm.index + CITATION_WINDOW_CHARS);
    CITED_SYMBOL_RE.lastIndex = 0;
    let sm;
    while ((sm = CITED_SYMBOL_RE.exec(window))) {
      const symbol = sm[1].replace(/\($/, '');
      if (symbol === relPath || relPath.endsWith(`/${symbol}`)) continue; // the path token itself
      if (!content.includes(symbol)) {
        contradictions.push({
          kind: 'missing-citation',
          detail: `candidate cites \`${symbol}\` in ${relPath}, but that name does not appear anywhere in the real fetched content of ${relPath}`,
        });
      }
    }
  }
  return contradictions;
}

// --- Check 2: "this already exists" / prerequisite claim --------------------------------
// A candidate that references its own prior sibling/prerequisite by name (e.g. "the
// AC-13a gate", "the existing X hook") -- check the named thing is actually mentioned
// somewhere in the real fetched content, not just asserted. This is the exact shape
// AC-16/AC-18 got wrong: both cited "the AC-13a external-dependency feasibility gate"
// as an existing prerequisite with no fetched file ever containing it.
const PREREQUISITE_CLAIM_RE = /\b(the\s+existing|already\s+(?:exists?|built|implemented|wired|has)|the\s+AC-\d+[a-z]?\s+(?:gate|hook|check|fix))\b/gi;

function checkPrerequisiteClaim(task, body) {
  const contradictions = [];
  const files = fetchedFilesOf(task);
  if (!files.length) return contradictions;
  PREREQUISITE_CLAIM_RE.lastIndex = 0;
  if (!PREREQUISITE_CLAIM_RE.test(body)) return contradictions;
  // Named-entity extraction: a quoted identifier or backtick-quoted symbol near a
  // prerequisite-claim phrase, checked against the UNION of all fetched file content --
  // deliberately loose (any fetched file, not just one named alongside the claim), since
  // a real prerequisite could legitimately live in a different file than the one this
  // candidate's own Solution targets.
  const allContent = files.map((f) => String((f && f.content) || '')).join('\n');
  CITED_SYMBOL_RE.lastIndex = 0;
  let sm;
  const checked = new Set();
  while ((sm = CITED_SYMBOL_RE.exec(body))) {
    const symbol = sm[1].replace(/\($/, '');
    if (checked.has(symbol)) continue;
    checked.add(symbol);
    const nearbyClaim = body.slice(Math.max(0, sm.index - CITATION_WINDOW_CHARS), sm.index).match(PREREQUISITE_CLAIM_RE);
    if (nearbyClaim && !allContent.includes(symbol)) {
      contradictions.push({
        kind: 'unverified-prerequisite',
        detail: `candidate claims \`${symbol}\` already exists, but that name does not appear anywhere in the real fetched content of any file this candidate cites`,
      });
    }
  }
  return contradictions;
}

// { contradictions: [{kind, detail}] }. Pure, deterministic, no model, no I/O beyond
// what's already in promptContext.fetchedFiles.
function computePremiseEvidence(task) {
  const body = String((task.promptContext && task.promptContext.body) || '');
  return { contradictions: [...checkCitations(task, body), ...checkPrerequisiteClaim(task, body)] };
}

// Whether the candidate makes ANY claim shape this module knows how to check at all --
// used to skip the model fallback for the common candidate that makes no checkable claim.
function hasCheckableClaim(task) {
  const body = String((task.promptContext && task.promptContext.body) || '');
  CITED_PATH_RE.lastIndex = 0;
  PREREQUISITE_CLAIM_RE.lastIndex = 0;
  return CITED_PATH_RE.test(body) || PREREQUISITE_CLAIM_RE.test(body);
}

function buildPremiseCheckPrompt(task) {
  const body = String((task.promptContext && task.promptContext.body) || '');
  const filesBlock = fetchedFilesOf(task)
    .map((f) => `--- ${f.path} ---\n${clip(f.content, 4000)}`)
    .join('\n\n');
  return [
    'A candidate proposes a fix to agent-manager. Its Problem statement makes a claim about the CURRENT code -- possibly that some other feature/gate/hook already exists, or that a specific symbol is present somewhere. You are given the real fetched content of every file the candidate names. Judge ONLY whether the Problem statement\'s claim about the CURRENT code is true -- do not judge the proposed Solution, and do not judge whether the idea is good.',
    '',
    '--- CANDIDATE ---',
    clip(body, 3000),
    '',
    '--- REAL FETCHED CONTENT ---',
    filesBlock ? clip(filesBlock, 8000) : '(no files fetched)',
    '',
    'Output EXACTLY one of:',
    '  PREMISE_VALID',
    'or:',
    '  PREMISE_INVALID -- <one sentence citing the real content above that contradicts the claim>',
    'Nothing else.',
  ].join('\n');
}

function parsePremiseVerdict(text) {
  const firstLine = (String(text || '').split('\n').find((l) => l.trim()) || '').trim();
  if (/^PREMISE_VALID\b/i.test(firstLine)) return { verdict: 'ok' };
  const m = firstLine.match(/^PREMISE_INVALID\b\s*[-:]*\s*(.*)$/i);
  if (m) return { verdict: 'invalid-premise', reason: m[1].trim().slice(0, 300) || '(no detail given)' };
  return { verdict: 'ok' }; // non-conforming output -- 3b noise, same "0 survivors -> ok" rule elsewhere
}

// task, { call, maybeLockedOn } -> { verdict: 'ok'|'invalid-premise', reason? }
async function runPremiseCheck(task, { call, maybeLockedOn } = {}) {
  if (!isEnabled()) return { verdict: 'ok' };
  if (typeof call !== 'function') return { verdict: 'ok' }; // advisory -- no caller means no check, never a hard requirement
  const pc = task.promptContext || {};
  const evidence = pc.premiseEvidence || computePremiseEvidence(task);
  if (evidence.contradictions.length) {
    return { verdict: 'invalid-premise', reason: evidence.contradictions[0].detail };
  }
  if (!hasCheckableClaim(task)) return { verdict: 'ok' };

  const prompt = buildPremiseCheckPrompt(task);
  const fn = () => call({
    prompt, model: PREMISE_CHECK_MODEL, numCtx: PREMISE_CHECK_NUM_CTX,
    think: false, temperature: 0.2, numPredict: 300, source: task.source,
  });
  let result;
  try {
    result = maybeLockedOn ? await maybeLockedOn(PREMISE_CHECK_MODEL, fn, 'candidate-premise') : await fn();
  } catch (e) {
    return { verdict: 'ok', error: String((e && e.message) || e).slice(0, 160) }; // advisory -- never blocks on a model-call failure
  }
  if (result && result.degenerate) return { verdict: 'ok' };
  return parsePremiseVerdict(result && result.response);
}

// Adapter matching the postImplementCheck(task, implementResponse, {call,
// maybeLockedOn}) hook signature -- runPremiseCheck itself ignores implementResponse
// entirely (it checks the CANDIDATE's own stated premise, independent of what was
// drafted), so this just drops the unused positional argument.
async function runPremiseCheckAsPostImplement(task, _implementResponse, opts) {
  return runPremiseCheck(task, opts);
}

module.exports = {
  computePremiseEvidence,
  hasCheckableClaim,
  runPremiseCheck,
  runPremiseCheckAsPostImplement,
  buildPremiseCheckPrompt,
  parsePremiseVerdict,
  checkCitations,
  checkPrerequisiteClaim,
};
