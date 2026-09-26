# Function Length Decomposition Candidates

### AC-1 · Split applyAdhocDiff into routing, guard, and apply stages
Strength: Strong
Files: src/apply-adhoc-diff.js
Snippet:
```

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
```

Problem:
`applyAdhocDiff(task, rawDiff)` is 109 lines and interleaves three unrelated responsibilities that merely share the `task` parameter. The first ~8 lines are a resolution-routing branch: it inspects `task.adhocResolution`, validates `subTaskProposals`, calls `queueSubTasks`, and returns a skip-result object — a pure domain operation with no file I/O, no git subprocess, and no diff handling. The next ~6 lines are a guard that checks `rawDiff` for emptiness and builds a human-readable reason string. The remaining ~90+ lines are a multi-step I/O pipeline: writing a temp file, running `git apply --numstat` as a parse-check via `execFileSync`, then (in the unseen tail) running the real `git apply`, handling the error path, cleaning up the temp file, and assembling the return object. Because these three concerns are co-located in one function, a reviewer must hold the routing logic, the guard logic, and the subprocess pipeline in working memory simultaneously, and a change to any one (e.g., adding a new resolution type) forces a re-read of the unrelated I/O code.

Solution:
Extract three named helpers and reduce `applyAdhocDiff` to a ~15-line dispatcher. (1) `routeAdhocResolution(task)` — contains the `decompose` branch: reads `task.adhocResolution`, validates `subTaskProposals`, calls `queueSubTasks`, and returns either a skip-result object or `null` to signal "continue." (2) `guardEmptyDiff(rawDiff)` — returns `{ skipped: true, reason: string }` when `rawDiff` is falsy/whitespace-only, otherwise `null`. (3) `materializeAndApplyPatch(rawDiff, worktreePath)` — owns the temp-file write, the `execFileSync('git', ['apply', '--numstat', '--unidiff-zero', tmpPath])` parse-check, the real `execFileSync('git', ['apply', tmpPath])`, the `try/catch` error assembly, and the `finally` block that unlinks the temp file; returns the success or failure result object. The top-level `applyAdhocDiff` then reads:

```js
function applyAdhocDiff(task, rawDiff) {
  const routed = routeAdhocResolution(task);
  if (routed) return routed;

  const guard = guardEmptyDiff(rawDiff);
  if (guard) return guard;

  return materializeAndApplyPatch(rawDiff, task.worktreePath);
}
```

Each helper is independently unit-testable: `routeAdhocResolution` can be tested with mock `queueSubTasks`; `guardEmptyDiff` is a pure function; `materializeAndApplyPatch` can be tested with a temp-dir fixture and a stubbed `execFileSync`.

Benefits:
A reviewer touching the resolution-routing logic no longer scrolls past 90 lines of git subprocess code, and vice-versa. The `try/catch`/`finally` cleanup is isolated inside one function, so a future change to the apply pipeline (e.g., adding `--3way` or a retry) cannot accidentally disturb the routing or guard paths. Each extracted helper has a single, obvious contract, making the top-level dispatcher self-documenting and trivially coverable by a three-branch integration test.

### AC-2 · Extract file-load and entry-lookup from applyGroupA
Strength: Strong
Files: src/apply-group-a.js
Snippet:
```

function applyBrainDumpSort({ implementResponse, task, brainDumpPath, secondBrainDir, pipelineDir }) {
  const { brainDumpEntryId, rawText } = task.promptContext;

  let data;
  try {
    data = JSON.parse(fs.existsSync(brainDumpPath) ? fs.readFileSync(brainDumpPath, 'utf8') : '{"entries":[]}');
  } catch {
    data = { entries: [] };
  }
  if (!Array.isArray(data.entries)) data.entries = [];

  const entry = data.entries.find((e) => e && e.id === brainDumpEntryId);
  if (!entry) {
    return { skipped: true, reason: `brain-dump entry "${brainDumpEntryId}" no longer exists (deleted since this task was drafted)` };
  }
  // The entry may have been edited (the dashboard's PUT resets status back to 'captured' on
  // a text change) or otherwise changed since this task was drafted -- classifying stale
  // text into the entry's CURRENT record would silently mislabel it under a rawText it no
  // longer has. Only apply if the entry is still exactly what this task was drafted against.
  if (entry.status !== 'captured' || entry.rawText !== rawText) {
    return { skipped: true, reason: 'brain-dump entry changed since this task was drafted -- not applying a stale classification' };
  }

  const result = parseBrainDumpSortResult(implementResponse);
  if (!result) {
    return { skipped: true, reason: 'implement pass did not return a valid classification -- entry left as captured for retry' };
  }
  if (!secondBrainDir) {
    return { skipped: true, reason: 'SECOND_BRAIN_DIR is not configured -- cannot file this entry anywhere' };
  }

```

Problem:
The visible opening of this 205-line function already interleaves at least two self-contained responsibilities before any domain-specific apply logic begins: a file-existence guard, a synchronous `readFileSync`, a `JSON.parse`, and a shape-coercion step on `data.entries` (a persisted-store loading concern with its own failure modes), followed immediately by an `entries.find(...)` record-retrieval concern. Neither of these is a one-liner; each carries its own error path and state assumption. Embedding them inline means a reader must track file-system state, deserialization edge cases, and array-search semantics before reaching the function's actual purpose, and any change to the store format ripples through a 205-line body rather than a single named helper.

Solution:
Extract the file-load-and-parse sequence (`fs.existsSync` guard, `readFileSync`, `JSON.parse`, and the `data.entries` shape-coercion) into a `loadBrainDump(filePath)` helper that returns a normalized store object or throws a domain-specific error. Extract the `entries.find(...)` call into a `findEntry(store, key)` helper that returns the matched entry or `undefined`. The remaining body of `applyGroupA` then starts at the point where it operates on the located entry, so the function's entry point reads as a short, legible pipeline (load → find → apply) rather than a monolithic block. Each extracted helper is small, independently callable, and has a clear contract that can be documented in its JSDoc without referencing the broader pipeline.

Benefits:
A reviewer scanning `applyGroupA` sees a three-step flow instead of a 205-line wall, making it straightforward to verify that the apply logic is correct without first mentally parsing the I/O and lookup preamble. Unit tests for `loadBrainDump` can exercise malformed JSON, missing files, and shape mismatches in isolation with no mocks beyond a temp-file fixture. Unit tests for `findEntry` can verify lookup semantics (exact key match, empty array, missing key) with a plain in-memory object. The main function's test surface shrinks to the apply logic itself, reducing the number of setup steps and mocks required per test case and making regression diffs in code review far easier to attribute to a single concern.

### AC-3 · Decompose `callOnce` in claude-client.js
Strength: Strong
Files: src/claude-client.js
Snippet:
```

async function callOnce({ prompt, model, effort, maxTurns = 1, allowedTools, permissionMode = 'dontAsk', cwd, timeoutMs, sandbox, resume }) {
  assertSubscriptionAuthAvailable();
  // cwd lets a caller run this against a real project directory instead of the
  // isolated scratch dir -- e.g. the dashboard's Discuss sessions (2026-08-17, brain-
  // dump entry: "Claude in the agent-manager has no access to... the system it's
  // housed inside") pass the active project's repoRoot here alongside a read-only
  // allowedTools list, so Read/Grep/Glob actually resolve real files instead of an
  // empty directory. Falls back to CLAUDE_CWD (the isolated scratch dir) for every
  // caller that doesn't explicitly ask for this -- the existing, safer default.
  const workDir = cwd || CLAUDE_CWD;
  fs.mkdirSync(workDir, { recursive: true });

  const datedPrompt = `${currentDateLine()}\n\n${prompt}`;
  const args = [
    '-p', datedPrompt,
    '--output-format', 'json',
    '--model', model || MODEL,
    '--max-turns', String(maxTurns),
    '--permission-mode', permissionMode,
  ];
  // low/medium/high/xhigh/max -- see CLI --effort. Falls back to the CLI's own default
  // (currently "high") when neither the call site nor CLAUDE_EFFORT sets one, same
  // "don't invent a value the caller didn't ask for" reasoning as `model` above.
  const effortLevel = effort || process.env.CLAUDE_EFFORT;
  if (effortLevel) args.push('--effort', effortLevel);
  // No --allowedTools by default -- this module is used as a plain text-completion
  // backend (drafting/critiquing/reviewing prompt text), the same shape as Ollama's
  // /api/generate, not an agentic session. Callers that genuinely need tool access can
  // pass allowedTools explicitly.
  //
  // But leaving tools implicitly available (the CLI's own default) combined with
```

Problem:
The 124-line `callOnce` function at line 87 interleaves at least four distinct responsibilities—environment and directory setup (auth assertion, `workDir` resolution, `mkdirSync`), CLI argument construction (conditional `--effort`, `--allowedTools`, `--permission-mode`, `--max-turns` flags), child-process lifecycle management (spawn, `timeoutMs` enforcement, `sandbox` wrapper wiring, `resume` session-id passthrough), and response parsing (extracting text and tool-use blocks from the `--output-format json` payload)—into a single linear body. The ten-parameter signature (`prompt, model, effort, maxTurns, allowedTools, permissionMode, cwd, timeoutMs, sandbox, resume`) makes it impossible for a reviewer to change timeout semantics or add a new flag without scanning the entire function for side effects on the other concerns, and the entanglement means a regression in arg-building silently corrupts the spawn call or vice versa.

Solution:
Extract three named helpers from `callOnce`, each taking only the subset of parameters it needs: (1) `resolveWorkDir(cwd, sandbox)` handles auth assertion, directory resolution, and `mkdirSync`, returning the final working directory; (2) `buildCliArgs({ model, effort, maxTurns, allowedTools, permissionMode, resume, prompt })` returns the fully-assembled `string[]` for the CLI invocation, with all conditional flag logic isolated and trivially unit-testable against a table of input objects; (3) `spawnAndCollect(workDir, args, { timeoutMs, sandbox })` encapsulates the child-process spawn, timeout timer, sandbox wrapper invocation, and stdout/stderr collection, returning a raw `{ stdout, stderr, exitCode }` object. `callOnce` then becomes a thin ~20-line orchestrator that calls those three helpers in sequence and delegates the final JSON-parsing step to a small `parseClaudeResponse(stdout)` utility, leaving the function as a readable pipeline rather than a monolith.

Benefits:
Each extracted helper is independently testable—`buildCliArgs` can be asserted against expected flag arrays without spawning anything, `spawnAndCollect` can be tested with a mock `child_process.spawn`, and `parseClaudeResponse` can be fed canned JSON fixtures—so the test surface shrinks from one brittle integration test to four fast, isolated units. Code review becomes scoped: a change to timeout behavior touches only `spawnAndCollect`, a new `--flag` touches only `buildCliArgs`, and the orchestrator diff stays under 25 lines, eliminating the "wade through 120 lines to find the one `if` I care about" cost that currently slows every PR touching this file.

### AC-4 · Decompose the 661-line local-draft orchestrator into single-responsibility helpers
Strength: Strong
Files: src/local-draft.js
Snippet:
```
 */
async function draftTask(task, {
  localCall = null, projectSearchFetch = runSearches, recordModelCall = defaultRecordModelCall,
  draftAdhocImplementFn = draftAdhocImplement,
  draftAdhocViaHarnessSearchFn = draftAdhocViaHarnessSearch,
  draftAdhocViaLocalAgenticFn = draftAdhocViaLocalAgentic,
  draftResearchImplementFn = draftResearchImplement, withLockFn = defaultWithLock,
} = {}) {
  // Resolved here rather than as a static default param: the right backend depends on the
  // task's reasoning tier (model-provider.js's reasoningTierFor()), which isn't known
  // until the task object itself is in hand -- passing the whole task (not just
  // task.source) lets a per-instance task.reasoningTier override take effect, e.g. Brain
  // Dump #77's automatic high-reasoning retry for a needs-clarification task. Explicit
  // test/caller overrides (localCall passed in) always win -- this only fills the gap
  // production code leaves (local-draft.js's own main() calls draftTask(task) with no
  // second argument at all).
  // 2026-08-24 (model-profile-registry.js): when the task's own source declares a
  // modelProfile, its model/numCtx/numPredict become defaults for every real call below --
  // spread BEFORE each call site's own opts so a pass's own tuned numPredict (plan=1400,
  // critique=900, ...) still wins over the profile's generic default, while model/numCtx
  // (never set by any call site's own opts today) reliably take effect. Skipped entirely
  // for an injected localCall (test/caller override) -- that already wins outright, same
  // as it always has; wrapping it here would silently change what a test believes it's
  // calling.
  const modelProfile = resolveModelProfile(task);
  const profileOverrides = modelProfile
    ? { model: modelProfile.model, numCtx: modelProfile.numCtx, numPredict: modelProfile.numPredict }
    : null;
  const baseLocalCall = localCall || providerFor(task).call;
  const resolvedLocalCall = profileOverrides && !localCall
    ? (opts) => baseLocalCall({ ...profileOverrides, ...opts })
    : baseLocalCall;
```

Problem:
The async body of the local-draft entry point packs five distinct concerns into one 661-line scope: model-profile resolution and the spread-before override wrapper, backend/strategy selection among four injected draft functions keyed on task.source and reasoningTier, sequential multi-call orchestration where each pass carries its own numPredict and opts, lock acquisition and release around the entire call sequence, and per-call telemetry recording. Because all five share a single lexical scope, a developer changing the critique pass's numPredict must scroll past profile resolution, strategy branching, and lock plumbing to locate the right line. The Brain-Dump-#77 high-reasoning retry path is interleaved with the happy-path first call, so a regression in retry eligibility is 200 lines away from the call it guards. Unit tests must mock all four draft backends, the lock, and the recorder just to exercise one sub-concern in isolation, which is why the injected-dependency pattern that was clearly designed for testability is currently defeated by the monolithic scope.

Solution:
Extract four named helper functions from the body, each owning exactly one responsibility. First, resolveCallOpts(task, localCall, profileOverrides) encapsulates profile resolution, the spread-before override merge, and the "skip entirely for an injected localCall" branch, returning a plain opts object. Second, selectDraftStrategy(task, retryState) inspects task.source, task.reasoningTier, and the Brain-Dump-#77 retry flag and returns the single draft function to invoke plus its per-pass parameters (numPredict, temperature, etc.), eliminating the multi-way branch from the orchestrator. Third, executeDraftPasses(strategy, opts, localCall, withLockFn, recordModelCall) acquires the lock, runs the one or two sequential model calls (plan then critique, or the retry re-entry), records each call via recordModelCall, and releases the lock in a finally block. Fourth, the top-level function becomes a thin ~30-line composition: call resolveCallOpts, call selectDraftStrategy, call executeDraftPasses, and return the result. Each helper is independently importable and testable without the others.

Benefits:
A reviewer can approve a numPredict change by reading a 15-line opts object in resolveCallOpts instead of scanning 661 lines. The retry-eligibility logic in selectDraftStrategy becomes a pure decision function that can be table-tested with ten or twenty fixture tasks and zero mocks. The lock and telemetry in executeDraftPasses can be verified with a single fake lock and a call-recorder spy, independent of which draft backend was selected. Cognitive load drops from "understand five interlocking concerns in one scope" to "read three short, single-purpose functions in sequence," and the injected-dependency pattern finally delivers the testability it was designed for.

### AC-5 · Decompose runReview's multi-responsibility body (renamed from reviewTask since this candidate was filed)
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
Corrected 2026-09-22 (needs-clarification bucket review): this candidate's code and Snippet are unchanged and still accurate at their cited location in `src/review-task.js`, but the enclosing function was renamed from `reviewTask` to `runReview` since this candidate was filed -- `reviewTask` today is a 6-line wrapper that just calls `runReview` and sets `task.status`. The anchor-matcher still finds the Snippet fine (it's the same file, same lines); only the candidate's own prose named the wrong function, which would have sent an implement pass hunting for a `reviewTask` body that no longer contains any of this logic.

At 535 lines, `runReview` interleaves at least four independently-failing responsibilities in a single sequential body: majority-vote strategy resolution (baseMajorityVote / resolvedMajorityVote with a profileOverrides conditional), domain and work-dir configuration lookup (getDomainConfig, getWorkDir), source-specific repo-root resolution that branches on task.source with its own file-existence guard, try/catch around JSON.parse(readFileSync), nested property traversal, and a semantic override for brain_dump_sort, and finally grounding-file setup via os.tmpdir(). None of these blocks is a flat data literal; each contains conditional branching, synchronous I/O, error recovery, and cross-source override logic with its own failure mode. The 2026-08-16 regression in which every real brain_dump_sort task was rejected at review was a compounding bug spanning two spots roughly 80 lines apart inside this one body, which is precisely the class of defect that is harder to catch and harder to bisect when the two interacting pieces share a single untested monolith rather than living in two named, individually tested functions.

Solution:
Extract four named helper functions from the body of `runReview`, each returning a small result object and carrying its own try/catch where I/O is involved: resolveMajorityVote(task, profileOverrides) encapsulates the base/resolved vote logic and the profileOverrides conditional; resolveDomainAndWorkDir(task) wraps getDomainConfig and getWorkDir and returns a unified config record; resolveRepoRootForSource(task, domainConfig) contains the if/else-if on task.source, the deep_dive JSON lookup with its file-existence guard and fallback, and the brain_dump_sort semantic override that corrects the domain-config default workDirKind; and setupGroundingFile(task) builds the taskPathForGrounding via os.tmpdir(). `runReview` itself then becomes a short orchestrator that calls these four in sequence, destructures their results, and proceeds to the review-orchestration and verdict-prompt logic that already follows in the lower portion of the function. No new modules, no new exports beyond the file; the four helpers are module-private functions in the same src/review-task.js file. `reviewTask`, the thin wrapper that now calls `runReview`, is untouched.

Benefits:
Each extracted helper is independently unit-testable with a stubbed task object and a stubbed filesystem, so the brain_dump_sort workDirKind override and the deep_dive clone-path fallback each get a focused test that asserts the exact return value without exercising the majority-vote or grounding-file code paths. A future change to one source's repo-root resolution (for example, adding a third task.source) touches only resolveRepoRootForSource and its test, and a reviewer can verify the change in a 30-line diff rather than scrolling through 535 lines to confirm the majority-vote wrapper above it is untouched. The compounding-bug failure mode that produced the 2026-08-16 regression becomes structurally harder to reproduce because the two interacting decisions now live in adjacent, named, individually tested functions whose contracts are visible at a glance.

### AC-6 · Decompose runReview's mixed path-resolution, grounding I/O, and verdict-assembly responsibilities (renamed from reviewTask since this candidate was filed)
Strength: Strong
Files: src/review-task.js
Snippet:
```
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
  let groundingText = '';
  try {
    fs.writeFileSync(taskPathForGrounding, JSON.stringify(task));
    groundingText = execFileSync('node', [path.join(__dirname, 'get-grounding-source.js'), taskPathForGrounding], { encoding: 'utf8' });
  } catch (e) {
    groundingText = '';
  } finally {
    try { fs.unlinkSync(taskPathForGrounding); } catch (e) { /* best-effort cleanup */ }
  }

  const factCheck = checkDraft(task.implementResponse || '', repoRootForCheck, groundingText || undefined);
```

Problem:
Corrected 2026-09-22 (needs-clarification bucket review, same shape as AC-5): this candidate's code and Snippet are unchanged and still accurate at their cited location in `src/review-task.js`, but the enclosing function was renamed from `reviewTask` to `runReview` since this candidate was filed. Only the prose named the wrong function.

The 535-line body of `runReview` interleaves at least four independent concerns that each have their own failure domain and input surface: per-source path resolution with filesystem existence checks and JSON parsing of a coverage file (the `repoRootForCheck` block with its growing `else if` chain over `task.source`), grounding-text preparation via a temp-file write and `execFileSync` call to `get-grounding-source.js` with best-effort `finally` cleanup, the `checkDraft` invocation and its `undefined`-grounding fallback glue, and the prompt-assembly / LLM round-trip / verdict-shaping pipeline that the `buildVerdictPrompt` comment references. Because all of these live in one flat block, a regression in the `brain_dump_sort` path-resolution branch (exactly the 2026-08-16 bug the historical comment describes) is only discoverable by reading through the grounding I/O and prompt code to understand why the resolved root matters downstream. Each new task source adds another `else if` arm, each new grounding strategy touches the temp-file block, and each prompt tweak ripples through the same 535 lines—making the function a compounding-change hotspot rather than a linear pipeline.

Solution:
Extract four named helpers, each owning exactly one failure domain, and reduce `runReview` to a ~40–60-line orchestrator that calls them in sequence. First, `resolveRepoRootForCheck(task, workDir, ctx)` encapsulates the per-source branching, filesystem `existsSync` checks, coverage-file JSON parse, and returns a small `{ repoRoot, sourceKind }` record; the historical-bug comment moves with it. Second, `buildGroundingText(task, repoRoot)` owns the temp-file write, `execFileSync` invocation of `get-grounding-source.js`, stdout capture, and the `finally` cleanup, returning a string (empty on failure) so the orchestrator never sees an I/O exception. Third, the `checkDraft` call-site glue—deciding what arguments to pass and handling the `undefined` grounding fallback—collapses into a one-line call now that `buildGroundingText` has a stable return contract. Fourth, `buildVerdictPrompt(task, factCheckResult, grounding)` (already referenced in the comment) is made an explicit top-level function if it is not already, and the LLM API call plus response-shape validation become a fifth helper, `invokeAndParseVerdict(prompt, ctx)`. The orchestrator then reads as a short, ordered list of steps with no inline branching over `task.source` and no raw `execFileSync` in its body. `reviewTask`, the thin wrapper that now calls `runReview`, is untouched.

Benefits:
Each extracted helper can be unit-tested in isolation: `resolveRepoRootForCheck` against a fixture task object and a mocked filesystem, `buildGroundingText` with a stubbed `execFileSync`, `buildVerdictPrompt` as a pure string-shaping test, and `invokeAndParseVerdict` with a recorded LLM response. A new task source (the recurring `else if` growth) is added in one file and one function rather than threaded through 535 lines of mixed logic. Code review of a prompt change no longer requires the reviewer to mentally skip over path-resolution and I/O code to find the relevant hunk, and the 2026-08-16 class of bug—two compounding causes in different parts of the same function—becomes structurally impossible because each cause now lives in a function with a single, testable contract.

### AC-7 · Decompose the monolithic system-report builder into per-section renderers
Strength: Strong
Files: src/system-report.js
Snippet:
```
      ? ` (${fmtUsd(timeAccounting.totalCostUsd)} of that was REAL Claude spend; the rest ran locally, free, and is a token-based estimate)`
      : ' (every one of those calls actually ran locally, free -- this is a token-based estimate of what they would have cost)';
    sentences.push(`If every model call this period had gone through the Anthropic API, it would have cost an estimated ${fmtUsd(timeAccounting.totalHypotheticalCostUsd)} across ${timeAccounting.callsWithHypotheticalCost} call(s)${realPart}.`);
  }

  return sentences.join(' ');
}

function renderMarkdown({ period, startIso, endIso, tasks, downtime, timeAccounting, queueHealth, selfAuditActivity, blockedPatterns }) {
  const bySource = {};
  const byClassification = { junk: 0, benefit: 0, filtering: 0, housekeeping: 0, unclear: 0 };
  for (const t of tasks) {
    bySource[t.source || 'unknown'] = (bySource[t.source || 'unknown'] || 0) + 1;
    byClassification[t.classification] = (byClassification[t.classification] || 0) + 1;
  }

  const lines = [];
  lines.push(`# ${period[0].toUpperCase()}${period.slice(1)} Report — ${fmtLocal(startIso)} to ${fmtLocal(endIso)}`);
  lines.push('');
  lines.push(`**Tasks completed:** ${tasks.length}`);
  lines.push('');

  lines.push('## Summary');
  lines.push(buildPlainEnglishSummary({ period, tasks, byClassification, blockedPatterns, downtime, timeAccounting }));
  lines.push('');

  lines.push('## By Source');
  for (const [source, count] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${source}: ${count}`);
  }
  lines.push('');

```

Problem:
The report-building function accepts nine parameters (`period`, `startIso`, `endIso`, `tasks`, `downtime`, `timeAccounting`, `queueHealth`, `selfAuditActivity`, `blockedPatterns`) and spans roughly 137 lines because it interleaves data aggregation (computing `bySource` and `byClassification` maps) with the rendering of seven visually distinct markdown sections. Each section — "By Source," "By Classification," "Downtime," "Time Accounting," "Queue Health," "Self-Audit," "Blocked Patterns" — is a self-contained block of a header line, a loop or a few conditionals, and a trailing blank line, yet none can be tested, reviewed, or modified in isolation without constructing all nine parameters and parsing the full markdown output. The fact that `buildPlainEnglishSummary` was already extracted proves the decomposition pattern is viable here; the remaining sections simply haven't received the same treatment.

Solution:
Extract each markdown section into its own small, clearly-named pure function that takes only the slice of data it needs and returns a string (or an array of lines). Concretely: `renderBySource(bySource)`, `renderByClassification(byClassification)`, `renderDowntime(downtime)`, `renderTimeAccounting(timeAccounting)`, `renderQueueHealth(queueHealth)`, `renderSelfAudit(selfAuditActivity)`, and `renderBlockedPatterns(blockedPatterns)`. The top-level function then shrinks to (a) the two aggregation loops that produce `bySource` and `byClassification`, and (b) a short array of section strings joined with newlines, passing each parameter to exactly one renderer. The aggregation step can itself be pulled into `aggregateTaskStats(tasks)` if desired, leaving the top-level function as a thin orchestrator of roughly 15–20 lines.

Benefits:
Each renderer becomes independently unit-testable with a single argument, so a test for the Downtime warning threshold no longer needs to fabricate eight unrelated parameters or regex-scan a multi-section markdown blob. Code review diffs become scoped to one section at a time, making it obvious when a taxonomy rename touches only `renderByClassification` and `aggregateTaskStats` rather than a 137-line wall. New sections (e.g., a "Top 5 blocked patterns" sub-list) are added by writing one new function and appending one line to the orchestrator, with zero risk of accidentally reordering or breaking an unrelated section.

### AC-8 · Split onboarding side-effect from candidate selection in nextCandidateFulfillmentTask
Strength: Strong
Files: src/task-sources.js
Snippet:
```
  // lead that was actually discovered FOR this project. Without this, deep_dive treated
  // every Strong lead in the shared ledger as fair game for whichever project's pipeline
  // happened to be running.
  const strongLeads = parseStrongLeadsFromIndex(readIfExists(projectSearchIndexPath))
    .filter((lead) => lead.relevantTo === projectTag);
  // Onboarding (below) does a real `git clone` of the lead's URL -- same offline failure
  // mode as project_search's search calls, just via git instead of https directly. Only
  // guards the clone step, not the whole function: drafting from ALREADY-onboarded
  // communities (the candidates loop further down) is pure local filesystem work and
  // stays available offline.
  const onboardingOnline = strongLeads.some((lead) => !coverage.projects[slugifyForId(lead.name)]) ? isOnline() : true;
  let coverageChanged = false;
  for (const lead of strongLeads) {
    if (!onboardingOnline) break;
    const slug = slugifyForId(lead.name);
    if (coverage.projects[slug]) continue; // already onboarded (or a prior onboarding attempt failed and will retry below)
    try {
      const onboarded = onboardDeepDiveProject(lead, deepDiveClonesDir);
      coverage.projects[slug] = {
        sourceUrl: lead.url,
        clonePath: onboarded.clonePath,
        clonedAt: new Date().toISOString(),
        communities: onboarded.communities,
        // Stamped at onboarding time so arch_import's own filter (nextArchImportTask) can
        // trace a promoted item back to which consumer project it was ever relevant to,
        // without needing to re-parse INDEX.md itself.
        relevantToProject: projectTag,
      };
      coverageChanged = true;
    } catch (e) {
      // Clone/graph-build failures (bad URL, network, python not on PATH, etc.) must never
      // crash the worker loop -- log and skip this lead for this tick; since it's still
```

Problem:
`nextCandidateFulfillmentTask` is 137 lines (37 over the project limit) because it bundles two responsibilities with different I/O profiles and failure modes into a single body. The first half is an onboarding loop: it filters strong leads, checks `isOnline()`, iterates with per-lead try/catch around `git clone` and `onboardDeepDiveProject`, and mutates `coverage.projects` / `coverageChanged`. The second half (the "candidates loop further down" the in-source comments reference) is pure local-file selection and drafting over already-onboarded communities, available offline. Because both halves share the function's parameter list and mutate the same `coverage` object, a reader must hold the entire 137-line body in mind to reason about either concern in isolation, and a change to offline behavior or to the clone/retry logic forces a review of the other half.

Solution:
Extract the online-gated onboarding phase into a private helper, e.g. `onboardPendingLeads(strongLeads, coverage, deepDiveClonesDir)`, which encapsulates the `isOnline()` guard, the per-lead try/catch loop, the `git clone` / `onboardDeepDiveProject` calls, and the `coverage.projects` / `coverageChanged` mutations, returning a boolean or the updated coverage so the caller can proceed. The remaining body of `nextCandidateFulfillmentTask` then contains only the local candidate-selection and draft-task-construction logic, which can itself be tightened or further split if it still exceeds the limit. The public signature of `nextCandidateFulfillmentTask` stays the same; the helper is module-private and called at the top of the function before the selection loop.

Benefits:
Each extracted piece becomes independently unit-testable: the onboarding helper can be tested with a mocked network layer and a stubbed `onboardDeepDiveProject` without exercising the selection path, and the selection logic can be tested with a pre-populated `coverage` object and no network at all. Code review diffs are scoped to one concern at a time, reducing the chance that a change to clone-retry semantics silently affects candidate ordering or vice versa. The main function shrinks to roughly 60–70 lines of single-purpose selection logic, bringing it back under the project's length budget and making the "return a task descriptor" contract visible at a glance.

### AC-9 · Extract markdown section parser and candidate selection from nextCandidateFulfillmentTask
Strength: Strong
Files: src/sdk/candidate-fulfillment.js
Snippet:
```
// (see this whole session's running theme of exactly that happening elsewhere).
function nextCandidateFulfillmentTask(candidatesPath, sourceName) {
  // lazy (see module header) -- task-sources.js is fully loaded by the time any
  // next() poll calls this.
  const { taskIdExistsInQueue } = require('../task-sources.js');
  const { defaultDomain } = getConfig();
  const text = readIfExists(candidatesPath);
  if (!text) return null;

  const sections = [];
  let pos = 0;
  while (pos < text.length) {
    const start = text.indexOf('### ', pos);
    if (start === -1) break;

    const nextH2 = text.indexOf('\n## ', start + 3);
    const nextH3 = text.indexOf('\n### ', start + 3);
    let end;
    if (nextH2 !== -1 && nextH3 !== -1) {
      end = Math.min(nextH2, nextH3);
    } else if (nextH2 !== -1) {
      end = nextH2;
    } else if (nextH3 !== -1) {
      end = nextH3;
    } else {
      end = -1;
    }

    const sectionText = end === -1 ? text.slice(start) : text.slice(start, end);
    sections.push(sectionText);
    pos = end === -1 ? text.length : end + 1;
  }
```

Problem:
`nextCandidateFulfillmentTask` spans 140 lines and interleaves three independently-testable responsibilities: a file-existence guard (`readIfExists(candidatesPath)` with an early `return null`), a self-contained markdown `###`-section parser (a `while (pos < text.length)` loop that tracks `nextH2`, `nextH3`, and section boundaries to push `sectionText` entries), and the downstream candidate-selection logic that filters sections by `sourceName`/`defaultDomain`, checks `taskIdExistsInQueue`, and assembles the final task object. Because the parser's four-way boundary logic (both H2 and H3 present, only one, neither, end-of-text sentinel) is entangled with the selection loop, a change to header-matching rules forces a reviewer to re-read the entire 140-line body, and unit-testing malformed markdown (missing H2, nested H3, empty trailing section) requires invoking a function whose primary contract is "return the next fulfillable task or null."

Solution:
Extract two pure helpers from the body of `nextCandidateFulfillmentTask`. First, `parseCandidateSections(markdownText)` — a standalone function that takes the raw file text and returns an array of `{ heading, body }` objects by walking the `###`/`##` boundary logic; it has no dependency on `sourceName`, `defaultDomain`, or the task queue. Second, `selectNextCandidate(sections, { sourceName, defaultDomain, queue })` — a function that receives the parsed sections plus the selection context and returns the next eligible task object or `null`, encapsulating the `taskIdExistsInQueue` check and domain filtering. The original `nextCandidateFulfillmentTask` then shrinks to a thin orchestrator: read the file, call `parseCandidateSections`, call `selectNextCandidate`, and return the result. Both helpers are pure (or near-pure) and can be exported for direct unit testing.

Benefits:
Each extracted helper can be tested in isolation with focused fixtures — the parser against a battery of malformed-markdown strings, the selector against various queue states and domain mismatches — without mocking the filesystem or constructing a full task-queue harness. Code review diffs become scoped: a change to header-matching rules touches only `parseCandidateSections`, while a change to queue-priority logic touches only `selectNextCandidate`. The orchestrator function drops to roughly 10–15 lines, making its control flow (read → parse → select → return) immediately legible at a glance.

### AC-10 · Decompose applyBrainDumpSort guard-and-classify monolith
Strength: Strong
Files: src/apply-group-a.js
Snippet:
```

function applyBrainDumpSort({ implementResponse, task, brainDumpPath, secondBrainDir, pipelineDir }) {
  const { brainDumpEntryId, rawText } = task.promptContext;

  const data = loadBrainDump(brainDumpPath);

  const entry = findEntry(data, brainDumpEntryId);
  if (!entry) {
    return { skipped: true, reason: `brain-dump entry "${brainDumpEntryId}" no longer exists (deleted since this task was drafted)` };
  }
  // The entry may have been edited (the dashboard's PUT resets status back to 'captured' on
  // a text change) or otherwise changed since this task was drafted -- classifying stale
  // text into the entry's CURRENT record would silently mislabel it under a rawText it no
  // longer has. Only apply if the entry is still exactly what this task was drafted against.
  if (entry.status !== 'captured' || entry.rawText !== rawText) {
    return { skipped: true, reason: 'brain-dump entry changed since this task was drafted -- not applying a stale classification' };
  }

  const result = parseBrainDumpSortResult(implementResponse);
  if (!result) {
    return { skipped: true, reason: 'implement pass did not return a valid classification -- entry left as captured for retry' };
  }
  if (!secondBrainDir) {
    return { skipped: true, reason: 'SECOND_BRAIN_DIR is not configured -- cannot file this entry anywhere' };
  }

  const namingError = validateSecondBrainPath(result.secondBrainPath, secondBrainDir);
  if (namingError) {
    return { skipped: true, reason: `rejected secondBrainPath "${result.secondBrainPath}": ${namingError} -- entry left as captured for retry` };
  }

  // Brain Dump #1 follow-up (2026-08-17): a note can be actionable WITHOUT being a code
```

Problem:
applyBrainDumpSort packs at least five independent guard/validation checks (entry-existence, entry-staleness, parse-validity, config-presence, path-legality) into a single linear block, each carrying its own domain rationale — the staleness justification alone spans four lines of explanatory comment. A trailing note ("a note can be actionable WITHOUT being a code…") signals that the remaining roughly 170 lines layer on at least one more orthogonal rule (actionable-vs-code classification) before the mechanical write-and-flip tail. The result is a ~200-line function where a reviewer must hold all five preconditions in working memory to evaluate any single change, and where the classification rule is buried between unrelated validation steps, making it invisible to anyone scanning for "where do we decide what counts as actionable?"

Solution:
Extract three clearly-named helpers from the body of applyBrainDumpSort. First, validateBrainDumpEntry(entry, config) — a pure predicate that returns a discriminated result (ok / stale / unparseable / missing-config / illegal-path) so the five guards live in one place with a single return contract. Second, classifyNoteActionability(parsedEntry) — isolates the "actionable vs. code" domain rule (and any sub-rules the trailing comment foreshadows) into a function whose name states the decision it makes, independent of file I/O. Third, persistAndFlip(entry, classification) — the mechanical write-file-and-update-status tail. applyBrainDumpSort itself then shrinks to a short orchestration: call validate, call classify, call persist, and propagate the result. Each helper is small enough to unit-test in isolation with a handful of fixtures.

Benefits:
A reviewer changing the staleness window now reads a 15-line predicate instead of hunting through 200 lines for the one `if` that matters. The classification rule becomes independently testable: you can assert "this note is actionable" or "this note is code" without mocking file-system calls or config plumbing. Because each helper has a single responsibility and a named contract, the main function reads as a three-line narrative (validate → classify → persist), which makes the overall flow obvious in code review and gives future contributors a clear insertion point when a sixth guard or a second classification sub-rule appears.

### AC-11 · Decompose reviewTask's layered orchestration
Strength: Strong
Files: src/review-task.js
Snippet:
```
 */
async function reviewTask(task, { repoRoot, pipelineDir, secondBrainDir, domainsPath, instancesDir, deepDiveCoveragePath, localMajorityVote = null, recordModelOutcome = defaultRecordModelOutcome } = {}) {
  // Resolved here rather than as a static default param, same reasoning as
  // local-draft.js's draftTask() -- the right backend depends on the task's reasoning
  // tier, only known once the task object is in hand. Passing the whole task (not just
  // task.source) lets a per-instance task.reasoningTier override take effect. An explicit
  // caller override always wins.
  // 2026-08-24 (model-profile-registry.js): same pattern as local-draft.js's own
  // resolvedLocalCall wrapping -- when the task's own source declares a modelProfile,
  // its overrides become defaults spread BEFORE the real majorityVote() call below (opts
  // spread after wins, though the one real call site doesn't set model/numCtx/numPredict/
  // effort/timeoutMs itself today, so the profile's values reliably take effect). Passing
  // both local-only (numCtx/numPredict) and claude-only (effort/timeoutMs) keys
  // unconditionally is safe -- whichever backend's majorityVote() runs only destructures
  // the params it recognizes, ignoring the rest. Skipped for an injected
  // localMajorityVote (test/caller override), same as local-draft.js.
  const modelProfile = resolveModelProfile(task);
  const profileOverrides = modelProfile
    ? {
      model: modelProfile.model, numCtx: modelProfile.numCtx, numPredict: modelProfile.numPredict,
      effort: modelProfile.effort, timeoutMs: modelProfile.timeoutMs,
    }
    : null;
  // 2026-08-27, Grimmethy: "Review should never be gated behind claude. Please allow
  // the local model to review them" -- ALWAYS the local backend, never providerFor(task)
  // (which would route a high-reasoning-tier task to Claude). Root-caused live: this
  // review call had, in practice, ALREADY always run local regardless of tier -- nothing
  // in review-task.js's own require graph ever loaded task-sources.js, so
  // providerFor()'s tier lookup silently saw an empty registry and defaulted to local
  // every time -- but review-runner.sh's separate bash-side pre-check DID load that
  // registry (to compute its own Claude-budget gate), correctly saw a high-tier task,
  // and skipped it whenever Claude was paused/rate-limited: a real task that would have
```

Problem:
reviewTask is a 276-line async function that bundles at least three independently testable concerns behind a single entry point: resolving model-profile overrides from task.source, deciding which backend callable to invoke (the 2026-08-27 "always local" rule versus the legacy providerFor path, plus the localMajorityVote injection), and then performing the majorityVote call followed by outcome recording. The parameter surface—task plus eight destructured options including six filesystem paths, an injectable model stub, and an injectable recorder—confirms this is an orchestration function, not a single linear task. Because the three concerns are interleaved with conditional branching (the modelProfile ternary, the injected-override path, the dated backend-routing decision), a regression in any one layer is only observable by exercising the entire 276-line body, and a reader cannot hold the full control flow in working memory.

Solution:
Extract two cohesive helpers from reviewTask, leaving the remainder as a short orchestration shell. First, pull the profile-resolution and backend-selection logic—reading task.source's declared profile, building the overrides object, applying the 2026-08-27 local-backend rule, and honouring the localMajorityVote injection—into a pure function resolveReviewBackend(task, { localMajorityVote }) that returns { callable, profileOverrides }. Second, pull the call-and-record sequence—invoking the resolved callable with the resolved overrides, then calling recordModelOutcome with the result—into a thin wrapper executeAndRecord(callable, profileOverrides, task, { recordModelOutcome }). The remaining reviewTask body then reads as resolve, execute, return—roughly thirty to forty lines—with each extracted helper independently unit-testable without touching the filesystem or the model.

Benefits:
Each extracted helper has a single, clearly-named responsibility and a small parameter list, so a reviewer can verify the routing rule or the profile-resolution logic in isolation without scrolling through 276 lines. Unit tests for resolveReviewBackend need no filesystem fixtures because the function is pure given task.source, and tests for executeAndRecord can mock the callable and the recorder independently. The orchestration shell becomes a readable three-step sequence, making it straightforward to add a future step (such as a post-review cache write) without further inflating an already-long function.

### AC-12 · Split renderMarkdown's fused aggregation-and-rendering pipeline
Strength: Strong
Files: src/system-report.js
Snippet:
```

function renderMarkdown({ period, startIso, endIso, tasks, downtime, timeAccounting, queueHealth, selfAuditActivity, blockedPatterns }) {
  const bySource = {};
  const byClassification = { junk: 0, benefit: 0, filtering: 0, housekeeping: 0, unclear: 0 };
  for (const t of tasks) {
    bySource[t.source || 'unknown'] = (bySource[t.source || 'unknown'] || 0) + 1;
    byClassification[t.classification] = (byClassification[t.classification] || 0) + 1;
  }

  const lines = [];
  lines.push(`# ${period[0].toUpperCase()}${period.slice(1)} Report — ${fmtLocal(startIso)} to ${fmtLocal(endIso)}`);
  lines.push('');
  lines.push(`**Tasks completed:** ${tasks.length}`);
  lines.push('');

  lines.push('## Summary');
  lines.push(buildPlainEnglishSummary({ period, tasks, byClassification, blockedPatterns, downtime, timeAccounting }));
  lines.push('');

  lines.push('## By Source');
  for (const [source, count] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${source}: ${count}`);
  }
  lines.push('');

  lines.push('## Junk vs. Benefit (by task count)');
  lines.push(`- Benefit: ${byClassification.benefit}`);
  lines.push(`- Signal-filtering (correctly dismissed false positives): ${byClassification.filtering}`);
  lines.push(`- Housekeeping: ${byClassification.housekeeping}`);
  lines.push(`- Junk (blocked / confirmed-bad): ${byClassification.junk}`);
  if (byClassification.unclear) lines.push(`- Unclear (not classified): ${byClassification.unclear}`);
  lines.push('');
```

Problem:
`renderMarkdown` is 137 lines long not because it is a long string template, but because it interleaves at least two distinct responsibilities in a single linear body: (1) data transformation—two aggregation loops over `tasks` that build `bySource` and `byClassification` counters, a `.sort` on the source map, and a conditional branch on `byClassification.unclear`—and (2) section-by-section rendering of five or six heterogeneous report blocks (Summary, By Source, Junk-vs-Benefit, Downtime, Queue Health, Self-Audit, Blocked Patterns), each with its own formatting rules and conditionals. Because the aggregation step feeds directly into `buildPlainEnglishSummary` and into the per-section `lines.push` calls, a reader must hold the entire compute-then-render pipeline in working memory to understand why any given line of output looks the way it does, and a change to the aggregation logic (e.g., adding a new classification bucket) forces the reviewer to scan all 137 lines to confirm no rendering section silently depends on the old shape.

Solution:
Extract the pure data-transformation prefix into a small helper, e.g. `aggregateTaskStats(tasks)`, that returns `{ bySource, byClassification, sortedSources }` and contains the two loops, the sort, and the `unclear` flag. Then break the rendering body into one clearly-named function per report section—`renderSummarySection`, `renderBySourceSection`, `renderJunkVsBenefitSection`, `renderDowntimeSection`, `renderQueueHealthSection`, `renderSelfAuditSection`, `renderBlockedPatternsSection`—each accepting the pre-computed stats object (and any section-specific parameters) and returning an array of markdown lines. `renderMarkdown` itself shrinks to a thin orchestrator: call `aggregateTaskStats`, call `buildPlainEnglishSummary` with the result, then concatenate the per-section line arrays. Each extracted function is small enough to unit-test in isolation with a fixed stats fixture, and the conditional branching (e.g., the `unclear` guard) lives next to the section it affects rather than being buried mid-function.

Benefits:
Readability improves because a reviewer can verify a single section's formatting logic in 15–25 lines instead of scanning 137; the aggregation logic becomes independently testable (feed a synthetic `tasks` array, assert the shape of `bySource`/`byClassification`) without exercising any rendering code; and future changes—adding a new classification bucket, reordering sections, or swapping the sort criterion—are localized to one small function, reducing the chance of an accidental cross-section regression that the current monolithic body makes easy to miss in code review.

### AC-13 · Extract proxy request-handling pipeline into named sub-functions
Strength: Strong
Files: vendor/tokenfold/core/tokenfold/adapters/proxy.py
Snippet:
```
    @app.post("/v1/chat/completions")
    async def chat(request: Request):
        try:
            body = await request.json()
        except Exception:
            raw = await request.body()
            r = await client.post(f"{_upstream(request)}/chat/completions",
                                  content=raw, headers=_fwd_headers(request))
            return Response(r.content, r.status_code)

        mode_hdr = request.headers.get("x-tokenfold-mode")
        route_hdr = request.headers.get("x-tokenfold-route")
        if mode_hdr:
            eng.cfg.mode = mode_hdr.upper()
            eng.cfg.clamp()
        if route_hdr:
            eng.cfg.route_mode = route_hdr.lower()
            eng.cfg.clamp()

        model = body.get("model", "")
        messages = body.get("messages", [])
        sid_hdr = request.headers.get("x-tokenfold-session")
        scope_hdr = request.headers.get("x-tokenfold-scope")
        encoded, report = eng.encode(messages, model, session_id=sid_hdr, scope=scope_hdr)
        body["messages"] = encoded
        sid = report.session_id

        upstream = f"{_upstream(request)}/chat/completions"
        headers = _fwd_headers(request)
        headers["content-type"] = "application/json"

        if body.get("stream"):
```

Problem:
The 103-line proxy handler interleaves at least four distinct responsibilities in a single flat body: (1) deserializing the inbound request with a raw-body fallback on JSON-parse failure, (2) reading per-request configuration overrides from HTTP headers and clamping them into the session object, (3) performing the core token-fold encoding (session/scope extraction, token mapping, response shaping), and (4) branching into a streaming path that builds a chunked response iterator. Each concern has its own try/except surface, its own early-return conditions, and its own set of unit-test cases, yet they all share one indentation level and one local-variable namespace. A developer fixing the streaming branch must scroll past the header-clamping logic to find it; a developer adding a new config header must reason about whether it interacts with the token-encoding step. The length is not a line-count artifact—it is four mini-functions glued together by shared mutable state.

Solution:
Split the handler into four private helpers called sequentially from a thin orchestrator. First, `_parse_inbound(raw_body, content_type) -> dict` encapsulates the JSON-parse-with-fallback and returns a normalized payload dict (or raises a typed `MalformedRequestError`). Second, `_apply_header_overrides(headers, session) -> None` reads the two (or more) config headers, clamps values, and mutates the session object in place. Third, `_encode_tokens(payload, session) -> EncodedResponse` contains the actual token-fold mapping logic—session/scope extraction, token substitution, and response dict construction. Fourth, `_build_stream_response(payload, session)` returns the async generator / chunked iterator for the `stream: true` path. The public handler becomes roughly 15 lines: parse, override, then either call `_encode_tokens` and return a JSON response, or call `_build_stream_response` and return the streaming response. Each helper is independently importable and testable.

Benefits:
Each extracted helper can be unit-tested in isolation with a minimal fixture (a dict in, a dict out) without standing up the full proxy transport. Code review diffs shrink: a change to header clamping no longer appears in the same hunk as a change to token mapping. The streaming branch, which is the most complex and most likely to change, becomes a single named function whose signature documents its contract. New contributors can read the 15-line orchestrator to understand the request lifecycle at a glance, then drill into whichever helper is relevant to their task.

### AC-14 · Decompose `_encode` orchestrator into single-responsibility pipeline stages
Strength: Strong
Files: vendor/tokenfold/core/tokenfold/core/encoder.py
Snippet:
```
    # ------------------------------------------------------------------
    def _encode(self, messages: list[dict], model: str, prof,
                report: EncodeReport, t0: float,
                session_id: str | None = None,
                provider: str = "") -> tuple[list[dict], EncodeReport]:
        cfg = self.cfg
        sid = session_id or session_id_for(messages)
        report.session_id = sid
        session = Session(sid)
        session.turn += 1

        if cfg.mode == "OFF":
            report.original_tokens = report.encoded_tokens = self._count_all(messages, prof)
            report.latency_ms = (time.perf_counter() - t0) * 1000
            return messages, report

        # Tiny requests can never clear the min-savings thresholds: the full
        # pipeline runs only to have the never-larger invariant revert it,
        # which burned latency AND stamped fallback=True — live metrics showed
        # a cluster of 5–35 token requests inflating fallback_pct with what is
        # really just correct "nothing to do here" behavior. Skip early.
        total_tok = self._count_all(messages, prof)
        if total_tok < cfg.min_encode_tokens:
            # Learning must NOT be gated with the pipeline: short boilerplate
            # repeated across many tiny requests is exactly what the nursery
            # exists to notice. Same observe step the candidate search runs.
            for m in messages:
                if m.get("role") in ("user", "system"):
                    try:
                        skel, _regs = protected.extract(self._text(m))
                        terse = phrases.compress(skel)
                    except Exception:
```

Problem:
The `_encode` function spans roughly 355 lines and interleaves at least four distinct concerns in a single control-flow body: session bookkeeping (sid derivation, turn increment), OFF-mode early-exit, a sub-threshold branch that still performs nursery learning via `protected.extract` and `phrases.compress`, and the full encoding pipeline with candidate search, a never-larger invariant check that can revert prior work, and fallback stamping. The inline comments confirm these are not sequential steps but *interacting invariants*—learning must run on a subset of paths regardless of pipeline outcome, the never-larger check can undo compression, and fallback bookkeeping must fire only after a revert. This branching-plus-side-effect topology makes the function genuinely hard to review, reason about, or test in isolation; a single regression in one branch (e.g., forgetting to call `phrases.compress` on the tiny-request path) is invisible until integration tests catch it, and the 355-line body gives a reviewer no structural anchor.

Solution:
Extract five helpers from the body of `_encode`, each with a single entry/exit contract: (1) `_resolve_session(messages, session_id) -> Session` handling sid derivation and turn increment; (2) `_early_exit_off(messages, prof, report, t0)` for the OFF-mode count-and-return path; (3) `_observe_tiny(messages, prof)` encapsulating the nursery learning step (`protected.extract` + `phrases.compress`) that must run on sub-threshold requests independent of the pipeline; (4) `_run_pipeline(messages, model, prof, session, cfg)` containing candidate search, compression, the never-larger invariant check, and its revert logic; and (5) `_apply_fallback(messages, report, session)` for the revert-and-stamp `fallback=True` transition. The remaining `_encode` becomes a 30–50-line orchestrator that calls these in order, wires report fields, and owns only the top-level try/except and timing.

Benefits:
Each extracted helper can be unit-tested with a stub `prof`/`cfg` and a fixed message list, eliminating the need for full-pipeline integration tests to verify, say, that the tiny-request path still calls `phrases.compress`. Code review becomes tractable because a reviewer can assess the never-larger invariant in `_run_pipeline` without scrolling past session bookkeeping and OFF-mode logic. The orchestrator reads as a top-down narrative of pipeline stages, making it immediately obvious which branch a new requirement (e.g., a third early-exit mode) belongs in, and reducing the risk that a future edit to one concern accidentally breaks an invariant in another.

### AC-15 · Extract parseCandidateSections from nextCandidateFulfillmentTask
Strength: Strong
Files: src/sdk/candidate-fulfillment.js

Problem:
The nextCandidateFulfillmentTask function inlines a ~20-line while-loop that walks a markdown string, finds `### ` headings, determines each section's end boundary (next `\n## ` or `\n### `), and pushes raw section strings into a local `sections` array. This parsing logic is tangled together with the candidate-selection business logic that follows, making it impossible to unit-test the section-boundary logic in isolation or reuse it if another consumer needs the same `###`-section split.

Solution:
Define a new function `parseCandidateSections(text)` immediately above `nextCandidateFulfillmentTask`. It takes the raw markdown string and returns the `sections` array (array of strings, each starting at a `### ` heading and ending just before the next `\n## ` or `\n### ` heading, or at end-of-string). Move the entire while-loop body (from `const sections = []; let pos = 0;` through `pos = end === -1 ? text.length : end + 1;`) into this new function. In `nextCandidateFulfillmentTask`, replace that inline loop with a single call: `const sections = parseCandidateSections(text);`. No other lines in the function are touched.

Benefits:
The markdown-section parser is now independently testable (feed a synthetic multi-section string, assert boundaries). The main function's body shrinks by ~20 lines, making the selection logic that follows easier to read in context. Pure extraction—zero behavior change.

### AC-16 · Extract selectNextCandidate from nextCandidateFulfillmentTask
Strength: Strong
Files: src/sdk/candidate-fulfillment.js

Problem:
After the section-parsing loop, nextCandidateFulfillmentTask contains a long for-loop (~100 lines) that: filters sections by AC-ID presence, Strength: Strong, length cap, placeholder-body detection; checks taskIdExistsInQueue; assembles the task object (title, filesArray, fetchedFiles via fs.readFileSync, promptContext); and returns the first qualifying candidate or null. This selection/assembly logic is the bulk of the function and depends on taskIdExistsInQueue, getConfig (defaultDomain, repoRoot), path, and fs—making the function hard to test without the full module context and impossible to reuse for a different candidate doc shape.

Solution:
Define a new function `selectNextCandidate(sections, deps)` immediately above `nextCandidateFulfillmentTask` (or below `parseCandidateSections`). `deps` is an object `{ taskIdExistsInQueue, defaultDomain, sourceName, repoRoot }` passed in from the caller. Move the entire for-loop and all code after it (from `for (const section of sections) {` through the function's final return) into this new function, replacing the direct `require('../task-sources.js')` call and `getConfig()` calls with the corresponding `deps` fields. The function returns the assembled task object or `null`. In `nextCandidateFulfillmentTask`, replace the inline selection logic with: `return selectNextCandidate(sections, { taskIdExistsInQueue, defaultDomain, sourceName, repoRoot: getConfig().repoRoot });`. The lazy `require` for `taskIdExistsInQueue` and the `getConfig()` call for `defaultDomain` remain in `nextCandidateFulfillmentTask` (or move to the caller) and are passed via `deps`. No other lines are touched.

Benefits:
The selection/assembly logic is now independently testable with a fixed `sections` array and stubbed `deps` (no fs, no require). The main function becomes a thin 5-line orchestrator: read file → parse sections → select → return. The `deps` injection makes it trivial to test the placeholder-rejection, queue-dedup, and fetchedFiles paths without a real repo. Pure extraction—zero behavior change.

### AC-17 · Decompose get-grounding-source main() into input, config, and context builders
Strength: Strong
Files: src/get-grounding-source.js
Snippet:
```

function main() {
  const taskPath = process.argv[2];
  const task = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
  const pc = task.promptContext;
  const parts = [];

  // Resolved once, used both to refresh fetchedFiles below and for the adhoc live-fetch
  // block further down. Fails open (getConfig() can throw if AGENT_MANAGER_REPO_ROOT is
  // unset -- a context/test-environment gap, not a reason to fail this whole grounding
  // assembly) same as reasoningTierFor()'s own established try/catch treatment of the
  // identical getConfig() call.
  let repoRoot = null;
  try {
    ({ repoRoot } = getConfig());
  } catch (e) {
    console.warn(`[get-grounding-source] getConfig() failed, repoRoot will remain null: ${e?.message ?? e}`);
  }

  if (pc) {
    if (pc.existingStub) parts.push(String(pc.existingStub));
    if (pc.siblingExample && pc.siblingExample.content) parts.push(String(pc.siblingExample.content));
    if (pc.goalMdFull) parts.push(String(pc.goalMdFull));
    if (pc.csvRow) parts.push(JSON.stringify(pc.csvRow));
    if (pc.body) parts.push(String(pc.body));
    if (pc.noteContent) parts.push(String(pc.noteContent));
    if (pc.files) {
      for (const f of [].concat(pc.files)) {
        if (f.content) parts.push(String(f.content));
      }
    }
    // 2026-08-27, root-caused live via 3 real blocked observability_fix candidates
```

Problem:
The 111-line `main()` in `src/get-grounding-source.js` interleaves at least four distinct responsibilities—CLI argument and JSON-file parsing, config resolution with a documented fail-open policy (the `try { ({repoRoot} = getConfig()) } catch {…}` block and its six-line explanatory comment), static `promptContext` assembly (the `if (pc.existingStub) parts.push(…)` / `if (pc.files) { for … }` block spanning roughly fifteen lines of parallel conditional pushes), and the core grounding-source computation itself. Because these concerns are sequenced inline in one function, a reader must track local-variable lifetimes across all four phases, the fail-open policy is buried mid-function rather than visible at the call site, and any change to the context-assembly rules (e.g., adding a new `pc` field) requires editing the same block that also owns argument validation, making the diff surface larger and the review harder than the logical change warrants.

Solution:
Extract three small, clearly-named helpers that `main()` calls in sequence. First, `readGroundingRequest(argv)` encapsulates `process.argv[2]` handling, the `fs.readFileSync` + `JSON.parse` call, and basic shape validation, returning a plain request object. Second, `resolveRepoRoot()` wraps the `getConfig()` call in its own `try/catch`, owns the six-line comment explaining the fail-open rationale and its mirror of `reasoningTierFor()`, and returns either the resolved root or a sentinel (e.g., `null`) that the caller can branch on. Third, `buildPromptContext(pc, repoRoot)` takes the parsed `pc` field and the resolved root and returns the fully-assembled `parts` array, keeping all the `if (pc.existingStub)` / `if (pc.files)` / loop logic in one place. `main()` then shrinks to roughly twenty lines: call the three helpers, perform the actual grounding-source work, and emit the result.

Benefits:
Each extracted helper is independently unit-testable (feed a fake `argv`, a stubbed `getConfig`, or a synthetic `pc` object without invoking the full CLI path), the fail-open policy becomes a one-line call whose contract is documented at the helper's JSDoc rather than hidden in a mid-function comment, and future additions to the prompt-context rules (new `pc` fields, new conditional branches) are localized to `buildPromptContext` with zero risk of accidentally reordering the config-resolution or argument-parsing steps. Review diffs for any single concern become smaller and easier to verify, and the function's overall shape—parse, resolve, build, compute—reads as a table of contents rather than a wall of interleaved logic.

### AC-18 · Decompose runPlanWithTools into orchestrator + focused helpers
Strength: Strong
Files: src/local-tool-client.js
Snippet:
```

async function runPlanWithTools({ prompt, messages: reqMessages, maxTurns = 5, source, allowWrite = false, onChunk, primaryRoot, extraRoots = [], forceSummaryOnCap = false, nudgeToEditEarly = false, leafMustEdit = false }) {
  const { pipelineDir, repoRoot } = getConfig();
  // allowWrite=true (Chat panel only) checks its OWN kill switch, separate from
  // arch_discovery's -- see WRITE_TOOLS' own header for why these must stay independent.
  const killSwitchPath = path.join(pipelineDir, 'queue',
    allowWrite ? '.chat-write-tools-disabled' : '.arch-discovery-tools-disabled');
  if (fs.existsSync(killSwitchPath)) {
    return runWithoutToolsFallback(prompt, pipelineDir);
  }

  // Multi-root (2026-08-31, system-wide Chat panel): the caller may thread its own
  // primary root + a list of additional accessible repo roots. Every non-chat caller
  // passes neither, so allowedRoots is just [repoRoot] and every tool behaves exactly
  // as it did before. Deduped on realpath, primary first.
  const rawRoots = [primaryRoot || repoRoot, ...(Array.isArray(extraRoots) ? extraRoots : [])];
  const seen = new Set();
  const allowedRoots = [];
  for (const r of rawRoots) {
    let real;
    try { real = fs.realpathSync(r); } catch { continue; }
    if (!seen.has(real)) { seen.add(real); allowedRoots.push(real); }
  }
  if (allowedRoots.length === 0) allowedRoots.push(path.resolve(repoRoot));

  const tools = withGrepDirsHint(allowWrite ? [...TOOLS, ...WRITE_TOOLS] : TOOLS);
  const toolHandlers = allowWrite
    ? { ...buildToolHandlers(allowedRoots), ...buildWriteToolHandlers(allowedRoots) }
    : buildToolHandlers(allowedRoots);
  // 2026-08-24 -- caught live via the Chat panel's first real message: this loop's own
  // /api/chat calls had NO coordination with worker-1/reviewer's use of the same single
  // resident Ollama model, the exact uncoordinated-contention bug the Discuss-side lock
```

Problem:
The ~202-line body of `runPlanWithTools` interleaves at least five independently-testable responsibilities—kill-switch gating, multi-root resolution and deduplication, tool/handler assembly, the multi-turn LLM agent loop, and three flag-driven behavioural modifiers (`forceSummaryOnCap`, `nudgeToEditEarly`, `leafMustEdit`)—into a single function with an 11-parameter destructured signature. Because the conditional axes (`allowWrite`, kill-switch state, root count, each behavioural flag) multiply the effective path count and the stateful loop makes operation ordering significant, a change to any one concern (e.g., adding a new root-resolution edge case or tweaking the summary-on-cap policy) forces the reviewer to trace the entire 202-line body, raising the risk of unintended interaction with the other concerns.

Solution:
Extract four focused helpers and reduce the original to a thin orchestrator. First, `resolveAllowedRoots(primaryRoot, extraRoots, repoRoot)` encapsulates the `rawRoots → realpath → Set → allowedRoots` pipeline including the empty-result fallback, making it a pure, trivially unit-testable function. Second, `buildToolSet(allowWrite, allowedRoots)` returns the correct `TOOLS`/`WRITE_TOOLS` spread plus the two `build*ToolHandlers` results. Third, `checkKillSwitch(allowWrite, pipelineDir)` returns a boolean so the early-return policy is a one-liner in the orchestrator. Fourth, `executeAgentLoop({ prompt, messages, maxTurns, tools, toolHandlers, onChunk, forceSummaryOnCap, nudgeToEditEarly, leafMustEdit, source })` contains the actual LLM-call → parse-tool-calls → execute → append-messages → repeat cycle, with the three flag modifiers applied as small per-turn policy functions (`applySummaryOnCap`, `applyNudgeToEdit`, `applyLeafMustEdit`) called at the appropriate point in the loop. The orchestrator `runPlanWithTools` then shrinks to roughly 30–40 lines: destructure params, call the three setup helpers, and delegate to `executeAgentLoop`.

Benefits:
Each extracted function can be unit-tested in isolation—feed `resolveAllowedRoots` unresolvable or duplicate paths, toggle `allowWrite` in `buildToolSet`, or simulate a malformed tool-call JSON in `executeAgentLoop`—without spinning up the full agent loop or mocking the LLM transport. Code review becomes tractable because a PR touching root-resolution logic no longer requires reading the 170-line loop body, and vice versa. The 11-parameter "god entry point" smell is reduced to a short orchestrator that reads as a table of contents, making it obvious which concern owns which parameter and where a new flag should be threaded through.

### AC-19 · Decompose the multi-branch task-queue dispatcher in apply-group-a.js
Strength: Strong
Files: src/apply-group-a.js
Snippet:
```
}

function applyBrainDumpSort({ implementResponse, task, brainDumpPath, secondBrainDir, pipelineDir }) {
  const { brainDumpEntryId, rawText } = task.promptContext;

  const data = loadBrainDump(brainDumpPath);

  const entry = findEntry(data, brainDumpEntryId);
  if (!entry) {
    // Terminal: the entry is gone, there is nothing to regenerate.
    return { skipped: true, reason: `brain-dump entry "${brainDumpEntryId}" no longer exists (deleted since this task was drafted)` };
  }
  // The entry may have been edited (the dashboard's PUT resets status back to 'captured' on
  // a text change) or otherwise changed since this task was drafted -- classifying stale
  // text into the entry's CURRENT record would silently mislabel it under a rawText it no
  // longer has. Only apply if the entry is still exactly what this task was drafted against.
  if (entry.status !== 'captured' || entry.rawText !== rawText) {
    return recoverableSortSkip(data, entry, brainDumpPath,
      'brain-dump entry changed since this task was drafted -- a fresh sort will classify the current text');
  }

  if (!secondBrainDir) {
    // Terminal: no vault configured, no retry will help.
    return { skipped: true, reason: 'SECOND_BRAIN_DIR is not configured -- cannot file this entry anywhere' };
  }

  const result = parseBrainDumpSortResult(implementResponse);
  if (!result) {
    return recoverableSortSkip(data, entry, brainDumpPath,
      'implement pass did not return a valid classification JSON');
  }

  const trackedLabels = readProjectRegistry().map((p) => p.label).filter(Boolean);
  const namingError = validateSecondBrainPath(result.secondBrainPath, secondBrainDir, trackedLabels);
  if (namingError) {
    return recoverableSortSkip(data, entry, brainDumpPath,
      `rejected secondBrainPath "${result.secondBrainPath}": ${namingError}`);
  }

  // Deterministic belongsToProject recovery -- the classifier routinely leaves this null
  // for a note that is plainly a concrete change to this pipeline's own code (the dominant
  // failure of the blocked backlog). May also flip actionable true.
  {
    const derived = deriveBelongsToProject(result, task.promptContext);
    result.belongsToProject = derived.belongsToProject;
    result.actionable = derived.actionable;
  }

  // Brain Dump #1 follow-up (2026-08-17): a note can be actionable WITHOUT being a code
  // change -- "investigate X, document findings" needs real web research, not a diff
  // against any tracked project. Only when NO tracked project was named/recovered -- a
  // note tied to a project routes to that project's queue below, never to research.
  if (result.requiresResearch && !result.belongsToProject) {
    if (!pipelineDir) {
      return { skipped: true, reason: 'no pipelineDir available -- cannot queue a research task' };
    }
    const queuedId = `research-brain-dump-${brainDumpEntryId}-${Date.now()}`;
    const researchTask = {
      id: queuedId,
      domain: 'research',
      source: 'research_task',
      title: rawText.slice(0, 120),
      promptContext: { rawText, brainDumpEntryId, secondBrainPath: result.secondBrainPath, tags: result.tags },
    };
    const researchDir = path.join(pipelineDir, 'queue', 'research');
    fs.mkdirSync(researchDir, { recursive: true });
    writeJsonAtomicSync(path.join(researchDir, `${queuedId}.json`), researchTask);

    // Same audit-trail cross-reference convention the adhoc branch below already uses --
    // an entry findable in the note it will eventually gain real content in, not the
    // record of truth (brain-dump.json's queuedTaskId/queuedAt is that).
    const fullPath = path.join(secondBrainDir, result.secondBrainPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    appendMarkdownLineAtomic(fullPath, `\n- **${stamp}** Queued as research task \`${queuedId}\` -- ${rawText}\n`);

    entry.status = 'actioned';
    entry.queuedTaskId = queuedId;
    entry.queuedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(brainDumpPath), { recursive: true });
    writeJsonAtomicSync(brainDumpPath, data);

    return { file: fullPath, queuedTaskId: queuedId, researchQueued: true };
  }

  // A note naming a tracked project IS work -- queue a real adhoc task in that project's
  // own queue. The old `result.actionable &&` precondition is dropped (2026-09-03, user:
  // "a note describing a concrete change to a tracked project always becomes a work task"):
  // a project-labelled note the classifier forgot to mark actionable is still a task, and
  // deriveBelongsToProject already forces actionable when it recovers a self-project label.
  const matchedProject = result.belongsToProject
    ? readProjectRegistry().find((p) => p.label === result.belongsToProject)
    : null;

  if (result.belongsToProject && !matchedProject) {
    // reviewBrainDumpSort should have blocked a non-tracked label; if one slipped through,
    // don't silently downgrade it to a passive note -- that masks the misclassification.
    return recoverableSortSkip(data, entry, brainDumpPath,
      `belongsToProject "${result.belongsToProject}" does not match any registered project -- a corrected pass should name a tracked label or null`);
  }

  if (matchedProject) {
    const validDomains = (() => {
      try {
        return Object.keys(JSON.parse(fs.readFileSync(matchedProject.domainsPath, 'utf8')));
      } catch {
        return [];
      }
    })();

    if (validDomains.includes('adhoc')) {
      const queuedId = `adhoc-brain-dump-${brainDumpEntryId}-${Date.now()}`;
      const adhocTask = {
        id: queuedId,
        domain: 'adhoc',
        source: 'brain_dump',
        title: rawText.slice(0, 120),
        promptContext: { rawText, brainDumpEntryId },
      };

      // Path-prefetch (context-aware-file-path-prefetch-job.md, 2026-08-16): resolve
      // anchor keywords from this task's title/rawText against the target project's own
      // dependency graph BEFORE it's ever claimed for drafting, so the plan/implement
      // passes already have real, validated file paths in promptContext instead of the
      // model searching for them (or worse, inventing them) from scratch on every call.
      // 'greenfield' (no graph built yet for this project) is explicitly NOT an error --
      // per the Discuss session's own note, that's just "nothing to prefetch," and the
      // task queues normally. 'no-match'/'ambiguous' are the two cases the Grill Me/
      // Discuss sessions asked to be held for a human rather than silently guessed at:
      // written to queue/needs-clarification/ instead of queue/adhoc/, invisible to
      // nextAdhocTask() (which only ever scans queue/adhoc/) until a human resolves it
      // via the dashboard.
      // graphPathOverride via config.js's resolveGraphPath() (not path-prefetch.js's own
      // graphify-out/graph.json default) -- confirmed live 2026-08-16: the dashboard's
      // Build Graph button writes to .agent-manager-cache/, not graphify-out/, so without
      // this override every real project's graph looked absent ('greenfield') even after
      // a real build, and this fast path silently never matched anything.
      const anchorResult = resolveAnchors({
        repoRoot: matchedProject.repoRoot,
        title: adhocTask.title,
        rawText,
        graphPathOverride: resolveGraphPath(matchedProject.repoRoot),
        // uiVocabHubFiles (2026-08-20, see path-prefetch.js's UI_VOCAB header): opt-in
        // per project in projects.json -- a project with no UI hub file(s) declared here
        // simply never triggers the fallback, same behavior as before this existed.
        uiVocabHubFiles: matchedProject.uiVocabHubFiles || [],
      });
      let adhocDir = path.join(matchedProject.pipelineDir, 'queue', 'adhoc');
      if (anchorResult.status === 'matched') {
        adhocTask.promptContext.prefetchedPaths = anchorResult.paths;
      } else if (anchorResult.status === 'no-match') {
        adhocDir = path.join(matchedProject.pipelineDir, 'queue', 'needs-clarification');
        adhocTask.needsClarification = { reason: 'no-match' };
      } else if (anchorResult.status === 'ambiguous') {
        adhocDir = path.join(matchedProject.pipelineDir, 'queue', 'needs-clarification');
        adhocTask.needsClarification = { reason: 'ambiguous', candidates: anchorResult.candidates };
        if (anchorResult.paths.length > 0) adhocTask.promptContext.prefetchedPaths = anchorResult.paths;
      }
      // 'greenfield': adhocTask left exactly as constructed above, queues normally with
      // no prefetchedPaths field at all -- there is nothing to prefetch from yet.

      // 2026-08-24 (pipeline hardening, Grimmethy: "duplicate-task detection before
      // filing") -- brainDumpSortPlanPrompt/ImplementPrompt already showed the classifier
      // every currently-queued task title and asked it to flag a real match. Overrides
      // whatever the anchor-resolution logic above decided (even a confident path match
      // isn't worth drafting if the whole task is a duplicate) -- held for a human via the
      // SAME multiple-choice/free-text picker the "needs a human decision" adhoc path
      // already uses (adhoc-agentic-draft.js's RESOLUTION: needs-human-decision), not a
      // new UI: no structured options here since this is really a binary "is this real"
      // call the existing generic Archive button on every needs-clarification row (for
      // "yes, duplicate") plus the free-text Other box (for "no, here's why not") already
      // fully cover.
      if (result.possibleDuplicateOf) {
        adhocDir = path.join(matchedProject.pipelineDir, 'queue', 'needs-clarification');
        adhocTask.needsClarification = {
          reason: 'design-decision',
          openQuestions: (
            `This brain-dump note was flagged as a possible duplicate of an already-` +
            `queued task:\n\n  "${result.possibleDuplicateOf}"\n\n` +
            `NOTE (this task's own text): ${rawText}\n\n` +
            'If this genuinely is the same underlying feature/fix, use the Archive ' +
            'button on this row instead of answering below. If it is NOT actually a ' +
            'duplicate (different scope, different project, coincidental overlap), ' +
            'explain why in the box below and submit to send it to drafting.'
          ),
        };
      }

      adhocTask.generatedForRepoRoot = matchedProject.repoRoot;

      fs.mkdirSync(adhocDir, { recursive: true });
      writeJsonAtomicSync(path.join(adhocDir, `${queuedId}.json`), adhocTask);

      entry.status = 'actioned';
      entry.queuedTaskId = queuedId;
      entry.queuedAt = new Date().toISOString();
      fs.mkdirSync(path.dirname(brainDumpPath), { recursive: true });
      writeJsonAtomicSync(brainDumpPath, data);

      return { file: path.join(adhocDir, `${queuedId}.json`), queuedTaskId: queuedId, queuedProject: matchedProject.label };
    }
    // Matched a real project but it has no 'adhoc' domain -- a config gap that needs a
// ... [truncated for review: this function continues for 30 more line(s) not shown]
```

Problem:
The function is roughly 230 lines and inlines three to four complete mini-pipelines—guard/validation preamble, a research-task enqueue path, an adhoc-project-task enqueue path (itself containing a four-way `resolveAnchors` status switch plus a duplicate-detection override), and a fallback/passive-note tail—each with its own validation, I/O, data-shaping, and distinct return shape. A reader must hold the shared preamble variables, the branch-specific object construction, the atomic-write sequences, and the divergent return contracts all in working memory at once; the adhoc branch alone nests a `matched` / `no-match` / `ambiguous` / `greenfield` decision tree inside an `if (matchedProject)` block, making it the single hardest section to review or test in isolation.

Solution:
Extract four clearly-named helpers that sit alongside the dispatcher: (1) `validateAndLoadEntry(entryPath)` returning the parsed entry, config, and derived `belongsToProject` (the ~30-line preamble); (2) `enqueueResearchTask(entry, config, dataDir)` encapsulating the `researchTask` construction, `mkdirSync`, `writeJsonAtomicSync`, `appendMarkdownLineAtomic`, entry mutation, and the `{file, queuedTaskId, researchQueued}` return; (3) `enqueueAdhocProjectTask(entry, matchedProject, config, dataDir)` containing the domain-list validation, the `resolveAnchors` four-status switch, the duplicate-detection override, task write, entry mutation, and the `{file, queuedTaskId, queuedProject}` return; and (4) `handleFallbackOrPassiveNote(entry, config, dataDir)` for the truncated tail. The top-level function then shrinks to a thin dispatch: call the validator, branch on the entry's task type, delegate to the appropriate helper, and return its result.

Benefits:
Each extracted helper has a single, nameable responsibility and a uniform input/output contract, so unit tests can exercise the adhoc four-way anchor logic, the duplicate-override edge case, and the research-task write sequence independently without stubbing the other branches. Code review becomes a matter of reading one 20–40-line function at a time rather than tracking shared mutable state across 230 lines. The top-level dispatcher drops to roughly 20–30 lines of pure routing, making it trivial to verify that every branch is reached and that no branch accidentally falls through to the wrong return shape.

### AC-20 · Extract the decompose/coordinate branch from applyAdhocDiff
Strength: Strong
Files: src/apply-adhoc-diff.js
Snippet:
```
}

function applyAdhocDiff({ task, repoRoot, pipelineDir }) {
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

    return { files };
  } catch (e) {
    const detail = (e.stdout || e.stderr || e.message || '').toString().slice(0, 2000);
    throw new Error(`git apply failed: ${detail}`);
  } finally {
    try { fs.unlinkSync(patchPath); } catch (_) { /* best-effort cleanup */ }
  }
}
```

Problem:
The function runs ~120 lines and interleaves two distinct responsibilities: (1) the core "apply the diff to the working tree" sequence (staging, writing, committing) which is a natural atomic unit, and (2) a `decompose` branch (roughly lines 65–82) that performs no filesystem or git work at all, instead building a structurally different return shape (`{ coordinating: true, subTasks: [...] }`) by partitioning the incoming diff into sub-tasks. Because the two paths share only the initial argument-parsing prologue, they change for independent reasons: the decompose logic is driven by coordination-policy changes, while the apply sequence is driven by git/worktree mechanics. Keeping them in one function means every coordination-policy tweak forces a reviewer to re-read the entire apply path, and a regression in one branch is easy to miss when scanning the other.

Solution:
Extract the decompose branch into a standalone function, e.g. `buildDecomposedPlan(diff, options)`, that takes the already-parsed diff and returns the `coordinating` result object. The caller in `applyAdhocDiff` then becomes a short if/else: if the decompose path is triggered, delegate to `buildDecomposedPlan` and return its result; otherwise fall through to the existing apply sequence unchanged. No other lines move; the apply path stays intact as a single natural unit.

Benefits:
The main function drops to roughly 85–90 lines, well under the threshold, and each half can be unit-tested in isolation: `buildDecomposedPlan` can be tested with pure diff fixtures and no filesystem mocks, while the apply path continues to use its existing integration harness. Code review diffs for coordination-policy changes will no longer include the apply sequence, reducing reviewer cognitive load and the chance of an accidental edit to the git-staging logic.

### AC-21 · Extract per-outcome handlers from the review loop body
Strength: Strong
Files: src/auto-confirm-review.js
Snippet:
```
}

async function autoConfirmReview({ pipelineDir, repoRoot, grepDirs, majorityVote, candidatesPath }) {
  const summary = { checked: 0, confirmed: 0, denied: 0, escalated: 0, errors: 0 };
  if (process.env.AGENT_MANAGER_AUTO_CONFIRM_REVIEW === 'false') return summary;

  const dir = path.join(pipelineDir, 'queue', 'awaiting-confirm');
  const approvedDir = path.join(pipelineDir, 'queue', 'approved');
  const archiveDir = path.join(pipelineDir, 'queue', 'done', '_archived_no_action');
  const fixCandidatesPath = candidatesPath || (getConfig().pipelineFixCandidatesPath);

  let names;
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return summary; // no awaiting-confirm/ dir -- nothing to do
  }

  for (const name of names) {
    const file = path.join(dir, name);
    let task;
    try {
      task = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      summary.errors += 1;
      continue;
    }
    if (task.autoConfirmReviewedAt) continue; // already reviewed once -- left for a human

    summary.checked += 1;
    const isForensics = task.source === 'pipeline_forensics';
    const deleteItems = isForensics ? [] : parseDeleteItems(task.implementResponse);

    let prompt;
    let gateStamp;
    if (isForensics) {
      prompt = buildForensicsConfirmPrompt(task, readCandidatesDoc(fixCandidatesPath));
      gateStamp = 'forensicsReportConfirmedAt';
    } else if (deleteItems.length && batchContainsDeleteMode(task.implementResponse)) {
      const refMap = gatherDeleteReferences(repoRoot, grepDirs, deleteItems.map((i) => i.file));
      prompt = buildDeleteConfirmPrompt(task, deleteItems, refMap);
      gateStamp = 'deleteConfirmedAt';
    } else {
      // A hold we don't recognise -- don't guess. Leave it for a human, but stamp so we
      // don't re-check every tick.
      task.autoConfirmReviewedAt = new Date().toISOString();
      task.autoConfirmDecision = 'escalate';
      task.autoConfirmReviewNote = 'auto-confirm review does not recognise this hold type -- left for a human';
      appendHistoryEvent(task, 'advisory', task.autoConfirmReviewNote);
      try { fs.writeFileSync(file, JSON.stringify(task, null, 2)); summary.escalated += 1; }
      catch (err) {
        const taskId = task.id || (task.implementResponse ? task.implementResponse.slice(0, 8) : 'unknown');
        console.error(`[auto-confirm-review] escalate write failed: file=${file} task=${taskId} code=${err.code || ''} message=${err.message}`);
        summary.errors += 1;
      }
      continue;
    }

    let vote;
    try {
      vote = await majorityVote({
        prompt,
        classify: classifyVote(['CONFIRM', 'DENY'], 15),
        n: AUTO_CONFIRM_VOTES,
        minAgreeing: AUTO_CONFIRM_MIN_AGREEING,
        temperature: 0.2,
        source: task.source,
      });
    } catch (e) {
      // Every vote hard-failed (infra). Do NOT stamp -- next tick retries.
      appendHistoryEvent(task, 'advisory', `auto-confirm review could not run (${(e && e.message || 'vote error').slice(0, 160)}) -- will retry`);
      try { fs.writeFileSync(file, JSON.stringify(task, null, 2)); } catch { /* best-effort */ }
      summary.errors += 1;
      continue;
    }

    const now = new Date().toISOString();
    if (vote.confident && vote.verdict === 'CONFIRM') {
      const reason = voteReason(vote, 'CONFIRM');
      task[gateStamp] = now; // 'forensicsReportConfirmedAt' or 'deleteConfirmedAt' -- the field apply-task.js's gate checks
      task.autoConfirmReviewedAt = now;
      task.autoConfirmDecision = 'confirm';
      task.autoConfirmReviewNote = reason;
      task.status = 'approved';
      appendHistoryEvent(task, 'approved', `auto-confirmed (votes: ${vote.realVoteCount}/${vote.requestedVotes}): ${reason}`);
      try {
        const result = moveTaskFile(file, approvedDir, name, task);
        if (result) summary.confirmed += 1;
        else { console.error(`auto-confirm: moveTaskFile returned falsy for ${name} (${file}): ${result}`); summary.errors += 1; }
      } catch (err) { console.error(`auto-confirm: moveTaskFile threw for ${name} (${file}): ${err && err.message || err}`); summary.errors += 1; }
    } else if (vote.confident && vote.verdict === 'DENY') {
      const reason = voteReason(vote, 'DENY');
      task.autoConfirmReviewedAt = now;
      task.autoConfirmDecision = 'deny';
      task.autoConfirmReviewNote = reason;
      task.status = 'done';
      task.doneMarker = `auto-denied at confirm gate: ${reason}`;
      appendHistoryEvent(task, 'archived', `auto-denied (votes: ${vote.realVoteCount}/${vote.requestedVotes}): ${reason}`);
      try {
        if (moveTaskFile(file, archiveDir, name, task)) summary.denied += 1;
        else summary.errors += 1;
      } catch { summary.errors += 1; }
    } else {
      // No confident majority -- leave for a human.
      task.autoConfirmReviewedAt = now;
      task.autoConfirmDecision = 'escalate';
      task.autoConfirmReviewNote = `no confident CONFIRM/DENY majority (votes: ${vote.realVoteCount}/${vote.requestedVotes})`;
      appendHistoryEvent(task, 'advisory', `auto-confirm review inconclusive (${task.autoConfirmReviewNote}) -- held for a human`);
      try { fs.writeFileSync(file, JSON.stringify(task, null, 2)); summary.escalated += 1; }
      catch { summary.errors += 1; }
    }
  }

  return summary;
}
```

Problem:
The 113-line loop body inlines three structurally parallel outcome handlers (CONFIRM, DENY, inconclusive) plus a classification sub-branch, each repeating the same four-step pattern—stamp review fields, call appendHistoryEvent, write or move the record file into an outcome-specific directory, and increment a summary counter—but with different field names, target paths, and error strings. Because the three blocks are "same shape, different values," a reader must hold all three in working memory simultaneously to verify that no field is missed in one branch when editing another, and a future edit that touches the shared pattern (e.g., adding a new stamped field) must be replicated across three near-identical blocks with a high chance of a silent omission in one.

Solution:
Extract each outcome branch into its own small, clearly-named function—`handleConfirmOutcome(record, ctx)`, `handleDenyOutcome(record, ctx)`, and `handleInconclusiveOutcome(record, ctx)`—each owning its field-stamping, history-event call, file write/move, and counter bump. Additionally, pull the classification sub-branch into a `classifyOutcome(record)` helper that returns a discriminator the loop body can switch on. The loop body then reduces to: classify → dispatch to the matching handler → continue, dropping from ~113 lines to roughly 25–30 lines of orchestration while each handler stays under 30 lines.

Benefits:
Each handler becomes independently unit-testable (mock the file-system and history-event calls, assert the exact stamped fields and target path for that outcome), so a regression in one branch is caught without exercising the other two. Code review diff size shrinks because a change to the DENY path no longer sits adjacent to CONFIRM and inconclusive logic, reducing the chance of a reviewer's eye skipping a parallel edit. The shared four-step pattern is now visible in three small, identically-shaped functions, making it trivial to spot when one diverges (a missing field, a wrong directory constant) and straightforward to later consolidate into a shared helper if the pattern stabilises.

### AC-22 · Extract priority-wait loop and flock/compat lifecycle from GPU slot acquisition
Strength: Strong
Files: src/gpu-arbiter.js
Snippet:
```
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin fallback if SharedArrayBuffer is unavailable */ }
  }
}

// ---- the primary API --------------------------------------------------------------------

// Register a ticket and block (busy-wait with sleeps, like single-flight-lock.js -- this
// whole module blocks the calling process by design) until this ticket may proceed:
// no higher-priority-class ticket exists, and this is the earliest ticket of its own
// class. Then acquire the underlying flock. Returns a handle:
//   { release(), cancelled: () => boolean }
// The caller MUST call handle.release() (use withGpu() to make that automatic). While
// holding, a background interval re-touches the ticket and, if cancelRequested lands,
// invokes onCancel() exactly once -- the caller wires that to abort its model call.
function acquire(instancesDir, { cls = DEFAULT_CLASS, model, taskId = null, phase = null, onCancel = null } = {}) {
  const dir = ticketsDir(instancesDir, model);
  fs.mkdirSync(dir, { recursive: true });

  const myRank = classRank(cls);
  const seq = String(Date.now()).padStart(16, '0');
  const name = `${seq}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.json`;
  const fp = path.join(dir, name);
  const mySeqNum = Number(seq);

  writeTicketAtomic(fp, {
    pid: process.pid, cls, taskId, phase,
    startedAt: nowIso(), holding: false, cancelRequested: false,
  });

  // If this pid already holds a place ticket (holdPlace) of equal-or-higher priority for
  // this model, FIFO position is already reserved -- an inner per-turn acquire must not
  // re-queue behind peers that arrived AFTER the place (that would deadlock: the place
  // blocks those peers, and those peers would block this turn). Skip the wait loop; the
  // real flock still serialises the actual model call.
  const holdsPlace = liveTickets(instancesDir, model).some(
    (t) => t.pid === process.pid && t.place && classRank(t.cls) <= myRank,
  );

  const deadline = Date.now() + overallTimeoutMs();

  try {
    for (;;) {
      if (holdsPlace) break;
      if (Date.now() >= deadline) {
        safeUnlink(fp);
        throw new Error(`gpu-arbiter: '${cls}' ticket for model '${model || '(default)'}' timed out waiting to reach the head of the queue`);
      }
      touch(fp);
      const tickets = liveTickets(instancesDir, model);
      const mine = tickets.find((t) => t._name === name);
      if (!mine) {
        // our ticket was swept (we were too slow to re-touch, or a clock jump) -- re-add.
        writeTicketAtomic(fp, { pid: process.pid, cls, taskId, phase, startedAt: nowIso(), holding: false, cancelRequested: false });
        continue;
      }
      if (mine.cancelRequested) {
        safeUnlink(fp);
        const err = new Error('gpu-arbiter: cancelled while waiting');
        err.gpuArbiterCancelled = true;
        throw err;
      }
      const higherExists = tickets.some((t) => t._name !== name && t.pid !== process.pid && classRank(t.cls) < myRank);
      // A ticket owned by THIS pid at our own class (typically a holdPlace() place-holder
      // for a chat tool loop, or a re-added ticket after a sweep) is not a competitor --
      // this process already has its spot.
      const earlierPeer = tickets.some((t) => t._name !== name && t.pid !== process.pid
        && classRank(t.cls) === myRank && t._seq < mySeqNum);
      if (!higherExists && !earlierPeer) break;
      sleepSync(POLL_MS);
    }
  } catch (err) {
    safeUnlink(fp);
    throw err;
  }

  // At the head -- take the real mutex. skipPriorityBackoff: the ARBITER is the priority
  // mechanism now; sfl's own .discuss-waiting backoff would just make us wait on the
  // compat marker the arbiter itself drops for interactive tickets.
  const compat = interactiveCompatMarker(instancesDir, cls);
  let flockHandle;
  try {
    flockHandle = sfl.acquire(instancesDir, model, { skipPriorityBackoff: true });
  } catch (err) {
    compat.remove();
    safeUnlink(fp);
    throw err;
  }
  patchTicket(fp, { holding: true });

  let cancelled = false;
  let released = false;
  const watcher = setInterval(() => {
    if (released) return;
    touch(fp);
    compat.refresh();
    const cur = readTicket(fp);
    if (cur && cur.cancelRequested && !cancelled) {
      cancelled = true;
      if (typeof onCancel === 'function') {
        try { onCancel(); } catch { /* best-effort */ }
      }
    }
```

Problem:
The 103-line function interleaves four phases, but the real maintenance cost concentrates in two of them. The priority/FIFO wait loop (~30 lines) carries five distinct exit or continue paths—holdsPlace, timeout, ticket-swept re-add, cancelRequested, and the higher-priority/earlier-peer check—plus a `for(;;)` whose `continue` re-enters after mutating shared state, making it hard to verify that no path skips a cleanup or double-removes the ticket. The flock-acquisition block is shorter but has a fragile ordering constraint: the compat marker must be created *before* the flock and removed *only* on the failure path, a coupling that is easy to break when someone edits the surrounding logic. Because both of these blocks sit inline in the same function body, a reviewer must hold the entire 103-line sequence in working memory to confirm that, say, the timeout path does not accidentally leave the compat marker behind, or that the ticket-swept re-add does not re-enter the loop with a stale priority value.

Solution:
Extract two focused helpers, leaving the ticket-registration preamble and the final execution/cleanup tail inline. First, pull the entire priority/FIFO wait loop into a function like `waitForTurn(ticketId, priority, deadline, signal)` that returns a small result object (`{ status: 'acquired' | 'timeout' | 'cancelled' | 'swept' }`) and encapsulates all five exit/continue branches behind that contract. Second, pull the flock acquisition plus compat-marker create/remove into `acquireFlockWithCompat(lockPath)` that returns the fd on success and throws (or returns a typed error) on failure, with the marker cleanup guaranteed inside that single function so the ordering invariant lives in one place. The outer function then reads as a short sequence: register ticket → wait for turn → acquire flock → do work → release, with each step delegating to a named helper whose name states its contract.

Benefits:
Each extracted helper is independently unit-testable: `waitForTurn` can be tested with a fake ticket store and a controllable clock to exercise all five exit paths without touching the filesystem flock, and `acquireFlockWithCompat` can be tested against a real temp directory to verify the marker-creation/removal invariant under both success and failure. Code review becomes a matter of checking that the outer function's linear sequence calls the helpers in the right order and handles the result, rather than tracing 30 lines of nested `for(;;)` / `continue` logic. The compat-marker ordering bug class—marker created after flock, or not removed on a new failure path—becomes structurally impossible to introduce from outside the helper, because the invariant is now local to a 12-line function whose sole job is that pairing.

### AC-23 · draftAdhocBranch: extract decompose pre-flight and resolution sub-paths
Strength: Strong
Files: src/local-draft.js
Snippet:
```
// strict, line-based format; a freeform rewrite is not a safe way to edit one) -- every
// path here returns a final draftTask result directly instead.
async function draftAdhocBranch(task, {
  maybeLocked, recordModelCall, attempt, resolvedLocalCall, resolvedCallIsLocal,
  draftAdhocViaHarnessSearchFn, draftAdhocViaLocalAgenticFn, draftAdhocViaLocalAgenticWriteFn,
}) {
  // Tiered LOCAL escalation (2026-09-01, Grimmethy: "reasoning workers are supposed to go
  // through qwen. Claude needs to be removed as a dependency from that system"). Every
  // tier runs the local model against an isolated worktree:
  //   1. harness-search  -- cheap, single-shot, grep-grounded blind diff (proven).
  //   2. local-agentic   -- multi-turn, READ-ONLY tools, emits a Group-B diff (opt-in).
  //   3. local-agentic-WRITE -- multi-turn with real edit/write/run_bash in a worktree
  //      (default-on; this is what the deleted Claude adhoc-agentic-draft.js used to do).
  // Tiers 1-2 return {applied, succeeded, reason?}: applied -> done; declined -> next
  // tier. Tier 3 returns a terminal draftTask-shaped verdict (implemented / blocked /
  // needs-clarification) -- if it can't do the task it BLOCKS for a human. No Claude
  // fallback. All tiers are unconditionally lock-wrapped (always local).
  //
  // Each tier is bracketed with an 'implement-started' checkpoint. The ladder emits no
  // other history until a tier resolves, and tier 3 is a multi-turn agentic pass that
  // routinely runs for many minutes -- so without these, a task killed mid-ladder (or one
  // that keeps dying in tier 3) shows only '... -> plan-done' and the Pipeline History
  // looks cut short. With main()'s persist hook each one lands on disk the moment it fires,
  // so the log shows exactly how far the draft got. (2026-08-31, Grimmethy: "the task log
  // gets cut short" -- observed on a stubborn brain-dump adhoc looping in tier 3.)

  // PRELIMINARY DECOMPOSE CHECK (2026-09-02): one cheap model call, no tool loop, run
  // BEFORE any agentic tier. A task that is genuinely 5 endpoints + a UI + tests wastes a
  // full 35-turn tier-3 pass (and 2 retries) discovering that; catch it here instead. Only
  // on a FRESH task -- a retry / re-scoped / already-decomposed task has specific feedback
  // to act on and skips this. The decompose verdict flows straight to review -> coordinator
  // exactly like a RESOLUTION: decompose from tier 3.
  const preliminaryDecomposeEnabled = process.env.AGENT_MANAGER_PRELIMINARY_DECOMPOSE !== 'false';
  const isFreshAdhoc = !task.localRejectCount
    && !(Array.isArray(task.priorRejectionFeedback) && task.priorRejectionFeedback.length)
    && !task.rescopedFromDecompose
    && !task.autoDecomposeCount
    && task.adhocResolution !== 'decompose';
  if (preliminaryDecomposeEnabled && isFreshAdhoc) {
    const split = await maybeLocked(resolvedCallIsLocal !== false, () => runDecomposePass(task, { mode: 'preliminary', call: resolvedLocalCall }), 'decompose-check');
    if (split && split.subTasks.length >= 2) {
      appendHistoryEvent(task, 'implement-started', `adhoc: preliminary size check -> decompose (${split.subTasks.length} pieces)`);
      task.adhocResolution = 'decompose';
      task.subTaskProposals = split.subTasks;
      task.rawDiff = '';
      task.implementResponse = `Preliminary size check: this task spans ${split.subTasks.length} independent pieces, so it was decomposed before any implementation attempt.`;
      concludeDraft(task);
      return { succeeded: true, blocked: false };
    }
  }

  appendHistoryEvent(task, 'implement-started', 'adhoc tier 1/3: harness-search (cheap grep-grounded blind diff)');
  const harnessResult = await maybeLocked(true, () => draftAdhocViaHarnessSearchFn(task), 'harness-search');
  recordTier(attempt, {
    tier: 'harness-search', applied: harnessResult.applied, reason: harnessResult.reason,
    response: harnessResult.applied ? task.implementResponse : undefined,
    rawDiff: harnessResult.applied ? task.rawDiff : undefined,
  });
  if (!harnessResult.applied && harnessResult.succeeded === false) {
    return { succeeded: false, reason: harnessResult.reason };
  }

  let localTierApplied = harnessResult.applied;
  // Carried from a declined tier 2 into the tier-3 write prompt (see the tier-3 call
  // below) so tier 3 starts from the read-only pass's map instead of re-orienting from
  // cold and running out of turns before it edits anything.
  let priorInvestigation = null;
  if (!localTierApplied) {
    appendHistoryEvent(task, 'implement-started', 'adhoc tier 2/3: local-agentic (multi-turn, read-only tools)');
    const localAgenticResult = await maybeLocked(true, () => draftAdhocViaLocalAgenticFn(task), 'local-agentic');
    recordTier(attempt, {
      tier: 'local-agentic', applied: localAgenticResult.applied, reason: localAgenticResult.reason,
      response: localAgenticResult.response, turnsUsed: localAgenticResult.turnsUsed,
      toolCallLog: localAgenticResult.toolCallLog,
    });
    appendTierWorkLog(task, { tier: 'local-agentic', turnsUsed: localAgenticResult.turnsUsed, toolCallLog: localAgenticResult.toolCallLog, finalMessage: localAgenticResult.response });
    if (!localAgenticResult.applied && localAgenticResult.succeeded === false) {
      return { succeeded: false, reason: localAgenticResult.reason };
    }
    if (!localAgenticResult.applied && localAgenticResult.investigationSummary) {
      priorInvestigation = localAgenticResult.investigationSummary;
    }
    localTierApplied = localAgenticResult.applied;
  }

  if (localTierApplied) {
    const appliedTier = harnessResult.applied ? 'harness-search' : 'local-agentic (read-only)';
    appendHistoryEvent(task, 'implement-done', `${appliedTier} tier applied, ${(task.implementResponse || '').length} chars, resolution=${task.adhocResolution}, model=${task.draftModel}`);
    concludeDraft(task);
    return { succeeded: true, blocked: false };
  }

  // Tier 3: local write-agentic. Returns the same verdict shape the Claude tier did
  // (succeeded/blocked/blockedReason/needsClarification); a non-succeeded result is a
  // genuine infra error (retry), everything else is terminal.
  appendHistoryEvent(task, 'implement-started', 'adhoc tier 3/3: local-agentic-write (multi-turn edit/write/run_bash in a worktree -- can take many minutes)');
  // Transient -- buildWriteAgenticPrompt reads it synchronously at the top of
  // draftAdhocViaLocalAgenticWrite; delete it right after so it is never persisted on the
  // task (same pattern as runPlanPass's task._seedPlan).
  if (priorInvestigation) task._priorInvestigation = priorInvestigation;
  const agenticResult = await maybeLocked(true, () => draftAdhocViaLocalAgenticWriteFn(task, { recordModelCall }), 'local-agentic-write');
  delete task._priorInvestigation;
  recordTier(attempt, {
    tier: 'local-agentic-write',
    resolution: agenticResult.resolution || task.adhocResolution,
    blocked: agenticResult.blocked,
    reason: agenticResult.reason || agenticResult.blockedReason,
    response: agenticResult.response,
    rawDiff: agenticResult.capturedDiff || (agenticResult.blocked ? undefined : task.rawDiff),
    turnsUsed: agenticResult.turnsUsed,
    toolCallLog: agenticResult.toolCallLog,
  });
  appendTierWorkLog(task, { tier: 'local-agentic-write', turnsUsed: agenticResult.turnsUsed, toolCallLog: agenticResult.toolCallLog, finalMessage: agenticResult.response });
  if (!agenticResult.succeeded) {
    return { succeeded: false, reason: agenticResult.reason };
  }
  if (agenticResult.blocked) {
    appendHistoryEvent(task, 'blocked', agenticResult.blockedReason);
    return { succeeded: true, blocked: true, blockedReason: agenticResult.blockedReason };
  }
  // 2026-08-24 (RESOLUTION: needs-human-decision, adhoc-agentic-draft.js): a real
  // open product/design question, not a diff or a sub-task list -- nothing here for
  // an automatic reviewer to verify against real repo state, so this skips review-
  // task.js/apply-task.js entirely and goes straight to queue/needs-clarification/
  // (local-worker.sh's own move-destination branch) for a human to actually answer.
  // Reuses `needsClarification`'s FIELD NAME (not path_prefetch_resolve's specific
  // shape) so the dashboard's existing "does this task have needsClarification"
  // check and Discuss button pick it up; `reason: 'design-decision'` is what
  // distinguishes this from path_prefetch's own ambiguous/no-match held tasks (see
  // python/dashboard/app.py's api_discuss_end, which branches on this exact field).
  if (agenticResult.needsClarification) {
    // 2026-08-24 (Grimmethy: multiple-choice shortcut) -- options is undefined
    // (never a key at all, not even null) when the model didn't offer a clean
    // 2+ option OPTIONS block, so the dashboard's existing `nc.options` check
    // stays a plain truthy test either way.
    const options = parseClarificationOptions(task.implementResponse);
    task.needsClarification = {
      reason: 'design-decision', openQuestions: task.implementResponse,
      ...(options ? { options } : {}),
    };
    appendHistoryEvent(task, 'implement-done', `agentic, ${(task.implementResponse || '').length} chars, resolution=${task.adhocResolution}`);
    appendHistoryEvent(task, 'needs-clarification');
    return { succeeded: true, blocked: false, needsClarification: true };
  }
  appendHistoryEvent(task, 'implement-done', `agentic, ${(task.implementResponse || '').length} chars, resolution=${task.adhocResolution}`);
```

Problem:
`draftAdhocBranch` spans 143 lines and is not a single linear pipeline; it is at least four logically distinct units (a decompose pre-flight gate, a resolution/branching core, a sub-task-proposal assembly, and a final task-field commit) that share only a mutable `task` object as their coupling point. The pre-flight alone carries its own early-return, its own history-event append, and its own set of `task` field mutations (`adhocResolution`, `subTaskProposals`, `rawDiff`, `implementResponse`), making it independently testable yet inseparable in the current body. Because every unit mutates the same `task` reference and the function has no intermediate return boundaries, a reader must hold the full 143-line state in working memory to reason about any single branch, and a regression in one unit (e.g., a missing `rawDiff` write in the decompose path) can silently corrupt a downstream unit that assumes the field was set.

Solution:
Extract the preliminary decompose pre-flight into a `maybePreliminaryDecompose(task, { maybeLocked, resolvedLocalCall, resolvedCallIsLocal })` helper that returns either a decompose verdict object (triggering the caller's early return) or `null` to signal fall-through; internally it owns the env-flag check, freshness predicates, the `runDecomposePass` call, the history-event append, and the four `task` field writes. Next, pull the sub-task-proposal assembly (the block that builds `subTaskProposals` from the diff and local-call context) into `buildSubTaskProposals(task, diff)` so its branching on call locality is isolated. Finally, wrap the terminal commit sequence (setting `implementResponse`, appending the final history event, and returning the resolution) into `commitAdhocResolution(task)`. The top-level `draftAdhocBranch` then reduces to a short orchestration: call the pre-flight, bail if it returns a verdict, otherwise call the proposal builder, then the commit helper, and return.

Benefits:
Each extracted helper has a single, nameable contract and a small, self-contained mutation surface, so a reviewer can verify the decompose gate's early-return logic without scanning 120+ lines of unrelated branching. Unit tests can exercise `maybePreliminaryDecompose` with a stub `task` and assert the four field writes and the history append in isolation, and can test `buildSubTaskProposals` against a fixed diff without needing the full env-flag and freshness setup. The top-level function shrinks to roughly 15–20 lines of sequencing, making the overall control flow (decompose-or-fall-through → propose → commit) immediately legible and reducing the blast radius of any future edit to a single helper.

### AC-24 · Decompose reject-retry-check into discovery, exhaustion, and feedback stages
Strength: Strong
Files: src/reject-retry-check.js
Snippet:
```
}

function rejectRetryCheck({ blockedDir, pendingDir, adhocDir, needsClarificationDir, deepDiveCoveragePath, brainDumpPath, recordModelOutcome = defaultRecordModelOutcome }) {
  const summary = { checked: 0, requeued: 0, exhausted: 0, errors: 0 };
  const entries = [];
  try {
    for (const n of fs.readdirSync(blockedDir).filter((f) => f.endsWith('.json'))) {
      entries.push({ dir: blockedDir, name: n });
    }
  } catch (e) {
    // blocked/ doesn't exist yet -- fall through, the adhoc/ scan below may still have work.
  }
  // An adhoc tier draft-stage block writes the task file back IN PLACE in queue/adhoc/ --
  // it never moves to blocked/. So a genuinely blocked adhoc task (retry cap hit, a
  // real review rejection, ...) that happens to still be sitting in adhoc/ is invisible
  // to this sweep: no blind retry, no needs-clarification escalation, forever. Confirmed
  // live 2026-09-02: adhoc-...-plugins-install-...-1, blockedStage 'review',
  // localRejectCount 2/2, stranded in queue/adhoc/. Pick those up here too -- everything
  // downstream already keys off isAdhocTask(task) and the per-entry source dir.
  try {
    for (const n of fs.readdirSync(adhocDir).filter((f) => f.endsWith('.json'))) {
      try {
        const t = JSON.parse(fs.readFileSync(path.join(adhocDir, n), 'utf8'));
        if (t && t.status === 'blocked') entries.push({ dir: adhocDir, name: n });
      } catch { /* unparseable -- not this sweep's problem */ }
    }
  } catch { /* no adhoc/ dir -- fine */ }

  if (entries.length === 0) return summary;

  for (const { dir: sourceDir, name } of entries) {
    const filePath = path.join(sourceDir, name);
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      if (!raw) continue;
      const task = JSON.parse(raw);
      summary.checked++;

      // Only a genuine review-stage rejection is eligible -- never an apply-stage failure
      // that happens to still carry localVotes from an earlier, unrelated successful
      // review (redrafting can't fix that; see agent-manager-common.sh's
      // test_review_rejection, the bash equivalent of this exact check).
      //
      // 2026-09-01: also eligible -- an adhoc tier-3 draft-stage block that a redraft could
      // plausibly fix (resolveAgenticDraft sets task.retryableDraftBlock):
      //   - the model exhausted its turn budget without making a single edit
      //     (task.turnBudgetExhausted) -- the redraft is NOT blind: plan + tier-2
      //     investigation are folded into the prompt and the feedback below says "edit early".
      //   - the model chose RESOLUTION: decompose but botched the sub-task JSON -- a redraft
      //     can emit valid JSON or just implement the change; the feedback reminds it of the
      //     format.
      // Bounded by the same MAX_LOCAL_REJECT_RETRIES cap; on exhaustion it takes the same
      // adhoc -> needs-clarification escalation as a stuck review rejection.
      const retryableDraftBlock = isAdhocTask(task) && task.retryableDraftBlock === true;
      if (!isReviewRejection(task) && !retryableDraftBlock) continue;

      // A continuation (agentic-draft-common.js: the model ran out of turns mid-
      // implementation, no real design question) is forward progress, not a failed
      // redraft -- it has its OWN cap (MAX_AGENTIC_CONTINUATIONS, enforced there) and must
      // not be gated by, or count against, the blind-redraft cap.
      const isContinuation = retryableDraftBlock && task.isAgenticContinuation === true;

      const retryCount = Number(task.localRejectCount) || 0;
      if (retryCount >= MAX_LOCAL_REJECT_RETRIES && !isContinuation) {
        // An exhausted ADHOC rejection is very often a real disagreement about scope
        // ("is this already done, or a request to extend it?") that no amount of blind
        // redraft will resolve -- send it to a human instead of leaving it to rot in
        // blocked/ forever. (Non-adhoc keeps the original "stamp once, stay in blocked"
        // behaviour.)
        if (isAdhocTask(task) && needsClarificationDir) {
          const alreadyEscalated = Array.isArray(task.history) && task.history.some((h) => h.stage === 'needs-clarification');
          if (alreadyEscalated) { summary.exhausted++; continue; }
          task.needsClarification = { reason: 'design-decision', openQuestions: buildExhaustedAdhocQuestion(task) };
          appendHistoryEvent(task, 'exhausted', `${retryCount}/${MAX_LOCAL_REJECT_RETRIES} retries used`);
          appendHistoryEvent(task, 'needs-clarification', 'escalated to a human after exhausting redraft retries');
          fs.mkdirSync(needsClarificationDir, { recursive: true });
          fs.writeFileSync(path.join(needsClarificationDir, name), JSON.stringify(task, null, 2));
          fs.unlinkSync(filePath);
          summary.exhausted++;
          continue;
        }
        // Already stamped on a prior tick -- an exhausted task stays in blocked/
        // permanently (nothing here ever moves or deletes it), so without this guard this
        // whole branch re-fires every single tick forever. Confirmed live 2026-08-17: one
        // real exhausted task accumulated 20+ duplicate 'exhausted' history entries (one
        // per ~30s tick) over about 12 minutes before this was caught, unbounded growth
        // for as long as the task sits there -- which, being exhausted, is indefinitely.
        const alreadyStamped = Array.isArray(task.history) && task.history.some((h) => h.stage === 'exhausted');
        if (alreadyStamped) { summary.exhausted++; continue; }
        stampDeepDiveExhausted(task, deepDiveCoveragePath);
        stampBrainDumpSortExhausted(task, brainDumpPath);
        // Persist the exhaustion itself onto the task -- previously this branch never
        // wrote the file back at all, so a task permanently stuck in queue/blocked/ after
        // hitting the retry cap carried no record that retries were ever attempted or
        // exhausted; only localRejectCount (no timestamp) hinted at it.
        appendHistoryEvent(task, 'exhausted', `${retryCount}/${MAX_LOCAL_REJECT_RETRIES} retries used`);
        fs.writeFileSync(filePath, JSON.stringify(task, null, 2));
        summary.exhausted++;
        continue;
      }

      const priorFeedback = Array.isArray(task.priorRejectionFeedback) ? task.priorRejectionFeedback : [];
      if (isContinuation) {
        priorFeedback.push([
          'This is a CONTINUATION, not a fresh start. A prior pass got partway through and ran out of turns. It reported this remaining work:',
          '',
          String(task.agenticContinuationNote || '').slice(0, 4000),
          task.priorPartialDiff
            ? `\nThe partial diff it already produced (build ON this, do not redo it):\n\n${String(task.priorPartialDiff).slice(0, 6000)}`
            : '',
          '',
          'Start editing with edit_file/write_file within your first 1-2 turns from where it left off. Finish the remaining work and end with RESOLUTION: implemented.',
        ].filter(Boolean).join('\n'));
        delete task.agenticContinuationNote;
        delete task.priorPartialDiff;
        // keep task.isAgenticContinuation + task.agenticContinuationCount for the cap in
        // agentic-draft-common.js's resolveAgenticDraft on the next pass.
      } else if (retryableDraftBlock && task.rescopedFromDecompose === true && typeof task.rescopedRawText === 'string' && task.rescopedRawText.trim()) {
        // resolveAgenticDraft decided this task's real scope is exactly one sub-task the
        // model proposed. Make that the task now, and tell the next pass to implement it
        // (not decompose again).
        task.promptContext = task.promptContext || {};
        task.promptContext.rawText = task.rescopedRawText;
        priorFeedback.push(`A prior pass decided this task's real scope is exactly: ${task.rescopedRawText}\nThat is the task now. Implement THAT with edit_file/write_file in this pass. Do not decompose again.`);
        delete task.rescopedRawText; // keep rescopedFromDecompose set for the escalation cap in resolveAgenticDraft
      } else if (retryableDraftBlock && task.turnBudgetExhausted === true) {
        priorFeedback.push('A prior attempt spent its whole turn budget exploring and made ZERO edits. Do not re-explore from scratch: the PLAN and PRIOR INVESTIGATION are already in your prompt -- use them, get to a concrete edit_file within the first few turns, and answer RESOLUTION: decompose if the task is genuinely too large to finish in one pass.');
      } else if (retryableDraftBlock && typeof task.adhocDiffSubstanceFeedback === 'string' && task.adhocDiffSubstanceFeedback.trim()) {
        // resolveAgenticDraft (agentic-draft-common.js) found the produced diff was a token
        // gesture -- an ADR/doc instead of the code, an unrequested delete, or a file the
        // task explicitly forbids. The feedback names the real target(s).
        priorFeedback.push(task.adhocDiffSubstanceFeedback);
        delete task.adhocDiffSubstanceFeedback;
      } else if (retryableDraftBlock) {
        priorFeedback.push('A prior attempt chose RESOLUTION: decompose but the sub-task JSON was malformed. If this task is doable in one pass, just implement it. If it genuinely needs splitting, end with EXACTLY "RESOLUTION: decompose" then, on the next lines, a single valid JSON array of 2+ objects each shaped {"title": "...", "rawText": "..."} and nothing else.');
      } else {
        priorFeedback.push(String(task.blockedReason || ''));
      }
      delete task.turnBudgetExhausted;
      delete task.retryableDraftBlock;
      // Clear the terminal block state -- otherwise a task requeued into queue/adhoc/ still
      // reads status:'blocked' and this sweep's adhoc/ scan re-requeues it every tick until
      // the cap. blockedStage/blockedReason are left for priorRejectionFeedback's history.
      if (task.status === 'blocked') task.status = 'pending';
      task.priorRejectionFeedback = priorFeedback;
      // A continuation is forward progress, not a spent redraft -- don't burn a slot of the
      // blind-redraft budget on it (its own MAX_AGENTIC_CONTINUATIONS cap bounds it).
      if (!isContinuation) task.localRejectCount = retryCount + 1;

      recordModelOutcome({ callId: task.abCallId, outcome: 'requeued', outcomeStage: 'watchdog', outcomeReason: task.blockedReason || null });
      appendHistoryEvent(task, 'requeued', task.blockedReason || undefined);

      // nextAdhocTask() only scans queue/adhoc/ -- an adhoc task requeued to pending/ is
      // only picked up by a general worker, never re-drafted through draftAdhocBranch's
      // tiers. Match python/dashboard/app.py's own adhoc-requeue destination.
      const destDir = (isAdhocTask(task) && adhocDir) ? adhocDir : pendingDir;
      const newPath = path.join(destDir, name);
      fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(newPath, JSON.stringify(task, null, 2));
      // A task picked up from queue/adhoc/ requeues back to queue/adhoc/ -- same path.
      // Only unlink when the source and destination genuinely differ, or we'd delete the
      // file we just wrote.
      if (path.resolve(filePath) !== path.resolve(newPath)) fs.unlinkSync(filePath);
      summary.requeued++;
    } catch (e) {
      console.warn('[reject-retry-check] requeue failed for', filePath, e.message, e.code);
      summary.errors++;
    }
  }

  return summary;
}
```

Problem:
The function interleaves three semantically distinct responsibilities—entry discovery (two directory scans with different filter semantics), exhaustion handling (two sub-paths with independent idempotency guards for adhoc escalation vs. deep-dive stamping), and feedback construction (a six-branch state-to-string mapping)—into a single mutable scope. The exhaustion sub-procedure is the highest-risk logic (it caused the 2026-08-17 duplicate-history bug and the 2026-09-02 adhoc-stranding bug), yet it is entangled with the requeue path and the feedback chain, making it impossible to reason about, test, or review in isolation. The feedback chain is effectively a pure function of (task, isContinuation, retryableDraftBlock) → string, but it is buried inside mutation code, so adding a new retryableDraftBlock subtype requires navigating the entire function to confirm no side-effect ordering is broken.

Solution:
Extract three named helpers scoped to this file: (1) discoverBlockedEntries() returning a normalized array of {source, task, meta} from the two directory scans; (2) handleExhaustion(entry, ctx) encapsulating both the adhoc→needs-clarification escalation path and the non-adhoc deep-dive/brain-dump stamping path, each with its own idempotency guard, returning a small result object ({action, payload}); (3) buildFeedbackString(task, isContinuation, retryableDraftBlock) as a pure function that maps the six state branches to the injected prompt string. The top-level function then becomes a short orchestration loop: discover → for each entry, if exhausted call handleExhaustion, else call buildFeedbackString and enqueue—roughly 15–20 lines of glue.

Benefits:
Each extracted helper becomes independently unit-testable: the exhaustion guards can be tested against fixture histories without mocking directory I/O, and the feedback mapping can be table-tested across all six branches without executing any mutation. Code review of a new retryableDraftBlock subtype now touches only buildFeedbackString, and the 2026-08-17 / 2026-09-02 class of bugs (guard ordering, duplicate stamps) becomes visible as a single function's contract rather than a side effect buried in a 100-line body. The top-level orchestrator reads as a three-line pipeline, making the overall control flow auditable at a glance.

### AC-25 · Decompose the review-task orchestrator into per-gate evaluators
Strength: Strong
Files: src/review-task.js
Snippet:
```
 * the reviewTask wrapper) so tests can call it directly with a fake localMajorityVote.
 */
async function runReview(task, { repoRoot, pipelineDir, secondBrainDir, domainsPath, instancesDir, deepDiveCoveragePath, localMajorityVote = null, recordModelOutcome = defaultRecordModelOutcome } = {}) {
  // Resolved here rather than as a static default param, same reasoning as
  // local-draft.js's draftTask() -- the right backend depends on the task's reasoning
  // tier, only known once the task object is in hand. Passing the whole task (not just
  // task.source) lets a per-instance task.reasoningTier override take effect. An explicit
  // caller override always wins.
  // 2026-08-24 (model-profile-registry.js): same pattern as local-draft.js's own
  // resolvedLocalCall wrapping -- when the task's own source declares a modelProfile,
  // its overrides become defaults spread BEFORE the real majorityVote() call below (opts
  // spread after wins, though the one real call site doesn't set model/numCtx/numPredict/
  // effort/timeoutMs itself today, so the profile's values reliably take effect). Passing
  // both local-only (numCtx/numPredict) and claude-only (effort/timeoutMs) keys
  // unconditionally is safe -- whichever backend's majorityVote() runs only destructures
  // the params it recognizes, ignoring the rest. Skipped for an injected
  // localMajorityVote (test/caller override), same as local-draft.js.
  const modelProfile = resolveModelProfile(task);
  const profileOverrides = modelProfile
    ? {
      model: modelProfile.model, numCtx: modelProfile.numCtx, numPredict: modelProfile.numPredict,
      effort: modelProfile.effort, timeoutMs: modelProfile.timeoutMs,
    }
    : null;
  // 2026-08-27, Grimmethy: "Review should never be gated behind claude. Please allow
  // the local model to review them" -- ALWAYS the local backend, never providerFor(task)
  // (which would route a high-reasoning-tier task to Claude). Root-caused live: this
  // review call had, in practice, ALREADY always run local regardless of tier -- nothing
  // in review-task.js's own require graph ever loaded task-sources.js, so
  // providerFor()'s tier lookup silently saw an empty registry and defaulted to local
  // every time -- but review-runner.sh's separate bash-side pre-check DID load that
  // registry (to compute its own Claude-budget gate), correctly saw a high-tier task,
  // and skipped it whenever Claude was paused/rate-limited: a real task that would have
  // reviewed successfully in seconds sat unreviewed for hours, purely because of a
  // mismatch between what the pre-check assumed would happen and what actually would
  // have. Making this the real, intentional behavior (not an accidental side effect of
  // a missing require) instead of just deleting review-runner.sh's now-dead gate --
  // review-runner.sh's own header already documented the intent ("Reviewer is always
  // Ornith (never Claude)"), this just makes the code match it for real.
  const baseMajorityVote = localMajorityVote || localMajorityVoteBackend;
  const resolvedMajorityVote = profileOverrides && !localMajorityVote
    ? (opts) => baseMajorityVote({ ...profileOverrides, ...opts })
    : baseMajorityVote;
  appendHistoryEvent(task, 'review-started');

  // Deterministic review (brain_dump_sort, 2026-09-03): a mechanical validate replaces the
  // LLM majority vote entirely -- no grounding subprocess, no fact-check, no vote. The vote
  // was rejecting valid classifications on folder/filename nitpicks its own guidance forbade
  // (8 permanently-blocked tasks). A failure here still sets blockedStage:'review', so
  // reject-retry-check folds the specific reason into the next draft (an informed retry).
  const detValidate = deterministicReviewValidator(resolveSourceName(task));
  if (detValidate) {
    let outcome;
    try {
      outcome = detValidate(task, { secondBrainDir, repoRoot });
    } catch (e) {
      outcome = { ok: false, reason: `deterministic review validator threw: ${e.message}` };
    }
    if (outcome && outcome.ok) {
      task.reviewedAt = new Date().toISOString();
      task.reviewProvider = 'deterministic-brain-dump-sort';
      task.localVerdict = 'Auto-approved: deterministic classification validation passed (no vote).';
      recordModelOutcome({ callId: task.abCallId, outcome: 'approved', outcomeStage: 'review', outcomeReason: null });
      appendHistoryEvent(task, 'approved', 'deterministic-brain-dump-sort');
      return { succeeded: true, verdict: 'approved', factCheckVerdict: 'skipped' };
    }
    const reason = `Deterministic review: ${outcome ? outcome.reason : 'validation failed'}`;
    task.reviewProvider = 'deterministic-brain-dump-sort';
    recordModelOutcome({ callId: task.abCallId, outcome: 'rejected', outcomeStage: 'review', outcomeReason: reason });
    appendHistoryEvent(task, 'blocked', reason);
    return { succeeded: true, verdict: 'blocked', blockedReason: reason, blockedStage: 'review', factCheckVerdict: 'skipped' };
  }

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
  }

  const taskPathForGrounding = path.join(require('os').tmpdir(), `review-grounding-${task.id}.json`);
  let groundingText = '';
  try {
    fs.writeFileSync(taskPathForGrounding, JSON.stringify(task));
    groundingText = execFileSync('node', [path.join(__dirname, 'get-grounding-source.js'), taskPathForGrounding], { encoding: 'utf8' });
  } catch (e) {
    console.error(`[review-task] grounding-source generation failed for ${taskPathForGrounding}: ${e.stack || e.message || String(e)}`);
    groundingText = '';
  } finally {
    try { fs.unlinkSync(taskPathForGrounding); } catch (e) { /* best-effort cleanup */ }
  }

  // Feed the consumer's configured code dirs (AGENT_MANAGER_GREP_DIRS) as extraRoots so
  // resolveAgainstRepo can turn a bare `app.py` into `server/app.py` instead of reporting
  // it "missing" -> "fabricated". Only meaningful when the fact-check runs against
  // agent-manager's OWN repoRoot (the default); for a deep_dive external clone or the
  // second-brain vault, these dirs don't apply and simply won't match -- harmless.
  const factCheckExtraRoots = (repoRootForCheck === workDir)
    ? (() => { try { return getConfig().grepAllowedDirs; } catch { return []; } })()
    : [];
  const factCheck = checkDraft(task.implementResponse || '', repoRootForCheck, groundingText || undefined, factCheckExtraRoots);
  // `imprecise-file-path` is informational (a real file cited with a sloppy prefix) --
  // it must not by itself flip the verdict label to "flagged".
  const factCheckVerdict = (factCheck.flags || []).some((f) => f.type !== 'imprecise-file-path') ? 'flagged' : 'pass';

  // 2026-08-24 (pipeline hardening -- resurrects a real gap closed once already on
  // 2026-08-12 for the old Windows/PowerShell review-runner.ps1, never carried forward
  // across this project's Linux port): fact-checker.js's own comments call ungrounded-url
  // and ungrounded-field "almost never a false positive" -- checkGroundedValues() only
  // ever flags a value when there IS real grounding source text to compare against and
  // the value appears NOWHERE in it, placeholders already exempted. That precision was
  // being wasted as advisory context a review vote could (and did) simply ignore, the
  // same "known-bad signal, only advisory" shape every OTHER deterministic gate in this
  // function already treats as disqualifying. Hard-blocks before spending a review call,
  // same as the empty-response/non-implementation/fixed-literals gates below.
  // 2026-08-25, root-caused live via a real blocked adhoc task (second-brain review
  // sweep): RESOLUTION: decompose (adhoc-agentic-draft.js's "task judged too large,
  // propose sub-tasks instead of a diff" outcome, carved out in buildVerdictPrompt below
  // -- see its own comment) got hard-blocked here anyway, before ever reaching that
  // carve-out, because a decompose proposal's sub-task rawText routinely SUGGESTS names
  // for config/paths a FUTURE sub-task should create (e.g. "add
  // AGENT_MANAGER_SECOND_BRAIN_REVIEW_COVERAGE_PATH, following the pattern of
  // stalenessAuditCoveragePath" -- explicitly marked as a proposal, "e.g.", never a claim
  // that it already exists). checkGroundedValues' whole premise is "a value cited as
  // already-real that appears nowhere in the grounding source is fabricated" -- a
  // category error against text that is deliberately proposing something new, the exact
  // same "new declaration, not a claimed-existing value" distinction NEW_DECLARATION_RE
  // already carves out for a real diff's own `+const NAME = ...` line, just for a
  // decompose proposal's prose instead of a diff. Scoped ONLY to the two high-precision
  // flags that hard-block with no review call at all -- factCheck's OTHER checks (missing-
  // file, fabricated-commit-reference, unconfirmed-relationship) still run and still hard-
  // block a decompose response exactly as before: those check "does this cite something
  // that claims to already exist," which stays a real fabrication signal even in a
  // decompose proposal's prose. And the full factCheck (including these two flags) is
  // still handed to the reviewer model via buildVerdictPrompt below regardless -- this
  // only removes the automatic no-review-call block, not the information itself.
  // 2026-08-26: a `{"mode": "split"}` proposal (see candidateSplitInstructions) is the
  // exact same category as a decompose proposal above -- prose describing FUTURE
  // sub-candidates, which routinely names config/field values a future drafting pass
  // should create, not a claim that something already exists. Same carve-out, same
  // "still checked, just not auto-blocked" scoping.
  //
  // 2026-09-02: the same category error for an advisoryProse candidate-generating review
  // source (function_length_review / performance_review / observability_review). Their
  // deliverable is a `### AC-NNN` candidate block whose Solution paragraph PROPOSES names
  // for helpers/constants a FUTURE fix pass should introduce ("extract into a
  // RETRYABLE_WITH_BACKOFF branch", "compute START_MS once outside the loop") -- never a
  // claim that RETRYABLE_WITH_BACKOFF / START_MS already exists. checkGroundedValues'
  // premise ("a value cited as already-real that appears nowhere is fabricated") is a
  // category error against a proposal, exactly like the decompose case above. Confirmed
  // live: function-length-...reject-retry-check-js-90 (RETRYABLE_WITH_BACKOFF),
  // performance-...uptime-log-js-58 (START_MS). Still handed to the vote via
  // buildVerdictPrompt -- just not an automatic no-review block.
  const isDecomposeProposal = (task.source === 'manual' && task.adhocResolution === 'decompose') || !!task.candidateSplitProposals;
  const isProposalNotClaim = isDecomposeProposal || isAdvisoryProseSource(resolveSourceName(task));
  const highPrecisionFlags = isProposalNotClaim
    ? []
    : (factCheck.flags || []).filter((f) => f.type === 'ungrounded-url' || f.type === 'ungrounded-field');
  if (highPrecisionFlags.length > 0) {
    const detail = highPrecisionFlags.map((f) => `${f.type}: ${f.detail}`).join('; ');
    const reason = `Deterministic gate: draft cites a value that appears nowhere in its real grounding source -- ${detail}. This fact-check flag is high-precision (almost never a false positive) and treated as disqualifying, not merely advisory context a vote could ignore -- no local-model review call spent on a draft already known to contain a hallucinated value.`;
    task.reviewProvider = 'deterministic-ungrounded-value';
    recordModelOutcome({ callId: task.abCallId, outcome: 'rejected', outcomeStage: 'review', outcomeReason: reason });
    appendHistoryEvent(task, 'blocked', reason);
    return { succeeded: true, verdict: 'blocked', blockedReason: reason, blockedStage: 'review', factCheckVerdict };
  }

  const trimmedImplResponse = (task.implementResponse || '').trim();
  const effectivelyEmpty = isEffectivelyEmpty(trimmedImplResponse);

  if (isEmptyApprovalSource(task.source) && effectivelyEmpty) {
    task.reviewedAt = new Date().toISOString();
    task.reviewProvider = 'deterministic-empty-approve';
    task.localVerdict = `Auto-approved: implementResponse is genuinely empty, a documented valid outcome for ${task.source} (no local-model review call spent -- this is deterministic, not a judgment call)`;
    recordModelOutcome({ callId: task.abCallId, outcome: 'approved', outcomeStage: 'review', outcomeReason: null });
    appendHistoryEvent(task, 'approved', 'deterministic-empty-approve');
    return { succeeded: true, verdict: 'approved', factCheckVerdict };
  }

  let isNonImplementation = false;
  if (!effectivelyEmpty) {
    isNonImplementation = NON_IMPL_PATTERNS.some((pat) => pat.test(trimmedImplResponse));
    if (!isNonImplementation && trimmedImplResponse.length < 80 && !trimmedImplResponse.includes('```')) {
      isNonImplementation = true;
    }
  }
  if (isNonImplementation && !isEmptyApprovalSource(task.source) && !isAdvisoryProseSource(task.source)) {
    const reason = 'Deterministic gate: implementResponse is a bare tool-call request or meta-commentary, not a real implementation attempt -- no local-model review call spent (mechanically detectable, not a judgment call).';
    task.reviewProvider = 'deterministic-non-implementation';
    recordModelOutcome({ callId: task.abCallId, outcome: 'rejected', outcomeStage: 'review', outcomeReason: reason });
    appendHistoryEvent(task, 'blocked', reason);
    return { succeeded: true, verdict: 'blocked', blockedReason: reason, blockedStage: 'review', factCheckVerdict };
  }

// ... [truncated for review: this function continues for 108 more line(s) not shown]
```

Problem:
The 308-line function is not one cohesive algorithm; it is a single entry point that sequentially runs six or seven independently authored gate subsystems (each stamped with a different date from 2026-08-24 through 09-03), interleaves their results, and folds them into a final verdict. Because every gate's logic—its inputs, its pass/fail criteria, its side-effects on shared mutable state—lives inline in the same scope, a change to one gate (say, the 09-02 policy check) forces the reader to hold the other six in working memory to confirm no variable is clobbered or an early-return path is missed. The accumulated length is therefore not "verbose" but structurally monolithic: there is no seam at which a reviewer can isolate one gate's behavior, and the function's cyclomatic complexity grows linearly with every new gate that gets appended.

Solution:
Extract each dated gate into its own named function (e.g., `evaluateBaselineGate`, `evaluatePolicyGate`, `evaluateRecencyGate`, `evaluateScopeGate`, `evaluateComplianceGate`, `evaluateFinalityGate`), each accepting a narrow, explicitly-typed context object and returning a small `{ pass, reason, metadata }` result. The top-level orchestrator then becomes a thin loop that builds the shared context once, calls each gate in a documented order, collects the result array, and applies the final aggregation rule. Any gate that mutates shared state should instead read from and write to the context object, making data flow visible in the signature rather than implicit in variable scope.

Benefits:
Each extracted gate becomes independently unit-testable with a minimal fixture, so a regression in the 09-02 policy check no longer requires exercising the full 308-line path. Code review shrinks from "read 308 lines and trace six interleaved state machines" to "read one 30–50 line function with a two-field input and a three-field output." Adding a seventh or eighth gate in the future becomes a new file (or a new function in the same file) plus one line in the orchestrator's call list, rather than another 40-line block spliced into an already-crowded scope, which directly reduces the probability of the variable-shadowing and early-exit bugs that monolithic gate chains are prone to.

### AC-26 · Decompose the 120-line merge endpoint into four single-responsibility helpers
Strength: Strong
Files: python/dashboard/app.py
Snippet:
```

@app.route("/api/git/branches/<path:branch>/merge", methods=["POST"])
def api_git_merge_branch(branch):
    repo_root = get_active_repo_root()
    if not repo_root:
        abort(404, description="no active project -- AGENT_MANAGER_REPO_ROOT is not resolvable")
    repo_root = Path(repo_root)

    # Never trust a caller-supplied branch string as a raw git ref beyond what THIS
    # process already enumerated itself -- re-derive the current list (cheap: cached
    # unless stale) and require an exact match, the same "only act on what we ourselves
    # already offered" gate api_task_archive/api_task_requeue's state allowlists use.
    branches = list_unmerged_branches(force=True)
    match = next((b for b in branches if b["branch"] == branch), None)
    if not match:
        abort(404, description=f"'{branch}' is not a currently-listed, pushed-but-unmerged agent/* branch")

    # A branch owned by a coordinator hub that hasn't finished (a stacked file-decompose
    # branch still missing its wiring commit + integration-gate pass) is not safe to merge
    # -- doing so 404s the moved routes. Block it unless the caller explicitly forces.
    hub = match.get("hub")
    if hub and not hub.get("readyToMerge") and not (request.get_json(silent=True) or {}).get("force"):
        prog = hub.get("progress") or {}
        gate = (hub.get("integrationGate") or {}).get("status")
        return jsonify({
            "succeeded": False,
            "reason": (
                f"'{branch}' belongs to coordinator hub {hub.get('id')} which is not finished "
                f"({prog.get('done')}/{prog.get('total')} task(s) done"
                + (f", integration gate {gate}" if gate else "")
                + "). Merging now would ship an incomplete decomposition. Re-send with "
                '{"force": true} only if you have verified the branch is actually complete.'
            ),
        }), 409

    lock_fd = _acquire_apply_lock()
    if lock_fd is None:
        abort(409, description="the pipeline is mid-apply right now -- try again in a few seconds")

    main_branch = match["mainBranch"]
    try:
        _run_git(["fetch", "origin"], repo_root)
        _run_git(["checkout", main_branch], repo_root)
        _run_git(["reset", "--hard", f"origin/{main_branch}"], repo_root)
        try:
            _run_git(["merge", "--no-ff", f"origin/{branch}", "-m", f"Merge {match['title']} (via dashboard)"], repo_root)
        except RuntimeError as merge_err:
            subprocess.run(["git", "merge", "--abort"], cwd=str(repo_root), capture_output=True, timeout=15)
            # match['willConflict']/['conflictFiles'] came from list_unmerged_branches's
            # own merge-tree preview a moment ago (same request, force-refreshed above) --
            # if it already predicted this exact outcome, say so plainly instead of
            # surfacing raw git stderr. Confirmed live 2026-08-18: an add/add conflict
            # between two independently-drafted candidate docs produced exactly this kind
            # of opaque failure with no indication of WHICH files or WHY.
            if match.get("willConflict") and match.get("conflictFiles"):
                files = ", ".join(match["conflictFiles"])
                raise RuntimeError(
                    f"conflicts with {main_branch} on: {files} -- this was flagged before you clicked merge; "
                    f"resolve by hand (e.g. combine both versions) rather than retrying, retrying will fail the same way"
                ) from merge_err
            raise merge_err
        _run_git(["push", "origin", main_branch], repo_root)
        try:
            _run_git(["push", "origin", "--delete", branch], repo_root)
        except RuntimeError as e:
            # Non-fatal -- the merge to main already succeeded and is the part that
            # matters; a leftover now-fully-merged remote branch is harmless clutter
            # (next list will filter it out via the ahead==0 check) rather than a real
            # failure worth reporting as one.
            logger.warning("Non-fatal: could not delete remote branch %r (repo: %s): %s", branch, repo_root, e)
    except RuntimeError as e:
        return jsonify({"succeeded": False, "reason": str(e)}), 500
    finally:
        _release_apply_lock(lock_fd)

    _invalidate_branch_cache()
    live_sync = _sync_live_checkout(main_branch)

    # Stamp mergedAt on the task record once its branch is actually merged (2026-08-22,
    # Grimmethy: "some way to prioritize what order adhoc tasks get completed in. Those
    # with dependencies on new adhoc tasks are absolutely going to need to be done after
    # the dependency is completed") -- this is the real "is this dependency satisfied"
    # signal task-sources.js's nextAdhocTask() checks before letting a dependent task
    # claim. Reaching queue/done/ alone isn't enough: a task there is only pushed to its
    # OWN branch, not merged, and every adhoc draft's git worktree starts from
    # origin/<mainBranch> -- a dependency's fix isn't actually visible to a dependent
    # task's fresh checkout until it's merged, confirmed live by the exact failure this
    # feature exists to prevent (a dependent task's diff going stale against code the
    # dependency hadn't landed yet). Best-effort: a task record not found (already
    # archived, or this merge came from some other source than the normal apply flow)
    # must never fail the merge itself, which already fully succeeded above.
    qdir = queue_dir()
    if qdir:
        task_id = branch.removeprefix("agent/")
        for candidate in (qdir / "done" / f"{task_id}.json", qdir / "done" / "_archived_no_action" / f"{task_id}.json"):
            if candidate.is_file():
                data = read_json_safe(candidate)
                if data is not None:
                    now_iso = datetime.now(timezone.utc).isoformat()
                    data["mergedAt"] = now_iso
                    # Close the task log with a terminal disposition event (see
                    # src/task-disposition.js) -- `mergedAt` alone is a field the dependency
                    # gate reads; an update audit reads the history, which used to stop at
                    # `applied`.
                    if data.get("terminalDisposition") != "merged":
                        hist = data.get("history")
                        if not isinstance(hist, list):
                            hist = data["history"] = []
                        hist.append({
                            "stage": "merged",
                            "at": now_iso,
                            "detail": f"merged into {main_branch} via the dashboard Unmerged Branches tab",
                        })
                        data["terminalDisposition"] = "merged"
                    try:
                        candidate.write_text(json.dumps(data, indent=2), encoding="utf-8")
                    except OSError as exc:
                        logger.error("Failed to persist merge-state for branch %r to %s: %s", branch, candidate, exc)
                        raise
                break

    return jsonify({"succeeded": True, "branch": branch, "mainBranch": main_branch, "liveSync": live_sync})
```

Problem:
The merge endpoint is 120 lines long, but the raw count is misleading: a large share of those lines are explanatory comments that document *why* each step is ordered the way it is. The real issue is that the function interleaves four concerns with different failure domains and change-frequencies—(A) input validation and authorization (repo-root check, branch re-derivation, hub-readiness policy, ~35 lines), (B) the git merge transaction itself (lock acquisition, fetch, checkout, reset, merge, conflict handling, push, remote-branch deletion, ~35 lines), (C) post-merge side-effects such as cache invalidation and live-checkout sync (~3 lines), and (D) task-record bookkeeping (locating the JSON file under `done/`, stamping `mergedAt`, appending to history, setting `terminalDisposition`, writing the file back, ~30 lines). Each concern has a distinct error surface (404/409 vs. 500/lock-contention vs. `OSError`/`json` parse) and a distinct change driver (new branch-ownership rules vs. new conflict strategies vs. cache-mechanism swaps vs. task-schema evolution), yet they are woven into one linear body. A change to the task schema, for example, forces the reviewer to re-read the entire git-transaction block to confirm it is untouched, and a new hub-readiness state requires hunting through the middle of a lock/merge sequence to find the authorization check.

Solution:
Extract four private helpers, each taking only the data it needs and returning a narrow result or raising a domain-specific exception: (1) `_validate_and_authorize_merge(repo_root, branch, hub_state)` returning a validated context object (resolved branch, confirmed hub-readiness); (2) `_execute_git_merge(context)` encapsulating the lock→fetch→checkout→reset→merge→conflict→push→delete-remote sequence and returning a merge-result record; (3) `_apply_post_merge_side_effects(context, merge_result)` for cache invalidation and live-checkout sync; (4) `_record_merge_in_task_file(done_dir, task_id, merge_result)` for the JSON locate/stamp/history/disposition/write-back cycle. The public endpoint function then becomes a thin ~15-line orchestrator that calls these four in order, maps their exceptions to the correct HTTP status codes, and logs at the boundary. The existing explanatory comments move with their respective blocks into the helpers, preserving the documentation while making each block independently scannable.

Benefits:
Each helper can be unit-tested in isolation with fakes (a mock git repo for B, a temp directory for D, a stubbed cache for C) without standing up the full HTTP layer or the other three concerns. Code review becomes targeted: a PR that changes the task schema touches only `_record_merge_in_task_file`, and the reviewer can verify the git-transaction block is byte-identical by diffing a single 35-line function rather than scrolling through 120 interleaved lines. The four helpers also make it trivial to add cross-cutting concerns—retry logic around the git transaction, structured logging around file I/O, or an audit hook after authorization—without risking accidental reordering of unrelated steps. Finally, the thin orchestrator makes the *intended* execution order and the error-mapping policy visible at a glance, which is the primary readability win for a new maintainer.

### AC-27 · Decompose pipeline-launch orchestrator into named sub-tasks
Strength: Strong
Files: python/dashboard/app.py
Snippet:
```


def _start_pipeline(raw_path: str, include_apply: bool, skip_push: bool) -> dict:
    """Writes the chosen path/toggles into agent-manager.env (creating the file if it
    doesn't exist yet) and spawns the relevant loops as real, visible console windows,
    same as launch.bat's own `start powershell.exe -NoExit ...` pattern -- shared by
    /api/pipeline/start and _restart_pipeline()."""
    record_project_used(raw_path)
    write_env_value(ENV_FILE_PATH, "AGENT_MANAGER_REPO_ROOT", raw_path)
    write_env_value(ENV_FILE_PATH, "AGENT_MANAGER_INCLUDE_APPLY", "true" if include_apply else "false")
    write_env_value(ENV_FILE_PATH, "AGENT_MANAGER_APPLY_SKIP_PUSH", "true" if skip_push else "false")

    # Fix, 2026-07-26 (Grimmethy: "I keep setting the Project tab's path to TaxHarvest,
    # but it doesn't stick -- navigating away and back reverts to agent-manager"):
    # get_active_repo_root() checks os.environ FIRST, only falling back to the .env FILE
    # if unset -- by design, so a project pre-configured via launch.bat's own env vars
    # wins at startup rather than a stale leftover .env value silently overriding it. But
    # writing the new path to the file above was never reflected back into THIS already-
    # running dashboard process's own os.environ, so get_active_repo_root() kept
    # returning whatever the dashboard happened to be launched with, forever -- no
    # dashboard restart, no amount of clicking Start Pipeline, would ever change what it
    # reported as active. Mutating os.environ here keeps the original precedence (an
    # externally-set env var still wins at the NEXT dashboard restart) while making an
    # in-dashboard project switch actually take effect and persist for the rest of this
    # process's lifetime, matching what the Project tab visibly promises.
    os.environ["AGENT_MANAGER_REPO_ROOT"] = raw_path

    # Fix, 2026-08-20 (Grimmethy: "I'm still only seeing the agent manager and it's clone
    # [in the Project tab] -- we should be able to select from any of the projects"):
    # AGENT_MANAGER_PIPELINE_DIR/AGENT_MANAGER_DOMAINS_PATH were NEVER written here at
    # all -- only REPO_ROOT/INCLUDE_APPLY/SKIP_PUSH were -- so switching to a project with
    # its own dedicated pipeline dir (several new plugin repos this session each got one,
    # separate from repoRoot so pipeline internals don't land inside the tracked git repo)
    # silently kept whatever pipelineDir the PREVIOUSLY active project left behind in the
    # shared .env, real risk of one project's tasks landing in a completely different
    # project's live queue. If this repoRoot was already registered (via a prior Start
    # Pipeline, or set up directly -- see record_project_registry_entry), honor ITS
    # pipelineDir/domainsPath instead of leaving the stale previous value in place; a
    # genuinely first-time repo still falls through to the old raw_path-based default
    # below, unchanged.
    normalized_raw_path = os.path.normpath(raw_path)
    existing_registration = next(
        (e for e in read_project_registry() if os.path.normpath(e.get("repoRoot", "")) == normalized_raw_path),
        None,
    )
    if existing_registration and existing_registration.get("pipelineDir"):
        write_env_value(ENV_FILE_PATH, "AGENT_MANAGER_PIPELINE_DIR", existing_registration["pipelineDir"])
        os.environ["AGENT_MANAGER_PIPELINE_DIR"] = existing_registration["pipelineDir"]
        if existing_registration.get("domainsPath"):
            write_env_value(ENV_FILE_PATH, "AGENT_MANAGER_DOMAINS_PATH", existing_registration["domainsPath"])
            os.environ["AGENT_MANAGER_DOMAINS_PATH"] = existing_registration["domainsPath"]

    env_overrides = read_env_file(ENV_FILE_PATH)
    env_overrides["AGENT_MANAGER_REPO_ROOT"] = raw_path
    child_env = {**os.environ, **env_overrides}

    _ensure_task_domains(child_env, raw_path, list(read_active_job_types()))

    # Same pipelineDir/domainsPath resolution _ensure_task_domains just used above --
    # recorded here so a later brain-dump routing decision can locate THIS project's
    # queue even after a different project becomes active (project-history.json alone
    # only ever stored the bare repoRoot).
    pipeline_dir_for_registry = child_env.get("AGENT_MANAGER_PIPELINE_DIR") or raw_path
    domains_path_for_registry = child_env.get("AGENT_MANAGER_DOMAINS_PATH") or str(Path(pipeline_dir_for_registry) / "task-domains.json")
    record_project_registry_entry(raw_path, pipeline_dir_for_registry, domains_path_for_registry)

    # Explicit pipeline start is a "GPU work now" signal -- stomp any ComfyUI GPU lease
    # PromptForge left behind so the local-model daemons don't yield their ticks to a
    # generation that isn't the priority anymore (see comfyui_lease_held in
    # agent-manager-common.sh). scripts/launch.sh does the same on the Linux path; this
    # also covers the Windows .ps1 path below.
    _comfy_lease = Path(
        os.environ.get("AGENT_MANAGER_COMFY_LEASE_PATH")
        or (Path(os.environ.get("HOME") or "~").expanduser()
            / ".local/state/agent-manager/comfyui-lease.json")
    )
    try:
        _comfy_lease.unlink(missing_ok=True)
    except OSError as exc:
        logger.debug("ComfyUI lease unlink failed: %s", exc, exc_info=True)

    if os.name != "nt":
        import platform, subprocess as sp, shlex
        LOG_DIR = Path(os.environ.get("HOME") or "~").expanduser() / ".local/state/agent-manager/logs"
        launch_py = str(PACKAGE_ROOT / 'scripts' / 'launch.sh')
        if not Path(launch_py).is_file():
            return {"started": False, "reason": f"{launch_py} missing; cannot start daemons on Linux without a working launch script."}
        subprocess.Popen(
            ["bash", launch_py],
            env=child_env,
            cwd=str(PACKAGE_ROOT),
            stdout=(LOG_DIR / 'launch-python.log').open('a'),
            stderr=sp.STDOUT,
            start_new_session=True,
        )
        return {"started": True, "repoRoot": raw_path}

    creationflags = subprocess.CREATE_NEW_CONSOLE
    scripts = [
        (["powershell.exe", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", str(SRC_DIR / "local-worker.ps1"), "-InstanceId", "worker-1"], "Local Worker 1"),
        (["powershell.exe", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", str(SRC_DIR / "review-runner.ps1")], "Local Review Runner"),
        (["powershell.exe", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", str(SRC_DIR / "queue-watchdog.ps1")], "Queue Watchdog"),
    ]
    if include_apply:
        scripts.insert(2, (["powershell.exe", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", str(SRC_DIR / "apply-runner.ps1")], "Apply Runner"))

    for args, _label in scripts:
        subprocess.Popen(args, env=child_env, creationflags=creationflags, cwd=str(PACKAGE_ROOT))

    return {"started": True, "repoRoot": raw_path, "includeApply": include_apply, "skipPush": skip_push}
```

Problem:
The launch handler is ~108 lines (≈80 executable after the two multi-line fix-comment blocks) and interleaves six distinct responsibilities in a single linear body: (1) persisting the chosen path/toggles to `.env` and mirroring them into `os.environ`, (2) resolving `pipelineDir`/`domainsPath` from the project registry and writing them back, (3) building the merged `child_env` dict and calling `_ensure_task_domains`, (4) recording a new or updated project-registry entry, (5) stomping the ComfyUI GPU lease file, and (6) the platform branch that spawns `launch.sh` on Linux or four-to-five PowerShell console windows on Windows. None of these steps is individually complex, but a reader who wants to understand "where does the GPU lease get cleared?" must wade through the registry and env-file bookkeeping above it, and a reviewer adding a new pre-launch side-effect has no obvious insertion point. Each sub-task also has its own failure mode (file-write I/O, registry lookup miss, subprocess spawn error) that is currently entangled in one try/except scope, making targeted error handling and unit testing awkward.

Solution:
Extract four small, clearly-named helpers that the top-level handler calls in sequence: `_persist_launch_env(path, toggles)` for responsibility 1 (write `.env` + mirror `os.environ`); `_resolve_and_register_project(project_id)` for responsibilities 2 and 4 (look up or create the registry entry, write `pipelineDir`/`domainsPath` back to `.env`/`os.environ`, and return the resolved paths); `_acquire_gpu_lease()` for responsibility 5 (stomp the lease file, with its own narrow try/except); and `_spawn_pipeline(child_env, pipeline_dir)` for responsibility 6 (the `os.name` branch that launches `launch.sh` or the PowerShell windows). The top-level handler then reads as a short, readable pipeline: persist env → resolve project → acquire lease → spawn, with the `child_env` construction (responsibility 3) left inline since it is a two-line dict merge that glues the pieces together. Each helper is 10–30 lines, has a single return type, and can be tested in isolation with a mocked filesystem or `os.environ`.

Benefits:
A reviewer scanning the diff for a change to the GPU-lease logic now sees a one-line call to `_acquire_gpu_lease()` instead of hunting through 30 lines of registry code; a developer adding a new pre-launch side-effect has an obvious place to insert a new helper call. Each extracted function can be unit-tested independently (e.g., verify that `_persist_launch_env` writes the correct `.env` keys without actually spawning a process), which is currently impossible because the launch step is in the same scope. The `os.name` platform branch, which is the most likely site for future OS-specific tweaks, becomes a self-contained function whose signature makes its inputs (`child_env`, `pipeline_dir`) explicit rather than implicit closures over the outer scope.

### AC-28 · Decompose coordinator sweep into per-concern helpers
Strength: Strong
Files: src/coordinator-sweep.js
Snippet:
```
}

function coordinatorSweep({ pipelineDir, repoRoot, runGate = runStackedGate } = {}) {
  const coordDir = path.join(pipelineDir, 'queue', 'coordinating');
  const doneDir = path.join(pipelineDir, 'queue', 'done');
  let resolvedRepoRoot = repoRoot;
  if (resolvedRepoRoot === undefined) { try { ({ repoRoot: resolvedRepoRoot } = getConfig()); } catch { resolvedRepoRoot = null; } }
  const summary = { checked: 0, updated: 0, completed: 0, errors: 0 };

  let names;
  try {
    names = fs.readdirSync(coordDir).filter((f) => f.endsWith('.json'));
  } catch (err) {
    if (err.code === 'ENOENT') return summary; // no coordinating/ dir yet -- nothing to sweep
    summary.errors += 1;
    console.error(`[coordinator-sweep] readdirSync failed for ${coordDir}: ${err.code || 'UNKNOWN'} -- ${err.message}`);
    return summary;
  }

  for (const name of names) {
    const file = path.join(coordDir, name);
    let parent;
    try {
      parent = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      summary.errors += 1;
      continue; // a malformed coordinating file is not this sweep's problem to fix
    }
    if (!Array.isArray(parent.subTasks) || parent.subTasks.length === 0) {
      // A coordinating parent with no checklist is a bug upstream -- complete it out so it
      // does not sit here forever.
      parent.status = 'done';
      parent.doneMarker = 'coordinator had no sub-tasks -- completed';
      stampHubMerged(parent);
      appendHistoryEvent(parent, 'done', parent.doneMarker);
      moveToDone(file, doneDir, name, parent);
      summary.checked += 1;
      summary.completed += 1;
      continue;
    }

    summary.checked += 1;
    let doneCount = 0;
    const recById = new Map();
    for (const st of parent.subTasks) {
      const rec = st && st.id ? findTaskRecordById(pipelineDir, st.id) : null;
      recById.set(st && st.id, rec);
      st.status = classifyChildStatus(rec);
      if (TERMINAL_GOOD.has(st.status)) doneCount += 1;
    }
    parent.progress = { done: doneCount, total: parent.subTasks.length };
    parent.lastReconciledAt = new Date().toISOString();

    // Stuck-chain detection: surface a hub that can never complete on its own instead of
    // leaving it frozen at partial progress. The hub STAYS in coordinating/ so the sweep
    // keeps reconciling it (and auto-clears / auto-completes if the children get unstuck);
    // what changes is a `coordinatorBlocked` marker + a `blockedReason` the dashboard
    // renders, and after a grace period an `escalated` flag + a louder history event.
    if (doneCount < parent.subTasks.length) {
      const stuck = findStuckChildren(parent.subTasks, recById);
      const now = new Date().toISOString();
      if (stuck.length > 0) {
        const signature = stuck.map((s) => `${s.id}:${s.why}`).sort().join(' | ');
        if (!parent.coordinatorBlocked || parent.coordinatorBlocked.signature !== signature) {
          parent.coordinatorBlocked = { signature, since: now, children: stuck, escalated: false };
          appendHistoryEvent(parent, 'blocked', `coordinator stuck: ${stuck.map((s) => `${s.id} -- ${s.why}`).join('; ')}`.slice(0, 500));
          summary.blocked = (summary.blocked || 0) + 1;
        }
        parent.blockedReason = `${stuck.length} sub-task(s) can't proceed: ${stuck.map((s) => `${s.id.replace(/^adhoc-/, '')} (${s.why})`).join('; ')}`.slice(0, 400);
        const escalateMs = stuckEscalateMs();
        const stuckForMs = Date.now() - Date.parse(parent.coordinatorBlocked.since || now);
        if (escalateMs > 0 && stuckForMs >= escalateMs && !parent.coordinatorBlocked.escalated) {
          parent.coordinatorBlocked.escalated = true;
          parent.coordinatorBlocked.escalatedAt = now;
          appendHistoryEvent(parent, 'advisory',
            `coordinator hub stuck ${Math.floor(stuckForMs / 86400000)}d -- needs a human: resolve/requeue/archive ${stuck.map((s) => s.id).join(', ')}, or archive this hub`);
          summary.escalated = (summary.escalated || 0) + 1;
        }
      } else if (parent.coordinatorBlocked) {
        delete parent.coordinatorBlocked;
        delete parent.blockedReason;
        appendHistoryEvent(parent, 'advisory', 'coordinator unblocked -- sub-tasks progressing again');
        summary.unblocked = (summary.unblocked || 0) + 1;
      }
    }

    const allChildrenDone = doneCount === parent.subTasks.length;

    // A child went back to work (e.g. a human requeued the wiring step after a gate
    // failure) -- re-arm the gate so the next all-done transition re-checks the branch.
    if (!allChildrenDone && parent.integrationGate
        && ['failed', 'errored'].includes(parent.integrationGate.status)) {
      parent.integrationGate = { status: 'pending', reArmedAt: new Date().toISOString() };
      delete parent.blockedReason;
      delete parent.coordinatorBlocked;
    }

    // Stacked decompose hub: children done is necessary but not sufficient -- the shared
    // branch must actually import and keep its route table. Gate runs once; its result is
    // cached on the hub so a quiet every-tick sweep never re-runs a worktree build.
    if (allChildrenDone && parent.mode === 'stacked' && parent.integrationGate
        && parent.integrationGate.status === 'pending') {
      const res = runGate(parent, resolvedRepoRoot);
      const now = new Date().toISOString();
      if (res.skipped) {
        parent.integrationGate = { status: 'skipped', at: now };
      } else if (res.ok) {
        parent.integrationGate = { status: 'passed', at: now, checks: res.checks || [] };
        appendHistoryEvent(parent, 'advisory', `integration gate passed on ${parent.branch} -- ${(res.checks || []).map((c) => `${c.name}:${c.status}`).join(' ')}`);
        summary.gatePassed = (summary.gatePassed || 0) + 1;
      } else {
        const failing = (res.checks || []).filter((c) => c.status === 'fail');
        parent.integrationGate = { status: res.errored ? 'errored' : 'failed', at: now, checks: res.checks || [] };
        parent.blockedReason = `decompose integration gate ${res.errored ? 'errored' : 'failed'} on ${parent.branch}: ${failing.map((c) => `${c.name} -- ${c.detail}`).join(' | ')}`.slice(0, 600);
        parent.coordinatorBlocked = {
          signature: `integration-gate:${failing.map((c) => c.name).sort().join(',')}`,
          since: now, escalated: false,
          children: [{ id: parent.subTasks[parent.subTasks.length - 1].id, why: `integration gate failed: ${failing.map((c) => c.name).join(', ')}` }],
        };
        appendHistoryEvent(parent, 'blocked', parent.blockedReason);
        summary.gateFailed = (summary.gateFailed || 0) + 1;
        // errored (not failed) -> let a later tick retry the gate itself.
        if (res.errored) parent.integrationGate.status = 'pending';
        try { fs.writeFileSync(file, JSON.stringify(parent, null, 2)); summary.updated += 1; }
        catch (err) { console.error(`coordinator-sweep: failed to write ${file}: ${err.message}`); summary.errors += 1; }
        continue;
      }
    }

    const gateClear = !(parent.mode === 'stacked' && parent.integrationGate
      && ['failed', 'pending'].includes(parent.integrationGate.status) && allChildrenDone);

    if (allChildrenDone && gateClear) {
      parent.status = 'done';
      parent.doneMarker = `coordinator complete: all ${parent.subTasks.length} sub-task(s) done`;
      stampHubMerged(parent);
      appendHistoryEvent(parent, 'done', parent.doneMarker);
      moveToDone(file, doneDir, name, parent);
      summary.completed += 1;
    } else {
      try {
        fs.writeFileSync(file, JSON.stringify(parent, null, 2));
        summary.updated += 1;
      } catch (err) {
        console.error(`coordinator-sweep: failed to write ${file}: ${err.message}`);
        summary.errors += 1;
      }
    }
  }

  return summary;
}
```

Problem:
The sweep function packs five logically independent concerns into a single 150-line body: directory bootstrap and ENOENT guarding, per-file JSON parsing with a "no subTasks" fast-path, child-status reconciliation (classifying each subTask and writing back `st.status` / `parent.progress`), stuck-chain detection with its own mini state-machine (coordinatorBlocked set/clear, signature comparison, grace-period escalation, `blockedReason` string assembly), and gate re-arming when a child returns to work. Each concern has its own branching, side-effects, and failure modes, yet they are interleaved in one linear flow. A developer fixing the escalation grace-period logic must scroll past unrelated I/O and reconciliation code to find the relevant lines, and a change to the JSON-parse guard risks inadvertently touching the stuck-chain state transitions because they share the same local scope and mutable variables.

Solution:
Extract four named helpers from the body, keeping the outer function as a thin orchestrator that calls them in sequence. First, `resolveSweepDirs(config)` handles directory resolution, the ENOENT guard, and the directory scan, returning an array of file paths or an empty list. Second, `loadSubTasks(filePath)` encapsulates the per-file JSON parse, the "no subTasks" fast-path, and returns a normalized record or null. Third, `reconcileChildStatuses(subTasks, recById)` performs the classification loop and writes `st.status` / `parent.progress`, returning the updated `recById` map. Fourth, `detectAndEscalateStuckChains(recById, coordinatorBlocked)` owns the signature comparison, grace-period check, `blockedReason` construction, and the set/clear of `coordinatorBlocked`, returning any unblock actions to apply. The residual gate re-arming (a few lines) can stay inline in the orchestrator or become a tiny `rearmGate(child)` call. The outer function shrinks to roughly 25–30 lines of sequencing and logging.

Benefits:
Each extracted helper can be unit-tested in isolation with a stubbed file system or in-memory record map, without exercising the full I/O path. Code review becomes tractable because a diff touching escalation logic no longer sits inside a 150-line hunk that also touches JSON parsing. New contributors can understand the sweep pipeline by reading the orchestrator's five sequential calls rather than tracing a single dense block, and the mutable shared state (`coordinatorBlocked`, `recById`) is now explicitly passed and returned, making data flow visible at the call sites rather than implicit through a shared local scope.

### AC-29 · Decompose runIntegrationGate into per-check and lifecycle helpers
Strength: Strong
Files: src/decompose-integration-gate.js
Snippet:
```
// -- only for a setup failure it genuinely can't proceed past (e.g. cannot create the
// worktree), which the caller treats as an errored (not failed) gate and retries later.
function runIntegrationGate({ repoRoot, branch, mainBranch = 'master', sourceFile, routes = [], exec = realExec } = {}) {
  const checks = [];
  const srcDir = path.dirname(sourceFile);
  const srcModule = path.basename(sourceFile).replace(/\.py$/, '');
  const isPy = /\.py$/.test(sourceFile);
  const wtBase = fs.mkdtempSync(path.join(os.tmpdir(), 'decompose-gate-'));
  const branchWt = path.join(wtBase, 'branch');
  const mainWt = path.join(wtBase, 'main');
  const cleanup = [];

  const record = (name, status, detail) => checks.push({ name, status, detail: String(detail || '').slice(0, 2000) });
  const done = () => {
    for (const wt of cleanup) {
      try { exec('git', ['worktree', 'remove', '--force', wt], { cwd: repoRoot }); } catch { /* best-effort */ }
    }
    try { fs.rmSync(wtBase, { recursive: true, force: true }); } catch { /* best-effort */ }
    const failed = checks.filter((c) => c.status === 'fail');
    return { ok: failed.length === 0, checks, branch };
  };

  try {
    exec('git', ['worktree', 'add', '--detach', branchWt, branch], { cwd: repoRoot });
    cleanup.push(branchWt);
  } catch (e) {
    record('setup', 'fail', `could not create worktree for ${branch}: ${e.message}`);
    return { ...done(), errored: true };
  }

  if (!isPy) {
    record('language', 'skip', `integration gate only covers Python decompositions; ${sourceFile} left to review`);
    return done();
  }

  // 1. py_compile every changed / new .py file on the branch.
  let changed = [];
  try {
    const out = exec('git', ['diff', '--name-only', `${mainBranch}...${branch}`], { cwd: repoRoot });
    changed = out.split('\n').map((s) => s.trim()).filter((s) => s.endsWith('.py'));
  } catch (e) {
    record('py_compile', 'skip', `could not list changed files: ${e.message}`);
  }
  const toCompile = Array.from(new Set([sourceFile, ...changed])).filter((f) => fs.existsSync(path.join(branchWt, f)));
  if (toCompile.length) {
    try {
      exec('python3', ['-m', 'py_compile', ...toCompile], { cwd: branchWt });
      record('py_compile', 'pass', `${toCompile.length} file(s): ${toCompile.join(', ')}`);
    } catch (e) {
      record('py_compile', 'fail', `${(e.stderr || e.stdout || e.message)}`);
      return done();
    }
  }

  // 2. import the source module -- catches the circular import the isolated compile can't.
  try {
    exec('python3', ['-c', `import ${srcModule}`], { cwd: path.join(branchWt, srcDir), timeout: 30_000 });
    record('import', 'pass', `import ${srcModule} from ${srcDir} exits 0`);
  } catch (e) {
    const msg = String(e.stderr || e.stdout || e.message);
    // A bare ModuleNotFoundError for a third-party dep means this environment can't import
    // the app at all -- not the branch's fault. A circular import / NameError / ImportError
    // for a first-party name IS the branch's fault.
    if (/ModuleNotFoundError: No module named '(flask|werkzeug|jinja2)'/.test(msg) && !/circular|partially initialized/.test(msg)) {
      record('import', 'skip', `app dependencies not installed here: ${msg.split('\n').pop()}`);
      return done();
    }
    record('import', 'fail', msg);
    return done();
  }

  // 3. url_map invariant: identical route table on main and on the branch.
  try {
    exec('git', ['worktree', 'add', '--detach', mainWt, mainBranch], { cwd: repoRoot });
    cleanup.push(mainWt);
  } catch (e) {
    record('url_map', 'skip', `could not create ${mainBranch} worktree: ${e.message}`);
    return done();
  }
  const dump = (wt) => {
    const p = path.join(wt, srcDir, '.decompose_url_dump.py');
    fs.writeFileSync(p, URL_MAP_DUMP);
    try { return exec('python3', ['.decompose_url_dump.py'], { cwd: path.join(wt, srcDir), timeout: 30_000 }); }
    finally { try { fs.unlinkSync(p); } catch { /* ignore */ } }
  };
  let mainRules; let branchRules;
  try { mainRules = dump(mainWt).trim(); branchRules = dump(branchWt).trim(); } catch (e) {
    record('url_map', 'skip', `route dump failed: ${String(e.stderr || e.message).split('\n').pop()}`);
    return done();
  }
  if (mainRules.startsWith('IMPORT_ERROR') || branchRules.startsWith('IMPORT_ERROR')) {
    record('url_map', 'fail', `route dump import error -- main: ${mainRules.slice(0, 300)} | branch: ${branchRules.slice(0, 300)}`);
    return done();
  }
  let cmp;
  try { cmp = diffRouteTables(mainRules, branchRules); } catch {
    record('url_map', 'skip', 'route dump was not JSON'); return done();
  }
  if (!cmp.ok) {
    record('url_map', 'fail',
      `route table changed -- a pure relocation must not. Dropped: ${cmp.droppedRules.join(' | ') || 'none'}. Added: ${cmp.addedRules.join(' | ') || 'none'}.`);
    return done();
  }
  record('url_map', 'pass', `${cmp.count} routes, rule table unchanged (endpoints re-homed as expected)`);

  // 4. boot smoke -- opt-in (needs a runnable app + a free port).
  if (process.env.AGENT_MANAGER_DECOMPOSE_BOOT_SMOKE === 'true' && routes.length) {
    record('boot', 'skip', 'boot smoke requested but not implemented in this build -- import + url_map cover the crash modes');
  }

  return done();
}
```

Problem:
`runIntegrationGate` spans roughly 110 lines and interweaves three distinct responsibilities—worktree lifecycle management (create, exec, cleanup, teardown), per-check error-interpretation logic (distinguishing missing third-party deps from circular imports via regex over stderr, handling `IMPORT_ERROR` sentinels and JSON-parse failures in the `url_map` check), and result aggregation via the `done()` closure that captures `checks`, `cleanup`, `wtBase`, and `branch` from the outer scope. Because the worktree teardown (`cleanup.push(...)`, `done()`) is threaded through the body of each check rather than isolated, a reader must track which worktree is alive and who owns its cleanup across the entire span. The per-check logic (e.g., the import check's stderr regex, the `url_map` check's structural diff) is only exercisable today by spinning up two git worktrees, writing a temp `.py` file, and exec-ing `python3`, which makes unit-testing each decision path impractical and pushes all verification into slow integration tests.

Solution:
Extract the worktree setup and teardown into a `setupWorktrees(repoRoot, branch, mainBranch)` helper that returns `{ branchWt, mainWt, cleanup }`, and a `teardownWorktrees(cleanup)` wrapper that runs all pushed cleanup steps and unlinks temp files. Extract each numbered check into its own small, clearly-named function—`checkPyCompile(ctx)`, `checkImportResolution(ctx)`, `checkUrlMap(ctx)`, `checkRuntimeBehavior(ctx)`—where `ctx` is a plain object carrying `branchWt`, `mainWt`, `sourceFile`, `exec`, and a `record(result)` callback. Each check function returns a `CheckResult` and owns its own error-interpretation logic (the stderr regex, the sentinel handling, the JSON diff) without touching worktree lifecycle. The top-level `runIntegrationGate` then shrinks to a ~20-line orchestration: call `setupWorktrees`, run the four checks in order via a small loop or explicit sequence, call `teardownWorktrees`, and aggregate results.

Benefits:
Each per-check function becomes independently unit-testable by passing a mock `ctx` with a stubbed `exec` that returns canned stderr or JSON, eliminating the need for real worktrees in most test cases. The worktree lifecycle is visible in exactly one place, so a reviewer can verify cleanup correctness (no leaked worktrees, no missing `unlink` calls) in a single 15-line function rather than scanning 110 lines for interleaved `cleanup.push` calls. The `done()` closure's implicit captured state disappears; the orchestration function's data flow is explicit—inputs in, `CheckResult[]` out—making the contract obvious in code review and in the function's type signature.

### AC-30 · Decompose the five-phase `acquire()` protocol into named sub-functions
Strength: Strong
Files: src/gpu-arbiter.js
Snippet:
```
// holding, a background interval re-touches the ticket and, if cancelRequested lands,
// invokes onCancel() exactly once -- the caller wires that to abort its model call.
function acquire(instancesDir, { cls = DEFAULT_CLASS, model, taskId = null, phase = null, onCancel = null } = {}) {
  const dir = ticketsDir(instancesDir, model);
  fs.mkdirSync(dir, { recursive: true });

  const myRank = classRank(cls);
  const seq = String(Date.now()).padStart(16, '0');
  const name = `${seq}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.json`;
  const fp = path.join(dir, name);
  const mySeqNum = Number(seq);

  writeTicketAtomic(fp, {
    pid: process.pid, cls, taskId, phase,
    startedAt: nowIso(), holding: false, cancelRequested: false,
  });

  // If this pid already holds a place ticket (holdPlace) of equal-or-higher priority for
  // this model, FIFO position is already reserved -- an inner per-turn acquire must not
  // re-queue behind peers that arrived AFTER the place (that would deadlock: the place
  // blocks those peers, and those peers would block this turn). Skip the wait loop; the
  // real flock still serialises the actual model call.
  const holdsPlace = liveTickets(instancesDir, model).some(
    (t) => t.pid === process.pid && t.place && classRank(t.cls) <= myRank,
  );

  const deadline = Date.now() + overallTimeoutMs();

  try {
    for (;;) {
      if (holdsPlace) break;
      if (Date.now() >= deadline) {
        safeUnlink(fp);
        throw new Error(`gpu-arbiter: '${cls}' ticket for model '${model || '(default)'}' timed out waiting to reach the head of the queue`);
      }
      touch(fp);
      const tickets = liveTickets(instancesDir, model);
      const mine = tickets.find((t) => t._name === name);
      if (!mine) {
        // our ticket was swept (we were too slow to re-touch, or a clock jump) -- re-add.
        writeTicketAtomic(fp, { pid: process.pid, cls, taskId, phase, startedAt: nowIso(), holding: false, cancelRequested: false });
        continue;
      }
      if (mine.cancelRequested) {
        safeUnlink(fp);
        const err = new Error('gpu-arbiter: cancelled while waiting');
        err.gpuArbiterCancelled = true;
        throw err;
      }
      const higherExists = tickets.some((t) => t._name !== name && t.pid !== process.pid && classRank(t.cls) < myRank);
      // A ticket owned by THIS pid at our own class (typically a holdPlace() place-holder
      // for a chat tool loop, or a re-added ticket after a sweep) is not a competitor --
      // this process already has its spot.
      const earlierPeer = tickets.some((t) => t._name !== name && t.pid !== process.pid
        && classRank(t.cls) === myRank && t._seq < mySeqNum);
      if (!higherExists && !earlierPeer) break;
      sleepSync(POLL_MS);
    }
  } catch (err) {
    safeUnlink(fp);
    throw err;
  }

  // At the head -- take the real mutex. skipPriorityBackoff: the ARBITER is the priority
  // mechanism now; sfl's own .discuss-waiting backoff would just make us wait on the
  // compat marker the arbiter itself drops for interactive tickets.
  const compat = interactiveCompatMarker(instancesDir, cls);
  let flockHandle;
  try {
    flockHandle = sfl.acquire(instancesDir, model, { skipPriorityBackoff: true });
  } catch (err) {
    compat.remove();
    safeUnlink(fp);
    throw err;
  }
  patchTicket(fp, { holding: true });

  let cancelled = false;
  let released = false;
  const watcher = setInterval(() => {
    if (released) return;
    touch(fp);
    compat.refresh();
    const cur = readTicket(fp);
    if (cur && cur.cancelRequested && !cancelled) {
      cancelled = true;
      if (typeof onCancel === 'function') {
        try { onCancel(); } catch { /* best-effort */ }
      }
    }
  }, REFRESH_MS);
  if (typeof watcher.unref === 'function') watcher.unref();

  return {
    release() {
      if (released) return;
      released = true;
      clearInterval(watcher);
      try { sfl.release(flockHandle); } catch { /* already released */ }
      compat.remove();
      safeUnlink(fp);
    },
    cancelled: () => cancelled,
  };
}
```

Problem:
The `acquire()` function at roughly 103 lines is not merely padded with long string literals or a flat config table; it is a five-phase protocol (ticket creation, place-holder shortcut, polling wait loop, real mutex acquisition, and background watcher setup) in which at least two phases carry non-trivial branching logic. Phase 3 (the polling loop, ~35 lines) contains four distinct edge-case branches—sweep recovery, cancellation detection, higher-priority peer exists, earlier-peer exists—that a reader must hold simultaneously in working memory to verify any single one. Phase 5 (~30 lines) introduces a mutable `cancelled`/`released` pair and a `setInterval` closure that outlives the call, making the function's lifetime semantics opaque. Because all five phases are inlined in one procedural body, a unit test author cannot exercise the arbitration logic or the watcher lifecycle in isolation without also exercising filesystem setup and mutex acquisition, and a reviewer must track state mutations across the entire span to confirm no phase clobbers another's invariants.

Solution:
Extract four named helpers that each own one or two phases, leaving `acquire()` as a thin orchestrator of roughly 20–25 lines. (1) `createTicket(instancesDir, opts)` – phase 1: unique-name generation, directory setup, atomic write. (2) `shouldSkipWait(ticket, instancesDir)` – phase 2: the place-holder shortcut check returning a boolean. (3) `waitForSlot(ticket, instancesDir, opts)` – phase 3: the polling loop with its four branches (sweep recovery, cancel, higher-priority, earlier-peer), returning either a resolved slot or a rejection reason. (4) `attachWatcher(ticket, instancesDir, opts)` – phase 5: the `setInterval` re-touch, cancel callback wiring, and the `release()` closure, returning the handle object. Phase 4 (real `sfl.acquire` + `patchTicket`) is short enough (~15 lines) to remain inline in the orchestrator or to fold into `waitForSlot`'s tail. Each helper takes only the data it needs, so the orchestrator reads top-to-bottom as a checklist of the protocol's steps.

Benefits:
Each extracted helper has a single, nameable responsibility that maps directly to a unit test: `shouldSkipWait` can be tested with a mocked filesystem in two lines, `waitForSlot` can be tested with a fake clock and a stubbed peer list without touching `sfl.acquire`, and `attachWatcher` can be tested for correct interval cleanup and cancel propagation in isolation. Code review becomes phase-scoped—a reviewer checking the arbitration logic reads only `waitForSlot` and its four branches rather than scanning 103 lines for the relevant block. The orchestrator's short body also makes it immediately obvious at a glance which phases exist and in what order, reducing the cognitive load on anyone onboarding to the arbiter.

### AC-31 · Decompose the 144-line adhoc escalation ladder into per-tier functions
Strength: Strong
Files: src/local-draft.js
Snippet:
```
// strict, line-based format; a freeform rewrite is not a safe way to edit one) -- every
// path here returns a final draftTask result directly instead.
async function draftAdhocBranch(task, {
  maybeLocked, recordModelCall, attempt, resolvedLocalCall, resolvedCallIsLocal,
  draftAdhocViaHarnessSearchFn, draftAdhocViaLocalAgenticFn, draftAdhocViaLocalAgenticWriteFn,
}) {
  // Tiered LOCAL escalation (2026-09-01, Grimmethy: "reasoning workers are supposed to go
  // through qwen. Claude needs to be removed as a dependency from that system"). Every
  // tier runs the local model against an isolated worktree:
  //   1. harness-search  -- cheap, single-shot, grep-grounded blind diff (proven).
  //   2. local-agentic   -- multi-turn, READ-ONLY tools, emits a Group-B diff (opt-in).
  //   3. local-agentic-WRITE -- multi-turn with real edit/write/run_bash in a worktree
  //      (default-on; this is what the deleted Claude adhoc-agentic-draft.js used to do).
  // Tiers 1-2 return {applied, succeeded, reason?}: applied -> done; declined -> next
  // tier. Tier 3 returns a terminal draftTask-shaped verdict (implemented / blocked /
  // needs-clarification) -- if it can't do the task it BLOCKS for a human. No Claude
  // fallback. All tiers are unconditionally lock-wrapped (always local).
  //
  // Each tier is bracketed with an 'implement-started' checkpoint. The ladder emits no
  // other history until a tier resolves, and tier 3 is a multi-turn agentic pass that
  // routinely runs for many minutes -- so without these, a task killed mid-ladder (or one
  // that keeps dying in tier 3) shows only '... -> plan-done' and the Pipeline History
  // looks cut short. With main()'s persist hook each one lands on disk the moment it fires,
  // so the log shows exactly how far the draft got. (2026-08-31, Grimmethy: "the task log
  // gets cut short" -- observed on a stubborn brain-dump adhoc looping in tier 3.)

  // PRELIMINARY DECOMPOSE CHECK (2026-09-02): one cheap model call, no tool loop, run
  // BEFORE any agentic tier. A task that is genuinely 5 endpoints + a UI + tests wastes a
  // full 35-turn tier-3 pass (and 2 retries) discovering that; catch it here instead. Only
  // on a FRESH task -- a retry / re-scoped / already-decomposed task has specific feedback
  // to act on and skips this. The decompose verdict flows straight to review -> coordinator
  // exactly like a RESOLUTION: decompose from tier 3.
  const preliminaryDecomposeEnabled = process.env.AGENT_MANAGER_PRELIMINARY_DECOMPOSE !== 'false';
  const isFreshAdhoc = !task.localRejectCount
    && !(Array.isArray(task.priorRejectionFeedback) && task.priorRejectionFeedback.length)
    && !task.rescopedFromDecompose
    && !task.autoDecomposeCount
    && !task.atomic // a file-decompose child IS the output of a decomposition -- re-splitting it loops
    && task.adhocResolution !== 'decompose';
  if (preliminaryDecomposeEnabled && isFreshAdhoc) {
    const split = await maybeLocked(resolvedCallIsLocal !== false, () => runDecomposePass(task, { mode: 'preliminary', call: resolvedLocalCall }), 'decompose-check');
    if (split && split.subTasks.length >= 2) {
      appendHistoryEvent(task, 'implement-started', `adhoc: preliminary size check -> decompose (${split.subTasks.length} pieces)`);
      task.adhocResolution = 'decompose';
      task.subTaskProposals = split.subTasks;
      task.rawDiff = '';
      task.implementResponse = `Preliminary size check: this task spans ${split.subTasks.length} independent pieces, so it was decomposed before any implementation attempt.`;
      concludeDraft(task);
      return { succeeded: true, blocked: false };
    }
  }

  appendHistoryEvent(task, 'implement-started', 'adhoc tier 1/3: harness-search (cheap grep-grounded blind diff)');
  const harnessResult = await maybeLocked(true, () => draftAdhocViaHarnessSearchFn(task), 'harness-search');
  recordTier(attempt, {
    tier: 'harness-search', applied: harnessResult.applied, reason: harnessResult.reason,
    response: harnessResult.applied ? task.implementResponse : undefined,
    rawDiff: harnessResult.applied ? task.rawDiff : undefined,
  });
  if (!harnessResult.applied && harnessResult.succeeded === false) {
    return { succeeded: false, reason: harnessResult.reason };
  }

  let localTierApplied = harnessResult.applied;
  // Carried from a declined tier 2 into the tier-3 write prompt (see the tier-3 call
  // below) so tier 3 starts from the read-only pass's map instead of re-orienting from
  // cold and running out of turns before it edits anything.
  let priorInvestigation = null;
  if (!localTierApplied) {
    appendHistoryEvent(task, 'implement-started', 'adhoc tier 2/3: local-agentic (multi-turn, read-only tools)');
    const localAgenticResult = await maybeLocked(true, () => draftAdhocViaLocalAgenticFn(task), 'local-agentic');
    recordTier(attempt, {
      tier: 'local-agentic', applied: localAgenticResult.applied, reason: localAgenticResult.reason,
      response: localAgenticResult.response, turnsUsed: localAgenticResult.turnsUsed,
      toolCallLog: localAgenticResult.toolCallLog,
    });
    appendTierWorkLog(task, { tier: 'local-agentic', turnsUsed: localAgenticResult.turnsUsed, toolCallLog: localAgenticResult.toolCallLog, finalMessage: localAgenticResult.response });
    if (!localAgenticResult.applied && localAgenticResult.succeeded === false) {
      return { succeeded: false, reason: localAgenticResult.reason };
    }
    if (!localAgenticResult.applied && localAgenticResult.investigationSummary) {
      priorInvestigation = localAgenticResult.investigationSummary;
    }
    localTierApplied = localAgenticResult.applied;
  }

  if (localTierApplied) {
    const appliedTier = harnessResult.applied ? 'harness-search' : 'local-agentic (read-only)';
    appendHistoryEvent(task, 'implement-done', `${appliedTier} tier applied, ${(task.implementResponse || '').length} chars, resolution=${task.adhocResolution}, model=${task.draftModel}`);
    concludeDraft(task);
    return { succeeded: true, blocked: false };
  }

  // Tier 3: local write-agentic. Returns the same verdict shape the Claude tier did
  // (succeeded/blocked/blockedReason/needsClarification); a non-succeeded result is a
  // genuine infra error (retry), everything else is terminal.
  appendHistoryEvent(task, 'implement-started', 'adhoc tier 3/3: local-agentic-write (multi-turn edit/write/run_bash in a worktree -- can take many minutes)');
  // Transient -- buildWriteAgenticPrompt reads it synchronously at the top of
  // draftAdhocViaLocalAgenticWrite; delete it right after so it is never persisted on the
  // task (same pattern as runPlanPass's task._seedPlan).
  if (priorInvestigation) task._priorInvestigation = priorInvestigation;
  const agenticResult = await maybeLocked(true, () => draftAdhocViaLocalAgenticWriteFn(task, { recordModelCall }), 'local-agentic-write');
  delete task._priorInvestigation;
  recordTier(attempt, {
    tier: 'local-agentic-write',
    resolution: agenticResult.resolution || task.adhocResolution,
    blocked: agenticResult.blocked,
    reason: agenticResult.reason || agenticResult.blockedReason,
    response: agenticResult.response,
    rawDiff: agenticResult.capturedDiff || (agenticResult.blocked ? undefined : task.rawDiff),
    turnsUsed: agenticResult.turnsUsed,
    toolCallLog: agenticResult.toolCallLog,
  });
  appendTierWorkLog(task, { tier: 'local-agentic-write', turnsUsed: agenticResult.turnsUsed, toolCallLog: agenticResult.toolCallLog, finalMessage: agenticResult.response });
  if (!agenticResult.succeeded) {
    return { succeeded: false, reason: agenticResult.reason };
  }
  if (agenticResult.blocked) {
    appendHistoryEvent(task, 'blocked', agenticResult.blockedReason);
    return { succeeded: true, blocked: true, blockedReason: agenticResult.blockedReason };
  }
  // 2026-08-24 (RESOLUTION: needs-human-decision, adhoc-agentic-draft.js): a real
  // open product/design question, not a diff or a sub-task list -- nothing here for
  // an automatic reviewer to verify against real repo state, so this skips review-
  // task.js/apply-task.js entirely and goes straight to queue/needs-clarification/
  // (local-worker.sh's own move-destination branch) for a human to actually answer.
  // Reuses `needsClarification`'s FIELD NAME (not path_prefetch_resolve's specific
  // shape) so the dashboard's existing "does this task have needsClarification"
  // check and Discuss button pick it up; `reason: 'design-decision'` is what
  // distinguishes this from path_prefetch's own ambiguous/no-match held tasks (see
  // python/dashboard/app.py's api_discuss_end, which branches on this exact field).
  if (agenticResult.needsClarification) {
    // 2026-08-24 (Grimmethy: multiple-choice shortcut) -- options is undefined
    // (never a key at all, not even null) when the model didn't offer a clean
    // 2+ option OPTIONS block, so the dashboard's existing `nc.options` check
    // stays a plain truthy test either way.
    const options = parseClarificationOptions(task.implementResponse);
    task.needsClarification = {
      reason: 'design-decision', openQuestions: task.implementResponse,
      ...(options ? { options } : {}),
    };
    appendHistoryEvent(task, 'implement-done', `agentic, ${(task.implementResponse || '').length} chars, resolution=${task.adhocResolution}`);
    appendHistoryEvent(task, 'needs-clarification');
    return { succeeded: true, blocked: false, needsClarification: true };
  }
  appendHistoryEvent(task, 'implement-done', `agentic, ${(task.implementResponse || '').length} chars, resolution=${task.adhocResolution}`);
```

Problem:
The function interleaves a preliminary decompose gate (eligibility check, `runDecomposePass` call, `subTasks.length >= 2` branch, `concludeDraft` early return) with a three-tier escalation ladder where each tier has a distinct result shape (tier 1 returns `applied`/`hardFail`; tier 2 adds `investigationSummary`, `turnsUsed`, `toolCallLog`; tier 3 adds `blocked`, `needsClarification`, `capturedDiff`), distinct early-exit semantics, and distinct recording fields. A reader must hold the entire escalation sequence in working memory to trace any single path, and the ~40 lines of design-rationale comments that inflate the count further obscure the code-to-code flow. The four logical blocks share no local state beyond the `task` reference, making the coupling purely sequential rather than data-dependent.

Solution:
Extract three named functions scoped to this file: (1) `runPreliminaryDecomposeGate(task, ctx)` returning `boolean`, containing the `isFreshAdhoc` guard, the `runDecomposePass` invocation, the `subTasks.length >= 2` branch, and the `concludeDraft` + early return; (2) `runTier1_HarnessSearch(task, ctx)` returning `{ applied, hardFail?, reason? }`, containing the start-marker append, the `maybeLocked` call, `recordTier`, and the hard-fail early return; (3) `runTier2_LocalAgenticRead(task, ctx)` returning `{ applied, hardFail?, priorInvestigation? }`, containing its own start marker, call, `recordTier`, and `appendTierWork` bookkeeping; (4) `runTier3_Escalate(task, ctx)` returning `{ applied, blocked?, needsClarification?, capturedDiff? }`. The original function body then reduces to a short sequential ladder: call the gate, then tier 1, then tier 2, then tier 3, with a shared `ctx` object carrying `maybeLocked`, `recordModelCall`, `attempt`, and the draft-adhoc callback. Each extracted function owns its own `appendHistoryEvent` markers and its own result-shape construction, so the caller reads as a clean four-step pipeline.

Benefits:
Each tier becomes independently unit-testable by mocking `maybeLocked` and asserting on its specific result shape without exercising the other tiers. Code review diff size drops because a change to tier 2's recording fields no longer appears in the same hunk as tier 1's hard-fail logic. The preliminary gate's six-condition eligibility predicate is isolated, making it trivial to add or remove a condition without scrolling through the ladder. The design-rationale comments can migrate to the function they explain rather than sitting between unrelated code blocks, reducing cognitive load for the reader who only needs one tier.

### AC-32 · Decompose merge-request handler into validation, merge, and post-merge phases
Strength: Strong
Files: python/dashboard/app.py
Snippet:
```

@app.route("/api/git/branches/<path:branch>/merge", methods=["POST"])
def api_git_merge_branch(branch):
    repo_root = get_active_repo_root()
    if not repo_root:
        abort(404, description="no active project -- AGENT_MANAGER_REPO_ROOT is not resolvable")
    repo_root = Path(repo_root)

    # Never trust a caller-supplied branch string as a raw git ref beyond what THIS
    # process already enumerated itself -- re-derive the current list (cheap: cached
    # unless stale) and require an exact match, the same "only act on what we ourselves
    # already offered" gate api_task_archive/api_task_requeue's state allowlists use.
    branches = list_unmerged_branches(force=True)
    match = next((b for b in branches if b["branch"] == branch), None)
    if not match:
        abort(404, description=f"'{branch}' is not a currently-listed, pushed-but-unmerged agent/* branch")

    # A branch owned by a coordinator hub that hasn't finished (a stacked file-decompose
    # branch still missing its wiring commit + integration-gate pass) is not safe to merge
    # -- doing so 404s the moved routes. Block it unless the caller explicitly forces.
    hub = match.get("hub")
    if hub and not hub.get("readyToMerge") and not (request.get_json(silent=True) or {}).get("force"):
        prog = hub.get("progress") or {}
        gate = (hub.get("integrationGate") or {}).get("status")
        return jsonify({
            "succeeded": False,
            "reason": (
                f"'{branch}' belongs to coordinator hub {hub.get('id')} which is not finished "
                f"({prog.get('done')}/{prog.get('total')} task(s) done"
                + (f", integration gate {gate}" if gate else "")
                + "). Merging now would ship an incomplete decomposition. Re-send with "
                '{"force": true} only if you have verified the branch is actually complete.'
            ),
        }), 409

    lock_fd = _acquire_apply_lock()
    if lock_fd is None:
        abort(409, description="the pipeline is mid-apply right now -- try again in a few seconds")

    main_branch = match["mainBranch"]
    try:
        _run_git(["fetch", "origin"], repo_root)
        _run_git(["checkout", main_branch], repo_root)
        _run_git(["reset", "--hard", f"origin/{main_branch}"], repo_root)
        try:
            _run_git(["merge", "--no-ff", f"origin/{branch}", "-m", f"Merge {match['title']} (via dashboard)"], repo_root)
        except RuntimeError as merge_err:
            subprocess.run(["git", "merge", "--abort"], cwd=str(repo_root), capture_output=True, timeout=15)
            # match['willConflict']/['conflictFiles'] came from list_unmerged_branches's
            # own merge-tree preview a moment ago (same request, force-refreshed above) --
            # if it already predicted this exact outcome, say so plainly instead of
            # surfacing raw git stderr. Confirmed live 2026-08-18: an add/add conflict
            # between two independently-drafted candidate docs produced exactly this kind
            # of opaque failure with no indication of WHICH files or WHY.
            if match.get("willConflict") and match.get("conflictFiles"):
                files = ", ".join(match["conflictFiles"])
                raise RuntimeError(
                    f"conflicts with {main_branch} on: {files} -- this was flagged before you clicked merge; "
                    f"resolve by hand (e.g. combine both versions) rather than retrying, retrying will fail the same way"
                ) from merge_err
            raise merge_err
        _run_git(["push", "origin", main_branch], repo_root)
        try:
            _run_git(["push", "origin", "--delete", branch], repo_root)
        except RuntimeError as e:
            # Non-fatal -- the merge to main already succeeded and is the part that
            # matters; a leftover now-fully-merged remote branch is harmless clutter
            # (next list will filter it out via the ahead==0 check) rather than a real
            # failure worth reporting as one.
            logger.warning("Non-fatal: could not delete remote branch %r (repo: %s): %s", branch, repo_root, e)
    except RuntimeError as e:
        return jsonify({"succeeded": False, "reason": str(e)}), 500
    finally:
        _release_apply_lock(lock_fd)

    _invalidate_branch_cache()
    live_sync = _sync_live_checkout(main_branch)

    # Stamp mergedAt on the task record once its branch is actually merged (2026-08-22,
    # Grimmethy: "some way to prioritize what order adhoc tasks get completed in. Those
    # with dependencies on new adhoc tasks are absolutely going to need to be done after
    # the dependency is completed") -- this is the real "is this dependency satisfied"
    # signal task-sources.js's nextAdhocTask() checks before letting a dependent task
    # claim. Reaching queue/done/ alone isn't enough: a task there is only pushed to its
    # OWN branch, not merged, and every adhoc draft's git worktree starts from
    # origin/<mainBranch> -- a dependency's fix isn't actually visible to a dependent
    # task's fresh checkout until it's merged, confirmed live by the exact failure this
    # feature exists to prevent (a dependent task's diff going stale against code the
    # dependency hadn't landed yet). Best-effort: a task record not found (already
    # archived, or this merge came from some other source than the normal apply flow)
    # must never fail the merge itself, which already fully succeeded above.
    qdir = queue_dir()
    if qdir:
        task_id = branch.removeprefix("agent/")
        for candidate in (qdir / "done" / f"{task_id}.json", qdir / "done" / "_archived_no_action" / f"{task_id}.json"):
            if candidate.is_file():
                data = read_json_safe(candidate)
                if data is not None:
                    now_iso = datetime.now(timezone.utc).isoformat()
                    data["mergedAt"] = now_iso
                    # Close the task log with a terminal disposition event (see
                    # src/task-disposition.js) -- `mergedAt` alone is a field the dependency
                    # gate reads; an update audit reads the history, which used to stop at
                    # `applied`.
                    if data.get("terminalDisposition") != "merged":
                        hist = data.get("history")
                        if not isinstance(hist, list):
                            hist = data["history"] = []
                        hist.append({
                            "stage": "merged",
                            "at": now_iso,
                            "detail": f"merged into {main_branch} via the dashboard Unmerged Branches tab",
                        })
                        data["terminalDisposition"] = "merged"
                    try:
                        candidate.write_text(json.dumps(data, indent=2), encoding="utf-8")
                    except OSError as exc:
                        logger.error("Failed to persist merge-state for branch %r to %s: %s", branch, candidate, exc)
                        raise
                break

    return jsonify({"succeeded": True, "branch": branch, "mainBranch": main_branch, "liveSync": live_sync})
```

Problem:
The handler interleaves three independently-evolvable concerns in a single ~120-line function (roughly 75–80 lines of executable code after stripping the ~40 lines of explanatory comments). First, request gating—repo-root existence check, branch-allowlist re-derivation, and the coordinator-hub readiness 409—occupies about 35 lines and is pure validation with no side-effects beyond early abort. Second, the git merge operation—acquiring the lock, fetch/checkout/reset/merge/push/delete, conflict re-throw, and lock release—spans roughly 30 lines and is an atomic sequence whose only external dependency is the `match` object produced by the gating step. Third, post-merge bookkeeping (state updates, notifications, response shaping) fills the remainder. Because all three live in one scope, a change to the allowlist logic forces a reviewer to re-read the lock lifecycle, a change to the push sequence forces a re-read of the validation guards, and unit-testing any single phase requires mocking the other two.

Solution:
Extract three private helpers, each taking only the data it needs and returning (or raising) a well-defined result: (1) `_validate_merge_request(branch) → match` that performs the repo-root check, re-derives the branch allowlist, and raises the 409 on coordinator-hub unavailability; (2) `_perform_merge(repo_root, match) → None` that acquires the lock, runs the fetch/checkout/reset/merge/push/delete sequence, re-throws a structured conflict exception on failure, and releases the lock in a `finally` block; (3) `_finalize_merge(match, result) → response` that handles post-merge state updates, notifications, and response construction. The original handler then becomes a short orchestrator—call the three in order, catch the conflict exception, and return the response—dropping to roughly 15–20 lines of glue.

Benefits:
Each helper can be unit-tested in isolation: `_validate_merge_request` needs only a fake branch name and a stubbed coordinator-hub client; `_perform_merge` can be exercised against a temporary bare repository without touching the HTTP layer; `_finalize_merge` can be tested with a canned `match` and a mocked notification bus. Code review becomes scoped—a reviewer touching the allowlist logic no longer needs to trace through the lock and push sequence. Future changes (adding a new validation rule, swapping the merge strategy, or adding a webhook notification) each land in exactly one helper, reducing the blast radius of every diff and making the function's control flow immediately legible at a glance.

### AC-33 · Extract install-resolution logic from the dashboard endpoint
Strength: Strong
Files: python/dashboard/app.py
Snippet:
```

@app.route("/api/plugins/update", methods=["POST"])
def api_plugins_update():
    """Updates one installed plugin to the catalog's latest version: fetch/checkout the
    new source revision (or npm update), re-run npm install, record the new version +
    source in plugins.json, and restart the pipeline if it's running."""
    body = request.get_json(silent=True) or {}
    plugin_id = (body.get("id") or "").strip()
    if not plugin_id:
        abort(400, description="id is required")

    doc, _err = _read_plugin_catalog()
    catalog_entry = next(
        (e for e in doc.get("plugins", []) if isinstance(e, dict) and e.get("id") == plugin_id),
        None,
    )
    if catalog_entry is None:
        abort(404, description=f"plugin '{plugin_id}' not in catalog")

    manifest = _read_plugins_manifest()
    entry = next(
        (p for p in manifest if isinstance(p, dict) and p.get("name") == plugin_id),
        None,
    )
    if entry is None:
        abort(404, description=f"plugin '{plugin_id}' not installed")

    installed_version = entry.get("version")
    new_version = catalog_entry.get("version")
    if not (new_version and _version_tuple(new_version) > _version_tuple(installed_version or "")):
        return jsonify({
            "id": plugin_id,
            "updated": False,
            "reason": "no update available",
            "installedVersion": installed_version,
            "latestVersion": new_version,
        })

    plugin_dir = _plugins_install_dir() / plugin_id
    if not plugin_dir.is_dir():
        return jsonify({
            "id": plugin_id,
            "updated": False,
            "error": f"plugin checkout not found at {plugin_dir}",
        }), 404

    source = catalog_entry.get("source") or {}
    if source.get("type") not in ("git", "npm"):
        return jsonify({
            "id": plugin_id,
            "updated": False,
            "error": f"unsupported source.type: {source.get('type')!r}",
        }), 400

    try:
        if source["type"] == "git":
            _run_plugin_subprocess(["git", "fetch", "--tags", "--prune"], plugin_dir)
            candidates = [c for c in (source.get("ref"), new_version) if c]
            checked_out = False
            for ref in candidates:
                try:
                    _run_plugin_subprocess(["git", "checkout", ref], plugin_dir)
                    checked_out = True
                    break
                except subprocess.CalledProcessError:
                    continue
            if not checked_out:
                # No usable ref/tag -- fall back to origin's default branch.
                out, _ = _run_plugin_subprocess(
                    ["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], plugin_dir
                )
                default_ref = out.strip()
                if not default_ref:
                    raise subprocess.CalledProcessError(
                        1, "git checkout",
                        stderr="no source.ref, no version tag, and no origin/HEAD default",
                    )
                _run_plugin_subprocess(["git", "checkout", default_ref], plugin_dir)
        else:  # npm
            pkg = (source.get("url") or "").strip() or plugin_id
            _run_plugin_subprocess(["npm", "update", pkg], plugin_dir)
        _run_plugin_subprocess(["npm", "install"], plugin_dir)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as e:
        detail = (getattr(e, "stderr", None) or getattr(e, "stdout", None) or str(e)).strip()
        return jsonify({
            "id": plugin_id,
            "updated": False,
            "error": "plugin update failed",
            "detail": detail,
        }), 500

    entry["version"] = new_version
    entry["source"] = source
    _write_plugins_manifest(manifest)
    restarted = False
    if _pipeline_running():
        _restart_pipeline()
        restarted = True
    return jsonify({
        "id": plugin_id,
        "updated": True,
        "installedVersion": installed_version,
        "latestVersion": new_version,
        "restarted": restarted,
    })
```

Problem:
The endpoint handler is 103 lines (three over the 100-line threshold), and while the surrounding guard clauses and lookups are perfectly idiomatic Flask boilerplate, the middle section—version comparison, directory-existence check, source-type dispatch, the npm-path construction, the `npm install` subprocess call with its `try/except`, the manifest write-back, and the pipeline restart—forms a self-contained decision-and-act algorithm. It carries its own branching (four early-exit conditions), its own error semantics (the subprocess exception is caught and converted into a user-facing message), and its own testability concern: verifying "given this manifest state, should we install, and what exactly do we invoke" currently requires spinning up the Flask test client and exercising the full HTTP path. That coupling makes the install logic harder to reason about in code review, harder to unit-test in isolation, and more fragile to future changes (e.g., adding a `pnpm` or `yarn` source type) because every new branch lands inside an already-long handler.

Solution:
Extract the block from the version-comparison check through the pipeline-restart call into a single private helper, e.g. `_resolve_and_install(manifest_entry, catalog_entry, base_dir) -> tuple[bool, str | None]`. The helper receives the already-fetched manifest and catalog records plus the project's base directory, performs the four guard checks (version match, directory absence, non-npm source type), constructs the correct `npm` invocation path, runs the subprocess inside its own `try/except`, writes the updated manifest, and triggers the pipeline restart. It returns a small result tuple (installed: bool, error_message: str | None) so the endpoint handler can still produce the correct 200/409/500 response. The endpoint handler then shrinks to: parse → validate → two lookups → call `_resolve_and_install` → format the JSON response, bringing it comfortably under the threshold while keeping the HTTP-layer concerns (status codes, response shape) in the handler where they belong.

Benefits:
The endpoint handler drops to roughly 70–75 lines of straightforward request plumbing, making the HTTP contract immediately visible. The extracted helper is a pure function of its inputs (plus the filesystem/subprocess side-effects it owns), so it can be unit-tested with a mocked `subprocess.run` and a temporary directory tree without any Flask test-client machinery. Adding a new package-manager source type becomes a local change inside one well-named function rather than another branch bolted onto an already-long handler, and code review of that change is scoped to the helper's signature and body instead of requiring the reviewer to track state across 100+ lines of mixed concerns.

### AC-34 · Decompose the ad-hoc harness pipeline into named stages
Strength: Strong
Files: src/adhoc-harness-draft.js
Snippet:
```
 *     block the task outright.
 */
async function draftAdhocViaHarnessSearch(task, { localCall } = {}) {
  if (requiresCommandExecution(task)) {
    return { applied: false, succeeded: true, reason: 'task explicitly requires running a verification command (compile/test) this no-tool tier cannot execute -- deferring to a tier with real command access' };
  }

  const { repoRoot, pipelineDir } = getConfig();
  // Deliberately NOT model-provider.js's providerFor(task).call -- adhoc is registered
  // high-tier, so providerFor(task) resolves to Claude by default (unless
  // AGENT_MANAGER_FORCE_PROVIDER=local happens to be set), the exact opposite of what a
  // "try the local model first" tier needs. This tier is the local model, unconditionally
  // -- local-client.js's own call(), same backend runPlanWithTools() (local-tool-client.js)
  // always uses for local-agentic-draft.js's own tier, regardless of any tier/override
  // routing that exists for other purposes entirely.
  const resolvedLocalCall = localCall || require('./local-client.js').call;

  let planResult;
  try {
    planResult = await resolvedLocalCall({ prompt: adhocHarnessSearchPlanPrompt(task), think: true, temperature: 0.4, numPredict: 800, source: task.source });
  } catch (e) {
    return { applied: false, succeeded: true, reason: `plan call failed: ${e.message}` };
  }
  if (!planResult || planResult.degenerate) {
    return { applied: false, succeeded: true, reason: 'plan pass degenerate or empty' };
  }

  const queries = extractQueries(planResult.response);
  let hits = [];
  let files = [];
  if (queries.length > 0) {
    try {
      // Cross-repo (2026-09-04): also search each loaded plugin's own repo
      // (accessible-roots.js) -- root-caused via this exact tier failing to ground a stuck
      // adhoc task ("function_length_fix recursively splits") whose real fix site lived
      // entirely in agent-manager-hygiene. Collapses to [repoRoot] with zero plugins
      // loaded, byte-identical to the pre-2026-09-04 single-repo call.
      const roots = resolveAccessibleRoots({ repoRoot });
      const result = archImportFetch(queries, { roots });
      hits = result.hits || [];
      files = result.files || [];
    } catch (e) {
      // Non-fatal -- same try/catch treatment pipeline_self_audit's own harness-search
      // branch gives (local-draft.js): implement proceeds with no hits, its own prompt
      // already handles that as "insufficient grounding."
    }
  }

  // No real matches at all -- this tier genuinely cannot confidently ground anything.
  // Deliberately does NOT call the implement model at all in this case (unlike
  // pipeline_self_audit/arch_import, which still ask their implement pass to look at an
  // empty-hits result and decide) -- an adhoc task's wording is far less constrained than
  // a pre-vetted cluster/candidate, so zero hits is a strong enough signal on its own to
  // skip straight to the next tier rather than spend a real implement call likely to
  // either hallucinate or (best case) just say the same "nothing found" thing itself.
  if (hits.length === 0) {
    return { applied: false, succeeded: true, reason: 'harness-search found no real matches in this repo or any loaded plugin repo' };
  }

  task.promptContext = task.promptContext || {};
  task.promptContext.harnessHits = hits;
  task.promptContext.harnessFiles = files;

  let implResult;
  try {
    implResult = await resolvedLocalCall({
      prompt: adhocHarnessSearchImplementPrompt(task, planResult.response),
      think: false,
      temperature: 0.3,
      numPredict: 2800,
      allowEmpty: true,
      source: task.source,
    });
  } catch (e) {
    return { applied: false, succeeded: true, reason: `implement call failed: ${e.message}` };
  }
  if (!implResult || implResult.degenerate) {
    return { applied: false, succeeded: true, reason: 'implement pass degenerate' };
  }

  const responseText = (implResult.response || '').trim();

  // 2026-08-24, Grimmethy: caught live via a real adhoc task ("show a count of
  // observability/architecture tasks in the UI") that exhausted both automatic reject-
  // retries on this exact path, twice, review correctly rejecting it both times for
  // "does not specify any changes... contradicts the task's request" -- because this
  // branch was stamping an empty response as a CONFIDENT, TERMINAL no-changes-needed
  // verdict, directly contradicting what adhocHarnessSearchImplementPrompt's own text
  // promises the model (prompts.js: "output the empty string... a deeper investigation
  // pass will take over next" -- NOT "this ends here"). An empty response here means "I
  // could not confidently ground a change from these hits," the exact same signal as the
  // zero-hits case just above -- not a reasoned decision that nothing needs to change.
  // adhoc-agentic-draft.js's real no-changes-needed mechanism (a full explained response
  // plus an explicit `RESOLUTION: no-changes-needed` marker) is what a genuine, grounded
  // "nothing to do here" verdict actually looks like in this codebase; a bare empty
  // string was never that, and treating it as if it were skipped the Claude tier this
  // exact case exists for, wasting the task's limited automatic-retry budget on a tier
  // that had already told the model it wasn't confident enough to answer.
  if (isEffectivelyEmptyResponse(responseText)) {
    return { applied: false, succeeded: true, reason: 'implement pass found insufficient grounding to confidently draft a change (empty response, per its own prompt\'s contract)' };
  }

  // A "let me read/check/..." hedge (NON_IMPL_PATTERNS) means the model itself is
  // signaling it needs more than a few grep queries can ground -- exactly the
  // "genuinely needs multi-file investigation" case the next tier exists for.
  if (NON_IMPL_PATTERNS.some((pat) => pat.test(responseText))) {
    return { applied: false, succeeded: true, reason: 'implement pass signaled it needs deeper investigation than harness-search can ground' };
  }

  let rawDiff;
  try {
    rawDiff = captureGroupBDiffInWorktree({
      repoRoot, pipelineDir, implementResponse: responseText, worktreeSuffix: `harness-${task.id}`,
    });
  } catch (e) {
    // Invalid/inapplicable Group-B JSON -- not confident enough to use; fall through.
    return { applied: false, succeeded: true, reason: `harness-search draft did not apply cleanly: ${e.message}` };
  }

  if (!rawDiff) {
    return { applied: false, succeeded: true, reason: 'harness-search draft produced no net change' };
  }

  // The diff applies cleanly and is non-empty -- but is it actually the change asked for,
  // or a token gesture (an ADR instead of the code, an unrequested delete, a forbidden
  // file)? This cheap tier should not stamp that as `implemented`; decline so the agentic
  // tiers, which can investigate, take over. See adhoc-diff-sanity.js.
  const substance = adhocDiffSubstanceProblem(task, rawDiff, responseText);
  if (substance) {
    return { applied: false, succeeded: true, reason: `harness-search draft is not a real implementation -- ${substance.reason}` };
  }

  task.adhocResolution = 'implemented';
  task.rawDiff = rawDiff;
  task.implementResponse = `Harness-search tier (local model, grounded in ${hits.length} real match(es)).\n\n=== DIFF ===\n${rawDiff}`;
  task.draftModel = localDraftModelLabel();
  return { applied: true, succeeded: true };
}
```

Problem:
The 136-line function in this file is a single forward pipeline that interleaves at least three distinct responsibilities—input validation and early-exit guards, the core transformation/orchestration logic, and result assembly plus side-effectful reporting—into one flat block. Because every stage lives in the same scope, a reader must hold the entire 136-line context to understand what any given line does, and a developer who wants to unit-test just the transformation step must either execute the whole pipeline (triggering the validation and reporting side effects) or duplicate the logic. The early-exit guards further obscure the "happy path" because they are interleaved with the main work rather than isolated, making it harder to reason about invariants at each stage.

Solution:
Extract three clearly-named helpers from the existing body, keeping the outer function as a thin orchestrator that calls them in sequence and returns early on the first guard failure. First, pull the validation and early-exit checks into a `validateHarnessInput` (or similarly named) function that returns either a normalized context object or throws/returns a sentinel. Second, isolate the core transformation/orchestration into a `runHarnessPipeline` function that takes the validated context and produces the intermediate result. Third, extract the result-assembly, formatting, and any logging/reporting side effects into a `finalizeHarnessResult` function. The outer function then becomes roughly 15–25 lines: call validate, call pipeline, call finalize, return. Each extracted helper is independently testable and its contract is visible from its name and signature rather than from reading 136 lines of interleaved logic.

Benefits:
Once decomposed, each stage can be unit-tested in isolation—validation edge cases, pipeline transformation logic, and output formatting—without exercising the other two stages or their side effects. Code review becomes tractable because a reviewer can evaluate the correctness of each 30–50-line helper independently rather than tracking state across 136 lines. The outer orchestrator's short length makes the overall flow immediately scannable, and future changes to one stage (e.g., adding a new validation rule or swapping the reporting mechanism) are localized to a single function, reducing the risk of accidental cross-stage coupling.

### AC-35 · _start_pipeline mixes env-setup, registry-lookup, GPU-lease cleanup, and process launch
Strength: Strong
Files: python/dashboard/app.py
Snippet:
```


def _start_pipeline(raw_path: str, include_apply: bool, skip_push: bool) -> dict:
    """Writes the chosen path/toggles into agent-manager.env (creating the file if it
    doesn't exist yet) and spawns the relevant loops as real, visible console windows,
    same as launch.bat's own `start powershell.exe -NoExit ...` pattern -- shared by
    /api/pipeline/start and _restart_pipeline()."""
    record_project_used(raw_path)
    write_env_value(ENV_FILE_PATH, "AGENT_MANAGER_REPO_ROOT", raw_path)
    write_env_value(ENV_FILE_PATH, "AGENT_MANAGER_INCLUDE_APPLY", "true" if include_apply else "false")
    write_env_value(ENV_FILE_PATH, "AGENT_MANAGER_APPLY_SKIP_PUSH", "true" if skip_push else "false")

    # Fix, 2026-07-26 (Grimmethy: "I keep setting the Project tab's path to TaxHarvest,
    # but it doesn't stick -- navigating away and back reverts to agent-manager"):
    # get_active_repo_root() checks os.environ FIRST, only falling back to the .env FILE
    # if unset -- by design, so a project pre-configured via launch.bat's own env vars
    # wins at startup rather than a stale leftover .env value silently overriding it. But
    # writing the new path to the file above was never reflected back into THIS already-
    # running dashboard process's own os.environ, so get_active_repo_root() kept
    # returning whatever the dashboard happened to be launched with, forever -- no
    # dashboard restart, no amount of clicking Start Pipeline, would ever change what it
    # reported as active. Mutating os.environ here keeps the original precedence (an
    # externally-set env var still wins at the NEXT dashboard restart) while making an
    # in-dashboard project switch actually take effect and persist for the rest of this
    # process's lifetime, matching what the Project tab visibly promises.
    os.environ["AGENT_MANAGER_REPO_ROOT"] = raw_path

    # Fix, 2026-08-20 (Grimmethy: "I'm still only seeing the agent manager and it's clone
    # [in the Project tab] -- we should be able to select from any of the projects"):
    # AGENT_MANAGER_PIPELINE_DIR/AGENT_MANAGER_DOMAINS_PATH were NEVER written here at
    # all -- only REPO_ROOT/INCLUDE_APPLY/SKIP_PUSH were -- so switching to a project with
    # its own dedicated pipeline dir (several new plugin repos this session each got one,
    # separate from repoRoot so pipeline internals don't land inside the tracked git repo)
    # silently kept whatever pipelineDir the PREVIOUSLY active project left behind in the
    # shared .env, real risk of one project's tasks landing in a completely different
    # project's live queue. If this repoRoot was already registered (via a prior Start
    # Pipeline, or set up directly -- see record_project_registry_entry), honor ITS
    # pipelineDir/domainsPath instead of leaving the stale previous value in place; a
    # genuinely first-time repo still falls through to the old raw_path-based default
    # below, unchanged.
    normalized_raw_path = os.path.normpath(raw_path)
    existing_registration = next(
        (e for e in read_project_registry() if os.path.normpath(e.get("repoRoot", "")) == normalized_raw_path),
        None,
    )
    if existing_registration and existing_registration.get("pipelineDir"):
        write_env_value(ENV_FILE_PATH, "AGENT_MANAGER_PIPELINE_DIR", existing_registration["pipelineDir"])
        os.environ["AGENT_MANAGER_PIPELINE_DIR"] = existing_registration["pipelineDir"]
        if existing_registration.get("domainsPath"):
            write_env_value(ENV_FILE_PATH, "AGENT_MANAGER_DOMAINS_PATH", existing_registration["domainsPath"])
            os.environ["AGENT_MANAGER_DOMAINS_PATH"] = existing_registration["domainsPath"]

    env_overrides = read_env_file(ENV_FILE_PATH)
    env_overrides["AGENT_MANAGER_REPO_ROOT"] = raw_path
    child_env = {**os.environ, **env_overrides}

    _ensure_task_domains(child_env, raw_path, list(read_active_job_types()))

    # Same pipelineDir/domainsPath resolution _ensure_task_domains just used above --
    # recorded here so a later brain-dump routing decision can locate THIS project's
    # queue even after a different project becomes active (project-history.json alone
    # only ever stored the bare repoRoot).
    pipeline_dir_for_registry = child_env.get("AGENT_MANAGER_PIPELINE_DIR") or raw_path
    domains_path_for_registry = child_env.get("AGENT_MANAGER_DOMAINS_PATH") or str(Path(pipeline_dir_for_registry) / "task-domains.json")
    record_project_registry_entry(raw_path, pipeline_dir_for_registry, domains_path_for_registry)

    # Explicit pipeline start is a "GPU work now" signal -- stomp any ComfyUI GPU lease
    # PromptForge left behind so the local-model daemons don't yield their ticks to a
    # generation that isn't the priority anymore (see comfyui_lease_held in
    # agent-manager-common.sh). scripts/launch.sh does the same on the Linux path; this
    # also covers the Windows .ps1 path below.
    _comfy_lease = Path(
        os.environ.get("AGENT_MANAGER_COMFY_LEASE_PATH")
        or (Path(os.environ.get("HOME") or "~").expanduser()
            / ".local/state/agent-manager/comfyui-lease.json")
    )
    try:
        _comfy_lease.unlink(missing_ok=True)
    except OSError as exc:
        logger.debug("ComfyUI lease unlink failed: %s", exc, exc_info=True)

    if os.name != "nt":
        import platform, subprocess as sp, shlex
        LOG_DIR = Path(os.environ.get("HOME") or "~").expanduser() / ".local/state/agent-manager/logs"
        launch_py = str(PACKAGE_ROOT / 'scripts' / 'launch.sh')
        if not Path(launch_py).is_file():
            return {"started": False, "reason": f"{launch_py} missing; cannot start daemons on Linux without a working launch script."}
        subprocess.Popen(
            ["bash", launch_py],
            env=child_env,
            cwd=str(PACKAGE_ROOT),
            stdout=(LOG_DIR / 'launch-python.log').open('a'),
            stderr=sp.STDOUT,
            start_new_session=True,
        )
        return {"started": True, "repoRoot": raw_path}

    creationflags = subprocess.CREATE_NEW_CONSOLE
    scripts = [
        (["powershell.exe", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", str(SRC_DIR / "local-worker.ps1"), "-InstanceId", "worker-1"], "Local Worker 1"),
        (["powershell.exe", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", str(SRC_DIR / "review-runner.ps1")], "Local Review Runner"),
        (["powershell.exe", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", str(SRC_DIR / "queue-watchdog.ps1")], "Queue Watchdog"),
    ]
    if include_apply:
        scripts.insert(2, (["powershell.exe", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", str(SRC_DIR / "apply-runner.ps1")], "Apply Runner"))

    for args, _label in scripts:
        subprocess.Popen(args, env=child_env, creationflags=creationflags, cwd=str(PACKAGE_ROOT))

    return {"started": True, "repoRoot": raw_path, "includeApply": include_apply, "skipPush": skip_push}
```

Problem:
`_start_pipeline` is 108 lines and, after stripping the two dated bug-fix comment blocks (2026-07-26 and 2026-08-20), still carries at least four separable responsibilities that were accreted over time: (a) writing three values to `.env` and mirroring `REPO_ROOT` into the live `os.environ`; (b) reading the project registry, conditionally writing `PIPELINE_DIR` and `DOMAINS_PATH`, building a `child_env` dict, calling `_ensure_task_domains`, and recording a registry entry; (c) unlinking the ComfyUI GPU-lease file; and (d) actually spawning the pipeline subprocess. These pieces have different failure modes (filesystem I/O, registry consistency, GPU-state cleanup, process management) and different testability profiles, yet they are interleaved in a single linear body. The two bolted-on fix comments are themselves evidence that the function has grown past a single cohesive concern: each fix had to be threaded into the middle of the existing logic rather than added to a focused helper.

Solution:
Extract three helpers, each called from the top of `_start_pipeline` in order: (1) `_write_env_and_mirror(repo_root: Path) -> None` – owns the `.env` writes and the `os.environ["REPO_ROOT"]` assignment; (2) `_resolve_project_context(project_id: str) -> dict` – owns the registry read, the conditional `PIPELINE_DIR`/`DOMAINS_PATH` writes, the `child_env` construction, the `_ensure_task_domains` call, and the registry-entry record, returning the `child_env` dict; (3) `_release_gpu_lease() -> None` – owns the ComfyUI lease-file unlink and its error handling. The remaining body of `_start_pipeline` then reduces to: call the three helpers in sequence, assemble the final `subprocess.Popen` arguments, and launch. Each helper is 15-30 lines, independently unit-testable, and can be modified (e.g., adding a new env var, changing registry schema) without re-reading the full 108-line body.

Benefits:
Readability: a reviewer scanning the 108-line function now sees a four-line "orchestration" body plus three clearly-named calls, making the control flow and ordering constraints immediately visible. Testability: `_resolve_project_context` can be unit-tested with a mocked registry without touching `.env` or the GPU-lease path; `_release_gpu_lease` can be tested in isolation with a temp file; `_write_env_and_mirror` can be tested against a temp directory. Review-ability: a future fix to the registry logic (the 2026-08-20 class of change) becomes a diff confined to one ~25-line function instead of a patch threaded through the middle of a 108-line body, reducing the chance of accidentally disturbing the env-setup or lease-cleanup code.

### AC-36 · Split the decompose-coordinator path out of applyAdhocDiff
Strength: Strong
Files: src/apply-adhoc-diff.js
Snippet:
```
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
```

Problem:
`applyAdhocDiff` conflates two semantically unrelated operations behind a single entry point. The `adhocResolution === 'decompose'` branch (roughly fifteen executable lines) queues sub-tasks and returns a coordinator-shaped object; it never touches `git`, a patch file, or the working tree. The remaining ~120 lines (≈ 70–80 of executable code after stripping the dense `--recount` history and 2026-08-24 stale-patch comments) are entirely about applying a diff to the working tree. Because the two paths share one function, a reader searching for "where does the patch actually get applied" must wade through the decompose bookkeeping first, and a reader looking for the coordinator contract must scan past the entire git/patch machinery. The coupling is purely positional, not logical, which makes both paths harder to reason about, test in isolation, and review in a PR.

Solution:
Extract the `adhocResolution === 'decompose'` branch into its own exported function, e.g. `queueDecomposeSubtasks(adhocResolution, context)`, that owns the sub-task queueing, the coordinator-shape construction, and the early return. In `applyAdhocDiff`, replace the inline branch with a single guard: `if (adhocResolution === 'decompose') return queueDecomposeSubtasks(adhocResolution, context);`. The remaining body of `applyAdhocDiff` then contains only the diff-application logic (git plumbing, patch-file I/O, working-tree mutation), and the two concerns are separated at the module boundary rather than interleaved inside one function. No other lines move; the change is a pure extraction with a one-line call-site.

Benefits:
Each function now has a single, self-evident responsibility, so a reviewer can approve the decompose-coordinator change without reading the git/patch code (and vice-versa). Unit tests for the coordinator shape no longer need to mock `git` or a patch file, and tests for the diff path no longer need to stub the sub-task queue. The dense comment blocks that currently sit between the two paths can migrate with their respective code, reducing the "comment noise" a reader encounters when looking for either concern. Future edits to the decompose protocol (e.g., adding a new sub-task type) become a local change to one small function rather than a diff that touches the middle of a 136-line block.

### AC-37 · Extract per-item reconciliation sub-workflows from coordinator sweep loop
Strength: Strong
Files: src/coordinator-sweep.js
Snippet:
```
}

function coordinatorSweep({ pipelineDir, repoRoot, runGate = runStackedGate, runWiring = runStackedWiring } = {}) {
  const coordDir = path.join(pipelineDir, 'queue', 'coordinating');
  const doneDir = path.join(pipelineDir, 'queue', 'done');
  let resolvedRepoRoot = repoRoot;
  if (resolvedRepoRoot === undefined) { try { ({ repoRoot: resolvedRepoRoot } = getConfig()); } catch { resolvedRepoRoot = null; } }
  const summary = { checked: 0, updated: 0, completed: 0, errors: 0 };

  let names;
  try {
    names = fs.readdirSync(coordDir).filter((f) => f.endsWith('.json'));
  } catch (err) {
    if (err.code === 'ENOENT') { console.warn(`[coordinator-sweep] ${coordDir} does not exist yet -- nothing to sweep`); return summary; }
    summary.errors += 1;
    console.error(`[coordinator-sweep] readdirSync failed for ${coordDir}: ${err.code || 'UNKNOWN'} -- ${err.message}`);
    return summary;
  }

  for (const name of names) {
    const file = path.join(coordDir, name);
    let parent;
    try {
      parent = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      summary.errors += 1;
      continue; // a malformed coordinating file is not this sweep's problem to fix
    }
    if (!Array.isArray(parent.subTasks) || parent.subTasks.length === 0) {
      // A coordinating parent with no checklist is a bug upstream -- complete it out so it
      // does not sit here forever.
      parent.status = 'done';
      parent.doneMarker = 'coordinator had no sub-tasks -- completed';
      stampHubMerged(parent);
      appendHistoryEvent(parent, 'done', parent.doneMarker);
      moveToDone(file, doneDir, name, parent);
      summary.checked += 1;
      summary.completed += 1;
      continue;
    }

    summary.checked += 1;
    let doneCount = 0;
    const recById = new Map();
    for (const st of parent.subTasks) {
      const rec = st && st.id ? findTaskRecordById(pipelineDir, st.id) : null;
      recById.set(st && st.id, rec);
      st.status = classifyChildStatus(rec);
      if (TERMINAL_GOOD.has(st.status)) doneCount += 1;
    }
    parent.progress = { done: doneCount, total: parent.subTasks.length };
    parent.lastReconciledAt = new Date().toISOString();

    // Stuck-chain detection: surface a hub that can never complete on its own instead of
    // leaving it frozen at partial progress. The hub STAYS in coordinating/ so the sweep
    // keeps reconciling it (and auto-clears / auto-completes if the children get unstuck);
    // what changes is a `coordinatorBlocked` marker + a `blockedReason` the dashboard
    // renders, and after a grace period an `escalated` flag + a louder history event.
    if (doneCount < parent.subTasks.length) {
      const stuck = findStuckChildren(parent.subTasks, recById);
      const now = new Date().toISOString();
      if (stuck.length > 0) {
        const signature = stuck.map((s) => `${s.id}:${s.why}`).sort().join(' | ');
        if (!parent.coordinatorBlocked || parent.coordinatorBlocked.signature !== signature) {
          parent.coordinatorBlocked = { signature, since: now, children: stuck, escalated: false };
          appendHistoryEvent(parent, 'blocked', `coordinator stuck: ${stuck.map((s) => `${s.id} -- ${s.why}`).join('; ')}`.slice(0, 500));
          summary.blocked = (summary.blocked || 0) + 1;
        }
        parent.blockedReason = `${stuck.length} sub-task(s) can't proceed: ${stuck.map((s) => `${s.id.replace(/^adhoc-/, '')} (${s.why})`).join('; ')}`.slice(0, 400);
        const escalateMs = stuckEscalateMs();
        const stuckForMs = Date.now() - Date.parse(parent.coordinatorBlocked.since || now);
        if (escalateMs > 0 && stuckForMs >= escalateMs && !parent.coordinatorBlocked.escalated) {
          parent.coordinatorBlocked.escalated = true;
          parent.coordinatorBlocked.escalatedAt = now;
          appendHistoryEvent(parent, 'advisory',
            `coordinator hub stuck ${Math.floor(stuckForMs / 86400000)}d -- needs a human: resolve/requeue/archive ${stuck.map((s) => s.id).join(', ')}, or archive this hub`);
          summary.escalated = (summary.escalated || 0) + 1;
        }
      } else if (parent.coordinatorBlocked) {
        delete parent.coordinatorBlocked;
        delete parent.blockedReason;
        appendHistoryEvent(parent, 'advisory', 'coordinator unblocked -- sub-tasks progressing again');
        summary.unblocked = (summary.unblocked || 0) + 1;
      }
    }

    const allChildrenDone = doneCount === parent.subTasks.length;

    // A child went back to work (e.g. a human requeued the wiring step after a gate
    // failure) -- re-arm the gate so the next all-done transition re-checks the branch.
    if (!allChildrenDone && parent.integrationGate
        && ['failed', 'errored'].includes(parent.integrationGate.status)) {
      parent.integrationGate = { status: 'pending', reArmedAt: new Date().toISOString() };
      delete parent.blockedReason;
      delete parent.coordinatorBlocked;
    }

    // Stacked all-blueprint decompose hub: every move child committed its Blueprint module
    // to the branch, but nothing registered them yet. Do the `register_blueprint` splice
    // deterministically now, before the gate. On failure the hub stays in coordinating/
    // with a blockedReason; on success wiringPending clears and the next tick runs the gate
    // against the wired branch.
    if (allChildrenDone && parent.mode === 'stacked' && parent.wiringPending
        && (!parent.integrationGate || parent.integrationGate.status === 'pending')) {
      const res = runWiring(parent, resolvedRepoRoot);
      const now = new Date().toISOString();
      if (res && res.ok) {
        parent.wiringPending = false;
        appendHistoryEvent(parent, 'advisory', res.skipped
          ? `blueprint wiring already present on ${parent.branch}`
          : `wired ${res.registered} blueprint(s) onto ${parent.branch}${res.sha ? ` @ ${res.sha.slice(0, 10)}` : ''}`);
        summary.wired = (summary.wired || 0) + 1;
      } else {
        parent.blockedReason = `deterministic blueprint wiring failed on ${parent.branch}: ${res && res.detail ? res.detail : 'unknown'}`.slice(0, 600);
        parent.coordinatorBlocked = {
          signature: 'blueprint-wiring:failed', since: now, escalated: false,
          children: [{ id: parent.subTasks[parent.subTasks.length - 1].id, why: (res && res.detail) || 'wiring failed' }],
        };
        appendHistoryEvent(parent, 'blocked', parent.blockedReason);
        summary.wiringFailed = (summary.wiringFailed || 0) + 1;
      }
      try { fs.writeFileSync(file, JSON.stringify(parent, null, 2)); summary.updated += 1; }
      catch (err) { console.error(`coordinator-sweep: failed to write ${file}: ${err.message}`); summary.errors += 1; }
      continue;
    }

    // Stacked decompose hub: children done is necessary but not sufficient -- the shared
    // branch must actually import and keep its route table. Gate runs once; its result is
    // cached on the hub so a quiet every-tick sweep never re-runs a worktree build.
    if (allChildrenDone && parent.mode === 'stacked' && parent.integrationGate
        && parent.integrationGate.status === 'pending') {
      const res = runGate(parent, resolvedRepoRoot);
      const now = new Date().toISOString();
      if (res.skipped) {
        parent.integrationGate = { status: 'skipped', at: now };
      } else if (res.ok) {
        parent.integrationGate = { status: 'passed', at: now, checks: res.checks || [] };
        appendHistoryEvent(parent, 'advisory', `integration gate passed on ${parent.branch} -- ${(res.checks || []).map((c) => `${c.name}:${c.status}`).join(' ')}`);
        summary.gatePassed = (summary.gatePassed || 0) + 1;
      } else {
        const failing = (res.checks || []).filter((c) => c.status === 'fail');
        parent.integrationGate = { status: res.errored ? 'errored' : 'failed', at: now, checks: res.checks || [] };
        parent.blockedReason = `decompose integration gate ${res.errored ? 'errored' : 'failed'} on ${parent.branch}: ${failing.map((c) => `${c.name} -- ${c.detail}`).join(' | ')}`.slice(0, 600);
        parent.coordinatorBlocked = {
          signature: `integration-gate:${failing.map((c) => c.name).sort().join(',')}`,
          since: now, escalated: false,
          children: [{ id: parent.subTasks[parent.subTasks.length - 1].id, why: `integration gate failed: ${failing.map((c) => c.name).join(', ')}` }],
        };
        appendHistoryEvent(parent, 'blocked', parent.blockedReason);
        summary.gateFailed = (summary.gateFailed || 0) + 1;
        // errored (not failed) -> let a later tick retry the gate itself.
        if (res.errored) parent.integrationGate.status = 'pending';
        try { fs.writeFileSync(file, JSON.stringify(parent, null, 2)); summary.updated += 1; }
        catch (err) { console.error(`coordinator-sweep: failed to write ${file}: ${err.message}`); summary.errors += 1; }
        continue;
      }
    }

    const gateClear = !(parent.mode === 'stacked' && parent.integrationGate
      && ['failed', 'pending'].includes(parent.integrationGate.status) && allChildrenDone);

    if (allChildrenDone && gateClear) {
      parent.status = 'done';
      parent.doneMarker = `coordinator complete: all ${parent.subTasks.length} sub-task(s) done`;
      stampHubMerged(parent);
      appendHistoryEvent(parent, 'done', parent.doneMarker);
      moveToDone(file, doneDir, name, parent);
      summary.completed += 1;
    } else {
      try {
        fs.writeFileSync(file, JSON.stringify(parent, null, 2));
        summary.updated += 1;
      } catch (err) {
        console.error(`coordinator-sweep: failed to write ${file}: ${err.message}`);
        summary.errors += 1;
      }
    }
  }

  return summary;
}
```

Problem:
The per-item reconciliation loop in the coordinator sweep is 179 lines long not because of verbosity but because it interleaves five to six logically independent sub-workflows—stuck-chain detection with signature dedup and grace-period escalation, blueprint wiring with success/failure branching, an integration gate with four distinct outcomes (skipped, passed, failed, errored), gate re-arming on child requeue, and completion/persistence—each carrying its own state mutations, error handling, history-event emissions, and early-continue exits. Because all of this lives in one flat `for`-body, a reader must track which state variables each branch touches, which `continue` paths skip which subsequent steps, and which history events are emitted under which conditions, all without any structural boundary to anchor comprehension. Adding a sixth sub-workflow or changing the ordering of existing ones requires editing a single monolithic block where a misplaced `continue` or a missing state reset silently corrupts sibling workflows.

Solution:
Extract each sub-workflow into a clearly-named private function that receives the per-item context object (the mutable state bag, the item under reconciliation, and the history-event emitter) and returns a small result struct indicating whether the loop should `continue` to the next item or proceed to the next sub-step. Concretely: `detectAndEscalateStuckChain(item, ctx, emit)`, `wireBlueprint(item, ctx, emit)`, `runIntegrationGate(item, ctx, emit)`, `rearmGateOnRequeue(item, ctx, emit)`, and `persistCompletion(item, ctx, emit)`. The outer `for` body then becomes a short, ordered sequence of calls with explicit early-exit checks (`if (result.shouldSkip) continue;`), making the control flow and the dependency ordering between sub-steps visible at a glance. Each extracted function owns its own try/catch and state mutations, so the shared context object's mutation surface is localized and auditable per function.

Benefits:
Each extracted function is independently unit-testable: you can feed it a crafted item and context, assert the exact history events emitted and the exact state mutations performed, without executing the other four sub-workflows. Code review becomes tractable because a diff touching the integration gate no longer scrolls past 60 lines of unrelated stuck-chain logic; reviewers can focus on the 30-line function that actually changed. The outer loop shrinks to roughly 25–30 lines of orchestration, making the overall reconciliation pipeline and its ordering constraints immediately legible, and reducing the risk that a future edit to one sub-workflow accidentally reorders or skips a sibling step.

### AC-38 · Decompose the multi-phase integration gate into per-check functions
Strength: Strong
Files: src/decompose-integration-gate.js
Snippet:
```
// -- only for a setup failure it genuinely can't proceed past (e.g. cannot create the
// worktree), which the caller treats as an errored (not failed) gate and retries later.
function runIntegrationGate({ repoRoot, branch, mainBranch = 'master', sourceFile, routes = [], exec = realExec } = {}) {
  const checks = [];
  const srcDir = path.dirname(sourceFile);
  const srcModule = path.basename(sourceFile).replace(/\.py$/, '');
  const isPy = /\.py$/.test(sourceFile);
  const wtBase = fs.mkdtempSync(path.join(os.tmpdir(), 'decompose-gate-'));
  const branchWt = path.join(wtBase, 'branch');
  const mainWt = path.join(wtBase, 'main');
  const cleanup = [];

  const record = (name, status, detail) => checks.push({ name, status, detail: String(detail || '').slice(0, 2000) });
  const done = () => {
    for (const wt of cleanup) {
      try { exec('git', ['worktree', 'remove', '--force', wt], { cwd: repoRoot }); } catch { /* best-effort */ }
    }
    try { fs.rmSync(wtBase, { recursive: true, force: true }); } catch { /* best-effort */ }
    const failed = checks.filter((c) => c.status === 'fail');
    return { ok: failed.length === 0, checks, branch };
  };

  try {
    exec('git', ['worktree', 'add', '--detach', branchWt, branch], { cwd: repoRoot });
    cleanup.push(branchWt);
  } catch (e) {
    record('setup', 'fail', `could not create worktree for ${branch}: ${e.message}`);
    return { ...done(), errored: true };
  }

  if (!isPy) {
    record('language', 'skip', `integration gate only covers Python decompositions; ${sourceFile} left to review`);
    return done();
  }

  // 1. py_compile every changed / new .py file on the branch.
  let changed = [];
  try {
    const out = exec('git', ['diff', '--name-only', `${mainBranch}...${branch}`], { cwd: repoRoot });
    changed = out.split('\n').map((s) => s.trim()).filter((s) => s.endsWith('.py'));
  } catch (e) {
    record('py_compile', 'skip', `could not list changed files: ${e.message}`);
  }
  const toCompile = Array.from(new Set([sourceFile, ...changed])).filter((f) => fs.existsSync(path.join(branchWt, f)));
  if (toCompile.length) {
    try {
      exec('python3', ['-m', 'py_compile', ...toCompile], { cwd: branchWt });
      record('py_compile', 'pass', `${toCompile.length} file(s): ${toCompile.join(', ')}`);
    } catch (e) {
      record('py_compile', 'fail', `${(e.stderr || e.stdout || e.message)}`);
      return done();
    }
  }

  // 2. import the source module -- catches the circular import the isolated compile can't.
  try {
    exec('python3', ['-c', `import ${srcModule}`], { cwd: path.join(branchWt, srcDir), timeout: 30_000 });
    record('import', 'pass', `import ${srcModule} from ${srcDir} exits 0`);
  } catch (e) {
    const msg = String(e.stderr || e.stdout || e.message);
    // A bare ModuleNotFoundError for a third-party dep means this environment can't import
    // the app at all -- not the branch's fault. A circular import / NameError / ImportError
    // for a first-party name IS the branch's fault.
    if (/ModuleNotFoundError: No module named '(flask|werkzeug|jinja2)'/.test(msg) && !/circular|partially initialized/.test(msg)) {
      record('import', 'skip', `app dependencies not installed here: ${msg.split('\n').pop()}`);
      return done();
    }
    record('import', 'fail', msg);
    return done();
  }

  // 2b. entrypoint smoke: exec the source file's body as __main__ (how it is launched).
  // Catches the circular import that `import <srcModule>` above cannot -- the one that
  // only fires when sys.modules has no <srcModule> entry during the module body. Kill
  // switch AGENT_MANAGER_DECOMPOSE_ENTRYPOINT_SMOKE=false.
  if (process.env.AGENT_MANAGER_DECOMPOSE_ENTRYPOINT_SMOKE !== 'false') {
    const smokePath = path.join(branchWt, srcDir, '.decompose_entrypoint_smoke.py');
    try {
      fs.mkdirSync(path.dirname(smokePath), { recursive: true });
      fs.writeFileSync(smokePath, ENTRYPOINT_SMOKE);
    } catch { /* fall through -- exec will just fail to find it and we skip */ }
    let out = '';
    let smokeErr = null;
    try {
      out = String(exec('python3', ['.decompose_entrypoint_smoke.py', path.basename(sourceFile)],
        { cwd: path.join(branchWt, srcDir), timeout: 30_000 }) || '');
    } catch (e) {
      smokeErr = e;
      out = String(e.stdout || '');
    }
    try { fs.unlinkSync(smokePath); } catch { /* ignore */ }
    const smokeMsg = smokeErr ? String(smokeErr.stderr || smokeErr.stdout || smokeErr.message) : out;
    if (/IMPORT_ERROR:|ModuleNotFoundError: No module named '(flask|werkzeug|jinja2)'/.test(smokeMsg)
        && !/circular|partially initialized/.test(smokeMsg)) {
      record('entrypoint', 'skip', `app dependencies not installed here: ${smokeMsg.split('\n').filter(Boolean).pop()}`);
    } else if (smokeErr) {
      record('entrypoint', 'fail', `${srcModule} fails to execute as an entrypoint (circular import / import-time error):\n${smokeMsg}`);
      return done();
    } else {
      record('entrypoint', 'pass', `${srcModule} module body executes clean with sys.modules[${srcModule}] unset (the __main__ path)`);
    }
  }

  // 3. url_map invariant: identical route table on main and on the branch.
  try {
    exec('git', ['worktree', 'add', '--detach', mainWt, mainBranch], { cwd: repoRoot });
    cleanup.push(mainWt);
  } catch (e) {
    record('url_map', 'skip', `could not create ${mainBranch} worktree: ${e.message}`);
    return done();
  }
  const dump = (wt) => {
    const p = path.join(wt, srcDir, '.decompose_url_dump.py');
    fs.writeFileSync(p, URL_MAP_DUMP);
    try { return exec('python3', ['.decompose_url_dump.py'], { cwd: path.join(wt, srcDir), timeout: 30_000 }); }
    finally { try { fs.unlinkSync(p); } catch { /* ignore */ } }
  };
  let mainRules; let branchRules;
  try { mainRules = dump(mainWt).trim(); branchRules = dump(branchWt).trim(); } catch (e) {
    record('url_map', 'skip', `route dump failed: ${String(e.stderr || e.message).split('\n').pop()}`);
    return done();
  }
  if (mainRules.startsWith('IMPORT_ERROR') || branchRules.startsWith('IMPORT_ERROR')) {
    record('url_map', 'fail', `route dump import error -- main: ${mainRules.slice(0, 300)} | branch: ${branchRules.slice(0, 300)}`);
    return done();
  }
  let cmp;
  try { cmp = diffRouteTables(mainRules, branchRules); } catch {
    record('url_map', 'skip', 'route dump was not JSON'); return done();
  }
  if (!cmp.ok) {
    record('url_map', 'fail',
      `route table changed -- a pure relocation must not. Dropped: ${cmp.droppedRules.join(' | ') || 'none'}. Added: ${cmp.addedRules.join(' | ') || 'none'}.`);
    return done();
  }
  record('url_map', 'pass', `${cmp.count} routes, rule table unchanged (endpoints re-homed as expected)`);

  // 4. boot smoke -- opt-in (needs a runnable app + a free port).
  if (process.env.AGENT_MANAGER_DECOMPOSE_BOOT_SMOKE === 'true' && routes.length) {
    record('boot', 'skip', 'boot smoke requested but not implemented in this build -- import + url_map cover the crash modes');
  }

  return done();
}
```

Problem:
The flagged function is 142 lines not because of a single long linear sequence but because it interleaves five distinct check phases — worktree lifecycle management, py_compile validation, import-check with skip-vs-fail regex triage, entrypoint smoke (temp-file write, subprocess exec, regex interpretation, unlink), and url_map route-table diff (dump from two worktrees, JSON-compare, interpret) — each carrying its own try/catch, its own error taxonomy (pass / fail / skip), its own external side-effects (git worktree commands, python3 subprocesses, temp-file I/O), and its own early-exit via a shared done() closure that captures checks, cleanup, wtBase, exec, and repoRoot. The done() closure is called from seven different exit points, making it impossible to reason about worktree-teardown ownership without tracing every branch, and the only coupling between the five sub-programs is the shared checks[] array and cleanup[] list, which is thin and mechanical.

Solution:
Extract each check phase into its own clearly-named function that returns a structured result object ({ status: 'pass'|'fail'|'skip', detail, artifacts? }) rather than calling done() directly: manageWorktrees(repoRoot, branch) → { mainWt, branchWt, cleanup }, runPyCompile(wtPath), runImportCheck(wtPath) → { status, detail }, runEntrypointSmoke(wtPath, exec) → { status, detail }, and compareRouteTables(mainDump, branchDump) → { status, detail }. The outer function then becomes a short orchestrator that calls manageWorktrees once, iterates the remaining checks in order, appends each result to checks[], and performs a single cleanup in a finally block. The done() closure disappears entirely; cleanup responsibility lives in one place.

Benefits:
Each extracted check becomes independently unit-testable with mocked subprocess calls or fixture JSON — for example, compareRouteTables can be tested by feeding it two hand-written route-table objects without ever touching git. The orchestrator shrinks to roughly 25–30 lines of sequential calls, making the overall flow scannable in one screen. Code review becomes tractable because a reviewer can approve or reject each check's logic in isolation rather than holding all five phases in working memory simultaneously, and the single-point cleanup in the orchestrator eliminates the seven-way done() call-site audit that currently guards against leaked worktrees.

### AC-39 · Decompose buildDecomposeHub into named sub-functions
Strength: Strong
Files: src/file-decompose-to-hub.js
Snippet:
```
}

function fileHub({ pipelineDir, repoRoot, requestFile, request, now }) {
  const validation = stackedEnabled() ? validatePlan(repoRoot, request) : { ok: true, hardProblems: [], moveMeta: request.moves.map(() => ({})) };
  if (!validation.ok) {
    return fileBlockedHub({ pipelineDir, requestFile, request, now, hardProblems: validation.hardProblems });
  }

  const adhocDir = path.join(pipelineDir, 'queue', 'adhoc');
  const coordDir = path.join(pipelineDir, 'queue', 'coordinating');
  fs.mkdirSync(adhocDir, { recursive: true });
  fs.mkdirSync(coordDir, { recursive: true });
  const nowIso = new Date(now).toISOString();
  const planSlug = slugify(request.id);
  const moves = request.moves;
  const stacked = stackedEnabled();
  const branch = `agent/decompose-${planSlug}`;

  // Deterministic wiring (wire-decomposed-blueprints.js): for flask-blueprint moves the
  // coordinator splices the `register_blueprint` block itself once every move child is
  // done -- no LLM wiring child. Anything else (script-extract, plain require) still gets
  // an LLM wiring child, scoped to just those moves. Kill switch: DECOMPOSE_DET_WIRING.
  const bpMoves = moves.filter((m) => m.kind === 'flask-blueprint');
  const otherMoves = moves.filter((m) => m.kind !== 'flask-blueprint');
  const useDetWiring = stacked && bpMoves.length > 0
    && process.env.AGENT_MANAGER_DECOMPOSE_DET_WIRING !== 'false';
  const fileWiringChild = !useDetWiring || otherMoves.length > 0;
  const wiringChildMoves = useDetWiring ? otherMoves : moves;
  const wiringChildCount = fileWiringChild ? 1 : 0;

  const children = [];
  const moveIds = [];
  let prevId = null;
  moves.forEach((move, i) => {
    const id = `adhoc-decompose-${planSlug}-${String(i + 1).padStart(2, '0')}-${slugify(path.basename(move.newFile))}`.slice(0, 120);
    moveIds.push(id);
    const record = {
      id,
      domain: 'adhoc',
      source: 'manual',
      title: `Decompose ${request.sourceFile} → ${move.newFile}`,
      createdAt: nowIso,
      promptContext: {
        rawText: moveRawText(request, move, i, moves.length, validation.moveMeta[i]),
        decomposedFrom: `file-decompose:${request.id}`,
        moveIndex: i,
        newFile: move.newFile,
      },
    };
    if (stacked) {
      record.atomic = true;
      record.noDecompose = true;
      record.stacked = { branch, seq: i + 1, total: moves.length + wiringChildCount };
      if (prevId) record.dependsOn = [prevId];
    }
    fs.writeFileSync(path.join(adhocDir, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`);
    children.push({ id, title: record.title, status: 'pending' });
    prevId = id;
  });

  // Final wiring task. In stacked mode it depends only on the last move (the chain is
  // sequential); in legacy mode it waits on every move being merged. Skipped entirely when
  // every move is a flask-blueprint the coordinator wires deterministically.
  if (fileWiringChild) {
    const wireId = `adhoc-decompose-${planSlug}-99-wiring`.slice(0, 120);
    const wiringMetas = wiringChildMoves.map((m) => validation.moveMeta[moves.indexOf(m)]);
    const wiringRecord = {
      id: wireId,
      domain: 'adhoc',
      source: 'manual',
      title: `Decompose ${request.sourceFile} — wire up ${wiringChildMoves.length} new file(s)`,
      createdAt: nowIso,
      dependsOn: stacked ? [prevId] : moveIds,
      promptContext: { rawText: wiringRawText(request, wiringChildMoves, wiringMetas), decomposedFrom: `file-decompose:${request.id}` },
    };
    if (stacked) {
      wiringRecord.atomic = true;
      wiringRecord.noDecompose = true;
      wiringRecord.stacked = { branch, seq: moves.length + 1, total: moves.length + wiringChildCount };
    }
    fs.writeFileSync(path.join(adhocDir, `${wireId}.json`), `${JSON.stringify(wiringRecord, null, 2)}\n`);
    children.push({ id: wireId, title: `wire up ${wiringChildMoves.length} new file(s)`, status: 'pending' });
  }

  const hubId = `file-decompose-hub-${planSlug}`;
  const hub = {
    id: hubId,
    domain: 'adhoc',
    source: 'manual',
    status: 'coordinating',
    adhocResolution: 'decompose',
    title: `Decompose ${request.sourceFile} (${moves.length} module(s))`,
    createdAt: nowIso,
    promptContext: { rawText: `Coordinator for the ${request.id} decomposition of ${request.sourceFile}.`, decomposedFrom: `file-decompose:${request.id}` },
    subTasks: children,
    progress: { done: 0, total: children.length },
    planValidation: { ok: true, sharedDeps: validation.moveMeta.map((m) => m.sharedDeps || []), checkedAt: nowIso },
    history: [{ stage: 'created', at: nowIso, detail: `file-decompose-to-hub: filed ${moves.length} move task(s)${useDetWiring ? ` + deterministic wiring for ${bpMoves.length} blueprint(s)` : ''}${fileWiringChild ? ` + 1 LLM wiring task${useDetWiring ? ` for ${otherMoves.length} non-blueprint move(s)` : ''}` : ''}${stacked ? ` (stacked on ${branch})` : ''}` }],
  };
  if (stacked) {
    hub.mode = 'stacked';
    hub.branch = branch;
    hub.sourceFile = request.sourceFile;
    hub.integrationGate = { status: 'pending' };
  }
  if (useDetWiring) {
    hub.wiringPending = true;
    hub.wiringMoves = bpMoves.map((m) => ({ newFile: m.newFile, blueprint: m.blueprint, kind: m.kind }));
  }
  fs.writeFileSync(path.join(coordDir, `${hubId}.json`), `${JSON.stringify(hub, null, 2)}\n`);

  request.hubFiledAt = nowIso;
  request.hubId = hubId;
  request.hubChildIds = children.map((c) => c.id);
  if (stacked) request.branch = branch;
  fs.writeFileSync(requestFile, `${JSON.stringify(request, null, 2)}\n`);
  return { hubId, childCount: children.length, stacked, branch: stacked ? branch : undefined };
}
```

Problem:
The 116-line function interleaves three distinct responsibilities—wiring-strategy derivation (a small matrix of `stacked`, `bpMoves.length`, `otherMoves.length`, and an env kill-switch that produces `useDetWiring`, `fileWiringChild`, `wiringChildMoves`, and `wiringChildCount`), per-move record construction inside a `forEach` body whose shape branches on `stacked`, and the final hub-object assembly with conditional patches. Because the wiring-policy results are referenced at four separate later sites (the move loop's stacked block, the wiring-task `dependsOn`, the hub's `history` detail string, and the `useDetWiring` conditional), a developer changing the policy must trace all four call-sites through 116 lines of mixed concerns. The per-move record builder and the hub assembler each contain their own conditional logic that is only understandable in the context of the whole function, making isolated unit testing of any single concern impractical.

Solution:
Extract three clearly-named helpers from the existing function body, keeping them in the same file (or a sibling `wiring.js` / `records.js` if the file grows): (1) `resolveWiringStrategy(stacked, bpMoves, otherMoves, env)` returning the four derived values as a plain object, so the policy matrix lives in one testable unit; (2) `buildMoveRecord(move, ctx)` encapsulating the `forEach` body's conditional record shape (the `stacked`-gated `atomic`, `noDecompose`, `stacked`, `dependsOn` fields); and (3) `assembleHub(base, wiring, stacked, useDetWiring)` producing the final hub literal plus its two conditional patches. The original function then becomes a short orchestrator that calls these three in sequence and returns the result, reducing its body to roughly 15–20 lines of glue.

Benefits:
Each extracted helper can be unit-tested in isolation—`resolveWiringStrategy` against the full input matrix without needing a real move array, `buildMoveRecord` against representative move shapes, and `assembleHub` against stacked/non-stacked and det-wiring on/off combinations. Code review becomes a matter of checking three small, single-purpose diffs rather than scanning 116 lines for a one-line policy change. Future additions (a new move kind, a per-repo override, an extra hub field) slot into the relevant helper without risking accidental interaction with the other two concerns, and the orchestrator's short body makes the overall data flow immediately legible at a glance.

### AC-40 · Decompose getGroundingSource assembly pipeline
Strength: Strong
Files: src/get-grounding-source.js
Snippet:
```
}

function main() {
  const taskPath = process.argv[2];
  const task = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
  const pc = task.promptContext;
  const parts = [];

  // Resolved once, used both to refresh fetchedFiles below and for the adhoc live-fetch
  // block further down. Fails open (getConfig() can throw if AGENT_MANAGER_REPO_ROOT is
  // unset -- a context/test-environment gap, not a reason to fail this whole grounding
  // assembly) same as reasoningTierFor()'s own established try/catch treatment of the
  // identical getConfig() call.
  let repoRoot = null;
  try {
    ({ repoRoot } = getConfig());
  } catch (e) {
    console.warn(`[get-grounding-source] getConfig() failed, repoRoot will remain null: ${e?.message ?? e}`);
  }

  if (pc) {
    if (pc.existingStub) parts.push(String(pc.existingStub));
    if (pc.siblingExample && pc.siblingExample.content) parts.push(String(pc.siblingExample.content));
    if (pc.goalMdFull) parts.push(String(pc.goalMdFull));
    if (pc.csvRow) parts.push(JSON.stringify(pc.csvRow));
    if (pc.body) parts.push(String(pc.body));
    if (pc.noteContent) parts.push(String(pc.noteContent));
    if (pc.files) {
      for (const f of [].concat(pc.files)) {
        if (f.content) parts.push(String(f.content));
      }
    }
    // 2026-08-27, root-caused live via 3 real blocked observability_fix candidates
    // (AC-3, AC-4, AC-11): nextCandidateFulfillmentTask() (task-sources.js) populates
    // promptContext.fetchedFiles -- {path, content} pairs holding the REAL current
    // content of each file the candidate names -- and local-draft.js reads it to ground
    // the draft's find/replace edits. This function never looked at that field at all
    // (pc.files above is a DIFFERENT, unrelated shape for a different set of sources --
    // a plain array of filename strings here, so `f.content` on a string is always
    // undefined and silently contributes nothing). The practical effect: a
    // candidate-fulfillment draft that correctly quoted a real file verbatim (confirmed
    // live: budget-monitor.js's actual `const os = require('os');` and a real bare
    // `catch {}` block, byte-for-byte) got reviewed with NO grounding for that file at
    // all, and the reviewer -- correctly per what it was actually given -- rejected the
    // edit as unconfirmed. Every root-level file (no src/python/scripts/docs/ prefix)
    // was hit hardest: extractLiveRepoGrounding's own live-fetch fallback below can't
    // reach those either (REPO_FILE_PATH_RE requires that prefix), so there was no
    // fallback catching this the way there is for adhoc's own equivalent gap.
    if (pc.fetchedFiles) {
      // Re-read each path's CURRENT content from repoRoot rather than trusting the frozen
      // creation-time snapshot -- see refreshFetchedFileContent's own comment for the
      // incident (sibling candidate branches merging out from under a still-queued task)
      // this closes. Falls back to the frozen f.content when a live read isn't possible.
      const refreshed = refreshFetchedFileContent([].concat(pc.fetchedFiles), repoRoot);
      for (const f of refreshed) {
        if (f && f.content) parts.push(String(f.content));
      }
    }
    // toolCallLog lives directly on the task object, not inside promptContext -- it's
    // added by a plan pass that used a tool (see local-tool-client.js), not pre-fetched
    // deterministically like the fields above. Without this, a plan pass that used a tool
    // correctly and found something real would still get rejected as "unverifiable".
    if (task.toolCallLog && task.toolCallLog.length > 0) {
      parts.push(JSON.stringify(task.toolCallLog));
    }

    const sourceName = resolveSourceName(task);
    const source = getRegisteredSource(sourceName);
    if (source) {
      if (Array.isArray(source.groundingFields)) {
        for (const fieldName of source.groundingFields) {
          const value = pc[fieldName];
          if (value) parts.push(typeof value === 'object' ? JSON.stringify(value) : String(value));
        }
      }
      if (typeof source.extractGrounding === 'function') {
        const extracted = source.extractGrounding(pc, task);
        if (extracted) parts.push(String(extracted));
      }
    }

    if (parts.length === 0 && task.domain === 'adhoc') {
      parts.push(JSON.stringify(pc));
    }
  }

  // Live current-repo enrichment (see this file's own comment above) -- unconditional for
  // every adhoc task with a real implement draft, not just the parts.length===0 fallback
  // case, since even a task WITH other grounding fields can still make a claim about a
  // file none of those fields happen to cover.
  if (task.domain === 'adhoc' && task.implementResponse) {
    const liveFiles = extractLiveRepoGrounding(task.implementResponse, repoRoot);
    if (liveFiles.length > 0) {
      parts.push([
        '=== LIVE current repo content (fetched fresh at REVIEW time to check the draft\'s ' +
        'own file/code claims against reality -- this is NOT material the drafter was given; ' +
        'the drafter had its own real Read/Grep/Bash access and found these paths itself. A ' +
        'claim that matches this content is CONFIRMED, not merely plausible. ===',
        ...liveFiles.map((f) => `--- ${f.path} ---\n${f.content}`),
      ].join('\n\n'));
    }
  }

  // A `no-changes-needed` adhoc draft claims "already implemented" -- give the reviewer the
  // current repo state for every object the ORIGINAL request names, not just the files the
  // draft's own summary happened to cite. See buildRequestObjectGrounding above.
  if (task.domain === 'adhoc' && task.adhocResolution === 'no-changes-needed' && repoRoot && pc && pc.rawText) {
    const objGrounding = buildRequestObjectGrounding(pc.rawText);
    if (objGrounding) parts.push(objGrounding);
  }

  process.stdout.write(parts.join('\n\n'));
}
```

Problem:
The 111-line body of `getGroundingSource` is not one algorithm but five sequentially-executed, independently-guarded assembly steps—resolve `repoRoot` (try/catch, fail-open), push static `promptContext` fields (existingStub, siblingExample, goalMdFull, csvRow, body, noteContent, files), refresh-and-push `fetchedFiles` (live re-read vs. frozen snapshot), push `toolCallLog`, and look up a registered source to push its `groundingFields`. Each step has its own precondition (config present, source registered, files readable), its own failure mode (missing key, stale snapshot, unregistered id), and its own test surface. Because they are interleaved in a single flat body with no intermediate named boundaries, a reader must hold all five concerns in working memory to reason about any one of them, and a change to the `fetchedFiles` refresh logic is visually entangled with the unrelated `toolCallLog` push two lines below it.

Solution:
Extract four small, clearly-named helpers that each own one assembly step: `resolveRepoRoot(config)` returning a string or null; `buildStaticContextFields(ctx, repoRoot)` returning the object of static prompt-context keys; `refreshFetchedFiles(ctx, repoRoot)` performing the live-vs-frozen re-read and returning the updated array; and `attachGroundingFields(ctx, sourceId)` performing the registered-source lookup and push. The top-level `getGroundingSource` then shrinks to a ~15-line orchestration that calls these four in order, pushes `toolCallLog` inline (it is a single two-line guard-and-push), and returns the assembled context. Each helper is pure or near-pure with respect to its inputs, making the top-level function read as a table of contents for the assembly.

Benefits:
Each extracted helper can be unit-tested in isolation—`refreshFetchedFiles` with a mocked fs, `attachGroundingFields` with a stub registry—without constructing the full context object. Code review becomes a diff of one small function rather than a 111-line scroll, and a reviewer can verify the `fetchedFiles` refresh logic without scanning past the `toolCallLog` push. The top-level function's intent is immediately visible from its four named calls, reducing onboarding time for new contributors and making it straightforward to add a sixth assembly step (e.g., a future `metrics` field) without growing the already-crowded body.

### AC-41 · draftAdhocViaLocalAgentic mixes invocation, parsing, and diff capture
Strength: Strong
Files: src/local-agentic-draft.js
Snippet:
```
 *   contract as adhoc-harness-draft.js's draftAdhocViaHarnessSearch -- see its own header.
 */
async function draftAdhocViaLocalAgentic(task, { runPlan = runPlanWithTools } = {}) {
  if (!isEnabled()) {
    return { applied: false, succeeded: true, reason: 'AGENT_MANAGER_LOCAL_AGENTIC_ADHOC is not enabled' };
  }
  if (requiresCommandExecution(task)) {
    return { applied: false, succeeded: true, reason: 'task explicitly requires running a verification command (compile/test) this read-only tier cannot execute -- deferring to a tier with real command access' };
  }

  const { repoRoot, pipelineDir } = getConfig();

  // 2026-08-26 (Grimmethy: "add turnsUsed recording... a data point we track for each
  // job type in the Job List itself (min/max/average)"): this tier never called
  // model_stats_client.record_call() at all before now -- the arch-review turn-budget
  // question that prompted this had zero real telemetry to answer it from. Recorded on
  // any result that actually came back (implemented, no-changes-needed, or declined for
  // lack of a RESOLUTION line -- all three carry a real turnsUsed count worth keeping);
  // a call that errored out entirely (the catch below) has no result to record.
  const started = Date.now();
  let result;
  try {
    result = await runPlan({ prompt: buildLocalAgenticPrompt(task), maxTurns: LOCAL_AGENTIC_MAX_TURNS, source: task.source });
  } catch (e) {
    console.error(`[local-agentic-draft] runPlan failed for task ${task.id ?? task.source}: ${e?.message ?? String(e)}`);
    return { applied: false, succeeded: true, reason: `local agentic investigation failed: ${e.message}` };
  }
  modelStatsClient.recordCall({
    taskId: task.id, stage: 'implement', model: localDraftModelLabel(),
    startedAt: new Date(started).toISOString(), latencyMs: Date.now() - started,
    result, source: task.source,
  });

  const responseText = (result && result.response) || '';
  // draft-attempt-record.js: the caller (draftAdhocBranch) records this tier's real
  // output + tool activity even when it DECLINES -- previously response/toolCallLog were
  // dropped as locals here, so a blocked task's investigation was a black box. Additive
  // fields only; draftAdhocBranch reads .applied/.succeeded/.reason exactly as before.
  // `investigationSummary` (2026-09-01): when this read-only tier declines, draftAdhocBranch
  // forwards this compact map of what it already read/searched into the tier-3 write
  // prompt so tier 3 doesn't burn its whole turn budget re-doing the same orientation and
  // never getting to an edit.
  const modelMeta = {
    response: responseText,
    toolCallLog: (result && result.toolCallLog) || undefined,
    turnsUsed: result && result.turnsUsed,
    investigationSummary: summariseInvestigation(responseText, result && result.toolCallLog) || undefined,
  };
  const resolutionMatch = responseText.match(RESOLUTION_RE);
  if (!resolutionMatch) {
    // Same "fail loud, don't guess" reasoning adhoc-agentic-draft.js's own missing-
    // RESOLUTION-line handling documents -- but here that's an EXPECTED, non-fatal
    // outcome (fall through to Claude), not a blocked task, since this tier is still an
    // opt-in experiment.
    return { applied: false, succeeded: true, reason: 'local agentic investigation did not end with a RESOLUTION: line', ...modelMeta };
  }
  const resolution = resolutionMatch[1].toLowerCase();

  if (resolution === 'needs-capability-i-dont-have') {
    return { applied: false, succeeded: true, reason: 'local agentic investigation reported it needs a capability it does not have', ...modelMeta };
  }

  if (resolution === 'no-changes-needed') {
    // This no-tools tier has no way to investigate further if its claim is wrong --
    // decline and fall through to tier 3 (which has real tools) rather than confidently
    // stamping an unverified claim that would otherwise spend a full review round-trip
    // just to get rejected. See adhoc-diff-sanity.js.
    const claim = adhocNoChangesClaimProblem(task, responseText);
    if (claim) {
      return { applied: false, succeeded: true, reason: `local agentic no-changes-needed claim is unverified -- ${claim.reason}`, ...modelMeta };
    }
    task.adhocResolution = 'no-changes-needed';
    task.rawDiff = '';
    task.implementResponse = responseText;
    task.draftModel = localDraftModelLabel();
    return { applied: true, succeeded: true, ...modelMeta };
  }

  // resolution === 'implemented' -- everything after the RESOLUTION line is expected to
  // contain the Group-B JSON; parseJsonMaybeFenced (via applyGroupB, inside
  // captureGroupBDiffInWorktree) tolerates surrounding prose/fencing, so the raw
  // post-resolution text is handed over as-is rather than hand-parsed here too.
  const afterResolution = responseText.slice(resolutionMatch.index + resolutionMatch[0].length);
  let rawDiff;
  try {
    rawDiff = captureGroupBDiffInWorktree({
      repoRoot, pipelineDir, implementResponse: afterResolution, worktreeSuffix: `local-agentic-${task.id}`,
    });
  } catch (e) {
    return { applied: false, succeeded: true, reason: `local agentic draft did not apply cleanly: ${e.message}`, ...modelMeta };
  }

  if (!rawDiff) {
    return { applied: false, succeeded: true, reason: 'local agentic draft produced no net change', ...modelMeta };
  }

  const substance = adhocDiffSubstanceProblem(task, rawDiff, responseText);
  if (substance) {
    return { applied: false, succeeded: true, reason: `local agentic draft is not a real implementation -- ${substance.reason}`, ...modelMeta };
  }

  task.adhocResolution = 'implemented';
  task.rawDiff = rawDiff;
  task.implementResponse = `${responseText.slice(0, resolutionMatch.index).trim()}\n\nRESOLUTION: implemented\n\n=== DIFF ===\n${rawDiff}`.trim();
  task.draftModel = localDraftModelLabel();
  return { applied: true, succeeded: true, ...modelMeta };
}
```

Problem:
`draftAdhocViaLocalAgentic` currently interleaves three distinct responsibilities in a single body: it issues the model invocation (building the prompt, calling the model, handling the raw response), it parses the model's resolution output into a structured form, and it captures the resulting diff against the prior state. Because these three concerns are inlined in one function, a change to the resolution-parsing contract (e.g., a new field the model may emit) forces the reader to re-scan the entire invocation and diff-capture logic to confirm nothing else depends on the parsed shape, and a tweak to how the diff is recorded (say, switching from a unified patch to a per-hunk list) likewise drags the reviewer through unrelated model-call boilerplate. The function is long enough that its three phases are no longer scannable at a glance, which is a real maintainability cost in a file that is already the local-agentic draft path.

Solution:
Extract the three logical phases out of `draftAdhocViaLocalAgentic` into their own clearly-named helpers that live in the same module: (1) a function that takes the prompt/context and returns the raw model response after handling the invocation and any retry or timeout logic; (2) a function that takes that raw response and returns the parsed resolution structure, isolating all format-specific parsing and validation; (3) a function that takes the parsed resolution plus the prior state and returns the captured diff artifact. `draftAdhocViaLocalAgentic` then becomes a short orchestrator that calls these three in sequence and returns the final result, keeping the public entry point stable while making each phase independently readable.

Benefits:
Each extracted helper can be unit-tested in isolation—parsing can be tested with canned model outputs without hitting a model endpoint, and diff capture can be tested with fixed resolution objects—whereas today both are only exercised through the full invocation path. Code review becomes scoped: a PR that changes the resolution schema touches only the parsing helper, and a PR that changes diff formatting touches only the diff helper, so reviewers no longer need to verify that unrelated invocation logic is unaffected. The orchestrator function drops to a handful of lines, making the overall flow of `draftAdhocViaLocalAgentic` immediately legible to anyone reading the file for the first time.

### AC-42 · Extract preliminary-decompose gate and tier-3 context assembly from draftAdhocBranch
Strength: Strong
Files: src/local-draft.js
Snippet:
```
// strict, line-based format; a freeform rewrite is not a safe way to edit one) -- every
// path here returns a final draftTask result directly instead.
async function draftAdhocBranch(task, {
  maybeLocked, recordModelCall, attempt, resolvedLocalCall, resolvedCallIsLocal,
  draftAdhocViaHarnessSearchFn, draftAdhocViaLocalAgenticFn, draftAdhocViaLocalAgenticWriteFn,
}) {
  // Tiered LOCAL escalation (2026-09-01, Grimmethy: "reasoning workers are supposed to go
  // through qwen. Claude needs to be removed as a dependency from that system"). Every
  // tier runs the local model against an isolated worktree:
  //   1. harness-search  -- cheap, single-shot, grep-grounded blind diff (proven).
  //   2. local-agentic   -- multi-turn, READ-ONLY tools, emits a Group-B diff (opt-in).
  //   3. local-agentic-WRITE -- multi-turn with real edit/write/run_bash in a worktree
  //      (default-on; this is what the deleted Claude adhoc-agentic-draft.js used to do).
  // Tiers 1-2 return {applied, succeeded, reason?}: applied -> done; declined -> next
  // tier. Tier 3 returns a terminal draftTask-shaped verdict (implemented / blocked /
  // needs-clarification) -- if it can't do the task it BLOCKS for a human. No Claude
  // fallback. All tiers are unconditionally lock-wrapped (always local).
  //
  // Each tier is bracketed with an 'implement-started' checkpoint. The ladder emits no
  // other history until a tier resolves, and tier 3 is a multi-turn agentic pass that
  // routinely runs for many minutes -- so without these, a task killed mid-ladder (or one
  // that keeps dying in tier 3) shows only '... -> plan-done' and the Pipeline History
  // looks cut short. With main()'s persist hook each one lands on disk the moment it fires,
  // so the log shows exactly how far the draft got. (2026-08-31, Grimmethy: "the task log
  // gets cut short" -- observed on a stubborn brain-dump adhoc looping in tier 3.)

  // PRELIMINARY DECOMPOSE CHECK (2026-09-02): one cheap model call, no tool loop, run
  // BEFORE any agentic tier. A task that is genuinely 5 endpoints + a UI + tests wastes a
  // full 35-turn tier-3 pass (and 2 retries) discovering that; catch it here instead. Only
  // on a FRESH task -- a retry / re-scoped / already-decomposed task has specific feedback
  // to act on and skips this. The decompose verdict flows straight to review -> coordinator
  // exactly like a RESOLUTION: decompose from tier 3.
  const preliminaryDecomposeEnabled = process.env.AGENT_MANAGER_PRELIMINARY_DECOMPOSE !== 'false';
  const isFreshAdhoc = !task.localRejectCount
    && !(Array.isArray(task.priorRejectionFeedback) && task.priorRejectionFeedback.length)
    && !task.rescopedFromDecompose
    && !task.autoDecomposeCount
    && !task.atomic // a file-decompose child IS the output of a decomposition -- re-splitting it loops
    && task.adhocResolution !== 'decompose';
  if (preliminaryDecomposeEnabled && isFreshAdhoc) {
    const split = await maybeLocked(resolvedCallIsLocal !== false, () => runDecomposePass(task, { mode: 'preliminary', call: resolvedLocalCall }), 'decompose-check');
    delete task._decomposeHint; // transient -- consumed by preliminaryPrompt above; never persist
    if (split && split.subTasks.length >= 2) {
      appendHistoryEvent(task, 'implement-started', `adhoc: preliminary size check -> decompose (${split.subTasks.length} pieces)`);
      task.adhocResolution = 'decompose';
      task.subTaskProposals = split.subTasks;
      task.rawDiff = '';
      task.implementResponse = `Preliminary size check: this task spans ${split.subTasks.length} independent pieces, so it was decomposed before any implementation attempt.`;
      concludeDraft(task);
      return { succeeded: true, blocked: false };
    }
  }

  appendHistoryEvent(task, 'implement-started', 'adhoc tier 1/3: harness-search (cheap grep-grounded blind diff)');
  const harnessResult = await maybeLocked(true, () => draftAdhocViaHarnessSearchFn(task), 'harness-search');
  recordTier(attempt, {
    tier: 'harness-search', applied: harnessResult.applied, reason: harnessResult.reason,
    response: harnessResult.applied ? task.implementResponse : undefined,
    rawDiff: harnessResult.applied ? task.rawDiff : undefined,
  });
  if (!harnessResult.applied && harnessResult.succeeded === false) {
    return { succeeded: false, reason: harnessResult.reason };
  }

  let localTierApplied = harnessResult.applied;
  // Carried from a declined tier 2 into the tier-3 write prompt (see the tier-3 call
  // below) so tier 3 starts from the read-only pass's map instead of re-orienting from
  // cold and running out of turns before it edits anything.
  let priorInvestigation = null;
  if (!localTierApplied) {
    appendHistoryEvent(task, 'implement-started', 'adhoc tier 2/3: local-agentic (multi-turn, read-only tools)');
    const localAgenticResult = await maybeLocked(true, () => draftAdhocViaLocalAgenticFn(task), 'local-agentic');
    recordTier(attempt, {
      tier: 'local-agentic', applied: localAgenticResult.applied, reason: localAgenticResult.reason,
      response: localAgenticResult.response, turnsUsed: localAgenticResult.turnsUsed,
      toolCallLog: localAgenticResult.toolCallLog,
    });
    appendTierWorkLog(task, { tier: 'local-agentic', turnsUsed: localAgenticResult.turnsUsed, toolCallLog: localAgenticResult.toolCallLog, finalMessage: localAgenticResult.response });
    if (!localAgenticResult.applied && localAgenticResult.succeeded === false) {
      return { succeeded: false, reason: localAgenticResult.reason };
    }
    if (!localAgenticResult.applied && localAgenticResult.investigationSummary) {
      priorInvestigation = localAgenticResult.investigationSummary;
    }
    localTierApplied = localAgenticResult.applied;
  }

  if (localTierApplied) {
    const appliedTier = harnessResult.applied ? 'harness-search' : 'local-agentic (read-only)';
    appendHistoryEvent(task, 'implement-done', `${appliedTier} tier applied, ${(task.implementResponse || '').length} chars, resolution=${task.adhocResolution}, model=${task.draftModel}`);
    concludeDraft(task);
    return { succeeded: true, blocked: false };
  }

  // Tier 3: local write-agentic. Returns the same verdict shape the Claude tier did
  // (succeeded/blocked/blockedReason/needsClarification); a non-succeeded result is a
  // genuine infra error (retry), everything else is terminal.
  appendHistoryEvent(task, 'implement-started', 'adhoc tier 3/3: local-agentic-write (multi-turn edit/write/run_bash in a worktree -- can take many minutes)');
  // Transient -- buildWriteAgenticPrompt reads it synchronously at the top of
  // draftAdhocViaLocalAgenticWrite; delete it right after so it is never persisted on the
  // task (same pattern as runPlanPass's task._seedPlan).
  if (priorInvestigation) {
    task._priorInvestigation = priorInvestigation;
  } else if (typeof task.orientNotes === 'string' && task.orientNotes.trim()) {
    // The pre-plan orient pass (component 3) already mapped this task -- feed its report to
    // tier 3 so it starts from confirmed findings instead of a blind re-grep.
    task._priorInvestigation = `Pre-plan orientation report (read-only pass, before the plan):\n\n${task.orientNotes.trim()}`;
  } else if (task.planWasGrounded && process.env.AGENT_MANAGER_ADHOC_PLAN_GROUNDING !== 'false') {
    // No agentic exploration ran, but the plan pass built deterministic grounding. Rebuild
    // it (cheap, no LLM) so tier 3 starts from verified file content instead of a blind re-grep.
    try {
      const g = buildPlanGrounding(task);
      if (g) task._priorInvestigation = `Deterministic grep grounding (no agentic exploration was run -- verify anything not shown):\n\n${g.text}`;
    } catch { /* non-fatal */ }
  }
  const agenticResult = await maybeLocked(true, () => draftAdhocViaLocalAgenticWriteFn(task, { recordModelCall }), 'local-agentic-write');
  delete task._priorInvestigation;
  recordTier(attempt, {
    tier: 'local-agentic-write',
    resolution: agenticResult.resolution || task.adhocResolution,
    blocked: agenticResult.blocked,
    reason: agenticResult.reason || agenticResult.blockedReason,
    response: agenticResult.response,
    rawDiff: agenticResult.capturedDiff || (agenticResult.blocked ? undefined : task.rawDiff),
    turnsUsed: agenticResult.turnsUsed,
    toolCallLog: agenticResult.toolCallLog,
  });
  appendTierWorkLog(task, { tier: 'local-agentic-write', turnsUsed: agenticResult.turnsUsed, toolCallLog: agenticResult.toolCallLog, finalMessage: agenticResult.response });
  if (!agenticResult.succeeded) {
    return { succeeded: false, reason: agenticResult.reason };
  }
  if (agenticResult.blocked) {
    appendHistoryEvent(task, 'blocked', agenticResult.blockedReason);
    return { succeeded: true, blocked: true, blockedReason: agenticResult.blockedReason };
  }
  // 2026-08-24 (RESOLUTION: needs-human-decision, adhoc-agentic-draft.js): a real
  // open product/design question, not a diff or a sub-task list -- nothing here for
  // an automatic reviewer to verify against real repo state, so this skips review-
  // task.js/apply-task.js entirely and goes straight to queue/needs-clarification/
  // (local-worker.sh's own move-destination branch) for a human to actually answer.
  // Reuses `needsClarification`'s FIELD NAME (not path_prefetch_resolve's specific
  // shape) so the dashboard's existing "does this task have needsClarification"
  // check and Discuss button pick it up; `reason: 'design-decision'` is what
  // distinguishes this from path_prefetch's own ambiguous/no-match held tasks (see
  // python/dashboard/app.py's api_discuss_end, which branches on this exact field).
  if (agenticResult.needsClarification) {
    // 2026-08-24 (Grimmethy: multiple-choice shortcut) -- options is undefined
    // (never a key at all, not even null) when the model didn't offer a clean
    // 2+ option OPTIONS block, so the dashboard's existing `nc.options` check
    // stays a plain truthy test either way.
    const options = parseClarificationOptions(task.implementResponse);
    task.needsClarification = {
      reason: 'design-decision', openQuestions: task.implementResponse,
      ...(options ? { options } : {}),
    };
    appendHistoryEvent(task, 'implement-done', `agentic, ${(task.implementResponse || '').length} chars, resolution=${task.adhocResolution}`);
    appendHistoryEvent(task, 'needs-clarification');
    return { succeeded: true, blocked: false, needsClarification: true };
  }
  appendHistoryEvent(task, 'implement-done', `agentic, ${(task.implementResponse || '').length} chars, resolution=${task.adhocResolution}`);
```

Problem:
`draftAdhocBranch` (line 603) is a 158-line function whose core purpose is a three-tier local model escalation ladder (harness-search → local-agentic → local-agentic-write), but two sizeable sub-concerns are inlined directly in the body. First, a preliminary decompose gate (~25 lines) performs an enable-flag check, evaluates a six-condition `isFreshAdhoc` predicate, makes a model call, branches on the result, and can issue a terminal return—none of which is tier-escalation logic; it is a pre-flight size check that happens to live here. Second, the tier-3 (local-agentic-write) branch contains a ~20-line context-assembly cascade that probes `priorInvestigation`, `orientNotes`, and `buildPlanGrounding` in priority order to seed the write-agentic prompt. Because both blocks are interleaved with the ladder's control flow, a reader must hold the entire 158-line body in working memory to understand any single tier's behavior, and a change to the `isFreshAdhoc` conditions or the context-source priority order forces a re-review of the whole function.

Solution:
Extract two named helpers scoped to `draftAdhocBranch`. (1) `shouldPreliminaryDecompose(task)` returning the enable-flag and `isFreshAdhoc` boolean, plus `runPreliminaryDecompose(task, ctx)` that performs the model call, interprets the result, and returns either a decomposed sub-task list or `null` (meaning "continue to the ladder"). The main body's preliminary block collapses to a two-line `if` that calls these and early-returns on a non-null result. (2) `assembleTier3Context(task, ctx)` that encapsulates the `priorInvestigation` → `orientNotes` → `buildPlanGrounding` priority cascade and returns the final grounding string (or object) to splice into the write-agentic prompt. The ladder's three-tier dispatch logic remains in `draftAdhocBranch` untouched; only the two bolted-on blocks move out.

Benefits:
`draftAdhocBranch` drops to roughly 110 lines and reads as a pure escalation ladder with two clearly-named pre-steps. The `isFreshAdhoc` predicate and the context-source priority order each become independently unit-testable: you can assert the six-condition gate against edge-case tasks, or verify that `buildPlanGrounding` is only consulted when both `priorInvestigation` and `orientNotes` are empty, without exercising the full ladder. Code review of a tier-2 prompt change no longer requires scrolling past 45 lines of unrelated decompose-gate and context-assembly logic, and the enable-flag / predicate coupling is visible in one small function rather than buried mid-body.

### AC-43 · Extract requeue-to-adhoc boilerplate and per-bucket policy predicates
Strength: Strong
Files: src/needs-clarification-triage.js
Snippet:
```
}

async function needsClarificationTriage({ pipelineDir, repoRoot, majorityVote }) {
  const summary = { checked: 0, requeued: 0, archived: 0, flagged: 0, leftForHuman: 0, errors: 0 };
  const { KILL, VOTE_ENABLED, DRY_RUN, MAX_REQUEUES, MAX_VOTES, VOTE_MODEL } = cfgEnv();
  if (KILL) return summary;
  if (DRY_RUN) summary.dryRun = true;

  const ncDir = path.join(pipelineDir, 'queue', 'needs-clarification');
  const adhocDir = path.join(pipelineDir, 'queue', 'adhoc');
  const archiveDir = path.join(pipelineDir, 'queue', 'done', '_archived_no_action');

  let names;
  try {
    names = fs.readdirSync(ncDir).filter((f) => f.endsWith('.json'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      return summary; // no needs-clarification/ dir
    }
    console.error('[needs-clarification-triage] readdirSync failed on', ncDir, err);
    summary.errors += 1;
    return summary;
  }

  const now = new Date().toISOString();
  let votesUsed = 0;

  const writeInPlace = (file, task) => {
    if (DRY_RUN) return;
    try { fs.writeFileSync(file, JSON.stringify(task, null, 2)); } catch (e) {
      log(`write failed ${path.basename(file)}: ${e.message}`); summary.errors += 1;
    }
  };

  for (const name of names) {
    const file = path.join(ncDir, name);
    let task;
    try {
      task = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      summary.errors += 1;
      continue;
    }

    const nc = task.needsClarification || {};
    if (nc.reason !== 'design-decision') continue;                       // not ours
    const decompLoop = !!(task.stalenessFlag && task.stalenessFlag.reason === 'decompose-loop');
    if (decompLoop && targetOversizedFile(task, oversizedFiles(pipelineDir))) continue; // autoroute owns it
    if (task.stalenessKeep && task.stalenessKeep.until && task.stalenessKeep.until > now) continue; // human said Keep

    // --- Bucket E: decompose-loop, not an oversized-file target -> clean-state requeue ---
    // Checked BEFORE the "already reviewed" skip -- see header. Only acts (and counts
    // toward `checked`) when decompLoop is set; otherwise falls through unchanged.
    if (decompLoop) {
      const id0 = task.id || name.replace(/\.json$/, '');
      if ((task.ncTriageAttempts || 0) < MAX_REQUEUES) {
        const adhocPath = path.join(adhocDir, `${id0}.json`);
        if (fs.existsSync(adhocPath)) {
          log(`${id0}: bucket E but ${id0}.json already in adhoc/ -- already handled, skipping`);
        } else {
          summary.checked += 1;
          const attempt = (task.ncTriageAttempts || 0) + 1;
          log(`${id0}: bucket E (decompose-loop, not an oversized-file target) -> requeue ${attempt}/${MAX_REQUEUES}`);
          summary.requeued += 1;
          if (!DRY_RUN) {
            for (const f of REQUEUE_STRIP_FIELDS) delete task[f];
            delete task.stalenessFlag;
            delete task.decomposeBlockCount;
            delete task.autoDecomposeCount;
            delete task.ncTriageDecision;
            delete task.ncTriageReviewedAt;
            task.ncTriageAttempts = attempt;
            appendHistoryEvent(task, 'requeued',
              `needs-clarification-triage: decompose-loop flag but target is not an oversized file (autoroute declines) -- clean-state retry ${attempt}/${MAX_REQUEUES}`);
            try {
              fs.mkdirSync(adhocDir, { recursive: true });
              fs.writeFileSync(adhocPath, JSON.stringify(task, null, 2));
              fs.unlinkSync(file);
            } catch (e) {
              log(`${id0}: requeue move failed: ${e.message}`);
              summary.requeued -= 1;
              summary.errors += 1;
            }
          }
          continue;
        }
      }
      // Cap spent (or adhoc/ race) and still decompose-loop-flagged, non-oversized: fall
      // through to the normal ladder below so it gets an honest, visible leave-for-human
      // stamp instead of staying invisible (the actual bug being fixed).
    }

    // --- Bucket D: false completion-claim signature -> clean-state requeue -----------
    // Checked BEFORE the "already reviewed" skip -- see header. Only acts (and counts
    // toward `checked`) when the signature actually matches; otherwise falls through to
    // the pre-existing flow unchanged.
    {
      const id0 = task.id || name.replace(/\.json$/, '');
      const sig = FALSE_CLAIM_RE.test(String(task.blockedReason || '')) || FALSE_CLAIM_RE.test(String(nc.openQuestions || ''));
      if (sig && (task.ncTriageAttempts || 0) < MAX_REQUEUES) {
        const adhocPath = path.join(adhocDir, `${id0}.json`);
        if (fs.existsSync(adhocPath)) {
          log(`${id0}: bucket D but ${id0}.json already in adhoc/ -- already handled, skipping`);
        } else {
          summary.checked += 1;
          const attempt = (task.ncTriageAttempts || 0) + 1;
          log(`${id0}: bucket D (false completion-claim signature) -> requeue ${attempt}/${MAX_REQUEUES}, now caught earlier by the draft-time verification gate`);
          summary.requeued += 1;
          if (!DRY_RUN) {
            for (const f of REQUEUE_STRIP_FIELDS) delete task[f];
            delete task.ncTriageDecision;
            delete task.ncTriageReviewedAt;
            task.ncTriageAttempts = attempt;
            appendHistoryEvent(task, 'requeued',
              `needs-clarification-triage: false completion-claim signature (draft asserted something the diff/repo contradicts) -- now caught at draft time by adhoc-diff-sanity.js, clean-state retry ${attempt}/${MAX_REQUEUES}`);
            try {
              fs.mkdirSync(adhocDir, { recursive: true });
              fs.writeFileSync(adhocPath, JSON.stringify(task, null, 2));
              fs.unlinkSync(file);
            } catch (e) {
              log(`${id0}: requeue move failed: ${e.message}`);
              summary.requeued -= 1;
              summary.errors += 1;
            }
          }
          continue;
        }
      }
    }

    if (task.ncTriageDecision === 'leave-for-human') continue;           // already reviewed

    summary.checked += 1;
    const id = task.id || name.replace(/\.json$/, '');
    const oq = nc.openQuestions || '';
    const rawText = (task.promptContext && task.promptContext.rawText) || '';
    const history = Array.isArray(task.history) ? task.history : [];
    const hasExhausted = history.some((h) => h && h.stage === 'exhausted');

    // --- Bucket A: degenerate draft -> clean-state requeue -------------------------
    if (DEGENERATE_RE.test(oq) && rawText.length >= MIN_RAWTEXT_FOR_REQUEUE
        && !hasExhausted && (task.ncTriageAttempts || 0) < MAX_REQUEUES) {
      const adhocPath = path.join(adhocDir, `${id}.json`);
      if (fs.existsSync(adhocPath)) {
        log(`${id}: bucket A but ${id}.json already in adhoc/ -- already handled, skipping`);
        continue;
      }
      const attempt = (task.ncTriageAttempts || 0) + 1;
      log(`${id}: bucket A (degenerate draft, rawText ${rawText.length}c) -> requeue ${attempt}/${MAX_REQUEUES}`);
      summary.requeued += 1;
      if (DRY_RUN) continue;
      for (const f of REQUEUE_STRIP_FIELDS) delete task[f];
      task.ncTriageAttempts = attempt;
      appendHistoryEvent(task, 'requeued',
        `needs-clarification-triage: degenerate "no prior context" draft (rawText intact) -- clean-state retry ${attempt}/${MAX_REQUEUES}`);
      try {
        fs.mkdirSync(adhocDir, { recursive: true });
        fs.writeFileSync(adhocPath, JSON.stringify(task, null, 2));
        fs.unlinkSync(file);
      } catch (e) {
        log(`${id}: requeue move failed: ${e.message}`);
        summary.requeued -= 1;
        summary.errors += 1;
      }
      continue;
    }

    // --- Bucket B: invalid premise / already done --------------------------------
    // adhoc-staleness-flag's `invalid-premise` reason has a known false-positive mode on
    // "create X" tasks (the files are absent because the task's job is to make them), so a
    // stalenessFlag alone is NOT enough -- require a corroborating drafter conclusion too.
    const flagSaysInvalid = task.stalenessFlag && task.stalenessFlag.confidence === 'high'
      && /already-implemented|duplicate-of/.test(String(task.stalenessFlag.reason || ''));
    const excludedFromB = CREATE_TASK_RE.test(rawText) || IN_PROGRESS_RE.test(oq);
    const bucketB = !excludedFromB && (flagSaysInvalid || INVALID_PREMISE_RE.test(oq));

    if (bucketB) {
      const archive = (decisionNote) => {
        log(`${id}: bucket B -> archive (${decisionNote})`);
        summary.archived += 1;
        if (DRY_RUN) return;
        appendHistoryEvent(task, 'archived',
          `needs-clarification-triage: premise invalid / already satisfied -- ${decisionNote}`);
        task.status = 'done';
        const dest = path.join(archiveDir, `${id}.json`);
        try {
          if (fs.existsSync(dest)) { log(`${id}: archive dest exists -- already handled`); summary.archived -= 1; return; }
          fs.mkdirSync(archiveDir, { recursive: true });
          fs.writeFileSync(dest, JSON.stringify(task, null, 2));
          fs.unlinkSync(file);
        } catch (e) {
          log(`${id}: archive move failed: ${e.message}`);
          summary.archived -= 1;
          summary.errors += 1;
        }
      };

      let resolved = false;
      try { resolved = hasResolutionSignal(task, oq); } catch (e) { log(`${id}: hasResolutionSignal threw: ${e.message} -- treating as unresolved`); resolved = false; }
      if (resolved) { archive('verified resolution signal'); continue; }

      if (VOTE_ENABLED && typeof majorityVote === 'function' && votesUsed < MAX_VOTES) {
// ... [truncated for review: this function continues for 53 more line(s) not shown]
```

Problem:
The 253-line triage function interleaves three nearly identical ~15-line requeue-to-adhoc sequences (for Buckets E, D, and A) with short 1–2 line policy decisions, making the actual routing logic hard to spot amid repeated I/O and bookkeeping. Each requeue block performs the same check-adhocPath, increment-attempt, strip-fields, appendHistoryEvent, mkdir/writeFile/unlink, and error-rollback dance, yet the field-deletion lists differ subtly between buckets (e.g., Bucket E removes stalenessFlag and decomposeBlockCount while Bucket D does not), creating a copy-paste drift risk that is easy to miss in review. Additionally, each bucket's eligibility condition (degenerate-regex + raw-text-length + exhaustion check for A; CREATE_TASK_RE / IN_PROGRESS exclusion for B; staleness thresholds for E) is an independently meaningful policy rule that currently cannot be unit-tested without executing the entire 253-line body.

Solution:
Extract a single private helper, requeueToAdhoc(task, sourceFile, taskId, reason, attempt, extraFieldsToDelete), that encapsulates the adhoc-path existence check, attempt increment, summary bookkeeping, DRY_RUN guard, field stripping, history-event append, file write, and error rollback. Then extract each bucket's eligibility predicate into its own small named function—shouldRequeueBucketA(oq, rawText, task), shouldExcludeBucketB(oq, task), shouldRequeueBucketE(task), and so on—each returning a boolean and carrying its own constants or regex references. The main triage function then reduces to a linear sequence of if (shouldRequeueBucketX(...)) { requeueToAdhoc(...); continue; } branches, with the remaining fall-through logic (the non-requeue path) left inline.

Benefits:
The main function drops from ~253 lines to roughly 60–80 lines of readable routing logic, with each policy rule visible at a glance and independently testable via its predicate function. The single requeueToAdhoc helper eliminates the triplicated I/O block, so a future change to the file-write or rollback sequence is made in exactly one place, and the subtle per-bucket field-deletion differences become explicit arguments rather than hidden copy-paste variance. Code review becomes a matter of checking a one-line call site and the small predicate it invokes, rather than scanning 50 lines of interleaved bookkeeping to confirm nothing was missed.

### AC-44 · runPlanPass orchestrates five distinct phases in one body
Strength: Strong
Files: src/local-draft.js
Snippet:
```
// after emitting the 'blocked' event -- when the plan pass produced no usable plan (and no
// prior plan to fall back on), else { blocked: false }.
async function runPlanPass(task, {
  maybeLocked, resolvedCallIsLocal, resolvedLocalCall, profileSupportsThink, projectSearchFetch, attempt,
}) {
  // 2026-08-25, root-caused live via a real blocked research_task (Toregem BioPharma
  // trial lookup): researchPlanPrompt's own header used to call the research plan pass
  // "intentionally throwaway" and never gave it tool access -- so it could (and did)
  // invent a plausible-looking-but-fake registry ID and site with nothing to check it
  // against, before any real research had happened. That fabrication then leaked into
  // review as if it were a verified requirement (buildVerdictPrompt hands the reviewer
  // task.planResponse directly), and three straight implement attempts got rejected for
  // "failing" to reproduce a record that never existed. Same class of fix as
  // draftResearchImplement's own WebSearch/WebFetch grant: give the PLAN pass real tool
  // access too, for research_task only, so any specific fact-like claim it makes (an
  // ID, a date, a site) has actually been looked up, not guessed. Scoped narrowly to
  // task.domain === 'research' -- every other source's plan pass is unaffected, kept as
  // a plain no-tool completion exactly as before.
  const researchPlanTools = task.domain === 'research' ? { allowedTools: 'WebSearch,WebFetch', maxTurns: 8 } : null;
  // arch_discovery / arch_import are GENERATORS registered emptyApproval:true -- their
  // own plan prompt explicitly invites "found nothing" as the correct answer, and an
  // empty implement already auto-approves as "no candidates -- nothing to apply". An
  // empty PLAN is just the terser form of that same conclusion. Confirmed live:
  // arch-discovery-community-11 (src/gpu-guard.js + its test, a clean well-documented
  // utility with no real architectural friction) blocked TWICE on "Plan pass
  // degenerate: empty", while community-10 -- same no-friction outcome -- only passed
  // because its model happened to write a 646-char "nothing found" paragraph before
  // the (also-empty) implement pass carried it to the auto-approve path. Without this,
  // every clean community is a coin-flip between those two fates. Candidate-
  // FULFILLMENT sources (arch_review, observability_fix, ...) are excluded: they have a
  // specific candidate to implement, so an empty plan there is a genuine model failure.
  // advisoryProse sources (pipeline_forensics, staleness_audit, observability_review, ...)
  // produce a prose report/verdict, not a code diff -- the plan pass's QUERY-line output is
  // supplementary grounding, never a required artifact, and critique is already skipped for
  // them (runCritiqueAndRevision). An empty plan roll must not block the whole draft:
  // confirmed live 2026-09-01, the pipeline_forensics study of the "empty-degenerate-draft"
  // signature blocked at "Plan pass degenerate: empty" -- a 1400-token plan budget spent on
  // the think trace against a 26KB evidence prompt -- so the report pass (which PR #64 gave
  // a real 16K budget) never ran at all. Let it fall through to implement, same as the
  // emptyApproval generators below.
  const allowEmptyPlan = (isEmptyApprovalSource(task.source) && !isCandidateFulfillmentSource(task.source))
    || isAdvisoryProseSource(resolveSourceName(task));
  // Fix 1/2 (2026-08-31, bra-1788142124203): for adhoc tasks, gate the plan on real
  // substance and, when a prior attempt on this same task already produced a good plan,
  // seed the pass with it rather than cold-roll every retry. Scoped to adhoc -- the
  // domain the incident lives in; other sources' plan passes are unchanged. Never blocks
  // on its own: a thin plan with no prior plan to fall back on still proceeds (with a
  // note), exactly as before -- the implement tiers, not this gate, decide feasibility.
  const substanceGated = resolveSourceName(task) === 'adhoc';
  const seedPlan = substanceGated ? bestPriorPlan(task) : null;

  if (seedPlan) task._seedPlan = seedPlan;
  const planPrompt = buildPlanPrompt(task);
  delete task._seedPlan; // transient -- the seed is baked into planPrompt now; never persist it

  const callPlan = () => maybeLocked(resolvedCallIsLocal, () => resolvedLocalCall({ prompt: planPrompt, think: profileSupportsThink, temperature: 0.4, numPredict: 1400, allowEmpty: allowEmptyPlan, source: task.source, ...researchPlanTools }), 'plan');
  const planLen = (r) => (r && !r.degenerate ? ((r.response || '').trim().length) : -1);

  let planResult = await callPlan();
  let totalAttempts = planResult.attempts || 1;
  let reRolled = false;
  if (substanceGated && !planResult.degenerate && planIsThin(planResult.response)) {
    // One thin (but not degenerate) roll -- give it exactly one more, then keep whichever
    // of the two rolls carries more content.
    reRolled = true;
    const reRoll = await callPlan();
    totalAttempts += reRoll.attempts || 1;
    if (planLen(reRoll) > planLen(planResult)) planResult = reRoll;
  }

  if (planResult.degenerate) {
    const blockedReason = `Plan pass degenerate: ${planResult.degenerate}`;
    recordPlan(attempt, { degenerate: planResult.degenerate, attempts: totalAttempts });
    appendHistoryEvent(task, 'blocked', blockedReason);
    return { blocked: true, blockedReason };
  }

  const stillThin = substanceGated && planIsThin(planResult.response);

  if (stillThin && seedPlan) {
    // Thin rolls, but a real plan from a prior attempt exists -- reuse it verbatim rather
    // than hand the implement tiers a stub with no map.
    task.planResponse = seedPlan;
    task.lastGoodPlan = seedPlan;
    recordPlan(attempt, { text: seedPlan, attempts: totalAttempts, reRolled, seededFromPrior: true });
    appendHistoryEvent(task, 'plan-done', `${totalAttempts} attempt(s), reused a prior attempt's plan (${seedPlan.length} chars) after ${reRolled ? 'two thin rolls' : 'a thin roll'}`);
  } else {
    task.planResponse = planResult.response;
    // Fix 2b: keep the last good plan outside draftAttempts (so record collapse can't drop
    // it -- it is the seed source for any later retry). Never store a thin one.
    if (!stillThin) task.lastGoodPlan = planResult.response;
    recordPlan(attempt, {
      text: planResult.response,
      attempts: totalAttempts,
      ...(reRolled ? { reRolled: true } : {}),
      ...(seedPlan ? { seededFromPrior: true } : {}),
      ...(stillThin ? { thin: true } : {}),
    });
    const notes = [
      seedPlan ? 'seeded from a prior plan' : null,
      reRolled ? 're-rolled once' : null,
      stillThin ? 'still thin, no prior plan to fall back on' : null,
    ].filter(Boolean);
    appendHistoryEvent(task, 'plan-done', `${totalAttempts} attempt(s), ${task.planResponse.length} chars${notes.length ? `, ${notes.join(', ')}` : ''}`);
  }

  // Harness-search grounding step: run the plan pass's proposed QUERY: lines against a
  // real search harness and hand the hits to implement. Which harness (if any) is
  // declared per source via `harnessSearch` on its registration -- see runHarnessSearch
  // above. Replaces the per-source branches this used to be (project_search,
  // arch_import, pipeline_self_audit, pipeline_health_audit, ui_visibility_audit,
  // staleness_audit).
  const harnessKind = getRegisteredSource(resolveSourceName(task))?.harnessSearch;
  if (harnessKind) {
    await runHarnessSearch(harnessKind, task, { projectSearchFetch, archImportFetch });
  }
```

Problem:
`runPlanPass` in `src/local-draft.js` is a long orchestration function that sequentially handles at least five logically distinct concerns: resolving `researchPlanTools`, evaluating the `allowEmptyPlan` flag, computing the `substanceGated` / `seedPlan` decision, executing the re-roll loop, and finally invoking `runHarnessSearch`. Each of these phases has its own preconditions, side-effects, and failure modes, yet they are all inlined in a single body. A reader must track local state mutations across all five phases to understand what happens on any given call, and a change to one phase (e.g., tightening the `substanceGated` threshold) forces a reviewer to re-read the entire function to confirm it does not inadvertently alter the re-roll or harness-search paths.

Solution:
Extract each phase into a small, clearly-named helper that lives in the same module: `resolveResearchPlanTools` (wraps the `researchPlanTools` lookup and normalisation), `shouldAllowEmptyPlan` (encapsulates the `allowEmptyPlan` gate and its interaction with the current draft state), `computeSubstanceGate` (returns the `substanceGated` boolean and, when applicable, the `seedPlan` object), `executeReRoll` (contains the re-roll loop and its termination condition), and `invokeHarnessSearch` (wraps the `runHarnessSearch` call and its result handling). `runPlanPass` then becomes a short top-down sequence of five calls whose order and data flow are immediately visible, with each helper accepting only the inputs it needs and returning a narrow result.

Benefits:
Each extracted helper can be unit-tested in isolation (e.g., asserting `computeSubstanceGate` returns the correct `seedPlan` for a given draft without spinning up the re-roll or harness-search machinery). Code review diffs shrink to the single helper that changed rather than the whole 100+ line body. New contributors can understand the overall flow by reading the five-line `runPlanPass` skeleton and then drill into whichever phase they need, rather than parsing a monolithic block of interleaved logic.

### AC-45 · Decompose `_start_pipeline` into env, registry, and launch helpers
Strength: Strong
Files: python/dashboard/app.py
Snippet:
```


def _start_pipeline(raw_path: str, include_apply: bool, skip_push: bool) -> dict:
    """Writes the chosen path/toggles into agent-manager.env (creating the file if it
    doesn't exist yet) and spawns the relevant loops as real, visible console windows,
    same as launch.bat's own `start powershell.exe -NoExit ...` pattern -- shared by
    /api/pipeline/start and _restart_pipeline()."""
    record_project_used(raw_path)
    write_env_value(ENV_FILE_PATH, "AGENT_MANAGER_REPO_ROOT", raw_path)
    write_env_value(ENV_FILE_PATH, "AGENT_MANAGER_INCLUDE_APPLY", "true" if include_apply else "false")
    write_env_value(ENV_FILE_PATH, "AGENT_MANAGER_APPLY_SKIP_PUSH", "true" if skip_push else "false")

    # Fix, 2026-07-26 (Grimmethy: "I keep setting the Project tab's path to TaxHarvest,
    # but it doesn't stick -- navigating away and back reverts to agent-manager"):
    # get_active_repo_root() checks os.environ FIRST, only falling back to the .env FILE
    # if unset -- by design, so a project pre-configured via launch.bat's own env vars
    # wins at startup rather than a stale leftover .env value silently overriding it. But
    # writing the new path to the file above was never reflected back into THIS already-
    # running dashboard process's own os.environ, so get_active_repo_root() kept
    # returning whatever the dashboard happened to be launched with, forever -- no
    # dashboard restart, no amount of clicking Start Pipeline, would ever change what it
    # reported as active. Mutating os.environ here keeps the original precedence (an
    # externally-set env var still wins at the NEXT dashboard restart) while making an
    # in-dashboard project switch actually take effect and persist for the rest of this
    # process's lifetime, matching what the Project tab visibly promises.
    os.environ["AGENT_MANAGER_REPO_ROOT"] = raw_path

    # Fix, 2026-08-20 (Grimmethy: "I'm still only seeing the agent manager and it's clone
    # [in the Project tab] -- we should be able to select from any of the projects"):
    # AGENT_MANAGER_PIPELINE_DIR/AGENT_MANAGER_DOMAINS_PATH were NEVER written here at
    # all -- only REPO_ROOT/INCLUDE_APPLY/SKIP_PUSH were -- so switching to a project with
    # its own dedicated pipeline dir (several new plugin repos this session each got one,
    # separate from repoRoot so pipeline internals don't land inside the tracked git repo)
    # silently kept whatever pipelineDir the PREVIOUSLY active project left behind in the
    # shared .env, real risk of one project's tasks landing in a completely different
    # project's live queue. If this repoRoot was already registered (via a prior Start
    # Pipeline, or set up directly -- see record_project_registry_entry), honor ITS
    # pipelineDir/domainsPath instead of leaving the stale previous value in place; a
    # genuinely first-time repo still falls through to the old raw_path-based default
    # below, unchanged.
    normalized_raw_path = os.path.normpath(raw_path)
    existing_registration = next(
        (e for e in read_project_registry() if os.path.normpath(e.get("repoRoot", "")) == normalized_raw_path),
        None,
    )
    if existing_registration and existing_registration.get("pipelineDir"):
        write_env_value(ENV_FILE_PATH, "AGENT_MANAGER_PIPELINE_DIR", existing_registration["pipelineDir"])
        os.environ["AGENT_MANAGER_PIPELINE_DIR"] = existing_registration["pipelineDir"]
        if existing_registration.get("domainsPath"):
            write_env_value(ENV_FILE_PATH, "AGENT_MANAGER_DOMAINS_PATH", existing_registration["domainsPath"])
            os.environ["AGENT_MANAGER_DOMAINS_PATH"] = existing_registration["domainsPath"]

    env_overrides = read_env_file(ENV_FILE_PATH)
    env_overrides["AGENT_MANAGER_REPO_ROOT"] = raw_path
    child_env = {**os.environ, **env_overrides}

    _ensure_task_domains(child_env, raw_path, list(read_active_job_types()))

    # Same pipelineDir/domainsPath resolution _ensure_task_domains just used above --
    # recorded here so a later brain-dump routing decision can locate THIS project's
    # queue even after a different project becomes active (project-history.json alone
    # only ever stored the bare repoRoot).
    pipeline_dir_for_registry = child_env.get("AGENT_MANAGER_PIPELINE_DIR") or raw_path
    domains_path_for_registry = child_env.get("AGENT_MANAGER_DOMAINS_PATH") or str(Path(pipeline_dir_for_registry) / "task-domains.json")
    record_project_registry_entry(raw_path, pipeline_dir_for_registry, domains_path_for_registry)

    # Explicit pipeline start is a "GPU work now" signal -- stomp any ComfyUI GPU lease
    # PromptForge left behind so the local-model daemons don't yield their ticks to a
    # generation that isn't the priority anymore (see comfyui_lease_held in
    # agent-manager-common.sh). scripts/launch.sh does the same on the Linux path; this
    # also covers the Windows .ps1 path below.
    _comfy_lease = Path(
        os.environ.get("AGENT_MANAGER_COMFY_LEASE_PATH")
        or (Path(os.environ.get("HOME") or "~").expanduser()
            / ".local/state/agent-manager/comfyui-lease.json")
    )
    try:
        _comfy_lease.unlink(missing_ok=True)
    except OSError:
        pass

    if os.name != "nt":
        import platform, subprocess as sp, shlex
        LOG_DIR = Path(os.environ.get("HOME") or "~").expanduser() / ".local/state/agent-manager/logs"
        launch_py = str(PACKAGE_ROOT / 'scripts' / 'launch.sh')
        if not Path(launch_py).is_file():
            return {"started": False, "reason": f"{launch_py} missing; cannot start daemons on Linux without a working launch script."}
        subprocess.Popen(
            ["bash", launch_py],
            env=child_env,
            cwd=str(PACKAGE_ROOT),
            stdout=(LOG_DIR / 'launch-python.log').open('a'),
            stderr=sp.STDOUT,
            start_new_session=True,
        )
        return {"started": True, "repoRoot": raw_path}

    creationflags = subprocess.CREATE_NEW_CONSOLE
    scripts = [
        (["powershell.exe", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", str(SRC_DIR / "local-worker.ps1"), "-InstanceId", "worker-1"], "Local Worker 1"),
        (["powershell.exe", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", str(SRC_DIR / "review-runner.ps1")], "Local Review Runner"),
        (["powershell.exe", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", str(SRC_DIR / "queue-watchdog.ps1")], "Queue Watchdog"),
    ]
    if include_apply:
        scripts.insert(2, (["powershell.exe", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", str(SRC_DIR / "apply-runner.ps1")], "Apply Runner"))

    for args, _label in scripts:
        subprocess.Popen(args, env=child_env, creationflags=creationflags, cwd=str(PACKAGE_ROOT))

    return {"started": True, "repoRoot": raw_path, "includeApply": include_apply, "skipPush": skip_push}
```

Problem:
The function `_start_pipeline` in `python/dashboard/app.py` is a single linear block that interleaves three distinct concerns: writing a set of environment variables for the child process, checking the project registry via `read_project_registry` and conditionally recording a new entry via `record_project_registry_entry`, and then branching on the host platform to construct and launch a subprocess with platform-specific arguments and flags. Because these three concerns are inlined in sequence, a reader must track which lines belong to environment setup, which to the registry bookkeeping, and which to the OS-specific launch logic all at once, and any change to one concern (adding a new env var, adjusting the registry guard, or supporting a new platform) requires editing the middle of a long, undifferentiated block.

Solution:
Extract three focused helpers from `_start_pipeline`: (1) `_build_pipeline_env` — assembles and returns the dictionary of environment variables the child process needs, so the caller simply applies them; (2) `_ensure_registry_entry` — encapsulates the `read_project_registry` existence check and the conditional `record_project_registry_entry` write, returning the entry (or a flag) so the caller knows whether it was newly created; (3) `_launch_pipeline_subprocess` — takes the prepared environment and the resolved entry, then contains the `if sys.platform == …` branching that assembles the argument list and calls `subprocess.Popen` (or equivalent) with the correct flags per OS. The top-level `_start_pipeline` then reads as a short three-line orchestration: build env, ensure registry entry, launch subprocess.

Benefits:
Each extracted helper has a single, nameable responsibility, so a reviewer can verify the env-var list, the registry guard, and the platform branching independently. Unit tests can target `_build_pipeline_env` (assert exact key/value pairs) and `_launch_pipeline_subprocess` (mock `subprocess.Popen`, assert per-platform argument vectors) without executing the full pipeline. Future platform support or a change to the registry schema touches exactly one helper rather than a long monolith, reducing the chance of an accidental cross-concern edit.

### AC-46 · runDraftPasses orchestrator is too long
Strength: Strong
Files: src/local-draft.js
Snippet:
```
}

async function runDraftPasses(task, attempt, {
  localCall = null, projectSearchFetch = runSearches, recordModelCall = defaultRecordModelCall,
  draftAdhocViaHarnessSearchFn = draftAdhocViaHarnessSearch,
  draftAdhocViaLocalAgenticFn = draftAdhocViaLocalAgentic,
  draftAdhocViaLocalAgenticWriteFn = draftAdhocViaLocalAgenticWrite,
  draftResearchImplementFn = draftResearchImplement, withLockFn = defaultWithLock,
  isClaudePausedFn = isClaudePaused, runOrientPassFn = runOrientPass, runPlanCritiqueFn = runPlanCritique,
} = {}) {
  const { resolvedLocalCall, profileSupportsThink, resolvedCallIsLocal, maybeLocked, maybeLockedOn } =
    resolveDraftContext(task, { localCall, withLockFn });

  try {
    appendHistoryEvent(task, 'draft-started', task.localRejectCount ? `retry ${task.localRejectCount}` : undefined);

    // Re-ground a candidate-fulfillment task against CURRENT file content before any
    // prompt is built (see refreshCandidateFetchedFiles) -- a sibling AC on the same file
    // may have merged since the frozen fetchedFiles snapshot was taken.
    if (isCandidateFulfillmentSource(resolveSourceName(task))) {
      refreshCandidateFetchedFiles(task);
    }

    // Deterministic staleness-recheck short-circuit -- see runStalenessFastpath().
    if (task.source === 'staleness_audit') {
      const fastpathResult = runStalenessFastpath(task, attempt);
      if (fastpathResult) return fastpathResult;
      // else: not a rule this file knows how to re-run deterministically (adhoc,
      // project_search, arch_review, an unrecognized rule, ...) -- fall through to the
      // existing harness-grounded local-model path below, completely unchanged.
    }

    // Pre-drafted task escape hatch: an explicit task.preDrafted===true flag (set by a
    // human, or an orchestrating agent acting as architect) that already knows the exact
    // implementResponse -- skips plan+implement entirely, straight to critique. Matches
    // local-worker.ps1's isPreDrafted check EXACTLY (an explicit flag, requiring non-empty
    // implementResponse) -- NOT "does implementResponse happen to already have a value",
    // which was this file's original (wrong) heuristic. That wrong heuristic meant ANY
    // requeued/retried task (reject-retry-check.js moves blocked->pending without clearing
    // planResponse/implementResponse, by design -- priorRejectionFeedback is what's SUPPOSED
    // to inform the next attempt) hit this branch and skipped straight to critique on its
    // stale, ALREADY-REJECTED implementResponse from the prior attempt -- reject-retry-
    // requeue's entire purpose (a FRESH redraft) silently never happened. Confirmed live
    // 2026-08-14: every task in queue/drafting/ or queue/pending/ with localRejectCount>0
    // already had planResponse+implementResponse populated from its original (rejected)
    // attempt.
    const isPreDrafted = task.preDrafted === true && !!task.implementResponse;

    if (isPreDrafted) {
      if (!task.planResponse) {
        task.planResponse = 'Pre-drafted task: the exact implementResponse below was specified directly by the caller, not produced by a plan+implement pass.';
      }
      recordPlan(attempt, { text: task.planResponse, attempts: 0 });
      recordImplement(attempt, { text: task.implementResponse, note: 'pre-drafted (caller-supplied implementResponse)' });
    } else {
      // research_task's plan pass grants Claude-only WebSearch/WebFetch. If research
      // can't run on Claude (not opted in / no token / paused) block BEFORE the plan
      // pass rather than run a webless plan that produces nothing usable.
      if (task.domain === 'research') {
        const claudeStatus = researchClaudeStatus(task, isClaudePausedFn);
        if (!claudeStatus.ok) {
          appendHistoryEvent(task, 'blocked', claudeStatus.reason);
          return { succeeded: true, blocked: true, blockedReason: claudeStatus.reason };
        }
      }

      const planOutcome = await runPlanPass(task, {
        maybeLocked, resolvedCallIsLocal, resolvedLocalCall, profileSupportsThink, projectSearchFetch, attempt, runOrientPassFn,
      });
      if (planOutcome.blocked) {
        return { succeeded: true, blocked: true, blockedReason: planOutcome.blockedReason };
      }

      const literalEditResult = tryDeterministicLiteralEdit(task, attempt);
      if (literalEditResult) return literalEditResult;

      // Plan critique (component 4): check the grounded plan for mechanical gaps before the
      // implement ladder burns turns. A deterministic pre-filter does the high-value checks;
      // a small qwen2.5:3b call on its own lock key is the semantic fallback. Advisory --
      // "gaps" triggers exactly one bounded re-plan. Default OFF (=== 'true' to enable).
      if (resolveSourceName(task) === 'adhoc'
          && process.env.AGENT_MANAGER_ADHOC_PLAN_CRITIQUE === 'true'
          && !task._planCritiqueRevised) {
        try {
          const critique = await runPlanCritiqueFn(task, { maybeLockedOn });
          recordPlanCritique(attempt, { verdict: critique.verdict, gapCount: critique.gaps.length, viaModel: critique.viaModel });
          appendHistoryEvent(task, 'plan-critique-done', critique.verdict === 'ok' ? 'ok' : `${critique.gaps.length} gap(s): ${critique.gaps.map((g) => g.split(' ')[0]).join(',')}`);
          if (critique.verdict === 'gaps') {
            task._planCritiqueFeedback = critique.gaps;
            task._planCritiqueRevised = true;
            if (critique.gaps.some((g) => g.startsWith('SCOPE_TOO_BIG'))) {
              task._decomposeHint = critique.gaps.find((g) => g.startsWith('SCOPE_TOO_BIG'));
            }
            const rePlan = await runPlanPass(task, {
              maybeLocked, resolvedCallIsLocal, resolvedLocalCall, profileSupportsThink, projectSearchFetch, attempt, runOrientPassFn,
            });
            delete task._planCritiqueFeedback;
            if (rePlan.blocked) return { succeeded: true, blocked: true, blockedReason: rePlan.blockedReason };
          }
        } catch (e) {
          appendHistoryEvent(task, 'advisory', `plan-critique errored (non-fatal): ${String(e && e.message || e).slice(0, 160)}`);
        }
      }

      // adhoc-shaped tasks implement via a tiered LOCAL agentic ladder (harness-search ->
      // read-only agentic -> write agentic in an isolated worktree) instead of the blind
      // JSON-diff pass below -- see draftAdhocBranch(). Every path there returns a final
      // draftTask result; nothing here calls Claude.
      if (resolveSourceName(task) === 'adhoc') {
        return await draftAdhocBranch(task, {
          maybeLocked, recordModelCall, attempt, resolvedLocalCall, resolvedCallIsLocal,
          draftAdhocViaHarnessSearchFn, draftAdhocViaLocalAgenticFn, draftAdhocViaLocalAgenticWriteFn,
        });
      }

      // research_task implements via a real agentic Claude (WebSearch/WebFetch) call -- see
      // draftResearchBranch(). Same "the agentic pass already produced the final artifact,
      // skip the local plan/critique/revision loop" reasoning as the adhoc branch.
      if (task.domain === 'research') {
        return await draftResearchBranch(task, { recordModelCall, draftResearchImplementFn, isClaudePausedFn, attempt });
      }

      const implementOutcome = await runImplementPass(task, {
        maybeLocked, resolvedCallIsLocal, resolvedLocalCall, profileSupportsThink,
      }, { recordModelCall, attempt });
      if (implementOutcome.done) return implementOutcome.result;
    }

    await runCritiqueAndRevision(task, {
      maybeLocked, resolvedCallIsLocal, resolvedLocalCall, profileSupportsThink, attempt,
    });

    concludeDraft(task);

```

Problem:
`runDraftPasses` is the top-level orchestrator that sequences `runPlanPass`, `runImplementPass`, and `runCritiqueAndRevision`, while also handling the `draftAdhocBranch` path and the state-threading between each pass. Because all of that conditional branching, intermediate-state bookkeeping, and error-recovery logic lives inline in one body, a reader must hold the entire pass-sequence in working memory to understand what happens when, say, the critique pass fails and the adhoc branch is taken. The function's length is not just a line-count issue; it conflates "decide which passes to run" with "thread results between passes" with "handle the adhoc fallback," making any single change risky without re-reading the whole block.

Solution:
Extract two clearly-named helpers from inside `runDraftPasses`: (1) `selectPassSequence` (or similar) that inspects the incoming draft state and returns an ordered list of the pass functions to invoke—encapsulating the decision logic that currently mixes `runPlanPass`, `runImplementPass`, `runCritiqueAndRevision`, and the `draftAdhocBranch` guard into one tangled conditional; and (2) `threadPassResults` (or similar) that takes the ordered list and the mutable draft state, calls each pass in turn, and handles the inter-pass state handoff and the adhoc-branch fallback in one place. `runDraftPasses` itself then shrinks to a short "select → thread → return" skeleton, with the two extracted helpers carrying the bulk of the logic.

Benefits:
A reviewer can verify the pass-selection policy in `selectPassSequence` without being distracted by state-threading details, and vice-versa. Unit tests can target the selection logic (given a draft state, which passes fire?) and the threading logic (given a pass list and a failure at step N, what does the state look like?) independently, rather than exercising the full orchestrator for every edge case. Future additions—say a new pass between implement and critique—become a one-line change in the selection list rather than a re-threading of the entire inline body.

### AC-47 · runPlanPass conflates tool-access setup, re-roll/seed-fallback, and harness search
Strength: Strong
Files: src/local-draft.js
Snippet:
```
// after emitting the 'blocked' event -- when the plan pass produced no usable plan (and no
// prior plan to fall back on), else { blocked: false }.
async function runPlanPass(task, {
  maybeLocked, resolvedCallIsLocal, resolvedLocalCall, profileSupportsThink, projectSearchFetch, attempt,
}) {
  // 2026-08-25, root-caused live via a real blocked research_task (Toregem BioPharma
  // trial lookup): researchPlanPrompt's own header used to call the research plan pass
  // "intentionally throwaway" and never gave it tool access -- so it could (and did)
  // invent a plausible-looking-but-fake registry ID and site with nothing to check it
  // against, before any real research had happened. That fabrication then leaked into
  // review as if it were a verified requirement (buildVerdictPrompt hands the reviewer
  // task.planResponse directly), and three straight implement attempts got rejected for
  // "failing" to reproduce a record that never existed. Same class of fix as
  // draftResearchImplement's own WebSearch/WebFetch grant: give the PLAN pass real tool
  // access too, for research_task only, so any specific fact-like claim it makes (an
  // ID, a date, a site) has actually been looked up, not guessed. Scoped narrowly to
  // task.domain === 'research' -- every other source's plan pass is unaffected, kept as
  // a plain no-tool completion exactly as before.
  const researchPlanTools = task.domain === 'research' ? { allowedTools: 'WebSearch,WebFetch', maxTurns: 8 } : null;
  // arch_discovery / arch_import are GENERATORS registered emptyApproval:true -- their
  // own plan prompt explicitly invites "found nothing" as the correct answer, and an
  // empty implement already auto-approves as "no candidates -- nothing to apply". An
  // empty PLAN is just the terser form of that same conclusion. Confirmed live:
  // arch-discovery-community-11 (src/gpu-guard.js + its test, a clean well-documented
  // utility with no real architectural friction) blocked TWICE on "Plan pass
  // degenerate: empty", while community-10 -- same no-friction outcome -- only passed
  // because its model happened to write a 646-char "nothing found" paragraph before
  // the (also-empty) implement pass carried it to the auto-approve path. Without this,
  // every clean community is a coin-flip between those two fates. Candidate-
  // FULFILLMENT sources (arch_review, observability_fix, ...) are excluded: they have a
  // specific candidate to implement, so an empty plan there is a genuine model failure.
  // advisoryProse sources (pipeline_forensics, staleness_audit, observability_review, ...)
  // produce a prose report/verdict, not a code diff -- the plan pass's QUERY-line output is
  // supplementary grounding, never a required artifact, and critique is already skipped for
  // them (runCritiqueAndRevision). An empty plan roll must not block the whole draft:
  // confirmed live 2026-09-01, the pipeline_forensics study of the "empty-degenerate-draft"
  // signature blocked at "Plan pass degenerate: empty" -- a 1400-token plan budget spent on
  // the think trace against a 26KB evidence prompt -- so the report pass (which PR #64 gave
  // a real 16K budget) never ran at all. Let it fall through to implement, same as the
  // emptyApproval generators below.
  const allowEmptyPlan = (isEmptyApprovalSource(task.source) && !isCandidateFulfillmentSource(task.source))
    || isAdvisoryProseSource(resolveSourceName(task));
  // Fix 1/2 (2026-08-31, bra-1788142124203): for adhoc tasks, gate the plan on real
  // substance and, when a prior attempt on this same task already produced a good plan,
  // seed the pass with it rather than cold-roll every retry. Scoped to adhoc -- the
  // domain the incident lives in; other sources' plan passes are unchanged. Never blocks
  // on its own: a thin plan with no prior plan to fall back on still proceeds (with a
  // note), exactly as before -- the implement tiers, not this gate, decide feasibility.
  const substanceGated = resolveSourceName(task) === 'adhoc';
  const seedPlan = substanceGated ? bestPriorPlan(task) : null;

  if (seedPlan) task._seedPlan = seedPlan;
  const planPrompt = buildPlanPrompt(task);
  delete task._seedPlan; // transient -- the seed is baked into planPrompt now; never persist it

  const callPlan = () => maybeLocked(resolvedCallIsLocal, () => resolvedLocalCall({ prompt: planPrompt, think: profileSupportsThink, temperature: 0.4, numPredict: 1400, allowEmpty: allowEmptyPlan, source: task.source, ...researchPlanTools }), 'plan');
  const planLen = (r) => (r && !r.degenerate ? ((r.response || '').trim().length) : -1);

  let planResult = await callPlan();
  let totalAttempts = planResult.attempts || 1;
  let reRolled = false;
  if (substanceGated && !planResult.degenerate && planIsThin(planResult.response)) {
    // One thin (but not degenerate) roll -- give it exactly one more, then keep whichever
    // of the two rolls carries more content.
    reRolled = true;
    const reRoll = await callPlan();
    totalAttempts += reRoll.attempts || 1;
    if (planLen(reRoll) > planLen(planResult)) planResult = reRoll;
  }

  if (planResult.degenerate) {
    const blockedReason = `Plan pass degenerate: ${planResult.degenerate}`;
    recordPlan(attempt, { degenerate: planResult.degenerate, attempts: totalAttempts });
    appendHistoryEvent(task, 'blocked', blockedReason);
    return { blocked: true, blockedReason };
  }

  const stillThin = substanceGated && planIsThin(planResult.response);

  if (stillThin && seedPlan) {
    // Thin rolls, but a real plan from a prior attempt exists -- reuse it verbatim rather
    // than hand the implement tiers a stub with no map.
    task.planResponse = seedPlan;
    task.lastGoodPlan = seedPlan;
    recordPlan(attempt, { text: seedPlan, attempts: totalAttempts, reRolled, seededFromPrior: true });
    appendHistoryEvent(task, 'plan-done', `${totalAttempts} attempt(s), reused a prior attempt's plan (${seedPlan.length} chars) after ${reRolled ? 'two thin rolls' : 'a thin roll'}`);
  } else {
    task.planResponse = planResult.response;
    // Fix 2b: keep the last good plan outside draftAttempts (so record collapse can't drop
    // it -- it is the seed source for any later retry). Never store a thin one.
    if (!stillThin) task.lastGoodPlan = planResult.response;
    recordPlan(attempt, {
      text: planResult.response,
      attempts: totalAttempts,
      ...(reRolled ? { reRolled: true } : {}),
      ...(seedPlan ? { seededFromPrior: true } : {}),
      ...(stillThin ? { thin: true } : {}),
    });
    const notes = [
      seedPlan ? 'seeded from a prior plan' : null,
      reRolled ? 're-rolled once' : null,
      stillThin ? 'still thin, no prior plan to fall back on' : null,
    ].filter(Boolean);
    appendHistoryEvent(task, 'plan-done', `${totalAttempts} attempt(s), ${task.planResponse.length} chars${notes.length ? `, ${notes.join(', ')}` : ''}`);
  }

  // Harness-search grounding step: run the plan pass's proposed QUERY: lines against a
  // real search harness and hand the hits to implement. Which harness (if any) is
  // declared per source via `harnessSearch` on its registration -- see runHarnessSearch
  // above. Replaces the per-source branches this used to be (project_search,
  // arch_import, pipeline_self_audit, pipeline_health_audit, ui_visibility_audit,
  // staleness_audit).
  const harnessKind = getRegisteredSource(resolveSourceName(task))?.harnessSearch;
  if (harnessKind) {
    await runHarnessSearch(harnessKind, task, { projectSearchFetch, archImportFetch });
  }
```

Problem:
`runPlanPass` bundles at least three distinct responsibilities into a single body: (1) establishing plan-pass tool access, (2) the substance-gated re-roll and seed-fallback loop (`substanceGated` → `seedPlan` → `stillThin` retry), and (3) harness search. The degenerate-plan early-exit (`if (planResult.degenerate) { … return { blocked: true, blockedReason }; }`) is a single inline guard that is fine where it sits, but the multi-step re-roll/seed-fallback sequence that surrounds it is a self-contained "try again with a seed" concern that is interleaved with tool-access setup and search logic. Because these concerns share one scope, a change to the seed-fallback retry policy forces the reader to re-orient through the tool-access and search code, and vice-versa; the function's length is not incidental padding but the sum of three logically independent workflows.

Solution:
Extract the re-roll/seed-fallback loop into a helper such as `attemptSeedReroll(planResult, substanceGated, stillThin)` that owns the `substanceGated`/`seedPlan`/`stillThin` retry cycle and returns either a usable plan or a "still thin" signal. Extract the harness-search step into `resolveHarnessSearch(planContext)` so the search parameters and result-shaping live in one place. Leave the degenerate-plan guard inline in `runPlanPass` (it is a single early-return branch tightly coupled to the surrounding flow). The remaining `runPlanPass` body then reads as a short orchestration: set up tool access → check degenerate → call `attemptSeedReroll` → call `resolveHarnessSearch` → assemble the return object.

Benefits:
Each extracted helper has a single, nameable responsibility, so a reviewer can validate the seed-fallback retry policy without scanning tool-access boilerplate, and a change to harness-search parameters does not require re-reading the re-roll logic. Unit tests can target `attemptSeedReroll` with synthetic `planResult`/`substanceGated`/`stillThin` inputs in isolation, and `resolveHarnessSearch` can be tested against mock search fixtures, rather than constructing the full `runPlanPass` context for every case. The top-level function shrinks to a readable orchestration skeleton, reducing the cognitive load when onboarding or auditing the plan-pass path.

### AC-48 · resolveAgenticDraft is a monolithic multi-branch resolver
Strength: Strong
Files: src/agentic-draft-common.js
Snippet:
```
// neutral: reads only `result.response` / `result.degenerate` and stages the worktree's
// diff. `retriedForTurnBudget` only tunes the "did not end with RESOLUTION" note.
function resolveAgenticDraft(task, { result, worktreeDir, modelLabel, retriedForTurnBudget = false }) {
  const summary = (result && result.response) || '';
  // Both cleared on every outcome; set true again below only for the specific
  // draft-stage blocks a redraft could plausibly fix, which reject-retry-check.js then
  // requeues (bounded, with grounding) instead of leaving them to dead-end in blocked/.
  // A stale true from an earlier attempt must not survive a later one.
  //   turnBudgetExhausted  -- ran the whole turn budget, made zero edits, no diff
  //   retryableDraftBlock  -- the broader "adhoc tier-3 block that is redraft-eligible"
  //                           marker (turn-budget exhaustion OR a malformed decompose)
  task.turnBudgetExhausted = false;
  task.retryableDraftBlock = false;
  // draft-attempt-record.js: the caller records this tier's real output, tool activity,
  // and -- on a NON-clean outcome (degenerate / no RESOLUTION line / bad decompose) where
  // resolveAgenticDraft otherwise stages nothing -- whatever the model left in the
  // worktree, so a 20-turn tier-3 run that ends up blocked is no longer a black box.
  // All additive on the returned object; callers read succeeded/blocked/blockedReason/
  // needsClarification exactly as before. bestEffortDiff is best-effort (the worktree is
  // still alive here; cleanup runs in runAgenticDraftInWorktree's outer finally).
  const meta = {
    response: summary,
    toolCallLog: (result && result.toolCallLog) || undefined,
    turnsUsed: result && result.turnsUsed,
  };
  const bestEffortDiff = () => {
    try {
      runGit(['add', '-A'], worktreeDir);
      return runGit(['diff', '--cached'], worktreeDir).trim() || undefined;
    } catch {
      return undefined;
    }
  };

  if (result && result.degenerate) {
    return { succeeded: true, blocked: true, blockedReason: `Agentic implement pass degenerate: ${result.degenerate}${retriedForTurnBudget ? ' (retried once at a larger turn budget)' : ''}`, ...meta, capturedDiff: bestEffortDiff() };
  }

  const resolutionMatch = summary.match(RESOLUTION_RE);
  const resolution = resolutionMatch ? resolutionMatch[1].toLowerCase() : null;
  if (modelLabel) task.draftModel = modelLabel;
  meta.resolution = resolution || undefined;

  if (!resolution) {
    // Fix (2026-08-31, bra-1788142124203): the run hit its turn cap and even
    // runPlanWithTools' forced final no-tools turn (result.forcedSummary) didn't yield a
    // parseable RESOLUTION. Hard-blocking here throws the whole run away as "cannot
    // determine outcome". Instead hand it to a human as a clarification, carrying the
    // transcript and whatever partial work landed in the worktree -- the same terminal
    // shape a real RESOLUTION: needs-human-decision produces.
    if (result && result.forcedSummary) {
      const capturedDiff = bestEffortDiff();
      const edits = ((result && result.toolCallLog) || [])
        .filter((c) => c && /^(edit_file|write_file)$/.test(c.tool)).length;
      // The failure class this whole grounding change targets: the model spent its entire
      // turn budget exploring and never edited a single file (no edit/write calls, empty
      // worktree). A hardcoded "needs-human-decision" placeholder is neither a real
      // question nor a retryable state -- record a clean, honest block that
      // reject-retry-check.js can requeue once with the plan + prior-investigation map.
      if (edits === 0 && !capturedDiff) {
        task.turnBudgetExhausted = true;
        task.retryableDraftBlock = true;
        // Sticky (survives reject-retry-check's reset of turnBudgetExhausted): a leaf that
        // has demonstrably blown a full budget with zero edits is NOT confirmed-atomic --
        // local-agentic-write-draft.js's leafDecomposeLocked() reads this to let it
        // choose RESOLUTION: decompose on the next pass.
        task.turnBudgetExhaustedBefore = true;
        return {
          succeeded: true,
          blocked: true,
          blockedReason: 'Agentic implement pass exhausted its turn budget without making any edits -- likely needs grounding or a smaller scope',
          ...meta,
          capturedDiff: undefined,
        };
      }
      // Otherwise the model got somewhere (partial work in the worktree, or the forced
      // summary produced real content) -- keep the existing human-clarification path.
      task.adhocResolution = 'needs-human-decision';
      task.rawDiff = '';
      task.implementResponse = summary
        || '(the agentic implement pass ran out of turns before reaching a conclusion; see its recorded tool activity for what it had investigated)';
      return { succeeded: true, blocked: false, needsClarification: true, ...meta, capturedDiff };
    }
    const budgetNote = retriedForTurnBudget
      ? ' -- ran out of turns twice in a row; a larger budget alone will not fix this'
      : '';
    return { succeeded: true, blocked: true, blockedReason: `Agentic implement pass did not end with a RESOLUTION: line -- cannot determine outcome${budgetNote}`, ...meta, capturedDiff: bestEffortDiff() };
  }

  if (resolution === 'decompose') {
    const afterResolution = summary.slice(resolutionMatch.index + resolutionMatch[0].length);
    const subTasks = parseSubTaskProposals(afterResolution);
    const n = subTasks ? subTasks.length : 0;

    if (n === 0) {
      // The model reached a conclusion ("this is too big, split it") but produced no
      // usable sub-task JSON at all.
      //
      // If it made REAL edits first, that is "I did part of it then ran low on turns/
      // confidence" -- redirect to a CONTINUATION (finish what you started) exactly like
      // the n >= 2 branch below, rather than blocking and throwing the partial work away.
      // Confirmed live 2026-09-02 (second-brain note-graph task): two passes each made
      // several successful edit_file calls, then answered RESOLUTION: decompose with
      // malformed JSON -- every retry restarted from origin/master.
      const partialDiff = bestEffortDiff();
      const priorContinuations = Number(task.agenticContinuationCount) || 0;
      if (partialDiff && priorContinuations < MAX_AGENTIC_CONTINUATIONS) {
        task.agenticContinuationCount = priorContinuations + 1;
        task.agenticContinuationNote = summary;
        task.priorPartialDiff = partialDiff;
        task.retryableDraftBlock = true;
        task.isAgenticContinuation = true;
        return {
          succeeded: true,
          blocked: true,
          blockedReason: `Agentic implement pass made partial edits then chose RESOLUTION: decompose with no usable pieces -- requeued as continuation ${task.agenticContinuationCount}/${MAX_AGENTIC_CONTINUATIONS} to finish`,
          ...meta,
          capturedDiff: partialDiff,
        };
      }
      // No partial work (or continuation budget spent): redraft-eligible with a format
      // reminder. Sticky count of "said decompose, gave nothing usable" passes: local-
      // agentic-write-draft.js's repeated-decompose backstop fires once this reaches 2 (do
      // the split in a single clean call rather than requeue toward escalation).
      // reject-retry-check.js does not reset it.
      task.decomposeBlockCount = (Number(task.decomposeBlockCount) || 0) + 1;
      task.retryableDraftBlock = true;
      return { succeeded: true, blocked: true, blockedReason: 'Agentic implement pass said RESOLUTION: decompose but no valid JSON array of {title, rawText} sub-tasks followed it', ...meta, capturedDiff: bestEffortDiff() };
    }

    if (n === 1) {
      // A "decompose" into exactly ONE sub-task is the model saying "this is atomic" --
      // usually it just could not commit to editing. Treat the single sub-task as a
      // sharper re-scope of THIS task and requeue once (reject-retry-check.js swaps in the
      // sharper rawText). If it decomposes-to-one AGAIN after being re-scoped, that is a
      // real signal it needs a human -- escalate instead of looping.
      if (task.rescopedFromDecompose === true) {
        task.adhocResolution = 'needs-human-decision';
        task.rawDiff = '';
        task.implementResponse = `${summary}\n\n(decomposed to a single atomic sub-task twice without implementing it -- needs a human)`;
        return { succeeded: true, blocked: false, needsClarification: true, ...meta };
      }
      task.rescopedFromDecompose = true;
      task.rescopedRawText = subTasks[0].rawText;
      // Also a "said decompose, not implementable as given" pass -- counts toward the
      // repeated-decompose backstop (see the n === 0 branch).
      task.decomposeBlockCount = (Number(task.decomposeBlockCount) || 0) + 1;
      task.retryableDraftBlock = true;
      return { succeeded: true, blocked: true, blockedReason: 'Agentic pass re-scoped this to a single sharper sub-task; requeued once for a focused implement pass', ...meta, capturedDiff: bestEffortDiff() };
    }

    // A pass that made REAL edits and then answered RESOLUTION: decompose is not "this
    // can't be one change" -- it is "I did part of it and ran low on turns/confidence."
    // Accepting the split here discards that partial work (rawDiff = '') AND routinely
    // drops whatever the model already finished from the sub-task list (root-caused live
    // 2026-09-02 via the plugins-marketplace endpoint task: tier 3 wrote the catalog
    // validators in app.py, then split into "seed file" + "test file" and the endpoint
    // itself -- the actual deliverable -- silently vanished). Redirect it to a CONTINUATION
    // (finish what you started), same mechanism the needs-human-decision branch uses,
    // bounded by MAX_AGENTIC_CONTINUATIONS. Only once that budget is spent and it STILL
    // wants to split do we accept the decompose.
    const decomposeDiff = bestEffortDiff();
    const continuations = Number(task.agenticContinuationCount) || 0;
    if (decomposeDiff && continuations < MAX_AGENTIC_CONTINUATIONS) {
      task.agenticContinuationCount = continuations + 1;
      task.agenticContinuationNote = summary;
      task.priorPartialDiff = decomposeDiff;
      task.retryableDraftBlock = true;
      task.isAgenticContinuation = true;
      return {
        succeeded: true,
        blocked: true,
        blockedReason: `Agentic implement pass made partial edits then chose RESOLUTION: decompose -- requeued as continuation ${task.agenticContinuationCount}/${MAX_AGENTIC_CONTINUATIONS} to finish before any split`,
        ...meta,
        capturedDiff: decomposeDiff,
      };
    }

    task.adhocResolution = resolution;
    task.subTaskProposals = subTasks;
    task.rawDiff = '';
    // Keep the partial-work note visible for the sub-task drafters / a human even when the
    // split is finally accepted -- the diff itself is not carried (the pieces re-derive it
    // against current code), but "an earlier pass got this far" is worth stating.
    task.implementResponse = decomposeDiff
      ? `${summary}\n\n(NOTE: an earlier pass made partial edits before this split; they were not carried forward -- each sub-task starts from current \`main\`.)`
      : summary;
    return { succeeded: true, blocked: false, ...meta };
  }

  if (resolution === 'needs-human-decision') {
    const capturedDiff = bestEffortDiff();
    const continuations = Number(task.agenticContinuationCount) || 0;
    // "Re-run me", not a real question -- see MAX_AGENTIC_CONTINUATIONS. Only when real
    // partial work landed (an empty worktree here is a genuine "I could not even start").
    if (capturedDiff && continuations < MAX_AGENTIC_CONTINUATIONS && RERUN_NOT_A_QUESTION_RE.test(summary)) {
      task.agenticContinuationCount = continuations + 1;
      task.agenticContinuationNote = summary;
      task.priorPartialDiff = capturedDiff;
      task.retryableDraftBlock = true;
      task.isAgenticContinuation = true;
      return {
// ... [truncated for review: this function continues for 51 more line(s) not shown]
```

Problem:
`resolveAgenticDraft` is a single function whose body sequentially handles eight-plus distinct terminal resolution paths—clean-resolution, decompose with n=0, decompose with n=1, decompose with n≥2, needs-human-decision, and several additional state-specific branches—each carrying its own local variable setup, conditional guards, and return-shape assembly. Because every branch's logic lives inline in one body, the function grows linearly with the number of states the agentic-draft pipeline can produce, making it hard to trace a single path without scanning unrelated branches, and making it easy for a change in one branch to accidentally perturb a shared local that a neighboring branch still depends on.

Solution:
Reduce the top-level body to a short classifier (a few lines of if/else or a switch on the draft's resolved state) that delegates to one named inner function per terminal branch. Each inner function—`resolveClean`, `resolveDecomposeZero`, `resolveDecomposeOne`, `resolveDecomposeMany`, `resolveNeedsHuman`, and the remaining state-specific handlers—owns its own local variables, guards, and return construction so that no branch's setup leaks into another. The top-level function becomes a thin dispatch of roughly one line per branch, and the total line count of the outer function drops to the length of the classifier plus the delegation calls, while every branch's full logic remains reachable from the same single entry point.

Benefits:
A reviewer can verify one branch's logic in isolation without holding seven other branches in working memory; a unit test can target a single inner function by calling it directly with a crafted draft state rather than exercising the full function and hoping the right branch fires; and adding a new terminal state means adding one new inner function and one new dispatch line, rather than inserting a block mid-function where it can collide with adjacent branches' local state.

### AC-49 · Decompose `draftAdhocViaHarnessSearch` orchestration
Strength: Strong
Files: src/adhoc-harness-draft.js
Snippet:
```
 *     block the task outright.
 */
async function draftAdhocViaHarnessSearch(task, { localCall } = {}) {
  if (requiresCommandExecution(task)) {
    return { applied: false, succeeded: true, reason: 'task explicitly requires running a verification command (compile/test) this no-tool tier cannot execute -- deferring to a tier with real command access' };
  }

  const { repoRoot, pipelineDir } = getConfig();
  // Deliberately NOT model-provider.js's providerFor(task).call -- adhoc is registered
  // high-tier, so providerFor(task) resolves to Claude by default (unless
  // AGENT_MANAGER_FORCE_PROVIDER=local happens to be set), the exact opposite of what a
  // "try the local model first" tier needs. This tier is the local model, unconditionally
  // -- local-client.js's own call(), same backend runPlanWithTools() (local-tool-client.js)
  // always uses for local-agentic-draft.js's own tier, regardless of any tier/override
  // routing that exists for other purposes entirely.
  const resolvedLocalCall = localCall || require('./local-client.js').call;

  let planResult;
  try {
    planResult = await resolvedLocalCall({ prompt: adhocHarnessSearchPlanPrompt(task), think: true, temperature: 0.4, numPredict: 800, source: task.source });
  } catch (e) {
    return { applied: false, succeeded: true, reason: `plan call failed: ${e.message}` };
  }
  if (!planResult || planResult.degenerate) {
    return { applied: false, succeeded: true, reason: 'plan pass degenerate or empty' };
  }

  const queries = extractQueries(planResult.response);
  let hits = [];
  let files = [];
  if (queries.length > 0) {
    try {
      const result = archImportFetch(queries);
      hits = result.hits || [];
      files = result.files || [];
    } catch (e) {
      // Non-fatal -- same try/catch treatment pipeline_self_audit's own harness-search
      // branch gives (local-draft.js): implement proceeds with no hits, its own prompt
      // already handles that as "insufficient grounding."
    }
  }

  // No real matches at all -- this tier genuinely cannot confidently ground anything.
  // Deliberately does NOT call the implement model at all in this case (unlike
  // pipeline_self_audit/arch_import, which still ask their implement pass to look at an
  // empty-hits result and decide) -- an adhoc task's wording is far less constrained than
  // a pre-vetted cluster/candidate, so zero hits is a strong enough signal on its own to
  // skip straight to the next tier rather than spend a real implement call likely to
  // either hallucinate or (best case) just say the same "nothing found" thing itself.
  if (hits.length === 0) {
    return { applied: false, succeeded: true, reason: 'harness-search found no real matches in this repo' };
  }

  task.promptContext = task.promptContext || {};
  task.promptContext.harnessHits = hits;
  task.promptContext.harnessFiles = files;

  let implResult;
  try {
    implResult = await resolvedLocalCall({
      prompt: adhocHarnessSearchImplementPrompt(task, planResult.response),
      think: false,
      temperature: 0.3,
      numPredict: 2800,
      allowEmpty: true,
      source: task.source,
    });
  } catch (e) {
    return { applied: false, succeeded: true, reason: `implement call failed: ${e.message}` };
  }
  if (!implResult || implResult.degenerate) {
    return { applied: false, succeeded: true, reason: 'implement pass degenerate' };
  }

  const responseText = (implResult.response || '').trim();

  // 2026-08-24, Grimmethy: caught live via a real adhoc task ("show a count of
  // observability/architecture tasks in the UI") that exhausted both automatic reject-
  // retries on this exact path, twice, review correctly rejecting it both times for
  // "does not specify any changes... contradicts the task's request" -- because this
  // branch was stamping an empty response as a CONFIDENT, TERMINAL no-changes-needed
  // verdict, directly contradicting what adhocHarnessSearchImplementPrompt's own text
  // promises the model (prompts.js: "output the empty string... a deeper investigation
  // pass will take over next" -- NOT "this ends here"). An empty response here means "I
  // could not confidently ground a change from these hits," the exact same signal as the
  // zero-hits case just above -- not a reasoned decision that nothing needs to change.
  // adhoc-agentic-draft.js's real no-changes-needed mechanism (a full explained response
  // plus an explicit `RESOLUTION: no-changes-needed` marker) is what a genuine, grounded
  // "nothing to do here" verdict actually looks like in this codebase; a bare empty
  // string was never that, and treating it as if it were skipped the Claude tier this
  // exact case exists for, wasting the task's limited automatic-retry budget on a tier
  // that had already told the model it wasn't confident enough to answer.
  if (isEffectivelyEmptyResponse(responseText)) {
    return { applied: false, succeeded: true, reason: 'implement pass found insufficient grounding to confidently draft a change (empty response, per its own prompt\'s contract)' };
  }

  // A "let me read/check/..." hedge (NON_IMPL_PATTERNS) means the model itself is
  // signaling it needs more than a few grep queries can ground -- exactly the
  // "genuinely needs multi-file investigation" case the next tier exists for.
  if (NON_IMPL_PATTERNS.some((pat) => pat.test(responseText))) {
    return { applied: false, succeeded: true, reason: 'implement pass signaled it needs deeper investigation than harness-search can ground' };
  }

  let rawDiff;
  try {
    rawDiff = captureGroupBDiffInWorktree({
      repoRoot, pipelineDir, implementResponse: responseText, worktreeSuffix: `harness-${task.id}`,
    });
  } catch (e) {
    // Invalid/inapplicable Group-B JSON -- not confident enough to use; fall through.
    return { applied: false, succeeded: true, reason: `harness-search draft did not apply cleanly: ${e.message}` };
  }

  if (!rawDiff) {
    return { applied: false, succeeded: true, reason: 'harness-search draft produced no net change' };
  }

  // The diff applies cleanly and is non-empty -- but is it actually the change asked for,
  // or a token gesture (an ADR instead of the code, an unrequested delete, a forbidden
  // file)? This cheap tier should not stamp that as `implemented`; decline so the agentic
  // tiers, which can investigate, take over. See adhoc-diff-sanity.js.
  const substance = adhocDiffSubstanceProblem(task, rawDiff);
  if (substance) {
    return { applied: false, succeeded: true, reason: `harness-search draft is not a real implementation -- ${substance.reason}` };
  }

  task.adhocResolution = 'implemented';
  task.rawDiff = rawDiff;
  task.implementResponse = `Harness-search tier (local model, grounded in ${hits.length} real match(es)).\n\n=== DIFF ===\n${rawDiff}`;
  task.draftModel = localDraftModelLabel();
  return { applied: true, succeeded: true };
}
```

Problem:
`draftAdhocViaHarnessSearch` is an async orchestration function that sequentially (or conditionally) drives three distinct sub-operations—`resolvedLocalCall`, `archImportFetch`, and `captureGroupBDiffInWorktree`—and then stitches their results together. Because all three call-sites, their error-handling branches, and the result-combination logic live in a single body, the function's length is driven by the sum of three unrelated concerns rather than by one cohesive transformation. A reader must hold the entire orchestration sequence in working memory to understand which intermediate value feeds which downstream call, and any change to one sub-operation (e.g., adding a retry to `archImportFetch`) forces a diff review across the whole function, increasing the chance of accidentally disturbing the other two paths.

Solution:
Extract each of the three operational phases into its own clearly-named helper: (1) `resolveLocalCallForDraft` wrapping the `resolvedLocalCall` invocation plus its local error/normalisation logic; (2) `fetchArchImportForDraft` wrapping `archImportFetch` and any shape-mapping of the fetched payload; (3) `captureWorktreeDiffForDraft` wrapping `captureGroupBDiffInWorktree` and the diff normalisation. The remaining `draftAdhocViaHarnessSearch` body then becomes a short sequential (or parallel, if the calls are independent) pipeline that calls the three helpers, combines their return values, and returns the final draft result—roughly 10–15 lines of pure orchestration with no inline operational detail.

Benefits:
Each helper can be unit-tested in isolation by mocking its single external dependency, so a regression in, say, the diff-capture path is caught without exercising the import-fetch path. Code review diffs become scoped to one helper at a time, reducing the surface area a reviewer must validate. The top-level function reads as a table-of-contents of the draft pipeline, making it immediately obvious what the three stages are and in what order they execute, which aids onboarding and future re-ordering (e.g., parallelising independent stages).

### AC-50 · nextCandidateFulfillmentTask mixes loading, parsing, per-candidate I/O, and result assembly
Strength: Strong
Files: src/sdk/candidate-fulfillment.js
Snippet:
```
// instead of copy-pasting a second near-identical function that would inevitably drift
// (see this whole session's running theme of exactly that happening elsewhere).
function nextCandidateFulfillmentTask(candidatesPath, sourceName) {
  // lazy (see module header) -- task-sources.js is fully loaded by the time any
  // next() poll calls this.
  const { taskIdExistsInQueue } = require('../task-sources.js');
  const { defaultDomain } = getConfig();
  const text = readIfExists(candidatesPath);
  if (!text) return null;

  const sections = [];
  let pos = 0;
  while (pos < text.length) {
    const start = text.indexOf('### ', pos);
    if (start === -1) break;

    const nextH2 = text.indexOf('\n## ', start + 3);
    const nextH3 = text.indexOf('\n### ', start + 3);
    let end;
    if (nextH2 !== -1 && nextH3 !== -1) {
      end = Math.min(nextH2, nextH3);
    } else if (nextH2 !== -1) {
      end = nextH2;
    } else if (nextH3 !== -1) {
      end = nextH3;
    } else {
      end = -1;
    }

    const sectionText = end === -1 ? text.slice(start) : text.slice(start, end);
    sections.push(sectionText);
    pos = end === -1 ? text.length : end + 1;
  }

  for (const section of sections) {
    const headingLine = section.split('\n')[0];

    const idMatch = headingLine.match(/AC-\d+/);
    if (!idMatch) continue;
    const candidateId = idMatch[0];

    const strengthMatch = section.match(/^Strength:\s*(.+)$/m);
    if (!strengthMatch || strengthMatch[1].trim() !== 'Strong') continue;

    if (section.length > MAX_ARCH_REVIEW_TASK_CHARS) continue;

    // 2026-08-24 -- caught live: a real task (arch-review-ac-10, "AC-10 · Example
    // candidate", Files: foo.js) sat permanently un-completable for weeks, repeatedly
    // bulk-requeued on the assumption it was a "crash-bug casualty" rather than ever
    // having its own content re-examined -- its Problem/Solution sections were literally
    // "Problem: ...\nSolution: ..." (an unfilled template placeholder), not a real
    // finding. Traced to a real, if narrow, gap: this function has always trusted ANY
    // "Strength: Strong" section as actionable with no check that its content is real.
    // Deliberately NOT rejecting on "no referenced files exist" (see fetchedFiles'
    // own comment below -- a candidate proposing a genuinely NEW file is a valid,
    // intended shape, not a stale one) -- an ellipsis-only Problem/Solution body is a
    // much more specific, unambiguous signal: no real LLM-drafted finding ever produces
    // literally just "..." as its entire problem or solution description, regardless of
    // whether the files it names exist yet.
    const problemMatch = section.match(/^Problem:\s*\n?([\s\S]*?)(?=\n(?:Solution|Benefits):|$)/m);
    const solutionMatch = section.match(/^Solution:\s*\n?([\s\S]*?)(?=\nBenefits:|$)/m);
    const isPlaceholderBody = (m) => !m || m[1].trim() === '' || /^\.{3,}$/.test(m[1].trim());
    if (isPlaceholderBody(problemMatch) || isPlaceholderBody(solutionMatch)) continue;

    const taskId = sourceName.replace(/_/g, '-') + '-' + candidateId.toLowerCase();
    if (taskIdExistsInQueue(taskId)) continue;

    const titleMatch = headingLine.match(/AC-\d+\s*·\s*(.+)/);
    const titleText = (titleMatch ? titleMatch[1] : headingLine.replace(/^###\s*/, '')).trim();

    let filesArray = [];
    const filesMatch = section.match(/^Files:\s*(.+)$/m);
    if (filesMatch) {
      filesArray = filesMatch[1].split(',').map((f) => f.trim());
    }

    // 2026-09-02: the `Files:` line is frequently incomplete -- a candidate whose Solution
    // says "call `buildPlanPrompt` with a second arg" needs prompts.js in view to see that
    // function's real signature, but only lists local-draft.js (pipeline-forensics-fix-ac-7
    // /-ac-14). Also read any repo-relative source path the Problem/Solution prose names
    // into fetchedFiles (NOT into `files` -- those stay the candidate's declared edit
    // targets, which the review/decompose gates count against), so the drafter can ground
    // a cross-file change instead of editing blind or refusing.
    const contextFiles = [...new Set(
      [...section.matchAll(/(?<![\w/.-])((?:src|python|scripts|lib)\/[\w./-]+\.(?:js|ts|py|mjs|cjs))\b/g)].map((m) => m[1]),
    )].filter((p) => !filesArray.includes(p)).slice(0, 3);

    // Grounding fix (2026-08-21, confirmed live: observability-fix-ac-5 fabricated a
    // plausible-but-wrong `find` string -- "catch { return []; }" -- that matched nothing
    // in the real file, because this candidate's own implement pass was never shown real
    // file content, only its own prose write-up from whenever the candidate was originally
    // drafted, possibly hours or days earlier by a different pass entirely. Every OTHER
    // fulfillment-style source (arch_import, pipeline_self_audit) grounds its implement
    // pass in real, freshly-read file content; this generic consumer -- shared by
    // arch_review, arch_import_review, observability_fix, performance_fix, and
    // backlog_fulfillment all at once -- never did. Unlike arch_import's own harness
    // grounding (which has to SEARCH for candidate files because it doesn't know them yet),
    // this already knows exactly which files from the candidate's own "Files:" line, so no
    // search step is needed -- just read them, best-effort. A file that doesn't exist
    // (a candidate proposing a brand-new file, or a stale/illustrative path) is not an
    // error -- see fetchedFiles' own promptContext field, which the implement prompt is
    // told explicitly means "ground a create, or flag the mismatch, don't invent content."
    const { repoRoot } = getConfig();
    const readWindowed = (relPath, isContext) => {
      try {
        const full = path.resolve(repoRoot, relPath);
        if (!full.startsWith(path.resolve(repoRoot) + path.sep) && full !== path.resolve(repoRoot)) return null;
        const content = fs.readFileSync(full, 'utf8');
        const entry = { path: relPath, content: windowFetchedFileContent(content, section) };
        if (isContext) entry.context = true; // referenced in prose, not a declared edit target
        return entry;
      } catch {
        return null; // doesn't exist / unreadable -- not an error, see comment above
      }
    };
    const declaredFetched = filesArray.map((p) => readWindowed(p, false)).filter(Boolean);
    const contextFetched = contextFiles.map((p) => readWindowed(p, true)).filter(Boolean);
    const fetchedFiles = [...declaredFetched, ...contextFetched];

    // Path-hallucination guard (2026-08-26, Grimmethy: "Can we answer why it didn't get
    // correct files to begin with?" -- arch-review-ac-7 investigation). Same shape as the
    // isPlaceholderBody skip above (a real, precedented gap: arch-review-ac-10 sat
    // permanently un-completable for weeks because this function trusted ANY
    // "Strength: Strong" section as actionable with no check its content was real) but for
    // the "Files:" line instead of the Problem/Solution body. Confirmed live: AC-7 listed
    // 5 files (none with a directory prefix, two -- resolveGraphPath.js/getConfig.js --
    // not real files at all, both actually live together in src/config.js) despite
    // archReviewImplementPrompt's own explicit instruction to copy paths exactly as given
    // -- the model just didn't follow it. Every one of the 5 silently failed to resolve
    // above, leaving fetchedFiles empty, and the task was queued anyway, doomed to the same
    // "no real implementation code" degenerate/blocked cycle every single pass. Deliberately
    // NOT skipping on filesArray.length === 1 with zero fetchedFiles -- see this function's
    // own comment above: a candidate proposing ONE genuinely brand-new file is a valid,
    // intended shape (fetchedFiles' own promptContext meaning is "ground a create, or flag
    // the mismatch"). Multiple listed files where NONE resolve is a much stronger signal --
    // no real architectural finding proposes touching several already-existing-sounding
    // files that are ALL, simultaneously, brand new.
    if (filesArray.length >= 2 && declaredFetched.length === 0) continue;

    // Deterministic, one-level candidate pre-split (2026-09-02). A candidate declaring >=2
    // files, or laying out >=3 numbered edit steps in its Solution, is more than the local
    // 27B reliably lands in a single diff (pipeline-forensics-fix-ac-1/-ac-14 blocked+
    // exhausted exactly this way). `mustPreSplit` tells the implement pass to decompose it
    // into single-concern sub-candidates FIRST. Every sub-candidate the split writes back
    // carries `Split-Depth: 1`; this reader refuses to pre-split anything already at depth
    // >= 1, a hard recursion stop that does NOT depend on the model's judgement (the earlier
    // model-driven re-split went infinite -- AC-4..AC-12, 2026-09-01).
    const depthMatch = section.match(/^Split-Depth:\s*(\d+)\s*$/m);
    const splitDepth = depthMatch ? Number(depthMatch[1]) : 0;
    // Count numbered steps off the raw section (the Solution-only capture above stops at
    // the first end-of-line under /m, so it can't be used for this).
    const solutionSlice = section.split(/^Solution:/m)[1] ? section.split(/^Solution:/m)[1].split(/^Benefits:/m)[0] : '';
    const numberedSteps = (solutionSlice.match(/(?:^|\n)\s*\d+[.)]\s+\S/g) || []).length;
    const mustPreSplit = splitDepth === 0 && (filesArray.length >= 2 || numberedSteps >= 3);

    return {
      id: taskId,
      domain: defaultDomain,
      source: sourceName,
      title: `${candidateId} · ${titleText}`,
      promptContext: {
        candidateId,
        title: titleText,
        files: filesArray,
        fetchedFiles,
        body: section,
        splitDepth,
        mustPreSplit,
      },
    };
  }

  return null;
}
```

Problem:
`nextCandidateFulfillmentTask` performs four distinct responsibilities in a single body: (1) it loads the candidates file via `readIfExists(candidatesPath)`, (2) it walks the raw text with inline `indexOf` calls to locate and slice out individual candidate sections, (3) for each candidate it invokes the locally-defined `readWindowed` closure (which internally calls `fs.readFileSync`) to pull declared/context files and also consults `taskIdExistsInQueue` for external queue state, and (4) it assembles and returns the final fulfillment result object. Because the section-parsing logic, the per-candidate file-fetching loop, the external state check, and the result shaping are all interleaved in one scope, a reader must track closure-captured variables and the `indexOf` bookkeeping simultaneously, and any change to the candidate-file format or the queue-lookup contract forces a review of the entire function.

Solution:
Extract two helpers scoped to this function. First, `parseCandidateSections(rawText)` encapsulates the inline `indexOf`-based scanning that locates section boundaries and slices out per-candidate blocks; it takes the raw string returned by `readIfExists` and returns an array of structured section objects (name, body, declared-file list, context-file list). Second, `evaluateCandidate(section, readWindowed, taskIdExistsInQueue)` receives a single parsed section plus the two dependencies it needs—the `readWindowed` closure for fetching declared/context files and the `taskIdExistsInQueue` predicate for the external state check—and returns a per-candidate verdict object. The top-level `nextCandidateFulfillmentTask` then reduces to: call `readIfExists(candidatesPath)`, pass the text to `parseCandidateSections`, iterate the sections calling `evaluateCandidate` with the closure and predicate in hand, and assemble the final result. No new I/O is introduced; the I/O boundary remains exactly where it is today, but it is now an explicit parameter rather than an implicit closure capture.

Benefits:
`parseCandidateSections` can be unit-tested with fixture strings in isolation, verifying that the `indexOf` boundary logic handles edge cases (empty file, missing delimiters, trailing whitespace) without any filesystem access. `evaluateCandidate` makes the two external dependencies (`readWindowed`, `taskIdExistsInQueue`) visible in its signature, so a reviewer immediately sees what the function reads from disk and what external state it consults, and a mock can be injected in tests. The top-level function shrinks to a short orchestration sequence that is trivially reviewable, and future changes to the candidate-file format or the queue-lookup contract are localized to a single helper rather than scattered through a long body.

### AC-51 · Decompose `api_task_requeue` into path-resolution, branch-abandonment, and record-building helpers
Strength: Strong
Files: python/dashboard/routes/task.py
Snippet:
```

@task_bp.route("/api/task/<state>/<task_id>/requeue", methods=["POST"])
def api_task_requeue(state, task_id):
    """Manual requeue (Job Status > Blocked/Needs Clarification/Done tabs, per-row button; also the Brain Dump
    tab's "Reopen" action on an archived entry's badge): moves the task back to pending/,
    stripped to the same shape a freshly-generated task has -- every drafting/review/apply
    artifact (blockedReason, doneMarker, ornithVotes, planResponse, implementResponse, etc.)
    is dropped, not carried forward. ornithRejectCount resets to 0 deliberately: a manual
    requeue is a deliberate human do-over, not a continuation of the same automatic retry
    cycle queue-watchdog.ps1's Invoke-RejectRetryCheck already runs for review-stage
    rejections (capped at $MaxOrnithRejectRetries=2) -- carrying the old count forward would
    let a manually-requeued task block again after fewer real attempts than a task hitting
    that cap for the first time gets.

    2026-09-06, real incident: a stacked file-decompose sub-task (seq 2 of 5, sharing one
    branch with its 4 siblings -- see file-decompose-to-hub.js) blocked on a sustained
    Ollama infra outage. Its `stacked` field -- {branch, seq, total}, the ONLY thing that
    ties it back to the shared branch and its position in the sequence -- is a TOP-LEVEL
    task field, not part of promptContext, so the "fresh" rebuild below silently dropped it
    on every requeue: a human clicking Requeue on a stuck stacked sub-task would have
    detached it from its hub, breaking the coordination with no error and no visible sign
    anything was wrong until the wiring step later found the branch missing pieces.
    `dependsOn` (also file-decompose-to-hub.js, and consumed by nextAdhocTask's/
    coordinator-sweep.js's dependency gate) is the identical shape -- a top-level field a
    generic reset has no way to know matters.

    2026-09-06, same requeue, second field: `atomic` (also file-decompose-to-hub.js) was
    STILL being dropped by this same allowlist gap even after the stacked/dependsOn fix
    above -- confirmed live, the requeued sub-task's own local-draft.js pre-split check
    (`!task.atomic`, the guard that exists specifically because "a file-decompose child IS
    the output of a decomposition; re-splitting it loops") saw `atomic: undefined` and let
    the model try to decompose it AGAIN, producing a malformed 2-piece split and blocking a
    second time. `noDecompose` (set alongside `atomic` by the same code, currently unread
    elsewhere but the same coordination-field shape) is preserved too rather than assuming
    it stays unused forever. All four preserved explicitly now, when present, rather than
    trusting this allowlist to anticipate every future coordination field one at a time.

    'archived' is a distinct pseudo-state (not a real QUEUE_STATES member) for a task
    api_task_archive moved to done/_archived_no_action/ -- _task_state_index reports it as
    'archived', not 'done', so this must be handled as a separate lookup path rather than
    falling through to state_dir/task_id.json, which would 404 (real gap found 2026-08-17
    auditing the "always reversible" promise: an archived item couldn't actually be
    un-archived through the UI before this). 2026-08-24: also checks done-archive.js's own
    dated month buckets (queue/done/_archived/<YYYY-MM>/) -- a task the AUTOMATIC daily
    archive pass moved there is just as "archived" and must be just as requeueable as one a
    human moved to _archived_no_action/ by hand; see done-archive.js's own header on the
    same "always reversible" promise this endpoint already exists to uphold."""
    from app import _record_manual_requeue, _repeated_blocker_match, get_active_repo_root, logger, queue_dir, read_json_safe
    if state not in ("blocked", "needs-clarification", "done", "archived"):
        abort(400, description="only a blocked, needs-clarification, done, or archived task can be requeued")
    qdir = queue_dir()
    if not qdir:
        abort(404)
    if state == "archived":
        src = qdir / "done" / "_archived_no_action" / f"{task_id}.json"
        if not src.is_file():
            archived_root = qdir / "done" / "_archived"
            if archived_root.is_dir():
                for month_dir in archived_root.iterdir():
                    if not month_dir.is_dir():
                        continue
                    candidate = month_dir / f"{task_id}.json"
                    if candidate.is_file():
                        src = candidate
                        break
    else:
        src = qdir / state / f"{task_id}.json"
    data = read_json_safe(src)
    if not data:
        abort(404)

    # A needs-clarification task can be sent straight back for a fresh draft -- but only a NON-adhoc one. An adhoc-shaped task lives in
    # queue/adhoc/ (nextAdhocTask only scans there), and this route writes to pending/, which would silently orphan it; those have their
    # own /resolve and /answer routes below. (2026-09-20: a candidate-fulfillment task exhausted its retries on failures that were then
    # fixed, and the only way back was moving its file to blocked/ by hand.)
    if state == "needs-clarification" and (
        data.get("domain") == "adhoc" or data.get("source") in ("manual", "derived_task")
    ):
        abort(400, description=(
            "this is an adhoc-shaped task -- send it back with the file-path picker (/resolve) or the answer box (/answer), "
            "which put it where the adhoc lane claims it; a plain requeue would strand it in pending/"
        ))

    if state in ("blocked", "needs-clarification") and not (request.get_json(silent=True) or {}).get("force"):
        repeat = _repeated_blocker_match(data)
        if repeat:
            abort(409, description=(
                "This task's rejection looks like the same underlying problem as an "
                f"earlier attempt: \"{repeat[:220]}\" -- redrafting alone hasn't fixed "
                "this before and likely won't now without a real change. Diagnose the "
                "actual root cause first (or confirm you already have), then requeue "
                "again to proceed anyway."
            ))

    # If this task was already applied to a branch that never merged (task-disposition.js's
    # 'pending-merge' -- an agent/<id> branch exists, ahead of main, unmerged), a requeue is
    # about to redo the same work from scratch on a FRESH branch, so the old one is now
    # abandoned, not merely forgotten. Without this, this endpoint silently orphaned the
    # prior branch: it stayed pushed to GitHub, unmerged, with no PR and no record anywhere
    # that a later attempt superseded it. Confirmed live 2026-09-13:
    # adhoc-add-spec-comment-at-call-site-in-src-local-draft-js-1789232601161-1's
    # forbidden-path-gate-blocked branch sat dangling until a human noticed and deleted it
    # by hand. Guarded on terminalDisposition != 'merged' so a task record that (rarely)
    # reached done/ with its branch already merged is never touched.
    if data.get("terminalDisposition") != "merged":
        applied_branch = None
        for ev in reversed(data.get("history") or []):
            if isinstance(ev, dict) and ev.get("stage") == "applied" and ev.get("detail"):
                applied_branch = ev["detail"]
                break
        if applied_branch:
            from app import _invalidate_branch_cache, _run_git
            repo_root = get_active_repo_root()
            repo_root = Path(repo_root) if repo_root else None
            if repo_root:
                try:
                    _run_git(["push", "origin", "--delete", applied_branch], repo_root)
                    from branch_removals import record_branch_removal
                    record_branch_removal(qdir, applied_branch, "superseded-by-requeue", task_id=task_id,
                                          detail=f"requeued from {state}/", actor="dashboard-requeue")
                except RuntimeError as e:
                    # Non-fatal, same reasoning as api_git_merge_branch's own post-merge
                    # branch delete -- already gone, never actually pushed, or a transient
                    # network error are all fine; the requeue itself must not fail here.
                    logger.warning(
                        "Non-fatal: could not delete superseded branch %r for requeued task %r: %s",
                        applied_branch, task_id, e,
                    )
                _invalidate_branch_cache()
            abandon_iso = datetime.now(timezone.utc).isoformat()
            abandon_detail = f"superseded by a manual requeue from {state}/; prior branch {applied_branch} deleted"
            data.setdefault("history", []).append({
                "stage": "abandoned", "at": abandon_iso, "detail": abandon_detail,
            })
            data["terminalDisposition"] = "abandoned"
            # NOT closing out task-logs/<id>.json here (contrast api_git_merge_branch's
            # 'merged' handling): that file is committed only on the task's OWN branch, and
            # for an unmerged branch it was never on <main> to begin with -- there is
            # nothing on disk in this checkout to update. task-log-reconcile.js's own
            # 'abandoned' disposition (see task-disposition.js's header) has the identical
            # scope: it marks the queue/ record, it does not retroactively rescue a
            # never-merged branch's task-log onto main.

    pending_dir = qdir / "pending"
    pending_dir.mkdir(parents=True, exist_ok=True)
    dest = pending_dir / f"{task_id}.json"
    if dest.exists():
        abort(409, description=f"'{task_id}' already has a task in pending/")

    now_iso = datetime.now(timezone.utc).isoformat()
    # history must never be replaced -- it's the one append-only, complete log of
    # everything that happened to this task (see task-history.js and AGENTS.md's task-log
    # section), and a manual requeue is exactly the kind of step whose OWN reason (plus
    # whatever blockedReason/priorRejectionFeedback drove it) needs to survive in that log,
    # not vanish the moment the task starts its next draft cycle. Root-caused live
    # 2026-09-12: this endpoint used to stamp a brand-new one-entry array here, discarding
    # every prior event -- including the real blockedReason a `blocked` history event
    # already carried -- for observability-fix-ac-158 and others, so the ONLY trace left
    # of why a task ever blocked was this note's bare "manually requeued from blocked/".
    old_history = data.get("history")
    history = list(old_history) if isinstance(old_history, list) else []
    history.append({
        "stage": "requeued",
        "at": now_iso,
        "note": f"manually requeued from {state}/",
        # The exact fields a fresh rebuild used to drop silently -- carried into the log
        # entry itself so they're never lost even though the rebuilt task below won't
        # carry them forward as live working state.
        "blockedReasonAtRequeue": data.get("blockedReason"),
        "priorRejectionFeedbackAtRequeue": data.get("priorRejectionFeedback"),
    })
    fresh = {
        "id": data.get("id", task_id),
        "domain": data.get("domain"),
        "source": data.get("source"),
        "title": data.get("title"),
        "promptContext": data.get("promptContext"),
        "status": "pending",
        "createdAt": data.get("createdAt", now_iso),
        "history": history,
    }
    # Coordination fields (see this endpoint's own docstring) -- never part of the
    # drafting/review/apply history this reset is meant to clear, so always carried over
    # verbatim when present rather than silently dropped.
    if "stacked" in data:
        fresh["stacked"] = data["stacked"]
    if "dependsOn" in data:
        fresh["dependsOn"] = data["dependsOn"]
    if "atomic" in data:
        fresh["atomic"] = data["atomic"]
    if "noDecompose" in data:
        fresh["noDecompose"] = data["noDecompose"]
    dest.write_text(json.dumps(fresh, indent=2), encoding="utf-8")
    src.unlink()
    _record_manual_requeue(data, reason_hint=f"manually requeued from {state}/", requeue_writer="operator-manual")
    return jsonify({"id": task_id, "requeued": True})
```

Problem:
The `api_task_requeue` handler is 194 lines (≈110 executable after stripping the incident-history docstring and inline `#` comments). More importantly than raw length, it interleaves five independently-testable responsibilities on a single call stack: (1) resolving the source `.json` path across the flat `state/` layout and the archived month-bucket scan, (2) the adhoc-task guard, (3) the repeated-blocker guard, (4) a 35-line branch-abandonment cluster that shells out to `git push --delete`, invalidates a module-level cache, appends to a separate `branch_removals` log, and mutates `data["terminalDisposition"]`, and (5) building the "fresh" pending record with coordination-field carryover (stacked, dependsOn, atomic, noDecompose) — the exact logic whose bug caused the 2026-09-06 stacked/atomic incidents. Because all five share one function, a change to the branch-abandonment side-effects (e.g., adding a second remote, or making the cache invalidation conditional) forces a reviewer to re-verify the path-resolution and record-building logic, and none of the five pieces can be unit-tested in isolation without spinning up the full Flask app and a fake git repo.

Solution:
Extract three helpers into the same module above the route: `_resolve_requeue_source` (pure path logic, returns `Path | None`), `_abandon_superseded_branch` (the git/cache/history/disposition side-effect cluster, non-fatal on `RuntimeError`), and `_build_fresh_requeue_record` (pure data transform that preserves history and coordination fields while dropping drafting artifacts). The route handler then becomes a ~55-line linear pipeline: validate state → resolve source → read JSON → two guard checks → call the three helpers → write dest → unlink source → audit-log → return. The concrete shape of the change:

```python
# --- New helpers (inserted above the route in the same module) ---

def _resolve_requeue_source(qdir: Path, state: str, task_id: str) -> Path | None:
    """Return the source .json path for a requeue, or None if not found."""
    if state == "archived":
        src = qdir / "done" / "_archived_no_action" / f"{task_id}.json"
        if src.is_file():
            return src
        archived_root = qdir / "done" / "_archived"
        if archived_root.is_dir():
            for month_dir in sorted(archived_root.iterdir()):
                if not month_dir.is_dir():
                    continue
                candidate = month_dir / f"{task_id}.json"
                if candidate.is_file():
                    return candidate
        return None
    return qdir / state / f"{task_id}.json"


def _abandon_superseded_branch(data: dict, qdir: Path, state: str, task_id: str) -> None:
    """Delete the superseded branch on the remote, invalidate the cache,
    stamp 'abandoned' in history, and set terminalDisposition.
    Non-fatal on git errors (branch may already be gone)."""
    if data.get("terminalDisposition") == "merged":
        return
    applied_branch = None
    for ev in reversed(data.get("history") or []):
        if isinstance(ev, dict) and ev.get("stage") == "applied" and ev.get("detail"):
            applied_branch = ev["detail"]
            break
    if not applied_branch:
        return
    from app import _invalidate_branch_cache, _run_git, get_active_repo_root, logger
    repo_root = get_active_repo_root()
    repo_root = Path(repo_root) if repo_root else None
    if repo_root:
        try:
            _run_git(["push", "origin", "--delete", applied_branch], repo_root)
            from branch_removals import record_branch_removal
            record_branch_removal(
                qdir, applied_branch, "superseded-by-requeue",
                task_id=task_id, detail=f"requeued from {state}/",
                actor="dashboard-requeue",
            )
        except RuntimeError as e:
            logger.warning(
                "Non-fatal: could not delete superseded branch %r "
                "for requeued task %r: %s", applied_branch, task_id, e,
            )
        _invalidate_branch_cache()
    now_iso = datetime.now(timezone.utc).isoformat()
    data.setdefault("history", []).append({
        "stage": "abandoned", "at": now_iso,
        "detail": (
            f"superseded by a manual requeue from {state}/; "
            f"prior branch {applied_branch} deleted"
        ),
    })
    data["terminalDisposition"] = "abandoned"


def _build_fresh_requeue_record(data: dict, task_id: str, state: str, now_iso: str) -> dict:
    """Construct the fresh pending/ task dict, preserving history and
    coordination fields while dropping drafting/review/apply artifacts."""
    old_history = data.get("history")
    history = list(old_history) if isinstance(old_history, list) else []
    history.append({
        "stage": "requeued", "at": now_iso,
        "note": f"manually requeued from {state}/",
        "blockedReasonAtRequeue": data.get("blockedReason"),
        "priorRejectionFeedbackAtRequeue": data.get("priorRejectionFeedback"),
    })
    fresh = {
        "id": data.get("id", task_id),
        "domain": data.get("domain"),
        "source": data.get("source"),
        "title": data.get("title"),
        "promptContext": data.get("promptContext"),
        "status": "pending",
        "createdAt": data.get("createdAt", now_iso),
        "history": history,
    }
    for field in ("stacked", "dependsOn", "atomic", "noDecompose"):
        if field in data:
            fresh[field] = data[field]
    return fresh


# --- Slimmed route handler (replaces the 194-line body) ---

@task_bp.route("/api/task/<state>/<task_id>/requeue", methods=["POST"])
def api_task_requeue(state, task_id):
    """<docstring unchanged — incident history and cross-file contracts>"""
    from app import (
        _record_manual_requeue, _repeated_blocker_match,
        logger, queue_dir, read_json_safe,
    )

    if state not in ("blocked", "needs-clarification", "done", "archived"):
        abort(400, description=(
            "only a blocked, needs-clarification, done, or archived task can be requeued"
        ))
    qdir = queue_dir()
    if not qdir:
        abort(404)

    src = _resolve_requeue_source(qdir, state, task_id)
    if src is None or not src.is_file():
        abort(404)
    data = read_json_safe(src)
    if not data:
        abort(404)

    # adhoc guard
    if state == "needs-clarification" and (
        data.get("domain") == "adhoc"
        or data.get("source") in ("manual", "derived_task")
    ):
        abort(400, description=(
            "adhoc / manually-derived tasks in needs-clarification cannot be requeued; "
            "resolve the clarification first"
        ))

    # repeated-blocker guard
    if state in ("blocked", "needs-clarification") and not (
        request.get_json(silent=True) or {}
    ).get("force"):
        repeat = _repeated_blocker_match(data)
        if repeat:
            abort(409, description=(
                f"same blocker already recorded: {repeat}; "
                "pass {\"force\": true} to override"
            ))

    _abandon_superseded_branch(data, qdir, state, task_id)

    pending_dir = qdir / "pending"
    pending_dir.mkdir(parents=True, exist_ok=True)
    dest = pending_dir / f"{task_id}.json"
    if dest.exists():
        abort(409, description=f"'{task_id}' already has a task in pending/")

    now_iso = datetime.now(timezone.utc).isoformat()
    fresh = _build_fresh_requeue_record(data, task_id, state, now_iso)
    dest.write_text(json.dumps(fresh, indent=2), encoding="utf-8")
    src.unlink()
    _record_manual_requeue(
        data,
        reason_hint=f"manually requeued from {state}/",
        requeue_writer="operator-manual",
    )
    return jsonify({"id": task_id, "requeued": True})
```

Benefits:
Each helper is independently unit-testable without a Flask app or a real git repository: `_resolve_requeue_source` is exercised with a temporary `tmp_path` tree; `_abandon_superseded_branch` is tested by monkey-patching `_run_git` and `_invalidate_branch_cache` and asserting the `history` append and `terminalDisposition` stamp; `_build_fresh_requeue_record` is a pure function verified against fixture dicts that reproduce the 2026-09-06 stacked/atomic regression. The branch-abandonment helper also becomes directly callable from a future "sweep unmerged branches" endpoint without duplicating the git-push, cache-invalidation, and audit-log sequence. Review scope shrinks: a PR touching only the path-resolution logic no longer requires a reviewer to re-read the 35-line git block, and vice-versa. The route handler itself reads top-to-bottom as a linear precondition → act → persist pipeline, which matches how the endpoint is actually reasoned about in incident post-mortems.

### AC-52 · Decompose renderHardwareTab into per-section renderers
Strength: Strong
Files: python/dashboard/static/js/branches-joblist-hardware-tabs.js
Snippet:
```
}

async function renderHardwareTab() {
  const main = document.getElementById('main');
  const [data, watchConfig] = await Promise.all([
    fetchJson('/api/hardware/stats'),
    fetchJson('/api/hardware/watch-config').catch(() => ({})),
  ]);
  // Hardware is a swappable plugin slot (2026-09-05) -- "available: false" means no
  // plugin is currently active/running for it, distinct from a plugin running but
  // still warming up its first sample (which instead shows normally with nulls/no
  // history yet, same as before this change).
  if (data.available === false) {
    main.innerHTML = `
      <div class="empty">Hardware monitoring is off -- pick a plugin on the
        <a href="#" onclick="activeTab='plugins'; renderNav(); renderMain(); return false;">Plugins tab</a>.</div>`;
    return;
  }
  const watchChecklistHtml = renderWatchConfigChecklist(watchConfig || {});
  const cur = data.current || {};
  const avg = data.averages || {};
  const history = data.history || [];
  const ram = cur.ram || {};
  const disk = cur.disk || {};
  // Multi-GPU (2026-09-05): prefer the full "gpus" list (both this repo's plugins can
  // report it -- see hardware_stats.py's _gpus()/goatmon_adapter.py's "gpus" key) so
  // every GPU on the box gets its own labeled section, not just whichever one a
  // legacy single-"gpu" heuristic picked as "primary". Falls back to a one-item list
  // from the singular "gpu" field for any plugin that only ever reports one.
  const gpuList = (cur.gpus && cur.gpus.length) ? cur.gpus : (cur.gpu ? [cur.gpu] : []);
  const gpuLabel = (g, i) => g.name || `GPU ${g.index != null ? g.index : i}`;
  // History rows carry the same "gpus" (or singular "gpu") shape per sample -- match
  // by array position, since a GPU's index/name is stable across samples on one box.
  const gpuHistoryValue = (entry, i, field) => {
    if (entry.gpus && entry.gpus[i]) return entry.gpus[i][field];
    if (i === 0 && entry.gpu) return entry.gpu[field];
    return null;
  };
  const gpuAvg = (i, field) => {
    const values = history.map(e => gpuHistoryValue(e, i, field)).filter(v => v != null);
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  };

  const tempStat = (label, curVal, avgVal) => `
    <div class="stat"><strong>${fmtTemp(curVal)}</strong>${escapeHtml(label)} temp (24h avg ${fmtTemp(avgVal)})</div>`;

  const gpuSections = gpuList.length ? gpuList.map((g, i) => `
    <div class="field-label">${escapeHtml(gpuLabel(g, i))}</div>
    <div class="stat-row">
      <div class="stat"><strong>${fmtPercent(g.utilizationPercent)}</strong>utilization (24h avg ${fmtPercent(gpuAvg(i, 'utilizationPercent'))})</div>
      <div class="stat"><strong>${fmtMiB(g.vramUsedMiB)} / ${fmtMiB(g.vramTotalMiB)}</strong>VRAM used</div>
      <div class="stat"><strong>${fmtTemp(g.temperatureCelsius)}</strong>temp (24h avg ${fmtTemp(gpuAvg(i, 'temperatureCelsius'))})</div>
    </div>
    ${renderSparkline(history, e => gpuHistoryValue(e, i, 'utilizationPercent'), gpuAvg(i, 'utilizationPercent'), `${gpuLabel(g, i)} utilization`)}
    ${renderSparkline(history, e => gpuHistoryValue(e, i, 'vramUsedMiB'), gpuAvg(i, 'vramUsedMiB'), `${gpuLabel(g, i)} VRAM used`)}
    ${renderSparkline(history, e => gpuHistoryValue(e, i, 'temperatureCelsius'), gpuAvg(i, 'temperatureCelsius'), `${gpuLabel(g, i)} temperature`)}
  `).join('') : `<div class="field-label">GPU</div><div class="meta">No GPU detected.</div>`;

  main.innerHTML = `
    ${watchChecklistHtml}
    <div class="field-label">System</div>
    <div class="stat-row">
      <div class="stat"><strong>${fmtPercent(cur.cpuPercent)}</strong>CPU utilization (24h avg ${fmtPercent(avg.cpuPercent)})</div>
      <div class="stat"><strong>${fmtBytes(ram.usedBytes)} / ${fmtBytes(ram.totalBytes)}</strong>RAM used</div>
      <div class="stat"><strong>${fmtBytes(disk.usedBytes)} / ${fmtBytes(disk.totalBytes)}</strong>disk used</div>
      ${tempStat('CPU', cur.cpuTemperatureCelsius, avg.cpuTemperatureCelsius)}
    </div>
    ${renderSparkline(history, e => e.cpuTemperatureCelsius, avg.cpuTemperatureCelsius, 'CPU temperature')}
    ${renderSparkline(history, e => e.cpuPercent, avg.cpuPercent, 'CPU utilization')}
    ${renderSparkline(history, e => e.ram ? e.ram.usedBytes : null, avg.ramUsedBytes, 'RAM used')}
    ${renderSparkline(history, e => e.disk ? e.disk.usedBytes : null, avg.diskUsedBytes, 'disk used')}

    ${gpuSections}

    ${cur.filesystems && cur.filesystems.length ? `
    <div class="field-label">Filesystems</div>
    <table style="width:100%; border-collapse:collapse;">
      <tr><th class="meta" style="text-align:left; padding:2px 8px 2px 0;">Mount</th>
          <th class="meta" style="text-align:left; padding:2px 8px;">Device</th>
          <th class="meta" style="text-align:left; padding:2px 8px;">Type</th>
          <th class="meta" style="text-align:right; padding:2px 0;">Used / total</th></tr>
      ${cur.filesystems.map(fs => `
        <tr>
          <td class="meta" style="padding:2px 8px 2px 0; word-break:break-all;">${escapeHtml(fs.mountPoint)}${fs.readOnly ? ' <span class="badge idle">ro</span>' : ''}</td>
          <td class="meta" style="padding:2px 8px; font-family:monospace;">${escapeHtml(fs.device)}</td>
          <td class="meta" style="padding:2px 8px;">${escapeHtml(fs.type)}</td>
          <td class="meta" style="padding:2px 0; text-align:right;">${fmtBytes(fs.usedBytes)} / ${fmtBytes(fs.totalBytes)}</td>
        </tr>`).join('')}
    </table>` : ''}

    ${(cur.power || (cur.runaways && cur.runaways.length)) ? `
    <div class="field-label">Power &amp; runaway processes</div>
    <div class="stat-row">
      ${cur.power && cur.power.packageWatts != null
        ? `<div class="stat"><strong>${cur.power.packageWatts.toFixed(1)} W</strong>package power${avg.powerPackageWatts != null ? ` (24h avg ${avg.powerPackageWatts.toFixed(1)} W)` : ''}</div>`
        : ''}
    </div>
    ${cur.power && cur.power.rails && cur.power.rails.length ? `
    <table style="width:100%; border-collapse:collapse; margin-top:6px;">
      ${cur.power.rails.map(r => `
        <tr><td class="meta" style="padding:2px 8px 2px 0;">${escapeHtml(r.name)}</td>
            <td class="meta" style="padding:2px 0;">${r.watts.toFixed(2)} W</td></tr>`).join('')}
    </table>` : ''}
    ${cur.runaways && cur.runaways.length ? `
    <table style="width:100%; border-collapse:collapse; margin-top:6px;">
      ${cur.runaways.map(a => `
        <tr><td class="meta" style="padding:2px 8px 2px 0; color:var(--bad);">pid ${a.pid}</td>
            <td class="meta" style="padding:2px 0;">${escapeHtml(a.headline)}</td></tr>`).join('')}
    </table>` : `<div class="meta" style="margin-top:6px;">No runaway processes detected.</div>`}
    ` : ''}

    ${cur.processes && cur.processes.length ? `
    <div class="field-label">Top processes by CPU</div>
    <table style="width:100%; border-collapse:collapse;">
      <tr><th class="meta" style="text-align:left; padding:2px 8px 2px 0;">Process</th>
          <th class="meta" style="text-align:right; padding:2px 8px;">PID</th>
          <th class="meta" style="text-align:right; padding:2px 8px;">CPU</th>
          <th class="meta" style="text-align:right; padding:2px 8px;">RAM</th>
          <th class="meta" style="text-align:right; padding:2px 8px;">Threads</th>
          <th class="meta" style="text-align:right; padding:2px 8px;">GPU</th>
          <th class="meta" style="text-align:left; padding:2px 0;">User / scope</th></tr>
      ${cur.processes.map(p => `
        <tr>
          <td class="meta" style="padding:2px 8px 2px 0;">${escapeHtml(p.name)}</td>
          <td class="meta" style="padding:2px 8px; text-align:right;">${p.pid}</td>
          <td class="meta" style="padding:2px 8px; text-align:right;">${fmtPercent(p.cpuPercent)}</td>
          <td class="meta" style="padding:2px 8px; text-align:right;">${fmtBytes(p.rssBytes)}</td>
          <td class="meta" style="padding:2px 8px; text-align:right;">${p.threads}</td>
          <td class="meta" style="padding:2px 8px; text-align:right;">${p.gpuPercent ? fmtPercent(p.gpuPercent) : '-'}</td>
          <td class="meta" style="padding:2px 0;">${escapeHtml(p.user || '-')} &middot; ${escapeHtml(p.scopeLabel || '-')}</td>
        </tr>`).join('')}
    </table>` : ''}

    <div class="meta" style="margin-top:14px">${history.length} sample${history.length === 1 ? '' : 's'} in the last 24h &middot; sampled every 10s.</div>
  `;
}
```

Problem:
`renderHardwareTab` is a 134-line async function that interleaves five independently-conditional UI sections (system stats, per-GPU cards, filesystems table, power/runaways, top-processes table). Each section has its own data-shape guards, its own table/row rendering, and its own helper closures (`gpuHistoryValue`, `gpuAvg`, `tempStat`) that are defined at the top-level function scope and pollute the namespace of the other four sections. Changing the filesystems table requires scrolling past GPU logic and the power section; changing the multi-GPU fallback logic produces a 134-line diff hunk that a reviewer must re-read in full. The branching is real (five distinct conditional blocks, nested guards in two of them), not a flat template or a big switch/case, so the length is a genuine maintainability cost.

Solution:
Extract each of the five sections into a small named function that returns an HTML string: `renderSystemSection(cur, avg, history)`, `renderGpuSection(cur, history)`, `renderFilesystemsSection(cur)`, `renderPowerSection(cur, avg)`, and `renderProcessesSection(cur)`. The GPU helper closures (`gpuHistoryValue`, `gpuAvg`) move inside `renderGpuSection` where they are actually used; `tempStat` moves inside `renderSystemSection`. The original `renderHardwareTab` becomes a ~25-line orchestrator that fetches data, handles the `available === false` early return, and concatenates the five section outputs into `main.innerHTML`. No new imports, no new globals, no behavioural change.

Benefits:
Each section function is a pure string-returning function of a small, explicit input tuple, making it trivially unit-testable in a DOM-less harness (e.g., "given a `cur` with two GPUs and three history samples, does the GPU section render both cards?"). A reviewer diffing a power-section change now sees a 25-line hunk in `renderPowerSection` instead of a 134-line hunk. The GPU helper closures are scoped to the one function that uses them, eliminating accidental cross-section coupling. The orchestrator remains the single place that knows about the fetch, the early-return, and the overall page layout.

```diff
--- a/python/dashboard/static/js/branches-joblist-hardware-tabs.js
+++ b/python/dashboard/static/js/branches-joblist-hardware-tabs.js
@@ -856,134 +856,17 @@
-async function renderHardwareTab() {
-  const main = document.getElementById('main');
-  const [data, watchConfig] = await Promise.all([
-    fetchJson('/api/hardware/stats'),
-    fetchJson('/api/hardware/watch-config').catch(() => ({})),
-  ]);
-  if (data.available === false) {
-    main.innerHTML = `
-      <div class="empty">Hardware monitoring is off -- pick a plugin on the
-        <a href="#" onclick="activeTab='plugins'; renderNav(); renderMain(); return false;">Plugins tab</a>.</div>`;
-    return;
-  }
-  const watchChecklistHtml = renderWatchConfigChecklist(watchConfig || {});
-  const cur = data.current || {};
-  const avg = data.averages || {};
-  const history = data.history || [];
-  const ram = cur.ram || {};
-  const disk = cur.disk || {};
-  const tempStat = (label, curVal, avgVal) => `...`;
-  const gpuHistoryValue = (entry, i, field) => { ... };
-  const gpuAvg = (i, field) => { ... };
-  const gpuSections = ...;
-  main.innerHTML = `
-    ${watchChecklistHtml}
-    <div class="field-label">System</div>
-    ... (system stats + sparklines)
-    ${gpuSections}
-    ... (filesystems table)
-    ... (power & runaways)
-    ... (top processes)
-    <div class="meta">...</div>
-  `;
-}
+// ─��� Section renderers (each returns an HTML string) ──────────────────
+
+function renderSystemSection(cur, avg, history) {
+  const ram = cur.ram || {};
+  const disk = cur.disk || {};
+  const tempStat = (label, curVal, avgVal) => `
+    <div class="stat"><strong>${fmtTemp(curVal)}</strong>${escapeHtml(label)} temp (24h avg ${fmtTemp(avgVal)})</div>`;
+  return `
+    <div class="field-label">System</div>
+    <div class="stat-row">
+      <div class="stat"><strong>${fmtPercent(cur.cpuPercent)}</strong>CPU utilization (24h avg ${fmtPercent(avg.cpuPercent)})</div>
+      <div class="stat"><strong>${fmtBytes(ram.usedBytes)} / ${fmtBytes(ram.totalBytes)}</strong>RAM used</div>
+      <div class="stat"><strong>${fmtBytes(disk.usedBytes)} / ${fmtBytes(disk.totalBytes)}</strong>disk used</div>
+      ${tempStat('CPU', cur.cpuTemperatureCelsius, avg.cpuTemperatureCelsius)}
+    </div>
+    ${renderSparkline(history, e => e.cpuTemperatureCelsius, avg.cpuTemperatureCelsius, 'CPU temperature')}
+    ${renderSparkline(history, e => e.cpuPercent, avg.cpuPercent, 'CPU utilization')}
+    ${renderSparkline(history, e => e.ram ? e.ram.usedBytes : null, avg.ramUsedBytes, 'RAM used')}
+    ${renderSparkline(history, e => e.disk ? e.disk.usedBytes : null, avg.diskUsedBytes, 'disk used')}`;
+}
+
+function renderGpuSection(cur, history) {
+  const gpuList = (cur.gpus && cur.gpus.length) ? cur.gpus : (cur.gpu ? [cur.gpu] : []);
+  const gpuLabel = (g, i) => g.name || `GPU ${g.index != null ? g.index : i}`;
+  const gpuHistoryValue = (entry, i, field) => {
+    if (entry.gpus && entry.gpus[i]) return entry.gpus[i][field];
+    if (i === 0 && entry.gpu) return entry.gpu[field];
+    return null;
+  };
+  const gpuAvg = (i, field) => {
+    const values = history.map(e => gpuHistoryValue(e, i, field)).filter(v => v != null);
+    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
+  };
+  if (!gpuList.length)
+    return `<div class="field-label">GPU</div><div class="meta">No GPU detected.</div>`;
+  return gpuList.map((g, i) => `
+    <div class="field-label">${escapeHtml(gpuLabel(g, i))}</div>
+    <div class="stat-row">
+      <div class="stat"><strong>${fmtPercent(g.utilizationPercent)}</strong>utilization (24h avg ${fmtPercent(gpuAvg(i, 'utilizationPercent'))})</div>
+      <div class="stat"><strong>${fmtMiB(g.vramUsedMiB)} / ${fmtMiB(g.vramTotalMiB)}</strong>VRAM used</div>
+      <div class="stat"><strong>${fmtTemp(g.temperatureCelsius)}</strong>temp (24h avg ${fmtTemp(gpuAvg(i, 'temperatureCelsius'))})</div>
+    </div>
+    ${renderSparkline(history, e => gpuHistoryValue(e, i, 'utilizationPercent'), gpuAvg(i, 'utilizationPercent'), `${gpuLabel(g, i)} utilization`)}
+    ${renderSparkline(history, e => gpuHistoryValue(e, i, 'vramUsedMiB'), gpuAvg(i, 'vramUsedMiB'), `${gpuLabel(g, i)} VRAM used`)}
+    ${renderSparkline(history, e => gpuHistoryValue(e, i, 'temperatureCelsius'), gpuAvg(i, 'temperatureCelsius'), `${gpuLabel(g, i)} temperature`)}
+  `).join('');
+}
+
+function renderFilesystemsSection(cur) {
+  if (!cur.filesystems || !cur.filesystems.length) return '';
+  return `
+    <div class="field-label">Filesystems</div>
+    <table style="width:100%; border-collapse:collapse;">
+      <tr><th class="meta" style="text-align:left; padding:2px 8px 2px 0;">Mount</th>
+          <th class="meta" style="text-align:left; padding:2px 8px;">Device</th>
+          <th class="meta" style="text-align:left; padding:2px 8px;">Type</th>
+          <th class="meta" style="text-align:right; padding:2px 0;">Used / total</th></tr>
+      ${cur.filesystems.map(fs => `
+        <tr>
+          <td class="meta" style="padding:2px 8px 2px 0; word-break:break-all;">${escapeHtml(fs.mountPoint)}${fs.readOnly ? ' <span class="badge idle">ro</span>' : ''}</td>
+          <td class="meta" style="padding:2px 8px; font-family:monospace;">${escapeHtml(fs.device)}</td>
+          <td class="meta" style="padding:2px 8px;">${escapeHtml(fs.type)}</td>
+          <td class="meta" style="padding:2px 0; text-align:right;">${fmtBytes(fs.usedBytes)} / ${fmtBytes(fs.totalBytes)}</td>
+        </tr>`).join('')}
+    </table>`;
+}
+
+function renderPowerSection(cur, avg) {
+  if (!cur.power && !(cur.runaways && cur.runaways.length)) return '';
+  return `
+    <div class="field-label">Power &amp; runaway processes</div>
+    <div class="stat-row">
+      ${cur.power && cur.power.packageWatts != null
+        ? `<div class="stat"><strong>${cur.power.packageWatts.toFixed(1)} W</strong>package power${avg.powerPackageWatts != null ? ` (24h avg ${avg.powerPackageWatts.toFixed(1)} W)` : ''}</div>`
+        : ''}
+    </div>
+    ${cur.power && cur.power.rails && cur.power.rails.length ? `
+    <table style="width:100%; border-collapse:collapse; margin-top:6px;">
+      ${cur.power.rails.map(r => `
+        <tr><td class="meta" style="padding:2px 8px 2px 0;">${escapeHtml(r.name)}</td>
+            <td class="meta" style="padding:2px 0;">${r.watts.toFixed(2)} W</td></tr>`).join('')}
+    </table>` : ''}
+    ${cur.runaways && cur.runaways.length ? `
+    <table style="width:100%; border-collapse:collapse; margin-top:6px;">
+      ${cur.runaways.map(a => `
+        <tr><td class="meta" style="padding:2px 8px 2px 0; color:var(--bad);">pid ${a.pid}</td>
+            <td class="meta" style="padding:2px 0;">${escapeHtml(a.headline)}</td></tr>`).join('')}
+    </table>` : `<div class="meta" style="margin-top:6px;">No runaway processes detected.</div>`}`;
+}
+
+function renderProcessesSection(cur) {
+  if (!cur.processes || !cur.processes.length) return '';
+  return `
+    <div class="field-label">Top processes by CPU</div>
+    <table style="width:100%; border-collapse:collapse;">
+      <tr><th class="meta" style="text-align:left; padding:2px 8px 2px 0;">Process</th>
+          <th class="meta" style="text-align:right; padding:2px 8px;">PID</th>
+          <th class="meta" style="text-align:right; padding:2px 8px;">CPU</th>
+          <th class="meta" style="text-align:right; padding:2px 8px;">RAM</th>
+          <th class="meta" style="text-align:right; padding:2px 8px;">Threads</th>
+          <th class="meta" style="text-align:right; padding:2px 8px;">GPU</th>
+          <th class="meta" style="text-align:left; padding:2px 0;">User / scope</th></tr>
+      ${cur.processes.map(p => `
+        <tr>
+          <td class="meta" style="padding:2px 8px 2px 0;">${escapeHtml(p.name)}</td>
+          <td class="meta" style="padding:2px 8px; text-align:right;">${p.pid}</td>
+          <td class="meta" style="padding:2px 8px; text-align:right;">${fmtPercent(p.cpuPercent)}</td>
+          <td class="meta" style="padding:2px 8px; text-align:right;">${fmtBytes(p.rssBytes)}</td>
+          <td class="meta" style="padding:2px 8px; text-align:right;">${p.threads}</td>
+          <td class="meta" style="padding:2px 8px; text-align:right;">${p.gpuPercent ? fmtPercent(p.gpuPercent) : '-'}</td>
+          <td class="meta" style="padding:2px 0;">${escapeHtml(p.user || '-')} &middot; ${escapeHtml(p.scopeLabel || '-')}</td>
+        </tr>`).join('')}
+    </table>`;
+}
+
+// ── Orchestrator ──────────────────────────────────────────────────────
+
+async function renderHardwareTab() {
+  const main = document.getElementById('main');
+  const [data, watchConfig] = await Promise.all([
+    fetchJson('/api/hardware/stats'),
+    fetchJson('/api/hardware/watch-config').catch(() => ({})),
+  ]);
+  if (data.available === false) {
+    main.innerHTML = `
+      <div class="empty">Hardware monitoring is off -- pick a plugin on the
+        <a href="#" onclick="activeTab='plugins'; renderNav(); renderMain(); return false;">Plugins tab</a>.</div>`;
+    return;
+  }
+  const cur = data.current || {};
+  const avg = data.averages || {};
+  const history = data.history || [];
+  main.innerHTML = `
+    ${renderWatchConfigChecklist(watchConfig || {})}
+    ${renderSystemSection(cur, avg, history)}
+    ${renderGpuSection(cur, history)}
+    ${renderFilesystemsSection(cur)}
+    ${renderPowerSection(cur, avg)}
+    ${renderProcessesSection(cur)}
+    <div class="meta" style="margin-top:14px">${history.length} sample${history.length === 1 ? '' : 's'} in the last 24h &middot; sampled every 10s.</div>`;
+}
```

### AC-53 · Decompose renderPluginsTab into per-responsibility helpers
Strength: Strong
Files: python/dashboard/static/js/core-ui.js
Snippet:
```
}

async function renderPluginsTab() {
  const main = document.getElementById('main');
  let data;
  try {
    data = await fetchJson('/api/plugins');
  } catch (e) {
    main.innerHTML = `<div class="empty">Could not load plugins: ${escapeHtml(e.message)}</div>`;
    return;
  }
  const slotted = plugins => plugins.filter((p) => p.slot);
  const unslotted = plugins => plugins.filter((p) => !p.slot);
  const allPlugins = data.plugins || [];
  const rows = unslotted(allPlugins).map((p) => {
    const enabled = p.enabled !== false;
    return `
      <div style="display:flex; align-items:flex-start; gap:12px; padding:12px 14px; background:var(--panel); border:1px solid var(--border); border-radius:8px; margin-bottom:8px;">
        <label style="display:flex; align-items:center; gap:8px; margin-top:2px; cursor:pointer;">
          <input type="checkbox" class="plugin-toggle" data-name="${escapeAttr(p.name)}" ${enabled ? 'checked' : ''}>
        </label>
        <div style="flex:1; min-width:0;">
          <div style="font-weight:600;">${escapeHtml(p.name)} ${enabled ? '' : '<span class="badge idle" style="margin-left:6px;">disabled</span>'}</div>
          ${p.description ? `<div class="meta" style="margin-top:2px;">${escapeHtml(p.description)}</div>` : ''}
          <div class="meta" style="margin-top:4px; word-break:break-all; font-family:monospace; font-size:11px; color:var(--muted);">${escapeHtml(p.registerPath || '(no path)')}</div>
        </div>
      </div>`;
  }).join('');

  // Slotted plugins (e.g. "hardware-tab") are mutually exclusive -- a radio group, not
  // independent checkboxes, since exactly one (or none) actually runs at a time and
  // switching genuinely starts/stops the underlying process (see /api/plugins/select-slot).
  const slotGroups = {};
  slotted(allPlugins).forEach((p) => { (slotGroups[p.slot] = slotGroups[p.slot] || []).push(p); });
  const slotSections = Object.entries(slotGroups).map(([slot, members]) => {
    const radioName = `slot-${slot}`;
    const noneChecked = !members.some((m) => m.active) ? 'checked' : '';
    const options = [`
      <label style="display:flex; align-items:center; gap:8px; padding:8px 10px; cursor:pointer;">
        <input type="radio" name="${escapeAttr(radioName)}" class="slot-radio" data-slot="${escapeAttr(slot)}" value="" ${noneChecked}>
        <span>None (stop monitoring)</span>
      </label>`, ...members.map((m) => {
      const badge = m.running
        ? '<span class="badge ok" style="margin-left:6px;">running</span>'
        : '<span class="badge idle" style="margin-left:6px;">stopped</span>';
      return `
      <label style="display:flex; align-items:flex-start; gap:8px; padding:8px 10px; cursor:pointer;">
        <input type="radio" name="${escapeAttr(radioName)}" class="slot-radio" data-slot="${escapeAttr(slot)}" value="${escapeAttr(m.name)}" ${m.active ? 'checked' : ''} style="margin-top:2px;">
        <span>
          <div style="font-weight:600;">${escapeHtml(m.name)}${badge}</div>
          ${m.description ? `<div class="meta" style="margin-top:2px;">${escapeHtml(m.description)}</div>` : ''}
        </span>
      </label>`;
    })];
    return `
      <div style="padding:12px 14px; background:var(--panel); border:1px solid var(--border); border-radius:8px; margin-bottom:8px;">
        <div class="field-label" style="margin-bottom:6px;">${escapeHtml(slot)} source</div>
        <div style="display:flex; flex-direction:column; gap:2px;" id="slot-group-${escapeAttr(slot)}">${options.join('')}</div>
        <div class="meta slot-status" style="margin-top:6px;"></div>
      </div>`;
  }).join('');

  main.innerHTML = `
    <h2 style="margin-top:0;">Plugins</h2>
    ${slotSections}
    <div class="meta" style="margin-bottom:14px;">
      Only enabled plugins register their task sources. A change here restarts the pipeline if it is running so an
      in-flight draft for a now-disabled source can't stall. Manifest: <span style="font-family:monospace;">${escapeHtml(data.manifestPath || 'plugins.json')}</span>
    </div>
    <div id="plugins-list">${rows || '<div class="empty">No plugins registered yet -- add one below.</div>'}</div>

    <h3 style="margin-top:22px;">Add a plugin</h3>
    <div style="display:flex; flex-direction:column; gap:8px; max-width:640px;">
      <input type="text" id="plugin-add-path" placeholder="Absolute path to the plugin's register.js (e.g. /media/model-cache/github/agent-manager-imagegen/register.js)" style="padding:8px; background:var(--bg); border:1px solid var(--border); border-radius:6px; color:var(--text);">
      <input type="text" id="plugin-add-name" placeholder="Name (optional -- defaults to the plugin folder name)" style="padding:8px; background:var(--bg); border:1px solid var(--border); border-radius:6px; color:var(--text);">
      <input type="text" id="plugin-add-desc" placeholder="Description (optional)" style="padding:8px; background:var(--bg); border:1px solid var(--border); border-radius:6px; color:var(--text);">
      <button class="action" id="plugin-add-btn" style="align-self:flex-start;">Add plugin</button>
      <div id="plugin-add-msg" class="meta"></div>
    </div>

    <h3 style="margin-top:22px;">Available plugins</h3>
    <div id="marketplace-note" class="meta" style="margin-bottom:10px;"></div>
    <div id="marketplace-list"><div class="meta">Loading...</div></div>`;

  main.querySelectorAll('.slot-radio').forEach((radio) => {
    radio.onchange = async () => {
      const slot = radio.dataset.slot;
      const name = radio.value || null;
      const group = main.querySelector(`#slot-group-${slot}`);
      const statusEl = group ? group.closest('div').parentElement.querySelector('.slot-status') : null;
      group.querySelectorAll('input').forEach((r) => { r.disabled = true; });
      if (statusEl) statusEl.textContent = name ? `Starting ${name}...` : 'Stopping...';
      try {
        const r = await fetch('/api/plugins/select-slot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slot, name }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.description || r.status);
        if (name && !body.healthy) {
          if (statusEl) statusEl.textContent = `${name} started but did not report healthy in time -- check its log.`;
        }
        await renderPluginsTab();
      } catch (e) {
        alert('Could not switch plugin: ' + e.message);
        await renderPluginsTab();
      }
    };
  });

  main.querySelectorAll('.plugin-toggle').forEach((cb) => {
    cb.onchange = async () => {
      cb.disabled = true;
      try {
        const r = await fetch('/api/plugins/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: cb.dataset.name, enabled: cb.checked }),
        });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).description || r.status);
        await renderPluginsTab();
      } catch (e) {
        alert('Could not update plugin: ' + e.message);
        cb.checked = !cb.checked;
        cb.disabled = false;
      }
    };
  });

  const addBtn = main.querySelector('#plugin-add-btn');
  addBtn.onclick = async () => {
    const msg = main.querySelector('#plugin-add-msg');
    const registerPath = main.querySelector('#plugin-add-path').value.trim();
    const name = main.querySelector('#plugin-add-name').value.trim();
    const description = main.querySelector('#plugin-add-desc').value.trim();
    if (!registerPath) { msg.textContent = 'A register.js path is required.'; return; }
    addBtn.disabled = true;
    msg.textContent = 'Adding...';
    try {
      const r = await fetch('/api/plugins/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ registerPath, name, description }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.description || r.status);
      await renderPluginsTab();
    } catch (e) {
      msg.textContent = 'Could not add plugin: ' + e.message;
      addBtn.disabled = false;
    }
  };

  // Marketplace: fetch catalog entries annotated with install status and render
  // Install / Update / Installed controls per entry. 402/403 surface via showToast.
  (async () => {
    const listEl = main.querySelector('#marketplace-list');
    const noteEl = main.querySelector('#marketplace-note');
    let mkt;
    try {
      mkt = await fetchJson('/api/plugins/marketplace');
    } catch (e) {
      listEl.innerHTML = '<div class="meta">Could not load marketplace: ' + escapeHtml(e.message) + '</div>';
      return;
    }
    if (mkt.catalogError) {
      noteEl.textContent = mkt.catalogError;
    }
    const entries = mkt.plugins || mkt.entries || [];
    if (!entries.length) {
      listEl.innerHTML = '<div class="meta">No plugins available in the catalog.</div>';
      return;
    }
    listEl.innerHTML = entries.map((p) => {
      const installed = p.installed === true;
      const updateAvail = p.updateAvailable === true;
      let priceText = '';
      if (p.pricing && p.pricing.model && p.pricing.model !== 'free') {
        const cur = p.pricing.currency || '';
        const amt = p.pricing.amount_cents != null ? (p.pricing.amount_cents / 100) : 0;
        const interval = p.pricing.interval || '';
        priceText = escapeHtml(cur + ' ' + amt + (interval ? ' / ' + interval : ''));
      }
      let controlHtml = '';
      if (installed && updateAvail) {
        controlHtml = '<button class="action" data-mkt-action="update" data-id="' + escapeAttr(p.id) + '">Update</button>';
      } else if (installed) {
        controlHtml = '<span class="badge ok" style="margin-top:2px;">Installed</span>';
      } else {
        const isPaid = p.pricing && p.pricing.model && p.pricing.model !== 'free';
        const paidStyle = isPaid ? ' style="opacity:0.7; border-style:dashed;" title="Paid plugin -- requires a license"' : '';
        controlHtml = '<button class="action" data-mkt-action="install" data-id="' + escapeAttr(p.id) + '"' + paidStyle + '>Install</button>';
      }
      const versionLine = p.installedVersion
        ? '<div class="meta" style="margin-top:2px; font-size:11px;">Installed: ' + escapeHtml(p.installedVersion) + (updateAvail ? ' <span class="badge idle" style="margin-left:4px;">update available</span>' : '') + '</div>'
        : '';
      return '<div style="display:flex; align-items:flex-start; gap:12px; padding:12px 14px; background:var(--panel); border:1px solid var(--border); border-radius:8px; margin-bottom:8px;">'
        + '<div style="flex:1; min-width:0;">'
        + '<div style="font-weight:600;">' + escapeHtml(p.name) + (priceText ? ' <span class="meta" style="margin-left:8px;">' + priceText + '</span>' : '') + '</div>'
        + '<div class="meta" style="margin-top:2px;">' + escapeHtml(p.summary || '') + '</div>'
        + versionLine
// ... [truncated for review: this function continues for 36 more line(s) not shown]
```

Problem:
The 236-line `renderPluginsTab` interleaves five distinct responsibilities—fetching and rendering unslotted toggle rows, building slotted radio-group sections, assembling the page shell and add-plugin form, wiring three separate event-handler loops, and fetching plus rendering the marketplace catalog—each with its own data source, UI paradigm, and failure mode. A developer changing the marketplace pricing display must scroll past roughly 170 lines of unrelated toggle and radio code; a developer updating the slot-switching API contract must locate the handler buried among the toggle and add-plugin handlers. All five sections share one top-level scope with no per-section error isolation, so a DOM-query bug in one section can silently break another. The inline-CSS template strings inflate the line count, but the root issue is that five independently testable units share one call stack and one `main` reference.

Solution:
Extract each responsibility into its own named function so the top-level orchestrator drops to roughly 25 lines of sequencing. The concrete shape is:

```js
// core-ui.js — replaces the single 236-line renderPluginsTab

async function renderPluginsTab() {
  const main = document.getElementById('main');
  let data;
  try {
    data = await fetchJson('/api/plugins');
  } catch (e) {
    main.innerHTML = `<div class="empty">Could not load plugins: ${escapeHtml(e.message)}</div>`;
    return;
  }

  const all = data.plugins || [];
  const unslotted = all.filter(p => !p.slot);
  const slotted   = all.filter(p => p.slot);

  main.innerHTML = `
    <h2 style="margin-top:0;">Plugins</h2>
    ${buildSlotSections(slotted)}
    <div id="plugins-list">${buildUnslottedRows(unslotted)}</div>
    ${buildAddPluginForm()}
    <div id="marketplace-list"></div>
    <div id="marketplace-note"></div>`;

  wireSlotRadios(main);
  wirePluginToggles(main);
  wireAddPluginForm(main);
  renderMarketplace(main);
}

function buildUnslottedRows(plugins) { /* existing checkbox-row template */ }
function buildSlotSections(plugins)   { /* existing radio-group template */ }
function buildAddPluginForm()         { /* existing form markup */ }

function wireSlotRadios(main) {
  main.querySelectorAll('.slot-radio').forEach(radio => {
    radio.onchange = async () => { /* existing select-slot handler */ };
  });
}

function wirePluginToggles(main) {
  main.querySelectorAll('.plugin-toggle').forEach(cb => {
    cb.onchange = async () => { /* existing toggle handler */ };
  });
}

function wireAddPluginForm(main) {
  const btn = main.querySelector('#plugin-add-btn');
  btn.onclick = async () => { /* existing add handler */ };
}

async function renderMarketplace(main) {
  const listEl = main.querySelector('#marketplace-list');
  const noteEl = main.querySelector('#marketplace-note');
  let mkt;
  try { mkt = await fetchJson('/api/plugins/marketplace'); }
  catch (e) { noteEl.textContent = e.message; return; }
  /* existing catalog card rendering */
}
```

Each extracted function takes a data array or a `main` element and returns/renders HTML, making it independently unit-testable with a mock DOM node or a plain data fixture.

Benefits:
Once decomposed, a change to the marketplace card layout touches only `renderMarketplace` and its template—no scrolling through toggle or radio code. The three event-wiring functions can be tested in isolation by constructing a minimal DOM stub and asserting that the correct `fetchJson` URL is called on the right user action. Code review diffs become scoped to one responsibility at a time, and the single shared top-level scope (where a typo in one `querySelector` could silently break a sibling section) is replaced by per-function error boundaries. The top-level function becomes a readable table-of-contents that a new contributor can scan in under ten seconds.

### AC-54 · Extract event-wiring and async I/O from renderTaskDetailModal
Strength: Strong
Files: python/dashboard/static/js/task-detail-modal.js
Snippet:
```
}

function renderTaskDetailModal(task) {
  const backdrop = document.getElementById('modal-backdrop');
  const content = document.getElementById('modal-content');
  let html = `<button class="close" onclick="closeDetail()">&times;</button><h2>${task.id}</h2>`;
  // "Send to Chat" (2026-09-01) -- dumps this task's key context into the System Chat
  // panel as a user message (via sendTextToChat -> POST /api/chat/inject, no model call)
  // so a follow-up can be had about it. Button sits in the modal's top action area, same
  // .secondary style as Discuss/Edit/Delete. Wired below (task-send-to-chat) rather than
  // inlined so the multi-line payload isn't quote-escaping trouble in an onclick string.
  // Premium Priority toggle (2026-09-07, Grimmethy: "I'll need a way in app to be able
  // to set that premium priority slot for any specific task. I am getting tired of
  // manually selecting it for the worker queue every pass.") -- POSTs
  // /api/task-anywhere/<id>/premium-priority, which finds the task wherever it currently
  // sits (pending/blocked/needs-clarification/drafting/adhoc) and stamps/clears
  // task.premiumPriority; next-claimable-task.js's effectivePriority() then sorts it
  // ahead of EVERY other task, every tick, until this is turned off again or the task
  // reaches done -- unlike the Workers tab's per-instance assign-task pin (one-shot,
  // cleared the moment it's claimed), this is meant to be "set once, forget it."
  const premiumOn = !!task.premiumPriority;
  html += `<div style="margin:8px 0 4px">`
    + `<button type="button" class="secondary" id="task-send-to-chat">Send to Chat</button> `
    + `<button type="button" class="${premiumOn ? 'action' : 'secondary'}" id="task-premium-priority" title="${premiumOn ? 'Currently claimed ahead of everything else in the queue, every pass, until turned off or the task completes. Click to turn off.' : 'Always claim this task first, every pass, regardless of source or age -- stays on until you turn it off or the task completes.'}">${premiumOn ? '★ Premium Priority (on)' : '☆ Set Premium Priority'}</button>`
    + `</div>`;
  if (task._foundState) html += `<div class="field-label">Queue State</div><div>${escapeHtml(task._foundState)}</div>`;
  html += `<div><strong>${escapeHtmlBright(task.title || '')}</strong></div>`;
  // Hub back-link (2026-09-06, Grimmethy: "when a task is a sub-task of a hub I should be
  // able to click into the hub task from the top of the sub task's task log") -- the
  // inverse of renderSubTaskChecklist just below (which shows a hub's children): a
  // decomposed sub-task's promptContext.decomposedFrom already names its owning hub's id
  // (file-decompose-to-hub.js, applyAdhocDiff's own decompose path), but nothing ever
  // surfaced it -- a human landing on a stuck sub-task (like the stacked file-decompose
  // incident this same night) had no one-click way back to the hub coordinating it.
  // taskLink() + the existing data-open-task-anywhere delegation below already do the
  // rest -- the hub could be in coordinating/, done/, or blocked/, so this doesn't guess.
  if (task.promptContext && task.promptContext.decomposedFrom) {
    html += `<div class="field-label">Part of Hub</div><div>${taskLink(task.promptContext.decomposedFrom)}</div>`;
  }
  html += renderSubTaskChecklist(task);
  html += renderRelatedTasks(task);
  // Task metadata (2026-08-26, Grimmethy: "At the top of every task I'd like to see a
  // bit of meta data. How much machine time was spent on the task and a list of all the
  // files it touched") -- totalLatencyMs sums real wall-clock time across every model
  // call this task made (see _task_cost_summary's own comment: recorded for local Ollama
  // calls the same as Claude ones, unlike totalCostUsd which is $0, not absent, for an
  // all-local task). _filesTouched is server-computed from whichever shape this task's
  // actual on-disk change came in (a unified diff, or a Group B JSON change list) --
  // empty for a task that never wrote to the filesystem at all (a verdict-only audit, a
  // split proposal), not an error.
  if (task._costSummary && task._costSummary.totalLatencyMs != null) {
    html += `<div class="field-label">Machine Time</div><div>${fmtDuration(task._costSummary.totalLatencyMs / 1000)} across ${task._costSummary.totalCalls} model call(s)</div>`;
  }
  if (task._filesTouched) {
    const filesLabel = task._filesTouched.length
      ? task._filesTouched.map(f => `<code>${escapeHtml(f)}</code>`).join('<br>')
      : '<span class="meta">no files touched</span>';
    html += `<div class="field-label">Files Touched (${task._filesTouched.length})</div><div>${filesLabel}</div>`;
  }
  // Estimated Anthropic API cost for this ONE task (2026-08-23, Grimmethy: "We should
  // include estimated cost tracking in the job page itself") -- api_task_detail/
  // api_task_anywhere sum every model_calls row for this task_id server-side (a task can
  // carry several real calls: plan, implement, critique, revision), since task.abCallId
  // on the task itself only ever holds the MOST RECENT one. _costSummary is null (not a
  // zeroed object) when the db/column isn't available or no calls exist yet for this
  // task at all -- shown only when there's something real to show.
  if (task._costSummary) {
    const cs = task._costSummary;
    // hypotheticalCostUsd (2026-08-23, Grimmethy: "Clarification on the anthropic
    // costs. I'd like estimates for if we had used the API. Even if we used the local
    // models.") -- unlike totalCostUsd (real spend, $0 for an all-local task), this is
    // always a real number: what THIS task would have cost had every one of its calls,
    // local or not, gone through the API.
    const realLabel = cs.totalCostUsd > 0
      ? `${fmtUsd(cs.totalCostUsd)} real (${cs.callsWithCost}/${cs.totalCalls} call(s) via Claude)`
      : `$0 real -- all ${cs.totalCalls} call(s) ran locally`;
    const hLabel = cs.hypotheticalCostUsd != null ? ` · ${fmtUsd(cs.hypotheticalCostUsd)} est. if every call had used the API` : '';
    html += `<div class="field-label">Estimated API Cost</div><div>${realLabel}${hLabel}</div>`;
  }
  // Request / Input (2026-08-30, Grimmethy: "I get no indication of what actually
  // happened") -- the task's actual INPUT (what the model was asked to act on). Different
  // sources stash it under different promptContext keys; app.py's _task_input_summary
  // normalises them into a [{label, text}] list so a blocked product_spec task shows its
  // ~2KB request brief (promptContext.requestText) instead of just a truncated title.
  if (task._requestInput && task._requestInput.length) {
    for (const item of task._requestInput) {
      html += `<div class="field-label">${escapeHtml(item.label)}</div><pre>${escapeHtml(item.text)}</pre>`;
    }
  }
  html += `<div class="field-label">Domain / Source</div><div>${task.domain || ''} / ${task.source || ''}</div>`;
  if (task.blockedReason) html += `<div class="field-label">Blocked Reason</div><div style="color:var(--bad)">${escapeHtmlBright(task.blockedReason)}</div>`;
  if (task.branch) html += `<div class="field-label">Branch</div><div>${task.branch}</div>`;
  if (task.promptContext && task.promptContext.prefetchedPaths && task.promptContext.prefetchedPaths.length) {
    html += `<div class="field-label">Prefetched Paths</div><div>${task.promptContext.prefetchedPaths.map(p => `<code>${escapeHtml(p)}</code>`).join('<br>')}</div>`;
  }
  // staleness_audit (2026-08-22, Grimmethy: "I don't have information in the task page
  // about when it was actually set up. The pipeline history only shows the newest
  // staleness audit. All previous steps are missing.") -- this task's OWN
  // task.history[] only ever covers its own short life (created -> drafted -> reviewed);
  // the thing a human actually needs to judge "is this really stale" is the ORIGINAL
  // flagged task's own dates, which staleness-audit.js now stamps as structured fields
  // (originalTitle/originalCreatedAt/originalLastActivityAt) specifically so this can
  // render them directly instead of leaving them buried in evidenceText's prose (which
  // only the drafting MODEL ever reads).
  if (task.source === 'staleness_audit' && task.promptContext && task.promptContext.originalTaskId) {
    const pc = task.promptContext;
    html += `<div class="field-label">Original Flagged Task</div><div>`
      + `<code>${escapeHtml(pc.originalTaskId)}</code>`
      + (pc.originalTitle ? `<br>${escapeHtml(pc.originalTitle)}` : '')
      + `<br><span class="meta">Created: ${pc.originalCreatedAt ? new Date(pc.originalCreatedAt).toLocaleString() : 'unknown'}`
      + ` &middot; Last activity: ${pc.originalLastActivityAt ? new Date(pc.originalLastActivityAt).toLocaleString() : 'unknown'}</span>`
      + (pc.reasons && pc.reasons.length ? `<br><span class="meta">Flagged: ${pc.reasons.map(escapeHtml).join(', ')}</span>` : '')
      + `</div>`;
  }
  html += renderForensicsStudyBlock(task);
  // For advisoryProse sources (pipeline_forensics) the deliverable IS implementResponse --
  // a root-cause report, not a diff. Rendered dead last under a generic "Implement" label,
  // it reads as buried; hoist it right below the study framing so the modal leads with the
  // conclusion. The bottom-of-modal block is then skipped (reportShown).
  let reportShown = false;
  if (PROSE_REPORT_SOURCES.has(task.source) && task.implementResponse) {
    html += `<div class="field-label">Root-Cause Report</div><pre>${escapeHtmlBright(task.implementResponse)}</pre>`;
    reportShown = true;
  }
  if (task.needsClarification) html += renderClarificationPicker(task);
  // Pipeline History: task.history[] (task-history.js's appendHistoryEvent -- see that
  // module for the schema). Was written correctly the whole time this session but never
  // rendered anywhere in the app -- the data existed only if you went and read the raw
  // task JSON off disk yourself, which defeats the point of a per-step timeline being a
  // dashboard feature at all. Entries come in two shapes: older ones only ever have
  // `status` (no `stage`, no `detail`) from before task-history.js existed -- render both
  // so a task whose life started before this feature shipped doesn't just show a gap.
  if (task.history && task.history.length) {
    const liveBadge = TASK_DETAIL_LIVE_STATES.has(task._foundState || '')
      ? ` <span class="meta" title="this task is mid-pass; new steps appear here automatically">● live</span>` : '';
    html += `<div class="field-label">Pipeline History${liveBadge}</div><div class="task-history">`;
    html += task.history.map(h => {
      const label = h.stage || h.status || '?';
      const when = h.at ? new Date(h.at).toLocaleString() : '';
      const detail = h.detail || h.note || '';
      return `<div class="task-history-row"><span class="task-history-stage">${escapeHtml(label)}</span> `
        + `<span class="meta">${escapeHtml(when)}</span>`
        + (detail ? `<div class="meta">${escapeHtml(detail)}</div>` : '')
        + `</div>`;
    }).join('') + `</div>`;
  }
  // Draft Attempts: one collapsible record per draftTask() run (draft-attempt-record.js).
  // task.planResponse / task.implementResponse below only ever show the LAST run; this is
  // the per-attempt history -- every earlier plan, every tier's decline reason + response,
  // every tier-3 worktree diff -- so following up on a task that failed N times no longer
  // means re-investigating from scratch.
  html += renderDraftAttempts(task);
  html += renderWorkLog(task);
  html += renderHarnessHits(task);
  html += renderEvidenceBundle(task);
  // A "degenerate: empty" block means the model returned nothing for that pass -- the
  // field is absent, not present-and-empty, so without this the modal just omits the
  // section and the timeline is the only hint anything ran. Say it explicitly.
  const emptyPlan = !task.planResponse && /plan pass degenerate/i.test(task.blockedReason || '');
  const emptyImpl = !task.implementResponse && /implement pass degenerate/i.test(task.blockedReason || '');
  if (task.planResponse) html += `<div class="field-label">Plan</div><pre>${escapeHtmlBright(task.planResponse)}</pre>`;
  else if (emptyPlan) html += `<div class="field-label">Plan</div><pre class="meta">(the plan pass returned an empty response — nothing was drafted; see Blocked Reason above)</pre>`;
  if (task.implementResponse && !reportShown) html += `<div class="field-label">Implement</div><pre>${escapeHtmlBright(task.implementResponse)}</pre>`;
  else if (emptyImpl) html += `<div class="field-label">Implement</div><pre class="meta">(the implement pass returned an empty response — nothing was drafted; see Blocked Reason above)</pre>`;
  content.innerHTML = html;
  backdrop.classList.add('open');
  // Jump to another task from an in-modal link (the forensic study's failing/winner ids) --
  // same delegated pattern the Recent Tasks / Workers lists use.
  content.querySelectorAll('[data-open-task-anywhere]').forEach((link) => {
    link.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openTaskAnywhere(link.dataset.openTaskAnywhere); };
  });
  if (task.needsClarification) wireClarificationPicker(task.id);
  // "Send to Chat" button handler (declared in the modal HTML above). 2026-09-07: used
  // to dump this task's title/source/blockedReason/request/plan/implement text into the
  // System Chat panel as one user message -- measured live at ~13k chars / a real
  // 10,713-token first turn (65% of the local chat's 16,384-token window,
  // instances/context-budget-audit.log), most of which the conversation often never
  // needed. Now injects just the id + title; the model has real lookup tools
  // (read_task/search_tasks, local-tool-client.js) to pull the rest -- summary first,
  // then one specific section (plan/implement/history/blockedReason) only if a question
  // actually needs it -- instead of paying for the whole blob on every single click. See
  // concept-send-to-chat-307f1b's research for the two gaps this closes (no lookup tool
  // existed, no search existed) and the plan behind this change.
  // VERIFIED 2026-09-08 (this file): button created at line 221; this handler reads ONLY
  // task.id (line 387) and task.title (line 388) -- none of blockedReason/request/plan/
  // implement -- and hard-caps the payload at <=200 chars before sendTextToChat
  // (core-ui.js:783), which POSTs the { text } verbatim to /api/chat/inject with no
  // further expansion. That is the full, complete scope of what gets injected.
  const taskSendToChatBtn = document.getElementById('task-send-to-chat');
  if (taskSendToChatBtn) {
    taskSendToChatBtn.onclick = async () => {
      taskSendToChatBtn.disabled = true;
      try {
        const parts = [`# ${task.id}`];
        if (task.title) parts.push('title: ' + task.title);
        let text = parts.join('\n\n');
        if (text.length > 200) text = text.slice(0, 199) + '…'; // hard cap: sendTextToChat must never receive >200 chars
        await sendTextToChat(text); // POSTs, expands the sidebar, tells the plugin iframe to refresh; throws on !ok
        showToast('Sent to chat', 'info');
      } catch (e) {
        showToast('Could not send to chat: ' + e.message);
      } finally {
// ... [truncated for review: this function continues for 27 more line(s) not shown]
```

Problem:
renderTaskDetailModal spans 227 lines and mixes two distinct responsibilities: building the modal's HTML string (≈150 lines of linear `if (task.X) html += …` field appends) and wiring post-render DOM events (≈45 lines of click-delegation, clarification-picker binding, and an async send-to-chat handler that disables the button, makes a network call, and manages disabled-state transitions). The async handler in particular violates the function's implicit contract of "produce a string and set innerHTML" — a future change to the chat payload forces a reader to scroll through 150 lines of `<div>` concatenation to find the `onclick`, and the handler cannot be unit-tested in isolation without exercising the entire HTML builder.

Solution:
Extract the event-wiring block (task-link delegation, clarification-picker binding, and the async send-to-chat handler) into a new `wireTaskDetailModalEvents(content, task)` function called at the end of `renderTaskDetailModal` after `content.innerHTML = html`. The linear field-appending stays in place — splitting 18 two-line conditionals into 18 one-line calls adds ceremony without reducing cognitive load. Optionally, the pipeline-history `.map()` block (≈15 lines with its own loop, badge ternary, and date formatting) can be extracted into `renderPipelineHistory(task)` returning an HTML string.

```diff
--- a/python/dashboard/static/js/task-detail-modal.js
+++ b/python/dashboard/static/js/task-detail-modal.js
@@ -207,6 +207,7 @@ function renderTaskDetailModal(task) {
   const backdrop = document.getElementById('modal-backdrop');
   const content = document.getElementById('modal-content');
   let html = `<button class="close" onclick="closeDetail()">&times;</button><h2>${task.id}</h2>`;
   /* … all existing html += … lines unchanged … */
   content.innerHTML = html;
   backdrop.classList.add('open');
-  content.querySelectorAll('[data-open-task-anywhere]').forEach((link) => {
-    link.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openTaskAnywhere(link.dataset.openTaskAnywhere); };
-  });
-  if (task.needsClarification) wireClarificationPicker(task.id);
-  const taskSendToChatBtn = document.getElementById('task-send-to-chat');
-  if (taskSendToChatBtn) {
-    taskSendToChatBtn.onclick = async () => {
-      taskSendToChatBtn.disabled = true;
-      try {
-        const parts = [`# ${task.id}`];
-        if (task.title) parts.push('title: ' + task.title);
-        let text = parts.join('\n\n');
-        if (text.length > 200) text = text.slice(0, 199) + '\u2026';
-        await sendTextToChat(text);
-        showToast('Sent to chat', 'info');
-      } catch (e) {
-        showToast('Could not send to chat: ' + e.message);
-      } finally {
-        taskSendToChatBtn.disabled = false;
-      }
-    };
-  }
+  wireTaskDetailModalEvents(content, task);
 }
+
+function wireTaskDetailModalEvents(content, task) {
+  content.querySelectorAll('[data-open-task-anywhere]').forEach((link) => {
+    link.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openTaskAnywhere(link.dataset.openTaskAnywhere); };
+  });
+  if (task.needsClarification) wireClarificationPicker(task.id);
+  const taskSendToChatBtn = document.getElementById('task-send-to-chat');
+  if (taskSendToChatBtn) {
+    taskSendToChatBtn.onclick = async () => {
+      taskSendToChatBtn.disabled = true;
+      try {
+        const parts = [`# ${task.id}`];
+        if (task.title) parts.push('title: ' + task.title);
+        let text = parts.join('\n\n');
+        if (text.length > 200) text = text.slice(0, 199) + '\u2026';
+        await sendTextToChat(text);
+        showToast('Sent to chat', 'info');
+      } catch (e) {
+        showToast('Could not send to chat: ' + e.message);
+      } finally {
+        taskSendToChatBtn.disabled = false;
+      }
+    };
+  }
+}
```

Benefits:
renderTaskDetailModal drops from 227 to roughly 170 lines, and every remaining line serves the single concern of "build the modal's HTML." The 50+ lines of event wiring and async I/O now live in wireTaskDetailModalEvents, which is independently testable (mock sendTextToChat, assert button disabled-state transitions) without exercising the HTML builder. A reviewer changing the chat payload sees a 20-line function instead of scrolling past 150 lines of `<div>` concatenation. The linear field-appending stays readable top-to-bottom in its original order, which is exactly the reading order a developer needs when adding a new task field.

### AC-55 · Decompose resolveAgenticDraft resolution-class branches into named handlers
Strength: Strong
Files: src/agentic-draft-common.js
Snippet:
```
// neutral: reads only `result.response` / `result.degenerate` and stages the worktree's
// diff. `retriedForTurnBudget` only tunes the "did not end with RESOLUTION" note.
function resolveAgenticDraft(task, { result, worktreeDir, modelLabel, retriedForTurnBudget = false }) {
  const summary = (result && result.response) || '';
  // Both cleared on every outcome; set true again below only for the specific
  // draft-stage blocks a redraft could plausibly fix, which reject-retry-check.js then
  // requeues (bounded, with grounding) instead of leaving them to dead-end in blocked/.
  // A stale true from an earlier attempt must not survive a later one.
  //   turnBudgetExhausted  -- ran the whole turn budget, made zero edits, no diff
  //   retryableDraftBlock  -- the broader "adhoc tier-3 block that is redraft-eligible"
  //                           marker (turn-budget exhaustion OR a malformed decompose)
  task.turnBudgetExhausted = false;
  task.retryableDraftBlock = false;
  // draft-attempt-record.js: the caller records this tier's real output, tool activity,
  // and -- on a NON-clean outcome (degenerate / no RESOLUTION line / bad decompose) where
  // resolveAgenticDraft otherwise stages nothing -- whatever the model left in the
  // worktree, so a 20-turn tier-3 run that ends up blocked is no longer a black box.
  // All additive on the returned object; callers read succeeded/blocked/blockedReason/
  // needsClarification exactly as before. bestEffortDiff is best-effort (the worktree is
  // still alive here; cleanup runs in runAgenticDraftInWorktree's outer finally).
  const meta = {
    response: summary,
    toolCallLog: (result && result.toolCallLog) || undefined,
    turnsUsed: result && result.turnsUsed,
  };
  const bestEffortDiff = () => {
    try {
      stageDraftChanges({ worktreeDir, runGit, task });
      // --full-index --binary: see group-b-worktree-diff.js's own note (2026-09-14) --
      // without both flags together, `git apply` refuses a binary patch outright (or
      // fails with "missing binary patch data") if git's own heuristic ever decides a
      // produced file is binary (a literal NUL byte in otherwise-ordinary source content
      // is enough), even though the file itself is perfectly normal text. Costs nothing
      // for the common text-patch case.
      // normalizeDiffOutput (not a bare .trim()): see its own header note -- a bare
      // .trim() strips the trailing blank line a `GIT binary patch` section structurally
      // requires (corrupt binary patch at apply time), and for an ordinary text diff
      // fails to restore the exactly-one trailing newline `git apply` needs (the
      // original 2026-09-08 incident this shared helper exists to fix).
      return normalizeDiffOutput(runGit(['diff', '--cached', '--full-index', '--binary'], worktreeDir)) || undefined;
    } catch {
      return undefined;
    }
  };

  if (result && result.degenerate) {
    return { succeeded: true, blocked: true, blockedReason: `Agentic implement pass degenerate: ${result.degenerate}${retriedForTurnBudget ? ' (retried once at a larger turn budget)' : ''}`, ...meta, capturedDiff: bestEffortDiff() };
  }

  const resolutionMatch = summary.match(RESOLUTION_RE);
  const resolution = resolutionMatch ? resolutionMatch[1].toLowerCase() : null;
  if (modelLabel) task.draftModel = modelLabel;
  meta.resolution = resolution || undefined;

  if (!resolution) {
    // Fix (2026-08-31, bra-1788142124203): the run hit its turn cap and even
    // runPlanWithTools' forced final no-tools turn (result.forcedSummary) didn't yield a
    // parseable RESOLUTION. Hard-blocking here throws the whole run away as "cannot
    // determine outcome". Instead hand it to a human as a clarification, carrying the
    // transcript and whatever partial work landed in the worktree -- the same terminal
    // shape a real RESOLUTION: needs-human-decision produces.
    if (result && result.forcedSummary) {
      const capturedDiff = bestEffortDiff();
      const edits = ((result && result.toolCallLog) || [])
        .filter((c) => c && /^(edit_file|write_file)$/.test(c.tool)).length;
      // The failure class this whole grounding change targets: the model spent its entire
      // turn budget exploring and never edited a single file (no edit/write calls, empty
      // worktree). A hardcoded "needs-human-decision" placeholder is neither a real
      // question nor a retryable state -- record a clean, honest block that
      // reject-retry-check.js can requeue once with the plan + prior-investigation map.
      if (edits === 0 && !capturedDiff) {
        task.turnBudgetExhausted = true;
        task.retryableDraftBlock = true;
        // Sticky (survives reject-retry-check's reset of turnBudgetExhausted): a leaf that
        // has demonstrably blown a full budget with zero edits is NOT confirmed-atomic --
        // local-agentic-write-draft.js's leafDecomposeLocked() reads this to let it
        // choose RESOLUTION: decompose on the next pass.
        task.turnBudgetExhaustedBefore = true;
        return {
          succeeded: true,
          blocked: true,
          blockedReason: 'Agentic implement pass exhausted its turn budget without making any edits -- likely needs grounding or a smaller scope',
          ...meta,
          capturedDiff: undefined,
        };
      }
      // Otherwise the model got somewhere (partial work in the worktree, or the forced
      // summary produced real content) -- keep the existing human-clarification path.
      task.adhocResolution = 'needs-human-decision';
      task.rawDiff = '';
      task.implementResponse = summary
        || '(the agentic implement pass ran out of turns before reaching a conclusion; see its recorded tool activity for what it had investigated)';
      // 2026-09-16, pipeline hardening: result.forcedSummaryNonCompliant means the model
      // ignored runPlanWithTools' own explicit, bounded, twice-repeated demand for a
      // RESOLUTION: line -- a mechanical gate/model-compliance failure, NOT the same kind
      // of thing as a genuine RESOLUTION: needs-human-decision the model actually chose.
      // Confirmed live: this exact shape stranded a task with a fully correct diff already
      // sitting in its own history behind a human-only queue, twice in a row, because
      // nothing distinguished "the model declined to decide" from "the model never even
      // tried to answer the question this turn asked." Stamped here so a future triage
      // pass (or a human reading the task) can tell the two apart without re-deriving it
      // from the raw transcript.
      if (result && result.forcedSummaryNonCompliant) task.forcedSummaryNonCompliant = true;
      return { succeeded: true, blocked: false, needsClarification: true, ...meta, capturedDiff };
    }
    const budgetNote = retriedForTurnBudget
      ? ' -- ran out of turns twice in a row; a larger budget alone will not fix this'
      : '';
    return { succeeded: true, blocked: true, blockedReason: `Agentic implement pass did not end with a RESOLUTION: line -- cannot determine outcome${budgetNote}`, ...meta, capturedDiff: bestEffortDiff() };
  }

  if (resolution === 'decompose') {
    const afterResolution = summary.slice(resolutionMatch.index + resolutionMatch[0].length);
    const subTasks = parseSubTaskProposals(afterResolution);
    const n = subTasks ? subTasks.length : 0;

    if (n === 0) {
      // The model reached a conclusion ("this is too big, split it") but produced no
      // usable sub-task JSON at all.
      //
      // If it made REAL edits first, that is "I did part of it then ran low on turns/
      // confidence" -- redirect to a CONTINUATION (finish what you started) exactly like
      // the n >= 2 branch below, rather than blocking and throwing the partial work away.
      // Confirmed live 2026-09-02 (second-brain note-graph task): two passes each made
      // several successful edit_file calls, then answered RESOLUTION: decompose with
      // malformed JSON -- every retry restarted from origin/master.
      const partialDiff = bestEffortDiff();
      const priorContinuations = Number(task.agenticContinuationCount) || 0;
      if (partialDiff && priorContinuations < MAX_AGENTIC_CONTINUATIONS) {
        task.agenticContinuationCount = priorContinuations + 1;
        task.agenticContinuationNote = summary;
        task.priorPartialDiff = partialDiff;
        task.retryableDraftBlock = true;
        task.isAgenticContinuation = true;
        return {
          succeeded: true,
          blocked: true,
          blockedReason: `Agentic implement pass made partial edits then chose RESOLUTION: decompose with no usable pieces -- requeued as continuation ${task.agenticContinuationCount}/${MAX_AGENTIC_CONTINUATIONS} to finish`,
          ...meta,
          capturedDiff: partialDiff,
        };
      }
      // No partial work (or continuation budget spent): redraft-eligible with a format
      // reminder. Sticky count of "said decompose, gave nothing usable" passes: local-
      // agentic-write-draft.js's repeated-decompose backstop fires once this reaches 2 (do
      // the split in a single clean call rather than requeue toward escalation).
      // reject-retry-check.js does not reset it.
      task.decomposeBlockCount = (Number(task.decomposeBlockCount) || 0) + 1;
      task.retryableDraftBlock = true;
      return { succeeded: true, blocked: true, blockedReason: 'Agentic implement pass said RESOLUTION: decompose but no valid JSON array of {title, rawText} sub-tasks followed it', ...meta, capturedDiff: bestEffortDiff() };
    }

    if (n === 1) {
      // A "decompose" into exactly ONE sub-task is the model saying "this is atomic" --
      // usually it just could not commit to editing. Treat the single sub-task as a
      // sharper re-scope of THIS task and requeue once (reject-retry-check.js swaps in the
      // sharper rawText). If it decomposes-to-one AGAIN after being re-scoped, that is a
      // real signal it needs a human -- escalate instead of looping.
      if (task.rescopedFromDecompose === true) {
        task.adhocResolution = 'needs-human-decision';
        task.rawDiff = '';
        task.implementResponse = `${summary}\n\n(decomposed to a single atomic sub-task twice without implementing it -- needs a human)`;
        return { succeeded: true, blocked: false, needsClarification: true, ...meta };
      }
      task.rescopedFromDecompose = true;
      task.rescopedRawText = subTasks[0].rawText;
      // Also a "said decompose, not implementable as given" pass -- counts toward the
      // repeated-decompose backstop (see the n === 0 branch).
      task.decomposeBlockCount = (Number(task.decomposeBlockCount) || 0) + 1;
      task.retryableDraftBlock = true;
      return { succeeded: true, blocked: true, blockedReason: 'Agentic pass re-scoped this to a single sharper sub-task; requeued once for a focused implement pass', ...meta, capturedDiff: bestEffortDiff() };
    }

    // A pass that made REAL edits and then answered RESOLUTION: decompose is not "this
    // can't be one change" -- it is "I did part of it and ran low on turns/confidence."
    // Accepting the split here discards that partial work (rawDiff = '') AND routinely
    // drops whatever the model already finished from the sub-task list (root-caused live
    // 2026-09-02 via the plugins-marketplace endpoint task: tier 3 wrote the catalog
    // validators in app.py, then split into "seed file" + "test file" and the endpoint
    // itself -- the actual deliverable -- silently vanished). Redirect it to a CONTINUATION
    // (finish what you started), same mechanism the needs-human-decision branch uses,
    // bounded by MAX_AGENTIC_CONTINUATIONS. Only once that budget is spent and it STILL
    // wants to split do we accept the decompose.
    const decomposeDiff = bestEffortDiff();
    const continuations = Number(task.agenticContinuationCount) || 0;
    if (decomposeDiff && continuations < MAX_AGENTIC_CONTINUATIONS) {
      task.agenticContinuationCount = continuations + 1;
      task.agenticContinuationNote = summary;
      task.priorPartialDiff = decomposeDiff;
      task.retryableDraftBlock = true;
      task.isAgenticContinuation = true;
      return {
        succeeded: true,
        blocked: true,
        blockedReason: `Agentic implement pass made partial edits then chose RESOLUTION: decompose -- requeued as continuation ${task.agenticContinuationCount}/${MAX_AGENTIC_CONTINUATIONS} to finish before any split`,
        ...meta,
        capturedDiff: decomposeDiff,
      };
    }

    task.adhocResolution = resolution;
    task.subTaskProposals = subTasks;
// ... [truncated for review: this function continues for 222 more line(s) not shown]
```

Problem:
The 422-line `resolveAgenticDraft` function contains six or more distinct decision paths (degenerate, no-resolution-with-forced-summary, no-resolution-without-forced-summary, decompose-with-0/1/≥2 subtasks, and the remaining resolution classes), each with its own preconditions, a distinct subset of `task.*` state mutations (`turnBudgetExhausted`, `retryableDraftBlock`, `turnBudgetExhaustedBefore`, `agenticContinuationCount`, `decomposeBlockCount`, `rescopedFromDecompose`, `adhocResolution`, `subTaskProposals`, `forcedSummaryNonCompliant`), and a distinct return shape. The branches are nested rather than flat: the `!resolution` path splits on `forcedSummary` → `edits===0` vs. else, and the `decompose` path splits on `n===0` / `n===1` / `n≥2` and then on `partialDiff && continuations < MAX` within each. Verifying that the correct flags are set and stale ones cleared in every path requires holding the entire state machine in working memory, and every new failure class adds another nested branch mid-function.

Solution:
Extract each resolution-class branch into a small, clearly-named handler function (≤ ~60 lines each) that owns its own `task.*` mutations and returns the same shape. The dispatcher resets cross-cutting flags, computes `meta` and `bestEffortDiff` once, then delegates. The concrete change to the top of the function and the first two handlers:

```diff
--- a/src/agentic-draft-common.js
+++ b/src/agentic-draft-common.js
@@ -1,12 +1,14 @@
 function resolveAgenticDraft(task, { result, worktreeDir, modelLabel, retriedForTurnBudget = false }) {
   const summary = (result && result.response) || '';
   task.turnBudgetExhausted = false;
   task.retryableDraftBlock = false;
+  // (existing meta / bestEffortDiff setup unchanged)
+
+  if (result && result.degenerate) {
+    return handleDegenerate({ task, result, meta, bestEffortDiff, retriedForTurnBudget });
+  }
 
   const resolutionMatch = summary.match(RESOLUTION_RE);
   const resolution = resolutionMatch ? resolutionMatch[1].toLowerCase() : null;
   if (modelLabel) task.draftModel = modelLabel;
   meta.resolution = resolution || undefined;
 
-  // [~400 lines of nested if/else branches for degenerate, !resolution, decompose, implement, needs-human-decision]
+  if (!resolution) {
+    return handleNoResolution({ task, result, summary, meta, bestEffortDiff, retriedForTurnBudget });
+  }
+  if (resolution === 'decompose') {
+    return handleDecompose({ task, summary, resolutionMatch, subTasks: parseSubTaskProposals(
+      summary.slice(resolutionMatch.index + resolutionMatch[0].length)
+    ), meta, bestEffortDiff });
+  }
+  return handleOtherResolution({ task, resolution, summary, meta, bestEffortDiff, retriedForTurnBudget });
 }
+
+function handleDegenerate({ task, result, meta, bestEffortDiff, retriedForTurnBudget }) {
+  return {
+    succeeded: true, blocked: true,
+    blockedReason: `Agentic implement pass degenerate: ${result.degenerate}${retriedForTurnBudget ? ' (retried once at a larger turn budget)' : ''}`,
+    ...meta, capturedDiff: bestEffortDiff(),
+  };
+}
+
+function handleNoResolution({ task, result, summary, meta, bestEffortDiff, retriedForTurnBudget }) {
+  if (result && result.forcedSummary) {
+    const capturedDiff = bestEffortDiff();
+    const edits = ((result.toolCallLog) || []).filter((c) => c && /^(edit_file|write_file)$/.test(c.tool)).length;
+    if (edits === 0 && !capturedDiff) {
+      task.turnBudgetExhausted = true;
+      task.retryableDraftBlock = true;
+      task.turnBudgetExhaustedBefore = true;
+      return { succeeded: true, blocked: true, blockedReason: '…exhausted its turn budget without making any edits…', ...meta, capturedDiff: undefined };
+    }
+    task.adhocResolution = 'needs-human-decision';
+    task.rawDiff = '';
+    task.implementResponse = summary || '(…ran out of turns…)';
+    if (result.forcedSummaryNonCompliant) task.forcedSummaryNonCompliant = true;
+    return { succeeded: true, blocked: false, needsClarification: true, ...meta, capturedDiff };
+  }
+  return { succeeded: true, blocked: true, blockedReason: 'No resolution marker found', ...meta, capturedDiff: bestEffortDiff() };
+}
+
+function handleDecompose({ task, summary, resolutionMatch, subTasks, meta, bestEffortDiff }) {
+  const n = subTasks ? subTasks.length : 0;
+  if (n === 0) return handleDecomposeZeroSubTasks({ task, summary, meta, bestEffortDiff });
+  if (n === 1) return handleDecomposeOneSubTask({ task, subTasks, summary, meta, bestEffortDiff });
+  return handleDecomposeMultiple({ task, subTasks, meta, bestEffortDiff });
+}
+
+// handleDecomposeZeroSubTasks, handleDecomposeOneSubTask, handleDecomposeMultiple,
+// handleOtherResolution — each ≤ 60 lines, each owns its task.* mutations, each returns.
```

The existing inline incident comments (2026-08-31, 2026-09-02, 2026-09-16) move with their respective handlers. The `bestEffortDiff` closure and `meta` object stay in the dispatcher and are forwarded. Before cutting, confirm the truncated tail does not contain a branch that mutates state and then falls through to a later branch; if such fall-through exists, the seam is at the fall-through point rather than the resolution-class boundary.

Benefits:
Each handler is ≤ ~60 lines with its `task.*` mutations local and visible in one screen, so a reviewer verifying a single return path no longer needs to track 10+ flags across 6+ nested branches. Adding a new failure class becomes a new handler function; existing handlers are untouched and cannot be clobbered. Unit-testing a specific path (e.g. "decompose with 0 subtasks + partial diff → continuation") calls `handleDecomposeZeroSubTasks` directly with a fixture rather than mocking the entire 422-line entry point, and no other branch can interfere.

### AC-56 · Extract restoreFilesAfterFailedApply from applyAdhocDiff
Strength: Strong
Files: src/apply-adhoc-diff.js
Snippet:
```
}

function applyAdhocDiff({ task, repoRoot, pipelineDir, exec }) {
  if (task && task.adhocResolution === 'decompose') {
    return buildDecomposedPlan(task, pipelineDir);
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
```

Problem:
`applyAdhocDiff` runs 124 lines and nests three `try/catch` levels in its failure path. The innermost block — a per-file loop that attempts `git checkout HEAD -- <file>` and falls back to `fs.unlinkSync` when the file has no HEAD entry — is a self-contained cleanup routine with no dependency on the surrounding error-propagation chain. Its presence inside the `threeWayErr` catch is what pushes the main apply path to depth 3, and it is the only part of the function that cannot be unit-tested in isolation without standing up the full `git apply` → `--3way` → conflict-marker scenario. The remaining length (validation, patch write, plain-apply, 3way-fallback, acceptance gate, `finally` cleanup) is an irreducible linear pipeline whose comments encode live debugging history (2026-08-18, 2026-08-24) and must stay in place.

Solution:
Extract the per-file restore loop into a top-level helper `restoreFilesAfterFailedApply(files, repoRoot)` placed immediately above `applyAdhocDiff`, then replace the inline loop in the `threeWayErr` catch with a single call. The helper is a pure function of its two arguments; it needs no closure over `patchPath`, `plainApplyErr`, or the `finally` block. The concrete change is:

```diff
+ function restoreFilesAfterFailedApply(files, repoRoot) {
+   for (const file of files) {
+     try {
+       execFileSync('git', ['checkout', 'HEAD', '--', file], {
+         cwd: repoRoot, encoding: 'utf8', env: GIT_ENV, timeout: GIT_TIMEOUT_MS,
+       });
+     } catch (restoreErr) {
+       try {
+         fs.unlinkSync(path.join(repoRoot, file));
+       } catch (unlinkErr) {
+         if (unlinkErr.code !== 'ENOENT') {
+           console.warn(
+             `[apply-adhoc-diff] failed to remove stray file after failed apply: ${file} -- ${unlinkErr.message || String(unlinkErr)}`,
+           );
+         }
+       }
+     }
+   }
+ }
+
  function applyAdhocDiff(/* …unchanged signature… */) {
    /* …unchanged guard, patch-write, validate, plain-apply… */
      try {
        execFileSync('git', ['apply', '--3way', '--recount', patchPath], {
          cwd: repoRoot, encoding: 'utf8', env: GIT_ENV, timeout: GIT_TIMEOUT_MS,
        });
      } catch (threeWayErr) {
-       for (const file of files) {
-         try {
-           execFileSync('git', ['checkout', 'HEAD', '--', file'], {
-             cwd: repoRoot, encoding: 'utf8', env: GIT_ENV, timeout: GIT_TIMEOUT_MS,
-           });
-         } catch (restoreErr) {
-           try { fs.unlinkSync(path.join(repoRoot, file)); } catch (unlinkErr) {
-             if (unlinkErr.code !== 'ENOENT') {
-               console.warn(`[apply-adhoc-diff] failed to remove stray file after failed apply: ${file} -- ${unlinkErr.message || String(unlinkErr)}`);
-             }
-           }
-         }
-       }
+       restoreFilesAfterFailedApply(files, repoRoot);
        throw plainApplyErr;
      }
    /* …unchanged acceptance-gate, return, finally… */
  }
```

No other lines in the function are touched. The `--recount` / `--3way` / `HEAD --` comments, the acceptance-command gate, and the `finally` block that unlinks `patchPath` all remain exactly where they are.

Benefits:
Nesting depth in the failure path drops from 3 to 2, so a reader tracing a `--3way` conflict sees `restoreFilesAfterFailedApply(files, repoRoot); throw plainApplyErr;` instead of a 15-line inline loop. The helper gains an independent unit-test surface: feed it `['new-file.js']` with `execFileSync` mocked to throw, and assert `fs.unlinkSync` fires without standing up the full git-apply scenario. A third test case (`unlinkSync` throwing with a non-`ENOENT` code) can assert the `console.warn` path. The main function lands at roughly 105 lines — just under the 100-line heuristic threshold — and reads as a single linear pipeline: guard → write patch → validate → apply-with-fallback → gate → return.

### AC-57 · Decompose applyBrainDumpSort into five focused helpers
Strength: Strong
Files: src/apply-group-a-brain-dump.js
Snippet:
```
}

function applyBrainDumpSort({ implementResponse, task, brainDumpPath, secondBrainDir, pipelineDir }) {
  const { brainDumpEntryId, rawText, existingQueuedTitles } = task.promptContext;

  const data = loadBrainDump(brainDumpPath);

  const entry = findEntry(data, brainDumpEntryId);
  if (!entry) {
    // Terminal: the entry is gone, there is nothing to regenerate.
    return { skipped: true, reason: `brain-dump entry "${brainDumpEntryId}" no longer exists (deleted since this task was drafted)` };
  }
  // The entry may have been edited (the dashboard's PUT resets status back to 'captured' on
  // a text change) or otherwise changed since this task was drafted -- classifying stale
  // text into the entry's CURRENT record would silently mislabel it under a rawText it no
  // longer has. Only apply if the entry is still exactly what this task was drafted against.
  if (entry.suppressed) {
    // A human retired this finding after its sort task was queued -- sorting it now would
    // still file a note or queue a task for something they already dismissed.
    return { skipped: true, reason: 'brain-dump entry was suppressed since this task was queued -- not sorting it' };
  }
  if (entry.status !== 'captured' || entry.rawText !== rawText) {
    return recoverableSortSkip(data, entry, brainDumpPath,
      'brain-dump entry changed since this task was drafted -- a fresh sort will classify the current text');
  }

  if (!secondBrainDir) {
    // Terminal: no vault configured, no retry will help.
    return { skipped: true, reason: 'SECOND_BRAIN_DIR is not configured -- cannot file this entry anywhere' };
  }

  const result = parseBrainDumpSortResult(implementResponse);
  if (!result) {
    return recoverableSortSkip(data, entry, brainDumpPath,
      'implement pass did not return a valid classification JSON');
  }

  const trackedLabels = readProjectRegistry().map((p) => p.label).filter(Boolean);
  result.secondBrainPath = normalizeSecondBrainPathCase(result.secondBrainPath, trackedLabels);
  result.secondBrainPath = path.normalize(result.secondBrainPath);
  // normalizeSecondBrainPathCase above only corrects against the CANONICAL_TOP_LEVEL
  // constant + the project registry's own label spelling -- it trusts the registry, not
  // the disk. If a tracked project's real on-disk folder casing has ever drifted from
  // its registry label (a manual rename, or the label recorded before the folder existed),
  // that correction can hand validateSecondBrainPath's OWN on-disk conflict check a
  // spelling that doesn't match what's actually there, tripping its "different-case
  // duplicate" rejection for a folder that in fact already exists -- the silent no-op
  // this whole task is about. Resolve the first segment against disk directly, but only
  // when exactly one entry matches case-insensitively (0 or 2+ matches is ambiguous or
  // missing -- leave the path as-is and let validateSecondBrainPath's own rejection,
  // "different-case duplicate" included, be the fallback).
  if (secondBrainDir) {
    const segments = result.secondBrainPath.split(/[\\/]/).filter(Boolean);
    if (segments.length > 0) {
      let entries;
      try {
        entries = fs.readdirSync(secondBrainDir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith('.'));
      } catch {
        entries = [];
      }
      const matches = entries.filter((e) => e.name.toLowerCase() === segments[0].toLowerCase());
      if (matches.length === 1 && matches[0].name !== segments[0]) {
        segments[0] = matches[0].name;
        result.secondBrainPath = segments.join('/');
      }
    }
  }
  const namingError = validateSecondBrainPath(result.secondBrainPath, secondBrainDir, trackedLabels);
  if (namingError) {
    return recoverableSortSkip(data, entry, brainDumpPath,
      `rejected secondBrainPath "${result.secondBrainPath}": ${namingError}`);
  }

  // Deterministic belongsToProject recovery -- the classifier routinely leaves this null
  // for a note that is plainly a concrete change to this pipeline's own code (the dominant
  // failure of the blocked backlog). May also flip actionable true.
  {
    const derived = deriveBelongsToProject(result, task.promptContext);
    result.belongsToProject = derived.belongsToProject;
    result.actionable = derived.actionable;
  }

  // Origin routing: a finding raised by project X's pipeline is about project X, whatever
  // the classifier guessed. Overrides the label; and a note filed under a DIFFERENT tracked
  // project's vault folder moves to X's folder when that folder exists.
  {
    const origin = originProjectFor(entry, readProjectRegistry());
    if (origin && origin.label) {
      result.belongsToProject = origin.label;
      const segments = result.secondBrainPath.split(/[\\/]/).filter(Boolean);
      if (segments.length > 1 && segments[0] !== origin.label
          && trackedLabels.includes(segments[0])
          && fs.existsSync(path.join(secondBrainDir, origin.label))) {
        segments[0] = origin.label;
        result.secondBrainPath = segments.join('/');
      }
    }
  }

  // Investigation-shaped machine findings become notes, never code tasks (see
  // isInvestigationFinding's header). Applied AFTER origin routing so the note still files
  // under the raising project's vault folder.
  if (entry.raisedBy && isInvestigationFinding(rawText)) {
    result.belongsToProject = null;
    result.actionable = false;
  }

  // Brain Dump #1 follow-up (2026-08-17): a note can be actionable WITHOUT being a code
  // change -- "investigate X, document findings" needs real web research, not a diff
  // against any tracked project. Only when NO tracked project was named/recovered -- a
  // note tied to a project routes to that project's queue below, never to research.
  if (result.requiresResearch && !result.belongsToProject) {
    if (!pipelineDir) {
      return { skipped: true, reason: 'no pipelineDir available -- cannot queue a research task' };
    }
    const queuedId = `research-brain-dump-${brainDumpEntryId}-${Date.now()}`;
    const researchTask = {
      id: queuedId,
      domain: 'research',
      source: 'research_task',
      title: rawText.slice(0, 120),
      promptContext: { rawText, brainDumpEntryId, secondBrainPath: result.secondBrainPath, tags: result.tags },
    };
    const researchDir = path.join(pipelineDir, 'queue', 'research');
    fs.mkdirSync(researchDir, { recursive: true });
    writeJsonAtomicSync(path.join(researchDir, `${queuedId}.json`), researchTask);

    // Same audit-trail cross-reference convention the adhoc branch below already uses --
    // an entry findable in the note it will eventually gain real content in, not the
    // record of truth (brain-dump.json's queuedTaskId/queuedAt is that).
    const fullPath = path.join(secondBrainDir, result.secondBrainPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    appendMarkdownLineAtomic(fullPath, `\n- **${stamp}** Queued as research task \`${queuedId}\` -- ${rawText}\n`);

    entry.status = 'actioned';
    entry.queuedTaskId = queuedId;
    entry.queuedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(brainDumpPath), { recursive: true });
    writeJsonAtomicSync(brainDumpPath, data);

    return { file: fullPath, queuedTaskId: queuedId, researchQueued: true };
  }

  // A note naming a tracked project IS work -- queue a real adhoc task in that project's
  // own queue. The old `result.actionable &&` precondition is dropped (2026-09-03, user:
  // "a note describing a concrete change to a tracked project always becomes a work task"):
  // a project-labelled note the classifier forgot to mark actionable is still a task, and
  // deriveBelongsToProject already forces actionable when it recovers a self-project label.
  const matchedProject = result.belongsToProject
    ? readProjectRegistry().find((p) => p.label === result.belongsToProject)
    : null;

  if (result.belongsToProject && !matchedProject) {
    // reviewBrainDumpSort should have blocked a non-tracked label; if one slipped through,
    // don't silently downgrade it to a passive note -- that masks the misclassification.
    return recoverableSortSkip(data, entry, brainDumpPath,
      `belongsToProject "${result.belongsToProject}" does not match any registered project -- a corrected pass should name a tracked label or null`);
  }

  if (matchedProject) {
    const validDomains = (() => {
      try {
        return Object.keys(JSON.parse(fs.readFileSync(matchedProject.domainsPath, 'utf8')));
      } catch (err) {
        const reason = err && err.message ? err.message : String(err);
        process.stderr.write(`[apply-group-a] failed to read domains from ${matchedProject.domainsPath}: ${reason}\n`);
        return [];
      }
    })();

    if (validDomains.includes('adhoc')) {
      const queuedId = `adhoc-brain-dump-${brainDumpEntryId}-${Date.now()}`;
      // A brain-dump entry with a `raisedBy` was machine-filed (side-finding-sweep.js:
      // a pipeline_debrief Now-What item, or any pass's writeSideFindingInbox side
      // finding) -- NOT a human handing the pipeline a task. Route it to queue/derived/
      // (source: derived_task, priority 48) instead of queue/adhoc/ (priority 10, preempts
      // every deterministic source), so this whole class is its own throttleable Job List
      // lane. A human-typed entry has no raisedBy and stays genuine adhoc. If it still
      // needs clarification (below), it goes to needs-clarification either way -- a human
      // resolving it there re-files it as real adhoc, which is correct (they vouched for it).
      const isDerived = !!(entry && entry.raisedBy);
      const adhocTask = {
        id: queuedId,
        domain: 'adhoc',
        source: isDerived ? 'derived_task' : 'brain_dump',
        title: rawText.slice(0, 120),
        promptContext: isDerived
          ? { rawText, brainDumpEntryId, derivedFrom: entry.raisedBy }
          : { rawText, brainDumpEntryId },
      };

      // Path-prefetch (context-aware-file-path-prefetch-job.md, 2026-08-16): resolve
      // anchor keywords from this task's title/rawText against the target project's own
      // dependency graph BEFORE it's ever claimed for drafting, so the plan/implement
      // passes already have real, validated file paths in promptContext instead of the
      // model searching for them (or worse, inventing them) from scratch on every call.
      // 'greenfield' (no graph built yet for this project) is explicitly NOT an error --
      // per the Discuss session's own note, that's just "nothing to prefetch," and the
      // task queues normally. 'no-match'/'ambiguous' are the two cases the Grill Me/
      // Discuss sessions asked to be held for a human rather than silently guessed at:
// ... [truncated for review: this function continues for 135 more line(s) not shown]
```

Problem:
The 335-line body of `applyBrainDumpSort` interleaves at least five distinct responsibilities—precondition guards, path normalisation and on-disk resolution, an ownership-correction pipeline, a research-task queuing branch, and a project-task (adhoc/derived) queuing branch—each with its own branching, side-effects, and failure mode. Because they share a single scope, a reader must hold the entire correction pipeline in working memory to know which later branch a given mutation feeds into, and a unit test for any one concern (e.g. "does origin routing reassign the first path segment?") must stub `loadBrainDump`, `parseBrainDumpSortResult`, `validateSecondBrainPath`, `fs.readdirSync`, `writeJsonAtomicSync`, and `appendMarkdownLineAtomic` just to reach the line under test. The ~40 % comment density is a symptom of this conflation, not a cause: the comments exist because the reader cannot infer branch boundaries from the code structure alone.

Solution:
Extract the five responsibilities into top-level helper functions and reduce `applyBrainDumpSort` to a thin coordinator that sequences them. The concrete shape of the change is:

```javascript
// ── 1. Guards (pure, no I/O beyond loadBrainDump) ──────────────────
function checkSortPreconditions({ entry, rawText, secondBrainDir, implementResponse, brainDumpPath, data }) {
  if (!entry)
    return { skipped: true, reason: `brain-dump entry … no longer exists` };
  if (entry.suppressed)
    return { skipped: true, reason: '…suppressed…' };
  if (entry.status !== 'captured' || entry.rawText !== rawText)
    return recoverableSortSkip(data, entry, brainDumpPath, '…changed…');
  if (!secondBrainDir)
    return { skipped: true, reason: 'SECOND_BRAIN_DIR is not configured…' };
  const result = parseBrainDumpSortResult(implementResponse);
  if (!result)
    return recoverableSortSkip(data, entry, brainDumpPath, '…invalid JSON…');
  return { ok: true, result };
}

// ── 2. Path normalise → disk-resolve → validate ────────────────────
function resolveAndValidateSecondBrainPath(result, secondBrainDir, trackedLabels) {
  result.secondBrainPath = normalizeSecondBrainPathCase(result.secondBrainPath, trackedLabels);
  result.secondBrainPath = path.normalize(result.secondBrainPath);
  if (secondBrainDir) { /* …existing readdir logic… */ }
  const namingError = validateSecondBrainPath(result.secondBrainPath, secondBrainDir, trackedLabels);
  if (namingError) return { ok: false, error: namingError };
  return { ok: true };
}

// ── 3. Ownership-correction pipeline (mutates result in place) ─────
function applyOwnershipCorrections(result, entry, rawText) {
  const derived = deriveBelongsToProject(result, /* promptContext */);
  result.belongsToProject = derived.belongsToProject;
  result.actionable = derived.actionable;
  const origin = originProjectFor(entry, readProjectRegistry());
  if (origin?.label) { /* …existing reassign logic… */ }
  if (entry.raisedBy && isInvestigationFinding(rawText)) {
    result.belongsToProject = null;
    result.actionable = false;
  }
}

// ── 4. Research-task branch (self-contained I/O) ───────────────────
function queueResearchTask({ result, entry, rawText, brainDumpEntryId, brainDumpPath, secondBrainDir, pipelineDir, data }) {
  const queuedId = `research-brain-dump-${brainDumpEntryId}-${Date.now()}`;
  /* …existing mkdir / writeJson / appendMarkdown / entry mutation… */
  return { file: fullPath, queuedTaskId: queuedId, researchQueued: true };
}

// ── 5. Project-task branch (adhoc / derived / needs-clarification) ─
function queueProjectTask({ result, entry, rawText, brainDumpEntryId, matchedProject, secondBrainDir, data, brainDumpPath }) {
  /* …domain read, adhoc/derived selection, path-prefetch,
     needs-clarification routing, file writes… */
}

// ── Thin coordinator (≈ 40 lines) ──────────────────────────────────
function applyBrainDumpSort({ implementResponse, task, brainDumpPath, secondBrainDir, pipelineDir }) {
  const { brainDumpEntryId, rawText } = task.promptContext;
  const data  = loadBrainDump(brainDumpPath);
  const entry = findEntry(data, brainDumpEntryId);

  const guard = checkSortPreconditions({ entry, rawText, secondBrainDir, implementResponse, brainDumpPath, data });
  if (!guard.ok) return guard;

  const { result } = guard;
  const trackedLabels = readProjectRegistry().map(p => p.label).filter(Boolean);

  const pathOk = resolveAndValidateSecondBrainPath(result, secondBrainDir, trackedLabels);
  if (!pathOk.ok)
    return recoverableSortSkip(data, entry, brainDumpPath, `rejected secondBrainPath …: ${pathOk.error}`);

  applyOwnershipCorrections(result, entry, rawText);

  if (result.requiresResearch && !result.belongsToProject)
    return queueResearchTask({ result, entry, rawText, brainDumpEntryId, brainDumpPath, secondBrainDir, pipelineDir, data });

  const matchedProject = result.belongsToProject
    ? readProjectRegistry().find(p => p.label === result.belongsToProject)
    : null;
  if (result.belongsToProject && !matchedProject)
    return recoverableSortSkip(data, entry, brainDumpPath, `belongsToProject … does not match…`);
  if (matchedProject)
    return queueProjectTask({ result, entry, rawText, brainDumpEntryId, matchedProject, secondBrainDir, data, brainDumpPath });

  /* …fallback: file as passive note… */
}
```

Each helper is scoped to exactly one concern, takes only the state it needs, and returns a well-defined shape. The coordinator is a linear sequence of guard → resolve → correct → route, with no branching hidden inside a 335-line body.

Benefits:
Once decomposed, each helper is independently unit-testable with plain-object fixtures (no need to stub the full I/O stack), a PR that touches only path validation shows a ~30-line diff instead of 335 lines of context, adding a new correction pass is a one-line append to `applyOwnershipCorrections` rather than an insertion into the middle of a monolithic body, and the coordinator's control flow is readable in a single screen—making it straightforward to verify that every early-return path is reachable and that no branch silently falls through to an unintended default.

### AC-58 · Decompose applyRetryCheck four-branch loop into named decision helpers
Strength: Strong
Files: src/apply-retry-check.js
Snippet:
```
}

function applyRetryCheck({ blockedDir, pendingDir, needsClarificationDir, approvedDir, pipelineDir, repoRoot, extraRoots, decideResolved = decideFindingResolved, recordModelOutcome = defaultRecordModelOutcome }) {
  const summary = { checked: 0, requeued: 0, exhausted: 0, resolved: 0, errors: 0, errorDetails: [] };
  const approvedDirResolved = approvedDir || (pipelineDir ? path.join(pipelineDir, 'queue', 'approved') : null);
  let names = [];
  try {
    names = fs.readdirSync(blockedDir).filter((f) => f.endsWith('.json'));
  } catch (e) {
    return summary; // blocked/ doesn't exist yet -- nothing to check.
  }

  for (const name of names) {
    const filePath = path.join(blockedDir, name);
    // Tracks the operation actually in flight when the catch below fires, so
    // errorDetails' step reflects reality instead of always reading "write" for a
    // failure that happened during read/parse/record -- see this variable's own
    // reassignments just ahead of each real operation it names.
    let step = 'read';
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      if (!raw) continue;
      step = 'parse';
      const task = JSON.parse(raw);
      summary.checked++;

      // Only a genuine apply-stage failure is eligible -- never a review rejection that
      // happens to still carry stale fields, same "only act on the specific stage this
      // check owns" reasoning reject-retry-check.js's own isReviewRejection() guard uses.
      if (!isApplyFailure(task)) continue;

      // Diverged-history short-circuit -- see isDivergedHistoryFailure's own header.
      // Regardless of retryCount: retrying reproduces the identical git-state failure,
      // structurally, not stochastically, so there is no reason to wait for the cap.
      if (isDivergedHistoryFailure(task) && needsClarificationDir) {
        const alreadyEscalated = Array.isArray(task.history) && task.history.some((h) => h.stage === 'needs-clarification');
        if (!alreadyEscalated) {
          task.needsClarification = {
            reason: 'git-state-diverged',
            openQuestions: [
              `Apply failed because the pipeline's own working checkout and origin/<main> have diverged (each has commits the other lacks) -- a git-state problem, not a content/draft-quality one: ${String(task.blockedReason || '')}`,
              'A fresh redraft cannot fix this -- the SAME diverged branch will reject any diff. Reconcile the branch by hand (confirm which side'
                + ' has the real intended history, then either fast-forward, rebase, or reset the working checkout to match), then requeue this task.',
            ],
          };
          step = 'record';
          appendHistoryEvent(task, 'needs-clarification', 'escalated immediately -- diverged git history, a blind retry cannot differ');
          if (pipelineDir) fileGhostDebt({ task, reasonText: task.blockedReason, site: 'apply-retry-check:diverged-history', pipelineDir });
          step = 'write';
          fs.mkdirSync(needsClarificationDir, { recursive: true });
          fs.writeFileSync(path.join(needsClarificationDir, name), JSON.stringify(task, null, 2));
          step = 'unlink';
          fs.unlinkSync(filePath);
          summary.exhausted++;
          continue;
        }
      }

      // Checked before the retry-count logic, regardless of retryCount: a resolved finding
      // needs no further redraft, and a task ALREADY at the cap (the AC-169 state) is
      // exactly the one that would otherwise never be looked at again.
      if (isFindStringMiss(task) && approvedDirResolved) {
        step = 'resolve';
        const resolved = decideResolved(task, { repoRoot, extraRoots });
        if (resolved) {
          landAsResolvedFalsePositive(task, name, filePath, approvedDirResolved);
          summary.resolved++;
          continue;
        }
      }

      const retryCount = Number(task.applyRetryCount) || 0;
      if (retryCount >= MAX_APPLY_RETRIES) {
        const alreadyStamped = Array.isArray(task.history) && task.history.some((h) => h.stage === 'exhausted');
        // Exhaustion used to be a permanent dead end -- stamp 'exhausted' and stay in
        // blocked/ forever, nothing ever reading it back out (reject-retry-check.js closed
        // the same gap for review rejections 2026-09-17/18). Escalate to a human instead.
        // Deliberately NOT gated on alreadyStamped: tasks stamped on an earlier tick (before
        // this existed) are exactly the ones stuck right now.
        if (needsClarificationDir && !alreadyEscalatedSinceLastReadmission(task)) {
          step = 'record';
          task.needsClarification = { reason: 'design-decision', openQuestions: buildExhaustedApplyQuestion(task) };
          if (!alreadyStamped) appendHistoryEvent(task, 'exhausted', `${retryCount}/${MAX_APPLY_RETRIES} apply retries used`);
          appendHistoryEvent(task, 'needs-clarification', 'escalated to a human after exhausting apply retries');
          if (pipelineDir) fileGhostDebt({ task, reasonText: task.blockedReason, site: 'apply-retry-check:retry-cap-exhausted', pipelineDir });
          step = 'write';
          fs.mkdirSync(needsClarificationDir, { recursive: true });
          fs.writeFileSync(path.join(needsClarificationDir, name), JSON.stringify(task, null, 2));
          step = 'unlink';
          fs.unlinkSync(filePath);
          summary.exhausted++;
          continue;
        }
        // Same "stamp once, never re-fire" guard reject-retry-check.js uses -- without
        // it this branch would re-append an 'exhausted' history event on every single
        // watchdog tick for as long as the task sits here, unbounded.
        if (alreadyStamped) { summary.exhausted++; continue; }
        step = 'record';
        appendHistoryEvent(task, 'exhausted', `${retryCount}/${MAX_APPLY_RETRIES} apply retries used`);
        step = 'write';
        fs.writeFileSync(filePath, JSON.stringify(task, null, 2));
        summary.exhausted++;
        continue;
      }

      task.applyRetryCount = retryCount + 1;

      step = 'record';
      recordModelOutcome({ callId: task.abCallId, outcome: 'requeued', outcomeStage: 'apply-watchdog', outcomeReason: task.blockedReason || null });
      appendHistoryEvent(task, 'requeued', task.blockedReason || undefined);

      step = 'write';
      const newPath = path.join(pendingDir, name);
      fs.mkdirSync(pendingDir, { recursive: true });
      fs.writeFileSync(newPath, JSON.stringify(task, null, 2));
      step = 'unlink';
      fs.unlinkSync(filePath);
      summary.requeued++;
    } catch (e) {
      summary.errors++;
      const detail = { task: name, step, message: e.message, code: e.code ?? null };
      summary.errorDetails.push(detail);
      console.error(JSON.stringify(detail));
    }
  }

  return summary;
}
```

Problem:
The 126-line `applyRetryCheck` inlines four distinct business rules—diverged-history escalation, false-positive resolution, retry-cap exhaustion, and normal requeue—each with its own preconditions, side-effect sequence, and summary counter. Two of those rules (diverged-history and retry-exhaustion) share a near-identical escalate-to-needsClarificationDir mechanic (mkdir → write → unlink → increment) that is copy-pasted verbatim, and the `step` bookkeeping variable exists only because all four paths are inlined in a single try/catch. A future change to the escalation write format, the addition of a file lock, or a change to the JSON shape must be made in two places, and no single rule can be unit-tested in isolation without mocking the entire 126-line function.

Solution:
Extract the duplicated escalation block into a single `escalateToNeedsClarification` helper, then lift each of the four decision branches into its own named function that returns a small action string. The main loop body shrinks to scaffolding (readdir guard, read/parse, summary bookkeeping) plus a short sequential dispatch. Concretely:

```js
// Shared escalation mechanic (was duplicated in diverged-history and retry-exhausted branches)
function escalateToNeedsClarification({ task, name, blockedPath, needsClarificationDir, summary }) {
  fs.mkdirSync(needsClarificationDir, { recursive: true });
  fs.writeFileSync(path.join(needsClarificationDir, name), JSON.stringify(task, null, 2));
  fs.unlinkSync(blockedPath);
  summary.exhausted++;
}

// One decision branch each; each returns an action string or 'skip'
function handleDivergedHistory(task, ctx) { /* … */ return 'escalated'; }
function handleResolvedFinding(task, ctx)  { /* … */ return 'resolved'; }
function handleRetryExhaustion(task, ctx)  { /* … */ return 'exhausted'; }
function handleNormalRequeue(task, ctx)    { /* … */ return 'requeued'; }

// Main function shrinks to ~40 lines of scaffolding + dispatch
function applyRetryCheck({ blockedDir, pendingDir, needsClarificationDir, approvedDir,
                           pipelineDir, repoRoot, extraRoots,
                           decideResolved = decideFindingResolved,
                           recordModelOutcome = defaultRecordModelOutcome }) {
  const summary = { checked: 0, requeued: 0, exhausted: 0, resolved: 0, errors: 0, errorDetails: [] };
  const approvedDirResolved = approvedDir || (pipelineDir ? path.join(pipelineDir, 'queue', 'approved') : null);

  let names;
  try {
    names = fs.readdirSync(blockedDir).filter((f) => f.endsWith('.json'));
  } catch { return summary; }

  const ctx = { pendingDir, needsClarificationDir, approvedDirResolved, pipelineDir,
                repoRoot, extraRoots, decideResolved, recordModelOutcome, summary };

  for (const name of names) {
    const filePath = path.join(blockedDir, name);
    let step = 'read';
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      if (!raw) continue;
      step = 'parse';
      const task = JSON.parse(raw);
      summary.checked++;
      if (!isApplyFailure(task)) continue;

      if (handleDivergedHistory(task, ctx) === 'escalated') continue;
      if (handleResolvedFinding(task, ctx) === 'resolved')  continue;
      if (handleRetryExhaustion(task, ctx) === 'exhausted') continue;
      handleNormalRequeue(task, ctx);
    } catch (e) {
      summary.errors++;
      const detail = { task: name, step, message: e.message, code: e.code ?? null };
      summary.errorDetails.push(detail);
      console.error(JSON.stringify(detail));
    }
  }
  return summary;
}
```

The `step` variable and the outer try/catch stay in the caller so error-detail reporting is unchanged; each helper receives a `ctx` object carrying the directories, callbacks, and summary it needs.

Benefits:
The main function drops from 126 to roughly 40 lines of loop scaffolding and a four-line dispatch, making the control flow scannable at a glance. Each decision helper is 15–30 lines, single-purpose, and independently unit-testable with a stub `task` object and a mock `ctx`—no need to exercise the full readdir/read/parse pipeline. The duplicated escalation write now lives in exactly one function, so adding a lock, changing the JSON shape, or altering the unlink order is a one-place edit. Reviewers can evaluate each business rule in isolation during code review rather than tracking four interleaved side-effect sequences through a single 126-line body.

### AC-170 · Extract doResetToMain and prepareStackedBranch from createRealGitRunner factory body
Strength: Strong
Files: src/git-runner.js
Snippet:
```
 * @param {string} repoRoot - Absolute path to the git repo to operate on.
 */
function createRealGitRunner(repoRoot) {
  const mainBranch = detectDefaultBranch(repoRoot);
  function run(args) {
    return execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe', encoding: 'utf8', env: GIT_ENV, timeout: GIT_TIMEOUT_MS });
  }
  function isAncestor(a, b) {
    try { run(['merge-base', '--is-ancestor', a, b]); return true; } catch { return false; }
  }
  function doResetToMain() {
    try {
      run(['stash', 'push', '-u', '-m', `agent-manager auto-stash before reset ${new Date().toISOString()}`]);
    } catch (e) {
      throw new Error(`auto-stash before resetToMain failed, reset aborted to avoid destroying work: ${e.message}`);
    }
    run(['checkout', mainBranch]);
    run(['fetch', 'origin', mainBranch]);
    const remote = `origin/${mainBranch}`;
    const originInLocal = isAncestor(remote, mainBranch);
    const localInOrigin = isAncestor(mainBranch, remote);
    if (originInLocal && !localInOrigin) {
      if (ungatedMainPushAllowed()) {
        try {
          run(['push', 'origin', `${mainBranch}:${mainBranch}`]);
        } catch (e) {
          throw new Error(`resetToMain: local ${mainBranch} is ahead of origin but fast-forwarding it to origin failed (push rejected -- e.g. a protected branch or a race): ${e.message}`);
        }
      } else {
        // Local main holds commits origin lacks. The old behavior pushed them to origin/main
        // unattended -- exactly what must never happen without a human gate (see
        // lib/main-push-policy.js). Preserve them on a rescue BRANCH (pushed best-effort, so a
        // reset never destroys work) and fall through to the reset. A human decides about them.
        const rescue = `agent/rescued-${mainBranch}-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
        try {
          run(['branch', rescue, mainBranch]);
        } catch (e) {
          throw new Error(`resetToMain: local ${mainBranch} is ahead of origin and could not be rescued to ${rescue} before the reset: ${e.message}`);
        }
        try { run(['push', '-u', 'origin', rescue]); } catch { /* best-effort: the local rescue branch still exists */ }
        console.error(`[git-runner] local ${mainBranch} had commit(s) origin lacks; NOT pushed to ${mainBranch} (no ungated main pushes) -- kept on ${rescue} for a human to review/merge`);
      }
    } else if (!originInLocal && !localInOrigin) {
      throw new Error(`resetToMain: local ${mainBranch} and ${remote} have diverged (each has commit(s) the other lacks) -- needs a human to reconcile, not an automatic reset`);
    }
    run(['reset', '--hard', remote]);
    // Pop the stash created above right back onto the now-reset tree (2026-09-14, fixing
    // the "never popped" hazard this function used to carry -- see the header comment on
    // the returned object below for the full incident history). Confirmed live: the
    // dedicated AGENT_MANAGER_APPLY_REPO_ROOT worktree this runs against is never
    // interactively edited, so there is no live human WIP this could clobber -- unlike
    // the pre-2026-09-07 shape where resetToMain() ran directly against the same checkout
    // a human sometimes edits live, popping immediately was NOT safe (a stray edit could
    // ride back onto the tree right before an automated commit). "No stash entries found"
    // (the overwhelmingly common case -- nothing was stashed) is swallowed as a no-op;
    // any other pop failure (e.g. a real conflict) is logged and swallowed rather than
    // thrown -- the reset itself already succeeded, and git leaves the stash entry intact
    // on a failed pop for manual recovery, so this can never make things worse than the
    // old never-popped behavior, only better.
    try {
      run(['stash', 'pop']);
    } catch (e) {
      const msg = e.stderr ? e.stderr.toString() : e.message;
      if (!/no stash entries found/i.test(msg)) {
        console.error(`[git-runner] stash pop after resetToMain failed (stash entry left in place for manual recovery): ${msg}`);
      }
    }
  }
  return {
    mainBranch,
    fetchMain: () => run(['fetch', 'origin', mainBranch]),
    // Auto-stash before the hard reset instead of silently destroying uncommitted work --
    // this exact `git reset --hard` wiped real, unrecoverable work TWICE in one session
    // (see docs/pipeline-incident-2026-07-19.md and its 2026-07-21 repeat) because this
    // repo is sometimes edited live in the same working tree the pipeline operates on.
    // `-u` includes untracked files. Stashing when there's nothing to stash is a harmless
    // no-op (git prints "No local changes to save", exits 0) -- no separate status check
    // needed. A stash failure (e.g. an in-progress merge/rebase) must not silently fall
    // through to the destructive reset below, so it's re-thrown with context rather than
    // swallowed.
    //
    // FIXED (2026-09-14, was a HAZARD since 2026-09-03): the stash created above is now
    // popped right after the hard reset (see doResetToMain()) instead of being left as a
    // graveyard -- so any untracked/tracked content swept up here round-trips back onto
    // the tree instead of silently vanishing. This used to matter enormously: when
    // pipelineDir === repoRoot, every pipeline runtime-state file lands inside repoRoot,
    // and 90 scanner false-positive suppressions were lost this way over 3 days before
    // the ledgers were ignored. src/pipeline-state-gitignored.test.js still enforces the
    // getConfig()-path .gitignore invariant as defense-in-depth (a state file that's
    // git-ignored is never even stashed in the first place, `git stash -u` skips it
    // outright), independent of this pop fix.
    resetToMain: doResetToMain,
    createBranch: (name) => run(['checkout', '-b', name]),
    checkoutMain: () => run(['checkout', mainBranch]),
    // Checkout an EXISTING branch (stacked file-decompose: move N+1 rides on top of the
    // branch move N already committed to, so it must not reset it away).
    checkoutBranch: (name) => run(['checkout', name]),
    branchExists: (name) => {
      try { run(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]); return true; }
      catch { return false; }
    },
    // 2026-09-08, added alongside prepareStackedBranch below -- checks the REMOTE copy
    // specifically (refs/remotes/origin/<name>), distinct from branchExists' local-only
    // check. A caller must never treat "a local ref with this name exists" as proof the
    // branch is real/current -- see prepareStackedBranch's own header for the incident.
    remoteBranchExists: (name) => {
      try { run(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`]); return true; }
      catch { return false; }
    },
    // Best-effort fetch of one non-main branch (stacked decompose: pick up a prior step's
    // commit if this host's local ref is behind or missing). A failure is non-fatal.
    fetchBranch: (name) => {
      try { return run(['fetch', 'origin', name]); } catch { return ''; }
    },
    // Reset-or-create a local branch to track origin/<name> exactly (stacked decompose,
    // when the local ref is missing or stale but origin has the prior step's commit).
    checkoutTracking: (name) => run(['checkout', '-B', name, `origin/${name}`]),
    deleteBranch: (name) => run(['branch', '-D', name]),
    // 2026-09-08, Grimmethy: "harden it properly with tests" -- root-caused live: apply-
    // task.js's stacked-decompose handling (seq > 1) used to trust branchExists(name)
    // (a LOCAL-only check) as proof the branch was safe to check out, with no check that
    // the local copy was actually current. A 5-day-old, unrelated local branch with the
    // SAME name -- leftover cruft, origin's real copy long since merged and deleted --
    // made every apply attempt check out that stale tree and then fail to apply a diff
    // computed against current main, identically, every single retry (not a race; a
    // permanently wrong decision that would never self-correct). This is the single,
    // self-contained decision resetToMain() already models for the analogous "is my
    // local copy of mainBranch safe to sync from origin" question -- same ahead/behind/
    // diverged reasoning, applied here to a per-hub scratch branch instead:
    //   - origin has it, local doesn't (or local ⊆ origin, i.e. stale/behind/identical):
    //     sync local to origin's tip. Always safe -- local has nothing origin lacks.
    //   - origin has it AND local is STRICTLY ahead (real unpushed commits, e.g. a prior
    //     step's own push failed after a successful commit): trust local as-is, matching
    //     the old default behavior -- never silently discard real unpushed work.
    //   - origin has it and the two have diverged: surface loudly for a human, exactly
    //     like resetToMain's own diverged case -- never guess which side to keep.
    //   - origin doesn't have it, but local descends from CURRENT main: plausibly real,
    //     unpushed work from a step whose push never even started -- trust it.
    //   - origin doesn't have it, and local (if any) does NOT descend from current main:
    //     this is the exact stale-branch case that caused the incident. Discard any such
    //     local branch and fall back to resetToMain() + a fresh branch off it, the same
    //     "the whole prior chain already merged" fallback the seq===1 path already uses
    //     (2026-09-07 reasoning) -- now reached by an actual staleness check instead of
    //     by trusting whatever name happens to exist locally.
    prepareStackedBranch: (name) => {
      try { run(['fetch', 'origin', name]); } catch { /* best-effort, matches fetchBranch */ }
      const remote = `origin/${name}`;
      const remoteExists = (() => {
        try { run(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}`]); return true; } catch { return false; }
      })();
      const localExists = (() => {
        try { run(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]); return true; } catch { return false; }
      })();
      if (remoteExists) {
        if (localExists) {
          const originInLocal = isAncestor(remote, name); // origin ⊆ local (local ahead or equal)
          const localInOrigin = isAncestor(name, remote); // local ⊆ origin (local behind or equal)
          if (originInLocal && !localInOrigin) {
            run(['checkout', name]); // real unpushed commits -- trust local as-is.
            return;
          }
          if (!originInLocal && !localInOrigin) {
            throw new Error(`prepareStackedBranch: local ${name} and ${remote} have diverged (each has commit(s) the other lacks) -- needs a human to reconcile, not an automatic sync`);
          }
        }
        // A ROLLING branch (e.g. TRIAGE_BRANCH) is never explicitly rebased on its own --
        // apply-main-batch.js's own header says so plainly ("based on whatever main was
        // when it was first created and is never rebased"). Every branch of the logic
        // above only ever compares LOCAL to REMOTE; none of it ever asks whether the
        // REMOTE copy itself has fallen behind current main. Root-caused live 2026-09-22:
        // a human merged the branch and deleted it, but a near-concurrent apply cycle
        // recreated it (a real race, or simply this same "trust origin blindly" gap on an
        // OLDER cycle, well before that merge) anchored to a point of main from TWO DAYS
        // earlier -- every apply after that just kept stacking onto that same stale
        // lineage, silently re-including commits that had already separately landed on
        // main (identical SHAs -- confirmed live), one of which was a finding a human had
        // explicitly retracted as a false positive after the fact.
        try { run(['fetch', 'origin', mainBranch]); } catch { /* best-effort, matches fetchMain elsewhere */ }
        if (!isAncestor(`origin/${mainBranch}`, remote)) {
          run(['checkout', '-B', name, remote]);
          try {
            run(['rebase', `origin/${mainBranch}`]);
          } catch (e) {
            try { run(['rebase', '--abort']); } catch { /* best-effort */ }
            throw new Error(
              `prepareStackedBranch: ${remote} is based on a stale point of ${mainBranch} (main has moved on since this rolling branch was last built) and rebasing its still-unmerged commits onto the current tip failed -- needs a human to reconcile, not an automatic sync: ${e.message}`,
            );
          }
          return;
        }
        run(['checkout', '-B', name, remote]); // local missing, or ⊆ origin (stale/behind/identical); remote itself is current
        return;
      }
      if (localExists && isAncestor(`origin/${mainBranch}`, name)) {
        run(['checkout', name]); // no remote copy, but local is real work off current main
        return;
      }
      // No remote copy, and no trustworthy local copy -- discard any stale local branch
      // and start this step fresh off current main (2026-09-07 fallback reasoning: origin
      // having nothing can only mean the whole prior chain already merged).
      if (localExists) { try { run(['branch', '-D', name]); } catch { /* best-effort */ } }
      doResetToMain();
// ... [truncated for review: this function continues for 4 more line(s) not shown]
```

Problem:
The 204-line `createRealGitRunner` factory buries two independently complex, multi-branch operations—`doResetToMain` (stash → checkout → fetch → two-way ancestor check → push-or-rescue → hard reset → conditional stash pop) and `prepareStackedBranch` (fetch → remote/local existence → four-way ancestor matrix → stale-main rebase → fallback reset)—as anonymous closures inside a single function body. Neither can be unit-tested in isolation because they close over `run`, `isAncestor`, `mainBranch`, and `repoRoot`; the only way to exercise the rescue-branch path or the diverged-throw path is to invoke the factory against a real repository. The remaining ~80 lines are a dozen one-liner method definitions and factory wiring, which are fine, but they force a reader to scroll through two dense decision trees just to find the API surface.

Solution:
Lift `doResetToMain` and `prepareStackedBranch` to module-level named functions that receive a small context object (`{ run, isAncestor, mainBranch }`), and promote the two tiny helpers (`makeRun`, `makeIsAncestor`) alongside them. The factory shrinks to a ~40-line wiring block that constructs the context and returns the flat API object. The incident-history comments (2026-07-19, 2026-09-08, 2026-09-14, 2026-09-22) move with the code they annotate. The one-liner methods stay in the returned object; no new module boundary is introduced for the helpers.

```diff
+ // ── shared helpers (promoted from factory body) ──
+ function makeRun(repoRoot) {
+   return (args) =>
+     execFileSync('git', args, {
+       cwd: repoRoot, stdio: 'pipe', encoding: 'utf8',
+       env: GIT_ENV, timeout: GIT_TIMEOUT_MS,
+     });
+ }
+
+ function makeIsAncestor(run) {
+   return (a, b) => {
+     try { run(['merge-base', '--is-ancestor', a, b]); return true; }
+     catch { return false; }
+   };
+ }
+
+ // ── extracted: was inline closure in createRealGitRunner ──
+ // [incident-history comments 2026-07-19 / 2026-09-08 move here]
+ function doResetToMain({ run, isAncestor, mainBranch }) {
+   // … body unchanged: stash, checkout, fetch, ancestor matrix,
+   //   push-or-rescue, reset --hard, conditional stash pop …
+ }
+
+ // [incident-history comments 2026-09-14 / 2026-09-22 move here]
+ function prepareStackedBranch({ run, isAncestor, mainBranch, doResetToMain }) {
+   return (name) => {
+     // … body unchanged: fetch, remote/local existence,
+     //   4-way ancestor matrix, stale-main rebase, fallback …
+   };
+ }
+
  // ── factory: now short, purely wiring ──
  function createRealGitRunner(repoRoot) {
    const mainBranch = detectDefaultBranch(repoRoot);
    const run        = makeRun(repoRoot);
    const isAncestor = makeIsAncestor(run);
    const resetToMain = () => doResetToMain({ run, isAncestor, mainBranch });

    return {
      mainBranch,
      fetchMain:        () => run(['fetch', 'origin', mainBranch]),
      resetToMain,
      createBranch:     (name) => run(['checkout', '-b', name]),
      checkoutMain:     () => run(['checkout', mainBranch]),
      checkoutBranch:   (name) => run(['checkout', name]),
      branchExists:     (name) => { try { run(['rev-parse','--verify','--quiet',`refs/heads/${name}`]); return true; } catch { return false; } },
      remoteBranchExists: (name) => { try { run(['rev-parse','--verify','--quiet',`refs/remotes/origin/${name}`]); return true; } catch { return false; } },
      fetchBranch:      (name) => { try { return run(['fetch','origin',name]); } catch { return ''; } },
      checkoutTracking: (name) => run(['checkout','-B',name,`origin/${name}`]),
      deleteBranch:     (name) => run(['branch','-D',name]),
-     // [~60 lines of doResetToMain closure removed from here]
-     // [~70 lines of prepareStackedBranch closure removed from here]
      prepareStackedBranch: prepareStackedBranch({ run, isAncestor, mainBranch, doResetToMain: resetToMain }),
    };
  }
```

Benefits:
Both extracted functions become named, importable units. A test can call `doResetToMain({ run: mockRun, isAncestor: mockAnc, mainBranch: 'main' })` with a scripted `mockRun` and assert the exact git-argument sequence—including the rescue-branch path and the diverged-throw path—without touching a real repository. The factory drops from 204 lines to roughly 40 lines of wiring, so a reader sees the full API surface immediately without scrolling through two dense decision trees. Adding a new git operation becomes a one-liner in the returned object rather than an insertion between two complex closures. Review diffs for changes to either complex operation no longer interleave with unrelated one-liner edits in the factory body.

### AC-171 · Decompose renderDiscoveryTab into pure row-builder functions
Strength: Strong
Files: python/dashboard/static/js/analytics-and-discovery.js
Snippet:
```
}

async function renderDiscoveryTab() {
  const d = await fetchJson('/api/discovery');
  discoveryCandidatesCache = d.candidates || [];
  const main = document.getElementById('main');
  if (!d.available) {
    main.innerHTML = '<div class="empty">No discovery state found for the active project -- community-coverage.json and the candidates doc appear once the project graph is built and arch_discovery has run.</div>';
    return;
  }

  const reviewed = d.communities.filter(c => c.lastReviewedAt).length;
  const inFlight = d.tasks.filter(t => t.state !== 'done');
  const doneRuns = d.tasks.filter(t => t.state === 'done');
  const nextCommunity = d.communities.find(c => c.id === d.nextCommunityId);
  const stats = `
    <div class="stat-row">
      <div class="stat"><strong>${reviewed} / ${d.communities.length}</strong>communities reviewed</div>
      <div class="stat"><strong>${inFlight.length}</strong>runs in flight</div>
      <div class="stat"><strong>${doneRuns.length}</strong>runs completed</div>
      <div class="stat"><strong>${d.candidates.length}</strong>candidates produced</div>
      <div class="stat"><strong>${nextCommunity ? escapeHtml(nextCommunity.name) : '--'}</strong>next up</div>
    </div>`;

  // Same order the job itself works in (nextArchDiscoveryTask's oldest-first rotation,
  // never-reviewed before any real timestamp), so the top of the table is always "what
  // discovery cares about right now".
  const sortedCommunities = [...d.communities].sort((a, b) =>
    (a.lastReviewedAt || '').localeCompare(b.lastReviewedAt || ''));
  // Only rows with something to say (in queue, next up, or actually reviewed) show by
  // default; the untouched tail collapses to a one-line count.
  const interesting = sortedCommunities.filter(c =>
    c.inFlightState || c.id === d.nextCommunityId || c.lastReviewedAt);
  const communities = discoveryShowAllCommunities ? sortedCommunities : interesting;
  const hiddenCount = sortedCommunities.length - communities.length;
  const communityRows = communities.map(c => {
    const status = c.inFlightState
      ? `<span class="badge warn">in queue: ${escapeHtml(c.inFlightState)}</span>`
      : c.id === d.nextCommunityId
        ? '<span class="badge ok">next up</span>'
        : c.lastReviewedAt
          ? '<span class="badge idle">reviewed</span>'
          : '<span class="badge idle">never reviewed</span>';
    return `<tr>
      <td>#${c.id} ${escapeHtml(c.name || '')}</td>
      <td>${status}</td>
      <td>${c.lastReviewedAt ? new Date(c.lastReviewedAt).toLocaleString() : ''}</td>
      <td>${c.lastCandidateCount ?? ''}</td>
    </tr>`;
  }).join('');

  const stateBadge = (s) => {
    const cls = s === 'done' ? 'ok' : s === 'blocked' ? 'bad'
      : (s === 'needs-clarification' || s === 'awaiting-confirm') ? 'warn' : 'idle';
    return `<span class="badge ${cls}">${escapeHtml(s)}</span>`;
  };
  const runRows = d.tasks.map(t => {
    // Whichever field carries the run's actual outcome -- same signal priority as
    // _adhoc_task_excerpt server-side.
    const result = t.blockedReason
      ? `<span style="color:var(--bad)">${escapeHtmlBright(t.blockedReason.slice(0, 140))}${t.blockedReason.length > 140 ? '…' : ''}</span>`
      : t.doneMarker
        ? escapeHtml(t.doneMarker)
        : t.hasImplement ? 'draft written' : t.hasPlan ? 'plan written' : '';
    return `<tr class="clickable" data-task-id="${escapeAttr(t.id)}" title="Click for the full readout (plan, draft, review verdicts)">
      <td>${escapeHtmlBright(t.title)}</td>
      <td>${stateBadge(t.state)}</td>
      <td>${t.createdAt ? new Date(t.createdAt).toLocaleString() : ''}</td>
      <td class="meta">${result}</td>
    </tr>`;
  }).join('');
  const runsTable = d.tasks.length === 0
    ? '<div class="empty">No arch-discovery runs in the queue yet.</div>'
    : `<table><thead><tr><th>Run</th><th>State</th><th>Created</th><th>Result</th></tr></thead><tbody>${runRows}</tbody></table>`;

  const candidateRows = d.candidates.map(c => `
    <tr class="clickable" data-candidate-id="${c.id}" title="Click to read the full write-up">
      <td><span class="bd-serial">AC-${String(c.id).padStart(3, '0')}</span></td>
      <td>${escapeHtmlBright(c.title)}</td>
      <td>${c.strength ? `<span class="badge ${c.strength === 'Strong' ? 'ok' : 'idle'}">${escapeHtml(c.strength)}</span>` : ''}</td>
      <td class="meta">${c.files.slice(0, 3).map(escapeHtml).join(', ')}${c.files.length > 3 ? ` +${c.files.length - 3} more` : ''}</td>
    </tr>`).join('');
  const candidatesTable = d.candidates.length === 0
    ? '<div class="empty">No candidates written yet.</div>'
    : `<table><thead><tr><th>ID</th><th>Candidate</th><th>Strength</th><th>Files</th></tr></thead><tbody>${candidateRows}</tbody></table>`;

  const communityToggle = (discoveryShowAllCommunities || hiddenCount > 0)
    ? `<div style="margin:8px 0 0"><button class="secondary" id="discovery-show-all">${
        discoveryShowAllCommunities
          ? 'Show active communities only'
          : `Show all ${sortedCommunities.length} communities (${hiddenCount} never reviewed hidden)`
      }</button></div>`
    : '';

  // Runs and candidates first -- they're what this tab exists to surface; the (large)
  // community rotation table is reference material below them.
  main.innerHTML = stats
    + `<div class="field-label">Discovery Runs</div>` + runsTable
    + `<div class="field-label">Candidates Produced${d.candidatesPath ? ` <span style="text-transform:none;letter-spacing:0">(${escapeHtml(d.candidatesPath)})</span>` : ''}</div>`
    + candidatesTable
    + `<div class="field-label">Communities (rotation order)</div>`
    + `<table><thead><tr><th>Community</th><th>Status</th><th>Last Reviewed</th><th>Candidates Last Run</th></tr></thead><tbody>${communityRows}</tbody></table>`
    + communityToggle;

  main.querySelectorAll('tr[data-task-id]').forEach(row => {
    row.onclick = () => openTaskAnywhere(row.dataset.taskId);
  });
  main.querySelectorAll('tr[data-candidate-id]').forEach(row => {
    row.onclick = () => openDiscoveryCandidate(parseInt(row.dataset.candidateId, 10));
  });
  const toggleBtn = document.getElementById('discovery-show-all');
  if (toggleBtn) toggleBtn.onclick = () => {
    discoveryShowAllCommunities = !discoveryShowAllCommunities;
    renderDiscoveryTab();
  };
}
```

Problem:
`renderDiscoveryTab` is 114 lines and interleaves four independent row-mapping strategies (community status badges with a 4-way ternary and sort/filter pipeline, run-result extraction with a 4-way `blockedReason → doneMarker → hasImplement → hasPlan` chain, candidate strength badges, and stats aggregation) plus a separate DOM event-wiring block. None of those four mapping blocks can be unit-tested in isolation today without invoking the whole function and a live DOM, and the densest branching (the run-result chain) is buried in the middle of a long template-literal assembly, making it the hardest section to reason about in context.

Solution:
Extract each mapping block into a small, pure function that takes the already-fetched `d` object and returns an HTML string (or a `{rows, toggle}` pair for the community section), then reduce the orchestrator to a ~20-line fetch → assemble → wire-events sequence. The concrete shape:

```javascript
// --- extracted pure builders (no DOM, no fetch) ---

function buildStatsHtml(d) {
  const reviewed  = d.communities.filter(c => c.lastReviewedAt).length;
  const inFlight  = d.tasks.filter(t => t.state !== 'done');
  const doneRuns  = d.tasks.filter(t => t.state === 'done');
  const next      = d.communities.find(c => c.id === d.nextCommunityId);
  return `
    <div class="stat-row">
      <div class="stat"><strong>${reviewed} / ${d.communities.length}</strong> communities reviewed</div>
      <div class="stat"><strong>${inFlight.length}</strong> runs in flight</div>
      <div class="stat"><strong>${doneRuns.length}</strong> runs completed</div>
      <div class="stat"><strong>${d.candidates.length}</strong> candidates produced</div>
      <div class="stat"><strong>${next ? escapeHtml(next.name) : '--'}</strong> next up</div>
    </div>`;
}

function buildCommunityRows(d) {
  const sorted = [...d.communities].sort((a, b) =>
    (a.lastReviewedAt || '').localeCompare(b.lastReviewedAt || ''));
  const interesting = sorted.filter(c =>
    c.inFlightState || c.id === d.nextCommunityId || c.lastReviewedAt);
  const visible = discoveryShowAllCommunities ? sorted : interesting;
  const rows = visible.map(c => {
    const status = c.inFlightState
      ? `<span class="badge warn">in queue: ${escapeHtml(c.inFlightState)}</span>`
      : c.id === d.nextCommunityId
        ? '<span class="badge ok">next up</span>'
        : c.lastReviewedAt
          ? '<span class="badge idle">reviewed</span>'
          : '<span class="badge idle">never reviewed</span>';
    return `<tr>
      <td>#${c.id} ${escapeHtml(c.name || '')}</td>
      <td>${status}</td>
      <td>${c.lastReviewedAt ? new Date(c.lastReviewedAt).toLocaleString() : ''}</td>
      <td>${c.lastCandidateCount ?? ''}</td>
    </tr>`;
  }).join('');
  const hiddenCount = sorted.length - visible.length;
  const toggle = (discoveryShowAllCommunities || hiddenCount > 0)
    ? `<div style="margin:8px 0 0"><button class="secondary" id="discovery-show-all">${
        discoveryShowAllCommunities
          ? 'Show active communities only'
          : `Show all ${sorted.length} communities (${hiddenCount} never reviewed hidden)`
      }</button></div>`
    : '';
  return { rows, toggle };
}

function buildRunsTable(d) {
  const stateBadge = (s) => {
    const cls = s === 'done' ? 'ok' : s === 'blocked' ? 'bad'
      : (s === 'needs-clarification' || s === 'awaiting-confirm') ? 'warn' : 'idle';
    return `<span class="badge ${cls}">${escapeHtml(s)}</span>`;
  };
  const rows = d.tasks.map(t => {
    const result = t.blockedReason
      ? `<span style="color:var(--bad)">${escapeHtmlBright(t.blockedReason.slice(0, 140))}${t.blockedReason.length > 140 ? '\u2026' : ''}</span>`
      : t.doneMarker ? escapeHtml(t.doneMarker)
      : t.hasImplement ? 'draft written' : t.hasPlan ? 'plan written' : '';
    return `<tr class="clickable" data-task-id="${escapeAttr(t.id)}" title="Click for the full readout">
      <td>${escapeHtmlBright(t.title)}</td>
      <td>${stateBadge(t.state)}</td>
      <td>${t.createdAt ? new Date(t.createdAt).toLocaleString() : ''}</td>
      <td class="meta">${result}</td>
    </tr>`;
  }).join('');
  return d.tasks.length === 0
    ? '<div class="empty">No arch-discovery runs in the queue yet.</div>'
    : `<table><thead><tr><th>Run</th><th>State</th><th>Created</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function buildCandidatesTable(d) {
  const rows = d.candidates.map(c => `
    <tr class="clickable" data-candidate-id="${c.id}" title="Click to read the full write-up">
      <td><span class="bd-serial">AC-${String(c.id).padStart(3, '0')}</span></td>
      <td>${escapeHtmlBright(c.title)}</td>
      <td>${c.strength ? `<span class="badge ${c.strength === 'Strong' ? 'ok' : 'idle'}">${escapeHtml(c.strength)}</span>` : ''}</td>
      <td class="meta">${c.files.slice(0, 3).map(escapeHtml).join(', ')}${c.files.length > 3 ? ` +${c.files.length - 3} more` : ''}</td>
    </tr>`).join('');
  return d.candidates.length === 0
    ? '<div class="empty">No candidates written yet.</div>'
    : `<table><thead><tr><th>ID</th><th>Candidate</th><th>Strength</th><th>Files</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function wireDiscoveryEvents(main) {
  main.querySelectorAll('tr[data-task-id]').forEach(row => {
    row.onclick = () => openTaskAnywhere(row.dataset.taskId);
  });
  main.querySelectorAll('tr[data-candidate-id]').forEach(row => {
    row.onclick = () => openDiscoveryCandidate(parseInt(row.dataset.candidateId, 10));
  });
  const toggleBtn = document.getElementById('discovery-show-all');
  if (toggleBtn) toggleBtn.onclick = () => {
    discoveryShowAllCommunities = !discoveryShowAllCommunities;
    renderDiscoveryTab();
  };
}

// --- slimmed orchestrator (~20 lines) ---

async function renderDiscoveryTab() {
  const d = await fetchJson('/api/discovery');
  discoveryCandidatesCache = d.candidates || [];
  const main = document.getElementById('main');
  if (!d.available) {
    main.innerHTML = '<div class="empty">No discovery state found for the active project.</div>';
    return;
  }
  const { rows: communityRows, toggle: communityToggle } = buildCommunityRows(d);
  main.innerHTML = buildStatsHtml(d)
    + `<div class="field-label">Discovery Runs</div>` + buildRunsTable(d)
    + `<div class="field-label">Candidates Produced${d.candidatesPath ? ` <span style="text-transform:none;letter-spacing:0">(${escapeHtml(d.candidatesPath)})</span>` : ''}</div>`
    + buildCandidatesTable(d)
    + `<div class="field-label">Communities (rotation order)</div>`
    + `<table><thead><tr><th>Community</th><th>Status</th><th>Last Reviewed</th><th>Candidates Last Run</th></tr></thead><tbody>${communityRows}</tbody></table>`
    + communityToggle;
  wireDiscoveryEvents(main);
}
```

No API or DOM contract changes; the `innerHTML` output is byte-identical if the builders are transcribed faithfully. The only shared mutable state is the existing module-level `discoveryShowAllCommunities` flag, which `buildCommunityRows` reads and `wireDiscoveryEvents` toggles—same as today.

Benefits:
Each extracted builder is a pure function of the `d` object (plus the one module-level flag for the community section), so any of the four can be unit-tested with a fixture object and a string-equality assertion without a DOM or network. The densest branching—the run-result extraction chain—becomes a 15-line function with a single, obvious entry point instead of a nested ternary buried in a 114-line body. Code review diffs become scoped to one builder at a time, and the orchestrator reads as a linear "fetch → assemble → wire" pipeline that a new contributor can follow in under a minute.

### AC-172 · Decompose enterProjectTab to isolate server-state sync logic
Strength: Strong
Files: python/dashboard/static/js/project-tab.js
Snippet:
```
async function enterProjectTab() {
  // Sync the path input from the server's actual active project on every tab entry, before
  // rendering it. Without this, the input only ever reflected localStorage -- if the active
  // project changed via any OTHER route (hand-editing agent-manager.env, another browser tab,
  // launch.bat) the input would silently keep showing a stale path while "Last configured
  // project" below it correctly showed the truth. Since Start Pipeline acts on the input's
  // value, not on activeRepoRoot, that mismatch could launch a pipeline against the wrong
  // project with no warning. Only overrides on tab entry, not on the 3s poll thereafter, so a
  // deliberate browse-a-different-project session isn't fought by this sync mid-use.
  //
  // Compares against lastSyncedActiveRepoRoot (the last server value we actually observed),
  // NOT against projectPath -- comparing against projectPath meant a typed-but-not-yet-started
  // path (Start Pipeline never ran, so activeRepoRoot on the server never changed) got silently
  // overwritten back to the server's stale/placeholder activeRepoRoot on every single tab
  // revisit, since the two never stopped disagreeing. Bug: "Project File Path ... resets to a
  // non-existent default path each time I navigate to it" (2026-08-18). Only a genuine change
  // in what the server reports since we last looked now counts as "external".
  try {
    const status = await fetchJson('/api/pipeline/status');
    if (status.activeRepoRoot && status.activeRepoRoot !== lastSyncedActiveRepoRoot) {
      lastSyncedActiveRepoRoot = status.activeRepoRoot;
      if (status.activeRepoRoot !== projectPath) setProjectPath(status.activeRepoRoot);
    }
    // Same reasoning as the path sync above: reflect whatever's actually configured
    // server-side (env file / another tab / launch.bat) rather than only ever showing
    // this browser's last local choice.
    if (typeof status.includeApply === 'boolean') {
      includeApply = status.includeApply;
      localStorage.setItem('agentManagerIncludeApply', String(includeApply));
    }
    if (typeof status.skipPush === 'boolean') {
      skipPush = status.skipPush;
      localStorage.setItem('agentManagerSkipPush', String(skipPush));
    }
  } catch (e) { /* dashboard's own status check failed -- fall back to whatever's cached */ }

  const main = document.getElementById('main');
  main.innerHTML = `
    <div style="display:flex;flex-direction:column;height:calc(100vh - 93px);">
      <div class="path-row">
        <select id="project-select" style="flex:1;"><option value="">Loading projects...</option></select>
        <input id="project-path-input" type="text" placeholder="C:\\path\\to\\your\\project" value="${escapeAttr(projectPath)}" list="project-history-list" autocomplete="off" style="display:none;">
        <datalist id="project-history-list"></datalist>
        <button class="secondary" id="history-toggle">History...</button>
        <button class="secondary" id="browse-toggle">Browse...</button>
        <button class="secondary" id="sync-btn" title="Fetch origin and fast-forward this checkout onto it">Sync with GitHub</button>
        <button class="action" id="build-btn">Build Graph</button>
      </div>
      <div id="history-panel" class="browser-panel" style="display:none"></div>
      <div class="path-row">
        <input id="project-grepdirs-input" type="text" placeholder="src, frontend/src, backend/src (optional -- comma-separated, leave blank to scan the whole path)" value="${escapeAttr(grepDirs)}">
      </div>
      <div class="path-row" id="pipeline-toggles-row" style="gap:16px;align-items:center;">
        <label style="display:flex;align-items:center;gap:4px;font-size:0.9em;cursor:pointer;">
          <input type="checkbox" id="include-apply-toggle" ${includeApply ? 'checked' : ''}>
          Enable Apply Runner (writes/commits changes)
        </label>
        <label style="display:flex;align-items:center;gap:4px;font-size:0.9em;cursor:pointer;${includeApply ? '' : 'opacity:.5;'}" title="Applied work is always pushed now (2026-08-17) -- an unpushed branch was silently losing real work over time. This only controls whether the local checkout returns to main after each apply, or stays on the applied branch for inspection.">
          <input type="checkbox" id="skip-push-toggle" ${!includeApply ? 'disabled' : ''} ${!skipPush ? 'checked' : ''}>
          Return to main after each apply (unchecked: stay on the applied branch)
        </label>
        <span class="meta" style="font-size:0.85em;">Which job types run is now controlled from the Job List tab. Applied work is always pushed to the remote for durability, regardless of this toggle.</span>
      </div>
      <div id="browser-panel" class="browser-panel" style="display:none"></div>
      <div id="pipeline-panel" class="worker-card"></div>
      <div id="project-status-area" style="flex:1;min-height:0;display:flex;flex-direction:column;"></div>
    </div>
  `;
  lastRenderedStatusKey = null;  // fresh tab entry -- force the first poll to actually render
  document.getElementById('project-path-input').addEventListener('change', (e) => {
    setProjectPath(e.target.value.trim());
    lastRenderedStatusKey = null;  // switched projects -- old key would wrongly suppress the new render
    refreshProjectStatus();
  });
  document.getElementById('include-apply-toggle').addEventListener('change', (e) => {
    includeApply = e.target.checked;
    localStorage.setItem('agentManagerIncludeApply', String(includeApply));
    const pushToggle = document.getElementById('skip-push-toggle');
    pushToggle.disabled = !includeApply;
    pushToggle.closest('label').style.opacity = includeApply ? '' : '.5';
    if (!includeApply) { pushToggle.checked = false; skipPush = true; localStorage.setItem('agentManagerSkipPush', 'true'); }
  });
  document.getElementById('skip-push-toggle').addEventListener('change', (e) => {
    skipPush = !e.target.checked;
    localStorage.setItem('agentManagerSkipPush', String(skipPush));
  });
  document.getElementById('project-select').addEventListener('change', (e) => {
    if (!e.target.value) return;
    setProjectPath(e.target.value);
    document.getElementById('project-path-input').value = projectPath;
    lastRenderedStatusKey = null;  // switched projects -- old key would wrongly suppress the new render
    refreshProjectStatus();
  });
  document.getElementById('browse-toggle').onclick = () => {
    browserOpen = !browserOpen;
    document.getElementById('browser-panel').style.display = browserOpen ? 'block' : 'none';
    // Manual path entry only makes sense while actively browsing -- otherwise the
    // dropdown (populated from Second Brain's referenced projects) is the only way
    // to pick a project, per the actual ask.
    document.getElementById('project-select').style.display = browserOpen ? 'none' : '';
    document.getElementById('project-path-input').style.display = browserOpen ? '' : 'none';
    if (browserOpen) { browsePath = projectPath || ''; loadBrowsePanel(); }
  };
  document.getElementById('history-toggle').onclick = () => {
    historyOpen = !historyOpen;
    document.getElementById('history-panel').style.display = historyOpen ? 'block' : 'none';
    if (historyOpen) renderHistoryPanel();
  };
  document.getElementById('project-grepdirs-input').addEventListener('change', (e) => {
    grepDirs = e.target.value.trim();
    localStorage.setItem('agentManagerGrepDirs', grepDirs);
  });
  document.getElementById('build-btn').onclick = triggerBuild;
  document.getElementById('sync-btn').onclick = triggerSync;

  await loadProjectHistory();
  await loadProjectDropdown();
  await refreshPipelineStatus();
  await refreshProjectStatus();
  projectStatusInterval = setInterval(() => { refreshPipelineStatus(); refreshProjectStatus(); }, 3000);
}
```

Problem:
`enterProjectTab` is 121 lines that interleave a subtle server-state sync comparison, a ~30-line HTML template string, ~40 lines of coupled event wiring, and a short init sequence. The sync block at the top contains a two-variable comparison (`lastSyncedActiveRepoRoot` vs `projectPath`) that already produced a real bug on 2026-08-18 (documented in the inline comment); that logic is buried 15 lines into a function whose remaining 106 lines are layout and wiring, making it easy for a future edit to land in the wrong place or miss a related handler. The HTML string inflates the line count and pushes the sync logic further from the function's entry point, obscuring "what happens first."

Solution:
Extract three named helpers and leave a thin ~10-line orchestrator. The critical extraction is `syncProjectTabStateFromServer()`, which owns the `lastSyncedActiveRepoRoot` / `projectPath` comparison and the `includeApply` / `skipPush` persistence in one independently-callable, unit-testable unit. The HTML template becomes `projectTabHTML()` (pure string, no logic). All DOM listeners move into `wireProjectTabEvents()`. The new `enterProjectTab` body is just: call sync, set innerHTML, wire events, load history/dropdown, start the interval.

```js
// ── 1. Server-state sync (the subtle, bug-prone part) ──────────────────
async function syncProjectTabStateFromServer() {
  try {
    const status = await fetchJson('/api/pipeline/status');
    if (status.activeRepoRoot && status.activeRepoRoot !== lastSyncedActiveRepoRoot) {
      lastSyncedActiveRepoRoot = status.activeRepoRoot;
      if (status.activeRepoRoot !== projectPath) setProjectPath(status.activeRepoRoot);
    }
    if (typeof status.includeApply === 'boolean') {
      includeApply = status.includeApply;
      localStorage.setItem('agentManagerIncludeApply', String(includeApply));
    }
    if (typeof status.skipPush === 'boolean') {
      skipPush = status.skipPush;
      localStorage.setItem('agentManagerSkipPush', String(skipPush));
    }
  } catch (e) { /* fall back to cached values */ }
}

// ── 2. HTML layout (pure string, no logic) ─────────────────────────────
function projectTabHTML() {
  return `
    <div style="display:flex;flex-direction:column;height:calc(100vh - 93px);">
      <div class="path-row">
        <select id="project-select" style="flex:1;"><option value="">Loading projects...</option></select>
        <input id="project-path-input" type="text" placeholder="C:\\path\\to\\your\\project"
               value="${escapeAttr(projectPath)}" list="project-history-list"
               autocomplete="off" style="display:none;">
        <datalist id="project-history-list"></datalist>
        <button class="secondary" id="history-toggle">History...</button>
        <button class="secondary" id="browse-toggle">Browse...</button>
        <button class="secondary" id="sync-btn" title="Fetch origin and fast-forward this checkout onto it">Sync with GitHub</button>
        <button class="action" id="build-btn">Build Graph</button>
      </div>
      <div id="history-panel" class="browser-panel" style="display:none"></div>
      <div class="path-row">
        <input id="project-grepdirs-input" type="text"
               placeholder="src, frontend/src, backend/src (optional -- comma-separated, leave blank to scan the whole path)"
               value="${escapeAttr(grepDirs)}">
      </div>
      <div class="path-row" id="pipeline-toggles-row" style="gap:16px;align-items:center;">
        <label style="display:flex;align-items:center;gap:4px;font-size:0.9em;cursor:pointer;">
          <input type="checkbox" id="include-apply-toggle" ${includeApply ? 'checked' : ''}>
          Enable Apply Runner (writes/commits changes)
        </label>
        <label style="display:flex;align-items:center;gap:4px;font-size:0.9em;cursor:pointer;${includeApply ? '' : 'opacity:.5;'}"
               title="Applied work is always pushed now (2026-08-17) -- an unpushed branch was silently losing real work over time. This only controls whether the local checkout returns to main after each apply, or stays on the applied branch for inspection.">
          <input type="checkbox" id="skip-push-toggle" ${!includeApply ? 'disabled' : ''} ${!skipPush ? 'checked' : ''}>
          Return to main after each apply (unchecked: stay on the applied branch)
        </label>
        <span class="meta" style="font-size:0.85em;">Which job types run is now controlled from the Job List tab. Applied work is always pushed to the remote for durability, regardless of this toggle.</span>
      </div>
      <div id="browser-panel" class="browser-panel" style="display:none"></div>
      <div id="pipeline-panel" class="worker-card"></div>
      <div id="project-status-area" style="flex:1;min-height:0;display:flex;flex-direction:column;"></div>
    </div>`;
}

// ── 3. Event wiring (all DOM listeners in one place) ───────────────────
function wireProjectTabEvents() {
  document.getElementById('project-path-input').addEventListener('change', (e) => {
    setProjectPath(e.target.value.trim());
    lastRenderedStatusKey = null;
    refreshProjectStatus();
  });
  document.getElementById('include-apply-toggle').addEventListener('change', (e) => {
    includeApply = e.target.checked;
    localStorage.setItem('agentManagerIncludeApply', String(includeApply));
    const pushToggle = document.getElementById('skip-push-toggle');
    pushToggle.disabled = !includeApply;
    pushToggle.closest('label').style.opacity = includeApply ? '' : '.5';
    if (!includeApply) { pushToggle.checked = false; skipPush = true; localStorage.setItem('agentManagerSkipPush', 'true'); }
  });
  document.getElementById('skip-push-toggle').addEventListener('change', (e) => {
    skipPush = !e.target.checked;
    localStorage.setItem('agentManagerSkipPush', String(skipPush));
  });
  document.getElementById('project-select').addEventListener('change', (e) => {
    if (!e.target.value) return;
    setProjectPath(e.target.value);
    document.getElementById('project-path-input').value = projectPath;
    lastRenderedStatusKey = null;
    refreshProjectStatus();
  });
  document.getElementById('browse-toggle').onclick = () => {
    browserOpen = !browserOpen;
    document.getElementById('browser-panel').style.display = browserOpen ? 'block' : 'none';
    document.getElementById('project-select').style.display = browserOpen ? 'none' : '';
    document.getElementById('project-path-input').style.display = browserOpen ? '' : 'none';
    if (browserOpen) { browsePath = projectPath || ''; loadBrowsePanel(); }
  };
  document.getElementById('history-toggle').onclick = () => {
    historyOpen = !historyOpen;
    document.getElementById('history-panel').style.display = historyOpen ? 'block' : 'none';
    if (historyOpen) renderHistoryPanel();
  });
  document.getElementById('project-grepdirs-input').addEventListener('change', (e) => {
    grepDirs = e.target.value.trim();
    localStorage.setItem('agentManagerGrepDirs', grepDirs);
  });
  document.getElementById('build-btn').onclick = triggerBuild;
  document.getElementById('sync-btn').onclick = triggerSync;
}

// ── 4. Thin orchestrator (the new enterProjectTab) ─────────────────────
async function enterProjectTab() {
  await syncProjectTabStateFromServer();

  const main = document.getElementById('main');
  main.innerHTML = projectTabHTML();
  lastRenderedStatusKey = null;

  wireProjectTabEvents();

  await loadProjectHistory();
  await loadProjectDropdown();
  await refreshPipelineStatus();
  await refreshProjectStatus();
  projectStatusInterval = setInterval(() => { refreshPipelineStatus(); refreshProjectStatus(); }, 3000);
}
```

Benefits:
The sync comparison that caused the 2026-08-18 bug becomes a standalone ~15-line function whose entire purpose is that logic; it can be unit-tested with a stubbed `fetchJson` without mocking `document` or running the full 121-line orchestrator. Adding a new toggle or handler means opening `wireProjectTabEvents()` (~35 lines) rather than scanning 121 lines. Changing the layout means editing `projectTabHTML()` in isolation. The new `enterProjectTab` body is 10 lines of named calls, making the "what happens on tab entry" flow immediately readable and the sync step unmissable.

### AC-173 · Extract classification dispatch and outcome application from autoConfirmReview
Strength: Strong
Files: src/auto-confirm-review.js
Snippet:
```
}

async function autoConfirmReview({ pipelineDir, repoRoot, grepDirs, majorityVote, candidatesPath }) {
  const summary = { checked: 0, confirmed: 0, denied: 0, escalated: 0, errors: 0 };
  if (process.env.AGENT_MANAGER_AUTO_CONFIRM_REVIEW === 'false') return summary;

  const dir = path.join(pipelineDir, 'queue', 'awaiting-confirm');
  const approvedDir = path.join(pipelineDir, 'queue', 'approved');
  const archiveDir = path.join(pipelineDir, 'queue', 'done', '_archived_no_action');
  const fixCandidatesPath = candidatesPath || (getConfig().pipelineFixCandidatesPath);

  let names;
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return summary; // no awaiting-confirm/ dir -- nothing to do
  }

  for (const name of names) {
    const file = path.join(dir, name);
    let task;
    try {
      task = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      summary.errors += 1;
      continue;
    }
    if (task.autoConfirmReviewedAt) continue; // already reviewed once -- left for a human

    summary.checked += 1;
    const isForensics = task.source === 'pipeline_forensics';
    const isDebrief = task.source === 'pipeline_debrief';
    const deleteItems = (isForensics || isDebrief) ? [] : parseDeleteItems(task.implementResponse);

    let prompt;
    let gateStamp;
    if (isForensics) {
      prompt = buildForensicsConfirmPrompt(task, readCandidatesDoc(fixCandidatesPath));
      gateStamp = 'forensicsReportConfirmedAt';
    } else if (isDebrief) {
      prompt = buildDebriefConfirmPrompt(task);
      gateStamp = 'debriefReportConfirmedAt';
    } else if (deleteItems.length && batchContainsDeleteMode(task.implementResponse)) {
      const refMap = gatherDeleteReferences(repoRoot, grepDirs, deleteItems.map((i) => i.file), task);
      prompt = buildDeleteConfirmPrompt(task, deleteItems, refMap);
      gateStamp = 'deleteConfirmedAt';
    } else {
      // A hold we don't recognise -- don't guess. Leave it for a human, but stamp so we
      // don't re-check every tick.
      task.autoConfirmReviewedAt = new Date().toISOString();
      task.autoConfirmDecision = 'escalate';
      task.autoConfirmReviewNote = 'auto-confirm review does not recognise this hold type -- left for a human';
      appendHistoryEvent(task, 'advisory', task.autoConfirmReviewNote);
      try { fs.writeFileSync(file, JSON.stringify(task, null, 2)); summary.escalated += 1; }
      catch (err) {
        const taskId = task.id || (task.implementResponse ? task.implementResponse.slice(0, 8) : 'unknown');
        console.error(`[auto-confirm-review] escalate write failed: file=${file} task=${taskId} code=${err.code || ''} message=${err.message}`);
        summary.errors += 1;
      }
      continue;
    }

    let vote;
    try {
      vote = await majorityVote({
        prompt,
        classify: classifyVote(['CONFIRM', 'DENY'], 15),
        n: isDebrief ? DEBRIEF_VOTES : AUTO_CONFIRM_VOTES,
        minAgreeing: isDebrief ? DEBRIEF_MIN_AGREEING : AUTO_CONFIRM_MIN_AGREEING,
        temperature: 0.2,
        source: task.source,
      });
    } catch (e) {
      // Every vote hard-failed (infra). Do NOT stamp -- next tick retries.
      appendHistoryEvent(task, 'advisory', `auto-confirm review could not run (${(e && e.message || 'vote error').slice(0, 160)}) -- will retry`);
      try { fs.writeFileSync(file, JSON.stringify(task, null, 2)); } catch { /* best-effort */ }
      summary.errors += 1;
      continue;
    }

    const now = new Date().toISOString();
    if (vote.confident && vote.verdict === 'CONFIRM') {
      const reason = voteReason(vote, 'CONFIRM');
      task[gateStamp] = now; // 'forensicsReportConfirmedAt' or 'deleteConfirmedAt' -- the field apply-task.js's gate checks
      task.autoConfirmReviewedAt = now;
      task.autoConfirmDecision = 'confirm';
      task.autoConfirmReviewNote = reason;
      task.status = 'approved';
      appendHistoryEvent(task, 'approved', `auto-confirmed (votes: ${vote.realVoteCount}/${vote.requestedVotes}): ${reason}`);
      try {
        const result = moveTaskFile(file, approvedDir, name, task);
        if (result) summary.confirmed += 1;
        else { console.error(`auto-confirm: moveTaskFile returned falsy for ${name} (${file}): ${result}`); summary.errors += 1; }
      } catch (err) { console.error(`auto-confirm: moveTaskFile threw for ${name} (${file}): ${err && err.message || err}`); summary.errors += 1; }
    } else if (vote.confident && vote.verdict === 'DENY') {
      const reason = voteReason(vote, 'DENY');
      task.autoConfirmReviewedAt = now;
      task.autoConfirmDecision = 'deny';
      task.autoConfirmReviewNote = reason;
      task.status = 'done';
      task.doneMarker = `auto-denied at confirm gate: ${reason}`;
      appendHistoryEvent(task, 'archived', `auto-denied (votes: ${vote.realVoteCount}/${vote.requestedVotes}): ${reason}`);
      try {
        if (moveTaskFile(file, archiveDir, name, task)) summary.denied += 1;
        else summary.errors += 1;
      } catch (err) { console.error(`auto-confirm: moveTaskFile threw (DENY) for ${name} (${file}): ${err && err.message || err}`); summary.errors += 1; }
    } else {
      // No confident majority -- leave for a human.
      task.autoConfirmReviewedAt = now;
      task.autoConfirmDecision = 'escalate';
      task.autoConfirmReviewNote = `no confident CONFIRM/DENY majority (votes: ${vote.realVoteCount}/${vote.requestedVotes})`;
      appendHistoryEvent(task, 'advisory', `auto-confirm review inconclusive (${task.autoConfirmReviewNote}) -- held for a human`);
      try { fs.writeFileSync(file, JSON.stringify(task, null, 2)); summary.escalated += 1; }
      catch { summary.errors += 1; }
    }
  }

  return summary;
}
```

Problem:
The 117-line autoConfirmReview function carries two independent branching axes — a 4-way classification dispatch (forensics / debrief / delete / unknown) and a 3-way outcome dispatch (CONFIRM / DENY / inconclusive) — producing 12 distinct code paths through the loop body. Each outcome branch repeats the same shape (mutate 4–5 task fields, call appendHistoryEvent, move or write the file, bump a summary counter), so adding a fourth hold type or a new stamp field requires touching copy-pasted logic in three places. The combined reading burden makes a 17-line-over-threshold function feel like a 60-line one.

Solution:
Extract two named helpers scoped to this function: classifyAndBuildPrompt (the if/else-if/else-if/else block that decides what to vote on, returning a prompt + gateStamp or an escalate signal) and applyVoteOutcome (the CONFIRM/DENY/inconclusive block that mutates fields, appends history, moves the file, and returns the summary-counter key). The coordinator loop then shrinks to: scan directory → per-file: classify → vote → apply → bump counter.

```diff
--- a/src/auto-confirm-review.js
+++ b/src/auto-confirm-review.js
@@ -290,6 +290,52 @@
+function classifyAndBuildPrompt(task, { repoRoot, grepDirs, fixCandidatesPath }) {
+  const isForensics = task.source === 'pipeline_forensics';
+  const isDebrief   = task.source === 'pipeline_debrief';
+  const deleteItems = (isForensics || isDebrief) ? [] : parseDeleteItems(task.implementResponse);
+
+  if (isForensics) {
+    return { prompt: buildForensicsConfirmPrompt(task, readCandidatesDoc(fixCandidatesPath)), gateStamp: 'forensicsReportConfirmedAt' };
+  }
+  if (isDebrief) {
+    return { prompt: buildDebriefConfirmPrompt(task), gateStamp: 'debriefReportConfirmedAt' };
+  }
+  if (deleteItems.length && batchContainsDeleteMode(task.implementResponse)) {
+    const refMap = gatherDeleteReferences(repoRoot, grepDirs, deleteItems.map((i) => i.file), task);
+    return { prompt: buildDeleteConfirmPrompt(task, deleteItems, refMap), gateStamp: 'deleteConfirmedAt' };
+  }
+  return { escalate: true, note: 'unrecognised hold type -- left for a human' };
+}
+
+function applyVoteOutcome(task, file, name, { verdict, vote, gateStamp, approvedDir, archiveDir, now }) {
+  const reason = voteReason(vote, verdict);
+  task.autoConfirmReviewedAt = now;
+  task.autoConfirmDecision   = verdict.toLowerCase();
+  task.autoConfirmReviewNote = reason;
+
+  if (verdict === 'CONFIRM') {
+    task[gateStamp] = now;
+    task.status = 'approved';
+    appendHistoryEvent(task, 'approved', `auto-confirmed (votes: ${vote.realVoteCount}/${vote.requestedVotes}): ${reason}`);
+    return moveTaskFile(file, approvedDir, name, task) ? 'confirmed' : null;
+  }
+  if (verdict === 'DENY') {
+    task.status = 'done';
+    task.doneMarker = `auto-denied at confirm gate: ${reason}`;
+    appendHistoryEvent(task, 'archived', `auto-denied (votes: ${vote.realVoteCount}/${vote.requestedVotes}): ${reason}`);
+    return moveTaskFile(file, archiveDir, name, task) ? 'denied' : null;
+  }
+  appendHistoryEvent(task, 'advisory', `auto-confirm review inconclusive (${reason}) -- held for a human`);
+  fs.writeFileSync(file, JSON.stringify(task, null, 2));
+  return 'escalated';
+}
```

Benefits:
Each extracted helper is independently unit-testable without exercising the full loop: classifyAndBuildPrompt can be tested with fixture tasks for all four hold types, and applyVoteOutcome can be tested against a temp directory for all three verdicts (including the write-failure path). The coordinator drops to roughly 55 lines of linear flow (scan → classify → vote → apply → count), so a reviewer can verify the control structure in one pass. Future edits — adding a fifth hold type, changing a stamp field, or introducing a new outcome — touch exactly one helper instead of three interleaved branches.

### AC-174 · Decompose validatePlan into three strategy functions
Strength: Strong
Files: src/file-decompose-to-hub.js
Snippet:
```
// hardProblems block the whole plan (hub filed blocked, no children). Shared deps do not
// block -- they are threaded into the move + wiring prompts.
function validatePlan(repoRoot, request) {
  const hardProblems = [];
  const moveMeta = [];
  const allMovedSymbols = new Set();
  for (const m of request.moves) for (const s of (m.symbols || [])) allMovedSymbols.add(s);

  // A plain CommonJS source (src/*.js) -- neither an HTML <script> nor a .py. Run the
  // whole plan through decompose-node-module.js once: it chains the N moves and only
  // succeeds if EVERY move is a self-contained set of top-level function declarations
  // (references only each other + require()d names + JS globals). ok -> every move gets
  // nodeModuleApplyOk (the .js analogue of deterministicApplyOk); not-ok -> one hard
  // problem with the exact reason. The move `kind` (script-extract vs module-extract) is
  // irrelevant here -- .js wiring is require()/module.exports either way.
  //
  // 2026-09-14, screaminggoatclubmt: "Harden [this]" -- caught live: this branch used to
  // match ANY .js source by extension alone, with zero regard for whether it's actually a
  // Node CommonJS module. python/dashboard/static/js/*.js files are loaded via a plain
  // browser `<script src>` tag (see index.html) -- no bundler, no Node runtime, `require`
  // is not a defined identifier there at all. The produced split used real
  // require()/module.exports wiring anyway, which would have thrown "require is not
  // defined" the instant the browser loaded it, breaking the Models/Deep-Dive/Discovery/
  // Tokenfold tabs -- caught before merge only because this session verifies every branch
  // for real before recommending one. looksLikeNodeCommonJsModule (require()/module.exports
  // ANYWHERE in the source) gates this branch now; every real Node module in this repo has
  // at least one of those (confirmed: 0 occurrences across every static/js/*.js file,
  // 20+ each across a sample of real src/*.js modules). A file that fails this gate falls
  // through to the generic per-move loop below, which already handles `script-extract`
  // moves in a browser-safe way (staticCheckScriptExtractMove, verbatim extraction, no
  // require()/module.exports wiring at all) -- built and proven for plain .js sources
  // back on 2026-09-08 (review-task.js), just never reachable for THIS class of file
  // because this earlier, broader check always intercepted it first.
  if (/\.(js|mjs|cjs)$/.test(request.sourceFile || '')) {
    let sourceText = null;
    try { sourceText = fs.readFileSync(path.join(repoRoot, request.sourceFile), 'utf8'); } catch { /* unreadable -> advisory only */ }
    if (sourceText != null && looksLikeNodeCommonJsModule(sourceText)) {
      const built = buildNodeModuleOnePassChanges(sourceText, request.sourceFile, request.moves.map((m) => ({ newFile: m.newFile, symbols: m.symbols || [] })), repoRoot);
      if (built.ok) {
        for (const _m of request.moves) moveMeta.push({ sharedDeps: [], neededImports: [], nodeModuleApplyOk: true });
      } else {
        hardProblems.push(`${request.sourceFile}: ${built.reason}`);
        for (const _m of request.moves) moveMeta.push({ sharedDeps: [], neededImports: [] });
      }
      return { ok: hardProblems.length === 0, hardProblems, moveMeta };
    }
    // Unreadable, OR readable but not a CommonJS module -- fall through to the generic
    // per-move loop below rather than returning here.
  }

  // A .py source whose plan is ALL flask-blueprint moves: run the whole plan through
  // decompose-flask-blueprint.js once (AST extract + py_compile). ok -> every move gets
  // blueprintApplyOk and fileHub short-circuits to a single deterministic one-pass task
  // (no hub, no per-move 27B agentic pass -- which on a large app.py runs out of turn
  // budget before finishing: the 2026-09-09 blueprint hub). not-ok -> one hard problem.
  // A MIXED .py plan (some blueprint, some not) still falls through to the per-move path.
  if (process.env.AGENT_MANAGER_DECOMPOSE_BLUEPRINT !== 'false'
      && /\.py$/.test(request.sourceFile || '') && request.moves.length
      && request.moves.every((m) => m.kind === 'flask-blueprint' && m.blueprint)) {
    let sourceText = null;
    try { sourceText = fs.readFileSync(path.join(repoRoot, request.sourceFile), 'utf8'); } catch { /* unreadable -> advisory only */ }
    if (sourceText != null) {
      const built = buildBlueprintOnePassChanges(sourceText, request.sourceFile,
        request.moves.map((m) => ({ newFile: m.newFile, blueprint: m.blueprint, symbols: m.symbols || [] })));
      if (built.ok) {
        for (const _m of request.moves) moveMeta.push({ sharedDeps: [], neededImports: [], blueprintApplyOk: true });
      } else {
        hardProblems.push(`${request.sourceFile}: ${built.reason}`);
        for (const _m of request.moves) moveMeta.push({ sharedDeps: [], neededImports: [] });
      }
    } else {
      for (const _m of request.moves) moveMeta.push({ sharedDeps: [], neededImports: [] });
    }
    return { ok: hardProblems.length === 0, hardProblems, moveMeta };
  }

  for (const move of request.moves) {
    const symbols = move.symbols || [];
    const meta = { sharedDeps: [], neededImports: [] };
    if (symbols.length === 0) {
      hardProblems.push(`${move.newFile}: move has no symbols`);
      moveMeta.push(meta);
      continue;
    }
    if (move.kind === 'script-extract') {
      const seCheck = staticCheckScriptExtractMove(repoRoot, request.sourceFile, symbols);
      if (seCheck && seCheck.resolvable) {
        if (!seCheck.ok) {
          hardProblems.push(`${move.newFile}: ${seCheck.missing.join(', ')} could not be located as top-level function declarations in ${request.sourceFile}`);
        } else {
          // Every symbol resolves cleanly -- this move can skip the model entirely at
          // apply time (see local-draft.js's tryDeterministicScriptExtractEdit).
          meta.deterministicApplyOk = true;
        }
      }
      moveMeta.push(meta);
      continue;
    }
    const check = staticCheckMove(repoRoot, request.sourceFile, symbols);
    if (check) {
      if (check.missing && check.missing.length) {
        hardProblems.push(`${move.newFile}: ${check.missing.join(', ')} not defined at module scope in ${request.sourceFile}`);
      }
      const strays = Object.entries(check.externalRefs || {});
      if (strays.length) {
        hardProblems.push(`${move.newFile}: ${strays.map(([s, lines]) => `${s} is still referenced elsewhere in ${request.sourceFile} (line(s) ${lines.slice(0, 6).join(', ')})`).join('; ')} -- not a self-contained move`);
      }
      // `app` is expected for a flask-blueprint move (every @app.route becomes
      // @<bp>.route); anything else that resolves to an app.py module-level name and is
      // not itself being moved becomes a cross-module import.
      meta.sharedDeps = (check.sharedDeps || []).filter((d) => {
        if (d === 'app' && move.kind === 'flask-blueprint') return false;
        return !allMovedSymbols.has(d);
      });
      meta.neededImports = check.neededImports || [];
    }
    moveMeta.push(meta);
  }
  return { ok: hardProblems.length === 0, hardProblems, moveMeta };
}
```

Problem:
`validatePlan` is a 118-line three-way dispatch where each branch (Node CommonJS one-pass, Flask blueprint one-pass, generic per-move) is a self-contained validation strategy with its own gate condition, builder call, and result shape. The branches are mutually exclusive and independently testable, yet they are welded into a single function. Adding a fourth strategy (Rust, Go, a new Python framework) requires editing the entire 118-line body and risks the other two branches. The generic per-move loop itself contains a sub-branch (`script-extract` vs. generic) that is logically distinct. Even after stripping the ~30 lines of comments, the three branches are ~85 lines of different logic sharing only the input/output contract — a structural smell, not a padding one.

Solution:
Extract three strategy functions that each return `true` if they handled the plan (caller returns immediately) or `false` to fall through, plus a thin ~15-line dispatcher. The full decomposition, with every branch preserved verbatim, is:

```js
// ── Strategy 1: Node CommonJS one-pass ──────────────────────────────────────
function validateNodeCommonJsPlan(repoRoot, request, hardProblems, moveMeta) {
  if (!/\.(js|mjs|cjs)$/.test(request.sourceFile || '')) return false;
  let sourceText = null;
  try { sourceText = fs.readFileSync(path.join(repoRoot, request.sourceFile), 'utf8'); }
  catch { /* unreadable → advisory only, fall through */ }
  if (sourceText == null || !looksLikeNodeCommonJsModule(sourceText)) return false;

  const built = buildNodeModuleOnePassChanges(
    sourceText, request.sourceFile,
    request.moves.map((m) => ({ newFile: m.newFile, symbols: m.symbols || [] })),
    repoRoot,
  );
  if (built.ok) {
    for (const _m of request.moves)
      moveMeta.push({ sharedDeps: [], neededImports: [], nodeModuleApplyOk: true });
  } else {
    hardProblems.push(`${request.sourceFile}: ${built.reason}`);
    for (const _m of request.moves)
      moveMeta.push({ sharedDeps: [], neededImports: [] });
  }
  return true;
}

// ── Strategy 2: Flask blueprint one-pass ────────────────────────────────────
function validateFlaskBlueprintPlan(repoRoot, request, hardProblems, moveMeta) {
  if (process.env.AGENT_MANAGER_DECOMPOSE_BLUEPRINT === 'false') return false;
  if (!/\.py$/.test(request.sourceFile || '')) return false;
  if (!request.moves.length) return false;
  if (!request.moves.every((m) => m.kind === 'flask-blueprint' && m.blueprint)) return false;

  let sourceText = null;
  try { sourceText = fs.readFileSync(path.join(repoRoot, request.sourceFile), 'utf8'); }
  catch { /* unreadable → advisory only */ }

  if (sourceText != null) {
    const built = buildBlueprintOnePassChanges(
      sourceText, request.sourceFile,
      request.moves.map((m) => ({ newFile: m.newFile, blueprint: m.blueprint, symbols: m.symbols || [] })),
    );
    if (built.ok) {
      for (const _m of request.moves)
        moveMeta.push({ sharedDeps: [], neededImports: [], blueprintApplyOk: true });
    } else {
      hardProblems.push(`${request.sourceFile}: ${built.reason}`);
      for (const _m of request.moves)
        moveMeta.push({ sharedDeps: [], neededImports: [] });
    }
  } else {
    for (const _m of request.moves)
      moveMeta.push({ sharedDeps: [], neededImports: [] });
  }
  return true;
}

// ── Strategy 3: Generic per-move validation ───────────────────────────────��─
function validateGenericMoves(repoRoot, request, hardProblems, moveMeta, allMovedSymbols) {
  for (const move of request.moves) {
    const symbols = move.symbols || [];
    const meta = { sharedDeps: [], neededImports: [] };

    if (symbols.length === 0) {
      hardProblems.push(`${move.newFile}: move has no symbols`);
      moveMeta.push(meta);
      continue;
    }

    if (move.kind === 'script-extract') {
      const seCheck = staticCheckScriptExtractMove(repoRoot, request.sourceFile, symbols);
      if (seCheck && seCheck.resolvable) {
        if (!seCheck.ok) {
          hardProblems.push(
            `${move.newFile}: ${seCheck.missing.join(', ')} could not be located ` +
            `as top-level function declarations in ${request.sourceFile}`,
          );
        } else {
          meta.deterministicApplyOk = true;
        }
      }
      moveMeta.push(meta);
      continue;
    }

    const check = staticCheckMove(repoRoot, request.sourceFile, symbols);
    if (check) {
      if (check.missing && check.missing.length) {
        hardProblems.push(
          `${move.newFile}: ${check.missing.join(', ')} not defined at module scope in ${request.sourceFile}`,
        );
      }
      const strays = Object.entries(check.externalRefs || {});
      if (strays.length) {
        hardProblems.push(
          `${move.newFile}: ${strays
            .map(([s, lines]) =>
              `${s} is still referenced elsewhere in ${request.sourceFile} ` +
              `(line(s) ${lines.slice(0, 6).join(', ')})`
            )
            .join('; ')} -- not a self-contained move`,
        );
      }
      meta.sharedDeps = (check.sharedDeps || []).filter((d) => {
        if (d === 'app' && move.kind === 'flask-blueprint') return false;
        return !allMovedSymbols.has(d);
      });
      meta.neededImports = check.neededImports || [];
    }
    moveMeta.push(meta);
  }
}

// ── Thin dispatcher (replaces the old 118-line validatePlan) ───────────────
function validatePlan(repoRoot, request) {
  const hardProblems = [];
  const moveMeta = [];
  const allMovedSymbols = new Set();
  for (const m of request.moves)
    for (const s of (m.symbols || [])) allMovedSymbols.add(s);

  if (validateNodeCommonJsPlan(repoRoot, request, hardProblems, moveMeta))
    return { ok: hardProblems.length === 0, hardProblems, moveMeta };
  if (validateFlaskBlueprintPlan(repoRoot, request, hardProblems, moveMeta))
    return { ok: hardProblems.length === 0, hardProblems, moveMeta };

  validateGenericMoves(repoRoot, request, hardProblems, moveMeta, allMovedSymbols);
  return { ok: hardProblems.length === 0, hardProblems, moveMeta };
}
```

Benefits:
Each strategy becomes independently unit-testable: `validateNodeCommonJsPlan` can be tested with a mock `buildNodeModuleOnePassChanges` without touching the blueprint or generic paths, and vice-versa. Adding a fourth strategy (e.g. `validateRustCratePlan`) is a new ~25-line function plus one `if` line in the dispatcher, not a 118→150-line edit. The top-level function now reads as "try A, try B, else C" in 15 lines, making the three-way mutual-exclusion obvious at a glance. The extraction is mechanical — every branch, gate, and result-push is preserved verbatim — so there is no behaviour change.

### AC-175 · Decompose `callOnce` into testable pipeline stages
Strength: Strong
Files: src/claude-client.js
Snippet:
```
}

async function callOnce({ prompt, model, effort, maxTurns = 1, allowedTools, permissionMode = 'dontAsk', cwd, timeoutMs, sandbox, resume, addDirs, allowSideFindings = true, allowAmplification = false, conceptId = null }) {
  assertSubscriptionAuthAvailable();
  // cwd lets a caller run this against a real project directory instead of the
  // isolated scratch dir -- e.g. the dashboard's Discuss sessions (2026-08-17, brain-
  // dump entry: "Claude in the agent-manager has no access to... the system it's
  // housed inside") pass the active project's repoRoot here alongside a read-only
  // allowedTools list, so Read/Grep/Glob actually resolve real files instead of an
  // empty directory. Falls back to CLAUDE_CWD (the isolated scratch dir) for every
  // caller that doesn't explicitly ask for this -- the existing, safer default.
  const workDir = cwd || CLAUDE_CWD;
  fs.mkdirSync(workDir, { recursive: true });

  // Pipeline-wide side-finding capture (2026-09-05, see side-finding.js's own header) --
  // same treatment as local-client.js's callOnce(), the sibling chokepoint.
  let effectivePrompt = allowSideFindings ? injectSideFindingInstruction(prompt) : prompt;
  // Incident Amplification (2026-09-08) -- opt-in, default false, same reasoning as
  // local-client.js's callOnce().
  if (allowAmplification) effectivePrompt = injectAmplificationInstruction(effectivePrompt);
  if (conceptId) effectivePrompt = injectConceptBuildInstruction(effectivePrompt);
  const datedPrompt = `${currentDateLine()}\n\n${effectivePrompt}`;
  // Hard ceiling (see DRAFT_MAX_TURNS above, brain-dump bd-1788707820332) -- a
  // caller asking for 61 turns gets 20, a caller asking for 1 keeps 1.
  const effectiveMaxTurns = Math.min(maxTurns, DRAFT_MAX_TURNS);
  const args = [
    '-p', datedPrompt,
    '--output-format', 'json',
    '--model', model || MODEL,
    '--max-turns', String(effectiveMaxTurns),
    '--permission-mode', permissionMode,
  ];
  // low/medium/high/xhigh/max -- see CLI --effort. Falls back to the CLI's own default
  // (currently "high") when neither the call site nor CLAUDE_EFFORT sets one, same
  // "don't invent a value the caller didn't ask for" reasoning as `model` above.
  const effortLevel = effort || process.env.CLAUDE_EFFORT;
  if (effortLevel) args.push('--effort', effortLevel);
  // No --allowedTools by default -- this module is used as a plain text-completion
  // backend (drafting/critiquing/reviewing prompt text), the same shape as Ollama's
  // /api/generate, not an agentic session. Callers that genuinely need tool access can
  // pass allowedTools explicitly.
  //
  // But leaving tools implicitly available (the CLI's own default) combined with
  // --max-turns 1 is a live footgun, confirmed 2026-08-16: a prompt that reads as a
  // request to go investigate something (a Discuss reply like "please look it up and
  // see if we can find usable information") pushes the model to attempt a built-in
  // tool call (e.g. WebFetch) as its one turn instead of returning text, and the CLI
  // then exits with "Reached maximum number of turns (1)" -- the raw JSON of that
  // error is what a caller (e.g. discuss_sessions.py) sees, with no completion at all.
  // When the caller hasn't opted into tools via allowedTools, explicitly pass
  // `--tools ''` (the CLI's own documented way to disable the built-in set entirely,
  // distinct from --allowedTools which only narrows an already-available set) so a
  // plain-text-completion call can never spend its single turn attempting a tool call
  // it was never meant to have.
  if (allowedTools) {
    args.push('--allowedTools', allowedTools);
  } else {
    args.push('--tools', '');
  }
  if (MAX_BUDGET_USD) args.push('--max-budget-usd', MAX_BUDGET_USD);
  // 2026-08-24 (Chat panel, Brain Dump #153: "very similar to the claude terminal I have
  // been using externally") -- resume threads --resume <sessionId> so the CLI's OWN
  // session storage carries real conversation context forward between calls, instead of
  // every caller having to rebuild a full prompt+transcript from scratch each turn the
  // way discuss_sessions.py's Discuss/Grill callers already do. `result.sessionId` from a
  // prior callOnce() (parsed.session_id, already returned below) is what a caller passes
  // back in here for its next message.
  if (resume) args.push('--resume', resume);

  // addDirs (2026-08-31, system-wide Chat panel): extra directories the `claude` CLI is
  // allowed to Read/Grep/Glob/Edit/Write in, on top of `cwd`. The dashboard's Chat panel
  // roots `cwd` at the agent-manager repo and passes one entry per registered
  // plugin/project repo, so a single conversation can span every codebase the system
  // knows about. Omitted by every other caller -- unchanged single-`cwd` behaviour.
  for (const d of Array.isArray(addDirs) ? addDirs : []) {
    if (d) args.push('--add-dir', d);
  }

  // sandbox (2026-08-24, sandbox.js): only adhoc-agentic-draft.js's agentic call passes
  // this -- the one real Bash-capable, unattended tool-use path in this codebase (see
  // sandbox.js's own header). Every other caller omits it and this branch never runs,
  // completely unchanged behavior. Fails OPEN with a flagged return field, not closed --
  // a hardening layer on top of existing behavior must never become a new single point of
  // failure that halts real work; the caller (adhoc-agentic-draft.js) is responsible for
  // surfacing sandboxUnavailable somewhere visible (task.sandboxUnavailable) rather than
  // silently degrading.
  let execBin = CLAUDE_BIN;
  let execArgs = args;
  let sandboxUnavailable = false;
  if (sandbox) {
    const wrapped = wrapWithSandbox(CLAUDE_BIN, args, { workDir, ...sandbox });
    if (wrapped.available) {
      execBin = wrapped.command;
      execArgs = wrapped.args;
    } else {
      sandboxUnavailable = true;
      console.error('[claude-client] sandbox requested but bwrap is not available on this host -- running unsandboxed (see sandbox.js AGENT_MANAGER_ADHOC_SANDBOX)');
    }
  }

  let stdout;
  try {
    stdout = execFileSync(execBin, execArgs, {
      encoding: 'utf8',
      // timeoutMs lets a caller running a genuinely long agentic session (real
      // Read/Grep/Glob/Edit/Write/Bash investigation + implementation + test runs, not
      // this module's usual single-completion call) override the 300s default sized for
      // that ordinary case -- see adhoc-agentic-draft.js, the first caller that needs it.
      timeout: timeoutMs || REQUEST_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      cwd: workDir,
      env: buildChildEnv(),
    });
  } catch (e) {
    const detail = (e.stdout || e.stderr || e.message || '').toString().slice(0, 2000);
    // Non-zero exit whose output mentions the turn limit (the CLI's own
    // "Reached maximum number of turns (N)" failure, confirmed live 2026-08-16)
    // -- surface it as the same structured error as the JSON-parsed path below
    // so a caller can detect exhaustion uniformly instead of pattern-matching
    // free text.
    if (/(?:max(?:imum)?[ -]?turns?|turn budget)/i.test(detail)) {
      const turnLimitErr = new Error(`Draft turn limit exceeded (claude -p non-zero exit): ${detail}`);
      turnLimitErr.code = 'DRAFT_TURN_LIMIT_EXCEEDED';
      turnLimitErr.maxTurns = effectiveMaxTurns;
      throw turnLimitErr;
    }
    throw new Error(`claude -p failed: ${detail}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (e) {
    throw new Error(`claude -p returned non-JSON output with --output-format json: ${stdout.slice(0, 500)}`);
  }

  // Turn-limit exhaustion detected in the CLI's own JSON (confirmed live shape:
  // stop_reason "tool_use" with num_turns at the requested ceiling, e.g. 31/31 in
  // the 2026-08-23 adhoc-draft failure) -- throw the structured error here,
  // before the caller can mistake an exhausted run for a completed one. This is
  // the code the retry-exclusion consumer (call()'s loop / adhoc-agentic-draft.js)
  // keys on rather than pattern-matching stop_reason/num_turns itself.
  if (
    parsed.stop_reason === 'tool_use' &&
    parsed.num_turns != null &&
    parsed.num_turns >= effectiveMaxTurns
  ) {
    const turnLimitErr = new Error(
      `Draft turn limit exceeded: ${parsed.num_turns} turns reached the ceiling of ${effectiveMaxTurns}.`
    );
    turnLimitErr.code = 'DRAFT_TURN_LIMIT_EXCEEDED';
    turnLimitErr.maxTurns = effectiveMaxTurns;
    turnLimitErr.numTurns = parsed.num_turns;
    throw turnLimitErr;
  }

  return {
    response: parsed.result || '',
    thinking: '',
    // total_cost_usd is a client-side estimate per Claude Code's own docs, and is
    // largely moot here anyway since a subscription-authenticated call isn't billed
    // per-token -- kept only as an observability breadcrumb, never treated as billing.
    costUsd: parsed.total_cost_usd,
    sessionId: parsed.session_id,
    // stopReason/numTurns (2026-08-23, Grimmethy: "Fix: Claude agentic adhoc drafts that
    // exhaust their turn budget get blindly retried at the same budget, wasting real
    // spend") -- previously discarded entirely, even though the raw CLI JSON always
    // carries them (confirmed live in a real failure: stop_reason":"tool_use",
    // "num_turns":31). Without these, a caller has no way to tell "ran out of turns
    // mid-investigation" apart from any other incomplete response -- see
    // adhoc-agentic-draft.js's own turn-exhaustion retry, the first real consumer.
    stopReason: parsed.stop_reason || null,
    numTurns: parsed.num_turns != null ? parsed.num_turns : null,
    sandboxUnavailable,
  };
}
```

Problem:
The `callOnce` function in `src/claude-client.js` is ~174 lines (≈100 lines of executable code plus ~70 lines of historical/rationale comments) and interleaves five independently-testable responsibilities: prompt-injection string assembly, CLI argument construction with 7+ optional flags and non-obvious interactions (`allowedTools` vs `--tools ''`, `effort` fallback chain), sandbox binary/args wrapping, synchronous process execution with two distinct turn-limit detection paths (non-zero exit regex *and* JSON `stop_reason`), and final result-shaping into the module's return contract. Because all five live in one body, a caller who wants to unit-test a single concern—e.g. "does the arg builder emit `--tools ''` when `allowedTools` is absent?"—must mock `execFileSync`, `fs.mkdirSync`, the sandbox wrapper, and three prompt injectors. Every new CLI flag, new injection type, or new error class forces a reader to hold the entire body in working memory to verify a sibling branch wasn't broken.

Solution:
Extract three pure or near-pure helpers from the top of `callOnce` so the remaining body becomes a ~50-line linear pipeline where each step is a named call. The extracted pieces are: (1) `buildPrompt` — applies side-finding / amplification / concept-build injections and prepends the date line, returning a string; (2) `buildArgs` — assembles the CLI argument array from the options object, handling the `allowedTools`/`--tools ''` branch, the `effort` env fallback, and the `addDirs` loop, returning `{ args, effectiveMaxTurns }`; (3) `detectTurnLimit` — takes the parsed JSON and the effective ceiling, returns a tagged `Error` or `null`, unifying the two turn-limit detection paths into one function. The sandbox-wrapping block and the `execFileSync` call stay inline in `callOnce` because they are inherently side-effectful and short. The historical comments move to the headers of the extracted helpers or a module-level doc block so institutional knowledge is preserved.

```js
// ── extracted: pure, no I/O ──────────────────────────────────────────
function buildPrompt(prompt, { allowSideFindings = true, allowAmplification = false, conceptId = null }) {
  let p = allowSideFindings ? injectSideFindingInstruction(prompt) : prompt;
  if (allowAmplification) p = injectAmplificationInstruction(p);
  if (conceptId) p = injectConceptBuildInstruction(p);
  return `${currentDateLine()}\n\n${p}`;
}

function buildArgs({ model, effort, maxTurns, permissionMode, allowedTools, resume, addDirs }) {
  const effectiveMaxTurns = Math.min(maxTurns, DRAFT_MAX_TURNS);
  const args = [
    '-p', '', // placeholder; caller splices in buildPrompt result
    '--output-format', 'json',
    '--model', model || MODEL,
    '--max-turns', String(effectiveMaxTurns),
    '--permission-mode', permissionMode,
  ];
  const effortLevel = effort || process.env.CLAUDE_EFFORT;
  if (effortLevel) args.push('--effort', effortLevel);
  if (allowedTools) { args.push('--allowedTools', allowedTools); }
  else { args.push('--tools', ''); }
  if (MAX_BUDGET_USD) args.push('--max-budget-usd', MAX_BUDGET_USD);
  if (resume) args.push('--resume', resume);
  for (const d of Array.isArray(addDirs) ? addDirs : []) {
    if (d) args.push('--add-dir', d);
  }
  return { args, effectiveMaxTurns };
}

// ── extracted: turn-limit detection (deduplicated) ───────────────────
function detectTurnLimit(parsed, effectiveMaxTurns) {
  if (parsed.stop_reason === 'tool_use' &&
      parsed.num_turns != null &&
      parsed.num_turns >= effectiveMaxTurns) {
    const err = new Error(
      `Draft turn limit exceeded: ${parsed.num_turns} turns reached the ceiling of ${effectiveMaxTurns}.`
    );
    err.code = 'DRAFT_TURN_LIMIT_EXCEEDED';
    err.maxTurns = effectiveMaxTurns;
    err.numTurns = parsed.num_turns;
    return err;
  }
  return null;
}

// ── refactored callOnce: linear pipeline, each step named ────────────
async function callOnce(opts) {
  assertSubscriptionAuthAvailable();
  const workDir = opts.cwd || CLAUDE_CWD;
  fs.mkdirSync(workDir, { recursive: true });

  const datedPrompt = buildPrompt(opts.prompt, opts);
  const { args, effectiveMaxTurns } = buildArgs(opts);
  args[1] = datedPrompt; // splice in the prompt (index 1 = value of '-p')

  // sandbox wrapping (unchanged logic, ~12 lines)
  let execBin = CLAUDE_BIN, execArgs = args, sandboxUnavailable = false;
  if (opts.sandbox) { /* …same wrapWithSandbox block… */ }

  // execute
  let stdout;
  try {
    stdout = execFileSync(execBin, execArgs, { /* …same options… */ });
  } catch (e) {
    const detail = (e.stdout || e.stderr || e.message || '').toString().slice(0, 2000);
    if (/(?:max(?:imum)?[ -]?turns?|turn budget)/i.test(detail)) {
      const err = new Error(`Draft turn limit exceeded (claude -p non-zero exit): ${detail}`);
      err.code = 'DRAFT_TURN_LIMIT_EXCEEDED';
      err.maxTurns = effectiveMaxTurns;
      throw err;
    }
    throw new Error(`claude -p failed: ${detail}`);
  }

  // parse + validate
  let parsed;
  try { parsed = JSON.parse(stdout); }
  catch { throw new Error(`claude -p returned non-JSON output: ${stdout.slice(0, 500)}`); }

  const turnErr = detectTurnLimit(parsed, effectiveMaxTurns);
  if (turnErr) throw turnErr;

  return {
    response: parsed.result || '',
    thinking: '',
    costUsd: parsed.total_cost_usd,
    sessionId: parsed.session_id,
    stopReason: parsed.stop_reason || null,
    numTurns: parsed.num_turns != null ? parsed.num_turns : null,
    sandboxUnavailable,
  };
}
```

Benefits:
Each extracted helper is independently unit-testable with zero mocking of `execFileSync`, `fs`, or the sandbox layer: `buildArgs({ allowedTools: undefined, … })` returns an array you can assert on directly; `buildPrompt("hi", { allowAmplification: true })` returns a string; `detectTurnLimit({ stop_reason: 'tool_use', num_turns: 5 }, 5)` returns a tagged error. Adding a new CLI flag becomes a one-line change inside `buildArgs` covered by its own test, rather than a surgical edit inside a 174-line body where a missed `else` branch for `--tools ''` would be easy to overlook. Reviewers can approve or reject each helper in isolation, and the `callOnce` body reads as a five-step pipeline whose intent is visible at a glance.

### AC-176 · Decompose reconcile() into four single-responsibility helpers
Strength: Strong
Files: src/task-log-reconcile.js
Snippet:
```
}

function reconcile({ pipelineDir, repoRoot, argv = [], fetchFn, commitCountFn } = {}) {
  const report = argv.includes('--report');
  const reclassify = argv.includes('--reclassify');
  const backfill = argv.includes('--backfill') || reclassify;
  const dryRun = argv.includes('--dry-run');
  // 2026-09-08, Grimmethy: root-caused live a false "abandoned -- branch gone, work
  // lost" verdict on TWO separate, genuinely still-open agent/<id> branches. Both were
  // real, reviewed, tested work -- confirmed alive on origin the whole time -- but this
  // routine tick had never fetched, so buildShipContext()'s git for-each-ref only ever
  // saw whatever refs/remotes/origin/agent/* happened to already be cached locally,
  // which one sibling apply's own git operations on this SAME shared repoRoot can
  // perturb between ticks (confirmed: one of the two read correctly as pending-merge on
  // one tick, then flipped to abandoned 17 minutes later with no merge in between).
  // `abandoned` is a STABLE_TERMINAL_STAGE -- once wrong, it never self-heals. Fetch is
  // now unconditional on every tick (still cheap/bounded/best-effort, same as before) so
  // the routine path is never working from a staler view of origin than a --backfill run
  // would have used. `--no-fetch` is the explicit opt-out for a sandboxed/offline run
  // that wants to trust local refs on purpose.
  const doFetch = !argv.includes('--no-fetch');
  const doneDir = path.join(pipelineDir, 'queue', 'done');
  // Under --reclassify, records already closed as `noop` are re-resolved (a FALSE-POSITIVE
  // dismissal recorded before the `dismissed` stage existed). `abandoned` reopens too, as
  // of the same 2026-09-08 fix above -- a wrong "work lost" verdict deserves the same
  // audit-triggered correction path noop already had; re-resolving it now runs against a
  // freshly-fetched ctx, so a genuinely still-open branch reclassifies correctly instead
  // of being re-confirmed as lost by the same stale-ref bug that produced it.
  const allowReopenFrom = reclassify ? new Set(['noop', 'abandoned']) : undefined;

  if (doFetch && repoRoot) {
    const fetch = fetchFn || (() => execFileSync('git', ['-C', repoRoot, 'fetch', 'origin', '--quiet'], { stdio: 'ignore', timeout: 60000 }));
    try { fetch(); } catch { /* offline -- use local refs */ }
  }

  const state = loadState(pipelineDir);
  const ctx = repoRoot ? buildShipContext(repoRoot) : null;

  if (shipContextLooksBroken(ctx, { repoRoot, commitCountFn })) {
    console.error(`[task-log-reconcile] onMainIds is empty despite origin/${ctx.mainBranch} having real merge history -- buildShipContext likely failed silently (see task-disposition.js's own maxBuffer fix). Skipping this reconcile pass entirely rather than risk a false merged/abandoned verdict; will retry next tick.`);
    return { scanned: 0, resolved: 0, merged: 0, 'applied-direct': 0, filed: 0, dismissed: 0, noop: 0, 'pending-merge': 0, abandoned: 0, errors: 0, skippedReason: 'onMainIds-empty' };
  }

  const summary = { scanned: 0, resolved: 0, merged: 0, 'applied-direct': 0, filed: 0, dismissed: 0, noop: 0, 'pending-merge': 0, abandoned: 0, errors: 0 };
  const pendingList = [];
  const abandonedList = [];

  for (const { id, file } of candidateRecords(doneDir, { backfill, state })) {
    const record = readJson(file);
    if (record === null) { summary.errors += 1; continue; }
    summary.scanned += 1;

    let outcome;
    try {
      outcome = resolveDisposition(record, { repoRoot, ctx, allowReopenFrom, pipelineDir });
    } catch (err) {
      console.error(`task-log-reconcile: resolve failed for ${id}: ${err.message}`);
      summary.errors += 1;
      continue;
    }
    if (!outcome) {
      // Stable states that need no further work: already carries a non-pending terminal
      // event, OR the record was never applied at all (a blocked / needs-clarification task
      // that reached done/). Remember either so it is not re-read every tick -- without this
      // the ~2000 never-applied done records get a full readdir+parse pass forever.
      const tail = Array.isArray(record.history) && record.history[record.history.length - 1];
      const closed = tail && STABLE_TERMINAL_STAGES.has(tail.stage);
      if (closed || !lastAppliedEvent(record.history)) {
        state.resolvedIds.add(id); state.pendingIds.delete(id);
      }
      continue;
    }

    const tail = record.history[record.history.length - 1];
    // Nothing to append when the resolved stage already IS the tail: the pending-merge
    // re-check, and (under --reclassify) a noop record that stays noop because its verdict
    // was inconclusive, not a false positive.
    const tailUnchanged = tail && tail.stage === outcome.stage;
    if (!tailUnchanged && !dryRun) {
      appendHistoryEvent(record, outcome.stage, outcome.detail);
      record.terminalDisposition = outcome.stage;
      if (outcome.stage === 'merged' && !record.mergedAt) {
        record.mergedAt = new Date().toISOString();
        record.mergedAtSource = 'task-log-reconcile';
      }
      if ((outcome.stage === 'merged' || outcome.stage === 'applied-direct')
        && (record.source === 'pipeline_self_audit' || record.source === 'pipeline_forensics_fix')) {
        const req = deriveAmplificationRequestFromFix(record);
        if (req) {
          try {
            runAmplificationSweep({
              rootCauseSummary: req.rootCauseSummary, query: req.query, excludeFiles: req.excludeFiles,
              root: repoRoot, pipelineDir, source: record.source, taskId: record.id, stage: 'task-log-reconcile',
            });
          } catch (e) { /* best-effort -- never break reconcile over an amplification sweep */ }
        }
      }
      try {
        fs.writeFileSync(file, JSON.stringify(record, null, 2));
      } catch (err) {
        console.error(`task-log-reconcile: write failed for ${id}: ${err.message}`);
        summary.errors += 1;
        continue;
      }
    }

    if (!tailUnchanged) { summary.resolved += 1; summary[outcome.stage] = (summary[outcome.stage] || 0) + 1; }
    if (outcome.stage === 'pending-merge') {
      state.pendingIds.add(id); state.resolvedIds.delete(id);
      pendingList.push(`${record.id} -- ${outcome.detail}`);
    } else {
      state.resolvedIds.add(id); state.pendingIds.delete(id);
      if (outcome.stage === 'abandoned') abandonedList.push(`${record.id} -- ${outcome.detail}`);
    }
  }

  if (!dryRun) saveState(pipelineDir, state);

  if (report) {
    if (pendingList.length) {
      console.error(`\n[task-log-reconcile] ${pendingList.length} task(s) PENDING MERGE (agent/<id> branch ahead of main):`);
      for (const l of pendingList) console.error(`  ${l}`);
    }
    if (abandonedList.length) {
      console.error(`\n[task-log-reconcile] ${abandonedList.length} task(s) ABANDONED (applied, branch gone, not on main -- work lost):`);
      for (const l of abandonedList) console.error(`  ${l}`);
    }
    if (!pendingList.length && !abandonedList.length) console.error('[task-log-reconcile] no pending-merge or abandoned tasks this pass.');
  }

  return summary;
}
```

Problem:
The `reconcile` function in `src/task-log-reconcile.js` is approximately 130 lines (roughly 100 lines of executable code after stripping the 2026-09-08 root-cause comment block and the `--reclassify` rationale). It interleaves four separable concerns: (1) deriving a config object from `argv` flags, (2) the per-record resolution loop with stable-state checking and history bookkeeping, (3) a fire-and-forget amplification sweep guarded by a compound stage-and-source predicate, and (4) a pure stdout report. None of these four pieces can be unit-tested in isolation without mocking the entire pipeline (fs, git fetch, `resolveDisposition`), and the amplification block—already the most likely site of future growth (new sources, new sweep parameters)—is buried three levels deep inside the loop body, making it easy to miss during review.

Solution:
Extract four small, clearly-named helpers and reduce `reconcile` to an orchestration shell of roughly 70 lines. `parseReconcileConfig(argv)` returns the five booleans plus the `allowReopenFrom` set; `isStableOrNeverApplied(record)` encapsulates the terminal-stage / never-applied predicate; `maybeRunAmplification(record, outcome, repoRoot, pipelineDir)` owns the guard predicates, the `deriveAmplificationRequestFromFix` call, and the best-effort `try/catch`; `printReconcileReport(pendingList, abandonedList)` handles all `console.error` output. The existing explanatory comments (root-cause block, `--reclassify` rationale) stay attached to the call sites or move to `parseReconcileConfig` so the "why" is preserved.

```diff
--- a/src/task-log-reconcile.js
+++ b/src/task-log-reconcile.js
@@ -185,6 +185,36 @@
+function parseReconcileConfig(argv) {
+  const report     = argv.includes('--report');
+  const reclassify = argv.includes('--reclassify');
+  const backfill   = argv.includes('--backfill') || reclassify;
+  const dryRun     = argv.includes('--dry-run');
+  const doFetch    = !argv.includes('--no-fetch');
+  const allowReopenFrom = reclassify ? new Set(['noop', 'abandoned']) : undefined;
+  return { report, reclassify, backfill, dryRun, doFetch, allowReopenFrom };
+}
+
+function isStableOrNeverApplied(record) {
+  const tail = Array.isArray(record.history) && record.history[record.history.length - 1];
+  return (tail && STABLE_TERMINAL_STAGES.has(tail.stage)) || !lastAppliedEvent(record.history);
+}
+
+function maybeRunAmplification(record, outcome, repoRoot, pipelineDir) {
+  if (outcome.stage !== 'merged' && outcome.stage !== 'applied-direct') return;
+  if (record.source !== 'pipeline_self_audit' && record.source !== 'pipeline_forensics_fix') return;
+  const req = deriveAmplificationRequestFromFix(record);
+  if (!req) return;
+  try {
+    runAmplificationSweep({
+      rootCauseSummary: req.rootCauseSummary,
+      query: req.query,
+      excludeFiles: req.excludeFiles,
+      root: repoRoot,
+      pipelineDir,
+      source: record.source,
+      taskId: record.id,
+      stage: 'task-log-reconcile',
+    });
+  } catch { /* best-effort: never block reconciliation on sweep failure */ }
+}
+
+function printReconcileReport(pendingList, abandonedList) {
+  if (pendingList.length) {
+    console.error(`\n[task-log-reconcile] ${pendingList.length} task(s) PENDING MERGE (agent/<id> branch ahead of main):`);
+    for (const l of pendingList) console.error(`  ${l}`);
+  }
+  if (abandonedList.length) {
+    console.error(`\n[task-log-reconcile] ${abandonedList.length} task(s) ABANDONED (applied, branch gone, not on main -- work lost):`);
+    for (const l of abandonedList) console.error(`  ${l}`);
+  }
+  if (!pendingList.length && !abandonedList.length) {
+    console.error('[task-log-reconcile] no pending-merge or abandoned tasks this pass.');
+  }
+}
+
 function reconcile({ pipelineDir, repoRoot, argv = [], fetchFn, commitCountFn } = {}) {
-  const report     = argv.includes('--report');
-  const reclassify = argv.includes('--reclassify');
-  const backfill   = argv.includes('--backfill') || reclassify;
-  const dryRun     = argv.includes('--dry-run');
-  // …(2026-09-08 root-cause comment block, ~15 lines)
-  const doFetch    = !argv.includes('--no-fetch');
+  const { report, reclassify, backfill, dryRun, doFetch, allowReopenFrom } = parseReconcileConfig(argv);
   const doneDir = path.join(pipelineDir, 'queue', 'done');
-  // …(--reclassify rationale comment, ~5 lines)
-  const allowReopenFrom = reclassify ? new Set(['noop', 'abandoned']) : undefined;
 
   if (doFetch && repoRoot) { /* …unchanged… */ }
   const state = loadState(pipelineDir);
@@ loop body @@
-    if (!outcome) {
-      const tail = Array.isArray(record.history) && record.history[record.history.length - 1];
-      const closed = tail && STABLE_TERMINAL_STAGES.has(tail.stage);
-      if (closed || !lastAppliedEvent(record.history)) {
+    if (!outcome) {
+      if (isStableOrNeverApplied(record)) {
         state.resolvedIds.add(id);
         state.pendingIds.delete(id);
       }
       continue;
@@
-      if ((outcome.stage === 'merged' || outcome.stage === 'applied-direct')
-          && (record.source === 'pipeline_self_audit' || record.source === 'pipeline_forensics_fix')) {
-        const req = deriveAmplificationRequestFromFix(record);
-        if (req) {
-          try {
-            runAmplificationSweep({ … });
-          } catch (e) { /* … */ }
-        }
-      }
+      maybeRunAmplification(record, outcome, repoRoot, pipelineDir);
@@
-  if (report) {
-    if (pendingList.length) { … }
-    if (abandonedList.length) { … }
-    if (!pendingList.length && !abandonedList.length) { … }
-  }
+  if (report) printReconcileReport(pendingList, abandonedList);
 
   return summary;
 }
```

Benefits:
Each helper is independently unit-testable: `isStableOrNeverApplied` can be exercised against fixture records with no fs or git mocking; `maybeRunAmplification` can be tested with a stubbed `runAmplificationSweep` to verify the guard predicates and confirm it never throws; `parseReconcileConfig` is a pure function of `argv`; `printReconcileReport` can be tested by capturing `console.error`. Adding a new amplification source or sweep variant touches only the 12-line `maybeRunAmplification` body rather than the middle of a 55-line loop. A reviewer reading the loop can skip the named call and trust the contract, reducing cognitive load. The main `reconcile` function drops to roughly 70 lines of orchestration, well under any length threshold, with zero behavioural change.

### AC-177 · Decompose `api_task_requeue` into testable helpers
Strength: Strong
Files: python/dashboard/routes/task.py
Snippet:
```

@task_bp.route("/api/task/<state>/<task_id>/requeue", methods=["POST"])
def api_task_requeue(state, task_id):
    """Manual requeue (Job Status > Blocked/Needs Clarification/Done tabs, per-row button; also the Brain Dump
    tab's "Reopen" action on an archived entry's badge): moves the task back to pending/,
    stripped to the same shape a freshly-generated task has -- every drafting/review/apply
    artifact (blockedReason, doneMarker, ornithVotes, planResponse, implementResponse, etc.)
    is dropped, not carried forward. ornithRejectCount resets to 0 deliberately: a manual
    requeue is a deliberate human do-over, not a continuation of the same automatic retry
    cycle queue-watchdog.ps1's Invoke-RejectRetryCheck already runs for review-stage
    rejections (capped at $MaxOrnithRejectRetries=2) -- carrying the old count forward would
    let a manually-requeued task block again after fewer real attempts than a task hitting
    that cap for the first time gets.

    2026-09-06, real incident: a stacked file-decompose sub-task (seq 2 of 5, sharing one
    branch with its 4 siblings -- see file-decompose-to-hub.js) blocked on a sustained
    Ollama infra outage. Its `stacked` field -- {branch, seq, total}, the ONLY thing that
    ties it back to the shared branch and its position in the sequence -- is a TOP-LEVEL
    task field, not part of promptContext, so the "fresh" rebuild below silently dropped it
    on every requeue: a human clicking Requeue on a stuck stacked sub-task would have
    detached it from its hub, breaking the coordination with no error and no visible sign
    anything was wrong until the wiring step later found the branch missing pieces.
    `dependsOn` (also file-decompose-to-hub.js, and consumed by nextAdhocTask's/
    coordinator-sweep.js's dependency gate) is the identical shape -- a top-level field a
    generic reset has no way to know matters.

    2026-09-06, same requeue, second field: `atomic` (also file-decompose-to-hub.js) was
    STILL being dropped by this same allowlist gap even after the stacked/dependsOn fix
    above -- confirmed live, the requeued sub-task's own local-draft.js pre-split check
    (`!task.atomic`, the guard that exists specifically because "a file-decompose child IS
    the output of a decomposition; re-splitting it loops") saw `atomic: undefined` and let
    the model try to decompose it AGAIN, producing a malformed 2-piece split and blocking a
    second time. `noDecompose` (set alongside `atomic` by the same code, currently unread
    elsewhere but the same coordination-field shape) is preserved too rather than assuming
    it stays unused forever. All four preserved explicitly now, when present, rather than
    trusting this allowlist to anticipate every future coordination field one at a time.

    'archived' is a distinct pseudo-state (not a real QUEUE_STATES member) for a task
    api_task_archive moved to done/_archived_no_action/ -- _task_state_index reports it as
    'archived', not 'done', so this must be handled as a separate lookup path rather than
    falling through to state_dir/task_id.json, which would 404 (real gap found 2026-08-17
    auditing the "always reversible" promise: an archived item couldn't actually be
    un-archived through the UI before this). 2026-08-24: also checks done-archive.js's own
    dated month buckets (queue/done/_archived/<YYYY-MM>/) -- a task the AUTOMATIC daily
    archive pass moved there is just as "archived" and must be just as requeueable as one a
    human moved to _archived_no_action/ by hand; see done-archive.js's own header on the
    same "always reversible" promise this endpoint already exists to uphold."""
    from app import _record_manual_requeue, _repeated_blocker_match, get_active_repo_root, logger, queue_dir, read_json_safe
    if state not in ("blocked", "needs-clarification", "done", "archived"):
        abort(400, description="only a blocked, needs-clarification, done, or archived task can be requeued")
    qdir = queue_dir()
    if not qdir:
        abort(404)
    if state == "archived":
        src = qdir / "done" / "_archived_no_action" / f"{task_id}.json"
        if not src.is_file():
            archived_root = qdir / "done" / "_archived"
            if archived_root.is_dir():
                for month_dir in archived_root.iterdir():
                    if not month_dir.is_dir():
                        continue
                    candidate = month_dir / f"{task_id}.json"
                    if candidate.is_file():
                        src = candidate
                        break
    else:
        src = qdir / state / f"{task_id}.json"
    data = read_json_safe(src)
    if not data:
        abort(404)

    # A needs-clarification task can be sent straight back for a fresh draft -- but only a NON-adhoc one. An adhoc-shaped task lives in
    # queue/adhoc/ (nextAdhocTask only scans there), and this route writes to pending/, which would silently orphan it; those have their
    # own /resolve and /answer routes below. (2026-09-20: a candidate-fulfillment task exhausted its retries on failures that were then
    # fixed, and the only way back was moving its file to blocked/ by hand.)
    if state == "needs-clarification" and (
        data.get("domain") == "adhoc" or data.get("source") in ("manual", "derived_task")
    ):
        abort(400, description=(
            "this is an adhoc-shaped task -- send it back with the file-path picker (/resolve) or the answer box (/answer), "
            "which put it where the adhoc lane claims it; a plain requeue would strand it in pending/"
        ))

    if state in ("blocked", "needs-clarification") and not (request.get_json(silent=True) or {}).get("force"):
        repeat = _repeated_blocker_match(data)
        if repeat:
            abort(409, description=(
                "This task's rejection looks like the same underlying problem as an "
                f"earlier attempt: \"{repeat[:220]}\" -- redrafting alone hasn't fixed "
                "this before and likely won't now without a real change. Diagnose the "
                "actual root cause first (or confirm you already have), then requeue "
                "again to proceed anyway."
            ))

    # If this task was already applied to a branch that never merged (task-disposition.js's
    # 'pending-merge' -- an agent/<id> branch exists, ahead of main, unmerged), a requeue is
    # about to redo the same work from scratch on a FRESH branch, so the old one is now
    # abandoned, not merely forgotten. Without this, this endpoint silently orphaned the
    # prior branch: it stayed pushed to GitHub, unmerged, with no PR and no record anywhere
    # that a later attempt superseded it. Confirmed live 2026-09-13:
    # adhoc-add-spec-comment-at-call-site-in-src-local-draft-js-1789232601161-1's
    # forbidden-path-gate-blocked branch sat dangling until a human noticed and deleted it
    # by hand. Guarded on terminalDisposition != 'merged' so a task record that (rarely)
    # reached done/ with its branch already merged is never touched.
    if data.get("terminalDisposition") != "merged":
        applied_branch = None
        for ev in reversed(data.get("history") or []):
            if isinstance(ev, dict) and ev.get("stage") == "applied" and ev.get("detail"):
                applied_branch = ev["detail"]
                break
        if applied_branch:
            from app import _invalidate_branch_cache, _run_git
            repo_root = get_active_repo_root()
            repo_root = Path(repo_root) if repo_root else None
            if repo_root:
                try:
                    _run_git(["push", "origin", "--delete", applied_branch], repo_root)
                    from branch_removals import record_branch_removal
                    record_branch_removal(qdir, applied_branch, "superseded-by-requeue", task_id=task_id,
                                          detail=f"requeued from {state}/", actor="dashboard-requeue")
                except RuntimeError as e:
                    # Non-fatal, same reasoning as api_git_merge_branch's own post-merge
                    # branch delete -- already gone, never actually pushed, or a transient
                    # network error are all fine; the requeue itself must not fail here.
                    logger.warning(
                        "Non-fatal: could not delete superseded branch %r for requeued task %r: %s",
                        applied_branch, task_id, e,
                    )
                _invalidate_branch_cache()
            abandon_iso = datetime.now(timezone.utc).isoformat()
            abandon_detail = f"superseded by a manual requeue from {state}/; prior branch {applied_branch} deleted"
            data.setdefault("history", []).append({
                "stage": "abandoned", "at": abandon_iso, "detail": abandon_detail,
            })
            data["terminalDisposition"] = "abandoned"
            # NOT closing out task-logs/<id>.json here (contrast api_git_merge_branch's
            # 'merged' handling): that file is committed only on the task's OWN branch, and
            # for an unmerged branch it was never on <main> to begin with -- there is
            # nothing on disk in this checkout to update. task-log-reconcile.js's own
            # 'abandoned' disposition (see task-disposition.js's header) has the identical
            # scope: it marks the queue/ record, it does not retroactively rescue a
            # never-merged branch's task-log onto main.

    pending_dir = qdir / "pending"
    pending_dir.mkdir(parents=True, exist_ok=True)
    dest = pending_dir / f"{task_id}.json"
    if dest.exists():
        abort(409, description=f"'{task_id}' already has a task in pending/")

    now_iso = datetime.now(timezone.utc).isoformat()
    # history must never be replaced -- it's the one append-only, complete log of
    # everything that happened to this task (see task-history.js and AGENTS.md's task-log
    # section), and a manual requeue is exactly the kind of step whose OWN reason (plus
    # whatever blockedReason/priorRejectionFeedback drove it) needs to survive in that log,
    # not vanish the moment the task starts its next draft cycle. Root-caused live
    # 2026-09-12: this endpoint used to stamp a brand-new one-entry array here, discarding
    # every prior event -- including the real blockedReason a `blocked` history event
    # already carried -- for observability-fix-ac-158 and others, so the ONLY trace left
    # of why a task ever blocked was this note's bare "manually requeued from blocked/".
    old_history = data.get("history")
    history = list(old_history) if isinstance(old_history, list) else []
    history.append({
        "stage": "requeued",
        "at": now_iso,
        "note": f"manually requeued from {state}/",
        # The exact fields a fresh rebuild used to drop silently -- carried into the log
        # entry itself so they're never lost even though the rebuilt task below won't
        # carry them forward as live working state.
        "blockedReasonAtRequeue": data.get("blockedReason"),
        "priorRejectionFeedbackAtRequeue": data.get("priorRejectionFeedback"),
    })
    fresh = {
        "id": data.get("id", task_id),
        "domain": data.get("domain"),
        "source": data.get("source"),
        "title": data.get("title"),
        "promptContext": data.get("promptContext"),
        "status": "pending",
        "createdAt": data.get("createdAt", now_iso),
        "history": history,
    }
    # Coordination fields (see this endpoint's own docstring) -- never part of the
    # drafting/review/apply history this reset is meant to clear, so always carried over
    # verbatim when present rather than silently dropped.
    if "stacked" in data:
        fresh["stacked"] = data["stacked"]
    if "dependsOn" in data:
        fresh["dependsOn"] = data["dependsOn"]
    if "atomic" in data:
        fresh["atomic"] = data["atomic"]
    if "noDecompose" in data:
        fresh["noDecompose"] = data["noDecompose"]
    dest.write_text(json.dumps(fresh, indent=2), encoding="utf-8")
    src.unlink()
    _record_manual_requeue(data, reason_hint=f"manually requeued from {state}/", requeue_writer="operator-manual")
    return jsonify({"id": task_id, "requeued": True})
```

Problem:
The 194-line `api_task_requeue` route bundles four concerns that each carry independent failure modes and external dependencies: archived-source resolution with a month-bucket fallback search, two pre-requeue guard clauses, a non-fatal git `push --delete` branch-cleanup block with its own `try/except` and in-place mutation of `data["history"]` and `data["terminalDisposition"]`, and a task-rebuild step whose coordination-field allowlist has already caused two production incidents. Because the branch-cleanup logic is inlined between the guards and the `write_text` call, a unit test for "requeue correctly deletes the old branch" must mock file I/O, the adhoc guard, the blocker check, and the rebuild simultaneously. The coordination-field allowlist (stacked, dependsOn, atomic, noDecompose) is buried between a git block and a `write_text` call, making it invisible to a reviewer scanning for "which fields survive a requeue."

Solution:
Extract three module-level helpers above the route and reduce the route body to a ~35-line linear orchestration (validate → resolve → guard → cleanup → rebuild → persist → respond). The two guard clauses stay inline because they are 5–8-line pure aborts tightly coupled to `state`. The concrete change:

```python
# --- extracted helpers (same module, above the route) ---

def _resolve_requeue_source(qdir: Path, state: str, task_id: str) -> Path:
    """Locate the task file. Archived tasks may live in _archived_no_action/
    or in a dated month bucket under _archived/."""
    if state == "archived":
        src = qdir / "done" / "_archived_no_action" / f"{task_id}.json"
        if not src.is_file():
            archived_root = qdir / "done" / "_archived"
            if archived_root.is_dir():
                for month_dir in archived_root.iterdir():
                    if not month_dir.is_dir():
                        continue
                    candidate = month_dir / f"{task_id}.json"
                    if candidate.is_file():
                        src = candidate
                        break
    else:
        src = qdir / state / f"{task_id}.json"
    return src


def _cleanup_superseded_branch(data: dict, qdir: Path, state: str, task_id: str) -> None:
    """If the task was applied to an unmerged branch, delete that branch and
    record the abandonment. Non-fatal: git/network errors are logged, not raised."""
    if data.get("terminalDisposition") == "merged":
        return
    applied_branch = None
    for ev in reversed(data.get("history") or []):
        if isinstance(ev, dict) and ev.get("stage") == "applied" and ev.get("detail"):
            applied_branch = ev["detail"]
            break
    if not applied_branch:
        return

    from app import _invalidate_branch_cache, _run_git
    repo_root = get_active_repo_root()
    repo_root = Path(repo_root) if repo_root else None
    if repo_root:
        try:
            _run_git(["push", "origin", "--delete", applied_branch], repo_root)
            from branch_removals import record_branch_removal
            record_branch_removal(
                qdir, applied_branch, "superseded-by-requeue",
                task_id=task_id, detail=f"requeued from {state}/",
                actor="dashboard-requeue",
            )
        except RuntimeError as e:
            logger.warning(
                "Non-fatal: could not delete superseded branch %r for requeued task %r: %s",
                applied_branch, task_id, e,
            )
        _invalidate_branch_cache()

    now_iso = datetime.now(timezone.utc).isoformat()
    data.setdefault("history", []).append({
        "stage": "abandoned",
        "at": now_iso,
        "detail": f"superseded by a manual requeue from {state}/; prior branch {applied_branch} deleted",
    })
    data["terminalDisposition"] = "abandoned"


def _build_fresh_requeue(data: dict, task_id: str, state: str, now_iso: str) -> dict:
    """Rebuild the task to its fresh pending shape, preserving history and
    coordination fields (stacked, dependsOn, atomic, noDecompose)."""
    old_history = data.get("history")
    history = list(old_history) if isinstance(old_history, list) else []
    history.append({
        "stage": "requeued",
        "at": now_iso,
        "note": f"manually requeued from {state}/",
        "blockedReasonAtRequeue": data.get("blockedReason"),
        "priorRejectionFeedbackAtRequeue": data.get("priorRejectionFeedback"),
    })
    fresh = {
        "id": data.get("id", task_id),
        "domain": data.get("domain"),
        "source": data.get("source"),
        "title": data.get("title"),
        "promptContext": data.get("promptContext"),
        "status": "pending",
        "createdAt": data.get("createdAt", now_iso),
        "history": history,
    }
    for field in ("stacked", "dependsOn", "atomic", "noDecompose"):
        if field in data:
            fresh[field] = data[field]
    return fresh


# --- the route becomes a short orchestration ---

@task_bp.route("/api/task/<state>/<task_id>/requeue", methods=["POST"])
def api_task_requeue(state, task_id):
    """[docstring unchanged]"""
    from app import _record_manual_requeue, _repeated_blocker_match, get_active_repo_root, logger, queue_dir, read_json_safe

    if state not in ("blocked", "needs-clarification", "done", "archived"):
        abort(400, description="only a blocked, needs-clarification, done, or archived task can be requeued")
    qdir = queue_dir()
    if not qdir:
        abort(404)

    src = _resolve_requeue_source(qdir, state, task_id)
    data = read_json_safe(src)
    if not data:
        abort(404)

    # adhoc guard
    if state == "needs-clarification" and (
        data.get("domain") == "adhoc" or data.get("source") in ("manual", "derived_task")
    ):
        abort(400, description=(
            "this is an adhoc-shaped task -- send it back with the file-path picker (/resolve) "
            "or the answer box (/answer), which put it where the adhoc lane claims it; "
            "a plain requeue would strand it in pending/"
        ))

    # repeated-blocker guard
    if state in ("blocked", "needs-clarification") and not (request.get_json(silent=True) or {}).get("force"):
        repeat = _repeated_blocker_match(data)
        if repeat:
            abort(409, description=(
                f"This task's rejection looks like the same underlying problem as an earlier "
                f"attempt: \"{repeat[:220]}\" -- redrafting alone hasn't fixed this before and "
                "likely won't now without a real change. Diagnose the actual root cause first "
                "(or confirm you already have), then requeue again to proceed anyway."
            ))

    # branch cleanup (non-fatal internally)
    _cleanup_superseded_branch(data, qdir, state, task_id)

    # rebuild & persist
    pending_dir = qdir / "pending"
    pending_dir.mkdir(parents=True, exist_ok=True)
    dest = pending_dir / f"{task_id}.json"
    if dest.exists():
        abort(409, description=f"'{task_id}' already has a task in pending/")

    now_iso = datetime.now(timezone.utc).isoformat()
    fresh = _build_fresh_requeue(data, task_id, state, now_iso)
    dest.write_text(json.dumps(fresh, indent=2), encoding="utf-8")
    src.unlink()
    _record_manual_requeue(data, reason_hint=f"manually requeued from {state}/", requeue_writer="operator-manual")
    return jsonify({"id": task_id, "requeued": True})
```

Benefits:
Each extracted helper becomes independently unit-testable with a temp-dir fixture and one stubbed external call. `_cleanup_superseded_branch` can be tested by asserting the `data` dict mutation and the single `_run_git` invocation without exercising file I/O, the adhoc guard, or the blocker check. `_build_fresh_requeue` makes the coordination-field allowlist a single greppable, testable function whose contract ("which fields survive a requeue") is visible at the call site rather than buried between a git block and a `write_text`. The route body drops to ~35 lines of linear orchestration where each step is a named call, making the control flow and the non-fatal error boundary of the git block immediately legible in code review.

### AC-178 · Decompose renderWorkers into named, testable helpers
Strength: Strong
Files: python/dashboard/static/js/core-ui.js
Snippet:
```
// === true) is skipped, and only when focus is currently inside one of this tab's own
// selects, i.e. the operator is actively mid-choice. The next 5s tick tries again.
async function renderWorkers(isPoll) {
  if (isPoll) {
    const active = document.activeElement;
    if (active && (active.classList.contains('worker-type-select') || active.classList.contains('worker-task-select'))) {
      return;
    }
    // Top up the completed-tasks log with anything newer than what's already loaded --
    // see refreshNewestCompletedTasks's own header note. Only on the real poll cycle,
    // not every action-triggered re-render (assign-task, filter click, expand/collapse).
    await refreshNewestCompletedTasks();
  }
  // run-log vs recent-tasks (2026-09-08, Grimmethy: "This looks like it's only showing
  // fully completed tasks. I want to see a log of every time an agent is run and the
  // outcome of that run."): a drafting worker's real activity includes attempts that
  // never reach a terminal task state at all (a hard OLLAMA_TIMEOUT, mid-GPU-contention,
  // never produces a usable response) -- /api/instances/<id>/run-log surfaces those too,
  // merged with every model_calls row regardless of outcome. reviewer has no equivalent
  // call-level data (review-task.js's majorityVote never calls recordCall, see that
  // route's own docstring) so it keeps the existing terminal-state recent-tasks view.
  const expandedIsWorker = !!(expandedWorkerId && expandedWorkerId.startsWith('worker'));
  const [instances, workerModels, costSummary, recentTasks] = await Promise.all([
    fetchJson('/api/instances'),
    fetchJson('/api/worker-models'),
    fetchJson('/api/models/cost-summary'),
    // Only fetch for whichever card is currently expanded -- no point loading this for
    // every instance on every 5s poll when at most one card shows it at a time.
    expandedWorkerId
      ? fetchJson(`/api/instances/${encodeURIComponent(expandedWorkerId)}/${expandedIsWorker ? 'run-log' : 'recent-tasks'}`)
      : Promise.resolve(null),
  ]);
  // Candidate list for each worker's own "assign task" override dropdown (2026-09-07
  // follow-up, Grimmethy after live-testing the override: "the only tasks I have
  // access to... are pipeline debrief tasks. The task I want, autodecomp, is in
  // drafting. I need access to the full list of available jobs, they should however be
  // whats available for that specific worker type"). Per-instance now, not one shared
  // list: /api/instances/<id>/assignable-tasks tier-filters for THAT lane and also
  // surfaces tasks already claimed by other lanes (queue/drafting/<lane>/), not just
  // queue/pending/ -- a plain worker-model-style shared list can't express either of
  // those. Fetched only for worker-* instances (canAssignTask), in parallel.
  const assignableByInstance = {};
  await Promise.all(instances.filter(canAssignTask).map(async (inst) => {
    try {
      const r = await fetchJson(`/api/instances/${encodeURIComponent(inst.instanceId)}/assignable-tasks`);
      assignableByInstance[inst.instanceId] = r.items || [];
    } catch (e) {
      assignableByInstance[inst.instanceId] = [];
    }
  }));
  const overrides = workerModels.overrides || {};
  // Per-instance cumulative estimated API cost (2026-08-23, "Where else would it make
  // sense to track it?" -> Workers tab): AGENT_MANAGER_INSTANCE_ID is stamped onto every
  // real model_calls row now (see model-stats-client.js's own recordCall) -- keyed here
  // by instanceId so each worker-card can show its own running total, same "estimate,
  // not a bill" framing as the Models tab's own widget.
  const costByInstance = Object.fromEntries((costSummary.byInstance || []).map((i) => [i.instanceId, i.totalCost]));
  const main = document.getElementById('main');
  const fetchedAt = Date.now();
  instances.forEach(i => { i._fetchedAtMs = fetchedAt; });
  instancesForTimers = instances;
  // Clear the optimistic pending-assign marker the moment real data confirms it --
  // either the pin took (currentTaskId now matches) or the operator/pipeline moved on
  // to something else for this instance since (a stale marker pointing at a taskId this
  // instance is no longer even working toward would be actively misleading, worse than
  // no marker at all).
  instances.forEach((inst) => {
    // Any real currentTaskId -- matching the pin (success) or not (moved on to
    // something else meanwhile) -- means the "waiting to pick this up" state is over.
    if (pendingWorkerAssign[inst.instanceId] && inst.currentTaskId) {
      delete pendingWorkerAssign[inst.instanceId];
    }
  });
  const filterBar = `
    <div class="worker-filter-bar" style="margin-bottom:10px; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px">
      <div></div>
      <label style="display:flex; align-items:center; gap:6px; font-size:0.9em; cursor:pointer" title="Stops every automated Claude call pipeline-wide (worker-reasoning's plan pass, adhoc/research's implement calls, review votes) until unchecked -- preserves your subscription's token budget.">
        <input type="checkbox" id="claude-pause-toggle" ${workerModels.claudePaused ? 'checked' : ''}>
        Pause Claude (preserve subscription tokens)
      </label>
    </div>
  `;
  const shown = instances;
  if (instances.length === 0) { main.innerHTML = '<div class="empty">No instances found -- is the pipeline running?</div>'; return; }
  // Preserve scroll position across the full innerHTML replace below -- same isPoll
  // "don't yank state out from under the operator" reasoning as the dropdown guard
  // above, needed here because the completed-tasks log (renderCompletedTasksSection)
  // can push #main well past one screen, and a poll landing mid-scroll would otherwise
  // silently reset the operator back to the top every 5s.
  const scrollY = window.scrollY;
  main.innerHTML = filterBar + (shown.length === 0
    ? '<div class="empty">No workers match this filter.</div>'
    : shown.map(inst => `
    <div class="worker-card clickable" data-instance-id="${escapeAttr(inst.instanceId)}">
      <div class="row">
        <span class="id">${inst.instanceId}</span>
        ${(() => {
          const kind = modelKindForInstance(inst);
          if (!kind) return '';
          const current = overrides[inst.instanceId] || '';
          const optionsFor = (label, values) => values.length
            ? `<optgroup label="${escapeAttr(label)}">${values.map(m => `<option value="${escapeAttr(m.value)}" ${m.value === current ? 'selected' : ''}>${m.label}</option>`).join('')}</optgroup>`
            : '';
          let body;
          if (kind === 'mixed') {
            // Prefixed so local-worker.sh's refresh_active_model can tell which backend
            // was picked -- see that function's own comment for why this is the fix for
            // "reasoning only shows subscription models."
            body = optionsFor('Claude (subscription)', (workerModels.claudeModels || []).map(m => ({ value: `claude:${m}`, label: m })))
              + optionsFor('Local (Ollama)', (workerModels.ollamaModels || []).map(m => ({ value: `ollama:${m}`, label: m })));
          } else {
            body = (workerModels.ollamaModels || []).map(m => `<option value="${escapeAttr(m)}" ${m === current ? 'selected' : ''}>${m}</option>`).join('');
          }
          return `<select class="worker-model-select" data-instance-id="${escapeAttr(inst.instanceId)}" onclick="event.stopPropagation()"><option value="">(default)</option>${body}</select>`;
        })()}
        ${canAssignTask(inst) ? (() => {
          const items = assignableByInstance[inst.instanceId] || [];
          // Grouped by source (task TYPE) so the picker shows "pipeline_debrief (7)"
          // etc first, rather than one flat list where a deep single-type backlog
          // buries everything else (see selectedWorkerTaskType's own header comment).
          const bySource = {};
          items.forEach((t) => {
            const key = t.source || 'unknown';
            (bySource[key] = bySource[key] || []).push(t);
          });
          const sourceKeys = Object.keys(bySource).sort();
          const selectedType = selectedWorkerTaskType[inst.instanceId] || '';
          // Keep the previously-picked type visible even if its bucket happens to be
          // empty on THIS particular poll (its last task just got claimed elsewhere, or
          // this instance's own assignable-tasks fetch above hit its catch and fell back
          // to [] for one cycle) -- 2026-09-07, same complaint as isPoll above: a
          // transient empty bucket used to collapse the whole drill-down back to the
          // type-only picker, which looked identical to "your selection got reset" even
          // though selectedWorkerTaskType was never actually cleared.
          if (selectedType && !sourceKeys.includes(selectedType)) sourceKeys.push(selectedType);
          sourceKeys.sort();
          const typeSelect = `<select class="worker-type-select" data-instance-id="${escapeAttr(inst.instanceId)}" onclick="event.stopPropagation()" title="Assign a specific task to this worker, overriding the automated priority/tier claim order -- includes tasks already claimed by other workers, tier-filtered for this worker type">
            <option value="">(assign a task…)</option>
            ${sourceKeys.map(k => `<option value="${escapeAttr(k)}" ${k === selectedType ? 'selected' : ''}>${escapeHtml(k)} (${(bySource[k] || []).length})</option>`).join('')}
          </select>`;
          if (!selectedType) return typeSelect;
          const tasksOfSelectedType = bySource[selectedType] || [];
          // A native <select> sizes itself to its widest <option> text -- an untruncated
          // task title (adhoc/decompose titles especially routinely run 80-100+ chars)
          // pushed this whole control off the right edge of the worker card (2026-09-07,
          // Grimmethy: "when I open the manual task that has long task names it sets the
          // selector to the size of the largest... names should be truncated"). Truncate
          // what's SHOWN; the option's own `title` attribute (native hover tooltip) and
          // `data-title` (read by setWorkerTask's confirm-dialog text) both still carry
          // the full, untruncated title -- nothing is actually lost, just not rendered
          // into the control's own width.
          const OPTION_LABEL_MAX = 70;
          const truncateLabel = (s) => (s.length > OPTION_LABEL_MAX ? `${s.slice(0, OPTION_LABEL_MAX - 1)}…` : s);
          const optionLabel = (t) => {
            // A hub member leads with its HUB#### slot (2026-09-20) so a hub in progress is recognisable in this list.
            const rawTitle = t.title || t.id;
            const base = t.hub && !/^HUB\d/.test(rawTitle) ? `${hubTag(t.hub)} · ${rawTitle}` : rawTitle;
            // pinnedTo (2026-09-07, Grimmethy: "why do the 2 reasoning workers have
            // different lists? they really should share the same task list") -- a task
            // pending but already pinned to a SIBLING lane (same tier) now shows here
            // too instead of being invisible; picking it just re-pins it to this lane
            // instead (no kill needed, nothing is running on it yet, unlike the
            // "⚠ running on" case below).
            let full = base;
            if (t.location && t.location !== 'pending') full = `⚠ running on ${t.location.replace(/^drafting:/, '')} — ${base}`;
            else if (t.pinnedTo) full = `📌 pinned to ${t.pinnedTo} — ${base}`;
            // premiumPriority (2026-09-07, Grimmethy: "I am getting tired of manually
            // selecting it for the worker queue every pass") -- surfaces here so the
            // operator can SEE this task is already set to always-claim-first and
            // doesn't need to keep re-picking it via this very dropdown.
            if (t.premiumPriority) full = `★ ${full}`;
            return truncateLabel(full);
          };
          const taskSelect = `<select class="worker-task-select" data-instance-id="${escapeAttr(inst.instanceId)}" onclick="event.stopPropagation()" title="Pick a specific ${escapeAttr(selectedType)} task to assign to this worker">
            <option value="">${tasksOfSelectedType.length ? `(choose a ${escapeHtml(selectedType)} task…)` : `(no ${escapeHtml(selectedType)} tasks right now)`}</option>
            ${tasksOfSelectedType.map(t => `<option value="${escapeAttr(t.id)}" data-title="${escapeAttr(t.title || t.id)}" data-source-lane="${escapeAttr(t.location && t.location !== 'pending' ? t.location.replace(/^drafting:/, '') : '')}" title="${escapeAttr(t.title || t.id)}">${escapeHtml(optionLabel(t))}</option>`).join('')}
          </select>`;
          return typeSelect + taskSelect;
        })() : ''}
        <div class="badge-col">
          <span class="badge ${statusBadgeClass(inst.status, inst.stale)}">${inst.stale ? 'STALE' : inst.status}</span>
          ${inst.stale ? `<span class="stale-timer" id="stale-timer-${inst.instanceId}"></span>` : ''}
          <span class="state-timer" id="state-timer-${inst.instanceId}">${inst.stateAgeSeconds != null ? 'in this state ' + fmtDuration(inst.stateAgeSeconds) : ''}</span>
        </div>
      </div>
      <div class="meta">
        pid ${inst.pid ?? '-'} · model ${inst.model || '-'} · heartbeat ${fmtAge(inst.heartbeatAgeSeconds)} ago
        ${inst.currentTaskId && inst.projectLabel ? ' · <span class="badge ' + (inst.borrowed ? 'warn' : 'idle') + '" title="' + (inst.borrowed ? 'Borrowed: this lane is idle in the active project and is working a task of ' + escapeAttr(inst.projectLabel) + ' (idle-pool borrowing)' : 'This task belongs to the active project') + '">📁 ' + escapeHtml(inst.projectLabel) + (inst.borrowed ? ' (borrowed)' : '') + '</span>' : ''}
        ${inst.currentTaskId && inst.hub ? ' · <span class="badge ok" title="This task belongs to hub ' + escapeAttr(inst.hub.label) + '" style="font-weight:700">🗂 ' + escapeHtml(hubTag(inst.hub)) + '</span>' : ''}
        ${inst.currentTaskId ? ' · working on <strong><a href="#" data-open-task-anywhere="' + escapeAttr(inst.currentTaskId) + '">' + escapeHtml(inst.currentTaskId) + '</a></strong>' + (inst.currentPass ? ' (' + escapeHtml(inst.currentPass) + ')' : '') : ''}
        ${pendingWorkerAssign[inst.instanceId] ? ' · <strong>📌 pinned, waiting for ' + escapeAttr(inst.instanceId) + ' to pick it up…</strong>' : ''}
        ${costByInstance[inst.instanceId] ? ' · ' + fmtUsd(costByInstance[inst.instanceId]) + ' est. API cost' : ''}
      </div>
      ${expandedWorkerId === inst.instanceId ? `
      <div class="worker-recent-tasks">
        <div class="meta" style="margin-top:8px; font-weight:600">${inst.instanceId === 'reviewer' ? 'Last 10 reviewed tasks' : 'Recent runs (every attempt, including failures)'}</div>
        ${recentTasks ? (recentTasks.runs ? renderRunLogList(recentTasks.runs) : renderRecentTasksList(recentTasks.tasks || [])) : '<div class="meta">Loading…</div>'}
      </div>` : ''}
    </div>
  `).join('')) + renderCompletedTasksSection();
  window.scrollTo(0, scrollY);
  setupCompletedTasksObserver();
// ... [truncated for review: this function continues for 41 more line(s) not shown]
```

Problem:
`renderWorkers` is 241 lines long because it interleaves at least six distinct responsibilities—poll-cycle guard, multi-endpoint fan-out fetch, state reconciliation, per-card model-select construction, per-card task-assignment dropdown, and per-card meta/badge rendering—into a single body. Two of those responsibilities (the model-select and task-assignment dropdowns) are implemented as IIFEs embedded inside a template literal within a `map()` callback, making them syntactically inseparable from the surrounding HTML string. The task-assignment `optionLabel` closure alone applies five independent formatting rules (`hubTag()` prefix, `t.pinnedTo` pin indicator, `t.premiumPriority` star prefix, `t.location` "running on" warning, and length truncation), each of which is a one-line branch that currently cannot be unit-tested in isolation. A change to any single rule (e.g., renaming `premiumPriority` to a new field) forces the developer to navigate through the poll guard, the four parallel `fetchJson` calls, the per-instance `assignable-tasks` loop, and the model-select IIFE to locate the correct spot, and a regression in any one of those is invisible to the others.

Solution:
Extract each responsibility into a named function so the top-level `renderWorkers` becomes a short orchestrator that calls them in sequence. The two IIFE blocks become standalone `renderModelSelect` and `renderTaskAssignSelect` functions; the `optionLabel` logic inside `renderTaskAssignSelect` keeps all five formatting rules with their correct field names (`t.pinnedTo`, `t.premiumPriority`, `t.location`, `hubTag(t.hub)`) and the truncation guard. The fetch block and poll guard become `fetchWorkerData` and `pollGuardAndRefresh`. The concrete shape of the two most critical extractions:

```js
// --- extracted from the IIFE inside the map() callback ---

function renderModelSelect(inst, overrides, workerModels) {
  const kind = modelKindForInstance(inst);
  if (!kind) return '';
  const current = overrides[inst.instanceId] || '';
  const optionsFor = (label, values) => values.length
    ? `<optgroup label="${escapeAttr(label)}">${values.map(m =>
        `<option value="${escapeAttr(m.value)}" ${m.value === current ? 'selected' : ''}>${m.label}</option>`
      ).join('')}</optgroup>`
    : '';
  let body;
  if (kind === 'mixed') {
    body = optionsFor('Claude (subscription)',
        (workerModels.claudeModels || []).map(m => ({ value: `claude:${m}`, label: m })))
      + optionsFor('Local (Ollama)',
        (workerModels.ollamaModels || []).map(m => ({ value: `ollama:${m}`, label: m })));
  } else {
    body = (workerModels.ollamaModels || []).map(m =>
      `<option value="${escapeAttr(m)}" ${m === current ? 'selected' : ''}>${m}</option>`
    ).join('');
  }
  return `<select class="worker-model-select" data-instance-id="${escapeAttr(inst.instanceId)}" onclick="event.stopPropagation()"><option value="">(default)</option>${body}</select>`;
}

function renderTaskAssignSelect(inst, assignableByInstance) {
  if (!canAssignTask(inst)) return '';
  const items = assignableByInstance[inst.instanceId] || [];
  const bySource = {};
  items.forEach((t) => { const k = t.source || 'unknown'; (bySource[k] = bySource[k] || []).push(t); });
  const sourceKeys = Object.keys(bySource).sort();
  const selectedType = selectedWorkerTaskType[inst.instanceId] || '';
  if (selectedType && !sourceKeys.includes(selectedType)) sourceKeys.push(selectedType);
  sourceKeys.sort();

  const typeSelect = `<select class="worker-type-select" data-instance-id="${escapeAttr(inst.instanceId)}" onclick="event.stopPropagation()">
    <option value="">(assign a task…)</option>
    ${sourceKeys.map(k => `<option value="${escapeAttr(k)}" ${k === selectedType ? 'selected' : ''}>${escapeHtml(k)} (${(bySource[k] || []).length})</option>`).join('')}
  </select>`;
  if (!selectedType) return typeSelect;

  const tasksOfSelectedType = bySource[selectedType] || [];
  const OPTION_LABEL_MAX = 70;
  const truncateLabel = (s) => s.length > OPTION_LABEL_MAX ? `${s.slice(0, OPTION_LABEL_MAX - 1)}…` : s;

  const optionLabel = (t) => {
    const rawTitle = t.title || t.id;
    const base = t.hub && !/^HUB\d/.test(rawTitle) ? `${hubTag(t.hub)} · ${rawTitle}` : rawTitle;
    let full = base;
    if (t.location && t.location !== 'pending') {
      full = `⚠ running on ${t.location.replace(/^drafting:/, '')} — ${base}`;
    } else if (t.pinnedTo) {
      full = `📌 pinned to ${t.pinnedTo} — ${base}`;
    }
    if (t.premiumPriority) full = `★ ${full}`;
    return truncateLabel(full);
  };

  const taskSelect = `<select class="worker-task-select" data-instance-id="${escapeAttr(inst.instanceId)}" onclick="event.stopPropagation()">
    <option value="">${tasksOfSelectedType.length ? `(choose a ${escapeHtml(selectedType)} task…)` : `(no ${escapeHtml(selectedType)} tasks right now)`}</option>
    ${tasksOfSelectedType.map(t => `<option value="${escapeAttr(t.id)}" data-title="${escapeAttr(t.title || t.id)}" data-source-lane="${escapeAttr(t.location && t.location !== 'pending' ? t.location.replace(/^drafting:/, '') : '')}" title="${escapeAttr(t.title || t.id)}">${escapeHtml(optionLabel(t))}</option>`).join('')}
  </select>`;
  return typeSelect + taskSelect;
}

// --- top-level orchestrator (replaces the 241-line body) ---
async function renderWorkers(isPoll) {
  await pollGuardAndRefresh(isPoll);
  const data = await fetchWorkerData(expandedWorkerId, expandedIsWorker);
  const { instances, workerModels, costSummary, recentTasks, assignableByInstance } = data;
  const overrides = workerModels.overrides || {};
  const costByInstance = Object.fromEntries((costSummary.byInstance || []).map(i => [i.instanceId, i.totalCost]));
  reconcilePendingAssign(instances);
  // …render loop now calls renderModelSelect / renderTaskAssignSelect / renderWorkerMeta
}
```

Benefits:
Each extracted function can be snapshot- or unit-tested with a mock task object or `workerModels` stub without exercising the poll guard, the four parallel fetches, or the per-instance `assignable-tasks` loop. A regression in the `t.pinnedTo` prefix, the `t.premiumPriority` star, the `t.location` "running on" warning, or the `hubTag()` formatting is caught by a single `renderTaskAssignSelect` test. The `map()` callback in the render loop shrinks from roughly 120 lines of nested template-plus-IIFE to about ten lines of template that call three named helpers, making the surrounding HTML structure immediately legible. Code review of a change to the model-select logic no longer requires scrolling past the poll guard and fetch block, and vice versa.

### AC-179 · Decompose renderPluginsTab into single-responsibility helpers
Strength: Strong
Files: python/dashboard/static/js/core-ui.js
Snippet:
```
}

async function renderPluginsTab() {
  const main = document.getElementById('main');
  let data;
  try {
    data = await fetchJson('/api/plugins');
  } catch (e) {
    main.innerHTML = `<div class="empty">Could not load plugins: ${escapeHtml(e.message)}</div>`;
    return;
  }
  const slotted = plugins => plugins.filter((p) => p.slot);
  const unslotted = plugins => plugins.filter((p) => !p.slot);
  const allPlugins = data.plugins || [];
  const rows = unslotted(allPlugins).map((p) => {
    const enabled = p.enabled !== false;
    return `
      <div style="display:flex; align-items:flex-start; gap:12px; padding:12px 14px; background:var(--panel); border:1px solid var(--border); border-radius:8px; margin-bottom:8px;">
        <label style="display:flex; align-items:center; gap:8px; margin-top:2px; cursor:pointer;">
          <input type="checkbox" class="plugin-toggle" data-name="${escapeAttr(p.name)}" ${enabled ? 'checked' : ''}>
        </label>
        <div style="flex:1; min-width:0;">
          <div style="font-weight:600;">${escapeHtml(p.name)} ${enabled ? '' : '<span class="badge idle" style="margin-left:6px;">disabled</span>'}</div>
          ${p.description ? `<div class="meta" style="margin-top:2px;">${escapeHtml(p.description)}</div>` : ''}
          <div class="meta" style="margin-top:4px; word-break:break-all; font-family:monospace; font-size:11px; color:var(--muted);">${escapeHtml(p.registerPath || '(no path)')}</div>
        </div>
      </div>`;
  }).join('');

  // Slotted plugins (e.g. "hardware-tab") are mutually exclusive -- a radio group, not
  // independent checkboxes, since exactly one (or none) actually runs at a time and
  // switching genuinely starts/stops the underlying process (see /api/plugins/select-slot).
  const slotGroups = {};
  slotted(allPlugins).forEach((p) => { (slotGroups[p.slot] = slotGroups[p.slot] || []).push(p); });
  const slotSections = Object.entries(slotGroups).map(([slot, members]) => {
    const radioName = `slot-${slot}`;
    const noneChecked = !members.some((m) => m.active) ? 'checked' : '';
    const options = [`
      <label style="display:flex; align-items:center; gap:8px; padding:8px 10px; cursor:pointer;">
        <input type="radio" name="${escapeAttr(radioName)}" class="slot-radio" data-slot="${escapeAttr(slot)}" value="" ${noneChecked}>
        <span>None (stop monitoring)</span>
      </label>`, ...members.map((m) => {
      const badge = m.running
        ? '<span class="badge ok" style="margin-left:6px;">running</span>'
        : '<span class="badge idle" style="margin-left:6px;">stopped</span>';
      return `
      <label style="display:flex; align-items:flex-start; gap:8px; padding:8px 10px; cursor:pointer;">
        <input type="radio" name="${escapeAttr(radioName)}" class="slot-radio" data-slot="${escapeAttr(slot)}" value="${escapeAttr(m.name)}" ${m.active ? 'checked' : ''} style="margin-top:2px;">
        <span>
          <div style="font-weight:600;">${escapeHtml(m.name)}${badge}</div>
          ${m.description ? `<div class="meta" style="margin-top:2px;">${escapeHtml(m.description)}</div>` : ''}
        </span>
      </label>`;
    })];
    return `
      <div style="padding:12px 14px; background:var(--panel); border:1px solid var(--border); border-radius:8px; margin-bottom:8px;">
        <div class="field-label" style="margin-bottom:6px;">${escapeHtml(slot)} source</div>
        <div style="display:flex; flex-direction:column; gap:2px;" id="slot-group-${escapeAttr(slot)}">${options.join('')}</div>
        <div class="meta slot-status" style="margin-top:6px;"></div>
      </div>`;
  }).join('');

  main.innerHTML = `
    <h2 style="margin-top:0;">Plugins</h2>
    ${slotSections}
    <div class="meta" style="margin-bottom:14px;">
      Only enabled plugins register their task sources. A change here restarts the pipeline if it is running so an
      in-flight draft for a now-disabled source can't stall. Manifest: <span style="font-family:monospace;">${escapeHtml(data.manifestPath || 'plugins.json')}</span>
    </div>
    <div id="plugins-list">${rows || '<div class="empty">No plugins registered yet -- add one below.</div>'}</div>

    <h3 style="margin-top:22px;">Add a plugin</h3>
    <div style="display:flex; flex-direction:column; gap:8px; max-width:640px;">
      <input type="text" id="plugin-add-path" placeholder="Absolute path to the plugin's register.js (e.g. /media/model-cache/github/agent-manager-imagegen/register.js)" style="padding:8px; background:var(--bg); border:1px solid var(--border); border-radius:6px; color:var(--text);">
      <input type="text" id="plugin-add-name" placeholder="Name (optional -- defaults to the plugin folder name)" style="padding:8px; background:var(--bg); border:1px solid var(--border); border-radius:6px; color:var(--text);">
      <input type="text" id="plugin-add-desc" placeholder="Description (optional)" style="padding:8px; background:var(--bg); border:1px solid var(--border); border-radius:6px; color:var(--text);">
      <button class="action" id="plugin-add-btn" style="align-self:flex-start;">Add plugin</button>
      <div id="plugin-add-msg" class="meta"></div>
    </div>

    <h3 style="margin-top:22px;">Available plugins</h3>
    <div id="marketplace-note" class="meta" style="margin-bottom:10px;"></div>
    <div id="marketplace-list"><div class="meta">Loading...</div></div>`;

  main.querySelectorAll('.slot-radio').forEach((radio) => {
    radio.onchange = async () => {
      const slot = radio.dataset.slot;
      const name = radio.value || null;
      const group = main.querySelector(`#slot-group-${slot}`);
      const statusEl = group ? group.closest('div').parentElement.querySelector('.slot-status') : null;
      group.querySelectorAll('input').forEach((r) => { r.disabled = true; });
      if (statusEl) statusEl.textContent = name ? `Starting ${name}...` : 'Stopping...';
      try {
        const r = await fetch('/api/plugins/select-slot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slot, name }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.description || r.status);
        if (name && !body.healthy) {
          if (statusEl) statusEl.textContent = `${name} started but did not report healthy in time -- check its log.`;
        }
        await renderPluginsTab();
      } catch (e) {
        alert('Could not switch plugin: ' + e.message);
        await renderPluginsTab();
      }
    };
  });

  main.querySelectorAll('.plugin-toggle').forEach((cb) => {
    cb.onchange = async () => {
      cb.disabled = true;
      try {
        const r = await fetch('/api/plugins/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: cb.dataset.name, enabled: cb.checked }),
        });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).description || r.status);
        await renderPluginsTab();
      } catch (e) {
        alert('Could not update plugin: ' + e.message);
        cb.checked = !cb.checked;
        cb.disabled = false;
      }
    };
  });

  const addBtn = main.querySelector('#plugin-add-btn');
  addBtn.onclick = async () => {
    const msg = main.querySelector('#plugin-add-msg');
    const registerPath = main.querySelector('#plugin-add-path').value.trim();
    const name = main.querySelector('#plugin-add-name').value.trim();
    const description = main.querySelector('#plugin-add-desc').value.trim();
    if (!registerPath) { msg.textContent = 'A register.js path is required.'; return; }
    addBtn.disabled = true;
    msg.textContent = 'Adding...';
    try {
      const r = await fetch('/api/plugins/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ registerPath, name, description }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.description || r.status);
      await renderPluginsTab();
    } catch (e) {
      msg.textContent = 'Could not add plugin: ' + e.message;
      addBtn.disabled = false;
    }
  };

  // Marketplace: fetch catalog entries annotated with install status and render
  // Install / Update / Installed controls per entry. 402/403 surface via showToast.
  (async () => {
    const listEl = main.querySelector('#marketplace-list');
    const noteEl = main.querySelector('#marketplace-note');
    let mkt;
    try {
      mkt = await fetchJson('/api/plugins/marketplace');
    } catch (e) {
      listEl.innerHTML = '<div class="meta">Could not load marketplace: ' + escapeHtml(e.message) + '</div>';
      return;
    }
    if (mkt.catalogError) {
      noteEl.textContent = mkt.catalogError;
    }
    const entries = mkt.plugins || mkt.entries || [];
    if (!entries.length) {
      listEl.innerHTML = '<div class="meta">No plugins available in the catalog.</div>';
      return;
    }
    listEl.innerHTML = entries.map((p) => {
      const installed = p.installed === true;
      const updateAvail = p.updateAvailable === true;
      let priceText = '';
      if (p.pricing && p.pricing.model && p.pricing.model !== 'free') {
        const cur = p.pricing.currency || '';
        const amt = p.pricing.amount_cents != null ? (p.pricing.amount_cents / 100) : 0;
        const interval = p.pricing.interval || '';
        priceText = escapeHtml(cur + ' ' + amt + (interval ? ' / ' + interval : ''));
      }
      let controlHtml = '';
      if (installed && updateAvail) {
        controlHtml = '<button class="action" data-mkt-action="update" data-id="' + escapeAttr(p.id) + '">Update</button>';
      } else if (installed) {
        controlHtml = '<span class="badge ok" style="margin-top:2px;">Installed</span>';
      } else {
        const isPaid = p.pricing && p.pricing.model && p.pricing.model !== 'free';
        const paidStyle = isPaid ? ' style="opacity:0.7; border-style:dashed;" title="Paid plugin -- requires a license"' : '';
        controlHtml = '<button class="action" data-mkt-action="install" data-id="' + escapeAttr(p.id) + '"' + paidStyle + '>Install</button>';
      }
      const versionLine = p.installedVersion
        ? '<div class="meta" style="margin-top:2px; font-size:11px;">Installed: ' + escapeHtml(p.installedVersion) + (updateAvail ? ' <span class="badge idle" style="margin-left:4px;">update available</span>' : '') + '</div>'
        : '';
      return '<div style="display:flex; align-items:flex-start; gap:12px; padding:12px 14px; background:var(--panel); border:1px solid var(--border); border-radius:8px; margin-bottom:8px;">'
        + '<div style="flex:1; min-width:0;">'
        + '<div style="font-weight:600;">' + escapeHtml(p.name) + (priceText ? ' <span class="meta" style="margin-left:8px;">' + priceText + '</span>' : '') + '</div>'
        + '<div class="meta" style="margin-top:2px;">' + escapeHtml(p.summary || '') + '</div>'
        + versionLine
// ... [truncated for review: this function continues for 36 more line(s) not shown]
```

Problem:
`renderPluginsTab` spans roughly 236 lines and interleaves five independent responsibilities—fetching the plugin list, building unslotted-checkbox HTML rows, building slotted-radio-group sections, wiring three separate event-handler families, and running an async marketplace fetch-and-render. Each responsibility has its own data shape, failure mode, and test surface, yet they share one function body. A change to marketplace pricing forces a reader to re-scan the entire body to confirm the toggle handler is untouched, and a new slot type requires understanding the radio-group template amid unrelated marketplace code. The length is a symptom of five jobs in one scope, not of any single job being inherently large.

Solution:
Extract five named helpers that live in the same file, above `renderPluginsTab`, and reduce the original to a ~25-line orchestrator that fetches data, builds two HTML fragments, sets `innerHTML`, and calls the wiring/render helpers. Each helper takes only what it needs (the plugin array or the populated `#main` element) so it can be unit-tested in isolation. No template string, `fetch` call, or `escapeHtml`/`escapeAttr` usage changes—only scope moves.

```diff
--- a/python/dashboard/static/js/core-ui.js
+++ b/python/dashboard/static/js/core-ui.js
@@ renderPluginsTab @@
+// --- extracted helpers (same file, above renderPluginsTab) ---
+
+function buildUnslottedRows(plugins) {
+  const unslotted = plugins.filter((p) => !p.slot);
+  return unslotted.map((p) => {
+    const enabled = p.enabled !== false;
+    return `
+      <div style="display:flex; align-items:flex-start; gap:12px; padding:12px 14px;">
+        …(existing template, verbatim)
+      </div>`;
+  }).join('');
+}
+
+function buildSlotSections(plugins) {
+  const slotted = plugins.filter((p) => p.slot);
+  const groups = {};
+  slotted.forEach((p) => { (groups[p.slot] = groups[p.slot] || []).push(p); });
+  return Object.entries(groups).map(([slot, members]) => {
+    …(existing radio-group template, verbatim)
+  }).join('');
+}
+
+function wireSlotRadios(main) {
+  main.querySelectorAll('.slot-radio').forEach((radio) => {
+    radio.onchange = async () => { …(existing handler body, verbatim) };
+  });
+}
+
+function wirePluginToggles(main) {
+  main.querySelectorAll('.plugin-toggle').forEach((cb) => {
+    cb.onchange = async () => { …(existing handler body, verbatim) };
+  });
+}
+
+function wireAddPluginButton(main) {
+  const addBtn = main.querySelector('#plugin-add-btn');
+  addBtn.onclick = async () => { …(existing handler body, verbatim) };
+}
+
+async function renderMarketplace(main) {
+  const listEl = main.querySelector('#marketplace-list');
+  const noteEl = main.querySelector('#marketplace-note');
+  …(existing IIFE body, verbatim)
+}
+
 // --- main function, now a thin orchestrator ---
 async function renderPluginsTab() {
   const main = document.getElementById('main');
   let data;
   try {
     data = await fetchJson('/api/plugins');
   } catch (e) {
     main.innerHTML = `<div class="empty">Could not load plugins: ${escapeHtml(e.message)}</div>`;
     return;
   }
   const allPlugins = data.plugins || [];
+  const rows = buildUnslottedRows(allPlugins);
+  const slotSections = buildSlotSections(allPlugins);
 
   main.innerHTML = `
     <h2 style="margin-top:0;">Plugins</h2>
     ${slotSections}
     …(static form + marketplace placeholder, unchanged)
     <div id="marketplace-list"><div class="meta">Loading...</div></div>`;
 
+  wireSlotRadios(main);
+  wirePluginToggles(main);
+  wireAddPluginButton(main);
+  renderMarketplace(main);
 }
```

Benefits:
Each extracted helper is a pure or near-pure unit that can be exercised with a fixture array (for the two `build*` functions) or a JSDOM stub (for the three `wire*` functions and `renderMarketplace`), so a regression in one handler no longer requires re-reading the other four. Code review diffs shrink to the single helper that changed. The orchestrator reads top-to-bottom as a five-line pipeline—fetch, build, mount, wire, render—making the control flow and error boundary obvious at a glance.

### AC-180 · Decompose coordinatorSweep into stage-scoped helpers
Strength: Strong
Files: src/coordinator-sweep.js
Snippet:
```
}

function coordinatorSweep({ pipelineDir, repoRoot, runGate = runStackedGate, runWiring = runStackedWiring, runAutoMerge = autoMergeVerifiedMoveChild } = {}) {
  const coordDir = path.join(pipelineDir, 'queue', 'coordinating');
  const doneDir = path.join(pipelineDir, 'queue', 'done');
  let resolvedRepoRoot = repoRoot;
  if (resolvedRepoRoot === undefined) { try { ({ repoRoot: resolvedRepoRoot } = getConfig()); } catch { resolvedRepoRoot = null; } }
  const summary = { checked: 0, updated: 0, completed: 0, errors: 0 };

  // Label every hub that has no HUB#### yet (oldest first), before the loop below reads them.
  try { const labelled = assignMissingHubSerials(pipelineDir); if (labelled) summary.hubsLabelled = labelled; } catch (e) { console.warn(`[coordinator-sweep] hub serial backfill failed (advisory): ${e.message}`); }

  let names;
  try {
    names = fs.readdirSync(coordDir).filter((f) => f.endsWith('.json'));
  } catch (err) {
    if (err.code === 'ENOENT') { console.warn(`[coordinator-sweep] ${coordDir} does not exist yet -- nothing to sweep`); return summary; }
    summary.errors += 1;
    console.error(`[coordinator-sweep] readdirSync failed for ${coordDir}: ${err.code || 'UNKNOWN'} -- ${err.message}`);
    return summary;
  }

  for (const name of names) {
    const file = path.join(coordDir, name);
    let parent;
    try {
      parent = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      summary.errors += 1;
      continue; // a malformed coordinating file is not this sweep's problem to fix
    }
    if (!Array.isArray(parent.subTasks) || parent.subTasks.length === 0) {
      // A coordinating parent with no checklist is a bug upstream -- complete it out so it
      // does not sit here forever.
      //
      // 2026-09-14, screaminggoatclubmt: "fix the mislabeling" -- a hub that carries
      // `coordinatorBlocked` from the moment it was filed (file-decompose-to-hub.js's
      // fileBlockedHub(): validatePlan() found a hard problem, subTasks was `[]` from
      // creation, ZERO children were ever attempted) was being routed through
      // stampHubMerged() exactly like a hub whose children ALL genuinely shipped, so its
      // history read "created -> merged -> done" and the dashboard reported it as a
      // successful merge. Confirmed live: 33 `Decompose <file> -- plan needs revision`
      // records in queue/done/ carry this exact false "merged" disposition. Route the
      // rejected-at-creation case through `noop` instead (task-disposition.js's own
      // definition: "the apply produced no change... no code change") -- still stamps
      // mergedAt so any (unlikely, since no children ever existed) dependsOn sibling isn't
      // blocked forever, per stampHubMerged's own reasoning, just without the false
      // "merged" label.
      const rejectedAtCreation = !!parent.coordinatorBlocked;
      parent.status = 'done';
      parent.doneMarker = rejectedAtCreation
        ? 'coordinator hub rejected at creation -- no sub-tasks were ever filed'
        : 'coordinator had no sub-tasks -- completed';
      stampHubMerged(parent, rejectedAtCreation ? {
        disposition: 'noop',
        detail: 'coordinator hub: plan rejected at creation, no sub-tasks were ever filed',
      } : undefined);
      appendHistoryEvent(parent, 'done', parent.doneMarker);
      // 2026-09-14, screaminggoatclubmt: "fold it into the watchdog sweep" -- file
      // straight into done/_archived_no_action/ instead of done/'s top level for the
      // rejected-at-creation case: it produced zero real work, so there is nothing for a
      // human to review or a dependent to wait on, the exact "no action" meaning this
      // folder already carries elsewhere (staleness-auto-archive.js's own DENY-vote and
      // archive-recommendation paths file directly here the same way, with no human
      // click in between -- established precedent for an automated sweep to use this
      // folder, not only the dashboard's own Archive button). Otherwise these hubs would
      // just sit in done/'s top level for up to done-archive.js's 30-day retention window
      // before its generic time-based pass finally moved them. The genuine
      // all-children-succeeded case is unaffected -- it still lands in done/ normally.
      const destDir = rejectedAtCreation ? path.join(doneDir, '_archived_no_action') : doneDir;
      if (rejectedAtCreation) {
        appendHistoryEvent(parent, 'archived', 'Auto-archived: coordinator hub rejected at creation, no sub-tasks were ever filed -- nothing to review or wait on');
      }
      moveToDone(file, destDir, name, parent);
      summary.checked += 1;
      summary.completed += 1;
      continue;
    }

    summary.checked += 1;
    const recById = new Map();
    for (const st of parent.subTasks) {
      const rec = st && st.id ? findTaskRecordById(pipelineDir, st.id) : null;
      recById.set(st && st.id, rec);
      st.status = classifyChildStatus(rec);
    }
    // A hub built before "one hub = one stacked chain" may be mixed (some pieces stacked, some independent and stuck behind a merge):
    // put its not-yet-started pieces onto the chain (hub-restack.js). Before the held-marker below, which reads the fresh fields.
    try {
      const restacked = restackHubChain(parent, recById);
      if (restacked.length) { summary.restacked = (summary.restacked || 0) + restacked.length; appendHistoryEvent(parent, 'advisory', `restacked ${restacked.length} piece(s) onto the hub's shared branch`); }
    } catch { /* repair is best-effort */ }
    // Members lead with their hub's label (hub-serial.js): queueSubTasks does it for the hubs it builds, this covers older hubs and the
    // producers that mint their own child ids. The checklist titles always follow; a member's record is only rewritten while it is idle.
    try { const n = retitleHubMembers(parent, recById); if (n) summary.membersRetitled = (summary.membersRetitled || 0) + n; } catch { /* cosmetic */ }
    // A hub renamed to its HUB#### id (hub-rename.js) may have a member a worker was mid-way through: point its decomposedFrom at the new id once idle.
    try { const n = repairStaleHubRefs(parent, recById); if (n) summary.staleHubRefsRepaired = (summary.staleHubRefsRepaired || 0) + n; } catch { /* cosmetic */ }
    // A piece that is only waiting for an earlier sibling to land (hub-priority.js hubHasUnmergedEarlierSibling) reads 'in-progress' and
    // looks stuck; say what it is waiting for so the checklist is honest. Computed after every status above is fresh (the check reads
    // sibling statuses off `parent`), and cleared as soon as the piece is released.
    for (const st of parent.subTasks) {
      const rec = st && st.id ? recById.get(st.id) : null;
      let held = null;
      if (st && st.status === 'in-progress' && rec && rec.task) {
        try { const h = hubHasUnmergedEarlierSibling(pipelineDir, rec.task, parent); if (h.blocked) held = { id: h.blockingSiblingId, status: h.blockingSiblingStatus }; } catch { /* advisory */ }
      }
      if (st && held) st.heldFor = held; else if (st) delete st.heldFor;
    }

    // A non-stacked decompose hub: its move children carry no dependsOn, so nothing else
    // reconciles their merge. Confirm each `done` child against origin/<main>'s commit
    // trailer and flip it to `merged` -- then the hub only completes on all-MERGED, so its
    // mergedAt stamp is honest and dependents don't unblock against a pre-split main.
    const strictMergeHub = parent.decomposeHub === true && parent.mode !== 'stacked';
    if (strictMergeHub) {
      reconcileDecomposeChildMerges(pipelineDir, resolvedRepoRoot, parent.subTasks, recById, parent, runAutoMerge);
    }

    let doneCount = 0;
    let builtCount = 0;
    for (const st of parent.subTasks) {
      st.phase = childPhase(st.status, strictMergeHub); // bare `done` is NOT enough to complete a strict-merge hub
      if (st.phase === 'merged') { doneCount += 1; builtCount += 1; } else if (st.phase === 'built') builtCount += 1;
    }
    // done = merged/closed (completion, unchanged); built = done + finished-but-awaiting-merge (what the UI shows as progress).
    parent.progress = { done: doneCount, built: builtCount, total: parent.subTasks.length };
    parent.lastReconciledAt = new Date().toISOString();

    // Stuck-chain detection: surface a hub that can never complete on its own instead of
    // leaving it frozen at partial progress. The hub STAYS in coordinating/ so the sweep
    // keeps reconciling it (and auto-clears / auto-completes if the children get unstuck);
    // what changes is a `coordinatorBlocked` marker + a `blockedReason` the dashboard
    // renders, and after a grace period an `escalated` flag + a louder history event.
    if (doneCount < parent.subTasks.length) {
      const stuck = findStuckChildren(parent.subTasks, recById);
      const now = new Date().toISOString();
      if (stuck.length > 0) {
        const signature = stuck.map((s) => `${s.id}:${s.why}`).sort().join(' | ');
        if (!parent.coordinatorBlocked || parent.coordinatorBlocked.signature !== signature) {
          parent.coordinatorBlocked = { signature, since: now, children: stuck, escalated: false };
          appendHistoryEvent(parent, 'blocked', `coordinator stuck: ${stuck.map((s) => `${s.id} -- ${s.why}`).join('; ')}`.slice(0, 500));
          summary.blocked = (summary.blocked || 0) + 1;
        }
        parent.blockedReason = `${stuck.length} sub-task(s) can't proceed: ${stuck.map((s) => `${s.id.replace(/^adhoc-/, '')} (${s.why})`).join('; ')}`.slice(0, 400);
        const escalateMs = stuckEscalateMs();
        const stuckForMs = Date.now() - Date.parse(parent.coordinatorBlocked.since || now);
        if (escalateMs > 0 && stuckForMs >= escalateMs && !parent.coordinatorBlocked.escalated) {
          parent.coordinatorBlocked.escalated = true;
          parent.coordinatorBlocked.escalatedAt = now;
          appendHistoryEvent(parent, 'advisory',
            `coordinator hub stuck ${Math.floor(stuckForMs / 86400000)}d -- needs a human: resolve/requeue/archive ${stuck.map((s) => s.id).join(', ')}, or archive this hub`);
          summary.escalated = (summary.escalated || 0) + 1;
        }
      } else if (parent.coordinatorBlocked) {
        delete parent.coordinatorBlocked;
        delete parent.blockedReason;
        appendHistoryEvent(parent, 'advisory', 'coordinator unblocked -- sub-tasks progressing again');
        summary.unblocked = (summary.unblocked || 0) + 1;
      }
    }

    const allChildrenDone = doneCount === parent.subTasks.length;

    // A child went back to work (e.g. a human requeued the wiring step after a gate
    // failure) -- re-arm the gate so the next all-done transition re-checks the branch.
    if (!allChildrenDone && parent.integrationGate
        && ['failed', 'errored'].includes(parent.integrationGate.status)) {
      parent.integrationGate = { status: 'pending', reArmedAt: new Date().toISOString() };
      delete parent.blockedReason;
      delete parent.coordinatorBlocked;
    }

    // Stacked all-blueprint decompose hub: every move child committed its Blueprint module
    // to the branch, but nothing registered them yet. Do the `register_blueprint` splice
    // deterministically now, before the gate. On failure the hub stays in coordinating/
    // with a blockedReason; on success wiringPending clears and the next tick runs the gate
    // against the wired branch.
    if (allChildrenDone && parent.mode === 'stacked' && parent.wiringPending
        && (!parent.integrationGate || parent.integrationGate.status === 'pending')) {
      const res = runWiring(parent, resolvedRepoRoot);
      const now = new Date().toISOString();
      if (res && res.ok) {
        parent.wiringPending = false;
        appendHistoryEvent(parent, 'advisory', res.skipped
          ? `blueprint wiring already present on ${parent.branch}`
          : `wired ${res.registered} blueprint(s) onto ${parent.branch}${res.sha ? ` @ ${res.sha.slice(0, 10)}` : ''}`);
        summary.wired = (summary.wired || 0) + 1;
      } else {
        parent.blockedReason = `deterministic blueprint wiring failed on ${parent.branch}: ${res && res.detail ? res.detail : 'unknown'}`.slice(0, 600);
        parent.coordinatorBlocked = {
          signature: 'blueprint-wiring:failed', since: now, escalated: false,
          children: [{ id: parent.subTasks[parent.subTasks.length - 1].id, why: (res && res.detail) || 'wiring failed' }],
        };
        appendHistoryEvent(parent, 'blocked', parent.blockedReason);
        summary.wiringFailed = (summary.wiringFailed || 0) + 1;
      }
      try { fs.writeFileSync(file, JSON.stringify(parent, null, 2)); summary.updated += 1; }
      catch (err) { console.error(`coordinator-sweep: failed to write ${file}: ${err.message}`); summary.errors += 1; }
      continue;
    }

    // Stacked decompose hub: children done is necessary but not sufficient -- the shared
// ... [truncated for review: this function continues for 54 more line(s) not shown]
```

Problem:
`coordinatorSweep` is a 254-line function that interleaves at least nine logically distinct responsibilities—empty-subtask completion, status classification with three best-effort repair passes, held-for-sibling annotation, strict-merge reconciliation, progress folding, stuck-detection with escalation timers, gate re-arming, blueprint wiring, and final gate execution with completion and file write—into a single loop body with multiple early-`continue` exits. The 2026-09-14 "rejected-at-creation" change is a concrete example of the cost: a reviewer had to trace all 254 lines to confirm the new `rejectedAtCreation` branch did not accidentally interact with the stuck-detection or wiring paths below it. No individual stage can be unit-tested in isolation without exercising the entire function, and the shared mutable `parent` object is mutated across all nine stages with no visible read/write boundary per stage.

Solution:
Extract each stage into a clearly-named, independently-testable helper function that receives only the fields it reads or mutates. The main `coordinatorSweep` becomes a ~60-line orchestration loop that calls `handleEmptySubTaskHub`, `classifyAndRepair`, `annotateHeldFor`, `reconcileDecomposeChildMerges`, `computeProgress`, `detectStuckAndEscalate`, `rearmGateIfNeeded`, `tryBlueprintWiring`, and `runGateAndComplete` in sequence. The three best-effort repair calls (restack, retitle, stale-ref) stay grouped inside `classifyAndRepair` because they share the same try/catch-and-continue pattern and are each only 2–3 lines; splitting them further would add indirection without reducing cognitive load. The early-`continue` paths become explicit return values (`tryBlueprintWiring` returns `true` when it handled the hub this tick).

Benefits:
Each helper can be unit-tested with a synthetic `parent` object and stubbed I/O without touching the filesystem, the wiring path, or the gate. Change isolation is concrete: the 2026-09-14 fix becomes a self-contained edit to `handleEmptySubTaskHub` with zero risk of altering stuck-detection or wiring logic. The shared-state surface is bounded—each helper receives only the fields it needs, making the read/write boundaries per stage visible to a reviewer. The orchestration loop reads top-to-bottom as a state machine with named transitions rather than a wall of interleaved mutations.

```javascript
// src/coordinator-sweep.js (post-decomposition)
//
// The 254-line coordinatorSweep is split into a ~60-line orchestration
// loop plus nine stage-scoped helpers.  Each helper receives only the
// fields it reads or mutates, so the shared `parent` object's
// read/write boundary is visible per stage.

import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from './config.js';
import { assignMissingHubSerials } from './hub-serials.js';
import { findTaskRecordById, classifyChildStatus, childPhase } from './task-records.js';
import { restackHubChain, retitleHubMembers, repairStaleHubRefs } from './hub-repairs.js';
import { hubHasUnmergedEarlierSibling } from './sibling-check.js';
import { reconcileDecomposeChildMerges } from './strict-merge.js';
import { findStuckChildren, stuckEscalateMs } from './stuck-detect.js';
import { runStackedGate, runStackedWiring, autoMergeVerifiedMoveChild } from './gates.js';
import { stampHubMerged, appendHistoryEvent, moveToDone } from './hub-lifecycle.js';

// ─────────────────────────────────────────────────────────────────────
//  Orchestration loop (was the 254-line body)
// ─────────────────────────────────────────────────────────────────────
export function coordinatorSweep({
  pipelineDir,
  repoRoot,
  runGate = runStackedGate,
  runWiring = runStackedWiring,
  runAutoMerge = autoMergeVerifiedMoveChild,
} = {}) {
  const coordDir = path.join(pipelineDir, 'queue', 'coordinating');
  const doneDir  = path.join(pipelineDir, 'queue', 'done');

  let resolvedRepoRoot = repoRoot;
  if (resolvedRepoRoot === undefined) {
    try { ({ repoRoot: resolvedRepoRoot } = getConfig()); }
    catch { resolvedRepoRoot = null; }
  }

  const summary = { checked: 0, updated: 0, completed: 0, errors: 0 };

  // Advisory: back-fill missing hub serials before the sweep.
  try {
    const labelled = assignMissingHubSerials(pipelineDir);
    if (labelled) summary.hubsLabelled = labelled;
  } catch (e) {
    console.warn(`[coordinator-sweep] hub serial backfill failed (advisory): ${e.message}`);
  }

  let names;
  try {
    names = fs.readdirSync(coordDir).filter((f) => f.endsWith('.json'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.warn(`[coordinator-sweep] ${coordDir} does not exist yet -- nothing to sweep`);
      return summary;
    }
    summary.errors += 1;
    console.error(`[coordinator-sweep] readdirSync failed for ${coordDir}: ${err.code || 'UNKNOWN'} -- ${err.message}`);
    return summary;
  }

  for (const name of names) {
    const file = path.join(coordDir, name);
    let parent;
    try { parent = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { summary.errors += 1; continue; }

    // Stage 1 ─ empty-subtask completion (early exit)
    if (!Array.isArray(parent.subTasks) || parent.subTasks.length === 0) {
      handleEmptySubTaskHub(parent, file, name, doneDir, summary);
      continue;
    }

    summary.checked += 1;

    // Stage 2 ─ classify + best-effort repairs
    const recById = classifyAndRepair(parent, pipelineDir, summary);

    // Stage 3 ─ held-for-sibling annotation
    annotateHeldFor(parent, recById, pipelineDir);

    // Stage 4 ─ strict-merge reconciliation
    const strictMergeHub = parent.decomposeHub === true && parent.mode !== 'stacked';
    if (strictMergeHub) {
      reconcileDecomposeChildMerges(
        pipelineDir, resolvedRepoRoot,
        parent.subTasks, recById, parent, runAutoMerge,
      );
    }

    // Stage 5 ─ progress fold
    const { doneCount } = computeProgress(parent, strictMergeHub);

    // Stage 6 ─ stuck-detection + escalation
    detectStuckAndEscalate(parent, recById, doneCount, pipelineDir, summary);

    // Stage 7 ─ gate re-arm
    rearmGateIfNeeded(parent, doneCount, parent.subTasks.length);

    // Stage 8 ─ blueprint wiring (may consume the tick)
    if (tryBlueprintWiring(parent, file, name, resolvedRepoRoot, runWiring, summary)) {
      continue;
    }

    // Stage 9 ─ gate execution + completion + write
    runGateAndComplete(parent, file, name, doneDir, resolvedRepoRoot,
                       runGate, runAutoMerge, summary);
  }

  return summary;
}

// ─────────────────────────────────────────────────────────────────────
//  Stage 1 – empty-subtask completion
// ─────────────────────────────────────────────────────────────────────
function handleEmptySubTaskHub(parent, file, name, doneDir, summary) {
  const rejectedAtCreation = !!parent.coordinatorBlocked;

  parent.status = 'done';
  parent.doneMarker = rejectedAtCreation
    ? 'coordinator hub rejected at creation -- no sub-tasks were ever filed'
    : 'coordinator had no sub-tasks -- completed';

  stampHubMerged(parent, rejectedAtCreation
    ? { disposition: 'noop',
        detail: 'coordinator hub: plan rejected at creation, no sub-tasks were ever filed' }
    : undefined);

  appendHistoryEvent(parent, 'done', parent.doneMarker);

  const destDir = rejectedAtCreation
    ? path.join(doneDir, '_archived_no_action')
    : doneDir;

  if (rejectedAtCreation) {
    appendHistoryEvent(parent, 'archived',
      'Auto-archived: coordinator hub rejected at creation, no sub-tasks were ever filed -- nothing to review or wait on');
  }

  moveToDone(file, destDir, name, parent);
  summary.checked += 1;
  summary.completed += 1;
}

// ─────────────────────────────────────────────────────────────────────
//  Stage 2 – classify + best-effort repairs
// ─────────────────────────────────────────────────────────────────────
function classifyAndRepair(parent, pipelineDir, summary) {
  const recById = new Map();
  for (const st of parent.subTasks) {
    const rec = st && st.id ? findTaskRecordById(pipelineDir, st.id) : null;
    recById.set(st && st.id, rec);
    st.status = classifyChildStatus(rec);
  }

  // Three independent advisory repairs; each swallows its own errors.
  try {
    const restacked = restackHubChain(parent, recById);
    if (restacked.length) {
      summary.restacked = (summary.restacked || 0) + restacked.length;
      appendHistoryEvent(parent, 'advisory',
        `restacked ${restacked.length} piece(s) onto the hub's shared branch`);
    }
  } catch { /* best-effort */ }

  try {
    const n = retitleHubMembers(parent, recById);
    if (n) summary.membersRetitled = (summary.membersRetitled || 0) + n;
  } catch { /* cosmetic */ }

  try {
    const n = repairStaleHubRefs(parent, recById);
    if (n) summary.staleHubRefsRepaired = (summary.staleHubRefsRepaired || 0) + n;
  } catch { /* cosmetic */ }

  return recById;
}

// ─────────────────────────────────────────────────────────────────────
//  Stage 3 – held-for-sibling annotation
// ─────────────────────────────────────────────────────────────────────
function annotateHeldFor(parent, recById, pipelineDir) {
  for (const st of parent.subTasks) {
    const rec = st && st.id ? recById.get(st.id) : null;
    let held = null;
    if (st && st.status === 'in-progress' && rec && rec.task) {
      try {
        const h = hubHasUnmergedEarlierSibling(pipelineDir, rec.task, parent);
        if (h.blocked) held = { id: h.blockingSiblingId, status: h.blockingSiblingStatus };
      } catch { /* advisory */ }
    }
    if (st && held) st.heldFor = held;
    else if (st) delete st.heldFor;
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Stage 5 – progress fold
// ─────────────────────────────────────────────────────────────────────
function computeProgress(parent, strictMergeHub) {
  let doneCount = 0;
  let builtCount = 0;
  for (const st of parent.subTasks) {
    st.phase = childPhase(st.status, strictMergeHub);
    if (st.phase === 'merged') { doneCount += 1; builtCount += 1; }
    else if (st.phase === 'built') builtCount += 1;
  }
  parent.progress = { done: doneCount, built: builtCount, total: parent.subTasks.length };
  parent.lastReconciledAt = new Date().toISOString();
  return { doneCount, builtCount };
}

// ─────────────────────────────────────────────────────────────────────
//  Stage 6 – stuck-detection + escalation
// ─────────────────────────────────────────────────────────────────────
function detectStuckAndEscalate(parent, recById, doneCount, pipelineDir, summary) {
  if (doneCount >= parent.subTasks.length) return;

  const stuck = findStuckChildren(parent.subTasks, recById);
  const now = new Date().toISOString();

  if (stuck.length > 0) {
    const signature = stuck.map((s) => `${s.id}:${s.why}`).sort().join(' | ');

    if (!parent.coordinatorBlocked
        || parent.coordinatorBlocked.signature !== signature) {
      parent.coordinatorBlocked = {
        signature, since: now, children: stuck, escalated: false,
      };
      appendHistoryEvent(parent, 'blocked',
        `coordinator stuck: ${stuck.map((s) => `${s.id} -- ${s.why}`).join('; ')}`.slice(0, 500));
      summary.blocked = (summary.blocked || 0) + 1;
    }

    parent.blockedReason =
      `${stuck.length} sub-task(s) can't proceed: ${stuck
        .map((s) => `${s.id.replace(/^adhoc-/, '')} (${s.why})`).join('; ')}`
        .slice(0, 400);

    const escalateMs = stuckEscalateMs();
    const stuckForMs = Date.now() - Date.parse(parent.coordinatorBlocked.since || now);
    if (escalateMs > 0 && stuckForMs >= escalateMs && !parent.coordinatorBlocked.escalated) {
      parent.coordinatorBlocked.escalated = true;
      parent.coordinatorBlocked.escalatedAt = now;
      appendHistoryEvent(parent, 'advisory',
        `coordinator hub stuck ${Math.floor(stuckForMs / 86400000)}d -- needs a human: ` +
        `resolve/requeue/archive ${stuck.map((s) => s.id).join(', ')}, or archive this hub`);
      summary.escalated = (summary.escalated || 0) + 1;
    }
  } else if (parent.coordinatorBlocked) {
    delete parent.coordinatorBlocked;
    delete parent.blockedReason;
    appendHistoryEvent(parent, 'advisory',
      'coordinator unblocked -- sub-tasks progressing again');
    summary.unblocked = (summary.unblocked || 0) + 1;
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Stage 7 – gate re-arm
// ─────────────────────────────────────────────────────────────────────
function rearmGateIfNeeded(parent, doneCount, total) {
  if (doneCount === total) return;
  if (parent.integrationGate
      && ['failed', 'errored'].includes(parent.integrationGate.status)) {
    parent.integrationGate = { status: 'pending', reArmedAt: new Date().toISOString() };
    delete parent.blockedReason;
    delete parent.coordinatorBlocked;
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Stage 8 – blueprint wiring
//  Returns true when wiring was attempted this tick (caller should
//  `continue`); false when the hub is not in a wiring-eligible state.
// ─────────────────────────────────────────────────────────────────────
function tryBlueprintWiring(parent, file, name, resolvedRepoRoot, runWiring, summary) {
  const allDone = parent.progress.done === parent.subTasks.length;
  if (!(allDone
        && parent.mode === 'stacked'
        && parent.wiringPending
        && (!parent.integrationGate || parent.integrationGate.status === 'pending'))) {
    return false;
  }

  const res = runWiring(parent, resolvedRepoRoot);
  const now = new Date().toISOString();

  if (res && res.ok) {
    parent.wiringPending = false;
    appendHistoryEvent(parent, 'advisory',
      res.skipped
        ? `blueprint wiring already present on ${parent.branch}`
        : `wired ${res.registered} blueprint(s) onto ${parent.branch}` +
          `${res.sha ? ` @ ${res.sha.slice(0, 10)}` : ''}`);
    summary.wired = (summary.wired || 0) + 1;
  } else {
    parent.blockedReason =
      `deterministic blueprint wiring failed on ${parent.branch}: ` +
      `${res && res.detail ? res.detail : 'unknown'}`.slice(0, 600);
    parent.coordinatorBlocked = {
      signature: 'blueprint-wiring:failed',
      since: now,
      escalated: false,
      children: [{
        id: parent.subTasks[parent.subTasks.length - 1].id,
        why: (res && res.detail) || 'wiring failed',
      }],
    };
    appendHistoryEvent(parent, 'blocked', parent.blockedReason);
    summary.wiringFailed = (summary.wiringFailed || 0) + 1;
  }

  try {
    fs.writeFileSync(file, JSON.stringify(parent, null, 2));
    summary.updated += 1;
  } catch (err) {
    console.error(`coordinator-sweep: failed to write ${file}: ${err.message}`);
    summary.errors += 1;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────
//  Stage 9 – gate execution + completion + file write
// ─────────────────────────────────────────────────────────────────────
function runGateAndComplete(parent, file, name, doneDir, resolvedRepoRoot,
                            runGate, runAutoMerge, summary) {
  const allMerged = parent.progress.done === parent.subTasks.length;

  if (allMerged) {
    // All children merged – run the integration gate, then complete.
    const gateResult = runGate(parent, resolvedRepoRoot);
    if (gateResult && gateResult.ok) {
      parent.integrationGate = { status: 'passed', at: new Date().toISOString() };
      parent.status = 'done';
      parent.doneMarker = `all ${parent.subTasks.length} sub-tasks merged; gate passed`;
      stampHubMerged(parent, {
        disposition: 'merged',
        detail: `gate passed; ${parent.subTasks.length} sub-task(s) on ${parent.branch}`,
      });
      appendHistoryEvent(parent, 'done', parent.doneMarker);
      moveToDone(file, doneDir, name, parent);
      summary.completed += 1;
    } else {
      parent.integrationGate = {
        status: gateResult && gateResult.status || 'failed',
        detail: (gateResult && gateResult.detail) || 'gate failed',
        at: new Date().toISOString(),
      };
      parent.blockedReason = `integration gate ${parent.integrationGate.status}`;
      appendHistoryEvent(parent, 'advisory',
        `integration gate ${parent.integrationGate.status}: ` +
        `${(gateResult && gateResult.detail) || 'no detail'}`.slice(0, 400));
    }
  } else if (parent.integrationGate && parent.integrationGate.status === 'pending') {
    // Partial progress – run gate on what is merged so far.
    const gateResult = runGate(parent, resolvedRepoRoot);
    if (gateResult && gateResult.ok) {
      parent.integrationGate.status = 'passed';
      parent.integrationGate.at = new Date().toISOString();
    } else {
      parent.integrationGate.status = gateResult && gateResult.status || 'failed';
      parent.integrationGate.detail = (gateResult && gateResult.detail) || 'gate failed';
      parent.integrationGate.at = new Date().toISOString();
    }
  }

  // Persist the hub state.
  try {
    fs.writeFileSync(file, JSON.stringify(parent, null, 2));
    summary.updated += 1;
  } catch (err) {
    console.error(`coordinator-sweep: failed to write ${file}: ${err.message}`);
    summary.errors += 1;
  }
}
```

### AC-181 · Extract complex git-runner operations to module scope
Strength: Strong
Files: src/git-runner.js
Snippet:
```
 * @param {string} repoRoot - Absolute path to the git repo to operate on.
 */
function createRealGitRunner(repoRoot) {
  const mainBranch = detectDefaultBranch(repoRoot);
  function run(args) {
    return execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe', encoding: 'utf8', env: GIT_ENV, timeout: GIT_TIMEOUT_MS });
  }
  function isAncestor(a, b) {
    try { run(['merge-base', '--is-ancestor', a, b]); return true; } catch { return false; }
  }
  function doResetToMain() {
    try {
      run(['stash', 'push', '-u', '-m', `agent-manager auto-stash before reset ${new Date().toISOString()}`]);
    } catch (e) {
      throw new Error(`auto-stash before resetToMain failed, reset aborted to avoid destroying work: ${e.message}`);
    }
    run(['checkout', mainBranch]);
    run(['fetch', 'origin', mainBranch]);
    const remote = `origin/${mainBranch}`;
    const originInLocal = isAncestor(remote, mainBranch);
    const localInOrigin = isAncestor(mainBranch, remote);
    if (originInLocal && !localInOrigin) {
      if (ungatedMainPushAllowed()) {
        try {
          run(['push', 'origin', `${mainBranch}:${mainBranch}`]);
        } catch (e) {
          throw new Error(`resetToMain: local ${mainBranch} is ahead of origin but fast-forwarding it to origin failed (push rejected -- e.g. a protected branch or a race): ${e.message}`);
        }
      } else {
        // Local main holds commits origin lacks. The old behavior pushed them to origin/main
        // unattended -- exactly what must never happen without a human gate (see
        // lib/main-push-policy.js). Preserve them on a rescue BRANCH (pushed best-effort, so a
        // reset never destroys work) and fall through to the reset. A human decides about them.
        const rescue = `agent/rescued-${mainBranch}-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
        try {
          run(['branch', rescue, mainBranch]);
        } catch (e) {
          throw new Error(`resetToMain: local ${mainBranch} is ahead of origin and could not be rescued to ${rescue} before the reset: ${e.message}`);
        }
        try { run(['push', '-u', 'origin', rescue]); } catch { /* best-effort: the local rescue branch still exists */ }
        console.error(`[git-runner] local ${mainBranch} had commit(s) origin lacks; NOT pushed to ${mainBranch} (no ungated main pushes) -- kept on ${rescue} for a human to review/merge`);
      }
    } else if (!originInLocal && !localInOrigin) {
      throw new Error(`resetToMain: local ${mainBranch} and ${remote} have diverged (each has commit(s) the other lacks) -- needs a human to reconcile, not an automatic reset`);
    }
    run(['reset', '--hard', remote]);
    // Pop the stash created above right back onto the now-reset tree (2026-09-14, fixing
    // the "never popped" hazard this function used to carry -- see the header comment on
    // the returned object below for the full incident history). Confirmed live: the
    // dedicated AGENT_MANAGER_APPLY_REPO_ROOT worktree this runs against is never
    // interactively edited, so there is no live human WIP this could clobber -- unlike
    // the pre-2026-09-07 shape where resetToMain() ran directly against the same checkout
    // a human sometimes edits live, popping immediately was NOT safe (a stray edit could
    // ride back onto the tree right before an automated commit). "No stash entries found"
    // (the overwhelmingly common case -- nothing was stashed) is swallowed as a no-op;
    // any other pop failure (e.g. a real conflict) is logged and swallowed rather than
    // thrown -- the reset itself already succeeded, and git leaves the stash entry intact
    // on a failed pop for manual recovery, so this can never make things worse than the
    // old never-popped behavior, only better.
    try {
      run(['stash', 'pop']);
    } catch (e) {
      const msg = e.stderr ? e.stderr.toString() : e.message;
      if (!/no stash entries found/i.test(msg)) {
        console.error(`[git-runner] stash pop after resetToMain failed (stash entry left in place for manual recovery): ${msg}`);
      }
    }
  }
  return {
    mainBranch,
    fetchMain: () => run(['fetch', 'origin', mainBranch]),
    // Auto-stash before the hard reset instead of silently destroying uncommitted work --
    // this exact `git reset --hard` wiped real, unrecoverable work TWICE in one session
    // (see docs/pipeline-incident-2026-07-19.md and its 2026-07-21 repeat) because this
    // repo is sometimes edited live in the same working tree the pipeline operates on.
    // `-u` includes untracked files. Stashing when there's nothing to stash is a harmless
    // no-op (git prints "No local changes to save", exits 0) -- no separate status check
    // needed. A stash failure (e.g. an in-progress merge/rebase) must not silently fall
    // through to the destructive reset below, so it's re-thrown with context rather than
    // swallowed.
    //
    // FIXED (2026-09-14, was a HAZARD since 2026-09-03): the stash created above is now
    // popped right after the hard reset (see doResetToMain()) instead of being left as a
    // graveyard -- so any untracked/tracked content swept up here round-trips back onto
    // the tree instead of silently vanishing. This used to matter enormously: when
    // pipelineDir === repoRoot, every pipeline runtime-state file lands inside repoRoot,
    // and 90 scanner false-positive suppressions were lost this way over 3 days before
    // the ledgers were ignored. src/pipeline-state-gitignored.test.js still enforces the
    // getConfig()-path .gitignore invariant as defense-in-depth (a state file that's
    // git-ignored is never even stashed in the first place, `git stash -u` skips it
    // outright), independent of this pop fix.
    resetToMain: doResetToMain,
    createBranch: (name) => run(['checkout', '-b', name]),
    checkoutMain: () => run(['checkout', mainBranch]),
    // Checkout an EXISTING branch (stacked file-decompose: move N+1 rides on top of the
    // branch move N already committed to, so it must not reset it away).
    checkoutBranch: (name) => run(['checkout', name]),
    branchExists: (name) => {
      try { run(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]); return true; }
      catch { return false; }
    },
    // 2026-09-08, added alongside prepareStackedBranch below -- checks the REMOTE copy
    // specifically (refs/remotes/origin/<name>), distinct from branchExists' local-only
    // check. A caller must never treat "a local ref with this name exists" as proof the
    // branch is real/current -- see prepareStackedBranch's own header for the incident.
    remoteBranchExists: (name) => {
      try { run(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`]); return true; }
      catch { return false; }
    },
    // Best-effort fetch of one non-main branch (stacked decompose: pick up a prior step's
    // commit if this host's local ref is behind or missing). A failure is non-fatal.
    fetchBranch: (name) => {
      try { return run(['fetch', 'origin', name]); } catch { return ''; }
    },
    // Reset-or-create a local branch to track origin/<name> exactly (stacked decompose,
    // when the local ref is missing or stale but origin has the prior step's commit).
    checkoutTracking: (name) => run(['checkout', '-B', name, `origin/${name}`]),
    deleteBranch: (name) => run(['branch', '-D', name]),
    // 2026-09-08, Grimmethy: "harden it properly with tests" -- root-caused live: apply-
    // task.js's stacked-decompose handling (seq > 1) used to trust branchExists(name)
    // (a LOCAL-only check) as proof the branch was safe to check out, with no check that
    // the local copy was actually current. A 5-day-old, unrelated local branch with the
    // SAME name -- leftover cruft, origin's real copy long since merged and deleted --
    // made every apply attempt check out that stale tree and then fail to apply a diff
    // computed against current main, identically, every single retry (not a race; a
    // permanently wrong decision that would never self-correct). This is the single,
    // self-contained decision resetToMain() already models for the analogous "is my
    // local copy of mainBranch safe to sync from origin" question -- same ahead/behind/
    // diverged reasoning, applied here to a per-hub scratch branch instead:
    //   - origin has it, local doesn't (or local ⊆ origin, i.e. stale/behind/identical):
    //     sync local to origin's tip. Always safe -- local has nothing origin lacks.
    //   - origin has it AND local is STRICTLY ahead (real unpushed commits, e.g. a prior
    //     step's own push failed after a successful commit): trust local as-is, matching
    //     the old default behavior -- never silently discard real unpushed work.
    //   - origin has it and the two have diverged: surface loudly for a human, exactly
    //     like resetToMain's own diverged case -- never guess which side to keep.
    //   - origin doesn't have it, but local descends from CURRENT main: plausibly real,
    //     unpushed work from a step whose push never even started -- trust it.
    //   - origin doesn't have it, and local (if any) does NOT descend from current main:
    //     this is the exact stale-branch case that caused the incident. Discard any such
    //     local branch and fall back to resetToMain() + a fresh branch off it, the same
    //     "the whole prior chain already merged" fallback the seq===1 path already uses
    //     (2026-09-07 reasoning) -- now reached by an actual staleness check instead of
    //     by trusting whatever name happens to exist locally.
    prepareStackedBranch: (name) => {
      try { run(['fetch', 'origin', name]); } catch { /* best-effort, matches fetchBranch */ }
      const remote = `origin/${name}`;
      const remoteExists = (() => {
        try { run(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}`]); return true; } catch { return false; }
      })();
      const localExists = (() => {
        try { run(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]); return true; } catch { return false; }
      })();
      if (remoteExists) {
        if (localExists) {
          const originInLocal = isAncestor(remote, name); // origin ⊆ local (local ahead or equal)
          const localInOrigin = isAncestor(name, remote); // local ⊆ origin (local behind or equal)
          if (originInLocal && !localInOrigin) {
            run(['checkout', name]); // real unpushed commits -- trust local as-is.
            return;
          }
          if (!originInLocal && !localInOrigin) {
            throw new Error(`prepareStackedBranch: local ${name} and ${remote} have diverged (each has commit(s) the other lacks) -- needs a human to reconcile, not an automatic sync`);
          }
        }
        // A ROLLING branch (e.g. TRIAGE_BRANCH) is never explicitly rebased on its own --
        // apply-main-batch.js's own header says so plainly ("based on whatever main was
        // when it was first created and is never rebased"). Every branch of the logic
        // above only ever compares LOCAL to REMOTE; none of it ever asks whether the
        // REMOTE copy itself has fallen behind current main. Root-caused live 2026-09-22:
        // a human merged the branch and deleted it, but a near-concurrent apply cycle
        // recreated it (a real race, or simply this same "trust origin blindly" gap on an
        // OLDER cycle, well before that merge) anchored to a point of main from TWO DAYS
        // earlier -- every apply after that just kept stacking onto that same stale
        // lineage, silently re-including commits that had already separately landed on
        // main (identical SHAs -- confirmed live), one of which was a finding a human had
        // explicitly retracted as a false positive after the fact.
        try { run(['fetch', 'origin', mainBranch]); } catch { /* best-effort, matches fetchMain elsewhere */ }
        if (!isAncestor(`origin/${mainBranch}`, remote)) {
          run(['checkout', '-B', name, remote]);
          try {
            run(['rebase', `origin/${mainBranch}`]);
          } catch (e) {
            try { run(['rebase', '--abort']); } catch { /* best-effort */ }
            throw new Error(
              `prepareStackedBranch: ${remote} is based on a stale point of ${mainBranch} (main has moved on since this rolling branch was last built) and rebasing its still-unmerged commits onto the current tip failed -- needs a human to reconcile, not an automatic sync: ${e.message}`,
            );
          }
          return;
        }
        run(['checkout', '-B', name, remote]); // local missing, or ⊆ origin (stale/behind/identical); remote itself is current
        return;
      }
      if (localExists && isAncestor(`origin/${mainBranch}`, name)) {
        run(['checkout', name]); // no remote copy, but local is real work off current main
        return;
      }
      // No remote copy, and no trustworthy local copy -- discard any stale local branch
      // and start this step fresh off current main (2026-09-07 fallback reasoning: origin
      // having nothing can only mean the whole prior chain already merged).
      if (localExists) { try { run(['branch', '-D', name]); } catch { /* best-effort */ } }
      doResetToMain();
// ... [truncated for review: this function continues for 4 more line(s) not shown]
```

Problem:
The `createRealGitRunner` factory is ~204 lines, but the bulk of that length comes from two genuinely complex inner functions — `doResetToMain` (~55 lines) and `prepareStackedBranch` (~70 lines) — that are trapped inside the closure alongside ~9 trivial one-liner wrappers. `prepareStackedBranch` in particular is a self-contained five-branch decision procedure (remote-ahead, local-ahead, diverged, local-off-main, stale-local) with its own error paths and incident history, yet it is unreachable from any test without constructing the entire runner object and exercising the other eleven properties first. The two complex functions share only three dependencies (`run`, `isAncestor`, `mainBranch`), so their coupling to the factory is incidental, not structural.

Solution:
Promote `doResetToMain` and `prepareStackedBranch` to module-scope functions that accept `(repoRoot, mainBranch, …)` as explicit parameters, and reduce the factory to a thin object-literal of one-liners that delegate to them. The `run` and `isAncestor` helpers move to module scope as well so the extracted functions can call them directly. The nine trivial wrappers (`fetchMain`, `checkoutMain`, `checkoutBranch`, `branchExists`, `remoteBranchExists`, `fetchBranch`, `checkoutTracking`, `deleteBranch`, `createBranch`) stay in the factory — extracting them would add indirection for no gain.

```diff
--- a/src/git-runner.js
+++ b/src/git-runner.js
@@
+// ── module-scope helpers ──────────────────────────────────────────────
+
+function runInRepo(repoRoot, args) {
+  return execFileSync('git', args, {
+    cwd: repoRoot, stdio: 'pipe', encoding: 'utf8',
+    env: GIT_ENV, timeout: GIT_TIMEOUT_MS,
+  });
+}
+
+function isAncestor(repoRoot, a, b) {
+  try { runInRepo(repoRoot, ['merge-base', '--is-ancestor', a, b]); return true; }
+  catch { return false; }
+}
+
+// ── complex operations (independently testable) ───────────────────────
+
+function doResetToMain(repoRoot, mainBranch) {
+  const run = (args) => runInRepo(repoRoot, args);
+  const ancestor = (a, b) => isAncestor(repoRoot, a, b);
+  /* body identical to current inner doResetToMain */
+}
+
+function prepareStackedBranch(repoRoot, mainBranch, name) {
+  const run = (args) => runInRepo(repoRoot, args);
+  const ancestor = (a, b) => isAncestor(repoRoot, a, b);
+  /* body identical to current inline prepareStackedBranch */
+}
+
 // ── factory ───────────────────────────────────────────────────────────
 function createRealGitRunner(repoRoot) {
   const mainBranch = detectDefaultBranch(repoRoot);
   const run = (args) => runInRepo(repoRoot, args);
   return {
     mainBranch,
     fetchMain: () => run(['fetch', 'origin', mainBranch]),
-    resetToMain: doResetToMain,
+    resetToMain: () => doResetToMain(repoRoot, mainBranch),
     createBranch: (name) => run(['checkout', '-b', name]),
     checkoutMain: () => run(['checkout', mainBranch]),
     checkoutBranch: (name) => run(['checkout', name]),
     branchExists: (name) => { /* unchanged */ },
     remoteBranchExists: (name) => { /* unchanged */ },
     fetchBranch: (name) => { /* unchanged */ },
     checkoutTracking: (name) => run(['checkout', '-B', name, `origin/${name}`]),
     deleteBranch: (name) => run(['branch', '-D', name]),
-    prepareStackedBranch: (name) => { /* ~70-line inline body */ },
+    prepareStackedBranch: (name) => prepareStackedBranch(repoRoot, mainBranch, name),
   };
 }
```

Benefits:
Each complex operation becomes a top-level, named, independently-importable unit. A test that wants to verify "diverged → throws" or "stale-local → fetches then checks out" can call `prepareStackedBranch(fixtureRepo, 'main', 'feature/x')` directly with a fixture repository, without constructing the full runner or touching the nine trivial wrappers. Review scope shrinks: a change to the stacked-branch decision tree no longer appears in the same diff hunk as a one-line `checkoutMain` wrapper. The factory itself drops to roughly 25 lines of self-evident delegation, making the object's surface area immediately scannable.

### AC-182 · Decompose renderDiscoveryTab into named builder functions
Strength: Strong
Files: python/dashboard/static/js/analytics-and-discovery.js
Snippet:
```
}

async function renderDiscoveryTab() {
  const d = await fetchJson('/api/discovery');
  discoveryCandidatesCache = d.candidates || [];
  const main = document.getElementById('main');
  if (!d.available) {
    main.innerHTML = '<div class="empty">No discovery state found for the active project -- community-coverage.json and the candidates doc appear once the project graph is built and arch_discovery has run.</div>';
    return;
  }

  const reviewed = d.communities.filter(c => c.lastReviewedAt).length;
  const inFlight = d.tasks.filter(t => t.state !== 'done');
  const doneRuns = d.tasks.filter(t => t.state === 'done');
  const nextCommunity = d.communities.find(c => c.id === d.nextCommunityId);
  const stats = `
    <div class="stat-row">
      <div class="stat"><strong>${reviewed} / ${d.communities.length}</strong>communities reviewed</div>
      <div class="stat"><strong>${inFlight.length}</strong>runs in flight</div>
      <div class="stat"><strong>${doneRuns.length}</strong>runs completed</div>
      <div class="stat"><strong>${d.candidates.length}</strong>candidates produced</div>
      <div class="stat"><strong>${nextCommunity ? escapeHtml(nextCommunity.name) : '--'}</strong>next up</div>
    </div>`;

  // Same order the job itself works in (nextArchDiscoveryTask's oldest-first rotation,
  // never-reviewed before any real timestamp), so the top of the table is always "what
  // discovery cares about right now".
  const sortedCommunities = [...d.communities].sort((a, b) =>
    (a.lastReviewedAt || '').localeCompare(b.lastReviewedAt || ''));
  // Only rows with something to say (in queue, next up, or actually reviewed) show by
  // default; the untouched tail collapses to a one-line count.
  const interesting = sortedCommunities.filter(c =>
    c.inFlightState || c.id === d.nextCommunityId || c.lastReviewedAt);
  const communities = discoveryShowAllCommunities ? sortedCommunities : interesting;
  const hiddenCount = sortedCommunities.length - communities.length;
  const communityRows = communities.map(c => {
    const status = c.inFlightState
      ? `<span class="badge warn">in queue: ${escapeHtml(c.inFlightState)}</span>`
      : c.id === d.nextCommunityId
        ? '<span class="badge ok">next up</span>'
        : c.lastReviewedAt
          ? '<span class="badge idle">reviewed</span>'
          : '<span class="badge idle">never reviewed</span>';
    return `<tr>
      <td>#${c.id} ${escapeHtml(c.name || '')}</td>
      <td>${status}</td>
      <td>${c.lastReviewedAt ? new Date(c.lastReviewedAt).toLocaleString() : ''}</td>
      <td>${c.lastCandidateCount ?? ''}</td>
    </tr>`;
  }).join('');

  const stateBadge = (s) => {
    const cls = s === 'done' ? 'ok' : s === 'blocked' ? 'bad'
      : (s === 'needs-clarification' || s === 'awaiting-confirm') ? 'warn' : 'idle';
    return `<span class="badge ${cls}">${escapeHtml(s)}</span>`;
  };
  const runRows = d.tasks.map(t => {
    // Whichever field carries the run's actual outcome -- same signal priority as
    // _adhoc_task_excerpt server-side.
    const result = t.blockedReason
      ? `<span style="color:var(--bad)">${escapeHtmlBright(t.blockedReason.slice(0, 140))}${t.blockedReason.length > 140 ? '…' : ''}</span>`
      : t.doneMarker
        ? escapeHtml(t.doneMarker)
        : t.hasImplement ? 'draft written' : t.hasPlan ? 'plan written' : '';
    return `<tr class="clickable" data-task-id="${escapeAttr(t.id)}" title="Click for the full readout (plan, draft, review verdicts)">
      <td>${escapeHtmlBright(t.title)}</td>
      <td>${stateBadge(t.state)}</td>
      <td>${t.createdAt ? new Date(t.createdAt).toLocaleString() : ''}</td>
      <td class="meta">${result}</td>
    </tr>`;
  }).join('');
  const runsTable = d.tasks.length === 0
    ? '<div class="empty">No arch-discovery runs in the queue yet.</div>'
    : `<table><thead><tr><th>Run</th><th>State</th><th>Created</th><th>Result</th></tr></thead><tbody>${runRows}</tbody></table>`;

  const candidateRows = d.candidates.map(c => `
    <tr class="clickable" data-candidate-id="${c.id}" title="Click to read the full write-up">
      <td><span class="bd-serial">AC-${String(c.id).padStart(3, '0')}</span></td>
      <td>${escapeHtmlBright(c.title)}</td>
      <td>${c.strength ? `<span class="badge ${c.strength === 'Strong' ? 'ok' : 'idle'}">${escapeHtml(c.strength)}</span>` : ''}</td>
      <td class="meta">${c.files.slice(0, 3).map(escapeHtml).join(', ')}${c.files.length > 3 ? ` +${c.files.length - 3} more` : ''}</td>
    </tr>`).join('');
  const candidatesTable = d.candidates.length === 0
    ? '<div class="empty">No candidates written yet.</div>'
    : `<table><thead><tr><th>ID</th><th>Candidate</th><th>Strength</th><th>Files</th></tr></thead><tbody>${candidateRows}</tbody></table>`;

  const communityToggle = (discoveryShowAllCommunities || hiddenCount > 0)
    ? `<div style="margin:8px 0 0"><button class="secondary" id="discovery-show-all">${
        discoveryShowAllCommunities
          ? 'Show active communities only'
          : `Show all ${sortedCommunities.length} communities (${hiddenCount} never reviewed hidden)`
      }</button></div>`
    : '';

  // Runs and candidates first -- they're what this tab exists to surface; the (large)
  // community rotation table is reference material below them.
  main.innerHTML = stats
    + `<div class="field-label">Discovery Runs</div>` + runsTable
    + `<div class="field-label">Candidates Produced${d.candidatesPath ? ` <span style="text-transform:none;letter-spacing:0">(${escapeHtml(d.candidatesPath)})</span>` : ''}</div>`
    + candidatesTable
    + `<div class="field-label">Communities (rotation order)</div>`
    + `<table><thead><tr><th>Community</th><th>Status</th><th>Last Reviewed</th><th>Candidates Last Run</th></tr></thead><tbody>${communityRows}</tbody></table>`
    + communityToggle;

  main.querySelectorAll('tr[data-task-id]').forEach(row => {
    row.onclick = () => openTaskAnywhere(row.dataset.taskId);
  });
  main.querySelectorAll('tr[data-candidate-id]').forEach(row => {
    row.onclick = () => openDiscoveryCandidate(parseInt(row.dataset.candidateId, 10));
  });
  const toggleBtn = document.getElementById('discovery-show-all');
  if (toggleBtn) toggleBtn.onclick = () => {
    discoveryShowAllCommunities = !discoveryShowAllCommunities;
    renderDiscoveryTab();
  };
}
```

Problem:
`renderDiscoveryTab` spans 114 lines and interleaves five distinct responsibilities—data fetch with an early-exit guard, derived-state computation (stats, sort, filter, hidden-count), three independent table builders (community rows, run rows with an inline `stateBadge` helper, candidate rows), page assembly into `main.innerHTML`, and three separate event-wiring blocks. The length is not merely "a lot of HTML"; it is a composition of concerns that share a single `d` scope and a single mutable `discoveryShowAllCommunities` flag, making it impossible to unit-test any one table builder in isolation without mocking `fetchJson`, the DOM, and module-level state. The inline `stateBadge` arrow function is unnameable and untestable in its current position.

Solution:
Extract five pure, independently-callable helpers—`buildStatsHtml(d)`, `buildCommunityTable(d)`, `stateBadge(s)` (hoisted to module scope), `buildRunsTable(d)`, `buildCandidatesTable(d)`—plus one DOM-binding function `wireDiscoveryEvents(main)`. The orchestrator `renderDiscoveryTab` shrinks to roughly 25 lines: fetch, guard, concatenate the builders in the same order with the same separator strings, then call the event-wiring function. Each builder owns its slice of `d` and introduces no new shared temporaries. The concrete change is shown below:

```js
// ---- extracted helpers (pure, independently testable) ----

function buildStatsHtml(d) {
  const reviewed = d.communities.filter(c => c.lastReviewedAt).length;
  const inFlight = d.tasks.filter(t => t.state !== 'done');
  const doneRuns = d.tasks.filter(t => t.state === 'done');
  const nextCommunity = d.communities.find(c => c.id === d.nextCommunityId);
  return `
    <div class="stat-row">
      <div class="stat"><strong>${reviewed} / ${d.communities.length}</strong>communities reviewed</div>
      <div class="stat"><strong>${inFlight.length}</strong>runs in flight</div>
      <div class="stat"><strong>${doneRuns.length}</strong>runs completed</div>
      <div class="stat"><strong>${d.candidates.length}</strong>candidates produced</div>
      <div class="stat"><strong>${nextCommunity ? escapeHtml(nextCommunity.name) : '--'}</strong>next up</div>
    </div>`;
}

function stateBadge(s) {
  const cls = s === 'done' ? 'ok' : s === 'blocked' ? 'bad'
    : (s === 'needs-clarification' || s === 'awaiting-confirm') ? 'warn' : 'idle';
  return `<span class="badge ${cls}">${escapeHtml(s)}</span>`;
}

function buildCommunityTable(d) {
  const sortedCommunities = [...d.communities].sort((a, b) =>
    (a.lastReviewedAt || '').localeCompare(b.lastReviewedAt || ''));
  const interesting = sortedCommunities.filter(c =>
    c.inFlightState || c.id === d.nextCommunityId || c.lastReviewedAt);
  const communities = discoveryShowAllCommunities ? sortedCommunities : interesting;
  const hiddenCount = sortedCommunities.length - communities.length;

  const communityRows = communities.map(c => {
    const status = c.inFlightState
      ? `<span class="badge warn">in queue: ${escapeHtml(c.inFlightState)}</span>`
      : c.id === d.nextCommunityId
        ? '<span class="badge ok">next up</span>'
        : c.lastReviewedAt
          ? '<span class="badge idle">reviewed</span>'
          : '<span class="badge idle">never reviewed</span>';
    return `<tr>
      <td>#${c.id} ${escapeHtml(c.name || '')}</td>
      <td>${status}</td>
      <td>${c.lastReviewedAt ? new Date(c.lastReviewedAt).toLocaleString() : ''}</td>
      <td>${c.lastCandidateCount ?? ''}</td>
    </tr>`;
  }).join('');

  const communityToggle = (discoveryShowAllCommunities || hiddenCount > 0)
    ? `<div style="margin:8px 0 0"><button class="secondary" id="discovery-show-all">${
        discoveryShowAllCommunities
          ? 'Show active communities only'
          : `Show all ${sortedCommunities.length} communities (${hiddenCount} never reviewed hidden)`
      }</button></div>`
    : '';

  return `<table><thead><tr><th>Community</th><th>Status</th><th>Last Reviewed</th><th>Candidates Last Run</th></tr></thead><tbody>${communityRows}</tbody></table>`
    + communityToggle;
}

function buildRunsTable(d) {
  const runRows = d.tasks.map(t => {
    const result = t.blockedReason
      ? `<span style="color:var(--bad)">${escapeHtmlBright(t.blockedReason.slice(0, 140))}${t.blockedReason.length > 140 ? '…' : ''}</span>`
      : t.doneMarker
        ? escapeHtml(t.doneMarker)
        : t.hasImplement ? 'draft written' : t.hasPlan ? 'plan written' : '';
    return `<tr class="clickable" data-task-id="${escapeAttr(t.id)}" title="Click for the full readout (plan, draft, review verdicts)">
      <td>${escapeHtmlBright(t.title)}</td>
      <td>${stateBadge(t.state)}</td>
      <td>${t.createdAt ? new Date(t.createdAt).toLocaleString() : ''}</td>
      <td class="meta">${result}</td>
    </tr>`;
  }).join('');
  return d.tasks.length === 0
    ? '<div class="empty">No arch-discovery runs in the queue yet.</div>'
    : `<table><thead><tr><th>Run</th><th>State</th><th>Created</th><th>Result</th></tr></thead><tbody>${runRows}</tbody></table>`;
}

function buildCandidatesTable(d) {
  const candidateRows = d.candidates.map(c => `
    <tr class="clickable" data-candidate-id="${c.id}" title="Click to read the full write-up">
      <td><span class="bd-serial">AC-${String(c.id).padStart(3, '0')}</span></td>
      <td>${escapeHtmlBright(c.title)}</td>
      <td>${c.strength ? `<span class="badge ${c.strength === 'Strong' ? 'ok' : 'idle'}">${escapeHtml(c.strength)}</span>` : ''}</td>
      <td class="meta">${c.files.slice(0, 3).map(escapeHtml).join(', ')}${c.files.length > 3 ? ` +${c.files.length - 3} more` : ''}</td>
    </tr>`).join('');
  return d.candidates.length === 0
    ? '<div class="empty">No candidates written yet.</div>'
    : `<table><thead><tr><th>ID</th><th>Candidate</th><th>Strength</th><th>Files</th></tr></thead><tbody>${candidateRows}</tbody></table>`;
}

function wireDiscoveryEvents(main) {
  main.querySelectorAll('tr[data-task-id]').forEach(row => {
    row.onclick = () => openTaskAnywhere(row.dataset.taskId);
  });
  main.querySelectorAll('tr[data-candidate-id]').forEach(row => {
    row.onclick = () => openDiscoveryCandidate(parseInt(row.dataset.candidateId, 10));
  });
  const toggleBtn = document.getElementById('discovery-show-all');
  if (toggleBtn) toggleBtn.onclick = () => {
    discoveryShowAllCommunities = !discoveryShowAllCommunities;
    renderDiscoveryTab();
  };
}

// ---- slimmed-down orchestrator (~25 lines) ----

async function renderDiscoveryTab() {
  const d = await fetchJson('/api/discovery');
  discoveryCandidatesCache = d.candidates || [];
  const main = document.getElementById('main');
  if (!d.available) {
    main.innerHTML = '<div class="empty">No discovery state found for the active project -- community-coverage.json and the candidates doc appear once the project graph is built and arch_discovery has run.</div>';
    return;
  }

  main.innerHTML = buildStatsHtml(d)
    + `<div class="field-label">Discovery Runs</div>` + buildRunsTable(d)
    + `<div class="field-label">Candidates Produced${d.candidatesPath ? ` <span style="text-transform:none;letter-spacing:0">(${escapeHtml(d.candidatesPath)})</span>` : ''}</div>`
    + buildCandidatesTable(d)
    + `<div class="field-label">Communities (rotation order)</div>`
    + buildCommunityTable(d);

  wireDiscoveryEvents(main);
}
```

Benefits:
Each table builder becomes a pure function of `d` (plus the already-module-level `discoveryShowAllCommunities` for the community table), so a developer can call `buildRunsTable(mockPayload)` in a unit test with no DOM, no `fetch`, and no module-state setup. The `stateBadge` helper gains a name and a stable location, making it referenceable from other render paths if needed. The orchestrator reads as a five-line recipe—fetch, guard, compose, wire—rather than a 114-line monolith, which cuts the cognitive cost of reviewing a change to, say, the candidate table from "trace 114 lines of interleaved template and logic" to "read a 20-line pure function." No behavior changes, no new dependencies, no architectural shift; it is a straightforward extract-method refactor that the line-count scanner is (correctly, if bluntly) nudging toward.

### AC-183 · Decompose enterProjectTab: extract sync logic, template, and event wiring
Strength: Strong
Files: python/dashboard/static/js/project-tab.js
Snippet:
```
async function enterProjectTab() {
  // Sync the path input from the server's actual active project on every tab entry, before
  // rendering it. Without this, the input only ever reflected localStorage -- if the active
  // project changed via any OTHER route (hand-editing agent-manager.env, another browser tab,
  // launch.bat) the input would silently keep showing a stale path while "Last configured
  // project" below it correctly showed the truth. Since Start Pipeline acts on the input's
  // value, not on activeRepoRoot, that mismatch could launch a pipeline against the wrong
  // project with no warning. Only overrides on tab entry, not on the 3s poll thereafter, so a
  // deliberate browse-a-different-project session isn't fought by this sync mid-use.
  //
  // Compares against lastSyncedActiveRepoRoot (the last server value we actually observed),
  // NOT against projectPath -- comparing against projectPath meant a typed-but-not-yet-started
  // path (Start Pipeline never ran, so activeRepoRoot on the server never changed) got silently
  // overwritten back to the server's stale/placeholder activeRepoRoot on every single tab
  // revisit, since the two never stopped disagreeing. Bug: "Project File Path ... resets to a
  // non-existent default path each time I navigate to it" (2026-08-18). Only a genuine change
  // in what the server reports since we last looked now counts as "external".
  try {
    const status = await fetchJson('/api/pipeline/status');
    if (status.activeRepoRoot && status.activeRepoRoot !== lastSyncedActiveRepoRoot) {
      lastSyncedActiveRepoRoot = status.activeRepoRoot;
      if (status.activeRepoRoot !== projectPath) setProjectPath(status.activeRepoRoot);
    }
    // Same reasoning as the path sync above: reflect whatever's actually configured
    // server-side (env file / another tab / launch.bat) rather than only ever showing
    // this browser's last local choice.
    if (typeof status.includeApply === 'boolean') {
      includeApply = status.includeApply;
      localStorage.setItem('agentManagerIncludeApply', String(includeApply));
    }
    if (typeof status.skipPush === 'boolean') {
      skipPush = status.skipPush;
      localStorage.setItem('agentManagerSkipPush', String(skipPush));
    }
  } catch (e) { /* dashboard's own status check failed -- fall back to whatever's cached */ }

  const main = document.getElementById('main');
  main.innerHTML = `
    <div style="display:flex;flex-direction:column;height:calc(100vh - 93px);">
      <div class="path-row">
        <select id="project-select" style="flex:1;"><option value="">Loading projects...</option></select>
        <input id="project-path-input" type="text" placeholder="C:\\path\\to\\your\\project" value="${escapeAttr(projectPath)}" list="project-history-list" autocomplete="off" style="display:none;">
        <datalist id="project-history-list"></datalist>
        <button class="secondary" id="history-toggle">History...</button>
        <button class="secondary" id="browse-toggle">Browse...</button>
        <button class="secondary" id="sync-btn" title="Fetch origin and fast-forward this checkout onto it">Sync with GitHub</button>
        <button class="action" id="build-btn">Build Graph</button>
      </div>
      <div id="history-panel" class="browser-panel" style="display:none"></div>
      <div class="path-row">
        <input id="project-grepdirs-input" type="text" placeholder="src, frontend/src, backend/src (optional -- comma-separated, leave blank to scan the whole path)" value="${escapeAttr(grepDirs)}">
      </div>
      <div class="path-row" id="pipeline-toggles-row" style="gap:16px;align-items:center;">
        <label style="display:flex;align-items:center;gap:4px;font-size:0.9em;cursor:pointer;">
          <input type="checkbox" id="include-apply-toggle" ${includeApply ? 'checked' : ''}>
          Enable Apply Runner (writes/commits changes)
        </label>
        <label style="display:flex;align-items:center;gap:4px;font-size:0.9em;cursor:pointer;${includeApply ? '' : 'opacity:.5;'}" title="Applied work is always pushed now (2026-08-17) -- an unpushed branch was silently losing real work over time. This only controls whether the local checkout returns to main after each apply, or stays on the applied branch for inspection.">
          <input type="checkbox" id="skip-push-toggle" ${!includeApply ? 'disabled' : ''} ${!skipPush ? 'checked' : ''}>
          Return to main after each apply (unchecked: stay on the applied branch)
        </label>
        <span class="meta" style="font-size:0.85em;">Which job types run is now controlled from the Job List tab. Applied work is always pushed to the remote for durability, regardless of this toggle.</span>
      </div>
      <div id="browser-panel" class="browser-panel" style="display:none"></div>
      <div id="pipeline-panel" class="worker-card"></div>
      <div id="project-status-area" style="flex:1;min-height:0;display:flex;flex-direction:column;"></div>
    </div>
  `;
  lastRenderedStatusKey = null;  // fresh tab entry -- force the first poll to actually render
  document.getElementById('project-path-input').addEventListener('change', (e) => {
    setProjectPath(e.target.value.trim());
    lastRenderedStatusKey = null;  // switched projects -- old key would wrongly suppress the new render
    refreshProjectStatus();
  });
  document.getElementById('include-apply-toggle').addEventListener('change', (e) => {
    includeApply = e.target.checked;
    localStorage.setItem('agentManagerIncludeApply', String(includeApply));
    const pushToggle = document.getElementById('skip-push-toggle');
    pushToggle.disabled = !includeApply;
    pushToggle.closest('label').style.opacity = includeApply ? '' : '.5';
    if (!includeApply) { pushToggle.checked = false; skipPush = true; localStorage.setItem('agentManagerSkipPush', 'true'); }
  });
  document.getElementById('skip-push-toggle').addEventListener('change', (e) => {
    skipPush = !e.target.checked;
    localStorage.setItem('agentManagerSkipPush', String(skipPush));
  });
  document.getElementById('project-select').addEventListener('change', (e) => {
    if (!e.target.value) return;
    setProjectPath(e.target.value);
    document.getElementById('project-path-input').value = projectPath;
    lastRenderedStatusKey = null;  // switched projects -- old key would wrongly suppress the new render
    refreshProjectStatus();
  });
  document.getElementById('browse-toggle').onclick = () => {
    browserOpen = !browserOpen;
    document.getElementById('browser-panel').style.display = browserOpen ? 'block' : 'none';
    // Manual path entry only makes sense while actively browsing -- otherwise the
    // dropdown (populated from Second Brain's referenced projects) is the only way
    // to pick a project, per the actual ask.
    document.getElementById('project-select').style.display = browserOpen ? 'none' : '';
    document.getElementById('project-path-input').style.display = browserOpen ? '' : 'none';
    if (browserOpen) { browsePath = projectPath || ''; loadBrowsePanel(); }
  };
  document.getElementById('history-toggle').onclick = () => {
    historyOpen = !historyOpen;
    document.getElementById('history-panel').style.display = historyOpen ? 'block' : 'none';
    if (historyOpen) renderHistoryPanel();
  };
  document.getElementById('project-grepdirs-input').addEventListener('change', (e) => {
    grepDirs = e.target.value.trim();
    localStorage.setItem('agentManagerGrepDirs', grepDirs);
  });
  document.getElementById('build-btn').onclick = triggerBuild;
  document.getElementById('sync-btn').onclick = triggerSync;

  await loadProjectHistory();
  await loadProjectDropdown();
  await refreshPipelineStatus();
  await refreshProjectStatus();
  projectStatusInterval = setInterval(() => { refreshPipelineStatus(); refreshProjectStatus(); }, 3000);
}
```

Problem:
`enterProjectTab` spans 121 lines and mixes four distinct responsibilities—server-state reconciliation, HTML template construction, six separate event-handler attachments, and the async load sequence—into a single flat body. The sync block (roughly 15 lines of conditional logic guarding `lastSyncedActiveRepoRoot`, `projectPath`, `includeApply`, and `skipPush`) is the only section with real branching and a documented 2026-08-18 regression, yet it is interleaved with ~35 lines of static markup and ~40 lines of repetitive `getElementById` → `addEventListener` → `localStorage` wiring. Because the sync logic is not independently callable, exercising it in a test requires rendering the full DOM, stubbing `fetchJson`, and driving the entire tab-entry sequence. The repetitive handler pattern also makes adding a new toggle a two-scroll exercise: find the `id` in the template string, then locate the correct handler among six others.

Solution:
Split the body into four named, single-purpose functions: `syncServerState()` (the async fetch-and-reconcile block, now directly testable with a mocked `fetchJson`), `projectTabTemplate()` (returns the HTML string, no logic), `wirePathSelection()` / `wirePipelineToggles()` / `wirePanelsAndActions()` (group the six handlers by concern so the id-to-handler mapping is local), and a slim `enterProjectTab()` entry point that calls them in order. The 2026-08-18 regression comments move directly above the 15 lines of logic they explain, rather than being buried between markup and handlers.

Benefits:
The sync block becomes unit-testable in isolation—mock `fetchJson`, call `syncServerState()`, assert the four mutated variables. Adding a new pipeline toggle is a one-function edit in `wirePipelineToggles()` plus one line in the template, with no scrolling through unrelated handlers. The entry-point body drops from 121 lines to roughly 15, reading as a checklist rather than a monolith, and the regression-context comments are co-located with the code they document.

```js
// ── 1. Server-state reconciliation (extracted, independently testable) ──
async function syncServerState() {
  try {
    const status = await fetchJson('/api/pipeline/status');
    if (status.activeRepoRoot && status.activeRepoRoot !== lastSyncedActiveRepoRoot) {
      lastSyncedActiveRepoRoot = status.activeRepoRoot;
      if (status.activeRepoRoot !== projectPath) setProjectPath(status.activeRepoRoot);
    }
    if (typeof status.includeApply === 'boolean') {
      includeApply = status.includeApply;
      localStorage.setItem('agentManagerIncludeApply', String(includeApply));
    }
    if (typeof status.skipPush === 'boolean') {
      skipPush = status.skipPush;
      localStorage.setItem('agentManagerSkipPush', String(skipPush));
    }
  } catch (e) { /* fall back to cached values */ }
}

// ── 2. HTML template (pure string, no logic) ──
function projectTabTemplate() {
  return `
    <div style="display:flex;flex-direction:column;height:calc(100vh - 93px);">
      <div class="path-row">
        <select id="project-select" style="flex:1;"><option value="">Loading projects...</option></select>
        <input id="project-path-input" type="text" placeholder="C:\\path\\to\\your\\project"
               value="${escapeAttr(projectPath)}" list="project-history-list"
               autocomplete="off" style="display:none;">
        <datalist id="project-history-list"></datalist>
        <button class="secondary" id="history-toggle">History...</button>
        <button class="secondary" id="browse-toggle">Browse...</button>
        <button class="secondary" id="sync-btn" title="Fetch origin and fast-forward">Sync with GitHub</button>
        <button class="action" id="build-btn">Build Graph</button>
      </div>
      <div id="history-panel" class="browser-panel" style="display:none"></div>
      <div class="path-row">
        <input id="project-grepdirs-input" type="text"
               placeholder="src, frontend/src, backend/src (optional)"
               value="${escapeAttr(grepDirs)}">
      </div>
      <div class="path-row" id="pipeline-toggles-row" style="gap:16px;align-items:center;">
        <label style="display:flex;align-items:center;gap:4px;font-size:0.9em;cursor:pointer;">
          <input type="checkbox" id="include-apply-toggle" ${includeApply ? 'checked' : ''}>
          Enable Apply Runner (writes/commits changes)
        </label>
        <label style="display:flex;align-items:center;gap:4px;font-size:0.9em;cursor:pointer;${includeApply ? '' : 'opacity:.5;'}"
               title="Applied work is always pushed now (2026-08-17)…">
          <input type="checkbox" id="skip-push-toggle"
                 ${!includeApply ? 'disabled' : ''} ${!skipPush ? 'checked' : ''}>
          Return to main after each apply
        </label>
        <span class="meta" style="font-size:0.85em;">
          Which job types run is now controlled from the Job List tab.
        </span>
      </div>
      <div id="browser-panel" class="browser-panel" style="display:none"></div>
      <div id="pipeline-panel" class="worker-card"></div>
      <div id="project-status-area" style="flex:1;min-height:0;display:flex;flex-direction:column;"></div>
    </div>`;
}

// ── 3. Event wiring, grouped by concern ──
function wirePathSelection() {
  document.getElementById('project-path-input').addEventListener('change', (e) => {
    setProjectPath(e.target.value.trim());
    lastRenderedStatusKey = null;
    refreshProjectStatus();
  });
  document.getElementById('project-select').addEventListener('change', (e) => {
    if (!e.target.value) return;
    setProjectPath(e.target.value);
    document.getElementById('project-path-input').value = projectPath;
    lastRenderedStatusKey = null;
    refreshProjectStatus();
  });
  document.getElementById('project-grepdirs-input').addEventListener('change', (e) => {
    grepDirs = e.target.value.trim();
    localStorage.setItem('agentManagerGrepDirs', grepDirs);
  });
}

function wirePipelineToggles() {
  document.getElementById('include-apply-toggle').addEventListener('change', (e) => {
    includeApply = e.target.checked;
    localStorage.setItem('agentManagerIncludeApply', String(includeApply));
    const pushToggle = document.getElementById('skip-push-toggle');
    pushToggle.disabled = !includeApply;
    pushToggle.closest('label').style.opacity = includeApply ? '' : '.5';
    if (!includeApply) { pushToggle.checked = false; skipPush = true; localStorage.setItem('agentManagerSkipPush', 'true'); }
  });
  document.getElementById('skip-push-toggle').addEventListener('change', (e) => {
    skipPush = !e.target.checked;
    localStorage.setItem('agentManagerSkipPush', String(skipPush));
  });
}

function wirePanelsAndActions() {
  document.getElementById('browse-toggle').onclick = () => {
    browserOpen = !browserOpen;
    document.getElementById('browser-panel').style.display = browserOpen ? 'block' : 'none';
    document.getElementById('project-select').style.display = browserOpen ? 'none' : '';
    document.getElementById('project-path-input').style.display = browserOpen ? '' : 'none';
    if (browserOpen) { browsePath = projectPath || ''; loadBrowsePanel(); }
  };
  document.getElementById('history-toggle').onclick = () => {
    historyOpen = !historyOpen;
    document.getElementById('history-panel').style.display = historyOpen ? 'block' : 'none';
    if (historyOpen) renderHistoryPanel();
  };
  document.getElementById('build-btn').onclick = triggerBuild;
  document.getElementById('sync-btn').onclick = triggerSync;
}

// ── 4. Entry point: short, readable sequence ──
async function enterProjectTab() {
  await syncServerState();

  const main = document.getElementById('main');
  main.innerHTML = projectTabTemplate();
  lastRenderedStatusKey = null;

  wirePathSelection();
  wirePipelineToggles();
  wirePanelsAndActions();

  await loadProjectHistory();
  await loadProjectDropdown();
  await refreshPipelineStatus();
  await refreshProjectStatus();
  projectStatusInterval = setInterval(() => { refreshPipelineStatus(); refreshProjectStatus(); }, 3000);
}
```

### AC-184 · Decompose autoConfirmReview into classification, outcome, and orchestrator
Strength: Strong
Files: src/auto-confirm-review.js
Snippet:
```
}

async function autoConfirmReview({ pipelineDir, repoRoot, grepDirs, majorityVote, candidatesPath }) {
  const summary = { checked: 0, confirmed: 0, denied: 0, escalated: 0, errors: 0 };
  if (process.env.AGENT_MANAGER_AUTO_CONFIRM_REVIEW === 'false') return summary;

  const dir = path.join(pipelineDir, 'queue', 'awaiting-confirm');
  const approvedDir = path.join(pipelineDir, 'queue', 'approved');
  const archiveDir = path.join(pipelineDir, 'queue', 'done', '_archived_no_action');
  const fixCandidatesPath = candidatesPath || (getConfig().pipelineFixCandidatesPath);

  let names;
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return summary; // no awaiting-confirm/ dir -- nothing to do
  }

  for (const name of names) {
    const file = path.join(dir, name);
    let task;
    try {
      task = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      summary.errors += 1;
      continue;
    }
    if (task.autoConfirmReviewedAt) continue; // already reviewed once -- left for a human

    summary.checked += 1;
    const isForensics = task.source === 'pipeline_forensics';
    const isDebrief = task.source === 'pipeline_debrief';
    const deleteItems = (isForensics || isDebrief) ? [] : parseDeleteItems(task.implementResponse);

    let prompt;
    let gateStamp;
    if (isForensics) {
      prompt = buildForensicsConfirmPrompt(task, readCandidatesDoc(fixCandidatesPath));
      gateStamp = 'forensicsReportConfirmedAt';
    } else if (isDebrief) {
      prompt = buildDebriefConfirmPrompt(task);
      gateStamp = 'debriefReportConfirmedAt';
    } else if (deleteItems.length && batchContainsDeleteMode(task.implementResponse)) {
      const refMap = gatherDeleteReferences(repoRoot, grepDirs, deleteItems.map((i) => i.file), task);
      prompt = buildDeleteConfirmPrompt(task, deleteItems, refMap);
      gateStamp = 'deleteConfirmedAt';
    } else {
      // A hold we don't recognise -- don't guess. Leave it for a human, but stamp so we
      // don't re-check every tick.
      task.autoConfirmReviewedAt = new Date().toISOString();
      task.autoConfirmDecision = 'escalate';
      task.autoConfirmReviewNote = 'auto-confirm review does not recognise this hold type -- left for a human';
      appendHistoryEvent(task, 'advisory', task.autoConfirmReviewNote);
      try { fs.writeFileSync(file, JSON.stringify(task, null, 2)); summary.escalated += 1; }
      catch (err) {
        const taskId = task.id || (task.implementResponse ? task.implementResponse.slice(0, 8) : 'unknown');
        console.error(`[auto-confirm-review] escalate write failed: file=${file} task=${taskId} code=${err.code || ''} message=${err.message}`);
        summary.errors += 1;
      }
      continue;
    }

    let vote;
    try {
      vote = await majorityVote({
        prompt,
        classify: classifyVote(['CONFIRM', 'DENY'], 15),
        n: isDebrief ? DEBRIEF_VOTES : AUTO_CONFIRM_VOTES,
        minAgreeing: isDebrief ? DEBRIEF_MIN_AGREEING : AUTO_CONFIRM_MIN_AGREEING,
        temperature: 0.2,
        source: task.source,
      });
    } catch (e) {
      // Every vote hard-failed (infra). Do NOT stamp -- next tick retries.
      appendHistoryEvent(task, 'advisory', `auto-confirm review could not run (${(e && e.message || 'vote error').slice(0, 160)}) -- will retry`);
      try { fs.writeFileSync(file, JSON.stringify(task, null, 2)); } catch { /* best-effort */ }
      summary.errors += 1;
      continue;
    }

    const now = new Date().toISOString();
    if (vote.confident && vote.verdict === 'CONFIRM') {
      const reason = voteReason(vote, 'CONFIRM');
      task[gateStamp] = now; // 'forensicsReportConfirmedAt' or 'deleteConfirmedAt' -- the field apply-task.js's gate checks
      task.autoConfirmReviewedAt = now;
      task.autoConfirmDecision = 'confirm';
      task.autoConfirmReviewNote = reason;
      task.status = 'approved';
      appendHistoryEvent(task, 'approved', `auto-confirmed (votes: ${vote.realVoteCount}/${vote.requestedVotes}): ${reason}`);
      try {
        const result = moveTaskFile(file, approvedDir, name, task);
        if (result) summary.confirmed += 1;
        else { console.error(`auto-confirm: moveTaskFile returned falsy for ${name} (${file}): ${result}`); summary.errors += 1; }
      } catch (err) { console.error(`auto-confirm: moveTaskFile threw for ${name} (${file}): ${err && err.message || err}`); summary.errors += 1; }
    } else if (vote.confident && vote.verdict === 'DENY') {
      const reason = voteReason(vote, 'DENY');
      task.autoConfirmReviewedAt = now;
      task.autoConfirmDecision = 'deny';
      task.autoConfirmReviewNote = reason;
      task.status = 'done';
      task.doneMarker = `auto-denied at confirm gate: ${reason}`;
      appendHistoryEvent(task, 'archived', `auto-denied (votes: ${vote.realVoteCount}/${vote.requestedVotes}): ${reason}`);
      try {
        if (moveTaskFile(file, archiveDir, name, task)) summary.denied += 1;
        else summary.errors += 1;
      } catch (err) { console.error(`auto-confirm: moveTaskFile threw (DENY) for ${name} (${file}): ${err && err.message || err}`); summary.errors += 1; }
    } else {
      // No confident majority -- leave for a human.
      task.autoConfirmReviewedAt = now;
      task.autoConfirmDecision = 'escalate';
      task.autoConfirmReviewNote = `no confident CONFIRM/DENY majority (votes: ${vote.realVoteCount}/${vote.requestedVotes})`;
      appendHistoryEvent(task, 'advisory', `auto-confirm review inconclusive (${task.autoConfirmReviewNote}) -- held for a human`);
      try { fs.writeFileSync(file, JSON.stringify(task, null, 2)); summary.escalated += 1; }
      catch { summary.errors += 1; }
    }
  }

  return summary;
}
```

Problem:
The 117-line `autoConfirmReview` body interleaves four distinct responsibilities—directory scanning and file I/O, hold-type classification with prompt construction, vote orchestration, and outcome application (three branches that each stamp different fields, write to a different directory, and emit a different history event)—in a single scope. Because the classification dispatch and the three-branch outcome logic are inline in the `for…of` loop, adding a fifth hold type or changing how DENY archives requires navigating the full body, and neither sub-responsibility is independently unit-testable without invoking the entire loop with mocked `fs`, `majorityVote`, and `moveTaskFile`.

Solution:
Extract two focused helpers scoped to this function: `resolveConfirmContext(task, ctx)` which encapsulates the four-way hold-type dispatch (forensics / debrief / delete / unknown) and returns a uniform `{ prompt, gateStamp }` or `{ escalate: true }` shape; and `applyOutcome({ task, file, name, decision, reason, vote, now, gateStamp, dirs, summary })` which encapsulates the shared "stamp three fields → append history → persist → bump summary" skeleton across the confirm / deny / escalate branches. The outer `autoConfirmReview` is reduced to a ~50-line orchestrator: env-guard → readdir → loop { read → skip-if-done → `resolveConfirmContext` → `majorityVote` → `applyOutcome` }.

Benefits:
A reader tracing the happy path sees only the ~50-line orchestrator and jumps into a helper only when needed. Adding a new hold type is a single `if` inside `resolveConfirmContext` with zero risk to the other branches. Changing the DENY archive path is one line in `applyOutcome`. Both helpers are pure-enough to unit-test in isolation: `resolveConfirmContext` can be called with a fixture task and asserted on its return shape without any I/O, and `applyOutcome` can be tested with a stubbed `moveTaskFile` and a mutable summary object.

```js
// ── extracted helper 1 ───────────────────────────────────────────────
function resolveConfirmContext(task, { repoRoot, grepDirs, fixCandidatesPath }) {
  const isForensics = task.source === 'pipeline_forensics';
  const isDebrief   = task.source === 'pipeline_debrief';
  const deleteItems = (isForensics || isDebrief)
    ? []
    : parseDeleteItems(task.implementResponse);

  if (isForensics) {
    return {
      prompt:    buildForensicsConfirmPrompt(task, readCandidatesDoc(fixCandidatesPath)),
      gateStamp: 'forensicsReportConfirmedAt',
    };
  }
  if (isDebrief) {
    return {
      prompt:    buildDebriefConfirmPrompt(task),
      gateStamp: 'debriefReportConfirmedAt',
    };
  }
  if (deleteItems.length && batchContainsDeleteMode(task.implementResponse)) {
    const refMap = gatherDeleteReferences(
      repoRoot, grepDirs, deleteItems.map((i) => i.file), task,
    );
    return {
      prompt:    buildDeleteConfirmPrompt(task, deleteItems, refMap),
      gateStamp: 'deleteConfirmedAt',
    };
  }
  return { escalate: true };
}

// ── extracted helper 2 ───────────────────────────────────────────────
function applyOutcome({ task, file, name, decision, reason, vote, now,
                        gateStamp, dirs, summary }) {
  const { approvedDir, archiveDir } = dirs;
  const voteStr = `votes: ${vote.realVoteCount}/${vote.requestedVotes}`;

  task.autoConfirmReviewedAt = now;
  task.autoConfirmDecision   = decision;
  task.autoConfirmReviewNote = reason;

  if (decision === 'confirm') {
    task[gateStamp] = now;
    task.status     = 'approved';
    appendHistoryEvent(task, 'approved', `auto-confirmed (${voteStr}): ${reason}`);
    try {
      const ok = moveTaskFile(file, approvedDir, name, task);
      if (ok) summary.confirmed += 1;
      else { console.error(`auto-confirm: moveTaskFile falsy for ${name}`); summary.errors += 1; }
    } catch (err) {
      console.error(`auto-confirm: moveTaskFile threw (CONFIRM) ${name}: ${err?.message || err}`);
      summary.errors += 1;
    }
  } else if (decision === 'deny') {
    task.status     = 'done';
    task.doneMarker = `auto-denied at confirm gate: ${reason}`;
    appendHistoryEvent(task, 'archived', `auto-denied (${voteStr}): ${reason}`);
    try {
      if (moveTaskFile(file, archiveDir, name, task)) summary.denied += 1;
      else summary.errors += 1;
    } catch (err) {
      console.error(`auto-confirm: moveTaskFile threw (DENY) ${name}: ${err?.message || err}`);
      summary.errors += 1;
    }
  } else { // 'escalate'
    appendHistoryEvent(task, 'advisory',
      `auto-confirm review inconclusive (${reason}) -- held for a human`);
    try { fs.writeFileSync(file, JSON.stringify(task, null, 2)); summary.escalated += 1; }
    catch { summary.errors += 1; }
  }
}

// ── slimmed orchestrator (~50 lines) ─────────────────────────────────
async function autoConfirmReview({ pipelineDir, repoRoot, grepDirs, majorityVote, candidatesPath }) {
  const summary = { checked: 0, confirmed: 0, denied: 0, escalated: 0, errors: 0 };
  if (process.env.AGENT_MANAGER_AUTO_CONFIRM_REVIEW === 'false') return summary;

  const dir             = path.join(pipelineDir, 'queue', 'awaiting-confirm');
  const approvedDir     = path.join(pipelineDir, 'queue', 'approved');
  const archiveDir      = path.join(pipelineDir, 'queue', 'done', '_archived_no_action');
  const fixCandidatesPath = candidatesPath || getConfig().pipelineFixCandidatesPath;
  const dirs = { approvedDir, archiveDir };

  let names;
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); }
  catch { return summary; }

  for (const name of names) {
    const file = path.join(dir, name);
    let task;
    try { task = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { summary.errors += 1; continue; }

    if (task.autoConfirmReviewedAt) continue;
    summary.checked += 1;

    const ctx = resolveConfirmContext(task, { repoRoot, grepDirs, fixCandidatesPath });
    if (ctx.escalate) {
      const now = new Date().toISOString();
      task.autoConfirmReviewedAt = now;
      task.autoConfirmDecision   = 'escalate';
      task.autoConfirmReviewNote = 'unrecognised hold type -- left for a human';
      appendHistoryEvent(task, 'advisory', task.autoConfirmReviewNote);
      try { fs.writeFileSync(file, JSON.stringify(task, null, 2)); summary.escalated += 1; }
      catch (err) {
        console.error(`[auto-confirm-review] escalate write failed: ${file} ${err.code || ''} ${err.message}`);
        summary.errors += 1;
      }
      continue;
    }

    let vote;
    try {
      vote = await majorityVote({
        prompt:      ctx.prompt,
        classify:    classifyVote(['CONFIRM', 'DENY'], 15),
        n:           task.source === 'pipeline_debrief' ? DEBRIEF_VOTES : AUTO_CONFIRM_VOTES,
        minAgreeing: task.source === 'pipeline_debrief' ? DEBRIEF_MIN_AGREEING : AUTO_CONFIRM_MIN_AGREEING,
        temperature: 0.2,
        source:      task.source,
      });
    } catch (e) {
      appendHistoryEvent(task, 'advisory',
        `auto-confirm review could not run (${(e?.message || 'vote error').slice(0, 160)}) -- will retry`);
      try { fs.writeFileSync(file, JSON.stringify(task, null, 2)); } catch { /* best-effort */ }
      summary.errors += 1;
      continue;
    }

    const now      = new Date().toISOString();
    const decision = vote.confident ? vote.verdict.toLowerCase() : 'escalate';
    const reason   = vote.confident
      ? voteReason(vote, vote.verdict)
      : `no confident CONFIRM/DENY majority (votes: ${vote.realVoteCount}/${vote.requestedVotes})`;

    applyOutcome({ task, file, name, decision, reason, vote, now,
                   gateStamp: ctx.gateStamp, dirs, summary });
  }

  return summary;
}
```

### AC-185 · Decompose validatePlan into per-regime helpers
Strength: Strong
Files: src/file-decompose-to-hub.js
Snippet:
```
// hardProblems block the whole plan (hub filed blocked, no children). Shared deps do not
// block -- they are threaded into the move + wiring prompts.
function validatePlan(repoRoot, request) {
  const hardProblems = [];
  const moveMeta = [];
  const allMovedSymbols = new Set();
  for (const m of request.moves) for (const s of (m.symbols || [])) allMovedSymbols.add(s);

  // A plain CommonJS source (src/*.js) -- neither an HTML <script> nor a .py. Run the
  // whole plan through decompose-node-module.js once: it chains the N moves and only
  // succeeds if EVERY move is a self-contained set of top-level function declarations
  // (references only each other + require()d names + JS globals). ok -> every move gets
  // nodeModuleApplyOk (the .js analogue of deterministicApplyOk); not-ok -> one hard
  // problem with the exact reason. The move `kind` (script-extract vs module-extract) is
  // irrelevant here -- .js wiring is require()/module.exports either way.
  //
  // 2026-09-14, screaminggoatclubmt: "Harden [this]" -- caught live: this branch used to
  // match ANY .js source by extension alone, with zero regard for whether it's actually a
  // Node CommonJS module. python/dashboard/static/js/*.js files are loaded via a plain
  // browser `<script src>` tag (see index.html) -- no bundler, no Node runtime, `require`
  // is not a defined identifier there at all. The produced split used real
  // require()/module.exports wiring anyway, which would have thrown "require is not
  // defined" the instant the browser loaded it, breaking the Models/Deep-Dive/Discovery/
  // Tokenfold tabs -- caught before merge only because this session verifies every branch
  // for real before recommending one. looksLikeNodeCommonJsModule (require()/module.exports
  // ANYWHERE in the source) gates this branch now; every real Node module in this repo has
  // at least one of those (confirmed: 0 occurrences across every static/js/*.js file,
  // 20+ each across a sample of real src/*.js modules). A file that fails this gate falls
  // through to the generic per-move loop below, which already handles `script-extract`
  // moves in a browser-safe way (staticCheckScriptExtractMove, verbatim extraction, no
  // require()/module.exports wiring at all) -- built and proven for plain .js sources
  // back on 2026-09-08 (review-task.js), just never reachable for THIS class of file
  // because this earlier, broader check always intercepted it first.
  if (/\.(js|mjs|cjs)$/.test(request.sourceFile || '')) {
    let sourceText = null;
    try { sourceText = fs.readFileSync(path.join(repoRoot, request.sourceFile), 'utf8'); } catch { /* unreadable -> advisory only */ }
    if (sourceText != null && looksLikeNodeCommonJsModule(sourceText)) {
      const built = buildNodeModuleOnePassChanges(sourceText, request.sourceFile, request.moves.map((m) => ({ newFile: m.newFile, symbols: m.symbols || [] })), repoRoot);
      if (built.ok) {
        for (const _m of request.moves) moveMeta.push({ sharedDeps: [], neededImports: [], nodeModuleApplyOk: true });
      } else {
        hardProblems.push(`${request.sourceFile}: ${built.reason}`);
        for (const _m of request.moves) moveMeta.push({ sharedDeps: [], neededImports: [] });
      }
      return { ok: hardProblems.length === 0, hardProblems, moveMeta };
    }
    // Unreadable, OR readable but not a CommonJS module -- fall through to the generic
    // per-move loop below rather than returning here.
  }

  // A .py source whose plan is ALL flask-blueprint moves: run the whole plan through
  // decompose-flask-blueprint.js once (AST extract + py_compile). ok -> every move gets
  // blueprintApplyOk and fileHub short-circuits to a single deterministic one-pass task
  // (no hub, no per-move 27B agentic pass -- which on a large app.py runs out of turn
  // budget before finishing: the 2026-09-09 blueprint hub). not-ok -> one hard problem.
  // A MIXED .py plan (some blueprint, some not) still falls through to the per-move path.
  if (process.env.AGENT_MANAGER_DECOMPOSE_BLUEPRINT !== 'false'
      && /\.py$/.test(request.sourceFile || '') && request.moves.length
      && request.moves.every((m) => m.kind === 'flask-blueprint' && m.blueprint)) {
    let sourceText = null;
    try { sourceText = fs.readFileSync(path.join(repoRoot, request.sourceFile), 'utf8'); } catch { /* unreadable -> advisory only */ }
    if (sourceText != null) {
      const built = buildBlueprintOnePassChanges(sourceText, request.sourceFile,
        request.moves.map((m) => ({ newFile: m.newFile, blueprint: m.blueprint, symbols: m.symbols || [] })));
      if (built.ok) {
        for (const _m of request.moves) moveMeta.push({ sharedDeps: [], neededImports: [], blueprintApplyOk: true });
      } else {
        hardProblems.push(`${request.sourceFile}: ${built.reason}`);
        for (const _m of request.moves) moveMeta.push({ sharedDeps: [], neededImports: [] });
      }
    } else {
      for (const _m of request.moves) moveMeta.push({ sharedDeps: [], neededImports: [] });
    }
    return { ok: hardProblems.length === 0, hardProblems, moveMeta };
  }

  for (const move of request.moves) {
    const symbols = move.symbols || [];
    const meta = { sharedDeps: [], neededImports: [] };
    if (symbols.length === 0) {
      hardProblems.push(`${move.newFile}: move has no symbols`);
      moveMeta.push(meta);
      continue;
    }
    if (move.kind === 'script-extract') {
      const seCheck = staticCheckScriptExtractMove(repoRoot, request.sourceFile, symbols);
      if (seCheck && seCheck.resolvable) {
        if (!seCheck.ok) {
          hardProblems.push(`${move.newFile}: ${seCheck.missing.join(', ')} could not be located as top-level function declarations in ${request.sourceFile}`);
        } else {
          // Every symbol resolves cleanly -- this move can skip the model entirely at
          // apply time (see local-draft.js's tryDeterministicScriptExtractEdit).
          meta.deterministicApplyOk = true;
        }
      }
      moveMeta.push(meta);
      continue;
    }
    const check = staticCheckMove(repoRoot, request.sourceFile, symbols);
    if (check) {
      if (check.missing && check.missing.length) {
        hardProblems.push(`${move.newFile}: ${check.missing.join(', ')} not defined at module scope in ${request.sourceFile}`);
      }
      const strays = Object.entries(check.externalRefs || {});
      if (strays.length) {
        hardProblems.push(`${move.newFile}: ${strays.map(([s, lines]) => `${s} is still referenced elsewhere in ${request.sourceFile} (line(s) ${lines.slice(0, 6).join(', ')})`).join('; ')} -- not a self-contained move`);
      }
      // `app` is expected for a flask-blueprint move (every @app.route becomes
      // @<bp>.route); anything else that resolves to an app.py module-level name and is
      // not itself being moved becomes a cross-module import.
      meta.sharedDeps = (check.sharedDeps || []).filter((d) => {
        if (d === 'app' && move.kind === 'flask-blueprint') return false;
        return !allMovedSymbols.has(d);
      });
      meta.neededImports = check.neededImports || [];
    }
    moveMeta.push(meta);
  }
  return { ok: hardProblems.length === 0, hardProblems, moveMeta };
}
```

Problem:
`validatePlan` is ~118 lines long because it inlines three structurally different validation regimes that merely share an accumulator shape: a CommonJS one-pass branch (read file → `looksLikeNodeCommonJsModule` gate → `buildNodeModuleOnePassChanges` → early return), a Flask-blueprint one-pass branch (read file → `buildBlueprintOnePassChanges` → early return), and a generic per-move loop whose body itself contains three sub-branches (`symbols.length === 0`, `script-extract`, and the generic `staticCheckMove` path). The two one-pass branches are near-duplicates of each other (read → build → push `moveMeta` per move → return), differing only in the builder call and the `*ApplyOk` flag name, so any change to `moveMeta` population or the `hardProblems` message format must be made in two places. The generic loop's `script-extract` sub-branch is a self-contained check that cannot be unit-tested without invoking the entire 118-line function. The length is a symptom of real branching complexity, not a long linear literal, so decomposition is a genuine maintainability improvement.

Solution:
Extract the per-move body (the largest single block and the most independently testable unit) into a named function `validateGenericMove` that takes the move, the request context, and the pre-built `allMovedSymbols` set, and returns `{ meta, hardProblems }`. The two one-pass branches remain inline in `validatePlan` because they have a subtle asymmetry the original code relies on: the `.js` branch falls through to the generic loop when the file is unreadable or fails the CommonJS gate, whereas the `.py` branch returns immediately even when unreadable (with empty `moveMeta`). Forcing both through a shared helper would require an extra flag to encode that distinction, which is less clear than keeping them explicit. The concrete change is the extraction of the per-move body:

```js
function validateGenericMove(repoRoot, request, move, allMovedSymbols) {
  const symbols = move.symbols || [];
  const meta = { sharedDeps: [], neededImports: [] };
  const hardProblems = [];

  if (symbols.length === 0) {
    hardProblems.push(`${move.newFile}: move has no symbols`);
    return { meta, hardProblems };
  }

  if (move.kind === 'script-extract') {
    const seCheck = staticCheckScriptExtractMove(repoRoot, request.sourceFile, symbols);
    if (seCheck && seCheck.resolvable) {
      if (!seCheck.ok) {
        hardProblems.push(
          `${move.newFile}: ${seCheck.missing.join(', ')} could not be located as top-level function declarations in ${request.sourceFile}`
        );
      } else {
        meta.deterministicApplyOk = true;
      }
    }
    return { meta, hardProblems };
  }

  const check = staticCheckMove(repoRoot, request.sourceFile, symbols);
  if (check) {
    if (check.missing && check.missing.length) {
      hardProblems.push(
        `${move.newFile}: ${check.missing.join(', ')} not defined at module scope in ${request.sourceFile}`
      );
    }
    const strays = Object.entries(check.externalRefs || {});
    if (strays.length) {
      hardProblems.push(
        `${move.newFile}: ${strays
          .map(([s, lines]) => `${s} is still referenced elsewhere in ${request.sourceFile} (line(s) ${lines.slice(0, 6).join(', ')})`)
          .join('; ')} -- not a self-contained move`
      );
    }
    meta.sharedDeps = (check.sharedDeps || []).filter((d) => {
      if (d === 'app' && move.kind === 'flask-blueprint') return false;
      return !allMovedSymbols.has(d);
    });
    meta.neededImports = check.neededImports || [];
  }

  return { meta, hardProblems };
}
```

`validatePlan` then replaces the inline `for (const move of request.moves) { … }` body with:

```js
  const hardProblems = [];
  const moveMeta = [];
  for (const move of request.moves) {
    const { meta, hardProblems: moveProblems } = validateGenericMove(repoRoot, request, move, allMovedSymbols);
    hardProblems.push(...moveProblems);
    moveMeta.push(meta);
  }
  return { ok: hardProblems.length === 0, hardProblems, moveMeta };
```

Benefits:
`validateGenericMove` can be unit-tested in isolation: feed a `script-extract` move and assert `deterministicApplyOk` is set, feed a move with empty `symbols` and assert the "no symbols" hard problem, or feed a generic move with a stubbed `staticCheckMove` return and verify the `sharedDeps` / `neededImports` / stray-reference logic. The two one-pass branches remain visible at the top of `validatePlan` where their asymmetry (fall-through vs. early-return on unreadable) is immediately apparent, and the duplicated `for (const _m of request.moves) moveMeta.push(...)` loops that previously appeared in all three regimes are now each local to their branch, so a change to `moveMeta` shape is a one-line edit per branch rather than a search-and-replace across a 118-line function.

### AC-186 · Decompose `loadSecondBrainBrowser` into fetch, render, and handler functions
Strength: Strong
Files: python/dashboard/static/js/brain-dump-and-second-brain.js
Snippet:
```
}

async function loadSecondBrainBrowser() {
  const panel = document.getElementById('bd-browser');
  if (!panel) return;
  panel.innerHTML = '<div class="empty">Loading...</div>';
  let data;
  try {
    data = await fetchJson('/api/second-brain/browse?path=' + encodeURIComponent(brainDumpBrowsePath));
  } catch (e) {
    // brainDumpBrowsePath is persisted in localStorage across sessions -- a folder it
    // points at can legitimately stop existing between visits (renamed, merged, deleted
    // outside the dashboard entirely, e.g. by hand or by another tool), which otherwise
    // permanently wedges this panel on a dead 404 with no way back short of clearing
    // localStorage yourself. Confirmed live 2026-08-16: the "projects"/"Projects"
    // case-duplicate folders got merged, and a browser that had "projects" saved from
    // before the merge 404'd here forever after. Fall back to root once rather than
    // leaving a stale path permanently wedged.
    if (brainDumpBrowsePath !== '') {
      brainDumpBrowsePath = '';
      localStorage.setItem('agentManagerBrainDumpBrowsePath', '');
      try {
        data = await fetchJson('/api/second-brain/browse?path=');
      } catch (e2) {
        panel.innerHTML = `<div class="empty">Could not browse: ${e2.message}</div>`;
        return;
      }
    } else {
      panel.innerHTML = `<div class="empty">Could not browse: ${e.message}</div>`;
      return;
    }
  }

  if (!data.configured) {
    panel.innerHTML = '<div class="empty">SECOND_BRAIN_DIR is not configured for the active project.</div>';
    return;
  }

  // A plain path-as-text crumb here previously gave no way back to the root except
  // clicking "up" once per level -- easy to end up parked deep in a small folder (e.g.
  // Decisions/, 2 files) after a "jump to file" link, with no obvious cue you're not
  // looking at the whole second brain. Every segment (including "Second Brain" itself)
  // is now a clickable jump-to-that-level link, reusing the same [data-nav] wiring the
  // existing browser-entry rows already use below (attribute selector, not class-scoped).
  const crumbSegments = data.path ? data.path.split('/') : [];
  let crumbHtml = `<span class="crumb-link" data-nav="">Second Brain</span>`;
  let acc = '';
  for (const seg of crumbSegments) {
    acc = acc ? `${acc}/${seg}` : seg;
    crumbHtml += ` / <span class="crumb-link" data-nav="${escapeAttr(acc)}">${escapeHtml(seg)}</span>`;
  }
  let html = `<div class="browser-crumb">${crumbHtml}</div>`;
  if (data.parent !== null) {
    html += `<div class="browser-entry" data-nav="${escapeAttr(data.parent)}"><span>.. (up)</span></div>`;
  }
  for (const entry of data.entries) {
    if (entry.isDir) {
      // Population count: direct children only (files + subfolders) -- null means the
      // folder couldn't be read (permissions), distinct from a genuinely empty "0".
      const countLabel = entry.count === null ? '?' : entry.count;
      html += `<div class="browser-entry" data-nav="${escapeAttr(entry.path)}"><span>${escapeHtml(entry.name)}/</span><span class="entry-count">${countLabel}</span></div>`;
    } else {
      const active = entry.path === brainDumpSelectedFile ? ' active' : '';
      // Notes linked to a real GitHub repo (via /api/second-brain/sync-github-projects)
      // get a one-click way to make that repo the pipeline's active project, or a badge
      // if it already is -- the actual ask: buttons in Second Brain that set a project
      // active, so every GitHub project is reachable AND actionable from here.
      let projectControl = '';
      if (entry.repoPath) {
        projectControl = entry.isActiveProject
          ? `<span class="badge ok" title="${escapeAttr(entry.repoPath)}">Active Project</span>`
          : `<button type="button" class="secondary set-active-project" data-repo-path="${escapeAttr(entry.repoPath)}" title="Stop the current pipeline and start it against ${escapeAttr(entry.repoPath)}">Set Active</button>`;
      } else if (entry.name.toLowerCase().endsWith('.md') && !entry.name.startsWith('_')) {
        // Project-starter notes (not yet linked to any repo, and not a _template.md-style
        // scaffold) get a way to actually become a project -- the ask: "turn these project
        // starters into actual projects" via a button next to the note.
        projectControl = `<button type="button" class="secondary create-github-project" data-note-path="${escapeAttr(entry.path)}" title="Create a new git repo seeded from this note's content">Create GitHub Project</button>`;
      }
      html += `<div class="browser-entry${active}" data-file="${escapeAttr(entry.path)}"><span>${escapeHtml(entry.name)}</span>${projectControl}</div>`;
    }
  }
  panel.innerHTML = html;

  panel.querySelectorAll('[data-nav]').forEach((el) => {
    el.onclick = () => {
      brainDumpBrowsePath = el.dataset.nav;
      localStorage.setItem('agentManagerBrainDumpBrowsePath', brainDumpBrowsePath);
      loadSecondBrainBrowser();
    };
  });
  panel.querySelectorAll('.set-active-project').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation(); // don't also trigger the row's data-file "open note" handler
      const repoPath = btn.dataset.repoPath;
      if (!confirm(`Stop the current pipeline (if running) and start it against:\n${repoPath}\n\nStarts in the safe default (no apply/no push) -- switch that on later from the Project tab if you want it to write changes.`)) return;
      btn.disabled = true;
      btn.textContent = 'Switching...';
      try {
        await fetch('/api/pipeline/stop', { method: 'POST' });
        const resp = await fetch('/api/pipeline/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: repoPath, includeApply: false, skipPush: true }),
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(err.description || ('HTTP ' + resp.status));
        }
        await loadSecondBrainBrowser();
      } catch (err) {
        alert('Could not switch active project: ' + err.message);
        btn.disabled = false;
        btn.textContent = 'Set Active';
      }
    };
  });
  panel.querySelectorAll('.create-github-project').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation(); // don't also trigger the row's data-file "open note" handler
      const notePath = btn.dataset.notePath;
      if (!confirm(`Create a new GitHub project seeded from this note?\n\nThis creates a new folder + git repo under your GitHub projects directory, with this note's content as README.md, and links the note to it here.`)) return;
      btn.disabled = true;
      btn.textContent = 'Creating...';
      try {
        const resp = await fetch('/api/second-brain/create-github-project', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ notePath }),
        });
        const result = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(result.description || ('HTTP ' + resp.status));
        await loadSecondBrainBrowser();
        alert(`Created ${result.projectName} at ${result.repoPath}`);
      } catch (err) {
        alert('Could not create GitHub project: ' + err.message);
        btn.disabled = false;
        btn.textContent = 'Create GitHub Project';
      }
    };
  });
  panel.querySelectorAll('[data-file]').forEach((el) => {
    el.onclick = () => loadSecondBrainFile(el.dataset.file);
  });
}
```

Problem:
`loadSecondBrainBrowser` spans 142 lines and interleaves four responsibilities with different side-effect profiles: a stateful fetch with stale-path recovery that mutates `brainDumpBrowsePath` and `localStorage`, a pure HTML-string builder (breadcrumb + entry loops with `isDir`/`repoPath`/`.md` branching), and two multi-step async handlers (`.set-active-project`, `.create-github-project`) each carrying confirm → disable → fetch → error-revert logic. A developer fixing the stale-path fallback must scroll past ~80 lines of HTML construction and handler wiring; a developer adding a new entry-type badge must wade through the fetch state-mutation and the async handlers. The two async handlers are each ~20 lines of non-trivial control flow that are independently testable only if extracted.

Solution:
Extract four named functions from the 142-line body, leaving a ~30-line orchestrator. The concrete shape:

```js
// 1. Stateful fetch + stale-path recovery
async function fetchBrowseData(path) {
  try {
    return await fetchJson('/api/second-brain/browse?path=' + encodeURIComponent(path));
  } catch (e) {
    if (path !== '') {
      brainDumpBrowsePath = '';
      localStorage.setItem('agentManagerBrainDumpBrowsePath', '');
      return await fetchJson('/api/second-brain/browse?path=');
    }
    throw e;
  }
}

// 2. Pure HTML builder (no I/O, no state mutation)
function buildBrowserHtml(data, selectedFile) {
  let html = '';
  // breadcrumb loop …
  // entry loop with isDir / repoPath / .md branching …
  return html;
}

// 3. Async handlers (one per action)
async function handleSetActiveProject(btn, repoPath) {
  // confirm → disable → fetch → error-revert
}
async function handleCreateGithubProject(btn, notePath) {
  // confirm → disable → POST → error-revert
}

// 4. Thin orchestrator (~30 lines)
async function loadSecondBrainBrowser() {
  const panel = document.getElementById('bd-browser');
  if (!panel) return;
  panel.innerHTML = '<div class="empty">Loading…</div>';

  let data;
  try {
    data = await fetchBrowseData(brainDumpBrowsePath);
  } catch (e) {
    panel.innerHTML = `<div class="empty">Could not browse: ${e.message}</div>`;
    return;
  }
  if (!data.configured) { /* … */ return; }

  panel.innerHTML = buildBrowserHtml(data, brainDumpSelectedFile);

  // wire [data-nav], .set-active-project, .create-github-project, [data-file]
  //   each handler is now a one-liner calling the extracted function
}
```

Each extracted piece is scoped to exactly this function's existing logic; no new behavior is introduced.

Benefits:
The orchestrator drops from 142 to ~30 lines and reads top-to-bottom as a single narrative. `fetchBrowseData` (12 lines) can be unit-tested with a mocked `fetchJson` to verify the stale-path reset and retry without touching the DOM. `buildBrowserHtml` is a pure function of `(data, selectedFile)` and can be tested with fixture data and snapshot assertions. Each async handler is independently testable with a mocked `fetch` and a stubbed button element. Code review of any one concern no longer requires scanning the other three, and the 2026-08-16 "projects" merge incident's stale-path semantics become a 12-line function that is trivially diffable in a PR.
