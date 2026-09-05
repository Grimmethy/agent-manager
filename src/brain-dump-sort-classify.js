'use strict';

// Classification helpers for the `brain_dump_sort` source, extracted from apply-group-a.js
// (2026-09-03) so task-sources.js can reference the validator at registration time without
// a task-sources.js <-> apply-group-a.js require cycle -- the same modularization lesson
// review-task.js's EMPTY_APPROVAL dedup already learned. apply-group-a.js re-exports every
// name here so its existing require()rs and tests are unchanged.
//
// The source now uses a DETERMINISTIC review (see review-task.js's deterministicReview
// branch): the LLM majority vote was rejecting valid classifications on folder/filename
// nitpicks its own guidance explicitly forbade -- confirmed live, 8 permanently-blocked
// tasks, one reject literally quoting the review guidance back as its reason. parse +
// validate + a tracked-label check is the whole gate now.

const fs = require('fs');
const path = require('path');
const { parseJsonMaybeFenced } = require('./json-fence.js');

// The ONLY valid top-level folders for a filed note, besides a registered project label
// (which becomes its own top-level folder on first use). Machine-written dirs
// ("Agent Manager Reports/", "Model Benchmarks/", "OrnithDebug/") are deliberately NOT
// here -- the classifier never targets them and renaming them would ripple into
// system-report.js / reasoning-bench.js / app.py's _reports_root/_second_brain_bench_dir.
// Kept in sync with scripts/migrate-second-brain-taxonomy.js and fed into
// brainDumpSortPlanPrompt so the prompt and this validator never drift.
const CANONICAL_TOP_LEVEL = ['Projects', 'Journal', 'References', 'Ideas', 'Research', 'Characters', 'StoryImages'];

// A local model routinely writes the literal string "null" / "none" / "n/a" / "" for a
// field that should be a JSON null. Treat all of those as absent.
function nullishString(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s && !['null', 'none', 'n/a', 'na', 'nil', 'undefined'].includes(s.toLowerCase()) ? s : null;
}

// Bare, undifferentiated filenames that give no hint what the note is actually about --
// confirmed live 2026-08-16: the local model filed a real note under plain "ideas.md",
// indistinguishable at a glance from any other idea ever captured. Checked against the
// FINAL path segment's stem only (no extension) -- a folder named "Ideas/" is fine (that's
// a category), a FILE named "ideas.md" is not (that's the note's own name doing zero work).
const GENERIC_FILENAME_BLOCKLIST = new Set([
  'ideas', 'idea', 'notes', 'note', 'misc', 'miscellaneous', 'stuff', 'todo', 'todos',
  'random', 'general', 'other', 'things', 'inbox', 'info', 'information', 'data', 'new',
  'untitled', 'temp', 'draft', 'journal', 'log',
]);

// Parses brain_dump_sort's implement-pass output -- a single JSON object, not markdown
// (see prompts.js's brainDumpSortImplementPrompt for the exact schema). Returns null on
// anything unparseable or missing secondBrainPath, rather than throwing -- callers treat
// null as "left as captured, retry next tick," the same non-fatal-skip convention every
// other Group A parser uses. `category` is NOT required (it was written but never read --
// 100% null across every real entry -- so demanding it only ever produced dead entries).
function parseBrainDumpSortResult(implementResponse) {
  const text = (implementResponse || '').trim();
  if (!text) return null;
  let parsed;
  try {
    // parseJsonMaybeFenced, not a bare JSON.parse -- the local model routinely wraps its
    // output in a ```json fence despite the prompt asking for none (confirmed live
    // 2026-07-26, a fully-approved classification stuck 'captured' forever because of it).
    parsed = parseJsonMaybeFenced(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (!parsed.secondBrainPath) return null;
  return {
    // Strip a leading slash -- path.join(secondBrainDir, '/Projects/foo.md') resolves
    // relative on POSIX but an absolute-looking second segment can behave surprisingly on
    // some platforms; normalize here rather than rely on path.join's platform handling.
    secondBrainPath: String(parsed.secondBrainPath).replace(/^[/\\]+/, '').trim(),
    tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
    actionable: !!parsed.actionable,
    rationale: parsed.rationale ? String(parsed.rationale).trim() : '',
    belongsToProject: nullishString(parsed.belongsToProject),
    requiresResearch: !!parsed.requiresResearch,
    // 2026-08-24 (pipeline hardening): the classifier is shown already-queued task titles
    // and flags a near-duplicate here; null/absent means it saw nothing similar.
    // nullishString: the 27B routinely emits the literal STRING "null" / "none" / "N/A"
    // instead of a JSON null -- confirmed live 2026-09-02, a real function_length_fix bug
    // report held on `possibleDuplicateOf: "null"` treated as a real duplicate title.
    possibleDuplicateOf: nullishString(parsed.possibleDuplicateOf),
    // 2026-09-03 (auto-wikilink on filing): 0-5 existing note basenames this note relates
    // to. Sanitized -- drop any .md suffix and path separators so it can only ever name a
    // basename, never traverse.
    relatedNotes: Array.isArray(parsed.relatedNotes)
      ? parsed.relatedNotes
        .map((n) => String(n).replace(/\.md$/i, '').replace(/[\\/]/g, '').trim())
        .filter(Boolean)
        .slice(0, 5)
      : [],
  };
}

// Rejects a proposed secondBrainPath outright (returns a reason string) rather than
// silently accepting it. Checks, all about a name/location actively working against future
// retrieval rather than style preference:
//   1. the path is a bare vault-root file (no folder) -- notes must live in a category.
//   2. the file's own basename is a bare generic word (see blocklist).
//   3. the top-level folder is not one of the canonical folders or a registered project
//      label -- the taxonomy is fixed now, "invent a new top-level folder per entry"
//      defeats the point of a second brain.
//   4. (better error) the top-level folder is a different-case duplicate of an existing one.
// Returns null when the path is fine.
function validateSecondBrainPath(relPath, secondBrainDir, trackedProjectLabels = []) {
  const segments = String(relPath || '').split(/[\\/]/).filter(Boolean);
  if (segments.length === 0) return 'secondBrainPath is empty';
  if (segments.length < 2) {
    return `secondBrainPath "${relPath}" is a bare vault-root file -- file it inside a top-level folder (${CANONICAL_TOP_LEVEL.join(', ')}, or a tracked project label)`;
  }

  const baseName = segments[segments.length - 1];
  const stem = baseName.replace(/\.[^./]+$/, '').toLowerCase().trim();
  if (GENERIC_FILENAME_BLOCKLIST.has(stem)) {
    return `filename "${baseName}" is too generic to find again later -- name it after the actual subject of the note (e.g. "ebay-cross-post-automation.md", not "ideas.md")`;
  }

  const topLevel = segments[0];
  const allowed = new Set([...CANONICAL_TOP_LEVEL, ...(Array.isArray(trackedProjectLabels) ? trackedProjectLabels : [])]);
  if (!allowed.has(topLevel)) {
    return `top-level folder "${topLevel}" is not one of the allowed second-brain folders (${[...allowed].join(', ')}) -- file this under the closest existing one`;
  }

  if (secondBrainDir) {
    let existingNames;
    try {
      existingNames = fs.readdirSync(secondBrainDir, { withFileTypes: true })
        .filter((e) => !e.name.startsWith('.'))
        .map((e) => e.name);
    } catch {
      existingNames = [];
    }
    const conflict = existingNames.find((name) => name.toLowerCase() === topLevel.toLowerCase() && name !== topLevel);
    if (conflict) {
      return `top-level folder "${topLevel}" is a different-case duplicate of the existing "${conflict}" -- reuse "${conflict}" exactly`;
    }
  }

  return null;
}

// Does `checkText` show a real, concrete connection to `selfLabel` -- a change verb PLUS a
// subject that's actually about this pipeline? Shared by two call sites in
// deriveBelongsToProject below: the self-project RECOVERY path (classifier left the label
// null/bogus, checked against rawText+rationale, unchanged from before this function was
// extracted) and the self-project ASSERTION guard (classifier explicitly claimed the
// self-label -- checked against rawText ALONE, never the classifier's own rationale, which
// is exactly what a hallucinated claim fabricates to justify itself. Root-caused live
// 2026-09-05: 3 confirmed incidents -- a note about Instagram sticker art, one about
// sand-battery insulation, one titled "Climate finance solutions" -- each got
// `belongsToProject: "agent-manager"` from the classifier with a fabricated rationale
// ("...a feature related to handling drafts...", "...the start_research_on_thermal_batteries
// feature...") inventing a connection that doesn't exist in the note itself).
function hasSelfProjectSignal(checkText, selfLabel) {
  const hasChangeVerb = /\b(add|fix|should|shouldn't|need|needs|make|change|changing|refactor|implement|support|remove|rename|persist|track|wire|handle|prevent|ensure|allow|expose|surface|store|stop|drop|split|guard|race|reset|expand)\b/i.test(checkText);
  const selfSubject = (selfLabel && checkText.toLowerCase().includes(selfLabel.toLowerCase()))
    || /\b(pipeline|dashboard|brain[- ]?dump|second[- ]?brain|worker|queue|review|apply|task[- ]?source|draft(?:ing)?|adhoc|prompt|classifier|coordinat|watchdog|reject-retry)\b/i.test(checkText);
  return hasChangeVerb && selfSubject;
}

// Recovers `belongsToProject` when the classifier left it null (or set a label that isn't
// tracked) for a note that is plainly a concrete change to this pipeline's own codebase --
// the dominant failure of the blocked backlog. Returns { belongsToProject, actionable }
// with both possibly rewritten. Deterministic, not a prompt tweak the 27B keeps ignoring.
function deriveBelongsToProject(parsed, promptContext = {}) {
  const trackedLabels = Array.isArray(promptContext.projectLabels) ? promptContext.projectLabels : [];
  const rawLabel = nullishString(parsed.belongsToProject);
  const actionable = !!parsed.actionable;
  const rawText = String(promptContext.rawText || '');
  const text = `${rawText}\n${parsed.rationale || ''}`;
  const selfLabel = promptContext.selfProjectLabel;

  // A note that is a NEW standalone product/plugin, or a pure creative/worldbuilding
  // concept, is Second Brain content -- never a code task, even if the classifier assigned
  // it a project. Confirmed live 2026-09-02: "New Plugin > World Simulator" and "Character
  // concept > Hooble and the Dragon" both got routed to agent-manager as adhoc tasks.
  const isNoteNotTask =
    /^\s*(new\s+plugin\b|character(?:\s+concept)?\b|story\b|world[- ]?sim|worldbuilding\b|lore\b|\bnpc\b)/i.test(rawText)
    || (/\bplugin\b/i.test(text) && /\b(new|standalone|separate|build a|create a|spin ?up|its own)\b/i.test(text));
  if (isNoteNotTask) return { belongsToProject: null, actionable: false };

  // Already a real tracked label -- trust it, EXCEPT when it's the pipeline's OWN self-label
  // and the note's own rawText shows no real connection to it (see hasSelfProjectSignal's
  // header) -- the exact self-attribution bias that produced 3 confirmed fabricated-feature
  // incidents live. An explicit claim about a DIFFERENT tracked project is unaffected; the
  // evidenced bias is specifically "a model running inside its own pipeline defaults to
  // 'this must be about me' when confused by off-topic content."
  if (rawLabel && trackedLabels.includes(rawLabel)) {
    if (rawLabel === selfLabel && !hasSelfProjectSignal(rawText, selfLabel)) {
      return { belongsToProject: null, actionable: false };
    }
    return { belongsToProject: rawLabel, actionable };
  }

  // The classifier's label is bogus/null but the note's LEADING text (a breadcrumb or
  // first sentence, first ~90 chars) explicitly names exactly one OTHER tracked project --
  // route there rather than self-recovering. Confirmed live: "PromptForge SB Originated
  // Characters don't retain details..." self-recovered to agent-manager on the word "SB".
  // Head-scoped so a passing body mention ("...while the pipeline was pointed at PromptForge")
  // does NOT hijack the routing.
  const head = rawText.slice(0, 90);
  const named = [...new Set(trackedLabels.filter((l) =>
    l !== selfLabel && new RegExp(`\\b${l.replace(/-/g, '[- ]?')}\\b`, 'i').test(head)))];
  if (named.length === 1) {
    return { belongsToProject: named[0], actionable: true };
  }

  // Self-project recovery for a concrete change to this pipeline itself.
  if (selfLabel && !parsed.requiresResearch && hasSelfProjectSignal(text, selfLabel)) {
    return { belongsToProject: selfLabel, actionable: true };
  }

  // No recovery -- return whatever the model said (a bogus label is caught by
  // reviewBrainDumpSort and retried with the valid list as feedback).
  return { belongsToProject: rawLabel, actionable };
}

// The entire review gate for brain_dump_sort. { ok:true } | { ok:false, reason }. A false
// result blocks at review with `reason` -> reject-retry-check folds it into the next
// draft's prompt (an INFORMED retry, not a dead end).
function reviewBrainDumpSort(task, { secondBrainDir, trackedProjectLabels = [] } = {}) {
  const parsed = parseBrainDumpSortResult(task && task.implementResponse);
  if (!parsed) {
    return { ok: false, reason: 'classification is not a valid JSON object with a secondBrainPath field (no fences, no prose, no truncation)' };
  }
  const namingError = validateSecondBrainPath(parsed.secondBrainPath, secondBrainDir, trackedProjectLabels);
  if (namingError) {
    return { ok: false, reason: `secondBrainPath "${parsed.secondBrainPath}": ${namingError}` };
  }
  if (parsed.belongsToProject && !trackedProjectLabels.includes(parsed.belongsToProject)) {
    return {
      ok: false,
      reason: `belongsToProject "${parsed.belongsToProject}" is not a tracked project label (valid: ${trackedProjectLabels.join(', ') || 'none'}) -- use one exactly, or null`,
    };
  }
  return { ok: true };
}

module.exports = {
  CANONICAL_TOP_LEVEL,
  GENERIC_FILENAME_BLOCKLIST,
  parseBrainDumpSortResult,
  validateSecondBrainPath,
  deriveBelongsToProject,
  reviewBrainDumpSort,
};
