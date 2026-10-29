'use strict';

// Deterministic task-shape classifier (no model call). Classifies an adhoc task BEFORE it is drafted from its title, rawText and orient notes into:
//   'investigation' -- read-only; the only deliverable is a findings / documentation file
//   'cross-repo'    -- names a file or path under another repo root
//   'one-file-fix'  -- names exactly one source file (plus at most two tests) and nothing that multiplies the work
//   'multi-file'    -- everything else (the default, so an unclassifiable task behaves exactly as before)
// Checked in that order, and every rule that fires leaves a human-readable reason on the result.
//
// Why it exists (2026-10-15): a read-only "verify the map against three repos" task looped through a decompose answer with no usable pieces, and a bug task was
// split into pieces by the pre-plan scopeComplexityGate (local-agentic-write-draft.js) on path/keyword counts alone. The classifier is consulted at the decompose
// decision only (shapeBlocksDecompose / preliminaryDecomposeDecision) and recorded on the record as task.shape = { class, reasons } for the dashboard and history.
// Kill switch: AGENT_MANAGER_TASK_SHAPE=off (default on).

const path = require('path');

const CODE_EXT = '(?:js|mjs|cjs|ts|tsx|py|sh|ps1|json|css|html|yml|yaml|toml|sql)';
const FILE_RE = new RegExp(`(?<![\\w:/.-])((?:[\\w@.-]+/)*[\\w@.-]+\\.(?:${CODE_EXT}|md))(?![\\w])`, 'g');
const ENDPOINT_RE = /\/(?:api|plugins)\/[A-Za-z0-9_\-/]+/g;
const ABS_PATH_RE = /(?<![\w.:-])(\/(?:[\w.@-]+\/){2,}[\w.@-]*)/g;
const READ_ONLY_RE = /\bread-only\b|\bfindings (?:doc|file)\b|\bwrite (?:only )?(?:the )?(?:one|a single|a new)\b[^.\n]{0,30}\b(?:file|doc)\b|\bnothing else (?:is )?(?:changed|touched)\b|\bchange nothing else\b|\bFILE TO WRITE\b/i;
const EDIT_VERB_RE = /\b(change|edit|modify|fix|rename|refactor|patch|implement)\b/gi;
const NEGATION_BEFORE_RE = /(?:\bnothing|\bno|\bnot|\bnever|\bwithout|n't)\s+(?:else\s+)?$/i;
const MULTIPLICITY_RE = /\b(?:each of|every|across|all callers|all (?:the )?(?:writers|callers|sources))\b/i;

function shapeEnabled() {
  return String(process.env.AGENT_MANAGER_TASK_SHAPE || '').trim().toLowerCase() !== 'off';
}

function taskText(task) {
  const ctx = (task && task.promptContext) || {};
  const parts = [task && task.title, ctx.rawText];
  const notes = String((task && task.orientNotes) || '');
  const m = /EDIT LOCATION\(S\):([\s\S]*?)(?:\nOPEN QUESTION:|$)/.exec(notes);
  if (m) parts.push(m[1]);
  return parts.filter(Boolean).join('\n');
}

const isTestFile = (p) => /\.test\.|(?:^|\/)test_[^/]*$|(?:^|\/)tests?\//.test(p);
const isDocFile = (p) => /\.md$/i.test(p) || /^docs?\//i.test(p);

function namedFiles(text) {
  const byBase = new Map();
  for (const m of text.matchAll(FILE_RE)) {
    const p = m[1].replace(/^\.\//, '');
    if (/node_modules\//.test(p)) continue;
    const base = path.basename(p);
    if (!byBase.has(base) || p.length > byBase.get(base).length) byBase.set(base, p);
  }
  return [...byBase.values()];
}

// A sentence with an un-negated edit verb followed (within 80 chars) by a code path: the task asks for a code change, so it is not a read-only investigation
// even if it also says "read-only" somewhere ("Rename the helper in src/a.js. Nothing else is changed in docs.").
function hasCodeEditImperative(text) {
  const codeRe = new RegExp(`[\\w@./-]+\\.${CODE_EXT}\\b`);
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    for (const m of sentence.matchAll(EDIT_VERB_RE)) {
      if (NEGATION_BEFORE_RE.test(sentence.slice(Math.max(0, m.index - 20), m.index))) continue;
      const after = sentence.slice(m.index + m[0].length, m.index + m[0].length + 80);
      if (codeRe.test(after) && !isDocFile(codeRe.exec(after)[0])) return true;
    }
  }
  return false;
}

function crossRepoPaths(text, roots) {
  const rootList = (Array.isArray(roots) ? roots : []).filter(Boolean).map((r) => path.resolve(r));
  const primary = rootList[0] || null;
  const siblings = rootList.slice(1);
  const parent = primary ? path.dirname(primary) : null;
  const hits = [];
  for (const m of text.matchAll(ABS_PATH_RE)) {
    const p = m[1].replace(/\/+$/, '');
    if (primary && (p === primary || p.startsWith(primary + path.sep))) continue;
    const underSibling = siblings.some((s) => p === s || p.startsWith(s + path.sep));
    const siblingDir = parent && p.startsWith(parent + path.sep) && p.slice(parent.length + 1).split('/')[0] !== path.basename(primary);
    if (underSibling || siblingDir) hits.push(p);
  }
  return [...new Set(hits)];
}

function defaultRoots() {
  try { return require('./accessible-roots.js').resolveAccessibleRoots(); } catch { return []; }
}

function classifyTaskShape(task, { roots } = {}) {
  const text = taskText(task);
  const files = namedFiles(text);
  const docs = files.filter(isDocFile);
  const tests = files.filter((f) => !isDocFile(f) && isTestFile(f));
  const sources = files.filter((f) => !isDocFile(f) && !isTestFile(f));

  const readOnly = READ_ONLY_RE.exec(text);
  if (readOnly && docs.length && !hasCodeEditImperative(text)) {
    return { class: 'investigation', reasons: [`read-only statement: "${readOnly[0].slice(0, 60)}"`, `findings/doc deliverable: ${docs[0]}`] };
  }

  const cross = crossRepoPaths(text, roots || defaultRoots());
  if (cross.length) {
    return { class: 'cross-repo', reasons: [`names ${cross.length} path(s) under another repo root: ${cross.slice(0, 2).join(', ')}`] };
  }

  const endpoints = new Set(text.match(ENDPOINT_RE) || []);
  const numbered = new Set((text.match(/\((\d{1,2})\)/g) || []));
  const multiplicity = MULTIPLICITY_RE.exec(text);
  if (sources.length === 1 && tests.length <= 2 && endpoints.size < 3 && numbered.size < 2 && !multiplicity) {
    return { class: 'one-file-fix', reasons: [`names one source file: ${sources[0]}`, `${tests.length} test file(s), ${endpoints.size} endpoint path(s)`] };
  }

  const reasons = [];
  if (sources.length !== 1) reasons.push(`${sources.length} source files named`);
  if (tests.length > 2) reasons.push(`${tests.length} test files named`);
  if (endpoints.size >= 3) reasons.push(`${endpoints.size} endpoint paths`);
  if (numbered.size >= 2) reasons.push(`${numbered.size} numbered wants`);
  if (multiplicity) reasons.push(`multiplicity wording: "${multiplicity[0]}"`);
  return { class: 'multi-file', reasons: reasons.length ? reasons : ['default'] };
}

// Sets task.shape = { class, reasons } (recomputed each pass; the text does not change but orient notes may). Disabled -> task.shape is removed.
function stampTaskShape(task, opts) {
  if (!task) return null;
  if (!shapeEnabled()) { delete task.shape; return null; }
  task.shape = classifyTaskShape(task, opts);
  return task.shape;
}

function shapeBlocksDecompose(task) {
  return shapeEnabled() && !!(task && task.shape && task.shape.class === 'one-file-fix');
}

// The pre-plan scope gate's verdict, adjusted for the task's shape. one-file-fix -> never decompose (and say why, for the history); investigation -> may decompose
// only along its own questions; multi-file / cross-repo -> the gate's verdict untouched.
function preliminaryDecomposeDecision(task, gate) {
  const g = gate || { shouldDecompose: false };
  const base = { decompose: !!g.shouldDecompose, priorAttemptBlock: g.reason, suppressedDetail: null };
  if (!g.shouldDecompose || !shapeEnabled()) return base;
  if (shapeBlocksDecompose(task)) {
    return { decompose: false, priorAttemptBlock: g.reason, suppressedDetail: `decompose suppressed: one-file-fix (${task.shape.reasons.join('; ')})` };
  }
  if (task && task.shape && task.shape.class === 'investigation') {
    return { ...base, priorAttemptBlock: `${g.reason}\n\nThis task is a read-only investigation (${task.shape.reasons.join('; ')}). Split it only along its own numbered questions or areas; never into code-change pieces.` };
  }
  return base;
}

module.exports = { classifyTaskShape, stampTaskShape, shapeBlocksDecompose, preliminaryDecomposeDecision, shapeEnabled };
