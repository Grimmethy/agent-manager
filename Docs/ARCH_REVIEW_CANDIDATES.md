# Architecture Review Candidates

### AC-1 · Kill-switch file couples tool-client behavior to filesystem state instead of config
Strength: Strong
Files: src/local-tool-client.js, src/config.js

Problem:
The kill-switch branch in `src/local-tool-client.js` swaps into a plain `call()` from `./local-client.js` when `.arch-discovery-tools-disabled` exists on disk. This means the same prompt path has two divergent code paths (tool-calling loop with retry vs. single-attempt generate) controlled by an arbitrary file rather than a setting in `config.js`. Any consumer that wants to disable tools must create a file, which is inconsistent with how every other behavior in this package is configured via `AGENT_MANAGER_*` env vars and config entries.

Solution:
Replace the filesystem kill-switch with a configuration-driven toggle read from `src/config.js`, e.g. a `tools_disabled` boolean that defaults to false (or can be set via an env var like `ARCH_DISCOVERY_TOOLS_DISABLED`). The tool client should always route through the same code path, and when tools are disabled it should invoke `call()` with its own retry-on-degenerate logic rather than delegating to the single-attempt path.

Benefits:
This makes tool-disabling behavior consistent with the rest of the package's configuration model (env vars + config), removes the filesystem side-effect that silently changes runtime behavior, and ensures both code paths share the same failure/retry contract instead of diverging into two different modes for the same prompt.

### AC-2 · grep-codebase-tool.js hardcodes directory exclusions instead of reading them from config
Strength: Strong
Files: src/grep-codebase-tool.js, src/config.js

Problem:
The `['node_modules', '.git', 'queue']` skip list in `src/grep-codebase-tool.js` is baked into the walker implementation. A consumer that wants to add or remove exclusion patterns has no way to do so without editing this file directly, creating tight coupling between search behavior and source code rather than letting config drive it. This contradicts `config.js`'s own design principle of "every env-var-driven setting."

Solution:
Read exclusion patterns from a configuration entry in `src/config.js`, e.g. an array like `grep_exclude_dirs` that defaults to the sensible baseline (`['node_modules', '.git']`). The walker should merge any user-provided overrides with the default set at runtime, allowing consumers to extend or shrink the skip list without touching implementation code.

Benefits:
This decouples search behavior from source code, making it possible for downstream tooling and CI configurations to customize grep patterns via config/env vars rather than patching files. It also aligns with `config.js`'s design principle that every setting should be configurable, improving maintainability and reducing the risk of accidental behavior changes when adding new directories.

### AC-3 · Tool-client duplicates degenerate-detection/retry contract when tools are disabled
Strength: Strong
Files: src/local-tool-client.js, src/local-client.js

Problem:
In the kill-switch branch (`fs.existsSync(killSwitchPath)`), `src/local-tool-client.js` calls `call()` from `./local-client.js`, but that call goes through `callOnce` which has its own timeout and no retry loop. The normal path uses `runPlanWithTools` with a turn cap and built-in retry-on-degenerate logic. This means the disabled-tools code path doesn't reuse any of the multi-retry contract documented in `local-client.js`, so it inherits single-attempt behavior instead of the documented failure mode. Two different failure modes for the same prompt depending on which branch executes.

Solution:
Refactor the kill-switch branch to invoke a shared helper that applies the same retry-on-degenerate logic used by `runPlanWithTools` in both paths, rather than delegating directly to `callOnce`. When tools are disabled, the tool client should still go through the same degenerate-detection pipeline, just with the tool-calling loop short-circuited. This ensures consistent failure behavior regardless of which branch executes.

Benefits:
This eliminates two different failure modes for the same prompt based on filesystem state, making runtime behavior predictable and testable. Both code paths now share a single contract for handling degenerate responses, reducing cognitive load when reasoning about tool-client behavior and simplifying future maintenance since only one retry/degenerate implementation needs to be maintained.

### AC-4 · Extract git vs. direct-write apply paths into separate functions
Strength: Strong
Files: src/apply-task.js

Problem:
The `applyTask` function in `src/apply-task.js` interleaves two fundamentally different workflows -- git branch/commit/push (used by the default path) and direct file writes with custom markers/tracking files (used by secondbrain, project_search, deep_dive) -- in a single branching structure. Each domain returns a different shape (`{ succeeded: true, doneMarker }` vs `{ succeeded: true, branch }`), forcing callers to inspect return values at every call site. Adding a fourth domain requires editing the same function and inserting another if/else block with no extension point.

Solution:
Extract two independent functions -- one handling git-based apply (branching, committing, pushing) and one handling direct-write apply (creating markers, updating INDEX.md or coverage.json). The caller dispatches to the appropriate function based on task domain. Each function returns a normalized `{ succeeded }` shape with optional metadata fields appended per-path. If needed, introduce an `ApplyStrategy` interface so future domains can register their own strategy without touching existing code.

Benefits:
The git and direct-write paths become independent units that can evolve without coupling. New domain types only need to implement the shared contract rather than edit a monolithic function. Return-value inspection at call sites is eliminated because all strategies normalize output shape. This gains a clear extension point for adding domains in the future.

### AC-5 · Provider duality threaded through every model-touching function
Strength: Strong
Files: python/dashboard/discuss_sessions.py

Problem:
The local/Claude split isn't isolated behind an abstraction — it's conditional branches in `_chat_prompt_for_turn`, `_generate`, and the session schema itself. Every function that interacts with a model must know about both providers: which prompt format to build, which client to call, how to extract latency/model metadata for stats recording. The two execution models (tool-calling Claude vs bare completion Ornith) have fundamentally different shapes — one accepts `cwd`/`allowed_tools`/`max_turns`, the other takes `temperature`/`num_predict`. These differences are propagated through `_generate`'s parameter list and through the session dict's `"provider"` field, creating a situation where adding a third provider (or removing one) requires touching every function in this module.

Solution:
Introduce a small provider abstraction — either a `ProviderSpec` object that encapsulates its prompt-building strategy, client call shape, and stats-recording convention, or two thin adapter functions (`_call_local`, `_call_claude`) each with their own clean signature. The session dict should store enough information for the right spec to be selected without re-deriving it from a string tag at every call site. This would let `_generate` become a single dispatch rather than an if/else.

Benefits:
Adding or removing providers becomes a localized change confined to one adapter layer instead of a cross-cutting refactor through every model-touching function. The session schema becomes self-describing — it carries its own provider configuration rather than requiring external lookup logic at each call site. Type signatures narrow per-adapter, making the different parameter shapes explicit and reducing the chance of passing incompatible arguments across providers.

### AC-6 · `arch-discovery-structcheck.js` fuses library exports with a side-effecting CLI entry point behind conditional late-binding requires
Strength: Strong
Files: arch-discovery-structcheck.js, config.js

Problem:
The file declares itself as a reusable module by exporting `checkStructure`, `recordArchDiscoveryStructFailure`, and `recordArchImportStructFailure` at the top level. Yet the bottom of the same file also executes an unconditional CLI block that runs when the file is invoked directly via Node. That CLI block calls `require('./config.js')` inside its own body rather than hoisting the import to module scope, so the dependency on config is invisible to static analysis and only materializes by tracing execution into the failure path. The dual contract means importing this module for its utilities silently pulls in no side effects, but running it as a script silently reads config and writes files -- two very different behaviors behind one filename that can confuse both developers and tooling.

Solution:
Split the file into `arch-discovery-structcheck-lib.js` (pure exports only) and `arch-discovery-structcheck-cli.js` (the CLI entry point with its own explicit `require('./config.js')`). The original filename can become a thin re-export of the lib or be removed entirely, with documentation pointing consumers to whichever surface they need. Alternatively, guard the CLI block behind an explicit `if (require.main === module)` check and move the config require to the top of that guarded scope so the dependency is visible at module load time.

Benefits:
Static analysis can now see all imports; library consumers no longer risk accidental side effects from a stray CLI invocation, and CLI users get an explicit contract around where configuration comes from. The separation also makes unit testing the pure utilities straightforward without mocking filesystem writes or config resolution.

### AC-7 · `resolveGraphPath` performs eager filesystem I/O inside `getConfig()` with no repoRoot-keyed memoization
Strength: **Rejected -- async-getConfig refactor, superseded**
Rejected note: config.js's resolveGraphPath already has repoRoot-keyed memoization (graphPathCache); the only residual is a handful of first-call sync stat() calls at startup -- a bounded cold-path one-shot, the same shape PERFORMANCE_FIX_CANDIDATES.md AC-1 was rejected as a False Positive. Async-ifying getConfig() is a viral await-propagation change across dozens of sync call sites for negligible gain. AC-7/11/12/13/14/19/20/21/22 are all fragments of that one over-decomposed refactor.
Files: src/config.js, src/apply-task.js, src/task-sources.js, src/local-worker.ps1

Problem:
`resolveGraphPath` reads `.agent-manager-cache/` via `readdirSync` and probes each subdirectory with `statSync` on every invocation. It is called from `getConfig()`, which itself is invoked by multiple consumers within the same process -- notably `apply-task.js`, `task-sources.js`, and the Node side of `local-worker.ps1`. Because the result depends only on `repoRoot` (which rarely changes mid-run) and there is no memoization keyed to that input, every consumer re-scans the cache directory even when a previous call already produced the answer. The synchronous I/O also blocks the event loop for any caller that could otherwise be doing work in parallel.

Solution:
Introduce a memoization layer inside `resolveGraphPath` (or a thin wrapper) keyed on `repoRoot`, with an expiry or invalidation hook tied to filesystem events or an explicit cache-clear call when `.agent-manager-cache/` is known to have changed. Replace the synchronous `readdirSync`/`statSync` with their async counterparts (`promises.readdir`, `fs.stat`) and make `resolveGraphPath` return a Promise, propagating that change through `getConfig()` so callers no longer block on cache discovery.

Benefits:
Repeated config reads within a single run collapse to a single filesystem walk, eliminating redundant I/O and reducing latency for consumers like `apply-task.js` and `task-sources.js`. The async path unblocks the event loop, which matters most in long-running processes such as the PowerShell-hosted Node worker. Memoization also makes behavior deterministic with respect to repoRoot, simplifying reasoning about when cache state is current.

### AC-8 · Platform-specific security semantics baked into a cross-platform API surface
Strength: Strong
Files: src/secrets.js, src/secrets.test.js

Problem:
`writeSecretFile` is documented as providing "0600-mode enforcement" but only actually delivers that guarantee on POSIX. Windows callers get no real security boundary from the `mode` argument, yet the function name, its 0o600 constant, and the test assertions all imply cross-platform behavior. The module handles this by documenting the limitation in a header comment and skipping strict mode tests on Windows — but the API contract itself is misleading: callers on any platform can reasonably assume "write a secret file with restricted permissions" means the same thing everywhere, when only POSIX actually enforces it.

The test file mirrors this tension: it asserts exact mode bits on POSIX (`assert.equal(mode, 0o600)`) and skips those assertions on Windows, but doesn't assert that Windows callers at least get the content written correctly as a baseline guarantee of "something happened." The asymmetry between what's tested (POSIX-only security semantics) and what's documented (cross-platform utility) means the contract is partially implicit.

Solution:
Make `writeSecretFile` explicitly POSIX-only by renaming it to `writeSecretFilePosix` or adding an option like `{ platform: 'posix' }`, so Windows callers get a clear signal that this function doesn't apply. Alternatively, add a Windows-specific path that logs a warning when the mode argument is ignored, making the limitation observable at runtime rather than buried in documentation. The test suite should also assert content integrity on Windows to ensure the function does something useful and provides a baseline guarantee of behavior across platforms.

Benefits:
The API contract becomes honest about its actual security guarantees, preventing callers from assuming cross-platform protection where none exists. Tests now cover both platform-specific semantics (POSIX mode enforcement) and cross-platform baselines (content integrity), catching regressions on either axis. The design decision is explicit rather than implicit, reducing the cognitive load for maintainers evaluating whether to extend support or document limitations.

### AC-9 · AC-4a – Extract the git branch/commit/push path into applyViaGit
Strength: Strong
Files: src/apply-task.js

Problem:
The main apply flow in src/apply-task.js interleaves the git branch/commit/push sequence (createRealGitRunner, branch creation, staging, committing, pushing, and git-specific error handling) with the direct-write path in a single function body. The file already imports createRealGitRunner from ./git-runner.js and the header comment confirms the function 'does the entire git branch/commit/push sequence itself via child_process', but that logic sits inline alongside the non-git branches, making it impossible to unit-test the git path in isolation, add git-specific retry or skipPush handling, or reason about which lines are git-only versus shared. The DIRECT_TO_MAIN_SOURCES set (arch_discovery, arch_import, observability_review, performance_review) further complicates the inline logic by introducing a third routing dimension (push-to-main vs throwaway-branch) that is entangled with the same if/else chain.

Solution:
In src/apply-task.js, identify the contiguous block of code that performs the git sequence (branch creation via createRealGitRunner, file staging, commit with the coAuthorTrailer(task) trailer, push or skipPush, and the associated error handling / {succeeded:false, reason} returns). Extract that block verbatim into a new function applyViaGit(task, repoRoot, pipelineDir) defined in the same file, above the dispatcher. The function receives the task object, repoRoot, and pipelineDir (the same three parameters the current dispatcher already threads through). It returns the existing success shape {succeeded:true, branch:'agent/<id>'} or the existing failure shape {succeeded:false, reason:'<message>'} unchanged. The dispatcher (the code that currently calls the inline git block) is updated to call applyViaGit(...) and return its result directly. No internal variable names, ordering, or logic are changed—this is a pure 1:1 line move. Add a JSDoc @returns block on applyViaGit documenting both shapes.

Benefits:
The git path becomes independently testable (mock createRealGitRunner, assert branch name and commit trailer). The DIRECT_TO_MAIN_SOURCES skipPush branch and the normal push branch can be reasoned about in one small function instead of a 200-line monolith. Future changes to commit message format, trailer logic, or push strategy touch only applyViaGit. The dispatcher shrinks to a routing decision plus a return, making the overall control flow of the file easier to audit.

### AC-10 · AC-4b – Extract the direct-write (marker / INDEX / coverage) path into applyViaDirectWrite
Strength: Strong
Files: src/apply-task.js

Problem:
The same main apply function in src/apply-task.js also contains the non-git 'direct-write' path: for domains such as secondbrain, project_search, and deep_dive (routed via the imports applySecondBrainNote, applyProjectSearchFindings, applyDeepDiveFindings from ./apply-group-a.js, and the writeArtifact helper that dispatches on usesGroupB / source.apply), the function creates a done-marker file, updates INDEX.md and/or coverage.json, and returns {succeeded:true, doneMarker:'<path>'}. This logic is interleaved with the git path in the same function body, so adding a new direct-write domain, changing the marker format, or adjusting the INDEX.md update logic requires navigating the entire git branch/commit/push code above it. The writeArtifact function (visible in the file) already partially separates the 'which apply to call' decision, but the downstream marker-creation and bookkeeping steps remain inline in the shared body.

Solution:
In src/apply-task.js, identify the contiguous block of code that handles the direct-write outcome: the calls into applySecondBrainNote / applyProjectSearchFindings / applyDeepDiveFindings / applyBrainDumpSort / applyPathPrefetchResolve / closeBrainDumpEntryResolved / applyResearchTask (all imported from ./apply-group-a.js), the writeArtifact call for Group B sources, the done-marker file creation, and the INDEX.md / coverage.json update logic. Extract that block verbatim into a new function applyViaDirectWrite(task, repoRoot, pipelineDir) defined in the same file. It receives the same three parameters. It returns the existing success shape {succeeded:true, doneMarker:'<path>'} or the existing failure shape {succeeded:false, reason:'<message>'} unchanged. The dispatcher is updated to call applyViaDirectWrite(...) and return its result. No internal variable names, ordering, or logic are changed—pure 1:1 line move. Add a JSDoc @returns block on applyViaDirectWrite documenting both shapes. The shared setup that runs before the branch (argument validation, task destructuring, appendHistoryEvent, requeueBlockedTasksForSignature) stays in the dispatcher and is passed through to whichever sub-function is called.

Benefits:
Adding a new direct-write domain (e.g. a new apply-group-a.js export) only touches applyViaDirectWrite and the import line, not the git path. The marker/INDEX/coverage bookkeeping can be refactored or tested in isolation. The two extraction functions (this one and applyViaGit from AC-4a) together reduce the dispatcher to a ~10-line routing function, making the file's top-level control flow trivially auditable. Each sub-function can be exported for targeted unit tests without exercising the other path.

### AC-11 · Async-ify resolveGraphPath with repoRoot-keyed memoization in config.js
Strength: **Rejected -- async-getConfig refactor, superseded**
Rejected note: config.js's resolveGraphPath already has repoRoot-keyed memoization (graphPathCache); the only residual is a handful of first-call sync stat() calls at startup -- a bounded cold-path one-shot, the same shape PERFORMANCE_FIX_CANDIDATES.md AC-1 was rejected as a False Positive. Async-ifying getConfig() is a viral await-propagation change across dozens of sync call sites for negligible gain. AC-7/11/12/13/14/19/20/21/22 are all fragments of that one over-decomposed refactor.
Files: src/config.js

Problem:
resolveGraphPath(repoRoot) performs eager synchronous filesystem I/O (fs.existsSync, fs.readdirSync, fs.statSync) on every single getConfig() call, with no caching. In a long-lived worker process that calls getConfig() repeatedly (every task-source tick, every apply-task invocation), this re-walks .agent-manager-cache/ from scratch each time, blocking the event loop and doing redundant stat/readdir work. There is also no way to invalidate a cached result when the dashboard writes a new graph.json, so a memoized version needs an explicit invalidation hook.

Solution:
1) Add a module-level Map keyed by path.resolve(repoRoot) storing the resolved graph-path string. 2) Convert resolveGraphPath to an async function using fs.promises (readdir, stat, access) instead of the sync variants; on entry, check the Map and return the cached value on a hit; on a miss, perform the async walk and store the result before returning. 3) Export a new invalidateGraphPathCache(repoRoot?) function that deletes a single key or clears the whole Map. 4) Change getConfig() from function to async function and replace the bare resolveGraphPath(repoRoot) call with await resolveGraphPath(repoRoot). 5) Keep the AGENT_MANAGER_GRAPH_PATH env-var short-circuit before the await so an explicitly-set path never touches the cache or the filesystem.

Benefits:
Eliminates redundant synchronous readdir/stat walks on every getConfig() call in long-lived worker processes; frees the event loop during the (now async) filesystem I/O; gives downstream code (e.g. a task-completion handler that writes a new graph.json) a deterministic one-line call to force a re-scan on the next getConfig() invocation; the env-var override path remains zero-cost and synchronous.

### AC-12 · Adopt async getConfig() in apply-task.js and task-sources.js
Strength: **Rejected -- async-getConfig refactor, superseded**
Rejected note: config.js's resolveGraphPath already has repoRoot-keyed memoization (graphPathCache); the only residual is a handful of first-call sync stat() calls at startup -- a bounded cold-path one-shot, the same shape PERFORMANCE_FIX_CANDIDATES.md AC-1 was rejected as a False Positive. Async-ifying getConfig() is a viral await-propagation change across dozens of sync call sites for negligible gain. AC-7/11/12/13/14/19/20/21/22 are all fragments of that one over-decomposed refactor.
Files: src/apply-task.js,src/task-sources.js

Problem:
After config.js's getConfig() becomes async (returns a Promise), every call site that does const { pipelineDir } = getConfig(); or similar destructuring will silently receive a Promise instead of a plain object, causing undefined property reads and runtime failures. In task-sources.js, taskIdExistsInQueue(id) calls getConfig() synchronously and is itself called from many nextTask generators throughout the file; making it async cascades to every caller. In apply-task.js, getConfig() is required at the top and called in the (truncated) apply logic. All of these call sites must be converted to await getConfig() and their enclosing functions made async (or wrapped in an IIFE / .then chain) to complete the migration.

Solution:
1) In src/task-sources.js: change taskIdExistsInQueue to async function taskIdExistsInQueue(id) and add await before getConfig(); then propagate async/await up through every function that calls taskIdExistsInQueue (the nextTask generators for each of the 10 built-in sources, the adhoc/research title-scanning helper, and any other internal callers visible in the file). 2) In src/apply-task.js: add await before every getConfig() call site in the apply/writeArtifact/branch logic; make the enclosing functions async where they are not already. 3) Verify no other module in the package calls getConfig() without await (grep for require('./config.js') and getConfig() across src/). 4) local-worker.ps1 needs no change — it invokes Node scripts (local-client.js, prompts.js, local-tool-client.js) via & node and reads stdout; it does not itself call getConfig() or resolveGraphPath.

Benefits:
Completes the breaking-change migration so no caller silently receives a Promise where it expects a plain object; the cascading async in task-sources.js is contained to that one file's internal call graph (all nextTask functions are already called from a single async worker loop, so the propagation is mechanical); apply-task.js's CLI entry point already runs in an async context (it's a top-level script), so adding await is straightforward; no PowerShell-side change is needed, keeping the worker's invocation contract unchanged.

### AC-13 · Async-ify resolveGraphPath and getConfig in src/config.js
Strength: **Rejected -- async-getConfig refactor, superseded**
Rejected note: config.js's resolveGraphPath already has repoRoot-keyed memoization (graphPathCache); the only residual is a handful of first-call sync stat() calls at startup -- a bounded cold-path one-shot, the same shape PERFORMANCE_FIX_CANDIDATES.md AC-1 was rejected as a False Positive. Async-ifying getConfig() is a viral await-propagation change across dozens of sync call sites for negligible gain. AC-7/11/12/13/14/19/20/21/22 are all fragments of that one over-decomposed refactor.
Files: src/config.js

Problem:
resolveGraphPath uses three synchronous fs calls (fs.existsSync, fs.readdirSync, fs.statSync) that block the Node event loop on every getConfig() invocation. getConfig() itself is synchronous and calls resolveGraphPath(repoRoot) inline, so any consumer that needs a config object must wait on a blocking syscall. This is fine for a one-shot CLI but blocks the event loop in the long-running drafting daemon and dashboard server that import this module.

Solution:
Convert resolveGraphPath to an async function that uses fs.promises.access (for the existsSync check), fs.promises.readdir (for the directory listing), and fs.promises.stat (for mtimeMs). Preserve the exact three-tier resolution order: (1) .agent-manager-cache/default/graph.json, (2) most-recently-modified graph.json across .agent-manager-cache/<hash>/ subdirs, (3) graphify-out/graph.json fallback. Convert getConfig to an async function and prepend await before the resolveGraphPath(repoRoot) call on the line 'const graphPath = process.env.AGENT_MANAGER_GRAPH_PATH || resolveGraphPath(repoRoot);'. The returned object shape (all keys, types) is unchanged; callers simply await it.

Benefits:
Non-blocking filesystem I/O in the daemon and server processes; no behavioral change to the resolution logic or the returned config object; paves the way for callers to do useful work while the stat/readdir round-trip is in flight.

### AC-14 · Propagate await getConfig() through taskIdExistsInQueue (task-sources.js) and all getConfig() call sites in apply-task.js
Strength: **Rejected -- async-getConfig refactor, superseded**
Rejected note: config.js's resolveGraphPath already has repoRoot-keyed memoization (graphPathCache); the only residual is a handful of first-call sync stat() calls at startup -- a bounded cold-path one-shot, the same shape PERFORMANCE_FIX_CANDIDATES.md AC-1 was rejected as a False Positive. Async-ifying getConfig() is a viral await-propagation change across dozens of sync call sites for negligible gain. AC-7/11/12/13/14/19/20/21/22 are all fragments of that one over-decomposed refactor.
Files: src/apply-task.js, src/task-sources.js

Problem:
Once getConfig() returns a Promise, every existing call site that destructures it synchronously (e.g. 'const { pipelineDir } = getConfig();' inside taskIdExistsInQueue in task-sources.js, and the one or more call sites in apply-task.js that import getConfig from ./config.js) will receive a Promise object instead of the config object, causing undefined property access and runtime errors. taskIdExistsInQueue is called from multiple source-generator functions in task-sources.js, so making it async cascades to those callers as well.

Solution:
In src/task-sources.js: change taskIdExistsInQueue to 'async function taskIdExistsInQueue(id)' and change 'const { pipelineDir } = getConfig();' to 'const { pipelineDir } = await getConfig();'. Then find every caller of taskIdExistsInQueue within task-sources.js (the source-generator tick functions that call it for dedup) and add await, making those enclosing functions async if they are not already. In src/apply-task.js: locate every call site of getConfig() (the file imports it via 'const { getConfig, ensureRegistered } = require("./config.js");') and add await; make the enclosing function async if it is not already, and propagate await up through any further callers in the same file. Verify no top-level (module-scope) call to getConfig() exists that would need restructuring into an async IIFE or a top-level await.

Benefits:
All consumers of getConfig() correctly await the Promise, preserving the same runtime values they received before; the async propagation is minimal (one await per call site) and does not change any business logic; the daemon and CLI both work correctly with the now-async config lookup.

### AC-15 · Export a reusable degenerate-detection/retry helper from local-client.js
Strength: Strong
Files: src/local-client.js

Problem:
local-client.js contains the canonical degenerate-output detector (detectDegenerate) and the retry-on-degenerate contract described in Docs/agents/local-delegation.md, but this logic is only exposed as an internal implementation detail of callOnce/the module's own retry loop -- there is no exported, standalone entry point another caller (such as local-tool-client.js) can invoke to get the same degenerate-classification and retry behavior without re-deriving it independently.

Solution:
Add an explicit, exported helper (e.g. module.exports.detectDegenerate and a small exported retryOnDegenerate(fn, opts) wrapper built on the existing detectDegenerate logic and the same retry semantics already used internally) so the degenerate-detection rules (empty/quirky-empty, repeated-character, repetition-loop, non-ascii-gibberish) and the decision of when to retry live in exactly one place with one public surface.

Benefits:
Establishes a single source of truth for what counts as a degenerate local-model response and how retries are attempted, so any other caller can depend on the same tested behavior instead of re-implementing an approximation of it.

### AC-16 · Have local-tool-client.js's no-tools path reuse local-client.js's degenerate/retry helper instead of its own copy
Strength: Strong
Files: src/local-tool-client.js

Problem:
When tools are disabled, local-tool-client.js currently falls back to its own degenerate-detection and retry handling for the /api/chat response rather than delegating to local-client.js's existing, already-audited detectDegenerate/retry contract, producing two independent implementations of the same failure-handling rules that can silently drift out of sync.

Solution:
Once local-client.js exposes a reusable exported helper for degenerate detection and retry (see the companion candidate for local-client.js), update local-tool-client.js's tools-disabled code path to call that shared helper on the model's response text instead of running its own separate degenerate-check/retry logic, removing the duplicated implementation from this file.

Benefits:
Eliminates a second, independently-maintained copy of the degenerate-detection/retry contract, so a future fix or tuning of the detection rules in local-client.js automatically applies to the tools-disabled path here too, instead of requiring the same fix to be made twice.

### AC-17 · Provider dispatch in _generate: extract per-provider call path
Strength: Strong
Files: python/dashboard/discuss_sessions.py

Problem:
_generate currently inlines both the Ollama (local) call and the Claude CLI call in one function body, branching on session["provider"] mid-function. The Claude path needs cwd, allowed_tools (CLAUDE_DISCUSS_ALLOWED_TOOLS), and max_turns (CLAUDE_DISCUSS_MAX_TURNS); the local path needs the harness-mediated grep context (QUERY_LINE_RE, MAX_HARNESS_QUERIES, _expand_grep_terms, MAX_HARNESS_CONTEXT_CHARS) plus the ollama_client.generate() call. Because both paths share one function, adding or adjusting either provider's call shape means wading through the other's logic, and the function is long enough that a reader must track two unrelated call conventions simultaneously.

Solution:
Introduce two thin adapter functions -- _call_local(session, prompt, transcript) and _call_claude(session, prompt, transcript) -- each with a clean signature carrying only its own provider-specific parameters (local: instances_dir for the lock, harness-context budget; claude: cwd, allowed_tools, max_turns). _generate becomes a short dispatch: read session["provider"], call the matching adapter, and record stats (latency, model id) uniformly after the call returns. The adapters live directly above _generate in the same file; no new module, no new class. The existing constants (CLAUDE_DISCUSS_ALLOWED_TOOLS, CLAUDE_DISCUSS_MAX_TURNS, MAX_HARNESS_CONTEXT_CHARS, etc.) are referenced inside their respective adapter and are not moved.

Benefits:
Each provider's call path is independently readable and testable; a future third provider adds one more adapter without touching the other two; _generate shrinks to a ~5-line dispatch that is trivially reviewable; the stats-recording convention (latency + model identifier) is written once at the dispatch level rather than duplicated in each branch.

### AC-18 · Provider-aware prompt building in _chat_prompt_for_turn
Strength: **Rejected -- describes a refactor already done; the waste it targets is fictional**
Rejected note: _chat_prompt_for_turn (discuss_sessions.py:224) is already a 12-line function that branches on provider at the top and delegates to the shared _build_chat_prompt skeleton. The Claude branch never calls _local_harness_context, so there is no Claude turn "silently consuming Ornith's num_ctx on a preamble it ignores" -- that waste does not exist. The proposed "shared skeleton + provider-specific preamble slot" split is (a) already in place at the _chat_prompt_for_turn level and (b) impossible as written without editing _build_chat_prompt (which injects harness context *inside* the body via `elif harness_context:`), which this candidate's own scope guard forbids. Across three attempts the drafter either guessed wrong (rejected for contradicting the real code) or correctly refused; task archived. Also surfaced a grounding gap worth noting separately: discuss_sessions.py (27KB) was truncated to MAX_FETCHED_FILE_CHARS (8KB) and the fetch window missed the target function entirely, so no drafter saw the code it was told to restructure. Investigated 2026-08-29.
Files: python/dashboard/discuss_sessions.py

Problem:
_chat_prompt_for_turn builds a single prompt string used by both providers, but the two paths have different prompt conventions: the local (Ornith) path prepends harness-grep context (the real file content gathered by _build_search_proposal_prompt + _expand_grep_terms + grep_fetch_client) before the note text, while the Claude path does not need that preamble because Claude can Read/Grep/Glob its own files via CLAUDE_DISCUSS_ALLOWED_TOOLS. Currently the function either includes the harness-context block unconditionally (wasting Ornith's 8192-token num_ctx window on a Claude turn that ignores it) or conditionally branches on provider mid-string-concatenation, which is fragile and hard to extend.

Solution:
Split _chat_prompt_for_turn into a shared skeleton (system instruction, note text, transcript turns) plus a provider-specific preamble slot. For PROVIDER_LOCAL the preamble is the harness-grep context block (built by the existing _build_search_proposal_prompt / _expand_grep_terms / grep_fetch_client pipeline, capped at MAX_HARNESS_CONTEXT_CHARS). For PROVIDER_CLAUDE the preamble is empty (or a one-line note that file access is available via tools). The function signature gains no new parameters -- it already receives the session dict and reads session["provider"] -- but the internal branching is moved to the top of the function so the two prompt shapes are visually distinct blocks rather than interleaved conditionals.

Benefits:
The prompt shape for each provider is a single contiguous block that can be read, copied, and tested in isolation; the 8192-token budget for Ornith is no longer silently consumed by a Claude-only preamble; adding a new provider means adding one more preamble branch at the top of the function rather than threading a conditional through every string-concatenation line.

### AC-19 · Make taskIdExistsInQueue async and propagate await to all its callers in task-sources.js
Strength: **Rejected -- async-getConfig refactor, superseded**
Rejected note: config.js's resolveGraphPath already has repoRoot-keyed memoization (graphPathCache); the only residual is a handful of first-call sync stat() calls at startup -- a bounded cold-path one-shot, the same shape PERFORMANCE_FIX_CANDIDATES.md AC-1 was rejected as a False Positive. Async-ifying getConfig() is a viral await-propagation change across dozens of sync call sites for negligible gain. AC-7/11/12/13/14/19/20/21/22 are all fragments of that one over-decomposed refactor.
Files: src/task-sources.js

Problem:
config.js's getConfig() now returns a Promise<Config> instead of a plain object. taskIdExistsInQueue (line ~100) calls `const { pipelineDir } = getConfig();` synchronously, which would destructure a Promise and yield undefined for pipelineDir, causing every fs.existsSync check to throw or silently miss. Every caller of taskIdExistsInQueue in this file — the nextTask generator for each of the 10 built-in sources (priorities 10/20/40/70/71/80/81/82/85/90), the adhoc/research title-scanning helper, and any other internal call sites — invokes it without await, so they would receive a Promise instead of a boolean and their truthiness checks would always be truthy (a Promise is always truthy), breaking dedup entirely.

Solution:
1) Change the declaration from `function taskIdExistsInQueue(id)` to `async function taskIdExistsInQueue(id)` and change `const { pipelineDir } = getConfig();` to `const { pipelineDir } = await getConfig();`. 2) Walk every call site of taskIdExistsInQueue in the file (each built-in source's nextTask generator, the title-scanning helper, and any other internal callers) and add `await` before the call. 3) For each caller that is not already declared `async`, add the `async` keyword to its function declaration. 4) If any of those callers are themselves invoked by another function in the file, repeat the async/await propagation one level up until reaching the module's exported entry points. 5) Verify that any top-level or IIFE code that calls the exported nextTask functions already handles a returned Promise (e.g., is inside an async wrapper or uses .then).

Benefits:
Restores correct synchronous-looking dedup semantics: taskIdExistsInQueue returns a real boolean again (via await), callers correctly skip already-queued tasks, and the 10 built-in sources plus the title-scanning helper all work with the new async getConfig() contract without TypeError or silent truthiness bugs.

### AC-20 · Add await to every getConfig() call site in apply-task.js and make enclosing functions async
Strength: **Rejected -- async-getConfig refactor, superseded**
Rejected note: config.js's resolveGraphPath already has repoRoot-keyed memoization (graphPathCache); the only residual is a handful of first-call sync stat() calls at startup -- a bounded cold-path one-shot, the same shape PERFORMANCE_FIX_CANDIDATES.md AC-1 was rejected as a False Positive. Async-ifying getConfig() is a viral await-propagation change across dozens of sync call sites for negligible gain. AC-7/11/12/13/14/19/20/21/22 are all fragments of that one over-decomposed refactor.
Files: src/apply-task.js

Problem:
config.js's getConfig() now returns a Promise<Config>. apply-task.js imports getConfig (line 14: `const { getConfig, ensureRegistered } = require('./config.js');`) and calls it in multiple places throughout the apply logic, the writeArtifact path, and the branch/commit/push sequence. Each call site currently does `const { pipelineDir } = getConfig()` (or similar destructuring) without await, so it destructures a Promise object, yielding undefined for pipelineDir and any other config fields. This causes path.join to throw, git commands to target the wrong directory, and the entire apply pipeline to fail with a confusing TypeError or write artifacts to 'undefined' paths.

Solution:
1) Locate every call site of getConfig() in the file (the apply dispatch logic, the writeArtifact helper, the branch/commit/push sequence, and any other internal usage). 2) At each site, change `getConfig()` to `await getConfig()` (e.g., `const { pipelineDir } = getConfig()` becomes `const { pipelineDir } = await getConfig()`). 3) For each call site, walk up to the nearest enclosing function: if it is not already declared `async`, add the `async` keyword. 4) If that function is called by another function in the file, repeat the async/await propagation one level up until reaching the top-level entry point. 5) Verify the CLI entry point (the file is invoked as `node apply-task.js <task.json>`) already runs in an async context — either via top-level await (ESM, Node ≥ 14.8) or an `async main().catch(…)` / IIFE pattern — so the await chain resolves before the process exits and the single-line JSON result is written to stdout.

Benefits:
The apply pipeline correctly resolves the config object before using pipelineDir, git branch names, and artifact paths. All downstream logic (writeArtifact, group-A/group-B dispatch, git runner, history append) receives a real string path instead of undefined, eliminating the class of failures where apply silently writes to the wrong location or crashes with a TypeError on the first path.join call.

### AC-21 · Async-ify resolveGraphPath and getConfig in src/config.js
Strength: **Rejected -- async-getConfig refactor, superseded**
Rejected note: config.js's resolveGraphPath already has repoRoot-keyed memoization (graphPathCache); the only residual is a handful of first-call sync stat() calls at startup -- a bounded cold-path one-shot, the same shape PERFORMANCE_FIX_CANDIDATES.md AC-1 was rejected as a False Positive. Async-ifying getConfig() is a viral await-propagation change across dozens of sync call sites for negligible gain. AC-7/11/12/13/14/19/20/21/22 are all fragments of that one over-decomposed refactor.
Files: src/config.js

Problem:
resolveGraphPath performs three synchronous filesystem calls (fs.existsSync, fs.readdirSync, fs.statSync) that block the Node.js event loop every time a graph path is resolved. getConfig calls resolveGraphPath synchronously on the line `const graphPath = process.env.AGENT_MANAGER_GRAPH_PATH || resolveGraphPath(repoRoot);`, so every consumer of getConfig (the drafting daemon, the dashboard server, and any other importer) inherits that blocking behavior. In a server process handling concurrent requests, a single statSync or readdirSync on a slow filesystem can stall the entire event loop.

Solution:
Convert resolveGraphPath to `async function resolveGraphPath(repoRoot)`. Replace the `fs.existsSync(defaultCacheGraph)` guard with a try/catch around `await fs.promises.access(defaultCacheGraph)`. Replace the synchronous `.filter().map().sort()` chain (which embeds `fs.existsSync` and `fs.statSync` inside callbacks) with an async for-loop over `await fs.promises.readdir(cacheDir, { withFileTypes: true })`, using `await fs.promises.stat(p)` for each candidate and collecting results into an array before sorting. Preserve the exact three-tier resolution order (default/graph.json → freshest hashed-dir graph.json → graphify-out/graph.json) and the returned string path. Convert getConfig to `async function getConfig()`. Change the graphPath line to `const graphPath = process.env.AGENT_MANAGER_GRAPH_PATH ?? (await resolveGraphPath(repoRoot));` so the env-var short-circuit is evaluated before the await. All other keys and types in the returned config object are unchanged.

Benefits:
Eliminates event-loop blocking during config and graph-path resolution, allowing the drafting daemon and dashboard server to handle concurrent I/O without stalling. The resolution algorithm, its three-tier priority order, and the shape of the returned config object are all preserved, so no consumer logic changes beyond adding `await`.

### AC-22 · Update all callers of getConfig and resolveGraphPath to await the now-async functions
Strength: **Rejected -- async-getConfig refactor, superseded**
Rejected note: config.js's resolveGraphPath already has repoRoot-keyed memoization (graphPathCache); the only residual is a handful of first-call sync stat() calls at startup -- a bounded cold-path one-shot, the same shape PERFORMANCE_FIX_CANDIDATES.md AC-1 was rejected as a False Positive. Async-ifying getConfig() is a viral await-propagation change across dozens of sync call sites for negligible gain. AC-7/11/12/13/14/19/20/21/22 are all fragments of that one over-decomposed refactor.
Files: (to be enumerated: every file that imports src/config.js and calls getConfig or resolveGraphPath -- known consumers include the drafting daemon and the dashboard server; exact file paths must be discovered via repository search)

Problem:
After the async conversion in src/config.js, every existing call site that invokes `getConfig()` or `resolveGraphPath(repoRoot)` without `await` will receive a Promise instead of a resolved value. Downstream code that expects a string path (e.g., passing it to `fs.readFile`, `path.join`, or an HTTP header) will silently receive a Promise object, causing runtime errors or incorrect behavior. Because the call sites span multiple files whose paths are not yet known, this cannot be captured in the same atomic edit as the config.js conversion.

Solution:
Search the repository for all occurrences of `require('…/config')`, `import … from '…/config'`, `getConfig(`, and `resolveGraphPath(`. For each call site, add `await` before the call and ensure the enclosing function is declared `async` (or wrap in `.then()` if the context cannot be made async). Verify that no caller relies on the synchronous return value in a way that `await` would break (e.g., a synchronous event handler in a framework). Flag any caller in a context that cannot be made async as a risk and decide whether a top-level `await` or a microtask wrapper is appropriate.

Benefits:
All consumers correctly await the async config resolution, preserving identical runtime behavior (same resolved values, same error semantics) while gaining non-blocking I/O. Completing this step is required before the async conversion in src/config.js can be safely merged, since omitting it would break every caller at runtime.

### AC-23 · AC-16a — Confirm/export the shared degenerate-detection + retry helper from local-client.js
Strength: Strong
Files: src/local-client.js

Problem:
local-tool-client.js's no-tools (tools-disabled) path carries its own inline copy of degenerate-output detection and retry logic for the /api/chat response. local-client.js already implements the same detectDegenerate/retry contract for its /api/generate path, but the helper is not yet exported as a reusable named function that another module can import. Until it is, local-tool-client.js cannot drop its local copy without duplicating the logic in a third place.

Solution:
In src/local-client.js, extract (or confirm the companion candidate already extracted) the degenerate-detection predicate and the retry loop into a single named export (e.g. `detectDegenerateAndRetry(responseText, { maxRetries, callFn })`) that encapsulates: (1) the exact pattern/condition that marks a response as degenerate, (2) the retry policy (max attempts, what is re-sent, back-off if any), and (3) the return shape (final text or thrown error). Export it so a sibling module can `require('./local-client.js')` and pull the helper by name. If the logic is already a private function, simply add it to the module's `module.exports`.

Benefits:
Single source of truth for the degenerate/retry contract; any future tweak to what counts as degenerate or how many retries are allowed is made in one place; removes the prerequisite blocker for AC-16b.

### AC-24 · AC-16b — Replace local-tool-client.js no-tools path degenerate/retry with the shared helper
Strength: Strong
Files: src/local-tool-client.js

Problem:
The tools-disabled branch in local-tool-client.js re-implements degenerate-output detection and retry inline (its own pattern check on the model's response text, its own retry counter / re-invocation loop). This duplicates the already-audited logic in local-client.js, so a fix or policy change in one file silently diverges from the other. The file's own header comment stresses that this module is deliberately narrow and should lean on existing, already-audited helpers rather than growing its own copies.

Solution:
1) Add `const { detectDegenerateAndRetry } = require('./local-client.js');` (exact export name to be confirmed against local-client.js's module.exports at implementation time) to the import block near the top of local-tool-client.js. 2) In the no-tools / tools-disabled branch (the code path that fires when the caller passes no tools or tools are disabled, located after the tool-handler definitions and before/inside the main `runPlanWithTools`-style function — the section not visible in the truncated excerpt), delete the local degenerate-detection predicate, the local retry counter, and the local re-invocation loop. 3) Replace that block with a single call to `detectDegenerateAndRetry(responseText, { maxRetries: <same value as before>, callFn: <the existing /api/chat call closure> })`, preserving the exact observable behaviour (same degenerate rule, same max attempts, same return value passed to the caller). 4) Remove any now-orphaned private helper functions in this file that existed solely to support the old local retry (e.g. a private `isDegenerate()` or a module-level retry counter). 5) Verify no other branch in this file references the removed local helpers.

Benefits:
Eliminates a second, possibly-divergent copy of the degenerate/retry logic; the no-tools path now inherits the already-audited behaviour from local-client.js automatically; smaller surface area in local-tool-client.js (fewer lines to review, test, and keep in sync); satisfies the plan's A5 requirement of zero observable behavioural change.

### AC-25 · Extract local/Ollama provider call path into _call_local
Strength: Strong
Files: python/dashboard/discuss_sessions.py

Problem:
The _generate function in discuss_sessions.py inlines the entire local (Ollama) provider path directly in its body: building the harness-mediated grep search proposal, expanding query terms via _expand_grep_terms, fetching context via grep_fetch_client under _maybe_locked, and calling ollama_client.generate(). This logic is entangled with the Claude provider's branch and with _generate's own dispatch/stats-recording responsibilities, making the function long and harder to read or modify safely.

Solution:
Add a new function _call_local(session, prompt, transcript) placed directly above _generate in discuss_sessions.py. Move the local-provider branch's body out of _generate into this function verbatim -- the harness query-proposal call, QUERY_LINE_RE parsing, _expand_grep_terms usage, MAX_HARNESS_QUERIES/MAX_HARNESS_CONTEXT_CHARS limits, the _maybe_locked-guarded grep_fetch_client call, and the ollama_client.generate() call -- with no behavioral changes, only adjusting indentation and turning locals referenced from the branch into the function's parameters/return value. The function should return whatever _generate needs afterward (e.g. response text and model id) so the caller can still do its existing post-processing. Leave the module-level constants (QUERY_LINE_RE, MAX_HARNESS_QUERIES, MAX_HARNESS_CONTEXT_CHARS) untouched at module scope; _call_local simply references them.

Benefits:
Isolates the local-provider's harness-context-building and generation logic into its own testable, independently readable unit, and is a prerequisite step toward turning _generate into a short provider-dispatch function without changing any runtime behavior.

### AC-26 · Extract Claude provider call path into _call_claude and rewrite _generate as a dispatcher
Strength: Strong
Files: python/dashboard/discuss_sessions.py

Problem:
The _generate function also inlines the entire Claude-provider path (the claude_client CLI invocation using CLAUDE_DISCUSS_ALLOWED_TOOLS and CLAUDE_DISCUSS_MAX_TURNS) alongside the local-provider path, plus shared pre/post logic and stats recording, all in one function. Once the local path is pulled into _call_local, _generate still contains the Claude branch's full body and a manual if/else on session["provider"] mixed with unrelated setup and stats-recording code.

Solution:
Add a new function _call_claude(session, prompt, transcript) placed directly above _generate (next to _call_local), and move the Claude-provider branch's body into it verbatim -- the claude_client CLI invocation using CLAUDE_DISCUSS_ALLOWED_TOOLS and CLAUDE_DISCUSS_MAX_TURNS, cwd handling, and any Claude-specific error handling -- with no behavioral changes, returning the same shape _call_local returns (e.g. response text and model id) so both can be consumed identically. Then rewrite _generate itself: keep any shared prompt/transcript setup that runs before the provider branch, replace the inlined if/else provider logic with a short dispatch that calls _call_local(...) or _call_claude(...) based on session["provider"], and perform the existing stats/latency/model-id recording once against the adapter's return value before returning as before. Leave CLAUDE_DISCUSS_ALLOWED_TOOLS and CLAUDE_DISCUSS_MAX_TURNS at module scope, referenced only from _call_claude.

Benefits:
Completes the split of per-provider logic out of _generate, leaving _generate as a short, easy-to-follow dispatcher with a single unified stats-recording path, while both adapters remain plain functions in the same file with no behavioral change and no new module/class introduced.

### AC-27 · `readPluginsManifest()` has no injectable path, forcing a cache-bust ritual in every test
Strength: Worth exploring
Files: src/plugins-manifest.js, src/accessible-roots.js, src/plugins-manifest.test.js, src/accessible-roots.test.js

Problem:
`PLUGINS_MANIFEST_PATH` is a module-level `const` resolved from `process.env.AGENT_MANAGER_PLUGINS_MANIFEST` at require-time, and `readPluginsManifest()` accepts no arguments. The only way to point the function at a different manifest file is to set the environment variable *before* the module is first loaded. Both test files work around this by setting the env var, deleting the entry from `require.cache`, and re-requiring. `accessible-roots.test.js` makes it worse: it must bust the cache for **two** modules (`plugins-manifest.js` *and* `accessible-roots.js`) because `accessible-roots.js` captured `readPluginsManifest` and `enabledRegisterPaths` as free variables at its own load time. Any future module that requires `plugins-manifest.js` early (e.g., `config.js`'s `ensureRegistered()`) locks in the path for the life of the process, and any new test that wants a different manifest must replicate the same cache-bust dance. The interface is "shallow" in the sense that the function that most needs a parameter (the path) has none, while the one constant that *is* exported (`PLUGINS_MANIFEST_PATH`) is read-only and not wired into the function's signature.

Solution:
Let `readPluginsManifest(manifestPath?)` accept an optional path argument that defaults to the existing `PLUGINS_MANIFEST_PATH` constant, and let `resolveAccessibleRoots({ repoRoot, manifestPath? })` pass it through. Tests then inject a temp path as a plain argument and drop the cache-bust entirely. No behavioural change for existing callers that omit the argument.

Benefits:
Tests become deterministic and independent of module-load order; the two-line `delete require.cache[…]; require(…)` ritual disappears from both test files. Any future module that needs a non-default manifest can pass a path directly without mutating global state or fighting the require cache. The public API becomes self-documenting: the parameter that controls behaviour is visible in the function signature rather than hidden in an env-var side-effect at load time.

### AC-28 · `accessible-roots.js` recovers the plugin repo root with `path.dirname(registerPath)`, an implicit "register.js lives at repo root" contract
Strength: Worth exploring
Files: src/accessible-roots.js, src/plugins-manifest.js

Problem:
The manifest format stores a *file* path (`registerPath: "/abs/…/agent-manager-hygiene/register.js"`). `accessible-roots.js` recovers the *directory* it needs with `path.dirname(rp)`. This silently assumes `register.js` is always one level deep (i.e., at the repo root). If a plugin ever ships its entry point in a subdirectory (`…/plugin/src/register.js`), `dirname` yields `…/plugin/src/` and the grounding search is scoped to the wrong tree—no error, just a narrower (wrong) search root. The assumption is visible in the doc-comment example but is not encoded in the manifest schema, not validated by `enabledRegisterPaths()`, and not checked by `resolveAccessibleRoots()`. The `dirname` step is a one-line coupling that is easy to miss when adding a new plugin whose layout differs.

Solution:
Add a `repoRoot` (or `rootDir`) field to each manifest entry so the directory the grounding search should be scoped to is explicit data rather than a derived guess. `accessible-roots.js` reads `entry.repoRoot` directly and falls back to `path.dirname(entry.registerPath)` only for legacy manifests that lack the field, emitting a deprecation warning. `enabledRegisterPaths()` can validate that `repoRoot` is an absolute directory path when present.

Benefits:
The contract between the manifest producer and `accessible-roots.js` becomes explicit and self-documenting in the schema rather than implicit in a `dirname` call. Plugins with non-trivial layouts (monorepos, nested entry points) work correctly without a code change. The fallback path preserves backward compatibility with existing manifests, so the migration is additive and low-risk.

### AC-29 · `metrics` is an undeclared implicit global in `budget-monitor.js`
Strength: Strong
Files: budget-monitor.js

Problem:
`readEntries()` references a bare identifier `metrics` in its `catch` block (guarded by a `typeof` check) but never imports it, receives it as a parameter, or reads it from any configuration surface. The module silently depends on a caller having assigned `globalThis.metrics` before the parse-failure path executes. Because no `require`, parameter, or env-var reference mentions `metrics`, the dependency is invisible in the module's apparent interface: a reader scanning signatures and imports sees a two-parameter function with no way to know it conditionally emits a counter. In practice this means (a) a test asserting "parse failures are counted" must set and later delete a global, introducing order-dependence and cross-test contamination; (b) a test asserting the opposite must ensure the global is absent, which is fragile in a shared runner; and (c) in the file's own documented invocation pattern (`node -e` one-liner), the global is absent by default, so the metric is silently dropped with no log, no warning, and no return-value signal to the caller.

Solution:
Add an optional `metrics` (or `onParseFailure`) parameter to `readEntries(filePath, sinceMs, metrics?)` and thread it from `computeBudgetHealthy(options?)`, which itself accepts an optional reporter. Default to a no-op function so existing callers (the shell-script one-liner, current tests) need no changes. The caller that has a metrics library passes it in; the dependency becomes visible in the signature, testable by passing a stub, and the silent no-op becomes an explicit, documented default rather than an accidental side-effect of global state.

Benefits:
The module's true dependency graph matches its visible interface—no hidden global. Tests can assert counter emission or its absence by passing (or omitting) a stub, with zero global mutation and no cache-bust ritual. Future callers in CI sandboxes or secondary agent processes can inject their own metrics sink without polluting `globalThis`. The "silent drop" failure mode is eliminated: the no-op is now a deliberate, documented default rather than an accident of the runtime environment.

### AC-30 · `PROJECTS_DIR` / `CACHE_PATH` frozen at require-time; only override is env-var + cache-bust
Strength: Worth exploring
Files: budget-monitor.js

Problem:
`PROJECTS_DIR` and `CACHE_PATH` are resolved from `process.env` once at module load into module-level `const`s. `computeBudgetHealthy()` and `isBudgetHealthy()` take no arguments, so the only way to point the scanner at a non-default directory (a CI sandbox, a secondary agent's transcript store, a per-test `mkdtemp` dir) is to set the env var, delete the module from `require.cache`, and re-`require`—the same ritual the file's own comments describe for tests and that AC-30 documents for `PLUGINS_MANIFEST_PATH`. This makes the scan target an invisible, load-time side-effect rather than a parameter, coupling every test or alternate caller to the global `require.cache` lifecycle.

Solution:
Add an optional `projectsDir?` parameter to `computeBudgetHealthy(projectsDir?)` (and propagate to `isBudgetHealthy`), defaulting to the existing `PROJECTS_DIR` const. Derive `CACHE_PATH` from the resolved directory rather than freezing it at load. Existing callers that pass nothing see identical behaviour; tests and future callers inject a target directory directly without mutating env vars or busting the cache.

Benefits:
Tests no longer need the set-env → delete-from-cache → re-require dance, eliminating a class of flaky, order-dependent test failures. CI sandboxes and multi-agent deployments can scan arbitrary transcript stores in the same process without global mutation. The module's interface honestly reflects its one degree of freedom (the scan target), making the code easier to reason about and compose.
