'use strict';

// deterministic-extract.js -- extracted from src/local-draft.js ([[hub-task-integration]] node-module decompose).

const fs = require('fs');
const path = require('path');
const { appendHistoryEvent, setHistoryPersistHook } = require('../task-history.js');
const {
  beginDraftAttempt, recordPlan, recordImplement, recordCritique, recordOrient, recordPlanCritique, recordTier, finalizeDraftAttempt,
} = require('../draft-attempt-record.js');
const { getConfig, ensureRegistered } = require('../config.js');
const { resolveGroundingRef, readFileAtRef } = require('../stacked-grounding.js');
const { localOllamaLockKey, writeTaskJson, researchClaudeStatus, isResearchDomainTask, draftDoneDetail, concludeDraft } = require('./draft-lifecycle.js');

function computePlanNumPredict(task) {
  const ctx = task.promptContext;
  const hasLargeEvidenceBundle = !!(ctx && ctx.evidenceText && ctx.evidenceText.length > 10000);
  const hasLargePromptContext = !!(ctx && JSON.stringify(ctx).length > 6000);
  // change_review (2026-09-19, same incident as implement-critique.js's computeImplementBudget
  // comment): its PART 1 plan pass has to walk EVERY hunk of ctx.unitDiff, one line of
  // classification each. The generic "large prompt context" branch below already gives a
  // change_review task with a 9000-char diff the 2800 floor, and that was fine -- but a
  // genuinely large diff (>10000 chars) exhausted that SAME 2800 purely to think:true's
  // reasoning trace before a single plan line got written (confirmed live: change-review-
  // 7eecbfa's 15057-char diff and change-review-b8a6f21's 12202-char diff, both a 0-char
  // plan on every attempt). Only kicks in above the existing threshold's own proven-good
  // range, so the flat 2800 stays exactly as before for every diff size already confirmed
  // to work with it.
  const unitDiffChars = (ctx && ctx.unitDiff) ? ctx.unitDiff.length : 0;
  if (unitDiffChars > 10000) return Math.min(8000, Math.max(6000, Math.ceil(unitDiffChars / 3)));
  return (ctx && ctx.brainDumpEntryId) || hasLargeEvidenceBundle || hasLargePromptContext ? 2800 : 1400;
}

function tryDeterministicScriptExtractEdit(task, attempt) {
  const ctx = task.promptContext;
  if (!(ctx && ctx.deterministicApply === 'script-extract' && ctx.sourceFile && ctx.newFile && Array.isArray(ctx.symbols) && ctx.symbols.length)) {
    return null;
  }
  let repoRoot;
  try { ({ repoRoot } = getConfig()); } catch { return null; }
  if (!repoRoot) return null;

  // 2026-09-09, root-caused live (file-decompose-hub-autodecomp-adhoc-add-job-stage-
  // groups-...): this used to always read the plain repoRoot working tree, which for a
  // stacked file-decompose sub-task is main's content, not the shared stacked branch's --
  // already missing earlier sibling moves already extracted from it. The `find`/`replace`
  // pair below got built from the wrong base, so it verified fine in isolation (against
  // itself) but failed a real `git apply` once actually applied to the real stacked
  // branch. Same missing concept already fixed at 5 other call sites via
  // stacked-grounding.js's resolveGroundingRef -- groundingRef is null for any non-stacked
  // task, so every non-stacked caller reads exactly as before.
  const groundingRef = resolveGroundingRef(task, repoRoot);
  let html;
  if (groundingRef) {
    html = readFileAtRef(repoRoot, groundingRef, ctx.sourceFile);
    if (html === null) return null;
  } else {
    const absSource = path.join(repoRoot, ctx.sourceFile);
    try { html = fs.readFileSync(absSource, 'utf8'); } catch { return null; }
  }

  // isHtml (2026-09-08, Grimmethy: "Yes, please build it" -- see script-extract.js's own
  // header for the review-task.js incident this closes): a plain .js/.mjs/.cjs source now
  // ALSO gets this deterministic short-circuit, not just .html -- buildExtraction returns
  // `newSource` (the whole rewritten file) instead of `newHtml` for that case, since there
  // is no <script> tag/insertion-point rewriting to do.
  const isHtml = /\.html?$/.test(ctx.sourceFile);
  const { buildExtraction } = require('../script-extract.js');
  const extraction = buildExtraction(html, ctx.symbols, { isHtml });
  if (!extraction.ok) {
    // Drifted since plan-validation time (e.g. an earlier stacked move on this same
    // branch already touched the file) -- fall through to the normal path rather than
    // trust a check that's no longer true. Advisory only, never a block: the model-
    // driven path below is exactly what would have run if this short-circuit didn't
    // exist at all.
    appendHistoryEvent(task, 'advisory', `deterministic script-extract check no longer holds (${extraction.problems.map((p) => `${p.name}: ${p.status}`).join('; ')}) -- falling through to the normal drafting path`);
    return null;
  }

  const groupBChanges = [
    { mode: 'create', file: ctx.newFile, content: extraction.newFileContent },
    { mode: 'edit', file: ctx.sourceFile, find: html, replace: isHtml ? extraction.newHtml : extraction.newSource },
  ];

  // adhoc-domain tasks apply via applyAdhocDiff (apply-task.js's writeArtifact ->
  // source.apply), which reads task.rawDiff -- a REAL unified diff -- and has never
  // looked at task.implementResponse at all. Real incident, 2026-09-07: this short-
  // circuit originally only ever set task.implementResponse to the Group-B JSON above,
  // so review correctly verified and approved it, then apply silently did nothing at
  // all ("adhoc agentic draft produced no diff") because task.rawDiff was never set --
  // the task landed in queue/done/ marked succeeded despite zero real changes reaching
  // the repo. group-b-worktree-diff.js already exists for exactly this conversion (the
  // adhoc write-tier's own real diffs are produced the identical way) -- reused here
  // rather than hand-rolling unified-diff text, so the SAME proven git-apply-verified
  // path produces it. It also re-confirms the Group-B change still applies cleanly
  // against real origin/<main> content (not just the repoRoot snapshot read above),
  // throwing (caught below, falls through to the normal path) if that has ALSO drifted.
  // `task` passed through (2026-09-09) so a stacked sub-task's diff is captured against
  // its own shared branch, not main -- see captureGroupBDiffInWorktree's own header for
  // the real incident this closes.
  const { pipelineDir } = getConfig();
  let rawDiff;
  try {
    const { captureGroupBDiffInWorktree } = require('../group-b-worktree-diff.js');
    rawDiff = captureGroupBDiffInWorktree({
      repoRoot, pipelineDir, implementResponse: JSON.stringify(groupBChanges), worktreeSuffix: task.id, task,
    });
  } catch (e) {
    appendHistoryEvent(task, 'advisory', `deterministic script-extract diff capture failed (${String(e && e.message || e).slice(0, 200)}) -- falling through to the normal drafting path`);
    return null;
  }
  if (!rawDiff) {
    appendHistoryEvent(task, 'advisory', 'deterministic script-extract move produced an empty diff against real origin content -- falling through to the normal drafting path');
    return null;
  }

  task.planResponse = 'Deterministic script-extract move: every named symbol resolves to a real, unambiguous top-level function declaration via script-extract.js\'s V8-parser oracle -- no search terms or model judgment needed.';
  recordPlan(attempt, { text: task.planResponse, attempts: 0 });
  appendHistoryEvent(task, 'plan-done', 'deterministic script-extract, no model call');

  // implementResponse (the Group-B JSON) stays -- this is what review's own
  // verifyDeterministicScriptExtractDraft gate inspects. rawDiff (the real unified diff,
  // just captured above) is the separate field apply actually consumes for an adhoc task.
  task.implementResponse = JSON.stringify(groupBChanges);
  task.rawDiff = rawDiff;
  task.adhocResolution = 'implemented';
  recordImplement(attempt, { text: task.implementResponse, note: `deterministic script-extract move (${ctx.symbols.length} symbol(s), V8-parser-verified)` });
  appendHistoryEvent(task, 'implement-done', `deterministic script-extract move: ${ctx.symbols.length} symbol(s) moved to ${ctx.newFile}, no model call`);

  task.critiqueOutcome = 'no-issues';
  recordCritique(attempt, { outcome: 'no-issues' });
  appendHistoryEvent(task, 'critique-done', 'no-issues (deterministic move, nothing for a critique pass to add)');

  concludeDraft(task);
  return { succeeded: true, blocked: false };
}

function tryDeterministicOnePassDecompose(task, attempt) {
  const ctx = task.promptContext;
  if (!(ctx && ctx.deterministicApply === 'one-pass-decompose' && ctx.sourceFile
        && Array.isArray(ctx.moves) && ctx.moves.length >= 2)) {
    return null;
  }
  let repoRoot; let pipelineDir;
  try { ({ repoRoot, pipelineDir } = getConfig()); } catch { return null; }
  if (!repoRoot) return null;

  // Never stacked -- read the plain working tree (the worktree diff capture below
  // re-verifies against real origin/<main>).
  let sourceText;
  try { sourceText = fs.readFileSync(path.join(repoRoot, ctx.sourceFile), 'utf8'); } catch { return null; }

  const { buildOnePassGroupBChanges } = require('../decompose-one-pass.js');
  const built = buildOnePassGroupBChanges(sourceText, ctx.sourceFile, ctx.moves);
  if (!built.ok) {
    appendHistoryEvent(task, 'advisory', `deterministic one-pass decompose not applicable (${built.reason}) -- falling through to the normal drafting path`);
    return null;
  }

  let rawDiff;
  try {
    const { captureGroupBDiffInWorktree } = require('../group-b-worktree-diff.js');
    rawDiff = captureGroupBDiffInWorktree({
      repoRoot, pipelineDir, implementResponse: JSON.stringify(built.changes), worktreeSuffix: task.id, task,
    });
  } catch (e) {
    appendHistoryEvent(task, 'advisory', `deterministic one-pass decompose diff capture failed (${String(e && e.message || e).slice(0, 200)}) -- falling through to the normal drafting path`);
    return null;
  }
  if (!rawDiff) {
    appendHistoryEvent(task, 'advisory', 'deterministic one-pass decompose produced an empty diff against real origin content -- falling through to the normal drafting path');
    return null;
  }

  const symCount = ctx.moves.reduce((n, m) => n + (m.symbols || []).length, 0);
  task.planResponse = `Deterministic one-pass decomposition: ${ctx.moves.length} module(s), ${symCount} symbol(s), every one a V8-parser-verified top-level declaration -- no model judgment needed.`;
  recordPlan(attempt, { text: task.planResponse, attempts: 0 });
  appendHistoryEvent(task, 'plan-done', 'deterministic one-pass decompose, no model call');

  task.implementResponse = JSON.stringify(built.changes);
  task.rawDiff = rawDiff;
  task.adhocResolution = 'implemented';
  recordImplement(attempt, { text: task.implementResponse, note: `deterministic one-pass decompose (${ctx.moves.length} module(s), ${symCount} symbol(s), V8-parser-verified)` });
  appendHistoryEvent(task, 'implement-done', `deterministic one-pass decompose: ${symCount} symbol(s) into ${ctx.moves.length} module(s) + <script> wiring, no model call`);

  task.critiqueOutcome = 'no-issues';
  recordCritique(attempt, { outcome: 'no-issues' });
  appendHistoryEvent(task, 'critique-done', 'no-issues (deterministic move, nothing for a critique pass to add)');

  concludeDraft(task);
  return { succeeded: true, blocked: false };
}

function tryDeterministicNodeModuleDecompose(task, attempt) {
  const ctx = task.promptContext;
  if (!(ctx && ctx.deterministicApply === 'node-module-decompose' && ctx.sourceFile
        && Array.isArray(ctx.moves) && ctx.moves.length >= 1)) {
    return null;
  }
  let repoRoot; let pipelineDir;
  try { ({ repoRoot, pipelineDir } = getConfig()); } catch { return null; }
  if (!repoRoot) return null;

  let sourceText;
  try { sourceText = fs.readFileSync(path.join(repoRoot, ctx.sourceFile), 'utf8'); } catch { return null; }

  const { buildNodeModuleOnePassChanges } = require('../decompose-node-module.js');
  const built = buildNodeModuleOnePassChanges(sourceText, ctx.sourceFile, ctx.moves, repoRoot);
  if (!built.ok) {
    appendHistoryEvent(task, 'advisory', `deterministic node-module decompose not applicable (${built.reason}) -- falling through to the normal drafting path`);
    return null;
  }

  // 2026-09-14 removed: a redundant, ADDITIONAL parse-check here (`new vm.Script(text)`
  // on every produced file) that was strictly WEAKER than buildNodeModuleOnePassChanges's
  // own firstNodeCheckError just above (real `node --check`, added later -- 2026-09-09
  // incident, see decompose-node-module.js's own header) -- and actively WRONG for a
  // common, valid pattern: `new vm.Script(text)` compiles `text` as a bare top-level
  // script with NO CommonJS module wrapper, so a perfectly legal top-level `return`
  // inside `if (require.main === module) { ... return; }` (this codebase's own standard
  // CLI-entry-point guard, e.g. task-sources.js's own --priority-map/--pending-readiness
  // handlers) throws "Illegal return statement" here even though real `node --check` (and
  // real `require()`) both correctly treat it as legal, since Node's actual module
  // wrapper IS a function. Caught live 2026-09-14: task-sources.js's own deterministic
  // decompose fell through to the full agentic drafting path on every single attempt,
  // purely because of this false positive -- `built.ok` above already proves the file
  // parses and requires cleanly; this check added nothing but a stricter, buggier retest.

  let rawDiff;
  try {
    const { captureGroupBDiffInWorktree } = require('../group-b-worktree-diff.js');
    rawDiff = captureGroupBDiffInWorktree({
      repoRoot, pipelineDir, implementResponse: JSON.stringify(built.changes), worktreeSuffix: task.id, task,
    });
  } catch (e) {
    appendHistoryEvent(task, 'advisory', `deterministic node-module decompose diff capture failed (${String(e && e.message || e).slice(0, 200)}) -- falling through to the normal drafting path`);
    return null;
  }
  if (!rawDiff) {
    appendHistoryEvent(task, 'advisory', 'deterministic node-module decompose produced an empty diff against real origin content -- falling through to the normal drafting path');
    return null;
  }

  const symCount = ctx.moves.reduce((n, m) => n + (m.symbols || []).length, 0);
  task.planResponse = `Deterministic one-pass CommonJS decomposition: ${ctx.moves.length} module(s), ${symCount} function(s), every one a V8-parser-verified self-contained top-level declaration -- no model judgment needed.`;
  recordPlan(attempt, { text: task.planResponse, attempts: 0 });
  appendHistoryEvent(task, 'plan-done', 'deterministic node-module decompose, no model call');

  task.implementResponse = JSON.stringify(built.changes);
  task.rawDiff = rawDiff;
  task.adhocResolution = 'implemented';
  recordImplement(attempt, { text: task.implementResponse, note: `deterministic node-module decompose (${ctx.moves.length} module(s), ${symCount} function(s), V8-parser-verified)` });
  appendHistoryEvent(task, 'implement-done', `deterministic node-module decompose: ${symCount} function(s) into ${ctx.moves.length} module(s) + require() wiring, no model call`);

  task.critiqueOutcome = 'no-issues';
  recordCritique(attempt, { outcome: 'no-issues' });
  appendHistoryEvent(task, 'critique-done', 'no-issues (deterministic move, nothing for a critique pass to add)');

  concludeDraft(task);
  return { succeeded: true, blocked: false };
}

function tryDeterministicBlueprintDecompose(task, attempt) {
  const ctx = task.promptContext;
  if (!(ctx && ctx.deterministicApply === 'blueprint-decompose' && ctx.sourceFile
        && Array.isArray(ctx.moves) && ctx.moves.length >= 1)) {
    return null;
  }
  let repoRoot; let pipelineDir;
  try { ({ repoRoot, pipelineDir } = getConfig()); } catch { return null; }
  if (!repoRoot) return null;

  let sourceText;
  try { sourceText = fs.readFileSync(path.join(repoRoot, ctx.sourceFile), 'utf8'); } catch { return null; }

  const { buildBlueprintOnePassChanges } = require('../decompose-flask-blueprint.js');
  const built = buildBlueprintOnePassChanges(sourceText, ctx.sourceFile, ctx.moves);
  if (!built.ok) {
    appendHistoryEvent(task, 'advisory', `deterministic blueprint decompose not applicable (${built.reason}) -- falling through to the normal drafting path`);
    return null;
  }
  // buildBlueprintOnePassChanges already runs `python3 -m py_compile` on every produced
  // file before returning ok -- no separate parse check needed here.

  let rawDiff;
  try {
    const { captureGroupBDiffInWorktree } = require('../group-b-worktree-diff.js');
    rawDiff = captureGroupBDiffInWorktree({
      repoRoot, pipelineDir, implementResponse: JSON.stringify(built.changes), worktreeSuffix: task.id, task,
    });
  } catch (e) {
    appendHistoryEvent(task, 'advisory', `deterministic blueprint decompose diff capture failed (${String(e && e.message || e).slice(0, 200)}) -- falling through to the normal drafting path`);
    return null;
  }
  if (!rawDiff) {
    appendHistoryEvent(task, 'advisory', 'deterministic blueprint decompose produced an empty diff against real origin content -- falling through to the normal drafting path');
    return null;
  }

  const routeCount = ctx.moves.reduce((n, m) => n + (m.symbols || []).length, 0);
  task.planResponse = `Deterministic one-pass Flask-Blueprint decomposition: ${ctx.moves.length} blueprint(s), ${routeCount} route(s), AST-extracted + py_compile-verified -- no model judgment needed.`;
  recordPlan(attempt, { text: task.planResponse, attempts: 0 });
  appendHistoryEvent(task, 'plan-done', 'deterministic blueprint decompose, no model call');

  task.implementResponse = JSON.stringify(built.changes);
  task.rawDiff = rawDiff;
  task.adhocResolution = 'implemented';
  recordImplement(attempt, { text: task.implementResponse, note: `deterministic blueprint decompose (${ctx.moves.length} blueprint(s), ${routeCount} route(s), AST + py_compile)` });
  appendHistoryEvent(task, 'implement-done', `deterministic blueprint decompose: ${routeCount} route(s) into ${ctx.moves.length} blueprint(s) + register_blueprint wiring, no model call`);

  task.critiqueOutcome = 'no-issues';
  recordCritique(attempt, { outcome: 'no-issues' });
  appendHistoryEvent(task, 'critique-done', 'no-issues (deterministic move, nothing for a critique pass to add)');

  concludeDraft(task);
  return { succeeded: true, blocked: false };
}

function tryDeterministicLiteralEdit(task, attempt) {
  const literalEditLiterals = (task.promptContext && Array.isArray(task.promptContext.fixedLiterals))
    ? task.promptContext.fixedLiterals
    : [];
  if (!(task.promptContext && typeof task.promptContext.file === 'string' && task.promptContext.file
    && typeof task.promptContext.find === 'string' && task.promptContext.find
    && literalEditLiterals.length === 1 && typeof literalEditLiterals[0].content === 'string' && literalEditLiterals[0].content)) {
    return null;
  }
  task.implementResponse = JSON.stringify({
    mode: 'edit',
    file: task.promptContext.file,
    find: task.promptContext.find,
    replace: literalEditLiterals[0].content,
  });
  recordImplement(attempt, { text: task.implementResponse, note: 'deterministic find/replace (fully specified in the task)' });
  appendHistoryEvent(task, 'implement-done', 'deterministic find/replace (file, find, and the single fixedLiterals block were all fully specified in the task -- constructed directly instead of asking the model to reproduce content it was already handed verbatim)');
  concludeDraft(task);
  return { succeeded: true, blocked: false };
}

module.exports = { computePlanNumPredict, tryDeterministicScriptExtractEdit, tryDeterministicOnePassDecompose, tryDeterministicNodeModuleDecompose, tryDeterministicBlueprintDecompose, tryDeterministicLiteralEdit };
