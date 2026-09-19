'use strict';

// The pipeline owns git; a task's draft never does. A drafting sandbox mounts the shared git dir
// READ-ONLY (only the per-worktree gitdir is writable), so a draft cannot create a commit, move a
// ref, merge, or push -- and it must not try: after a draft passes review the harness itself commits
// the change, pushes an unmerged agent/<task> branch, and a human merges it. Everything below exists
// because that contract was violated three ways in one PF-Client-Portal incident (2026-09-19):
//   1. a plan ended with "commit with a message like ..." and "merge to master";
//   2. the implement pass ran `git add`, hit "Read-only file system", and blocked as an infra error;
//   3. Chat, told to hand git actions to the pipeline, queued a premium-priority "commit it and merge
//      to master" task that no sandbox can ever perform, which then held a GPU lane through restarts.

// Prompt text, appended to plan and implement prompts.
const GIT_OWNERSHIP_RULE = [
  'GIT IS NOT YOUR JOB. Do not plan, run, or claim git steps that write history: no commit, merge, push,',
  'pull, rebase, tag, cherry-pick, branch create/delete/checkout, and no "open a PR". The pipeline commits',
  'your change and lands an unmerged branch for a human by itself once your edits pass review, so your',
  'deliverable ends at the edited files. Read-only git (status, diff, log, show, blame) is fine.',
  'If a git write command fails with "Read-only file system", that is the sandbox working as designed:',
  'ignore it and do NOT report it as a blocker. Acceptance criteria must be about the FILES (content, a',
  'command over the working tree) -- never about a commit, a branch, a merge, or repository history.',
].join(' ');

// A CRITERIA bullet whose pass/fail depends on repository history written by a commit/merge/branch --
// unsatisfiable inside the sandbox, and it made otherwise-correct drafts fail acceptance.
const GIT_WRITE_CRITERION_RE = new RegExp([
  String.raw`\bgit\s+(?:log|show|branch|status|rev-parse|merge-base)\b[^.\n]*\b(?:commit|master|main|merged?|throwaway|branch)\b`,
  String.raw`\b(?:commit|branch|merge|tag)\b[^.\n]*\b(?:is|was|has been|exists?|contains?)\b[^.\n]*\b(?:master|main|history|committed|merged|deleted|listed)\b`,
  String.raw`\b(?:merged?|committed|pushed)\s+(?:to|into|on)\s+(?:master|main|origin)\b`,
  String.raw`\bcommit\s+(?:whose|with)\s+(?:subject|message)\b`,
  String.raw`\b(?:working tree|git status)\b[^.\n]*\bclean\b[^.\n]*\b(?:after|on)\s+(?:the\s+)?(?:merge|commit)\b`,
].join('|'), 'i');

function dropGitWriteCriteria(criteria) {
  return (criteria || []).filter((c) => !GIT_WRITE_CRITERION_RE.test(String(c)));
}

// A human/Chat request whose DELIVERABLE is a git operation ("Commit X and merge to master"). The
// pipeline cannot perform these -- it produces a diff, not a commit -- so it must never be queued as
// a task. Narrow on purpose: an imperative git-write title, or an explicit "commit it / merge to
// master/main / push to origin" instruction in the description. A task that merely MENTIONS git
// (fix the git-runner, add a merge-driver) is unaffected.
const GIT_WRITE_TITLE_RE = /^\s*(?:commit|merge|push|cherry-?pick|rebase|tag|land|open (?:a )?(?:pr|pull request)|create (?:a )?(?:pr|pull request|branch))\b/i;
const GIT_WRITE_INSTRUCTION_RE = new RegExp([
  String.raw`\bcommit\s+(?:it|this|that|the\s+(?:change|fix|edit|file|diff))\b`,
  String.raw`\bmerge\s+(?:it|this|that|the\s+(?:branch|change|fix))?\s*(?:to|into)\s+(?:master|main)\b`,
  String.raw`\bpush\s+(?:it|this|that|the\s+(?:branch|change|fix))?\s*(?:to|upstream)\b`,
  String.raw`\bfast-forward\s+(?:master|main)\b`,
].join('|'), 'i');

function isGitWriteRequest({ title, description } = {}) {
  return GIT_WRITE_TITLE_RE.test(String(title || '')) || GIT_WRITE_INSTRUCTION_RE.test(String(description || ''));
}

const GIT_WRITE_REQUEST_REFUSAL = 'queue_reviewed_task cannot queue a git operation (commit, merge, push, branch, PR): '
  + 'the pipeline produces a code CHANGE, not a commit -- after a draft passes review it commits and pushes an '
  + 'unmerged branch itself, and a human merges it from the dashboard\'s Unmerged Branches tab. If a change is '
  + 'still needed, file a task that describes the CHANGE (which files, what behavior); if something only needs '
  + 'landing, tell the user to merge the branch from the Unmerged Branches tab.';

module.exports = {
  GIT_OWNERSHIP_RULE,
  GIT_WRITE_CRITERION_RE,
  dropGitWriteCriteria,
  isGitWriteRequest,
  GIT_WRITE_REQUEST_REFUSAL,
};
