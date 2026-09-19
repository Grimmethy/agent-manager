'use strict';

// harness-search.js -- extracted from src/local-draft.js ([[hub-task-integration]] node-module decompose).

const fs = require('fs');
const path = require('path');
const { fetchForQueries: archImportFetch } = require('../arch-import-fetch.js');
const { appendHistoryEvent, setHistoryPersistHook } = require('../task-history.js');
const { getConfig, ensureRegistered } = require('../config.js');
const { resolveSourceName, getRegisteredSource } = require('../task-source-registry.js');

function isCandidateFulfillmentSource(source) {
  const entry = getRegisteredSource(source);
  return !!(entry && entry.candidateFulfillment);
}

function refreshCandidateFetchedFiles(task) {
  const pc = task && task.promptContext;
  if (!pc) return;
  const hasFetched = Array.isArray(pc.fetchedFiles) && pc.fetchedFiles.length > 0;
  const hasDeclared = Array.isArray(pc.files) && pc.files.some((f) => typeof f === 'string');
  if (!hasFetched && !hasDeclared) return;
  let repoRoot;
  let grepAllowedDirs = [];
  try { ({ repoRoot, grepAllowedDirs } = getConfig()); } catch (err) { console.warn('[local-draft] getConfig failed:', err.message); return; }
  if (!repoRoot) return;
  let windowFetchedFileContent;
  try { ({ windowFetchedFileContent } = require('../sdk/candidate-fulfillment.js')); } catch (err) { console.warn('[local-draft] candidate-fulfillment require failed:', err.message); return; }
  const resolvedRoot = path.resolve(repoRoot);
  const section = pc.body || '';

  // Heal a stale snapshot: a task generated BEFORE the shared Files: resolver (candidate-path-
  // grounding.js resolveCitedFile) keeps the fetchedFiles it was created with, and a requeue keeps
  // that stored promptContext -- so PropertyForager's arch-review-ac-1 (`Files: SearchView`, an
  // empty fetchedFiles) re-drafted with no code even after the resolver fix. Any declared file that
  // resolves to a real file but is missing from fetchedFiles is fetched now, and the declared entry is
  // rewritten to its repo-relative path. Idempotent: a healthy task is left as it was.
  if (hasDeclared) {
    try {
      const { resolveCitedFile } = require('../candidate-path-grounding.js');
      if (!Array.isArray(pc.fetchedFiles)) pc.fetchedFiles = [];
      const have = new Set(pc.fetchedFiles.map((f) => f && f.path).filter(Boolean));
      const healed = [];
      pc.files = pc.files.map((entry) => {
        if (typeof entry !== 'string') return entry;
        const r = resolveCitedFile(resolvedRoot, entry, grepAllowedDirs || []);
        if (!(r.exists && r.isFile && r.relPath)) return entry;
        if (!have.has(r.relPath)) {
          try {
            const windowed = windowFetchedFileContent(fs.readFileSync(r.resolvedPath, 'utf8'), section);
            pc.fetchedFiles.push({ path: r.relPath, content: windowed.text, anchorConfidence: windowed.confidence });
            have.add(r.relPath);
            healed.push(r.relPath);
          } catch (err) {
            console.warn('[local-draft] could not fetch declared file:', r.relPath, err.message);
          }
        }
        return r.relPath;
      });
      if (healed.length) appendHistoryEvent(task, 'context-refreshed', `fetched ${healed.length} declared file(s) missing from the stored snapshot: ${healed.join(', ')}`);
    } catch (err) {
      console.warn('[local-draft] declared-file refresh failed (advisory):', err.message);
    }
  }
  if (!Array.isArray(pc.fetchedFiles) || pc.fetchedFiles.length === 0) return;
  pc.fetchedFiles = pc.fetchedFiles.map((f) => {
    if (!f || !f.path) return f;
    try {
      const full = path.resolve(resolvedRoot, f.path);
      if (full !== resolvedRoot && !full.startsWith(resolvedRoot + path.sep)) return f;
      const windowed = windowFetchedFileContent(fs.readFileSync(full, 'utf8'), section);
      return { ...f, content: windowed.text, anchorConfidence: windowed.confidence };
    } catch (err) {
      console.warn('[local-draft] file enrich failed:', f.path, err.message);
      return f;
    }
  });
}

function isEmptyApprovalSource(source) {
  const entry = getRegisteredSource(source);
  return !!(entry && entry.emptyApproval);
}

function isAdvisoryProseSource(source) {
  const entry = getRegisteredSource(source);
  return !!(entry && entry.advisoryProse);
}

function parseHarnessQueries(planResponse) {
  return [...(planResponse || '').matchAll(/^QUERY:\s*(.+)$/gm)].map((m) => m[1].trim()).filter(Boolean);
}

async function runHarnessSearch(kind, task, { projectSearchFetch, archImportFetch, roots }) {
  const queries = parseHarnessQueries(task.planResponse);
  if (kind === 'projectSearch') {
    let searchResults = [];
    if (queries.length > 0) {
      try {
        searchResults = await projectSearchFetch(queries);
      } catch (e) {
        console.warn(`[local-draft] projectSearchFetch failed, proceeding with no results:`, e?.message ?? e);
        // Non-fatal -- implement proceeds with no results (its own prompt handles an empty
        // list: "(no results -- the searches returned nothing usable)").
      }
    }
    task.promptContext.searchResults = searchResults;
    appendHistoryEvent(task, 'harness-search', `${queries.length} quer(y/ies), ${searchResults.length} result(s)`);
    return;
  }
  // 'archImport' -- also pipeline_self_audit / pipeline_health_audit / ui_visibility_audit /
  // staleness_audit / pipeline_forensics(_fix) / product_spec_outline/section: literally
  // the same archImportFetch of agent-manager's own repo (PLUS any loaded plugin repo,
  // 2026-09-04 -- see accessible-roots.js's own header for the incident this closes), the
  // only difference being what promptContext text the implement prompt renders around the
  // hits (which lives in the prompt, not this step).
  let harnessHits = [];
  let harnessFiles = [];
  if (queries.length > 0) {
    try {
      const result = archImportFetch(queries, { roots });
      harnessHits = result.hits || [];
      harnessFiles = result.files || [];
    } catch (e) {
      console.warn(`archImportFetch failed, continuing with empty harness data: ${e && e.message ? e.message : e}`);
    }
  }
  task.promptContext.harnessHits = harnessHits;
  task.promptContext.harnessFiles = harnessFiles;
  appendHistoryEvent(task, 'harness-search', `${queries.length} quer(y/ies), ${harnessHits.length} hit(s), ${harnessFiles.length} file(s)`);
}

function extractCandidateSnippet(body) {
  const m = /(?:^|\n)\s*Snippet:\s*```[\w-]*\n([\s\S]*?)```/i.exec(String(body || ''));
  return m ? m[1].replace(/\s+$/, '') : '';
}

function distinctiveLine(snippet) {
  return (snippet || '').split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length >= 12 && !/^(#|\/\/|\*|"""|''')/.test(l))
    .sort((a, b) => b.length - a.length)[0] || '';
}

function findEditFarFromAnchor(find, content, anchorSnippet) {
  const anchor = distinctiveLine(anchorSnippet);
  if (anchor.length < 12) return false;                 // no usable anchor
  if (anchorSnippet.replace(/\s+/g, ' ').includes(find.replace(/\s+/g, ' ').trim())) return false; // find IS in the snippet -- correct block
  const anchorIdx = content.indexOf(anchor);
  if (anchorIdx === -1) return false;                   // snippet stale/paraphrased -- can't judge, don't false-positive
  const findIdx = content.indexOf(find);
  return findIdx !== -1 && Math.abs(findIdx - anchorIdx) > 600; // ~15 lines away = a different block
}

module.exports = { isCandidateFulfillmentSource, refreshCandidateFetchedFiles, isEmptyApprovalSource, isAdvisoryProseSource, parseHarnessQueries, runHarnessSearch, extractCandidateSnippet, distinctiveLine, findEditFarFromAnchor };
