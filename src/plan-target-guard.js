'use strict';

// Hard PRE-implementation guard (2026-09-17, needs-clarification bd-1788967312693,
// "pre-implementation timing ambiguity" -- user-selected resolution: run before
// runImplementPass, using the plan's own declared targets).
//
// draft-file-guard.js's missingFileCheck already blocks a fabricated file citation --
// but only AFTER runImplementPass runs, scoped to candidateFulfillment sources whose
// implement response is a structured Group-B diff. That guard saves the critique/
// revision turn, but still spends the full implement pass on a plan that names a file
// that was never real to begin with.
//
// adhoc's plan pass already declares its own edit targets in plain prose
// (adhoc-diff-sanity.js's extractDeclaredTargets -- the same primitive reject-retry-
// check.js's forbidden-path-false-positive rescue already trusts). Checking those
// BEFORE the implement pass is called catches the identical fabrication one stage
// earlier, saving the implement turn too, not just critique.
//
// Scoped to adhoc only, mirroring missingFileCheck's own scoping reasoning: a
// generator-stage source's plan legitimately proposes a not-yet-real target
// (deep_dive/arch_discovery/product_spec_outline) or an external repo's own path, so
// checking declared targets against THIS repoRoot would false-positive there. adhoc
// tasks always target THIS repo's own files.
//
// Pure wrapper -- no draft-pipeline imports -- unit-testable in isolation, same shape
// as draft-file-guard.js.

const { extractDeclaredTargets } = require('./adhoc-diff-sanity.js');
const { checkFilePaths } = require('./fact-checker.js');

// Plain-prose create-mode signal: extractDeclaredTargets has no structured mode:"create"
// marker to read (unlike a Group-B JSON diff), so a declared target that doesn't exist
// yet is only exempt when a creation verb appears in the ~80 chars immediately before
// its mention in the plan text -- narrow/local on purpose, same reasoning as candidate-
// path-grounding.js's own CREATE_MODE_VERBS: a creation verb elsewhere in an unrelated
// sentence must not blanket-exempt every declared target in the plan.
const CREATE_FILE_VERBS_RE = /\b(?:create|creates|creating|add(?:s|ing)?\s+a\s+new\s+file|new\s+file\s+(?:at|named)?)\b[^\n]{0,80}$/i;
// 2026-10-15: design-doc tasks say "write ONE file, Docs/x.md" / "write the single file", not "create", and were blocked as missing-file targets (tuning-loops
// design and rotation-findings tasks). The phrase must contain the word "file" between the verb and the path: a bare "write to src/x.js" or "write src/x.js back" stays
// an ordinary edit, not a create signal.
// The phrase must sit directly against the path (only punctuation/quotes between): "write ONE file, Docs/x.md" yes; "write the file list ... then edit src/x.js" no.
const WRITE_FILE_PHRASE_RE = /\bwrite\s+(?:(?:the|a|an|one|single|new)\s+)+file[\s,:;(`'"*_-]*$/i;
// 2026-11-01 (questforge hub HUB0029-08, docs piece, blocked 'plan cites missing-file target(s): Docs/SERVICE.md' with a thin plan): the task title mentioned the
// path first, inside parentheses ("... the service (Docs/SERVICE.md) and the backlog line"), and the broad create-verb window below only looks at the FIRST mention of
// a path in the task text, so the later, explicit "WHAT: create Docs/SERVICE.md, edit Docs/BACKLOG.md ..." was never examined. Like WRITE_FILE_PHRASE_RE this
// phrase is strict enough to check at EVERY mention: the create verb must sit DIRECTLY against the path (only articles, "file" and punctuation or quotes between),
// so "Create a summary of the problem, then edit src/x.js" and "create X, edit Y" (Y) stay ordinary edit targets.
// 2026-11-02 (HUB0259-01, "Add src/tool-loop-guard.test.js with tests" parked as a missing-file target): "add" directly against a path is a create signal in the same strict form;
// it only matters for a path that does not exist, so "Add a summary of the problem, then edit src/x.js" still leaves src/x.js an ordinary target.
const DIRECT_CREATE_RE = /\b(?:create|creates|creating|add|adds|adding)\s+(?:(?:the|a|an|one|single|new)\s+)*(?:file\s+)?[\s`'"*_(]*$/i;
const ONCE_IT_EXISTS_AFTER_RE = /^[\s`'"*_)(,.;:-]{0,6}once[\s*_]+it[\s*_]+(?:exists|is[\s*_]+(?:created|written))\b/i;
const isCreateVerbBefore = (before) => CREATE_FILE_VERBS_RE.test(before) || WRITE_FILE_PHRASE_RE.test(before);

// every occurrence of needle in text, as start indexes (the guard used to look at the first only: 2026-10-15, a plan that quoted the task's "write ONE file" first and said
// "one file to create" later was blocked because only the first mention was examined)
function mentionIndexes(text, needle) {
  const out = [];
  if (!needle) return out;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}

// Existence-acknowledgment signal (2026-09-18, pipeline hardening -- confirmed live: a
// task literally titled "Create src/review-parity.test.js" burned 16 real drafting
// attempts because its own plan said, verbatim, "`src/review-parity.test.js` does
// **not** exist yet (confirmed by the orientation report)" -- a model that has just
// verified a target doesn't exist and says so has, in effect, declared it a create
// target, even without using one of CREATE_FILE_VERBS_RE's specific verbs anywhere
// nearby. Unlike the creation-verb check above, this phrasing lands AFTER the path
// mention far more often than before it ("`X` does not exist yet, so this plan will
// create it"), so both directions are checked, not just backward.
// `[\s*_]+` (not plain `\s+`) between words: a model routinely bolds "not" for emphasis
// ("does **not** exist yet") -- confirmed live, this is the EXACT real phrasing that
// caused the incident above, and a literal whitespace-only gap would miss it.
// 2026-10-08: also "is absent" / "not present" / "not found" / "no such file" (HUB0011-02: the plan said `<path>` "is absent" for a task titled "Create <file>" and was blocked).
const EXISTENCE_ACK_RE = /\b(?:does|do)[\s*_]+not[\s*_]+(?:yet[\s*_]+)?exist\b|\bdoesn'?t[\s*_]+(?:yet[\s*_]+)?exist\b|\bnot[\s*_]+yet[\s*_]+(?:present|created)\b|\b(?:is|are|was)[\s*_]+(?:currently[\s*_]+)?absent\b|\b(?:is|are)[\s*_]+not[\s*_]+(?:present|found)\b|\bno[\s*_]+such[\s*_]+file\b|\bonce[\s*_]+it[\s*_]+(?:exists|is[\s*_]+(?:created|written))\b/i;

// taskText (optional, 2026-10-08): the TASK's own title + body. A task that itself says "Create <file>" has declared the file a create target no matter how the
// plan words it; the plan-only signals above missed that when the plan named the file by its full path and called it "absent".
function isDeclaredCreateTarget(planText, targetPath, taskText = '') {
  const text = String(planText || '');
  for (const idx of mentionIndexes(text, targetPath)) {
    const before = text.slice(Math.max(0, idx - 80), idx);
    if (isCreateVerbBefore(before)) return true;
    const after = text.slice(idx + targetPath.length, idx + targetPath.length + 80);
    if (EXISTENCE_ACK_RE.test(before) || EXISTENCE_ACK_RE.test(after)) return true;
  }
  // Task text: the broad create-verb window still looks at the FIRST mention only (an unrelated "Create a summary ..., then edit src/x.js" later in the body must not
  // exempt a fabricated path -- the existing "create verb about a different file" test); the strict write-file phrase is checked at every mention.
  const task = String(taskText || '');
  const tIdxs = mentionIndexes(task, targetPath);
  const win = (i) => task.slice(Math.max(0, i - 80), i);
  // 2026-11-02 (HUB0273-01: "... and src/chat-tool-gate.test.js once it exists"): the task text itself says the file is not there yet. Strict like the write-file phrase: the
  // words must follow the path directly (a few characters of punctuation at most), so an unrelated "once it exists" elsewhere exempts nothing.
  const afterWin = (i) => task.slice(i + targetPath.length, i + targetPath.length + 24);
  // 2026-11-09 (pf-lessons hub pieces): a task titled "Create unit c1-u07 01-read.md on what a deal is" with `Files: content/chapter-1/c1-u07/01-read.md`
  // was blocked because the plan text had no create verb near the path and the task text only listed the path in a "Files:" line. If the task text has a
  // "Files:" line that EXACTLY lists the target path AND the task title (first line) contains a create-intent verb near its start, treat the path as a create
  // target. The guard only reaches this branch for missing files, so no new exemption is added for existing files.
  if (hasFilesLineListing(task, targetPath) && hasCreateVerbInTitle(task)) return true;
  return tIdxs.length > 0 && (CREATE_FILE_VERBS_RE.test(win(tIdxs[0])) || tIdxs.some((i) => WRITE_FILE_PHRASE_RE.test(win(i)) || DIRECT_CREATE_RE.test(win(i)) || ONCE_IT_EXISTS_AFTER_RE.test(afterWin(i))));
}

// 2026-11-09 (pf-lessons hub pieces): does the task text have a "Files:" line that
// EXACTLY lists the target path as one of its comma-separated entries?
function hasFilesLineListing(taskText, targetPath) {
  const lines = String(taskText || '').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('Files:')) continue;
    const entries = trimmed.slice('Files:'.length).split(',');
    for (const entry of entries) {
      if (entry.trim() === targetPath) return true;
    }
  }
  return false;
}

// 2026-11-09 (pf-lessons hub pieces): does the first line (title) of the task text
// contain a create-intent verb near its start?
function hasCreateVerbInTitle(taskText) {
  const lines = String(taskText || '').split('\n');
  const title = (lines[0] || '').trim();
  if (!title) return false;
  // Check the first 100 chars of the title for a create-intent verb
  const titlePrefix = title.slice(0, 100);
  return /\b(?:create|add|write|draft|new)\b/i.test(titlePrefix);
}

// (task, planText, repoRoot, extraRoots, existsAtRef) -> { blocked, reason?, missing? }
// existsAtRef (optional, injected so this stays a pure wrapper): (claimedPath) => boolean, "does it exist on the branch this task really builds
// on". A STACKED task's files live on its shared branch tip, which the working tree at repoRoot does not show, so a target only that branch has
// is real, not fabricated. It can only RESCUE a path the working-tree check called missing; a throw or a false leaves the verdict unchanged.

// 2026-11-08: explicit type field support. Plans can now declare targets as `{type: 'create', path: '...'}` or `{type: 'modify', path: '...'}`.
// Create targets skip the existence check; modify targets must exist. This is cleaner than the heuristic isDeclaredCreateTarget for plans that
// explicitly state their intent. The regex captures both JSON-like and prose forms: {type: 'create', path: 'x'}, {type: "modify", path: "y"}, etc.
const EXPLICIT_TYPE_RE = /\{[^}]*type\s*:\s*['"]?(create|modify)['"]?[^}]*path\s*:\s*['"]?([^'"}\s]+)['"]?[^}]*\}/gi;

function extractExplicitTypes(planText) {
  const types = new Map();
  if (!planText) return types;
  let m;
  while ((m = EXPLICIT_TYPE_RE.exec(planText)) !== null) {
    const type = m[1].toLowerCase();
    const path = m[2];
    types.set(path, type);
  }
  return types;
}

function planTargetGuard(task, planText, repoRoot, extraRoots = [], existsAtRef = null) {
  let targets = [];
  try { targets = extractDeclaredTargets(task, planText); } catch { targets = []; }
  
  // 2026-11-08: also extract paths from explicit type declarations
  const explicitTypes = extractExplicitTypes(planText);
  for (const [path, type] of explicitTypes) {
    if (!targets.includes(path)) {
      targets.push(path);
    }
  }
  
  if (!targets.length || !repoRoot) return { blocked: false };

  const checked = checkFilePaths(targets.join(', '), repoRoot, extraRoots);
  
  // 2026-11-08: categorize targets by type, using resolvedPath when available
  const createPaths = [];
  const modifyPaths = [];
  for (const entry of checked) {
    // Use resolvedPath if the file was found at a different location
    let effectivePath = entry.claimedPath;
    if (entry.resolvedPath) {
      // Strip repoRoot prefix to get relative path
      const normalizedRepoRoot = repoRoot.replace(/\\/g, '/').replace(/\/$/, '');
      const normalizedResolved = entry.resolvedPath.replace(/\\/g, '/');
      if (normalizedResolved.startsWith(normalizedRepoRoot + '/')) {
        effectivePath = normalizedResolved.slice(normalizedRepoRoot.length + 1);
      }
    }
    
    if (explicitTypes.get(entry.claimedPath) === 'create' || (entry.exists === false && isDeclaredCreateTarget(planText, entry.claimedPath, taskTextOf(task)))) {
      createPaths.push(effectivePath);
    } else {
      modifyPaths.push(effectivePath);
    }
  }
  
  // 2026-11-08: filter out create targets from missing check; they don't need to exist
  const missing = checked.filter((entry) => {
    if (entry.exists !== false) return false;
    if (existsOnBranch(existsAtRef, entry.claimedPath)) return false;
    // Explicit type 'create' exempts the target
    if (explicitTypes.get(entry.claimedPath) === 'create') return false;
    // Heuristic fallback: isDeclaredCreateTarget for backward compatibility
    if (isDeclaredCreateTarget(planText, entry.claimedPath, taskTextOf(task))) return false;
    return true;
  });

  if (missing.length === 0) return { blocked: false, targetSummary: { create: createPaths, modify: modifyPaths } };

  // 2026-11-08: for missing files, check if they were resolved to a different location
  const resolvedMissing = missing.map((entry) => {
    if (entry.resolvedPath) {
      // Strip repoRoot prefix to get relative path
      const normalizedRepoRoot = repoRoot.replace(/\\/g, '/').replace(/\/$/, '');
      const normalizedResolved = entry.resolvedPath.replace(/\\/g, '/');
      let resolvedRelative = entry.resolvedPath;
      if (normalizedResolved.startsWith(normalizedRepoRoot + '/')) {
        resolvedRelative = normalizedResolved.slice(normalizedRepoRoot.length + 1);
      }
      return { ...entry, effectivePath: resolvedRelative, wasResolved: true };
    }
    return { ...entry, effectivePath: entry.claimedPath, wasResolved: false };
  });
  
  // If all missing files were resolved, treat as not blocked
  if (resolvedMissing.every((e) => e.wasResolved)) {
    return { blocked: false, targetSummary: { create: createPaths, modify: modifyPaths } };
  }

  const paths = resolvedMissing.map((entry) => entry.effectivePath);
  
  // 2026-11-08: include actionable feedback suggesting to mark as create target
  // Ambiguous: a bare name matched more than one real file. List the candidates so the operator can pick one.
  const ambiguous = resolvedMissing.filter((e) => Array.isArray(e.candidates) && e.candidates.length > 1);
  const candidateNote = ambiguous.length
    ? ' -- ambiguous, candidate paths: ' + ambiguous.map((e) => e.claimedPath + ' => ' + e.candidates.map((c) => c.split(repoRoot.replace(/\/$/, '') + '/').join('')).join(' | ')).join('; ')
    : '';
  const feedback = ' -- mark as a create target (e.g. "create `' + paths[0] + '`)") or correct the path' + candidateNote;
  
  return {
    blocked: true,
    reason: 'plan cites missing-file target(s): ' + paths.join(', ') + feedback + (hasHumanDecision(task) ? HUMAN_DECISION_HINT : ''),
    missing: paths,
    targetSummary: { create: createPaths, modify: modifyPaths },
  };
}

// 2026-10-30 (HUB0088-02 sat through six identical blocks after a human had corrected the path in prose): once the task already carries a
// 'HUMAN DESIGN DECISION' block the operator needs to know the way out is a `Files:` line in the answer, which replaces the stale one.
// Appended AFTER the comma-joined path list so consumers that match only the prefix (src/lib/gate-readmit.js PLAN_TARGET_REASON_RE) are unaffected.
const HUMAN_DECISION_HINT = ' -- a human decision exists on this task: answer it again with a "Files:" line naming the real paths to correct the target';
const hasHumanDecision = (task) => /HUMAN DESIGN DECISION/.test((task && task.promptContext && task.promptContext.rawText) || '');

const taskTextOf = (task) => `${(task && task.title) || ''}\n${(task && task.promptContext && task.promptContext.rawText) || ''}`;

function existsOnBranch(existsAtRef, claimedPath) {
  if (typeof existsAtRef !== 'function') return false;
  try { return existsAtRef(claimedPath) === true; } catch { return false; }
}

module.exports = { planTargetGuard, isDeclaredCreateTarget };
