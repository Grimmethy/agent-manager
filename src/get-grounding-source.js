'use strict';

// Assembles the "grounding source" -- the material an LLM was actually handed for a task --
// so a fact-check pass can flag any value in a draft that was fabricated (present in NONE
// of its inputs). A registered task source can extend grounding via a `groundingFields`
// array or an `extractGrounding` function without this file ever needing to change.
//
// CLI: node get-grounding-source.js <task.json>
// Writes the assembled grounding text to stdout, or nothing if there's nothing to ground.

const fs = require('fs');
const path = require('path');
const { getRegisteredSource, resolveSourceName } = require('./task-source-registry.js');
const { getConfig, ensureRegistered } = require('./config.js');

// Registers this package's 6 built-in sources FIRST (side effect of the require) -- the
// consumer's own registration file (ensureRegistered, below) calls updateTaskSource on
// some of these built-ins, which throws if the base entry isn't registered yet.
require('./task-sources.js');
ensureRegistered();

// 2026-08-24 (Grimmethy: "Fix the grounding gap") -- caught live: an adhoc task's real
// agentic Claude pass (adhoc-agentic-draft.js) has live Read/Grep/Bash access and
// investigates the CURRENT repo directly, completely independent of the task's own
// promptContext -- which is a snapshot captured at task-CREATION time, before any real
// investigation happened, and for an adhoc/manual task with no other grounding fields
// this file only ever had that stale snapshot to offer (see the `parts.length === 0 &&
// task.domain === 'adhoc'` fallback below). A real, correct claim about a file the
// snapshot never captured (or captured a different, unrelated file for) then reads as
// "unverified" / fabricated to the reviewer purely because the evidence is outdated, not
// because the claim is wrong -- confirmed live: a decompose sub-task correctly described
// src/model-stats-client.js's real recordCall() signature, rejected because the stale
// snapshot only showed python/dashboard/model_stats_client.py's differently-shaped
// wrapper of the same underlying table.
//
// Fix: for an adhoc task, deterministically extract any src/python/scripts/docs file path
// the draft itself REFERENCES (in its implementResponse -- covers the plain summary, a
// real === DIFF === section, and a decompose JSON sub-task list all at once, since all
// three live in that one field) and fetch each one's CURRENT real content directly from
// the repo, live, at review time -- not what the drafter was given, what the drafter's
// own claim can actually be checked against right now. Deterministic (no LLM judgment),
// capped (LIVE_FETCH_MAX_FILES/LIVE_FETCH_MAX_CHARS_PER_FILE) so a draft that happens to
// mention many paths can't blow up the review prompt's size.
const LIVE_FETCH_MAX_FILES = 5;
const LIVE_FETCH_MAX_CHARS_PER_FILE = 4000;

// For an adhoc task resolved `no-changes-needed`, the reviewer's job is a coverage check:
// is every concrete thing the request names actually present in the current code? Pull the
// candidate "objects" out of the raw request text and grep each against the real repo NOW,
// so the vote sees "what the repo actually has for `gallery` / `image` / `nsfw`" rather
// than only whatever the drafter's own summary chose to cite. Deterministic, bounded.
const REQUEST_OBJECT_STOPWORDS = new Set([
  'should', 'shall', 'when', 'with', 'that', 'this', 'from', 'have', 'into', 'their', 'them',
  'then', 'they', 'will', 'would', 'could', 'being', 'such', 'also', 'only', 'each', 'both',
  'some', 'more', 'most', 'other', 'while', 'where', 'what', 'your', 'about', 'after', 'before',
  'tagged', 'selected', 'checkbox', 'check', 'these', 'those', 'here', 'there', 'been', 'does',
  'hide', 'show', 'make', 'like', 'need', 'want', 'note', 'used', 'uses', 'able', 'must',
]);
const MAX_REQUEST_OBJECT_TOKENS = 8;
const MAX_HITS_PER_OBJECT = 4;

function extractRequestObjectTokens(rawText) {
  const text = String(rawText || '');
  const tokens = new Set();
  for (const m of text.matchAll(/\/[A-Za-z][\w/-]{2,}/g)) tokens.add(m[0]);                 // /api/... paths
  for (const m of text.matchAll(/["'`]([^"'`]{3,40})["'`]/g)) tokens.add(m[1].trim());       // "quoted phrases"
  for (const m of text.matchAll(/\b[A-Za-z_][A-Za-z0-9]*(?:[_][A-Za-z0-9]+|[A-Z][a-z0-9]+)+\b/g)) tokens.add(m[0]); // camelCase / snake_case
  for (const m of text.matchAll(/\b[A-Za-z]{4,}\b/g)) {                                      // plain content words
    if (!REQUEST_OBJECT_STOPWORDS.has(m[0].toLowerCase())) tokens.add(m[0]);
  }
  return [...tokens].slice(0, MAX_REQUEST_OBJECT_TOKENS);
}

function buildRequestObjectGrounding(rawText) {
  const tokens = extractRequestObjectTokens(rawText);
  if (tokens.length === 0) return '';
  // grepCodebase (via fetchForQueries) matches a single-word query case-SENSITIVELY, so a
  // request that writes "NSFW" would never find `nsfw` in code. Search each token plus its
  // lower/upper-cased forms and fold the hits back onto the original token -- the same
  // case-normalization discuss_sessions.py's _expand_grep_terms does on the Python side.
  const variantToTok = new Map();
  const queries = [];
  for (const tok of tokens) {
    for (const v of new Set([tok, tok.toLowerCase(), tok.toUpperCase()])) {
      if (!variantToTok.has(v)) { variantToTok.set(v, tok); queries.push(v); }
    }
  }
  let hits = [];
  try {
    hits = require('./arch-import-fetch.js').fetchForQueries(queries).hits || [];
  } catch (e) {
    console.error('[get-grounding-source] fetchForQueries failed:', e && e.message ? e.message : String(e));
    return '';
  }
  const byTok = new Map(tokens.map((t) => [t, []]));
  for (const h of hits) {
    const tok = variantToTok.get(h.query);
    if (tok && byTok.has(tok)) byTok.get(tok).push(h);
  }
  const lines = [
    '=== REQUEST OBJECTS -- current repo state (each noun/identifier from the request text, ' +
    'grepped against the real repo NOW; "(no match ...)" means the request names something ' +
    'the current code has no trace of -- a strong signal the request is NOT already done) ===',
  ];
  for (const tok of tokens) {
    const tokHits = (byTok.get(tok) || []).slice(0, MAX_HITS_PER_OBJECT);
    lines.push(tokHits.length
      ? `- "${tok}": ${tokHits.map((h) => `${h.file}:${h.line}`).join(', ')}`
      : `- "${tok}": (no match in the searched code dirs)`);
  }
  return lines.join('\n');
}
// 2026-08-24 regression, caught investigating a real blocked task: the draft correctly
// cited `python/dashboard/templates/index.html:882-895` as proof a feature already
// existed -- .html was never in this extension list, so the ONE file that actually
// contained the cited code never got fetched at all, and review kept rejecting a true
// "no-changes-needed" verdict as unconfirmed even after this whole live-grounding
// mechanism shipped. Added html/json -- the other real file types this codebase's own
// citable sources (dashboard templates, config) actually use.
const REPO_FILE_PATH_RE = /\b((?:src|python|scripts|docs)\/[\w./-]+\.(?:js|py|sh|md|html|json))(?::(\d+)(?:-(\d+))?)?/g;
// Same incident, second half of the bug: the OTHER file the draft cited (app.py) DID
// match, but flat-truncating from the start of a 4600-line/231KB file never reached line
// 399 where the actually-relevant route lived -- the "grounding" was still functionally
// empty. When a citation carries a line number (`file.py:399-427`, the exact shape this
// pipeline's own draft prompts ask for), center the fetched window on it instead.
const LIVE_FETCH_CONTEXT_LINES = 60;

// 2026-08-25, third round of the same underlying bug -- caught live via a real blocked
// task: a pure UI change to a ~4700-line index.html added new constants (JOB_TYPE_FAMILIES
// etc.) around line 2478, but the draft's own prose summary ("Only index.html changed, as
// expected") carried no `file.ext:line` citation -- REPO_FILE_PATH_RE above only ever
// recognizes THAT prose shape, never a real diff's own line info, so with no citation to
// center on, extractContentWindow fell back to the file's first 4000 characters (nowhere
// near line 2478). The fact-checker then correctly-per-its-own-logic flagged the new
// constants as "not found in source" -- a structural false positive for any real diff deep
// in a large file with no matching prose citation, not an actual hallucination.
//
// adhoc-agentic-draft.js's own implementResponse ALWAYS carries a real, standard unified
// diff when there's a diff at all (`=== DIFF ===\n${task.rawDiff}`, task.rawDiff captured
// via a real `git diff`) -- that diff's own `@@ -a,b +c,d @@` hunk header already states
// exactly which lines changed, far more reliably than hoping the model's prose summary
// happens to also cite a line number. Parsed here as a second, independent source of line
// info for the SAME byPath map extractLiveRepoGrounding builds below, keyed by the diff
// header's own b/<path> (the post-change file) -- only used to FILL IN a path that has no
// prose-citation line number yet, never overrides a real citation that's already present.
const DIFF_GIT_HEADER_RE = /^diff --git a\/(?:\S+) b\/(\S+)/;
const DIFF_HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

function extractDiffHunkLineRefs(text) {
  const refs = new Map();
  let currentPath = null;
  for (const line of text.split('\n')) {
    const headerMatch = line.match(DIFF_GIT_HEADER_RE);
    if (headerMatch) {
      currentPath = headerMatch[1];
      continue;
    }
    if (!currentPath) continue;
    const hunkMatch = line.match(DIFF_HUNK_RE);
    // Only the FIRST hunk per file -- same "first reference wins" convention as byPath's
    // own dedup below; a file touched by several scattered hunks still gets a real,
    // in-the-right-neighborhood window instead of no window at all, which is the actual
    // bug being fixed here.
    if (hunkMatch && !refs.has(currentPath)) {
      const startLine = Number(hunkMatch[1]);
      const lineCount = hunkMatch[2] ? Number(hunkMatch[2]) : 1;
      refs.set(currentPath, { startLine, endLine: startLine + Math.max(lineCount - 1, 0) });
    }
  }
  return refs;
}

function extractContentWindow(content, startLine, endLine) {
  if (content.length <= LIVE_FETCH_MAX_CHARS_PER_FILE) return content;
  if (!startLine) return `${content.slice(0, LIVE_FETCH_MAX_CHARS_PER_FILE)}\n...[truncated]`;

  const lines = content.split('\n');
  const from = Math.max(0, startLine - 1 - LIVE_FETCH_CONTEXT_LINES);
  const to = Math.min(lines.length, (endLine || startLine) + LIVE_FETCH_CONTEXT_LINES);
  const windowed = lines.slice(from, to).join('\n');
  const header = `...[showing lines ${from + 1}-${to}, around the cited line(s)]...\n`;
  return windowed.length <= LIVE_FETCH_MAX_CHARS_PER_FILE
    ? `${header}${windowed}`
    : `${header}${windowed.slice(0, LIVE_FETCH_MAX_CHARS_PER_FILE)}\n...[truncated]`;
}

// Path-traversal guard shared by extractLiveRepoGrounding and refreshFetchedFileContent
// below -- a candidate path could still contain '..' segments even when it came from a
// deterministic source (nextCandidateFulfillmentTask()'s own files list), so both call
// sites refuse anything that resolves outside repoRoot rather than trust the source alone.
function resolveWithinRoot(resolvedRoot, candidate) {
  const full = path.join(resolvedRoot, candidate);
  return full.startsWith(resolvedRoot + path.sep) ? full : null;
}

// 2026-08-27 (Grimmethy: "pipeline was running smoothly until we merged 9 branches, now
// everything is going to blocked") -- root-caused live: observability_fix/arch_review
// candidate-fulfillment tasks ground their draft against promptContext.fetchedFiles, a
// snapshot of each named file's content taken once at CANDIDATE-CREATION time
// (nextCandidateFulfillmentTask(), task-sources.js). That snapshot is never refreshed
// before review runs. When several sibling candidates (e.g. 8+ observability-fix/
// arch-review ACs) all touch the same few files and get merged serially, a task still
// in flight keeps getting fact-checked against an increasingly stale pre-merge snapshot --
// confirmed live via observability-fix-ac-3's retry history: re-drafted 4 times over ~20
// hours as sibling ACs (ac-4, ac-11, ac-18, ...) merged in around it, blocked each time on
// slightly different grounds about the same catch block in budget-monitor.js.
//
// Fix: at review time, re-read each fetchedFiles path's CURRENT content straight from
// repoRoot instead of trusting the frozen snapshot -- same "check the claim against
// reality right now" principle extractLiveRepoGrounding already applies for adhoc tasks
// below, just applied to a deterministic path list instead of regex-extracted ones. Falls
// back to the frozen snapshot content when a live read isn't possible (repoRoot unset in
// this environment, or the file has since been deleted/moved by a merge) -- stale grounding
// beats no grounding at all, same reasoning extractLiveRepoGrounding's own catch uses.
function refreshFetchedFileContent(fetchedFiles, repoRoot) {
  if (!repoRoot) return fetchedFiles;
  const resolvedRoot = path.resolve(repoRoot);
  return fetchedFiles.map((f) => {
    if (!f || !f.path) return f;
    const full = resolveWithinRoot(resolvedRoot, f.path);
    if (!full) return f;
    try {
      return { ...f, content: fs.readFileSync(full, 'utf8') };
    } catch (e) {
      return f; // deleted/moved since the snapshot was taken -- fall back to the frozen copy.
    }
  });
}

function extractLiveRepoGrounding(text, repoRoot) {
  if (!text || !repoRoot) return [];
  const resolvedRoot = path.resolve(repoRoot);
  // Keyed by path so a file cited more than once keeps the FIRST real line reference seen
  // for it, rather than the regex's own Set-of-strings dedup (pre-this-fix) silently
  // discarding whichever line number happened to not be on the first mention.
  const byPath = new Map();
  for (const m of text.matchAll(REPO_FILE_PATH_RE)) {
    const [, candidate, startLine, endLine] = m;
    const existing = byPath.get(candidate);
    if (!existing || (!existing.startLine && startLine)) {
      byPath.set(candidate, { startLine: startLine ? Number(startLine) : null, endLine: endLine ? Number(endLine) : null });
    }
  }

  // Fill in a real diff hunk's own line info for any path REPO_FILE_PATH_RE found (or
  // missed entirely) with no prose citation -- see DIFF_GIT_HEADER_RE/DIFF_HUNK_RE's own
  // header comment for the incident this closes. Never overrides a real prose citation
  // that's already present.
  for (const [candidate, ref] of extractDiffHunkLineRefs(text)) {
    const existing = byPath.get(candidate);
    if (!existing || !existing.startLine) byPath.set(candidate, ref);
  }

  const found = [];
  for (const [candidate, lineRef] of byPath) {
    if (found.length >= LIVE_FETCH_MAX_FILES) break;
    const full = resolveWithinRoot(resolvedRoot, candidate);
    if (!full) continue;
    let content;
    try {
      content = fs.readFileSync(full, 'utf8');
    } catch (e) {
      continue; // matched a path SHAPE but isn't a real file -- not evidence either way, skip.
    }
    found.push({ path: candidate, content: extractContentWindow(content, lineRef.startLine, lineRef.endLine) });
  }
  return found;
}

function main() {
  const taskPath = process.argv[2];
  const task = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
  const pc = task.promptContext;
  const parts = [];

  // Resolved once, used both to refresh fetchedFiles below and for the adhoc live-fetch
  // block further down. Fails open (getConfig() can throw if AGENT_MANAGER_REPO_ROOT is
  // unset -- a context/test-environment gap, not a reason to fail this whole grounding
  // assembly) same as reasoningTierFor()'s own established try/catch treatment of the
  // identical getConfig() call.
  let repoRoot = null;
  try {
    ({ repoRoot } = getConfig());
  } catch (e) {
    repoRoot = null;
  }

  if (pc) {
    if (pc.existingStub) parts.push(String(pc.existingStub));
    if (pc.siblingExample && pc.siblingExample.content) parts.push(String(pc.siblingExample.content));
    if (pc.goalMdFull) parts.push(String(pc.goalMdFull));
    if (pc.csvRow) parts.push(JSON.stringify(pc.csvRow));
    if (pc.body) parts.push(String(pc.body));
    if (pc.noteContent) parts.push(String(pc.noteContent));
    if (pc.files) {
      for (const f of [].concat(pc.files)) {
        if (f.content) parts.push(String(f.content));
      }
    }
    // 2026-08-27, root-caused live via 3 real blocked observability_fix candidates
    // (AC-3, AC-4, AC-11): nextCandidateFulfillmentTask() (task-sources.js) populates
    // promptContext.fetchedFiles -- {path, content} pairs holding the REAL current
    // content of each file the candidate names -- and local-draft.js reads it to ground
    // the draft's find/replace edits. This function never looked at that field at all
    // (pc.files above is a DIFFERENT, unrelated shape for a different set of sources --
    // a plain array of filename strings here, so `f.content` on a string is always
    // undefined and silently contributes nothing). The practical effect: a
    // candidate-fulfillment draft that correctly quoted a real file verbatim (confirmed
    // live: budget-monitor.js's actual `const os = require('os');` and a real bare
    // `catch {}` block, byte-for-byte) got reviewed with NO grounding for that file at
    // all, and the reviewer -- correctly per what it was actually given -- rejected the
    // edit as unconfirmed. Every root-level file (no src/python/scripts/docs/ prefix)
    // was hit hardest: extractLiveRepoGrounding's own live-fetch fallback below can't
    // reach those either (REPO_FILE_PATH_RE requires that prefix), so there was no
    // fallback catching this the way there is for adhoc's own equivalent gap.
    if (pc.fetchedFiles) {
      // Re-read each path's CURRENT content from repoRoot rather than trusting the frozen
      // creation-time snapshot -- see refreshFetchedFileContent's own comment for the
      // incident (sibling candidate branches merging out from under a still-queued task)
      // this closes. Falls back to the frozen f.content when a live read isn't possible.
      const refreshed = refreshFetchedFileContent([].concat(pc.fetchedFiles), repoRoot);
      for (const f of refreshed) {
        if (f && f.content) parts.push(String(f.content));
      }
    }
    // toolCallLog lives directly on the task object, not inside promptContext -- it's
    // added by a plan pass that used a tool (see local-tool-client.js), not pre-fetched
    // deterministically like the fields above. Without this, a plan pass that used a tool
    // correctly and found something real would still get rejected as "unverifiable".
    if (task.toolCallLog && task.toolCallLog.length > 0) {
      parts.push(JSON.stringify(task.toolCallLog));
    }

    const sourceName = resolveSourceName(task);
    const source = getRegisteredSource(sourceName);
    if (source) {
      if (Array.isArray(source.groundingFields)) {
        for (const fieldName of source.groundingFields) {
          const value = pc[fieldName];
          if (value) parts.push(typeof value === 'object' ? JSON.stringify(value) : String(value));
        }
      }
      if (typeof source.extractGrounding === 'function') {
        const extracted = source.extractGrounding(pc, task);
        if (extracted) parts.push(String(extracted));
      }
    }

    if (parts.length === 0 && task.domain === 'adhoc') {
      parts.push(JSON.stringify(pc));
    }
  }

  // Live current-repo enrichment (see this file's own comment above) -- unconditional for
  // every adhoc task with a real implement draft, not just the parts.length===0 fallback
  // case, since even a task WITH other grounding fields can still make a claim about a
  // file none of those fields happen to cover.
  if (task.domain === 'adhoc' && task.implementResponse) {
    const liveFiles = extractLiveRepoGrounding(task.implementResponse, repoRoot);
    if (liveFiles.length > 0) {
      parts.push([
        '=== LIVE current repo content (fetched fresh at REVIEW time to check the draft\'s ' +
        'own file/code claims against reality -- this is NOT material the drafter was given; ' +
        'the drafter had its own real Read/Grep/Bash access and found these paths itself. A ' +
        'claim that matches this content is CONFIRMED, not merely plausible. ===',
        ...liveFiles.map((f) => `--- ${f.path} ---\n${f.content}`),
      ].join('\n\n'));
    }
  }

  // A `no-changes-needed` adhoc draft claims "already implemented" -- give the reviewer the
  // current repo state for every object the ORIGINAL request names, not just the files the
  // draft's own summary happened to cite. See buildRequestObjectGrounding above.
  if (task.domain === 'adhoc' && task.adhocResolution === 'no-changes-needed' && repoRoot && pc && pc.rawText) {
    const objGrounding = buildRequestObjectGrounding(pc.rawText);
    if (objGrounding) parts.push(objGrounding);
  }

  process.stdout.write(parts.join('\n\n'));
}

module.exports = { extractLiveRepoGrounding, refreshFetchedFileContent, extractRequestObjectTokens, buildRequestObjectGrounding, main };

if (require.main === module) {
  main();
}
