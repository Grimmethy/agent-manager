# Architecture Review Candidates

### AC-1 · ΓòÉΓòùΓòúΓò¥ΓòúΓòù Kill-switch file couples tool-client behavior to filesystem state instead of config
Strength: Strong
Files: src/ornith-tool-client.js, src/config.js

Problem:
The kill-switch branch in `src/ornith-tool-client.js` swaps into a plain `call()` from `./ornith-client.js` when `.arch-discovery-tools-disabled` exists on disk. This means the same prompt path has two divergent code paths (tool-calling loop with retry vs. single-attempt generate) controlled by an arbitrary file rather than a setting in `config.js`. Any consumer that wants to disable tools must create a file, which is inconsistent with how every other behavior in this package is configured via `AGENT_MANAGER_*` env vars and config entries.

Solution:
Replace the filesystem kill-switch with a configuration-driven toggle read from `src/config.js`, e.g. a `tools_disabled` boolean that defaults to false (or can be set via an env var like `ARCH_DISCOVERY_TOOLS_DISABLED`). The tool client should always route through the same code path, and when tools are disabled it should invoke `call()` with its own retry-on-degenerate logic rather than delegating to the single-attempt path.

Benefits:
This makes tool-disabling behavior consistent with the rest of the package's configuration model (env vars + config), removes the filesystem side-effect that silently changes runtime behavior, and ensures both code paths share the same failure/retry contract instead of diverging into two different modes for the same prompt.

### AC-2 · ΓòÉΓòùΓòúΓò¥ΓòúΓòù grep-codebase-tool.js hardcodes directory exclusions instead of reading them from config
Strength: Strong
Files: src/grep-codebase-tool.js, src/config.js

Problem:
The `['node_modules', '.git', 'queue']` skip list in `src/grep-codebase-tool.js` is baked into the walker implementation. A consumer that wants to add or remove exclusion patterns has no way to do so without editing this file directly, creating tight coupling between search behavior and source code rather than letting config drive it. This contradicts `config.js`'s own design principle of "every env-var-driven setting."

Solution:
Read exclusion patterns from a configuration entry in `src/config.js`, e.g. an array like `grep_exclude_dirs` that defaults to the sensible baseline (`['node_modules', '.git']`). The walker should merge any user-provided overrides with the default set at runtime, allowing consumers to extend or shrink the skip list without touching implementation code.

Benefits:
This decouples search behavior from source code, making it possible for downstream tooling and CI configurations to customize grep patterns via config/env vars rather than patching files. It also aligns with `config.js`'s design principle that every setting should be configurable, improving maintainability and reducing the risk of accidental behavior changes when adding new directories.

### AC-3 · ΓòÉΓòùΓòúΓò¥ΓòúΓòù Tool-client duplicates degenerate-detection/retry contract when tools are disabled
Strength: Strong
Files: src/ornith-tool-client.js, src/ornith-client.js

Problem:
In the kill-switch branch (`fs.existsSync(killSwitchPath)`), `src/ornith-tool-client.js` calls `call()` from `./ornith-client.js`, but that call goes through `callOnce` which has its own timeout and no retry loop. The normal path uses `runPlanWithTools` with a turn cap and built-in retry-on-degenerate logic. This means the disabled-tools code path doesn't reuse any of the multi-retry contract documented in `ornith-client.js`, so it inherits single-attempt behavior instead of the documented failure mode. Two different failure modes for the same prompt depending on which branch executes.

Solution:
Refactor the kill-switch branch to invoke a shared helper that applies the same retry-on-degenerate logic used by `runPlanWithTools` in both paths, rather than delegating directly to `callOnce`. When tools are disabled, the tool client should still go through the same degenerate-detection pipeline, just with the tool-calling loop short-circuited. This ensures consistent failure behavior regardless of which branch executes.

Benefits:
This eliminates two different failure modes for the same prompt based on filesystem state, making runtime behavior predictable and testable. Both code paths now share a single contract for handling degenerate responses, reducing cognitive load when reasoning about tool-client behavior and simplifying future maintenance since only one retry/degenerate implementation needs to be maintained.

NOTE: The second review returned "NO ISSUES FOUND," meaning no problems were flagged in the CRITIQUE section; therefore this draft is presented unchanged as-is.
