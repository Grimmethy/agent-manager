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

### AC-78 · Create shared heartbeat-thresholds module as single source of truth
Strength: Strong
Split-Depth: 1
Files: src/heartbeat-thresholds.js

Problem:
uptime-log.js and dead-process-check.js each declare their own copies of STALE_HEARTBEAT_SECONDS and WORKER_ZOMBIE_THRESHOLD_SECONDS. They have already diverged: uptime-log.js holds WORKER_ZOMBIE_THRESHOLD_SECONDS = 1200 while dead-process-check.js (the authoritative owner, per its long rationale comment) holds 1680. The header comment in uptime-log.js claims the values are shared, but they are not. There is no single file that both modules can import from, so any future tuning change must be made in two places and is easy to miss.

Solution:
Create src/heartbeat-thresholds.js (CommonJS, matching the project's require/module.exports style) that exports exactly two named constants: STALE_HEARTBEAT_SECONDS = 300 and WORKER_ZOMBIE_THRESHOLD_SECONDS = 1680 (the value dead-process-check.js already uses, which is the correct one). Include a brief module-level comment stating this is the single source of truth for stale/zombie thresholds and that both the uptime reporter and the dead-process daemon must read from here. Do not include WORKER_ZOMBIE_THRESHOLD_SECONDS_P40 (that is specific to dead-process-check.js's P40 lane handling) or any logic, helpers, or other constants.

Benefits:
Establishes one canonical location for the two threshold values. Eliminates the risk of the two files drifting apart again (which has already happened: 1200 vs 1680). Gives both consumers a single import target, making the 'shared semantics' guarantee structural rather than aspirational.

### AC-79 · Point dead-process-check.js at the shared thresholds module
Strength: Strong
Split-Depth: 1
Files: src/dead-process-check.js
Depends-On: AC-78

Problem:
dead-process-check.js currently declares its own local const STALE_HEARTBEAT_SECONDS = 300 and const WORKER_ZOMBIE_THRESHOLD_SECONDS = 1680 (with a long rationale comment). These are the authoritative values that uptime-log.js should be reading, but because they are local to this file, uptime-log.js cannot import them and instead re-declares its own (stale) copies.

Solution:
Remove the two local const declarations (STALE_HEARTBEAT_SECONDS and WORKER_ZOMBIE_THRESHOLD_SECONDS) and the associated rationale comment block. Replace them with a single require: const { STALE_HEARTBEAT_SECONDS, WORKER_ZOMBIE_THRESHOLD_SECONDS } = require('./heartbeat-thresholds.js');. Keep WORKER_ZOMBIE_THRESHOLD_SECONDS_P40 and P40_INSTANCE_IDS as local declarations in this file (they are specific to the P40 lane logic and not shared). All existing internal references (the zombieThreshold ternial, the isZombie comparison) resolve to the same binding names, so no further edits are needed in the decision logic. Do not change any restart-decision code, cooldown logic, orphan-detection code, or exports.

Benefits:
dead-process-check.js now reads its thresholds from the shared module, making it the canonical consumer. The long rationale comment can be relocated to the shared module (or kept here as a note pointing to it) without changing behaviour. Removes the last local copy of these two constants from this file.

### AC-80 · Point uptime-log.js at the shared thresholds module (fixes the 1200-vs-1680 divergence)
Strength: Strong
Split-Depth: 1
Files: src/uptime-log.js
Depends-On: AC-78

Problem:
uptime-log.js declares const STALE_HEARTBEAT_SECONDS = 300 and const WORKER_ZOMBIE_THRESHOLD_SECONDS = 1200 locally, and its header comment asserts these 'reuse dead-process-check.js's own' values. In reality they have diverged: dead-process-check.js uses 1680 (sized to review's 1440s worst-case chain plus slack), while uptime-log.js still holds the old 1200. This means uptime-log.js classifies a worker as 'stale' 480 seconds earlier than the daemon that actually restarts it, producing false-positive 'down' samples in the uptime log for any worker legitimately in a long multi-pass task. The constants are also re-exported via module.exports, so external consumers may depend on them.

Solution:
Remove the two local const declarations (STALE_HEARTBEAT_SECONDS = 300 and WORKER_ZOMBIE_THRESHOLD_SECONDS = 1200). Add const { STALE_HEARTBEAT_SECONDS, WORKER_ZOMBIE_THRESHOLD_SECONDS } = require('./heartbeat-thresholds.js'); near the top of the file (after the existing require lines). Update the header comment block: replace the sentence claiming the values 'reuse dead-process-check.js's own' constants with a note that the values are imported from ./heartbeat-thresholds.js (the single source of truth). Keep the constants in module.exports (re-export the imported bindings) so any external consumer of require('./uptime-log.js').STALE_HEARTBEAT_SECONDS continues to work. Do not change the stale-computation logic (the > vs >= difference is a separate concern and out of scope here), do not change appendSample, pruneOldSamples, readSamplesInWindow, isProcessAlive, logPath, or the CLI block.

Benefits:
uptime-log.js now classifies staleness using the same 1680s zombie threshold the daemon uses, eliminating the false-positive 'down' samples for long multi-pass tasks. The 'shared semantics' comment is now factually true. The 1200 value is gone from the codebase; any future tuning change is a one-line edit in heartbeat-thresholds.js.

### AC-81 · Add cross-file threshold-consistency test
Strength: Strong
Split-Depth: 1
Files: test/heartbeat-thresholds.test.js
Depends-On: AC-80

Problem:
After the three changes above, both modules import from the same shared module, but nothing in the test suite verifies that they actually agree. A future refactor could re-introduce a local const in one file, or a new consumer could hard-code a value, and the divergence would go undetected until the next live SIGKILL-loop incident.

Solution:
Create a test file (location: follow the project's existing test convention; if none exists, test/heartbeat-thresholds.test.js) that: (1) requires STALE_HEARTBEAT_SECONDS and WORKER_ZOMBIE_THRESHOLD_SECONDS from src/heartbeat-thresholds.js; (2) requires the same two names from src/uptime-log.js's module.exports and from src/dead-process-check.js (if it exports them) or verifies via a small helper that the values used in its decision path match the shared constants; (3) asserts that all three sources return identical numeric values for both constants. The test must NOT hard-code 300 or 1680 — it should compare the imported values against each other so that a future tuning change is automatically reflected. If dead-process-check.js does not export its constants, the test can instead import the shared module and assert that uptime-log.js's exported constants equal the shared module's, which transitively proves agreement since dead-process-check.js imports from the same module.

Benefits:
Catches any future re-introduction of a local constant or value drift between the two files. The test is self-maintaining: it compares values to each other rather than to hard-coded numbers, so a legitimate tuning change (e.g., 1680 → 2400) does not require updating the test.

### AC-82 · Duplicated build-merge-persist sequence in graph_build.py
Strength: Strong
Files: python/graph_build.py

Problem:
Both `check_due()` and the default (non-`--target-dir`) branch of `main()` execute the same five-step pipeline: read the old graph, coverage, and file_cache from disk; call `build_graph_data`; call `merge_coverage` to fold in prior review state; write the three JSON artefacts (graph, coverage, file_cache) with `mkdir(parents=True, exist_ok=True)` guards; and compute/report the carried-forward community count. The only differences between the two call sites are the `progress` sink (a callable in `check_due`, `print` in `main`), the source of `use_model_naming` (hard-coded `True` vs. `not args.no_model_naming`), and whether the schedule file is written afterwards. Because the sequence is copy-pasted rather than shared, any change to the persistence contract—adding atomic writes, changing the JSON schema, emitting an additional output file, or fixing a path-handling bug—must be made in two places with a real risk of divergence.

Solution:
Extract a single helper, e.g. `_run_build_and_persist(cfg, *, use_model_naming, progress=None)`, that encapsulates the read-old-state → `build_graph_data` → `merge_coverage` → write-three-JSON-files → return `(result, merged_coverage, file_cache, carried_count)` sequence. Both `check_due` and the default branch of `main` call this helper, passing their respective `use_model_naming` value and `progress` sink. The schedule-file write in `check_due` and the human-readable summary lines in `main` remain at their call sites, since they are presentation/scheduling concerns rather than persistence logic.

Benefits:
A single code path owns the build-and-persist contract, so schema changes, atomicity improvements, or new output artefacts are made once. The two call sites become thin wrappers that only differ in their `use_model_naming` source and post-persist side-effects, making the diff surface for future changes smaller and eliminating the class of "I fixed it in `check_due` but forgot `main`" regressions.

### AC-85 · Remove dead `require('../task-sources.js')` from prompt-assembly.js
Strength: Strong
Split-Depth: 1
Files: src/lib/prompt-assembly.js

Problem:
The file contains a bare, unassigned side-effect require: `require('../task-sources.js');` sitting between the header comment and the `assemblePrompt` function. No symbol from `task-sources.js` is destructured, assigned, or referenced anywhere in this file — the sole exported function `assemblePrompt` only uses its two parameters and the spread/join operators. The require is redundant because `src/prompts.js`, which is the module that actually consumes `assemblePrompt`, already loads `./task-sources.js` directly (its own `require('./task-sources.js')` line). Leaving the dead require in place adds a needless edge to the module graph and a small circular-require risk for no functional benefit.

Solution:
Delete the single line `require('../task-sources.js');` (and the one blank line immediately preceding it, to avoid leaving a double blank between the header comment and the function). No other line in the file is touched. The file's `'use strict'` directive, header comment, `assemblePrompt` function body, and `module.exports` remain byte-identical.

Benefits:
Removes a redundant module-load edge from the dependency graph, eliminates a potential circular-require path, and makes the file's actual dependencies (none beyond built-ins) explicit. Zero behavioural change: `assemblePrompt` is a pure function of its two array arguments and never touches any `task-sources.js` symbol.

### AC-86 · Remove dead `require('../task-sources.js')` from prompt-blocks.js
Strength: Strong
Split-Depth: 1
Files: src/lib/prompt-blocks.js

Problem:
The file contains a bare, unassigned side-effect require: `require('../task-sources.js');` sitting between the header comment and the first function (`statedAcceptanceBlock`). None of the five exported functions (`statedAcceptanceBlock`, `fixedLiteralsBlock`, `priorRejectionBlock`, `priorVerdictBlock`, `strictCiteConstraintBlock`) reference any symbol originating from `task-sources.js`; they operate purely on their `task` argument and local constants like `PRIOR_VERDICT_MAX_CHARS`. The require is redundant because `src/prompts.js`, the module that destructures and calls all five of these functions, already loads `./task-sources.js` directly. The dead require adds a needless module-graph edge and a small circular-require risk without providing any value to this file.

Solution:
Delete the single line `require('../task-sources.js');` (and the one blank line immediately preceding it, to avoid leaving a double blank between the header comment and the first function). No other line in the file is touched. The `'use strict'` directive, header comment, all five function bodies, the `PRIOR_VERDICT_MAX_CHARS` constant, and the `module.exports` statement remain byte-identical.

Benefits:
Removes a redundant module-load edge from the dependency graph, eliminates a potential circular-require path, and makes the file's actual dependencies (none beyond built-ins) explicit. Zero behavioural change: all five block functions are pure functions of their `task` argument and never touch any `task-sources.js` symbol.

### AC-87 · Two unrelated registries co-reside in one module with side-effect registration
Strength: Strong
Files: src/deterministic-recheck-registry.js, src/staleness-fastpath.js

Problem:
`src/deterministic-recheck-registry.js` is named and header-commented as a deterministic staleness-recheck rules registry, yet it also houses a pre-dispatch gate registry that serves a different pipeline stage. The two registries differ in key type (rule-ID string vs. source-name string), value shape (single detector function vs. a config object with nested per-file/repo-wide rule maps), and population strategy (module-load side-effect registration vs. external plugin calls). The sharpest consequence is that requiring the module for the recheck registry—as `staleness-fastpath.js` does—silently registers four pre-dispatch gates as a side effect. A test that calls `clearDeterministicRecheckRegistry()` to obtain a clean slate for recheck rules gets no equivalent clearing for the gate registry, so the auto-registered gates persist invisibly across test runs. A developer adding a new pre-dispatch gate must edit a file whose name and primary purpose describe a different concern, and a developer searching for gate registration has to know it lives inside the "recheck-registry" file.

Solution:
Extract the pre-dispatch gate registry—including its two built-in detectors and their registration calls—into its own module (e.g. `pre-dispatch-gate-registry.js`). The recheck registry file becomes a pure passive registry with no side effects on require. Each registry gets its own test file that can clear and inspect its own state without the other's interference, and `staleness-fastpath.js` imports from the two modules independently.

Benefits:
Requiring the recheck registry no longer has hidden side effects, eliminating a class of test-pollution bugs. Each registry is discoverable by its own name, so a developer searching for "where are gates registered?" finds the answer in a file whose name matches the concern. Test isolation becomes straightforward: clearing one registry cannot accidentally leave the other in a stale state. Future contributors can extend either registry without reading or understanding the other's key semantics, value shapes, or population strategy.

### AC-88 · Recheck registry accepts non-function detectors, deferring a context-poor TypeError to call time
Strength: Strong
Files: src/deterministic-recheck-registry.js, src/staleness-fastpath.js

Problem:
`registerPreDispatchGate` in the same file checks `typeof detector !== 'function'` and throws a clear `TypeError` at registration, naming the offending value. `registerDeterministicRecheck` performs no equivalent check on the values inside `perFileRules` or `repoWideRules`. A misconfiguration such as `{ perFileRules: { 'silent-catch-block': 'some-string' } }`—a typo, a wrong import, a config-deserialization bug—registers successfully. The failure surfaces later, inside `staleness-fastpath.js`'s `deterministicRecheck()`, where `detector(text, originalFile)` throws `TypeError: detector is not a function`—an error message that names neither the rule key, the source, nor the registration site, and that occurs deep in a file-read-plus-call sequence that is harder to debug than a registration-time throw.

Solution:
In `registerDeterministicRecheck`, iterate the keys of `perFileRules` and `repoWideRules` and assert each value is a function, throwing a `TypeError` that names the source, the rule key, and the expected type—mirroring the gate registry's existing validation pattern already present in the same file.

Benefits:
A misconfiguration is caught immediately at registration with a self-describing error that identifies the source, the rule key, and the expected type, rather than surfacing minutes later as an opaque "not a function" throw buried in a call stack. This converts a deferred, context-poor runtime error into an immediate, actionable registration error, reducing debugging time and preventing a single bad rule from silently corrupting every subsequent recheck pass.

### AC-89 · Duplicated build-merge-persist pipeline in graph_build.py
Strength: Strong
Files: python/graph_build.py

Problem:
Both `check_due()` and the default (non-`--target-dir`) branch of `main()` in `graph_build.py` execute the same five-step pipeline: read the old graph, coverage, and file_cache from disk; call `build_graph_data`; call `merge_coverage` to fold in prior review state; write the three JSON artefacts (graph, coverage, file_cache) with `mkdir(parents=True, exist_ok=True)` guards; and compute/report the carried-forward community count. The only differences between the two call sites are the `progress` sink (a callable in `check_due`, `print` in `main`), the source of `use_model_naming` (hard-coded `True` vs. `not args.no_model_naming`), and whether the schedule file is written afterwards. Because this sequence is copy-pasted rather than shared, any change to the persistence contract—adding atomic writes, changing the JSON schema, emitting an additional output file, or fixing a path-handling bug—must be made in two places with a real risk of divergence.

Solution:
Extract a single helper, e.g. `_run_build_and_persist(cfg, *, use_model_naming, progress=None)`, that encapsulates the read-old-state → `build_graph_data` → `merge_coverage` → write-three-JSON-files → return `(result, merged_coverage, file_cache, carried_count)` sequence. Both `check_due` and the default branch of `main` call this helper, passing their respective `use_model_naming` value and `progress` sink. The schedule-file write in `check_due` and the human-readable summary lines in `main` remain at their call sites, since they are presentation/scheduling concerns rather than persistence logic.

Benefits:
A single code path owns the build-and-persist contract, so schema changes, atomicity improvements, or new output artefacts are made once. The two call sites become thin wrappers that only differ in their `use_model_naming` source and post-persist side-effects, making the diff surface for future changes smaller and eliminating the class of "I fixed it in `check_due` but forgot `main`" regressions.

### AC-90 · Extract shared source-file detection regex into a single module
Strength: Strong
Files: src/review-inert.js, src/review-skip-paths.js

Problem:
Both `src/review-inert.js` and `src/review-skip-paths.js` independently define a local `SOURCE_RE` regular expression (currently `/\.js|\.mjs|\.cjs|\.py$/`) to decide which files count as source code. Because the pattern is copy-pasted rather than imported from a shared location, any future change—adding TypeScript (`.ts`/`.tsx`), supporting `.rb` or `.go`, or tightening the anchor—must be made in two places. A developer who updates one file and overlooks the other will cause the two review detectors to silently classify different sets of files as "source," producing inconsistent review output that is difficult to diagnose because neither file logs a mismatch.

Solution:
Create a small shared module (e.g. `src/source-file-pattern.js`) that exports the canonical `SOURCE_RE` (and, if useful, a `isSourceFile(path)` helper). Replace the local regex definitions in `src/review-inert.js` and `src/review-skip-paths.js` with an import from that module. Add a unit test that asserts both consumers resolve to the same pattern, so any accidental re-introduction of a local copy is caught at CI time.

Benefits:
A single source of truth for "what counts as source code" eliminates the class of silent-divergence bugs entirely. Adding a new language or adjusting extension rules becomes a one-line change in one file. The shared test gives immediate feedback if a future refactor accidentally re-introduces a second copy, and the codebase becomes easier to audit because the definition lives in one discoverable location rather than being scattered across detectors.

### AC-91 · Inconsistent slice boundary semantics between drift-scan and drift-fix
Strength: Worth exploring
Files: src/drift-scan.js, src/drift-fix.js

Problem:
Both `drift-scan.js` and `drift-fix.js` independently locate the static block using the same `staticStartMarker` and `staticEndMarker`, but they apply different slicing conventions. `drift-scan.js` uses `sliceBetween`, which includes the end marker in the extracted slice (`text.slice(startIdx, endIdx + endMarker.length)`), while `drift-fix.js` uses inline logic that excludes it (`text.slice(startIdx, endIdx)`). Today this is benign because the end marker is a Markdown heading that is not a data row, but the two modules disagree on what "the block" means. If a future pair definition uses an end marker that is itself part of the data (a closing delimiter, a sentinel row, etc.), the scanner would count that value as present in the static file while the fixer would not see the corresponding row to delete, producing a silent mismatch between scan and fix.

Solution:
Extract a single `locateBlock(text, startMarker, endMarker)` helper in `drift-scan.js` that returns the slice under one documented boundary convention (e.g., always inclusive of the end marker) and export it. `drift-fix.js` imports and calls this helper instead of re-implementing its own `indexOf`/`slice` pair. A unit test in the existing `node:test` suite asserts that both modules, given the same input text and markers, produce an identical set of rows, locking in the shared convention.

Benefits:
The two modules can no longer drift apart on what constitutes the block boundary, eliminating an entire class of latent scan/fix mismatches. Adding a new pair definition with a data-bearing end marker becomes safe without requiring the author to remember which module's slicing convention to match. The shared helper also gives a single place to document the boundary contract, reducing cognitive load for future contributors.

### AC-92 · Test mutation of shared module state in drift-fix tests
Strength: Worth exploring
Files: src/drift-fix.test.js, src/drift-scan.js, src/drift-fix.js

Problem:
The tests in `drift-fix.test.js` inject fake pair definitions by directly mutating the `driftScan.PAIRS` array (setting `.length = 0` then `.push(...)`). This works only because `drift-fix.js` reads `PAIRS` at call time and the array is a plain mutable export. The tests are therefore coupled to an implementation detail of `drift-scan.js`—that `PAIRS` is a live, writable array—rather than to the interface `drift-fix.js` actually consumes. Any refactor of `drift-scan.js` (freezing the array, switching to a getter, moving pair definitions into a closure) would silently break the tests with no change to `drift-fix.js`'s public API, and the tests would fail for reasons unrelated to the code under test.

Solution:
Refactor `buildFixEvidence` in `drift-fix.js` to accept the pair definition as an explicit parameter (e.g., `buildFixEvidence(repoRoot, flag, pair)`), or introduce a lightweight dependency-injection seam (a `setPairsForTest` function or a constructor option). The tests in `drift-fix.test.js` then pass the fake pair directly to the function under test and no longer touch `driftScan.PAIRS`. The existing `node:test` test structure is preserved; only the setup/teardown lines that mutate the shared array are replaced with a local variable passed into the call.

Benefits:
`drift-fix.test.js` becomes independent of `drift-scan.js`'s internal state, so refactors to `drift-scan.js` (freezing, getters, restructured exports) no longer risk breaking unrelated tests. The dependency between the two modules is made explicit in the function signature rather than hidden in a shared mutable export, improving readability and making it straightforward to add or remove pairs in tests without global side effects.

NOTE: Flag 2 was not applied because the draft's description that "only the setup/teardown lines... are replaced with a local variable passed into the call" is an accurate summary of the necessary changes; updating the call sites to pass the new parameter is the direct consequence of the proposed refactoring, not a contradiction of the preserved test structure.

### AC-93 · Extract shared "valid enabled entry" predicate
Strength: Worth exploring
Files: src/plugins-manifest.js, src/resolve-plugin-root.js

Problem:
The predicate that defines a loadable, enabled plugin manifest entry — a truthy object with a non-blank string `registerPath` and `enabled !== false` — is written independently in two files. In `plugins-manifest.js`, `enabledRegisterPaths` filters with `p && typeof p.registerPath === 'string' && p.registerPath.trim() && p.enabled !== false`. In `resolve-plugin-root.js`, `resolvePluginRoot` re-states the same four conditions inline when looking up a plugin by name. The shared kernel is the contract for what a valid manifest entry looks like, yet it lives in two places. If the entry schema evolves — a new required field, a tri-state `enabled`, a path-normalisation rule — both sites must be updated in lockstep, and a missed update in one file produces a silent divergence in which one code path accepts an entry the other rejects.

Solution:
Extract the four-condition check into a small named predicate (e.g. `isValidEnabledEntry(p)`) exported from `plugins-manifest.js`. `resolvePluginRoot` then composes it with its existing `p.name === pluginName` check instead of re-listing the conditions. The predicate becomes the single source of truth for the entry contract; any future schema change is a one-file edit.

Benefits:
"Change the entry contract" goes from "edit two files and hope they stay in sync" to "edit one file." The intent of the check is named at the call site, making the manifest-entry contract visible to readers of `resolve-plugin-root.js` without them having to mentally diff two inline boolean expressions. The existing tests already cover the back-compat fallback path, so the refactor is low-risk and immediately verified.

### AC-97 · DOM-integration functions depend on invisible globals, making them untestable in isolation
Strength: Worth exploring
Files: python/dashboard/static/js/branches-joblist-hardware-tabs.js

Problem:
`renderBranchListInto` and `wireBranchVerdictFilterBar` reference four identifiers—`branchCardHtml`, `wireBranchCard`, `currentBranches`, `currentHeldHubs`—that are neither imported, declared, nor passed as parameters. They are expected to exist as globals provided by `branches-joblist-hardware-tabs.js` at call time. The comment in the code acknowledges this is deliberate (keeping the hot file lean), and the `module.exports` line correctly omits the two DOM functions, confirming they are browser-only. The concrete friction: the test file can only exercise the pure helpers. The two functions that actually wire the UI together are structurally untestable in isolation because their contract depends on four names that live in another file's global scope. A rename or removal in the hot file produces a `ReferenceError` at runtime with no import-graph signal, no lint warning, and no test failure. The dependency is real but invisible to any tooling that follows the module boundary.

Solution:
Add the four dependencies as explicit parameters (or a single context object) to the signatures of `renderBranchListInto` and `wireBranchVerdictFilterBar`. In production, `branches-joblist-hardware-tabs.js` passes its own values at the call site, exactly as it would have read them from the global scope before. In the test file, the test author calls the same two functions directly, supplying stub or mock values for each of the four parameters—no global setup, no dependency on the hot file being loaded. Because the parameters are part of the function's public signature, the test file is the entity that controls what those four names resolve to, and it can do so independently of any other module.

Benefits:
The test suite can cover the DOM-integration path, catching regressions in the wiring logic. A rename or removal of any of the four globals in the hot file becomes a test-time error (the test's mock no longer matches the expected shape, or the hot file's call site fails to compile/lint) rather than a silent runtime `ReferenceError`. The module's public surface (the exported pure functions) and its actual runtime dependencies (the four globals) align, removing the one place where they currently diverge.

### AC-98 · Hard-coded concept IDs in the generic card renderer
Strength: Strong
Files: python/dashboard/static/js/concepts-and-adhoc-tab.js

Problem:
The `renderConceptCard` function embeds two hard-coded string literals (`'concept-ghost-in-the-machine-0dbeea'` and `'concept-adhoc-task-lifecycle-64935e'`) to conditionally inject specialized UI panels (ghost telemetry and a static lifecycle flowchart) into specific concept cards. This tightly couples the generic rendering path to particular database records and violates locality: any new concept that requires a specialized panel forces a modification to this core function, and if the underlying concept is renamed or its ID changes in the database, the UI panel silently disappears with no error or warning. The rendering logic is no longer data-driven; it is a lookup table of specific IDs hidden inside a function that is supposed to be generic.

Solution:
Extract the hard-coded IDs and their associated HTML-generation code into a separate configuration object (or a dedicated "specialized panels" module) that maps concept IDs to a panel-rendering function. `renderConceptCard` then simply looks up the concept ID in that configuration and, if a match exists, invokes the corresponding panel renderer and appends the result. Adding a new specialized view becomes a matter of adding one entry to the configuration (or one new module file) without touching the core rendering logic at all.

Benefits:
The generic card renderer becomes truly generic and testable in isolation. New specialized panels can be added or removed without modifying shared code, eliminating the risk of a silent UI regression when a concept ID changes. The configuration object serves as a single, auditable registry of which concepts receive custom treatment, making the coupling explicit and discoverable rather than buried in conditional branches.

### AC-99 · Implicit global-function dependencies break isolated testing
Strength: Strong
Files: python/dashboard/static/js/concepts-and-adhoc-tab.js, python/dashboard/static/js/concepts-and-adhoc-tab.test.js

Problem:
`renderConceptCard` calls `escapeHtml`, `escapeAttr`, and `renderReportMarkdown`, which are defined in other files (`core-ui.js`, `analytics-and-discovery.js`) and injected into the browser's global scope. Because these utilities are neither imported nor exported through the module system, the test file must manually stub them onto the `global` object before requiring the module under test. This creates a fragile dependency chain: the test relies on the exact names and signatures of functions defined in unrelated files, the module cannot be exercised in isolation, and any rename or signature change in the source file silently breaks the test with no compile-time or import-time signal.

Solution:
Refactor `concepts-and-adhoc-tab.js` to accept the required utilities (`escapeHtml`, `escapeAttr`, `renderReportMarkdown`) via dependency injection (e.g., a factory function or an initialization method that accepts a context object containing these functions). In the browser, the global instances are passed in during initialization. In the test file, the module can be initialized with mock functions directly, removing the need to pollute the global object. This preserves the browser's global scope architecture while making the module's dependencies explicit and testable in isolation.

Benefits:
The module's dependencies are explicit and self-documenting; a reader sees exactly which external functions it relies on. Tests become deterministic and isolated—mocking injected functions is straightforward, and no global-state cleanup is needed. Renaming or removing a utility in the source file will surface as a clear error during initialization or test setup rather than a silent `undefined is not a function` at runtime, catching integration drift at test time rather than in the browser.

NOTE: The flag regarding AC-002 was applied; the solution was corrected to use dependency injection instead of CommonJS `require` to respect the browser global scope constraint.

### AC-100 · Merge conflates "ours never had this slot" with "ours deleted this slot"
Strength: Strong
Files: src/candidates-doc-merge.js

Problem:
In the theirs-walk branch of `mergeCandidatesDoc`, the guard `!ours.blocks.has(id)` is intended to mean "ours never touched this slot, so apply theirs' version." However, that same condition is true when ours *deleted* a block that the ancestor contained. In that case the code unconditionally sets `finalBlocks.set(id, theirsBlock)`, resurrecting a block that ours intentionally removed. The dedicated DELETIONS pass at the bottom of the function only fires when `theirs.blocks.has(id)` is false (i.e., theirs deleted it), which is the opposite scenario. The result is that the merge is not a true three-way merge for the "ours deleted + theirs edited/added the same slot" case: it silently violates the function's own stated intent of honoring ours' deletions and never silently dropping content someone changed. The defect is currently latent because the test suite has no case where ours deletes a slot that theirs also modifies, and the live nine-branch collision scenario is a same-slot edit, not a delete-vs-edit.

Solution:
Distinguish "ours never had this slot" from "ours deleted this slot" by consulting the ancestor map. In the theirs-walk branch, split the `!ours.blocks.has(id)` path into two sub-cases:

1. **Clean-apply (theirs added a genuinely new slot):** `!ours.blocks.has(id) && !ancestor.blocks.has(id)`. Neither ours nor the ancestor had this id, so theirs introduced it. Apply theirs' block as before.

2. **Delete-vs-edit conflict:** `!ours.blocks.has(id) && ancestor.blocks.has(id)`. The ancestor had the slot, ours removed it, and theirs still has it (either edited or retained). This is a true three-way conflict: both sides changed the slot in incompatible ways (ours deleted, theirs kept/edited). The correct resolution, consistent with the function's contract of degrading to git's conflict-marker behavior on ambiguity, is to **emit a conflict marker** for this id in the output. Specifically:
   - Do **not** silently insert theirs' block (that resurrects a deletion).
   - Do **not** silently skip the slot (that discards theirs' edit, violating the "never silently drop content someone changed" invariant).
   - Instead, write a `<<<<<<< ours` / `=======` / `>>>>>>> theirs` block (or the equivalent structural conflict marker the function already uses for same-slot edit conflicts) that shows ours' side as empty (deleted) and theirs' side as their current content, so a human can decide.
   - Log a warning to stderr naming the conflicting id.

3. **Both-deleted (no conflict):** `!ours.blocks.has(id) && ancestor.blocks.has(id) && !theirs.blocks.has(id)`. Both sides removed the slot. Leave it out of `finalBlocks` with no marker. (This case is already handled by the existing DELETIONS pass, but make the interaction explicit.)

Add two test cases:
- **Delete-vs-edit:** Ancestor contains `### AC-3` with content X. Ours removes `### AC-3` entirely. Theirs edits `### AC-3` to content Y. Assert the merged output contains a conflict marker for AC-3 (not a clean application of Y, not a silent absence).
- **Both-deleted:** Ancestor contains `### AC-3`. Both ours and theirs remove it. Assert AC-3 is absent from the output and no conflict marker is emitted.

Benefits:
The merge becomes a correct three-way reconciliation for the delete-vs-edit case. The function's stated invariant ("a block ours edited is kept; never silently drop content someone changed") is now symmetric: deletions are honored *without* silently discarding the other side's edits. The conflict-marker path is the same degradation mechanism the function already uses for same-slot edit conflicts, so the behavior is consistent and predictable. Future contributors can rely on the merge to surface delete-vs-edit conflicts for human resolution rather than silently choosing one side.

---

*AC-002 removed.*

NOTE: AC-002 was removed because the critique correctly identifies that (a) the draft's description of the failure mode is factually wrong — the actual behavior is last-wins in the Map with the `order` array carrying the duplicate, not "the merge sees the slot as untouched" — and (b) the prescribed fix (throw on duplicate id) would be a behavioral regression for the live nine-branch collision scenario where the structural merge must reconcile independently-written same-id content rather than refuse to resolve.

### AC-101 · Inconsistent error-handling contract in `readEntries`
Strength: Strong
Files: (no verified file paths in plan)

Problem:
`readEntries` treats file I/O failures asymmetrically: it silently swallows `ENOENT` by returning an empty array, but re-throws every other `readFileSync` error such as `EACCES` or `EIO`. Because `computeBudgetHealthy` iterates over a dynamically generated list of 500+ transcript files and concatenates their results, a single transient disk I/O error or a temporary permission change on any one file will propagate an unhandled exception out of the entire budget health check. The system cannot fall back to cached data or report a partial state; it simply crashes.

Solution:
Standardize the error-handling contract so that all `readFileSync` failures are treated as non-fatal. For any error (not just `ENOENT`), the function should log the specific error code and message (as it already does for non-ENOENT cases) and then return an empty array for that file. This lets `computeBudgetHealthy` continue iterating over the remaining files, producing a best-effort health report from whatever data is actually readable rather than failing the entire check.

Benefits:
A single bad file can no longer take down the whole budget health gate. Operators get a logged, diagnosable error for the specific file that failed while the rest of the 500+ files still contribute to the health calculation. The module's stated goal of being a lightweight, low-overhead gate is preserved because the failure mode is now graceful degradation instead of a hard crash, and downstream consumers receive a (possibly partial) result they can act on rather than an exception they must catch.

### AC-102 · O(N²) complexity in `estimateBudgetCeiling`
Strength: Strong
Files: (no verified file paths in plan)

Problem:
`estimateBudgetCeiling` iterates over every rate-limit event and, for each one, performs a linear scan of the entire `allEntries` array to sum tokens within the preceding 5-hour window. With a high volume of rate-limit hits (e.g., 100) and a large dataset (e.g., 100,000 entries), this produces roughly 10 million inner-loop iterations per call. The resulting CPU spike and latency directly contradict the module's design goal of being a lightweight, low-overhead gate that runs frequently without noticeable cost.

Solution:
Refactor to a two-pointer sliding-window approach. Because `allEntries` is already sorted by timestamp when `computeBudgetHealthy` hands it off, a single left-to-right pass with two indices (one tracking the start of the 5-hour window, one tracking the current entry) can maintain a running token sum and emit the window total for each rate-limit event in O(N) total time. The nested loop is eliminated entirely, and no auxiliary data structure beyond the existing sorted array is needed.

Benefits:
The worst-case cost drops from O(N × M) to O(N + M) (where M is the number of rate-limit events), turning a 10-million-iteration workload into a single linear pass. CPU spikes during high-traffic periods disappear, the gate's latency becomes predictable and proportional to dataset size rather than the product of dataset size and event count, and the module can be called more frequently (or on larger datasets) without degrading the host process.

### AC-103 · `distinctivePhrases` hides a first-line-only contract in a comment rather than the interface
Strength: Worth exploring
Files: src/text-similarity.js

Problem:
`distinctivePhrases(text)` and `sharesDistinctivePhrase(a, b)` both internally truncate their argument to the first line via `String(text).split('\n')[0]`, yet the function signature accepts an arbitrary string and nothing in the name, parameter type, or JSDoc signals that everything after the first newline is silently discarded. Both current callers happen to pre-slice to their own first line before calling, so the internal truncation is redundant today—but that redundancy is the only thing protecting correctness. If a future caller passes a multi-line string (the in-file comment explicitly names a `blockedReason` from `agentic-draft-common.js` as a likely future input), the phrase set is computed from an incomplete string, producing a wrong similarity score that looks plausible rather than raising an error. The contract lives in a comment ("Revisit… if multi-line inputs become common") rather than in the API surface, so a new caller has no mechanical signal that the truncation exists.

Solution:
Remove the internal `split('\n')[0]` from both `distinctivePhrases` and `sharesDistinctivePhrase`, making the functions genuinely multi-line. Current callers already slice to their first line before calling, so this is a no-op for them. The JSDoc is updated to state that the function operates on the full string passed in, and any caller that wants first-line-only semantics performs its own slice at the call site (which they already do). This eliminates the hidden truncation and the redundant double-slice.

Benefits:
The API surface now matches its behavior: what you pass in is what gets processed. A future caller passing a multi-line string gets a correct, full-string similarity score instead of a silently truncated one. The "revisit" comment becomes unnecessary because the function no longer has a hidden first-line assumption. The redundancy of two independent `split('\n')[0]` calls (one in the caller, one in the callee) is removed, simplifying the mental model for anyone reading the call chain.

### AC-104 · `writeSideFindingInbox` uses raw `fs.writeFileSync` while a purpose-built atomic-write utility sits in the same community
Strength: Worth exploring
Files: src/side-finding.js, src/atomic-write.js

Problem:
`writeSideFindingInbox` in `side-finding.js` writes inbox JSON files with a direct `fs.writeFileSync` call. In the same directory, `atomic-write.js` exports `writeJsonAtomicSync(file, data)` and its header comment describes the exact failure mode it prevents: a crash mid-write producing a truncated, unparseable file. The side-finding inbox is a queue that `side-finding-sweep.js` drains; a truncated JSON file in that queue is a malformed record the sweep must detect and skip. The non-use is defensible—the side-finding write is a create-new-file pattern, so a truncated write loses one optional side-finding rather than corrupting shared state—but that justification is not stated anywhere in `side-finding.js`. A maintainer reading the community sees a purpose-built atomic-write utility and a sibling file that bypasses it, and must re-derive the risk-level difference to decide whether the omission is intentional.

Solution:
Switch the `fs.writeFileSync` call in `writeSideFindingInbox` to `writeJsonAtomicSync(path.join(dir, name), record)`. The change is one line, the call is already inside a try/catch, and the cost of the extra temp-file-and-rename is negligible for a low-frequency inbox write. This removes the question entirely: the community now uses its own atomic-write utility consistently, and no reader needs to infer why it was skipped.

Benefits:
A crash mid-write can no longer leave a truncated, unparseable JSON file in the inbox queue, eliminating a class of malformed records that the sweep must detect and skip. The community's use of its own utility is consistent, removing the cognitive overhead for a maintainer who sees `atomic-write.js` next to a file that doesn't use it. The justification no longer needs to be re-derived from first principles each time someone reads the code.

### AC-105 · Duplicated direct-to-main eligibility check within apply-main-batch.js
Strength: Strong
Files: src/lib/apply-main-batch.js

Problem:
Both `applyDirectToMainBatchOnBranch` and `mainPartition` (both defined in `apply-main-batch.js`) independently resolve the source name, fetch the registered source, and check for the `directToMain === true` flag to decide whether a task is eligible for batch processing. Because the two implementations live in separate functions within the same file with no shared helper, any change to the eligibility rule—renaming the flag, adding a second condition, or altering how the source is resolved—must be made in both places. A missed update in one function silently changes which tasks are accepted, producing a divergence bug that is hard to surface because each path still works in isolation.

Solution:
Extract the eligibility determination into a single shared function (e.g. `isDirectToMainTask(task, sources)`) that encapsulates the source-name resolution, source lookup, and flag check. Both `applyDirectToMainBatchOnBranch` and `mainPartition` call this one function, so the rule is defined in exactly one location and both paths stay in lockstep automatically.

Benefits:
A single source of truth for the "direct-to-main" rule eliminates the class of divergence bug where one path accepts a task the other rejects. Future changes to eligibility (new flags, compound conditions, source-type checks) require editing one function instead of hunting for every inline copy, reducing review surface and the chance of a subtle mismatch between the two apply paths.

### AC-106 · Inline git command sequence in apply-main-batch.js couples batch logic to git-runner.js
Strength: Worth exploring
Files: src/lib/apply-main-batch.js, src/git-runner.js

Problem:
`applyDirectToMainBatchOnBranch` issues a long, ordered sequence of `gitRunner` calls—`fetchMain`, `prepareStackedBranch`, `resetToMain`, `add`, `commit`, `push`, `checkoutMain`, `retryPushAfterRebase`, and others—directly inlined in the batch-application logic. There is no intermediate abstraction (a "branch-apply" or "stack-push" helper) that groups these steps. As a result, the batch-eligibility and staging logic is entangled with the exact git command ordering, making it difficult to unit-test the batch logic in isolation (every test must stub the full gitRunner surface) and making it brittle if the push workflow gains a step (e.g., a pre-push hook or a rebase-retry loop) that must be inserted between existing calls.

Solution:
Introduce a thin orchestration layer (e.g. `applyStackedBatchToMain(branch, files, gitRunner)`) that owns the ordered git sequence and exposes a single entry point. `applyDirectToMainBatchOnBranch` then focuses on eligibility, file staging, and error handling, delegating the mechanical git steps to the orchestrator. The orchestrator can be tested with a mock gitRunner that asserts the call sequence, and the batch logic can be tested with a stubbed orchestrator.

Benefits:
Separating the "what to apply" decision from the "how to apply it via git" mechanics improves testability (batch logic tests no longer need a full gitRunner mock), localizes git-sequence changes to one file, and makes the push/retry workflow easier to evolve without touching the eligibility and staging code.

### AC-107 · Task-file staging rules duplicated across apply paths
Strength: Strong
Files: src/lib/apply-main-batch.js

Problem:
`apply-main-batch.js` manually builds the staging list (`artifact.files || [artifact.file]`) and then calls `assertStageableFiles`, with special handling to exclude `task-logs/` (which is gitignored) from the set of files to stage. The comments in the file indicate that other apply paths perform the same construction and exclusion inline. Because the "what is stageable" rule (including the `task-logs` exclusion and the `files`-vs-`file` fallback) is repeated across multiple apply paths, a change to the staging contract—adding a new artifact type, changing the gitignore rule, or altering the fallback shape—must be replicated everywhere, and a missed copy produces the exact staging-failure bug the comments describe.

Solution:
Create a single `resolveStageableFiles(artifact)` helper that encapsulates the `files`/`file` fallback, the `task-logs/` exclusion, and any future artifact-type filtering, returning the final list to pass to `assertStageableFiles`. Every apply path (`apply-main-batch.js` and any others) calls this helper instead of reconstructing the list inline.

Benefits:
The staging contract lives in one place, so adding a new artifact type or adjusting the gitignore exclusion is a one-line change rather than a multi-file hunt. It eliminates the recurring class of "staged a gitignored path" failures by making the exclusion rule impossible to forget in a new apply path, and it simplifies each apply function by removing a block of inline list-manipulation code.

NOTE: Flag 3 was not applied because the critique's premise that "vague stylistic nitpicks do not count" is not part of the provided task constraints; the original draft's assessment of AC-002 as a "Worth exploring" architectural improvement is a valid code review observation, not a fabricated defect, and removing it would reduce the utility of the review.

### AC-108 · Blocking strategy to avoid O(N²) Jaccard comparisons in dedup
Strength: Strong
Files: src/staleness-audit-dedup.js

Problem:
`findDuplicateTask` in `staleness-audit-dedup.js` iterates over the entire corpus for every incoming task, computing a full Jaccard similarity score (token normalization, set intersection, set union) against each existing entry. For a corpus of size N this is O(N²) pairwise comparisons, and `normalizeTaskTokens` is re-invoked for the same tasks on every pass. As the task queue grows into the thousands, the quadratic cost dominates wall-clock time for what is otherwise a lightweight dedup check. There is no pre-filtering or indexing: tasks from entirely different sources or domains are still subjected to the full similarity computation, wasting cycles on pairs that could never be duplicates.

Solution:
Introduce a blocking (candidate-reduction) step before the Jaccard computation. Group tasks by a coarse key such as `source` or `domain` so that only tasks within the same group are compared. Within a group, apply a lightweight pre-filter—e.g., require at least one shared distinctive token (a token appearing in fewer than 5 % of the corpus) before computing the full Jaccard score. Optionally, maintain a small inverted index (token → task-id set) that is updated incrementally as tasks are added, so the candidate set for a new task is the union of posting lists for its tokens, capped at a small threshold. The existing Jaccard threshold and scoring logic remain unchanged; only the set of pairs fed into it is reduced.

Benefits:
The number of expensive Jaccard evaluations drops from O(N²) to roughly O(N · k) where k is the average candidate-pair count after blocking, typically a small constant. `normalizeTaskTokens` is computed once per task and cached rather than re-derived for every comparison. The dedup step scales linearly with queue growth instead of quadratically, removing a bottleneck that would become noticeable at a few thousand queued tasks.

### AC-109 · Silent guard disablement when nvidia-smi is unavailable
Strength: Worth exploring
Files: src/gpu-guard.js

Problem:
`readFreeVramMb` shells out to `nvidia-smi` via `execFileSync`. When the binary is absent from `PATH`—a common situation in minimal container images, non-standard driver installs, or CI runners—the function returns `null`, which causes `ensureGpuHeadroomCore` to set `checked: false` and skip all reclamation logic. The guard silently becomes a no-op with no warning surfaced to the operator, so a genuinely starved GPU goes unaddressed and the only trace is a missing `checked` flag that callers may never inspect.

Solution:
When `nvidia-smi` is not found or fails to execute, emit an explicit `stderr` warning (e.g. "gpu-headroom guard disabled: nvidia-smi not found in PATH") before returning `null`. Additionally, allow an injected `readFreeVram` implementation (the parameter already exists on the core function) so that environments with alternative GPU-query tools can supply their own reader without modifying the guard's internals. The default implementation should also attempt a secondary lookup (e.g. `/usr/bin/nvidia-smi`, `/usr/local/bin/nvidia-smi`) before giving up.

Benefits:
Operators immediately see in their logs that the guard is inert and why, turning a silent failure into an actionable diagnostic. The injected-reader seam makes the guard portable to AMD/ROCm or virtualized-GPU environments without forking the codebase, and the secondary-path lookup reduces false negatives on systems where `nvidia-smi` exists but sits outside the default `PATH`.

### AC-110 · Redundant per-branch git subprocesses and repeated JSON I/O in verdict enrichment
Strength: Strong
Files: python/dashboard/branch_verdicts.py

Problem:
The `enrich_branches_with_verdicts` function iterates over every branch and, for each one, calls `_git_out(run_git, ["rev-parse", f"origin/{branch}"], repo_root)` to obtain the head SHA, then immediately calls `run_deterministic_checks` which internally executes multiple additional git commands (e.g., `cherry`, `diff`, `merge-tree`). When a deterministic verdict is written or cleared, it also calls `save_verdicts` and `load_verdicts`, which read and write the entire `branch-verdicts.json` file to disk. This results in O(N) git subprocess spawns and O(N) full-file JSON read/write cycles for a list of N branches, creating a significant performance bottleneck and unnecessary I/O churn for what is a read-heavy dashboard operation.

Solution:
Refactor the function to batch the git operations where possible (e.g., using `git for-each-ref` to retrieve all head SHAs in a single call) and batch the verdict persistence. Instead of saving and reloading the JSON file for every single branch, the function should accumulate all verdict changes in memory and perform a single `save_verdicts` call at the end of the loop. This reduces the number of git subprocesses and disk I/O operations from O(N) to O(1) for the persistence layer.

Benefits:
Reducing per-branch subprocess spawning and full-file JSON I/O to a single batched operation dramatically cuts wall-clock time for dashboard loads that touch many branches, eliminates unnecessary disk churn that can contend with other processes, and simplifies the persistence path by making it a single atomic write rather than N interleaved read-modify-write cycles.

### AC-111 · Lazy require couples SDK helper to monolith implementation detail
Strength: Worth exploring
Files: src/sdk/candidate-fulfillment.js, src/task-sources.js

Problem:
`candidate-fulfillment.js` performs a lazy `require()` of `task-sources.js` inside `nextCandidateFulfillmentTask` to obtain `taskIdExistsInQueue`, explicitly to avoid a load-time dependency on what the code calls a "monolith." This hides a real runtime dependency behind a function boundary: the module graph no longer reflects the true coupling, and if `task-sources.js` renames or restructures that export, the failure surfaces only at call-time in production rather than at import-time in CI or local development. It also makes `candidate-fulfillment.js` harder to unit-test in isolation or reuse in a context where `task-sources.js` is unavailable, since the dependency is not visible at the module boundary.

Solution:
Extract `taskIdExistsInQueue` (or a minimal `TaskIdLookup` interface) into a small, dependency-free module. `task-sources.js` can re-export it for backward compatibility, and `candidate-fulfillment.js` can import it statically at load time. If the circular-dependency concern is the root cause, break the cycle by having the consumer inject the lookup function (dependency injection) rather than reaching into the monolith at call time.

Benefits:
The dependency graph becomes honest and visible to tooling (tree-shaking, circular-dep linters, bundle analysis). `candidate-fulfillment.js` can be tested in isolation by passing a stub lookup, and it can be consumed in SDK contexts where the full task-sources monolith is not present. Runtime "module not found" or "undefined is not a function" errors from a renamed export are replaced by load-time failures that are caught in CI.

### AC-112 · Hardcoded source-name branches violate the registry's own extension contract
Strength: Strong
Files: src/task-source-registry.js

Problem:
`resolveSourceName` in `task-source-registry.js` contains explicit `if` branches for `adhoc` and `secondbrain` alongside a `sourceAliases` map that is populated via `registerSourceAlias()`. The surrounding comment states that a plugin should declare its own naming quirk through `registerSourceAlias()` "instead of this file needing to know every consumer's naming," yet the file still hardcodes two of those very cases. This is an Open/Closed Principle violation: the registry is open for extension (new aliases can be registered) but not closed for modification (adding a new special-case source requires editing `resolveSourceName`). It also creates an inconsistency where `adhoc` and `secondbrain` are treated differently from every other source, making the resolution logic harder to reason about and test uniformly.

Solution:
The existing `registerSourceAlias(sourceValue, name)` maps a single `task.source` string to a registry name, but the `adhoc` branch is a compound condition (`task.domain === 'adhoc' || task.source === 'manual'`) and the `secondbrain` branch is keyed on `task.domain` rather than `task.source`. Neither can be expressed through the current alias signature. The fix is to generalize the registration mechanism: introduce `registerSourceResolver(name, predicate)` where `predicate` receives the full task object and returns a boolean. The existing `registerSourceAlias(sourceValue, name)` becomes a thin convenience wrapper that calls `registerSourceResolver(name, (task) => task.source === sourceValue)`. At module-initialization time (or in a dedicated setup module), register:

- `registerSourceResolver('adhoc', (task) => task.domain === 'adhoc' || task.source === 'manual')`
- `registerSourceResolver('secondbrain', (task) => task.domain === 'secondbrain')`

`resolveSourceName` then becomes a linear scan of the registered resolvers (first match wins) with a single fallback, containing no source-specific logic. The scan is over a small, bounded list (a handful of built-ins plus any plugins), so the cost is negligible.

Benefits:
The registry's resolution path is uniform: every source, built-in or plugin, goes through the same data-driven predicate lookup. Adding a new special-case source no longer requires modifying `task-source-registry.js`; it is a one-line `registerSourceResolver` call in the source's own module. Testing `resolveSourceName` no longer requires special-casing `adhoc` and `secondbrain`—they are just registered predicates like any other, and the function can be tested with arbitrary resolver tables. The existing `registerSourceAlias` API remains available for the simple `task.source`-only case, preserving backward compatibility for any current callers.

### AC-113 · Inconsistent error-handling contract across git-ref helpers in stacked-grounding.js
Strength: Strong
Files: src/stacked-grounding.js

Problem:
Within the same module, `grepAtRef` treats `git grep` exit code 1 (no matches) as a normal empty result and lets genuine errors propagate as thrown exceptions, while `readFileAtRef` and `resolveAtRef` catch every error indiscriminately and return `null`. This means a caller cannot tell whether a `null` from `readFileAtRef` means "the path legitimately does not exist at this ref" or "the ref itself is invalid / the git command failed for an unrelated reason." The mixed contract forces every consumer to either ignore real failures silently or add redundant pre-checks (e.g., verifying the ref exists before calling the function), duplicating logic that the module should own.

Solution:
Standardize all three functions to a single contract: distinguish "not found / no matches" (return a sentinel such as `null` or an empty string) from "operational failure" (throw a typed error). Concretely, `readFileAtRef` and `resolveAtRef` should inspect the underlying error (e.g., `git show` exit code 128 with a "bad revision" message vs. a genuine I/O failure) and only return `null` for the expected not-found case, rethrowing or wrapping everything else. A small shared helper in the module can encapsulate the exit-code classification so the three call sites stay consistent.

Benefits:
Callers gain a reliable signal: a thrown error means "something is wrong, investigate," while a `null`/empty return means "expected absence." This eliminates the need for redundant ref-existence pre-checks at every call site, makes debugging git-related failures straightforward (the real error surfaces instead of being masked as `null`), and removes the cognitive overhead of remembering which of the three functions uses which convention.

### AC-114 · Latent crash when a registered source lacks a valid apply method
Strength: Strong
Files: src/lib/apply-core.js, src/task-source-registry.js

Problem:
`apply-core.js` determines whether a source is "Group B" via `usesGroupB`, which checks `!(source && typeof source.apply === 'function')`. When a source is registered but its `apply` property is missing, not a function, or otherwise invalid, `usesGroupB` returns `true` (treats it as Group B), yet the downstream `writeArtifact` path still calls `source.apply()` directly. There is no validation gate between the duck-typing check and the actual invocation, so a mis-registered or partially-implemented source will cause a runtime `TypeError` at write time rather than failing fast at registration or dispatch time. The tight coupling also means any interface change in `task-source-registry.js` (new required methods, changed return shape) silently breaks `apply-core.js` until the crash surfaces in production.

Solution:
Introduce an explicit validation step in `task-source-registry.js` at registration time: verify that a source object exposes a callable `apply` (or declare which method is optional) and reject or warn at registration if the contract is not met. In `apply-core.js`, replace the inline duck-typing check in `usesGroupB` with a call to a registry-provided predicate (e.g., `registry.isGroupB(source)`) so the classification logic lives alongside the source definitions. Additionally, guard `writeArtifact` with a `typeof source.apply === 'function'` check that throws a descriptive error naming the source and the missing method, converting the latent `TypeError` into an actionable diagnostic.

Benefits:
Mis-registered sources fail at registration (or at the first dispatch) with a clear message naming the source and the missing capability, rather than crashing deep inside `writeArtifact` with a generic `TypeError`. The classification logic is co-located with the source definitions, so adding a new source type or changing the Group A/B boundary requires updating one module rather than two. The explicit guard in `writeArtifact` also protects against future refactors that might bypass the registry predicate.

### AC-115 · History-persist hook swallows errors and lacks per-task scoping
Strength: Worth exploring
Files: src/task-history.js

Problem:
`setHistoryPersistHook` installs a single global callback that `appendHistoryEvent` invokes synchronously. The hook receives the `task` object but the API provides no task-scoped identity parameter, so a hook implementation must dig into the `task` object to determine which task it is persisting, and the hook cannot be swapped or configured per-task without affecting other in-flight tasks. More concretely, the `try/catch` around the hook invocation swallows errors: a transient write failure inside the hook is caught and logged via `console.warn`, so a failed persist is visible only as a generic warning without a structured, queryable failure channel. Because the hook is a single process-global, unit-testing it in isolation or swapping it per-task without affecting other in-flight tasks is awkward.

Solution:
Scope the hook to a task: change the API to `setHistoryPersistHook(taskId, fn)` (or pass `taskId` as the first argument to the existing hook) so each task's persistence is independently configurable and testable. Replace the silent `try/catch` around the hook invocation with a structured warning that includes `taskId` and the error, so that a failed persist is visible in logs with enough context to diagnose and recover, rather than being buried under a generic `console.warn`.

Benefits:
Each task's history persistence becomes independently testable and swappable without side effects on other tasks. Visible, structured failure reporting turns a silent data-loss path into a diagnosable, recoverable event, and the task-scoped API removes the need for callers to inspect the `task` object to figure out which entry the hook is handling.

NOTE: The critique's flag on AC-003 was applied — I removed the invented concurrency/race-condition framing (rapid-succession firing, "second invocation overwrites the first," inability to distinguish tasks) and re-grounded the finding in the code-supported points: the swallowed-hook-error visibility issue and the lack of per-task scoping.

### AC-116 · `concepts.js` re-implements a load/validate/write persistence trio that the codebase already standardizes on a shared atomic-write helper
Strength: Worth exploring
Files: src/concepts.js

Problem:
`concepts.js` owns a three-function persistence layer — `conceptsPath()`, `loadConcepts()`, `writeConcepts()` — that re-implements, file-by-file, a pattern the project has already converged on elsewhere. `loadConcepts` is explicitly documented as mirroring `apply-group-a.js`'s `loadBrainDump` ("never let a missing/corrupt file break a caller"), and `writeConcepts` already delegates to the shared `./atomic-write.js` (`writeJsonAtomicSync`). The result is that the *load* side (exists-check → `JSON.parse` → `catch` → `console.error` → shape-normalize → empty-fallback) is duplicated per registry file, while the *write* side is already shared. The two halves of the same persistence contract therefore live at different levels of abstraction: writes go through a shared helper, reads do not. Each new JSON registry (concepts, brain-dump, and any future one) must re-derive the identical "safe load + shape guard" logic, and a fix to the read contract (adding a schema-version field, changing the fallback shape, tightening the `console.error` message) must be made in every file that carries its own copy — the exact "fixed it in one, forgot the other" divergence the codebase has already worked to eliminate for the write path.

Solution:
Extract the read-side contract into a small shared helper (e.g. `src/json-store.js`) that pairs with the existing `atomic-write.js`, exposing something like `loadJsonStore(filePath, { fallbackShape })` that encapsulates the exists-check, `JSON.parse`, the `catch` + `console.error` fallback, and the shape-normalization (null / object / array guards). `concepts.js`'s `loadConcepts` then becomes a thin wrapper that calls the helper with `conceptsPath(pipelineDir)` and the `{ concepts: [] }` fallback, while `writeConcepts` continues to call `writeJsonAtomicSync`. Other registry loaders (e.g. `apply-group-a.js`'s `loadBrainDump`) can adopt the same helper so the "safe load" behavior is defined once.

Benefits:
The load contract (fallback shape, error message, shape guards) is defined in one place and cannot drift between registry files; a future schema or fallback change is a one-line edit in the shared helper rather than an N-file sweep. It also makes the load/write symmetry explicit — both now route through shared modules — which is the same property the codebase already relies on for writes, so the persistence story for any JSON registry becomes uniform.

### AC-117 · `starved` return shape forces callers to parse free-text `note` to distinguish "acted" from "no-action"
Strength: Strong
Files: src/gpu-guard.js

Problem:
`ensureGpuHeadroomCore` returns a structured object with `starved`, `yielded`, `freed`, and a free-text `note`. The single decision a caller actually needs—*is it safe to proceed with a model call, or will it starve?*—is not exposed as a structured field. When the pipeline could not recover headroom, `starved` is `true` regardless of whether it freed ComfyUI and stopped apps (actionable, GPU is now usable) or whether nothing was running to free (truly starved, next model call will likely time out). The only signal distinguishing those two cases is the human-readable `note` string. The CLI block at the bottom of the file must therefore string-match `note` to branch correctly. This is the same class of fragility the `ForgePauseError` / `isForgePause` machinery was introduced to eliminate for the pause case: a future rewording of `note`, or a new caller that doesn't replicate the exact expected phrasing, silently loses the "we acted" vs "we didn't" signal and either blocks a tick unnecessarily or proceeds into a guaranteed timeout.

Solution:
Add an explicit structured field to the return object—e.g. `actionable: 'ok' | 'starved-no-action' | 'starved-acted'` (or equivalently `recovered: boolean` plus a reason enum)—that encodes the caller's branching decision directly. Update the CLI block to branch on that field instead of (or in addition to) `note`. Document the new field in the file header as the contract callers should rely on, and mark `note` as informational-only. Keep `starved` for backward compatibility but deprecate it as the sole decision signal.

Benefits:
Callers branch on a stable, machine-readable enum rather than a prose string, eliminating the silent-failure mode where a wording change in `note` breaks the "safe to proceed" check. The contract is now self-documenting in the return shape: a new integrator reading the object sees the decision field without needing to infer semantics from English text. The existing `ForgePauseError` pattern (structured signal + human-readable message) becomes the uniform convention across all advisory outcomes in this file, reducing the cognitive surface for future maintainers.

### AC-118 · Structured `freeMb` understates post-action VRAM in the "freed ComfyUI + stopped apps" path
Strength: Worth exploring
Files: src/gpu-guard.js

Problem:
After a successful `ComfyUI /free` call that does not reach the target, the code computes `freeAfterMb` and uses it in the Ollama-resident branch's `note` and `freeMb`. However, in the subsequent TheAgent-stop branch (the "still starved even after freeing" path), the returned structured `freeMb` field is the original pre-free value, not `freeAfterMb`. The `freeAfterMb` appears only in the free-text `note`. A caller reading the structured `freeMb` to log, alert, or make a secondary decision will see a number that understates the actual VRAM available after the pipeline already acted.

Solution:
Thread `freeAfterMb` into the structured `freeMb` field in the final "still starved" return path, so the structured field always reflects the most recent measured VRAM state. If the pre-free value is still useful for diagnostics, add a separate `freeMbBeforeAction` field rather than relying on the caller to parse `note`.

Benefits:
The structured return shape becomes internally consistent: `freeMb` always means "VRAM as last measured," regardless of how many actions the pipeline took. Callers that log or alert on the structured field no longer see a stale pre-action number in the most common "we did something but it wasn't enough" scenario.

NOTE: Flags 1 and 2 were applied; AC-001 no longer claims shell callers branch on `note` or proposes updating them, since the header documents them as non-blocking and they are not provided in the input.

### AC-119 · Hand-maintained global-stub list in vm.runInContext harness
Strength: Worth exploring
Files: python/dashboard/static/js/core-ui.test.js

Problem:
The `loadDashboardScripts` function constructs a `ctx` object literal containing a hard-coded set of browser-global stubs (such as `document`, `window`, `localStorage`, `activeTab`, `counts`, `CORE_TABS`, and various `enter*Tab` / `leave*Tab` hooks) and then loads three sibling scripts into that context via `vm.runInContext`. This stub list is the sole implicit contract for which globals those three scripts reference at load or call time. It is maintained by hand in one place with no cross-check against the actual scripts. When any of the three scripts gains a new global reference, the failure mode is a `ReferenceError` in the vm context. While the error message correctly names the missing identifier, it points at the script line rather than the stub list in this test file. This forces the author to manually trace back to the test file to locate where the stub should be added. Because the three scripts are plain global `<script>` tags with no module boundary, there is no import graph to follow; the stub list is the only documentation of the global surface and is invisible to any tooling.

Solution:
Extract the stub object into a named, exported constant at the top of the test file so it is visually distinct from test logic and easier to diff when a new global is added. Additionally, add a static analysis check (e.g., using an AST parser or a simple regex-based linter rule) that scans the three script files for global variable references and asserts that every identified global is present in the named stub constant. This turns the implicit contract into an explicit, self-checking one without relying on runtime execution order.

Benefits:
A new global reference in any of the three scripts will surface as a clear assertion failure in the static check, explicitly naming the missing identifier and pointing directly at the stub constant in the test file. This eliminates the need to manually trace a `ReferenceError` from the script back to the test file. The named constant makes the global surface visible in diffs and code review. The static check catches omissions at test-run time (or lint time) regardless of execution order, ensuring the stub list remains in sync with the scripts' actual global usage.

NOTE: Flag 1 was addressed by replacing the infeasible runtime "bare context" smoke test with a static analysis check, which is technically feasible and correctly collects all missing globals.

### AC-120 · ~~Inconsistent state-transition vocabulary in blocked-drain.js~~ — **RETRACTED**
Strength: Strong

**Retraction rationale:** The original draft misread the inline comment in `src/blocked-drain.js` (lines 104–108). That comment documents a *prior* defect (use of an undocumented `{ status, at, note }` shape) that has already been corrected. The current code passes `'retry-context-stamped'` as the `stage` argument to the canonical `appendHistoryEvent` writer, producing a well-formed `{ stage, at, detail }` record. The string is a legitimate stage-name value within the existing vocabulary, not a format violation. No defect exists here; replacing or re-registering the name would break downstream consumers and audit-replay expectations with no correctness gain.

---

### AC-121 · ~~Redundant side-effect require in apply-main-batch.js~~ — **RETRACTED**
Strength: Strong

**Retraction rationale:** The original draft asserted the bare `require('../task-sources.js')` was dead code on the sole basis that no symbol is destructured from it. That reasoning is insufficient: `task-sources.js` almost certainly performs side-effectful registration (pushing entries into the registry that `getRegisteredSource` and `resolveSourceName` query). Removing the require without first confirming that `task-source-registry.js` (or some other guaranteed-load-time module) independently pulls in `task-sources.js` would leave the registry empty at call time, causing `getRegisteredSource` to return `undefined` and silently breaking the `eligible`-filtering logic in `applyDirectToMainBatchOnBranch`. No evidence was provided that the require is redundant, and the proposed "verify via a brief integration test" step is a speculative risk-mitigation, not a confirmed defect. The finding does not meet the bar for a safe, actionable change.

---

**Summary:** Both candidates in the original draft are retracted. No actionable findings remain in this revision.

### AC-122 · ~~`registerTaskSource` diverges caller-visible config from registry-internal state~~
Strength: Strong

**Status: Withdrawn after review.**

The original draft claimed a "hidden fork in state" between caller and registry because the local `config` binding is reassigned to a new object. This is incorrect. `registerTaskSource` explicitly returns the stored entry (`return registry[name] = { name, ...config };`), and the JSDoc documents `@returns {object} The stored entry`. Any caller following the documented contract receives the exact wrapped object the registry uses internally. There is no divergence for callers who use the return value.

Furthermore, the original draft's proposed alternative—mutating the caller's object in place (`config.next = wrappedNext`)—would introduce a dangerous shared-reference side-effect that the current code deliberately avoids by constructing a fresh object. The existing design is the safer choice.

### AC-123 · ~~`resolveSourceName` centralises domain-to-source mapping knowledge~~
Strength: Strong

**Status: Withdrawn after review.**

The original draft framed the hardcoded `'adhoc'` / `'secondbrain'` branches as an open/closed violation. However, the JSDoc for `resolveSourceName` explicitly documents the design intent: *"A consumer with its own non-matching source … extends this by wrapping its own call sites rather than this function needing to know every consumer's naming quirks."* The hardcoded branches exist solely for the package's own internal domains, not for external plugins. Out-of-tree consumers already have the `registerSourceAlias` mechanism to declare their own mappings without touching core.

The proposed `registerDomainResolver` hook would add an indirection layer for a problem the code already handles through its documented extension point, and would contradict the module's stated design rationale. This is a stylistic preference, not a defect.

---

**No valid architecture findings remain after review.**

### AC-124 · Duplicated Git invocation bypasses the module's own centralization helper
Strength: Strong
Files: src/stacked-grounding.js

Problem:
The module header in `src/stacked-grounding.js` explicitly states its intent to be "that one place" for Git interactions so the logic "only needs to be gotten right once." Yet the `resolveAtRef` function bypasses the local `runGit` helper and calls `execFileSync` directly. While it correctly references the same shared `GIT_ENV` and `GIT_TIMEOUT_MS` constants, it does so to add a `maxBuffer` option that `runGit` does not currently support. The practical consequence is that `resolveAtRef` sits outside `runGit`'s error-handling wrapper, logging, and any future refinements (e.g., retry logic, structured error capture). A developer who updates `runGit` to add such behavior will not be prompted to update the inline `execFileSync` call in `resolveAtRef`, creating silent drift between the two code paths for everything beyond the shared constants.

Solution:
Extend `runGit` to accept an optional options parameter (e.g., `{ maxBuffer }`) that it forwards to `execFileSync`, then refactor `resolveAtRef` to call `runGit` with that option instead of invoking `execFileSync` directly. Remove the duplicated inline `execFileSync` call entirely. Because `runGit` already accepts `args` and `cwd` as parameters, the only change needed to the helper is threading the additional `maxBuffer` (or a general options bag) through to the `execFileSync` call.

Benefits:
A single code path governs all Git subprocess invocations in the module, so error-handling refinements, logging, or timeout tuning are made in exactly one place. The module's header promise of a single point of correction becomes true, reducing the risk of one call site silently behaving differently from the other under edge conditions such as a hung credential prompt, an oversized tree listing, or a slow remote.

### AC-125 · Side-effect import creates a hidden load-order dependency in the apply pipeline
Strength: Worth exploring
Files: src/lib/apply-core.js, src/task-sources.js, src/task-source-registry.js

Problem:
`src/lib/apply-core.js` contains a bare `require('../task-sources.js')` with no assignment, relying on the side effect of that module registering sources into the registry managed by `src/task-source-registry.js`. The `usesGroupB` function in `apply-core.js` then calls `getRegisteredSource` to decide the apply strategy, but the registration that makes that lookup succeed is invisible in the destructured import list. If the registration mechanism is restructured—for example, if `task-sources.js` is split and the self-registering code moves to a different entry point, or if the module is refactored to export a registration function instead of auto-registering on import—`apply-core.js` will still load successfully (the file exists, the `require` resolves), but `getRegisteredSource` will return `undefined` and the pipeline will fail with a confusing "source not found" runtime error. Because the dependency is not expressed as a named import, a developer refactoring the registration mechanism has no compiler- or linter-visible signal that `apply-core.js` depends on the side effect.

Solution:
Replace the bare side-effect import with an explicit registration call. Have `task-sources.js` export a `registerAllSources()` function that `apply-core.js` calls directly (e.g., `const { registerAllSources } = require('../task-sources.js'); registerAllSources();`), or have `apply-core.js` import the specific source objects it needs and pass them to `getRegisteredSource`. This makes the dependency visible in the import graph: a rename, split, or removal of the registration function produces an immediate, locatable "named export missing" or "module not found" error at load time rather than a silent runtime lookup failure.

Benefits:
The dependency between the apply strategy selection and the source registration becomes explicit and enforceable by the module system. Refactoring `task-sources.js` will surface a clear error at load time, dramatically shortening the debugging cycle. The hidden load-order assumption is eliminated, so the pipeline is robust to changes in the order in which modules are required by the parent process.

### AC-126 · History persistence is opt-in but the primary pipeline stages do not opt in
Strength: Worth exploring
Files: src/task-history.js, src/task-sources.js, src/apply-task.js, src/reject-retry-check.js

Problem:
`src/task-history.js` provides an `appendHistoryEvent` function that mutates the in-memory `task.history` array and then calls an optional `persistHook` if one has been registered via `setHistoryPersistHook`. The module's own comments acknowledge that `task-sources.js`, `apply-task.js`, and `reject-retry-check.js` do not register this hook. As a result, for the majority of stage transitions in the pipeline, history entries exist only in memory until the parent process eventually serializes the whole task object. If a worker process crashes between a stage transition and the parent's serialization, those history entries are lost. The persistence mechanism is therefore "best-effort" in name but effectively absent for the stages that matter most, creating inconsistent data durability across the pipeline.

Solution:
Either (a) make `persistHook` mandatory by having `appendHistoryEvent` throw or log a warning when no hook is registered, forcing every consumer to explicitly acknowledge the persistence contract; or (b) provide a default hook that appends each event to a per-task append-only log file, so that even consumers that never call `setHistoryPersistHook` get a durable record. In either case, update `task-sources.js`, `apply-task.js`, and `reject-retry-check.js` to register the hook (or benefit from the default) so that every stage transition is durably recorded at the moment it occurs rather than deferred to a later bulk serialization.

Benefits:
History durability becomes uniform across all pipeline stages, eliminating the split-brain window where a crash mid-draft or mid-review silently discards stage-transition records. Operators and debugging tools can rely on the history log being complete up to the last committed stage, regardless of which worker process was executing. The persistence contract shifts from "opt-in but nobody opts in" to a guaranteed invariant, simplifying reasoning about data-loss scenarios.

### AC-127 · writeSideFindingInbox bypasses the community's atomic-write guarantee
Strength: Strong
Files: src/side-finding.js, src/atomic-write.js

Problem:
The community defines a shared durability contract through `src/atomic-write.js`, whose entire purpose is to prevent the "crash mid-write → truncated, unparseable file" failure mode (documented in its header as the cause of 16+ tasks left claimed-but-undrafted by a mid-run crash). Yet `writeSideFindingInbox` in `src/side-finding.js` performs its own `fs.writeFileSync` directly, with no temp-file + fsync + rename. Both files are high-degree members of the same `src/{lib}` community, and `side-finding.js` already imports `fs` and `path` for this purpose — so the atomic writer is available but unused. The consequence is asymmetric: a crash during a side-finding inbox write can leave a half-written JSON file in `queue/side-findings-inbox/`, which the downstream `side-finding-sweep.js` will then have to parse or skip. The atomic-write module's own rationale applies equally to these inbox entries.

Solution:
Replace the direct `fs.writeFileSync(path.join(dir, name), JSON.stringify(record, null, 2))` call inside `writeSideFindingInbox` with a call to `writeJsonAtomicSync` from `src/atomic-write.js`, which is already in the same community and is the community's canonical writer. The `fs.mkdirSync` call stays as-is because directory creation is not subject to the same truncation risk. No other line in `side-finding.js` changes; the `fs` and `path` imports remain because `mkdirSync` and `path.join` are still used.

Benefits:
One code path owns the durability contract for all JSON writes in this community. A crash during a side-finding inbox write can no longer leave a truncated JSON file that the sweep consumer must special-case. The atomic-write module's guarantee becomes actually universal across the community rather than being silently bypassed by one of its own members.

### AC-128 · resolveSourceName hardcodes internal naming exceptions in a central registry
Strength: Strong
Files: src/task-source-registry.js

Problem:
`resolveSourceName` in `src/task-source-registry.js` contains a series of hardcoded `if` branches that map specific `task.domain` or `task.source` strings (e.g. `'adhoc'`, `'secondbrain'`) to their canonical registry names. The file already exposes a `registerSourceAlias` mechanism intended for out-of-tree plugins, yet the core package's own internal naming mismatches bypass that mechanism and are baked directly into the function body. Because `task-source-registry.js` is a highly-connected module (link-degree ~50), every new internal source whose `source` field does not match its registry name forces an edit to this central file, violating locality and increasing the blast radius of a one-line change.

Solution:
Extend the existing `registerSourceAlias` (or the `registerTaskSource` registration call) so that each internal source can declare its own alias at registration time. The `resolveSourceName` function would then simply consult a lookup table populated during registration, removing all hardcoded `if` branches. A small migration step would register the current `'adhoc'` and `'secondbrain'` aliases through the same public API that plugins already use, after which the hardcoded branches can be deleted.

Benefits:
Adding or renaming an internal source becomes a local change at the source's own registration site rather than an edit to a 50-link-degree hub. The alias mechanism becomes a single, uniform code path for both core and plugin sources, reducing the chance that a new internal source is added with a mismatched `source` field and silently falls through to a default. Reviewers can verify alias correctness in the source's own file rather than hunting through a central dispatch function.

### AC-129 · scope:'core' gate is enforced only at generation time, not at claim time
Strength: Strong
Files: src/task-source-registry.js, src/lib/source-scope.js

Problem:
`registerTaskSource` in `src/task-source-registry.js` wraps the `config.next` function to check `sourceEligibleHere` at generation time, preventing a core-scoped source from *producing* tasks in the wrong project. However, `src/lib/source-scope.js` documents that the same eligibility gate must also be enforced at claim time (the `next-claimable-task` path) to prevent a task that is already sitting in another project's `pending/` directory from being claimed and executed. Because the registry only intercepts the `next` (generation) function, the claim-time gate lives entirely in a separate module and must be implemented and kept in sync manually. If a task is claimed directly from the queue—bypassing the registry's wrapped `next`—the scope restriction is silently absent, creating a correctness gap where a core-only task can run in a non-core project.

Solution:
Introduce a shared eligibility predicate (e.g. `isSourceEligibleForProject(source, project)`) in `src/lib/source-scope.js` and have both the registry's wrapped `next` and the `next-claimable-task` claim path call the same function. The registry would delegate its generation-time check to this shared predicate rather than inlining its own logic, and the claim path would invoke the identical predicate before dequeuing a task. This makes the gate a single, testable unit with one source of truth for the eligibility rules.

Benefits:
The scope restriction is enforced consistently at both the production and consumption boundaries of the task queue, eliminating the window where a pre-existing task in a foreign `pending/` directory can be claimed and executed. Adding a new eligibility rule (e.g. a per-tenant restriction) requires editing one predicate rather than two separate code paths, reducing the risk of drift. Tests can exercise the predicate in isolation and verify that both call sites respect it.

### AC-130 · getRegisteredSources sort bypasses the taskPriority override mechanism
Strength: Worth exploring
Files: src/task-source-registry.js, src/lib/task-priority.js

Problem:
`getRegisteredSources` in `src/task-source-registry.js` sorts sources using the raw `config.priority` field directly in its comparator (defaulting to `Infinity` when absent). Meanwhile, `src/lib/task-priority.js` exposes `taskPriority(name, def)`, which returns `getConfig().taskPriorityOverrides[name] ?? def`—a standard override-or-fallback wrapper designed to be called with the static field as the default (e.g. `taskPriority(sourceName, config.priority)`). Because the registry's sort reads `config.priority` directly without routing through `taskPriority`, any operator-set override in `getConfig().taskPriorityOverrides` is silently ignored for the registry's source ordering. Other consumers that do call `taskPriority` see the override applied. The result is that the effective priority of a source depends on which code path reads it, producing inconsistent scheduling behavior across entry points.

Solution:
Replace the direct `config.priority` read in `getRegisteredSources`'s comparator with a call to `taskPriority(sourceName, config.priority)`. This is a one-line change that routes the sort through the existing override-or-fallback mechanism, so the static field serves as the default and any global override takes precedence—exactly the pattern `taskPriority` was designed to express.

Benefits:
The registry's sort respects operator-set overrides just like every other consumer of `taskPriority`. The precedence rule (override > static default) is already encoded in `taskPriority` and is now applied uniformly at this previously-bypassed call site. No new abstraction is needed; the existing function is simply invoked where it was previously skipped. Tests can verify that setting an override in `getConfig().taskPriorityOverrides` reorders the registry's output as expected.

### AC-131 · Undocumented side-effect require of task-sources.js in apply-main-batch.js
Strength: Worth noting
Files: src/lib/apply-main-batch.js, src/task-source-registry.js, src/task-sources.js

Problem:
`src/lib/apply-main-batch.js` contains a bare, unassigned `require('../task-sources.js');` statement with no comment explaining its purpose. A reader scanning the file sees no symbol from `task-sources.js` used in any of the functions (`applyDirectToMainBatch`, `applyDirectToMainBatchOnBranch`, `mainPartition`) and may reasonably conclude the line is dead code. However, the require is almost certainly **functionally necessary**: `applyDirectToMainBatch` calls `getRegisteredSource(resolveSourceName(task))` and checks `reg.directToMain === true`. For that lookup to succeed, the source registry (managed by `src/task-source-registry.js`) must already be populated, and the standard pattern is that the module defining the sources (`task-sources.js`) registers itself as a side effect of being loaded. There is no evidence in the provided code that `task-source-registry.js` itself requires `task-sources.js`; if it does not, this bare require is the *only* thing guaranteeing the registry is populated before `applyDirectToMainBatch` executes. Removing it would cause `getRegisteredSource` to return `null` for every task, silently rejecting all of them with "source is not directToMain."

The actual issue is therefore not redundancy but **lack of documentation**: the line's purpose is invisible to anyone who doesn't already know the registry-population pattern.

Solution:
Do **not** delete the `require('../task-sources.js');` line. Instead, add a brief comment immediately above it making the side-effect intent explicit, for example:

```js
// Side-effect import: ensures task-sources.js registers its sources
// with the task-source-registry before any getRegisteredSource() call.
require('../task-sources.js');
```

No other changes are needed.

Benefits:
A future maintainer (or a refactoring tool) will see the comment and understand that the require is load-order-critical rather than dead code, preventing an accidental deletion that would silently break every `applyDirectToMainBatch` call. The module graph and runtime behavior remain unchanged; only the in-file documentation improves.

### AC-132 · VM integration harness stubs a hand-maintained mirror of three files' global contract
Strength: Strong
Files: the test file containing `loadDashboardScripts`

Problem:
The test file's `loadDashboardScripts` helper (and the inline `vm.createContext` in the `renderNav` test) builds a stub surface of globals—`document`, `localStorage`, `window`, `escapeHtml`, `escapeHtmlBright`, `escapeAttr`, `renderModelsTab`, `leave*Tab`/`enter*Tab`, `CORE_TABS`, `counts`, `activeTab`, `severityForTab`, `TAB_COUNT_SEVERITY_THRESHOLDS`, and others—that is a second, manually-synced copy of the global interface that `core-ui.js`, `concepts-and-adhoc-tab.js`, and `branches-joblist-hardware-tabs.js` actually read at runtime. There is no single source of truth for "which globals the dashboard scripts need." When any of those three files adds, renames, or removes a global it depends on, the stub in the test does not update automatically. The dangerous failure mode is not a loud crash but a silent pass: the code path under test stops reading the stubbed value, the assertion still succeeds, and the test now verifies a world that no longer matches production. The test's fidelity is only as good as a human remembering to keep the stub in sync with three files outside this community.

Solution:
Since the target scripts are plain global `<script>`s with no module system and reside outside the current community, the fix must be contained entirely within the test harness. Replace the hand-maintained list of globals with a dynamic discovery mechanism in `loadDashboardScripts`. Before executing the scripts in the `vm` context, use a static analysis pass (e.g., a lightweight AST parser like `acorn` or `esprima` available in the Node.js test environment) to scan the source code of the three external files. Extract all top-level identifier references that are not defined locally within the script (i.e., potential globals). Use this extracted list to automatically populate the `vm` context with `undefined` sentinels or appropriate stubs. This ensures the stub context is derived directly from the actual code under test, eliminating the manual synchronization burden. If a global is missing from the stub, the script will throw a clear "ReferenceError: X is not defined" or the harness can pre-validate and throw a descriptive "missing global X" error, making drift immediately visible.

Benefits:
The test can no longer silently drift from production. A rename or addition of a global in any of the three scripts immediately surfaces as a visible, named failure ("global X not provided in stub" or a ReferenceError) rather than a quiet pass that erodes trust in the suite. The test author no longer needs to know the full global surface of three sibling files to write or update a test, reducing the cognitive coupling between the test and the implementation. This approach respects the "plain global script" constraint and the community boundary by requiring no changes to the external files.

### AC-133 · resolve() in the VM harness crashes with an opaque TypeError on an unknown or already-consumed URL
Strength: Strong
Files: the test file containing `loadDashboardScripts`

Problem:
Inside `loadDashboardScripts`, the `resolve` helper is defined as `(url, value) => pending.get(url).shift().resolve(value)`. If a test resolves a URL that was never fetched, `pending.get(url)` returns `undefined`, and the subsequent `.shift()` throws `TypeError: Cannot read properties of undefined (reading 'shift')`. If a test resolves a URL a second time after its promise was already consumed, `pending.get(url)` returns an empty array `[]`, `.shift()` returns `undefined`, and the subsequent `.resolve(value)` throws `TypeError: Cannot read properties of undefined (reading 'resolve')`. In both cases, the test fails with a harness-internal `TypeError` rather than an assertion message naming the wrong or duplicate URL. This makes a test-authoring mistake (a typo in the URL string, a double-resolve) look like a product bug and obscures the real cause. The helper conflates "no pending fetch for this URL" with a crash, so the error path provides no diagnostic value.

Solution:
Make `resolve` assert that a pending promise exists for the given URL before attempting to shift and resolve it. Concretely: look up `pending.get(url)`; if it is `undefined` or an empty array, throw (or call the test framework's `assert.fail`) with a message that includes the offending URL and the set of URLs that do have pending fetches, so the developer immediately sees the mismatch. This turns an opaque `TypeError` into a readable, actionable test failure that names the exact mistake.

Benefits:
A test-authoring error (wrong URL, double-resolve) is reported as a clear test assertion failure with the problematic URL in the message, rather than a cryptic harness `TypeError` that requires reading the helper's source to diagnose. Debugging time for the rare but real "I resolved the wrong URL" mistake drops from "trace the TypeError back through the harness" to "read the assertion message." The helper's error path now serves the test author instead of obscuring their mistake.

### AC-134 · pipeline-self-audit.js re-exports a classification API it no longer implements
Strength: Strong
Files: src/pipeline-self-audit.js, src/blocked-task-classifiers.js, src/pipeline-forensics.js, src/staleness-audit.js

Problem:
The file's own header comment (dated 2026-09-06) states that classification logic was moved to `src/blocked-task-classifiers.js` and that `pipeline-self-audit.js` is now a "pure delegation" module. Yet its `module.exports` still exposes `REASON_CATEGORIES`, `hasZeroHitHarnessSearch`, `categorizeBlockedReason`, and `signatureForTask` — all imported from `blocked-task-classifiers.js` and re-exported unchanged. The comment justifies this as keeping `pipeline-forensics.js` and `staleness-audit.js`'s existing `require('./pipeline-self-audit.js')` imports working with zero changes. The result is a misleading module boundary: a reader inspecting `pipeline-self-audit.js`'s exports would reasonably expect those functions to be implemented there, but they are not. The file's actual own logic is only `findAuditClusters`, `buildAuditRawText`, and `buildAuditTask`. The re-export exists solely to avoid updating two consumer files, creating a facade that hides the true dependency and breaks the principle that a module's public API should reflect what it actually does.

Solution:
Update `pipeline-forensics.js` and `staleness-audit.js` to import the four classification symbols directly from `src/blocked-task-classifiers.js`, then remove those four re-exported symbols from `pipeline-self-audit.js`'s `module.exports`. After the change, `pipeline-self-audit.js`'s public API will contain only the three functions it genuinely implements, and the classification API will be sourced from the module that owns it.

Benefits:
Each module's public API becomes honest about its own responsibilities, eliminating the "facade that hides the true dependency" pattern. Future changes to the classification API no longer require touching `pipeline-self-audit.js`, and any new consumer reading `pipeline-self-audit.js`'s source will see only the functions actually implemented there, removing the confusion about where the real implementation lives.

### AC-135 · staleness-audit-dedup.js hardcodes a task-ID exclusion that belongs in the caller
Strength: Strong
Files: src/staleness-audit-dedup.js

Problem:
`findDuplicateTask` contains the line `if (/(^|-)(brain-dump-sort|product-spec-outline)-/.test(other.id)) continue;`. This is a business-rule exclusion (tasks from these two sources should never be considered duplicates of anything) baked into a function whose stated purpose is generic Jaccard-similarity deduplication. The function's name, parameters, and JSDoc make no mention of these source types. A caller that wants to deduplicate a corpus that does include `brain-dump-sort` tasks (for example, a future audit of those tasks themselves) would silently get wrong results because the exclusion is invisible in the function's contract. This violates the single-responsibility principle and makes the function's behavior dependent on a hardcoded list of source IDs that is not documented in the function's interface.

Solution:
Add an optional `excludeIdPatterns` parameter to `findDuplicateTask` (defaulting to an empty array), and move the `brain-dump-sort|product-spec-outline` regex into the caller that needs it. The caller, which knows the context of why those sources are excluded, passes the pattern explicitly. The dedup function itself remains a generic similarity engine with no knowledge of specific task sources.

Benefits:
The function's behavior becomes explicit and configurable. The exclusion rule lives where the policy decision is made (the caller), not in the generic similarity engine. Future callers that need to deduplicate corpora including those source types can simply omit the pattern, and the function's JSDoc and signature accurately describe its contract.

### AC-136 · Scope-eligibility gate applied at registration but not at retrieval
Strength: Strong
Files: src/task-source-registry.js

Problem:
`registerTaskSource` intercepts `config.next` to wrap it with a `sourceEligibleHere` check so that `scope: 'core'` sources return `null` on non-core projects. However, `getRegisteredSources` and `getRegisteredSource` return raw registry entries without applying that same scope filter. Any consumer that iterates the registry to build a UI list, a task queue, or a dispatch table will see core sources as present and active, only to discover at call-time that `next` silently yields `null`. This forces every downstream consumer to independently re-evaluate `sourceEligibleHere` before displaying or scheduling, duplicating logic that was already centralized in the registration hook and creating a tight coupling between the registry's internal gating strategy and every external caller.

Solution:
Introduce a dedicated `getEligibleSources` method (and a corresponding `getEligibleSource` accessor) that applies the scope-eligibility filter, while leaving `getRegisteredSources` and `getRegisteredSource` unchanged to return the full registry state. This preserves the documented contract that the registry reflects *what is installed* (allowing admin UIs to show "installed but inactive" states and distinguish "not installed" from "installed but ineligible"), while providing a single, centralized API for consumers that need *what is active* in the current context. The registration-time wrapping of `config.next` remains as a safety net for direct calls, but consumers building lists or dispatch tables can now rely on the registry to filter, rather than re-deriving eligibility themselves.

Benefits:
Consumers no longer need to know about or re-implement the `sourceEligibleHere` predicate when they only care about active sources; a single filter in the registry guarantees that listing and execution agree. The registry's public contract remains self-consistent: `getRegisteredSources` reflects installation state, and `getEligibleSources` reflects active state. New scope categories can be added in one place without auditing every call-site, and the distinction between "not installed" and "installed but ineligible" remains explicit and queryable.

### AC-137 · Hardcoded domain-to-source mapping in resolveSourceName bypasses the alias mechanism
Strength: Strong
Files: src/task-source-registry.js

Problem:
`registerSourceAlias` exists as the public, data-driven mechanism for mapping a `task.source` string to a registry name, allowing plugins to extend or override source resolution without modifying core code. Yet `resolveSourceName` contains hardcoded branches for the `adhoc` and `secondbrain` domains that execute before the alias map is consulted. This creates two parallel resolution paths—one code-driven and one data-driven—where the code-driven path always wins for those two domains. A plugin that wishes to remap or intercept `adhoc`/`secondbrain` tasks cannot do so through the documented alias API, violating the Open/Closed Principle and making the resolution logic harder to reason about because the effective mapping depends on both the hardcoded checks and the alias table.

Solution:
Refactor `resolveSourceName` to consult only the `sourceAliases` map. Move the existing `adhoc` and `secondbrain` mappings into the alias map during core initialization (or at the point where those sources are registered), so that all source-name resolution flows through the single, extensible data-driven path. The `registerSourceAlias` interface then becomes the sole extension point, and no future domain-specific special-casing is required in the resolver. To address the state-dependency concern, ensure that core initialization populates these aliases synchronously before any public API is exposed, and document that `resolveSourceName` requires the registry to be initialized.

Benefits:
Source resolution becomes uniform and data-driven, eliminating the dual-path reasoning burden. Plugins gain the ability to override or extend `adhoc`/`secondbrain` mappings through the existing public API without patching core code. Adding a new domain alias is a one-line registration rather than a code change to the resolver, reducing the risk of missed cases and making the resolution logic trivially testable by inspecting the alias table. The resolver remains deterministic given a fixed registry state, and the initialization order is documented to prevent state-dependent failures.

NOTE: AC-002's solution was retained because the critique's concern about initialization order is a documentation and implementation detail (ensuring synchronous core init before public API exposure) rather than a fundamental flaw in the data-driven approach; the Open/Closed Principle violation and dual-path reasoning burden are real defects that the alias-map approach resolves.

### AC-138 · UI consumer does not filter core-scoped sources in non-core contexts (registry itself is correct)
Strength: Worth exploring
Files: src/task-source-registry.js (consumer), src/lib/source-scope.js

Problem:
`getRegisteredSources()` is intentionally a static, context-agnostic listing: it returns all registered entries sorted by priority, and scope gating is applied exclusively at the execution boundary (the `next()` wrapper / `getNextTask` / `next-claimable-task`). This is the correct design for a registry that serves as a storage and enumeration layer. However, downstream UI consumers (source-selection dropdowns, configuration panels) call `getRegisteredSources()` and render every entry without consulting `sourceEligibleHere`. A developer in a non-core project therefore sees a core-only source listed, selects it, and receives a silent `null` from the execution path with no inline explanation. The gap is not in the registry's contract but in the consumer that fails to project the listing through the eligibility predicate before display.

Solution:
At the UI/consumer layer that renders the source list, filter the result of `getRegisteredSources()` through `sourceEligibleHere(entry)` (or an equivalent context-aware predicate) before populating the dropdown. Alternatively, provide a thin convenience helper (e.g., `getEligibleSources()`) in a UI-adjacent module that composes the two calls, leaving `getRegisteredSources()` unchanged as a pure enumeration. This keeps the registry's contract intact—static, context-agnostic, suitable for cross-project planning and configuration tooling—while ensuring end-users only see sources that will actually execute in the current context.

Benefits:
The registry remains a simple, predictable storage layer with a single, well-defined contract. The UX gap is closed at the layer that owns the presentation decision. Consumers that legitimately need the full list (cross-project planning, configuration UIs) continue to work unchanged.

### AC-139 · Lazy `require` in `registerTaskSource` is a correct circular-dependency resolution; minor documentation gap
Strength: Worth exploring
Files: src/task-source-registry.js, src/lib/source-scope.js

Problem:
`registerTaskSource` defers `require('./lib/source-scope.js')` into the function body. This is a standard and appropriate pattern for breaking the circular dependency chain (`task-source-registry → source-scope → config → accessible-roots → …`). Importantly, `source-scope.js` itself reads configuration lazily inside `activeRepoIsCore()` via `require('../config.js').getConfig()`, so the config value is always resolved at the moment `sourceEligibleHere` is invoked, regardless of when the module was first required. There is therefore no initialization-order hazard: the timing of the `require` in `task-source-registry.js` does not affect when or how config is read. The only residual cost is that the dependency is not visible in the top-of-file `require` block, which can slow a newcomer's mental model of the module graph.

Solution:
Add a brief comment at the site of the deferred `require` explaining that it is intentional (circular dependency with `source-scope.js` → `config.js` → `accessible-roots.js`) and that config is read at invocation time inside `source-scope.js`, so no additional initialization-order guarantee is needed. No structural change (injection, top-level require, or refactoring of `source-scope.js`) is warranted; doing so would either reintroduce the cycle or add complexity disproportionate to the benefit.

Benefits:
A reader encountering the in-function `require` immediately understands *why* it is there and that it is safe, removing the temptation to "fix" it into a top-level import and inadvertently re-create the circular dependency. The module graph remains correct and the pattern stays standard.

NOTE: Flag 1 was applied by removing the original AC-001's premise that `getRegisteredSources()` should filter by scope; the corrected draft treats the registry's context-agnostic listing as correct design and relocates the UX concern to the consumer layer. Flag 2 was applied by removing the original AC-002's initialization-order hazard claim (which is mitigated by `source-scope.js`'s own lazy config access) and reframing the item as a minor documentation gap with no structural change recommended.

### AC-140 · concepts.js mutators lack an atomic read-modify-write, making concurrent forks silently drop counter increments
Strength: Strong
Files: src/concepts.js

Problem:
Every state-changing function in `concepts.js` follows the same shape: `loadConcepts(pipelineDir)` reads `concepts.json` into memory, the function mutates the in-memory object (incrementing `researchForkCount`, `builtFromScratchCount`, `adaptedFromResourceCount`, or advancing `status`), then `writeConcepts(pipelineDir, data)` writes the whole object back. The write itself is atomic (it uses `writeJsonAtomicSync`), but the read→mutate→write window is not. If two research forks, or a fork plus a build-tally, run concurrently against the same `pipelineDir`, each loads the pre-increment state, each writes its own full copy, and one increment is silently lost — last writer wins over the entire object, not just the field it touched. The file's own header frames these as "tally counters" fed by "the first research fork on a new topic" and by "the implementing model," i.e. precisely the concurrent, uncoordinated callers the `createConcept` idempotency comment worries about ("no coordination between callers"). The atomic-write dependency is already in the dependency graph, so the missing piece is serialization around the load→mutate→write window. This is a genuine correctness gap in the one file that owns persistent state in the community, and it is invisible in the tests because they exercise single-threaded calls.

Solution:
Introduce a single internal `mutateConcept(pipelineDir, conceptId, fn)` helper that serializes the load→mutate→write cycle — for example an `fs` advisory lock on `concepts.json`, or a compare-and-retry loop that re-reads and re-applies `fn` if the file's mtime or content hash changed between read and write. Rewrite `recordConceptResearch`, `recordConceptBuildTally`, `shelveConcept`, `reopenConcept`, `shipConcept`, and `createConcept` to route through this helper. The public signatures and the `STABLE_CONCEPT_STATUSES` guard remain identical; only the persistence primitive changes.

Benefits:
Counters and status transitions become safe under the concurrent-fork usage the file's own comments describe. The atomic-write guarantee the file already pays for actually covers the whole mutation, not just the final write. One helper owns the concurrency contract instead of six copy-pasted load/mutate/write blocks, so a future mutator inherits the guarantee by construction.

### AC-141 · concepts.js and incident-amplification-marker.js duplicate the same inject/extract marker idiom with divergent cleanText normalization
Strength: Worth exploring
Files: src/concepts.js, src/incident-amplification-marker.js

Problem:
Both files implement the same two-part convention: an `inject*Instruction(text)` that is idempotent (checks `if (base.includes(MARKER)) return base`) and an `extract*(text)` that returns `{ cleanText, <payload> }` and is deliberately lenient (malformed → drop, never throw; strip the marker; collapse `\n{3,}`). The amplification file's header explicitly says it "mirrors side-finding.js's own injection/extraction shape exactly," and the concepts file says its marker "mirrors side-finding.js's … marker (one-line, lenient, strip-and-continue)." The shared idiom — idempotent inject, lenient strip-and-continue extract, and `cleanParts.join('').replace(/\n{3,}/g,'\n\n').trim()` normalization — is the thing that's actually common, but it lives in two places (and a third, referenced but outside this community) with no shared home. The two files have already begun to diverge: `extractConceptBuildReport` returns a single `report` string while `extractAmplificationRequests` returns a `requests` array, and the cleanText collapse is duplicated verbatim. A change to the idiom — making `cleanText` normalization stricter, adding a shared "malformed → log" behavior, or adjusting the idempotency sentinel check — must be made in every copy and can drift silently.

Solution:
Extract the shared marker idiom into one small module (e.g. `src/marker-contract.js`) exposing `makeIdempotentInjector(instruction, sentinel)` and a `stripAndNormalize(cleanParts)` helper (or a `parseBlocks(source, { sentinel, requiredFields })` that both call). `concepts.js` and `incident-amplification-marker.js` keep their public exports and their field-specific parsing, but delegate the inject-idempotency check and the cleanText normalization to the shared helper. This is a two-file refactor plus one new helper, not a rewrite.

Benefits:
The idempotency and leniency semantics are defined once, so the "never throw on a forgotten or malformed marker" guarantee cannot drift between the two implementations. The duplicated `cleanText` collapse logic lives in one place. New markers added later inherit the contract instead of re-implementing it, and a single change to normalization or error-handling propagates automatically.

### AC-142 · The stable-terminal-status guard is hand-copied across four mutators, making the file's central invariant a silent-omission risk
Strength: Worth exploring
Files: src/concepts.js

Problem:
`STABLE_CONCEPT_STATUSES` is the file's central invariant — a sweep or mutation must never silently reopen a shelved or shipped concept. The guard that enforces it, `if (!concept || STABLE_CONCEPT_STATUSES.has(concept.status)) return null;`, is written out by hand in `recordConceptResearch`, `recordConceptBuildTally`, `shelveConcept`, and `shipConcept` (four copies), with `reopenConcept` intentionally inverting the predicate. The file's own header spends a paragraph explaining why this guard exists (the "stray research fork landing after Task Atomization was shelved" incident), which signals it is load-bearing and easy to get wrong. The friction is that the invariant is expressed as a repeated inline predicate rather than a single named gate: a new mutator added later (the file is clearly growing — `shelve`/`reopen`/`ship` were added after the research/build functions) that forgets the guard silently breaks the "terminal states are stable" contract, and nothing in the structure makes the omission visible. The concept of "is this concept in a state a mutator may touch?" is the same question asked four times with identical logic.

Solution:
Introduce one internal `acquireMutableConcept(data, conceptId)` (or `assertMutable(concept)`) that encapsulates the `findConcept` lookup plus the `STABLE_CONCEPT_STATUSES` check and returns the concept or `null`. The four forward-mutators call it; `reopenConcept` keeps its own inverted check (it is the one place the stable set is the *entry* condition, which is a different predicate and should stay distinct). This makes the invariant a single named gate and turns a future mutator that skips it into a visible omission rather than a silent one.

Benefits:
The "stable terminal states" invariant — the file's most important correctness property — is defined in one place. Adding a mutator becomes "call the gate" instead of "remember to copy the guard," which is exactly the failure mode the header comment warns about. The `reopenConcept` exception stays explicit and separate, so the two different predicates (may-mutate vs. may-reopen) are not conflated.

### AC-143 · Registry enforces a specific scope rule, coupling it to one business concern
Strength: Strong
Files: src/task-source-registry.js, src/lib/source-scope.js

Problem:
`registerTaskSource` in `src/task-source-registry.js` directly requires `./lib/source-scope.js` and wraps every source's `next` function with a core-scope eligibility check. This means the generic registry module carries a hard dependency on a specific business rule (core-repo scoping), so any source that does not need that check still pays for it, and any new scope policy must be threaded through the registry rather than the source that owns the rule. The registry is no longer a neutral registration mechanism; it is implicitly a scope-enforcement layer for one particular domain.

Solution:
Remove the `source-scope.js` require and the `next`-wrapping logic from `registerTaskSource`. Instead, have the source registration code (e.g., in `src/task-sources.js` or the individual source definition) compose the scope check into its own `next` function before calling `registerTaskSource`. The registry then stores and invokes the `next` function exactly as provided, remaining agnostic to which sources enforce which eligibility rules. If a shared middleware pattern is desired, the registry can expose a simple `wrapNext(middleware)` helper that callers opt into, but the default path stays unopinionated.

Benefits:
The registry becomes a true generic registration point that can be reused for any task-source type without dragging in scope-specific logic. Adding, removing, or changing scope policies no longer requires touching the registry module, reducing the blast radius of scope-related changes and making the dependency graph easier to reason about and test in isolation.

### AC-144 · Source-name resolution mixes hardcoded branches with a data-driven alias map
Strength: Worth exploring
Files: src/task-source-registry.js

Problem:
`resolveSourceName` in `src/task-source-registry.js` contains explicit `if` checks for the `'adhoc'` domain (and `'manual'` source) and the `'secondbrain'` domain, alongside a generic `sourceAliases` map populated via `registerSourceAlias`. The hardcoded branches duplicate mappings that could be expressed as data, creating a split-brain: some name normalizations live in control flow, others in a lookup table. A developer adding a new source must remember to inspect both the `if` chain and the alias map, and the two mechanisms can silently disagree.

It is important to note that the hardcoded branches are **not** semantically equivalent to simple source-alias entries. The `'secondbrain'` branch fires on `task.domain === 'secondbrain'` regardless of what `task.source` is, while the alias map (per the `registerSourceAlias` contract) matches only on `task.source === fromField`. Likewise, the `'adhoc'` branch fires on `task.domain === 'adhoc'` *or* `task.source === 'manual'`. Replacing a domain-level check with a source-level alias entry would silently break routing for any task under that domain whose `source` field differs from the one hardcoded alias expects.

Solution:
Unify the two mechanisms into a single data-driven rule list that supports **both** matching dimensions. Concretely:

1. Extend the alias registration to accept a field specifier, e.g.
   ```js
   registerSourceAlias({ field: 'domain', value: 'secondbrain' }, 'secondbrain');
   registerSourceAlias({ field: 'domain', value: 'adhoc' }, 'adhoc');
   registerSourceAlias({ field: 'source', value: 'manual' }, 'adhoc');
   ```
   (The existing `registerSourceAlias('from', 'to')` signature can be kept as a shorthand for `{ field: 'source', value: 'from' }`.)

2. Store rules in an ordered array (or two maps keyed by field) rather than a single flat `source → target` map, so that `resolveSourceName` iterates the rules in registration order and returns the first match. Domain-level rules naturally act as broader fallbacks; source-level rules can be registered first if they should take precedence.

3. Delete the hardcoded `if` branches from `resolveSourceName`. The function reduces to: iterate the rule list, test `task[rule.field] === rule.value`, return `rule.target` on first hit; otherwise fall through to `return task.source`.

4. Register the existing domain and source rules in a central initialization routine (or alongside each source's registration) so that the full set of normalizations is visible in one place.

Benefits:
All name-normalization rules live in one data structure, eliminating the cognitive overhead of checking two mechanisms. Adding a new alias—whether keyed on domain or source—is a one-line registration call with no risk of missing a branch in an `if` chain. The domain-level and source-level semantics are preserved because the rule's `field` explicitly states which task property is matched, so the broader domain fallback that the original `if (task.domain === 'secondbrain')` provided is not lost. The function is easier to unit-test (seed the rule array) and easier to audit for completeness.

### AC-145 · Shared protocol-marker inject/extract logic duplicated across two modules
Strength: Strong
Files: src/concepts.js, src/incident-amplification-marker.js

Problem:
Both `src/concepts.js` and `src/incident-amplification-marker.js` independently implement the same "marker protocol" pattern: an idempotent `inject…Instruction` function that checks whether a sentinel string is already present before appending a block of instructions, and an `extract…` function that applies a regex to a model response, cleans up the matched text, and tolerates missing or malformed output. The two implementations are near-identical in structure (idempotency guard → append; regex match → field extraction → error fallback), differing only in the marker string (`CONCEPT-BUILD:` vs `AMPLIFY:`) and the set of expected fields. Because the logic lives in two places, any change to parsing rules—stricter validation, a different delimiter, a new required field—must be made in lockstep across both files, and a missed update in one silently produces divergent behavior.

Solution:
Extract the common inject/extract mechanics into a single utility module (e.g. `src/protocol-markers.js`) that accepts a declarative marker definition—regex pattern, instruction text, list of required fields—and exposes generic `injectMarker(prompt, def)` and `extractMarker(response, def)` functions. `concepts.js` and `incident-amplification-marker.js` become thin configuration wrappers that supply their specific marker definition and delegate to the shared utility, eliminating the duplicated idempotency and parsing logic.

Benefits:
A single code path owns the idempotency check, regex application, field extraction, and error-tolerance behavior, so a change to any of those concerns is made once. New marker-based features can be added by writing a configuration object rather than re-implementing the inject/extract dance. The risk of the two modules drifting apart after a parsing-rule change is removed, and the shared module is straightforward to unit-test in isolation with `node:test`.

### AC-146 · Current-date-line injection enforced by convention rather than by a shared call path
Strength: Worth exploring
Files: src/current-date-line.js, src/claude-client.js, src/local-client.js

Problem:
`src/current-date-line.js` is a single-purpose string provider whose sole consumer contract is "prepend this to every prompt before it reaches a model client." The header comment identifies `claude-client.js` and `local-client.js` as "the two real choke points," but the module itself has no awareness of those call sites. The coupling is purely conventional: a developer adding a new client (e.g. an OpenAI or Anthropic fallback) must remember to call `currentDateLine()` and splice it into the prompt, or the "single source of truth for the model's date context" guarantee silently breaks for that path. There is no compile-time or runtime mechanism that enforces the invariant.

Solution:
Introduce a thin `prompt-assembly` (or middleware) layer that every client funnels through before sending a request. This layer unconditionally prepends `currentDateLine()` to the prompt, so the policy "every model call carries the current date" is enforced by code structure rather than by each client remembering to call the helper. Clients become pure transport (auth, HTTP, streaming) and no longer carry prompt-assembly responsibilities.

Benefits:
Adding a new client type cannot accidentally omit the date line because the assembly step is structural, not optional. The "where is the date line needed" knowledge is centralized in one module instead of being scattered across N client files. Reviewers can verify the invariant by inspecting a single call site rather than auditing every client implementation.

### AC-147 · Draft-truncation guard hard-coupled to a specific markdown layout with no shared contract
Strength: Speculative
Files: src/draft-truncation-guard.js, src/local-draft.js

Problem:
`src/draft-truncation-guard.js` detects truncation by checking for unclosed markdown tables and code fences—patterns that are specific to the "PLAN table" and "IMPLEMENT section" conventions emitted by `local-draft.js`. The two files have no direct import relationship or shared type/constant that ties them together; the guard simply assumes the draft will contain those particular structures. If the draft format evolves (a new section type, a different table style, a non-markdown output mode), the guard will either miss real truncation (false negative) or flag complete drafts as truncated (false positive), and nothing in the codebase signals that the two modules must be updated together.

Solution:
Make the set of "expected structural markers" (table delimiters, fence characters, section headings) a shared constant or small configuration object that both `local-draft.js` (as the producer) and `draft-truncation-guard.js` (as the consumer) import. This creates an explicit dependency edge: changing the draft format in one file forces a review of the other because they now reference the same symbol. Alternatively, if the guard's heuristic is deemed sufficient for the foreseeable format, add a co-located comment or a lightweight lint rule that cross-references the two files so a change to one triggers a reminder to audit the other.

Benefits:
The implicit "these two files must stay in sync" contract becomes visible in the dependency graph, reducing the chance that a prompt-format change silently invalidates the truncation heuristic. The guard remains simple and heuristic (avoiding over-engineering), but the coupling is now explicit and discoverable rather than relying on a developer's memory of which files are related.

### AC-148 · Shared protocol-marker inject/extract logic duplicated across two modules
Strength: Strong
Files: src/concepts.js, src/incident-amplification-marker.js

Problem:
Both `src/concepts.js` and `src/incident-amplification-marker.js` independently implement the same "marker protocol" pattern: an idempotent `inject…Instruction` function that checks whether a sentinel string is already present before appending a block of instructions, and an `extract…` function that applies a regex to a model response, cleans up the matched text, and tolerates missing or malformed output. The two implementations are near-identical in structure (idempotency guard → append; regex match → field extraction → error fallback), differing only in the marker string (`CONCEPT-BUILD:` vs `AMPLIFY:`) and the set of expected fields. Because the logic lives in two places, any change to parsing rules—stricter validation, a different delimiter, a new required field—must be made in lockstep across both files, and a missed update in one silently produces divergent behavior.

Solution:
Extract the common inject/extract mechanics into a single utility module (e.g. `src/protocol-markers.js`) that accepts a declarative marker definition—regex pattern, instruction text, list of required fields—and exposes generic `injectMarker(prompt, def)` and `extractMarker(response, def)` functions. `concepts.js` and `incident-amplification-marker.js` become thin configuration wrappers that supply their specific marker definition and delegate to the shared utility, eliminating the duplicated idempotency and parsing logic.

Benefits:
A single code path owns the idempotency check, regex application, field extraction, and error-tolerance behavior, so a change to any of those concerns is made once. New marker-based features can be added by writing a configuration object rather than re-implementing the inject/extract dance. The risk of the two modules drifting apart after a parsing-rule change is removed, and the shared module is straightforward to unit-test in isolation with `node:test`.

### AC-149 · Current-date-line injection enforced by convention rather than by a shared call path
Strength: Worth exploring
Files: src/current-date-line.js, src/claude-client.js, src/local-client.js

Problem:
`src/current-date-line.js` is a single-purpose string provider whose sole consumer contract is "prepend this to every prompt before it reaches a model client." The header comment identifies `claude-client.js` and `local-client.js` as "the two real choke points," but the module itself has no awareness of those call sites. The coupling is purely conventional: a developer adding a new client (e.g. an OpenAI or Anthropic fallback) must remember to call `currentDateLine()` and splice it into the prompt, or the "single source of truth for the model's date context" guarantee silently breaks for that path. There is no compile-time or runtime mechanism that enforces the invariant.

Solution:
Introduce a thin `prompt-assembly` (or middleware) layer that every client funnels through before sending a request. This layer unconditionally prepends `currentDateLine()` to the prompt, so the policy "every model call carries the current date" is enforced by code structure rather than by each client remembering to call the helper. Clients become pure transport (auth, HTTP, streaming) and no longer carry prompt-assembly responsibilities.

Benefits:
Adding a new client type cannot accidentally omit the date line because the assembly step is structural, not optional. The "where is the date line needed" knowledge is centralized in one module instead of being scattered across N client files. Reviewers can verify the invariant by inspecting a single call site rather than auditing every client implementation.

### AC-150 · Draft-truncation guard hard-coupled to a specific markdown layout with no shared contract
Strength: Speculative
Files: src/draft-truncation-guard.js, src/local-draft.js

Problem:
`src/draft-truncation-guard.js` detects truncation by checking for unclosed markdown tables and code fences—patterns that are specific to the "PLAN table" and "IMPLEMENT section" conventions emitted by `local-draft.js`. The two files have no direct import relationship or shared type/constant that ties them together; the guard simply assumes the draft will contain those particular structures. If the draft format evolves (a new section type, a different table style, a non-markdown output mode), the guard will either miss real truncation (false negative) or flag complete drafts as truncated (false positive), and nothing in the codebase signals that the two modules must be updated together.

Solution:
Make the set of "expected structural markers" (table delimiters, fence characters, section headings) a shared constant or small configuration object that both `local-draft.js` (as the producer) and `draft-truncation-guard.js` (as the consumer) import. This creates an explicit dependency edge: changing the draft format in one file forces a review of the other because they now reference the same symbol. Alternatively, if the guard's heuristic is deemed sufficient for the foreseeable format, add a co-located comment or a lightweight lint rule that cross-references the two files so a change to one triggers a reminder to audit the other.

Benefits:
The implicit "these two files must stay in sync" contract becomes visible in the dependency graph, reducing the chance that a prompt-format change silently invalidates the truncation heuristic. The guard remains simple and heuristic (avoiding over-engineering), but the coupling is now explicit and discoverable rather than relying on a developer's memory of which files are related.

### AC-151 · Consolidate duplicated Git execution and environment configuration in stacked-grounding
Strength: Strong
Files: src/stacked-grounding.js

Problem:
The module defines a local `runGit` helper alongside `GIT_ENV` and `GIT_TIMEOUT_MS` constants, yet `resolveAtRef` bypasses this helper and calls `execFileSync` directly with the same environment and timeout settings. This creates a tight coupling to the local configuration values and duplicates the execution logic, meaning any future change to the environment (e.g., adding a new `GIT_*` variable) or timeout policy must be applied in two places within the same file, increasing the risk of configuration drift.

Solution:
Refactor `resolveAtRef` to call the existing `runGit` helper instead of invoking `execFileSync` directly. The helper already encapsulates the environment variables (including `GIT_TERMINAL_PROMPT: '0'`) and the timeout, so `resolveAtRef` simply passes its command arguments through the same code path as every other Git interaction in the module.

Benefits:
All Git interactions within the module share a single execution path, so environment and timeout configuration lives in exactly one place. This eliminates the risk that a future change to `GIT_ENV` or `GIT_TIMEOUT_MS` is applied to the helper but missed in `resolveAtRef`, and it makes the module's Git interaction surface easier to audit and test.

### AC-152 · Remove redundant side-effect require in apply-core
Strength: Strong
Files: src/lib/apply-core.js, src/prompts.js, src/task-sources.js

Problem:
`apply-core.js` includes a bare `require('../task-sources.js')` as a side-effect import, but none of the functions it exports (`writeArtifact`, `applyCandidateSplit`, etc.) reference any symbols from `task-sources.js`. The consuming module `src/prompts.js` already loads `task-sources.js` directly, so this edge in the dependency graph is a leftover from a prior refactoring and serves no functional purpose.

Solution:
Delete the `require('../task-sources.js')` line from `apply-core.js`. No other code in the module depends on the side effect, and the module that actually needs `task-sources.js` (`src/prompts.js`) already imports it.

Benefits:
The module dependency graph loses a spurious edge, eliminating a potential circular-require hazard if `task-sources.js` ever comes to import from `apply-core.js`. It also makes the true dependency surface of `apply-core.js` explicit and easier to reason about during future refactors.

### AC-153 · Standardize Git ref resolution strategy in stacked-grounding
Strength: Worth exploring
Files: src/stacked-grounding.js

Problem:
Within the same module, `resolveGroundingRef` uses `createRealGitRunner` to check branch existence, while `readFileAtRef`, `grepAtRef`, and `resolveAtRef` interact with Git via direct `execFileSync` calls using `origin/${ref}`. This represents two distinct mechanisms for Git interaction coexisting in one file, which complicates reasoning about which commands are covered by the runner's error handling and which are not.

Solution:
Evaluate whether `createRealGitRunner` can be extended to cover `git show` and `git grep` invocations, or whether a thin internal wrapper (beyond the existing `runGit` helper) should be introduced so that all Git interactions in the module follow a single strategy for ref resolution, error handling, and environment setup.

Benefits:
A single, consistent Git interaction strategy within the module reduces cognitive overhead when reading or modifying the code, ensures uniform error handling across all Git calls, and makes it straightforward to add cross-cutting concerns (logging, retry logic, or environment overrides) in one place rather than patching each call site individually.

### AC-154 · Finding-identity contract split across side-finding.js and text-similarity.js
Strength: Worth exploring
Files: src/side-finding.js, src/text-similarity.js, src/side-finding-sweep.js

Problem:
Two modules independently encode "what counts as the same finding" with no shared definition of the comparison unit. `side-finding.js` dedups within a single response by exact lowercased title (`seenTitles` in `extractSideFindings`), treating identical titles with different bodies as one finding. `text-similarity.js` provides `jaccardSimilarity` and `sharesDistinctivePhrase` for the cross-response dedup that `side-finding-sweep.js` performs, treating different titles with a shared distinctive phrase as one finding. Both solve "is this finding already known?" at different granularities, but neither file states that the title is the canonical identity token and the phrase/Jaccard signals are secondary disambiguators. The only thread connecting them is the `conceptId` data field, which is a scope key, not a shared predicate. If the title convention changes (e.g. the model starts emitting a severity prefix or timestamp in the title), the within-response dedup in `side-finding.js` shifts silently while `text-similarity.js`'s consumers are unaffected, and vice versa. A reader of either file has no signal that the other module's output is being compared against a key built by the first.

Solution:
Introduce a single, named notion of "finding identity" shared by both dedup layers. Concretely: extract a small helper (or a documented contract block in both files) that states the canonical comparison key is the lowercased title, and that `text-similarity.js`'s phrase/Jaccard signals are applied only as a secondary disambiguator when titles do not already match. Both `extractSideFindings` in `side-finding.js` and the sweep's dedup in `side-finding-sweep.js` would call the same normalization function to produce the comparison key, making the two dedup layers explicitly ordered (exact-title first, fuzzy second) rather than two independent, coincidentally-complementary heuristics.

Benefits:
A future change to the title convention (prefix, suffix, case, length) is a single-point edit that both dedup paths pick up automatically, eliminating the silent-divergence risk. A reader of either file immediately sees the shared identity contract and the ordering of the two dedup layers. The `conceptId` scoping field and the fuzzy-similarity signals retain their roles, but their relationship to the primary identity key becomes explicit rather than implicit.

### AC-155 · Pipeline-internal directory skip-list is enforced by two files that do not reference each other
Strength: Speculative
Files: src/grep-codebase-tool.js, src/side-finding.js, src/lib/archived-dirs.js

Problem:
`grep-codebase-tool.js` defines `GREP_SKIP_DIRS` (which includes `queue`) and separately calls `isArchivedDirName` from `lib/archived-dirs.js`. `side-finding.js` writes its inbox into `queue/side-findings-inbox/`. The invariant "pipeline-internal state directories are not searchable" is therefore enforced by two files that do not know about each other: the inbox lives inside a skipped directory purely because two independently-chosen string literals happen to agree on `queue`. If `side-finding.js` were moved to a top-level `side-findings/` directory (a plausible refactor given the inbox is a first-class concept with its own sweep module), it would silently become greppable and start polluting plan-grounding hits with the pipeline's own side-finding JSON files. Conversely, renaming or removing the `queue` entry from `GREP_SKIP_DIRS` would break the invariant with no compile-time, test-time, or documentation signal, because the coupling is purely lexical.

Solution:
Extract the "pipeline-internal, non-searchable directory" policy into a single shared constant, likely alongside `isArchivedDirName` in `lib/archived-dirs.js` or in a new `lib/pipeline-dirs.js`. Both `grep-codebase-tool.js`'s `GREP_SKIP_DIRS` and `side-finding.js`'s inbox-root derivation would reference this shared constant. A short comment on the constant states the invariant: "directories listed here hold pipeline state and must not appear in codebase-search results."

Benefits:
The "the inbox lives in a skipped dir" invariant becomes explicit and shared rather than coincidental. A future move of the inbox or a rename of a skip-list entry is a single-point change that both modules pick up. A reader of either file can trace the skip policy to one source of truth instead of inferring it from a string literal in a different module.

### AC-156 · Registry hardcodes scope logic, creating a hidden coupling to `source-scope.js` internals
Strength: Strong
Files: src/task-source-registry.js, src/lib/source-scope.js

Problem:
`task-source-registry.js` (`registerTaskSource`) directly requires `lib/source-scope.js` and hardcodes the string `'core'` to decide when to wrap the `next` function. This creates a hidden coupling: the registry must know the internal API of `source-scope.js` (specifically `sourceEligibleHere`) and the specific scope value `'core'` in order to enforce eligibility. A registration function is expected to be a thin, scope-agnostic store; instead it carries scope-specific branching logic. If the scope model evolves (a new `'local'` scope, a change in how `sourceEligibleHere` resolves, a rename of the exported function), the registry must be updated in lockstep, and the coupling is invisible to anyone reading the registry in isolation because the dependency is a direct `require` rather than a documented interface.

Solution:
Move the scope-guarding responsibility into `lib/source-scope.js` itself. Export a function such as `applyScopeGuards(config)` (or a more granular `wrapNextWithScopeCheck(next, scope)`) that encapsulates the eligibility check and the closure wiring. The registry then calls that exported helper—e.g. `config = { ...config, next: wrapNextWithScopeCheck(config.next, config.scope) }`—without importing `sourceEligibleHere` directly or hardcoding the `'core'` string. The helper returns a new function (or a new config object), consistent with the existing spread-based pattern already in the registry, so the caller's original object is never touched. The registry becomes a thin, scope-agnostic store, and all scope-specific logic lives in one module.

Benefits:
The registry no longer needs to know which scopes exist, how eligibility is computed, or which internal function of `source-scope.js` to call. Adding or modifying a scope requires touching only `lib/source-scope.js`, and the registry's `require` list shrinks to the helper's public API. The control flow is easier to trace: a reader of the registry sees a single opaque call rather than an inline scope branch, and a reader of `source-scope.js` sees the full eligibility logic in one place. Testing simplifies because the scope-guarding logic can be unit-tested in isolation without standing up the registry.

### AC-157 · Scope-eligibility check enforced redundantly at registration and at claim time
Strength: Worth exploring
Files: src/task-source-registry.js, src/lib/source-scope.js

Problem:
`lib/source-scope.js` exports `sourceEligibleHere` and its own comment states the check is "Enforced at generation (getNextTask) AND claim (next-claimable-task)." Meanwhile, `task-source-registry.js` already wraps `next` at registration time so that the generation path is guarded. This means the same eligibility predicate is evaluated in at least two places for the same task, and a developer reading either site in isolation cannot tell which one is authoritative. If one site is updated (e.g., a new scope condition is added) and the other is missed, the two checks silently disagree, producing tasks that pass one gate but fail the other—or vice versa—with no obvious error.

Solution:
Choose a single enforcement point and remove the other. If the registry wrapper is sufficient (i.e., every task that enters the system passes through `registerTaskSource`), drop the claim-time re-check and document that registration-time guarding is the sole gate. If the claim-time check is necessary for tasks registered before a scope was set or for tasks injected through a path that bypasses the registry, remove the registry wrapper and make the claim-time check the documented, sole enforcement point. In either case, add a brief comment at the chosen site stating that it is the only place eligibility is enforced, so future readers do not add a second check.

Benefits:
Eliminating the duplicate check removes a whole category of "which check is the real one?" confusion and prevents the two sites from drifting out of sync. Control flow becomes linear and easier to reason about: a task is either eligible or it is not, determined in exactly one place. Testing simplifies because there is one code path to exercise rather than two that must be kept in agreement.

### AC-158 · Registry hard-requires scope-resolution, breaking its "passive store" contract
Strength: Strong
Files: src/task-source-registry.js, src/lib/source-scope.js, src/config.js

Problem:
`registerTaskSource` in `src/task-source-registry.js` directly `require`s `src/lib/source-scope.js` in order to wrap the `next()` function for sources declared with `scope: 'core'`. That module in turn `require`s `src/config.js` (via `activeRepoIsCore`), and `src/config.js` is a central hub pulled in by nearly every other module in the codebase. The registry's stated contract is a "plain object keyed by source name" with "no validation," yet by injecting scope-gating logic at registration time it becomes an active participant in business-logic enforcement that depends on the runtime environment. This makes the registry impossible to unit-test in isolation (any test must stub `source-scope.js` or `config.js`) and introduces a latent circular-dependency risk: if `config.js` or any of its transitive dependencies ever need to `require` the registry, the load graph breaks.

Solution:
Remove the `require` of `src/lib/source-scope.js` from `registerTaskSource`. The registry should store the raw `next` function and the source's declared scope as plain metadata, with no gating logic applied at registration time.

Introduce a single choke-point retrieval function—e.g. `invokeSource(name, …args)`—in a dedicated module (or in the execution layer) that **every** caller must use to obtain and invoke a source's `next()`. This function applies the `sourceEligibleHere` scope check before delegating to the stored function and returns `null` when the source is not eligible in the current environment. Crucially, this covers **all** invocation paths: `getNextTask` in the priority ladder, the always-run watchdog sweeps that call a source directly, and any future caller. The existing code comment in `task-source-registry.js`—"Wrap next() so that EVERY caller -- getNextTask, the always-run watchdog sweeps that call a source directly -- gets null on any other project"—confirms that the design intent is to gate at the *invocation* boundary, not at registration. Moving the gate to a shared `invokeSource` choke point preserves that guarantee while decoupling the registry from the scope/config dependency chain.

Callers that currently destructure `registry[name].next` and call it directly are refactored to call `invokeSource(name, …)` instead. Because the choke point is a single function, there is exactly one place to reason about scope eligibility, and no caller can bypass it without going through a code path that is itself a bug (and easily caught by a lint rule or integration test that asserts no direct `.next` access on registry entries).

Benefits:
The registry becomes a true passive store that can be tested with zero external stubs. The hidden load-time dependency chain (registry → scope → config → everything) is eliminated, removing the circular-dependency risk. Scope-gating logic lives in one choke-point function that covers every invocation path—including the direct watchdog sweeps—so no caller can accidentally invoke a core-scoped source on a non-core project. New task sources can be registered in tests and integration harnesses without pulling in the full configuration stack.

### AC-159 · Source identity is split-brain between plugin stamping and registry resolution
Strength: Worth exploring
Files: src/task-source-registry.js, src/sdk/candidate-fulfillment.js, source plugin modules (e.g. arch_review, arch_import_review)

Problem:
The "source" string that identifies a task's origin is managed in two disconnected places. The **source plugin code** (e.g. the `arch_review` and `arch_import_review` modules) is responsible for *stamping* the `source` field when creating a task via the shared SDK utility `nextCandidateFulfillmentTask` in `src/sdk/candidate-fulfillment.js`. The SDK is a generic parameterized helper—it receives the source name as an argument from the calling plugin and does not itself decide which string to use. Meanwhile, `src/task-source-registry.js` defines `resolveSourceName(task)` to *resolve* that stamped string back to a registry key, including special-case aliases like `'manual'` → `'adhoc'` and `'deadcode_triage'` → `'unused_export'`. There is no single source of truth: adding a new task source requires the plugin to stamp a string *and* the registry to have a matching entry (or alias) for that string. A mismatch in either direction—stamping a string the registry doesn't resolve, or registering a key no plugin ever stamps—produces a silently dead source with no compile-time or test-time signal.

Solution:
Make the **source plugin** the single owner of its identity string. When a plugin registers itself via `registerTaskSource`, it passes its canonical name (e.g. `'arch_review'`) as the registry key. The same canonical name is the string the plugin stamps on tasks it creates (passed as the `source` parameter to `nextCandidateFulfillmentTask`). The registry's `resolveSourceName` is reduced to a thin backward-compatibility shim that maps a small, frozen set of legacy strings (e.g. `'manual'` → `'adhoc'`, `'deadcode_triage'` → `'unused_export'`) to their current canonical names; no new aliases are added. A lightweight assertion (run at registration time or in a startup test) verifies that every registered key is a string some plugin actually stamps, and conversely that every stamped string in the codebase resolves to a registered key—closing the "registered but never stamped" / "stamped but never registered" gap at test time rather than leaving it to production.

The SDK utility (`nextCandidateFulfillmentTask`) remains a generic, source-agnostic helper. It does not query the registry or own identity logic; it simply forwards whatever `source` string the calling plugin provides.

Benefits:
Adding a new task source is a single-step operation: the plugin declares its canonical name once, uses that same name for both registration and stamping, and the registry key and the stamped string are in sync by construction. The alias table in the registry shrinks to a frozen backward-compatibility shim for pre-existing task strings, rather than a parallel identity system that must be kept in lockstep with plugin code. The SDK remains a simple, testable utility with no knowledge of the registry or of source identity.

NOTE: Flag 2 was applied — the AC-002 solution was rewritten to attribute identity ownership to the source plugin (not the SDK) and to treat the SDK as a generic parameterized utility, removing the incorrect "SDK queries the registry for the stamp" proposal. Flag 3 was applied — the AC-001 solution was rewritten to introduce a single `invokeSource` choke-point function that covers all callers (including direct watchdog sweeps), rather than naively moving the check to `getNextTask` alone.

### AC-160 · Dead require of task-sources.js in apply-core.js
Strength: Strong
Files: src/lib/apply-core.js, src/task-sources.js

Problem:
`apply-core.js` contains a bare, unassigned side-effect require of `task-sources.js` at the top of the file. None of the functions in `apply-core.js`—`coAuthorTrailer`, `usesGroupB`, `applyCandidateSplit`, `writeArtifact`, or any other—reference a symbol imported from `task-sources.js`. This is the same class of dead require already identified in AC-85 and AC-86 for `prompt-assembly.js` and `prompt-blocks.js`. It adds a needless edge to the module dependency graph, introduces a small circular-require risk if `task-sources.js` (transitively) imports back into `apply-core.js`, and misleads readers into believing a functional dependency exists.

Solution:
Remove the `require('../task-sources.js');` line from `apply-core.js`. If a side-effect import is genuinely required (e.g., `task-sources.js` registers a global on load), document that intent with a comment and move the require to the entry point that actually depends on the side effect, rather than burying it in an unrelated module.

Benefits:
The module graph loses a spurious edge, reducing circular-require risk and making the true dependency surface of `apply-core.js` accurate. It aligns the codebase with the cleanup already performed in AC-85 and AC-86, and removes a source of confusion for anyone auditing imports or performing tree-shaking / bundle analysis.

### AC-161 · Remove redundant side-effect require of task-sources.js in apply-core.js
Strength: Strong
Files: src/lib/apply-core.js, src/apply-task.js

Problem:
`src/lib/apply-core.js` contains a bare, unassigned side-effect require of `task-sources.js` near the top of the file. No symbol from that module is destructured, assigned, or referenced anywhere in the file's exported functions (`coAuthorTrailer`, `usesGroupB`, `applyCandidateSplit`, `writeArtifact`, `closeOriginatingBrainDumpEntry`, `assertStageableFiles`). The module was extracted from `src/apply-task.js` (as noted in its header comment), and the caller `src/apply-task.js` already loads `task-sources.js` directly. The dead require therefore adds a needless edge to the module dependency graph and introduces a small circular-require risk for zero functional benefit.

Solution:
Delete the single `require('../task-sources.js');` line (and the one blank line immediately preceding it, to avoid leaving a double blank between the header comment and the first function definition). No other line in the file is touched: the `'use strict'` directive, the header comment, all function bodies, and the `module.exports` block remain byte-identical.

Benefits:
Removes a redundant module-load edge from the dependency graph, eliminates a potential circular-require path, and makes the file's actual dependencies explicit. There is zero behavioural change because none of the exported functions reference any symbol from `task-sources.js`.

### AC-162 · `ollama_client.generate()` sends `null` model when `LOCAL_MODEL` is unset
Strength: Worth exploring
Files: python/dashboard/ollama_client.py

Problem:
`MODEL = os.environ.get("LOCAL_MODEL")` is read once at import time with no fallback. The module's own header comment states the intent: an unset `LOCAL_MODEL` should surface as a real Ollama "model not found" error rather than a guessed name. However, the current implementation sends `"model": null` in the request body. While Ollama correctly rejects this with a `400 Bad Request` (e.g., "model is required"), this failure mode is suboptimal for two reasons:
1. **Latency/Network Dependency:** The error is only discovered after a network round-trip to the Ollama server. If the server is down, unreachable, or slow, the operator receives a connection error or timeout instead of the specific configuration error.
2. **Clarity:** A local `RuntimeError` explicitly naming the missing `LOCAL_MODEL` environment variable is more actionable and self-explanatory than a generic HTTP 400 response from a remote service.

Because `MODEL` is captured at import time, a process that starts before the env var is set keeps sending `null` for its entire lifetime. The current behavior is not "silent" (Ollama does not fall back to a default model), but it is an indirect failure that relies on external service behavior to report a local configuration error.

Solution:
In `generate()`, before building the request body, check `if MODEL is None` and raise a `RuntimeError` (or a small dedicated exception) whose message names the missing `LOCAL_MODEL` environment variable. This makes the failure happen at the client boundary, is deterministic, and matches the module's own documented intent. No change to the request path when `MODEL` is set.

Benefits:
Converts a network-dependent configuration error into an immediate, self-explanatory local error; eliminates the need for a network round-trip to detect a missing environment variable; and makes the "no hardcoded fallback" design actually hold at runtime rather than only in a comment.

### AC-163 · `test_client_timeout_handling.py` mutates `sys.path` to import its subjects
Strength: Worth exploring
Files: python/dashboard/test_client_timeout_handling.py

Problem:
The test executes `sys.path.insert(0, str(Path(__file__).parent))` and then imports `claude_client` and `local_tool_client` as top-level modules. This mutates global interpreter state as a side effect of importing the test module. The primary concern is not shadowing (since inserting at index 0 correctly prioritizes the local directory), but rather **global state pollution**. The mutation persists for the rest of the interpreter session, so any other test or module loaded afterward in the same process inherits the altered path. This can lead to subtle import resolution issues in other parts of the test suite if they rely on standard package resolution or if the local directory contains modules with names that conflict with installed packages.

The header comment notes this matches a zero-extra-dependency stdlib-unittest convention, but that is an argument for consistency, not for the pattern being sound in a larger test suite.

Solution:
Use `importlib.util.spec_from_file_location` to load the modules directly from their file paths without modifying `sys.path`. This approach is isolated to the specific test module and does not pollute the global interpreter state. For example:
```python
import importlib.util
from pathlib import Path

def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

claude_client = load_module("claude_client", Path(__file__).parent / "claude_client.py")
local_tool_client = load_module("local_tool_client", Path(__file__).parent / "local_tool_client.py")
```
This removes the `sys.path` mutation entirely while maintaining the ability to import local modules without requiring a full package structure.

Benefits:
Removes global `sys.path` mutation from the test process, eliminates the risk of path pollution affecting other tests, and makes the test's dependency on the modules under test explicit and isolated.

NOTE: The critique regarding AC-002's "shadowing" claim was valid and addressed by reframing the problem as global state pollution rather than shadowing, and by proposing a more robust solution using `importlib` instead of package imports. The critique regarding AC-001's "silent fallback" claim was valid and addressed by correcting the problem statement to reflect that Ollama returns a clear error, but the local error is still preferable for latency and clarity reasons.

### AC-164 · Inconsistent error-handling contract between resolveAtRef and grepAtRef
Strength: Strong
Files: src/stacked-grounding.js

Problem:
The `resolveAtRef` function swallows all `execFileSync` exceptions and returns `null`, treating a genuine git infrastructure failure (network timeout, corrupted object database, missing git binary) identically to a legitimate "path not found" result. Its sibling `grepAtRef` in the same file explicitly distinguishes between a "no match" exit code (1) and a real failure (exit code > 1), re-throwing the latter. Because `resolveAtRef` is used to validate target files for stacked tasks, a transient git error causes the system to falsely report a real file as "absent," leading to a valid task being blocked or rejected as a "fabricated path" rather than surfacing the underlying infrastructure failure to the operator.

Solution:
Align `resolveAtRef` with the error-handling contract already established by `grepAtRef`: catch the `execFileSync` exception, inspect the exit code, and re-throw (or throw a typed error) when the exit code indicates a genuine failure rather than a simple "not found" result. Only return `null` when the exit code specifically means the path does not exist at the given ref.

Benefits:
Operators and downstream task-validation logic can distinguish between "the file truly isn't there" and "git itself failed," preventing valid tasks from being silently rejected as fabricated. It also makes the module's error contract internally consistent, reducing the cognitive load on anyone reading or extending `stacked-grounding.js`.

### AC-165 · Dead require of task-sources.js in apply-core.js
Strength: Worth exploring
Files: src/lib/apply-core.js, src/task-sources.js, src/apply-task.js

Problem:
`apply-core.js` contains a bare, unassigned side-effect require of `../task-sources.js`. No symbol from `task-sources.js` is destructured, assigned, or referenced anywhere in `apply-core.js`; the functions in `task-sources.js` (`writeArtifact`, `applyCandidateSplit`, and others) operate purely on their arguments and other imported modules. The caller, `src/apply-task.js`, already loads `./task-sources.js` directly. The dead require adds a needless edge to the module graph and introduces a small circular-require risk for no functional benefit.

Solution:
Remove the bare `require('../task-sources.js')` line from `apply-core.js`. Since no binding from that module is used and the caller already loads it, the require is pure dead weight.

Benefits:
The module graph becomes smaller and more honest—every edge reflects a real dependency. It eliminates a potential circular-require hazard and makes it easier for a reader (or a bundler) to understand the true dependency surface of `apply-core.js`.

### AC-166 · Unify Marker Extraction and Injection Logic
Strength: Strong
Files: src/incident-amplification-marker.js, src/concepts.js

Problem:
Both `src/incident-amplification-marker.js` and `src/concepts.js` implement the same "find marker, extract payload, strip from text" pattern independently. Each file checks for marker idempotency (`if (base.includes('MARKER:')) return base;`), splits the response text on a marker string, parses the payload with regex-based key-value extraction, and returns a `{ cleanText, ... }` object. The `concepts.js` variant (`extractConceptBuildReport`) is a simplified single-marker version, while `incident-amplification-marker.js` handles multiple instances and more complex block structures. Because the logic is duplicated rather than shared, any change to marker format, whitespace handling, or delimiter conventions must be made in two places, and the two implementations can drift apart in how they handle edge cases such as multiple marker lines or malformed blocks.

Solution:
Extract a shared `extractMarkerBlock(text, markerRegex, parserFn)` utility (or a small `MarkerExtractor` class) that encapsulates the idempotency guard, text splitting, payload parsing, and clean-text reconstruction. Both `concepts.js` and `incident-amplification-marker.js` would delegate their extraction and injection logic to this single utility, passing in their specific marker regex and a parser callback. The utility would standardize behavior for multiple markers, malformed blocks, and whitespace variations, so both call sites inherit identical edge-case handling.

Benefits:
A single code path owns the marker protocol, so a format change (new delimiter, stricter whitespace, additional fields) is made in one place and both consumers pick it up automatically. The risk of the two implementations diverging—where `concepts.js` silently mishandles a multi-line payload that `incident-amplification-marker.js` handles correctly—is eliminated. Testing the extraction logic once in the shared utility covers both call sites, reducing the test surface and the chance of a regression in one file going unnoticed because the other file's tests mask it.

### AC-167 · Decouple `getConceptTimeline` from Hardcoded Filesystem Paths
Strength: Worth exploring
Files: src/concepts.js

Problem:
`getConceptTimeline` in `src/concepts.js` accepts `loadBrainDump` and `listTaskHistory` as optional function parameters, which suggests a dependency-injection design. However, the function also internally constructs a path via `path.join(pipelineDir, 'brain-dump.json')` and passes that concrete path to the loader. This means the module still encodes a specific storage location and filename, violating the Dependency Inversion Principle: `concepts.js` should depend only on an abstract "give me brain-dump entries" contract, not on where the file lives. Testing the function with a different data source (in-memory array, database row, alternate filename) requires either mocking `path.join` or the filesystem, or passing a loader that happens to read from the exact path the function constructs, which is a hidden coupling.

Solution:
Refactor `getConceptTimeline` to accept either a pre-loaded `brainDumpEntries` array or a `getBrainDumpEntries(conceptId)` callback that the caller fully controls. Remove the internal `path.join(pipelineDir, 'brain-dump.json')` call entirely. The caller (dashboard, API layer, CLI) resolves the storage location, loads the data, and passes only the relevant entries into `concepts.js`. This makes `concepts.js` a pure logic module that operates on data structures rather than file paths.

Benefits:
`concepts.js` becomes trivially testable: pass an in-memory array, no filesystem mocking required. Migrating brain-dump storage to a database, a different filename, or a remote service is a caller-side change with zero edits to `concepts.js`. The module's public contract becomes explicit and honest—its parameters describe exactly what it needs—rather than implying decoupling while secretly depending on a specific path layout.

### AC-168 · Centralize Stable-Status Guard Across Concept Mutators
Strength: Strong
Files: src/concepts.js

Problem:
`src/concepts.js` defines `STABLE_CONCEPT_STATUSES` and then manually repeats the guard `if (!concept || STABLE_CONCEPT_STATUSES.has(concept.status)) return null;` at the top of `recordConceptResearch`, `recordConceptBuildTally`, `shelveConcept`, and `reopenConcept`. This is a classic shotgun-surgery risk: adding a new mutator (e.g., `updateConceptDescription`, `reassignConceptOwner`) requires the developer to remember to insert the same guard. If they forget, a stable concept can be silently mutated, violating the invariant that stable states are terminal. The invariant is scattered across N call sites rather than enforced by a single mechanism, increasing cognitive load and the probability of an oversight.

Solution:
Introduce a `guardStableStatus(concept)` helper that throws a descriptive error (or returns a sentinel) when the concept is in a stable state. Every mutator calls this guard as its first statement. Alternatively, wrap concept mutation in a class method or a Proxy that intercepts property writes and rejects them when `status ∈ STABLE_CONCEPT_STATUSES`, making it structurally impossible for any current or future mutator to bypass the check. The key is that the invariant lives in one place and is enforced by the mechanism, not by developer memory.

Benefits:
Adding a new mutator no longer requires remembering to add the guard—the guard is either a mandatory first call or is enforced by the wrapper itself. Code review becomes simpler: reviewers check that the mutator calls `guardStableStatus` (or that the wrapper handles it) rather than scanning for a hand-rolled `if` that might be subtly different. The invariant "stable concepts are terminal" is stated once, in one function, and is impossible to accidentally weaken by editing one of several scattered copies.

### AC-169 · ~~Duplicated priority-resolution logic across registry and priority modules~~ — **RETRACTED**
Strength: ~~Strong~~ → **Invalid**
Files: src/task-source-registry.js, src/lib/task-priority.js

**Retraction:**
The original draft mischaracterized the relationship between these two modules. They do **not** implement the same resolution pattern, and there is no duplicated logic to consolidate.

- `task-source-registry.js` → `getRegisteredSources` reads the `priority` value **stored in each registry entry** (set at `registerTaskSource` call time) and uses it solely for **sorting the list** of registered sources (`a.priority ?? Infinity`). It never consults `getConfig().taskPriorityOverrides`.
- `task-priority.js` → `taskPriority` is a **config-lookup helper** that returns `getConfig().taskPriorityOverrides[name] ?? def`, where `def` is a caller-supplied default. It never reads from the registry.

These are complementary mechanisms with different inputs (registry entry vs. config object) and different purposes (list-sorting key vs. single-value resolution). They are not competing implementations of the same function, and the "divergence" the draft described is simply the intended design: the registry holds a base priority for ordering, while config overrides allow per-context or per-environment adjustment for consumers that explicitly opt in.

**No code change is warranted.** The proposed `resolvePriority(sourceName, registeredEntry)` utility would conflate two unrelated data sources, break `taskPriority`'s general-purpose contract (it is not registry-specific), and introduce a coupling that does not exist today.

NOTE: All three flags were applied; the entire finding was retracted because the core premise (duplicated logic / two sources of truth) was factually incorrect per the critique's code-level analysis.

### AC-170 · Extract shared destination-path and mkdir logic in done-archive
Strength: Strong
Files: src/done-archive.js

Problem:
Both `archiveDoneTasks` and `archiveSpecificDoneTasks` independently construct the archive destination directory path via `path.join(doneDir, ARCHIVE_DIRNAME, monthBucket(new Date(now)))` and manage a `destDirEnsured` flag to call `fs.mkdirSync(destDir, { recursive: true })`. The header comment on `archiveSpecificDoneTasks` states the two functions are intended to produce indistinguishable output for downstream consumers, yet the shared "resolve destination and ensure it exists" logic is duplicated rather than centralized. If the bucketing scheme, directory naming, or creation strategy changes, a developer must remember to update both call sites, creating a realistic risk that the two paths silently diverge.

Solution:
Extract the destination-path construction and directory-ensuring logic into a single internal helper (e.g., `resolveArchiveDest(doneDir, now)`) that returns the resolved `destDir` and guarantees it exists. Both `archiveDoneTasks` and `archiveSpecificDoneTasks` then call this helper once, eliminating the duplicated `path.join` / `monthBucket` / `mkdirSync` sequence and the per-function `destDirEnsured` bookkeeping.

Benefits:
A single source of truth for the archive destination means any future change to bucketing granularity, directory naming, or filesystem-creation strategy is made in exactly one place. The two public functions become thinner and more obviously equivalent, reducing the cognitive load on reviewers and eliminating the class of "I updated one but forgot the other" regressions.

### AC-171 · Redundant side-effect require of task-sources.js in apply-core.js
Strength: Strong
Files: src/lib/apply-core.js

Problem:
`src/lib/apply-core.js` contains a bare, unassigned side-effect require of `../task-sources.js` sitting between the header comment and the first exported function. None of the file's exported functions (`coAuthorTrailer`, `usesGroupB`, `applyCandidateSplit`, `writeArtifact`, `closeOriginatingBrainDumpEntry`, `assertStageableFiles`) reference any symbol originating from `task-sources.js`. The require is redundant because `src/prompts.js`, the primary consumer of these functions, already loads `./task-sources.js` directly. The dead require adds a needless module-graph edge and a small circular-require risk without providing any value to this file.

Solution:
Delete the single line `require('../task-sources.js');` and the one blank line immediately preceding it, so the header comment is followed by a single blank line and then the first function. No other line in the file is touched: the `'use strict'` directive, header comment, all function bodies, and the `module.exports` statement remain byte-identical.

Benefits:
Removes a redundant module-load edge from the dependency graph, eliminates a potential circular-require path, and makes the file's actual dependencies (none beyond built-ins) explicit. Zero behavioural change: every function in the file is a pure function of its arguments and never touches any `task-sources.js` symbol.

### AC-172 · Duplicated marker-inject/extract lifecycle with divergent contracts
Strength: Strong
Files: src/concepts.js, src/incident-amplification-marker.js

Problem:
Both `concepts.js` (via `injectConceptBuildInstruction` / `extractConceptBuildReport`) and `incident-amplification-marker.js` implement the same conceptual responsibility—inject a sentinel instruction into a prompt if not already present, then later parse and strip that marker from the model's response—but each defines its own parsing rules, required fields, scoping (e.g. "first blank line" boundary), and idempotency checks. Because there is no shared "marker protocol" contract, the two implementations can silently drift: one may tolerate multi-block markers while the other expects a single block, one may clean up extra blank lines while the other leaves them, and callers must memorize which module owns which marker. This shallow-interface duplication means a change to the injection or extraction semantics in one module has no enforcement mechanism to keep the other in sync.

Solution:
Extract a shared "marker protocol" helper (a small module or a set of pure functions) that encapsulates the inject-if-absent / extract-and-strip lifecycle: a single API that takes a marker template, a list of required fields, a scoping rule (e.g. "up to first blank line"), and a cleanup policy. Both `concepts.js` and `incident-amplification-marker.js` would then delegate to this shared helper, passing their specific marker strings and field requirements as configuration. The two modules retain their domain-specific naming and any domain-specific validation, but the mechanical inject/parse/strip/idempotency logic lives in one place.

Benefits:
A single source of truth for the inject/extract lifecycle eliminates the risk of divergent idempotency or cleanup behavior between the two markers. Adding a third marker in the future becomes a configuration change rather than a copy-paste of parsing logic. Callers no longer need to know which module "owns" which marker's mechanics; they only specify their marker's content and fields. The shared helper is trivially unit-testable in isolation (inject → extract round-trip, idempotency, malformed-input tolerance), which is harder to exercise when the logic is embedded in two larger modules.

### AC-173 · concepts.js bundles registry persistence, state machine, and prompt-marker logic
Strength: Strong
Files: src/concepts.js, src/incident-amplification-marker.js

Problem:
`concepts.js` currently contains at least three distinct responsibilities: file I/O and registry persistence (`loadConcepts`, `writeConcepts`), a lifecycle state machine (`recordConceptResearch`, `recordConceptBuildTally`, `shelveConcept`, `reopenConcept`, `shipConcept`), timeline querying (`getConceptTimeline`), and prompt-marker injection/extraction (`injectConceptBuildInstruction`, `extractConceptBuildReport`). The prompt-marker logic is not conceptually part of the concept registry—it belongs to the "model response protocol" layer that `incident-amplification-marker.js` already represents. Bundling it here forces any caller that only needs lifecycle transitions to load marker-parsing code, and any caller that only needs the marker protocol to load registry I/O code. The two responsibilities have different change drivers (registry schema vs. prompt conventions) and different test surfaces, so coupling them in one module increases the blast radius of changes to either.

Solution:
Move `injectConceptBuildInstruction` and `extractConceptBuildReport` out of `concepts.js` into a dedicated module (e.g. `concept-build-marker.js`) that sits alongside `incident-amplification-marker.js` and, per AC-001, delegates its mechanical inject/extract work to the shared marker-protocol helper. `concepts.js` re-exports the two functions for backward compatibility (or callers are updated to import from the new module). The result is that `concepts.js` contains only registry persistence, state-machine transitions, and timeline queries—its true domain—while the prompt-marker concern is co-located with its sibling marker module.

Benefits:
Each module now has a single, coherent change driver: registry schema changes touch only `concepts.js`; prompt-convention changes touch only the marker modules. The state machine and file I/O in `concepts.js` become easier to reason about and test in isolation (no marker-parsing edge cases to account for). The marker modules form a visible, cohesive group that signals to a reader "this is the model-response-protocol layer," making the architecture self-documenting.

### AC-174 · current-date-line.js is a standalone prompt-augmentation helper outside the marker protocol
Strength: Worth exploring
Files: src/current-date-line.js, src/claude-client.js, src/local-client.js

Problem:
`current-date-line.js` provides a single helper (`currentDateLine`) that is injected at choke points in `claude-client.js` and `local-client.js`. It is conceptually the same kind of concern as the concept-build marker and the amplify marker—prompt augmentation—but it is implemented as a free-standing one-function module with no shared inject/extract lifecycle, no idempotency guard, and no cleanup convention. The codebase thus has at least three separate "prompt augmentation" mechanisms, each with its own (or absent) idempotency, cleanup, and parsing rules. This is not a bug, but the absence of a unifying abstraction means that adding a fourth augmentation (or changing how the date line is injected) requires ad-hoc coordination across modules with no shared contract to enforce consistency.

Solution:
Fold `currentDateLine` into the shared marker-protocol helper introduced in AC-001 (or at minimum, give it the same inject-if-absent / idempotency-guard pattern). The date line would be registered as a "marker" whose template is the date string and whose extraction rule is "strip the line if present." `claude-client.js` and `local-client.js` would call the shared helper rather than the standalone function. This does not require a large refactor—the helper is small—but it brings the date line under the same idempotency and cleanup guarantees as the other two markers.

Benefits:
All three prompt-augmentation mechanisms share one idempotency contract and one cleanup policy, eliminating the risk that the date line is injected twice (or not stripped) while the other markers are handled correctly. A future augmentation (e.g. a system-prompt preamble) can be added by registering a new marker template rather than writing a new standalone module. The choke-point modules (`claude-client.js`, `local-client.js`) gain a single, uniform call site for all prompt augmentations, simplifying their code and making the set of active augmentations visible in one place.

### AC-175 · resolveSourceName hardcodes built-in domain-based routing that the alias extension point cannot express
Strength: Strong
Files: src/task-source-registry.js

Problem:
`resolveSourceName()` contains two hardcoded `if` branches for the package's own built-in sources (`task.domain === 'adhoc' || task.source === 'manual' → 'adhoc'` and `task.domain === 'secondbrain' → 'secondbrain'`), yet the file's header and `registerSourceAlias`'s JSDoc both promise that a plugin "declares its own quirk via `registerSourceAlias()` instead of this file needing to know every consumer's naming." The alias mechanism only maps a `task.source` string to a single registry-name string, so it structurally cannot express the domain-keyed cases that the two built-ins require. The result is a reserved namespace: any plugin whose tasks happen to carry `domain: 'adhoc'` or `source: 'manual'` is silently captured by the hardcoded branch before the alias lookup is ever consulted, with no public API path to override or reassign that mapping. The doc comment further mis-describes the extension point as "wrapping its own call sites" rather than calling `registerSourceAlias`, compounding the confusion for a contributor who reads the header and then discovers the hardcoded branches.

Solution:
Introduce a parallel `domainAliases` map in the same module that follows the identical single-string-key → single-string-value contract as the existing `sourceAliases` map, exposed through a new `registerDomainAlias(domainValue, toName)` function (both arguments are plain strings, mirroring `registerSourceAlias`'s signature). At module initialization, replace the two hardcoded `if` branches with `registerDomainAlias('adhoc', 'adhoc')` and `registerDomainAlias('secondbrain', 'secondbrain')`. Update `resolveSourceName` to check `domainAliases[task.domain]` first, then fall through to the existing `sourceAliases[task.source]` lookup, then to the default. The existing `registerSourceAlias(fromField, toName)` API and its single-string contract are left entirely unchanged; the new function is additive. Finally, correct the header comment and `registerSourceAlias` JSDoc to accurately name `registerSourceAlias` / `registerDomainAlias` as the extension points rather than "wrapping call sites."

Benefits:
The two most important built-in mappings become expressible through the same public extension API that out-of-tree plugins use, eliminating the reserved-namespace collision and the silent mis-routing of plugin tasks that happen to stamp `domain: 'adhoc'` or `source: 'manual'`. The hardcoded `if` branches are deleted, so the file's own documented promise ("no hardcoded `if` for every out-of-tree source's naming quirk") becomes true for the package's own sources as well. The additive `registerDomainAlias` function follows the exact same single-string contract as `registerSourceAlias`, so no existing caller's code changes and the API surface remains predictable. The corrected doc comments remove the misleading "wrapping call sites" language, giving a contributor an accurate mental model of the extension point on first read.

### AC-176 · Module-level singleton hook in task-history creates hidden global state
Strength: Weak (Revised)
Files: src/task-history.js

Problem:
`setHistoryPersistHook` assigns to a module-level `persistHook` variable that `appendHistoryEvent` later invokes. While the code comments describe this as an intentional "opt-in per process" design, this pattern creates a hidden global state dependency. Any two independent pipeline workers (e.g., a local-draft worker and a review-task worker) that load this module in the same Node.js process will silently overwrite each other's hook. The module's behavior therefore depends on the execution order of its callers rather than on explicit, inspectable parameters. This makes concurrency bugs difficult to diagnose and violates the principle of locality, as the dependency is not visible in the function signature of `appendHistoryEvent`.

Solution:
Replace the module-level `persistHook` variable with an explicit parameter. `appendHistoryEvent` should accept a `persist` function (or a small options object containing it) as an argument, and callers should pass their own hook at the call site. If a default no-op is needed for backward compatibility, it can be supplied as a default parameter value, but the dependency becomes visible in the function signature and is no longer shared mutable state. This requires updating existing callers to explicitly pass their persistence strategy, which clarifies the dependency graph.

Benefits:
Each worker owns its persistence strategy explicitly, eliminating the class of race conditions where one worker's hook clobbers another's. The module becomes trivially testable in isolation (pass a spy), and code review can verify the dependency at the call site rather than hunting for a side-effecting `setHistoryPersistHook` call elsewhere in the process. This aligns the implementation with the principle of explicit dependencies, even if it deviates from the original "singleton" design intent.

### AC-177 · Duplicated Git env/timeout constants bypass the shared runner in stacked-grounding
Strength: Strong
Files: src/stacked-grounding.js

Problem:
The header comment in `src/stacked-grounding.js` states that the file reuses `git-runner.js`'s adapter for `resolveGroundingRef` to avoid hand-rolling Git checks. Yet `readFileAtRef`, `grepAtRef`, and `resolveAtRef` each call `execFileSync` directly with locally defined `GIT_ENV` and `GIT_TIMEOUT_MS` constants, bypassing the shared runner entirely. This breaks the "one place to get it right" goal the header promises and means any future change to Git execution standards (a new environment variable, a timeout adjustment, a sandbox flag) must be replicated across three call sites in the same file, increasing the chance of drift.

Solution:
Route `readFileAtRef`, `grepAtRef`, and `resolveAtRef` through the same `git-runner.js` adapter that `resolveGroundingRef` already uses. Remove the local `GIT_ENV` and `GIT_TIMEOUT_MS` definitions from `src/stacked-grounding.js` and let the runner own those constants. If the runner's API does not yet cover the specific sub-commands (`show`, `grep`, `rev-parse`), extend the runner with thin wrappers rather than duplicating the `execFileSync` boilerplate.

Benefits:
Git execution configuration lives in exactly one module, so a single change propagates everywhere. The file's public behavior matches its documented intent, reducing cognitive load for maintainers who read the header and expect the runner to be the sole Git-execution path. New sub-commands added later inherit the correct env/timeout automatically.

### AC-178 · apply-core depends on side-effect require of task-sources for registry population
Strength: Worth exploring
Files: src/lib/apply-core.js, src/task-sources.js

Problem:
`writeArtifact` in `src/lib/apply-core.js` calls `getRegisteredSource`, which is only populated as a side effect of the top-level `require('../task-sources.js')` at the top of the file. While this is a standard CommonJS pattern, it creates an implicit, order-sensitive dependency: if `apply-core.js` is loaded in a context where `task-sources.js` has not yet been required (or if the registry is reset between tests), `getRegisteredSource` will return `undefined` and `writeArtifact` will fail at runtime with an error that is not visible from the function's own signature. The module's correctness is thus coupled to the load order of an external module rather than to an explicit dependency.

Solution:
Make the source registry an explicit dependency. Either (a) have `writeArtifact` accept the source object (or a lookup function) as a parameter, or (b) have the caller inject the registry via a small factory/initialiser that `apply-core.js` exposes (e.g., `initApplyCore({ getRegisteredSource })`). Remove the bare side-effect `require` from the top of `apply-core.js` so that the module's dependencies are visible in its public API rather than hidden in a load-order assumption.

Benefits:
The module is testable without loading the full source registry, and the dependency is visible at the call site, making it obvious to a reader which external state the function relies on. It eliminates a class of hard-to-reproduce runtime errors that only surface when module load order changes (e.g., after a refactor or in a bundler that reorders imports).

NOTE: Flag 2 was not fully applied because the critique incorrectly claims the solution "breaks the existing API contract" in a way that contradicts the code's intent; however, the critique's core point about the "opt-in per process" design intent was valid, so the draft was revised to acknowledge this design choice while still recommending explicit parameters for clarity and testability.

### AC-179 · Lazy-require in task-source-registry creates undocumented coupling to scope/config subsystems
Strength: Moderate
Files: src/task-source-registry.js, src/lib/source-scope.js, src/config.js, src/accessible-roots.js

Problem:
The `registerTaskSource` function in `src/task-source-registry.js` performs a conditional `require('./lib/source-scope.js')` inside its function body when wrapping the `next` function for `scope: 'core'` sources. The lazy-require is almost certainly a deliberate mitigation against a circular dependency: `source-scope.js` requires `../config.js` (via `activeRepoIsCore()`), and `config.js` sits in a foundational dependency chain that likely reaches back toward the registry or its siblings. Moving the require to the top level would therefore re-introduce the very cycle the lazy-require avoids.

The real issue is not the laziness itself but the *undocumented* coupling. There is no comment, JSDoc annotation, or architectural note explaining *why* the require is deferred, what the circular path looks like, or what invariants must hold if the scope or config modules change. As a result:

- A developer reading `task-source-registry.js` sees a bare `require` buried in a conditional branch and cannot tell whether it is a performance deferral, a circularity workaround, or an oversight.
- Static-analysis and module-graph tools (madge, dependency-cruiser) either miss the edge entirely or flag it as a suspicious mid-function require, producing noise that buries real findings.
- Any refactor of `config.js`, `accessible-roots.js`, or `source-scope.js` can silently alter the registry's runtime behaviour with no visible import relationship to prompt a review.

Solution:
Because the circular dependency is real, the fix is **not** to promote the require to top level. Instead, make the coupling explicit and the dependency direction unambiguous:

1. **Invert the dependency (preferred).** Have the registry expose a registration hook, e.g. `registry.setScopeResolver(fn)`. The scope module (or a small bootstrap/setup module that already loads both) calls `registry.setScopeResolver(sourceEligibleHere)` at initialisation time. The registry then calls the stored function when wrapping `next` for core sources, and **never requires `source-scope.js` at all**—lazy or otherwise. The dependency arrow becomes `source-scope → task-source-registry` (one-directional), which is acyclic. This removes the mid-function `require` entirely and makes the coupling visible in the scope module's top-level imports.

2. **If inversion is not feasible** (e.g., the registry is loaded before the scope module in a way that prevents the scope module from calling back), keep the lazy-require but **document it explicitly**:
   - Add a `// NOTE: lazy require to break circular dep: registry → scope → config → … → registry` comment directly above the `require` call.
   - Add a JSDoc `@depends` or `@circular` tag on `registerTaskSource` naming the specific modules in the cycle.
   - Add a short "Dependency notes" section to the file's header comment listing `source-scope.js`, `config.js`, and `accessible-roots.js` as *runtime* (not load-time) dependencies and the reason.

3. **Either way**, add a brief integration-test or smoke-test assertion that registers a core source and verifies the scope-wrapping path executes, so that a future refactor of the scope or config modules that breaks the wiring is caught in CI rather than in production.

Benefits:
- The circular-dependency constraint is preserved (no new cycle is introduced), so the refactor is safe.
- The coupling becomes visible to both humans and tooling: either as a top-level import in the scope module (option 1) or as an explicit, commented runtime dependency (option 2).
- Module-graph tools report a clean, one-directional edge instead of an unexplained mid-function require, reducing false-positive noise.
- The smoke test (option 3) guards the registration path against silent breakage from future refactors of `config.js` or `accessible-roots.js`.
- Developers no longer need to reverse-engineer the circular path to understand why the require is deferred; the rationale is stated in the code.

### AC-180 · `ollama_client.generate` sends `"model": null` to Ollama when `LOCAL_MODEL` is unset, producing a less actionable server error than the documented contract implies
Strength: Strong
Files: python/dashboard/ollama_client.py

Problem:
The module-level constant `MODEL` is initialized from `os.environ.get("LOCAL_MODEL")`, which yields `None` when the variable is unset. The `generate` function then builds its request body with `"model": MODEL` and serializes it via `json.dumps`. Because `None` is a valid JSON type (it serializes to `null`), no local exception is raised; the HTTP request is sent with the body `{"model": null, ...}`. Ollama receives a `null` model value and returns a server-side error (typically a generic "model not found" or "model must be a string" message). The user sees an opaque, server-generated error that does not identify the root cause — an unset `LOCAL_MODEL` environment variable — rather than the clear, actionable message the docstring describes. The failure mode is therefore less informative than the documented contract promises, and the user must infer the missing configuration from a generic server response.

Solution:
At the top of `generate` (or in a small helper called before the request is built), check whether `MODEL` is `None` or an empty string. If so, raise a `ValueError` (or a dedicated `OllamaClientError`) with a message such as `"LOCAL_MODEL environment variable is not set; please configure it to a valid Ollama model name."` This ensures the caller receives an immediate, locally-generated error that names the exact configuration problem, without depending on the wording of Ollama's server-side response.

Benefits:
The failure mode now matches the documented behavior: the user receives a clear, actionable message identifying the missing configuration rather than a generic server error that requires inference. Debugging time drops because the root cause (unset environment variable) is stated explicitly at the point of failure. The function's contract becomes reliable regardless of whether the caller is running in a container, a CI job, or a developer shell where `LOCAL_MODEL` may not yet be exported, and the error is independent of Ollama's internal error-message wording (which could change across server versions).

### AC-181 · Registry hides a runtime dependency on source-scope via lazy require
Strength: Not recommended
Files: src/task-source-registry.js, src/lib/source-scope.js, src/accessible-roots.js, src/config.js

Problem:
The draft suggested removing the inline `require('./lib/source-scope.js')` from `registerTaskSource` to decouple the registry from scoping logic. However, the code explicitly documents that this wrapping is required to ensure **every** caller—including "always-run watchdog sweeps" that invoke `source.next()` directly—respects the `scope: 'core'` gate. Moving this logic to a bootstrap layer or a caller-provided decorator would break this guarantee for any execution path that bypasses the standard `getNextTask` priority ladder, leaving those paths vulnerable to cross-project data leakage or incorrect behavior.

Solution:
Retain the current implementation. The registry must own the wrapping logic to enforce the scope gate universally across all execution paths. The "hidden dependency" is a deliberate architectural choice to ensure correctness and safety over loose coupling in this specific context.

Benefits:
Ensures that all task source invocations, regardless of the calling context (priority ladder, watchdog, direct call), are consistently gated by the source-scope logic. Prevents potential security or correctness hazards that would arise if the gate were optional or context-dependent.

### AC-182 · resolveSourceName mixes hardcoded built-in checks with the alias mechanism
Strength: Not recommended
Files: src/task-source-registry.js

Problem:
The draft suggested replacing hardcoded checks for `task.domain === 'adhoc'` with `registerSourceAlias`. This is factually incorrect because `registerSourceAlias` maps `task.source` values to registry names. The `adhoc` case is triggered by `task.domain === 'adhoc'` OR `task.source === 'manual'`. An alias for `'adhoc'` would only catch tasks where `task.source === 'adhoc'`, which is not the case. Furthermore, the alias mechanism cannot handle the `domain`-based check at all. The hardcoded logic is necessary because the resolution key (`domain` vs `source`) differs from the alias key (`source` only).

Solution:
Retain the current implementation. The hardcoded checks are required to handle the specific combination of `domain` and `source` values that define the `adhoc` source, which cannot be expressed through the existing `source`-only alias mechanism.

Benefits:
Ensures correct resolution of `adhoc` tasks, which have a unique identification pattern (`domain: 'adhoc'` or `source: 'manual'`) that does not fit the standard alias mapping. Prevents regression in task source resolution for this specific built-in source.

### AC-183 · task-priority silently reads global config, masking initialization errors
Strength: Not recommended
Files: src/lib/task-priority.js, src/config.js

Problem:
The draft suggested removing the `try/catch` in `taskPriority` to surface initialization errors. However, the `try/catch` is a deliberate "fail-open" design pattern to ensure that a failure to load config (e.g., in a test environment, a minimal CLI context, or a misconfigured deployment) does not crash the entire task priority resolution. The function's contract is to return a priority, and falling back to `def` is the correct, safe behavior. Removing the `try/catch` or requiring explicit config injection would introduce a hard dependency on `config.js` initialization, potentially causing crashes in contexts where config is not fully loaded but a default priority is still needed.

Solution:
Retain the current implementation. The `try/catch` provides graceful degradation, ensuring that the system remains available and functional even when configuration is unavailable or misconfigured. This is appropriate for a utility function that must not become a single point of failure.

Benefits:
Ensures robustness and availability in diverse execution contexts (tests, minimal CLI, misconfigured deployments). Prevents crashes due to missing or uninitialized configuration, allowing the system to continue operating with default priorities rather than failing entirely.

NOTE: All three flags were applied as they correctly identified that the original draft's proposed solutions would break existing functionality, violate design intent, or introduce unnecessary fragility.

### AC-184 · Task-source registry hardwired to core-scope policy
Strength: Strong
Files: src/task-source-registry.js, src/lib/source-scope.js

Problem:
`registerTaskSource` in `src/task-source-registry.js` directly `require`s `./lib/source-scope.js` and, when the registration config specifies `scope: 'core'`, wraps the caller's `next` function with `sourceEligibleHere` gating. This means the registry—a general-purpose storage and dispatch mechanism—carries an opinion about a specific project-scoping policy ("core" vs. non-core). Any change to the scoping rules, or the introduction of a different conditional-gating strategy (e.g., environment-based, feature-flag-based), forces a modification to the registry itself. The coupling is also invisible to consumers: they register a source with a `scope` string and the registry silently injects a config-reading side effect into every task-generation call, which is not apparent from the registry's public API.

Solution:
Remove the `require` of `source-scope.js` and the `scope === 'core'` branch from `registerTaskSource`. Instead, let the caller supply an already-wrapped `next` function (or a generic `wrap` function in the registration config) that encapsulates whatever eligibility logic is needed. The registry then stores and invokes the function as-is, remaining agnostic to the business policy. The existing call site that currently passes `scope: 'core'` is updated to wrap `next` with `sourceEligibleHere` before handing it to the registry.

Benefits:
The registry becomes a pure, policy-free storage mechanism that can be reused in any context without dragging in `source-scope.js` or its transitive config dependencies. Scoping rules can evolve, be replaced, or be composed without touching the registry. The dependency graph shrinks: consumers of the registry no longer transitively load `source-scope.js`, `getConfig`, or `isCoreRepo`.

### AC-185 · Candidate-fulfillment god module obscures the dependency graph
Strength: Strong
Files: src/sdk/candidate-fulfillment.js

Problem:
`src/sdk/candidate-fulfillment.js` was assembled by moving code "verbatim out of task-sources.js" and re-exporting `candidate-docs.js` so that a plugin has "one import for the whole candidate lifecycle." In practice the module mixes at least four distinct concerns: the write side (`candidateDocs`), the read/claim side (`nextCandidateFulfillmentTask`), a cluster of low-level text helpers (`findFuzzyMatch`, `windowAroundIndex`, `collectAnchorHits`, `snippetFromSection`, `quotedSymbolsFromSection`), and a block of tuning constants (`MAX_FETCHED_FILE_CHARS`, `MIN_REGION_CHARS`, `MAX_ANCHOR_REGIONS`, `QUOTED_SYMBOL_RE`, `LINE_CITATION_RE`, etc.). Because the module re-exports `candidate-docs`, any consumer that imports even one helper transitively loads `candidate-docs`, `candidate-premise-check`, `pipeline-forensics`, `task-history`, and several `lib` modules. This makes the effective dependency footprint of a simple utility import far larger than necessary, increases the surface area for circular-dependency bugs, and means that a change to any one of those transitive modules can invalidate a module that only needed `findFuzzyMatch`.

Solution:
Extract the low-level helpers and their associated constants into a dedicated module (e.g., `src/lib/candidate-grounding.js`) that has no dependency on the candidate-lifecycle write/read path. `src/sdk/candidate-fulfillment.js` then retains only the high-level orchestration (`nextCandidateFulfillmentTask`) and the re-export of `candidate-docs` for backward compatibility, while importing the helpers from the new module. Consumers that only need the text helpers import the new module directly, avoiding the full lifecycle dependency chain.

Benefits:
The dependency graph becomes honest: importing a fuzzy-match helper no longer pulls in the entire candidate lifecycle. The module boundary aligns with the actual unit of change—tuning constants and text-extraction logic can be refactored independently of the task-claiming logic. The risk of circular dependencies is reduced because the new helper module sits lower in the graph and has no back-edges to the lifecycle modules.

### AC-186 · Hidden config read via default parameter in sourceEligibleHere
Strength: Worth exploring
Files: src/lib/source-scope.js, src/task-source-registry.js

Problem:
`sourceEligibleHere` in `src/lib/source-scope.js` declares a default parameter `coreActive = activeRepoIsCore()`. Because the registry's wrapper in `src/task-source-registry.js` calls `sourceEligibleHere` without passing `coreActive`, every task-generation invocation triggers `activeRepoIsCore()`, which reads `getConfig().repoRoot` and evaluates `isCoreRepo()`. The concern here is not performance—the read is a cheap in-process object access—but *visibility*: the function signature does not advertise that it will read global configuration, and the call site in the registry makes no reference to `source-scope.js` or `activeRepoIsCore`. A reader of `registerTaskSource` sees a bare `sourceEligibleHere()` call with no indication that a global config lookup is happening underneath. If the scoping policy is later made injectable (per AC-001), the hidden default becomes a silent coupling that is easy to miss during refactoring.

Solution:
Remove the default parameter from `sourceEligibleHere` so the function signature reads `sourceEligibleHere(coreActive)` with no implicit fallback. At the call site (the wrapper that AC-001 moves out of the registry into the caller), resolve `activeRepoIsCore()` at **call time**—inside the `next` wrapper, on each invocation—and pass the resulting boolean explicitly: `sourceEligibleHere(activeRepoIsCore())`. This preserves the gate's intended semantics (re-evaluate the *current* active repo on every task-generation call, fail-open on read errors) while making the config dependency visible in the call chain. No value is cached or captured at registration time.

Benefits:
The function's contract becomes honest—no hidden global reads hidden behind a default parameter. The call site explicitly names `activeRepoIsCore()`, so a reader immediately sees the config dependency and the fact that it is re-evaluated per call. If the scoping policy is later made injectable (per AC-001), the explicit parameter makes it straightforward to swap in a different eligibility source without hunting for a hidden default. The gate's fail-open, re-evaluate-on-each-call semantics are preserved unchanged.

### AC-187 · Duplicated git execution path in stacked-grounding
Strength: Strong
Files: src/stacked-grounding.js, src/git-runner.js

Problem:
`src/stacked-grounding.js` defines its own `runGit` helper along with local `GIT_ENV` and `GIT_TIMEOUT_MS` constants, yet in the same module it also imports `createRealGitRunner` from `src/git-runner.js` to power `resolveGroundingRef`. This leaves two independent code paths for spawning git processes inside one file, each with its own environment setup, timeout handling, and error-shaping logic. Any future change to the shared runner—tightening timeouts, adding credential scrubbing, altering exit-code interpretation—will silently apply to one call site and not the other, producing inconsistent behavior that is hard to reproduce because it depends on which internal function happens to be invoked.

Solution:
Remove the local `runGit`, `GIT_ENV`, and `GIT_TIMEOUT_MS` definitions from `src/stacked-grounding.js`. Replace every call site that currently uses `runGit` with the runner produced by `createRealGitRunner` (or a thin wrapper around it that accepts the same arguments). If `stacked-grounding` needs a slightly different timeout or environment override, pass those as options into the runner factory rather than re-implementing the spawn logic. This yields a single, testable seam for all git interaction in the module.

Benefits:
Environment variables, timeouts, and error handling live in exactly one place, so a fix or hardening change propagates uniformly. Unit tests can mock or stub a single runner object instead of patching two separate spawn helpers. New contributors see one canonical pattern for "run a git command" rather than guessing which of two local implementations is the sanctioned one, reducing the chance of accidental divergence in future refactors.

### AC-188 · Hard dependency on hub plugin global in apply-core
Strength: Strong
Files: src/lib/apply-core.js

Problem:
`writeArtifact` in `src/lib/apply-core.js` branches on `task.candidateSplitRoute === 'hub'` and then calls `getCandidateSplitHubFiler()`, a global-registry lookup that throws a hard error when the `agent-manager-hub-tasks` plugin has not registered a filer. This makes a core library function crash at runtime based on an implicit, order-sensitive registration performed by an unrelated plugin. It prevents `apply-core` from being exercised in isolation (unit tests, CLI tooling, or a deployment that intentionally omits the hub plugin) and hides a configuration-state problem behind an untyped global that is easy to miss during refactoring.

Solution:
Replace the global-registry lookup with an explicit dependency: accept an optional `filer` (or a small strategy object) as a parameter to `writeArtifact`, or read it from a context/injection object that the caller is expected to provide. When the hub route is requested but no filer is supplied, return a structured, recoverable result (e.g. `{ ok: false, reason: 'hub-filer-not-configured' }`) or throw a typed error that the caller can catch and translate into a user-facing configuration message. The plugin can still register itself, but it does so by injecting into the context rather than mutating a process-global that `apply-core` reaches into opaquely.

Benefits:
`apply-core` becomes independently testable—tests supply a stub filer or the absence of one and assert the expected outcome without needing to load the full plugin. The dependency graph is explicit and visible in the function signature, so static analysis and code review can surface missing wiring. Deployments that do not use the hub plugin no longer risk an unhandled crash in a core path, and the "not configured" state is a first-class, inspectable result rather than an opaque throw from a global.

### AC-189 · Extract shared marker-injection/extraction primitives to eliminate duplicated parsing logic
Strength: Strong
Files: src/concepts.js, src/incident-amplification-marker.js

Problem:
`concepts.js` and `incident-amplification-marker.js` each implement a nearly identical marker-injection and extraction pattern: an instruction string, an idempotent `inject*Instruction` function that checks for the marker's presence before appending, and an `extract*` function that splits the model's response on a marker regex, cleans the text (collapsing extra newlines, trimming whitespace), and returns a structured report. The two implementations use similar regex patterns and text-cleaning steps but are written independently. Any change to the marker convention—adding an optional field, adjusting the delimiter, or improving the cleaning pipeline—must be replicated in both files, creating a divergence risk and doubling the maintenance surface.

Solution:
Introduce a new module `src/marker-utils.js` exporting two generic helpers: `injectMarker(text, markerString)`, which appends `markerString` to `text` only if it is not already present, and `extractMarker(text, markerRegex, parseBlock)`, which splits `text` on `markerRegex`, applies the caller-supplied `parseBlock` to each matched segment to produce structured data, and returns `{ cleanText, reports }`. Refactor `concepts.js` to call these utilities with its `CONCEPT_BUILD_MARKER_RE` and a small parser for `scratch|adapted` fields, and refactor `incident-amplification-marker.js` to call them with its `AMPLIFY_SPLIT_RE` and a parser for `AMPLIFY/QUERY/DIR/EXCLUDE`. The per-module instruction strings and field-specific parsing remain in their respective files; only the shared injection/extraction mechanics move to the utility.

Benefits:
The duplicated injection and extraction logic is eliminated, so a change to the marker convention (new optional field, delimiter tweak, cleaning improvement) is made in exactly one place. Adding a future marker type becomes a matter of supplying a regex and a parser to the same two helpers rather than re-implementing the split-clean-parse pipeline. The two existing modules become thinner and their behavior is guaranteed to stay in lockstep because they share the same code path.

### AC-190 · `side-finding.js` bypasses the project's atomic-write guarantee for the same crash class `atomic-write.js` was built to prevent
Strength: Strong
Files: src/side-finding.js, src/atomic-write.js

Problem:
`atomic-write.js` exists to guard against a documented, non-hypothetical failure mode: a crash mid-`fs.writeFileSync` leaves a truncated, unparseable file (the module header cites 16+ tasks left claimed-but-undrafted by a mid-run crash on 2026-07-14 and a live EPIPE crash on 2026-08-16). Its guarantee is write-to-temp, fsync, rename — so a crash at any point before the rename leaves the prior file untouched. `side-finding.js`'s `writeSideFindingInbox()` writes inbox entries with a plain `fs.writeFileSync(path.join(dir, name), JSON.stringify(record, null, 2))` — the exact pattern `atomic-write.js` was created to eliminate. The module's own comment justifies this as "best-effort, fire-and-forget" and "a disk/permissions problem here must never turn into a pipeline-wide outage." But the failure mode `atomic-write.js` guards against is not a permissions error — it is a mid-write crash, which `writeSideFindingInbox` is equally exposed to. A truncated `sf-*.json` file in `queue/side-findings-inbox/` is exactly the kind of unparseable artifact the project has already been bitten by, and it lands in the same `queue/` tree whose crash history is documented elsewhere. The "best-effort" framing conflates two different failure classes: a permissions/disk-full error (where the `try/catch` is the right guard) and a mid-write crash (where the `try/catch` does nothing, because the process is gone). The two files are in the same community, `atomic-write.js` is the project's canonical answer to "how do I write a file safely," and `side-finding.js` has a private, divergent answer for the same class of operation.

Solution:
Replace the `fs.writeFileSync` call in `writeSideFindingInbox` with `writeJsonAtomicSync` from `atomic-write.js`. The existing `try/catch` wrapper stays, so a permissions or disk-full error is still swallowed and logged as non-fatal, preserving the "never throw past the caller" contract. The "best-effort" semantics are fully preserved — the `try/catch` still catches the error classes that matter for the "optional side channel" intent — but the mid-write crash class is now covered by the same guarantee the rest of the project relies on. No other line in `side-finding.js` changes; the `fs` require can be dropped if no other call in the file uses it.

Benefits:
Closes a real durability gap in the same `queue/` tree the project has already lost work to, reuses the existing shared primitive instead of a private divergent implementation, and makes the "best-effort" intent accurate (it now means "swallow the error classes that are recoverable" rather than "skip the durability guarantee"). Zero behavioral change in the success path; the only observable difference is that a crash mid-write now leaves the previous state of the inbox intact instead of a truncated, unparseable file.

### AC-191 · Extract duplicated signature-parsing logic into a shared helper
Strength: Strong
Files: src/pipeline-self-audit.js

Problem:
In `src/pipeline-self-audit.js`, the logic that splits a `signature` string into its `source` and `category` components (via `lastIndexOf('::')` and `slice`) is duplicated verbatim inside both `buildAuditRawText` and `buildAuditTask`. This tight coupling to the exact string format means that any future change to the signature convention—such as introducing a new separator, an additional metadata segment, or a different ordering—requires a synchronized edit in two separate functions. A missed update in one location will silently produce inconsistent evidence text versus task titles, and because the two copies are structurally identical, a reviewer scanning one function may assume the other is already correct.

Solution:
Introduce a single private helper, e.g. `parseSignature(signature)`, that returns `{ source, category }` (or `null` for malformed input). Replace the inline `lastIndexOf`/`slice` expressions in both `buildAuditRawText` and `buildAuditTask` with a call to this helper. Add a brief JSDoc comment on the helper documenting the expected signature format so the contract lives in one place. If the format is already defined as a constant or type elsewhere in the module, reference it in the helper's documentation.

Benefits:
The parsing rule now exists in exactly one location, eliminating the divergence risk between the two call sites. Future format changes require editing a single function, and any validation or error-handling logic (e.g., guarding against a missing `::`) can be added once and inherited by both consumers. Code review surface shrinks because reviewers no longer need to verify that two inline blocks remain in lockstep, and the helper is trivially unit-testable in isolation.

### AC-192 · Test files for the same concern live in two different directories with inconsistent naming
Strength: Worth exploring
Files: src/lib/prompt-implementation.test.js, src/test_project_search_zero_findings_prompt.js

Problem:
The community contains two regression tests that both verify prompt instruction text, yet they are placed in different directories and follow different naming conventions. `src/lib/prompt-implementation.test.js` sits alongside the source code it exercises in `src/lib/` and uses the `*.test.js` suffix that the rest of the repository's node:test suite relies on. `src/test_project_search_zero_findings_prompt.js`, by contrast, is dropped in the `src/` root with a `test_` prefix and no `.test.js` suffix. A developer looking for prompt-related tests must check two locations and recognise two naming patterns, and a tool that globs `**/*.test.js` will silently miss the second file.

Solution:
Move `src/test_project_search_zero_findings_prompt.js` into `src/lib/` and rename it to `src/lib/project-search-zero-findings-prompt.test.js`, following the `*.test.js` convention already used by its sibling `src/lib/prompt-implementation.test.js`. The original file at `src/test_project_search_zero_findings_prompt.js` is removed. This co-locates all prompt-instruction regression tests in one directory and makes them discoverable by the same glob pattern the rest of the test suite uses.

Benefits:
All prompt-related tests are found in a single directory, reducing the chance that a new test is added to the wrong location or with the wrong suffix and thus skipped by the test runner. The naming convention becomes uniform across the community, which lowers cognitive load for anyone onboarding to the codebase and makes it straightforward to add further prompt regression tests without a second decision about where and how to name the file.

NOTE: Flag 1's core claim of a filename collision was incorrect — the proposed target `project-search-zero-findings-prompt.test.js` is distinct from the existing `prompt-implementation.test.js`; only the minor clarity improvement (explicitly stating the old file is removed) was applied.

### AC-193 · ~~Case-sensitivity mismatch between path normalization and validation~~
Strength: Strong

**Status: Withdrawn**

Upon re-examination, the draft's premise was incorrect. `validateSecondBrainPath` already constructs a lower-cased set (`allowedLower`) and performs the membership test against that normalized form (`allowedLower.has(topLevel.toLowerCase())`). The case-insensitive validation the draft proposed to add is already present in the code. There is no gap to close, and the proposed refactor would be a no-op.

---

### AC-194 · ~~Scattered `belongsToProject` validation and coercion across two functions~~
Strength: Strong

**Status: Withdrawn**

Upon re-examination, the draft mischaracterized the control flow. `deriveBelongsToProject` is invoked *inside* `reviewBrainDumpSort` immediately before the canonical-folder coercion check. The coercion in `reviewBrainDumpSort` is a deliberate final safety net for edge cases (e.g., a model output that bypasses the derivation recovery paths), not a duplicated or independent enforcement of the same rule. The separation of "derivation/recovery" from "final validation/coercion" is a valid and intentional layering. Extracting a shared helper called by both functions would not change behavior and would obscure the two distinct responsibilities. The "risk of partial update" the draft cited is speculative and not supported by the code's actual call structure.

### AC-195 · Registry enforces the core-scope gate; SDK is a passive utility
Strength: N/A (No defect)
Files: src/task-source-registry.js, src/sdk/candidate-fulfillment.js

Problem:
None. The initial draft incorrectly identified a "hidden contract" or enforcement gap. In reality, `src/sdk/candidate-fulfillment.js` provides helper functions (parsing, grounding, etc.) that plugins use to construct their `next` logic. It does not register sources or bypass the registry. The registry (`src/task-source-registry.js`) is the sole enforcement point: when a plugin calls `registerTaskSource` with `scope: 'core'`, the registry automatically wraps the provided `next` function with `sourceEligibleHere`. This is a standard, explicit API contract. The "gap" described in the draft does not exist because the SDK is not an active enforcement path; it is a passive library.

Solution:
No code changes required. The current architecture is correct. The registry remains the single source of truth for scope-gate enforcement. Plugin authors are responsible for setting `scope: 'core'` in their registration config if they wish to be gated, which is a configuration decision, not a missing SDK feature.

Benefits:
Maintains a clear separation of concerns: the SDK provides logic, the registry manages lifecycle and policy enforcement. No risk of breaking existing plugins or introducing redundant enforcement layers.

### AC-196 · Source ordering and task priority are orthogonal concerns
Strength: N/A (No defect)
Files: src/task-source-registry.js, src/lib/task-priority.js

Problem:
None. The initial draft incorrectly characterized the relationship between static source ordering (registry) and dynamic task priority (lib) as a "divergence" causing bugs. In reality, these are distinct, intentional layers. Source ordering determines *which* source is polled for a task (scheduling). Task priority determines *how* that specific task is ranked within a queue or for selection (execution). A low-priority source can legitimately produce high-priority tasks, and dynamic task priority overrides allow fine-grained control without re-registering sources. This separation is a feature, not a bug.

Solution:
No code changes required. The current design correctly separates source scheduling order from task execution priority. Developers should understand that `getRegisteredSources()` order affects polling sequence, while `taskPriority()` affects task ranking. These are independent knobs for different aspects of the system.

Benefits:
Preserves the ability to have fine-grained control over both source selection and task ranking. Avoids the complexity and potential breakage of unifying two orthogonal concerns. Maintains flexibility for dynamic priority adjustments without impacting source registration.
