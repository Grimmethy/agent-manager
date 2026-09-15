'use strict';

// Drains queue/context-log-inbox/ (written by local-tool-client.js's runPlanWithTools(),
// see context-log-marker.js's own header) into one Second Brain note PER CHAT SESSION,
// matching this codebase's own established watchdog-sweep convention (side-finding-sweep.js,
// adhoc-staleness-flag.js) rather than writing the note synchronously at extraction time.
//
// Deliberately NOT routed through brain_dump_sort or brain-dump.json at all -- that's the
// human-facing Brain Dump tab, and a compacted entry per Chat exchange would flood it
// (Grimmethy: "a sorting system we could train to file them away properly rather than
// flooding the pipeline" -- what gets reused here is the SAME machine-written-directory
// convention brain-dump-sort-classify.js's own CANONICAL_TOP_LEVEL already excludes
// `Agent Manager Reports/`/`Model Benchmarks/`/`OrnithDebug/` from, not its LLM
// classifier -- a second model call per Chat exchange would compete for the same GPU
// Chat's own turn already holds, exactly the contention this session has repeatedly
// hardened against). Notes land under `Agent Manager Reports/Chat Context Logs/`,
// alongside those other machine-written report dirs, and are never scanned/routed by
// brain_dump_sort.
//
// No task-reference classifier either: Chat already knows which task it was discussing
// (it called read_task or one of the unstick tools) and states TASK-REF: directly in its
// own response (see context-log-marker.js) -- this sweep only VERIFIES that reference is
// real (via findTaskAnywhere) before writing a `[[project]]` link, following the vault's
// own established pattern for referencing something that isn't itself a note (see
// Research/agent-manager.md: "New concept in [[agent-manager]] (`concepts.json`
// `concept-...`)" -- wikilink the project's own note, cite the specific id in backticks).
// A taskRef that doesn't resolve (already moved/deleted since the exchange) is silently
// omitted, never guessed at.
//
// Kill switch: AGENT_MANAGER_CONTEXT_LOG_SWEEP=false.

const fs = require('fs');
const path = require('path');
const { inboxDir } = require('./context-log-marker.js');
const { appendMarkdownLineAtomic } = require('./apply-group-a-brain-dump.js');
const { findTaskAnywhere } = require('./task-anywhere.js');

const BATCH_CAP = Number(process.env.AGENT_MANAGER_CONTEXT_LOG_SWEEP_BATCH) || 50;
const CONTEXT_LOG_SUBDIR = path.join('Agent Manager Reports', 'Chat Context Logs');

function readInboxItems(pipelineDir) {
  const dir = inboxDir(pipelineDir);
  let names;
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.slice(0, BATCH_CAP)) {
    const filePath = path.join(dir, name);
    try {
      const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (record && record.sessionId && record.summary) out.push({ record, filePath });
    } catch { /* malformed -- skip, cleaned up below regardless */ }
  }
  return out;
}

function notePath(secondBrainDir, sessionId) {
  // sessionId is our own `chat-<epoch>-<hex8>` format (chat_sessions.py) -- already a
  // safe filename with no path-traversal risk, but stripped of anything non-alphanumeric
  // besides `-` defensively rather than trusting that shape blindly forever.
  const safe = String(sessionId).replace(/[^a-zA-Z0-9-]/g, '');
  return path.join(secondBrainDir, CONTEXT_LOG_SUBDIR, `${safe}.md`);
}

// Verifies taskRef actually exists in this pipeline before linking to it -- omit, don't
// guess, on anything that doesn't resolve (already moved/deleted since the exchange, or
// simply wrong). repoRoot's own basename is the project's real Second Brain note name --
// confirmed against python/dashboard/app.py's own project registry ("label":
// Path(normalized_root).name), the same value every tracked project's own research note
// is already named after (e.g. Research/agent-manager.md).
function resolveTaskRefSuffix(pipelineDir, repoRoot, taskRef) {
  if (!taskRef) return '';
  const found = findTaskAnywhere(pipelineDir, taskRef);
  if (!found) return '';
  const projectName = path.basename(repoRoot || pipelineDir);
  return ` -- [[${projectName}]] (task \`${taskRef}\`)`;
}

async function sweep({ pipelineDir, repoRoot, secondBrainDir, dryRun = false, now = Date.now() }) {
  const summary = { scanned: 0, appended: 0, errors: 0, wouldAppend: [] };
  if (process.env.AGENT_MANAGER_CONTEXT_LOG_SWEEP === 'false') return summary;
  if (!secondBrainDir) return summary; // nothing configured -- fail open, not an error

  const items = readInboxItems(pipelineDir);
  summary.scanned = items.length;
  if (items.length === 0) return summary;

  const nowIso = new Date(now).toISOString();

  for (const { record, filePath } of items) {
    try {
      const dest = notePath(secondBrainDir, record.sessionId);
      const suffix = resolveTaskRefSuffix(pipelineDir, repoRoot, record.taskRef);
      const line = `\n- **${nowIso}** ${record.summary}${suffix}\n`;
      if (dryRun) {
        summary.wouldAppend.push({ dest, line });
      } else {
        // appendMarkdownLineAtomic (unlike this module) assumes its target directory
        // already exists -- true for the canonical vault folders every other caller
        // writes into, not yet true the very first time this session's own subdir gets
        // created.
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        appendMarkdownLineAtomic(dest, line);
      }
      summary.appended += 1;
    } catch (e) {
      console.error(`[context-log-sweep] ${filePath}: ${e && e.message}`);
      summary.errors += 1;
    }
  }

  for (const { filePath } of items) {
    if (!dryRun) { try { fs.unlinkSync(filePath); } catch { /* already gone -- fine */ } }
  }

  return summary;
}

module.exports = { sweep, BATCH_CAP, CONTEXT_LOG_SUBDIR, notePath };

// --- CLI --------------------------------------------------------------------------
if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  const { getConfig } = require('./config.js');
  const { pipelineDir, repoRoot, secondBrainDir } = getConfig();
  sweep({ pipelineDir, repoRoot, secondBrainDir, dryRun })
    .then((s) => {
      if (dryRun) {
        for (const w of s.wouldAppend) console.log(`[append] ${w.dest}\n${w.line}`);
        console.log(`\nwould append ${s.appended} / scanned ${s.scanned}`);
      } else {
        console.log(`context-log-sweep: scanned=${s.scanned} appended=${s.appended} errors=${s.errors}`);
      }
      process.exit(0);
    })
    .catch((e) => { console.error('[context-log-sweep]', e && e.stack || e); process.exit(0); });
}
