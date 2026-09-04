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
// Returns [{ id, title }] (2026-09-02: was [id] -- the coordinator parent needs titles for
// its checklist). A proposal's optional `after: N` (N = index of an EARLIER sub-task, so
// the graph is a DAG by construction) becomes a real dependsOn edge -- isDependencySatisfied
// (task-sources.js) then holds that child in queue/adhoc/ until the earlier one is MERGED.
function queueSubTasks(subTasks, pipelineDir, parentTaskId) {
  const adhocDir = path.join(pipelineDir, 'queue', 'adhoc');
  fs.mkdirSync(adhocDir, { recursive: true });
  const ids = subTasks.map((sub, i) => `adhoc-${slugify(sub.title)}-${Date.now()}-${i}`);
  return subTasks.map((sub, i) => {
    const record = {
      id: ids[i],
      domain: 'adhoc',
      source: 'manual',
      title: sub.title,
      promptContext: { rawText: sub.rawText, decomposedFrom: parentTaskId },
    };
    if (Number.isInteger(sub.after) && sub.after >= 0 && sub.after < i) {
      record.dependsOn = [ids[sub.after]];
    }
    fs.writeFileSync(path.join(adhocDir, `${ids[i]}.json`), JSON.stringify(record, null, 2) + '\n');
    return { id: ids[i], title: sub.title };
  });
}

const { runAcceptanceCommand } = require('./acceptance-command-gate.js');

function applyAdhocDiff({ task, repoRoot, pipelineDir, exec }) {
  if (task && task.adhocResolution === 'decompose') {
    const subTasks = Array.isArray(task.subTaskProposals) ? task.subTaskProposals : [];
    if (!subTasks.length) {
      return { skipped: true, reason: 'RESOLUTION: decompose but no sub-task proposals survived to apply time -- nothing queued' };
    }
    const queued = queueSubTasks(subTasks, pipelineDir, task.id);
    // The parent does NOT go to done/ -- it becomes a coordinator in queue/coordinating/,
    // tracking its children on a checklist and auto-completing (coordinator-sweep.js) once
    // every child reaches done/. See recordApplyOutcome + apply-task.sh for the routing.
    return {
      coordinating: true,
      reason: `Decomposed into ${queued.length} sub-task(s), now coordinating: ${queued.map((t) => t.title).join('; ')}`,
      subTasks: queued.map((t) => ({ id: t.id, title: t.title, status: 'pending' })),
    };
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
    try {
      execFileSync('git', ['apply', '--recount', patchPath], { cwd: repoRoot, encoding: 'utf8', env: GIT_ENV, timeout: GIT_TIMEOUT_MS });
    } catch (plainApplyErr) {
      // 2026-08-24 (pipeline hardening -- caught live: a real task's diff conflicted with
      // an unrelated sibling task's own change that landed on the SAME file in between
      // this draft's worktree being cut and apply actually running -- the classic
      // "patch went stale because something else nearby changed" failure, not a
      // malformed or genuinely wrong diff). Plain `git apply` only ever does literal
      // context-line matching -- it has no way to tell "the code I'm editing is still
      // there, just a few lines further down" from "this code is genuinely gone." A
      // real three-way merge (using the base/ours/theirs blob content the diff's own
      // `index` lines already point at -- this worktree shares the repo's object
      // database, so those blobs are all reachable) resolves exactly this class of
      // conflict automatically, the same way `git apply --3way`/`git am --3way` are
      // git's own documented answer to "the plain apply failed, try harder before
      // giving up." Only attempted as a fallback, never instead of the plain apply --
      // a clean context-based apply is unambiguous and should always be preferred when
      // it works.
      try {
        execFileSync('git', ['apply', '--3way', '--recount', patchPath], { cwd: repoRoot, encoding: 'utf8', env: GIT_ENV, timeout: GIT_TIMEOUT_MS });
      } catch (threeWayErr) {
        // Unlike plain `git apply` (atomic -- either applies cleanly or leaves the
        // working tree untouched), a FAILED `--3way` attempt still writes real
        // <<<<<<< ours / ======= / >>>>>>> theirs conflict markers directly into the
        // working tree file before returning failure -- confirmed live writing this
        // fix's own test. Left alone, a genuine conflict (not just a stale-context
        // shift) would leave corrupted source sitting in the repo under an "apply
        // failed" report that reads as "nothing changed." Restore every file this
        // patch touches to its real HEAD content before rethrowing, so a failed
        // attempt -- 3-way or plain -- has the exact same "untouched" guarantee.
        for (const file of files) {
          try {
            // `HEAD --` (not bare `--`, which means "from the index") -- confirmed live
            // writing this fix: a failed --3way conflict leaves the INDEX itself marked
            // unmerged (stage U), and plain `git checkout -- <file>` refuses to touch an
            // unmerged path ("error: path is unmerged") entirely. Checking out an actual
            // commit-ish resets both the index and working tree regardless of merge state.
            execFileSync('git', ['checkout', 'HEAD', '--', file], { cwd: repoRoot, encoding: 'utf8', env: GIT_ENV, timeout: GIT_TIMEOUT_MS });
          } catch (restoreErr) {
            // Fails for a file this patch CREATES (mode:"create" has no HEAD entry to
            // restore from) -- the failed --3way attempt may have still written a stray
            // file there. Best-effort remove it rather than leave a leftover conflict-
            // marker file sitting in the repo untracked; per-file (not a blanket git
            // clean) so an unrelated pre-existing untracked file elsewhere is never
            // touched.
            try { fs.unlinkSync(path.join(repoRoot, file)); } catch (unlinkErr) {
              if (unlinkErr.code !== 'ENOENT') {
                console.warn(`[apply-adhoc-diff] failed to remove stray file after failed apply: ${file} -- ${unlinkErr.message || String(unlinkErr)}`);
              }
            }
          }
        }
        // Surface the PLAIN apply's error (what a human/redraft decision should
        // actually see), not the 3-way attempt's, since 3-way's own failure mode
        // ("Failed to merge in the changes") is less informative about the real
        // underlying conflict than the plain apply's own message.
        throw plainApplyErr;
      }
    }

    // Component 2 opt-in acceptance gate: the patch is now applied to repoRoot (which
    // apply-task.js has already branched to agent/<id>); run the task-authored command
    // against that state BEFORE apply-task.js commits. A failure throws -- same terminal
    // shape as a failed git apply, so the task goes to blocked/ with the branch left for
    // inspection. Only fires when the task supplies acceptanceCommand AND the flag is on.
    const acceptanceCommand = task && task.promptContext && task.promptContext.acceptanceCommand;
    if (process.env.AGENT_MANAGER_ADHOC_ACCEPTANCE_COMMAND === 'true'
        && typeof acceptanceCommand === 'string' && acceptanceCommand.trim()) {
      const gate = runAcceptanceCommand({ repoRoot, command: acceptanceCommand, exec });
      if (!gate.ok) {
        const detail = (gate.checks[0] && gate.checks[0].detail) || 'no output';
        throw new Error(`acceptance command failed after apply -- branch left for inspection: ${detail}`);
      }
    }

    return { files };
  } catch (e) {
    if (/^acceptance command failed/.test(e.message || '')) throw e;
    const detail = (e.stdout || e.stderr || e.message || '').toString().slice(0, 2000);
    throw new Error(`git apply failed: ${detail}`);
  } finally {
    try { fs.unlinkSync(patchPath); } catch (_) { /* best-effort cleanup */ }
  }
}

module.exports = { applyAdhocDiff, queueSubTasks };
