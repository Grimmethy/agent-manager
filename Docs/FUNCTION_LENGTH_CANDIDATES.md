# Function Length Decomposition Candidates

### AC-1 · Decompose reviewTask's multi-responsibility body
Strength: Strong
Files: src/review-task.js
Snippet:
```
  const baseMajorityVote = localMajorityVote || localMajorityVoteBackend;
  const resolvedMajorityVote = profileOverrides && !localMajorityVote
    ? (opts) => baseMajorityVote({ ...profileOverrides, ...opts })
    : baseMajorityVote;
  appendHistoryEvent(task, 'review-started');
  const domainCfg = getDomainConfig(domainsPath, task.domain);
  const workDir = getWorkDir(domainCfg, { repoRoot, secondBrainDir });

  // fact-check: deep_dive's real "repo root" for this purpose is the cloned external
  // project (looked up by promptContext.projectSlug), not agent-manager's own repo --
  // otherwise every referenced file reports as missing.
  let repoRootForCheck = workDir;
  if (task.source === 'deep_dive' && deepDiveCoveragePath && fs.existsSync(deepDiveCoveragePath)) {
    try {
      const ddCoverage = JSON.parse(fs.readFileSync(deepDiveCoveragePath, 'utf8'));
      const ddProj = ddCoverage.projects && ddCoverage.projects[task.promptContext.projectSlug];
      if (ddProj && ddProj.clonePath) repoRootForCheck = ddProj.clonePath;
    } catch (e) { /* fall back to workDir */ }
  } else if (task.source === 'brain_dump_sort' && secondBrainDir) {
    // Same reasoning as deep_dive above: brain_dump_sort's implementResponse names a
    // secondBrainPath, which is a location under the VAULT, never under repoRoot --
    // task-domains.json's brain_dump_sort entry has workDirKind:'repoRoot' (a domain-
    // config default, not specific to this source), so without this override every
    // single brain_dump_sort draft's secondBrainPath got fact-checked against the wrong
    // directory entirely and reported "missing" regardless of whether the destination
    // note already existed. Confirmed live 2026-08-16: this was one of two compounding
    // causes (see buildVerdictPrompt's brain_dump_sort carve-out below for the other)
    // behind EVERY real brain_dump_sort task getting rejected at review.
    repoRootForCheck = secondBrainDir;
  }

  const taskPathForGrounding = path.join(require('os').tmpdir(), `review-grounding-${task.id}.json`);
```

Problem:
At 251 lines, reviewTask interleaves at least four independently-failing responsibilities in a single sequential body: majority-vote strategy resolution (baseMajorityVote / resolvedMajorityVote with a profileOverrides conditional), domain and work-dir configuration lookup (getDomainConfig, getWorkDir), source-specific repo-root resolution that branches on task.source with its own file-existence guard, try/catch around JSON.parse(readFileSync), nested property traversal, and a semantic override for brain_dump_sort, and finally grounding-file setup via os.tmpdir(). None of these blocks is a flat data literal; each contains conditional branching, synchronous I/O, error recovery, and cross-source override logic with its own failure mode. The 2026-08-16 regression in which every real brain_dump_sort task was rejected at review was a compounding bug spanning two spots roughly 80 lines apart inside this one body, which is precisely the class of defect that is harder to catch and harder to bisect when the two interacting pieces share a single untested monolith rather than living in two named, individually tested functions.

Solution:
Extract four named helper functions from the body of reviewTask, each returning a small result object and carrying its own try/catch where I/O is involved: resolveMajorityVote(task, profileOverrides) encapsulates the base/resolved vote logic and the profileOverrides conditional; resolveDomainAndWorkDir(task) wraps getDomainConfig and getWorkDir and returns a unified config record; resolveRepoRootForSource(task, domainConfig) contains the if/else-if on task.source, the deep_dive JSON lookup with its file-existence guard and fallback, and the brain_dump_sort semantic override that corrects the domain-config default workDirKind; and setupGroundingFile(task) builds the taskPathForGrounding via os.tmpdir(). reviewTask itself then becomes a short orchestrator that calls these four in sequence, destructures their results, and proceeds to the review-orchestration and verdict-prompt logic that already follows in the lower portion of the function. No new modules, no new exports beyond the file; the four helpers are module-private functions in the same src/review-task.js file.

Benefits:
Each extracted helper is independently unit-testable with a stubbed task object and a stubbed filesystem, so the brain_dump_sort workDirKind override and the deep_dive clone-path fallback each get a focused test that asserts the exact return value without exercising the majority-vote or grounding-file code paths. A future change to one source's repo-root resolution (for example, adding a third task.source) touches only resolveRepoRootForSource and its test, and a reviewer can verify the change in a 30-line diff rather than scrolling through 251 lines to confirm the majority-vote wrapper above it is untouched. The compounding-bug failure mode that produced the 2026-08-16 regression becomes structurally harder to reproduce because the two interacting decisions now live in adjacent, named, individually tested functions whose contracts are visible at a glance.
