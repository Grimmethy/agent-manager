# `src/maintenance/` — scanner rules stay, review sources moved

This directory is **split** as of 2026-08-27:

- **`*-scan.js` + `scan-utils.js` live here** (in `agent-manager` core). They are pure,
  deterministic `(text, relPath) -> findings` rule functions with no registry, no LLM, no
  `src/` dependency beyond `scan-utils.js`.
- **The `*-review.js` task-source wrappers moved out** into the out-of-tree
  **agent-manager-hygiene** plugin (`observability_review`/`_fix`,
  `performance_review`/`_fix`, `function_length_review`/`_fix`). The plugin `require`s the
  detectors here via `agent-manager/src/maintenance/<x>-scan.js`.

## Why the detectors stayed

`src/staleness-fastpath.js` (core) re-runs these exact rule functions to answer
"is this scanner finding still live in the file's *current* content" deterministically,
in milliseconds, without an LLM round-trip. It's on the hot path of core `local-draft.js`
and `staleness-audit.js`, which never load the plugin. Moving the detectors would either
add a plugin-load failure mode to that deterministic path or force a drifting second copy
of the rules — so they stay.

`scan-utils.js` is the bottom of the tree (zero `src/` imports) and is imported by all
three scanners plus `staleness-fastpath.js`.

## Files

| File | Role | Consumed by |
|---|---|---|
| `scan-utils.js` | `listSourceFiles`, `isLikelyMinified`, `extractBraceBody`, `lineOfIndex` | the three scanners, `staleness-fastpath.js`, the plugin |
| `observability-scan.js` | silent-catch / unguarded-loop / OTel-naming / missing-reserved-attribute rules | `staleness-fastpath.js`, plugin `observability-review.js` |
| `performance-scan.js` | sync-io-in-loop / sequential-await / json-deep-clone rules | `staleness-fastpath.js`, plugin `performance-review.js` |
| `function-length-scan.js` | over-long-function rule (`AGENT_MANAGER_MAX_FUNCTION_LINES`, default 100) | plugin `function-length-review.js` (no `staleness-fastpath` rule, kept here for symmetry) |

See `docs/PLUGIN_API.md` for the full core↔plugin contract.
