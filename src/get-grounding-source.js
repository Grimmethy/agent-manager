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
const REPO_FILE_PATH_RE = /\b(?:src|python|scripts|docs)\/[\w./-]+\.(?:js|py|sh|md)\b/g;

function extractLiveRepoGrounding(text, repoRoot) {
  if (!text || !repoRoot) return [];
  const resolvedRoot = path.resolve(repoRoot);
  const candidates = new Set(text.match(REPO_FILE_PATH_RE) || []);
  const found = [];
  for (const candidate of candidates) {
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
    found.push({
      path: candidate,
      content: content.length > LIVE_FETCH_MAX_CHARS_PER_FILE
        ? `${content.slice(0, LIVE_FETCH_MAX_CHARS_PER_FILE)}\n...[truncated]`
        : content,
    });
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
