'use strict';

// Assembles the "grounding source" -- the material an LLM was actually handed for a task --
// so a fact-check pass can flag any value in a draft that was fabricated (present in NONE
// of its inputs). A registered task source can extend grounding via a `groundingFields`
// array or an `extractGrounding` function without this file ever needing to change.
//
// CLI: node get-grounding-source.js <task.json>
// Writes the assembled grounding text to stdout, or nothing if there's nothing to ground.

const fs = require('fs');
const { getRegisteredSource } = require('./task-source-registry.js');
const { ensureRegistered } = require('./config.js');

// Registers this package's 6 built-in sources FIRST (side effect of the require) -- the
// consumer's own registration file (ensureRegistered, below) calls updateTaskSource on
// some of these built-ins, which throws if the base entry isn't registered yet.
require('./task-sources.js');
ensureRegistered();

function resolveSourceName(task) {
  if (task.domain === 'adhoc') return 'adhoc';
  if (task.domain === 'secondbrain') return 'secondbrain';
  if (task.source === 'deadcode_triage') return 'unused_export';
  return task.source;
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
    // added by a plan pass that used a tool (see ornith-tool-client.js), not pre-fetched
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

  process.stdout.write(parts.join('\n\n'));
}

main();
