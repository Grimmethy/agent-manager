'use strict';

// Per-task acceptance criteria for adhoc tasks (2026-09-04) -- component 2 of the "plan
// mode" port. A task can carry an explicit "definition of done"; when it doesn't, the plan
// pass is asked to STATE one. Downstream: tier 3 must report a real check per criterion in
// an "Acceptance:" block, review holds the diff to every criterion, and (opt-in) an
// acceptanceCommand is run against the applied branch before commit.
//
// Nothing here calls a model. reviewGuidance / reviewCompletenessQuestion are already
// per-task dynamic (resolveDynamicReviewField), so the review side needs no plumbing --
// task-sources.js's adhocReviewCompletenessQuestion just folds task.acceptanceCriteria in.

const MAX_CRITERIA = 8;
const MAX_CRITERION_CHARS = 240;

function normalizeList(value) {
  let items = [];
  if (Array.isArray(value)) {
    items = value.map((v) => String(v || '').trim());
  } else if (typeof value === 'string') {
    items = value.split('\n').map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim());
  }
  return items.filter(Boolean).map((s) => s.slice(0, MAX_CRITERION_CHARS)).slice(0, MAX_CRITERIA);
}

// Trailing "CRITERIA:" block in the plan text -> the bullets under it (until a blank line
// or EOF). Tolerates `- `, `* `, `1. `, `1) ` bullets.
function parseCriteriaBlock(planText) {
  const text = String(planText || '');
  const m = text.match(/^\s*CRITERIA:\s*$/im);
  if (!m) return [];
  const rest = text.slice(m.index + m[0].length).split('\n');
  const out = [];
  for (const line of rest) {
    if (!line.trim()) { if (out.length) break; else continue; }
    const b = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.+?)\s*$/);
    if (!b) { if (out.length) break; else continue; }
    out.push(b[1].trim());
  }
  return normalizeList(out);
}

// File-path-shaped tokens found anywhere in a task's own edit-instruction prose (not
// just a structured "Files:" line, which most adhoc tasks don't have) -- deliberately
// broader-recall than adhoc-diff-sanity.js's extractDeclaredTargets, which only scans
// the TITLE for this purpose. Sentence-scoped and restriction-aware for the same reason:
// a file named only inside a "do not touch X" clause is not a declared edit target.
const FILE_TOKEN_RE = /\b(?:src|python|scripts|lib|tests?|docs)\/[\w./@-]*[\w]|\b[\w-]+\.(?:js|jsx|ts|tsx|py|sh|go|rb|rs|java|html|css|json|ya?ml)\b/gi;
const RESTRICTION_SENTENCE_RE = /\b(?:do ?n(?:'?o?)?t|don['’]t|never|must not|no other|nothing (?:else |but )?(?:in|under)|not (?:touch|modif|chang|edit))\b.*?\b(?:touch\w*|modif\w+|chang\w+|edit\w+|alter\w+|updat\w+|delet\w+|writ\w+ (?:to|into))\b|\b(?:never|does ?n(?:'?o)?t) (?:touch\w*|modif\w+)\b/i;

function declaredEditFiles(rawText) {
  const out = new Set();
  for (const sentence of String(rawText || '').split(/(?<=[.!?:;])\s+|\n+/)) {
    if (RESTRICTION_SENTENCE_RE.test(sentence)) continue;
    for (const m of sentence.matchAll(FILE_TOKEN_RE)) out.add(m[0].replace(/^\.\//, ''));
  }
  return [...out];
}

// dropSingleFileScopeContradictions (2026-09-15) -- the plan pass writes its own
// CRITERIA: bullets (prompts.js's "definition of done" instruction) with no visibility
// into whether the SAME task also names a second file elsewhere in its own prose. Root-
// caused live on adhoc-add-getsecondbraindir-and-requiresecondbraindir-helpers-to-
// config-js-with-tests: the task's rawText explicitly says "In src/config.test.js ...
// add tests", but the plan model still wrote a criterion asserting the diff touches only
// src/config.js -- burning 6 draft attempts across 3 needs-clarification-triage retries
// before a human caught the contradiction, because every fresh plan re-derived the same
// self-defeating criterion. A criterion cannot legitimately restrict the diff to fewer
// files than the task's OWN prose already commits it to touching -- so when the task
// names >= 2 distinct edit-target files, any criterion that reads as a single-file-only
// scope restriction is dropped before implement/review ever see it, rather than letting
// the contradiction get rediscovered the expensive way on every retry.
const SINGLE_FILE_SCOPE_RE = /\bonly\b[^.]*\b(?:file|modif|touch|chang)|\bno other files?\b|\bexclusively\b[^.]*\b(?:file|modif|touch|chang)|\bmust not (?:be modified|appear|change)\b/i;

function dropSingleFileScopeContradictions(task, criteria) {
  const rawText = (task && task.promptContext && task.promptContext.rawText) || (task && task.title) || '';
  const files = declaredEditFiles(rawText);
  if (files.length < 2) return criteria; // no multi-file scope to contradict
  return criteria.filter((c) => !SINGLE_FILE_SCOPE_RE.test(c));
}

// task -> { criteria: string[], source: 'promptContext' | 'plan-derived' | null }
function resolveAcceptanceCriteria(task) {
  const pc = (task && task.promptContext) || {};
  if (pc.acceptanceCriteria != null) {
    const criteria = normalizeList(pc.acceptanceCriteria);
    if (criteria.length) return { criteria: dropSingleFileScopeContradictions(task, criteria), source: 'promptContext' };
  }
  const fromPlan = parseCriteriaBlock(task && (task.planResponse || task.lastGoodPlan));
  if (fromPlan.length) return { criteria: dropSingleFileScopeContradictions(task, fromPlan), source: 'plan-derived' };
  return { criteria: [], source: null };
}

// Parse tier 3's "Acceptance:" block out of its final summary.
//   Acceptance:
//   1. <criterion> -- <check you ran> -- <PASS/FAIL + output>
// -> [{ criterion, check, result, pass }]
function parseAcceptanceBlock(summary) {
  const text = String(summary || '');
  const m = text.match(/^\s*Acceptance:\s*$/im);
  if (!m) return [];
  const rest = text.slice(m.index + m[0].length).split('\n');
  const out = [];
  for (const line of rest) {
    if (!line.trim()) { if (out.length) break; else continue; }
    const b = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.+)$/);
    if (!b) { if (out.length) break; else continue; }
    const segs = b[1].split(/\s+--\s+/);
    if (segs.length < 2) { out.push({ criterion: b[1].trim(), check: '', result: '', pass: false }); continue; }
    const criterion = segs[0].trim();
    const check = (segs[1] || '').trim();
    const result = segs.slice(2).join(' -- ').trim() || (segs[1] || '').trim();
    const pass = /\bPASS(?:ED|ES)?\b/i.test(result) && !/\bFAIL(?:ED|S)?\b/i.test(result);
    out.push({ criterion, check, result, pass });
  }
  return out;
}

// detectContradictoryLiteralAcceptance (2026-09-15, filed as brain-dump bd-1789433484492,
// "pipeline hardening 5/5") -- a task's own rawText can be unsatisfiable BY CONSTRUCTION:
// it mandates inserting an exact multi-line literal block of quoted text AND separately
// demands that some exact phrase appear as a single contiguous string (a grep/"Verify the
// string X appears" check), but that phrase's own characters straddle a line boundary
// inside the mandated literal as specified -- no implementation can satisfy both at once.
// Root-caused live: system-report.js's LESSONS-LEARNED comment task specified the six-line
// comment text as a sequence of separately-quoted lines wrapping "...Do NOT create a" /
// "parallel store..." across two of them, while also requiring
// `grep -c 'Do NOT create a parallel store'` to return >= 1 -- burned 3 real automated
// attempts before a human caught it. This runs BEFORE any draft attempt (mirrors
// detectExternalDependency's own "bail before spending a single turn" contract in
// local-agentic-write-draft.js) rather than letting the pipeline discover the
// contradiction the expensive way.
//
// Heuristic, not a general contradiction solver: only catches this one recurring shape
// (a cluster of >= 3 consecutive single-quoted literal segments, read as the lines of a
// file to write verbatim, plus a "verify/grep ... 'PHRASE'" clause elsewhere in the same
// text) -- deliberately narrow so it can never false-positive on a task that merely
// mentions a quoted string once or twice.
const LITERAL_LINE_CLUSTER_MIN = 3;
const REQUIRED_PHRASE_RE = /(?:verify|grep(?:\s+-\w+)*)\b[^.]*?['"]([^'"]{8,})['"]/i;

function detectContradictoryLiteralAcceptance(task) {
  const rawText = String((task && task.promptContext && task.promptContext.rawText) || '');
  if (!rawText) return null;

  // A run of >= LITERAL_LINE_CLUSTER_MIN single-quoted segments, each separated by only
  // whitespace/nothing (the "'line one' 'line two' 'line three' ..." shape a mandated
  // multi-line literal block gets flattened into as prose) -- collected as the ordered
  // lines of the literal text the task wants written verbatim.
  const clusterRe = /(?:'[^']*'\s*){3,}/;
  const clusterMatch = rawText.match(clusterRe);
  if (!clusterMatch) return null;
  const lines = [...clusterMatch[0].matchAll(/'([^']*)'/g)].map((m) => m[1]);
  if (lines.length < LITERAL_LINE_CLUSTER_MIN) return null;

  const requiredMatch = rawText.match(REQUIRED_PHRASE_RE);
  if (!requiredMatch) return null;
  const requiredPhrase = requiredMatch[1];

  // The phrase the task actually wants written literally, one line per array entry.
  const asWritten = lines.join('\n');
  if (asWritten.includes(requiredPhrase)) return null; // already satisfiable, nothing wrong

  // Collapsing line breaks to spaces -- stripping each line's own leading comment
  // marker/indentation first (// , #, *, etc.), since those decorate each WRITTEN line
  // individually and are never part of the prose content a human pictures reading
  // continuously -- is what the task AUTHOR was almost certainly picturing when they
  // wrote the requirement. If the phrase appears there but not in the real, as-written
  // (newline-preserving, marker-preserving) text, that's the exact contradiction: the
  // literal instructions wrap the required phrase across a line boundary a plain-text
  // grep can never cross.
  // \s+ collapsed to a single space throughout -- both the per-line indentation after a
  // stripped marker (e.g. the 3 spaces in '//   text') and the required phrase itself are
  // normalized the same way, so neither side's incidental whitespace produces a false
  // negative.
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const collapsed = norm(lines.map((l) => l.replace(/^\s*(?:\/\/|#|\*|--)\s*/, '')).join(' '));
  if (!collapsed.includes(norm(requiredPhrase))) return null; // not this specific shape -- some other mismatch, not ours to diagnose

  return {
    contradictory: true,
    requiredPhrase,
    lines,
    reason: `The task's own literal text (read line-by-line, as it would actually be written) never contains "${requiredPhrase}" as one contiguous string -- it is split across a line boundary in the mandated text. No implementation can satisfy both "write these exact lines" and "grep for this exact unwrapped phrase" at once.`,
  };
}

module.exports = { resolveAcceptanceCriteria, parseAcceptanceBlock, parseCriteriaBlock, normalizeList, MAX_CRITERIA, detectContradictoryLiteralAcceptance, declaredEditFiles, dropSingleFileScopeContradictions };
