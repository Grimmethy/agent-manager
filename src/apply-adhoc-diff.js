'use strict';

// Custom apply for the adhoc source (Brain Dump #67) -- registered via
// updateTaskSource('adhoc', { apply: applyAdhocDiff }) in prompts.js, the same
// per-source extension point arch_discovery/arch_import/unused_export already use (see
// apply-task.js's writeArtifact()). Unlike every other Group A/B writer, there is no
// content to WRITE here -- adhoc-agentic-draft.js already produced a real unified diff
// (task.rawDiff) by editing an isolated git worktree directly; this function's only job
// is landing that diff onto the real repoRoot apply-task.js has already fetched/reset/
// branched by the time this runs.
//
// task.rawDiff empty (adhoc-agentic-draft.js's agentic call decided nothing needed to
// change, or something went wrong upstream) -- skipped, same {skipped, reason} shape
// apply-task.js already handles for applyBrainDumpSort/applyProjectSearchFindings/etc.
// Deliberately NOT gated on task.adhocResolution's own claim -- an empty diff always
// means "nothing to apply" regardless of what the model said, and a non-empty diff
// always goes through the normal git-apply + human-gated Apply click regardless of what
// the model said. See adhoc-agentic-draft.js's own comment on this.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
const GIT_TIMEOUT_MS = 60_000;

function slugify(str) {
  return str.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '').replace(/[^a-z0-9]+/g, '-');
}

// 2026-08-24: applies a RESOLUTION: decompose draft (adhoc-agentic-draft.js) by writing
// each proposed sub-task into queue/adhoc/, the exact schema/location queue-adhoc-task.js
// already uses -- nextAdhocTask() (task-sources.js) force-overrides domain/source to
// 'adhoc'/'manual' on anything it picks up from there regardless of what the file itself
// says, so there's no need to set them here. No git branch/commit involved (same as any
// other skipped apply) -- this is pipeline bookkeeping, not a code change.
function queueSubTasks(subTasks, pipelineDir, parentTaskId) {
  const adhocDir = path.join(pipelineDir, 'queue', 'adhoc');
  fs.mkdirSync(adhocDir, { recursive: true });
  return subTasks.map((sub, i) => {
    const id = `adhoc-${slugify(sub.title)}-${Date.now()}-${i}`;
    const record = {
      id,
      domain: 'adhoc',
      source: 'manual',
      title: sub.title,
      promptContext: { rawText: sub.rawText, decomposedFrom: parentTaskId },
    };
    fs.writeFileSync(path.join(adhocDir, `${id}.json`), JSON.stringify(record, null, 2) + '\n');
    return id;
  });
}

function applyAdhocDiff({ task, repoRoot, pipelineDir }) {
  if (task && task.adhocResolution === 'decompose') {
    const subTasks = Array.isArray(task.subTaskProposals) ? task.subTaskProposals : [];
    if (!subTasks.length) {
      return { skipped: true, reason: 'RESOLUTION: decompose but no sub-task proposals survived to apply time -- nothing queued' };
    }
    const ids = queueSubTasks(subTasks, pipelineDir, task.id);
    return { skipped: true, reason: `Decomposed into ${ids.length} sub-task(s), queued to queue/adhoc/: ${subTasks.map((t) => t.title).join('; ')}` };
  }

  const rawDiff = (task && task.rawDiff) || '';
  if (!rawDiff.trim()) {
    const reason = task && task.adhocResolution === 'no-changes-needed'
      ? `no code change needed: ${(task.implementResponse || '').slice(0, 300)}`
      : 'adhoc agentic draft produced no diff';
    return { skipped: true, reason };
  }

  const patchPath = path.join(os.tmpdir(), `adhoc-apply-${task.id}-${process.pid}.patch`);
  fs.writeFileSync(patchPath, rawDiff.endsWith('\n') ? rawDiff : `${rawDiff}\n`);
  try {
    // --numstat lists touched files without needing the patch already applied -- run
    // first so a malformed patch fails via the SAME `git apply` error path either way
    // (numstat also validates the patch parses, though not that it applies cleanly).
    // --recount here too (see the real `git apply` call below for why) -- confirmed live
    // 2026-08-18: this call has no --recount of its own, so a hunk with a wrong stated
    // line-count rejected THIS call as "corrupt patch" before ever reaching the real
    // apply below, even after --recount was added there alone.
    const numstat = execFileSync('git', ['apply', '--numstat', '--recount', patchPath], {
      cwd: repoRoot, encoding: 'utf8', env: GIT_ENV, timeout: GIT_TIMEOUT_MS,
    });
    const files = numstat.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => line.split('\t').pop());
    if (files.length === 0) {
      throw new Error('git apply --numstat reported no files touched by this diff');
    }

    // --recount: confirmed live 2026-08-18 -- a real, otherwise-valid diff from
    // adhoc-agentic-draft.js's agentic capture (`git diff` against an isolated worktree)
    // failed here with "corrupt patch at line 68" on a plain `git apply`, while `git apply
    // --check --recount` against the identical bytes succeeded cleanly. The hunk header's
    // stated line counts didn't match the actual hunk body -- recount ignores the stated
    // counts and recalculates them from the body instead, which is exactly the tolerance
    // needed for a diff captured this way (not hand-written, so a header/body mismatch is
    // a capture-format quirk, not a sign of real corruption -- --numstat above already
    // proved the patch parses and lists real files before this point).
    execFileSync('git', ['apply', '--recount', patchPath], { cwd: repoRoot, encoding: 'utf8', env: GIT_ENV, timeout: GIT_TIMEOUT_MS });

    return { files };
  } catch (e) {
    const detail = (e.stdout || e.stderr || e.message || '').toString().slice(0, 2000);
    throw new Error(`git apply failed: ${detail}`);
  } finally {
    try { fs.unlinkSync(patchPath); } catch (_) { /* best-effort cleanup */ }
  }
}

module.exports = { applyAdhocDiff, queueSubTasks };
