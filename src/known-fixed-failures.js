'use strict';

// known-fixed-failures.js -- failure classes whose FIX HAS LANDED in this codebase, so a task parked because of one can be requeued.
//
// Why (2026-09-20, PF function-length-fix-ac-3): the task exhausted its retries on failures we then fixed (#394 wrong-block false
// positive, #396 curly-quote find mismatch + a revision that replaced the draft with commentary). It sat in needs-clarification for ~40
// minutes with a GPU idle, because "blocked-drain requeues on a fix signature" only knows the signatures pipeline_self_audit /
// pipeline_forensics_fix derive when THEY apply a fix -- a fix merged by hand had no way to say "tasks stuck on this can go again".
// Ship an entry here in the same PR as the fix; fix-signature-sweep.js drains the matching stuck tasks once, when the code carrying the
// entry first runs.
//
// An entry: { id, fixedIn, description, dirs, applies(task) }
//   id       stable key (recorded on a requeued task so it is never requeued for the same fix twice)
//   applies  a PRECISE test that this task's failure is the class the fix addresses -- text of the recorded failure, plus any structural
//            precondition (e.g. the target file really contains the typographic characters). Over-matching costs a wasted draft, and the
//            once-per-fix guard bounds it to one; under-matching just leaves the old "wait for a human".

const TYPOGRAPHIC_RE = /[‘’“”–— ]/;

// Everything the pipeline recorded about WHY this task is stuck.
function failureText(task) {
  const parts = [task && task.blockedReason];
  if (task && Array.isArray(task.priorRejectionFeedback)) parts.push(...task.priorRejectionFeedback);
  if (task && task.needsClarification) parts.push(task.needsClarification.openQuestions, task.needsClarification.reason);
  return parts.filter((p) => typeof p === 'string').join('\n');
}

function anyFetchedFileMatches(task, re) {
  const files = task && task.promptContext && Array.isArray(task.promptContext.fetchedFiles) ? task.promptContext.fetchedFiles : [];
  return files.some((f) => f && typeof f.content === 'string' && re.test(f.content));
}

// Would the CURRENT grounding fetch anchor every declared (non-context) file of this task strongly? Recomputed from the live files with the same windowing the draft
// uses (refreshCandidateFetchedFiles re-windows on every attempt, so a requeue picks the result up). Fail-closed: any error or unreadable file is "no".
function groundingNowReliable(task) {
  const pc = task && task.promptContext;
  const bad = pc && Array.isArray(pc.fetchedFiles) ? pc.fetchedFiles.filter((f) => f && !f.context && f.anchorConfidence === 'none' && f.path) : [];
  if (!bad.length) return false;
  try {
    const path = require('path');
    const fs = require('fs');
    const root = path.resolve(require('./config.js').getConfig().repoRoot);
    const { windowFetchedFileContent } = require('./sdk/candidate-fulfillment.js');
    return bad.every((f) => {
      const full = path.resolve(root, f.path);
      if (full !== root && !full.startsWith(root + path.sep)) return false;
      if (windowFetchedFileContent(fs.readFileSync(full, 'utf8'), pc.body || '').confidence === 'strong') return true;
      // the cited code may have moved to a sibling file (what refreshCandidateFetchedFiles now follows)
      const hit = require('./sdk/lib/file-grounding.js').relocateStaleAnchor(root, f.path, pc.body || '');
      return !!hit && windowFetchedFileContent(hit.content, pc.body || '').confidence === 'strong';
    });
  } catch { return false; }
}

// The cited code MOVED: a declared (non-context) file whose live content no longer contains the candidate's Snippet, although it IS in exactly one other file (recomputed from the live
// repo, not from the stored anchorConfidence: a task minted while the code was in place stored 'strong', and a file can window 'strong' through symbols that merely occur elsewhere in it).
// Fail-closed like groundingNowReliable.
function citedCodeMovedAndRelocatable(task) {
  const pc = task && task.promptContext;
  const declared = pc && Array.isArray(pc.fetchedFiles) ? pc.fetchedFiles.filter((f) => f && !f.context && f.path) : [];
  if (!declared.length || !pc.body) return false;
  try {
    const path = require('path');
    const fs = require('fs');
    const root = path.resolve(require('./config.js').getConfig().repoRoot);
    const { windowFetchedFileContent, relocateStaleAnchor, snippetMissingFrom } = require('./sdk/lib/file-grounding.js');
    let moved = 0;
    for (const f of declared) {
      const full = path.resolve(root, f.path);
      if (full !== root && !full.startsWith(root + path.sep)) return false;
      let text = '';
      try { text = fs.readFileSync(full, 'utf8'); } catch (e) { if (!e || e.code !== 'ENOENT') throw e; } // a renamed / deleted cited file counts as "the snippet is not there"
      if (!snippetMissingFrom(text, pc.body)) continue;
      const hit = relocateStaleAnchor(root, f.path, pc.body);
      if (!hit || windowFetchedFileContent(hit.content, pc.body).confidence !== 'strong') return false;
      moved += 1;
    }
    return moved > 0;
  } catch { return false; }
}

// Shared by the two docs-only-gate entries: the recorded failure is the docs-only block AND the current gate would no longer read the task as asking for code.
function docsOnlyGateNoLongerBlocks(task) {
  const t = failureText(task);
  if (!/only (?:touches|created\/edited) documentation/.test(t) || !/code change/.test(t)) return false;
  try { return !require('./adhoc-diff-sanity.js').taskWantsCodeChange(task); } catch { return false; }
}

// The recorded failure says the piece's own sibling (the earlier part it builds on) was "not merged" into the tree the draft or the review's executed verification
// worked in. Stacked children now draft and verify on their shared branch (agentic-draft-common.js and review-task.js both use resolveGroundingRef), so the failure can
// recur only if that branch is missing; re-admit only when the stacked branch exists on origin now and carries commits beyond the default branch. Fail closed.
const SIBLING_NOT_IN_TREE_RE = /sibling[^\n]{0,120}(?:not (?:yet )?merged|has not been merged|not (?:yet )?(?:present|landed|in the (?:working )?tree))|(?:not|never) (?:yet )?merged into the working tree|(?:guard|code|change)[^\n]{0,60}from (?:the )?(?:sibling|1\/\d)[^\n]{0,40}not (?:yet )?merged/i;
function siblingNowReachableOnStackedBranch(task) {
  if (!task || !task.stacked || !task.stacked.branch || !SIBLING_NOT_IN_TREE_RE.test(failureText(task))) return false;
  try {
    const { resolveGroundingRef } = require('./stacked-grounding.js');
    const { execFileSync } = require('child_process');
    const root = require('./config.js').getConfig().repoRoot;
    const branch = resolveGroundingRef(task, root);
    if (!branch) return false;
    const base = require('./git-runner.js').detectDefaultBranch(root);
    const ahead = execFileSync('git', ['rev-list', '--count', `origin/${base}..origin/${branch}`], { cwd: root, encoding: 'utf8', timeout: 30000 }).trim();
    return Number(ahead) > 0;
  } catch { return false; }
}

// The recorded failure says a sibling repo could not be reached from the implement pass AND the task really does name a registered sibling repo (an absolute path
// inside one of `roots`, by default the read-only root list the implement pass itself now gets). Fail closed: no roots, no raw text or a throw is "no".
const SIBLING_PATH_RE = /\/media\/model-cache\/github\/[A-Za-z0-9._-]+(?:\/[^\s'"`),;]*)?/g;
function siblingRepoWasUnreachable(task, roots) {
  const t = failureText(task);
  const unreachable = /not inside any accessible repo|exactly one accessible repo/i.test(t)
    || (/No such file or directory/i.test(t) && /\/media\/model-cache\/github\/[A-Za-z0-9._-]+/.test(t));
  if (!unreachable) return false;
  try {
    const path = require('path');
    const fs = require('fs');
    const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
    let list = roots;
    if (!list) {
      const core = process.env.AGENT_MANAGER_CORE_REPO_ROOT || require('./config.js').getConfig().repoRoot;
      list = require('./accessible-roots.js').resolveReadOnlySiblingRoots({ repoRoot: core });
    }
    const named = String(task && task.promptContext && task.promptContext.rawText || '').match(SIBLING_PATH_RE) || [];
    return named.some((p) => list.some((r) => { const rr = real(r); const pp = real(p); return pp === rr || pp.startsWith(rr + path.sep); }));
  } catch { return false; }
}

// The lane endpoint a task's recorded failure names ("Ollama endpoint http://host:11434 is not reachable (...)" / "... did not answer within 5000ms"), or null.
const ENDPOINT_FAILURE_RE = /Ollama endpoint (https?:\/\/[^\s"')]+) (?:is not reachable|did not answer within)/;

// Does that endpoint answer HTTP right now? The REAL check, re-run when the sweep looks at a parked task: any status code counts (as scripts/agent-manager-common.sh
// ollama_endpoint_reachable), refused / timed out / unreachable does not. Cached per URL for 60 s so a sweep over many parked tasks probes each endpoint once.
// _setEndpointProbe lets tests replace it; it never throws (fail-closed: unknown = not answering = leave the task parked).
const defaultEndpointProbe = (url) => {
  try {
    const r = require('child_process').spawnSync('curl', ['-s', '-m', '3', '-o', '/dev/null', '-w', '%{http_code}', `${url.replace(/\/+$/, '')}/api/version`], { encoding: 'utf8', timeout: 6000 });
    const code = String(r.stdout || '').trim();
    return r.status === 0 && code !== '' && code !== '000';
  } catch { return false; }
};
let endpointProbe = defaultEndpointProbe;
const endpointCache = new Map();
function endpointAnswersNow(url) {
  const hit = endpointCache.get(url);
  if (hit && Date.now() - hit.at < 60000) return hit.ok;
  const ok = !!endpointProbe(url);
  endpointCache.set(url, { at: Date.now(), ok });
  return ok;
}
function _setEndpointProbe(fn) { endpointProbe = fn || defaultEndpointProbe; endpointCache.clear(); }

// A task parked because its lane's Ollama endpoint was down (the 2026-10-23 grimm reset parked six) AND that endpoint answers again.
function parkedOnEndpointOutageAndEndpointBack(task) {
  const m = ENDPOINT_FAILURE_RE.exec(failureText(task));
  return !!m && endpointAnswersNow(m[1]);
}

const KNOWN_FIXED = [
  {
    id: 'wrong-block-whole-function-snippet',
    fixedIn: 'agent-manager #394',
    description: 'findEditFarFromAnchor judged an edit "a DIFFERENT block" by distance from one line of a whole-function Snippet',
    dirs: ['blocked', 'needs-clarification'],
    applies: (task) => failureText(task).includes('matches the file -- but a DIFFERENT block than the one this candidate flagged'),
  },
  {
    id: 'typographic-find-mismatch',
    fixedIn: 'agent-manager #396',
    description: 'a Group B find differing from the file only by curly quotes / dashes / special spaces (or a literal \\u201c escape) failed the verbatim check',
    dirs: ['blocked', 'needs-clarification'],
    applies: (task) => failureText(task).includes('does not appear verbatim anywhere in that file') && anyFetchedFileMatches(task, TYPOGRAPHIC_RE),
  },
  {
    id: 'revision-commentary-replaced-draft',
    fixedIn: 'agent-manager #396',
    description: 'the critique revise call answered with commentary and that prose replaced the draft, tripping the meta-commentary gate',
    dirs: ['blocked', 'needs-clarification'],
    applies: (task) => /bare tool-call request or meta-commentary|consists entirely of meta-commentary/.test(failureText(task)),
  },
  {
    id: 'draft-sandbox-stdout-line',
    fixedIn: 'agent-manager (draft-sandbox stdout fix, 2026-09-20)',
    description: 'prepareAdhocWorktree logged its node_modules line to STDOUT (#420), so the worker could not JSON.parse local-draft.js output and a SUCCESSFUL draft was recorded as "draft call failed" and retried',
    dirs: ['blocked', 'needs-clarification'],
    applies: (task) => { const t = failureText(task); return /draft call failed \d+ times/.test(t) && t.includes('[draft-sandbox]'); },
  },
  {
    id: 'implement-degenerate-invisible-block',
    fixedIn: 'agent-manager (implement-pass degenerate now stamps blockedStage "implement", 2026-09-21)',
    description: 'an "Implement pass degenerate: empty/truncated" block stamped no blockedStage, so reject-retry-check never saw it and the task sat in blocked/ forever',
    dirs: ['blocked'],
    // Only the victims that predate the stamp (no blockedStage): a task that already carries one is handled by the sweep itself.
    applies: (task) => !task.blockedStage && /Implement pass degenerate/.test(failureText(task)),
  },
  {
    id: 'docs-only-gate-negated-paths',
    fixedIn: 'agent-manager (docs-only gate: negated / cited / boilerplate path mentions, 2026-09-21)',
    description: 'adhoc-diff-sanity blocked a CORRECT docs-only diff ("the task asks for a code change") because the task text mentioned code paths only to say they are NOT to be edited, or because the model plan described what the document will cite',
    dirs: ['blocked', 'needs-clarification'],
    // The failure text AND a structural precondition: the fixed gate would no longer read this task as asking for code (a task that really wants code stays put).
    applies: docsOnlyGateNoLongerBlocks,
  },
  {
    // A NEW id for the 2026-10-15 follow-up fix: the sweep stamps firstSeen once per id and skips tasks that got stuck after it, so the 2026-09-21 entry above could never drain
    // the tasks the later fix unblocks (the PromptForge and core GPU broker verification tasks, stuck 2026-10-15/16, were skipped as "failed after the fix").
    id: 'docs-only-gate-read-only-deliverable',
    fixedIn: 'agent-manager (docs-only gate: read-only documentation tasks and edit verbs inside identifiers, 5ac1dee7, 2026-10-15)',
    description: 'adhoc-diff-sanity blocked a CORRECT docs-only diff ("the task asks for a code change") for a task that states a documentation deliverable and says its code is read-only, because verbs and phrases in code-citing sentences ("would move", "lease-delete+yield", "a NEW file") were read as requests',
    dirs: ['blocked', 'needs-clarification'],
    applies: docsOnlyGateNoLongerBlocks,
  },
  {
    id: 'implement-pass-sibling-repos-readable',
    fixedIn: 'agent-manager (implement pass reads registered plugin/project repos read-only, merged 028e586f, 2026-10-16)',
    description: 'The agentic implement pass could see only its own worktree, so a read-only cross-repo verification task (GPU broker verify videoforge/promptforge) found "/media/model-cache/github/<repo> does not exist" or "path is not inside any accessible repo" and concluded the repo was not on this machine. It now gets every registered plugin repo as a read-only root.',
    dirs: ['blocked', 'needs-clarification'],
    // The failure text says a sibling repo was unreachable AND the task names a path inside one of the roots the implement pass now receives (a task about a repo that really is not registered stays put).
    applies: (task) => siblingRepoWasUnreachable(task),
  },
  {
    id: 'stale-snippet-partial-anchor',
    fixedIn: 'agent-manager (grounding: prefix/suffix fallback for a stale candidate Snippet, 2026-09-21)',
    description: 'a candidate whose Snippet was edited inside (a comment or parameter added since it was written) matched nowhere, so the window fell back to blind head-truncation (anchorConfidence none) and the task was escalated as "no reliable anchor"',
    dirs: ['blocked', 'needs-clarification'],
    // Failure text AND a structural precondition: the new matcher really does anchor every declared file today (a candidate whose code is genuinely gone stays put).
    applies: (task) => failureText(task).includes('could not find a reliable anchor') && groundingNowReliable(task),
  },
  {
    id: 'cited-code-moved-relocated',
    fixedIn: 'agent-manager (grounding follows a candidate\'s code to the file it moved to, 2026-09-21)',
    description: 'a candidate\'s code moved to another file (a function extracted into a sibling module, a handler moved into routes/) so the cited file had no anchor and every draft saw the wrong file, ending in refusals, mismatched find strings or an escalation whatever the failure text said',
    dirs: ['blocked', 'needs-clarification'],
    applies: (task) => citedCodeMovedAndRelocatable(task),
  },
  {
    // 2026-09-22, root-caused live via function-length-fix-ac-44: PR #436's item 2
    // ("context-only files no longer park a task") fixed hasUnreliableGrounding itself,
    // but shipped no drain entry for the shape it fixes -- only for the snippet-matching
    // bug (stale-snippet-partial-anchor, which requires a currently-'none' NON-context
    // file to exist and re-verifies it now anchors 'strong'). AC-44's actual DECLARED
    // target (src/local-draft.js) anchored 'strong' the whole time; the escalation was
    // caused entirely by a context-only reference (src/gpu-guard.js, quoted in the
    // candidate's own prose) that the pre-fix classifier wrongly counted. Because no
    // non-context file was ever 'none', stale-snippet-partial-anchor's own
    // groundingNowReliable() sees an empty `bad` list and fails closed (not fixed) --
    // exactly the case where it should recognize there was never a real problem to
    // re-verify. This entry re-runs the CURRENT (fixed) classifier directly: if a task
    // was escalated as 'unreliable-grounding' but hasUnreliableGrounding(task) no
    // longer agrees on its own stored fetchedFiles (no live file read needed -- the
    // bug was in how the classifier counted files it already had, not in re-fetching
    // them), the escalation itself is void.
    id: 'context-only-file-falsely-parked',
    fixedIn: 'agent-manager (grounding: context-only files no longer park a task, PR #436, 2026-09-21)',
    description: 'a candidate was escalated as "unreliable-grounding" solely because a context-only reference file (quoted in the write-up\'s prose, never a declared edit target) anchored `none` -- the classifier now excludes context files, and the task\'s actual declared target(s) were never unreliable at all',
    dirs: ['needs-clarification'],
    applies: (task) => {
      if (!task || !task.needsClarification || task.needsClarification.reason !== 'unreliable-grounding') return false;
      const { hasUnreliableGrounding } = require('./blocked-task-classifiers.js');
      return !hasUnreliableGrounding(task);
    },
  },
  {
    // 2026-10-18: the review fact-checker's ungrounded-field gate flagged an environment variable the draft's own diff
    // introduces (read as process.env.X / os.environ / getenv / shell ${X:-}) -- e.g. AGENT_MANAGER_EDIT_FILE_TIERS on
    // brain-dump 1890. fact-checker.js now exempts those names; this re-runs that same extraction on the parked task's
    // own diff and re-admits it only when EVERY flagged name is such an env read (one genuinely invented name keeps it parked).
    id: 'ungrounded-field-new-env-var',
    fixedIn: 'agent-manager (fact-checker: an env var read by the draft\'s own diff is not ungrounded, 2026-10-18)',
    description: 'an ungrounded-field block on a name the draft itself introduces as an environment variable it reads',
    dirs: ['blocked', 'needs-clarification'],
    applies: (task) => {
      const names = [...failureText(task).matchAll(/ungrounded-field: ([A-Z][A-Z0-9]*_[A-Z0-9_]+)/g)].map((m) => m[1]);
      if (!names.length) return false;
      const { extractEnvReadIdentifiers } = require('./fact-checker.js');
      const reads = extractEnvReadIdentifiers((task && (task.implementResponse || task.rawDiff)) || '');
      return names.every((n) => reads.has(n));
    },
  },
  {
    // 2026-10-24, HUB0270 2/4: check 4 now skips status claims (e.g. "All 42 tests pass") when the
    // summary or task text contains a whole-suite run phrase ('test/*.test.js', 'npm test', 'full suite',
    // 'whole suite', 'all tests', 'node --test', 'unittest discover', 'pytest'), because such a claim is
    // about the ENTIRE test suite, not the diff's added test definitions -- comparing the status count to
    // the diff's added test defs would always fail spuriously. This entry re-runs that same check against
    // the parked task's stored summary and rawText to determine if the fix genuinely unblocks it.
    id: 'false-test-count-claim-whole-suite',
    failureClass: 'false-test-count-claim on a status claim that reported a whole-suite total',
    fixedIn: 'agent-manager (adhoc-diff-sanity check 4: skip status claims when a whole-suite run phrase is present, HUB0270 2/4)',
    description: "check 4 rejected a CORRECT status claim ('All 42 tests pass') because the summary did not contain a whole-suite run phrase, and the check compared the whole-suite count (42) against the diff's added test defs (3) -- the claim was about the entire suite, not the diff's additions, so the comparison was always going to fail spuriously",
    dirs: ['blocked', 'needs-clarification'],
    applies: (task) => {
      const t = failureText(task);
      // The recorded failure is the check-4 false-completion-claim reason.
      if (!/summary claims \d+ tests but the diff only adds \d+ test definition/.test(t)) return false;
      try {
        // Inline the check-4 logic: extractClaimedTestCount + WHOLE_SUITE_RUN_RE check.
        // `extractClaimedTestCount` is not exported from adhoc-diff-sanity.js, so we replicate
        // the relevant portion here for the known-fixed-failures registry.
        const ALL_N_TESTS_RE = /\ball\s+(\d+)\s+tests?\b/i;
        const N_TESTS_CLAIM_RE = /\b(\d+)\s+tests?\s+(?:pass(?:es|ed|ing)?|added)\b/i;
        const WHOLE_SUITE_RUN_RE = /\b(?:test\/\*\.test\.js|npm test|full suite|whole suite|all tests|node --test|unittest discover|pytest)\b/i;
        const summary = (task && task.promptContext && task.promptContext.body) || '';
        const rawText = (task && task.promptContext && task.promptContext.rawText) || '';
        const combined = `${summary}\n${rawText}`;
        const all = ALL_N_TESTS_RE.exec(summary);
        if (all) {
          // "all N tests" -> kind 'status'
          return !!WHOLE_SUITE_RUN_RE.test(combined);
        }
        const m = N_TESTS_CLAIM_RE.exec(summary);
        if (!m) return false;
        const kind = /added/i.test(m[0]) ? 'added' : 'status';
        if (kind !== 'status') return false;
        // The fix: a whole-suite run phrase in the summary or rawText means the status claim is
        // about the entire suite, so check 4 should skip (not compare against the diff).
        return !!WHOLE_SUITE_RUN_RE.test(combined);
      } catch { return false; }
    },
  },
  {
    // 2026-10-19: the same gate flagged an ALL_CAPS dummy string that exists only in a test file the draft itself adds (brain-dump 1891's
    // SENTINEL_THOUGHT). fact-checker.js now exempts those, as it already did for URLs; this re-runs that same extraction on the parked
    // task's own diff and re-admits it only when EVERY flagged name qualifies (a name production code also uses stays flagged).
    id: 'ungrounded-field-test-fixture',
    fixedIn: 'agent-manager (fact-checker: a fixture token only in the draft\'s own added test files is not ungrounded, 2026-10-19)',
    description: 'an ungrounded-field block on an ALL_CAPS name that appears only on added lines of test files in the draft\'s own diff',
    dirs: ['blocked', 'needs-clarification'],
    applies: (task) => {
      const names = [...failureText(task).matchAll(/ungrounded-field: ([A-Z][A-Z0-9]*_[A-Z0-9_]+)/g)].map((m) => m[1]);
      if (!names.length) return false;
      const { fieldsOnlyInAddedTestFiles } = require('./fact-checker.js');
      const fixtures = fieldsOnlyInAddedTestFiles((task && (task.implementResponse || task.rawDiff)) || '');
      return names.every((n) => fixtures.has(n));
    },
  },
  {
    // 2026-10-23 (Grimmethy: the rx580 lane sat idle 12 h after grimm hard-reset; "this is a recurring event"): with the lane's Ollama endpoint down, every draft failed
    // identically, burned the infra requeue rounds and parked the task in blocked/. scripts/local-worker.sh now claims nothing while its endpoint is down (the circuit
    // breaker), so this cannot happen again; this requeues, once, the tasks parked before it existed, and only when the endpoint they name answers now.
    id: 'lane-endpoint-outage-parked',
    fixedIn: 'agent-manager (worker endpoint circuit breaker, 2026-10-23)',
    description: 'a draft that failed only because the lane\'s Ollama endpoint was unreachable or silent (host reset, service down) parked the task after its retry rounds; the endpoint answers again',
    dirs: ['blocked', 'needs-clarification'],
    applies: parkedOnEndpointOutageAndEndpointBack,
  },
  {
    // 2026-10-26: the forbidden-path gate read "Does not touch any file other than `x`" as forbidding x, and a file the task itself says to create was forbidden by its own
    // "exactly one new file" scope sentences (HUB0040 2/3, HUB0125 1/2). The gate now exempts both; this re-admits a parked task only when the CURRENT gate no longer forbids
    // the path its block named.
    id: 'forbidden-path-exemption-and-created-targets',
    fixedIn: 'agent-manager (adhoc-diff-sanity: exception clauses exempt, created files are declared targets, 2026-10-26)',
    description: 'adhoc-diff-sanity blocked a diff for touching a path that the task\'s own text exempts ("other than x") or says to create',
    dirs: ['blocked', 'needs-clarification'],
    applies: (task) => {
      const named = [...failureText(task).matchAll(/matches forbidden "([^"]+)"/g)].map((m) => m[1]);
      if (!named.length) return false;
      try {
        const g = require('./adhoc-diff-sanity.js');
        const rawText = (task.promptContext && task.promptContext.rawText) || task.title || '';
        const planText = task.planResponse || task.lastGoodPlan || '';
        const targets = g.extractDeclaredTargets(task, planText);
        const forbidden = g.extractForbiddenPaths(`${rawText}\n${planText}`).filter((f) => !targets.some((t) => g.pathsRefEqual(f, t)));
        return named.every((n) => !forbidden.some((f) => f === n));
      } catch { return false; }
    },
  },
  {
    // 2026-10-26: a stacked test piece (HUB0123 2/2) was parked after drafts and reviews ran in a tree WITHOUT its sibling's code ("the 1/2 guard is not yet merged"; the
    // sibling was on the shared branch the whole time). Drafting and the review's executed verification now use the stacked branch as their base; the failed attempts predate that.
    id: 'stacked-sibling-missing-from-tree',
    fixedIn: 'agent-manager (stacked children draft and verify on their shared branch: stacked-grounding.js / review-task.js baseBranch, 2026-10)',
    description: 'a stacked hub piece failed because its sibling piece\'s code was absent from the tree the draft or the executed verification used, although the sibling is on the shared stacked branch',
    dirs: ['blocked', 'needs-clarification'],
    applies: siblingNowReachableOnStackedBranch,
  },
];

module.exports = { KNOWN_FIXED, failureText, siblingRepoWasUnreachable, SIBLING_NOT_IN_TREE_RE, _setEndpointProbe };
