'use strict';

// Chat's `check_branch` tool: run one unmerged branch's covering tests in a scratch copy and say what was and was not run.
//
// Why: the chat can read a diff but cannot run a test (run_bash is mounted read-only and capped at 30 seconds), so on 2026-10-29 it recorded 14 merge verdicts
// without running any, and two were wrong. This tool is the missing capability; branch-check-runner.js does the work, branch-check-store.js remembers the
// result so a verdict recorded in a later turn can be held to it.
//
// Like record_branch_verdict it is a thin client of the dashboard's branch listing: it resolves the one listed branch (so it only ever checks a branch the
// dashboard offered, at the head the dashboard reports), runs the check, stores the result and relays it. It never merges, pushes or edits anything, and it
// resolves to { ok: true, ... } or { ok: false, error } and never throws for an expected failure.

const { fetchRows, projectMatches, httpRequest } = require('./chat-branch-verdict.js');
const { runBranchCheck } = require('./branch-check-runner.js');
const { saveBranchCheck } = require('./branch-check-store.js');

function messageFor(result, stored) {
  const sha = String(result.headSha || '').slice(0, 9);
  const tests = result.checked.filter((c) => c.kind === 'tests');
  const statics = result.checked.filter((c) => c.kind === 'static');
  const red = result.checked.filter((c) => !c.ok);
  const ran = result.checked.length
    ? `${tests.length} test run(s) and ${statics.length} static scan(s) ran on ${sha}: ${red.length ? `${red.length} red (${red.map((c) => c.what).join('; ')})` : 'all green'}`
    : `nothing ran on ${sha}`;
  const docs = result.docsOnly ? ' The branch changes only documentation.' : '';
  const gaps = result.notRun.length ? ` Not run: ${result.notRun.join('; ')}.` : '';
  const kept = stored ? '' : ' The result could not be stored, so a merge verdict will need this check run again.';
  return `${ran}.${docs}${gaps}${kept}`;
}

async function checkBranchTool({ branch, project } = {}, opts = {}) {
  if (typeof branch !== 'string' || !branch.trim()) {
    return { ok: false, error: 'check_branch requires a non-empty "branch": the full branch name from list_unverified_branches' };
  }
  const request = opts.request || httpRequest;
  const { rows, error } = await fetchRows(request);
  if (error) return { ok: false, error };

  const name = branch.trim();
  const wanted = typeof project === 'string' && project.trim() ? project.trim() : null;
  const matches = rows.filter((r) => r.branch === name && (!wanted || projectMatches(r, wanted)));
  if (!matches.length) {
    return { ok: false, error: `"${name}"${wanted ? ` in project "${wanted}"` : ''} is not a currently listed unmerged branch; call list_unverified_branches for the current ones` };
  }
  if (matches.length > 1) {
    return { ok: false, error: `"${name}" is listed in more than one project (${matches.map((r) => r.project && r.project.label).join(', ')}); pass "project"` };
  }
  const row = matches[0];
  const repoRoot = row.project && row.project.repoRoot;
  const headSha = String(row.headSha || '');
  if (!repoRoot || !headSha || !row.mainBranch) {
    return { ok: false, error: `the listing row for "${name}" has no project root, head sha or main branch, so it cannot be checked` };
  }

  let result;
  try {
    result = await (opts.runBranchCheck || runBranchCheck)({ repoRoot, branch: name, headSha, base: `origin/${row.mainBranch}` });
  } catch (e) {
    return { ok: false, error: `the check could not run: ${e && e.message ? e.message : e}` };
  }
  let stored = false;
  try { stored = (opts.saveBranchCheck || saveBranchCheck)(repoRoot, result) === true; } catch (_) { stored = false; }

  return {
    ok: true, headSha: result.headSha, harness: result.harness, docsOnly: result.docsOnly, testsRun: result.testsRun,
    checked: result.checked, notRun: result.notRun, message: messageFor(result, stored),
  };
}

module.exports = { checkBranchTool };
