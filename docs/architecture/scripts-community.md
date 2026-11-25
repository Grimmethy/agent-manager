# Architecture: community "scripts" (communityId 1)

This document is discovery only. It describes the current code and makes no behavior change.

## Purpose and boundaries

The community centers on `src/task-source-registry.js`, the hub with 50 degree. It is the registry of task sources. Each source registers a name and a config that includes `next()`, an optional `gate`, optional `owners`, and optional `variantOf`. The module also maps the `source` and `domain` stamps on generated tasks to registry names, and it records tasks that could not be resolved.

Boundary: the module does not generate tasks itself. Source implementations live elsewhere and register themselves.

## Modules

Paths were checked with `test -f` in the working tree.

| Path | Status | Responsibility |
|---|---|---|
| `src/task-source-registry.js` | confirmed (read in full, 307 lines) | Registry, gating, owner guard, alias resolution, drop recording |
| `src/source-owner-guard.js` | confirmed (exists; `ownerAllows` imported) | Decides whether the running repo root is one of a source's owners |
| `src/pipeline-history.js` | confirmed (exists; `logPipelineEvent` imported) | Writes owner-mismatch history events |
| `src/config.js` | confirmed (exists; `getConfig` required lazily inside functions) | Supplies `repoRoot` and `pipelineDir` |
| `src/local-client.js` | confirmed to exist; not required by the hub | Not part of the hub's data flow |

Callers: about 50 non-test files under `src/` and `src/lib/` contain the string `task-source-registry`. Examples include `src/task-sources.js`, `src/next-claimable-task.js`, `src/apply-task.js`, `src/config.js`, `src/registry-variants.js`, `src/task-domains-registry.js`, and `src/lib/task-selection.js`. I did not read each caller, so their use of the API is unverified.

## Exports

`module.exports` of `src/task-source-registry.js` contains exactly these 12 names:

- `registerTaskSource(name, config)`
- `getRegisteredSources()`
- `getRegisteredSource(name)`
- `clearRegistry()`
- `updateTaskSource(name, partialConfig)`
- `resolveSourceName(task)`
- `registerSourceAlias(fromField, toName)`
- `registerDomainAlias(domain, toName)`
- `getUnresolvedSourceCount()`
- `getUnresolvedSources()`
- `variantParentOf(name)`
- `getVariantsOf(parent)`

Internal, not exported: `gateNext`, `validateGate`, `recordOwnerMismatch`, `runningRootForOwnerGuard`, `pipelineDirForHistory`, `seedBuiltinAliases`.

## Module state

All state is module-level and lives for the process, except where `clearRegistry()` resets it.

- `registry`: plain object keyed by source name. Entries are `{ name, ...config }`.
- `sourceAliases`: plain object mapping a `task.source` string to a registry name. Filled by `registerSourceAlias`.
- `domainAliases`: `Object.create(null)` mapping a `task.domain` string to a registry name. Filled by `registerDomainAlias`.
- `unresolvedDrops`: a Map keyed by `JSON.stringify([id, source, domain])`, holding `{ taskId, source, domain, count }`.
- `gatedNextFns`: a WeakSet of wrapper functions, so a `next` is never double-wrapped.
- `ownerMismatchCounts`: plain object of per-source counters.
- `clearRegistry()` empties `registry`, `sourceAliases`, `domainAliases`, and `unresolvedDrops`, then calls `seedBuiltinAliases()`. It does not reset `ownerMismatchCounts` or `gatedNextFns`.

## Data flow

1. **Module load:** `seedBuiltinAliases()` runs. It registers domain aliases `adhoc->adhoc` and `secondbrain->secondbrain`, and source alias `manual->adhoc`.
2. **Registration:** `registerTaskSource(name, config)` throws if `name` is already registered. It then:
   - validates `gate` (must be a function if present);
   - wraps `next` with `gateNext(gate, next)` when both are functions;
   - wraps `next` with the owner guard when `owners` is defined;
   - validates `variantOf` shape (a non-empty string naming a different source; the parent need not be registered yet);
   - stores `registry[name] = { name, ...config }`.
3. **Later attachment:** `updateTaskSource` merges fields into an existing entry. It applies the same gate wrapping, and it throws if the name is unregistered.
4. **Alias resolution:** `resolveSourceName(task)` checks `domainAliases[task.domain]`, then `sourceAliases[task.source]`, then falls back to `task.source`. If the result is not in `registry` and the registry is non-empty, the miss is recorded in `unresolvedDrops`. The result is returned either way.
5. **Gate evaluation:** every call to a wrapped `next()` evaluates `gate()` on that call. A falsy result returns `null` without calling the source. The gate is never cached.
6. **Owner check:** when `owners` is set, each `next()` call reads the running root through `runningRootForOwnerGuard()` and calls `ownerAllows(runningRoot, owners)`. On a mismatch it calls `recordOwnerMismatch` and returns `null`.
7. **Variants:** `variantParentOf` follows `variantOf` chains to the root, cycle-safe. It returns `null` if the name is not a variant. `getVariantsOf(parent)` returns every registered name whose root is `parent`.

## Failure behavior

- `runningRootForOwnerGuard()` returns `null` if `getConfig()` throws or `repoRoot` is unset. `ownerAllows(null, owners)` then decides the outcome, which the owner-guard module controls.
- `recordOwnerMismatch` never rethrows. It has three outcomes:
  - **recorded:** `logPipelineEvent(dir, 'owner-mismatch', entry)` returns truthy.
  - **skipped:** `pipelineDirForHistory()` returns `null` (no `pipelineDir`, no `AGENT_MANAGER_PIPELINE_DIR`, no `repoRoot`). It writes a stderr warning and returns.
  - **failed:** the write returns falsy or throws. It writes a stderr warning.
  - In skipped and failed cases the per-source counter still increments and the gate still returns `null`.
- `pipelineDirForHistory()` falls back to the environment variable if `getConfig()` throws.
- Validation errors are thrown: duplicate registration, a non-function `gate`, a bad `variantOf`, and updating an unregistered source.
- `resolveSourceName` returns `task.source` unchanged on a miss. It does not throw. Calls made before the registry is populated are not cached and record nothing.

## Extension points

- `registerSourceAlias(fromField, toName)`: a plugin maps a `task.source` value that differs from its registry name.
- `registerDomainAlias(domain, toName)`: a plugin maps a `task.domain` value to a registry name.
- `gate` in the config: a per-call eligibility predicate.
- `owners` in the config: restricts a source to specific repo roots.
- `variantOf` in the config: metadata linking a smaller-scoped variant to its parent.

A search of non-test `src/` files found no direct call to `registerSourceAlias` or `registerDomainAlias` outside the hub. Plugin registrations are therefore assumed to live out of tree.

## Open questions

1. Confirm each file in `src/` that imports `task-source-registry` uses only the 12 exports listed above.
2. Which out-of-tree plugin files call `registerSourceAlias` or `registerDomainAlias`? They are not visible from this checkout.
3. The owner guard's behavior for `runningRoot === null` (fail-closed or fail-open) is decided in `src/source-owner-guard.js`. That file was not read in this pass.
4. `src/pipeline-history.js` and `src/config.js` were confirmed to exist. Their internals were not read.
5. `src/local-client.js` was confirmed to exist, but the hub does not require it. Its role in the community is unverified.
6. `clearRegistry()` does not reset `ownerMismatchCounts` or `gatedNextFns`. Whether that is intended is unknown.
