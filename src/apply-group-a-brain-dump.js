'use strict';

// apply-group-a-brain-dump.js -- extracted from src/apply-group-a.js ([[hub-task-integration]] node-module decompose).

const fs = require('fs');
const path = require('path');
const { resolveAnchors, extractKeywords } = require('./path-prefetch.js');
const { resolveGraphPath, getSecondBrainDir } = require('./config.js');
const { writeAtomicSync, writeJsonAtomicSync } = require('./atomic-write.js');
const { normalizeTokens, jaccardSimilarity } = require('./text-similarity.js');
const {
  CANONICAL_TOP_LEVEL,
  GENERIC_FILENAME_BLOCKLIST,
  parseBrainDumpSortResult,
  validateSecondBrainPath,
  normalizeSecondBrainPathCase,
  deriveBelongsToProject,
  isInvestigationFinding,
} = require('./brain-dump-sort-classify.js');

function readProjectRegistry() {
  const registryPath = process.env.AGENT_MANAGER_PROJECTS_REGISTRY_PATH || path.join(__dirname, '..', 'projects.json');
  try {
    const list = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function sameDir(a, b) {
  const real = (x) => { try { return fs.realpathSync(x); } catch { return path.resolve(x); } };
  return !!a && !!b && real(a) === real(b);
}

// A machine-raised finding (entry.raisedBy.repoRoot, stamped by side-finding.js) belongs to
// the project whose pipeline raised it. brain-dump.json is global, so the classifier could
// only guess -- and its own-project bias sent PF-Client-Portal findings to agent-manager
// (2026-09-19). Returns the registered project entry for that repo, or null.
function originProjectFor(entry, registry) {
  const root = entry && entry.raisedBy && entry.raisedBy.repoRoot;
  if (!root) return null;
  return registry.find((p) => sameDir(p.repoRoot, root)) || null;
}

// Validates a classifier-reported possibleDuplicateOf against the REAL candidate list it
// was actually shown (task.promptContext.existingQueuedTitles, built by task-sources.js's
// existingQueuedTaskTitles()) -- 2026-09-16, pipeline hardening: root-caused live that the
// classifier's possibleDuplicateOf field was never checked against that list at all, so the
// local model could (and, confirmed across a live needs-clarification queue, routinely did)
// return a string that matches NEITHER a real queued title NOR anything resembling one --
// two confirmed shapes: (a) echoing a quoted/bracketed phrase from INSIDE the note's own
// rawText as if it were an external match, (b) a plausible-sounding but entirely invented
// slug (e.g. "agent-manager-apply-target") that isn't a real task title at all (real titles
// are full sentences). Both false-positive shapes permanently routed the note to
// needs-clarification for a human to manually discover it was never a real duplicate --
// confirmed on ~43% of one live needs-clarification queue. Tolerant matching (exact,
// substring either direction for a truncated title, or Jaccard >= 0.5 for a close
// paraphrase) so a genuine match phrased slightly differently than the 140-char-truncated
// title still passes; anything below that bar is almost certainly a hallucination, not a
// real duplicate the classifier actually found.
const DUPLICATE_MATCH_JACCARD_THRESHOLD = 0.5;
function isValidDuplicateMatch(candidate, existingTitles) {
  const c = String(candidate || '').trim();
  if (!c || !Array.isArray(existingTitles) || existingTitles.length === 0) return false;
  const cLower = c.toLowerCase();
  const cTokens = normalizeTokens(c);
  return existingTitles.some((title) => {
    const t = String(title || '').trim();
    if (!t) return false;
    const tLower = t.toLowerCase();
    if (cLower === tLower) return true;
    if (cLower.includes(tLower) || tLower.includes(cLower)) return true;
    return jaccardSimilarity(cTokens, normalizeTokens(t)) >= DUPLICATE_MATCH_JACCARD_THRESHOLD;
  });
}

// HUB0115 1/3 -- phrase-echo rejection for the duplicate gate. The classifier's
// confirmed hallucination shape (a) is echoing a quoted/bracketed phrase from INSIDE
// the note's own rawText as if it were an external task-title match. This helper
// detects exactly that grounding: a possibleDuplicateOf string that is (after
// normalizing -- lowercase, collapse whitespace, and stripping one pair of enclosing
// quotes/brackets the classifier may have dropped or kept) a substring of the note's
// own rawText is a phrase-echo, not a real duplicate the classifier found. It is the
// (b) branch of the gate's decision order and is only consulted for candidates that
// FAIL isValidDuplicateMatch, so a genuine candidate-list match can never be
// overridden by it. Pure function -- safe to unit-test directly.
function isGroundedInInput(candidate, rawText) {
  const raw = String(rawText || '');
  if (!raw.trim()) return false;
  const plain = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  // Reuse text-similarity.js's normalizeTokens (already imported above) as a second,
  // punctuation/case/stopword-insensitive containment signal: the candidate's normalized
  // token stream must appear, in order, inside rawText's normalized token stream.
  const tokenStream = (s) => [...normalizeTokens(s)].join(' ');
  const variants = [
    candidate,
    String(candidate || '').replace(/^['"[\(`]+|['"\]\)`]+$/g, ''),
  ];
  const tPlain = plain(raw);
  const tTokens = tokenStream(raw);
  return variants.some((v) => {
    const cPlain = plain(v);
    if (cPlain && tPlain.includes(cPlain)) return true;
    const cTok = tokenStream(v);
    return cTok.length > 0 && tTokens.includes(cTok);
  });
}

// HUB0115 1/3 -- reason-keyed dismissal recording for the possible-duplicate gate.
// Every path that nulls result.possibleDuplicateOf (i.e. DISMISSES the classifier's
// duplicate claim) calls recordDuplicateGateDismissal BEFORE nulling it, so the exact
// rejected string is captured. The record is a pure side effect -- counter increments
// plus one stable, greppable console.warn line -- and runs AFTER the gate has already
// decided to dismiss, so it cannot flip a would-be-kept candidate into a dropped one:
// the keep/decide branches above are untouched by this. Keys:
//   'phrase-echo'       -- candidate grounded in the note's own rawText (gate branch (b))
//   'ungrounded'        -- candidate matching neither a real queued title nor the note (branch (c))
//   'invalid-candidate' -- a claimed duplicate that isn't even a usable string (reserved
//                          for the sibling 2/3 dismissal paths outside this gate)
const duplicateGateDismissals = {
  'phrase-echo': 0,
  'ungrounded': 0,
  'invalid-candidate': 0,
};

// entry is the brain-dump entry object (or null/omitted on paths that have no entry):
// the existing entry.duplicateGateAttempts retry counter lives on the entry because the
// entry is the object that persists across repeated classification attempts of the same
// note. Emits exactly one greppable line (token: duplicateGateDismissal) carrying all
// four audit fields.
function recordDuplicateGateDismissal(entry, { noteId, rejectedCandidate, reason, candidatesChecked }) {
  if (entry && typeof entry === 'object') {
    entry.duplicateGateAttempts = (Number(entry.duplicateGateAttempts) || 0) + 1;
  }
  if (Object.prototype.hasOwnProperty.call(duplicateGateDismissals, reason)) {
    duplicateGateDismissals[reason] += 1;
  }
  console.warn(`[apply-group-a-brain-dump] duplicateGateDismissal noteId=${noteId} rejectedCandidate=${rejectedCandidate} reason=${reason} candidatesChecked=${candidatesChecked}`);
  return reason;
}

function allNoteBasenames(secondBrainDir) {
  const names = new Set();
  const walk = (abs, depth) => {
    if (depth > 5) return;
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) walk(path.join(abs, e.name), depth + 1);
      else if (e.name.endsWith('.md')) names.add(e.name.replace(/\.md$/, ''));
    }
  };
  if (secondBrainDir) walk(secondBrainDir, 0);
  return names;
}

function resolveNoteLinks(result, secondBrainDir, selfBasename) {
  const existing = allNoteBasenames(secondBrainDir);
  const byLower = new Map([...existing].map((n) => [n.toLowerCase(), n]));
  const isSelf = (n) => selfBasename && n.toLowerCase() === selfBasename.toLowerCase();

  const linked = [];
  for (const raw of (result.relatedNotes || [])) {
    const hit = byLower.get(String(raw).toLowerCase());
    if (hit && !isSelf(hit) && !linked.includes(hit)) linked.push(hit);
  }
  if (linked.length > 0) return linked.slice(0, 5);

  // Fallback: no explicit relatedNotes resolved -- link the 1-2 existing notes whose
  // basename shares >= 2 distinctive tokens with this note's tags + path stem. No model call.
  const noteTokens = new Set([
    ...extractKeywords((result.tags || []).join(' ')),
    ...extractKeywords(String(result.secondBrainPath || '').replace(/[/\\.]/g, ' ')),
  ].map((k) => k.lower));
  if (noteTokens.size === 0) return [];
  const scored = [];
  for (const name of existing) {
    if (isSelf(name)) continue;
    const overlap = extractKeywords(name.replace(/[-_]/g, ' ')).filter((k) => noteTokens.has(k.lower)).length;
    if (overlap >= 2) scored.push({ name, overlap });
  }
  scored.sort((a, b) => b.overlap - a.overlap);
  return scored.slice(0, 2).map((s) => s.name);
}

function appendMarkdownLineAtomic(fullPath, line) {
  const existing = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf8') : null;
  const contents = existing !== null
    ? existing + line
    : `# ${path.basename(fullPath, path.extname(fullPath))}\n${line}`;
  writeAtomicSync(fullPath, contents);
}

function loadBrainDump(filePath) {
  let data;
  try {
    data = JSON.parse(fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '{"entries":[]}');
  } catch (err) {
    console.error(`[loadBrainDump] ${filePath}: ${err.message}${err.stack ? `\n${err.stack}` : ''} — returning empty store`);
    data = { entries: [] };
  }
  if (!Array.isArray(data.entries)) data.entries = [];
  return data;
}

function findEntry(data, entryId) {
  return data.entries.find((e) => e && e.id === entryId) || null;
}

function recoverableSortSkip(data, entry, brainDumpPath, reason) {
  entry.sortAttempt = (entry.sortAttempt || 0) + 1;
  try {
    fs.mkdirSync(path.dirname(brainDumpPath), { recursive: true });
    writeJsonAtomicSync(brainDumpPath, data);
  } catch { /* best-effort -- reject-retry-check's exhaustion path also bumps sortAttempt */ }
  return { skipped: true, recoverable: true, reason };
}

// applyBrainDumpSort is the entry point (HUB0085): load + classify the entry, then dispatch to exactly one of four outcomes -- queue a research task, queue an adhoc
// task in the matched project, report a recoverable skip, or file a passive vault note. Each stage below is the original code moved verbatim; only the plumbing
// (ctx in, the original return objects out) is new. loadAndClassifyEntry returns { done: <the original early-return value> } or { ctx }.
// Stage 1: load the entry, refuse anything stale / suppressed / unconfigured, parse the classifier's JSON.
function loadAndValidateEntry({ implementResponse, task, brainDumpPath, secondBrainDir, pipelineDir }) {
  const { brainDumpEntryId, rawText, existingQueuedTitles } = task.promptContext;

  const data = loadBrainDump(brainDumpPath);

  const entry = findEntry(data, brainDumpEntryId);
  if (!entry) {
    // Terminal: the entry is gone, there is nothing to regenerate.
    return { done: { skipped: true, reason: `brain-dump entry "${brainDumpEntryId}" no longer exists (deleted since this task was drafted)` } };
  }
  // The entry may have been edited (the dashboard's PUT resets status back to 'captured' on
  // a text change) or otherwise changed since this task was drafted -- classifying stale
  // text into the entry's CURRENT record would silently mislabel it under a rawText it no
  // longer has. Only apply if the entry is still exactly what this task was drafted against.
  if (entry.suppressed) {
    // A human retired this finding after its sort task was queued -- sorting it now would
    // still file a note or queue a task for something they already dismissed.
    return { done: { skipped: true, reason: 'brain-dump entry was suppressed since this task was queued -- not sorting it' } };
  }
  if (entry.status !== 'captured' || entry.rawText !== rawText) {
    // Stale (HUB0050 2/3): this task was drafted against text the entry no longer has,
    // so re-classifying THIS task's response will NEVER apply -- it is not a
    // recoverable classification miss. Going through recoverableSortSkip here (the old
    // path) burned one of the entry's MAX_SORT_ATTEMPTS slots on a condition a fresh
    // sort under a new id simply supersedes, and its recoverable:true shape let
    // apply-task.js phrase it as "sort not applied (retrying)" on a done task. Emit a
    // distinct non-success stale shape instead: no sortAttempt write (the entry is left
    // exactly as-is, status still 'captured' for the fresh sort), no recoverable flag,
    // and success:false so the caller's stale check (apply-group-a.js) can route it
    // away from the done transition.
    return { done: {
      skipped: true,
      stale: true,
      success: false,
      reason: 'brain-dump entry changed since this task was drafted -- a fresh sort will classify the current text',
    } };
  }

  if (!secondBrainDir) secondBrainDir = getSecondBrainDir();
  if (!secondBrainDir) {
    // Terminal: no vault configured, no retry will help.
    return { done: { skipped: true, reason: 'SECOND_BRAIN_DIR is not configured -- cannot file this entry anywhere' } };
  }

  const result = parseBrainDumpSortResult(implementResponse);
  if (!result) {
    return { done: recoverableSortSkip(data, entry, brainDumpPath,
      'implement pass did not return a valid classification JSON') };
  }


  return { ctx: { data, entry, result, secondBrainDir, pipelineDir, brainDumpEntryId, rawText, existingQueuedTitles, brainDumpPath, promptContext: task.promptContext } };
}

// Stage 2: normalise and validate the vault path, then recover the owning project (derive, origin routing, investigation-shaped findings).
function classifySortResult(ctx) {
  const { data, entry, result, secondBrainDir, rawText, brainDumpPath, promptContext } = ctx;
  const trackedLabels = readProjectRegistry().map((p) => p.label).filter(Boolean);
  result.secondBrainPath = normalizeSecondBrainPathCase(result.secondBrainPath, trackedLabels);
  result.secondBrainPath = path.normalize(result.secondBrainPath);
  // normalizeSecondBrainPathCase above only corrects against the CANONICAL_TOP_LEVEL
  // constant + the project registry's own label spelling -- it trusts the registry, not
  // the disk. If a tracked project's real on-disk folder casing has ever drifted from
  // its registry label (a manual rename, or the label recorded before the folder existed),
  // that correction can hand validateSecondBrainPath's OWN on-disk conflict check a
  // spelling that doesn't match what's actually there, tripping its "different-case
  // duplicate" rejection for a folder that in fact already exists -- the silent no-op
  // this whole task is about. Resolve the first segment against disk directly, but only
  // when exactly one entry matches case-insensitively (0 or 2+ matches is ambiguous or
  // missing -- leave the path as-is and let validateSecondBrainPath's own rejection,
  // "different-case duplicate" included, be the fallback).
  if (secondBrainDir) {
    const segments = result.secondBrainPath.split(/[\\/]/).filter(Boolean);
    if (segments.length > 0) {
      let entries;
      try {
        entries = fs.readdirSync(secondBrainDir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith('.'));
      } catch {
        entries = [];
      }
      const matches = entries.filter((e) => e.name.toLowerCase() === segments[0].toLowerCase());
      if (matches.length === 1 && matches[0].name !== segments[0]) {
        segments[0] = matches[0].name;
        result.secondBrainPath = segments.join('/');
      }
    }
  }
  const namingError = validateSecondBrainPath(result.secondBrainPath, secondBrainDir, trackedLabels);
  if (namingError) {
    return { done: recoverableSortSkip(data, entry, brainDumpPath,
      `rejected secondBrainPath "${result.secondBrainPath}": ${namingError}`) };
  }

  // Deterministic belongsToProject recovery -- the classifier routinely leaves this null
  // for a note that is plainly a concrete change to this pipeline's own code (the dominant
  // failure of the blocked backlog). May also flip actionable true.
  {
    const derived = deriveBelongsToProject(result, promptContext);
    result.belongsToProject = derived.belongsToProject;
    result.actionable = derived.actionable;
  }

  // Origin routing: a finding raised by project X's pipeline is about project X, whatever
  // the classifier guessed. Overrides the label; and a note filed under a DIFFERENT tracked
  // project's vault folder moves to X's folder when that folder exists.
  {
    const origin = originProjectFor(entry, readProjectRegistry());
    if (origin && origin.label) {
      result.belongsToProject = origin.label;
      const segments = result.secondBrainPath.split(/[\\/]/).filter(Boolean);
      if (segments.length > 1 && segments[0] !== origin.label
          && trackedLabels.includes(segments[0])
          && fs.existsSync(path.join(secondBrainDir, origin.label))) {
        segments[0] = origin.label;
        result.secondBrainPath = segments.join('/');
      }
    }
  }

  // Investigation-shaped machine findings become notes, never code tasks (see
  // isInvestigationFinding's header). Applied AFTER origin routing so the note still files
  // under the raising project's vault folder.
  if (entry.raisedBy && isInvestigationFinding(rawText)) {
    result.belongsToProject = null;
    result.actionable = false;
  }

  return { ctx };
}

// loadAndClassifyEntry returns { done: <the original early-return value> } or { ctx }.
function loadAndClassifyEntry(args) {
  const loaded = loadAndValidateEntry(args);
  if (loaded.done) return loaded;
  return classifySortResult(loaded.ctx);
}

// Stage: a requeue-free research note (no tracked project named) becomes a research task plus a vault cross-reference.
function queueResearchTask(ctx) {
  const { data, entry, result, secondBrainDir, pipelineDir, brainDumpEntryId, rawText, brainDumpPath } = ctx;
  if (!pipelineDir) {
    return { skipped: true, reason: 'no pipelineDir available -- cannot queue a research task' };
  }
  const queuedId = `research-brain-dump-${brainDumpEntryId}-${Date.now()}`;
  const researchTask = {
    id: queuedId,
    domain: 'research',
    source: 'research_task',
    title: rawText.slice(0, 120),
    promptContext: { rawText, brainDumpEntryId, secondBrainPath: result.secondBrainPath, tags: result.tags },
  };
  const researchDir = path.join(pipelineDir, 'queue', 'research');
  fs.mkdirSync(researchDir, { recursive: true });
  writeJsonAtomicSync(path.join(researchDir, `${queuedId}.json`), researchTask);

  // Same audit-trail cross-reference convention the adhoc branch below already uses --
  // an entry findable in the note it will eventually gain real content in, not the
  // record of truth (brain-dump.json's queuedTaskId/queuedAt is that).
  const fullPath = path.join(secondBrainDir, result.secondBrainPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  appendMarkdownLineAtomic(fullPath, `\n- **${stamp}** Queued as research task \`${queuedId}\` -- ${rawText}\n`);

  entry.status = 'actioned';
  entry.queuedTaskId = queuedId;
  entry.queuedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(brainDumpPath), { recursive: true });
  writeJsonAtomicSync(brainDumpPath, data);

  return { file: fullPath, queuedTaskId: queuedId, researchQueued: true };
}

// Stage: the matched project's registered domains (an unreadable domains file is logged and treated as none).
function readProjectDomains(matchedProject) {
  return (() => {
    try {
      return Object.keys(JSON.parse(fs.readFileSync(matchedProject.domainsPath, 'utf8')));
    } catch (err) {
      const reason = err && err.message ? err.message : String(err);
      process.stderr.write(`[apply-group-a] failed to read domains from ${matchedProject.domainsPath}: ${reason}\n`);
      return [];
    }
  })();
}

// Stage: build the adhoc/derived task for the entry and resolve its path prefetch (queue dir + needs-clarification for no-match / ambiguous).
function buildAdhocTaskForEntry(ctx, matchedProject) {
  const { entry, brainDumpEntryId, rawText } = ctx;
  const queuedId = `adhoc-brain-dump-${brainDumpEntryId}-${Date.now()}`;
  // A brain-dump entry with a `raisedBy` was machine-filed (side-finding-sweep.js:
  // a pipeline_debrief Now-What item, or any pass's writeSideFindingInbox side
  // finding) -- NOT a human handing the pipeline a task. Route it to queue/derived/
  // (source: derived_task, priority 48) instead of queue/adhoc/ (priority 10, preempts
  // every deterministic source), so this whole class is its own throttleable Job List
  // lane. A human-typed entry has no raisedBy and stays genuine adhoc. If it still
  // needs clarification (below), it goes to needs-clarification either way -- a human
  // resolving it there re-files it as real adhoc, which is correct (they vouched for it).
  const isDerived = !!(entry && entry.raisedBy);
  const adhocTask = {
    id: queuedId,
    domain: 'adhoc',
    source: isDerived ? 'derived_task' : 'brain_dump',
    title: rawText.slice(0, 120),
    promptContext: isDerived
      ? { rawText, brainDumpEntryId, derivedFrom: entry.raisedBy }
      : { rawText, brainDumpEntryId },
  };

  // Path-prefetch (context-aware-file-path-prefetch-job.md, 2026-08-16): resolve
  // anchor keywords from this task's title/rawText against the target project's own
  // dependency graph BEFORE it's ever claimed for drafting, so the plan/implement
  // passes already have real, validated file paths in promptContext instead of the
  // model searching for them (or worse, inventing them) from scratch on every call.
  // 'greenfield' (no graph built yet for this project) is explicitly NOT an error --
  // per the Discuss session's own note, that's just "nothing to prefetch," and the
  // task queues normally. 'no-match'/'ambiguous' are the two cases the Grill Me/
  // Discuss sessions asked to be held for a human rather than silently guessed at:
  // written to queue/needs-clarification/ instead of queue/adhoc/, invisible to
  // nextAdhocTask() (which only ever scans queue/adhoc/) until a human resolves it
  // via the dashboard.
  // graphPathOverride via config.js's resolveGraphPath() (not path-prefetch.js's own
  // graphify-out/graph.json default) -- confirmed live 2026-08-16: the dashboard's
  // Build Graph button writes to .agent-manager-cache/, not graphify-out/, so without
  // this override every real project's graph looked absent ('greenfield') even after
  // a real build, and this fast path silently never matched anything.
  const anchorResult = resolveAnchors({
    repoRoot: matchedProject.repoRoot,
    title: adhocTask.title,
    rawText,
    graphPathOverride: resolveGraphPath(matchedProject.repoRoot),
    // uiVocabHubFiles (2026-08-20, see path-prefetch.js's UI_VOCAB header): opt-in
    // per project in projects.json -- a project with no UI hub file(s) declared here
    // simply never triggers the fallback, same behavior as before this existed.
    uiVocabHubFiles: matchedProject.uiVocabHubFiles || [],
  });
  let adhocDir = path.join(matchedProject.pipelineDir, 'queue', isDerived ? 'derived' : 'adhoc');
  if (anchorResult.status === 'matched') {
    adhocTask.promptContext.prefetchedPaths = anchorResult.paths;
  } else if (anchorResult.status === 'no-match') {
    adhocDir = path.join(matchedProject.pipelineDir, 'queue', 'needs-clarification');
    adhocTask.needsClarification = { reason: 'no-match' };
  } else if (anchorResult.status === 'ambiguous') {
    adhocDir = path.join(matchedProject.pipelineDir, 'queue', 'needs-clarification');
    adhocTask.needsClarification = { reason: 'ambiguous', candidates: anchorResult.candidates };
    if (anchorResult.paths.length > 0) adhocTask.promptContext.prefetchedPaths = anchorResult.paths;
  }
  // 'greenfield': adhocTask left exactly as constructed above, queues normally with
  // no prefetchedPaths field at all -- there is nothing to prefetch from yet.

  return { queuedId, adhocTask, adhocDir };
}

// Stage: the possible-duplicate gate. Returns { skip } (a recoverable skip on the first flag) or { adhocDir } (possibly redirected to needs-clarification).
function applyDuplicateGate(ctx, matchedProject, built) {
  const { data, entry, result, rawText, brainDumpEntryId, existingQueuedTitles, brainDumpPath } = ctx;
  const { adhocTask } = built;
  let { adhocDir } = built;
  // 2026-08-24 (pipeline hardening, Grimmethy: "duplicate-task detection before
  // filing") -- brainDumpSortPlanPrompt/ImplementPrompt already showed the classifier
  // every currently-queued task title and asked it to flag a real match. Overrides
  // whatever the anchor-resolution logic above decided (even a confident path match
  // isn't worth drafting if the whole task is a duplicate) -- held for a human via the
  // SAME multiple-choice/free-text picker the "needs a human decision" adhoc path
  // already uses (adhoc-agentic-draft.js's RESOLUTION: needs-human-decision), not a
  // new UI: no structured options here since this is really a binary "is this real"
  // call the existing generic Archive button on every needs-clarification row (for
  // "yes, duplicate") plus the free-text Other box (for "no, here's why not") already
  // fully cover.
  // Validate BEFORE trusting it -- see isValidDuplicateMatch's own header for the
  // incident this closes. A classifier answer that matches nothing in the real
  // candidate list it was shown is treated as no match at all, not a duplicate flag.
  // HUB0115 1/3 -- enforce the decision order explicitly: (a) a valid match against
  // the REAL candidate list the classifier was shown is trusted (falls through to
  // the duplicate handling below); (b) else a string grounded in the note's own
  // rawText is null'd as a phrase-echo; (c) else null'd as ungrounded. (b) and (c)
  // both null -- they differ only in WHY, which recordDuplicateGateDismissal's
  // reason-keyed counter and single greppable audit line keep distinct for the
  // human reviewing the queue (HUB0118 2/3: both paths route through it).
  if (result.possibleDuplicateOf) {
    if (isValidDuplicateMatch(result.possibleDuplicateOf, existingQueuedTitles)) {
      // (a) valid candidate-list match -- trust it.
    } else if (isGroundedInInput(result.possibleDuplicateOf, rawText)) {
      // HUB0118 2/3 -- the helper call IS the dismissal record (reason-keyed counter +
      // entry.duplicateGateAttempts + the single greppable audit line); no separate
      // console.warn / raw counter increment here anymore.
      recordDuplicateGateDismissal(entry, {
        noteId: brainDumpEntryId,
        rejectedCandidate: result.possibleDuplicateOf,
        reason: 'phrase-echo',
        candidatesChecked: Array.isArray(existingQueuedTitles) ? existingQueuedTitles.length : 0,
      });
      result.possibleDuplicateOf = null;
    } else {
      // HUB0118 2/3 -- same: the helper call is the one and only dismissal record.
      recordDuplicateGateDismissal(entry, {
        noteId: brainDumpEntryId,
        rejectedCandidate: result.possibleDuplicateOf,
        reason: 'ungrounded',
        candidatesChecked: Array.isArray(existingQueuedTitles) ? existingQueuedTitles.length : 0,
      });
      result.possibleDuplicateOf = null;
    }
  }
  if (result.possibleDuplicateOf) {
    // Bounded one-retry gate (2026-09-15, brain-dump bd-1788900769368: "All three
    // 'failing' tasks share identical death signature... with zero model_calls" --
    // root-caused live: a fuzzy title-match false positive here used to route
    // straight to needs-clarification every time, with no way back -- this decision
    // happens at APPLY time for the brain_dump_sort CLASSIFICATION task, before the
    // downstream adhoc task this block builds ever exists, so reject-retry-check.js's
    // retry machinery (which only ever sees adhoc/research tasks, not this one) can
    // never reach it. Mirrors needs-clarification-triage.js's own ncTriageAttempts/
    // MAX_REQUEUES pattern -- and reuses recoverableSortSkip, the SAME mechanism this
    // file already relies on for every other "give it one more classification pass"
    // case just above -- by leaving entry.status as 'captured' (not writing the
    // downstream adhoc task, not marking the entry actioned), nextBrainDumpSortTask()
    // naturally re-drafts a fresh classification of this same note later, which may
    // well not repeat the same fuzzy match on a differently-worded pass. The counter
    // lives on the brain-dump ENTRY (not the classification task or the not-yet-built
    // adhocTask) since the entry is the one object that genuinely persists across
    // repeated classification attempts of the same logical note.
    const duplicateGateAttempts = Number(entry.duplicateGateAttempts) || 0;
    if (duplicateGateAttempts < 1) {
      entry.duplicateGateAttempts = duplicateGateAttempts + 1;
      console.warn(`[apply-group-a-brain-dump] possible-duplicate gate: entry ${brainDumpEntryId} matched against "${result.possibleDuplicateOf}" (duplicateGateAttempts=${entry.duplicateGateAttempts}) -- retrying with a fresh classification pass instead of routing to needs-clarification`);
      return { skip: recoverableSortSkip(data, entry, brainDumpPath,
        `possible duplicate of "${result.possibleDuplicateOf}" on the first flag -- retrying with a fresh classification pass`) };
    }
    console.warn(`[apply-group-a-brain-dump] possible-duplicate gate: entry ${brainDumpEntryId} matched against "${result.possibleDuplicateOf}" again (duplicateGateAttempts=${duplicateGateAttempts}) -- routing to needs-clarification`);
    adhocDir = path.join(matchedProject.pipelineDir, 'queue', 'needs-clarification');
    adhocTask.needsClarification = {
      reason: 'design-decision',
      openQuestions: (
        `This brain-dump note was flagged as a possible duplicate of an already-` +
        `queued task:\n\n  "${result.possibleDuplicateOf}"\n\n` +
        `NOTE (this task's own text): ${rawText}\n\n` +
        'If this genuinely is the same underlying feature/fix, use the Archive ' +
        'button on this row instead of answering below. If it is NOT actually a ' +
        'duplicate (different scope, different project, coincidental overlap), ' +
        'explain why in the box below and submit to send it to drafting.'
      ),
    };
  }

  return { adhocDir };
}

// Stage: write the adhoc task into its queue dir and mark the brain-dump entry actioned.
function writeAdhocTask(ctx, matchedProject, built, adhocDir) {
  const { data, entry, brainDumpPath } = ctx;
  const { queuedId, adhocTask } = built;
  adhocTask.generatedForRepoRoot = matchedProject.repoRoot;

  fs.mkdirSync(adhocDir, { recursive: true });
  writeJsonAtomicSync(path.join(adhocDir, `${queuedId}.json`), adhocTask);

  entry.status = 'actioned';
  entry.queuedTaskId = queuedId;
  entry.queuedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(brainDumpPath), { recursive: true });
  writeJsonAtomicSync(brainDumpPath, data);

  return { file: path.join(adhocDir, `${queuedId}.json`), queuedTaskId: queuedId, queuedProject: matchedProject.label };
}

// Stage: a result naming a registered project becomes an adhoc task in that project (or a recoverable skip when the project cannot take one).
function queueProjectTask(ctx, matchedProject) {
  const { data, entry, brainDumpPath } = ctx;
  if (readProjectDomains(matchedProject).includes('adhoc')) {
    const built = buildAdhocTaskForEntry(ctx, matchedProject);
    const gate = applyDuplicateGate(ctx, matchedProject, built);
    if (gate.skip) return gate.skip;
    return writeAdhocTask(ctx, matchedProject, built, gate.adhocDir);
  }
  // Matched a real project but it has no 'adhoc' domain -- a config gap that needs a
  // human, not a silent downgrade to a passive note.
  return recoverableSortSkip(data, entry, brainDumpPath,
    `matched project "${matchedProject.label}" has no 'adhoc' domain registered -- cannot queue work there`);
}

// Stage: the passive vault-note fallback for an entry not tied to any tracked project.
function filePassiveNote(ctx) {
  const { data, entry, result, secondBrainDir, rawText, brainDumpPath } = ctx;
  const fullPath = path.join(secondBrainDir, result.secondBrainPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const tagsSuffix = result.tags.length ? ` _(${result.tags.join(', ')})_` : '';
  const links = resolveNoteLinks(result, secondBrainDir, path.basename(result.secondBrainPath, '.md'));
  const wikiSuffix = links.length ? ` -- see ${links.map((n) => `[[${n}]]`).join(', ')}` : '';
  const line = `\n- **${stamp}** ${rawText}${tagsSuffix}${wikiSuffix}\n`;
  appendMarkdownLineAtomic(fullPath, line);

  entry.status = 'sorted';
  entry.sort = {
    secondBrainPath: result.secondBrainPath,
    tags: result.tags,
    actionable: result.actionable,
    rationale: result.rationale,
  };
  entry.sortedAt = new Date().toISOString();

  fs.mkdirSync(path.dirname(brainDumpPath), { recursive: true });
  writeJsonAtomicSync(brainDumpPath, data);

  return { file: fullPath };
}

function applyBrainDumpSort({ implementResponse, task, brainDumpPath, secondBrainDir, pipelineDir }) {
  const loaded = loadAndClassifyEntry({ implementResponse, task, brainDumpPath, secondBrainDir, pipelineDir });
  if (loaded.done) return loaded.done;
  const { ctx } = loaded;
  const { result, data, entry } = ctx;

  // Brain Dump #1 follow-up (2026-08-17): a note can be actionable WITHOUT being a code
  // change -- "investigate X, document findings" needs real web research, not a diff
  // against any tracked project. Only when NO tracked project was named/recovered -- a
  // note tied to a project routes to that project's queue below, never to research.
  if (result.requiresResearch && !result.belongsToProject) {
    return queueResearchTask(ctx);
  }

  // A note naming a tracked project IS work -- queue a real adhoc task in that project's
  // own queue. The old `result.actionable &&` precondition is dropped (2026-09-03, user:
  // "a note describing a concrete change to a tracked project always becomes a work task"):
  // a project-labelled note the classifier forgot to mark actionable is still a task, and
  // deriveBelongsToProject already forces actionable when it recovers a self-project label.
  const matchedProject = result.belongsToProject
    ? readProjectRegistry().find((p) => p.label === result.belongsToProject)
    : null;

  if (result.belongsToProject && !matchedProject) {
    // reviewBrainDumpSort should have blocked a non-tracked label; if one slipped through,
    // don't silently downgrade it to a passive note -- that masks the misclassification.
    return recoverableSortSkip(data, entry, brainDumpPath,
      `belongsToProject "${result.belongsToProject}" does not match any registered project -- a corrected pass should name a tracked label or null`);
  }

  if (matchedProject) return queueProjectTask(ctx, matchedProject);

  return filePassiveNote(ctx);
}

function closeBrainDumpEntryResolved({ brainDumpPath, brainDumpEntryId, note }) {
  if (!brainDumpPath || !brainDumpEntryId) return { skipped: true, reason: 'no brainDumpPath/brainDumpEntryId to close' };

  let data;
  try {
    data = JSON.parse(fs.existsSync(brainDumpPath) ? fs.readFileSync(brainDumpPath, 'utf8') : '{"entries":[]}');
  } catch {
    return { skipped: true, reason: 'brain-dump.json unreadable -- not closing anything' };
  }
  if (!Array.isArray(data.entries)) return { skipped: true, reason: 'brain-dump.json has no entries array' };

  const entry = data.entries.find((e) => e && e.id === brainDumpEntryId);
  if (!entry) return { skipped: true, reason: `brain-dump entry "${brainDumpEntryId}" no longer exists` };

  entry.status = 'actioned';
  entry.resolvedNote = note;
  entry.resolvedAt = new Date().toISOString();
  writeJsonAtomicSync(brainDumpPath, data);
  return { closed: true, entryId: brainDumpEntryId };
}

module.exports = { allNoteBasenames, resolveNoteLinks, appendMarkdownLineAtomic, loadBrainDump, findEntry, recoverableSortSkip, applyBrainDumpSort, closeBrainDumpEntryResolved, readProjectRegistry, isValidDuplicateMatch, isGroundedInInput, duplicateGateDismissals, recordDuplicateGateDismissal, originProjectFor };
