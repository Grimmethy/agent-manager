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

### AC-31 · Registry mutation bypasses the `scope:'core'` guard
Strength: Strong
Files: src/task-source-registry.js

Problem:
`registerTaskSource` wraps the caller-supplied `config.next` in a closure that evaluates the `sourceEligibleHere` guard at invocation time, so that every call to `next` re-checks the `scope:'core'` eligibility before delegating to the original function. However, `updateTaskSource` performs a raw `Object.assign` onto the existing registry entry, replacing `next` with whatever the caller supplies. Because the update path never re-applies the `sourceEligibleHere` wrapper, a plugin can initially register a source with `scope:'core'` (installing the guard wrapper at registration time) and then later call `updateTaskSource` to swap in a new `next` implementation that executes without any scope check. The result is that a core-scoped task source can silently run on non-core projects, violating the architectural boundary the guard was introduced to protect.

Solution:
Route all mutations of a registered source's `next` field through a single internal setter (or make `updateTaskSource` re-apply the `sourceEligibleHere` wrapper to the incoming `next` before assigning it). The wrapper should capture the source's declared `scope` at registration time and re-validate on every invocation, so the eligibility contract is invariant across the source's lifetime regardless of how many times `next` is replaced.

Benefits:
Closes the bypass so the `scope:'core'` guarantee holds for the entire lifetime of a registered source, not just at the moment of initial registration. Eliminates a class of subtle plugin-privilege-escalation bugs where a seemingly benign update call silently removes a security boundary. Makes the registry's contract easier to reason about because there is exactly one code path that can place a function into the `next` slot, and that path always enforces the guard.

### AC-32 · Duplicated registry boilerplate across task-source and model-profile registries
Strength: Worth exploring
Files: src/task-source-registry.js, src/model-profile-registry.js

Problem:
`task-source-registry.js` and `model-profile-registry.js` each independently implement the same three-operation registry contract: `register` (throws on duplicate key), `get` (returns `undefined` for a missing key), and `clear` (iterates keys and deletes each). The logic is line-for-line equivalent apart from the entity name. Any future change to the registry contract—adding input validation, structured error types, logging hooks, or a different collision policy—must be implemented and tested in both files, and the two copies can drift independently over time.

Solution:
Extract the shared register/get/clear pattern into a small factory or base module (e.g., `createRegistry(entityLabel)`) that both registries instantiate, passing only the label used in error messages and any entity-specific validation hook. Each registry file then retains only its domain-specific logic (such as the `sourceEligibleHere` wrapping in the task-source registry) while delegating the generic bookkeeping to the shared implementation.

Benefits:
A single source of truth for the registry contract means a change to error semantics, validation, or logging is made once and propagates to both registries automatically. Reduces the surface area for drift: the two registries can no longer silently diverge on edge-case behaviour (e.g., one throws a `TypeError` while the other throws a `RangeError` for a duplicate key). New registries added to the codebase can adopt the same contract with a one-line instantiation rather than copying and adapting boilerplate.

### AC-33 · Global mutable persistence hook in task-history.js
Strength: Strong
Files: src/task-history.js, src/local-draft.js, src/review-task.js

Problem:
`setHistoryPersistHook` assigns to a module-level `let persistHook` inside `task-history.js`, creating a process-wide mutable singleton that is invisible in the signature of `appendHistoryEvent`. Any module that calls `setHistoryPersistHook`—such as `local-draft.js` or `review-task.js`—silently alters the behavior of every subsequent `appendHistoryEvent` call in that process, regardless of which task or pipeline stage is being processed. The "opt-in per process" comment masks the fact that the hook is actually bound at module-load time, so two pipeline stages or test cases registering different hooks in the same process will interfere with each other, and it is impossible to give different tasks different persistence behaviors within a single process.

Solution:
Remove the module-level `persistHook` variable and `setHistoryPersistHook` entirely. Instead, add an optional trailing parameter to `appendHistoryEvent(task, stage, detail, persistHook?)`. When the parameter is omitted or `undefined`, the function behaves exactly as it does today with no hook registered (no persistence side-effect). Callers that previously called `setHistoryPersistHook(fn)` simply pass `fn` as the fourth argument at each call site. This makes the dependency explicit in the function signature, scopes persistence behavior to the individual call, and eliminates the hidden global.

Benefits:
The coupling between unrelated modules disappears: `local-draft.js` and `review-task.js` no longer share a hidden mutable channel, and each call site declares its own persistence behavior. Test isolation improves because a test that registers a hook no longer leaks it into subsequent tests in the same process. The function's contract becomes self-documenting—any reader of `appendHistoryEvent` can see at a glance whether persistence is possible without hunting for a setter elsewhere.

### AC-34 · Hidden filename contract between requeue-attribution.js and pipeline-forensics.js
Strength: Strong
Files: src/requeue-attribution.js, src/pipeline-forensics.js

Problem:
`checkAndEscalate` in `requeue-attribution.js` writes a file to `queue/forensics-requests/requeue-attribution-<sig>.json`, and a comment in that file explicitly states that `pipeline-forensics.js`'s `coverageEntryActive` check is "keyed on this exact filename." The two modules are therefore coupled through an implicit filename convention that is not enforced by any shared constant, type, or interface. A reader of `requeue-attribution.js`'s public interface has no way to know that `pipeline-forensics.js` depends on the exact string format, and if either side changes its pattern the other will silently break—files will be written but never picked up, with no error or log to indicate the mismatch.

Solution:
Extract the filename pattern (the directory, the prefix, and the signature-interpolation format) into a small shared utility module, e.g. `src/lib/forensics-request-naming.js`, that exports a single function such as `forensicsRequestPath(sig)`. Both `requeue-attribution.js` and `pipeline-forensics.js` import and call that function instead of each hard-coding the string. The shared module becomes the single source of truth for the naming contract, and any future change to the pattern is made in one place.

Benefits:
The hidden contract becomes a visible, importable dependency: a reader of either file can follow the import to see exactly what naming convention is in effect. A change to the pattern is a one-line edit in the shared module rather than a coordinated two-file change, eliminating the class of silent breakage where files are written but never consumed. The convention is also trivially unit-testable in isolation, and the coupling is now discoverable through standard "who imports this?" tooling rather than through a comment.

### AC-35 · Four near-identical deterministic gate functions in one file
Strength: Strong
Files: src/lib/deterministic-extract.js, src/deterministic-draft-registry.js

Problem:
`deterministic-extract.js` exports four functions — `tryDeterministicScriptExtractEdit`, `tryDeterministicOnePassDecompose`, `tryDeterministicNodeModuleDecompose`, and `tryDeterministicBlueprintDecompose` — whose bodies are structurally identical: each checks `ctx.deterministicApply` against its own kind string, evaluates a kind-specific predicate on the context shape, and then delegates to the single shared `tryRegisteredDeterministicDraft(task, attempt)`. The file's own header acknowledges these "now only gate on their own kind and dispatch here" and points to `deterministic-draft-registry.js` as the real design home, yet the gate (kind check + predicate + dispatch) is still hand-written four times. Adding a fifth deterministic kind requires a fifth copy of the same `if (!(ctx && ctx.deterministicApply === …)) return null; return tryRegisteredDeterministicDraft(…)` shape, and the set of supported kinds is scattered across four functions rather than one table. The per-kind predicate is the only thing that genuinely varies, but it is interleaved with the shared dispatch, so variation and invariant are not separated.

Solution:
Collapse the four wrappers into a single data-driven gate. Introduce one internal `tryDeterministic(task, attempt)` that reads `ctx.deterministicApply`, looks up the matching entry in a small array or `Map` of `{ kind, predicate }` pairs, runs the predicate, and calls `tryRegisteredDeterministicDraft` exactly once. The four public named exports remain as thin one-liners that delegate to this shared gate (or callers migrate to a single entry point), so the external API is unchanged. The per-kind predicates become the only per-kind data, and the null-gate contract plus dispatch live in exactly one place.

Benefits:
Adding a new deterministic kind is now a one-line table entry (kind string + predicate) instead of a new exported function with a copy-pasted guard. The invariant "check kind → check predicate → delegate" is stated once, eliminating the risk that a future edit to the dispatch or null-contract is applied to three of the four functions and missed on the fourth. The file's stated intent (the registry is the design home) is made structurally true rather than merely documented.

### AC-36 · Two parallel git-execution paths in stacked-grounding.js
Strength: Strong
Files: src/stacked-grounding.js

Problem:
`stacked-grounding.js` defines a shared `runGit(args, cwd)` helper that sets `GIT_ENV`, `GIT_TIMEOUT_MS`, utf-8 encoding, and `cwd`, and both `readFileAtRef` and `grepAtRef` route through it. However, `resolveAtRef` bypasses the helper entirely and inlines its own `execFileSync('git', ['ls-tree', …], { cwd, encoding: 'utf8', env: GIT_ENV, timeout: GIT_TIMEOUT_MS, maxBuffer: 64*1024*1024 })`, re-declaring the same environment hardening and timeout. The "how do we run git safely" decision (no terminal prompt, no interactive GCM, bounded timeout, bounded buffer) is now expressed in two places. If the timeout, env hardening, or buffer policy changes, a reader must remember to update both `runGit` and the inline call, and a change to one silently diverges from the other. The reason the author inlined rather than extended the helper is that `resolveAtRef` needs a larger `maxBuffer` than the other two commands, which the current `runGit` signature cannot express — a tell that the helper's interface is too narrow for the module's own needs.

Solution:
Extend `runGit` to accept an optional options-override parameter (e.g. `runGit(args, cwd, { maxBuffer })`) that merges caller-supplied values over the defaults, or split into a small internal `gitExec(args, cwd, opts)` that both `runGit` and `resolveAtRef` call. `resolveAtRef` then routes through the same executor, passing its larger buffer as a parameter rather than re-declaring the full `execFileSync` call. The git-invocation contract (env, timeout, encoding, buffer policy) lives in exactly one place.

Benefits:
A single change to the timeout, env hardening, or buffer default propagates to all git calls automatically. The module no longer contains two independent expressions of the same safety policy, removing the divergence risk. The helper's interface now matches the module's actual needs, so future git commands that require different buffers or options can be added without introducing yet another inline `execFileSync`.

### AC-37 · MAX_SIDE_FINDINGS_PER_RESPONSE frozen from env at module load
Strength: Worth exploring
Files: src/side-finding.js

Problem:
`side-finding.js` resolves `const MAX_SIDE_FINDINGS_PER_RESPONSE = Number(process.env.AGENT_MANAGER_MAX_SIDE_FINDINGS_PER_RESPONSE) || 3;` once at require time into a module-level const, then reads that const inside `extractSideFindings`. The cap is a per-response policy, but it is bound to the process environment at load. A test or an alternate caller that wants a different cap must set the env var and bust the `require.cache` to re-require the module — the same load-time-freeze pattern flagged elsewhere in this codebase. The severity is mitigated by the fact that the value is also exported (so it is at least visible in the interface) and the default of 3 is a sane constant, but it still couples a tunable policy to global load-time state rather than to the call site.

Solution:
Resolve the cap inside `extractSideFindings` at call time (reading `process.env` on each invocation) or accept an optional `maxFindings` parameter that defaults to the current constant. Either approach makes the policy a per-call decision rather than a load-time one, while preserving the existing default and the exported constant for backward compatibility.

Benefits:
Tests and alternate callers can vary the cap without cache-busting or process-level env mutation. The policy is co-located with the function that enforces it, making the dependency explicit rather than implicit in module-load order. If the team treats the cap as a genuine deployment-time constant, the change is harmless; if it ever needs to be per-call, the refactor is already in place.

### AC-39 · `checkGpuContention` hard-codes `node:sqlite` and an assumed DB schema
Strength: Strong
Files: src/requeue-attribution.js

Problem:
`checkGpuContention` in `src/requeue-attribution.js` dynamically requires `node:sqlite` and assumes a `model-stats.db` file with a specific schema (`model_calls` table with `task_id`, `started_at`, `latency_ms`). This is a tight, implicit coupling to a particular runtime environment and database structure. If `node:sqlite` is unavailable (older Node versions, alternative runtimes) or the schema changes, the function silently returns `false`, potentially missing real GPU-contention signals. The dependency is not declared in any interface or configuration, making it hard to detect or substitute.

Solution:
Introduce a `GpuContentionChecker` interface (or a simple function-type contract) and make `classifyRequeue` accept an optional `checkGpuContention` parameter. The default implementation can continue to use `node:sqlite`, but tests and alternative environments can inject a mock or a different backend. This makes the dependency explicit and swappable without modifying the attribution logic.

Benefits:
Testability improves because the checker can be mocked without requiring a real SQLite database or the `node:sqlite` module. Migration to a different database backend or runtime no longer requires editing the attribution module. The dependency on GPU-contention data is now explicitly declared in the function signature rather than hidden behind a dynamic `require`.

### AC-40 · Streaming read loop in `stream_plan_with_tools` has no timeout — a mid-stream stall parks the worker thread forever
Strength: Strong
Files: python/dashboard/local_tool_client.py

Problem:
`run_plan_with_tools` wraps its `subprocess.run(...)` in a `try/except subprocess.TimeoutExpired` block and normalizes a hang into `LocalToolClientError` — the file's own comment documents this as a live, caught-in-production gap. But `stream_plan_with_tools`, which the file identifies as the primary path for the Chat panel's live-streamed replies, has no equivalent protection on the part that actually blocks: the `for line in proc.stdout:` loop. `SUBPROCESS_TIMEOUT_S` (6000 s) is applied only to the post-loop `proc.wait(timeout=...)`, which is reached only after the child has already closed its stdout. The timeout therefore bounds the gap between "last line read" and "process reaped," not the time the process spends producing (or failing to produce) output. If `local-tool-client.js` starts emitting chunks and then stalls mid-stream (a stuck tool call, a hung Ollama request, a deadlock in the GPU single-flight lock the file itself references), the `for line in proc.stdout` loop blocks indefinitely. `subprocess.TimeoutExpired` is never raised because no `subprocess.run`/`wait` is in flight. The `finally` block's `proc.kill()` is never reached because the generator is still suspended inside the `for`. The Flask worker thread is parked forever, the user sees a frozen Chat panel, and the caller's `except LocalToolClientError` (and app.py's `TimeoutError`/`ConnectionError`/`OSError` trio, per claude_client.py's own comment) never fires. This is the exact class of bug the sibling function was patched to fix, left unpatched in the function that is used more.

Solution:
Give the read loop a real deadline. Because the blocking read itself (`for line in proc.stdout:`) is where the stall occurs, a simple monotonic-clock check inside the loop body cannot work — the loop body never executes while the read is blocked. The deadline must be enforced on the read operation itself. Drive the read from a helper thread that calls `proc.stdout.readline()` under a lock while the main thread enforces the deadline, or use `select`/`poll` on the stdout file descriptor with a timeout. When the deadline is exceeded, call `proc.kill()` and raise `LocalToolClientError` with the same "may be queued behind a slow or stuck worker-lane task" message the sibling uses. The key requirement is that the blocking read — not the post-loop wait — carries the deadline, so a mid-stream stall is bounded and normalized into the one exception type callers already catch.

Benefits:
A mid-stream hang becomes a bounded, typed failure instead of a permanent worker-thread leak — the same guarantee `run_plan_with_tools` already provides and the file's own comments claim is the point of the module. The Chat panel's error handling, which only knows `LocalToolClientError` plus the builtin trio, actually works for the streaming path, matching the non-streaming path. No new exception type, no caller changes; the two siblings finally share the same timeout exception type on the failure path.

### AC-41 · `claude_client.generate` and `ollama_client.generate` return different shapes despite a documented "same return shape" contract
Strength: Worth exploring
Files: python/dashboard/claude_client.py, python/dashboard/ollama_client.py

Problem:
`claude_client.generate`'s docstring states its contract explicitly: "Same return shape as ollama_client.generate(): {response, thinking}." But the actual return value includes five keys — `response`, `thinking`, `degenerate`, `model`, `sessionId` — while `ollama_client.generate` returns only `response` and `thinking`. The two functions that are documented as interface-interchangeable (the whole reason `claude_client.generate` keeps `think`/`temperature`/`num_predict` in its signature so callers built against the Ollama interface don't need a separate call shape per provider) do not in fact have the same result shape. A caller that does `result["model"]` or `result["sessionId"]` works on Claude and raises `KeyError` on Ollama; a caller that does `result.get("model")` gets a value on Claude and `None` on Ollama with no signal that the field is provider-specific. The `model` field is also asymmetric in meaning: on Claude it is a prefixed string (`f"claude:{resolved_model}"`) added specifically for model-stats.db disambiguation, while on Ollama it is absent entirely. The "one interface, two providers" abstraction the headers promise is only half-true: interchangeability holds at the argument level but not at the result level, and the result is what downstream code (model_stats_client.record_call, the Discuss/Grill panels) actually consumes.

Solution:
Have `ollama_client.generate` also return the full five-key shape — `degenerate: None`, `model: f"ollama:{MODEL}"`, `sessionId: None` — so both providers return the same keys and callers can index uniformly. The `model` value must use the same `provider:model` prefix convention that `claude_client.generate` uses (`f"claude:{resolved_model}"`), since that prefix is what model-stats.db relies on for disambiguation; using the raw model name would break that consumer. This is the lower-risk option: it only adds keys, never removes or renames, so existing `result["response"]`/`result["thinking"]` access is untouched. The alternative — dropping the "same return shape" claim from `claude_client.generate`'s docstring and documenting the two shapes explicitly — leaves the caller-side `KeyError`/`None` asymmetry in place and is the weaker fix.

Benefits:
The provider-abstraction the module headers promise actually holds at the result level, not just the argument level. Callers in the Discuss/Grill/Chat panels and in model_stats_client.record_call can read `model`, `degenerate`, and `sessionId` without a per-provider branch or a `KeyError` risk, and the "models should be fully interchangeable" principle the ollama_client header cites is honored in the return value, not just the env-var handling.

### AC-42 · `_run_event` in model_stats_client swallows non-zero exits with no log — a stats-recording failure is indistinguishable from a successful record
Strength: Worth exploring
Files: python/dashboard/model_stats_client.py

Problem:
`_run_event` is the single choke point for `record_call` and `record_outcome`. It calls `subprocess.run(..., capture_output=True, timeout=15)` and then does nothing with the result — no `returncode` check, no stderr read. The only failure path it handles is the exception path (`OSError`, `subprocess.SubprocessError`), which is logged via `logger.warning`. But a non-zero exit — the normal way `model-stats-db.js` reports a failure (bad event name, a write error to model-stats.db, a malformed payload) — produces a `CompletedProcess` with `returncode != 0` and a populated `stderr`, and `_run_event` discards both silently. The file's stated contract is that every function "swallows its own errors" so stats recording never breaks the real feature; the current code satisfies that contract (no exception propagates), but it does so by silently discarding a non-zero exit with no log, which is more than the contract requires to be silent. If model-stats.db becomes unwritable (disk full, permissions, a lock held by another process), every `record_call`/`record_outcome` in the dashboard's interactive sessions fails with zero signal. The Models tab simply shows fewer rows, and the operator has no way to distinguish "the session wasn't recorded" from "the recording failed." The file's own 2026-09-06 comment about a real incident where model-stats.db had zero per-turn token data identifies exactly this class of blind spot. Notably, `get_turns_summary` in the same file *does* check `proc.returncode != 0` and returns `None` — so the correct pattern already exists in the file; `_run_event` simply doesn't apply it.

Solution:
In `_run_event`, after `subprocess.run` returns, check `result.returncode != 0` and, if so, emit a `logger.warning` with the event name and the stripped `stderr` (or the exit code if stderr is empty), matching the log format the exception path already uses. Keep the swallow — do not raise — so the "never break the real feature" contract holds. The fix is to make the swallow visible, not to make it loud. This is a one-line behavioral change with no caller impact.

Benefits:
A stats-recording failure becomes a logged, diagnosable event instead of a silent data gap — the same visibility `get_turns_summary` already provides for its read path. The "never break the feature" contract is preserved (still no exception), but the operator can now see *why* the Models tab is missing rows, which is the exact class of blind spot the file's own incident comment is trying to eliminate.

NOTE: Flag 3 was not applied as a "mistaken" flag because the draft's Problem section did not claim the current code *violates* the file's stated contract; it correctly noted the contract is satisfied (no exception propagates) and framed the missing log as a visibility gap beyond what the contract requires. The corrected Problem section makes this distinction explicit.

### AC-43 · `stacked-grounding.js` duplicates git-runner's remote-branch existence check
Strength: Strong
Files: src/stacked-grounding.js

Problem:
The module's own header comment states that `resolveGroundingRef` reuses `git-runner.js`'s real adapter (the same fetch + refs/remotes/origin/* existence check that `apply-task.js`'s `prepareStackedBranch` already depends on) to avoid a second hand-rolled check. However, the implementation contradicts this by calling `runner.fetchBranch(branch)` and `runner.remoteBranchExists(branch)` directly rather than delegating to a unified helper inside `git-runner.js`. This creates a tight coupling to the internal API of `git-runner.js`—specifically the assumption that `createRealGitRunner` returns an object exposing exactly those two methods—while failing to centralize the logic. If `git-runner.js` refactors its existence-check mechanism (e.g., switching to `git ls-remote` or caching results), `stacked-grounding.js` will break silently or require a coordinated change, violating the "one place to get it right" principle the module claims to implement.

Solution:
Move the `fetchBranch` + `remoteBranchExists` logic into `git-runner.js` as a single public method (e.g., `runner.resolveRemoteBranch(branch)` or `runner.isRemoteBranchAvailable(branch)`). `stacked-grounding.js` should call that one method instead of orchestrating the two-step sequence itself. This ensures the "real adapter" logic lives in one place and that `stacked-grounding.js` depends on a stable, documented interface rather than an implementation detail of the runner's internal state.

Benefits:
Eliminates the risk of `stacked-grounding.js` breaking when `git-runner.js` internals change. Makes the dependency explicit and testable: `stacked-grounding.js` can mock a single `resolveRemoteBranch` method rather than mocking two separate methods and their side effects. Aligns the code with its own stated design principle of centralizing the "which git ref" decision.

### AC-44 · `incident-amplification.js` bypasses `side-finding.js`'s extraction/dedup pipeline
Strength: Worth exploring
Files: src/incident-amplification.js, src/side-finding.js

Problem:
`incident-amplification.js` calls `writeSideFindingInbox` directly for each grep hit, bypassing `extractSideFindings` and the associated deduplication logic (title-based dedup, placeholder filtering, max-count enforcement) that `side-finding.js` provides. The comment in `incident-amplification.js` claims it reuses "side-finding.js/side-finding-sweep.js's already-built filing+dedup machinery end to end," but it only reuses the filing part (`writeSideFindingInbox`), not the dedup part. If `grepCodebase` returns multiple hits for the same file:line (e.g., due to multi-line matches or repeated patterns), `incident-amplification.js` will file multiple identical side-findings, whereas `extractSideFindings` would have deduplicated them. This creates an inconsistency in the side-finding inbox: some entries are deduplicated (from model responses), others are not (from incident amplification), forcing `side-finding-sweep.js` to handle both cases and contradicting the claim that no new dedup logic is needed.

Solution:
Refactor `incident-amplification.js` to construct a synthetic text block containing the grep hits in the `SIDE-FINDING:` format, then pass it through `extractSideFindings` to leverage the existing dedup and filtering logic. Alternatively, extract the dedup logic from `extractSideFindings` into a separate `deduplicateFindings` function that both `extractSideFindings` and `incident-amplification.js` can call. Either approach ensures all side-findings, regardless of source, go through the same dedup pipeline.

Benefits:
Ensures consistent deduplication behavior across all side-finding sources. Reduces the risk of duplicate entries in the inbox that would otherwise require additional handling in `side-finding-sweep.js`. Makes the "reuses existing machinery" claim accurate and reduces the surface area for dedup-related bugs.

### AC-49 · Rename checkGpuContention to defaultGpuContentionChecker
Strength: Strong
Split-Depth: 1
Files: src/requeue-attribution.js

Problem:
checkGpuContention hard-codes require('node:sqlite') and an assumed model_calls schema (task_id, started_at, latency_ms) with no way for a caller or test to substitute a different implementation. The function name gives no indication it is a default that could be overridden.

Solution:
Rename the existing function checkGpuContention(taskId, atMs, repoRoot) to defaultGpuContentionChecker(taskId, atMs, repoRoot). The body, parameters, return type, and error-handling semantics stay identical. This is a pure rename to establish the 'default implementation' role before the injection point is added at the call site.

Benefits:
Makes the default-implementation role explicit in the name, matching the existing pattern in the same file where classifyViaFallbackModel defaults to callBackend. Unblocks the next step (adding an injectable parameter at the call site) without changing any behaviour.

### AC-50 · Add injectable checkGpuContention parameter at the call site
Strength: Strong
Split-Depth: 1
Files: src/requeue-attribution.js
Depends-On: AC-49

Problem:
The classification entry point (the function that invokes the GPU-contention check as its step-2 deterministic signal) calls the now-renamed defaultGpuContentionChecker directly with no way to substitute a mock or alternative implementation, so tests must either stand up a real node:sqlite database or accept the silent-false path.

Solution:
In the function that currently calls defaultGpuContentionChecker(taskId, atMs, repoRoot), append an optional trailing parameter (e.g. checkGpuContention) of the same (taskId, atMs, repoRoot) => boolean shape. Inside that function, select the active checker with const checker = checkGpuContention || defaultGpuContentionChecker; and call checker(taskId, atMs, repoRoot) in place of the direct call. Existing callers that pass no extra argument are unaffected because the parameter is optional and appended last. This mirrors the existing injectable-callModel pattern already used by classifyViaFallbackModel in the same file.

Benefits:
Tests can inject a stub that returns true or false without touching node:sqlite or the model-stats.db schema. Production behaviour is unchanged when no checker is supplied. Follows the file's own established injection convention (callModel || callBackend), keeping the change idiomatic and low-risk.

### AC-59 · Duplicated JSON I/O with Non-Atomic Writes Bypassing the Shared Atomic Primitive
Strength: Strong
Files: src/fabricated-path-recheck-sweep.js, src/task-anywhere.js, src/atomic-write.js

Problem:
`fabricated-path-recheck-sweep.js` defines its own `readJson` and `writeJson` helpers that reimplement logic already present in `task-anywhere.js` (`readJsonSafe`) and in the project's shared `atomic-write.js` module. Critically, the local `writeJson` helper in `fabricated-path-recheck-sweep.js` calls `fs.writeFileSync` directly, which is a non-atomic operation. The project has an explicit architectural decision—documented in the header of `atomic-write.js`—to route all JSON persistence through the atomic write primitive so that a crash mid-write cannot leave a truncated or corrupted file on disk. By bypassing that primitive, `fabricated-path-recheck-sweep.js` introduces a single point in the pipeline where a crash during a write can silently corrupt a task-state file, while every other module in the same community enjoys the durability guarantee. The duplication also means any future fix to the read/write helpers (e.g., adding schema validation, encoding handling, or locking) must be applied in two or three places, increasing the chance of drift.

Solution:
Remove the local `readJson`/`writeJson` helpers from `fabricated-path-recheck-sweep.js` and replace their call sites with imports from the shared modules: use `readJsonSafe` (or an equivalent exported from `task-anywhere.js` / a small shared utility) for reads, and `writeJsonAtomicSync` from `atomic-write.js` for writes. If `readJsonSafe` currently lives inside `task-anywhere.js` and is not exported, extract it into a small shared `json-io.js` module that both `task-anywhere.js` and `fabricated-path-recheck-sweep.js` import, so the read path is also single-sourced. No behavioural change is required; the public API of the sweep script stays the same.

Benefits:
A single, atomic write path eliminates the crash-corruption window in `fabricated-path-recheck-sweep.js` and brings its durability guarantee in line with the rest of the pipeline. Removing the duplicated helpers reduces the surface area that must be updated when the JSON I/O contract changes (encoding, schema validation, file locking). Reviewers and future contributors no longer need to wonder whether a given module respects the atomic-write invariant; the answer is uniformly "yes" because there is only one implementation.

### AC-60 · `task-anywhere.js` hand-syncs its queue-state list with the dashboard and nothing tests that they match
Strength: Worth exploring
Files: src/task-anywhere.js, python/dashboard/app.py

Problem:
`src/task-anywhere.js` defines `QUEUE_STATES` (8 directory names) and its comment says it is "kept in sync by hand with python/dashboard/app.py's own QUEUE_STATES (app.py:301)". On master the real definition is at `python/dashboard/app.py:202`, so the comment's line reference is already stale, and the two lists are identical only by coincidence of nobody having changed either since. No test compares them: `src/task-anywhere.test.js` and `src/migrate-history-status-note.test.js` exercise `QUEUE_STATES` from the JS side only. Adding, renaming or reordering a queue directory in one language without the other would make the Node lookup and the dashboard disagree about where a task lives, silently (a task in the new directory is invisible to one side).

Solution:
Add a parity test (Node, reading `python/dashboard/app.py` as text and extracting the `QUEUE_STATES = [...]` literal) asserting it equals `task-anywhere.js`'s exported `QUEUE_STATES` in both membership and order, and fix the stale `app.py:301` reference in the comment. Do not restructure the search logic and do not route it through `config.js`: no config-driven task-location mechanism exists for this (the sibling sweeps hardcode their own directory lists, e.g. `fabricated-path-recheck-sweep.js` `DIRS`). A shared JSON list read by both languages is an acceptable alternative if the parity test proves too brittle.

Benefits:
Drift between the Node task lookup and the dashboard is caught by CI instead of by a task going missing, at the cost of one small test.

### AC-63 · uptime-log.js re-declares heartbeat thresholds that dead-process-check.js owns, with a comment claiming shared semantics
Strength: Strong
Files: src/uptime-log.js, src/dead-process-check.js

Problem:
`uptime-log.js` locally declares `STALE_HEARTBEAT_SECONDS = 300` and `WORKER_ZOMBIE_THRESHOLD_SECONDS = 1200`, and its header comment explicitly promises that "down" means the same thing here as it does to the daemon that actually restarts processes (i.e., `dead-process-check.js`). But the constants are copy-pasted, not imported. If someone in `dead-process-check.js` tunes the zombie threshold from 1200 to 900, `uptime-log.js` silently keeps using 1200, and the system report's downtime accounting will disagree with the daemon's actual restart decisions. The comment becomes a lie, and no test in this community pins the two files together.

Solution:
Extract both constants into a shared `heartbeat-thresholds.js` module that both `uptime-log.js` and `dead-process-check.js` import, and update `dead-process-check.js` to read its thresholds from that shared module rather than defining them locally. Add a test that asserts `uptime-log.js`'s stale/heartbeat computation matches `dead-process-check.js`'s for a representative set of `(ageSec, isWorker)` inputs, so the "same meaning" claim is enforced by the test suite rather than asserted in a comment.

Benefits:
The "what counts as stale" policy has a single owner, eliminating the silent-divergence risk where a tuning change in one file silently desynchronizes the system report from the daemon's restart decisions. The test provides a regression net: if the two files ever drift, CI fails rather than the report being subtly wrong in production.

NOTE: Flag 1 was applied by making the shared-file approach the primary recommendation and explicitly requiring `dead-process-check.js` to be modified to import from it, rather than assuming it already exports the constants.

### AC-66 · `deterministic-recheck-registry.js` bundles two unrelated registries with different lifecycles and keying schemes
Strength: Strong
Files: src/deterministic-recheck-registry.js, src/pipeline-forensics.test.js

Problem:
The module exports two distinct registries side by side: a source-keyed deterministic-recheck registry (register/get/clear keyed by task-source name, storing `perFileRules`/`repoWideRules` config objects) and a rule-keyed pre-dispatch gate registry (register/get/clear keyed by rule ID, storing detector functions). The gate registry additionally self-registers a built-in `sequential-await-in-loop` detector at module load time, making the module stateful by import, while the recheck registry is purely passive. These two mechanisms have different keying schemes, different consumers, different extension points, and different lifecycles, yet they share a single module identity. Any change to gate semantics or recheck semantics forces both to live in the same file, and importing the module carries an implicit side effect that the rest of the codebase (e.g. `model-profile-registry.js`) does not exhibit.

Solution:
Split the module into two separate modules: one for source-keyed deterministic-recheck registration (register/get/clear/list for `perFileRules`/`repoWideRules`) and one for rule-keyed pre-dispatch gate registration (register/get/clear for gate detectors). Within the new gate module, preserve the codebase’s “single swap point” discipline (as seen in `hub-review-detection.js`): keep the default `sequential-await-in-loop` detector defined inside the gate module and expose a `set`/`get` (or `register`/`get`) swap mechanism for it, rather than moving the default implementation to a bootstrap file. Update imports in `pipeline-forensics.test.js` and any other consumers to pull each registry from its own module.

Benefits:
Each module has a single responsibility and a single, predictable import side-effect profile (none). Changes to gate semantics no longer require touching the recheck module and vice-versa. The test file's import list becomes a clear statement of which registries are under test, removing the ambiguity that currently forces the `try/catch` workaround. New contributors can reason about one registry at a time without mentally separating two interleaved concerns.

NOTE (verified against master, 2026-09-25): the recheck half of `deterministic-recheck-registry.js` is a documented plugin API (`docs/PLUGIN_API.md` lists `registerDeterministicRecheck`, `getDeterministicRecheck`, `getRecheckSources`, `clearDeterministicRecheckRegistry`), and the hygiene plugin registers through it, so keep those exports at the existing path. The pre-dispatch gate functions (`registerPreDispatchGate` and friends) are NOT in the documented API, so they are the half to move to a new module; if any plugin already imports them, re-export from the old path. Also keep the file free of external requires (`silent-catch-plan-cap.js` cites that as a hot-path constraint the module holds). AC-68's claim of different verb shapes is wrong: both registries already use register/get/clear; ignore any candidate built on it.

### AC-69 · SDK re-export surface leaks test-only internals and couples read/write paths
Strength: Strong
Files: src/sdk/candidate-fulfillment.js, src/sdk/lib/candidate-lifecycle.js

Problem:
`candidate-fulfillment.js` builds its public `module.exports` by spreading `...candidateDocs` (the AC-NNN write-side namespace) alongside `nextCandidateFulfillmentTask`, `windowFetchedFileContent`, and a block of low-level helpers (`findFuzzyMatch`, `windowAroundIndex`, `collectAnchorHits`, `snippetFromSection`, `quotedSymbolsFromSection`) that the module's own comment labels as "exported for the plugin's own grounding tests." The module header frames the file as "one import for the whole candidate lifecycle," but the boundary between the documented public API and test-only internals is drawn only by a comment, not by any structural separation. A consumer importing `candidate-fulfillment` for `nextCandidateFulfillmentTask` transitively receives the write-side `candidateDocs` namespace and the fuzzy-matching/grounding primitives, with no structural way to distinguish stable contract from implementation detail. Any rename of a helper (e.g. `collectAnchorHits`) becomes a breaking change to the SDK surface even though it was never part of the documented API.

Solution:
Split the test-only helpers out of `candidate-fulfillment.js`'s `module.exports`. Move them to the `./lib/*` modules where they already live, and have the plugin's grounding tests import them from those lib modules directly. The SDK's exported surface should then match exactly what `docs/PLUGIN_API.md` documents: the two lifecycle functions plus the documented write-side namespace, with no comment-only boundary.

Benefits:
The SDK surface becomes a true contract: what is exported is what is documented, and what is documented is what is exported. Renaming or refactoring internal helpers no longer risks breaking a downstream consumer who happened to destructure them. The read/fulfill path is no longer structurally coupled to the write path through a shared export object, and the "one import" convenience no longer silently drags in five grounding primitives that plugins are not meant to depend on.

### AC-70 · `coverageEntryActiveLocal` is a misleading pass-through that fragments ownership
Strength: Strong
Files: src/lib/task-audit.js, src/pipeline-forensics.js

Problem:
`coverageEntryActiveLocal(entry, now)` in `task-audit.js` is defined as a one-line delegation: `return pipelineForensics.coverageEntryActive(entry, now);`. The `Local` suffix implies local logic or a local override, but there is none—the function is a pure alias. The other three exports in the same file (`markPipelineHealthAuditChecked`, `markUiVisibilityAuditChecked`, `markPipelineDebriefReported`) do real work (lazy `require` of sibling audit modules, writing the debrief coverage file), so the pass-through stands out as anomalous. A caller reading `task-audit.js` cannot tell whether the `Local` suffix implies different semantics (it does not), and the indirection forces a second hop to `pipeline-forensics.js` for what is a single function whose true home is there. This fragments ownership: the function's implementation lives in `pipeline-forensics.js`, but it is re-exposed here under a misleading name, making the real owner harder to find.

Solution:
Drop `coverageEntryActiveLocal` from `task-audit.js` and have callers import `coverageEntryActive` from `pipeline-forensics.js` directly. If the pass-through exists to provide a dependency-injection seam (so tests can stub the audit module), rename it to reflect that role (e.g. `coverageEntryActive` without the `Local` suffix) and add a one-line comment documenting the seam, rather than a suffix that implies local behavior that does not exist.

Benefits:
Ownership of `coverageEntryActive` is unambiguous: it lives in `pipeline-forensics.js` and is imported from there. The `task-audit.js` module presents a consistent surface where every export does distinct work. Callers no longer need to wonder whether the `Local` suffix changes behavior, and a grep for the function's implementation lands in one place instead of two.

### AC-71 · Remove dead `require('../task-sources.js')` from prompt-assembly and prompt-blocks
Strength: Strong
Files: src/lib/prompt-assembly.js, src/lib/prompt-blocks.js

Problem:
Both `prompt-assembly.js` and `prompt-blocks.js` open with a bare side-effect `require('../task-sources.js')` that neither file's code ever references. Every exported function in both files operates solely on its own parameters; no symbol from `task-sources.js` is destructured, called, or read. The require was inherited from the parent module (`src/prompts.js`) where it was needed, but the extracted functions carry no logical dependency on it. This creates a hidden coupling and failure surface: if `task-sources.js` or anything it transitively requires throws at load time, or if a future refactor introduces a require cycle back through these files, `assemblePrompt` and the four block functions will crash despite performing no work that could interact with task-sources. It also inflates the apparent coupling in any dependency-graph analysis and makes each module harder to reason about in isolation.

Solution:
Delete the `require('../task-sources.js')` line from both `src/lib/prompt-assembly.js` and `src/lib/prompt-blocks.js`. No exported function's behaviour changes. If a future function genuinely needs a task-source symbol, the require can be added back at that point with a clear, local justification.

Benefits:
Eliminates a load-time failure surface that is unrelated to the actual work of prompt formatting, removes a misleading hard edge from a pure formatting module into the task-source registry, and makes each module independently testable and analyzable without pulling in the entire task-source dependency tree.

### AC-74 · Export readJsonSafe from task-anywhere.js so it becomes a shared importable primitive
Strength: Strong
Split-Depth: 1
Files: src/task-anywhere.js

Problem:
task-anywhere.js defines a file-private helper `readJsonSafe(fullPath)` (a try/catch around `JSON.parse(fs.readFileSync(fullPath, 'utf8'))` that returns `null` on any error) and uses it throughout `findTaskAnywhere`, but it is NOT in the module's export list: `module.exports = { findTaskAnywhere, QUEUE_STATES };`. Meanwhile fabricated-path-recheck-sweep.js carries its own byte-for-byte-equivalent local `readJson(p)` (same `JSON.parse(fs.readFileSync(p,'utf8'))` in a try/catch returning `null`). The two are duplicated safe-JSON-read implementations, and the sweep cannot drop its copy because the canonical one is not importable.

Solution:
Add `readJsonSafe` to the export list. Change the final line `module.exports = { findTaskAnywhere, QUEUE_STATES };` to `module.exports = { findTaskAnywhere, QUEUE_STATES, readJsonSafe };`. Nothing else changes: the `readJsonSafe` function body and its existing internal callers inside `findTaskAnywhere` are left exactly as they are.

Benefits:
readJsonSafe becomes a shared, importable primitive with zero behavioural change to task-anywhere.js itself; a downstream module can now import the single canonical safe-JSON-read instead of re-declaring an identical copy.

### AC-75 · Route fabricated-path-recheck-sweep.js through the shared read/atomic-write primitives and delete its local helpers
Strength: Strong
Split-Depth: 1
Files: src/fabricated-path-recheck-sweep.js
Depends-On: AC-74

Problem:
The sweep defines two local helpers and uses both: `function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }` (called at `const task = readJson(filePath);`) and `function writeJson(p, data) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(data, null, 2)); }` (called at `writeJson(dest, fresh);`). The read helper duplicates task-anywhere.js's `readJsonSafe`, and the write helper is a plain non-atomic `fs.writeFileSync` that bypasses the shared atomic primitive `writeJsonAtomicSync` in atomic-write.js (which temp-file-writes in the same directory, fsyncs, then renames — the crash-safety guarantee the rest of the pipeline relies on). A crash mid-write here can leave a truncated, unparseable task file. Note the one real behavioural gap: `writeJsonAtomicSync`/`writeAtomicSync` open the temp file with `fs.openSync(tmp, 'w')`, which does NOT create the parent directory and throws if it is absent, whereas the local `writeJson` created it first via `fs.mkdirSync(path.dirname(p), { recursive: true })`.

Solution:
At the top of the file add two imports: `const { readJsonSafe } = require('./task-anywhere.js');` and `const { writeJsonAtomicSync } = require('./atomic-write.js');`. Replace the read call site `const task = readJson(filePath);` with `const task = readJsonSafe(filePath);`. Replace the write call site `writeJson(dest, fresh);` with the atomic write while preserving the directory-creation the local helper performed: `fs.mkdirSync(path.dirname(dest), { recursive: true }); writeJsonAtomicSync(dest, fresh);`. Delete both local helper definitions (`function readJson(p) {...}` and `function writeJson(p, data) {...}`). Keep `const fs = require('fs');` because `fs` is still used by `fs.readdirSync`, `fs.existsSync(dest)`, `fs.unlinkSync(filePath)`, and the retained `fs.mkdirSync`. Do not modify atomic-write.js — it already exports `writeJsonAtomicSync`.

Benefits:
The sweep now shares the single canonical safe-JSON-read (no duplicated `readJson`) and writes task files through the shared atomic primitive, gaining the same crash-safety guarantee as the rest of the pipeline. `writeJsonAtomicSync` emits identical JSON bytes to the old `writeJson` (`JSON.stringify(data, null, 2)`), so the on-disk content is unchanged and the only behavioural change is that the write is now atomic; the retained `fs.mkdirSync` keeps the parent-directory creation that the atomic primitive does not perform.
