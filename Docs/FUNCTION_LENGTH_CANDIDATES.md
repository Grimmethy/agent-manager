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
