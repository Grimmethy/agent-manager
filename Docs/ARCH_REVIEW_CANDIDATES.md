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
Strength: Strong
Files: resolveGraphPath.js, getConfig.js, apply-task.js, task-sources.js, local-worker.ps1

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
