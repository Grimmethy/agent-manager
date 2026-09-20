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
const { allocateHubSerial, formatHubLabel, memberId, memberTitle } = require('./hub-serial.js');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
const GIT_TIMEOUT_MS = 60_000;

function slugify(str) {
  return str.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '').replace(/[^a-z0-9]+/g, '-');
}

// 2026-09-11 (brain-dump #886): a deterministic backstop for a missed `after` link. The
// decompose prompt already tells the model to set "after": N "when the piece genuinely
// cannot start until that earlier one is merged -- e.g. it edits a file the earlier one
// creates" (local-agentic-write-draft.js) -- but two real incidents (draft-file-guard,
// apply-outcome-classifiers) show the model skipping it even when a LATER proposal's own
// rawText literally `require()`s the exact file path an EARLIER proposal's own title/
// rawText says it creates. Each sub-task then drafted independently against its own
// guess of the other's shape, producing two incompatible siblings -- caught only by luck,
// via a `git cherry-pick` add/add conflict during manual landing.
//
// Narrow and conservative on purpose: only fires on an earlier proposal matching
// "create/add/write/scaffold ... <path>.<ext>" (a real created-file claim, not a passing
// mention), and only links when a LATER proposal's rawText contains that exact path
// substring -- the same "it edits a file the earlier one creates" case the prompt already
// names, just enforced mechanically when the model forgets it. Never overrides an
// `after` the model DID set.
const CREATED_FILE_RE = /\b(?:create|add|write|scaffold)\b(?:[^.\n]{0,60}?)\b([\w./-]+\.(?:js|ts|py|ps1|sh))\b/i;

function inferMissingAfterLinks(subTasks) {
  // Keyed on the file's BASENAME, not its full path -- a wiring sub-task typically
  // `require()`s/`import`s the module by a relative path ("./draft-file-guard.js"), while
  // the creating sub-task names it repo-rooted ("src/draft-file-guard.js"); matching on
  // the shared basename catches both real incidents without needing exact path agreement.
  const createdBy = new Map(); // basename -> earliest sub-task index that creates it
  subTasks.forEach((sub, i) => {
    const m = CREATED_FILE_RE.exec(`${sub.title || ''} ${sub.rawText || ''}`);
    if (!m) return;
    const basename = m[1].split('/').pop();
    if (!createdBy.has(basename)) createdBy.set(basename, i);
  });
  return subTasks.map((sub, i) => {
    if (Number.isInteger(sub.after)) return sub; // the model already made this call -- leave it
    for (const [basename, j] of createdBy) {
      if (j < i && typeof sub.rawText === 'string' && sub.rawText.includes(basename)) {
        return { ...sub, after: j };
      }
    }
    return sub;
  });
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
// premiumPriority propagation (2026-09-07, Grimmethy: "This decompose should be the
// absolute highest priority job and we need a way to make sure it stays that way until
// completion" -- confirmed live: the real task this was built for hit exactly this gap.
// Its own decompose split produced 2 fresh child tasks with no premiumPriority at all,
// silently dropping back to ordinary priority the moment the parent (which no longer
// gets claimed itself -- it becomes a coordinator hub) stopped being the thing actually
// doing the work. Required a manual re-stamp on both children to keep the original
// intent. A parent that was flagged premium clearly wants ITS descendants prioritized
// too -- decomposition is supposed to be transparent to that intent, not reset it.
// 2026-09-12 (screaminggoatclubmt, real live incident: a 2-piece decompose split "add a
// comment" and "run the test suite to confirm it" into TWO separate sub-tasks -- the
// second had no code delta of its own to offer any diff-producing tier, ever, and got
// auto-linked via inferMissingAfterLinks to a dependsOn edge on the first that it didn't
// actually need (a comment cannot change whether a pre-existing test suite passes),
// producing a task that could structurally never complete and a dependency that could
// deadlock an unsupervised run -- see softDependsOn's own header for that half of the
// incident). Root cause: the decompose prompt only has vocabulary for code-change-shaped
// pieces ("touch ONE file"), nothing for "this piece is a verification checkpoint on a
// sibling's change, not new work of its own" -- so the model, following the ORIGINAL
// brain-dump's own "should confirm" phrasing, made that checkpoint its own task instead
// of folding it into the code-change piece's acceptance criteria.
//
// Deliberately conservative (high precision over high recall, same discipline
// CREATED_FILE_RE above already uses): only classifies a proposal as verification-only
// when its TITLE's leading verb is confirm/verify/check/etc. AND the title contains NO
// code-change verb anywhere -- "Add verification comment to X" still correctly reads as
// a real code-change task (leading verb "Add") even though the word "verification"
// appears in it; only "Run X to confirm" / "Verify Y" / "Check Z" survive both filters.
// Checked against the TITLE only, not the full rawText, since rawText commonly mentions
// a code-change verb in passing ("...so a follow-up pass can fix the guard") without
// this piece itself doing that work -- the title is the short, deliberately-imperative
// summary the decompose prompt already asks for, a far more reliable intent signal.
// "gate"/"guard" deliberately excluded: both are extremely common NOUNS in this
// codebase's own vocabulary ("the guard", "the gate") -- caught live via
// "Confirm the guard rejects a duplicate event" and "Verify the gate rejects a bad
// input", two real verification-only titles this word-boundary match cannot tell apart
// from an actual "Gate the review on X" code-change title (which doesn't start with a
// verification lead verb anyway, so losing this one word costs no real precision on the
// other side).
const CODE_CHANGE_VERB_RE = /\b(add|modify|change|fix|implement|create|write|remove|refactor|update|replace|wire|extract|rename|delete|insert|adjust|tighten|expand|introduce|migrate|split|merge|patch|restructure|drop|disable|enable)\b/i;
const VERIFICATION_LEAD_RE = /^(run|confirm|verify|check|validate|ensure|audit|test)\b/i;

function isVerificationOnlySubTask(sub) {
  const title = String((sub && sub.title) || '').trim();
  if (!title) return false;
  return VERIFICATION_LEAD_RE.test(title) && !CODE_CHANGE_VERB_RE.test(title);
}

function queueSubTasks(rawSubTasks, pipelineDir, parentTaskId, parentTask) {
  const subTasks = inferMissingAfterLinks(rawSubTasks);
  const adhocDir = path.join(pipelineDir, 'queue', 'adhoc');
  fs.mkdirSync(adhocDir, { recursive: true });
  // HUB#### serial (hub-serial.js): every member's id and title carries its hub's label so a member is recognisable as part of a hub.
  const hubSerial = allocateHubSerial(pipelineDir);
  const hubLabel = formatHubLabel(hubSerial);
  const ids = subTasks.map((sub, i) => memberId(hubLabel, i + 1, slugify(sub.title)));

  // Fold targets computed BEFORE any file is written, so a surviving sub-task's own
  // record already carries every criterion folded into it. A verification-only proposal
  // folds onto its declared `after` target when it has one, else the immediately
  // preceding proposal (both always point to an earlier, already-resolved index, so a
  // single forward pass is enough -- no fold ever needs to look ahead). Walks through an
  // already-folded target to the nearest SURVIVING one, so a chain of verification-only
  // proposals in a row still lands on one real task rather than being silently dropped.
  const foldTargets = new Map(); // sub-task index -> surviving target index it folds into
  subTasks.forEach((sub, i) => {
    if (!isVerificationOnlySubTask(sub)) return;
    let targetIndex = Number.isInteger(sub.after) && sub.after >= 0 && sub.after < i ? sub.after : (i > 0 ? i - 1 : null);
    while (targetIndex !== null && foldTargets.has(targetIndex)) targetIndex = foldTargets.get(targetIndex);
    if (targetIndex !== null && targetIndex !== i) foldTargets.set(i, targetIndex);
    // targetIndex === null (a verification-only proposal with nothing earlier to fold
    // onto, e.g. it's sub-task 0) is left un-folded on purpose -- it becomes its own
    // task same as before this fix, the one case this mechanism cannot improve on.
  });

  const extraCriteria = new Map(); // surviving index -> string[] folded in from siblings
  foldTargets.forEach((targetIndex, i) => {
    const list = extraCriteria.get(targetIndex) || [];
    list.push(subTasks[i].rawText);
    extraCriteria.set(targetIndex, list);
  });

  // ONE HUB = ONE STACKED BRANCH (2026-09-20; earlier: 2026-09-13, screaminggoatclubmt: "build the hubs so they add to the worktree of the
  // previously completed hub member"). A hard dependsOn edge only clears once the predecessor is actually MERGED to main, and nothing
  // merges a plain hub sub-task's branch on its own -- so every hub used to freeze at "step 1 of N" until a human merged a half-built
  // branch. The 2026-09-13 fix stacked pieces that had an `after` link on one shared branch (the mechanism file-decompose-to-hub.js
  // uses): step N's draft and review read the branch tip that already carries step N-1, and isDependencySatisfied() treats a stacked
  // predecessor's `done` as satisfied, no merge required.
  //
  // That only covered pieces the MODEL linked. PF function-length-fix-ac-2's nested hub (create tileGrid.ts / create usePropertyLocation.ts /
  // wire both): the wiring piece said "after piece 0" and never named piece 1, so piece 1 was an independent, UNSTACKED piece -- held by
  // hubHasUnmergedEarlierSibling behind piece 0's unmerged branch (a human merge), and the wiring piece would have drafted on a branch
  // lacking piece 1's file. The hub could not finish without an interruption.
  //
  // So every surviving piece of a hub (two or more) joins ONE chain, in proposal order, each depending on the one before: nothing ever
  // waits on a merge, the whole hub lands as ONE branch for ONE final merge, and merging that branch early is still safe -- a piece
  // that finds its branch already merged (and deleted) simply starts a fresh branch off main, which already carries the earlier pieces.
  // Trade: pieces run one at a time. They already did in practice (the sibling check held them), and an ordered chain is what makes
  // "ready to merge" mean the whole thing.
  //
  // A NESTED hub (the parent is itself a stacked piece that decomposed) continues its parent's branch instead of starting a second one,
  // taking the parent's slot in the sequence, so the ancestor hub still ends as one branch.
  const survivingIndices = subTasks.map((_, i) => i).filter((i) => !foldTargets.has(i));
  const chained = survivingIndices.length >= 2;
  const nested = parentTask && parentTask.stacked && parentTask.stacked.branch ? parentTask.stacked : null;
  const chainBranch = nested ? nested.branch : `agent/decompose-${slugify(parentTaskId)}`;
  const firstSeq = nested ? (Number(nested.seq) || 1) : 1;
  const chainTotal = (nested ? (Number(nested.total) || firstSeq) - 1 : 0) + survivingIndices.length;
  const seqOf = new Map();
  const prevOf = new Map();
  survivingIndices.forEach((i, k) => {
    seqOf.set(i, firstSeq + k);
    if (k > 0) prevOf.set(i, survivingIndices[k - 1]);
  });

  const carriedDiff = parentTask && typeof parentTask.carriedPartialDiff === 'string' && parentTask.carriedPartialDiff.trim() ? parentTask.carriedPartialDiff : null;
  const queued = [];
  subTasks.forEach((sub, i) => {
    if (foldTargets.has(i)) return; // folded into a sibling's acceptanceCriteria instead of becoming its own no-diff-possible task
    const record = {
      id: ids[i],
      domain: 'adhoc',
      source: 'manual',
      title: memberTitle(hubLabel, survivingIndices.indexOf(i) + 1, survivingIndices.length, sub.title),
      promptContext: { rawText: sub.rawText, decomposedFrom: parentTaskId },
    };
    if (chained) {
      record.stacked = { branch: chainBranch, seq: seqOf.get(i), total: chainTotal };
      if (prevOf.has(i)) record.dependsOn = [ids[prevOf.get(i)]];
    }
    // Work an earlier pass of the parent already landed (agentic-draft-common.js carriedPartialDiff): the pieces describe what REMAINS on top
    // of it, so the FIRST piece's worktree starts from it (applied as uncommitted changes) and every later piece stacks on the result.
    if (carriedDiff && i === survivingIndices[0]) {
      record.priorPartialDiff = carriedDiff;
      record.promptContext.rawText = `PRIOR WORK ALREADY APPLIED: an earlier pass of the parent task made some of this change. Those edits are applied to your worktree as uncommitted changes -- run git diff to see them, and do NOT redo them. Your job is the part below, on top of them.\n\n${sub.rawText}`;
    }
    const extra = extraCriteria.get(i);
    if (extra && extra.length) record.acceptanceCriteria = extra;
    if (parentTask && parentTask.premiumPriority) record.premiumPriority = true;
    fs.writeFileSync(path.join(adhocDir, `${ids[i]}.json`), JSON.stringify(record, null, 2) + '\n');
    queued.push({ id: ids[i], title: record.title });
  });
  queued.hubSerial = hubSerial;
  queued.hubLabel = hubLabel;
  return queued;
}

// A candidate-fulfillment task (function_length_fix, pipeline_forensics_fix, ...) whose implement pass judged the fix too big for one
// pass proposes `{"mode":"split"}` sub-candidates. The candidate-doc split (applyCandidateSplit) only files MORE candidates, and is
// disabled for sources whose candidates are already decompositions (noCandidateSplit) or already one level deep (Split-Depth >= 1):
// those used to BLOCK "for a human to narrow the fix" (PropertyForager function-length-fix-ac-2, arch-review-ac-6). Adhoc tasks that
// are too big already have a full system for this -- sub-tasks with ordering, a coordinator hub with a checklist, stacked branches --
// so a hub-routed split (task.candidateSplitRoute === 'hub') is converted into exactly that.
//
// Every piece is chained after the previous one: a candidate names ONE function/file, so its pieces edit the same code, and pieces
// running in parallel on separate branches would conflict at merge. The chain (queueSubTasks' `after` -> dependsOn + one shared
// stacked branch) serialises them onto a single branch. Each child is an ordinary adhoc task carrying `decomposedFrom`, which the
// draft passes read as "a confirmed-atomic leaf -- do not split again".
function candidateSplitToSubTasks(task) {
  const proposals = Array.isArray(task.candidateSplitProposals) ? task.candidateSplitProposals : [];
  const pc = task.promptContext || {};
  const total = proposals.length;
  const parentLabel = [pc.candidateId, pc.title || task.title].filter(Boolean).join(' -- ');
  return proposals.map((c, i) => {
    const others = proposals.filter((_, j) => j !== i).map((o) => o.title).filter(Boolean);
    const rawText = [
      `Part ${i + 1} of ${total} of a fix that was too large for one pass${parentLabel ? `: ${parentLabel}` : ''}.`,
      c.files ? `Files: ${c.files}` : null,
      '',
      `THIS PART: ${c.title}`,
      '',
      `Problem: ${c.problem}`,
      '',
      `Solution: ${c.solution}`,
      c.benefits ? `\nBenefits: ${c.benefits}` : null,
      '',
      `Scope: implement ONLY this part. Do not do the other part${others.length === 1 ? '' : 's'} (${others.join('; ')}) -- ${others.length === 1 ? 'it is a separate task' : 'they are separate tasks'}${i > 0 ? ', and the earlier part(s) are already in the code you are editing' : ''}. Leave everything else unchanged.`,
    ].filter((l) => l !== null).join('\n');
    const sub = { title: c.title, rawText };
    if (i > 0) sub.after = i - 1;
    return sub;
  });
}

function applyCandidateSplitAsHub(task, pipelineDir) {
  const subTasks = candidateSplitToSubTasks(task);
  if (subTasks.length < 2) {
    throw new Error(`task ${task.id}: a hub-routed candidate split needs at least 2 sub-candidates (got ${subTasks.length})`);
  }
  const queued = queueSubTasks(subTasks, pipelineDir, task.id, task);
  return {
    coordinating: true,
    reason: `Candidate too large for one pass -- decomposed into ${queued.length} chained sub-task(s), now coordinating: ${queued.map((t) => t.title).join('; ')}`,
    subTasks: queued.map((t) => ({ id: t.id, title: t.title, status: 'pending' })),
    hubSerial: queued.hubSerial,
    hubLabel: queued.hubLabel,
  };
}

const { runAcceptanceCommand } = require('./acceptance-command-gate.js');

function applyAdhocDiff({ task, repoRoot, pipelineDir, exec }) {
  if (task && task.adhocResolution === 'decompose') {
    const subTasks = Array.isArray(task.subTaskProposals) ? task.subTaskProposals : [];
    if (!subTasks.length) {
      return { skipped: true, reason: 'RESOLUTION: decompose but no sub-task proposals survived to apply time -- nothing queued' };
    }
    const queued = queueSubTasks(subTasks, pipelineDir, task.id, task);
    // The diff now lives on the first piece; the hub record must not keep a second, large copy.
    if (task.carriedPartialDiff) { task.carriedPartialDiffChars = task.carriedPartialDiff.length; delete task.carriedPartialDiff; }
    // The parent does NOT go to done/ -- it becomes a coordinator in queue/coordinating/,
    // tracking its children on a checklist and auto-completing (coordinator-sweep.js) once
    // every child reaches done/. See recordApplyOutcome + apply-task.sh for the routing.
    return {
      coordinating: true,
      reason: `Decomposed into ${queued.length} sub-task(s), now coordinating: ${queued.map((t) => t.title).join('; ')}`,
      subTasks: queued.map((t) => ({ id: t.id, title: t.title, status: 'pending' })),
      hubSerial: queued.hubSerial,
      hubLabel: queued.hubLabel,
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

module.exports = { applyAdhocDiff, queueSubTasks, inferMissingAfterLinks, isVerificationOnlySubTask, candidateSplitToSubTasks, applyCandidateSplitAsHub };
