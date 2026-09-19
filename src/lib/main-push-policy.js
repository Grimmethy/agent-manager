'use strict';

// One policy for "may the pipeline put anything on the remote's main branch by itself?".
//
// 2026-09-19, Grimmethy: "Nothing should ever go to github main like that without a gate
// step." An arch_discovery candidate-doc append (a reviewed-by-3-LLM-votes doc) had been
// committed and pushed straight to origin/main of a repo, unattended, ~30s after approval.
// The only sanctioned way onto main is now a HUMAN merge (the dashboard's merge button, or a
// PR): the pipeline pushes BRANCHES only.
//
//  - directToMain sources (candidate docs, *_review triage) no longer commit to main; they
//    append onto ONE rolling branch (TRIAGE_BRANCH) that a human merges. One shared branch,
//    not one per task, because every task appends to the same Docs/*_CANDIDATES.md and
//    independent branches would conflict at the end of that file.
//  - the coordinator no longer auto-merges "verified mechanical moves" into main.
//  - resetToMain never fast-forwards origin/main to a local-ahead main (it rescues those
//    commits to a branch instead); pushMain refuses outright.
//
// Opt-out (restores the old ungated behavior everywhere): AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH=true.
const TRIAGE_BRANCH = 'agent/triage-queue';

function ungatedMainPushAllowed() {
  return process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH === 'true';
}

module.exports = { TRIAGE_BRANCH, ungatedMainPushAllowed };
