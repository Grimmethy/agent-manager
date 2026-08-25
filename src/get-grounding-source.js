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
    const full = path.join(resolvedRoot, candidate);
    // Path-traversal guard -- a candidate matched by the regex could still contain '..'
    // segments; refuse anything that resolves outside repoRoot rather than trust the regex
    // alone to have excluded it.
    if (!full.startsWith(resolvedRoot + path.sep)) continue;
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
  // file none of those fields happen to cover. Fails open (getConfig() can throw if
  // AGENT_MANAGER_REPO_ROOT is unset -- a context/test-environment gap, not a reason to
  // fail this whole grounding assembly) same as reasoningTierFor()'s own established
  // try/catch treatment of the identical getConfig() call.
  if (task.domain === 'adhoc' && task.implementResponse) {
    let repoRoot = null;
    try {
      ({ repoRoot } = getConfig());
    } catch (e) {
      repoRoot = null;
    }
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

  process.stdout.write(parts.join('\n\n'));
}

module.exports = { extractLiveRepoGrounding, main };

if (require.main === module) {
  main();
}
