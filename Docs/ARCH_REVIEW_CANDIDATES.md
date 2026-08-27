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
Strength: Strong
Files: src/config.js

Problem:
resolveGraphPath(repoRoot) performs eager synchronous filesystem I/O (fs.existsSync, fs.readdirSync, fs.statSync) on every single getConfig() call, with no caching. In a long-lived worker process that calls getConfig() repeatedly (every task-source tick, every apply-task invocation), this re-walks .agent-manager-cache/ from scratch each time, blocking the event loop and doing redundant stat/readdir work. There is also no way to invalidate a cached result when the dashboard writes a new graph.json, so a memoized version needs an explicit invalidation hook.

Solution:
1) Add a module-level Map keyed by path.resolve(repoRoot) storing the resolved graph-path string. 2) Convert resolveGraphPath to an async function using fs.promises (readdir, stat, access) instead of the sync variants; on entry, check the Map and return the cached value on a hit; on a miss, perform the async walk and store the result before returning. 3) Export a new invalidateGraphPathCache(repoRoot?) function that deletes a single key or clears the whole Map. 4) Change getConfig() from function to async function and replace the bare resolveGraphPath(repoRoot) call with await resolveGraphPath(repoRoot). 5) Keep the AGENT_MANAGER_GRAPH_PATH env-var short-circuit before the await so an explicitly-set path never touches the cache or the filesystem.

Benefits:
Eliminates redundant synchronous readdir/stat walks on every getConfig() call in long-lived worker processes; frees the event loop during the (now async) filesystem I/O; gives downstream code (e.g. a task-completion handler that writes a new graph.json) a deterministic one-line call to force a re-scan on the next getConfig() invocation; the env-var override path remains zero-cost and synchronous.

### AC-12 · Adopt async getConfig() in apply-task.js and task-sources.js
Strength: Strong
Files: src/apply-task.js,src/task-sources.js

Problem:
After config.js's getConfig() becomes async (returns a Promise), every call site that does const { pipelineDir } = getConfig(); or similar destructuring will silently receive a Promise instead of a plain object, causing undefined property reads and runtime failures. In task-sources.js, taskIdExistsInQueue(id) calls getConfig() synchronously and is itself called from many nextTask generators throughout the file; making it async cascades to every caller. In apply-task.js, getConfig() is required at the top and called in the (truncated) apply logic. All of these call sites must be converted to await getConfig() and their enclosing functions made async (or wrapped in an IIFE / .then chain) to complete the migration.

Solution:
1) In src/task-sources.js: change taskIdExistsInQueue to async function taskIdExistsInQueue(id) and add await before getConfig(); then propagate async/await up through every function that calls taskIdExistsInQueue (the nextTask generators for each of the 10 built-in sources, the adhoc/research title-scanning helper, and any other internal callers visible in the file). 2) In src/apply-task.js: add await before every getConfig() call site in the apply/writeArtifact/branch logic; make the enclosing functions async where they are not already. 3) Verify no other module in the package calls getConfig() without await (grep for require('./config.js') and getConfig() across src/). 4) local-worker.ps1 needs no change — it invokes Node scripts (local-client.js, prompts.js, local-tool-client.js) via & node and reads stdout; it does not itself call getConfig() or resolveGraphPath.

Benefits:
Completes the breaking-change migration so no caller silently receives a Promise where it expects a plain object; the cascading async in task-sources.js is contained to that one file's internal call graph (all nextTask functions are already called from a single async worker loop, so the propagation is mechanical); apply-task.js's CLI entry point already runs in an async context (it's a top-level script), so adding await is straightforward; no PowerShell-side change is needed, keeping the worker's invocation contract unchanged.

### AC-13 · Async-ify resolveGraphPath and getConfig in src/config.js
Strength: Strong
Files: src/config.js

Problem:
resolveGraphPath uses three synchronous fs calls (fs.existsSync, fs.readdirSync, fs.statSync) that block the Node event loop on every getConfig() invocation. getConfig() itself is synchronous and calls resolveGraphPath(repoRoot) inline, so any consumer that needs a config object must wait on a blocking syscall. This is fine for a one-shot CLI but blocks the event loop in the long-running drafting daemon and dashboard server that import this module.

Solution:
Convert resolveGraphPath to an async function that uses fs.promises.access (for the existsSync check), fs.promises.readdir (for the directory listing), and fs.promises.stat (for mtimeMs). Preserve the exact three-tier resolution order: (1) .agent-manager-cache/default/graph.json, (2) most-recently-modified graph.json across .agent-manager-cache/<hash>/ subdirs, (3) graphify-out/graph.json fallback. Convert getConfig to an async function and prepend await before the resolveGraphPath(repoRoot) call on the line 'const graphPath = process.env.AGENT_MANAGER_GRAPH_PATH || resolveGraphPath(repoRoot);'. The returned object shape (all keys, types) is unchanged; callers simply await it.

Benefits:
Non-blocking filesystem I/O in the daemon and server processes; no behavioral change to the resolution logic or the returned config object; paves the way for callers to do useful work while the stat/readdir round-trip is in flight.

### AC-14 · Propagate await getConfig() through taskIdExistsInQueue (task-sources.js) and all getConfig() call sites in apply-task.js
Strength: Strong
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
Strength: Strong
Files: python/dashboard/discuss_sessions.py

Problem:
_chat_prompt_for_turn builds a single prompt string used by both providers, but the two paths have different prompt conventions: the local (Ornith) path prepends harness-grep context (the real file content gathered by _build_search_proposal_prompt + _expand_grep_terms + grep_fetch_client) before the note text, while the Claude path does not need that preamble because Claude can Read/Grep/Glob its own files via CLAUDE_DISCUSS_ALLOWED_TOOLS. Currently the function either includes the harness-context block unconditionally (wasting Ornith's 8192-token num_ctx window on a Claude turn that ignores it) or conditionally branches on provider mid-string-concatenation, which is fragile and hard to extend.

Solution:
Split _chat_prompt_for_turn into a shared skeleton (system instruction, note text, transcript turns) plus a provider-specific preamble slot. For PROVIDER_LOCAL the preamble is the harness-grep context block (built by the existing _build_search_proposal_prompt / _expand_grep_terms / grep_fetch_client pipeline, capped at MAX_HARNESS_CONTEXT_CHARS). For PROVIDER_CLAUDE the preamble is empty (or a one-line note that file access is available via tools). The function signature gains no new parameters -- it already receives the session dict and reads session["provider"] -- but the internal branching is moved to the top of the function so the two prompt shapes are visually distinct blocks rather than interleaved conditionals.

Benefits:
The prompt shape for each provider is a single contiguous block that can be read, copied, and tested in isolation; the 8192-token budget for Ornith is no longer silently consumed by a Claude-only preamble; adding a new provider means adding one more preamble branch at the top of the function rather than threading a conditional through every string-concatenation line.
