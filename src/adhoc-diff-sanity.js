'use strict';

// Substance gate for an adhoc task's produced diff (2026-09-02). Root-caused live via
// three needs-clarification tasks (job-list grouping, second-brain recurring source,
// mobile-access): faced with a substantial multi-file feature, the local model produces a
// plausible-looking TOKEN GESTURE that isn't the work asked for -- an ADR instead of the
// UI code, a dead unused stub function in an unrelated file, or it deletes a core file it
// was never asked to touch -- and the drafting tiers stamp that as
// `adhocResolution: 'implemented'` because their quality bar only checks "valid diff,
// applies cleanly, non-empty" and never "is this actually the change?".
//
// Five deterministic checks (1-3 original, 4-5 added 2026-09-04). Used by:
//   - adhoc-harness-draft.js (tier 1): a hit -> decline, fall through to the agentic tiers.
//   - local-agentic-draft.js (tier 2): a hit -> decline, fall through to tier 3.
//   - agentic-draft-common.js resolveAgenticDraft (tier 3 implemented branch): a hit ->
//     retryable block carrying pointed feedback, instead of a wasted review round-trip.
//
// 2026-09-04 (corpus investigation of 96 historically-stuck adhoc tasks): this file's own
// substance check only ever ran for `resolution === 'implemented'` with a non-empty diff --
// a `no-changes-needed` resolution (empty diff, by definition) sailed past it entirely, and
// a FALSE-but-checkable completion claim inside an `implemented` diff's own summary (a test
// count, a "created file X") was never cross-checked against the diff either. Both shapes
// accounted for ~43% of the historically-stuck corpus, caught only after a full review
// round-trip (sometimes several). `adhocNoChangesClaimProblem` (below) is the
// `no-changes-needed` sibling of `adhocDiffSubstanceProblem`; checks 4-5 extend
// `adhocDiffSubstanceProblem` itself with the false-completion-claim checks. Both reuse
// `extractRequestObjectTokens` (request-object-tokens.js) and `fetchForQueries`
// (arch-import-fetch.js) -- the same primitives get-grounding-source.js's
// `buildRequestObjectGrounding` already uses at REVIEW time -- moved earlier, to draft
// time, so the round-trip closes instead of just getting detected after the fact.

const { extractRequestObjectTokens } = require('./request-object-tokens.js');

// --- diff parsing -----------------------------------------------------------

// Unified git diff -> [{ path, kind: 'create'|'delete'|'edit' }]. `path` is the b/ side
// (a/ for a delete). Best-effort; a line it can't parse just isn't a changed file.
function parseChangedFiles(diff) {
  const lines = String(diff || '').split('\n');
  const files = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (!m) continue;
    let kind = 'edit';
    let path = m[2];
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      if (/^diff --git /.test(lines[j])) break;
      if (/^new file mode /.test(lines[j])) { kind = 'create'; break; }
      if (/^deleted file mode /.test(lines[j])) { kind = 'delete'; path = m[1]; break; }
    }
    files.push({ path, kind });
  }
  return files;
}

// --- classification helpers -----------------------------------------------

const DOC_PATH_RE = /(^|\/)(docs?|adr)(\/|$)|(^|\/)(README|CHANGELOG|CHANGES|HISTORY|CONTRIBUTING|AGENTS)(\.[\w-]+)?$|\.(md|mdx|markdown|rst|txt|adoc)$/i;
const isDocPath = (p) => DOC_PATH_RE.test(p);

// Does the task text ask for actual code, not just prose? A pure "write an ADR for X"
// task has none of these; job-list ("renderJobListTab() in index.html") and second-brain
// ("a new task source in src/task-sources.js") both do.
const CODE_SIGNAL_RE = /\b(src|python|scripts|lib|app|dashboard|templates)\/|\.(js|jsx|ts|tsx|py|sh|go|rb|rs|java|html|css)\b|\b(implement|endpoint|route|task source|new (?:module|file|source|helper)|render\w*\(|def \w+\(|function \w+|wire (?:it|this|the|in)|add .{0,25}(?:to|in|into) \w[\w./-]*\.(?:py|js|html|sh)|api route|backend|cursor module|sweep logic)\b/i;

// Verbs that make a delete legitimate.
const DELETE_INTENT_RE = /\b(delet\w+|remov\w+|drop\w*|deprecat\w+|rip out|tear out|get rid of|eliminat\w+|no longer needed|obsolete)\b/i;

// Explicit "do NOT touch X" / "never touches X" restriction clauses -> forbidden paths.
// Sentence-scoped so a path from an unrelated later sentence is never pulled in.
const RESTRICTION_SENTENCE_RE = /\b(?:do ?n(?:'?o?)?t|don['’]t|never|must not|no other|nothing (?:else |but )?(?:in|under)|not (?:touch|modif|chang|edit))\b.*?\b(?:touch\w*|modif\w+|chang\w+|edit\w+|alter\w+|updat\w+|delet\w+|writ\w+ (?:to|into))\b|\b(?:never|does ?n(?:'?o)?t) (?:touch\w*|modif\w+)\b/i;

function extractForbiddenPaths(text) {
  const out = new Set();
  const add = (raw) => {
    let s = String(raw || '').trim().replace(/^[`'"(]+|[`'".,;)]+$/g, '');
    if (!s) return;
    if (/^(src|python|scripts|lib|tests?|docs|node_modules)$/i.test(s)) s = s.toLowerCase() + '/';
    out.add(s);
  };
  const sentences = String(text || '').split(/(?<=[.!?:])\s+|\n+/);
  for (const sen of sentences) {
    if (!RESTRICTION_SENTENCE_RE.test(sen)) continue;
    for (const p of sen.matchAll(/\b(?:src|python|scripts|lib|tests?|docs|node_modules)\/[\w./@-]*[\w]/gi)) add(p[0]);
    for (const p of sen.matchAll(/[\w./@-]+\.(?:js|jsx|ts|tsx|py|sh|go|rb|rs|java|html|css|json|ya?ml)\b/gi)) add(p[0]);
    for (const p of sen.matchAll(/(?:anything|everything|any(?: of the)? files?)?\s*(?:under|inside|within|in)\s+(?:the\s+)?["'`]?(src|python|scripts|lib|tests?|docs)["'`]?(?:\s+(?:dir\w*|folder|tree|directory))?/gi)) add(p[1]);
    if (/\b(?:under|anything|everything|whole|entire|any (?:file|change) (?:in|under))\b/i.test(sen)) {
      for (const p of sen.matchAll(/\b(src|python|scripts|lib)\b/gi)) add(p[1]);
    }
  }
  return [...out];
}

function pathHitsForbidden(changedPath, forbidden) {
  const cp = changedPath.replace(/^\.\//, '');
  const base = cp.split('/').pop();
  return forbidden.find((f) => {
    if (f.endsWith('/')) return cp === f.slice(0, -1) || cp.startsWith(f);
    if (cp === f) return true;
    // path with no extension ("src/apply-adhoc-diff") -> match "src/apply-adhoc-diff.js"
    if (f.includes('/') && !/\.\w+$/.test(f)) return cp === f || cp.startsWith(`${f}.`);
    // a bare filename restriction matches by basename
    if (!f.includes('/')) return base === f || base.startsWith(`${f}.`);
    return false;
  });
}

// --- the gate -------------------------------------------------------------

function isAdhoc(task) {
  return !!task && (task.source === 'manual' || task.domain === 'adhoc');
}

const PLAN_TARGETS_HINT = 'Implement the actual change in the file(s) the plan/task names';

// --- false-completion-claim helpers (checks 4-5) ---------------------------

// "all 14 tests pass" / "all 24 tests" / "12 tests added" / "8 tests passing" -- the
// specific phrasing corpus incidents actually used. Deliberately narrow (a claim this
// check can't parse just isn't checked, never blocks).
const ALL_N_TESTS_RE = /\ball\s+(\d+)\s+tests?\b/i;
const N_TESTS_CLAIM_RE = /\b(\d+)\s+tests?\s+(?:pass(?:es|ed|ing)?|added)\b/i;

function extractClaimedTestCount(summary) {
  const m = ALL_N_TESTS_RE.exec(summary) || N_TESTS_CLAIM_RE.exec(summary);
  return m ? Number(m[1]) : null;
}

// Counts distinct test definitions ADDED by the diff (Python def test_..., JS it()/test()).
// Line-level, not AST -- consistent with this file's existing diff-parsing style.
function countAddedTestDefs(diff) {
  let n = 0;
  for (const line of String(diff || '').split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    if (/\bdef\s+test_\w+\s*\(/.test(line) || /\b(?:it|test)\(\s*['"`]/.test(line)) n++;
  }
  return n;
}

// "creates the file `x.py`" / "created file 'x.js'" -- checked against parseChangedFiles'
// own `create`-kind entries.
const CREATES_FILE_RE = /creat(?:e|ed|es)\s+(?:the\s+|a\s+)?(?:new\s+)?file\s+[`'"]([^`'"]+)[`'"]/i;

function extractClaimedCreatedFile(summary) {
  const m = CREATES_FILE_RE.exec(summary);
  return m ? m[1].trim() : null;
}

// --- no-changes-needed claim helpers (adhocNoChangesClaimProblem) ----------

const ALREADY_COVERED_RE = /already covered:/i;

// Every line under "Already covered:" (or anywhere else in the summary -- a citation
// written in prose still counts), so a token that appears ANYWHERE in the response text
// is treated as covered, not just inside the literal header block.
function tokenMentioned(token, summary) {
  return summary.toLowerCase().includes(String(token).toLowerCase());
}

// Returns null if the diff looks like a real, on-task implementation, else
// { code, reason, retryFeedback }.
function adhocDiffSubstanceProblem(task, rawDiff, summary = '') {
  if (!isAdhoc(task) || !String(rawDiff || '').trim()) return null;
  const rawText = (task.promptContext && task.promptContext.rawText) || task.title || '';
  const planText = task.planResponse || task.lastGoodPlan || '';
  const combined = `${rawText}\n${planText}`;
  const files = parseChangedFiles(rawDiff);
  if (files.length === 0) return null; // can't parse -- don't block on this check

  // 1. Explicit "do NOT touch X" violation -- most specific, checked first.
  const forbidden = extractForbiddenPaths(combined);
  if (forbidden.length) {
    const violations = files.map((f) => ({ f, hit: pathHitsForbidden(f.path, forbidden) })).filter((v) => v.hit);
    if (violations.length) {
      const list = violations.map((v) => `${v.f.path} (matches forbidden "${v.hit}")`).join(', ');
      return {
        code: 'forbidden-path',
        reason: `diff touches ${list} -- the task explicitly says not to`,
        retryFeedback: `Your diff modified ${violations.map((v) => v.f.path).join(', ')}, which the task EXPLICITLY forbids ("${forbidden.join('", "')}"). Discard those changes entirely. ${PLAN_TARGETS_HINT}, and nowhere else.`,
      };
    }
  }

  // 2. Deletes a file the task never asked to delete.
  const deletes = files.filter((f) => f.kind === 'delete');
  if (deletes.length && !DELETE_INTENT_RE.test(rawText)) {
    const list = deletes.map((d) => d.path).join(', ');
    return {
      code: 'unrequested-delete',
      reason: `diff deletes ${list} but the task never asked to delete anything`,
      retryFeedback: `Your diff DELETES ${list}. The task never asked for a deletion -- removing a file is almost certainly wrong here. Do not delete anything. ${PLAN_TARGETS_HINT}.`,
    };
  }

  // 3. Docs-only diff for a task that clearly wants code.
  const nonDoc = files.filter((f) => !isDocPath(f.path));
  if (nonDoc.length === 0 && CODE_SIGNAL_RE.test(combined)) {
    return {
      code: 'docs-only',
      reason: `diff only touches documentation (${files.map((f) => f.path).join(', ')}) -- the task asks for a code change`,
      retryFeedback: `Your diff only created/edited documentation (${files.map((f) => f.path).join(', ')}). That is not the deliverable -- the task asks for a real code change. ${PLAN_TARGETS_HINT}. A doc/ADR, if the task asks for one at all, comes LAST, after the code is written and checked.`,
    };
  }

  // 4. A checkable "all N tests pass/added" claim contradicted by the diff's own test defs.
  const claimedTests = extractClaimedTestCount(summary);
  if (claimedTests !== null) {
    const actualTests = countAddedTestDefs(rawDiff);
    if (actualTests < claimedTests) {
      return {
        code: 'false-test-count-claim',
        reason: `summary claims ${claimedTests} tests but the diff only adds ${actualTests} test definition(s)`,
        retryFeedback: `Your summary claims ${claimedTests} tests, but the diff you produced only adds ${actualTests} test definition(s). Either write the tests you claimed, or correct the summary to match what the diff actually contains -- do not report a count you didn't verify against your own diff.`,
      };
    }
  }

  // 5. A checkable "creates the file X" claim contradicted by the diff's own file list.
  const claimedFile = extractClaimedCreatedFile(summary);
  if (claimedFile) {
    const created = files.some((f) => f.kind === 'create' && (f.path === claimedFile || f.path.endsWith(`/${claimedFile}`) || claimedFile.endsWith(f.path)));
    if (!created) {
      return {
        code: 'false-file-creation-claim',
        reason: `summary claims it creates \`${claimedFile}\` but the diff has no "new file" entry for that path`,
        retryFeedback: `Your summary claims you created \`${claimedFile}\`, but your diff has no "new file" entry for that path. Either actually create it in the diff, or correct the summary -- do not claim a file exists that your own diff doesn't create.`,
      };
    }
  }

  return null;
}

// The no-changes-needed sibling of adhocDiffSubstanceProblem. Returns null if the claim
// looks genuinely grounded, else { code, reason, retryFeedback }.
function adhocNoChangesClaimProblem(task, summary) {
  if (!isAdhoc(task)) return null;
  const text = String(summary || '');
  if (!text.trim()) return null; // an empty response is handled elsewhere (turn-budget path)

  // Check A: no "Already covered:" block at all -- the single most common shape in the
  // corpus (a bare refusal or meta-commentary response with no coverage breakdown).
  if (!ALREADY_COVERED_RE.test(text)) {
    return {
      code: 'missing-citation-block',
      reason: 'no "Already covered:" block at all',
      retryFeedback: 'You answered RESOLUTION: no-changes-needed but gave no "Already covered:" block. Before that resolution is valid, you MUST list every concrete object/endpoint/field the request names, one line each, as `<object> -- <path>:<symbol>`, pointing at the REAL current file:symbol that covers it. If you cannot fill in a real file:symbol for every object the request names, it is NOT no-changes-needed -- implement the missing part instead.',
    };
  }

  // Check B: a distinctive named object is neither mentioned anywhere in the response NOR
  // findable anywhere in the live repo -- a double-negative confirmation the "already
  // covered" claim is false for that specific object.
  const rawText = (task.promptContext && task.promptContext.rawText) || task.title || '';
  const tokens = extractRequestObjectTokens(rawText).filter((tok) => !tokenMentioned(tok, text));
  if (tokens.length === 0) return null;

  let fetchForQueries;
  try {
    ({ fetchForQueries } = require('./arch-import-fetch.js'));
  } catch {
    return null; // can't verify -- don't block on this check
  }
  const variantToTok = new Map();
  const queries = [];
  for (const tok of tokens) {
    for (const v of new Set([tok, tok.toLowerCase(), tok.toUpperCase()])) {
      if (!variantToTok.has(v)) { variantToTok.set(v, tok); queries.push(v); }
    }
  }
  let hits = [];
  try {
    hits = fetchForQueries(queries).hits || [];
  } catch {
    return null; // grep failed -- don't block on this check
  }
  const hasHit = new Set();
  for (const h of hits) { const tok = variantToTok.get(h.query); if (tok) hasHit.add(tok); }
  const ungrounded = tokens.filter((tok) => !hasHit.has(tok));
  if (ungrounded.length === 0) return null;

  const list = ungrounded.map((t) => `"${t}"`).join(', ');
  return {
    code: 'ungrounded-named-object',
    reason: `the request names ${list}, which appears in neither your "Already covered:" citations nor anywhere in the current repo`,
    retryFeedback: `The request names ${list}. Your response doesn't cite it, and a search of the current repo found no trace of it either -- that is a strong signal it is NOT already covered. For each of these, either point at the real file:symbol that implements it, or implement the missing piece. Do not answer no-changes-needed while any of these remain unaccounted for.`,
  };
}

module.exports = {
  adhocDiffSubstanceProblem, adhocNoChangesClaimProblem, parseChangedFiles, extractForbiddenPaths,
};
