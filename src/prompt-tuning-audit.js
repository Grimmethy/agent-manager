'use strict';

// HUB0706 1/2: pure prompt-tuning corpus helpers. No network, no model calls, no writes.
const fs = require('fs');
const path = require('path');

// Judgment-heavy prompt builders eligible for tuning (each located by grep).
const ALLOWLIST = [
  { id: 'brain_dump_sort', file: 'src/lib/prompt-planning.js', functionName: 'brainDumpSortPlanPrompt' },
  { id: 'review_verdict', file: 'src/review-task.js', functionName: 'buildVerdictPrompt' },
  { id: 'adhoc_plan', file: 'src/prompts.js', functionName: 'adhocHarnessSearchPlanPrompt' },
];

const DEFAULT_MIN_OUTCOMES = 50;
const TUPLE_CAP = 20;
// queue/ is absent from this checkout, so the record shape (including the promptTarget
// field that tags which builder produced an outcome) is UNCONFIRMED. Re-check against a
// real queue/done/*.json before relying on it.
const CORPUS_DIRS = ['done', 'blocked', 'worklogs'];

function minOutcomes() {
  const raw = process.env.PROMPT_TUNING_MIN_OUTCOMES;
  const n = Number(String(raw == null ? '' : raw).trim());
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MIN_OUTCOMES;
}

function resolveTarget(target) {
  const id = typeof target === 'string' ? target : target && target.id;
  const entry = ALLOWLIST.find((e) => e.id === id);
  if (!entry) throw new Error(`prompt-tuning-audit: target not in ALLOWLIST: ${id}`);
  return entry;
}

// Every *.json in dir. A missing dir yields []; a malformed file is skipped, not thrown.
function readJsonRecords(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  const records = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    try { records.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))); } catch (e) { /* skipped */ }
  }
  return records;
}

function gatherCorpus(repoRoot, target) {
  const entry = resolveTarget(target);
  const matching = [];
  for (const sub of CORPUS_DIRS) {
    for (const rec of readJsonRecords(path.join(repoRoot, 'queue', sub))) {
      if (rec && rec.promptTarget === entry.id) matching.push(rec);
    }
  }
  const count = matching.length;
  const tuples = matching.slice(0, TUPLE_CAP).map((rec) => ({
    input: rec.input == null ? '' : rec.input,
    output: rec.output == null ? '' : rec.output,
    verdict: rec.verdict == null ? null : rec.verdict,
    reason: rec.reason == null ? '' : rec.reason,
  }));
  return { ready: count >= minOutcomes(), count, tuples };
}

function skipQuoted(src, i, q) {
  let j = i + 1;
  while (j < src.length && src[j] !== q) {
    if (src[j] === '\\') j += 2;
    else j++;
  }
  return j + 1;
}

function skipTemplate(src, i) {
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === '\\') { j += 2; continue; }
    if (src[j] === '`') return j + 1;
    if (src[j] === '$' && src[j + 1] === '{') { j = closeOf(src, j + 1, '{', '}') + 1; continue; }
    j++;
  }
  throw new Error('prompt-tuning-audit: unterminated template literal');
}

// openIdx points at `open`; returns the index of its matching `close`. Skips comments, strings, templates.
function closeOf(src, openIdx, open, close) {
  let depth = 0;
  let j = openIdx;
  while (j < src.length) {
    const c = src[j];
    const n = src[j + 1];
    if (c === '/' && n === '/') { const e = src.indexOf('\n', j); j = e === -1 ? src.length : e; continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', j + 2); if (e === -1) break; j = e + 2; continue; }
    if (c === '"' || c === "'") { j = skipQuoted(src, j, c); continue; }
    if (c === '`') { j = skipTemplate(src, j); continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return j; }
    j++;
  }
  throw new Error(`prompt-tuning-audit: unbalanced '${open}' at offset ${openIdx}`);
}

function promptTemplateText(repoRoot, target) {
  const entry = resolveTarget(target);
  const src = fs.readFileSync(path.join(repoRoot, entry.file), 'utf8');
  const decl = new RegExp('function\\s+' + entry.functionName + '\\s*\\(').exec(src);
  if (!decl) throw new Error(`prompt-tuning-audit: function ${entry.functionName} not found in ${entry.file}`);
  const parenOpen = decl.index + decl[0].length - 1;
  const parenClose = closeOf(src, parenOpen, '(', ')');
  const braceOpen = src.indexOf('{', parenClose + 1);
  if (braceOpen === -1) throw new Error(`prompt-tuning-audit: no body for ${entry.functionName}`);
  const braceClose = closeOf(src, braceOpen, '{', '}');
  return src.slice(decl.index, braceClose + 1);
}

module.exports = { ALLOWLIST, DEFAULT_MIN_OUTCOMES, TUPLE_CAP, minOutcomes, gatherCorpus, promptTemplateText };
