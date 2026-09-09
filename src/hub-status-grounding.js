'use strict';

// Hub status grounding (2026-09-09) -- root-caused live: file-decompose-hub-autodecomp-
// adhoc-add-job-stage-groups-table-and-render-colla's wiring child concluded 2 of its 4
// target files "do not exist anywhere in this checkout" and punted to a human, when all 4
// already existed on its own shared stacked branch. The immediate cause (its worktree was
// built from origin/<mainBranch>, not the stacked branch) is fixed elsewhere this session
// (stacked-grounding.js's resolveGroundingRef, now wired into every real drafting path).
// This closes the deeper, structural gap Grimmethy named: "We have communication issues
// inside the hubs themselves... I'm inclined to say increase hub communication" -- a
// stacked child was handed a bare, asserted claim ("every move step has committed...")
// plus its own possibly-misconfigured tool exploration, with NOTHING in between to
// cross-check one against the other.
//
// Two signals, neither trustworthy alone, combined here:
//   1. The hub's own tracked subTasks[].status -- real communication, but confirmed
//      unreliable on its own: task 02 in the real incident showed "status": "merged"
//      while having produced a verified ZERO-diff no-op (the file was never created).
//   2. A fresh, git-verified existence check against the REAL stacked branch tip, run
//      every time this grounding is built (never a stale snapshot) -- also imperfect on
//      its own, since the candidate path is parsed from the hub's own title text, which
//      in the same real incident recorded the WRONG path for one sibling
//      (".../templates/static/js/core-ui.js" vs. where the file actually landed,
//      ".../static/js/core-ui.js").
// Combining them and telling the model explicitly which one to trust on disagreement is
// the actual fix: a plain assertion becomes a fresh, authoritative check the model is
// told to prefer over its own contradicted exploration.

const fs = require('fs');
const path = require('path');
const { resolveGroundingRef, readFileAtRef } = require('./stacked-grounding.js');

const SIBLING_FILE_RE = /→\s*(\S+)$/;

function repoRootOrNull(opts) {
  if (opts && opts.repoRoot) return opts.repoRoot;
  try {
    return require('./config.js').getConfig().repoRoot || null;
  } catch {
    return null;
  }
}

function pipelineDirOrNull(opts) {
  if (opts && opts.pipelineDir) return opts.pipelineDir;
  try {
    return require('./config.js').getConfig().pipelineDir || null;
  } catch {
    return null;
  }
}

// task, { pipelineDir?, repoRoot? } -> grounding text | null. null whenever this task
// isn't a decomposed hub child, its hub can't be read, or the hub has no siblings to
// report -- every ordinary (non-decomposed) task is completely unaffected.
function buildHubStatusGrounding(task, opts = {}) {
  const hubId = task && task.promptContext && task.promptContext.decomposedFrom;
  if (!hubId) return null;
  const pipelineDir = pipelineDirOrNull(opts);
  if (!pipelineDir) return null;

  let hub;
  try {
    hub = JSON.parse(fs.readFileSync(path.join(pipelineDir, 'queue', 'coordinating', `${hubId}.json`), 'utf8'));
  } catch (e) {
    return null; // hub gone/archived/unreadable -- nothing to report, not an error
  }
  if (!Array.isArray(hub.subTasks) || hub.subTasks.length === 0) return null;

  const repoRoot = repoRootOrNull(opts);
  const groundingRef = repoRoot ? resolveGroundingRef(task, repoRoot) : null;

  const lines = [
    'HUB STATUS -- this task is one piece of a larger coordinated decomposition. Below is '
      + "the coordinator hub's own tracked status for every sibling piece, PLUS a fresh, "
      + 'independent check of whether each one\'s target file genuinely exists on the real '
      + 'shared branch right now (checked at the moment this prompt was built, not a stale '
      + 'snapshot):',
  ];
  for (const st of hub.subTasks) {
    if (!st || st.id === task.id) continue;
    const match = SIBLING_FILE_RE.exec(st.title || '');
    let verified = 'not checked (could not parse a target file from this sibling\'s title)';
    if (match && groundingRef) {
      const filePath = match[1];
      const content = readFileAtRef(repoRoot, groundingRef, filePath);
      verified = content !== null ? `CONFIRMED exists at ${filePath}` : `NOT FOUND at ${filePath}`;
    } else if (match && !groundingRef) {
      verified = 'not checked (this task is not resolvable to a real stacked branch)';
    }
    lines.push(`- ${st.title || st.id} [hub status: ${st.status || 'unknown'}] -- VERIFIED ON DISK: ${verified}`);
  }
  lines.push(
    'If your own tool exploration (read_file/list_directory/grep_codebase) contradicts a '
      + 'VERIFIED line above, TRUST THE VERIFIED LINE -- it just ran a real check against '
      + 'the actual branch this task is working from. Your own worktree may be pointed at '
      + 'the wrong branch or a stale checkout; do not conclude a sibling\'s work is missing '
      + 'on the strength of your own exploration alone when a VERIFIED line says otherwise.',
  );
  return lines.join('\n');
}

module.exports = { buildHubStatusGrounding };
