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
  // Context files the candidate's prose names (a relative require/import specifier, an any-directory path): a task created before citedContextFiles existed -- or requeued from
  // its stored snapshot -- never had them fetched. Same helper and windowing as creation; idempotent, declared files never become context, advisory on any error.
  try {
    const { citedContextFiles } = require('../candidate-path-grounding.js');
    const declared = (Array.isArray(pc.files) ? pc.files : []).map((e) => (typeof e === 'string' ? e : (e && e.path) || '')).filter(Boolean);
    const have = new Set((Array.isArray(pc.fetchedFiles) ? pc.fetchedFiles : []).map((f) => f && f.path).filter(Boolean));
    const contextCount = (Array.isArray(pc.fetchedFiles) ? pc.fetchedFiles : []).filter((f) => f && f.context).length;
    const wanted = citedContextFiles({ section, declaredFiles: declared, repoRoot: resolvedRoot, max: 3 }).filter((p) => !have.has(p)).slice(0, Math.max(0, 3 - contextCount));
    const added = [];
    for (const rel of wanted) {
      try {
        const windowed = windowFetchedFileContent(fs.readFileSync(path.resolve(resolvedRoot, rel), 'utf8'), section);
        if (!Array.isArray(pc.fetchedFiles)) pc.fetchedFiles = [];
        pc.fetchedFiles.push({ path: rel, content: windowed.text, anchorConfidence: windowed.confidence, context: true });
        added.push(rel);
      } catch (err) { console.warn('[local-draft] could not fetch context file:', rel, err.message); }
    }
    if (added.length) appendHistoryEvent(task, 'context-refreshed', `fetched ${added.length} context file(s) the candidate's prose names: ${added.join(', ')}`);
  } catch (err) {
    console.warn('[local-draft] context-file refresh failed (advisory):', err.message);
  }
  if (!Array.isArray(pc.fetchedFiles) || pc.fetchedFiles.length === 0) return;
  const relocated = [];
  pc.fetchedFiles = pc.fetchedFiles.map((f) => {
    if (!f || !f.path) return f;
    try {
      const full = path.resolve(resolvedRoot, f.path);
      if (full !== resolvedRoot && !full.startsWith(resolvedRoot + path.sep)) return f;
      // A cited file that no longer exists at all (renamed / deleted: the code lives elsewhere now) is followed like one that lost the code -- but only when relocation finds it.
      let fileText; let fileGone = false;
      try { fileText = fs.readFileSync(full, 'utf8'); } catch (e) { if (!e || e.code !== 'ENOENT') throw e; fileText = ''; fileGone = true; }
      const windowed = windowFetchedFileContent(fileText, section);
      let grounding = null;
      try { grounding = require('../sdk/lib/file-grounding.js'); } catch { grounding = null; }
      if (grounding && !f.context && grounding.snippetMissingFrom(fileText, section)) {
        // The candidate's Snippet is not in the file it cites: its code may have MOVED (a sibling file, a subdirectory) since it was written. Follow it (unique match only).
        const hit = grounding.relocateStaleAnchor(resolvedRoot, f.path, section);
        if (hit) {
          const w2 = windowFetchedFileContent(hit.content, section);
          if (w2.confidence === 'strong') {
            relocated.push({ from: f.path, to: hit.path });
            return { ...f, path: hit.path, content: w2.text, anchorConfidence: 'strong', relocatedFrom: f.path };
          }
        }
      }
      if (fileGone) return f;
      return { ...f, content: windowed.text, anchorConfidence: windowed.confidence };
    } catch (err) {
      console.warn('[local-draft] file enrich failed:', f.path, err.message);
      return f;
    }
  });
  if (relocated.length) {
    // Keep the declared list pointing at the file the code lives in now, and leave an audit line.
    if (Array.isArray(pc.files)) pc.files = pc.files.map((e) => (typeof e === 'string' ? ((relocated.find((r) => r.from === e) || {}).to || e) : e));
    appendHistoryEvent(task, 'context-refreshed', `grounding relocated (the cited code moved): ${relocated.map((r) => `${r.from} -> ${r.to}`).join(', ')}`);
  }
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

// A project search where EVERY query result is a transient error did not run: nothing was searched, so there is nothing to implement from and "0 results" would be
// a lie. Brain dump #1663: of 102 recorded project_search runs, 66 had zero real results and six errors each -- getaddrinfo ENOTFOUND api.github.com (126 errors) and
// huggingface.co (64), request timed out (206) -- yet the connectivity probe had passed, so each one went on through implement, critique and review and finished as a
// no-op "0 results". Only genuinely transient classes count (DNS, connection, timeout, HTTP 403/429/5xx rate limit or outage): a permanent error such as a rejected
// query (HTTP 422) keeps the old behaviour, otherwise it would be requeued forever.
const TRANSIENT_SEARCH_ERROR_RE = /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|socket hang up|timed out|HTTP (?:403|429|5\d\d)\b/i;

// Returns a short description of the dominant error when the search did not run, else null (some result is real, the list is empty, or an error is not transient).
function searchDidNotRun(results) {
  if (!Array.isArray(results) || results.length === 0) return null;
  const errors = [];
  for (const r of results) {
    if (!r || typeof r !== 'object' || typeof r.error !== 'string' || !r.error) return null;
    if (!TRANSIENT_SEARCH_ERROR_RE.test(r.error)) return null;
    errors.push(r.error);
  }
  const counts = new Map();
  for (const e of errors) { const k = e.replace(/\d+/g, 'N').slice(0, 60); counts.set(k, (counts.get(k) || 0) + 1); }
  const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return `${errors.length} of ${results.length} results errored, mostly "${top[0]}"`;
}

async function runHarnessSearch(kind, task, { projectSearchFetch, archImportFetch, roots, isOnlineFn }) {
  const queries = parseHarnessQueries(task.planResponse);
  if (kind === 'projectSearch') {
    let searchResults = [];
    if (queries.length > 0) {
      const online = typeof isOnlineFn === 'function' ? isOnlineFn({ forceRefresh: true }) : true;
      if (!online) {
        task.networkUnavailable = true;
        task.promptContext.searchResults = [];
        return { networkUnavailable: true };
      }
      try {
        searchResults = await projectSearchFetch(queries);
      } catch (e) {
        console.warn(`[local-draft] projectSearchFetch failed, proceeding with no results:`, e?.message ?? e);
        // Non-fatal -- implement proceeds with no results (its own prompt handles an empty
        // list: "(no results -- the searches returned nothing usable)").
      }
    }
    const failure = searchDidNotRun(searchResults);
    if (failure) {
      // Same outcome as the offline gate above: draftTask requeues a network_unavailable block WITHOUT using a draft attempt, so it is retried later.
      task.networkUnavailable = true;
      task.promptContext.searchResults = [];
      appendHistoryEvent(task, 'harness-search', `${queries.length} quer(y/ies): the search did not run (${failure}) -- treated as network unavailable, requeued without using an attempt`);
      return { networkUnavailable: true };
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

// How far (chars, ~15 lines) an edit may sit outside the flagged block and still count as "the flagged block" -- the lead-in comment,
// the signature line above it, a helper inserted just before it.
const WRONG_BLOCK_MARGIN_CHARS = 600;

function findEditFarFromAnchor(find, content, anchorSnippet) {
  const anchor = distinctiveLine(anchorSnippet);
  if (anchor.length < 12) return false;                 // no usable anchor
  if (anchorSnippet.replace(/\s+/g, ' ').includes(find.replace(/\s+/g, ' ').trim())) return false; // find IS in the snippet -- correct block
  const anchorIdx = content.indexOf(anchor);
  if (anchorIdx === -1) return false;                   // snippet stale/paraphrased -- can't judge, don't false-positive
  const findIdx = content.indexOf(find);
  if (findIdx === -1) return false;
  // The flagged block is the WHOLE snippet, not the one line distinctiveLine() picked from it. For a function-length candidate the
  // snippet is a 100-200 line function, and a legitimate extraction edits its signature/lead-in comment (to add the new components
  // above it) or a section deep inside -- both far from any single "longest line". PropertyForager function-length-fix-ac-3: every
  // attempt's edit at the function header sat ~3,900 chars from the longest line and was rejected "wrong-block" (a different block
  // than the one flagged), five redrafts in a row, until the model degraded to narrating tool calls. So when the whole snippet is
  // located verbatim in the file, an edit is on the flagged block iff it overlaps that span (plus a margin).
  const spanStart = content.indexOf(anchorSnippet);
  if (spanStart !== -1) {
    const spanEnd = spanStart + anchorSnippet.length;
    return findIdx + find.length < spanStart - WRONG_BLOCK_MARGIN_CHARS || findIdx > spanEnd + WRONG_BLOCK_MARGIN_CHARS;
  }
  return Math.abs(findIdx - anchorIdx) > WRONG_BLOCK_MARGIN_CHARS; // ~15 lines away = a different block
}

module.exports = { searchDidNotRun, TRANSIENT_SEARCH_ERROR_RE, isCandidateFulfillmentSource, refreshCandidateFetchedFiles, isEmptyApprovalSource, isAdvisoryProseSource, parseHarnessQueries, runHarnessSearch, extractCandidateSnippet, distinctiveLine, findEditFarFromAnchor };
