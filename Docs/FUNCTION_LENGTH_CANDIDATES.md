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
