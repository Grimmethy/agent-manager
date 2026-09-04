'use strict';

// Deterministic grounding for the adhoc PLAN pass (2026-09-04). The adhoc plan prompt
// otherwise gets zero file content -- just title + JSON.stringify(promptContext) -- so it
// invents paths and symbols, and `blindPlanBlock` has to tell tier 3 that everything the
// plan says is unverified. This module builds a small, deterministic (no LLM, no GPU)
// grounding block from (a) the files the task names, re-read fresh and windowed, and (b) a
// repo grep on the distinctive identifiers in the task text. It is the cheap first layer of
// the "explore before you plan" port; the agentic orient pass (orient-pass.js) is the
// deeper second layer that runs when this comes back weak.

const { taskAnchorFiles, taskIdentifiers } = require('./task-anchor-files.js');
const { grepCodebase } = require('./grep-codebase-tool.js');
const { resolveAccessibleRoots } = require('./accessible-roots.js');
const path = require('path');

const PLAN_GROUNDING_MAX_CHARS = 12000;
const GREP_HITS_MAX_CHARS = 8000;
const MAX_IDENTIFIER_QUERIES = 6;
const ANCHOR_MAX_FILES = 3;
const ANCHOR_MAX_CHARS_PER_FILE = 4000;

function repoRootOrNull(opts) {
  if (opts && opts.repoRoot) return opts.repoRoot;
  try {
    return require('./config.js').getConfig().repoRoot || null;
  } catch {
    return null;
  }
}

function renderAnchor(files) {
  return files.map((f) => `--- ${f.path} ---\n\`\`\`\n${f.content}\n\`\`\``).join('\n\n');
}

// Identifiers worth grepping: the task's distinctive tokens, minus any that are just the
// basename of a file we already included in full.
function grepQueries(rawText, anchorPaths) {
  const anchorBasenames = new Set(anchorPaths.map((p) => p.split('/').pop().replace(/\.[^.]+$/, '')));
  return taskIdentifiers(rawText)
    .filter((id) => !anchorBasenames.has(id))
    .slice(0, MAX_IDENTIFIER_QUERIES);
}

// task, { repoRoot? } -> { text, anchorPaths, grepHits } | null
function buildPlanGrounding(task, opts = {}) {
  const repoRoot = repoRootOrNull(opts);
  if (!repoRoot || !task) return null;
  const rawText = String((task.promptContext && task.promptContext.rawText) || '');

  let anchorFiles = [];
  try {
    anchorFiles = taskAnchorFiles(task, repoRoot, { maxFiles: ANCHOR_MAX_FILES, maxCharsPerFile: ANCHOR_MAX_CHARS_PER_FILE });
  } catch { anchorFiles = []; }
  const anchorPaths = anchorFiles.map((f) => f.path);

  // Multi-repo (2026-09-04): also grep each loaded plugin's own repo (accessible-roots.js)
  // -- a task about "the pipeline" is just as likely to be about agent-manager-hygiene's
  // code as agent-manager's own, and this grep is the only thing standing between a real
  // fix site and a model that has to invent one instead. extraRoots (roots[1:]) each get
  // ONE whole-repo grepCodebase call per query, same reasoning arch-import-fetch.js's own
  // multi-root fetchForQueries documents -- an extra root has no AGENT_MANAGER_GREP_DIRS
  // allowlist of its own. The primary root keeps its EXACT original call (root: repoRoot,
  // untouched) rather than looping it through resolveAccessibleRoots()[0] -- grepCodebase
  // only treats `root` as an alternate when it resolves to a DIFFERENT path than its own
  // internal getConfig().repoRoot, and comparing a realpath'd roots[0] against a
  // not-necessarily-realpath'd repoRoot risks a false mismatch (e.g. a symlinked checkout).
  const extraRoots = resolveAccessibleRoots({ repoRoot }).slice(1);
  let grepHits = [];
  const queries = rawText ? grepQueries(rawText, anchorPaths) : [];
  const HITS_PER_QUERY = 6;
  for (const query of queries) {
    try {
      const raw = grepCodebase({ query, root: repoRoot });
      const results = (Array.isArray(raw) ? raw : []).slice(0, HITS_PER_QUERY);
      for (const r of results) grepHits.push({ ...r, query });
    } catch { /* one bad query shouldn't sink the rest */ }
    for (const root of extraRoots) {
      try {
        const raw = grepCodebase({ query, root });
        const results = (Array.isArray(raw) ? raw : []).slice(0, HITS_PER_QUERY);
        for (const r of results) grepHits.push({ ...r, query });
      } catch { /* one bad query/root shouldn't sink the rest */ }
    }
  }
  // Drop grep hits for files already shown in full as anchor content.
  const shown = new Set(anchorPaths);
  grepHits = grepHits.filter((h) => h && h.file && !shown.has(h.file));

  if (anchorFiles.length === 0 && grepHits.length === 0) return null;

  const parts = [];
  if (anchorFiles.length) {
    parts.push('FILES THIS TASK NAMES (read from the repo just now):', '', renderAnchor(anchorFiles));
  }
  if (grepHits.length) {
    let hitText = grepHits.map((h) => {
      const tag = h.root ? `[${path.basename(h.root)}] ` : '';
      return `${tag}${h.file}:${h.line}: ${String(h.text || '').trim()}`;
    }).join('\n');
    if (hitText.length > GREP_HITS_MAX_CHARS) hitText = `${hitText.slice(0, GREP_HITS_MAX_CHARS)}\n...[grep hits truncated]`;
    parts.push('', 'GREP HITS (repo grep on the identifiers this task names):', '', hitText);
  }
  let text = parts.join('\n').trim();
  if (text.length > PLAN_GROUNDING_MAX_CHARS) text = `${text.slice(0, PLAN_GROUNDING_MAX_CHARS)}\n...[grounding truncated]`;

  return { text, anchorPaths, grepHits };
}

// Does the deterministic grounding already cover everything the task names? If so the
// agentic orient pass (orient-pass.js) has nothing to add and can be skipped. A task with
// no distinctive identifiers and no named files is "architectural" -> not covered.
function groundingCovers(task, grounding) {
  if (!grounding) return false;
  const rawText = String((task.promptContext && task.promptContext.rawText) || '');
  const idents = taskIdentifiers(rawText);
  if (idents.length === 0 && grounding.anchorPaths.length === 0) return false; // architectural

  const coveredFiles = new Set([
    ...grounding.anchorPaths,
    ...grounding.grepHits.map((h) => h.file),
  ]);
  // literal repo paths / backtick filenames named in the task must all be represented
  const namedPaths = [];
  for (const m of rawText.matchAll(/\b(?:src|python|scripts|lib|test|tests|docs)(?:\/[\w.@-]+)+\.\w{1,5}\b/g)) namedPaths.push(m[0]);
  for (const p of namedPaths) {
    if (![...coveredFiles].some((cf) => cf === p || cf.endsWith(`/${p}`) || p.endsWith(`/${cf}`))) return false;
  }
  // every distinctive identifier must appear somewhere in the grounding text (anchor file
  // content, a grep hit line, or an anchor file's own name)
  const haystack = `${grounding.text}\n${grounding.anchorPaths.join('\n')}`;
  for (const id of idents) {
    if (!haystack.includes(id)) return false;
  }
  return true;
}

module.exports = {
  buildPlanGrounding,
  groundingCovers,
  PLAN_GROUNDING_MAX_CHARS,
  MAX_IDENTIFIER_QUERIES,
};
