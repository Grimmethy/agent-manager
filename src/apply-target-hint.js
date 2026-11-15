'use strict';

// apply-target-hint.js -- when an adhoc diff cannot be applied because it was written for ANOTHER registered project, say which one and what to do.
//
// Why (2026-09-29, then re-checked 2026-10-30): a manual/adhoc task whose real diff edits files of a plugin repo failed at apply with a bare
// "git apply failed: error: content-pipeline/prompts.js: No such file or directory", because the record sat in agent-manager's own queue and apply
// used agent-manager's apply clone. The pipeline already applies plugin work correctly when the approved record sits in THAT project's own queue
// (scripts/apply-loop.sh runs each pool project's pass, and a premium pass for any registered project, with that project's own REPO_ROOT and no
// AGENT_MANAGER_APPLY_REPO_ROOT; see docs/agents/apply-routing.md). So the missing piece is only a clear message, not a router.
//
// Pure helpers plus a registry read; nothing here changes what gets applied. applyAdhocDiff calls targetHintForFailure() ONLY after git apply has failed.

const fs = require('fs');
const path = require('path');
const { listProjects } = require('./chat-projects.js');

// Existing-file paths a unified diff touches (a NEW file cannot tell us which repo it belongs to, so `new file mode` entries are left out).
function existingPathsInDiff(rawDiff) {
  const paths = [];
  const blocks = String(rawDiff || '').split(/^diff --git /m).slice(1);
  for (const block of blocks) {
    const head = block.split('\n', 6).join('\n');
    if (/^new file mode/m.test(head)) continue;
    const m = /^a\/(.+?) b\/(.+?)$/m.exec(block.split('\n', 1)[0]);
    if (m) paths.push(m[1]);
  }
  return [...new Set(paths)];
}

// The single other registered project whose repo holds every existing file the diff edits, or null. This repo must hold none of them.
function otherProjectForDiff(rawDiff, repoRoot, { registryPath } = {}) {
  const files = existingPathsInDiff(rawDiff);
  if (files.length === 0) return null;
  if (files.some((f) => fs.existsSync(path.join(repoRoot, f)))) return null;
  // This repo holds none of the files (checked above), so it cannot be among the owners.
  const owners = listProjects({ registryPath, activeRepoRoot: repoRoot })
    .filter((p) => files.every((f) => fs.existsSync(path.join(p.repoRoot, f))));
  return owners.length === 1 ? owners[0] : null;
}

// A one-sentence addition for the apply error, or '' when no single other project fits.
function targetHintForFailure(rawDiff, repoRoot, opts) {
  let project = null;
  try { project = otherProjectForDiff(rawDiff, repoRoot, opts); } catch { /* a hint must never hide the real error */ }
  if (!project) return '';
  return `HINT: this diff edits files that exist in project "${project.label}" (${project.repoRoot}) and not in this repo; the approved record belongs in that project's own queue: ${path.join(project.pipelineDir, 'queue', 'approved')}/`;
}

module.exports = { existingPathsInDiff, otherProjectForDiff, targetHintForFailure };
