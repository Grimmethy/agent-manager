# Mutation Check

Deterministic mutation-testing CLI for the pipeline: apply each mutation from a JSON
manifest to a source file, run a test command, and report which mutations survived.
Used to verify that the mutation-testing pipeline catches real defects and that every
mutated file is restored byte-for-byte before the next mutation runs.

This tool is part of the mutation-testing pipeline (HUB0203). The CLI source lives at
`scripts/mutation-check.js`; the test suite lives at
`scripts/mutation-check.test.js`. See [Codebase Map](codebase-map.md) for the full
repo layout context.

**Safety guarantees:**
- Mutations are applied in-memory then written back; every file is restored to its
  original bytes before the next mutation starts.
- All file paths are validated to stay within `--cwd` — a mutation targeting a path
  outside the working directory is reported as `NOOP` (outcome `path-escape`) rather
  than written to an arbitrary location.
- Tests run with a configurable timeout (`--timeout-s`, default 300 s); a timeout is
  treated as a killed mutation (test failed).
- After restore, the file is re-read and compared byte-for-byte with the original; a
  mismatch is reported as outcome `survived` with `failing: "byte-mismatch"`. This is
  the **byte-identical restoration verification guarantee** — if the bytes differ, the
  tool exits 3 and flags the mutation as survived.

## CLI Usage

```
node scripts/mutation-check.js --test "<cmd> [args]" --cwd <dir> --mutations <path> [--timeout-s N] [--regex]
```

The test command supports quoted substrings (`"..."` or `'...'`) so embedded spaces
are preserved — the parser does **not** expand shell variables or run the command
through a shell, which prevents two failure modes this tool is designed to avoid:

- **Shell variable expansion** — a mutation's `find`/`replace` values can contain `$`,
  backticks, or other shell meta-characters; running the test through a shell would
  silently rewrite them before the mutation is applied. The CLI spawns the test
  directly via `child_process.spawn`, never via `/bin/sh -c`.
- **Equivalent mutations** — two mutations that differ only in quoting or whitespace
  around a `find` string would produce identical file content and mask each other.
  The CLI treats `find` as a literal substring (or regex when `--regex` is set) with
  no shell interpretation, so every mutation in the manifest is applied exactly as
  written.

## CLI Arguments

| Argument | Type | Required | Default | Description |
|---|---|---|---|---|
| `--test` | string | yes | — | Test command to run. Parsed respecting quoted substrings; no shell expansion. |
| `--cwd` | string | yes | — | Working directory for the test and for resolving `file` paths in the mutations manifest. Must be an existing directory. |
| `--mutations` | string | yes | — | Path to a JSON file containing the mutation array. |
| `--timeout-s` | integer | no | 300 | Per-test timeout in seconds. Must be a positive integer. |
| `--regex` | boolean flag | no | false | Treat each mutation's `find` field as a regex pattern (with optional `/pattern/flags` syntax) instead of a literal substring. |

## Mutations Manifest Format

JSON array of objects, each with four string fields:

```json
[
  { "name": "kill-func", "file": "app.js", "find": "original", "replace": "mutated" }
]
```

| Field | Type | Description |
|---|---|---|
| `name` | string | Human-readable identifier for the mutation (must be unique per run). |
| `file` | string | Path to the source file to mutate, relative to `--cwd`. |
| `find` | string | Literal substring (or regex with `--regex`) to search for in the file. |
| `replace` | string | Replacement string. Applied to **all** occurrences of `find` in the file. |

## Output Format

JSON lines on stdout, one per mutation plus a final summary:

```
{"name":"kill-func","outcome":"killed","failing":false}
{"name":"survive-const","outcome":"survived","failing":true}
{"type":"summary","total":2,"killed":1,"survived":1,"noop":0,"restoreFailed":false}
```

Per-mutation fields:

| Field | Type | Description |
|---|---|---|
| `name` | string | Mutation name (from the manifest). |
| `outcome` | string | One of: `killed`, `survived`, `NOOP`. |
| `failing` | bool or string | `false` for killed; `true` for survived (test passed); a string reason for NOOP outcomes (`"path-escape"`, `"read-error"`, `"byte-mismatch"`, etc.). |

Summary fields:

| Field | Type | Description |
|---|---|---|
| `type` | string | Always `"summary"`. |
| `total` | integer | Number of mutations in the manifest. |
| `killed` | integer | Mutations where the test failed (desired outcome). |
| `survived` | integer | Mutations where the test passed (defect not caught). |
| `noop` | integer | Mutations that were not applied (path escape, read error, etc.). |
| `restoreFailed` | boolean | True if any byte-identity verification failed. |

If the baseline test fails before any mutations are applied, the output contains a
single summary line with `baselineRed: true` and the tool exits 2 (see below).

## Exit Codes

| Code | Meaning |
|---|---|
| 0 | All mutations killed (test failed for every one) or no mutations in the manifest. |
| 1 | At least one mutation survived (test passed for at least one). |
| 2 | Baseline test failed (red) or invalid/missing CLI arguments. |
| 3 | Restore failed — at least one file could not be restored to its original bytes (byte-identity check did not match). |

## Failure Modes Prevented

This tool exists to catch two categories of pipeline failure:

1. **Shell variable expansion in mutation manifests** — without the no-shell-spawn
   design, a mutation like `{ "find": "$VAR", "replace": "x" }` would have `$VAR`
   expanded by the shell before the mutation is applied, silently changing what gets
   mutated. The CLI spawns tests directly (never via `/bin/sh -c`), so the mutation
   string is applied verbatim.

2. **Equivalent mutations masking each other** — when two mutations in a manifest
   differ only in quoting or surrounding whitespace but produce identical file
   content, running them sequentially can mask a defect: the second mutation's
   "survival" may actually be the first mutation's artifact. The CLI applies each
   mutation in isolation (read → mutate → test → **byte-verify restore → next**), so
   each mutation is evaluated against a pristine file.

## Verification Guarantee

Every mutation follows this cycle:

1. Read original file bytes into memory.
2. Apply mutation to in-memory copy.
3. Write mutated content to disk.
4. Run the test command.
5. Write original bytes back to disk.
6. **Re-read the file and `Buffer.compare()` against the original bytes.**
7. If the bytes differ, mark the mutation as `survived` with `failing: "byte-mismatch"`
   and set the global `restoreFailed` flag (exit code 3).

Step 6 is the byte-identical restoration verification guarantee: the tool will not
report a mutation as successfully reverted unless the file on disk is byte-for-byte
identical to what it was before the mutation was applied.

## See Also

- [Codebase Map](codebase-map.md) — where this file and its test live in the repo,
  plus the layout of other agent documentation.
- `scripts/mutation-check.js` — the CLI source.
- `scripts/mutation-check.test.js` — the test suite (node:test, ~7 tests).
