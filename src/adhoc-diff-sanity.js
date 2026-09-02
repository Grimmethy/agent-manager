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
// Three deterministic checks. Used by:
//   - adhoc-harness-draft.js (tier 1): a hit -> decline, fall through to the agentic tiers.
//   - agentic-draft-common.js resolveAgenticDraft (tier 3 implemented branch): a hit ->
//     retryable block carrying pointed feedback, instead of a wasted review round-trip.

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

// Returns null if the diff looks like a real, on-task implementation, else
// { code, reason, retryFeedback }.
function adhocDiffSubstanceProblem(task, rawDiff) {
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

  return null;
}

module.exports = { adhocDiffSubstanceProblem, parseChangedFiles, extractForbiddenPaths };
