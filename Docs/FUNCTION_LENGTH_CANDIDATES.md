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

### AC-5 · Decompose reviewTask's multi-responsibility body
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

### AC-6 · Decompose reviewTask's mixed path-resolution, grounding I/O, and verdict-assembly responsibilities
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
The 266-line body of `reviewTask` interleaves at least four independent concerns that each have their own failure domain and input surface: per-source path resolution with filesystem existence checks and JSON parsing of a coverage file (the `repoRootForCheck` block with its growing `else if` chain over `task.source`), grounding-text preparation via a temp-file write and `execFileSync` call to `get-grounding-source.js` with best-effort `finally` cleanup, the `checkDraft` invocation and its `undefined`-grounding fallback glue, and the prompt-assembly / LLM round-trip / verdict-shaping pipeline that the `buildVerdictPrompt` comment references. Because all of these live in one flat block, a regression in the `brain_dump_sort` path-resolution branch (exactly the 2026-08-16 bug the historical comment describes) is only discoverable by reading through the grounding I/O and prompt code to understand why the resolved root matters downstream. Each new task source adds another `else if` arm, each new grounding strategy touches the temp-file block, and each prompt tweak ripples through the same 266 lines—making the function a compounding-change hotspot rather than a linear pipeline.

Solution:
Extract four named helpers, each owning exactly one failure domain, and reduce `reviewTask` to a ~40–60-line orchestrator that calls them in sequence. First, `resolveRepoRootForCheck(task, workDir, ctx)` encapsulates the per-source branching, filesystem `existsSync` checks, coverage-file JSON parse, and returns a small `{ repoRoot, sourceKind }` record; the historical-bug comment moves with it. Second, `buildGroundingText(task, repoRoot)` owns the temp-file write, `execFileSync` invocation of `get-grounding-source.js`, stdout capture, and the `finally` cleanup, returning a string (empty on failure) so the orchestrator never sees an I/O exception. Third, the `checkDraft` call-site glue—deciding what arguments to pass and handling the `undefined` grounding fallback—collapses into a one-line call now that `buildGroundingText` has a stable return contract. Fourth, `buildVerdictPrompt(task, factCheckResult, grounding)` (already referenced in the comment) is made an explicit top-level function if it is not already, and the LLM API call plus response-shape validation become a fifth helper, `invokeAndParseVerdict(prompt, ctx)`. The orchestrator then reads as a short, ordered list of steps with no inline branching over `task.source` and no raw `execFileSync` in its body.

Benefits:
Each extracted helper can be unit-tested in isolation: `resolveRepoRootForCheck` against a fixture task object and a mocked filesystem, `buildGroundingText` with a stubbed `execFileSync`, `buildVerdictPrompt` as a pure string-shaping test, and `invokeAndParseVerdict` with a recorded LLM response. A new task source (the recurring `else if` growth) is added in one file and one function rather than threaded through 266 lines of mixed logic. Code review of a prompt change no longer requires the reviewer to mentally skip over path-resolution and I/O code to find the relevant hunk, and the 2026-08-16 class of bug—two compounding causes in different parts of the same function—becomes structurally impossible because each cause now lives in a function with a single, testable contract.

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
